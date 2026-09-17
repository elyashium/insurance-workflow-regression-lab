/**
 * Workflow version 2: tolerant heuristic extraction.
 *
 * The obvious next iteration. It widens the label vocabulary so a broker who
 * writes "Constr:" or "Bldg Val:" is still understood, loosens number parsing
 * so "$3.1M" and a bare "16700000" are read, and pulls two documents into
 * scope that v1 ignored - the broker email and the late endorsement.
 *
 * It also turns on context back-fill, which is where the interesting part is.
 * Back-fill reads prose near a blank cell and fills the cell in. On most
 * packets it does nothing. On one it produces two values that look like data
 * and are not, and quietly removes a flag that would have sent the packet to a
 * human. Version v2.1 is the same profile with that one switch turned off,
 * which is how the lab demonstrates catching a regression and gating a fix.
 */

import { runExtraction } from './engine.js';

/** @type {any} */
export const V2_PROFILE = {
  id: 'v2-heuristic',
  name: 'v2 - tolerant heuristic',
  currency: 'loose',

  documents: ['acord', 'sov', 'loss_run', 'endorsement', 'email'],
  readEndorsements: true,
  contextBackfill: true,

  // Two passes: one to read the documents, one to revisit blanks with the
  // whole packet in hand. The cost model charges for both.
  passes: 2,

  labels: {
    // Aliases are listed most specific first. The trailing colon in the
    // matcher already prevents "Constr" from swallowing "Construction", but
    // ordering them this way keeps the intent readable.
    insuredName: ['Named Insured', 'Insured Name (DBA)', 'Insured Name', 'Applicant', 'Insured'],
    receivedDate: ['Date Received', 'Received', 'Date Rec'],
    effectiveDate: ['Proposed Effective Date', 'Requested Effective Date', 'Effective Date'],
    statedTiv: ['Total Insured Value', 'TIV (stated)', 'Total Insurable Value', 'TIV'],

    building: ['Building Value', 'Bldg Val', 'Building', 'Bldg'],
    contents: ['Contents', 'Cont'],
    bi: ['Business Interruption', 'BI'],
    construction: ['Construction Type', 'Construction', 'Constr'],
    yearBuilt: ['Year Built', 'Yr Built', 'Yr Blt', 'Built'],
  },
};

/**
 * @param {import('../packets.js').Packet} packet
 * @returns {import('../types.js').ExtractionResult}
 */
export function extract(packet) {
  return runExtraction(packet, V2_PROFILE);
}
