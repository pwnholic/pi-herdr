import type {
    AgentPage,
    AgentPatch,
    AgentRecord,
    AgentStatus,
    RegisterAgentInput,
} from "../domain/agent.ts";
import { canTransitionAgent, isAgentStatus } from "../domain/agent.ts";
import {
    ConflictError,
    InvalidTransitionError,
    LeaseConflictError,
    NotFoundError,
    RevisionConflictError,
    ValidationError,
} from "../domain/errors.ts";
import { type AgentId, createAgentId, parseAgentId } from "../domain/ids.ts";
import {
    assertJsonValue,
    validateAlias,
    validateLabel,
    validateNonNegativeInteger,
    validateOptionalLabel,
    validatePageLimit,
    validatePositiveInteger,
} from "../domain/validation.ts";
import { decodeCursor, encodeCursor } from "./cursor.ts";
import { isSqliteConstraintError, type StorageDatabase } from "./database.ts";
import { canonicalJson } from "./json.ts";
import { type AgentRow, toAgentRecord } from "./rows.ts";

export interface ListAgentsOptions {
    readonly status?: AgentStatus;
    readonly parentAgentId?: AgentId;
    readonly limit?: number;
    readonly cursor?: string;
}

export interface RenameAgentInput {
    readonly agentId: AgentId;
    readonly alias: string;
    readonly displayName?: string;
    readonly expectedRevision: number;
}

export interface PatchAgentInput {
    readonly agentId: AgentId;
    readonly patch: AgentPatch;
    readonly expectedRevision: number;
}

export interface TransitionAgentInput extends PatchAgentInput {
    readonly status: AgentStatus;
}

export interface AgentLeaseInput {
    readonly agentId: AgentId;
    readonly owner: string;
    readonly leaseMs: number;
}

export class AgentRepository {
    readonly #storage: StorageDatabase;

    constructor(storage: StorageDatabase) {
        this.#storage = storage;
    }

    register(input: RegisterAgentInput): AgentRecord {
        const id = input.id === undefined ? createAgentId() : parseAgentId(input.id);
        const alias = validateAlias(input.alias);
        const displayName = validateLabel(input.displayName ?? alias, "displayName");
        const role = validateLabel(input.role, "role");
        const sessionId = validateOptionalLabel(input.sessionId, "sessionId", 256);
        const sessionFile = validateOptionalLabel(input.sessionFile, "sessionFile", 4_096);
        const workspaceId = validateOptionalLabel(input.workspaceId, "workspaceId", 256);
        const tabId = validateOptionalLabel(input.tabId, "tabId", 256);
        const paneId = validateOptionalLabel(input.paneId, "paneId", 256);
        const parentAgentId =
            input.parentAgentId === undefined ? undefined : parseAgentId(input.parentAgentId);
        const metadata = input.metadata ?? {};
        assertJsonValue(metadata, "metadata");
        const now = this.#storage.now();

        if (parentAgentId !== undefined) this.#getRow(parentAgentId);

        try {
            this.#storage.connection
                .prepare(`
                    INSERT INTO agents(
                        id, alias, display_name, role, status, session_id, session_file,
                        workspace_id, tab_id, pane_id, parent_agent_id, metadata_json,
                        created_at, updated_at, last_seen_at, revision
                    ) VALUES (?, ?, ?, ?, 'registered', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
                `)
                .run(
                    id,
                    alias,
                    displayName,
                    role,
                    sessionId ?? null,
                    sessionFile ?? null,
                    workspaceId ?? null,
                    tabId ?? null,
                    paneId ?? null,
                    parentAgentId ?? null,
                    canonicalJson(metadata),
                    now,
                    now,
                    now,
                );
        } catch (cause) {
            if (isSqliteConstraintError(cause)) {
                throw new ConflictError("Agent id or alias already exists", { id, alias }, cause);
            }
            throw cause;
        }
        return this.get(id);
    }

