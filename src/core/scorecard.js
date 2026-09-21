/**
 * Scoring and version comparison.
 *
 * Two jobs. First, score a run against the hand-labeled ground truth, field by
 * field. Second, diff two versions' scores and say what actually moved.
 *
 * The second job is the one the lab exists for. An aggregate accuracy number
 * is close to useless on its own: two versions can score identically and be
 * wrong about completely different things, and a version can gain three points
 * of accuracy while losing the one field that mattered. So the comparison
 * reports movements, not just totals - every field that was right and became
 * wrong is named, individually, and that list is the gate.
 *
 * A note on what "correct" means for a null. Ground truth records null where a
 * value is genuinely absent from the packet. Reporting null there is scored
 * CORRECT. Inventing a plausible value is scored wrong. This is the whole
 * reason the back-fill regression is visible: it raises no errors, breaks no
 * checks, and simply turns two correct nulls into two confident mistakes.
 */

import { normalizeAddress } from './address.js';
import { SCALAR_FIELDS, LOCATION_FIELDS } from './types.js';

/**
 * @typedef {Object} FieldScore
 * @property {string} key         'insuredName' or 'L2.yearBuilt'
 * @property {any} expected
 * @property {any} actual
 * @property {boolean} correct
 * @property {number} confidence
 * @property {string} method
 */

/**
 * Compare an extracted value to a labeled one.
 *
 * @param {any} expected
 * @param {any} actual
 * @returns {boolean}
 */
export function valuesEqual(expected, actual) {
  if (expected == null && actual == null) return true;
  if (expected == null || actual == null) return false;
  if (typeof expected === 'number' || typeof actual === 'number') {
    return Number(expected) === Number(actual);
  }
  return String(expected).trim().toLowerCase() === String(actual).trim().toLowerCase();
}

/**
 * Score one run against ground truth.
 *
 * @param {any} run
 * @param {any} truth  the ground-truth entry for this packet
 * @returns {{ fields: FieldScore[], correct: number, total: number, accuracy: number }}
 */
export function scoreRun(run, truth) {
  /** @type {FieldScore[]} */
  const fields = [];

  for (const name of SCALAR_FIELDS) {
    const f = run.fields[name];
    const expected = truth.fields[name] ?? null;
    const actual = f?.value ?? null;
    fields.push({
      key: name,
      expected,
      actual,
      correct: valuesEqual(expected, actual),
      confidence: f?.confidence ?? 0,
      method: f?.method ?? 'not-extracted',
    });
  }

  // Locations are matched by normalised address rather than by position: a
  // version that fails to remove a duplicate has an extra row, and scoring
  // positionally after that point would mark every subsequent field wrong for
  // the wrong reason. The extra row is penalised once, below, on its own.
  const produced = run.resolution.locations;
  const claimed = new Set();

  truth.locations.forEach((expectedLoc, i) => {
    const wanted = normalizeAddress(expectedLoc.address);
    let matchIndex = produced.findIndex(
      (l, j) => !claimed.has(j) && normalizeAddress(l.fields.address.value) === wanted,
    );
    if (matchIndex === -1 && !claimed.has(i) && produced[i]) {
      // Fall back to position when the address itself was misread, so the
      // remaining fields on that row are still scored rather than all written
      // off at once.
      matchIndex = i;
    }
    if (matchIndex !== -1) claimed.add(matchIndex);

    const match = matchIndex === -1 ? null : produced[matchIndex];
    const label = match?.locId ?? `expected#${i + 1}`;

    for (const name of LOCATION_FIELDS) {
      const f = match?.fields?.[name];
      const expected = expectedLoc[name] ?? null;
      const actual = f?.value ?? null;
      fields.push({
        key: `${label}.${name}`,
        expected,
        actual,
        correct: match ? valuesEqual(expected, actual) : false,
        confidence: f?.confidence ?? 0,
        method: f?.method ?? 'not-extracted',
      });
    }
  });

  // One item for getting the shape of the schedule right. A version that
  // leaves a duplicated building on the books has not read the schedule
  // correctly, however well it read the individual cells.
  fields.push({
    key: 'locationCount',
    expected: truth.locations.length,
    actual: produced.length,
    correct: produced.length === truth.locations.length,
    confidence: 1,
    method: 'reconciliation',
  });

  const correct = fields.filter((f) => f.correct).length;
  return {
    fields,
    correct,
    total: fields.length,
    accuracy: fields.length ? correct / fields.length : 0,
  };
}

