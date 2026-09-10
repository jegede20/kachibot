/**
 * KACHIBOT — trade execution core.
 * Turns watch signals / user commands into executed, tracked, scorecard-able
 * trades. Enforces every cap & check before funds move and never drops a
 * trade silently: failures end in a 'failed' trade row + notification.
 */
import { Keypair, PublicKey, VersionedTransaction, TransactionInstruction } from '@solana/web3.js';
import BN from 'bn.js';
import { getStore, Store } from './db';
import { UserDoc, TradeRow, ExitReason, dayKey, resolveExit, normalizeExit, exitSellFraction, describeExit } from './types';
import {
  curvePhase, fetchCurve, loadPricingCtx, sellSolLamportsForTokenAmount,
  buildCurveBuy, buildCurveSell, mcapSolLamports, priceSolPerTokenLamports,
  isLiveCurve, getTokenProgramForMint, deriveAta, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, WRAPPED_SOL,
} from './chain/pump';
import { buildJupiterBuy, buildJupiterSell, quote } from './chain/jupiter';
import { getConnection } from './chain/conn';
import { getSolUsd } from './chain/price';
import { simulate, sendTrade, confirmSignature, toVersioned } from './chain/send';
import { getTokenMeta, rugFlags, describeRugFlags } from './chain/meta';
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

function computeBudget(s: UserDoc['settings'], watchedSpend: number | null): number {
  let budget: number;
  if (s.buyMode === 'pct' && watchedSpend !== null && watchedSpend > 0) {
    budget = Math.floor(watchedSpend * s.buyPctOfSpend);
  } else {
    budget = s.buyAmountLamports;
  }
  return Math.max(0, Math.min(budget, s.perTradeCapLamports));
}

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

  async onWatchSignal(ev: WatchSignal): Promise<void> {
    await this.chained(ev.userId, async () => {
      const doc = await this.store.getUser(ev.userId);
      if (!doc.watched.some((w) => w.id === ev.watchId)) return; // watch removed meanwhile
      if (ev.side === 'buy') await this.handleWatchedBuy(doc, ev);
      else await this.handleWatchedSell(doc, ev);
    });
  }

  private async handleWatchedBuy(doc: UserDoc, ev: WatchSignal): Promise<void> {
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

    const phase = await curvePhase(conn, new PublicKey(ev.mint)).catch(() => 'unknown' as const);
    if (phase === 'unknown' || phase === 'none') {
      if (s.alerts.activity) {
        await notifyUser(doc.userId, `👁 <b>RADAR</b> — ${escTag(ev.watchedLabel)} bought ${coinTag(ev.mintName, ev.mintSymbol, ev.mint)} — not a live pump token (already graduated or delisted). Nothing copied.`);
      }
      return;
    }

    const budget = computeBudget(s, ev.spendLamports);
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
    const matches = open.filter((t) => t.mint === ev.mint && !this.sellingRows.has(t.id));
    if (!matches.length) return;

    // the exit rule of the watch that triggered this (override, else global)
    const watch = ev.watchId ? doc.watched.find((w) => w.id === ev.watchId) || null : null;
    const exit = resolveExit(doc, watch);
    const soldTxt = solExact(ev.spendLamports);
    const what = coinTag(ev.mintName, ev.mintSymbol, ev.mint);
    const frac = exitSellFraction(exit);

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
      await notifyUser(
        doc.userId,
        `👻 <b>COPY-SELL TRIGGERED</b> — ${escTag(ev.watchedLabel)} dumped ${what}${soldTxt ? ` (≈ ${soldTxt})` : ''}. Selling ${size} of ${matches.length} open position${matches.length > 1 ? 's' : ''}.`,
      );
    }
    for (const t of matches) {
      const job = frac >= 0.999
        ? this.sellOpenPosition(doc.userId, t.id, 'COPY_SELL')
        : this.sellFraction(doc.userId, t.id, frac, 'COPY_SELL');
      await job.catch((e) => console.error('[trader] copy-sell failed:', (e as Error).message));
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
      settingsAtEntry: {
        exit: resolveExit(doc, doc.watched.find((w) => w.id === ev.watchId) || null),
        tpMultiples: [...s.tpMultiples],
        stopLossPct: s.stopLossPct,
        copySell: s.copySell,
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
        const j = await buildJupiterBuy(conn, { mint, buyer: wallet.publicKey, budgetLamports: budget, slippagePct: doc.settings.slippagePct });
        const supply = await this.mintSupply(mint);
        row.entryMcapLamports = supply !== null && j.plan.tokenAmountRaw > 0n
          ? Math.floor((Number(j.plan.solLamports) * supply) / Number(j.plan.tokenAmountRaw))
          : null;
        if (doc.settings.honeypotCheck) {
          const okSim = await this.simulateVersioned(j.tx);
          if (!okSim) throw new DodgedError('jupiter swap simulation failed — no safe route');
        }
        const sig = await this.sendJupiterTx(wallet, j.tx);
        row.txSignatures.push(sig);
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
   * Execute one sell order for `tokenAmountRaw` of `row.mint`, returning
   * realized SOL lamports (measured from the wallet balance delta).
   */
  private async execSell(
    doc: UserDoc,
    wallet: Keypair,
    row: TradeRow,
    tokenAmountRaw: bigint,
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
        slippagePct: row.settingsAtEntry.slippagePct,
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
        slippagePct: row.settingsAtEntry.slippagePct,
      });
      if (!j) throw new Error('no sell route — liquidity gone');
      await this.sendJupiterTx(wallet, j.tx);
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

  private async checkOpenPositions(): Promise<void> {
    let users: UserDoc[] = [];
    try {
      users = await this.store.listUsers();
    } catch {
      users = [...this.knownUsers].map((u) => ({ userId: u } as UserDoc));
    }
    for (const doc of users) {
      const userId = doc.userId;
      try {
        const open = await this.store.listTrades(userId, 'open');
        for (const row of open) {
          if (this.sellingRows.has(row.id)) continue;
          await this.chained(userId, () => this.checkThresholds(userId, row));
        }
      } catch (e) {
        console.error('[trader] checker:', (e as Error).message);
      }
    }
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
          const probe = await quote(new PublicKey(row.mint), WRAPPED_SOL, remaining, 5000).catch(() => null);
          if (!probe) {
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

    if (mult <= 1 - row.settingsAtEntry.stopLossPct) {
      await this.sellOpenPosition(userId, row.id, 'SL');
      return;
    }
    if (mult <= 0.12) {
      await this.sellOpenPosition(userId, row.id, 'RUG');
      return;
    }
    // target exits: when the user set a multiple or market-cap goal for this
    // watched wallet, that single target replaces the global TP ladder
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
      const q = await quote(mint, WRAPPED_SOL, remaining, Math.max(100, Math.round(row.settingsAtEntry.slippagePct * 10_000)));
      if (!q) return null;
      return Number(BigInt(q.outAmount));
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
    if (!info || info.data.length < 44) return null;
    return Number(BigInt(`0x${info.data.subarray(36, 44).toString('hex')}`));
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
