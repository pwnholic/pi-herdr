import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { parseWorkflowId } from "../domain/ids.ts";
import type { JsonValue } from "../domain/validation.ts";
import type { PiHerdrRuntime } from "./runtime.ts";
import { modelToolResult } from "./tool-output.ts";

const MessageKindSchema = Type.Union(
    [
        Type.Literal("message"),
        Type.Literal("request"),
        Type.Literal("response"),
        Type.Literal("event"),
    ],
    {
        description:
            "message (default) for information; request when asking for work/an answer; response only when replying to a request via replyToMessageId; event for an informational update. Internal control/result kinds are forbidden here.",
        default: "message",
    },
);

const MessageStateSchema = Type.Union(
    [
        Type.Literal("queued"),
        Type.Literal("delivered"),
        Type.Literal("read"),
        Type.Literal("acked"),
        Type.Literal("dead_letter"),
    ],
    {
        description:
            "Durable delivery receipt: queued, delivered, read, acked, or dead_letter. read is not acknowledgement.",
    },
);

const AgentStatusSchema = Type.Union(
    [
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
    ],
    {
        description:
            "Optional registry state filter. registered/starting are not readiness; running means working; idle/blocked/interrupted preserve a live session; stopping/stopped indicate termination; completed/failed are terminal assignments; orphaned needs recovery.",
    },
);

