# ADR 0001: Durable SQLite supervisor with native Herdr control

Status: accepted

## Context

The reference implementation relied on transient process state and terminal polling. It could not
provide durable direct mail, safe correction after Escape, coordinated rename, or deterministic
recovery after a parent restart.

## Decision

Use embedded SQLite as the orchestration source of truth and Herdr 0.8.2 native agent commands as
the external lifecycle surface. Preserve full Pi TUIs in Herdr tabs. Use Pi 0.85.0 extension events
and require explicit `agent_complete` followed by `agent_settled` for terminal results.

Live payloads always pass through the durable mailbox and recipient Pi extension with
`deliverAs: "steer"`. Herdr terminal input is not a second payload-delivery path. Mutable aliases
are projections over immutable UUID identity.

Use `better-sqlite3` because Pi runs extensions under Node. Synchronous local transactions make
mail/idempotency, leases, revisions, DAG reservation, and recovery invariants explicit. Bun stays
the package manager, but no Bun database sidecar is introduced.

## Alternatives

- Raw pane input and process polling retain the original identity and interruption failure modes.
- Pi RPC is suitable for headless automation but would require a second client to preserve the
  native interactive TUI model.
- JSON/JSONL files cannot cheaply provide multi-record uniqueness, transactional leases,
  deduplication, or indexed pagination.
- An external broker adds an unnecessary service and trust boundary for a local control plane.

## Consequences

`better-sqlite3` is a native Node dependency. Mail delivery is at-least-once, so effects must be
idempotent and acknowledgement is explicit. SQLite and Herdr cannot share one transaction;
external mutations therefore have compensation and recovery paths, and ambiguous surfaces become
`orphaned` rather than guessed healthy.

