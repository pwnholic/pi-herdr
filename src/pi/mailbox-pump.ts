import { randomUUID } from "node:crypto";
import type { AgentId, MessageId } from "../domain/ids.ts";
import type { MailboxMessage } from "../domain/mailbox.ts";
import type { SqliteControlPlaneStore } from "../storage/index.ts";

export type MailboxDisposition = "read" | "ack";

export interface MailboxPumpStore {
    getMessage(
        messageId: Parameters<SqliteControlPlaneStore["getMessage"]>[0],
    ): ReturnType<SqliteControlPlaneStore["getMessage"]>;
    claimMessages(
        input: Parameters<SqliteControlPlaneStore["claimMessages"]>[0],
    ): ReturnType<SqliteControlPlaneStore["claimMessages"]>;
    markMessageRead(
        input: Parameters<SqliteControlPlaneStore["markMessageRead"]>[0],
    ): ReturnType<SqliteControlPlaneStore["markMessageRead"]>;
    acknowledgeMessage(
        input: Parameters<SqliteControlPlaneStore["acknowledgeMessage"]>[0],
    ): ReturnType<SqliteControlPlaneStore["acknowledgeMessage"]>;
    renewMessageLease(
        input: Parameters<SqliteControlPlaneStore["renewMessageLease"]>[0],
    ): ReturnType<SqliteControlPlaneStore["renewMessageLease"]>;
    retryMessage(
        input: Parameters<SqliteControlPlaneStore["retryMessage"]>[0],
    ): ReturnType<SqliteControlPlaneStore["retryMessage"]>;
    pruneMailbox?: SqliteControlPlaneStore["pruneMailbox"];
}

export interface MailboxPumpOptions {
    readonly store: MailboxPumpStore;
    readonly recipientAgentId: AgentId;
    readonly recipientRunId?: string;
    readonly leaseMs: number;
    readonly pollMs: number;
    readonly batchSize: number;
    readonly dispatch: (message: MailboxMessage) => Promise<MailboxDisposition>;
    readonly owner?: string;
    readonly now?: () => number;
    readonly onError?: (error: unknown) => void;
    readonly onAcknowledged?: (
        original: MailboxMessage,
        acknowledged: MailboxMessage,
    ) => Promise<void> | void;
    readonly maxDeliveryBytes?: number;
    readonly retentionMs?: number;
    readonly idempotencyRetentionMs?: number;
}

/**
 * Single-flight, at-least-once mailbox consumer. A message is advanced only
 * after the process-local dispatcher accepts it; failed dispatches are put
 * back with bounded exponential backoff.
 */
export class MailboxPump {
    readonly #store: MailboxPumpStore;
    readonly #recipientAgentId: AgentId;
    readonly #recipientRunId: string | undefined;
    readonly #leaseMs: number;
    readonly #heartbeatMs: number;
    readonly #batchSize: number;
    readonly #dispatch: (message: MailboxMessage) => Promise<MailboxDisposition>;
    readonly #now: () => number;
    readonly #onError: (error: unknown) => void;
    readonly #onAcknowledged:
        | ((original: MailboxMessage, acknowledged: MailboxMessage) => Promise<void> | void)
        | undefined;
    readonly #maxDeliveryBytes: number;
    readonly #retentionMs: number | undefined;
    readonly #idempotencyRetentionMs: number | undefined;
    readonly owner: string;
    #timer: NodeJS.Timeout | undefined;
    #inFlight: Promise<void> | undefined;
    readonly #readLeases = new Set<MessageId>();
    #stopped = true;
    #lastPruneAt: number | undefined;
    #laneIndex = 0;

