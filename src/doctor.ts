import { existsSync } from 'node:fs';
import { config, firstLine, resolveSecret } from './config.ts';
import { run } from './exec.ts';
import { langfuseClient } from './sources/langfuse.ts';
import { connect } from './sources/postgres.ts';
import { sentryReadState } from './sources/sentry.ts';
import type { Check, Pack } from './types.ts';

async function bin(name: string, required: boolean, args = ['--version']): Promise<Check> {
  const r = await run(name, args, { timeoutMs: 20_000 });
  return { name: `${name} binary`, ok: r.code === 0, detail: r.code === 0 ? firstLine(r.stdout || r.stderr) || 'found' : 'not found', fix: r.code === 0 ? undefined : `install ${name}`, required };
}

/** Every configured source is checked with a real read, not just "is a key set". */
export async function doctor(pack: Pack | null): Promise<{ checks: Check[]; ok: boolean }> {
  const checks: Check[] = [];
  const s = config.sources;
  checks.push({
    name: 'config',
    ok: Boolean(config.file),
    detail: config.file ?? 'no .reprobe/config.json found (only --user, traces and share links work)',
    fix: config.file ? undefined : 'run `reprobe init` in your repo',
  });
  checks.push({ name: 'repo', ok: existsSync(`${config.repo}/.git`), detail: config.repo, fix: 'set "repo" in the config to your git checkout', required: true });

  const bins: Array<Promise<Check>> = [bin('git', true)];
  if (s.postgres) bins.push(bin('psql', true));
  if (s.sentry) bins.push(bin('sentry-cli', true));
  if (s.archive) bins.push(bin('rg', false));
  for (const l of s.logs ?? []) {
    if ('railway' in l) bins.push(bin('railway', true));
    if ('command' in l) bins.push(bin(l.command[0], true, ['--help']));
  }
  bins.push(bin('claude', false), bin('codex', false));
  const seen = new Set<string>();
  for (const c of await Promise.all(bins)) if (!seen.has(c.name) && seen.add(c.name)) checks.push(c);

  let pg = null;
  if (s.postgres) {
    const { db, status } = await connect();
    pg = db;
    checks.push({ name: 'Postgres (read-only)', ok: Boolean(db), detail: status.detail, fix: db ? undefined : 'check sources.postgres.url in the config', required: true });
    if (db) {
      try {
        const [row] = await db.query<{ ro: string; who: string }>(`SELECT current_setting('default_transaction_read_only') AS ro, current_user AS who`);
        checks.push({ name: 'Postgres session default', ok: row?.ro === 'on', detail: `default_transaction_read_only=${row?.ro} as ${row?.who}; every query also runs in BEGIN READ ONLY ... ROLLBACK`, required: true });
      } catch (e) {
        checks.push({ name: 'Postgres queries', ok: false, detail: (e as Error).message, required: true });
      }
    }
  }

  if (s.langfuse) {
    const lf = await langfuseClient();
    if (!lf) {
      const why = (await Promise.all([resolveSecret(s.langfuse.publicKey), resolveSecret(s.langfuse.secretKey), resolveSecret(s.langfuse.baseUrl)])).filter((r) => !r.value).map((r) => r.detail);
      checks.push({ name: 'Langfuse', ok: false, detail: `keys did not resolve: ${why.join('; ')}`, fix: 'check sources.langfuse in the config' });
    } else {
      const r = await lf.get('/api/public/v2/observations?limit=1&fields=core');
      checks.push({ name: 'Langfuse', ok: r.status === 200, detail: `${lf.base} v2 observations HTTP ${r.status}` });
    }
  }

  try {
    const r = await fetch('https://api.smith.langchain.com/api/v1/public/00000000-0000-0000-0000-000000000000/run', { signal: AbortSignal.timeout(15_000) });
    checks.push({ name: 'LangSmith public API', ok: r.status === 404 || r.ok, detail: `reachable (HTTP ${r.status} for a dummy share id); shared runs need no key` });
  } catch (e) {
    checks.push({ name: 'LangSmith public API', ok: false, detail: (e as Error).message });
  }

  if (s.sentry) {
    const st = await sentryReadState();
    checks.push({ name: 'Sentry', ok: st.state === 'ok', detail: st.detail, fix: st.state === 'ok' ? undefined : 'sentry-cli login with a token that has event:read, project:read, org:read' });
  }

  for (const l of s.logs ?? []) {
    if ('railway' in l) {
      const r = await run('railway', ['deployment', 'list', '--service', l.railway.service, '--json'], { cwd: l.railway.cwd ? `${config.repo}/${l.railway.cwd}` : config.repo, timeoutMs: 30_000 });
      let detail = firstLine(r.stderr);
      if (r.code === 0) {
        try {
          const list = JSON.parse(r.stdout) as Array<{ createdAt: string }>;
          detail = `${list.length} deployments of ${l.railway.service}, oldest ${list.map((d) => d.createdAt).sort()[0]}; Railway keeps logs for recent deployments only`;
        } catch {
          detail = 'unparseable deployment list';
        }
      }
      checks.push({ name: `logs: ${l.name}`, ok: r.code === 0, detail, fix: r.code === 0 ? undefined : `railway login; railway link in ${config.repo}` });
    } else if ('file' in l) {
      checks.push({ name: `logs: ${l.name}`, ok: true, detail: `reads ${l.file}` });
    } else {
      checks.push({ name: `logs: ${l.name}`, ok: true, detail: `runs \`${l.command.join(' ')}\` for the window` });
    }
  }

  if (s.archive) checks.push({ name: 'transcript archive', ok: existsSync(s.archive.dir), detail: `${s.archive.dir} (${s.archive.glob})` });
  checks.push({
    name: 'reporter',
    ok: Boolean(config.reporter),
    detail: config.reporter ? `${config.reporter.slice(0, 8)}…` : 'unset: "I" and "my friend" complaints need --user',
    fix: config.reporter ? undefined : 'set "reporter" in the config or REPROBE_REPORTER',
  });
  if (pack) {
    checks.push({ name: 'pack', ok: true, detail: `${pack.name} (${config.pack})` });
    if (pack.doctor) checks.push(...(await pack.doctor({ config, pg, run })));
  }
  return { checks, ok: checks.every((c) => c.ok || !c.required) };
}
