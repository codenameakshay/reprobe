import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendEvidence, readAgentReplay, readGathered } from '../src/case.ts';
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
    const appended = appendEvidence(dir, [
      { id: 'agent:a', source: 'agent', at: '2026-01-01T00:10:00.000Z', kind: 'tool', summary: 'called on +91 98765 43210', data: {} },
      { id: 'db:c', source: 'db', at: '2026-01-01T00:30:00.000Z', kind: 'row', summary: 'new row', data: {} },
    ]);
    assert.deepEqual(appended.map((e) => e.id), ['agent:a', 'db:c']);
    assert.deepEqual(readGathered(dir).evidence.map((e) => e.id), ['agent:a', 'db:b', 'db:c']);
    assert.match(appended[0].summary, /\[phone\]/);
    assert.equal(readFileSync(join(dir, 'evidence.json'), 'utf8').includes('98765 43210'), false);
  });
});

test('appendEvidence versions conflicting retry ids without mutating input and is idempotent', () => {
  withCase((dir) => {
    writeFileSync(join(dir, 'evidence.json'), JSON.stringify(gathered()));
    const retry = [{ id: 'db:b', source: 'db', at: '2026-01-01T00:30:00.000Z', kind: 'row', summary: 'different retry result', data: {} }];
    const original = structuredClone(retry);
    const appended = appendEvidence(dir, retry);
    assert.equal(readGathered(dir).evidence[0].summary, 'later');
    assert.deepEqual(retry, original, 'caller-owned tool results stay unchanged');
    const version = appended[0];
    assert.ok(version);
    assert.notEqual(version.id, 'db:b');
    const repeated = appendEvidence(dir, retry);
    assert.equal(readGathered(dir).evidence.filter((e) => e.summary === 'different retry result').length, 1);
    assert.equal(repeated[0].id, version.id);
    assert.deepEqual(retry, original);
  });
});

test('appendEvidence resolves a hash-suffix collision without overwriting prior evidence', () => {
  withCase((dir) => {
    const item = { id: 'db:b', source: 'db', at: '2026-01-01T00:30:00.000Z', kind: 'row', summary: 'new colliding result', data: {} };
    const suffix = createHash('sha256').update(JSON.stringify(item)).digest('hex').slice(0, 10);
    const existingCollision = { ...item, id: `db:b~${suffix}`, summary: 'pre-existing different payload' };
    const initial = gathered();
    initial.evidence.push(existingCollision);
    writeFileSync(join(dir, 'evidence.json'), JSON.stringify(initial));
    const added = appendEvidence(dir, [item])[0];
    const g = readGathered(dir);
    assert.equal(g.evidence.find((e) => e.id === existingCollision.id)?.summary, 'pre-existing different payload');
    assert.equal(added.id, `${existingCollision.id}-1`);
    const repeated = appendEvidence(dir, [item]);
    assert.equal(readGathered(dir).evidence.filter((e) => e.summary === 'new colliding result').length, 1);
    assert.equal(repeated[0].id, added.id);
  });
});

test('appendEvidence refuses a symlinked evidence sink without changing its target', () => {
  withCase((dir) => {
    const external = join(dir, 'external.json');
    writeFileSync(external, JSON.stringify(gathered()));
    symlinkSync(external, join(dir, 'evidence.json'));
    assert.throws(() => appendEvidence(dir, [{ id: 'new', source: 'test', at: null, kind: 'x', summary: 'x', data: {} }]), /refusing symlinked checkout path/);
    assert.deepEqual(JSON.parse(readFileSync(external, 'utf8')), gathered());
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

test('readAgentReplay permits dot-dot-prefixed names that remain inside the case dir', () => {
  withCase((dir) => {
    mkdirSync(join(dir, '..safe'));
    writeFileSync(join(dir, '..safe', 'x.spec.ts'), 'const example = "fixture";');
    writeFileSync(join(dir, 'replay.json'), replayJson([{ path: 'server/x.spec.ts', from: '..safe/x.spec.ts' }]));
    const replay = readAgentReplay(dir);
    assert.equal(replay?.files[0].content, 'const example = "fixture";');
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
