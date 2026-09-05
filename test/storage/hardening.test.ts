import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentStatus } from "../../src/domain/agent.ts";
import type { AgentId } from "../../src/domain/ids.ts";
import { MailboxPump } from "../../src/pi/mailbox-pump.ts";
import { SqliteControlPlaneStore } from "../../src/storage/index.ts";

test("pump lane rotation serves ordinary mail even while controls remain queued", async () => {
    const store = SqliteControlPlaneStore.open({ filename: ":memory:" });
    try {
        const { parent, child } = pair(store);
        for (let i = 0; i < 5; i++)
            store.enqueueMessage({
                senderAgentId: parent.id,
                recipientAgentId: child.id,
                kind: "control",
                content: `control-${i}`,
            });
        const ordinary = store.enqueueMessage({
            senderAgentId: parent.id,
            recipientAgentId: child.id,
            kind: "message",
            content: "ordinary",
        }).message;
        const delivered: string[] = [];
        const pump = new MailboxPump({
            store,
            recipientAgentId: child.id,
            recipientRunId: child.runId,
            leaseMs: 60000,
            pollMs: 60000,
            batchSize: 1,
            dispatch: async (message) => {
                delivered.push(message.id);
                return "ack";
            },
        });
        await pump.pollNow();
        await pump.pollNow();
        await pump.pollNow();
        assert.equal(delivered[2], ordinary.id);
        assert.ok(
            store.listMessages({ recipientAgentId: child.id, states: ["queued"] }).items.length > 0,
        );
    } finally {
        store.close();
    }
});

function transition(store: SqliteControlPlaneStore, id: AgentId, status: AgentStatus) {
    return store.transitionAgent({
        agentId: id,
        status,
        patch: {},
        expectedRevision: store.getAgent(id).revision,
    });
}

function pair(store: SqliteControlPlaneStore) {
    const parent = store.registerAgent({ alias: "parent", role: "coordinator" });
    const child = store.registerAgent({ alias: "child", role: "worker", parentAgentId: parent.id });
    transition(store, child.id, "starting");
    transition(store, child.id, "running");
    return { parent, child };
}

test("ordinary unacked mail cannot block a correction; ordering stays strict within each lane", () => {
    const store = SqliteControlPlaneStore.open({ filename: ":memory:" });
    try {
        const { parent, child } = pair(store);
        const ordinary = store.enqueueMessage({
            senderAgentId: parent.id,
            recipientAgentId: child.id,
            kind: "message",
            content: "information",
        }).message;
        const [claimed] = store.claimMessages({
            recipientAgentId: child.id,
            owner: "consumer",
            leaseMs: 60000,
        });
        assert.equal(claimed?.id, ordinary.id);
        store.markMessageRead({
            messageId: claimed!.id,
            recipientAgentId: child.id,
            owner: "consumer",
            expectedRevision: claimed!.revision,
        });
        const control = store.enqueueMessage({
            senderAgentId: parent.id,
            recipientAgentId: child.id,
            kind: "control",
            content: "correct course",
        }).message;
        store.enqueueMessage({
            senderAgentId: parent.id,
            recipientAgentId: child.id,
            kind: "control",
            content: "second correction",
        });
        store.enqueueMessage({
            senderAgentId: parent.id,
            recipientAgentId: child.id,
            kind: "message",
            content: "second information",
        });
        const result = store.claimMessages({
            recipientAgentId: child.id,
            owner: "consumer-2",
            leaseMs: 60000,
        });
        assert.deepEqual(
            result.map((message) => message.id),
            [control.id],
        );
        assert.equal(
            store.claimMessages({ recipientAgentId: child.id, owner: "consumer-3", leaseMs: 60000 })
                .length,
            0,
        );
    } finally {
        store.close();
    }
});

test("a completion bypasses an ordinary unacked message in the parent's mailbox", () => {
    const store = SqliteControlPlaneStore.open({ filename: ":memory:" });
    try {
        const { parent, child } = pair(store);
        store.enqueueMessage({
            senderAgentId: child.id,
            recipientAgentId: parent.id,
            kind: "message",
            content: "progress",
        });
        const [ordinary] = store.claimMessages({
            recipientAgentId: parent.id,
            owner: "parent",
            leaseMs: 60000,
        });
        store.markMessageRead({
            messageId: ordinary!.id,
            recipientAgentId: parent.id,
            owner: "parent",
            expectedRevision: ordinary!.revision,
        });
        store.declareCompletion({
            agentId: child.id,
            invocationToken: "complete",
            payload: { status: "succeeded", summary: "done" },
        });
        const result = store.publishCompletion(child.id, child.runId, "complete");
        assert.equal(
            store.claimMessages({ recipientAgentId: parent.id, owner: "parent", leaseMs: 60000 })[0]
                ?.id,
            result.id,
        );
    } finally {
        store.close();
    }
});

