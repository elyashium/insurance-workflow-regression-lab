/**
 * Test runner: `node --test` over every `test/*.test.js` file.
 *
 * Why this file exists instead of `node --test test/` in package.json:
 * Node 20 treats a bare directory argument as "scan this directory", while
 * Node 22 treats it as a module to load and dies with MODULE_NOT_FOUND — and
 * quoted globs only work on 22+. Enumerating the files here behaves
 * identically on every supported Node (see `engines` in package.json) and in
 * every shell, because no shell ever expands a glob.
 *
 * Usage: `node scripts/test.mjs [-- <extra node --test flags>]`
 */

import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

/**
 * Helper modules that also define tests (their self-check guards every unit
 * test's baseline assumption, so they must run — the old `node --test test/`
 * directory scan picked them up implicitly).
 */
const SELF_TESTING_HELPERS = ['fixtures.js'];

const files = readdirSync(new URL('../test/', import.meta.url))
  .filter((f) => f.endsWith('.test.js') || SELF_TESTING_HELPERS.includes(f))
  .sort()
  .map((f) => `test/${f}`);

if (!files.length) {
  console.error('scripts/test.mjs: no test/*.test.js files found');
  process.exit(1);
}

const extra = process.argv.includes('--') ? process.argv.slice(process.argv.indexOf('--') + 1) : [];
const res = spawnSync(process.execPath, ['--test', ...extra, ...files], { stdio: 'inherit' });
process.exit(res.status ?? 1);
