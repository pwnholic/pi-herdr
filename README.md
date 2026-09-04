# pi-herdr

Durable multi-agent orchestration for [Pi](https://pi.dev) inside
[Herdr](https://herdr.dev). Each child remains a full, visible Pi TUI in its own native Herdr tab,
while agent identity, mailbox delivery, workflow state, leases, and recovery metadata live in
SQLite.

This is a greenfield rewrite in the repository root. The original `pi-herdr-agents` project was
used only as a behavioral reference and is not imported at runtime.

## What this fixes

- Direct child-to-child mail without routing through the parent model.
- Durable at-least-once delivery with idempotency keys, acknowledgements, retries, TTL, and a
  dead-letter state.
- Corrective steering after Escape without killing or manually resuming the child process.
- Mutable Herdr agent aliases with coordinated agent, pane, tab, registry, and Pi display names.
- Restart recovery using immutable agent IDs and verified Herdr workspace/tab/pane capabilities.
- Explicit completion: `agent_end` is never treated as final, and `agent_settled` completes work
  only after the child calls `agent_complete`.
- Persistent DAG workflows with bounded concurrency, dependency scheduling, cancellation, and
  crash-safe spawn reservations.

## Runtime model

```text
Pi parent extension
  ├── AgentSupervisor ── native Herdr lifecycle/rename/interrupt
  ├── WorkflowEngine  ── durable DAG scheduling
  └── MailboxPump     ── parent inbox/results
                │
                ▼
        SQLite control plane (WAL)
      registry · leases · mail · DAGs
                ▲
       ┌────────┼────────┐
       │        │        │
   Pi child  Pi child  Pi child
   mail pump mail pump mail pump
       │        │        │
   Herdr tab Herdr tab Herdr tab
```

Mailbox payloads have exactly one live-delivery path: the recipient extension injects them through
Pi using `deliverAs: "steer"`. Herdr controls the terminal/process lifecycle, so a correction is not
duplicated through terminal input.

## Requirements

- Node.js `>=22.19.0` (Pi itself runs under Node)
- Bun `1.4.0` or newer for deterministic package installation
- Pi `0.84.4`
- Herdr `0.8.2`

All npm dependencies are exact-pinned in `package.json` and `bun.lock`.

## Install and load

```bash
bun install --frozen-lockfile
pi install .
```

For development, load the extension explicitly from a Pi process running inside Herdr:

```bash
pi --extension "$PWD/src/extension.ts"
```

The extension refuses unsafe external Herdr control when `HERDR_ENV=1` is absent. Parent mailbox
inspection still works, but spawning, renaming, interrupting, or closing Herdr agents requires a
managed Herdr pane.

## Tools

Every process receives the durable mailbox tools:

- `agent_mail_send`, `agent_mail_list`, `agent_mail_read`, `agent_mail_ack`
- `agent_complete` for an explicitly assigned child

The parent coordinator additionally receives lifecycle tools:

- `agent_spawn`, `agent_steer`, `agent_interrupt`, `agent_resume`
- `agent_rename`, `agent_stop`, `agents_list`
- `workflow_start`, `workflow_status`, `workflow_list`, `workflow_cancel`

Important behavior:

- Escape interrupts only the current turn. The child remains registered and alive.
- `agent_steer` writes a durable correction; the child mailbox pump injects it into the current or
  next Pi turn.
- `agent_rename` changes the mutable alias. Routing by immutable UUID remains stable.
- A normal idle/settled turn does not shut down a child. The child must call `agent_complete`, and
  the parent closes the owned Herdr tab only after processing its durable result.

## Configuration

| Variable | Default | Purpose |
| --- | ---: | --- |
| `PI_HERDR_DB` | Pi session directory + `pi-herdr/control.sqlite` | Shared control-plane file |
| `PI_HERDR_MAX_AGENTS` | `8` | Maximum non-terminal agents |
| `PI_HERDR_MAX_MESSAGE_BYTES` | `65536` | Mail payload limit |
| `PI_HERDR_MAX_RESULT_BYTES` | `262144` | Completion payload limit |
| `PI_HERDR_MAX_PAGE_SIZE` | `100` | Query/claim page limit |
| `PI_HERDR_LAUNCH_TIMEOUT_MS` | `30000` | Native Pi readiness deadline |
| `PI_HERDR_OPERATION_TIMEOUT_MS` | `15000` | Herdr operation deadline |
| `PI_HERDR_LEASE_DURATION_MS` | `60000` | Agent/mail delivery lease |
| `PI_HERDR_MESSAGE_TTL_MS` | `604800000` | Default mailbox TTL |
| `PI_HERDR_COMPLETION_POLL_MS` | `500` | Inbox pump interval |

Child identity variables (`PI_HERDR_AGENT_ID`, `PI_HERDR_PARENT_ID`, and related fields) are set by
the supervisor and should not be supplied manually.

## Development

```bash
bun run typecheck
bun run test
bun run test:coverage
bun run format:check
bun run lint
bun run check
```

Tests execute with Node's native test runner. Bun remains the package manager, but `bun:sqlite`
cannot be imported by a Pi extension because Pi's executable is Node-based. The embedded
`better-sqlite3` connection therefore runs only under Node; no Bun database sidecar or second
failure domain is introduced.
