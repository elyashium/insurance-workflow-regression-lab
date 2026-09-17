/**
 * Address normalisation and duplicate detection.
 *
 * The same building arrives twice under two asset IDs more often than anyone
 * would like, and the two rows rarely agree on how to spell the street. The
 * v1 workflow compares raw strings and therefore misses these; v2 normalises
 * first. That difference is one of the headline rows in the scorecard, so the
 * matcher is kept small, deterministic and directly testable.
 */

/** Street-type abbreviations, mapped to a single canonical spelling. */
const STREET_SUFFIXES = {
  AVE: 'AVENUE', AV: 'AVENUE', AVEN: 'AVENUE',
  ST: 'STREET', STR: 'STREET',
  RD: 'ROAD',
  DR: 'DRIVE', DRV: 'DRIVE',
  LN: 'LANE',
  CT: 'COURT',
  BLVD: 'BOULEVARD', BLV: 'BOULEVARD',
  PKWY: 'PARKWAY', PKY: 'PARKWAY', PARKWY: 'PARKWAY',
  HWY: 'HIGHWAY',
  PL: 'PLACE',
  TER: 'TERRACE', TERR: 'TERRACE',
  CIR: 'CIRCLE',
  TRL: 'TRAIL',
  PLZ: 'PLAZA',
  SQ: 'SQUARE',
  EXPY: 'EXPRESSWAY',
  LP: 'LOOP',
};

/** Leading/trailing directionals, mapped to a canonical spelling. */
const DIRECTIONALS = {
  N: 'NORTH', S: 'SOUTH', E: 'EAST', W: 'WEST',
  NE: 'NORTHEAST', NW: 'NORTHWEST', SE: 'SOUTHEAST', SW: 'SOUTHWEST',
};

/**
 * Sub-building designators. A suite or unit number does not make a second
 * structure, so these are dropped before comparison - that is exactly the
 * PKT-008 case, where a sub-meter shows up in the finance register as its own
 * asset row.
 */
const UNIT_TOKENS = ['SUITE', 'STE', 'UNIT', 'APT', 'APARTMENT', 'FLOOR', 'FL', 'RM', 'ROOM', 'BLDG', 'BUILDING', 'DEPT'];

/**
 * Reduce a street address to a comparable canonical form.
 *
 * @param {string | null | undefined} raw
 * @returns {string}
 */
