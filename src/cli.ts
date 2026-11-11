import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { launchAgent } from './agent.ts';
import { appendEvidence, caseDirFor, loadPack, readAgentReplay, readGathered } from './case.ts';
import { config, loadConfig } from './config.ts';
import { caseIdFor, detect } from './detectors.ts';
import { validateDiagnosis } from './diagnosis.ts';
import { doctor } from './doctor.ts';
import { retryingFetch } from './exec.ts';
import { gather } from './gather.ts';
import { writeInit } from './init.ts';
import { narrate, type Narrative } from './llm.ts';
import { redactText, redactValue } from './redact.ts';
import { renderMarkdown } from './report.ts';
import { fetchTrace, langfuseClient, parseLangfuseTrace } from './sources/langfuse.ts';
import { gatherLangsmith, parseLangsmithShare } from './sources/langsmith.ts';
import { gatherArchive, gatherLogs } from './sources/logs.ts';
import { connect } from './sources/postgres.ts';
import { gatherSentry } from './sources/sentry.ts';
import type { Check, Evidence, Finding, Gathered, Pack, Replay } from './types.ts';
import { cleanWorktrees, verifyReplay, type VerifyResult } from './verify.ts';

const USAGE = `reprobe "<complaint>" [--trace <langfuse|langsmith url or id>] [--user <id|phone|email>] [--chat <id>]
        [--sentry <issue>] [--since 2h] [--at <iso>] [--agent claude|codex|none] [--model <m>] [--summary]
    Gather evidence read-only, run the detectors, write a case, then hand it to your coding agent.

reprobe agent <case> [--agent claude|codex] [--model <m>] [--headless]   (re)start the agent on a case
reprobe init [--force]                                      detect sources and write .reprobe/config.json
reprobe doctor                                              check every source with a real read

Tools the agent uses (each appends citable evidence to the case):
reprobe query <case> "<SELECT ...>"                        one read-only query
reprobe logs <case> [--grep <text>]... [--since <iso>] [--until <iso>]
reprobe sentry <case> [--issue <id>] [--user <id>]
reprobe trace <case> <langfuse|langsmith url or id>
reprobe verify <case> <commit>...                         run the replay in a detached worktree per commit
reprobe report <case>                                      validate diagnosis.json citations, render report.md

reprobe analyze <case>     re-run detectors and the report from the saved evidence, offline
reprobe clean              remove reprobe's worktrees for this repo
Global: --config <path to .reprobe/config.json>`;

export function parseDuration(s: string): number {
  const m = s.trim().match(/^(\d+(?:\.\d+)?)\s*(m|min|h|d)$/i);
  if (!m) throw new Error(`bad duration "${s}" (use 30m, 2h, 3d)`);
  return Number(m[1]) * { m: 60_000, min: 60_000, h: 3_600_000, d: 86_400_000 }[m[2].toLowerCase() as 'm' | 'min' | 'h' | 'd'];
}

const say = (s: string) => process.stderr.write(`reprobe: ${redactText(s)}\n`);
const out = (s: string) => process.stdout.write(`${s}\n`);

export function formatDoctorCheck(c: Check): string {
  return `${c.ok ? 'ok  ' : c.required ? 'FAIL' : 'MISS'} ${redactText(c.name)}: ${redactText(c.detail)}${c.fix && !c.ok ? `\n     fix: ${redactText(c.fix)}` : ''}\n`;
}

function caseReplay(dir: string, g: Gathered, pack: Pack | null): Replay | undefined {
  return readAgentReplay(dir) ?? detect(g, pack).find((f) => f.replay)?.replay;
}

function readDiagnosis(dir: string, g: Gathered) {
  const file = join(dir, 'diagnosis.json');
  return existsSync(file) ? validateDiagnosis(JSON.parse(readFileSync(file, 'utf8')), new Set(g.evidence.map((e) => e.id))) : null;
}

function readVerify(dir: string): VerifyResult[] {
  const file = join(dir, 'verify.json');
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as VerifyResult[]) : [];
}

