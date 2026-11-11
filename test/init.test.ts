import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { detect, writeInit } from '../src/init.ts';

/** A throwaway repo with the given files (relative path -> content). */
function withRepo(files: Record<string, string>, fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'reprobe-init-'));
  try {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), content);
    }
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('detect finds Postgres from a Prisma schema and names the env var, not its value', () => {
  withRepo({ 'prisma/schema.prisma': 'datasource db {\n  provider = "postgresql"\n  url      = env("DB_URL")\n}\n' }, (dir) => {
    assert.deepEqual(detect(dir).config.sources?.postgres, { url: 'env:DB_URL' });
  });
});

test('detect finds Sentry from the SDK and reads org and project from .sentryclirc', () => {
  withRepo({
    'package.json': '{"dependencies":{"@sentry/node":"8.0.0"}}',
    '.sentryclirc': '[defaults]\norg = acme-co\nproject = api\n',
  }, (dir) => {
    assert.deepEqual(detect(dir).config.sources?.sentry, { org: 'acme-co', projects: ['api'] });
  });
});

test('detect finds a Fly app from fly.toml as a command log source', () => {
  withRepo({ 'fly.toml': 'app = "my-api"\n' }, (dir) => {
    assert.deepEqual(detect(dir).config.sources?.logs, [{ name: 'fly my-api', command: ['fly', 'logs', '-a', 'my-api', '--no-tail'] }]);
  });
});

test('detect adds a nodeModules setup step when package.json and a lockfile exist', () => {
  withRepo({ 'package.json': '{}', 'package-lock.json': '{}' }, (dir) => {
    assert.deepEqual(detect(dir).config.verify?.setup, [{ nodeModules: '.' }]);
  });
});

test('detect never puts a secret value in the config, even when a .env file holds one', () => {
  withRepo({
    'package.json': '{"dependencies":{"pg":"8.11.0"}}',
    '.env': 'DATABASE_URL=postgres://secret@db.example/app\n',
  }, (dir) => {
    const { config } = detect(dir);
    assert.deepEqual(config.sources?.postgres, { url: 'env:DATABASE_URL' });
    assert.equal(JSON.stringify(config).includes('secret'), false);
  });
});

test('writeInit refuses to overwrite an existing .reprobe/config.json without force', () => {
  withRepo({ '.reprobe/config.json': '{}' }, (dir) => {
    assert.throws(() => writeInit(dir, false), /exists/);
    assert.equal(readFileSync(join(dir, '.reprobe/config.json'), 'utf8'), '{}');
  });
});

test('writeInit creates .reprobe/config.json when none exists', () => {
  withRepo({ 'package.json': '{}' }, (dir) => {
    const { path } = writeInit(dir, false);
    assert.equal(existsSync(path), true);
    assert.ok('sources' in JSON.parse(readFileSync(path, 'utf8')));
  });
});
