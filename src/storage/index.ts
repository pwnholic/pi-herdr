import type { AgentPage, AgentRecord, RegisterAgentInput } from "../domain/agent.ts";
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

    private constructor(options: OpenStoreOptions) {
        this.#database = new StorageDatabase(options);
        this.#agents = new AgentRepository(this.#database);
        this.#mailbox = new MailboxRepository(this.#database);
        this.#completions = new CompletionRepository(this.#database);
        this.#workflows = new WorkflowRepository(this.#database);
    }

    static open(options: OpenStoreOptions): SqliteControlPlaneStore {
        return new SqliteControlPlaneStore(options);
    }

    close(): void {
        this.#database.close();
    }

    registerAgent(input: RegisterAgentInput): AgentRecord {
        return this.#agents.register(input);
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
        return this.#agents.rename(input);
    }

    patchAgent(input: PatchAgentInput): AgentRecord {
        return this.#agents.patch(input);
    }

    transitionAgent(input: TransitionAgentInput): AgentRecord {
        return this.#agents.transition(input);
    }

    deleteAgent(agentId: AgentId, expectedRevision: number): void {
        this.#agents.delete(agentId, expectedRevision);
    }

    acquireAgentLease(input: AgentLeaseInput): AgentRecord {
        return this.#agents.acquireLease(input);
    }

    renewAgentLease(input: AgentLeaseInput): AgentRecord {
        return this.#agents.renewLease(input);
    }

    releaseAgentLease(agentId: AgentId, owner: string): AgentRecord {
        return this.#agents.releaseLease(agentId, owner);
    }

    enqueueMessage(input: EnqueueMessageInput): EnqueueResult {
        return this.#mailbox.enqueue(input);
    }

    getMessage(messageId: MessageId): MailboxMessage {
        return this.#mailbox.get(messageId);
    }

    listMessages(filter: MailboxFilter): MessagePage {
        return this.#mailbox.list(filter);
    }

    listSentMessages(filter: OutboxFilter): MessagePage {
        return this.#mailbox.listSent(filter);
    }

    requeueDeadLetterMessage(input: RequeueDeadLetterInput): MailboxMessage {
        return this.#mailbox.requeueDeadLetter(input);
    }

    claimMessages(input: ClaimMessagesInput): readonly MailboxMessage[] {
        return this.#mailbox.claim(input);
    }

    markMessageRead(input: MessageMutationInput): MailboxMessage {
        return this.#mailbox.markRead(input);
    }

    acknowledgeMessage(input: MessageMutationInput): MailboxMessage {
        return this.#mailbox.acknowledge(input);
    }

    renewMessageLease(input: RenewMessageLeaseInput): MailboxMessage {
        return this.#mailbox.renewLease(input);
    }

    retryMessage(input: RetryMessageInput): MailboxMessage {
        return this.#mailbox.retry(input);
    }

    deadLetterMessage(input: DeadLetterMessageInput): MailboxMessage {
        return this.#mailbox.deadLetter(input);
    }

    runMailboxMaintenance(): MaintenanceResult {
        return this.#mailbox.runMaintenance();
    }

    listDeadLetters(input: ListNamespaceMessagesInput): MessagePage {
        return this.#mailbox.listDeadLetters(input);
    }

    mailboxStats(rootAgentId: AgentId) {
        return this.#mailbox.stats(rootAgentId);
    }

    unresolvedRequiredMessages(agentId: AgentId, limit?: number): readonly MailboxMessage[] {
        return this.#mailbox.unresolvedRequired(agentId, limit);
    }

    pruneMailbox(input: PruneMessagesInput): PruneMessagesResult {
        return this.#mailbox.prune(input);
    }

    getCompletion(agentId: AgentId): CompletionOutboxRecord | undefined {
        return this.#completions.get(agentId);
    }

    declareCompletion(input: DeclareCompletionInput): CompletionOutboxRecord {
        return this.#completions.declare(input);
    }

    markCompletionEmitted(
        agentId: AgentId,
        invocationToken: string,
        messageId: MessageId,
    ): CompletionOutboxRecord {
        return this.#completions.markEmitted(agentId, invocationToken, messageId);
    }

    markCompletionParentApplied(agentId: AgentId, invocationToken: string): CompletionOutboxRecord {
        return this.#completions.markParentApplied(agentId, invocationToken);
    }

    markCompletionAcknowledged(
        agentId: AgentId,
        invocationToken: string,
        messageId: MessageId,
    ): CompletionOutboxRecord {
        return this.#completions.markAcknowledged(agentId, invocationToken, messageId);
    }

    invalidateCompletion(agentId: AgentId, invocationToken: string): CompletionOutboxRecord {
        return this.#completions.invalidate(agentId, invocationToken);
    }

    listPendingCompletions(parentAgentId: AgentId): readonly CompletionOutboxRecord[] {
        return this.#completions.listPendingForParent(parentAgentId);
    }

    beginMailboxEffect(messageId: MessageId, effect: string): MailboxEffectRecord {
        return this.#completions.beginEffect(messageId, effect);
    }

    advanceMailboxEffect(messageId: MessageId, state: MailboxEffectState): MailboxEffectRecord {
        return this.#completions.advanceEffect(messageId, state);
    }

    createWorkflow(input: CreateWorkflowInput): WorkflowRecord {
        return this.#workflows.create(input);
    }

    getWorkflow(workflowId: WorkflowId): WorkflowRecord {
        return this.#workflows.get(workflowId);
    }

    listWorkflows(options?: ListWorkflowsOptions): WorkflowPage {
        return this.#workflows.list(options);
    }

    transitionWorkflow(input: TransitionWorkflowInput): WorkflowRecord {
        return this.#workflows.transition(input);
    }

    updateWorkflowNode(input: UpdateWorkflowNodeInput): WorkflowRecord {
        return this.#workflows.updateNode(input);
    }
}
