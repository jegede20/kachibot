/**
 * KACHIBOT — transaction delivery.
 * Priority-fee & Jito-bundle aware sending with bounded retries. All fee money
 * comes from the user's own trade funds; no project infra cost.
 */
import {
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { IS_MAINNET, JITO_RPC_URL, JITO_TIP_ACCOUNTS } from '../config';
import { getConnection } from './conn';

export const COMPUTE_BUDGET_PROG = new PublicKey('ComputeBudget111111111111111111111111111111');
export const SYSTEM_PROG = new PublicKey('11111111111111111111111111111111');
export const DEFAULT_CU_LIMIT = 400_000;

function ix(programId: PublicKey, data: Buffer, keys: Array<{ pubkey: PublicKey; isSigner: boolean; isWritable: boolean }> = []): TransactionInstruction {
  return new TransactionInstruction({ keys, programId, data });
}

/**
 * SetComputeUnitLimit (ix 2, u32 LE) + SetComputeUnitPrice (ix 3, u64 LE
 * micro-lamports per CU) sized so the worst case spends `maxFeeLamports`.
 */
export function priorityFeeIxs(maxFeeLamports: number, cuLimit = DEFAULT_CU_LIMIT): TransactionInstruction[] {
  const limit = Buffer.alloc(4);
  limit.writeUInt32LE(cuLimit, 0);
  const out = [ix(COMPUTE_BUDGET_PROG, Buffer.concat([Buffer.from([2]), limit]))];
  if (maxFeeLamports > 0) {
    const price = Math.max(1, Math.floor(maxFeeLamports / cuLimit));
    const priceBuf = Buffer.alloc(8);
    priceBuf.writeBigUInt64LE(BigInt(price), 0);
    out.push(ix(COMPUTE_BUDGET_PROG, Buffer.concat([Buffer.from([3]), priceBuf])));
  }
  return out;
}

export function toVersioned(payer: PublicKey, ixs: TransactionInstruction[], recentBlockhash: string): VersionedTransaction {
  const msg = new TransactionMessage({
    payerKey: payer,
    recentBlockhash,
    instructions: ixs,
  }).compileToV0Message();
  return new VersionedTransaction(msg);
}

/**
 * Simulate a transaction (unsigned) to verify it executes — the honeypot /
 * pre-commit check. Returns units consumed & any simulation error text.
 */
export async function simulate(
  conn: Connection,
  payer: Keypair,
  ixs: TransactionInstruction[],
): Promise<{ ok: boolean; err: string | null; units: number }> {
  const { blockhash } = await conn.getLatestBlockhash('confirmed');
  const tx = toVersioned(payer.publicKey, ixs, blockhash);
  tx.signatures = tx.signatures.map(() => new Uint8Array(64)); // dummy sigs; sigVerify:false
  try {
    const sim = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' });
    if (sim.value.err) {
      return { ok: false, err: describeSimError(sim.value.err), units: sim.value.unitsConsumed || 0 };
    }
    return { ok: true, err: null, units: sim.value.unitsConsumed || 0 };
  } catch (e) {
    return { ok: false, err: `simulate call failed: ${(e as Error).message}`, units: 0 };
  }
}

function describeSimError(err: unknown): string {
  try {
    if (Array.isArray(err)) {
      const inner = err[1] as { InstructionError?: unknown } | undefined;
      if (inner && typeof inner === 'object' && 'InstructionError' in inner) {
        return `InstructionError: ${JSON.stringify(inner.InstructionError)}`;
      }
      return JSON.stringify(err);
    }
    return String(err);
  } catch {
    return String(err);
  }
}

export type ConfirmOutcome = 'confirmed' | 'landed-failed' | 'timeout';

/** Poll signature status; 'landed-failed' means on-chain execution error. */
export async function confirmSignature(conn: Connection, sig: string, timeoutMs = 45_000): Promise<ConfirmOutcome> {
  const start = Date.now();
  for (;;) {
    try {
      const status = await conn.getSignatureStatus(sig, { searchTransactionHistory: false });
      const s = status?.value;
      if (s && s.err) return 'landed-failed';
      if (s && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')) return 'confirmed';
    } catch {
      // transient RPC poll error — keep waiting, do not misreport
    }
    if (Date.now() - start > timeoutMs) return 'timeout';
    await new Promise((r) => setTimeout(r, 750));
  }
}

export interface SendResult { signature: string; via: 'jito' | 'rpc'; attempts: number; outcome: ConfirmOutcome; }

/**
 * Send ixs honoring the user's fee cap. Tries a Jito bundle (mainnet only)
 * first when the cap allows, then falls back to RPC broadcast with priority
 * fees. Every path returns a signature or throws a descriptive error.
 */
export async function sendTrade(
  conn: Connection,
  payer: Keypair,
  ixs: TransactionInstruction[],
  maxFeeLamports: number,
): Promise<SendResult> {
  const feeIxs = priorityFeeIxs(maxFeeLamports);
  const failures: string[] = [];

  if (IS_MAINNET && maxFeeLamports > 0) {
    try {
      const sig = await tryJitoBundle(conn, payer, feeIxs, ixs, maxFeeLamports);
      if (sig) {
        const outcome = await confirmSignature(conn, sig);
        if (outcome === 'timeout') failures.push('jito: confirmed nowhere in 45s');
        return { signature: sig, via: 'jito', attempts: 1, outcome };
      }
      failures.push('jito: no bundle result');
    } catch (e) {
      failures.push(`jito: ${(e as Error).message}`);
    }
  }

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const { blockhash } = await conn.getLatestBlockhash('confirmed');
      const tx = toVersioned(payer.publicKey, [...feeIxs, ...ixs], blockhash);
      tx.sign([payer]);
      const sig = await conn.sendRawTransaction(tx.serialize(), {
        skipPreflight: true,
        preflightCommitment: 'confirmed',
        maxRetries: 2,
      });
      const outcome = await confirmSignature(conn, sig);
      if (outcome !== 'timeout') return { signature: sig, via: 'rpc', attempts: attempt, outcome };
      failures.push(`rpc attempt ${attempt}: no confirmation in 45s`);
    } catch (e) {
      failures.push(`rpc attempt ${attempt}: ${(e as Error).message}`);
    }
  }
  throw new Error(`send failed after retries — ${failures.join(' | ')}`);
}

