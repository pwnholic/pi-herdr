import type { AgentRecord, AgentStatus } from "../domain/agent.ts";
import type { AgentId, MessageId, ThreadId, WorkflowId } from "../domain/ids.ts";
import type { MailboxMessage, MessageKind, MessageState } from "../domain/mailbox.ts";
import type {
    WorkflowNodeRecord,
    WorkflowNodeStatus,
    WorkflowRecord,
    WorkflowStatus,
} from "../domain/workflow.ts";
import { parseStoredJson } from "./json.ts";

export interface AgentRow {
    readonly id: string;
    readonly alias: string;
    readonly display_name: string;
    readonly role: string;
    readonly status: AgentStatus;
    readonly session_id: string | null;
    readonly session_file: string | null;
    readonly workspace_id: string | null;
    readonly tab_id: string | null;
    readonly pane_id: string | null;
    readonly parent_agent_id: string | null;
    readonly root_agent_id: string | null;
    readonly metadata_json: string;
    readonly created_at: number;
    readonly updated_at: number;
    readonly last_seen_at: number;
    readonly revision: number;
    readonly lease_owner: string | null;
    readonly lease_expires_at: number | null;
}

export interface MessageRow {
    readonly sequence: number;
    readonly id: string;
    readonly sender_agent_id: string | null;
    readonly sender_scope: string;
    readonly root_agent_id: string | null;
    readonly recipient_agent_id: string;
    readonly thread_id: string;
    readonly reply_to_message_id: string | null;
    readonly kind: MessageKind;
    readonly content: string;
    readonly metadata_json: string;
    readonly delivery_mode: "steer" | "followUp";
    readonly required: number;
    readonly hop_count: number;
    readonly state: MessageState;
    readonly attempt_count: number;
    readonly max_attempts: number;
    readonly available_at: number;
    readonly expires_at: number | null;
    readonly delivered_at: number | null;
    readonly read_at: number | null;
    readonly acked_at: number | null;
    readonly dead_lettered_at: number | null;
    readonly dead_letter_reason: string | null;
    readonly lease_owner: string | null;
    readonly lease_expires_at: number | null;
    readonly idempotency_key: string | null;
    readonly intent_hash: string | null;
    readonly created_at: number;
    readonly updated_at: number;
    readonly revision: number;
}

export interface WorkflowRow {
    readonly id: string;
    readonly root_agent_id: string;
    readonly name: string;
    readonly status: WorkflowStatus;
    readonly metadata_json: string;
    readonly created_at: number;
    readonly updated_at: number;
    readonly revision: number;
}

export interface WorkflowNodeRow {
    readonly workflow_id: string;
    readonly node_id: string;
    readonly status: WorkflowNodeStatus;
    readonly input_json: string;
    readonly output_json: string | null;
    readonly error: string | null;
    readonly created_at: number;
    readonly updated_at: number;
    readonly started_at: number | null;
    readonly finished_at: number | null;
    readonly revision: number;
}

export function toAgentRecord(row: AgentRow): AgentRecord {
    return {
        id: row.id as AgentId,
        alias: row.alias,
        displayName: row.display_name,
        role: row.role,
        status: row.status,
        ...(row.session_id === null ? {} : { sessionId: row.session_id }),
        ...(row.session_file === null ? {} : { sessionFile: row.session_file }),
        ...(row.workspace_id === null ? {} : { workspaceId: row.workspace_id }),
        ...(row.tab_id === null ? {} : { tabId: row.tab_id }),
        ...(row.pane_id === null ? {} : { paneId: row.pane_id }),
        ...(row.parent_agent_id === null ? {} : { parentAgentId: row.parent_agent_id as AgentId }),
        rootAgentId: (row.root_agent_id ?? row.id) as AgentId,
        metadata: parseStoredJson(row.metadata_json),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        lastSeenAt: row.last_seen_at,
        revision: row.revision,
        ...(row.lease_owner === null ? {} : { leaseOwner: row.lease_owner }),
        ...(row.lease_expires_at === null ? {} : { leaseExpiresAt: row.lease_expires_at }),
    };
}

export function toMailboxMessage(row: MessageRow): MailboxMessage {
    return {
        id: row.id as MessageId,
        rootAgentId: (row.root_agent_id ?? row.recipient_agent_id) as AgentId,
        ...(row.sender_agent_id === null ? {} : { senderAgentId: row.sender_agent_id as AgentId }),
        recipientAgentId: row.recipient_agent_id as AgentId,
        threadId: row.thread_id as ThreadId,
        ...(row.reply_to_message_id === null
            ? {}
            : { replyToMessageId: row.reply_to_message_id as MessageId }),
        kind: row.kind,
        content: row.content,
        metadata: parseStoredJson(row.metadata_json),
        deliveryMode: row.delivery_mode,
        required: row.required === 1,
        hopCount: row.hop_count,
        state: row.state,
        attemptCount: row.attempt_count,
        maxAttempts: row.max_attempts,
        availableAt: row.available_at,
        ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
        ...(row.delivered_at === null ? {} : { deliveredAt: row.delivered_at }),
        ...(row.read_at === null ? {} : { readAt: row.read_at }),
        ...(row.acked_at === null ? {} : { ackedAt: row.acked_at }),
        ...(row.dead_lettered_at === null ? {} : { deadLetteredAt: row.dead_lettered_at }),
        ...(row.dead_letter_reason === null ? {} : { deadLetterReason: row.dead_letter_reason }),
        ...(row.lease_owner === null ? {} : { leaseOwner: row.lease_owner }),
        ...(row.lease_expires_at === null ? {} : { leaseExpiresAt: row.lease_expires_at }),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        revision: row.revision,
    };
}

export function toWorkflowNodeRecord(
    row: WorkflowNodeRow,
    dependencies: readonly string[],
): WorkflowNodeRecord {
    return {
        workflowId: row.workflow_id as WorkflowId,
        nodeId: row.node_id,
        status: row.status,
        dependencies,
        input: parseStoredJson(row.input_json),
        ...(row.output_json === null ? {} : { output: parseStoredJson(row.output_json) }),
        ...(row.error === null ? {} : { error: row.error }),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        ...(row.started_at === null ? {} : { startedAt: row.started_at }),
        ...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
        revision: row.revision,
    };
}

export function toWorkflowRecord(
    row: WorkflowRow,
    nodes: readonly WorkflowNodeRecord[],
): WorkflowRecord {
    return {
        id: row.id as WorkflowId,
        rootAgentId: row.root_agent_id as AgentId,
        name: row.name,
        status: row.status,
        metadata: parseStoredJson(row.metadata_json),
        nodes,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        revision: row.revision,
    };
}
