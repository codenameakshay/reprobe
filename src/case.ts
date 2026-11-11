import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { config } from './config.ts';
import { redactValue } from './redact.ts';
import type { Evidence, Gathered, Pack, Replay } from './types.ts';
import { assertSafeRelativePath } from './verify.ts';

export function caseDirFor(arg: string): string {
  if (existsSync(join(arg, 'evidence.json'))) return resolve(arg);
  const inCases = join(config.casesDir, arg);
  if (existsSync(join(inCases, 'evidence.json'))) return inCases;
  throw new Error(`no case at ${arg} or ${inCases}`);
}

export function readGathered(dir: string): Gathered {
  return redactValue(JSON.parse(readFileSync(join(dir, 'evidence.json'), 'utf8')) as Gathered);
}

/** Tool calls the agent makes during an investigation become citable evidence in the same case. */
export function appendEvidence(dir: string, items: Evidence[]): Gathered {
  const g = readGathered(dir);
  const byId = new Map(g.evidence.map((e) => [e.id, e]));
  for (const e of redactValue(items)) byId.set(e.id, e);
  g.evidence = [...byId.values()].sort((a, b) => (a.at ?? '').localeCompare(b.at ?? '') || a.id.localeCompare(b.id));
  writeFileSync(join(dir, 'evidence.json'), JSON.stringify(g, null, 2));
  return g;
}

function within(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * replay.json, written by the agent: like a Replay, but each file may give `from` (a path inside the
 * case dir) instead of inline `content`.
 */
export function readAgentReplay(dir: string): Replay | null {
  const file = join(dir, 'replay.json');
  if (!existsSync(file)) return null;
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Omit<Replay, 'files'> & { files: Array<{ path: string; from?: string; content?: string; mode?: 'create' | 'append' }> };
  const caseRoot = realpathSync(dir);
  const files = (raw.files ?? []).map((f) => {
    assertSafeRelativePath(f.path, 'replay file');
    let content = f.content;
    if (typeof content !== 'string') {
      if (typeof f.from !== 'string') throw new Error(`replay file ${f.path} needs content or from`);
      const src = realpathSync(resolve(dir, f.from));
      if (!within(caseRoot, src)) throw new Error(`replay file ${f.path}: "from" must stay inside the case dir`);
      content = readFileSync(src, 'utf8');
    }
    return { path: f.path, content, mode: f.mode === 'append' ? ('append' as const) : ('create' as const) };
  });
  return { description: String(raw.description ?? 'agent-written replay'), files, cwd: raw.cwd ?? '.', command: raw.command, requires: raw.requires ?? [], marker: raw.marker, kind: raw.kind };
}

export async function loadPack(): Promise<Pack | null> {
  if (!config.pack) return null;
  const mod = await import(pathToFileURL(config.pack).href);
  const pack = (mod.default ?? mod.pack) as Pack | undefined;
  if (!pack || typeof pack.name !== 'string') throw new Error(`${config.pack} must export default { name, ... }`);
  return pack;
}
