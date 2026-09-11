# Pi Integration and Correctness Gaps

Updated 2026-09-11.

This document tracks correctness, lifecycle, concurrency, recovery, and security-boundary gaps between `pi-herdr` and the Pi runtime.

These items are not feature requests.

A gap belongs here only when it can affect:

- protocol correctness,
- delivery guarantees,
- completion correctness,
- run/session isolation,
- lifecycle safety,
- crash recovery,
- orchestration health,
- or security boundaries.

---

## Current Gap Register

| Priority | Gap                                                                                                                  | Severity               | Status                        |
| -------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------- | ----------------------------- |
| P0       | `agent_settled` is too close to being treated as a global quiescence barrier                                         | **CRITICAL candidate** | Partially hardened; handoff remains open |
| P0       | SQLite mailbox state and native Pi steering/follow-up queues need an end-to-end fenced handoff                       | **CRITICAL candidate** | Durable context gate implemented; provider boundary/uncertain injection open |
| P0       | Completion must freeze protocol mutations and invalidate drafts across model turns, not only agent runs             | **CRITICAL candidate** | Local guards and store ownership fencing implemented; Pi handoff open |
| P0       | Durable execution epoch and exclusive binding                                                                       | **HIGH**               | Implemented for managed store connections; real-process tests pass |
| P1       | Pi session replacement through `/new`, `/resume`, `/fork`, and `/clone` needs an explicit UI lifecycle policy         | **HIGH**               | Binding replacement rejected; command interception open |
| P1       | `/reload` teardown and rebind behavior is not yet a documented invariant                                             | **HIGH**               | Contract gap                  |
| P1       | Escape/abort semantics do not explicitly account for pending Pi-native queues                                        | **HIGH**               | Contract gap                  |
| P1       | `steeringMode` and `followUpMode` can change assumed delivery semantics                                              | **HIGH**               | Contract gap                  |
| P1       | Pi extension failures are fail-open while orchestration-critical failures should generally fail closed               | **HIGH**               | Architectural                 |
| P1       | Pi `0.85.0` baseline should be reconsidered because `0.85.1` fixes an SDK import regression                          | **HIGH**               | Confirmed                     |
| P2       | Session replay deduplication does not yet use the strongest available Pi-native durable primitives                   | **MEDIUM/HIGH**        | Improvement                   |
| P2       | Pi package/dependency behavior must be audited against Bun usage and exact dependency pins                           | **MEDIUM**             | Requires `package.json` audit |
| P2       | Shared filesystem and direct SQLite access are not a security-isolation boundary                                     | **HIGH / Security**    | Known limitation              |

---

## 2026-09-11 implementation checkpoint

Audit baseline: commit `d18c003`; project Pi SDK pin `0.85.0`, installed Pi CLI
`0.85.1`. Dependencies were restored with the existing frozen lockfile for a
reproducible baseline; no dependency upgrade is claimed. MCP generation
`2026-09-08T02:34:13Z` reported changed file metadata, so relevant implementation
and test sources were read directly after graph discovery.

Implemented in this checkpoint:

- `src/pi/runtime.ts`: refuse publication and invalidate the draft when settlement
  reports busy/pending Pi state; validate the callback's session ID.
- `src/extension.ts`: handle `turn_start`, not just `agent_start`, so later model
  turns inside one agent run invalidate a previous completion draft.
- Freeze public send/read/ack/retry operations while a child completion is declared;
  revalidate runtime ownership after asynchronous mailbox reads/acknowledgements.
- Reject startup into a different assigned session ID and fence active operations
  when either the registry session binding or live session manager changes.
- Correct `agent_complete` guidance: request it alone in a tool batch. Pi's agent
  loop executes subsequent tools even after one returns `terminate: true`, and
  terminates the batch's continuation only when every tool result opts in.
- Align spawn/resume test expectations with the existing supported `-ne`/`-e`
  arguments; the initial baseline was 120 passing tests and two flag-spelling failures.

Evidence and limits:

- Six new runtime regression cases failed before the patch and passed afterward.
  Additional tests cover extension event wiring and live session-manager changes.
- Initial guard-checkpoint `bun run check`: typecheck, all 130 tests (including Pi RPC startup and
  completion SIGKILL tests), formatting, and lint passed. This is not live managed
  Herdr UI acceptance or proof of a complete fenced handoff.
- A deterministic probe using Pi's actual agent loop and a fake model stream showed
  `complete -> send -> another model turn` with only one `agent_start` event.
