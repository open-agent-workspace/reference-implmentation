import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addRepository,
  createAgentProfile,
  discoverWorkspace,
  initWorkspace,
  listRepositories,
  loadAgentProfile,
  loadWorkspace,
} from '../src/workspace.js';
import { runGit } from '../src/git.js';

async function gitRepository(parent, name) {
  const root = join(parent, name);
  mkdirSync(root, { recursive: true });
  await runGit(['init', '-q', root]);
  writeFileSync(join(root, 'README.md'), `${name}\n`);
  await runGit(['config', 'user.name', 'Test'], { cwd: root });
  await runGit(['config', 'user.email', 'test@example.com'], { cwd: root });
  await runGit(['add', '.'], { cwd: root });
  await runGit(['commit', '-qm', 'initial'], { cwd: root });
  return root;
}

test('init creates layout and discovers workspace from nested directories', () => {
  const root = mkdtempSync(join(tmpdir(), 'ws-workspace-'));
  try {
    const workspace = initWorkspace(root, { name: 'Example' });
    for (const path of ['workspace.yaml', '.gitignore', 'context/architecture.md', 'context/conventions.md',
      'context/policies.md', 'agents', 'history/runs', 'proposals', 'runtime']) {
      assert.ok(existsSync(join(workspace.workspaceDir, path)), path);
    }
    const nested = join(root, 'src', 'deep');
    mkdirSync(nested, { recursive: true });
    assert.equal(discoverWorkspace(nested).root, root);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('repository manifest validates Git, stores portable paths, and assigns first primary', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ws-repos-'));
  try {
    initWorkspace(root);
    const repo = await gitRepository(root, 'app');
    const other = await gitRepository(root, 'api');
    assert.equal((await addRepository(root, repo)).role, 'primary');
    assert.equal((await addRepository(root, other, { name: 'Backend' })).name, 'backend');
    assert.deepEqual(listRepositories(root).map(({ name, role, path }) => ({ name, role, path })), [
      { name: 'app', role: 'primary', path: 'app' },
      { name: 'backend', role: 'secondary', path: 'api' },
    ]);
    await assert.rejects(() => addRepository(root, repo), /already registered/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('agent profile is a non-shell command argv with runtime policy fields', () => {
  const root = mkdtempSync(join(tmpdir(), 'ws-agents-'));
  try {
    initWorkspace(root);
    createAgentProfile(root, 'coder', {
      command: 'node ./agent.mjs "hello world"',
      validation: ['npm test'],
      ports: ['PORT'],
      concurrency: 'forbid',
    });
    assert.deepEqual(loadAgentProfile(root, 'coder'), {
      name: 'coder', provider: 'command', command: ['node', './agent.mjs', 'hello world'],
      instructions: '', skills: [], context_scope: { repositories: 'all' },
      mutation_scope: { repositories: 'primary' }, resource_policy: {}, integration_policy: {},
      concurrency: 'forbid', validation: ['npm test'], ports: ['PORT'],
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('workspace loading rejects malformed and unsupported manifests', () => {
  const root = mkdtempSync(join(tmpdir(), 'ws-invalid-'));
  try {
    const workspace = initWorkspace(root);
    writeFileSync(workspace.configPath, 'version: [not valid\n', 'utf8');
    assert.throws(() => loadWorkspace(root), /Invalid workspace config/);
    writeFileSync(workspace.configPath, 'version: 99\nrepositories: []\n', 'utf8');
    assert.throws(() => loadWorkspace(root), /Unsupported workspace version/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
