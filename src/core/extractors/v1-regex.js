/**
 * Workflow version 1: strict regex extraction.
 *
 * What a first implementation looks like. It reads the three documents that
 * are obviously "the submission", recognises the label wording the standard
 * forms use, and insists that currency arrive formatted as $12,400,000.
 *
 * Its failures are the honest ones: when a broker types "Constr:" instead of
 * "Construction:", or writes "$3.1M", v1 does not guess. It records a
 * low-confidence miss, which downstream becomes an abstention rather than a
 * wrong answer. That is the behaviour the scorecard is meant to make visible -
 * v1 is less accurate than v2 but it is not more dangerous than v2, and the
 * per-field diff is where that shows up.
 */

import { runExtraction } from './engine.js';

/** @type {any} */
export const V1_PROFILE = {
  id: 'v1-regex',
  name: 'v1 - strict regex',
  currency: 'strict',

  // The broker email and any endorsement are out of scope. v1 treats the
  // submission as the application, the schedule and the loss run.
  documents: ['acord', 'sov', 'loss_run'],
  readEndorsements: false,
  contextBackfill: false,
  passes: 1,

  labels: {
    insuredName: ['Named Insured', 'Applicant'],
    receivedDate: ['Date Received'],
    effectiveDate: ['Proposed Effective Date'],
    statedTiv: ['Total Insured Value'],

    building: ['Building'],
    contents: ['Contents'],
    bi: ['BI'],
    construction: ['Construction'],
    yearBuilt: ['Year Built'],
  },
};

/**
 * @param {import('../packets.js').Packet} packet
 * @returns {import('../types.js').ExtractionResult}
 */
export function extract(packet) {
  return runExtraction(packet, V1_PROFILE);
}
