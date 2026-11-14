import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { initWorkspace, createAgentProfile } from '../src/workspace.js';
import { createComposition, addCompositionMember } from '../src/composition.js';
import { resolveCompositionContext, renderCompositionContext, verifyCompositionContext, canonicalJSON, contextHash } from '../src/composition-context.js';
import { openStore } from '../src/store.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'ws-context-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const [control, member, sibling] = ['control', 'member', 'sibling'].map((name) => {
    const path = join(root, name); mkdirSync(path); return initWorkspace(path, { name });
  });
  const repository = join(member.root, 'repos', 'app'); mkdirSync(repository);
  member.config.repositories = [{ name: 'app', path: 'repos/app', role: 'primary' }];
  writeFileSync(member.configPath, stringify(member.config));
  createComposition(control);
  addCompositionMember(control, 'member', member.root, { access: 'read-write' });
  addCompositionMember(control, 'sibling', sibling.root);
  writeFileSync(join(control.root, 'AGENTS.md'), 'COMPOSITION-CONTRACTS');
  writeFileSync(join(member.root, 'AGENTS.md'), 'MEMBER-RULES');
  writeFileSync(join(repository, 'AGENTS.md'), 'REPOSITORY-RULES');
  const skill = (workspace, name, text) => {
    const path = join(workspace.root, '.agents/skills', name); mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} description\n---\n${text}\n`);
  };
  skill(control, 'rust', 'COMPOSITION-SKILL-BODY');
  skill(member, 'rust', 'MEMBER-SKILL-BODY');
  skill(member, 'unused', 'UNUSED-SKILL-BODY');
  skill(sibling, 'private', 'SIBLING-PRIVATE-BODY');
  return { root, control, member, sibling, repository, request: { member: 'member', repository: 'app', grants: { read: ['instructions', 'context', 'skills'] } } };
}

test('context is deterministic, scoped, lazy and excludes unrelated member/private context', (t) => {
  const f = fixture(t);
  mkdirSync(join(f.repository, 'src/a'), { recursive: true });
  mkdirSync(join(f.repository, 'src/b'), { recursive: true });
  writeFileSync(join(f.repository, 'src/a/AGENTS.md'), 'A-RULES');
  writeFileSync(join(f.repository, 'src/b/AGENTS.md'), 'B-RULES');
  writeFileSync(join(f.member.workspaceDir, 'history', 'secret.md'), 'PRIVATE-HISTORY');
  const request = { ...f.request, paths: ['src/a/file.rs', 'src/a/other.rs'], skills: ['rust', `${f.member.config.id}:member:rust`] };
  const plan = resolveCompositionContext(f.control, request);
  assert.equal(plan.sha256, resolveCompositionContext(f.control, request).sha256);
  assert.equal(plan.valid, true);
  const serialized = JSON.parse(JSON.stringify(plan)); delete serialized.sha256;
  assert.equal(contextHash(canonicalJSON(serialized)), plan.sha256);
  const rendered = renderCompositionContext(plan);
  for (const marker of ['COMPOSITION-CONTRACTS', 'MEMBER-RULES', 'REPOSITORY-RULES', 'A-RULES', 'MEMBER-SKILL-BODY']) assert.ok(rendered.includes(marker), marker);
  for (const marker of ['B-RULES', 'SIBLING-PRIVATE-BODY', 'PRIVATE-HISTORY', 'UNUSED-SKILL-BODY', 'COMPOSITION-SKILL-BODY', 'unused description']) assert.ok(!rendered.includes(marker), marker);
  assert.equal(plan.sources.filter((source) => source.content.includes('MEMBER-SKILL-BODY')).length, 1);
  const instructionSources = plan.sources.filter((source) => source.kind === 'instructions');
  assert.deepEqual(instructionSources.map((source) => source.content), ['COMPOSITION-CONTRACTS', 'MEMBER-RULES', 'REPOSITORY-RULES', 'A-RULES']);
  assert.equal(plan.skills.filter((skill) => skill.name === 'rust').length, 2);
  assert.notEqual(plan.skills.filter((skill) => skill.name === 'rust')[0].id, plan.skills.filter((skill) => skill.name === 'rust')[1].id);
});

test('native overrides and root-to-path precedence survive composition', (t) => {
  const f = fixture(t);
  writeFileSync(join(f.repository, 'AGENTS.override.md'), 'OVERRIDE');
  const plan = resolveCompositionContext(f.control, f.request);
  assert.ok(plan.sources.some((source) => source.content === 'OVERRIDE'));
  assert.ok(!plan.sources.some((source) => source.content === 'REPOSITORY-RULES'));
});

test('grants exclude sources by default, reject private traversal and prevent symlink escape', (t) => {
  const f = fixture(t);
  const empty = resolveCompositionContext(f.control, { member: 'member', repository: 'app' });
  assert.deepEqual(empty.sources, []);
  assert.deepEqual(empty.skills, []);
  assert.throws(() => resolveCompositionContext(f.control, { ...f.request, grants: { read: ['private'] } }), /Unsupported read capability/);
  assert.throws(() => resolveCompositionContext(f.control, { ...f.request, paths: ['../private.txt'] }), /Invalid task path/);
  assert.throws(() => resolveCompositionContext(f.control, { ...f.request, shared: ['.workspace/history/secret.md'] }), /Shared context must belong/);
  assert.throws(() => resolveCompositionContext(f.control, { ...f.request, shared: ['.workspace/context/../agents/coder.yaml'] }), /Shared context must belong/);
  writeFileSync(join(f.member.workspaceDir, 'agents/private.yaml'), 'PRIVATE');
  symlinkSync(join(f.member.workspaceDir, 'agents/private.yaml'), join(f.member.workspaceDir, 'context/architecture.md.tmp'));
  assert.throws(() => resolveCompositionContext(f.control, { ...f.request, shared: ['.workspace/context/architecture.md.tmp'] }), /not found/);
  writeFileSync(join(f.root, 'outside.md'), 'PRIVATE');
  symlinkSync(join(f.root, 'outside.md'), join(f.control.workspaceDir, 'context/escape.md'));
  assert.throws(() => resolveCompositionContext(f.control, { ...f.request, shared: ['.workspace/context/escape.md'] }), /symlink/);
  rmSync(join(f.member.workspaceDir, 'context/architecture.md'));
  symlinkSync(join(f.member.workspaceDir, 'agents/private.yaml'), join(f.member.workspaceDir, 'context/architecture.md'));
  assert.throws(() => resolveCompositionContext(f.control, f.request), /symlink/);
  rmSync(join(f.member.workspaceDir, 'context/architecture.md'));
  writeFileSync(join(f.member.workspaceDir, 'context/architecture.md'), 'restored');
  const denied = resolveCompositionContext(f.control, { ...f.request, shared: ['.workspace/context/architecture.md'], grants: { read: [] } });
  assert.equal(denied.conflicts[0].kind, 'grant');
});

test('selected missing references and changed sources fail; unrelated offline members do not', (t) => {
  const f = fixture(t);
  rmSync(f.sibling.root, { recursive: true });
  const plan = resolveCompositionContext(f.control, f.request);
  assert.equal(plan.valid, true);
  assert.throws(() => resolveCompositionContext(f.control, { ...f.request, member: 'sibling' }), /config not found/);
  assert.throws(() => resolveCompositionContext(f.control, { ...f.request, skills: ['missing'] }), /missing or ambiguous/);
  assert.throws(() => resolveCompositionContext(f.control, { ...f.request, shared: ['.workspace/context/absent.md'] }), /not found/);
  writeFileSync(join(f.member.root, 'AGENTS.md'), 'CHANGED');
  assert.throws(() => verifyCompositionContext(plan), /context changed/);
});

test('nested access and profile conflicts name their policy sources, and profile skills reuse native discovery', (t) => {
  const f = fixture(t);
  createComposition(f.sibling);
  addCompositionMember(f.sibling, 'leaf', f.member.root, { access: 'read-write' });
  const nested = resolveCompositionContext(f.control, { ...f.request, member: 'sibling/leaf', grants: { read: [], write: true } });
  assert.equal(nested.access, 'read-only');
  assert.equal(nested.conflicts[0].kind, 'access');
  assert.match(nested.conflicts[0].sources[0], /composition.yaml#sibling.access/);
  createAgentProfile(f.member, 'restricted', { command: ['node'], mutation_scope: { repositories: ['another'] }, skills: ['rust'] });
  const request = { ...f.request, profile: 'restricted', grants: { read: ['skills'], start_agent: true, write: true } };
  const plan = resolveCompositionContext(f.control, request);
  assert.equal(plan.conflicts[0].kind, 'mutation_scope');
  assert.match(plan.conflicts[0].sources[0], /restricted.yaml/);
  assert.equal(plan.skills.find((skill) => skill.name === 'rust' && skill.scope === 'member').loaded, true);
  assert.ok(!JSON.stringify(plan).includes('mutation_scope:'));
  writeFileSync(join(f.member.workspaceDir, 'agents/restricted.yaml'), 'name: changed');
  assert.throws(() => verifyCompositionContext(plan), /context changed/);
});

test('read-only status store cannot migrate or modify member operational state', (t) => {
  const f = fixture(t);
  const writer = openStore(f.member); writer.createRun({ id: 'R-one', profile: 'coder' }); writer.close();
  const path = join(f.member.workspaceDir, 'runtime/workspace.db');
  const before = readFileSync(path);
  const reader = openStore(f.member, { readonly: true });
  assert.equal(reader.getRun('R-one').id, 'R-one');
  assert.throws(() => reader.createRun({ id: 'R-two', profile: 'coder' }), /readonly|read-only/i);
  reader.close(); assert.deepEqual(readFileSync(path), before);
  assert.equal(existsSync(join(f.control.workspaceDir, 'runtime/workspace.db')), false);
});

test('malformed unrelated skill metadata is diagnosed lazily instead of blocking a selected skill', (t) => {
  const f = fixture(t);
  writeFileSync(join(f.member.root, '.agents/skills/unused/SKILL.md'), '---\nname: [invalid\n---\nUNUSED');
  const plan = resolveCompositionContext(f.control, { ...f.request, skills: ['rust'] });
  assert.equal(plan.valid, true);
  assert.ok(plan.omitted.some((reason) => reason.includes('skill descriptor is invalid')));
  assert.throws(() => resolveCompositionContext(f.control, { ...f.request, skills: ['unused'] }), /missing or ambiguous/);
});

test('SQLite dispatcher leases reject concurrent owners, preserve token ownership and reclaim dead dispatchers', (t) => {
  const f = fixture(t); const store = openStore(f.control);
  t.after(() => store.close());
  store.acquireCompositionLease('task:step', 'first');
  assert.throws(() => store.acquireCompositionLease('task:step', 'second'), /already being dispatched/);
  assert.equal(store.releaseCompositionLease('task:step', 'wrong-token'), false);
  store.db.prepare('UPDATE composition_leases SET pid = ? WHERE key = ?').run(2147483647, 'task:step');
  store.acquireCompositionLease('task:step', 'replacement');
  assert.equal(store.releaseCompositionLease('task:step', 'first'), false);
  assert.equal(store.releaseCompositionLease('task:step', 'replacement'), true);
});
