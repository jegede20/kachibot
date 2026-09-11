/**
 * Data → card model. Pure functions, no network: everything here can be unit
 * tested, and the geometry/palette live in ./scorecard.ts.
 *
 * Two fillings of the same template:
 *   tradeScorecardModel   — one closed copy (history → 🏆 card #n)
 *   overallScorecardModel — the account-wide PnL card (🏆 PnL)
 */
import type { PnlStats, TradeRow } from '../types';
import { mcapUsd } from '../format';
import type { ScorecardModel, ScorecardRow } from './scorecard';

const DASH = '—';

/** plain-text exit reasons — the card faces have no emoji glyphs */
export function cardReasonLabel(r: string | null | undefined): string {
  switch (r) {
    case 'TP': return 'Take profit';
    case 'SL': return 'Stop loss';
    case 'COPY_SELL': return 'Wallet sold';
    case 'MANUAL': return 'Manual sell';
    case 'PANIC': return 'Panic sell';
    case 'RUG': return 'Rug detected';
    case 'TRAIL': return 'Trailing stop';
    case 'TIME': return 'Max hold time';
    case 'ERROR': return 'Error close';
    case 'CANCELLED': return 'Cancelled';
    default: return DASH;
  }
}

/** "+417%" / "-92%" — whole percent when it is big, one decimal when it is not */
export function pctCardText(ratio: number): string {
  if (!Number.isFinite(ratio)) return '0%';
  const v = Math.abs(ratio) * 100;
  const sign = ratio >= 0 ? '+' : '-';
  if (v >= 10) return `${sign}${Math.round(v)}%`;
  if (v >= 1) return `${sign}${v.toFixed(1)}%`;
  return `${sign}${v.toFixed(2)}%`;
}

/** "5.2X" / "0.08X" */
export function multCardText(x: number): string {
  if (!Number.isFinite(x) || x <= 0) return `0.00X`;
  return `${x >= 1 ? x.toFixed(1) : x.toFixed(2)}X`;
}

/** "1.20 SOL" — two decimals, unit spelled out (never the scope glyph) */
export function solCardText(lamports: number | null | undefined): string {
  if (lamports === null || lamports === undefined || !Number.isFinite(lamports)) return DASH;
  return `${(lamports / 1e9).toFixed(2)} SOL`;
}

/** "12m" / "2h 14m" — the card's compact hold time */
export function durCard(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms <= 0) return DASH;
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

const ticker = (t: TradeRow): string => `$${(t.symbol || '???').toUpperCase()}`;

/* ------------------------------ per-trade card ---------------------------- */

export interface TradeCardInput {
  trade: TradeRow;
  /** market cap in SOL lamports at exit (null when unknown) */
  exitMcapLamports?: number | null;
  solUsd?: number | null;
  now?: number;
}

export function tradeScorecardModel(input: TradeCardInput): ScorecardModel {
  const t = input.trade;
  const now = input.now ?? Date.now();
  const solUsd = input.solUsd ?? null;
  const pnl = t.pnlLamports ?? 0;
  const spent = t.spentLamports ?? 0;
  const ratio = spent > 0 ? pnl / spent : 0;
  const multiple = t.netMultiple ?? (spent > 0 ? (spent + pnl) / spent : 0);
  const holdMs = t.holdMs ?? Math.max(0, (t.exitTime ?? now) - t.entryTime);
  const sym = (t.symbol || '???').toUpperCase();

  const rows: ScorecardRow[] = [
    { label: 'Entry MC', value: mcapUsd(t.entryMcapLamports, solUsd) ?? DASH },
    { label: 'Exit MC', value: mcapUsd(input.exitMcapLamports ?? null, solUsd) ?? DASH },
    { label: 'Duration', value: durCard(holdMs) },
    { label: 'Balance before', value: solCardText(t.walletBalanceBefore) },
    { label: 'Balance after', value: solCardText(t.walletBalanceAfter) },
    { label: 'Exit reason', value: cardReasonLabel(t.exitReason) },
  ];

  return {
    token: ticker(t),
    verdict: pnl >= 0 ? 'Bullish' : 'Bearish',
    qualifier: t.exitReason === 'RUG' ? 'Rug' : null,
    pct: pctCardText(ratio),
    multiple: multCardText(multiple),
    trend: pnl >= 0 ? 'up' : 'down',
    rows,
    footer: `${sym} : ${durCard(holdMs)} held`,
  };
}

/* ------------------------------ account PnL card -------------------------- */

export interface OverallCardInput {
  stats: PnlStats;
  solUsd?: number | null;
  /** average market cap at entry across priced closed trades (SOL lamports) */
  avgEntryMcapLamports?: number | null;
  /** average market cap at exit across priced closed trades (SOL lamports) */
  avgExitMcapLamports?: number | null;
  /** most common exit reason across closed trades */
  topReason?: string | null;
}

export function overallScorecardModel(input: OverallCardInput): ScorecardModel {
  const st = input.stats;
  const solUsd = input.solUsd ?? null;
  const realized = st.realizedLamports ?? 0;
  const unreal = st.unrealizedLamports ?? 0;
  const total = realized + unreal;
  const bought = st.boughtLamports ?? 0;
  const sold = st.soldLamports ?? 0;
  const multiple = bought > 0 ? sold / bought : 0;
  const hold = st.avgHoldMs;

  const rows: ScorecardRow[] = [
    { label: 'Entry MC', value: mcapUsd(input.avgEntryMcapLamports ?? null, solUsd) ?? DASH },
    { label: 'Exit MC', value: mcapUsd(input.avgExitMcapLamports ?? null, solUsd) ?? DASH },
    { label: 'Duration', value: durCard(hold) },
    { label: 'Balance before', value: solCardText(bought) },
    { label: 'Balance after', value: solCardText(sold) },
    { label: 'Exit reason', value: cardReasonLabel(input.topReason ?? null) },
  ];

  const n = st.closed ?? 0;
  const footer = n > 0
    ? `${n} trade${n === 1 ? '' : 's'} : ${durCard(hold)} avg hold`
    : `no closed copies yet`;

  return {
    token: 'OVERALL',
    verdict: total >= 0 ? 'Bullish' : 'Bearish',
    qualifier: null,
    pct: pctCardText(st.returnPct ?? 0),
    multiple: multCardText(multiple),
    trend: total >= 0 ? 'up' : 'down',
    rows,
    footer,
  };
}

/* ------------------------------- aggregates ------------------------------- */

/** mean market cap across closed rows that have one (SOL lamports) */
export function avgMcapLamports(rows: TradeRow[], pick: (t: TradeRow) => number | null | undefined): number | null {
  const vals = rows
    .map(pick)
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0);
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

/** the exit reason that shows up most often across closed rows */
export function topExitReason(rows: TradeRow[]): string | null {
  const counts = new Map<string, number>();
  for (const t of rows) {
    if (!t.exitReason) continue;
    counts.set(t.exitReason, (counts.get(t.exitReason) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestN = 0;
  for (const [k, v] of counts) {
    if (v > bestN) { best = k; bestN = v; }
  }
  return best;
}
