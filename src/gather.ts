import { config } from './config.ts';
import { retryingFetch, run } from './exec.ts';
import { redactValue } from './redact.ts';
import { fetchTrace, findTraceIds, langfuseClient, parseLangfuseTrace } from './sources/langfuse.ts';
import { gatherLangsmith, parseLangsmithShare } from './sources/langsmith.ts';
import { gatherArchive, gatherLogs } from './sources/logs.ts';
import { connect } from './sources/postgres.ts';
import { gatherSentry } from './sources/sentry.ts';
import type { Evidence, GatherCtx, Gathered, Input, Intent, Pack, SourceStatus, Subject, Window } from './types.ts';

const WORD_NUM: Record<string, number> = { once: 1, twice: 2, thrice: 3, two: 2, three: 3, four: 4, five: 5 };

/** Product-neutral facts in the complaint. Packs read `words` for their own topics. */
export function parseIntent(text: string): Intent {
  const t = text.toLowerCase();
  const n = t.match(/\b(once|twice|thrice)\b|\b(\d+|two|three|four|five) times\b/);
  return {
    build: t.match(/\b(?:build|app|version|on)\s*(?:no\.?\s*|v|#)?(\d{3})\b/)?.[1] ?? null,
    aboutOther: /\b(my friend|a friend|friend of mine|my (?:customer|client|colleague)|a user|the user|this user|his|her|he|she)\b/.test(t),
    retries: n ? (WORD_NUM[n[1] ?? n[2]] ?? Number(n[2])) || null : null,
    words: t,
  };
}

/** Times the input itself carries: a trace URL's `timestamp=`/`start_time=`. */
export function anchorFromInput(input: Input): string | null {
  if (input.at) return new Date(input.at).toISOString();
  for (const s of [input.trace ?? '']) {
    let decoded = s;
    try {
      decoded = decodeURIComponent(s);
    } catch {}
    const m = decoded.match(/(?:timestamp|start_time)=(\d{4}-\d\d-\d\dT[\d:.]+Z?)/);
    if (m) return new Date(m[1].endsWith('Z') ? m[1] : `${m[1]}Z`).toISOString();
  }
  return null;
}

export function windowFor(anchor: string, sinceMs: number): Window {
  const at = Date.parse(anchor);
  return { from: new Date(at - sinceMs).toISOString(), to: new Date(at + 10 * 60_000).toISOString() };
}

async function settle<T>(source: SourceStatus['source'], p: Promise<T>): Promise<T | SourceStatus> {
  try {
    return await p;
  } catch (e) {
    return { source, state: 'error', detail: errorDetail(e) };
  }
}

function errorDetail(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).slice(0, 300);
}

function take(r: { status: SourceStatus; evidence: Evidence[] } | SourceStatus, sources: SourceStatus[], evidence: Evidence[]) {
  if ('state' in r) sources.push(r);
  else {
    sources.push(r.status);
    evidence.push(...r.evidence);
  }
}

export async function gather(input: Input, pack: Pack | null, log: (s: string) => void = () => {}): Promise<Gathered> {
  const sources: SourceStatus[] = [];
  const evidence: Evidence[] = [];
  const subject: Subject = { sessionIds: [], traceIds: [] };
  const intent = parseIntent(input.complaint);

  let pg = null;
  if (config.sources.postgres) {
    log('connecting to Postgres (read-only)');
    const connected = await settle('postgres', connect());
    pg = 'state' in connected ? null : connected.db;
    sources.push('state' in connected ? connected : connected.status);
  }

  // 1. Traces first: they carry the user, the session and the time.
  let anchor = anchorFromInput(input);
  const lfId = input.trace ? parseLangfuseTrace(input.trace) : null;
  const lsShare = input.trace && !lfId ? parseLangsmithShare(input.trace) : null;
  const lfResolution = await settle('langfuse', langfuseClient());
  const lfFailed = lfResolution !== null && 'state' in lfResolution;
  const lf = lfResolution === null || lfFailed ? null : lfResolution;
  if (lfResolution !== null && 'state' in lfResolution) sources.push(lfResolution);
  if (lfId) {
    log(`fetching Langfuse trace ${lfId}`);
    if (!lf) {
      if (!lfFailed) sources.push({ source: 'langfuse', state: 'missing-credentials', detail: config.sources.langfuse ? 'Langfuse keys did not resolve (reprobe doctor)' : 'no langfuse source in the config' });
    } else {
      const r = await settle('langfuse', fetchTrace(lf, lfId, pack?.observation));
      take(r, sources, evidence);
      if (!('state' in r)) {
        subject.traceIds.push(lfId);
        if (r.userId) Object.assign(subject, { userId: r.userId, how: `user on Langfuse trace ${lfId}` });
        if (r.sessionId) subject.sessionIds.push(r.sessionId);
        anchor ??= r.at ?? null;
      }
    }
  }
  if (lsShare) {
    log(`fetching LangSmith public run ${lsShare}`);
    const r = await settle('langsmith', gatherLangsmith(lsShare, retryingFetch()));
    take(r, sources, evidence);
    if (!('state' in r)) anchor ??= r.evidence[0]?.at ?? null;
  } else if (input.trace && !lfId) {
    sources.push({ source: 'langsmith', state: 'error', detail: `--trace "${input.trace.slice(0, 80)}" is neither a Langfuse trace nor a LangSmith share link` });
  }

  anchor ??= new Date().toISOString();
  const window = windowFor(anchor, input.sinceMs);
  const ctx: GatherCtx = { config, input, intent, window, subject, sources, evidence, pg, logIds: [], log, run };

  // 2. Who is this about? A pack knows the product's users; without one, --user and the reporter are taken as given.
  let resolveSubjectFailed = false;
  if (pack?.resolveSubject) {
    const priorSubject = { ...subject, sessionIds: [...subject.sessionIds], traceIds: [...subject.traceIds] };
    const priorLogIds = [...ctx.logIds];
    try {
      await pack.resolveSubject(ctx);
    } catch (e) {
      resolveSubjectFailed = true;
      delete subject.userId;
      delete subject.label;
      delete subject.how;
      Object.assign(subject, priorSubject);
      ctx.logIds.splice(0, ctx.logIds.length, ...priorLogIds);
      sources.push({ source: pack.name, state: 'error', detail: errorDetail(e) });
    }
  }
  if (!pack?.resolveSubject || resolveSubjectFailed) {
    const reporter = input.reporter ?? config.reporter;
    if (input.user && !subject.userId) Object.assign(subject, { userId: input.user, how: '--user, taken as given' });
    else if (!subject.userId && reporter && !intent.aboutOther) Object.assign(subject, { userId: reporter, how: 'the reporter (first-person complaint)' });
    if (input.chat) subject.sessionIds.push(input.chat);
  }

  // 3. Logs, live and archived, filtered by every id in play.
  const ids = [...new Set([subject.userId, ...subject.sessionIds, ...ctx.logIds].filter((x): x is string => Boolean(x)))];
  log('reading logs');
  const [live, archived] = await Promise.all([settle('logs', gatherLogs(window, ids)), settle('archive', gatherArchive(window, ids))]);
  if ('state' in live) sources.push(live);
  else for (const r of live) take(r, sources, evidence);
  take(archived, sources, evidence);

  // 4. Product rows, after logs so a pack can use them to narrow candidates.
  if (pack?.gather) {
    log(`reading ${pack.name} rows`);
    try {
      await pack.gather(ctx);
    } catch (e) {
      sources.push({ source: pack.name, state: 'error', detail: errorDetail(e) });
    }
  }

  if (lf && subject.userId && !lfId) {
    const traceIds = (await settle('langfuse', findTraceIds(lf, window, subject.userId, subject.sessionIds))) as string[] | SourceStatus;
    if (!Array.isArray(traceIds)) sources.push(traceIds);
    else if (!traceIds.length) sources.push({ source: 'langfuse', state: 'empty', detail: 'no traces for the subject in the window' });
    else {
      for (const id of traceIds.slice(0, 6)) {
        const r = await settle('langfuse', fetchTrace(lf, id, pack?.observation));
        take(r, sources, evidence);
        if (!('state' in r)) subject.traceIds.push(id);
      }
    }
  } else if (!lf && !lfId && config.sources.langfuse && !lfFailed) {
    sources.push({ source: 'langfuse', state: 'missing-credentials', detail: 'Langfuse keys did not resolve (reprobe doctor)' });
  }

  if (config.sources.sentry) take(await settle('sentry', gatherSentry({ window, userId: subject.userId, issue: input.sentry })), sources, evidence);

  const unique = new Map(evidence.map((e) => [e.id, e]));
  const sorted = [...unique.values()].sort((a, b) => (a.at ?? '').localeCompare(b.at ?? '') || a.id.localeCompare(b.id));
  return redactValue({ input, window, subject, sources, evidence: sorted });
}
