import type { WorkflowId } from "./ids.ts";
import type { JsonValue } from "./validation.ts";

export const WORKFLOW_STATUSES = [
    "pending",
    "running",
    "succeeded",
    "failed",
    "cancelled",
] as const;
export const WORKFLOW_NODE_STATUSES = [
    "pending",
    "ready",
    "running",
    "succeeded",
    "failed",
    "cancelled",
    "blocked",
] as const;

export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];
export type WorkflowNodeStatus = (typeof WORKFLOW_NODE_STATUSES)[number];

export interface WorkflowNodeRecord {
    readonly workflowId: WorkflowId;
    readonly nodeId: string;
    readonly status: WorkflowNodeStatus;
    readonly dependencies: readonly string[];
    readonly input: JsonValue;
    readonly output?: JsonValue;
    readonly error?: string;
    readonly createdAt: number;
    readonly updatedAt: number;
    readonly startedAt?: number;
    readonly finishedAt?: number;
    readonly revision: number;
}

export interface WorkflowRecord {
    readonly id: WorkflowId;
    readonly name: string;
    readonly status: WorkflowStatus;
    readonly metadata: JsonValue;
    readonly nodes: readonly WorkflowNodeRecord[];
    readonly createdAt: number;
    readonly updatedAt: number;
    readonly revision: number;
}

export interface CreateWorkflowNodeInput {
    readonly nodeId: string;
    readonly dependencies?: readonly string[];
    readonly input?: JsonValue;
}

export interface CreateWorkflowInput {
    readonly id?: WorkflowId;
    readonly name: string;
    readonly metadata?: JsonValue;
    readonly nodes: readonly CreateWorkflowNodeInput[];
}

export interface WorkflowNodePatch {
    readonly status: WorkflowNodeStatus;
    readonly output?: JsonValue;
    readonly error?: string;
}

export interface WorkflowPage {
    readonly items: readonly WorkflowRecord[];
    readonly nextCursor?: string;
}

export function isWorkflowStatus(value: unknown): value is WorkflowStatus {
    return typeof value === "string" && (WORKFLOW_STATUSES as readonly string[]).includes(value);
}

export function isWorkflowNodeStatus(value: unknown): value is WorkflowNodeStatus {
    return (
        typeof value === "string" && (WORKFLOW_NODE_STATUSES as readonly string[]).includes(value)
    );
}
