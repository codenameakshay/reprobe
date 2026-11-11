import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildConfig, setConfig } from '../src/config.ts';
import { caseContext, headlessTools, launchAgent, reprobeCmd } from '../src/agent.ts';
import { main } from '../src/cli.ts';
import type { Gathered } from '../src/types.ts';

const gathered: Gathered = {
  input: { complaint: 'password=supersecret', sinceMs: 1 },
  window: { from: '2026-01-01T00:00:00Z', to: '2026-01-01T00:00:01Z' },
  subject: { sessionIds: [], traceIds: [] },
  sources: [],
  evidence: [],
};

test('CASE.md redacts complaint secrets before writing agent context', () => {
  setConfig(buildConfig(null, {}, '/tmp', { ...process.env, HOME: '/tmp' }));
  const context = caseContext('/tmp/case', gathered, []);
  assert.doesNotMatch(context, /supersecret/);
  assert.match(context, /password=\[redacted\]/);
});

test('REPROBE command shell-quotes paths containing spaces and apostrophes', () => {
  const configPath = "/tmp/reprobe's config/config.json";
  setConfig({ ...buildConfig(null, {}), file: configPath });
  const command = reprobeCmd();
  assert.ok(command.includes("'/tmp/reprobe'\\''s config/config.json'"));
});

test('REPROBE command passes shell metacharacter paths as literal argv', () => {
  const dir = mkdtempSync(join(tmpdir(), 'reprobe-shell-'));
  const marker = join(dir, 'executed');
  const configPath = join(dir, `$(touch executed) \`touch executed\` 'config.json`);
  try {
    writeFileSync(configPath, JSON.stringify({ repo: resolve(import.meta.dirname, '..') }));
    setConfig({ ...buildConfig(null, {}), file: configPath });
    const command = spawnSync('/bin/sh', ['-c', `${reprobeCmd()} --help`], { cwd: dir, encoding: 'utf8' });
    assert.equal(command.status, 0, command.stderr);
    assert.match(command.stdout, /reprobe/);
    assert.equal(existsSync(marker), false, 'shell metacharacters from config path must not execute');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('headless reprobe permissions exclude mutating maintenance commands', () => {
  setConfig(buildConfig(null, {}));
  const tools = headlessTools('/tmp/reprobe-case');
  assert.equal(tools.filter((tool) => tool.includes(' query:*)')).length, 1);
  assert.equal(tools.filter((tool) => tool.includes(' verify:*)')).length, 1);
  assert.equal(tools.filter((tool) => tool.includes(' clean:*)') || tool.includes(' init:*)')).length, 0);
});

test('launchAgent refuses a symlinked CASE.md sink before checking agent CLIs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'reprobe-agent-case-'));
  const external = join(dir, 'source.md');
  const caseDir = join(dir, 'case');
  try {
    mkdirSync(caseDir);
    writeFileSync(external, 'source sentinel');
    symlinkSync(external, join(caseDir, 'CASE.md'));
    await assert.rejects(launchAgent(caseDir, gathered, [], {}), /refusing symlinked checkout path/);
    assert.equal(existsSync(external), true);
    assert.equal(readFileSync(external, 'utf8'), 'source sentinel');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('report command redacts valid diagnosis claims printed to stdout', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'reprobe-report-'));
  const savedWrite = process.stdout.write;
  let stdout = '';
  try {
    writeFileSync(join(dir, 'evidence.json'), JSON.stringify({ ...gathered, evidence: [{ id: 'e1', source: 'test', at: null, kind: 'test', summary: 'ok', data: {} }] }));
    writeFileSync(join(dir, 'diagnosis.json'), JSON.stringify({ rootCause: { text: 'token=sk-lf-123456789abcdef', evidence: ['e1'], confidence: 'high' } }));
    process.stdout.write = ((chunk: string | Uint8Array) => { stdout += chunk.toString(); return true; }) as typeof process.stdout.write;
    await main(['report', dir]);
  } finally {
    process.stdout.write = savedWrite;
    rmSync(dir, { recursive: true, force: true });
  }
  assert.doesNotMatch(stdout, /sk-lf-123456789abcdef/);
});
