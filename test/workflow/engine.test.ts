import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import type { AgentRecord } from "../../src/domain/agent.ts";
import type { AgentId } from "../../src/domain/ids.ts";
import type { SpawnAgentRequest, SpawnAgentResult } from "../../src/orchestrator/types.ts";
import { SqliteControlPlaneStore } from "../../src/storage/index.ts";
import { WorkflowEngine, type WorkflowSupervisor } from "../../src/workflow/index.ts";

class FakeSupervisor implements WorkflowSupervisor {
    readonly store: SqliteControlPlaneStore;
    readonly calls: SpawnAgentRequest[] = [];
    readonly stopped: AgentId[] = [];
    activeSpawns = 0;
    maxActiveSpawns = 0;
    spawnGate: Promise<void> | undefined;

    constructor(store: SqliteControlPlaneStore) {
        this.store = store;
    }

    async spawn(request: SpawnAgentRequest): Promise<SpawnAgentResult> {
        this.calls.push(request);
        this.activeSpawns += 1;
        this.maxActiveSpawns = Math.max(this.maxActiveSpawns, this.activeSpawns);
        try {
            if (this.spawnGate !== undefined) await this.spawnGate;
            let agent = this.store.registerAgent({
                alias: request.alias,
                role: request.role,
                ...(request.displayName === undefined ? {} : { displayName: request.displayName }),
                ...(request.metadata === undefined ? {} : { metadata: request.metadata }),
            });
            agent = this.store.transitionAgent({
                agentId: agent.id,
                status: "starting",
                patch: {},
                expectedRevision: agent.revision,
            });
            agent = this.store.transitionAgent({
                agentId: agent.id,
                status: "running",
                patch: {},
                expectedRevision: agent.revision,
            });
            return { agent, sessionId: randomUUID() };
        } finally {
            this.activeSpawns -= 1;
        }
    }

    async stop(identifier: AgentId | string): Promise<AgentRecord> {
        let agent: AgentRecord;
        try {
            agent = this.store.getAgent(identifier as AgentId);
        } catch {
            agent = this.store.getAgentByAlias(identifier);
        }
        this.stopped.push(agent.id);
        if (agent.status !== "stopping") {
            agent = this.store.transitionAgent({
                agentId: agent.id,
                status: "stopping",
                patch: {},
                expectedRevision: agent.revision,
            });
        }
        return this.store.transitionAgent({
            agentId: agent.id,
            status: "stopped",
            patch: {},
            expectedRevision: agent.revision,
        });
    }
}

const openStores: SqliteControlPlaneStore[] = [];
const temporaryDirectories: string[] = [];

function openStore(filename = ":memory:"): SqliteControlPlaneStore {
    const value = SqliteControlPlaneStore.open({ filename });
    openStores.push(value);
    return value;
}

function pipeline(engine: WorkflowEngine) {
    return engine.start({
        name: "pipeline",
        nodes: [
            {
                nodeId: "research",
                task: {
                    alias: "researcher",
                    role: "research",
                    prompt: "Research the contract",
                    cwd: "/tmp",
                },
            },
            {
                nodeId: "build",
                dependencies: ["research"],
                task: {
                    alias: "builder",
                    role: "implementation",
                    prompt: "Build the contract",
                    cwd: "/tmp",
                },
            },
        ],
    });
}

afterEach(() => {
    while (openStores.length > 0) openStores.pop()?.close();
    while (temporaryDirectories.length > 0) {
        const directory = temporaryDirectories.pop();
        if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
    }
});

