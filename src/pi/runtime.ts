import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type {
    AgentEndEvent,
    ExtensionAPI,
    ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { type OrchestratorConfig, resolveConfig } from "../config.ts";
import type { AgentRecord, AgentStatus } from "../domain/agent.ts";
import { ValidationError } from "../domain/errors.ts";
import { type AgentId, parseAgentId, parseThreadId } from "../domain/ids.ts";
import type { MailboxMessage, MessageKind, MessageState } from "../domain/mailbox.ts";
import { type JsonValue, validateAlias } from "../domain/validation.ts";
import type { Failpoint } from "../faults.ts";
import { HerdrAdapter } from "../herdr/index.ts";
import { AgentSupervisor } from "../orchestrator/index.ts";
import { SqliteControlPlaneStore } from "../storage/index.ts";
import { CompletionCoordinator, type CompletionPayload } from "./completion.ts";

export type { CompletionArtifact, CompletionPayload } from "./completion.ts";

import { WorkflowEngine } from "../workflow/index.ts";
import { MailboxPump } from "./mailbox-pump.ts";
import { dispatchMailboxMessage } from "./message-dispatcher.ts";

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
    readonly failpoint?: Failpoint;
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
    readonly completion?: CompletionCoordinator;
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
    readonly threadId?: string;
}