for (const point of ["completion.publish.after_enqueue", "completion.publish.before_commit"]) {
    test(`completion publication rolls back and recovers after ${point}`, () => {
        const directory = mkdtempSync(join(tmpdir(), "pi-herdr-publish-"));
        let store: SqliteControlPlaneStore | undefined;
        try {
            const filename = join(directory, "control.sqlite");
            store = SqliteControlPlaneStore.open({
                filename,
                failpoint: (name) => {
                    if (name === point) throw new Error(point);
                },
            });
            const { parent, child } = pair(store);
            const payload = {
                status: "succeeded",
                summary: "frozen",
                details: { files: ["result.ts"] },
            };
            store.declareCompletion({ agentId: child.id, invocationToken: "tool-call", payload });
            assert.throws(
                () => store!.publishCompletion(child.id, child.runId, "tool-call"),
                new RegExp(point),
            );
            assert.equal(store.getCompletion(child.id)?.state, "declared");
            assert.equal(store.listMessages({ recipientAgentId: parent.id }).items.length, 0);
            assert.equal(store.getAgent(child.id).status, "running");
            assert.equal(
                store
                    .listEvents({ rootAgentId: parent.id })
                    .items.some((event) => event.type === "mail.queued"),
                false,
            );
            store.close();
            store = SqliteControlPlaneStore.open({ filename });
            const published = store.publishCompletion(child.id, child.runId, "tool-call");
            assert.deepEqual(JSON.parse(published.content), payload);
            assert.equal(
                store.publishCompletion(child.id, child.runId, "tool-call").id,
                published.id,
            );
            assert.equal(store.getAgent(child.id).status, "completed");
            assert.equal(store.listMessages({ recipientAgentId: parent.id }).items.length, 1);
        } finally {
            store?.close();
            rmSync(directory, { recursive: true, force: true });
        }
    });
}

test("late required mail prevents publication even after a successful declaration", () => {
    const store = SqliteControlPlaneStore.open({ filename: ":memory:" });
    try {
        const { parent, child } = pair(store);
        store.declareCompletion({
            agentId: child.id,
            invocationToken: "complete",
            payload: { status: "succeeded", summary: "done" },
        });
        store.enqueueMessage({
            senderAgentId: parent.id,
            recipientAgentId: child.id,
            kind: "control",
            content: "wait, fix this",
        });
        assert.throws(
            () => store.publishCompletion(child.id, child.runId, "complete"),
            /unresolved required/,
        );
        assert.equal(store.getCompletion(child.id)?.state, "declared");
        assert.equal(store.getAgent(child.id).status, "running");
    } finally {
        store.close();
    }
});

test("restart keeps the run but a new assignment fences old sends, replies, leases, and completion", () => {
    const store = SqliteControlPlaneStore.open({ filename: ":memory:" });
    try {
        const { parent, child } = pair(store);
        transition(store, child.id, "stopping");
        transition(store, child.id, "stopped");
        assert.equal(transition(store, child.id, "starting").runId, child.runId);
        transition(store, child.id, "running");
        const old = store.enqueueMessage({
            senderAgentId: parent.id,
            recipientAgentId: child.id,
            kind: "request",
            content: "old work",
        }).message;
        const [claimed] = store.claimMessages({
            recipientAgentId: child.id,
            recipientRunId: child.runId,
            owner: "old-process",
            leaseMs: 60000,
        });
        transition(store, child.id, "failed");
        const next = transition(store, child.id, "starting");
        assert.notEqual(next.runId, child.runId);
        assert.throws(
            () =>
                store.markMessageRead({
                    messageId: old.id,
                    recipientAgentId: child.id,
                    owner: "old-process",
                    expectedRevision: claimed!.revision,
                }),
            /superseded/,
        );
        assert.throws(
            () =>
                store.claimMessages({
                    recipientAgentId: child.id,
                    recipientRunId: child.runId,
                    owner: "old-process",
                    leaseMs: 60000,
                }),
            /superseded/,
        );
        assert.throws(
            () =>
                store.enqueueMessage({
                    senderAgentId: child.id,
                    senderRunId: child.runId,
                    recipientAgentId: parent.id,
                    kind: "message",
                    content: "late",
                }),
            /superseded/,
        );
        assert.throws(
            () =>
                store.enqueueMessage({
                    senderAgentId: child.id,
                    recipientAgentId: parent.id,
                    kind: "response",
                    content: "late reply",
                    replyToMessageId: old.id,
                }),
            /assignment generations/,
        );
        assert.throws(
            () =>
                store.declareCompletion({
                    agentId: child.id,
                    runId: child.runId,
                    invocationToken: "late",
                    payload: { status: "succeeded", summary: "late" },
                }),
            /superseded/,
        );
        store.runMailboxMaintenance();
        const dead = store.getMessage(old.id);
        assert.equal(dead.deadLetterReason, "superseded_assignment");
        assert.throws(
            () =>
                store.requeueDeadLetterMessage({
                    messageId: old.id,
                    senderAgentId: parent.id,
                    expectedRevision: dead.revision,
                }),
            /superseded/,
        );
    } finally {
        store.close();
    }
});

test("events have stable scoped pagination, roll back with their mutation, and health reports the schema", () => {
    const store = SqliteControlPlaneStore.open({ filename: ":memory:" });
    try {
        const { parent, child } = pair(store);
        const other = store.registerAgent({ alias: "other-root", role: "coordinator" });
        const first = store.listEvents({ rootAgentId: parent.id, limit: 1 });
        const rest = store.listEvents({ rootAgentId: parent.id, after: first.nextAfter });
        assert.equal(first.hasMore, true);
        assert.ok(
            rest.items.every(
                (event) => event.sequence > first.nextAfter && event.entityId !== other.id,
            ),
        );
        assert.ok(
            rest.items.some(
                (event) => event.entityId === child.id && event.type === "agent.changed",
            ),
        );
        const health = store.databaseHealth();
        assert.equal(health.quickCheck, "ok");
        assert.equal(health.foreignKeys, true);
        assert.equal(health.schema.length, 1);
    } finally {
        store.close();
    }
});
