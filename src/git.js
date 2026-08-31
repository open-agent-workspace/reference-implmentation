import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';

import { WorkspaceError } from './errors.js';

/**
 * Error raised when Git cannot complete a command.
 *
 * The original argv and captured streams are intentionally retained so a
 * caller can record useful provenance without having to parse an error string.
 */
export class GitError extends WorkspaceError {
  constructor(message, { args = [], cwd, stdout = '', stderr = '', code, signal, cause } = {}) {
    super(message, { cause });
    this.name = 'GitError';
    this.args = [...args];
    this.cwd = cwd;
    this.stdout = stdout;
    this.stderr = stderr;
    this.code = code;
    this.signal = signal;
  }
}

function assertArgs(args) {
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
    throw new TypeError('Git arguments must be an array of strings');
  }
}

function displayArg(arg) {
  return /^[a-zA-Z0-9_./:@%+=,-]+$/.test(arg) ? arg : JSON.stringify(arg);
}

/**
 * Invoke Git without a shell. No argument is interpreted as shell syntax.
 * Resolves with stdout/stderr on success and throws GitError on failure.
 */
export function runGit(args, { cwd, env, input, encoding = 'utf8' } = {}) {
  assertArgs(args);
  if (cwd !== undefined && typeof cwd !== 'string') throw new TypeError('Git cwd must be a string');

  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding(encoding);
    child.stderr.setEncoding(encoding);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (cause) => {
      reject(new GitError(`Unable to start git: ${cause.message}`, { args, cwd, stdout, stderr, cause }));
    });
    child.once('close', (code, signal) => {
      if (code === 0) {
        resolve({ stdout, stderr, code, signal });
      } else {
        const command = ['git', ...args].map(displayArg).join(' ');
        const detail = stderr.trim() || stdout.trim() || `exit code ${code ?? signal}`;
        reject(new GitError(`${command} failed: ${detail}`, { args, cwd, stdout, stderr, code, signal }));
      }
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

export const git = runGit;

export async function assertGitRepository(repoPath) {
  if (typeof repoPath !== 'string' || repoPath.length === 0) {
    throw new WorkspaceError('Repository path is required');
  }
  try {
    await access(repoPath);
    const result = await runGit(['rev-parse', '--show-toplevel'], { cwd: repoPath });
    return path.resolve(result.stdout.trim());
  } catch (cause) {
    if (cause instanceof WorkspaceError) throw cause;
    throw new WorkspaceError(`Not a Git repository: ${repoPath}`, { cause });
  }
}

export async function repositoryRoot(repoPath) {
  return assertGitRepository(repoPath);
}

export async function currentBranch(repoPath) {
  const root = await assertGitRepository(repoPath);
  try {
    const { stdout } = await runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: root });
    return stdout.trim() || null;
  } catch (error) {
    // A detached HEAD is a valid snapshot, but has no branch name.
    if (error instanceof GitError && error.code === 1) return null;
    throw error;
  }
}

export const getCurrentBranch = currentBranch;

export async function headCommit(repoPath) {
  const root = await assertGitRepository(repoPath);
  const { stdout } = await runGit(['rev-parse', '--verify', 'HEAD'], { cwd: root });
  return stdout.trim();
}

export const currentHead = headCommit;

export async function statusPorcelain(repoPath) {
  const root = await assertGitRepository(repoPath);
  const { stdout } = await runGit(['status', '--porcelain=v1', '--untracked-files=all'], { cwd: root });
  return stdout;
}

export async function isDirty(repoPath) {
  return (await statusPorcelain(repoPath)).length > 0;
}

export async function snapshotRepository(repoPath) {
  const root = await assertGitRepository(repoPath);
  const [branch, head, status] = await Promise.all([
    currentBranch(root),
    headCommit(root),
    statusPorcelain(root),
  ]);
  return {
    path: root,
    root,
    branch,
    head,
    dirty: status.length > 0,
    status,
  };
}

export const snapshotRepo = snapshotRepository;

export async function snapshotRepositories(repositories) {
  if (!Array.isArray(repositories)) throw new TypeError('Repositories must be an array');
  return Promise.all(repositories.map((repository) => snapshotRepository(
    typeof repository === 'string' ? repository : repository.path,
  )));
}

