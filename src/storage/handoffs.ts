import { randomUUID } from "node:crypto";
import { ValidationError } from "../domain/errors.ts";
import type { MessageId } from "../domain/ids.ts";
import type { StorageDatabase } from "./database.ts";
import type { ExecutionLease } from "./executions.ts";

export interface PiHandoff {
    readonly token: string;
    readonly epoch: number;
    readonly observed: boolean;
    readonly created: boolean;
}

interface HandoffRow {
    token: string;
    epoch: number;
    observed_at: number | null;
    mailbox_owner: string;
}

/** Called only within the store facade's execution-fenced write transaction. */
export class HandoffRepository {
    readonly #storage: StorageDatabase;
    constructor(storage: StorageDatabase) {
        this.#storage = storage;
    }

    begin(messageId: MessageId, mailboxOwner: string, execution: ExecutionLease): PiHandoff {
        this.#assertRecipient(messageId, mailboxOwner, execution);
        const old = this.#storage.connection
            .prepare(
                "SELECT token, epoch, observed_at, mailbox_owner FROM mailbox_pi_handoffs WHERE message_id = ?",
            )
            .get(messageId) as HandoffRow | undefined;
        if (old?.epoch === execution.epoch) {
            if (old.mailbox_owner !== mailboxOwner)
                throw new ValidationError(
                    "Pi handoff mailbox owner changed; restart the execution before reinjection",
                );
            return {
                token: old.token,
                epoch: old.epoch,
                observed: old.observed_at !== null,
                created: false,
            };
        }
        const token = randomUUID();
        this.#storage.connection
            .prepare(`
            INSERT INTO mailbox_pi_handoffs(message_id, agent_id, epoch, token, mailbox_owner, submitted_at, observed_at)
            VALUES (?, ?, ?, ?, ?, ?, NULL)
            ON CONFLICT(message_id) DO UPDATE SET epoch = excluded.epoch, token = excluded.token,
                mailbox_owner = excluded.mailbox_owner, submitted_at = excluded.submitted_at, observed_at = NULL
        `)
            .run(
                messageId,
                execution.agentId,
                execution.epoch,
                token,
                mailboxOwner,
                this.#storage.now(),
            );
        this.#storage.connection
            .prepare(`
            UPDATE completion_outbox SET state = 'invalidated', updated_at = ?, revision = revision + 1
            WHERE agent_id = ? AND state = 'declared'
        `)
            .run(this.#storage.now(), execution.agentId);
        return { token, epoch: execution.epoch, observed: false, created: true };
    }

    observe(messageId: MessageId, token: string, execution: ExecutionLease): boolean {
        // Old context entries (including prior epochs) are not new delivery evidence.
        const match = this.#storage.connection
            .prepare(`
            SELECT mailbox_owner FROM mailbox_pi_handoffs WHERE message_id = ? AND agent_id = ?
                AND epoch = ? AND token = ? AND observed_at IS NULL
        `)
            .get(messageId, execution.agentId, execution.epoch, token) as
            | { mailbox_owner: string }
            | undefined;
        if (!match) return false;
        this.#assertRecipient(messageId, match.mailbox_owner, execution);
        this.#storage.connection
            .prepare(`
            UPDATE mailbox_pi_handoffs SET observed_at = ? WHERE message_id = ? AND token = ?
        `)
            .run(this.#storage.now(), messageId, token);
        return true;
    }

    assertObserved(messageId: MessageId, execution: ExecutionLease): void {
        const row = this.#storage.connection
            .prepare(`
            SELECT observed_at, epoch FROM mailbox_pi_handoffs WHERE message_id = ? AND agent_id = ?
        `)
            .get(messageId, execution.agentId) as
            | Pick<HandoffRow, "observed_at" | "epoch">
            | undefined;
        if (row && (row.epoch !== execution.epoch || row.observed_at === null)) {
            throw new ValidationError(
                "Pi mailbox handoff has not been observed in the current execution context",
            );
        }
    }

    assertSettled(execution: ExecutionLease): void {
        const row = this.#storage.connection
            .prepare(`
            SELECT h.message_id FROM mailbox_pi_handoffs h
            JOIN mailbox_messages m ON m.id = h.message_id
            WHERE h.agent_id = ? AND m.recipient_run_id = ? AND h.observed_at IS NULL LIMIT 1
        `)
            .get(execution.agentId, execution.runId);
        if (row)
            throw new ValidationError(
                "Cannot complete while a Pi mailbox handoff awaits context observation",
            );
    }

    #assertRecipient(messageId: MessageId, mailboxOwner: string, execution: ExecutionLease): void {
        const row = this.#storage.connection
            .prepare(`
            SELECT 1 FROM mailbox_messages WHERE id = ? AND recipient_agent_id = ?
                AND recipient_run_id = ? AND lease_owner = ? AND state IN ('delivered', 'read') AND lease_expires_at > ?
        `)
            .get(messageId, execution.agentId, execution.runId, mailboxOwner, this.#storage.now());
        if (!row)
            throw new ValidationError("Pi handoff requires live recipient delivery ownership");
    }
}
