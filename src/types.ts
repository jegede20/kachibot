/**
 * KACHIBOT — shared domain types, defaults & validation.
 */
import { DEFAULT_SETTINGS } from './config';

export type BuyMode = 'fixed' | 'pct';
export type ExitReason = 'TP' | 'SL' | 'COPY_SELL' | 'MANUAL' | 'PANIC' | 'RUG' | 'ERROR';
export type TradeStatus = 'open' | 'closed' | 'failed';

export interface AlertsConfig { snipes: boolean; sells: boolean; activity: boolean; }

export interface UserSettings {
  buyMode: BuyMode;
  /** lamports of SOL per snipe in fixed mode */
  buyAmountLamports: number;
  /** 0..1 fraction of the watched spend to copy in pct mode */
  buyPctOfSpend: number;
  /** slippage fraction (0.25 = 25%) applied to max/min bounds */
  slippagePct: number;
  /** cap on priority fee / jito tip lamports per transaction */
  maxFeeLamports: number;
  /** take-profit multiples ladder e.g. [2,3] (1x+). */
  tpMultiples: number[];
  /** stop loss fraction of entry (0.5 = -50%) */
  stopLossPct: number;
  /** copy the watched wallet's sells too */
  copySell: boolean;
  /** ignore watched buys smaller than this (lamports) */
  minSpendLamports: number;
  /** ignore watched buys larger than this (lamports) */
  maxSpendLamports: number;
  /** hard stop: total auto-buys per day per user */
  dailyCapLamports: number;
  /** hard stop: per auto-buy */
  perTradeCapLamports: number;
  /** min ms between two auto-buys triggered by the same watched wallet */
  watcherCooldownMs: number;
  /** run simulation / anti-rug checks before committing funds */
  honeypotCheck: boolean;
  alerts: AlertsConfig;
}

export interface WatchedWallet {
  id: string;
  address: string;
  label: string;
  source: 'address' | 'pumpfun';
  addedAt: number;
  paused: boolean;
  /** when the user paused it (for "paused for X" on the card) */
  pausedAt?: number;
  /** last time this wallet's buy was seen on-chain (live watcher stamps it) */
  lastBuySeenAt?: number;
}

/** one stored Solana wallet inside a user's vault (multi-wallet supported) */
export interface WalletRecord {
  id: string;
  label: string;
  /** AES-encrypted base58 keypair secret (the signing key) */
  secret: string;
  /** AES-encrypted 12/24-word seed phrase — null when imported as a raw key */
  mnemonic: string | null;
  createdAt: number;
}

export interface UserDoc {
  userId: number;
  settings: UserSettings;
  watched: WatchedWallet[];
  /** encrypted wallet secret (base58 keypair) of the ACTIVE wallet — kept in
   * sync with wallets[] for compatibility with the trade engine */
  secret: string | null;
  /** vault of all wallets owned by this user */
  wallets: WalletRecord[];
  /** id of the active (trading) wallet */
  activeWalletId: string | null;
  /** salted sha256 of the export PIN (hex) — null = PIN not set */
  pinHash: string | null;
  createdAt: number;
  lastSeenAt: number;
  /** true once the /start welcome has been shown */
  welcomed: boolean;
  /** lamports auto-bought today (rolling UTC day) */
  daySpend: { day: string; lamports: number } | null;
}

/** one open/closed trade = one buy + its sell chain = one scorecard */
export interface PartialSell {
  time: number;
  reason: 'TP' | 'SL' | 'COPY_SELL' | 'MANUAL' | 'PANIC' | 'RUG' | 'ERROR';
  /** multiple of entry at which this chunk was sold (exit/entry) */
  multiple: number;
  tokenAmountRaw: string;
  quoteLamports: number;
  txSignature: string | null;
}

