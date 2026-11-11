import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildConfig, setConfig, type FileConfig } from '../src/config.ts';
import { gatherSentry, parseIssueTable, sentryAuthState, sentryReadState } from '../src/sources/sentry.ts';
import type { Runner, RunResult } from '../src/exec.ts';
import type { Window } from '../src/types.ts';

const WINDOW: Window = { from: '2026-07-27T00:00:00Z', to: '2026-07-28T12:00:00Z' };
const HINT = 'sentry-cli is not logged in: run `sentry-cli login`';
const HEADER = '| Issue ID | Short ID | Title | Status | Last seen |';

/** Points the config at a sentry source (org acme, projects api and app) unless the test passes its own. */
function useSentry(sentry: Partial<NonNullable<FileConfig['sources']>['sentry']> = {}): void {
  setConfig(buildConfig(null, { sources: { sentry: { org: 'acme', projects: ['api', 'app'], ...sentry } } }));
}

/** Fake sentry-cli: records every argv and answers from the callback. Never runs a real binary. */
function fakeRunner(answer: (args: string[]) => Partial<RunResult>): { runner: Runner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: Runner = async (cmd, args) => {
    if (cmd !== 'sentry-cli') throw new Error(`unexpected command: ${cmd}`);
    calls.push(args);
    const a = answer(args);
    return { code: a.code ?? 0, stdout: a.stdout ?? '', stderr: a.stderr ?? '' };
  };
  return { runner, calls };
}

const projectOf = (args: string[]) => args[args.indexOf('-p') + 1];
const queryOf = (args: string[]) => args[args.indexOf('--query') + 1];

function tableOf(rows: string[][]): string {
  return ['+---+', HEADER, '+---+', ...rows.map((r) => `| ${r.join(' | ')} |`), '+---+'].join('\n') + '\n';
}

test('sentryAuthState is skipped when the config has no sentry source', async () => {
  setConfig(buildConfig(null, {}));
  const { runner, calls } = fakeRunner(() => ({ code: 0 }));
  assert.deepEqual(await sentryAuthState(runner), { source: 'sentry', state: 'skipped', detail: 'no sentry source in the config' });
  assert.equal(calls.length, 0);
});

test('sentryAuthState reports a missing binary (exit 127)', async () => {
  useSentry();
  const { runner } = fakeRunner(() => ({ code: 127, stderr: 'spawn sentry-cli ENOENT' }));
  assert.deepEqual(await sentryAuthState(runner), {
    source: 'sentry',
    state: 'missing-credentials',
    detail: 'sentry-cli not installed',
  });
});

test('sentryAuthState reports Method: Unauthorized as missing-credentials without leaking output', async () => {
  useSentry();
  const { runner, calls } = fakeRunner(() => ({ code: 0, stdout: 'Method: Unauthorized token=sekrit' }));
  assert.deepEqual(await sentryAuthState(runner), { source: 'sentry', state: 'missing-credentials', detail: HINT });
  assert.deepEqual(calls, [['info']]);
});

test('sentryAuthState reports a failed run as missing-credentials', async () => {
  useSentry();
  const { runner } = fakeRunner(() => ({ code: 1, stderr: 'error: token=sekrit' }));
  const out = await sentryAuthState(runner);
  assert.deepEqual(out, { source: 'sentry', state: 'missing-credentials', detail: HINT });
  assert.ok(!out.detail.includes('sekrit'));
});

test('sentryAuthState is ok when sentry-cli info succeeds', async () => {
  useSentry();
  const { runner } = fakeRunner(() => ({ code: 0, stdout: 'Sentry CLI 2.40.0\nAuthenticated' }));
  assert.deepEqual(await sentryAuthState(runner), {
    source: 'sentry',
    state: 'ok',
    detail: 'sentry-cli authenticated',
  });
});

