import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detect, routeTemplate } from '../src/detectors.ts';
import type { Evidence, Gathered, Pack, Replay } from '../src/types.ts';

const T = '2026-09-08T17:16:00.000Z';
const atMs = (ms: number) => new Date(Date.parse(T) + ms).toISOString();
const marker = 'REPROBE_REPLAY:masked';

function gathered(complaint: string, evidence: Evidence[], subject: Partial<Gathered['subject']> = {}): Gathered {
  return {
    input: { complaint, sinceMs: 7_200_000 },
    window: { from: '2026-09-08T15:16:00.000Z', to: '2026-09-08T17:26:00.000Z' },
    subject: { userId: 'u-1', sessionIds: [], traceIds: [], ...subject },
    sources: [],
    evidence,
  };
}

const ROUTE_ID = 'cabcdefghijklmnopqrstuvwx';

function maskedEvidence(http500AtMs: number): Evidence[] {
  return [
    {
      id: 'archive:warn-roster',
      source: 'archive',
      at: T,
      kind: 'log.warn',
      summary: 'WARN [OrdersService] createOrder rejected — requester is not the owner',
      data: {
        at: T,
        text: 'WARN [OrdersService] createOrder rejected — requester is not the owner',
        level: 'warn',
        context: 'OrdersService',
        method: null,
        path: null,
        status: null,
        userId: null,
        clientVersion: null,
      },
    },
    {
      id: 'archive:forbidden',
      source: 'archive',
      at: T,
      kind: 'log.error',
      summary: "ERROR [ExceptionsHandler] ForbiddenException: You can only confirm your own order.",
      data: {
        at: T,
        text: "ERROR [ExceptionsHandler] ForbiddenException: You can only confirm your own order.",
        level: 'error',
        context: 'ExceptionsHandler',
        method: null,
        path: null,
        status: null,
        userId: null,
        clientVersion: null,
      },
    },
    {
      id: 'archive:http-500',
      source: 'archive',
      at: atMs(http500AtMs),
      kind: 'http.5xx',
      summary: `POST /orders/${ROUTE_ID}/confirm 500 (133ms)`,
      data: {
        at: atMs(http500AtMs),
        text: `LOG [HTTP] ❌ POST /orders/${ROUTE_ID}/confirm 500 — 133ms`,
        level: 'info',
        context: 'HTTP',
        method: 'POST',
        path: `/orders/${ROUTE_ID}/confirm`,
        status: 500,
        userId: 'u-1',
        clientVersion: '1.2.0+155',
      },
    },
  ];
}

const sentryEvidence = (): Evidence[] => [
  { id: 'sentry:api:1', source: 'sentry', at: T, kind: 'sentry.issue', summary: 'API-1 Recent crash (unresolved)', data: {}, link: 'https://acme.sentry.io/issues/1/' },
];

const bugReportEvidence = (): Evidence[] => [
  { id: 'db:BugReport:b1', source: 'db', at: atMs(20_000), kind: 'bug.report', summary: 'in-app bug report', data: { id: 'b1' } },
];

// ── routeTemplate ────────────────────────────────────────────────────────────

test('routeTemplate turns a cuid segment into :id', () => {
  assert.equal(routeTemplate('/orders/c111111111111111111111111/confirm'), '/orders/:id/confirm');
});

test('routeTemplate turns a uuid segment into :id', () => {
  assert.equal(routeTemplate('/groups/123e4567-e89b-12d3-a456-426614174000/members'), '/groups/:id/members');
});

// ── client-error-masked-as-500 ───────────────────────────────────────────────

