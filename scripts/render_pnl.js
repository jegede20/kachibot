/** Offline preview of the 🏆 PnL scorecard (no Telegram, no network). */
const { scorecardStats } = require('../dist/types');
const { pnlScorecardText } = require('../dist/format');

const NOW = Date.now();
const H = 3600_000;
let n = 0;
function row(o) {
  n++;
  return {
    id: 'r' + n, userId: 1, mint: 'Mint' + n + 'pump',
    symbol: o.symbol, name: o.symbol + ' coin',
    status: o.status || 'closed',
    entryTime: NOW - (o.agoMs || 2 * H), exitTime: o.status === 'open' ? null : NOW - (o.agoMs || 2 * H) + (o.holdMs || 1800_000),
    spentLamports: o.spent, pnlLamports: o.pnl ?? o.spent * ((o.mult ?? 1) - 1),
    netMultiple: o.mult ?? 1 + (o.pnl ?? 0) / o.spent,
    holdMs: o.holdMs || 1800_000,
    watchedLabel: o.ape || 'manual',
    partialSells: o.partials || [],
  };
}
// a realistically messy copy-trading history
const rows = [
  row({ symbol: 'PACT', spent: 0.5e9, mult: 7.1, ape: 'ape #1', holdMs: 4 * H, agoMs: 96 * H }),
  row({ symbol: 'MOON', spent: 0.4e9, mult: 3.2, ape: 'ape #1', holdMs: 2 * H, agoMs: 90 * H }),
  row({ symbol: 'DOGS', spent: 0.3e9, mult: 0.32, ape: 'ape #3', holdMs: 40 * 60_000, agoMs: 88 * H }),
  row({ symbol: 'WOJAK', spent: 0.25e9, mult: 2.1, ape: 'ape #3', holdMs: 6 * H, agoMs: 70 * H }),
  row({ symbol: 'FWOG', spent: 0.2e9, mult: 0.55, ape: 'ape #2', holdMs: 30 * 60_000, agoMs: 60 * H }),
  row({ symbol: 'GIGA', spent: 0.5e9, mult: 2.6, ape: 'ape #1', holdMs: 9 * H, agoMs: 50 * H }),
  row({ symbol: 'PONKE', spent: 0.35e9, mult: 0.7, ape: 'ape #2', holdMs: 5 * H, agoMs: 40 * H }),
  row({ symbol: 'BONK', spent: 0.6e9, mult: 1.9, ape: 'ape #1', holdMs: 12 * H, agoMs: 30 * H }),
  row({ symbol: 'WIF', spent: 0.45e9, mult: 0.4, ape: 'ape #3', holdMs: 3 * H, agoMs: 20 * H }),
  row({ symbol: 'MEW', spent: 0.3e9, mult: 4.4, ape: 'ape #1', holdMs: 7 * H, agoMs: 12 * H }),
  row({ symbol: 'PEPE', spent: 0.4e9, mult: 1.3, ape: 'ape #1', holdMs: 20 * 60_000, agoMs: 90 * H }),   // r11
  row({ symbol: 'NEWS', spent: 0.2e9, mult: 0.6, ape: 'ape #3', holdMs: 45 * 60_000, agoMs: 80 * H }),  // r12
  row({ symbol: 'OPEN1', spent: 0.5e9, status: 'open', ape: 'ape #1', agoMs: 3 * H, partials: [] }),
  row({ symbol: 'OPEN2', spent: 0.3e9, status: 'open', ape: 'ape #3', agoMs: 1 * H,
        partials: [{ time: NOW, reason: 'TP', multiple: 2, tokenAmountRaw: '1', quoteLamports: 0.25e9, txSignature: null }] }),
];

const unreal = { r13: 0.72e9, r14: 0.20e9 }; // live value of the two open bags
const st = scorecardStats(rows, { unrealizedByRow: unreal });
console.log('────────── PROFITABLE ACCOUNT (SOL ≈ $180) ──────────\n');
console.log(pnlScorecardText(st, 180));
console.log('\nstats:', JSON.stringify({ closed: st.closed, wins: st.wins, winRate: +st.winRate.toFixed(2), realized: st.realizedLamports, returnPct: +st.returnPct.toFixed(3), best: st.best, worst: st.worst, streak: st.streak, openPriced: st.openPriced, unrealized: st.unrealizedLamports, last7: st.last7 }, null, 1));

console.log('\n\n────────── EMPTY ACCOUNT ──────────\n');
console.log(pnlScorecardText(scorecardStats([]), 180));

console.log('\n\n────────── LOSING ACCOUNT (all red) ──────────\n');
const red = rows.slice(0, 6).map((r) => ({ ...r, pnlLamports: -r.spentLamports * 0.4, netMultiple: 0.6, status: 'closed' }));
console.log(pnlScorecardText(scorecardStats(red, {}), 180));
