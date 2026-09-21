/**
 * Groq adapter units: metering, cache, evidence resolution, prompt shape.
 *
 * Nothing here touches the network. Live behaviour is covered by the
 * conditional v3 block in pipeline.integration.test.js, which runs with
 * GROQ_API_KEY or a seeded cache and skips otherwise.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  meterCost,
  cacheKey,
  readCache,
  writeCache,
  complete,
  DEFAULT_MODEL,
} from '../src/core/llm.js';
import { buildPrompt, spanForQuote } from '../src/core/extractors/v3-llm.js';
import { loadAllPackets } from '../src/core/packets.js';
import { indexDocument } from '../src/core/text.js';

const packets = await loadAllPackets();
const pkt002 = packets.find((p) => p.packetId === 'PKT-002');

/** Run fn with temporary env overrides, restored afterwards. */
async function withEnv(overrides, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(overrides)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('metering multiplies metered tokens by the published rate', () => {
  const cost = meterCost('openai/gpt-oss-120b', { inputTokens: 1_000_000, outputTokens: 1_000_000 });
  assert.equal(cost.usd, 0.75);
  assert.equal(cost.simulated, false);
  assert.equal(cost.model, 'openai/gpt-oss-120b');
});

test('unknown models are refused, not costed at an invented rate', () => {
  assert.throws(() => meterCost('imaginary-model', { inputTokens: 10, outputTokens: 10 }), /No published rate/);
});

test('cache keys are deterministic and request-scoped', () => {
  const a = [{ role: 'user', content: 'same' }];
  const b = [{ role: 'user', content: 'different' }];
  assert.equal(cacheKey(DEFAULT_MODEL, a), cacheKey(DEFAULT_MODEL, a));
  assert.notEqual(cacheKey(DEFAULT_MODEL, a), cacheKey(DEFAULT_MODEL, b));
  assert.notEqual(cacheKey('other-model', a), cacheKey(DEFAULT_MODEL, a));
});

test('a cached response replays without a key and without the network', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'iwrl-cache-'));
  const messages = [{ role: 'user', content: `cache-probe-${Date.now()}` }];
  const key = cacheKey(DEFAULT_MODEL, messages);
  const entry = {
    content: '{"insuredName":{"value":"Probe LLC","quote":null}}',
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    model: DEFAULT_MODEL,
    cached: false,
  };
  await withEnv({ GROQ_CACHE_DIR: dir, GROQ_API_KEY: undefined, GROQ_CACHE: undefined }, async () => {
    await writeCache(key, entry);
    assert.deepEqual(await readCache(key), entry);
    const out = await complete(DEFAULT_MODEL, messages);
    assert.equal(out.cached, true);
    assert.equal(out.content, entry.content);
    assert.deepEqual(out.usage, entry.usage);
  });
});

test('an uncached call without a key fails loudly, naming the key', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'iwrl-cache-empty-'));
  await withEnv({ GROQ_CACHE_DIR: dir, GROQ_API_KEY: undefined, GROQ_CACHE: 'off' }, async () => {
    await assert.rejects(
      () => complete(DEFAULT_MODEL, [{ role: 'user', content: 'will-not-resolve' }]),
      /GROQ_API_KEY/,
    );
  });
});

test('the prompt is deterministic for a packet and names its documents', () => {
  const a = buildPrompt(pkt002, { documents: ['acord', 'sov'], model: DEFAULT_MODEL });
  const b = buildPrompt(pkt002, { documents: ['acord', 'sov'], model: DEFAULT_MODEL });
  assert.deepEqual(a, b);
  assert.ok(a.messages[1].content.includes('=== DOCUMENT acord'));
  assert.ok(a.messages[1].content.includes('=== DOCUMENT sov'));
  assert.ok(!a.messages[1].content.includes('=== DOCUMENT email'));
});

test('quotes resolve to exact spans, misses resolve to null', () => {
  const doc = indexDocument('sov', 'sov.txt', 'Row one\nNeedle in a haystack\nRow three');
  const span = spanForQuote([doc], 'Needle in a haystack');
  assert.ok(span);
  assert.equal(span.docId, 'sov');
  assert.equal(doc.text.slice(span.start, span.end), 'Needle in a haystack');
  assert.equal(spanForQuote([doc], 'no such text anywhere'), null);
  assert.equal(spanForQuote([doc], null), null);
});
