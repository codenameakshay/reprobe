import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { config } from './config.ts';
import { run } from './exec.ts';
import { redactText } from './redact.ts';
import type { Finding, Gathered } from './types.ts';
import { assertSafeCheckoutPath } from './verify.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
/** How the agent calls reprobe back: this exact install and config, so it works under npx too. */
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export const reprobeCmd = () =>
  `${shellQuote(process.execPath)} --no-warnings ${shellQuote(join(HERE, import.meta.url.endsWith('.ts') ? 'cli.ts' : 'cli.js'))}${config.file ? ` --config ${shellQuote(config.file)}` : ''}`;

interface Agent {
  id: 'claude' | 'codex';
  label: string;
}
const AGENTS: Agent[] = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
];

export function caseContext(dir: string, g: Gathered, findings: Finding[], headless = false): string {
  const bad = g.sources.filter((s) => s.state !== 'ok');
  return redactText([
    `# reprobe case ${dir.split('/').pop()}`,
    '',
    `- Complaint: ${JSON.stringify(g.input.complaint)}`,
    `- Case dir: ${dir}`,
    `- Repo (code that ran): ${config.repo}`,
    `- Window: ${g.window.from} to ${g.window.to}`,
    `- Subject: ${g.subject.label ?? g.subject.userId ?? 'not resolved'}${g.subject.how ? ` (${g.subject.how})` : ''}`,
    `- Evidence: ${g.evidence.length} items in evidence.json; timeline and sources in report.md`,
    `- Sources not ok: ${bad.length ? bad.map((s) => `${s.source} ${s.state}`).join(', ') : 'none'}`,
    `- Detector findings: ${findings.length ? findings.slice(0, 5).map((f) => `[${f.confidence}] ${f.title}${f.replay ? ' (has a replay)' : ''}`).join('; ') : 'none matched'}`,
    `- Configured sources: ${Object.entries(config.sources).filter(([, v]) => v).map(([k]) => k).join(', ') || 'none (run reprobe init)'}`,
    '',
    'Wherever the playbook writes `$REPROBE`, run exactly this command (copy it literally, do not use a shell variable):',
    '',
    `    ${reprobeCmd()}`,
    '',
    `and wherever it writes <case>, use \`${dir}\`.`,
    '',
    ...(headless
      ? ['**Headless run:** nobody is watching this session. Do not ask questions and do not offer to write a fix; where the playbook says to ask, state your assumption under `unknowns` in diagnosis.json. Finish with steps 5 and 7.', '']
      : []),
    '---',
    '',
    readFileSync(join(ROOT, 'PLAYBOOK.md'), 'utf8'),
  ].join('\n'));
}

async function installed(): Promise<Agent[]> {
  const out: Agent[] = [];
  for (const a of AGENTS) if ((await run(a.id, ['--version'], { timeoutMs: 15_000 })).code === 0) out.push(a);
  return out;
}

async function pick(agents: Agent[]): Promise<Agent> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    for (;;) {
      const answer = (await rl.question(`Investigate with:\n${agents.map((a, i) => `  [${i + 1}] ${a.label}`).join('\n')}\n> `)).trim().toLowerCase();
      const hit = agents[Number.parseInt(answer, 10) - 1] ?? agents.find((a) => a.id === answer);
      if (hit) return hit;
    }
  } finally {
    rl.close();
  }
}

/**
 * Like `t3 triage`: write the context + playbook into the case, start the engineer's own agent CLI
 * in the repo with one line pointing at it, and fall back to "paste this" when no agent is installed.
 */
export async function launchAgent(dir: string, g: Gathered, findings: Finding[], opts: { agent?: string; model?: string; headless?: boolean }): Promise<number> {
  const casePath = join(dir, 'CASE.md');
  writeFileSync(assertSafeCheckoutPath(dir, 'CASE.md'), caseContext(dir, g, findings, opts.headless));
  const have = await installed();
  let agent: Agent | undefined;
  if (opts.agent) {
    agent = have.find((a) => a.id === opts.agent);
    if (!agent) throw new Error(`${opts.agent} is not installed or not on PATH`);
  } else if (have.length === 1) agent = have[0];
  else if (have.length > 1) {
    if (!process.stdin.isTTY || !process.stderr.isTTY) throw new Error('both claude and codex are installed and there is no terminal to ask: pass --agent claude or --agent codex');
    agent = await pick(have);
  }
  if (!agent) {
    process.stderr.write(`No agent CLI (claude, codex) found. Paste this into any coding agent, opened in ${config.repo}:\n\n  Read ${casePath} and follow it.\n\n`);
    return 0;
  }
  const prompt = `Read the file ${JSON.stringify(casePath)} and follow it exactly: it is a production bug investigation playbook with the case context at the top.`;
  const args = [...(opts.model ? ['--model', opts.model] : [])];
  if (opts.headless) {
    if (agent.id !== 'claude') throw new Error('headless runs support claude only for now');
    // Headless means no one approves tool calls, so the agent gets exactly the tools the playbook needs:
    // read the code, read git history, write inside the case dir, and run this reprobe.
    // The prompt goes right after -p: --allowedTools is variadic and swallows any argument after it.
    args.push('-p', prompt, '--output-format', 'text', '--allowedTools', headlessTools(dir).join(','));
  } else args.push(prompt);
  process.stderr.write(`Starting ${agent.label}${opts.headless ? ' (headless)' : ''} in ${config.repo}.\n`);
  return new Promise((resolveExit, reject) => {
    const child = spawn(agent.id, args, { cwd: config.repo, stdio: opts.headless ? ['ignore', 'inherit', 'inherit'] : 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolveExit(code ?? (signal ? 1 : 0)));
  });
}

export function headlessTools(dir: string): string[] {
  return [
    'Read',
    'Grep',
    'Glob',
    ...['show', 'log', 'diff', 'grep', 'blame', 'rev-parse', 'ls-tree', 'cat-file'].map((c) => `Bash(git ${c}:*)`),
    ...['query', 'logs', 'sentry', 'trace', 'verify', 'report'].map((c) => `Bash(${reprobeCmd()} ${c}:*)`),
    // Edit rules cover every file-writing tool; `//` marks an absolute path.
    `Edit(/${dir}/**)`,
  ];
}
