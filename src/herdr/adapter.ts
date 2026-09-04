import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import {
    type HerdrCliErrorBody,
    HerdrCommandError,
    HerdrRenameError,
    type HerdrRenameRollback,
    type HerdrRenameStep,
    HerdrValidationError,
} from "./errors.ts";
import {
    type CommandExecution,
    type CommandInvocation,
    type CommandRunner,
    createNodeCommandRunner,
} from "./executor.ts";

export const HERDR_ALIAS_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

export type HerdrAgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export type HerdrReadSource = "visible" | "recent" | "recent-unwrapped" | "detection";

export interface HerdrCurrentContext {
    readonly workspaceId: string;
    readonly tabId: string;
    readonly paneId: string;
    readonly source: "environment" | "cli";
}

export interface HerdrOwnedSurface {
    readonly ownershipId: string;
    readonly workspaceId: string;
    readonly tabId: string;
    readonly paneId: string;
    readonly cwd: string;
    readonly alias: string;
    readonly paneLabel: string;
    readonly tabLabel: string;
    readonly agentStarted: boolean;
    readonly closed: boolean;
}

/** Serializable ownership capability stored by the parent supervisor. */
export type PersistedHerdrSurface = HerdrOwnedSurface;

interface MutableSurface extends HerdrOwnedSurface {
    alias: string;
    paneLabel: string;
    tabLabel: string;
    agentStarted: boolean;
    closed: boolean;
}

export interface HerdrAdapterOptions {
    readonly runner?: CommandRunner;
    readonly executable?: string;
    readonly environment?: Readonly<Record<string, string | undefined>>;
    readonly defaultTimeoutMs?: number;
    readonly startupTimeoutMs?: number;
}

export interface HerdrOperationOptions {
    readonly timeoutMs?: number;
    readonly signal?: AbortSignal;
}

export interface CreateHerdrSurfaceOptions extends HerdrOperationOptions {
    readonly alias: string;
    readonly cwd: string;
    readonly label?: string;
    readonly workspaceId?: string;
    readonly env?: Readonly<Record<string, string>>;
}

export interface StartPiOptions extends HerdrOperationOptions {
    readonly args?: readonly string[];
    /** Herdr's independent readiness deadline passed to `agent start`. */
    readonly readinessTimeoutMs?: number;
}

export interface PromptOptions extends HerdrOperationOptions {
    readonly wait?: boolean;
    readonly until?: readonly HerdrAgentStatus[];
}

export interface WaitOptions extends HerdrOperationOptions {
    readonly until?: readonly HerdrAgentStatus[];
}

export interface ReadAgentOptions extends HerdrOperationOptions {
    readonly source?: HerdrReadSource;
    readonly lines?: number;
    readonly format?: "text" | "ansi";
}

export interface HerdrAgentInspection {
    readonly alias?: string;
    readonly paneId?: string;
    readonly status: HerdrAgentStatus;
    readonly raw: Readonly<Record<string, unknown>>;
}

export interface HerdrAgentRead {
    readonly text: string;
    readonly source: HerdrReadSource;
    readonly raw: Readonly<Record<string, unknown>>;
}

export interface HerdrOperationResult {
    readonly raw: Readonly<Record<string, unknown>>;
    readonly status?: HerdrAgentStatus;
}

interface JsonEnvelope {
    readonly result: Readonly<Record<string, unknown>>;
}

const VALID_STATUSES = new Set<HerdrAgentStatus>(["idle", "working", "blocked", "done", "unknown"]);
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(
    value: unknown,
    path: string,
    invocation: CommandInvocation,
    execution: CommandExecution,
): string {
    if (typeof value !== "string" || value.length === 0) {
        throw new HerdrCommandError(
            `Malformed Herdr response: ${path} must be a non-empty string`,
            invocation,
            { execution },
        );
    }
    return value;
}

function optionalStatus(value: unknown): HerdrAgentStatus | undefined {
    return typeof value === "string" && VALID_STATUSES.has(value as HerdrAgentStatus)
        ? (value as HerdrAgentStatus)
        : undefined;
}

