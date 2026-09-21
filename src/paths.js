/**
 * Filesystem locations, resolved relative to this file so the app works no
 * matter which directory it is started from.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** Repository root. */
export const ROOT_DIR = join(here, '..');

/** Seed corpus and ground truth. */
export const DATA_DIR = join(ROOT_DIR, 'data');

/** One directory per synthetic submission packet. */
export const PACKETS_DIR = join(DATA_DIR, 'packets');

/** Persisted runs, traces and human review decisions. */
export const STORE_DIR = process.env.VERCEL
  // Serverless filesystems are read-only except /tmp, and /tmp is ephemeral:
  // reviews survive warm invocations but are not durable on Vercel. Runs are
  // pure functions of the corpus so nothing else needs the disk.
  ? join('/tmp', 'iwrl-store')
  : join(DATA_DIR, 'store');

/** Static frontend assets. */
export const PUBLIC_DIR = join(ROOT_DIR, 'public');
