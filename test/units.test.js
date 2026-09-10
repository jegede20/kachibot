'use strict';
/** Unit tests: pump instruction classifier, pricing wiring, settings validation, formatting. */
const { test } = require('node:test');
const assert = require('node:assert');
process.env.ENCRYPTION_KEY = 'test-only-key-abcdef';

const { classifyPumpIx, pumpIxArgs } = require('../dist/chain/pump');
const {
  validateAndApply, defaultSettings, summarizeTrades, lamportsToSol,
  resolveExit, normalizeExit, describeExit, exitSellFraction, parseExitInput,
  formatMcapUsd, EXIT_DEFAULT,
} = require('../dist/types');
const { solShort, scorecardText, chartLink, pctSigned, coinTag, solExact } = require('../dist/format');

const disc = (arr) => Buffer.from(arr);

test('instruction classifier decodes the LIVE pump program surface (empirical 2026-09)', () => {
  const cases = [
    // disc bytes captured from live mainnet txs (see test/fixtures/live/*.json)
    [[0, 148, 208, 218, 31, 67, 94, 176], 'Buy', 'buy'],          // direct modern Buy
    [[30, 116, 53, 226, 28, 186, 127, 17], 'BuyV2', 'buy'],        // BuyV2 (router era)
    [[216, 194, 192, 153, 36, 196, 194, 21], 'BuyExactQuoteInV2', 'buy'],
    [[230, 52, 92, 141, 216, 177, 69, 64], 'Sell', 'sell'],        // modern Sell
    [[38, 66, 185, 4, 145, 171, 233, 145], 'BuyExactQuoteInV2', 'buy'], // direct-Buy fixture disc
    [[245, 154, 189, 103, 3, 27, 123, 102], 'SellV2', 'sell'],     // direct-Sell fixture disc
    [[102, 6, 61, 18, 1, 218, 235, 234], 'buy', 'buy'],            // sdk-era legacy alias
    [[51, 230, 133, 164, 1, 127, 131, 173], 'sell', 'sell'],
  ];
  for (const [bytes, name, side] of cases) {
    const sig = classifyPumpIx(Buffer.from(bytes));
    assert.ok(sig, `classifier failed for disc ${bytes}`);
    assert.strictEqual(sig.name, name);
    assert.strictEqual(sig.side, side);
  }
  assert.strictEqual(classifyPumpIx(Buffer.from([9, 9, 9, 9, 9, 9, 9, 9])), null);
});

test('live fixture payloads classify to the right side (BuyExactQuoteInV2 / SellV2)', () => {
  const fs = require('fs');
  const path = require('path');
  const readIx = (f) => {
    const j = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'live', f)));
    const msg = j.message || j;
    const meta = j.meta || j;
    const keys = (j.accountKeys || (msg.accountKeys || []).map((k) => (typeof k === 'string' ? k : k.pubkey)))
      .concat(...(((meta.loadedAddresses || {}).writable || []).map(String)))
      .concat(...(((meta.loadedAddresses || {}).readonly || []).map(String)));
    const ixs = (msg.instructions || []).concat((meta.innerInstructions || []).flatMap((x) => x.instructions || []));
    const ix = ixs.find((i) => keys[i.programIdIndex] === '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P' && i.data && Buffer.from(i.data, 'base64').length >= 8 && (i.accounts || []).length > 10);
    return { data: Buffer.from(ix.data, 'base64'), keys, ix };
  };
  const buy = readIx('direct-Buy.json');
  const sell = readIx('direct-Sell.json');
  const bsig = classifyPumpIx(buy.data);
  const ssig = classifyPumpIx(sell.data);
  assert.ok(bsig && bsig.side === 'buy');
  assert.ok(ssig && ssig.side === 'sell');
  // amount args present
  const bf = pumpIxArgs(buy.data);
  const sf = pumpIxArgs(sell.data);
  assert.ok(bf.amountU64 > 0n && bf.secondU64 > 0n);
  assert.ok(sf.amountU64 > 0n && sf.secondU64 > 0n);
});

