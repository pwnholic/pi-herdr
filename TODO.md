# Verification and follow-up

Updated 2026-09-05. Implementation and verification are recorded separately: a mocked lifecycle
test is not proof that the live Herdr UI works.

## Implemented and regression-tested

- [x] Model-visible tool data includes IDs, receipt states, and pagination.
- [x] All 23 tools document purpose, parameter provenance/constraints, and named prompt guidelines.
      Nested workflow/task/artifact parameters are covered by a schema-documentation regression test.
- [x] Three mailbox lanes preserve ordering per recipient/lane; ordinary unacked mail cannot block
      control or completion. Pump preference rotates to avoid ordinary-mail starvation.
- [x] Completion payloads are frozen, with atomic mailbox publication/outbox marking/terminal status.
- [x] Required mail is checked at declaration and publication; new reasoning invalidates stale drafts.
- [x] Run identity survives stopped-process restart and changes when a finished assignment is reopened.
      Old sends, consumers, replies, leases, and workflow results are fenced.
- [x] Workflow cancellation persists before external stops, gates scheduling, cleans late spawns,
      and retries failed cleanup after engine replacement.
- [x] Runtime completion and mailbox protocol handling have separate modules.
- [x] Invalid transitions no longer silently succeed; deliberately ignored native observations have
      explicit journal entries.
- [x] Operational event history, scoped querying, incremental retention, and diagnostics are available.
- [x] Result-size and page-size configuration match storage limits; unsupported JSON values are rejected.
- [x] README is the primary documentation; the separate docs directory is removed from repo/package.
- [x] Existing namespace, idempotency, lease, retry, rename compensation, and retention regressions pass.

## Evidence

`bun run check` passes TypeScript, 122 Node tests, formatting, and linting (0 skipped tests).

| Area | Evidence | Boundary |
| --- | --- | --- |
| Mail ordering, fairness, stale runs, atomic publication, events | `test/storage/hardening.test.ts` | SQLite plus deterministic pump tests |
| Model-visible discover → request → read → reply → ack → receipt | `test/pi/runtime.test.ts` | Real store/runtime; mocked Pi injection |
| Tool guidance and parameter constraints | `test/pi/tool-contracts.test.ts` | Checks every registered tool and nested parameter |
| Output bounds and routing/pagination visibility | `test/pi/tool-output.test.ts` | Structured output contract tests |
| Cancel during spawn, failed stop retry, old workflow binding | `test/workflow/engine.test.ts` | Real store/engine; mocked native supervisor |
| Completion crash before/after commit | `test/e2e/completion-crash.test.ts` | Actual Node child killed with SIGKILL at three boundaries |
| Concurrent mailbox clients | `test/e2e/process-mailbox.test.ts` | Eight actual Node processes, one SQLite database |
| Pi extension startup | `test/e2e/pi-rpc.test.ts` | Actual Pi RPC process; no LLM request or Herdr UI interaction |

Dependency freshness was checked using `bun outdated`; versions and lockfile remain exact-pinned.
A future registry release requires another check, not a claim that today's versions stay latest.

## Remaining live acceptance: managed Herdr pane required

The current shell is not a managed Herdr pane. Do not fabricate `HERDR_ENV` or control an unrelated
focused workspace to complete these checks.

- [ ] Run parent → idle worker, parent → working worker, and worker → worker communication in actual
      Pi TUIs; verify message IDs, receipts, order, and no unintended duplicate injections.
- [ ] Press actual Escape during work, send a correction, and verify that the worker remains alive
      and continues without manual relaunch.
- [ ] Rename during queued traffic; check Herdr agent alias, pane/tab labels, Pi session name, and
      stable UUID routing.
- [ ] Verify native working/idle/blocked lifecycle labels with the installed Herdr state extension.
- [ ] Cancel while native startup is in flight and during an external stop failure; confirm owned-tab
      cleanup and no new dependent worker launches.
- [ ] Kill/restart actual Pi parent/worker processes around external result application,
      notification, and tab close; record durable state and visible-delivery counts.
- [ ] Verify two live coordinators sharing storage cannot control or consume each other's workers.
- [ ] Confirm all test-created Herdr tabs/processes are closed without touching unrelated resources.

Record Pi/Herdr versions, exact commands, database path, agent/run/message IDs, observed outcomes,
and cleanup evidence when this matrix is run. Keep these boxes unchecked until that evidence exists.

## Explicit limits, not completion claims

- Pi session persistence, SQLite, and Herdr are not one distributed transaction. Delivery remains
  at least once; arbitrary external effects need their own idempotency.
- Public-tool namespace checks do not sandbox untrusted code with direct filesystem/SQLite access.
- Event history is retained diagnostic data, not a complete event-sourced backup or unlimited log.
- The suite does not claim exhaustive crash-point/property-state coverage, sustained-load behavior,
  or certification of every third-party provider/model.
