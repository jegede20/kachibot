# KACHIBOT 🎯

Telegram copy-sniper bot for Solana / pump.fun. Watch a wallet (or a pump.fun
profile — the profile URL auto-resolves to its wallet), and KACHIBOT mirrors
the buys that wallet makes — including brand-new low-mcap pump.fun launches —
directly on the pump.fun bonding curve (pre-graduation) or via Jupiter
(post-graduation), then manages the position with TP/SL, optional copy-sells,
rug detection and a per-trade branded scorecard.

Built from scratch on Node.js + Telegraf + @solana/web3.js, with the official
`@pump-fun/pump-sdk` used for on-chain *state decoding* (curve, global, fee
config) and curve *pricing math*.

---

## Quick start

```bash
npm install
cp .env.example .env        # then fill in TELEGRAM_BOT_TOKEN (+ optional keys)
npm run build
npm test                    # 14 tests: crypto, classifier, template engine, settings, format
node scripts/smoke.js       # live check: decodes real pump.fun txs from mainnet
npm start                   # boots watcher + trader + Telegram bot
```

Required env: `TELEGRAM_BOT_TOKEN`, `ENCRYPTION_KEY` (or
`KACHI_MASTER_PASSPHRASE`). Everything else is optional:

- `SOLANA_NETWORK` / `RPC_HTTP_URL` / `RPC_WS_URL` — Helius free tier is
  recommended; the public RPC works but is rate-limited.
- `SUPABASE_URL` / `SUPABASE_ANON_KEY` — multi-user Postgres storage
  (run `supabase/schema.sql` once). If unset, KACHIBOT stores to a local
  JSON file (`./data/db.json`) — zero infra.
- `JITO_RPC_URL` / `JITO_TIP_ACCOUNTS` — mainnet Jito speed lane for snipes.
- `JUPITER_API_KEY`, `HELIUS_DAS_URL` — rate-limit/metadata niceties.

Only allowed Telegram ids (if you set `TELEGRAM_ALLOWED_USER_IDS`) can talk
to the bot; otherwise the first /start user becomes the owner.

---

## What it does

**Watch / snipe**
- `/watch <wallet-or-pump.fun-coin/profile-url>` — one WebSocket account
  subscription per watched wallet + a signature-polling backstop. pump.fun
  URLs auto-resolve to the wallet address.
- Every pump-program buy/sell touching the watched wallet is decoded — direct
  txs *and* router/CPI paths — via an **empirical instruction table captured
  from live mainnet** (the protocol's current discriminator set differs from
  the shipped IDL; see `src/chain/pump.ts`).
- Per-user/per-wallet config: fixed SOL or % of the watched spend, slippage,
  priority-fee/Jito-tip cap, TP ladder (2x/3x/custom), stop-loss, optional
  copy-sell, honeypot/simulate-before-buy, mint/freeze-authority checks,
  daily **and** per-trade spend caps with auto-cancel, per-wallet cooldown.

**Execution (the honest part)**
- Pre-graduation buys/sells are executed with **live template copy**: the
  exact pump-program instruction of a just-observed same-coin trade (account
  vector incl. protocol vaults + payload), re-targeted to your wallet with
  linear amount scaling. Amount sizing uses the official curve+fee math.
- **Every curve trade is simulation-gated** before broadcast — a malformed or
  honeypot-ish instruction never hits the network.
- Post-graduation (curve complete or closed) → Jupiter quote + swap, detected
  automatically per trade.
- Trades are settlement-verified from wallet balance deltas (never assumed).

**Wallet & security**
- New wallet generation, import seed phrase / private key, PIN-gated export.
- AES-256-GCM at rest; secrets decrypt only transiently for signing/export.
- Full multi-user isolation.

**Manage & report**
- Main menu, Wallet, Trading settings, Watchlist (per-wallet win rate &
  avg return), Open positions with live PnL, History + scorecards, Alerts,
  Panic-sell / sell-all — all inline-keyboard only, no web UI.
- One branded KACHIBOT trade card per completed trade (entry mcap, hold time,
  balance before/after, PnL, X multiple, rug signal, exit reason reflecting
  the active exit mode), and real-time snipe/sell/watch alerts with chart
  links and inline sell-now buttons.

## Known limits (protocol reality, Sept 2026)

The pump.fun mainnet program now runs several coexisting instruction
generations and per-coin protocol vaults whose derivation rules are partially
undocumented. KACHIBOT therefore never hand-assembles curve instructions from
an IDL — it replays observed ones (see above). Consequences:

- A same-coin reference trade must have been observed for curve buys/sells
  (the watched wallet's own buy is the reference for your snipe, so the
  copy-snipe flow always has one). If none exists yet, the bot tells you and
  retries — nothing is guessed onto the chain.
- Very exotic setups (USDC-quoted curves, mayhem/cashback edge cases) follow
  the same rule: if a valid reference exists it works; otherwise you get a
  clean, safe refusal instead of a failed tx.
- The Jupiter quote endpoint is reached from the machine running the bot.

Not financial advice: snipe only what you can afford to lose. Rug checks and
simulation reduce risk; they cannot eliminate it.
