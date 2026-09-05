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
    isMessageDeliveryMode,
    isMessageKind,
    isMessageState,
    type MailboxFilter,
    type MailboxMessage,
    type MailboxStats,
    type MessagePage,
    type OutboxFilter,
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
    readonly sender_run_id: string | null;
    readonly recipient_run_id: string;
    readonly thread_id: string;
    readonly sender_agent_id: string | null;
    readonly recipient_agent_id: string;
    readonly hop_count: number;
    readonly kind: string;
}

interface AgentNamespaceRow {
    readonly id: string;
    readonly run_id: string;
    readonly parent_agent_id: string | null;
    readonly root_agent_id: string;
}

interface TombstoneRow {
    readonly intent_hash: string;
    readonly message_id: string;
}

interface StatsRow {
    readonly queued: number;
    readonly delivered: number;
    readonly read: number;
    readonly acknowledged: number;
    readonly dead_lettered: number;
    readonly oldest_pending_at: number | null;
    readonly total_pending_bytes: number;
}

export const MAILBOX_QUEUE_LIMITS = {
    perSender: 1_000,
    perRecipient: 1_000,
    perThread: 128,
} as const;

export interface RequeueDeadLetterInput {
    readonly messageId: MessageId;
    readonly senderAgentId: AgentId;
    readonly expectedRevision: number;
    readonly ttlMs?: number;
}

export interface ClaimMessagesInput {
    readonly recipientAgentId: AgentId;
    readonly recipientRunId?: string;
    readonly preferredLane?: "control" | "result" | "ordinary";
    readonly owner: string;
    readonly leaseMs: number;
    readonly limit?: number;
    readonly messageId?: MessageId;
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

export interface PruneMessagesInput {
    readonly retentionMs: number;
    readonly idempotencyRetentionMs: number;
    readonly limit?: number;
}

export interface PruneMessagesResult {
    readonly pruned: number;
    readonly tombstonesExpired: number;
}

export interface ListNamespaceMessagesInput {
    readonly rootAgentId: AgentId;
    readonly limit?: number;
    readonly cursor?: string;
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
        const deliveryMode =
            input.deliveryMode ?? (input.kind === "control" ? "steer" : "followUp");
        if (!isMessageDeliveryMode(deliveryMode)) {
            throw new ValidationError("deliveryMode is invalid", { field: "deliveryMode" });
        }
        const required = input.required ?? (input.kind === "control" || input.kind === "request");
        if (typeof required !== "boolean") {
            throw new ValidationError("required must be a boolean", { field: "required" });
        }
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
        if (input.expiresAt !== undefined && input.ttlMs !== undefined) {
            throw new ValidationError("expiresAt and ttlMs are mutually exclusive", {
                field: "expiresAt",
            });
        }
        const ttlMs =
            input.ttlMs === undefined
                ? undefined
                : validatePositiveInteger(input.ttlMs, "ttlMs", 90 * 24 * 60 * 60 * 1000);
        const expiresAt =
            input.expiresAt === undefined
                ? ttlMs === undefined
                    ? undefined
                    : now + ttlMs
                : validateNonNegativeInteger(input.expiresAt, "expiresAt");
        if (expiresAt !== undefined && (expiresAt <= now || expiresAt <= availableAt)) {
            throw new ValidationError("expiresAt must be later than both now and availableAt", {
                field: "expiresAt",
            });
        }

