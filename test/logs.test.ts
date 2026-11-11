import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildConfig, setConfig } from '../src/config.ts';
import { gatherArchive, gatherLogs, globRegex, inWindow, mergeContinuations, parseLogLine, relevant, type LogLine } from '../src/sources/logs.ts';

const W = { from: '2026-09-08T15:00:00.000Z', to: '2026-09-08T17:00:00.000Z' };

function logLine(over: Partial<LogLine> = {}): LogLine {
  return {
    at: '2026-07-28T08:43:34.107Z',
    text: '',
    level: 'info',
    context: null,
    method: null,
    path: null,
    status: null,
    userId: null,
    clientVersion: null,
    ...over,
  };
}

const NEST_ERROR_PLAIN =
  '2026-07-28T08:43:34.107Z [info] [Nest] 1  - 07/28/2026, 8:43:34 AM   ERROR [OrderConfirmService] ForbiddenException: You can only confirm';

test('parseLogLine reads a Railway JSON request line', () => {
  const l = parseLogLine(
    '{"timestamp":"2026-09-08T17:16:10.131Z","event":"request_completed","method":"GET","path":"/groups/abc","statusCode":200,"userId":"u-1","clientVersion":"1.2.0+155","message":""}',
  );
  assert.ok(l);
  assert.equal(l.method, 'GET');
  assert.equal(l.path, '/groups/abc');
  assert.equal(l.status, 200);
  assert.equal(l.userId, 'u-1');
  assert.equal(l.clientVersion, '1.2.0+155');
  assert.equal(l.at, '2026-09-08T17:16:10.131Z');
});

test('parseLogLine reads a Nest ERROR line: level and context', () => {
  const l = parseLogLine(NEST_ERROR_PLAIN);
  assert.ok(l);
  assert.equal(l.level, 'error');
  assert.equal(l.context, 'OrderConfirmService');
});

test('parseLogLine still reads level error when colour codes lost their ESC byte', () => {
  const l = parseLogLine(
    '2026-07-28T08:43:34.107Z [info] [Nest] 1  - 07/28/2026, 8:43:34 AM   [31m ERROR[39m [OrderConfirmService] ForbiddenException: You can only confirm',
  );
  assert.ok(l);
  assert.equal(l.level, 'error');
  assert.equal(l.context, 'OrderConfirmService');
});

test('parseLogLine reads method and status from a Nest HTTP summary line', () => {
  const l = parseLogLine(
    '2026-07-28T08:43:34.107Z [info] [Nest] 1 - 07/28/2026, 8:43:34 AM   LOG [HTTP] ❌ POST /orders/cabc/confirm 500 — 133ms',
  );
  assert.ok(l);
  assert.equal(l.method, 'POST');
  assert.equal(l.status, 500);
});

test('parseLogLine returns null for a non-log line', () => {
  assert.equal(parseLogLine('just some text with no timestamp'), null);
});

test('parseLogLine ignores malformed calendar timestamps instead of throwing', () => {
  assert.equal(parseLogLine('2026-99-88T17:16:10Z [info] impossible date'), null);
  assert.equal(parseLogLine('{"timestamp":"not-a-date","message":"bad clock"}'), null);
});

test('parseLogLine normalizes timezone-less ISO timestamps as UTC', () => {
  const l = parseLogLine('{"timestamp":"2026-09-08T17:16:10.131","message":"clock"}');
  assert.ok(l);
  assert.equal(l.at, '2026-09-08T17:16:10.131Z');
});

test('mergeContinuations folds same-timestamp continuation rows into the line that started them', () => {
  const start = logLine({ at: '2026-07-28T08:43:34.107Z', text: 'ERROR [OrderConfirmService] ForbiddenException: You can only confirm', level: 'error' });
  const c1 = logLine({ at: '2026-07-28T08:43:34.107Z', text: 'at Foo.bar (x.js:1:1)' });
  const c2 = logLine({ at: '2026-07-28T08:43:34.107Z', text: 'status: 403,' });
  const later = logLine({ at: '2026-07-28T08:43:35.000Z', text: 'ERROR [OrderConfirmService] ForbiddenException: again', level: 'error' });
  const out = mergeContinuations([start, c1, c2, later]);
  assert.equal(out.length, 2);
  assert.equal(out[0].text, 'ERROR [OrderConfirmService] ForbiddenException: You can only confirm | at Foo.bar (x.js:1:1) | status: 403,');
  assert.ok(out[0].text.includes(' | '));
  assert.ok(out[0].text.includes('at Foo.bar (x.js:1:1)'));
  assert.ok(out[0].text.includes('status: 403,'));
  assert.equal(out[1].at, '2026-07-28T08:43:35.000Z');
  assert.equal(out[1].text, 'ERROR [OrderConfirmService] ForbiddenException: again');
});

