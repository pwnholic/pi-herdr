import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import type {
    AgentEndEvent,
    ExtensionAPI,
    ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AgentRecord } from "../../src/domain/agent.ts";
import type { AgentId } from "../../src/domain/ids.ts";
import { registerPiHerdrExtension } from "../../src/extension.ts";
import { DeterministicFailpoints } from "../../src/faults.ts";
import { PiHerdrRuntime } from "../../src/pi/runtime.ts";
import { registerPiHerdrTools } from "../../src/pi/tools.ts";
import { SqliteControlPlaneStore } from "../../src/storage/index.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

function fixture() {
    const directory = mkdtempSync(join(tmpdir(), "pi-herdr-runtime-"));
    temporaryDirectories.push(directory);
    const filename = join(directory, "control.sqlite");
    const setupStore = SqliteControlPlaneStore.open({ filename });
    const parent = setupStore.registerAgent({
        alias: "coordinator-test",
        role: "coordinator",
    });
    let child = setupStore.registerAgent({
        alias: "worker-test",
        role: "worker",
        parentAgentId: parent.id,
    });
    child = setupStore.transitionAgent({
        agentId: child.id,
        status: "starting",
        patch: {},
        expectedRevision: child.revision,
    });
    const sent: Array<{ message: unknown; options: unknown }> = [];
    const entries: unknown[] = [];
    const names: string[] = [];
    const pi = {
        setSessionName: (name: string) => names.push(name),
        getSessionName: () => undefined,
        sendMessage: (message: unknown, options: unknown) => {
            sent.push({ message, options });
            entries.push({ type: "custom_message", ...(message as object) });
        },
    } as unknown as ExtensionAPI;
    const context = {
        cwd: directory,
        isIdle: () => true,
        hasPendingMessages: () => false,
        sessionManager: {
            getSessionDir: () => directory,
            getSessionId: () => "44444444-4444-4444-8444-444444444444",
            getSessionFile: () => join(directory, "session.jsonl"),
            getEntries: () => entries,
        },
        shutdown: () => {
            throw new Error("child runtime must not request shutdown");
        },
    } as unknown as ExtensionContext;
    const runtime = new PiHerdrRuntime(pi, {
        extensionPath: join(directory, "extension.ts"),
        environment: {
            PI_HERDR_AGENT_ID: child.id,
            PI_HERDR_PARENT_ID: parent.id,
            PI_HERDR_DB: filename,
            PI_HERDR_COMPLETION_POLL_MS: "60000",
        },
    });
    return {
        directory,
        filename,
        setupStore,
        parent,
        child,
        pi,
        context,
        runtime,
        sent,
        names,
        entries,
    };
}

function assistantEvent(stopReason: "stop" | "aborted", text = "final answer"): AgentEndEvent {
    return {
        type: "agent_end",
        messages: [
            {
                role: "assistant",
                stopReason,
                content: [{ type: "text", text }],
            },
        ],
    } as AgentEndEvent;
}

function current(store: SqliteControlPlaneStore, agent: AgentRecord): AgentRecord {
    return store.getAgent(agent.id);
}

test("a duplicate runtime cannot alter an active binding; clean stop permits replacement", async () => {
    const f = fixture();
    const replacement = new PiHerdrRuntime(f.pi, {
        extensionPath: join(f.directory, "extension.ts"),
        environment: {
            PI_HERDR_AGENT_ID: f.child.id,
            PI_HERDR_PARENT_ID: f.parent.id,
            PI_HERDR_DB: f.filename,
        },
    });
    try {
        await f.runtime.start(f.context);
        const before = f.setupStore.getAgent(f.child.id);
        await assert.rejects(replacement.start(f.context), /execution/);
        assert.deepEqual(f.setupStore.getAgent(f.child.id), before);
        f.runtime.onAgentStart();
        await f.runtime.stop();
        await replacement.start(f.context);
        replacement.onAgentStart();
        assert.equal(f.setupStore.getAgent(f.child.id).status, "running");
    } finally {
        await f.runtime.stop();
        await replacement.stop();
        f.setupStore.close();
    }
});

