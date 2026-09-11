# pi-herdr

A durable multi-agent extension for [Pi](https://pi.dev), built for visible agents running inside
[Herdr](https://herdr.dev).

Each worker keeps its own interactive Pi session and Herdr tab. A shared SQLite control plane
tracks identities, assignments, messages, completion, and workflows. Workers can communicate
directly with one another; the parent model does not have to relay their messages.

## Capabilities

- Direct parent/worker and worker/worker mail, with discovery and sender-visible receipts.
- Durable corrections after Escape, without automatically killing or relaunching workers.
- Mutable aliases and display names backed by immutable agent IDs.
- Separate control, completion, and ordinary-message lanes, with ordering inside each lane.
- Frozen completion declarations and atomic result publication.
- Persistent DAG scheduling, cancellation intent, and cleanup of agents launched during cancellation.
- Run-scoped messages that reject traffic from superseded assignments.
- Queryable event history, mailbox health, dead letters, and database diagnostics.

These are local orchestration guarantees, not an OS security sandbox. Agents sharing the same
filesystem and database must be trusted. Public tools enforce coordinator namespaces and protocol
roles, but cannot protect against arbitrary code opening the database directly.

## Requirements

- Node.js 22.19.0 or newer.
- Bun 1.4.0 or newer for installation and development.
- Pi 0.85.0.
- Herdr with native agent commands; the adapter targets the 0.8.2 command contract.

Dependencies are exact-pinned in `package.json` and `bun.lock`. Verify registry freshness with
`bun outdated`; exact pins are reproducible, not a promise that releases will never advance.

Pi executes extensions under Node, so SQLite uses `better-sqlite3`. Bun is the package manager;
there is no Bun sidecar, external broker, or background database service.

## Install

From this repository:

```bash
bun install --frozen-lockfile
pi install .
```

Start Pi inside a managed Herdr pane for lifecycle operations. Do not manufacture `HERDR_ENV`
to bypass that requirement: Herdr must provide the actual workspace and pane context.

For an isolated development load:

```bash
pi --no-extensions --extension "$PWD/src/extension.ts"
```

Do not simultaneously load an installed copy and an explicit development copy: their tool names
conflict. The supervisor launches children with extension auto-discovery disabled and explicitly
loads this extension. If Herdr's `herdr-agent-state.ts` integration is installed in Pi's extension
directory, it is also passed to children to project their state into Herdr's UI.

Parent-side mailbox inspection works outside Herdr. Spawn, rename, interrupt, resume, and close
require a managed Herdr environment.

### Fresh database baseline

This rewrite intentionally has one schema baseline, not a chain of compatibility migrations.
Older development databases, including earlier variants of schema version 1, fail with
`MIGRATION_FAILED`. The current baseline is `pi-herdr-control-plane-v1-handoffs`;
the preceding `v1-runs` and `v1-executions` baselines are also incompatible.

Use a fresh `PI_HERDR_DB` path, or archive the old development database while all users of it are
stopped. The extension never deletes an existing database automatically. All workers launched by
one supervisor receive the same database path.

## Tools

| Available to | Tools                                                                          | Purpose                                                        |
| ------------ | ------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| Every agent  | `agent_directory`                                                              | Discover peers by immutable ID, alias, role, and state         |
| Every agent  | `agent_mail_send`, `agent_mail_list`, `agent_mail_read`, `agent_mail_ack`      | Send, inspect, process, and acknowledge inbox mail             |
| Every agent  | `agent_mail_sent`, `agent_mail_retry`                                          | Inspect delivery receipts and retry eligible dead letters      |
| Workers      | `agent_complete`                                                               | Declare an explicit succeeded/failed result                    |
| Parent       | `agent_spawn`, `agents_list`, `agent_steer`, `agent_interrupt`, `agent_resume` | Launch, discover, correct, interrupt, or resume workers        |
| Parent       | `agent_rename`, `agent_stop`                                                   | Rename a worker or terminate its owned surface                 |
| Parent       | `workflow_start`, `workflow_status`, `workflow_list`, `workflow_cancel`        | Manage persistent dependency graphs                            |
| Parent       | `agent_mail_dead_letters`, `agent_mail_status`                                 | Inspect namespace delivery failures and queue health           |
| Parent       | `agent_events`, `agent_diagnostics`                                            | Inspect durable event history and runtime/database integration |

Tool results put structured data in model-visible `content`, not only Pi's UI-only `details`.
Large results are explicitly abbreviated; use smaller pages and returned cursors. Mail reads accept
`offset` and `limit` and return `nextOffset` when more content remains. Offsets count JavaScript
string characters (UTF-16 code units); each read returns at most 8,192 of them.

### Direct communication

1. Discover the recipient with `agent_directory`.
2. Send to its immutable ID with `agent_mail_send`. Use a stable `idempotencyKey` for retries.
3. The recipient receives the mail through its Pi extension, reads it, and performs the requested work.
4. Replies use `kind: "response"` and the original `replyToMessageId`.
5. Acknowledge processed mail with `agent_mail_ack`; the sender checks `agent_mail_sent`.

A successful send reports a path such as `Interacted with /root/workflow_engine`, the durable
message ID, and whether delivery is live or deferred. Queued is not processed: acknowledgement is
the explicit receipt for completed handling.

## Communication contract

Mail moves through:

```text
queued → delivered → read → acked
   ↖ retry / expired lease
                  ↘ dead_letter
```

Delivery is **at least once**. A consumer owns a renewable lease; after process death, expired
leases can be reclaimed. Repeated sends with the same sender/run/key and identical intent resolve
to the same message. Reusing that key for different intent is rejected.

Ordering is FIFO within each recipient's lane:

- Control: authenticated ancestor corrections and rename notifications; injected as Pi steering.
- Completion: internal durable worker results.
- Ordinary: messages, requests, responses, and events; injected as follow-up messages.

An unacknowledged ordinary message cannot block a correction or completion. The pump rotates lane
preference so continuous control traffic does not monopolize ordinary delivery. Each lane remains
ordered across consumers, retries, and backoff. Queues, thread hops, message size, and per-poll
delivery bytes are bounded.

Public mail cannot impersonate internal control or completion traffic. Replies must match the
thread participants, request/response contract, and assignment generations.

### Interruption and assignments

Escape interrupts a turn, not the worker process. A live interrupted worker can receive
`agent_steer`; no manual relaunch is necessary for that correction.

An agent has an immutable `id` and a current `runId`. Restarting a stopped process preserves its
assignment. Reopening a completed or failed assignment creates a new run. Old-run messages become
dead letters, old consumers cannot claim new-run mail, and old results cannot complete the new
assignment. A finished worker with a published result must wait for parent acknowledgement before
being resumed.

Ordinary mail to stopped/orphaned workers is explicitly deferred. Control requires a live
recipient. Mail to completed/failed workers is rejected. Alias changes do not change either ID.

### Completion and recovery

A worker calls `agent_complete` with a status, summary, and optional details/artifact references.
Call it alone in its tool batch, after finishing mailbox replies and acknowledgements.
The validated payload is persisted before the tool returns. It is not rebuilt from transient final
assistant text.

After Pi emits `agent_settled`, one SQLite transaction publishes the frozen result, marks its
outbox emitted, and advances worker status. Success is refused while required mail remains
unresolved, including mail arriving after declaration. Aborting or beginning another reasoning
turn invalidates an unpublished declaration.
Settlement reported while Pi is busy or reports pending messages also invalidates the draft.
Public send/read/ack/retry operations are frozen while a completion draft is declared.
Managed workers reject a Pi session ID different from their existing registry binding.

Ordinary mail and steering instructions have a durable Pi handoff token bound to the recipient's
execution epoch and mailbox owner. Submission alone leaves mail `delivered`. Only the matching
custom message observed by this extension's `context` hook permits `read`, then explicit ack.
Polling maintains the lease without reinjecting the same handoff. A new handoff invalidates a
completion draft, and unobserved handoffs block declaration/publication, including optional mail.
Rename controls and parent-side result application remain direct protocol effects.

Context observation is not proof of provider receipt or model understanding: another extension
may still transform context afterward. If Pi drops a custom queue or asynchronously fails to
inject it, the handoff remains pending rather than becoming falsely read. Let queued turns run;
if no context observation can occur, restart that runtime, then allow mailbox lease recovery.
Replacement epochs get new handoff tokens; old tokens cannot confirm the replacement delivery.
Automatic recovery from uncertain injection and full provider-boundary fencing remain open.

Each managed parent or worker binds its store connection to a durable execution identity:
agent ID, run ID, Pi session ID, monotonic epoch, and unique process owner. A live lease prevents
a second process from binding the same assignment/session. Every store mutation checks ownership
inside its SQLite transaction, including mailbox reads that perform expiry maintenance. Once a
replacement acquires ownership, the old connection cannot write, renew, or release the new lease.

Runtime heartbeats renew the lease every third of `PI_HERDR_LEASE_DURATION_MS` (default: 60 seconds).
Clean shutdown releases ownership after draining runtime work. A crash requires waiting for lease
expiry before retrying startup; renewal failure stops background scheduling and rejects active
operations until restart. These are cooperative managed-process guards, not isolation from trusted
administrative stores, arbitrary SQLite writers, or already-dispatched external Pi/Herdr actions.

The parent journals result application before notifying Pi and acknowledging the message.
Completion messages do not inherit ordinary-mail TTL. A replacement execution invalidates an
unpublished draft and requires a new `agent_complete` declaration. Already-emitted results retain
their delivery identity, so the parent can resume handling without generating a different
completion payload.

SQLite, Pi session persistence, and Herdr do not share a transaction. Session-history replay
checks reduce duplicate injections, but this is not a universal exactly-once guarantee for
external effects. Operations triggered by received mail should be idempotent.

### Workflows

A workflow is a validated DAG. Ready nodes are durably reserved before launch using a
`(workflowId, nodeId, spawnKey, runId)` binding. Dependency results unlock successors, duplicate
ticks coalesce, and the scheduler respects its coordinator's concurrency bound.

Cancellation records intent before awaiting external stops. Scheduling rejects new work for that
workflow; a spawn that returns after cancellation triggers cleanup. Failed stops stay recoverable
and produce `workflow.cancel_retry` events. Replacement engines retry cleanup. Cancellation is
not a reusable workflow reset: create a new workflow for another execution.

## Architecture

```text
Pi tools / session events
          │
          ├── AgentSupervisor ───── Herdr lifecycle and owned surfaces
          ├── WorkflowEngine ───── DAG reservations and cancellation
          ├── CompletionCoordinator ── frozen result publication
          └── MailboxPump ──────── Message dispatcher ── recipient Pi session
                    │
                    ▼
              SQLite (WAL)
 agents/runs · mailbox/leases · completion/effects · workflows · event timeline
```

Responsibilities follow directory boundaries:

- `src/domain`: contracts, identifiers, validation, and state transitions.
- `src/storage`: SQLite repositories, atomic operations, retention, and the single schema baseline.
- `src/herdr`: native command arguments, deadlines, diagnostics, and verified surface capabilities.
- `src/orchestrator`: coordinate the durable registry with external process operations.
- `src/workflow`: reserve, schedule, reconcile, and cancel workflow nodes.
- `src/pi`: session lifecycle, completion, message dispatch, mailbox consumption, and tool output.

SQLite mutations use revisions and leases; native commands use argument arrays and bounded
timeouts. The supervisor closes only resources it owns and can verify. Ambiguous external state
is surfaced for recovery, not treated as a healthy process.

## Operations

Use `agent_diagnostics` for the active database/schema, SQLite integrity, extension paths,
managed-Herdr context, and queue health. It does not certify the live Herdr UI.

Use `agent_events` with `after`, `limit`, and optional `entityId`. Continue from `nextAfter`;
`hasMore` signals additional rows. Lifecycle and mailbox state events commit with their mutations.
Message bodies are omitted; runtime errors and cancellation failures are also recorded.

Event history and terminal ordinary mail are pruned incrementally using mailbox retention.
Idempotency tombstones outlive pruned ordinary mail. Completion records have separate retention
semantics and are not discarded by ordinary-mail pruning. The timeline is diagnostic history,
not a complete event-sourced database backup.

### Troubleshooting

| Symptom                              | Check                                                                                                 |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| Tool name conflicts on load          | Load either the installed package or one isolated development copy                                    |
| `MIGRATION_FAILED`                   | Select a fresh database or archive the superseded baseline                                            |
| Worker looks idle in Herdr           | Inspect lifecycle integration in `agent_diagnostics`; registry and native UI are separate projections |
| Send is queued but unprocessed       | Inspect recipient state, inbox lane head, leases, TTL, and sender receipts                            |
| Completion refuses success           | Read and acknowledge required mail before declaring the result again                                  |
| Workflow cancellation reports errors | Inspect `agent_events` and let reconciliation retry the owned-surface stop                            |

## Configuration

| Environment variable                |                                          Default | Meaning                           |
| ----------------------------------- | -----------------------------------------------: | --------------------------------- |
| `PI_HERDR_DB`                       | Pi session directory + `pi-herdr/control.sqlite` | Shared database                   |
| `PI_HERDR_MAX_AGENTS`               |                                              `8` | Non-terminal worker limit         |
| `PI_HERDR_MAX_MESSAGE_BYTES`        |                                          `65536` | Ordinary-mail content limit       |
| `PI_HERDR_MAX_RESULT_BYTES`         |                                         `262144` | Completion limit; at most 1 MiB   |
| `PI_HERDR_MAX_PAGE_SIZE`            |                                            `100` | Page size; at most 100            |
| `PI_HERDR_LAUNCH_TIMEOUT_MS`        |                                          `30000` | Pi readiness deadline             |
| `PI_HERDR_OPERATION_TIMEOUT_MS`     |                                          `15000` | Native operation deadline         |
| `PI_HERDR_LEASE_DURATION_MS`        |                                          `60000` | Lease duration                    |
| `PI_HERDR_MESSAGE_TTL_MS`           |                                      `604800000` | Ordinary-mail TTL                 |
| `PI_HERDR_COMPLETION_POLL_MS`       |                                            `500` | Inbox/workflow polling interval   |
| `PI_HERDR_MAX_DELIVERY_BYTES`       |                                         `524288` | Per-poll injection byte budget    |
| `PI_HERDR_MAILBOX_RETENTION_MS`     |                                     `2592000000` | Ordinary-mail and event retention |
| `PI_HERDR_IDEMPOTENCY_RETENTION_MS` |                                     `7776000000` | Replay tombstone retention        |

The supervisor supplies `PI_HERDR_AGENT_ID`, `PI_HERDR_PARENT_ID`, and `PI_HERDR_RUN_ID` to
workers. Do not handcraft those identities.

## Development and verification

```bash
bun install --frozen-lockfile
bun run check
bun run test:coverage
bun outdated
```

`bun run check` runs TypeScript, Node's test runner, formatting, and linting. Use `bun run test`,
not `bun test`: this extension's native SQLite dependency runs under Node.

The suite includes repository/runtime tests, a model-visible tool communication journey,
workflow cancellation races, concurrent SQLite clients, real Pi RPC extension loading, and
SIGKILL tests around completion commit boundaries. The RPC test uses `pi` from PATH or `PI_BIN`
and requires no model request.

Real managed-Herdr UI behavior still needs in-pane verification: actual Escape/steer interaction,
display-name propagation, lifecycle labels, and owned-tab cleanup. Passing mocked lifecycle tests
or an RPC startup test does not certify that UI matrix. [TODO.md](TODO.md) records the remaining
acceptance work.

API references: [Pi extensions](https://pi.dev/docs/latest/extensions),
[Pi SDK](https://pi.dev/docs/latest/sdk), [Pi RPC](https://pi.dev/docs/latest/rpc),
and [Herdr plugins](https://herdr.dev/docs/plugins/).
