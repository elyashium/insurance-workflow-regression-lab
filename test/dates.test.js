import test from 'node:test';
import assert from 'node:assert/strict';

import { parseIsoDate, daysBetween, monthsBetween, formatIsoDate } from '../src/core/dates.js';

test('parseIsoDate reads a calendar date as UTC midnight', () => {
  const ts = parseIsoDate('2026-03-01');
  assert.equal(ts, Date.UTC(2026, 2, 1));
  assert.equal(new Date(ts).toISOString(), '2026-03-01T00:00:00.000Z');
});

test('parseIsoDate is timezone-stable', () => {
  // The flag a packet raises must not depend on where the reviewer is sitting.
  // If this ever parsed in local time, the date would shift by a day either
  // side of UTC and a boundary case would flag in one office and not another.
  const ts = parseIsoDate('2026-01-01');
  assert.equal(formatIsoDate(ts), '2026-01-01');
  assert.equal(new Date(ts).getUTCHours(), 0);
});

test('parseIsoDate rejects dates that are not real', () => {
  assert.equal(parseIsoDate('2026-02-30'), null, 'February has no 30th');
  assert.equal(parseIsoDate('2025-02-29'), null, '2025 is not a leap year');
  assert.equal(parseIsoDate('2026-13-01'), null, 'no thirteenth month');
  assert.equal(parseIsoDate('2026-00-10'), null);
  assert.equal(parseIsoDate('2026-01-00'), null);
});

test('parseIsoDate accepts a genuine leap day', () => {
  assert.equal(formatIsoDate(parseIsoDate('2028-02-29')), '2028-02-29');
});

test('parseIsoDate rejects anything that is not an ISO date', () => {
  assert.equal(parseIsoDate('03/01/2026'), null);
  assert.equal(parseIsoDate('March 1, 2026'), null);
  assert.equal(parseIsoDate('2026-3-1'), null);
  assert.equal(parseIsoDate('TBD'), null);
  assert.equal(parseIsoDate(''), null);
  assert.equal(parseIsoDate(null), null);
  assert.equal(parseIsoDate(undefined), null);
});

test('parseIsoDate tolerates surrounding whitespace', () => {
  assert.equal(parseIsoDate('  2026-03-01  '), Date.UTC(2026, 2, 1));
});

test('daysBetween counts whole days and keeps direction', () => {
  const a = parseIsoDate('2026-03-01');
  const b = parseIsoDate('2026-03-15');
  assert.equal(daysBetween(a, b), 14);
  assert.equal(daysBetween(b, a), -14);
  assert.equal(daysBetween(a, a), 0);
});

test('daysBetween is unaffected by the daylight-saving transition', () => {
  // A 23-hour local day would round to 0 or 2 if this were not UTC arithmetic.
  const before = parseIsoDate('2026-03-07');
  const after = parseIsoDate('2026-03-09');
  assert.equal(daysBetween(before, after), 2);
});

test('monthsBetween counts calendar months', () => {
  assert.equal(monthsBetween(parseIsoDate('2026-01-01'), parseIsoDate('2027-01-01')), 12);
  assert.equal(monthsBetween(parseIsoDate('2026-01-15'), parseIsoDate('2027-02-15')), 13);
  assert.equal(monthsBetween(parseIsoDate('2026-06-01'), parseIsoDate('2026-06-01')), 0);
});

test('monthsBetween is signed', () => {
  assert.ok(monthsBetween(parseIsoDate('2027-01-01'), parseIsoDate('2026-01-01')) < 0);
});

test('monthsBetween resolves the twelve-month appetite boundary', () => {
  // The GL-003 rule is "more than twelve months ahead". A submission that is
  // exactly a year out must sit on the permitted side of the line, and one a
  // fortnight later must not.
  const received = parseIsoDate('2026-02-10');
  assert.ok(monthsBetween(received, parseIsoDate('2027-02-10')) <= 12);
  assert.ok(monthsBetween(received, parseIsoDate('2027-03-01')) > 12);
});

test('formatIsoDate round-trips a parsed date', () => {
  for (const iso of ['2026-01-01', '2026-02-28', '2028-02-29', '2026-12-31']) {
    assert.equal(formatIsoDate(parseIsoDate(iso)), iso);
  }
});

test('formatIsoDate renders an absent timestamp as absent', () => {
  assert.equal(formatIsoDate(null), '--');
  assert.equal(formatIsoDate(NaN), '--');
});
