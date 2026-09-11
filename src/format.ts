/**
 * KACHIBOT — branded copy & scorecard rendering.
 * Consistent voice for every message: scope badge, flat tone, no generic-bot
 * templating. All user-supplied strings are HTML-escaped.
 */
import { TradeRow, PnlStats, PositionMath } from './types';

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
export function scorecardText(t: TradeRow, seqNo: number, runningPnlLamports: number, solUsd: number | null = null): string {
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
  lines.push(`${T} pnl        ${sol4Signed(pnl)}  (${pctSigned(pnl / Math.max(1, t.spentLamports))})${usdShort(pnl, solUsd) ? ` · ${usdShort(pnl, solUsd)}` : ''}`);
  lines.push(`${T} multiple   ${x.toFixed(2)}x`);
  lines.push(`${T} exit       ${reason}`);
  lines.push(`${T} hold       ${t.holdMs !== null ? durMs(t.holdMs) : '—'}`);
  lines.push(`${T} bought     ${sol4(t.spentLamports)}`);
  lines.push(`${T} sold       ${sol4(Math.max(0, t.realizedQuoteLamports ?? t.spentLamports + (t.pnlLamports ?? 0)))}`);
  lines.push(`${T} ape→exit   ${new Date(t.entryTime).toISOString().slice(11, 19)} → ${t.exitTime ? new Date(t.exitTime).toISOString().slice(11, 19) : '—'} UTC`);
  lines.push(`${T} entry mcap ${mcapUsd(t.entryMcapLamports, solUsd) ?? mcapText(t.entryMcapLamports)}${t.partialSells.length ? ` · ${t.partialSells.length} sell${t.partialSells.length > 1 ? 's' : ''}` : ''}`);
  if (t.walletBalanceBefore !== null && t.walletBalanceAfter !== null) {
    lines.push(`${T} wallet     ${sol4(t.walletBalanceBefore)} → ${sol4(t.walletBalanceAfter)}`);
  }
  if (t.watchedLabel) lines.push(`${T} copied     ${esc(t.watchedLabel)}`);
  lines.push(T);
  lines.push(`${T} ${vibe} ${bull ? 'bull scored 🎯' : 'rug alert — stay frosty'}`);
  lines.push(`${T} ${D.repeat(46)}`);
  lines.push(`running PnL: ${sol4Signed(runningPnlLamports)}`);
  lines.push(chartLink(t.mint));
  return lines.join('\n');
}

/** compact USD: "$45.9K", "$1.23M" — for market caps */
export function usdCompact(usd: number): string {
  const a = Math.abs(usd);
  const sign = usd < 0 ? '-' : '';
  if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${sign}$${(a / 1e3).toFixed(1)}K`;
  return `${sign}$${a.toFixed(0)}`;
}

/** market cap in USD, or in SOL when no price feed is available */
export function mcapUsd(lamports: number | null | undefined, solUsd: number | null): string | null {
  if (!lamports || lamports <= 0 || !Number.isFinite(lamports)) return null;
  if (solUsd && solUsd > 0) return usdCompact((lamports / 1e9) * solUsd);
  return `${fmtNum(lamports / 1e9)} SOL`;
}

/** money-style SOL: "5.9360 SOL" — 4 dp, unit spelled out, never the scope glyph */
export function sol4(lamports: number): string {
  const v = Number.isFinite(lamports) ? lamports / 1e9 : 0;
  return `${v.toFixed(4)} SOL`;
}

/** signed money-style SOL: "+5.9360 SOL" / "-0.1800 SOL" */
export function sol4Signed(lamports: number): string {
  return `${lamports >= 0 ? '+' : '-'}${sol4(Math.abs(lamports))}`;
}

/** USD text for a SOL amount; pass the live SOL price (or null to hide USD) */
export function usdShort(lamports: number, solUsd: number | null | undefined): string | null {
  if (!solUsd || !Number.isFinite(solUsd) || solUsd <= 0) return null;
  const v = (lamports / 1e9) * solUsd;
  const sign = v >= 0 ? '+' : '-';
  const a = Math.abs(v);
  const txt = (a >= 1000 ? a.toFixed(0) : a.toFixed(2)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}$${txt}`;
}

/**
 * The PnL scorecard: one account-wide card — headline profit, how it was made,
 * which apes earned it, and what is still open.
 */
