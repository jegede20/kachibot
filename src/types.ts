/**
 * KACHIBOT — shared domain types, defaults & validation.
 */
import { DEFAULT_SETTINGS } from './config';

export type BuyMode = 'fixed' | 'pct';
export type ExitReason = 'TP' | 'SL' | 'COPY_SELL' | 'MANUAL' | 'PANIC' | 'RUG' | 'TRAIL' | 'TIME' | 'ERROR';
export type TradeStatus = 'open' | 'closed' | 'failed';

export interface AlertsConfig { snipes: boolean; sells: boolean; activity: boolean; }

/* --------------------------- exit strategies ---------------------------- */
/**
 * How KACHIBOT exits a copied position.
 *  follow — sell 100% the moment the watched wallet sells (classic copy-sell)
 *  pct    — sell a chosen % of the position when the watched wallet sells
 *  hold   — never follow the ape's sells (TP ladder + stop-loss still guard)
 *  mult   — ignore the ape's sells, exit the whole bag at a chosen multiple
 *  mcap   — ignore the ape's sells, exit the whole bag at a target market cap
 */
export type ExitMode = 'follow' | 'pct' | 'hold' | 'mult' | 'mcap';

export interface ExitConfig {
  mode: ExitMode;
  /** 'pct': fraction (0.01..1) of the remaining position sold when the ape sells */
  pct: number;
  /** 'mult': target multiple — 3 means sell everything at 3x */
  mult: number | null;
  /** 'mcap': target market cap in USD */
  mcapUsd: number | null;
}

export const EXIT_DEFAULT: ExitConfig = { mode: 'follow', pct: 1, mult: null, mcapUsd: null };

const EXIT_MODES: ExitMode[] = ['follow', 'pct', 'hold', 'mult', 'mcap'];

export function isExitMode(x: unknown): x is ExitMode {
  return typeof x === 'string' && (EXIT_MODES as string[]).includes(x);
}

/** coerce anything (missing / legacy / corrupted doc) into a valid ExitConfig */
export function normalizeExit(cfg: unknown): ExitConfig {
  if (!cfg || typeof cfg !== 'object') return { ...EXIT_DEFAULT };
  const c = cfg as Partial<ExitConfig>;
  if (!isExitMode(c.mode)) return { ...EXIT_DEFAULT };
  const pctRaw = Number(c.pct);
  const pct = Number.isFinite(pctRaw) ? Math.min(1, Math.max(0.01, pctRaw)) : 1;
  const multRaw = c.mult === null || c.mult === undefined ? null : Number(c.mult);
  const mcapRaw = c.mcapUsd === null || c.mcapUsd === undefined ? null : Number(c.mcapUsd);
  return {
    mode: c.mode,
    pct,
    mult: multRaw !== null && Number.isFinite(multRaw) && multRaw > 0 ? multRaw : null,
    mcapUsd: mcapRaw !== null && Number.isFinite(mcapRaw) && mcapRaw > 0 ? mcapRaw : null,
  };
}

/** per-watch override wins, otherwise the user's global default */
export function resolveExit(doc: { settings: UserSettings }, watch?: { exit?: ExitConfig | null } | null): ExitConfig {
  if (watch && watch.exit) return normalizeExit(watch.exit);
  return normalizeExit(doc.settings.exit);
}

/** fraction of the REMAINING position to sell when the watched wallet sells */
export function exitSellFraction(cfg: ExitConfig): number {
  if (cfg.mode === 'follow') return 1;
  if (cfg.mode === 'pct') return Math.min(1, Math.max(0.01, cfg.pct));
  return 0; // hold / mult / mcap: the ape's sell is not an exit signal
}

export function formatMcapUsd(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v) || v <= 0) return '—';
  const trim = (x: number, d: number): string => x.toFixed(d).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
  if (v >= 1e9) return `$${trim(v / 1e9, 2)}b`;
  if (v >= 1e6) return `$${trim(v / 1e6, 2)}m`;
  if (v >= 1e3) return `$${trim(v / 1e3, 1)}k`;
  return `$${Math.round(v)}`;
}

/** one-line human description used on cards and menus */
export function describeExit(cfg: ExitConfig): string {
  switch (cfg.mode) {
    case 'follow': return 'follow ape — sell all';
    case 'pct': return `sell ${Math.round(cfg.pct * 100)}% when ape sells`;
    case 'hold': return 'hold — ignore ape sells';
    case 'mult': return `sell all at ${cfg.mult ? `${cfg.mult}x` : '—'}`;
    case 'mcap': return `sell all at ${formatMcapUsd(cfg.mcapUsd)} mcap`;
    default: return 'follow ape — sell all';
  }
}

