# Multi-Agent Capability and Product Roadmap

Updated 2026-09-08.

This document tracks product, orchestration, workflow, automation, and extensibility capabilities that would make `pi-herdr` a more capable multi-agent environment.

These items are **not correctness defects** unless separately promoted into the correctness-gap register.

The correctness layer must remain stable even if none of these features are implemented.

---

# 1. Tool and Capability Extensibility

Built-in Pi tools alone are not sufficient for a general multi-agent system.

Workers should be able to use:

- Pi-native tools,
- MCP servers,
- external tool providers,
- connectors,
- repository-local tools,
- extension-defined capabilities,
- future capability providers.

Capability availability must be represented explicitly.

Conceptual worker capability declaration:

```text
WorkerCapabilities
├── nativeTools
├── MCP
├── connectors
├── extensionTools
├── filesystemAccess
├── networkAccess
├── repositoryAccess
└── capabilityRestrictions
```

Do not assume every worker receives every capability available to the parent.

Support:

```text
parent capability
       │
       ├── inherit
       ├── restrict
       ├── explicitly grant
       └── deny
```

Capability selection should be tied to assignment needs and policy.

---

# 2. Full JSON Configuration

Configuration should have a complete machine-readable representation.

Avoid hidden configuration spread across:

- prompts,
- environment variables,
- implicit defaults,
- partial state mutations,
- and extension-local assumptions.

Conceptual configuration:

```json
{
  "version": 1,
  "runtime": {},
  "agents": {},
  "tools": {},
  "mcp": {},
  "connectors": {},
  "skills": {},
  "workflow": {},
  "monitoring": {},
  "automation": {},
  "lifecycle": {},
  "guardrails": {},
  "policies": {}
}
```

Requirements:

- full JSON representation,
- schema validation,
- explicit version,
- deterministic defaults,
- inspectable effective configuration,
- configuration diffing,
- persistence,
- auditability.

If partial updates are supported, the resulting **full effective JSON** must remain queryable.

---

# 3. Skill-Aware Spawn Contract

Sub-agent creation should explicitly define required skills.

Do not rely only on natural-language hints such as:

```text
Use the security skill.
```

Spawn metadata should preferably include:

```text
AgentSpawn
├── assignment
├── role
├── primarySkill
├── additionalPlaybooks
├── capabilities
├── workspace
└── executionPolicy
```

The generated worker prompt should end with an explicit execution instruction similar to:

```text
Before beginning the assignment:

1. Load the designated primary skill.
2. Read and apply its complete workflow.
3. Load only additional playbooks triggered by this task.
4. Follow all verification and completion requirements.
5. Do not report success until the skill-defined exit criteria are met.
```

The skill requirement should therefore exist in:

```text
structured spawn state
+
worker-visible prompt
```

rather than prompt text alone.

---

# 4. Agent Retirement

Stopping a worker and deleting its historical identity are different operations.

Model lifecycle explicitly:

```text
active
   ↓
stopped
   ↓
terminal
   ↓
retired
   ↓
archived
```

Potential operations:

```text
stop
retire
archive
purge
```

Avoid one ambiguous `delete` operation.

Before retirement:

- preserve completion result,
- preserve event history,
- resolve ownership,
- handle pending mail,
- detach workflow references,
- close owned resources,
- preserve required audit metadata.

---

# 5. Automatic Agent Garbage Collection

Unused workers should not accumulate indefinitely.

Possible GC candidates:

- completed agents,
- failed agents,
- cancelled agents,
- orphaned workers,
- superseded runs,
- workers no longer referenced by an active workflow,
- workers inactive beyond configured retention,
- temporary review/research workers whose result has been consumed.

Conceptual process:

```text
terminal agent
      ↓
retention period
      ↓
referenced?
 ┌────┴────┐
 yes       no
 │          │
retain    archive
            ↓
       cleanup resources
```

GC must preserve enough information for:

- diagnostics,
- result provenance,
- audit,
- recovery.

---

# 6. Workflow Board / Kanban Projection

Persistent DAGs are useful for dependency correctness.

They are not always sufficient for human workflow management.

Expose workflow as a board projection.

Example:

```text
Backlog
   ↓
Ready
   ↓
In Progress
   ↓
Blocked
   ↓
Review
   ↓
Done
```

Additional terminal or exceptional states:

```text
Failed
Cancelled
Needs Input
Superseded
```

Important distinction:

