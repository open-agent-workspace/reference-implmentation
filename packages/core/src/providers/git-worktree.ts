import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import {
  GitError,
  assertGitRepository,
  currentBranch,
  headCommit,
  isDirty,
  runGit,
  snapshotRepository,
} from '../git.js';
import { WorkspaceError } from '../errors.js';

function requiredString(value, name) {
  if (typeof value !== 'string' || value.length === 0) throw new WorkspaceError(`${name} is required`);
  return value;
}

function safeRef(value, name) {
  requiredString(value, name);
  if (value.startsWith('-') || value.includes('\0')) throw new WorkspaceError(`Invalid ${name}`);
  return value;
}

function safeRunId(runId) {
  const value = requiredString(runId, 'runId');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(value) || value.includes('..')) {
    throw new WorkspaceError('runId contains unsafe path characters');
  }
  return value.replaceAll('/', '-');
}

function asPath(value, name) {
  const result = path.resolve(requiredString(value, name));
  if (result === path.parse(result).root) throw new WorkspaceError(`${name} cannot be the filesystem root`);
  return result;
}

/**
 * Create a writable Git worktree for a bounded Run. The canonical checkout is
 * never checked out, reset, or otherwise modified by this operation.
 */
export async function createWorktree({
  repoPath,
  runId,
  path: requestedPath,
  worktreePath,
  worktreeRoot,
  baseRef,
  baseCommit,
  branchName,
  allowDirtyCanonical = false,
} : any = {}) {
  const root = await assertGitRepository(repoPath);
  const snapshot = await snapshotRepository(root);
  if (snapshot.dirty && !allowDirtyCanonical) {
    throw new WorkspaceError(`Canonical checkout is dirty: ${root}`);
  }

  const id = safeRunId(runId);
  const branch = safeRef(branchName ?? `run/${id}`, 'branchName');
  const base = safeRef(baseRef ?? baseCommit ?? snapshot.branch ?? snapshot.head, 'baseRef');
  const targetPath = worktreePath ?? requestedPath;
  const target = targetPath
    ? asPath(targetPath, 'worktreePath')
    : path.resolve(
      worktreeRoot
        ? requiredString(worktreeRoot, 'worktreeRoot')
        : path.join(path.dirname(root), '.workspace-runtime', 'worktrees', path.basename(root)),
      id,
    );

  // Refuse to put a worktree directly on top of the canonical checkout.
  if (target === root) throw new WorkspaceError('Worktree path must differ from canonical checkout');
  await mkdir(path.dirname(target), { recursive: true });

  await runGit(['worktree', 'add', '-b', branch, target, base], { cwd: root });
  const created = await snapshotRepository(target);
  return {
    repoPath: root,
    canonicalPath: root,
    worktreePath: target,
    branch,
    baseRef: base,
    baseCommit: created.head,
    runId,
    snapshot: created,
  };
}

/** Materialize a context-only repository at its captured commit without a branch. */
export async function createContextWorktree({ repoPath, runId, worktreePath, worktreeRoot, baseCommit } : any = {}) {
  const root = await assertGitRepository(repoPath);
  const id = safeRunId(runId);
  const base = safeRef(baseCommit ?? await headCommit(root), 'baseCommit');
  const target = worktreePath
    ? asPath(worktreePath, 'worktreePath')
    : path.resolve(worktreeRoot ?? path.join(path.dirname(root), '.workspace-runtime', 'context'), id);
  if (target === root) throw new WorkspaceError('Context worktree must differ from canonical checkout');
  await mkdir(path.dirname(target), { recursive: true });
  await runGit(['worktree', 'add', '--detach', target, base], { cwd: root });
  return { repoPath: root, worktreePath: target, baseCommit: base, detached: true, runId };
}

/**
 * Finalize whatever an agent left in its worktree. A Candidate is returned
 * even when the agent made no changes; in that case `changed` is false and
 * `resultCommit` is the worktree's existing HEAD.
 */
export async function finalizeCandidate({
  worktreePath,
  repoPath,
  repo,
  runId,
  candidateId,
  baseCommit,
  branch,
  message,
} : any = {}) {
  const worktree = await assertGitRepository(worktreePath);
  const worktreeBranch = await currentBranch(worktree);
  const resultBranch = safeRef(branch ?? worktreeBranch, 'branch');
  if (!resultBranch || worktreeBranch !== resultBranch) {
    throw new WorkspaceError(`Candidate worktree is on unexpected branch (expected ${resultBranch ?? 'a branch'}, got ${worktreeBranch ?? 'detached HEAD'})`);
  }

  await runGit(['add', '--all'], { cwd: worktree });
  let changed = true;
  try {
    await runGit(['diff', '--cached', '--quiet'], { cwd: worktree });
    changed = false;
  } catch (error) {
    if (!(error instanceof GitError) || error.code !== 1) throw error;
  }

  if (changed) {
    const commitMessage = message ?? (runId ? `Run ${runId}` : 'Agent candidate');
    requiredString(commitMessage, 'message');
    await runGit(['commit', '-m', commitMessage], { cwd: worktree });
  }
  const resultCommit = await headCommit(worktree);
  return {
    candidateId,
    runId,
    repoPath: repoPath
      ? await assertGitRepository(repoPath)
      : (repo?.path ? await assertGitRepository(repo.path) : undefined),
    repo: typeof repo === 'string' ? repo : undefined,
    worktreePath: worktree,
    branch: resultBranch,
    baseCommit,
    resultCommit,
    commit: changed ? resultCommit : null,
    changed,
    status: 'PENDING',
  };
}

/**
 * Remove a worktree only when the caller opts in explicitly. This provider
 * never removes candidate work as part of error handling or normal cleanup.
 */
export async function removeWorktree({ repoPath, worktreePath, allowRemoval = false, preserve, force = false } : any = {}) {
  if (allowRemoval !== true && preserve !== false) {
    throw new WorkspaceError('Worktree removal requires allowRemoval: true');
  }
  const root = await assertGitRepository(repoPath);
  const target = asPath(worktreePath, 'worktreePath');
  if (target === root) throw new WorkspaceError('Refusing to remove canonical checkout');
  const { stdout } = await runGit(['worktree', 'list', '--porcelain'], { cwd: root });
  const registered = stdout.split('\n').some((line) => line === `worktree ${target}`);
  if (!registered) throw new WorkspaceError(`Worktree is not registered with repository: ${target}`);
  const args = ['worktree', 'remove'];
  if (force) args.push('--force');
  args.push(target);
  await runGit(args, { cwd: root });
  return { repoPath: root, worktreePath: target, removed: true };
}

export class GitWorktreeExecutionProvider {
  [key: string]: any;
  async createWorktree(options) {
    return createWorktree(options);
  }

  async createContextWorktree(options) {
    return createContextWorktree(options);
  }

  async finalizeCandidate(options) {
    return finalizeCandidate(options);
  }

  async removeWorktree(options) {
    return removeWorktree(options);
  }

  async snapshot(options) {
    return snapshotRepository(typeof options === 'string' ? options : options.repoPath);
  }

  async currentBranch(repoPath) {
    return currentBranch(typeof repoPath === 'string' ? repoPath : repoPath.repoPath);
  }

  async isDirty(repoPath) {
    return isDirty(typeof repoPath === 'string' ? repoPath : repoPath.repoPath);
  }
}

export const GitWorktreeProvider = GitWorktreeExecutionProvider;
