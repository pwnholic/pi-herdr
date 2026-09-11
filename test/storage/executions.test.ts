import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SqliteControlPlaneStore } from "../../src/storage/index.ts";

function fixture() {
    const directory = mkdtempSync(join(tmpdir(), "pi-herdr-executions-"));
    const filename = join(directory, "control.sqlite");
    let now = 1_000;
    const stores: SqliteControlPlaneStore[] = [];
    const open = (failpoint?: (point: string) => void) => {
        const store = SqliteControlPlaneStore.open({
            filename,
            clock: { now: () => now },
            ...(failpoint ? { failpoint } : {}),
        });
        stores.push(store);
        return store;
    };
    const admin = open();
    const parent = admin.registerAgent({ alias: "parent", role: "coordinator" });
    let child = admin.registerAgent({
        alias: "child",
        role: "worker",
        parentAgentId: parent.id,
        sessionId: "session-a",
    });
    for (const status of ["starting", "running"] as const) {
        child = admin.transitionAgent({
            agentId: child.id,
            status,
            patch: {},
            expectedRevision: child.revision,
        });
    }
    const input = { agentId: child.id, runId: child.runId, sessionId: "session-a", leaseMs: 100 };
    return {
        admin,
        child,
        parent,
        open,
        input,
        advance: (ms: number) => {
            now += ms;
        },
        close: () => {
            for (const store of stores) store.close();
            rmSync(directory, { recursive: true, force: true });
        },
    };
}

test("durable Pi handoff fences read, ack and completion until context observation", () => {
    const f = fixture();
    try {
        const worker = f.open();
        worker.acquireExecution({ ...f.input, owner: "runtime" });
        const mail = f.admin.enqueueMessage({
            senderAgentId: f.parent.id,
            recipientAgentId: f.child.id,
            kind: "message",
            content: "context evidence",
        }).message;
        const [claimed] = worker.claimMessages({
            recipientAgentId: f.child.id,
            owner: "pump",
            leaseMs: 50,
            limit: 1,
        });
        assert.ok(claimed);
        worker.declareCompletion({
            agentId: f.child.id,
            invocationToken: "draft",
            payload: { status: "succeeded", summary: "old" },
        });
        assert.throws(() => worker.beginPiHandoff(mail.id, "someone-else"), /ownership/);
        const handoff = worker.beginPiHandoff(mail.id, "pump");
        assert.equal(f.admin.getCompletion(f.child.id)?.state, "invalidated");
        assert.equal(worker.beginPiHandoff(mail.id, "pump").created, false);
        const mutation = {
            messageId: mail.id,
            recipientAgentId: f.child.id,
            owner: "pump",
            expectedRevision: claimed.revision,
        };
        assert.throws(() => worker.markMessageRead(mutation), /not been observed/);
        assert.throws(() => worker.acknowledgeMessage(mutation), /not been observed/);
        assert.throws(
            () =>
                worker.declareCompletion({
                    agentId: f.child.id,
                    invocationToken: "new",
                    payload: {},
                }),
            /awaits context/,
        );
        assert.throws(
            () => worker.publishCompletion(f.child.id, f.child.runId, "draft"),
            /awaits context/,
        );
        assert.equal(worker.observePiHandoff(mail.id, "forged"), false);
        assert.equal(worker.observePiHandoff(mail.id, handoff.token), true);
        assert.equal(worker.observePiHandoff(mail.id, handoff.token), false);
        const read = worker.markMessageRead(mutation);
        assert.equal(
            worker.acknowledgeMessage({ ...mutation, expectedRevision: read.revision }).state,
            "acked",
        );
        worker.declareCompletion({
            agentId: f.child.id,
            invocationToken: "new",
            payload: { status: "succeeded", summary: "context seen" },
        });
        assert.equal(worker.publishCompletion(f.child.id, f.child.runId, "new").kind, "result");
    } finally {
        f.close();
    }
});

test("replacement epoch rejects old handoff tokens and expired mailbox ownership", () => {
    const f = fixture();
    try {
        const a = f.open(),
            b = f.open();
        a.acquireExecution({ ...f.input, owner: "a" });
        const mail = f.admin.enqueueMessage({
            senderAgentId: f.parent.id,
            recipientAgentId: f.child.id,
            kind: "message",
            content: "restart",
        }).message;
        a.claimMessages({ recipientAgentId: f.child.id, owner: "pump-a", leaseMs: 50, limit: 1 });
        const old = a.beginPiHandoff(mail.id, "pump-a");
        f.advance(50);
        assert.throws(() => a.observePiHandoff(mail.id, old.token), /ownership/);
        f.advance(50);
        b.acquireExecution({ ...f.input, owner: "b" });
        b.claimMessages({ recipientAgentId: f.child.id, owner: "pump-b", leaseMs: 50, limit: 1 });
        assert.throws(
            () =>
                b.declareCompletion({
                    agentId: f.child.id,
                    invocationToken: "premature-restart",
                    payload: {},
                }),
            /awaits context/,
        );
        const replacement = b.beginPiHandoff(mail.id, "pump-b");
        assert.notEqual(replacement.token, old.token);
        assert.equal(replacement.epoch, 2);
        assert.equal(b.observePiHandoff(mail.id, old.token), false);
        assert.throws(() => a.observePiHandoff(mail.id, old.token), /execution/);
        assert.equal(b.observePiHandoff(mail.id, replacement.token), true);
    } finally {
        f.close();
    }
});

