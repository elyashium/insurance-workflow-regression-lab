/**
 * Workflow versions.
 *
 * A version is an extraction profile plus a guideline configuration. Both
 * halves are data, and both are versioned together, because in practice the
 * two move together: someone widens the label vocabulary in the same sprint
 * someone else raises the appetite ceiling, and when the numbers move afterward
 * nobody can say which change did it. Pinning them into one object is what
 * makes the question answerable.
 *
 * Every threshold below is invented for the demonstration. None of it is real
 * underwriting guidance.
 */

import { V1_PROFILE } from './extractors/v1-regex.js';
import { V2_PROFILE } from './extractors/v2-heuristic.js';
import { V3_PROFILE } from './extractors/v3-llm.js';

/**
 * @typedef {Object} WorkflowVersion
 * @property {string} id
 * @property {string} name
 * @property {string} summary
 * @property {string[]} changes      what moved relative to the previous version
 * @property {any} extractorProfile
 * @property {any} guidelines
 */

/** @type {WorkflowVersion[]} */
export const VERSIONS = [
  {
    id: 'v1-regex',
    name: 'v1 - strict regex',
    summary:
      'The first implementation. Reads the application, the schedule and the loss run, recognises the standard field labels, and requires currency to be written in full. Compares addresses as raw strings.',
    changes: ['Baseline.'],
    extractorProfile: V1_PROFILE,
    guidelines: {
      tivCeiling: 40_000_000,
      lossRatioCeilingPct: 1.5,
      maxMonthsAhead: 12,
      addressMatching: 'exact',
    },
  },
  {
    id: 'v2-heuristic',
    name: 'v2 - tolerant heuristic',
    summary:
      'Widens the label vocabulary, loosens number parsing, brings the broker email and late endorsements into scope, normalises addresses before comparing them, and infers values for blank fields from surrounding prose. Appetite ceiling raised to $50M in the same release.',
    changes: [
      'Label aliases widened (Constr, Bldg Val, Yr Blt, Insured Name (DBA), TIV (stated), Applicant).',
      'Currency parsing accepts bare digits and K/M/B shorthand.',
      'Broker email and endorsement documents brought into scope.',
      'Endorsements applied to scheduled values.',
      'Address matching normalised, with fuzzy fallback inside a shared postcode.',
      'Context back-fill: blank fields inferred from nearby prose.',
      'Appetite ceiling raised from $40M to $50M.',
    ],
    extractorProfile: V2_PROFILE,
    guidelines: {
      tivCeiling: 50_000_000,
      lossRatioCeilingPct: 1.5,
      maxMonthsAhead: 12,
      addressMatching: 'normalized',
    },
  },
  {
    id: 'v2.1-no-backfill',
    name: 'v2.1 - back-fill removed',
    summary:
      'v2 with context back-fill switched off, and nothing else changed. This is the fix: it keeps every improvement v2 made and drops the one heuristic that invented data. Run the diff against v2 to confirm the regression is gone and nothing else moved with it.',
    changes: ['Context back-fill disabled. All other v2 behaviour unchanged.'],
    extractorProfile: { ...V2_PROFILE, id: 'v2.1-no-backfill', contextBackfill: false, passes: 1 },
    guidelines: {
      tivCeiling: 50_000_000,
      lossRatioCeilingPct: 1.5,
      maxMonthsAhead: 12,
      addressMatching: 'normalized',
    },
  },
  {
    id: 'v3-llm',
    name: 'v3 - model extraction',
    summary:
      'Same pipeline and same guidelines as v2, but a chat model (Groq) does the reading instead of the heuristic extractor. No context back-fill: the model is instructed to report null where the packet is blank. Needs GROQ_API_KEY or a seeded response cache.',
    changes: [
      'Extraction delegated to a chat model with evidence-quote resolution.',
      'Model instructed to report null for absent values — no back-fill.',
      'Costs are metered per call (tokens × published rate), not simulated.',
    ],
    extractorProfile: V3_PROFILE,
    guidelines: {
      tivCeiling: 50_000_000,
      lossRatioCeilingPct: 1.5,
      maxMonthsAhead: 12,
      addressMatching: 'normalized',
    },
  },
];

/** The version pair the comparison view opens on. */
export const DEFAULT_COMPARISON = { baseline: 'v1-regex', candidate: 'v2-heuristic' };

/**
 * @param {string} id
 * @returns {WorkflowVersion}
 */
export function getVersion(id) {
  const found = VERSIONS.find((v) => v.id === id);
  if (!found) {
    throw new Error(`Unknown workflow version "${id}". Known: ${VERSIONS.map((v) => v.id).join(', ')}`);
  }
  return found;
}
