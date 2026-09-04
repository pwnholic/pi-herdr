# Pi Herdr Communication Hardening

Audit scope: parent-to-child, child-to-parent, and child-to-child communication.

Baseline: `813a1f7` (`dev`), audited 2026-09-05. The current mailbox is durable and
at-least-once. It already has SQLite transactions, WAL, foreign keys, immutable agent IDs,
optimistic revisions, lease ownership, retries, acknowledgements, TTL, dead-letter state, and
direct routing without a parent-model relay. The work below covers the remaining correctness,
authorization, recovery, and operability gaps.

Implementation status (2026-09-05): COMM-001 through COMM-018 and COMM-020 are implemented and
covered by deterministic tests. COMM-019's real Pi RPC and multi-process SQLite portions pass;
the final managed-Herdr UI certification remains unchecked because this shell is not running with
`HERDR_ENV=1`, and Herdr's own safety contract forbids controlling a focused session from outside
a managed pane.

## P0 — Correctness and data-loss risks

### [x] COMM-001 Make tool-level idempotency stable across time

**Observed:** `AgentSupervisor.send()` and child `sendMail()` calculate a new absolute
`expiresAt` on every call. `MailboxRepository.enqueue()` includes that timestamp in the intent
hash. Repeating the same logical send with the same idempotency key a few milliseconds later is
therefore rejected as a different request instead of being deduplicated.

**Reproduced:** two identical supervisor sends with the same key returned
`Idempotency key was already used for a different request`.

**Work:**

- Separate caller-supplied intent fields from server-derived timestamps.
- Hash a stable TTL policy or exclude a generated absolute expiry from the request hash.
- Preserve strict conflict detection when the recipient, content, kind, thread, or explicit
  delivery policy differs.

**Acceptance:**

- An identical retry after time advances returns the original message with `deduplicated: true`.
- Reusing a key for different content, recipient, kind, or thread still fails.
- Concurrent identical sends from separate processes create exactly one mailbox row.

### [x] COMM-002 Fix expired batch leases, duplicate injection, and failure reordering

**Observed:** the pump claims an entire batch and then dispatches sequentially. Leases for later
messages start before their delivery. A slow first dispatch can expire every claimed lease. The
payload is injected before the lease-protected `markRead`, so messages are requeued and injected
again. A failed first message can also be backed off while a later message overtakes it.

**Reproduced:** two messages produced delivery order `one, two, one, two` after the clock advanced
beyond the batch lease.

**Work:**

- Claim one message at a time, or renew the current/batch leases before every external dispatch.
- Define ordering explicitly: strict recipient FIFO, per-thread FIFO, or unordered across threads.
- Do not claim a later message when an earlier message in the same ordering domain is retrying.
- Keep at-least-once semantics, but make duplicate windows explicit and bounded.

**Acceptance:**

- A dispatch longer than `leaseMs` does not cause a second injection while its consumer lives.
- A retrying message is not overtaken within its documented ordering domain.
- Two concurrent pumps never inject the same leased revision concurrently.
- Add deterministic fake-clock tests for slow dispatch, lease expiry, retry, and process takeover.

### [x] COMM-003 Persist completion declaration before `agent_complete` returns

**Observed:** `#pendingCompletion` exists only in process memory. A crash, extension reload, or Pi
shutdown after `agent_complete` returns but before `agent_settled` loses the declaration and may
leave the parent or workflow waiting forever.

**Work:**

- Add a durable completion outbox/state machine keyed by agent ID and tool invocation token.
- Persist `declared -> emitted -> parent_applied -> acknowledged` transitions transactionally.
- Restore a pending declaration on child session restart and emit it after a valid settled event.
- Store the validated completion payload independently of the transient Pi callback state.

**Acceptance:**

- Kill the child after tool success but before `agent_settled`; restart emits exactly one logical
  completion.
- Replaying `agent_settled` or restarting either side is idempotent.
- A completed workflow cannot remain permanently `running` solely because of this crash window.

### [x] COMM-004 Make parent completion handling duplicate-safe

**Observed:** workflow mutation, agent transition, tab finalization, parent `sendMessage`, and
mailbox acknowledgement are not one transaction. A crash between those effects and the final ack
can replay the result and duplicate the parent notification.

**Work:**

- Add a durable parent inbox effect ledger keyed by message ID.
- Split durable result application from transient UI/LLM notification.
- Make finalization and notification resumable, with each phase independently idempotent.
- Never close the only recoverable child surface before the durable result application is known to
  be complete.

**Acceptance:**

- Fault injection after every phase converges to one workflow result and one logical parent event.
- Replayed completion messages do not duplicate notifications or regress terminal state.
- Both success and failure completion paths have equivalent recovery guarantees.

### [x] COMM-005 Add coordinator ownership and communication authorization

