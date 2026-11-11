import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSafeWorktreeLocation, assertSafeRelativePath, assertSafeReplay, assertSafeCheckoutPath, cleanWorktrees, verifyReplay } from '../src/verify.ts';
import { buildConfig, config, setConfig, type SetupStep } from '../src/config.ts';
import type { Runner, RunResult } from '../src/exec.ts';
import type { Replay } from '../src/types.ts';

const sha = 'a'.repeat(40);
const marker = 'REPROBE_REPLAY:fixture';
const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '' });

/** A replay whose test file prints the START marker, as assertSafeReplay requires. */
const replayFixture = (over: Partial<Replay> = {}): Replay => ({
  description: 'fixture',
  cwd: 'server',
  requires: [],
  marker,
  kind: 'server-jest',
  files: [{ path: 'server/src/replay.spec.ts', mode: 'create', content: `test('replay', () => console.log('${marker}:START'));\n` }],
  command: ['npx', 'jest', '--runTestsByPath', 'src/replay.spec.ts', '--coverage=false'],
  ...over,
});

interface Fixture {
  base: string;
  repo: string;
  cache: string;
  wt: string;
  deps: string;
  calls: string[][];
  runner: Runner;
}

/**
 * A repo with one cached detached worktree at cache/wt/<repo basename>/<sha12>. `metadata` picks which
 * git answer to corrupt; `setup` is the config's verify.setup list for the run.
 */
const fixture = async (body: (f: Fixture) => Promise<void>, metadata = 'safe', setup: SetupStep[] = [{ nodeModules: 'server' }]) => {
  const base = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), '.verify-fixture-'));
  const repo = join(base, 'repo');
  const cache = join(base, 'cache');
  const wt = join(cache, 'wt', 'repo', sha.slice(0, 12));
  const lock = '{}';
  const depsHash = createHash('sha256').update(lock).update('\0').update('{}').digest('hex').slice(0, 12);
  const deps = join(cache, 'deps', `server-${depsHash}`);
  const previous = config;
  const calls: string[][] = [];
  mkdirSync(join(repo, '.git'), { recursive: true });
  mkdirSync(join(repo, '.git/worktrees/fixture'), { recursive: true });
  mkdirSync(join(base, 'foreign'), { recursive: true });
  mkdirSync(join(wt, 'server'), { recursive: true });
  writeFileSync(join(wt, '.git'), 'fake worktree metadata');
  writeFileSync(join(repo, '.git/worktrees/fixture/gitdir'), join(metadata === 'foreign-backpointer' ? repo : wt, '.git'));
  writeFileSync(join(wt, 'server/package.json'), '{}');
  writeFileSync(join(wt, 'server/package-lock.json'), lock);
  mkdirSync(join(deps, 'node_modules'), { recursive: true });
  writeFileSync(join(deps, 'node_modules/.package-lock.json'), lock);
  const runner: Runner = async (cmd, args, opts) => {
    calls.push([cmd, ...args]);
    if (cmd === 'git' && args[0] === 'rev-parse') {
      if (args[1] === '--verify') return ok(sha);
      if (args[1] === '--show-toplevel') return ok(wt);
      if (metadata === 'error') return { code: 128, stdout: '', stderr: 'metadata unavailable' };
      if (args[1] === '--absolute-git-dir') return ok(join(repo, metadata === 'primary-git-dir' ? '.git' : '.git/worktrees/fixture'));
      return ok(metadata === 'foreign' && opts?.cwd === wt ? join(base, 'foreign') : join(repo, '.git'));
    }
    if (cmd === 'git' && args[0] === 'symbolic-ref') return metadata === 'attached' ? ok('refs/heads/user-work') : { code: 1, stdout: '', stderr: '' };
    if (cmd === 'git' && args[0] === 'worktree' && args[1] === 'list') return ok(metadata === 'unregistered' ? '' : `worktree ${wt}\nHEAD ${sha}\ndetached\n\n`);
    return ok('PASS src/replay.spec.ts\nTest Suites: 1 passed, 1 total\nTests: 1 passed, 1 total');
  };
  setConfig(buildConfig(null, { repo, verify: { setup } }, base, { REPROBE_CACHE_DIR: cache }));
  try {
    await body({ base, repo, cache, wt, deps, calls, runner });
  } finally {
    setConfig(previous);
    rmSync(base, { recursive: true, force: true });
  }
};