test("runtime heartbeat renews ownership and lease loss stays failed closed until restart", async (t) => {
    const f = fixture();
    let now = 1000;
    let bound: SqliteControlPlaneStore | undefined;
    const errors: unknown[] = [];
    t.mock.timers.enable({ apis: ["setInterval"] });
    const runtime = new PiHerdrRuntime(f.pi, {
        extensionPath: join(f.directory, "extension.ts"),
        environment: {
            PI_HERDR_AGENT_ID: f.child.id,
            PI_HERDR_PARENT_ID: f.parent.id,
            PI_HERDR_DB: f.filename,
            PI_HERDR_COMPLETION_POLL_MS: "60000",
        },
        openStore: (filename) => {
            bound = SqliteControlPlaneStore.open({ filename, clock: { now: () => now } });
            return bound;
        },
        onError: (error) => errors.push(error),
    });
    try {
        await runtime.start(f.context);
        assert.equal(bound?.execution?.expiresAt, 61000);
        now = 21000;
        t.mock.timers.tick(20000);
        assert.equal(bound?.execution?.expiresAt, 81000);
        now = 81000;
        t.mock.timers.tick(20000);
        assert.match(String(errors[0]), /execution/);
        now = 21000; // Clock recovery must not silently restore runtime authority.
        assert.throws(() => runtime.onAgentStart(), /ownership is unsafe/);
        await runtime.stop();
        await runtime.start(f.context);
        assert.equal(bound?.execution?.epoch, 2);
        runtime.onAgentStart();
    } finally {
        await runtime.stop();
        t.mock.timers.reset();
        f.setupStore.close();
    }
});

for (const condition of ["busy", "pending"] as const) {
    test(`settlement rejects a completion draft when Pi is ${condition}`, async () => {
        const { runtime, context, setupStore, child, parent } = fixture();
        try {
            await runtime.start(context);
            runtime.onAgentStart();
            runtime.declareCompletion({ status: "succeeded", summary: "premature" }, "draft");
            await runtime.onAgentSettled({
                ...context,
                isIdle: () => condition !== "busy",
                hasPendingMessages: () => condition === "pending",
            });
            assert.equal(setupStore.getCompletion(child.id)?.state, "invalidated");
            assert.equal(setupStore.listMessages({ recipientAgentId: parent.id }).items.length, 0);
        } finally {
            await runtime.stop();
            setupStore.close();
        }
    });
}

test("a later model turn in the same agent run invalidates the completion draft", async () => {
    const { runtime, context, setupStore, child, parent } = fixture();
    try {
        await runtime.start(context);
        runtime.onAgentStart();
        runtime.declareCompletion({ status: "succeeded", summary: "old turn" }, "draft");
        runtime.onTurnStart();
        await runtime.onAgentSettled(context);
        assert.equal(setupStore.getCompletion(child.id)?.state, "invalidated");
        assert.equal(setupStore.listMessages({ recipientAgentId: parent.id }).items.length, 0);
        runtime.declareCompletion({ status: "succeeded", summary: "revised" }, "new-draft");
        await runtime.onAgentSettled(context);
        assert.equal(setupStore.getCompletion(child.id)?.state, "emitted");
    } finally {
        await runtime.stop();
        setupStore.close();
    }
});

test("child startup refuses to replace an assigned Pi session binding", async () => {
    const { runtime, context, setupStore, child } = fixture();
    const assigned = "77777777-7777-4777-8777-777777777777";
    setupStore.patchAgent({
        agentId: child.id,
        patch: { sessionId: assigned },
        expectedRevision: child.revision,
    });
    try {
        await assert.rejects(runtime.start(context), /session/i);
        assert.equal(setupStore.getAgent(child.id).sessionId, assigned);
    } finally {
        await runtime.stop();
        setupStore.close();
    }
});

test("a changed session binding fences an already running child", async () => {
    const { runtime, context, setupStore, child, parent } = fixture();
    try {
        await runtime.start(context);
        const bound = setupStore.getAgent(child.id);
        setupStore.patchAgent({
            agentId: child.id,
            patch: { sessionId: "77777777-7777-4777-8777-777777777777" },
            expectedRevision: bound.revision,
        });
        assert.throws(
            () => runtime.sendMail({ recipient: parent.id, content: "stale" }),
            /session/i,
        );
        await assert.rejects(runtime.onAgentSettled(context), /session/i);
    } finally {
        await runtime.stop();
        setupStore.close();
    }
});

