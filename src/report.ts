import type { Diagnosis } from './diagnosis.ts';
import type { Narrative } from './llm.ts';
import type { Evidence, Finding, Gathered } from './types.ts';
import type { VerifyResult } from './verify.ts';

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

function cite(id: string, byId: Map<string, Evidence>): string {
  const e = byId.get(id);
  if (!e) return '[evidence unavailable]';
  const ref = e.link ? `[${id}](${e.link.startsWith('/') ? `file://${e.link}` : e.link})` : `\`${id}\``;
  return `${ref} ${e.at ? `(${e.at}) ` : ''}${cell(e.summary.slice(0, 200))}`;
}

/** The report keeps every cited row, every non-log row, and only the warnings/failures among log lines. */
function timelineRows(g: Gathered, findings: Finding[]): Evidence[] {
  const cited = new Set(findings.flatMap((f) => f.evidence));
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
  out.push(`# reprobe ${caseId}`, '');
  out.push(`> ${i.complaint.replace(/\n/g, '\n> ')}`, '');
  const given = [i.trace && `trace \`${i.trace}\``, i.user && `user \`${i.user}\``, i.chat && `chat \`${i.chat}\``, i.sentry && `sentry \`${i.sentry}\``].filter(Boolean);
  out.push(`- **Input:** ${given.length ? given.join(', ') : 'complaint only'}`);
  out.push(`- **Window:** ${g.window.from} to ${g.window.to}`);
  const subject = g.subject.label ?? (g.subject.userId ? `user ${g.subject.userId}` : g.subject.sessionIds[0] ? `session ${g.subject.sessionIds[0]}` : 'not resolved');
  out.push(`- **Subject:** ${subject}${g.subject.how ? ` (${g.subject.how})` : ''}`);
  out.push(`- **Evidence:** ${g.evidence.length} items from ${[...new Set(g.evidence.map((e) => e.source))].sort().join(', ') || 'no source'}`, '');

  if (diagnosis) {
    const ids = (c: { evidence: string[] }) => c.evidence.map((id) => (byId.has(id) ? `\`${id}\`` : '[evidence unavailable]')).join(' ');
    out.push('## Diagnosis', '', `_By ${cell(diagnosis.agent)}. Every claim below cites evidence ids that exist in evidence.json; ${diagnosis.dropped.length} claim(s) that did not were dropped._`, '');
    if (diagnosis.rootCause) {
      out.push(`**Root cause [${diagnosis.rootCause.confidence.toUpperCase()}]:** ${diagnosis.rootCause.text}`, '', 'Evidence:');
      for (const id of diagnosis.rootCause.evidence) out.push(`- ${cite(id, byId)}`);
      out.push('');
    } else out.push('No root cause survived citation checks.', '');
    for (const c of diagnosis.summary) out.push(`- ${c.text} ${ids(c)}`);
    if (diagnosis.hypotheses.length) {
      out.push('', 'Other hypotheses:');
      for (const c of diagnosis.hypotheses) out.push(`- ${c.text} ${ids(c)}`);
    }
    if (diagnosis.unknowns.length) {
      out.push('', 'Not known:');
      for (const u of diagnosis.unknowns) out.push(`- ${u}`);
    }
    if (diagnosis.fix) out.push('', `**Fix:** ${diagnosis.fix.text}${diagnosis.fix.commit ? ` (commit \`${diagnosis.fix.commit}\`)` : ''}`);
    if (diagnosis.dropped.length) {
      out.push('', 'Dropped (no valid citation):');
      for (const t of diagnosis.dropped) out.push(`- ~~${cell(t)}~~`);
    }
    out.push('');
  }

  out.push(diagnosis ? '## Detector findings' : '## Likely root cause', '');
  if (!findings.length) out.push('No failure signature matched the evidence. Read the timeline and the source table: missing sources are the first thing to fix.', '');
  findings.forEach((f, n) => {
    out.push(`### ${n + 1}. [${f.confidence.toUpperCase()}] ${f.title}`, '');
    out.push(f.rootCause, '');
    out.push('Evidence:');
    for (const id of f.evidence) out.push(`- ${cite(id, byId)}`);
    if (f.unknowns.length) {
      out.push('', 'Not known from the evidence:');
      for (const u of f.unknowns) out.push(`- ${u}`);
    }
    if (f.replay) {
      out.push('', `Replay: ${f.replay.description}.`);
      for (const file of f.replay.files) out.push(`- \`replay/${file.path}\` (${file.mode === 'append' ? 'appended to the existing file' : 'new file'})`);
      out.push(`- Run at any commit: \`reprobe verify ${caseId} <commit>\` (runs \`${f.replay.command.join(' ')}\` in a detached worktree)`);
    }
    out.push('');
  });

  if (verify.length) {
    out.push('## Replay results', '', '| commit | sha | outcome | detail |', '|---|---|---|---|');
    for (const v of verify) out.push(`| ${cell(v.commit)} | ${v.sha.slice(0, 10)} | **${v.outcome.toUpperCase()}** | ${cell(v.detail)} |`);
    out.push('');
  }

  if (narrative || !diagnosis) out.push('## Summary', '');
  if (!narrative) {
    if (!diagnosis) out.push('No summary yet: run `reprobe agent <case>` to investigate with Claude Code or Codex, or pass `--summary` for a short cited LLM summary.');
  } else if ('error' in narrative) out.push(`LLM summary unavailable: ${narrative.error}. The findings above are deterministic and complete without it.`);
  else {
    out.push(`_Written by ${narrative.model}. Citation IDs are checked against the evidence list; claim accuracy is not independently verified. ${narrative.dropped.length} uncited claim(s) were dropped._`, '');
    for (const c of narrative.summary) out.push(`- ${c.text} ${c.evidence.map((id) => byId.has(id) ? `\`${id}\`` : '[evidence unavailable]').join(' ')}`);
    if (narrative.hypotheses.length) {
      out.push('', 'Other hypotheses:');
      for (const c of narrative.hypotheses) out.push(`- ${c.text} ${c.evidence.map((id) => byId.has(id) ? `\`${id}\`` : '[evidence unavailable]').join(' ')}`);
    }
  }
  out.push('');

  out.push('## Sources', '', '| source | state | detail |', '|---|---|---|');
  for (const s of [...g.sources].sort((a, b) => a.source < b.source ? -1 : a.source > b.source ? 1 : a.state < b.state ? -1 : a.state > b.state ? 1 : 0)) out.push(`| ${s.source} | ${s.state === 'ok' ? 'ok' : `**${s.state}**`} | ${cell(s.detail)} |`);
  out.push('');

  const rows = timelineRows(g, findings);
  out.push('## Timeline', '', `${rows.length} of ${g.evidence.length} items (all cited items, all DB/trace rows, and log warnings/failures). Everything is in \`evidence.json\`.`, '');
  out.push('| time (UTC) | source | what | id |', '|---|---|---|---|');
  for (const e of rows) out.push(`| ${e.at ?? '-'} | ${e.source} | ${cell(e.summary.slice(0, 220))} | \`${e.id}\` |`);
  out.push('');
  return out.join('\n');
}
