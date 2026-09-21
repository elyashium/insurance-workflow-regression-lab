/**
 * Write-path gate: reads stay open, reviews need the shared key when set.
 *
 * Importing the server binds no ports (the listen guard only fires when the
 * file is the entrypoint), so this is a pure unit over `authorized()`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { authorized } from '../src/server.js';

const reqWith = (key) => ({ headers: key === undefined ? {} : { 'x-api-key': key } });

async function withEnv(overrides, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(overrides)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('reviews are open when no key is configured', async () => {
  await withEnv({ LAB_API_KEY: undefined }, async () => {
    assert.equal(authorized(reqWith(undefined)), true);
    assert.equal(authorized(reqWith('anything')), true);
  });
});

test('a configured key admits exactly itself', async () => {
  await withEnv({ LAB_API_KEY: 'lab-secret' }, async () => {
    assert.equal(authorized(reqWith('lab-secret')), true);
    assert.equal(authorized(reqWith('wrong')), false);
    assert.equal(authorized(reqWith(undefined)), false);
    assert.equal(authorized(reqWith('')), false);
  });
});
