import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const stringify = (value) => JSON.stringify(value, null, 2);
import { initWorkspace, addRepository, createAgentProfile, createComposition, addCompositionMember, removeCompositionMember, runGit, openStore, resolveCompositionContext } from '@agentic-workspace/core';
import { main } from '../src/cli.js';

async function call(cwd, ...args) {
  let output = '';
  try { await main([...args, '--json'], { cwd, stdout: { write: (value) => { output += value; } } }); }
  catch (error) { error.output = output; throw error; }
  return JSON.parse(output);
}
async function fixture(t, options: any = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ws-cd-flow-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const controlPath = join(root, 'control'); mkdirSync(controlPath);
  const control = initWorkspace(controlPath, { name: 'control' }); createComposition(control);
  writeFileSync(join(control.root, 'AGENTS.md'), 'INTEGRATION-GUIDANCE');
  writeFileSync(join(control.workspaceDir, 'context/command.md'), 'SHARED-COMMAND-CONTRACT');
  const members: any[] = [];
  for (const name of ['dashboard', 'firmware']) {
    const path = join(root, name); mkdirSync(path);
    const workspace = initWorkspace(path, { name });
    writeFileSync(join(path, 'AGENTS.md'), `${name}-WORKSPACE-INSTRUCTIONS`);
    const skillPath = join(path, '.agents/skills/selected'); mkdirSync(skillPath, { recursive: true });
    writeFileSync(join(skillPath, 'SKILL.md'), `---\nname: selected\ndescription: selected task skill\n---\n${name}-SELECTED-SKILL`);
    const unused = join(path, '.agents/skills/unused'); mkdirSync(unused, { recursive: true });
    writeFileSync(join(unused, 'SKILL.md'), `---\nname: unused\ndescription: unrelated skill\n---\n${name}-UNRELATED-SKILL`);
    const repository = join(path, 'repos/app'); mkdirSync(repository);
    await runGit(['init', '-qb', 'main', repository]);
    await runGit(['config', 'user.name', 'Composition Test'], { cwd: repository });
    await runGit(['config', 'user.email', 'composition@test.invalid'], { cwd: repository });
    writeFileSync(join(repository, 'AGENTS.md'), `${name}-REPO-INSTRUCTIONS`);
    writeFileSync(join(repository, 'README.md'), name);
    await runGit(['add', '.'], { cwd: repository }); await runGit(['commit', '-qm', 'base'], { cwd: repository });
    await addRepository(workspace, repository, { name: 'app' });
    // addRepository regenerates workspace guidance; retain a distinctive custom instruction.
    writeFileSync(join(path, 'AGENTS.md'), `${name}-WORKSPACE-INSTRUCTIONS`);
    const gate = join(root, `${name}-gate`);
    if (!options.fail) writeFileSync(gate, 'ready');
    const validationGate = join(root, `${name}-validation-gate`);
    if (!options.validationFail) writeFileSync(validationGate, 'ready');
    const command = [process.execPath, '-e', `const fs=require('node:fs'); if(!fs.existsSync(${JSON.stringify(gate)}))process.exit(2); setTimeout(()=>fs.writeFileSync('result.txt', process.env.WS_AGENT_INSTRUCTIONS), ${options.delay ?? 0});`];
    createAgentProfile(workspace, 'coder', { command, skills: ['selected'], mutation_scope: { repositories: ['app'] }, context_scope: { repositories: 'none' },
      validation: [[process.execPath, '-e', `if(!require('node:fs').existsSync('result.txt') || !require('node:fs').existsSync(${JSON.stringify(validationGate)}) ${options.requireScopedValidation ? "|| !process.env.WS_AGENT_INSTRUCTIONS?.includes('SHARED-COMMAND-CONTRACT')" : ''})process.exit(1)`]] });
    // This unavailable repository must never be snapshotted by a composition step.
    const config = workspace.config; config.repositories.push({ name: 'offline', path: 'repos/offline', context: false });
    writeFileSync(workspace.configPath, stringify(config));
    addCompositionMember(control, name, path, { access: 'read-write' });
    members.push({ workspace, repository, gate, validationGate });
  }
  writeFileSync(join(control.root, 'AGENTS.md'), 'INTEGRATION-GUIDANCE');
  const task: any = { version: 1, id: 'remote-focus', composition: control.config.id, objective: 'Route a button action',
    subtasks: members.map(({ workspace }, index) => ({ id: workspace.config.name, member: workspace.config.name, workspace_id: workspace.config.id,
      repository: 'app', profile: 'coder', objective: `Update ${workspace.config.name}`, depends_on: index ? ['dashboard'] : [],
      context: { shared: ['.workspace/context/command.md'] },
      grants: { read: ['instructions', 'context', 'skills', 'source'], write: true, start_agent: true, read_status: true } })) };
  const path = join(control.root, 'task.yaml'); writeFileSync(path, stringify(task));
  return { root, control, members, task, path };
}