test('replay paths reject traversal and absolute paths', () => {
  assert.throws(() => assertSafeRelativePath('../outside', 'replay file'));
  assert.throws(() => assertSafeRelativePath('/tmp/outside', 'replay cwd'));
  assert.throws(() => assertSafeRelativePath('packages/../../outside', 'required file'));
  assert.equal(assertSafeRelativePath('server/src/test.spec.ts', 'replay file'), 'server/src/test.spec.ts');
});

test('root cwd is valid for replays and root setup steps', async () => {
  await fixture(async ({ base, wt, calls, runner }) => {
    const replay = replayFixture({ cwd: '.' });
    assert.doesNotThrow(() => assertSafeReplay(replay));
    const invoked: string[] = [];
    const mocked: Runner = async (cmd, args, opts) => {
      if (cmd === 'prepare' || args.includes('--runTestsByPath')) invoked.push(`${cmd}:${opts?.cwd}`);
      if (args.includes('--runTestsByPath')) return ok(`${marker}:START\n${marker}:PASS`);
      return runner(cmd, args, opts);
    };
    const results = await verifyReplay(base, replay, ['HEAD'], null, () => {}, mocked);
    assert.equal(results[0].outcome, 'pass');
    assert.deepEqual(invoked, [`prepare:${wt}`, `npx:${wt}`]);
    assert.ok(calls.some(([cmd]) => cmd === 'git'));
  }, 'safe', [{ cwd: '.', run: ['prepare'] }]);
});

test('assertSafeReplay accepts a known runner and refuses an unknown one', () => {
  assert.doesNotThrow(() => assertSafeReplay(replayFixture()));
  assert.throws(() => assertSafeReplay(replayFixture({ command: ['rm', '-rf', '/'] })), /not a known test runner/);
  assert.throws(() => assertSafeReplay(replayFixture({ command: ['sh', '-c', 'echo'] })), /not a known test runner/);
});

test('assertSafeReplay honours verify.allow for a custom runner', () => {
  const custom = replayFixture({ command: ['mytool', 'run'] });
  assert.throws(() => assertSafeReplay(custom, []));
  assert.doesNotThrow(() => assertSafeReplay(custom, ['mytool']));
});

test('assertSafeReplay refuses a malformed marker or a replay that never prints START', () => {
  assert.throws(() => assertSafeReplay(replayFixture({ marker: 'BAD marker' })), /marker/);
  assert.throws(() => assertSafeReplay(replayFixture({ files: [{ path: 'server/x.spec.ts', mode: 'create', content: 'no marker here' }] })), /START/);
  assert.throws(() => assertSafeReplay(replayFixture({ files: [{ path: '.git/config', mode: 'create', content: `${marker}:START` }] })), /git metadata/);
  assert.throws(() => assertSafeReplay(replayFixture({ files: [{ path: 'server/.git/index', mode: 'create', content: `${marker}:START` }] })), /git metadata/);
  assert.throws(() => assertSafeReplay(replayFixture({ files: [{ path: '.GIT', mode: 'create', content: `${marker}:START` }] })), /git metadata/);
});

