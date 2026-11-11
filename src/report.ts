import type { Diagnosis } from './diagnosis.ts';
import type { Narrative } from './llm.ts';
import type { Evidence, Finding, Gathered } from './types.ts';
import type { VerifyResult } from './verify.ts';
import { redactText } from './redact.ts';

const inline = (s: string) => redactText(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/[\\`*_{}\[\]()#+!|~]/g, '\\$&').replace(/[\r\n]/g, ' ');
const cell = inline;
const code = (s: string) => {
  const safe = redactText(s).replace(/[\r\n]/g, ' ');
  const ticks = '`'.repeat(Math.max(1, ...[...safe.matchAll(/`+/g)].map((m) => m[0].length + 1)));
  const padded = safe.startsWith('`') || safe.endsWith('`') || (safe.startsWith(' ') && safe.endsWith(' ')) ? ` ${safe} ` : safe;
  return `${ticks}${padded}${ticks}`;
};

function cite(id: string, byId: Map<string, Evidence>): string {
  const e = byId.get(id);
  if (!e) return '[evidence unavailable]';
  const displayId = inline(id);
  let href = '';
  if (e.link && !/[\u0000-\u001f\u007f]/.test(e.link)) {
    try {
      const url = new URL(redactText(e.link));
      if (/^https?:$/.test(url.protocol) && !url.username && !url.password) href = url.href.replace(/[()]/g, (c) => c === '(' ? '%28' : '%29');
    } catch { href = ''; }
  }
  const ref = href ? `[${displayId}](${href})` : code(id);
  return `${ref} ${e.at ? `(${inline(e.at)}) ` : ''}${cell(e.summary.slice(0, 200))}`;
}

/** The report keeps every cited row, every non-log row, and only the warnings/failures among log lines. */
const codeCell = (s: string) => code(s).replace(/\|/g, '\\|');

function timelineRows(g: Gathered, findings: Finding[], narrative: Narrative | { error: string } | null, diagnosis: Diagnosis | null): Evidence[] {
  const diagnosisCitations = diagnosis ? [...(diagnosis.rootCause?.evidence ?? []), ...diagnosis.summary.flatMap((c) => c.evidence), ...diagnosis.hypotheses.flatMap((c) => c.evidence)] : [];
  const narrativeCitations = narrative && !('error' in narrative) ? [...narrative.summary.flatMap((c) => c.evidence), ...narrative.hypotheses.flatMap((c) => c.evidence)] : [];
  const cited = new Set([...findings.flatMap((f) => f.evidence), ...diagnosisCitations, ...narrativeCitations]);
  return g.evidence.filter(
    (e) => cited.has(e.id) || !['logs', 'archive'].includes(e.source) || ['http.5xx', 'http.4xx', 'log.error', 'log.warn'].includes(e.kind),
  ).sort((a, b) => {
    const normalize = (at: string | null) => at && /^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?$/.test(at) ? `${at}Z` : at;
    const atA = a.at ? Date.parse(normalize(a.at)!) : NaN;
    const atB = b.at ? Date.parse(normalize(b.at)!) : NaN;
    const time = Number.isFinite(atA) && Number.isFinite(atB) ? atA - atB : (a.at ?? '') < (b.at ?? '') ? -1 : (a.at ?? '') > (b.at ?? '') ? 1 : 0;
    return time || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  });
}

export function renderMarkdown(caseId: string, g: Gathered, findings: Finding[], narrative: Narrative | { error: string } | null, verify: VerifyResult[] = [], diagnosis: Diagnosis | null = null): string {
  const byId = new Map(g.evidence.map((e) => [e.id, e]));
  const out: string[] = [];
  const i = g.input;
  out.push(`# reprobe ${inline(caseId)}`, '');
  out.push(`> ${inline(i.complaint).replace(/\n/g, '\n> ')}`, '');
  const given = [i.trace && `trace ${code(i.trace)}`, i.user && `user ${code(i.user)}`, i.chat && `chat ${code(i.chat)}`, i.sentry && `sentry ${code(i.sentry)}`].filter(Boolean);
  out.push(`- **Input:** ${given.length ? given.join(', ') : 'complaint only'}`);
  out.push(`- **Window:** ${inline(g.window.from)} to ${inline(g.window.to)}`);
  const subject = g.subject.label ?? (g.subject.userId ? `user ${g.subject.userId}` : g.subject.sessionIds[0] ? `session ${g.subject.sessionIds[0]}` : 'not resolved');
  out.push(`- **Subject:** ${inline(subject)}${g.subject.how ? ` (${inline(g.subject.how)})` : ''}`);
  out.push(`- **Evidence:** ${g.evidence.length} items from ${[...new Set(g.evidence.map((e) => inline(e.source)))].sort().join(', ') || 'no source'}`, '');

  if (diagnosis) {
    const ids = (c: { evidence: string[] }) => c.evidence.map((id) => (byId.has(id) ? code(id) : '[evidence unavailable]')).join(' ');
    out.push('## Diagnosis', '', `_By ${cell(diagnosis.agent)}. Every claim below cites evidence ids that exist in evidence.json; ${diagnosis.dropped.length} claim(s) that did not were dropped._`, '');
    if (diagnosis.rootCause) {
      out.push(`**Root cause [${diagnosis.rootCause.confidence.toUpperCase()}]:** ${inline(diagnosis.rootCause.text)}`, '', 'Evidence:');
      for (const id of diagnosis.rootCause.evidence) out.push(`- ${cite(id, byId)}`);
      out.push('');
    } else out.push('No root cause survived citation checks.', '');
    for (const c of diagnosis.summary) out.push(`- ${inline(c.text)} ${ids(c)}`);
    if (diagnosis.hypotheses.length) {
      out.push('', 'Other hypotheses:');
      for (const c of diagnosis.hypotheses) out.push(`- ${inline(c.text)} ${ids(c)}`);
    }
    if (diagnosis.unknowns.length) {
      out.push('', 'Not known:');
      for (const u of diagnosis.unknowns) out.push(`- ${inline(u)}`);
    }
    if (diagnosis.fix) out.push('', `**Fix:** ${inline(diagnosis.fix.text)}${diagnosis.fix.commit ? ` (commit ${code(diagnosis.fix.commit)})` : ''}`);
    if (diagnosis.dropped.length) {
      out.push('', 'Dropped (no valid citation):');
      for (const t of diagnosis.dropped) out.push(`- ~~${cell(t)}~~`);
    }
    out.push('');
  }

  out.push(diagnosis ? '## Detector findings' : '## Likely root cause', '');
  if (!findings.length) out.push('No failure signature matched the evidence. Read the timeline and the source table: missing sources are the first thing to fix.', '');
  findings.forEach((f, n) => {
    out.push(`### ${n + 1}. [${f.confidence.toUpperCase()}] ${inline(f.title)}`, '');
    out.push(inline(f.rootCause), '');
    out.push('Evidence:');
    for (const id of f.evidence) out.push(`- ${cite(id, byId)}`);
    if (f.unknowns.length) {
      out.push('', 'Not known from the evidence:');
      for (const u of f.unknowns) out.push(`- ${inline(u)}`);
    }
    if (f.replay) {
      out.push('', `Replay: ${inline(f.replay.description)}.`);
      for (const file of f.replay.files) out.push(`- ${code(`replay/${file.path}`)} (${file.mode === 'append' ? 'appended to the existing file' : 'new file'})`);
      out.push(`- Run at any commit: ${code(`reprobe verify ${caseId} <commit>`)} (runs ${code(f.replay.command.join(' '))} in a detached worktree)`);
    }
    out.push('');
  });

  if (verify.length) {
    out.push('## Replay results', '', '| commit | sha | outcome | detail |', '|---|---|---|---|');
    for (const v of verify) out.push(`| ${cell(v.commit)} | ${cell(v.sha.slice(0, 10))} | **${cell(v.outcome.toUpperCase())}** | ${cell(v.detail)} |`);
    out.push('');
  }

  if (narrative || !diagnosis) out.push('## Summary', '');
  if (!narrative) {
    if (!diagnosis) out.push('No summary yet: run `reprobe agent <case>` to investigate with Claude Code or Codex, or pass `--summary` for a short cited LLM summary.');
  } else if ('error' in narrative) out.push(`LLM summary unavailable: ${inline(narrative.error)}. The findings above are deterministic and complete without it.`);
  else {
    out.push(`_Written by ${inline(narrative.model)}. Citation IDs are checked against the evidence list; claim accuracy is not independently verified. ${narrative.dropped.length} uncited claim(s) were dropped._`, '');
    for (const c of narrative.summary) out.push(`- ${inline(c.text)} ${c.evidence.map((id) => byId.has(id) ? code(id) : '[evidence unavailable]').join(' ')}`);
    if (narrative.hypotheses.length) {
      out.push('', 'Other hypotheses:');
      for (const c of narrative.hypotheses) out.push(`- ${inline(c.text)} ${c.evidence.map((id) => byId.has(id) ? code(id) : '[evidence unavailable]').join(' ')}`);
    }
  }
  out.push('');

  out.push('## Sources', '', '| source | state | detail |', '|---|---|---|');
  for (const s of [...g.sources].sort((a, b) => a.source < b.source ? -1 : a.source > b.source ? 1 : a.state < b.state ? -1 : a.state > b.state ? 1 : 0)) out.push(`| ${cell(s.source)} | ${s.state === 'ok' ? 'ok' : `**${s.state}**`} | ${cell(s.detail)} |`);
  out.push('');

  const rows = timelineRows(g, findings, narrative, diagnosis);
  out.push('## Timeline', '', `${rows.length} of ${g.evidence.length} items (all cited items, all DB/trace rows, and log warnings/failures). Everything is in \`evidence.json\`.`, '');
  out.push('| time (UTC) | source | what | id |', '|---|---|---|---|');
  for (const e of rows) out.push(`| ${e.at ? cell(e.at) : '-'} | ${cell(e.source)} | ${cell(e.summary.slice(0, 220))} | ${codeCell(e.id)} |`);
  out.push('');
  return out.join('\n');
}
