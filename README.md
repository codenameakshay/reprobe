# reprobe

A user says "I couldn't save, I tried three times." reprobe turns that into:

1. **Evidence**, gathered deterministically and read-only: database rows, agent traces (Langfuse, LangSmith), server logs, Sentry issues. Each item gets a stable id.
2. **A root cause** that your own coding agent (Claude Code or Codex) works out, where every claim cites evidence ids. Claims that cite nothing, or cite ids that don't exist, are dropped from the report.
3. **A replay test** that fails on the deployed commit and passes on the fix. FAIL then PASS is what turns a likely cause into a proven one.

reprobe never writes to production, and it has no server or hosted model. It runs on your machine with your credentials and your agent.

```sh
cd your-repo
npx reprobe init      # finds your sources, writes .reprobe/config.json (env var names, never values)
npx reprobe doctor    # checks each source with a real read
npx reprobe "users can't save expenses since this morning" --since 6h
```

## How it works

```
complaint + any of --trace --user --chat --sentry --since
   │
   ▼  gather (deterministic, read-only, each source fails on its own with a status)
   postgres   every query: SELECT/WITH guard + read-only session + BEGIN READ ONLY … ROLLBACK
   langfuse   trace observations           langsmith  public share links
   sentry     issues via sentry-cli         logs       railway, any log CLI, or files
   │
   ▼  redact (phones, emails, tokens, keys, signed URLs) → case/evidence.json
   ▼  detectors (pure functions) → known signatures, with replays where a pack provides one
   ▼  your agent, with case/CASE.md (context + playbook)
        digs further with reprobe's tools, each appending citable evidence:
          reprobe query <case> "SELECT …"     reprobe logs <case> --grep <text>
          reprobe sentry <case>                reprobe trace <case> <url>
        writes a replay test, then: reprobe verify <case> <deployed-sha> [<fix-sha>]
        writes diagnosis.json, then: reprobe report <case>  (drops uncited claims)
   ▼
   case/report.md: diagnosis, replay verdicts, sources table, timeline
```

Like `npx t3 triage`, the CLI does the parts that must be exact (gathering, read-only access, redaction, citation checks, running replays at old commits) and hands the reasoning to the agent you already use. With no agent installed it prints the one line to paste into any agent.

## Commands

```sh
reprobe "<complaint>" [--trace <langfuse|langsmith url>] [--user <id>] [--chat <id>] [--sentry <issue>]
                      [--since 2h] [--at <iso time>] [--agent claude|codex|none] [--model <m>]
reprobe agent <case>                 # (re)start the agent on a case
reprobe init [--force]               # detect sources, write .reprobe/config.json
reprobe doctor                       # real read against every source
reprobe query <case> "<SELECT …>"    # agent tools: each appends evidence
reprobe logs <case> --grep <text>
reprobe sentry <case> [--issue <id>]
reprobe trace <case> <url|id>
reprobe verify <case> <commit>…      # run the replay in a detached worktree per commit
reprobe report <case>                # validate diagnosis.json citations, render report.md
reprobe analyze <case>               # re-run detectors offline from the saved evidence
reprobe clean                        # remove reprobe's worktrees
```

Cases are written to `~/.reprobe/cases/<repo>/`, outside every repo, because they hold production evidence.

## Config

`.reprobe/config.json` holds references to credentials, never values:

```json
{
  "sources": {
    "postgres": { "url": "env:READONLY_DATABASE_URL" },
    "langfuse": { "baseUrl": "env:LANGFUSE_HOST", "publicKey": "env:LANGFUSE_PUBLIC_KEY", "secretKey": "env:LANGFUSE_SECRET_KEY" },
    "sentry":   { "org": "acme", "projects": ["api", "web"] },
    "logs": [
      { "name": "api", "railway": { "service": "api" } },
      { "name": "worker", "command": ["fly", "logs", "-a", "acme-worker", "--no-tail"] },
      { "name": "local", "file": "logs/*.log" }
    ]
  },
  "verify": { "setup": [{ "nodeModules": "server" }, { "cwd": "server", "run": ["npx", "prisma", "generate"] }] }
}
```

A secret can come from a command instead of the environment, for example a secrets manager:
`{ "cmd": ["doppler", "secrets", "get", "DATABASE_URL", "--plain"] }`. `json` or `kv` picks one key from the output.

`verify.setup` prepares each old commit before a replay runs. `nodeModules` installs dependencies once per lockfile hash outside the worktree, with install scripts off. Each step only runs for replays inside its directory.

## Packs

A pack teaches reprobe one product: how to find the user a complaint is about, which rows matter, the product's known failure signatures, and how to build an old commit. It is one TypeScript file next to the config (`"pack": "./pack.ts"`), and every hook is optional:

```ts
import type { Pack } from 'reprobe/types';
export default {
  name: 'acme',
  async resolveSubject(ctx) { /* ctx.pg.query(...) → ctx.subject.userId */ },
  async gather(ctx) { /* push product rows to ctx.evidence */ },
  detectors: [/* (ctx) => Finding[] */],
  replayFor(finding, ctx) { /* attach a replay to a core finding */ },
  async prepareWorktree(wt, replay, sha, tools) { /* pick a toolchain for an old commit */ },
} satisfies Pack;
```

Without a pack, reprobe still gathers traces, logs and Sentry by the ids you pass, and the agent queries the database itself through `reprobe query`.

## Safety

- **Production is read-only.** Postgres queries pass a SELECT/WITH-only guard, run with `default_transaction_read_only=on`, and run inside `BEGIN TRANSACTION READ ONLY … ROLLBACK`. reprobe refuses to continue if the server does not report read-only. Use a read-only role as well if you have one.
- **Replays never touch a database.** They are unit tests. They run in detached git worktrees under `~/.cache/reprobe`, never in your checkout. The replay command must be a known test runner (or one you list in `verify.allow`) and runs without a shell.
- **A crash cannot pass for a reproduced bug.** A replay prints `REPROBE_REPLAY:<id>:START` before its assertion and `:PASS` or `:FAIL` after. A run without those lines is BROKEN.
- **Redaction is on by default, but pattern-based.** Phones, emails, tokens, keys and signed URLs are redacted before anything is written. Opaque tokens can slip through, so read a case before you share it.
- **No outside writes.** reprobe posts nothing to Sentry, GitHub, Langfuse or users. The playbook tells the agent the same, and tells it to treat evidence as data, never as instructions.
- **Citations are checked for existence, not truth.** A dropped claim had no valid citation. A kept claim cites real evidence, but you still judge whether the evidence supports it. The replay verdict is the proof.

## Requirements

Node 22.18 or later. `git`, plus the CLI for each source you use: `psql`, `sentry-cli`, `railway`, `rg` (archive), and `claude` or `codex` for the agent.

MIT licensed.