- A probe of installed Pi `0.85.1`'s `sendCustomMessage` method showed a custom
  follow-up queued directly in the agent while `pendingMessageCount` remained zero.
  **`hasPendingMessages()` is therefore not a complete custom-message barrier.**
- SQLite-backed probes with mocked Pi reproduced early read/ack without consumption
  evidence and stale-runtime operations after session rebinding. Session-ID guards
  address rebinding, not the full durable handoff or same-session concurrent owners.
- Existing publication already uses an immediate SQLite transaction, rechecks
  required inbox mail, and has crash/retry tests. Preserve those guarantees.

### Durable execution ownership checkpoint

- Added `agent_executions` in the single `pi-herdr-control-plane-v1-executions`
  baseline: agent/run/session, monotonic epoch, unique owner, expiry. The preceding
  `v1-runs` database is rejected, not upgraded or deleted. Stop all old processes
  and select a fresh database; archive the old store if its data must be retained.
- A unique root-session index prevents concurrent first starts from bypassing
  ownership by creating separate coordinator identities for the same Pi session.
- Parent and worker runtimes acquire exclusive ownership, renew every third of the
  configured lease duration, and conditionally release after shutdown drains work.
  A crash retains exclusivity until expiry; a failed renewal makes runtime health
  sticky-failed until restart. No forced takeover of a live same-session lease.
- Bound-store mutations validate assignment/session/epoch/owner/expiry before and
  after work in one immediate SQLite transaction. This includes completion,
  workflow, registry, events, and mailbox reads with maintenance side effects.
  Release never unbinds the old connection or releases a replacement's lease.
- Acquiring a new execution invalidates unpublished completion drafts atomically.
  A replacement must reconsider and redeclare completion. Already-emitted results
  keep their idempotent delivery identity and parent recovery path.
- Storage tests exercise expiry, stale writes, conditional release, rollback at
  acquisition, rollback on mid-write expiry, and run/session replacement. Real
  processes exercise competing acquisition, stale send/publish/renew, SIGKILL,
  expiry recovery, and monotonically increasing epochs. Runtime tests cover
  duplicate startup, clean replacement, heartbeat renewal and sticky lease loss.
- Negative control: temporarily removing both transactional ownership checks made
  five of six execution storage tests fail; the checks were restored before the
  final verification. The root-session uniqueness case was added afterward.
- Final execution-checkpoint `bun run check`: typecheck, all 142 tests, formatting,
  and lint passed with no skipped tests or lint warnings. `git diff --check` passed.
  This includes real Pi RPC startup, not live managed Herdr UI acceptance.
- Scope: cooperative managed processes using the bound store facade. Unbound
  bootstrap/administrative stores and arbitrary SQLite access remain trusted.
  Pi queue consumption and already-dispatched external actions are not fenced by
  a SQLite epoch alone. Wall-clock changes may affect lease availability; epoch
  equality still rejects an old owner after takeover, even with its clock behind.

### Pi context-observation checkpoint (after pushed `af282ea`)

- Added a single-baseline `mailbox_pi_handoffs` ledger: message, recipient, execution
  epoch, random token, mailbox owner, submission time, and context-observation time.
  Current baseline is `pi-herdr-control-plane-v1-handoffs`; `v1-executions` is now
  rejected too. No existing user database was migrated or deleted.
- Dispatcher journals before injection. Queue submission is `pending`, not `read`.
  Pump retains/renews pending leases and reconciles observations without reinjection.
  Ordinary/steering delivery no longer treats session-history presence as consumption.
- The Pi `context` hook records only matching token/current-epoch observations with
  live recipient mailbox ownership. Tracked unobserved handoffs fence read/ack and
  completion in storage; beginning a new handoff invalidates an unpublished draft.
- Tests cover queued-but-unobserved mail, wrong tokens, expired mailbox ownership,
  replacement epochs, pending lease renewal, late optional mail, and preservation of
  observed handoff identity after injected failure. A real Pi agent loop with an
  offline model stream verifies follow-up queue ordering; its ExtensionAPI adapter
  is mocked. This is not full AgentSession/Herdr acceptance.
- Repeated pump shutdown now waits for the same in-flight dispatch before resource
  release; restoring the old early return reproduces the failing regression.
- Unobserved handoffs from an earlier epoch of the same run also block completion
  until recovered, rather than disappearing from the barrier during replacement.
- Final `bun run check`: all 148 tests, typecheck, formatting, and lint passed;
  `git diff --check` passed. No skipped tests. Dependencies were not upgraded.