/** parse the value the user types for a given exit mode */
export function parseExitInput(
  mode: ExitMode,
  raw: string,
): { ok: true; cfg: ExitConfig } | { ok: false; error: string } {
  const v = raw.trim().toLowerCase().replace(/\s+/g, '');
  if (mode === 'follow' || mode === 'hold') return { ok: true, cfg: { ...EXIT_DEFAULT, mode } };
  if (mode === 'pct') {
    const n = Number(v.replace(/%$/, ''));
    if (!Number.isFinite(n) || n < 1 || n > 100) return { ok: false, error: 'enter a percentage between 1 and 100 (e.g. 50)' };
    return { ok: true, cfg: { mode: 'pct', pct: Math.min(1, n / 100), mult: null, mcapUsd: null } };
  }
  if (mode === 'mult') {
    const n = Number(v.replace(/x$/, ''));
    if (!Number.isFinite(n) || n < 1.01 || n > 1000) return { ok: false, error: 'enter a multiple ≥1.01 (e.g. 3x)' };
    return { ok: true, cfg: { mode: 'mult', pct: 1, mult: n, mcapUsd: null } };
  }
  // mcap: 100k / 1.5m / 2b / 69000 / $69,000
  const m = v.replace(/[$,\s]/g, '').match(/^([0-9]*\.?[0-9]+)([kmb])?$/);
  if (!m) return { ok: false, error: 'enter a market cap like 100k, 1.5m or 69000' };
  const base = Number(m[1]);
  const scale = m[2] === 'b' ? 1e9 : m[2] === 'm' ? 1e6 : m[2] === 'k' ? 1e3 : 1;
  const usd = base * scale;
  if (!Number.isFinite(usd) || usd <= 0) return { ok: false, error: 'enter a market cap like 100k, 1.5m or 69000' };
  return { ok: true, cfg: { mode: 'mcap', pct: 1, mult: null, mcapUsd: usd } };
}

/* ------------------------- risk / exit automation ------------------------ */

export interface TrailingStopConfig {
  enabled: boolean;
  /** only start trailing once the position has reached this multiple */
  armAtMult: number;
  /** give back this fraction from the peak before selling (0.25 = -25% off peak) */
  trailPct: number;
}

/** per-watch buy-size override (otherwise the global size is used) */
/**
 * Ape reputation filter — judges a watched wallet by the track record of the
 * copies it produced, so a wallet that keeps handing you losses can be
 * skipped (or halved) automatically. Costs no entry latency.
 */
export interface ReputationConfig {
  enabled: boolean;
  /** do not judge a wallet until it has this many closed copies */
  minTrades: number;
  /** win rate floor (0..1) — below this the wallet is judged weak */
  minWinRate: number;
  /** 'skip' = do not copy at all · 'halve' = copy at half size */
  onFail: 'skip' | 'halve';
}

/** fill in a reputation config for docs created before this feature existed */
export function normalizeReputation(cfg: unknown): ReputationConfig {
  const c = (cfg || {}) as Partial<ReputationConfig>;
  const min = Number(c.minTrades);
  const win = Number(c.minWinRate);
  return {
    enabled: !!c.enabled,
    minTrades: Number.isFinite(min) && min >= 1 ? Math.floor(min) : 10,
    minWinRate: Number.isFinite(win) ? Math.min(1, Math.max(0, win)) : 0.3,
    onFail: c.onFail === 'halve' ? 'halve' : 'skip',
  };
}

export function evaluateReputation(
  stats: { closed?: number; winRate?: number } | null | undefined,
  cfg: ReputationConfig,
): { judged: boolean; pass: boolean; winRate: number; closed: number } {
  const closed = Number(stats?.closed) || 0;
  const winRate = Number(stats?.winRate) || 0;
  const min = Math.max(1, Math.floor(Number(cfg?.minTrades) || 1));
  const floor = Math.min(1, Math.max(0, Number(cfg?.minWinRate) || 0));
  if (closed < min) return { judged: false, pass: true, winRate, closed };
  return { judged: true, pass: winRate >= floor, winRate, closed };
}

/** scorecard of one watched wallet (closed copies only) */
export function watchReputation(rows: TradeRow[], watchId: string | null | undefined): TradeHistorySummary {
  if (!watchId) return summarizeTrades([]);
  return summarizeTrades((rows || []).filter((r) => r.watchId === watchId));
}

