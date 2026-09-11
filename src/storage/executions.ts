import { LeaseConflictError, ValidationError } from "../domain/errors.ts";
import { type AgentId, parseAgentId } from "../domain/ids.ts";
import { validateLabel, validatePositiveInteger } from "../domain/validation.ts";
import type { StorageDatabase } from "./database.ts";

export interface AcquireExecutionInput {
    readonly agentId: AgentId;
    readonly runId: string;
    readonly sessionId: string;
    readonly owner: string;
    readonly leaseMs: number;
}

export interface ExecutionLease {
    readonly agentId: AgentId;
    readonly runId: string;
    readonly sessionId: string;
    readonly epoch: number;
    readonly owner: string;
    readonly expiresAt: number;
}

interface ExecutionRow {
    agent_id: string;
    run_id: string;
    session_id: string;
    epoch: number;
    owner: string | null;
    expires_at: number | null;
}

/** One immutable execution identity per store connection; release cannot unbind it. */
export class ExecutionRepository {
    readonly #storage: StorageDatabase;
    #lease: ExecutionLease | undefined;

    constructor(storage: StorageDatabase) {
        this.#storage = storage;
    }

    get lease(): ExecutionLease | undefined {
        return this.#lease === undefined ? undefined : { ...this.#lease };
    }

    acquire(input: AcquireExecutionInput): ExecutionLease {
        if (this.#lease !== undefined) {
            throw new ValidationError(
                "Execution is already bound; use a new store for a new owner",
            );
        }
        const agentId = parseAgentId(input.agentId);
        const runId = validateLabel(input.runId, "runId", 256);
        const sessionId = validateLabel(input.sessionId, "sessionId", 256);
        const owner = validateLabel(input.owner, "owner", 256);
        const leaseMs = validatePositiveInteger(input.leaseMs, "leaseMs", 3_600_000);
        const lease = this.#storage.connection
            .transaction(() => {
                const now = this.#storage.now();
                this.#assertAssignment(agentId, runId, sessionId);
                const old = this.#row(agentId);
                if (
                    old?.run_id === runId &&
                    old.session_id === sessionId &&
                    old.owner !== null &&
                    old.expires_at !== null &&
                    old.expires_at > now
                ) {
                    throw new LeaseConflictError("execution", agentId, old.owner);
                }
                const epoch = (old?.epoch ?? 0) + 1;
                if (!Number.isSafeInteger(epoch))
                    throw new ValidationError("Execution epoch exhausted");
                const expiresAt = now + leaseMs;
                this.#storage.connection
                    .prepare(`
                INSERT INTO agent_executions(agent_id, run_id, session_id, epoch, owner, expires_at)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(agent_id) DO UPDATE SET run_id = excluded.run_id,
                    session_id = excluded.session_id, epoch = excluded.epoch,
                    owner = excluded.owner, expires_at = excluded.expires_at
            `)
                    .run(agentId, runId, sessionId, epoch, owner, expiresAt);
                // A draft is not a published result. A replacement execution must
                // reconsider it; emitted results retain their original delivery identity.
                this.#storage.connection
                    .prepare(`
                UPDATE completion_outbox SET state = 'invalidated', updated_at = ?,
                    revision = revision + 1 WHERE agent_id = ? AND state = 'declared'
            `)
                    .run(now, agentId);
                this.#storage.hit("execution.acquire.before_commit", { agentId, epoch });
                return { agentId, runId, sessionId, epoch, owner, expiresAt };
            })
            .immediate();
        this.#lease = Object.freeze(lease);
        return { ...lease };
    }

    /** Must execute within the SAME immediate transaction as the protected write. */
    assertCurrent(): void {
        const lease = this.#lease;
        if (lease === undefined) return; // trusted bootstrap/administrative store
        this.#assertAssignment(lease.agentId, lease.runId, lease.sessionId);
        const row = this.#row(lease.agentId);
        if (
            row?.epoch !== lease.epoch ||
            row.owner !== lease.owner ||
            row.run_id !== lease.runId ||
            row.session_id !== lease.sessionId ||
            row.expires_at === null ||
            row.expires_at <= this.#storage.now()
        ) {
            throw new LeaseConflictError("execution", lease.agentId, row?.owner ?? undefined);
        }
    }

    renew(leaseMsValue: number): ExecutionLease {
        const leaseMs = validatePositiveInteger(leaseMsValue, "leaseMs", 3_600_000);
        const lease = this.#lease;
        if (lease === undefined) throw new ValidationError("Execution is not bound");
        const renewed = this.#storage.connection
            .transaction(() => {
                this.assertCurrent();
                const expiresAt = this.#storage.now() + leaseMs;
                this.#storage.connection
                    .prepare(`
                UPDATE agent_executions SET expires_at = ? WHERE agent_id = ? AND epoch = ? AND owner = ?
            `)
                    .run(expiresAt, lease.agentId, lease.epoch, lease.owner);
                return { ...lease, expiresAt };
            })
            .immediate();
        this.#lease = Object.freeze(renewed);
        return { ...renewed };
    }

    /** Idempotent conditional release; never releases a replacement owner's lease. */
    release(): boolean {
        const lease = this.#lease;
        if (lease === undefined) return false;
        return this.#storage.connection
            .transaction(() => {
                return (
                    this.#storage.connection
                        .prepare(`
                UPDATE agent_executions SET owner = NULL, expires_at = NULL
                WHERE agent_id = ? AND epoch = ? AND owner = ?
            `)
                        .run(lease.agentId, lease.epoch, lease.owner).changes === 1
                );
            })
            .immediate();
    }

    #assertAssignment(agentId: AgentId, runId: string, sessionId: string): void {
        const agent = this.#storage.connection
            .prepare("SELECT run_id, session_id FROM agents WHERE id = ?")
            .get(agentId) as { run_id: string; session_id: string | null } | undefined;
        if (agent?.run_id !== runId || agent.session_id !== sessionId) {
            throw new ValidationError("Execution belongs to a superseded assignment or Pi session");
        }
    }

    #row(agentId: AgentId): ExecutionRow | undefined {
        return this.#storage.connection
            .prepare("SELECT * FROM agent_executions WHERE agent_id = ?")
            .get(agentId) as ExecutionRow | undefined;
    }
}
