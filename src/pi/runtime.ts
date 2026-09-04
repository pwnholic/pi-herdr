import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type {
    AgentEndEvent,
    ExtensionAPI,
    ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { type OrchestratorConfig, resolveConfig } from "../config.ts";
import { type AgentRecord, type AgentStatus, canTransitionAgent } from "../domain/agent.ts";
import { ValidationError } from "../domain/errors.ts";
import { type AgentId, parseAgentId } from "../domain/ids.ts";
import type { MailboxMessage, MessageKind, MessageState } from "../domain/mailbox.ts";
import { assertJsonValue, type JsonValue, validateAlias } from "../domain/validation.ts";
import { HerdrAdapter } from "../herdr/index.ts";
import { AgentSupervisor } from "../orchestrator/index.ts";
import { SqliteControlPlaneStore } from "../storage/index.ts";
import { WorkflowEngine } from "../workflow/index.ts";
import { type MailboxDisposition, MailboxPump } from "./mailbox-pump.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const HERDR_PI_LIFECYCLE_EXTENSION = "herdr-agent-state.ts";

function discoverHerdrLifecycleExtension(
    environment: Readonly<Record<string, string | undefined>>,
): string | undefined {
    const configuredDirectory = environment.PI_CODING_AGENT_DIR?.trim();
    const agentDirectory =
        configuredDirectory === undefined || configuredDirectory.length === 0
            ? join(homedir(), ".pi", "agent")
            : resolve(configuredDirectory);
    const candidate = join(agentDirectory, "extensions", HERDR_PI_LIFECYCLE_EXTENSION);
    return existsSync(candidate) ? candidate : undefined;
}

export interface CompletionArtifact {
    readonly path: string;
    readonly description?: string;
}

export interface CompletionPayload {
    readonly status: "succeeded" | "failed";
    readonly summary: string;
    readonly details?: JsonValue;
    readonly artifacts?: readonly CompletionArtifact[];
}

interface PendingCompletion {
    readonly payload: CompletionPayload;
    readonly token: string;
}

export interface RuntimeDependencies {
    readonly environment?: Readonly<Record<string, string | undefined>>;
    readonly extensionPath: string;
    readonly openStore?: (filename: string) => SqliteControlPlaneStore;
    readonly createHerdr?: (
        environment: Readonly<Record<string, string | undefined>>,
    ) => HerdrAdapter;
    readonly createSupervisor?: (
        options: ConstructorParameters<typeof AgentSupervisor>[0],
    ) => AgentSupervisor;
    readonly onError?: (error: unknown) => void;
}

interface ActiveResources {
    readonly config: OrchestratorConfig;
    readonly store: SqliteControlPlaneStore;
    readonly identity: AgentRecord;
    readonly parentAgentId?: AgentId;
    readonly supervisor?: AgentSupervisor;
    readonly workflowEngine?: WorkflowEngine;
    readonly pump: MailboxPump;
    readonly child: boolean;
}

export interface SendMailInput {
    readonly recipient: string;
    readonly kind?: MessageKind;
    readonly content: string;
    readonly idempotencyKey?: string;
    readonly replyToMessageId?: string;
}

export interface ListMailInput {
    readonly states?: readonly MessageState[];
    readonly limit?: number;
    readonly cursor?: string;
}

/** Session-scoped control plane. No Pi context is retained between callbacks. */
export class PiHerdrRuntime {
    readonly #pi: ExtensionAPI;
    readonly #environment: Readonly<Record<string, string | undefined>>;
    readonly #extensionPath: string;
    readonly #lifecycleExtensionPath: string | undefined;
    readonly #openStore: (filename: string) => SqliteControlPlaneStore;
    readonly #createHerdr: (
        environment: Readonly<Record<string, string | undefined>>,
    ) => HerdrAdapter;
    readonly #createSupervisor: (
        options: ConstructorParameters<typeof AgentSupervisor>[0],
    ) => AgentSupervisor;
    readonly #onError: (error: unknown) => void;
    #active: ActiveResources | undefined;
    #lastAgentMessages: AgentEndEvent["messages"] = [];
    #lastTurnAborted = false;
    #pendingCompletion: PendingCompletion | undefined;
    #completionEmitted = false;
    #workflowTimer: NodeJS.Timeout | undefined;
    #workflowTick: Promise<unknown> | undefined;

    constructor(pi: ExtensionAPI, dependencies: RuntimeDependencies) {
        this.#pi = pi;
        this.#environment = dependencies.environment ?? process.env;
        this.#extensionPath = dependencies.extensionPath;
        this.#lifecycleExtensionPath = discoverHerdrLifecycleExtension(this.#environment);
        this.#openStore =
            dependencies.openStore ?? ((filename) => SqliteControlPlaneStore.open({ filename }));
        this.#createHerdr =
            dependencies.createHerdr ?? ((environment) => new HerdrAdapter({ environment }));
        this.#createSupervisor =
            dependencies.createSupervisor ?? ((options) => new AgentSupervisor(options));
        this.#onError = dependencies.onError ?? (() => undefined);
    }

    get isActive(): boolean {
        return this.#active !== undefined;
    }

    get isChild(): boolean {
        return this.#requireActive().child;
    }

    get identity(): AgentRecord {
        return this.#requireActive().identity;
    }

    async start(ctx: ExtensionContext): Promise<void> {
        await this.stop();
        this.#resetTurnState();
        const config = resolveConfig({
            sessionDir: ctx.sessionManager.getSessionDir(),
            cwd: ctx.cwd,
            env: this.#environment,
        });
        mkdirSync(dirname(config.databasePath), { recursive: true });
        const store = this.#openStore(config.databasePath);

        try {
            const childIdValue = this.#environment.PI_HERDR_AGENT_ID;
            const parentIdValue = this.#environment.PI_HERDR_PARENT_ID;
            if ((childIdValue === undefined) !== (parentIdValue === undefined)) {
                throw new ValidationError(
                    "PI_HERDR_AGENT_ID and PI_HERDR_PARENT_ID must be provided together",
                );
            }

            if (childIdValue !== undefined && parentIdValue !== undefined) {
                this.#active = this.#startChild(store, config, ctx, childIdValue, parentIdValue);
            } else {
                this.#active = await this.#startParent(store, config, ctx);
            }
            this.#active.pump.start();
            if (this.#active.workflowEngine !== undefined) this.#scheduleWorkflowTick(0);
        } catch (error) {
            store.close();
            this.#active = undefined;
            throw error;
        }
    }

    async stop(): Promise<void> {
        const active = this.#active;
        if (active === undefined) return;
        if (this.#workflowTimer !== undefined) clearTimeout(this.#workflowTimer);
        this.#workflowTimer = undefined;
        await active.pump.stop().catch(this.#onError);
        await this.#workflowTick?.catch(this.#onError);
        this.#workflowTick = undefined;
        if (this.#workflowTimer !== undefined) clearTimeout(this.#workflowTimer);
        this.#workflowTimer = undefined;
        if (this.#active === active) this.#active = undefined;
        active.store.close();
        this.#resetTurnState();
    }

    onAgentStart(): void {
        const active = this.#active;
        if (!active?.child) return;
        this.#lastTurnAborted = false;
        this.#transition(active.store, active.identity.id, "running");
    }

    onAgentEnd(event: AgentEndEvent): void {
        const active = this.#active;
        if (!active?.child) return;
        this.#lastAgentMessages = [...event.messages];
        const lastAssistant = event.messages.findLast((message) => message.role === "assistant");
        this.#lastTurnAborted = lastAssistant?.stopReason === "aborted";
        if (this.#lastTurnAborted) {
            if (!this.#completionEmitted) this.#pendingCompletion = undefined;
            this.#transition(active.store, active.identity.id, "interrupted");
        }
    }

    async onAgentSettled(_ctx: ExtensionContext): Promise<void> {
        const active = this.#active;
        if (!active?.child) return;
        if (this.#pendingCompletion !== undefined) {
            this.#emitCompletion(active, this.#pendingCompletion);
            return;
        }
        this.#transition(
            active.store,
            active.identity.id,
            this.#lastTurnAborted ? "interrupted" : "idle",
        );
    }

    declareCompletion(input: CompletionPayload, token: string): CompletionPayload {
        const active = this.#requireChild();
        const completion = validateCompletion(input, active.config.maxResultBytes);
        if (typeof token !== "string" || token.length === 0) {
            throw new ValidationError("agent_complete requires a non-empty invocation token");
        }
        if (this.#pendingCompletion !== undefined) {
            if (
                this.#pendingCompletion.token !== token ||
                JSON.stringify(this.#pendingCompletion.payload) !== JSON.stringify(completion)
            ) {
                throw new ValidationError(
                    "agent_complete was already declared with another payload",
                );
            }
            return this.#pendingCompletion.payload;
        }
        this.#pendingCompletion = { payload: completion, token };
        return completion;
    }

    sendMail(input: SendMailInput) {
        const active = this.#requireActive();
        const recipient = resolveAgent(active.store, input.recipient);
        if (active.supervisor !== undefined) {
            return active.supervisor.send({
                senderAgentId: active.identity.id,
                recipient: recipient.id,
                kind: input.kind ?? "message",
                content: input.content,
                ...(input.idempotencyKey === undefined
                    ? {}
                    : { idempotencyKey: input.idempotencyKey }),
                ...(input.replyToMessageId === undefined
                    ? {}
                    : { replyToMessageId: parseMessageIdForTool(input.replyToMessageId) }),
            });
        }
        if (Buffer.byteLength(input.content, "utf8") > active.config.maxMessageBytes) {
            throw new ValidationError(
                `content exceeds ${active.config.maxMessageBytes} UTF-8 bytes`,
            );
        }
        return active.store.enqueueMessage({
            senderAgentId: active.identity.id,
            recipientAgentId: recipient.id,
            kind: input.kind ?? "message",
            content: input.content,
            ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
            ...(input.replyToMessageId === undefined
                ? {}
                : { replyToMessageId: parseMessageIdForTool(input.replyToMessageId) }),
            expiresAt: Date.now() + active.config.messageTtlMs,
        });
    }

    listMail(input: ListMailInput = {}) {
        const active = this.#requireActive();
        return active.store.listMessages({
            recipientAgentId: active.identity.id,
            ...(input.states === undefined ? {} : { states: input.states }),
            ...(input.limit === undefined ? {} : { limit: input.limit }),
            ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        });
    }

    async readMail(messageId: string): Promise<MailboxMessage> {
        const active = this.#requireActive();
        await active.pump.pollNow();
        const message = active.store.getMessage(parseMessageIdForTool(messageId));
        this.#assertRecipient(message, active.identity.id);
        return message;
    }

    async acknowledgeMail(messageId: string): Promise<MailboxMessage> {
        const active = this.#requireActive();
        await active.pump.pollNow();
        let message = active.store.getMessage(parseMessageIdForTool(messageId));
        this.#assertRecipient(message, active.identity.id);
        if (message.state === "acked") return message;
        if (message.state !== "read" || message.leaseOwner !== active.pump.owner) {
            throw new ValidationError(
                "message must be read and actively leased by this Pi process before acknowledgement",
            );
        }
        message = active.store.acknowledgeMessage({
            messageId: message.id,
            recipientAgentId: active.identity.id,
            owner: active.pump.owner,
            expectedRevision: message.revision,
        });
        return message;
    }

    requireParent(): {
        readonly store: SqliteControlPlaneStore;
        readonly supervisor: AgentSupervisor;
        readonly identity: AgentRecord;
        readonly config: OrchestratorConfig;
        readonly workflowEngine: WorkflowEngine;
    } {
        const active = this.#requireActive();
        if (
            active.child ||
            active.supervisor === undefined ||
            active.workflowEngine === undefined
        ) {
            throw new ValidationError("This operation is available only to the parent coordinator");
        }
        return {
            store: active.store,
            supervisor: active.supervisor,
            identity: active.identity,
            config: active.config,
            workflowEngine: active.workflowEngine,
        };
    }

    #startChild(
        store: SqliteControlPlaneStore,
        config: OrchestratorConfig,
        ctx: ExtensionContext,
        childIdValue: string,
        parentIdValue: string,
    ): ActiveResources {
        const childId = parseAgentId(childIdValue);
        const parentAgentId = parseAgentId(parentIdValue);
        let identity = store.getAgent(childId);
        if (identity.parentAgentId !== parentAgentId) {
            throw new ValidationError("Child registry parent does not match PI_HERDR_PARENT_ID");
        }
        const sessionFile = ctx.sessionManager.getSessionFile();
        identity = store.patchAgent({
            agentId: identity.id,
            patch: {
                sessionId: ctx.sessionManager.getSessionId(),
                ...(sessionFile === undefined ? {} : { sessionFile }),
            },
            expectedRevision: identity.revision,
        });
        this.#pi.setSessionName(identity.displayName);
        const pump = this.#createPump(store, identity.id, config, true);
        return {
            store,
            config,
            identity,
            parentAgentId,
            pump,
            child: true,
        };
    }

    async #startParent(
        store: SqliteControlPlaneStore,
        config: OrchestratorConfig,
        ctx: ExtensionContext,
    ): Promise<ActiveResources> {
        const sessionId = ctx.sessionManager.getSessionId();
        let identity = findCoordinator(store, sessionId);
        const sessionFile = ctx.sessionManager.getSessionFile();
        if (identity === undefined) {
            const alias = validateAlias(
                `coordinator-${sessionId.replaceAll("-", "").slice(0, 16)}`,
            );
            identity = store.registerAgent({
                alias,
                displayName: this.#pi.getSessionName() ?? alias,
                role: "coordinator",
                sessionId,
                ...(sessionFile === undefined ? {} : { sessionFile }),
                metadata: { piHerdr: { coordinator: true } },
            });
        } else {
            identity = store.patchAgent({
                agentId: identity.id,
                patch: {
                    sessionId,
                    ...(sessionFile === undefined ? {} : { sessionFile }),
                },
                expectedRevision: identity.revision,
            });
        }
        identity = this.#transition(store, identity.id, "starting");
        identity = this.#transition(store, identity.id, "idle");

        const herdr = this.#createHerdr(this.#environment);
        const context = herdr.isManagedEnvironment()
            ? await herdr.discoverCurrentContext({ timeoutMs: config.operationTimeoutMs })
            : undefined;
        const supervisor = this.#createSupervisor({
            store,
            herdr,
            config,
            parentAgentId: identity.id,
            sessionDir: ctx.sessionManager.getSessionDir(),
            extensionPath: this.#extensionPath,
            ...(this.#lifecycleExtensionPath === undefined
                ? {}
                : { lifecycleExtensionPath: this.#lifecycleExtensionPath }),
            ...(context === undefined ? {} : { workspaceId: context.workspaceId }),
        });
        await supervisor.recover();
        const workflowEngine = new WorkflowEngine({
            store,
            supervisor,
            maxConcurrent: config.maxLiveAgents,
        });
        const pump = this.#createPump(store, identity.id, config, false, supervisor);
        return {
            store,
            config,
            identity,
            supervisor,
            workflowEngine,
            pump,
            child: false,
        };
    }

    #createPump(
        store: SqliteControlPlaneStore,
        identity: AgentId,
        config: OrchestratorConfig,
        child: boolean,
        supervisor?: AgentSupervisor,
    ): MailboxPump {
        return new MailboxPump({
            store,
            recipientAgentId: identity,
            leaseMs: config.leaseDurationMs,
            pollMs: config.completionPollMs,
            batchSize: config.maxPageSize,
            dispatch: async (message) =>
                this.#dispatchMessage(message, child, identity, supervisor),
            onError: this.#onError,
        });
    }

    async #dispatchMessage(
        message: MailboxMessage,
        child: boolean,
        identity: AgentId,
        supervisor?: AgentSupervisor,
    ): Promise<MailboxDisposition> {
        const metadata = jsonObject(message.metadata);
        const action = typeof metadata.action === "string" ? metadata.action : undefined;
        if (child && message.kind === "control" && action === "rename") {
            const displayName = metadata.displayName;
            if (typeof displayName !== "string" || displayName.length === 0) {
                throw new ValidationError("rename control is missing displayName");
            }
            this.#pi.setSessionName(displayName);
            return "ack";
        }

        if (!child && message.kind === "result") {
            if (supervisor === undefined) throw new Error("Parent supervisor is unavailable");
            const sender = message.senderAgentId;
            if (sender === undefined)
                throw new ValidationError("result message has no sender agent");
            const status = metadata.status;
            if (status !== "succeeded" && status !== "failed") {
                throw new ValidationError("result message has an invalid completion status");
            }
            if (metadata.agentId !== undefined && metadata.agentId !== sender) {
                throw new ValidationError("result metadata agentId does not match its sender");
            }
            const record = supervisor.resolveAgent(sender);
            const workflowEngine = this.#requireActive().workflowEngine;
            if (workflowEngine !== undefined && hasWorkflowBinding(record)) {
                const completion = parseCompletionResult(message.content);
                await workflowEngine.acceptCompletion({
                    agentId: record.id,
                    status,
                    result: completion,
                    ...(status === "failed" ? { error: completionSummary(completion) } : {}),
                });
            }
            this.#transition(
                this.#requireActive().store,
                record.id,
                status === "succeeded" ? "completed" : "failed",
            );
            await supervisor.finalizeCompletedAgent(record.id);
            this.#pi.sendMessage(mailboxCustomMessage(message, true), {
                triggerTurn: true,
                deliverAs: "steer",
            });
            await workflowEngine?.tick();
            return "ack";
        }

        if (message.recipientAgentId !== identity) {
            throw new ValidationError("Mailbox dispatcher received a message for another agent");
        }
        this.#pi.sendMessage(mailboxCustomMessage(message), {
            triggerTurn: true,
            deliverAs: "steer",
        });
        return "read";
    }

    #emitCompletion(active: ActiveResources, declaration: PendingCompletion): void {
        if (this.#completionEmitted) return;
        if (active.parentAgentId === undefined) {
            throw new ValidationError("Child has no parent recipient for completion result");
        }
        const completion = declaration.payload;
        const finalMessage = latestAssistantText(this.#lastAgentMessages);
        const content = JSON.stringify({
            ...completion,
            ...(finalMessage === undefined ? {} : { finalMessage }),
        });
        if (Buffer.byteLength(content, "utf8") > active.config.maxResultBytes) {
            throw new ValidationError(
                `completion result exceeds ${active.config.maxResultBytes} UTF-8 bytes`,
            );
        }
        active.store.enqueueMessage({
            senderAgentId: active.identity.id,
            recipientAgentId: active.parentAgentId,
            kind: "result",
            content,
            metadata: {
                action: "completion",
                agentId: active.identity.id,
                status: completion.status,
            },
            idempotencyKey: completionKey(active.identity.id, declaration.token),
            expiresAt: Date.now() + active.config.messageTtlMs,
        });
        this.#transition(
            active.store,
            active.identity.id,
            completion.status === "succeeded" ? "completed" : "failed",
        );
        this.#completionEmitted = true;
    }

    #transition(
        store: SqliteControlPlaneStore,
        agentId: AgentId,
        status: AgentStatus,
    ): AgentRecord {
        const current = store.getAgent(agentId);
        if (current.status === status || !canTransitionAgent(current.status, status))
            return current;
        return store.transitionAgent({
            agentId,
            status,
            patch: {},
            expectedRevision: current.revision,
        });
    }

    #assertRecipient(message: MailboxMessage, recipient: AgentId): void {
        if (message.recipientAgentId !== recipient) {
            throw new ValidationError("message belongs to another mailbox");
        }
    }

    #requireActive(): ActiveResources {
        if (this.#active === undefined) {
            throw new ValidationError("Pi Herdr runtime is not active for this session");
        }
        return this.#active;
    }

    #requireChild(): ActiveResources {
        const active = this.#requireActive();
        if (!active.child)
            throw new ValidationError("agent_complete is available only to children");
        return active;
    }

    #resetTurnState(): void {
        this.#lastAgentMessages = [];
        this.#lastTurnAborted = false;
        this.#pendingCompletion = undefined;
        this.#completionEmitted = false;
    }

    #scheduleWorkflowTick(delay: number): void {
        if (this.#active?.workflowEngine === undefined) return;
        this.#workflowTimer = setTimeout(() => {
            this.#workflowTimer = undefined;
            const engine = this.#active?.workflowEngine;
            if (engine === undefined) return;
            const operation = engine.tick();
            this.#workflowTick = operation;
            void operation.catch(this.#onError).finally(() => {
                if (this.#workflowTick === operation) this.#workflowTick = undefined;
                const interval = this.#active?.config.completionPollMs;
                if (interval !== undefined) this.#scheduleWorkflowTick(interval);
            });
        }, delay);
        this.#workflowTimer.unref();
    }
}

