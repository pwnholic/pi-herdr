# Pi Herdr Architecture

## Objective

Pi Herdr is a durable local control plane for multiple visible Pi agents running in Herdr. Herdr
owns terminal/process surfaces, Pi owns conversation sessions, and SQLite owns orchestration state.
A process restart must not erase agent identity, queued messages, workflow progress, or completion
events.

## Invariants

1. Agent IDs are immutable. Human-readable aliases are mutable and never become durable identity.
2. SQLite is the source of truth for the registry, mailbox, leases, and workflow DAGs.
3. Herdr agent, workspace, tab, and pane identifiers are verified external projections.
4. Mail writes and idempotency records commit atomically.
5. Delivery is at-least-once. Consumers acknowledge only after processing, and handlers use stable
   idempotency keys where external effects are possible.
6. Interruption, steering, process termination, and session relaunch are separate operations.
7. A child completes only after `agent_complete` followed by Pi's `agent_settled`; `agent_end` alone
   and aborted settled turns are never completion.
8. External commands use argument arrays, bounded output, cancellation, deadlines, structured
   errors, and recovery checks.
9. The supervisor closes only Herdr resources represented by its owned capability objects.

## Components

```text
Pi parent extension
  ├── AgentSupervisor ── native Herdr lifecycle and identity projection
  ├── WorkflowEngine  ── persistent DAG scheduling and reconciliation
  └── MailboxPump     ── durable parent inbox and completion handling
                 │
                 ▼
          SQLite control plane (WAL)
      registry · leases · mailbox · workflows
                 ▲
       ┌─────────┼─────────┐
       │         │         │
   Pi child  Pi child  Pi child
   mail pump mail pump mail pump
       │         │         │
   Herdr tab Herdr tab Herdr tab
```

`src/herdr` owns native command contracts, `src/storage` owns transactions and migrations,
`src/orchestrator` coordinates durable state with external surfaces, `src/workflow` schedules DAGs,
and `src/pi` binds those services to extension events and tools.

## Control operations

- `spawn`: reserve identity, create a no-focus Herdr tab, start Pi, persist the verified surface,
  and submit the assignment. Failures compensate owned resources and persist terminal state.
- `send`: atomically enqueue mail. Direct child-to-child routing needs no parent-model relay.
- `steer`: enqueue one durable control message. The recipient pump injects it once with Pi
  `deliverAs: "steer"`; no duplicate terminal-input path is used.
- `interrupt`: send native Esc to the current Herdr agent. The process and Pi session stay alive.
- `rename`: rename Herdr agent/pane/tab projections, commit the mutable registry alias, then notify
  the child so its Pi session display name follows. External rollback is attempted on commit error.
- `resume`: a live interrupted child receives durable steering without restart. A terminal child is
  relaunched only after Pi JSONL session identity and cwd validation.
- `complete`: after explicit settled completion, the parent advances a bound workflow, finalizes
  the owned tab, notifies itself, and acknowledges the durable result.

## Mailbox lifecycle

Messages move through `queued → delivered → read → acked`, with TTL and terminal
`dead_letter` handling. Claims are revision-checked and owner-leased. Read-but-unacknowledged mail
gets a heartbeat; if its process dies, the lease expires and maintenance requeues or dead-letters
it. FIFO pagination uses a durable sequence rather than timestamps.

## Workflow recovery

Workflow nodes are validated as a DAG and reserved transactionally before agent launch. A stable
hash-derived Herdr alias and metadata binding `(workflowId, nodeId, spawnKey)` let a restarted
coordinator reconcile a running reservation without duplicate spawn. Concurrency is globally
bounded and duplicate ticks coalesce.

## Runtime boundary

Pi executes extensions in Node. `better-sqlite3` therefore provides the embedded synchronous
transaction boundary. Bun remains the exact-pinned package manager and developer runtime;
`bun:sqlite` is intentionally not hidden behind a sidecar process.

