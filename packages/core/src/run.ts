import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve, basename } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { RUN_STATUSES } from './constants.js';
import { WorkspaceError, invariant } from './errors.js';
import { isAlive } from './providers/process.js';
import { currentBranch } from './git.js';
import { renderCompositionContext, verifyCompositionContext } from './composition-context.js';

const execFileAsync: any = promisify(execFile);
const ACTIVE = new Set(['CREATED', 'PREPARING', 'RUNNING', 'INTEGRATING']);
const TRANSITIONS = Object.freeze({
  CREATED: new Set(['PREPARING', 'CANCELLED', 'FAILED']),
  PREPARING: new Set(['RUNNING', 'FAILED', 'CANCELLED', 'ORPHANED']),
  RUNNING: new Set(['CANDIDATE', 'FAILED', 'CANCELLED', 'ORPHANED']),
  CANDIDATE: new Set(['INTEGRATING', 'COMPLETED', 'INTEGRATION_FAILED', 'FAILED']),
  INTEGRATING: new Set(['COMPLETED', 'INTEGRATION_FAILED', 'FAILED', 'ORPHANED']),
  COMPLETED: new Set(),
  FAILED: new Set(),
  CANCELLED: new Set(),
  ORPHANED: new Set(['CANDIDATE', 'FAILED', 'CANCELLED']),
  INTEGRATION_FAILED: new Set(['INTEGRATING', 'COMPLETED']),
});

function id() {
  return `R-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${randomUUID().slice(0, 8)}`;
}

async function invoke(target, names, ...args) {
  if (!target) return undefined;
  for (const name of names) {
    if (typeof target[name] === 'function') return target[name](...args);
  }
  return undefined;
}

function asRepoList(workspace, store) {
  const repos = workspace?.repos ?? workspace?.repositories ?? workspace?.config?.repositories ?? store?.repositories ?? [];
  if (Array.isArray(repos)) return repos;
  return Object.entries(repos).map(([name, value]) => ({ name, ...(value as any) }));
}

function repoName(repo) {
  return repo.name ?? repo.id ?? basename(repo.path);
}

async function gitExec(args, cwd) {
  const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 4 * 1024 * 1024 });
  return stdout.trim();
}