test('worktree target must be a non-symlink descendant of cache and outside the source checkout', () => {
  const base = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), '.verify-fixture-'));
  const repo = join(base, 'repo');
  const cache = join(base, 'cache');
  const external = join(base, 'external');
  mkdirSync(repo);
  mkdirSync(cache);
  mkdirSync(external);
  try {
    assert.doesNotThrow(() => assertSafeWorktreeLocation(repo, cache, join(cache, 'wt', 'abc')));
    assert.throws(() => assertSafeWorktreeLocation(repo, cache, repo));
    assert.throws(() => assertSafeWorktreeLocation(repo, cache, join(base, 'outside')));
    symlinkSync(external, join(cache, 'wt'), 'dir');
    assert.throws(() => assertSafeWorktreeLocation(repo, cache, join(cache, 'wt', 'abc')));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('replay write paths cannot follow checkout symlinks out of a worktree', () => {
  const base = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), '.verify-fixture-'));
  const outside = join(base, 'outside');
  mkdirSync(outside);
  try {
    assert.throws(() => assertSafeCheckoutPath(base, '../outside/pwned.ts'));
    symlinkSync(outside, join(base, 'link'), 'dir');
    assert.throws(() => assertSafeCheckoutPath(base, 'link/pwned.ts'));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

for (const linkDirectory of [false, true]) {
  test(`verifyReplay refuses a symlinked verify ${linkDirectory ? 'directory' : 'log file'} without overwriting its target`, async () => {
    await fixture(async ({ base, repo, runner }) => {
      const target = join(repo, 'user-file');
      writeFileSync(target, 'keep user contents');
      if (linkDirectory) symlinkSync(repo, join(base, 'verify'), 'dir');
      else {
        mkdirSync(join(base, 'verify'));
        symlinkSync(target, join(base, 'verify', `${sha.slice(0, 12)}.log`));
      }
      await assert.rejects(verifyReplay(base, replayFixture(), ['HEAD'], null, () => {}, runner), /symlink/);
      assert.equal(readFileSync(target, 'utf8'), 'keep user contents');
      assert.equal(existsSync(join(repo, `${sha.slice(0, 12)}.log`)), false);
    });
  });
}

for (const metadata of ['attached', 'foreign', 'error', 'primary-git-dir', 'unregistered', 'foreign-backpointer']) {
  test(`verifyReplay refuses ${metadata} cached checkout before destructive git`, async () => {
    await fixture(async ({ base, calls, runner }) => {
      await assert.rejects(verifyReplay(base, replayFixture(), ['HEAD'], null, () => {}, runner), /refusing/);
      assert.equal(calls.some(([cmd, action]) => cmd === 'git' && ['checkout', 'reset', 'clean'].includes(action)), false);
    }, metadata);
  });
}

test('verifyReplay refuses a cached .git symlink to primary metadata before destructive git', async () => {
  await fixture(async ({ base, repo, wt, calls, runner }) => {
    rmSync(join(wt, '.git'));
    symlinkSync(join(repo, '.git'), join(wt, '.git'), 'dir');
    await assert.rejects(verifyReplay(base, replayFixture(), ['HEAD'], null, () => {}, runner), /refusing/);
    assert.equal(calls.some(([cmd, action]) => cmd === 'git' && ['checkout', 'reset', 'clean'].includes(action)), false);
  });
});

test('verifyReplay never installs into a foreign node_modules symlink', async () => {
  await fixture(async ({ base, wt, repo, calls, runner }) => {
    mkdirSync(join(repo, 'node_modules'));
    symlinkSync(join(repo, 'node_modules'), join(wt, 'server/node_modules'), 'dir');
    await assert.rejects(verifyReplay(base, replayFixture(), ['HEAD'], null, () => {}, runner), /node_modules/);
    assert.equal(calls.some(([cmd]) => cmd !== 'git'), false);
  });
});

for (const linked of [false, true]) {
  test(`verifyReplay reinstalls missing cached node_modules when the completion marker exists${linked ? ' behind its owned symlink' : ''}`, async () => {
    await fixture(async ({ base, deps, wt, runner }) => {
      writeFileSync(join(deps, '.reprobe-installed'), 'old success\n');
      rmSync(join(deps, 'node_modules'), { recursive: true, force: true });
      if (linked) symlinkSync(join(deps, 'node_modules'), join(wt, 'server/node_modules'), 'dir');
      let installs = 0;
      const mocked: Runner = async (cmd, args, opts) => {
        if (cmd === 'npm') {
          installs++;
          mkdirSync(join(opts!.cwd, 'node_modules'), { recursive: true });
          writeFileSync(join(opts!.cwd, 'node_modules/.package-lock.json'), '{}');
          return ok();
        }
        if (args.includes('--runTestsByPath')) return ok(`${marker}:START\n${marker}:PASS`);
        return runner(cmd, args, opts);
      };
      const results = await verifyReplay(base, replayFixture(), ['HEAD'], null, () => {}, mocked);
      assert.equal(results[0].outcome, 'pass');
      assert.equal(installs, 1);
      assert.equal(readFileSync(join(deps, 'node_modules/.package-lock.json'), 'utf8'), '{}');
    });
  });
}

test('verifyReplay separates dependency cache entries for manifests sharing a lockfile', async () => {
  await fixture(async ({ base, wt, runner }) => {
    let installs = 0;
    const mocked: Runner = async (cmd, args, opts) => {
      if (cmd === 'npm') {
        installs++;
        mkdirSync(join(opts!.cwd, 'node_modules'), { recursive: true });
        writeFileSync(join(opts!.cwd, 'node_modules/.package-lock.json'), '{}');
        return ok();
      }
      if (args.includes('--runTestsByPath')) return ok(`${marker}:START\n${marker}:PASS`);
      return runner(cmd, args, opts);
    };
    assert.equal((await verifyReplay(base, replayFixture(), ['HEAD'], null, () => {}, mocked))[0].outcome, 'pass');
    rmSync(join(wt, 'server/node_modules'), { recursive: true, force: true });
    writeFileSync(join(wt, 'server/package.json'), '{"name":"different-manifest"}');
    assert.equal((await verifyReplay(base, replayFixture(), ['HEAD'], null, () => {}, mocked))[0].outcome, 'pass');
    assert.equal(installs, 2);
  });
});

test('verifyReplay accepts a successful zero-dependency install that creates no node_modules', async () => {
  await fixture(async ({ base, deps, runner }) => {
    rmSync(join(deps, 'node_modules'), { recursive: true, force: true });
    let installs = 0;
    const mocked: Runner = async (cmd, args, opts) => {
      if (cmd === 'npm') {
        installs++;
        return ok();
      }
      if (args.includes('--runTestsByPath')) return ok(`${marker}:START\n${marker}:PASS`);
      return runner(cmd, args, opts);
    };
    const results = await verifyReplay(base, replayFixture(), ['HEAD'], null, () => {}, mocked);
    assert.equal(results[0].outcome, 'pass');
    assert.equal(installs, 1);
    assert.equal(existsSync(join(deps, 'node_modules')), true);
    assert.equal(existsSync(join(deps, '.reprobe-installed')), true);
  });
});

for (const target of ['deps', 'package.json', 'node_modules']) {
  test(`verifyReplay rejects symlinked dependency cache ${target} before writes or subprocesses`, async () => {
    await fixture(async ({ base, deps, calls, runner }) => {
      const external = join(base, 'external');
      mkdirSync(external);
      if (target === 'deps') {
        rmSync(deps, { recursive: true });
        symlinkSync(external, deps, 'dir');
      } else if (target === 'node_modules') {
        rmSync(join(deps, 'node_modules'), { recursive: true });
        symlinkSync(external, join(deps, 'node_modules'), 'dir');
      } else {
        writeFileSync(join(external, 'package.json'), 'external sentinel');
        symlinkSync(join(external, 'package.json'), join(deps, 'package.json'));
      }
      await assert.rejects(verifyReplay(base, replayFixture(), ['HEAD'], null, () => {}, runner), /symlink/);
      assert.equal(calls.some(([cmd]) => cmd !== 'git'), false);
      if (target === 'package.json') assert.equal(readFileSync(join(external, 'package.json'), 'utf8'), 'external sentinel');
    });
  });
}

test('cleanWorktrees retains attached branch checkouts and removes only detached registrations', async () => {
  await fixture(async ({ repo, cache, wt }) => {
    const detached = join(cache, 'wt', 'repo', 'detached');
    mkdirSync(detached);
    const calls: string[][] = [];
    const runner: Runner = async (cmd, args) => {
      calls.push([cmd, ...args]);
      return ok(args[0] === 'worktree' && args[1] === 'list'
        ? `worktree ${repo}\nHEAD ${sha}\nbranch refs/heads/main\n\nworktree ${wt}\nHEAD ${sha}\nbranch refs/heads/user-work\n\nworktree ${detached}\nHEAD ${sha}\ndetached\n\n`
        : '');
    };
    assert.deepEqual(await cleanWorktrees(runner), ['detached']);
    assert.deepEqual(calls.filter(([, action, verb]) => action === 'worktree' && verb === 'remove'), [['git', 'worktree', 'remove', '--force', detached]]);
  });
});

test('cleanWorktrees fails closed when worktree metadata cannot be read', async () => {
  await fixture(async ({ calls }) => {
    const runner: Runner = async (cmd, args) => {
      calls.push([cmd, ...args]);
      return { code: 128, stdout: '', stderr: 'metadata unavailable' };
    };
    await assert.rejects(cleanWorktrees(runner), /metadata unavailable/);
    assert.equal(calls.length, 1);
  });
});

for (const [label, code, output] of [
  ['passed original tests', 0, 'PASS src/agent/order-consumer.service.spec.ts\n  ○ skipped reprobe fixture\nTest Suites: 1 passed, 1 total\nTests: 5 passed, 1 skipped, 6 total'],
  ['failed unrelated test', 1, 'FAIL src/agent/order-consumer.service.spec.ts\n  ● unrelated original assertion\nExpected: true\nReceived: false\nTest Suites: 1 failed\nTests: 1 failed, 1 skipped, 4 passed, 6 total'],
] as const) {
  test(`verifyReplay cannot use ${label} as proof of its replay`, async () => {
    await fixture(async ({ base, runner }) => {
      const mocked: Runner = async (cmd, args, opts) => args.includes('--runTestsByPath') ? { code, stdout: output, stderr: '' } : runner(cmd, args, opts);
      const results = await verifyReplay(base, replayFixture(), ['HEAD'], null, () => {}, mocked);
      assert.equal(results[0].outcome, 'broken');
    });
  });
}

for (const [phase, code, expected] of [['PASS', 0, 'pass'], ['FAIL', 1, 'fail'], ['START', 0, 'broken'], ['PASS', 1, 'broken']] as const) {
  test(`verifyReplay classifies its own ${phase} marker at exit ${code} as ${expected}`, async () => {
    await fixture(async ({ base, runner }) => {
      const replay = replayFixture();
      const signals = `${marker}:START\n${phase === 'START' ? '' : `${marker}:${phase}\n`}`;
      const output = signals + (code === 0
        ? 'PASS src/replay.spec.ts\nTest Suites: 1 passed, 1 total\nTests: 1 passed, 1 total'
        : 'FAIL src/replay.spec.ts\n  ● reprobe fixture › replay assertion\nExpected: true\nReceived: false\nTest Suites: 1 failed');
      const mocked: Runner = async (cmd, args, opts) => args.includes('--runTestsByPath') ? { code, stdout: output, stderr: '' } : runner(cmd, args, opts);
      const results = await verifyReplay(base, replay, ['HEAD'], null, () => {}, mocked);
      assert.equal(results[0].outcome, expected);
    });
  });
}

test('verifyReplay redacts commit labels on the not-applicable return branch', async () => {
  await fixture(async ({ base, runner }) => {
    const replay = replayFixture({ requires: ['server/missing.ts'] });
    const results = await verifyReplay(base, replay, ['token=opaque-secret'], null, () => {}, runner);
    assert.equal(results[0].outcome, 'not-applicable');
    assert.equal(results[0].commit, 'token=[redacted]');
    assert.equal(JSON.stringify(results).includes('opaque-secret'), false);
  });
});

test('verifyReplay redacts a failing setup step and marks the commit broken without running the replay', async () => {
  await fixture(async ({ base, calls, runner }) => {
    const mocked: Runner = async (cmd, args, opts) => (cmd === 'npm' ? { code: 1, stdout: '', stderr: 'token=opaque-secret' } : runner(cmd, args, opts));
    const logs: string[] = [];
    const results = await verifyReplay(base, replayFixture(), ['HEAD'], null, (message) => logs.push(message), mocked);
    assert.equal(results[0].outcome, 'broken');
    assert.equal(JSON.stringify({ results, logs }).includes('opaque-secret'), false);
    assert.equal(calls.some(([cmd, ...args]) => cmd === 'npx' && args.includes('--runTestsByPath')), false);
  }, 'safe', [{ cwd: 'server', run: ['npm', 'ci', '--token=opaque-secret'] }]);
});

test('verifyReplay replaces a stale log when a cached commit becomes not-applicable', async () => {
  await fixture(async ({ base, runner }) => {
    const passedRun: Runner = async (cmd, args, opts) => args.includes('--runTestsByPath')
      ? ok(`${marker}:START\n${marker}:PASS`)
      : runner(cmd, args, opts);
    const first = await verifyReplay(base, replayFixture(), ['HEAD'], null, () => {}, passedRun);
    assert.match(readFileSync(first[0].logFile, 'utf8'), new RegExp(`${marker}:PASS`));

    const second = await verifyReplay(base, replayFixture({ requires: ['server/missing.ts'] }), ['HEAD'], null, () => {}, runner);
    assert.equal(second[0].outcome, 'not-applicable');
    const log = readFileSync(second[0].logFile, 'utf8');
    assert.match(log, /not-applicable: missing at this commit/);
    assert.doesNotMatch(log, new RegExp(`${marker}:PASS`));
  });
});

test('verifyReplay redacts setup command arguments in raw log callbacks', async () => {
  await fixture(async ({ base, calls, runner }) => {
    const logs: string[] = [];
    const mocked: Runner = async (cmd, args, opts) => cmd === 'npm'
      ? { code: 1, stdout: '', stderr: 'install failed' }
      : runner(cmd, args, opts);
    const results = await verifyReplay(base, replayFixture(), ['HEAD'], null, (message) => logs.push(message), mocked);
    assert.equal(results[0].outcome, 'broken');
    assert.equal(JSON.stringify(logs).includes('opaque-secret'), false);
    assert.ok(logs.some((message) => message.includes('--token=[redacted]')));
    assert.equal(calls.some(([cmd]) => cmd === 'npx'), false);
  }, 'safe', [{ cwd: 'server', run: ['npm', 'ci', '--token=opaque-secret'] }]);
});
