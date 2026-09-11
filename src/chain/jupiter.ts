/**
 * KACHIBOT — Jupiter Aggregator API (post-graduation swaps + live prices).
 * Free-tier friendly: the public quote API needs no key (optional JUPITER_API_KEY
 * header supported when you have one).
 */
import { Connection, PublicKey, VersionedTransaction, TransactionInstruction } from '@solana/web3.js';
import { JUPITER_QUOTE_API, JUPITER_API_KEY } from '../config';
import { deriveAta, ataCreateIx, getTokenProgramForMint, WRAPPED_SOL } from './pump';
import { getConnection, RpcError } from './conn';

const HEADERS: Record<string, string> = JUPITER_API_KEY
  ? { 'x-api-key': JUPITER_API_KEY, 'content-type': 'application/json' }
  : { 'content-type': 'application/json' };

async function jupiterFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20_000);
  try {
    const res = await fetch(`${JUPITER_QUOTE_API}${path}`, { ...init, headers: HEADERS, signal: ctl.signal });
    if (!res.ok) throw new Error(`Jupiter HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return (await res.json()) as T;
  } catch (e) {
    if (e instanceof RpcError) throw e;
    throw new Error(`jupiter request failed: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    clearTimeout(timer);
  }
}

export interface JupiterQuote {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: 'ExactIn' | 'ExactOut';
  slippageBps: number;
  /** v1 returns this as a decimal string */
  priceImpactPct: number | string;
  routePlan: Array<{ swapInfo: { ammKey: string; label?: string; feePct?: number } }>;
  computedAmount?: string;
}

/**
 * True when a Jupiter failure means "this venue can't serve the swap right now"
 * (no route / API down / rate limited) — i.e. a fallback route is worth trying,
 * as opposed to a bad parameter or an on-chain failure.
 */
export function noRouteError(msg: string): boolean {
  return /no route|no liquidity|request failed|HTTP|timeout|aborted/i.test(msg);
}

/** Quote swapping `amountRaw` of fromMint into toMint. */
export async function quote(
  fromMint: PublicKey,
  toMint: PublicKey,
  amountRaw: bigint,
  slippageBps: number,
  swapMode: 'ExactIn' | 'ExactOut' = 'ExactIn',
): Promise<JupiterQuote | null> {
  const params = new URLSearchParams({
    inputMint: fromMint.toBase58(),
    outputMint: toMint.toBase58(),
    amount: amountRaw.toString(),
    slippageBps: String(Math.max(10, Math.min(5000, Math.round(slippageBps)))),
    swapMode,
    restrictIntermediateTokens: 'true',
  });
  try {
    return await jupiterFetch<JupiterQuote>(`/quote?${params}`);
  } catch (e) {
    console.warn('[jupiter] quote failed:', (e as Error).message);
    return null;
  }
}

interface SwapTxResponse {
  swapTransaction: string;
  lastValidBlockHeight?: number;
  prioritizationFeeLamports?: number;
}

/** Request the unsigned swap tx for a quoteResponse payload. */
async function requestSwapTx(user: PublicKey, quoteResponse: JupiterQuote): Promise<VersionedTransaction> {
  const body = {
    quoteResponse,
    userPublicKey: user.toBase58(),
    wrapAndUnwrapSol: true,
    dynamicComputeUnitLimit: true,
    prioritizationFeeLamports: { autoMultiplier: 1 },
  };
  const res = await jupiterFetch<SwapTxResponse>('/swap', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return VersionedTransaction.deserialize(Buffer.from(res.swapTransaction, 'base64'));
}

export interface PostGradPlan {
  ixs: TransactionInstruction[];
  tokenAmountRaw: bigint;
  solLamports: bigint;
  priceImpactPct: number;
  routeLabel: string;
}

async function ensureOutputAta(conn: Connection, payer: PublicKey, outputMint: PublicKey): Promise<TransactionInstruction[]> {
  const tp = await getTokenProgramForMint(conn, outputMint);
  const ata = deriveAta(payer, outputMint, tp);
  const info = await conn.getAccountInfo(ata, 'confirmed');
  if (info && info.owner.equals(tp) && info.data.length > 0) return [];
  return [ataCreateIx(payer, payer, outputMint, tp)];
}

/**
 * Post-graduation BUY of `mint`: swap budgetLamports SOL -> tokens through Jupiter.
 */
export async function buildJupiterBuy(
  conn: Connection,
  opts: { mint: PublicKey; buyer: PublicKey; budgetLamports: number; slippagePct: number },
): Promise<{ plan: PostGradPlan; tx: VersionedTransaction }> {
  if (opts.budgetLamports <= 0) throw new Error('budget must be positive');
  const q = await quote(WRAPPED_SOL, opts.mint, BigInt(opts.budgetLamports), opts.slippagePct * 10_000);
  if (!q) throw new Error('jupiter: no route found for this token (no liquidity)');
  const tx = await requestSwapTx(opts.buyer, q);
  const preIxs = await ensureOutputAta(conn, opts.buyer, opts.mint);
  const plan: PostGradPlan = {
    ixs: preIxs,
    tokenAmountRaw: BigInt(q.outAmount),
    solLamports: BigInt(q.inAmount),
    priceImpactPct: Number(q.priceImpactPct || 0),
    routeLabel: (q.routePlan?.[0]?.swapInfo?.label) || 'dex',
  };
  return { plan, tx };
}

/**
 * Post-graduation SELL of `mint`: swap tokens -> SOL through Jupiter.
 * Returns null when the route has no liquidity (e.g. token fully rugged).
 */
export async function buildJupiterSell(
  conn: Connection,
  opts: { mint: PublicKey; seller: PublicKey; tokenAmountRaw: bigint; slippagePct: number },
): Promise<{ plan: PostGradPlan; tx: VersionedTransaction } | null> {
  if (opts.tokenAmountRaw <= 0n) return null;
  const q = await quote(opts.mint, WRAPPED_SOL, opts.tokenAmountRaw, opts.slippagePct * 10_000);
  if (!q || BigInt(q.outAmount) <= 0n) return null;
  const tx = await requestSwapTx(opts.seller, q);
  const plan: PostGradPlan = {
    ixs: [],
    tokenAmountRaw: BigInt(q.inAmount),
    solLamports: BigInt(q.outAmount),
    priceImpactPct: Number(q.priceImpactPct || 0),
    routeLabel: (q.routePlan?.[0]?.swapInfo?.label) || 'dex',
  };
  return { plan, tx };
}

/** Live token price in SOL lamports per single raw token unit (via a 1-unit quote). */
export async function solPricePerRawToken(conn: Connection, mint: PublicKey): Promise<number | null> {
  // quote 1,000,000 raw tokens (typical 6-decimals) -> SOL
  const q = await quote(mint, WRAPPED_SOL, 1_000_000n, 300);
  if (!q || BigInt(q.outAmount) <= 0n) return null;
  return Number(BigInt(q.outAmount)) / 1_000_000;
}

/** SOL lamports liquid per `amountRaw` tokens right now (post-grad liquidity probe). */
export async function sellableSolLamports(mint: PublicKey, amountRaw: bigint): Promise<number | null> {
  const q = await quote(mint, WRAPPED_SOL, amountRaw, 5000);
  if (!q) return null;
  return Number(BigInt(q.outAmount));
}

export function getSolConnection(): Connection {
  return getConnection();
}
