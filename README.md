# Agentic Engineering Workspace Reference CLI

`ws` is a local-first reference implementation of the Agentic Engineering
Workspace patterns. It coordinates bounded coding-agent runs across one or
more Git repositories without turning those repositories into a monorepo or
letting agents write into the human checkout.

The implementation deliberately starts small:

- Git worktrees isolate writable runs.
- SQLite coordinates local operational state.
- Markdown and YAML hold durable, reviewable workspace knowledge.
- command adapters invoke local agents; there is no embedded model router.
- candidates are inspected and integrated separately from agent execution.
- external schedulers can repeatedly invoke the same bounded `ws run` command.

Worktrees are workflow isolation, not a security sandbox.

## Requirements

- Node.js 24 or newer
- Git 2.31 or newer

## Install and try it

```bash
pnpm install
pnpm link --global

cd /path/to/a/git/repository
ws init
ws repo add .
ws agent add coder --command 'node ./scripts/my-agent.mjs {prompt}'
git add .workspace
git commit -m "Configure agentic workspace"
ws run coder "Fix authentication refresh" --no-integrate
ws runs
ws status
ws inspect <run-id>
ws integrate <candidate-id>
```

`ws run` is synchronous, which makes it useful from a terminal, cron,
`systemd`, or another scheduler. Independent invocations can run concurrently;
each receives a separate Run ID, branch, worktree, process record, and allocated
ports.

## Commands

```text
ws init [directory]
ws repo add <path> [--name <name>] [--role <role>]
ws repo list
ws agent add <name> [--command <command>] [--concurrency allow|forbid]
ws run <agent> [objective] [--repo <name>] [--context-repo <name> ...]
       [--intent <json>] [--port <ENV_NAME> ...] [--integrate|--no-integrate]
ws runs [--limit <n>]
ws status
ws inspect <run-or-candidate-id>
ws integrate <candidate-id>
ws cleanup
```

Most read commands support `--json` for scripts.

## Workspace files

`ws init` creates:

```text
.workspace/
├── workspace.yaml
├── context/
│   ├── architecture.md
│   ├── conventions.md
│   └── policies.md
├── agents/
├── history/runs/
├── proposals/
├── runtime/
│   ├── workspace.db
│   ├── worktrees/
│   └── logs/
└── .gitignore
```

The manifest and context are durable and Git-friendly. The runtime directory
is ignored and disposable. Losing it loses local coordination history, never
the Git commits that contain candidate work.

## Agent command profiles

An agent profile is a YAML file under `.workspace/agents`. Commands are parsed
as argument arrays, not evaluated by a shell. Placeholders let a provider
receive explicit inputs:

```yaml
name: coder
provider: command
command:
  - codex
  - exec
  - --cwd
  - "{worktree}"
  - "{prompt}"
concurrency: allow
validation:
  - npm test
ports:
  - PORT
```

Supported placeholders are `{prompt}`, `{instructions}`, `{worktree}`,
`{workspace}`, and `{context}`. Context repository paths and allocated ports
are also injected as environment variables. `ws agent add codex` uses the
non-interactive `codex exec --ephemeral` adapter by default; other commands can
be supplied explicitly with `--command`.

## Safety defaults

- A run records repository revisions before invoking an agent.
- Only the primary mutation repository receives a writable worktree.
- Canonical checkouts with uncommitted changes are never integrated into.
- Integration is serialized and remains separate from execution.
- Failed integration preserves the candidate branch and worktree.
- Cleanup removes only integrated/completed artifacts proven safe to remove.
- Orphan recovery releases dead runtime resources but preserves candidate work.

V1 does not provide remote execution, atomic multi-repository integration,
hard sandboxing, a scheduler, a CI service, or distributed coordination. Those
are explicit provider extension points rather than hidden promises.
