import { config, firstLine, resolveSecret } from '../config.ts';
import { run, type Runner } from '../exec.ts';
import type { Evidence, SourceStatus, Window } from '../types.ts';

/**
 * Defence in depth on top of the read-only transaction: only a single SELECT/WITH statement, and no
 * statement keyword that could write even if the transaction mode were somehow lost.
 */
export function assertReadOnlySql(sql: string): void {
  const s = sql.trim();
  if (!/^(select|with)\b/i.test(s)) throw new Error('reprobe only runs SELECT/WITH queries');
  const withoutStrings = s.replace(/'(?:[^']|'')*'/g, "''");
  if (withoutStrings.includes(';')) throw new Error('reprobe refuses multi-statement SQL');
  if (withoutStrings.includes('\\')) throw new Error('reprobe refuses psql meta-commands or escaped identifiers');
  if (/\bU&"/i.test(s)) throw new Error('reprobe refuses Unicode-escaped identifiers');
  const banned = /\b(insert|update|delete|merge|drop|alter|create|truncate|grant|revoke|copy|call|do|vacuum|analyze|lock|set|reset|refresh|listen|notify|prepare|execute|into|nextval|setval|set_config|pg_terminate_backend|pg_cancel_backend|pg_advisory_lock(?:_shared)?|pg_advisory_unlock(?:_shared|_all)?|lo_import|lo_export)\b/i;
  const stripped = withoutStrings.replace(/"((?:[^"]|"")*)"/g, '$1');
  const hit = stripped.match(banned);
  if (hit) throw new Error(`reprobe refuses SQL containing "${hit[1]}"`);
}

/** The exact script psql reads: every query runs inside a READ ONLY transaction that is rolled back. */
export function readOnlyScript(sql: string): string {
  assertReadOnlySql(sql);
  return `BEGIN TRANSACTION READ ONLY;\nSELECT coalesce(json_agg(t), '[]'::json) FROM (${sql}) t;\nROLLBACK;\n`;
}

export function bindSql(sql: string, vars: Record<string, string>): string {
  return sql.replace(/:'([A-Za-z_][A-Za-z0-9_]*)'/g, (_placeholder, name: string) => {
    if (!Object.prototype.hasOwnProperty.call(vars, name)) throw new Error(`missing SQL value: ${name}`);
    const value = vars[name];
    if (value.includes('\0')) throw new Error(`SQL value contains NUL: ${name}`);
    const escaped = value.replace(/'/g, "''").replace(/\r/g, "' || chr(13) || '").replace(/\n/g, "' || chr(10) || '");
    return `'${escaped}'`;
  });
}

export function pgEnv(url: string): Record<string, string> {
  const u = new URL(url);
  return {
    PGHOST: u.hostname,
    PGPORT: u.port || '5432',
    PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password),
    PGDATABASE: u.pathname.replace(/^\//, ''),
    PGSSLMODE: u.searchParams.get('sslmode') ?? 'prefer',
    PGCONNECT_TIMEOUT: '10',
    PGAPPNAME: 'reprobe-readonly',
    // A second guard: even outside the explicit transaction, the session default is read-only.
    PGOPTIONS: '-c default_transaction_read_only=on -c statement_timeout=20000 -c standard_conforming_strings=on',
  };
}

export class Pg {
  private url: string;
  private runner: Runner;
  constructor(url: string, runner: Runner = run) {
    this.url = url;
    this.runner = runner;
  }

  async query<T = Record<string, unknown>>(sql: string, vars: Record<string, string> = {}): Promise<T[]> {
    const args = ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'];
    args.push('-f', '-');
    const r = await this.runner('psql', args, { env: pgEnv(this.url), input: readOnlyScript(bindSql(sql, vars)), timeoutMs: 30_000 });
    if (r.code !== 0) throw new Error(`psql: ${firstLine(r.stderr) || `exit ${r.code}`}`);
    // json_agg separates elements with newlines, so the result spans lines.
    const out = r.stdout.trim();
    const start = out.indexOf('[');
    return JSON.parse(start < 0 ? '[]' : out.slice(start)) as T[];
  }
}

export async function connect(runner: Runner = run): Promise<{ db: Pg | null; status: SourceStatus }> {
  const pgConf = config.sources.postgres;
  if (!pgConf) return { db: null, status: { source: 'postgres', state: 'skipped', detail: 'no postgres source in the config' } };
  const { value: url, detail } = await resolveSecret(pgConf.url, runner);
  if (!url) return { db: null, status: { source: 'postgres', state: 'missing-credentials', detail } };
  const db = new Pg(url, runner);
  try {
    const [row] = await db.query<{ ro: string }>(`SELECT current_setting('transaction_read_only') AS ro`);
    if (row?.ro !== 'on') {
      return { db: null, status: { source: 'postgres', state: 'error', detail: 'refusing to continue: session is not read-only' } };
    }
  } catch (e) {
    return { db: null, status: { source: 'postgres', state: 'unreachable', detail: (e as Error).message } };
  }
  return { db, status: { source: 'postgres', state: 'ok', detail: `${detail}, read-only transaction verified` } };
}

export const utc = (v: unknown): string | null => {
  if (typeof v !== 'string' || !v) return null;
  const date = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(v) ? v : `${v}Z`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};
