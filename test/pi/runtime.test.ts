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
    const names: string[] = [];
    const pi = {
        setSessionName: (name: string) => names.push(name),
        getSessionName: () => undefined,
        sendMessage: (message: unknown, options: unknown) => sent.push({ message, options }),
    } as unknown as ExtensionAPI;
    const context = {
        cwd: directory,
        sessionManager: {
            getSessionDir: () => directory,
            getSessionId: () => "44444444-4444-4444-8444-444444444444",
            getSessionFile: () => join(directory, "session.jsonl"),
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
    return { directory, filename, setupStore, parent, child, pi, context, runtime, sent, names };
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
    assert.ok(!names.includes("agent_spawn"));
    assert.ok(!names.includes("workflow_start"));
    assert.equal(definitions.length, names.length);
});

test("agent_complete binds idempotency to its tool call and terminates the batch", async () => {
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
    const pi = {
        getSessionName: () => "Coordinator",
        setSessionName: () => undefined,
        sendMessage: () => order.push("notify"),
    } as unknown as ExtensionAPI;
    const context = {
        cwd: directory,
        sessionManager: {
            getSessionDir: () => directory,
            getSessionId: () => "55555555-5555-4555-8555-555555555555",
            getSessionFile: () => join(directory, "parent.jsonl"),
        },
    } as unknown as ExtensionContext;
    const runtime = new PiHerdrRuntime(pi, {
        extensionPath: join(directory, "extension.ts"),
        environment: {
            PI_HERDR_DB: filename,
            PI_HERDR_COMPLETION_POLL_MS: "60000",
        },
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
    const result = setupStore.enqueueMessage({
        senderAgentId: child.id,
        recipientAgentId: runtime.identity.id,
        kind: "result",
        content: JSON.stringify({ status: "succeeded", summary: "done" }),
        metadata: { action: "completion", agentId: child.id, status: "succeeded" },
    });

    await runtime.readMail(result.message.id);

    assert.deepEqual(order, ["finalize", "notify"]);
    assert.equal(setupStore.getMessage(result.message.id).state, "acked");
    assert.equal(setupStore.getAgent(child.id).status, "completed");
    await runtime.stop();
    setupStore.close();
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
