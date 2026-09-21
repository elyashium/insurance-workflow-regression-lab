/**
 * Run manifests: hash-pinned provenance for every suite.
 *
 * Equal inputs must hash equal; any moved byte must move the hash. Timestamps
 * are the only thing allowed to differ between identical runs.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { loadAllPackets, loadGroundTruth } from '../src/core/packets.js';
import { runSuite } from '../src/core/lab.js';
import { getVersion } from '../src/core/versions.js';
import { perturbPacket } from '../src/core/perturb.js';
import { stableStringify, hashOf, hashCorpus, hashProfile } from '../src/core/manifest.js';

const packets = await loadAllPackets();
const groundTruth = await loadGroundTruth();

test('stable stringify orders keys and pins functions by source', () => {
  assert.equal(stableStringify({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(stableStringify({ b: 1, a: 2 }), stableStringify({ a: 2, b: 1 }));
  assert.ok(stableStringify({ f() { return 1; } }).startsWith('{"f":fn:'));
});

test('identical runs share corpus and profile hashes; timestamps may differ', async () => {
  const a = await runSuite('v2-heuristic');
  const b = await runSuite('v2-heuristic');
  assert.equal(a.manifest.corpusHash, b.manifest.corpusHash);
  assert.equal(a.manifest.profileHash, b.manifest.profileHash);
  assert.deepEqual(a.manifest.packets, b.manifest.packets.map((p) => ({ ...p })));
  assert.deepEqual(a.manifest.guidelines, b.manifest.guidelines);
});

test('different profiles and different corpora hash differently', async () => {
  const v1 = await runSuite('v1-regex');
  const v2 = await runSuite('v2-heuristic');
  assert.notEqual(v1.manifest.profileHash, v2.manifest.profileHash);
  assert.equal(v1.manifest.corpusHash, v2.manifest.corpusHash, 'same corpus in, same hash out');

  const degraded = packets.map((p) => perturbPacket(p, 'ocr-heavy'));
  const noisy = await runSuite('v1-regex', { groundTruth, packets: degraded });
  assert.notEqual(noisy.manifest.corpusHash, v1.manifest.corpusHash);
  assert.equal(noisy.manifest.profileHash, v1.manifest.profileHash);
});

test('hashCorpus matches the manifest and hashProfile matches the version', async () => {
  const suite = await runSuite('v1-regex');
  assert.equal(hashCorpus(packets, groundTruth), suite.manifest.corpusHash);
  assert.equal(hashProfile(getVersion('v1-regex').extractorProfile), suite.manifest.profileHash);
  assert.ok(/^[0-9a-f]{64}$/.test(suite.manifest.corpusHash));
});
