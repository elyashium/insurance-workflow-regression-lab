/**
 * Perturbations: deterministic degradation, measured robustness.
 *
 * Degraded input must degrade identically every time (or the "robustness"
 * number is noise), must never touch the input packet, and must move the
 * strict parser more than the tolerant one. Everything below is synthetic.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { loadAllPackets, loadGroundTruth } from '../src/core/packets.js';
import { runSuite } from '../src/core/lab.js';
import { perturbPacket, perturbText, PERTURB_PROFILES, rngFor } from '../src/core/perturb.js';

const packets = await loadAllPackets();
const groundTruth = await loadGroundTruth();

/** @param {string} versionId @param {any[]} pkt */
async function accuracyOf(versionId, pkt) {
  const suite = await runSuite(versionId, { groundTruth, packets: pkt });
  return suite.summary.accuracy;
}

test('degradation is deterministic per packet, profile, and document', async () => {
  const pkt = packets[0];
  for (const profile of Object.keys(PERTURB_PROFILES)) {
    const a = perturbPacket(pkt, profile);
    const b = perturbPacket(pkt, profile);
    assert.deepEqual(
      a.documents.map((d) => d.text),
      b.documents.map((d) => d.text),
      `${profile} is not deterministic`,
    );
  }
  assert.equal(rngFor('same')(), rngFor('same')());
  assert.notEqual(rngFor('same')(), rngFor('other'));
});

test('perturbation never mutates its input', async () => {
  const pkt = packets[1];
  const before = JSON.stringify(pkt);
  perturbPacket(pkt, 'ocr-heavy');
  assert.equal(JSON.stringify(pkt), before);
});

test('unknown profiles fail loudly', () => {
  assert.throws(() => perturbText('text', 'mold-and-fire', 'PKT-001/sov'), /Unknown perturbation profile/);
});

test('heavy OCR degrades the strict parser; layout furniture does not move it', async () => {
  const clean = await accuracyOf('v1-regex', packets);
  const light = await accuracyOf(
    'v1-regex',
    packets.map((p) => perturbPacket(p, 'ocr-light')),
  );
  const heavy = await accuracyOf(
    'v1-regex',
    packets.map((p) => perturbPacket(p, 'ocr-heavy')),
  );
  const layout = await accuracyOf(
    'v1-regex',
    packets.map((p) => perturbPacket(p, 'pdf-layout')),
  );

  assert.ok(light <= clean, 'light OCR should not improve a strict parser');
  assert.ok(heavy < clean, 'heavy OCR must cost the strict parser accuracy');
  assert.equal(layout, clean, 'page furniture must not fool a line-oriented reader');
});

test('three profiles are published', () => {
  assert.deepEqual(Object.keys(PERTURB_PROFILES).sort(), ['ocr-heavy', 'ocr-light', 'pdf-layout']);
});
