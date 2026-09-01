import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

/** Markers delimit the part of AGENTS.md owned by `ws`. */
export const GENERATED_AGENTS_START = '<!-- BEGIN WS MANAGED WORKSPACE GUIDANCE -->';
export const GENERATED_AGENTS_END = '<!-- END WS MANAGED WORKSPACE GUIDANCE -->';

const NAVIGATION_SKILL = 'workspace-navigation';
const RUNS_SKILL = 'workspace-runs';

function repositoryRows(workspace) {
  const repositories = Array.isArray(workspace?.config?.repositories)
    ? workspace.config.repositories
    : [];
  return repositories
    .map((repository) => ({
      name: String(repository?.name ?? ''),
      role: String(repository?.role ?? 'secondary'),
      path: repository?.path === undefined || repository?.path === null
        ? '(not materialized)'
        : String(repository.path),
      url: repository?.url ? String(repository.url) : '',
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function repositoryList(rows) {
  if (rows.length === 0) return '- No repositories are registered yet.';
  return rows.map((repository) => {
    const source = repository.url ? `; URL: ${repository.url}` : '';
    return `- \`${repository.name}\` (${repository.role}) — path: \`${repository.path}\`${source}`;
  }).join('\n');
}

function managedGuidance(workspace) {
  const rows = repositoryRows(workspace);
  return [
    GENERATED_AGENTS_START,
    'This section is maintained by `ws`; edits outside these markers are preserved.',
    '',
    '## Repositories',
    '',
    repositoryList(rows),
    '',
    '## Workspace workflow',
    '',
    '- Treat this directory as the coding-agent workspace and keep each repository under `repos/` as an independent Git repository.',
    '- Read `.workspace/workspace.yaml` before changing repository relationships or shared context.',
    '- Use `ws repo list` to inspect registered repositories, `ws repo clone` to add URL-backed repositories, and `ws repo sync` to materialize missing checkouts.',
    '- Use `ws run <agent> "<objective>"` for bounded agent work. Runs mutate an isolated Git worktree and produce a reviewable candidate.',
    '- Inspect and validate candidates before `ws integrate <candidate-id>`; never edit a canonical checkout to bypass the workflow.',
    '- Run the repository validation commands described by its local `AGENTS.md` before integration.',
    '',
    '## Generated workspace skills',
    '',
    '- `.agents/skills/workspace-navigation/SKILL.md` explains repository discovery and safe navigation.',
    '- `.agents/skills/workspace-runs/SKILL.md` explains bounded Runs, context, validation, and integration.',
    GENERATED_AGENTS_END,
  ].join('\n');
}

function replaceManagedSection(existing, section) {
  const start = existing.indexOf(GENERATED_AGENTS_START);
  const end = existing.indexOf(GENERATED_AGENTS_END);
  if (start >= 0 && end >= start) {
    const afterEnd = end + GENERATED_AGENTS_END.length;
    return `${existing.slice(0, start)}${section}${existing.slice(afterEnd)}`;
  }
  if (existing.length === 0) return `${section}\n`;
  const separator = existing.endsWith('\n') ? '' : '\n';
  return `${existing}${separator}\n${section}\n`;
}

function skillFrontmatter(name, description) {
  return [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    '---',
  ].join('\n');
}

function navigationSkill(workspace) {
  const rows = repositoryRows(workspace);
  return [
    skillFrontmatter(
      NAVIGATION_SKILL,
      'Navigate an Agentic Engineering Workspace, inspect its repository manifest, and work safely across independent Git repositories.',
    ),
    '',
    '# Workspace navigation',
    '',
    '## Workspace contract',
    '',
    '- The workspace root owns `.workspace/workspace.yaml`, shared context, `.agents/skills`, and this guidance.',
    '- Independent checkouts live under `repos/`; do not turn them into a nested monorepo or commit their contents to the workspace Git repository.',
    '- Repository paths in the manifest are portable paths relative to the workspace root. A repository can be URL-backed before it is materialized.',
    '',
    '## Registered repositories',
    '',
    repositoryList(rows),
    '',
    '## Navigation procedure',
    '',
    '1. Start at the workspace root and read `.workspace/workspace.yaml` plus relevant files in `.workspace/context/`.',
    '2. Resolve the target by manifest name and use its exact manifest `path`; never derive a checkout directory from the logical name when a path is recorded.',
    '3. Confirm the target is a Git repository before editing and keep unrelated repositories untouched.',
    '4. Use `ws repo list` and Git status to verify the checkout and branch before handing work to an agent.',
    '5. Keep shared instructions in the workspace root and repository-specific instructions in that repository.',
    '',
    'Do not follow a path that escapes the workspace `repos/` convention when materializing a URL. Report a missing or unsafe checkout instead.',
    '',
  ].join('\n');
}

function runsSkill(workspace) {
  const rows = repositoryRows(workspace);
  return [
    skillFrontmatter(
      RUNS_SKILL,
      'Run bounded coding-agent work across an Agentic Engineering Workspace with isolated worktrees, explicit context, validation, and reviewable integration.',
    ),
    '',
    '# Workspace Runs',
    '',
    '## Current repository scope',
    '',
    repositoryList(rows),
    '',
    '## Run procedure',
    '',
    '1. Select one mutation repository with `--repo`; select read-only context repositories with `--context-repo` when needed.',
    '2. State a concrete objective and keep the agent profile within its declared mutation and resource policy.',
    '3. Start `ws run <agent> "<objective>" --no-integrate` when review is required before integration.',
    '4. Inspect the Run and candidate with `ws inspect <id>` and review the isolated worktree diff.',
    '5. Run the repository tests and validation evidence. Resolve failures in a new bounded Run when possible.',
    '6. Integrate only an approved candidate with `ws integrate <candidate-id>`; integration is serialized and remains separate from execution.',
    '',
    'Never write agent changes directly into a canonical checkout, manually delete an unresolved candidate worktree, or claim completion without test evidence.',
    '',
  ].join('\n');
}

function openaiMetadata(name, displayName, shortDescription, prompt) {
  return [
    'interface:',
    `  display_name: "${displayName}"`,
    `  short_description: "${shortDescription}"`,
    `  default_prompt: "${prompt}"`,
    'policy:',
    '  allow_implicit_invocation: true',
    '',
  ].join('\n');
}

function writeOwnedFile(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path) || readFileSync(path, 'utf8') !== content) {
    writeFileSync(path, content, 'utf8');
  }
}

/**
 * Generate the root coding-agent guidance and workspace skills.
 *
 * The generated AGENTS section is bounded by explicit markers. Existing
 * user-authored content is retained byte-for-byte while the managed section
 * is replaced deterministically whenever repository metadata changes.
 */
export function writeWorkspaceAgentFiles(workspace) {
  const root = workspace.root;
  const agentsPath = join(root, 'AGENTS.md');
  const existing = existsSync(agentsPath) ? readFileSync(agentsPath, 'utf8') : '';
  const agentsContent = replaceManagedSection(existing, managedGuidance(workspace));
  writeOwnedFile(agentsPath, agentsContent);

  const skillsRoot = join(root, '.agents', 'skills');
  const navigationRoot = join(skillsRoot, NAVIGATION_SKILL);
  const runsRoot = join(skillsRoot, RUNS_SKILL);
  writeOwnedFile(join(navigationRoot, 'SKILL.md'), navigationSkill(workspace));
  writeOwnedFile(
    join(navigationRoot, 'agents', 'openai.yaml'),
    openaiMetadata(
      NAVIGATION_SKILL,
      'Workspace Navigation',
      'Navigate repositories and workspace context safely',
      'Use $workspace-navigation to inspect this workspace and safely locate the right repository.',
    ),
  );
  writeOwnedFile(join(runsRoot, 'SKILL.md'), runsSkill(workspace));
  writeOwnedFile(
    join(runsRoot, 'agents', 'openai.yaml'),
    openaiMetadata(
      RUNS_SKILL,
      'Workspace Runs',
      'Run bounded agent work with reviewable integration',
      'Use $workspace-runs to plan, validate, and integrate a bounded workspace Run.',
    ),
  );

  return {
    agentsPath,
    skills: {
      navigation: navigationRoot,
      runs: runsRoot,
    },
  };
}

export const generateWorkspaceAgentFiles = writeWorkspaceAgentFiles;
export const refreshWorkspaceAgentFiles = writeWorkspaceAgentFiles;
