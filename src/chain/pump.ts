/**
 * KACHIBOT — pump.fun bonding-curve integration (pre-graduation trades).
 *
 * IMPORTANT (2026-09): the shipped pump.fun anchor IDL on mainnet uses a
 * discriminator scheme that no longer matches the @pump-fun/pump-sdk IDL
 * (verified against live on-chain data). Detection is therefore driven by an
 * EMPIRICAL table captured from live mainnet transactions (see
 * test/fixtures/live/*.json for ground truth), and trade execution uses
 * LIVE TEMPLATE COPY: the exact pump-program instruction (account vector +
 * payload) of a recent same-coin trade observed on-chain, with the trader
 * account + its token ATA swapped for ours and the leading u64 amounts
 * scaled linearly. Every execution is SIMULATION-GATED before broadcast.
 */
import {
  Connection,
  PublicKey,
  TransactionInstruction,
  AccountInfo,
} from '@solana/web3.js';
import BN from 'bn.js';
import {
  PUMP_PROGRAM_ID,
  PUMP_AMM_PROGRAM_ID,
  PUMP_SDK,
  OnlinePumpSdk,
  bondingCurvePda,
  getBuyTokenAmountFromSolAmount,
  getBuySolAmountFromTokenAmount,
  getSellSolAmountFromTokenAmount,
  bondingCurveMarketCap,
  type BondingCurve,
  type Global,
  type FeeConfig,
} from '@pump-fun/pump-sdk';
import { getConnection, RpcError } from './conn';

export const PUMP_PROG = PUMP_PROGRAM_ID;
export const PUMP_AMM_PROG = PUMP_AMM_PROGRAM_ID;

export const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
export const ATA_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
export const WRAPPED_SOL = new PublicKey('So11111111111111111111111111111111111111112');
export const SYSTEM_PROGRAM_ID = new PublicKey('11111111111111111111111111111111');
export const PUMP_FEE_PROGRAM_ID = new PublicKey('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ');

/* --------------- live empirical instruction table (2026-09 mainnet) ------ */

/* --------------- live empirical instruction table (2026-09 mainnet) ------ */

export interface PumpIxSig {
  name: string;
  side: 'buy' | 'sell';
  /** primary u64 arg semantics — for copy-scaled execution both u64s scale linearly */
  qtyKind: 'tokenAmount' | 'quoteAmount';
  variant: string;
}

/**
 * discLE -> signature. Captured from live mainnet txs (log instruction names
 * paired 1:1 with program ix data in test/fixtures/live/*.json). Several
 * protocol generations coexist; duplicates map to the same semantic.
 */
const LIVE_IX: Array<{ disc: string; name: string; side: 'buy' | 'sell'; qtyKind: 'tokenAmount' | 'quoteAmount'; variant: string }> = [
  // modern (v2-era) instruction set — dominant on current mainnet
  { disc: '12708669002580268032', name: 'Buy', side: 'buy', qtyKind: 'tokenAmount', variant: 'modern' },
  { disc: '1260931053904032798', name: 'BuyV2', side: 'buy', qtyKind: 'tokenAmount', variant: 'modern' },
  { disc: '1568031281755767512', name: 'BuyExactQuoteInV2', side: 'buy', qtyKind: 'quoteAmount', variant: 'modern' },
  { disc: '10514123444410991142', name: 'BuyExactQuoteInV2', side: 'buy', qtyKind: 'quoteAmount', variant: 'modern' },
  { disc: '15885439065179159614', name: 'BuyExactSolIn', side: 'buy', qtyKind: 'quoteAmount', variant: 'legacy' },
  { disc: '1053231840573661928', name: 'BuyExactSolIn', side: 'buy', qtyKind: 'quoteAmount', variant: 'legacy' },
  { disc: '1092200152373300619', name: 'Buy', side: 'buy', qtyKind: 'tokenAmount', variant: 'legacy' },
  { disc: '1020142558335372683', name: 'Buy', side: 'buy', qtyKind: 'tokenAmount', variant: 'legacy' },
  { disc: '4631303335463105766', name: 'Sell', side: 'sell', qtyKind: 'tokenAmount', variant: 'modern' },
  { disc: '14677890340627919065', name: 'Sell', side: 'sell', qtyKind: 'tokenAmount', variant: 'legacy' },
  { disc: '6807051329997820210', name: 'Sell', side: 'sell', qtyKind: 'tokenAmount', variant: 'legacy' },
  { disc: '7384525715443391221', name: 'SellV2', side: 'sell', qtyKind: 'tokenAmount', variant: 'modern' },
  { disc: '7456583319481319157', name: 'SellV2', side: 'sell', qtyKind: 'tokenAmount', variant: 'modern' },
];
const DISC_TABLE = new Map<string, PumpIxSig>();
for (const ix of LIVE_IX) DISC_TABLE.set(ix.disc, { name: ix.name, side: ix.side, qtyKind: ix.qtyKind, variant: ix.variant });
// sdk-era sha256("global:<name>") discs — older deployments in old tx history
const LEGACY_DISCS: Array<[string, string, 'buy' | 'sell']> = [
  ['16927863322537952870', 'buy', 'buy'],
  ['12502976635542562355', 'sell', 'sell'],
  ['4455121504214849464', 'buy_v2', 'buy'],
  ['12844523316622587485', 'sell_v2', 'sell'],
  ['6903419673668549688', 'buy_exact_sol_in', 'buy'],
  ['3412406252911504322', 'buy_exact_quote_in_v2', 'buy'],
];
for (const [disc, name, side] of LEGACY_DISCS) DISC_TABLE.set(disc, { name, side, qtyKind: side === 'sell' || name === 'buy_exact_sol_in' || name === 'buy_exact_quote_in_v2' ? 'quoteAmount' : 'tokenAmount', variant: 'sdk-era' });

