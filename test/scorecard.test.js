'use strict';
/** Unit tests: the KACHIBOT share card — data mapping + SVG template. */
const { test } = require('node:test');
const assert = require('node:assert');
process.env.ENCRYPTION_KEY = 'test-only-key-abcdef';

const { scorecardSvg, renderScorecard, SCORECARD_TAGLINE } = require('../dist/card/scorecard');
const {
  tradeScorecardModel, overallScorecardModel, avgMcapLamports, topExitReason,
  cardReasonLabel, pctCardText, multCardText, solCardText, durCard,
} = require('../dist/card/model');
const { scorecardStats } = require('../dist/types');

const SOL = 1e9;
const NOW = 1_800_000_000_000;

const trade = (over = {}) => ({
  id: 't1', userId: 1, watchId: null, watchedAddress: null, watchedLabel: null,
  mint: 'Mint1111111111111111111111111111111111111111',
  symbol: 'MOONK', name: 'Moonk', tokenProgram: 'spl',
  entryTime: NOW - 2 * 3600e3, exitTime: NOW,
  spentLamports: 0.63 * SOL, entryTokenAmount: '1000', entryPriceLamports: 1e-9,
  entryMcapLamports: 91 * SOL, walletBalanceBefore: 1.2 * SOL, peakMultiple: 5.4,
  settingsAtEntry: { tpMultiples: [2, 3, 5], stopLossPct: 50, copySell: true, slippagePct: 12, maxFeeLamports: 1e7 },
  partialSells: [], status: 'closed', exitReason: 'COPY_SELL',
  realizedQuoteLamports: 3.28 * SOL, exitPriceLamports: 5.2e-9,
  walletBalanceAfter: 3.85 * SOL, pnlLamports: 2.65 * SOL, pnlPct: 4.2, netMultiple: 5.2,
  holdMs: (2 * 60 + 14) * 60e3, ...over,
});

const ROW_LABELS = ['Entry MC', 'Exit MC', 'Duration', 'Balance before', 'Balance after', 'Exit reason'];

/* ------------------------------- formatting ------------------------------- */

test('pctCardText: whole percents when big, one decimal when small', () => {
  assert.strictEqual(pctCardText(4.17), '+417%');
  assert.strictEqual(pctCardText(-0.92), '-92%');
  assert.strictEqual(pctCardText(0.052), '+5.2%');
  assert.strictEqual(pctCardText(0), '+0.00%');
  assert.strictEqual(pctCardText(NaN), '0%');
});

test('multCardText: one decimal at/above 1x, two below', () => {
  assert.strictEqual(multCardText(5.24), '5.2X');
  assert.strictEqual(multCardText(0.08), '0.08X');
  assert.strictEqual(multCardText(0), '0.00X');
  assert.strictEqual(multCardText(-3), '0.00X');
});

test('solCardText / durCard / cardReasonLabel', () => {
  assert.strictEqual(solCardText(1.2 * SOL), '1.20 SOL');
  assert.strictEqual(solCardText(null), '—');
  assert.strictEqual(durCard(12 * 60e3), '12m');
  assert.strictEqual(durCard((2 * 60 + 14) * 60e3), '2h 14m');
  assert.strictEqual(durCard(45_000), '45s');
  assert.strictEqual(durCard(null), '—');
  assert.strictEqual(cardReasonLabel('COPY_SELL'), 'Wallet sold');
  assert.strictEqual(cardReasonLabel('RUG'), 'Rug detected');
  assert.strictEqual(cardReasonLabel(null), '—');
});

/* ------------------------------ per-trade card ---------------------------- */

