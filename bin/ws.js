#!/usr/bin/env -S node --disable-warning=ExperimentalWarning

// Compatibility entrypoint for existing checkouts and documentation links.
// The published CLI package owns the implementation in the pnpm monorepo.
import '../packages/cli/bin/ws.js';
