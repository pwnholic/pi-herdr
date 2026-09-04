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

export interface MailboxMessage {
    readonly id: MessageId;
    readonly senderAgentId?: AgentId;
    readonly recipientAgentId: AgentId;
    readonly threadId: ThreadId;
    readonly replyToMessageId?: MessageId;
    readonly kind: MessageKind;
    readonly content: string;
    readonly metadata: JsonValue;
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
    readonly recipientAgentId: AgentId;
    readonly threadId?: ThreadId;
    readonly replyToMessageId?: MessageId;
    readonly kind: MessageKind;
    readonly content: string;
    readonly metadata?: JsonValue;
    readonly idempotencyKey?: string;
    readonly availableAt?: number;
    readonly expiresAt?: number;
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

export function isMessageKind(value: unknown): value is MessageKind {
    return typeof value === "string" && (MESSAGE_KINDS as readonly string[]).includes(value);
}

export function isMessageState(value: unknown): value is MessageState {
    return typeof value === "string" && (MESSAGE_STATES as readonly string[]).includes(value);
}
