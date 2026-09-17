/**
 * Currency parsing.
 *
 * Two deliberately different parsers, because the difference between them is
 * one of the things the regression lab is built to measure.
 *
 *   parseStrictCurrency - insists on "$12,400,000": leading dollar sign,
 *     comma-grouped thousands, no suffixes. This is the v1 baseline. It is not
 *     a strawman; it is what a first-pass extractor written against two clean
 *     sample documents actually looks like.
 *
 *   parseLooseCurrency - additionally accepts bare digits ("16700000"),
 *     magnitude suffixes ("$3.1M", "750K"), and a missing dollar sign. This is
 *     v2.
 */

const STRICT_RE = /^\$\d{1,3}(,\d{3})*$/;
const LOOSE_RE = /^\$?\s*(\d+(?:,\d{3})*(?:\.\d+)?)\s*([KMB])?$/i;

const SUFFIX_MULTIPLIER = { K: 1_000, M: 1_000_000, B: 1_000_000_000 };

/**
 * Strict parser. Returns null for anything that is not exactly "$N,NNN,NNN".
 *
 * @param {string | null | undefined} raw
 * @returns {number | null}
 */
export function parseStrictCurrency(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (s === '') return null;
  if (!STRICT_RE.test(s)) return null;
  const n = Number(s.slice(1).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * Tolerant parser: handles missing "$", missing comma grouping, decimals, and
 * K/M/B magnitude suffixes.
 *
 * @param {string | null | undefined} raw
 * @returns {number | null}
 */
export function parseLooseCurrency(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (s === '') return null;

  const m = LOOSE_RE.exec(s);
  if (!m) return null;

  const base = Number(m[1].replace(/,/g, ''));
  if (!Number.isFinite(base)) return null;

  const suffix = m[2] ? m[2].toUpperCase() : null;
  const value = suffix ? base * SUFFIX_MULTIPLIER[suffix] : base;

  // Reject fractional currency. Every figure in this domain is whole dollars,
  // and a non-integer here means we misread the token.
  return Number.isInteger(value) ? value : Math.round(value);
}

/**
 * Format a number as USD for display. No dependency on Intl locale data being
 * present, so the output is identical on every machine.
 *
 * @param {number | null | undefined} n
 * @returns {string}
 */
export function formatUsd(n) {
  if (n == null || !Number.isFinite(n)) return '--';
  const neg = n < 0;
  const digits = Math.round(Math.abs(n)).toString();
  let out = '';
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ',';
    out += digits[i];
  }
  return `${neg ? '-' : ''}$${out}`;
}

/**
 * Compact display for headline figures: $128.3M, $770.0K.
 *
 * @param {number | null | undefined} n
 * @returns {string}
 */
export function formatUsdCompact(n) {
  if (n == null || !Number.isFinite(n)) return '--';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1_000_000_000) return `${sign}$${(abs / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}K`;
  return formatUsd(n);
}