export function pnlScorecardText(st: PnlStats, solUsd: number | null = null): string {
  const L: string[] = [];
  const rule = D.repeat(26);
  const two = (label: string, value: string) => `${T} ${label.padEnd(10)}${value}`;
  const signed = (lamports: number) => sol4Signed(lamports);
  const usd = (lamports: number) => usdShort(lamports, solUsd);

  if (!st.closed && !st.openCount) {
    L.push(header('🏆', 'PnL SCORECARD'));
    L.push(rule);
    L.push(`${T} no closed copies yet — the card fills itself`);
    L.push(`${T} the moment your first ape exits.`);
    if (st.failed) {
      L.push(rule);
      L.push(`${T} ${st.failed} snipe${st.failed === 1 ? '' : 's'} didn't fill — no SOL spent,`);
      L.push(`${T} nothing lost. Failed attempts never open a position.`);
    }
    L.push(rule);
    L.push(`${T} tip: 👀 Watchlist → add a wallet you trust.`);
    return L.join('\n');
  }

  const total = st.realizedLamports;
  const up = total >= 0;

  L.push(header('🏆', 'PnL SCORECARD'));
  L.push(rule);
  // headline: profit, then USD + return on what was copied
  L.push(`${up ? '🟢' : '🔴'} <b>${signed(total)}</b>${usd(total) ? `  <b>${usd(total)}</b>` : ''}`);
  if (st.closed) {
    L.push(`${T} ${pctSigned(st.returnPct)} on ${sol4(st.boughtLamports)} copied across ${st.closed} trade${st.closed === 1 ? '' : 's'}`);
  }
  L.push(rule);

  if (st.closed) {
    L.push(two('wins', `${st.wins}/${st.closed} (${Math.round(st.winRate * 100)}%)`));
    if (st.wins) L.push(two('avg win', `${signed(st.avgWinLamports)} · ${st.avgWinMultiple.toFixed(2)}x`));
    if (st.losses) L.push(two('avg loss', `${signed(st.avgLossLamports)}`));
    if (st.best) L.push(two('best', `$${esc(st.best.symbol)} ${signed(st.best.pnlLamports)} (${st.best.multiple.toFixed(2)}x)`));
    if (st.worst) L.push(two('worst', `$${esc(st.worst.symbol)} ${signed(st.worst.pnlLamports)} (${st.worst.multiple.toFixed(2)}x)`));
    if (st.streak.count > 1) {
      L.push(two('streak', st.streak.kind === 'W' ? `🔥 ${st.streak.count} wins in a row` : `🧊 ${st.streak.count} losses in a row`));
    }
    if (st.avgHoldMs !== null) L.push(two('avg hold', durMs(st.avgHoldMs)));
    L.push(rule);
    L.push(two('bought', sol4(st.boughtLamports)));
    L.push(two('sold', sol4(st.soldLamports)));
  }

  if (st.byApe.length) {
    L.push(rule);
    L.push(`${T} <b>who earned it</b>`);
    for (const a of st.byApe.slice(0, 3)) {
      const wr = a.closed ? ` · ${Math.round((a.wins / a.closed) * 100)}% win` : '';
      L.push(`${T} ${a.pnlLamports >= 0 ? '🟢' : '🔴'} ${esc(a.label)} <b>${signed(a.pnlLamports)}</b>${wr} (${a.closed})`);
    }
  }

  if (st.openCount) {
    L.push(rule);
    const unreal = st.unrealizedLamports;
    L.push(two('open', `${st.openCount} position${st.openCount === 1 ? '' : 's'} · ${sol4(st.openCostLamports)} in`));
    if (unreal !== null) L.push(two('live pnl', `${unreal >= 0 ? '🟢' : '🔴'} <b>${signed(unreal)}</b>${usd(unreal) ? ` ${usd(unreal)}` : ''}`));
  }

  L.push(rule);
  L.push(`${T} last 7d: ${st.last7.closed} closed · ${signed(st.last7.realizedLamports)}`);
  return L.join('\n');
}

export interface PositionCardView {
  live: number | null;
  math: PositionMath;
  pricePerToken: number | null;
  mcapLamports: number | null;
  entryPricePerToken: number | null;
}

/**
 * The live POSITION card — a running trade, exchange style: what it is worth
 * now, what it cost, entry vs current market cap, and how long it has run.
 */
