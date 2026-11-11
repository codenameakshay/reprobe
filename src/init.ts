import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { FileConfig, LogSource, SetupStep } from './config.ts';

const SKIP = new Set(['node_modules', '.git', 'build', 'dist', '.dart_tool', '.next', 'vendor', 'target', '.venv', 'venv', 'ios', 'android']);
const LOCKS = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb'];

/** Directories up to two levels deep, repo root first. */
function dirs(root: string, depth = 2): string[] {
  const out = [root];
  if (depth === 0) return out;
  let entries: string[] = [];
  try {
    entries = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && !SKIP.has(e.name) && !e.name.startsWith('.')).map((e) => e.name).sort();
  } catch {}
  for (const e of entries) out.push(...dirs(join(root, e), depth - 1));
  return out;
}

const read = (p: string) => {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return '';
  }
};

export interface Detected {
  config: FileConfig;
  found: string[];
  todo: string[];
}

/** Reads the repo's manifests and deploy files; never reads secret values, only the names of env vars. */
export function detect(repo: string): Detected {
  const found: string[] = [];
  const todo: string[] = [];
  const sources: NonNullable<FileConfig['sources']> = {};
  const setup: SetupStep[] = [];
  const logs: LogSource[] = [];
  const all = dirs(repo);
  const rel = (d: string) => relative(repo, d) || '.';
  const text = all.map((d) => ['package.json', 'pubspec.yaml', 'requirements.txt', 'pyproject.toml', 'Gemfile', 'go.mod'].map((f) => read(join(d, f))).join('\n')).join('\n');
  const envNames = new Set(all.flatMap((d) => ['.env.example', '.env.sample', '.env.template'].flatMap((f) => [...read(join(d, f)).matchAll(/^\s*([A-Z][A-Z0-9_]*)\s*=/gm)].map((m) => m[1]))));

  // Postgres: Prisma's datasource names the env var; otherwise a pg driver plus DATABASE_URL.
  for (const d of all) {
    for (const schema of ['prisma/schema.prisma', 'schema.prisma']) {
      const m = read(join(d, schema)).match(/datasource\s+\w+\s*\{[^}]*provider\s*=\s*"postgres(?:ql)?"[^}]*url\s*=\s*env\("([A-Z0-9_]+)"\)/s);
      if (m && !sources.postgres) {
        sources.postgres = { url: `env:${m[1]}` };
        found.push(`Postgres via Prisma in ${rel(d)} (url from ${m[1]})`);
      }
    }
  }
  if (!sources.postgres && /"(pg|postgres|@neondatabase\/serverless|drizzle-orm|knex|typeorm|sequelize)"|psycopg|asyncpg|\bpgx\b|lib\/pq/.test(text)) {
    sources.postgres = { url: 'env:DATABASE_URL' };
    found.push('a Postgres driver (url from DATABASE_URL)');
  }
  if (sources.postgres) todo.push('Point sources.postgres.url at a READ-ONLY role if you have one. reprobe also forces read-only transactions, but a read-only role is the strongest guard.');

  if (/"langfuse|langfuse[>=~\s]|langfuse\b/.test(text)) {
    const base = envNames.has('LANGFUSE_HOST') ? 'LANGFUSE_HOST' : 'LANGFUSE_BASE_URL';
    sources.langfuse = { baseUrl: `env:${base}`, publicKey: 'env:LANGFUSE_PUBLIC_KEY', secretKey: 'env:LANGFUSE_SECRET_KEY' };
    found.push('Langfuse SDK');
  }

  if (/@sentry\/|sentry_flutter|sentry-sdk|sentry_dart|sentry-go|sentry-ruby/.test(text)) {
    let org = '';
    const projects = new Set<string>();
    for (const d of all) {
      const props = `${read(join(d, '.sentryclirc'))}\n${read(join(d, 'sentry.properties'))}`;
      org ||= props.match(/^\s*(?:org|defaults\.org)\s*=\s*(\S+)/m)?.[1] ?? '';
      const p = props.match(/^\s*(?:project|defaults\.project)\s*=\s*(\S+)/m)?.[1];
      if (p) projects.add(p);
    }
    sources.sentry = { org: org || 'TODO-your-sentry-org', projects: projects.size ? [...projects] : ['TODO-your-sentry-project'] };
    found.push('Sentry SDK');
    if (!org || !projects.size) todo.push('Fill sources.sentry.org and .projects (the slugs in your Sentry URLs), then `sentry-cli login` with a token that has event:read, project:read, org:read.');
  }

  for (const d of all) {
    if (existsSync(join(d, 'railway.toml')) || existsSync(join(d, 'railway.json'))) {
      logs.push({ name: `railway ${rel(d)}`, railway: { service: 'TODO-railway-service-name', cwd: rel(d) === '.' ? undefined : rel(d) } });
      found.push(`Railway deploy config in ${rel(d)}`);
      todo.push(`Set the Railway service name for ${rel(d)} (\`railway status\` shows it), and run \`railway link\` there.`);
    }
    const fly = read(join(d, 'fly.toml')).match(/^\s*app\s*=\s*["']([^"']+)["']/m)?.[1];
    if (fly) {
      logs.push({ name: `fly ${fly}`, command: ['fly', 'logs', '-a', fly, '--no-tail'] });
      found.push(`Fly app ${fly}`);
      todo.push('fly logs only returns recent lines; for older incidents add a file or command log source that reads your log drain.');
    }
  }
  if (!logs.length) todo.push('No log source detected. Add one to sources.logs: {"name":"api","command":["<cli>","logs",...,"{since}","{until}"]} or {"name":"api","file":"logs/*.log"}.');

  for (const d of all) {
    if (!existsSync(join(d, 'package.json')) || !LOCKS.some((l) => existsSync(join(d, l)))) continue;
    setup.push({ nodeModules: rel(d) });
    for (const schema of ['prisma/schema.prisma', 'schema.prisma']) {
      if (existsSync(join(d, schema))) setup.push({ cwd: rel(d), run: ['npx', 'prisma', 'generate'] });
    }
  }

  const config: FileConfig = { sources, verify: { setup } };
  if (logs.length) config.sources!.logs = logs;
  return { config, found, todo };
}

export function writeInit(repo: string, force: boolean): { path: string; detected: Detected } {
  const path = join(repo, '.reprobe/config.json');
  if (existsSync(path) && !force) throw new Error(`${path} exists; pass --force to overwrite`);
  const detected = detect(repo);
  mkdirSync(join(repo, '.reprobe'), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ ...detected.config, _todo: detected.todo }, null, 2)}\n`);
  return { path, detected };
}