test("protocol writes are frozen after completion declaration until the next model turn", async () => {
    const { runtime, context, setupStore, parent } = fixture();
    try {
        await runtime.start(context);
        runtime.onAgentStart();
        runtime.declareCompletion({ status: "succeeded", summary: "done" }, "draft");
        assert.throws(() => runtime.sendMail({ recipient: parent.id, content: "late" }), /frozen/i);
        assert.throws(() => runtime.retryDeadLetter(parent.id), /frozen/i);
        await assert.rejects(runtime.readMail(parent.id), /frozen/i);
        await assert.rejects(runtime.acknowledgeMail(parent.id), /frozen/i);
        runtime.onTurnStart();
        assert.doesNotThrow(() => runtime.sendMail({ recipient: parent.id, content: "new turn" }));
    } finally {
        await runtime.stop();
        setupStore.close();
    }
});

test("extension turn_start wiring invalidates a draft inside the same agent run", async () => {
    const base = fixture();
    const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
    const runtime = registerPiHerdrExtension(
        {
            ...base.pi,
            registerTool: () => undefined,
            on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
                handlers.set(name, handler);
            },
        } as unknown as ExtensionAPI,
        {
            extensionPath: join(base.directory, "extension.ts"),
            environment: {
                PI_HERDR_AGENT_ID: base.child.id,
                PI_HERDR_PARENT_ID: base.parent.id,
                PI_HERDR_RUN_ID: base.child.runId,
                PI_HERDR_DB: base.filename,
                PI_HERDR_COMPLETION_POLL_MS: "60000",
            },
        },
    );
    try {
        await handlers.get("session_start")!({}, base.context);
        await handlers.get("agent_start")!({}, base.context);
        runtime.declareCompletion({ status: "succeeded", summary: "draft" }, "draft");
        assert.ok(handlers.has("turn_start"));
        await handlers.get("turn_start")!({}, base.context);
        await handlers.get("agent_settled")!({}, base.context);
        assert.equal(base.setupStore.getCompletion(base.child.id)?.state, "invalidated");
        assert.equal(
            base.setupStore.listMessages({ recipientAgentId: base.parent.id }).items.length,
            0,
        );
    } finally {
        await runtime.stop();
        base.setupStore.close();
    }
});

test("session-manager replacement fences child tools before the registry changes", async () => {
    const { runtime, context, setupStore, parent } = fixture();
    let sessionId = context.sessionManager.getSessionId();
    const mutableContext = {
        ...context,
        sessionManager: { ...context.sessionManager, getSessionId: () => sessionId },
    } as ExtensionContext;
    try {
        await runtime.start(mutableContext);
        sessionId = "77777777-7777-4777-8777-777777777777";
        assert.throws(
            () => runtime.sendMail({ recipient: parent.id, content: "stale" }),
            /session/i,
        );
        assert.throws(
            () => runtime.declareCompletion({ status: "succeeded", summary: "stale" }, "stale"),
            /session/i,
        );
    } finally {
        await runtime.stop();
        setupStore.close();
    }
});

test("an aborted last assistant turn invalidates pending completion and stays alive", async () => {
    const { runtime, context, setupStore, child, parent } = fixture();
    await runtime.start(context);
    runtime.onAgentStart();
    runtime.declareCompletion({ status: "succeeded", summary: "premature" }, "tool-call-1");

    runtime.onAgentEnd(assistantEvent("aborted"));
    await runtime.onAgentSettled(context);

    assert.equal(current(setupStore, child).status, "interrupted");
    assert.equal(setupStore.listMessages({ recipientAgentId: parent.id }).items.length, 0);
    await runtime.stop();
    setupStore.close();
});

test("explicit completion emits one durable result after settled without child shutdown", async () => {
    const { runtime, context, setupStore, child, parent } = fixture();
    await runtime.start(context);
    runtime.onAgentStart();
    runtime.declareCompletion(
        { status: "succeeded", summary: "implemented", details: { tests: 3 } },
        "tool-call-2",
    );
    runtime.onAgentEnd(assistantEvent("stop"));

    await runtime.onAgentSettled(context);
    await runtime.onAgentSettled(context);

    assert.equal(current(setupStore, child).status, "completed");
    const results = setupStore.listMessages({
        recipientAgentId: parent.id,
        states: ["queued"],
    }).items;
    assert.equal(results.length, 1);
    assert.equal(results[0]?.kind, "result");
    assert.equal(JSON.parse(results[0]?.content ?? "{}").summary, "implemented");
    await runtime.stop();
    setupStore.close();
});

