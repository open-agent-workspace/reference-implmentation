import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { main } from '../src/cli.js';

const exec = promisify(execFile);

async function git(cwd, args) {
  return exec('git', args, { cwd, maxBuffer: 4 * 1024 * 1024 });
}

async function runWs(cwd, args) {
  let stdout = '';
  const stream = { write(chunk) { stdout += String(chunk); return true; } };
  await main(args, { cwd, stdout: stream });
  return stdout;
}

async function fixture(parent, name) {
  const bare = join(parent, `${name}.git`);
  const source = join(parent, `${name}-source`);
  await git(parent, ['init', '--bare', '-q', bare]);
  await git(parent, ['init', '-q', source]);
  await git(source, ['config', 'user.name', 'CLI Test']);
  await git(source, ['config', 'user.email', 'cli-test@localhost']);
  await exec(process.execPath, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(join(source, 'README.md'))}, 'fixture\\n')`]);
  await git(source, ['add', '.']);
  await git(source, ['commit', '-qm', 'fixture']);
  await git(source, ['remote', 'add', 'origin', bare]);
  await git(source, ['push', '-q', '-u', 'origin', 'HEAD']);
  return { bare, source };
}

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

test('repo add infers and persists origin URL, and generated guidance follows mutations', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'ws-cli-repo-add-'));
  const workspace = join(parent, 'workspace');
  const { bare, source } = await fixture(parent, 'inferred');
  await exec('mkdir', ['-p', workspace]);

  await runWs(workspace, ['init']);
  assert.equal(await exists(join(workspace, '.git')), true);
  const added = JSON.parse(await runWs(workspace, ['repo', 'add', source, '--name', 'source', '--json']));
  assert.equal(added.name, 'source');
  assert.equal(added.url, bare);
  const manifest = await readFile(join(workspace, '.workspace', 'workspace.yaml'), 'utf8');
  assert.match(manifest, new RegExp(`url: ${bare.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}`));
  const agents = await readFile(join(workspace, 'AGENTS.md'), 'utf8');
  assert.match(agents, /`source`/);
  assert.match(await readFile(join(workspace, '.agents', 'skills', 'workspace-navigation', 'SKILL.md'), 'utf8'), /Workspace navigation/);
  assert.match(await readFile(join(workspace, '.agents', 'skills', 'workspace-runs', 'SKILL.md'), 'utf8'), /Workspace Runs/);
});

test('repo clone defaults to repos and sync rematerializes missing URL-backed repositories', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'ws-cli-repo-clone-'));
  const workspace = join(parent, 'workspace');
  const { bare } = await fixture(parent, 'cloned');
  await exec('mkdir', ['-p', workspace]);
  await runWs(workspace, ['init']);

  const cloned = JSON.parse(await runWs(workspace, ['repo', 'clone', bare, '--json']));
  const destination = join(workspace, 'repos', 'cloned');
  assert.equal(cloned.name, 'cloned');
  assert.equal(cloned.path, 'repos/cloned');
  assert.equal(cloned.url, bare);
  assert.equal(await exists(join(destination, '.git')), true);

  await rm(destination, { recursive: true, force: true });
  const synced = JSON.parse(await runWs(workspace, ['repo', 'sync', 'cloned', '--json']));
  assert.equal(synced[0].materialized, true);
  assert.equal(synced[0].path, destination);
  assert.equal(await exists(join(destination, '.git')), true);

  const listed = JSON.parse(await runWs(workspace, ['repo', 'list', '--json']));
  assert.equal(listed[0].url, bare);
  assert.equal((await stat(destination)).isDirectory(), true);

  const custom = JSON.parse(await runWs(workspace, [
    'repo', 'clone', bare,
    '--name', 'custom',
    '--path', 'repos/custom-checkout',
    '--json',
  ]));
  assert.equal(custom.path, 'repos/custom-checkout');
  assert.equal(await exists(join(workspace, 'repos', 'custom-checkout', '.git')), true);
  await assert.rejects(
    () => runWs(workspace, [
      'repo', 'clone', bare,
      '--name', 'escape',
      '--path', '../escape',
      '--json',
    ]),
    /Unsafe repository destination/,
  );
});

test('generate refreshes workspace files without removing user-authored AGENTS content', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'ws-cli-generate-'));
  await runWs(workspace, ['init']);
  const agentsPath = join(workspace, 'AGENTS.md');
  const existing = await readFile(agentsPath, 'utf8');
  await import('node:fs/promises').then(({ writeFile }) => writeFile(agentsPath, `# Local rules\n\n${existing}`));
  const result = JSON.parse(await runWs(workspace, ['generate', '--json']));
  assert.equal(result.agentsPath, agentsPath);
  assert.match(await readFile(agentsPath, 'utf8'), /# Local rules/);
  assert.equal(await exists(join(workspace, '.agents', 'skills', 'workspace-navigation', 'agents', 'openai.yaml')), true);
  assert.equal(await exists(join(workspace, '.agents', 'skills', 'workspace-runs', 'agents', 'openai.yaml')), true);
});
