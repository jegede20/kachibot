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
