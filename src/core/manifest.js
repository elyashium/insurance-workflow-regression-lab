/**
 * Run manifests: hash-pinned provenance for every suite.
 *
 * A manifest answers "exactly what ran?" without storing the runs: the corpus
 * hash (packets + ground truth as executed, so perturbed runs hash
 * differently), the extractor-profile hash (any config change moves it), the
 * guidelines, and the per-packet outcomes. Two manifests with equal hashes
 * describe bit-identical inputs; only timestamps and latencies may differ.
 */

import { createHash } from 'node:crypto';

/**
 * Canonical serialization: sorted keys, functions by source. Two configs that
 * behave identically but are written differently still hash differently — the
 * manifest pins the artifact, not the semantics.
 *
 * @param {any} value
 * @returns {string}
 */
export function stableStringify(value) {
  if (typeof value === 'function') return `fn:${value.toString()}`;
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * @param {any} value
 * @returns {string} sha256 hex
 */
export function hashOf(value) {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

/**
 * Hash what a suite actually executed: packet documents plus the ground
 * truth they were scored against.
 *
 * @param {import('./packets.js').Packet[]} packets
 * @param {any} groundTruth
 */
export function hashCorpus(packets, groundTruth) {
  return hashOf({
    packets: [...packets]
      .sort((a, b) => (a.packetId < b.packetId ? -1 : 1))
      .map((p) => ({
        packetId: p.packetId,
        documents: [...p.documents]
          .sort((a, b) => (a.docId < b.docId ? -1 : 1))
          .map((d) => ({ docId: d.docId, text: d.text })),
      })),
    groundTruth,
  });
}

/**
 * @param {any} extractorProfile
 */
export function hashProfile(extractorProfile) {
  return hashOf(extractorProfile);
}

/**
 * @param {any} suite  a scored suite from runSuite
 * @param {{corpusHash: string, profileHash: string}} hashes
 */
export function buildManifest(suite, hashes) {
  return {
    versionId: suite.versionId,
    createdAt: new Date().toISOString(),
    corpusHash: hashes.corpusHash,
    profileHash: hashes.profileHash,
    guidelines: suite.guidelines,
    packets: suite.scored.map((s) => ({
      packetId: s.run.packetId,
      decision: s.run.routing.decision,
      abstained: s.run.routing.abstained,
      correct: s.score.correct,
      total: s.score.total,
    })),
  };
}