test('mergeContinuations keeps distinct same-timestamp context, level, and user events separate', () => {
  const at = '2026-07-28T08:43:34.107Z';
  const out = mergeContinuations([
    logLine({ at, text: 'worker failed', level: 'error', context: 'WorkerA', userId: 'u-1' }),
    logLine({ at, text: 'worker failed elsewhere', level: 'error', context: 'WorkerB', userId: 'u-1' }),
    logLine({ at, text: 'retry started', level: 'warn', userId: 'u-2' }),
  ]);
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((line) => line.text), ['worker failed', 'worker failed elsewhere', 'retry started']);
});

test('mergeContinuations folds parsed Nest stack rows without context into their error', () => {
  const start = parseLogLine('2026-09-08T16:00:00.000Z [error] ERROR [OrdersService] ForbiddenException: no');
  const stack = parseLogLine('2026-09-08T16:00:00.000Z [info] at Foo.bar (x.js:1:1)');
  assert.ok(start);
  assert.ok(stack);
  assert.equal(start.context, 'OrdersService');
  assert.equal(stack.context, null);
  const merged = mergeContinuations([start, stack]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].text, `${start.text} | ${stack.text}`);
});

test('relevant keeps warnings', () => {
  assert.equal(relevant(logLine({ level: 'warn', text: 'LOG [X] something odd' }), ['u-1']), true);
});

test('relevant drops an info 200 line for another user', () => {
  const l = logLine({
    text: 'request_completed GET /groups/abc 200 clientVersion=1.2.0+155 userId=u-2',
    method: 'GET',
    path: '/groups/abc',
    status: 200,
    userId: 'u-2',
    clientVersion: '1.2.0+155',
  });
  assert.equal(relevant(l, ['u-1']), false);
});

test('relevant keeps an info line that carries a shortened id of the subject', () => {
  const l = logLine({ text: 'LOG [X] requester=abcdef12… created an order' });
  assert.equal(relevant(l, ['abcdef12-0000-0000-0000-000000000000']), true);
});

test('inWindow is inclusive at both boundaries', () => {
  const w = { from: '2026-09-08T15:00:00.000Z', to: '2026-09-08T17:00:00.000Z' };
  assert.equal(inWindow('2026-09-08T15:00:00.000Z', w), true);
  assert.equal(inWindow('2026-09-08T17:00:00.000Z', w), true);
  assert.equal(inWindow('2026-09-08T14:59:59.999Z', w), false);
  assert.equal(inWindow('2026-09-08T17:00:00.001Z', w), false);
  assert.equal(inWindow('2026-09-08T17:00:00+00:00', w), true);
  assert.equal(inWindow('2026-09-08T19:00:00+02:00', w), true);
  assert.equal(inWindow('2026-09-08T19:00:00', w), false);
});

test('globRegex matches * as any run of characters and treats . as a literal dot', () => {
  assert.equal(globRegex('*myapp*').test('-Users-x-myapp-y'), true);
  assert.equal(globRegex('a.b*').test('axbc'), false);
  assert.equal(globRegex('a.b*').test('a.bc'), true);
});

test('gatherLogs with no log sources returns one skipped status', async () => {
  setConfig(buildConfig(null, {}));
  const out = await gatherLogs(W, [], async () => {
    throw new Error('no command must run');
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].status.state, 'skipped');
  assert.deepEqual(out[0].evidence, []);
});

