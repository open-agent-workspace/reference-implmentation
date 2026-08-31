import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { GitError, currentBranch, headCommit, isDirty, runGit, snapshotRepository } from '../src/git.js';
import {
  createContextWorktree,
  createWorktree,
  finalizeCandidate,
  removeWorktree,
} from '../src/providers/git-worktree.js';

async function repoFixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ws-git-worktree-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await runGit(['init', '-b', 'main'], { cwd: directory });
  await runGit(['config', 'user.name', 'Workspace Tests'], { cwd: directory });
  await runGit(['config', 'user.email', 'workspace-tests@example.invalid'], { cwd: directory });
  await writeFile(path.join(directory, 'README.md'), 'base\n');
  await runGit(['add', '--all'], { cwd: directory });
  await runGit(['commit', '-m', 'base'], { cwd: directory });
  return directory;
}

test('runGit passes argv literally and reports repository snapshots', async (t) => {
  const repo = await repoFixture(t);
  const marker = '$(touch SHOULD_NOT_EXIST)';
  const result = await runGit(['log', '-1', '--format=%s', marker], { cwd: repo }).catch((error) => error);
  assert.ok(result instanceof GitError);
  assert.equal(await isDirty(repo), false);
  const snapshot = await snapshotRepository(repo);
  assert.equal(snapshot.branch, 'main');
  assert.equal(snapshot.dirty, false);
  assert.match(snapshot.head, /^[0-9a-f]{40}$/);
  await assert.rejects(() => runGit(['status'], { cwd: path.join(repo, 'missing') }), GitError);
});

test('creates isolated worktree and finalizes changed and unchanged candidates', async (t) => {
  const repo = await repoFixture(t);
  const beforeBranch = await currentBranch(repo);
  const beforeHead = await headCommit(repo);
  const worktree = await createWorktree({ repoPath: repo, runId: 'run-1' });
  assert.equal(await currentBranch(repo), beforeBranch);
  assert.equal(await headCommit(repo), beforeHead);
  assert.equal(await isDirty(repo), false);
  assert.equal(worktree.branch, 'run/run-1');
  assert.notEqual(worktree.worktreePath, repo);

  await writeFile(path.join(worktree.worktreePath, 'new.txt'), 'agent result\n');
  const candidate = await finalizeCandidate({
    ...worktree,
    runId: 'run-1',
    message: 'agent candidate',
  });
  assert.equal(candidate.changed, true);
  assert.match(candidate.resultCommit, /^[0-9a-f]{40}$/);
  assert.equal(candidate.commit, candidate.resultCommit);
  assert.equal((await readFile(path.join(repo, 'new.txt')).catch(() => null)), null);
  assert.equal(await isDirty(worktree.worktreePath), false);

  const unchangedWorktree = await createWorktree({ repoPath: repo, runId: 'run-2' });
  const unchanged = await finalizeCandidate({ ...unchangedWorktree, runId: 'run-2' });
  assert.equal(unchanged.changed, false);
  assert.equal(unchanged.commit, null);
  assert.equal(unchanged.resultCommit, unchangedWorktree.baseCommit);
});

test('worktree removal is opt-in and does not remove canonical checkout', async (t) => {
  const repo = await repoFixture(t);
  const worktree = await createWorktree({ repoPath: repo, runId: 'run-remove' });
  await assert.rejects(
    () => removeWorktree({ repoPath: repo, worktreePath: worktree.worktreePath }),
    /allowRemoval: true/,
  );
  await removeWorktree({ repoPath: repo, worktreePath: worktree.worktreePath, allowRemoval: true });
  await assert.rejects(() => currentBranch(worktree.worktreePath));
  assert.equal(await currentBranch(repo), 'main');
  assert.equal(await isDirty(repo), false);
});

test('materializes a captured context commit in a detached worktree', async (t) => {
  const repo = await repoFixture(t);
  const capturedCommit = await headCommit(repo);
  const canonicalBefore = await snapshotRepository(repo);
  const context = await createContextWorktree({
    repoPath: repo,
    runId: 'run-context',
    baseCommit: capturedCommit,
  });

  assert.equal(context.detached, true);
  assert.notEqual(context.worktreePath, repo);
  assert.equal(await currentBranch(context.worktreePath), null);
  assert.equal(await headCommit(context.worktreePath), capturedCommit);
  assert.deepEqual(await snapshotRepository(repo), canonicalBefore);

  // Advance canonical history after materialization. The context checkout
  // remains a stable read-only view of the captured revision.
  await writeFile(path.join(repo, 'canonical-only.txt'), 'new canonical state\n');
  await runGit(['add', '--all'], { cwd: repo });
  await runGit(['commit', '-m', 'advance canonical'], { cwd: repo });
  assert.notEqual(await headCommit(repo), capturedCommit);
  assert.equal(await headCommit(context.worktreePath), capturedCommit);
  await assert.rejects(() => readFile(path.join(context.worktreePath, 'canonical-only.txt')));
  assert.equal(await readFile(path.join(repo, 'canonical-only.txt'), 'utf8'), 'new canonical state\n');

  await removeWorktree({
    repoPath: repo,
    worktreePath: context.worktreePath,
    allowRemoval: true,
  });
  await assert.rejects(() => currentBranch(context.worktreePath));
  assert.equal(await currentBranch(repo), 'main');
  assert.equal(await isDirty(repo), false);
});
