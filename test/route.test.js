'use strict';
/** Unit tests: post-graduation routing (Jupiter -> PumpSwap fallback + valuations). */
const { test } = require('node:test');
const assert = require('node:assert');
process.env.ENCRYPTION_KEY = 'test-only-key-abcdef';

const { noRouteError } = require('../dist/chain/jupiter');
const { poolMcapLamports } = require('../dist/chain/pumpswap');
const BN = require('bn.js');

test('noRouteError: treats missing routes as fallback-able', () => {
  assert.equal(noRouteError('jupiter: no route found for this token (no liquidity)'), true);
  assert.equal(noRouteError('jupiter request failed: fetch failed'), true);
  assert.equal(noRouteError('Jupiter HTTP 429: too many requests'), true);
  assert.equal(noRouteError('jupiter request failed: This operation was aborted'), true);
});

test('noRouteError: real failures are not mistaken for a missing route', () => {
  assert.equal(noRouteError('budget must be positive'), false);
  assert.equal(noRouteError('tx landed but failed on-chain'), false);
  assert.equal(noRouteError('pre-buy simulation failed (custom error)'), false);
  assert.equal(noRouteError('no tokens received'), false);
});

test('poolMcapLamports: constant-product market cap from pool reserves', () => {
  // 1000 SOL of quote reserves, 1e9 raw tokens held by the pool, 1e9 supply
  // -> 1 SOL per token outstanding -> 1000 SOL market cap
  const st = { poolBaseAmount: new BN('1000000000'), poolQuoteAmount: new BN(BigInt(1000) * 1_000_000_000n) };
  assert.equal(poolMcapLamports(st, 1_000_000_000), 1000 * 1_000_000_000);
});

test('poolMcapLamports: scales with supply', () => {
  const st = { poolBaseAmount: new BN('500000000'), poolQuoteAmount: new BN(BigInt(20) * 1_000_000_000n) };
  // 20 SOL for 500M tokens -> 40 SOL per 1B -> 10B supply = 400 SOL
  assert.equal(poolMcapLamports(st, 10_000_000_000), 400 * 1_000_000_000);
});

test('poolMcapLamports: null when it cannot be computed', () => {
  const st = { poolBaseAmount: new BN('1000'), poolQuoteAmount: new BN('1000') };
  assert.equal(poolMcapLamports(st, null), null);
  assert.equal(poolMcapLamports(st, 0), null);
  assert.equal(poolMcapLamports({ poolBaseAmount: new BN('0'), poolQuoteAmount: new BN('1000') }, 1e9), null);
});

test('poolMcapLamports: handles BN-string reserves from a plan', () => {
  const st = { poolBaseAmount: new BN('2000000000'), poolQuoteAmount: new BN(BigInt(4) * 1_000_000_000n) };
  assert.equal(poolMcapLamports(st, 500_000_000), 1_000_000_000);
});

/* ------------------------- copy-sell: mirror mode ------------------------- */

const { soldFractionOf, copySellFraction, normalizeCopySellMode } = require('../dist/types');

test('soldFractionOf: measures the slice of the ape bag a sell moved', () => {
  assert.equal(soldFractionOf(1000n, 400n), 0.6);   // sold 60%, kept 40% moonbag
  assert.equal(soldFractionOf(1000n, 0n), 1);       // full exit
  assert.equal(soldFractionOf('1000', '250'), 0.75); // string balances
  assert.equal(soldFractionOf(1000n, 999n), 0.001); // tiny trim
});

test('soldFractionOf: null when the tx tells us nothing', () => {
  assert.equal(soldFractionOf(1000n, 1000n), null); // no change
  assert.equal(soldFractionOf(0n, 0n), null);       // no pre balance
  assert.equal(soldFractionOf(null, 5n), null);
  assert.equal(soldFractionOf(undefined, undefined), null);
});

test('copySellFraction: mirror copies the ape slice, all dumps everything', () => {
  assert.equal(copySellFraction('mirror', 0.6, 1), 0.6);
  assert.equal(copySellFraction('mirror', 1, 1), 1);
  assert.equal(copySellFraction('all', 0.25, 1), 1);      // dump all regardless
  assert.equal(copySellFraction('all', 0.25, 0.5), 1);
});

test('copySellFraction: falls back to the exit rule when the ape slice is unknown', () => {
  assert.equal(copySellFraction('mirror', null, 0.5), 0.5);
  assert.equal(copySellFraction('mirror', undefined, 0.5), 0.5);
  assert.equal(copySellFraction(undefined, 0.6, 0.5), 0.5); // legacy doc
});

test('copySellFraction: clamps absurd values', () => {
  assert.equal(copySellFraction('mirror', 0.0001, 1), 0.01); // never sell ~0
  assert.equal(copySellFraction('mirror', 5, 1), 1);         // never oversell
});

test('normalizeCopySellMode: backfills safely', () => {
  assert.equal(normalizeCopySellMode(undefined), 'mirror');
  assert.equal(normalizeCopySellMode('all'), 'all');
  assert.equal(normalizeCopySellMode('mirror'), 'mirror');
  assert.equal(normalizeCopySellMode('nonsense'), 'mirror');
});
