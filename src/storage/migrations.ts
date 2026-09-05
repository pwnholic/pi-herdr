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
        name: "pi-herdr-control-plane-v1-runs",
        sql: `
        CREATE TABLE agents (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL,
            alias TEXT NOT NULL,
            display_name TEXT NOT NULL,
            role TEXT NOT NULL,
            status TEXT NOT NULL CHECK (
                status IN (
                    'registered',
                    'starting',
                    'running',
                    'idle',
                    'blocked',
                    'interrupted',
                    'stopping',
                    'stopped',
                    'completed',
                    'failed',
                    'orphaned'
                )
            ),
            session_id TEXT,
            session_file TEXT,
            workspace_id TEXT,
            tab_id TEXT,
            pane_id TEXT,
            parent_agent_id TEXT REFERENCES agents (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
            root_agent_id TEXT NOT NULL REFERENCES agents (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
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
            CHECK (
                (lease_owner IS NULL) = (lease_expires_at IS NULL)
            )
        ) STRICT;

        CREATE INDEX agents_status_created_idx ON agents (status, created_at, id);

        CREATE INDEX agents_lease_expiry_idx ON agents (lease_expires_at)
        WHERE
            lease_expires_at IS NOT NULL;

        CREATE UNIQUE INDEX agents_root_alias_idx ON agents (root_agent_id, alias);

        CREATE INDEX agents_root_created_idx ON agents (root_agent_id, created_at, id);

        CREATE TABLE mailbox_messages (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT,
            id TEXT NOT NULL UNIQUE,
            sender_agent_id TEXT REFERENCES agents (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
            sender_scope TEXT NOT NULL,
            sender_run_id TEXT,
            recipient_run_id TEXT NOT NULL,
            recipient_agent_id TEXT NOT NULL REFERENCES agents (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
            root_agent_id TEXT NOT NULL REFERENCES agents (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
            thread_id TEXT NOT NULL,
            reply_to_message_id TEXT REFERENCES mailbox_messages (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
            kind TEXT NOT NULL CHECK (
                kind IN (
                    'message',
                    'request',
                    'response',
                    'control',
                    'result',
                    'event'
                )
            ),
            content TEXT NOT NULL,
            metadata_json TEXT NOT NULL,
            delivery_mode TEXT NOT NULL CHECK (delivery_mode IN ('steer', 'followUp')),
            required INTEGER NOT NULL CHECK (required IN (0, 1)),
            hop_count INTEGER NOT NULL DEFAULT 0 CHECK (hop_count BETWEEN 0 AND 64),
            state TEXT NOT NULL CHECK (
                state IN (
                    'queued',
                    'delivered',
                    'read',
                    'acked',
                    'dead_letter'
                )
            ),
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
            CHECK (
                expires_at IS NULL
                OR expires_at > created_at
            ),
            CHECK (
                (lease_owner IS NULL) = (lease_expires_at IS NULL)
            ),
            CHECK ((idempotency_key IS NULL) = (intent_hash IS NULL)),
            CHECK (
                state != 'acked'
                OR acked_at IS NOT NULL
            ),
            CHECK (
                state != 'dead_letter'
                OR (
                    dead_lettered_at IS NOT NULL
                    AND dead_letter_reason IS NOT NULL
                )
            )
        ) STRICT;

        CREATE UNIQUE INDEX mailbox_idempotency_idx ON mailbox_messages (sender_scope, idempotency_key)
        WHERE
            idempotency_key IS NOT NULL;

        CREATE INDEX mailbox_recipient_order_idx ON mailbox_messages (recipient_agent_id, sequence);

        CREATE INDEX mailbox_delivery_idx ON mailbox_messages (recipient_agent_id, state, available_at, sequence);

        CREATE INDEX mailbox_thread_idx ON mailbox_messages (thread_id, sequence);

        CREATE INDEX mailbox_expiry_idx ON mailbox_messages (expires_at)
        WHERE
            expires_at IS NOT NULL
            AND state NOT IN ('acked', 'dead_letter');

        CREATE INDEX mailbox_lease_expiry_idx ON mailbox_messages (lease_expires_at)
        WHERE
            lease_expires_at IS NOT NULL;

        CREATE INDEX mailbox_root_state_idx ON mailbox_messages (root_agent_id, state, sequence);

        CREATE TABLE mailbox_idempotency_tombstones (
            sender_scope TEXT NOT NULL,
            idempotency_key TEXT NOT NULL,
            intent_hash TEXT NOT NULL,
            message_id TEXT NOT NULL,
            retained_until INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            PRIMARY KEY (sender_scope, idempotency_key)
        ) STRICT;

        CREATE INDEX mailbox_tombstones_expiry_idx ON mailbox_idempotency_tombstones (retained_until);

        CREATE TABLE completion_outbox (
            agent_id TEXT PRIMARY KEY REFERENCES agents (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
            run_id TEXT NOT NULL,
            invocation_token TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            state TEXT NOT NULL CHECK (
                state IN (
                    'declared',
                    'emitted',
                    'parent_applied',
                    'acknowledged',
                    'invalidated'
                )
            ),
            message_id TEXT REFERENCES mailbox_messages (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0)
        ) STRICT;

        CREATE TABLE mailbox_effects (
            message_id TEXT PRIMARY KEY REFERENCES mailbox_messages (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
            effect TEXT NOT NULL,
            state TEXT NOT NULL CHECK (state IN ('applying', 'applied', 'notified')),
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0)
        ) STRICT;

        CREATE TABLE workflows (
            id TEXT PRIMARY KEY,
            root_agent_id TEXT NOT NULL REFERENCES agents (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
            name TEXT NOT NULL,
            status TEXT NOT NULL CHECK (
                status IN (
                    'pending',
                    'running',
                    'succeeded',
                    'failed',
                    'cancelled'
                )
            ),
            metadata_json TEXT NOT NULL,
            cancel_requested_at INTEGER,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
            CHECK (length(name) BETWEEN 1 AND 128)
        ) STRICT;

        CREATE TABLE workflow_nodes (
            workflow_id TEXT NOT NULL REFERENCES workflows (id) ON UPDATE RESTRICT ON DELETE CASCADE,
            node_id TEXT NOT NULL,
            status TEXT NOT NULL CHECK (
                status IN (
                    'pending',
                    'ready',
                    'running',
                    'succeeded',
                    'failed',
                    'cancelled',
                    'blocked'
                )
            ),
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
            FOREIGN KEY (workflow_id, node_id) REFERENCES workflow_nodes (workflow_id, node_id) ON UPDATE RESTRICT ON DELETE CASCADE,
            FOREIGN KEY (workflow_id, depends_on_node_id) REFERENCES workflow_nodes (workflow_id, node_id) ON UPDATE RESTRICT ON DELETE CASCADE,
            CHECK (node_id != depends_on_node_id)
        ) STRICT;

        CREATE INDEX workflows_root_status_created_idx ON workflows (root_agent_id, status, created_at, id);

        CREATE INDEX workflow_nodes_status_idx ON workflow_nodes (workflow_id, status, node_id);

        CREATE INDEX workflow_dependencies_reverse_idx ON workflow_node_dependencies (workflow_id, depends_on_node_id, node_id);

        CREATE TABLE operational_events (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT,
            root_agent_id TEXT NOT NULL,
            entity_id TEXT NOT NULL,
            run_id TEXT,
            type TEXT NOT NULL,
            data_json TEXT NOT NULL,
            created_at INTEGER NOT NULL
        ) STRICT;

        CREATE INDEX events_root_sequence_idx ON operational_events (root_agent_id, sequence);

        CREATE TRIGGER mailbox_assignment_fence
        BEFORE UPDATE ON mailbox_messages
        WHEN NEW.state IN ('queued', 'delivered', 'read', 'acked') AND (
            NEW.recipient_run_id != (SELECT run_id FROM agents WHERE id = NEW.recipient_agent_id)
            OR (NEW.sender_agent_id IS NOT NULL AND
                NEW.sender_run_id != (SELECT run_id FROM agents WHERE id = NEW.sender_agent_id))
        )
        BEGIN
            SELECT RAISE(ABORT, 'Mailbox mutation belongs to a superseded assignment');
        END;

        CREATE TRIGGER agent_created
        AFTER INSERT ON agents
        BEGIN
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
            (
                NEW.root_agent_id,
                NEW.id,
                NEW.run_id,
                'agent.created',
                json_object('status', NEW.status, 'alias', NEW.alias),
                NEW.created_at
            );

        END;

        CREATE TRIGGER agent_changed
        AFTER UPDATE ON agents WHEN OLD.status != NEW.status
        OR OLD.run_id != NEW.run_id
        OR OLD.alias != NEW.alias
        BEGIN
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
            (
                NEW.root_agent_id,
                NEW.id,
                NEW.run_id,
                'agent.changed',
                json_object(
                    'from',
                    OLD.status,
                    'to',
                    NEW.status,
                    'alias',
                    NEW.alias
                ),
                NEW.updated_at
            );

        END;

        CREATE TRIGGER mail_created
        AFTER INSERT ON mailbox_messages
        BEGIN
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
            (
                NEW.root_agent_id,
                NEW.id,
                NEW.recipient_run_id,
                'mail.queued',
                json_object(
                    'sender',
                    NEW.sender_agent_id,
                    'recipient',
                    NEW.recipient_agent_id,
                    'senderRunId',
                    NEW.sender_run_id,
                    'threadId',
                    NEW.thread_id,
                    'kind',
                    NEW.kind
                ),
                NEW.created_at
            );

        END;

        CREATE TRIGGER mail_changed
        AFTER UPDATE OF state ON mailbox_messages WHEN OLD.state != NEW.state
        BEGIN
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
            (
                NEW.root_agent_id,
                NEW.id,
                NEW.recipient_run_id,
                'mail.changed',
                json_object(
                    'from',
                    OLD.state,
                    'to',
                    NEW.state,
                    'attempt',
                    NEW.attempt_count,
                    'reason',
                    NEW.dead_letter_reason
                ),
                NEW.updated_at
            );

        END;

        CREATE TRIGGER workflow_changed
        AFTER UPDATE ON workflows WHEN OLD.status != NEW.status
        OR OLD.cancel_requested_at IS NOT NEW.cancel_requested_at
        BEGIN
        INSERT INTO
            operational_events (
                root_agent_id,
                entity_id,
                type,
                data_json,
                created_at
            )
        VALUES
            (
                NEW.root_agent_id,
                NEW.id,
                'workflow.changed',
                json_object(
                    'from',
                    OLD.status,
                    'to',
                    NEW.status,
                    'cancelRequestedAt',
                    NEW.cancel_requested_at
                ),
                NEW.updated_at
            );

        END;

        CREATE TRIGGER completion_changed
        AFTER UPDATE ON completion_outbox WHEN OLD.state != NEW.state
        BEGIN
        INSERT INTO
            operational_events (
                root_agent_id,
                entity_id,
                run_id,
                type,
                data_json,
                created_at
            )
        SELECT
            root_agent_id,
            NEW.agent_id,
            NEW.run_id,
            'completion.changed',
            json_object(
                'from',
                OLD.state,
                'to',
                NEW.state,
                'messageId',
                NEW.message_id
            ),
            NEW.updated_at
        FROM
            agents
        WHERE
            id = NEW.agent_id;

        END;
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

        for (const migration of MIGRATIONS) {
            if (migration.version <= latestApplied) continue;
            connection
                .transaction(() => {
                    connection.exec(migration.sql);
                    connection
                        .prepare(
                            "INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)",
                        )
                        .run(migration.version, migration.name, now);
                })
                .immediate();
            const violations = connection.pragma("foreign_key_check") as unknown[];
            const violation = violations.at(0);
            if (violation !== undefined) {
                throw new MigrationError(
                    `Foreign-key violation after migration ${migration.version}`,
                );
            }
        }
    } catch (cause) {
        if (cause instanceof MigrationError) throw cause;
        throw new MigrationError("Failed to migrate control-plane database", cause);
    }
}
