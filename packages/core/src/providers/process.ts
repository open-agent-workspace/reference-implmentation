import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir } from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomInt } from 'node:crypto';
import { WorkspaceError } from '../errors.js';

const ACTIVE_RUN_STATUSES = new Set(['CREATED', 'PREPARING', 'RUNNING', 'INTEGRATING']);

function isoNow() {
  return new Date().toISOString();
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function isGroupAlive(pgid) {
  if (process.platform === 'win32') return isAlive(pgid);
  if (!Number.isInteger(pgid) || pgid <= 0) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/**
 * Local resource/process coordinator. The database is deliberately optional:
 * the in-memory mode is useful for provider tests, while production passes the
 * workspace SQLite DatabaseSync instance.
 */
export class ProcessResourceProvider {
  [key: string]: any;
  constructor({ db = null, store = null, runtimeDir = '.workspace/runtime', now = isoNow, canBind } : any = {}) {
    // Prefer the OperationalStore contract when supplied. The raw-db mode is
    // retained for embedders that do not use the reference store.
    this.store = store ?? (db?.allocateResource ? db : null);
    this.db = this.store?.db ?? db;
    this.runtimeDir = runtimeDir;
    this.now = now;
    this.canBind = canBind ?? ((host, port) => this.#canBind(host, port));
    this.processes = new Map();
    this.resources = new Map();
    if (this.db && !this.store) this.#ensureSchema();
  }

  #ensureSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runtime_resources (
        id INTEGER PRIMARY KEY,
        run_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        name TEXT,
        value TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'allocated',
        metadata TEXT,
        allocated_at TEXT NOT NULL,
        released_at TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS runtime_resources_active_key
        ON runtime_resources(kind, value) WHERE state = 'allocated';
      CREATE TABLE IF NOT EXISTS runtime_processes (
        id INTEGER PRIMARY KEY,
        run_id TEXT NOT NULL,
        pid INTEGER NOT NULL,
        pgid INTEGER,
        command TEXT NOT NULL,
        cwd TEXT,
        stdout_log TEXT,
        stderr_log TEXT,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        status TEXT NOT NULL DEFAULT 'running',
        exit_code INTEGER,
        signal TEXT
      );
    `);
  }

  #dbRun(sql, ...params) {
    return this.db?.prepare(sql).run(...params);
  }

  #dbGet(sql, ...params) {
    return this.db?.prepare(sql).get(...params);
  }

  async allocatePort({ runId, name = 'PORT', preferredPort, host = '127.0.0.1' } : any = {}) {
    if (!runId) throw new WorkspaceError('A run ID is required to allocate a port');
    const candidates = preferredPort
      ? [Number(preferredPort)]
      : Array.from({ length: 256 }, () => randomInt(30_000, 60_000));
    for (const port of candidates) {
      if (!Number.isInteger(port) || port < 1 || port > 65_535) continue;
      if (!(await this.canBind(host, port))) continue;
      const value = `${host}:${port}`;
      try {
        if (this.store) {
          const record = this.store.allocateResource({
            runId,
            type: 'port',
            name,
            value,
            metadata: { host, port },
          });
          return { kind: 'port', type: 'port', name, host, port, value, id: record.id };
        } else if (this.db) {
          // BEGIN IMMEDIATE makes the check + insert one local-machine lease.
          this.db.exec('BEGIN IMMEDIATE');
          try {
            const existing = this.#dbGet(
              "SELECT id FROM runtime_resources WHERE kind = 'port' AND value = ? AND state = 'allocated'",
              value,
            );
            if (existing) {
              this.db.exec('ROLLBACK');
              continue;
            }
            this.#dbRun(
              "INSERT INTO runtime_resources (run_id, kind, name, value, state, metadata, allocated_at) VALUES (?, 'port', ?, ?, 'allocated', ?, ?)",
              runId,
              name,
              value,
              JSON.stringify({ host, port }),
              this.now(),
            );
            this.db.exec('COMMIT');
          } catch (error) {
            try { this.db.exec('ROLLBACK'); } catch { /* preserve original error */ }
            if (String(error.message).includes('UNIQUE')) continue;
            throw error;
          }
        } else {
          const key = `${host}:${port}`;
          if ([...this.resources.values()].some((r) => r.kind === 'port' && r.value === key && r.state === 'allocated')) continue;
          this.resources.set(`${runId}:port:${name}`, { runId, kind: 'port', name, value: key, state: 'allocated', allocatedAt: this.now() });
        }
        return { kind: 'port', name, host, port, value };
      } catch (error) {
        if (String(error.message).includes('Resource is already allocated')) continue;
        throw new WorkspaceError(`Unable to reserve port ${value}`, { cause: error });
      }
    }
    throw new WorkspaceError(`No available TCP port${preferredPort ? ` ${preferredPort}` : ''}`);
  }

  #canBind(host, port) {
    return new Promise((resolve) => {
      const server = createServer();
      const finish = (value) => {
        server.removeAllListeners();
        try { server.close(); } catch { /* not listening */ }
        resolve(value);
      };
      server.once('error', () => finish(false));
      server.listen({ host, port }, () => finish(true));
    });
  }

  async launchProcess({ runId, command, args = [], cwd, env = {}, label = 'agent' } : any = {}) {
    if (!runId) throw new WorkspaceError('A run ID is required to launch a process');
    if (!command || typeof command !== 'string') throw new WorkspaceError('Process command must be an executable name');
    const logDir = join(this.runtimeDir, 'logs', String(runId));
    await mkdir(logDir, { recursive: true });
    const stdoutLog = join(logDir, `${label}.stdout.log`);
    const stderrLog = join(logDir, `${label}.stderr.log`);
    const startedAt = this.now();
    const stdoutFd = openSync(stdoutLog, 'a');
    const stderrFd = openSync(stderrLog, 'a');
    let child;
    try {
      child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      shell: false,
      detached: process.platform !== 'win32',
        stdio: ['ignore', stdoutFd, stderrFd],
      });
    } finally {
      closeSync(stdoutFd);
      closeSync(stderrFd);
    }
    const record: any = {
      runId,
      pid: child.pid,
      pgid: process.platform === 'win32' ? child.pid : child.pid,
      command: [command, ...args],
      cwd,
      stdoutLog,
      stderrLog,
      startedAt,
      status: 'running',
      child,
    };
    if (Number.isInteger(child.pid)) this.processes.set(`${runId}:${child.pid}`, record);
    if (this.store && Number.isInteger(child.pid)) {
      const saved = this.store.addProcess({
        runId,
        pid: child.pid,
        pgid: record.pgid,
        command: JSON.stringify(record.command),
        startedAt,
        metadata: { cwd, stdoutLog, stderrLog, label },
      });
      record.dbId = saved.id;
    } else if (this.db && Number.isInteger(child.pid)) {
      const result = this.#dbRun(
        'INSERT INTO runtime_processes (run_id, pid, pgid, command, cwd, stdout_log, stderr_log, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        runId,
        child.pid,
        record.pgid,
        JSON.stringify(record.command),
        cwd ?? null,
        stdoutLog,
        stderrLog,
        startedAt,
      );
      record.dbId = Number(result.lastInsertRowid);
    }
    const completion = new Promise((resolve) => {
      let settled = false;
      const finish = (status, code, signal) => {
        if (settled) return;
        settled = true;
        record.status = status;
        record.exitCode = code;
        record.signal = signal;
        record.endedAt = this.now();
        if (this.store && record.dbId) {
          this.store.updateProcess(record.dbId, {
            status: status === 'exited' ? 'EXITED' : 'FAILED',
            exitedAt: record.endedAt,
            exitCode: code,
            metadata: { cwd, stdoutLog, stderrLog, label, signal },
          });
        } else if (this.db && record.dbId) {
          this.#dbRun('UPDATE runtime_processes SET ended_at = ?, status = ?, exit_code = ?, signal = ? WHERE id = ?', record.endedAt, status, code, signal, record.dbId);
        }
        resolve({ ...record, child: undefined, success: status === 'exited' && code === 0 });
      };
      child.once('error', (error) => { record.error = error; finish('failed', null, null); });
      child.once('close', (code, signal) => finish('exited', code, signal));
    });
    record.completion = completion;
    return record;
  }

  async runProcess(options) {
    const record = await this.launchProcess(options);
    return record.completion;
  }

  async stopProcess(recordOrPid, { signal = 'SIGTERM', graceMs = 2_000 } : any = {}) {
    const record = typeof recordOrPid === 'object'
      ? recordOrPid
      : [...this.processes.values()].find((item) => item.pid === Number(recordOrPid));
    if (!record?.pid) return false;
    const targetAlive = process.platform === 'win32' ? isAlive(record.pid) : isGroupAlive(record.pgid ?? record.pid);
    if (!targetAlive) return false;
    try {
      if (process.platform !== 'win32') process.kill(-record.pgid, signal);
      else process.kill(record.pid, signal);
    } catch (error) {
      if (!['ESRCH', 'EPERM'].includes(error.code)) throw error;
      return false;
    }
    if (graceMs > 0) await new Promise((resolve) => setTimeout(resolve, graceMs));
    if (process.platform === 'win32' ? isAlive(record.pid) : isGroupAlive(record.pgid ?? record.pid)) {
      try {
        if (process.platform !== 'win32') process.kill(-record.pgid, 'SIGKILL');
        else process.kill(record.pid, 'SIGKILL');
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    }
    return true;
  }

  async stopRunProcesses(runId) {
    const records = [...this.processes.values()].filter((item) => item.runId === runId);
    if (this.store) {
      for (const saved of this.store.listProcesses({ runId })) {
        if (!records.some((item) => item.pid === saved.pid)) {
          records.push({ ...saved, runId: saved.run_id, pgid: saved.pgid ?? saved.pid });
        }
      }
    }
    for (const record of records) await this.stopProcess(record, { graceMs: 250 });
  }

  async releaseRunResources(runId) {
    await this.stopRunProcesses(runId);
    if (this.store) {
      for (const resource of this.store.listResources({ runId, active: true })) this.store.releaseResource(resource.id, { ignoreMissing: true });
    } else if (this.db) {
      this.#dbRun("UPDATE runtime_resources SET state = 'released', released_at = ? WHERE run_id = ? AND state = 'allocated'", this.now(), runId);
    } else {
      for (const [key, resource] of this.resources) if (resource.runId === runId) resource.state = 'released';
    }
  }

  /** Return runtime records whose process disappeared, without deleting worktrees. */
  async reconcile() {
    const staleRuns = new Set();
    const records = this.store
      ? this.store.listProcesses().filter((item) => ['RUNNING', 'ACTIVE', 'running', 'active'].includes(item.status))
      : this.db
      ? this.db.prepare("SELECT * FROM runtime_processes WHERE status = 'running'").all()
      : [...this.processes.values()].filter((item) => item.status === 'running');
    for (const record of records) {
      if (isAlive(record.pid)) continue;
      staleRuns.add(record.run_id ?? record.runId);
      if (this.store) this.store.updateProcess(record.id, { status: 'ORPHANED', exitedAt: this.now() });
      else if (this.db) this.#dbRun("UPDATE runtime_processes SET status = 'orphaned', ended_at = ? WHERE id = ?", this.now(), record.id);
      else record.status = 'orphaned';
    }
    for (const runId of staleRuns) await this.releaseRunResources(runId);
    return [...staleRuns];
  }
}

export { isAlive, ACTIVE_RUN_STATUSES };
