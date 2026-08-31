import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';

import { WorkspaceError } from '../errors.js';

function safeId(value, label) {
  const id = String(value ?? '');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id)) throw new WorkspaceError(`Invalid ${label}`);
  return id;
}

/** Git-friendly durable summaries and reviewable knowledge proposals. */
export class FileKnowledgeProvider {
  constructor({ workspaceDir } = {}) {
    if (!workspaceDir) throw new WorkspaceError('FileKnowledgeProvider requires workspaceDir');
    this.workspaceDir = workspaceDir;
  }

  async recordDurableRun(run, candidate) {
    const runId = safeId(run?.id, 'run ID');
    const directory = join(this.workspaceDir, 'history', 'runs');
    await mkdir(directory, { recursive: true });
    const record = {
      version: 1,
      run: runId,
      profile: run.profile,
      purpose: run.purpose ?? run.objective ?? '',
      primary_repo: run.primary_repo ?? run.primaryRepo,
      status: run.status,
      intent: run.intent ?? run.intent_json ?? {},
      snapshot: run.snapshot ?? run.snapshot_json ?? null,
      candidate: candidate ? {
        id: candidate.id,
        repo: candidate.repo_name ?? candidate.repoName ?? candidate.repo,
        base_commit: candidate.base_commit ?? candidate.baseCommit,
        result_commit: candidate.result_commit ?? candidate.resultCommit,
        status: candidate.status,
        validation: candidate.validation ?? candidate.validation_json ?? null,
      } : null,
      completed_at: run.finished_at ?? run.finishedAt ?? new Date().toISOString(),
    };
    const path = join(directory, `${runId}.yaml`);
    await writeFile(path, stringifyYaml(record), 'utf8');
    return { path, record };
  }

  async propose({ id, runId, title, body, kind = 'discovery' } = {}) {
    const proposalId = safeId(id ?? `P-${Date.now()}`, 'proposal ID');
    const directory = join(this.workspaceDir, 'proposals');
    await mkdir(directory, { recursive: true });
    const proposal = {
      version: 1,
      id: proposalId,
      run: runId ?? null,
      kind,
      title: String(title ?? ''),
      body: String(body ?? ''),
      status: 'proposed',
      proposed_at: new Date().toISOString(),
    };
    const path = join(directory, `${proposalId}.yaml`);
    await writeFile(path, stringifyYaml(proposal), 'utf8');
    return { path, proposal };
  }
}

export default FileKnowledgeProvider;
