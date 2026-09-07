import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { OrchestratorConfig } from "../config.ts";
import {
    type AgentPatch,
    type AgentRecord,
    type AgentStatus,
    canTransitionAgent,
} from "../domain/agent.ts";
import { ValidationError } from "../domain/errors.ts";
import { type AgentId, parseAgentId } from "../domain/ids.ts";
import type { EnqueueResult } from "../domain/mailbox.ts";
import { type JsonValue, validateAlias, validateLabel } from "../domain/validation.ts";
import type { Failpoint } from "../faults.ts";
import type {
    HerdrAdapter,
    HerdrAgentInspection,
    HerdrOwnedSurface,
    PersistedHerdrSurface,
} from "../herdr/index.ts";
import type { SqliteControlPlaneStore } from "../storage/index.ts";
import { OrchestratorError } from "./errors.ts";
import type {
    RecoveryEntry,
    RenameAgentRequest,
    ResumeAgentRequest,
    SendAgentMessageRequest,
    SpawnAgentRequest,
    SpawnAgentResult,
    SteerAgentRequest,
    SteerAgentResult,
} from "./types.ts";

type HerdrControl = Pick<
    HerdrAdapter,
    | "createSurface"
    | "startPi"
    | "prompt"
    | "interrupt"
    | "inspect"
    | "rename"
    | "close"
    | "recoverSurface"
    | "snapshotSurface"
>;

export interface SupervisorOptions {
    readonly store: SqliteControlPlaneStore;
    readonly herdr: HerdrControl;
    readonly config: OrchestratorConfig;
    readonly parentAgentId: AgentId;
    readonly sessionDir: string;
    readonly extensionPath: string;
    readonly lifecycleExtensionPath?: string;
    readonly workspaceId?: string;
    readonly failpoint?: Failpoint;
}

const LIVE_STATUSES = new Set<AgentStatus>([
    "starting",
    "running",
    "idle",
    "blocked",
    "interrupted",
    "stopping",
    "orphaned",
]);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CHILD_PROTOCOL_TOOLS = [
    "agent_complete",
    "agent_mail_send",
    "agent_mail_list",
    "agent_mail_read",
    "agent_mail_ack",
    "agent_mail_sent",
    "agent_mail_retry",
    "agent_directory",
] as const;
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const TOOL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/u;
const CONTROL_RECIPIENT_STATUSES = new Set<AgentStatus>([
    "starting",
    "running",
    "idle",
    "blocked",
    "interrupted",
]);

type AgentLifecyclePhase =
    | "create_surface"
    | "persist_surface"
    | "start_pi"
    | "persist_started_surface"
    | "submit_initial_prompt"
    | "mark_running"
    | "resume_create_surface"
    | "resume_persist_surface"
    | "resume_pi"
    | "resume_persist_started_surface"
    | "submit_resume_prompt"
    | "mark_resumed";

function jsonObject(value: JsonValue): Readonly<Record<string, JsonValue>> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Readonly<Record<string, JsonValue>>)
        : {};
}

function mergeMetadata(
    record: AgentRecord,
    values: Readonly<Record<string, JsonValue>>,
): JsonValue {
    return { ...jsonObject(record.metadata), ...values };
}

function persistedSurface(metadata: JsonValue): PersistedHerdrSurface | undefined {
    const root = jsonObject(metadata);
    const control = jsonObject(root.piHerdr ?? null);
    const candidate = control.surface;
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
        return undefined;
    }
    return candidate as unknown as PersistedHerdrSurface;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function instructionPrompt(prompt: string): string {
    return `${prompt}\n\n[Pi Herdr protocol]\nWhen the assigned work is genuinely complete, call agent_complete exactly once with a concise summary and structured result. Do not exit merely because a turn settled. If interrupted, remain available for corrective instructions.`;
}

export class AgentSupervisor {
    readonly #store: SqliteControlPlaneStore;
    readonly #herdr: HerdrControl;
    readonly #config: OrchestratorConfig;
    readonly #parentAgentId: AgentId;
    readonly #rootAgentId: AgentId;
    readonly #sessionDir: string;
    readonly #extensionPath: string;
    readonly #lifecycleExtensionPath: string | undefined;
    readonly #workspaceId: string | undefined;
    readonly #failpoint: Failpoint | undefined;
    readonly #surfaces = new Map<AgentId, HerdrOwnedSurface>();