export function normalizeAddress(raw) {
  if (raw == null) return '';
  let s = String(raw).toUpperCase();

  // Punctuation carries no meaning here; "#" is treated as a unit marker.
  s = s.replace(/#/g, ' UNIT ');
  s = s.replace(/[.,;:'"()]/g, ' ');
  s = s.replace(/[-/\\]/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();

  // Drop "SUITE 100", "UNIT B", "FLOOR 3" and friends, including a trailing
  // designator with no number after it.
  for (const token of UNIT_TOKENS) {
    s = s.replace(new RegExp(`\\b${token}\\b\\s*[A-Z0-9-]*`, 'g'), ' ');
  }

  const canonical = s
    .split(' ')
    .filter(Boolean)
    .map((word) => STREET_SUFFIXES[word] || DIRECTIONALS[word] || word);

  return canonical.join(' ').replace(/\s+/g, ' ').trim();
}

/** Every word that names a street type, in both abbreviated and full form. */
const SUFFIX_WORDS = new Set([
  ...Object.keys(STREET_SUFFIXES),
  ...Object.values(STREET_SUFFIXES),
]);

/** Every word that names a compass direction, in both forms. */
const DIRECTIONAL_WORDS = new Set([
  ...Object.keys(DIRECTIONALS),
  ...Object.values(DIRECTIONALS),
]);

/**
 * The one word in an address most likely to identify it in running prose.
 *
 * "14 Spindle Court" is written as "Spindle Court" or just "Spindle" in a
 * broker email, never as its house number. Dropping numbers, street types and
 * directionals and taking the longest word left gives a token worth searching
 * for. Short words are rejected outright: an "Elm" or a "Bay" appears in
 * unrelated sentences too often to anchor anything.
 *
 * @param {string | null | undefined} raw
 * @returns {string | null} uppercase token, or null if nothing distinctive
 */
export function distinctiveStreetToken(raw) {
  const words = normalizeAddress(raw)
    .split(' ')
    .filter(
      (w) => w.length >= 4 && !/^\d/.test(w) && !SUFFIX_WORDS.has(w) && !DIRECTIONAL_WORDS.has(w),
    );
  if (words.length === 0) return null;

  return words.reduce((best, w) => (w.length > best.length ? w : best), words[0]);
}

/**
 * Stable key for a location: canonical street plus postal code. Two identical
 * street names in different towns must not collide.
 *
 * @param {string | null | undefined} address
 * @param {string | null | undefined} zip
 * @returns {string}
 */
export function addressKey(address, zip) {
  return `${normalizeAddress(address)}|${(zip || '').toString().trim()}`;
}

/**
 * Levenshtein edit distance, iterative with a single rolling row.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function levenshtein(a, b) {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prev = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    const curr = new Array(b.length + 1);
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = curr;
  }
  return prev[b.length];
}

/**
 * Normalised similarity in [0,1], where 1 is an exact match.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function similarity(a, b) {
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 1;
  return 1 - levenshtein(a, b) / longest;
}

/**
 * @typedef {Object} MatchOptions
 * @property {boolean} [fuzzy=false]     normalise before comparing, and allow
 *                                       near-matches within `threshold`
 * @property {number}  [threshold=0.92]  similarity floor for a fuzzy match
 */

/**
 * @typedef {Object} MatchResult
 * @property {boolean} match
 * @property {number} score
 * @property {'exact-raw'|'exact-normalized'|'fuzzy'|'none'} basis
 */

/**
 * Decide whether two locations are the same physical place.
 *
 * In exact mode (v1) this is a trimmed, case-insensitive string comparison,
 * which is what a first-pass implementation does and why "1420 Kestrel Ave"
 * and "1420 Kestrel Avenue" slip through as two buildings.
 *
 * @param {{address?: string|null, zip?: string|null}} a
 * @param {{address?: string|null, zip?: string|null}} b
 * @param {MatchOptions} [options]
 * @returns {MatchResult}
 */
export function addressesMatch(a, b, options = {}) {
  const { fuzzy = false, threshold = 0.92 } = options;

  const rawA = (a.address || '').trim().toUpperCase();
  const rawB = (b.address || '').trim().toUpperCase();
  const zipA = (a.zip || '').toString().trim();
  const zipB = (b.zip || '').toString().trim();

  if (rawA !== '' && rawA === rawB && zipA === zipB) {
    return { match: true, score: 1, basis: 'exact-raw' };
  }
  if (!fuzzy) return { match: false, score: 0, basis: 'none' };

  const normA = normalizeAddress(a.address);
  const normB = normalizeAddress(b.address);
  if (normA === '' || normB === '') return { match: false, score: 0, basis: 'none' };

  if (normA === normB && zipA === zipB) {
    return { match: true, score: 1, basis: 'exact-normalized' };
  }

  // Typo tolerance, but only within the same postal code. Without the zip
  // guard, similar street names in neighbouring towns start merging.
  if (zipA !== '' && zipA === zipB) {
    const score = similarity(normA, normB);
    if (score >= threshold) return { match: true, score, basis: 'fuzzy' };
    return { match: false, score, basis: 'none' };
  }

  return { match: false, score: 0, basis: 'none' };
}

/**
 * @typedef {Object} DuplicateGroup
 * @property {number} keepIndex        index of the row treated as authoritative
 * @property {number[]} duplicateIndexes indexes considered repeats of it
 * @property {string} basis
 * @property {number} score
 */

/**
 * Group locations that refer to the same physical place.
 *
 * First occurrence wins: the earliest row is kept and later rows are recorded
 * as duplicates. This matches the convention documented in ground-truth.json.
 *
 * @param {{address?: string|null, zip?: string|null}[]} locations
 * @param {MatchOptions} [options]
 * @returns {DuplicateGroup[]} only groups that actually contain a duplicate
 */
export function findDuplicateGroups(locations, options = {}) {
  /** @type {DuplicateGroup[]} */
  const groups = [];
  const claimed = new Set();

  for (let i = 0; i < locations.length; i++) {
    if (claimed.has(i)) continue;
    /** @type {DuplicateGroup} */
    const group = { keepIndex: i, duplicateIndexes: [], basis: 'none', score: 0 };

    for (let j = i + 1; j < locations.length; j++) {
      if (claimed.has(j)) continue;
      const result = addressesMatch(locations[i], locations[j], options);
      if (result.match) {
        group.duplicateIndexes.push(j);
        group.basis = result.basis;
        group.score = result.score;
        claimed.add(j);
      }
    }

    if (group.duplicateIndexes.length > 0) groups.push(group);
  }

  return groups;
}
