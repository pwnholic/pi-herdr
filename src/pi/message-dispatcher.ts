import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentRecord } from "../domain/agent.ts";
import { ValidationError } from "../domain/errors.ts";
import type { AgentId } from "../domain/ids.ts";
import type { MailboxMessage } from "../domain/mailbox.ts";
import { assertJsonValue, type JsonValue, MAX_MESSAGE_BYTES } from "../domain/validation.ts";
import type { Failpoint } from "../faults.ts";
import type { AgentSupervisor } from "../orchestrator/index.ts";
import type { SqliteControlPlaneStore } from "../storage/index.ts";
import type { WorkflowEngine } from "../workflow/index.ts";
import type { MailboxDisposition } from "./mailbox-pump.ts";

interface DispatcherOptions {
    readonly active: {
        readonly store: SqliteControlPlaneStore;
        readonly identity: AgentRecord;
        readonly workflowEngine?: WorkflowEngine;
    };
    readonly message: MailboxMessage;
    readonly child: boolean;
    readonly identity: AgentId;
    readonly supervisor?: AgentSupervisor;
    readonly pi: ExtensionAPI;
    readonly hasPiMailboxMessage: (id: string) => boolean;
    readonly failpoint?: Failpoint;
}

/** Apply durable protocol effects before notifying Pi; replays resume the effect journal. */
export async function dispatchMailboxMessage(
    options: DispatcherOptions,
): Promise<MailboxDisposition> {
    const { active, message, child, identity, supervisor } = options;

    if (
        message.recipientRunId !== active.identity.runId ||
        (message.senderAgentId !== undefined &&
            active.store.getAgent(message.senderAgentId).runId !== message.senderRunId)
    ) {
        throw new ValidationError("Message belongs to a superseded assignment");
    }
    const metadata = jsonObject(message.metadata);
    const action = typeof metadata.action === "string" ? metadata.action : undefined;
    if (child && message.kind === "control" && action === "rename") {
        const displayName = metadata.displayName;
        if (typeof displayName !== "string" || displayName.length === 0) {
            throw new ValidationError("rename control is missing displayName");
        }
        options.pi.setSessionName(displayName);
        return "ack";
    }

    if (!child && message.kind === "result") {
        if (supervisor === undefined) throw new Error("Parent supervisor is unavailable");
        const sender = message.senderAgentId;
        if (sender === undefined) throw new ValidationError("result message has no sender agent");
        const status = metadata.status;
        if (status !== "succeeded" && status !== "failed") {
            throw new ValidationError("result message has an invalid completion status");
        }
        if (metadata.agentId !== undefined && metadata.agentId !== sender) {
            throw new ValidationError("result metadata agentId does not match its sender");
        }
        const record = supervisor.resolveAgent(sender);
        const declaration = active.store.getCompletion(record.id);
        const completionToken = metadata.completionToken;
        if (
            typeof completionToken !== "string" ||
            declaration?.invocationToken !== completionToken ||
            declaration.runId !== message.senderRunId ||
            declaration.messageId !== message.id
        ) {
            throw new ValidationError("Result does not match its durable completion declaration");
        }
        const workflowEngine = active.workflowEngine;
        const store = active.store;
        let effect = store.beginMailboxEffect(message.id, "completion");
        if (effect.state === "applying") {
            options.failpoint?.("completion.apply.before", { messageId: message.id });
            if (workflowEngine !== undefined && hasWorkflowBinding(record)) {
                const completion = parseCompletionResult(message.content);
                await workflowEngine.acceptCompletion({
                    agentId: record.id,
                    status,
                    result: completion,
                    ...(status === "failed" ? { error: completionSummary(completion) } : {}),
                });
            }
            const current = store.getAgent(record.id);
            if (current.runId !== message.senderRunId)
                throw new ValidationError("Completion assignment changed during application");
            const terminal = status === "succeeded" ? "completed" : "failed";
            if (current.status !== terminal)
                store.transitionAgent({
                    agentId: record.id,
                    status: terminal,
                    patch: {},
                    expectedRevision: current.revision,
                });
            if (completionToken !== undefined) {
                store.markCompletionParentApplied(record.id, completionToken);
            }
            effect = store.advanceMailboxEffect(message.id, "applied");
            options.failpoint?.("completion.apply.after", { messageId: message.id });
        }
        if (effect.state === "applied") {
            if (options.hasPiMailboxMessage(message.id)) {
                await workflowEngine?.tick();
                store.advanceMailboxEffect(message.id, "notified");
                return "ack";
            }
            await supervisor.finalizeCompletedAgent(record.id);
            options.failpoint?.("completion.notification.before", { messageId: message.id });
            options.pi.sendMessage(mailboxCustomMessage(message, true), {
                triggerTurn: true,
                deliverAs: message.deliveryMode,
            });
            options.failpoint?.("completion.notification.after", { messageId: message.id });
            await workflowEngine?.tick();
            store.advanceMailboxEffect(message.id, "notified");
        }
        return "ack";
    }

    if (message.recipientAgentId !== identity) {
        throw new ValidationError("Mailbox dispatcher received a message for another agent");
    }
    if (options.hasPiMailboxMessage(message.id)) return "read";
    options.failpoint?.("mailbox.injection.before", { messageId: message.id });
    options.pi.sendMessage(mailboxCustomMessage(message), {
        triggerTurn: true,
        deliverAs: message.deliveryMode,
    });
    options.failpoint?.("mailbox.injection.after", { messageId: message.id });
    return "read";
}

function jsonObject(value: JsonValue): Readonly<Record<string, JsonValue>> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Readonly<Record<string, JsonValue>>)
        : {};
}

function hasWorkflowBinding(agent: AgentRecord): boolean {
    const binding = jsonObject(agent.metadata).piHerdrWorkflow;
    return typeof binding === "object" && binding !== null && !Array.isArray(binding);
}

function parseCompletionResult(content: string): JsonValue {
    let parsed: unknown;
    try {
        parsed = JSON.parse(content);
    } catch (cause) {
        throw new ValidationError("result message content is not valid JSON", {
            cause: cause instanceof Error ? cause.message : String(cause),
        });
    }
    assertJsonValue(parsed, "result.content", MAX_MESSAGE_BYTES);
    return parsed;
}

function completionSummary(completion: JsonValue): string {
    const summary = jsonObject(completion).summary;
    return typeof summary === "string" ? summary : "Agent reported failure";
}

function mailboxCustomMessage(message: MailboxMessage, automaticallyAcknowledged = false) {
    const sender = message.senderAgentId ?? "system";
    return {
        customType: "pi-herdr-mail",
        content: automaticallyAcknowledged
            ? `[Pi Herdr mail ${message.id} from ${sender}; kind=${message.kind}; acknowledged after durable completion handling]\n${message.content}`
            : `[Pi Herdr mail ${message.id} from ${sender}; kind=${message.kind}]\n${message.content}\n\nAcknowledge after processing with agent_mail_ack({ messageId: "${message.id}" }).`,
        display: true,
        details: {
            messageId: message.id,
            senderAgentId: sender,
            kind: message.kind,
            threadId: message.threadId,
        },
    };
}
