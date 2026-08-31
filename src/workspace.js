import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, normalize, parse, relative, resolve } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { WorkspaceError, invariant } from './errors.js';
import { WORKSPACE_VERSION } from './constants.js';
import { repositoryRoot } from './git.js';

const WORKSPACE_DIR = '.workspace';
const CONFIG_FILE = 'workspace.yaml';
const CONFIG_DIRS = ['context', 'agents', 'history/runs', 'proposals', 'runtime'];
const CONTEXT_FILES = ['architecture.md', 'conventions.md', 'policies.md'];

function absoluteExistingPath(value) {
  const candidate = resolve(String(value));
  if (!existsSync(candidate)) throw new WorkspaceError(`Path does not exist: ${candidate}`);
  return realpathSync(candidate);
}

function workspaceRootFrom(input = process.cwd()) {
  if (input && typeof input === 'object' && input.root) return resolve(input.root);
  const candidate = resolve(String(input));
  if (existsSync(candidate) && statSync(candidate).isFile()) return dirname(candidate);
  return candidate;
}

/** Find the nearest .workspace directory while walking toward the filesystem root. */
export function discoverWorkspace(start = process.cwd()) {
  let current = workspaceRootFrom(start);
  while (true) {
    const directory = join(current, WORKSPACE_DIR);
    if (existsSync(join(directory, CONFIG_FILE))) return loadWorkspace(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new WorkspaceError(`No workspace found from ${resolve(String(start))}`);
}

export const findWorkspace = discoverWorkspace;

function configFor(workspace) {
  if (workspace && workspace.config && workspace.root) return workspace;
  return discoverWorkspace(workspace);
}

function writeConfig(workspace, config) {
  writeFileSync(workspace.configPath, stringifyYaml(config), 'utf8');
}

/** Initialize a workspace and its durable/runtime directory layout. */
export function initWorkspace(root = process.cwd(), options = {}) {
  const workspaceRoot = absoluteExistingPath(root);
  const workspaceDir = join(workspaceRoot, WORKSPACE_DIR);
  const configPath = join(workspaceDir, CONFIG_FILE);
  if (existsSync(configPath) && !options.force) {
    throw new WorkspaceError(`Workspace already initialized at ${workspaceDir}`);
  }

  mkdirSync(workspaceDir, { recursive: true });
  for (const directory of CONFIG_DIRS) mkdirSync(join(workspaceDir, directory), { recursive: true });
  for (const file of CONTEXT_FILES) {
    const path = join(workspaceDir, 'context', file);
    if (!existsSync(path)) writeFileSync(path, `# ${parse(file).name}\n\n`, 'utf8');
  }

  // Runtime state is disposable and must never enter durable Git history. The
  // marker keeps the directory available after a fresh clone.
  writeFileSync(join(workspaceDir, 'runtime', '.gitkeep'), '', 'utf8');
  writeFileSync(
    join(workspaceDir, '.gitignore'),
    '# Local operational state (SQLite, logs, worktrees, and process data)\nruntime/\n',
    'utf8',
  );

  const existing = existsSync(configPath) ? parseYaml(readFileSync(configPath, 'utf8')) : {};
  const config = {
    version: WORKSPACE_VERSION,
    id: existing.id ?? randomUUID(),
    name: options.name ?? existing.name ?? parse(workspaceRoot).base,
    repositories: Array.isArray(existing.repositories) ? existing.repositories : [],
    context: existing.context ?? { revision: 0 },
  };
  const workspace = { root: workspaceRoot, workspaceDir, configPath, config };
  writeConfig(workspace, config);
  return loadWorkspace(workspaceRoot);
}

export const initializeWorkspace = initWorkspace;

/** Load and validate workspace metadata without mutating it. */
export function loadWorkspace(rootOrStart = process.cwd()) {
  const root = workspaceRootFrom(rootOrStart);
  const workspaceDir = join(root, WORKSPACE_DIR);
  const configPath = join(workspaceDir, CONFIG_FILE);
  if (!existsSync(configPath)) throw new WorkspaceError(`Workspace config not found: ${configPath}`);
  let config;
  try {
    config = parseYaml(readFileSync(configPath, 'utf8')) ?? {};
  } catch (cause) {
    throw new WorkspaceError(`Invalid workspace config: ${configPath}`, { cause });
  }
  invariant(config.version === undefined || Number(config.version) === WORKSPACE_VERSION,
    `Unsupported workspace version in ${configPath}`);
  if (!Array.isArray(config.repositories)) config.repositories = [];
  const workspace = { root, workspaceDir, configPath, config };
  // Keep the durable manifest portable while exposing resolved paths to
  // runtime consumers (RunOrchestrator and providers).
  workspace.repositories = config.repositories.map((repository) => ({
    ...repository,
    path: realpathOrResolve(repository.path, root),
  }));
  workspace.getAgentProfile = (name) => loadAgentProfile(workspace, name);
  workspace.getAgent = workspace.getAgentProfile;
  return workspace;
}

export function workspacePaths(workspaceOrRoot = process.cwd()) {
  const workspace = configFor(workspaceOrRoot);
  return {
    ...workspace,
    contextDir: join(workspace.workspaceDir, 'context'),
    agentsDir: join(workspace.workspaceDir, 'agents'),
    historyDir: join(workspace.workspaceDir, 'history'),
    proposalsDir: join(workspace.workspaceDir, 'proposals'),
    runtimeDir: join(workspace.workspaceDir, 'runtime'),
    databasePath: join(workspace.workspaceDir, 'runtime', 'workspace.db'),
  };
}

async function gitRoot(path) {
  try {
    return realpathSync(await repositoryRoot(path));
  } catch (cause) {
    throw new WorkspaceError(`Not a Git repository: ${path}`, { cause });
  }
}

function normalizedName(value) {
  const name = String(value ?? '').trim().toLowerCase();
  invariant(name.length > 0, 'Repository/profile name cannot be empty');
  invariant(/^[a-z0-9][a-z0-9_-]*$/.test(name),
    `Invalid name "${value}"; use letters, numbers, '-' or '_'`);
  return name;
}

/** Add a Git repository to the manifest. The first repository is primary. */
export async function addRepository(workspaceOrRoot, repositoryPath, options = {}) {
  if (repositoryPath === undefined) {
    repositoryPath = workspaceOrRoot;
    workspaceOrRoot = process.cwd();
  }
  const workspace = configFor(workspaceOrRoot);
  const path = await gitRoot(absoluteExistingPath(repositoryPath));
  const name = normalizedName(options.name ?? parse(path).base);
  const repositories = workspace.config.repositories;
  invariant(!repositories.some((repo) => realpathOrResolve(repo.path, workspace.root) === path),
    `Repository already registered: ${path}`);
  invariant(!repositories.some((repo) => normalizedName(repo.name) === name),
    `Repository name already registered: ${name}`);
  const role = repositories.length === 0 ? 'primary' : (options.role ?? 'secondary');
  const repository = {
    name,
    // Keep the manifest portable when repositories live beside the workspace.
    // Consumers should resolve this path against workspace.root before use.
    path: relative(workspace.root, path) || '.',
    role,
    context: options.context ?? true,
  };
  repositories.push(repository);
  writeConfig(workspace, workspace.config);
  if (Array.isArray(workspace.repositories)) {
    workspace.repositories.push({ ...repository, path });
  }
  return repository;
}

export const repoAdd = addRepository;

function realpathOrResolve(value, base) {
  const path = isAbsolute(String(value)) ? String(value) : resolve(base, String(value));
  try { return realpathSync(path); } catch { return normalize(path); }
}

export function listRepositories(workspaceOrRoot = process.cwd()) {
  return [...configFor(workspaceOrRoot).config.repositories];
}

export const repoList = listRepositories;

function profileName(value) { return normalizedName(value); }

function commandArgv(command) {
  if (command === undefined || command === null) return undefined;
  if (Array.isArray(command)) return command.map(String);
  // CLI callers are encouraged to pass argv arrays. This small tokenizer is
  // deliberately not a shell: commands are never evaluated through a shell.
  const tokens = [];
  const pattern = /"((?:\\.|[^"\\])*)"|'([^']*)'|([^\s]+)/g;
  let match;
  const source = String(command);
  while ((match = pattern.exec(source))) tokens.push((match[1] ?? match[2] ?? match[3]).replace(/\\([\\"'])/g, '$1'));
  invariant(tokens.length > 0, 'Agent command cannot be empty');
  return tokens;
}

function defaultAgentCommand(profile) {
  if (profile === 'codex') return ['codex', 'exec', '--ephemeral', '{instructions}\n\nTask:\n{prompt}'];
  return [profile];
}

/** Create an Agent Profile YAML file, preserving replaceable provider settings. */
export function createAgentProfile(workspaceOrRoot, name, options = {}) {
  if (name === undefined) {
    name = workspaceOrRoot;
    workspaceOrRoot = process.cwd();
  }
  const workspace = configFor(workspaceOrRoot);
  const profile = profileName(name);
  const path = join(workspace.workspaceDir, 'agents', `${profile}.yaml`);
  invariant(!existsSync(path), `Agent profile already exists: ${profile}`);
  const value = {
    name: profile,
    provider: options.provider ?? 'command',
    ...(commandArgv(options.command) ? { command: commandArgv(options.command) } : { command: defaultAgentCommand(profile) }),
    instructions: options.instructions ?? '',
    skills: options.skills ?? [],
    context_scope: options.context_scope ?? { repositories: 'all' },
    mutation_scope: options.mutation_scope ?? { repositories: 'primary' },
    resource_policy: options.resource_policy ?? {},
    integration_policy: options.integration_policy ?? {},
    concurrency: options.concurrency ?? 'allow',
    validation: options.validation ?? [],
    ports: options.ports ?? [],
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, stringifyYaml(value), 'utf8');
  return value;
}

export const addAgentProfile = createAgentProfile;
export const agentAdd = createAgentProfile;

export function loadAgentProfile(workspaceOrRoot, name) {
  if (name === undefined) {
    name = workspaceOrRoot;
    workspaceOrRoot = process.cwd();
  }
  const workspace = configFor(workspaceOrRoot);
  const profile = profileName(name);
  const path = join(workspace.workspaceDir, 'agents', `${profile}.yaml`);
  if (!existsSync(path)) throw new WorkspaceError(`Agent profile not found: ${profile}`);
  try { return parseYaml(readFileSync(path, 'utf8')) ?? {}; } catch (cause) {
    throw new WorkspaceError(`Invalid agent profile: ${path}`, { cause });
  }
}

export function listAgentProfiles(workspaceOrRoot = process.cwd()) {
  const workspace = configFor(workspaceOrRoot);
  const directory = join(workspace.workspaceDir, 'agents');
  if (!existsSync(directory)) return [];
  return readdirSafe(directory)
    .filter((name) => name.endsWith('.yaml') || name.endsWith('.yml'))
    .map((name) => name.replace(/\.ya?ml$/, ''))
    .sort();
}

function readdirSafe(directory) {
  try { return readdirSync(directory); } catch { return []; }
}
