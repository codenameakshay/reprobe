import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { run, type Runner } from './exec.ts';
import { redactText } from './redact.ts';

/**
 * Where a credential comes from. Config files hold references, never values:
 * - "env:NAME" reads an environment variable.
 * - { cmd: [...] } runs a command (no shell) and takes its stdout; `json` or `kv` picks one key from it.
 *   "{repo}" in an argument is replaced with the repo path.
 */
export type SecretRef = string | { cmd: string[]; cwd?: string; json?: string; kv?: string };

export type LogSource =
  | { name: string; railway: { service: string; cwd?: string } }
  /** Any CLI that prints log lines: fly logs, vercel logs, kubectl logs, docker logs. "{since}"/"{until}" are ISO times. */
  | { name: string; command: string[]; cwd?: string }
  | { name: string; file: string };

export type SetupStep =
  /** Install node_modules for this directory once per lockfile hash, cached outside the worktree, then symlink it in.
   *  Like every step, it runs only for replays whose cwd is inside its directory. */
  | { nodeModules: string }
  | { cwd: string; run: string[] };

export interface FileConfig {
  repo?: string;
  reporter?: string;
  pack?: string;
  sources?: {
    postgres?: { url: SecretRef };
    langfuse?: { baseUrl: SecretRef; publicKey: SecretRef; secretKey: SecretRef };
    sentry?: { org: string; projects: string[]; url?: string };
    logs?: LogSource[];
    /** Log-shaped tool output in saved Claude Code transcripts: a fallback once live logs have expired. */
    archive?: { dir: string; glob: string };
  };
  verify?: { setup?: SetupStep[]; allow?: string[] };
}

export interface Config extends Required<Pick<FileConfig, 'sources'>> {
  /** The config file, or null when running without one. */
  file: string | null;
  /** The code checkout that replays run against (in detached worktrees, never in place). */
  repo: string;
  reporter?: string;
  pack: string | null;
  cacheDir: string;
  casesDir: string;
  llmModel: string;
  verify: { setup: SetupStep[]; allow: string[] };
}

const expand = (p: string, base: string) => {
  const home = p === '~' || p.startsWith('~/') ? join(homedir(), p.slice(1)) : p;
  return isAbsolute(home) ? home : resolve(base, home);
};

function canonicalPath(p: string): string {
  const abs = resolve(p);
  if (existsSync(abs)) return realpathSync(abs);
  const parent = dirname(abs);
  return parent === abs ? abs : join(canonicalPath(parent), basename(abs));
}

function containingGitTop(path: string): string | null {
  let cursor = canonicalPath(path);
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) return null;
    cursor = parent;
  }
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: cursor, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Case evidence must never be committable: outside every git work tree, or at a path git ignores.
 * Symlink aliases are resolved first.
 */
export function assertCasesOutsideRepo(casesPath: string, repoPath: string): void {
  const cases = canonicalPath(casesPath);
  const repo = canonicalPath(repoPath);
  const rel = relative(repo, cases);
  const inConfiguredRepo = rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  const top = inConfiguredRepo ? repo : containingGitTop(cases);
  if (top && !gitIgnores(top, cases)) {
    throw new Error(`case directory must be outside the repo or ignored by git (${casesPath})`);
  }
}