    constructor(options: SupervisorOptions) {
        this.#store = options.store;
        this.#herdr = options.herdr;
        this.#config = options.config;
        this.#parentAgentId = options.parentAgentId;
        this.#rootAgentId = options.store.getAgent(options.parentAgentId).rootAgentId;
        this.#sessionDir = options.sessionDir;
        this.#extensionPath = options.extensionPath;
        this.#lifecycleExtensionPath = options.lifecycleExtensionPath;
        this.#workspaceId = options.workspaceId;
        this.#failpoint = options.failpoint;
    }

    async spawn(request: SpawnAgentRequest, signal?: AbortSignal): Promise<SpawnAgentResult> {
        this.#assertContent(request.prompt, this.#config.maxMessageBytes, "prompt");
        const alias = validateAlias(request.alias);
        const displayName = validateLabel(request.displayName ?? alias, "displayName");
        const role = validateLabel(request.role, "role");
        this.#assertCapacity();

        const sessionId = randomUUID();
        const childSessionDir = join(this.#sessionDir, "pi-herdr", "sessions");
        const childArgs = this.#childPiArgs(request, sessionId, childSessionDir, displayName);
        mkdirSync(childSessionDir, { recursive: true });
        let agent = this.#store.registerAgent({
            ...(request.runId === undefined ? {} : { runId: request.runId }),
            alias,
            displayName,
            role,
            sessionId,
            parentAgentId: this.#parentAgentId,
            metadata: request.metadata ?? {},
        });
        agent = this.#store.transitionAgent({
            agentId: agent.id,
            status: "starting",
            patch: {},
            expectedRevision: agent.revision,
        });

        let surface: HerdrOwnedSurface | undefined;
        let phase: AgentLifecyclePhase = "create_surface";
        try {
            surface = await this.#herdr.createSurface({
                alias,
                cwd: request.cwd,
                label: displayName,
                ...(this.#workspaceId === undefined ? {} : { workspaceId: this.#workspaceId }),
                env: {
                    PI_HERDR_AGENT_ID: agent.id,
                    PI_HERDR_RUN_ID: agent.runId,
                    PI_HERDR_DB: this.#config.databasePath,
                    PI_HERDR_PARENT_ID: this.#parentAgentId,
                    PI_HERDR_ROLE: role,
                },
                timeoutMs: this.#config.operationTimeoutMs,
                ...(signal === undefined ? {} : { signal }),
            });
            this.#surfaces.set(agent.id, surface);
            phase = "persist_surface";
            agent = this.#recordSurface(agent.id, surface);

            phase = "start_pi";
            await this.#herdr.startPi(surface, {
                args: childArgs,
                readinessTimeoutMs: this.#config.launchTimeoutMs,
                timeoutMs: this.#config.launchTimeoutMs + 5_000,
                ...(signal === undefined ? {} : { signal }),
            });
            phase = "persist_started_surface";
            agent = this.#recordSurface(agent.id, surface);
            phase = "submit_initial_prompt";
            await this.#herdr.prompt(surface, instructionPrompt(request.prompt), {
                timeoutMs: this.#config.operationTimeoutMs,
                ...(signal === undefined ? {} : { signal }),
            });
            phase = "mark_running";
            agent = this.#markPromptSubmitted(agent.id, "running");
            return { agent, sessionId };
        } catch (cause) {
            const orphaned =
                surface === undefined ? false : !(await this.#closeAfterFailure(surface));
            this.#surfaces.delete(agent.id);
            agent = this.#markLaunchFailure(agent.id, cause, orphaned, phase);
            throw new OrchestratorError(
                "EXTERNAL_OPERATION_FAILED",
                `Failed to launch agent ${alias} during ${phase}: ${errorMessage(cause)}`,
                {
                    cause,
                    details: { agentId: agent.id, alias, status: agent.status, orphaned, phase },
                    retryable: true,
                },
            );
        }
    }

    send(request: SendAgentMessageRequest): EnqueueResult {
        this.#assertContent(request.content, this.#config.maxMessageBytes, "content");
        const recipient = this.resolveAgent(request.recipient);
        if (request.kind === "control" && !CONTROL_RECIPIENT_STATUSES.has(recipient.status)) {
            throw new ValidationError(
                `Cannot deliver control mail to ${recipient.alias} in ${recipient.status} state`,
            );
        }
        if (recipient.status === "completed" || recipient.status === "failed") {
            throw new ValidationError(`Cannot send mail to terminal agent ${recipient.alias}`);
        }
        return this.#store.enqueueMessage({
            ...(request.senderAgentId === undefined
                ? { senderAgentId: this.#parentAgentId }
                : { senderAgentId: request.senderAgentId }),
            recipientAgentId: recipient.id,
            kind: request.kind ?? "message",
            content: request.content,
            metadata: request.metadata ?? {},
            ...(request.idempotencyKey === undefined
                ? {}
                : { idempotencyKey: request.idempotencyKey }),
            ...(request.replyToMessageId === undefined
                ? {}
                : { replyToMessageId: request.replyToMessageId }),
            ttlMs: this.#config.messageTtlMs,
        });
    }

    async steer(request: SteerAgentRequest, signal?: AbortSignal): Promise<SteerAgentResult> {
        signal?.throwIfAborted();
        this.#assertContent(request.instruction, this.#config.maxMessageBytes, "instruction");
        const recipient = this.resolveAgent(request.recipient);
        const delivery = this.send({
            senderAgentId: request.senderAgentId ?? this.#parentAgentId,
            recipient: recipient.id,
            kind: "control",
            content: request.instruction,
            metadata: { action: "steer" },
            ...(request.idempotencyKey === undefined
                ? {}
                : { idempotencyKey: request.idempotencyKey }),
        });
        // The recipient's extension pump injects this message with Pi's `deliverAs: "steer"`.
        // Calling `herdr agent prompt` here as well would duplicate the corrective payload.
        return { agent: this.#store.getAgent(recipient.id), delivery };
    }

    async interrupt(agent: AgentId | string, signal?: AbortSignal): Promise<AgentRecord> {
        const record = this.resolveAgent(agent);
        const surface = await this.#surfaceFor(record);
        await this.#herdr.interrupt(surface, {
            timeoutMs: this.#config.operationTimeoutMs,
            ...(signal === undefined ? {} : { signal }),
        });
        return this.#transition(record.id, "interrupted");
    }

    async rename(request: RenameAgentRequest, signal?: AbortSignal): Promise<AgentRecord> {
        const current = this.resolveAgent(request.agent);
        const alias = validateAlias(request.alias);
        const displayName = validateLabel(request.displayName ?? alias, "displayName");
        const surface = await this.#surfaceFor(current);

        await this.#herdr.rename(surface, alias, displayName, {
            timeoutMs: this.#config.operationTimeoutMs,
            ...(signal === undefined ? {} : { signal }),
        });
        let registryRenamed: AgentRecord | undefined;
        try {
            const latest = this.#store.getAgent(current.id);
            registryRenamed = this.#store.renameAgent({
                agentId: latest.id,
                alias,
                displayName,
                expectedRevision: latest.revision,
            });
            this.send({
                recipient: registryRenamed.id,
                kind: "control",
                content: `Your durable display name is now ${displayName}.`,
                metadata: { action: "rename", displayName },
                idempotencyKey: `rename:${registryRenamed.id}:${registryRenamed.revision}`,
            });
            return registryRenamed;
        } catch (cause) {
            let registryRollbackError: unknown;
            if (registryRenamed !== undefined) {
                try {
                    const latest = this.#store.getAgent(current.id);
                    this.#store.renameAgent({
                        agentId: latest.id,
                        alias: current.alias,
                        displayName: current.displayName,
                        expectedRevision: latest.revision,
                    });
                } catch (rollbackCause) {
                    registryRollbackError = rollbackCause;
                }
            }
            let externalRollbackError: unknown;
            try {
                await this.#herdr.rename(surface, current.alias, current.displayName, {
                    timeoutMs: this.#config.operationTimeoutMs,
                });
            } catch (rollbackCause) {
                externalRollbackError = rollbackCause;
            }
            if (registryRollbackError !== undefined || externalRollbackError !== undefined) {
                throw new OrchestratorError(
                    "EXTERNAL_OPERATION_FAILED",
                    "Rename failed and one or more rollback projections also failed",
                    {
                        cause,
                        details: {
                            agentId: current.id,
                            originalError: errorMessage(cause),
                            registryRollbackError:
                                registryRollbackError === undefined
                                    ? null
                                    : errorMessage(registryRollbackError),
                            externalRollbackError:
                                externalRollbackError === undefined
                                    ? null
                                    : errorMessage(externalRollbackError),
                        },
                    },
                );
            }
            throw cause;
        }
    }

    async stop(agent: AgentId | string, signal?: AbortSignal): Promise<AgentRecord> {
        const current = this.resolveAgent(agent);
        const stopping = this.#transition(current.id, "stopping");
        try {
            const surface = await this.#surfaceFor(stopping);
            this.#failpoint?.("herdr.close.before", { agentId: stopping.id });
            await this.#herdr.close(surface, {
                timeoutMs: this.#config.operationTimeoutMs,
                ...(signal === undefined ? {} : { signal }),
            });
            this.#failpoint?.("herdr.close.after", { agentId: stopping.id });
            this.#surfaces.delete(stopping.id);
            return this.#transition(stopping.id, "stopped");
        } catch (cause) {
            const orphaned = this.#transition(stopping.id, "orphaned");
            throw new OrchestratorError(
                "EXTERNAL_OPERATION_FAILED",
                `Failed to stop agent ${current.alias}: ${errorMessage(cause)}`,
                { cause, details: { agentId: orphaned.id }, retryable: true },
            );
        }
    }

    async resume(request: ResumeAgentRequest, signal?: AbortSignal): Promise<AgentRecord> {
        const current = this.resolveAgent(request.agent);
        if (["running", "idle", "blocked", "interrupted"].includes(current.status)) {
            if (request.instruction === undefined) return current;
            return (
                await this.steer(
                    { recipient: current.id, instruction: request.instruction },
                    signal,
                )
            ).agent;
        }
        if (current.status === "orphaned") {
            throw new OrchestratorError(
                "RECOVERY_FAILED",
                "Cannot resume an orphaned agent until its external Herdr state is reconciled",
                { details: { agentId: current.id } },
            );
        }
        if (!["stopped", "completed", "failed"].includes(current.status)) {
            throw new OrchestratorError("NOT_READY", `Agent ${current.alias} cannot be resumed`, {
                details: { agentId: current.id, status: current.status },
            });
        }

        const pendingCompletion = this.#store.getCompletion(current.id);
        if (
            pendingCompletion?.runId === current.runId &&
            ["emitted", "parent_applied"].includes(pendingCompletion.state)
        ) {
            throw new OrchestratorError(
                "NOT_READY",
                "Completion is awaiting parent acknowledgement; retry resume after it is processed",
                {
                    details: { agentId: current.id, completionState: pendingCompletion.state },
                },
            );
        }
        const oldSurface = persistedSurface(current.metadata);
        if (!oldSurface) {
            throw new OrchestratorError("RECOVERY_FAILED", "Agent working directory is unknown", {
                details: { agentId: current.id },
            });
        }
        const sessionFile = this.#validateSession(current, oldSurface.cwd);
        let agent = this.#transition(current.id, "starting");
        let surface: HerdrOwnedSurface | undefined;
        let phase: AgentLifecyclePhase = "resume_create_surface";
        try {
            surface = await this.#herdr.createSurface({
                alias: agent.alias,
                cwd: oldSurface.cwd,
                label: agent.displayName,
                ...(this.#workspaceId === undefined ? {} : { workspaceId: this.#workspaceId }),
                env: {
                    PI_HERDR_AGENT_ID: agent.id,
                    PI_HERDR_RUN_ID: agent.runId,
                    PI_HERDR_DB: this.#config.databasePath,
                    PI_HERDR_PARENT_ID: this.#parentAgentId,
                    PI_HERDR_ROLE: agent.role,
                },
                timeoutMs: this.#config.operationTimeoutMs,
                ...(signal === undefined ? {} : { signal }),
            });
            this.#surfaces.set(agent.id, surface);
            phase = "resume_persist_surface";
            agent = this.#recordSurface(agent.id, surface);
            phase = "resume_pi";
            await this.#herdr.startPi(surface, {
                args: [
                    ...this.#isolatedExtensionArgs(),
                    "--session",
                    sessionFile,
                    "--name",
                    agent.displayName,
                ],
                readinessTimeoutMs: this.#config.launchTimeoutMs,
                timeoutMs: this.#config.launchTimeoutMs + 5_000,
                ...(signal === undefined ? {} : { signal }),
            });
            phase = "resume_persist_started_surface";
            agent = this.#recordSurface(agent.id, surface);
            if (request.instruction !== undefined) {
                this.#assertContent(
                    request.instruction,
                    this.#config.maxMessageBytes,
                    "instruction",
                );
                phase = "submit_resume_prompt";
                await this.#herdr.prompt(surface, request.instruction, {
                    timeoutMs: this.#config.operationTimeoutMs,
                    ...(signal === undefined ? {} : { signal }),
                });
                phase = "mark_resumed";
                return this.#markPromptSubmitted(agent.id, "running");
            }
            phase = "mark_resumed";
            return this.#markPromptSubmitted(agent.id, "idle");
        } catch (cause) {
            const orphaned =
                surface === undefined ? false : !(await this.#closeAfterFailure(surface));
            this.#surfaces.delete(agent.id);
            this.#markLaunchFailure(agent.id, cause, orphaned, phase);
            throw new OrchestratorError(
                "EXTERNAL_OPERATION_FAILED",
                `Failed to resume agent ${current.alias} during ${phase}: ${errorMessage(cause)}`,
                { cause, details: { agentId: current.id, orphaned, phase }, retryable: true },
            );
        }
    }

    async recover(signal?: AbortSignal): Promise<readonly RecoveryEntry[]> {
        const entries: RecoveryEntry[] = [];
        let cursor: string | undefined;
        do {
            const page = this.#store.listAgents({
                parentAgentId: this.#parentAgentId,
                limit: this.#config.maxPageSize,
                ...(cursor === undefined ? {} : { cursor }),
            });
            for (const agent of page.items) {
                if (!LIVE_STATUSES.has(agent.status)) continue;
                const snapshot = persistedSurface(agent.metadata);
                if (!snapshot) {
                    const marked = this.#transition(agent.id, "orphaned");
                    entries.push({
                        agentId: agent.id,
                        recovered: false,
                        status: marked.status,
                        error: "persisted surface capability is missing",
                    });
                    continue;
                }
                try {
                    // Recovery is deliberately ordered to keep external reconciliation bounded.
                    // oxlint-disable-next-line no-await-in-loop
                    const surface = await this.#herdr.recoverSurface(snapshot, {
                        timeoutMs: this.#config.operationTimeoutMs,
                        ...(signal === undefined ? {} : { signal }),
                    });
                    this.#surfaces.set(agent.id, surface);
                    // oxlint-disable-next-line no-await-in-loop
                    const inspection = await this.#herdr.inspect(surface, {
                        timeoutMs: this.#config.operationTimeoutMs,
                        ...(signal === undefined ? {} : { signal }),
                    });
                    const recovered = this.#applyInspection(agent.id, inspection);
                    entries.push({
                        agentId: agent.id,
                        recovered: true,
                        status: recovered.status,
                    });
                } catch (cause) {
                    const marked = this.#transition(agent.id, "orphaned");
                    entries.push({
                        agentId: agent.id,
                        recovered: false,
                        status: marked.status,
                        error: errorMessage(cause),
                    });
                }
            }
            cursor = page.nextCursor;
        } while (cursor !== undefined);
        return entries;
    }

    resolveAgent(identifier: AgentId | string): AgentRecord {
        const agent = UUID_PATTERN.test(identifier)
            ? this.#store.getAgent(parseAgentId(identifier))
            : this.#store.getAgentByAlias(validateAlias(identifier), this.#rootAgentId);
        if (agent.rootAgentId !== this.#rootAgentId) {
            throw new ValidationError("Agent is outside this coordinator ownership namespace");
        }
        return agent;
    }

    async finalizeCompletedAgent(agentId: AgentId): Promise<void> {
        const agent = this.#store.getAgent(agentId);
        if (agent.status !== "completed" && agent.status !== "failed") return;
        const surface = this.#surfaces.get(agentId) ?? (await this.#surfaceFor(agent));
        this.#failpoint?.("herdr.close.before", { agentId });
        try {
            await this.#herdr.close(surface, { timeoutMs: this.#config.operationTimeoutMs });
            this.#failpoint?.("herdr.close.after", { agentId });
            this.#surfaces.delete(agentId);
        } catch (cause) {
            throw new OrchestratorError(
                "EXTERNAL_OPERATION_FAILED",
                `Completion is durable but the Herdr surface for ${agent.alias} could not be closed`,
                { cause, details: { agentId }, retryable: true },
            );
        }
    }

    #childPiArgs(
        request: SpawnAgentRequest,
        sessionId: string,
        sessionDir: string,
        displayName: string,
    ): string[] {
        const args = [
            ...this.#isolatedExtensionArgs(),
            "--session-id",
            sessionId,
            "--session-dir",
            sessionDir,
            "--name",
            displayName,
        ];
        if (request.model !== undefined) {
            args.push("--model", validateLabel(request.model, "model", 256));
        }
        if (request.thinking !== undefined) {
            if (!THINKING_LEVELS.has(request.thinking)) {
                throw new ValidationError("thinking is not a supported Pi thinking level", {
                    field: "thinking",
                });
            }
            args.push("--thinking", request.thinking);
        }
        if (request.tools !== undefined) {
            if (
                request.tools.length > 128 ||
                request.tools.some((tool) => !TOOL_NAME_PATTERN.test(tool))
            ) {
                throw new ValidationError("tools must contain at most 128 valid Pi tool names", {
                    field: "tools",
                });
            }
            args.push(
                "--tools",
                [...new Set([...request.tools, ...CHILD_PROTOCOL_TOOLS])].join(","),
            );
        }
        return args;
    }

    #isolatedExtensionArgs(): string[] {
        return [
            "--extensions",
            ...(this.#lifecycleExtensionPath === undefined
                ? []
                : ["--extension", this.#lifecycleExtensionPath]),
            "--extension",
            this.#extensionPath,
        ];
    }

    #assertCapacity(): void {
        let count = 0;
        let cursor: string | undefined;
        do {
            const page = this.#store.listAgents({
                rootAgentId: this.#rootAgentId,
                limit: this.#config.maxPageSize,
                ...(cursor === undefined ? {} : { cursor }),
            });
            count += page.items.filter((item) => LIVE_STATUSES.has(item.status)).length;
            if (count >= this.#config.maxLiveAgents) {
                throw new OrchestratorError(
                    "LIMIT_EXCEEDED",
                    `Maximum live agent count (${this.#config.maxLiveAgents}) reached`,
                );
            }
            cursor = page.nextCursor;
        } while (cursor !== undefined);
    }

    #assertContent(value: string, maximum: number, field: string): void {
        if (typeof value !== "string" || value.length === 0) {
            throw new ValidationError(`${field} must be a non-empty string`, { field });
        }
        if (Buffer.byteLength(value, "utf8") > maximum) {
            throw new ValidationError(`${field} exceeds ${maximum} UTF-8 bytes`, {
                field,
                maximum,
            });
        }
    }

    #recordSurface(agentId: AgentId, surface: HerdrOwnedSurface): AgentRecord {
        const current = this.#store.getAgent(agentId);
        const snapshot = this.#herdr.snapshotSurface(surface);
        return this.#store.patchAgent({
            agentId,
            patch: {
                workspaceId: snapshot.workspaceId,
                tabId: snapshot.tabId,
                paneId: snapshot.paneId,
                metadata: mergeMetadata(current, {
                    piHerdr: {
                        surface: snapshot as unknown as JsonValue,
                    },
                }),
            },
            expectedRevision: current.revision,
        });
    }

    async #surfaceFor(agent: AgentRecord): Promise<HerdrOwnedSurface> {
        const existing = this.#surfaces.get(agent.id);
        if (existing) return existing;
        const snapshot = persistedSurface(agent.metadata);
        if (!snapshot) {
            throw new OrchestratorError("RECOVERY_FAILED", "Agent has no persisted Herdr surface", {
                details: { agentId: agent.id },
            });
        }
        const recovered = await this.#herdr.recoverSurface(snapshot, {
            timeoutMs: this.#config.operationTimeoutMs,
        });
        this.#surfaces.set(agent.id, recovered);
        return recovered;
    }

    #transition(agentId: AgentId, status: AgentStatus, patch: AgentPatch = {}): AgentRecord {
        const current = this.#store.getAgent(agentId);
        if (current.status === status) return current;
        return this.#store.transitionAgent({
            agentId,
            status,
            patch,
            expectedRevision: current.revision,
        });
    }

    #markPromptSubmitted(agentId: AgentId, status: "running" | "idle"): AgentRecord {
        const current = this.#store.getAgent(agentId);
        if (current.status !== "starting" && current.status !== status) {
            // A child can settle while the native prompt command is returning.
            this.#store.recordEvent({
                rootAgentId: current.rootAgentId,
                entityId: agentId,
                runId: current.runId,
                type: "agent.late_prompt_receipt",
                data: { current: current.status, observed: status },
            });
            return current;
        }
        return this.#transition(agentId, status);
    }

    #applyInspection(agentId: AgentId, inspection: HerdrAgentInspection): AgentRecord {
        const target: AgentStatus | undefined =
            inspection.status === "working"
                ? "running"
                : inspection.status === "blocked"
                  ? "blocked"
                  : inspection.status === "idle" || inspection.status === "done"
                    ? "idle"
                    : undefined;
        const current = this.#store.getAgent(agentId);
        const observed = target ?? "orphaned";
        if (current.status !== observed && !canTransitionAgent(current.status, observed)) {
            // Native idle/done is an observation, not authority to reverse an
            // interrupted turn, a stop in flight, or a committed completion.
            this.#store.recordEvent({
                rootAgentId: current.rootAgentId,
                entityId: agentId,
                runId: current.runId,
                type: "agent.observation_ignored",
                data: { current: current.status, observed },
            });
            return current;
        }
        return this.#transition(agentId, observed);
    }

    async #closeAfterFailure(surface: HerdrOwnedSurface): Promise<boolean> {
        try {
            await this.#herdr.close(surface, { timeoutMs: this.#config.operationTimeoutMs });
            return true;
        } catch {
            return false;
        }
    }

    #markLaunchFailure(
        agentId: AgentId,
        cause: unknown,
        orphaned: boolean,
        phase: AgentLifecyclePhase,
    ): AgentRecord {
        const current = this.#store.getAgent(agentId);
        const metadata = mergeMetadata(current, {
            launchFailure: { message: errorMessage(cause), phase, at: Date.now() },
        });
        const target: AgentStatus = orphaned ? "orphaned" : "failed";
        if (canTransitionAgent(current.status, target)) {
            return this.#store.transitionAgent({
                agentId,
                status: target,
                patch: { metadata },
                expectedRevision: current.revision,
            });
        }
        return this.#store.patchAgent({
            agentId,
            patch: { metadata },
            expectedRevision: current.revision,
        });
    }

    #validateSession(agent: AgentRecord, expectedCwd: string): string {
        if (!agent.sessionFile || !existsSync(agent.sessionFile)) {
            throw new OrchestratorError("SESSION_INVALID", "Agent session file does not exist", {
                details: { agentId: agent.id, sessionFile: agent.sessionFile ?? null },
            });
        }
        const firstLine = readFileSync(agent.sessionFile, "utf8").split(/\r?\n/u, 1)[0];
        let header: unknown;
        try {
            header = JSON.parse(firstLine ?? "");
        } catch (cause) {
            throw new OrchestratorError("SESSION_INVALID", "Agent session header is invalid JSON", {
                cause,
                details: { agentId: agent.id, sessionFile: agent.sessionFile },
            });
        }
        if (
            typeof header !== "object" ||
            header === null ||
            !("type" in header) ||
            (header as { type?: unknown }).type !== "session" ||
            !("id" in header) ||
            (header as { id?: unknown }).id !== agent.sessionId ||
            !("cwd" in header) ||
            (header as { cwd?: unknown }).cwd !== expectedCwd
        ) {
            throw new OrchestratorError(
                "SESSION_INVALID",
                "Agent session identity does not match",
                {
                    details: { agentId: agent.id, sessionFile: agent.sessionFile },
                },
            );
        }
        return agent.sessionFile;
    }
}
