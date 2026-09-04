import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { OrchestratorConfig } from "../../src/config.ts";
import type { AgentRecord } from "../../src/domain/agent.ts";
import { NotFoundError } from "../../src/domain/errors.ts";
import type { AgentId } from "../../src/domain/ids.ts";
import { DeterministicFailpoints, type Failpoint } from "../../src/faults.ts";
import type {
    CreateHerdrSurfaceOptions,
    HerdrAgentInspection,
    HerdrOperationOptions,
    HerdrOperationResult,
    HerdrOwnedSurface,
    PersistedHerdrSurface,
    PromptOptions,
    StartPiOptions,
} from "../../src/herdr/index.ts";
import { AgentSupervisor, OrchestratorError } from "../../src/orchestrator/index.ts";
import { SqliteControlPlaneStore } from "../../src/storage/index.ts";

const RESULT: HerdrOperationResult = { raw: {}, status: "idle" };

class FakeHerdr {
    readonly calls: Array<{ readonly name: string; readonly value?: unknown }> = [];
    failStart = false;
    failPrompt = false;
    inspection: HerdrAgentInspection = { status: "idle", raw: {} };

    async createSurface(options: CreateHerdrSurfaceOptions): Promise<HerdrOwnedSurface> {
        this.calls.push({ name: "create", value: options });
        return {
            ownershipId: `ownership-${this.calls.length}`,
            workspaceId: options.workspaceId ?? "workspace-1",
            tabId: `tab-${this.calls.length}`,
            paneId: `pane-${this.calls.length}`,
            cwd: options.cwd,
            alias: options.alias,
            paneLabel: options.label ?? options.alias,
            tabLabel: options.label ?? options.alias,
            agentStarted: false,
            closed: false,
        };
    }

    async startPi(
        surface: HerdrOwnedSurface,
        options: StartPiOptions,
    ): Promise<HerdrOperationResult> {
        this.calls.push({ name: "start", value: options });
        if (this.failStart) throw new Error("start failed");
        (surface as { agentStarted: boolean }).agentStarted = true;
        return RESULT;
    }

    async prompt(
        _surface: HerdrOwnedSurface,
        text: string,
        _options?: PromptOptions,
    ): Promise<HerdrOperationResult> {
        this.calls.push({ name: "prompt", value: text });
        if (this.failPrompt) throw new Error("prompt failed");
        return RESULT;
    }

    async steer(
        _surface: HerdrOwnedSurface,
        text: string,
        _options?: HerdrOperationOptions,
    ): Promise<HerdrOperationResult> {
        this.calls.push({ name: "steer", value: text });
        return { raw: {}, status: "working" };
    }

    async interrupt(): Promise<HerdrOperationResult> {
        this.calls.push({ name: "interrupt" });
        return RESULT;
    }

    async inspect(): Promise<HerdrAgentInspection> {
        this.calls.push({ name: "inspect" });
        return this.inspection;
    }

    async rename(surface: HerdrOwnedSurface, alias: string, label: string): Promise<void> {
        this.calls.push({ name: "rename", value: { alias, label } });
        Object.assign(surface, { alias, paneLabel: label, tabLabel: label });
    }

    async close(surface: HerdrOwnedSurface): Promise<void> {
        this.calls.push({ name: "close" });
        (surface as { closed: boolean }).closed = true;
    }

    async recoverSurface(record: PersistedHerdrSurface): Promise<HerdrOwnedSurface> {
        this.calls.push({ name: "recover", value: record });
        return { ...record };
    }

    snapshotSurface(surface: HerdrOwnedSurface): PersistedHerdrSurface {
        return { ...surface };
    }
}

