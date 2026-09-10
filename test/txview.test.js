'use strict';
/** Unit tests: versioned(v0)-transaction decoding + off-curve swap detection.
 * Regression: analyzeTx read message.accountKeys/instructions which only exist
 * on LEGACY txs — every modern v0 tx (staticAccountKeys + compiledInstructions
 * + address-table lookups) decoded to an empty key list, so NO pump buy/sell
 * was ever attributed and the watcher stayed silent on active wallets. */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  decodeMessageView, allIxs, programsOf, detectSwapSignals, DEX_SWAP_PROGS,
  determineSide, PRIME_STALE_MS, isStaleTx, ANALYSIS_MAX_AGE_MS,
} = require('../dist/chain/txview');
const { classifyPumpIx } = require('../dist/chain/pump');

const PUMP_PROG = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const CcJX = 'CcJX975YTw8owyuRwyC1m9pyC3ZhRp89VM12pfUfDBcf';
const FH5H = 'FH5HjZvWREJC8C4aAL348UQp48fh2CZxDncLCpEwnuo2';

const fixture = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'live', name), 'utf8'));

test('v0 tx (address-table lookups) decodes to a full key list + instructions', () => {
  const tx = fixture('v0-pump-sell-3zvj5Je1.json');
  const m = tx.transaction.message;
  // sanity: the fixture really is the versioned wire shape
  assert.ok(Array.isArray(m.staticAccountKeys) && !Array.isArray(m.accountKeys), 'fixture should be v0-shaped');
  const view = decodeMessageView(tx);
  assert.ok(view, 'decode failed');
  assert.ok(view.pkeys.length >= (m.staticAccountKeys.length + (tx.meta.loadedAddresses.writable.length + tx.meta.loadedAddresses.readonly.length)), 'pkeys must cover static+loaded');
  assert.ok(view.top.length > 0, 'top-level compiled instructions must decode');
  // the watched wallet must resolve to a real position
  assert.ok(view.pkeys.includes(CcJX), 'watched wallet missing from decoded keys');
});

test('pump CPI inside a v0 tx is found after decoding (previously invisible)', () => {
  const tx = fixture('v0-pump-sell-3zvj5Je1.json');
  const view = decodeMessageView(tx);
  const ixs = allIxs(view);
  const pump = ixs.filter((ix) => view.pkeys[ix.programIdIndex] === PUMP_PROG);
  assert.ok(pump.length > 0, 'no pump instruction found in v0 tx');
  let trade = null;
  for (const ix of pump) {
    const sig = classifyPumpIx(Buffer.from(ix.data, 'base64'));
    if (sig) trade = sig;
  }
  assert.ok(trade, 'pump instruction should classify as a trade');
  assert.strictEqual(trade.side, 'sell');
});

test('off-curve swap buy paid with USDC is detected for the watched wallet', () => {
  const tx = fixture('v0-dex-buy-56FYfa.json');
  const view = decodeMessageView(tx);
  assert.ok(view.pkeys.includes(FH5H), 'watched wallet missing from keys');
  const progs = programsOf(view);
  assert.ok([...progs].some((p) => DEX_SWAP_PROGS.has(p)), 'fixture should invoke a known DEX');
  const signals = detectSwapSignals(view, tx.meta, FH5H);
  const buys = signals.filter((s) => s.side === 'buy');
  assert.ok(buys.length >= 1, 'expected a buy signal, got: ' + JSON.stringify(signals.map((s) => s.side)));
  const b = buys[0];
  assert.ok(b.mint && b.mint.length >= 32, 'signal must name a token mint');
  assert.ok((b.tokenDeltaRaw ?? 0n) > 0n, 'buy signal must carry a positive token delta');
  // paid with USDC, not SOL → no SOL-spend estimate (fixed-mode sizing)
  assert.strictEqual(b.solMovedLamports, null);
});

test('legacy-shaped messages still decode (no regression)', () => {
  // minimal legacy shape as the RPC returns it
  const legacy = {
    transaction: {
      message: {
        accountKeys: [
          { pubkey: CcJX, signer: true, writable: true },
          { pubkey: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', signer: false, writable: false },
        ],
        instructions: [{ programIdIndex: 0, accounts: [0], data: Buffer.from('abcd').toString('base64') }],
      },
    },
    meta: { loadedAddresses: { writable: [], readonly: [] }, innerInstructions: [], err: null },
  };
  const view = decodeMessageView(legacy);
  assert.ok(view, 'legacy decode failed');
  assert.deepStrictEqual(view.pkeys, [CcJX, 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA']);
  assert.strictEqual(view.top.length, 1);
  assert.strictEqual(view.top[0].programIdIndex, 0);
  assert.strictEqual(view.inner.length, 0);
});

test('detectSwapSignals ignores non-DEX transfers and dust moves', () => {
  const tx = fixture('v0-dex-buy-56FYfa.json');
  const view = decodeMessageView(tx);
  // spoof: zero out program ids -> no DEX -> no signals even with the same deltas
  const blank = { pkeys: view.pkeys, top: [], inner: [] };
  assert.deepStrictEqual(detectSwapSignals(blank, tx.meta, FH5H), []);
});


test('determineSide trusts the watched wallet delta in bundled txs', () => {
  // bundled tx: the pump ix belongs to a router (traderPos -1). The ape SOLD.
  // Old logic used the foreign ix + global logs -> wrongly reported "buy".
  assert.strictEqual(determineSide('buy', true, false, -1, -1), 'sell');
  assert.strictEqual(determineSide('sell', false, true, -1, 1), 'buy');
  // when the ix IS the ape's own (traderPos >= 0), the ix wins
  assert.strictEqual(determineSide('buy', true, false, 3, -1), 'buy');
  assert.strictEqual(determineSide('sell', false, true, 3, 1), 'sell');
  // no delta information -> previous behaviour (ix + logs)
  assert.strictEqual(determineSide('buy', false, true, -1, 0), 'sell');
  assert.strictEqual(determineSide('buy', true, false, -1, 0), 'buy');
});

test('PRIME_STALE_MS leaves a window for buys made during a restart gap', () => {
  assert.ok(PRIME_STALE_MS >= 60_000 && PRIME_STALE_MS <= 300_000, 'prime window sane');
});


test('isStaleTx blocks restart-gap replays but allows fresh buys', () => {
  const now = 1_800_000_000_000;
  // a buy 30s old (short restart gap) must still be mirrored
  assert.strictEqual(isStaleTx(now / 1000 - 30, now), false);
  // a buy from 2 minutes ago is still inside the window
  assert.strictEqual(isStaleTx(now / 1000 - 120, now), false);
  // a buy from an hour ago (long sleep) must never be mirrored
  assert.strictEqual(isStaleTx(now / 1000 - 3600, now), true);
  // unknown blockTime -> not treated as stale
  assert.strictEqual(isStaleTx(null, now), false);
  assert.strictEqual(isStaleTx(0, now), false);
  assert.ok(ANALYSIS_MAX_AGE_MS > PRIME_STALE_MS, 'analysis window must exceed prime window');
});
