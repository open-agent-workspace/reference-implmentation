# Composable workspaces: assessment and implementation plan

This change implements Phase B: reference-only composition. Context/skill
resolution and coordinated execution below are proposed follow-ups, not new
runtime capabilities. A composition coordinates independently owned workspaces;
it does not register their repositories in its own manifest.

## Architecture assessment (Phase A)

Assessment baseline: reference implementation commit `59288763c0ed`.
The implementation is a TypeScript/pnpm monorepo with `packages/core` and
`packages/cli`; the executable is `ws`, not `workspace`.

| Concern | Actual implementation | Reuse / constraint |
| --- | --- | --- |
| Creation, identity, opening | `core/src/workspace.ts`: `initWorkspace` writes `.workspace/workspace.yaml` version 1 with a UUID; `discoverWorkspace` walks ancestors; `loadWorkspace` loads an exact root. No global workspace catalog or open/session daemon. | Reference existing IDs; exact loading prevents accidentally resolving a missing child to an ancestor. Older manifests without IDs continue standalone; membership requires an ID. |
| Repositories | `config.repositories` owns names, relative paths, URL, role and context flag; `repo add/clone/sync/list` manage registrations and materialization. One workspace may contain many repositories. | Keep each member's registrations authoritative. Composition never clones or materializes them. |
| Architecture graph | `system.ts` reads optional Systems, Layers, Resources, repository mappings and dependencies; discovery filters declarations. | Useful for identifying ownership within each selected member. It has no cross-workspace identity/reference semantics. |
| Instructions and skills | `agent-guidance.ts` generates a bounded section of root `AGENTS.md` and two `.agents/skills/*/SKILL.md` files, preserving user text. Profiles contain `instructions` and `skills`. | There is no general task-scoped skill resolver. `skills` is stored but is not resolved by `CommandAgentProvider`. Provider/native instruction discovery depends on the agent command and working directory. |
| Shared / private context | `.workspace/context` contains shared files; `RunOrchestrator` copies it into disposable Run context and captures its hash/revision. Agent instructions live in profile YAML. No private-context access control or merge protocol. | Reuse shared-context snapshots and provider preparation; do not treat all profile/history files as public context. |
| Agent sessions, goals, tasks and plans | One command process per bounded Run. The CLI accepts direct objectives and arbitrary `--intent` JSON; Run intent and selected lineage fields persist. No durable Task/goal/plan entities or scheduler. | Caller-owned Task IDs can correlate member Runs. Do not invent a second planner. |
| Isolation / Git | `git-worktree.ts` makes a branch/worktree for one mutation repository; other selected repositories receive detached context worktrees; each Candidate has independent commits. | Delegate execution to the member's existing runner, store and integration policy. Never combine Git histories. |
| Multi-repository work | A Run reads several repositories but mutates one. Current `run.ts` snapshots **all registered repositories** before materializing the selected context. | Unrelated unavailable repositories can still block a narrow Run; composition discovery must not inherit that behavior. Fix selected-only snapshots before cross-workspace dispatch. |
| Concurrency | SQLite profile leases for `concurrency: forbid`, process/resource records, and serialized integration lock. Concurrent permitted profiles get separate worktrees. | These locks are per workspace; they are not cross-workspace authorization or a global transaction. |
| Persistence / recovery | `store.ts` uses local SQLite under `.workspace/runtime`; Runs, Candidates, run repositories, events, processes, resource allocations and leases are persisted. `knowledge-files.ts` writes Git-friendly history/proposals. `status --reconcile` handles local ownership. | Durable history is not guaranteed for every failure/interruption. Operational state is separate from versioned declarations. |
| Hierarchy / dependencies | System repository/module edges exist; no workspace-to-workspace references, inheritance, member locator or cycle detection. | Add a small optional reference declaration; leave existing graphs and discovery intact. |
| Permissions | Profile scopes and worktree checks express workflow boundaries; local processes inherit OS access. Context worktrees are checked for modifications after execution. | Neither Git worktrees nor membership metadata provide a filesystem sandbox. No composition path may bypass provider/OS approvals. |

## Alternatives and decision

See [ADR-001](adr-001-composable-workspaces.md). A composition is an optional
capability of an existing workspace, represented by one additional YAML file.
A fresh integration/control directory may be initialized as a workspace and
own only contracts, architectural context and tests. It need not own a software
repository. Multiple compositions are separate coordinating workspaces; a member
may be referenced from any number of them.

## Data model implemented in Phase B

`.workspace/composition.yaml` uses the existing YAML library and snake_case
configuration conventions:

```yaml
version: 1
workspace_id: <coordinating workspace's existing id>
name: Agent Control System
members:
  - workspace_id: <dashboard's existing id>
    alias: dashboard
    path: ../dashboard
    role: Routes controller commands to desktop sessions
    access: read-only
  - workspace_id: <companion's existing id>
    alias: companion
    path: ../companion
    role: Owns desktop deep links and local session activation
    access: read-write
```

