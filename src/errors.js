export class WorkspaceError extends Error {
  constructor(message, { exitCode = 1, cause } = {}) {
    super(message, { cause });
    this.name = 'WorkspaceError';
    this.exitCode = exitCode;
  }
}

export function invariant(condition, message) {
  if (!condition) throw new WorkspaceError(message);
}