        return this.#storage.connection
            .transaction(() => {
                const recipient = this.#requireAgent(recipientAgentId);
                const sender =
                    senderAgentId === undefined ? undefined : this.#requireAgent(senderAgentId);
                if (
                    (input.senderRunId !== undefined && input.senderRunId !== sender?.run_id) ||
                    (input.recipientRunId !== undefined &&
                        input.recipientRunId !== recipient.run_id)
                ) {
                    throw new ValidationError("Message belongs to a superseded assignment");
                }
                if (sender !== undefined && sender.root_agent_id !== recipient.root_agent_id) {
                    throw new ValidationError(
                        "Sender and recipient belong to different communication namespaces",
                    );
                }
                if (
                    input.kind === "control" &&
                    sender !== undefined &&
                    !this.#isAncestor(sender.id as AgentId, recipientAgentId)
                ) {
                    throw new ValidationError(
                        "Control mail may only be sent by an ancestor of the recipient",
                        { field: "kind" },
                    );
                }
                if (
                    input.kind === "result" &&
                    (sender === undefined || recipient.id !== sender.parent_agent_id)
                ) {
                    throw new ValidationError(
                        "Completion results may only be sent to the sender's direct parent",
                        { field: "kind" },
                    );
                }

                let threadId =
                    input.threadId === undefined ? undefined : parseThreadId(input.threadId);
                let hopCount = 0;
                const replyToMessageId =
                    input.replyToMessageId === undefined
                        ? undefined
                        : parseMessageId(input.replyToMessageId);
                if (replyToMessageId !== undefined) {
                    const reply = this.#storage.connection
                        .prepare(
                            "SELECT thread_id, sender_agent_id, recipient_agent_id, sender_run_id, recipient_run_id, hop_count, kind FROM mailbox_messages WHERE id = ?",
                        )
                        .get(replyToMessageId) as ReplyRow | undefined;
                    if (!reply) throw new NotFoundError("message", replyToMessageId);
                    if (
                        reply.sender_run_id !== recipient.run_id ||
                        reply.recipient_run_id !== sender?.run_id
                    ) {
                        throw new ValidationError("Cannot reply across assignment generations");
                    }
                    if (threadId !== undefined && threadId !== reply.thread_id) {
                        throw new ValidationError("threadId must match the replied-to message", {
                            field: "threadId",
                        });
                    }
                    if (
                        reply.sender_agent_id === null ||
                        senderAgentId !== (reply.recipient_agent_id as AgentId) ||
                        recipientAgentId !== (reply.sender_agent_id as AgentId)
                    ) {
                        throw new ValidationError(
                            "reply sender and recipient must reverse the referenced message participants",
                            { field: "replyToMessageId" },
                        );
                    }
                    if (input.kind === "response" && reply.kind !== "request") {
                        throw new ValidationError(
                            "response mail must reply directly to a request",
                            { field: "replyToMessageId" },
                        );
                    }
                    threadId = parseThreadId(reply.thread_id);
                    hopCount = reply.hop_count + 1;
                    if (hopCount > 64) {
                        throw new ValidationError("message thread exceeds the maximum hop count", {
                            field: "replyToMessageId",
                        });
                    }
                } else if (input.kind === "response") {
                    throw new ValidationError("response mail requires replyToMessageId", {
                        field: "replyToMessageId",
                    });
                }

                const senderScope =
                    sender === undefined
                        ? `@system:${recipient.root_agent_id}`
                        : `${sender.id}:${sender.run_id}`;
                const requestHash =
                    idempotencyKey === undefined
                        ? undefined
                        : intentHash({
                              senderAgentId: senderAgentId ?? null,
                              senderRunId: sender?.run_id ?? null,
                              recipientRunId: recipient.run_id,
                              recipientAgentId,
                              threadId: threadId ?? null,
                              replyToMessageId: replyToMessageId ?? null,
                              kind: input.kind,
                              content: input.content,
                              metadata,
                              deliveryMode,
                              required,
                              hopCount,
                              availableAt: input.availableAt ?? null,
                              expiresAt: input.expiresAt ?? null,
                              ttlMs: ttlMs ?? null,
                              maxAttempts,
                          });

                if (idempotencyKey !== undefined && requestHash !== undefined) {
                    const duplicate = this.#findIdempotent(senderScope, idempotencyKey);
                    if (duplicate) {
                        return this.#resolveDuplicate(
                            duplicate,
                            requestHash,
                            senderScope,
                            idempotencyKey,
                        );
                    }
                    const tombstone = this.#findTombstone(senderScope, idempotencyKey, now);
                    if (tombstone !== undefined) {
                        if (tombstone.intent_hash !== requestHash) {
                            throw new IdempotencyConflictError(senderScope, idempotencyKey);
                        }
                        throw new ConflictError(
                            "The idempotent message was already completed and pruned",
                            { messageId: tombstone.message_id, senderScope, idempotencyKey },
                        );
                    }
                }

                const resolvedThreadId = threadId ?? createThreadId();
                this.#assertQueueCapacity(
                    senderScope,
                    recipientAgentId,
                    resolvedThreadId,
                    input.kind,
                );
                try {
                    this.#storage.hit("mailbox.enqueue.before_insert", { messageId: id });
                    this.#storage.connection
                        .prepare(`
                            INSERT INTO
                                mailbox_messages (
                                    id,
                                    sender_agent_id,
                                    sender_scope,
                                    recipient_agent_id,
                                    root_agent_id,
                                    thread_id,
                                    reply_to_message_id,
                                    kind,
                                    content,
                                    metadata_json,
                                    state,
                                    delivery_mode,
                                    required,
                                    hop_count,
                                    sender_run_id,
                                    recipient_run_id,
                                    attempt_count,
                                    max_attempts,
                                    available_at,
                                    expires_at,
                                    idempotency_key,
                                    intent_hash,
                                    created_at,
                                    updated_at,
                                    revision
                                )
                            VALUES
                                (
                                    ?,
                                    ?,
                                    ?,
                                    ?,
                                    ?,
                                    ?,
                                    ?,
                                    ?,
                                    ?,
                                    ?,
                                    'queued',
                                    ?,
                                    ?,
                                    ?,
                                    ?,
                                    ?,
                                    0,
                                    ?,
                                    ?,
                                    ?,
                                    ?,
                                    ?,
                                    ?,
                                    ?,
                                    0
                                )
                `)
                        .run(
                            id,
                            senderAgentId ?? null,
                            senderScope,
                            recipientAgentId,
                            recipient.root_agent_id,
                            resolvedThreadId,
                            replyToMessageId ?? null,
                            input.kind,
                            input.content,
                            canonicalJson(metadata),
                            deliveryMode,
                            required ? 1 : 0,
                            hopCount,
                            sender?.run_id ?? null,
                            recipient.run_id,
                            maxAttempts,
                            availableAt,
                            expiresAt ?? null,
                            idempotencyKey ?? null,
                            requestHash ?? null,
                            now,
                            now,
                        );
                    this.#storage.hit("mailbox.enqueue.after_insert", { messageId: id });
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
                return { message: toMailboxMessage(this.#getRow(id)), deduplicated: false };
            })
            .immediate();
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

    listSent(filter: OutboxFilter): MessagePage {
        const senderAgentId = parseAgentId(filter.senderAgentId);
        const limit = validatePageLimit(filter.limit);
        const cursor = decodeCursor(filter.cursor, "messages");
        this.#requireAgent(senderAgentId);
        this.runMaintenance();
        const conditions = ["sender_agent_id = ?"];
        const parameters: unknown[] = [senderAgentId];
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
                if (!isMessageState(state)) {
                    throw new ValidationError("states contains an invalid state", {
                        field: "states",
                    });
                }
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
        const lane = input.preferredLane ?? "control";
        if (!["control", "result", "ordinary"].includes(lane))
            throw new ValidationError("Invalid mailbox lane");
        if (
            input.recipientRunId !== undefined &&
            this.#requireAgent(recipientAgentId).run_id !== input.recipientRunId
        ) {
            throw new ValidationError("Mailbox consumer belongs to a superseded assignment");
        }
        const owner = validateLabel(input.owner, "owner", 256);
        const leaseMs = validatePositiveInteger(input.leaseMs, "leaseMs", 3_600_000);
        const limit = validatePageLimit(input.limit);
        const messageId =
            input.messageId === undefined ? undefined : parseMessageId(input.messageId);
        this.#requireAgent(recipientAgentId);
        const now = this.#storage.now();

        return this.#storage.connection
            .transaction(() => {
                if (
                    input.recipientRunId !== undefined &&
                    this.#requireAgent(recipientAgentId).run_id !== input.recipientRunId
                ) {
                    throw new ValidationError(
                        "Mailbox consumer belongs to a superseded assignment",
                    );
                }
                this.#runMaintenance(now);
                const candidates = this.#storage.connection
                    .prepare(
                        messageId === undefined
                            ? `
                            SELECT
                                candidate.*
                            FROM
                                mailbox_messages AS candidate
                            WHERE
                                candidate.recipient_agent_id = ?
                                AND candidate.state = 'queued'
                                AND candidate.available_at <= ?
                                AND NOT EXISTS (
                                    SELECT
                                        1
                                    FROM
                                        mailbox_messages AS earlier
                                    WHERE
                                        earlier.recipient_agent_id = candidate.recipient_agent_id
                                        AND (earlier.kind = 'control') = (candidate.kind = 'control')
                                        AND (earlier.kind = 'result') = (candidate.kind = 'result')
                                        AND earlier.state IN ('queued', 'delivered', 'read')
                                        AND earlier.sequence < candidate.sequence
                                )
                            ORDER BY
                                (CASE candidate.kind WHEN 'control' THEN 'control' WHEN 'result' THEN 'result' ELSE 'ordinary' END = ?) DESC,
                                CASE candidate.kind
                                    WHEN 'control' THEN 0
                                    WHEN 'result' THEN 1
                                    ELSE 2
                                END,
                                candidate.sequence
                            LIMIT
                                ?
                            `
                            : `
                            SELECT
                                *
                            FROM
                                mailbox_messages
                            WHERE
                                recipient_agent_id = ?
                                AND id = ?
                                AND state = 'queued'
                                AND available_at <= ?
                                AND NOT EXISTS (
                                    SELECT
                                        1
                                    FROM
                                        mailbox_messages AS earlier
                                    WHERE
                                        earlier.recipient_agent_id = mailbox_messages.recipient_agent_id
                                        AND (earlier.kind = 'control') = (mailbox_messages.kind = 'control')
                                        AND (earlier.kind = 'result') = (mailbox_messages.kind = 'result')
                                        AND earlier.state IN ('queued', 'delivered', 'read')
                                        AND earlier.sequence < mailbox_messages.sequence
                                )
                            LIMIT
                                ?
                            `,
                    )
                    .all(
                        ...(messageId === undefined
                            ? [recipientAgentId, now, lane, limit]
                            : [recipientAgentId, messageId, now, limit]),
                    ) as MessageRow[];
                const claimed: MailboxMessage[] = [];
                for (const row of candidates) {
                    const result = this.#storage.connection
                        .prepare(`
                            UPDATE mailbox_messages
                            SET
                                state = 'delivered',
                                attempt_count = attempt_count + 1,
                                delivered_at = ?,
                                read_at = NULL,
                                lease_owner = ?,
                                lease_expires_at = ?,
                                updated_at = ?,
                                revision = revision + 1
                            WHERE
                                id = ?
                                AND revision = ?
                                AND state = 'queued'
                    `)
                        .run(now, owner, now + leaseMs, now, row.id, row.revision);
                    if (result.changes === 1)
                        claimed.push(toMailboxMessage(this.#getRow(row.id as MessageId)));
                }
                this.#storage.hit("mailbox.claim.after_update", {
                    recipientAgentId,
                    count: claimed.length,
                });
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
                SET
                    lease_expires_at = ?,
                    updated_at = ?,
                    revision = revision + 1
                WHERE
                    id = ?
                    AND revision = ?
                    AND state IN ('delivered', 'read')
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
                    SET
                        state = 'dead_letter',
                        dead_lettered_at = ?,
                        dead_letter_reason = ?,
                        lease_owner = NULL,
                        lease_expires_at = NULL,
                        updated_at = ?,
                        revision = revision + 1
                    WHERE
                        id = ?
                        AND revision = ?
                `)
                .run(now, reason ?? "delivery_attempts_exhausted", now, id, expected);
            if (result.changes !== 1) this.#throwRevision(id, expected);
        } else {
            const result = this.#storage.connection
                .prepare(`
                    UPDATE mailbox_messages
                    SET
                        state = 'queued',
                        available_at = ?,
                        delivered_at = NULL,
                        read_at = NULL,
                        lease_owner = NULL,
                        lease_expires_at = NULL,
                        updated_at = ?,
                        revision = revision + 1
                    WHERE
                        id = ?
                        AND revision = ?
                `)
                .run(availableAt, now, id, expected);
            if (result.changes !== 1) this.#throwRevision(id, expected);
        }
        return toMailboxMessage(this.#getRow(id));
    }

    requeueDeadLetter(input: RequeueDeadLetterInput): MailboxMessage {
        const id = parseMessageId(input.messageId);
        const sender = parseAgentId(input.senderAgentId);
        const expected = validateNonNegativeInteger(input.expectedRevision, "expectedRevision");
        const ttlMs =
            input.ttlMs === undefined
                ? undefined
                : validatePositiveInteger(input.ttlMs, "ttlMs", 90 * 24 * 60 * 60 * 1000);
        const row = this.#getRow(id);
        this.#assertAssignment(row);
        if (row.sender_agent_id !== sender) throw new NotFoundError("message", id);
        if (row.revision !== expected) this.#throwRevision(id, expected);
        if (row.state !== "dead_letter") {
            throw new InvalidTransitionError("message", id, row.state, "queued");
        }
        const now = this.#storage.now();
        const result = this.#storage.connection
            .prepare(`
                UPDATE mailbox_messages
                SET
                    state = 'queued',
                    attempt_count = 0,
                    available_at = ?,
                    expires_at = ?,
                    delivered_at = NULL,
                    read_at = NULL,
                    acked_at = NULL,
                    dead_lettered_at = NULL,
                    dead_letter_reason = NULL,
                    lease_owner = NULL,
                    lease_expires_at = NULL,
                    updated_at = ?,
                    revision = revision + 1
                WHERE
                    id = ?
                    AND revision = ?
                    AND state = 'dead_letter'
            `)
            .run(now, ttlMs === undefined ? null : now + ttlMs, now, id, expected);
        if (result.changes !== 1) this.#throwRevision(id, expected);
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
                SET
                    state = 'dead_letter',
                    dead_lettered_at = ?,
                    dead_letter_reason = ?,
                    lease_owner = NULL,
                    lease_expires_at = NULL,
                    updated_at = ?,
                    revision = revision + 1
                WHERE
                    id = ?
                    AND revision = ?
            `)
            .run(now, reason, now, id, expected);
        if (result.changes !== 1) this.#throwRevision(id, expected);
        return toMailboxMessage(this.#getRow(id));
    }

    runMaintenance(): MaintenanceResult {
        const now = this.#storage.now();
        return this.#storage.connection.transaction(() => this.#runMaintenance(now)).immediate();
    }

    unresolvedRequired(recipientAgentIdValue: AgentId, limit = 100): readonly MailboxMessage[] {
        const recipientAgentId = parseAgentId(recipientAgentIdValue);
        const pageLimit = validatePageLimit(limit);
        this.#requireAgent(recipientAgentId);
        this.runMaintenance();
        const rows = this.#storage.connection
            .prepare(`
                SELECT
                    *
                FROM
                    mailbox_messages
                WHERE
                    recipient_agent_id = ?
                    AND required = 1
                    AND state IN ('queued', 'delivered', 'read')
                ORDER BY
                    sequence
                LIMIT
                    ?
            `)
            .all(recipientAgentId, pageLimit) as MessageRow[];
        return rows.map(toMailboxMessage);
    }

    listDeadLetters(input: ListNamespaceMessagesInput): MessagePage {
        const rootAgentId = parseAgentId(input.rootAgentId);
        const limit = validatePageLimit(input.limit);
        const cursor = decodeCursor(input.cursor, "messages");
        const conditions = ["root_agent_id = ?", "state = 'dead_letter'"];
        const parameters: unknown[] = [rootAgentId];
        if (cursor !== undefined) {
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

    stats(rootAgentIdValue: AgentId): MailboxStats {
        const rootAgentId = parseAgentId(rootAgentIdValue);
        const row = this.#storage.connection
            .prepare(`
                SELECT
                    SUM(
                        CASE
                            WHEN state = 'queued' THEN 1
                            ELSE 0
                        END
                    ) AS queued,
                    SUM(
                        CASE
                            WHEN state = 'delivered' THEN 1
                            ELSE 0
                        END
                    ) AS delivered,
                    SUM(
                        CASE
                            WHEN state = 'read' THEN 1
                            ELSE 0
                        END
                    ) AS read,
                    SUM(
                        CASE
                            WHEN state = 'acked' THEN 1
                            ELSE 0
                        END
                    ) AS acknowledged,
                    SUM(
                        CASE
                            WHEN state = 'dead_letter' THEN 1
                            ELSE 0
                        END
                    ) AS dead_lettered,
                    MIN(
                        CASE
                            WHEN state IN ('queued', 'delivered', 'read') THEN created_at
                        END
                    ) AS oldest_pending_at,
                    COALESCE(
                        SUM(
                            CASE
                                WHEN state IN ('queued', 'delivered', 'read') THEN length(CAST(content AS BLOB))
                                ELSE 0
                            END
                        ),
                        0
                    ) AS total_pending_bytes
                FROM
                    mailbox_messages
                WHERE
                    root_agent_id = ?
            `)
            .get(rootAgentId) as StatsRow;
        return {
            rootAgentId,
            queued: row.queued ?? 0,
            delivered: row.delivered ?? 0,
            read: row.read ?? 0,
            acknowledged: row.acknowledged ?? 0,
            deadLettered: row.dead_lettered ?? 0,
            ...(row.oldest_pending_at === null ? {} : { oldestPendingAt: row.oldest_pending_at }),
            totalPendingBytes: row.total_pending_bytes,
        };
    }

    prune(input: PruneMessagesInput): PruneMessagesResult {
        const retentionMs = validatePositiveInteger(
            input.retentionMs,
            "retentionMs",
            365 * 24 * 60 * 60 * 1000,
        );
        const idempotencyRetentionMs = validatePositiveInteger(
            input.idempotencyRetentionMs,
            "idempotencyRetentionMs",
            365 * 24 * 60 * 60 * 1000,
        );
        const limit = validatePageLimit(input.limit);
        const now = this.#storage.now();
        return this.#storage.connection
            .transaction(() => {
                const tombstonesExpired = this.#storage.connection
                    .prepare("DELETE FROM mailbox_idempotency_tombstones WHERE retained_until <= ?")
                    .run(now).changes;
                const rows = this.#storage.connection
                    .prepare(`
                        SELECT
                            *
                        FROM
                            mailbox_messages AS candidate
                        WHERE
                            candidate.kind != 'result'
                            AND candidate.state IN ('acked', 'dead_letter')
                            AND candidate.updated_at <= ?
                            AND NOT EXISTS (
                                SELECT
                                    1
                                FROM
                                    mailbox_messages AS reply
                                WHERE
                                    reply.reply_to_message_id = candidate.id
                            )
                        ORDER BY
                            candidate.sequence
                        LIMIT
                            ?
                    `)
                    .all(now - retentionMs, limit) as MessageRow[];
                let pruned = 0;
                for (const row of rows) {
                    if (row.idempotency_key !== null && row.intent_hash !== null) {
                        this.#storage.connection
                            .prepare(`
                                INSERT INTO
                                    mailbox_idempotency_tombstones (
                                        sender_scope,
                                        idempotency_key,
                                        intent_hash,
                                        message_id,
                                        retained_until,
                                        created_at
                                    )
                                VALUES
                                    (?, ?, ?, ?, ?, ?)
                                ON CONFLICT (sender_scope, idempotency_key) DO UPDATE
                                SET
                                    intent_hash = excluded.intent_hash,
                                    message_id = excluded.message_id,
                                    retained_until = MAX(retained_until, excluded.retained_until)
                            `)
                            .run(
                                row.sender_scope,
                                row.idempotency_key,
                                row.intent_hash,
                                row.id,
                                now + idempotencyRetentionMs,
                                now,
                            );
                    }
                    pruned += this.#storage.connection
                        .prepare("DELETE FROM mailbox_messages WHERE id = ?")
                        .run(row.id).changes;
                }
                return { pruned, tombstonesExpired };
            })
            .immediate();
    }

    #runMaintenance(now: number): MaintenanceResult {
        this.#storage.connection
            .prepare(`
                UPDATE mailbox_messages
                SET
                    state = 'dead_letter',
                    dead_lettered_at = ?,
                    dead_letter_reason = 'superseded_assignment',
                    lease_owner = NULL,
                    lease_expires_at = NULL,
                    updated_at = ?,
                    revision = revision + 1
                WHERE
                    state NOT IN ('acked', 'dead_letter')
                    AND (
                        recipient_run_id != (
                            SELECT
                                run_id
                            FROM
                                agents
                            WHERE
                                id = recipient_agent_id
                        )
                        OR (
                            sender_agent_id IS NOT NULL
                            AND sender_run_id != (
                                SELECT
                                    run_id
                                FROM
                                    agents
                                WHERE
                                    id = sender_agent_id
                            )
                        )
                    )
        `)
            .run(now, now);
        const expired = this.#storage.connection
            .prepare(`
                UPDATE mailbox_messages
                SET
                    state = 'dead_letter',
                    dead_lettered_at = ?,
                    dead_letter_reason = 'expired',
                    lease_owner = NULL,
                    lease_expires_at = NULL,
                    updated_at = ?,
                    revision = revision + 1
                WHERE
                    state NOT IN ('acked', 'dead_letter')
                    AND expires_at IS NOT NULL
                    AND expires_at <= ?
            `)
            .run(now, now, now).changes;
        const attemptsExhausted = this.#storage.connection
            .prepare(`
                UPDATE mailbox_messages
                SET
                    state = 'dead_letter',
                    dead_lettered_at = ?,
                    dead_letter_reason = 'delivery_attempts_exhausted',
                    lease_owner = NULL,
                    lease_expires_at = NULL,
                    updated_at = ?,
                    revision = revision + 1
                WHERE
                    state IN ('delivered', 'read')
                    AND lease_expires_at <= ?
                    AND attempt_count >= max_attempts
            `)
            .run(now, now, now).changes;
        const requeued = this.#storage.connection
            .prepare(`
                UPDATE mailbox_messages
                SET
                    state = 'queued',
                    delivered_at = NULL,
                    read_at = NULL,
                    lease_owner = NULL,
                    lease_expires_at = NULL,
                    updated_at = ?,
                    revision = revision + 1
                WHERE
                    state IN ('delivered', 'read')
                    AND lease_expires_at <= ?
                    AND attempt_count < max_attempts
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
        this.#storage.hit(`mailbox.${to}.before_update`, { messageId: id });
        const leaseSql = releaseLease ? ", lease_owner = NULL, lease_expires_at = NULL" : "";
        const result = this.#storage.connection
            .prepare(`
                UPDATE mailbox_messages
                SET state = ?, ${timestampColumn} = ?, updated_at = ?, revision = revision + 1${leaseSql}
                WHERE id = ? AND revision = ? AND state = ?
            `)
            .run(to, now, now, id, expected, from);
        if (result.changes !== 1) this.#throwRevision(id, expected);
        this.#storage.hit(`mailbox.${to}.after_update`, { messageId: id });
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
        this.#assertAssignment(row);
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

    #assertAssignment(row: MessageRow): void {
        if (
            this.#requireAgent(row.recipient_agent_id as AgentId).run_id !== row.recipient_run_id ||
            (row.sender_agent_id !== null &&
                this.#requireAgent(row.sender_agent_id as AgentId).run_id !== row.sender_run_id)
        ) {
            throw new ValidationError("Message belongs to a superseded assignment");
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

    #findTombstone(scope: string, key: string, now: number): TombstoneRow | undefined {
        return this.#storage.connection
            .prepare(`
                SELECT intent_hash, message_id
                FROM mailbox_idempotency_tombstones
                WHERE sender_scope = ? AND idempotency_key = ? AND retained_until > ?
            `)
            .get(scope, key, now) as TombstoneRow | undefined;
    }

    #assertQueueCapacity(
        senderScope: string,
        recipientAgentId: AgentId,
        threadId: string,
        kind: string,
    ): void {
        const lane =
            kind === "control"
                ? "kind = 'control'"
                : kind === "result"
                  ? "kind = 'result'"
                  : "kind NOT IN ('control','result')";
        const active = `state IN ('queued','delivered','read') AND ${lane}`;
        const senderCount = this.#storage.connection
            .prepare(
                `SELECT COUNT(*) AS count FROM mailbox_messages WHERE sender_scope = ? AND ${active}`,
            )
            .get(senderScope) as { count: number };
        if (senderCount.count >= MAILBOX_QUEUE_LIMITS.perSender) {
            throw new ValidationError("Sender mailbox quota exceeded", { senderScope });
        }
        const recipientCount = this.#storage.connection
            .prepare(
                `SELECT COUNT(*) AS count FROM mailbox_messages WHERE recipient_agent_id = ? AND ${active}`,
            )
            .get(recipientAgentId) as { count: number };
        if (recipientCount.count >= MAILBOX_QUEUE_LIMITS.perRecipient) {
            throw new ValidationError("Recipient mailbox quota exceeded", { recipientAgentId });
        }
        const threadCount = this.#storage.connection
            .prepare(
                `SELECT COUNT(*) AS count FROM mailbox_messages WHERE thread_id = ? AND ${active}`,
            )
            .get(threadId) as { count: number };
        if (threadCount.count >= MAILBOX_QUEUE_LIMITS.perThread) {
            throw new ValidationError("Message thread quota exceeded", { threadId });
        }
    }

    #isAncestor(candidateValue: AgentId, descendantValue: AgentId): boolean {
        const candidate = parseAgentId(candidateValue);
        const descendant = parseAgentId(descendantValue);
        const row = this.#storage.connection
            .prepare(`
                WITH RECURSIVE
                    ancestors (id) AS (
                        SELECT
                            parent_agent_id
                        FROM
                            agents
                        WHERE
                            id = ?
                        UNION ALL
                        SELECT
                            agents.parent_agent_id
                        FROM
                            agents
                            JOIN ancestors ON agents.id = ancestors.id
                        WHERE
                            agents.parent_agent_id IS NOT NULL
                    )
                SELECT
                    1
                FROM
                    ancestors
                WHERE
                    id = ?
                LIMIT
                    1
            `)
            .get(descendant, candidate);
        return row !== undefined;
    }

    #requireAgent(agentId: AgentId): AgentNamespaceRow {
        const row = this.#storage.connection
            .prepare("SELECT id, run_id, parent_agent_id, root_agent_id FROM agents WHERE id = ?")
            .get(agentId) as AgentNamespaceRow | undefined;
        if (!row) throw new NotFoundError("agent", agentId);
        return row;
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
