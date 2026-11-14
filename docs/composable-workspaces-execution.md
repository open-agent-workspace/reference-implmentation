# Scoped context and cross-workspace work

Phases B, C and D are implemented as local composition references, scoped context
resolution and explicit subtask dispatch. Each member retains its workspace ID,
profiles, repository ownership, SQLite store, Git worktrees and Candidates.
There is no scheduler, automatic retry engine or cross-repository transaction.

## Scoped context (Phase C)

```sh
ws compose context --member companion --repo desktop \
  --allow-read instructions --allow-read context --allow-read skills \
  --task-path src/session.rs --skill rust --json
```

The command operates from the coordinator, resolves only the selected member path
and repository, and outputs an ordered plan with source paths, ownership, scopes,
selection reasons, hashes, omitted sources, lazy skill descriptors and conflicts.
No files are changed and no agent starts. Omitted grants default to no reads.
Unrelated offline members do not block a selection. To inspect a named profile's
policy and selected skills, add `--profile coder --allow-start`; this authorizes
reading that profile for the preview but does not start it. Add `--allow-write`
to preview membership/profile write conflicts.

`--shared <path>` explicitly selects coordinator-owned `.workspace/context/*` or
`system/contracts/*` files; it is repeatable. Private history/profile paths,
parent traversal and symlinked context/skill files are rejected. Member shared
context includes the standard architecture, conventions and policies files only;
unselected files are neither copied nor hashed by composition dispatch.

Instruction sources are resolved deterministically:

1. Composition ancestors' root guidance is scoped to integration/contracts.
2. The selected member's root guidance governs that workspace.
3. Selected repository and `--task-path` ancestor guidance applies from root to
   nearest path. `AGENTS.override.md` takes precedence over `AGENTS.md` in the
   same directory, matching the existing AGENTS convention.
4. Explicit task/profile skill bodies are included from their owning workspace.
   The named profile's own instructions remain with the member provider.

Native provider/system/user authority is unchanged. Sibling instructions are not
merged into a single global policy. Composition rules cannot override member
mutation policy. Structured membership, grant and profile conflicts report their
sources; arbitrary contradictions in prose still require human/agent review.
The CLI follows AGENTS conventions, not every vendor-specific configuration format.

Skills use the existing `.agents/skills/<name>/SKILL.md` convention. The resolver
discovers names/descriptions and original paths; bodies enter the bundle only
when selected by the task or existing profile `skills` field. There is no copying,
installation or second skill registry. Unqualified skill names resolve within the
selected member root. Descriptor IDs qualify workspace and scope, for example
`<workspace-id>:composition:rust`, `<workspace-id>:member:rust` or
`<workspace-id>:repository:desktop:rust`. Select an exact ID for other scopes.
Malformed unrelated descriptors are reported as omitted; explicitly requesting
an unavailable descriptor fails. Repeated references to the same owned source
are deduplicated while preserving provenance. Unselected bodies and descriptors stay in the inspectable discovery plan rather
than entering the execution prompt; an agent can request them on demand. Native agents may independently discover repository guidance;
the CLI does not disable that provider behavior.

The plan includes a metadata-only member responsibility catalog and coordinator
root, so an agent can discover ownership and request more scoped context without
loading every repository. Additional context never expands the Run's write target.

## Caller-owned task file (Phase D)

Store durable intent wherever the caller owns it, such as a Workstream. The CLI
reads this YAML without rewriting it. IDs are required: substitute actual IDs
from `ws compose inspect --json`. A task's definition is immutable after its
first attempt; use a new Task ID if changing intent, dependencies or grants.

```yaml
version: 1
id: remote-focus
composition: <coordinator-workspace-id>
objective: Route an ESP32 action to a desktop session
subtasks:
  - id: emit
    member: esp32
    workspace_id: <esp32-workspace-id>
    repository: firmware
    profile: coder
    objective: Emit the reviewed button action
    depends_on: []
    context:
      shared: [.workspace/context/button-command.md]
      paths: [src/buttons.cpp]
      skills: [embedded]
    grants:
      read: [instructions, context, skills, source]
      write: true
      start_agent: true
      read_status: true
  - id: activate
    member: companion
    workspace_id: <companion-workspace-id>
    repository: desktop
    profile: coder
    objective: Handle the reviewed session action
    depends_on: [emit]
    context:
      shared: [.workspace/context/button-command.md]
      skills: [rust]
    grants:
      read: [instructions, context, skills, source]
      write: true
      start_agent: true
      read_status: true
```

Subtasks may target several repositories in one workspace, with one mutation
repository per attempt. Profiles can allow multiple repository names, but a Run
still mutates only its explicitly selected one. Task/subtask IDs use letters,
digits, underscores and hyphens. Nested member selectors use slash-separated
aliases; every ancestor must permit writes. Definitions reject duplicate IDs,
unknown dependencies, dependency cycles, unknown fields and unsupported versions.

Read grants are distinct: `instructions`, `context`, `skills` and `source`.
A named profile is loaded only with `start_agent` authority. `read_status`
authorizes reading only the linked member Run/Candidate records, not arbitrary
private agent history. Dispatch requires explicit `write`, `start_agent`,
`read_status` and `source` grants, plus read-write membership at every edge and
the member profile's mutation/context constraints. Missing instruction/context/
skill grants omit those sources; selecting a skill/shared file without its read
grant produces a conflict. Private agent context is never a supported shared grant.

