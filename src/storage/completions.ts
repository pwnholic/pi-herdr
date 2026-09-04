import {
    ConflictError,
    InvalidTransitionError,
    RevisionConflictError,
    ValidationError,
} from "../domain/errors.ts";
import type { AgentId, MessageId } from "../domain/ids.ts";
import { parseAgentId, parseMessageId } from "../domain/ids.ts";
import { assertJsonValue, type JsonValue, validateLabel } from "../domain/validation.ts";
import type { StorageDatabase } from "./database.ts";
import { canonicalJson, parseStoredJson } from "./json.ts";

export type CompletionOutboxState =
    | "declared"
    | "emitted"
    | "parent_applied"
    | "acknowledged"
    | "invalidated";

export interface CompletionOutboxRecord {
    readonly agentId: AgentId;
    readonly invocationToken: string;
    readonly payload: JsonValue;
    readonly state: CompletionOutboxState;
    readonly messageId?: MessageId;
    readonly createdAt: number;
    readonly updatedAt: number;
    readonly revision: number;
}

interface CompletionRow {
    readonly agent_id: string;
    readonly invocation_token: string;
    readonly payload_json: string;
    readonly state: CompletionOutboxState;
    readonly message_id: string | null;
    readonly created_at: number;
    readonly updated_at: number;
    readonly revision: number;
}

export interface DeclareCompletionInput {
    readonly agentId: AgentId;
    readonly invocationToken: string;
    readonly payload: JsonValue;
}

export type MailboxEffectState = "applying" | "applied" | "notified";
export interface MailboxEffectRecord {
    readonly messageId: MessageId;
    readonly effect: string;
    readonly state: MailboxEffectState;
    readonly revision: number;
}

interface EffectRow {
    readonly message_id: string;
    readonly effect: string;
    readonly state: MailboxEffectState;
    readonly revision: number;
}

export class CompletionRepository {
    readonly #storage: StorageDatabase;

    constructor(storage: StorageDatabase) {
        this.#storage = storage;
    }

    get(agentId: AgentId): CompletionOutboxRecord | undefined {
        const id = parseAgentId(agentId);
        const row = this.#storage.connection
            .prepare("SELECT * FROM completion_outbox WHERE agent_id = ?")
            .get(id) as CompletionRow | undefined;
        return row === undefined ? undefined : toCompletion(row);
    }

    declare(input: DeclareCompletionInput): CompletionOutboxRecord {
        const agentId = parseAgentId(input.agentId);
        const invocationToken = validateLabel(input.invocationToken, "invocationToken", 256);
        assertJsonValue(input.payload, "payload");
        const payloadJson = canonicalJson(input.payload);
        const now = this.#storage.now();
        return this.#storage.connection
            .transaction(() => {
                this.#storage.hit("completion.declare.before_write", { agentId });
                const current = this.get(agentId);
                if (current !== undefined) {
                    const same =
                        current.invocationToken === invocationToken &&
                        canonicalJson(current.payload) === payloadJson;
                    if (same && current.state !== "invalidated") return current;
                    if (current.state !== "acknowledged" && current.state !== "invalidated") {
                        throw new ConflictError(
                            "A different completion is already pending for this agent",
                            { agentId, state: current.state },
                        );
                    }
                    const result = this.#storage.connection
                        .prepare(`
                            UPDATE completion_outbox
                            SET invocation_token = ?, payload_json = ?, state = 'declared',
                                message_id = NULL, updated_at = ?, revision = revision + 1
                            WHERE agent_id = ? AND revision = ?
                        `)
                        .run(invocationToken, payloadJson, now, agentId, current.revision);
                    if (result.changes !== 1) {
                        throw new RevisionConflictError(
                            "completion",
                            agentId,
                            current.revision,
                            this.get(agentId)?.revision ?? current.revision,
                        );
                    }
                    const declared = this.get(agentId) as CompletionOutboxRecord;
                    this.#storage.hit("completion.declare.after_write", { agentId });
                    return declared;
                }
                this.#storage.connection
                    .prepare(`
                        INSERT INTO completion_outbox(
                            agent_id, invocation_token, payload_json, state, message_id,
                            created_at, updated_at, revision
                        ) VALUES (?, ?, ?, 'declared', NULL, ?, ?, 0)
                    `)
                    .run(agentId, invocationToken, payloadJson, now, now);
                const declared = this.get(agentId) as CompletionOutboxRecord;
                this.#storage.hit("completion.declare.after_write", { agentId });
                return declared;
            })
            .immediate();
    }

