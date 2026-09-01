#!/usr/bin/env -S node --disable-warning=ExperimentalWarning

import { main } from '../dist/src/cli.js';

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`Error: ${error.message}\n`);
  if (process.env.WS_DEBUG) {
    process.stderr.write(`${error.stack}\n`);
  }
  process.exitCode = error.exitCode ?? 1;
});