describe("AgentSupervisor", () => {
    let directory: string;
    let store: SqliteControlPlaneStore;
    let parent: AgentRecord;
    let herdr: FakeHerdr;
    let supervisor: AgentSupervisor;
    let activeFailpoint: Failpoint | undefined;

    beforeEach(() => {
        directory = mkdtempSync(join(tmpdir(), "pi-herdr-supervisor-"));
        activeFailpoint = undefined;
        store = SqliteControlPlaneStore.open({
            filename: ":memory:",
            failpoint: (point, context) => activeFailpoint?.(point, context),
        });
        parent = store.registerAgent({ alias: "coordinator", role: "coordinator" });
        herdr = new FakeHerdr();
        const config: OrchestratorConfig = {
            databasePath: join(directory, "control.sqlite"),
            maxLiveAgents: 4,
            maxMessageBytes: 64 * 1024,
            maxResultBytes: 256 * 1024,
            maxPageSize: 100,
            launchTimeoutMs: 30_000,
            operationTimeoutMs: 15_000,
            leaseDurationMs: 60_000,
            messageTtlMs: 86_400_000,
            completionPollMs: 100,
            maxDeliveryBytes: 512 * 1024,
            mailboxRetentionMs: 30 * 86_400_000,
            idempotencyRetentionMs: 90 * 86_400_000,
        };
        supervisor = new AgentSupervisor({
            store,
            herdr,
            config,
            parentAgentId: parent.id,
            sessionDir: directory,
            extensionPath: "/extension.ts",
            lifecycleExtensionPath: "/herdr-agent-state.ts",
            workspaceId: "workspace-1",
        });
    });

    afterEach(() => {
        store.close();
        rmSync(directory, { recursive: true, force: true });
    });

    test("spawns a native Pi agent and durably records its recovery capability", async () => {
        const result = await supervisor.spawn({
            alias: "builder",
            displayName: "Builder",
            role: "implementation",
            prompt: "Build the API",
            cwd: directory,
            tools: ["read"],
        });

        assert.equal(result.agent.status, "running");
        assert.equal(result.agent.parentAgentId, parent.id);
        assert.equal(result.agent.workspaceId, "workspace-1");
        assert.deepEqual(
            herdr.calls.map((call) => call.name),
            ["create", "start", "prompt"],
        );
        const start = herdr.calls[1]?.value as StartPiOptions;
        assert.deepEqual(start.args?.slice(0, 5), [
            "--no-extensions",
            "--extension",
            "/herdr-agent-state.ts",
            "--extension",
            "/extension.ts",
        ]);
        assert.ok(start.args?.includes("--session-id"));
        assert.ok(start.args?.includes("--extension"));
        assert.ok(
            start.args?.includes(
                "read,agent_complete,agent_mail_send,agent_mail_list,agent_mail_ack,agent_mail_sent,agent_mail_retry,agent_directory",
            ),
        );
        assert.match(String(herdr.calls[2]?.value), /call agent_complete exactly once/u);
    });

    test("keeps an interrupted process alive and steers a correction without resume", async () => {
        const spawned = await supervisor.spawn({
            alias: "reviewer",
            role: "review",
            prompt: "Review",
            cwd: directory,
        });
        const interrupted = await supervisor.interrupt(spawned.agent.id);
        assert.equal(interrupted.status, "interrupted");

        const steered = await supervisor.steer({
            recipient: spawned.agent.id,
            instruction: "Use the corrected scope",
            idempotencyKey: "correction-1",
        });
        assert.equal(steered.agent.status, "interrupted");
        assert.equal(steered.delivery.message.kind, "control");
        assert.equal(herdr.calls.filter((call) => call.name === "start").length, 1);
        assert.equal(herdr.calls.filter((call) => call.name === "steer").length, 0);
    });

    test("rejects control for stopped agents while deferring ordinary mail until resume", async () => {
        const spawned = await supervisor.spawn({
            alias: "offline_worker",
            role: "review",
            prompt: "Review",
            cwd: directory,
        });
        const stopped = await supervisor.stop(spawned.agent.id);
        assert.equal(stopped.status, "stopped");
        assert.throws(
            () =>
                supervisor.send({
                    recipient: stopped.id,
                    kind: "control",
                    content: "stale correction",
                }),
            (error: unknown) => {
                assert.match((error as Error).message, /stopped/u);
                return true;
            },
        );
        const deferred = supervisor.send({
            recipient: stopped.id,
            kind: "message",
            content: "read after explicit resume",
        });
        assert.equal(deferred.message.state, "queued");
    });

    test("cannot resolve or control another coordinator namespace", async () => {
        const otherParent = store.registerAgent({ alias: "other_parent", role: "coordinator" });
        const otherChild = store.registerAgent({
            alias: "foreign_child",
            role: "worker",
            parentAgentId: otherParent.id,
        });
        assert.throws(() => supervisor.resolveAgent(otherChild.id), /outside/u);
        await assert.rejects(supervisor.interrupt(otherChild.id), /outside/u);
        assert.equal(herdr.calls.filter((call) => call.name === "interrupt").length, 0);
    });

    test("renames the live Herdr projections and durable alias", async () => {
        const spawned = await supervisor.spawn({
            alias: "old_name",
            role: "review",
            prompt: "Review",
            cwd: directory,
        });
        const renamed = await supervisor.rename({
            agent: spawned.agent.id,
            alias: "new_name",
            displayName: "New name",
        });

        assert.equal(renamed.alias, "new_name");
        assert.equal(store.getAgentByAlias("new_name").id, spawned.agent.id);
        assert.deepEqual(herdr.calls.at(-1), {
            name: "rename",
            value: { alias: "new_name", label: "New name" },
        });
        const inbox = store.listMessages({ recipientAgentId: spawned.agent.id });
        assert.equal(inbox.items[0]?.kind, "control");
    });

    test("rolls registry and Herdr projections back when rename notification fails", async () => {
        const spawned = await supervisor.spawn({
            alias: "rollback_name",
            role: "review",
            prompt: "Review",
            cwd: directory,
        });
        activeFailpoint = new DeterministicFailpoints([{ point: "mailbox.enqueue.after_insert" }])
            .hit;

        await assert.rejects(
            supervisor.rename({
                agent: spawned.agent.id,
                alias: "should_not_stick",
                displayName: "Should not stick",
            }),
        );

        const recovered = store.getAgent(spawned.agent.id);
        assert.equal(recovered.alias, "rollback_name");
        assert.equal(recovered.displayName, "rollback_name");
        assert.deepEqual(herdr.calls.at(-1), {
            name: "rename",
            value: { alias: "rollback_name", label: "rollback_name" },
        });
        assert.equal(store.listMessages({ recipientAgentId: spawned.agent.id }).items.length, 0);
    });

    test("re-adopts persisted surfaces after a supervisor restart", async () => {
        const spawned = await supervisor.spawn({
            alias: "recoverable",
            role: "review",
            prompt: "Review",
            cwd: directory,
        });
        herdr.inspection = { status: "idle", raw: {} };

        const restarted = new AgentSupervisor({
            store,
            herdr,
            config: {
                databasePath: join(directory, "control.sqlite"),
                maxLiveAgents: 4,
                maxMessageBytes: 64 * 1024,
                maxResultBytes: 256 * 1024,
                maxPageSize: 100,
                launchTimeoutMs: 30_000,
                operationTimeoutMs: 15_000,
                leaseDurationMs: 60_000,
                messageTtlMs: 86_400_000,
                completionPollMs: 100,
                maxDeliveryBytes: 512 * 1024,
                mailboxRetentionMs: 30 * 86_400_000,
                idempotencyRetentionMs: 90 * 86_400_000,
            },
            parentAgentId: parent.id,
            sessionDir: directory,
            extensionPath: "/extension.ts",
            workspaceId: "workspace-1",
        });
        const recovered = await restarted.recover();

        assert.deepEqual(recovered, [
            { agentId: spawned.agent.id, recovered: true, status: "idle" },
        ]);
        assert.equal(store.getAgent(spawned.agent.id).status, "idle");
    });

    test("persists a failed launch and compensates its owned tab", async () => {
        herdr.failStart = true;
        await assert.rejects(
            supervisor.spawn({
                alias: "broken",
                role: "test",
                prompt: "Fail",
                cwd: directory,
            }),
            (error: unknown) =>
                error instanceof OrchestratorError &&
                error.code === "EXTERNAL_OPERATION_FAILED" &&
                error.details.phase === "start_pi" &&
                error.details.orphaned === false,
        );
        assert.equal(store.getAgentByAlias("broken").status, "failed");
        assert.equal(herdr.calls.at(-1)?.name, "close");
    });

    test("identifies failure while submitting the initial prompt", async () => {
        herdr.failPrompt = true;
        await assert.rejects(
            supervisor.spawn({
                alias: "prompt_broken",
                role: "test",
                prompt: "Fail after startup",
                cwd: directory,
            }),
            (error: unknown) =>
                error instanceof OrchestratorError &&
                error.details.phase === "submit_initial_prompt" &&
                /during submit_initial_prompt/u.test(error.message),
        );
        const failed = store.getAgentByAlias("prompt_broken");
        assert.equal(failed.status, "failed");
        assert.equal(
            (failed.metadata as { launchFailure?: { phase?: string } }).launchFailure?.phase,
            "submit_initial_prompt",
        );
    });

    test("resumes only an identity-matching Pi session file", async () => {
        const spawned = await supervisor.spawn({
            alias: "resumable",
            role: "test",
            prompt: "Work",
            cwd: directory,
        });
        const sessionFile = join(directory, "child.jsonl");
        writeFileSync(
            sessionFile,
            `${JSON.stringify({
                type: "session",
                version: 3,
                id: spawned.sessionId,
                timestamp: new Date().toISOString(),
                cwd: directory,
            })}\n`,
        );
        const latest = store.getAgent(spawned.agent.id);
        store.patchAgent({
            agentId: latest.id,
            patch: { sessionFile },
            expectedRevision: latest.revision,
        });
        await supervisor.stop(spawned.agent.id);

        const resumed = await supervisor.resume({
            agent: spawned.agent.id,
            instruction: "Continue safely",
        });
        assert.equal(resumed.status, "running");
        const starts = herdr.calls.filter((call) => call.name === "start");
        assert.equal(starts.length, 2);
        const resumedStart = starts[1];
        assert.ok(resumedStart);
        const resumedArgs = (resumedStart.value as StartPiOptions).args;
        assert.deepEqual(resumedArgs?.slice(0, 5), [
            "--no-extensions",
            "--extension",
            "/herdr-agent-state.ts",
            "--extension",
            "/extension.ts",
        ]);
        assert.ok(resumedArgs?.includes(sessionFile));
    });

    test("re-adopts and closes a completed child after parent runtime replacement", async () => {
        const spawned = await supervisor.spawn({
            alias: "finisher",
            role: "test",
            prompt: "Finish",
            cwd: directory,
        });
        const current = store.getAgent(spawned.agent.id);
        store.transitionAgent({
            agentId: current.id,
            status: "completed",
            patch: {},
            expectedRevision: current.revision,
        });
        const restarted = new AgentSupervisor({
            store,
            herdr,
            config: {
                databasePath: join(directory, "control.sqlite"),
                maxLiveAgents: 4,
                maxMessageBytes: 64 * 1024,
                maxResultBytes: 256 * 1024,
                maxPageSize: 100,
                launchTimeoutMs: 30_000,
                operationTimeoutMs: 15_000,
                leaseDurationMs: 60_000,
                messageTtlMs: 86_400_000,
                completionPollMs: 100,
                maxDeliveryBytes: 512 * 1024,
                mailboxRetentionMs: 30 * 86_400_000,
                idempotencyRetentionMs: 90 * 86_400_000,
            },
            parentAgentId: parent.id,
            sessionDir: directory,
            extensionPath: "/extension.ts",
            workspaceId: "workspace-1",
        });

        await restarted.finalizeCompletedAgent(spawned.agent.id);
        assert.deepEqual(
            herdr.calls.slice(-2).map((call) => call.name),
            ["recover", "close"],
        );
    });

    test("routes by immutable id or mutable alias", () => {
        const child = store.registerAgent({
            alias: "lookup",
            role: "test",
            parentAgentId: parent.id,
        });
        assert.equal(supervisor.resolveAgent("lookup").id, child.id);
        assert.equal(supervisor.resolveAgent(child.id as AgentId).alias, "lookup");
        assert.throws(() => supervisor.resolveAgent("missing"), NotFoundError);
    });
});
