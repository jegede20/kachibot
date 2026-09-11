'use strict';
/** Unit tests: the 🏆 PnL scorecard maths (pure, no network). */
const { test } = require('node:test');
const assert = require('node:assert');
process.env.ENCRYPTION_KEY = 'test-only-key-abcdef';

const { scorecardStats } = require('../dist/types');
const { pnlScorecardText, sol4, sol4Signed, usdShort } = require('../dist/format');

const NOW = 1_800_000_000_000;
const SOL = 1e9;
let seq = 0;
function row(o) {
  seq++;
  const spent = o.spent * SOL;
  const mult = o.mult ?? 1;
  return {
    id: o.id || 'r' + seq,
    userId: 1,
    mint: 'Mint' + seq + 'pump',
    symbol: o.symbol || 'T' + seq,
    name: 'coin ' + seq,
    status: o.status || 'closed',
    entryTime: o.entryTime ?? NOW - 10 * 3600_000,
    exitTime: o.status === 'open' ? null : (o.exitTime ?? NOW - 9 * 3600_000),
    spentLamports: spent,
    pnlLamports: o.pnl !== undefined ? o.pnl * SOL : spent * (mult - 1),
    netMultiple: mult,
    holdMs: o.holdMs ?? 3600_000,
    watchedLabel: o.ape || 'manual',
    partialSells: o.partials || [],
  };
}

test('scorecardStats: totals, bought vs sold and return %', () => {
  const rows = [
    row({ symbol: 'WIN', spent: 1, mult: 3 }),   // +2
    row({ symbol: 'LOSS', spent: 1, mult: 0.5 }), // -0.5
  ];
  const st = scorecardStats(rows);
  assert.equal(st.closed, 2);
  assert.equal(st.realizedLamports, 1.5 * SOL);
  assert.equal(st.boughtLamports, 2 * SOL);
  assert.equal(st.soldLamports, 3.5 * SOL); // bought + realized
  assert.equal(Math.round(st.returnPct * 1000) / 1000, 0.75);
});

test('scorecardStats: win rate and averages', () => {
  const rows = [
    row({ spent: 1, mult: 2 }),  // win +1
    row({ spent: 1, mult: 4 }),  // win +3
    row({ spent: 2, mult: 0.5 }),// loss -1
  ];
  const st = scorecardStats(rows);
  assert.equal(st.wins, 2);
  assert.equal(st.losses, 1);
  assert.equal(Math.round(st.winRate * 100), 67);
  assert.equal(st.avgWinLamports, 2 * SOL);       // (1 + 3) / 2
  assert.equal(st.avgLossLamports, -1 * SOL);
  assert.equal(Math.round(st.avgWinMultiple * 100), 300); // (2 + 4) / 2
});

test('scorecardStats: best is the biggest win, worst is the biggest loss', () => {
  const rows = [
    row({ symbol: 'SMALLWIN', spent: 1, mult: 1.2 }), // +0.2
    row({ symbol: 'BIGWIN', spent: 1, mult: 5 }),     // +4
    row({ symbol: 'SMALLLOSS', spent: 1, mult: 0.9 }),// -0.1
    row({ symbol: 'BIGLOSS', spent: 1, mult: 0.2 }),  // -0.8
  ];
  const st = scorecardStats(rows);
  assert.equal(st.best.symbol, 'BIGWIN');
  assert.equal(st.best.pnlLamports, 4 * SOL);
  assert.equal(st.worst.symbol, 'BIGLOSS'); // regression: was picking the mildest loss
  assert.equal(st.worst.pnlLamports, -0.8 * SOL);
});

test('scorecardStats: trailing win/loss streak counts from the latest close', () => {
  const rows = [
    row({ spent: 1, mult: 0.5, exitTime: NOW - 5 * 3600_000 }),  // L (oldest)
    row({ spent: 1, mult: 2, exitTime: NOW - 4 * 3600_000 }),    // W
    row({ spent: 1, mult: 3, exitTime: NOW - 3 * 3600_000 }),    // W
    row({ spent: 1, mult: 4, exitTime: NOW - 2 * 3600_000 }),    // W
  ];
  const st = scorecardStats(rows, { now: NOW });
  assert.deepEqual(st.streak, { kind: 'W', count: 3 });
});