function gitIgnores(top: string, path: string): boolean {
  try {
    execFileSync('git', ['-C', top, 'check-ignore', '-q', '--no-index', '--', path], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function gitTop(cwd: string): string | null {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

/** --config, then REPROBE_CONFIG, then .reprobe/config.json at the top of the current git repo. */
export function findConfigFile(flag?: string, cwd = process.cwd(), env = process.env): string | null {
  if (flag) return resolve(cwd, flag);
  if (env.REPROBE_CONFIG) return resolve(cwd, env.REPROBE_CONFIG);
  const top = gitTop(cwd);
  const candidate = top ? join(top, '.reprobe/config.json') : null;
  return candidate && existsSync(candidate) ? candidate : null;
}

export function buildConfig(file: string | null, raw: FileConfig, cwd = process.cwd(), env = process.env): Config {
  const base = file ? (basename(dirname(file)) === '.reprobe' ? dirname(dirname(file)) : dirname(file)) : cwd;
  const repo = raw.repo ? expand(raw.repo, base) : (gitTop(base) ?? base);
  const cacheDir = env.REPROBE_CACHE_DIR ? expand(env.REPROBE_CACHE_DIR, cwd) : join(homedir(), '.cache/reprobe');
  const sources = raw.sources ?? {};
  const casesDir = join(env.REPROBE_CASES_DIR ? expand(env.REPROBE_CASES_DIR, cwd) : join(homedir(), '.reprobe/cases'), basename(repo));
  return {
    file,
    repo,
    reporter: env.REPROBE_REPORTER ?? raw.reporter,
    pack: raw.pack ? expand(raw.pack, file ? dirname(file) : cwd) : null,
    cacheDir,
    casesDir,
    llmModel: env.REPROBE_LLM_MODEL ?? 'sonnet',
    sources: {
      ...sources,
      archive: sources.archive ? { ...sources.archive, dir: expand(sources.archive.dir, base) } : undefined,
    },
    verify: { setup: raw.verify?.setup ?? [], allow: raw.verify?.allow ?? [] },
  };
}

export let config: Config = buildConfig(null, {});

export function loadConfig(flag?: string): Config {
  const file = findConfigFile(flag);
  const raw = file ? (JSON.parse(readFileSync(file, 'utf8')) as FileConfig) : {};
  config = buildConfig(file, raw);
  secretCache.clear();
  return config;
}

/** Tests and packs set config directly. */
export function setConfig(c: Config): void {
  config = c;
  secretCache.clear();
}

const secretCache = new Map<string, string>();

export async function resolveSecret(ref: SecretRef | undefined, runner: Runner = run): Promise<{ value: string | null; detail: string }> {
  if (!ref) return { value: null, detail: 'not configured' };
  if (typeof ref === 'string') {
    if (!ref.startsWith('env:')) return { value: ref, detail: 'inline value in config' };
    const v = process.env[ref.slice(4)];
    return v ? { value: v, detail: ref } : { value: null, detail: `${ref.slice(4)} is not set` };
  }
  const key = JSON.stringify(ref);
  const cached = secretCache.get(key);
  if (cached) return { value: cached, detail: `\`${ref.cmd[0]}\`` };
  const args = ref.cmd.slice(1).map((a) => a.replaceAll('{repo}', config.repo));
  const r = await runner(ref.cmd[0], args, { cwd: ref.cwd ? expand(ref.cwd, config.repo) : config.repo, timeoutMs: 30_000 });
  if (r.code === 127) return { value: null, detail: `${ref.cmd[0]} is not installed` };
  if (r.code !== 0) return { value: null, detail: `${ref.cmd[0]} failed: ${firstLine(r.stderr || r.stdout)}` };
  let value: string | null = r.stdout.trim();
  if (ref.json) {
    try {
      const v = JSON.parse(value)[ref.json];
      value = typeof v === 'string' && v ? v : null;
    } catch {
      value = null;
    }
  } else if (ref.kv) {
    const line = r.stdout.split('\n').find((l) => l.startsWith(`${ref.kv}=`));
    value = line ? line.slice(ref.kv.length + 1).trim() : null;
  }
  if (!value) return { value: null, detail: `${ref.cmd[0]} returned no ${ref.json ?? ref.kv ?? 'value'}` };
  secretCache.set(key, value);
  return { value, detail: `\`${ref.cmd[0]}\`` };
}

export function firstLine(s: string): string {
  return redactText((s.split('\n').find((l) => l.trim() && !/Config as Code|Migrate:|Existing files keep/.test(l)) ?? '').trim()).slice(0, 200);
}