/** Decode an instruction data buffer against the live pump program surface. */
export function classifyPumpIx(data: Buffer): PumpIxSig | null {
  if (!data || data.length < 8) return null;
  const sig = DISC_TABLE.get(data.readBigUInt64LE(0).toString());
  return sig || null;
}

export interface PumpIxFields { amountU64: bigint | null; secondU64: bigint | null; restHex: string; }

/** Pull the leading u64 argument values from a pump instruction payload. */
export function pumpIxArgs(data: Buffer): PumpIxFields {
  const a = data.length >= 16 ? data.readBigUInt64LE(8) : null;
  const b = data.length >= 24 ? data.readBigUInt64LE(16) : null;
  const restHex = data.length > 24 ? data.subarray(24).toString('hex') : '';
  return { amountU64: a, secondU64: b, restHex };
}

/** instruction names the live pump program logs on dispatch, mapped to side */
export function pumpLogSide(name: string): 'buy' | 'sell' | null {
  const n = String(name || '').toLowerCase().replace(/\s/g, '');
  if (n.startsWith('buy')) return 'buy';
  if (n.startsWith('sell')) return 'sell';
  return null;
}

export interface PumpIxSigView {
  name: string;
  side: 'buy' | 'sell';
  qtyKind: 'tokenAmount' | 'quoteAmount';
  variant: string;
  /** full base64 of the ix data payload */
  dataB64: string;
}

/* ----------------------- live template copy engine ---------------------- */

/**
 * A pump-program trade template: the EXACT instruction of a live same-coin
 * trade (modern account vector incl. protocol-vault accounts we do not
 * hardcode). Replays for a new trader by substituting the trader + its token
 * ATA and linearly scaling the leading u64 amounts.
 */
export interface PumpTradeTemplate {
  mint: string;
  side: 'buy' | 'sell';
  name: string;
  discLe: string;
  dataB64: string;
  accAddrs: string[];
  /** position in accAddrs of the trader account */
  traderPos: number;
  /** position in accAddrs of the trader's token ATA (may be -1) */
  traderAtaPos: number;
  traderAtaAddr: string;
  tokenProgram: 'token2022' | 'spl' | '';
  /** raw token amount that moved to/from the trader in the source tx */
  tokenDeltaRaw: string | null;
  quoteDeltaRaw: string | null;
  seenAt: number;
  sig: string;
}

const templateCache = new Map<string, PumpTradeTemplate>(); // key: mint:side

