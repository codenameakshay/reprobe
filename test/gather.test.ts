import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { anchorFromInput, gather, parseIntent, windowFor } from '../src/gather.ts';
import { buildConfig, setConfig } from '../src/config.ts';

test('parseIntent: failed save with a retry count', () => {
  const i = parseIntent('i was not able to save this order, i tried thrice');
  assert.equal(i.retries, 3);
  assert.equal(i.aboutOther, false);
  assert.equal(i.build, null);
});

test('parseIntent: a friend on app 155 reads the build and the other-person flag', () => {
  const i = parseIntent('my friend who is on the latest app 155 was not seeing his groups');
  assert.equal(i.build, '155');
  assert.equal(i.aboutOther, true);
  assert.equal(i.retries, null);
  assert.match(i.words, /groups/);
});

test('parseIntent: numeric and word retry counts', () => {
  assert.equal(parseIntent('i tried 2 times and it failed').retries, 2);
  assert.equal(parseIntent('it failed twice').retries, 2);
});

test('parseIntent: words holds the lowercased complaint for pack topic matching', () => {
  assert.equal(parseIntent('The Order GOT REMOVED').words, 'the order got removed');
});

test('anchorFromInput reads start_time from a LangSmith share URL', () => {
  const anchor = anchorFromInput({
    complaint: 'x',
    trace: 'https://smith.langchain.com/public/x/r/y?start_time=2026-07-28T08%3A44%3A36.147001Z',
    sinceMs: 1,
  });
  assert.equal(anchor, '2026-07-28T08:44:36.147Z');
});

test('anchorFromInput reads timestamp from a Langfuse URL', () => {
  const anchor = anchorFromInput({
    complaint: 'x',
    trace: 'https://langfuse.example.test/project/p1/traces/t1?timestamp=2026-08-26T07:28:40.904Z',
    sinceMs: 1,
  });
  assert.equal(anchor, '2026-08-26T07:28:40.904Z');
});

test('anchorFromInput ignores malformed percent escapes in a trace URL', () => {
  assert.doesNotThrow(() => anchorFromInput({ complaint: 'x', trace: 'https://example.test/?timestamp=%ZZ' }));
  assert.equal(anchorFromInput({ complaint: 'x', trace: 'https://example.test/?timestamp=%ZZ' }), null);
});

test('anchorFromInput: explicit at wins over a trace URL', () => {
  const anchor = anchorFromInput({
    complaint: 'x',
    at: '2026-09-01T00:00:00Z',
    trace: 'https://langfuse.example.test/project/p1/traces/t1?timestamp=2026-08-26T07:28:40.904Z',
    sinceMs: 1,
  });
  assert.equal(anchor, '2026-09-01T00:00:00.000Z');
});

test('windowFor: two hours back, ten minutes forward', () => {
  const w = windowFor('2026-09-08T17:28:07.000Z', 7_200_000);
  assert.equal(w.from, '2026-09-08T15:28:07.000Z');
  assert.equal(w.to, '2026-09-08T17:38:07.000Z');
});

test('gather records a failed subject hook and continues with unmodified input attribution', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'reprobe-gather-'));
  try {
    writeFileSync(join(dir, 'api.log'), '2026-09-08T16:30:00.000Z [info] request userId=partial-user\n');
    setConfig(buildConfig(null, { repo: dir, sources: { logs: [{ name: 'local', file: '*.log' }] } }));
    const gathered = await gather({ complaint: 'x', user: 'reporter-user', at: '2026-09-08T16:30:00Z', sinceMs: 60_000 }, {
      name: 'test-pack',
      async resolveSubject(ctx) {
        ctx.subject.userId = 'partial-user';
        ctx.logIds.push('partial-user');
        throw new Error('subject lookup failed');
      },
    });

    assert.equal(gathered.subject.userId, 'reporter-user');
    assert.deepEqual(gathered.subject.sessionIds, []);
    assert.ok(gathered.sources.some((s) => s.source === 'test-pack' && s.state === 'error' && /subject lookup failed/.test(s.detail)));
    assert.equal(gathered.evidence.length, 0);
    assert.ok(gathered.sources.some((s) => s.source === 'logs' && s.state === 'empty'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('gather isolates a Langfuse credential-resolution exception as a source error', async () => {
  setConfig(buildConfig(null, { sources: { langfuse: {
    baseUrl: { cmd: [] } as any,
    publicKey: 'public',
    secretKey: 'secret',
  } } }));
  const gathered = await gather({ complaint: 'x', trace: '0123456789abcdef0123456789abcdef', sinceMs: 60_000 }, null);
  assert.ok(gathered.sources.some((s) => s.source === 'langfuse' && s.state === 'error'));
  assert.equal(gathered.sources.filter((s) => s.source === 'langfuse').length, 1);
});
