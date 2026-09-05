import {
    ConflictError,
    InvalidTransitionError,
    NotFoundError,
    RevisionConflictError,
    ValidationError,
} from "../domain/errors.ts";
import {
    type AgentId,
    createWorkflowId,
    parseAgentId,
    parseWorkflowId,
    type WorkflowId,
} from "../domain/ids.ts";
import {
    assertJsonValue,
    MAX_MESSAGE_BYTES,
    validateLabel,
    validateNonNegativeInteger,
    validatePageLimit,
} from "../domain/validation.ts";
import {
    type CreateWorkflowInput,
    isWorkflowNodeStatus,
    isWorkflowStatus,
    type WorkflowNodePatch,
    type WorkflowNodeStatus,
    type WorkflowPage,
    type WorkflowRecord,
    type WorkflowStatus,
} from "../domain/workflow.ts";
import { decodeCursor, encodeCursor } from "./cursor.ts";
import { isSqliteConstraintError, type StorageDatabase } from "./database.ts";
import { canonicalJson } from "./json.ts";
import {
    toWorkflowNodeRecord,
    toWorkflowRecord,
    type WorkflowNodeRow,
    type WorkflowRow,
} from "./rows.ts";

interface DependencyRow {
    readonly node_id: string;
    readonly depends_on_node_id: string;
}

interface CountRow {
    readonly count: number;
}

export interface ListWorkflowsOptions {
    readonly rootAgentId: AgentId;
    readonly status?: WorkflowStatus;
    readonly cancelRequestedOnly?: boolean;
    readonly limit?: number;
    readonly cursor?: string;
}

export interface TransitionWorkflowInput {
    readonly rootAgentId: AgentId;
    readonly workflowId: WorkflowId;
    readonly status: WorkflowStatus;
    readonly expectedRevision: number;
}

export interface UpdateWorkflowNodeInput {
    readonly rootAgentId: AgentId;
    readonly workflowId: WorkflowId;
    readonly nodeId: string;
    readonly patch: WorkflowNodePatch;
    readonly expectedRevision: number;
}

const NODE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const WORKFLOW_TRANSITIONS: Readonly<Record<WorkflowStatus, ReadonlySet<WorkflowStatus>>> = {
    pending: new Set(["running", "failed", "cancelled"]),
    running: new Set(["succeeded", "failed", "cancelled"]),
    succeeded: new Set(),
    failed: new Set(["running", "cancelled"]),
    cancelled: new Set(["running"]),
};
const NODE_TRANSITIONS: Readonly<Record<WorkflowNodeStatus, ReadonlySet<WorkflowNodeStatus>>> = {
    pending: new Set(["ready", "blocked", "cancelled"]),
    ready: new Set(["running", "blocked", "cancelled"]),
    running: new Set(["succeeded", "failed", "blocked", "cancelled"]),
    succeeded: new Set(),
    failed: new Set(["ready", "cancelled"]),
    cancelled: new Set(["ready"]),
    blocked: new Set(["ready", "cancelled"]),
};

export class WorkflowRepository {
    readonly #storage: StorageDatabase;

    constructor(storage: StorageDatabase) {
        this.#storage = storage;
    }