export interface TradeRow {
  id: string;
  userId: number;
  watchId: string | null;
  watchedAddress: string | null;
  watchedLabel: string | null;
  mint: string;
  symbol: string;
  name: string;
  tokenProgram: 'spl' | 'token2022';
  entryTime: number;
  exitTime: number | null;
  spentLamports: number;           // total SOL lamports out of the wallet (incl. fees)
  entryTokenAmount: string;        // raw token units received
  entryPriceLamports: number;      // SOL lamports per raw token at entry
  entryMcapLamports: number | null;
  walletBalanceBefore: number | null;
  settingsAtEntry: {
    tpMultiples: number[];
    stopLossPct: number;
    copySell: boolean;
    slippagePct: number;
    maxFeeLamports: number;
  };
  partialSells: PartialSell[];
  status: TradeStatus;
  exitReason: ExitReason | null;
  realizedQuoteLamports: number | null;  // total SOL received (all sells)
  exitPriceLamports: number | null;      // volume-weighted avg exit price
  walletBalanceAfter: number | null;
  pnlLamports: number | null;            // realized - spent
  pnlPct: number | null;                 // pnl / spent
  netMultiple: number | null;            // realized / spent (gross X)
  holdMs: number | null;
  error: string | null;
  txSignatures: string[];
}

export interface TradeHistorySummary {
  total: number;
  closed: number;
  open: number;
  realizedPnlLamports: number;
  winCount: number;
  winRate: number; // 0..1 of closed trades
  avgReturnPct: number;
}

export function summarizeTrades(rows: TradeRow[]): TradeHistorySummary {
  const closed = rows.filter((r) => r.status === 'closed');
  const wins = closed.filter((r) => (r.pnlLamports ?? 0) > 0);
  const realized = closed.reduce((a, r) => a + (r.pnlLamports ?? 0), 0);
  const avg =
    closed.length && closed.some((r) => r.pnlPct !== null)
      ? closed.reduce((a, r) => a + (r.pnlPct ?? 0), 0) / closed.filter((r) => r.pnlPct !== null).length
      : 0;
  return {
    total: rows.length,
    closed: closed.length,
    open: rows.filter((r) => r.status === 'open').length,
    realizedPnlLamports: realized,
    winCount: wins.length,
    winRate: closed.length ? wins.length / closed.length : 0,
    avgReturnPct: avg,
  };
}

/* ------------------------------- defaults ------------------------------ */

export function defaultSettings(): UserSettings {
  return JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as UserSettings;
}

export function freshUser(userId: number): UserDoc {
  return {
    userId,
    settings: defaultSettings(),
    watched: [],
    secret: null,
    wallets: [],
    activeWalletId: null,
    pinHash: null,
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
    welcomed: false,
    daySpend: null,
  };
}

export function dayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

/* ------------------------------ validation ----------------------------- */

export class ValidationError extends Error {}

