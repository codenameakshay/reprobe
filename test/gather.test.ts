import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anchorFromInput, parseIntent, windowFor } from '../src/gather.ts';

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