// Parameter provenance is part of the model contract. Never ask the model to invent registry IDs.
const AgentReference = Type.String({
    minLength: 1,
    maxLength: 36,
    description:
        "Immutable agent UUID copied from agent_directory.items[].id, agents_list.items[].id, or agent_spawn.agent.id; current alias also accepted. Prefer UUID. NOT a sessionId, runId, display name, or /root/... path.",
});
const InboxMessageId = Type.String({
    format: "uuid",
    description:
        "Incoming message UUID copied from agent_mail_list.items[].id or the Pi Herdr mail notice. Must belong to your inbox; do not supply an agent, thread, or sent-message ID.",
});
const RetryMessageId = Type.String({
    format: "uuid",
    description:
        "Dead-letter message UUID from agent_mail_sent.items[].id or parent agent_mail_dead_letters.items[].id. Inspect its failure reason first; only sender-owned (or parent namespace) messages are retryable.",
});
const WorkflowId = Type.String({
    format: "uuid",
    description:
        "Existing workflow UUID copied from workflow_start.workflow.id or workflow_list.items[].id. This is NOT a nodeId or agent ID.",
});
const Alias = Type.String({
    minLength: 1,
    maxLength: 32,
    pattern: "^[a-z][a-z0-9_-]*$",
    description:
        "A caller-chosen alias, unique in this coordinator namespace: 1-32 lowercase letters/digits/_/-, starting with a letter; e.g. durable_store. No spaces or /root/ prefix. Check agent_directory/agents_list first.",
});
const DisplayName = Type.String({
    minLength: 1,
    maxLength: 128,
    description:
        "Optional human-readable UI label, e.g. Durable Store. No leading/trailing whitespace. Defaults to alias; not a routing identifier.",
});
const IdempotencyKey = Type.String({
    minLength: 1,
    maxLength: 128,
    description:
        "Optional caller-chosen stable key for ONE logical send, e.g. review-request-1. Reuse unchanged for identical retries; use a new key when recipient/content/kind/reply changes. Do not regenerate a timestamp on each retry.",
});
const Instruction = Type.String({
    minLength: 1,
    maxLength: 1048576,
    description:
        "Nonempty, self-contained correction or continuation: say what changed and what should happen next. UTF-8 byte limit is PI_HERDR_MAX_MESSAGE_BYTES (default 65536); prefer concise text and artifact paths.",
});
const PageFields = {
    limit: Type.Optional(
        Type.Integer({
            minimum: 1,
            maximum: 100,
            default: 50,
            description:
                "Records per page: 1-100, default 50. Use smaller pages if output is abbreviated.",
        }),
    ),
    cursor: Type.Optional(
        Type.String({
            minLength: 1,
            description:
                "Opaque nextCursor copied verbatim from the previous result of THIS list tool, with the same filters. Omit for the first page; never construct or reuse a cursor from another list.",
        }),
    ),
};
const MailFilters = {
    states: Type.Optional(
        Type.Array(MessageStateSchema, {
            minItems: 1,
            maxItems: 5,
            uniqueItems: true,
            description:
                "Optional 1-5 distinct receipt states: queued (waiting), delivered (leased), read (awaiting ack), acked (acknowledged), dead_letter (failed). Omit for all states; [] is invalid.",
        }),
    ),
    ...PageFields,
    threadId: Type.Optional(
        Type.String({
            format: "uuid",
            description:
                "Optional threadId copied from agent_mail_send.message.threadId or inbox/read/outbox records. Filters an existing conversation; do not invent or substitute replyToMessageId.",
        }),
    ),
};
const TaskFields = {
    alias: Alias,
    displayName: Type.Optional(DisplayName),
    role: Type.String({
        minLength: 1,
        maxLength: 128,
        description:
            "Caller-chosen concise specialization, e.g. storage, reviewer, or implementation. Nonempty with no leading/trailing whitespace; this is a label, not an installed skill or model ID.",
    }),
    prompt: Type.String({
        minLength: 1,
        maxLength: 65536,
        description:
            "Self-contained assignment: objective, context, exact owned files/responsibilities, constraints, expected artifacts, and verification. Tell the worker it shares the codebase and must not revert peers' edits. No surrounding whitespace for workflow tasks; default content limit is 65536 UTF-8 bytes.",
    }),
    cwd: Type.String({
        minLength: 1,
        maxLength: 4096,
        description:
            "Existing absolute working directory from the current workspace/user's requested repo, e.g. /absolute/project. Resolve it before spawning; no relative path or literal ~. Workers using the same cwd share files; this does not create a git worktree.",
    }),
    model: Type.Optional(
        Type.String({
            minLength: 1,
            maxLength: 256,
            description:
                "Optional configured Pi CLI model selector, normally provider/model-id, copied from the user's Pi configuration or pi --list-models. Omit to use Pi defaults if unknown. Never guess a model to fix a launch error; authentication/provider availability is still required.",
        }),
    ),
    thinking: Type.Optional(
        Type.Union(
            ["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((level) =>
                Type.Literal(level),
            ),
            {
                description:
                    "Optional Pi reasoning level: off, minimal, low, medium, high, xhigh, or max. Omit for Pi defaults; model capabilities may clamp the requested level.",
            },
        ),
    ),
    tools: Type.Optional(
        Type.Array(
            Type.String({
                minLength: 1,
                maxLength: 128,
                pattern: "^[A-Za-z][A-Za-z0-9_-]*$",
                description:
                    "Exact available Pi tool name, e.g. read, bash, edit, or write; not a shell command, skill, or file path.",
            }),
            {
                maxItems: 128,
                uniqueItems: true,
                description:
                    "Optional allowlist of up to 128 unique available tool names. Omit for Pi defaults; [] requests only the mandatory child protocol tools. The supervisor always adds mail/discovery/completion tools.",
            },
        ),
    ),
};
const NodeId = Type.String({
    minLength: 1,
    maxLength: 128,
    pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$",
    description:
        "Caller-chosen node key unique inside this workflow, e.g. research or build. Starts with a letter/digit; remaining characters may include . _ -. NOT an agent or workflow UUID.",
});

