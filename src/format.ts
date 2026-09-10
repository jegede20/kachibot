/**
 * KACHIBOT — branded copy & scorecard rendering.
 * Consistent voice for every message: scope badge, flat tone, no generic-bot
 * templating. All user-supplied strings are HTML-escaped.
 */
import { TradeRow } from './types';

export const KACHI = 'KACHIBOT';
export const LOGO = '◉K'; // scope mark + monogram (flat, chunky)

export function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** "Name ($SYM)" — HTML-escaped; falls back to a short mint when unknown */
export function coinTag(name: string | null | undefined, symbol: string | null | undefined, mint?: string): string {
  const n = esc((name || '').trim());
  const sym = esc((symbol || '').trim());
  if (n && sym) return `<b>${n}</b> ($${sym})`;
  if (sym) return `<b>$${sym}</b>`;
  if (n) return `<b>${n}</b>`;
  return mint ? `<code>${esc(mint.slice(0, 6))}…</code>` : 'the token';
}

/** exact SOL text: "0.1234 SOL" — 4 dp minimum, trailing zeros trimmed */
export function solExact(lamports: number | null | undefined): string | null {
  if (lamports === null || lamports === undefined || !Number.isFinite(lamports)) return null;
  const s = lamports / 1e9;
  if (s === 0) return '0 SOL';
  let txt = s.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
  const dp = txt.includes('.') ? txt.split('.')[1].length : 0;
  if (dp < 4) txt = s.toFixed(4);
  return `${txt} SOL`;
}

export function sol(n: number): string {
  const s = n / 1e9;
  return fmtNum(s);
}

export function fmtNum(x: number): string {
  if (!Number.isFinite(x)) return '0';
  const abs = Math.abs(x);
  if (abs >= 1000000) return `${(x / 1000000).toFixed(1)}M`;
  if (abs >= 10000) return `${(x / 1000).toFixed(1)}k`;
  if (abs >= 100) return x.toFixed(1);
  if (abs >= 1) return x.toFixed(3);
  if (abs >= 0.001) return x.toFixed(4);
  if (abs === 0) return '0';
  return x.toPrecision(3);
}

export function solShort(lamports: number): string {
  return `◎${fmtNum(lamports / 1e9)}`;
}

export function mcapText(lamports: number | null): string {
  if (!lamports || lamports <= 0) return 'n/a';
  return `◎${fmtNum(lamports / 1e9)}`;
}