test('scorecardStats: per-ape leaderboard sorted by profit', () => {
  const rows = [
    row({ ape: 'ape #1', spent: 1, mult: 3 }),  // +2
    row({ ape: 'ape #2', spent: 1, mult: 0.5 }),// -0.5
    row({ ape: 'ape #1', spent: 1, mult: 2 }),  // +1  -> ape #1 total +3
    row({ ape: 'ape #3', spent: 1, mult: 1.5 }) // +0.5
  ];
  const st = scorecardStats(rows);
  assert.equal(st.byApe.length, 3);
  assert.equal(st.byApe[0].label, 'ape #1');
  assert.equal(st.byApe[0].pnlLamports, 3 * SOL);
  assert.equal(st.byApe[0].closed, 2);
  assert.equal(st.byApe[0].wins, 2);
  assert.equal(st.byApe[st.byApe.length - 1].label, 'ape #2');
});

test('scorecardStats: unrealized only counts rows we could price', () => {
  const rows = [
    row({ id: 'o1', status: 'open', spent: 1 }),
    row({ id: 'o2', status: 'open', spent: 1 }),
  ];
  const st = scorecardStats(rows, { unrealizedByRow: { o1: 2 * SOL } }); // o2 unpriced
  assert.equal(st.openCount, 2);
  assert.equal(st.openPriced, 1);
  assert.equal(st.unrealizedLamports, 1 * SOL); // 2.0 live - 1.0 cost (o2 excluded entirely)
});

test('scorecardStats: unrealized includes SOL already banked from partial sells', () => {
  const rows = [row({
    id: 'o1', status: 'open', spent: 1,
    partials: [{ time: NOW, reason: 'TP', multiple: 2, tokenAmountRaw: '1', quoteLamports: 1.2 * SOL, txSignature: null }],
  })];
  const st = scorecardStats(rows, { unrealizedByRow: { o1: 0.5 * SOL } });
  assert.equal(st.unrealizedLamports, 0.7 * SOL); // 0.5 live + 1.2 banked - 1.0 cost
});

test('scorecardStats: last 7 days window and empty history', () => {
  const rows = [
    row({ spent: 1, mult: 2, exitTime: NOW - 2 * 86400_000 }),   // inside 7d
    row({ spent: 1, mult: 2, exitTime: NOW - 30 * 86400_000 }),  // outside
  ];
  const st = scorecardStats(rows, { now: NOW });
  assert.equal(st.closed, 2);
  assert.equal(st.last7.closed, 1);

  const empty = scorecardStats([]);
  assert.equal(empty.closed, 0);
  assert.equal(empty.winRate, 0);
  assert.equal(empty.best, null);
  assert.equal(empty.unrealizedLamports, null);
  assert.equal(empty.firstTradeAt, null);
});

test('sol4 / sol4Signed / usdShort money formatting', () => {
  assert.equal(sol4(5.936 * SOL), '5.9360 SOL');
  assert.equal(sol4Signed(-0.27 * SOL), '-0.2700 SOL');
  assert.equal(sol4Signed(0), '+0.0000 SOL');
  assert.equal(usdShort(1068 / 180 * SOL, 180), '+$1,068');
  assert.equal(usdShort(-12.5 / 180 * SOL, 180), '-$12.50');
  assert.equal(usdShort(5 * SOL, null), null);
});

test('pnlScorecardText: renders a headline, money and an empty state', () => {
  const st = scorecardStats([row({ symbol: 'PACT', spent: 1, mult: 7, ape: 'ape #1' })]);
  const text = pnlScorecardText(st, 180);
  assert.match(text, /PnL SCORECARD/);
  assert.match(text, /\+6\.0000 SOL/);
  assert.match(text, /\+\$1,080/);
  assert.match(text, /who earned it/);
  assert.ok(!text.includes('◎'), 'scorecard never mixes the scope glyph with SOL');

  const blank = pnlScorecardText(scorecardStats([]), 180);
  assert.match(blank, /no closed copies yet/);
});