/**
 * Aggregate a set of scored runs into the headline figures.
 *
 * @param {{run: any, score: any}[]} scored
 * @returns {any}
 */
export function summarize(scored) {
  const correct = scored.reduce((sum, s) => sum + s.score.correct, 0);
  const total = scored.reduce((sum, s) => sum + s.score.total, 0);
  const abstained = scored.filter((s) => s.run.routing.abstained).length;

  const decisions = { quote: 0, decline: 0, referred: 0 };
  for (const s of scored) decisions[s.run.routing.decision]++;

  const latencies = scored.map((s) => s.run.durationMs);
  const cost = scored.reduce((sum, s) => sum + s.run.cost.usd, 0);

  return {
    packets: scored.length,
    correct,
    total,
    accuracy: total ? correct / total : 0,
    abstained,
    abstentionRate: scored.length ? abstained / scored.length : 0,
    decisions,
    totalLatencyMs: round(latencies.reduce((a, b) => a + b, 0)),
    meanLatencyMs: latencies.length
      ? round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
      : 0,
    totalCostUsd: Math.round(cost * 1e6) / 1e6,
    meanCostUsd: scored.length ? Math.round((cost / scored.length) * 1e6) / 1e6 : 0,
    costIsSimulated: true,
  };
}

/**
 * Diff two scored version runs.
 *
 * @param {{run: any, score: any}[]} baseline
 * @param {{run: any, score: any}[]} candidate
 * @returns {any}
 */
export function compare(baseline, candidate) {
  const byPacketBase = new Map(baseline.map((s) => [s.run.packetId, s]));
  const byPacketCand = new Map(candidate.map((s) => [s.run.packetId, s]));
  const packetIds = [...byPacketBase.keys()].filter((id) => byPacketCand.has(id)).sort();

  /** @type {any[]} */
  const regressions = [];
  /** @type {any[]} */
  const improvements = [];
  /** @type {any[]} */
  const packets = [];

  for (const packetId of packetIds) {
    const b = byPacketBase.get(packetId);
    const c = byPacketCand.get(packetId);

    const baseFields = new Map(b.score.fields.map((f) => [f.key, f]));
    const candFields = new Map(c.score.fields.map((f) => [f.key, f]));

    /** @type {any[]} */
    const movedFields = [];
    for (const [key, candField] of candFields) {
      const baseField = baseFields.get(key);
      if (!baseField || baseField.correct === candField.correct) continue;

      const movement = {
        packetId,
        packetLabel: b.run.packetLabel,
        key,
        expected: candField.expected,
        baselineValue: baseField.actual,
        candidateValue: candField.actual,
        baselineCorrect: baseField.correct,
        candidateCorrect: candField.correct,
        candidateConfidence: candField.confidence,
        candidateMethod: candField.method,
      };
      movedFields.push(movement);
      (candField.correct ? improvements : regressions).push(movement);
    }

    const routingChanged =
      b.run.routing.decision !== c.run.routing.decision ||
      b.run.routing.abstained !== c.run.routing.abstained;

    const baseFlags = b.run.checks.filter((x) => x.status === 'flag').map((x) => x.id);
    const candFlags = c.run.checks.filter((x) => x.status === 'flag').map((x) => x.id);

    packets.push({
      packetId,
      packetLabel: b.run.packetLabel,
      edgeCases: b.run.edgeCases ?? [],
      baseline: packetSide(b),
      candidate: packetSide(c),
      routingChanged,
      flagsAdded: candFlags.filter((id) => !baseFlags.includes(id)),
      flagsRemoved: baseFlags.filter((id) => !candFlags.includes(id)),
      movedFields,
      netFieldDelta: c.score.correct - b.score.correct,
    });
  }

  const baseSummary = summarize(baseline);
  const candSummary = summarize(candidate);

  // Slice the movement by planted edge case. Packets carry their edge-case
  // tags, so every moved field is attributed to each tag on its packet. A
  // packet with three tags counts in three slices — slices overlap by design
  // and are diagnostic, not additive. Only slices with movement are reported.
  /** @type {Map<string, {slice: string, packets: Set<string>, regressions: number, improvements: number}>} */
  const sliceMap = new Map();
  for (const p of packets) {
    if (!p.movedFields.length) continue;
    const tags = p.edgeCases.length ? p.edgeCases : ['none'];
    for (const tag of tags) {
      let s = sliceMap.get(tag);
      if (!s) {
        s = { slice: tag, packets: new Set(), regressions: 0, improvements: 0 };
        sliceMap.set(tag, s);
      }
      s.packets.add(p.packetId);
      for (const m of p.movedFields) {
        if (m.candidateCorrect) s.improvements++;
        else s.regressions++;
      }
    }
  }
  const slices = [...sliceMap.values()]
    .map((s) => ({
      slice: s.slice,
      packets: s.packets.size,
      regressions: s.regressions,
      improvements: s.improvements,
      net: s.improvements - s.regressions,
    }))
    .sort((a, b) => b.regressions - a.regressions || b.improvements - a.improvements || (a.slice < b.slice ? -1 : 1));

  return {
    baselineVersionId: baseline[0]?.run.versionId ?? null,
    candidateVersionId: candidate[0]?.run.versionId ?? null,
    summary: {
      baseline: baseSummary,
      candidate: candSummary,
      delta: {
        accuracy: candSummary.accuracy - baseSummary.accuracy,
        correct: candSummary.correct - baseSummary.correct,
        abstentionRate: candSummary.abstentionRate - baseSummary.abstentionRate,
        meanLatencyMs: round(candSummary.meanLatencyMs - baseSummary.meanLatencyMs),
        totalCostUsd: Math.round((candSummary.totalCostUsd - baseSummary.totalCostUsd) * 1e6) / 1e6,
      },
    },
    regressions,
    improvements,
    packets,
    slices,
    /**
     * The gate. A candidate that loses even one previously-correct field does
     * not ship on the strength of a better average.
     */
    verdict: regressions.length === 0 ? 'clean' : 'regressed',
  };
}