test('real member Runs receive scoped context and independent Candidates; dependency gates require integration', async (t) => {
  const f = await fixture(t);
  const first = f.members[0]; const second = f.members[1];
  const manifestBytes = f.members.map(({ workspace }) => readFileSync(workspace.configPath, 'utf8'));
  assert.equal((await call(f.control.root, 'compose', 'task', 'validate', f.path)).valid, true);
  assert.equal((await call(f.control.root, 'compose', 'task', 'inspect', f.path)).status, 'BLOCKED');
  for (const { workspace } of f.members) assert.equal(existsSync(join(workspace.workspaceDir, 'runtime/workspace.db')), false);
  const plan = await call(f.control.root, 'compose', 'task', 'context', f.path, '--step', 'dashboard');
  const started = await call(f.control.root, 'compose', 'task', 'run', f.path, '--step', 'dashboard', '--expect-context', plan.sha256);
  assert.equal(started.status, 'CANDIDATE');
  const inspected = await call(first.workspace.root, 'inspect', started.candidate);
  const body = readFileSync(join(inspected.run.worktree_path, 'result.txt'), 'utf8');
  for (const expected of ['INTEGRATION-GUIDANCE', 'dashboard-WORKSPACE-INSTRUCTIONS', 'dashboard-REPO-INSTRUCTIONS', 'dashboard-SELECTED-SKILL']) assert.ok(body.includes(expected), expected);
  for (const forbidden of ['firmware-WORKSPACE-INSTRUCTIONS', 'firmware-SELECTED-SKILL', 'UNRELATED-SKILL', 'unrelated skill']) assert.ok(!body.includes(forbidden), forbidden);
  assert.equal(body.split('SHARED-COMMAND-CONTRACT').length - 1, 1);
  assert.equal(inspected.run.context_paths_json.length, 0);
  assert.deepEqual(inspected.run.snapshot.repos.map((repo) => repo.name), ['app']);
  assert.equal(existsSync(join(first.repository, 'result.txt')), false);
  assert.equal((await call(f.control.root, 'compose', 'task', 'run', f.path, '--step', 'dashboard')).run, started.run);
  await assert.rejects(() => call(f.control.root, 'compose', 'task', 'run', f.path, '--step', 'firmware'), /Dependency must be integrated/);
  assert.equal((await call(f.control.root, 'compose', 'task', 'inspect', f.path)).status, 'PARTIAL');
  await call(first.workspace.root, 'integrate', started.candidate);
  const next = await call(f.control.root, 'compose', 'task', 'run', f.path, '--step', 'firmware');
  assert.notEqual(next.run, started.run); assert.notEqual(next.candidate, started.candidate);
  await call(second.workspace.root, 'integrate', next.candidate);
  assert.equal((await call(f.control.root, 'compose', 'task', 'inspect', f.path)).status, 'INTEGRATED');
  assert.deepEqual(f.members.map(({ workspace }) => readFileSync(workspace.configPath, 'utf8')), manifestBytes);
  assert.equal((await call(first.workspace.root, 'runs')).length, 1);
  const history = join(first.workspace.workspaceDir, 'history/runs', `${started.run}.yaml`);
  assert.ok(existsSync(history));
  assert.ok(readFileSync(history, 'utf8').includes('remote-focus'));
});

test('failed attempts are durable, repeated attempts do not relaunch, and explicit retry preserves both Runs', async (t) => {
  const f = await fixture(t, { fail: true });
  let failed;
  await assert.rejects(async () => { try { await call(f.control.root, 'compose', 'task', 'run', f.path, '--step', 'dashboard'); } catch (error) { failed = JSON.parse(error.output); throw error; } }, /FAILED/);
  assert.equal(failed.status, 'FAILED');
  assert.ok(existsSync(join(f.members[0].workspace.workspaceDir, 'history/runs', `${failed.run}.yaml`)));
  writeFileSync(f.members[0].gate, 'ready');
  await assert.rejects(() => call(f.control.root, 'compose', 'task', 'run', f.path, '--step', 'dashboard'), /FAILED/);
  const retried = await call(f.control.root, 'compose', 'task', 'run', f.path, '--step', 'dashboard', '--attempt', '2');
  assert.equal(retried.status, 'CANDIDATE'); assert.notEqual(retried.run, failed.run);
  const inspection = await call(f.control.root, 'compose', 'task', 'inspect', f.path);
  assert.deepEqual(inspection.subtasks[0].attempts.map((attempt) => attempt.status), ['FAILED', 'CANDIDATE']);
  await assert.rejects(() => call(f.control.root, 'compose', 'task', 'run', f.path, '--step', 'dashboard', '--attempt', '3'), /preserve unresolved Candidates/);
});