/** human label for the per-wallet confirm-hold delay */
export function describeConfirmHold(ms: number | null | undefined): string {
  const v = Number(ms);
  if (!Number.isFinite(v) || v <= 0) return 'copy instantly';
  if (v < 60_000) return `wait ${Math.round(v / 1000)}s to confirm they hold`;
  if (v < 3_600_000) return `wait ${Math.round(v / 60_000)}m to confirm they hold`;
  return `wait ${(v / 3_600_000).toFixed(1)}h to confirm they hold`;
}

export interface BuySizeConfig {
  mode: BuyMode;
  /** fixed: lamports per snipe · pct: fraction (0..1) of the watched spend */
  value: number;
}

/**
 * Trailing-stop trigger for a position: the multiple at or below which the
 * position is sold. null = not armed (never railed high enough yet).
 */
export function trailingExitMultiple(peak: number, cfg: TrailingStopConfig): number | null {
  if (!cfg || !cfg.enabled) return null;
  const arm = Number(cfg.armAtMult);
  const give = Number(cfg.trailPct);
  if (!Number.isFinite(arm) || !Number.isFinite(give)) return null;
  if (!Number.isFinite(peak) || peak < arm) return null;
  return peak * (1 - Math.min(0.9, Math.max(0.01, give)));
}

/** break-even stop arms after the first take-profit rung has banked profit */
export function breakEvenArmed(partialSells: Array<{ reason?: string | null }> | null | undefined): boolean {
  return (partialSells || []).some((s) => s && s.reason === 'TP');
}

/**
 * Backfill settings that did not exist when an account was created, so new
 * features work for long-standing users without a database migration.
 * Only fills what is missing — it never overwrites a user's own choice.
 */
export function ensureSettings(s: UserSettings): UserSettings {
  if (!s) return s;
  if (!s.trailing) s.trailing = normalizeTrailing(null);
  if (typeof s.breakEvenStop !== 'boolean') s.breakEvenStop = DEFAULT_SETTINGS.breakEvenStop;
  if (s.maxHoldMs === undefined) s.maxHoldMs = DEFAULT_SETTINGS.maxHoldMs;
  if (typeof s.lowBalanceWarnLamports !== 'number') s.lowBalanceWarnLamports = DEFAULT_SETTINGS.lowBalanceWarnLamports;
  if (!s.exit) s.exit = { ...EXIT_DEFAULT };
  if (!s.reputation) s.reputation = { ...DEFAULT_SETTINGS.reputation };
  return s;
}

/** fill in a trailing config for docs created before this feature existed */
export function normalizeTrailing(cfg: unknown): TrailingStopConfig {
  const c = (cfg || {}) as Partial<TrailingStopConfig>;
  const arm = Number(c.armAtMult);
  const give = Number(c.trailPct);
  return {
    enabled: !!c.enabled,
    armAtMult: Number.isFinite(arm) && arm > 0 ? arm : 3,
    trailPct: Number.isFinite(give) && give > 0 ? Math.min(0.9, give) : 0.25,
  };
}

export function resolveBuySize(doc: { settings: UserSettings }, watch?: { buySize?: BuySizeConfig | null } | null): BuySizeConfig {
  const ov = watch && watch.buySize ? watch.buySize : null;
  if (ov && (ov.mode === 'fixed' || ov.mode === 'pct')) {
    const v = Number(ov.value);
    if (Number.isFinite(v) && v > 0) return { mode: ov.mode, value: ov.mode === 'pct' ? Math.min(2, v) : v };
  }
  const s = doc.settings;
  return s.buyMode === 'pct'
    ? { mode: 'pct', value: s.buyPctOfSpend }
    : { mode: 'fixed', value: s.buyAmountLamports };
}