async function hashDirectory(directory) {
  const hash = createHash('sha256');
  async function walk(current, prefix = '') {
    let entries;
    try { entries = await readdir(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = join(prefix, entry.name);
      const path = join(current, entry.name);
      if (entry.isDirectory()) await walk(path, relative);
      else if (entry.isFile()) {
        hash.update(relative);
        hash.update(await readFile(path));
      }
    }
  }
  await walk(directory);
  return hash.digest('hex');
}

/**
 * Coordinates one bounded run. All collaborators are injected to keep the
 * domain independent of a particular SQLite, Git, or agent implementation.
 */
export class RunOrchestrator {
  [key: string]: any;
  constructor({ workspace, store, git, gitProvider, agent, agentProvider, resources, resourceProvider, integration, integrationProvider, knowledge, knowledgeProvider, profileResolver, runtimeDir = null, now = () => new Date().toISOString() } : any = {}) {
    this.workspace = workspace;
    this.store = store;
    this.git = git ?? gitProvider;
    this.agent = agent ?? agentProvider;
    this.resources = resources ?? resourceProvider;
    this.integration = integration ?? integrationProvider;
    this.knowledge = knowledge ?? knowledgeProvider;
    this.profileResolver = profileResolver;
    this.runtimeDir = runtimeDir ?? (workspace?.workspaceDir ? join(workspace.workspaceDir, 'runtime') : '.workspace/runtime');
    this.now = now;
  }

  async #storeRun(run) {
    const result = await invoke(this.store, ['createRun', 'insertRun', 'saveRun'], run);
    return result ? { ...run, ...result } : run;
  }

  async #update(run, patch) {
    Object.assign(run, patch);
    await invoke(this.store, ['updateRun', 'saveRun'], run.id, patch, run);
    return run;
  }

  async #event(run, type, payload: any = {}) {
    const event = { runId: run.id, type, payload, at: this.now() };
    await invoke(this.store, ['recordEvent', 'addEvent', 'appendEvent'], event);
    return event;
  }

  async #transition(run, next, extra: any = {}) {
    const current = run.status;
    invariant(RUN_STATUSES.includes(next), `Unknown Run status: ${next}`);
    if (current !== next && !TRANSITIONS[current]?.has(next)) {
      throw new WorkspaceError(`Illegal Run transition ${current} -> ${next}`);
    }
    await this.#update(run, { ...extra, status: next, updatedAt: this.now() });
    await this.#event(run, `run.${next.toLowerCase()}`, extra);
    return run;
  }

  async #profile(name) {
    if (this.profileResolver) return this.profileResolver(name);
    const profile = await invoke(this.workspace, ['getAgent', 'getAgentProfile'], name)
      ?? await invoke(this.store, ['getAgent', 'getAgentProfile'], name);
    if (profile) return profile;
    const profiles = this.workspace?.agents ?? this.workspace?.agentProfiles ?? {};
    const value = Array.isArray(profiles) ? profiles.find((item) => (item.name ?? item.id) === name) : profiles[name];
    if (!value) throw new WorkspaceError(`Unknown agent profile: ${name}`);
    return { name, ...value };
  }

  async #runs() {
    return (await invoke(this.store, ['listRuns', 'getRuns'])) ?? [];
  }

  async #assertConcurrency(profile) {
    if (profile.concurrency !== 'forbid') return;
    const active = (await this.#runs()).filter((run) => run.profile === profile.name && ACTIVE.has(run.status));
    if (active.length) throw new WorkspaceError(`Agent profile ${profile.name} forbids concurrent runs (${active.map((run) => run.id).join(', ')})`);
  }

  async #head(path) {
    return await invoke(this.git, ['head', 'getHead', 'revParse'], path) ?? gitExec(['rev-parse', 'HEAD'], path);
  }

  async #branch(path) {
    const explicit = await invoke(this.git, ['currentBranch', 'branch'], path);
    if (explicit !== undefined) return explicit;
    try { return await currentBranch(path); } catch { return null; }
  }

  async #dirty(path) {
    try {
      const status = await gitExec(['status', '--porcelain', '--untracked-files=all'], path);
      return status.split('\n').filter(Boolean).some((line) => !this.#isPromotedKnowledgePath(line));
    } catch {
      const explicit = await invoke(this.git, ['isDirty', 'dirty'], path);
      return explicit === undefined ? false : Boolean(explicit);
    }
  }

  async #workspaceOnlyDirty(path) {
    try {
      const status = await gitExec(['status', '--porcelain', '--untracked-files=all'], path);
      const rows = status.split('\n').filter(Boolean);
      return rows.length > 0 && rows.every((line) => this.#isPromotedKnowledgePath(line));
    } catch {
      return false;
    }
  }

  #isPromotedKnowledgePath(statusLine) {
    const path = statusLine.slice(3).replace(/^"|"$/g, '');
    return path.startsWith('.workspace/history/compositions/') || path.startsWith('.workspace/history/runs/') || path.startsWith('.workspace/proposals/');
  }

  async #snapshot(repos, selectedContext?) {
    const snapshot = [];
    for (const repo of repos) {
      const path = resolve(this.workspace?.root ?? process.cwd(), repo.path);
      const [commit, branch] = await Promise.all([this.#head(path), this.#branch(path)]);
      snapshot.push({ name: repoName(repo), path, commit, branch, role: repo.role, context: repo.context !== false });
    }
    const contextDir = this.workspace?.workspaceDir ? join(this.workspace.workspaceDir, 'context') : null;
    const contextHash = selectedContext ? selectedContext.sha256 : contextDir ? await hashDirectory(contextDir) : null;
    return {
      at: this.now(),
      context: {
        revision: this.workspace?.config?.context?.revision ?? null,
        sha256: contextHash,
      },
      repos: snapshot,
    };
  }

  async #materializeWorkspaceContext(run) {
    if (!this.workspace?.workspaceDir) return null;
    const source = join(this.workspace.workspaceDir, 'context');
    try {
      if (!(await stat(source)).isDirectory()) return null;
    } catch { return null; }
    const target = join(this.runtimeDir, 'worktrees', run.id, 'workspace-context');
    await cp(source, target, { recursive: true, force: false, errorOnExist: true });
    return target;
  }

  async #worktree({ run, repo, baseCommit, allowDirtyCanonical = false }) {
    const worktreePath = join(this.runtimeDir, 'worktrees', run.id, repoName(repo));
    await mkdir(join(this.runtimeDir, 'worktrees', run.id), { recursive: true });
    const branch = `ws/run/${run.id}`;
    const result = await invoke(this.git, ['createWorktree', 'addWorktree'], {
      repoPath: resolve(this.workspace?.root ?? process.cwd(), repo.path), path: worktreePath, worktreePath,
      branch, branchName: branch, baseCommit, baseRef: baseCommit, runId: run.id, allowDirtyCanonical,
    });
    if (result) return { path: result.path ?? result.worktreePath ?? worktreePath, branch: result.branch ?? branch };
    await execFileAsync('git', ['worktree', 'add', '-b', branch, worktreePath, baseCommit], { cwd: resolve(repo.path) });
    return { path: worktreePath, branch };
  }

  async #contextWorktree({ run, repo, baseCommit }) {
    const worktreePath = join(this.runtimeDir, 'worktrees', run.id, `context-${repoName(repo)}`);
    const result = await invoke(this.git, ['createContextWorktree'], {
      repoPath: resolve(this.workspace?.root ?? process.cwd(), repo.path),
      worktreePath,
      runId: run.id,
      baseCommit,
    });
    return result?.worktreePath ?? result?.path ?? resolve(this.workspace?.root ?? process.cwd(), repo.path);
  }

  async #commitCandidate(run, repo, worktree, baseCommit) {
    const result = await invoke(this.git, ['finalizeCandidate', 'commitWorktree', 'createCandidate'], {
      runId: run.id, repo, repoName: repoName(repo), repoPath: resolve(this.workspace?.root ?? process.cwd(), repo.path),
      worktreePath: worktree.path, baseCommit, branch: worktree.branch, candidateId: `C-${run.id}`,
      message: `Run ${run.id}: ${run.objective}`,
    });
    if (result) return { ...result, baseCommit, repo: repoName(repo), repoName: repoName(repo), worktreePath: worktree.path, branch: result.branch ?? worktree.branch };
    if (!(await this.#dirty(worktree.path))) return { baseCommit, resultCommit: baseCommit, repo: repoName(repo), repoName: repoName(repo), worktreePath: worktree.path, branch: worktree.branch, changed: false };
    await execFileAsync('git', ['add', '-A'], { cwd: worktree.path });
    await execFileAsync('git', ['-c', 'user.name=Workspace Agent', '-c', 'user.email=workspace-agent@localhost', 'commit', '-m', `Run ${run.id}: ${run.objective}`], { cwd: worktree.path });
    const resultCommit = await this.#head(worktree.path);
    return { baseCommit, resultCommit, repo: repoName(repo), repoName: repoName(repo), worktreePath: worktree.path, branch: worktree.branch, changed: true };
  }

  async execute({ profile: profileName, agent: agentName, prompt, objective, primaryRepo, repo, contextRepos, contextRepo, intent = {}, integrate = true, noIntegrate = false, env = {}, runId, onCreated, resolvedContext } : any = {}) {
    const name = profileName ?? agentName;
    if (!name) throw new WorkspaceError('An agent profile is required');
    const profile = { ...(await this.#profile(name)) };
    profile.name ??= name;
    await this.#assertConcurrency(profile);
    const repos = asRepoList(this.workspace, this.store);
    if (!repos.length) throw new WorkspaceError('Workspace has no repositories');
    const mutationScope = profile.mutation_scope?.repositories;
    const scopedPrimary = Array.isArray(mutationScope)
      ? mutationScope[0]
      : (mutationScope && !['primary', 'all'].includes(mutationScope) ? mutationScope : undefined);
    const primarySelector = primaryRepo ?? repo ?? scopedPrimary;
    const primary = primarySelector
      ? repos.find((item) => repoName(item) === primarySelector || item.path === primarySelector)
      : (repos.find((item) => item.role === 'primary') ?? repos[0]);
    if (!primary) throw new WorkspaceError(`Primary repository not found: ${primarySelector}`);
    const primaryByRole = repos.find((item) => item.role === 'primary') ?? repos[0];
    const mutationAllowed = mutationScope === undefined || mutationScope === 'all'
      || (mutationScope === 'primary' ? primary === primaryByRole
        : Array.isArray(mutationScope) ? mutationScope.includes(repoName(primary)) : mutationScope === repoName(primary));
    invariant(mutationAllowed, `Profile ${name} mutation scope does not allow ${repoName(primary)}`);
    const profileContext = profile.context_scope?.repositories;
    const selectedContext = contextRepos ?? contextRepo
      ?? (profileContext === 'all' ? undefined : profileContext);
    if (selectedContext && selectedContext !== 'none') {
      const requested = Array.isArray(selectedContext) ? selectedContext : [selectedContext];
      const missing = requested.filter((name) => !repos.some((item) => repoName(item) === name));
      if (missing.length) throw new WorkspaceError(`Context repository not found: ${missing.join(', ')}`);
    }
    const context = selectedContext === 'none'
      ? []
      : selectedContext
        ? repos.filter((item) => (Array.isArray(selectedContext) ? selectedContext : [selectedContext]).includes(repoName(item)))
        : repos.filter((item) => item !== primary && item.context !== false);
    const contextOnly = context.filter((item) => item !== primary);
    if (profileContext && profileContext !== 'all') {
      const permitted = profileContext === 'none' ? [] : Array.isArray(profileContext) ? profileContext : [profileContext];
      invariant(contextOnly.every((item) => permitted.includes(repoName(item))), `Profile ${name} context scope does not allow selected repositories`);
    }
    intent = { ...intent };
    delete intent.execution_result; // reserved for verified provider evidence
    if (!resolvedContext) delete intent.resolved_context;
    if (runId !== undefined) invariant(/^R-[a-zA-Z0-9_-]+$/.test(runId), 'Invalid Run ID');
    if (resolvedContext) {
      invariant(resolvedContext.grants?.write === true && resolvedContext.grants?.start_agent === true && resolvedContext.grants?.read?.includes('source') && resolvedContext.access === 'read-write', 'Composition context lacks dispatch grants');
      invariant(resolvedContext.repository === repoName(primary) && resolvedContext.workspace_id === this.workspace.config.id, 'Composition context targets a different workspace/repository');
      verifyCompositionContext(resolvedContext);
      profile.instructions = [renderCompositionContext(resolvedContext), profile.instructions ?? ''].filter(Boolean).join('\n\nAgent profile instructions:\n');
      intent = { ...intent, resolved_context: { ...resolvedContext,
        sources: resolvedContext.sources.map(({ content, ...source }) => source) } };
    }
    const run = await this.#storeRun({
      id: runId ?? id(), profile: profile.name, objective: objective ?? prompt ?? '', prompt: prompt ?? objective ?? '', status: 'CREATED',
      primaryRepo: repoName(primary), contextRepos: contextOnly.map(repoName), intent: { ...intent, execution_owner: { pid: process.pid } }, createdAt: this.now(), updatedAt: this.now(),
    });
    let profileLease = false;
    let worktree;
    let candidate;
    try {
      await onCreated?.(run);
      if (profile.concurrency === 'forbid') {
        profileLease = Boolean(await invoke(this.store, ['acquireProfileLease'], profile.name, run.id));
      }
      await this.#transition(run, 'PREPARING');
      const snapshot = await this.#snapshot([primary, ...contextOnly], resolvedContext);
      await this.#update(run, { snapshot });
      await this.#event(run, 'run.snapshot', snapshot);
      const primarySnap = snapshot.repos.find((item) => item.name === repoName(primary));
      const primaryPath = resolve(this.workspace?.root ?? process.cwd(), primary.path);
      if (await this.#dirty(primaryPath)) throw new WorkspaceError(`Primary repository ${repoName(primary)} has uncommitted changes`);
      for (const item of snapshot.repos) {
        await invoke(this.store, ['addRunRepository', 'saveRunRepository'], run.id, {
          repoName: item.name, name: item.name, path: item.path, role: item.role,
          mutation: item.name === repoName(primary), context: item.name !== repoName(primary), baseCommit: item.commit,
        });
      }
      worktree = await this.#worktree({ run, repo: primary, baseCommit: primarySnap.commit, allowDirtyCanonical: await this.#workspaceOnlyDirty(primaryPath) });
      // Composition already supplies selected shared context; do not copy unselected files or private data.
      const workspaceContextPath = resolvedContext ? null : await this.#materializeWorkspaceContext(run);
      const contextMaterializations = [];
      for (const item of contextOnly) {
        const itemSnapshot = snapshot.repos.find((entry) => entry.name === repoName(item));
        const contextPath = await this.#contextWorktree({ run, repo: item, baseCommit: itemSnapshot.commit });
        contextMaterializations.push({ repo: item, path: contextPath });
        await invoke(this.store, ['addRunRepository', 'saveRunRepository'], run.id, {
          repoName: repoName(item), name: repoName(item), path: itemSnapshot.path, role: item.role,
          mutation: false, context: true, baseCommit: itemSnapshot.commit, worktreePath: contextPath,
        });
      }
      const contextPaths = [workspaceContextPath, ...contextMaterializations.map((item) => item.path)].filter(Boolean);
      await this.#update(run, { worktree: worktree.path, branch: worktree.branch, contextPaths });
      await invoke(this.store, ['addRunRepository', 'saveRunRepository'], run.id, {
        repoName: repoName(primary), name: repoName(primary), path: primarySnap.path, role: primary.role,
        mutation: true, context: false, baseCommit: primarySnap.commit, worktreePath: worktree.path,
      });
      const allocations = [];
      const requestedPorts = [
        ...(profile.ports ?? profile.resources?.ports ?? []),
        ...(intent.ports ?? []),
      ];
      const allocatedNames = new Set();
      for (const item of requestedPorts) {
        const spec = typeof item === 'string' ? { name: item } : item;
        if (allocatedNames.has(spec.name)) continue;
        allocatedNames.add(spec.name);
        allocations.push(await this.resources.allocatePort({ runId: run.id, ...spec }));
      }
      const runEnv = Object.fromEntries(allocations.map((item) => [item.name, String(item.port)]));
      await this.#update(run, { resources: allocations, environment: runEnv });
      await this.#event(run, 'run.intent', { ...intent, primaryRepo: repoName(primary), writeScope: intent.writeScope ?? [repoName(primary)], contextRepos: contextOnly.map(repoName) });
      if (resolvedContext) verifyCompositionContext(resolvedContext);
      await this.#transition(run, 'RUNNING');
      if (!this.agent?.run) throw new WorkspaceError('No agent provider configured');
      const result = await this.agent.run({
        profile,
        run,
        prompt: run.prompt,
        worktreePath: worktree.path,
        workspacePath: this.workspace?.root,
        contextPaths,
        env: { ...runEnv, ...env },
      });
      await this.#update(run, { intent: { ...run.intent, execution_result: {
        success: Boolean(result.success), exit_code: result.exitCode ?? null, logs: result.logs ?? null, validation: result.validation ?? null,
      } } });
      if (result.validation) await this.#event(run, 'run.validation', result.validation);
      const persisted = await invoke(this.store, ['getRun', 'findRun'], run.id);
      if (persisted?.status === 'CANCELLED') { run.status = 'CANCELLED'; throw new WorkspaceError('Run was cancelled'); }
      if (!result.success) {
        const detail = result.error?.message
          ?? (result.exitCode == null ? 'unknown process error' : `exit code ${result.exitCode}`);
        throw new WorkspaceError(`Agent process failed: ${detail}`);
      }
      for (const item of contextMaterializations) {
        const dirty = await invoke(this.git, ['isDirty', 'dirty'], item.path);
        if (dirty) throw new WorkspaceError(`Agent modified context-only repository ${repoName(item.repo)}; isolated worktree preserved`);
      }
      candidate = await this.#commitCandidate(run, primary, worktree, primarySnap.commit);
      candidate.runId = run.id;
      candidate.status = 'PENDING';
      candidate.validation = result.validation ?? null;
      candidate.targetBranch = primarySnap.branch;
      candidate.metadata = { repoPath: primaryPath, worktreePath: worktree.path, branch: worktree.branch, targetBranch: primarySnap.branch };
      const stored = await invoke(this.store, ['createCandidate', 'insertCandidate', 'saveCandidate'], candidate);
      if (stored) candidate = { ...candidate, ...stored };
      await this.#update(run, { candidateId: candidate.id, candidate });
      await this.#transition(run, 'CANDIDATE');
      if (integrate && !noIntegrate && this.integration?.integrate) {
        await invoke(this.store, ['recoverIntegrationLock']);
        await this.#transition(run, 'INTEGRATING');
        const integrated = await this.integration.integrate({ candidate, run, repoPath: primaryPath, worktreePath: worktree.path, branch: candidate.branch, targetBranch: candidate.targetBranch });
        const validatedCandidate = await invoke(this.store, ['getCandidate', 'findCandidate'], candidate.id);
        candidate = {
          ...candidate,
          ...integrated,
          validation: validatedCandidate?.validation ?? validatedCandidate?.validation_json ?? candidate.validation,
          status: integrated?.status ?? 'INTEGRATED',
        };
        await invoke(this.store, ['updateCandidate', 'saveCandidate'], candidate.id, candidate, candidate);
        await this.#transition(run, 'COMPLETED', { candidate, finishedAt: this.now() });
        await this.resources?.releaseRunResources?.(run.id);

      } else {
        await this.resources?.releaseRunResources?.(run.id);
      }
      return run;
    } catch (error) {
      const status = run.status === 'CANDIDATE' || run.status === 'INTEGRATING' ? 'INTEGRATION_FAILED' : 'FAILED';
      if (status === 'INTEGRATION_FAILED' && candidate?.id) {
        candidate.status = 'INTEGRATION_FAILED';
        candidate.metadata = { ...candidate.metadata, integrationError: error.message };
        await invoke(this.store, ['updateCandidate', 'saveCandidate'], candidate.id, candidate, candidate);
      }
      if (run.status !== status && TRANSITIONS[run.status]?.has(status)) await this.#transition(run, status, { error: error.message, candidate });
      else await this.#update(run, { error: error.message });
      // Deliberately do not remove the worktree: an unintegrated result is user data.
      await this.resources?.releaseRunResources?.(run.id);
      throw error;
    } finally {
      if (profileLease) await invoke(this.store, ['releaseProfileLease'], profile.name, run.id);
      await this.#update(run, { finishedAt: this.now() });
      await invoke(this.knowledge, ['recordDurableRun'], run, candidate);
    }
  }

  async reconcile() {
    const staleRuns = await this.resources?.reconcile?.() ?? [];
    // A dispatcher can disappear before it launches any child process. Do not
    // mistake an agent that outlived its dispatcher for an abandoned attempt.
    for (const run of await this.#runs()) {
      const pid = run.intent?.execution_owner?.pid;
      if (!ACTIVE.has(run.status) || !pid || isAlive(pid)) continue;
      const processes = await invoke(this.store, ['listProcesses'], { runId: run.id }) ?? [];
      if (processes.some((item) => isAlive(item.pid))) continue;
      if (!staleRuns.includes(run.id)) staleRuns.push(run.id);
    }
    for (const runId of staleRuns) {
      const run = await invoke(this.store, ['getRun', 'findRun'], runId);
      if (run && ACTIVE.has(run.status)) {
        await this.#transition(run, 'ORPHANED', { error: 'Owned process disappeared', finishedAt: this.now() });
        await this.resources?.releaseRunResources?.(runId);
        await invoke(this.knowledge, ['recordDurableRun'], run, run.candidate);
      }
    }
    return staleRuns;
  }

  async cancel(runId) {
    const run = await invoke(this.store, ['getRun', 'findRun'], runId);
    if (!run) throw new WorkspaceError(`Run not found: ${runId}`);
    if (TRANSITIONS[run.status]?.has('CANCELLED')) await this.#transition(run, 'CANCELLED', { finishedAt: this.now() });
    await this.agent?.stop?.(runId);
    await this.resources?.releaseRunResources?.(runId);
    await invoke(this.knowledge, ['recordDurableRun'], run, run.candidate);
    return run;
  }
}

export { TRANSITIONS };