test('client-error-masked-as-500 fires for a Forbidden that became a 500 within 2s, without a replay in core', () => {
  const g = gathered('createOrder failed and it said I am not allowed', maskedEvidence(100));
  const f = detect(g).find((x) => x.signature === 'client-error-masked-as-500');
  assert.ok(f);
  assert.ok(f.title.includes('/orders/:id/confirm'));
  assert.match(f.rootCause, /ForbiddenException \("You can only confirm/);
  assert.equal(f.replay, undefined);
});

test('client-error-masked-as-500 does not fire when the 500 is more than 2s away', () => {
  const g = gathered('createOrder failed and it said I am not allowed', maskedEvidence(3_000));
  const f = detect(g).find((x) => x.signature === 'client-error-masked-as-500');
  assert.equal(f, undefined);
});

test('client-error-masked-as-500 does not pair missing timestamps', () => {
  const evidence = maskedEvidence(100).map((e) => ({ ...e, at: null }));
  assert.equal(detect(gathered('createOrder failed and it said I am not allowed', evidence)).some((f) => f.signature === 'client-error-masked-as-500'), false);
});

test('one 500 near two different client exceptions is not attributed to either one', () => {
  const evidence = maskedEvidence(100);
  evidence.push({ ...evidence[1], id: 'archive:bad-request', summary: 'BadRequestException: Different failure', data: { ...evidence[1].data as object, text: 'ERROR [ExceptionsHandler] BadRequestException: Different failure' } });
  assert.equal(detect(gathered('I could not save this order', evidence)).some((f) => f.signature === 'client-error-masked-as-500'), false);
});

// ── pack hooks ───────────────────────────────────────────────────────────────

test('detect runs pack detectors and includes their findings beside the core ones', () => {
  const pack: Pack = {
    name: 'fake',
    detectors: [() => [{ signature: 'fake:thing', title: 'pack finding', confidence: 'medium', rootCause: 'from the pack', evidence: ['archive:warn-roster'], unknowns: [] }]],
  };
  const signatures = detect(gathered('createOrder failed', maskedEvidence(100)), pack).map((f) => f.signature);
  assert.ok(signatures.includes('fake:thing'));
  assert.ok(signatures.includes('client-error-masked-as-500'));
});

test('replayFor attaches a replay to the masked finding, which has none in core', () => {
  const replay: Replay = {
    description: 'masked 500 replay',
    cwd: 'server',
    command: ['npx', 'jest', '--runTestsByPath', 'src/replay.spec.ts'],
    requires: [],
    marker,
    kind: 'server-jest',
    files: [{ path: 'server/src/replay.spec.ts', mode: 'append', content: `console.log('${marker}:START');\n` }],
  };
  const pack: Pack = { name: 'fake', replayFor: (f) => (f.signature === 'client-error-masked-as-500' ? replay : undefined) };
  const f = detect(gathered('createOrder failed', maskedEvidence(100)), pack).find((x) => x.signature === 'client-error-masked-as-500');
  assert.equal(f?.replay, replay);
});

// ── anomalies ────────────────────────────────────────────────────────────────

test('anomalies are de-duplicated against evidence cited by non-anomaly findings', () => {
  const found = detect(gathered('createOrder failed', [...maskedEvidence(100), ...sentryEvidence()]));
  assert.deepEqual(found.map((f) => f.signature), ['client-error-masked-as-500', 'anomaly:sentry-issue']);
  const anomaly = found[1];
  assert.deepEqual(anomaly.evidence, ['sentry:api:1']);
  assert.equal(anomaly.title, '1 × sentry issue');
  for (const id of found[0].evidence) assert.equal(anomaly.evidence.includes(id), false);
});

test('findings are byte-stable when evidence arrives in a different order', () => {
  const evidence = [...maskedEvidence(100), ...bugReportEvidence()];
  const first = detect(gathered('the card vanished', evidence));
  const second = detect(gathered('the card vanished', [...evidence].reverse()));
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});

test('findings are ranked high confidence before low', () => {
  const findings = detect(gathered('createOrder failed', [...maskedEvidence(100), ...bugReportEvidence()]));
  assert.deepEqual(findings.map((f) => f.confidence), ['high', 'low']);
  assert.equal(findings[0].signature, 'client-error-masked-as-500');
  assert.equal(findings[1].signature, 'anomaly:in-app-bug-report');
});
