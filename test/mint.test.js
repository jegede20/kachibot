'use strict';
/** Unit tests: raw mint-account decoding (the source of every market cap). */
const { test } = require('node:test');
const assert = require('node:assert');
process.env.ENCRYPTION_KEY = 'test-only-key-abcdef';

const { mintSupplyRaw } = require('../dist/chain/meta');

/** build a minimal SPL / Token-2022 mint account (82-byte base layout) */
function mintBuffer(supplyRaw, decimals = 6) {
  const buf = Buffer.alloc(82);
  buf.writeUInt32LE(1, 0); // mint_authority = Some
  buf.writeBigUInt64LE(BigInt(supplyRaw), 36); // supply — LITTLE endian
  buf[44] = decimals;
  buf[45] = 1; // is_initialized
  return buf;
}

test('mintSupplyRaw: reads the supply little-endian', () => {
  assert.strictEqual(mintSupplyRaw(mintBuffer(1_000_000_000_000n)), 1_000_000_000_000);
  assert.strictEqual(mintSupplyRaw(mintBuffer(939_859_645_162_408n)), 939_859_645_162_408);
  assert.strictEqual(mintSupplyRaw(mintBuffer(0n)), 0);
});

test('mintSupplyRaw: endianness regression (1 must not become 7.2e16)', () => {
  // bytes 01 00 00 … — a big-endian read of this is 72057594037927936
  assert.strictEqual(mintSupplyRaw(mintBuffer(1n)), 1);
  const be = Buffer.alloc(82);
  be.writeBigUInt64LE(1n, 36);
  assert.strictEqual(mintSupplyRaw(be), 1);
  assert.notStrictEqual(mintSupplyRaw(be), 72057594037927936);
});

test('mintSupplyRaw: handles the largest plausible supply', () => {
  const big = 1_000_000_000_000_000_000n; // 1e18 raw
  assert.strictEqual(mintSupplyRaw(mintBuffer(big)), 1e18);
});

test('mintSupplyRaw: null on missing or truncated account data', () => {
  assert.strictEqual(mintSupplyRaw(null), null);
  assert.strictEqual(mintSupplyRaw(undefined), null);
  assert.strictEqual(mintSupplyRaw(Buffer.alloc(10)), null); // too short
  assert.strictEqual(mintSupplyRaw(Buffer.alloc(44)), null); // needs the decimals byte too
});

test('mintSupplyRaw: accepts a plain Uint8Array as well as a Buffer', () => {
  const arr = new Uint8Array(mintBuffer(123_456_789n));
  assert.strictEqual(mintSupplyRaw(arr), 123_456_789);
});
