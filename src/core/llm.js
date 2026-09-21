/**
 * Groq model adapter with a file-backed response cache.
 *
 * One job: turn a chat request into text plus metered usage, deterministically
 * whenever possible. The cache is the load-bearing piece — keyed by the hash
 * of (model, messages), it makes every model-backed run replayable offline and
 * byte-identical across runs. A cache hit returns before the API key is even
 * consulted, so seeded replays need no network and no key.
 *
 * Configuration (environment only — keys never live in the repo):
 * - `GROQ_API_KEY`   required for live calls, never for cache hits.
 * - `GROQ_MODEL`     override the default model (must be in MODEL_RATES).
 * - `GROQ_CACHE_DIR` override the cache directory (tests point this at tmp).
 * - `GROQ_CACHE=off` bypass the cache (live call even on a hit).
 *
 * A local `.env` file (KEY=VALUE lines, gitignored) is loaded best-effort so
 * `GROQ_API_KEY=... node src/server.js` works without exporting anything.
 */

import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(here, '..', '..');

export const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';

/** Default extraction model: strongest general model on this account's list. */
export const DEFAULT_MODEL = 'openai/gpt-oss-120b';

/**
 * Metered rates in USD per 1M tokens, as published on Groq's price list.
 * Unknown models are refused rather than costed at an invented rate.
 */
export const MODEL_RATES = {
  'openai/gpt-oss-120b': { input: 0.15, output: 0.6, observed: '2026-09-01' },
};

const MAX_TOKENS = 4096;
const TIMEOUT_MS = 90_000;
const RETRIES = 3;

/**
 * At most this many live calls in flight. The free tier meters tokens per
 * minute, so unbounded concurrency turns one suite into a 429 storm that
 * retries then amplify. Cache hits never take a slot.
 */
function maxConcurrent() {
  const n = Number(process.env.GROQ_CONCURRENCY ?? 2);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 2;
}

let inFlight = 0;
/** @type {(() => void)[]} */
const waiters = [];

/** @returns {Promise<() => void>} release function for one network slot */
async function acquireSlot() {
  while (inFlight >= maxConcurrent()) {
    await new Promise((/** @type {(v: void) => void} */ resolve) => waiters.push(resolve));
  }
  inFlight++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    inFlight--;
    waiters.shift()?.();
  };
}

/**
 * How long to wait before retrying: the server's Retry-After first, else a
 * backoff measured in seconds — TPM limits ask for patience, not milliseconds.
 *
 * @param {number} attempt
 * @param {Response | null} res
 * @param {any} data
 */
function retryDelayMs(attempt, res, data) {
  const header = Number(res?.headers?.get?.('retry-after'));
  if (Number.isFinite(header) && header >= 0) return header * 1000;
  const m = /try again in ([\d.]+)s/.exec(data?.error?.message ?? '');
  if (m) return Math.ceil(Number(m[1]) * 1000);
  return 4000 * 2 ** attempt;
}

let envLoaded = false;

/** Load a local `.env` file once, best-effort and silent. Never overrides real env. */
export function loadLocalEnv() {
  if (envLoaded) return;
  envLoaded = true;
  return readFile(join(ROOT_DIR, '.env'), 'utf8')
    .then((raw) => {
      for (const line of raw.split('\n')) {
        const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
        if (!m || m[1] in process.env) continue;
        process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
      }
    })
    .catch(() => {});
}

/** @returns {string} machine-local cache directory */
export function cacheDir() {
  return process.env.GROQ_CACHE_DIR ?? join(ROOT_DIR, 'data', '.llm-cache');
}

/**
 * @param {string} model
 * @param {any[]} messages
 * @returns {string} sha256 of the canonical request
 */
export function cacheKey(model, messages) {
  return createHash('sha256').update(JSON.stringify({ model, messages })).digest('hex');
}

/**
 * @param {string} key
 * @returns {Promise<any|null>} cached completion, or null on miss/error
 */
export async function readCache(key) {
  try {
    return JSON.parse(await readFile(join(cacheDir(), `${key}.json`), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Best-effort atomic write; a cache that cannot be written degrades to live.
 * @param {string} key
 * @param {any} entry
 */
export async function writeCache(key, entry) {
  try {
    const dir = cacheDir();
    await mkdir(dir, { recursive: true });
    const tmp = join(dir, `${key}.${process.pid}.tmp`);
    await writeFile(tmp, `${JSON.stringify(entry, null, 2)}\n`, 'utf8');
    await rename(tmp, join(dir, `${key}.json`));
  } catch {
    /* the call already succeeded — losing the cache entry is not an error */
  }
}

/**
 * Meter a completion. Unknown models throw: inventing a price is worse than
 * refusing the call.
 *
 * @param {string} model
 * @param {{inputTokens: number, outputTokens: number}} usage
 * @returns {{usd: number, model: string, inputTokens: number, outputTokens: number, simulated: false}}
 */
export function meterCost(model, usage) {
  const rates = MODEL_RATES[model];
  if (!rates) {
    throw new Error(
      `No published rate for model "${model}". Known: ${Object.keys(MODEL_RATES).join(', ')}.`,
    );
  }
  const usd = (usage.inputTokens / 1e6) * rates.input + (usage.outputTokens / 1e6) * rates.output;
  return {
    usd: Math.round(usd * 1e6) / 1e6,
    model,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    simulated: false,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {string} model
 * @param {any[]} messages
 * @param {{maxTokens?: number}} [opts]
 * @returns {Promise<{content: string, usage: {inputTokens: number, outputTokens: number, totalTokens: number}, model: string, cached: boolean}>}
 */
export async function complete(model, messages, opts = {}) {
  await loadLocalEnv();
  const key = cacheKey(model, messages);

  if (process.env.GROQ_CACHE !== 'off') {
    const hit = await readCache(key);
    if (hit) return { ...hit, cached: true };
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error(
      'GROQ_API_KEY is not set and the request is not cached. ' +
        'Set the key (env or local .env, never committed) or seed the cache first.',
    );
  }

  const body = JSON.stringify({
    model,
    messages,
    max_tokens: opts.maxTokens ?? MAX_TOKENS,
    response_format: { type: 'json_object' },
  });

  let lastErr = null;
  const release = await acquireSlot();
  try {
    for (let attempt = 0; attempt <= RETRIES; attempt++) {
      let res = null;
      let data = {};
      try {
        res = await fetch(GROQ_API_URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body,
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        data = await res.json().catch(() => ({}));
      } catch (err) {
        lastErr = err;
        if (attempt < RETRIES) {
          await sleep(retryDelayMs(attempt, null, {}));
          continue;
        }
        if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
          throw new Error(`Groq request timed out after ${TIMEOUT_MS}ms`);
        }
        throw err instanceof Error ? err : new Error(String(err));
      }
      if (!res.ok) {
        const retryable = res.status === 429 || res.status >= 500;
        lastErr = new Error(`Groq ${res.status}: ${data?.error?.message ?? 'request failed'}`);
        if (retryable && attempt < RETRIES) {
          await sleep(retryDelayMs(attempt, res, data));
          continue;
        }
        throw lastErr;
      }
      const content = data?.choices?.[0]?.message?.content ?? '';
      const usage = {
        inputTokens: data?.usage?.prompt_tokens ?? 0,
        outputTokens: data?.usage?.completion_tokens ?? 0,
        totalTokens: data?.usage?.total_tokens ?? 0,
      };
      const out = { content, usage, model, cached: false };
      await writeCache(key, out);
      return out;
    }
  } finally {
    release();
  }
  throw lastErr ?? new Error('Groq request failed without a recorded error.');
}