test("one durable correction is injected exactly once through Pi steer delivery", async () => {
    const { runtime, context, setupStore, child, parent, sent } = fixture();
    const queued = setupStore.enqueueMessage({
        senderAgentId: parent.id,
        recipientAgentId: child.id,
        kind: "control",
        content: "Use the corrected requirement",
        metadata: { action: "steer" },
    });
    await runtime.start(context);

    await runtime.readMail(queued.message.id);
    await runtime.readMail(queued.message.id);

    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0]?.options, { triggerTurn: true, deliverAs: "steer" });
    assert.equal(setupStore.getMessage(queued.message.id).state, "read");
    await runtime.stop();
    setupStore.close();
});

test("read-by-id never exposes a later queued payload ahead of FIFO ownership", async () => {
    const { runtime, context, setupStore, child, parent } = fixture();
    const first = setupStore.enqueueMessage({
        senderAgentId: parent.id,
        recipientAgentId: child.id,
        kind: "message",
        content: "first",
    }).message;
    const second = setupStore.enqueueMessage({
        senderAgentId: parent.id,
        recipientAgentId: child.id,
        kind: "message",
        content: "second",
    }).message;
    await runtime.start(context);

    await assert.rejects(runtime.readMail(second.id), /not currently readable/u);
    await runtime.readMail(first.id);
    await runtime.acknowledgeMail(first.id);
    const accepted = await runtime.readMail(second.id);
    assert.equal(accepted.id, second.id);
    assert.equal(accepted.state, "read");
    await runtime.stop();
    setupStore.close();
});

test("read-by-id never exposes a message leased by another Pi process", async () => {
    const { runtime, context, setupStore, child, parent } = fixture();
    const message = setupStore.enqueueMessage({
        senderAgentId: parent.id,
        recipientAgentId: child.id,
        kind: "message",
        content: "owned elsewhere",
    }).message;
    const [claimed] = setupStore.claimMessages({
        recipientAgentId: child.id,
        owner: "another-pi-process",
        leaseMs: 60_000,
        limit: 1,
        messageId: message.id,
    });
    assert.ok(claimed);
    setupStore.markMessageRead({
        messageId: claimed.id,
        recipientAgentId: child.id,
        owner: "another-pi-process",
        expectedRevision: claimed.revision,
    });
    await runtime.start(context);

    await assert.rejects(runtime.readMail(message.id), /not currently readable/u);
    assert.equal(setupStore.getMessage(message.id).leaseOwner, "another-pi-process");
    await runtime.stop();
    setupStore.close();
});

test("child registration exposes completion but not parent control tools", () => {
    const names: string[] = [];
    const definitions: Array<{ name: string; execute: (...args: never[]) => unknown }> = [];
    const pi = {
        registerTool: (definition: { name: string; execute: (...args: never[]) => unknown }) => {
            names.push(definition.name);
            definitions.push(definition);
        },
    } as unknown as ExtensionAPI;
    const runtime = {
        declareCompletion: (completion: unknown, token: string) => ({ completion, token }),
    } as unknown as PiHerdrRuntime;
    registerPiHerdrTools(pi, runtime, true);

    assert.ok(names.includes("agent_complete"));
    assert.ok(names.includes("agent_mail_send"));
    assert.ok(names.includes("agent_mail_sent"));
    assert.ok(!names.includes("agent_mail_dead_letters"));
    assert.ok(!names.includes("agent_mail_status"));
    assert.ok(names.includes("agent_directory"));
    assert.ok(!names.includes("agent_spawn"));
    assert.ok(!names.includes("workflow_start"));
    assert.equal(definitions.length, names.length);
});

