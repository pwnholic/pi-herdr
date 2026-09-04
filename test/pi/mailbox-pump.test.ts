import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentId, MessageId, ThreadId } from "../../src/domain/ids.ts";
import type { MailboxMessage } from "../../src/domain/mailbox.ts";
import { MailboxPump, type MailboxPumpStore } from "../../src/pi/mailbox-pump.ts";

const AGENT_ID = "11111111-1111-4111-8111-111111111111" as AgentId;
const MESSAGE_ID = "22222222-2222-4222-8222-222222222222" as MessageId;

function message(revision = 1): MailboxMessage {
    return {
        id: MESSAGE_ID,
        rootAgentId: AGENT_ID,
        recipientAgentId: AGENT_ID,
        threadId: "33333333-3333-4333-8333-333333333333" as ThreadId,
        kind: "result",
        content: "done",
        metadata: {},
        deliveryMode: "followUp",
        required: false,
        hopCount: 0,
        state: "delivered",
        attemptCount: 1,
        maxAttempts: 3,
        availableAt: 0,
        deliveredAt: 0,
        leaseOwner: "test-owner",
        leaseExpiresAt: 10_000,
        createdAt: 0,
        updatedAt: 0,
        revision,
    };
}

test("retry uses the latest revision when acknowledgement fails after mark-read", async () => {
    let claimed = false;
    let retryRevision: number | undefined;
    const store: MailboxPumpStore = {
        getMessage: () => message(2),
        claimMessages: () => {
            if (claimed) return [];
            claimed = true;
            return [message()];
        },
        markMessageRead: () => ({ ...message(2), state: "read" }),
        acknowledgeMessage: () => {
            throw new Error("temporary acknowledgement failure");
        },
        renewMessageLease: () => message(3),
        retryMessage: (input) => {
            retryRevision = input.expectedRevision;
            return { ...message(3), state: "queued" };
        },
    };
    const pump = new MailboxPump({
        store,
        recipientAgentId: AGENT_ID,
        owner: "test-owner",
        leaseMs: 1_000,
        pollMs: 1_000,
        batchSize: 10,
        dispatch: async () => "ack",
    });

    await pump.pollNow();

    assert.equal(retryRevision, 2);
});

test("read messages renew their lease before another mailbox claim", async () => {
    let now = 0;
    let current = message();
    let claimed = false;
    let renewals = 0;
    const store: MailboxPumpStore = {
        getMessage: () => current,
        claimMessages: () => {
            if (claimed) return [];
            claimed = true;
            return [current];
        },
        markMessageRead: () => {
            current = { ...current, state: "read", revision: 2, leaseExpiresAt: 1_000 };
            return current;
        },
        acknowledgeMessage: () => current,
        renewMessageLease: (input) => {
            renewals += 1;
            assert.equal(input.expectedRevision, current.revision);
            current = {
                ...current,
                revision: current.revision + 1,
                leaseExpiresAt: now + input.leaseMs,
            };
            return current;
        },
        retryMessage: () => current,
    };
    const pump = new MailboxPump({
        store,
        recipientAgentId: AGENT_ID,
        owner: "test-owner",
        leaseMs: 1_000,
        pollMs: 1_000,
        batchSize: 10,
        now: () => now,
        dispatch: async () => "read",
    });

    await pump.pollNow();
    now = 900;
    await pump.pollNow();

    assert.equal(renewals, 1);
    assert.equal(current.leaseExpiresAt, 1_900);
    assert.equal(current.revision, 3);
});

test("renews the active delivery lease while an external dispatch is slow", async () => {
    let current = { ...message(), leaseExpiresAt: Date.now() + 30 };
    let claimed = false;
    let renewals = 0;
    const errors: unknown[] = [];
    const store: MailboxPumpStore = {
        getMessage: () => current,
        claimMessages: () => {
            if (claimed) return [];
            claimed = true;
            return [current];
        },
        renewMessageLease: (input) => {
            renewals += 1;
            assert.equal(input.expectedRevision, current.revision);
            current = {
                ...current,
                revision: current.revision + 1,
                leaseExpiresAt: Date.now() + input.leaseMs,
            };
            return current;
        },
        markMessageRead: (input) => {
            assert.equal(input.expectedRevision, current.revision);
            current = { ...current, state: "read", revision: current.revision + 1 };
            return current;
        },
        acknowledgeMessage: () => current,
        retryMessage: () => current,
    };
    const pump = new MailboxPump({
        store,
        recipientAgentId: AGENT_ID,
        owner: "test-owner",
        leaseMs: 30,
        pollMs: 10,
        batchSize: 1,
        dispatch: async () => {
            await new Promise((resolve) => setTimeout(resolve, 75));
            return "read";
        },
        onError: (error) => errors.push(error),
    });

    await pump.pollNow();

    assert.ok(renewals >= 2);
    assert.deepEqual(errors, []);
    assert.equal(current.state, "read");
});
