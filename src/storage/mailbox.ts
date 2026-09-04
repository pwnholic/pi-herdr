import {
    ConflictError,
    IdempotencyConflictError,
    InvalidTransitionError,
    LeaseConflictError,
    NotFoundError,
    RevisionConflictError,
    ValidationError,
} from "../domain/errors.ts";
import {
    type AgentId,
    createMessageId,
    createThreadId,
    type MessageId,
    parseAgentId,
    parseMessageId,
    parseThreadId,
} from "../domain/ids.ts";
import {
    type EnqueueMessageInput,
    type EnqueueResult,
    isMessageKind,
    isMessageState,
    type MailboxFilter,
    type MailboxMessage,
    type MessagePage,
} from "../domain/mailbox.ts";
import {
    assertJsonValue,
    MAX_MESSAGE_BYTES,
    validateLabel,
    validateNonNegativeInteger,
    validatePageLimit,
    validatePositiveInteger,
} from "../domain/validation.ts";
import { decodeCursor, encodeCursor } from "./cursor.ts";
import { isSqliteConstraintError, type StorageDatabase } from "./database.ts";
import { canonicalJson, intentHash } from "./json.ts";
import { type MessageRow, toMailboxMessage } from "./rows.ts";

interface IdempotencyRow extends MessageRow {
    readonly intent_hash: string;
}

interface ReplyRow {
    readonly thread_id: string;
}

export interface ClaimMessagesInput {
    readonly recipientAgentId: AgentId;
    readonly owner: string;
    readonly leaseMs: number;
    readonly limit?: number;
}

export interface MessageMutationInput {
    readonly messageId: MessageId;
    readonly recipientAgentId: AgentId;
    readonly owner: string;
    readonly expectedRevision: number;
}

export interface RenewMessageLeaseInput extends MessageMutationInput {
    readonly leaseMs: number;
}

export interface RetryMessageInput extends MessageMutationInput {
    readonly availableAt?: number;
    readonly reason?: string;
}

export interface DeadLetterMessageInput {
    readonly messageId: MessageId;
    readonly reason: string;
    readonly expectedRevision: number;
}

export interface MaintenanceResult {
    readonly expired: number;
    readonly attemptsExhausted: number;
    readonly requeued: number;
}

export class MailboxRepository {
    readonly #storage: StorageDatabase;

    constructor(storage: StorageDatabase) {
        this.#storage = storage;
    }