test("a Pi session cannot bootstrap two root identities and bypass execution exclusivity", () => {
    const f = fixture();
    try {
        f.admin.registerAgent({ alias: "first", role: "coordinator", sessionId: "root-session" });
        assert.throws(() =>
            f.admin.registerAgent({
                alias: "second",
                role: "coordinator",
                sessionId: "root-session",
            }),
        );
        assert.equal(
            f.admin.listAgents().items.filter((agent) => agent.sessionId === "root-session").length,
            1,
        );
    } finally {
        f.close();
    }
});

test("one live execution owner; expiry increments epoch and fences every stale mailbox mutation", () => {
    const f = fixture();
    try {
        const a = f.open(),
            b = f.open();
        const first = a.acquireExecution({ ...f.input, owner: "a" });
        assert.equal(first.epoch, 1);
        assert.throws(() => b.acquireExecution({ ...f.input, owner: "b" }), /execution/);
        assert.throws(() => b.acquireExecution({ ...f.input, owner: "a" }), /execution/);
        const mail = f.admin.enqueueMessage({
            senderAgentId: f.parent.id,
            recipientAgentId: f.child.id,
            kind: "message",
            content: "input",
        }).message;
        const [claimed] = a.claimMessages({
            recipientAgentId: f.child.id,
            owner: "mailbox-a",
            leaseMs: 10_000,
            limit: 1,
        });
        assert.ok(claimed);
        const read = a.markMessageRead({
            messageId: mail.id,
            recipientAgentId: f.child.id,
            owner: "mailbox-a",
            expectedRevision: claimed.revision,
        });
        a.declareCompletion({
            agentId: f.child.id,
            runId: f.child.runId,
            invocationToken: "old",
            payload: { status: "succeeded", summary: "old" },
        });
        f.advance(100);
        assert.throws(() => a.renewExecution(100), /execution/);
        const second = b.acquireExecution({ ...f.input, owner: "b" });
        assert.equal(second.epoch, 2);
        assert.equal(f.admin.getCompletion(f.child.id)?.state, "invalidated");
        const mutation = {
            messageId: mail.id,
            recipientAgentId: f.child.id,
            owner: "mailbox-a",
            expectedRevision: read.revision,
        };
        const writes = [
            () =>
                a.enqueueMessage({
                    senderAgentId: f.child.id,
                    recipientAgentId: f.parent.id,
                    kind: "message",
                    content: "stale",
                }),
            () =>
                a.claimMessages({
                    recipientAgentId: f.child.id,
                    owner: "mailbox-a",
                    leaseMs: 100,
                    limit: 1,
                }),
            () => a.markMessageRead(mutation),
            () => a.acknowledgeMessage(mutation),
            () => a.renewMessageLease({ ...mutation, leaseMs: 100 }),
            () => a.retryMessage({ ...mutation, availableAt: 2000 }),
            () =>
                a.deadLetterMessage({
                    messageId: mail.id,
                    reason: "stale",
                    expectedRevision: read.revision,
                }),
            () => a.runMailboxMaintenance(),
            () => a.getMessage(mail.id), // get performs maintenance
            () => a.listMessages({ recipientAgentId: f.child.id }),
            () => a.publishCompletion(f.child.id, f.child.runId, "old"),
            () => a.invalidateCompletion(f.child.id, "old"),
            () =>
                a.declareCompletion({ agentId: f.child.id, invocationToken: "late", payload: {} }),
            () =>
                a.patchAgent({
                    agentId: f.child.id,
                    patch: { metadata: { stale: true } },
                    expectedRevision: f.admin.getAgent(f.child.id).revision,
                }),
            () =>
                a.recordEvent({
                    rootAgentId: f.parent.id,
                    entityId: f.child.id,
                    type: "stale",
                    data: {},
                }),
        ];
        for (const write of writes) assert.throws(write, /execution/);
        assert.equal(a.releaseExecution(), false);
        b.assertExecution();
        assert.equal(f.admin.getMessage(mail.id).revision, read.revision);
        assert.equal(f.admin.listMessages({ recipientAgentId: f.parent.id }).items.length, 0);
        b.declareCompletion({
            agentId: f.child.id,
            runId: f.child.runId,
            invocationToken: "new",
            payload: { status: "succeeded", summary: "new" },
        });
        const result = b.publishCompletion(f.child.id, f.child.runId, "new");
        assert.equal(b.publishCompletion(f.child.id, f.child.runId, "new").id, result.id);
    } finally {
        f.close();
    }
});