    constructor(options: MailboxPumpOptions) {
        this.#store = options.store;
        this.#recipientAgentId = options.recipientAgentId;
        this.#recipientRunId = options.recipientRunId;
        this.#leaseMs = options.leaseMs;
        this.#heartbeatMs = Math.min(
            options.pollMs,
            Math.max(100, Math.floor(options.leaseMs / 3)),
        );
        this.#batchSize = options.batchSize;
        this.#dispatch = options.dispatch;
        this.#now = options.now ?? Date.now;
        this.#onError = options.onError ?? (() => undefined);
        this.#onAcknowledged = options.onAcknowledged;
        this.#maxDeliveryBytes = options.maxDeliveryBytes ?? Number.POSITIVE_INFINITY;
        this.#retentionMs = options.retentionMs;
        this.#idempotencyRetentionMs = options.idempotencyRetentionMs;
        this.owner = options.owner ?? `pi:${process.pid}:${randomUUID()}`;
    }

    start(): void {
        if (!this.#stopped) return;
        this.#stopped = false;
        this.#schedule(0);
    }

    async stop(): Promise<void> {
        if (this.#stopped) return;
        this.#stopped = true;
        if (this.#timer !== undefined) clearTimeout(this.#timer);
        this.#timer = undefined;
        await this.#inFlight;
        this.#readLeases.clear();
    }

    async pollNow(): Promise<void> {
        if (this.#inFlight !== undefined) return this.#inFlight;
        const operation = this.#poll().finally(() => {
            if (this.#inFlight === operation) this.#inFlight = undefined;
        });
        this.#inFlight = operation;
        return operation;
    }

    async pollMessage(messageId: MessageId): Promise<void> {
        if (this.#inFlight !== undefined) await this.#inFlight;
        const operation = this.#poll(messageId).finally(() => {
            if (this.#inFlight === operation) this.#inFlight = undefined;
        });
        this.#inFlight = operation;
        return operation;
    }

    #schedule(delay: number): void {
        if (this.#stopped) return;
        this.#timer = setTimeout(() => {
            this.#timer = undefined;
            void this.pollNow()
                .catch(this.#onError)
                .finally(() => this.#schedule(this.#heartbeatMs));
        }, delay);
        this.#timer.unref();
    }

    async #poll(messageId?: MessageId): Promise<void> {
        this.#renewReadLeases();
        this.#pruneIfDue();
        const maximum = messageId === undefined ? this.#batchSize : 1;
        let deliveredBytes = 0;
        for (let index = 0; index < maximum; index += 1) {
            const [message] = this.#store.claimMessages({
                recipientAgentId: this.#recipientAgentId,
                ...(this.#recipientRunId === undefined
                    ? {}
                    : { recipientRunId: this.#recipientRunId }),
                owner: this.owner,
                leaseMs: this.#leaseMs,
                limit: 1,
                preferredLane: (["control", "result", "ordinary"] as const)[this.#laneIndex]!,
                ...(messageId === undefined ? {} : { messageId }),
            });
            if (message === undefined) return;
            this.#laneIndex = (this.#laneIndex + 1) % 3;
            // Claim immediately before dispatch so a slow earlier delivery cannot expire
            // leases for payloads that have not been presented to Pi yet.
            // eslint-disable-next-line no-await-in-loop
            if (!(await this.#deliver(message))) return;
            deliveredBytes += Buffer.byteLength(message.content, "utf8");
            if (deliveredBytes >= this.#maxDeliveryBytes) break;
        }
    }

    async #deliver(message: MailboxMessage): Promise<boolean> {
        let latest = message;
        let heartbeatError: unknown;
        let acknowledged: MailboxMessage | undefined;
        const heartbeat = setInterval(
            () => {
                if (heartbeatError !== undefined) return;
                try {
                    latest = this.#store.renewMessageLease({
                        messageId: latest.id,
                        recipientAgentId: this.#recipientAgentId,
                        owner: this.owner,
                        expectedRevision: latest.revision,
                        leaseMs: this.#leaseMs,
                    });
                } catch (error) {
                    heartbeatError = error;
                }
            },
            Math.max(10, Math.floor(this.#leaseMs / 3)),
        );
        heartbeat.unref();
        try {
            const disposition = await this.#dispatch(message);
            if (heartbeatError !== undefined) throw heartbeatError;
            latest = this.#store.markMessageRead({
                messageId: latest.id,
                recipientAgentId: this.#recipientAgentId,
                owner: this.owner,
                expectedRevision: latest.revision,
            });
            if (disposition === "ack") {
                acknowledged = this.#store.acknowledgeMessage({
                    messageId: latest.id,
                    recipientAgentId: this.#recipientAgentId,
                    owner: this.owner,
                    expectedRevision: latest.revision,
                });
            } else {
                this.#readLeases.add(latest.id);
            }
        } catch (error) {
            try {
                this.#store.retryMessage({
                    messageId: latest.id,
                    recipientAgentId: this.#recipientAgentId,
                    owner: this.owner,
                    expectedRevision: latest.revision,
                    availableAt: this.#now() + retryDelay(message.attemptCount),
                    reason: errorMessage(error),
                });
            } catch (retryError) {
                this.#onError(retryError);
            }
            this.#onError(error);
            return false;
        } finally {
            clearInterval(heartbeat);
        }
        if (acknowledged !== undefined && this.#onAcknowledged !== undefined) {
            try {
                await this.#onAcknowledged(message, acknowledged);
            } catch (error) {
                this.#onError(error);
            }
        }
        return true;
    }

    #renewReadLeases(): void {
        const now = this.#now();
        for (const messageId of this.#readLeases) {
            const current = this.#store.getMessage(messageId);
            if (
                current.state !== "read" ||
                current.leaseOwner !== this.owner ||
                current.leaseExpiresAt === undefined ||
                current.leaseExpiresAt <= now
            ) {
                this.#readLeases.delete(messageId);
                continue;
            }
            const renewalWindow = Math.max(this.#heartbeatMs * 2, Math.floor(this.#leaseMs / 3));
            if (current.leaseExpiresAt > now + renewalWindow) continue;
            this.#store.renewMessageLease({
                messageId,
                recipientAgentId: this.#recipientAgentId,
                owner: this.owner,
                expectedRevision: current.revision,
                leaseMs: this.#leaseMs,
            });
        }
    }

    #pruneIfDue(): void {
        if (
            this.#store.pruneMailbox === undefined ||
            this.#retentionMs === undefined ||
            this.#idempotencyRetentionMs === undefined
        ) {
            return;
        }
        const now = this.#now();
        const interval = Math.min(this.#retentionMs, 60 * 60 * 1000);
        if (this.#lastPruneAt !== undefined && now - this.#lastPruneAt < interval) return;
        this.#store.pruneMailbox({
            retentionMs: this.#retentionMs,
            idempotencyRetentionMs: this.#idempotencyRetentionMs,
            limit: this.#batchSize,
        });
        this.#lastPruneAt = now;
    }
}

function retryDelay(attempt: number): number {
    return Math.min(30_000, 250 * 2 ** Math.max(0, attempt - 1));
}

function errorMessage(error: unknown): string {
    const value = error instanceof Error ? error.message : String(error);
    return value.length <= 512 ? value : value.slice(0, 512);
}
