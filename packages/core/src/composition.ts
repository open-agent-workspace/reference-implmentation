import { closeSync, existsSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parse, stringify } from 'yaml';
import { invariant, WorkspaceError } from './errors.js';
import { discoverWorkspace, loadWorkspace } from './workspace.js';

export interface WorkspaceReference {
  workspace_id: string;
  alias: string;
  path: string;
  role?: string;
  access: 'read-only' | 'read-write';
}
export interface WorkspaceComposition {
  version: 1;
  workspace_id: string;
  name: string;
  members: WorkspaceReference[];
}

function owner(value: any) {
  return value?.config && value?.root ? value : discoverWorkspace(value);
}
function manifest(workspace) { return join(workspace.workspaceDir, 'composition.yaml'); }
function identifier(value, label) {
  invariant(typeof value === 'string' && value.trim().length > 0, `Invalid ${label}`);
}
function alias(value) {
  invariant(typeof value === 'string' && /^[a-z0-9][a-z0-9_-]*$/.test(value), 'Alias must contain lowercase letters, digits, hyphens or underscores');
}
function schema(value, workspace): asserts value is WorkspaceComposition {
  invariant(value && value.version === 1, 'Unsupported composition version');
  identifier(workspace.config.id, 'owner workspace ID');
  invariant(value.workspace_id === workspace.config.id, 'Composition owner identity mismatch');
  identifier(value.name, 'composition name');
  invariant(Array.isArray(value.members), 'Composition members must be an array');
  const aliases = new Set();
  const identities = new Set();
  for (const member of value.members) {
    invariant(member && typeof member === 'object', 'Invalid composition member');
    alias(member.alias);
    identifier(member.workspace_id, 'member workspace ID');
    identifier(member.path, 'member path');
    invariant(member.role === undefined || typeof member.role === 'string', 'Invalid member role');
    invariant(['read-only', 'read-write'].includes(member.access), 'Invalid member access');
    invariant(!aliases.has(member.alias), `Duplicate member alias: ${member.alias}`);
    invariant(!identities.has(member.workspace_id), `Duplicate member workspace ID: ${member.workspace_id}`);
    aliases.add(member.alias);
    identities.add(member.workspace_id);
  }
}

/** Optional, Git-friendly declaration; no member data or runtime state is read. */
export function loadComposition(workspaceOrRoot: any = process.cwd()): WorkspaceComposition {
  const workspace = owner(workspaceOrRoot);
  let value;
  try { value = parse(readFileSync(manifest(workspace), 'utf8')); }
  catch (cause) { throw new WorkspaceError(`Cannot read composition: ${manifest(workspace)}`, { cause }); }
  schema(value, workspace);
  return value;
}

/** Serialize local writers; atomically replace the manifest, preserving the old file on failure. */
function mutate(workspace, operation) {
  const path = manifest(workspace);
  const lock = `${path}.lock`;
  let descriptor;
  try { descriptor = openSync(lock, 'wx', 0o600); }
  catch (cause) { throw new WorkspaceError(`Composition is locked: ${lock}; if interrupted, verify no writer remains before removing this lock`, { cause }); }
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const value = operation();
    schema(value, workspace);
    writeFileSync(temporary, stringify(value), { flag: 'wx' });
    renameSync(temporary, path);
    return value;
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
    closeSync(descriptor);
    unlinkSync(lock);
  }
}

export function createComposition(workspaceOrRoot: any, name?: string) {
  const workspace = owner(workspaceOrRoot);
  return mutate(workspace, () => {
    invariant(!existsSync(manifest(workspace)), 'Composition already exists');
    return { version: 1, workspace_id: workspace.config.id, name: name ?? workspace.config.name, members: [] };
  });
}

function memberWorkspace(workspace, member) {
  // Exact root loading is essential: ancestor discovery could silently bind a missing member to its parent.
  const loaded = loadWorkspace(resolve(workspace.root, member.path));
  invariant(loaded.config.id === member.workspace_id, `Identity mismatch for ${member.alias}: expected ${member.workspace_id}, found ${loaded.config.id ?? '(missing)'}`);
  return loaded;
}

function memberAt(workspace, value, memberAlias) {
  alias(memberAlias);
  const member = value.members.find((item) => item.alias === memberAlias);
  invariant(member, `Member not found: ${memberAlias}`);
  return member;
}

