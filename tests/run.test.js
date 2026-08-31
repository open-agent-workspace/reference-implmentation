import test from 'node:test';
import assert from 'node:assert/strict';
import { RunOrchestrator } from '../src/run.js';

function fixtures() {
  const records = [];
  const candidates = [];
  let profileLease;
  const store = {
    createRun(input) { const run = { ...input }; records.push(run); return run; },
    updateRun(id, patch) { Object.assign(records.find((item) => item.id === id), patch); },
    listRuns() { return records; },
    recordEvent() {},
    addRunRepository() {},
    createCandidate(input) { const candidate = { id: 'C1', ...input }; candidates.push(candidate); return candidate; },
    updateCandidate(id, patch) { Object.assign(candidates.find((item) => item.id === id), patch); },
    acquireProfileLease(profile, owner) {
      if (profileLease) throw new Error(`Agent profile ${profile} forbids concurrent runs (${profileLease})`);
      profileLease = owner;
      return { profile, owner };
    },
    releaseProfileLease(profile, owner) { if (profileLease === owner) profileLease = undefined; },
  };
  const gitCalls = [];
  const git = {
    async head(path) { return path.includes('secondary') ? 'deadbeef' : 'base1234'; },
    async isDirty() { return false; },
    async createWorktree(options) { gitCalls.push(options); return { worktreePath: '/tmp/fake-worktree', branch: options.branch }; },
    async finalizeCandidate(options) { return { ...options, repoName: 'primary', resultCommit: 'result1234', changed: true }; },
  };
  const resources = { async allocatePort(input) { return { ...input, kind: 'port', port: 43210 }; }, async releaseRunResources() {} };
  const agent = { async run() { return { success: true, exitCode: 0 }; } };
  const workspace = { root: '/tmp', config: { repositories: [
    { name: 'primary', path: 'primary', role: 'primary' },
    { name: 'secondary', path: 'secondary', role: 'secondary' },
  ] } };
  return { records, candidates, gitCalls, store, git, resources, agent, workspace, runtimeDir: '/tmp/runtime', get profileLease() { return profileLease; } };
}

test('run snapshots all repos but creates one writable primary worktree', async () => {
  const f = fixtures();
  const orchestrator = new RunOrchestrator({ ...f, profileResolver: async () => ({ name: 'coder', concurrency: 'allow', ports: [{ name: 'PORT' }] }), runtimeDir: '/tmp/runtime' });
  const run = await orchestrator.execute({ profile: 'coder', prompt: 'fake task', noIntegrate: true });
  assert.equal(run.status, 'CANDIDATE');
  assert.deepEqual(run.snapshot.repos.map((item) => item.name), ['primary', 'secondary']);
  assert.equal(f.gitCalls.length, 1);
  assert.equal(f.gitCalls[0].repoPath, '/tmp/primary');
  assert.equal(run.resources[0].name, 'PORT');
  assert.equal(f.candidates.length, 1);
});

test('forbid concurrency rejects an active profile before creating a run', async () => {
  const f = fixtures();
  f.records.push({ id: 'existing', profile: 'housekeeper', status: 'RUNNING' });
  const orchestrator = new RunOrchestrator({ ...f, profileResolver: async () => ({ name: 'housekeeper', concurrency: 'forbid' }) });
  await assert.rejects(() => orchestrator.execute({ profile: 'housekeeper', prompt: 'repeat' }), /forbids concurrent runs/);
  assert.equal(f.records.length, 1);
});

test('forbid profile uses and releases a durable profile lease', async () => {
  const f = fixtures();
  const orchestrator = new RunOrchestrator({
    ...f,
    profileResolver: async () => ({ name: 'housekeeper', concurrency: 'forbid' }),
  });
  const run = await orchestrator.execute({ profile: 'housekeeper', prompt: 'single pass', noIntegrate: true });
  assert.equal(run.status, 'CANDIDATE');
  assert.equal(f.profileLease, undefined, 'lease must be released at Run termination');
});

test('automatic integration failure marks both Run and Candidate', async () => {
  const f = fixtures();
  const orchestrator = new RunOrchestrator({
    ...f,
    profileResolver: async () => ({ name: 'coder', concurrency: 'allow' }),
    integration: { async integrate() { throw new Error('validation gate failed'); } },
  });
  await assert.rejects(() => orchestrator.execute({ profile: 'coder', prompt: 'bad candidate' }), /validation gate failed/);
  assert.equal(f.records[0].status, 'INTEGRATION_FAILED');
  assert.equal(f.candidates[0].status, 'INTEGRATION_FAILED');
  assert.match(f.candidates[0].metadata.integrationError, /validation gate failed/);
});
