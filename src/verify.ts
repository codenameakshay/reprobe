import { createHash } from 'node:crypto';
import { appendFileSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { config, firstLine, type SetupStep } from './config.ts';
import { run, type Runner } from './exec.ts';
import { redactText, redactValue } from './redact.ts';
import type { Pack, Replay } from './types.ts';

export type Outcome = 'pass' | 'fail' | 'broken' | 'not-applicable';

export interface VerifyResult {
  commit: string;
  sha: string;
  outcome: Outcome;
  detail: string;
  logFile: string;
}

/** Validate paths serialized in evidence before they can escape a worktree. */
export function assertSafeRelativePath(path: string, label: string): string {
  if (typeof path !== 'string' || !path || path.includes('\0') || path.includes('\\') || isAbsolute(path)) {
    throw new Error(`unsafe ${label} path`);
  }
  const parts = path.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) throw new Error(`unsafe ${label} path`);
  return path;
}

export function assertSafeCheckoutPath(root: string, path: string): string {
  assertSafeRelativePath(path, 'checkout');
  const canonicalRoot = realpathSync(root);
  let cursor = canonicalRoot;
  for (const component of path.split('/')) {
    cursor = join(cursor, component);
    try {
      if (lstatSync(cursor).isSymbolicLink()) throw new Error(`refusing symlinked checkout path ${path}`);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }
  const candidate = prospectiveRealpath(cursor);
  if (!within(canonicalRoot, candidate)) throw new Error(`checkout path escapes worktree: ${path}`);
  return cursor;
}

function within(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function prospectiveRealpath(path: string): string {
  let cursor = resolve(path);
  const tail: string[] = [];
  while (!existsSync(cursor)) {
    tail.unshift(cursor.slice(dirname(cursor).length + 1));
    cursor = dirname(cursor);
  }
  return join(realpathSync(cursor), ...tail);
}

/** Reject paths that can redirect a cached worktree into the user's source checkout. */
export function assertSafeWorktreeLocation(repoPath: string, cachePath: string, worktreePath: string): void {
  const repo = realpathSync(repoPath);
  if (existsSync(cachePath) && lstatSync(cachePath).isSymbolicLink()) throw new Error('unsafe worktree location: symlinked cache directory');
  const cache = prospectiveRealpath(cachePath);
  const target = prospectiveRealpath(worktreePath);
  if (!within(cache, target) || within(repo, target) || within(target, repo)) throw new Error('unsafe worktree location');
  let cursor = cache;
  for (const component of relative(cache, target).split(sep).filter(Boolean)) {
    cursor = join(cursor, component);
    try {
      if (lstatSync(cursor).isSymbolicLink()) throw new Error('unsafe worktree location: symlink in cache path');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }
}

/** Test runners a replay may start. A config can add more under verify.allow. */
export const DEFAULT_RUNNERS = ['npx', 'npm', 'pnpm', 'yarn', 'bun', 'bunx', 'node', 'deno', 'flutter', 'dart', 'pytest', 'python', 'python3', 'uv', 'go', 'cargo', 'bundle', 'rspec', 'mvn', 'gradle', './gradlew', 'swift', 'dotnet', 'mix', 'php', 'vendor/bin/phpunit'];

export function assertSafeReplay(replay: Replay, allow: string[] = config.verify.allow): void {
  assertSafeRelativePath(replay.cwd, 'replay cwd');
  for (const file of replay.files) assertSafeRelativePath(file.path, 'replay file');
  for (const path of replay.requires) assertSafeRelativePath(path, 'required file');
  if (!replay.files.length) throw new Error('replay has no test file');
  if (!Array.isArray(replay.command) || !replay.command.length || replay.command.some((a) => typeof a !== 'string' || a.includes('\0'))) throw new Error('replay command must be a non-empty argv');
  if (![...DEFAULT_RUNNERS, ...allow].includes(replay.command[0])) throw new Error(`refusing replay command "${replay.command[0]}": not a known test runner (add it to verify.allow)`);
  if (typeof replay.marker !== 'string' || !/^REPROBE_REPLAY:[A-Za-z0-9_-]{1,80}$/.test(replay.marker)) throw new Error('replay marker must look like REPROBE_REPLAY:<id>');
  if (!replay.files.some((f) => f.content.includes(`${replay.marker}:START`))) throw new Error(`no replay file prints ${replay.marker}:START`);
}

const git = (args: string[], cwd = config.repo, runner: Runner = run) => runner('git', args, { cwd, timeoutMs: 600_000 });

function detachedRegistrations(output: string): Set<string> {
  return new Set(output.split(/\n\n/)
    .filter((block) => /^detached$/m.test(block) && !/^branch /m.test(block) && /^HEAD [0-9a-f]{40,64}$/m.test(block))
    .map((block) => block.match(/^worktree (.+)$/m)?.[1]).filter((p): p is string => Boolean(p)).map((p) => prospectiveRealpath(p)));
}

/** A run that never reached its assertion is BROKEN, not FAIL: only a failing assertion proves the bug. */
export function classify(code: number, output: string, marker?: string | null): { outcome: Outcome; detail: string } {
  output = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r\n?/g, '\n');
  const lines = output.split('\n').map((line) => line.replace(/^\s*\d{2}:\d{2}\s+\+\d+(?:\s+-\d+)?:\s?/, '').trim());
  const hits = (phase: string) => lines.filter((line) => line === `${marker}:${phase}` || line.startsWith(`${marker}:${phase} `));
  const signal = (phase: string) => hits(phase).length === 1;
  if (!marker || !signal('START')) return { outcome: 'broken', detail: 'missing proof that the replay reached its assertions' };
  const passed = signal('PASS');
  const failed = signal('FAIL');
  if (code === 0) return passed && !failed ? { outcome: 'pass', detail: 'replay passed' } : { outcome: 'broken', detail: 'exit 0 without proof that the replay assertions passed' };
  if (passed || !failed) return { outcome: 'broken', detail: 'non-zero exit without proof that the replay assertion failed' };
  const diagnosticOutput = output.split(/(?:^|\n)\s*(?:- Expected|Expected:)/)[0];
  const runtimeError = diagnosticOutput.match(
    /(ReferenceError: .+|SyntaxError: .+|Cannot find module .+|TypeError: \S+ is not a (?:function|constructor).*|Error: Couldn't resolve the package .+|Compilation failed.*|Failed to load ".+|Error: Not found: .+|isn't defined for the (?:class|type) .+|Undefined name .+|The getter '.+' isn't defined.+|No named parameter with the name .+)/,
  );
  if (runtimeError) return { outcome: 'broken', detail: runtimeError[1].slice(0, 300) };
  const diff = output.indexOf('- Expected');
  const jestDiff = diff >= 0 ? output.slice(diff).split('\n').slice(0, 9).filter((l) => !/^\s*>?\s*\d+ \|/.test(l)).map((l) => l.trim()).filter(Boolean).join(' ') : null;
  const normalizedOutput = output.replace(/^\s*\d{2}:\d{2}\s+\+\d+\s+-\d+:\s?/gm, '');
  const assertion =
    jestDiff ??
    (/(?:^|\n)\s*Expected: /.test(normalizedOutput) ? normalizedOutput.match(/(?:^|\n)\s*Actual: [^\n]*(?:\n\s*Which: [^\n]*)?/)?.[0].trim() : undefined) ??
    normalizedOutput.match(/(Expected:[^\n]*\n\s*Received:[^\n]*)/)?.[1] ??
    normalizedOutput.match(/(expect\(received\)[^\n]*)/)?.[1];
  // The test printed its FAIL marker after reaching the assertion and the runner exited non-zero: that is the proof.
  const said = hits('FAIL')[0].slice(`${marker}:FAIL`.length).trim();
  return { outcome: 'fail', detail: (assertion ?? (said || `assertion failed (exit ${code})`)).replace(/\s+/g, ' ').slice(0, 300) };
}

async function worktree(sha: string, runner: Runner): Promise<string> {
  const dir = join(config.cacheDir, 'wt', basename(config.repo), sha.slice(0, 12));
  assertSafeWorktreeLocation(config.repo, config.cacheDir, dir);
  mkdirSync(dirname(dir), { recursive: true });
  if (!existsSync(join(dir, '.git'))) {
    if (existsSync(dir)) throw new Error(`refusing to reuse unregistered worktree path ${dir}`);
    const r = await git(['worktree', 'add', '--detach', dir, sha], config.repo, runner);
    if (r.code !== 0) throw new Error(`git worktree add: ${firstLine(r.stderr)}`);
  } else {
    if (lstatSync(dir).isSymbolicLink()) throw new Error(`refusing symlinked cached worktree ${dir}`);
    const metadata = lstatSync(join(dir, '.git'));
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`refusing non-file or symlinked cached worktree metadata ${dir}`);
    const top = await git(['rev-parse', '--show-toplevel'], dir, runner);
    const common = await git(['rev-parse', '--git-common-dir'], dir, runner);
    const sourceCommon = await git(['rev-parse', '--git-common-dir'], config.repo, runner);
    const gitDir = await git(['rev-parse', '--absolute-git-dir'], dir, runner);
    const branch = await git(['symbolic-ref', '-q', 'HEAD'], dir, runner);
    const listed = await git(['worktree', 'list', '--porcelain'], config.repo, runner);
    if (top.code !== 0 || common.code !== 0 || sourceCommon.code !== 0 || gitDir.code !== 0 || branch.code !== 1 || listed.code !== 0 || !top.stdout.trim() || !common.stdout.trim() || !sourceCommon.stdout.trim() || !isAbsolute(gitDir.stdout.trim())) {
      throw new Error(`refusing cached worktree with unreadable or attached git metadata ${dir}`);
    }
    const actualTop = top.code === 0 ? realpathSync(top.stdout.trim()) : '';
    const actualCommon = common.code === 0 ? realpathSync(resolve(dir, common.stdout.trim())) : '';
    const expectedCommon = sourceCommon.code === 0 ? realpathSync(resolve(config.repo, sourceCommon.stdout.trim())) : '';
    const actualGitDir = realpathSync(gitDir.stdout.trim());
    const linkedMetadataRoot = join(expectedCommon, 'worktrees');
    if (actualTop !== realpathSync(dir) || actualCommon !== expectedCommon || actualGitDir === expectedCommon || actualGitDir === linkedMetadataRoot || !within(linkedMetadataRoot, actualGitDir) || !detachedRegistrations(listed.stdout).has(actualTop)) {
      throw new Error(`refusing stale, attached, or foreign cached worktree ${dir}`);
    }
    const backpointer = assertSafeCheckoutPath(actualGitDir, 'gitdir');
    if (realpathSync(resolve(actualGitDir, readFileSync(backpointer, 'utf8').trim())) !== realpathSync(join(dir, '.git'))) {
      throw new Error(`refusing cached worktree metadata belonging to another checkout ${dir}`);
    }
    for (const [label, args] of [
      ['checkout', ['checkout', '--detach', '-f', '-q', sha]],
      ['reset', ['reset', '--hard', '-q', sha]],
      ['clean', ['clean', '-fdq', '-e', 'node_modules', '-e', '.dart_tool', '-e', 'build']],
    ] as const) {
      const r = await git([...args], dir, runner);
      if (r.code !== 0) throw new Error(`git ${label}: ${firstLine(r.stderr || r.stdout)}`);
    }
  }
  return dir;
}

const LOCKFILES: Array<[string, string[]]> = [
  ['package-lock.json', ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund']],
  ['pnpm-lock.yaml', ['pnpm', 'install', '--frozen-lockfile', '--ignore-scripts']],
  ['yarn.lock', ['yarn', 'install', '--frozen-lockfile', '--ignore-scripts']],
  ['bun.lock', ['bun', 'install', '--frozen-lockfile', '--ignore-scripts']],
  ['bun.lockb', ['bun', 'install', '--frozen-lockfile', '--ignore-scripts']],
];

/** node_modules for `dir`, installed once per lockfile hash outside the worktree (install scripts off), then symlinked in. */
async function nodeModules(wt: string, dir: string, log: (s: string) => void, runner: Runner): Promise<string | null> {
  const root = !dir || dir === '.' ? wt : assertSafeCheckoutPath(wt, dir);
  const found = LOCKFILES.find(([lock]) => existsSync(join(root, lock)));
  if (!found) return `no lockfile in ${dir} (package-lock.json, pnpm-lock.yaml, yarn.lock, bun.lock)`;
  const [lockName, install] = found;
  const prefix = dir === '.' || !dir ? '' : `${dir}/`;
  const lock = assertSafeCheckoutPath(wt, `${prefix}${lockName}`);
  const manifest = assertSafeCheckoutPath(wt, `${prefix}package.json`);
  const hash = createHash('sha256').update(readFileSync(lock)).digest('hex').slice(0, 12);
  const depsPath = `deps/${(dir || 'root').replace(/[^A-Za-z0-9_-]/g, '_')}-${hash}`;
  const deps = assertSafeCheckoutPath(config.cacheDir, depsPath);
  const modules = assertSafeCheckoutPath(config.cacheDir, `${depsPath}/node_modules`);
  const done = assertSafeCheckoutPath(config.cacheDir, `${depsPath}/.reprobe-installed`);
  const linkedModules = join(root, 'node_modules');
  let linked;
  try {
    linked = lstatSync(linkedModules);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  if (linked && (!linked.isSymbolicLink() || !existsSync(linkedModules) || !existsSync(modules) || realpathSync(linkedModules) !== realpathSync(modules))) {
    throw new Error(`refusing ${prefix}node_modules outside the owned dependency cache`);
  }
  if (!existsSync(done)) {
    log(`installing dependencies for ${dir || '.'} lockfile ${hash} (one time, cached in ${deps})`);
    mkdirSync(deps, { recursive: true });
    copyFileSync(manifest, assertSafeCheckoutPath(config.cacheDir, `${depsPath}/package.json`));
    copyFileSync(lock, assertSafeCheckoutPath(config.cacheDir, `${depsPath}/${lockName}`));
    const r = await runner(install[0], install.slice(1), { cwd: deps, timeoutMs: 1_200_000 });
    if (r.code !== 0) return `${install.join(' ')} failed: ${firstLine(r.stderr || r.stdout)}`;
    writeFileSync(done, `${new Date().toISOString()}\n`);
  }
  if (!linked) symlinkSync(modules, linkedModules);
  return null;
}

/** A step for `server` runs only for replays whose cwd is inside `server`; a step for `.` always runs. */
export const stepApplies = (stepDir: string, replayCwd: string) => !stepDir || stepDir === '.' || replayCwd === stepDir || replayCwd.startsWith(`${stepDir}/`);

async function setup(wt: string, steps: SetupStep[], replayCwd: string, log: (s: string) => void, runner: Runner): Promise<string | null> {
  for (const step of steps) {
    if (!stepApplies('nodeModules' in step ? step.nodeModules : step.cwd, replayCwd)) continue;
    if ('nodeModules' in step) {
      // ponytail: one shared node_modules per lockfile, so concurrent verifies of different commits could race on generated code. Verify runs commits one at a time.
      const err = await nodeModules(wt, step.nodeModules, log, runner);
      if (err) return err;
      continue;
    }
    assertSafeRelativePath(step.cwd, 'setup cwd');
    const cwd = assertSafeCheckoutPath(wt, step.cwd);
    if (!existsSync(cwd)) continue;
    log(`setup: ${step.run.join(' ')} in ${step.cwd}`);
    const r = await runner(step.run[0], step.run.slice(1), { cwd, timeoutMs: 900_000, env: { CI: '1' } });
    if (r.code !== 0) return `setup ${step.run.join(' ')} failed: ${firstLine(r.stderr || r.stdout)}`;
  }
  return null;
}

export async function verifyReplay(caseDir: string, replay: Replay, commits: string[], pack: Pack | null = null, log: (s: string) => void = () => {}, runner: Runner = run): Promise<VerifyResult[]> {
  assertSafeReplay(replay);
  const results: VerifyResult[] = [];
  mkdirSync(join(caseDir, 'verify'), { recursive: true });
  for (const commit of commits) {
    const rev = await git(['rev-parse', '--verify', '--end-of-options', `${commit}^{commit}`], config.repo, runner);
    const sha = rev.stdout.trim();
    const logId = /^[0-9a-f]{40,64}$/i.test(sha) ? sha.slice(0, 12) : createHash('sha256').update(commit).digest('hex').slice(0, 12);
    const logFile = join(caseDir, 'verify', `${logId}.log`);
    if (rev.code !== 0) {
      results.push({ commit: redactText(commit), sha: '', outcome: 'broken', detail: redactText(`unknown commit ${commit}`), logFile });
      continue;
    }
    if (!/^[0-9a-f]{40,64}$/i.test(sha)) {
      results.push({ commit: redactText(commit), sha: '', outcome: 'broken', detail: 'git returned an invalid commit id', logFile });
      continue;
    }
    log(`${redactText(commit)} (${sha.slice(0, 10)}): preparing worktree`);
    const wt = await worktree(sha, runner);
    const missing = replay.requires.filter((p) => !existsSync(join(wt, p)));
    if (missing.length) {
      results.push({ commit, sha, outcome: 'not-applicable', detail: `missing at this commit: ${missing.join(', ')}`, logFile });
      continue;
    }
    for (const f of replay.files) {
      const target = assertSafeCheckoutPath(wt, f.path);
      mkdirSync(dirname(target), { recursive: true });
      if (f.mode === 'append') appendFileSync(target, f.content);
      else writeFileSync(target, f.content);
    }
    let command = replay.command;
    let shimNote = '';
    const setupError = await setup(wt, config.verify.setup, replay.cwd, log, runner);
    if (setupError) {
      results.push({ commit, sha, outcome: 'broken', detail: redactText(setupError), logFile });
      continue;
    }
    if (pack?.prepareWorktree) {
      const prepared = await pack.prepareWorktree(wt, replay, sha, { run: runner, git: (args, cwd = wt) => git(args, cwd, runner), safePath: assertSafeCheckoutPath, log });
      if (prepared.notes?.length) shimNote = ` [${prepared.notes.join('; ')}]`;
      if (prepared.error) {
        results.push({ commit, sha, outcome: 'broken', detail: redactText(prepared.error + shimNote), logFile });
        continue;
      }
      if (prepared.command) command = prepared.command;
    }
    const cwd = assertSafeCheckoutPath(wt, replay.cwd);
    log(`${redactText(commit)}: running ${redactText(command.join(' '))}`);
    const r = await runner(command[0], command.slice(1), { cwd, timeoutMs: 900_000, env: { CI: '1' } });
    const output = `${r.stdout}\n${r.stderr}`;
    writeFileSync(logFile, redactText(`$ ${command.join(' ')}\n# commit ${sha}${shimNote}\n${output}`));
    const verdict = classify(r.code, output, replay.marker);
    results.push({ commit: redactText(commit), sha, outcome: verdict.outcome, detail: redactText(verdict.detail + shimNote), logFile });
  }
  return redactValue(results);
}

export async function cleanWorktrees(runner: Runner = run): Promise<string[]> {
  const root = join(config.cacheDir, 'wt', basename(config.repo));
  if (!existsSync(root)) return [];
  if (lstatSync(root).isSymbolicLink()) throw new Error('refusing to clean symlinked worktree cache');
  const listed = await git(['worktree', 'list', '--porcelain'], config.repo, runner);
  if (listed.code !== 0) throw new Error(`git worktree list: ${firstLine(listed.stderr || listed.stdout)}`);
  const registered = detachedRegistrations(listed.stdout);
  const removed: string[] = [];
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    if (lstatSync(path).isSymbolicLink()) continue;
    try {
      assertSafeWorktreeLocation(config.repo, config.cacheDir, path);
    } catch {
      continue;
    }
    if (!registered.has(prospectiveRealpath(path))) continue;
    const r = await git(['worktree', 'remove', '--force', path], config.repo, runner);
    if (r.code === 0) removed.push(name);
  }
  await git(['worktree', 'prune'], config.repo, runner);
  return removed;
}