test('offline members show stale cached results while unrelated member context stays available', async (t) => {
  const f = await fixture(t);
  const started = await call(f.control.root, 'compose', 'task', 'run', f.path, '--step', 'dashboard');
  renameSync(f.members[0].workspace.root, join(f.root, 'offline-dashboard'));
  const inspection = await call(f.control.root, 'compose', 'task', 'inspect', f.path);
  assert.equal(inspection.stale, true);
  assert.equal(inspection.subtasks[0].stale, true);
  assert.equal(inspection.subtasks[0].attempts[0].candidate, started.candidate);
  const other = resolveCompositionContext(f.control, { member: 'firmware', repository: 'app', grants: { read: ['instructions'] } });
  assert.equal(other.valid, true);
});

test('dispatch grants, profile constraints, context hashes and pinned identities are checked before agent startup', async (t) => {
  const f = await fixture(t);
  const original = structuredClone(f.task);
  for (const grant of ['write', 'start_agent', 'read_status']) {
    f.task = structuredClone(original); f.task.subtasks[0].grants[grant] = false; writeFileSync(f.path, stringify(f.task));
    await assert.rejects(() => call(f.control.root, 'compose', 'task', 'run', f.path, '--step', 'dashboard'), /explicit.*grants/);
  }
  f.task = structuredClone(original); f.task.subtasks[0].workspace_id = 'impostor'; writeFileSync(f.path, stringify(f.task));
  await assert.rejects(() => call(f.control.root, 'compose', 'task', 'run', f.path, '--step', 'dashboard'), /identity mismatch/);
  f.task = structuredClone(original); writeFileSync(f.path, stringify(f.task));
  await assert.rejects(() => call(f.control.root, 'compose', 'task', 'run', f.path, '--step', 'dashboard', '--expect-context', 'wrong'), /differs from expected hash/);
  assert.equal(existsSync(join(f.members[0].workspace.workspaceDir, 'runtime/workspace.db')), false);
});

test('Task definition cycles, unknown dependencies and changing intent after an attempt are rejected', async (t) => {
  const f = await fixture(t);
  const original = structuredClone(f.task);
  f.task.subtasks[0].depends_on = ['firmware']; writeFileSync(f.path, stringify(f.task));
  await assert.rejects(() => call(f.control.root, 'compose', 'task', 'validate', f.path), /dependency cycle/);
  f.task = structuredClone(original); f.task.subtasks[0].depends_on = ['missing']; writeFileSync(f.path, stringify(f.task));
  await assert.rejects(() => call(f.control.root, 'compose', 'task', 'validate', f.path), /Unknown subtask dependency/);
  f.task = structuredClone(original); writeFileSync(f.path, stringify(f.task));
  await call(f.control.root, 'compose', 'task', 'run', f.path, '--step', 'dashboard');
  f.task.subtasks[1].objective = 'Changed caller intent'; writeFileSync(f.path, stringify(f.task));
  await assert.rejects(() => call(f.control.root, 'compose', 'task', 'run', f.path, '--step', 'firmware'), /Task definition changed/);
});

test('concurrent dispatch of the same subtask cannot launch duplicate member agents', async (t) => {
  const f = await fixture(t, { delay: 300 });
  const pending = call(f.control.root, 'compose', 'task', 'run', f.path, '--step', 'dashboard');
  // dispatch acquires its durable lease before the first asynchronous agent step.
  await assert.rejects(() => call(f.control.root, 'compose', 'task', 'run', f.path, '--step', 'dashboard'), /already being dispatched/);
  assert.equal((await pending).status, 'CANDIDATE');
  assert.equal((await call(f.members[0].workspace.root, 'runs')).length, 1);
});

