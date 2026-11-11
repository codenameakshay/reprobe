import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retryingFetch } from '../src/exec.ts';

const noSleep = async () => {};

test('retryingFetch retries a 429 and returns the later 200', async () => {
  const statuses = [429, 429, 200];
  const seen: number[] = [];
  const fake = (async () => {
    const status = statuses.shift()!;
    seen.push(status);
    return new Response('{}', { status, headers: status === 429 ? { 'retry-after': '1' } : {} });
  }) as typeof fetch;
  const res = await retryingFetch(fake, 5, noSleep)('https://x');
  assert.equal(res.status, 200);
  assert.deepEqual(seen, [429, 429, 200]);
});

test('retryingFetch returns a 404 at once', async () => {
  let calls = 0;
  const fake = (async () => {
    calls++;
    return new Response('', { status: 404 });
  }) as typeof fetch;
  const res = await retryingFetch(fake, 5, noSleep)('https://x');
  assert.equal(res.status, 404);
  assert.equal(calls, 1);
});

test('retryingFetch gives up after the last attempt and returns that response', async () => {
  let calls = 0;
  const fake = (async () => {
    calls++;
    return new Response('', { status: 503 });
  }) as typeof fetch;
  const res = await retryingFetch(fake, 3, noSleep)('https://x');
  assert.equal(res.status, 503);
  assert.equal(calls, 3);
});

test('retryingFetch retries a network error', async () => {
  let calls = 0;
  const fake = (async () => {
    calls++;
    if (calls < 2) throw new Error('ECONNRESET');
    return new Response('', { status: 200 });
  }) as typeof fetch;
  assert.equal((await retryingFetch(fake, 3, noSleep)('https://x')).status, 200);
});
