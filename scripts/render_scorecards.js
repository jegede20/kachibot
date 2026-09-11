'use strict';
/**
 * Offline preview of the KACHIBOT card renderer.
 *   node scripts/render_scorecards.js
 * Writes out/*.png so the layout can be eyeballed (and OCR-checked) without
 * touching Telegram.
 */
const fs = require('node:fs');
const path = require('node:path');
const { renderScorecard } = require('../dist/card/scorecard');
const { tradeScorecardModel, overallScorecardModel, avgMcapLamports, topExitReason } = require('../dist/card/model');
const { scorecardStats } = require('../dist/types');

const SOL = 1e9;
const OUT = path.join(__dirname, '..', 'out');
fs.mkdirSync(OUT, { recursive: true });

const row = (over = {}) => ({
  id: 't1',
  userId: 1,
  watchId: null,
  watchedAddress: null,
  watchedLabel: null,
  mint: 'MINT',
  symbol: 'MOONK',
  name: 'Moonk',
  tokenProgram: 'spl',
  entryTime: Date.now() - 2 * 3600e3,
  exitTime: Date.now(),
  spentLamports: 0.63 * SOL,
  entryTokenAmount: '1000',
  entryPriceLamports: 1e-9,
  entryMcapLamports: 18.2e3 / 200 * SOL,   // ~= $18.2K with SOL at $200
  walletBalanceBefore: 1.2 * SOL,
  peakMultiple: 5.4,
  settingsAtEntry: { tpMultiples: [2, 3, 5], stopLossPct: 50, copySell: true, slippagePct: 12, maxFeeLamports: 1e7 },
  partialSells: [],
  status: 'closed',
  exitReason: 'COPY_SELL',
  realizedQuoteLamports: 3.28 * SOL,
  exitPriceLamports: 5.2e-9,
  walletBalanceAfter: 3.85 * SOL,
  pnlLamports: 2.65 * SOL,
  pnlPct: 4.17,
  netMultiple: 5.2,
  holdMs: (2 * 60 + 14) * 60e3,
  ...over,
});

async function main() {
  const solUsd = 200;

  // 1 — bullish copy, mirrors the reference bullish mockup
  const bull = tradeScorecardModel({
    trade: row({ symbol: 'MOONK', exitReason: 'COPY_SELL' }),
    exitMcapLamports: 94.1e3 / solUsd * SOL,
    solUsd,
  });
  await renderScorecard(bull).then((b) => fs.writeFileSync(path.join(OUT, 'card-bullish.png'), b));

  // 2 — bearish rug, mirrors the reference bearish mockup
  const bear = tradeScorecardModel({
    trade: row({
      symbol: 'GRIFT',
      spentLamports: 2 * SOL,
      realizedQuoteLamports: 0.16 * SOL,
      pnlLamports: -1.84 * SOL,
      pnlPct: -0.92,
      netMultiple: 0.08,
      exitReason: 'RUG',
      entryMcapLamports: 31.4e3 / solUsd * SOL,
      walletBalanceBefore: 2 * SOL,
      walletBalanceAfter: 0.16 * SOL,
      holdMs: 12 * 60e3,
    }),
    exitMcapLamports: 2.1e3 / solUsd * SOL,
    solUsd,
  });
  await renderScorecard(bear).then((b) => fs.writeFileSync(path.join(OUT, 'card-bearish.png'), b));

  // 3 — account-wide PnL card, same template
  const rows = [
    row({ id: 'a', symbol: 'MOONK', pnlLamports: 2.65 * SOL, netMultiple: 5.2, exitReason: 'COPY_SELL', holdMs: 2 * 3600e3, exitMcapLamports: 94.1e3 / solUsd * SOL }),
    row({ id: 'b', symbol: 'GRIFT', spentLamports: 2 * SOL, realizedQuoteLamports: 0.16 * SOL, pnlLamports: -1.84 * SOL, netMultiple: 0.08, exitReason: 'RUG', holdMs: 12 * 60e3, entryMcapLamports: 31.4e3 / solUsd * SOL, exitMcapLamports: 2.1e3 / solUsd * SOL }),
    row({ id: 'c', symbol: 'HaWG', spentLamports: 0.0235 * SOL, realizedQuoteLamports: 0.018 * SOL, pnlLamports: -0.0055 * SOL, netMultiple: 0.77, exitReason: 'MANUAL', holdMs: 45 * 60e3, entryMcapLamports: 25.4e3 / solUsd * SOL, exitMcapLamports: 19e3 / solUsd * SOL }),
  ];
  const st = scorecardStats(rows, {});
  const overall = overallScorecardModel({
    stats: st,
    solUsd,
    avgEntryMcapLamports: avgMcapLamports(rows, (t) => t.entryMcapLamports),
    avgExitMcapLamports: avgMcapLamports(rows, (t) => t.exitMcapLamports ?? null),
    topReason: topExitReason(rows),
  });
  await renderScorecard(overall).then((b) => fs.writeFileSync(path.join(OUT, 'card-overall.png'), b));

  console.log('wrote:');
  for (const f of ['card-bullish.png', 'card-bearish.png', 'card-overall.png']) {
    const p = path.join(OUT, f);
    console.log(' ', p, fs.statSync(p).size, 'bytes');
  }
  console.log('\nbullish model:', JSON.stringify({ token: bull.token, verdict: bull.verdict, pct: bull.pct, multiple: bull.multiple, rows: bull.rows, footer: bull.footer }, null, 1));
  console.log('bearish model:', JSON.stringify({ token: bear.token, verdict: bear.verdict, qualifier: bear.qualifier, pct: bear.pct, multiple: bear.multiple, rows: bear.rows, footer: bear.footer }, null, 1));
  console.log('overall model:', JSON.stringify({ token: overall.token, verdict: overall.verdict, pct: overall.pct, multiple: overall.multiple, rows: overall.rows, footer: overall.footer }, null, 1));
}

main().catch((e) => { console.error(e); process.exit(1); });