test("agent_complete binds idempotency to its tool call and requests batch termination", async () => {
    const definitions: Array<{ name: string; execute: (...args: never[]) => unknown }> = [];
    let observedToken: string | undefined;
    const pi = {
        registerTool: (definition: { name: string; execute: (...args: never[]) => unknown }) =>
            definitions.push(definition),
    } as unknown as ExtensionAPI;
    const runtime = {
        declareCompletion: (completion: unknown, token: string) => {
            observedToken = token;
            return completion;
        },
    } as unknown as PiHerdrRuntime;
    registerPiHerdrTools(pi, runtime, true);
    const complete = definitions.find((definition) => definition.name === "agent_complete");
    assert.ok(complete);

    const execute = complete.execute as unknown as (
        toolCallId: string,
        params: unknown,
        signal: undefined,
        onUpdate: undefined,
        context: unknown,
    ) => Promise<unknown>;
    const result = (await execute(
        "tool-call-stable-token",
        { status: "succeeded", summary: "done" },
        undefined,
        undefined,
        {},
    )) as { terminate?: boolean };

    assert.equal(observedToken, "tool-call-stable-token");
    assert.equal(result.terminate, true);
});

test("parent registration exposes workflow engine tools but not child completion", () => {
    const names: string[] = [];
    const pi = {
        registerTool: (definition: { name: string }) => names.push(definition.name),
    } as unknown as ExtensionAPI;
    registerPiHerdrTools(pi, {} as PiHerdrRuntime, false);

    assert.ok(names.includes("agent_spawn"));
    assert.ok(names.includes("agent_mail_dead_letters"));
    assert.ok(names.includes("agent_mail_status"));
    assert.ok(names.includes("workflow_start"));
    assert.ok(names.includes("workflow_cancel"));
    assert.ok(!names.includes("agent_complete"));
});

test("passes the installed Herdr lifecycle extension to isolated children", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-herdr-lifecycle-"));
    temporaryDirectories.push(directory);
    const extensionDirectory = join(directory, "extensions");
    const lifecycleExtensionPath = join(extensionDirectory, "herdr-agent-state.ts");
    mkdirSync(extensionDirectory, { recursive: true });
    writeFileSync(lifecycleExtensionPath, "export default () => undefined;\n");

    let observedLifecycleExtensionPath: string | undefined;
    const runtime = new PiHerdrRuntime(
        {
            getSessionName: () => "Coordinator",
            setSessionName: () => undefined,
            sendMessage: () => undefined,
        } as unknown as ExtensionAPI,
        {
            extensionPath: join(directory, "pi-herdr.ts"),
            environment: {
                PI_CODING_AGENT_DIR: directory,
                PI_HERDR_DB: join(directory, "control.sqlite"),
                PI_HERDR_COMPLETION_POLL_MS: "60000",
            },
            createHerdr: () => ({ isManagedEnvironment: () => false }) as never,
            createSupervisor: (options) => {
                observedLifecycleExtensionPath = options.lifecycleExtensionPath;
                return { recover: async () => [] } as never;
            },
        },
    );
    const context = {
        cwd: directory,
        sessionManager: {
            getSessionDir: () => directory,
            getSessionId: () => "66666666-6666-4666-8666-666666666666",
            getSessionFile: () => join(directory, "parent.jsonl"),
        },
    } as unknown as ExtensionContext;

    await runtime.start(context);
    assert.equal(observedLifecycleExtensionPath, lifecycleExtensionPath);
    await runtime.stop();
});