function statusFrom(result: Readonly<Record<string, unknown>>): HerdrAgentStatus | undefined {
    const agent = isRecord(result.agent) ? result.agent : undefined;
    return (
        optionalStatus(result.status) ??
        optionalStatus(result.agent_status) ??
        optionalStatus(agent?.status) ??
        optionalStatus(agent?.agent_status)
    );
}

function requiredStatus(
    result: Readonly<Record<string, unknown>>,
    invocation: CommandInvocation,
    execution: CommandExecution,
): HerdrAgentStatus {
    const status = statusFrom(result);
    if (!status) {
        throw new HerdrCommandError(
            "Malformed Herdr response: agent status is missing or invalid",
            invocation,
            { execution },
        );
    }
    return status;
}

function operationResult(result: Readonly<Record<string, unknown>>): HerdrOperationResult {
    const status = statusFrom(result);
    return status ? { raw: result, status } : { raw: result };
}

function parseJsonLine(value: string): unknown {
    const lines = value
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        try {
            return JSON.parse(lines[index]!);
        } catch {
            // Herdr may be preceded by a launcher diagnostic; only JSON is trusted.
        }
    }
    return undefined;
}

function parseCliError(execution: CommandExecution): HerdrCliErrorBody | undefined {
    for (const stream of [execution.stderr, execution.stdout]) {
        const parsed = parseJsonLine(stream);
        if (!isRecord(parsed) || !isRecord(parsed.error)) continue;
        const error = parsed.error;
        return {
            ...(typeof error.code === "string" ? { code: error.code } : {}),
            ...(typeof error.message === "string" ? { message: error.message } : {}),
            ...("details" in error ? { details: error.details } : {}),
        };
    }
    return undefined;
}

function assertAlias(alias: string): void {
    if (!HERDR_ALIAS_PATTERN.test(alias)) {
        throw new HerdrValidationError(
            `Invalid Herdr alias ${JSON.stringify(alias)}; expected [a-z][a-z0-9_-]{0,31}`,
        );
    }
}

function assertText(value: string, field: string): void {
    if (value.length === 0) throw new HerdrValidationError(`${field} must not be empty`);
    if (value.includes("\0")) throw new HerdrValidationError(`${field} must not contain NUL`);
}

function assertTimeout(value: number, field = "timeoutMs"): void {
    if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
        throw new HerdrValidationError(`${field} must be a positive safe integer`);
    }
}

function assertLines(value: number): void {
    if (!Number.isSafeInteger(value) || value < 1 || value > 100_000) {
        throw new HerdrValidationError("lines must be an integer between 1 and 100000");
    }
}

export class HerdrAdapter {
    readonly #runner: CommandRunner;
    readonly #executable: string;
    readonly #environment: Readonly<Record<string, string | undefined>>;
    readonly #defaultTimeoutMs: number;
    readonly #startupTimeoutMs: number;
    readonly #owned = new WeakSet<object>();
    readonly #ownershipIds = new Set<string>();
    readonly #ownedLocations = new Set<string>();