test('trade card: bullish copy fills every slot of the house design', () => {
  const m = tradeScorecardModel({ trade: trade(), exitMcapLamports: 470 * SOL, solUsd: 200, now: NOW });
  assert.strictEqual(m.token, '$MOONK');
  assert.strictEqual(m.verdict, 'Bullish');
  assert.strictEqual(m.qualifier, null);
  assert.strictEqual(m.pct, '+421%');
  assert.strictEqual(m.multiple, '5.2X');
  assert.strictEqual(m.trend, 'up');
  assert.deepStrictEqual(m.rows.map((r) => r.label), ROW_LABELS);
  assert.strictEqual(m.rows[0].value, '$18.2K');        // 91 SOL @ $200
  assert.strictEqual(m.rows[1].value, '$94.0K');        // 470 SOL @ $200
  assert.strictEqual(m.rows[2].value, '2h 14m');
  assert.strictEqual(m.rows[3].value, '1.20 SOL');
  assert.strictEqual(m.rows[4].value, '3.85 SOL');
  assert.strictEqual(m.rows[5].value, 'Wallet sold');
  assert.strictEqual(m.footer, 'MOONK : 2h 14m held');
});

test('trade card: rug exit is bearish and qualifies the verdict', () => {
  const m = tradeScorecardModel({
    trade: trade({
      symbol: 'grift', exitReason: 'RUG', pnlLamports: -1.84 * SOL, netMultiple: 0.08,
      spentLamports: 2 * SOL, holdMs: 12 * 60e3, walletBalanceBefore: 2 * SOL, walletBalanceAfter: 0.16 * SOL,
    }),
    exitMcapLamports: 10.5 * SOL, solUsd: 200, now: NOW,
  });
  assert.strictEqual(m.token, '$GRIFT');
  assert.strictEqual(m.verdict, 'Bearish');
  assert.strictEqual(m.qualifier, 'Rug');
  assert.strictEqual(m.pct, '-92%');
  assert.strictEqual(m.multiple, '0.08X');
  assert.strictEqual(m.trend, 'down');
  assert.strictEqual(m.rows[5].value, 'Rug detected');
  assert.strictEqual(m.footer, 'GRIFT : 12m held');
});

test('trade card: missing values degrade to a dash, never undefined', () => {
  const m = tradeScorecardModel({
    trade: trade({ entryMcapLamports: null, walletBalanceBefore: null, walletBalanceAfter: null, holdMs: null, exitReason: null, exitTime: null }),
    exitMcapLamports: null, solUsd: null, now: NOW,
  });
  assert.strictEqual(m.rows[0].value, '—');
  assert.strictEqual(m.rows[1].value, '—');
  assert.strictEqual(m.rows[3].value, '—');
  assert.strictEqual(m.rows[4].value, '—');
  assert.strictEqual(m.rows[5].value, '—');
  assert.strictEqual(m.rows[2].value, '2h 0m');   // open rows count from entry to now
});

/* ------------------------------ account PnL card -------------------------- */

test('overall card: same six labels, account-wide values', () => {
  const rows = [
    trade({ id: 'a', pnlLamports: 2.65 * SOL, netMultiple: 5.2, exitReason: 'COPY_SELL', holdMs: 2 * 3600e3 }),
    trade({ id: 'b', pnlLamports: -1.84 * SOL, netMultiple: 0.08, exitReason: 'RUG', holdMs: 12 * 60e3 }),
    trade({ id: 'c', pnlLamports: -0.0055 * SOL, netMultiple: 0.77, exitReason: 'MANUAL', holdMs: 45 * 60e3 }),
  ];
  const st = scorecardStats(rows, {});
  const m = overallScorecardModel({
    stats: st, solUsd: 200,
    avgEntryMcapLamports: avgMcapLamports(rows, (t) => t.entryMcapLamports),
    avgExitMcapLamports: avgMcapLamports(rows, (t) => t.exitMcapLamports ?? null),
    topReason: topExitReason(rows),
  });
  assert.strictEqual(m.token, 'OVERALL');
  assert.deepStrictEqual(m.rows.map((r) => r.label), ROW_LABELS);
  assert.strictEqual(m.rows[3].value, solCardText(st.boughtLamports));
  assert.strictEqual(m.rows[4].value, solCardText(st.soldLamports));
  assert.strictEqual(m.rows[5].value, 'Wallet sold');    // one each -> first seen wins the tie
  assert.match(m.footer, /^3 trades : \d+m avg hold$/);
});

