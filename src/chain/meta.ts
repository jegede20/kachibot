/**
 * KACHIBOT — token metadata & anti-rug checks.
 * Reads on-chain only (no API key required): mint authorities from the mint
 * account itself, name/symbol from the Metaplex metadata account, and (when a
 * Helius DAS URL is configured) richer assets incl. image.
 */
import { Connection, PublicKey } from '@solana/web3.js';
import { HELIUS_DAS_URL } from '../config';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from './pump';

/**
 * Raw token supply from raw mint-account bytes.
 * SPL and Token-2022 share the same Mint layout: mint_authority (36 bytes),
 * then supply as a **little-endian u64** at offset 36. Reading it big-endian
 * (a mistake we shipped once) inflates it by ~4 orders of magnitude and turns
 * every market cap into nonsense.
 */
export function mintSupplyRaw(data: Uint8Array | Buffer | null | undefined): number | null {
  if (!data || data.length < 45) return null;
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  try {
    const v = buf.readBigUInt64LE(36);
    return Number(v);
  } catch {
    return null;
  }
}

export const METAPLEX_META = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');

export interface TokenMeta {
  mint: string;
  name: string;
  symbol: string;
  image: string | null;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  /** decimals if known */
  decimals: number;
}

const metaCache = new Map<string, TokenMeta | null>();

export function parseMintAuthorities(mintData: Buffer): { mintAuthority: string | null; freezeAuthority: string | null } {
  const readOpt = (off: number): string | null => {
    if (mintData.length < off + 36) return null;
    const tag = mintData[off];
    if (tag === 0) return null;
    if (tag === 1 && mintData.length >= off + 36) {
      return new PublicKey(mintData.subarray(off + 4, off + 36)).toBase58();
    }
    return null;
  };
  return { mintAuthority: readOpt(0), freezeAuthority: readOpt(46) };
}

/* ------------------------- metaplex metadata ---------------------------- */

interface MetaplexDecoded { name: string; symbol: string; uri: string; }

export function decodeMetaplexMetadata(data: Buffer): MetaplexDecoded | null {
  try {
    let off = 1 + 32 + 32; // key + update authority + mint
    const readStr = (): string => {
      if (off + 4 > data.length) throw new Error('short');
      const len = data.readUInt32LE(off);
      off += 4;
      const s = data.subarray(off, off + len).toString('utf8');
      off += len;
      return s;
    };
    const name = readStr();
    const symbol = readStr();
    const uri = readStr();
    return { name, symbol, uri };
  } catch {
    return null;
  }
}

export function metadataPda(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('metadata'), METAPLEX_META.toBuffer(), mint.toBuffer()],
    METAPLEX_META,
  )[0];
}

async function fetchMetaplex(conn: Connection, mint: PublicKey): Promise<{ name: string; symbol: string; image: string | null } | null> {
  try {
    const info = await conn.getAccountInfo(metadataPda(mint), 'confirmed');
    if (!info || !info.owner.equals(METAPLEX_META)) return null;
    const d = decodeMetaplexMetadata(info.data);
    if (!d) return null;
    return { name: d.name, symbol: d.symbol, image: null };
  } catch {
    return null;
  }
}

async function fetchHeliusDAS(mint: PublicKey): Promise<{ name: string; symbol: string; image: string | null } | null> {
  if (!HELIUS_DAS_URL) return null;
  try {
    const res = await fetch(HELIUS_DAS_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getAsset',
        params: { id: mint.toBase58() },
      }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      result?: {
        content?: { metadata?: { name?: string; symbol?: string }; links?: { image?: string } };
        authorities?: Array<{ address: string; scopes: string[] }>;
        mint_extensions?: unknown;
      };
    };
    const r = body.result;
    if (!r) return null;
    return {
      name: r.content?.metadata?.name || '',
      symbol: r.content?.metadata?.symbol || '',
      image: r.content?.links?.image || null,
    };
  } catch {
    return null;
  }
}

const NOT_FOUND_TOKEN_META: TokenMeta | null = null;

/** Full token meta incl. authorities; null when mint doesn't exist. */
export async function getTokenMeta(conn: Connection, mint: PublicKey): Promise<TokenMeta | null> {
  const key = mint.toBase58();
  if (metaCache.has(key)) return metaCache.get(key) ?? null;

  const mintInfo = await conn.getAccountInfo(mint, 'confirmed').catch(() => null);
  if (!mintInfo) {
    metaCache.set(key, NOT_FOUND_TOKEN_META);
    return null;
  }
  const isToken = mintInfo.owner.equals(TOKEN_PROGRAM_ID) || mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID);
  const authorities = parseMintAuthorities(mintInfo.data);
  let offchain: { name: string; symbol: string; image: string | null } | null = null;
  if (isToken) {
    offchain = (await fetchHeliusDAS(mint)) || (await fetchMetaplex(conn, mint));
  }
  const meta: TokenMeta = {
    mint: key,
    name: offchain?.name?.trim() ? offchain.name : compact(key),
    symbol: offchain?.symbol?.trim() ? offchain.symbol : compact(key, 6),
    image: offchain?.image || null,
    mintAuthority: authorities.mintAuthority,
    freezeAuthority: authorities.freezeAuthority,
    decimals: mintInfo.data.length >= 45 ? mintInfo.data[44] : 6,
  };
  metaCache.set(key, meta);
  return meta;
}

function compact(key: string, n = 4): string {
  return `${key.slice(0, n)}…${key.slice(-4)}`;
}

export interface RugFlags {
  mintAuthority: boolean;
  freezeAuthority: boolean;
  mintExists: boolean;
}

/** On-chain anti-rug signal: non-null mint/freeze authorities on a pump coin are a red flag. */
export async function rugFlags(conn: Connection, mint: PublicKey): Promise<RugFlags> {
  const meta = await getTokenMeta(conn, mint);
  if (!meta) return { mintAuthority: true, freezeAuthority: true, mintExists: false };
  return {
    mintAuthority: !!meta.mintAuthority,
    freezeAuthority: !!meta.freezeAuthority,
    mintExists: true,
  };
}

export function describeRugFlags(f: RugFlags): string[] {
  const out: string[] = [];
  if (!f.mintExists) out.push('mint not found on-chain');
  if (f.mintAuthority) out.push('mint authority not renounced');
  if (f.freezeAuthority) out.push('freeze authority present');
  return out;
}
