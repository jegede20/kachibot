/**
 * KACHIBOT — trade execution core.
 * Turns watch signals / user commands into executed, tracked, scorecard-able
 * trades. Enforces every cap & check before funds move and never drops a
 * trade silently: failures end in a 'failed' trade row + notification.
 */
import { Keypair, PublicKey, VersionedTransaction, TransactionInstruction, Connection } from '@solana/web3.js';
import BN from 'bn.js';
import { getStore, Store } from './db';
import { UserDoc, TradeRow, ExitReason, dayKey, resolveExit, normalizeExit, exitSellFraction, describeExit, resolveBuySize, trailingExitMultiple, breakEvenArmed, normalizeTrailing, evaluateReputation, watchReputation, type TrailingStopConfig, type BuySizeConfig, type ReputationConfig, copySellFraction, positionMath, PositionMath, holdingDivergence, isRetryableSellError } from './types';
import {
  curvePhase, fetchCurve, loadPricingCtx, sellSolLamportsForTokenAmount,
  buildCurveBuy, buildCurveSell, mcapSolLamports, priceSolPerTokenLamports,
  isLiveCurve, getTokenProgramForMint, deriveAta, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, WRAPPED_SOL,
} from './chain/pump';
import { buildJupiterBuy, buildJupiterSell, quote, noRouteError } from './chain/jupiter';
import { getConnection } from './chain/conn';
import { getSolUsd } from './chain/price';
import { buildPumpSwapBuy, buildPumpSwapSell, findPumpSwapPool, poolMcapLamports } from './chain/pumpswap';
import { simulate, sendTrade, confirmSignature, toVersioned } from './chain/send';
import { getTokenMeta, rugFlags, describeRugFlags, mintSupplyRaw } from './chain/meta';
import { decryptSecret, keypairFromSecret } from './crypto';
import { notifyUser } from './notify';
import { chartLink, scorecardText, coinTag, solExact } from './format';

export interface WatchSignal {
  userId: number;
  watchId: string;
  watchedAddress: string;
  watchedLabel: string;
  side: 'buy' | 'sell';
  mint: string;
  /** full token name from chain metadata (may be null for brand-new mints) */
  mintName?: string | null;
  /** token ticker/symbol from chain metadata */
  mintSymbol?: string | null;
  spendLamports: number | null;
  /** exact SOL that left the watched wallet in this tx */
  spentSolLamports?: number | null;
  tokenAmountRaw: string | null;
  /** 0..1 share of the watched wallet's OWN bag this sell moved (null if unknown) */
  apeSoldFraction?: number | null;
  sig: string;
  route: string;
}

/** error that should NOT alarm the user (a clean dodge) */
export class DodgedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DodgedError';
  }
}

const keyCache = new Map<string, { at: number; kp: Keypair }>();

/** the engine must re-derive when the ACTIVE wallet changes (multi-wallet vault) */
export function bustWalletCache(userId: number): void {
  for (const k of keyCache.keys()) if (k.startsWith(`${userId}:`)) keyCache.delete(k);
}
const lastWalletWarning = new Map<number, number>();

function getWallet(doc: UserDoc): Keypair | null {
  if (!doc.secret) return null;
  // key by active-wallet identity: switching wallets mid-session must never
  // serve the previous wallet's cached key
  const key = `${doc.userId}:${doc.secret.slice(0, 16)}`;
  const hit = keyCache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.kp;
  try {
    const kp = keypairFromSecret(decryptSecret(doc.secret));
    keyCache.set(key, { at: Date.now(), kp });
    return kp;
  } catch (e) {
    console.error(`[trader] wallet decrypt failed for user ${doc.userId}:`, (e as Error).message);
    return null;
  }
}

async function warnNoWallet(userId: number, reason: string): Promise<void> {
  const now = Date.now();
  if (now - (lastWalletWarning.get(userId) || 0) < 10 * 60_000) return;
  lastWalletWarning.set(userId, now);
  await notifyUser(userId, `⚠️ <b>${reason}</b>\n\nHead to /wallet — generate or import one, then snipes go live.`);
}

/** exact SOL the ape spent, as text (falls back to the priced estimate) */
function apeSpendText(ev: WatchSignal): string | null {
  return solExact(ev.spentSolLamports ?? ev.spendLamports);
}

