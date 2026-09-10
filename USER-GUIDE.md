# KACHIBOT — User Guide

**KACHIBOT** is a Telegram bot (`@TexSnipeBot`) that watches other Solana wallets for you. Add a wallet you want to follow, and every time that wallet **buys** a token, KACHIBOT **buys the same token for you**, using the money in *your* bot wallet. It can then sell for you automatically — at your chosen profit targets, at your own rules, or when the wallet you follow sells. Every finished trade gets a simple scorecard.

No web app. Everything happens inside this Telegram chat, with buttons.

---

## 60-second start

1. Press **START** or send `/start`.
2. Tap **💼 Wallet** → **✨ Generate new wallet** → reply **yes**.
   - A **24-word backup phrase** appears. **Write it down now.** It is shown once and then erased from the chat.
3. Send a little **SOL** (0.05–0.1 is enough to test) to the address shown on the wallet screen — send it from any exchange or wallet you already have, over the **Solana network**.
4. Tap **⚙️ Settings** and check the numbers (explained below).
5. Tap **👀 Watchlist** → **➕ Add target** and paste the address of a wallet you want to copy.

Done. From then on the bot watches and copies by itself. Test with small amounts first.

---

## 1. Your wallet

Your wallet is the wallet KACHIBOT **spends from**. It lives inside the bot, and its keys are stored **encrypted** (AES-256-GCM). KACHIBOT can only move money from it if you asked it to.

### Create a wallet
Wallet screen → **✨ Generate new wallet** → reply **yes** to confirm.

- You get a **24-word backup phrase**. It is shown **once** — KACHIBOT deletes that message from the chat after you confirm.
- The bot also keeps an encrypted copy so you can export it later (with your PIN).
- **If you lose both the phrase and your PIN access, the money is gone.** Write the phrase on paper or in a password manager *before* funding the wallet.

### Fund the wallet
On the wallet screen you'll see:

```
Address: 7xKX...yourAddress...
```

That long code is your wallet's public address — it's safe to share. Anyone can send SOL to it; only the phrase/key can take money *out*.

- Send SOL from an exchange or another wallet, selecting the **Solana** network when withdrawing.
- The balance starts as **◎0** and updates itself a moment later. Tap **⟳ Refresh** any time.
- Deposits usually appear within seconds. If the balance stays 0 after a minute, check the transaction on the explorer link (solscan.io) — 99% of the time the SOL went to the wrong network.

### Add a wallet you already own
Wallet screen → **📥 Import** → paste **either**:

- a **12- or 24-word seed phrase** (the words, in order, lower-case), or
- a **private key** (base58, hex, or a 64-number JSON array).

The imported wallet becomes your active wallet. Importing adds a *new* wallet — it never overwrites an existing one.

### Multiple wallets
You can hold several wallets at once and switch between them:

- **🔁 Switch** buttons at the bottom of the wallet screen take you to your other wallets.
- **✏️ Rename** gives a wallet a custom name (up to 24 characters).
- **➕ New** creates another; **📥 Import** adds one you already own.
- **🗑 Delete** removes a wallet from the bot after you type the word `DELETE`.

Deleting only removes the wallet *from KACHIBOT*. The money on the blockchain stays yours — but you can only reach it again with the phrase/key, so **export or write down the backup before deleting**.

### Receive SOL
Wallet screen → **📥 Receive** shows your current address and a link to view it on the explorer. Send SOL to the address labelled `Address:`.

### Send SOL
Wallet screen → **📤 Send**, then:

