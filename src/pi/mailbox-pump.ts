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
}

export interface MailboxPumpOptions {
    readonly store: MailboxPumpStore;
    readonly recipientAgentId: AgentId;
    readonly leaseMs: number;
    readonly pollMs: number;
    readonly batchSize: number;
    readonly dispatch: (message: MailboxMessage) => Promise<MailboxDisposition>;
    readonly owner?: string;
    readonly now?: () => number;
    readonly onError?: (error: unknown) => void;
}

/**
 * Single-flight, at-least-once mailbox consumer. A message is advanced only
 * after the process-local dispatcher accepts it; failed dispatches are put
 * back with bounded exponential backoff.
 */
export class MailboxPump {
    readonly #store: MailboxPumpStore;
    readonly #recipientAgentId: AgentId;
    readonly #leaseMs: number;
    readonly #heartbeatMs: number;
    readonly #batchSize: number;
    readonly #dispatch: (message: MailboxMessage) => Promise<MailboxDisposition>;
    readonly #now: () => number;
    readonly #onError: (error: unknown) => void;
    readonly owner: string;
    #timer: NodeJS.Timeout | undefined;
    #inFlight: Promise<void> | undefined;
    readonly #readLeases = new Set<MessageId>();
    #stopped = true;

    constructor(options: MailboxPumpOptions) {
        this.#store = options.store;
        this.#recipientAgentId = options.recipientAgentId;
        this.#leaseMs = options.leaseMs;
        this.#heartbeatMs = Math.min(
            options.pollMs,
            Math.max(100, Math.floor(options.leaseMs / 3)),
        );
        this.#batchSize = options.batchSize;
        this.#dispatch = options.dispatch;
        this.#now = options.now ?? Date.now;
        this.#onError = options.onError ?? (() => undefined);
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

    async #poll(): Promise<void> {
        this.#renewReadLeases();
        const messages = this.#store.claimMessages({
            recipientAgentId: this.#recipientAgentId,
            owner: this.owner,
            leaseMs: this.#leaseMs,
            limit: this.#batchSize,
        });
        for (const message of messages) {
            // Mailbox sequence is causal: later messages must not overtake earlier ones.
            // eslint-disable-next-line no-await-in-loop
            await this.#deliver(message);
        }
    }

    async #deliver(message: MailboxMessage): Promise<void> {
        let latest = message;
        try {
            const disposition = await this.#dispatch(message);
            latest = this.#store.markMessageRead({
                messageId: message.id,
                recipientAgentId: this.#recipientAgentId,
                owner: this.owner,
                expectedRevision: message.revision,
            });
            if (disposition === "ack") {
                this.#store.acknowledgeMessage({
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
        }
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
}

function retryDelay(attempt: number): number {
    return Math.min(30_000, 250 * 2 ** Math.max(0, attempt - 1));
}

function errorMessage(error: unknown): string {
    const value = error instanceof Error ? error.message : String(error);
    return value.length <= 512 ? value : value.slice(0, 512);
}