    constructor(options: HerdrAdapterOptions = {}) {
        this.#runner = options.runner ?? createNodeCommandRunner();
        this.#executable = options.executable ?? "herdr";
        this.#environment = options.environment ?? process.env;
        this.#defaultTimeoutMs = options.defaultTimeoutMs ?? 35_000;
        this.#startupTimeoutMs = options.startupTimeoutMs ?? 30_000;
        assertText(this.#executable, "executable");
        assertTimeout(this.#defaultTimeoutMs, "defaultTimeoutMs");
        assertTimeout(this.#startupTimeoutMs, "startupTimeoutMs");
    }

    isManagedEnvironment(): boolean {
        return this.#environment.HERDR_ENV === "1";
    }

    async discoverCurrentContext(
        options: HerdrOperationOptions = {},
    ): Promise<HerdrCurrentContext> {
        this.#assertManaged();
        const workspaceId = this.#environment.HERDR_WORKSPACE_ID;
        const tabId = this.#environment.HERDR_TAB_ID;
        const paneId = this.#environment.HERDR_PANE_ID;
        if (workspaceId && tabId && paneId) {
            return { workspaceId, tabId, paneId, source: "environment" };
        }

        const { result, invocation, execution } = await this.#run(
            ["pane", "current", "--current"],
            options,
        );
        const pane = isRecord(result.pane) ? result.pane : undefined;
        if (!pane) {
            throw new HerdrCommandError(
                "Malformed Herdr response: result.pane is missing",
                invocation,
                { execution },
            );
        }
        return {
            workspaceId: requiredString(
                pane.workspace_id,
                "result.pane.workspace_id",
                invocation,
                execution,
            ),
            tabId: requiredString(pane.tab_id, "result.pane.tab_id", invocation, execution),
            paneId: requiredString(pane.pane_id, "result.pane.pane_id", invocation, execution),
            source: "cli",
        };
    }

    async createSurface(options: CreateHerdrSurfaceOptions): Promise<HerdrOwnedSurface> {
        this.#assertManaged();
        assertAlias(options.alias);
        assertText(options.cwd, "cwd");
        if (!isAbsolute(options.cwd)) {
            throw new HerdrValidationError("cwd must be an absolute path");
        }
        const label = options.label ?? options.alias;
        assertText(label, "label");
        const workspaceId =
            options.workspaceId ?? (await this.discoverCurrentContext(options)).workspaceId;
        assertText(workspaceId, "workspaceId");

        const args = [
            "tab",
            "create",
            "--workspace",
            workspaceId,
            "--cwd",
            options.cwd,
            "--label",
            label,
        ];
        for (const [key, value] of Object.entries(options.env ?? {}).toSorted(([a], [b]) =>
            a.localeCompare(b),
        )) {
            if (!ENV_KEY_PATTERN.test(key)) {
                throw new HerdrValidationError(`Invalid environment key ${JSON.stringify(key)}`);
            }
            assertText(value, `env.${key}`);
            args.push("--env", `${key}=${value}`);
        }
        args.push("--no-focus");

        const { result, invocation, execution } = await this.#run(args, options);
        const tab = isRecord(result.tab) ? result.tab : undefined;
        const rootPane = isRecord(result.root_pane) ? result.root_pane : undefined;
        if (!tab || !rootPane) {
            throw new HerdrCommandError(
                "Malformed Herdr response: tab create requires result.tab and result.root_pane",
                invocation,
                { execution },
            );
        }
        const returnedWorkspaceId =
            typeof tab.workspace_id === "string" ? tab.workspace_id : workspaceId;
        if (returnedWorkspaceId !== workspaceId) {
            throw new HerdrCommandError(
                `Malformed Herdr response: workspace mismatch (${returnedWorkspaceId} != ${workspaceId})`,
                invocation,
                { execution },
            );
        }

        const surface: MutableSurface = {
            ownershipId: randomUUID(),
            workspaceId,
            tabId: requiredString(tab.tab_id, "result.tab.tab_id", invocation, execution),
            paneId: requiredString(
                rootPane.pane_id,
                "result.root_pane.pane_id",
                invocation,
                execution,
            ),
            cwd: options.cwd,
            alias: options.alias,
            paneLabel: label,
            tabLabel: label,
            agentStarted: false,
            closed: false,
        };
        this.#register(surface);
        return surface;
    }

    /**
     * Re-adopt a capability persisted by the supervisor after a parent restart.
     * Registration happens only after live-agent and pane topology proofs pass.
     */
    async recoverSurface(
        record: PersistedHerdrSurface,
        options: HerdrOperationOptions = {},
    ): Promise<HerdrOwnedSurface> {
        this.#assertManaged();
        this.#validatePersistedRecord(record);
        if (this.#ownershipIds.has(record.ownershipId)) {
            throw new HerdrValidationError("Surface ownershipId is already adopted");
        }
        if (this.#ownedLocations.has(this.#locationKey(record))) {
            throw new HerdrValidationError("Surface tab/pane is already adopted");
        }

        const agentResponse = await this.#run(["agent", "get", record.alias], options);
        const agent = isRecord(agentResponse.result.agent)
            ? agentResponse.result.agent
            : agentResponse.result;
        const liveAlias = [agent.name, agent.alias, agent.agent_name].find(
            (value): value is string => typeof value === "string",
        );
        const livePaneId = [agent.pane_id, agent.paneId].find(
            (value): value is string => typeof value === "string",
        );
        if (liveAlias !== record.alias) {
            throw new HerdrCommandError(
                `Recovery identity mismatch: live alias ${JSON.stringify(liveAlias)} != ${JSON.stringify(record.alias)}`,
                agentResponse.invocation,
                { execution: agentResponse.execution },
            );
        }
        if (livePaneId !== record.paneId) {
            throw new HerdrCommandError(
                `Recovery identity mismatch: live pane ${JSON.stringify(livePaneId)} != ${JSON.stringify(record.paneId)}`,
                agentResponse.invocation,
                { execution: agentResponse.execution },
            );
        }
        requiredStatus(agentResponse.result, agentResponse.invocation, agentResponse.execution);

        // Herdr 0.8.2 `pane get <pane_id>` returns the pane at result.pane;
        // verify every persisted topology ID before granting ownership.
        const paneResponse = await this.#run(["pane", "get", record.paneId], options);
        const pane = isRecord(paneResponse.result.pane) ? paneResponse.result.pane : undefined;
        if (!pane) {
            throw new HerdrCommandError(
                "Malformed Herdr response: result.pane is missing",
                paneResponse.invocation,
                { execution: paneResponse.execution },
            );
        }
        const checks: Array<[unknown, string, string]> = [
            [pane.pane_id, record.paneId, "pane"],
            [pane.tab_id, record.tabId, "tab"],
            [pane.workspace_id, record.workspaceId, "workspace"],
        ];
        for (const [actual, expected, field] of checks) {
            if (actual !== expected) {
                throw new HerdrCommandError(
                    `Recovery topology mismatch: live ${field} ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`,
                    paneResponse.invocation,
                    { execution: paneResponse.execution },
                );
            }
        }
        const paneAlias = [pane.agent_name, pane.agent_alias, pane.live_agent_name].find(
            (value): value is string => typeof value === "string",
        );
        if (paneAlias !== undefined && paneAlias !== record.alias) {
            throw new HerdrCommandError(
                `Recovery identity mismatch: pane agent ${JSON.stringify(paneAlias)} != ${JSON.stringify(record.alias)}`,
                paneResponse.invocation,
                { execution: paneResponse.execution },
            );
        }
        const paneStatusValue = pane.agent_status ?? pane.status;
        if (paneStatusValue !== undefined && optionalStatus(paneStatusValue) === undefined) {
            throw new HerdrCommandError(
                "Malformed Herdr response: pane agent status is invalid",
                paneResponse.invocation,
                { execution: paneResponse.execution },
            );
        }

        const surface: MutableSurface = { ...record };
        this.#register(surface);
        return surface;
    }

    /** Produce a detached record suitable for durable supervisor storage. */
    snapshotSurface(surface: HerdrOwnedSurface): PersistedHerdrSurface {
        return { ...this.#requireOwned(surface) };
    }

    async startPi(
        surface: HerdrOwnedSurface,
        options: StartPiOptions = {},
    ): Promise<HerdrOperationResult> {
        const owned = this.#requireOwned(surface);
        if (owned.agentStarted) {
            throw new HerdrValidationError("Pi agent has already been started on this surface");
        }
        const readinessTimeoutMs = options.readinessTimeoutMs ?? this.#startupTimeoutMs;
        assertTimeout(readinessTimeoutMs, "readinessTimeoutMs");
        const args = [
            "agent",
            "start",
            owned.alias,
            "--kind",
            "pi",
            "--pane",
            owned.paneId,
            "--timeout",
            String(readinessTimeoutMs),
        ];
        for (const value of options.args ?? []) assertText(value, "Pi argument");
        if (options.args?.length) args.push("--", ...options.args);
        const { result } = await this.#run(args, {
            ...options,
            timeoutMs: options.timeoutMs ?? readinessTimeoutMs + 5_000,
        });
        owned.agentStarted = true;
        return operationResult(result);
    }

    async prompt(
        surface: HerdrOwnedSurface,
        text: string,
        options: PromptOptions = {},
    ): Promise<HerdrOperationResult> {
        return this.#submitPrompt(surface, text, options);
    }

    /** Insert corrective input into a live Pi turn without Escape or resume. */
    async steer(
        surface: HerdrOwnedSurface,
        text: string,
        options: HerdrOperationOptions = {},
    ): Promise<HerdrOperationResult> {
        return this.#submitPrompt(surface, text, { ...options, wait: false });
    }

    async interrupt(
        surface: HerdrOwnedSurface,
        options: HerdrOperationOptions = {},
    ): Promise<HerdrOperationResult> {
        const owned = this.#requireStarted(surface);
        const { result } = await this.#run(["agent", "send-keys", owned.alias, "esc"], options);
        return operationResult(result);
    }

    async wait(
        surface: HerdrOwnedSurface,
        options: WaitOptions = {},
    ): Promise<HerdrOperationResult> {
        const owned = this.#requireStarted(surface);
        const args = ["agent", "wait", owned.alias];
        this.#appendUntil(args, options.until);
        if (options.timeoutMs !== undefined) args.push("--timeout", String(options.timeoutMs));
        const { result } = await this.#run(args, options);
        return operationResult(result);
    }

    async inspect(
        surface: HerdrOwnedSurface,
        options: HerdrOperationOptions = {},
    ): Promise<HerdrAgentInspection> {
        const owned = this.#requireStarted(surface);
        const { result, invocation, execution } = await this.#run(
            ["agent", "get", owned.alias],
            options,
        );
        const agent = isRecord(result.agent) ? result.agent : result;
        const status = statusFrom(result) ?? statusFrom(agent);
        if (!status) {
            throw new HerdrCommandError(
                "Malformed Herdr response: agent status is missing or invalid",
                invocation,
                { execution },
            );
        }
        return {
            ...(typeof agent.name === "string" ? { alias: agent.name } : {}),
            ...(typeof agent.pane_id === "string" ? { paneId: agent.pane_id } : {}),
            status,
            raw: result,
        };
    }

