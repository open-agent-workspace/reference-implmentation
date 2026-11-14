import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.js';

async function runWs(cwd, args) {
  let stdout = '';
  const stream = { write(chunk) { stdout += String(chunk); return true; } };
  await main(args, { cwd, stdout: stream });
  return stdout;
}

test('discover filters declared resources and validate does not create runtime state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ws-cli-system-'));
  await runWs(root, ['init']);
  await rm(join(root, '.workspace', 'runtime', 'workspace.db'), { force: true });
  await writeFile(join(root, 'system', 'systems.yaml'), 'version: 1\nsystems:\n  - id: platform\n    name: Platform\n');
  await writeFile(join(root, 'system', 'layers.yaml'), 'version: 1\nlayers:\n  - id: execution\n    name: Execution\n');
  await writeFile(join(root, 'system', 'resources.yaml'), [
    'version: 1',
    'resources:',
    '  - id: cli',
    '    name: CLI',
    '    kind: repo',
    '    systems: [platform]',
    '    layers: [execution]',
  ].join('\n'));
  await writeFile(join(root, 'system', 'repos.yaml'), 'version: 1\nrepositories: []\n');
  const discovered = JSON.parse(await runWs(root, ['discover', '--system', 'platform', '--json']));
  assert.deepEqual(discovered.map((item) => item.id), ['cli']);
  const validated = JSON.parse(await runWs(root, ['validate', '--json']));
  assert.equal(validated.valid, true);
  await access(join(root, 'system', 'resources.yaml'));
  assert.equal(await access(join(root, '.workspace', 'runtime', 'workspace.db')).then(() => true).catch(() => false), false);
  const status = JSON.parse(await runWs(root, ['status', '--json']));
  assert.equal(status.declared.resources[0].id, 'cli');
  assert.deepEqual(status.reconciled_orphans, []);
  await readFile(join(root, 'system', 'resources.yaml'), 'utf8');
});

test('dependencies lists repository and module edges and supports direction filters', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ws-cli-dependencies-'));
  await runWs(root, ['init']);
  await writeFile(join(root, '.workspace', 'workspace.yaml'), [
    'version: 1',
    'repositories:',
    '  - name: app',
    '    path: repos/app',
    '    role: primary',
    '    context: true',
    '  - name: docs',
    '    path: repos/docs',
    '    role: secondary',
    '    context: true',
  ].join('\n'));
  await writeFile(join(root, 'system', 'dependencies.yaml'), [
    'version: 1',
    'dependencies:',
    '  - id: app-cli-core',
    '    from: { repository: app, module: packages/cli }',
    '    to: { repository: app, module: packages/core }',
    '    kind: imports',
    '  - id: docs-app',
    '    from: { repository: docs }',
    '    to: { repository: app }',
    '    kind: documents',
  ].join('\n'));

  const all = JSON.parse(await runWs(root, ['dependencies', '--json']));
  assert.deepEqual(all.map((entry) => entry.id), ['app-cli-core', 'docs-app']);
  const incoming = JSON.parse(await runWs(root, ['deps', '--repository', 'app', '--direction', 'incoming', '--json']));
  assert.deepEqual(incoming.map((entry) => entry.id), ['app-cli-core', 'docs-app']);
  const human = await runWs(root, ['dependencies', '--repository', 'app', '--direction', 'outgoing']);
  assert.match(human, /app:packages\/cli/);
  assert.match(human, /app:packages\/core/);
});