export function validateAndApply(path: string, rawValue: string, s: UserSettings): { ok: true; applied: string } | { ok: false; error: string } {
  const v = rawValue.trim();
  const num = Number(v);
  const setNum = (min: number, max: number, target: (x: number) => void): string | null => {
    if (!Number.isFinite(num) || num < min || num > max) {
      return `value must be between ${min} and ${max}`;
    }
    target(num);
    return null;
  };
  const setInt = (min: number, max: number, target: (x: number) => void): string | null => {
    if (!Number.isInteger(num)) return 'value must be a whole number';
    return setNum(min, max, target);
  };

  switch (path) {
    case 'buy_amount_sol': {
      const e = setNum(0.0001, 100, (x) => { s.buyAmountLamports = Math.floor(x * 1e9); s.buyMode = 'fixed'; });
      return e ? { ok: false, error: e } : { ok: true, applied: `${num} SOL (fixed)` };
    }
    case 'buy_pct': {
      const e = setNum(0.01, 2, (x) => { s.buyPctOfSpend = x; s.buyMode = 'pct'; });
      return e ? { ok: false, error: e } : { ok: true, applied: `${Math.round(num * 100)}% of watched spend (pct)` };
    }
    case 'slippage': {
      const e = setNum(0.01, 1, (x) => { s.slippagePct = x; });
      return e ? { ok: false, error: e } : { ok: true, applied: `${Math.round(num * 100)}%` };
    }
    case 'fee_cap': {
      const e = setNum(0.00001, 0.2, (x) => { s.maxFeeLamports = Math.floor(x * 1e9); });
      return e ? { ok: false, error: e } : { ok: true, applied: `${num} SOL/tx` };
    }
    case 'tp_multiples': {
      const parts = v.split(/[\s,]+/).map(Number);
      if (!parts.length || parts.some((p) => !Number.isFinite(p) || p < 1.01 || p > 100)) {
        return { ok: false, error: 'list multiples ≥1.01 separated by commas, e.g. 2, 3' };
      }
      s.tpMultiples = [...new Set(parts)].sort((a, b) => a - b).slice(0, 5);
      return { ok: true, applied: `${s.tpMultiples.map((m) => `${m}x`).join(', ')}` };
    }
    case 'stop_loss': {
      const e = setNum(0.01, 0.99, (x) => { s.stopLossPct = x; });
      return e ? { ok: false, error: e } : { ok: true, applied: `${Math.round(num * 100)}%` };
    }
    case 'min_spend': {
      const e = setNum(0.00001, 100, (x) => { s.minSpendLamports = Math.floor(x * 1e9); });
      return e ? { ok: false, error: e } : { ok: true, applied: `${num} SOL` };
    }
    case 'max_spend': {
      const e = setNum(0.0001, 5000, (x) => { s.maxSpendLamports = Math.floor(x * 1e9); });
      return e ? { ok: false, error: e } : { ok: true, applied: `${num} SOL` };
    }
    case 'daily_cap': {
      const e = setNum(0.001, 100, (x) => { s.dailyCapLamports = Math.floor(x * 1e9); });
      return e ? { ok: false, error: e } : { ok: true, applied: `${num} SOL/day` };
    }
    case 'trade_cap': {
      const e = setNum(0.0001, 10, (x) => { s.perTradeCapLamports = Math.floor(x * 1e9); });
      return e ? { ok: false, error: e } : { ok: true, applied: `${num} SOL/trade` };
    }
    case 'cooldown': {
      const e = setInt(1, 600, (x) => { s.watcherCooldownMs = x * 1000; });
      return e ? { ok: false, error: e } : { ok: true, applied: `${num}s` };
    }
    default:
      return { ok: false, error: `unknown setting ${path}` };
  }
}

/* ------------------------------- helpers ------------------------------- */

export function lamportsToSol(n: number): string {
  return (n / 1e9).toFixed(Math.max(0, Math.min(9, 9 - Math.floor(Math.log10(Math.max(n, 1))))));
}

export function lamportsToSolRounded(n: number): string {
  const sol = n / 1e9;
  if (sol >= 1000) return `${sol.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  if (sol >= 1) return sol.toLocaleString('en-US', { maximumFractionDigits: 3 });
  if (sol >= 0.001) return sol.toLocaleString('en-US', { maximumFractionDigits: 4 });
  return sol.toLocaleString('en-US', { maximumFractionDigits: 6 });
}

export function lamportsToUsdLike(n: number, quoteIsSol: boolean): string {
  return quoteIsSol ? `◎${lamportsToSolRounded(n)}` : `$${lamportsToSolRounded(n)}`;
}

export function compactAddress(a: string): string {
  return a.length <= 12 ? a : `${a.slice(0, 4)}…${a.slice(-4)}`;
}

/** fraction 0..1 -> percent string with sign */
export function pctSigned(x: number): string {
  return `${x >= 0 ? '+' : ''}${(x * 100).toFixed(x >= 0 ? 2 : 2)}%`;
}

export function pct(x: number): string {
  return `${(x * 100).toFixed(2)}%`;
}