function write(dir: string, g: Gathered, findings: Finding[], narrative: Narrative | { error: string } | null, verify: VerifyResult[]) {
  const caseId = caseIdFor(g);
  const safe = redactValue({ g, findings, narrative, verify });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'evidence.json'), JSON.stringify(safe.g, null, 2));
  writeFileSync(join(dir, 'findings.json'), JSON.stringify({ caseId, subject: safe.g.subject, window: safe.g.window, sources: safe.g.sources, findings: safe.findings }, null, 2));
  for (const f of safe.findings) {
    for (const file of f.replay?.files ?? []) {
      const target = join(dir, 'replay', file.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.content);
    }
  }
  if (verify.length) writeFileSync(join(dir, 'verify.json'), JSON.stringify(safe.verify, null, 2));
  writeFileSync(join(dir, 'report.md'), renderMarkdown(caseId, safe.g, safe.findings, safe.narrative, safe.verify, readDiagnosis(dir, safe.g)));
}

export async function main(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      config: { type: 'string' },
      trace: { type: 'string' },
      user: { type: 'string' },
      chat: { type: 'string' },
      sentry: { type: 'string' },
      reporter: { type: 'string' },
      since: { type: 'string', default: '2h' },
      until: { type: 'string' },
      at: { type: 'string' },
      out: { type: 'string' },
      agent: { type: 'string' },
      model: { type: 'string' },
      summary: { type: 'boolean', default: false },
      'no-llm': { type: 'boolean', default: false },
      'no-agent': { type: 'boolean', default: false },
      headless: { type: 'boolean', default: false },
      verify: { type: 'string', multiple: true, default: [] },
      grep: { type: 'string', multiple: true, default: [] },
      issue: { type: 'string' },
      force: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [cmd, ...rest] = positionals;
  if (values.help || !cmd) return out(USAGE);
  loadConfig(values.config);

  if (cmd === 'init') {
    const { path, detected } = writeInit(config.repo, values.force!);
    out(`wrote ${path}`);
    for (const f of detected.found) out(`  found: ${f}`);
    for (const t of detected.todo) out(`  todo:  ${t}`);
    out('next: edit the todos, then `reprobe doctor`');
    return;
  }

  const pack = await loadPack();
  if (cmd === 'doctor') {
    const { checks, ok } = await doctor(pack);
    for (const c of checks) process.stdout.write(formatDoctorCheck(c));
    out(ok ? '\nrequired sources ready' : '\nrequired sources missing (see FAIL lines)');
    process.exitCode = ok ? 0 : 1;
    return;
  }
  if (cmd === 'clean') return out(`removed ${(await cleanWorktrees()).length} worktree(s)`);

  if (['agent', 'analyze', 'verify', 'report', 'query', 'logs', 'sentry', 'trace'].includes(cmd)) {
    if (!rest[0]) throw new Error(`${cmd} needs a case dir`);
    const dir = caseDirFor(rest[0]);
    const g = readGathered(dir);
    const add = (items: Evidence[], show: (e: Evidence) => string = (e) => `${e.at ?? '-'}  ${e.summary}`) => {
      appendEvidence(dir, items);
      if (!items.length) out('(nothing found)');
      for (const e of redactValue(items)) out(`[${e.id}] ${show(e)}`);
    };
    switch (cmd) {
      case 'agent': {
        process.exitCode = await launchAgent(dir, g, detect(g, pack), { agent: values.agent, model: values.model, headless: values.headless });
        return;
      }
      case 'analyze': {
        const findings = detect(g, pack);
        write(dir, g, findings, values.summary ? await narrate(g, findings) : null, readVerify(dir));
        return out(join(dir, 'report.md'));
      }
      case 'verify': {
        const replay = caseReplay(dir, g, pack);
        if (!replay) throw new Error('this case has no replay: write replay.json (see the playbook) or let a detector produce one');
        const results = await verifyReplay(dir, replay, rest.slice(1), pack, say);
        const kept = [...readVerify(dir).filter((v) => !results.some((r) => r.sha === v.sha)), ...results];
        writeFileSync(join(dir, 'verify.json'), JSON.stringify(redactValue(kept), null, 2));
        for (const v of results) out(`${v.commit} ${v.sha.slice(0, 10)} ${v.outcome.toUpperCase()} ${v.detail}\n  log: ${v.logFile}`);
        return;
      }
      case 'report': {
        write(dir, g, detect(g, pack), null, readVerify(dir));
        const d = readDiagnosis(dir, g);
        out(join(dir, 'report.md'));
        if (!d) out('no diagnosis.json yet: only detector findings are in the report');
        else out(`diagnosis: ${d.rootCause ? `[${d.rootCause.confidence}] ${d.rootCause.text.slice(0, 160)}` : 'no root cause survived citation checks'}; ${d.dropped.length} claim(s) dropped`);
        return;
      }
      case 'query': {
        const sql = rest[1];
        if (!sql) throw new Error('query needs SQL');
        const { db, status } = await connect();
        if (!db) throw new Error(`postgres: ${status.detail}`);
        const rows = await db.query(sql);
        const id = `query:${createHash('sha256').update(sql).digest('hex').slice(0, 10)}`;
        add([{ id, source: 'query', at: null, kind: 'query.rows', summary: `${rows.length} row(s) for: ${sql.replace(/\s+/g, ' ').slice(0, 160)}`, data: { sql, rows: rows.slice(0, 200), truncated: rows.length > 200 } }], (e) => e.summary);
        out(JSON.stringify(redactValue(rows.slice(0, 50)), null, 1).slice(0, 20_000));
        return;
      }
      case 'logs': {
        const w = { from: values.since && /^\d{4}-/.test(values.since) ? values.since : g.window.from, to: values.until ?? g.window.to };
        const ids = values.grep!.length ? values.grep! : [g.subject.userId, ...g.subject.sessionIds].filter((x): x is string => Boolean(x));
        const results = [...(await gatherLogs(w, ids)), await gatherArchive(w, ids)];
        for (const r of results) if (r.status.state !== 'ok') say(`${r.status.source} ${r.status.state}: ${r.status.detail}`);
        const lines = results.flatMap((r) => r.evidence).filter((e) => !values.grep!.length || values.grep!.some((t) => JSON.stringify(e.data).includes(t)));
        return add(lines);
      }
      case 'sentry': {
        const r = await gatherSentry({ window: g.window, userId: values.user ?? g.subject.userId, issue: values.issue });
        if (r.status.state !== 'ok') say(`sentry ${r.status.state}: ${r.status.detail}`);
        return add(r.evidence);
      }
      case 'trace': {
        const ref = rest[1];
        if (!ref) throw new Error('trace needs a Langfuse or LangSmith url or id');
        const lfId = parseLangfuseTrace(ref);
        const share = lfId ? null : parseLangsmithShare(ref);
        if (lfId) {
          const lf = await langfuseClient();
          if (!lf) throw new Error('langfuse is not configured or its keys did not resolve');
          const r = await fetchTrace(lf, lfId, pack?.observation);
          if (r.status.state !== 'ok') say(`langfuse ${r.status.state}: ${r.status.detail}`);
          return add(r.evidence);
        }
        if (!share) throw new Error('not a Langfuse trace or a LangSmith share link');
        const r = await gatherLangsmith(share, retryingFetch());
        if (r.status.state !== 'ok') say(`langsmith ${r.status.state}: ${r.status.detail}`);
        return add(r.evidence);
      }
    }
  }

  const g = await gather(
    { complaint: cmd, trace: values.trace, user: values.user, chat: values.chat, sentry: values.sentry, reporter: values.reporter, at: values.at, sinceMs: parseDuration(values.since!) },
    pack,
    say,
  );
  const dir = resolve(values.out ?? config.casesDir, caseIdFor(g));
  const findings = detect(g, pack);
  const summary = values.summary && !values['no-llm'] ? (say('asking the LLM for a cited summary'), await narrate(g, findings)) : null;
  const replay = findings.find((f) => f.replay)?.replay;
  mkdirSync(dir, { recursive: true });
  const verify = values.verify!.length && replay ? await verifyReplay(dir, replay, values.verify!, pack, say) : [];
  write(dir, g, findings, summary, verify);
  const top = findings[0];
  out(join(dir, 'report.md'));
  out(top ? `top: [${top.confidence}] ${top.title}${top.replay ? `\nreplay: ${top.replay.files.map((f) => f.path).join(', ')}` : ''}` : 'no signature matched');
  for (const v of verify) out(`verify ${v.commit}: ${v.outcome.toUpperCase()} ${v.detail}`);

  const wantAgent = !values['no-agent'] && values.agent !== 'none' && process.stdin.isTTY && process.stdout.isTTY;
  if (wantAgent) process.exitCode = await launchAgent(dir, g, findings, { agent: values.agent, model: values.model });
  else out(`next: reprobe agent ${dir}`);
}

const fail = (e: unknown) => {
  process.stderr.write(`reprobe: ${redactText((e as Error)?.message ?? String(e))}\n`);
  process.exitCode = 2;
};

export const run = (argv: string[]) => main(argv).catch(fail);

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void run(process.argv.slice(2));
