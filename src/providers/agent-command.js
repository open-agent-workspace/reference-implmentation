import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { WorkspaceError } from '../errors.js';

function asPathList(paths) {
  return (paths ?? []).map((item) => typeof item === 'string' ? item : item.path).filter(Boolean);
}

/**
 * Tokenize a small command-line string without invoking a shell. Quotes and
 * backslash escapes are supported; shell expansion, pipes, redirects, and
 * command chaining are never interpreted.
 */
export function tokenizeCommand(command) {
  if (typeof command !== 'string') throw new WorkspaceError('Validation command must be an argv array or string');
  const tokens = [];
  let token = '';
  let quote = null;
  let escaped = false;
  let started = false;
  for (const character of command) {
    if (escaped) {
      token += character;
      escaped = false;
      started = true;
      continue;
    }
    if (character === '\\' && quote !== "'") {
      escaped = true;
      started = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      else token += character;
      started = true;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      started = true;
    } else if (/\s/.test(character)) {
      if (started) {
        tokens.push(token);
        token = '';
        started = false;
      }
    } else {
      token += character;
      started = true;
    }
  }
  if (escaped) token += '\\';
  if (quote) throw new WorkspaceError('Unclosed quote in validation command');
  if (started) tokens.push(token);
  if (!tokens.length) throw new WorkspaceError('Validation command cannot be empty');
  return tokens;
}

/**
 * Adapter for local agent CLIs. Commands are argv arrays so prompts and paths
 * never pass through a shell. A profile may use either `command` or `argv`:
 * ["node", "fake-agent.js", "--prompt", "{prompt}"].
 */
export class CommandAgentProvider {
  constructor({ processProvider, runtimeDir = '.workspace/runtime' } = {}) {
    if (!processProvider) throw new WorkspaceError('CommandAgentProvider requires a process provider');
    this.processProvider = processProvider;
    this.runtimeDir = runtimeDir;
    this.active = new Map();
  }