    enqueue(input: EnqueueMessageInput): EnqueueResult {
        const id = input.id === undefined ? createMessageId() : parseMessageId(input.id);
        const senderAgentId =
            input.senderAgentId === undefined ? undefined : parseAgentId(input.senderAgentId);
        const recipientAgentId = parseAgentId(input.recipientAgentId);
        if (!isMessageKind(input.kind))
            throw new ValidationError("kind is invalid", { field: "kind" });
        if (
            typeof input.content !== "string" ||
            Buffer.byteLength(input.content, "utf8") > MAX_MESSAGE_BYTES
        ) {
            throw new ValidationError(
                `content must be a string no larger than ${MAX_MESSAGE_BYTES} bytes`,
                { field: "content" },
            );
        }
        const metadata = input.metadata ?? {};
        assertJsonValue(metadata, "metadata");
        const idempotencyKey =
            input.idempotencyKey === undefined
                ? undefined
                : validateLabel(input.idempotencyKey, "idempotencyKey", 128);
        const maxAttempts = validatePositiveInteger(input.maxAttempts ?? 3, "maxAttempts", 100);
        const now = this.#storage.now();
        const availableAt =
            input.availableAt === undefined
                ? now
                : validateNonNegativeInteger(input.availableAt, "availableAt");
        const expiresAt =
            input.expiresAt === undefined
                ? undefined
                : validateNonNegativeInteger(input.expiresAt, "expiresAt");
        if (expiresAt !== undefined && (expiresAt <= now || expiresAt <= availableAt)) {
            throw new ValidationError("expiresAt must be later than both now and availableAt", {
                field: "expiresAt",
            });
        }

        this.#requireAgent(recipientAgentId);
        if (senderAgentId !== undefined) this.#requireAgent(senderAgentId);

        let threadId = input.threadId === undefined ? undefined : parseThreadId(input.threadId);
        const replyToMessageId =
            input.replyToMessageId === undefined
                ? undefined
                : parseMessageId(input.replyToMessageId);
        if (replyToMessageId !== undefined) {
            const reply = this.#storage.connection
                .prepare("SELECT thread_id FROM mailbox_messages WHERE id = ?")
                .get(replyToMessageId) as ReplyRow | undefined;
            if (!reply) throw new NotFoundError("message", replyToMessageId);
            if (threadId !== undefined && threadId !== reply.thread_id) {
                throw new ValidationError("threadId must match the replied-to message", {
                    field: "threadId",
                });
            }
            threadId = parseThreadId(reply.thread_id);
        }

        const senderScope = senderAgentId ?? "@system";
        const requestHash =
            idempotencyKey === undefined
                ? undefined
                : intentHash({
                      senderAgentId: senderAgentId ?? null,
                      recipientAgentId,
                      threadId: threadId ?? null,
                      replyToMessageId: replyToMessageId ?? null,
                      kind: input.kind,
                      content: input.content,
                      metadata,
                      availableAt: input.availableAt ?? null,
                      expiresAt: expiresAt ?? null,
                      maxAttempts,
                  });

        if (idempotencyKey !== undefined && requestHash !== undefined) {
            const duplicate = this.#findIdempotent(senderScope, idempotencyKey);
            if (duplicate)
                return this.#resolveDuplicate(duplicate, requestHash, senderScope, idempotencyKey);
        }

        const resolvedThreadId = threadId ?? createThreadId();
        try {
            this.#storage.connection
                .prepare(`
                    INSERT INTO mailbox_messages(
                        id, sender_agent_id, sender_scope, recipient_agent_id, thread_id,
                        reply_to_message_id, kind, content, metadata_json, state,
                        attempt_count, max_attempts, available_at, expires_at,
                        idempotency_key, intent_hash, created_at, updated_at, revision
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?, ?, ?, ?, 0)
                `)
                .run(
                    id,
                    senderAgentId ?? null,
                    senderScope,
                    recipientAgentId,
                    resolvedThreadId,
                    replyToMessageId ?? null,
                    input.kind,
                    input.content,
                    canonicalJson(metadata),
                    maxAttempts,
                    availableAt,
                    expiresAt ?? null,
                    idempotencyKey ?? null,
                    requestHash ?? null,
                    now,
                    now,
                );
        } catch (cause) {
            if (
                idempotencyKey !== undefined &&
                requestHash !== undefined &&
                isSqliteConstraintError(cause)
            ) {
                const duplicate = this.#findIdempotent(senderScope, idempotencyKey);
                if (duplicate)
                    return this.#resolveDuplicate(
                        duplicate,
                        requestHash,
                        senderScope,
                        idempotencyKey,
                    );
            }
            if (isSqliteConstraintError(cause)) {
                throw new ConflictError(
                    "Message id already exists or message references are invalid",
                    { id },
                    cause,
                );
            }
            throw cause;
        }
        return { message: this.get(id), deduplicated: false };
    }

    get(messageId: MessageId): MailboxMessage {
        this.runMaintenance();
        return toMailboxMessage(this.#getRow(parseMessageId(messageId)));
    }

    list(filter: MailboxFilter): MessagePage {
        const recipientAgentId = parseAgentId(filter.recipientAgentId);
        const limit = validatePageLimit(filter.limit);
        const cursor = decodeCursor(filter.cursor, "messages");
        this.#requireAgent(recipientAgentId);
        this.runMaintenance();

        const conditions = ["recipient_agent_id = ?"];
        const parameters: unknown[] = [recipientAgentId];
        if (filter.states !== undefined) {
            if (
                filter.states.length === 0 ||
                filter.states.length > 5 ||
                new Set(filter.states).size !== filter.states.length
            ) {
                throw new ValidationError("states must contain 1-5 unique message states", {
                    field: "states",
                });
            }
            for (const state of filter.states) {
                if (!isMessageState(state))
                    throw new ValidationError("states contains an invalid state", {
                        field: "states",
                    });
            }
            conditions.push(`state IN (${filter.states.map(() => "?").join(", ")})`);
            parameters.push(...filter.states);
        }
        if (filter.threadId !== undefined) {
            conditions.push("thread_id = ?");
            parameters.push(parseThreadId(filter.threadId));
        }
        if (cursor) {
            conditions.push("sequence > ?");
            parameters.push(cursor.createdAt);
        }
        parameters.push(limit + 1);
        const rows = this.#storage.connection
            .prepare(`
                SELECT * FROM mailbox_messages
                WHERE ${conditions.join(" AND ")}
                ORDER BY sequence
                LIMIT ?
            `)
            .all(...parameters) as MessageRow[];
        const hasMore = rows.length > limit;
        const pageRows = rows.slice(0, limit);
        const last = pageRows.at(-1);
        return {
            items: pageRows.map(toMailboxMessage),
            ...(hasMore && last
                ? { nextCursor: encodeCursor("messages", last.sequence, last.id) }
                : {}),
        };
    }

    claim(input: ClaimMessagesInput): readonly MailboxMessage[] {
        const recipientAgentId = parseAgentId(input.recipientAgentId);
        const owner = validateLabel(input.owner, "owner", 256);
        const leaseMs = validatePositiveInteger(input.leaseMs, "leaseMs", 3_600_000);
        const limit = validatePageLimit(input.limit);
        this.#requireAgent(recipientAgentId);
        const now = this.#storage.now();

        return this.#storage.connection
            .transaction(() => {
                this.#runMaintenance(now);
                const candidates = this.#storage.connection
                    .prepare(`
                    SELECT * FROM mailbox_messages
                    WHERE recipient_agent_id = ? AND state = 'queued' AND available_at <= ?
                    ORDER BY sequence
                    LIMIT ?
                `)
                    .all(recipientAgentId, now, limit) as MessageRow[];
                const claimed: MailboxMessage[] = [];
                for (const row of candidates) {
                    const result = this.#storage.connection
                        .prepare(`
                        UPDATE mailbox_messages
                        SET state = 'delivered', attempt_count = attempt_count + 1,
                            delivered_at = ?, read_at = NULL, lease_owner = ?, lease_expires_at = ?,
                            updated_at = ?, revision = revision + 1
                        WHERE id = ? AND revision = ? AND state = 'queued'
                    `)
                        .run(now, owner, now + leaseMs, now, row.id, row.revision);
                    if (result.changes === 1)
                        claimed.push(toMailboxMessage(this.#getRow(row.id as MessageId)));
                }
                return claimed;
            })
            .immediate();
    }

    markRead(input: MessageMutationInput): MailboxMessage {
        return this.#leasedTransition(input, "delivered", "read", "read_at");
    }

    acknowledge(input: MessageMutationInput): MailboxMessage {
        return this.#leasedTransition(input, "read", "acked", "acked_at", true);
    }

    renewLease(input: RenewMessageLeaseInput): MailboxMessage {
        const id = parseMessageId(input.messageId);
        const recipient = parseAgentId(input.recipientAgentId);
        const owner = validateLabel(input.owner, "owner", 256);
        const expected = validateNonNegativeInteger(input.expectedRevision, "expectedRevision");
        const leaseMs = validatePositiveInteger(input.leaseMs, "leaseMs", 3_600_000);
        const now = this.#storage.now();
        const row = this.#getRow(id);
        this.#assertMutation(row, recipient, owner, expected, ["delivered", "read"], now);
        const result = this.#storage.connection
            .prepare(`
                UPDATE mailbox_messages
                SET lease_expires_at = ?, updated_at = ?, revision = revision + 1
                WHERE id = ? AND revision = ? AND state IN ('delivered', 'read')
            `)
            .run(now + leaseMs, now, id, expected);
        if (result.changes !== 1) this.#throwRevision(id, expected);
        return toMailboxMessage(this.#getRow(id));
    }

    retry(input: RetryMessageInput): MailboxMessage {
        const id = parseMessageId(input.messageId);
        const recipient = parseAgentId(input.recipientAgentId);
        const owner = validateLabel(input.owner, "owner", 256);
        const expected = validateNonNegativeInteger(input.expectedRevision, "expectedRevision");
        const now = this.#storage.now();
        const availableAt =
            input.availableAt === undefined
                ? now
                : validateNonNegativeInteger(input.availableAt, "availableAt");
        const reason =
            input.reason === undefined ? undefined : validateLabel(input.reason, "reason", 512);
        const row = this.#getRow(id);
        this.#assertMutation(row, recipient, owner, expected, ["delivered", "read"], now);

        if (row.attempt_count >= row.max_attempts) {
            const result = this.#storage.connection
                .prepare(`
                    UPDATE mailbox_messages
                    SET state = 'dead_letter', dead_lettered_at = ?, dead_letter_reason = ?,
                        lease_owner = NULL, lease_expires_at = NULL, updated_at = ?, revision = revision + 1
                    WHERE id = ? AND revision = ?
                `)
                .run(now, reason ?? "delivery_attempts_exhausted", now, id, expected);
            if (result.changes !== 1) this.#throwRevision(id, expected);
        } else {
            const result = this.#storage.connection
                .prepare(`
                    UPDATE mailbox_messages
                    SET state = 'queued', available_at = ?, delivered_at = NULL, read_at = NULL,
                        lease_owner = NULL, lease_expires_at = NULL, updated_at = ?, revision = revision + 1
                    WHERE id = ? AND revision = ?
                `)
                .run(availableAt, now, id, expected);
            if (result.changes !== 1) this.#throwRevision(id, expected);
        }
        return toMailboxMessage(this.#getRow(id));
    }

    deadLetter(input: DeadLetterMessageInput): MailboxMessage {
        const id = parseMessageId(input.messageId);
        const reason = validateLabel(input.reason, "reason", 512);
        const expected = validateNonNegativeInteger(input.expectedRevision, "expectedRevision");
        const row = this.#getRow(id);
        if (row.revision !== expected)
            throw new RevisionConflictError("message", id, expected, row.revision);
        if (row.state === "acked" || row.state === "dead_letter") {
            throw new InvalidTransitionError("message", id, row.state, "dead_letter");
        }
        const now = this.#storage.now();
        const result = this.#storage.connection
            .prepare(`
                UPDATE mailbox_messages
                SET state = 'dead_letter', dead_lettered_at = ?, dead_letter_reason = ?,
                    lease_owner = NULL, lease_expires_at = NULL, updated_at = ?, revision = revision + 1
                WHERE id = ? AND revision = ?
            `)
            .run(now, reason, now, id, expected);
        if (result.changes !== 1) this.#throwRevision(id, expected);
        return toMailboxMessage(this.#getRow(id));
    }

    runMaintenance(): MaintenanceResult {
        const now = this.#storage.now();
        return this.#storage.connection.transaction(() => this.#runMaintenance(now)).immediate();
    }

    #runMaintenance(now: number): MaintenanceResult {
        const expired = this.#storage.connection
            .prepare(`
                UPDATE mailbox_messages
                SET state = 'dead_letter', dead_lettered_at = ?, dead_letter_reason = 'expired',
                    lease_owner = NULL, lease_expires_at = NULL, updated_at = ?, revision = revision + 1
                WHERE state NOT IN ('acked','dead_letter') AND expires_at IS NOT NULL AND expires_at <= ?
            `)
            .run(now, now, now).changes;
        const attemptsExhausted = this.#storage.connection
            .prepare(`
                UPDATE mailbox_messages
                SET state = 'dead_letter', dead_lettered_at = ?, dead_letter_reason = 'delivery_attempts_exhausted',
                    lease_owner = NULL, lease_expires_at = NULL, updated_at = ?, revision = revision + 1
                WHERE state IN ('delivered','read') AND lease_expires_at <= ? AND attempt_count >= max_attempts
            `)
            .run(now, now, now).changes;
        const requeued = this.#storage.connection
            .prepare(`
                UPDATE mailbox_messages
                SET state = 'queued', delivered_at = NULL, read_at = NULL,
                    lease_owner = NULL, lease_expires_at = NULL, updated_at = ?, revision = revision + 1
                WHERE state IN ('delivered','read') AND lease_expires_at <= ? AND attempt_count < max_attempts
            `)
            .run(now, now).changes;
        return { expired, attemptsExhausted, requeued };
    }

    #leasedTransition(
        input: MessageMutationInput,
        from: "delivered" | "read",
        to: "read" | "acked",
        timestampColumn: "read_at" | "acked_at",
        releaseLease = false,
    ): MailboxMessage {
        const id = parseMessageId(input.messageId);
        const recipient = parseAgentId(input.recipientAgentId);
        const owner = validateLabel(input.owner, "owner", 256);
        const expected = validateNonNegativeInteger(input.expectedRevision, "expectedRevision");
        const now = this.#storage.now();
        const row = this.#getRow(id);
        this.#assertMutation(row, recipient, owner, expected, [from], now);
        const leaseSql = releaseLease ? ", lease_owner = NULL, lease_expires_at = NULL" : "";
        const result = this.#storage.connection
            .prepare(`
                UPDATE mailbox_messages
                SET state = ?, ${timestampColumn} = ?, updated_at = ?, revision = revision + 1${leaseSql}
                WHERE id = ? AND revision = ? AND state = ?
            `)
            .run(to, now, now, id, expected, from);
        if (result.changes !== 1) this.#throwRevision(id, expected);
        return toMailboxMessage(this.#getRow(id));
    }

    #assertMutation(
        row: MessageRow,
        recipient: AgentId,
        owner: string,
        expected: number,
        allowedStates: readonly string[],
        now: number,
    ): void {
        if (row.recipient_agent_id !== recipient) throw new NotFoundError("message", row.id);
        if (row.revision !== expected)
            throw new RevisionConflictError("message", row.id, expected, row.revision);
        if (!allowedStates.includes(row.state)) {
            throw new InvalidTransitionError(
                "message",
                row.id,
                row.state,
                allowedStates[0] ?? "unknown",
            );
        }
        if (
            row.lease_owner !== owner ||
            row.lease_expires_at === null ||
            row.lease_expires_at <= now
        ) {
            throw new LeaseConflictError("message", row.id, row.lease_owner ?? undefined);
        }
    }

    #resolveDuplicate(
        row: IdempotencyRow,
        requestHash: string,
        scope: string,
        key: string,
    ): EnqueueResult {
        if (row.intent_hash !== requestHash) throw new IdempotencyConflictError(scope, key);
        return { message: toMailboxMessage(row), deduplicated: true };
    }

    #findIdempotent(scope: string, key: string): IdempotencyRow | undefined {
        return this.#storage.connection
            .prepare(
                "SELECT * FROM mailbox_messages WHERE sender_scope = ? AND idempotency_key = ?",
            )
            .get(scope, key) as IdempotencyRow | undefined;
    }

    #requireAgent(agentId: AgentId): void {
        const row = this.#storage.connection
            .prepare("SELECT 1 FROM agents WHERE id = ?")
            .get(agentId);
        if (!row) throw new NotFoundError("agent", agentId);
    }

    #getRow(messageId: MessageId): MessageRow {
        const row = this.#storage.connection
            .prepare("SELECT * FROM mailbox_messages WHERE id = ?")
            .get(messageId) as MessageRow | undefined;
        if (!row) throw new NotFoundError("message", messageId);
        return row;
    }

    #throwRevision(messageId: MessageId, expected: number): never {
        const actual = this.#getRow(messageId).revision;
        throw new RevisionConflictError("message", messageId, expected, actual);
    }
}
