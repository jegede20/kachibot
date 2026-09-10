/**
 * KACHIBOT — transaction message decoding (shared, pure).
 *
 * The RPC returns TWO message shapes and the watcher must handle both:
 *  - legacy:      message.accountKeys (full list) + message.instructions (decoded)
 *  - versioned:   message.staticAccountKeys + message.compiledInstructions
 *                 (+ meta.loadedAddresses). compiledInstruction indices address
 *                 the FULL account list: static, then loaded writable, then
 *                 loaded readonly. Inner (CPI) instructions always carry the
 *                 same full-list indices under meta.innerInstructions.
 *
 * decodeMessageView() normalizes either shape into { pkeys, ixs } so callers
 * never touch the wire format directly.
 */
import type { Connection } from '@solana/web3.js';

export type RawTx = NonNullable<Awaited<ReturnType<Connection['getTransaction']>>>;

export interface FlatIx {
  programIdIndex: number;
  accounts: number[];
  data: string;
}

export interface TxView {
  /** full ordered account-key list (static + loaded) */
  pkeys: string[];
  /** top-level instructions (decoded for both message versions) */
  top: FlatIx[];
  /** inner (CPI) instructions from meta, flattened */
  inner: FlatIx[];
}

const toStr = (k: unknown): string => (typeof k === 'string' ? k : ((k as { toBase58?: () => string }).toBase58?.() ?? String(k)));

export function decodeMessageView(tx: RawTx): TxView | null {
  const m = tx.transaction.message as unknown as {
    accountKeys?: Array<{ pubkey: string } | string>;
    instructions?: FlatIx[];
    staticAccountKeys?: unknown[];
    compiledInstructions?: Array<{ programIdIndex: number; accountIndexes: number[]; data: string }>;
  };
  const metaAny = tx.meta as unknown as {
    loadedAddresses?: { writable: unknown[]; readonly: unknown[] };
    innerInstructions?: Array<{ instructions: FlatIx[] }>;
  };
  const loadedRaw = metaAny?.loadedAddresses || { writable: [], readonly: [] };
  const loaded = {
    writable: loadedRaw.writable.map(toStr),
    readonly: loadedRaw.readonly.map(toStr),
  };

  let pkeys: string[];
  let top: FlatIx[];
  if (Array.isArray(m.accountKeys) && m.accountKeys.length) {
    // legacy shape
    pkeys = m.accountKeys.map((k) => (typeof k === 'string' ? k : k.pubkey));
    top = (m.instructions || []).map((ix) => ({
      programIdIndex: ix.programIdIndex,
      accounts: ix.accounts,
      data: ix.data,
    }));
  } else {
    // versioned (v0) shape
    pkeys = [...(m.staticAccountKeys || []).map(toStr), ...loaded.writable, ...loaded.readonly];
    top = (m.compiledInstructions || []).map((ci) => ({
      programIdIndex: ci.programIdIndex,
      accounts: ci.accountIndexes || [],
      data: ci.data,
    }));
  }
  const inner = (metaAny?.innerInstructions || []).flatMap((x) => x.instructions || []);
  return { pkeys, top, inner };
}

/** all instructions (top + inner) — the order matches RPC log order */
export function allIxs(view: TxView): FlatIx[] {
  return [...view.top, ...view.inner];
}

/** every program id invoked in the tx (by account position) */
export function programsOf(view: TxView): Set<string> {
  const s = new Set<string>();
  for (const ix of allIxs(view)) {
    const p = view.pkeys[ix.programIdIndex];
    if (p) s.add(p);
  }
  return s;
}

/**
 * Known DEX/aggregator programs (mainnet). Used to recognize "wallet swapped
 * on an open market" — i.e. buys/sells that happen OFF the pump bonding curve
 * (graduated coins traded on PumpSwap / Raydium / Meteora / Orca / Jupiter).
 */
export const DEX_SWAP_PROGS = new Set<string>([
  'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', // Raydium AMM v4
  'CPMMoo8L3F4NbTegBCKVNunggL7H1vpd5K25c9p2m', // Raydium CPMM
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', // Raydium CLMM
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // PumpSwap AMM
  'LBUZKhRxPF3XUpBCjp4YzDCgHbeiH4Jx2sM5vM6n6gB', // Meteora DLMM
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', // Orca Whirlpools
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', // Jupiter v6
]);

/** minimum SOL moved by the watched wallet to count as a swap (lamports) */
export const SWAP_MIN_SOL_LAMPORTS = 200_000; // 0.0002 SOL

export const WSOL_MINT = 'So11111111111111111111111111111111111111112';

/** how old a signature may be at prime time and still be analyzed (ms) */
export const PRIME_STALE_MS = 120_000;

/**
 * Decide the side of a pump trade event.
 * - If the classified pump instruction contains the watched wallet (traderPos>=0)
 *   the instruction itself is authoritative (ix classification + log names).
 * - Otherwise the tx is bundled/multi-party (a router or another trader owns the
 *   pump instruction): trust the WATCHED WALLET's own token delta sign instead,
 *   so a sell by the ape is never mirrored as a buy (and vice versa).
 */