/** Read only manifests, recursively. Missing references become diagnostics, never implicit initialization. */
function inspect(workspace, composition, ancestors: string[] = [], prefix = '', depth = 0): any {
  const errors: string[] = [];
  const chain = [...ancestors, workspace.config.id];
  const members = composition.members.map((member) => {
    const label = `${prefix}${member.alias}`;
    const row: any = { ...member, resolved_path: resolve(workspace.root, member.path), status: 'available' };
    try {
      invariant(depth < 64, `Composition depth exceeds 64 at ${label}`);
      invariant(!chain.includes(member.workspace_id), `Composition cycle: ${[...chain, member.workspace_id].join(' -> ')} (${label})`);
      const loaded = memberWorkspace(workspace, member);
      row.name = loaded.config.name;
      row.repositories = loaded.config.repositories.map(({ name, role }) => ({ name, role }));
      if (existsSync(manifest(loaded))) {
        const nested = inspect(loaded, loadComposition(loaded), chain, `${label}/`, depth + 1);
        row.members = nested.members;
        errors.push(...nested.errors);
      }
    } catch (error) {
      row.status = 'unresolved';
      row.error = error.message;
      errors.push(`${label}: ${error.message}`);
    }
    return row;
  });
  return { ...composition, members, valid: errors.length === 0, errors };
}

export function inspectComposition(workspaceOrRoot: any = process.cwd()) {
  const workspace = owner(workspaceOrRoot);
  return inspect(workspace, loadComposition(workspace));
}

export function validateComposition(workspaceOrRoot: any = process.cwd()) {
  try {
    const result = inspectComposition(workspaceOrRoot);
    return { valid: result.valid, errors: result.errors };
  } catch (error) { return { valid: false, errors: [error.message] }; }
}

export function addCompositionMember(workspaceOrRoot: any, memberAlias: string, memberRoot: string, options: any = {}) {
  const workspace = owner(workspaceOrRoot);
  alias(memberAlias);
  const target = loadWorkspace(resolve(workspace.root, memberRoot));
  identifier(target.config.id, 'member workspace ID');
  return mutate(workspace, () => {
    const value = loadComposition(workspace);
    value.members.push({ workspace_id: target.config.id, alias: memberAlias,
      path: relative(workspace.root, target.root) || '.', access: options.access ?? 'read-only',
      ...(options.role !== undefined ? { role: options.role } : {}) });
    schema(value, workspace);
    // Reject cycles and invalid nested structures; unrelated unavailable members remain editable.
    const added = inspect(workspace, { ...value, members: [value.members.at(-1)!] });
    invariant(added.valid, added.errors.join('; '));
    return value;
  });
}

/** Remove only the declaration, including when the referenced workspace is offline. */
export function removeCompositionMember(workspaceOrRoot: any, memberAlias: string) {
  const workspace = owner(workspaceOrRoot);
  return mutate(workspace, () => {
    const value = loadComposition(workspace);
    memberAt(workspace, value, memberAlias);
    value.members = value.members.filter((member) => member.alias !== memberAlias);
    return value;
  });
}

/** Repair a locator without rebinding the stable identity. */
export function relocateCompositionMember(workspaceOrRoot: any, memberAlias: string, memberRoot: string) {
  const workspace = owner(workspaceOrRoot);
  return mutate(workspace, () => {
    const value = loadComposition(workspace);
    const member = memberAt(workspace, value, memberAlias);
    const target = loadWorkspace(resolve(workspace.root, memberRoot));
    invariant(target.config.id === member.workspace_id, `Identity mismatch for ${memberAlias}`);
    member.path = relative(workspace.root, target.root) || '.';
    const result = inspect(workspace, { ...value, members: [member] });
    invariant(result.valid, result.errors.join('; '));
    return value;
  });
}

/** Resolve only a selected reference path; no unrelated members need be online. */
export function resolveCompositionMember(workspaceOrRoot: any, selector: string) {
  let workspace = owner(workspaceOrRoot);
  const ancestors = [workspace];
  const edges: any[] = [];
  const segments = String(selector).split('/');
  invariant(segments.length <= 64, 'Composition depth exceeds 64');
  for (const segment of segments) {
    const member = memberAt(workspace, loadComposition(workspace), segment);
    invariant(!ancestors.some((item) => item.config.id === member.workspace_id), `Composition cycle at ${selector}`);
    const loaded = memberWorkspace(workspace, member);
    edges.push({ owner: workspace.config.id, config: manifest(workspace), ...member });
    ancestors.push(loaded);
    workspace = loaded;
  }
  return { workspace, ancestors, edges, access: edges.every((edge) => edge.access === 'read-write') ? 'read-write' : 'read-only' };
}
