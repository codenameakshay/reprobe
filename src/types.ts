import type { Config } from './config.ts';
import type { Runner } from './exec.ts';
import type { ObservationAnnotator } from './sources/langfuse.ts';
import type { Pg } from './sources/postgres.ts';

/** Built-in sources are 'postgres', 'langfuse', 'langsmith', 'sentry', 'logs', 'archive', 'query'; packs add their own. */
export type SourceName = string;

export type SourceState =
  | 'ok'
  | 'empty'
  | 'missing-credentials'
  | 'unreachable'
  | 'expired'
  | 'not-found'
  | 'skipped'
  | 'error';

export interface SourceStatus {
  source: SourceName;
  state: SourceState;
  detail: string;
}

/** One fact from one source. `id` is stable across runs so reports and citations diff cleanly. */
export interface Evidence {
  id: string;
  source: SourceName;
  at: string | null;
  kind: string;
  summary: string;
  data: unknown;
  link?: string;
}

export interface Window {
  from: string;
  to: string;
}

export interface Input {
  complaint: string;
  trace?: string;
  user?: string;
  chat?: string;
  sentry?: string;
  reporter?: string;
  at?: string;
  sinceMs: number;
}

export interface Subject {
  userId?: string;
  label?: string;
  how?: string;
  sessionIds: string[];
  traceIds: string[];
}

export interface ReplayFile {
  /** Path relative to the repo root. */
  path: string;
  content: string;
  mode: 'create' | 'append';
}

/**
 * A focused test that encodes the invariant the bug broke. It must print `<marker>:START` before its
 * assertions and exactly one of `<marker>:PASS` / `<marker>:FAIL` after, so a run that crashed before
 * reaching the assertion is classified BROKEN instead of FAIL.
 */
export interface Replay {
  description: string;
  files: ReplayFile[];
  /** Directory relative to the repo root that the command runs in. */
  cwd: string;
  /** argv, no shell. command[0] must be a known test runner or listed in verify.allow. */
  command: string[];
  /** Files that must exist at the target commit for the replay to apply. */
  requires: string[];
  /** REPROBE_REPLAY:<id> */
  marker: string;
  /** Free-form tag a pack can use to pick its worktree preparation (e.g. 'server-jest', 'dart-test'). */
  kind?: string;
}

export type Confidence = 'high' | 'medium' | 'low';

export interface Finding {
  signature: string;
  title: string;
  confidence: Confidence;
  rootCause: string;
  evidence: string[];
  unknowns: string[];
  replay?: Replay;
}

export interface Gathered {
  input: Input;
  window: Window;
  subject: Subject;
  sources: SourceStatus[];
  evidence: Evidence[];
}

/** What the complaint says, independent of any product. Packs add product topics on top. */
export interface Intent {
  build: string | null;
  aboutOther: boolean;
  retries: number | null;
  words: string;
}

export interface GatherCtx {
  config: Config;
  input: Input;
  intent: Intent;
  window: Window;
  subject: Subject;
  sources: SourceStatus[];
  evidence: Evidence[];
  /** The read-only Postgres client, when configured and verified read-only. */
  pg: Pg | null;
  /** Extra ids (user ids, session ids) that make a log line relevant. */
  logIds: string[];
  log: (s: string) => void;
  run: Runner;
}

export interface DetectCtx {
  g: Gathered;
  intent: Intent;
  caseId: string;
  /** Evidence sorted by time, then id. */
  ev: Evidence[];
}

export type Detector = (c: DetectCtx) => Finding[];

export interface PrepareResult {
  /** Replaces the replay command (e.g. a toolchain picked for the commit date). */
  command?: string[];
  notes?: string[];
  /** A reason the commit cannot run the replay; the result is BROKEN with this detail. */
  error?: string;
}

/**
 * A pack teaches reprobe one product: how to find the user, which rows matter, which failure
 * signatures it has, and how to build an old commit. Every hook is optional.
 * Packs import only types from reprobe; everything they call at runtime arrives in the ctx.
 */
export interface Pack {
  name: string;
  /** Before logs are read: resolve who the complaint is about, or a candidate set (push ids to ctx.logIds). */
  resolveSubject?(ctx: GatherCtx): Promise<void>;
  /** After logs are read: narrow candidates using log evidence, then read product rows. */
  gather?(ctx: GatherCtx): Promise<void>;
  /** Product facts read off each Langfuse observation (flags for detectors, words for the summary). */
  observation?: ObservationAnnotator;
  detectors?: Detector[];
  /** Attach a replay to a core finding (e.g. a masked 4xx on a route the pack knows how to test). */
  replayFor?(finding: Finding, ctx: DetectCtx): Replay | undefined;
  /** Runs in the worktree after the replay files are written and setup steps ran. */
  prepareWorktree?(wt: string, replay: Replay, sha: string, tools: WorktreeTools): Promise<PrepareResult>;
  doctor?(ctx: { config: Config; pg: Pg | null; run: Runner }): Promise<Check[]>;
}

export interface WorktreeTools {
  run: Runner;
  git(args: string[], cwd?: string): ReturnType<Runner>;
  /** Resolve a relative path inside a root, refusing symlinks and escapes. */
  safePath(root: string, rel: string): string;
  log(s: string): void;
}

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
  fix?: string;
  required?: boolean;
}