test("release permits immediate restart without resetting epoch or unbinding the old connection", () => {
    const f = fixture();
    try {
        const a = f.open();
        a.acquireExecution({ ...f.input, owner: "a" });
        f.advance(50);
        assert.equal(a.renewExecution(200).expiresAt, 1250);
        assert.equal(a.releaseExecution(), true);
        assert.equal(a.releaseExecution(), false);
        assert.throws(() => a.runMailboxMaintenance(), /execution/);
        assert.throws(() => a.acquireExecution({ ...f.input, owner: "a" }), /already bound/);
        const b = f.open();
        assert.equal(b.acquireExecution({ ...f.input, owner: "a" }).epoch, 2);
        assert.equal(a.releaseExecution(), false); // same owner string is not enough
        b.assertExecution();
    } finally {
        f.close();
    }
});

test("takeover preserves an already emitted completion and its idempotent result", () => {
    const f = fixture();
    try {
        const a = f.open();
        a.acquireExecution({ ...f.input, owner: "a" });
        a.declareCompletion({
            agentId: f.child.id,
            invocationToken: "done",
            payload: { status: "succeeded", summary: "done" },
        });
        const result = a.publishCompletion(f.child.id, f.child.runId, "done");
        f.advance(100);
        const b = f.open();
        b.acquireExecution({ ...f.input, owner: "b" });
        assert.equal(f.admin.getCompletion(f.child.id)?.state, "emitted");
        assert.equal(b.publishCompletion(f.child.id, f.child.runId, "done").id, result.id);
        assert.throws(() => a.publishCompletion(f.child.id, f.child.runId, "done"), /execution/);
    } finally {
        f.close();
    }
});

test("expiry during a write rolls back the mutation instead of committing after lease loss", () => {
    const f = fixture();
    try {
        const a = f.open((point) => {
            if (point === "mailbox.enqueue.before_insert") f.advance(100);
        });
        a.acquireExecution({ ...f.input, owner: "a" });
        assert.throws(
            () =>
                a.enqueueMessage({
                    senderAgentId: f.child.id,
                    recipientAgentId: f.parent.id,
                    kind: "message",
                    content: "must roll back",
                }),
            /execution/,
        );
        assert.equal(f.admin.listMessages({ recipientAgentId: f.parent.id }).items.length, 0);
    } finally {
        f.close();
    }
});

test("failed acquisition rolls back epoch and draft invalidation and can be retried", () => {
    const f = fixture();
    try {
        let fail = true;
        const a = f.open((point) => {
            if (fail && point === "execution.acquire.before_commit")
                throw new Error("acquire crash");
        });
        f.admin.declareCompletion({ agentId: f.child.id, invocationToken: "draft", payload: {} });
        assert.throws(() => a.acquireExecution({ ...f.input, owner: "a" }), /acquire crash/);
        assert.equal(a.execution, undefined);
        assert.equal(f.admin.getCompletion(f.child.id)?.state, "declared");
        fail = false;
        assert.equal(a.acquireExecution({ ...f.input, owner: "a" }).epoch, 1);
    } finally {
        f.close();
    }
});

test("run and session identity are validated by storage, not only by runtime", () => {
    const f = fixture();
    try {
        const a = f.open();
        assert.throws(
            () => a.acquireExecution({ ...f.input, sessionId: "wrong", owner: "a" }),
            /session/,
        );
        assert.throws(
            () => a.acquireExecution({ ...f.input, runId: "wrong", owner: "a" }),
            /assignment/,
        );
        a.acquireExecution({ ...f.input, owner: "a" });
        const agent = f.admin.getAgent(f.child.id);
        f.admin.patchAgent({
            agentId: agent.id,
            expectedRevision: agent.revision,
            patch: { sessionId: "replacement" },
        });
        assert.throws(() => a.renewExecution(100), /session/);
        assert.throws(() => a.publishCompletion(f.child.id, f.child.runId, "old"), /session/);
        const b = f.open();
        assert.equal(
            b.acquireExecution({ ...f.input, sessionId: "replacement", owner: "b" }).epoch,
            2,
        );
    } finally {
        f.close();
    }
});
