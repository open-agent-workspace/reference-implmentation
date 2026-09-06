import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { WorkspaceError, invariant } from './errors.js';
import { discoverWorkspace } from './workspace.js';

export const SYSTEM_VERSION = 1;
export const SYSTEM_REGISTRY_DIR = 'system';
export const SYSTEM_REGISTRY_FILES = Object.freeze({
  systems: 'systems.yaml',
  layers: 'layers.yaml',
  resources: 'resources.yaml',
  repositories: 'repos.yaml',
});

function workspaceFor(input = process.cwd()) {
  const start: any = input ?? process.cwd();
  return start != null && typeof start === 'object' && start.root ? start : discoverWorkspace(start);
}

function registryPath(workspace, filename) {
  return join(workspace.root, SYSTEM_REGISTRY_DIR, filename);
}

function readRegistry(workspace, key, filename) {
  const path = registryPath(workspace, filename);
  if (!existsSync(path)) return { present: false, path, values: [] };
  let document;
  try {
    document = parseYaml(readFileSync(path, 'utf8')) ?? {};
  } catch (cause) {
    throw new WorkspaceError(`Invalid system registry: ${path}`, { cause });
  }
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new WorkspaceError(`System registry must contain a mapping: ${path}`);
  }
  const values = document[key] ?? (key === 'repositories' ? document.repos : undefined) ?? [];
  if (!Array.isArray(values)) throw new WorkspaceError(`${key} must be an array: ${path}`);
  return { present: true, path, version: document.version, values };
}

function derivedRegistries(workspace) {
  const repositories = (workspace.config.repositories ?? []).map((repository) => ({
    id: String(repository.name),
    manifest_name: String(repository.name),
    resource: String(repository.name),
    systems: [],
    layers: [],
  }));
  const resources = (workspace.config.repositories ?? []).map((repository) => ({
    id: String(repository.name),
    name: String(repository.name),
    kind: 'repo',
    systems: [],
    layers: [],
    repository: String(repository.name),
    ...(repository.path !== undefined ? { path: repository.path } : {}),
    ...(repository.role !== undefined ? { role: repository.role } : {}),
    ...(repository.url !== undefined ? { url: repository.url } : {}),
    lifecycle: 'active',
  }));
  return { systems: [], layers: [], resources, repositories };
}

function repositoryFallbacks(workspace, resources, repositories) {
  const mappedNames = new Set(repositories.map((entry) => entry?.manifest_name).filter(Boolean));
  const fallback = [];
  for (const repository of workspace.config.repositories ?? []) {
    const name = String(repository.name);
    const hasResource = resources.some((resource) => resource?.repository === name);
    if (mappedNames.has(name) || hasResource) continue;
    let resourceId = name;
    while (resources.some((resource) => resource?.id === resourceId)) resourceId = `repo-${resourceId}`;
    const resource = {
      id: resourceId,
      name,
      kind: 'repo',
      systems: [],
      layers: [],
      repository: name,
      derived: true,
      ...(repository.path !== undefined ? { path: repository.path } : {}),
      ...(repository.role !== undefined ? { role: repository.role } : {}),
      ...(repository.url !== undefined ? { url: repository.url } : {}),
      lifecycle: 'active',
    };
    resources.push(resource);
    repositories.push({ id: name, manifest_name: name, resource: resourceId, systems: [], layers: [], derived: true });
    fallback.push(resourceId);
  }
  return fallback;
}

/**
 * Load the durable system topology. Existing workspaces without any system
 * registries get repository resources derived from workspace.yaml. When a
 * registry exists, it remains canonical; workspace repositories not yet
 * represented by a repository/resource mapping are appended as derived
 * fallback entries so adding a repository remains discoverable.
 */
