/**
 * SOL/USD spot price — only used to compare a USD market-cap target against
 * the on-chain (SOL-denominated) market cap. Cached, never throws, returns
 * null when every source is unreachable so callers can skip the check.
 */
const CACHE_MS = 5 * 60_000;
let cached: { at: number; usd: number } | null = null;

async function fetchJson(url: string, ms = 4000): Promise<unknown> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** SOL price in USD, or null when unknown. */
export async function getSolUsd(): Promise<number | null> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.usd;

  const cg = await fetchJson('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
  const cgPrice = (cg as { solana?: { usd?: number } } | null)?.solana?.usd;
  if (typeof cgPrice === 'number' && cgPrice > 0) {
    cached = { at: Date.now(), usd: cgPrice };
    return cgPrice;
  }

  const bn = await fetchJson('https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT');
  const bnPrice = Number((bn as { price?: string | number } | null)?.price);
  if (Number.isFinite(bnPrice) && bnPrice > 0) {
    cached = { at: Date.now(), usd: bnPrice };
    return bnPrice;
  }

  return null;
}

/** test/override hook */
export function setSolUsdForTest(usd: number | null): void {
  cached = usd === null ? null : { at: Date.now(), usd };
}
