import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  addRepository,
  discoverResources,
  initWorkspace,
  loadSystemModel,
  validateSystemModel,
} from '../src/index.js';
import { runGit } from '../src/git.js';

async function gitRepository(parent, name) {
  const root = join(parent, name);
  await runGit(['init', '-q', root]);
  await runGit(['config', 'user.name', 'System Test'], { cwd: root });
  await runGit(['config', 'user.email', 'system-test@example.invalid'], { cwd: root });
  writeFileSync(join(root, 'README.md'), `${name}\n`);
  await runGit(['add', '.'], { cwd: root });
  await runGit(['commit', '-qm', 'initial'], { cwd: root });
  return root;
}

test('init creates system registries and loads an empty valid topology', () => {
  const root = mkdtempSync(join(tmpdir(), 'ws-system-'));
  try {
    initWorkspace(root);
    for (const file of ['systems.yaml', 'layers.yaml', 'resources.yaml', 'repos.yaml']) {
      assert.equal(existsSync(join(root, 'system', file)), true, file);
    }
    const model = loadSystemModel(root);
    assert.equal(model.derived, false);
    assert.deepEqual(model.resources, []);
    assert.equal(validateSystemModel(root).valid, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('legacy workspaces derive repository resources only when registries are absent', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ws-system-legacy-'));
  try {
    initWorkspace(root);
    const repo = await gitRepository(root, 'app');
    await addRepository(root, repo, { name: 'app' });
    rmSync(join(root, 'system'), { recursive: true, force: true });
    const derived = loadSystemModel(root);
    assert.equal(derived.derived, true);
    assert.equal(derived.resources[0].kind, 'repo');
    writeFileSync(join(root, 'system'), 'not a directory\n');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('validation catches unknown relationships, manifest names, and unsafe paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'ws-system-invalid-'));
  try {
    initWorkspace(root);
    writeFileSync(join(root, 'system', 'systems.yaml'), 'version: 1\nsystems:\n  - id: platform\n    name: Platform\n');
    writeFileSync(join(root, 'system', 'layers.yaml'), 'version: 1\nlayers:\n  - id: execution\n    name: Execution\n');
    writeFileSync(join(root, 'system', 'resources.yaml'), [
      'version: 1',
      'resources:',
      '  - id: cli',
      '    name: CLI',
      '    kind: repo',
      '    systems: [missing]',
      '    layers: [execution]',
      '    path: ../outside',
      '    repository: missing-repo',
    ].join('\n'));
    writeFileSync(join(root, 'system', 'repos.yaml'), [
      'version: 1',
      'repositories:',
      '  - id: cli-repo',
      '    manifest_name: missing-repo',
      '    resource: missing-resource',
      '    systems: [platform]',
      '    layers: [execution]',
    ].join('\n'));
    const report = validateSystemModel(root);
    assert.equal(report.valid, false);
    assert.ok(report.errors.some((error) => error.path.includes('resources[0].path')));
    assert.ok(report.errors.some((error) => error.path.includes('manifest_name')));
    assert.ok(discoverResources(root, { layer: 'execution' }).length === 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
