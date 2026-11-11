import type { Evidence, SourceStatus } from '../types.ts';
import { redactText, redactValue } from '../redact.ts';

const API = 'https://api.smith.langchain.com/api/v1/public';
const WEB = 'https://smith.langchain.com/public';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIMEOUT_MS = 20_000;

interface LangsmithRun {
  id: string;
  name?: string;
  run_type?: string;
  status?: string;
  error?: unknown;
  start_time?: string | null;
  end_time?: string | null;
  parent_run_id?: string | null;
  inputs?: unknown;
  outputs?: unknown;
}

interface Result {
  status: SourceStatus;
  evidence: Evidence[];
}

/** Accepts a share URL or a bare share UUID; returns the share UUID, or null. */
export function parseLangsmithShare(input: string): string | null {
  const s = input.trim();
  if (UUID.test(s)) return s;
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  const id = /\/public\/([^/]+)/.exec(url.pathname)?.[1];
  return id !== undefined && UUID.test(id) ? id : null;
}

export async function gatherLangsmith(share: string, fetchImpl: typeof fetch = fetch): Promise<Result> {
  const none = (state: SourceStatus['state'], detail: string): Result => ({
    status: { source: 'langsmith', state, detail },
    evidence: [],
  });

  let res: Response;
  try {
    res = await fetchImpl(`${API}/${share}/run`, { method: 'GET', signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    return none('unreachable', errorMessage(e));
  }
  if (res.status === 404) {
    return none('expired', `share token not found (trace deleted, unshared, or past LangSmith retention): ${share}`);
  }
  if (!res.ok) return none('error', `HTTP ${res.status}`);

  let top: LangsmithRun;
  try {
    top = (await res.json()) as LangsmithRun;
  } catch (e) {
    return none('error', `invalid JSON: ${errorMessage(e)}`);
  }
  if (!top || typeof top.id !== 'string') return none('error', 'unexpected response: no run id');

  // Best effort: if the list call fails, report the top run alone.
  let listed: LangsmithRun[] = [];
  try {
    const q = await fetchImpl(`${API}/${share}/runs/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ limit: 100 }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (q.ok) listed = arr(((await q.json()) as { runs?: unknown }).runs) as LangsmithRun[];
  } catch {
    listed = [];
  }

  const rest = listed.filter((r) => typeof r?.id === 'string' && r.id !== top.id).sort(byStartThenId);
  const runs = [top, ...rest];
  return {
    status: { source: 'langsmith', state: 'ok', detail: `${runs.length} runs` },
    evidence: runs.map((r) => toEvidence(r, share)),
  };
}

function toEvidence(run: LangsmithRun, share: string): Evidence {
  const tools = toolNames(run.outputs);
  const error = run.error ? ` ERROR: ${errorText(run.error).slice(0, 200)}` : '';
  const toolPart = tools.length > 0 ? ` tools=[${tools.join(',')}]` : '';
  return {
    id: `langsmith:run:${run.id}`,
    source: 'langsmith',
    at: withZone(run.start_time),
    kind: 'langsmith.run',
    summary: `${run.run_type ?? ''} ${run.name ?? ''}`.trim() + error + toolPart,
    data: {
      id: run.id,
      name: run.name ?? null,
      run_type: run.run_type ?? null,
      status: run.status ?? null,
      error: run.error ?? null,
      start_time: run.start_time ?? null,
      end_time: run.end_time ?? null,
      parent_run_id: run.parent_run_id ?? null,
      inputs_preview: preview(run.inputs),
      outputs_preview: preview(run.outputs),
    },
    link: `${WEB}/${share}/r`,
  };
}

function toolNames(outputs: unknown): string[] {
  const names: string[] = [];
  const steps = arr((outputs as { output?: unknown } | null | undefined)?.output);
  for (const step of steps as Array<{ update?: { messages?: unknown } }>) {
    for (const msg of arr(step?.update?.messages) as Array<{ tool_calls?: unknown }>) {
      for (const call of arr(msg?.tool_calls) as Array<{ name?: unknown }>) {
        if (typeof call?.name === 'string') names.push(call.name);
      }
    }
  }
  return names;
}

function byStartThenId(a: LangsmithRun, b: LangsmithRun): number {
  const sa = a.start_time ?? '';
  const sb = b.start_time ?? '';
  if (sa !== sb) return sa < sb ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function withZone(t: string | null | undefined): string | null {
  if (!t) return null;
  return /(?:Z|[+-]\d{2}:?\d{2})$/i.test(t) ? t : `${t}Z`;
}

function preview(v: unknown): string {
  return JSON.stringify(redactValue(v ?? null)).slice(0, 800);
}

function errorText(e: unknown): string {
  return redactText(typeof e === 'string' ? e : JSON.stringify(redactValue(e)) ?? '');
}

function arr(x: unknown): unknown[] {
  return Array.isArray(x) ? x : [];
}

function errorMessage(e: unknown): string {
  return redactText(e instanceof Error ? e.message : String(e));
}
