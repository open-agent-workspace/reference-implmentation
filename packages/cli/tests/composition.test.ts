import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, renameSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initWorkspace, loadWorkspace } from '@agentic-workspace/core';
import { main } from '../src/cli.js';

test('CLI composes two existing application workspaces without migration', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ws-compose-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const roots = ['control', 'dashboard', 'esp32'].map((name) => {
    const path = join(root, name); mkdirSync(path); initWorkspace(path, { name }); return path;
  });
  const [control, dashboard, esp32] = roots;
  const original = roots.map((path) => readFileSync(join(path, '.workspace/workspace.yaml'), 'utf8'));
  let text = '';
  const context = { cwd: control, stdout: { write: (value) => { text += value; } } };
  async function run(...args) { text = ''; await main(['compose', ...args, '--json'], context); return JSON.parse(text); }
  assert.equal((await run('create', 'Agent Control System')).name, 'Agent Control System');
  await run('add', 'dashboard', '../dashboard', '--role', 'Routes commands');
  await run('add', 'esp32', esp32, '--access', 'read-write');
  assert.equal((await run('list')).length, 2);
  assert.equal((await run('inspect')).members[1].access, 'read-write');
  assert.equal((await run('validate')).valid, true);
  renameSync(esp32, join(root, 'firmware'));
  assert.equal((await run('inspect')).members[1].status, 'unresolved');
  await assert.rejects(() => run('validate'), /validation failed/);
  assert.equal(JSON.parse(text).valid, false);
  await run('relocate', 'esp32', '../firmware');
  await run('remove', 'esp32');
  assert.equal(loadWorkspace(join(root, 'firmware')).config.name, 'esp32');
  assert.equal(existsSync(join(dashboard, '.workspace/composition.yaml')), false);
  assert.deepEqual([control, dashboard, join(root, 'firmware')].map((path) =>
    readFileSync(join(path, '.workspace/workspace.yaml'), 'utf8')), original);
  await assert.rejects(() => run('add', 'missing'), /workspace path/);
  await assert.rejects(() => run('inspect', 'extra'), /Too many arguments/);
  await assert.rejects(() => run('delete'), /Unknown composition action/);
  await assert.rejects(() => run('remove', 'dashboard', '--access', 'read-write'), /Unknown option/);
});
