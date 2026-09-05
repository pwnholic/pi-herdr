import type { AgentId, MessageId, ThreadId } from "./ids.ts";
import type { JsonValue } from "./validation.ts";

export const MESSAGE_KINDS = [
    "message",
    "request",
    "response",
    "control",
    "result",
    "event",
] as const;
export const MESSAGE_STATES = ["queued", "delivered", "read", "acked", "dead_letter"] as const;

export type MessageKind = (typeof MESSAGE_KINDS)[number];
export type MessageState = (typeof MESSAGE_STATES)[number];
export const MESSAGE_DELIVERY_MODES = ["steer", "followUp"] as const;
export type MessageDeliveryMode = (typeof MESSAGE_DELIVERY_MODES)[number];

export interface MailboxMessage {
    readonly id: MessageId;
    readonly rootAgentId: AgentId;
    readonly senderAgentId?: AgentId;
    readonly senderRunId?: string;
    readonly recipientRunId: string;
    readonly recipientAgentId: AgentId;
    readonly threadId: ThreadId;
    readonly replyToMessageId?: MessageId;
    readonly kind: MessageKind;
    readonly content: string;
    readonly metadata: JsonValue;
    readonly deliveryMode: MessageDeliveryMode;
    readonly required: boolean;
    readonly hopCount: number;
    readonly state: MessageState;
    readonly attemptCount: number;
    readonly maxAttempts: number;
    readonly availableAt: number;
    readonly expiresAt?: number;
    readonly deliveredAt?: number;
    readonly readAt?: number;
    readonly ackedAt?: number;
    readonly deadLetteredAt?: number;
    readonly deadLetterReason?: string;
    readonly leaseOwner?: string;
    readonly leaseExpiresAt?: number;
    readonly createdAt: number;
    readonly updatedAt: number;
    readonly revision: number;
}

export interface EnqueueMessageInput {
    readonly id?: MessageId;
    readonly senderAgentId?: AgentId;
    readonly senderRunId?: string;
    readonly recipientRunId?: string;
    readonly recipientAgentId: AgentId;
    readonly threadId?: ThreadId;
    readonly replyToMessageId?: MessageId;
    readonly kind: MessageKind;
    readonly content: string;
    readonly metadata?: JsonValue;
    readonly deliveryMode?: MessageDeliveryMode;
    readonly required?: boolean;
    readonly idempotencyKey?: string;
    readonly availableAt?: number;
    readonly expiresAt?: number;
    readonly ttlMs?: number;
    readonly maxAttempts?: number;
}

export interface EnqueueResult {
    readonly message: MailboxMessage;
    readonly deduplicated: boolean;
}

export interface MessagePage {
    readonly items: readonly MailboxMessage[];
    readonly nextCursor?: string;
}

export interface MailboxFilter {
    readonly recipientAgentId: AgentId;
    readonly states?: readonly MessageState[];
    readonly threadId?: ThreadId;
    readonly limit?: number;
    readonly cursor?: string;
}

export interface OutboxFilter {
    readonly senderAgentId: AgentId;
    readonly states?: readonly MessageState[];
    readonly threadId?: ThreadId;
    readonly limit?: number;
    readonly cursor?: string;
}

export interface MailboxStats {
    readonly rootAgentId: AgentId;
    readonly queued: number;
    readonly delivered: number;
    readonly read: number;
    readonly acknowledged: number;
    readonly deadLettered: number;
    readonly oldestPendingAt?: number;
    readonly totalPendingBytes: number;
}

export function isMessageKind(value: unknown): value is MessageKind {
    return typeof value === "string" && (MESSAGE_KINDS as readonly string[]).includes(value);
}

export function isMessageState(value: unknown): value is MessageState {
    return typeof value === "string" && (MESSAGE_STATES as readonly string[]).includes(value);
}

export function isMessageDeliveryMode(value: unknown): value is MessageDeliveryMode {
    return (
        typeof value === "string" && (MESSAGE_DELIVERY_MODES as readonly string[]).includes(value)
    );
}
