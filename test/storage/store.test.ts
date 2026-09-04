import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import type { AgentId, WorkflowId } from "../../src/domain/ids.ts";
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
        assert.throws(
            () => store.registerAgent({ alias: "worker_a", role: "worker" }),
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
        });
        clock.advance(500);
        const duplicate = store.enqueueMessage({
            senderAgentId: sender,
            recipientAgentId: recipient,
            kind: "request",
            content: "inspect auth",
            idempotencyKey: "request-1",
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
});

describe("durable workflows", () => {
    test("rejects duplicate nodes, unknown dependencies, and DAG cycles", () => {
        const { store } = fixture();
        assert.throws(
            () =>
                store.createWorkflow({
                    name: "duplicate",
                    nodes: [{ nodeId: "a" }, { nodeId: "a" }],
                }),
            expectCode("VALIDATION_FAILED"),
        );
        assert.throws(
            () =>
                store.createWorkflow({
                    name: "unknown",
                    nodes: [{ nodeId: "a", dependencies: ["missing"] }],
                }),
            expectCode("VALIDATION_FAILED"),
        );
        assert.throws(
            () =>
                store.createWorkflow({
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
        let workflow = store.createWorkflow({
            name: "pipeline",
            nodes: [{ nodeId: "research" }, { nodeId: "implement", dependencies: ["research"] }],
        });
        assert.equal(workflow.status, "running");
        assert.equal(workflow.nodes.find((node) => node.nodeId === "research")?.status, "ready");
        assert.equal(workflow.nodes.find((node) => node.nodeId === "implement")?.status, "pending");

        const research = workflow.nodes.find((node) => node.nodeId === "research")!;
        workflow = store.updateWorkflowNode({
            workflowId: workflow.id,
            nodeId: research.nodeId,
            patch: { status: "running" },
            expectedRevision: research.revision,
        });
        const runningResearch = workflow.nodes.find((node) => node.nodeId === "research")!;
        assert.throws(
            () =>
                store.updateWorkflowNode({
                    workflowId: workflow.id,
                    nodeId: "research",
                    patch: { status: "succeeded" },
                    expectedRevision: research.revision,
                }),
            expectCode("REVISION_CONFLICT"),
        );
        workflow = store.updateWorkflowNode({
            workflowId: workflow.id,
            nodeId: "research",
            patch: { status: "succeeded", output: { finding: "ok" } },
            expectedRevision: runningResearch.revision,
        });
        assert.equal(workflow.nodes.find((node) => node.nodeId === "implement")?.status, "ready");
        const implement = workflow.nodes.find((node) => node.nodeId === "implement")!;
        workflow = store.updateWorkflowNode({
            workflowId: workflow.id,
            nodeId: "implement",
            patch: { status: "running" },
            expectedRevision: implement.revision,
        });
        const runningImplement = workflow.nodes.find((node) => node.nodeId === "implement")!;
        workflow = store.updateWorkflowNode({
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
        const id: WorkflowId = store.createWorkflow({
            name: "persistent",
            nodes: [{ nodeId: "one" }, { nodeId: "two", dependencies: ["one"] }],
        }).id;
        store.close();
        const reopened = SqliteControlPlaneStore.open({ filename, clock });
        const recovered = reopened.getWorkflow(id);
        assert.deepEqual(recovered.nodes.find((node) => node.nodeId === "two")?.dependencies, [
            "one",
        ]);
        reopened.close();
    });
});