const PUBLIC_MESSAGE_KINDS = new Set<MessageKind>(["message", "request", "response", "event"]);
const TERMINAL_AGENT_STATUSES = new Set<AgentStatus>(["completed", "failed"]);

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
    readonly #failpoint: Failpoint | undefined;
    #active: ActiveResources | undefined;
    #lastTurnAborted = false;
    #workflowTimer: NodeJS.Timeout | undefined;
    #workflowTick: Promise<unknown> | undefined;
    #sessionManager: ExtensionContext["sessionManager"] | undefined;

    constructor(pi: ExtensionAPI, dependencies: RuntimeDependencies) {
        this.#pi = pi;
        this.#environment = dependencies.environment ?? process.env;
        this.#extensionPath = dependencies.extensionPath;
        this.#lifecycleExtensionPath = discoverHerdrLifecycleExtension(this.#environment);
        this.#openStore =
            dependencies.openStore ??
            ((filename) =>
                SqliteControlPlaneStore.open({
                    filename,
                    ...(dependencies.failpoint === undefined
                        ? {}
                        : { failpoint: dependencies.failpoint }),
                }));
        this.#createHerdr =
            dependencies.createHerdr ?? ((environment) => new HerdrAdapter({ environment }));
        this.#createSupervisor =
            dependencies.createSupervisor ?? ((options) => new AgentSupervisor(options));
        this.#onError = (error) => {
            try {
                const active = this.#active;
                active?.store.recordEvent({
                    rootAgentId: active.identity.rootAgentId,
                    entityId: active.identity.id,
                    runId: active.identity.runId,
                    type: "runtime.error",
                    data: {
                        message: (error instanceof Error ? error.message : String(error)).slice(
                            0,
                            4096,
                        ),
                    },
                });
            } catch {
                /* A failed database cannot journal its own failure. */
            }
            dependencies.onError?.(error);
        };
        this.#failpoint = dependencies.failpoint;
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
        this.#sessionManager = ctx.sessionManager;
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
            this.#active.store.recordEvent({
                rootAgentId: this.#active.identity.rootAgentId,
                entityId: this.#active.identity.id,
                runId: this.#active.identity.runId,
                type: "runtime.started",
                data: {
                    child: this.#active.child,
                    lifecycleExtension: this.#lifecycleExtensionPath !== undefined,
                },
            });
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
        this.#sessionManager = undefined;
        active.store.close();
        this.#resetTurnState();
    }

    onAgentStart(): void {
        const active = this.#active;
        if (!active?.child) return;
        this.#requireActive();
        this.#lastTurnAborted = false;
        // New reasoning invalidates any result drafted before a late correction.
        active.completion?.abort();
        this.#transition(active.store, active.identity.id, "running");
    }

    onAgentEnd(event: AgentEndEvent): void {
        const active = this.#active;
        if (!active?.child) return;
        const lastAssistant = event.messages.findLast((message) => message.role === "assistant");
        this.#lastTurnAborted = lastAssistant?.stopReason === "aborted";
        if (this.#lastTurnAborted) {
            this.#requireActive();
            active.completion?.abort();
            this.#transition(active.store, active.identity.id, "interrupted");
        }
    }

    async onAgentSettled(_ctx: ExtensionContext): Promise<void> {
        const active = this.#active;
        if (!active?.child) return;
        this.#requireActive();
        if (active.completion?.settle()) return;
        this.#transition(
            active.store,
            active.identity.id,
            this.#lastTurnAborted ? "interrupted" : "idle",
        );
    }

    declareCompletion(input: CompletionPayload, token: string): CompletionPayload {
        return this.#requireChild().completion!.declare(input, token);
    }

    sendMail(input: SendMailInput) {
        const active = this.#requireActive();
        const recipient = resolveAgent(active.store, input.recipient, active.identity.rootAgentId);
        const kind = input.kind ?? "message";
        if (!PUBLIC_MESSAGE_KINDS.has(kind)) {
            throw new ValidationError(
                `${kind} is reserved for authenticated Pi Herdr protocol traffic`,
                { field: "kind" },
            );
        }
        if (TERMINAL_AGENT_STATUSES.has(recipient.status)) {
            throw new ValidationError(`Cannot send mail to terminal agent ${recipient.alias}`);
        }
        if (active.supervisor !== undefined) {
            const delivery = active.supervisor.send({
                senderAgentId: active.identity.id,
                recipient: recipient.id,
                kind,
                content: input.content,
                ...(input.idempotencyKey === undefined
                    ? {}
                    : { idempotencyKey: input.idempotencyKey }),
                ...(input.replyToMessageId === undefined
                    ? {}
                    : { replyToMessageId: parseMessageIdForTool(input.replyToMessageId) }),
            });
            return interactionResult(active.store, recipient, delivery);
        }
        if (Buffer.byteLength(input.content, "utf8") > active.config.maxMessageBytes) {
            throw new ValidationError(
                `content exceeds ${active.config.maxMessageBytes} UTF-8 bytes`,
            );
        }
        const delivery = active.store.enqueueMessage({
            senderAgentId: active.identity.id,
            senderRunId: active.identity.runId,
            recipientAgentId: recipient.id,
            kind,
            content: input.content,
            ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
            ...(input.replyToMessageId === undefined
                ? {}
                : { replyToMessageId: parseMessageIdForTool(input.replyToMessageId) }),
            ttlMs: active.config.messageTtlMs,
        });
        return interactionResult(active.store, recipient, delivery);
    }

    listMail(input: ListMailInput = {}) {
        const active = this.#requireActive();
        return active.store.listMessages({
            recipientAgentId: active.identity.id,
            ...(input.states === undefined ? {} : { states: input.states }),
            ...(input.limit === undefined ? {} : { limit: input.limit }),
            ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
            ...(input.threadId === undefined
                ? {}
                : { threadId: parseThreadIdForTool(input.threadId) }),
        });
    }

    listSentMail(input: ListMailInput = {}) {
        const active = this.#requireActive();
        return active.store.listSentMessages({
            senderAgentId: active.identity.id,
            ...(input.states === undefined ? {} : { states: input.states }),
            ...(input.limit === undefined ? {} : { limit: input.limit }),
            ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
            ...(input.threadId === undefined
                ? {}
                : { threadId: parseThreadIdForTool(input.threadId) }),
        });
    }

    listDeadLetters(input: Pick<ListMailInput, "limit" | "cursor"> = {}) {
        const { store, identity } = this.requireParent();
        return store.listDeadLetters({
            rootAgentId: identity.rootAgentId,
            ...(input.limit === undefined ? {} : { limit: input.limit }),
            ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        });
    }

    mailboxStatus() {
        const { store, identity } = this.requireParent();
        return store.mailboxStats(identity.rootAgentId);
    }

    events(input: { after?: number; limit?: number; entityId?: string }) {
        const { store, identity } = this.requireParent();
        return store.listEvents({ ...input, rootAgentId: identity.rootAgentId });
    }

    diagnostics() {
        const { store, identity, config } = this.requireParent();
        return {
            identity: { id: identity.id, runId: identity.runId },
            database: { path: config.databasePath, ...store.databaseHealth() },
            extensions: {
                path: this.#extensionPath,
                exists: existsSync(this.#extensionPath),
                isolatedChildren: true,
                lifecyclePath: this.#lifecycleExtensionPath ?? null,
            },
            managedHerdr: this.#environment.HERDR_ENV === "1",
            mailbox: store.mailboxStats(identity.rootAgentId),
            warnings:
                this.#lifecycleExtensionPath === undefined
                    ? [
                          "Herdr Pi lifecycle extension was not found; Herdr UI status projection is not certified.",
                      ]
                    : [],
        };
    }

    retryDeadLetter(messageId: string): MailboxMessage {
        const active = this.#requireActive();
        const message = active.store.getMessage(parseMessageIdForTool(messageId));
        const parentMayOperate =
            !active.child && message.rootAgentId === active.identity.rootAgentId;
        if (message.senderAgentId !== active.identity.id && !parentMayOperate) {
            throw new ValidationError("message does not belong to this agent's outbox");
        }
        const recipient = resolveAgent(
            active.store,
            message.recipientAgentId,
            active.identity.rootAgentId,
        );
        if (TERMINAL_AGENT_STATUSES.has(recipient.status)) {
            throw new ValidationError(`Cannot retry mail to terminal agent ${recipient.alias}`);
        }
        return active.store.requeueDeadLetterMessage({
            messageId: message.id,
            senderAgentId: message.senderAgentId ?? active.identity.id,
            expectedRevision: message.revision,
            ttlMs: active.config.messageTtlMs,
        });
    }

    listPeers(input: Pick<ListMailInput, "limit" | "cursor"> = {}) {
        const active = this.#requireActive();
        return active.store.listAgents({
            rootAgentId: active.identity.rootAgentId,
            ...(input.limit === undefined ? {} : { limit: input.limit }),
            ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        });
    }

    async readMail(messageId: string): Promise<MailboxMessage> {
        const active = this.#requireActive();
        const id = parseMessageIdForTool(messageId);
        const before = active.store.getMessage(id);
        this.#assertRecipient(before, active.identity.id);
        if (before.state === "queued") await active.pump.pollMessage(id);
        const message = active.store.getMessage(id);
        this.#assertRecipient(message, active.identity.id);
        if (
            (message.state !== "read" && message.state !== "acked") ||
            (message.state === "read" &&
                (message.leaseOwner !== active.pump.owner ||
                    message.leaseExpiresAt === undefined ||
                    message.leaseExpiresAt <= Date.now()))
        ) {
            throw new ValidationError("message is not currently readable by this Pi process");
        }
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
        const expectedRun = this.#environment.PI_HERDR_RUN_ID;
        if (expectedRun !== undefined && expectedRun !== identity.runId) {
            throw new ValidationError("Child process belongs to a superseded assignment");
        }
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
            completion: new CompletionCoordinator(store, identity, config.maxResultBytes),
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
        if (identity.status === "registered")
            identity = this.#transition(store, identity.id, "starting");
        if (identity.status !== "idle") identity = this.#transition(store, identity.id, "idle");

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
            ...(this.#failpoint === undefined ? {} : { failpoint: this.#failpoint }),
        });
        await supervisor.recover();
        for (const completion of store.listPendingCompletions(identity.id)) {
            if (completion.runId !== store.getAgent(completion.agentId).runId) continue;
            if (completion.messageId === undefined) continue;
            const message = store.getMessage(completion.messageId);
            if (message.state === "dead_letter") {
                store.requeueDeadLetterMessage({
                    messageId: message.id,
                    senderAgentId: completion.agentId,
                    expectedRevision: message.revision,
                });
            } else if (message.state === "acked" && completion.state === "parent_applied") {
                store.markCompletionAcknowledged(
                    completion.agentId,
                    completion.invocationToken,
                    message.id,
                );
            }
        }
        const workflowEngine = new WorkflowEngine({
            store,
            supervisor,
            rootAgentId: identity.rootAgentId,
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
            recipientRunId: store.getAgent(identity).runId,
            leaseMs: config.leaseDurationMs,
            pollMs: config.completionPollMs,
            batchSize: config.maxPageSize,
            maxDeliveryBytes: config.maxDeliveryBytes,
            retentionMs: config.mailboxRetentionMs,
            idempotencyRetentionMs: config.idempotencyRetentionMs,
            dispatch: async (message) =>
                dispatchMailboxMessage({
                    active: this.#requireActive(),
                    message,
                    child,
                    identity,
                    ...(supervisor === undefined ? {} : { supervisor }),
                    pi: this.#pi,
                    hasPiMailboxMessage: (id) => this.#hasPiMailboxMessage(id),
                    ...(this.#failpoint === undefined ? {} : { failpoint: this.#failpoint }),
                }),
            onAcknowledged: (original) => {
                if (original.kind !== "result" || original.senderAgentId === undefined) return;
                const metadata = jsonObject(original.metadata);
                const token = metadata.completionToken;
                if (typeof token !== "string") return;
                const completion = store.getCompletion(original.senderAgentId);
                if (completion?.state !== "parent_applied") return;
                store.markCompletionAcknowledged(original.senderAgentId, token, original.id);
            },
            onError: this.#onError,
        });
    }

    #transition(
        store: SqliteControlPlaneStore,
        agentId: AgentId,
        status: AgentStatus,
    ): AgentRecord {
        const current = store.getAgent(agentId);
        if (current.status === status) return current;
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
        if (
            this.#active.store.getAgent(this.#active.identity.id).runId !==
            this.#active.identity.runId
        ) {
            throw new ValidationError("This process belongs to a superseded assignment");
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
        this.#lastTurnAborted = false;
    }

    #hasPiMailboxMessage(messageId: string): boolean {
        const manager = this.#sessionManager as
            | {
                  getBranch?: () => readonly unknown[];
                  getEntries?: () => readonly unknown[];
              }
            | undefined;
        const entries = manager?.getBranch?.() ?? manager?.getEntries?.() ?? [];
        return entries.some((entry) => {
            if (typeof entry !== "object" || entry === null) return false;
            const value = entry as {
                type?: unknown;
                customType?: unknown;
                details?: unknown;
            };
            if (value.type !== "custom_message" || value.customType !== "pi-herdr-mail") {
                return false;
            }
            return jsonObject(value.details as JsonValue).messageId === messageId;
        });
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

function resolveAgent(
    store: SqliteControlPlaneStore,
    identifier: string,
    rootAgentId?: AgentId,
): AgentRecord {
    const agent = UUID_PATTERN.test(identifier)
        ? store.getAgent(parseAgentId(identifier))
        : store.getAgentByAlias(validateAlias(identifier), rootAgentId);
    if (rootAgentId !== undefined && agent.rootAgentId !== rootAgentId) {
        throw new ValidationError("Agent is outside this communication namespace");
    }
    return agent;
}

function interactionResult(
    store: SqliteControlPlaneStore,
    recipient: AgentRecord,
    delivery: ReturnType<SqliteControlPlaneStore["enqueueMessage"]>,
) {
    const segments: string[] = [];
    let current = recipient;
    while (current.parentAgentId !== undefined) {
        segments.push(current.alias);
        current = store.getAgent(current.parentAgentId);
    }
    return {
        ...delivery,
        recipient: {
            id: recipient.id,
            alias: recipient.alias,
            path: `/root${segments.length === 0 ? "" : `/${segments.toReversed().join("/")}`}`,
            status: recipient.status,
            deliveryContract: ["starting", "running", "idle", "blocked", "interrupted"].includes(
                recipient.status,
            )
                ? ("live_mailbox" as const)
                : ("deferred_until_resume" as const),
        },
    };
}

function parseMessageIdForTool(value: string) {
    if (!UUID_PATTERN.test(value)) throw new ValidationError("messageId must be a UUID");
    return value.toLowerCase() as Parameters<SqliteControlPlaneStore["getMessage"]>[0];
}

function parseThreadIdForTool(value: string) {
    return parseThreadId(value);
}

function jsonObject(value: JsonValue): Readonly<Record<string, JsonValue>> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Readonly<Record<string, JsonValue>>)
        : {};
}
