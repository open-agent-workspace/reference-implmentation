import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { OperationalStore } from '../src/store.js';

function temporaryStore() {
  const root = mkdtempSync(join(tmpdir(), 'ws-store-'));
  const store = new OperationalStore(join(root, 'runtime', 'workspace.db'));
  return { root, store };
}

test('SQLite store migrates schema and round-trips runs, repositories, candidates and events', () => {
  const { root, store } = temporaryStore();
  try {
    const run = store.createRun({ profile: 'coder', purpose: 'fix auth', intent: { write_scope: ['src/**'] }, snapshot: { app: 'abc' } });
    assert.equal(run.status, 'CREATED');
    assert.deepEqual(run.intent_json, { write_scope: ['src/**'] });
    store.addRunRepository(run.id, { name: 'app', path: '/tmp/app', mutation: true, context: true, baseCommit: 'abc' });
    assert.equal(store.listRunRepositories(run.id)[0].mutation, true);
    const candidate = store.createCandidate({ runId: run.id, repoName: 'app', baseCommit: 'abc', validation: { passed: true } });
    assert.deepEqual(store.getCandidate(candidate.id).validation_json, { passed: true });
    const event = store.recordEvent({ runId: run.id, type: 'candidate.created', payload: { candidate: candidate.id } });
    assert.deepEqual(store.getEvent(event.id).payload_json, { candidate: candidate.id });
    assert.equal(store.listRuns({ status: 'CREATED' }).length, 1);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test('resources reject active collisions and integration lock is owner-safe', () => {
  const { root, store } = temporaryStore();
  try {
    const run = store.createRun({ id: 'R1', profile: 'coder' });
    const resource = store.allocateResource({ runId: run.id, type: 'port', value: 43127 });
    assert.throws(() => store.allocateResource({ runId: run.id, type: 'port', value: 43127 }), /already allocated/);
    store.releaseResource(resource.id);
    assert.equal(store.allocateResource({ runId: run.id, type: 'port', value: 43127 }).value, '43127');
    assert.equal(store.acquireIntegrationLock('owner-a').owner, 'owner-a');
    assert.throws(() => store.acquireIntegrationLock('owner-b'), /held by owner-a/);
    assert.throws(() => store.releaseIntegrationLock('owner-b'), /does not match/);
    assert.equal(store.releaseIntegrationLock('owner-a'), true);
    assert.equal(store.acquireIntegrationLock('owner-b').owner, 'owner-b');
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test('profile leases are exclusive and stale owners can be reclaimed', () => {
  const { root, store } = temporaryStore();
  try {
    store.createRun({ id: 'R-live', profile: 'housekeeper', status: 'RUNNING' });
    store.acquireProfileLease('housekeeper', 'R-live');
    assert.throws(
      () => store.acquireProfileLease('housekeeper', 'R-next'),
      /forbids concurrent runs/,
    );

    store.updateRunStatus('R-live', 'FAILED');
    assert.deepEqual(store.acquireProfileLease('housekeeper', 'R-next'), {
      profile: 'housekeeper', owner: 'R-next',
    });
    assert.equal(store.listProfileLeases()[0].owner, 'R-next');

    // A lease whose Run disappeared is stale and must not block recovery.
    store.acquireProfileLease('missing-profile', 'R-missing');
    assert.deepEqual(store.acquireProfileLease('missing-profile', 'R-replacement'), {
      profile: 'missing-profile', owner: 'R-replacement',
    });
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test('integration lock recovery reclaims only locks with no active integrating Run', () => {
  const { root, store } = temporaryStore();
  try {
    store.acquireIntegrationLock('crashed-owner');
    const recovered = store.recoverIntegrationLock();
    assert.equal(recovered.owner, 'crashed-owner');
    assert.equal(store.integrationLock().owner, null);

    store.createRun({ id: 'R-integrating', profile: 'coder', status: 'INTEGRATING' });
    store.acquireIntegrationLock('active-owner');
    assert.equal(store.recoverIntegrationLock(), null);
    assert.equal(store.integrationLock().owner, 'active-owner');

    store.updateRunStatus('R-integrating', 'FAILED');
    assert.equal(store.recoverIntegrationLock().owner, 'active-owner');
    assert.equal(store.integrationLock().owner, null);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
