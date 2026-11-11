import { spawn } from 'node:child_process';

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  input?: string;
}

export type Runner = (cmd: string, args: string[], opts?: RunOptions) => Promise<RunResult>;

/** Never throws: a missing binary or a timeout comes back as a non-zero code with the reason in stderr. */
export const run: Runner = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (r: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      done({ code: 124, stdout, stderr: `${stderr}\ntimed out after ${opts.timeoutMs}ms` });
    }, opts.timeoutMs ?? 60_000);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => done({ code: 127, stdout, stderr: String(e.message) }));
    child.on('close', (code) => done({ code: code ?? 1, stdout, stderr }));
    // A child that exits before reading its stdin (or never started) must not crash reprobe.
    child.stdin.on('error', () => {});
    child.stdin.end(opts.input ?? '');
  });

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * fetch that retries rate limits, gateway errors and network failures with backoff, honouring
 * Retry-After. A 4xx other than 408/425/429 is an answer, not a failure, and returns at once.
 */
export function retryingFetch(base: typeof fetch = fetch, attempts = 5, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    let last: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        const res = await base(input, init);
        if (!RETRYABLE.has(res.status) || i === attempts - 1) return res;
        const after = Number(res.headers.get('retry-after'));
        await sleep(Math.min(30_000, Number.isFinite(after) && after > 0 ? after * 1000 : 1000 * 2 ** i));
      } catch (e) {
        last = e;
        if (i === attempts - 1) throw e;
        await sleep(1000 * 2 ** i);
      }
    }
    throw last;
  }) as typeof fetch;
}
