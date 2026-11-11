import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildConfig, setConfig } from '../src/config.ts';
import { assertReadOnlySql, connect, Pg, pgEnv, readOnlyScript, utc } from '../src/sources/postgres.ts';

test('assertReadOnlySql accepts plain and quoted read-only SELECTs', () => {
  assert.doesNotThrow(() => assertReadOnlySql('SELECT 1'));
  assert.doesNotThrow(() => assertReadOnlySql('WITH x AS (SELECT 1) SELECT * FROM x'));
  assert.doesNotThrow(() => assertReadOnlySql(`SELECT "updatedAt" FROM "User" WHERE name = 'delete me'`));
  assert.doesNotThrow(() => assertReadOnlySql('SELECT 1 /* delete; update; set_config() */ -- copy\n'));
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

test('assertReadOnlySql sees executable SQL after comments and across quote forms', () => {
  assert.throws(() => assertReadOnlySql('SELECT 1 /* harmless */; DROP TABLE x'));
  assert.throws(() => assertReadOnlySql("SELECT E'\\\\'; DROP TABLE x; --'"));
  assert.throws(() => assertReadOnlySql('SELECT $$safe$$; DROP TABLE x'));
  assert.throws(() => assertReadOnlySql('WITH x AS (SELECT 1) /* gap */ DELETE FROM t'));
  assert.throws(() => assertReadOnlySql('SELECT 1 -- comment\n; DROP TABLE x'));
});

test('assertReadOnlySql ends line comments on CR, LF, and CRLF', () => {
  for (const newline of ['\r', '\n', '\r\n']) {
    assert.throws(
      () => assertReadOnlySql(`SELECT 1 -- comment${newline}; COMMIT; SET default_transaction_read_only=off; DELETE FROM t`),
      /multi-statement|commit|set|delete/i,
    );
  }
});

test('Pg.query rejects CR-terminated comment injection before invoking its runner', async () => {
  let calls = 0;
  const db = new Pg('postgres://u:p@h:5432/d', async () => {
    calls++;
    return { code: 0, stdout: '[]', stderr: '' };
  });
  await assert.rejects(
    db.query('SELECT 1) t --comment\r; COMMIT; SET default_transaction_read_only=off; DELETE FROM t; SELECT 1 --'),
    /multi-statement|commit|set|delete/i,
  );
  assert.equal(calls, 0);
});

test('assertReadOnlySql rejects newline-continued escape strings and logical decoding side effects', () => {
  assert.doesNotThrow(() => assertReadOnlySql("SELECT E'plain\\\\string'"));
  assert.throws(() => assertReadOnlySql("SELECT E'first'\n'second'"), /continued escape strings/i);
  assert.throws(() => assertReadOnlySql("SELECT E'first'\n'\\\\' plus suffix"), /continued escape strings/i);
  assert.throws(() => assertReadOnlySql("SELECT pg_logical_emit_message(true, 'prefix', 'message')"));
});

test('assertReadOnlySql rejects unrecognized Unicode dollar-quote tags', () => {
  for (const tag of ['é', '高']) {
    assert.throws(
      () => assertReadOnlySql(`SELECT $${tag}$' $${tag}$; DELETE FROM t`),
      /unrecognized dollar-quoted SQL/i,
    );
  }
});

test('assertReadOnlySql rejects write operations in CTEs', () => {
  assert.throws(() => assertReadOnlySql('WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x'));
});

test('assertReadOnlySql rejects known side-effect function families', () => {
  assert.throws(() => assertReadOnlySql("SELECT dblink_exec('host', 'DELETE FROM t')"));
  assert.throws(() => assertReadOnlySql("SELECT dblink('host', 'DELETE FROM t RETURNING *')"));
  assert.throws(() => assertReadOnlySql("SELECT pg_read_file('/etc/passwd')"));
  assert.throws(() => assertReadOnlySql("SELECT lo_import('/tmp/file')"));
  assert.throws(() => assertReadOnlySql('SELECT pg_notify(\'channel\', \'payload\')'));
  assert.throws(() => assertReadOnlySql('SELECT pg_advisory_xact_lock(1)'));
  assert.throws(() => assertReadOnlySql('SELECT pg_try_advisory_lock(1)'));
  assert.throws(() => assertReadOnlySql("SELECT set_config('x', 'y', false)"));
  assert.throws(() => assertReadOnlySql("SELECT 'unterminated"));
  assert.throws(() => assertReadOnlySql('SELECT 1 /* unterminated'));
  assert.throws(() => assertReadOnlySql('SELECT $$unterminated'));
});

test('Pg.query rejects nontransactional administrative functions before invoking psql', async () => {
  let calls = 0;
  const db = new Pg('postgres://u:p@h:5432/d', async () => {
    calls++;
    return { code: 0, stdout: '[]', stderr: '' };
  });
  for (const sql of [
    'SELECT pg_stat_reset()',
    "SELECT pg_stat_reset_shared('bgwriter')",
    'SELECT pg_stat_reset_single_table_counters(123)',
    'SELECT pg_reload_conf()',
    'SELECT pg_rotate_logfile()',
    "SELECT pg_create_restore_point('reprobe')",
  ]) {
    await assert.rejects(db.query(sql), /refuses SQL/);
  }
  assert.equal(calls, 0);
});

test('assertReadOnlySql detects psql commands even when SQL comments precede them', () => {
  assert.throws(() => assertReadOnlySql('SELECT 1\n-- comment\n\\! touch /tmp/reprobe-write'));
  assert.throws(() => assertReadOnlySql('SELECT 1\n/* comment */\n\\copy t from /tmp/x'));
});

test('readOnlyScript wraps the query in a read-only transaction that is rolled back', () => {
  const script = readOnlyScript('SELECT 1');
  assert.ok(script.startsWith('BEGIN TRANSACTION READ ONLY;'));
  assert.ok(script.endsWith('ROLLBACK;\n'));
});

test('readOnlyScript ends a trailing SQL line comment before closing its wrapper', () => {
  assert.match(readOnlyScript('SELECT 1 -- note'), /SELECT 1 -- note\n\) t;/);
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
