import type { AgentRecord } from "../domain/agent.ts";
import type { AgentId, MessageId } from "../domain/ids.ts";
import type { EnqueueResult, MessageKind } from "../domain/mailbox.ts";
import type { JsonValue } from "../domain/validation.ts";

export interface SpawnAgentRequest {
    readonly alias: string;
    readonly displayName?: string;
    readonly role: string;
    readonly prompt: string;
    readonly cwd: string;
    readonly model?: string;
    readonly thinking?: string;
    readonly tools?: readonly string[];
    readonly metadata?: JsonValue;
}

export interface SendAgentMessageRequest {
    readonly senderAgentId?: AgentId;
    readonly recipient: AgentId | string;
    readonly kind?: MessageKind;
    readonly content: string;
    readonly idempotencyKey?: string;
    readonly metadata?: JsonValue;
    readonly replyToMessageId?: MessageId;
}

export interface SteerAgentRequest {
    readonly senderAgentId?: AgentId;
    readonly recipient: AgentId | string;
    readonly instruction: string;
    readonly idempotencyKey?: string;
}

export interface RenameAgentRequest {
    readonly agent: AgentId | string;
    readonly alias: string;
    readonly displayName?: string;
}

export interface ResumeAgentRequest {
    readonly agent: AgentId | string;
    readonly instruction?: string;
}

export interface RecoveryEntry {
    readonly agentId: AgentId;
    readonly recovered: boolean;
    readonly status?: string;
    readonly error?: string;
}

export interface SpawnAgentResult {
    readonly agent: AgentRecord;
    readonly sessionId: string;
}

export interface SteerAgentResult {
    readonly agent: AgentRecord;
    readonly delivery: EnqueueResult;
}
