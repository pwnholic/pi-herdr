import type { AgentRecord } from "../domain/agent.ts";
import type { AgentId, WorkflowId } from "../domain/ids.ts";
import type { JsonValue } from "../domain/validation.ts";
import type { WorkflowRecord } from "../domain/workflow.ts";
import type { SpawnAgentRequest, SpawnAgentResult } from "../orchestrator/types.ts";

export interface WorkflowTaskInput {
    readonly alias: string;
    readonly role: string;
    readonly prompt: string;
    readonly cwd: string;
    readonly displayName?: string;
    readonly model?: string;
    readonly thinking?: string;
    readonly tools?: readonly string[];
}

export interface WorkflowTaskDefinition {
    readonly nodeId: string;
    readonly dependencies?: readonly string[];
    readonly task: WorkflowTaskInput;
}

export interface StartWorkflowInput {
    readonly id?: WorkflowId;
    readonly name: string;
    readonly metadata?: JsonValue;
    readonly nodes: readonly WorkflowTaskDefinition[];
}

export interface WorkflowNodeEvent {
    readonly workflowId: WorkflowId;
    readonly nodeId: string;
    readonly agentId: AgentId;
}

export interface WorkflowNodeResult extends WorkflowNodeEvent {
    readonly result?: JsonValue;
}

export interface WorkflowNodeFailure extends WorkflowNodeEvent {
    readonly error: string;
    readonly details?: JsonValue;
}

export interface WorkflowAgentCompletion {
    readonly agentId: AgentId;
    readonly status: "succeeded" | "failed";
    readonly result?: JsonValue;
    readonly error?: string;
}

export interface WorkflowTickResult {
    readonly claimed: number;
    readonly resumed: number;
    readonly spawnFailures: number;
}

export interface WorkflowCancelResult {
    readonly workflow: WorkflowRecord;
    readonly stopErrors: readonly string[];
}

export interface WorkflowSupervisor {
    spawn(request: SpawnAgentRequest, signal?: AbortSignal): Promise<SpawnAgentResult>;
    stop(agent: AgentId | string, signal?: AbortSignal): Promise<AgentRecord>;
}