export function registerPiHerdrTools(
    pi: ExtensionAPI,
    runtime: PiHerdrRuntime,
    childProcess: boolean,
): void {
    if (!childProcess) {
        pi.registerTool({
            name: "agent_events",
            label: "Inspect agent event timeline",
            description:
                "Inspect the parent's durable, namespace-scoped event timeline after a lifecycle or delivery problem. Returns items, nextAfter, and hasMore; it does not deliver or acknowledge messages.",
            promptSnippet: "Inspect durable lifecycle and mail events.",
            promptGuidelines: [
                "Use agent_events after agent_diagnostics or agent_mail_status reveals a problem; copy entityId from an agent, message, or workflow result and continue with nextAfter, not a fabricated cursor.",
            ],
            parameters: Type.Object(
                {
                    after: Type.Optional(
                        Type.Integer({
                            minimum: 0,
                            default: 0,
                            description:
                                "Event sequence to start AFTER. Omit or use 0 initially; copy nextAfter from the previous agent_events result for the same entity filter.",
                        }),
                    ),
                    limit: PageFields.limit,
                    entityId: Type.Optional(
                        Type.String({
                            minLength: 1,
                            maxLength: 256,
                            description:
                                "Optional immutable agent, message, or workflow ID from its discovery/result tool. Filters that entity's history in this namespace; omit for all entities.",
                        }),
                    ),
                },
                { additionalProperties: false },
            ),
            async execute(_id, params) {
                const result = runtime.events(params);
                return toolResult("agent_events", result, `${result.items.length} event(s)`);
            },
        });
        pi.registerTool({
            name: "agent_diagnostics",
            label: "Inspect control-plane diagnostics",
            description:
                "Read-only parent startup/troubleshooting check for SQLite schema and integrity, queue health, extension paths, and managed Herdr context. No parameters; pass {}. Does not prove live UI behavior or modify processes.",
            promptSnippet: "Check database and Herdr integration before troubleshooting.",
            promptGuidelines: [
                "Use agent_diagnostics when spawn fails, tools conflict, or Herdr shows an unexpected status; diagnose the returned error instead of repeatedly spawning agents with guessed models.",
            ],
            parameters: Type.Object(
                {},
                {
                    additionalProperties: false,
                    description: "No parameters; pass {} for a read-only integration check.",
                },
            ),
            async execute() {
                return toolResult(
                    "agent_diagnostics",
                    runtime.diagnostics(),
                    "Control-plane diagnostics",
                );
            },
        });
    }
    pi.registerTool({
        name: "agent_mail_send",
        label: "Send agent mail",
        description:
            "Send durable ordinary mail directly to a discovered same-namespace agent. Discover first with agent_directory; copy items[].id into recipient. Returns message.id, threadId, receipt state, and delivery contract. Does not wait for processing. Use agent_steer for parent corrections and agent_complete for final worker results.",
        promptSnippet: "Send direct peer mail; discovery → send → receipt.",
        promptGuidelines: [
            "Use agent_directory before agent_mail_send if the recipient ID is unknown; /root/... is a display path, not a recipient ID.",
            "Use agent_mail_send with kind=response and replyToMessageId from the incoming request when replying; reuse one idempotencyKey only for identical retries of the same logical message.",
        ],
        parameters: Type.Object(
            {
                recipient: AgentReference,
                content: Type.String({
                    minLength: 1,
                    maxLength: 1048576,
                    description:
                        "Plain-text message or JSON encoded as a string. State the request/context clearly; never include credentials. Default limit 65536 UTF-8 bytes, enforced by configured PI_HERDR_MAX_MESSAGE_BYTES. Sending does not mean it was processed.",
                }),
                kind: Type.Optional(MessageKindSchema),
                idempotencyKey: Type.Optional(IdempotencyKey),
                replyToMessageId: Type.Optional(
                    Type.String({
                        format: "uuid",
                        description:
                            "Original incoming message UUID from agent_mail_read or inbox listing. Required for kind=response and must reference a request sent by the recipient to you in the same run. Omit for a new conversation.",
                    }),
                ),
            },
            { additionalProperties: false },
        ),
        executionMode: "sequential",
        async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
            const result = runtime.sendMail(params);
            return toolResult(
                "agent_mail_send",
                result,
                `Interacted with \`${result.recipient.path}\` — queued message ${result.message.id}`,
            );
        },
    });

    pi.registerTool({
        name: "agent_mail_list",
        label: "List agent mail",
        description:
            "List your own durable inbox without acknowledging it. Start with {} or states=[queued,delivered,read]; copy items[].id into agent_mail_read. Returns items and optional nextCursor. Listing alone does not acquire a processing lease.",
        promptSnippet: "Find incoming message IDs before reading.",
        promptGuidelines: [
            "Use agent_mail_list → agent_mail_read → handle requested work or send a reply → agent_mail_ack; do not acknowledge just because a message appeared in the list.",
        ],
        parameters: Type.Object(MailFilters, { additionalProperties: false }),
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
        name: "agent_mail_sent",
        label: "List sent agent mail",
        description:
            "List your own sent messages and their durable delivery receipts. Use message.id from agent_mail_send to locate its record. acked means recipient acknowledgement; queued/read do not mean completion. Returns items and optional nextCursor.",
        promptSnippet: "Check sent-message receipts instead of resending.",
        promptGuidelines: [
            "Use agent_mail_sent after agent_mail_send to distinguish queued, read, acked, and dead_letter; inspect failure reasons before agent_mail_retry and avoid tight polling loops.",
        ],
        parameters: Type.Object(MailFilters, { additionalProperties: false }),
        async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
            const result = runtime.listSentMail(params);
            return toolResult("agent_mail_sent", result, `${result.items.length} sent message(s)`);
        },
    });

    pi.registerTool({
        name: "agent_mail_retry",
        label: "Retry dead-lettered agent mail",
        description:
            "Requeue one eligible dead_letter message you sent; the parent may retry same-namespace messages. Get messageId and failure reason from agent_mail_sent or agent_mail_dead_letters first. Does not create a different logical message. Superseded-run traffic and terminal recipients cannot be retried.",
        promptSnippet: "Retry an inspected, recoverable dead letter.",
        promptGuidelines: [
            "Use agent_mail_retry only after addressing the failure reported by agent_mail_sent or agent_mail_dead_letters; create new work explicitly rather than retrying superseded-assignment messages.",
        ],
        parameters: Type.Object({ messageId: RetryMessageId }, { additionalProperties: false }),
        executionMode: "sequential",
        async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
            const result = runtime.retryDeadLetter(params.messageId);
            return toolResult("agent_mail_retry", result, `Requeued ${result.id}`);
        },
    });

    if (!childProcess)
        pi.registerTool({
            name: "agent_mail_dead_letters",
            label: "List dead-lettered agent mail",
            description:
                "Parent-only read-only list of failed, expired, or superseded namespace messages. Returns IDs, durable failure reasons, revisions, and optional nextCursor. Use this to choose whether a retry is appropriate; no automatic requeue occurs.",
            promptSnippet: "Inspect namespace dead letters before retry.",
            promptGuidelines: [
                "Use agent_mail_dead_letters after agent_mail_status reports failures; distinguish recoverable delivery failures from superseded_assignment, which agent_mail_retry must reject.",
            ],
            parameters: Type.Object(PageFields, { additionalProperties: false }),
            async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
                const result = runtime.listDeadLetters(params);
                return toolResult(
                    "agent_mail_dead_letters",
                    result,
                    `${result.items.length} dead-lettered message(s)`,
                );
            },
        });

    if (!childProcess)
        pi.registerTool({
            name: "agent_mail_status",
            label: "Inspect mailbox health",
            description:
                "Parent-only read-only queue summary: queued/delivered/read/acked/dead-letter counts, pending bytes, and oldest pending timestamp. Pass {}. Use agent_mail_dead_letters or agent_events for individual failures.",
            promptSnippet: "Inspect queue pressure and pending delivery.",
            promptGuidelines: [
                "Use agent_mail_status for queue health, agent_mail_sent for your own receipts, and agent_events for the event timeline; none of these means the requested work is complete.",
            ],
            parameters: Type.Object(
                {},
                {
                    additionalProperties: false,
                    description:
                        "No parameters; pass {} for this parent's namespace queue summary.",
                },
            ),
            async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
                const result = runtime.mailboxStatus();
                return toolResult(
                    "agent_mail_status",
                    result,
                    `${result.queued} queued message(s)`,
                );
            },
        });

    pi.registerTool({
        name: "agent_directory",
        label: "List authorized Pi Herdr peers",
        description:
            "Read-only peer discovery available to every agent in the current coordinator namespace. Call {} first when you do not know a recipient. Returns items[].id, runId, current alias, role, status, and optional nextCursor. Reuse immutable IDs after a rename; never invent agent IDs.",
        promptSnippet: "Discover authorized peers and immutable routing IDs.",
        promptGuidelines: [
            "Use agent_directory before direct mail and after an alias lookup fails; choose an existing peer's immutable items[].id, not its display name, session ID, runId, or /root/... path.",
        ],
        parameters: Type.Object(PageFields, { additionalProperties: false }),
        async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
            const result = runtime.listPeers(params);
            return toolResult("agent_directory", result, `${result.items.length} peer(s)`);
        },
    });

    pi.registerTool({
        name: "agent_mail_read",
        label: "Read agent mail",
        description:
            "Read one message from your own inbox with an active processing lease, or reread an acknowledged message. Get messageId from agent_mail_list or an injected Pi Herdr mail notice. Reads content in chunks and returns nextOffset when more remains; does not acknowledge. A later message may be blocked by an earlier unacked message in the same lane.",
        promptSnippet: "Read incoming mail; follow nextOffset before processing.",
        promptGuidelines: [
            "Use agent_mail_read on an inbox message ID, read all needed chunks via nextOffset, then handle its work before agent_mail_ack; if FIFO or lease ownership blocks the read, inspect earlier inbox messages instead of bypassing ownership.",
        ],
        parameters: Type.Object(
            {
                messageId: InboxMessageId,
                offset: Type.Optional(
                    Type.Integer({
                        minimum: 0,
                        default: 0,
                        description:
                            "UTF-16 character offset into content. Omit for the first chunk; copy nextOffset from the previous agent_mail_read result for this message. Not a byte offset or list cursor.",
                    }),
                ),
                limit: Type.Optional(
                    Type.Integer({
                        minimum: 1,
                        maximum: 8192,
                        default: 8192,
                        description:
                            "Content characters per read, 1-8192 (default 8192). Follow nextOffset until all needed content is read before processing/acknowledging.",
                    }),
                ),
            },
            { additionalProperties: false },
        ),
        executionMode: "sequential",
        async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
            const result = await runtime.readMail(params.messageId);
            const offset = params.offset ?? 0;
            const end = Math.min(result.content.length, offset + (params.limit ?? 8192));
            return toolResult(
                "agent_mail_read",
                {
                    id: result.id,
                    senderAgentId: result.senderAgentId,
                    senderRunId: result.senderRunId,
                    recipientAgentId: result.recipientAgentId,
                    recipientRunId: result.recipientRunId,
                    threadId: result.threadId,
                    kind: result.kind,
                    state: result.state,
                    required: result.required,
                    content: result.content.slice(offset, end),
                    offset,
                    contentCharacters: result.content.length,
                    ...(end < result.content.length ? { nextOffset: end } : {}),
                },
                `Read ${result.id}`,
            );
        },
    });

    pi.registerTool({
        name: "agent_mail_ack",
        label: "Acknowledge agent mail",
        description:
            "Acknowledge an incoming message after its requested work has been handled. Get messageId from agent_mail_read or the received mail notice, not from your outbox. Returns the acknowledged receipt. Releases the lane head; does not send a reply or complete your assignment.",
        promptSnippet: "Acknowledge processed incoming mail, not sent mail.",
        promptGuidelines: [
            "Call agent_mail_ack only after processing agent_mail_read content and sending any required reply; use agent_complete separately for final assignment completion.",
        ],
        parameters: Type.Object({ messageId: InboxMessageId }, { additionalProperties: false }),
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
                "Worker-only final result declaration, not a progress update. Use status=succeeded only when assigned work and required mail are handled; status=failed reports a terminal failure. Call this alone in its tool batch. Persists a frozen result and requests termination; publication requires eligible Pi settlement. An interrupted, superseded, or later-turn-invalidated declaration must be reconsidered before redeclaring.",
            promptSnippet: "Finish a worker assignment with an explicit durable result.",
            promptGuidelines: [
                "Before agent_complete, inspect agent_mail_list and handle/ack required instructions; report the actual summary and artifact paths, not just an intention to work.",
                "Use agent_mail_send for progress or peer responses before completion. Call agent_complete alone in its batch: Pi may execute other tools in a mixed batch despite its termination request. Protocol writes are frozen after declaration until a new model turn invalidates the draft.",
            ],
            parameters: Type.Object(
                {
                    status: Type.Union([Type.Literal("succeeded"), Type.Literal("failed")], {
                        description:
                            "succeeded only after assigned work and required inbox instructions are handled; failed for a terminal task failure. Do not use for progress, waiting, or interruption.",
                    }),
                    summary: Type.String({
                        minLength: 1,
                        maxLength: 1048576,
                        description:
                            "Concise truthful final result or failure reason, without surrounding whitespace. Include what was verified and any limitations. Full structured result limit defaults to 262144 UTF-8 bytes.",
                    }),
                    details: Type.Optional(
                        Type.Unknown({
                            description:
                                "Optional JSON-only supporting result: strings, finite numbers, booleans, null, arrays, or plain objects. No undefined, functions, NaN, cycles, or secrets. Use artifact references for large outputs; shares the completion byte budget.",
                        }),
                    ),
                    artifacts: Type.Optional(
                        Type.Array(
                            Type.Object(
                                {
                                    path: Type.String({
                                        minLength: 1,
                                        description:
                                            "Actual produced/referenced artifact path, preferably absolute or clearly relative to the worker cwd. Obtain it from completed work; do not invent a file. This reference does not upload or verify the file.",
                                    }),
                                    description: Type.Optional(
                                        Type.String({
                                            minLength: 1,
                                            description:
                                                "Short explanation of what this artifact contains and how it supports the reported result.",
                                        }),
                                    ),
                                },
                                {
                                    additionalProperties: false,
                                    description:
                                        "One artifact reference; no file contents are embedded.",
                                },
                            ),
                            {
                                maxItems: 256,
                                description:
                                    "Optional up to 256 actual artifact references. Prefer paths over embedding large file bodies in details.",
                            },
                        ),
                    ),
                },
                { additionalProperties: false },
            ),
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
        description:
            "Parent-only launch of one worker in a new visible Herdr tab. Check agents_list for existing workers and use agent_diagnostics if Herdr setup is uncertain. Requires a unique alias, role, self-contained prompt, and existing absolute cwd. Returns agent.id, agent.runId, and sessionId; use agent.id for later control. A failed launch may leave a failed/orphaned registry record.",
        promptSnippet: "Spawn one new worker with explicit scope and cwd.",
        promptGuidelines: [
            "Before agent_spawn, inspect agents_list to avoid duplicating existing work; provide a bounded task, owned files, expected result, and shared-worktree instructions in prompt.",
            "After agent_spawn fails, inspect agents_list and agent_diagnostics before retrying; do not guess model names, create repeated aliases, or treat a returned sessionId as agent.id.",
        ],
        parameters: Type.Object(TaskFields, { additionalProperties: false }),
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
            "Parent-only corrective instruction for a live starting/running/idle/blocked/interrupted worker. Copy agent.id from agents_list or agent_spawn. Writes one durable steering message; does not kill or relaunch the worker. Use agent_mail_send for informational messages and agent_resume for a stopped process.",
        promptSnippet: "Correct live or interrupted work without a restart.",
        promptGuidelines: [
            "After Escape or a mistaken instruction, use agent_steer with the existing agent ID and a clear correction; do not use agent_stop or spawn a replacement unless process termination is actually intended.",
        ],
        parameters: Type.Object(
            {
                agent: AgentReference,
                instruction: Instruction,
                idempotencyKey: Type.Optional(IdempotencyKey),
            },
            { additionalProperties: false },
        ),
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
            "Parent-only send Escape to interrupt the current worker turn while preserving its process and session. Copy agent from agents_list or agent_spawn. This is not a stop, cancellation of a workflow, or final result; follow with agent_steer if correcting the task.",
        promptSnippet: "Interrupt a turn while preserving the worker process.",
        promptGuidelines: [
            "Use agent_interrupt to pause an active turn, then agent_steer to correct it; agent_stop closes the process and workflow_cancel cancels scheduled work instead.",
        ],
        parameters: Type.Object({ agent: AgentReference }, { additionalProperties: false }),
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
            "Parent-only coordinated rename of a live worker's registry alias, Herdr agent/tab/pane, and Pi display name. Get agent from agents_list; choose a new valid unused alias. ID and run remain stable. External and database changes use compensation, not a shared atomic transaction; inspect diagnostics on rollback errors.",
        promptSnippet: "Rename a worker while keeping its immutable ID.",
        promptGuidelines: [
            "Use agent_rename with an existing immutable agent ID; after success continue routing by that ID, and after partial failure inspect agent_events/agents_list rather than assuming every display changed.",
        ],
        parameters: Type.Object(
            { agent: AgentReference, alias: Alias, displayName: Type.Optional(DisplayName) },
            { additionalProperties: false },
        ),
        executionMode: "sequential",
        async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
            const result = await runtime.requireParent().supervisor.rename(params, signal);
            return toolResult("agent_rename", result, `Renamed agent to ${result.alias}`);
        },
    });

    pi.registerTool({
        name: "agent_stop",
        label: "Stop Pi Herdr agent",
        description:
            "Parent-only terminate a worker process and close its verified owned Herdr tab. Copy agent.id from agents_list. This is destructive to live work, unlike agent_interrupt; it does not report successful assignment completion. Use workflow_cancel for a whole DAG.",
        promptSnippet: "Explicitly stop a worker and close its owned tab.",
        promptGuidelines: [
            "Use agent_stop only when worker termination is intended, not to fix a prompt; prefer agent_interrupt/agent_steer for corrections and workflow_cancel for workflow-owned work.",
        ],
        parameters: Type.Object({ agent: AgentReference }, { additionalProperties: false }),
        executionMode: "sequential",
        async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
            const result = await runtime.requireParent().supervisor.stop(params.agent, signal);
            return toolResult("agent_stop", result, `Stopped ${result.alias}`);
        },
    });

    pi.registerTool({
        name: "agent_resume",
        label: "Resume Pi Herdr agent",
        description:
            "Parent-only reopen a stopped worker's validated Pi session, or steer a live worker when instruction is supplied. Copy the existing agent ID from agents_list. A stopped restart keeps its run; reopening completed/failed work creates a new run. Published results must be acknowledged first; orphaned surfaces need recovery before resume.",
        promptSnippet: "Resume an existing session, not a duplicate worker.",
        promptGuidelines: [
            "Use agents_list before agent_resume to check state; for a live interrupted worker prefer agent_steer, and do not relaunch a completed worker until its completion receipt is acknowledged.",
        ],
        parameters: Type.Object(
            { agent: AgentReference, instruction: Type.Optional(Instruction) },
            { additionalProperties: false },
        ),
        executionMode: "sequential",
        async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
            const result = await runtime.requireParent().supervisor.resume(params, signal);
            return toolResult("agent_resume", result, `Agent ${result.alias} is ${result.status}`);
        },
    });

    pi.registerTool({
        name: "agents_list",
        label: "List Pi Herdr agents",
        description:
            "Parent-only read-only list of current and historical agents in this coordinator namespace. Start with {} or a status filter. Returns items[].id, runId, alias, role, status, and nextCursor. Failed spawns remain visible; a registry row alone does not prove a live Herdr process.",
        promptSnippet: "Inspect agent identities and states before lifecycle actions.",
        promptGuidelines: [
            "Use agents_list before agent_spawn, agent_steer, agent_resume, agent_rename, or agent_stop; copy items[].id and inspect state instead of guessing an alias or retrying a failed spawn blindly.",
        ],
        parameters: Type.Object(
            { status: Type.Optional(AgentStatusSchema), ...PageFields },
            { additionalProperties: false },
        ),
        async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
            const { store, identity } = runtime.requireParent();
            const result = store.listAgents({ ...params, rootAgentId: identity.rootAgentId });
            return toolResult("agents_list", result, `${result.items.length} agent(s)`);
        },
    });

    pi.registerTool({
        name: "workflow_start",
        label: "Start durable workflow",
        description:
            "Parent-only create and schedule a new durable DAG. Each node needs a unique local nodeId and a task; dependencies refer to nodeIds in this same request, not agent/workflow UUIDs. Returns workflow.id and tick results. Ready nodes launch automatically; do not also spawn their workers manually.",
        promptSnippet: "Start a dependency graph with explicit tasks and node IDs.",
        promptGuidelines: [
            "Use workflow_start for dependent multi-step work and agent_spawn for one independent worker; define all nodeIds/dependencies before starting and never form cycles.",
            "After workflow_start, copy workflow.id into workflow_status; do not repeat workflow_start to poll because each call creates another workflow.",
        ],
        parameters: Type.Object(
            {
                name: Type.String({
                    minLength: 1,
                    maxLength: 128,
                    description:
                        "Caller-chosen human-readable workflow name, without surrounding whitespace. Not the workflow ID: save the generated workflow.id from the response.",
                }),
                nodes: Type.Array(
                    Type.Object(
                        {
                            nodeId: NodeId,
                            dependencies: Type.Optional(
                                Type.Array(NodeId, {
                                    maxItems: 1000,
                                    uniqueItems: true,
                                    description:
                                        "Node keys from THIS nodes array that must succeed first. Omit or [] for roots; all keys must exist, be unique, and form an acyclic graph with no self-reference. Example: build depends on [research].",
                                }),
                            ),
                            task: Type.Object(TaskFields, {
                                additionalProperties: false,
                                description:
                                    "Assignment automatically launched when dependencies succeed. Provide explicit ownership and cwd; do not separately call agent_spawn for this node. The scheduler derives a unique worker alias from this base alias.",
                            }),
                        },
                        {
                            additionalProperties: false,
                            description: "One durable DAG node and its launch task.",
                        },
                    ),
                    {
                        minItems: 1,
                        maxItems: 1000,
                        description:
                            "1-1000 nodes defined together. Node IDs must be unique; dependencies refer to these IDs, not positions or agent IDs. Keep graphs small enough to inspect and verify.",
                    },
                ),
            },
            { additionalProperties: false },
        ),
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
        description:
            "Parent-only read one existing workflow's durable status and node states. Get workflowId from workflow_start.workflow.id or workflow_list.items[].id. This does not create work or restart the DAG. Inspect failed/blocked nodes and cancellation intent before taking action.",
        promptSnippet: "Inspect an existing workflow without restarting it.",
        promptGuidelines: [
            "Use workflow_status with the saved workflow ID to check progress; queued/running nodes are not complete, and blocked descendants need their upstream failure resolved rather than manual duplicate spawns.",
        ],
        parameters: Type.Object({ workflowId: WorkflowId }, { additionalProperties: false }),
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
        description:
            "Parent-only read-only discovery of durable workflows in the current namespace. Start with {} when the workflow ID is unknown; returns items[].id and optional nextCursor. Use an item's id with workflow_status or workflow_cancel.",
        promptSnippet: "Find workflow IDs before status or cancellation.",
        promptGuidelines: [
            "Use workflow_list to recover an existing workflow ID after a session restart, then workflow_status; do not call workflow_start just because the previous ID was forgotten.",
        ],
        parameters: Type.Object(PageFields, { additionalProperties: false }),
        async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
            const parent = runtime.requireParent();
            const result = parent.store.listWorkflows({
                rootAgentId: parent.identity.rootAgentId,
                ...params,
            });
            return toolResult("workflow_list", result, `${result.items.length} workflow(s)`);
        },
    });

    pi.registerTool({
        name: "workflow_cancel",
        label: "Cancel workflow",
        description:
            "Parent-only persist cancellation intent for an existing workflow, prevent new launches, and attempt to stop mapped workers. Copy workflowId from workflow_list or workflow_start. Returns workflow and stopErrors; errors mean cleanup is pending and reconciliation will retry. Does not roll back generated files or support resetting this workflow.",
        promptSnippet: "Cancel a DAG and inspect pending cleanup errors.",
        promptGuidelines: [
            "Use workflow_cancel for whole-workflow cancellation; inspect stopErrors and workflow_status/agent_events afterward, and do not claim all processes stopped while cleanup errors remain.",
        ],
        parameters: Type.Object({ workflowId: WorkflowId }, { additionalProperties: false }),
        executionMode: "sequential",
        async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
            const result = await runtime
                .requireParent()
                .workflowEngine.cancel(parseWorkflowId(params.workflowId), signal);
            return toolResult(
                "workflow_cancel",
                result,
                `Cancellation requested for ${result.workflow.id}; ${result.stopErrors.length} stop error(s)`,
            );
        },
    });
}

function toolResult<T>(tool: string, data: T, message: string) {
    return modelToolResult(tool, data, message);
}
