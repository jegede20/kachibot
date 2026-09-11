/**
 * KACHIBOT — PumpSwap (pump.fun AMM) direct route.
 *
 * Why this exists: when a pump.fun coin graduates, its liquidity migrates to
 * PumpSwap. For a freshly migrated pool Jupiter often has no route yet, which
 * made every copy of a just-graduated coin fail with "jupiter: no route found".
 * This module swaps directly against the pool as a fallback (and as a route in
 * its own right), on both the buy and the sell side — so a position opened
 * here can always be closed here too.
 */
import { Connection, PublicKey, TransactionInstruction } from '@solana/web3.js';
import BN from 'bn.js';
import {
  OnlinePumpAmmSdk,
  PumpAmmSdk,
  canonicalPumpPoolPda,
  buyQuoteInput as priceBuyQuote,
  sellBaseInput as priceSellBase,
} from '@pump-fun/pump-swap-sdk';
import { WRAPPED_SOL } from './pump';

let onlineAmm: OnlinePumpAmmSdk | null = null;
function online(conn: Connection): OnlinePumpAmmSdk {
  if (!onlineAmm) onlineAmm = new OnlinePumpAmmSdk(conn);
  return onlineAmm;
}
const offlineAmm = new PumpAmmSdk();

export interface PumpSwapPlan {
  ixs: TransactionInstruction[];
  /** pool reserves, for market-cap and valuation maths */
  poolBase: string;
  poolQuote: string;
  /** estimated tokens out (buy) — actual amount is measured after the swap */
  tokenAmountRaw: bigint;
  solLamports: bigint;
  pool: string;
}

/** the canonical PumpSwap pool for a mint, or null when it has none */
export async function findPumpSwapPool(conn: Connection, mint: PublicKey): Promise<PublicKey | null> {
  const candidates: PublicKey[] = [];
  try {
    candidates.push(canonicalPumpPoolPda(mint, WRAPPED_SOL));
    const def = canonicalPumpPoolPda(mint);
    if (!candidates.some((c) => c.equals(def))) candidates.push(def);
  } catch {
    return null;
  }
  for (const pool of candidates) {
    try {
      const info = await conn.getAccountInfo(pool, 'confirmed');
      if (info && info.data.length > 0) return pool;
    } catch {
      /* try next */
    }
  }
  return null;
}

/** constant-product market cap estimate in SOL lamports (pre-trade) */
export function poolMcapLamports(state: { poolBaseAmount: BN; poolQuoteAmount: BN }, supply: number | null): number | null {
  if (!supply || supply <= 0) return null;
  const base = Number(state.poolBaseAmount.toString());
  const quote = Number(state.poolQuoteAmount.toString());
  if (!Number.isFinite(base) || !Number.isFinite(quote) || base <= 0) return null;
  return Math.floor((quote / base) * supply);
}

/** BUY: spend `budgetLamports` of SOL for `mint` through its PumpSwap pool */
export async function buildPumpSwapBuy(
  conn: Connection,
  opts: { mint: PublicKey; buyer: PublicKey; budgetLamports: number; slippagePct: number },
): Promise<PumpSwapPlan> {
  if (opts.budgetLamports <= 0) throw new Error('budget must be positive');
  const pool = await findPumpSwapPool(conn, opts.mint);
  if (!pool) throw new Error('no PumpSwap pool for this token (liquidity not migrated)');
  const state = await online(conn).swapSolanaState(pool, opts.buyer);
  const quote = new BN(opts.budgetLamports);
  const slippage = Math.min(0.9, Math.max(0.001, opts.slippagePct));

  let est = 0n;
  try {
    const priced = priceBuyQuote({
      quote,
      slippage,
      baseReserve: state.poolBaseAmount,
      quoteReserve: state.poolQuoteAmount,
      virtualQuoteReserves: (state.pool as { virtualQuoteReserves?: BN }).virtualQuoteReserves,
      globalConfig: state.globalConfig,
      baseMintAccount: state.baseMintAccount,
      baseMint: state.baseMint,
      coinCreator: (state.pool as { coinCreator: PublicKey }).coinCreator,
      creator: (state.pool as { creator: PublicKey }).creator,
      feeConfig: state.feeConfig,
      quoteMint: (state.pool as { quoteMint: PublicKey }).quoteMint,
      isMayhemMode: (state.pool as { isMayhemMode?: boolean }).isMayhemMode,
      creatorFeeBps: (state.pool as { creatorFeeBps?: BN }).creatorFeeBps,
    } as Parameters<typeof priceBuyQuote>[0]);
    est = BigInt(priced.base.toString());
  } catch {
    est = 0n; // estimate only — the real amount is measured after the swap
  }

  const ixs = await offlineAmm.buyQuoteInput(state, quote, slippage);
  return {
    ixs,
    tokenAmountRaw: est,
    solLamports: BigInt(opts.budgetLamports),
    pool: pool.toBase58(),
    poolBase: state.poolBaseAmount.toString(),
    poolQuote: state.poolQuoteAmount.toString(),
  };
}

/** SELL: swap `tokenAmountRaw` of `mint` back to SOL through its PumpSwap pool */
export async function buildPumpSwapSell(
  conn: Connection,
  opts: { mint: PublicKey; seller: PublicKey; tokenAmountRaw: bigint; slippagePct: number },
): Promise<{ ixs: TransactionInstruction[]; solLamports: bigint; pool: string }> {
  if (opts.tokenAmountRaw <= 0n) throw new Error('nothing to sell');
  const pool = await findPumpSwapPool(conn, opts.mint);
  if (!pool) throw new Error('no PumpSwap pool for this token (cannot sell)');
  const state = await online(conn).swapSolanaState(pool, opts.seller);
  const base = new BN(opts.tokenAmountRaw.toString());
  const slippage = Math.min(0.9, Math.max(0.001, opts.slippagePct));

  let est = 0n;
  try {
    const priced = priceSellBase({
      base,
      slippage,
      baseReserve: state.poolBaseAmount,
      quoteReserve: state.poolQuoteAmount,
      virtualQuoteReserves: (state.pool as { virtualQuoteReserves?: BN }).virtualQuoteReserves,
      globalConfig: state.globalConfig,
      baseMintAccount: state.baseMintAccount,
      baseMint: state.baseMint,
      coinCreator: (state.pool as { coinCreator: PublicKey }).coinCreator,
      creator: (state.pool as { creator: PublicKey }).creator,
      feeConfig: state.feeConfig,
      quoteMint: (state.pool as { quoteMint: PublicKey }).quoteMint,
      isMayhemMode: (state.pool as { isMayhemMode?: boolean }).isMayhemMode,
      creatorFeeBps: (state.pool as { creatorFeeBps?: BN }).creatorFeeBps,
    } as Parameters<typeof priceSellBase>[0]);
    est = BigInt(String((priced as { uiQuote?: { toString(): string } }).uiQuote ?? 0));
  } catch {
    est = 0n;
  }

  const ixs = await offlineAmm.sellBaseInput(state, base, slippage);
  return { ixs, solLamports: est, pool: pool.toBase58() };
}