```text
DAG = dependency/scheduling truth

Kanban = operational/work-state projection
```

Do not replace the DAG with Kanban if doing so weakens dependency semantics.

The workflow engine should own canonical task state.

Skills may influence workflow behavior, but should not become the sole persistence layer.

---

# 7. Git Workspace / Worktree Integration

Coding workers should optionally receive isolated repository workspaces.

Example:

```text
Repository
   │
   ├── worktree/task-a → Agent A
   ├── worktree/task-b → Agent B
   └── worktree/task-c → Agent C
```

Benefits:

- isolated mutations,
- clear ownership,
- easier diff review,
- lower accidental overwrite risk,
- reproducible task branches,
- easier rollback,
- easier integration review.

Track structurally:

```text
workflowNode
agentId
runId
repository
baseRevision
branch
worktreePath
resultRevision
```

Workspace cleanup should integrate with workflow and agent lifecycle.

---

# 8. Consistency Guardrails

Multiple successful agents can still produce a globally inconsistent result.

Introduce a reconciliation layer.

Detect:

- contradictory conclusions,
- duplicate work,
- incompatible assumptions,
- stale dependency results,
- contradictory patches,
- overlapping code ownership,
- incompatible versions,
- artifact conflicts,
- superseded result consumption,
- workflow state disagreement.

Conceptually:

```text
Agent A result ───────┐
                      │
Agent B result ───────┼──► Reconciliation
                      │
Repository state ─────┤
                      │
Workflow state ───────┘
                            │
                  ┌─────────┴─────────┐
                  │                   │
              consistent           conflict
                  │                   │
                accept           review/rework
```

Possible guardrail layers:

```text
pre-execution
mid-execution
pre-publication
pre-merge
final synthesis
```

---

# 9. Agent Activity Model

Track activity semantically rather than through only a process heartbeat.

Useful fields include:

```text
lastProcessHeartbeat
lastTurnStartedAt
lastTurnSettledAt
lastToolActivityAt
lastMailReceivedAt
lastMailSentAt
lastMailAckAt
lastWorkflowProgressAt
lastArtifactMutationAt
lastStateTransitionAt
```

From those signals derive:

```text
working
idle
waiting
blocked
stalled
unresponsive
terminal
```

A worker waiting correctly on a dependency must not be classified as stalled merely because it has not called a tool recently.

---

# 10. Stalled-Agent Detection

Detect lack of meaningful progress.

Possible evidence:

```text
reasoning active for excessive duration
no workflow progress
repeated same operation
unresolved error loop
dependency already satisfied but agent remains blocked
status request unanswered
tool retry loop
```

Use multiple signals rather than a single timeout whenever possible.

---

# 11. Automatic Steering

The parent/coordinator may automatically intervene when an agent appears stuck.

Recommended escalation:

```text
activity anomaly
      ↓
inspect state
      ↓
legitimate waiting?
 ┌────┴────┐
 yes       no
 │          │
ignore   request status
             ↓
         recovered?
        ┌────┴────┐
       yes       no
       │          │
     continue    steer
                   ↓
               recovered?
              ┌────┴────┐
             yes       no
             │          │
          continue   reassign /
                     interrupt /
                     retire
```

Automatic steering must be:

- bounded,
- rate-limited,
- generation-aware,
- context-aware,
- idempotent,
- visible in event history.

Avoid:

```text
steer
steer
steer
steer
...
```

without evidence of new failure.

---

# 12. Automatic Inter-Agent Messaging

Allow orchestration policies to generate messages based on workflow events.

Potential triggers:

```text
dependency completed
dependency failed
artifact updated
conflict detected
worker blocked
worker stalled
review required
assignment changed
workflow cancelled
parent checkpoint required
new result relevant to another worker
```

Example:

```text
Agent A completes parser implementation
               ↓
workflow discovers Agent B depends on it
               ↓
Agent B receives durable dependency update
```

Generated traffic must still use normal protocol guarantees:

- immutable recipient ID,
- run fencing,
- idempotency,
- receipts,
- lane semantics,
- retry rules,
- dead letters.

---

# 13. Message Coalescing

Automation can create message storms.

Introduce coalescing.

Instead of:

```text
artifact changed
artifact changed
artifact changed
artifact changed
```

prefer:

```text
Artifact X changed 4 times.
Latest revision: abc123.
Relevant downstream dependency is now ready.
```

Possible controls:

```text
debounce
deduplication
aggregation
priority
rate limiting
supersession
```

Control messages should remain independent of ordinary message coalescing where necessary.

---

# 14. Policy Engine

Autonomous behavior should not be distributed across unrelated hard-coded conditions.

Create a policy layer.

Conceptually:

```text
PolicyEngine
├── SpawnPolicy
├── CapabilityPolicy
├── SkillPolicy
├── WorkspacePolicy
├── ActivityPolicy
├── SteeringPolicy
├── MessagingPolicy
├── RetirementPolicy
├── ConsistencyPolicy
└── ResourcePolicy
```

Policies should be:

- versioned,
- schema validated,
- queryable,
- deterministic where possible,
- testable,
- auditable.

Example:

```json
{
  "activity": {
    "statusProbeAfterMs": 120000,
    "steerAfterMs": 300000,
    "maxAutomaticSteers": 2
  },
  "retirement": {
    "terminalRetentionMs": 1800000,
    "archiveBeforeCleanup": true
  }
}
```

Values are configuration rather than protocol constants.

---

# 15. Human Override

Automation must remain controllable.

Provide operations to:

```text
disable auto-steering
pause automation
pin an agent
prevent GC
force review
override workflow status
disable a policy
manually reassign work
```

Manual intervention should create an auditable event.

---

# 16. Capability Discovery

The system should know not merely which agents exist, but what they can currently do.

Directory entries may eventually expose:

```text
agent
├── role
├── skills
├── capabilities
├── MCP servers
├── tools
├── workspace
├── workflow assignments
├── current state
└── current load
```

This enables capability-aware scheduling.

Example:

```text
task requires:
    solidity
    slither
    git workspace
    external RPC

scheduler
    ↓
select eligible worker
```

---

# 17. Capability-Aware Scheduling

Workflow assignment should eventually consider more than dependency readiness.

Potential scheduler inputs:

```text
required skills
required tools
required MCP capabilities
workspace availability
agent workload
specialization
model capability
cost policy
dependency locality
existing context
```

This allows:

```text
ready task
    ↓
eligible agents
    ↓
policy ranking
    ↓
reservation
    ↓
spawn/assign
```

instead of spawning arbitrary homogeneous workers.

---

# Recommended Delivery Order

## Phase A — Foundation

1. Full JSON configuration.
2. Structured capability model.
3. Skill-aware spawn contract.
4. Activity model.
5. Policy engine foundation.

## Phase B — Agent Lifecycle

6. Explicit retirement.
7. Archival.
8. Automatic garbage collection.
9. Human override.

## Phase C — Autonomous Coordination

10. Stalled-agent detection.
11. Automatic status probes.
12. Automatic steering.
13. Automatic inter-agent messaging.
14. Message coalescing.

## Phase D — Workflow

15. Kanban projection.
16. Git worktree/workspace integration.
17. Capability-aware scheduling.

## Phase E — Correctness Above Individual Agents

18. Consistency guardrails.
19. Reconciliation gates.
20. Review/merge gates.

## Phase F — Ecosystem

21. MCP.
22. Connectors.
23. External capability providers.
24. Dynamic capability discovery.

---

# Non-Goals

This roadmap should not weaken protocol correctness in exchange for autonomy.

In particular:

```text
auto-steering
auto-messaging
auto-GC
Kanban
MCP
skills
capability scheduling
```

must remain layered above:

```text
identity
run fencing
mail durability
completion correctness
workflow ownership
crash recovery
```

Feature richness must not become part of the trusted correctness core unless strictly necessary.

---

# Target Architecture

Long-term:

```text
                    Coordinator
                         │
              ┌──────────┴──────────┐
              │                     │
         Policy Engine         Workflow Engine
              │                     │
       ┌──────┼──────┐        ┌─────┼─────┐
       │      │      │        │     │     │
    Skills  Tools  MCP     DAG   Kanban  Git
       │      │      │        │     │     │
       └──────┴──┬───┘        └─────┬─────┘
                 │                  │
                 └────────┬─────────┘
                          │
                    Agent Scheduler
                          │
                ┌─────────┼─────────┐
                │         │         │
             Agent A   Agent B   Agent C
                │         │         │
                └─────────┼─────────┘
                          │
                Consistency Guard
                          │
                     Final Result
```

The policy and workflow layers decide what should happen.

The underlying durable protocol decides whether it can happen safely.