/** remember a live pump trade of `mint` so later trades can replay its shape */
export function captureTemplate(t: Omit<PumpTradeTemplate, 'seenAt'>): void {
  const prev = templateCache.get(`${t.mint}:${t.side}`);
  if (prev && prev.accAddrs.length === t.accAddrs.length && Date.now() - prev.seenAt < 10_000) return;
  templateCache.set(`${t.mint}:${t.side}`, { ...t, seenAt: Date.now() });
}

export function getTemplate(mint: string, side: 'buy' | 'sell'): PumpTradeTemplate | null {
  const t = templateCache.get(`${mint}:${side}`);
  if (!t) return null;
  if (Date.now() - t.seenAt > 10 * 60_000) return null; // stale
  return t;
}

export function dropTemplates(mint: string): void {
  templateCache.delete(`${mint}:buy`);
  templateCache.delete(`${mint}:sell`);
}

export function templateStats(): { size: number; mints: number } {
  const mints = new Set<string>();
  templateCache.forEach((_, k) => mints.add(k.split(':')[0]));
  return { size: templateCache.size, mints: mints.size };
}

/** 8-byte LE u64 > scale-safe check */
function safeU64(v: BN): boolean {
  return v.gte(new BN(0)) && v.lt(new BN('18446744073709551616'));
}

export interface CopyPlan {
  ixs: TransactionInstruction[];
  /** expected token quantity for the new trader (raw units) */
  tokenAmount: BN;
  /** expected gross quote cost in lamports */
  expectedCostLamports: number;
  /** conservative max bound for cost-based args */
  maxSolCostLamports: number;
  ataNeeded: boolean;
  ataAddress: string | null;
}

function copyIxPayload(template: PumpTradeTemplate, scale: BN): Buffer {
  const src = Buffer.from(template.dataB64, 'base64');
  const payload = Buffer.from(src);
  if (src.length >= 16 && !scale.eq(new BN(1))) {
    const mul = (off: number): void => {
      const cur = new BN(payload.readBigUInt64LE(off).toString());
      const next = cur.mul(scale);
      if (safeU64(next)) payload.writeBigUInt64LE(BigInt(next.toString()), off);
      // if it overflows u64 we leave the bound unchanged (slippage guard stays loose)
    };
    mul(8);
    if (src.length >= 24) mul(16);
  }
  return payload;
}

/**
 * Rebuild a live pump trade for a NEW trader.
 * - traderPos/traderAtaPos accounts are swapped (canonical ATA for the new
 *   trader when possible), every other account is copied verbatim.
 * - leading u64 args are multiplied by `scale` (default 1 => identical copy).
 */
export function buildPumpCopyIxs(
  conn: Connection,
  opts: {
    template: PumpTradeTemplate;
    trader: PublicKey;
    scale: BN;
    ataAddress?: string | null;
  },
): Promise<CopyPlan> {
  const t = opts.template;
  const ata = String(opts.ataAddress ?? deriveAta(opts.trader, new PublicKey(t.mint), t.tokenProgram === 'spl' ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID));
  const keys: Array<{ pubkey: PublicKey; isSigner: boolean; isWritable: boolean }> = t.accAddrs.map((addr, pos) => {
    let pubkey = addr;
    if (pos === t.traderPos) pubkey = opts.trader.toBase58();
    else if (t.traderAtaPos >= 0 && pos === t.traderAtaPos) pubkey = String(ata);
    return {
      pubkey: new PublicKey(pubkey),
      isSigner: pos === t.traderPos, // pump requires the trader as signer
      isWritable: true, // over-marking is safe; sim gate validates before send
    };
  });
  const ix = new TransactionInstruction({
    programId: PUMP_PROGRAM_ID,
    keys,
    data: copyIxPayload(t, opts.scale),
  });
  return Promise.resolve({
    ixs: [ix],
    tokenAmount: new BN(opts.scale.toString() !== '1' && t.tokenDeltaRaw ? new BN(t.tokenDeltaRaw).mul(opts.scale) : (t.tokenDeltaRaw ? new BN(t.tokenDeltaRaw) : new BN(0))),
    expectedCostLamports: t.quoteDeltaRaw && t.quoteDeltaRaw !== '0' ? Number(t.quoteDeltaRaw) : 0,
    maxSolCostLamports: 0,
    ataNeeded: false,
    ataAddress: t.traderAtaPos >= 0 ? ata : null,
  });
}

/* ------------------------------- curve state --------------------------- /* ------------------------------- curve state --------------------------- */

