import type { AgentId } from "../domain/ids.ts";
import { parseAgentId } from "../domain/ids.ts";
import {
    assertJsonValue,
    type JsonValue,
    validateLabel,
    validateNonNegativeInteger,
    validatePageLimit,
    validatePositiveInteger,
} from "../domain/validation.ts";
import type { StorageDatabase } from "./database.ts";
import { canonicalJson, parseStoredJson } from "./json.ts";

export interface EventQuery {
    readonly rootAgentId: AgentId;
    readonly after?: number;
    readonly limit?: number;
    readonly entityId?: string;
}

interface EventRow {
    sequence: number;
    entity_id: string;
    run_id: string | null;
    type: string;
    data_json: string;
    created_at: number;
}

/** Payload-free timeline; lifecycle triggers commit in the originating transaction. */
export class EventRepository {
    readonly #storage: StorageDatabase;
    constructor(storage: StorageDatabase) {
        this.#storage = storage;
    }

    append(input: {
        rootAgentId: AgentId;
        entityId: string;
        runId?: string;
        type: string;
        data: JsonValue;
    }): void {
        assertJsonValue(input.data, "event.data");
        this.#storage.connection
            .prepare(`
                INSERT INTO
                    operational_events (
                        root_agent_id,
                        entity_id,
                        run_id,
                        type,
                        data_json,
                        created_at
                    )
                VALUES
                    (?, ?, ?, ?, ?, ?)
        `)
            .run(
                parseAgentId(input.rootAgentId),
                validateLabel(input.entityId, "entityId", 256),
                input.runId ?? null,
                validateLabel(input.type, "type", 128),
                canonicalJson(input.data),
                this.#storage.now(),
            );
    }

    list(input: EventQuery) {
        const root = parseAgentId(input.rootAgentId);
        const after = validateNonNegativeInteger(input.after ?? 0, "after");
        const limit = validatePageLimit(input.limit);
        const entity =
            input.entityId === undefined
                ? undefined
                : validateLabel(input.entityId, "entityId", 256);
        const rows = this.#storage.connection
            .prepare(`
            SELECT
                sequence,
                entity_id,
                run_id,
                type,
                data_json,
                created_at
            FROM
                operational_events
            WHERE
                root_agent_id = ?
                AND sequence > ? ${entity === undefined ? "" : "AND entity_id = ?"}
            ORDER BY
                sequence
            LIMIT
                ?
        `)
            .all(root, after, ...(entity === undefined ? [] : [entity]), limit + 1) as EventRow[];
        const items = rows.slice(0, limit).map((row) => ({
            sequence: row.sequence,
            entityId: row.entity_id,
            runId: row.run_id,
            type: row.type,
            data: parseStoredJson(row.data_json),
            createdAt: row.created_at,
        }));
        return { items, nextAfter: items.at(-1)?.sequence ?? after, hasMore: rows.length > limit };
    }

    prune(retentionMs: number, limit = 100): number {
        const cutoff =
            this.#storage.now() -
            validatePositiveInteger(retentionMs, "retentionMs", 365 * 24 * 60 * 60 * 1000);
        return this.#storage.connection
            .prepare(`
                DELETE FROM operational_events
                WHERE
                    sequence IN (
                        SELECT
                            sequence
                        FROM
                            operational_events
                        WHERE
                            created_at < ?
                        ORDER BY
                            sequence
                        LIMIT
                            ?
                    )
        `)
            .run(cutoff, validatePageLimit(limit)).changes;
    }
}