- Exact dependency source was read alongside the official Pi extension docs:
  `context` runs before a model call, but later extensions can still transform it.
  The pinned `0.85.0` SDK barrel/direct session import also pulls an unavailable
  `@earendil-works/pi-server` dependency in this installation. The real agent-loop
  test avoids that import; package integration is not claimed fixed.

Remaining handoff work:

- Context observation is weaker than provider-request inclusion or processing.
  Another extension can strip/change a message after our hook; that boundary is open.
- Pi's void `sendMessage` adapter hides asynchronous injection errors. An unobserved
  handoff stays pending, blocks completion, and is not silently reinjected in the
  same execution. Queue loss needs explicit runtime restart and mailbox lease
  recovery today; automatic uncertainty resolution and health diagnostics remain open.
- Parent result notification still uses its existing effect journal/history replay;
  it is not covered by the ordinary/steering context gate.

Next implementation slice:

1. Extend the context gate to provider-boundary evidence and explicit uncertain
   injection recovery, including reload, crash, queue loss, and asynchronous failure.
2. Completion barrier incorporating that evidence and broader fail-closed runtime health.
3. Real Pi/Herdr acceptance for correction, session replacement, and reload.

These are partial guards, **not closure of P0**, and not plugin/capability inheritance.

---

# 1. Completion Quiescence

`agent_settled` must not be treated as proof that the entire worker execution environment is globally quiescent.

Completion publication should require a stronger barrier.

Conceptually:

```text
completion declaration frozen
AND
same agent identity
AND
same assignment/run
AND
same Pi session generation
AND
no newer reasoning generation
AND
no required unresolved mailbox traffic
AND
no Pi-native pending messages
AND
no delivery currently in flight
AND
no completion-sensitive protocol mutation in flight
AND
Pi session is genuinely idle
```

A settlement event should therefore act as one input to completion publication, not as the sole publication authority.

---

# 2. SQLite ↔ Pi Queue Handoff

`pi-herdr` and Pi maintain separate state machines.

`pi-herdr` has durable mailbox state:

```text
queued
→ delivered
→ read
→ acked
```

Pi separately owns:

```text
steering queue
follow-up queue
active reasoning state
```

Therefore:

```text
SQLite delivered
```

must not automatically mean:

```text
Pi consumed
```

Introduce an observable delivery handoff.

A conceptual model is:

```text
queued
  ↓
leased
  ↓
dispatching
  ↓
accepted_by_pi
  ↓
consumed_by_pi
  ↓
read
  ↓
acked
```

Exact state names are implementation-specific.

The required invariant is that completion cannot mistake a Pi-pending message for fully processed traffic.

---

# 3. Parallel Protocol Tool Execution

Pi can execute tool calls concurrently.

Therefore protocol operations such as:

```text
agent_mail_send
agent_mail_ack
agent_mail_retry
agent_complete
workflow mutation
```

must not independently observe mutable run state without fencing.

Dangerous example:

```text
agent_mail_send ──────────────┐
                              │
                  agent_complete
                              │
              observes no pending mail
                              │
                    freezes success
                              │
mail mutation commits ────────┘
```

Introduce either:

- run-scoped protocol serialization,
- transactional protocol revisions,
- explicit mutation fencing,
- or another mechanism with equivalent guarantees.

`agent_complete` must never observe false quiescence while completion-relevant mutations remain in flight.

---

# 4. Execution Identity

Managed store ownership is implemented in the execution checkpoint above. The
remaining identity work concerns delivery attempts, Pi consumption evidence, and
explicit session-command lifecycle policy; the conceptual model below is not a
claim that every field is already persisted.

`agentId + runId` alone may be insufficient when the underlying Pi session can be replaced.

The execution identity should conceptually include:

```text
AgentExecutionIdentity
├── agentId
├── parentId
├── assignmentId
├── runId
├── piSessionId
├── sessionEpoch
└── protocolRevision
```

The exact schema may differ.

The important property is that stale state from an old Pi session cannot mutate or complete a newer execution generation.

---

# 5. Pi Session Replacement

Explicit policy is required for:

```text
/new
/resume
/fork
/clone
```

For managed workers, choose one of two approaches.

## Strict Mode

Disallow session replacement operations inside managed workers.

This is the simplest model to prove correct.

## Supported Replacement

If replacement is allowed:

```text
old session
    ↓
fence old execution
    ↓
detach runtime integration
    ↓
create/bind new session epoch
    ↓
restore required subscriptions
    ↓
reconcile pending protocol state
    ↓
resume
```

The transition must never be implicit.

---

