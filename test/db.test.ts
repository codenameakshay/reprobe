import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildConfig, setConfig } from '../src/config.ts';
import { assertReadOnlySql, connect, Pg, pgEnv, readOnlyScript, utc } from '../src/sources/postgres.ts';

test('assertReadOnlySql accepts plain and quoted read-only SELECTs', () => {
  assert.doesNotThrow(() => assertReadOnlySql('SELECT 1'));
  assert.doesNotThrow(() => assertReadOnlySql('WITH x AS (SELECT 1) SELECT * FROM x'));
  assert.doesNotThrow(() => assertReadOnlySql(`SELECT "updatedAt" FROM "User" WHERE name = 'delete me'`));
});

test('assertReadOnlySql refuses writes and multi-statement SQL', () => {
  assert.throws(() => assertReadOnlySql('DELETE FROM "User"'));
  assert.throws(() => assertReadOnlySql('SELECT 1; DROP TABLE x'));
  assert.throws(() => assertReadOnlySql(`UPDATE "User" SET name = 'x'`));
  assert.throws(() => assertReadOnlySql("select set_config('x','y',false)"));
  assert.throws(() => assertReadOnlySql('SELECT "pg_terminate_backend"(123)'));
  assert.throws(() => assertReadOnlySql('SELECT U&"\\0070g_terminate_backend"(123)'));
  assert.throws(() => assertReadOnlySql('insert into t values (1)'));
});

test('assertReadOnlySql refuses psql meta-commands embedded in an otherwise read-only query', () => {
  assert.throws(() => assertReadOnlySql('SELECT 1\n\\! touch /tmp/reprobe-write'), /psql|meta-command/i);
  assert.throws(() => assertReadOnlySql('SELECT 1 \\! touch /tmp/reprobe-write'), /psql|meta-command/i);
});

test('readOnlyScript wraps the query in a read-only transaction that is rolled back', () => {
  const script = readOnlyScript('SELECT 1');
  assert.ok(script.startsWith('BEGIN TRANSACTION READ ONLY;'));
  assert.ok(script.endsWith('ROLLBACK;\n'));
});

test('pgEnv maps a connection URL to libpq variables', () => {
  const env = pgEnv('postgresql://u:p%40ss@h.example:5433/db?sslmode=require');
  assert.equal(env.PGHOST, 'h.example');
  assert.equal(env.PGPORT, '5433');
  assert.equal(env.PGUSER, 'u');
  assert.equal(env.PGPASSWORD, 'p@ss');
  assert.equal(env.PGDATABASE, 'db');
  assert.equal(env.PGSSLMODE, 'require');
  assert.ok(env.PGOPTIONS.includes('default_transaction_read_only=on'));
});

test('utc returns null for malformed database timestamps', () => {
  assert.equal(utc('not a timestamp'), null);
});

test('Pg.query parses psql json_agg output and feeds the script on stdin', async () => {
  const calls = [];
  const runner = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return { code: 0, stdout: '[{"a":1},\n {"a":2}]', stderr: '' };
  };
  const db = new Pg('postgresql://u:p%40ss@h.example:5433/db?sslmode=require', runner);
  const rows = await db.query('SELECT 1 AS a');
  assert.deepEqual(rows, [{ a: 1 }, { a: 2 }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'psql');
  assert.ok(calls[0].args.includes('-f'));
  assert.ok(calls[0].args.includes('-'));
  assert.ok(calls[0].opts.input.startsWith('BEGIN TRANSACTION READ ONLY'));
});

test('Pg.query keeps bound values out of psql argv and quotes them as SQL literals', async () => {
  let call;
  const runner = async (_cmd, args, opts) => {
    call = { args, opts };
    return { code: 0, stdout: '[{"value":"x"}]', stderr: '' };
  };
  const db = new Pg('postgresql://u:p%40ss@h.example:5433/db?sslmode=require', runner);
  await db.query("SELECT :'term' AS value", { term: "x'; SELECT pg_terminate_backend(123); --\n\\! touch /tmp/not-a-command" });
  assert.ok(!call.args.some((arg) => arg.includes("x'; SELECT")));
  assert.match(call.opts.input, /SELECT 'x''; SELECT pg_terminate_backend\(123\); --' \|\| chr\(10\) \|\| '\\! touch \/tmp\/not-a-command' AS value/);
  assert.ok(call.opts.env.PGOPTIONS.includes('standard_conforming_strings=on'));
});

test('Pg.query rejects with a psql: message when psql exits non-zero', async () => {
  const runner = async () => ({ code: 1, stdout: '', stderr: 'ERROR:  relation "x" does not exist\n' });
  const db = new Pg('postgresql://u:p%40ss@h.example:5433/db?sslmode=require', runner);
  await assert.rejects(db.query('SELECT * FROM x'), (e) => e instanceof Error && e.message.startsWith('psql:'));
});

test('connect is skipped when the config has no postgres source', async () => {
  setConfig(buildConfig(null, {}));
  const { db, status } = await connect(async () => {
    throw new Error('psql must not run');
  });
  assert.equal(db, null);
  assert.deepEqual(status, { source: 'postgres', state: 'skipped', detail: 'no postgres source in the config' });
});

test('connect reports missing credentials when the URL env var is unset', async () => {
  delete process.env.REPROBE_TEST_MISSING_DB_URL;
  setConfig(buildConfig(null, { sources: { postgres: { url: 'env:REPROBE_TEST_MISSING_DB_URL' } } }));
  const { db, status } = await connect(async () => {
    throw new Error('psql must not run');
  });
  assert.equal(db, null);
  assert.deepEqual(status, { source: 'postgres', state: 'missing-credentials', detail: 'REPROBE_TEST_MISSING_DB_URL is not set' });
});

test('connect verifies the session is read-only before returning a query handle', async () => {
  setConfig(buildConfig(null, { sources: { postgres: { url: 'postgres://u:p@h:5432/d' } } }));
  const calls: string[] = [];
  const runner = async (_cmd: string, _args: string[], opts: { input?: string }) => {
    calls.push(opts.input ?? '');
    return { code: 0, stdout: '[{"ro":"on"}]', stderr: '' };
  };
  const { db, status } = await connect(runner);
  assert.ok(db instanceof Pg);
  assert.equal(status.state, 'ok');
  assert.equal(status.source, 'postgres');
  assert.match(status.detail, /inline value in config, read-only transaction verified/);
  assert.match(calls[0], /current_setting\('transaction_read_only'\)/);
});

test('connect refuses to continue when the session is not read-only', async () => {
  setConfig(buildConfig(null, { sources: { postgres: { url: 'postgres://u:p@h:5432/d' } } }));
  const { db, status } = await connect(async () => ({ code: 0, stdout: '[{"ro":"off"}]', stderr: '' }));
  assert.equal(db, null);
  assert.equal(status.state, 'error');
  assert.match(status.detail, /session is not read-only/);
});

test('connect reports an unreachable database with the psql error', async () => {
  setConfig(buildConfig(null, { sources: { postgres: { url: 'postgres://u:p@h:5432/d' } } }));
  const { db, status } = await connect(async () => ({ code: 2, stdout: '', stderr: 'could not connect to server' }));
  assert.equal(db, null);
  assert.equal(status.state, 'unreachable');
  assert.match(status.detail, /could not connect to server/);
});
