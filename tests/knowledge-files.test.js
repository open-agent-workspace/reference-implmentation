import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { parse as parseYaml } from 'yaml';
import { FileKnowledgeProvider } from '../src/providers/knowledge-files.js';

test('durable run summaries survive as Git-friendly YAML files', async (t) => {
  const workspaceDir = await mkdtemp(join(tmpdir(), 'ws-knowledge-'));
  t.after(() => rm(workspaceDir, { recursive: true, force: true }));
  const provider = new FileKnowledgeProvider({ workspaceDir });
  const result = await provider.recordDurableRun(
    {
      id: 'R-42', profile: 'coder', objective: 'fix auth', primaryRepo: 'frontend', status: 'COMPLETED',
      intent: { writeScope: ['src/auth/**'] }, snapshot: { repos: [{ name: 'frontend', commit: 'abc' }] },
    },
    { id: 'C-42', repo: 'frontend', baseCommit: 'abc', resultCommit: 'def', status: 'INTEGRATED', validation: { passed: true } },
  );
  assert.equal(result.path, join(workspaceDir, 'history', 'runs', 'R-42.yaml'));
  const record = parseYaml(await readFile(result.path, 'utf8'));
  assert.equal(record.version, 1);
  assert.equal(record.run, 'R-42');
  assert.equal(record.purpose, 'fix auth');
  assert.deepEqual(record.intent, { writeScope: ['src/auth/**'] });
  assert.equal(record.candidate.result_commit, 'def');
});

test('knowledge proposals are reviewable YAML with proposed status', async (t) => {
  const workspaceDir = await mkdtemp(join(tmpdir(), 'ws-proposals-'));
  t.after(() => rm(workspaceDir, { recursive: true, force: true }));
  const provider = new FileKnowledgeProvider({ workspaceDir });
  const result = await provider.propose({
    id: 'P-auth-refresh', runId: 'R-42', kind: 'architecture',
    title: 'Refresh tokens use the identity service', body: 'Keep refresh-token ownership in identity.',
  });
  assert.equal(result.path, join(workspaceDir, 'proposals', 'P-auth-refresh.yaml'));
  const proposal = parseYaml(await readFile(result.path, 'utf8'));
  assert.deepEqual(proposal, result.proposal);
  assert.equal(proposal.status, 'proposed');
  assert.equal(proposal.run, 'R-42');
});
