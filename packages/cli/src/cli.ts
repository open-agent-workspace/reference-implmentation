import { access, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { parseArgs, rejectUnknown, requirePositional } from './args.js';
import { printValue } from './output.js';
import {
  WorkspaceError,
  headCommit,
  currentBranch,
  isDirty,
  RunOrchestrator,
  openStore,
  addRepository,
  cloneRepository,
  createAgentProfile,
  discoverWorkspace,
  generateWorkspaceAgentFiles,
  initWorkspace,
  listRepositories,
  loadAgentProfile,
  materializeMissingRepositories,
  materializeRepository,
  repositoryRoot,
  workspacePaths,
  CommandAgentProvider,
  tokenizeCommand,
  GitWorktreeExecutionProvider,
  removeWorktree,
  GitIntegrationProvider,
  ProcessResourceProvider,
  FileKnowledgeProvider,
  runGit,
  discoverResources,
  loadSystemModel,
  validateSystemModel,
} from '@agentic-workspace/core';

const VERSION = '0.3.0';
const HELP = `Agentic Engineering Workspace reference CLI

Usage:
  ws init [directory] [--name <name>]
  ws repo add <path> [--name <name>] [--role <role>] [--url <git-url>]
  ws repo clone <git-url> [--name <name>] [--role <role>] [--path <repos/name>]
  ws repo sync [name]
  ws repo list [--json]
  ws discover [--system <id>] [--layer <id>] [--kind <kind>] [--json]
  ws validate [--json]
  ws generate [--json]
  ws agent add <name> [--command <argv>] [--concurrency allow|forbid]
  ws run <agent> [objective] [--repo <name>] [--context-repo <name> ...]
         [--intent <json>] [--port <ENV_NAME> ...] [--integrate|--no-integrate]
  ws runs [--limit <n>] [--json]
  ws status [--reconcile] [--json]
  ws inspect <run-or-candidate-id> [--json]
  ws integrate <candidate-id> [--json]
  ws cleanup [--json]

Environment:
  WS_DEBUG=1       Print stack traces for failures
`;

function output(value, options, context) {
  printValue(value, { json: options.json, stream: context.stdout });
}

function jsonIntent(value) {
  if (!value) return {};
  try {
    const result = JSON.parse(value);
    if (!result || Array.isArray(result) || typeof result !== 'object') throw new Error();
    return result;
  } catch {
    throw new WorkspaceError('--intent must be a JSON object');
  }
}

function runtime(workspace) {
  const paths = workspacePaths(workspace);
  const store = openStore(workspace);
  const resources = new ProcessResourceProvider({ db: store.db, store, runtimeDir: paths.runtimeDir });
  const git = new GitWorktreeExecutionProvider();
  const agent = new CommandAgentProvider({ processProvider: resources, runtimeDir: paths.runtimeDir });
  const validate = async ({ candidate, worktreePath }) => {
    const runId = candidate.run_id ?? candidate.runId;
    const run = store.getRun(runId);
    if (!run) throw new WorkspaceError(`Run not found for candidate: ${runId}`);
    const profile = loadAgentProfile(workspace, run.profile);
    const commands = profile.validation ?? [];
    const contextPaths = run.context_paths_json ?? [];
    const values = {
      prompt: run.purpose ?? run.objective ?? '',
      instructions: profile.instructions ?? '',
      worktree: worktreePath,
      cwd: worktreePath,
      workspace: workspace.root,
      context: contextPaths.join(process.platform === 'win32' ? ';' : ':'),
      context_paths: contextPaths.join(process.platform === 'win32' ? ';' : ':'),
      run_id: runId,
    };
    const expand = (value) => String(value).replace(
      /\{(prompt|instructions|worktree|cwd|workspace|context|context_paths|run_id)\}/g,
      (_all, key) => values[key] ?? '',
    );
    const evidence = [];
    for (let index = 0; index < commands.length; index += 1) {
      const argv = (Array.isArray(commands[index]) ? commands[index] : tokenizeCommand(commands[index])).map(expand);
      const result = await resources.runProcess({
        runId,
        command: argv[0],
        args: argv.slice(1),
        cwd: worktreePath,
        env: {
          WS_RUN_ID: runId,
          WS_WORKTREE: worktreePath,
          WS_WORKSPACE: workspace.root,
          WS_CONTEXT_PATHS: values.context_paths,
          WS_PROMPT: values.prompt,
          WS_AGENT_INSTRUCTIONS: values.instructions,
          WS_VALIDATION_INDEX: String(index + 1),
        },
        label: `integration-validation-${String(index + 1).padStart(3, '0')}`,
      });
      evidence.push({ command: argv, success: result.success, exitCode: result.exitCode, stdoutLog: result.stdoutLog, stderrLog: result.stderrLog });
      if (!result.success) {
        store.updateCandidate(candidate.id, { validation: { success: false, phase: 'integration', commands: evidence } });
        return false;
      }
    }
    if (commands.length) store.updateCandidate(candidate.id, { validation: { success: true, phase: 'integration', commands: evidence } });
    return true;
  };
  const integrator = new GitIntegrationProvider({ store, validate });
  const knowledge = new FileKnowledgeProvider({ workspaceDir: workspace.workspaceDir });
  const runs = new RunOrchestrator({
    workspace,
    store,
    git,
    agent,
    resources,
    integration: integrator,
    knowledge,
    runtimeDir: paths.runtimeDir,
  });
  return { paths, store, resources, git, agent, integrator, knowledge, runs };
}

function closeRuntime(value) {
  value?.store?.close();
}

async function commandInit(positionals, options, context) {
  rejectUnknown(options, ['name', 'json']);
  const workspace = initWorkspace(positionals[1] ?? context.cwd, { name: options.name });
  if (!(await pathExists(join(workspace.root, '.git')))) {
    await runGit(['init', '--quiet', workspace.root], { cwd: workspace.root });
  }
  const generated = generateWorkspaceAgentFiles(workspace);
  const state = runtime(workspace);
  closeRuntime(state);
  output({ workspace: workspace.root, id: workspace.config.id, config: workspace.configPath, generated }, options, context);
}

async function pathExists(path) {
  try { await access(path); return true; } catch { return false; }
}

function commandGenerate(positionals, options, context) {
  rejectUnknown(options, ['json']);
  if (positionals.length > 1) throw new WorkspaceError('ws generate does not accept positional arguments');
  const workspace = discoverWorkspace(context.cwd);
  const generated = generateWorkspaceAgentFiles(workspace);
  output(generated, options, context);
}

async function commandRepoClone(workspace, positionals, options, context) {
  rejectUnknown(options, ['name', 'role', 'path', 'json']);
  const url = requirePositional(positionals, 2, 'Git repository URL');
  const repository = await cloneRepository(workspace, url, {
    ...(options.name !== undefined ? { name: options.name } : {}),
    ...(options.role !== undefined ? { role: options.role } : {}),
    ...(options.path !== undefined ? { path: options.path } : {}),
  });
  output(repository, options, context);
}

async function commandRepoSync(workspace, positionals, options, context) {
  rejectUnknown(options, ['json']);
  if (positionals.length > 3) throw new WorkspaceError('Only one repository name may be supplied to repo sync');
  const requested = positionals[2];
  const repositories = workspace.config.repositories ?? [];
  let rows;
  if (requested === undefined) {
    rows = await materializeMissingRepositories(workspace);
  } else {
    const repository = repositories.find((entry) => String(entry.name).toLowerCase() === String(requested).toLowerCase());
    if (!repository) throw new WorkspaceError(`Repository not found: ${requested}`);
    const configuredPath = repository.path === undefined || repository.path === null
      ? undefined
      : resolve(workspace.root, repository.path);
    if (configuredPath && await pathExists(configuredPath)) {
      await repositoryRoot(configuredPath);
      rows = [{ ...repository, path: configuredPath, materialized: false }];
    } else {
      rows = [{ ...(await materializeRepository(workspace, repository)), materialized: true }];
    }
  }
  generateWorkspaceAgentFiles(workspace);
  output(rows, options, context);
}

async function commandRepo(positionals, options, context) {
  const action = requirePositional(positionals, 1, 'repo action (add, clone, sync, or list)');
  const workspace = discoverWorkspace(context.cwd);
  if (action === 'add') {
    rejectUnknown(options, ['name', 'role', 'url', 'json']);
    const path = requirePositional(positionals, 2, 'repository path');
    const absolutePath = resolve(context.cwd, path);
    const repository = await addRepository(workspace, absolutePath, {
      name: options.name,
      role: options.role,
      ...(options.url !== undefined ? { url: options.url } : {}),
    });
    generateWorkspaceAgentFiles(workspace);
    output(repository, options, context);
    return;
  }
  if (action === 'clone') {
    return commandRepoClone(workspace, positionals, options, context);
  }
  if (action === 'sync') {
    return commandRepoSync(workspace, positionals, options, context);
  }
  if (action === 'list') {
    rejectUnknown(options, ['json']);
    const rows = [];
    for (const repo of workspace.repositories) {
      let revision;
      try { revision = (await headCommit(repo.path)).slice(0, 12); } catch { revision = 'unborn'; }
      rows.push({ name: repo.name, role: repo.role, revision, path: repo.path, ...(repo.url ? { url: repo.url } : {}) });
    }
    output(rows, options, context);
    return;
  }
  throw new WorkspaceError(`Unknown repo action: ${action}`);
}

function commandDiscover(positionals, options, context) {
  rejectUnknown(options, ['system', 'layer', 'kind', 'json']);
  if (positionals.length > 1) throw new WorkspaceError('ws discover does not accept positional arguments');
  const workspace = discoverWorkspace(context.cwd);
  const rows = discoverResources(workspace, {
    ...(options.system !== undefined ? { system: options.system } : {}),
    ...(options.layer !== undefined ? { layer: options.layer } : {}),
    ...(options.kind !== undefined ? { kind: options.kind } : {}),
  });
  output(rows, options, context);
}

function commandValidate(positionals, options, context) {
  rejectUnknown(options, ['json']);
  if (positionals.length > 1) throw new WorkspaceError('ws validate does not accept positional arguments');
  const workspace = discoverWorkspace(context.cwd);
  const report = validateSystemModel(workspace);
  output({
    valid: report.valid,
    derived: report.derived,
    errors: report.errors,
    warnings: report.warnings,
  }, options, context);
  if (!report.valid) throw new WorkspaceError(`System validation failed with ${report.errors.length} error${report.errors.length === 1 ? '' : 's'}`);
}

function commandAgent(positionals, options, context) {
  const action = requirePositional(positionals, 1, 'agent action (add)');
  if (action !== 'add') throw new WorkspaceError(`Unknown agent action: ${action}`);
  rejectUnknown(options, ['command', 'provider', 'concurrency', 'port', 'json']);
  const workspace = discoverWorkspace(context.cwd);
  const name = requirePositional(positionals, 2, 'agent profile name');
  if (options.concurrency && !['allow', 'forbid'].includes(options.concurrency)) {
    throw new WorkspaceError('--concurrency must be allow or forbid');
  }
  const profile = createAgentProfile(workspace, name, {
    command: options.command,
    provider: options.provider,
    concurrency: options.concurrency,
    ports: options.port,
  });
  output(profile, options, context);
}

async function commandRun(positionals, options, context) {
  rejectUnknown(options, ['repo', 'context-repo', 'intent', 'port', 'integrate', 'no-integrate', 'json']);
  if (options.integrate && options['no-integrate']) {
    throw new WorkspaceError('--integrate and --no-integrate are mutually exclusive');
  }
  const workspace = discoverWorkspace(context.cwd);
  const state = runtime(workspace);
  try {
    const agent = requirePositional(positionals, 1, 'agent profile');
    const objective = positionals.slice(2).join(' ');
    const intent = jsonIntent(options.intent);
    if (options.port?.length) intent.ports = options.port;
    const run = await state.runs.execute({
      profile: agent,
      objective,
      repo: options.repo,
      contextRepos: options['context-repo'],
      intent,
      integrate: options['no-integrate'] ? false : true,
      noIntegrate: Boolean(options['no-integrate']),
    });
    const fresh = state.store.getRun(run.id) ?? run;
    const candidates = state.store.listCandidates({ runId: run.id });
    output({
      run: run.id,
      status: fresh.status,
      primary_repo: fresh.primary_repo,
      candidate: candidates[0]?.id ?? run.candidate?.id ?? '',
      candidate_status: candidates[0]?.status ?? run.candidate?.status ?? '',
    }, options, context);
  } finally {
    closeRuntime(state);
  }
}

function commandRuns(options, context) {
  rejectUnknown(options, ['limit', 'json']);
  const workspace = discoverWorkspace(context.cwd);
  const state = runtime(workspace);
  try {
    const limit = options.limit === undefined ? 30 : Number.parseInt(options.limit, 10);
    if (!Number.isInteger(limit) || limit < 1) throw new WorkspaceError('--limit must be a positive integer');
    const rows = state.store.listRuns({ limit }).map((run) => ({
      run: run.id,
      agent: run.profile,
      primary: run.primary_repo ?? '',
      status: run.status,
      created: run.created_at,
    }));
    output(rows, options, context);
  } finally { closeRuntime(state); }
}

async function declaredRepositoryStatus(repositories) {
  return Promise.all(repositories.map(async (repo) => {
    const base = { name: repo.name, path: repo.path };
    if (!repo.path) return { ...base, state: 'missing', dirty: null, branch: null, head: null };
    try {
      const [branch, head, dirty] = await Promise.all([
        currentBranch(repo.path).catch(() => null),
        headCommit(repo.path).catch(() => null),
        isDirty(repo.path).catch(() => null),
      ]);
      if (!head && !branch) return { ...base, state: 'invalid', dirty: null, branch: null, head: null };
      return { ...base, state: 'present', dirty, branch, head: head ? head.slice(0, 12) : null };
    } catch {
      return { ...base, state: 'invalid', dirty: null, branch: null, head: null };
    }
  }));
}

async function commandStatus(options, context) {
  rejectUnknown(options, ['json', 'reconcile']);
  const workspace = discoverWorkspace(context.cwd);
  const state = runtime(workspace);
  try {
    const stale = options.reconcile ? await state.runs.reconcile() : [];
    const allRuns = state.store.listRuns();
    const activeStatuses = new Set(['CREATED', 'PREPARING', 'RUNNING', 'INTEGRATING']);
    const candidates = state.store.listCandidates();
    const topology = loadSystemModel(workspace);
    const repositoryStatus = await declaredRepositoryStatus(workspace.repositories);
    const result = {
      workspace: workspace.config.name,
      root: workspace.root,
      declared: {
        systems: topology.systems,
        layers: topology.layers,
        resources: topology.resources,
        repositories: topology.repositories,
        derived: topology.derived,
        repository_status: repositoryStatus,
      },
      repositories: workspace.repositories.map((repo) => ({ name: repo.name, role: repo.role, path: repo.path })),
      active_runs: allRuns.filter((run) => activeStatuses.has(run.status)),
      pending_candidates: candidates.filter((candidate) => ['PENDING', 'INTEGRATION_FAILED'].includes(candidate.status)),
      active_resources: state.store.listResources({ active: true }),
      reconciled_orphans: stale,
    };
    output(result, options, context);
  } finally { closeRuntime(state); }
}

function inspectRecord(state, identifier) {
  const candidate = state.store.getCandidate(identifier);
  const run = candidate ? state.store.getRun(candidate.run_id) : state.store.getRun(identifier);
  if (!run) throw new WorkspaceError(`Run or candidate not found: ${identifier}`);
  const candidates = candidate ? [candidate] : state.store.listCandidates({ runId: run.id });
  return {
    run,
    repositories: state.store.listRunRepositories(run.id),
    processes: state.store.listProcesses({ runId: run.id }),
    resources: state.store.listResources({ runId: run.id }),
    events: state.store.listEvents({ runId: run.id }),
    candidates,
  };
}

function commandInspect(positionals, options, context) {
  rejectUnknown(options, ['json']);
  const id = requirePositional(positionals, 1, 'run or candidate ID');
  const state = runtime(discoverWorkspace(context.cwd));
  try { output(inspectRecord(state, id), options, context); }
  finally { closeRuntime(state); }
}

async function commandIntegrate(positionals, options, context) {
  rejectUnknown(options, ['json']);
  const id = requirePositional(positionals, 1, 'candidate ID');
  const state = runtime(discoverWorkspace(context.cwd));
  try {
    const candidate = state.store.getCandidate(id);
    if (!candidate) throw new WorkspaceError(`Candidate not found: ${id}`);
    if (candidate.status === 'INTEGRATED') {
      output(candidate, options, context);
      return;
    }
    const metadata = candidate.metadata_json ?? {};
    const run = state.store.getRun(candidate.run_id);
    if (!run) throw new WorkspaceError(`Run not found for candidate ${id}: ${candidate.run_id}`);
    state.store.recoverIntegrationLock();
    state.store.updateCandidate(id, { status: 'INTEGRATING' });
    state.store.updateRunStatus(run.id, 'INTEGRATING');
    try {
      const integrated = await state.integrator.integrate({
        candidate,
        repoPath: candidate.repo_path ?? metadata.repoPath,
        worktreePath: candidate.worktree_path ?? metadata.worktreePath,
        branch: candidate.branch ?? metadata.branch,
        targetBranch: candidate.target_branch ?? metadata.targetBranch,
      });
      const updated = state.store.updateCandidate(id, {
        status: 'INTEGRATED',
        resultCommit: integrated.resultCommit,
        integratedAt: new Date().toISOString(),
        metadata: {
          ...metadata,
          repoPath: integrated.repoPath,
          worktreePath: integrated.worktreePath,
          branch: integrated.branch,
          targetBranch: integrated.targetBranch,
          resultCommit: integrated.resultCommit,
        },
      });
      state.store.updateRunStatus(run.id, 'COMPLETED', { finishedAt: new Date().toISOString() });
      state.store.recordEvent({ runId: run.id, type: 'integration.completed', payload: { candidate: id, resultCommit: integrated.resultCommit } });
      await state.resources.releaseRunResources(run.id);
      await state.knowledge.recordDurableRun(state.store.getRun(run.id), updated);
      output(updated, options, context);
    } catch (error) {
      state.store.updateCandidate(id, { status: 'INTEGRATION_FAILED' });
      state.store.updateRunStatus(run.id, 'INTEGRATION_FAILED', { error: error.message });
      state.store.recordEvent({ runId: run.id, type: 'integration.failed', payload: { candidate: id, error: error.message } });
      await state.resources.releaseRunResources(run.id);
      throw error;
    }
  } finally { closeRuntime(state); }
}

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

async function commandCleanup(options, context) {
  rejectUnknown(options, ['json']);
  const state = runtime(discoverWorkspace(context.cwd));
  try {
    const orphaned = await state.runs.reconcile();
    const removed = [];
    const preserved = [];
    const candidates = state.store.listCandidates();
    for (const candidate of candidates) {
      const metadata = candidate.metadata_json ?? {};
      const worktreePath = candidate.worktree_path ?? metadata.worktreePath;
      const repoPath = candidate.repo_path ?? metadata.repoPath;
      if (candidate.status !== 'INTEGRATED') {
        if (worktreePath) preserved.push({ candidate: candidate.id, worktree: worktreePath, reason: 'unintegrated' });
        continue;
      }
      if (!worktreePath || !repoPath || !(await exists(worktreePath))) continue;
      try {
        await removeWorktree({ repoPath, worktreePath, allowRemoval: true });
        removed.push({ candidate: candidate.id, worktree: worktreePath });
      } catch (error) {
        preserved.push({ candidate: candidate.id, worktree: worktreePath, reason: error.message });
      }
    }
    const candidateWorktrees = new Set(candidates.map((candidate) => candidate.worktree_path ?? candidate.metadata?.worktreePath).filter(Boolean));
    for (const run of state.store.listRuns()) {
      if (['CREATED', 'PREPARING', 'RUNNING', 'INTEGRATING'].includes(run.status)) continue;
      for (const repository of state.store.listRunRepositories(run.id)) {
        const path = repository.worktree_path;
        if (!path || candidateWorktrees.has(path) || !(await exists(path))) continue;
        if (repository.context) {
          if (await isDirty(path)) {
            preserved.push({ run: run.id, worktree: path, reason: 'context-only worktree was modified' });
            continue;
          }
          try {
            await removeWorktree({ repoPath: repository.path, worktreePath: path, allowRemoval: true });
            removed.push({ run: run.id, worktree: path, kind: 'context' });
          } catch (error) {
            preserved.push({ run: run.id, worktree: path, reason: error.message });
          }
        } else {
          preserved.push({ run: run.id, worktree: path, reason: 'no integrated Candidate owns this worktree' });
        }
      }
      const workspaceContextPath = join(state.paths.runtimeDir, 'worktrees', run.id, 'workspace-context');
      if (run.context_paths_json?.includes(workspaceContextPath) && await exists(workspaceContextPath)) {
        await rm(workspaceContextPath, { recursive: true });
        removed.push({ run: run.id, worktree: workspaceContextPath, kind: 'workspace-context' });
      }
    }
    output({ orphaned, removed, preserved }, options, context);
  } finally { closeRuntime(state); }
}

export async function main(argv = [], suppliedContext: any = {}) {
  const context = {
    cwd: suppliedContext.cwd ?? process.cwd(),
    stdout: suppliedContext.stdout ?? process.stdout,
  };
  const { positionals, options } = parseArgs(argv);
  if (options.version) {
    rejectUnknown(options, ['version']);
    context.stdout.write(`${VERSION}\n`);
    return;
  }
  const command = positionals[0];
  if (!command || options.help) {
    context.stdout.write(HELP);
    return;
  }
  switch (command) {
    case 'init': return commandInit(positionals, options, context);
    case 'repo': return commandRepo(positionals, options, context);
    case 'discover': return commandDiscover(positionals, options, context);
    case 'validate': return commandValidate(positionals, options, context);
    case 'generate': return commandGenerate(positionals, options, context);
    case 'agent': return commandAgent(positionals, options, context);
    case 'run': return commandRun(positionals, options, context);
    case 'runs': return commandRuns(options, context);
    case 'status': return commandStatus(options, context);
    case 'inspect': return commandInspect(positionals, options, context);
    case 'integrate': return commandIntegrate(positionals, options, context);
    case 'cleanup': return commandCleanup(options, context);
    default: throw new WorkspaceError(`Unknown command: ${command}\n\n${HELP}`);
  }
}
