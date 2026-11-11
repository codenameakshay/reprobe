import type { Confidence } from './types.ts';

export interface Claim {
  text: string;
  evidence: string[];
}

export interface Diagnosis {
  agent: string;
  rootCause: (Claim & { confidence: Confidence }) | null;
  summary: Claim[];
  hypotheses: Claim[];
  unknowns: string[];
  fix: { text: string; commit: string } | null;
  /** Claims removed because they cited nothing, or an id that is not in the evidence. */
  dropped: string[];
}

const isClaim = (c: unknown, known: Set<string>): c is Claim =>
  Boolean(c) &&
  typeof (c as Claim).text === 'string' &&
  Array.isArray((c as Claim).evidence) &&
  (c as Claim).evidence.length > 0 &&
  (c as Claim).evidence.every((id) => typeof id === 'string' && known.has(id));

/** The agent's diagnosis.json, keeping only claims whose every cited id exists in the evidence. */
export function validateDiagnosis(raw: unknown, known: Set<string>): Diagnosis {
  const d = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const dropped: string[] = [];
  const keep = (c: unknown): c is Claim => {
    if (isClaim(c, known)) return true;
    const text = (c as Claim | null)?.text;
    if (typeof text === 'string') dropped.push(text.slice(0, 200));
    return false;
  };
  const list = (v: unknown) => (Array.isArray(v) ? v : []).filter(keep).map((c) => ({ text: c.text, evidence: c.evidence }));
  const rc = d.rootCause as (Claim & { confidence?: string }) | undefined;
  const confidence: Confidence = rc && ['high', 'medium', 'low'].includes(rc.confidence ?? '') ? (rc.confidence as Confidence) : 'low';
  const fix = d.fix as { text?: unknown; commit?: unknown } | undefined;
  return {
    agent: typeof d.agent === 'string' ? d.agent.slice(0, 120) : 'unknown agent',
    rootCause: rc && keep(rc) ? { text: rc.text, evidence: rc.evidence, confidence } : null,
    summary: list(d.summary),
    hypotheses: list(d.hypotheses),
    unknowns: (Array.isArray(d.unknowns) ? d.unknowns : []).filter((u): u is string => typeof u === 'string').map((u) => u.slice(0, 400)),
    fix: fix && typeof fix.text === 'string' ? { text: fix.text, commit: typeof fix.commit === 'string' ? fix.commit : '' } : null,
    dropped,
  };
}