/* -------------------------------- jito --------------------------------- */

async function tryJitoBundle(
  conn: Connection,
  payer: Keypair,
  feeIxs: TransactionInstruction[],
  tradeIxs: TransactionInstruction[],
  maxFeeLamports: number,
): Promise<string | null> {
  if (JITO_TIP_ACCOUNTS.length === 0) return null;
  const tipAcct = new PublicKey(JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)]);
  const { blockhash } = await conn.getLatestBlockhash('finalized');

  const tipLamports = Math.min(maxFeeLamports, 5_000_000); // never tip above 0.005 SOL
  const data = Buffer.alloc(12);
  data.writeUInt32LE(2, 0); // system transfer
  data.writeBigUInt64LE(BigInt(tipLamports), 4);
  const tipIx = ix(SYSTEM_PROG, data, [
    { pubkey: payer.publicKey, isSigner: true, isWritable: true },
    { pubkey: tipAcct, isSigner: false, isWritable: true },
  ]);

  const tipTx = toVersioned(payer.publicKey, [tipIx], blockhash);
  const mainTx = toVersioned(payer.publicKey, [...feeIxs, ...tradeIxs], blockhash);
  tipTx.sign([payer]);
  mainTx.sign([payer]);

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15_000);
  try {
    const res = await fetch(`${JITO_RPC_URL.replace(/\/$/, '')}/api/v1/bundles`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'sendBundle',
        params: [[Buffer.from(tipTx.serialize()).toString('base64'), Buffer.from(mainTx.serialize()).toString('base64')]],
      }),
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error(`bundle HTTP ${res.status}`);
    const body = (await res.json()) as { result?: string; error?: { message?: string } };
    if (body.error) throw new Error(body.error.message || 'bundle error');
    return body.result || null;
  } catch (e) {
    console.warn('[send] jito bundle failed:', (e as Error).message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function solConn(): Connection {
  return getConnection();
}
