import { ValidationError } from "./errors.ts";

declare const agentIdBrand: unique symbol;
declare const messageIdBrand: unique symbol;
declare const threadIdBrand: unique symbol;
declare const workflowIdBrand: unique symbol;

export type AgentId = string & { readonly [agentIdBrand]: true };
export type MessageId = string & { readonly [messageIdBrand]: true };
export type ThreadId = string & { readonly [threadIdBrand]: true };
export type WorkflowId = string & { readonly [workflowIdBrand]: true };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseUuid<T extends string>(value: unknown, field: string): T {
    if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
        throw new ValidationError(`${field} must be a UUID`, { field });
    }
    return value.toLowerCase() as T;
}

export function createAgentId(): AgentId {
    return crypto.randomUUID() as AgentId;
}

export function parseAgentId(value: unknown): AgentId {
    return parseUuid<AgentId>(value, "agentId");
}

export function createMessageId(): MessageId {
    return crypto.randomUUID() as MessageId;
}

export function parseMessageId(value: unknown): MessageId {
    return parseUuid<MessageId>(value, "messageId");
}

export function createThreadId(): ThreadId {
    return crypto.randomUUID() as ThreadId;
}

export function parseThreadId(value: unknown): ThreadId {
    return parseUuid<ThreadId>(value, "threadId");
}

export function createWorkflowId(): WorkflowId {
    return crypto.randomUUID() as WorkflowId;
}

export function parseWorkflowId(value: unknown): WorkflowId {
    return parseUuid<WorkflowId>(value, "workflowId");
}
