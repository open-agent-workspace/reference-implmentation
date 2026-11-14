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
  const f: any = fixtures();
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

test('context-only repository mutation fails the Run and preserves the worktree', async () => {
  const f: any = fixtures();
  f.git.createContextWorktree = async () => ({ worktreePath: '/tmp/context-secondary' });
  f.git.isDirty = async (path) => path === '/tmp/context-secondary';
  const orchestrator = new RunOrchestrator({
    ...f,
    profileResolver: async () => ({ name: 'coder', concurrency: 'allow' }),
  });
  await assert.rejects(
    () => orchestrator.execute({ profile: 'coder', prompt: 'unsafe context edit', noIntegrate: true }),
    /modified context-only repository secondary/,
  );
  assert.equal(f.records[0].status, 'FAILED');
  assert.equal(f.candidates.length, 0);
  assert.equal(f.records[0].worktree, '/tmp/fake-worktree');
});

test('cancel stops the agent, transitions the Run, and releases resources', async () => {
  const run = { id: 'R-cancel', status: 'RUNNING' };
  const calls = [];
  const orchestrator = new RunOrchestrator({
    store: {
      getRun: () => run,
      updateRun: (_id, patch) => Object.assign(run, patch),
      recordEvent: (event) => calls.push(event.type),
    },
    agent: { stop: async (runId) => calls.push(`stop:${runId}`) },
    resources: { releaseRunResources: async (runId) => calls.push(`release:${runId}`) },
  });
  assert.equal((await orchestrator.cancel(run.id)).status, 'CANCELLED');
  assert.deepEqual(calls, ['run.cancelled', 'stop:R-cancel', 'release:R-cancel']);
});

test('reconcile marks an active Run orphaned when its owned process disappears', async () => {
  const run: any = { id: 'R-orphan', status: 'RUNNING' };
  const orchestrator = new RunOrchestrator({
    store: {
      getRun: () => run,
      updateRun: (_id, patch) => Object.assign(run, patch),
      recordEvent() {},
    },
    resources: { reconcile: async () => [run.id] },
  });
  assert.deepEqual(await orchestrator.reconcile(), [run.id]);
  assert.equal(run.status, 'ORPHANED');
  assert.equal(run.error, 'Owned process disappeared');
});

test('only selected repositories are snapshotted; unavailable unrelated registrations cannot block a narrow Run', async () => {
  const f: any = fixtures();
  f.git.head = async (path) => { if (path.includes('secondary')) throw new Error('unavailable'); return 'base'; };
  const runner = new RunOrchestrator({ ...f, profileResolver: async () => ({ name: 'coder', context_scope: { repositories: 'none' } }) });
  const run = await runner.execute({ profile: 'coder', repo: 'primary', contextRepos: 'none', noIntegrate: true });
  assert.deepEqual(run.snapshot.repos.map((item) => item.name), ['primary']);
});

test('explicit repository selectors cannot expand mutation or context profile scopes', async () => {
  const f: any = fixtures();
  const runner = new RunOrchestrator({ ...f, profileResolver: async () => ({ name: 'coder', mutation_scope: { repositories: 'primary' }, context_scope: { repositories: 'none' } }) });
  await assert.rejects(() => runner.execute({ profile: 'coder', repo: 'secondary' }), /mutation scope/);
  await assert.rejects(() => runner.execute({ profile: 'coder', repo: 'primary', contextRepos: ['secondary'] }), /context scope/);
  assert.equal(f.records.length, 0);
});

test('pending Candidates and agent failures both retain durable Run evidence', async () => {
  const f: any = fixtures(); const durable = [];
  const runner = new RunOrchestrator({ ...f, profileResolver: async () => ({ name: 'coder' }), knowledge: { recordDurableRun: async (run) => durable.push({ ...run }) } });
  await runner.execute({ profile: 'coder', noIntegrate: true });
  f.agent.run = async () => ({ success: false, exitCode: 1 });
  await assert.rejects(() => runner.execute({ profile: 'coder', noIntegrate: true }), /exit code 1/);
  assert.deepEqual(durable.map((run) => run.status), ['CANDIDATE', 'FAILED']);
  assert.ok(durable.every((run) => run.finishedAt));
});

test('reconciliation recovers a dispatcher that disappeared before process launch, but preserves a live child', async () => {
  const f: any = fixtures();
  f.records.push({ id: 'R-abandoned', profile: 'coder', status: 'PREPARING', intent: { execution_owner: { pid: 2147483647 } } });
  f.records.push({ id: 'R-live-child', profile: 'coder', status: 'RUNNING', intent: { execution_owner: { pid: 2147483647 } } });
  f.store.getRun = (id) => f.records.find((run) => run.id === id);
  f.store.listProcesses = ({ runId }) => runId === 'R-live-child' ? [{ pid: process.pid }] : [];
  const runner = new RunOrchestrator(f);
  assert.deepEqual(await runner.reconcile(), ['R-abandoned']);
  assert.equal(f.records[0].status, 'ORPHANED');
  assert.equal(f.records[1].status, 'RUNNING');
});

test('a profile may allow several targets while each Run still mutates one selected repository', async () => {
  const f: any = fixtures();
  const runner = new RunOrchestrator({ ...f, profileResolver: async () => ({ name: 'coder', mutation_scope: { repositories: ['primary', 'secondary'] } }) });
  await runner.execute({ profile: 'coder', repo: 'secondary', contextRepos: 'none', noIntegrate: true });
  assert.equal(f.gitCalls.length, 1);
  assert.equal(f.gitCalls[0].repoPath, '/tmp/secondary');
});

test('an agent completion cannot overwrite a cancellation requested during execution', async () => {
  const f: any = fixtures();
  f.store.getRun = (id) => f.records.find((run) => run.id === id);
  const runner = new RunOrchestrator({ ...f, profileResolver: async () => ({ name: 'coder' }) });
  f.agent.run = async ({ run }) => { await runner.cancel(run.id); return { success: true }; };
  await assert.rejects(() => runner.execute({ profile: 'coder', noIntegrate: true }), /cancelled/);
  assert.equal(f.records[0].status, 'CANCELLED');
  assert.equal(f.candidates.length, 0);
});

test('the member Run boundary independently rejects composition context without dispatch grants', async () => {
  const f: any = fixtures();
  const runner = new RunOrchestrator({ ...f, profileResolver: async () => ({ name: 'coder' }) });
  await assert.rejects(() => runner.execute({ profile: 'coder', resolvedContext: { grants: { read: ['source'], write: true }, access: 'read-write' } }), /lacks dispatch grants/);
  assert.equal(f.records.length, 0);
});