    markEmitted(
        agentIdValue: AgentId,
        invocationTokenValue: string,
        messageIdValue: MessageId,
    ): CompletionOutboxRecord {
        const agentId = parseAgentId(agentIdValue);
        const invocationToken = validateLabel(invocationTokenValue, "invocationToken", 256);
        const messageId = parseMessageId(messageIdValue);
        const current = this.#require(agentId);
        if (
            current.state === "emitted" &&
            current.invocationToken === invocationToken &&
            current.messageId === messageId
        ) {
            return current;
        }
        if (current.state !== "declared" || current.invocationToken !== invocationToken) {
            throw new InvalidTransitionError("completion", agentId, current.state, "emitted");
        }
        return this.#transition(current, "emitted", messageId);
    }

    markParentApplied(agentIdValue: AgentId, invocationTokenValue: string): CompletionOutboxRecord {
        const agentId = parseAgentId(agentIdValue);
        const token = validateLabel(invocationTokenValue, "invocationToken", 256);
        const current = this.#require(agentId);
        if (current.state === "parent_applied" && current.invocationToken === token) return current;
        if (current.state !== "emitted" || current.invocationToken !== token) {
            throw new InvalidTransitionError(
                "completion",
                agentId,
                current.state,
                "parent_applied",
            );
        }
        return this.#transition(current, "parent_applied", current.messageId);
    }

    markAcknowledged(
        agentIdValue: AgentId,
        invocationTokenValue: string,
        messageIdValue: MessageId,
    ): CompletionOutboxRecord {
        const agentId = parseAgentId(agentIdValue);
        const token = validateLabel(invocationTokenValue, "invocationToken", 256);
        const messageId = parseMessageId(messageIdValue);
        const current = this.#require(agentId);
        if (
            current.state === "acknowledged" &&
            current.invocationToken === token &&
            current.messageId === messageId
        ) {
            return current;
        }
        if (
            current.state !== "parent_applied" ||
            current.invocationToken !== token ||
            current.messageId !== messageId
        ) {
            throw new InvalidTransitionError("completion", agentId, current.state, "acknowledged");
        }
        return this.#transition(current, "acknowledged", messageId);
    }

    invalidate(agentIdValue: AgentId, invocationTokenValue: string): CompletionOutboxRecord {
        const agentId = parseAgentId(agentIdValue);
        const token = validateLabel(invocationTokenValue, "invocationToken", 256);
        const current = this.#require(agentId);
        if (current.state === "invalidated" && current.invocationToken === token) return current;
        if (current.state !== "declared" || current.invocationToken !== token) {
            throw new InvalidTransitionError("completion", agentId, current.state, "invalidated");
        }
        return this.#transition(current, "invalidated", undefined);
    }

    listPendingForParent(parentAgentIdValue: AgentId): readonly CompletionOutboxRecord[] {
        const parentAgentId = parseAgentId(parentAgentIdValue);
        const rows = this.#storage.connection
            .prepare(`
                SELECT completion_outbox.*
                FROM completion_outbox
                JOIN agents ON agents.id = completion_outbox.agent_id
                WHERE agents.parent_agent_id = ?
                  AND completion_outbox.state IN ('emitted','parent_applied')
                ORDER BY completion_outbox.created_at, completion_outbox.agent_id
            `)
            .all(parentAgentId) as CompletionRow[];
        return rows.map(toCompletion);
    }