test('reconciliation and explicit retry recover an interrupted attempt without deleting its worktree', async (t) => {
  const f = await fixture(t, { fail: true });
  let failed;
  try { await call(f.control.root, 'compose', 'task', 'run', f.path, '--step', 'dashboard'); } catch (error) { failed = JSON.parse(error.output); }
  const store = openStore(f.members[0].workspace);
  const run = store.getRun(failed.run);
  const preserved = run.worktree_path;
  store.updateRun(failed.run, { status: 'PREPARING', intent: { ...run.intent, execution_owner: { pid: 2147483647 } } });
  store.close();
  await call(f.members[0].workspace.root, 'status', '--reconcile');
  const inspection = await call(f.control.root, 'compose', 'task', 'inspect', f.path);
  assert.equal(inspection.subtasks[0].status, 'ORPHANED');
  assert.equal(existsSync(preserved), true);
  writeFileSync(f.members[0].gate, 'ready');
  assert.equal((await call(f.control.root, 'compose', 'task', 'run', f.path, '--step', 'dashboard', '--attempt', '2')).status, 'CANDIDATE');
  assert.equal(existsSync(preserved), true);
});

test('separate CLI processes recover the same attempt from persisted Run and journal state', async (t) => {
  const f = await fixture(t);
  const bin = fileURLToPath(new URL('../../bin/ws.js', import.meta.url));
  const external = (...args) => JSON.parse(execFileSync(process.execPath, [bin, ...args, '--json'], { cwd: f.control.root, encoding: 'utf8' }));
  const first = external('compose', 'task', 'run', f.path, '--step', 'dashboard');
  const repeated = external('compose', 'task', 'run', f.path, '--step', 'dashboard');
  assert.equal(first.run, repeated.run);
  assert.equal(first.candidate, repeated.candidate);
  assert.equal(external('compose', 'task', 'inspect', f.path).subtasks[0].attempts.length, 1);
});

test('failed member validation blocks Candidates and dependent steps, then an explicit retry can recover', async (t) => {
  const f = await fixture(t, { validationFail: true });
  let failed;
  try { await call(f.control.root, 'compose', 'task', 'run', f.path, '--step', 'dashboard'); } catch (error) { failed = JSON.parse(error.output); }
  assert.equal(failed.status, 'FAILED');
  assert.equal(failed.candidate, null);
  assert.equal(failed.validation.success, false);
  assert.equal(failed.validation.commands.length, 1);
  assert.equal('command' in failed.validation.commands[0], false);
  const inspected = await call(f.members[0].workspace.root, 'inspect', failed.run);
  assert.ok(existsSync(join(inspected.run.worktree_path, 'result.txt')));
  await assert.rejects(() => call(f.control.root, 'compose', 'task', 'run', f.path, '--step', 'firmware'), /Dependency must be integrated/);
  writeFileSync(f.members[0].validationGate, 'ready');
  assert.equal((await call(f.control.root, 'compose', 'task', 'run', f.path, '--step', 'dashboard', '--attempt', '2')).status, 'CANDIDATE');
});

test('membership read-only ceilings block dispatch even with caller write grants', async (t) => {
  const f = await fixture(t);
  removeCompositionMember(f.control, 'dashboard');
  addCompositionMember(f.control, 'dashboard', f.members[0].workspace.root);
  await assert.rejects(() => call(f.control.root, 'compose', 'task', 'run', f.path, '--step', 'dashboard'), /membership denies write/);
  assert.equal(existsSync(join(f.members[0].workspace.workspaceDir, 'runtime/workspace.db')), false);
});

test('integration validation reuses the reviewed scoped context and refuses changed contract sources', async (t) => {
  const f = await fixture(t, { requireScopedValidation: true });
  const started = await call(f.control.root, 'compose', 'task', 'run', f.path, '--step', 'dashboard');
  writeFileSync(join(f.control.workspaceDir, 'context/command.md'), 'CHANGED-CONTRACT');
  await assert.rejects(() => call(f.members[0].workspace.root, 'integrate', started.candidate), /context changed/);
  assert.equal(existsSync(join(f.members[0].repository, 'result.txt')), false);
  writeFileSync(join(f.control.workspaceDir, 'context/command.md'), 'SHARED-COMMAND-CONTRACT');
  assert.equal((await call(f.members[0].workspace.root, 'integrate', started.candidate)).status, 'INTEGRATED');
});

test('reconciled orphaned Runs with unresolved Candidates cannot be superseded by a retry', async (t) => {
  const f = await fixture(t);
  const started = await call(f.control.root, 'compose', 'task', 'run', f.path, '--step', 'dashboard');
  const store = openStore(f.members[0].workspace);
  store.updateRun(started.run, { status: 'ORPHANED' }); store.close();
  await assert.rejects(() => call(f.control.root, 'compose', 'task', 'run', f.path, '--step', 'dashboard', '--attempt', '2'), /preserve unresolved Candidates/);
});
