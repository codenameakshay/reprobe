import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendEvidence, readAgentReplay } from '../src/case.ts';
import type { Gathered } from '../src/types.ts';

const gathered = (): Gathered => ({
  input: { complaint: 'x', sinceMs: 1 },
  window: { from: '2026-01-01T00:00:00.000Z', to: '2026-01-01T01:00:00.000Z' },
  subject: { sessionIds: [], traceIds: [] },
  sources: [],
  evidence: [{ id: 'db:b', source: 'db', at: '2026-01-01T00:30:00.000Z', kind: 'row', summary: 'later', data: {} }],
});

const replayJson = (files: unknown[]) => JSON.stringify({ description: 'd', cwd: 'server', command: ['npx', 'jest'], requires: [], marker: 'REPROBE_REPLAY:case1', files });

function withCase(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'reprobe-case-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('appendEvidence merges by id, keeps time order, and redacts phone numbers', () => {
  withCase((dir) => {
    writeFileSync(join(dir, 'evidence.json'), JSON.stringify(gathered()));
    const g = appendEvidence(dir, [
      { id: 'agent:a', source: 'agent', at: '2026-01-01T00:10:00.000Z', kind: 'tool', summary: 'called on +91 98765 43210', data: {} },
      { id: 'db:b', source: 'db', at: '2026-01-01T00:30:00.000Z', kind: 'row', summary: 'replaced', data: {} },
    ]);
    assert.deepEqual(g.evidence.map((e) => e.id), ['agent:a', 'db:b']);
    assert.equal(g.evidence[1].summary, 'replaced');
    assert.match(g.evidence[0].summary, /\[phone\]/);
    assert.equal(readFileSync(join(dir, 'evidence.json'), 'utf8').includes('98765 43210'), false);
  });
});

test('readAgentReplay returns null without replay.json', () => {
  withCase((dir) => {
    assert.equal(readAgentReplay(dir), null);
  });
});

test('readAgentReplay reads a from-file that stays inside the case dir', () => {
  withCase((dir) => {
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'x.spec.ts'), "console.log('REPROBE_REPLAY:case1:START');");
    writeFileSync(join(dir, 'replay.json'), replayJson([{ path: 'server/x.spec.ts', from: 'src/x.spec.ts' }]));
    const replay = readAgentReplay(dir);
    assert.ok(replay);
    assert.equal(replay.marker, 'REPROBE_REPLAY:case1');
    assert.equal(replay.cwd, 'server');
    assert.equal(replay.files[0].path, 'server/x.spec.ts');
    assert.equal(replay.files[0].content, "console.log('REPROBE_REPLAY:case1:START');");
    assert.equal(replay.files[0].mode, 'create');
  });
});

test('readAgentReplay throws when a from-file points outside the case dir', () => {
  withCase((root) => {
    const dir = join(root, 'case');
    mkdirSync(dir);
    writeFileSync(join(root, 'outside.txt'), 'outside the case');
    writeFileSync(join(dir, 'replay.json'), replayJson([{ path: 'server/x.spec.ts', from: '../outside.txt' }]));
    assert.throws(() => readAgentReplay(dir), /must stay inside the case dir/);
    writeFileSync(join(dir, 'replay.json'), replayJson([{ path: 'server/x.spec.ts', from: '../../etc/passwd' }]));
    assert.throws(() => readAgentReplay(dir));
  });
});

test('readAgentReplay rejects unsafe replay file paths', () => {
  withCase((dir) => {
    for (const path of ['../x', '/abs/x']) {
      writeFileSync(join(dir, 'replay.json'), replayJson([{ path, content: 'x' }]));
      assert.throws(() => readAgentReplay(dir), /unsafe replay file path/);
    }
  });
});