export function pctText(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

export function pctSigned(x: number): string {
  return `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`;
}

export function durMs(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function ago(ts: number): string {
  return `${durMs(Date.now() - ts)} ago`;
}

/* ----------------------------- scorecards ------------------------------ */

const D = '━';
const T = '┃';

function header(emoji: string, tag: string): string {
  return `${emoji} ${LOGO} · ${tag}`;
}

/** Card for a fully closed trade — the scorecard. */
export function scorecardText(t: TradeRow, seqNo: number, runningPnlLamports: number): string {
  const pnl = t.pnlLamports ?? 0;
  const x = t.netMultiple ?? 0;
  const bull = pnl >= 0;
  const vibe = bull ? '🟢 BULLISH' : '🔴 BEARISH / RUG ZONE';
  const reason = exitReasonLabel(t.exitReason);
  const lines: string[] = [];
  lines.push(header(bull ? '🏆' : '🩸', `TRADE CARD #${seqNo}`));
  lines.push(T);
  lines.push(`${bull ? '📗' : '📕'} ${esc(t.name)} <b>$${esc(t.symbol)}</b>`);
  lines.push(`${T} ${D.repeat(46)}`);
  lines.push(`${T} pnl        ${pnl >= 0 ? '+' : ''}${solShort(pnl)}  (${pctSigned(pnl / Math.max(1, t.spentLamports))})`);
  lines.push(`${T} multiple   ${x.toFixed(2)}x`);
  lines.push(`${T} exit       ${reason}`);
  lines.push(`${T} hold       ${t.holdMs !== null ? durMs(t.holdMs) : '—'}`);
  lines.push(`${T} ape→exit   ${new Date(t.entryTime).toISOString().slice(11, 19)} → ${t.exitTime ? new Date(t.exitTime).toISOString().slice(11, 19) : '—'} UTC`);
  lines.push(`${T} entry mcap ${mcapText(t.entryMcapLamports)}${t.partialSells.length ? ` · ${t.partialSells.length} sell${t.partialSells.length > 1 ? 's' : ''}` : ''}`);
  if (t.walletBalanceBefore !== null && t.walletBalanceAfter !== null) {
    lines.push(`${T} wallet     ${solShort(t.walletBalanceBefore)} → ${solShort(t.walletBalanceAfter)}`);
  }
  if (t.watchedLabel) lines.push(`${T} copied     ${esc(t.watchedLabel)}`);
  lines.push(T);
  lines.push(`${T} ${vibe} ${bull ? 'bull scored 🎯' : 'rug alert — stay frosty'}`);
  lines.push(`${T} ${D.repeat(46)}`);
  lines.push(`running PnL: ${runningPnlLamports >= 0 ? '+' : ''}${solShort(runningPnlLamports)}`);
  lines.push(chartLink(t.mint));
  return lines.join('\n');
}

export function exitReasonLabel(r: string | null | undefined): string {
  switch (r) {
    case 'TP': return '🎯 take-profit ladder';
    case 'SL': return '🛑 stop-loss';
    case 'COPY_SELL': return '👻 copy-sell (watched dumped)';
    case 'MANUAL': return '✋ manual sell';
    case 'PANIC': return '🚨 panic sell-all';
    case 'RUG': return '🧨 rug detected';
    case 'ERROR': return '⚠️ error close';
    case 'CANCELLED': return '🚫 cancelled';
    default: return '—';
  }
}

export function openPositionText(t: TradeRow, liveValueLamports: number | null, seqNo: number): string {
  const heldRaw = BigInt(t.entryTokenAmount) - BigInt(t.partialSells.reduce((a, s) => a + BigInt(s.tokenAmountRaw), 0n));
  const spent = t.spentLamports;
  const realized = t.partialSells.reduce((a, s) => a + s.quoteLamports, 0);
  const unreal = liveValueLamports !== null ? liveValueLamports - spent + realized : null;
  const totalPnl = unreal !== null ? unreal : null;
  const entryShort = `${t.name} $${esc(t.symbol)}`;
  const lines: string[] = [];
  lines.push(header('📡', `POSITION #${seqNo}`));
  lines.push(T);
  lines.push(entryShort);
  lines.push(`${T} aped      ${ago(t.entryTime)} · ${solShort(spent)}`);
  lines.push(`${T} held      ${fmtTokenAmount(heldRaw)} tokens`);
  if (totalPnl !== null) {
    const pnlPct = spent > 0 ? ((totalPnl) / spent) * 100 : 0;
    lines.push(`${T} pnl       ${totalPnl >= 0 ? '+' : ''}${solShort(totalPnl)} (${totalPnl >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%)`);
  } else {
    lines.push(`${T} pnl       … (fetching price)`);
  }
  const tpText = t.settingsAtEntry.tpMultiples.map((m) => `${m}x`).join(',');
  const sl = (1 - t.settingsAtEntry.stopLossPct);
  lines.push(`${T} exits     TP ${tpText} · SL ${(sl * 100).toFixed(0)}%${t.settingsAtEntry.copySell ? ' · copy-sell on' : ''}`);
  lines.push(`chart: pump.fun/coin/${t.mint}`);
  return lines.join('\n');
}

export function fmtTokenAmount(raw: bigint): string {
  if (raw >= 1_000_000_000_000n) return `${fmtNum(Number(raw) / 1e12)}B`;
  if (raw >= 1_000_000_000n) return `${fmtNum(Number(raw) / 1e9)}M`;
  if (raw >= 1_000_000n) return `${(Number(raw) / 1e6).toFixed(2)}M`;
  if (raw >= 1_000n) return `${(Number(raw) / 1e6).toFixed(1)}k`;
  return (Number(raw) / 1e6).toFixed(4);
}

export function chartLink(mint: string): string {
  return `https://pump.fun/coin/${mint}`;
}

export function snipeAlertText(name: string, symbol: string, spendSol: number, entryMcapLamports: number | null, mint: string): string {
  const lines: string[] = [];
  lines.push(header('🎯', 'SNIPE LOCKED'));
  lines.push(`${name} <b>$${esc(symbol)}</b>`);
  lines.push(`entry mcap ${mcapText(entryMcapLamports)} · spent ${solShort(spendSol)}`);
  lines.push(chartLink(mint));
  return lines.join('\n');
}

export function sellAlertText(name: string, symbol: string, realizedSol: number, reasonLabel: string, multiple: number | null): string {
  const lines: string[] = [];
  lines.push(header('💸', 'EXIT EXECUTED'));
  lines.push(`${name} <b>$${esc(symbol)}</b>`);
  lines.push(`${reasonLabel} · got ${solShort(realizedSol)}${multiple !== null ? ` at ${multiple.toFixed(2)}x` : ''}`);
  return lines.join('\n');
}

export function welcomeIntro(): string {
  const lines: string[] = [];
  lines.push(header('🎯', 'WELCOME TO THE BOOTH'));
  lines.push(T);
  lines.push('<b>KACHIBOT copies wallets.</b> Add one, and every buy it makes gets sniped into your wallet — TP/SL, rug checks and scorecards handled.');
  lines.push(T);
  lines.push('<b>GET STARTED:</b>');
  lines.push('1) 💼 <b>Wallet</b> — generate or import (this one buys)');
  lines.push('2) 💧 fund it with a little SOL');
  lines.push('3) ⚙️ <b>Settings</b> — buy size, slippage, TP/SL, caps');
  lines.push(T);
  lines.push('Then 👀 add a wallet to watch — the rest runs itself.');
  lines.push('Secrets AES-256 encrypted · no fees. /help anytime.');
  return lines.join('\n');
}

export function helpIntro(): string {
  const lines: string[] = [];
  lines.push(header('🛰️', 'COPY-SNIPER ONLINE'));
  lines.push(T);
  lines.push(`1) /start opens the cockpit`);
  lines.push(`2) /watch &lt;wallet or pump.fun coin/profile link&gt; — KACHIBOT tails every buy`);
  lines.push(`3) /settings tunes size, slippage, TP/SL, fee caps`);
  lines.push(`4) /wallet deposits your ammo (in-bot wallet)`);
  lines.push(`5) sit back — every ape prints a branded trade card`);
  lines.push(`6) /guide — full manual: wallets, send/receive, every setting, all commands`);
  lines.push(T);
  lines.push('All settings live in Telegram. No web app. No fees — ever.');
  return lines.join('\n');
}
