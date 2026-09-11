# KACHIBOT — User Guide

KACHIBOT (@TexSnipeBot) copies other Solana wallets. You add a wallet to follow; when it **buys** a token, KACHIBOT buys that token for you with the SOL in **your bot wallet**, manages the exit, and sends a scorecard when the trade closes.

Everything happens in this chat, with buttons.

---

## Start in 60 seconds

1. `/start`
2. **💼 Wallet → ✨ Generate new wallet → yes** — write down the 24-word backup phrase now (shown once, then deleted).
3. Send **SOL** (0.05–0.1 to test) to the address on the wallet screen, using the **Solana** network.
4. **⚙️ Settings** — check your numbers (see below).
5. **👀 Watchlist → ➕ Add target** — paste a wallet address or pump.fun link.

That's it. It copies on its own from there. Start small.

---

## Your wallet (💼)

The wallet KACHIBOT spends from. Keys are encrypted; your **PIN** guards sends, exports and panic-sell.

| Action | How | Note |
|---|---|---|
| Create | 💼 Wallet → ✨ Generate | 24-word phrase shown **once** — lose it and the PIN, lose the money |
| Fund | 💼 Wallet → 📥 Receive | Send SOL on **Solana** only; tap ⟳ Refresh |
| Import | 💼 Wallet → 📥 Import | 12/24-word phrase **or** private key |
| Multiple wallets | 🔁 Switch / ➕ New / ✏️ Rename | 🗑 Delete removes it from the bot — back it up first |
| Send | 💼 Wallet → 📤 Send | Address → amount → PIN |
| Backup | 💼 Wallet → 📋 Export | Seed phrase or private key, after PIN |
| PIN | 💼 Wallet → 🔐 PIN | 4–32 chars; required for sends/exports/panic |

> Nobody at KACHIBOT will ever DM you for your phrase, PIN or SOL. Anyone who does is scamming you.

---

## Main screen

| Button | What it's for |
|---|---|
| 💼 **Wallet** | Create, fund, import, send, export |
| 👀 **Watchlist** | Wallets you copy |
| 📡 **Positions** | Open trades, live value, sell buttons |
| 📖 **History** | Closed trades, PnL, win rate, scorecards |
| ⚙️ **Settings** | All trading rules |
| 🔔 **Alerts** | Which messages you receive |
| 🧯 **Panic** | Sell everything now |

---

## Settings (⚙️)

Tap a row to type a new value; tap a toggle to switch it.

**Size**
| Setting | Default |
|---|---|
| 💰 Buy amount (fixed mode) | 0.005 SOL |
| 📊 Copy % of watched spend (% mode) | 50% |
| Mode button (top of screen) | fixed |

**Buying**
| Setting | Default |
|---|---|
| 💧 Slippage % | 25% |
| ⚡ Fee cap per tx | 0.001 SOL |
| 📏 Min / Max spend filter | 0.0001 / 100 SOL |
| 🪫 Per-trade cap | 0.05 SOL |
| 🪫 Daily cap | 0.5 SOL/day |
| ⏱ Cooldown (same wallet) | 10s |
| 🛡 Honeypot / rug check | ON |

