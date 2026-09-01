# Agentic Engineering Workspace Reference CLI

`ws` is a local-first TypeScript reference implementation of the Agentic
Engineering Workspace patterns. It coordinates bounded coding-agent runs
across one or more Git repositories without turning those repositories into a
monorepo or letting agents write into the human checkout.

The reference convention treats a workspace as a Git control repository. Open
that control repository as the coding agent’s project root. The repositories
it manages are independently Git-managed checkouts below the ignored
`repos/` directory; they are not submodules and they do not share the control
repository’s history.

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
- pnpm 11 or newer
- TypeScript 7 (installed by the workspace as `typescript@7.0.2`)

## Install and create a workspace

```bash
pnpm install
pnpm build
pnpm --filter @agentic-workspace/cli link --global

mkdir /path/to/my-workspace
cd /path/to/my-workspace
ws init
ws repo clone https://github.com/acme/api-service.git \
  --name api --role primary --path repos/api-service
ws repo clone https://github.com/acme/web-client.git \
  --name web --role secondary --path repos/web-client
ws repo add /path/to/a/local-repository --name local --role secondary
ws generate
ws agent add coder --command 'node ./scripts/my-agent.mjs {prompt}'
git add AGENTS.md .agents .workspace .gitignore
git commit -m "Configure agentic workspace"

# Run these commands from the workspace root.
ws repo sync
ws run coder "Fix authentication refresh" --repo api \
  --context-repo web --no-integrate
ws runs
ws status
ws inspect <run-id>
ws integrate <candidate-id>
```

`ws init` creates the Git control-repository layout and durable workspace
metadata. If a workspace is being initialized in a directory that is not yet
Git-managed, the CLI initializes that control repository. `ws repo clone`
materializes a URL-backed repository at `repos/<name>` (or an explicit direct
child such as `--path repos/api-service`) and records its URL and
workspace-relative path. Paths outside `repos/` are rejected. `ws repo add`
registers an existing local checkout; it infers the `origin` URL when one is
available, or accepts an explicit `--url`.

`ws generate` writes the root `AGENTS.md` and workspace-scoped skills under
`.agents/skills/`. These files explain the workspace map, repository
boundaries, `ws` workflow, and the distinction between the interactive driver
and bounded Runs. Review and commit generated guidance along with the control
repository’s manifest.

## Monorepo layout

The implementation is a pnpm monorepo with explicit package boundaries:

```text
packages/
├── core/  # workspace model, store, orchestration, and provider seams
└── cli/   # argument parsing, output, command dispatch, and ws binary
```

Use `pnpm check` for the TypeScript 7 build and all unit/integration tests, or
`pnpm test:coverage` to include Node's source coverage report. The executable
for a repository checkout is `packages/cli/bin/ws.js` after `pnpm build`.

`ws run` is synchronous, which makes it useful from a terminal, cron,
`systemd`, or another scheduler. Independent invocations can run concurrently;
each receives a separate Run ID, branch, worktree, process record, and allocated
ports.

## Commands

```text
  ws init [directory] [--name <name>]
  ws repo add <path> [--name <name>] [--role <role>] [--url <url>]
  ws repo clone <url> [--name <name>] [--role <role>] [--path <repos/name>]
  ws repo sync [name]
  ws repo list
  ws generate
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

The control repository created by `ws init` has this shape:

```text
AGENTS.md                         # generated driver-agent instructions
.agents/
└── skills/                       # generated workspace skills
.gitignore                        # includes repos/ and runtime state
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
repos/                            # ignored; independent Git repositories
├── api-service/.git/
├── web-client/.git/
└── ...
```

The manifest, context, generated guidance, skills, profiles, history
summaries, and proposals are durable and Git-friendly. The `repos/` directory
is intentionally ignored by the control repository; each checkout remains
owned by its own Git repository. The `.workspace/runtime/` directory is also
ignored and disposable. Losing runtime state loses local coordination history,
never the Git commits that contain candidate work.

A repository entry is portable because it records both a workspace-relative
path and its Git URL:

```yaml
repositories:
  - name: api
    path: repos/api-service
    url: https://github.com/acme/api-service.git
    role: primary
    context: true
  - name: web
    path: repos/web-client
    url: https://github.com/acme/web-client.git
    role: secondary
    context: true
```

`ws repo sync [name]` uses the recorded URL to clone a missing checkout. It
verifies but deliberately leaves an existing checkout unchanged, so it never
fetches over or otherwise disturbs local work. Independent repositories do
not become one atomic update.

## The two agent contexts

There are two deliberate working contexts:

1. The interactive driver agent starts with its current directory at the
   control-repository root. It reads the generated `AGENTS.md` and
   `.agents/skills/`, edits durable workspace configuration or documentation,
   and invokes `ws repo ...`, `ws generate`, and bounded `ws run` commands.
2. A bounded Run agent is launched by `ws run` in an isolated Git worktree of
   the selected mutation repository under `.workspace/runtime/worktrees/`.
   It receives the selected repository context, changes only its mutation
   repository, and returns a Candidate for validation and integration.

The driver’s root checkout and the managed repositories’ canonical checkouts
remain separate. A bounded Run does not edit the control repository or a
context-only repository. This lets the coding agent operate from one project
root while preserving the repository-level ownership and review boundaries.

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
