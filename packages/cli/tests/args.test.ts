import assert from 'node:assert/strict';
import test from 'node:test';

import { parseArgs, rejectUnknown } from '../src/args.js';

test('parses positional, boolean, assigned, and repeated options', () => {
  assert.deepEqual(
    parseArgs(['run', 'coder', 'fix it', '--repo=app', '--context-repo', 'api', '--context-repo=db', '--json']),
    {
      positionals: ['run', 'coder', 'fix it'],
      options: { repo: 'app', 'context-repo': ['api', 'db'], json: true },
    },
  );
});

test('rejects missing and unknown option values', () => {
  assert.throws(() => parseArgs(['--repo']), /requires a value/);
  assert.throws(() => rejectUnknown({ surprise: true }, ['json']), /Unknown option/);
});