test('gatherLogs reports a malformed railway deployment response as a prefixed source error', async () => {
  setConfig(buildConfig(null, { sources: { logs: [{ name: 'api', railway: { service: 'api' } }] } }));
  const [result] = await gatherLogs(W, [], async () => ({ code: 0, stdout: '{"deployments":[]}', stderr: '' }));
  assert.equal(result.status.state, 'error');
  assert.match(result.status.detail, /^api: .*invalid JSON or deployment list shape/);
  assert.deepEqual(result.evidence, []);
});

test('gatherLogs keeps successful railway deployment logs when another deployment fails', async () => {
  setConfig(buildConfig(null, { sources: { logs: [{ name: 'api', railway: { service: 'api' } }] } }));
  const seen: string[][] = [];
  const [result] = await gatherLogs(W, ['u-1'], async (_cmd, args) => {
    seen.push(args);
    if (args[0] === 'deployment') {
      return {
        code: 0,
        stdout: JSON.stringify([
          { id: 'failed-deployment', createdAt: '2026-09-08T14:00:00.000Z' },
          { id: 'good-deployment', createdAt: '2026-09-08T16:00:00.000Z' },
        ]),
        stderr: '',
      };
    }
    if (args[1] === 'failed-deployment') return { code: 1, stdout: '', stderr: 'temporary fetch failure' };
    return {
      code: 0,
      stdout: '{"timestamp":"2026-09-08T16:30:00.000Z","event":"request_completed","method":"GET","path":"/groups","statusCode":200,"userId":"u-1","message":""}',
      stderr: '',
    };
  });
  assert.equal(result.status.state, 'ok');
  assert.equal(result.evidence.length, 1);
  assert.match(result.status.detail, /^api: /);
  assert.match(result.status.detail, /failed: failed-d/);
  assert.ok(seen.every((args) => Array.isArray(args)));
  assert.ok(seen[0].includes('--json'));
});

test('gatherLogs distinguishes an empty recent railway window from expired retained logs', async () => {
  setConfig(buildConfig(null, { sources: { logs: [{ name: 'api', railway: { service: 'api' } }] } }));
  const now = Date.now();
  const recent = { from: new Date(now - 60_000).toISOString(), to: new Date(now).toISOString() };
  const old = { from: '2020-01-01T00:00:00.000Z', to: '2020-01-01T01:00:00.000Z' };
  let deploymentLists = 0;
  const run = async (_cmd: string, args: string[]) => args[0] === 'deployment'
    ? { code: 0, stdout: JSON.stringify([{ id: 'deployment-1', createdAt: new Date(deploymentLists++ === 0 ? now - 120_000 : Date.parse('2019-12-31T23:00:00Z')).toISOString() }]), stderr: '' }
    : { code: 0, stdout: '', stderr: '' };
  const [empty] = await gatherLogs(recent, [], run);
  assert.equal(empty.status.state, 'empty');
  assert.match(empty.status.detail, /no relevant lines/);
  const [expired] = await gatherLogs(old, [], run);
  assert.equal(expired.status.state, 'expired');
  assert.match(expired.status.detail, /retention/);
});

test('gatherLogs reads a command source with {since} and {until} substituted and parses its lines', async () => {
  setConfig(buildConfig(null, { sources: { logs: [{ name: 'fly', command: ['fly', 'logs', '--since', '{since}', '--until', '{until}'] }] } }));
  const calls: string[][] = [];
  const [result] = await gatherLogs(W, ['u-1'], async (cmd, args) => {
    calls.push([cmd, ...args]);
    return { code: 0, stdout: '2026-09-08T16:30:00.000Z [error] boom for u-1\n', stderr: '' };
  });
  assert.deepEqual(calls[0], ['fly', 'logs', '--since', W.from, '--until', W.to]);
  assert.equal(result.status.state, 'ok');
  assert.match(result.status.detail, /^fly: 1 relevant lines/);
  assert.equal(result.evidence.length, 1);
  assert.equal(result.evidence[0].kind, 'log.error');
});

