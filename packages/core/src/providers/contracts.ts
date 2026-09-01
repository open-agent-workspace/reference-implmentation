/**
 * Provider contracts are documented here rather than enforced by inheritance.
 * Implementations can be replaced as long as they expose the same methods.
 */
export const providerContracts = Object.freeze({
  agent: ['prepare', 'run', 'stop'],
  execution: ['createWorktree', 'removeWorktree'],
  resource: ['allocatePort', 'launchProcess', 'releaseRunResources'],
  integration: ['integrate'],
  knowledge: ['recordDurableRun', 'propose'],
});
