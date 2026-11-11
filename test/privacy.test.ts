import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { formatDoctorCheck } from '../src/cli.ts';
import type { Gathered } from '../src/types.ts';

const REPO = resolve(import.meta.dirname, '..');
const T = '2026-09-08T17:16:00.000Z';
const ORDER_ID = 'order-example-1';
const rawValues = [
  'privacy.person+case@example.com',
  '+1 415 555 2671',
  'opaque_token_value_BUGREPRO_83f40c9b',
  'https://logs.example.test/archive?X-Amz-Credential=PRIVATE%2F2026%2Fkey&X-Amz-Signature=signature-value-123',
];

function fixture(): Gathered {
  return {
    input: {
      complaint: `The groceries card vanished; contact ${rawValues[0]} at ${rawValues[1]}`,
      sinceMs: 7_200_000,
    },
    window: { from: '2026-09-08T15:16:00.000Z', to: '2026-09-08T17:26:00.000Z' },
    subject: { userId: 'u-1', sessionIds: ['s1'], traceIds: ['t1'] },
    sources: [],
    evidence: [
      {
        id: `db:Order:${ORDER_ID}`,
        source: 'db',
        at: T,
        kind: 'order',
        summary: `order ${ORDER_ID} "Example group order · amount 302 · 3 participants" status EXPIRED; contact ${rawValues[0]} ${rawValues[1]}`,
        data: {
          id: ORDER_ID,
          status: 'EXPIRED',
          sessionId: 's1',
          summary: 'Example group order · amount 302 · 3 participants',
          confirmedAt: null,
          rejectedAt: null,
          createdAt: T,
          access_token: rawValues[2],
          downloadUrl: rawValues[3],
        },
      },
      {
        id: 'db:Message:m2',
        source: 'db',
        at: '2026-09-08T17:16:10.000Z',
        kind: 'chat.assistant',
        summary: 'assistant completed the turn without order metadata',
        data: { sessionId: 's1', role: 'assistant', content: 'Here is your split', metadataKeys: [], orderIdsInMetadata: [], hasOrders: false },
      },
      {
        id: 'db:AgentRun:r1',
        source: 'db',
        at: '2026-09-08T17:15:50.000Z',
        kind: 'agent.run',
        summary: 'agent run for s1',
        data: { id: 'r1', sessionId: 's1' },
      },
      {
        id: 'db:AgentStep:step1',
        source: 'db',
        at: '2026-09-08T17:15:55.000Z',
        kind: 'agent.step',
        summary: 'order returned by propose_order',
        data: { runId: 'r1', orderIds: [ORDER_ID], tools: ['propose_order'] },
      },
    ],
  };
}

function artifactFiles(dir: string): string[] {
  const paths: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) paths.push(...artifactFiles(path));
    else paths.push(path);
  }
  return paths;
}

function analyze(caseDir: string): void {
  execFileSync(process.execPath, ['src/cli.ts', 'analyze', caseDir, '--no-llm'], {
    cwd: REPO,
    stdio: 'pipe',
  });
}

test('analyze sanitizes saved evidence and generated artifacts, and is stable on rerun', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'reprobe-privacy-'));
  const caseDir = join(tempDir, 'case');
  try {
    mkdirSync(caseDir);
    writeFileSync(join(caseDir, 'evidence.json'), JSON.stringify(fixture(), null, 2));

    analyze(caseDir);
    const firstFindings = readFileSync(join(caseDir, 'findings.json'));
    const files = artifactFiles(caseDir);
    assert.ok(files.some((path) => path.endsWith('report.md')));
    assert.ok(files.some((path) => path.endsWith('findings.json')));
    assert.ok(files.some((path) => path.endsWith('evidence.json')));
    for (const path of files) {
      const content = readFileSync(path, 'utf8');
      for (const raw of rawValues) assert.equal(content.includes(raw), false, `${raw} leaked into ${path}`);
    }

    analyze(caseDir);
    assert.deepEqual(readFileSync(join(caseDir, 'findings.json')), firstFindings, 'rerunning analyze should preserve findings byte-for-byte');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('doctor check output redacts sensitive source details and fixes', () => {
  const line = formatDoctorCheck({
    ok: false,
    name: 'langfuse',
    detail: `credential URL ${rawValues[3]} and ${rawValues[0]} ${rawValues[1]}`,
    fix: `set access_token=${rawValues[2]}`,
  });
  for (const raw of rawValues) assert.equal(line.includes(raw), false, `${raw} leaked in doctor output`);
  assert.match(line, /^MISS langfuse:/);
});