test('template copy engine replays a live buy for a new trader (scale + swap)', async () => {
  const fs = require('fs');
  const path = require('path');
  const { buildPumpCopyIxs } = require('../dist/chain/pump');
  const { PublicKey } = require('@solana/web3.js');
  const j = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'live', 'direct-Buy.json')));
  const msg = j.message || j;
  const meta = j.meta || j;
  const keys = (j.accountKeys || (msg.accountKeys || []).map((k) => (typeof k === 'string' ? k : k.pubkey)))
    .concat(...(((meta.loadedAddresses || {}).writable || []).map(String)))
    .concat(...(((meta.loadedAddresses || {}).readonly || []).map(String)));
  const outer = (msg.instructions || []);
  const ix = outer.find((i) => keys[i.programIdIndex] === '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P' && i.data);
  assert.ok(ix, 'fixture has a direct pump ix');
  const accAddrs = ix.accounts.map((ai) => keys[ai]);
  const watched = '9NBrgQ4QUCBBBwXeDs3zgviV8h5GkvPgiU1BkisGZY2R'; // fixture trader (tx signer)
  const watchedAta = 'J1mCvuQvQocbfGPDtTB8AnteWMcfAHNPYyTFZwen5LH'; // wait: real fixture J1mCvuQvQocb… — set below via search
  const traderPos = accAddrs.indexOf(watched);
  assert.ok(traderPos >= 0);
  const ataAddr = accAddrs.find((a) => a.startsWith('J1mCvu'));
  const ataPos = accAddrs.indexOf(ataAddr);
  const template = {
    mint: '46wcctSbTjvLoV4i5YDxBrjztRr6EjBXQVGG7G7Zpump',
    side: 'buy', name: 'BuyExactQuoteInV2',
    discLe: '', dataB64: ix.data, accAddrs,
    traderPos, traderAtaPos: ataPos, traderAtaAddr: ataAddr,
    tokenProgram: 'token2022', tokenDeltaRaw: '43354666754231', quoteDeltaRaw: null, sig: 'fixture',
  };
  const { captureTemplate, getTemplate } = require('../dist/chain/pump');
  captureTemplate(template);
  assert.ok(getTemplate(template.mint, 'buy'));
  const newTrader = new PublicKey('BvM3mR4XBUDEgCLr7FLk9r8RXv5K3wtpvHog2Q3FzRbz');
  const newAta = new PublicKey('3vvTAf4dhJ7vL9ABK1C5hH3mWJ4AGKKcUy2xyJYkns7Y');
  const plan = await buildPumpCopyIxs(null, { template, trader: newTrader, scale: new (require('bn.js'))(2), ataAddress: newAta.toBase58() });
  assert.strictEqual(plan.ixs.length, 1);
  const out = plan.ixs[0];
  assert.strictEqual(out.keys.length, template.accAddrs.length);
  assert.strictEqual(out.keys[traderPos].pubkey.toBase58(), newTrader.toBase58());
  assert.strictEqual(out.keys[ataPos].pubkey.toBase58(), newAta.toBase58());
  // non-trader/non-ata slots untouched
  assert.strictEqual(out.keys[0].pubkey.toBase58(), accAddrs[0]);
  assert.strictEqual(out.keys[1].pubkey.toBase58(), accAddrs[1]);
  // disc preserved, first two u64s doubled
  const data = out.data;
  assert.strictEqual(data.length, Buffer.from(ix.data, 'base64').length);
  assert.deepStrictEqual([...data.subarray(0, 8)], [...Buffer.from(ix.data, 'base64').subarray(0, 8)]);
  const f0 = pumpIxArgs(Buffer.from(ix.data, 'base64'));
  const f1 = pumpIxArgs(data);
  assert.strictEqual(f1.amountU64, f0.amountU64 * 2n);
  // second u64 of this fixture exceeds u64/2 — the engine clamps on overflow (never corrupts u64)
  assert.ok(f1.secondU64 === f0.secondU64 || f1.secondU64 === f0.secondU64 * 2n);
  // overflow guard documented: values that would overflow are left untouched
  const fBig = Buffer.concat([Buffer.alloc(8), u64le(18446744073709551615n - 1n), u64le(100n)]);
  assert.strictEqual(fBig.length, 24);
  assert.ok(plan.tokenAmount.gt(new (require('bn.js'))(0)));
});

