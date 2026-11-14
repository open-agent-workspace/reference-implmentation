import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { invariant } from './errors.js';
import { loadComposition, resolveCompositionMember } from './composition.js';
import { canonicalJSON, CONTEXT_CAPABILITIES, contextHash, resolveCompositionContext, workspaceOwner } from './composition-context.js';
import { openStore } from './store.js';
import { workspacePaths } from './workspace.js';

const active = new Set(['CREATED', 'PREPARING', 'RUNNING', 'INTEGRATING']);
const retryable = new Set(['FAILED', 'CANCELLED', 'ORPHANED', 'REJECTED']);
function name(value, label) { invariant(typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value), `Invalid ${label}`); }
function text(value, label) { invariant(typeof value === 'string' && value.trim().length > 0, `Missing ${label}`); }
function keys(value, allowed, label) {
  invariant(value && typeof value === 'object' && !Array.isArray(value), `Invalid ${label}`);
  invariant(Object.keys(value).every((key) => allowed.includes(key)), `Unknown field in ${label}`);
}
function strings(value, label) { invariant(value === undefined || (Array.isArray(value) && value.every((item) => typeof item === 'string')), `Invalid ${label}`); }

/** Caller-owned intent is read, validated and correlated; it is never rewritten by dispatch. */
export function loadCompositionTask(workspaceOrRoot: any, path: string) {
  const workspace = workspaceOwner(workspaceOrRoot);
  const task = parse(readFileSync(path, 'utf8'));
  keys(task, ['version', 'id', 'composition', 'objective', 'subtasks'], 'Task');
  invariant(task.version === 1, 'Unsupported composition Task version');
  name(task.id, 'Task ID');
  text(task.objective, 'Task objective');
  invariant(task.composition === workspace.config.id, 'Task composition identity mismatch');
  loadComposition(workspace);
  invariant(Array.isArray(task.subtasks) && task.subtasks.length > 0, 'Task must declare at least one subtask');
  const ids = new Set();
  for (const step of task.subtasks) {
    keys(step, ['id', 'member', 'workspace_id', 'repository', 'profile', 'objective', 'depends_on', 'context', 'grants'], 'subtask');
    name(step.id, 'subtask ID');
    invariant(!ids.has(step.id), `Duplicate subtask: ${step.id}`); ids.add(step.id);
    for (const field of ['member', 'workspace_id', 'repository', 'profile', 'objective']) text(step[field], `subtask ${step.id}.${field}`);
    strings(step.depends_on, 'dependencies');
    if (step.context !== undefined) {
      keys(step.context, ['paths', 'shared', 'skills'], 'subtask context');
      for (const field of ['paths', 'shared', 'skills']) strings(step.context[field], field);
    }
    keys(step.grants, ['read', 'write', 'start_agent', 'read_status'], 'subtask grants');
    strings(step.grants.read, 'read grants');
    invariant((step.grants.read ?? []).every((capability) => CONTEXT_CAPABILITIES.includes(capability)), 'Unsupported read grant; private agent context is not shared');
    for (const field of ['write', 'start_agent', 'read_status']) invariant(typeof step.grants[field] === 'boolean', `Missing boolean grant: ${field}`);
  }
  const visiting = new Set(); const visited = new Set();
  const visit = (id) => {
    invariant(ids.has(id), `Unknown subtask dependency: ${id}`);
    invariant(!visiting.has(id), `Subtask dependency cycle: ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    const step = task.subtasks.find((item) => item.id === id);
    for (const dependency of step.depends_on ?? []) visit(dependency);
    visiting.delete(id); visited.add(id);
  };
  for (const id of ids) visit(id);
  return task;
}

export function compositionTaskHash(task) { return contextHash(canonicalJSON(task)); }
function directory(workspace, task) { return join(workspace.workspaceDir, 'history', 'compositions', contextHash(task.id)); }
function reportPath(workspace, task, step, attempt) { return join(directory(workspace, task), `${contextHash(step.id)}-${attempt}.yaml`); }
function saveReport(workspace, task, step, attempt, report) {
  const path = reportPath(workspace, task, step, attempt);
  mkdirSync(directory(workspace, task), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, stringify(report), { flag: 'wx', mode: 0o600 });
  renameSync(temp, path);
}
function reports(workspace, task, step) {
  if (!existsSync(directory(workspace, task))) return [];
  return readdirSync(directory(workspace, task)).filter((file) => file.startsWith(`${contextHash(step.id)}-`) && file.endsWith('.yaml'))
    .map((file) => parse(readFileSync(join(directory(workspace, task), file), 'utf8')))
    .sort((a, b) => a.attempt - b.attempt);
}
function validationSummary(evidence) {
  if (!evidence) return null;
  // Command argv may embed resolved instructions via placeholders. Keep that
  // evidence in its owning member rather than republishing bodies in the coordinator.
  return { success: evidence.success ?? evidence.passed ?? false,
    commands: (evidence.commands ?? []).map((command) => ({ index: command.index, label: command.label,
      success: command.success, exitCode: command.exitCode, signal: command.signal,
      stdoutLog: command.stdoutLog, stderrLog: command.stderrLog })) };
}
function observe(workspace, record) {
  const path = workspacePaths(workspace).databasePath;
  if (record.status === 'REJECTED') return { ...record, stale: false };
  if (!existsSync(path)) return { ...record, stale: true, error: 'Member Run database is unavailable' };
  const store = openStore(workspace, { readonly: true });
  try {
    const run = store.getRun(record.run);
    if (!run) return { ...record, stale: true, error: 'Member Run has not been recorded' };
    const lineage = run.intent?.composition_task;
    invariant(lineage?.plan_sha256 === record.plan_sha256 && lineage.composition === record.composition
      && lineage.task === record.task && lineage.subtask === record.subtask && lineage.attempt === record.attempt,
      'Member Run lineage mismatch');
    const candidate = run.candidate_id ? store.getCandidate(run.candidate_id) : undefined;
    return { ...record, stale: false, observed_at: new Date().toISOString(), context_sha256: run.intent?.resolved_context?.sha256 ?? record.context_sha256, status: ['INTEGRATED', 'INTEGRATION_FAILED'].includes(candidate?.status) ? candidate.status : run.status,
      candidate: candidate?.id ?? null, validation: validationSummary(candidate?.validation ?? candidate?.validation_json ?? run.intent?.execution_result?.validation), error: run.error ?? null };
  } finally { store.close(); }
}

/** Observational only. Offline members retain explicitly labelled cached results. */
export function inspectCompositionTask(workspaceOrRoot: any, task) {
  const coordinator = workspaceOwner(workspaceOrRoot);
  const hash = compositionTaskHash(task);
  const subtasks = task.subtasks.map((step) => {
    const attempts = reports(coordinator, task, step);
    let error;
    try {
      const selected = resolveCompositionMember(coordinator, step.member);
      invariant(selected.workspace.config.id === step.workspace_id, `Subtask ${step.id} workspace identity mismatch`);
      for (let index = 0; index < attempts.length; index++) {
        invariant(attempts[index].plan_sha256 === hash, `Task definition changed; use a new Task ID: ${task.id}`);
        if (step.grants.read_status) attempts[index] = observe(selected.workspace, attempts[index]);
        else attempts[index] = { ...attempts[index], stale: true, error: 'Status read grant is required' };
      }
    } catch (cause) {
      error = cause.message;
      for (let index = 0; index < attempts.length; index++) attempts[index] = { ...attempts[index], stale: true, error };
    }
    const latest = attempts.at(-1);
    return { id: step.id, member: step.member, workspace_id: step.workspace_id, repository: step.repository,
      depends_on: step.depends_on ?? [], attempts, status: error ? 'UNAVAILABLE' : latest?.status ?? 'PENDING',
      stale: Boolean(error || latest?.stale), ...(error ? { error } : {}) };
  });
  for (const step of subtasks) {
    if (step.status === 'PENDING' && step.depends_on.some((id) => subtasks.find((item) => item.id === id)?.status !== 'INTEGRATED')) step.status = 'BLOCKED';
  }
  const states = subtasks.map((step) => step.status);
  const status = states.every((state) => state === 'INTEGRATED') && subtasks.every((step) => !step.stale) ? 'INTEGRATED'
    : subtasks.some((step) => !step.stale && (active.has(step.status) || step.status === 'DISPATCHING')) ? 'RUNNING'
    : states.every((state) => ['INTEGRATED', 'CANDIDATE'].includes(state)) && subtasks.every((step) => !step.stale) ? 'READY_FOR_REVIEW'
    : states.some((state) => ['INTEGRATED', 'CANDIDATE'].includes(state)) ? 'PARTIAL'
    : states.some((state) => retryable.has(state) || state === 'INTEGRATION_FAILED') ? 'FAILED'
    : subtasks.some((step) => step.stale || ['BLOCKED', 'UNAVAILABLE'].includes(step.status)) ? 'BLOCKED' : 'PENDING';
  return { version: 1, task: task.id, composition: coordinator.config.id, plan_sha256: hash, status, stale: subtasks.some((step) => step.stale), subtasks };
}

/** One explicit caller-selected step/attempt, never an implicit scheduler or automatic retry. */
export async function dispatchCompositionStep(workspaceOrRoot: any, task, stepId: string, options: any = {}) {
  const coordinator = workspaceOwner(workspaceOrRoot);
  const step = task.subtasks.find((item) => item.id === stepId);
  invariant(step, `Subtask not found: ${stepId}`);
  const attempt = options.attempt ?? 1;
  invariant(Number.isSafeInteger(attempt) && attempt > 0, 'Attempt must be a positive integer');
  invariant(step.grants.write && step.grants.start_agent && step.grants.read_status && step.grants.read?.includes('source'), 'Dispatch requires explicit write, start_agent, read_status and source grants');
  const selected = resolveCompositionMember(coordinator, step.member);
  invariant(selected.workspace.config.id === step.workspace_id, `Subtask ${step.id} workspace identity mismatch`);
  invariant(selected.access === 'read-write', 'Composition membership denies write dispatch');
  invariant(typeof options.runtimeFactory === 'function', 'Member runtime factory is required');
  const parentStore = openStore(coordinator);
  const token = randomUUID();
  const key = `${contextHash(task.id)}:${contextHash(step.id)}`;
  let leased = false;
  let memberRuntime;
  try {
    parentStore.acquireCompositionLease(key, token); leased = true;
    const inspection = inspectCompositionTask(coordinator, task);
    invariant(!inspection.subtasks.some((item) => item.attempts.some((record) => record.plan_sha256 !== inspection.plan_sha256)), 'Task definition changed; use a new Task ID');
    const observed = inspection.subtasks.find((item) => item.id === step.id);
    const existing = observed.attempts.find((item) => item.attempt === attempt);
    invariant(!observed.error, observed.error);
    invariant(!observed.attempts.some((item) => item.plan_sha256 !== inspection.plan_sha256), 'Task definition changed; use a new Task ID');
    // Same attempt is idempotent, including a failure or still-running detached child.
    if (existing && !(existing.stale && existing.status === 'DISPATCHING' && ['Member Run has not been recorded', 'Member Run database is unavailable'].includes(existing.error))) {
      invariant(!existing.stale, `Cannot recover unavailable member status: ${existing.error}`);
      return existing;
    }
    const previous = observed.attempts.filter((item) => item.attempt !== attempt).at(-1);
    invariant(attempt === (previous ? previous.attempt + 1 : 1), 'Attempts must be consecutive; recover the existing attempt first');
    if (previous) invariant(!previous.stale && !previous.candidate && retryable.has(previous.status), 'Retry requires a failed, cancelled or reconciled orphaned Run; preserve unresolved Candidates');
    for (const dependency of step.depends_on ?? []) {
      const prior = inspection.subtasks.find((item) => item.id === dependency);
      invariant(prior?.status === 'INTEGRATED' && !prior.stale, `Dependency must be integrated before dispatch: ${dependency}`);
    }
    const context = resolveCompositionContext(coordinator, { member: step.member, repository: step.repository, profile: step.profile, grants: step.grants, ...step.context });
    invariant(context.valid, `Composition context conflicts: ${context.conflicts.map((item) => item.message).join('; ')}`);
    if (options.expectedContextHash) invariant(options.expectedContextHash === context.sha256, 'Resolved context differs from expected hash');
    const runId = `R-C-${contextHash(`${coordinator.config.id}:${task.id}:${step.id}:${attempt}`).slice(0, 40)}`;
    let report: any = { version: 1, composition: coordinator.config.id, task: task.id, subtask: step.id, attempt,
      member: step.member, workspace_id: step.workspace_id, repository: step.repository, profile: step.profile,
      run: runId, plan_sha256: inspection.plan_sha256, context_sha256: context.sha256, status: 'DISPATCHING', stale: false, observed_at: new Date().toISOString() };
    saveReport(coordinator, task, step, attempt, report);
    memberRuntime = options.runtimeFactory(selected.workspace);
    const child = memberRuntime.store.getRun(runId);
    if (child) {
      report = observe(selected.workspace, report);
      saveReport(coordinator, task, step, attempt, report);
      return report;
    }
    try {
      await memberRuntime.runs.execute({ profile: step.profile, objective: step.objective, repo: step.repository, contextRepos: 'none',
        noIntegrate: true, runId, resolvedContext: context,
        intent: { lineage: { task: task.id }, composition_task: { composition: coordinator.config.id, task: task.id, subtask: step.id, attempt, plan_sha256: inspection.plan_sha256 } },
        onCreated: () => saveReport(coordinator, task, step, attempt, { ...report, status: 'CREATED' }),
      });
      report = observe(selected.workspace, report);
    } catch (error) {
      const run = memberRuntime.store.getRun(runId);
      report = run ? observe(selected.workspace, report) : { ...report, status: 'REJECTED', error: error.message };
      report.error ??= error.message;
    }
    report.observed_at = new Date().toISOString();
    saveReport(coordinator, task, step, attempt, report);
    return report;
  } finally {
    memberRuntime?.store.close();
    if (leased) parentStore.releaseCompositionLease(key, token);
    parentStore.close();
  }
}
