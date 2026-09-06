import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';

import { WorkspaceError } from '../errors.js';

function safeId(value, label) {
  const id = String(value ?? '');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id)) throw new WorkspaceError(`Invalid ${label}`);
  return id;
}

function portablePath(value, root) {
  if (typeof value !== 'string' || !isAbsolute(value)) return value;
  const result = relative(root, value);
  if (result === '' || (result !== '..' && !result.startsWith(`..${sep}`) && !isAbsolute(result))) return result || '.';
  return value;
}

function portableSnapshot(snapshot, root) {
  if (!snapshot || typeof snapshot !== 'object') return snapshot ?? null;
  const result = { ...snapshot };
  if (Array.isArray(snapshot.repos)) {
    result.repos = snapshot.repos.map((repo) => ({
      ...repo,
      ...(repo?.path !== undefined ? { path: portablePath(repo.path, root) } : {}),
    }));
  }
  return result;
}

/** Git-friendly durable summaries and reviewable knowledge proposals. */
export class FileKnowledgeProvider {
  [key: string]: any;
  constructor({ workspaceDir } : any = {}) {
    if (!workspaceDir) throw new WorkspaceError('FileKnowledgeProvider requires workspaceDir');
    this.workspaceDir = workspaceDir;
    this.workspaceRoot = dirname(workspaceDir);
  }

  async recordDurableRun(run, candidate) {
    const runId = safeId(run?.id, 'run ID');
    const directory = join(this.workspaceDir, 'history', 'runs');
    await mkdir(directory, { recursive: true });
    const intent = run.intent ?? run.intent_json ?? {};
    const requestedLineage = intent?.lineage ?? {};
    const lineageFields = ['task', 'workstream', 'system_revision', 'plan_revision', 'resources'];
    const lineage = Object.fromEntries(lineageFields
      .filter((field) => requestedLineage[field] !== undefined || intent[field] !== undefined)
      .map((field) => [field, requestedLineage[field] ?? intent[field]]));
    const record = {
      version: 1,
      run: runId,
      agent: requestedLineage.agent ?? run.profile,
      purpose: run.purpose ?? run.objective ?? '',
      primary_repo: run.primary_repo ?? run.primaryRepo,
      status: run.status,
      intent,
      ...(Object.keys(lineage).length ? { lineage } : {}),
      snapshot: portableSnapshot(run.snapshot ?? run.snapshot_json ?? null, this.workspaceRoot),
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

  async propose({ id, runId, title, body, kind = 'discovery' } : any = {}) {
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