/**
 * Confidence calibration: do the extractor's confidences mean what they say?
 *
 * Every scored field (value AND nulls — an asserted absence carries a
 * confidence too) is bucketed by the confidence it was reported with, and
 * each bucket reports its empirical accuracy. A healthy extractor is
 * diagonal: the 0.9+ bucket is right ~95% of the time, the sub-0.6 bucket is
 * little better than a coin flip. The bands align with the pipeline's own
 * cutoffs: 0.6 is the low-confidence floor, 0.50 is what back-fill emits.
 */
const CALIBRATION_BANDS = [
  { lo: 0, hi: 0.6, label: '<0.6' },
  { lo: 0.6, hi: 0.8, label: '0.6–0.8' },
  { lo: 0.8, hi: 0.9, label: '0.8–0.9' },
  { lo: 0.9, hi: 1.0001, label: '≥0.9' },
];

/**
 * @param {{run: any, score: any}[]} scored
 * @returns {{range: string, n: number, correct: number, accuracy: number | null}[]}
 */
export function calibration(scored) {
  const bands = CALIBRATION_BANDS.map((b) => ({ ...b, n: 0, correct: 0 }));
  for (const s of scored) {
    for (const f of s.score.fields) {
      const band = bands.find((b) => f.confidence >= b.lo && f.confidence < b.hi) ?? bands[bands.length - 1];
      band.n++;
      if (f.correct) band.correct++;
    }
  }
  return bands.map((b) => ({
    range: b.label,
    n: b.n,
    correct: b.correct,
    accuracy: b.n ? b.correct / b.n : null,
  }));
}

/**
 * @param {{run: any, score: any}} s
 */
function packetSide(s) {
  return {
    versionId: s.run.versionId,
    decision: s.run.routing.decision,
    abstained: s.run.routing.abstained,
    reasons: s.run.routing.reasons,
    correct: s.score.correct,
    total: s.score.total,
    accuracy: s.score.accuracy,
    durationMs: s.run.durationMs,
    costUsd: s.run.cost.usd,
    flags: s.run.checks.filter((c) => c.status === 'flag').map((c) => c.id),
    conflicts: s.run.conflicts.map((c) => ({ id: c.id, severity: c.severity, title: c.title })),
  };
}

/**
 * @param {number} n
 */
function round(n) {
  return Math.round(n * 1000) / 1000;
}