let _online: OnlinePumpSdk | null = null;
export function onlineSdk(): OnlinePumpSdk {
  if (!_online) _online = new OnlinePumpSdk(getConnection());
  return _online;
}

export interface CurveState { curve: BondingCurve; accountInfo: AccountInfo<Buffer>; mint: PublicKey; }

export type CurvePhase = 'curve' | 'graduated' | 'none' | 'unknown';

/**
 * Read + decode the bonding curve for a mint.
 * 'graduated' = curve exists but complete/reserves zeroed (or closed).
 * 'none'      = mint not live on pump (no curve account at all).
 */
export async function fetchCurve(conn: Connection, mint: PublicKey): Promise<CurveState | null> {
  try {
    const info = await conn.getAccountInfo(bondingCurvePda(mint), 'confirmed');
    if (!info) return null;
    const curve = PUMP_SDK.decodeBondingCurve(info);
    return { curve, accountInfo: info, mint };
  } catch {
    return null;
  }
}

export async function curvePhase(conn: Connection, mint: PublicKey): Promise<CurvePhase> {
  const st = await fetchCurve(conn, mint);
  if (!st) {
    // no curve: could be graduated (curve closed) or never-pump. Check mint existence.
    const mintInfo = await conn.getAccountInfo(mint, 'confirmed').catch(() => null);
    if (!mintInfo || !mintInfo.owner.equals(TOKEN_PROGRAM_ID) && !mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID)) {
      return 'unknown';
    }
    return 'graduated';
  }
  if (st.curve.complete || st.curve.virtualTokenReserves.isZero()) return 'graduated';
  return 'curve';
}

export function isLiveCurve(st: CurveState | null): boolean {
  return !!st && !st.curve.complete && !st.curve.virtualTokenReserves.isZero();
}

/* --------------------------- program/cache helpers --------------------- */

let globalCacheVal: { at: number; global: Global } | null = null;
export async function getGlobal(): Promise<Global> {
  if (globalCacheVal && Date.now() - globalCacheVal.at < 60_000) return globalCacheVal.global;
  const g = await onlineSdk().fetchGlobal();
  globalCacheVal = { at: Date.now(), global: g };
  return g;
}

let feeCacheVal: { at: number; fee: FeeConfig | null } | null = null;
export async function getFeeConfig(): Promise<FeeConfig | null> {
  if (feeCacheVal && Date.now() - feeCacheVal.at < 10 * 60_000) return feeCacheVal.fee;
  const f = await onlineSdk().fetchFeeConfig().catch(() => null);
  feeCacheVal = { at: Date.now(), fee: f };
  return f;
}

export async function getTokenProgramForMint(conn: Connection, mint: PublicKey): Promise<PublicKey> {
  const info = await conn.getAccountInfo(mint, 'confirmed');
  if (!info) throw new RpcError('mint account missing', new Error(`${mint.toBase58()} not found`));
  if (info.owner.equals(TOKEN_2022_PROGRAM_ID)) return TOKEN_2022_PROGRAM_ID;
  if (info.owner.equals(TOKEN_PROGRAM_ID)) return TOKEN_PROGRAM_ID;
  throw new RpcError('mint not a token', new Error(`account ${mint.toBase58()} owner ${info.owner.toBase58()}`));
}

export function deriveAta(owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()],
    ATA_PROGRAM_ID,
  )[0];
}

const decimalsCache = new Map<string, number>();
/** decimals of any mint (SPL/Token-2022 share the prefix layout: decimals @44). */
export async function mintDecimals(conn: Connection, mint: PublicKey): Promise<number> {
  const hit = decimalsCache.get(mint.toBase58());
  if (hit !== undefined) return hit;
  const info = await conn.getAccountInfo(mint, 'confirmed');
  if (!info || info.data.length < 45) return 6;
  const d = info.data[44];
  decimalsCache.set(mint.toBase58(), d);
  return d;
}

