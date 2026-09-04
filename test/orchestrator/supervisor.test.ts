import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { OrchestratorConfig } from "../../src/config.ts";
import type { AgentRecord } from "../../src/domain/agent.ts";
import { NotFoundError } from "../../src/domain/errors.ts";
import type { AgentId } from "../../src/domain/ids.ts";
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

    beforeEach(() => {
        directory = mkdtempSync(join(tmpdir(), "pi-herdr-supervisor-"));
        store = SqliteControlPlaneStore.open({ filename: ":memory:" });
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
        };
        supervisor = new AgentSupervisor({
            store,
            herdr,
            config,
            parentAgentId: parent.id,
            sessionDir: directory,
            extensionPath: "/extension.ts",
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
        assert.ok(start.args?.includes("--session-id"));
        assert.ok(start.args?.includes("--extension"));
        assert.ok(
            start.args?.includes(
                "read,agent_complete,agent_mail_send,agent_mail_list,agent_mail_ack",
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
                error.details.orphaned === false,
        );
        assert.equal(store.getAgentByAlias("broken").status, "failed");
        assert.equal(herdr.calls.at(-1)?.name, "close");
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
        assert.ok((resumedStart.value as StartPiOptions).args?.includes(sessionFile));
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