1. Paste the destination address (the one you're paying).
2. Type the amount in **SOL** (e.g. `0.05`).
3. If you set a PIN, type it to approve.
4. You get a confirmation with a link to the transaction.

Sending costs a tiny network fee, paid from your wallet (a fraction of a cent).

### Export (backup) and PIN
- **🔐 PIN** — set a PIN (4–32 characters). Once set, **exports**, **sends** and **Panic sell-all** ask for it. The PIN is stored only as a scrambled hash; if you forget it, set a new one (it replaces the old).
- **📋 Export** — after entering your PIN, choose what to copy:
  - **🪪 Seed phrase** — your 12/24 words. Only available if the wallet was created here or imported with a phrase.
  - **🔑 Private key** — the raw signing key. Works with any Solana wallet app.

> Anyone who sees the phrase or private key **owns the wallet**. Store them offline. Never paste them into websites, other bots, or DM helpers. No legitimate service — including KACHIBOT — will ever ask you for them.

---

## 2. Settings (⚙️)

Tap **⚙️ Settings** to see your current setup. Tap any row to type a new value; tap a toggle button to switch it on/off. Everything below uses the values exactly as they appear in the app.

### How big your copy-buys are
| Setting | What it does | Default | Allowed |
|---|---|---|---|
| **💰 Buy amount (SOL, fixed)** | Every copy-buy spends this much SOL (when in fixed mode). | 0.005 SOL | 0.0001 – 100 |
| **📊 Copy % of watched spend** | Buy a percentage of what the watched wallet spent (when in % mode). Watched wallet buys 1 SOL → you buy this % of 1 SOL. | 50% | 1% – 200% |
| **Mode button** | Top of the settings screen switches between **fixed SOL** and **% of spend**. | fixed | tap to toggle |

Example: mode **%**, copy **20%**, wallet buys 0.5 SOL → you buy 0.1 SOL.

> Each watched wallet can also have **its own** size — see **💰 buy size** in §3.

### Buying behaviour
| Setting | What it does | Default | Allowed |
|---|---|---|---|
| **💧 Slippage %** | How much price may move between the moment a buy is spotted and your buy landing, before the bot gives up. Meme coins move fast — 25% is normal here. | 25% | 1% – 100% |
| **⚡ Fee cap per tx (SOL)** | Most the bot may pay in network fees (priority/tip) for one transaction. Higher = your buy lands faster. | 0.001 SOL | 0.00001 – 0.2 |
| **📏 Min-spend filter (SOL)** | Ignores watched-wallet buys *smaller* than this. | 0.0001 | 0.00001 – 100 |
| **📏 Max-spend filter (SOL)** | Ignores watched-wallet buys *bigger* than this. | 100 SOL (effectively off) | 0.0001 – 5000 |
| **🪫 Per-trade cap (SOL)** | Hard ceiling for a single copy-buy, whatever the mode says. | 0.05 SOL | 0.0001 – 10 |
| **🪫 Daily spend cap (SOL)** | Hard ceiling on all copy-buys in one day. Resets daily. | 0.5 SOL/day | 0.001 – 100 |
| **⏱ Watch cooldown (seconds)** | Minimum gap between two copy-buys from the same watched wallet. | 10s | 1 – 600 |
| **🛡 honeypot check** | Before buying, the bot tests the token's contract for traps (can't-sell scams, blacklists) and rejects bad ones. Keep it ON. | ON | toggle |

### Protection & trust
| Setting | What it does | Default | Allowed |
|---|---|---|---|
| **📈 Trail arm at (X)** | Trailing stop: the multiple at which trailing **starts** (e.g. `3x`). Once a position reaches it, KACHIBOT remembers the peak and sells if price gives back your *Trail back %*. | off until set (3x when on) | 1.05 – 1000 |
| **📉 Trail back %** | How far the price may fall back from the peak before the trailing stop sells (`25` = sell after giving back 25% of the peak). | 25 | 1 – 90 |
| **🎏 trailing** (toggle) | Switches the trailing stop on/off. | OFF | toggle |
| **🎗 break-even stop** | After your **first** take-profit rung banks profit, the stop on the remaining bag moves up to break-even — the trade can no longer end in a loss. | ON | toggle |
| **⏳ Max hold (hours)** | Auto-exit any position older than this, whatever the price (`0` = off). | off | 0 – 720 |
| **⚠️ Low balance alert (SOL)** | Warns you (at most once every 6h) when your wallet dips below this, *before* a watched wallet apes and the copy gets blocked. `0` = off. | 0.02 SOL | 0 – 100 |
| **🧾 Judge ape after N copies** | Reputation filter: don't form an opinion until the wallet has this many closed copies — stops a good wallet being judged on two unlucky trades. | 10 | 1 – 100 |
| **📉 Min ape win rate %** | Reputation filter: the win-rate floor. A wallet below it is treated as weak and your *weak ape* action applies. | 30 | 0 – 100 |
| **👤 reputation** (toggle) | Switches the reputation filter on/off (see §4). | OFF | toggle |
| **🧾 weak ape → SKIP / HALVE** | What to do with a wallet below your win-rate floor: copy nothing, or copy at half size. | SKIP | tap to toggle |