function findCoordinator(
    store: SqliteControlPlaneStore,
    sessionId: string,
): AgentRecord | undefined {
    let cursor: string | undefined;
    do {
        const page = store.listAgents({ limit: 100, ...(cursor === undefined ? {} : { cursor }) });
        const match = page.items.find(
            (agent) =>
                agent.sessionId === sessionId &&
                agent.parentAgentId === undefined &&
                agent.role === "coordinator",
        );
        if (match !== undefined) return match;
        cursor = page.nextCursor;
    } while (cursor !== undefined);
    return undefined;
}

function resolveAgent(store: SqliteControlPlaneStore, identifier: string): AgentRecord {
    return UUID_PATTERN.test(identifier)
        ? store.getAgent(parseAgentId(identifier))
        : store.getAgentByAlias(validateAlias(identifier));
}

function parseMessageIdForTool(value: string) {
    if (!UUID_PATTERN.test(value)) throw new ValidationError("messageId must be a UUID");
    return value.toLowerCase() as Parameters<SqliteControlPlaneStore["getMessage"]>[0];
}

function completionKey(agentId: AgentId, token: string): string {
    const digest = createHash("sha256").update(token).digest("hex").slice(0, 32);
    return `completion:${agentId}:${digest}`;
}

function validateCompletion(input: CompletionPayload, maximumBytes: number): CompletionPayload {
    if (input.status !== "succeeded" && input.status !== "failed") {
        throw new ValidationError("completion status must be succeeded or failed");
    }
    if (
        typeof input.summary !== "string" ||
        input.summary.trim() !== input.summary ||
        input.summary.length === 0
    ) {
        throw new ValidationError("completion summary must be a non-empty, unpadded string");
    }
    if (input.details !== undefined) assertJsonValue(input.details, "details");
    const artifacts = input.artifacts?.map((artifact) => {
        if (typeof artifact.path !== "string" || artifact.path.length === 0) {
            throw new ValidationError("artifact path must be a non-empty string");
        }
        if (
            artifact.description !== undefined &&
            (typeof artifact.description !== "string" || artifact.description.length === 0)
        ) {
            throw new ValidationError("artifact description must be a non-empty string");
        }
        return {
            path: artifact.path,
            ...(artifact.description === undefined ? {} : { description: artifact.description }),
        };
    });
    const normalized: CompletionPayload = {
        status: input.status,
        summary: input.summary,
        ...(input.details === undefined ? {} : { details: input.details }),
        ...(artifacts === undefined ? {} : { artifacts }),
    };
    assertJsonValue(normalized as unknown as JsonValue, "completion");
    if (Buffer.byteLength(JSON.stringify(normalized), "utf8") > maximumBytes) {
        throw new ValidationError(`completion exceeds ${maximumBytes} UTF-8 bytes`);
    }
    return normalized;
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
    assertJsonValue(parsed, "result.content");
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

function latestAssistantText(messages: AgentEndEvent["messages"]): string | undefined {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message?.role !== "assistant") continue;
        const text = message.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n")
            .trim();
        if (text.length > 0) return text;
    }
    return undefined;
}
