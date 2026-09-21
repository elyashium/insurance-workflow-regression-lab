/**
 * Fault drills: mutation-test the gate itself.
 *
 * The scorecard claims that any lost field blocks a release. A drill checks
 * that claim the way mutation testing checks a test suite — by deliberately
 * injecting the failure and confirming the gate fires. Each drill clones the
 * candidate's scored runs, sabotages them in one precise way, re-runs the
 * diff, and reports whether the gate caught it and named the field.
 *
 * Three drills, each aimed at a way gates get fooled in practice:
 *
 * - `single-field`: one correct field goes wrong. The minimum a gate must see.
 * - `blank-fill`: a correctly-reported absence becomes an invented value —
 *   the PKT-002 pattern, replayed anywhere in the corpus.
 * - `decoy-gains`: one field breaks while up to five others improve, so the
 *   average goes UP. The gate must still block. This is the whole thesis as
 *   an executable check.
 *
 * Everything here is deterministic: targets are picked in packet/key order,
 * so the same corpus always produces the same drills.
 */

import { compare } from './scorecard.js';

/**
 * @param {{run: any, score: any}[]} scored
 * @returns {{packetId: string, field: any} | null} first correct field in order
 */
function firstCorrect(scored, want = () => true) {
  for (const s of scored) {
    const fields = [...s.score.fields].sort((a, b) => (a.key < b.key ? -1 : 1));
    for (const field of fields) {
      if (field.correct && want(field)) return { packetId: s.run.packetId, field };
    }
  }
  return null;
}

/**
 * @param {any} expected
 * @returns {any} a value guaranteed to differ from it
 */
function injectWrong(expected) {
  if (expected == null) return 'Injected value';
  if (typeof expected === 'number') return expected + 1;
  return `${String(expected)} (injected)`;
}

/**
 * @param {{run: any, score: any}[]} scored
 * @returns {{run: any, score: any}[]} a deep copy the drills can sabotage freely
 */
function cloneScored(scored) {
  return structuredClone(scored);
}

/**
 * @param {{run: any, score: any}[]} baselineScored
 * @param {{run: any, score: any}[]} candidateScored
 * @returns {{id: string, title: string, description: string, flipped: any[], fixed: number, verdict: string, caught: boolean}[]}
 */
export function runDrills(baselineScored, candidateScored) {
  /** @type {{id: string, title: string, description: string, flipped: any[], fixed: number, verdict: string, caught: boolean}[]} */
  const drills = [];

  // Drill 1 — one correct field goes wrong.
  {
    const mutated = cloneScored(candidateScored);
    const target = firstCorrect(mutated);
    /** @type {any[]} */
    const flipped = [];
    if (target) {
      const injected = injectWrong(target.field.expected);
      flipped.push({
        packetId: target.packetId,
        key: target.field.key,
        expected: target.field.expected,
        injected,
      });
      target.field.actual = injected;
      target.field.correct = false;
    }
    const { verdict } = compare(baselineScored, mutated);
    drills.push({
      id: 'single-field',
      title: 'Single invented field',
      description: 'One correct field is replaced with a wrong value. The gate must name it.',
      flipped,
      fixed: 0,
      verdict,
      caught: verdict === 'regressed',
    });
  }

  // Drill 2 — a correctly-reported absence becomes an invented value.
  {
    const mutated = cloneScored(candidateScored);
    const target = firstCorrect(mutated, (f) => f.expected == null);
    /** @type {any[]} */
    const flipped = [];
    if (target) {
      const injected = injectWrong(target.field.expected);
      flipped.push({
        packetId: target.packetId,
        key: target.field.key,
        expected: target.field.expected,
        injected,
      });
      target.field.actual = injected;
      target.field.correct = false;
    }
    const { verdict } = compare(baselineScored, mutated);
    drills.push({
      id: 'blank-fill',
      title: 'Hallucinated into a blank',
      description: 'A field the packet genuinely leaves blank is filled with a plausible value — the PKT-002 pattern, replayed anywhere.',
      flipped,
      fixed: 0,
      verdict,
      caught: verdict === 'regressed',
    });
  }

  // Drill 3 — the average improves while one field breaks. The gate must
  // still block: this drill is the lab's thesis, executable.
  {
    const mutated = cloneScored(candidateScored);
    const target = firstCorrect(mutated);
    /** @type {any[]} */
    const flipped = [];
    let fixed = 0;
    if (target) {
      const injected = injectWrong(target.field.expected);
      flipped.push({
        packetId: target.packetId,
        key: target.field.key,
        expected: target.field.expected,
        injected,
      });
      target.field.actual = injected;
      target.field.correct = false;

      for (const s of mutated) {
        if (fixed >= 5) break;
        const fields = [...s.score.fields].sort((a, b) => (a.key < b.key ? -1 : 1));
        for (const field of fields) {
          if (fixed >= 5) break;
          if (field.correct) continue;
          // Don't "fix" the field this drill just broke.
          if (s.run.packetId === target.packetId && field.key === target.field.key) continue;
          field.actual = field.expected;
          field.correct = true;
          fixed++;
        }
      }
    }
    const { verdict } = compare(baselineScored, mutated);
    drills.push({
      id: 'decoy-gains',
      title: 'Gains that hide a loss',
      description: `One field breaks while ${fixed} other${fixed === 1 ? '' : 's'} improve, so the average goes up. The gate must still block.`,
      flipped,
      fixed,
      verdict,
      caught: verdict === 'regressed',
    });
  }

  return drills;
}