`workspace_id` is identity; `path` is a locator, resolved relative to the owning
workspace root. Writers store relative paths; readers also accept absolute
locators for local configurations. The root workspace already owns shared
context, guidance, skills and optional System contracts; the composition file
does not duplicate these as a competing catalog. Ownership is visible via member
alias, responsibility and repository names from `compose inspect`.

Aliases are unique lowercase names within one composition; a member ID cannot
appear twice in the same composition. Shared descendants in different branches
are allowed. Nested paths are relative to their own owner, not the top-level
composition. DFS tracks ancestor IDs, detects cycles, and caps traversal at 64
edges to bound pathologically deep graphs. Inspection continues across unavailable
or invalid members and returns their diagnostic alongside available siblings.
Adding or relocating a member validates the newly referenced subtree; an
unavailable nested reference must be repaired before adding that subtree.
Existing unrelated unavailable members do not prevent removal or repair.

There is no automatic disk scan or ID rebinding on relocation. `compose relocate`
requires the original identity at the new exact root; copied workspaces with the
same ID cannot be distinguished as separate owners. A user deliberately creating
a new independent identity must not clone an old workspace's ID. Duplicate IDs
across machines are outside this local registry's verification boundary.

Metadata can be reviewed and synchronized through the control workspace's Git
repository. Paths may need local relocation after clone; relative sibling layouts
remain portable when moved together. No new database or database migration is
required. Version 1 rejects unsupported versions rather than guessing.

Mutations acquire an exclusive local `.workspace/composition.yaml.lock`, reread
the current declaration, validate it, and atomically rename a temporary file over
the manifest. Concurrent writers fail with a useful message instead of losing
updates; readers see either complete version. After an interruption the old or
new manifest remains readable. Verify there is no active writer before removing
a stale lock or leftover `.tmp` file. These files must not be committed. This is
local filesystem coordination, not a distributed lock or power-loss durability
guarantee; resolve Git synchronization conflicts before running commands.

`access` defaults to `read-only`. In Phase B it records an intended maximum for a
future composition dispatcher; **it grants no authority and enforces no OS
permissions**. Commands read member manifests only, never source, root AGENTS,
profiles, history, instructions or skills. They never start agents. Editing
membership requires filesystem permission to the coordinator; the CLI does not
provide user roles or ACLs. Remove edits only this manifest, even when a member
is unavailable. No delete/relocate-files command is introduced.

## CLI surface implemented

Commands operate on the nearest current workspace, matching `repo` conventions:

```text
ws compose create [name] [--json]
ws compose add <alias> <workspace-path> [--role <role>] [--access read-only|read-write] [--json]
ws compose remove <alias> [--json]
ws compose relocate <alias> <workspace-path> [--json]
ws compose list [--json]
ws compose inspect [--json]
ws compose validate [--json]
```

`list` reports members of the current composition, not a machine-wide inventory.
`inspect` includes recursive structure, IDs, responsibility, locator, repository
names and diagnostics; neither requires repository checkouts to be available.
`validate` emits structured errors and exits nonzero on invalid references.
Top-level `ws validate` continues validating the existing System model; use
`ws compose validate` for composition references. A workspace without a composition
continues using all existing commands without migration. `ws run` is unchanged;
composition members are not silently added as writable or read-only repositories.

## Deterministic context plan (Phase C, proposed)

Extend preparation immediately before `CommandAgentProvider.prepare` and reuse
`RunOrchestrator` shared-context materialization. Do not add a separate skill
installation, copying or management system. The existing builder is small;
extract its shared selection/provenance logic rather than claim a resolver
already exists.

1. Accept explicit selected member paths such as `dashboard`, `companion`, or
   `subsystem/esp32`, selected repository names, purpose and approved read/write
   grants. Declared roles/System resources help an agent propose ownership; no
   semantic task classifier silently authorizes access. Unselected unavailable
   members do not block preparation; a selected missing reference does.
2. Verify each ID and effective grants along the complete reference path.
   Nested access is the intersection of every ancestor restriction, never a
   union of grants. Reading metadata, instructions, source, private context and
   starting an agent are separate capabilities. Reject insufficient grants
   before reading files. Private profiles/history/context require explicit
   access and never enter a default shared bundle.
3. Snapshot composition-owned architecture/policy/contracts selected for this
   task from the existing context/System conventions. Record source hashes,
   paths and selection reasons. The composition's instruction scope applies
   to integration/contracts; it cannot redefine a member's build, credentials
   or mutation policy.
4. Build a separate execution bundle per target workspace. Load its root
   AGENTS and selected repository/path-local conventions using the native
   agent adapter's instruction rules. Preserve root-to-nearest instruction
   precedence within that workspace. Sibling instructions are separate scoped
   documents; never concatenate them into one global authority. Agent
   system/developer/user precedence stays with the provider.
