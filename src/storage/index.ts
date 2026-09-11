import { createHash } from "node:crypto";
import type { AgentPage, AgentRecord, RegisterAgentInput } from "../domain/agent.ts";
import { ValidationError } from "../domain/errors.ts";
import type { AgentId, MessageId, WorkflowId } from "../domain/ids.ts";
import type {
    EnqueueMessageInput,
    EnqueueResult,
    MailboxFilter,
    MailboxMessage,
    MessagePage,
    OutboxFilter,
} from "../domain/mailbox.ts";
import type { CreateWorkflowInput, WorkflowPage, WorkflowRecord } from "../domain/workflow.ts";
import {
    type AgentLeaseInput,
    AgentRepository,
    type ListAgentsOptions,
    type PatchAgentInput,
    type RenameAgentInput,
    type TransitionAgentInput,
} from "./agents.ts";
import {
    type CompletionOutboxRecord,
    CompletionRepository,
    type DeclareCompletionInput,
    type MailboxEffectRecord,
    type MailboxEffectState,
} from "./completions.ts";
import { type Clock, type OpenStoreOptions, StorageDatabase } from "./database.ts";
import { type EventQuery, EventRepository } from "./events.ts";
import {
    type AcquireExecutionInput,
    type ExecutionLease,
    ExecutionRepository,
} from "./executions.ts";
import { canonicalJson } from "./json.ts";
import {
    type ClaimMessagesInput,
    type DeadLetterMessageInput,
    type ListNamespaceMessagesInput,
    MailboxRepository,
    type MaintenanceResult,
    type MessageMutationInput,
    type PruneMessagesInput,
    type PruneMessagesResult,
    type RenewMessageLeaseInput,
    type RequeueDeadLetterInput,
    type RetryMessageInput,
} from "./mailbox.ts";
import {
    type ListWorkflowsOptions,
    type TransitionWorkflowInput,
    type UpdateWorkflowNodeInput,
    WorkflowRepository,
} from "./workflows.ts";

export { LATEST_SCHEMA_VERSION } from "./migrations.ts";
export type {
    AcquireExecutionInput,
    ExecutionLease,
    AgentLeaseInput,
    ClaimMessagesInput,
    Clock,
    CompletionOutboxRecord,
    DeadLetterMessageInput,
    DeclareCompletionInput,
    ListAgentsOptions,
    ListNamespaceMessagesInput,
    ListWorkflowsOptions,
    MailboxEffectRecord,
    MailboxEffectState,
    MaintenanceResult,
    MessageMutationInput,
    OpenStoreOptions,
    PatchAgentInput,
    PruneMessagesInput,
    PruneMessagesResult,
    RenameAgentInput,
    RenewMessageLeaseInput,
    RequeueDeadLetterInput,
    RetryMessageInput,
    TransitionAgentInput,
    TransitionWorkflowInput,
    UpdateWorkflowNodeInput,
};

/**
 * Synchronous durable control-plane facade. Each mutation commits before it
 * returns; callers may safely construct a new facade over the same file after
 * process restart.
 */
export class SqliteControlPlaneStore {
    readonly #database: StorageDatabase;
    readonly #agents: AgentRepository;
    readonly #mailbox: MailboxRepository;
    readonly #completions: CompletionRepository;
    readonly #workflows: WorkflowRepository;
    readonly #events: EventRepository;
    readonly #executions: ExecutionRepository;

    private constructor(options: OpenStoreOptions) {
        this.#database = new StorageDatabase(options);
        this.#agents = new AgentRepository(this.#database);
        this.#mailbox = new MailboxRepository(this.#database);
        this.#completions = new CompletionRepository(this.#database);
        this.#workflows = new WorkflowRepository(this.#database);
        this.#events = new EventRepository(this.#database);
        this.#executions = new ExecutionRepository(this.#database);
    }

    static open(options: OpenStoreOptions): SqliteControlPlaneStore {
        return new SqliteControlPlaneStore(options);
    }

    close(): void {
        this.#database.close();
    }

    get execution(): ExecutionLease | undefined {
        return this.#executions.lease;
    }

    acquireExecution(input: AcquireExecutionInput): ExecutionLease {
        return this.#executions.acquire(input);
    }

    renewExecution(leaseMs: number): ExecutionLease {
        return this.#executions.renew(leaseMs);
    }

    releaseExecution(): boolean {
        return this.#executions.release();
    }

    assertExecution(): void {
        this.#database.connection.transaction(() => this.#executions.assertCurrent()).immediate();
    }