test("parent finalizes a result before notification and automatic acknowledgement", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-herdr-parent-"));
    temporaryDirectories.push(directory);
    const filename = join(directory, "control.sqlite");
    const order: string[] = [];
    const entries: unknown[] = [];
    const failpoints = new DeterministicFailpoints([{ point: "completion.notification.after" }]);
    const pi = {
        getSessionName: () => "Coordinator",
        setSessionName: () => undefined,
        sendMessage: (message: unknown) => {
            order.push("notify");
            entries.push({ type: "custom_message", ...(message as object) });
        },
    } as unknown as ExtensionAPI;
    const context = {
        cwd: directory,
        sessionManager: {
            getSessionDir: () => directory,
            getSessionId: () => "55555555-5555-4555-8555-555555555555",
            getSessionFile: () => join(directory, "parent.jsonl"),
            getEntries: () => entries,
        },
    } as unknown as ExtensionContext;
    const runtime = new PiHerdrRuntime(pi, {
        extensionPath: join(directory, "extension.ts"),
        environment: {
            PI_HERDR_DB: filename,
            PI_HERDR_COMPLETION_POLL_MS: "60000",
        },
        failpoint: failpoints.hit,
        createHerdr: () => ({ isManagedEnvironment: () => false }) as never,
        createSupervisor: (options) =>
            ({
                recover: async () => [],
                resolveAgent: (agentId: AgentId) => options.store.getAgent(agentId),
                finalizeCompletedAgent: async () => {
                    order.push("finalize");
                },
                spawn: async () => {
                    throw new Error("not used");
                },
                stop: async () => {
                    throw new Error("not used");
                },
            }) as never,
    });
    await runtime.start(context);
    const setupStore = SqliteControlPlaneStore.open({ filename });
    let child = setupStore.registerAgent({
        alias: "result-worker",
        role: "worker",
        parentAgentId: runtime.identity.id,
    });
    child = setupStore.transitionAgent({
        agentId: child.id,
        status: "starting",
        patch: {},
        expectedRevision: child.revision,
    });
    child = setupStore.transitionAgent({
        agentId: child.id,
        status: "running",
        patch: {},
        expectedRevision: child.revision,
    });
    setupStore.declareCompletion({
        agentId: child.id,
        runId: child.runId,
        invocationToken: "parent-result-test",
        payload: { status: "succeeded", summary: "done" },
    });
    const result = {
        message: setupStore.publishCompletion(child.id, child.runId, "parent-result-test"),
    };

    await assert.rejects(runtime.readMail(result.message.id));
    await new Promise((resolve) => setTimeout(resolve, 300));
    await runtime.readMail(result.message.id);

    assert.deepEqual(order, ["finalize", "notify"]);
    assert.equal(setupStore.getMessage(result.message.id).state, "acked");
    assert.equal(setupStore.getAgent(child.id).status, "completed");
    await runtime.stop();
    setupStore.close();
});

test("completion accepts the configured result budget rather than the smaller metadata budget", async () => {
    const { runtime, context, setupStore, child, parent } = fixture();
    try {
        await runtime.start(context);
        runtime.onAgentStart();
        assert.throws(
            () =>
                runtime.declareCompletion(
                    { status: "succeeded", summary: "invalid", details: { count: Number.NaN } },
                    "invalid",
                ),
            /unsupported JSON/,
        );
        const details = { report: "x".repeat(100000) };
        runtime.declareCompletion(
            { status: "succeeded", summary: "large structured result", details },
            "large-result",
        );
        await runtime.onAgentSettled(context);
        const result = setupStore.listMessages({ recipientAgentId: parent.id }).items[0]!;
        assert.deepEqual(JSON.parse(result.content).details, details);
        assert.equal(setupStore.getCompletion(child.id)?.state, "emitted");
    } finally {
        await runtime.stop();
        setupStore.close();
    }
});

test("a new reasoning turn invalidates a pre-correction declaration and accepts a revised result", async () => {
    const { runtime, context, setupStore, child } = fixture();
    try {
        await runtime.start(context);
        runtime.onAgentStart();
        runtime.declareCompletion(
            { status: "succeeded", summary: "before correction" },
            "old-declaration",
        );
        runtime.onAgentStart();
        assert.equal(setupStore.getCompletion(child.id)?.state, "invalidated");
        runtime.declareCompletion(
            { status: "succeeded", summary: "after correction" },
            "new-declaration",
        );
        await runtime.onAgentSettled(context);
        assert.equal(setupStore.getCompletion(child.id)?.state, "emitted");
    } finally {
        await runtime.stop();
        setupStore.close();
    }
});

test("distinct completion invocation tokens permit a later resumed assignment", async () => {
    const { runtime, context, setupStore, child } = fixture();
    await runtime.start(context);
    runtime.onAgentStart();
    runtime.declareCompletion({ status: "succeeded", summary: "first" }, "tool-call-a");
    runtime.onAgentEnd(assistantEvent("aborted"));
    await runtime.onAgentSettled(context);

    runtime.onAgentStart();
    runtime.declareCompletion({ status: "succeeded", summary: "second" }, "tool-call-b");
    runtime.onAgentEnd(assistantEvent("stop"));
    await runtime.onAgentSettled(context);

    assert.equal(current(setupStore, child).status, "completed");
    await runtime.stop();
    setupStore.close();
});