**Observed:** aliases and lookups are global within one database. `agents_list` and supervisor
resolution are not restricted to a coordinator subtree. A parent sharing the database can steer,
rename, stop, or message another coordinator's child. Peers can inject arbitrary `control` or
ordinary content into each other's LLM context without an allow-list.

**Work:**

- Persist a root coordinator/namespace ID on every agent and message.
- Scope list and lifecycle-control operations to the caller's owned subtree.
- Define policy separately for parent control, peer messages, peer requests, and cross-workflow
  communication.
- Reject peer `control` messages unless the recipient granted that capability.
- Preserve immutable sender provenance in every prompt-visible delivery.

**Acceptance:**

- Parent A cannot stop, rename, resume, or steer Parent B's descendants.
- Same-root child-to-child mail works when allowed and fails clearly when denied.
- A child cannot impersonate its parent or another child.
- Authorization is enforced in domain/storage code, not only hidden by tool schemas.

### [x] COMM-006 Reconcile completion expiry and dead letters

**Observed:** a completion result uses the normal message TTL. If the parent is offline past that
TTL, the result can dead-letter while the child is already marked completed; a bound workflow can
remain running with no recovery source.

**Work:**

- Keep terminal completion payloads in durable agent/workflow state, not only mailbox rows.
- Reconcile completed children with unapplied results during parent startup.
- Give terminal results an explicit retention/ack policy distinct from ordinary chat mail.
- Surface an actionable parent error when reconciliation cannot recover a result.

**Acceptance:**

- Parent restart after normal message TTL still recovers an unapplied child completion.
- Dead-lettering a result cannot silently strand a workflow node.
- Recovery is idempotent across repeated parent restarts.

## P1 — Communication semantics and operability

### [x] COMM-007 Provide delivery receipts and an outbox view

**Observed:** senders only receive `queued`. They cannot query whether their message was delivered,
read, acknowledged, expired, or dead-lettered because mailbox listing is inbox-only.

**Work:**

- Add sender-scoped outbox/status tools and message-state subscriptions or receipt events.
- Include failure/dead-letter reason and timestamps.
- Optionally provide `send-and-wait` with timeout/cancellation without blocking the mailbox pump.

**Acceptance:** sender can distinguish queued, accepted, processed, expired, and permanently failed.

### [x] COMM-008 Use message-kind-aware Pi delivery instead of steering everything

**Observed:** every ordinary message, request, response, event, and control message is injected with
`deliverAs: "steer"`. Informational peer mail can therefore alter the active turn like a correction.
Pi supports different steering/follow-up delivery semantics.

**Work:**

- Reserve `steer` for authorized corrective control.
- Default ordinary messages/responses/events to a documented follow-up or idle-gated policy.
- Allow a validated delivery policy where appropriate.
- Batch compatible bursts so one mailbox poll does not flood the Pi steering queue.

**Acceptance:** informational mail does not unexpectedly redirect active work; parent correction
still reaches the next model step promptly. See the official Pi extension message-delivery API.

### [x] COMM-009 Make offline and terminal-recipient behavior explicit

**Observed:** sending to stopped, completed, failed, or orphaned agents can return `queued` even
though no pump is available. `agent_steer` does not enforce its documented live-recipient contract.

**Work:**

- Validate recipient state for control messages.
- Define whether normal mail is rejected, deferred until resume, or wakes a stopped agent.
- Return the chosen delivery contract and recipient state to the sender.
- Prevent stale corrections from surprising a later unrelated resumed assignment.

**Acceptance:** control to a terminal recipient fails clearly; deferred mail has an explicit resume
and expiry policy.

### [x] COMM-010 Enforce thread participants and request/response correlation

**Observed:** `replyToMessageId` copies the referenced thread but does not verify that the sender and
recipient are participants. There is no request timeout, response waiter, or enforced
`request -> response` relationship.

**Work:**

- Persist thread participants and optional conversation purpose.
- Validate reply authorization and response kind.
- Add thread-scoped inbox/outbox queries and optional request correlation/timeouts.

**Acceptance:** unrelated agents cannot attach messages to a private thread; responses can be
matched reliably to requests.

### [x] COMM-011 Prevent completion with unresolved inbox work

**Observed:** a child can call `agent_complete` while messages remain queued, delivered, or read but
unacknowledged. Closing the child then leaves work behind and can cause stale redelivery on resume.

**Work:**

- Before terminal completion, check unresolved required/control mail.
- Define whether optional informational mail may be ignored or dead-lettered explicitly.
- Include unresolved message IDs in a validation error or completion summary.

**Acceptance:** required instructions cannot be silently abandoned by a successful completion.

### [x] COMM-012 Add child-visible, scoped agent discovery

**Observed:** direct child-to-child routing works only when the sender already knows a recipient UUID
or current alias. Children do not have a scoped directory/list tool, and aliases become stale after
rename.

**Work:**

- Add a read-only directory of authorized peers with immutable IDs, current aliases, roles, and
  availability.