function escTag(x: string): string {
  return x.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function computeBudget(size: BuySizeConfig, watchedSpend: number | null, perTradeCapLamports: number): number {
  let budget: number;
  if (size.mode === 'pct' && watchedSpend !== null && watchedSpend > 0) {
    budget = Math.floor(watchedSpend * size.value);
  } else {
    budget = Math.floor(size.value);
  }
  return Math.max(0, Math.min(budget, perTradeCapLamports));
}

/** options for an internal re-entry into the buy path */
export interface CopyOpts {
  /** copy at half size (reputation filter) */
  halve?: boolean;
  /** skip the confirm-hold wait (already waited) */
  skipConfirm?: boolean;
}

/** human delay text: never rounds a real wait down to "0s" */
function secsTxt(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${Math.max(1, Math.round(ms / 1000))}s`;
}

/** fraction of their bag an ape may sell inside the confirm window before we skip */
export const CONFIRM_DUMP_FRACTION = 0.5;

/** how many raw tokens to sell for a fraction of the remaining bag (pure, tested) */
export function tokensForFraction(remaining: bigint, entryTotal: bigint, frac: number): bigint {
  if (remaining <= 0n) return 0n;
  const clamped = Math.min(1, Math.max(0.01, frac));
  const bp = BigInt(Math.round(clamped * 10_000));
  let tokens = (remaining * bp) / 10_000n;
  if (tokens <= 0n) tokens = remaining;
  if (tokens > remaining) tokens = remaining;
  // never leave an un-sellable dust crumb behind (<1% of the entry bag)
  if (entryTotal > 0n && remaining - tokens > 0n && remaining - tokens < entryTotal / 100n) tokens = remaining;
  return tokens;
}

export class Trader {
  private store: Store = getStore();
  private userChains = new Map<number, Promise<unknown>>();
  private knownUsers = new Set<number>();
  private checkerTimer: NodeJS.Timeout | null = null;
  private sellingRows = new Set<string>();
  private lastCheckTickAt = 0;
  private lastCheckPassMs: number | null = null;
  /** in-memory peak multiple per open row (drives the trailing stop) */
  private peaks = new Map<string, number>();
  /** throttles for the low-balance heads-up */
  private balanceCheckedAt = new Map<number, number>();
  private reconciledAt = new Map<string, number>();
  private balanceWarnedAt = new Map<number, number>();
  /** buys waiting for their confirm-hold window to elapse */
  private pendingConfirms = new Set<string>();
  /** confirmed copies that the reputation filter asked to halve */
  private halvedConfirm = new Map<string, boolean>();

  touchUser(userId: number): void {
    this.knownUsers.add(userId);
  }

  /** serialize all trade actions per user so nothing races */
  private chained<T>(userId: number, fn: () => Promise<T>): Promise<T> {
    const prev = this.userChains.get(userId) || Promise.resolve();
    const run = prev.then(fn, fn);
    this.userChains.set(userId, run.then(() => undefined, () => undefined));
    return run;
  }

  /* ============================ watch dispatch ============================ */

  async onWatchSignal(ev: WatchSignal, opts?: CopyOpts): Promise<void> {
    await this.chained(ev.userId, async () => {
      const doc = await this.store.getUser(ev.userId);
      if (!doc.watched.some((w) => w.id === ev.watchId)) return; // watch removed meanwhile
      if (ev.side === 'buy') await this.handleWatchedBuy(doc, ev, opts);
      else await this.handleWatchedSell(doc, ev);
    });
  }

  /* ------------------------- reputation + confirm ------------------------- */

  /**
   * Judge the watched wallet by the copies it already produced. A wallet with
   * a losing track record is skipped (or copied at half size) — this costs no
   * entry latency, unlike the confirm-hold delay.
   */
  private async reputationGate(doc: UserDoc, ev: WatchSignal): Promise<{ proceed: boolean; halve: boolean }> {
    const cfg: ReputationConfig | null = doc.settings.reputation || null;
    if (!cfg || !cfg.enabled) return { proceed: true, halve: !!this.halvedConfirm.get(`${doc.userId}:${ev.mint}`) };
    const rows = await this.store.listTrades(doc.userId).catch(() => [] as TradeRow[]);
    const stats = watchReputation(rows, ev.watchId);
    const v = evaluateReputation(stats, cfg);
    if (!v.judged || v.pass) return { proceed: true, halve: false };
    const record = `${Math.round(v.winRate * 100)}% win rate over ${v.closed} copies`;
    const floor = `${Math.round(cfg.minWinRate * 100)}%`;
    if (cfg.onFail === 'skip') {
      await notifyUser(
        doc.userId,
        `🧾 <b>SKIPPED — WEAK APE</b> — ${escTag(ev.watchedLabel)} is at ${record}, below your ${floor} floor.\n`
        + `No funds spent on ${coinTag(ev.mintName, ev.mintSymbol, ev.mint)}. Change it in ⚙️ Settings → 👤 reputation.`,
        { silent: true },
      );
      return { proceed: false, halve: false };
    }
    return { proceed: true, halve: true };
  }

  /** true only on POSITIVE evidence that the ape dumped; unknown = fail-open */
  private async apeDumpCheck(ev: WatchSignal, dumpFrac = CONFIRM_DUMP_FRACTION): Promise<{ dumped: boolean; soldPct: number }> {
    const bought = BigInt(ev.tokenAmountRaw || '0');
    const now = await this.tokenBalanceOf(new PublicKey(ev.watchedAddress), new PublicKey(ev.mint)).catch(() => null);
    if (now === null) return { dumped: false, soldPct: 0 }; // could not verify -> copy anyway
    if (bought <= 0n) return { dumped: now <= 0n, soldPct: 100 };
    const kept = Number(now) / Number(bought);
    const soldPct = Math.max(0, Math.min(100, Math.round((1 - kept) * 100)));
    return { dumped: kept <= 1 - dumpFrac, soldPct };
  }

  /** wait, verify the ape still holds, then copy (per-wallet confirm-hold) */
  private async scheduleConfirmedCopy(doc: UserDoc, ev: WatchSignal, delayMs: number, halve: boolean): Promise<void> {
    const key = `${doc.userId}:${ev.watchedAddress}:${ev.mint}`;
    if (this.pendingConfirms.has(key)) return; // already waiting on this one
    this.pendingConfirms.add(key);
    if (halve) this.halvedConfirm.set(`${doc.userId}:${ev.mint}`, true);
    if (doc.settings.alerts.activity) {
      await notifyUser(
        doc.userId,
        `⏳ <b>CONFIRMING</b> — ${escTag(ev.watchedLabel)} bought ${coinTag(ev.mintName, ev.mintSymbol, ev.mint)}. `
        + `Waiting ${secsTxt(delayMs)} to see if they hold before copying.`,
        { silent: true },
      );
    }
    const t = setTimeout(async () => {
      this.pendingConfirms.delete(key);
      this.halvedConfirm.delete(`${doc.userId}:${ev.mint}`);
      try {
        const v = await this.apeDumpCheck(ev);
        if (v.dumped) {
          await notifyUser(
            doc.userId,
            `🚫 <b>SKIPPED — INSTANT DUMP</b> — ${escTag(ev.watchedLabel)} sold ${v.soldPct}% of their `
            + `${coinTag(ev.mintName, ev.mintSymbol, ev.mint)} within ${secsTxt(delayMs)} of buying. Nothing copied.`,
            { silent: true },
          );
          return;
        }
      } catch (e) {
        console.error('[trader] confirm-hold check failed:', (e as Error).message);
      }
      await this.onWatchSignal(ev, { halve, skipConfirm: true }).catch((e) => {
        console.error('[trader] confirmed copy failed:', (e as Error).message);
      });
    }, delayMs);
    if (typeof t.unref === 'function') t.unref();
  }

  private async handleWatchedBuy(doc: UserDoc, ev: WatchSignal, opts?: CopyOpts): Promise<void> {
    const conn = getConnection();
    const s = doc.settings;
    const wallet = getWallet(doc);
    if (!wallet) {
      await warnNoWallet(doc.userId, `${ev.watchedLabel} just aped ${coinTag(ev.mintName, ev.mintSymbol, ev.mint)} — but you have no KACHIBOT wallet yet`);
      return;
    }
    if (ev.spendLamports !== null) {
      if (ev.spendLamports < s.minSpendLamports) return;
      if (ev.spendLamports > s.maxSpendLamports) {
        const spentTxt = apeSpendText(ev);
        await notifyUser(
          doc.userId,
          `👁 <b>RADAR</b> — ${escTag(ev.watchedLabel)} bought ${coinTag(ev.mintName, ev.mintSymbol, ev.mint)}${spentTxt ? ` — spent ${spentTxt}` : ''}, above your max-spend filter (${(s.maxSpendLamports / 1e9).toFixed(2)}◎). Skipped.`,
        );
        return;
      }
    }

    // reputation gate: judge the ape by the copies it already produced
    const gate = await this.reputationGate(doc, ev);
    if (!gate.proceed) return;

    const phase = await curvePhase(conn, new PublicKey(ev.mint)).catch(() => 'unknown' as const);
    if (phase === 'unknown' || phase === 'none') {
      if (s.alerts.activity) {
        await notifyUser(doc.userId, `👁 <b>RADAR</b> — ${escTag(ev.watchedLabel)} bought ${coinTag(ev.mintName, ev.mintSymbol, ev.mint)} — not a live pump token (already graduated or delisted). Nothing copied.`);
      }
      return;
    }

    // per-wallet confirm-hold: pause, verify the ape still holds, then copy
    const watch = ev.watchId ? doc.watched.find((w) => w.id === ev.watchId) || null : null;
    const holdMs = Number(watch?.confirmHoldMs || 0);
    const halve = gate.halve || !!opts?.halve;
    if (holdMs > 0 && !opts?.skipConfirm) {
      await this.scheduleConfirmedCopy(doc, ev, holdMs, halve);
      return;
    }

    const buySize = resolveBuySize(doc, watch);
    const budget0 = computeBudget(buySize, ev.spendLamports, s.perTradeCapLamports);
    const budget = halve ? Math.floor(budget0 / 2) : budget0;
    if (budget <= 0) return;

    const bal = await conn.getBalance(wallet.publicKey, 'confirmed').catch(() => -1);
    if (bal < budget + s.maxFeeLamports + 2_000_000) {
      const have = Math.max(0, bal) / 1e9;
      const need = (budget + s.maxFeeLamports + 2_000_000) / 1e9;
      const apeSpent = apeSpendText(ev);
      await notifyUser(
        doc.userId,
        `⛔ <b>SNIPE BLOCKED</b> — ${escTag(ev.watchedLabel)} aped ${coinTag(ev.mintName, ev.mintSymbol, ev.mint)}${apeSpent ? ` with ${apeSpent}` : ''} — but your wallet holds ${have.toFixed(4)} SOL.\n\nNeed ≈ ${need.toFixed(4)} SOL to mirror it (buy + priority fee + buffer). Refill at /wallet — the next ape gets copied.`,
      );
      return;
    }

    const today = dayKey();
    const spentToday = doc.daySpend && doc.daySpend.day === today ? doc.daySpend.lamports : 0;
    const headroom = s.dailyCapLamports - spentToday;
    if (headroom <= 0) {
      await notifyUser(doc.userId, `🪫 <b>DAILY CAP HIT</b> — ${(spentToday / 1e9).toFixed(3)}◎ auto-bought today. Snipe auto-cancelled; resets tomorrow.`, { silent: true });
      return;
    }

    if (s.honeypotCheck) {
      const flags = await rugFlags(conn, new PublicKey(ev.mint));
      const issues = describeRugFlags(flags);
      if (issues.length) {
        await notifyUser(doc.userId, `🛡️ <b>RUG CHECK FAILED</b> — skipped ${coinTag(ev.mintName, ev.mintSymbol, ev.mint)} (${issues.join('; ')}).\nDisable the honeypot check in /settings to ape anyway.`);
        return;
      }
    }

    await this.executeBuy(doc, ev, Math.min(budget, headroom), phase === 'curve' ? 'curve' : 'jupiter');
  }

  private async handleWatchedSell(doc: UserDoc, ev: WatchSignal): Promise<void> {
    if (!doc.settings.copySell) return;
    const open = await this.store.listTrades(doc.userId, 'open');
    // outOfSync rows hold tokens the wallet no longer has — selling them is a
    // guaranteed failure, so the 🧹 button (not a copy-sell) closes those.
    const matches = open.filter((t) => t.mint === ev.mint && !t.outOfSync && !this.sellingRows.has(t.id));
    if (!matches.length) return;

    // the exit rule of the watch that triggered this (override, else global)
    const watch = ev.watchId ? doc.watched.find((w) => w.id === ev.watchId) || null : null;
    const exit = resolveExit(doc, watch);
    const soldTxt = solExact(ev.spendLamports);
    const what = coinTag(ev.mintName, ev.mintSymbol, ev.mint);
    const ruleFrac = exitSellFraction(exit);
    // mirror: sell the same slice of OUR bag that the ape sold of theirs, so a
    // partial profit-take leaves us a moonbag too (TP/SL still guard the rest).
    const frac = copySellFraction(doc.settings.copySellMode, ev.apeSoldFraction, ruleFrac);
    const mirrored = doc.settings.copySellMode === 'mirror' && typeof ev.apeSoldFraction === 'number' && ev.apeSoldFraction > 0;

    // hold / mult / mcap: the ape selling is NOT an exit signal for us
    if (frac <= 0) {
      if (doc.settings.alerts.activity) {
        const tail = exit.mode === 'hold'
          ? 'your rule is <b>hold</b> — nothing sold. TP ladder & stop-loss still guard it.'
          : `your rule is <b>${describeExit(exit)}</b> — holding until then.`;
        await notifyUser(doc.userId, `👻 <b>APE SOLD — HOLDING</b> — ${escTag(ev.watchedLabel)} dumped ${what}${soldTxt ? ` (≈ ${soldTxt})` : ''}. ${tail}`);
      }
      return;
    }

    if (doc.settings.alerts.activity) {
      const size = frac >= 0.999 ? 'all' : `${Math.round(frac * 100)}%`;
      const how = mirrored
        ? `they sold ${Math.round((ev.apeSoldFraction as number) * 100)}% of their bag — selling ${size} of yours and keeping the rest as a moonbag`
        : `selling ${size}`;
      await notifyUser(
        doc.userId,
        `👻 <b>COPY-SELL TRIGGERED</b> — ${escTag(ev.watchedLabel)} dumped ${what}${soldTxt ? ` (≈ ${soldTxt})` : ''}. ${how} on ${matches.length} open position${matches.length > 1 ? 's' : ''}.`,
      );
    }
    for (const t of matches) {
      const job = frac >= 0.999
        ? this.sellOpenPosition(doc.userId, t.id, 'COPY_SELL')
        : this.sellFraction(doc.userId, t.id, frac, 'COPY_SELL');
      await job.catch(async (e) => {
        const why = (e as Error).message;
        console.error('[trader] copy-sell failed:', why);
        // never leave the user thinking it sold — TP / SL still guard the bag
        await notifyUser(
          doc.userId,
          `⚠️ <b>COPY-SELL FAILED</b> — ${what} did not sell: ${escTag(why.slice(0, 140))}\n\nYour position is still open; the TP ladder and stop-loss keep watching it. You can also sell by hand in 📡 Positions.`,
        ).catch(() => undefined);
      });
    }
  }

  /** sell a fraction of the REMAINING position (partial copy-sell) */
  async sellFraction(userId: number, rowId: string, frac: number, reason: ExitReason): Promise<TradeRow | null> {
    return this.chained(userId, () => this.sellFractionLocked(userId, rowId, frac, reason));
  }

  private async sellFractionLocked(userId: number, rowId: string, frac: number, reason: ExitReason): Promise<TradeRow | null> {
    const doc = await this.store.getUser(userId);
    const wallet = getWallet(doc);
    if (!wallet) return null;
    const open = await this.store.listTrades(userId, 'open');
    const row = open.find((t) => t.id === rowId);
    if (!row) return null;
    const remaining = this.remainingTokens(row);
    if (remaining <= 0n || this.sellingRows.has(row.id)) return row;

    const clamped = Math.min(1, Math.max(0.01, frac));
    const tokens = tokensForFraction(remaining, BigInt(row.entryTokenAmount), frac);

    this.sellingRows.add(row.id);
    try {
      const proceeds = await this.execSell(doc, wallet, row, tokens);
      await this.recordSell(row, reason, tokens, proceeds, null);
      await this.closeRowIfDone(row);
      if (!this.isFullyOut(row) && doc.settings.alerts.sells) {
        const left = this.remainingTokens(row);
        const entry = BigInt(row.entryTokenAmount);
        await notifyUser(userId, `💸 <b>SOLD ${Math.round(clamped * 100)}%</b> — $${row.symbol}: ${(proceeds / 1e9).toFixed(5)}◎ out — ${(Number(left) / Number(entry) * 100).toFixed(0)}% of the bag still open`);
      }
      return row;
    } catch (e) {
      const msg = (e as Error).message;
      if (/no sell route|no route|liquidity gone|curve gone|not buyable/i.test(msg)) {
        await this.recordSell(row, 'RUG', remaining, 0, null, `rug sweep: ${msg}`);
        await this.closeRowIfDone(row);
        await notifyUser(userId, `🧨 <b>RUG SWEEP</b> — $${row.symbol}: ${msg.slice(0, 140)}. Position closed at 0.`);
        return row;
      }
      row.error = msg;
      await this.store.putTrade(row);
      await notifyUser(userId, `⛔ <b>SELL FAILED</b> — $${row.symbol}: ${msg}\nRetry from 📡 Positions.`);
      return row;
    } finally {
      this.sellingRows.delete(row.id);
    }
  }

  /* ================================ buy ================================== */

  private async newRow(doc: UserDoc, ev: WatchSignal, meta: { symbol: string; name: string }): Promise<TradeRow> {
    const now = Date.now();
    const s = doc.settings;
    return {
      id: `T${doc.userId}-${now}-${Math.floor(Math.random() * 1e6)}`,
      userId: doc.userId,
      watchId: ev.watchId,
      watchedAddress: ev.watchedAddress,
      watchedLabel: ev.watchedLabel,
      mint: ev.mint,
      symbol: meta.symbol,
      name: meta.name,
      tokenProgram: 'spl',
      entryTime: now,
      exitTime: null,
      spentLamports: 0,
      entryTokenAmount: '0',
      entryPriceLamports: 0,
      entryMcapLamports: null,
      walletBalanceBefore: null,
      peakMultiple: null,
      settingsAtEntry: {
        exit: resolveExit(doc, ev.watchId ? doc.watched.find((w) => w.id === ev.watchId) || null : null),
        trailing: normalizeTrailing(s.trailing),
        breakEvenStop: !!s.breakEvenStop,
        maxHoldMs: s.maxHoldMs ?? null,
        tpMultiples: [...s.tpMultiples],
        stopLossPct: s.stopLossPct,
        copySell: s.copySell,
        copySellMode: s.copySellMode,
        slippagePct: s.slippagePct,
        maxFeeLamports: s.maxFeeLamports,
      },
      partialSells: [],
      status: 'open',
      exitReason: null,
      realizedQuoteLamports: null,
      exitPriceLamports: null,
      walletBalanceAfter: null,
      pnlLamports: null,
      pnlPct: null,
      netMultiple: null,
      holdMs: null,
      error: null,
      txSignatures: [],
    };
  }

  /**
   * Plan a post-graduation buy across every venue we can reach:
   * Jupiter first (best aggregated price), then the PumpSwap pool directly.
   * Retries a couple of times because a freshly graduated coin can spend a few
   * seconds with no indexed route and no live pool.
   */
  private async planGraduatedBuy(
    conn: Connection,
    opts: { mint: PublicKey; buyer: PublicKey; budgetLamports: number; slippagePct: number },
  ): Promise<
    { kind: 'jupiter'; plan: Awaited<ReturnType<typeof buildJupiterBuy>>['plan']; tx: VersionedTransaction } |
    { kind: 'pumpswap'; plan: Awaited<ReturnType<typeof buildPumpSwapBuy>> }
  > {
    const ATTEMPTS = 3;
    let lastErr = 'no route found for this token';
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      try {
        const j = await buildJupiterBuy(conn, opts);
        return { kind: 'jupiter', plan: j.plan, tx: j.tx };
      } catch (e) {
        const m = (e as Error).message;
        if (!noRouteError(m)) throw e; // real failure (bad params, …) — do not retry
        lastErr = m;
      }
      try {
        const ps = await buildPumpSwapBuy(conn, opts);
        return { kind: 'pumpswap', plan: ps };
      } catch (e) {
        lastErr = (e as Error).message;
        if (attempt < ATTEMPTS) await new Promise((r) => setTimeout(r, 4000));
      }
    }
    throw new Error(
      /migrat|no PumpSwap pool/i.test(lastErr)
        ? 'coin just graduated and its liquidity is still migrating — no tradeable pool yet (~12s of retries)'
        : lastErr,
    );
  }

  private async executeBuy(doc: UserDoc, ev: WatchSignal, budget: number, route: 'curve' | 'jupiter'): Promise<void> {
    const conn = getConnection();
    const wallet = getWallet(doc);
    if (!wallet) return;
    const mint = new PublicKey(ev.mint);
    const meta = await getTokenMeta(conn, mint).catch(() => null);
    const row = await this.newRow(doc, ev, {
      symbol: meta?.symbol || ev.mint.slice(0, 6),
      name: meta?.name || ev.mint.slice(0, 6),
    });

    try {
      const balBefore = await conn.getBalance(wallet.publicKey, 'confirmed').catch(() => 0);
      const beforeAta = await this.tokenBalanceOf(wallet.publicKey, mint);
      row.walletBalanceBefore = balBefore;
      await this.store.putTrade(row); // crash-safe trail (swept at next boot if no tokens land)

      if (route === 'curve') {
        const plan = await buildCurveBuy(conn, { mint, buyer: wallet.publicKey, budgetLamports: budget, slippagePct: doc.settings.slippagePct });
        const tp = await getTokenProgramForMint(conn, mint);
        row.tokenProgram = tp.equals(TOKEN_2022_PROGRAM_ID) ? 'token2022' : 'spl';
        row.entryPriceLamports = await priceSolPerTokenLamports(conn, plan.curve);
        row.entryMcapLamports = await mcapSolLamports(conn, plan.curve);
        if (doc.settings.honeypotCheck) {
          const sim = await simulate(conn, wallet, plan.ixs);
          if (!sim.ok) throw new DodgedError(`pre-buy simulation failed (${sim.err}) — token is not buyable`);
        }
        const res = await sendTrade(conn, wallet, plan.ixs, doc.settings.maxFeeLamports);
        row.txSignatures.push(res.signature);
        if (res.outcome === 'landed-failed') throw new Error('tx landed but failed on-chain');
      } else {
        // A coin that JUST graduated can sit in a window where Jupiter has not
        // indexed it and the PumpSwap pool is not live yet. Retry briefly
        // across both venues instead of losing the copy.
        const leg = await this.planGraduatedBuy(conn, {
          mint,
          buyer: wallet.publicKey,
          budgetLamports: budget,
          slippagePct: doc.settings.slippagePct,
        });
        const j = leg.kind === 'jupiter' ? leg : null;
        const ps = leg.kind === 'pumpswap' ? leg.plan : null;
        const supply = await this.mintSupply(mint);

        if (j) {
          row.entryMcapLamports = supply !== null && j.plan.tokenAmountRaw > 0n
            ? Math.floor((Number(j.plan.solLamports) * supply) / Number(j.plan.tokenAmountRaw))
            : null;
          if (doc.settings.honeypotCheck) {
            const okSim = await this.simulateVersioned(j.tx);
            if (!okSim) throw new DodgedError('jupiter swap simulation failed — no safe route');
          }
          const sig = await this.sendJupiterTx(wallet, j.tx);
          row.txSignatures.push(sig);
        } else if (ps) {
          row.entryMcapLamports = poolMcapLamports(
            { poolBaseAmount: new BN(ps.poolBase), poolQuoteAmount: new BN(ps.poolQuote) },
            supply,
          );
          if (doc.settings.honeypotCheck) {
            const sim = await simulate(conn, wallet, ps.ixs);
            if (!sim.ok) throw new DodgedError(`pre-buy simulation failed (${sim.err}) — token is not buyable`);
          }
          const res = await sendTrade(conn, wallet, ps.ixs, doc.settings.maxFeeLamports);
          row.txSignatures.push(res.signature);
          if (res.outcome === 'landed-failed') throw new Error('tx landed but failed on-chain');
        }
      }

      const afterAta = await this.tokenBalanceOf(wallet.publicKey, mint, 6000);
      const balAfter = await conn.getBalance(wallet.publicKey, 'confirmed').catch(() => 0);
      const tokensIn = afterAta > beforeAta ? afterAta - beforeAta : 0n;
      const spent = Math.max(0, balBefore - balAfter);

      if (tokensIn <= 0n) throw new Error(`no tokens received — wallet balance moved ${(spent / 1e9).toFixed(6)}◎`);

      row.spentLamports = spent;
      row.entryTokenAmount = tokensIn.toString();
      row.entryPriceLamports = tokensIn > 0n && spent > 0 ? spent / Number(tokensIn) : row.entryPriceLamports;
      row.error = null;
      await this.store.putTrade(row);

      // rolling daily spend
      const today = dayKey();
      const prev = doc.daySpend && doc.daySpend.day === today ? doc.daySpend.lamports : 0;
      doc.daySpend = { day: today, lamports: prev + spent };
      await this.store.saveUser(doc);
      if (prev + spent >= doc.settings.dailyCapLamports) {
        await notifyUser(doc.userId, `🪫 <b>DAILY CAP REACHED</b> — ${((prev + spent) / 1e9).toFixed(3)}◎ auto-bought today. Further snipes cancel until tomorrow.`, { silent: true });
      }

      await this.notifySnipe(row);
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      row.status = 'failed';
      row.exitTime = Date.now();
      row.error = err.message;
      row.walletBalanceAfter = await conn.getBalance(wallet.publicKey, 'confirmed').catch(() => null);
      await this.store.putTrade(row).catch(() => undefined);
      const dodged = e instanceof DodgedError;
      const al = await this.store.getUser(doc.userId).catch(() => null);
      if (al?.settings.alerts.snipes) {
        await notifyUser(
          doc.userId,
          `${dodged ? '🛡️ <b>SNIPE DODGED</b>' : '⛔ <b>SNIPE FAILED</b>'} — $${row.symbol}: ${err.message}${dodged ? '' : ' (failed row kept in history)'}`,
        );
      }
    }
  }

  private async notifySnipe(row: TradeRow): Promise<void> {
    const u = await this.store.getUser(row.userId).catch(() => null);
    if (!u || !u.settings.alerts.snipes) return; // 🎯 snipes OFF → successful buys stay silent
    const tp = row.settingsAtEntry.tpMultiples.map((m) => `${m}x`).join('/');
    const lines = [
      `🎯 <b>SNIPE LOCKED</b> — ${row.name} <b>$${row.symbol}</b>`,
      row.watchedLabel ? `copied ${row.watchedLabel}` : '',
      row.entryMcapLamports !== null && row.entryMcapLamports > 0 ? `entry mcap ◎${(row.entryMcapLamports / 1e9).toFixed(4)}` : '',
      `spent ${(row.spentLamports / 1e9).toFixed(5)}◎ · TP ${tp} · SL ${(row.settingsAtEntry.stopLossPct * 100).toFixed(0)}%`,
      chartLink(row.mint),
    ].filter((l) => l.length > 0);
    await notifyUser(row.userId, lines.join('\n'), {
      buttons: [
        [['💸 Sell now', `sell:${row.id}`], ['📡 Position', `pos:${row.id}`]],
      ],
    });
  }

  /* ============================ sell pipelines ============================ */

  private remainingTokens(row: TradeRow): bigint {
    const sold = row.partialSells.reduce((a, s) => a + BigInt(s.tokenAmountRaw), 0n);
    return BigInt(row.entryTokenAmount) - sold;
  }

  private isFullyOut(row: TradeRow): boolean {
    return this.remainingTokens(row) <= 0n;
  }

  /** Full close of one open position (SL, copy-sell, manual, panic, rug). */
  async sellOpenPosition(userId: number, rowId: string, reason: ExitReason, targetMultiple: number | null = null): Promise<TradeRow | null> {
    return this.chained(userId, () => this.sellOpenPositionLocked(userId, rowId, reason, targetMultiple));
  }

  private async sellOpenPositionLocked(userId: number, rowId: string, reason: ExitReason, targetMultiple: number | null = null): Promise<TradeRow | null> {
    const doc = await this.store.getUser(userId);
    const wallet = getWallet(doc);
    if (!wallet) return null;
    const open = await this.store.listTrades(userId, 'open');
    const row = open.find((t) => t.id === rowId);
    if (!row) return null;
    const remaining = this.remainingTokens(row);
    if (remaining <= 0n || this.sellingRows.has(row.id)) return row;

    this.sellingRows.add(row.id);
    try {
      const proceeds = await this.execSell(doc, wallet, row, remaining);
      await this.recordSell(row, reason, remaining, proceeds, targetMultiple);
      if (!this.isFullyOut(row)) {
        // e.g. token balance measurement shortfall: keep the rest open but flag it
        row.error = `partial close: ${((remaining - this.remainingTokens(row)) / BigInt(row.entryTokenAmount) * 100n).toString()}% sold`;
      }
      await this.closeRowIfDone(row);
      return row;
    } catch (e) {
      const msg = (e as Error).message;
      if (/no sell route|no route|liquidity gone|curve gone|not buyable/i.test(msg)) {
        await this.recordSell(row, 'RUG', remaining, 0, null, `rug sweep: ${msg}`);
        await this.closeRowIfDone(row);
        await notifyUser(userId, `🧨 <b>RUG SWEEP</b> — $${row.symbol}: ${msg.slice(0, 140)}. Position closed at 0.`);
        return row;
      }
      row.error = msg;
      await this.store.putTrade(row);
      await notifyUser(userId, `⛔ <b>SELL FAILED</b> — $${row.symbol}: ${msg}\nRetry from 📡 Positions.`);
      return row;
    } finally {
      this.sellingRows.delete(row.id);
    }
  }

  /** Sell a TP step (a share of the position) when a rung is reached. */
  private async sellTpStepLocked(userId: number, row: TradeRow, targetMultiple: number): Promise<void> {
    const doc = await this.store.getUser(userId);
    const wallet = getWallet(doc);
    if (!wallet) return;
    const remaining = this.remainingTokens(row);
    if (remaining <= 0n || this.sellingRows.has(row.id)) return;
    const steps = row.settingsAtEntry.tpMultiples.length || 1;
    const stepTokens = BigInt(row.entryTokenAmount) / BigInt(steps);
    const sellTokens = stepTokens > remaining ? remaining : stepTokens;

    this.sellingRows.add(row.id);
    try {
      const proceeds = await this.execSell(doc, wallet, row, sellTokens);
      await this.recordSell(row, 'TP', sellTokens, proceeds, targetMultiple);
      await this.closeRowIfDone(row);
      if (this.isFullyOut(row)) return;
      const net = proceeds - Number(sellTokens) * row.entryPriceLamports;
      if (doc.settings.alerts.sells) {
        await notifyUser(userId, `🎯 <b>TP ${targetMultiple.toFixed(1)}x</b> — $${row.symbol} step: ${(proceeds / 1e9).toFixed(5)}◎ out (${net >= 0 ? '+' : ''}${(net / 1e9).toFixed(5)}◎) — position still open`);
      }
    } catch (e) {
      const msg = (e as Error).message;
      row.error = `TP step failed: ${msg}`;
      await this.store.putTrade(row).catch(() => undefined);
    } finally {
      this.sellingRows.delete(row.id);
    }
  }

  /**
   * Sell with a slippage ladder. A copy-sell races the ape's own dump, so the
   * first attempt uses your slippage and later ones widen it — the exit has to
   * land even while the price is running. Only errors that a wider slippage or
   * a fresh blockhash can fix are retried.
   */
  private async execSell(
    doc: UserDoc,
    wallet: Keypair,
    row: TradeRow,
    tokenAmountRaw: bigint,
    opts: { attempts?: number; slippagePct?: number } = {},
  ): Promise<number> {
    const base = Number.isFinite(opts.slippagePct) ? Number(opts.slippagePct) : row.settingsAtEntry.slippagePct;
    const attempts = Math.max(1, Math.min(4, Math.floor(opts.attempts ?? 3)));
    let last: Error | null = null;
    for (let i = 0; i < attempts; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, 350 * i));
      const slippagePct = i === 0 ? base : Math.min(50, Math.max(base, base * (i === 1 ? 2.5 : 6)));
      try {
        return await this.execSellOnce(doc, wallet, row, tokenAmountRaw, slippagePct);
      } catch (e) {
        last = e as Error;
        if (!isRetryableSellError(last.message)) throw last;
        console.warn(`[trader] sell attempt ${i + 1}/${attempts} failed (slippage ${slippagePct.toFixed(1)}%): ${last.message.slice(0, 140)}`);
      }
    }
    throw last ?? new Error('sell failed');
  }

  /**
   * Execute one sell order for `tokenAmountRaw` of `row.mint`, returning
   * realized SOL lamports (measured from the wallet balance delta).
   */
  private async execSellOnce(
    doc: UserDoc,
    wallet: Keypair,
    row: TradeRow,
    tokenAmountRaw: bigint,
    slippagePct: number,
  ): Promise<number> {
    const conn = getConnection();
    const mint = new PublicKey(row.mint);
    const tokenProgram = row.tokenProgram === 'token2022' ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
    const phase = await curvePhase(conn, mint);
    const balBefore = await conn.getBalance(wallet.publicKey, 'confirmed');

    if (phase === 'curve') {
      const plan = await buildCurveSell(conn, {
        mint,
        seller: wallet.publicKey,
        tokenAmount: new BN(tokenAmountRaw.toString()),
        slippagePct,
        tokenProgram,
      });
      const res = await sendTrade(conn, wallet, plan.ixs, row.settingsAtEntry.maxFeeLamports);
      if (res.outcome === 'landed-failed') {
        const parsed = await conn.getParsedTransaction(res.signature, { commitment: 'confirmed' }).catch(() => null);
        throw new Error(`on-chain error: ${parsed?.meta?.err ? JSON.stringify(parsed.meta.err).slice(0, 200) : 'unknown'}`);
      }
    } else {
      const j = await buildJupiterSell(conn, {
        mint,
        seller: wallet.publicKey,
        tokenAmountRaw,
        slippagePct,
      }).catch(() => null);
      if (j) {
        await this.sendJupiterTx(wallet, j.tx);
      } else {
        // no Jupiter route (freshly graduated coin): sell into the PumpSwap
        // pool directly, otherwise the position would be un-sellable
        const ps = await buildPumpSwapSell(conn, {
          mint,
          seller: wallet.publicKey,
          tokenAmountRaw,
          slippagePct,
        }).catch((e) => { throw new Error(`no sell route — liquidity gone (${(e as Error).message})`); });
        const res = await sendTrade(conn, wallet, ps.ixs, row.settingsAtEntry.maxFeeLamports);
        if (res.outcome === 'landed-failed') {
          const parsed = await conn.getParsedTransaction(res.signature, { commitment: 'confirmed' }).catch(() => null);
          throw new Error(`on-chain error: ${parsed?.meta?.err ? JSON.stringify(parsed.meta.err).slice(0, 200) : 'unknown'}`);
        }
      }
    }

    const balAfter = await conn.getBalance(wallet.publicKey, 'confirmed');
    const proceeds = Math.max(0, balAfter - balBefore);
    if (proceeds === 0 && tokenAmountRaw > 0n) {
      // token balance sanity: did the sale actually happen?
      const held = await this.tokenBalanceOf(wallet.publicKey, mint);
      if (held >= tokenAmountRaw) throw new Error('sell tx did not move tokens (measurement: wallet balance unchanged)');
    }
    return proceeds;
  }

  /** market cap in SOL lamports at exit; derives it for rows closed before we stored it */
  async mcapAtExitLamports(row: TradeRow): Promise<number | null> {
    if (typeof row.exitMcapLamports === 'number' && row.exitMcapLamports > 0) return row.exitMcapLamports;
    const px = row.exitPriceLamports ?? 0;
    if (!(px > 0)) return null;
    const supply = await this.mintSupply(new PublicKey(row.mint)).catch(() => null);
    return supply !== null ? Math.floor(px * supply) : null;
  }

  /** append a sell record; row passed by reference is mutated */
  private async recordSell(
    row: TradeRow,
    reason: ExitReason,
    tokenAmountRaw: bigint,
    quoteLamports: number,
    targetMultiple: number | null,
    errNote?: string,
  ): Promise<void> {
    const multiple = targetMultiple !== null
      ? targetMultiple
      : row.entryPriceLamports > 0 && tokenAmountRaw > 0n
        ? quoteLamports / (Number(tokenAmountRaw) * row.entryPriceLamports)
        : 0;
    row.partialSells.push({
      time: Date.now(),
      reason,
      multiple,
      tokenAmountRaw: tokenAmountRaw.toString(),
      quoteLamports,
      txSignature: null,
    });
    row.error = errNote || null;
    await this.store.putTrade(row);
  }

  /** close the row when no tokens remain; broadcast the scorecard */
  private async closeRowIfDone(row: TradeRow): Promise<boolean> {
    if (!this.isFullyOut(row) || row.status === 'closed') return false;
    const store = this.store;
    const realized = row.partialSells.reduce((a, s) => a + s.quoteLamports, 0);
    const last = row.partialSells[row.partialSells.length - 1];
    const conn = getConnection();

    row.status = 'closed';
    row.exitReason = last ? last.reason : 'MANUAL';
    row.exitTime = Date.now();
    row.realizedQuoteLamports = realized;
    const sold = row.partialSells.reduce((a, s) => a + BigInt(s.tokenAmountRaw), 0n);
    row.exitPriceLamports = sold > 0n && realized > 0 ? realized / Number(sold) : null;
    row.pnlLamports = realized - row.spentLamports;
    row.pnlPct = row.spentLamports > 0 ? (realized - row.spentLamports) / row.spentLamports : null;
    row.netMultiple = row.spentLamports > 0 ? realized / row.spentLamports : null;
    row.holdMs = row.exitTime - row.entryTime;

    // exit market cap: price per token at exit x supply (same maths as entry)
    {
      const px = row.exitPriceLamports ?? 0;
      const supply = await this.mintSupply(new PublicKey(row.mint)).catch(() => null);
      row.exitMcapLamports = supply !== null && px > 0 ? Math.floor(px * supply) : null;
    }

    const doc = await store.getUser(row.userId);
    const wallet = getWallet(doc);
    row.walletBalanceAfter = wallet
      ? await conn.getBalance(wallet.publicKey, 'confirmed').catch(() => null)
      : null;
    await store.putTrade(row);

    // scorecard + running PnL. 💸 sells alerts OFF → automatic exits (TP / SL /
    // copy-sell) close quietly; manual sells & panic always confirm with a card.
    const all = await store.listTrades(row.userId);
    const closed = all.filter((t) => t.status === 'closed');
    const running = closed.reduce((a, t) => a + (t.pnlLamports ?? 0), 0);
    const reason = row.exitReason ?? 'MANUAL';
    const quiet = !doc.settings.alerts.sells && ['TP', 'SL', 'COPY_SELL'].includes(reason);
    if (!quiet) {
      await notifyUser(row.userId, scorecardText(row, closed.length, running), {
        buttons: [
          [['📖 History', 'hist:0'], ['💸 Panic sell-all', 'panic:0']],
        ],
      });
    }
    return true;
  }

  /* ------------------------------- sell-all ------------------------------- */

  async sellAll(userId: number, reason: ExitReason): Promise<number> {
    return this.chained(userId, async () => {
      const open = await this.store.listTrades(userId, 'open');
      let done = 0;
      for (const t of open) {
        try {
          if (await this.sellOpenPositionLocked(userId, t.id, reason)) done++;
        } catch (e) {
          console.error('[trader] sellAll item:', (e as Error).message);
        }
      }
      return done;
    });
  }

  /* =========================== TP / SL / RUG loop ========================== */

  startChecker(intervalMs = 5000): void {
    if (this.checkerTimer) return;
    this.checkerTimer = setInterval(() => { void this.checkOpenPositions(); }, intervalMs);
    if (typeof this.checkerTimer.unref === 'function') this.checkerTimer.unref();
  }

  /** heartbeat of the exit checker, for /status: { running, lastTickAgeSec, lastPassMs } */
  checkerState(): { running: boolean; lastTickAt: number | null; lastPassMs: number | null } {
    return {
      running: this.checkerTimer !== null,
      lastTickAt: this.lastCheckTickAt || null,
      lastPassMs: this.lastCheckPassMs,
    };
  }

  private async checkOpenPositions(): Promise<void> {
    const startedAt = Date.now();
    this.lastCheckTickAt = startedAt;
    let users: UserDoc[] = [];
    try {
      users = await this.store.listUsers();
    } catch {
      users = [...this.knownUsers].map((u) => ({ userId: u } as UserDoc));
    }
    try {
      await this.checkOpenPositionsInner(users);
    } finally {
      this.lastCheckPassMs = Date.now() - startedAt;
    }
  }

  private async checkOpenPositionsInner(users: UserDoc[]): Promise<void> {
    for (const doc of users) {
      const userId = doc.userId;
      try {
        const open = await this.store.listTrades(userId, 'open');
        const wallet = getWallet(doc);
        for (const row of open) {
          if (this.sellingRows.has(row.id)) continue;
          // a position whose tokens already left the wallet is never sellable:
          // stop re-trying it every tick and let the user reconcile it
          if (row.outOfSync) continue;
          if (wallet && !(await this.reconcileRow(userId, row, wallet))) continue;
          await this.chained(userId, () => this.checkThresholds(userId, row));
        }
      } catch (e) {
        console.error('[trader] checker:', (e as Error).message);
      }
      // proactive refill nudge — so the next ape is not blocked at buy time
      await this.checkLowBalance(doc).catch(() => undefined);
    }
  }

  /**
   * Does the wallet still hold what this open row claims?
   * Tokens can leave without us (sold from another bot, moved to a cold
   * wallet, …). Without this the bot would retry an impossible sell forever
   * and silently never exit the position.
   * Returns true when the row is in sync and should be checked normally.
   */
  private async reconcileRow(userId: number, row: TradeRow, wallet: { publicKey: PublicKey }): Promise<boolean> {
    const everyMs = 2 * 60_000;
    const last = this.reconciledAt.get(row.id) || 0;
    if (Date.now() - last < everyMs) return true;
    this.reconciledAt.set(row.id, Date.now());

    const conn = getConnection();
    const mint = new PublicKey(row.mint);
    const expected = this.remainingTokens(row);
    if (expected <= 0n) return true;
    try {
      const tp = await getTokenProgramForMint(conn, mint);
      const ata = deriveAta(wallet.publicKey, mint, tp);
      // A missing token account means a definite zero (the ATA is closed when
      // a bag is fully sold) — that is very different from an RPC hiccup.
      const acct = await conn.getAccountInfo(ata, 'confirmed'); // throws only on RPC failure
      let actual: bigint | null = null;
      if (acct === null) actual = 0n;
      else if (acct.data.length >= 72) actual = acct.data.readBigUInt64LE(64); // RawAccount.amount (SPL + Token-2022 share this layout)
      const verdict = holdingDivergence(expected, actual);
      if (verdict === 'ok' || verdict === 'unknown') return true;

      row.outOfSync = true;
      row.outOfSyncAt = Date.now();
      await this.store.putTrade(row).catch(() => undefined);
      const fmt = (n: bigint) => (Number(n) / 1e6).toLocaleString(undefined, { maximumFractionDigits: 2 });
      await notifyUser(
        userId,
        `🚨 <b>OUT OF SYNC</b> — $${row.symbol}: your wallet holds ${fmt(actual ?? 0n)} tokens but KACHIBOT's books still count ${fmt(expected)}.\n\n`
        + 'They left the wallet outside the bot (sold or moved elsewhere), so automatic exits are paused for this position.\n'
        + 'Open 📡 Positions → tap it to close the stale entry.',
      );
      return false;
    } catch {
      return true; // never let a reconcile hiccup block a real exit check
    }
  }

  /** close a position the wallet no longer holds (user's explicit choice) */
  async closeStalePosition(userId: number, rowId: string): Promise<TradeRow | null> {
    return this.chained(userId, async () => {
      const open = await this.store.listTrades(userId, 'open');
      const row = open.find((t) => t.id === rowId);
      if (!row || !row.outOfSync) return null;
      const remaining = this.remainingTokens(row);
      this.sellingRows.add(row.id);
      try {
        // nothing to sell on-chain: book the leftover as a manual exit at zero
        // so the trade card stays honest about what we cannot verify
        await this.recordSell(row, 'MANUAL', remaining, 0, null, 'closed by user — tokens had already left the wallet');
        await this.closeRowIfDone(row);
        return row;
      } finally {
        this.sellingRows.delete(row.id);
      }
    });
  }

  /**
   * Warn once when the trading wallet is running low, well before the next
   * watched buy is blocked for insufficient funds. Silent for users with no
   * wallet or no watchlist, and throttled so it can never spam.
   */
  private async checkLowBalance(doc: UserDoc): Promise<void> {
    const threshold = Number(doc.settings.lowBalanceWarnLamports);
    if (!Number.isFinite(threshold) || threshold <= 0) return;
    if (!doc.watched || doc.watched.length === 0) return;
    const now = Date.now();
    if (now - (this.balanceCheckedAt.get(doc.userId) || 0) < 5 * 60_000) return;
    this.balanceCheckedAt.set(doc.userId, now);

    const wallet = getWallet(doc);
    if (!wallet) return; // no wallet yet — the buy-time notice covers that
    const bal = await getConnection().getBalance(wallet.publicKey).catch(() => null);
    if (bal === null) return;
    if (bal >= threshold) return;
    if (now - (this.balanceWarnedAt.get(doc.userId) || 0) < 6 * 3_600_000) return;
    this.balanceWarnedAt.set(doc.userId, now);

    const size = resolveBuySize(doc, null);
    const perBuy = size.mode === 'pct' ? doc.settings.buyAmountLamports : size.value;
    const snipesLeft = perBuy > 0 ? Math.floor(bal / perBuy) : 0;
    await notifyUser(
      doc.userId,
      `⚠️ <b>LOW BALANCE</b> — your wallet holds ${(bal / 1e9).toFixed(4)} SOL.\n\n`
      + `At ${(perBuy / 1e9).toFixed(4)} SOL per copy that is about ${snipesLeft} more snipe${snipesLeft === 1 ? '' : 's'} — `
      + `a watched wallet can ape any second, so top up now to avoid ⛔ blocked buys.\n\n`
      + `Refill at /wallet (address in 💼 Wallet → 📥 Receive).`,
      { silent: true },
    );
  }

  private async checkThresholds(userId: number, row: TradeRow): Promise<void> {
    const remaining = this.remainingTokens(row);
    if (remaining <= 0n) return;
    const value = await this.liveValueLamports(row);
    if (value === null) {
      // price feed dead: sweep only when clearly un-sellable & old enough
      if (Date.now() - row.entryTime > 5 * 60_000 && this.sellingRows.size === 0) {
        const phase = await curvePhase(getConnection(), new PublicKey(row.mint)).catch(() => 'unknown' as const);
        if (phase === 'graduated') {
          // only call it a rug when BOTH venues are dry: Jupiter has no route
          // AND there is no PumpSwap pool. A Jupiter outage alone must never
          // zero out a healthy position.
          const probe = await quote(new PublicKey(row.mint), WRAPPED_SOL, remaining, 5000).catch(() => null);
          const pool = probe ? null : await findPumpSwapPool(getConnection(), new PublicKey(row.mint)).catch(() => null);
          if (!probe && !pool) {
            await this.recordSell(row, 'RUG', remaining, 0, null, 'post-graduation liquidity gone');
            await this.closeRowIfDone(row);
            await notifyUser(userId, `🧨 <b>RUG SWEEP</b> — $${row.symbol}: liquidity dried up. Closed at 0.`);
          }
        }
      }
      return;
    }

    const entryTokens = BigInt(row.entryTokenAmount);
    const basisPerToken = entryTokens > 0n ? row.spentLamports / Number(entryTokens) : 0;
    const basis = basisPerToken > 0 ? basisPerToken * Number(remaining) : row.spentLamports;
    if (basis <= 0) return;
    const mult = value / basis;

    // break-even stop: once a TP rung has banked profit, the remainder may
    // never turn into a loss — the stop moves up to its own entry price
    const beArmed = !!row.settingsAtEntry.breakEvenStop && breakEvenArmed(row.partialSells);
    const stopMult = beArmed ? 1 : 1 - row.settingsAtEntry.stopLossPct;
    if (mult <= stopMult) {
      await this.sellOpenPosition(userId, row.id, 'SL');
      return;
    }
    if (mult <= 0.12) {
      await this.sellOpenPosition(userId, row.id, 'RUG');
      return;
    }
    // target exits: when the user set a multiple or market-cap goal for this
    // watched wallet, that single target replaces the global TP ladder
    // hard time limit: never let a bag sit forever
    const maxHold = row.settingsAtEntry.maxHoldMs;
    if (maxHold && maxHold > 0 && Date.now() - row.entryTime >= maxHold) {
      await this.sellOpenPosition(userId, row.id, 'TIME');
      return;
    }

    // trailing stop: once armed, follow the peak down by the configured give-back
    const trailCfg: TrailingStopConfig | null = row.settingsAtEntry.trailing || null;
    if (trailCfg) {
      const prevPeak = this.peaks.get(row.id) ?? row.peakMultiple ?? 0;
      const peak = Math.max(prevPeak, mult);
      this.peaks.set(row.id, peak);
      if (peak > (row.peakMultiple ?? 0)) {
        row.peakMultiple = peak;
        await this.store.putTrade(row).catch(() => undefined);
      }
      const trigger = trailingExitMultiple(peak, trailCfg);
      if (trigger !== null && mult <= trigger) {
        await this.sellOpenPosition(userId, row.id, 'TRAIL');
        return;
      }
    }

    const exit = normalizeExit(row.settingsAtEntry.exit);
    if (exit.mode === 'mult' && exit.mult) {
      if (mult >= exit.mult) await this.sellOpenPosition(userId, row.id, 'TP', exit.mult);
      return; // an armed multiple target replaces the TP ladder
    }
    if (exit.mode === 'mcap' && exit.mcapUsd) {
      const solUsd = await getSolUsd().catch(() => null);
      const entryMcap = row.entryMcapLamports;
      if (solUsd && solUsd > 0 && entryMcap && entryMcap > 0) {
        // mcap scales with price: entry market cap x the current multiple
        const currentMcapLamports = entryMcap * mult;
        const targetLamports = (exit.mcapUsd / solUsd) * 1e9;
        if (currentMcapLamports >= targetLamports) await this.sellOpenPosition(userId, row.id, 'TP', null);
        return; // an armed mcap target replaces the TP ladder
      }
      // price feed / entry mcap unavailable this tick: fall back to the ladder
      // so the position is never left without an exit plan
    }

    // TP ladder (ascending rungs, one step per rung)
    for (const target of row.settingsAtEntry.tpMultiples) {
      const rungSold = row.partialSells.some((s) => s.reason === 'TP' && s.multiple >= target * 0.85);
      if (rungSold) continue;
      if (mult >= target) {
        await this.sellTpStepLocked(userId, row, target);
        return;
      }
    }
  }

  /**
   * Everything the live POSITION card shows: current value, PnL against cost,
   * and the market data behind it (price per token + market cap).
   * One pricing call, reused for value, price and mcap so they always agree.
   */
  async positionView(row: TradeRow): Promise<{
    live: number | null;
    math: PositionMath;
    pricePerToken: number | null;
    mcapLamports: number | null;
    entryPricePerToken: number | null;
  }> {
    const live = await this.liveValueLamports(row);
    const math = positionMath(row, live);
    const remaining = this.remainingTokens(row);
    const pricePerToken = live !== null && remaining > 0n ? live / Number(remaining) : null;
    const supply = await this.mintSupply(new PublicKey(row.mint)).catch(() => null);
    const mcapLamports = pricePerToken !== null && supply ? Math.floor(pricePerToken * supply) : null;
    return {
      live,
      math,
      pricePerToken,
      mcapLamports,
      entryPricePerToken: row.entryPriceLamports ?? null,
    };
  }

  /** value `amountRaw` tokens off the PumpSwap pool (constant product) */
  private async poolValueLamports(mint: PublicKey, amountRaw: bigint): Promise<number | null> {
    const conn = getConnection();
    const pool = await findPumpSwapPool(conn, mint);
    if (!pool) return null;
    const state = await (async () => {
      const { OnlinePumpAmmSdk } = await import('@pump-fun/pump-swap-sdk');
      return new OnlinePumpAmmSdk(conn).swapSolanaState(pool, mint); // user only shapes ATAs, price maths below is user-independent
    })();
    const base = Number(state.poolBaseAmount.toString());
    const quote = Number(state.poolQuoteAmount.toString());
    if (!Number.isFinite(base) || !Number.isFinite(quote) || base <= 0) return null;
    const pricePerToken = quote / base; // SOL lamports per raw token
    const amt = Number(amountRaw);
    if (!Number.isFinite(amt)) return null;
    // constant product: selling `amt` at the current marginal price (no fee haircut)
    return Math.floor(pricePerToken * amt * 0.97);
  }

  /** proceeds estimate (SOL lamports) for the remaining tokens of a row */
  async liveValueLamports(row: TradeRow): Promise<number | null> {
    const conn = getConnection();
    const mint = new PublicKey(row.mint);
    const remaining = this.remainingTokens(row);
    if (remaining <= 0n) return null;
    try {
      const st = await fetchCurve(conn, mint);
      if (st && isLiveCurve(st)) {
        const cx = await loadPricingCtx(st.curve);
        return Number(sellSolLamportsForTokenAmount(cx, new BN(remaining.toString())).toString());
      }
      const q = await quote(mint, WRAPPED_SOL, remaining, Math.max(100, Math.round(row.settingsAtEntry.slippagePct * 10_000))).catch(() => null);
      if (q && BigInt(q.outAmount) > 0n) return Number(BigInt(q.outAmount));
      // no Jupiter price (freshly graduated coin): value it off the PumpSwap
      // pool, otherwise TP / stop-loss / trailing could never trigger
      return await this.poolValueLamports(mint, remaining).catch(() => null);
    } catch {
      return null;
    }
  }

  /* ---------------------------- startup sweep ----------------------------- */

  /** mark crash-interrupted half-buys as failed (open rows with zero tokens) */
  async sweepInterrupted(): Promise<void> {
    try {
      const users = await this.store.listUsers();
      for (const u of users) {
        const open = await this.store.listTrades(u.userId, 'open');
        for (const row of open) {
          if (row.entryTokenAmount === '0') {
            row.status = 'failed';
            row.exitTime = Date.now();
            row.error = 'interrupted (bot restarted mid-buy) — no tokens were received';
            await this.store.putTrade(row);
          }
        }
      }
    } catch (e) {
      console.error('[trader] sweep failed:', (e as Error).message);
    }
  }

  /* =============================== helpers ================================ */

  private async tokenBalanceOf(owner: PublicKey, mint: PublicKey, retryMs = 0): Promise<bigint> {
    const conn = getConnection();
    const tp = await getTokenProgramForMint(conn, mint).catch(() => TOKEN_PROGRAM_ID);
    const ata = deriveAta(owner, mint, tp);
    const started = Date.now();
    for (;;) {
      const info = await conn.getTokenAccountBalance(ata, 'confirmed').catch(() => null);
      if (info?.value) return BigInt(info.value.amount);
      if (Date.now() - started >= retryMs) return 0n;
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  private async mintSupply(mint: PublicKey): Promise<number | null> {
    const info = await getConnection().getAccountInfo(mint, 'confirmed');
    if (!info) return null;
    return mintSupplyRaw(info.data);
  }

  private vtxInstructions(tx: VersionedTransaction): TransactionInstruction[] {
    const message = tx.message as unknown as {
      getAccountKeys(): { get(idx: number): PublicKey };
      instructions: Array<{ accountKeyIndexes: number[]; programIdIndex: number; data: string }>;
    };
    const keys = message.getAccountKeys();
    return message.instructions.map((i) => ({
      keys: i.accountKeyIndexes.map((idx) => ({ pubkey: keys.get(idx), isSigner: false, isWritable: false })),
      programId: keys.get(i.programIdIndex),
      data: Buffer.from(i.data, 'base64'),
    }));
  }

  /** sign & send a Jupiter-built v0 tx with blockhash-refresh retries */
  private async sendJupiterTx(wallet: Keypair, tx: VersionedTransaction): Promise<string> {
    const conn = getConnection();
    tx.sign([wallet]);
    let lastErr = 'unknown';
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true, preflightCommitment: 'confirmed', maxRetries: 2 });
        const outcome = await confirmSignature(conn, sig, 30_000);
        if (outcome === 'confirmed') return sig;
        if (outcome === 'landed-failed') throw new Error('swap landed but failed on-chain');
        lastErr = 'confirmation timeout';
      } catch (e) {
        lastErr = (e as Error).message;
      }
      if (!tx.message.addressTableLookups.length) {
        const bh = await conn.getLatestBlockhash('confirmed').catch(() => null);
        if (bh) {
          try {
            tx = toVersioned(wallet.publicKey, this.vtxInstructions(tx), bh.blockhash);
            tx.sign([wallet]);
          } catch {
            /* keep the old tx when rebuilding fails */
          }
        }
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error(`jupiter send failed: ${lastErr}`);
  }

  /** simulate a v0 tx before funds move (honeypot check on the jupiter path) */
  private async simulateVersioned(tx: VersionedTransaction): Promise<boolean> {
    try {
      const conn = getConnection();
      tx.signatures = tx.signatures.map(() => new Uint8Array(64)); // dummy sigs, sigVerify:false
      const sim = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' });
      return !sim.value.err;
    } catch {
      return true; // sim infra hiccup must not veto a real trade
    }
  }
}

export const trader = new Trader();