test("replacement execution invalidates an unpublished draft and requires a new declaration", async () => {
    const { runtime, context, setupStore, child, parent, filename, directory, pi } = fixture();
    await runtime.start(context);
    runtime.onAgentStart();
    runtime.declareCompletion({ status: "succeeded", summary: "durable" }, "crash-token");
    await runtime.stop();

    const restarted = new PiHerdrRuntime(pi, {
        extensionPath: join(directory, "extension.ts"),
        environment: {
            PI_HERDR_AGENT_ID: child.id,
            PI_HERDR_PARENT_ID: parent.id,
            PI_HERDR_DB: filename,
            PI_HERDR_COMPLETION_POLL_MS: "60000",
        },
    });
    await restarted.start(context);
    assert.equal(setupStore.getCompletion(child.id)?.state, "invalidated");
    restarted.onAgentEnd(assistantEvent("stop"));
    await restarted.onAgentSettled(context);
    assert.equal(setupStore.listMessages({ recipientAgentId: parent.id }).items.length, 0);
    restarted.onAgentStart();
    restarted.declareCompletion({ status: "succeeded", summary: "revalidated" }, "new-epoch-token");
    await restarted.onAgentSettled(context);

    const results = setupStore.listMessages({ recipientAgentId: parent.id }).items;
    assert.equal(results.filter((message) => message.kind === "result").length, 1);
    assert.equal(setupStore.getCompletion(child.id)?.state, "emitted");
    await restarted.stop();
    setupStore.close();
});

test("rejects successful completion while required inbox mail is unresolved", async () => {
    const { runtime, context, setupStore, child, parent } = fixture();
    await runtime.start(context);
    const required = setupStore.enqueueMessage({
        senderAgentId: parent.id,
        recipientAgentId: child.id,
        kind: "request",
        content: "must answer",
    }).message;

    assert.throws(
        () => runtime.declareCompletion({ status: "succeeded", summary: "ignored" }, "blocked"),
        (error: unknown) => {
            assert.match((error as Error).message, new RegExp(required.id, "u"));
            return true;
        },
    );
    assert.equal(
        runtime.declareCompletion(
            { status: "failed", summary: "blocked by unresolved required mail" },
            "failure-report",
        ).status,
        "failed",
    );
    await runtime.stop();
    setupStore.close();
});

test("ordinary peer mail uses follow-up delivery semantics", async () => {
    const { runtime, context, setupStore, child, parent, sent } = fixture();
    const queued = setupStore.enqueueMessage({
        senderAgentId: parent.id,
        recipientAgentId: child.id,
        kind: "message",
        content: "informational",
    });
    await runtime.start(context);
    await runtime.readMail(queued.message.id);

    assert.deepEqual(sent[0]?.options, { triggerTurn: true, deliverAs: "followUp" });
    await runtime.stop();
    setupStore.close();
});

test("child discovery and direct peer mail expose a stable interaction path", async () => {
    const { runtime, context, setupStore, parent } = fixture();
    const peer = setupStore.registerAgent({
        alias: "durable_store",
        role: "storage",
        parentAgentId: parent.id,
    });
    const startingPeer = setupStore.transitionAgent({
        agentId: peer.id,
        status: "starting",
        patch: {},
        expectedRevision: peer.revision,
    });
    await runtime.start(context);

    const directory = runtime.listPeers();
    assert.ok(directory.items.some((agent) => agent.id === startingPeer.id));
    const interaction = runtime.sendMail({
        recipient: startingPeer.id,
        content: "coordinate transaction boundary",
    });
    assert.equal(interaction.recipient.path, "/root/durable_store");
    assert.equal(interaction.recipient.deliveryContract, "live_mailbox");
    assert.equal(setupStore.getMessage(interaction.message.id).recipientAgentId, startingPeer.id);
    await runtime.stop();
    setupStore.close();
});

