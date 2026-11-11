import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gatherLangsmith, parseLangsmithShare } from '../src/sources/langsmith.ts';

const SHARE = '11111111-2222-4333-8444-555555555555';
const API = `https://api.smith.langchain.com/api/v1/public/${SHARE}`;
const WEB = `https://smith.langchain.com/public/${SHARE}/r`;

interface Call {
  url: string;
  method: string;
  body: string | undefined;
}

/** Fake fetch: records every call and answers from the handler. Never touches the network. */
function fakeFetch(handler: (call: Call) => Response | Promise<Response>): { impl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : undefined,
    };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return { impl, calls };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

const TOP = {
  id: 'top',
  name: 'supervisor',
  run_type: 'chain',
  status: 'error',
  error: 'boom',
  start_time: '2026-07-28T08:44:48.123456',
  end_time: '2026-07-28T08:44:51.000000',
  parent_run_id: null,
  inputs: { q: 'hi' },
  outputs: { output: [{ update: { messages: [{ tool_calls: [{ name: 'get_splits' }, { name: 'create_split' }] }] } }] },
};

const LISTED = [
  TOP, // same run as the top run: must not be emitted twice
  {
    id: 'run-c',
    name: 'ChatModel',
    run_type: 'llm',
    status: 'success',
    start_time: '2026-07-28T08:44:50+00:00',
    parent_run_id: 'top',
    inputs: null,
    outputs: null,
  },
  {
    id: 'run-b',
    name: 'search',
    run_type: 'tool',
    status: 'success',
    start_time: '2026-07-28T08:44:49',
    parent_run_id: 'top',
    inputs: {},
    outputs: { output: [{ update: { messages: [{ tool_calls: [{ name: 'search_splits' }] }] } }] },
  },
  {
    id: 'run-a',
    name: 'ChatModel',
    run_type: 'llm',
    status: 'success',
    start_time: '2026-07-28T08:44:49',
    parent_run_id: 'top',
    inputs: null,
    outputs: null,
  },
];

test('parseLangsmithShare extracts the share UUID from a share URL with a query string', () => {
  const url =
    `https://smith.langchain.com/public/${SHARE}/r/01900000-aaaa-7bbb-8ccc-dddddddddddd?start_time=2026-07-28T08:44:48Z`;
  assert.equal(parseLangsmithShare(url), SHARE);
});

test('parseLangsmithShare accepts a bare share UUID', () => {
  assert.equal(parseLangsmithShare(SHARE), SHARE);
  assert.equal(parseLangsmithShare(`  ${SHARE}\n`), SHARE);
});

test('parseLangsmithShare returns null for garbage', () => {
  for (const input of [
    '',
    'not a url',
    'https://example.com/foo',
    'https://smith.langchain.com/projects/abc',
    'https://smith.langchain.com/public/not-a-uuid/r/x',
  ]) {
    assert.equal(parseLangsmithShare(input), null, `input: ${JSON.stringify(input)}`);
  }
});

test('gatherLangsmith maps a 404 to expired with no evidence', async () => {
  const { impl, calls } = fakeFetch(() => json({ detail: 'Not Found' }, 404));
  const out = await gatherLangsmith(SHARE, impl);
  assert.deepEqual(out, {
    status: {
      source: 'langsmith',
      state: 'expired',
      detail: `share token not found (trace deleted, unshared, or past LangSmith retention): ${SHARE}`,
    },
    evidence: [],
  });
  assert.equal(calls.length, 1);
});

test('gatherLangsmith maps a network failure to unreachable with the error message', async () => {
  const { impl } = fakeFetch(() => {
    throw new TypeError('fetch failed');
  });
  const out = await gatherLangsmith(SHARE, impl);
  assert.deepEqual(out, {
    status: { source: 'langsmith', state: 'unreachable', detail: 'fetch failed' },
    evidence: [],
  });
});

test('gatherLangsmith maps other non-2xx to error with the HTTP code', async () => {
  const { impl } = fakeFetch(() => json({ detail: 'boom' }, 500));
  const out = await gatherLangsmith(SHARE, impl);
  assert.deepEqual(out, {
    status: { source: 'langsmith', state: 'error', detail: 'HTTP 500' },
    evidence: [],
  });
});

test('gatherLangsmith emits top run first, then listed runs sorted, with tool names', async () => {
  const { impl, calls } = fakeFetch((c) => (c.method === 'POST' ? json({ runs: LISTED }) : json(TOP)));
  const out = await gatherLangsmith(SHARE, impl);

  assert.deepEqual(out.status, { source: 'langsmith', state: 'ok', detail: '4 runs' });
  assert.deepEqual(
    out.evidence.map((e) => e.id),
    ['langsmith:run:top', 'langsmith:run:run-a', 'langsmith:run:run-b', 'langsmith:run:run-c'],
  );

  const [top, a, b, c] = out.evidence;
  assert.equal(top.source, 'langsmith');
  assert.equal(top.kind, 'langsmith.run');
  assert.equal(top.at, '2026-07-28T08:44:48.123456Z');
  assert.equal(top.summary, 'chain supervisor ERROR: boom tools=[get_splits,create_split]');
  assert.equal(top.link, WEB);
  assert.equal(a.at, '2026-07-28T08:44:49Z');
  assert.equal(a.summary, 'llm ChatModel');
  assert.equal(b.summary, 'tool search tools=[search_splits]');
  assert.equal(c.at, '2026-07-28T08:44:50+00:00');

  const data = top.data as { inputs_preview: string; outputs_preview: string; id: string };
  assert.equal(data.id, 'top');
  assert.equal(data.inputs_preview, '{"q":"hi"}');
  assert.ok(data.outputs_preview.includes('get_splits'));

  assert.equal(calls[0].url, `${API}/run`);
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[1].url, `${API}/runs/query`);
  assert.equal(calls[1].method, 'POST');
  assert.equal(calls[1].body, '{"limit":100}');
});

test('gatherLangsmith falls back to the single top run when the list call fails', async () => {
  const { impl } = fakeFetch((c) => (c.method === 'POST' ? json({ detail: 'nope' }, 500) : json(TOP)));
  const out = await gatherLangsmith(SHARE, impl);
  assert.deepEqual(out.status, { source: 'langsmith', state: 'ok', detail: '1 runs' });
  assert.deepEqual(
    out.evidence.map((e) => e.id),
    ['langsmith:run:top'],
  );
});