    create(input: CreateWorkflowInput): WorkflowRecord {
        const id = input.id === undefined ? createWorkflowId() : parseWorkflowId(input.id);
        const rootAgentId = parseAgentId(input.rootAgentId);
        this.#assertRootAgent(rootAgentId);
        const name = validateLabel(input.name, "name");
        const metadata = input.metadata ?? {};
        assertJsonValue(metadata, "metadata");
        if (!Array.isArray(input.nodes) || input.nodes.length === 0 || input.nodes.length > 1_000) {
            throw new ValidationError("nodes must contain 1-1000 workflow nodes", {
                field: "nodes",
            });
        }

        const normalized = input.nodes.map((node) => {
            const nodeId = this.#validateNodeId(node.nodeId);
            const dependencies = node.dependencies === undefined ? [] : [...node.dependencies];
            if (dependencies.length > 1_000 || new Set(dependencies).size !== dependencies.length) {
                throw new ValidationError(
                    "node dependencies must be unique and contain at most 1000 entries",
                    {
                        field: `nodes.${nodeId}.dependencies`,
                    },
                );
            }
            for (const dependency of dependencies) this.#validateNodeId(dependency);
            const nodeInput = node.input ?? {};
            assertJsonValue(nodeInput, `nodes.${nodeId}.input`);
            return { nodeId, dependencies, input: nodeInput };
        });
        const nodeIds = new Set(normalized.map((node) => node.nodeId));
        if (nodeIds.size !== normalized.length) {
            throw new ValidationError("Workflow node ids must be unique", { field: "nodes" });
        }
        for (const node of normalized) {
            for (const dependency of node.dependencies) {
                if (!nodeIds.has(dependency)) {
                    throw new ValidationError(
                        `Node ${node.nodeId} depends on unknown node ${dependency}`,
                        {
                            field: `nodes.${node.nodeId}.dependencies`,
                        },
                    );
                }
                if (dependency === node.nodeId) {
                    throw new ValidationError(`Node ${node.nodeId} cannot depend on itself`, {
                        field: `nodes.${node.nodeId}.dependencies`,
                    });
                }
            }
        }
        this.#assertAcyclic(normalized);
        const now = this.#storage.now();

        try {
            this.#storage.connection
                .transaction(() => {
                    this.#storage.connection
                        .prepare(`
                            INSERT INTO
                                workflows (
                                    id,
                                    root_agent_id,
                                    name,
                                    status,
                                    metadata_json,
                                    created_at,
                                    updated_at,
                                    revision
                                )
                            VALUES
                                (?, ?, ?, 'pending', ?, ?, ?, 0)
                    `)
                        .run(id, rootAgentId, name, canonicalJson(metadata), now, now);
                    const insertNode = this.#storage.connection.prepare(`
                        INSERT INTO
                            workflow_nodes (
                                workflow_id,
                                node_id,
                                status,
                                input_json,
                                created_at,
                                updated_at,
                                revision
                            )
                        VALUES
                            (?, ?, ?, ?, ?, ?, 0)
                `);
                    for (const node of normalized) {
                        insertNode.run(
                            id,
                            node.nodeId,
                            node.dependencies.length === 0 ? "ready" : "pending",
                            canonicalJson(node.input),
                            now,
                            now,
                        );
                    }
                    const insertDependency = this.#storage.connection.prepare(`
                    INSERT INTO workflow_node_dependencies(workflow_id, node_id, depends_on_node_id)
                    VALUES (?, ?, ?)
                `);
                    for (const node of normalized) {
                        for (const dependency of node.dependencies)
                            insertDependency.run(id, node.nodeId, dependency);
                    }
                    this.#recompute(id, now);
                })
                .immediate();
        } catch (cause) {
            if (isSqliteConstraintError(cause)) {
                throw new ConflictError(
                    "Workflow id already exists or DAG constraints are invalid",
                    { id },
                    cause,
                );
            }
            throw cause;
        }
        return this.get(id, rootAgentId);
    }

    get(workflowId: WorkflowId, rootAgentId: AgentId): WorkflowRecord {
        const id = parseWorkflowId(workflowId);
        const root = parseAgentId(rootAgentId);
        const workflow = this.#getWorkflowRow(id, root);
        const nodeRows = this.#storage.connection
            .prepare("SELECT * FROM workflow_nodes WHERE workflow_id = ? ORDER BY node_id")
            .all(id) as WorkflowNodeRow[];
        const dependencies = this.#dependencies(id);
        return toWorkflowRecord(
            workflow,
            nodeRows.map((row) => toWorkflowNodeRecord(row, dependencies.get(row.node_id) ?? [])),
        );
    }

    list(options: ListWorkflowsOptions): WorkflowPage {
        const limit = validatePageLimit(options.limit);
        const cursor = decodeCursor(options.cursor, "workflows");
        const rootAgentId = parseAgentId(options.rootAgentId);
        const conditions: string[] = ["root_agent_id = ?"];
        const parameters: unknown[] = [rootAgentId];
        if (options.cancelRequestedOnly) conditions.push("cancel_requested_at IS NOT NULL");
        if (options.status !== undefined) {
            if (!isWorkflowStatus(options.status))
                throw new ValidationError("status is invalid", { field: "status" });
            conditions.push("status = ?");
            parameters.push(options.status);
        }
        if (cursor) {
            conditions.push("(created_at > ? OR (created_at = ? AND id > ?))");
            parameters.push(cursor.createdAt, cursor.createdAt, cursor.id);
        }
        parameters.push(limit + 1);
        const where = conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`;
        const rows = this.#storage.connection
            .prepare(`SELECT * FROM workflows ${where} ORDER BY created_at, id LIMIT ?`)
            .all(...parameters) as WorkflowRow[];
        const hasMore = rows.length > limit;
        const pageRows = rows.slice(0, limit);
        const last = pageRows.at(-1);
        return {
            items: pageRows.map((row) => this.get(row.id as WorkflowId, rootAgentId)),
            ...(hasMore && last
                ? { nextCursor: encodeCursor("workflows", last.created_at, last.id) }
                : {}),
        };
    }

    transition(input: TransitionWorkflowInput): WorkflowRecord {
        const id = parseWorkflowId(input.workflowId);
        const rootAgentId = parseAgentId(input.rootAgentId);
        const expected = validateNonNegativeInteger(input.expectedRevision, "expectedRevision");
        if (!isWorkflowStatus(input.status))
            throw new ValidationError("status is invalid", { field: "status" });
        const current = this.#getWorkflowRow(id, rootAgentId);
        if (current.cancel_requested_at !== null && input.status !== "cancelled") {
            throw new ValidationError(
                "Cancelled workflow cannot be restarted; create a new workflow",
            );
        }
        if (current.revision !== expected) {
            throw new RevisionConflictError("workflow", id, expected, current.revision);
        }
        if (!WORKFLOW_TRANSITIONS[current.status].has(input.status)) {
            throw new InvalidTransitionError("workflow", id, current.status, input.status);
        }
        const now = this.#storage.now();
        const result = this.#storage.connection
            .prepare(`
                UPDATE workflows
                SET
                    status = ?,
                    updated_at = ?,
                    revision = revision + 1
                WHERE
                    id = ?
                    AND root_agent_id = ?
                    AND revision = ?
            `)
            .run(input.status, now, id, rootAgentId, expected);
        if (result.changes !== 1) this.#throwWorkflowRevision(id, rootAgentId, expected);
        return this.get(id, rootAgentId);
    }

    updateNode(input: UpdateWorkflowNodeInput): WorkflowRecord {
        const workflowId = parseWorkflowId(input.workflowId);
        const rootAgentId = parseAgentId(input.rootAgentId);
        this.#getWorkflowRow(workflowId, rootAgentId);
        const nodeId = this.#validateNodeId(input.nodeId);
        const expected = validateNonNegativeInteger(input.expectedRevision, "expectedRevision");
        if (!isWorkflowNodeStatus(input.patch.status)) {
            throw new ValidationError("node status is invalid", { field: "patch.status" });
        }
        if (input.patch.output !== undefined)
            assertJsonValue(input.patch.output, "patch.output", MAX_MESSAGE_BYTES + 4096);
        const error =
            input.patch.error === undefined
                ? undefined
                : validateLabel(input.patch.error, "patch.error", 4_096);
        const now = this.#storage.now();

        this.#storage.connection
            .transaction(() => {
                const workflow = this.#getWorkflowRow(workflowId, rootAgentId);
                if (workflow.cancel_requested_at !== null && input.patch.status !== "cancelled") {
                    throw new ValidationError("Workflow cancellation is pending");
                }
                const current = this.#getNodeRow(workflowId, nodeId);
                if (current.revision !== expected) {
                    throw new RevisionConflictError(
                        "workflow_node",
                        `${workflowId}/${nodeId}`,
                        expected,
                        current.revision,
                    );
                }
                if (!NODE_TRANSITIONS[current.status].has(input.patch.status)) {
                    throw new InvalidTransitionError(
                        "workflow_node",
                        `${workflowId}/${nodeId}`,
                        current.status,
                        input.patch.status,
                    );
                }
                if (
                    (input.patch.status === "ready" || input.patch.status === "running") &&
                    !this.#dependenciesSucceeded(workflowId, nodeId)
                ) {
                    throw new InvalidTransitionError(
                        "workflow_node",
                        `${workflowId}/${nodeId}`,
                        current.status,
                        input.patch.status,
                    );
                }

                const startedAt = input.patch.status === "running" ? now : current.started_at;
                const finishedAt = ["succeeded", "failed", "cancelled"].includes(input.patch.status)
                    ? now
                    : null;
                const result = this.#storage.connection
                    .prepare(`
                        UPDATE workflow_nodes
                        SET
                            status = ?,
                            output_json = ?,
                            error = ?,
                            started_at = ?,
                            finished_at = ?,
                            updated_at = ?,
                            revision = revision + 1
                        WHERE
                            workflow_id = ?
                            AND node_id = ?
                            AND revision = ?
                `)
                    .run(
                        input.patch.status,
                        input.patch.output === undefined ? null : canonicalJson(input.patch.output),
                        error ?? null,
                        startedAt,
                        finishedAt,
                        now,
                        workflowId,
                        nodeId,
                        expected,
                    );
                if (result.changes !== 1) {
                    const actual = this.#getNodeRow(workflowId, nodeId).revision;
                    throw new RevisionConflictError(
                        "workflow_node",
                        `${workflowId}/${nodeId}`,
                        expected,
                        actual,
                    );
                }
                this.#recompute(workflowId, now);
            })
            .immediate();
        return this.get(workflowId, rootAgentId);
    }

    requestCancellation(workflowId: WorkflowId, rootAgentId: AgentId): WorkflowRecord {
        const current = this.get(workflowId, rootAgentId);
        if (current.cancelRequestedAt === undefined && current.status !== "succeeded") {
            const now = this.#storage.now();
            this.#storage.connection
                .prepare(`
                    UPDATE workflows
                    SET
                        cancel_requested_at = ?,
                        updated_at = ?,
                        revision = revision + 1
                    WHERE
                        id = ?
                        AND root_agent_id = ?
                        AND cancel_requested_at IS NULL
            `)
                .run(now, now, current.id, current.rootAgentId);
        }
        return this.get(workflowId, rootAgentId);
    }

    #recompute(workflowId: WorkflowId, now: number): void {
        let changes = 0;
        do {
            changes = this.#storage.connection
                .prepare(`
                    UPDATE workflow_nodes AS node
                    SET
                        status = 'blocked',
                        updated_at = ?,
                        revision = revision + 1
                    WHERE
                        workflow_id = ?
                        AND status IN ('pending', 'ready')
                        AND EXISTS (
                            SELECT
                                1
                            FROM
                                workflow_node_dependencies dep
                                JOIN workflow_nodes parent ON parent.workflow_id = dep.workflow_id
                                AND parent.node_id = dep.depends_on_node_id
                            WHERE
                                dep.workflow_id = node.workflow_id
                                AND dep.node_id = node.node_id
                                AND parent.status IN ('failed', 'cancelled', 'blocked')
                        )
                `)
                .run(now, workflowId).changes;
        } while (changes > 0);

        this.#storage.connection
            .prepare(`
                UPDATE workflow_nodes AS node
                SET
                    status = 'ready',
                    updated_at = ?,
                    revision = revision + 1
                WHERE
                    workflow_id = ?
                    AND status = 'pending'
                    AND NOT EXISTS (
                        SELECT
                            1
                        FROM
                            workflow_node_dependencies dep
                            JOIN workflow_nodes parent ON parent.workflow_id = dep.workflow_id
                            AND parent.node_id = dep.depends_on_node_id
                        WHERE
                            dep.workflow_id = node.workflow_id
                            AND dep.node_id = node.node_id
                            AND parent.status != 'succeeded'
                    )
            `)
            .run(now, workflowId);

        const statuses = this.#storage.connection
            .prepare(
                "SELECT status, COUNT(*) AS count FROM workflow_nodes WHERE workflow_id = ? GROUP BY status",
            )
            .all(workflowId) as Array<{
            readonly status: WorkflowNodeStatus;
            readonly count: number;
        }>;
        const counts = new Map(statuses.map((row) => [row.status, row.count]));
        const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
        let workflowStatus: WorkflowStatus;
        if ((counts.get("succeeded") ?? 0) === total) workflowStatus = "succeeded";
        else if ((counts.get("running") ?? 0) > 0 || (counts.get("ready") ?? 0) > 0)
            workflowStatus = "running";
        else if ((counts.get("failed") ?? 0) > 0) workflowStatus = "failed";
        else if ((counts.get("cancelled") ?? 0) > 0 || (counts.get("blocked") ?? 0) > 0)
            workflowStatus = "cancelled";
        else workflowStatus = "pending";

        this.#storage.connection
            .prepare(`
                UPDATE workflows
                SET status = ?, updated_at = ?, revision = revision + 1
                WHERE id = ?
            `)
            .run(workflowStatus, now, workflowId);
    }

    #dependenciesSucceeded(workflowId: WorkflowId, nodeId: string): boolean {
        const row = this.#storage.connection
            .prepare(`
                SELECT
                    COUNT(*) AS count
                FROM
                    workflow_node_dependencies dep
                    JOIN workflow_nodes parent ON parent.workflow_id = dep.workflow_id
                    AND parent.node_id = dep.depends_on_node_id
                WHERE
                    dep.workflow_id = ?
                    AND dep.node_id = ?
                    AND parent.status != 'succeeded'
            `)
            .get(workflowId, nodeId) as CountRow;
        return row.count === 0;
    }

    #dependencies(workflowId: WorkflowId): Map<string, string[]> {
        const rows = this.#storage.connection
            .prepare(`
                SELECT node_id, depends_on_node_id
                FROM workflow_node_dependencies WHERE workflow_id = ?
                ORDER BY node_id, depends_on_node_id
            `)
            .all(workflowId) as DependencyRow[];
        const result = new Map<string, string[]>();
        for (const row of rows) {
            const values = result.get(row.node_id) ?? [];
            values.push(row.depends_on_node_id);
            result.set(row.node_id, values);
        }
        return result;
    }