test('gatherLogs rejects an unsafe window before substituting it into command arguments', async () => {
  setConfig(buildConfig(null, { sources: { logs: [{ name: 'shell-wrapper', command: ['sh', '-c', 'provider --since {since} --until {until}'] }] } }));
  let calls = 0;
  const out = await gatherLogs({ from: '2026-09-08T15:00:00Z; touch /tmp/nope', to: W.to }, [], async () => {
    calls++;
    return { code: 0, stdout: '', stderr: '' };
  });
  assert.equal(calls, 0);
  assert.equal(out[0].status.state, 'error');
  assert.match(out[0].status.detail, /invalid log window/);
});

test('gatherLogs reads a file source from the repo and keeps only relevant lines', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'reprobe-logs-'));
  try {
    writeFileSync(join(dir, 'api.log'), '2026-09-08T16:30:00.000Z [error] disk full\n2026-09-08T16:31:00.000Z [info] fine\n');
    setConfig(buildConfig(null, { repo: dir, sources: { logs: [{ name: 'local', file: '*.log' }] } }));
    const [result] = await gatherLogs(W, []);
    assert.equal(result.status.state, 'ok');
    assert.match(result.status.detail, /^local: 1 relevant lines from 1 file\(s\)/);
    assert.equal(result.evidence.length, 1);
    assert.equal(result.evidence[0].summary, 'disk full');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('gatherLogs isolates a directory matched by a file glob and retains readable files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'reprobe-logs-'));
  try {
    writeFileSync(join(dir, 'api.log'), '2026-09-08T16:30:00.000Z [error] disk full\n');
    mkdirSync(join(dir, 'nested'));
    setConfig(buildConfig(null, { repo: dir, sources: { logs: [{ name: 'local', file: '*' }] } }));
    const [result] = await gatherLogs(W, []);
    assert.equal(result.status.state, 'ok');
    assert.match(result.status.detail, /failed: nested:/);
    assert.equal(result.evidence.length, 1);
    assert.equal(result.evidence[0].summary, 'disk full');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('gatherArchive is skipped when the config has no archive source', async () => {
  setConfig(buildConfig(null, {}));
  const result = await gatherArchive(W, [], async () => {
    throw new Error('rg must not run');
  });
  assert.deepEqual(result, { status: { source: 'archive', state: 'skipped', detail: 'no archive source in the config' }, evidence: [] });
});

test('gatherArchive reports search failures instead of disguising them as an empty archive', async () => {
  setConfig(buildConfig(null, { sources: { archive: { dir: join(tmpdir(), 'reprobe-no-such-archive'), glob: '*' } } }));
  const result = await gatherArchive(W, [], async () => ({ code: 2, stdout: '', stderr: 'permission denied' }));
  assert.equal(result.status.state, 'error');
  assert.match(result.status.detail, /permission denied/);
  assert.deepEqual(result.evidence, []);
});

test('gatherArchive parses only tool_result output from matching transcript rows', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'reprobe-archive-'));
  const project = join(dir, 'project-myapp');
  const file = join(project, 'session.jsonl');
  mkdirSync(project);
  try {
    setConfig(buildConfig(null, { sources: { archive: { dir, glob: '*myapp*' } } }));
    const assistantOnly = '2026-09-08T16:00:00.000Z [error] assistant prose userId=u-1';
    const output = '{"timestamp":"2026-09-08T16:30:00.000Z","event":"request_completed","method":"GET","path":"/groups","statusCode":200,"userId":"u-1","message":""}';
    const fabricatedResult = '2026-09-08T16:15:00.000Z [error] assistant-supplied tool result userId=u-1';
    writeFileSync(file, [
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: assistantOnly }, { type: 'tool_result', content: fabricatedResult }] } }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: output }] } }),
    ].join('\n') + '\n');
    const result = await gatherArchive(W, ['u-1'], async (_cmd, args) => {
      assert.equal(args[0], '-l');
      assert.equal(args.includes(dir), true);
      return { code: 0, stdout: `${file}\n`, stderr: '' };
    });
    assert.equal(result.status.state, 'ok');
    assert.match(result.status.detail, /original command and source are unverified/);
    assert.equal(result.evidence.length, 1);
    assert.match(result.evidence[0].summary, /request_completed GET \/groups 200/);
    assert.equal(result.evidence[0].data && (result.evidence[0].data as LogLine).userId, 'u-1');
    assert.doesNotMatch(result.evidence[0].summary, /assistant prose/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
