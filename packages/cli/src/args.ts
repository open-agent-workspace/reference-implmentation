import { WorkspaceError } from '@agentic-workspace/core';

const booleanOptions = new Set([
  'json',
  'help',
  'version',
  'integrate',
  'no-integrate',
]);

const repeatedOptions = new Set(['context-repo', 'port']);

export function parseArgs(tokens) {
  const positionals = [];
  const options: any = {};
  let literal = false;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (literal) {
      positionals.push(token);
      continue;
    }
    if (token === '--') {
      literal = true;
      continue;
    }
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }

    const equal = token.indexOf('=');
    const key = token.slice(2, equal === -1 ? undefined : equal);
    if (!key) throw new WorkspaceError('Invalid empty option');

    let value;
    if (equal !== -1) {
      value = token.slice(equal + 1);
    } else if (booleanOptions.has(key)) {
      value = true;
    } else {
      value = tokens[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new WorkspaceError(`Option --${key} requires a value`);
      }
      index += 1;
    }

    if (repeatedOptions.has(key)) {
      options[key] ??= [];
      options[key].push(value);
    } else if (Object.hasOwn(options, key)) {
      throw new WorkspaceError(`Option --${key} may only be specified once`);
    } else {
      options[key] = value;
    }
  }

  return { positionals, options };
}

export function requirePositional(positionals, index, label) {
  const value = positionals[index];
  if (!value) throw new WorkspaceError(`Missing ${label}`);
  return value;
}

export function rejectUnknown(options, allowed) {
  const valid = new Set(allowed);
  const unknown = Object.keys(options).filter((key) => !valid.has(key));
  if (unknown.length) {
    throw new WorkspaceError(`Unknown option${unknown.length > 1 ? 's' : ''}: ${unknown.map((key) => `--${key}`).join(', ')}`);
  }
}