5. Discover skill metadata lazily from the original workspace's `.agents/skills`
   convention and profile-selected skills. Expose names, descriptions, owner
   IDs and source paths; read a SKILL body only when explicitly selected or
   matched by the agent's existing invocation mechanism. Qualify duplicate
   names by workspace ID. Do not copy or install member skills in the parent.
6. Deduplicate by owner ID, canonical source path and content hash; preserve
   repeated provenance/selection reasons. A hash alone must not collapse two
   distinct authority scopes. Shared descendants do not duplicate context.
7. Reject machine-readable grant/scope conflicts with both source references.
   Textual instruction contradictions cannot be reliably inferred by string
   comparison: expose provenance, flag known structured conflicts and surface
   unresolved semantic conflicts for review. A composition rule never silently
   overrides member policy; narrow the task or resolve the conflict explicitly.
8. Add `ws compose context --member <alias> --repo <name> --json` with repeatable
   selections and an explain-only default. Return ordered scoped sources,
   omitted sources/reasons, lazy skill descriptors, grants and conflicts.
   Dispatch must consume the same resolved plan/hash to avoid inspection drift.

Tests: selected-only instructions and skill discovery; native precedence;
private-context denial; unrelated missing member; selected missing member;
identity drift; shared descendants and duplicate content; skill name collisions;
nested read-only restrictions; structured conflicts with source locations;
provider integration preserves standalone prompt behavior. No blanket promise
of detecting arbitrary natural-language contradictions.

## Cross-workspace coordination plan (Phase D, proposed)

Tasks/plans/retries belong to the caller per the product design. Represent a
parent Task and workspace-specific subtasks in caller-owned intent, then reuse
one member Run per attempt and one Candidate per mutation repository. Example
proposed request/result envelope (not a CLI command or persisted Task schema):

```yaml
version: 1
composition: <control workspace id>
task: remote-focus
subtasks:
  - id: contract
    member: integration
    repository: contracts
    depends_on: []
  - id: emit
    member: esp32
    repository: firmware
    depends_on: [contract]
  - id: route
    member: dashboard
    repository: web
    depends_on: [contract]
  - id: activate
    member: companion
    repository: desktop
    depends_on: [contract]
```

The caller owns this DAG, validates subtask IDs/dependencies, detects cycles and
chooses serial or concurrent execution. A future dispatcher validates one
selected member grant and invokes that member's existing runner/profile/store,
passing `intent.lineage.task`, subtask/attempt IDs and the composition ID in
`intent`. It does not use a parent profile to bypass a member's policy. Each
result references owning workspace ID, Run ID and Candidate ID; no parent process
must adopt a member's database or filesystem. Correlation fields are caller
claims, not verified execution evidence.

Aggregate status must distinguish blocked, running, failed, partial, ready for
review and integrated. Candidate creation is not integration success. Read
member status/results on demand, retain the last observation for offline members,
and label it stale. The external caller decides failure propagation, retry
budgets and cancellation; retry creates a new attempt/Run with the same subtask
identity, retaining previous results. Idempotency keys belong to the caller and
are not currently guaranteed by `ws run`. Interrupted ownership is reconciled by
the owning workspace; unresolved Candidates are preserved. Independent commits
can be integrated in dependency order after repository checks and shared contract
validation. Failures are partial outcomes, never an atomic cross-Git rollback.

Before dispatch implementation: fix selected-only snapshots; verify declared
mutation scope cannot be expanded by explicit selectors; harden context grants;
and make durable Run results reliable for every terminal outcome. Evaluate the
existing `cmwen/coding-agent-orchestrator` consumer rather than building scheduling,
retry and durable Task state here. These gaps are explicit prerequisites, not
solved by composition metadata.

## Integration plan and acceptance (Phase E)

Phase B includes core tests and an in-process CLI integration test with existing
independent temporary workspaces. They verify unchanged original manifests,
multi-composition membership, nested/shared references, cycle rollback, invalid
schemas/aliases/access, identity mismatch, missing references, relocation, exact
root lookup, stale writer locks and non-destructive removal. Existing standalone
workspace, CLI, Git, Run and store tests remain regression requirements.

For C/D, add provider end-to-end fixtures using a fake agent in separate dashboard,
Rust companion and firmware repositories with distinct instruction/skill markers.
Prove only selected markers reach each process and shared contracts appear once;
check dependency order, partial completion, failed validation and interruption/
retry recovery. Use temporary fixtures to simulate missing members; never move
or delete live repositories. No hardware or GPUI SDK is required for metadata
and scope tests; actual hardware integration remains the firmware owner's check.

Compatibility: no standalone config/schema/database changes. Initial acceptance
covers composition create/list/inspect/validate, member ownership metadata,
identity and Git independence, graceful missing references and safe removal.
Automatic scoped instruction loading, agent dispatch and coordinated Task status
remain future acceptance gates; Phase B does not claim all ten feature criteria.

See the [multi-application example](composable-workspaces-example.md).
