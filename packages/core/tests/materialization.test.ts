import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parse as parseYaml } from 'yaml';

import {
  addRepository,
  cloneRepository,
  generateWorkspaceAgentFiles,
  initWorkspace,
  listRepositories,
  loadWorkspace,
  materializeMissingRepositories,
} from '../src/index.js';
import { runGit } from '../src/git.js';

async function gitRepository(parent, name) {
  const root = join(parent, name);
  mkdirSync(root, { recursive: true });
  await runGit(['init', '-q', root]);
  await runGit(['config', 'user.name', 'Workspace Tests'], { cwd: root });
  await runGit(['config', 'user.email', 'workspace-tests@example.invalid'], { cwd: root });
  writeFileSync(join(root, 'README.md'), `${name}\n`);
  await runGit(['add', '--all'], { cwd: root });
  await runGit(['commit', '-qm', 'initial'], { cwd: root });
  return root;
}

async function bareRepository(parent, name) {
  const source = await gitRepository(parent, `${name}-source`);
  const bare = join(parent, `${name}.git`);
  await runGit(['clone', '--bare', source, bare], { cwd: parent });
  return { source, bare };
}

function temporaryWorkspace(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('init creates the repos convention and preserves the root gitignore', () => {
  const fixture = temporaryWorkspace('ws-init-convention-');
  try {
    writeFileSync(join(fixture.root, '.gitignore'), 'node_modules/\n# keep this\n');
    const workspace = initWorkspace(fixture.root);
    assert.ok(existsSync(join(fixture.root, 'repos')));
    assert.equal(readFileSync(join(fixture.root, '.gitignore'), 'utf8'),
      'node_modules/\n# keep this\n/repos/\n');

    // Force reinitialization is idempotent for the convention and never
    // duplicates the ignore rule.
    initWorkspace(fixture.root, { force: true });
    const rootIgnore = readFileSync(join(fixture.root, '.gitignore'), 'utf8');
    assert.equal(rootIgnore.match(/^\/repos\/$/gm)?.length, 1);
    assert.equal(loadWorkspace(fixture.root).root, workspace.root);
  } finally { fixture.cleanup(); }
});

test('local registration persists an explicit URL and infers origin when omitted', async () => {
  const fixture = temporaryWorkspace('ws-url-registration-');
  try {
    initWorkspace(fixture.root);
    const inferred = await gitRepository(fixture.root, 'inferred');
    const inferredUrl = 'https://example.invalid/team/inferred.git';
    await runGit(['remote', 'add', 'origin', inferredUrl], { cwd: inferred });
    const explicit = await gitRepository(fixture.root, 'explicit');
    const explicitUrl = 'file:///tmp/explicit-source.git';

    const first = await addRepository(fixture.root, inferred);
    const second = await addRepository(fixture.root, { path: explicit, url: explicitUrl, name: 'second' });
    assert.equal(first.url, inferredUrl);
    assert.equal(second.url, explicitUrl);
    assert.deepEqual(listRepositories(fixture.root).map((repository) => repository.url), [
      inferredUrl,
      explicitUrl,
    ]);
    const persisted = parseYaml(readFileSync(join(fixture.root, '.workspace', 'workspace.yaml'), 'utf8'));
    assert.equal(persisted.repositories[0].url, inferredUrl);
    assert.equal(persisted.repositories[1].url, explicitUrl);
  } finally { fixture.cleanup(); }
});

test('cloneRepository clones a local bare repository into repos and registers it', async () => {
  const fixture = temporaryWorkspace('ws-clone-local-');
  try {
    const workspace = initWorkspace(fixture.root);
    const source = await bareRepository(fixture.root, 'local-source');
    const repository = await cloneRepository(workspace, source.bare, { name: 'local-copy' });
    const destination = join(fixture.root, 'repos', 'local-copy');
    assert.equal(repository.name, 'local-copy');
    assert.equal(repository.path, 'repos/local-copy');
    assert.equal(repository.url, source.bare);
    assert.equal(readFileSync(join(destination, 'README.md'), 'utf8'), 'local-source-source\n');
    assert.equal(loadWorkspace(fixture.root).repositories[0].path, destination);

    const customSource = await bareRepository(fixture.root, 'custom-source');
    const custom = await cloneRepository(workspace, customSource.bare, {
      name: 'custom',
      path: 'repos/custom-checkout',
    });
    assert.equal(custom.path, 'repos/custom-checkout');
    assert.ok(existsSync(join(fixture.root, 'repos', 'custom-checkout', '.git')));
    await assert.rejects(
      () => cloneRepository(workspace, customSource.bare, {
        name: 'escape',
        path: '../escape',
      }),
      /Unsafe repository destination/,
    );
  } finally { fixture.cleanup(); }
});

test('materializeMissingRepositories clones URL-only entries and refuses non-repository destinations', async () => {
  const fixture = temporaryWorkspace('ws-materialize-');
  try {
    initWorkspace(fixture.root);
    const source = await bareRepository(fixture.root, 'materialize-source');
    const manifest = await addRepository(fixture.root, {
      name: 'materialized',
      url: source.bare,
      role: 'primary',
    });
    assert.equal(manifest.path, undefined);
    const results = await materializeMissingRepositories(fixture.root);
    assert.equal(results[0].materialized, true);
    assert.equal(results[0].path, join(fixture.root, 'repos', 'materialized'));
    assert.equal(loadWorkspace(fixture.root).config.repositories[0].path, 'repos/materialized');

    const bad = join(fixture.root, 'repos', 'not-a-repository');
    mkdirSync(bad, { recursive: true });
    await assert.rejects(
      () => cloneRepository(fixture.root, source.bare, { name: 'not-a-repository' }),
      /exists but is not a Git repository/,
    );
    await assert.rejects(
      () => cloneRepository(fixture.root, source.bare, { name: '../escape' }),
      /Invalid name/,
    );
  } finally { fixture.cleanup(); }
});

test('generated AGENTS guidance and skills are deterministic and preserve user content', async () => {
  const fixture = temporaryWorkspace('ws-agent-files-');
  try {
    const workspace = initWorkspace(fixture.root);
    const paths = generateWorkspaceAgentFiles(workspace);
    const generatedPaths = [
      paths.agentsPath,
      join(paths.skills.navigation, 'SKILL.md'),
      join(paths.skills.navigation, 'agents', 'openai.yaml'),
      join(paths.skills.runs, 'SKILL.md'),
      join(paths.skills.runs, 'agents', 'openai.yaml'),
    ];
    const first = generatedPaths.map((path) => readFileSync(path, 'utf8'));
    generateWorkspaceAgentFiles(workspace);
    assert.deepEqual(generatedPaths.map((path) => readFileSync(path, 'utf8')), first);
    assert.match(first[2], /display_name:/);
    assert.match(first[4], /default_prompt: .*\$workspace-runs/);
    assert.match(first[1], /use its exact manifest `path`/);

    // A user-authored prefix remains intact while ws owns only its marked
    // section. The repository list is refreshed after registration.
    writeFileSync(paths.agentsPath, '# Human instructions\n\nKeep this paragraph.\n');
    const repo = await gitRepository(fixture.root, 'application');
    await addRepository(workspace, repo);
    const agents = readFileSync(paths.agentsPath, 'utf8');
    assert.match(agents, /^# Human instructions\n\nKeep this paragraph\.\n/);
    assert.match(agents, /`application` \(primary\)/);
    const refreshed = generatedPaths.map((path) => readFileSync(path, 'utf8'));
    generateWorkspaceAgentFiles(loadWorkspace(fixture.root));
    assert.deepEqual(generatedPaths.map((path) => readFileSync(path, 'utf8')), refreshed);
  } finally { fixture.cleanup(); }
});