**Protection**
| Setting | Default |
|---|---|
| 🎏 Trailing stop (📈 arm at X, 📉 give back %) | off · 3x · 25% |
| 🎗 Break-even stop (after first TP, rest can't lose) | ON |
| ⏳ Max hold time (`0` = off) | off |
| ⚠️ Low-balance alert (`0` = off) | 0.02 SOL |
| 👤 Reputation filter (🧾 after N copies, 📉 min win %, 🧾 weak ape → SKIP/HALVE) | off · 10 · 30% · SKIP |

**Selling**
| Setting | Default |
|---|---|
| 🎯 TP ladder (e.g. `2x,3x,5x`) | 2x, 3x |
| 🛑 Stop-loss % | -50% |
| 👻 Copy-sell (mirror the ape's sells) | OFF |
| 🪞 On their sell → MIRROR their % / dump ALL | mirror |
| 💸 Exit rule | follow ape — sell all |

---

## Watchlist (👀) — who you copy

**Add a target:** paste a Solana wallet address, a **pump.fun coin link** (follows the coin's creator), or a **pump.fun profile link** (copy the address, not the @username). You can watch several at once.

Tap a target for its card:

```
👁 ape #1
Address: CcJX97…
⏱ watching for 2d 3h · 🟢 live        (or ⏸ paused for 1h)
🕓 last buy seen 12m ago
💸 exit: follow ape — sell all (default)
💰 size: 0.0050 SOL fixed (default)
⏳ confirm: copy instantly
📊 copies closed 9 · win rate 44% · +0.041 SOL
```

**Buttons on a target**

| Button | Sets |
|---|---|
| 💸 **exit rule** | How this wallet's positions close (see below) |
| 💰 **buy size** | Its own size: fixed SOL or % of its spend |
| ⏳ **confirm hold** | Wait 15/30/60s (or custom) and verify it still holds before copying |
| ⏸ **pause / ▶️ resume** | Stop/resume copying without deleting |
| 🗑 **remove** | Stop watching |

Anything marked **(default)** inherits your global setting. Per-wallet rules apply to coins copied from that wallet from the moment you set them.

---

## Trust rules (optional)

- **👤 Reputation filter** (⚙️ Settings) — once a wallet has **N closed copies** (default 10), a win rate below your floor (default 30%) means it's **skipped** or **copied at half size**. Free: uses history, costs no speed. Turn it on once each wallet has ~10 closed copies.
- **⏳ Confirm hold** (per wallet) — wait, then check the ape still holds; skip if they dumped **≥50%** in the window. Use only on wallets you don't trust to hold — waiting means entering higher on a runner.

---

## Exit rules (💸) — how a position closes

| Rule | When the ape sells | Otherwise |
|---|---|---|
| 👻 **Follow — sell all** | Sells 100% | TP ladder + stop-loss guard it |
| 🔢 **Sell %** | Sells your slice (e.g. 50%), rest stays open | Same |
| 🙌 **Hold** | Nothing | Same |
| 🎯 **Sell at X** | Nothing | Sells all at your multiple (e.g. 3x) |
| 📈 **Sell at mcap** | Nothing | Sells all at your market cap (e.g. 100k) |

Set a default in ⚙️ Settings, or per wallet from its card. 🎯/📈 replace the TP ladder for that position; stop-loss, trailing and rug protection always still apply. 🙌 Hold and targets don't need copy-sell ON.

**Copying a partial sell (moonbags).** Turn copy-sell ON and pick the mode under it:

| Mode | What the bot does when the ape sells |
|---|---|
| 🪞 **Mirror** (default) | Sells the *same % of your bag* they sold of theirs. Sell 60% → you sell 60% and keep a 40% moonbag. They take profit again → you mirror again. |
| 📤 **Dump all** | Sells 100% on their first sell, whatever size theirs was. |

While a moonbag is open, stop-loss, trailing, break-even, max hold and the TP ladder still guard it, and 💸 Sell now on the position card always dumps the rest.

---

## What happens when they buy

1. Watcher spots the buy — and names the coin plus the exact SOL spent.
2. Checks: reputation filter → confirm hold → min/max spend → caps → cooldown → honeypot → enough SOL.
3. Buy lands (bonding curve, or a DEX route if the coin graduated). A **position** opens.
4. Exits are automatic: trailing stop → break-even → max hold → stop-loss → TP ladder → copy-sell (your exit rule) → rug guard.
5. On close you get a **trade card**: PnL in SOL and %, hold time, and why it exited.

**Screens:** 📡 Positions (open trades, 💸 sell, 🧯 Panic sell-all) · 📖 History (all trades + 🏆 trade cards) · 🔔 Alerts (snipes / sells / activity) · 🧯 Panic (dump everything, PIN required).

## 🏆 PnL scorecard

One card for the whole account — tap **🏆 PnL** on the main screen or from 📖 History:

| Line | What it tells you |
|---|---|
| Headline | Total profit in SOL and USD, plus your return % on everything you copied |
| wins / avg win / avg loss / best / worst | How that profit was made |
| bought → sold | SOL in vs SOL back |
| who earned it | Profit per watched wallet, with that ape's win rate — the copy-trader's edge |
| open / live pnl | What your open bags are worth right now |
| last 7d | Recent form |

Only closed trades count as realized. Open positions show unrealized PnL priced live.

## 📡 Live position card

Tap any running trade in 📡 Positions for its exchange-style card:

| Line | What it tells you |
|---|---|
| Headline | Profit in SOL and USD, the multiple, and your % on what you spent |
| position / spent / banked | Worth now · what it cost · what partial sells already banked |
| entry mcap → now mcap | Where you got in vs where it trades now (+% move) |
| avg entry / now | Price per token then and now |
| bag | How much of the position is still open vs already banked |
| peak / opened / copied | Best multiple seen, when it opened, which wallet you copied |
| guards | TP ladder, stop-loss, trailing, break-even state |

Buttons: **💸 Sell 25% / 50% / all** (take profit and keep a moonbag) · **🔄 Refresh** re-prices it.

The headline counts SOL already banked plus what's still held, so partially sold positions show your true profit.

If a buy doesn't happen, **History** shows why: slippage too tight, cap hit, cooldown, wallet empty, honeypot, weak ape, or instant dump.

---

## Commands

`/start` · `/main` · `/wallet` · `/settings` · `/watch` · `/watch <address or link>` · `/positions` · `/history` · `/panic` · `/guide` · `/help` · `/cancel`

---

## Safety

- The bot is free and takes **no commission** — you pay only Solana network fees and your trades.
- Only fund it with money you can afford to lose. Copy trading is high-risk speculation, not advice.
- Keys are encrypted; your wallet is protected by your Telegram account + PIN.
- Keep the instance awake with a monitor — a free host sleeps when idle.

---

## Troubleshooting

**Balance still 0?** Tap ⟳ Refresh; check the deposit went over the **Solana** network.

**They bought, I didn't?** In order: target paused → reputation skip → confirm-hold dump → min/max spend → caps/cooldown → enough SOL → honeypot. Reason is in History.

**⛔ SNIPE BLOCKED?** Not enough SOL for the buy + fee + buffer. The message states the amount; ⚠️ LOW BALANCE warns you before it happens.

**Position not selling?** With 🎯/📈 it waits for *your* target, not the ape. With 🙌 Hold only your TP/SL/trailing/max-hold apply. Sell any time from 📡 Positions.

**Import failed?** Phrase must be exactly 12 or 24 lower-case words in order; a key must be complete (base58/hex/array), one format per message.

**Lost your phone?** Sign back into Telegram and open the bot — wallets and history are on the server. Your backup phrase is the ultimate fallback.

---

*SOL = Solana's coin. Slippage = extra price you accept to get filled. TP = take-profit. SL = stop-loss. Ape = a trader you copy. Rug = devs pull liquidity, price collapses. mcap = market cap. Trailing stop = follows the price up, sells when it falls back by your set amount. Break-even = the price where you neither win nor lose.*