    async read(
        surface: HerdrOwnedSurface,
        options: ReadAgentOptions = {},
    ): Promise<HerdrAgentRead> {
        const owned = this.#requireStarted(surface);
        const source = options.source ?? "recent-unwrapped";
        const lines = options.lines ?? 120;
        assertLines(lines);
        const format = options.format ?? "text";
        const { result, invocation, execution } = await this.#run(
            [
                "agent",
                "read",
                owned.alias,
                "--source",
                source,
                "--lines",
                String(lines),
                "--format",
                format,
            ],
            options,
        );
        const read = isRecord(result.read) ? result.read : undefined;
        const text = [result.text, result.content, result.output, read?.text].find(
            (value): value is string => typeof value === "string",
        );
        if (text === undefined) {
            throw new HerdrCommandError(
                "Malformed Herdr response: agent read text is missing",
                invocation,
                { execution },
            );
        }
        return { text, source, raw: result };
    }

    async rename(
        surface: HerdrOwnedSurface,
        newAlias: string,
        newLabel = newAlias,
        options: HerdrOperationOptions = {},
    ): Promise<void> {
        const owned = this.#requireStarted(surface);
        assertAlias(newAlias);
        assertText(newLabel, "newLabel");
        const fromAlias = owned.alias;
        const fromPaneLabel = owned.paneLabel;
        const fromTabLabel = owned.tabLabel;
        if (newAlias === fromAlias && newLabel === fromPaneLabel && newLabel === fromTabLabel) {
            return;
        }

        const applied: HerdrRenameStep[] = [];
        let failedStep: HerdrRenameStep = "agent";
        try {
            if (newAlias !== fromAlias) {
                await this.#run(["agent", "rename", fromAlias, newAlias], options);
                owned.alias = newAlias;
                applied.push("agent");
            }
            failedStep = "pane";
            if (newLabel !== owned.paneLabel) {
                await this.#run(["pane", "rename", owned.paneId, newLabel], options);
                owned.paneLabel = newLabel;
                applied.push("pane");
            }
            failedStep = "tab";
            if (newLabel !== owned.tabLabel) {
                await this.#run(["tab", "rename", owned.tabId, newLabel], options);
                owned.tabLabel = newLabel;
                applied.push("tab");
            }
        } catch (error) {
            const commandError = this.#asCommandError(error);
            const rollback: HerdrRenameRollback[] = [];
            // Compensation must remain possible if the initiating signal was
            // aborted, so rollback intentionally receives a fresh signal scope.
            const rollbackOptions: HerdrOperationOptions =
                options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs };
            for (const step of applied.toReversed()) {
                try {
                    if (step === "tab") {
                        // oxlint-disable-next-line no-await-in-loop -- rollback order is transactional
                        await this.#run(
                            ["tab", "rename", owned.tabId, fromTabLabel],
                            rollbackOptions,
                        );
                        owned.tabLabel = fromTabLabel;
                    } else if (step === "pane") {
                        // oxlint-disable-next-line no-await-in-loop -- rollback order is transactional
                        await this.#run(
                            ["pane", "rename", owned.paneId, fromPaneLabel],
                            rollbackOptions,
                        );
                        owned.paneLabel = fromPaneLabel;
                    } else {
                        // oxlint-disable-next-line no-await-in-loop -- rollback order is transactional
                        await this.#run(
                            ["agent", "rename", owned.alias, fromAlias],
                            rollbackOptions,
                        );
                        owned.alias = fromAlias;
                    }
                    rollback.push({ step, status: "succeeded" });
                } catch (rollbackError) {
                    rollback.push({
                        step,
                        status: "failed",
                        error: this.#asCommandError(rollbackError),
                    });
                }
            }
            throw new HerdrRenameError(
                {
                    fromAlias,
                    toAlias: newAlias,
                    fromLabel: fromTabLabel,
                    fromPaneLabel,
                    fromTabLabel,
                    toLabel: newLabel,
                    failedStep,
                    appliedSteps: [...applied],
                    rollback,
                },
                commandError,
            );
        }
    }

    async close(surface: HerdrOwnedSurface, options: HerdrOperationOptions = {}): Promise<void> {
        const owned = this.#requireOwned(surface);
        await this.#run(["tab", "close", owned.tabId], options);
        owned.closed = true;
        this.#owned.delete(owned);
        this.#ownershipIds.delete(owned.ownershipId);
        this.#ownedLocations.delete(this.#locationKey(owned));
    }

    async #submitPrompt(
        surface: HerdrOwnedSurface,
        text: string,
        options: PromptOptions,
    ): Promise<HerdrOperationResult> {
        const owned = this.#requireStarted(surface);
        assertText(text, "prompt");
        const args = ["agent", "prompt", owned.alias, text];
        if (options.wait) {
            args.push("--wait");
            this.#appendUntil(args, options.until);
        }
        if (options.timeoutMs !== undefined) args.push("--timeout", String(options.timeoutMs));
        const { result } = await this.#run(args, options);
        return operationResult(result);
    }

    #appendUntil(args: string[], statuses: readonly HerdrAgentStatus[] | undefined): void {
        if (!statuses) return;
        if (statuses.length === 0) {
            throw new HerdrValidationError("until must contain at least one status");
        }
        for (const status of statuses) {
            if (!VALID_STATUSES.has(status)) {
                throw new HerdrValidationError(
                    `Invalid Herdr agent status ${JSON.stringify(status)}`,
                );
            }
            args.push("--until", status);
        }
    }

    #assertManaged(): void {
        if (!this.isManagedEnvironment()) {
            throw new HerdrValidationError(
                "HERDR_ENV=1 is required; refusing to control another client's focused Herdr session",
            );
        }
    }

    #requireOwned(surface: HerdrOwnedSurface): MutableSurface {
        this.#assertManaged();
        if (!this.#owned.has(surface)) {
            throw new HerdrValidationError("Surface is not explicitly owned by this adapter");
        }
        const owned = surface as MutableSurface;
        if (owned.closed) throw new HerdrValidationError("Surface is already closed");
        return owned;
    }

    #requireStarted(surface: HerdrOwnedSurface): MutableSurface {
        const owned = this.#requireOwned(surface);
        if (!owned.agentStarted) {
            throw new HerdrValidationError("Pi agent has not been started on this surface");
        }
        return owned;
    }

    #validatePersistedRecord(record: PersistedHerdrSurface): void {
        if (!isRecord(record)) {
            throw new HerdrValidationError("Persisted surface must be an object");
        }
        for (const [field, value] of [
            ["ownershipId", record.ownershipId],
            ["workspaceId", record.workspaceId],
            ["tabId", record.tabId],
            ["paneId", record.paneId],
            ["cwd", record.cwd],
            ["paneLabel", record.paneLabel],
            ["tabLabel", record.tabLabel],
        ] as const) {
            assertText(value, field);
        }
        assertAlias(record.alias);
        if (!isAbsolute(record.cwd)) {
            throw new HerdrValidationError("cwd must be an absolute path");
        }
        if (!record.agentStarted) {
            throw new HerdrValidationError("Cannot recover a surface without a started Pi agent");
        }
        if (record.closed) throw new HerdrValidationError("Cannot recover a closed surface");
    }

    #locationKey(surface: Pick<HerdrOwnedSurface, "tabId" | "paneId">): string {
        return `${surface.tabId}\0${surface.paneId}`;
    }

    #register(surface: MutableSurface): void {
        if (this.#ownershipIds.has(surface.ownershipId)) {
            throw new HerdrValidationError("Surface ownershipId is already adopted");
        }
        const location = this.#locationKey(surface);
        if (this.#ownedLocations.has(location)) {
            throw new HerdrValidationError("Surface tab/pane is already adopted");
        }
        this.#owned.add(surface);
        this.#ownershipIds.add(surface.ownershipId);
        this.#ownedLocations.add(location);
    }

    #asCommandError(error: unknown): HerdrCommandError {
        if (error instanceof HerdrCommandError) return error;
        throw error;
    }

    async #run(
        args: readonly string[],
        options: HerdrOperationOptions,
    ): Promise<JsonEnvelope & { invocation: CommandInvocation; execution: CommandExecution }> {
        const timeoutMs = options.timeoutMs ?? this.#defaultTimeoutMs;
        assertTimeout(timeoutMs);
        const invocation: CommandInvocation = {
            executable: this.#executable,
            args: [...args],
            timeoutMs,
            ...(options.signal ? { signal: options.signal } : {}),
        };
        let execution: CommandExecution;
        try {
            execution = await this.#runner(invocation);
        } catch (cause) {
            throw new HerdrCommandError("Failed to execute Herdr", invocation, { cause });
        }

        const cliError = parseCliError(execution);
        if (execution.termination !== "exited" || execution.exitCode !== 0 || cliError) {
            const reason =
                cliError?.message ??
                cliError?.code ??
                (execution.termination === "timed_out" ? "command timed out" : undefined) ??
                (execution.termination === "aborted" ? "command aborted" : undefined) ??
                (execution.termination === "output_limit"
                    ? "command output limit exceeded"
                    : undefined) ??
                execution.error?.message ??
                `command exited with status ${execution.exitCode}`;
            throw new HerdrCommandError(`Herdr command failed: ${reason}`, invocation, {
                execution,
                ...(cliError ? { cliError } : {}),
                ...(execution.error ? { cause: execution.error } : {}),
            });
        }

        const parsed = parseJsonLine(execution.stdout);
        if (!isRecord(parsed) || !isRecord(parsed.result)) {
            throw new HerdrCommandError(
                "Malformed Herdr response: expected a JSON object with result",
                invocation,
                { execution },
            );
        }
        return { result: parsed.result, invocation, execution };
    }
}
