/**
 * KACHIBOT — configuration & environment.
 * All secrets come from environment variables / .env. The bot refuses to boot
 * with missing or invalid critical configuration rather than half-working.
 */
import 'dotenv/config';
import { PublicKey } from '@solana/web3.js';

export const NETWORK = (process.env.SOLANA_NETWORK || 'mainnet').toLowerCase();
export const IS_MAINNET = NETWORK === 'mainnet';

export const RPC_HTTP =
  process.env.RPC_HTTP_URL || (IS_MAINNET
    ? 'https://api.mainnet-beta.solana.com'
    : 'https://api.devnet.solana.com');

export const RPC_WS =
  process.env.RPC_WS_URL || (IS_MAINNET
    ? 'wss://api.mainnet-beta.solana.com'
    : 'wss://api.devnet.solana.com');

/** Optional Helius DAS key for rich token metadata (symbol/name, authorities). */
export const HELIUS_DAS_URL =
  process.env.HELIUS_DAS_URL && process.env.HELIUS_DAS_URL.length > 0
    ? process.env.HELIUS_DAS_URL
    : null;

export const TELEGRAM_BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
export const TELEGRAM_ALLOWED_USER_IDS = (process.env.TELEGRAM_ALLOWED_USER_IDS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

/** AES-256-GCM key: base64 32-byte key. If unset, derived from KACHI_MASTER_PASSPHRASE via SHA-256. */
export const ENCRYPTION_KEY =
  process.env.ENCRYPTION_KEY && process.env.ENCRYPTION_KEY.length > 0
    ? process.env.ENCRYPTION_KEY
    : (process.env.KACHI_MASTER_PASSPHRASE || '');

/** Supabase. When missing, KACHIBOT falls back to a local JSON file store (no external infra needed). */
export const SUPABASE_URL = process.env.SUPABASE_URL || '';
export const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
export const DATA_DIR = process.env.KACHI_DATA_DIR || './data';
/** HTTP port for the keep-alive/health endpoint (Render injects PORT) */
export const PORT = process.env.PORT ? Number(process.env.PORT) : 0;
/** Public base URL — /guide is served here so users can read the manual */
export const PUBLIC_URL = process.env.PUBLIC_URL || 'https://kachibot.onrender.com';
export const DB_FILE = process.env.KACHI_DB_FILE || `${DATA_DIR}/db.json`;

/** Jito block-engine (only used on mainnet when a user's fee cap > 0). */
export const JITO_RPC_URL = process.env.JITO_RPC_URL || 'https://mainnet.block-engine.jito.wtf';
export const JITO_TIP_ACCOUNTS = (
  process.env.JITO_TIP_ACCOUNTS ||
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5,HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe,Cw8CFciM9jGCG1enZNLFtwTe6S64rFAiZtCpumj4rpT8,ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49,DfXygSm4jCyNCybzYYTmbk3brb7Hv5by8msmta4qiLq8,ADuUkR4vqLUPWgxqYaYHGzyBnuRfUvZC1HZwP4nTJKxG'
).split(',').map((s) => s.trim()).filter((s) => s.length === 44);

/** Jupiter aggregator quote API (free tier; optional key for higher limits). */
export const JUPITER_QUOTE_API = process.env.JUPITER_API_URL || 'https://quote-api.jupiter.ag';
export const JUPITER_API_KEY = (process.env.JUPITER_API_KEY || '').trim();

/** pump.fun profile URL patterns accepted by /watch */
/**
 * Parse a pump.fun link -> { kind, id }.
 * Accepts: pump.fun/coin/<mint>, pump.fun/profile/<address>, pump.fun/<address>,
 * with or without scheme/www, tolerating trailing slash, query strings and
 * extra words around the link. Named groups so capture indices never drift.
 */
export function parsePumpfunLink(text: string): { kind: 'coin' | 'profile'; id: string } | null {
  const m = text.match(
    /(?:^|[^\w.@])(?:www\.)?pump\.fun\/(?:coin\/(?<mint>[1-9A-HJ-NP-Za-km-z]{32,44})|(?:profile\/)?(?<addr>[1-9A-HJ-NP-Za-km-z]{32,44}))/i,
  );
  if (!m || !m.groups) return null;
  if (m.groups.mint) return { kind: 'coin', id: m.groups.mint };
  if (m.groups.addr) return { kind: 'profile', id: m.groups.addr };
  return null;
}
export const WALLET_ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** How long (ms) the watcher holds "seen" buy signals to fold rapid re-fires into one event. */
export const WATCH_DEDUPE_WINDOW = 9000;

/** Defaults for new users — every value is overridable per user from the menu. */
export const DEFAULT_SETTINGS = {
  /** fixed lamports per snipe; when mode='pct' it is unused */
  buyAmountLamports: 5_000_000, // 0.005 SOL
  /** pct mode: 0.5 -> copy 50% of the watched wallet's estimated spend */
  buyPctOfSpend: 0.5,
  /** 'fixed' | 'pct' */
  buyMode: 'fixed' as 'fixed' | 'pct',
  slippagePct: 0.25, // 25%
  maxFeeLamports: 1_000_000, // priority/tip cap per tx: 0.001 SOL
  tpMultiples: [2, 3], // exit each 50% of position at 2x and 3x
  stopLossPct: 0.5, // sell everything at -50%
  copySell: false,
  minSpendLamports: 100_000, // ignore watched buys smaller than this
  maxSpendLamports: 100_000_000_000, // ignore watched buys bigger than this (lamports)
  dailyCapLamports: 500_000_000, // 0.5 SOL / day per user
  perTradeCapLamports: 50_000_000, // 0.05 SOL max per auto-buy
  watcherCooldownMs: 10_000, // min gap between two auto-buys from same watched wallet
  honeypotCheck: true,
  alerts: { snipes: true, sells: true, activity: false },
} as const;

export const SOL_DECIMALS = 9;
export const TOKEN_DECIMALS = 6; // pump.fun coins are 6-decimals

export function assertConfig(): void {
  const problems: string[] = [];
  if (!TELEGRAM_BOT_TOKEN) problems.push('TELEGRAM_BOT_TOKEN is required');
  if (RPC_HTTP.length < 10) problems.push('RPC_HTTP_URL looks wrong');
  if (RPC_WS.length < 10) problems.push('RPC_WS_URL looks wrong');
  if (!ENCRYPTION_KEY || ENCRYPTION_KEY.length < 16) {
    problems.push('ENCRYPTION_KEY (or KACHI_MASTER_PASSPHRASE, >=16 chars) is required — wallet secrets are encrypted with it');
  }
  if (SUPABASE_URL && !/^https:\/\//.test(SUPABASE_URL)) problems.push('SUPABASE_URL must be an https URL (or remove it to use local file store)');
  for (const t of JITO_TIP_ACCOUNTS) {
    try { new PublicKey(t); } catch { problems.push(`invalid JITO_TIP_ACCOUNTS entry: ${t}`); }
  }
  if (problems.length) {
    // eslint-disable-next-line no-console
    console.error('\nKACHIBOT config error:\n  - ' + problems.join('\n  - ') + '\nSee .env.example\n');
    process.exit(1);
  }
}
