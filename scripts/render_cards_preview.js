'use strict';
/** HTML preview: live POSITION card + after-trade card (offline, no network). */
const fs = require('fs');
const path = require('path');
const { positionMath } = require('../dist/types');
const { positionScorecardText, scorecardText } = require('../dist/format');

const SOL = 1e9;
const now = Date.now();
const USD = 180;

function row(o = {}) {
  return {
    id: 'p1', userId: 1, mint: 'J2EpCXn3Pt5UsyQ1DnJyCervJtYhskmcptU9ZNa9pump',
    symbol: o.symbol || 'PACT', name: o.name || 'We Made a Pact',
    status: o.status || 'open',
    entryTime: now - (o.agoMs || 2 * 3600_000),
    exitTime: o.status === 'closed' ? now - (o.agoMs || 2 * 3600_000) + (o.holdMs || 3600_000) : null,
    spentLamports: o.spent ?? 0.05 * SOL,
    realizedQuoteLamports: o.status === 'closed' ? (o.sold ?? 0.106 * SOL) : null,
    pnlLamports: o.status === 'closed' ? (o.sold ?? 0.106 * SOL) - (o.spent ?? 0.05 * SOL) : null,
    netMultiple: o.status === 'closed' ? (o.sold ?? 0.106 * SOL) / (o.spent ?? 0.05 * SOL) : null,
    pnlPct: o.status === 'closed' ? ((o.sold ?? 0.106 * SOL) - (o.spent ?? 0.05 * SOL)) / (o.spent ?? 0.05 * SOL) : null,
    holdMs: o.status === 'closed' ? (o.holdMs || 3600_000) : null,
    entryTokenAmount: '15800000000000',
    entryPriceLamports: 3.2e-6 * SOL,
    entryMcapLamports: 28.4e3 / USD * SOL,
    exitPriceLamports: o.status === 'closed' ? 6.8e-6 * SOL : null,
    exitReason: o.status === 'closed' ? 'TP' : null,
    peakMultiple: o.peak ?? 2.1,
    partialSells: o.partials || [],
    watchedLabel: o.ape || 'ape #1',
    walletBalanceBefore: 1.2 * SOL, walletBalanceAfter: o.status === 'closed' ? 1.256 * SOL : null,
    settingsAtEntry: {
      tpMultiples: [2, 3], stopLossPct: 0.5, copySell: true, copySellMode: 'mirror',
      slippagePct: 0.25, maxFeeLamports: 1e6, trailing: { enabled: false },
      breakEvenStop: true, maxHoldMs: null, exit: { mode: 'follow', pct: 1 },
    },
  };
}
const view = (r, live, price, mcap) => ({
  live, math: positionMath(r, live),
  pricePerToken: price, mcapLamports: mcap, entryPricePerToken: 3.2e-6 * SOL,
});

const running = row();
const moonbag = row({ partials: [{ time: now, reason: 'TP', multiple: 2, tokenAmountRaw: '9480000000000', quoteLamports: 0.06 * SOL, txSignature: null }] });
const down = row({ agoMs: 25 * 60_000, peak: 1.1 });
const closed = row({ status: 'closed', sold: 0.106 * SOL, holdMs: 47 * 60_000, agoMs: 3 * 3600_000 });

const cards = [
  ['Running position — in profit', positionScorecardText(running, view(running, 0.081 * SOL, 5.1e-6 * SOL, 45.9e3 / USD * SOL), USD)],
  ['Moonbag — 60% banked, 40% still open', positionScorecardText(moonbag, view(moonbag, 0.02 * SOL, 3.2e-6 * SOL, 28.4e3 / USD * SOL), USD)],
  ['Early drawdown', positionScorecardText(down, view(down, 0.04 * SOL, 2.5e-6 * SOL, 22e3 / USD * SOL), USD)],
  ['Price feed unavailable', positionScorecardText(row(), view(row(), null, null, null), USD)],
  ['After the trade closes', scorecardText(closed, 3, 0.056 * SOL, USD)],
];

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function rich(t) {
  return esc(t)
    .replace(/&lt;b&gt;(.*?)&lt;\/b&gt;/g, '<b>$1</b>')
    .replace(/\+[\d.]+ SOL/g, (m) => `<span class="up">${m}</span>`)
    .replace(/\+\$[\d,.]+/g, (m) => `<span class="up">${m}</span>`)
    .replace(/-[\d.]+ SOL/g, (m) => `<span class="down">${m}</span>`)
    .replace(/-\$[\d,.]+/g, (m) => `<span class="down">${m}</span>`)
    .replace(/(┃ (now mcap|entry mcap)\s+\$[\d.,KM B]+ \(\+[\d]+%\))/g, '<span class="up">$1</span>');
}
const card = (title, body) => `<div class="card"><div class="cap">${title}</div><pre>${rich(body)}</pre></div>`;

const html = `<!doctype html><meta charset="utf-8"><title>KACHIBOT — position cards</title>
<style>
 body{background:#0b0e13;color:#e6edf3;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;padding:28px 20px 44px}
 h1{font-size:17px;margin:0 0 4px;letter-spacing:.4px}
 p.sub{color:#8b949e;font-size:13px;margin:0 0 8px;max-width:780px}
 p.ref{color:#6e7681;font-size:12px;margin:0 0 22px}
 .wrap{max-width:1100px;margin:0 auto;display:flex;gap:20px;flex-wrap:wrap;align-items:flex-start}
 .card{flex:1 1 330px;background:#11161d;border:1px solid #232c38;border-radius:14px;padding:14px 16px;box-shadow:0 8px 24px rgba(0,0,0,.35)}
 .cap{color:#8b949e;font-size:11px;text-transform:uppercase;letter-spacing:1.2px;margin-bottom:10px}
 pre{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;line-height:1.55;margin:0;white-space:pre-wrap;word-break:break-word}
 b{color:#fff;font-weight:700}
 .up{color:#3fb950} .down{color:#f85149}
 .note{color:#6e7681;font-size:12px;margin-top:20px;text-align:center}
 .btns{color:#8b949e;font-size:12px;margin-top:8px}
</style>
<h1>KACHIBOT — live POSITION card</h1>
<p class="sub">Tapping a running position in 📡 Positions opens this: value, PnL, entry vs current market cap, when it was opened and who you copied.</p>
<p class="ref">Reference taken as inspiration only (BonkBot-style: position / profit / spent / entry MC / current MC) — rebuilt in KACHIBOT's voice with copy-trading detail.</p>
<div class="wrap">${cards.map(([t, b]) => card(t, b)).join('')}</div>
<p class="btns">Buttons under the live card: 💸 Sell 25% · 💸 Sell 50% · 💸 Sell all · 🔄 Refresh · 📡 Positions</p>
<p class="note">Only closed trades count as realized profit. Open positions are priced live when you open the card.</p>
`;

const out = path.join(__dirname, '..', 'position-cards-preview.html');
fs.writeFileSync(out, html);
console.log('written', out, html.length, 'bytes');