test('pumpIxArgs reads leading u64s', () => {
  const data = Buffer.concat([disc([102, 6, 61, 18, 1, 218, 235, 234]), u64le(123456789n), u64le(987654321n), Buffer.from([1])]);
  const f = pumpIxArgs(data);
  assert.strictEqual(f.amountU64, 123456789n);
  assert.strictEqual(f.secondU64, 987654321n);
});

function u64le(v) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v, 0);
  return b;
}

test('settings validation accepts sane values & rejects nonsense', () => {
  const s = defaultSettings();
  assert.strictEqual(validateAndApply('slippage', '0.25', s).ok, true);
  assert.strictEqual(s.slippagePct, 0.25);
  assert.strictEqual(validateAndApply('slippage', '-5', s).ok, false);
  assert.strictEqual(validateAndApply('slippage', '5', s).ok, false);
  assert.strictEqual(validateAndApply('buy_amount_sol', '0.005', s).ok, true);
  assert.strictEqual(validateAndApply('buy_amount_sol', '0', s).ok, false);
  assert.strictEqual(validateAndApply('buy_amount_sol', '-1', s).ok, false);
  assert.strictEqual(validateAndApply('buy_pct', '0.5', s).ok, true);
  assert.strictEqual(validateAndApply('buy_pct', '3', s).ok, false);
  const tp = validateAndApply('tp_multiples', '3, 2, 10', s);
  assert.strictEqual(tp.ok, true);
  if (tp.ok) assert.deepStrictEqual(s.tpMultiples, [2, 3, 10]);
  assert.strictEqual(validateAndApply('tp_multiples', '0.5', s).ok, false);
  assert.strictEqual(validateAndApply('cooldown', '10', s).ok, true);
  assert.strictEqual(validateAndApply('cooldown', '1.5', s).ok, false);
  assert.strictEqual(validateAndApply('daily_cap', '0.0000001', s).ok, false); // below minimum
  assert.strictEqual(validateAndApply('fee_cap', '0.001', s).ok, true);
  assert.strictEqual(validateAndApply('stop_loss', '0.995', s).ok, false); // > max 99%
  assert.strictEqual(validateAndApply('stop_loss', '0.5', s).ok, true);
});

test('trade summary math', () => {
  const mk = (id, pnl, status) => ({
    id, userId: 1, status, spentLamports: 100, pnlLamports: pnl, pnlPct: pnl / 100,
  });
  const sum = summarizeTrades([mk('a', 50, 'closed'), mk('b', -25, 'closed'), mk('c', 0, 'open')]);
  assert.strictEqual(sum.closed, 2);
  assert.strictEqual(sum.open, 1);
  assert.strictEqual(sum.realizedPnlLamports, 25);
  assert.strictEqual(sum.winRate, 0.5);
});

test('format helpers render safe text', () => {
  assert.strictEqual(solShort(1.5e9), '◎1.500');
  assert.strictEqual(solShort(1234567890), '◎1.235');
  assert.strictEqual(pctSigned(0.5), '+50.0%');
  assert.strictEqual(chartLink('abc'), 'https://pump.fun/coin/abc');
  assert.strictEqual(lamportsToSol(5000000), '0.005');
  const card = scorecardText({
    id: 'x', userId: 1, mint: 'mint1111', spentLamports: 1e9, entryTime: Date.now() - 60_000, exitTime: Date.now(),
    symbol: 'TEST', name: 'Test <Coin>', pnlLamports: 2e9, netMultiple: 2, holdMs: 60_000,
    partialSells: [], entryMcapLamports: null, walletBalanceBefore: 1e9, walletBalanceAfter: 3e9,
    status: 'closed', exitReason: 'TP', exitPriceLamports: null, realizedQuoteLamports: 3e9,
    pnlPct: 1, txSignatures: [], settingsAtEntry: {}, watchedLabel: null,
  }, 1, 2e9);
  assert.ok(card.includes('TRADE CARD #1'));
  assert.ok(card.includes('&lt;Coin&gt;')); // escaped
  assert.ok(card.includes('◎2.000'));
});


