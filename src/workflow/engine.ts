import { createHash, randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import type { AgentRecord, AgentStatus } from "../domain/agent.ts";
import { ControlPlaneError, ValidationError } from "../domain/errors.ts";
import { type AgentId, parseAgentId, parseWorkflowId, type WorkflowId } from "../domain/ids.ts";
import {
    assertJsonValue,
    type JsonValue,
    MAX_MESSAGE_BYTES,
    validateAlias,
    validateLabel,
    validatePositiveInteger,
} from "../domain/validation.ts";
import type { WorkflowNodeRecord, WorkflowRecord } from "../domain/workflow.ts";
import type { SpawnAgentRequest } from "../orchestrator/types.ts";
import type { SqliteControlPlaneStore } from "../storage/index.ts";
import type {
    StartWorkflowInput,
    WorkflowAgentCompletion,
    WorkflowCancelResult,
    WorkflowNodeFailure,
    WorkflowNodeResult,
    WorkflowSupervisor,
    WorkflowTaskInput,
    WorkflowTickResult,
} from "./types.ts";

interface WorkflowEngineOptions {
    readonly store: SqliteControlPlaneStore;
    readonly supervisor: WorkflowSupervisor;
    readonly rootAgentId: AgentId;
    readonly maxConcurrent?: number;
}

interface AgentBinding {
    readonly version: 1;
    readonly runId: string;
    readonly state: "reserved" | "succeeded" | "failed";
    readonly workflowId: WorkflowId;
    readonly nodeId: string;
    readonly spawnKey: string;
    readonly alias: string;
    readonly agentId?: string;
}

interface ReservationOutput {
    readonly piHerdr: AgentBinding;
    readonly result?: JsonValue;
    readonly details?: JsonValue;
}

const TERMINAL_AGENT_STATUSES = new Set<AgentStatus>(["failed", "stopped"]);
const STOPPABLE_AGENT_STATUSES = new Set<AgentStatus>([
    "registered",
    "starting",
    "running",
    "idle",
    "blocked",
    "interrupted",
    "stopping",
    "orphaned",
]);

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorText(cause: unknown): string {
    const value = cause instanceof Error ? cause.message : String(cause);
    return value.length <= 4_096 ? value : `${value.slice(0, 4_093)}...`;
}

function isControlError(cause: unknown, code: string): boolean {
    return cause instanceof ControlPlaneError && cause.code === code;
}

function spawnKey(workflowId: WorkflowId, nodeId: string): string {
    return `workflow:${workflowId}:${nodeId}`;
}

function agentAlias(base: string, workflowId: WorkflowId, nodeId: string): string {
    const suffix = createHash("sha256")
        .update(`${workflowId}\0${nodeId}`)
        .digest("hex")
        .slice(0, 8);
    return `${base.slice(0, 23)}-${suffix}`;
}

function reservation(workflowId: WorkflowId, nodeId: string, alias: string): ReservationOutput {
    return {
        piHerdr: {
            version: 1,
            runId: randomUUID(),
            state: "reserved",
            workflowId,
            nodeId,
            spawnKey: spawnKey(workflowId, nodeId),
            alias,
        },
    };
}

function toJsonValue(value: unknown, field: string): JsonValue {
    assertJsonValue(value, field, MAX_MESSAGE_BYTES + 4096);
    return value;
}

function bindingFrom(value: JsonValue | undefined): AgentBinding | undefined {
    if (!isObject(value) || !isObject(value.piHerdr)) return undefined;
    const binding = value.piHerdr;
    if (
        binding.version !== 1 ||
        typeof binding.runId !== "string" ||
        !["reserved", "succeeded", "failed"].includes(String(binding.state)) ||
        typeof binding.workflowId !== "string" ||
        typeof binding.nodeId !== "string" ||
        typeof binding.spawnKey !== "string" ||
        typeof binding.alias !== "string" ||
        (binding.agentId !== undefined && typeof binding.agentId !== "string")
    ) {
        return undefined;
    }
    return binding as unknown as AgentBinding;
}

function workflowMetadata(agent: AgentRecord): Readonly<Record<string, unknown>> | undefined {
    if (!isObject(agent.metadata) || !isObject(agent.metadata.piHerdrWorkflow)) return undefined;
    return agent.metadata.piHerdrWorkflow;
}

function bindingMatchesAgent(binding: AgentBinding, agent: AgentRecord): boolean {
    const metadata = workflowMetadata(agent);
    return (
        metadata?.workflowId === binding.workflowId &&
        metadata.nodeId === binding.nodeId &&
        metadata.spawnKey === binding.spawnKey &&
        agent.runId === binding.runId
    );
}

function bindingMatchesNode(binding: AgentBinding, node: WorkflowNodeRecord): boolean {
    return (
        binding.workflowId === node.workflowId &&
        binding.nodeId === node.nodeId &&
        binding.spawnKey === spawnKey(node.workflowId, node.nodeId)
    );
}

function normalizeTask(value: unknown, field: string): WorkflowTaskInput {
    if (!isObject(value)) throw new ValidationError(`${field} must be an object`, { field });
    const alias = validateAlias(value.alias);
    const role = validateLabel(value.role, `${field}.role`);
    const prompt = validateLabel(value.prompt, `${field}.prompt`, 65_536);
    const cwd = validateLabel(value.cwd, `${field}.cwd`, 4_096);
    if (!isAbsolute(cwd)) {
        throw new ValidationError(`${field}.cwd must be an absolute path`, {
            field: `${field}.cwd`,
        });
    }
    const displayName =
        value.displayName === undefined
            ? undefined
            : validateLabel(value.displayName, `${field}.displayName`);
    const model =
        value.model === undefined ? undefined : validateLabel(value.model, `${field}.model`, 256);
    const thinking =
        value.thinking === undefined
            ? undefined
            : validateLabel(value.thinking, `${field}.thinking`, 128);
    let tools: readonly string[] | undefined;
    if (value.tools !== undefined) {
        if (!Array.isArray(value.tools) || value.tools.length > 128) {
            throw new ValidationError(`${field}.tools must be an array with at most 128 items`, {
                field: `${field}.tools`,
            });
        }
        tools = value.tools.map((tool, index) =>
            validateLabel(tool, `${field}.tools.${index}`, 128),
        );
        if (new Set(tools).size !== tools.length) {
            throw new ValidationError(`${field}.tools must be unique`, { field: `${field}.tools` });
        }
    }
    return {
        alias,
        role,
        prompt,
        cwd,
        ...(displayName === undefined ? {} : { displayName }),
        ...(model === undefined ? {} : { model }),
        ...(thinking === undefined ? {} : { thinking }),
        ...(tools === undefined ? {} : { tools }),
    };
}

function taskFromNode(node: WorkflowNodeRecord): WorkflowTaskInput {
    return normalizeTask(node.input, `workflow.${node.workflowId}.${node.nodeId}.input`);
}

export class WorkflowEngine {
    readonly #store: SqliteControlPlaneStore;
    readonly #supervisor: WorkflowSupervisor;
    readonly #rootAgentId: AgentId;
    readonly #maxConcurrent: number;
    #activeTick: Promise<WorkflowTickResult> | undefined;

    constructor(options: WorkflowEngineOptions) {
        this.#store = options.store;
        this.#supervisor = options.supervisor;
        this.#rootAgentId = parseAgentId(options.rootAgentId);
        this.#maxConcurrent = validatePositiveInteger(
            options.maxConcurrent ?? 4,
            "maxConcurrent",
            1_000,
        );
    }

    start(input: StartWorkflowInput): WorkflowRecord {
        if (!Array.isArray(input.nodes)) {
            throw new ValidationError("nodes must be an array", { field: "nodes" });
        }
        const nodes = input.nodes.map((node, index) => ({
            nodeId: node.nodeId,
            ...(node.dependencies === undefined ? {} : { dependencies: node.dependencies }),
            input: toJsonValue(
                normalizeTask(node.task, `nodes.${index}.task`),
                `nodes.${index}.task`,
            ),
        }));
        return this.#store.createWorkflow({
            ...(input.id === undefined ? {} : { id: input.id }),
            rootAgentId: this.#rootAgentId,
            name: input.name,
            ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
            nodes,
        });
    }

    getStatus(workflowId: WorkflowId): WorkflowRecord {
        return this.#store.getWorkflow(parseWorkflowId(workflowId), this.#rootAgentId);
    }

    tick(signal?: AbortSignal): Promise<WorkflowTickResult> {
        if (this.#activeTick !== undefined) return this.#activeTick;
        const operation = this.#runTick(signal);
        this.#activeTick = operation;
        const clear = (): void => {
            if (this.#activeTick === operation) this.#activeTick = undefined;
        };
        void operation.then(clear, clear);
        return operation;
    }

    async acceptResult(event: WorkflowNodeResult): Promise<WorkflowRecord> {
        const workflowId = parseWorkflowId(event.workflowId);
        const agentId = parseAgentId(event.agentId);
        const current = this.#store.getWorkflow(workflowId, this.#rootAgentId);
        const node = this.#node(current, event.nodeId);
        const binding = this.#requireBinding(node);
        this.#assertEventAgent(binding, agentId);
        if (node.status === "succeeded") return current;
        if (node.status !== "running") {
            throw new ValidationError(`Cannot complete workflow node in ${node.status} state`, {
                workflowId,
                nodeId: node.nodeId,
            });
        }
        if (event.result !== undefined) assertJsonValue(event.result, "result", MAX_MESSAGE_BYTES);
        return this.#store.updateWorkflowNode({
            rootAgentId: this.#rootAgentId,
            workflowId,
            nodeId: node.nodeId,
            expectedRevision: node.revision,
            patch: {
                status: "succeeded",
                output: toJsonValue(
                    {
                        piHerdr: { ...binding, state: "succeeded", agentId },
                        ...(event.result === undefined ? {} : { result: event.result }),
                    },
                    "output",
                ),
            },
        });
    }

    async acceptFailure(event: WorkflowNodeFailure): Promise<WorkflowRecord> {
        const workflowId = parseWorkflowId(event.workflowId);
        const agentId = parseAgentId(event.agentId);
        const current = this.#store.getWorkflow(workflowId, this.#rootAgentId);
        const node = this.#node(current, event.nodeId);
        const binding = this.#requireBinding(node);
        this.#assertEventAgent(binding, agentId);
        if (node.status === "failed") return current;
        if (node.status !== "running") {
            throw new ValidationError(`Cannot fail workflow node in ${node.status} state`, {
                workflowId,
                nodeId: node.nodeId,
            });
        }
        if (event.details !== undefined)
            assertJsonValue(event.details, "details", MAX_MESSAGE_BYTES);
        return this.#store.updateWorkflowNode({
            rootAgentId: this.#rootAgentId,
            workflowId,
            nodeId: node.nodeId,
            expectedRevision: node.revision,
            patch: {
                status: "failed",
                error: errorText(event.error),
                output: toJsonValue(
                    {
                        piHerdr: { ...binding, state: "failed", agentId },
                        ...(event.details === undefined ? {} : { details: event.details }),
                    },
                    "output",
                ),
            },
        });
    }

    async acceptCompletion(event: WorkflowAgentCompletion): Promise<WorkflowRecord> {
        const agentId = parseAgentId(event.agentId);
        const agent = this.#store.getAgent(agentId);
        if (agent.rootAgentId !== this.#rootAgentId) {
            throw new ValidationError("Agent is outside this workflow namespace", { agentId });
        }
        const metadata = workflowMetadata(agent);
        if (
            typeof metadata?.workflowId !== "string" ||
            typeof metadata.nodeId !== "string" ||
            typeof metadata.spawnKey !== "string"
        ) {
            throw new ValidationError("Agent is not assigned to a workflow node", { agentId });
        }
        const workflowId = parseWorkflowId(metadata.workflowId);
        const workflow = this.#store.getWorkflow(workflowId, this.#rootAgentId);
        if (workflow.cancelRequestedAt !== undefined) {
            this.#store.recordEvent({
                rootAgentId: this.#rootAgentId,
                entityId: workflowId,
                runId: agent.runId,
                type: "workflow.completion_ignored",
                data: { agentId, reason: "cancel_requested" },
            });
            return workflow;
        }
        if (event.status === "succeeded") {
            return this.acceptResult({
                workflowId,
                nodeId: metadata.nodeId,
                agentId,
                ...(event.result === undefined ? {} : { result: event.result }),
            });
        }
        return this.acceptFailure({
            workflowId,
            nodeId: metadata.nodeId,
            agentId,
            error: errorText(event.error ?? "Agent reported failure"),
            ...(event.result === undefined ? {} : { details: event.result }),
        });
    }

    async cancel(workflowId: WorkflowId, signal?: AbortSignal): Promise<WorkflowCancelResult> {
        const id = parseWorkflowId(workflowId);
        const stopErrors: string[] = [];
        let workflow = this.#store.requestWorkflowCancellation(id, this.#rootAgentId);
        for (const snapshot of workflow.nodes) {
            if (signal?.aborted) throw signal.reason;
            let node = this.#node(this.#store.getWorkflow(id, this.#rootAgentId), snapshot.nodeId);
            if (node.status === "succeeded") continue;
            if (node.status === "running" || node.status === "cancelled") {
                const binding = bindingFrom(node.output);
                if (binding !== undefined && bindingMatchesNode(binding, node)) {
                    const agent = this.#findMappedAgent(binding);
                    if (agent !== undefined && STOPPABLE_AGENT_STATUSES.has(agent.status)) {
                        try {
                            // Stops are serialized because each one can change revisions and DAG
                            // state used by the next cancellation decision.
                            // eslint-disable-next-line no-await-in-loop
                            await this.#supervisor.stop(agent.id, signal);
                        } catch (cause) {
                            stopErrors.push(`${node.nodeId}: ${errorText(cause)}`);
                            this.#store.recordEvent({
                                rootAgentId: this.#rootAgentId,
                                entityId: id,
                                type: "workflow.cancel_retry",
                                data: {
                                    nodeId: node.nodeId,
                                    agentId: agent.id,
                                    error: errorText(cause),
                                },
                            });
                            continue;
                        }
                    }
                }
            }
            node = this.#node(this.#store.getWorkflow(id, this.#rootAgentId), snapshot.nodeId);
            if (["succeeded", "cancelled"].includes(node.status)) continue;
            try {
                workflow = this.#store.updateWorkflowNode({
                    rootAgentId: this.#rootAgentId,
                    workflowId: id,
                    nodeId: node.nodeId,
                    expectedRevision: node.revision,
                    patch: {
                        status: "cancelled",
                        ...(node.output === undefined ? {} : { output: node.output }),
                    },
                });
            } catch (cause) {
                if (!isControlError(cause, "REVISION_CONFLICT")) throw cause;
                workflow = this.#store.getWorkflow(id, this.#rootAgentId);
            }
        }
        return { workflow: this.#store.getWorkflow(id, this.#rootAgentId), stopErrors };
    }

    async #runTick(signal?: AbortSignal): Promise<WorkflowTickResult> {
        if (signal?.aborted) throw signal.reason;
        // Intent survives a cancelled tool call, a late spawn, and coordinator restart.
        let cancellationCursor: string | undefined;
        do {
            const page = this.#store.listWorkflows({
                rootAgentId: this.#rootAgentId,
                cancelRequestedOnly: true,
                limit: 100,
                ...(cancellationCursor === undefined ? {} : { cursor: cancellationCursor }),
            });
            for (const workflow of page.items) {
                // eslint-disable-next-line no-await-in-loop
                await this.cancel(workflow.id, signal);
            }
            cancellationCursor = page.nextCursor;
        } while (cancellationCursor !== undefined);
        let resumed = 0;
        let spawnFailures = 0;
        const active = this.#activeWorkflows();

        const reservations = active.flatMap((workflow) =>
            workflow.nodes
                .filter((node) => node.status === "running")
                .map((node) => ({ workflowId: workflow.id, nodeId: node.nodeId })),
        );
        for (const reserved of reservations) {
            if (signal?.aborted) throw signal.reason;
            // Reconciliation is serialized so a restart does not create a spawn burst before
            // each durable alias/metadata lookup has completed.
            // eslint-disable-next-line no-await-in-loop
            const outcome = await this.#resumeReservation(
                reserved.workflowId,
                reserved.nodeId,
                signal,
            );
            resumed += outcome.resumed;
            spawnFailures += outcome.failed;
        }

        const refreshed = this.#activeWorkflows();
        const running = refreshed.reduce(
            (count, workflow) =>
                count + workflow.nodes.filter((node) => node.status === "running").length,
            0,
        );
        let available = Math.max(0, this.#maxConcurrent - running);
        const claimed: Array<{ workflowId: WorkflowId; nodeId: string }> = [];
        for (const workflow of refreshed) {
            for (const snapshot of workflow.nodes) {
                if (available === 0) break;
                if (snapshot.status !== "ready") continue;
                if (signal?.aborted) throw signal.reason;
                try {
                    const task = taskFromNode(snapshot);
                    this.#store.updateWorkflowNode({
                        rootAgentId: this.#rootAgentId,
                        workflowId: workflow.id,
                        nodeId: snapshot.nodeId,
                        expectedRevision: snapshot.revision,
                        patch: {
                            status: "running",
                            output: toJsonValue(
                                reservation(
                                    workflow.id,
                                    snapshot.nodeId,
                                    agentAlias(task.alias, workflow.id, snapshot.nodeId),
                                ),
                                "reservation",
                            ),
                        },
                    });
                    claimed.push({ workflowId: workflow.id, nodeId: snapshot.nodeId });
                    available -= 1;
                } catch (cause) {
                    if (!isControlError(cause, "REVISION_CONFLICT")) throw cause;
                }
            }
            if (available === 0) break;
        }

        const outcomes = await Promise.all(
            claimed.map((entry) => this.#resumeReservation(entry.workflowId, entry.nodeId, signal)),
        );
        spawnFailures += outcomes.reduce((count, outcome) => count + outcome.failed, 0);
        return { claimed: claimed.length, resumed, spawnFailures };
    }

    async #resumeReservation(
        workflowId: WorkflowId,
        nodeId: string,
        signal?: AbortSignal,
    ): Promise<{ readonly resumed: number; readonly failed: number }> {
        if (
            this.#store.getWorkflow(workflowId, this.#rootAgentId).cancelRequestedAt !== undefined
        ) {
            await this.cancel(workflowId, signal);
            return { resumed: 0, failed: 0 };
        }
        const node = this.#node(this.#store.getWorkflow(workflowId, this.#rootAgentId), nodeId);
        if (node.status !== "running") return { resumed: 0, failed: 0 };
        const binding = bindingFrom(node.output);
        if (binding === undefined || !bindingMatchesNode(binding, node)) {
            this.#failReservation(
                workflowId,
                node,
                "Running node has no durable spawn reservation",
            );
            return { resumed: 0, failed: 1 };
        }
        const existing = this.#findMappedAgent(binding);
        if (existing !== undefined) {
            if (TERMINAL_AGENT_STATUSES.has(existing.status)) {
                this.#failReservation(
                    workflowId,
                    node,
                    `Reserved agent ${existing.alias} is ${existing.status}`,
                );
                return { resumed: 0, failed: 1 };
            }
            return { resumed: 1, failed: 0 };
        }

        try {
            await this.#supervisor.spawn(this.#spawnRequest(node, binding), signal);
            if (
                this.#store.getWorkflow(workflowId, this.#rootAgentId).cancelRequestedAt !==
                undefined
            ) {
                await this.cancel(workflowId);
            }
            return { resumed: 0, failed: 0 };
        } catch (cause) {
            if (
                this.#store.getWorkflow(workflowId, this.#rootAgentId).cancelRequestedAt !==
                undefined
            ) {
                await this.cancel(workflowId);
                return { resumed: 0, failed: 0 };
            }
            const raced = this.#findMappedAgent(binding);
            if (raced !== undefined && !TERMINAL_AGENT_STATUSES.has(raced.status)) {
                return { resumed: 1, failed: 0 };
            }
            this.#failReservation(workflowId, node, errorText(cause));
            return { resumed: 0, failed: 1 };
        }
    }

    #spawnRequest(node: WorkflowNodeRecord, binding: AgentBinding): SpawnAgentRequest {
        const task = taskFromNode(node);
        return {
            ...task,
            runId: binding.runId,
            alias: binding.alias,
            displayName: task.displayName ?? task.alias,
            metadata: {
                piHerdrWorkflow: {
                    workflowId: binding.workflowId,
                    nodeId: binding.nodeId,
                    spawnKey: binding.spawnKey,
                },
            },
        };
    }

    #failReservation(workflowId: WorkflowId, snapshot: WorkflowNodeRecord, error: string): void {
        const current = this.#node(
            this.#store.getWorkflow(workflowId, this.#rootAgentId),
            snapshot.nodeId,
        );
        if (current.status !== "running") return;
        try {
            this.#store.updateWorkflowNode({
                rootAgentId: this.#rootAgentId,
                workflowId,
                nodeId: current.nodeId,
                expectedRevision: current.revision,
                patch: {
                    status: "failed",
                    error: errorText(error),
                    ...(current.output === undefined ? {} : { output: current.output }),
                },
            });
        } catch (cause) {
            if (!isControlError(cause, "REVISION_CONFLICT")) throw cause;
        }
    }

    #assertEventAgent(binding: AgentBinding, agentId: string): void {
        const agent = this.#store.getAgent(parseAgentId(agentId));
        if (agent.rootAgentId !== this.#rootAgentId || !bindingMatchesAgent(binding, agent)) {
            throw new ValidationError("Agent is not assigned to this workflow node", {
                agentId,
                workflowId: binding.workflowId,
                nodeId: binding.nodeId,
            });
        }
    }

    #findMappedAgent(binding: AgentBinding): AgentRecord | undefined {
        try {
            const byAlias = this.#store.getAgentByAlias(binding.alias, this.#rootAgentId);
            if (bindingMatchesAgent(binding, byAlias)) return byAlias;
        } catch (cause) {
            if (!isControlError(cause, "NOT_FOUND")) throw cause;
        }

        let cursor: string | undefined;
        do {
            const page = this.#store.listAgents({
                rootAgentId: this.#rootAgentId,
                limit: 100,
                ...(cursor ? { cursor } : {}),
            });
            const match = page.items.find((agent) => bindingMatchesAgent(binding, agent));
            if (match !== undefined) return match;
            cursor = page.nextCursor;
        } while (cursor !== undefined);
        return undefined;
    }

    #activeWorkflows(): readonly WorkflowRecord[] {
        const result: WorkflowRecord[] = [];
        for (const status of ["pending", "running"] as const) {
            let cursor: string | undefined;
            do {
                const page = this.#store.listWorkflows({
                    rootAgentId: this.#rootAgentId,
                    status,
                    limit: 100,
                    ...(cursor ? { cursor } : {}),
                });
                result.push(
                    ...page.items.filter((workflow) => workflow.cancelRequestedAt === undefined),
                );
                cursor = page.nextCursor;
            } while (cursor !== undefined);
        }
        return result;
    }

    #requireBinding(node: WorkflowNodeRecord): AgentBinding {
        const binding = bindingFrom(node.output);
        if (binding === undefined || !bindingMatchesNode(binding, node)) {
            throw new ValidationError("Workflow node has no durable agent binding", {
                workflowId: node.workflowId,
                nodeId: node.nodeId,
            });
        }
        return binding;
    }

    #node(workflow: WorkflowRecord, nodeId: string): WorkflowNodeRecord {
        const node = workflow.nodes.find((candidate) => candidate.nodeId === nodeId);
        if (node === undefined) {
            throw new ValidationError(`Unknown workflow node: ${nodeId}`, {
                workflowId: workflow.id,
                nodeId,
            });
        }
        return node;
    }
}

export type { WorkflowEngineOptions };
