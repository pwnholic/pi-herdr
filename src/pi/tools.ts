import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { parseWorkflowId } from "../domain/ids.ts";
import type { JsonValue } from "../domain/validation.ts";
import type { PiHerdrRuntime } from "./runtime.ts";

const MessageKindSchema = Type.Union([
    Type.Literal("message"),
    Type.Literal("request"),
    Type.Literal("response"),
    Type.Literal("control"),
    Type.Literal("result"),
    Type.Literal("event"),
]);

const MessageStateSchema = Type.Union([
    Type.Literal("queued"),
    Type.Literal("delivered"),
    Type.Literal("read"),
    Type.Literal("acked"),
    Type.Literal("dead_letter"),
]);

const AgentStatusSchema = Type.Union([
    Type.Literal("registered"),
    Type.Literal("starting"),
    Type.Literal("running"),
    Type.Literal("idle"),
    Type.Literal("blocked"),
    Type.Literal("interrupted"),
    Type.Literal("stopping"),
    Type.Literal("stopped"),
    Type.Literal("completed"),
    Type.Literal("failed"),
    Type.Literal("orphaned"),
]);

export function registerPiHerdrTools(
    pi: ExtensionAPI,
    runtime: PiHerdrRuntime,
    childProcess: boolean,
): void {
    pi.registerTool({
        name: "agent_mail_send",
        label: "Send agent mail",
        description:
            "Durably send a direct message to another Pi Herdr agent by immutable id or current alias.",
        promptSnippet: "Send durable direct mail to another agent.",
        promptGuidelines: [
            "Use agent_mail_send for direct agent-to-agent communication; recipients process messages without a parent relay.",
        ],
        parameters: Type.Object({
            recipient: Type.String({ minLength: 1 }),
            content: Type.String({ minLength: 1 }),
            kind: Type.Optional(MessageKindSchema),
            idempotencyKey: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
            replyToMessageId: Type.Optional(Type.String({ format: "uuid" })),
        }),
        executionMode: "sequential",
        async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
            const result = runtime.sendMail(params);
            return toolResult("agent_mail_send", result, `Queued message ${result.message.id}`);
        },
    });

    pi.registerTool({
        name: "agent_mail_list",
        label: "List agent mail",
        description: "List this process agent's durable inbox, including read and unacked mail.",
        promptSnippet: "Inspect the current agent's durable inbox.",
        parameters: Type.Object({
            states: Type.Optional(Type.Array(MessageStateSchema, { uniqueItems: true })),
            limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
            cursor: Type.Optional(Type.String({ minLength: 1 })),
        }),
        async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
            const result = runtime.listMail(params);
            return toolResult(
                "agent_mail_list",
                result,
                `${result.items.length} mailbox message(s)`,
            );
        },
    });

    pi.registerTool({
        name: "agent_mail_read",
        label: "Read agent mail",
        description: "Read one durable inbox message after the local pump has accepted it.",
        parameters: Type.Object({ messageId: Type.String({ format: "uuid" }) }),
        executionMode: "sequential",
        async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
            const result = await runtime.readMail(params.messageId);
            return toolResult("agent_mail_read", result, result.content);
        },
    });

    pi.registerTool({
        name: "agent_mail_ack",
        label: "Acknowledge agent mail",
        description:
            "Acknowledge a processed inbox message. Call only after its requested work was handled.",
        promptSnippet: "Acknowledge mail only after processing it.",
        parameters: Type.Object({ messageId: Type.String({ format: "uuid" }) }),
        executionMode: "sequential",
        async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
            const result = await runtime.acknowledgeMail(params.messageId);
            return toolResult("agent_mail_ack", result, `Acknowledged ${result.id}`);
        },
    });

    if (childProcess)
        pi.registerTool({
            name: "agent_complete",
            label: "Complete assigned work",
            description:
                "Child-only explicit completion declaration. The durable result is emitted only after Pi fully settles.",
            promptSnippet: "Declare child work complete with a structured result.",
            promptGuidelines: [
                "Call agent_complete exactly once only when assigned work is genuinely complete; Escape or a normal settled turn is not completion.",
            ],
            parameters: Type.Object({
                status: Type.Union([Type.Literal("succeeded"), Type.Literal("failed")]),
                summary: Type.String({ minLength: 1 }),
                details: Type.Optional(Type.Unknown()),
                artifacts: Type.Optional(
                    Type.Array(
                        Type.Object({
                            path: Type.String({ minLength: 1 }),
                            description: Type.Optional(Type.String({ minLength: 1 })),
                        }),
                        { maxItems: 256 },
                    ),
                ),
            }),
            executionMode: "sequential",
            async execute(toolCallId, params, _signal, _onUpdate, _ctx) {
                const completion = runtime.declareCompletion(
                    {
                        status: params.status,
                        summary: params.summary,
                        ...(params.details === undefined
                            ? {}
                            : { details: params.details as JsonValue }),
                        ...(params.artifacts === undefined ? {} : { artifacts: params.artifacts }),
                    },
                    toolCallId,
                );
                return {
                    ...toolResult(
                        "agent_complete",
                        completion,
                        "Completion recorded; durable delivery will occur after agent_settled.",
                    ),
                    terminate: true,
                };
            },
        });

    if (!childProcess) registerParentTools(pi, runtime);
}

