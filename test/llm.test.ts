import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt, narrate, validate } from '../src/llm.ts';
import type { Evidence, Finding, Gathered } from '../src/types.ts';

const T = '2026-09-08T17:16:00.000Z';
const ARCHIVE_ID = 'archive:2026-09-08T17:16:00.000Z:aaaaaaaaaa';
const ORDER_EVIDENCE_ID = 'db:Order:c111111111111111111111111';

test('validate keeps claims whose evidence exists and drops the rest', () => {
  const raw = JSON.stringify({
    summary: [
      { text: 'A', evidence: ['e1'] },
      { text: 'B', evidence: ['nope'] },
      { text: 'C', evidence: [] },
    ],
    hypotheses: [],
  });
  const result = validate(raw, new Set(['e1']));
  assert.deepEqual(result, {
    summary: [{ text: 'A', evidence: ['e1'] }],
    hypotheses: [],
    dropped: ['B', 'C'],
  });
});

test('validate parses JSON wrapped in prose', () => {
  const raw = 'here you go {"summary":[{"text":"A","evidence":["e1"]}],"hypotheses":[]} thanks';
  const result = validate(raw, new Set(['e1']));
  assert.deepEqual(result, {
    summary: [{ text: 'A', evidence: ['e1'] }],
    hypotheses: [],
    dropped: [],
  });
});

test('validate returns null for a reply that is not JSON', () => {
  assert.equal(validate('no json here at all', new Set(['e1'])), null);
});

test('validate safely rejects JSON null and drops a mixed known/unknown citation list', () => {
  assert.equal(validate('null', new Set(['e1'])), null);
  assert.deepEqual(
    validate(JSON.stringify({ summary: [{ text: 'Mixed', evidence: ['e1', 'invented'] }], hypotheses: [] }), new Set(['e1'])),
    { summary: [], hypotheses: [], dropped: ['Mixed'] },
  );
});

test('narrate contains runner failures and redacts errors and returned claims', async () => {
  const g: Gathered = {
    input: { complaint: 'issue', sinceMs: 1 },
    window: { from: T, to: T },
    subject: { sessionIds: [], traceIds: [] },
    sources: [],
    evidence: [{ id: 'e1', source: 'db', at: T, kind: 'x', summary: 'safe', data: {} }],
  };
  const failing = await narrate(g, [], async () => { throw new Error('request failed for person@example.com token=secretvalue123'); });
  assert.deepEqual(failing, { error: 'request failed for [email] token=[redacted]' });

  const stderrSecret = await narrate(g, [], async () => ({ code: 1, stdout: '', stderr: `${'x'.repeat(190)} password="secret suffix beyond report cap` }));
  assert.equal('error' in stderrSecret && stderrSecret.error.includes('secret suffix'), false);

  let cliArgs: string[] = [];
  const leaking = await narrate(g, [], async () => ({
    code: 0,
    stdout: JSON.stringify({ summary: [{ text: 'Call 9876543210', evidence: ['e1'] }], hypotheses: [] }),
    stderr: '',
  }));
  assert.equal('summary' in leaking && leaking.summary[0]?.text, 'Call [phone]');

  await narrate(g, [], async (_cmd, args) => {
    cliArgs = args;
    return { code: 1, stdout: '', stderr: '' };
  });
  assert.ok(cliArgs.includes('--tools') && cliArgs[cliArgs.indexOf('--tools') + 1] === '');
  assert.ok(cliArgs.includes('--disable-slash-commands'));
});

test('buildPrompt includes the complaint and every cited evidence id', () => {
  const complaint = 'my friend on app 155 was not seeing his groups';
  const evidence: Evidence[] = [
    { id: ARCHIVE_ID, source: 'archive', at: T, kind: 'http.5xx', summary: 'POST /orders/:id/confirm 500 (133ms)', data: {} },
    { id: ORDER_EVIDENCE_ID, source: 'db', at: T, kind: 'order', summary: 'order c111111111111111111111111 status EXPIRED', data: {} },
  ];
  const g: Gathered = {
    input: { complaint, sinceMs: 7_200_000 },
    window: { from: '2026-09-08T15:16:00.000Z', to: '2026-09-08T17:26:00.000Z' },
    subject: { userId: 'u-1', label: 'Test User', how: 'the reporter', sessionIds: [], traceIds: [] },
    sources: [],
    evidence,
  };
  const findings: Finding[] = [
    {
      signature: 'client-error-masked-as-500',
      title: 'POST /orders/:id/confirm answered 500 for a deliberate ForbiddenException',
      confidence: 'high',
      rootCause: 'synthetic root cause',
      evidence: [ARCHIVE_ID, ORDER_EVIDENCE_ID],
      unknowns: [],
    },
  ];
  const prompt = buildPrompt(g, findings);
  assert.ok(prompt.includes(`COMPLAINT: ${complaint}`));
  assert.ok(prompt.includes(ARCHIVE_ID));
  assert.ok(prompt.includes(ORDER_EVIDENCE_ID));
});

test('buildPrompt redacts raw source values even if caller did not sanitize gathered data', () => {
  const g: Gathered = {
    input: { complaint: 'call 9876543210 for me@example.com', sinceMs: 1 },
    window: { from: T, to: T },
    subject: { label: 'Test', how: 'token=opaque-secret-value', sessionIds: [], traceIds: [] },
    sources: [{ source: 'db', state: 'error', detail: 'password="correct horse battery staple"' }],
    evidence: [{ id: 'e1', source: 'db', at: T, kind: 'source', summary: 'email someone@example.com', data: { outputPreview: '{"access_token":"opaque-token"}' } }],
  };
  const prompt = buildPrompt(g, []);
  for (const secret of ['9876543210', 'me@example.com', 'opaque-secret-value', 'correct horse battery staple', 'someone@example.com', 'opaque-token']) {
    assert.equal(prompt.includes(secret), false, `prompt leaked ${secret}`);
  }
});