- Prefer immutable IDs in generated prompts and workflow metadata.
- Consider bounded alias tombstones or an explicit renamed-agent error.

**Acceptance:** an authorized child can discover and message a peer without parent-model relay.

### [x] COMM-013 Add quotas, loop protection, and context backpressure

**Observed:** there is no per-sender queue quota, thread hop limit, burst budget, or ping-pong loop
detection. Up to a full page of individually large messages can be injected into Pi context in one
poll cycle.

**Work:**

- Add per-agent/per-thread queue limits and rate limits.
- Add maximum conversation hops or repeated-payload loop detection.
- Enforce aggregate batch byte/token budgets and coalesce compatible messages.
- Prioritize completion/control traffic without starving normal mail.

**Acceptance:** a noisy or compromised child cannot exhaust the database, Pi context, or model turns
of its peers.

### [x] COMM-014 Improve dead-letter and pump-failure observability

**Observed:** pump errors are primarily written through `onError`; senders receive no failure event,
and there is no parent-level dead-letter dashboard or retry command.

**Work:**

- Add dead-letter list/inspect/retry tools with ownership checks.
- Emit durable operational events to the owning coordinator.
- Track queue depth, oldest age, retries, lease takeovers, and delivery latency.

**Acceptance:** operators can identify and recover a failed message without opening SQLite manually.

### [x] COMM-015 Make `agent_mail_read` claim the requested message safely

**Observed:** `readMail(id)` polls one generic batch, then returns the requested row regardless of its
state. If the requested message lies beyond the batch limit, it may still be queued and unleased,
so the caller sees content but cannot acknowledge it and later receives another prompt injection.

**Work:** add a recipient-authorized claim/read-by-ID operation or reject rows that were not accepted
by the current pump owner.

**Acceptance:** a successful read-by-ID always returns an actively owned `read` message or an
already acknowledged message; it never exposes a queued payload as processed.

### [x] COMM-016 Separate reserved protocol messages from user-selectable kinds

**Observed:** the public send tool allows `result`, but parent dispatch treats every result-kind
message as a completion protocol record requiring private metadata. A normal result sent by a child
therefore retries and dead-letters instead of behaving like ordinary mail.

**Work:** reserve internal completion/control envelopes at the schema level, or expose a separate
validated user-result kind that cannot enter lifecycle handling.

**Acceptance:** user-generated mail cannot accidentally enter or poison the completion protocol.

### [x] COMM-017 Make rename notification failure transactional

**Observed:** durable registry rename commits before the child notification is enqueued. If enqueue
then fails, the catch path rolls Herdr back but does not roll the registry back, leaving external and
durable aliases inconsistent.

**Work:** use an outbox transaction for the child notification and distinguish registry-commit
failure from post-commit notification failure.

**Acceptance:** injected enqueue failures converge to one alias across registry, Herdr, pane/tab,
and Pi display name.

## P2 — Retention, testing, and long-run resilience

### [x] COMM-018 Add mailbox retention and idempotency tombstones

**Observed:** acknowledged and dead-letter rows are never pruned, and idempotency keys effectively
live forever. Long-running projects will grow without bound.

**Work:** add configurable retention, safe pruning, compact idempotency tombstones, incremental
cleanup, and database-size metrics.

**Acceptance:** pruning preserves active threads/references and does not permit unsafe replay of a
recent idempotency key.

### [ ] COMM-019 Add process-level Pi/Herdr communication E2E tests

Current tests cover repository behavior and mocked Pi injection, but not the complete multi-process
path.

Add an automated matrix covering:

- parent -> idle child, parent -> working child, and child -> child;
- simultaneous cross-send and burst delivery;
- Escape followed by correction;
- rename during queued traffic;
- child/parent kill at every completion phase;
- SQLite lock/busy timeout and abrupt process death;
- expired leases, TTL, dead letters, and restart recovery;
- multiple coordinators sharing one session directory;
- actual Pi steering modes and Herdr lifecycle status transitions.

Every test must assert durable database state, Pi-visible delivery count/order, Herdr process state,
and cleanup of tabs/processes.

### [x] COMM-020 Add a deterministic fault-injection harness

Provide failpoints around enqueue, claim, external injection, mark-read, ack, completion apply,
notification, and tab close. Run state-machine/property tests over retries, crashes, and concurrent
consumers so recovery invariants are tested instead of inferred.

## Proposed implementation order

1. COMM-001 and COMM-002: restore basic send/retry correctness.
2. COMM-003, COMM-004, and COMM-006: make completion genuinely durable end-to-end.
3. COMM-005: establish ownership/capability boundaries before expanding peer discovery.
4. COMM-008, COMM-009, COMM-010, COMM-011, COMM-015, COMM-016, and COMM-017: tighten semantics.
5. COMM-007, COMM-012, COMM-013, and COMM-014: improve usability and operations.
6. COMM-018, COMM-019, and COMM-020: retention and systematic resilience verification.