test('avgMcapLamports ignores nulls; topExitReason counts closed reasons', () => {
  assert.strictEqual(avgMcapLamports([], (t) => t.entryMcapLamports), null);
  assert.strictEqual(avgMcapLamports([{ entryMcapLamports: 10 }, { entryMcapLamports: null }, { entryMcapLamports: 30 }], (t) => t.entryMcapLamports), 20);
  assert.strictEqual(topExitReason([{ exitReason: 'TP' }, { exitReason: 'RUG' }, { exitReason: 'RUG' }]), 'RUG');
  assert.strictEqual(topExitReason([]), null);
});

/* ---------------------------------- svg ---------------------------------- */

test('svg: carries every element of the design in the fixed order', () => {
  const m = tradeScorecardModel({ trade: trade(), exitMcapLamports: 470 * SOL, solUsd: 200, now: NOW });
  const svg = scorecardSvg(m);
  assert.match(svg, /width="1200" height="675"/);
  const esc = (s) => s.replace(/'/g, '&apos;');
  for (const t of ['KACHIBOT', 'SOLANASNIPERBOT', '$MOONK', 'Bullish', '+421%', '5.2X', 'MOONK : 2h 14m held', esc(SCORECARD_TAGLINE)]) {
    assert.ok(svg.includes(t), `missing ${t}`);
  }
  const at = svg.split('\n');
  let last = -1;
  for (const label of ROW_LABELS) {
    const i = at.findIndex((l, idx) => idx > last && l.includes(`>${label}<`));
    assert.ok(i > last, `row "${label}" out of order`);
    last = i;
  }
});

test('svg: bullish and bearish use the house palette', () => {
  const bull = scorecardSvg(tradeScorecardModel({ trade: trade(), solUsd: 200, now: NOW }));
  assert.ok(bull.includes('#3ecf6e') && bull.includes('#122e1c'), 'bullish ink + pill fill');
  const bear = scorecardSvg(tradeScorecardModel({ trade: trade({ pnlLamports: -1 * SOL, exitReason: 'RUG' }), solUsd: 200, now: NOW }));
  assert.ok(bear.includes('#e04a4a') && bear.includes('#301414'), 'bearish ink + pill fill');
  assert.ok(!bear.includes('#3ecf6e'), 'bearish card must not be green');
});

test('svg: always six rows, and text is xml-escaped', () => {
  const m = tradeScorecardModel({ trade: trade({ symbol: '<X&Y>' }), solUsd: 200, now: NOW });
  const svg = scorecardSvg(m);
  assert.strictEqual((svg.match(/text-anchor="end"/g) || []).length, 6);
  assert.ok(svg.includes('&lt;X&amp;Y&gt;'));
  assert.ok(!svg.includes('<X&Y>'));
});

test('svg: long tickers shrink inside the chip instead of overlapping the pill', () => {
  const long = scorecardSvg(tradeScorecardModel({ trade: trade({ symbol: 'VERYLONGTOKENNAME' }), solUsd: 200, now: NOW }));
  const size = Number(/font-size="(\d+)"[^>]*>\$VERYLONGTOKENNAME/.exec(long)?.[1] ?? 99);
  assert.ok(size < 16, `expected a smaller font, got ${size}`);
});

/* -------------------------------- render --------------------------------- */

test('renderScorecard produces a real PNG', async () => {
  const png = await renderScorecard(tradeScorecardModel({ trade: trade(), exitMcapLamports: 470 * SOL, solUsd: 200, now: NOW }));
  assert.ok(Buffer.isBuffer(png));
  assert.ok(png.length > 10_000, `suspiciously small png: ${png.length}`);
  assert.strictEqual(png.slice(1, 4).toString(), 'PNG');
  assert.strictEqual(png.readUInt32BE(16), 1200);   // width
  assert.strictEqual(png.readUInt32BE(20), 675);    // height
});
