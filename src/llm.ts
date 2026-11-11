import { config } from './config.ts';
import { run, type Runner } from './exec.ts';
import { redactText, redactValue } from './redact.ts';
import type { Finding, Gathered } from './types.ts';

export interface Claim {
  text: string;
  evidence: string[];
}

export interface Narrative {
  model: string;
  summary: Claim[];
  hypotheses: Claim[];
  dropped: string[];
}


export function buildPrompt(g: Gathered, findings: Finding[]): string {
  const safeGathered = redactValue(g);
  const safeFindings = redactValue(findings);
  const cited = new Set(safeFindings.flatMap((f) => f.evidence));
  const ev = safeGathered.evidence.filter((e) => cited.has(e.id) || !['logs', 'archive'].includes(e.source)).slice(0, 220);
  return [
    'You summarise a production bug investigation for the engineer who owns the code.',
    'Rules:',
    '- Use ONLY the evidence items below. Every sentence must cite at least one evidence id from the list, exactly as written.',
    '- Do not invent ids, rows, log lines, times, numbers, or code. If something is unknown, say it is unknown and cite the source status that shows it.',
    '- The deterministic findings are already ranked; you may restate them, and you may add at most 2 extra hypotheses, each clearly tied to cited evidence.',
    '- Short declarative sentences. No marketing tone.',
    'Reply with JSON only, no prose around it, matching:',
    '{"summary":[{"text":"...","evidence":["id",...]}],"hypotheses":[{"text":"...","evidence":["id",...]}]}',
    '',
    `COMPLAINT: ${safeGathered.input.complaint}`,
    `WINDOW: ${safeGathered.window.from} to ${safeGathered.window.to}`,
    `SUBJECT: ${safeGathered.subject.label ?? 'unresolved'} (${safeGathered.subject.how ?? ''})`,
    `SOURCES: ${JSON.stringify(safeGathered.sources)}`,
    `FINDINGS: ${JSON.stringify(safeFindings.map(({ replay, ...f }) => f))}`,
    'EVIDENCE:',
    ...ev.map((e) => `${e.id} | ${e.at ?? '-'} | ${e.source} | ${e.summary}`),
  ].join('\n');
}

/** Keeps a claim only if it cites at least one id and every id it cites exists. */
export function validate(raw: string, known: Set<string>): Omit<Narrative, 'model'> | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  let parsed: { summary?: unknown; hypotheses?: unknown };
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const dropped: string[] = [];
  const keep = (list: unknown): Claim[] =>
    (Array.isArray(list) ? list : []).filter((c): c is Claim => {
      const ok = c && typeof c.text === 'string' && Array.isArray(c.evidence) && c.evidence.length > 0 && c.evidence.every((id: unknown) => typeof id === 'string' && known.has(id));
      if (!ok && c && typeof c.text === 'string') dropped.push(c.text.slice(0, 160));
      return ok;
    });
  return { summary: keep(parsed.summary), hypotheses: keep(parsed.hypotheses), dropped };
}

export async function narrate(g: Gathered, findings: Finding[], runner: Runner = run): Promise<Narrative | { error: string }> {
  const MODEL = config.llmModel;
  try {
    const r = await runner('claude', ['-p', '--model', MODEL, '--output-format', 'text', '--tools', '', '--disable-slash-commands'], {
      input: buildPrompt(g, findings),
      timeoutMs: 240_000,
      env: { CLAUDECODE: undefined, CLAUDE_CODE_ENTRYPOINT: undefined },
    });
    if (r.code !== 0) return { error: redactText(`claude -p exited ${r.code}: ${r.stderr.trim()}`).slice(0, 200) };
    const v = validate(r.stdout, new Set(g.evidence.map((e) => e.id)));
    if (!v) return { error: 'LLM reply was not the requested JSON' };
    return redactValue({ model: MODEL, ...v });
  } catch (e) {
    return { error: redactText(e instanceof Error ? e.message : String(e)).slice(0, 300) };
  }
}