test('sentryReadState is ok when sentry-cli can list issues for the first project', async () => {
  useSentry();
  const { runner, calls } = fakeRunner((args) => (args[0] === 'info' ? { stdout: 'ok' } : { stdout: tableOf([]) }));
  assert.deepEqual(await sentryReadState(runner), { source: 'sentry', state: 'ok', detail: 'can read issues in acme/api' });
  assert.deepEqual(calls[1], ['issues', 'list', '-o', 'acme', '-p', 'api', '--max-rows', '1']);
});

test('sentryReadState reports a 403 as missing-credentials and names the event:read scope', async () => {
  useSentry();
  const { runner } = fakeRunner((args) => (args[0] === 'info' ? { stdout: 'ok' } : { code: 1, stderr: 'Error: 403 Forbidden' }));
  const out = await sentryReadState(runner);
  assert.equal(out.state, 'missing-credentials');
  assert.match(out.detail, /event:read/);
});

test('sentryReadState rejects an empty project list without invoking sentry-cli', async () => {
  useSentry({ projects: [] });
  const { runner, calls } = fakeRunner(() => ({ stdout: 'unexpected' }));
  assert.deepEqual(await sentryReadState(runner), { source: 'sentry', state: 'error', detail: 'no Sentry projects configured' });
  assert.equal(calls.length, 0);
});

test('parseIssueTable parses the documented table into literal rows', () => {
  const text = `+------------+---------------------+------------------------------------------+------------+------------------------------+
| Issue ID   | Short ID            | Title                                    | Status     | Last seen                    |
+------------+---------------------+------------------------------------------+------------+------------------------------+
| 6812345678 | API-SERVER-4K       | ForbiddenException: You can only confirm | unresolved | 2026-07-28 08:44:48.123 UTC  |
+------------+---------------------+------------------------------------------+------------+------------------------------+
`;
  assert.deepEqual(parseIssueTable(text, 'api'), [
    {
      id: '6812345678',
      shortId: 'API-SERVER-4K',
      title: 'ForbiddenException: You can only confirm',
      lastSeen: '2026-07-28 08:44:48.123 UTC',
      status: 'unresolved',
    },
  ]);
});

test('parseIssueTable maps columns by header name and tolerates missing columns', () => {
  const text = `| Title | Short ID | Issue ID |
| Boom | APP-FLUTTER-1 | 77 |
`;
  assert.deepEqual(parseIssueTable(text, 'app'), [
    { id: '77', shortId: 'APP-FLUTTER-1', title: 'Boom', lastSeen: '', status: '' },
  ]);
});

test('parseIssueTable returns [] for text without a header', () => {
  assert.deepEqual(parseIssueTable('no issues here\n', 'api'), []);
});

test('gatherSentry stops at auth failure and never lists issues', async () => {
  useSentry();
  const { runner, calls } = fakeRunner(() => ({ code: 1, stderr: 'error: token=sekrit' }));
  const out = await gatherSentry({ window: WINDOW, runner });
  assert.deepEqual(out, {
    status: { source: 'sentry', state: 'missing-credentials', detail: HINT },
    evidence: [],
  });
  assert.deepEqual(calls, [['info']]);
});