  #argv(profile) {
    const raw = profile?.argv ?? profile?.command;
    if (!Array.isArray(raw) || raw.length === 0 || raw.some((item) => typeof item !== 'string')) {
      throw new WorkspaceError('Agent profile command must be a non-empty argv array');
    }
    return [...raw];
  }

  #expand(value, values) {
    return value.replace(/\{(prompt|instructions|worktree|cwd|workspace|context|context_paths|run_id)\}/g, (_all, key) => values[key] ?? '');
  }

  #validation(profile, values) {
    const configured = profile?.validation ?? [];
    if (!Array.isArray(configured)) throw new WorkspaceError('Agent profile validation must be an array');
    return configured.map((command) => {
      const argv = Array.isArray(command) ? command : tokenizeCommand(command);
      if (!argv.length || argv.some((item) => typeof item !== 'string')) {
        throw new WorkspaceError('Validation command argv must be a non-empty array of strings');
      }
      return argv.map((value) => this.#expand(value, values));
    });
  }

  prepare({ profile, run, prompt, worktreePath, contextPaths = [], workspacePath } = {}) {
    const values = {
      prompt: String(prompt ?? run?.objective ?? ''),
      instructions: String(profile?.instructions ?? ''),
      worktree: worktreePath ?? '',
      cwd: worktreePath ?? '',
      workspace: workspacePath ?? run?.workspacePath ?? '',
      context: asPathList(contextPaths).join(process.platform === 'win32' ? ';' : ':'),
      context_paths: asPathList(contextPaths).join(process.platform === 'win32' ? ';' : ':'),
      run_id: String(run?.id ?? run?.runId ?? ''),
    };
    const argv = this.#argv(profile).map((value) => this.#expand(value, values));
    const [command, ...args] = argv;
    return { command, args, argv, cwd: worktreePath, values };
  }

  async run({ profile, run, prompt, worktreePath, contextPaths = [], workspacePath, env = {} } = {}) {
    const spec = this.prepare({ profile, run, prompt, worktreePath, contextPaths, workspacePath });
    const runId = run?.id ?? run?.runId;
    if (!runId) throw new WorkspaceError('Agent run requires a run ID');
    const logDir = join(this.runtimeDir, 'logs', String(runId));
    await mkdir(logDir, { recursive: true });
    const expandedProfileEnv = Object.fromEntries(Object.entries(profile?.env ?? {}).map(([key, value]) => [
      key,
      this.#expand(String(value), spec.values),
    ]));
    const expandedEnv = Object.fromEntries(Object.entries(env).map(([key, value]) => [
      key,
      this.#expand(String(value), spec.values),
    ]));
    const mergedEnv = {
      ...expandedProfileEnv,
      ...expandedEnv,
      WS_RUN_ID: String(runId),
      WS_WORKTREE: worktreePath ?? '',
      WS_WORKSPACE: workspacePath ?? run?.workspacePath ?? '',
      WS_CONTEXT_PATHS: asPathList(contextPaths).join(process.platform === 'win32' ? ';' : ':'),
      WS_PROMPT: String(prompt ?? run?.objective ?? ''),
      WS_AGENT_INSTRUCTIONS: String(profile?.instructions ?? ''),
    };
    const record = await this.processProvider.launchProcess({
      runId,
      command: spec.command,
      args: spec.args,
      cwd: spec.cwd,
      env: mergedEnv,
      label: 'agent',
    });
    this.active.set(runId, record);
    const result = await record.completion;
    this.active.delete(runId);
    const configuredValidation = profile?.validation ?? [];
    // Validation is a postcondition of a successful agent invocation. A
    // failed agent must not run arbitrary follow-up commands in its worktree.
    const validationCommands = result.success ? this.#validation(profile, spec.values) : [];
    const validation = [];
    let validationSuccess = true;
    for (let index = 0; index < validationCommands.length; index += 1) {
      const argv = validationCommands[index];
      const [command, ...args] = argv;
      const label = `validation-${String(index + 1).padStart(3, '0')}`;
      let validationResult;
      try {
        validationResult = await this.#runProcess({
          runId,
          command,
          args,
          cwd: worktreePath,
          env: { ...mergedEnv, WS_VALIDATION_INDEX: String(index + 1) },
          label,
        });
      } catch (error) {
        validationResult = {
          success: false,
          exitCode: null,
          signal: null,
          error: error.message,
          stdoutLog: null,
          stderrLog: null,
        };
      }
      const evidence = {
        index: index + 1,
        label,
        command: argv,
        cwd: worktreePath,
        success: Boolean(validationResult.success),
        exitCode: validationResult.exitCode ?? null,
        signal: validationResult.signal ?? null,
        error: validationResult.error?.message ?? validationResult.error ?? null,
        stdoutLog: validationResult.stdoutLog ?? null,
        stderrLog: validationResult.stderrLog ?? null,
        logs: {
          stdout: validationResult.stdoutLog ?? null,
          stderr: validationResult.stderrLog ?? null,
        },
      };
      validation.push(evidence);
      if (!evidence.success) {
        validationSuccess = false;
        break;
      }
    }
    const validationEvidence = result.success && configuredValidation.length
      ? { success: validationSuccess, passed: validationSuccess, commands: validation, stoppedOnFailure: !validationSuccess }
      : null;
    const firstFailure = validation.find((item) => !item.success);
    return {
      ...result,
      success: Boolean(result.success && validationSuccess),
      exitCode: result.success && firstFailure ? firstFailure.exitCode : result.exitCode,
      command: spec.argv,
      worktreePath,
      contextPaths: asPathList(contextPaths),
      logs: { stdout: result.stdoutLog, stderr: result.stderrLog },
      validation: validationEvidence,
      validationEvidence,
    };
  }

  async #runProcess(options) {
    if (typeof this.processProvider.runProcess === 'function') return this.processProvider.runProcess(options);
    const record = await this.processProvider.launchProcess(options);
    return record.completion;
  }

  async stop(runId) {
    const processRecord = this.active.get(runId);
    if (!processRecord) return false;
    return this.processProvider.stopProcess(processRecord);
  }
}

export default CommandAgentProvider;
