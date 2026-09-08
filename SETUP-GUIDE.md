# KACHIBOT — Setup Guide

Reference for getting KACHIBOT from repo to live, and for day-to-day ops.
**Never commit or share `.env` — it holds live secrets (already gitignored).**

---

## 1. One-time Telegram setup (already done ✔)

In @BotFather, for the bot whose token is in `.env`:

| Item | Done |
|---|---|
| `/newbot` → token into `.env` | ✔ |
| `/setuserpic` → `kachibot-avatar-circle.png` (circle-fit ape + K) | ✔ |
| `/setdescriptionphoto` → `kachibot-desc-640x360.png` | ✔ |
| `/setdescription` + `/setabouttext` → short pitch | ✔ |
| `/setcommands` → start/menu/settings/wallet/watch/positions/history/panic/cancel | ✔ |

> Profile files live in the workspace root: `kachibot-avatar-circle.png`,
> `kachibot-desc-640x360.png` (and source art in `kachibot-avatar-512.png`,
> `kachibot-logo-final.png`, `kachibot-mark-*.png`, `kachibot-meme-ape-512.png`).

---

## 2. Environment (`.env`)

Copy of `.env.example` with real values:

| Variable | What it is | Where it comes from |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | bot identity | @BotFather `/newbot` |
| `SOLANA_NETWORK` | `mainnet` | — |
| `RPC_HTTP_URL` | Solana HTTP RPC | Helius dashboard (free key) |
| `RPC_WS_URL` | Solana WebSocket RPC (same key, `wss://`) | Helius dashboard |
| `HELIUS_DAS_URL` | optional token-metadata endpoint (same URL works) | Helius dashboard |
| `ENCRYPTION_KEY` | AES-256-GCM key for wallet secrets — **back it up, it is NOT recoverable** | `openssl rand -base64 32` |
| `SUPABASE_URL` | Postgres host for storage | Supabase → Project Settings → API |
| `SUPABASE_ANON_KEY` | anon key (REST) — schema has permissive RLS | Supabase → Project Settings → API |
| `TELEGRAM_ALLOWED_USER_IDS` | optional allowlist. Empty = anyone with the link can use the bot | your numeric ID from @userinfobot |

Optional (defaults are fine): `JITO_RPC_URL`, `JITO_TIP_ACCOUNTS` (pre-filled),
`JUPITER_API_KEY` (rate-limit bump).

---

## 3. Database (Supabase free tier)

Schema: `supabase/schema.sql` → two tables, `kachi_users` and `kachi_trades`
(`jsonb` docs + permissive RLS for the anon key). Already applied to the
project `jelfheaofoyimrlcssgl` (2026-09-08).

If you ever need to re-apply against a fresh project:

```bash
PGPASSWORD='<db-password>' psql \
  -h <host>.pooler.supabase.com -p 6543 \
  -U postgres.<project-ref> -d postgres \
  -v ON_ERROR_STOP=1 -f supabase/schema.sql
```

(Use the **session** pooler port 5432 instead of 6543 if you hit
transaction-pooler issues with DDL.)

No Supabase? Delete `SUPABASE_URL`/`SUPABASE_ANON_KEY` from `.env` → the bot
falls back to a local JSON store in `./data/db.json`.

---

## 4. Run

```bash
npm install          # first time only
npm run build        # tsc -> dist/
npm test             # 14 tests (crypto, classifier, template engine, ...)
node scripts/smoke.js # live check: decode real pump.fun txs on mainnet
npm start            # go live (long-running)
```

Healthy boot prints:

```
[db] using Supabase (postgres jsonb) store
[main] KACHIBOT up in …s — watching wallets, ready to mirror apes.
```

Stop cleanly with `Ctrl+C` (SIGINT → graceful shutdown).

## 4b. Run 24/7 (never stop)

**Pick ONE host:** an always-on machine — your own PC/laptop left on, a cheap
VPS, or a mini PC. The bot is a small Node process; it only needs outbound
internet + the `.env`.

### Option A — PM2 (easiest; Windows/macOS/Linux) — recommended for your PC
```bash
npm install -g pm2
npm run build
pm2 start ecosystem.config.cjs    # auto-restart on crash, memory recycle
pm2 save                          # remember the process list
pm2 startup                       # boot-time auto-start (prints a command; run it)
pm2 logs kachibot                 # watch logs
pm2 status                        # health
```
Restart after code changes: `pm2 restart kachibot`. Kill: `pm2 delete kachibot`.

### Option B — systemd on a VPS (true server grade)
```bash
sudo bash deploy/install-vps.sh   # copies repo to /opt/kachibot, builds,
                                  # creates .env if missing, registers &
                                  # starts kachibot.service (auto-restart +
                                  # boot start). Stops with clear error if
                                  # .env is missing so you can fill it first.
```
Then: `sudo journalctl -u kachibot -f` for logs,
`sudo systemctl restart kachibot` after any change.

### Option C — bare loop (no installs)
```bash
nohup bash start-forever.sh &     # or just: bash start-forever.sh
```
Auto-restarts on crash, logs to `data/kachibot.log`. No boot-start.

> All three rely on the app's crash guards (uncaught errors are logged, then
> the supervisor brings it back). The bot also re-hydrates watchers and
> sweeps interrupted trades on every boot, so restarts are safe.

### Option C2 — Render free tier (no PC; $0 — until Oracle works out)
Bridge hosting while testing: KACHIBOT now serves a health endpoint on `$PORT`,
so a free Render web service + UptimeRobot can keep it awake 24/7 (Render free
web services sleep after 15 min idle; a ping every 5 min prevents that).

