import {
  assertGitRepository,
  currentBranch,
  headCommit,
  isDirty,
  runGit,
  statusPorcelain,
} from '../git.js';
import { WorkspaceError } from '../errors.js';
import { randomUUID } from 'node:crypto';

export class IntegrationError extends WorkspaceError {
  [key: string]: any;
  constructor(message, { phase, preserved = true, candidate, cause } : any = {}) {
    super(message, { cause });
    this.name = 'IntegrationError';
    this.phase = phase;
    this.preserved = preserved;
    this.candidate = candidate;
  }
}

function required(value, name, fallback = undefined) {
  if (typeof value !== 'string' || value.length === 0) throw new WorkspaceError(`${name} is required`);
  if (value.startsWith('-') || value.includes('\0')) throw new WorkspaceError(`Invalid ${name}`);
  return value;
}

/**
 * Execute `fn` under the caller's operational store lock. A lock is required:
 * integration mutates canonical history and must not race another integrator.
 * The preferred store contract is `store.withLock(key, fn)`; an acquire/release
 * pair is accepted for small stores that do not expose the convenience method.
 */
export async function withIntegrationLock(store, key, fn) {
  if (!store) throw new WorkspaceError('An operational store lock is required for integration');
  if (typeof store.withLock === 'function') return store.withLock(key, fn);
  if (typeof store.acquireLock === 'function') {
    const release = await store.acquireLock(key);
    try {
      return await fn();
    } finally {
      if (typeof release === 'function') await release();
      else if (typeof store.releaseLock === 'function') await store.releaseLock(key);
    }
  }
  // OperationalStore's concrete API names the lock specifically because it
  // also owns other runtime resources. Keep this adapter here so the provider
  // remains usable with both the public store and small test doubles.
  if (typeof store.acquireIntegrationLock === 'function') {
    const owner = `integration-${randomUUID()}`;
    const acquired = await store.acquireIntegrationLock(owner);
    try {
      return await fn();
    } finally {
      if (typeof store.releaseIntegrationLock === 'function') {
        await store.releaseIntegrationLock(acquired?.owner ?? owner);
      }
    }
  }
  if (typeof store === 'function') return store(key, fn);
  throw new WorkspaceError('Operational store does not provide withLock or acquireLock/releaseLock');
}

function candidateValue(candidate, key, fallback = undefined) {
  return candidate?.[key] ?? fallback;
}

async function hasUnsafeCanonicalChanges(repoPath) {
  const rows = (await statusPorcelain(repoPath)).split('\n').filter(Boolean);
  return rows.some((line) => {
    const path = line.slice(3).replace(/^"|"$/g, '');
    return !path.startsWith('.workspace/history/compositions/') && !path.startsWith('.workspace/history/runs/') && !path.startsWith('.workspace/proposals/');
  });
}

/**
 * Integrate a finalized Candidate while holding a per-repository store lock.
 * Rebase and merge deliberately occur in separate working trees: the
 * candidate worktree is allowed to enter a conflict state and is left there
 * for inspection if anything fails. No abort, reset, or cleanup is attempted.
 */
export async function integrateCandidate({
  candidate,
  repoPath,
  worktreePath,
  branch,
  targetBranch,
  store,
  validate,
} : any = {}) {
  const candidateRecord = candidate ?? {};
  const canonical = await assertGitRepository(repoPath ?? candidateValue(candidateRecord, 'repoPath'));
  const candidateWorktree = await assertGitRepository(
    worktreePath ?? candidateValue(candidateRecord, 'worktreePath'),
  );
  const requestedTarget = targetBranch ?? candidateValue(candidateRecord, 'targetBranch');
  const candidateBranch = branch ?? candidateValue(candidateRecord, 'branch');
  const lockKey = `integration:${canonical}`;

  return withIntegrationLock(store, lockKey, async () => {
    if (await hasUnsafeCanonicalChanges(canonical)) {
      throw new IntegrationError(`Canonical checkout is dirty: ${canonical}`, {
        phase: 'preflight',
        candidate: candidateRecord,
      });
    }
    const actualTarget = await currentBranch(canonical);
    const target = required(requestedTarget ?? actualTarget, 'targetBranch');
    if (actualTarget !== target) {
      throw new IntegrationError(
        `Canonical checkout is on ${actualTarget ?? 'detached HEAD'}, expected ${target}`,
        { phase: 'preflight', candidate: candidateRecord },
      );
    }

    const actualCandidate = await currentBranch(candidateWorktree);
    const source = required(candidateBranch ?? actualCandidate, 'candidate branch');
    if (actualCandidate !== source) {
      throw new IntegrationError(
        `Candidate worktree is on ${actualCandidate ?? 'detached HEAD'}, expected ${source}`,
        { phase: 'preflight', candidate: candidateRecord },
      );
    }
    if (canonical === candidateWorktree) {
      throw new IntegrationError('Candidate worktree must be separate from canonical checkout', {
        phase: 'preflight',
        candidate: candidateRecord,
      });
    }
    if (await isDirty(candidateWorktree)) {
      throw new IntegrationError(`Candidate worktree is dirty; finalize it before integration: ${candidateWorktree}`, {
        phase: 'preflight',
        candidate: candidateRecord,
      });
    }

    try {
      await runGit(['rebase', target], { cwd: candidateWorktree });
    } catch (cause) {
      throw new IntegrationError(`Candidate rebase failed; worktree preserved: ${candidateWorktree}`, {
        phase: 'rebase',
        candidate: candidateRecord,
        cause,
      });
    }

    if (validate) {
      try {
        const validationResult = await validate({
          candidate: candidateRecord,
          repoPath: canonical,
          worktreePath: candidateWorktree,
          branch: source,
          targetBranch: target,
        });
        if (validationResult === false) throw new Error('Validation returned false');
      } catch (cause) {
        throw new IntegrationError(`Candidate validation failed: ${cause.message}; worktree preserved: ${candidateWorktree}`, {
          phase: 'validation',
          candidate: candidateRecord,
          cause,
        });
      }
    }

    try {
      await runGit(['merge', '--ff-only', source], { cwd: canonical });
    } catch (cause) {
      throw new IntegrationError(`Candidate fast-forward merge failed; worktree preserved: ${candidateWorktree}`, {
        phase: 'merge',
        candidate: candidateRecord,
        cause,
      });
    }

    const resultCommit = await headCommit(canonical);
    return {
      ...candidateRecord,
      candidate: candidateRecord,
      repoPath: canonical,
      worktreePath: candidateWorktree,
      branch: source,
      targetBranch: target,
      resultCommit,
      status: 'INTEGRATED',
    };
  });
}

export const integrate = integrateCandidate;

export class GitIntegrationProvider {
  [key: string]: any;
  constructor({ store, validate } : any = {}) {
    this.store = store;
    this.validate = validate;
  }

  async integrate(candidateOrOptions: any = {}, runOrOptions: any = {}) {
    // RunOrchestrator passes `(candidate, run)` while direct users generally
    // pass one `{ candidate, ...options }` object. Accept both shapes.
    const options: any = Object.hasOwn(candidateOrOptions, 'candidate')
      ? { ...candidateOrOptions, ...(runOrOptions ?? {}) }
      : { candidate: candidateOrOptions, ...(runOrOptions ?? {}) };
    return integrateCandidate({
      ...options,
      store: options.store ?? this.store,
      validate: options.validate ?? this.validate,
    });
  }
}

export const IntegrationProvider = GitIntegrationProvider;
