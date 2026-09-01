import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as net from 'node:net';
import { main } from '../src/cli.js';

const exec = promisify(execFile);

async function runWs(cwd, args) {
  let stdout = '';
  const stream = { write(chunk) { stdout += String(chunk); return true; } };
  await main(args, { cwd, stdout: stream });
  return { stdout, stderr: '' };
}

async function git(cwd, args) {
  return exec('git', args, { cwd, maxBuffer: 4 * 1024 * 1024 });
}

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

// The managed test environment disallows real TCP listeners. This preserves
// the allocator path while making the port probe deterministic and harmless.
async function withPortProbe(callback) {
  const originalListen = net.Server.prototype.listen;
  net.Server.prototype.listen = function patchedListen(...args) {
    const callbackArg = args.find((value) => typeof value === 'function');
    queueMicrotask(() => callbackArg?.call(this));
    return this;
  };
  try { return await callback(); } finally { net.Server.prototype.listen = originalListen; }
}

test('CLI runs an isolated candidate through inspect, integrate, and cleanup', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'ws-cli-'));
  await git(repo, ['init', '-q']);
  await git(repo, ['config', 'user.name', 'CLI Test']);
  await git(repo, ['config', 'user.email', 'cli-test@localhost']);
  // This command is committed into the repository, so the worktree can run it
  // without relying on files outside the snapshot.
await writeFile(join(repo, 'fake-agent.mjs'), `
import { writeFile } from 'node:fs/promises';
await writeFile('agent-output.txt', (process.env.WS_PROMPT ?? 'missing prompt') + '|TEST_PORT=' + (process.env.TEST_PORT ?? 'missing'));
`);
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-qm', 'fixture']);

  const initialized = await runWs(repo, ['init']);
  assert.match(initialized.stdout, /workspace:/i);
  await runWs(repo, ['repo', 'add', '.']);
  await runWs(repo, ['agent', 'add', 'coder', '--command', 'node fake-agent.mjs']);
  // Integration intentionally requires a clean canonical checkout. Commit the
  // durable workspace manifest and generated coding-agent guidance; runtime
  // SQLite/logs remain ignored.
  await git(repo, ['add', '.workspace', '.gitignore', 'AGENTS.md', '.agents']);
  await git(repo, ['commit', '-qm', 'configure workspace']);
  const before = (await git(repo, ['rev-parse', 'HEAD'])).stdout.trim();

  await assert.rejects(
    () => runWs(repo, ['run', 'coder', 'unknown', '--repo', 'missing', '--no-integrate', '--json']),
    /Primary repository not found/,
  );
  await assert.rejects(
    () => runWs(repo, ['run', 'coder', 'unknown', '--context-repo', 'missing', '--no-integrate', '--json']),
    /Context repository not found/,
  );

  const started = await withPortProbe(() => runWs(repo, [
    'run', 'coder', 'make', 'a', 'candidate', '--port', 'TEST_PORT', '--no-integrate', '--json',
  ]));
  const runResult = JSON.parse(started.stdout);
  assert.equal(runResult.status, 'CANDIDATE');
  assert.ok(runResult.candidate);
  assert.equal((await git(repo, ['rev-parse', 'HEAD'])).stdout.trim(), before);
  assert.equal(await exists(join(repo, 'agent-output.txt')), false, 'agent must not write canonical checkout');

  const inspected = JSON.parse((await runWs(repo, ['inspect', runResult.candidate, '--json'])).stdout);
  assert.equal(inspected.run.status, 'CANDIDATE');
  assert.equal(inspected.candidates[0].status, 'PENDING');
  const worktree = inspected.candidates[0].metadata_json.worktreePath;
  assert.equal(await exists(worktree), true, 'unintegrated candidate worktree must be preserved');
  assert.match(await readFile(join(worktree, 'agent-output.txt'), 'utf8'), /make a candidate\|TEST_PORT=\d+/);

  const listed = JSON.parse((await runWs(repo, ['runs', '--json'])).stdout);
  assert.equal(listed[0].run, runResult.run);
  const status = JSON.parse((await runWs(repo, ['status', '--json'])).stdout);
  assert.equal(status.pending_candidates[0].id, runResult.candidate);

  const integrated = JSON.parse((await runWs(repo, ['integrate', runResult.candidate, '--json'])).stdout);
  assert.equal(integrated.status, 'INTEGRATED');
  assert.notEqual((await git(repo, ['rev-parse', 'HEAD'])).stdout.trim(), before);
  assert.equal(await exists(join(repo, 'agent-output.txt')), true, 'integration should promote candidate changes');

  // Auto-integrated runs promote a concise durable record. The record is
  // intentionally left as an uncommitted workspace knowledge change, and must
  // not prevent the next auto-integrated run.
  const second = await runWs(repo, ['run', 'coder', 'record', 'history', '--json']);
  const secondResult = JSON.parse(second.stdout);
  assert.equal(secondResult.status, 'COMPLETED');
  const historyPath = join(repo, '.workspace', 'history', 'runs', `${secondResult.run}.yaml`);
  assert.equal(await exists(historyPath), true);
  const third = await runWs(repo, ['run', 'coder', 'history', 'again', '--json']);
  assert.equal(JSON.parse(third.stdout).status, 'COMPLETED');
  assert.equal(await exists(historyPath), true);

  const cleaned = JSON.parse((await runWs(repo, ['cleanup', '--json'])).stdout);
  assert.ok(cleaned.removed.some((item) => item.candidate === runResult.candidate));
  assert.equal(await exists(worktree), false, 'integrated worktree should be removable by cleanup');
});
