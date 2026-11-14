import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { initWorkspace, loadWorkspace, discoverWorkspace } from '../src/workspace.js';
import { addCompositionMember, createComposition, inspectComposition, loadComposition, relocateCompositionMember,
  removeCompositionMember, validateComposition } from '../src/composition.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'ws-composition-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspaces = ['control', 'dashboard', 'companion', 'esp32', 'other'].map((name) => {
    const path = join(root, name);
    mkdirSync(path);
    return initWorkspace(path, { name });
  });
  return { root, workspaces };
}
function bytes(workspace) { return readFileSync(workspace.configPath, 'utf8'); }
function path(workspace) { return join(workspace.workspaceDir, 'composition.yaml'); }

test('composition references independently usable workspaces, stores relative locators and never copies data', (t) => {
  const { workspaces: [control, dashboard, companion, , other] } = fixture(t);
  const before = [bytes(control), bytes(dashboard), bytes(companion)];
  createComposition(control, 'Agent Control System');
  addCompositionMember(control, 'dashboard', dashboard.root, { role: 'Routes commands' });
  addCompositionMember(control, 'companion', '../companion', { access: 'read-write' });
  createComposition(other);
  addCompositionMember(other, 'web', dashboard.root);
  const composition = loadComposition(control);
  assert.equal(composition.workspace_id, control.config.id);
  assert.deepEqual(composition.members.map((member) => [member.alias, member.path, member.access]), [
    ['dashboard', '../dashboard', 'read-only'], ['companion', '../companion', 'read-write'],
  ]);
  assert.deepEqual([bytes(control), bytes(dashboard), bytes(companion)], before);
  assert.equal(discoverWorkspace(dashboard.root).config.id, dashboard.config.id);
  assert.equal(inspectComposition(control).members[0].name, 'dashboard');
  assert.equal(existsSync(join(control.root, 'repos', 'dashboard')), false);
  assert.deepEqual(validateComposition(control), { valid: true, errors: [] });
  removeCompositionMember(control, 'dashboard');
  assert.equal(loadWorkspace(dashboard.root).config.id, dashboard.config.id);
  assert.equal(inspectComposition(other).members[0].status, 'available');
});

test('missing, replaced and relocated members remain inspectable and removable without identity rebinding', (t) => {
  const { root, workspaces: [control, dashboard, companion] } = fixture(t);
  createComposition(control);
  addCompositionMember(control, 'dashboard', dashboard.root);
  renameSync(dashboard.root, join(root, 'moved'));
  assert.equal(inspectComposition(control).members[0].status, 'unresolved');
  assert.match(validateComposition(control).errors[0], /dashboard/);
  assert.throws(() => relocateCompositionMember(control, 'dashboard', companion.root), /Identity mismatch/);
  relocateCompositionMember(control, 'dashboard', '../moved');
  assert.equal(validateComposition(control).valid, true);
  const replacement = loadWorkspace(join(root, 'moved'));
  const config = parse(bytes(replacement));
  config.id = 'replacement';
  writeFileSync(replacement.configPath, stringify(config));
  assert.match(inspectComposition(control).members[0].error, /Identity mismatch/);
  removeCompositionMember(control, 'dashboard');
  assert.deepEqual(loadComposition(control).members, []);
  assert.equal(existsSync(replacement.configPath), true);
});

test('nested composition supports shared descendants, detects cycles, and rolls back rejected changes', (t) => {
  const { workspaces: [control, dashboard, companion, esp32] } = fixture(t);
  for (const workspace of [control, dashboard, companion, esp32]) createComposition(workspace);
  addCompositionMember(dashboard, 'device', esp32.root);
  addCompositionMember(companion, 'device', esp32.root);
  addCompositionMember(control, 'dashboard', dashboard.root);
  addCompositionMember(control, 'companion', companion.root);
  assert.equal(validateComposition(control).valid, true);
  assert.equal(inspectComposition(control).members[0].members[0].workspace_id, esp32.config.id);
  const before = readFileSync(path(esp32), 'utf8');
  assert.throws(() => addCompositionMember(esp32, 'control', control.root), /cycle/);
  assert.equal(readFileSync(path(esp32), 'utf8'), before);
  assert.throws(() => addCompositionMember(control, 'self', control.root), /cycle/);
  // A cycle introduced by a synchronized/manual edit is still diagnosed at read time.
  const value = loadComposition(esp32);
  value.members.push({ alias: 'control', workspace_id: control.config.id, path: '../control', access: 'read-only' });
  writeFileSync(path(esp32), stringify(value));
  assert.match(validateComposition(control).errors.join(' '), /cycle/);
});

