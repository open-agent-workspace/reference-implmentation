export class WorkspaceError extends Error {
  [key: string]: any;
  constructor(message, { exitCode = 1, cause } : any = {}) {
    super(message, { cause });
    this.name = 'WorkspaceError';
    this.exitCode = exitCode;
  }
}

export function invariant(condition, message) {
  if (!condition) throw new WorkspaceError(message);
}
