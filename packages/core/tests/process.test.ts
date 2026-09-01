import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommandAgentProvider, tokenizeCommand } from '../src/providers/agent-command.js';
import { ProcessResourceProvider } from '../src/providers/process.js';

test('allocates distinct ports and releases the reservation', async () => {
  const provider = new ProcessResourceProvider({ runtimeDir: await mkdtemp(join(tmpdir(), 'ws-runtime-')), canBind: async () => true });
  const first = await provider.allocatePort({ runId: 'R1', preferredPort: 0 });
  assert.ok(first.port > 0);
  await assert.rejects(() => provider.allocatePort({ runId: 'R2', preferredPort: first.port }), /No available TCP port/);
  await provider.releaseRunResources('R1');
  const reused = await provider.allocatePort({ runId: 'R2', preferredPort: first.port });
  assert.equal(reused.port, first.port);
});

test('launches argv without a shell and records output in run logs', async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'ws-runtime-'));
  const provider = new ProcessResourceProvider({ runtimeDir });
  const result = await provider.runProcess({
    runId: 'R-log',
    command: process.execPath,
    args: ['-e', "process.stdout.write(process.env.WS_TEST_VALUE); process.stderr.write('err')"],
    env: { WS_TEST_VALUE: 'safe-output' },
    label: 'fake',
  });
  assert.equal(result.success, true);
  assert.match(await readFile(result.stdoutLog, 'utf8'), /safe-output/);
  assert.match(await readFile(result.stderrLog, 'utf8'), /err/);
});

test('runs argv and shell-like validation commands sequentially with evidence', async (t) => {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'ws-validation-runtime-'));
  const worktreePath = await mkdtemp(join(tmpdir(), 'ws-validation-worktree-'));
  t.after(() => Promise.all([
    rm(runtimeDir, { recursive: true, force: true }),
    rm(worktreePath, { recursive: true, force: true }),
  ]));
  const processes = new ProcessResourceProvider({ runtimeDir });
  const agent = new CommandAgentProvider({ processProvider: processes, runtimeDir });
  const profile = {
    command: [process.execPath, '-e', "require('node:fs').writeFileSync('agent.txt', process.env.WS_PROMPT)"],
    validation: [
      [process.execPath, '-e', "require('node:fs').writeFileSync('validation-order.txt', process.env.WS_VALIDATION_INDEX)"],
      `${process.execPath} -e "require('node:fs').appendFileSync('validation-order.txt', '|second')"`,
    ],
  };
  assert.deepEqual(tokenizeCommand('node -e "process.stdout.write(\\"ok\\")"'), [
    'node', '-e', 'process.stdout.write("ok")',
  ]);
  const result = await agent.run({
    profile,
    run: { id: 'R-validation' },
    prompt: 'safe prompt',
    worktreePath,
  });
  assert.equal(result.success, true);
  assert.equal(result.validation.success, true);
  assert.equal(result.validation.commands.length, 2);
  assert.notEqual(result.validation.commands[0].label, result.validation.commands[1].label);
  assert.equal(await readFile(join(worktreePath, 'agent.txt'), 'utf8'), 'safe prompt');
  assert.equal(await readFile(join(worktreePath, 'validation-order.txt'), 'utf8'), '1|second');
  for (const evidence of result.validation.commands) {
    assert.ok(evidence.exitCode === 0);
    assert.match(evidence.stdoutLog, /validation-00[12]\.stdout\.log$/);
    assert.match(evidence.stderrLog, /validation-00[12]\.stderr\.log$/);
  }
});

test('stops validation at the first failure and marks the provider result unsuccessful', async (t) => {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'ws-validation-runtime-'));
  const worktreePath = await mkdtemp(join(tmpdir(), 'ws-validation-worktree-'));
  t.after(() => Promise.all([
    rm(runtimeDir, { recursive: true, force: true }),
    rm(worktreePath, { recursive: true, force: true }),
  ]));
  const processes = new ProcessResourceProvider({ runtimeDir });
  const agent = new CommandAgentProvider({ processProvider: processes, runtimeDir });
  const result = await agent.run({
    profile: {
      command: [process.execPath, '-e', 'process.exit(0)'],
      validation: [
        `${process.execPath} -e "process.exitCode = 7"`,
        [process.execPath, '-e', "require('node:fs').writeFileSync('must-not-run', 'bad')"],
      ],
    },
    run: { id: 'R-validation-fail' },
    prompt: 'failure prompt',
    worktreePath,
  });
  assert.equal(result.success, false);
  assert.equal(result.exitCode, 7);
  assert.equal(result.validation.success, false);
  assert.equal(result.validation.stoppedOnFailure, true);
  assert.equal(result.validation.commands.length, 1);
  assert.equal(result.validation.commands[0].exitCode, 7);
  await assert.rejects(() => readFile(join(worktreePath, 'must-not-run')));
});