    get(agentId: AgentId): AgentRecord {
        return toAgentRecord(this.#getRow(parseAgentId(agentId)));
    }

    getByAlias(alias: string): AgentRecord {
        const normalized = validateAlias(alias);
        const row = this.#storage.connection
            .prepare("SELECT * FROM agents WHERE alias = ?")
            .get(normalized) as AgentRow | undefined;
        if (!row) throw new NotFoundError("agent", normalized);
        return toAgentRecord(row);
    }

    list(options: ListAgentsOptions = {}): AgentPage {
        const limit = validatePageLimit(options.limit);
        const cursor = decodeCursor(options.cursor, "agents");
        const conditions: string[] = [];
        const parameters: unknown[] = [];

        if (options.status !== undefined) {
            if (!isAgentStatus(options.status))
                throw new ValidationError("status is invalid", { field: "status" });
            conditions.push("status = ?");
            parameters.push(options.status);
        }
        if (options.parentAgentId !== undefined) {
            conditions.push("parent_agent_id = ?");
            parameters.push(parseAgentId(options.parentAgentId));
        }
        if (cursor) {
            conditions.push("(created_at > ? OR (created_at = ? AND id > ?))");
            parameters.push(cursor.createdAt, cursor.createdAt, cursor.id);
        }
        parameters.push(limit + 1);
        const where = conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`;
        const rows = this.#storage.connection
            .prepare(`SELECT * FROM agents ${where} ORDER BY created_at, id LIMIT ?`)
            .all(...parameters) as AgentRow[];
        const hasMore = rows.length > limit;
        const pageRows = rows.slice(0, limit);
        const last = pageRows.at(-1);
        return {
            items: pageRows.map(toAgentRecord),
            ...(hasMore && last
                ? { nextCursor: encodeCursor("agents", last.created_at, last.id) }
                : {}),
        };
    }

    rename(input: RenameAgentInput): AgentRecord {
        const id = parseAgentId(input.agentId);
        const alias = validateAlias(input.alias);
        const expectedRevision = validateNonNegativeInteger(
            input.expectedRevision,
            "expectedRevision",
        );
        const current = this.#getRow(id);
        if (current.revision !== expectedRevision) {
            throw new RevisionConflictError("agent", id, expectedRevision, current.revision);
        }
        if (
            current.alias === alias &&
            (input.displayName === undefined || current.display_name === input.displayName)
        ) {
            throw new ConflictError("Agent alias and display name are unchanged", { id, alias });
        }
        const displayName = validateLabel(input.displayName ?? current.display_name, "displayName");
        const now = this.#storage.now();
        try {
            const result = this.#storage.connection
                .prepare(`
                    UPDATE agents SET alias = ?, display_name = ?, updated_at = ?, revision = revision + 1
                    WHERE id = ? AND revision = ?
                `)
                .run(alias, displayName, now, id, expectedRevision);
            if (result.changes !== 1) this.#throwRevision(id, expectedRevision);
        } catch (cause) {
            if (isSqliteConstraintError(cause)) {
                throw new ConflictError("Agent alias already exists", { id, alias }, cause);
            }
            throw cause;
        }
        return this.get(id);
    }

    patch(input: PatchAgentInput): AgentRecord {
        const id = parseAgentId(input.agentId);
        const expectedRevision = validateNonNegativeInteger(
            input.expectedRevision,
            "expectedRevision",
        );
        const current = this.#getRow(id);
        if (current.revision !== expectedRevision) {
            throw new RevisionConflictError("agent", id, expectedRevision, current.revision);
        }

        const assignments: string[] = [];
        const values: unknown[] = [];
        const stringFields = [
            ["sessionId", "session_id", 256],
            ["sessionFile", "session_file", 4_096],
            ["workspaceId", "workspace_id", 256],
            ["tabId", "tab_id", 256],
            ["paneId", "pane_id", 256],
        ] as const;
        for (const [property, column, maximum] of stringFields) {
            const value = input.patch[property];
            if (value === undefined) continue;
            assignments.push(`${column} = ?`);
            values.push(value === null ? null : validateLabel(value, property, maximum));
        }
        if (input.patch.metadata !== undefined) {
            assertJsonValue(input.patch.metadata, "metadata");
            assignments.push("metadata_json = ?");
            values.push(canonicalJson(input.patch.metadata));
        }
        if (assignments.length === 0)
            throw new ValidationError("patch must change at least one field", { field: "patch" });

        const now = this.#storage.now();
        assignments.push("updated_at = ?", "last_seen_at = ?", "revision = revision + 1");
        values.push(now, now, id, expectedRevision);
        const result = this.#storage.connection
            .prepare(`UPDATE agents SET ${assignments.join(", ")} WHERE id = ? AND revision = ?`)
            .run(...values);
        if (result.changes !== 1) this.#throwRevision(id, expectedRevision);
        return this.get(id);
    }

    transition(input: TransitionAgentInput): AgentRecord {
        const id = parseAgentId(input.agentId);
        const expectedRevision = validateNonNegativeInteger(
            input.expectedRevision,
            "expectedRevision",
        );
        if (!isAgentStatus(input.status))
            throw new ValidationError("status is invalid", { field: "status" });
        const current = this.#getRow(id);
        if (current.revision !== expectedRevision) {
            throw new RevisionConflictError("agent", id, expectedRevision, current.revision);
        }
        if (!canTransitionAgent(current.status, input.status)) {
            throw new InvalidTransitionError("agent", id, current.status, input.status);
        }

        const patch = input.patch;
        const assignments = ["status = ?"];
        const values: unknown[] = [input.status];
        const stringFields = [
            ["sessionId", "session_id", 256],
            ["sessionFile", "session_file", 4_096],
            ["workspaceId", "workspace_id", 256],
            ["tabId", "tab_id", 256],
            ["paneId", "pane_id", 256],
        ] as const;
        for (const [property, column, maximum] of stringFields) {
            const value = patch[property];
            if (value === undefined) continue;
            assignments.push(`${column} = ?`);
            values.push(value === null ? null : validateLabel(value, property, maximum));
        }
        if (patch.metadata !== undefined) {
            assertJsonValue(patch.metadata, "metadata");
            assignments.push("metadata_json = ?");
            values.push(canonicalJson(patch.metadata));
        }
        const now = this.#storage.now();
        assignments.push("updated_at = ?", "last_seen_at = ?", "revision = revision + 1");
        values.push(now, now, id, expectedRevision);
        const result = this.#storage.connection
            .prepare(`UPDATE agents SET ${assignments.join(", ")} WHERE id = ? AND revision = ?`)
            .run(...values);
        if (result.changes !== 1) this.#throwRevision(id, expectedRevision);
        return this.get(id);
    }

    delete(agentId: AgentId, expectedRevision: number): void {
        const id = parseAgentId(agentId);
        const revision = validateNonNegativeInteger(expectedRevision, "expectedRevision");
        const current = this.#getRow(id);
        if (current.revision !== revision)
            throw new RevisionConflictError("agent", id, revision, current.revision);
        if (!["stopped", "completed", "failed"].includes(current.status)) {
            throw new InvalidTransitionError("agent", id, current.status, "deleted");
        }
        if (current.lease_owner !== null && (current.lease_expires_at ?? 0) > this.#storage.now()) {
            throw new LeaseConflictError("agent", id, current.lease_owner);
        }
        try {
            const result = this.#storage.connection
                .prepare("DELETE FROM agents WHERE id = ? AND revision = ?")
                .run(id, revision);
            if (result.changes !== 1) this.#throwRevision(id, revision);
        } catch (cause) {
            if (isSqliteConstraintError(cause)) {
                throw new ConflictError(
                    "Agent is still referenced and cannot be deleted",
                    { id },
                    cause,
                );
            }
            throw cause;
        }
    }

    acquireLease(input: AgentLeaseInput): AgentRecord {
        const id = parseAgentId(input.agentId);
        const owner = validateLabel(input.owner, "owner", 256);
        const leaseMs = validatePositiveInteger(input.leaseMs, "leaseMs", 3_600_000);
        const now = this.#storage.now();
        const expiresAt = now + leaseMs;
        const result = this.#storage.connection
            .prepare(`
                UPDATE agents
                SET lease_owner = ?, lease_expires_at = ?, updated_at = ?, revision = revision + 1
                WHERE id = ? AND (lease_owner IS NULL OR lease_expires_at <= ? OR lease_owner = ?)
            `)
            .run(owner, expiresAt, now, id, now, owner);
        if (result.changes !== 1) {
            const current = this.#getRow(id);
            throw new LeaseConflictError("agent", id, current.lease_owner ?? undefined);
        }
        return this.get(id);
    }

    renewLease(input: AgentLeaseInput): AgentRecord {
        const id = parseAgentId(input.agentId);
        const owner = validateLabel(input.owner, "owner", 256);
        const leaseMs = validatePositiveInteger(input.leaseMs, "leaseMs", 3_600_000);
        const now = this.#storage.now();
        const result = this.#storage.connection
            .prepare(`
                UPDATE agents
                SET lease_expires_at = ?, updated_at = ?, revision = revision + 1
                WHERE id = ? AND lease_owner = ? AND lease_expires_at > ?
            `)
            .run(now + leaseMs, now, id, owner, now);
        if (result.changes !== 1) {
            const current = this.#getRow(id);
            throw new LeaseConflictError("agent", id, current.lease_owner ?? undefined);
        }
        return this.get(id);
    }

    releaseLease(agentId: AgentId, ownerValue: string): AgentRecord {
        const id = parseAgentId(agentId);
        const owner = validateLabel(ownerValue, "owner", 256);
        const now = this.#storage.now();
        const result = this.#storage.connection
            .prepare(`
                UPDATE agents
                SET lease_owner = NULL, lease_expires_at = NULL, updated_at = ?, revision = revision + 1
                WHERE id = ? AND lease_owner = ?
            `)
            .run(now, id, owner);
        if (result.changes !== 1) {
            const current = this.#getRow(id);
            throw new LeaseConflictError("agent", id, current.lease_owner ?? undefined);
        }
        return this.get(id);
    }

    #getRow(agentId: AgentId): AgentRow {
        const row = this.#storage.connection
            .prepare("SELECT * FROM agents WHERE id = ?")
            .get(agentId) as AgentRow | undefined;
        if (!row) throw new NotFoundError("agent", agentId);
        return row;
    }

    #throwRevision(agentId: AgentId, expected: number): never {
        const actual = this.#getRow(agentId).revision;
        throw new RevisionConflictError("agent", agentId, expected, actual);
    }
}