1. https://render.com → sign up (may ask for a card for web services — if it
   does and you can't, fall back to Oracle/paid options).
2. New → **Web Service** → connect a GitHub repo containing this project
   (push the folder, minus .env) OR use Render's **Blueprint** with the
   included `render.yaml`.
3. Settings:
   - Build: `npm install && npm run build`
   - Start: `node dist/index.js`
   - Env vars: paste every key from §2 (`TELEGRAM_BOT_TOKEN`, `ENCRYPTION_KEY`,
     `RPC_*`, `HELIUS_DAS_URL`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`) — Render
     injects `PORT` automatically.
   - Region: **Frankfurt** (eu-central) for best Telegram latency.
4. Deploy → open the service URL → `/` returns `{"ok":true,...}`.
5. https://uptimerobot.com (free, no card) → add HTTP monitor hitting
   `https://<your-service>.onrender.com/` every **5 minutes** → instance never
   sleeps. 750 free hours/mo ≈ 31 days, so one service fits the month.
6. Stop the sandbox copy when Render is confirmed live (never two pollers on
   one token).

### Option D — Oracle Cloud Free Tier (no PC needed; $0 forever)
Recommended when you have no always-on PC. You get an Always-Free ARM VM
(4 OCPU / 24 GB RAM / up to 200 GB storage) that runs the bot 24/7.

1. Sign up at https://www.oracle.com/cloud/free/ (card required to verify
   identity — only used for that; free tier is never billed unless you
   upgrade to paid).
2. Console → **Compute → Instances → Create instance**:
   - Image: **Ubuntu 24.04** (Canonical, ARM)
   - Shape: **Ampere A1 Flex** (choose e.g. 2 OCPU / 12 GB RAM — inside the
     Always-Free envelope)
   - **Add SSH keys** → “Generate a key pair” → download both files and save
     them somewhere safe (the private key is your only way in)
   - Create → wait until **Running** → copy the **Public IP**
3. From your computer, upload the deploy bundle and run the installer
   (Windows PowerShell, in the folder where you saved the key + bundle):
   ```powershell
   scp -i oracle-key.pem kachibot-bundle.tar.gz ubuntu@PUBLIC_IP:~/
   ssh  -i oracle-key.pem ubuntu@PUBLIC_IP
   # on the server:
   tar xzf kachibot-bundle.tar.gz && cd kachibot
   sudo bash deploy/install-vps.sh     # installs Node, builds, starts service
   sudo nano /opt/kachibot/.env        # ONLY if the script asked you to fill keys
   sudo bash deploy/install-vps.sh     # re-run after filling .env
   ```
4. Check it: `sudo journalctl -u kachibot -f` → you should see
   `KACHIBOT up … ready to mirror apes`. The service auto-restarts on crash
   and auto-starts on reboot — true 24/7.
   > The bot makes outbound calls only — no extra firewall ports needed; SSH
   > (port 22) is already open by Oracle’s default security list.

> **Important:** this chat's sandbox keeps the bot alive only while this
> workspace session is open. Real 24/7 means running it on *your* machine
> (Option A/B/C above). Copy the whole project folder (incl. `.env` — keep it
> private) to that machine and start it there.

---

## 5. First-run checklist (in Telegram)

1. Open the bot → `/start` → welcome shows the 3 setup steps.
2. **💼 Wallet → Generate** (this wallet buys). Send it a small SOL amount
   (rent + fees; snipes need ammo too).
3. **⚙️ Settings** → buy size (fixed SOL or % of watched spend), slippage,
   TP/SL ladder, daily & per-trade caps, cooldown, honeypot toggle.
4. **👀 Watchlist → Add** → wallet address or `pump.fun/coin|profile/…` link.
5. Wait for a buy → snipe alert with chart link → exit prints the scorecard.

---

## 6. Ops notes

- **Latency:** Helius over public RPC; honeypot simulation adds ~0.5–1s (you
  can toggle it off for speed, on for safety). Jito tips help on hot launches.
- **Trade mechanics (protocol reality):** pre-graduation pump trades are
  executed by replaying a live same-coin instruction template (no IDL
  guessing) and are simulation-gated. First-time snipes for a mint need the
  watched wallet's buy as the reference — that's the event that triggers you,
  so the flow always has one. If a fresh mint has no valid template, the bot
  refuses cleanly instead of sending junk.
- **Backups:** `data/` (if local store) + `.env` + your `ENCRYPTION_KEY`.
  Losing the key = losing access to imported wallet secrets.
- **Troubleshooting quick hits:**
  - `429 Too Many Requests` → public-RPC rate limit; use the Helius URL.
  - Boot error about Supabase tables → run the schema (section 3).
  - Bot silent in Telegram → check the token in `.env`, restart.
  - Wrong avatar cached in BotFather → re-send `/setuserpic` with a fresh copy.

## 7. Layout (code map)

```
src/index.ts     boot: config → store → sweep → watcher → checker → bot
src/bot.ts       Telegram UI (inline keyboards only), welcome, menus
src/watcher.ts   wallet subscriptions, tx decode, template capture, signals
src/trader.ts    execution: caps, curve/jupiter buys+sells, TP/SL, scorecards
src/chain/       pump.ts (empirical discs + template engine), jupiter.ts,
                 send.ts, conn.ts, meta.ts
src/crypto.ts    AES-256-GCM secrets, keypair/mnemonic helpers
src/db.ts        Supabase jsonb store (or local JSON fallback)
src/format.ts    branded copy: welcome, alerts, scorecards
supabase/        schema.sql
test/            node:test suites + live fixtures (test/fixtures/live)
```