These controls govern CLI context selection and dispatch, not OS filesystem
permissions. Existing local agents still inherit their provider/OS access;
Git worktrees are workflow isolation, not a security sandbox.

## Commands and dependency gates

```sh
ws compose task validate workstreams/remote-focus.yaml --json
ws compose task inspect workstreams/remote-focus.yaml --json
ws compose task context workstreams/remote-focus.yaml --step emit --json
ws compose task run workstreams/remote-focus.yaml --step emit --json
```

`validate` checks the caller definition and resolves each declared subtask's
context/conflicts. `inspect` reads only the linked Run/Candidate state through
actual read-only SQLite connections and combines it with cached execution
reports. It creates no member database and never reconciles or dispatches work.
`context` resolves the exact step grants/profile; take its `sha256` into
`run --expect-context <sha256>` if the caller wants to bind execution to a preview.
Changed source/profile hashes fail before launching the agent. Integration
validation reconstitutes the same reviewed context from its provenance, verifies
its digest and uses the same provider instructions. A changed/deleted contract
or profile prevents integration until the reviewed inputs are restored or a
new reviewed Run is prepared.

`run` dispatches exactly one requested step and attempt. It never automatically
starts dependencies or integrates results. It calls the selected member's existing
RunOrchestrator, CommandAgentProvider, profile validation and isolated Git flow,
with no context-repository defaults expanded. Scoped context is passed through
the same provider instructions/environment. Only selected repositories are
snapshotted; unrelated unavailable registrations cannot block a narrow Run.
Explicit `--repo` and context selectors can no longer widen a profile's declared
scope, including in standalone Runs.

The result gives member workspace, Task/subtask, attempt, Run and Candidate IDs,
context/definition hashes, validation evidence and status. Review and integrate
from that member before starting dependent work:

```sh
cd /path/to/esp32-workspace
ws inspect <candidate-id> --json
ws integrate <candidate-id> --json
cd /path/to/coordinator
ws compose task run workstreams/remote-focus.yaml --step activate --json
```

Dependencies require an observed **integrated** Candidate. A successful agent or
pending Candidate is not sufficient. A contract update can be the first subtask,
followed by firmware/dashboard/desktop subtasks; a final integration-test subtask
can depend on them all and use its owning member's existing profile validation.
There is no global merge, automatic rollback or implicit checkout sharing.

## Attempts, partial completion and recovery

Run IDs are deterministic for coordinator ID, Task ID, subtask ID and attempt.
Repeating a call for the same attempt returns its existing result/status, even if
failed or still running; it never launches another agent. Failures need an explicit
next attempt number:

```sh
ws compose task run workstreams/remote-focus.yaml --step emit --attempt 2 --json
```

Attempts must be consecutive. Only failed, cancelled, rejected or reconciled
orphaned attempts can be retried. Pending Candidates and integration failures
are preserved for review/recovery instead of silently creating replacements.
Changing the Task definition requires a new Task ID; all previous attempts remain
in the original lineage. Retry budgets and choosing the next step remain caller-owned.

A dispatcher lease uses the coordinator's existing SQLite database and is keyed
by Task/subtask. Acquisition is transactional. It rejects live concurrent owners
and can reclaim a dead dispatcher; process-ID reuse or uncertain ownership
conservatively blocks. Different subtasks may run in separate caller invocations,
with member profile concurrency policy and isolated worktrees still applying.

Selected child Runs record caller Task lineage, definition/context hashes and the
execution owner's PID. Coordinator-owned execution reports live under
`.workspace/history/compositions/<task-id-hash>/`; member Run history remains in
that member's `.workspace/history/runs`. Reports contain execution references and
validation evidence, not instruction/skill bodies. Each report is replaced
atomically. They are execution history, not a second mutable Task scheduler.

If a dispatcher disappears after creating a Run, another process recovers that
Run by deterministic ID. A report written before any Run was created can resume
the same attempt. If a detached child remains alive, recovery reports it running
and does not duplicate it. Once its owner/child processes are gone, run the
existing `ws status --reconcile` inside the member. Reconciliation marks abandoned
Runs orphaned, including interruptions before child launch, and preserves their
worktrees. It does not resume an interrupted rebase or fabricate a Candidate.
Verified provider validation outcomes and log references are persisted even
when validation fails before Candidate creation. Failed, cancelled, orphaned
and pending-Candidate Runs now also retain durable
summaries; a process crash requires reconciliation to finish its summary.

Aggregate states include pending, blocked, running, failed, partial,
ready-for-review and integrated. Offline members retain the last report with
`stale: true` and an error; stale observations cannot satisfy dependency gates or
produce an integrated aggregate. After relocation, repair the member locator
with `ws compose relocate` and verify the same workspace ID. Inspection does not
write refreshed cache data; the durable cache is the last dispatch checkpoint.

## Validation and compatibility

Tests cover instruction ordering/overrides, relevance, deduplication, skill
collisions/lazy bodies, malformed unused descriptors, missing/changed references,
private-path and symlink rejection, nested grants and profile conflicts, real
member Runs with fake agents, distinct Git Candidates, integration dependencies,
retry/partial results, read-only status, cross-process idempotency, concurrent
leases and interruption recovery. Existing standalone tests remain required.
No new database or configuration syntax is introduced. The existing operational
SQLite schema adds one local dispatcher-lease table; task definitions are
caller-owned versioned YAML and existing composition version 1 remains compatible.
