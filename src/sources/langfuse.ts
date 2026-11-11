import { config, resolveSecret } from '../config.ts';
import { retryingFetch } from '../exec.ts';
import { redactText, redactValue } from '../redact.ts';
import type { Evidence, SourceStatus, Window } from '../types.ts';

export function parseLangfuseTrace(input: string): string | null {
  const m = input.match(/traces\/([0-9a-f]{32})/i) ?? input.match(/traceId=([0-9a-f]{32})/i) ?? input.trim().match(/^([0-9a-f]{32})$/i);
  return m ? m[1].toLowerCase() : null;
}

interface Obs {
  id: string;
  traceId: string;
  type: string;
  name: string;
  level?: string;
  statusMessage?: string | null;
  startTime: string;
  endTime?: string | null;
  parentObservationId?: string | null;
  input?: unknown;
  output?: unknown;
  metadata?: unknown;
  userId?: string | null;
  sessionId?: string | null;
}

export interface LangfuseClient {
  base: string;
  get(path: string): Promise<{ status: number; body: any }>;
}

export async function langfuseClient(fetchImpl: typeof fetch = retryingFetch()): Promise<LangfuseClient | null> {
  const lf = config.sources.langfuse;
  if (!lf) return null;
  const [pk, sk, rawBase] = (await Promise.all([resolveSecret(lf.publicKey), resolveSecret(lf.secretKey), resolveSecret(lf.baseUrl)])).map((r) => r.value);
  if (!pk || !sk || !rawBase) return null;
  const base = rawBase.replace(/\/+$/, '');
  const auth = `Basic ${Buffer.from(`${pk}:${sk}`).toString('base64')}`;
  return {
    base,
    async get(path) {
      let res: Response;
      try {
        res = await fetchImpl(`${base}${path}`, { headers: { authorization: auth }, signal: AbortSignal.timeout(120_000) });
      } catch (e) {
        throw new Error(redactText(e instanceof Error ? e.message : String(e)));
      }
      const text = await res.text();
      let body: unknown = null;
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
      return { status: res.status, body };
    },
  };
}

