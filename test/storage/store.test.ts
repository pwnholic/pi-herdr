import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import Database from "better-sqlite3";
import type { AgentId, ThreadId, WorkflowId } from "../../src/domain/ids.ts";
import { DeterministicFailpoints } from "../../src/faults.ts";
import { type Clock, SqliteControlPlaneStore } from "../../src/storage/index.ts";

class TestClock implements Clock {
    value: number;

    constructor(value = 1_800_000_000_000) {
        this.value = value;
    }

    now(): number {
        return this.value;
    }

    advance(milliseconds: number): void {
        this.value += milliseconds;
    }
}

const directories: string[] = [];

after(() => {
    for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

function fixture(clock = new TestClock()): {
    readonly filename: string;
    readonly clock: TestClock;
    readonly store: SqliteControlPlaneStore;
} {
    const directory = mkdtempSync(join(tmpdir(), "pi-herdr-store-"));
    directories.push(directory);
    const filename = join(directory, "control-plane.sqlite");
    return { filename, clock, store: SqliteControlPlaneStore.open({ filename, clock }) };
}

function expectCode(expectedCode: string): (error: unknown) => boolean {
    return (error) => {
        assert.equal((error as { code?: unknown }).code, expectedCode);
        return true;
    };
}

function registerPair(store: SqliteControlPlaneStore): {
    readonly sender: AgentId;
    readonly recipient: AgentId;
} {
    const sender = store.registerAgent({ alias: "parent", role: "orchestrator" }).id;
    const recipient = store.registerAgent({
        alias: "worker",
        role: "worker",
        parentAgentId: sender,
    }).id;
    return { sender, recipient };
}

describe("durable agent registry", () => {
    test("rejects the superseded schema instead of silently running mixed architecture", () => {
        const directory = mkdtempSync(join(tmpdir(), "pi-herdr-old-schema-"));
        directories.push(directory);
        const filename = join(directory, "control.sqlite");
        const legacy = new Database(filename);
        legacy.exec(`
            CREATE TABLE schema_migrations (
              version INTEGER PRIMARY KEY,
              name TEXT NOT NULL UNIQUE,
              applied_at INTEGER NOT NULL
            ) STRICT;
            INSERT INTO schema_migrations VALUES (1, 'pi-herdr-control-plane-v1', 1);
        `);
        legacy.close();
        for (const baseline of [
            "pi-herdr-control-plane-v1",
            "pi-herdr-control-plane-v1-runs",
            "pi-herdr-control-plane-v1-executions",
        ]) {
            const history = new Database(filename);
            history
                .prepare("UPDATE schema_migrations SET name = ? WHERE version = 1")
                .run(baseline);
            history.close();
            assert.throws(
                () => SqliteControlPlaneStore.open({ filename }),
                expectCode("MIGRATION_FAILED"),
            );
        }
    });

    test("persists identity and mutable recovery fields across reopen", () => {
        const { filename, clock, store } = fixture();
        const registered = store.registerAgent({
            alias: "worker_one",
            displayName: "Worker One",
            role: "worker",
            sessionFile: "/tmp/session.jsonl",
            workspaceId: "workspace-1",
            tabId: "tab-1",
            paneId: "pane-1",
            metadata: { model: "provider/model" },
        });
        const renamed = store.renameAgent({
            agentId: registered.id,
            alias: "reviewer",
            displayName: "Security Reviewer",
            expectedRevision: registered.revision,
        });
        assert.equal(renamed.id, registered.id);
        assert.equal(renamed.alias, "reviewer");
        store.close();

        const reopened = SqliteControlPlaneStore.open({ filename, clock });
        const recovered = reopened.getAgent(registered.id);
        assert.equal(recovered.id, registered.id);
        assert.equal(recovered.displayName, "Security Reviewer");
        assert.equal(recovered.sessionFile, "/tmp/session.jsonl");
        assert.deepEqual(recovered.metadata, { model: "provider/model" });
        reopened.close();
    });

    test("enforces aliases, state transitions, optimistic revisions, and lease ownership", () => {
        const { clock, store } = fixture();
        assert.throws(
            () => store.registerAgent({ alias: "UpperCase", role: "worker" }),
            expectCode("VALIDATION_FAILED"),
        );
        const first = store.registerAgent({ alias: "worker_a", role: "worker" });
        const otherRoot = store.registerAgent({ alias: "worker_a", role: "coordinator" });
        assert.notEqual(otherRoot.rootAgentId, first.rootAgentId);
        store.registerAgent({ alias: "nested", role: "worker", parentAgentId: first.id });
        assert.throws(
            () => store.registerAgent({ alias: "nested", role: "worker", parentAgentId: first.id }),
            expectCode("CONFLICT"),
        );
        assert.throws(
            () =>
                store.transitionAgent({
                    agentId: first.id,
                    status: "running",
                    patch: {},
                    expectedRevision: first.revision,
                }),
            expectCode("INVALID_TRANSITION"),
        );

        const starting = store.transitionAgent({
            agentId: first.id,
            status: "starting",
            patch: { sessionId: "session-1" },
            expectedRevision: first.revision,
        });
        assert.throws(
            () =>
                store.patchAgent({
                    agentId: first.id,
                    patch: { paneId: "pane-new" },
                    expectedRevision: first.revision,
                }),
            expectCode("REVISION_CONFLICT"),
        );
        const leased = store.acquireAgentLease({
            agentId: first.id,
            owner: "supervisor-a",
            leaseMs: 100,
        });
        assert.equal(leased.leaseOwner, "supervisor-a");
        assert.throws(
            () =>
                store.acquireAgentLease({ agentId: first.id, owner: "supervisor-b", leaseMs: 100 }),
            expectCode("LEASE_CONFLICT"),
        );
        assert.throws(
            () => store.releaseAgentLease(first.id, "supervisor-b"),
            expectCode("LEASE_CONFLICT"),
        );
        clock.advance(101);
        const takenOver = store.acquireAgentLease({
            agentId: first.id,
            owner: "supervisor-b",
            leaseMs: 100,
        });
        assert.equal(takenOver.leaseOwner, "supervisor-b");
        assert.equal(
            store.transitionAgent({
                agentId: first.id,
                status: "running",
                patch: {},
                expectedRevision: takenOver.revision,
            }).status,
            "running",
        );
        assert.equal(starting.status, "starting");
        store.close();
    });

    test("guards use after close", () => {
        const { store } = fixture();
        const id = store.registerAgent({ alias: "closed_test", role: "worker" }).id;
        store.close();
        assert.throws(() => store.getAgent(id), expectCode("STORAGE_CLOSED"));
    });
});

describe("durable mailbox", () => {
    test("deduplicates identical intent and rejects idempotency-key reuse for different intent", () => {
        const { clock, store } = fixture();
        const { sender, recipient } = registerPair(store);
        const first = store.enqueueMessage({
            senderAgentId: sender,
            recipientAgentId: recipient,
            kind: "request",
            content: "inspect auth",
            idempotencyKey: "request-1",
            ttlMs: 10_000,
        });
        clock.advance(500);
        const duplicate = store.enqueueMessage({
            senderAgentId: sender,
            recipientAgentId: recipient,
            kind: "request",
            content: "inspect auth",
            idempotencyKey: "request-1",
            ttlMs: 10_000,
        });
        assert.equal(duplicate.deduplicated, true);
        assert.equal(duplicate.message.id, first.message.id);
        assert.throws(
            () =>
                store.enqueueMessage({
                    senderAgentId: sender,
                    recipientAgentId: recipient,
                    kind: "request",
                    content: "different work",
                    idempotencyKey: "request-1",
                    ttlMs: 10_000,
                }),
            expectCode("IDEMPOTENCY_CONFLICT"),
        );
        store.close();
    });

    test("uses stable FIFO pagination even when timestamps are equal", () => {
        const { store } = fixture();
        const { sender, recipient } = registerPair(store);
        for (const content of ["first", "second", "third"]) {
            store.enqueueMessage({
                senderAgentId: sender,
                recipientAgentId: recipient,
                kind: "message",
                content,
            });
        }
        const firstPage = store.listMessages({ recipientAgentId: recipient, limit: 2 });
        assert.deepEqual(
            firstPage.items.map((item) => item.content),
            ["first", "second"],
        );
        assert.ok(firstPage.nextCursor);
        const secondPage = store.listMessages({
            recipientAgentId: recipient,
            limit: 2,
            cursor: firstPage.nextCursor,
        });
        assert.deepEqual(
            secondPage.items.map((item) => item.content),
            ["third"],
        );
        assert.equal(secondPage.nextCursor, undefined);
        assert.throws(
            () => store.listMessages({ recipientAgentId: recipient, limit: 101 }),
            expectCode("VALIDATION_FAILED"),
        );
        store.close();
    });

    test("excludes concurrent claims and enforces read/ack revisions and lease ownership", () => {
        const { filename, clock, store } = fixture();
        const { sender, recipient } = registerPair(store);
        store.enqueueMessage({
            senderAgentId: sender,
            recipientAgentId: recipient,
            kind: "message",
            content: "one",
        });
        const other = SqliteControlPlaneStore.open({ filename, clock });
        const claimed = store.claimMessages({
            recipientAgentId: recipient,
            owner: "consumer-a",
            leaseMs: 1_000,
        });
        assert.equal(claimed.length, 1);
        assert.equal(
            other.claimMessages({
                recipientAgentId: recipient,
                owner: "consumer-b",
                leaseMs: 1_000,
            }).length,
            0,
        );
        assert.throws(
            () =>
                other.markMessageRead({
                    messageId: claimed[0]!.id,
                    recipientAgentId: recipient,
                    owner: "consumer-b",
                    expectedRevision: claimed[0]!.revision,
                }),
            expectCode("LEASE_CONFLICT"),
        );
        const read = store.markMessageRead({
            messageId: claimed[0]!.id,
            recipientAgentId: recipient,
            owner: "consumer-a",
            expectedRevision: claimed[0]!.revision,
        });
        clock.advance(900);
        const renewed = store.renewMessageLease({
            messageId: read.id,
            recipientAgentId: recipient,
            owner: "consumer-a",
            expectedRevision: read.revision,
            leaseMs: 1_000,
        });
        assert.equal(renewed.leaseExpiresAt, clock.now() + 1_000);
        clock.advance(200);
        assert.equal(store.runMailboxMaintenance().requeued, 0);
        assert.throws(
            () =>
                store.acknowledgeMessage({
                    messageId: read.id,
                    recipientAgentId: recipient,
                    owner: "consumer-a",
                    expectedRevision: read.revision,
                }),
            expectCode("REVISION_CONFLICT"),
        );
        const acked = store.acknowledgeMessage({
            messageId: renewed.id,
            recipientAgentId: recipient,
            owner: "consumer-a",
            expectedRevision: renewed.revision,
        });
        assert.equal(acked.state, "acked");
        other.close();
        store.close();
    });

    test("expires TTLs and dead-letters exhausted delivery leases", () => {
        const { clock, store } = fixture();
        const { sender, recipient } = registerPair(store);
        const expiring = store.enqueueMessage({
            senderAgentId: sender,
            recipientAgentId: recipient,
            kind: "event",
            content: "short lived",
            expiresAt: clock.now() + 10,
        }).message;
        clock.advance(10);
        const expiration = store.runMailboxMaintenance();
        assert.equal(expiration.expired, 1);
        assert.equal(store.getMessage(expiring.id).deadLetterReason, "expired");

        const retrying = store.enqueueMessage({
            senderAgentId: sender,
            recipientAgentId: recipient,
            kind: "request",
            content: "one attempt",
            maxAttempts: 1,
        }).message;
        const [claimed] = store.claimMessages({
            recipientAgentId: recipient,
            owner: "consumer",
            leaseMs: 10,
        });
        assert.equal(claimed?.id, retrying.id);
        clock.advance(11);
        const exhaustion = store.runMailboxMaintenance();
        assert.equal(exhaustion.attemptsExhausted, 1);
        assert.equal(store.getMessage(retrying.id).deadLetterReason, "delivery_attempts_exhausted");
        store.close();
    });

    test("retries only by the lease owner and supports explicit dead-lettering", () => {
        const { store } = fixture();
        const { sender, recipient } = registerPair(store);
        const message = store.enqueueMessage({
            senderAgentId: sender,
            recipientAgentId: recipient,
            kind: "request",
            content: "retry me",
            maxAttempts: 2,
        }).message;
        const [claimed] = store.claimMessages({
            recipientAgentId: recipient,
            owner: "consumer-a",
            leaseMs: 100,
        });
        assert.equal(claimed?.id, message.id);
        assert.throws(
            () =>
                store.retryMessage({
                    messageId: claimed!.id,
                    recipientAgentId: recipient,
                    owner: "consumer-b",
                    expectedRevision: claimed!.revision,
                }),
            expectCode("LEASE_CONFLICT"),
        );
        const queued = store.retryMessage({
            messageId: claimed!.id,
            recipientAgentId: recipient,
            owner: "consumer-a",
            expectedRevision: claimed!.revision,
        });
        assert.equal(queued.state, "queued");
        const dead = store.deadLetterMessage({
            messageId: queued.id,
            reason: "operator_cancelled",
            expectedRevision: queued.revision,
        });
        assert.equal(dead.state, "dead_letter");
        assert.equal(dead.deadLetterReason, "operator_cancelled");
        assert.equal(
            store.listSentMessages({ senderAgentId: sender, states: ["dead_letter"] }).items[0]?.id,
            dead.id,
        );
        assert.equal(store.listDeadLetters({ rootAgentId: sender }).items[0]?.id, dead.id);
        assert.equal(store.mailboxStats(sender).deadLettered, 1);
        const requeued = store.requeueDeadLetterMessage({
            messageId: dead.id,
            senderAgentId: sender,
            expectedRevision: dead.revision,
            ttlMs: 1_000,
        });
        assert.equal(requeued.state, "queued");
        store.close();
    });

    test("persists queued and acknowledged messages across reopen", () => {
        const { filename, clock, store } = fixture();
        const { sender, recipient } = registerPair(store);
        const toAcknowledge = store.enqueueMessage({
            senderAgentId: sender,
            recipientAgentId: recipient,
            kind: "message",
            content: "durable ack",
        }).message;
        const claimed = store
            .claimMessages({ recipientAgentId: recipient, owner: "consumer", leaseMs: 1_000 })
            .find((message) => message.id === toAcknowledge.id)!;
        const read = store.markMessageRead({
            messageId: claimed.id,
            recipientAgentId: recipient,
            owner: "consumer",
            expectedRevision: claimed.revision,
        });
        const acknowledged = store.acknowledgeMessage({
            messageId: read.id,
            recipientAgentId: recipient,
            owner: "consumer",
            expectedRevision: read.revision,
        });
        const queued = store.enqueueMessage({
            senderAgentId: sender,
            recipientAgentId: recipient,
            kind: "control",
            content: "steer",
        }).message;
        store.close();
        const reopened = SqliteControlPlaneStore.open({ filename, clock });
        assert.equal(reopened.getMessage(queued.id).state, "queued");
        assert.equal(reopened.getMessage(acknowledged.id).state, "acked");
        reopened.close();
    });

    test("enforces namespace provenance and protocol authorization in storage", () => {
        const { store } = fixture();
        const parentA = store.registerAgent({ alias: "coordinator", role: "coordinator" });
        const parentB = store.registerAgent({ alias: "coordinator", role: "coordinator" });
        const childA = store.registerAgent({
            alias: "worker",
            role: "worker",
            parentAgentId: parentA.id,
        });
        const peerA = store.registerAgent({
            alias: "peer",
            role: "worker",
            parentAgentId: parentA.id,
        });
        const childB = store.registerAgent({
            alias: "worker",
            role: "worker",
            parentAgentId: parentB.id,
        });

        assert.equal(store.getAgentByAlias("worker", parentA.id).id, childA.id);
        assert.equal(store.getAgentByAlias("worker", parentB.id).id, childB.id);
        assert.throws(() => store.getAgentByAlias("worker"), expectCode("VALIDATION_FAILED"));
        assert.throws(
            () =>
                store.enqueueMessage({
                    senderAgentId: childA.id,
                    recipientAgentId: childB.id,
                    kind: "message",
                    content: "cross-root injection",
                }),
            expectCode("VALIDATION_FAILED"),
        );
        assert.throws(
            () =>
                store.enqueueMessage({
                    senderAgentId: childA.id,
                    recipientAgentId: peerA.id,
                    kind: "control",
                    content: "impersonated correction",
                }),
            expectCode("VALIDATION_FAILED"),
        );
        const authorized = store.enqueueMessage({
            senderAgentId: parentA.id,
            recipientAgentId: peerA.id,
            kind: "control",
            content: "parent correction",
        }).message;
        assert.equal(authorized.rootAgentId, parentA.id);
        assert.equal(authorized.deliveryMode, "steer");
        assert.equal(authorized.required, true);
        store.close();
    });

    test("holds strict recipient FIFO across consumers and retry backoff", () => {
        const { filename, clock, store } = fixture();
        const { sender, recipient } = registerPair(store);
        const first = store.enqueueMessage({
            senderAgentId: sender,
            recipientAgentId: recipient,
            kind: "message",
            content: "first",
        }).message;
        store.enqueueMessage({
            senderAgentId: sender,
            recipientAgentId: recipient,
            kind: "message",
            content: "second",
        });
        const other = SqliteControlPlaneStore.open({ filename, clock });
        const [claimed] = store.claimMessages({
            recipientAgentId: recipient,
            owner: "one",
            leaseMs: 1_000,
        });
        assert.equal(claimed?.id, first.id);
        assert.equal(
            other.claimMessages({ recipientAgentId: recipient, owner: "two", leaseMs: 1_000 })
                .length,
            0,
        );
        store.retryMessage({
            messageId: claimed!.id,
            recipientAgentId: recipient,
            owner: "one",
            expectedRevision: claimed!.revision,
            availableAt: clock.now() + 500,
        });
        assert.equal(
            other.claimMessages({ recipientAgentId: recipient, owner: "two", leaseMs: 1_000 })
                .length,
            0,
        );
        clock.advance(500);
        assert.equal(
            other.claimMessages({ recipientAgentId: recipient, owner: "two", leaseMs: 1_000 })[0]
                ?.id,
            first.id,
        );
        other.close();
        store.close();
    });

    test("enforces reply participants, response correlation, and thread hop limits", () => {
        const { store } = fixture();
        const parent = store.registerAgent({ alias: "thread_parent", role: "coordinator" });
        const requester = store.registerAgent({
            alias: "requester",
            role: "worker",
            parentAgentId: parent.id,
        });
        const responder = store.registerAgent({
            alias: "responder",
            role: "worker",
            parentAgentId: parent.id,
        });
        const outsider = store.registerAgent({
            alias: "outsider",
            role: "worker",
            parentAgentId: parent.id,
        });
        const request = store.enqueueMessage({
            senderAgentId: requester.id,
            recipientAgentId: responder.id,
            kind: "request",
            content: "question",
        }).message;
        assert.throws(
            () =>
                store.enqueueMessage({
                    senderAgentId: outsider.id,
                    recipientAgentId: requester.id,
                    kind: "response",
                    content: "thread injection",
                    replyToMessageId: request.id,
                }),
            expectCode("VALIDATION_FAILED"),
        );
        const response = store.enqueueMessage({
            senderAgentId: responder.id,
            recipientAgentId: requester.id,
            kind: "response",
            content: "answer",
            replyToMessageId: request.id,
        }).message;
        assert.equal(response.threadId, request.threadId);
        assert.equal(response.hopCount, 1);
        assert.throws(
            () =>
                store.enqueueMessage({
                    senderAgentId: responder.id,
                    recipientAgentId: requester.id,
                    kind: "response",
                    content: "uncorrelated",
                }),
            expectCode("VALIDATION_FAILED"),
        );
        store.close();
    });

    test("tracks completion outbox through parent application and acknowledgement", () => {
        const { filename, clock, store } = fixture();
        const { sender: parent, recipient: child } = registerPair(store);
        const declaration = store.declareCompletion({
            agentId: child,
            invocationToken: "complete-1",
            payload: { status: "succeeded", summary: "done" },
        });
        assert.equal(declaration.state, "declared");
        const result = store.enqueueMessage({
            senderAgentId: child,
            recipientAgentId: parent,
            kind: "result",
            content: "{}",
        }).message;
        store.markCompletionEmitted(child, "complete-1", result.id);
        store.markCompletionParentApplied(child, "complete-1");
        store.markCompletionAcknowledged(child, "complete-1", result.id);
        store.close();

        const reopened = SqliteControlPlaneStore.open({ filename, clock });
        assert.equal(reopened.getCompletion(child)?.state, "acknowledged");
        reopened.close();
    });

    test("prunes terminal mail incrementally while retaining idempotency tombstones", () => {
        const { clock, store } = fixture();
        const { sender, recipient } = registerPair(store);
        const message = store.enqueueMessage({
            senderAgentId: sender,
            recipientAgentId: recipient,
            kind: "message",
            content: "once",
            idempotencyKey: "retained-key",
        }).message;
        const [claimed] = store.claimMessages({
            recipientAgentId: recipient,
            owner: "consumer",
            leaseMs: 1_000,
        });
        const read = store.markMessageRead({
            messageId: claimed!.id,
            recipientAgentId: recipient,
            owner: "consumer",
            expectedRevision: claimed!.revision,
        });
        store.acknowledgeMessage({
            messageId: read.id,
            recipientAgentId: recipient,
            owner: "consumer",
            expectedRevision: read.revision,
        });
        clock.advance(11);
        assert.equal(
            store.pruneMailbox({ retentionMs: 10, idempotencyRetentionMs: 100 }).pruned,
            1,
        );
        assert.throws(
            () =>
                store.enqueueMessage({
                    senderAgentId: sender,
                    recipientAgentId: recipient,
                    kind: "message",
                    content: "once",
                    idempotencyKey: "retained-key",
                }),
            expectCode("CONFLICT"),
        );
        clock.advance(101);
        assert.equal(
            store.pruneMailbox({ retentionMs: 10, idempotencyRetentionMs: 100 }).tombstonesExpired,
            1,
        );
        const replay = store.enqueueMessage({
            senderAgentId: sender,
            recipientAgentId: recipient,
            kind: "message",
            content: "once",
            idempotencyKey: "retained-key",
        });
        assert.notEqual(replay.message.id, message.id);
        store.close();
    });

    test("rolls back injected enqueue failures and exposes mailbox health", () => {
        const failpoints = new DeterministicFailpoints([{ point: "mailbox.enqueue.after_insert" }]);
        const directory = mkdtempSync(join(tmpdir(), "pi-herdr-failpoint-"));
        directories.push(directory);
        const store = SqliteControlPlaneStore.open({
            filename: join(directory, "control.sqlite"),
            failpoint: failpoints.hit,
        });
        const { sender, recipient } = registerPair(store);
        assert.throws(() =>
            store.enqueueMessage({
                senderAgentId: sender,
                recipientAgentId: recipient,
                kind: "message",
                content: "must rollback",
            }),
        );
        const stats = store.mailboxStats(sender);
        assert.equal(stats.queued, 0);
        assert.equal(stats.totalPendingBytes, 0);
        store.close();
    });

    test("bounds a thread queue to prevent unbounded ping-pong", () => {
        const { store } = fixture();
        const { sender, recipient } = registerPair(store);
        const threadId = "77777777-7777-4777-8777-777777777777" as ThreadId;
        for (let index = 0; index < 128; index += 1) {
            store.enqueueMessage({
                senderAgentId: sender,
                recipientAgentId: recipient,
                threadId,
                kind: "message",
                content: `message-${index}`,
            });
        }
        assert.throws(
            () =>
                store.enqueueMessage({
                    senderAgentId: sender,
                    recipientAgentId: recipient,
                    threadId,
                    kind: "message",
                    content: "overflow",
                }),
            expectCode("VALIDATION_FAILED"),
        );
        store.close();
    });
});

describe("durable workflows", () => {
    test("isolates workflow ownership between coordinator namespaces", () => {
        const { store } = fixture();
        const firstRoot = store.registerAgent({ alias: "first-root", role: "coordinator" });
        const secondRoot = store.registerAgent({ alias: "second-root", role: "coordinator" });
        const child = store.registerAgent({
            alias: "first-child",
            role: "worker",
            parentAgentId: firstRoot.id,
        });
        const workflow = store.createWorkflow({
            rootAgentId: firstRoot.id,
            name: "private",
            nodes: [{ nodeId: "work" }],
        });

        assert.equal(workflow.rootAgentId, firstRoot.id);
        assert.equal(store.listWorkflows({ rootAgentId: firstRoot.id }).items.length, 1);
        assert.equal(store.listWorkflows({ rootAgentId: secondRoot.id }).items.length, 0);
        assert.throws(() => store.getWorkflow(workflow.id, secondRoot.id), expectCode("NOT_FOUND"));
        assert.throws(
            () =>
                store.updateWorkflowNode({
                    rootAgentId: secondRoot.id,
                    workflowId: workflow.id,
                    nodeId: "work",
                    patch: { status: "running" },
                    expectedRevision: workflow.nodes[0]?.revision ?? 0,
                }),
            expectCode("NOT_FOUND"),
        );
        assert.throws(
            () =>
                store.createWorkflow({
                    rootAgentId: child.id,
                    name: "child-owned",
                    nodes: [{ nodeId: "work" }],
                }),
            expectCode("NOT_FOUND"),
        );
        assert.equal(store.getWorkflow(workflow.id, firstRoot.id).nodes[0]?.status, "ready");
        store.close();
    });

    test("rejects duplicate nodes, unknown dependencies, and DAG cycles", () => {
        const { store } = fixture();
        const rootAgentId = store.registerAgent({ alias: "workflow-root", role: "coordinator" }).id;
        assert.throws(
            () =>
                store.createWorkflow({
                    rootAgentId,
                    name: "duplicate",
                    nodes: [{ nodeId: "a" }, { nodeId: "a" }],
                }),
            expectCode("VALIDATION_FAILED"),
        );
        assert.throws(
            () =>
                store.createWorkflow({
                    rootAgentId,
                    name: "unknown",
                    nodes: [{ nodeId: "a", dependencies: ["missing"] }],
                }),
            expectCode("VALIDATION_FAILED"),
        );
        assert.throws(
            () =>
                store.createWorkflow({
                    rootAgentId,
                    name: "cycle",
                    nodes: [
                        { nodeId: "a", dependencies: ["b"] },
                        { nodeId: "b", dependencies: ["a"] },
                    ],
                }),
            expectCode("VALIDATION_FAILED"),
        );
        store.close();
    });

    test("atomically advances dependencies and recomputes terminal parent status", () => {
        const { store } = fixture();
        const rootAgentId = store.registerAgent({ alias: "workflow-root", role: "coordinator" }).id;
        let workflow = store.createWorkflow({
            rootAgentId,
            name: "pipeline",
            nodes: [{ nodeId: "research" }, { nodeId: "implement", dependencies: ["research"] }],
        });
        assert.equal(workflow.status, "running");
        assert.equal(workflow.nodes.find((node) => node.nodeId === "research")?.status, "ready");
        assert.equal(workflow.nodes.find((node) => node.nodeId === "implement")?.status, "pending");

        const research = workflow.nodes.find((node) => node.nodeId === "research")!;
        workflow = store.updateWorkflowNode({
            rootAgentId,
            workflowId: workflow.id,
            nodeId: research.nodeId,
            patch: { status: "running" },
            expectedRevision: research.revision,
        });
        const runningResearch = workflow.nodes.find((node) => node.nodeId === "research")!;
        assert.throws(
            () =>
                store.updateWorkflowNode({
                    rootAgentId,
                    workflowId: workflow.id,
                    nodeId: "research",
                    patch: { status: "succeeded" },
                    expectedRevision: research.revision,
                }),
            expectCode("REVISION_CONFLICT"),
        );
        workflow = store.updateWorkflowNode({
            rootAgentId,
            workflowId: workflow.id,
            nodeId: "research",
            patch: { status: "succeeded", output: { finding: "ok" } },
            expectedRevision: runningResearch.revision,
        });
        assert.equal(workflow.nodes.find((node) => node.nodeId === "implement")?.status, "ready");
        const implement = workflow.nodes.find((node) => node.nodeId === "implement")!;
        workflow = store.updateWorkflowNode({
            rootAgentId,
            workflowId: workflow.id,
            nodeId: "implement",
            patch: { status: "running" },
            expectedRevision: implement.revision,
        });
        const runningImplement = workflow.nodes.find((node) => node.nodeId === "implement")!;
        workflow = store.updateWorkflowNode({
            rootAgentId,
            workflowId: workflow.id,
            nodeId: "implement",
            patch: { status: "succeeded" },
            expectedRevision: runningImplement.revision,
        });
        assert.equal(workflow.status, "succeeded");
        assert.equal(
            workflow.nodes.every((node) => node.status === "succeeded"),
            true,
        );
        store.close();
    });

    test("persists workflow DAG and state across reopen", () => {
        const { filename, clock, store } = fixture();
        const rootAgentId = store.registerAgent({ alias: "workflow-root", role: "coordinator" }).id;
        const id: WorkflowId = store.createWorkflow({
            rootAgentId,
            name: "persistent",
            nodes: [{ nodeId: "one" }, { nodeId: "two", dependencies: ["one"] }],
        }).id;
        store.close();
        const reopened = SqliteControlPlaneStore.open({ filename, clock });
        const recovered = reopened.getWorkflow(id, rootAgentId);
        assert.deepEqual(recovered.nodes.find((node) => node.nodeId === "two")?.dependencies, [
            "one",
        ]);
        reopened.close();
    });
});