    beginEffect(messageIdValue: MessageId, effectValue: string): MailboxEffectRecord {
        const messageId = parseMessageId(messageIdValue);
        const effect = validateLabel(effectValue, "effect", 128);
        const now = this.#storage.now();
        this.#storage.connection
            .prepare(`
                INSERT INTO mailbox_effects(message_id, effect, state, created_at, updated_at, revision)
                VALUES (?, ?, 'applying', ?, ?, 0)
                ON CONFLICT(message_id) DO NOTHING
            `)
            .run(messageId, effect, now, now);
        const current = this.#requireEffect(messageId);
        if (current.effect !== effect) {
            throw new ConflictError("Mailbox message is already bound to another effect", {
                messageId,
                existing: current.effect,
                requested: effect,
            });
        }
        return current;
    }

    advanceEffect(messageIdValue: MessageId, state: MailboxEffectState): MailboxEffectRecord {
        const messageId = parseMessageId(messageIdValue);
        const current = this.#requireEffect(messageId);
        const rank: Readonly<Record<MailboxEffectState, number>> = {
            applying: 0,
            applied: 1,
            notified: 2,
        };
        if (rank[current.state] >= rank[state]) return current;
        if (rank[state] !== rank[current.state] + 1) {
            throw new InvalidTransitionError("mailbox_effect", messageId, current.state, state);
        }
        const now = this.#storage.now();
        const result = this.#storage.connection
            .prepare(`
                UPDATE mailbox_effects
                SET state = ?, updated_at = ?, revision = revision + 1
                WHERE message_id = ? AND revision = ?
            `)
            .run(state, now, messageId, current.revision);
        if (result.changes !== 1) {
            const actual = this.#requireEffect(messageId);
            throw new RevisionConflictError(
                "mailbox_effect",
                messageId,
                current.revision,
                actual.revision,
            );
        }
        return this.#requireEffect(messageId);
    }

    #transition(
        current: CompletionOutboxRecord,
        state: CompletionOutboxState,
        messageId: MessageId | undefined,
    ): CompletionOutboxRecord {
        const now = this.#storage.now();
        const result = this.#storage.connection
            .prepare(`
                UPDATE completion_outbox
                SET state = ?, message_id = ?, updated_at = ?, revision = revision + 1
                WHERE agent_id = ? AND revision = ?
            `)
            .run(state, messageId ?? null, now, current.agentId, current.revision);
        if (result.changes !== 1) {
            throw new RevisionConflictError(
                "completion",
                current.agentId,
                current.revision,
                this.get(current.agentId)?.revision ?? current.revision,
            );
        }
        return this.#require(current.agentId);
    }

    #require(agentId: AgentId): CompletionOutboxRecord {
        const record = this.get(agentId);
        if (record === undefined) {
            throw new ValidationError("Completion declaration does not exist", { agentId });
        }
        return record;
    }

    #requireEffect(messageId: MessageId): MailboxEffectRecord {
        const row = this.#storage.connection
            .prepare(
                "SELECT message_id, effect, state, revision FROM mailbox_effects WHERE message_id = ?",
            )
            .get(messageId) as EffectRow | undefined;
        if (row === undefined) {
            throw new ValidationError("Mailbox effect does not exist", { messageId });
        }
        return {
            messageId: row.message_id as MessageId,
            effect: row.effect,
            state: row.state,
            revision: row.revision,
        };
    }
}

function toCompletion(row: CompletionRow): CompletionOutboxRecord {
    return {
        agentId: row.agent_id as AgentId,
        invocationToken: row.invocation_token,
        payload: parseStoredJson(row.payload_json),
        state: row.state,
        ...(row.message_id === null ? {} : { messageId: row.message_id as MessageId }),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        revision: row.revision,
    };
}