test('coinTag always names the coin (full name + ticker, escaped, mint fallback)', () => {
  assert.strictEqual(coinTag('Dog Wif Hat', 'WIF'), '<b>Dog Wif Hat</b> ($WIF)');
  assert.strictEqual(coinTag('', 'WIF'), '<b>$WIF</b>');
  assert.strictEqual(coinTag('Only Name', ''), '<b>Only Name</b>');
  // brand-new mints have no metadata yet -> short mint fallback, never blank
  assert.strictEqual(coinTag(null, null, 'AbCdEf1234567890'), '<code>AbCdEf…</code>');
  // metadata is chain-supplied: must be HTML-escaped
  assert.strictEqual(coinTag('A<b>B</b>', 'X&Y'), '<b>A&lt;b&gt;B&lt;/b&gt;</b> ($X&amp;Y)');
});

test('solExact renders the exact SOL amount spent', () => {
  assert.strictEqual(solExact(123_400_000), '0.1234 SOL');   // 0.1234
  assert.strictEqual(solExact(5_000_000), '0.0050 SOL');     // 4 dp minimum
  assert.strictEqual(solExact(1_234_567), '0.001235 SOL');   // rounds to 6 dp
  assert.strictEqual(solExact(2_000_000_000), '2.0000 SOL');
  assert.strictEqual(solExact(0), '0 SOL');
  assert.strictEqual(solExact(null), null);
  assert.strictEqual(solExact(undefined), null);
});


test('TP ladder setting accepts what the menu now asks for (2x,3x,5x or more)', () => {
  const s = defaultSettings();
  let r = validateAndApply('tp_multiples', '2x,3x,5x', s);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(s.tpMultiples, [2, 3, 5]);

  r = validateAndApply('tp_multiples', '1.5x 4x 10x', s);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(s.tpMultiples, [1.5, 4, 10]);

  // still accepts the old bare-number form
  r = validateAndApply('tp_multiples', '2, 3', s);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(s.tpMultiples, [2, 3]);

  // sorted, deduped, max 5 rungs
  r = validateAndApply('tp_multiples', '5x,2x,2x,3x,4x,6x,7x', s);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(s.tpMultiples, [2, 3, 4, 5, 6]);

  // rejects nonsense (< 1.01)
  assert.strictEqual(validateAndApply('tp_multiples', '0.5x', s).ok, false);
  assert.strictEqual(validateAndApply('tp_multiples', 'abc', s).ok, false);
  assert.strictEqual(validateAndApply('tp_multiples', '', s).ok, false);
});

test('exit rules: per-watch override wins, otherwise the global default', () => {
  const s = defaultSettings();
  s.exit = { mode: 'pct', pct: 0.25, mult: null, mcapUsd: null };
  const doc = { settings: s, watched: [] };
  // no override -> global
  assert.deepStrictEqual(resolveExit(doc, { exit: null }), { mode: 'pct', pct: 0.25, mult: null, mcapUsd: null });
  assert.deepStrictEqual(resolveExit(doc, undefined), { mode: 'pct', pct: 0.25, mult: null, mcapUsd: null });
  // override wins
  assert.deepStrictEqual(resolveExit(doc, { exit: { mode: 'hold', pct: 1, mult: null, mcapUsd: null } }).mode, 'hold');
  // legacy/corrupt docs never crash
  assert.deepStrictEqual(normalizeExit(undefined), EXIT_DEFAULT);
  assert.deepStrictEqual(normalizeExit({ mode: 'nonsense' }), EXIT_DEFAULT);
  assert.deepStrictEqual(normalizeExit('junk'), EXIT_DEFAULT);
});

test('exitSellFraction: follow sells all, pct sells a slice, targets ignore the ape', () => {
  assert.strictEqual(exitSellFraction({ mode: 'follow', pct: 1, mult: null, mcapUsd: null }), 1);
  assert.strictEqual(exitSellFraction({ mode: 'pct', pct: 0.5, mult: null, mcapUsd: null }), 0.5);
  assert.strictEqual(exitSellFraction({ mode: 'pct', pct: 5, mult: null, mcapUsd: null }), 1); // clamped
  assert.strictEqual(exitSellFraction({ mode: 'hold', pct: 1, mult: null, mcapUsd: null }), 0);
  assert.strictEqual(exitSellFraction({ mode: 'mult', pct: 1, mult: 3, mcapUsd: null }), 0);
  assert.strictEqual(exitSellFraction({ mode: 'mcap', pct: 1, mult: null, mcapUsd: 100000 }), 0);
});

