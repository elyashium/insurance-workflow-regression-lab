/**
 * Shared shapes for the pipeline.
 *
 * Kept as JSDoc typedefs rather than TypeScript so the project runs on a bare
 * Node install with no build step and no dependency download. `tsconfig.json`
 * turns these into real type checking via `checkJs` for anyone who wants it.
 */

/**
 * A single extracted value, always carrying its provenance.
 *
 * `value === null` is a meaningful answer, not an error: it asserts the packet
 * does not contain this field. Reporting null where the source is genuinely
 * blank is scored as CORRECT. Inventing a plausible value there is scored as
 * wrong, and is the specific regression v2 introduces on PKT-002.
 *
 * @typedef {Object} ExtractedField
 * @property {string} name
 * @property {any} value
 * @property {number} confidence         0..1
 * @property {import('./text.js').Span | null} evidence
 * @property {string | null} note        why the value is what it is
 * @property {string} method             which rule produced it, for the trace
 */

/**
 * @typedef {Object} LocationRecord
 * @property {string} locId
 * @property {Record<string, ExtractedField>} fields
 * @property {import('./text.js').Span | null} sourceSpan
 * @property {string | null} isDuplicateOf  locId of the row this repeats, or null
 */

/**
 * @typedef {Object} LossRecord
 * @property {string} lossId
 * @property {Record<string, ExtractedField>} fields
 * @property {import('./text.js').Span | null} sourceSpan
 */

/**
 * A value change requested after the schedule was issued.
 *
 * @typedef {Object} Endorsement
 * @property {string} endorsementId
 * @property {string | null} endorsementDate
 * @property {string | null} locHintId       location id named on the row
 * @property {string | null} locHintAddress  address named on the row
 * @property {string} targetField            our field name, e.g. buildingValue
 * @property {number | null} fromValue
 * @property {number} toValue
 * @property {import('./text.js').Span | null} span
 */

/**
 * @typedef {Object} ExtractionResult
 * @property {Record<string, ExtractedField>} fields
 * @property {LocationRecord[]} locations      as listed, before deduplication
 * @property {LossRecord[]} losses
 * @property {Endorsement[]} endorsements      empty unless the version reads them
 * @property {string[]} notes
 * @property {string[]} documentsRead
 * @property {number} inputChars
 * @property {number} passes
 * @property {number} outputTokensEstimate
 */

/**
 * @typedef {Object} CheckResult
 * @property {string} id
 * @property {string} title
 * @property {'pass'|'flag'|'not_evaluated'} status
 * @property {string} detail
 * @property {Record<string, any>} inputs      the figures the rule ran on
 * @property {import('./text.js').Span[]} evidence
 * @property {string} disclaimer               invented-threshold disclaimer
 */

/**
 * @typedef {Object} Conflict
 * @property {string} id
 * @property {string} title
 * @property {'low'|'medium'|'high'} severity
 * @property {string} detail
 * @property {import('./text.js').Span[]} evidence
 */

/**
 * Build an ExtractedField.
 *
 * @param {string} name
 * @param {any} value
 * @param {number} confidence
 * @param {import('./text.js').Span | null} [evidence]
 * @param {{ note?: string, method?: string }} [meta]
 * @returns {ExtractedField}
 */
export function field(name, value, confidence, evidence = null, meta = {}) {
  return {
    name,
    value: value === undefined ? null : value,
    confidence: Math.max(0, Math.min(1, confidence)),
    evidence,
    note: meta.note ?? null,
    method: meta.method ?? 'unspecified',
  };
}

/**
 * Convenience: a field the extractor looked for and did not find.
 *
 * @param {string} name
 * @param {number} confidence
 * @param {string} note
 * @param {string} method
 * @returns {ExtractedField}
 */
export function missingField(name, confidence, note, method) {
  return field(name, null, confidence, null, { note, method });
}

/** Scalar fields scored by the accuracy metric, in display order. */
export const SCALAR_FIELDS = [
  'insuredName',
  'receivedDate',
  'requestedEffectiveDate',
  'statedTiv',
  'computedTiv',
  'lossRunTotalIncurred',
  'lossCount',
];

/** Location sub-fields scored by the accuracy metric, in display order. */
export const LOCATION_FIELDS = [
  'address',
  'city',
  'state',
  'zip',
  'buildingValue',
  'contentsValue',
  'biValue',
  'constructionType',
  'yearBuilt',
];

/**
 * Fields that must be present and confident for the workflow to proceed
 * without a human. Construction type and year built are deliberately NOT here:
 * they are underwriting enrichment, and a packet missing them should raise a
 * data-completeness flag rather than halt the run.
 */
export const REQUIRED_FIELDS = ['insuredName', 'receivedDate', 'requestedEffectiveDate'];

/** Location sub-fields that are required for a run to proceed unattended. */
export const REQUIRED_LOCATION_FIELDS = ['address', 'buildingValue'];