export function describeBuySize(cfg: BuySizeConfig): string {
  if (!cfg || cfg.mode === 'pct') return `${Math.round((cfg?.value ?? 0) * 100)}% of ape's spend`;
  return `${(cfg.value / 1e9).toFixed(4)} SOL fixed`;
}

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
  /** global default exit rule; a watched wallet can override it */
  exit: ExitConfig;
  /** trailing stop: bank runners by trailing the peak once armed */
  trailing: TrailingStopConfig;
  /** after the first TP rung, move the stop to break-even on the rest */
  breakEvenStop: boolean;
  /** auto-exit a position after this long (ms); null = never */
  maxHoldMs: number | null;
  /** warn when the trading wallet drops below this balance (lamports); 0 = off */
  lowBalanceWarnLamports: number;
  /** skip/soften copies from watched wallets with a losing track record */
  reputation: ReputationConfig;
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
  /** per-wallet exit rule; null/absent = inherit the global default */
  exit?: ExitConfig | null;
  /** per-wallet buy size; null/absent = inherit the global size */
  buySize?: BuySizeConfig | null;
  /**
   * Per-wallet confirm-hold delay (ms): wait this long after the ape buys and
   * only copy if they are still holding. 0/null = copy instantly (default).
   * Skips apes who dump within seconds, at the cost of a later entry.
   */
  confirmHoldMs?: number | null;
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
  reason: ExitReason;
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
  /** highest multiple seen while open (drives the trailing stop) */
  peakMultiple: number | null;
  settingsAtEntry: {
    tpMultiples: number[];
    stopLossPct: number;
    copySell: boolean;
    slippagePct: number;
    maxFeeLamports: number;
    /** exit rule snapshot at entry (per-watch override resolved) */
    exit?: ExitConfig | null;
    /** trailing-stop snapshot at entry */
    trailing?: TrailingStopConfig | null;
    /** break-even stop snapshot at entry */
    breakEvenStop?: boolean;
    /** max hold time snapshot at entry (ms; null = never) */
    maxHoldMs?: number | null;
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
      // accepts "2,3", "2x, 3x", "1.5x 2x 10x"
      const parts = v.split(/[\s,]+/).map((p) => Number(p.replace(/x$/i, '')));
      if (!parts.length || parts.some((p) => !Number.isFinite(p) || p < 1.01 || p > 1000)) {
        return { ok: false, error: 'multiples ≥1.01 separated by commas — e.g. 2x, 3x, 5x (max 5 rungs)' };
      }
      s.tpMultiples = [...new Set(parts)].sort((a, b) => a - b).slice(0, 5);
      return { ok: true, applied: `TP ladder: ${s.tpMultiples.map((m) => `${m}x`).join(', ')}` };
    }
    case 'trail_arm': {
      const t = normalizeTrailing(s.trailing);
      const raw = Number(v.replace(/x$/i, ''));
      if (!Number.isFinite(raw) || raw < 1.05 || raw > 1000) {
        return { ok: false, error: 'arm the trailing stop at a multiple ≥1.05 (e.g. 3x)' };
      }
      s.trailing = { ...t, armAtMult: raw, enabled: true };
      return { ok: true, applied: `trailing arms at ${raw}x (ON)` };
    }
    case 'trail_pct': {
      const t = normalizeTrailing(s.trailing);
      const raw = Number(v.replace(/%$/, '')) / 100;
      if (!Number.isFinite(raw) || raw < 0.01 || raw > 0.9) {
        return { ok: false, error: 'give-back must be between 1% and 90% (e.g. 25)' };
      }
      s.trailing = { ...t, trailPct: raw };
      return { ok: true, applied: `trail back ${Math.round(raw * 100)}% from peak` };
    }
    case 'max_hold': {
      const e = setNum(0, 720, (x) => { s.maxHoldMs = x <= 0 ? null : Math.round(x * 3_600_000); });
      return e
        ? { ok: false, error: e }
        : { ok: true, applied: num <= 0 ? 'max hold off (hold until a rule exits)' : `max hold ${num}h` };
    }
    case 'low_bal': {
      const e = setNum(0, 100, (x) => { s.lowBalanceWarnLamports = Math.floor(x * 1e9); });
      return e
        ? { ok: false, error: e }
        : { ok: true, applied: num <= 0 ? 'low-balance alert off' : `warn below ${num} SOL` };
    }
    case 'rep_trades': {
      const r = normalizeReputation(s.reputation);
      const raw = Number(v);
      if (!Number.isInteger(raw) || raw < 1 || raw > 100) {
        return { ok: false, error: 'enter how many closed copies before judging, 1–100' };
      }
      s.reputation = { ...r, minTrades: raw };
      return { ok: true, applied: `judge apes after ${raw} copies` };
    }
    case 'rep_win': {
      const r = normalizeReputation(s.reputation);
      const raw = Number(v.replace(/%$/, '')) / 100;
      if (!Number.isFinite(raw) || raw < 0 || raw > 1) {
        return { ok: false, error: 'enter a win rate between 0 and 100 (e.g. 30)' };
      }
      s.reputation = { ...r, minWinRate: raw };
      return { ok: true, applied: `apes need ≥${Math.round(raw * 100)}% win rate` };
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