const quoteScaleCache = new Map<string, number>();
/** 1e9/10^decimals — multiplier converting quote raw units to SOL-lamport-equivalents. */
export async function quoteSolScale(conn: Connection, quoteMint: PublicKey): Promise<number> {
  const key = quoteMint.toBase58();
  const hit = quoteScaleCache.get(key);
  if (hit !== undefined) return hit;
  let scale = 1;
  if (!quoteMint.equals(WRAPPED_SOL)) {
    const dec = await mintDecimals(conn, quoteMint);
    scale = 10 ** (9 - dec);
  }
  quoteScaleCache.set(key, scale);
  return scale;
}

/* ------------------------------- pricing -------------------------------- */

export interface PricingCtx { global: Global; feeConfig: FeeConfig | null; curve: BondingCurve; }

export async function loadPricingCtx(curve: BondingCurve): Promise<PricingCtx> {
  const [global, feeConfig] = await Promise.all([getGlobal(), getFeeConfig()]);
  return { global, feeConfig, curve };
}

/** SOL-lamports the watched buyer spent for `tokenAmount` tokens (incl. fees), best estimate. */
export function solLamportsForTokenAmount(cx: PricingCtx, tokenAmount: BN): BN {
  return getBuySolAmountFromTokenAmount({
    global: cx.global,
    feeConfig: cx.feeConfig,
    mintSupply: cx.curve.tokenTotalSupply,
    bondingCurve: cx.curve,
    amount: tokenAmount,
    quoteMint: cx.curve.quoteMint,
  });
}

/** tokenAmount buyable for `budget` SOL-lamports (incl. fees). */
export function tokenAmountForSolLamports(cx: PricingCtx, budget: BN): BN {
  return getBuyTokenAmountFromSolAmount({
    global: cx.global,
    feeConfig: cx.feeConfig,
    mintSupply: cx.curve.tokenTotalSupply,
    bondingCurve: cx.curve,
    amount: budget,
    quoteMint: cx.curve.quoteMint,
  });
}

/** gross SOL-lamports expected when selling `tokenAmount` tokens (fee deducted internally by program). */
export function sellSolLamportsForTokenAmount(cx: PricingCtx, tokenAmount: BN): BN {
  return getSellSolAmountFromTokenAmount({
    global: cx.global,
    feeConfig: cx.feeConfig,
    mintSupply: cx.curve.tokenTotalSupply,
    bondingCurve: cx.curve,
    amount: tokenAmount,
  });
}

/** current market cap in SOL-lamport-equivalents. */
export function mcapSolLamports(conn: Connection, curve: BondingCurve): Promise<number> {
  return (async () => {
    const scale = await quoteSolScale(conn, curve.quoteMint);
    const mc = bondingCurveMarketCap({
      mintSupply: curve.tokenTotalSupply,
      virtualQuoteReserves: curve.virtualQuoteReserves,
      virtualTokenReserves: curve.virtualTokenReserves,
    });
    return Number(mc.toString()) * scale;
  })();
}

/** current price: SOL lamports per single raw token unit. */
export async function priceSolPerTokenLamports(conn: Connection, curve: BondingCurve): Promise<number> {
  const scale = await quoteSolScale(conn, curve.quoteMint);
  const price = curve.virtualQuoteReserves.mul(new BN(scale)).div(curve.virtualTokenReserves);
  return Number(price.toString());
}

/* ------------------------------- trade plans ---------------------------- */

export interface CurveBuyPlan {
  ixs: TransactionInstruction[];
  tokenAmount: BN;
  maxSolCostLamports: number;
  expectedCostLamports: number;
  curve: BondingCurve;
}

/**
 * Build instructions to buy a token still on its bonding curve.
 * budgetLamports is the desired outlay; slippagePct guards the max bound.
 */
/**
 * Build a buy for a token still on its bonding curve by REPLAYING a live
 * same-coin pump instruction (template copy engine). The template arrives
 * from the watcher the moment the watched wallet (or anyone) trades the mint;
 * budget sizing uses official curve+fee math; simulation gates the send.
 */