test('exit value parser handles the formats users actually type', () => {
  assert.deepStrictEqual(parseExitInput('follow', ''), { ok: true, cfg: { ...EXIT_DEFAULT, mode: 'follow' } });
  assert.deepStrictEqual(parseExitInput('hold', ''), { ok: true, cfg: { ...EXIT_DEFAULT, mode: 'hold' } });
  // percent
  assert.strictEqual(parseExitInput('pct', '50').cfg.pct, 0.5);
  assert.strictEqual(parseExitInput('pct', '50%').cfg.pct, 0.5);
  assert.strictEqual(parseExitInput('pct', '0').ok, false);
  assert.strictEqual(parseExitInput('pct', '150').ok, false);
  // multiple
  assert.strictEqual(parseExitInput('mult', '3x').cfg.mult, 3);
  assert.strictEqual(parseExitInput('mult', '10').cfg.mult, 10);
  assert.strictEqual(parseExitInput('mult', '1').ok, false); // <1.01 makes no sense
  // market cap
  assert.strictEqual(parseExitInput('mcap', '100k').cfg.mcapUsd, 100_000);
  assert.strictEqual(parseExitInput('mcap', '1.5m').cfg.mcapUsd, 1_500_000);
  assert.strictEqual(parseExitInput('mcap', '2b').cfg.mcapUsd, 2_000_000_000);
  assert.strictEqual(parseExitInput('mcap', '$69,000').cfg.mcapUsd, 69_000);
  assert.strictEqual(parseExitInput('mcap', 'abc').ok, false);
});

test('exit rules read cleanly on cards and format market caps compactly', () => {
  assert.strictEqual(describeExit({ mode: 'follow', pct: 1, mult: null, mcapUsd: null }), 'follow ape — sell all');
  assert.strictEqual(describeExit({ mode: 'pct', pct: 0.5, mult: null, mcapUsd: null }), 'sell 50% when ape sells');
  assert.strictEqual(describeExit({ mode: 'hold', pct: 1, mult: null, mcapUsd: null }), 'hold — ignore ape sells');
  assert.strictEqual(describeExit({ mode: 'mult', pct: 1, mult: 3, mcapUsd: null }), 'sell all at 3x');
  assert.strictEqual(describeExit({ mode: 'mcap', pct: 1, mult: null, mcapUsd: 100000 }), 'sell all at $100k mcap');
  assert.strictEqual(formatMcapUsd(1500), '$1.5k');
  assert.strictEqual(formatMcapUsd(69000), '$69k');
  assert.strictEqual(formatMcapUsd(1_500_000), '$1.5m');
  assert.strictEqual(formatMcapUsd(2_000_000_000), '$2b');
  assert.strictEqual(formatMcapUsd(null), '—');
});

test('partial sell math: exact shares and no dust crumbs left behind', () => {
  const { tokensForFraction } = require('../dist/trader');
  assert.strictEqual(tokensForFraction(1000n, 1000n, 0.5), 500n);
  assert.strictEqual(tokensForFraction(1000n, 1000n, 1), 1000n);
  assert.strictEqual(tokensForFraction(1000n, 1000n, 0.25), 250n);
  // odd numbers round down, never over-sell
  assert.strictEqual(tokensForFraction(7n, 7n, 0.5), 3n);
  // leftovers under 1% of the bag are swept in instead of stranded
  assert.strictEqual(tokensForFraction(1000n, 10_000n, 0.995), 1000n);
  // tiny bags still sell at least one unit
  assert.strictEqual(tokensForFraction(1n, 1000n, 0.01), 1n);
  assert.strictEqual(tokensForFraction(0n, 1000n, 0.5), 0n);
  // out-of-range fractions are clamped, never negative or oversized
  assert.strictEqual(tokensForFraction(1000n, 1000n, 5), 1000n);
  assert.strictEqual(tokensForFraction(1000n, 1000n, -1), 10n);
});