test("tools support discover, direct request, read, reply, ack and sender receipt using model-visible content", async () => {
    const base = fixture();
    let peer = base.setupStore.registerAgent({
        alias: "workflow_engine",
        role: "scheduler",
        parentAgentId: base.parent.id,
    });
    peer = base.setupStore.transitionAgent({
        agentId: peer.id,
        status: "starting",
        patch: {},
        expectedRevision: peer.revision,
    });
    const peerRuntime = new PiHerdrRuntime(
        {
            setSessionName: () => undefined,
            sendMessage: () => undefined,
        } as unknown as ExtensionAPI,
        {
            extensionPath: join(base.directory, "extension.ts"),
            environment: {
                PI_HERDR_AGENT_ID: peer.id,
                PI_HERDR_RUN_ID: peer.runId,
                PI_HERDR_PARENT_ID: base.parent.id,
                PI_HERDR_DB: base.filename,
                PI_HERDR_COMPLETION_POLL_MS: "60000",
            },
        },
    );
    type Tool = {
        name: string;
        execute: (id: string, params: unknown) => Promise<{ content: Array<{ text: string }> }>;
    };
    const invoker = (runtime: PiHerdrRuntime) => {
        const definitions = new Map<string, Tool>();
        registerPiHerdrTools(
            {
                registerTool: (tool: Tool) => definitions.set(tool.name, tool),
            } as unknown as ExtensionAPI,
            runtime,
            true,
        );
        return async (name: string, params: unknown): Promise<Record<string, unknown>> => {
            const result = await definitions.get(name)!.execute(`call-${name}`, params);
            // Intentionally never inspect details: Pi only shows content to the model.
            return JSON.parse(result.content[0]!.text.split("\n")[1]!) as Record<string, unknown>;
        };
    };
    try {
        await base.runtime.start(base.context);
        await peerRuntime.start(base.context);
        const caller = invoker(base.runtime),
            receiver = invoker(peerRuntime);
        const directory = await caller("agent_directory", {});
        const discovered = (directory.items as Array<{ id: string; alias: string }>).find(
            (entry) => entry.alias === "workflow_engine",
        )!;
        assert.equal(discovered.id, peer.id);
        const sent = await caller("agent_mail_send", {
            recipient: discovered.id,
            kind: "request",
            content: "Confirm transaction boundary",
            idempotencyKey: "journey-request",
        });
        const requestId = (sent.message as { id: string }).id;
        assert.equal((sent.recipient as { path: string }).path, "/root/workflow_engine");
        assert.ok((await receiver("agent_mail_list", {})).items);
        const read = await receiver("agent_mail_read", { messageId: requestId });
        assert.equal(read.content, "Confirm transaction boundary");
        const reply = await receiver("agent_mail_send", {
            recipient: base.child.id,
            kind: "response",
            content: "Confirmed",
            replyToMessageId: requestId,
        });
        await receiver("agent_mail_ack", { messageId: requestId });
        const replyId = (reply.message as { id: string }).id;
        const response = await caller("agent_mail_read", { messageId: replyId });
        assert.equal(response.content, "Confirmed");
        assert.equal(response.threadId, read.threadId);
        await caller("agent_mail_ack", { messageId: replyId });
        const receipt = await caller("agent_mail_sent", {});
        assert.equal(
            (receipt.items as Array<{ id: string; state: string }>).find(
                (item) => item.id === requestId,
            )?.state,
            "acked",
        );
    } finally {
        await peerRuntime.stop();
        await base.runtime.stop();
        base.setupStore.close();
    }
});

test("recovery detects a Pi-persisted injection after failure and does not duplicate it", async () => {
    const base = fixture();
    const failpoints = new DeterministicFailpoints([{ point: "mailbox.injection.after" }]);
    const runtime = new PiHerdrRuntime(base.pi, {
        extensionPath: join(base.directory, "extension.ts"),
        environment: {
            PI_HERDR_AGENT_ID: base.child.id,
            PI_HERDR_PARENT_ID: base.parent.id,
            PI_HERDR_DB: base.filename,
            PI_HERDR_COMPLETION_POLL_MS: "60000",
        },
        failpoint: failpoints.hit,
    });
    const queued = base.setupStore.enqueueMessage({
        senderAgentId: base.parent.id,
        recipientAgentId: base.child.id,
        kind: "message",
        content: "inject exactly once",
    });
    await runtime.start(base.context);
    await assert.rejects(runtime.readMail(queued.message.id));
    await new Promise((resolve) => setTimeout(resolve, 300));
    await runtime.readMail(queued.message.id);

    assert.equal(base.sent.length, 1);
    assert.equal(base.setupStore.getMessage(queued.message.id).state, "read");
    await runtime.stop();
    base.setupStore.close();
});
