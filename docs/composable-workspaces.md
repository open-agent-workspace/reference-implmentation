# Composable workspaces: assessment and implementation plan

Phases B, C and D are implemented. Stable workspace references now support
scoped context and explicit caller-selected subtask dispatch through member Runs. A composition coordinates independently owned workspaces;
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
remain portable when moved together. Reference metadata needs no new database or standalone workspace migration;
dispatch adds the local lease-table migration described below. Version 1 rejects unsupported versions rather than guessing.

Mutations acquire an exclusive local `.workspace/composition.yaml.lock`, reread
the current declaration, validate it, and atomically rename a temporary file over
the manifest. Concurrent writers fail with a useful message instead of losing
updates; readers see either complete version. After an interruption the old or
new manifest remains readable. Verify there is no active writer before removing
a stale lock or leftover `.tmp` file. These files must not be committed. This is
local filesystem coordination, not a distributed lock or power-loss durability
guarantee; resolve Git synchronization conflicts before running commands.

`access` defaults to `read-only`. It bounds the composition dispatcher and **it grants no authority and enforces no OS
permissions**. Membership/inspection commands read member manifests only. Context and Task
commands require explicit source grants and can start only a selected member Run. Editing
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
continues using all existing commands without migration. Standalone `ws run` retains its lifecycle and now enforces explicit profile scopes;
composition members are not silently added as writable or read-only repositories.

## Scoped context and subtask dispatch (Phases C and D)

See the [execution contract](composable-workspaces-execution.md) for the implemented
context resolver, explicit grants, caller-owned Task model, CLI commands,
dependency gates, integration validation, retries and interruption recovery.
The architecture table above records the pre-composition assessment baseline;
selected-only snapshots, profile scope enforcement, read-only inspection and
all-outcome Run summaries are now implemented prerequisites.

## Integration and compatibility

Standalone manifests and composition version 1 remain compatible. The operational
SQLite schema adds a local dispatcher-lease table. There is no new database,
mandatory Task store, scheduler, cross-Git transaction or skill manager.
[Tests and validation](composable-workspaces-validation.md) cover the original
reference slice plus scoped context and real cross-workspace fake-agent flows.
See the [multi-application example](composable-workspaces-example.md).
