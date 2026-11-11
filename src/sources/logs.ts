import { createHash } from 'node:crypto';
import { globSync, readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { config, firstLine } from '../config.ts';
import { run, type Runner } from '../exec.ts';
import type { Evidence, SourceStatus, Window } from '../types.ts';

export interface LogLine {
  at: string;
  text: string;
  level: string;
  context: string | null;
  method: string | null;
  path: string | null;
  status: number | null;
  userId: string | null;
  clientVersion: string | null;
}

// Transcripts sometimes keep the colour codes without their ESC byte, so the ESC is optional.
const ANSI = /\u001b?\[[0-9;]{1,12}m/g;
const HTTP = /(?:✅|❌|⚠️)?\s*\b(GET|POST|PUT|PATCH|DELETE)\s+(\/\S*)\s+(\d{3})\b/;
const KV = /(\w+)=("([^"]*)"|[^\s"]+)/g;

function timestampMs(value: string): number {
  const normalized = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?$/.test(value) ? `${value}Z` : value;
  return Date.parse(normalized);
}

function safeWindow(w: Window): Window | null {
  const timestamp = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/;
  if (!timestamp.test(w.from) || !timestamp.test(w.to)) return null;
  const from = Date.parse(w.from);
  const to = Date.parse(w.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) return null;
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
}

function kv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of text.matchAll(KV)) out[m[1]] = m[3] ?? m[2];
  return out;
}

/** Normalises the three shapes Railway logs come in: `--json` objects, `<ts> [level] <nest line>`, and `<ts> [LEVEL] key=value`. */
export function parseLogLine(raw: string): LogLine | null {
  const line = raw.replace(ANSI, '').trimEnd();
  let at: string | null = null;
  let text = '';
  let fields: Record<string, unknown> = {};
  if (line.startsWith('{')) {
    try {
      fields = JSON.parse(line);
    } catch {
      return null;
    }
    at = typeof fields.timestamp === 'string' ? fields.timestamp : null;
    text = String(fields.message ?? '').replace(ANSI, '');
    if (fields.event === 'request_completed' || fields.path) {
      text = `${fields.event ?? 'request'} ${fields.method ?? ''} ${fields.path ?? ''} ${fields.statusCode ?? ''} clientVersion=${fields.clientVersion ?? '?'} userId=${fields.userId ?? '?'} ${text}`.trim();
    }
  } else {
    const m = line.match(/^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z)\s+(?:\[(\w+)\]\s*)?(.*)$/);
    if (!m) return null;
    at = m[1];
    text = m[3];
    fields = { level: m[2], ...kv(text) };
  }
  if (!at || !text.trim()) return null;
  const timestamp = timestampMs(at);
  if (!Number.isFinite(timestamp)) return null;
  const nest = text.match(/\b(LOG|ERROR|WARN|DEBUG|VERBOSE)\s+\[([\w.-]+)\]/);
  const http = text.match(HTTP);
  const status = Number(fields.statusCode ?? http?.[3] ?? NaN);
  const level = (nest?.[1] ?? String(fields.level ?? 'info')).toLowerCase().replace('log', 'info');
  return {
    at: new Date(timestamp).toISOString(),
    text: text.replace(/\s+/g, ' ').trim(),
    level: level === 'warning' ? 'warn' : level,
    context: nest?.[2] ?? null,
    method: (fields.method as string) || http?.[1] || null,
    path: (fields.path as string) || http?.[2] || null,
    status: Number.isFinite(status) ? status : null,
    userId: typeof fields.userId === 'string' && fields.userId !== '?' ? (fields.userId as string) : null,
    clientVersion: typeof fields.clientVersion === 'string' && fields.clientVersion !== '?' ? (fields.clientVersion as string) : null,
  };
}

export function inWindow(at: string, w: Window): boolean {
  const value = timestampMs(at);
  const from = timestampMs(w.from);
  const to = timestampMs(w.to);
  return Number.isFinite(value) && Number.isFinite(from) && Number.isFinite(to) && value >= from && value <= to;
}

/** Lines worth keeping: anything about the people we care about, every warning/error, every failed request. */
export function relevant(l: LogLine, ids: string[]): boolean {
  if (l.level === 'error' || l.level === 'warn') return true;
  if (l.status !== null && l.status >= 400) return true;
  if (/Exception|Error:/.test(l.text)) return true;
  return ids.some((id) => l.text.includes(id) || (id.length > 8 && l.text.includes(`${id.slice(0, 8)}…`)));
}