    #write<T>(operation: () => T): T {
        return this.#database.connection
            .transaction(() => {
                this.#executions.assertCurrent();
                const result = operation();
                // Fail closed if a long synchronous operation outlives its lease.
                this.#executions.assertCurrent();
                return result;
            })
            .immediate();
    }

    listEvents(input: EventQuery) {
        return this.#events.list(input);
    }

    recordEvent(input: Parameters<EventRepository["append"]>[0]): void {
        this.#write(() => this.#events.append(input));
    }

    databaseHealth() {
        const db = this.#database.connection;
        return {
            schema: db
                .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
                .all(),
            journalMode: db.pragma("journal_mode", { simple: true }),
            foreignKeys: db.pragma("foreign_keys", { simple: true }) === 1,
            quickCheck: db.pragma("quick_check(1)", { simple: true }),
            allocatedBytes:
                Number(db.pragma("page_count", { simple: true })) *
                Number(db.pragma("page_size", { simple: true })),
        };
    }

    requestWorkflowCancellation(workflowId: WorkflowId, rootAgentId: AgentId): WorkflowRecord {
        return this.#write(() => this.#workflows.requestCancellation(workflowId, rootAgentId));
    }

    registerAgent(input: RegisterAgentInput): AgentRecord {
        return this.#write(() => this.#agents.register(input));
    }

    getAgent(agentId: AgentId): AgentRecord {
        return this.#agents.get(agentId);
    }

    getAgentByAlias(alias: string, rootAgentId?: AgentId): AgentRecord {
        return this.#agents.getByAlias(alias, rootAgentId);
    }

    listAgents(options?: ListAgentsOptions): AgentPage {
        return this.#agents.list(options);
    }

    renameAgent(input: RenameAgentInput): AgentRecord {
        return this.#write(() => this.#agents.rename(input));
    }

    patchAgent(input: PatchAgentInput): AgentRecord {
        return this.#write(() => this.#agents.patch(input));
    }

    transitionAgent(input: TransitionAgentInput): AgentRecord {
        return this.#write(() => this.#agents.transition(input));
    }

    deleteAgent(agentId: AgentId, expectedRevision: number): void {
        this.#write(() => this.#agents.delete(agentId, expectedRevision));
    }

    acquireAgentLease(input: AgentLeaseInput): AgentRecord {
        return this.#write(() => this.#agents.acquireLease(input));
    }

    renewAgentLease(input: AgentLeaseInput): AgentRecord {
        return this.#write(() => this.#agents.renewLease(input));
    }

    releaseAgentLease(agentId: AgentId, owner: string): AgentRecord {
        return this.#write(() => this.#agents.releaseLease(agentId, owner));
    }

    enqueueMessage(input: EnqueueMessageInput): EnqueueResult {
        return this.#write(() => this.#mailbox.enqueue(input));
    }

    getMessage(messageId: MessageId): MailboxMessage {
        return this.#write(() => this.#mailbox.get(messageId));
    }

    listMessages(filter: MailboxFilter): MessagePage {
        return this.#write(() => this.#mailbox.list(filter));
    }

    listSentMessages(filter: OutboxFilter): MessagePage {
        return this.#write(() => this.#mailbox.listSent(filter));
    }

    requeueDeadLetterMessage(input: RequeueDeadLetterInput): MailboxMessage {
        return this.#write(() => this.#mailbox.requeueDeadLetter(input));
    }

    claimMessages(input: ClaimMessagesInput): readonly MailboxMessage[] {
        return this.#write(() => this.#mailbox.claim(input));
    }

    markMessageRead(input: MessageMutationInput): MailboxMessage {
        return this.#write(() => this.#mailbox.markRead(input));
    }

    acknowledgeMessage(input: MessageMutationInput): MailboxMessage {
        return this.#write(() => this.#mailbox.acknowledge(input));
    }

    renewMessageLease(input: RenewMessageLeaseInput): MailboxMessage {
        return this.#write(() => this.#mailbox.renewLease(input));
    }

    retryMessage(input: RetryMessageInput): MailboxMessage {
        return this.#write(() => this.#mailbox.retry(input));
    }

    deadLetterMessage(input: DeadLetterMessageInput): MailboxMessage {
        return this.#write(() => this.#mailbox.deadLetter(input));
    }

    runMailboxMaintenance(): MaintenanceResult {
        return this.#write(() => this.#mailbox.runMaintenance());
    }

    listDeadLetters(input: ListNamespaceMessagesInput): MessagePage {
        return this.#mailbox.listDeadLetters(input);
    }

    mailboxStats(rootAgentId: AgentId) {
        return this.#mailbox.stats(rootAgentId);
    }

    unresolvedRequiredMessages(agentId: AgentId, limit?: number): readonly MailboxMessage[] {
        return this.#write(() => this.#mailbox.unresolvedRequired(agentId, limit));
    }

    pruneMailbox(input: PruneMessagesInput): PruneMessagesResult {
        return this.#write(() => {
            this.#events.prune(input.retentionMs, input.limit);
            return this.#mailbox.prune(input);
        });
    }

    getCompletion(agentId: AgentId): CompletionOutboxRecord | undefined {
        return this.#completions.get(agentId);
    }

    declareCompletion(input: DeclareCompletionInput): CompletionOutboxRecord {
        return this.#write(() => this.#completions.declare(input));
    }

    /** Frozen declaration, mailbox envelope, and publication marker commit together. */
    publishCompletion(agentId: AgentId, runId: string, token: string): MailboxMessage {
        return this.#write(() => {
            const agent = this.#agents.get(agentId);
            const declaration = this.#completions.get(agentId);
            if (
                agent.runId !== runId ||
                declaration?.runId !== runId ||
                declaration.invocationToken !== token ||
                agent.parentAgentId === undefined
            ) {
                throw new ValidationError("Completion does not belong to the active assignment");
            }
            if (declaration.messageId !== undefined && declaration.state !== "invalidated") {
                return this.#mailbox.get(declaration.messageId);
            }
            if (declaration.state !== "declared")
                throw new ValidationError("Completion is not declared");
            const payload = declaration.payload as { status?: unknown };
            if (payload.status !== "succeeded" && payload.status !== "failed")
                throw new ValidationError("Invalid completion status");
            if (
                payload.status === "succeeded" &&
                this.#mailbox.unresolvedRequired(agent.id).length > 0
            ) {
                throw new ValidationError(
                    "Cannot publish completion with unresolved required mail",
                );
            }
            const delivery = this.#mailbox.enqueue({
                senderAgentId: agent.id,
                senderRunId: runId,
                recipientAgentId: agent.parentAgentId,
                kind: "result",
                content: canonicalJson(declaration.payload),
                metadata: {
                    action: "completion",
                    agentId,
                    runId,
                    status: payload.status,
                    completionToken: token,
                },
                idempotencyKey: `completion:${createHash("sha256").update(`${agentId}:${runId}:${token}`).digest("hex")}`,
            });
            this.#database.hit("completion.publish.after_enqueue", { agentId, runId });
            this.#completions.markEmitted(agentId, token, delivery.message.id);
            const status = payload.status === "succeeded" ? "completed" : "failed";
            if (agent.status !== status)
                this.#agents.transition({
                    agentId,
                    status,
                    expectedRevision: agent.revision,
                    patch: {},
                });
            this.#database.hit("completion.publish.before_commit", { agentId, runId });
            return delivery.message;
        });
    }

    markCompletionEmitted(
        agentId: AgentId,
        invocationToken: string,
        messageId: MessageId,
    ): CompletionOutboxRecord {
        return this.#write(() =>
            this.#completions.markEmitted(agentId, invocationToken, messageId),
        );
    }

    markCompletionParentApplied(agentId: AgentId, invocationToken: string): CompletionOutboxRecord {
        return this.#write(() => this.#completions.markParentApplied(agentId, invocationToken));
    }

    markCompletionAcknowledged(
        agentId: AgentId,
        invocationToken: string,
        messageId: MessageId,
    ): CompletionOutboxRecord {
        return this.#write(() =>
            this.#completions.markAcknowledged(agentId, invocationToken, messageId),
        );
    }

    invalidateCompletion(agentId: AgentId, invocationToken: string): CompletionOutboxRecord {
        return this.#write(() => this.#completions.invalidate(agentId, invocationToken));
    }

    listPendingCompletions(parentAgentId: AgentId): readonly CompletionOutboxRecord[] {
        return this.#completions.listPendingForParent(parentAgentId);
    }

    beginMailboxEffect(messageId: MessageId, effect: string): MailboxEffectRecord {
        return this.#write(() => this.#completions.beginEffect(messageId, effect));
    }

    advanceMailboxEffect(messageId: MessageId, state: MailboxEffectState): MailboxEffectRecord {
        return this.#write(() => this.#completions.advanceEffect(messageId, state));
    }

    createWorkflow(input: CreateWorkflowInput): WorkflowRecord {
        return this.#write(() => this.#workflows.create(input));
    }

    getWorkflow(workflowId: WorkflowId, rootAgentId: AgentId): WorkflowRecord {
        return this.#workflows.get(workflowId, rootAgentId);
    }

    listWorkflows(options: ListWorkflowsOptions): WorkflowPage {
        return this.#workflows.list(options);
    }

    transitionWorkflow(input: TransitionWorkflowInput): WorkflowRecord {
        return this.#write(() => this.#workflows.transition(input));
    }

    updateWorkflowNode(input: UpdateWorkflowNodeInput): WorkflowRecord {
        return this.#write(() => this.#workflows.updateNode(input));
    }
}