test('gatherSentry keeps issues seen within a day of window.from and drops older ones', async () => {
  useSentry();
  const { runner, calls } = fakeRunner((args) => {
    if (args[0] === 'info') return { stdout: 'Sentry CLI 2.40.0' };
    if (projectOf(args) === 'api') {
      return {
        stdout: tableOf([
          ['1', 'API-1', 'Recent crash', 'unresolved', '2026-07-28 08:44:48.123 UTC'],
          ['2', 'API-2', 'Old crash', 'unresolved', '2026-06-01 00:00:00.000 UTC'],
        ]),
      };
    }
    return { stdout: tableOf([]) };
  });

  const out = await gatherSentry({ window: WINDOW, runner });

  assert.deepEqual(out.status, { source: 'sentry', state: 'ok', detail: '1 issues' });
  assert.deepEqual(
    out.evidence.map((e) => e.id),
    ['sentry:api:API-1'],
  );
  assert.deepEqual(out.evidence[0], {
    id: 'sentry:api:API-1',
    source: 'sentry',
    at: '2026-07-28T08:44:48.123Z',
    kind: 'sentry.issue',
    summary: 'API-1 Recent crash (unresolved)',
    data: {
      id: '1',
      shortId: 'API-1',
      title: 'Recent crash',
      lastSeen: '2026-07-28 08:44:48.123 UTC',
      status: 'unresolved',
    },
    link: 'https://acme.sentry.io/issues/?query=API-1',
  });

  const listCalls = calls.filter((a) => a[0] === 'issues');
  assert.equal(listCalls.length, 2);
  assert.deepEqual(listCalls[0], [
    'issues',
    'list',
    '-o',
    'acme',
    '-p',
    'api',
    '--query',
    'firstSeen:<=2026-07-28T12:00:00 lastSeen:>=2026-07-26T00:00:00',
    '--max-rows',
    '50',
  ]);
});

test('gatherSentry reports partial project failures alongside successful project evidence', async () => {
  useSentry();
  const { runner } = fakeRunner((args) => {
    if (args[0] === 'info') return { stdout: 'ok' };
    if (projectOf(args) === 'api') return { stdout: tableOf([['1', 'API-1', 'Recent crash', 'unresolved', '2026-07-28 08:44:48.123 UTC']]) };
    return { code: 1, stderr: 'temporary failure' };
  });
  const out = await gatherSentry({ window: WINDOW, runner });
  assert.equal(out.status.state, 'ok');
  assert.match(out.status.detail, /1 issues; some project reads failed: temporary failure/);
  assert.equal(out.evidence.length, 1);
});

test('gatherSentry does not call a partial project failure an empty result', async () => {
  useSentry();
  const { runner } = fakeRunner((args) => {
    if (args[0] === 'info') return { stdout: 'ok' };
    return projectOf(args) === 'api' ? { stdout: tableOf([]) } : { code: 1, stderr: 'temporary failure' };
  });
  const out = await gatherSentry({ window: WINDOW, runner });
  assert.equal(out.status.state, 'error');
  assert.match(out.status.detail, /some project reads failed: temporary failure/);
  assert.equal(out.evidence.length, 0);
});

test('gatherSentry does not call sentry-cli when the project list is empty', async () => {
  useSentry({ projects: [] });
  const { runner, calls } = fakeRunner(() => ({ stdout: 'unexpected' }));
  const out = await gatherSentry({ window: WINDOW, runner });
  assert.deepEqual(out, { status: { source: 'sentry', state: 'error', detail: 'no Sentry projects configured' }, evidence: [] });
  assert.equal(calls.length, 0);
});

test('gatherSentry links issues to sentry.url when the config sets it', async () => {
  useSentry({ url: 'https://sentry.example.com/' });
  const { runner } = fakeRunner((args) => (args[0] === 'info' ? { stdout: 'ok' } : projectOf(args) === 'api'
    ? { stdout: tableOf([['1', 'API-1', 'Recent crash', 'unresolved', '2026-07-28 08:44:48.123 UTC']]) }
    : { stdout: tableOf([]) }));
  const out = await gatherSentry({ window: WINDOW, runner });
  assert.equal(out.evidence[0].link, 'https://sentry.example.com/issues/?query=API-1');
});