    #assertAcyclic(
        nodes: readonly { readonly nodeId: string; readonly dependencies: readonly string[] }[],
    ): void {
        const graph = new Map(nodes.map((node) => [node.nodeId, node.dependencies]));
        const visiting = new Set<string>();
        const visited = new Set<string>();
        const visit = (nodeId: string): void => {
            if (visiting.has(nodeId))
                throw new ValidationError("Workflow graph contains a cycle", { field: "nodes" });
            if (visited.has(nodeId)) return;
            visiting.add(nodeId);
            for (const dependency of graph.get(nodeId) ?? []) visit(dependency);
            visiting.delete(nodeId);
            visited.add(nodeId);
        };
        for (const node of nodes) visit(node.nodeId);
    }

    #validateNodeId(value: unknown): string {
        if (
            typeof value !== "string" ||
            value.length === 0 ||
            value.length > 128 ||
            !NODE_ID_PATTERN.test(value)
        ) {
            throw new ValidationError(
                "nodeId must contain only letters, digits, dot, underscore, or hyphen",
                { field: "nodeId" },
            );
        }
        return value;
    }

    #getWorkflowRow(workflowId: WorkflowId, rootAgentId: AgentId): WorkflowRow {
        const row = this.#storage.connection
            .prepare("SELECT * FROM workflows WHERE id = ? AND root_agent_id = ?")
            .get(workflowId, rootAgentId) as WorkflowRow | undefined;
        if (!row) throw new NotFoundError("workflow", workflowId);
        return row;
    }

    #assertRootAgent(rootAgentId: AgentId): void {
        const row = this.#storage.connection
            .prepare(
                "SELECT id FROM agents WHERE id = ? AND root_agent_id = id AND parent_agent_id IS NULL",
            )
            .get(rootAgentId) as { readonly id: string } | undefined;
        if (row === undefined) throw new NotFoundError("root_agent", rootAgentId);
    }

    #getNodeRow(workflowId: WorkflowId, nodeId: string): WorkflowNodeRow {
        const row = this.#storage.connection
            .prepare("SELECT * FROM workflow_nodes WHERE workflow_id = ? AND node_id = ?")
            .get(workflowId, nodeId) as WorkflowNodeRow | undefined;
        if (!row) throw new NotFoundError("workflow_node", `${workflowId}/${nodeId}`);
        return row;
    }

    #throwWorkflowRevision(workflowId: WorkflowId, rootAgentId: AgentId, expected: number): never {
        const actual = this.#getWorkflowRow(workflowId, rootAgentId).revision;
        throw new RevisionConflictError("workflow", workflowId, expected, actual);
    }
}
