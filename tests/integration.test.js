import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { currentBranch, isDirty, runGit } from '../src/git.js';
import { createWorktree, finalizeCandidate } from '../src/providers/git-worktree.js';
import { IntegrationError, integrateCandidate } from '../src/providers/integration.js';

async function repoFixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ws-integration-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await runGit(['init', '-b', 'main'], { cwd: directory });
  await runGit(['config', 'user.name', 'Workspace Tests'], { cwd: directory });
  await runGit(['config', 'user.email', 'workspace-tests@example.invalid'], { cwd: directory });
  await writeFile(path.join(directory, 'README.md'), 'base\n');
  await runGit(['add', '--all'], { cwd: directory });
  await runGit(['commit', '-m', 'base'], { cwd: directory });
  return directory;
}

async function candidateFixture(t, repo, id, content = 'candidate\n') {
  const worktree = await createWorktree({ repoPath: repo, runId: id });
  await writeFile(path.join(worktree.worktreePath, 'README.md'), content);
  return finalizeCandidate({ ...worktree, runId: id, message: `${id} candidate` });
}

function lockStore() {
  const calls = [];
  return {
    calls,
    async withLock(key, fn) {
      calls.push(key);
      return fn();
    },
  };
}

test('integrates a candidate under the store lock with rebase then ff-only merge', async (t) => {
  const repo = await repoFixture(t);
  const candidate = await candidateFixture(t, repo, 'run-integrate');
  const store = lockStore();
  let validated = false;
  const result = await integrateCandidate({
    candidate,
    store,
    targetBranch: 'main',
    validate: async ({ worktreePath, targetBranch }) => {
      validated = targetBranch === 'main' && (await isDirty(worktreePath)) === false;
    },
  });
  assert.equal(validated, true);
  assert.equal(result.status, 'INTEGRATED');
  assert.equal(await currentBranch(repo), 'main');
  assert.equal(await readFile(path.join(repo, 'README.md'), 'utf8'), 'candidate\n');
  assert.equal(await isDirty(repo), false);
  assert.deepEqual(store.calls, [`integration:${repo}`]);
});

test('rejects dirty or wrong-branch canonical checkouts before mutation', async (t) => {
  const repo = await repoFixture(t);
  const candidate = await candidateFixture(t, repo, 'run-preflight');
  const store = lockStore();
  await writeFile(path.join(repo, 'dirty.txt'), 'human change\n');
  await assert.rejects(
    () => integrateCandidate({ candidate, store, targetBranch: 'main' }),
    (error) => error instanceof IntegrationError && error.phase === 'preflight',
  );
  assert.equal(await isDirty(repo), true);
  await runGit(['restore', '--staged', '--worktree', '.'], { cwd: repo });
  await runGit(['switch', '-c', 'other'], { cwd: repo });
  await assert.rejects(
    () => integrateCandidate({ candidate, store, targetBranch: 'main' }),
    (error) => error instanceof IntegrationError && error.phase === 'preflight',
  );
  assert.equal(await currentBranch(repo), 'other');
  assert.equal(await readFile(path.join(repo, 'README.md'), 'utf8'), 'base\n');
});

test('preserves candidate worktree in rebase conflict state', async (t) => {
  const repo = await repoFixture(t);
  const candidate = await candidateFixture(t, repo, 'run-conflict', 'candidate side\n');
  await writeFile(path.join(repo, 'README.md'), 'canonical side\n');
  await runGit(['add', '--all'], { cwd: repo });
  await runGit(['commit', '-m', 'canonical change'], { cwd: repo });
  const store = lockStore();
  await assert.rejects(
    () => integrateCandidate({ candidate, store, targetBranch: 'main' }),
    (error) => error instanceof IntegrationError && error.phase === 'rebase' && error.preserved === true,
  );
  assert.equal(await currentBranch(repo), 'main');
  assert.equal(await readFile(path.join(repo, 'README.md'), 'utf8'), 'canonical side\n');
  assert.equal(await readFile(path.join(candidate.worktreePath, 'README.md'), 'utf8').then((text) => text.includes('<<<<<<<')), true);
  const status = await runGit(['status', '--short'], { cwd: candidate.worktreePath });
  assert.match(status.stdout, /UU README\.md/);
});

test('requires a lock API', async (t) => {
  const repo = await repoFixture(t);
  const candidate = await candidateFixture(t, repo, 'run-no-lock');
  await assert.rejects(
    () => integrateCandidate({ candidate, targetBranch: 'main' }),
    /operational store lock is required/,
  );
});

