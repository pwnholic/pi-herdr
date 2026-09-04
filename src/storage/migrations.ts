import type Database from "better-sqlite3";
import { MigrationError } from "../domain/errors.ts";

interface Migration {
    readonly version: number;
    readonly name: string;
    readonly sql: string;
}

const MIGRATIONS: readonly Migration[] = [
    {
        version: 1,
        name: "durable-agent-registry-and-mailbox",
        sql: `
      CREATE TABLE agents (
        id TEXT PRIMARY KEY,
        alias TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        role TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('registered','starting','running','idle','blocked','interrupted','stopping','stopped','completed','failed','orphaned')),
        session_id TEXT,
        session_file TEXT,
        workspace_id TEXT,
        tab_id TEXT,
        pane_id TEXT,
        parent_agent_id TEXT REFERENCES agents(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
        metadata_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
        lease_owner TEXT,
        lease_expires_at INTEGER,
        CHECK (length(alias) BETWEEN 1 AND 32),
        CHECK (length(display_name) BETWEEN 1 AND 128),
        CHECK (length(role) BETWEEN 1 AND 128),
        CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL))
      ) STRICT;

      CREATE INDEX agents_status_created_idx ON agents(status, created_at, id);
      CREATE INDEX agents_lease_expiry_idx ON agents(lease_expires_at) WHERE lease_expires_at IS NOT NULL;

      CREATE TABLE mailbox_messages (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        sender_agent_id TEXT REFERENCES agents(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
        sender_scope TEXT NOT NULL,
        recipient_agent_id TEXT NOT NULL REFERENCES agents(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
        thread_id TEXT NOT NULL,
        reply_to_message_id TEXT REFERENCES mailbox_messages(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
        kind TEXT NOT NULL CHECK (kind IN ('message','request','response','control','result','event')),
        content TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('queued','delivered','read','acked','dead_letter')),
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        max_attempts INTEGER NOT NULL CHECK (max_attempts BETWEEN 1 AND 100),
        available_at INTEGER NOT NULL,
        expires_at INTEGER,
        delivered_at INTEGER,
        read_at INTEGER,
        acked_at INTEGER,
        dead_lettered_at INTEGER,
        dead_letter_reason TEXT,
        lease_owner TEXT,
        lease_expires_at INTEGER,
        idempotency_key TEXT,
        intent_hash TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
        CHECK (expires_at IS NULL OR expires_at > created_at),
        CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL)),
        CHECK ((idempotency_key IS NULL) = (intent_hash IS NULL)),
        CHECK (state != 'acked' OR acked_at IS NOT NULL),
        CHECK (state != 'dead_letter' OR (dead_lettered_at IS NOT NULL AND dead_letter_reason IS NOT NULL))
      ) STRICT;

      CREATE UNIQUE INDEX mailbox_idempotency_idx
        ON mailbox_messages(sender_scope, idempotency_key)
        WHERE idempotency_key IS NOT NULL;
      CREATE INDEX mailbox_recipient_order_idx
        ON mailbox_messages(recipient_agent_id, sequence);
      CREATE INDEX mailbox_delivery_idx
        ON mailbox_messages(recipient_agent_id, state, available_at, sequence);
      CREATE INDEX mailbox_thread_idx
        ON mailbox_messages(thread_id, sequence);
      CREATE INDEX mailbox_expiry_idx
        ON mailbox_messages(expires_at)
        WHERE expires_at IS NOT NULL AND state NOT IN ('acked','dead_letter');
      CREATE INDEX mailbox_lease_expiry_idx
        ON mailbox_messages(lease_expires_at)
        WHERE lease_expires_at IS NOT NULL;

      CREATE TABLE workflows (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending','running','succeeded','failed','cancelled')),
        metadata_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
        CHECK (length(name) BETWEEN 1 AND 128)
      ) STRICT;

      CREATE TABLE workflow_nodes (
        workflow_id TEXT NOT NULL REFERENCES workflows(id) ON UPDATE RESTRICT ON DELETE CASCADE,
        node_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending','ready','running','succeeded','failed','cancelled','blocked')),
        input_json TEXT NOT NULL,
        output_json TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        started_at INTEGER,
        finished_at INTEGER,
        revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
        PRIMARY KEY (workflow_id, node_id),
        CHECK (length(node_id) BETWEEN 1 AND 128)
      ) STRICT;

      CREATE TABLE workflow_node_dependencies (
        workflow_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        depends_on_node_id TEXT NOT NULL,
        PRIMARY KEY (workflow_id, node_id, depends_on_node_id),
        FOREIGN KEY (workflow_id, node_id)
          REFERENCES workflow_nodes(workflow_id, node_id) ON UPDATE RESTRICT ON DELETE CASCADE,
        FOREIGN KEY (workflow_id, depends_on_node_id)
          REFERENCES workflow_nodes(workflow_id, node_id) ON UPDATE RESTRICT ON DELETE CASCADE,
        CHECK (node_id != depends_on_node_id)
      ) STRICT;

      CREATE INDEX workflows_status_created_idx ON workflows(status, created_at, id);
      CREATE INDEX workflow_nodes_status_idx ON workflow_nodes(workflow_id, status, node_id);
      CREATE INDEX workflow_dependencies_reverse_idx
        ON workflow_node_dependencies(workflow_id, depends_on_node_id, node_id);
    `,
    },
];

interface MigrationRow {
    readonly version: number;
    readonly name: string;
}

export const LATEST_SCHEMA_VERSION = MIGRATIONS.at(-1)?.version ?? 0;

export function migrate(connection: Database.Database, now: number): void {
    try {
        connection.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        applied_at INTEGER NOT NULL
      ) STRICT;
    `);

        const applied = connection
            .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
            .all() as MigrationRow[];
        const latestApplied = applied.at(-1)?.version ?? 0;

        if (latestApplied > LATEST_SCHEMA_VERSION) {
            throw new MigrationError(
                `Database schema version ${latestApplied} is newer than supported version ${LATEST_SCHEMA_VERSION}`,
            );
        }

        for (const row of applied) {
            const expected = MIGRATIONS.find((migration) => migration.version === row.version);
            if (!expected || expected.name !== row.name) {
                throw new MigrationError(`Migration history mismatch at version ${row.version}`);
            }
        }

        const applyPending = connection.transaction(() => {
            for (const migration of MIGRATIONS) {
                if (migration.version <= latestApplied) continue;
                connection.exec(migration.sql);
                connection
                    .prepare(
                        "INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)",
                    )
                    .run(migration.version, migration.name, now);
            }
        });
        applyPending.immediate();
    } catch (cause) {
        if (cause instanceof MigrationError) throw cause;
        throw new MigrationError("Failed to migrate control-plane database", cause);
    }
}