export function determineSide(
  ixSide: 'buy' | 'sell',
  logBuy: boolean,
  logSell: boolean,
  traderPos: number,
  watchedTokenDeltaSign: number,
): 'buy' | 'sell' {
  if (traderPos < 0 && watchedTokenDeltaSign !== 0) {
    return watchedTokenDeltaSign > 0 ? 'buy' : 'sell';
  }
  return ixSide === 'sell' ? 'sell' : (logSell && !logBuy ? 'sell' : 'buy');
}

export interface SwapSignal {
  side: 'buy' | 'sell';
  mint: string;
  tokenDeltaRaw: bigint | null;
  /** best-effort SOL the wallet spent (buy) or received (sell) */
  solMovedLamports: number | null;
}

/** "money" mints: tokens apes pay with (bought/sold against) */
export const MONEY_MINTS = new Set<string>([
  WSOL_MINT,
  'So11111111111111111111111111111111111111112', // SOL (token form)
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMxx6P2sM4xBZ1gHVPSJvUvYwj2RqFyXsV4xV9yvB', // USDT (if it appears)
]);

/** raw token amount normalized to a ~lamport scale (9-decimals equivalent) */
const norm = (raw: bigint, decimals?: number): bigint => {
  const d = typeof decimals === 'number' && decimals >= 0 ? decimals : 6;
  if (d === 9) return raw;
  if (d < 9) return raw * 10n ** BigInt(9 - d);
  return raw / 10n ** BigInt(d - 9);
};

/**
 * Detect an off-curve swap by the watched wallet from balance deltas:
 * a non-money mint the wallet gained while its money (SOL / wSOL / USDC /
 * USDT) dropped => buy; the reverse => sell; inside a tx that invoked a
 * known DEX program. Pure — no network, no store.
 */
export function detectSwapSignals(
  view: TxView,
  meta: RawTx['meta'],
  watchedAddress: string,
): SwapSignal[] {
  if (!meta || meta.err) return [];
  const progs = programsOf(view);
  if (![...progs].some((p) => DEX_SWAP_PROGS.has(p))) return [];
  const walletIdx = view.pkeys.indexOf(watchedAddress);
  if (walletIdx < 0) return [];

  // SOL balance delta of the watched wallet
  const preBal = meta.preBalances && meta.preBalances[walletIdx];
  const postBal = meta.postBalances && meta.postBalances[walletIdx];
  const solDelta = preBal !== undefined && postBal !== undefined ? postBal - preBal : 0;

  // token deltas of the watched wallet (raw + normalized to ~lamport scale)
  const preTok = (meta.preTokenBalances || []).filter((b) => b && b.owner && b.mint);
  const postTok = (meta.postTokenBalances || []).filter((b) => b && b.owner && b.mint);
  const byMint = new Map<string, { raw: bigint; normVal: bigint }>();
  for (const b of postTok) {
    if (b.owner !== watchedAddress || !b.mint) continue;
    const pre = preTok.find((p) => p.accountIndex === b.accountIndex && p.owner === watchedAddress);
    const cur = BigInt((b.uiTokenAmount && b.uiTokenAmount.amount) || '0');
    const prev = pre ? BigInt((pre.uiTokenAmount && pre.uiTokenAmount.amount) || '0') : 0n;
    const d = cur - prev;
    if (d === 0n) continue;
    const n = norm(d, b.uiTokenAmount && b.uiTokenAmount.decimals);
    const e = byMint.get(b.mint) || { raw: 0n, normVal: 0n };
    e.raw += d; e.normVal += n;
    byMint.set(b.mint, e);
  }

  // total money moved (SOL balance + money tokens), normalized scale
  let moneyDelta = BigInt(solDelta); // SOL is already 9-decimals
  let solMoved = BigInt(Math.abs(solDelta));
  const hasSolMove = Math.abs(solDelta) >= SWAP_MIN_SOL_LAMPORTS;
  for (const [mint, e] of byMint) {
    if (!MONEY_MINTS.has(mint)) continue;
    moneyDelta += e.normVal;
    if (!hasSolMove) solMoved += e.normVal < 0n ? -e.normVal : e.normVal;
  }
  if (moneyDelta === 0n) return [];
  if (moneyDelta < 0n && -moneyDelta < BigInt(SWAP_MIN_SOL_LAMPORTS)) return [];
  if (moneyDelta > 0n && moneyDelta < BigInt(SWAP_MIN_SOL_LAMPORTS)) return [];

  const out: SwapSignal[] = [];
  for (const [mint, e] of byMint) {
    if (MONEY_MINTS.has(mint)) continue;
    if (e.raw > 0n && moneyDelta < 0n) {
      out.push({
        side: 'buy',
        mint,
        tokenDeltaRaw: e.raw,
        // only SOL-funded buys carry a true SOL spend (stablecoin spends
        // can't be sized without a price feed)
        solMovedLamports: hasSolMove ? Number(solMoved) : null,
      });
    } else if (e.raw < 0n && moneyDelta > 0n) {
      out.push({ side: 'sell', mint, tokenDeltaRaw: -e.raw, solMovedLamports: null });
    }
  }
  return out;
}
