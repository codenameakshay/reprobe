import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildConfig, firstLine, resolveSecret, setConfig } from '../src/config.ts';
import type { Runner } from '../src/exec.ts';
import { fetchTrace, findTraceIds, type LangfuseClient } from '../src/sources/langfuse.ts';
import { gatherLangsmith } from '../src/sources/langsmith.ts';

const TRACE = '0123456789abcdef0123456789abcdef';
const SHARE = '11111111-2222-4333-8444-555555555555';

const answer = (stdout: string, calls?: string[][]): Runner => async (cmd, args) => {
  calls?.push([cmd, ...args]);
  return { code: 0, stdout, stderr: '' };
};

test('source previews redact sensitive object properties before flattening them', async () => {
  const langfuse: LangfuseClient = {
    base: 'https://langfuse.example',
    async get() {
      return {
        status: 200,
        body: {
          data: [{
            id: 'obs-1', traceId: TRACE, type: 'GENERATION', name: 'test', startTime: '2026-01-01T00:00:00Z',
            input: { client_secret: 'lf-private-value' }, output: { client_secret: 'lf-private-value' },
          }],
        },
      };
    },
  };
  const lf = await fetchTrace(langfuse, TRACE);
  const outputPreview = (lf.evidence[1].data as { outputPreview: string }).outputPreview;
  assert.equal(outputPreview, '{"client_secret":"[redacted]"}');

  const ls = await gatherLangsmith(SHARE, (async () => new Response(JSON.stringify({
    id: 'run-1', inputs: { client_secret: 'ls-private-value' },
  }))) as typeof fetch);
  const inputsPreview = (ls.evidence[0].data as { inputs_preview: string }).inputs_preview;
  assert.equal(inputsPreview, '{"client_secret":"[redacted]"}');
});

test('Langfuse search encodes identity values as query parameters', async () => {
  const calls: string[] = [];
  const client: LangfuseClient = {
    base: 'https://langfuse.example',
    async get(path) {
      calls.push(path);
      return { status: 200, body: { data: [] } };
    },
  };
  await findTraceIds(client, { from: '2026-01-01T00:00:00Z', to: '2026-01-02T00:00:00Z' }, 'user&limit=1');
  const url = new URL(calls[0], client.base);
  assert.equal(url.searchParams.get('userId'), 'user&limit=1');
  assert.equal(url.searchParams.get('limit'), '200');
});

test('firstLine removes known secret-shaped values from command errors', () => {
  assert.doesNotMatch(firstLine('request failed token=sk-lf-123456789abcdef'), /sk-lf-123456789abcdef/);
});

test('resolveSecret reads an env: reference when the variable is set', async () => {
  process.env.REPROBE_TEST_SECRET_SET = 'env-value';
  try {
    setConfig(buildConfig(null, {}));
    assert.deepEqual(await resolveSecret('env:REPROBE_TEST_SECRET_SET'), { value: 'env-value', detail: 'env:REPROBE_TEST_SECRET_SET' });
  } finally {
    delete process.env.REPROBE_TEST_SECRET_SET;
  }
});

test('resolveSecret reports an unset env: reference as null with the variable name', async () => {
  delete process.env.REPROBE_TEST_SECRET_UNSET;
  setConfig(buildConfig(null, {}));
  assert.deepEqual(await resolveSecret('env:REPROBE_TEST_SECRET_UNSET'), { value: null, detail: 'REPROBE_TEST_SECRET_UNSET is not set' });
});

test('resolveSecret keeps a literal string as the value and says it is inline', async () => {
  setConfig(buildConfig(null, {}));
  assert.deepEqual(await resolveSecret('postgres://u:p@h/d'), { value: 'postgres://u:p@h/d', detail: 'inline value in config' });
});

test('resolveSecret takes a cmd reference stdout as the value', async () => {
  setConfig(buildConfig(null, {}));
  assert.deepEqual(await resolveSecret({ cmd: ['vault', 'read', 'plain-case'] }, answer('plain-secret\n')), { value: 'plain-secret', detail: '`vault`' });
});

test('resolveSecret with kv picks the matching line', async () => {
  setConfig(buildConfig(null, {}));
  const out = await resolveSecret({ cmd: ['vault', 'kv-case'], kv: 'TOKEN' }, answer('FOO=1\nTOKEN=abc\n'));
  assert.equal(out.value, 'abc');
});

test('resolveSecret with json picks the named key', async () => {
  setConfig(buildConfig(null, {}));
  const out = await resolveSecret({ cmd: ['vault', 'json-case'], json: 'access' }, answer('{"access":"tok-json","other":"x"}'));
  assert.equal(out.value, 'tok-json');
});

test('resolveSecret returns null with a redacted detail when the command fails', async () => {
  setConfig(buildConfig(null, {}));
  const failing: Runner = async () => ({ code: 1, stdout: '', stderr: 'boom token=sk-lf-123456789abcdef\nmore' });
  const out = await resolveSecret({ cmd: ['vault', 'fail-case'] }, failing);
  assert.equal(out.value, null);
  assert.match(out.detail, /vault failed: boom/);
  assert.doesNotMatch(out.detail, /sk-lf-123456789abcdef/);
});

test('resolveSecret substitutes {repo} in command arguments', async () => {
  setConfig(buildConfig(null, { repo: '/work/app' }));
  const calls: string[][] = [];
  const out = await resolveSecret({ cmd: ['vault', '{repo}/secrets.json', 'repo-case'] }, answer('ok', calls));
  assert.equal(out.value, 'ok');
  assert.deepEqual(calls[0], ['vault', '/work/app/secrets.json', 'repo-case']);
});

test('resolveSecret caches a successful value so a second resolve does not run the command', async () => {
  setConfig(buildConfig(null, {}));
  const calls: string[][] = [];
  const ref = { cmd: ['vault', 'cache-case'] };
  const first = await resolveSecret(ref, answer('cached', calls));
  const second = await resolveSecret(ref, answer('cached', calls));
  assert.equal(first.value, 'cached');
  assert.equal(second.value, 'cached');
  assert.equal(calls.length, 1);
});

test('resolveSecret does not cache a failure, so a later call can recover', async () => {
  setConfig(buildConfig(null, {}));
  const ref = { cmd: ['vault', 'retry-case'] };
  const failed = await resolveSecret(ref, async () => ({ code: 1, stdout: '', stderr: 'temporarily unavailable' }));
  const recovered = await resolveSecret(ref, answer('recovered'));
  assert.equal(failed.value, null);
  assert.equal(recovered.value, 'recovered');
});
