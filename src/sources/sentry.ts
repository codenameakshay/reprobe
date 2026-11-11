import type { Evidence, SourceStatus, Window } from '../types.ts';
import { run } from '../exec.ts';
import type { Runner } from '../exec.ts';
import { config } from '../config.ts';
import { redactText } from '../redact.ts';
const DAY_MS = 86_400_000;
const AUTH_HINT = 'sentry-cli is not logged in: run `sentry-cli login`';

export interface IssueRow {
  id: string;
  shortId: string;
  title: string;
  lastSeen: string;
  status: string;
}

/** Sentry is reached only through sentry-cli, which holds its own credentials. */
export async function sentryAuthState(runner: Runner = run): Promise<SourceStatus> {
  if (!config.sources.sentry) return { source: 'sentry', state: 'skipped', detail: 'no sentry source in the config' };
  const r = await runner('sentry-cli', ['info'], { timeoutMs: 15_000 });
  if (r.code === 127) return { source: 'sentry', state: 'missing-credentials', detail: 'sentry-cli not installed' };
  if (r.code !== 0 || r.stdout.includes('Method: Unauthorized')) {
    return { source: 'sentry', state: 'missing-credentials', detail: AUTH_HINT };
  }
  return { source: 'sentry', state: 'ok', detail: 'sentry-cli authenticated' };
}

const SCOPE_HINT = 'the sentry-cli token cannot read issues (an org CI token has only org:ci). Create a personal token with event:read, project:read and org:read, then `sentry-cli login --auth-token <token>`';

/** Logged in is not enough: CI tokens authenticate but get 403 on issues. */
export async function sentryReadState(runner: Runner = run): Promise<SourceStatus> {
  if (config.sources.sentry && !config.sources.sentry.projects?.length) {
    return { source: 'sentry', state: 'error', detail: 'no Sentry projects configured' };
  }
  const auth = await sentryAuthState(runner);
  if (auth.state !== 'ok') return auth;
  const { org, projects } = config.sources.sentry!;
  const r = await runner('sentry-cli', ['issues', 'list', '-o', org, '-p', projects[0], '--max-rows', '1'], { timeoutMs: 30_000 });
  if (r.code === 0) return { source: 'sentry', state: 'ok', detail: `can read issues in ${org}/${projects[0]}` };
  const err = `${r.stderr}\n${r.stdout}`;
  if (/403|permission/i.test(err)) return { source: 'sentry', state: 'missing-credentials', detail: SCOPE_HINT };
  return { source: 'sentry', state: 'error', detail: redactText(err.split('\n').find((l) => l.trim()) ?? `exit ${r.code}`).slice(0, 200) };
}

/** Parses the ASCII table from `sentry-cli issues list`. Columns are mapped by header name. */
export function parseIssueTable(text: string, project: string): IssueRow[] {
  const rows = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('|'))
    .map((l) => l.split('|').slice(1, -1).map((c) => c.trim()));
  const headerIdx = rows.findIndex((cells) =>
    cells.some((c) => c.toLowerCase() === 'issue id' || c.toLowerCase() === 'short id'),
  );
  if (headerIdx < 0) return [];
  const header = rows[headerIdx].map((c) => c.toLowerCase());
  const col = (name: string) => header.indexOf(name);
  const idx = {
    id: col('issue id'),
    shortId: col('short id'),
    title: col('title'),
    status: col('status'),
    lastSeen: col('last seen'),
  };
  const cell = (cells: string[], i: number) => (i < 0 ? '' : (cells[i] ?? ''));
  return rows
    .slice(headerIdx + 1)
    .filter((cells) => cells.some((c) => c !== ''))
    .map((cells) => ({
      id: cell(cells, idx.id),
      shortId: cell(cells, idx.shortId),
      title: cell(cells, idx.title),
      lastSeen: cell(cells, idx.lastSeen),
      status: cell(cells, idx.status),
    }));
}

export async function gatherSentry(opts: {
  window: Window;
  userId?: string;
  issue?: string;
  runner?: Runner;
}): Promise<{ status: SourceStatus; evidence: Evidence[] }> {
  const runner = opts.runner ?? run;
  if (config.sources.sentry && !config.sources.sentry.projects?.length) {
    return { status: { source: 'sentry', state: 'error', detail: 'no Sentry projects configured' }, evidence: [] };
  }
  const auth = await sentryAuthState(runner);
  if (auth.state !== 'ok') return { status: auth, evidence: [] };
  const { org: ORG, projects: PROJECTS, url } = config.sources.sentry!;

  const query = opts.issue ? opts.issue : opts.userId ? `user.id:${opts.userId}` : 'is:unresolved';
  const cutoff = Date.parse(opts.window.from) - DAY_MS;
  const evidence: Evidence[] = [];
  const failures: string[] = [];
  let successfulProjects = 0;

  for (const project of PROJECTS) {
    const r = await runner(
      'sentry-cli',
      ['issues', 'list', '-o', ORG, '-p', project, '--query', query, '--max-rows', '50'],
      { timeoutMs: 30_000 },
    );
    if (r.code !== 0) {
      failures.push(/403|permission/i.test(r.stderr) ? SCOPE_HINT : redactText((r.stderr.split('\n')[0] ?? '').trim()) || `exit ${r.code}`);
      continue;
    }
    successfulProjects++;
    for (const row of parseIssueTable(r.stdout, project)) {
      const ms = parseLastSeen(row.lastSeen);
      if (!opts.issue && (ms === null || ms < cutoff)) continue;
      evidence.push({
        id: `sentry:${project}:${row.id}`,
        source: 'sentry',
        at: ms === null ? null : new Date(ms).toISOString(),
        kind: 'sentry.issue',
        summary: `${row.shortId} ${row.title} (${row.status})`,
        data: row,
        link: url ? `${url.replace(/\/+$/, '')}/issues/${row.id}/` : `https://${ORG}.sentry.io/issues/${row.id}/`,
      });
    }
  }

  if (successfulProjects === 0) {
    return { status: { source: 'sentry', state: failures[0] === SCOPE_HINT ? 'missing-credentials' : 'error', detail: failures[0] ?? 'sentry-cli failed' }, evidence: [] };
  }
  if (evidence.length === 0) {
    return { status: { source: 'sentry', state: failures.length ? 'error' : 'empty', detail: failures.length ? `some project reads failed: ${failures.join('; ')}` : 'no matching issues' }, evidence };
  }
  return { status: { source: 'sentry', state: 'ok', detail: `${evidence.length} issues${failures.length ? `; some project reads failed: ${failures.join('; ')}` : ''}` }, evidence };
}

/** "2026-07-28 08:44:48.123 UTC" -> epoch ms, or null when it does not parse. */
function parseLastSeen(s: string): number | null {
  if (!s) return null;
  const ms = Date.parse(s.replace(' UTC', 'Z').replace(' ', 'T'));
  return Number.isNaN(ms) ? null : ms;
}