# 6. Extension Reload

`/reload` must be treated as a real lifecycle transition.

Long-lived components include:

```text
MailboxPump
CompletionCoordinator
WorkflowEngine
AgentSupervisor
SQLite handles
timers
listeners
subscriptions
```

Teardown must be idempotent.

Rebinding must not create:

- duplicate consumers,
- duplicate pumps,
- stale callbacks,
- multiple workflow engines claiming the same work,
- duplicate completion publication.

Required acceptance cases include:

```text
reload while idle
reload while mail pending
reload during dispatch
reload after completion declaration
reload during workflow execution
reload while leases exist
```

---

# 7. Interrupt and Pending Queue Semantics

Escape interrupts the current reasoning turn, but queued Pi messages are a separate concern.

A correction protocol must define what happens to previously queued steering/follow-up traffic.

Potential stale sequence:

```text
old steering A
old follow-up B

Escape

new correction C

C processed
A processed afterwards
B processed afterwards
```

A safe interrupt protocol should explicitly determine whether pending traffic is:

- preserved,
- invalidated,
- revalidated,
- reordered,
- or selectively replayed.

Traffic from a superseded execution generation must never become valid merely because it remains in Pi's queue.

---

# 8. Queue Configuration Invariants

Runtime behavior must not silently change because a user's Pi configuration changes:

```text
steeringMode
followUpMode
```

Managed workers should either:

- enforce required settings,
- assert compatible settings at startup,
- or make the orchestration protocol independent of these options.

Incompatible configuration should fail visibly.

---

# 9. Fail-Closed Orchestration Health

A coordination-critical extension failure must not leave a worker behaving as though its control plane is healthy.

Introduce explicit health state.

Example:

```text
healthy
   ↓
degraded
   ↓
unsafe_for_completion
```

Critical faults may include:

- mailbox pump failure,
- database invariant violation,
- lost session binding,
- unrecoverable lifecycle mismatch,
- completion coordinator failure,
- corrupted protocol state.

While unsafe:

```text
successful completion → rejected
unsafe protocol mutation → rejected or restricted
parent → notified
diagnostics → persisted
```

Recovery should also be explicit and observable.

---

# 10. Durable Delivery/Replaying Evidence

Replay checks should rely on durable machine identities where possible rather than message-text heuristics.

Useful delivery identity:

```text
messageId
runId
sessionEpoch
deliveryGeneration
```

The same identity should be correlatable across:

```text
SQLite state
Pi session history
runtime delivery
parent receipt
```

This does not produce universal exactly-once external effects.

It does substantially strengthen duplicate-injection detection and crash recovery.

---

# 11. Dependency and Package Contract

Audit `package.json` and installation behavior against Pi's package contract.

Verify especially:

- Pi core packages are not incorrectly bundled,
- host Pi version and extension compatibility are represented correctly,
- runtime dependencies are installed through the expected mechanism,
- `better-sqlite3` remains compatible with Node execution,
- exact pins do not accidentally bind runtime code to an incompatible host copy.

Do not classify this as resolved until the package manifest has been audited.

---

# 12. Security Isolation Boundary

Current public-tool authorization is a protocol boundary, not a hostile-code isolation boundary.

A worker that can directly access:

```text
filesystem
control.sqlite
process environment
```

may bypass public protocol tooling.

For trusted cooperative workers this may be acceptable.

For adversarial or untrusted workers, stronger architecture is required:

```text
Worker
   │
authenticated IPC/API
   ▼
Control-plane broker
   │
   ▼
SQLite
```

Workers should then lack direct write access to the control-plane database.

Optional stronger isolation includes:

- container per worker,
- VM/micro-VM,
- filesystem namespaces,
- restricted process permissions,
- network policy,
- capability-scoped credentials.

---

# Resolution Priority

## P0 — Correctness

1. Completion/quiescence barrier.
2. SQLite ↔ Pi queue handoff.
3. Parallel protocol-tool fencing.

## P1 — Lifecycle

4. Session generation identity.
5. Session replacement policy.
6. Reload teardown/rebind.
7. Interrupt/queue handling.
8. Queue-setting invariants.
9. Fail-closed health.
10. Pi baseline correction.

## P2 — Hardening

11. Durable replay evidence.
12. Dependency/package audit.
13. Stronger security boundary.

---

# Exit Criteria

This document should be considered resolved only when each gap has:

```text
defined invariant
        +
implementation
        +
regression test
        +
crash/recovery test where applicable
        +
real Pi acceptance where applicable
```

A README statement alone does not close a gap.