export function loadSystemModel(workspaceOrRoot = process.cwd()) {
  const workspace = workspaceFor(workspaceOrRoot);
  const systems = readRegistry(workspace, 'systems', SYSTEM_REGISTRY_FILES.systems);
  const layers = readRegistry(workspace, 'layers', SYSTEM_REGISTRY_FILES.layers);
  const resources = readRegistry(workspace, 'resources', SYSTEM_REGISTRY_FILES.resources);
  const repositories = readRegistry(workspace, 'repositories', SYSTEM_REGISTRY_FILES.repositories);
  const hasRegistry = systems.present || layers.present || resources.present || repositories.present;
  const derived = !hasRegistry ? derivedRegistries(workspace) : {
    systems: systems.values,
    layers: layers.values,
    resources: resources.values,
    repositories: repositories.values,
  };
  const fallbackResourceIds = !hasRegistry
    ? new Set(derived.resources.map((resource) => resource.id))
    : new Set(repositoryFallbacks(workspace, derived.resources, derived.repositories).map((name) => name));
  const derivedResources = [...fallbackResourceIds];
  return {
    version: SYSTEM_VERSION,
    root: workspace.root,
    directory: join(workspace.root, SYSTEM_REGISTRY_DIR),
    derived: !hasRegistry || derivedResources.length > 0,
    derivedResources,
    files: {
      systems: systems.path,
      layers: layers.path,
      resources: resources.path,
      repositories: repositories.path,
    },
    registryVersions: {
      systems: systems.version,
      layers: layers.version,
      resources: resources.version,
      repositories: repositories.version,
    },
    systems: derived.systems,
    layers: derived.layers,
    resources: derived.resources,
    repositories: derived.repositories,
  };
}

export const loadSystemTopology = loadSystemModel;

function matchesResource(resource, filters) {
  if (filters.system && !(resource.systems ?? []).includes(filters.system)) return false;
  if (filters.layer && !(resource.layers ?? []).includes(filters.layer)) return false;
  if (filters.kind && resource.kind !== filters.kind) return false;
  return true;
}

/** Discover declared resources by architecture relationship, without runtime adapters. */
export function discoverResources(workspaceOrRoot = process.cwd(), filters = {}) {
  const model = loadSystemModel(workspaceOrRoot);
  return model.resources.filter((resource) => matchesResource(resource, filters));
}

export const discoverSystemResources = discoverResources;
export const discoverSystem = discoverResources;
export const discoverSystemModel = loadSystemModel;

function addError(errors, path, message) {
  errors.push({ path, message });
}

function checkIdList(errors, values, path, known, label) {
  if (values === undefined) return;
  if (!Array.isArray(values)) {
    addError(errors, path, `${label} must be an array`);
    return;
  }
  for (const value of values) {
    if (typeof value !== 'string' || !value.trim()) addError(errors, path, `${label} contains an invalid reference`);
    else if (!known.has(value)) addError(errors, `${path}.${value}`, `Unknown ${label.slice(0, -1)} reference: ${value}`);
  }
}