describe("WorkflowEngine", () => {
    test("runs a DAG in dependency order and unlocks successors on durable completion", async () => {
        const storage = openStore();
        const supervisor = new FakeSupervisor(storage);
        const engine = new WorkflowEngine({ store: storage, supervisor, maxConcurrent: 2 });
        const workflow = pipeline(engine);

        assert.deepEqual(await engine.tick(), { claimed: 1, resumed: 0, spawnFailures: 0 });
        assert.equal(supervisor.calls.length, 1);
        assert.match(supervisor.calls[0]?.alias ?? "", /^researcher-[0-9a-f]{8}$/u);
        const researchAgent = storage.getAgentByAlias(supervisor.calls[0]?.alias ?? "missing");
        let current = await engine.acceptCompletion({
            agentId: researchAgent.id,
            status: "succeeded",
            result: { finding: "verified" },
        });
        assert.equal(current.nodes.find((node) => node.nodeId === "build")?.status, "ready");

        await engine.tick();
        assert.equal(supervisor.calls.length, 2);
        assert.match(supervisor.calls[1]?.alias ?? "", /^builder-[0-9a-f]{8}$/u);
        const builder = storage.getAgentByAlias(supervisor.calls[1]?.alias ?? "missing");
        current = await engine.acceptCompletion({ agentId: builder.id, status: "succeeded" });
        assert.equal(current.id, workflow.id);
        assert.equal(current.status, "succeeded");
    });

    test("enforces the global concurrency cap and coalesces duplicate ticks", async () => {
        const storage = openStore();
        const supervisor = new FakeSupervisor(storage);
        let releaseGate: (() => void) | undefined;
        supervisor.spawnGate = new Promise<void>((resolve) => {
            releaseGate = resolve;
        });
        const engine = new WorkflowEngine({ store: storage, supervisor, maxConcurrent: 2 });
        const workflow = engine.start({
            name: "bounded",
            nodes: ["one", "two", "three"].map((nodeId) => ({
                nodeId,
                task: {
                    alias: `agent-${nodeId}`,
                    role: "worker",
                    prompt: nodeId,
                    cwd: "/tmp",
                },
            })),
        });

        const firstTick = engine.tick();
        const duplicateTick = engine.tick();
        assert.equal(firstTick, duplicateTick);
        while (supervisor.calls.length < 2) {
            // Sequential polling is intentional: this observes the in-flight scheduler without
            // creating an unbounded batch of timers.
            // eslint-disable-next-line no-await-in-loop
            await new Promise((resolve) => setImmediate(resolve));
        }
        assert.equal(supervisor.calls.length, 2);
        assert.equal(supervisor.maxActiveSpawns, 2);
        releaseGate?.();
        await firstTick;

        const running = engine
            .getStatus(workflow.id)
            .nodes.filter((node) => node.status === "running");
        assert.equal(running.length, 2);
        await engine.tick();
        assert.equal(supervisor.calls.length, 2);
    });

    test("marks failed nodes and transitively blocks their descendants", async () => {
        const storage = openStore();
        const supervisor = new FakeSupervisor(storage);
        const engine = new WorkflowEngine({ store: storage, supervisor });
        const workflow = pipeline(engine);
        await engine.tick();

        const agent = storage.getAgentByAlias(supervisor.calls[0]?.alias ?? "missing");
        const current = await engine.acceptCompletion({
            agentId: agent.id,
            status: "failed",
            error: "contract mismatch",
            result: { retryable: false },
        });
        assert.equal(current.status, "failed");
        assert.equal(current.nodes.find((node) => node.nodeId === "research")?.status, "failed");
        assert.equal(current.nodes.find((node) => node.nodeId === "build")?.status, "blocked");
        assert.equal((await engine.tick()).claimed, 0);
        assert.equal(engine.getStatus(workflow.id).status, "failed");
    });

    test("reconciles persisted reservations after restart without duplicate spawn", async () => {
        const directory = mkdtempSync(join(tmpdir(), "pi-herdr-workflow-"));
        temporaryDirectories.push(directory);
        const filename = join(directory, "control.sqlite");
        const initialStore = openStore(filename);
        const initialSupervisor = new FakeSupervisor(initialStore);
        const initialEngine = new WorkflowEngine({
            store: initialStore,
            supervisor: initialSupervisor,
        });
        const workflow = pipeline(initialEngine);
        await initialEngine.tick();
        assert.equal(initialSupervisor.calls.length, 1);
        initialStore.close();
        openStores.splice(openStores.indexOf(initialStore), 1);

        const reopenedStore = openStore(filename);
        const restartedSupervisor = new FakeSupervisor(reopenedStore);
        const restartedEngine = new WorkflowEngine({
            store: reopenedStore,
            supervisor: restartedSupervisor,
        });
        const result = await restartedEngine.tick();

        assert.equal(result.resumed, 1);
        assert.equal(restartedSupervisor.calls.length, 0);
        assert.equal(restartedEngine.getStatus(workflow.id).status, "running");
    });

    test("derives distinct stable Herdr aliases when workflows reuse a task alias", async () => {
        const storage = openStore();
        const supervisor = new FakeSupervisor(storage);
        const engine = new WorkflowEngine({ store: storage, supervisor, maxConcurrent: 2 });
        const task = {
            alias: "shared-worker-name-that-is-long",
            role: "worker",
            prompt: "Run",
            cwd: "/tmp",
        } as const;
        engine.start({ name: "first", nodes: [{ nodeId: "work", task }] });
        engine.start({ name: "second", nodes: [{ nodeId: "work", task }] });

        await engine.tick();
        const aliases = supervisor.calls.map((call) => call.alias);
        assert.equal(aliases.length, 2);
        assert.equal(new Set(aliases).size, 2);
        assert.equal(
            aliases.every((alias) => alias.length <= 32),
            true,
        );
        assert.equal(
            aliases.every((alias) => /^[a-z][a-z0-9_-]*$/u.test(alias)),
            true,
        );
    });

    test("rejects relative working directories before persisting a workflow", () => {
        const storage = openStore();
        const engine = new WorkflowEngine({
            store: storage,
            supervisor: new FakeSupervisor(storage),
        });
        assert.throws(
            () =>
                engine.start({
                    name: "invalid",
                    nodes: [
                        {
                            nodeId: "work",
                            task: {
                                alias: "worker",
                                role: "worker",
                                prompt: "Run",
                                cwd: "relative/path",
                            },
                        },
                    ],
                }),
            /absolute path/u,
        );
        assert.equal(storage.listWorkflows().items.length, 0);
    });

    test("cancels safely mapped running agents and pending descendants", async () => {
        const storage = openStore();
        const supervisor = new FakeSupervisor(storage);
        const engine = new WorkflowEngine({ store: storage, supervisor });
        const workflow = pipeline(engine);
        await engine.tick();

        const cancelled = await engine.cancel(workflow.id);
        assert.equal(cancelled.stopErrors.length, 0);
        assert.equal(supervisor.stopped.length, 1);
        assert.equal(cancelled.workflow.status, "cancelled");
        assert.equal(
            cancelled.workflow.nodes.every((node) => node.status === "cancelled"),
            true,
        );
    });
});
