#!/usr/bin/env node
// A checkout runs src/ directly (Node strips the types); the published package ships only dist/.
import { existsSync } from 'node:fs';
const src = new URL('../src/cli.ts', import.meta.url);
const { run } = await import(existsSync(src) ? src.href : new URL('../dist/cli.js', import.meta.url).href);
await run(process.argv.slice(2));