export function positionScorecardText(
  t: TradeRow,
  v: PositionCardView,
  solUsd: number | null = null,
): string {
  const L: string[] = [];
  const rule = D.repeat(26);
  const two = (label: string, value: string) => `${T} ${label.padEnd(11)}${value}`;
  const m = v.math;
  const up = m.pnl >= 0;
  const priced = v.live !== null;

  L.push(header('📡', 'POSITION'));
  L.push(`${T} ${esc(t.name)} <b>$${esc(t.symbol)}</b>`);
  L.push(rule);

  // headline: profit on the whole position (banked + still held)
  if (priced) {
    L.push(`${up ? '🟢' : '🔴'} <b>${sol4Signed(m.pnl)}</b>${usdShort(m.pnl, solUsd) ? `  <b>${usdShort(m.pnl, solUsd)}</b>` : ''}`);
    L.push(`${T} <b>${m.multiple.toFixed(2)}x</b> · ${pctSigned(m.pnlPct)} on ${sol4(t.spentLamports)} · ${ago(t.entryTime)}`);
  } else {
    L.push(`${T} market price unavailable right now`);
    L.push(`${T} ${sol4(t.spentLamports)} in · ${ago(t.entryTime)}`);
  }
  L.push(rule);

  // position / cost block (the two-column BonkBot idea, stacked for Telegram)
  if (priced) L.push(two('position', sol4(m.positionValue)));
  L.push(two('spent', sol4(t.spentLamports)));
  if (m.realizedFromPartials > 0) L.push(two('banked', sol4(m.realizedFromPartials)));

  // market data: entry vs now
  const nowMcap = mcapUsd(v.mcapLamports, solUsd);
  const entryMcap = mcapUsd(t.entryMcapLamports, solUsd);
  if (entryMcap) L.push(two('entry mcap', entryMcap));
  if (nowMcap) L.push(two('now mcap', `${nowMcap}${entryMcap ? ` (${mcapDelta(v.mcapLamports, t.entryMcapLamports)})` : ''}`));
  if (v.entryPricePerToken !== null && v.entryPricePerToken > 0) {
    L.push(two('avg entry', priceText(v.entryPricePerToken)));
  }
  if (v.pricePerToken !== null && v.pricePerToken > 0) {
    L.push(two('now', priceText(v.pricePerToken)));
  }

  L.push(rule);
  const bagLeft = Math.max(0, Math.round((1 - m.soldFraction) * 100));
  L.push(two('bag', `${bagLeft}% still open${m.soldFraction > 0 ? ` · ${Math.round(m.soldFraction * 100)}% banked` : ''}`));
  if (t.peakMultiple !== null && t.peakMultiple !== undefined && t.peakMultiple > 0) {
    L.push(two('peak', `${t.peakMultiple.toFixed(2)}x`));
  }
  L.push(two('opened', `${new Date(t.entryTime).toISOString().slice(11, 16)} UTC · ${durMs(Date.now() - t.entryTime)} ago`));
  if (t.watchedLabel) L.push(two('copied', esc(t.watchedLabel)));

  const st = t.settingsAtEntry;
  const guards: string[] = [`TP ${st.tpMultiples.join('/')}x`, `SL -${Math.round(st.stopLossPct * 100)}%`];
  if (st.trailing?.enabled) guards.push('trailing');
  if (st.breakEvenStop) guards.push('break-even');
  L.push(two('guards', guards.join(' · ')));
  L.push(rule);
  L.push(chartLink(t.mint));
  return L.join('\n');
}

/** price per token, readable at any scale */
function priceText(pricePerTokenLamports: number): string {
  const solPerToken = pricePerTokenLamports / 1e9;
  if (solPerToken <= 0) return '—';
  if (solPerToken >= 0.001) return `${solPerToken.toFixed(6)} SOL`;
  return `${solPerToken.toExponential(2)} SOL`;
}

/** "+62%" style move between two market caps */
function mcapDelta(nowLamports: number | null, entryLamports: number | null): string {
  if (!nowLamports || !entryLamports || entryLamports <= 0) return '';
  const pct = (nowLamports / entryLamports - 1) * 100;
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(0)}%`;
}

export function exitReasonLabel(r: string | null | undefined): string {
  switch (r) {
    case 'TP': return '🎯 take-profit ladder';
    case 'SL': return '🛑 stop-loss';
    case 'COPY_SELL': return '👻 copy-sell (watched dumped)';
    case 'MANUAL': return '✋ manual sell';
    case 'PANIC': return '🚨 panic sell-all';
    case 'RUG': return '🧨 rug detected';
    case 'TRAIL': return '🎏 trailing stop';
    case 'TIME': return '⏳ max hold time';
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
  lines.push(`${T} exits     TP ${tpText} · SL ${(sl * 100).toFixed(0)}%${t.settingsAtEntry.copySell ? ` · copy-sell ${t.settingsAtEntry.copySellMode === 'all' ? 'all' : 'mirror'}` : ''}`);
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
