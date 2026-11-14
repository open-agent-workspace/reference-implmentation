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