function validateEntries(errors, values, label, required) {
  if (!Array.isArray(values)) {
    addError(errors, label, `${label} must be an array`);
    return new Map();
  }
  const ids = new Map();
  values.forEach((entry, index) => {
    const path = `${label}[${index}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      addError(errors, path, `${label} entries must be mappings`);
      return;
    }
    for (const field of required) {
      if (typeof entry[field] !== 'string' || !entry[field].trim()) addError(errors, `${path}.${field}`, `Missing required field: ${field}`);
    }
    if (typeof entry.id === 'string' && entry.id.trim()) {
      if (ids.has(entry.id)) addError(errors, `${path}.id`, `Duplicate ${label} id: ${entry.id}`);
      else ids.set(entry.id, entry);
    }
  });
  return ids;
}

function safeRelativePath(value, root) {
  if (typeof value !== 'string' || !value.trim() || isAbsolute(value)) return false;
  const resolved = resolve(root, value);
  const escaped = relative(root, resolved);
  return escaped === '' || (escaped !== '..' && !escaped.startsWith(`..${sep}`) && !isAbsolute(escaped));
}

/** Validate topology references and local path safety without opening runtime state. */
export function validateSystemModel(workspaceOrRoot = process.cwd()) {
  const errors = [];
  const warnings = [];
  let model;
  try {
    model = loadSystemModel(workspaceOrRoot);
  } catch (error) {
    return { valid: false, derived: false, errors: [{ path: 'system', message: error.message }], warnings: [] };
  }
  const systemIds = new Set(validateEntries(errors, model.systems, 'systems', ['id', 'name']).keys());
  const layerIds = new Set(validateEntries(errors, model.layers, 'layers', ['id', 'name']).keys());
  const resourceIds = new Set(validateEntries(errors, model.resources, 'resources', ['id', 'name', 'kind']).keys());
  const workspaceRepositoryNames = new Set((workspaceFor(workspaceOrRoot).config.repositories ?? []).map((repo) => String(repo.name)));
  const repositoryEntries = validateEntries(errors, model.repositories, 'repositories', ['id', 'manifest_name', 'resource']);

  for (const [name, version] of Object.entries(model.registryVersions)) {
    if (version !== undefined && Number(version) !== SYSTEM_VERSION) addError(errors, `system/${name}.yaml.version`, `Unsupported registry version: ${version}`);
  }
  for (const [index, resource] of model.resources.entries()) {
    if (!resource || typeof resource !== 'object') continue;
    if (!model.derivedResources.includes(resource.id) && (!Array.isArray(resource.systems) || resource.systems.length === 0)) addError(errors, `resources[${index}].systems`, 'Declared resources must reference at least one system');
    if (!model.derivedResources.includes(resource.id) && (!Array.isArray(resource.layers) || resource.layers.length === 0)) addError(errors, `resources[${index}].layers`, 'Declared resources must reference at least one layer');
    checkIdList(errors, resource.systems, `resources[${index}].systems`, systemIds, 'systems');
    checkIdList(errors, resource.layers, `resources[${index}].layers`, layerIds, 'layers');
    if (resource.kind !== undefined && (typeof resource.kind !== 'string' || !resource.kind.trim())) addError(errors, `resources[${index}].kind`, 'Resource kind must be a non-empty string');
    if (resource.path !== undefined && !safeRelativePath(resource.path, model.root)) addError(errors, `resources[${index}].path`, 'Local paths must be relative and stay inside the workspace root');
    if (resource.repository !== undefined && (typeof resource.repository !== 'string' || !workspaceRepositoryNames.has(resource.repository))) addError(errors, `resources[${index}].repository`, `Unknown repository manifest name: ${resource.repository}`);
  }
  for (const [index, repository] of model.repositories.entries()) {
    if (!repository || typeof repository !== 'object') continue;
    if (typeof repository.manifest_name === 'string' && !workspaceRepositoryNames.has(repository.manifest_name)) addError(errors, `repositories[${index}].manifest_name`, `Repository manifest name is not registered: ${repository.manifest_name}`);
    if (typeof repository.resource === 'string' && !resourceIds.has(repository.resource)) addError(errors, `repositories[${index}].resource`, `Unknown resource reference: ${repository.resource}`);
    const resource = typeof repository.resource === 'string'
      ? model.resources.find((entry) => entry?.id === repository.resource)
      : undefined;
    if (resource && resource.kind !== 'repo') addError(errors, `repositories[${index}].resource`, `Repository mapping must point to a repo resource: ${repository.resource}`);
    if (resource && resource.repository !== undefined && resource.repository !== repository.manifest_name) addError(errors, `repositories[${index}].resource`, `Resource repository does not match manifest_name: ${repository.manifest_name}`);
    checkIdList(errors, repository.systems, `repositories[${index}].systems`, systemIds, 'systems');
    checkIdList(errors, repository.layers, `repositories[${index}].layers`, layerIds, 'layers');
  }
  for (const [name, repo] of Object.entries<any>(workspaceFor(workspaceOrRoot).config.repositories ?? {})) {
    if (repo && typeof repo === 'object' && repo.path !== undefined && !safeRelativePath(repo.path, model.root)) addError(errors, `workspace.repositories.${name}.path`, 'Repository paths must be relative and stay inside the workspace root');
  }
  if (model.derived && model.derivedResources.length) warnings.push({ path: 'system', message: model.files.resources && existsSync(model.files.resources) ? 'Unmapped workspace repositories were derived into the system topology' : 'System registries are absent; repository resources were derived from workspace.yaml' });
  return { valid: errors.length === 0, derived: model.derived, errors, warnings, model };
}

export const validateSystem = validateSystemModel;
export const validateSystemTopology = validateSystemModel;

function writeRegistry(root, filename, key) {
  const directory = join(root, SYSTEM_REGISTRY_DIR);
  mkdirSync(directory, { recursive: true });
  const path = join(directory, filename);
  if (!existsSync(path)) writeFileSync(path, stringifyYaml({ version: SYSTEM_VERSION, [key]: [] }), 'utf8');
  return path;
}

/** Create starter durable system registries while preserving existing files. */
export function initializeSystemRegistries(root) {
  invariant(root, 'Workspace root is required');
  return {
    systems: writeRegistry(root, SYSTEM_REGISTRY_FILES.systems, 'systems'),
    layers: writeRegistry(root, SYSTEM_REGISTRY_FILES.layers, 'layers'),
    resources: writeRegistry(root, SYSTEM_REGISTRY_FILES.resources, 'resources'),
    repositories: writeRegistry(root, SYSTEM_REGISTRY_FILES.repositories, 'repositories'),
  };
}

export const initSystemRegistries = initializeSystemRegistries;
