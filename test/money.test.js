import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseStrictCurrency,
  parseLooseCurrency,
  formatUsd,
  formatUsdCompact,
} from '../src/core/money.js';

test('the strict parser reads fully written currency', () => {
  assert.equal(parseStrictCurrency('$12,400,000'), 12_400_000);
  assert.equal(parseStrictCurrency('$750,000'), 750_000);
  assert.equal(parseStrictCurrency('$0'), 0);
  assert.equal(parseStrictCurrency('  $1,000  '), 1_000);
});

test('the strict parser refuses everything it was not written for', () => {
  // These are the v1 blind spots, and each one appears somewhere in the corpus.
  assert.equal(parseStrictCurrency('16700000'), null, 'bare digits');
  assert.equal(parseStrictCurrency('$3.1M'), null, 'magnitude suffix');
  assert.equal(parseStrictCurrency('750K'), null, 'suffix without a dollar sign');
  assert.equal(parseStrictCurrency('12,400,000'), null, 'missing dollar sign');
  assert.equal(parseStrictCurrency('$1,20,000'), null, 'malformed grouping');
  assert.equal(parseStrictCurrency('$12.50'), null, 'decimals');
  assert.equal(parseStrictCurrency('TBD'), null);
});

test('the strict parser treats absence as absence, not as zero', () => {
  assert.equal(parseStrictCurrency(''), null);
  assert.equal(parseStrictCurrency('   '), null);
  assert.equal(parseStrictCurrency(null), null);
  assert.equal(parseStrictCurrency(undefined), null);
});

test('the tolerant parser reads everything the strict one does', () => {
  assert.equal(parseLooseCurrency('$12,400,000'), 12_400_000);
  assert.equal(parseLooseCurrency('$750,000'), 750_000);
  assert.equal(parseLooseCurrency('$0'), 0);
});

test('the tolerant parser reads the shapes the strict one rejects', () => {
  assert.equal(parseLooseCurrency('16700000'), 16_700_000);
  assert.equal(parseLooseCurrency('12,400,000'), 12_400_000);
  assert.equal(parseLooseCurrency('$3.1M'), 3_100_000);
  assert.equal(parseLooseCurrency('750K'), 750_000);
  assert.equal(parseLooseCurrency('$1.25B'), 1_250_000_000);
  assert.equal(parseLooseCurrency('$ 2,000'), 2_000);
});

test('the tolerant parser is case-insensitive about magnitude suffixes', () => {
  assert.equal(parseLooseCurrency('3.1m'), 3_100_000);
  assert.equal(parseLooseCurrency('750k'), 750_000);
  assert.equal(parseLooseCurrency('$1b'), 1_000_000_000);
});

test('the tolerant parser still refuses prose', () => {
  // Tolerance has to stop somewhere. "TBD" and "see attached" are the two
  // things brokers actually write in a value cell, and reading either of them
  // as a number would be worse than reading nothing.
  assert.equal(parseLooseCurrency('TBD'), null);
  assert.equal(parseLooseCurrency('see attached'), null);
  assert.equal(parseLooseCurrency('$1,2345'), null);
  assert.equal(parseLooseCurrency('12,400,000 USD'), null);
  assert.equal(parseLooseCurrency(''), null);
  assert.equal(parseLooseCurrency(null), null);
});

test('the tolerant parser returns whole dollars', () => {
  assert.equal(parseLooseCurrency('$1.005M'), 1_005_000);
  assert.equal(parseLooseCurrency('12.5'), 13);
  assert.ok(Number.isInteger(parseLooseCurrency('$3.333M')));
});

test('formatUsd groups thousands without Intl locale data', () => {
  assert.equal(formatUsd(0), '$0');
  assert.equal(formatUsd(999), '$999');
  assert.equal(formatUsd(1_000), '$1,000');
  assert.equal(formatUsd(12_400_000), '$12,400,000');
  assert.equal(formatUsd(-2_500), '-$2,500');
});

test('formatUsd renders an absent figure as absent', () => {
  assert.equal(formatUsd(null), '--');
  assert.equal(formatUsd(undefined), '--');
  assert.equal(formatUsd(NaN), '--');
  assert.equal(formatUsd(Infinity), '--');
});

test('formatUsdCompact scales to the magnitude', () => {
  assert.equal(formatUsdCompact(1_250_000_000), '$1.25B');
  assert.equal(formatUsdCompact(12_400_000), '$12.4M');
  assert.equal(formatUsdCompact(770_000), '$770.0K');
  assert.equal(formatUsdCompact(950), '$950');
  assert.equal(formatUsdCompact(-12_400_000), '-$12.4M');
  assert.equal(formatUsdCompact(null), '--');
});
