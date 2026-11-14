# Composition validation evidence

Base: `59288763c0ed`; isolated `ws run` workspace: `/tmp/ws-composition-review`.
The first Candidate was validated before integration. Release validation is
recorded separately in the managed documentation and Run history.

Validation commands from the Candidate worktree:

```sh
node_modules/.bin/tsc -p packages/core/tsconfig.json
node_modules/.bin/tsc -p packages/cli/tsconfig.json
node --test packages/core/dist/tests/*.test.js packages/cli/dist/tests/*.test.js
git diff --check
```

Results: TypeScript core/CLI builds pass; all 55 tests pass, zero failures,
zero skips (10 new composition tests, 45 existing tests). Diff whitespace
validation passes. The CLI integration test exercises public command handlers
with two existing temporary workspaces, relocation, missing references and safe
removal. It does not exercise context composition or dispatch, which are not
implemented in Phase B.

A fresh pnpm install was blocked by the sandbox's npm registry allowlist.
Validation reused the environment's installed TypeScript/Node types/YAML
packages via ignored node_modules links; no dependency or lockfile changes were
made. This is build/test evidence, not evidence of a fresh dependency install.

## Phases C/D validation

The C/D Candidate builds both TypeScript packages and passes all 82 core/CLI
tests (27 additional tests beyond Phase B), including real fake-agent execution
in separate member repositories and cross-process CLI recovery. Commands:

```sh
node_modules/.bin/tsc -p packages/core/tsconfig.json
node_modules/.bin/tsc -p packages/cli/tsconfig.json
node --test packages/core/dist/tests/*.test.js packages/cli/dist/tests/*.test.js
git diff --check
```

The managed documentation passes its metadata check and builds 65 pages before
restoring unrelated local documentation work. Dependency metadata is unchanged;
validation uses the environment's installed dependencies. Coverage includes
scoped instruction provenance and native overrides, lazy skill selection,
private-path/symlink rejection, grant conflicts, selected-only snapshots, profile
scope enforcement, caller-owned Task graphs, separate Candidates, integrated
dependency gates, failed validation evidence, retries, concurrent dispatch leases,
offline cached results, cancellation and interrupted ownership recovery.
Integration replays the reviewed context and rejects changed contract sources.
