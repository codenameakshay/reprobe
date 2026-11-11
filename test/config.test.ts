import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { symlinkSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertCasesOutsideRepo, buildConfig, findConfigFile } from '../src/config.ts';

test('relative paths in a non-.reprobe config are based on that config directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'reprobe-config-'));
  try {
    const cfg = buildConfig(join(dir, 'config.json'), { repo: join(dir, 'checkout'), sources: { archive: { dir: 'transcripts', glob: '*.jsonl' } } }, dir);
    assert.equal(cfg.sources.archive?.dir, join(dir, 'transcripts'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--config takes precedence over env config, then env config over git discovery', () => {
  const dir = mkdtempSync(join(tmpdir(), 'reprobe-config-order-'));
  try {
    const repo = join(dir, 'repo');
    const reprobeDir = join(repo, '.reprobe');
    mkdirSync(reprobeDir, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: repo });
    const discovered = join(reprobeDir, 'config.json');
    const envFile = join(dir, 'env.json');
    const flagFile = join(dir, 'flag.json');
    writeFileSync(discovered, '{}');
    writeFileSync(envFile, '{}');
    writeFileSync(flagFile, '{}');

    assert.equal(findConfigFile(flagFile, repo, { REPROBE_CONFIG: envFile }), flagFile);
    assert.equal(findConfigFile(undefined, repo, { REPROBE_CONFIG: envFile }), envFile);
    assert.equal(findConfigFile(undefined, repo, {}), realpathSync(discovered));
    rmSync(discovered);
    assert.equal(findConfigFile(undefined, repo, {}), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case directory inside checkout is rejected, including via a symlink alias', () => {
  const dir = mkdtempSync(join(tmpdir(), 'reprobe-cases-'));
  try {
    const repo = join(dir, 'repo');
    mkdirSync(repo);
    const alias = join(dir, 'repo-alias');
    symlinkSync(repo, alias);
    assert.throws(() => assertCasesOutsideRepo(join(repo, 'cases'), repo), /outside the repo/);
    assert.throws(() => assertCasesOutsideRepo(join(repo, '..evidence'), repo), /outside the repo/);
    assert.throws(() => assertCasesOutsideRepo(join(alias, 'cases'), repo), /outside the repo/);
    assert.doesNotThrow(() => assertCasesOutsideRepo(join(dir, 'cases'), repo));
    assert.doesNotThrow(() => assertCasesOutsideRepo(join(dir, 'repo-other'), repo));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case directory inside an unrelated git checkout is rejected', () => {
  const dir = mkdtempSync(join(tmpdir(), 'reprobe-cases-git-'));
  try {
    const configuredRepo = join(dir, 'configured');
    const unrelatedRepo = join(dir, 'unrelated');
    mkdirSync(configuredRepo);
    mkdirSync(unrelatedRepo);
    execFileSync('git', ['init', '-q'], { cwd: unrelatedRepo });
    assert.throws(() => assertCasesOutsideRepo(join(unrelatedRepo, 'case'), configuredRepo), /outside the repo/);
    assert.throws(() => assertCasesOutsideRepo(join(unrelatedRepo, 'nested', 'case'), configuredRepo), /outside the repo/);
    assert.doesNotThrow(() => assertCasesOutsideRepo(join(dir, 'external-case'), configuredRepo));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a case directory git ignores is allowed, inside the configured repo or another one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'reprobe-cases-ignored-'));
  try {
    const repo = join(dir, 'repo');
    mkdirSync(repo);
    execFileSync('git', ['init', '-q'], { cwd: repo });
    writeFileSync(join(repo, '.gitignore'), 'cases/\n');
    assert.doesNotThrow(() => assertCasesOutsideRepo(join(repo, 'cases', 'run1', 'case'), repo));
    assert.doesNotThrow(() => assertCasesOutsideRepo(join(repo, 'cases', 'x'), join(dir, 'elsewhere')));
    assert.throws(() => assertCasesOutsideRepo(join(repo, 'notes', 'case'), repo), /outside the repo/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
