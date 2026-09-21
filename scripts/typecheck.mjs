/**
 * Typecheck runner: `tsc --noEmit` over the JSDoc annotations without adding
 * any dependency to the repo.
 *
 * The repo stays dependency-free (runtime AND dev), so `tsc` and `@types/node`
 * cannot live in package.json. Instead this script installs them into a fresh
 * temp directory on every run and points the compiler at it via `--typeRoots`.
 * Needs the network; the check itself is hermetic apart from that.
 *
 * Usage: `node scripts/typecheck.mjs [--install-only]`
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const TYPESCRIPT_PIN = 'typescript@5';
const NODE_TYPES_PIN = '@types/node@22';

const dir = mkdtempSync(join(tmpdir(), 'iwrl-typecheck-'));
try {
  // NOTE: `shell: true` is required on Windows to spawn npm at all.
  execFileSync('npm', [
    'install', '--prefix', dir, '--no-audit', '--no-fund', '--no-save',
    TYPESCRIPT_PIN, NODE_TYPES_PIN,
  ], { stdio: 'inherit', shell: process.platform === 'win32' });

  if (process.argv.includes('--install-only')) process.exit(0);

  const tsc = join(dir, 'node_modules', 'typescript', 'bin', 'tsc');
  const typeRoots = join(dir, 'node_modules', '@types');
  const res = spawnSync(process.execPath, [tsc, '--noEmit', '-p', 'tsconfig.json', '--typeRoots', typeRoots], {
    stdio: 'inherit',
  });
  process.exitCode = res.status ?? 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
