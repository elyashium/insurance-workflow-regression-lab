/**
 * Date parsing and comparison.
 *
 * All packet dates are ISO (YYYY-MM-DD). Everything is handled as a UTC
 * calendar date so results do not shift with the machine's timezone - a
 * regression lab that produced different flags in Mumbai and San Francisco
 * would be worthless.
 */

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Parse an ISO date string into a UTC timestamp, or null if malformed or not a
 * real calendar date (e.g. 2026-02-30).
 *
 * @param {string | null | undefined} raw
 * @returns {number | null} epoch milliseconds at UTC midnight
 */
export function parseIsoDate(raw) {
  if (raw == null) return null;
  const m = ISO_RE.exec(String(raw).trim());
  if (!m) return null;

  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const ts = Date.UTC(year, month - 1, day);
  const d = new Date(ts);
  // Round-trip guard: Date.UTC silently rolls 2026-02-30 forward into March.
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    return null;
  }
  return ts;
}

/**
 * Whole days from `a` to `b`. Negative when b precedes a.
 *
 * @param {number} a epoch ms
 * @param {number} b epoch ms
 * @returns {number}
 */
export function daysBetween(a, b) {
  return Math.round((b - a) / 86_400_000);
}

/**
 * Calendar months from `a` to `b`, as a fractional figure.
 *
 * Uses whole months between the two calendar positions plus the day-of-month
 * remainder scaled by a 30.44 day average month. Precise enough for a "more
 * than twelve months out" appetite rule, and stable across timezones.
 *
 * @param {number} a epoch ms
 * @param {number} b epoch ms
 * @returns {number}
 */
export function monthsBetween(a, b) {
  const da = new Date(a);
  const db = new Date(b);
  const wholeMonths =
    (db.getUTCFullYear() - da.getUTCFullYear()) * 12 + (db.getUTCMonth() - da.getUTCMonth());
  const dayRemainder = (db.getUTCDate() - da.getUTCDate()) / 30.44;
  return wholeMonths + dayRemainder;
}

/**
 * Render an epoch timestamp back to an ISO calendar date.
 *
 * @param {number | null} ts
 * @returns {string}
 */
export function formatIsoDate(ts) {
  if (ts == null || !Number.isFinite(ts)) return '--';
  return new Date(ts).toISOString().slice(0, 10);
}