### When to sell
| Setting | What it does | Default | Allowed |
|---|---|---|---|
| **🎯 TP ladder (e.g. 2x,3x,5x or more)** | Take-profit steps, as multiples of your buy price. Type them however you like — `2x,3x,5x`, `2,3,5` or `1.5x 4x 10x` all work. With `2x,3x`: half your position is sold at 2x (100% profit) and the other half at 3x (200% profit). Up to 5 steps; they are sorted and de-duplicated for you. | 2x, 3x | any multiple 1.01 – 1000, up to 5 |
| **🛑 Stop-loss %** | If the price falls this much, everything left is sold automatically. | -50% | 1% – 99% |
| **👻 copy-sell** | When ON, the bot also mirrors the watched wallet's **sells** — if they dump, you dump (subject to your **exit rule**). When OFF, you only follow their buys and your own rules decide the exits. | OFF | toggle |
| **💸 Exit rule** | How a copied position is exited: **Follow** = sell 100% the moment the ape sells · **Sell %** = sell only a slice · **Hold** = never follow its sells · **Sell at X** = exit the whole bag at your multiple · **Sell at mcap** = exit at a market cap. Set one default for all wallets here, and/or a different rule per wallet (§3). | follow ape | see §5 |

> **A practical starting point:** fixed mode, 0.02–0.05 SOL per buy, slippage 25%, TP ladder `2x,3x`, stop-loss -50%, break-even ON, caps that match your budget. Copy-buys land *after* the wallet you follow — that's the nature of copy trading: they set the pace, you ride the move.

---

## 3. Watchlist (👀) — who you follow

Tap **👀 Watchlist** to manage targets. You can watch **several wallets at the same time**, and every target is watched simultaneously.

**Add a target** — paste one of these:

- a plain **Solana wallet address** (the long code from a trader's profile), or
- a **pump.fun coin link** — the bot follows the coin's *creator* wallet (the wallet that launches it), or
- a **pump.fun profile link** — note: copy the *address* from the profile page; @usernames aren't supported.

Each new target is labelled `ape #1`, `ape #2`… A watched wallet only triggers buys while it's **live** (not paused) and only if the buy passes your **settings** filters.

### The target card

Tap a target to see its card, for example:

```
👁 ape #1
Address: CcJX97…
source: pump.fun link
⏱ watching for 2d 3h · 🟢 live          (or ⏸ paused for 1h · watched 2d total)
🕓 last buy seen 12m ago
💸 exit: follow ape — sell all (default)
💰 size: 0.0050 SOL fixed (default)
⏳ confirm: copy instantly
🧾 reputation: 22% win / 14 copies — copies skipped
📊 copies closed: 9 · win rate 44% · avg return +18% · realized +0.041 SOL
```

- **🟢 live / ⏸ paused** — whether it is being copied right now, and for how long.
- **🕓 last buy seen** — when this wallet last bought anything on-chain (it buys often, even if you don't copy it).
- **💸 exit / 💰 size / ⏳ confirm** — this wallet's own rules; `(default)` means it inherits your global setting.
- **🧾 reputation** — only shown when the reputation filter is on (§4).
- **📊 performance** — win rate, average return and realized SOL from copies of *this* wallet.

### Per-wallet controls

| Button | What it sets | Options |
|---|---|---|
| **💸 exit rule** | How positions copied from this wallet are closed (§5) | follow / sell % / hold / sell at X / sell at mcap / use global default |
| **💰 buy size** | How much to spend per copy from this wallet | fixed SOL / % of this ape's spend / use global default |
| **⏳ confirm hold** | Wait and verify the ape still holds before copying (§4) | instant / 15s / 30s / 60s / custom (5–600s) |
| **⏸ pause / ▶️ resume** | Stop or restart copying this wallet without removing it | — |
| **🗑 remove** | Stop watching it | — |

Your **per-trade cap** always wins over any buy size, and a rule only applies to coins copied *from that wallet* from the moment you set it — open positions keep the rule they were opened with.

---

## 4. Trust rules — reputation filter & confirm-hold

Two tools decide **whether to trust an ape at all**. They solve the same problem in opposite ways: one uses history (free), one uses waiting (costs entry price).

### 👤 Reputation filter — judge by track record (no delay)
⚙️ **Settings → 👤 reputation**

Once a wallet has **N closed copies** (default 10), KACHIBOT looks at the win rate of the trades that wallet produced for you. Below your floor (default 30%), the wallet is treated as weak and either **skipped** or **copied at half size** (`🧾 weak ape → SKIP / HALVE`).

- It **never blocks a new wallet** — a target with 9 closed copies is always trusted.
- Open positions and other wallets never count towards a wallet's record.
- Skips are always explained: *"🧾 SKIPPED — WEAK APE — ape #3 is at 18% win rate over 12 copies, below your 30% floor. No funds spent."*
- **Costs you nothing in speed** — the judgement comes from history, not from waiting.

### ⏳ Confirm hold — wait and check (per wallet, off by default)
👀 **Watchlist → tap a wallet → ⏳ confirm hold**

KACHIBOT waits your chosen delay after the ape buys, checks on-chain that they **still hold** their tokens, and only then copies. If they dumped **≥50%** inside the window, the copy is skipped:

> *"🚫 SKIPPED — INSTANT DUMP — ape #2 sold 100% of their Coin ($SYM) within 30s of buying. Nothing copied."*

- Presets: **15s / 30s / 60s**, or any custom value from **5 to 600** seconds.
- A small trim (say 30%) is **not** treated as a dump — only ≥50% is.
- If the balance check can't be made (network hiccup), the bot **copies anyway** — a bad RPC should never cost you a trade.
- Pending waits live in memory: if the bot restarts mid-wait, that copy is simply dropped. Nothing is ever bought late at a stale price.

> **Which should you use?** Turn the **reputation filter** on once each wallet has ~10 closed copies — it's free protection. Use **confirm hold** surgically, only on a wallet you don't trust to hold: on a coin that runs, waiting 30 seconds means entering much higher. Leave it off for apes whose speed *is* the edge.

---

## 5. Exit rules (💸) — how each copied position is closed

Copy-sell used to be all-or-nothing: the watched wallet sold, you sold everything. Now **you choose** how each position exits.

| Rule | When the watched wallet sells | Otherwise |
|---|---|---|
| 👻 **Follow ape — sell all** | Your whole position is sold (classic copy-sell) | TP ladder + stop-loss still guard it |
| 🔢 **Sell %** | Only that % of your bag is sold (e.g. 50%) — the rest stays open | TP ladder + stop-loss still guard the rest |
| 🙌 **Hold** | Nothing — you stay in | TP ladder + stop-loss still guard it |
| 🎯 **Sell at X** | Nothing — you stay in | Whole bag sold when it hits your multiple (e.g. 3x) |
| 📈 **Sell at mcap** | Nothing — you stay in | Whole bag sold when the coin hits your market cap (e.g. 100k) |

**Where to set it**
- **⚙️ Settings → 💸 Exit rule (all wallets)** — your default for every wallet.
- **👀 Watchlist → tap a wallet → 💸 exit rule** — override for that wallet only (`↩️ use global default` puts it back).

**Notes that matter**
- A rule applies to coins copied **from that wallet** from the moment you set it; open positions keep the rule they were opened with.
- 🎯 and 📈 targets **replace** the TP ladder for that position — stop-loss, trailing and rug protection still apply.
- Market caps are compared in **USD** using a cached SOL price; if the price feed is unreachable for a moment, the ladder keeps guarding the position until it recovers.
- 🙌 Hold and the target rules do **not** need copy-sell to be ON — they are your own exits, not mirrors of the ape.

---

## 6. What happens when they buy

1. The watcher spots a buy from a wallet you follow (and names the coin in full, with the exact SOL that wallet spent).
2. Trust checks: **reputation filter** (skip/halve a weak ape) and **confirm hold** (wait and verify they still hold).
3. Settings checks: min/max spend filters, caps, cooldown, honeypot/sim check, enough SOL in your wallet.
4. If everything passes, KACHIBOT buys the same token for you — on the bonding curve, or via a DEX route if the coin already graduated off it — and a **position** opens.
5. Then it manages the exit automatically:
   - **trailing stop** (if armed) sells when price gives back your % from the peak;
   - **break-even stop** protects the remainder once the first rung banked profit;
   - **max hold time** exits anything older than your limit;
   - **stop-loss** sells everything if price drops to your limit;
   - **TP ladder** sells portions as price hits each multiple;
   - **copy-sell** (if ON) follows your **exit rule** — sell all, a %, or nothing;
   - a **rug guard** watches for liquidity pulls/scams and bails out if detected.
6. When the position is fully closed you get a **trade card**: bought, sold, PnL in SOL and %, how long it was held, and why it exited (TP / trailing / stop-loss / copy-sell / max hold / rug / manual).

### Screens
| Screen | Button / command | Shows |
|---|---|---|
| **📡 Positions** | `/positions` or Main → 📡 Positions | Every trade still open: token, SOL in, live value, multiple (e.g. 1.43x), age. Buttons: **💸 sell** (close one now), **📡 card** (details), **🧯 Panic sell-all**. |
| **📖 History** | `/history` or Main → 📖 History | All trades: closed (green/red with profit), open, and failed. Running PnL, win rate, average return. Every closed trade has a **🏆 card** button. |
| **🔔 Alerts** | Main → 🔔 Alerts | What messages the bot sends: **🎯 snipes** = copy-buy outcome cards (locked / failed / dodged) — off means it buys silently; **💸 sells** = TP-step sells and closed-trade scorecards; **👁 activity** = radar notes on wallets you watch (off by default). Protection warnings (blocks, rug sweeps, caps) always reach you. Every alert names the coin in full (name + ticker) and shows the exact SOL the watched wallet spent. Each is a simple on/off toggle. |
| **🧯 Panic sell-all** | Main → 🧯 Panic | Dumps *every* open position right now. Asks for your PIN (or a `yes` if no PIN is set). Use it when you want out of everything instantly. |

A **failed** or **skipped** buy stays in History with the reason — common ones:

- *slippage too tight* — price moved more than your Slippage % before the buy landed;
- *cap hit* — per-trade or daily cap reached;
- *honeypot / rug detected* — the bot's protection rejected the token;
- *wallet empty* — no SOL left for the buy + fee (you'll also get a **⚠️ LOW BALANCE** heads-up before this happens);
- *cooldown* — this wallet bought again too soon after the last copy;
- *weak ape* — the reputation filter skipped a wallet below your win-rate floor;
- *instant dump* — confirm-hold caught the ape selling ≥50% within the wait window.

---

## 7. All commands

| Command | What it does |
|---|---|
| `/start` | Opens the main screen (first time: the 3-step welcome). |
| `/main` or `/menu` | Return to the main screen from anywhere. |
| `/wallet` | Open your wallet (create, import, send, receive, export). |
| `/settings` | Open trading settings. |
| `/watch` | Open the watchlist. |
| `/watch <address>` | Immediately start watching a wallet address. |
| `/watch <pump.fun link>` | Watch a coin's creator (coin link) or a profile (address link). |
| `/positions` | See open trades and their live value. |
| `/history` | See all past trades and scorecards. |
| `/panic` | Sell every open position immediately. |
| `/guide` | Link to this user guide. |
| `/help` | Quick orientation list. |
| `/cancel` | Abort whatever the bot is waiting for (e.g. a value or PIN prompt). |

Tip: any plain message with no command in progress opens the main screen.

---

## 8. Money, fees, safety

- **The bot is free** and takes no fee or commission on your trades. The only costs are the **SOL network fees** and the **trades themselves**, all paid from your wallet.
- Only fund the bot wallet with money you're willing to lose on meme-coin copy trades. Copy trading is **not financial advice** — it is high-risk, fast-moving speculation. Start small.
- Keys are encrypted at rest and decrypted only to sign your trades or to export (behind your PIN).
- This bot is **open to anyone** who finds it on Telegram: your wallet is protected by your Telegram account + PIN. Keep your Telegram session safe and use a PIN.
- Nobody at KACHIBOT will ever DM you asking for your phrase, PIN, or SOL. Anyone who does is a scammer.
- If the bot ever seems unresponsive, `/start` it again — the main screen confirms it's alive. A response can take a few extra seconds right after a period of inactivity.

---

## 9. Troubleshooting

**Balance still ◎0 after a deposit?**
Tap **⟳ Refresh**. If it's still 0, check the deposit transaction on the solscan link from the Receive screen — most likely the SOL was sent on the wrong network (must be **Solana**, not BNB/Ethereum/other).

**The watched wallet bought but I didn't?**
Check, in order:

1. Is the target **paused**?
2. Did the **reputation filter** skip it (wallet below your win-rate floor)?
3. Did **confirm hold** catch the ape dumping inside the wait window?
4. Is the buy above your **min-spend** and below **max-spend**?
5. Did a **cap** run out (daily cap resets daily) or was it inside the **cooldown** window?
6. Does the wallet hold enough **SOL**? Is **honeypot check** rejecting it?

Every skip and rejection is recorded in **History** with its reason.

**I keep getting ⛔ SNIPE BLOCKED.**
Your wallet doesn't have enough SOL for the copy + fee + buffer. The message tells you exactly how much you need. Fund the wallet — and watch for the **⚠️ LOW BALANCE** warning that fires *before* the next ape buys.

**My position hasn't sold even though it's in profit.**
Check which exit applies: with a **🎯 Sell at X** or **📈 Sell at mcap** rule, the ape selling is not a signal — the position waits for *your* target. With **🙌 Hold**, only your TP ladder, trailing stop, stop-loss or max-hold time will close it. You can always sell manually from **📡 Positions**.

**Send failed?**
The destination must be a valid Solana address and your balance must cover amount + network fee. Confirmed sends can't be reversed.

**Import failed?**
A seed phrase must be exactly **12 or 24 words**, all lower-case, in order. A private key must be complete (base58, hex, or 64-number array) with nothing else in the message. Only one format per message.

**I want out of everything now.**
Main → **🧯 Panic sell-all**, then confirm with your PIN (or `yes`).

**I lost my phone / Telegram session.**
Reinstall Telegram, sign back in, and open the bot. Your wallets and history are saved on KACHIBOT's server. Your backup phrase stays the ultimate fallback — this is why you wrote it down.

---

*Short words used above: **SOL** — Solana's coin. **Slippage** — how much extra price you accept to get the buy through. **TP** — take-profit. **SL** — stop-loss. **Ape** — a trader you copy. **Honeypot** — a token you can buy but never sell. **Rug** — developers pull the money and the price collapses. **Bonding curve** — the automated price ladder pump.fun coins use before they "graduate" to open trading. **mcap** — market cap, the coin's total value. **Trailing stop** — a stop that follows the price up and only sells when it falls back by your chosen amount. **Break-even** — the price at which you neither win nor lose.*
