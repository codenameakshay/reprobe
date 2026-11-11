import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, readVerify, replayFingerprint, writeReplayFiles } from '../src/cli.ts';
import type { Finding, Replay } from '../src/types.ts';

const replay = (content: string): Replay => ({
  description: 'fixture',
  cwd: '.',
  command: ['node', 'test.js'],
  requires: [],
  marker: 'REPROBE_REPLAY:fixture',
  files: [{ path: 'test.js', content }],
});

test('analysis replay file writes reject traversal before joining paths', () => {
  const base = mkdtempSync(join(tmpdir(), 'reprobe-cli-replay-'));
  const dir = join(base, 'case');
  const outside = join(dir, 'evidence.json');
  try {
    mkdirSync(dir);
    writeFileSync(outside, 'case evidence sentinel');
    const finding = {
      signature: 'test',
      confidence: 'high',
      title: 'fixture',
      why: 'fixture',
      evidence: [],
      replay: { ...replay('safe'), files: [{ path: '../evidence.json', content: 'escaped' }] },
    } as Finding;
    assert.throws(() => writeReplayFiles(dir, [finding]), /unsafe replay file path/);
    assert.equal(readFileSync(outside, 'utf8'), 'case evidence sentinel');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('saved verify outcomes are shown only for the exact replay fingerprint', () => {
  const dir = mkdtempSync(join(tmpdir(), 'reprobe-cli-verify-'));
  const current = replay('current test');
  const old = replay('old test');
  try {
    writeFileSync(join(dir, 'verify.json'), JSON.stringify([
      { commit: 'old', sha: 'old-sha', outcome: 'fail', detail: 'old replay failed', logFile: 'old.log', replayFingerprint: replayFingerprint(old) },
      { commit: 'current', sha: 'current-sha', outcome: 'pass', detail: 'current replay passed', logFile: 'current.log', replayFingerprint: replayFingerprint(current) },
    ]));
    assert.deepEqual(readVerify(dir, current).map(({ commit }) => commit), ['current']);
    assert.deepEqual(readVerify(dir, old).map(({ commit }) => commit), ['old']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('report refuses a symlinked report sink without touching its target', async () => {
  const base = mkdtempSync(join(tmpdir(), 'reprobe-cli-report-link-'));
  const dir = join(base, 'case');
  const external = join(base, 'source.txt');
  try {
    mkdirSync(dir);
    writeFileSync(join(dir, 'evidence.json'), JSON.stringify({
      input: { complaint: 'x', sinceMs: 1 },
      window: { from: '2026-01-01T00:00:00.000Z', to: '2026-01-01T00:00:01.000Z' },
      subject: { sessionIds: [], traceIds: [] },
      sources: [],
      evidence: [],
    }));
    writeFileSync(external, 'source sentinel');
    symlinkSync(external, join(dir, 'report.md'));
    await assert.rejects(main(['report', dir]), /refusing symlinked checkout path/);
    assert.equal(readFileSync(external, 'utf8'), 'source sentinel');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('initial gather redacts a pack finding title printed to stdout', async () => {
  const base = mkdtempSync(join(tmpdir(), 'reprobe-cli-top-redaction-'));
  const savedWrite = process.stdout.write;
  let stdout = '';
  try {
    const repo = join(base, 'repo');
    mkdirSync(repo);
    const packPath = join(base, 'pack.mjs');
    writeFileSync(packPath, `export default {name:'fixture',async gather(ctx){ctx.evidence.push({id:'fixture',source:'fixture',at:null,kind:'fixture',summary:'fixture',data:{}})},detectors:[()=>[{signature:'fixture',confidence:'high',title:'password=private-value',rootCause:'fixture',evidence:['fixture'],unknowns:[]}]]};`);
    const configPath = join(base, 'config.json');
    writeFileSync(configPath, JSON.stringify({ repo, pack: packPath }));
    process.stdout.write = ((chunk: string | Uint8Array) => { stdout += chunk.toString(); return true; }) as typeof process.stdout.write;
    await main(['fixture complaint', '--config', configPath, '--out', join(base, 'cases'), '--no-agent']);
    assert.match(stdout, /top: \[high\] password=\[redacted\]/);
    assert.doesNotMatch(stdout, /private-value/);
  } finally {
    process.stdout.write = savedWrite;
    rmSync(base, { recursive: true, force: true });
  }
});