function parse(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

/**
 * Product-specific facts read off one observation (a pack knows its agent's output shapes).
 * `flags` lands in the evidence data for detectors; `bits` are appended to the summary.
 */
export type ObservationAnnotator = (o: { type: string; name: string; input: unknown; output: unknown; metadata: unknown }) => { flags: Record<string, unknown>; bits: string[] };

function toEvidence(o: Obs, link: string, annotate?: ObservationAnnotator): Evidence {
  const meta = (parse(o.metadata) ?? {}) as Record<string, unknown>;
  const extra = annotate?.({ type: o.type, name: o.name, input: o.input ?? null, output: o.output ?? null, metadata: o.metadata ?? null }) ?? { flags: {}, bits: [] };
  const flags = extra.flags;
  const bits = [`${o.type.toLowerCase()} ${o.name}`];
  if (o.level && o.level !== 'DEFAULT') bits.push(`level ${o.level}`);
  if (o.statusMessage) bits.push(`status "${String(o.statusMessage).slice(0, 160)}"`);
  bits.push(...extra.bits);
  return {
    id: `langfuse:obs:${o.id}`,
    source: 'langfuse',
    at: o.startTime,
    kind: `langfuse.${o.type.toLowerCase()}`,
    summary: bits.join(' · '),
    data: {
      traceId: o.traceId,
      id: o.id,
      parent: o.parentObservationId ?? null,
      type: o.type,
      name: o.name,
      level: o.level ?? null,
      startTime: o.startTime,
      endTime: o.endTime ?? null,
      runId: meta.runId ?? null,
      stepIndex: meta.stepIndex ?? null,
      agentName: meta.agentName ?? null,
      turnId: meta.turnId ?? null,
      flags,
      inputPreview: JSON.stringify(redactValue(o.input ?? null)).slice(0, 800),
      outputPreview: JSON.stringify(redactValue(o.output ?? null)).slice(0, 2000),
    },
    link,
  };
}

/**
 * v2 observations is the supported read path, but it does not serve older traces; the v1 trace
 * endpoint does until Langfuse removes it (announced for 2026-11-16). Try v2, fall back to v1, and say which.
 */
export async function fetchTrace(client: LangfuseClient, traceId: string, annotate?: ObservationAnnotator): Promise<{ status: SourceStatus; evidence: Evidence[]; userId?: string; sessionId?: string; at?: string }> {
  const v2 = await client.get(`/api/public/v2/observations?traceId=${traceId}&fields=core,basic,io,metadata&limit=200`);
  let observations: Obs[] = v2.status === 200 && Array.isArray(v2.body?.data) ? v2.body.data : [];
  let via = 'v2 observations';
  let trace: any = null;
  if (!observations.length) {
    const v1 = await client.get(`/api/public/traces/${traceId}`);
    if (v1.status === 404) {
      return { status: { source: 'langfuse', state: 'not-found', detail: `trace ${traceId} not found (deleted or past retention)` }, evidence: [] };
    }
    if (v1.status !== 200) return { status: { source: 'langfuse', state: 'error', detail: `trace ${traceId}: HTTP ${v1.status}` }, evidence: [] };
    trace = v1.body;
    observations = (trace.observations ?? []).map((o: Obs) => ({ ...o, traceId }));
    via = 'deprecated v1 trace endpoint (snapshot kept in the case dir)';
  }
  const projectId = trace?.projectId ?? (observations[0] as any)?.projectId ?? '';
  const link = `${client.base}/project/${projectId}/traces/${traceId}`;
  const evidence: Evidence[] = [];
  const userId = trace?.userId ?? observations.find((o) => o.userId)?.userId ?? undefined;
  const sessionId = trace?.sessionId ?? observations.find((o) => o.sessionId)?.sessionId ?? undefined;
  const at = trace?.timestamp ?? observations.map((o) => o.startTime).sort()[0];
  evidence.push({
    id: `langfuse:trace:${traceId}`,
    source: 'langfuse',
    at: at ?? null,
    kind: 'langfuse.trace',
    summary: `trace ${trace?.name ?? observations.find((o) => !o.parentObservationId)?.name ?? '?'} with ${observations.length} observations${trace?.release ? `, server release ${trace.release}` : ''}`,
    data: { traceId, release: trace?.release ?? null, userId: userId ?? null, sessionId: sessionId ?? null, tags: trace?.tags ?? [], output: trace?.output ?? null },
    link,
  });
  for (const o of [...observations].sort((a, b) => a.startTime.localeCompare(b.startTime) || a.id.localeCompare(b.id))) {
    evidence.push(toEvidence(o, link, annotate));
  }
  return { status: { source: 'langfuse', state: 'ok', detail: `trace ${traceId}: ${observations.length} observations via ${via}` }, evidence, userId, sessionId, at };
}

export async function findTraceIds(client: LangfuseClient, w: Window, userId?: string, sessionIds: string[] = []): Promise<string[]> {
  const ids = new Set<string>();
  if (userId) {
    const query = new URLSearchParams({ userId, fromStartTime: w.from, toStartTime: w.to, fields: 'core', limit: '200' });
    const r = await client.get(`/api/public/v2/observations?${query}`);
    for (const o of r.status === 200 && Array.isArray(r.body?.data) ? r.body.data : []) {
      if (typeof o?.traceId === 'string') ids.add(o.traceId);
    }
  }
  if (!ids.size) {
    const identities = [...(userId ? [{ userId }] : []), ...sessionIds.map((sessionId) => ({ sessionId }))];
    for (const identity of identities) {
      const query = new URLSearchParams({ ...identity, fromTimestamp: w.from, toTimestamp: w.to, limit: '50' });
      const r = await client.get(`/api/public/traces?${query}`);
      for (const t of r.status === 200 && Array.isArray(r.body?.data) ? r.body.data : []) {
        if (typeof t?.id === 'string') ids.add(t.id);
      }
    }
  }
  return [...ids].sort();
}
