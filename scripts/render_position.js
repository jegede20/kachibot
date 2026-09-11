/** Offline preview of the live POSITION card (no Telegram, no network). */
const { positionMath } = require('../dist/types');
const { positionScorecardText, scorecardText } = require('../dist/format');

const SOL = 1e9;
const now = Date.now();
const row = (o = {}) => ({
  id: 'p1', userId: 1, mint: 'J2EpCXn3Pt5UsyQ1DnJyCervJtYhskmcptU9ZNa9pump',
  symbol: o.symbol || 'PACT', name: o.name || 'We Made a Pact',
  status: o.status || 'open',
  entryTime: now - (o.agoMs || 2 * 3600_000),
  exitTime: o.status === 'closed' ? now - (o.agoMs || 2 * 3600_000) + (o.holdMs || 3600_000) : null,
  spentLamports: o.spent ?? 0.05 * SOL,
  realizedQuoteLamports: o.status === 'closed' ? (o.sold ?? 0.11 * SOL) : null,
  pnlLamports: o.status === 'closed' ? (o.sold ?? 0.11 * SOL) - (o.spent ?? 0.05 * SOL) : null,
  netMultiple: o.status === 'closed' ? (o.sold ?? 0.11 * SOL) / (o.spent ?? 0.05 * SOL) : null,
  pnlPct: o.status === 'closed' ? ((o.sold ?? 0.11 * SOL) - (o.spent ?? 0.05 * SOL)) / (o.spent ?? 0.05 * SOL) : null,
  holdMs: o.status === 'closed' ? (o.holdMs || 3600_000) : null,
  entryTokenAmount: '15800000000000',
  entryPriceLamports: 3.2e-6 * SOL,
  entryMcapLamports: 28.4e3 / 180 * SOL,
  exitPriceLamports: o.status === 'closed' ? 7e-6 * SOL : null,
  exitReason: o.status === 'closed' ? 'TP' : null,
  peakMultiple: o.peak ?? 2.1,
  partialSells: o.partials || [],
  watchedLabel: o.ape || 'ape #1',
  walletBalanceBefore: 1.2 * SOL, walletBalanceAfter: o.status === 'closed' ? 1.31 * SOL : null,
  settingsAtEntry: { tpMultiples: [2, 3], stopLossPct: 0.5, copySell: true, copySellMode: 'mirror', slippagePct: 0.25, maxFeeLamports: 1e6, trailing: { enabled: false }, breakEvenStop: true, maxHoldMs: null, exit: { mode: 'follow', pct: 1 } },
});

const r1 = row();
console.log('──────── 1) RUNNING POSITION (in profit) ────────\n');
console.log(positionScorecardText(r1, {
  live: 0.081 * SOL, math: positionMath(r1, 0.081 * SOL),
  pricePerToken: 5.1e-6 * SOL, mcapLamports: 45.9e3 / 180 * SOL, entryPricePerToken: 3.2e-6 * SOL,
}, 180));

const r2 = row({ partials: [{ time: now, reason: 'TP', multiple: 2, tokenAmountRaw: '9480000000000', quoteLamports: 0.06 * SOL, txSignature: null }] });
console.log('\n\n──────── 2) MOONBAG (60% banked, 40% still open) ────────\n');
console.log(positionScorecardText(r2, {
  live: 0.02 * SOL, math: positionMath(r2, 0.02 * SOL),
  pricePerToken: 3.2e-6 * SOL, mcapLamports: 28.4e3 / 180 * SOL, entryPricePerToken: 3.2e-6 * SOL,
}, 180));

const r3 = row({ agoMs: 25 * 60_000, peak: 1.1 });
console.log('\n\n──────── 3) DOWN (early, -20%) ────────\n');
console.log(positionScorecardText(r3, {
  live: 0.04 * SOL, math: positionMath(r3, 0.04 * SOL),
  pricePerToken: 2.5e-6 * SOL, mcapLamports: 22e3 / 180 * SOL, entryPricePerToken: 3.2e-6 * SOL,
}, 180));

const r4 = row();
console.log('\n\n──────── 4) PRICE FEED DEAD ────────\n');
console.log(positionScorecardText(r4, { live: null, math: positionMath(r4, null), pricePerToken: null, mcapLamports: null, entryPricePerToken: 3.2e-6 * SOL }, 180));

const r5 = row({ status: 'closed', sold: 0.106 * SOL, holdMs: 47 * 60_000, agoMs: 3 * 3600_000 });
console.log('\n\n──────── 5) AFTER-TRADE CARD (closed at 2.1x) ────────\n');
console.log(scorecardText(r5, 3, 0.056 * SOL));
