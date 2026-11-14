# ADR-001: Reference independently owned workspaces

Status: accepted; Phases B, C and D are implemented.

## Context

The CLI already composes independent repositories into bounded Runs, but a
repository registration does not preserve another workspace's identity, profile,
instructions, skills or policy ownership. Dashboard, Rust/GPUI and ESP32 projects
may already belong to different workspaces, each containing several repositories.
They must participate in multiple systems without migration or copying.

The existing product design assigns goals, scheduling, retries and budgets to
external callers. Git worktrees are workflow isolation, not security isolation.

## Options

| Option | Benefit | Cost |
| --- | --- | --- |
| Add every member repository to one manifest | No new abstraction | Duplicates ownership and loses member context; turns composition into a bigger workspace. |
| Represent references only as generic System Resources | Existing architecture catalog | No stable workspace identity binding, member access convention or cycle checks; overburdens an optional System model. |
| Global workspace database/catalog | Automatic lookup after relocation | New infrastructure and synchronization/privacy lifecycle; unnecessary for local composition. |
| Separate composition product/config format | Rich independent type | Competing workspace/context lifecycle and migration overhead. |
| Optional composition YAML on an existing coordinating workspace | Reuses identity, durable YAML, context conventions and CLI patterns | Explicit local locators and one composition per coordinating workspace. |

## Decision

Use `.workspace/composition.yaml`, version 1, bound to the coordinator's existing
workspace ID. Member references contain stable workspace ID, local alias, path
locator, optional responsibility and explicit intended access ceiling (read-only
by default). The coordinator may own only architectural context/contracts; it
need not own member repositories or any software repository.

Resolve exact workspace roots and verify identity. Allow nesting, shared
subgraphs and membership in multiple compositions. Detect ancestor identity
cycles and return per-member errors for unavailable references. Never discover
upward from a locator, initialize missing members, clone their repositories,
rewrite their manifests, inherit their profiles or delete their data.

Serialize local metadata mutations with an exclusive file lock and atomic
replacement. Keep declarations in Git, operational member Run state in each
member's existing SQLite store, and caller intent in its owning external system.
No new database, workspace schema migration or configuration syntax is added.

Membership access fields bound the implemented dispatcher, intersecting explicit
task grants with every nested access ceiling and member profile policy. They do
not grant OS permissions. Membership inspection reads manifests only; scoped
context and explicit task dispatch preserve instruction provenance and one
mutation repository per Run. Standalone commands do not interpret composition
metadata as authorization.

## Consequences

Existing workspaces remain independently usable and require no migration. Member
IDs must exist to be referenced; manifests lacking IDs remain usable standalone
and need an explicit owner-approved identity assignment before joining. Relative
paths are portable when layouts move together; `compose relocate` repairs a
member locator only after verifying its identity. No global search or automatic
workspace adoption is attempted.

A coordinating workspace can be versioned independently of application histories.
Git conflicts require explicit resolution; locks coordinate local writers only.
Offline members appear as diagnostics while available members remain inspectable.
New references require their selected subtree to validate. Removal remains
possible offline. Same-ID copies and malicious local filesystem races are not
solved by a reference catalog.

Scoped context explanation and caller-linked member Runs are implemented in the
[execution contract](composable-workspaces-execution.md).
This ADR does not authorize a scheduler, global worktree, cross-Git transaction,
or a second skill manager.