const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 10);

function logEvidence(l: LogLine, source: 'logs' | 'archive', extra: Record<string, unknown> = {}): Evidence {
  return {
    id: `${source}:${l.at}:${hash(l.text)}`,
    source,
    at: l.at,
    kind: l.status !== null ? (l.status >= 500 ? 'http.5xx' : l.status >= 400 ? 'http.4xx' : 'http.ok') : `log.${l.level}`,
    summary: (l.method && l.path && l.status !== null ? `${l.method} ${l.path} ${l.status}${l.userId ? ` user ${l.userId.slice(0, 8)}` : ''}${l.clientVersion ? ` app ${l.clientVersion}` : ''} · ${l.text}` : l.text).slice(0, 260),
    data: { ...l, ...extra },
  };
}

/**
 * Railway emits a multi-line message (an error object, a stack trace) as one line per row, all with
 * the same timestamp. Fold those rows back into the line that started them, in source order.
 */
export function mergeContinuations(lines: LogLine[]): LogLine[] {
  const out: LogLine[] = [];
  for (const l of lines) {
    const prev = out.at(-1);
    const starts = /\[Nest\]|\b(?:LOG|ERROR|WARN|DEBUG|VERBOSE)\s+\[|request_completed|^\S+=/.test(l.text) || l.status !== null;
    const continuation = /^(?:at\s|Caused by:|status:|message:|stack:|code:|details?:)/i.test(l.text);
    const boundary = prev && (
      prev.context !== null && l.context !== null && prev.context !== l.context ||
      prev.userId !== null && l.userId !== null && prev.userId !== l.userId ||
      prev.clientVersion !== null && l.clientVersion !== null && prev.clientVersion !== l.clientVersion ||
      l.level !== prev.level && !continuation
    );
    if (prev && prev.at === l.at && !starts && !boundary) {
      prev.text = `${prev.text} | ${l.text}`.slice(0, 4000);
      continue;
    }
    out.push({ ...l });
  }
  return out;
}

export function dedupe(lines: LogLine[]): LogLine[] {
  const seen = new Set<string>();
  return lines
    .filter((l) => {
      const k = `${l.at}|${l.text}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => a.at.localeCompare(b.at) || a.text.localeCompare(b.text));
}

// ── live logs ────────────────────────────────────────────────────────────────

type Result = { status: SourceStatus; evidence: Evidence[] };

async function railwayLines(src: { name: string; railway: { service: string; cwd?: string } }, w: Window, runner: Runner): Promise<{ lines: LogLine[]; errors: string[]; note: string } | SourceStatus> {
  const opts = { cwd: src.railway.cwd ? resolve(config.repo, src.railway.cwd) : config.repo, timeoutMs: 120_000 };
  const service = src.railway.service;
  const list = await runner('railway', ['deployment', 'list', '--service', service, '--json'], opts);
  if (list.code === 127) return { source: 'logs', state: 'missing-credentials', detail: 'railway CLI not installed' };
  if (list.code !== 0) return { source: 'logs', state: 'error', detail: `railway deployment list: ${firstLine(list.stderr)}` };
  let deployments: Array<{ id: string; createdAt: string }> = [];
  try {
    const value: unknown = JSON.parse(list.stdout);
    if (!Array.isArray(value) || value.some((d) => !d || typeof d.id !== 'string' || !d.id || typeof d.createdAt !== 'string' || !Number.isFinite(timestampMs(d.createdAt)))) {
      throw new Error('invalid deployment list shape');
    }
    deployments = value;
  } catch {
    return { source: 'logs', state: 'error', detail: 'railway deployment list: invalid JSON or deployment list shape' };
  }
  deployments.sort((a, b) => timestampMs(a.createdAt) - timestampMs(b.createdAt));
  const from = timestampMs(w.from);
  const to = timestampMs(w.to);
  const overlapping = deployments.filter((d, i) => timestampMs(d.createdAt) <= to && timestampMs(deployments[i + 1]?.createdAt ?? '9999-12-31T23:59:59.999Z') >= from);
  if (!overlapping.length) {
    return { source: 'logs', state: 'expired', detail: `no Railway deployment of ${service} covers the window; oldest listed deployment started ${deployments[0]?.createdAt ?? 'unknown'}` };
  }
  const lines: LogLine[] = [];
  const errors: string[] = [];
  for (const d of overlapping) {
    const r = await runner('railway', ['logs', d.id, '--service', service, '--since', w.from, '--until', w.to, '--json'], opts);
    if (r.code !== 0) {
      errors.push(`${d.id.slice(0, 8)}: ${firstLine(r.stderr)}`);
      continue;
    }
    lines.push(...mergeContinuations(r.stdout.split('\n').map(parseLogLine).filter((l): l is LogLine => l !== null && inWindow(l.at, w))));
  }
  return { lines, errors, note: `${overlapping.length} deployment(s)` };
}

async function commandLines(src: { name: string; command: string[]; cwd?: string }, w: Window, runner: Runner): Promise<{ lines: LogLine[]; errors: string[]; note: string } | SourceStatus> {
  const args = src.command.slice(1).map((a) => a.replaceAll('{since}', w.from).replaceAll('{until}', w.to));
  const r = await runner(src.command[0], args, { cwd: src.cwd ? resolve(config.repo, src.cwd) : config.repo, timeoutMs: 120_000 });
  if (r.code === 127) return { source: 'logs', state: 'missing-credentials', detail: `${src.command[0]} not installed` };
  if (r.code !== 0) return { source: 'logs', state: 'error', detail: `${src.command[0]}: ${firstLine(r.stderr || r.stdout)}` };
  return { lines: mergeContinuations(r.stdout.split('\n').map(parseLogLine).filter((l): l is LogLine => l !== null && inWindow(l.at, w))), errors: [], note: `\`${src.command[0]}\`` };
}

function fileLines(src: { name: string; file: string }, w: Window): { lines: LogLine[]; errors: string[]; note: string } | SourceStatus {
  const files = globSync(src.file, { cwd: config.repo }).map((f) => resolve(config.repo, f)).sort();
  if (!files.length) return { source: 'logs', state: 'not-found', detail: `no file matches ${src.file}` };
  const lines: LogLine[] = [];
  const errors: string[] = [];
  for (const f of files) {
    try {
      lines.push(...mergeContinuations(readFileSync(f, 'utf8').split('\n').map(parseLogLine).filter((l): l is LogLine => l !== null && inWindow(l.at, w))));
    } catch (e) {
      errors.push(`${basename(f)}: ${(e as Error).message}`);
    }
  }
  return { lines, errors, note: errors.length ? `${files.length - errors.length} readable file(s)` : `${files.length} file(s)` };
}

/** Every configured log source, filtered to lines that mention the ids or look like failures. */
export async function gatherLogs(w: Window, ids: string[], runner: Runner = run): Promise<Result[]> {
  const sources = config.sources.logs ?? [];
  if (!sources.length) return [{ status: { source: 'logs', state: 'skipped', detail: 'no log source in the config' }, evidence: [] }];
  const normalizedWindow = safeWindow(w);
  if (!normalizedWindow) return sources.map((src) => ({ status: { source: 'logs', state: 'error', detail: `${src.name}: invalid log window; expected ordered ISO timestamps` }, evidence: [] }));
  const out: Result[] = [];
  for (const src of sources) {
    const got = 'railway' in src ? await railwayLines(src, normalizedWindow, runner) : 'command' in src ? await commandLines(src, normalizedWindow, runner) : fileLines(src, normalizedWindow);
    if ('state' in got) {
      out.push({ status: { ...got, detail: `${src.name}: ${got.detail}` }, evidence: [] });
      continue;
    }
    const kept = dedupe(got.lines.filter((l) => relevant(l, ids))).slice(0, 800);
    if (!kept.length) {
      const stale = 'railway' in src && Date.now() - Date.parse(w.to) > 7 * 86_400_000;
      out.push({
        status: {
          source: 'logs',
          state: got.errors.length ? 'error' : stale ? 'expired' : 'empty',
          detail: `${src.name}: ${got.errors.length ? got.errors.join('; ') : stale ? 'no lines returned: logs past retention (~7 days on Railway)' : 'no relevant lines in the window'}`,
        },
        evidence: [],
      });
      continue;
    }
    out.push({
      status: { source: 'logs', state: 'ok', detail: `${src.name}: ${kept.length} relevant lines from ${got.note}${got.errors.length ? `; failed: ${got.errors.join('; ')}` : ''}` },
      evidence: kept.map((l) => logEvidence(l, 'logs')),
    });
  }
  return out;
}

// ── archived logs inside saved agent transcripts ─────────────────────────────

export const globRegex = (g: string) => new RegExp(`^${g.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);

function hourPrefixes(w: Window): string[] {
  const out: string[] = [];
  for (let t = timestampMs(w.from) - 3_600_000; t <= timestampMs(w.to); t += 3_600_000) out.push(new Date(t).toISOString().slice(0, 13) + ':');
  return [...new Set(out)];
}

function toolResultTexts(o: any): string[] {
  if (o?.type === 'assistant' || o?.message?.role === 'assistant') return [];
  const content = o?.message?.content;
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const b of content) {
    if (b?.type !== 'tool_result') continue;
    if (typeof b.content === 'string') out.push(b.content);
    else if (Array.isArray(b.content)) for (const c of b.content) if (typeof c?.text === 'string') out.push(c.text);
  }
  return out;
}

/**
 * Log-shaped tool output from a saved Claude Code transcript. Assistant messages are excluded, but
 * the transcript does not prove which command produced the output or whether it was edited later.
 */
export async function gatherArchive(w: Window, ids: string[], runner: Runner = run): Promise<{ status: SourceStatus; evidence: Evidence[] }> {
  const archive = config.sources.archive;
  if (!archive) return { status: { source: 'archive', state: 'skipped', detail: 'no archive source in the config' }, evidence: [] };
  const args = ['-l', '-F', '--glob', '*.jsonl', '--glob', '!**/subagents/**'];
  for (const p of hourPrefixes(w)) args.push('-e', p);
  args.push(archive.dir);
  const r = await runner('rg', args, { timeoutMs: 120_000 });
  if (r.code === 127) return { status: { source: 'archive', state: 'skipped', detail: 'ripgrep (rg) not installed' }, evidence: [] };
  if (r.code !== 0 && r.code !== 1) return { status: { source: 'archive', state: 'error', detail: `transcript search: ${firstLine(r.stderr)}` }, evidence: [] };
  const files = r.stdout
    .split('\n')
    .filter(Boolean)
    .filter((f) => globRegex(archive.glob).test(basename(dirname(f))))
    .sort();
  if (!files.length) return { status: { source: 'archive', state: 'empty', detail: `no saved transcript in ${archive.dir} mentions the window` }, evidence: [] };
  const found = new Map<string, { line: LogLine; file: string; row: number }>();
  for (const file of files) {
    const rows = readFileSync(file, 'utf8').split('\n');
    rows.forEach((row, i) => {
      if (!row.includes('tool_result')) return;
      let o: unknown;
      try {
        o = JSON.parse(row);
      } catch {
        return;
      }
      for (const text of toolResultTexts(o)) {
        const parsed = text
          .split('\n')
          .map((raw) => parseLogLine(raw.replace(/^\s*\d+[\t→]/, '')))
          .filter((l): l is LogLine => l !== null && inWindow(l.at, w));
        for (const l of mergeContinuations(parsed)) {
          if (!relevant(l, ids)) continue;
          const k = `${l.at}|${l.text}`;
          if (!found.has(k)) found.set(k, { line: l, file, row: i + 1 });
        }
      }
    });
  }
  const kept = [...found.values()].sort((a, b) => a.line.at.localeCompare(b.line.at) || a.line.text.localeCompare(b.line.text)).slice(0, 800);
  if (!kept.length) return { status: { source: 'archive', state: 'empty', detail: `${files.length} transcript(s) touch the window but hold no relevant log lines` }, evidence: [] };
  const sessions = new Set(kept.map((k) => basename(k.file)));
  return {
    status: { source: 'archive', state: 'ok', detail: `${kept.length} log-shaped tool output lines from ${sessions.size} saved transcript(s); original command and source are unverified` },
    evidence: kept.map((k) => ({ ...logEvidence(k.line, 'archive', { file: k.file, row: k.row }), link: `${k.file}:${k.row}` })),
  };
}