export async function buildCurveBuy(
  conn: Connection,
  opts: { mint: PublicKey; buyer: PublicKey; budgetLamports: number; slippagePct: number },
): Promise<CurveBuyPlan> {
  const state = await fetchCurve(conn, opts.mint);
  if (!state) throw new Error('no bonding curve for this mint (already graduated or not a pump token)');
  if (!isLiveCurve(state)) throw new Error('bonding curve is complete — token already graduated');
  if (opts.budgetLamports <= 0) throw new Error('budget must be positive');

  const template = getTemplate(opts.mint.toBase58(), 'buy');
  if (!template) throw new Error('no live buy template for this mint yet — retrying on the next observed trade');

  const tokenProgram = template.tokenProgram === 'spl' ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID;
  const [global, feeConfig] = await Promise.all([getGlobal(), getFeeConfig()]);
  const cx = { global, feeConfig, curve: state.curve };

  // desired token quantity for the budget (official curve+fee math)
  const tokenBudget = tokenAmountForSolLamports(cx, new BN(opts.budgetLamports));
  let scale = new BN(1);
  if (tokenBudget.gt(new BN(0)) && template.tokenDeltaRaw && new BN(template.tokenDeltaRaw).gt(new BN(0))) {
    scale = tokenBudget.div(new BN(template.tokenDeltaRaw));
    if (scale.lte(new BN(0))) scale = new BN(1);
    if (scale.gt(new BN(250))) scale = new BN(250); // cap: never ape >250x the reference
  }
  const plan = await buildPumpCopyIxs(conn, {
    template,
    trader: opts.buyer,
    scale,
    ataAddress: deriveAta(opts.buyer, opts.mint, tokenProgram).toBase58(),
  });
  const cost = solLamportsForTokenAmount(cx, plan.tokenAmount.gt(new BN(0)) ? plan.tokenAmount : tokenBudget);
  const ixs = [ataCreateIx(opts.buyer, opts.buyer, opts.mint, tokenProgram), ...plan.ixs];
  return {
    ixs,
    tokenAmount: plan.tokenAmount.gt(new BN(0)) ? plan.tokenAmount : tokenBudget,
    expectedCostLamports: Number(cost.toString()),
    maxSolCostLamports: Math.round(Number(cost.toString()) * (1 + Math.max(opts.slippagePct, 0.05))),
    curve: state.curve,
  };
}

export interface CurveSellPlan { ixs: TransactionInstruction[]; minOutLamports: number; grossLamports: number; }

/**
 * Build a sell back to the bonding curve by REPLAYING a live same-coin sell
 * instruction (template copy engine). Fall back to Jupiter once graduated.
 */
export async function buildCurveSell(
  conn: Connection,
  opts: { mint: PublicKey; seller: PublicKey; tokenAmount: BN; slippagePct: number; tokenProgram: PublicKey },
): Promise<CurveSellPlan> {
  const state = await fetchCurve(conn, opts.mint);
  if (!state || !isLiveCurve(state)) throw new Error('curve gone — token graduated, use Jupiter');
  const template = getTemplate(opts.mint.toBase58(), 'sell');
  if (!template) throw new Error('no live sell template for this mint yet — a same-coin sell has not been observed');

  let scale = new BN(1);
  if (opts.tokenAmount.gt(new BN(0)) && template.tokenDeltaRaw && new BN(template.tokenDeltaRaw).gt(new BN(0))) {
    scale = opts.tokenAmount.div(new BN(template.tokenDeltaRaw));
    if (scale.lte(new BN(0))) scale = new BN(1);
  }
  const plan = await buildPumpCopyIxs(conn, { template, trader: opts.seller, scale });
  const [global, feeConfig] = await Promise.all([getGlobal(), getFeeConfig()]);
  const cx = { global, feeConfig, curve: state.curve };
  const gross = sellSolLamportsForTokenAmount(cx, plan.tokenAmount.gt(new BN(0)) ? plan.tokenAmount : opts.tokenAmount);
  return {
    ixs: plan.ixs,
    grossLamports: Number(gross.toString()),
    minOutLamports: Math.round(Number(gross.toString()) * (1 - Math.max(opts.slippagePct, 0.05))),
  };
}

/** Build the ATA-creation instruction when needed (idempotent). */
export function ataCreateIx(payer: PublicKey, owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey): TransactionInstruction {
  const ata = deriveAta(owner, mint, tokenProgram);
  return new TransactionInstruction({
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: new PublicKey('11111111111111111111111111111111'), isSigner: false, isWritable: false },
      { pubkey: tokenProgram, isSigner: false, isWritable: false },
    ],
    programId: ATA_PROGRAM_ID,
    data: Buffer.from([1]), // CreateIdempotent
  });
}
