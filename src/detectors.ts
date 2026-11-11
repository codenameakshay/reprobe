import { createHash } from 'node:crypto';
import { parseIntent } from './gather.ts';
import type { Confidence, DetectCtx, Detector, Evidence, Finding, Gathered, Pack } from './types.ts';

export const ms = (s: string | null) => {
  if (!s) return NaN;
  const normalized = /^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?$/.test(s) ? `${s}Z` : s;
  return Date.parse(normalized);
};
export const d = <T>(e: Evidence) => e.data as T;
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
export const byStableTime = (a: Evidence, b: Evidence) => {
  const atA = ms(a.at);
  const atB = ms(b.at);
  return (Number.isFinite(atA) && Number.isFinite(atB) ? atA - atB : cmp(a.at ?? '', b.at ?? '')) || cmp(a.id, b.id);
};

export function caseIdFor(g: Gathered): string {
  const h = createHash('sha256').update(JSON.stringify([g.input.complaint, g.input.trace ?? '', g.input.user ?? '', g.input.chat ?? '', g.window.to])).digest('hex');
  return `${g.window.to.slice(0, 10)}-${h.slice(0, 6)}`;
}

export function routeTemplate(path: string): string {
  return path
    .split('?')[0]
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/:id')
    .replace(/\/c[a-z0-9]{24}\b/g, '/:id')
    .replace(/\/\d+(?=\/|$)/g, '/:n');
}

// ── A deliberate 4xx turned into a 500 (Nest/Spring-style `*Exception` names) ────────────────────────────────────

const CLIENT_EXCEPTIONS = /\b(BadRequest|Unauthorized|Forbidden|NotFound|Conflict|Gone|PayloadTooLarge|UnprocessableEntity|PreconditionFailed|UnsupportedMediaType)Exception: ([^|]+?)\s*(?:\||$)/;

interface Line {
  text: string;
  level: string;
  context: string | null;
  method: string | null;
  path: string | null;
  status: number | null;
}

const maskedClientError: Detector = ({ ev, intent }) => {
  const lines = ev.filter((e) => e.source === 'logs' || e.source === 'archive');
  const failed = lines.filter((e) => (d<Line>(e).status ?? 0) >= 500 && d<Line>(e).path);
  const groups = new Map<string, { exc: Evidence; name: string; message: string; route: string; method: string; hits: Evidence[]; triggers: Evidence[] }>();
  for (const e of lines) {
    const m = d<Line>(e).text.match(CLIENT_EXCEPTIONS);
    if (!m) continue;
    const near = failed.filter((f) => {
      const delta = Math.abs(ms(f.at) - ms(e.at));
      if (!Number.isFinite(delta) || delta > 2_000) return false;
      const matches = lines.flatMap((candidate) => {
        const match = d<Line>(candidate).text.match(CLIENT_EXCEPTIONS);
        const timeDelta = Math.abs(ms(f.at) - ms(candidate.at));
        return match && Number.isFinite(timeDelta) && timeDelta <= 2_000 ? [`${match[1]} ${match[2]}`] : [];
      });
      return new Set(matches).size === 1 && matches[0] === `${m[1]} ${m[2]}`;
    });
    if (!near.length) continue;
    if (new Set(near.map((n) => `${d<Line>(n).method} ${routeTemplate(d<Line>(n).path!)}`)).size !== 1) continue;
    const http = d<Line>(near[0]);
    const route = routeTemplate(http.path!);
    const key = `${http.method} ${route} ${m[1]} ${m[2]}`;
    const g = groups.get(key) ?? { exc: e, name: `${m[1]}Exception`, message: m[2].replace(/\s+\(\+\d+ms\)$/, ''), route, method: http.method ?? '?', hits: [], triggers: [] };
    for (const n of near) if (!g.hits.includes(n)) g.hits.push(n);
    for (const w of lines) {
      if (d<Line>(w).level === 'warn' && ms(w.at) <= ms(e.at) && ms(e.at) - ms(w.at) <= 1_000 && !g.triggers.includes(w)) g.triggers.push(w);
    }
    groups.set(key, g);
  }
  const out: Finding[] = [];
  for (const g of groups.values()) {
    const attempts = g.hits.length;
    const subjects = new Set(g.hits.map((h) => d<Line>(h).path)).size;
    const trigger = g.triggers.slice().sort(byStableTime)[0];
    const cited = [g.exc.id, ...g.hits.map((h) => h.id), ...g.triggers.slice(0, 3).map((t) => t.id)];
    const retriesNote = intent.retries ? ` The complaint says the user tried ${intent.retries} time(s); the logs show ${attempts} failed attempt(s) on ${subjects} distinct ${subjects === 1 ? 'resource' : 'resources'}.` : '';
    const orderedHits = [...g.hits].sort(byStableTime);
    out.push({
      signature: 'client-error-masked-as-500',
      title: `${g.method} ${g.route} answered 500 for a deliberate ${g.name}`,
      confidence: 'high',
      rootCause:
        `A ${g.name} ("${g.message}") and HTTP 500 evidence occur within two seconds on ${g.method} ${g.route} ` +
        `(${attempts} matching response(s), ${orderedHits[0].at ?? 'time unknown'} to ${orderedHits.at(-1)?.at ?? 'time unknown'}). The available rows do not establish a shared request ID.` +
        (trigger ? ` A nearby warning says: "${d<Line>(trigger).text.replace(/^.*?\b(?:LOG|ERROR|WARN|DEBUG|VERBOSE)\s+\[[^\]]+\]\s*/, '').slice(0, 200)}".` : '') +
        ` Likely cause, which the replay tests: the handler turns this deliberate ${g.name} into a 500, which a client usually shows as a generic, retryable failure, so the user retries a rejection that can never succeed.` +
        retriesNote,
      evidence: cited,
      unknowns: [
        'whether the exception and HTTP 500 share a request ID; only route and timing co-occurrence are available',
        'the request body the client sent (the server does not log it), so why the client built that request is not observable here',
      ],
    });
  }
  return out;
};