test('aliases, identities and permissions are validated without modifying the previous declaration', (t) => {
  const { workspaces: [control, dashboard, companion] } = fixture(t);
  createComposition(control);
  addCompositionMember(control, 'web', dashboard.root);
  const before = readFileSync(path(control), 'utf8');
  assert.throws(() => addCompositionMember(control, 'web', companion.root), /Duplicate member alias/);
  assert.throws(() => addCompositionMember(control, 'duplicate', dashboard.root), /Duplicate member workspace ID/);
  assert.throws(() => addCompositionMember(control, 'bad/path', companion.root), /Alias/);
  assert.throws(() => addCompositionMember(control, 'desktop', companion.root, { access: 'admin' }), /access/);
  assert.throws(() => removeCompositionMember(control, 'absent'), /not found/);
  assert.throws(() => createComposition(control), /already exists/);
  assert.equal(readFileSync(path(control), 'utf8'), before);
});

test('standalone manifests need no migration and invalid composition files produce diagnostics', (t) => {
  const { workspaces: [control, dashboard] } = fixture(t);
  assert.equal(existsSync(path(dashboard)), false);
  assert.equal(loadWorkspace(dashboard.root).config.id, dashboard.config.id);
  writeFileSync(path(control), 'version: [broken');
  assert.equal(validateComposition(control).valid, false);
  createComposition(dashboard);
  for (const value of [
    { ...loadComposition(dashboard), version: 99 },
    { ...loadComposition(dashboard), workspace_id: 'other-owner' },
    { ...loadComposition(dashboard), members: {} },
    { ...loadComposition(dashboard), members: [null] },
  ]) {
    writeFileSync(path(control), stringify(value));
    assert.equal(validateComposition(control).valid, false);
  }
});

test('exclusive mutation lock prevents lost updates and interrupted writers leave the manifest readable', (t) => {
  const { workspaces: [control, dashboard] } = fixture(t);
  createComposition(control);
  writeFileSync(`${path(control)}.lock`, 'interrupted writer');
  assert.throws(() => addCompositionMember(control, 'web', dashboard.root), /locked/);
  assert.equal(validateComposition(control).valid, true);
  rmSync(`${path(control)}.lock`);
  addCompositionMember(control, 'web', dashboard.root);
  assert.equal(validateComposition(control).valid, true);
  assert.equal(existsSync(`${path(control)}.lock`), false);
});

test('member lookup uses exact roots rather than ancestor workspace discovery', (t) => {
  const { workspaces: [control, dashboard] } = fixture(t);
  createComposition(control);
  mkdirSync(join(dashboard.root, 'nested'));
  assert.throws(() => addCompositionMember(control, 'web', join(dashboard.root, 'nested')), /config not found/);
});

test('unavailable unrelated members do not prevent adding, inspecting or removing available siblings', (t) => {
  const { root, workspaces: [control, dashboard, companion] } = fixture(t);
  createComposition(control);
  addCompositionMember(control, 'web', dashboard.root);
  renameSync(dashboard.root, join(root, 'offline'));
  addCompositionMember(control, 'desktop', companion.root);
  const result = inspectComposition(control);
  assert.equal(result.valid, false);
  assert.deepEqual(result.members.map((member) => member.status), ['unresolved', 'available']);
  removeCompositionMember(control, 'web');
  assert.equal(validateComposition(control).valid, true);
});

test('relative layouts survive relocation together and absolute locators verify identity', (t) => {
  const { root, workspaces: [control, dashboard] } = fixture(t);
  createComposition(control);
  addCompositionMember(control, 'web', dashboard.root);
  const moved = `${root}-moved`;
  renameSync(root, moved);
  t.after(() => rmSync(moved, { recursive: true, force: true }));
  const relocated = loadWorkspace(join(moved, 'control'));
  assert.equal(validateComposition(relocated).valid, true);
  const value = loadComposition(relocated);
  value.members[0].path = join(moved, 'dashboard');
  writeFileSync(path(relocated), stringify(value));
  assert.equal(validateComposition(relocated).valid, true);
});
