/**
 * KACHIBOT — RPC connection helpers (single provider by design; no fallback
 * provider per project constraints — errors surface loudly instead).
 */
import {
  Connection,
  PublicKey,
  clusterApiUrl,
  type Commitment,
} from '@solana/web3.js';
import { RPC_HTTP, RPC_WS, IS_MAINNET } from '../config';

const COMMITMENT: Commitment = 'confirmed';

let conn: Connection | null = null;
export function getConnection(): Connection {
  if (!conn) {
    const http = RPC_HTTP;
    const ws = /^wss?:\/\//.test(RPC_WS) ? RPC_WS : undefined;
    conn = new Connection(http, {
      wsEndpoint: ws || undefined,
      commitment: COMMITMENT,
      confirmTransactionInitialTimeout: 60_000,
      disableRetryOnRateLimit: false,
    });
    console.log(`[chain] RPC ${http}${ws ? ` (ws ${ws})` : ''} network=${IS_MAINNET ? 'mainnet' : 'devnet'}`);
  }
  return conn;
}

export function shortRpcForLog(): string {
  const u = new URL(RPC_HTTP);
  return `${u.hostname}${u.port ? ':' + u.port : ''}`;
}

export function defaultWsForLog(): string {
  return RPC_WS;
}

/* ------------------------- error-tolerant RPC -------------------------- */

export class RpcError extends Error {
  constructor(public readonly op: string, inner: unknown) {
    super(`${op}: ${inner instanceof Error ? inner.message : String(inner)}`);
    this.name = 'RpcError';
  }
}

/** JSON-RPC fetch wrapper: throws RpcError with clear context, no silent failures. */
export async function rpcFetch<T = unknown>(method: string, params: unknown[], timeoutMs = 20_000): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(RPC_HTTP, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: Date.now() % 100000, method, params }),
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { result?: T; error?: { message: string; code?: number } };
    if (body.error) throw new Error(`${body.error.message}${body.error.code ? ` (${body.error.code})` : ''}`);
    if (body.result === undefined) throw new Error('empty result');
    return body.result as T;
  } catch (e) {
    throw new RpcError(method, e);
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------ balances ------------------------------- */

export async function getLamports(pubkey: PublicKey, commitment: Commitment = 'confirmed'): Promise<number> {
  return getConnection().getBalance(pubkey, commitment);
}

export async function getBlockhash(): Promise<string> {
  const { blockhash } = await getConnection().getLatestBlockhash('confirmed');
  return blockhash;
}

export function pubkeyOk(s: string): PublicKey | null {
  try { return new PublicKey(s); } catch { return null; }
}

/** devnet-worthy faucet info only used in logs/tests */
export function clusterUrlHint(): string | null {
  return IS_MAINNET ? null : clusterApiUrl('devnet');
}