function registerParentTools(pi: ExtensionAPI, runtime: PiHerdrRuntime): void {
    pi.registerTool({
        name: "agent_spawn",
        label: "Spawn Pi Herdr agent",
        description: "Parent-only: launch a durable Pi subagent in its own native Herdr tab.",
        promptSnippet: "Spawn a durable subagent with a stable id and mutable alias.",
        parameters: Type.Object({
            alias: Type.String({ minLength: 1, maxLength: 32 }),
            displayName: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
            role: Type.String({ minLength: 1, maxLength: 128 }),
            prompt: Type.String({ minLength: 1 }),
            cwd: Type.String({ minLength: 1 }),
            model: Type.Optional(Type.String({ minLength: 1 })),
            thinking: Type.Optional(Type.String({ minLength: 1 })),
            tools: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true })),
        }),
        executionMode: "sequential",
        async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
            const { supervisor } = runtime.requireParent();
            const result = await supervisor.spawn(params, signal);
            return toolResult("agent_spawn", result, `Spawned ${result.agent.alias}`);
        },
    });

    pi.registerTool({
        name: "agent_steer",
        label: "Steer Pi Herdr agent",
        description:
            "Parent-only: durably queue one corrective instruction for live steering. This does not stop the agent.",
        promptSnippet: "Correct a running or interrupted child without manual resume.",
        parameters: Type.Object({
            agent: Type.String({ minLength: 1 }),
            instruction: Type.String({ minLength: 1 }),
            idempotencyKey: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
        }),
        executionMode: "sequential",
        async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
            const { supervisor, identity } = runtime.requireParent();
            const result = await supervisor.steer(
                {
                    senderAgentId: identity.id,
                    recipient: params.agent,
                    instruction: params.instruction,
                    ...(params.idempotencyKey === undefined
                        ? {}
                        : { idempotencyKey: params.idempotencyKey }),
                },
                signal,
            );
            return toolResult(
                "agent_steer",
                result,
                `Queued correction ${result.delivery.message.id}`,
            );
        },
    });

    pi.registerTool({
        name: "agent_interrupt",
        label: "Interrupt Pi Herdr agent",
        description:
            "Parent-only: interrupt the current child turn while keeping its process and session resumable.",
        parameters: Type.Object({ agent: Type.String({ minLength: 1 }) }),
        executionMode: "sequential",
        async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
            const result = await runtime.requireParent().supervisor.interrupt(params.agent, signal);
            return toolResult("agent_interrupt", result, `Interrupted ${result.alias}`);
        },
    });

    pi.registerTool({
        name: "agent_rename",
        label: "Rename Pi Herdr agent",
        description:
            "Parent-only: atomically rename the durable alias, Herdr agent, tab, pane, and Pi session display name.",
        parameters: Type.Object({
            agent: Type.String({ minLength: 1 }),
            alias: Type.String({ minLength: 1, maxLength: 32 }),
            displayName: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
        }),
        executionMode: "sequential",
        async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
            const result = await runtime.requireParent().supervisor.rename(params, signal);
            return toolResult("agent_rename", result, `Renamed agent to ${result.alias}`);
        },
    });

    pi.registerTool({
        name: "agent_stop",
        label: "Stop Pi Herdr agent",
        description: "Parent-only: explicitly stop and close a child agent's owned Herdr tab.",
        parameters: Type.Object({ agent: Type.String({ minLength: 1 }) }),
        executionMode: "sequential",
        async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
            const result = await runtime.requireParent().supervisor.stop(params.agent, signal);
            return toolResult("agent_stop", result, `Stopped ${result.alias}`);
        },
    });

    pi.registerTool({
        name: "agent_resume",
        label: "Resume Pi Herdr agent",
        description: "Parent-only: resume a stopped durable Pi session or steer a live child.",
        parameters: Type.Object({
            agent: Type.String({ minLength: 1 }),
            instruction: Type.Optional(Type.String({ minLength: 1 })),
        }),
        executionMode: "sequential",
        async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
            const result = await runtime.requireParent().supervisor.resume(params, signal);
            return toolResult("agent_resume", result, `Agent ${result.alias} is ${result.status}`);
        },
    });

    pi.registerTool({
        name: "agents_list",
        label: "List Pi Herdr agents",
        description: "Parent-only: list live and historical durable agent records.",
        promptSnippet: "Inspect durable agent state and identifiers.",
        parameters: Type.Object({
            status: Type.Optional(AgentStatusSchema),
            limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
            cursor: Type.Optional(Type.String({ minLength: 1 })),
        }),
        async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
            const result = runtime.requireParent().store.listAgents(params);
            return toolResult("agents_list", result, `${result.items.length} agent(s)`);
        },
    });

    pi.registerTool({
        name: "workflow_start",
        label: "Start durable workflow",
        description: "Parent-only: create and schedule a validated durable DAG workflow.",
        parameters: Type.Object({
            name: Type.String({ minLength: 1, maxLength: 128 }),
            nodes: Type.Array(
                Type.Object({
                    nodeId: Type.String({ minLength: 1, maxLength: 128 }),
                    dependencies: Type.Optional(
                        Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
                            uniqueItems: true,
                        }),
                    ),
                    task: Type.Object({
                        alias: Type.String({ minLength: 1, maxLength: 32 }),
                        role: Type.String({ minLength: 1, maxLength: 128 }),
                        prompt: Type.String({ minLength: 1 }),
                        cwd: Type.String({ minLength: 1 }),
                        displayName: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
                        model: Type.Optional(Type.String({ minLength: 1 })),
                        thinking: Type.Optional(Type.String({ minLength: 1 })),
                        tools: Type.Optional(
                            Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true }),
                        ),
                    }),
                }),
                { minItems: 1, maxItems: 1000 },
            ),
        }),
        executionMode: "sequential",
        async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
            const { workflowEngine } = runtime.requireParent();
            const workflow = workflowEngine.start({
                name: params.name,
                nodes: params.nodes.map((node) => ({
                    nodeId: node.nodeId,
                    ...(node.dependencies === undefined ? {} : { dependencies: node.dependencies }),
                    task: node.task,
                })),
            });
            const tick = await workflowEngine.tick(signal);
            return toolResult(
                "workflow_start",
                { workflow: workflowEngine.getStatus(workflow.id), tick },
                `Started workflow ${workflow.id}`,
            );
        },
    });

    pi.registerTool({
        name: "workflow_status",
        label: "Get workflow status",
        description: "Parent-only: read one durable workflow and all DAG node states.",
        parameters: Type.Object({ workflowId: Type.String({ format: "uuid" }) }),
        async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
            const result = runtime
                .requireParent()
                .workflowEngine.getStatus(parseWorkflowId(params.workflowId));
            return toolResult("workflow_status", result, `Workflow is ${result.status}`);
        },
    });

    pi.registerTool({
        name: "workflow_list",
        label: "List workflows",
        description: "Parent-only: list durable workflows.",
        parameters: Type.Object({
            limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
            cursor: Type.Optional(Type.String({ minLength: 1 })),
        }),
        async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
            const result = runtime.requireParent().store.listWorkflows(params);
            return toolResult("workflow_list", result, `${result.items.length} workflow(s)`);
        },
    });

    pi.registerTool({
        name: "workflow_cancel",
        label: "Cancel workflow",
        description: "Parent-only: cancel a pending or running durable workflow.",
        parameters: Type.Object({ workflowId: Type.String({ format: "uuid" }) }),
        executionMode: "sequential",
        async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
            const result = await runtime
                .requireParent()
                .workflowEngine.cancel(parseWorkflowId(params.workflowId), signal);
            return toolResult(
                "workflow_cancel",
                result,
                `Cancelled workflow ${result.workflow.id}`,
            );
        },
    });
}

function toolResult<T>(tool: string, data: T, message: string) {
    return {
        content: [{ type: "text" as const, text: message }],
        details: { tool, data },
    };
}