test('gatherSentry passes an explicit issue id through as the query and skips the window filter', async () => {
  useSentry();
  const { runner, calls } = fakeRunner((args) => {
    if (args[0] === 'info') return { stdout: 'Sentry CLI 2.40.0' };
    if (projectOf(args) === 'api') {
      return {
        stdout: tableOf([['2', 'API-2', 'Old crash', 'unresolved', '2026-06-01 00:00:00.000 UTC']]),
      };
    }
    return { stdout: tableOf([]) };
  });

  const out = await gatherSentry({ window: WINDOW, issue: 'API-2', runner });

  assert.deepEqual(
    out.evidence.map((e) => e.id),
    ['sentry:api:API-2'],
  );
  const listCalls = calls.filter((a) => a[0] === 'issues');
  assert.equal(listCalls.length, 2);
  for (const args of listCalls) assert.equal(queryOf(args), 'API-2');
});

test('gatherSentry builds a user.id query when given a userId', async () => {
  useSentry();
  const { runner, calls } = fakeRunner((args) => (args[0] === 'info' ? { stdout: 'ok' } : { stdout: tableOf([]) }));
  await gatherSentry({ window: WINDOW, userId: '42', runner });
  const listCalls = calls.filter((a) => a[0] === 'issues');
  assert.equal(listCalls.length, 2);
  for (const args of listCalls) assert.equal(queryOf(args), 'user.id:42 firstSeen:<=2026-07-28T12:00:00 lastSeen:>=2026-07-26T00:00:00');
});

test('gatherSentry reports empty when no issues match', async () => {
  useSentry();
  const { runner } = fakeRunner((args) => (args[0] === 'info' ? { stdout: 'ok' } : { stdout: tableOf([]) }));
  assert.deepEqual(await gatherSentry({ window: WINDOW, runner }), {
    status: { source: 'sentry', state: 'empty', detail: 'no matching issues' },
    evidence: [],
  });
});

test('gatherSentry reports error with the first stderr line when every project fails', async () => {
  useSentry();
  const { runner } = fakeRunner((args) =>
    args[0] === 'info' ? { stdout: 'ok' } : { code: 1, stderr: 'Error: rate limited\nretry later' },
  );
  assert.deepEqual(await gatherSentry({ window: WINDOW, runner }), {
    status: { source: 'sentry', state: 'error', detail: 'Error: rate limited' },
    evidence: [],
  });
});

test('gatherSentry redacts credential-shaped command errors', async () => {
  useSentry();
  const { runner } = fakeRunner((args) =>
    args[0] === 'info' ? { stdout: 'ok' } : { code: 1, stderr: 'request failed sntryu_123456789abcdef\nretry later' },
  );
  const out = await gatherSentry({ window: WINDOW, runner });
  assert.equal(out.status.state, 'error');
  assert.doesNotMatch(out.status.detail, /sntryu_123456789abcdef/);
});

test('gatherSentry: a 10-digit numeric issue id survives redaction because ids and links use the short id', async () => {
  setConfig(buildConfig(null, { sources: { sentry: { org: 'acme', projects: ['api'] } } }));
  const table = [
    '+------------+------------+-------+-----------------------------+------------+-------+',
    '| Issue ID   | Short ID   | Title | Last seen                   | Status     | Level |',
    '+------------+------------+-------+-----------------------------+------------+-------+',
    '| 7702017587 | API-1T     | Boom  | 2026-07-28T08:44:48.000000Z | unresolved | error |',
    '| 7808853152 | API-21     | Bang  | 2026-07-28T08:45:48.000000Z | unresolved | error |',
    '+------------+------------+-------+-----------------------------+------------+-------+',
  ].join('\n');
  const runner: Runner = async (_cmd, args) => (args[0] === 'info' ? { code: 0, stdout: 'Method: Auth Token', stderr: '' } : { code: 0, stdout: table, stderr: '' });
  const { redactValue } = await import('../src/redact.ts');
  const r = redactValue(await gatherSentry({ window: { from: '2026-07-28T08:00:00.000Z', to: '2026-07-28T09:00:00.000Z' }, runner }));
  assert.deepEqual(r.evidence.map((e) => e.id), ['sentry:api:API-1T', 'sentry:api:API-21']);
  assert.ok(r.evidence.every((e) => !e.link?.includes('[phone]')));
});
