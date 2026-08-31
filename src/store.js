import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { WorkspaceError, invariant } from './errors.js';
import { discoverWorkspace, workspacePaths } from './workspace.js';

const NOW = () => new Date().toISOString();

function json(value) {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

function optionalJson(value) { return value === undefined ? undefined : json(value); }

function unjson(value) {
  if (value === null || value === undefined || value === '') return null;
  try { return JSON.parse(value); } catch { return value; }
}

function rowWithJson(row, fields) {
  if (!row) return null;
  const result = { ...row };
  for (const field of fields) result[field] = unjson(result[field]);
  return result;
}

function dbPathFrom(input = process.cwd()) {
  if (typeof input === 'string' && (input.endsWith('.db') || input.includes('/runtime/'))) {
    return isAbsolute(input) ? input : resolve(input);
  }
  const workspace = input?.root ? input : discoverWorkspace(input);
  return workspacePaths(workspace).databasePath;
}

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    profile TEXT NOT NULL,
    status TEXT NOT NULL,
    purpose TEXT,
    objective TEXT,
    prompt TEXT,
    primary_repo TEXT,
    intent_json TEXT,
    snapshot_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT,
    started_at TEXT,
    finished_at TEXT,
    error TEXT,
    candidate_id TEXT,
    worktree_path TEXT,
    branch TEXT,
    context_paths_json TEXT,
    environment_json TEXT,
    resources_json TEXT,
    candidate_json TEXT
  );
  CREATE TABLE IF NOT EXISTS run_repositories (
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    repo_name TEXT NOT NULL,
    path TEXT NOT NULL,
    role TEXT,
    mutation INTEGER NOT NULL DEFAULT 0,
    context INTEGER NOT NULL DEFAULT 0,
    base_commit TEXT,
    worktree_path TEXT,
    PRIMARY KEY (run_id, repo_name)
  );
  CREATE TABLE IF NOT EXISTS resources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    name TEXT,
    value TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ALLOCATED',
    metadata_json TEXT,
    acquired_at TEXT NOT NULL,
    released_at TEXT
  );
  CREATE INDEX IF NOT EXISTS resources_active_idx ON resources(type, value, status);
  CREATE TABLE IF NOT EXISTS processes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    pid INTEGER NOT NULL,
    pgid INTEGER,
    command TEXT,
    status TEXT NOT NULL DEFAULT 'RUNNING',
    started_at TEXT NOT NULL,
    exited_at TEXT,
    exit_code INTEGER,
    metadata_json TEXT
  );
  CREATE INDEX IF NOT EXISTS processes_run_idx ON processes(run_id, status);
  CREATE TABLE IF NOT EXISTS candidates (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    repo_name TEXT NOT NULL,
    repo_path TEXT,
    worktree_path TEXT,
    branch TEXT,
    target_branch TEXT,
    base_commit TEXT,
    result_commit TEXT,
    status TEXT NOT NULL DEFAULT 'PENDING',
    validation_json TEXT,
    metadata_json TEXT,
    created_at TEXT NOT NULL,
    integrated_at TEXT
  );
  CREATE INDEX IF NOT EXISTS candidates_run_idx ON candidates(run_id);
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    payload_json TEXT,
    occurred_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS events_run_idx ON events(run_id, occurred_at);
  CREATE TABLE IF NOT EXISTS integration_lock (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    owner TEXT,
    acquired_at TEXT
  );
  INSERT OR IGNORE INTO integration_lock (id) VALUES (1);`,
  `CREATE TABLE IF NOT EXISTS profile_leases (
    profile TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    acquired_at TEXT NOT NULL
  );`,
];

export class OperationalStore {
  constructor(pathOrWorkspace = process.cwd(), options = {}) {
    this.path = dbPathFrom(pathOrWorkspace);
    mkdirSync(dirname(this.path), { recursive: true });
    this.db = new DatabaseSync(this.path);
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.migrate();
    if (options.readonly) this.readonly = true;
  }

  migrate() {
    this.db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );`);
    for (let index = 0; index < MIGRATIONS.length; index += 1) {
      const version = index + 1;
      const applied = this.db.prepare('SELECT 1 FROM schema_migrations WHERE version = ?').get(version);
      if (applied) continue;
      this.db.exec('BEGIN');
      try {
        this.db.exec(MIGRATIONS[index]);
        this.db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(version, NOW());
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw new WorkspaceError(`Database migration ${version} failed`, { cause: error });
      }
    }
    return this;
  }

  transaction(callback) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = callback(this);
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  createRun(input = {}) {
    const id = input.id ?? `R-${randomUUID()}`;
    const createdAt = input.created_at ?? input.createdAt ?? NOW();
    const profile = input.profile ?? input.agent_profile ?? input.agentProfile;
    invariant(profile, 'Run profile is required');
    this.db.prepare(`INSERT INTO runs
      (id, profile, status, purpose, objective, prompt, primary_repo, intent_json, snapshot_json,
       created_at, updated_at, started_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, profile, input.status ?? 'CREATED', input.purpose ?? input.objective ?? null,
        input.objective ?? input.purpose ?? null, input.prompt ?? input.objective ?? null,
        input.primary_repo ?? input.primaryRepo ?? null, json(input.intent), json(input.snapshot),
        createdAt, input.updated_at ?? input.updatedAt ?? createdAt, input.started_at ?? input.startedAt ?? null);
    return this.getRun(id);
  }

  getRun(id) {
    const row = rowWithJson(this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id),
      ['intent_json', 'snapshot_json', 'context_paths_json', 'environment_json', 'resources_json', 'candidate_json']);
    if (row) Object.assign(row, { intent: row.intent_json, snapshot: row.snapshot_json, candidate: row.candidate_json });
    return row;
  }

  listRuns(options = {}) {
    const clauses = [];
    const args = [];
    if (options.status) { clauses.push('status = ?'); args.push(options.status); }
    if (options.profile) { clauses.push('profile = ?'); args.push(options.profile); }
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
    const limit = Number.isInteger(options.limit) ? ` LIMIT ${Math.max(0, options.limit)}` : '';
    return this.db.prepare(`SELECT * FROM runs${where} ORDER BY created_at DESC${limit}`).all(...args)
      .map((row) => {
        const value = rowWithJson(row, ['intent_json', 'snapshot_json', 'context_paths_json', 'environment_json', 'resources_json', 'candidate_json']);
        return Object.assign(value, { intent: value.intent_json, snapshot: value.snapshot_json, candidate: value.candidate_json });
      });
  }

  updateRun(id, patch = {}) {
    const allowed = {
      status: patch.status,
      purpose: patch.purpose,
      objective: patch.objective,
      prompt: patch.prompt,
      primary_repo: patch.primary_repo ?? patch.primaryRepo,
      intent_json: optionalJson(patch.intent),
      snapshot_json: optionalJson(patch.snapshot),
      started_at: patch.started_at ?? patch.startedAt,
      finished_at: patch.finished_at ?? patch.finishedAt,
      error: patch.error,
      candidate_id: patch.candidate_id ?? patch.candidateId,
      worktree_path: patch.worktree_path ?? patch.worktreePath ?? patch.worktree,
      branch: patch.branch,
      context_paths_json: optionalJson(patch.contextPaths),
      environment_json: optionalJson(patch.environment),
      resources_json: optionalJson(patch.resources),
      candidate_json: optionalJson(patch.candidate),
      updated_at: patch.updated_at ?? patch.updatedAt,
    };
    const entries = Object.entries(allowed).filter(([, value]) => value !== undefined);
    if (!entries.length) return this.getRun(id);
    const result = this.db.prepare(`UPDATE runs SET ${entries.map(([key]) => `${key} = ?`).join(', ')} WHERE id = ?`)
      .run(...entries.map(([, value]) => value), id);
    invariant(result.changes > 0, `Run not found: ${id}`);
    return this.getRun(id);
  }

  updateRunStatus(id, status, fields = {}) { return this.updateRun(id, { ...fields, status }); }

  addRunRepository(runId, input = {}) {
    const repoName = input.repo_name ?? input.repoName ?? input.name;
    invariant(repoName, 'Run repository name is required');
    this.db.prepare(`INSERT INTO run_repositories
      (run_id, repo_name, path, role, mutation, context, base_commit, worktree_path)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id, repo_name) DO UPDATE SET path=excluded.path, role=excluded.role,
      mutation=excluded.mutation, context=excluded.context, base_commit=excluded.base_commit,
      worktree_path=excluded.worktree_path`)
      .run(runId, repoName, input.path ?? '', input.role ?? null, input.mutation ? 1 : 0,
        input.context ? 1 : 0, input.base_commit ?? input.baseCommit ?? null,
        input.worktree_path ?? input.worktreePath ?? null);
    return this.listRunRepositories(runId).find((row) => row.repo_name === repoName);
  }

  listRunRepositories(runId) {
    return this.db.prepare('SELECT * FROM run_repositories WHERE run_id = ? ORDER BY repo_name').all(runId)
      .map((row) => ({ ...row, mutation: Boolean(row.mutation), context: Boolean(row.context) }));
  }

  allocateResource(input = {}) {
    const runId = input.run_id ?? input.runId;
    const type = input.type;
    const value = String(input.value ?? input.key ?? '');
    invariant(runId && type && value, 'Resource run_id, type, and value are required');
    const id = this.transaction(() => {
      const active = this.db.prepare("SELECT * FROM resources WHERE type = ? AND value = ? AND status IN ('ALLOCATED','ACTIVE')")
        .get(type, value);
      invariant(!active, `Resource is already allocated: ${type}/${value}`);
      const result = this.db.prepare(`INSERT INTO resources
        (run_id, type, name, value, status, metadata_json, acquired_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`) 
        .run(runId, type, input.name ?? null, value, input.status ?? 'ALLOCATED', json(input.metadata), NOW());
      return Number(result.lastInsertRowid);
    });
    return this.getResource(id);
  }

  getResource(id) {
    return rowWithJson(this.db.prepare('SELECT * FROM resources WHERE id = ?').get(id), ['metadata_json']);
  }

  listResources(options = {}) {
    const clauses = [];
    const args = [];
    if (options.run_id ?? options.runId) { clauses.push('run_id = ?'); args.push(options.run_id ?? options.runId); }
    if (options.type) { clauses.push('type = ?'); args.push(options.type); }
    if (options.active) clauses.push("status IN ('ALLOCATED','ACTIVE')");
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
    return this.db.prepare(`SELECT * FROM resources${where} ORDER BY id`).all(...args)
      .map((row) => rowWithJson(row, ['metadata_json']));
  }

  releaseResource(id, options = {}) {
    const released = this.db.prepare("UPDATE resources SET status = 'RELEASED', released_at = ? WHERE id = ? AND status <> 'RELEASED'")
      .run(NOW(), id);
    if (released.changes === 0 && !options.ignoreMissing) throw new WorkspaceError(`Resource not found or already released: ${id}`);
    return this.getResource(id);
  }

  addProcess(input = {}) {
    const runId = input.run_id ?? input.runId;
    invariant(runId && input.pid !== undefined, 'Process run_id and pid are required');
    const result = this.db.prepare(`INSERT INTO processes
      (run_id, pid, pgid, command, status, started_at, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(runId, Number(input.pid), input.pgid ?? null, input.command ?? null,
        input.status ?? 'RUNNING', input.started_at ?? input.startedAt ?? NOW(), json(input.metadata));
    return this.getProcess(Number(result.lastInsertRowid));
  }

  getProcess(id) { return rowWithJson(this.db.prepare('SELECT * FROM processes WHERE id = ?').get(id), ['metadata_json']); }

  listProcesses(options = {}) {
    const runId = options.run_id ?? options.runId;
    const rows = runId
      ? this.db.prepare('SELECT * FROM processes WHERE run_id = ? ORDER BY id').all(runId)
      : this.db.prepare('SELECT * FROM processes ORDER BY id').all();
    return rows.map((row) => rowWithJson(row, ['metadata_json']));
  }

  updateProcess(id, patch = {}) {
    const fields = { status: patch.status, exited_at: patch.exited_at ?? patch.exitedAt, exit_code: patch.exit_code ?? patch.exitCode, metadata_json: optionalJson(patch.metadata) };
    const entries = Object.entries(fields).filter(([, value]) => value !== undefined);
    if (!entries.length) return this.getProcess(id);
    const result = this.db.prepare(`UPDATE processes SET ${entries.map(([key]) => `${key} = ?`).join(', ')} WHERE id = ?`)
      .run(...entries.map(([, value]) => value), id);
    invariant(result.changes > 0, `Process not found: ${id}`);
    return this.getProcess(id);
  }

  createCandidate(input = {}) {
    const id = input.id ?? `C-${randomUUID()}`;
    const runId = input.run_id ?? input.runId;
    const repoName = input.repo_name ?? input.repoName ?? input.repo;
    invariant(runId && repoName, 'Candidate run_id and repo_name are required');
    this.db.prepare(`INSERT INTO candidates
      (id, run_id, repo_name, repo_path, worktree_path, branch, target_branch, base_commit, result_commit,
       status, validation_json, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, runId, repoName, input.repo_path ?? input.repoPath ?? null,
        input.worktree_path ?? input.worktreePath ?? null, input.branch ?? null,
        input.target_branch ?? input.targetBranch ?? null, input.base_commit ?? input.baseCommit ?? null,
        input.result_commit ?? input.resultCommit ?? null, input.status ?? 'PENDING',
        json(input.validation), json(input.metadata), input.created_at ?? input.createdAt ?? NOW());
    return this.getCandidate(id);
  }

  getCandidate(id) {
    const row = rowWithJson(this.db.prepare('SELECT * FROM candidates WHERE id = ?').get(id), ['validation_json', 'metadata_json']);
    if (row) Object.assign(row, { validation: row.validation_json, metadata: row.metadata_json });
    return row;
  }

  listCandidates(options = {}) {
    const runId = options.run_id ?? options.runId;
    const rows = runId
      ? this.db.prepare('SELECT * FROM candidates WHERE run_id = ? ORDER BY created_at DESC').all(runId)
      : this.db.prepare('SELECT * FROM candidates ORDER BY created_at DESC').all();
    return rows.map((row) => {
      const value = rowWithJson(row, ['validation_json', 'metadata_json']);
      return Object.assign(value, { validation: value.validation_json, metadata: value.metadata_json });
    });
  }

  updateCandidate(id, patch = {}) {
    const fields = {
      result_commit: patch.result_commit ?? patch.resultCommit,
      repo_path: patch.repo_path ?? patch.repoPath,
      worktree_path: patch.worktree_path ?? patch.worktreePath,
      branch: patch.branch,
      target_branch: patch.target_branch ?? patch.targetBranch,
      status: patch.status,
      validation_json: optionalJson(patch.validation),
      metadata_json: optionalJson(patch.metadata),
      integrated_at: patch.integrated_at ?? patch.integratedAt,
    };
    const entries = Object.entries(fields).filter(([, value]) => value !== undefined);
    if (!entries.length) return this.getCandidate(id);
    const result = this.db.prepare(`UPDATE candidates SET ${entries.map(([key]) => `${key} = ?`).join(', ')} WHERE id = ?`)
      .run(...entries.map(([, value]) => value), id);
    invariant(result.changes > 0, `Candidate not found: ${id}`);
    return this.getCandidate(id);
  }

  recordEvent(input = {}) {
    invariant(input.type, 'Event type is required');
    const result = this.db.prepare(`INSERT INTO events(run_id, type, payload_json, occurred_at)
      VALUES (?, ?, ?, ?)`).run(input.run_id ?? input.runId ?? null, input.type,
      json(input.payload ?? input.data), input.occurred_at ?? input.occurredAt ?? NOW());
    return this.getEvent(Number(result.lastInsertRowid));
  }

  getEvent(id) { return rowWithJson(this.db.prepare('SELECT * FROM events WHERE id = ?').get(id), ['payload_json']); }

  listEvents(options = {}) {
    const runId = options.run_id ?? options.runId;
    const rows = runId
      ? this.db.prepare('SELECT * FROM events WHERE run_id = ? ORDER BY id').all(runId)
      : this.db.prepare('SELECT * FROM events ORDER BY id').all();
    return rows.map((row) => rowWithJson(row, ['payload_json']));
  }

  acquireIntegrationLock(owner = randomUUID()) {
    invariant(owner, 'Integration lock owner is required');
    return this.transaction(() => {
      const lock = this.db.prepare('SELECT owner FROM integration_lock WHERE id = 1').get();
      invariant(!lock.owner || lock.owner === owner, `Integration lock is held by ${lock.owner}`);
      this.db.prepare('UPDATE integration_lock SET owner = ?, acquired_at = ? WHERE id = 1').run(owner, NOW());
      return { owner, acquired_at: this.db.prepare('SELECT acquired_at FROM integration_lock WHERE id = 1').get().acquired_at };
    });
  }

  releaseIntegrationLock(owner) {
    const lock = this.db.prepare('SELECT owner FROM integration_lock WHERE id = 1').get();
    if (!lock?.owner) return false;
    invariant(!owner || lock.owner === owner, 'Integration lock owner does not match');
    this.db.prepare('UPDATE integration_lock SET owner = NULL, acquired_at = NULL WHERE id = 1').run();
    return true;
  }

  integrationLock() { return this.db.prepare('SELECT * FROM integration_lock WHERE id = 1').get(); }

  recoverIntegrationLock() {
    const lock = this.integrationLock();
    if (!lock?.owner) return null;
    const active = this.db.prepare("SELECT id FROM runs WHERE status = 'INTEGRATING' LIMIT 1").get();
    if (active) return null;
    this.releaseIntegrationLock(lock.owner);
    return lock;
  }

  acquireProfileLease(profile, owner) {
    invariant(profile && owner, 'Profile lease requires profile and owner');
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM profile_leases WHERE profile = ?').get(profile);
      if (existing) {
        const run = this.db.prepare('SELECT status FROM runs WHERE id = ?').get(existing.owner);
        const active = run && ['CREATED', 'PREPARING', 'RUNNING', 'INTEGRATING'].includes(run.status);
        invariant(!active, `Agent profile ${profile} forbids concurrent runs (${existing.owner})`);
        this.db.prepare('DELETE FROM profile_leases WHERE profile = ?').run(profile);
      }
      this.db.prepare('INSERT INTO profile_leases(profile, owner, acquired_at) VALUES (?, ?, ?)')
        .run(profile, owner, NOW());
      return { profile, owner };
    });
  }

  releaseProfileLease(profile, owner) {
    const result = this.db.prepare('DELETE FROM profile_leases WHERE profile = ? AND owner = ?').run(profile, owner);
    return result.changes > 0;
  }

  listProfileLeases() {
    return this.db.prepare('SELECT * FROM profile_leases ORDER BY profile').all();
  }

  // Generic names are provided for IntegrationProvider and embedders that do
  // not need to know that the reference store has one integration lock.
  acquireLock(key) { return this.acquireIntegrationLock(key); }
  releaseLock(key) { return this.releaseIntegrationLock(key); }

  close() { this.db.close(); }
}

export function openStore(pathOrWorkspace = process.cwd(), options = {}) {
  return new OperationalStore(pathOrWorkspace, options);
}

export const Store = OperationalStore;
export const createStore = openStore;
