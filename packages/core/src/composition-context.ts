import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parse } from 'yaml';
import { invariant } from './errors.js';
import { loadComposition, resolveCompositionMember } from './composition.js';
import { discoverWorkspace, loadAgentProfile } from './workspace.js';

export const CONTEXT_CAPABILITIES = ['instructions', 'context', 'skills', 'source'];
export const contextHash = (value: string) => createHash('sha256').update(value).digest('hex');
export function canonicalJSON(value: any): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonicalJSON(value[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export function workspaceOwner(value: any) { return value?.config ? value : discoverWorkspace(value); }

/** Lexical and physical containment: references cannot expose private files through symlinks. */
export function scopedFile(root: string, path: string) {
  invariant(typeof path === 'string' && path.length > 0 && !isAbsolute(path), `Expected a relative context path: ${path}`);
  const base = realpathSync(root);
  const candidate = resolve(base, path);
  const contained = (file) => { const rel = relative(base, file); return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };
  invariant(contained(candidate), `Context path escapes owner: ${path}`);
  if (!existsSync(candidate)) return undefined;
  // Do not let a public context/skill path alias private files even inside the same workspace.
  let component = base;
  for (const part of relative(base, candidate).split(sep)) {
    component = join(component, part);
    invariant(!lstatSync(component).isSymbolicLink(), `Context symlink is not allowed: ${path}`);
  }
  const actual = realpathSync(candidate);
  invariant(contained(actual), `Context symlink escapes owner: ${path}`);
  invariant(statSync(actual).isFile(), `Context source is not a file: ${path}`);
  return actual;
}

export interface ContextRequest {
  member: string;
  repository: string;
  paths?: string[];
  shared?: string[];
  skills?: string[];
  profile?: string;
  grants?: { read?: string[]; write?: boolean; start_agent?: boolean; read_status?: boolean };
}

/** Returns ordered, provenance-bearing scopes, never sibling instructions or private context. */
export function resolveCompositionContext(workspaceOrRoot: any, request: ContextRequest) {
  for (const key of ['paths', 'shared', 'skills']) invariant(request[key] === undefined || (Array.isArray(request[key]) && request[key].every((item) => typeof item === 'string')), `Invalid context ${key}`);
  const coordinator = workspaceOwner(workspaceOrRoot);
  const selected = resolveCompositionMember(coordinator, request.member);
  const workspace = selected.workspace;
  const repository = workspace.repositories.find((item) => item.name === request.repository);
  invariant(repository, `Repository not found in ${request.member}: ${request.repository}`);
  const grants = request.grants ?? {};
  invariant(!grants.read || (Array.isArray(grants.read) && grants.read.every((capability) => CONTEXT_CAPABILITIES.includes(capability))), 'Unsupported read capability; private agent context is not shared');
  const allowed = new Set(grants.read ?? []);
  const sources: any[] = [];
  const skills: any[] = [];
  const conflicts: any[] = [];
  const omitted: string[] = [];
  const policy_sources: any[] = [];
  const add = (owner, root, path, kind, scope, reason) => {
    const actual = scopedFile(root, path);
    if (!actual) return;
    const content = readFileSync(actual, 'utf8');
    const existing = sources.find((item) => item.workspace_id === owner && item.path === actual && item.scope === scope);
    if (existing) { if (!existing.reasons.includes(reason)) existing.reasons.push(reason); return; }
    sources.push({ workspace_id: owner, path: actual, kind, scope, reasons: [reason], sha256: contextHash(content), content });
  };
  if (grants.write && selected.access !== 'read-write') conflicts.push({ kind: 'access', message: 'Write denied by composition membership', sources: selected.edges.filter((edge) => edge.access !== 'read-write').map((edge) => `${edge.config}#${edge.alias}.access`) });
  const shared = [...new Set(request.shared ?? [])].sort();
  for (const path of shared) {
    invariant(typeof path === 'string' && !path.split(/[\\/]/).includes('..') && (path.startsWith('.workspace/context/') || path.startsWith('system/contracts/')), `Shared context must belong to .workspace/context or system/contracts: ${path}`);
    if (!allowed.has('context')) { conflicts.push({ kind: 'grant', message: `Missing context read grant for ${path}`, sources: ['request.grants.read'] }); continue; }
    invariant(scopedFile(coordinator.root, path), `Shared context not found: ${path}`);
    add(coordinator.config.id, coordinator.root, path, 'shared', 'composition integration/contracts only', 'explicit shared source');
  }
  if (allowed.has('instructions')) {
    // Ancestor guidance applies only to composition contracts, not member-local build policy.
    for (const ancestor of selected.ancestors.slice(0, -1)) {
      const path = existsSync(join(ancestor.root, 'AGENTS.override.md')) ? 'AGENTS.override.md' : 'AGENTS.md';
      add(ancestor.config.id, ancestor.root, path, 'instructions', 'composition integration/contracts only', 'composition ancestor guidance');
    }
    const rootGuidance = existsSync(join(workspace.root, 'AGENTS.override.md')) ? 'AGENTS.override.md' : 'AGENTS.md';
    add(workspace.config.id, workspace.root, rootGuidance, 'instructions', 'member workspace', 'member guidance');
    invariant(repository.path && existsSync(repository.path), `Selected repository is unavailable: ${repository.name}`);
    const instructionDirectories = new Set(['.']);
    for (const path of request.paths ?? []) {
      invariant(typeof path === 'string' && !isAbsolute(path) && !path.split(/[\\/]/).includes('..'), `Invalid task path: ${path}`);
      const normalized = relative(repository.path, resolve(repository.path, path));
      const directory = existsSync(resolve(repository.path, path)) && statSync(resolve(repository.path, path)).isDirectory() ? normalized : dirname(normalized);
      let current = directory;
      while (current && current !== '.') { instructionDirectories.add(current); current = dirname(current); }
    }
    for (const directory of [...instructionDirectories].sort((a, b) => a.split(sep).length - b.split(sep).length || a.localeCompare(b))) {
      const override = join(directory, 'AGENTS.override.md');
      const path = existsSync(join(repository.path, override)) ? override : join(directory, 'AGENTS.md');
      // Same physical root guidance is included once even if the root is itself registered as a repo.
      const actual = scopedFile(repository.path, path);
      if (actual && sources.some((item) => item.workspace_id === workspace.config.id && item.path === actual)) continue;
      add(workspace.config.id, repository.path, path, 'instructions', `repository:${repository.name}/${directory}`, 'selected repository/path guidance; nearest scope wins');
    }
  } else omitted.push('instructions: not granted');
  if (allowed.has('context')) {
    for (const path of ['architecture.md', 'conventions.md', 'policies.md']) add(workspace.config.id, workspace.root, `.workspace/context/${path}`, 'context', 'member workspace', 'member shared context');
  } else omitted.push('member context: not granted');
  let profile;
  if (request.profile) {
    // A named profile is read only with the explicit authority to start it.
    if (grants.start_agent) {
      const profilePath = scopedFile(workspace.root, `.workspace/agents/${request.profile}.yaml`);
      profile = loadAgentProfile(workspace, request.profile);
      policy_sources.push({ path: profilePath, sha256: contextHash(readFileSync(profilePath!, 'utf8')) });
      const scope = profile.mutation_scope?.repositories;
      const primary = workspace.repositories.find((item) => item.role === 'primary') ?? workspace.repositories[0];
      const permit = scope === undefined || scope === 'all' || (scope === 'primary' ? repository.name === primary?.name : Array.isArray(scope) ? scope.includes(repository.name) : scope === repository.name);
      if (grants.write && !permit) conflicts.push({ kind: 'mutation_scope', message: `Profile ${request.profile} cannot mutate ${repository.name}`, sources: [join(workspace.workspaceDir, 'agents', `${request.profile}.yaml`), 'request.repository'] });
    } else omitted.push('profile: requires start_agent grant');
  }
  if (allowed.has('skills')) {
    // Read descriptors from the existing native skill locations, with fully qualified IDs.
    const owners: any[] = selected.ancestors.map((item) => ({ id: item.config.id, root: item.root, scope: item === workspace ? 'member' : 'composition' }));
    owners.push({ id: workspace.config.id, root: repository.path, scope: `repository:${repository.name}` });
    for (const item of owners) {
      if (!item.root || !existsSync(join(item.root, '.agents/skills'))) continue;
      for (const entry of readdirSync(join(item.root, '.agents/skills')).sort()) {
        const path = `.agents/skills/${entry}/SKILL.md`;
        const actual = scopedFile(item.root, path);
        if (!actual || skills.some((skill) => skill.workspace_id === item.id && skill.path === actual)) continue;
        const raw = readFileSync(actual, 'utf8');
        const header = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
        let metadata;
        try {
          metadata = header ? parse(header[1]) : {};
          invariant(metadata && typeof metadata === 'object' && !Array.isArray(metadata), 'Invalid skill descriptor');
          invariant(metadata.name === undefined || typeof metadata.name === 'string', 'Invalid skill name');
          invariant(metadata.description === undefined || typeof metadata.description === 'string', 'Invalid skill description');
        } catch { omitted.push(`skill descriptor is invalid: ${actual}`); continue; }
        const id = `${item.id}:${item.scope}:${entry}`;
        skills.push({ id, name: metadata?.name ?? entry, description: metadata?.description ?? '', workspace_id: item.id, scope: item.scope, path: actual, loaded: false });
      }
    }
    const requested = [...new Set([...(request.skills ?? []), ...(Array.isArray(profile?.skills) ? profile.skills : [])])];
    for (const id of requested) {
      // Unqualified names are supported only within the selected member's root profile.
      const matches = skills.filter((skill) => skill.id === id || (skill.scope === 'member' && skill.workspace_id === workspace.config.id && skill.name === id));
      invariant(matches.length === 1, `Skill reference is missing or ambiguous: ${id}`);
      const skill = matches[0];
      if (skill.loaded) continue;
      const content = readFileSync(skill.path, 'utf8');
      skill.loaded = true;
      sources.push({ workspace_id: skill.workspace_id, path: skill.path, kind: 'skill', scope: skill.scope, reasons: ['explicit task/profile skill selection'], sha256: contextHash(content), content });
    }
  } else {
    omitted.push('skills: not granted');
    if (request.skills?.length || profile?.skills?.length) conflicts.push({ kind: 'grant', message: 'Selected skills require skills read grant', sources: ['request.grants.read'] });
  }
  const result: any = { version: 1, composition: coordinator.config.id, composition_root: coordinator.root, available_members: loadComposition(coordinator).members.map(({ alias, workspace_id, role, access }) => ({ alias, workspace_id, role, access })), member: request.member, workspace_id: workspace.config.id, repository: repository.name, access: selected.access,
    grants, precedence: 'provider authority remains unchanged; member/path rules govern their own scope; composition rules govern integration/contracts only; unresolved semantic conflicts require review',
    sources, skills, policy_sources, omitted, conflicts, valid: conflicts.length === 0 };
  // Content hashes and descriptors make inspection reproducible without storing duplicate bodies in the digest.
  result.sha256 = contextHash(canonicalJSON(result));
  return result;
}

export function renderCompositionContext(plan) {
  invariant(plan.valid, `Composition context conflicts: ${plan.conflicts.map((item) => item.message).join('; ')}`);
  return [`Composition ${plan.composition}; member ${plan.member}; workspace ${plan.workspace_id}; repository ${plan.repository}.`,
    plan.precedence,
    `Coordinator root: ${plan.composition_root}. Discover members with ws compose inspect from that root. Additional context never expands this Run's mutation scope.`,
    'Member ownership catalog (metadata only):',
    ...plan.available_members.map((member) => `${member.alias}: ${member.role ?? '(responsibility not declared)'}; workspace ${member.workspace_id}; membership ${member.access}`),
    ...plan.sources.map((source) => `Scope: ${source.scope}; source: ${source.path}; sha256: ${source.sha256}\n${source.content}`),
    `Discover additional skill descriptors on demand with ws compose context --member ${plan.member} --repo ${plan.repository} --allow-read skills from the coordinator root. Only the selected skill bodies above apply to this Run.`,
  ].join('\n\n');
}

/** Reject changed/deleted sources rather than dispatching an inspection that drifted. */
export function verifyCompositionContext(plan) {
  for (const source of [...plan.sources, ...(plan.policy_sources ?? [])]) invariant(existsSync(source.path) && realpathSync(source.path) === source.path && contextHash(readFileSync(source.path, 'utf8')) === source.sha256, `Composition context changed: ${source.path}`);
}

/** Reconstitute reviewed sources for integration validation without storing bodies in lineage. */
export function rehydrateCompositionContext(provenance) {
  verifyCompositionContext(provenance);
  const { sha256, ...metadata } = provenance;
  const plan = { ...metadata, sources: metadata.sources.map((source) => ({ ...source, content: readFileSync(source.path, 'utf8') })) };
  invariant(contextHash(canonicalJSON(plan)) === sha256, 'Stored composition context integrity mismatch');
  return { ...plan, sha256 };
}