// ── Everything else that looks wrong, without a signature ─────────────────

const anomalies: Detector = ({ ev }) => {
  const kinds: Array<[string, (e: Evidence) => boolean]> = [
    ['agent run failed', (e) => e.kind === 'agent.run' && /FAILED|CANCELLED/.test(e.summary)],
    ['chat turn marked run_failed', (e) => e.kind === 'chat.user' && e.summary.includes('RUN FAILED')],
    ['Langfuse span at ERROR level', (e) => e.source === 'langfuse' && e.summary.includes('level ERROR')],
    ['server 5xx', (e) => e.kind === 'http.5xx'],
    ['server error log', (e) => e.kind === 'log.error'],
    ['Sentry issue', (e) => e.kind === 'sentry.issue'],
    ['in-app bug report', (e) => e.kind === 'bug.report'],
  ];
  const out: Finding[] = [];
  for (const [title, match] of kinds) {
    const hits = ev.filter(match);
    if (!hits.length) continue;
    out.push({
      signature: `anomaly:${title.replace(/\s+/g, '-').toLowerCase()}`,
      title: `${hits.length} × ${title}`,
      confidence: 'low',
      rootCause: `Seen in the window but not matched to a known failure signature: ${hits.slice(0, 3).map((h) => h.summary.slice(0, 120)).join(' | ')}`,
      evidence: hits.slice(0, 10).map((h) => h.id),
      unknowns: [],
    });
  }
  return out;
};

export const CORE_DETECTORS: Detector[] = [maskedClientError, anomalies];

const RANK: Record<Confidence, number> = { high: 0, medium: 1, low: 2 };

export function detect(g: Gathered, pack: Pack | null = null): Finding[] {
  const ev = [...g.evidence].sort(byStableTime);
  const ctx: DetectCtx = { g, intent: parseIntent(g.input.complaint), caseId: caseIdFor(g), ev };
  const all = [...(pack?.detectors ?? []), ...CORE_DETECTORS].flatMap((det) => det(ctx)).map((f) => (f.replay || !pack?.replayFor ? f : { ...f, replay: pack.replayFor(f, ctx) }));
  const signatures = new Set(all.filter((f) => !f.signature.startsWith('anomaly:')).flatMap((f) => f.evidence));
  return all
    .map((f) => {
      if (!f.signature.startsWith('anomaly:')) return f;
      const evidence = f.evidence.filter((id) => !signatures.has(id));
      const hits = evidence.map((id) => ev.find((e) => e.id === id)).filter((e): e is Evidence => Boolean(e));
      const suffix = f.signature.slice('anomaly:'.length).replace(/-/g, ' ');
      return { ...f, title: `${evidence.length} × ${suffix}`, rootCause: `Seen in the window but not matched to a known failure signature: ${hits.slice(0, 3).map((h) => h.summary.slice(0, 120)).join(' | ')}`, evidence };
    })
    .filter((f) => f.evidence.length)
    .sort((a, b) => RANK[a.confidence] - RANK[b.confidence] || b.evidence.length - a.evidence.length || (a.signature < b.signature ? -1 : a.signature > b.signature ? 1 : 0));
}
