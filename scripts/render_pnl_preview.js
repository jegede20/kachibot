'use strict';
/** Renders an HTML preview of the 🏆 PnL scorecard (offline, no network). */
const fs = require('fs');
const path = require('path');
const { scorecardStats } = require('../dist/types');
const { pnlScorecardText } = require('../dist/format');

const NOW = Date.now();
const H = 3600_000;
const SOL = 1e9;
let n = 0;
function row(o) {
  n++;
  return {
    id: 'r' + n, userId: 1, mint: 'Mint' + n + 'pump',
    symbol: o.symbol, name: o.symbol + ' coin',
    status: o.status || 'closed',
    entryTime: NOW - (o.agoMs || 2 * H),
    exitTime: o.status === 'open' ? null : NOW - (o.agoMs || 2 * H) + (o.holdMs || 1800_000),
    spentLamports: o.spent,
    pnlLamports: o.spent * ((o.mult ?? 1) - 1),
    netMultiple: o.mult ?? 1,
    holdMs: o.holdMs || 1800_000,
    watchedLabel: o.ape || 'manual',
    partialSells: o.partials || [],
  };
}

const rows = [
  row({ symbol: 'PACT', spent: 0.5e9, mult: 7.1, ape: 'ape #1', holdMs: 4 * H, agoMs: 96 * H }),
  row({ symbol: 'MOON', spent: 0.4e9, mult: 3.2, ape: 'ape #1', holdMs: 2 * H, agoMs: 90 * H }),
  row({ symbol: 'DOGS', spent: 0.3e9, mult: 0.32, ape: 'ape #3', holdMs: 40 * 60_000, agoMs: 88 * H }),
  row({ symbol: 'WOJAK', spent: 0.25e9, mult: 2.1, ape: 'ape #3', holdMs: 6 * H, agoMs: 70 * H }),
  row({ symbol: 'FWOG', spent: 0.2e9, mult: 0.55, ape: 'ape #2', holdMs: 30 * 60_000, agoMs: 60 * H }),
  row({ symbol: 'GIGA', spent: 0.5e9, mult: 2.6, ape: 'ape #1', holdMs: 9 * H, agoMs: 50 * H }),
  row({ symbol: 'BONK', spent: 0.6e9, mult: 1.9, ape: 'ape #1', holdMs: 12 * H, agoMs: 30 * H }),
  row({ symbol: 'WIF', spent: 0.45e9, mult: 0.4, ape: 'ape #3', holdMs: 3 * H, agoMs: 20 * H }),
  row({ symbol: 'MEW', spent: 0.3e9, mult: 4.4, ape: 'ape #1', holdMs: 7 * H, agoMs: 12 * H }),
  row({ symbol: 'OPEN1', spent: 0.5e9, status: 'open', ape: 'ape #1', agoMs: 3 * H }),
  row({
    symbol: 'OPEN2', spent: 0.3e9, status: 'open', ape: 'ape #3', agoMs: 1 * H,
    partials: [{ time: NOW, reason: 'TP', multiple: 2, tokenAmountRaw: '1', quoteLamports: 0.25e9, txSignature: null }],
  }),
];
const unreal = { r10: 0.72e9, r11: 0.20e9 };
const profitable = pnlScorecardText(scorecardStats(rows, { unrealizedByRow: unreal }), 180);

const failedOnly = [{
  id: 'f1', userId: 1, status: 'failed', mint: 'J2EpCXn3pump', symbol: 'PACT', name: 'We Made a Pact',
  entryTime: NOW - H, exitTime: NOW - H, spentLamports: 0, pnlLamports: null, netMultiple: null,
  holdMs: null, watchedLabel: 'ape #1', partialSells: [],
}];
const today = pnlScorecardText(scorecardStats(failedOnly, {}), 98.92);

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function rich(t) {
  return esc(t)
    .replace(/&lt;b&gt;(.*?)&lt;\/b&gt;/g, '<b>$1</b>')
    .replace(/\+[\d.]+ SOL/g, (m) => `<span class="up">${m}</span>`)
    .replace(/\+\$[\d,.]+/g, (m) => `<span class="up">${m}</span>`)
    .replace(/-[\d.]+ SOL/g, (m) => `<span class="down">${m}</span>`)
    .replace(/-\$[\d,.]+/g, (m) => `<span class="down">${m}</span>`);
}
const card = (title, body) => `<div class="card"><div class="cap">${title}</div><pre>${rich(body)}</pre></div>`;

const html = `<!doctype html><meta charset="utf-8"><title>KACHIBOT PnL scorecard</title>
<style>
 body{background:#0b0e13;color:#e6edf3;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;padding:28px 20px 40px}
 h1{font-size:17px;margin:0 0 4px;letter-spacing:.4px}
 p.sub{color:#8b949e;font-size:13px;margin:0 0 22px}
 .wrap{max-width:780px;margin:0 auto;display:flex;gap:22px;flex-wrap:wrap;align-items:flex-start}
 .card{flex:1 1 340px;background:#11161d;border:1px solid #232c38;border-radius:14px;padding:14px 16px;box-shadow:0 8px 24px rgba(0,0,0,.35)}
 .cap{color:#8b949e;font-size:11px;text-transform:uppercase;letter-spacing:1.2px;margin-bottom:10px}
 pre{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;line-height:1.55;margin:0;white-space:pre-wrap;word-break:break-word}
 b{color:#fff;font-weight:700}
 .up{color:#3fb950} .down{color:#f85149}
 .note{color:#6e7681;font-size:12px;margin-top:18px;text-align:center}
</style>
<h1>KACHIBOT — 🏆 PnL scorecard</h1>
<p class="sub">What you get when you tap <b>🏆 PnL</b> in the bot (also reachable from 📖 History). Money is always spelled out as SOL.</p>
<div class="wrap">${card('Example — profitable account', profitable)}${card('What you see today — no closed trades yet', today)}</div>
<p class="note">Live values price open positions on request; only closed trades count as realized PnL.</p>
`;

const out = path.join(__dirname, '..', 'pnl-scorecard-preview.html');
fs.writeFileSync(out, html);
console.log('written', out, html.length, 'bytes');
