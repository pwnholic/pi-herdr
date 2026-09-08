# Pi Integration and Correctness Gaps

Updated 2026-09-08.

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
| P0       | `agent_settled` is too close to being treated as a global quiescence barrier                                         | **CRITICAL candidate** | Architectural                 |
| P0       | SQLite mailbox state and native Pi steering/follow-up queues lack an explicit fenced handoff                         | **CRITICAL candidate** | Architectural                 |
| P0       | `agent_complete` may race with other protocol tools under parallel tool execution                                    | **CRITICAL candidate** | Requires source audit         |
| P1       | Pi session replacement through `/new`, `/resume`, `/fork`, and `/clone` is not represented in the identity/run model | **HIGH**               | Contract gap                  |
| P1       | `/reload` teardown and rebind behavior is not yet a documented invariant                                             | **HIGH**               | Contract gap                  |
| P1       | Escape/abort semantics do not explicitly account for pending Pi-native queues                                        | **HIGH**               | Contract gap                  |
| P1       | `steeringMode` and `followUpMode` can change assumed delivery semantics                                              | **HIGH**               | Contract gap                  |
| P1       | Pi extension failures are fail-open while orchestration-critical failures should generally fail closed               | **HIGH**               | Architectural                 |
| P1       | Pi `0.85.0` baseline should be reconsidered because `0.85.1` fixes an SDK import regression                          | **HIGH**               | Confirmed                     |
| P2       | Session replay deduplication does not yet use the strongest available Pi-native durable primitives                   | **MEDIUM/HIGH**        | Improvement                   |
| P2       | Pi package/dependency behavior must be audited against Bun usage and exact dependency pins                           | **MEDIUM**             | Requires `package.json` audit |
| P2       | Shared filesystem and direct SQLite access are not a security-isolation boundary                                     | **HIGH / Security**    | Known limitation              |

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
