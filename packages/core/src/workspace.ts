import { randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
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
import { remoteUrl, repositoryRoot, runGit } from './git.js';
import { writeWorkspaceAgentFiles } from './agent-guidance.js';

const WORKSPACE_DIR = '.workspace';
const CONFIG_FILE = 'workspace.yaml';
const CONFIG_DIRS = ['context', 'agents', 'history/runs', 'proposals', 'runtime'];
const CONTEXT_FILES = ['architecture.md', 'conventions.md', 'policies.md'];

function absoluteExistingPath(value) {
  const candidate = resolve(String(value));
  if (!existsSync(candidate)) throw new WorkspaceError(`Path does not exist: ${candidate}`);
  return realpathSync(candidate);
}

function workspaceRootFrom(input: any = process.cwd()) {
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

function ensureIgnoreEntry(path, entry, header = '') {
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const hasEntry = existing.split(/\r?\n/).some((line) => line.trim() === entry);
  if (hasEntry) return;
  const prefix = existing.length === 0
    ? header
    : (existing.endsWith('\n') ? existing : `${existing}\n`);
  const separator = prefix.length > 0 && !prefix.endsWith('\n') ? '\n' : '';
  writeFileSync(path, `${prefix}${separator}${entry}\n`, 'utf8');
}

function ensureDirectory(path, description) {
  if (existsSync(path)) {
    const stats = lstatSync(path);
    invariant(stats.isDirectory() && !stats.isSymbolicLink(),
      `${description} must be a real directory: ${path}`);
    return;
  }
  mkdirSync(path, { recursive: true });
}

/** Initialize a workspace and its durable/runtime directory layout. */
export function initWorkspace(root = process.cwd(), options: any = {}) {
  const workspaceRoot = absoluteExistingPath(root);
  const workspaceDir = join(workspaceRoot, WORKSPACE_DIR);
  const configPath = join(workspaceDir, CONFIG_FILE);
  if (existsSync(configPath) && !options.force) {
    throw new WorkspaceError(`Workspace already initialized at ${workspaceDir}`);
  }

  ensureDirectory(join(workspaceRoot, 'repos'), 'Workspace repository directory');
  mkdirSync(workspaceDir, { recursive: true });
  for (const directory of CONFIG_DIRS) mkdirSync(join(workspaceDir, directory), { recursive: true });
  for (const file of CONTEXT_FILES) {
    const path = join(workspaceDir, 'context', file);
    if (!existsSync(path)) writeFileSync(path, `# ${parse(file).name}\n\n`, 'utf8');
  }

  // Runtime state is disposable and must never enter durable Git history. The
  // marker keeps the directory available after a fresh clone.
  writeFileSync(join(workspaceDir, 'runtime', '.gitkeep'), '', 'utf8');
  ensureIgnoreEntry(
    join(workspaceDir, '.gitignore'),
    'runtime/',
    '# Local operational state (SQLite, logs, worktrees, and process data)\n',
  );
  // Repositories are independent checkouts and are intentionally not part of
  // the workspace repository's Git history. Preserve any user entries while
  // making the convention explicit and anchored to the workspace root.
  ensureIgnoreEntry(join(workspaceRoot, '.gitignore'), '/repos/');

  const existing = existsSync(configPath) ? (parseYaml(readFileSync(configPath, 'utf8')) ?? {}) : {};
  const config = {
    version: WORKSPACE_VERSION,
    id: existing.id ?? randomUUID(),
    name: options.name ?? existing.name ?? parse(workspaceRoot).base,
    repositories: Array.isArray(existing.repositories) ? existing.repositories : [],
    context: existing.context ?? { revision: 0 },
  };
  const workspace = { root: workspaceRoot, workspaceDir, configPath, config };
  writeConfig(workspace, config);
  const loaded = loadWorkspace(workspaceRoot);
  writeWorkspaceAgentFiles(loaded);
  return loaded;
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
  const workspace: any = { root, workspaceDir, configPath, config };
  // Keep the durable manifest portable while exposing resolved paths to
  // runtime consumers (RunOrchestrator and providers).
  workspace.repositories = config.repositories.map((repository) => ({
    ...repository,
    path: repository.path === undefined || repository.path === null
      ? undefined
      : realpathOrResolve(repository.path, root),
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

export function normalizeRepositoryName(value) {
  const name = String(value ?? '').trim().toLowerCase();
  invariant(name.length > 0, 'Repository/profile name cannot be empty');
  invariant(/^[a-z0-9][a-z0-9_-]*$/.test(name),
    `Invalid name "${value}"; use letters, numbers, '-' or '_'`);
  return name;
}

const normalizedName = normalizeRepositoryName;

function repositoryNameFromUrl(value) {
  const source = String(value ?? '').trim().replace(/[?#].*$/, '').replace(/\/+$/, '');
  let candidate = source;
  try {
    candidate = new URL(source).pathname;
  } catch {
    // SCP-style Git URLs (`git@example.com:org/repository.git`) and local
    // filesystem paths are not valid WHATWG URLs; their final path segment is
    // still a safe and useful default repository name.
  }
  candidate = candidate.split(/[\\/:]/).filter(Boolean).pop() ?? '';
  candidate = candidate.replace(/\.git$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '');
  return normalizeRepositoryName(candidate || 'repository');
}

function normalizeRepositoryArguments(workspaceOrRoot, repositoryPath, options) {
  let workspaceInput = workspaceOrRoot;
  let pathInput = repositoryPath;
  let repositoryOptions = { ...(options ?? {}) };

  // `addRepository(workspace, { path, url, ... })` is convenient for callers
  // that already have a manifest-shaped value. Explicit trailing options win.
  if (pathInput && typeof pathInput === 'object' && !Array.isArray(pathInput)) {
    repositoryOptions = { ...pathInput, ...repositoryOptions };
    pathInput = repositoryOptions.path;
  }

  if (pathInput === undefined && repositoryOptions.path !== undefined) {
    pathInput = repositoryOptions.path;
  }

  // Preserve the original shorthand `addRepository('/path/to/repo')` while
  // also accepting `addRepository({ path, url })` from process.cwd().
  if (pathInput === undefined && typeof workspaceInput === 'string' && !repositoryOptions.url) {
    pathInput = workspaceInput;
    workspaceInput = process.cwd();
  } else if (
    pathInput === undefined
    && workspaceInput
    && typeof workspaceInput === 'object'
    && !workspaceInput.root
    && !workspaceInput.config
    && (workspaceInput.path !== undefined || workspaceInput.url !== undefined)
  ) {
    repositoryOptions = { ...workspaceInput, ...repositoryOptions };
    pathInput = repositoryOptions.path;
    workspaceInput = process.cwd();
  }

  return { workspaceInput, pathInput, repositoryOptions };
}

function explicitRepositoryUrl(options) {
  if (options.url === undefined || options.url === null) return undefined;
  invariant(typeof options.url === 'string' && options.url.trim().length > 0,
    'Repository URL must be a non-empty string');
  return options.url.trim();
}

function portableRepositoryPath(workspace, path) {
  return relative(workspace.root, path) || '.';
}

/** Add a Git repository to the manifest. The first repository is primary. */
export async function addRepository(workspaceOrRoot, repositoryPath, options: any = {}) {
  const { workspaceInput, pathInput, repositoryOptions } = normalizeRepositoryArguments(
    workspaceOrRoot,
    repositoryPath,
    options,
  );
  const workspace = configFor(workspaceInput);
  const configuredUrl = explicitRepositoryUrl(repositoryOptions);
  const path = pathInput === undefined || pathInput === null
    ? undefined
    : await gitRoot(absoluteExistingPath(pathInput));
  const url = configuredUrl ?? (path ? await remoteUrl(path) : undefined);
  invariant(path || url, 'Repository path or URL is required');
  const name = normalizedName(repositoryOptions.name ?? (path ? parse(path).base : repositoryNameFromUrl(url)));
  const repositories = workspace.config.repositories;
  if (path) {
    invariant(!repositories.some((repo) => repo.path !== undefined
      && realpathOrResolve(repo.path, workspace.root) === path),
    `Repository already registered: ${path}`);
  }
  invariant(!repositories.some((repo) => normalizedName(repo.name) === name),
    `Repository name already registered: ${name}`);
  const role = repositories.length === 0 ? 'primary' : (repositoryOptions.role ?? 'secondary');
  const repository: any = {
    name,
    // Keep the manifest portable when repositories live beside the workspace.
    // Consumers should resolve this path against workspace.root before use.
    ...(path ? { path: portableRepositoryPath(workspace, path) } : {}),
    ...(url ? { url } : {}),
    role,
    context: repositoryOptions.context ?? true,
  };
  repositories.push(repository);
  writeConfig(workspace, workspace.config);
  if (Array.isArray(workspace.repositories)) {
    workspace.repositories.push({ ...repository, path });
  }
  writeWorkspaceAgentFiles(workspace);
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

function repositoryByName(workspace, name) {
  const normalized = normalizedName(name);
  return workspace.config.repositories.find((repository) => normalizedName(repository.name) === normalized);
}

function repositoryDestination(workspace, name, requestedPath = undefined) {
  const repositoriesRoot = join(workspace.root, 'repos');
  ensureDirectory(repositoriesRoot, 'Workspace repository directory');
  const destination = requestedPath === undefined
    ? resolve(repositoriesRoot, name)
    : resolve(workspace.root, String(requestedPath));
  const child = relative(repositoriesRoot, destination);
  invariant(child && child !== '..' && !child.startsWith('..') && !isAbsolute(child),
    `Unsafe repository destination: ${destination}`);
  invariant(dirname(child) === '.',
    `Repository destination must be a direct child of repos/: ${destination}`);
  return destination;
}

function existingDirectoryKind(path) {
  if (!existsSync(path)) return 'missing';
  const stats = lstatSync(path);
  if (stats.isSymbolicLink()) return 'symlink';
  if (!stats.isDirectory()) return 'file';
  return 'directory';
}

async function ensureDestinationRepository(destination) {
  const kind = existingDirectoryKind(destination);
  if (kind === 'missing') return false;
  invariant(kind === 'directory',
    `Repository destination is unsafe (expected a directory): ${destination}`);
  try {
    const root = await gitRoot(destination);
    invariant(root === realpathSync(destination),
      `Repository destination contains a nested Git repository: ${destination}`);
    return true;
  } catch (cause) {
    if (cause instanceof WorkspaceError) {
      throw new WorkspaceError(`Repository destination exists but is not a Git repository: ${destination}`, { cause });
    }
    throw cause;
  }
}

function repositoryManifestPath(workspace, destination) {
  return portableRepositoryPath(workspace, destination);
}

function updateMaterializedRepository(workspace, repository, destination, url) {
  const path = repositoryManifestPath(workspace, destination);
  if (repository.path !== path) repository.path = path;
  if (url && repository.url !== url) repository.url = url;
  const runtime = Array.isArray(workspace.repositories)
    ? workspace.repositories.find((entry) => entry.name === repository.name)
    : undefined;
  if (runtime) runtime.path = destination;
  writeConfig(workspace, workspace.config);
  writeWorkspaceAgentFiles(workspace);
  return { ...repository, path: destination };
}

/**
 * Clone a Git URL into the workspace's managed `repos/` directory and add it
 * to the manifest. Git receives an argv array and never a shell command.
 */
export async function cloneRepository(workspaceOrRoot, url, options: any = {}) {
  if (workspaceOrRoot && typeof workspaceOrRoot === 'object'
    && !workspaceOrRoot.root && !workspaceOrRoot.config && url === undefined) {
    options = { ...workspaceOrRoot, ...options };
    workspaceOrRoot = process.cwd();
    url = options.url;
  }
  if (url === undefined && typeof workspaceOrRoot === 'string') {
    url = workspaceOrRoot;
    workspaceOrRoot = process.cwd();
  }
  if (url && typeof url === 'object' && !Array.isArray(url)) {
    options = { ...url, ...options };
    url = options.url;
  }
  invariant(typeof url === 'string' && url.trim().length > 0, 'Repository URL must be a non-empty string');
  const workspace = configFor(workspaceOrRoot);
  const source = url.trim();
  const name = normalizedName(options.name ?? repositoryNameFromUrl(source));
  const destination = repositoryDestination(workspace, name, options.path);
  const existing = await ensureDestinationRepository(destination);
  const registered = repositoryByName(workspace, name);
  if (existing) {
    if (registered) {
      const configuredPath = registered.path === undefined
        ? undefined
        : realpathOrResolve(registered.path, workspace.root);
      invariant(!configuredPath || configuredPath === destination,
        `Repository name already registered at another path: ${name}`);
      return updateMaterializedRepository(workspace, registered, destination, source);
    }
    return addRepository(workspace, destination, { ...options, name, url: source });
  }
  invariant(!registered, `Repository name already registered: ${name}`);
  await runGit(['clone', '--', source, destination], { cwd: workspace.root });
  return addRepository(workspace, destination, { ...options, name, url: source });
}

export const cloneRepo = cloneRepository;
export const cloneRepositoryFromUrl = cloneRepository;

/** Materialize one URL-backed manifest entry into `repos/<name>`. */
export async function materializeRepository(workspaceOrRoot, repositoryOrName, options: any = {}) {
  const workspace = configFor(workspaceOrRoot);
  let repository = repositoryOrName;
  if (typeof repositoryOrName === 'string') repository = repositoryByName(workspace, repositoryOrName);
  invariant(repository && typeof repository === 'object', 'Repository manifest entry is required');
  const registered = repository.name ? repositoryByName(workspace, repository.name) : undefined;
  if (registered) repository = registered;
  invariant(repository.url, `Repository has no URL to materialize: ${repository.name ?? '(unnamed)'}`);
  const name = normalizedName(options.name ?? repository.name ?? repositoryNameFromUrl(repository.url));
  if (repository.path !== undefined && repository.path !== null) {
    const configuredPath = resolve(workspace.root, String(repository.path));
    if (existsSync(configuredPath)) {
      const kind = existingDirectoryKind(configuredPath);
      invariant(kind === 'directory',
        `Repository destination is unsafe (expected a Git directory): ${configuredPath}`);
      const configuredRoot = await gitRoot(configuredPath);
      // Existing checkouts are allowed to remain where they are; this API is
      // for missing entries and must not silently relocate a live checkout.
      return { ...repository, path: configuredRoot, materialized: false };
    }
  }
  const destination = repositoryDestination(workspace, name, options.path ?? repository.path);
  const existing = await ensureDestinationRepository(destination);
  if (!existing) {
    await runGit(['clone', '--', String(repository.url), destination], { cwd: workspace.root });
  }
  if (!registered) {
    // URL-only entries passed directly to this API are first registered; this
    // also preserves role/context fields supplied by the manifest-shaped value.
    return addRepository(workspace, destination, { ...repository, ...options, name, url: repository.url });
  }
  return updateMaterializedRepository(workspace, registered, destination, String(repository.url));
}

export const materializeRepo = materializeRepository;

/** Materialize every missing URL-backed repository in manifest order. */
export async function materializeMissingRepositories(workspaceOrRoot = process.cwd(), options: any = {}) {
  const workspace = configFor(workspaceOrRoot);
  const results = [];
  for (const repository of [...workspace.config.repositories]) {
    const configuredPath = repository.path === undefined || repository.path === null
      ? undefined
      : realpathOrResolve(repository.path, workspace.root);
    if (configuredPath && existsSync(configuredPath)) {
      // A configured path that exists must still be a Git repository. This
      // catches accidental files before an agent attempts to use the entry.
      invariant(existingDirectoryKind(configuredPath) === 'directory',
        `Repository destination is unsafe (expected a real Git directory): ${configuredPath}`);
      await gitRoot(configuredPath);
      results.push({ ...repository, path: configuredPath, materialized: false });
      continue;
    }
    if (!repository.url) {
      if (configuredPath) {
        throw new WorkspaceError(`Repository path does not exist and has no URL: ${configuredPath}`);
      }
      throw new WorkspaceError(`Repository has no path or URL to materialize: ${repository.name}`);
    }
    if (repository.path !== undefined && repository.path !== null) {
      const configuredPath = resolve(workspace.root, String(repository.path));
      const expectedPath = repositoryDestination(
        workspace,
        normalizedName(repository.name),
        repository.path,
      );
      invariant(configuredPath === expectedPath,
        `Unsafe repository destination: ${configuredPath}; expected ${expectedPath}`);
    }
    results.push({
      ...(await materializeRepository(workspace, repository, options)),
      materialized: true,
    });
  }
  return results;
}

export const materializeRepositories = materializeMissingRepositories;
export const materializeWorkspaceRepositories = materializeMissingRepositories;

/** Generate or refresh the coding-agent guidance owned by this workspace. */
export function generateWorkspaceAgentFiles(workspaceOrRoot = process.cwd()) {
  return writeWorkspaceAgentFiles(configFor(workspaceOrRoot));
}

export const refreshWorkspaceAgentFiles = generateWorkspaceAgentFiles;

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
export function createAgentProfile(workspaceOrRoot, name, options: any = {}) {
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
