/**
 * KACHIBOT — Telegram UI. Everything lives in inline keyboards; no web app.
 * Menu tree: main -> wallet / settings / watchlist / positions / history /
 * alerts. Text inputs run on a tiny state machine (next message = value,
 * PIN, address…).
 */
import { Telegraf, Markup, Context } from 'telegraf';
import { PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { getConnection } from './chain/conn';
import { getStore } from './db';
import { UserDoc, WalletRecord, summarizeTrades, validateAndApply, resolveExit, normalizeExit, describeExit, parseExitInput, formatMcapUsd, EXIT_DEFAULT, resolveBuySize, describeBuySize, normalizeTrailing, evaluateReputation, watchReputation, describeConfirmHold, normalizeReputation, type ExitConfig, type ExitMode, type BuySizeConfig, scorecardStats, positionMath } from './types';
import { trader, bustWalletCache } from './trader';
import { watcher } from './watcher';
import { registerNotifier } from './notify';
import {
  decryptSecret, encryptSecret, generateMnemonic, keypairFromMnemonic,
  keypairFromSecret, keypairToSecret, parsePrivateKey,
} from './crypto';
import { solShort, sol, pctSigned, ago, durMs, scorecardText, pnlScorecardText, positionScorecardText, helpIntro, welcomeIntro, LOGO, exitReasonLabel } from './format';
import { parsePumpfunLink, WALLET_ADDR_RE, TELEGRAM_ALLOWED_USER_IDS, PUBLIC_URL } from './config';
import { fetchCurve, isLiveCurve } from './chain/pump';
import { getSolUsd } from './chain/price';
import crypto from 'node:crypto';

type Btn = { label: string; data: string };
type BtnRow = Btn[];
const B = (label: string, data: string): Btn => ({ label, data });
const row = (...btns: Btn[]): BtnRow => btns;
const HTML = { parse_mode: 'HTML' as const, link_preview_options: { is_disabled: true } };

const SETTING_LABELS: Array<[string, string]> = [
  ['💰 Buy amount (SOL, fixed)', 'buy_amount_sol'],
  ['📊 Copy % of watched spend', 'buy_pct'],
  ['💧 Slippage %', 'slippage'],
  ['⚡ Fee cap per tx (SOL)', 'fee_cap'],
  ['🎯 TP ladder (e.g. 2x,3x,5x or more)', 'tp_multiples'],
  ['🛑 Stop-loss %', 'stop_loss'],
  ['📏 Min-spend filter (SOL)', 'min_spend'],
  ['📏 Max-spend filter (SOL)', 'max_spend'],
  ['🪫 Per-trade cap (SOL)', 'trade_cap'],
  ['🪫 Daily spend cap (SOL)', 'daily_cap'],
  ['⏱ Watch cooldown (seconds)', 'cooldown'],
  ['📈 Trail arm at (X)', 'trail_arm'],
  ['📉 Trail back %', 'trail_pct'],
  ['⏳ Max hold (hours, 0 = off)', 'max_hold'],
  ['⚠️ Low balance alert (SOL)', 'low_bal'],
  ['🧾 Judge ape after N copies', 'rep_trades'],
  ['📉 Min ape win rate %', 'rep_win'],
];

function settingsSummary(s: UserDoc['settings']): string {
  const trail = normalizeTrailing(s.trailing);
  const repCfg = normalizeReputation(s.reputation);
  const mode = s.buyMode === 'pct'
    ? `${Math.round(s.buyPctOfSpend * 100)}% of watched spend`
    : `fixed ${sol(s.buyAmountLamports)}`;
  return [
    `🎚 size: <b>${mode}</b>`,
    `💧 slippage: <b>${Math.round(s.slippagePct * 100)}%</b>`,
    `⚡ fee cap/tx: <b>${sol(s.maxFeeLamports)}</b>`,
    `🎯 TP ladder: <b>${s.tpMultiples.length ? s.tpMultiples.map((m) => `${m}x`).join(', ') : 'off'}</b>`,
    `🎏 trailing: <b>${trail.enabled ? `from ${trail.armAtMult}x, -${Math.round(trail.trailPct * 100)}% off peak` : 'off'}</b>`,
    `🎗 break-even stop: <b>${s.breakEvenStop ? 'ON' : 'off'}</b>`,
    `⏳ max hold: <b>${s.maxHoldMs ? `${(s.maxHoldMs / 3_600_000).toFixed(1)}h` : 'off'}</b>`,
    `⚠️ low-balance alert: <b>${s.lowBalanceWarnLamports > 0 ? `below ${sol(s.lowBalanceWarnLamports)}` : 'off'}</b>`,
    `👤 reputation: <b>${repCfg.enabled ? `${repCfg.onFail === 'skip' ? 'skip' : 'halve'} apes under ${Math.round(repCfg.minWinRate * 100)}% win (after ${repCfg.minTrades} copies)` : 'off'}</b>`,
    `🛑 stop-loss: <b>-${Math.round(s.stopLossPct * 100)}%</b>`,
    `👻 copy-sell: <b>${s.copySell ? (s.copySellMode === 'all' ? 'ON — sell ALL when they sell' : 'ON — mirror their sell %') : 'off'}</b>`,
    `💸 exit rule: <b>${describeExit(normalizeExit(s.exit))}</b>`,
    `📏 spend window: <b>${sol(s.minSpendLamports)}–${sol(s.maxSpendLamports)}</b>`,
    `🪫 caps: <b>${sol(s.perTradeCapLamports)}/trade · ${sol(s.dailyCapLamports)}/day</b>`,
    `⏱ cooldown: <b>${Math.round(s.watcherCooldownMs / 1000)}s</b>`,
    `🛡 honeypot/sim check: <b>${s.honeypotCheck ? 'ON' : 'off'}</b>`,
  ].join('\n');
}

type Stage = { expect: string; payload?: string };

export class KachiBot {
  private bot: Telegraf;
  private pending = new Map<number, Stage>();

  constructor(token: string) {
    this.bot = new Telegraf(token);
    this.bot.catch((err) => console.error('[bot] uncaught:', (err as Error).message));
    this.middleware();
    this.commands();
    this.actions();
    this.textInputs();
  }

  /* ------------------------------ plumbing ------------------------------ */

  private uid(ctx: Context): number {
    if (!ctx.from) throw new Error('no sender');
    return ctx.from.id;
  }
  private allowed(ctx: Context): boolean {
    if (!TELEGRAM_ALLOWED_USER_IDS.length) return true;
    return !!ctx.from && TELEGRAM_ALLOWED_USER_IDS.includes(String(this.uid(ctx)));
  }

  private middleware(): void {
    this.bot.use(async (ctx, next) => {
      if (!this.allowed(ctx)) {
        if (ctx.from && ctx.chat?.type === 'private') {
          await ctx.reply('⛔ Not authorized — add your Telegram ID to TELEGRAM_ALLOWED_USER_IDS.').catch(() => undefined);
        }
        return;
      }
      const t0 = Date.now();
      try { await next(); } catch (e) { console.error('[bot] handler:', (e as Error).message); }
      const dt = Date.now() - t0;
      if (dt > 1200) console.warn(`[bot] slow handler ${dt}ms (${(ctx.message as { text?: string })?.text?.slice(0, 40) || ctx.updateType})`);
    });
  }

  private async docFor(userId: number): Promise<UserDoc> {
    trader.touchUser(userId);
    const doc = await getStore().getUser(userId);
    const needsMigrate = !Array.isArray(doc.wallets);
    this.normalizeWallets(doc);
    if (needsMigrate) {
      // legacy single-wallet doc -> vault; persist once
      await getStore().saveUser(doc);
      void getStore().flush();
    }
    return doc;
  }

  private async saveDoc(doc: UserDoc): Promise<void> {
    doc.lastSeenAt = Date.now();
    this.normalizeWallets(doc);
    await getStore().saveUser(doc);
  }

  private kb(rows: BtnRow[]) {
    return Markup.inlineKeyboard(rows.map((r) => r.map((b) => Markup.button.callback(b.label, b.data))));
  }

  private cbText(ctx: Context, t: string): Promise<unknown> {
    return ctx.answerCbQuery(t).catch(() => undefined);
  }

  /** best-effort edit of the originating message, else fresh reply */
  private async answer(ctx: Context, text: string, o: { kb?: ReturnType<typeof Markup.inlineKeyboard> } = {}): Promise<void> {
    const q = ctx.callbackQuery;
    if (q && 'message' in q && q.message) {
      const msg = q.message as { message_id?: number };
      if (msg.message_id) {
        try {
          await ctx.telegram.editMessageText(ctx.chat?.id, msg.message_id, undefined, text, {
            ...HTML, reply_markup: o.kb?.reply_markup,
          });
          return;
        } catch { /* text identical or expired -> fall back to a reply */ }
      }
    }
    await ctx.reply(text, { ...HTML, reply_markup: o.kb?.reply_markup });
  }

  /* ------------------------------- commands ------------------------------ */

  private commands(): void {
    this.bot.start(async (ctx) => {
      const doc = await this.docFor(this.uid(ctx));
      if (!doc.welcomed) {
        doc.welcomed = true;
        await this.saveDoc(doc);
        await ctx.reply(welcomeIntro(), {
          ...HTML,
          reply_markup: this.kb([
            row(B('💼 Wallet', 'm:wallet'), B('⚙️ Settings', 'm:settings')),
            row(B('👀 Watchlist', 'm:watch'), B('📡 Positions', 'm:positions')),
            row(B('▶️ Open cockpit', 'm:main')),
          ]).reply_markup,
        });
        return;
      }
      await this.saveDoc(doc);
      await this.showMain(ctx);
    });
    this.bot.help(async (ctx) => { await ctx.reply(helpIntro(), HTML); });
    this.bot.command('guide', async (ctx) => {
      await ctx.reply(
        `📖 <b>USER GUIDE</b> — plain-language manual for everything KACHIBOT does.\n\nSetup, wallets, send &amp; receive, import/export, every setting, every command:\n\n${PUBLIC_URL}/guide`,
        HTML,
      );
    });
    this.bot.command(['menu', 'main'], async (ctx) => this.showMain(ctx));
    this.bot.command('settings', async (ctx) => this.showSettings(ctx));
    this.bot.command('wallet', async (ctx) => this.showWallet(ctx));
    this.bot.command('positions', async (ctx) => this.showPositions(ctx));
    this.bot.command('history', async (ctx) => this.showHistory(ctx, 0));
    this.bot.command('watch', async (ctx) => {
      const raw = ((ctx.message as { text?: string })?.text || '').replace(/^\/watch(@\w+)?/, '').trim();
      if (raw) await this.addWatch(ctx, raw);
      else await this.showWatch(ctx);
    });
    this.bot.command('panic', async (ctx) => this.confirmPanic(ctx));
    this.bot.command('cancel', async (ctx) => {
      this.pending.delete(this.uid(ctx));
      await ctx.reply('🚫 cancelled.', HTML);
      await this.showMain(ctx);
    });
  }

  /* ------------------------------- main --------------------------------- */

  private async showMain(ctx: Context): Promise<void> {
    const userId = this.uid(ctx);
    const doc = await this.docFor(userId);
    const text = [
      `${LOGO} <b>KACHIBOT</b> — solana copy-sniper`,
      '━━━━━━━━━━━━━━━━━',
      doc.secret ? '💼 wallet ready' : '⚠️ no wallet yet — snipes are dark until you add one',
      `👀 watching <b>${doc.watched.length}</b> wallet${doc.watched.length === 1 ? '' : 's'}`,
      `🎯 ${doc.settings.buyMode === 'pct' ? `${Math.round(doc.settings.buyPctOfSpend * 100)}% of watched spend` : `${sol(doc.settings.buyAmountLamports)} fixed`} · SL -${Math.round(doc.settings.stopLossPct * 100)}%`,
      '',
      '👇 pick a panel',
    ].join('\n');
    const kb = this.kb([
      row(B('💼 Wallet', 'm:wallet'), B('⚙️ Settings', 'm:settings')),
      row(B('👀 Watchlist', 'm:watch'), B('📡 Positions', 'm:positions')),
      row(B('🏆 PnL', 'm:pnl'), B('📖 History', 'm:history')),
      row(B('🔔 Alerts', 'm:alerts')),
      row(B('🧯 Panic sell-all', 'panic')),
    ]);
    await this.answer(ctx, text, { kb });
  }

  /* ------------------------------ settings ------------------------------- */

  private async showSettings(ctx: Context): Promise<void> {
    const doc = await this.docFor(this.uid(ctx));
    const s = doc.settings;
    const kbRows: BtnRow[] = [];
    if (s.buyMode === 'pct') kbRows.push(row(B(`📊 % mode — tap to switch to fixed`, 's:mode:fixed')));
    else kbRows.push(row(B(`💰 fixed mode — tap to switch to %`, 's:mode:pct')));
    for (const [label, key] of SETTING_LABELS) kbRows.push(row(B(label, `s:set:${key}`)));
    kbRows.push(row(
      B(`👻 copy-sell ${s.copySell ? '✅' : '⬜'}`, 's:copySell'),
      B(`🛡 honeypot ${s.honeypotCheck ? '✅' : '⬜'}`, 's:honeypot'),
    ));
    if (s.copySell) {
      kbRows.push(row(B(
        s.copySellMode === 'all'
          ? '📤 on their sell → dump ALL — tap to MIRROR their %'
          : '🪞 on their sell → MIRROR their % — tap to dump ALL',
        's:copySellMode',
      )));
    }
    kbRows.push(row(
      B(`🎏 trailing ${s.trailing?.enabled ? '✅' : '⬜'}`, 's:trailing'),
      B(`🎗 break-even ${s.breakEvenStop ? '✅' : '⬜'}`, 's:breakeven'),
    ));
    kbRows.push(row(
      B(`👤 reputation ${s.reputation?.enabled ? '✅' : '⬜'}`, 's:rep'),
      B(`🧾 weak ape → ${s.reputation?.onFail === 'halve' ? 'HALVE SIZE' : 'SKIP'}`, 's:repfail'),
    ));
    kbRows.push(row(B('💸 Exit rule (all wallets)', 's:exit')));
    kbRows.push(row(B('🔙 Main', 'm:main')));
    await this.answer(ctx, `⚙️ <b>TRADING SETTINGS</b>\n\n${settingsSummary(s)}\n\nTap to change:`, { kb: this.kb(kbRows) });
  }

  private currentValue(s: UserDoc['settings'], key: string): string {
    switch (key) {
      case 'buy_amount_sol': return sol(s.buyAmountLamports);
      case 'buy_pct': return `${Math.round(s.buyPctOfSpend * 100)}%`;
      case 'slippage': return `${Math.round(s.slippagePct * 100)}%`;
      case 'fee_cap': return sol(s.maxFeeLamports);
      case 'tp_multiples': return s.tpMultiples.map((m) => `${m}x`).join(', ');
      case 'stop_loss': return `${Math.round(s.stopLossPct * 100)}%`;
      case 'min_spend': return sol(s.minSpendLamports);
      case 'max_spend': return sol(s.maxSpendLamports);
      case 'trade_cap': return sol(s.perTradeCapLamports);
      case 'daily_cap': return sol(s.dailyCapLamports);
      case 'cooldown': return `${Math.round(s.watcherCooldownMs / 1000)}s`;
      case 'trail_arm': return `${s.trailing?.armAtMult ?? 3}x`;
      case 'trail_pct': return `${Math.round((s.trailing?.trailPct ?? 0.25) * 100)}%`;
      case 'max_hold': return s.maxHoldMs ? `${(s.maxHoldMs / 3_600_000).toFixed(1)}h` : 'off';
      case 'low_bal': return s.lowBalanceWarnLamports > 0 ? sol(s.lowBalanceWarnLamports) : 'off';
      case 'rep_trades': return `${s.reputation?.minTrades ?? 10}`;
      case 'rep_win': return `${Math.round((s.reputation?.minWinRate ?? 0.3) * 100)}%`;
      default: return '';
    }
  }

  /* -------------------------------- wallet ------------------------------- */

  /* ------------------------------ wallets ------------------------------- */

  /** keep the wallets vault consistent: migrate legacy docs, sync active + secret */
  private normalizeWallets(doc: UserDoc): void {
    if (!Array.isArray(doc.wallets) || doc.wallets.length === 0) {
      if (doc.secret) {
        doc.wallets = [{ id: 'wallet-1', label: 'Wallet 1', secret: doc.secret, mnemonic: null, createdAt: doc.createdAt || Date.now() }];
      } else {
        doc.wallets = [];
      }
    }
    if (!doc.wallets.some((w) => w.id === doc.activeWalletId)) {
      doc.activeWalletId = doc.wallets[0]?.id ?? null;
    }
    const act = doc.wallets.find((w) => w.id === doc.activeWalletId) || doc.wallets[0] || null;
    if ((act ? act.secret : null) !== doc.secret) {
      doc.secret = act ? act.secret : null; // trade engine reads doc.secret
      bustWalletCache(doc.userId);
    }
  }

  private activeWallet(doc: UserDoc): WalletRecord | null {
    return doc.wallets.find((w) => w.id === doc.activeWalletId) || doc.wallets[0] || null;
  }

  private nextWalletLabel(doc: UserDoc): string {
    return `Wallet ${doc.wallets.length + 1}`;
  }

  private addWalletRecord(doc: UserDoc, rec: { secret: string; mnemonic: string | null; label?: string }): WalletRecord {
    const w: WalletRecord = {
      id: crypto.randomUUID(),
      label: rec.label || this.nextWalletLabel(doc),
      secret: rec.secret,
      mnemonic: rec.mnemonic,
      createdAt: Date.now(),
    };
    doc.wallets.push(w);
    doc.activeWalletId = w.id;
    doc.secret = w.secret;
    bustWalletCache(doc.userId);
    return w;
  }

  private tryWallet(doc: UserDoc): { kp: import('@solana/web3.js').Keypair } | null {
    const w = this.activeWallet(doc);
    if (!w) return null;
    try { return { kp: keypairFromSecret(decryptSecret(w.secret)) }; } catch { return null; }
  }

  /** balance with a hard 3s cap so the wallet screen never hangs on a slow RPC */
  private async balanceRace(pk: import('@solana/web3.js').PublicKey): Promise<number | null> {
    const slow = new Promise<null>((res) => setTimeout(() => res(null), 3000));
    const fast = getConnection().getBalance(pk, 'confirmed').catch(() => null);
    return Promise.race([fast, slow]);
  }

  private async showWallet(ctx: Context): Promise<void> {
    const doc = await this.docFor(this.uid(ctx));
    const w = this.activeWallet(doc);
    if (!w) {
      await this.answer(ctx,
        `💼 <b>NO WALLET YET</b>\n\nKACHIBOT keeps private in-bot wallets per user — one or many. Keys are AES-256 encrypted at rest, decrypted only to sign or export.`,
        { kb: this.kb([[B('✨ Generate new wallet', 'w:gen')], [B('📥 Import seed phrase / private key', 'w:imp')], [B('🔙 Main', 'm:main')]]) });
      return;
    }
    const kp = this.tryWallet(doc);
    const cached = kp ? this.balCache.get(kp.kp.publicKey.toBase58()) : undefined;
    const otherWallets = doc.wallets.filter((x) => x.id !== w.id);
    const kbRows: BtnRow[] = [];
    if (kp) {
      kbRows.push(row(B('📤 Send', 'w:send'), B('📥 Receive', 'w:recv')));
      kbRows.push(row(B('📋 Export', 'w:exp'), B('✏️ Rename', 'w:ren')));
      kbRows.push(row(B('🔐 PIN', 'w:pin'), B('🗑 Delete', 'w:del')));
    }
    for (const o of otherWallets) kbRows.push(row(B(`🔁 ${o.label}`, `w:sel:${o.id}`)));
    if (kp) kbRows.push(row(B('➕ New', 'w:gen'), B('📥 Import', 'w:imp'), B('⟳ Refresh', 'w:bal')));
    else kbRows.push(row(B('➕ New wallet', 'w:gen'), B('📥 Import wallet', 'w:imp')));
    kbRows.push(row(B('🔙 Main', 'm:main')));
    const addr = kp ? kp.kp.publicKey.toBase58() : '';
    const balShown = cached !== undefined ? solShort(cached) : '◎0'; // 0 until proven otherwise
    const text = [
      `💼 <b>WALLET</b> — ${w.label}${doc.wallets.length > 1 ? ` <i>(${doc.wallets.findIndex((x) => x.id === w.id) + 1}/${doc.wallets.length})</i>` : ''}`,
      `SOL balance: <b>${balShown}</b>`,
      '',
      addr ? `Address: <code>${addr}</code>` : '',
      '',
      addr ? '💸 send SOL here — snipes spend from it. Tap ⟳ to refresh after a deposit.' : 'Choose an action below.',
    ].join('\n');
    await this.answer(ctx, text, { kb: this.kb(kbRows) });
    // background: fetch real balance and patch the message when it lands
    if (kp) {
      const pkStr = kp.kp.publicKey.toBase58();
      this.balanceRace(kp.kp.publicKey).then((b) => {
        if (b === null) return;
        this.balCache.set(pkStr, b);
        const q = ctx.callbackQuery;
        if (q && 'message' in q && q.message && (q.message as { message_id?: number }).message_id) {
          void ctx.telegram
            .editMessageText(ctx.chat?.id, (q.message as { message_id: number }).message_id, undefined,
              [
                `💼 <b>WALLET</b> — ${w.label}${doc.wallets.length > 1 ? ` <i>(${doc.wallets.findIndex((x) => x.id === w.id) + 1}/${doc.wallets.length})</i>` : ''}`,
                `SOL balance: <b>${solShort(b)}</b>`,
                '',
                `Address: <code>${pkStr}</code>`,
                '',
                '💸 send SOL here — snipes spend from it. Tap ⟳ to refresh after a deposit.',
              ].join('\n'),
              { ...HTML, reply_markup: this.kb(kbRows).reply_markup },
            )
            .catch(() => undefined);
        }
      }).catch(() => undefined);
    }
  }

  private balCache = new Map<string, number>();

  private async askImport(ctx: Context): Promise<void> {
    this.pending.set(this.uid(ctx), { expect: 'import_input' });
    await this.answer(ctx,
      '📥 Send your <b>12/24-word seed phrase</b> or <b>private key</b> (base58, hex or 64-byte JSON array).\n\nIt is added as a <b>new wallet</b> and activated. Encrypted instantly — never stored in plaintext. /cancel to abort.');
  }

  private async runImport(userId: number, text: string): Promise<{ ok: boolean; message: string; address: string; label: string }> {
    const words = text.trim().split(/\s+/);
    let kp: ReturnType<typeof keypairFromMnemonic>;
    let phrase: string | null = null;
    if ((words.length === 12 || words.length === 24) && words.every((w) => /^[a-z]+$/.test(w))) {
      kp = keypairFromMnemonic(text);
      phrase = text.trim();
    } else {
      kp = parsePrivateKey(text);
    }
    const doc = await this.docFor(userId);
    const rec = this.addWalletRecord(doc, { secret: encryptSecret(keypairToSecret(kp)), mnemonic: phrase ? encryptSecret(phrase) : null });
    await this.saveDoc(doc);
    await getStore().flush(); // wallet secrets must survive a crash — write now
    return { ok: true, message: 'ok', address: kp.publicKey.toBase58(), label: rec.label };
  }

  private async doSend(
    userId: number,
    to: string,
    lamports: number,
  ): Promise<{ ok: boolean; sig?: string; message: string }> {
    const doc = await this.docFor(userId);
    const kp = this.tryWallet(doc);
    if (!kp) return { ok: false, message: 'no wallet' };
    const conn = getConnection();
    const bal = (await this.balanceRace(kp.kp.publicKey)) ?? 0;
    if (lamports <= 0) return { ok: false, message: 'amount must be positive' };
    if (bal < lamports + 10_000) return { ok: false, message: `insufficient balance: have ${solShort(bal)}, need ${solShort(lamports)} + fees` };
    try {
      const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
      const tx = new Transaction({ feePayer: kp.kp.publicKey, recentBlockhash: blockhash });
      tx.add(SystemProgram.transfer({ fromPubkey: kp.kp.publicKey, toPubkey: new PublicKey(to), lamports }));
      const sig = await conn.sendTransaction(tx, [kp.kp]);
      await Promise.race([
        conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed').then(() => true).catch(() => false),
        new Promise((r) => setTimeout(r, 6000)),
      ]);
      return { ok: true, sig, message: `${solShort(lamports)} → ${to.slice(0, 6)}…${to.slice(-4)}` };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  }

  private hashPin(pin: string): string {
    return crypto.createHash('sha256').update(`kachi:${pin}`).digest('hex');
  }

  /* ------------------------------- watchlist ------------------------------ */

  private async showWatch(ctx: Context): Promise<void> {
    const doc = await this.docFor(this.uid(ctx));
    if (!doc.watched.length) {
      await this.answer(ctx,
        '👀 <b>WATCHLIST</b> — empty.\n\nPaste a <b>wallet address</b> or a <b>pump.fun coin/profile link</b>; KACHIBOT mirrors every buy in real time.\n\nUse /watch &lt;address|url&gt; or tap add:',
        { kb: this.kb([[B('➕ Add target', 'w:add')], [B('🔙 Main', 'm:main')]]) });
      return;
    }
    const kbRows: BtnRow[] = [];
    for (const w of doc.watched) {
      const short = w.address.slice(0, 4) + '…' + w.address.slice(-4);
      kbRows.push(row(B(`${w.paused ? '⏸' : '👁'} ${w.label} (${short})`, `wv:${w.id}`)));
    }
    kbRows.push(row(B('➕ Add target', 'w:add'), B('🔙 Main', 'm:main')));
    const text = `👀 <b>WATCHLIST</b> — ${doc.watched.length} target${doc.watched.length === 1 ? '' : 's'}, watched simultaneously.\nTap one to inspect, pause or remove:`;
    await this.answer(ctx, text, { kb: this.kb(kbRows) });
  }

  /**
   * pump.fun link -> the wallet to watch.
   * profile/<address> -> that address itself.
   * coin/<mint>       -> the coin's creator wallet (the freshest ape signal).
   */
  private async resolvePumpfunUrl(raw: string): Promise<{ kind: 'wallet' | 'err'; value?: string; message?: string }> {
    const link = parsePumpfunLink(raw);
    if (!link) {
      if (/pump\.fun\/(?!coin\/|profile\/)/i.test(raw) && /pump\.fun\//i.test(raw)) {
        return { kind: 'err', message: 'username profiles aren\'t supported — copy the wallet address from the profile page' };
      }
      return { kind: 'err', message: 'that is not a pump.fun link — use pump.fun/profile/<address> or pump.fun/coin/<mint>' };
    }
    if (link.kind === 'profile') {
      return { kind: 'wallet', value: link.id };
    }
    const st = await fetchCurve(getConnection(), new PublicKey(link.id)).catch(() => null);
    if (st && isLiveCurve(st)) return { kind: 'wallet', value: st.curve.creator.toBase58() };
    return { kind: 'err', message: 'coin not found on the pump bonding curve (graduated or delisted) — watch its creator profile instead' };
  }

  private async addWatch(ctx: Context, raw: string): Promise<void> {
    const trimmed = raw.trim();
    let address: string;
    try {
      if (trimmed.includes('pump.fun') || /^https?:\/\//i.test(trimmed)) {
        const r = await this.resolvePumpfunUrl(trimmed);
        if (r.kind === 'err' || !r.value) {
          await ctx.reply(`❌ ${r.message}`, HTML);
          return;
        }
        address = r.value;
      } else {
        if (!WALLET_ADDR_RE.test(trimmed)) {
          await ctx.reply('❌ Not a Solana address and not a pump.fun link. Try again.', HTML);
          return;
        }
        address = trimmed;
      }
      new PublicKey(address);
    } catch {
      await ctx.reply('❌ invalid address', HTML);
      return;
    }

    const userId = this.uid(ctx);
    const doc = await this.docFor(userId);
    if (doc.watched.some((w) => w.address === address)) {
      await ctx.reply(`👀 Already watching <code>${address.slice(0, 8)}…</code>`, HTML);
      return;
    }
    const n = doc.watched.length + 1;
    doc.watched.push({
      id: `W${Date.now()}${Math.floor(Math.random() * 1000)}`,
      address,
      label: `ape #${n}`,
      source: trimmed.includes('pump.fun') ? 'pumpfun' : 'address',
      addedAt: Date.now(),
      paused: false,
    });
    await this.saveDoc(doc);
    await watcher.addTargetForUser(userId);
    await ctx.reply(
      `✅ <b>NOW WATCHING</b>\n\nAddress: <code>${address}</code>\nLabel: ${doc.watched[doc.watched.length - 1].label}\nEvery buy gets mirrored per your /settings.`,
      HTML,
    );
    await this.showWatch(ctx);
  }

  private async watchDetail(ctx: Context, watchId: string): Promise<void> {
    const doc = await this.docFor(this.uid(ctx));
    const w = doc.watched.find((x) => x.id === watchId);
    if (!w) { await ctx.reply('target gone', HTML); return; }
    const all = await getStore().listTrades(doc.userId);
    const mine = all.filter((t) => t.watchId === watchId && t.status === 'closed');
    const perf = mine.length
      ? (() => {
        const wins = mine.filter((t) => (t.pnlLamports ?? 0) > 0);
        const pnl = mine.reduce((a, t) => a + (t.pnlLamports ?? 0), 0);
        const avg = mine.reduce((a, t) => a + (t.pnlPct ?? 0), 0) / mine.length;
        return `\n📊 <b>performance</b>\ncopies closed: ${mine.length} · win rate ${Math.round((wins.length / mine.length) * 100)}%\navg return ${pctSigned(avg)} · realized ${solShort(pnl)}`;
      })()
      : '\n📊 no closed copies yet — win rate & returns appear once a mirrored trade fully closes (TP / stop-loss / sell)';
    const since = durMs(Math.max(0, Date.now() - w.addedAt));
    const statusLine = w.paused
      ? `⏸ paused${w.pausedAt ? ` for ${durMs(Math.max(0, Date.now() - w.pausedAt))}` : ''} · watched ${since} total`
      : `⏱ watching for ${since} · 🟢 live`;
    const buyLine = w.lastBuySeenAt ? `🕓 last buy seen ${ago(w.lastBuySeenAt)}` : null;
    const exitCfg = resolveExit(doc, w);
    const exitLine = `💸 exit: <b>${describeExit(exitCfg)}</b>${w.exit ? '' : ' (default)'}`;
    const sizeCfg = resolveBuySize(doc, w);
    const sizeLine = `💰 size: <b>${describeBuySize(sizeCfg)}</b>${w.buySize ? '' : ' (default)'}`;
    const holdLine = `⏳ confirm: <b>${describeConfirmHold(w.confirmHoldMs)}</b>`;
    const repCfg = normalizeReputation(doc.settings.reputation);
    let repLine: string | null = null;
    if (repCfg.enabled) {
      const st = watchReputation(all, w.id);
      const v = evaluateReputation(st, repCfg);
      repLine = v.judged
        ? `🧾 reputation: <b>${Math.round(v.winRate * 100)}% win / ${v.closed} copies</b> — ${v.pass ? '✅ trusted' : repCfg.onFail === 'skip' ? 'copies skipped' : 'copied at half size'}`
        : `🧾 reputation: ${st.closed}/${repCfg.minTrades} copies judged`;
    }
    const text = [
      `👁 <b>${escTag(w.label)}</b>`,
      `Address: <code>${w.address}</code>`,
      w.source === 'pumpfun' ? 'source: pump.fun link' : '',
      statusLine,
      buyLine,
      exitLine,
      sizeLine,
      holdLine,
      repLine,
      perf,
    ].filter(Boolean).join('\n');
    const kb = this.kb([
      row(B(w.paused ? '▶️ resume' : '⏸ pause', `wv:${w.id}:pause`), B('🗑 remove', `wv:${w.id}:remove`)),
      row(B('💸 exit rule', `ex:${w.id}:menu`), B('💰 buy size', `bs:${w.id}:menu`)),
      row(B('⏳ confirm hold', `cw:${w.id}:menu`), B('🔙 Watchlist', 'm:watch')),
    ]);
    await this.answer(ctx, text, { kb });
  }

  /* ------------------------------ exit rules ------------------------------ */

  /** exit-rule menu: scope 'g' = global default, otherwise a watched wallet id */
  private async showExitMenu(ctx: Context, scope: string): Promise<void> {
    const doc = await this.docFor(this.uid(ctx));
    const isGlobal = scope === 'g';
    const watch = isGlobal ? null : doc.watched.find((x) => x.id === scope) || null;
    if (!isGlobal && !watch) { await ctx.reply('target gone', HTML); return; }
    const current = isGlobal ? normalizeExit(doc.settings.exit) : resolveExit(doc, watch);
    const mark = (m: ExitMode): string => (current.mode === m ? ' ✅' : '');
    const val = (m: ExitMode): string => {
      if (m === 'pct' && current.mode === 'pct') return ` — ${Math.round(current.pct * 100)}%`;
      if (m === 'mult' && current.mode === 'mult' && current.mult) return ` — ${current.mult}x`;
      if (m === 'mcap' && current.mode === 'mcap' && current.mcapUsd) return ` — ${formatMcapUsd(current.mcapUsd)}`;
      return '';
    };
    const kbRows: BtnRow[] = [
      row(B(`👻 follow ape — sell all${mark('follow')}`, `ex:${scope}:follow`)),
      row(B(`🔢 sell % when ape sells${mark('pct')}${val('pct')}`, `ex:${scope}:pct`)),
      row(B(`🙌 hold — ignore ape sells${mark('hold')}`, `ex:${scope}:hold`)),
      row(B(`🎯 sell all at an X${mark('mult')}${val('mult')}`, `ex:${scope}:mult`)),
      row(B(`📈 sell all at mcap${mark('mcap')}${val('mcap')}`, `ex:${scope}:mcap`)),
    ];
    if (!isGlobal) kbRows.push(row(B('↩️ use global default', `ex:${scope}:inherit`)));
    kbRows.push(row(B(isGlobal ? '🔙 Settings' : '🔙 Target', isGlobal ? 'm:settings' : `wv:${scope}`)));

    const where = isGlobal ? 'default for every watched wallet' : `for ${escTag(watch ? watch.label : '')}`;
    const inherited = !isGlobal && !watch?.exit;
    const text = [
      `💸 <b>EXIT RULE</b> — ${where}`,
      '',
      `current: <b>${describeExit(current)}</b>${inherited ? ' (inherited from your global default)' : ''}`,
      '',
      '👻 follow — mirror the ape: sell 100% the moment it sells',
      '🔢 sell % — sell only a slice of the bag when it sells',
      '🙌 hold — never follow its sells (TP ladder & stop-loss still guard)',
      '🎯 / 📈 — ignore its sells and exit the whole bag at your own X or market cap',
      '',
      'Applies to coins copied from this wallet going forward.',
    ].join('\n');
    await this.answer(ctx, text, { kb: this.kb(kbRows) });
  }

  /** per-wallet buy size: bs:<watchId>:<action> */
  private async showBuySizeMenu(ctx: Context, watchId: string): Promise<void> {
    const doc = await this.docFor(this.uid(ctx));
    const w = doc.watched.find((x) => x.id === watchId);
    if (!w) { await ctx.reply('target gone', HTML); return; }
    const cur = resolveBuySize(doc, w);
    const inherited = !w.buySize;
    const mark = (m: 'fixed' | 'pct'): string => (cur.mode === m && !inherited ? ' ✅' : '');
    const kbRows: BtnRow[] = [
      row(B(`💵 fixed SOL per copy${mark('fixed')}`, `bs:${watchId}:fixed`)),
      row(B(`📊 % of this ape's spend${mark('pct')}`, `bs:${watchId}:pct`)),
      row(B('↩️ use global default', `bs:${watchId}:inherit`)),
      row(B('🔙 Target', `wv:${watchId}`)),
    ];
    const text = [
      `💰 <b>BUY SIZE</b> — for ${escTag(w.label)}`,
      '',
      `current: <b>${describeBuySize(cur)}</b>${inherited ? ' (inherited from your global size)' : ''}`,
      '',
      inherited
        ? '💵 fixed — spend a set amount every time this wallet buys'
        : '💵 fixed — spend a set amount every time this wallet buys',
      `📊 % — copy a percentage of what this wallet spends (budget still capped by your per-trade cap)`,
      '',
      'Only changes what you spend for coins copied from this wallet.',
    ].join('\n');
    await this.answer(ctx, text, { kb: this.kb(kbRows) });
  }

  /** per-wallet confirm-hold delay: cw:<watchId>:<seconds|menu|custom> */
  private async showConfirmMenu(ctx: Context, watchId: string): Promise<void> {
    const doc = await this.docFor(this.uid(ctx));
    const w = doc.watched.find((x) => x.id === watchId);
    if (!w) { await ctx.reply('target gone', HTML); return; }
    const cur = Number(w.confirmHoldMs || 0);
    const mark = (sec: number): string => (Math.round(cur / 1000) === sec ? ' ✅' : '');
    const kbRows: BtnRow[] = [
      row(B(`⚡ copy instantly${mark(0)}`, `cw:${watchId}:0`)),
      row(B(`⏱ wait 15s${mark(15)}`, `cw:${watchId}:15`), B(`⏱ wait 30s${mark(30)}`, `cw:${watchId}:30`), B(`⏱ wait 60s${mark(60)}`, `cw:${watchId}:60`)),
      row(B('✏️ custom seconds', `cw:${watchId}:custom`)),
      row(B('🔙 Target', `wv:${watchId}`)),
    ];
    const text = [
      `⏳ <b>CONFIRM HOLD</b> — for ${escTag(w.label)}`,
      '',
      `current: <b>${describeConfirmHold(cur)}</b>`,
      '',
      '⚡ instant — copy the second they buy (best entry price)',
      '⏱ wait — copy only if they are still holding after the delay, and skip them if they dumped ≥50% in that window',
      '',
      'Waiting filters out apes who buy and dump within seconds — but on a coin that runs you will enter later and higher. Off by default.',
    ].join('\n');
    await this.answer(ctx, text, { kb: this.kb(kbRows) });
  }

  private async afterExitChange(ctx: Context, scope: string): Promise<void> {
    if (scope === 'g') { await this.showSettings(ctx); return; }
    await this.watchDetail(ctx, scope);
  }

  /* ------------------------------- positions ------------------------------ */

  private async showPositions(ctx: Context): Promise<void> {
    const userId = this.uid(ctx);
    const open = await getStore().listTrades(userId, 'open');
    if (!open.length) {
      await this.answer(ctx, '📡 <b>POSITIONS</b>\n\nNo open positions. When a watched wallet apes, your snipe lands here with live PnL.', {
        kb: this.kb([[B('🔙 Main', 'm:main')]]),
      });
      return;
    }
    const live = new Map<string, number | null>();
    for (const r of open) live.set(r.id, await trader.liveValueLamports(r).catch(() => null));
    const sumIn = open.reduce((a, r) => a + r.spentLamports, 0);
    let sumVal = 0;
    for (const [, v] of live) sumVal += v ?? 0;

    const lines = [`📡 <b>POSITIONS</b> — ${open.length} open`, `in ${solShort(sumIn)} · live ${solShort(sumVal)}`];
    const kbRows: BtnRow[] = [];
    open.slice(0, 10).forEach((r, i) => {
      const v = live.get(r.id) ?? null;
      const held = BigInt(r.entryTokenAmount) - r.partialSells.reduce((a, s) => a + BigInt(s.tokenAmountRaw), 0n);
      const basisPer = Number(BigInt(r.entryTokenAmount)) > 0 ? r.spentLamports / Number(BigInt(r.entryTokenAmount)) : 0;
      const mult = v !== null && basisPer > 0 ? v / (basisPer * Number(held)) : null;
      lines.push(`${i + 1}. <b>$${r.symbol}</b> ${solShort(r.spentLamports)} → ${v !== null ? solShort(v) : '…'}${mult !== null ? ` (${mult.toFixed(2)}x)` : ''} · ${ago(r.entryTime)}`);
      kbRows.push(row(B(`💸 sell $${r.symbol}`, `sell:${r.id}`), B('📡 card', `pos:${r.id}`)));
    });
    if (open.length > 10) lines.push(`… +${open.length - 10} more (sell-all below)`);
    kbRows.push(row(B('🧯 Panic sell-all', 'panic')), row(B('🔙 Main', 'm:main')));
    await this.answer(ctx, lines.join('\n'), { kb: this.kb(kbRows) });
  }

  private async positionCard(ctx: Context, rowId: string): Promise<void> {
    const open = await getStore().listTrades(this.uid(ctx), 'open');
    const t = open.find((x) => x.id === rowId);
    if (!t) return;
    const [view, solUsd] = await Promise.all([
      trader.positionView(t).catch(() => null),
      getSolUsd().catch(() => null),
    ]);
    const v = view ?? { live: null, math: positionMath(t, null), pricePerToken: null, mcapLamports: null, entryPricePerToken: t.entryPriceLamports ?? null };
    const text = positionScorecardText(t, v, solUsd);
    const kbRows: BtnRow[] = [];
    if (t.outOfSync) {
      kbRows.push(row(B('🧹 Close stale entry', `closeStale:${t.id}`)));
    } else {
      kbRows.push(row(
        B('💸 Sell 25%', `sellfrac:${t.id}:25`),
        B('💸 Sell 50%', `sellfrac:${t.id}:50`),
        B('💸 Sell all', `sell:${t.id}`),
      ));
    }
    kbRows.push(row(B('🔄 Refresh', `pos:${t.id}`), B('📡 Positions', 'm:positions')));
    await this.answer(ctx, text, { kb: this.kb(kbRows) });
  }

  /** 🏆 account-wide PnL scorecard */
  private async showPnl(ctx: Context): Promise<void> {
    const userId = this.uid(ctx);
    const all = await getStore().listTrades(userId);
    const open = all.filter((t) => t.status === 'open');
    // price at most 5 open positions so the card stays snappy
    const unrealizedByRow: Record<string, number | null> = {};
    for (const t of open.slice(0, 5)) {
      unrealizedByRow[t.id] = await trader.liveValueLamports(t).catch(() => null);
    }
    const solUsd = await getSolUsd().catch(() => null);
    const st = scorecardStats(all, { unrealizedByRow });
    await this.answer(ctx, pnlScorecardText(st, solUsd), {
      kb: this.kb([[B('📖 History', 'm:history'), B('📡 Positions', 'm:positions')], [B('🔙 Main', 'm:main')]]),
    });
  }

  /* -------------------------------- history ------------------------------- */

  private async showHistory(ctx: Context, page: number): Promise<void> {
    const userId = this.uid(ctx);
    const all = await getStore().listTrades(userId);
    const sum = summarizeTrades(all);
    const perPage = 8;
    const pages = Math.max(1, Math.ceil(all.length / perPage));
    const pageSafe = Math.min(page, pages - 1);
    const slice = all.slice(pageSafe * perPage, pageSafe * perPage + perPage);
    const lines = [
      `📖 <b>TRADE HISTORY</b> — ${sum.closed} closed · ${sum.open} open`,
      `running PnL: <b>${sum.realizedPnlLamports >= 0 ? '+' : ''}${solShort(sum.realizedPnlLamports)}</b>${sum.closed ? ` · win ${Math.round(sum.winRate * 100)}% · avg ${pctSigned(sum.avgReturnPct / 100)}` : ''}`,
    ];
    const kbRows: BtnRow[] = [];
    if (!all.length) lines.push('\nNo trades yet — the first ape you mirror prints card #1 here.');
    slice.forEach((t, i) => {
      const idx = all.length - (pageSafe * perPage + i);
      if (t.status === 'closed') {
        const pnl = t.pnlLamports ?? 0;
        lines.push(`${idx}. ${pnl >= 0 ? '🟢' : '🔴'} <b>$${t.symbol}</b> ${pnl >= 0 ? '+' : ''}${solShort(pnl)} ${(t.netMultiple ?? 0) >= 1 ? `· ${(t.netMultiple ?? 0).toFixed(2)}x` : ''} · ${exitReasonLabel(t.exitReason)}`);
        kbRows.push(row(B(`🏆 card #${idx}`, `score:${t.id}`)));
      } else if (t.status === 'open') {
        lines.push(`${idx}. 📡 <b>$${t.symbol}</b> open · ${solShort(t.spentLamports)} in · ${ago(t.entryTime)}`);
      } else {
        lines.push(`${idx}. ⛔ <b>$${t.symbol}</b> failed · ${escTag((t.error || 'unknown').slice(0, 70))}`);
      }
    });
    const nav: BtnRow = [];
    if (pageSafe > 0) nav.push(B('⬅️ prev', `hist:${pageSafe - 1}`));
    nav.push(B(`p ${pageSafe + 1}/${pages}`, 'noop'));
    if (pageSafe < pages - 1) nav.push(B('next ➡️', `hist:${pageSafe + 1}`));
    if (nav.length > 1) kbRows.unshift(nav);
    kbRows.push(row(B('🏆 PnL scorecard', 'm:pnl')));
    kbRows.push(row(B('🔙 Main', 'm:main')));
    await this.answer(ctx, lines.join('\n'), { kb: this.kb(kbRows) });
  }

  /* -------------------------------- alerts -------------------------------- */

  private async showAlerts(ctx: Context): Promise<void> {
    const doc = await this.docFor(this.uid(ctx));
    const a = doc.settings.alerts;
    const t = (label: string, on: boolean, key: keyof typeof a): { label: string; data: string } =>
      B(`${label} ${on ? '✅' : '⬜'}`, `a:${key}`);
    await this.answer(ctx,
      '🔔 <b>ALERTS</b>\n\nWhat the bot messages you about:\n🎯 <b>snipes</b> — copy-buy outcome cards (locked / failed / dodged). Off = it buys silently.\n💸 <b>sells</b> — TP step sells and closed-trade scorecards. Off = exits close quietly.\n👁 <b>activity</b> — radar notes on wallets you watch (noisy).\nProtection warnings (blocks, rug sweeps, caps) always reach you.',
      {
        kb: this.kb([
          row(t('🎯 snipes', a.snipes, 'snipes'), t('💸 sells', a.sells, 'sells')),
          row(t('👁 watched activity', a.activity, 'activity')),
          row(B('🔙 Main', 'm:main')),
        ]),
      });
  }

  /* ------------------------------ actions -------------------------------- */

  private actions(): void {
    const on = (prefix: string, fn: (ctx: Context, rest: string) => Promise<void>): void => {
      this.bot.action(new RegExp(`^${prefix}(?::(.*))?$`), async (ctx) => {
        try {
          await fn(ctx, (ctx as unknown as { match: string[] }).match?.[1] || '');
        } catch (e) {
          console.error(`[bot] action ${prefix}:`, (e as Error).message);
          await ctx.answerCbQuery('⚠️ action failed').catch(() => undefined);
        }
      });
    };

    on('noop', async (ctx) => { await this.cbText(ctx, ' '); });

    on('m', async (ctx, rest) => {
      await this.cbText(ctx, ' ');
      switch (rest) {
        case 'wallet': await this.showWallet(ctx); break;
        case 'settings': await this.showSettings(ctx); break;
        case 'watch': await this.showWatch(ctx); break;
        case 'positions': await this.showPositions(ctx); break;
        case 'history': await this.showHistory(ctx, 0); break;
        case 'alerts': await this.showAlerts(ctx); break;
        default: await this.showMain(ctx);
      }
    });

    // settings
    on('s:mode', async (ctx, rest) => {
      const doc = await this.docFor(this.uid(ctx));
      if (rest === 'pct') doc.settings.buyMode = 'pct';
      if (rest === 'fixed') doc.settings.buyMode = 'fixed';
      await this.saveDoc(doc);
      await this.cbText(ctx, `mode → ${doc.settings.buyMode}`);
      await this.showSettings(ctx);
    });
    on('s:copySell', async (ctx) => {
      const doc = await this.docFor(this.uid(ctx));
      doc.settings.copySell = !doc.settings.copySell;
      if (typeof doc.settings.copySellMode !== 'string') doc.settings.copySellMode = 'mirror';
      await this.saveDoc(doc);
      await this.cbText(ctx, `copy-sell ${doc.settings.copySell ? 'ON' : 'OFF'}`);
      await this.showSettings(ctx);
    });
    on('s:copySellMode', async (ctx) => {
      const doc = await this.docFor(this.uid(ctx));
      doc.settings.copySellMode = doc.settings.copySellMode === 'all' ? 'mirror' : 'all';
      await this.saveDoc(doc);
      await this.cbText(ctx, doc.settings.copySellMode === 'all'
        ? 'copy-sell → dump ALL as soon as they sell'
        : 'copy-sell → MIRROR: sell the same % they sold, keep the moonbag');
      await this.showSettings(ctx);
    });
    on('s:honeypot', async (ctx) => {
      const doc = await this.docFor(this.uid(ctx));
      doc.settings.honeypotCheck = !doc.settings.honeypotCheck;
      await this.saveDoc(doc);
      await this.cbText(ctx, `honeypot check ${doc.settings.honeypotCheck ? 'ON' : 'OFF'}`);
      await this.showSettings(ctx);
    });
    on('s:trailing', async (ctx) => {
      const doc = await this.docFor(this.uid(ctx));
      doc.settings.trailing = { ...normalizeTrailing(doc.settings.trailing), enabled: !doc.settings.trailing?.enabled };
      await this.saveDoc(doc);
      await this.cbText(ctx, `trailing stop ${doc.settings.trailing.enabled ? 'ON' : 'OFF'}`);
      await this.showSettings(ctx);
    });
    on('s:breakeven', async (ctx) => {
      const doc = await this.docFor(this.uid(ctx));
      doc.settings.breakEvenStop = !doc.settings.breakEvenStop;
      await this.saveDoc(doc);
      await this.cbText(ctx, `break-even stop ${doc.settings.breakEvenStop ? 'ON' : 'OFF'}`);
      await this.showSettings(ctx);
    });
    on('s:rep', async (ctx) => {
      const doc = await this.docFor(this.uid(ctx));
      const r = normalizeReputation(doc.settings.reputation);
      doc.settings.reputation = { ...r, enabled: !r.enabled };
      await this.saveDoc(doc);
      await this.cbText(ctx, `reputation filter ${doc.settings.reputation.enabled ? 'ON' : 'OFF'}`);
      await this.showSettings(ctx);
    });
    on('s:repfail', async (ctx) => {
      const doc = await this.docFor(this.uid(ctx));
      const r = normalizeReputation(doc.settings.reputation);
      doc.settings.reputation = { ...r, onFail: r.onFail === 'skip' ? 'halve' : 'skip' };
      await this.saveDoc(doc);
      await this.cbText(ctx, `weak apes → ${doc.settings.reputation.onFail === 'skip' ? 'skipped' : 'halved'}`);
      await this.showSettings(ctx);
    });
    on('s:exit', async (ctx) => {
      await this.showExitMenu(ctx, 'g');
    });
    on('s:set', async (ctx, rest) => {
      const pair = SETTING_LABELS.find(([, k]) => k === rest);
      if (!pair) return;
      const doc = await this.docFor(this.uid(ctx));
      this.pending.set(this.uid(ctx), { expect: `setting:${rest}` });
      await this.cbText(ctx, 'enter value');
      await this.answer(ctx, `⚙️ <b>${pair[0]}</b>\ncurrent: ${this.currentValue(doc.settings, rest)}\n\nType the new value (or /cancel):`);
    });

    // exit rules: ex:<scope>:<action> (scope 'g' = global default)
    on('ex', async (ctx, rest) => {
      const parts = rest.split(':');
      const scope = parts[0];
      const action = parts[1] || 'menu';
      const userId = this.uid(ctx);
      const doc = await this.docFor(userId);
      if (action === 'menu') { await this.showExitMenu(ctx, scope); return; }

      const watch = scope === 'g' ? null : doc.watched.find((x) => x.id === scope) || null;
      if (scope !== 'g' && !watch) { await ctx.reply('target gone', HTML); return; }

      if (action === 'inherit') {
        if (!watch) return;
        watch.exit = null;
        await this.saveDoc(doc);
        await this.cbText(ctx, 'using global default');
        await this.showExitMenu(ctx, scope);
        return;
      }
      const mode = action as ExitMode;
      if (mode !== 'follow' && mode !== 'hold') {
        // needs a value from the user
        const prompts: Record<string, string> = {
          pct: 'Type the % of the bag to sell when this wallet sells (1–100), e.g. 50',
          mult: 'Type the multiple to sell the whole bag at, e.g. 3x',
          mcap: 'Type the market cap to sell the whole bag at, e.g. 100k / 1.5m',
        };
        this.pending.set(userId, { expect: `exitval:${scope}:${mode}` });
        await this.cbText(ctx, 'enter value');
        await this.answer(ctx, `💸 <b>EXIT RULE</b>\n\n${prompts[mode]}\n\n(or /cancel)`);
        return;
      }
      const cfg: ExitConfig = { ...EXIT_DEFAULT, mode };
      if (watch) watch.exit = cfg; else doc.settings.exit = cfg;
      await this.saveDoc(doc);
      await this.cbText(ctx, describeExit(cfg));
      await this.showExitMenu(ctx, scope);
    });

    // per-wallet buy size
    on('bs', async (ctx, rest) => {
      const [watchId, action] = rest.split(':');
      const doc = await this.docFor(this.uid(ctx));
      const w = doc.watched.find((x) => x.id === watchId);
      if (!w) { await ctx.reply('target gone', HTML); return; }
      if (action === 'menu') { await this.showBuySizeMenu(ctx, watchId); return; }
      if (action === 'inherit') {
        w.buySize = null;
        await this.saveDoc(doc);
        await this.cbText(ctx, 'using global size');
        await this.showBuySizeMenu(ctx, watchId);
        return;
      }
      const prompts: Record<string, string> = {
        fixed: 'Type the SOL amount to spend per copy from this wallet, e.g. 0.02',
        pct: "Type the % of this wallet's spend to copy, e.g. 50",
      };
      this.pending.set(this.uid(ctx), { expect: `bsval:${watchId}:${action}` });
      await this.cbText(ctx, 'enter value');
      await this.answer(ctx, `💰 <b>BUY SIZE</b>\n\n${prompts[action] || 'Type the new value'}\n\n(or /cancel)`);
    });

    // per-wallet confirm-hold delay
    on('cw', async (ctx, rest) => {
      const [watchId, action] = rest.split(':');
      const doc = await this.docFor(this.uid(ctx));
      const w = doc.watched.find((x) => x.id === watchId);
      if (!w) { await ctx.reply('target gone', HTML); return; }
      if (action === 'menu') { await this.showConfirmMenu(ctx, watchId); return; }
      if (action === 'custom') {
        this.pending.set(this.uid(ctx), { expect: `cwval:${watchId}` });
        await this.cbText(ctx, 'enter seconds');
        await this.answer(ctx, '⏳ <b>CONFIRM HOLD</b>\n\nType how many seconds to wait before copying (5–600), e.g. 45\n\n(or /cancel)');
        return;
      }
      const sec = Number(action);
      w.confirmHoldMs = Number.isFinite(sec) && sec > 0 ? Math.round(sec * 1000) : null;
      await this.saveDoc(doc);
      await this.cbText(ctx, describeConfirmHold(w.confirmHoldMs));
      await this.showConfirmMenu(ctx, watchId);
    });

    // wallet
    on('w:gen', async (ctx) => {
      const doc = await this.docFor(this.uid(ctx));
      const phrase = generateMnemonic(24);
      const q = ctx.callbackQuery;
      const msgId = q && 'message' in q && q.message ? (q.message as { message_id?: number }).message_id : undefined;
      // payload carries the phrase + the message id so we can wipe the phrase after confirmation
      this.pending.set(this.uid(ctx), { expect: 'gen_confirm', payload: JSON.stringify({ phrase, msgId }) });
      await this.cbText(ctx, ' ');
      await this.answer(ctx,
        `✨ <b>NEW WALLET</b> — ${this.nextWalletLabel(doc)}\n\nBack this up — shown once, then erased from the chat:\n<code>${phrase}</code>\n\nKACHIBOT stores the derived key <b>and</b> the phrase encrypted; never in plaintext.\n\nReply <b>yes</b> to create, /cancel to abort.`);
    });
    on('w:imp', async (ctx) => { await this.cbText(ctx, ' '); await this.askImport(ctx); });
    on('w:recv', async (ctx) => {
      const doc = await this.docFor(this.uid(ctx));
      const kp = this.tryWallet(doc);
      if (!kp) { await this.showWallet(ctx); return; }
      const addr = kp.kp.publicKey.toBase58();
      await this.cbText(ctx, ' ');
      await this.answer(ctx,
        `📥 <b>RECEIVE</b> — ${this.activeWallet(doc)?.label}\n\nAddress: <code>${addr}</code>\n\nSend SOL (any SPL token works for token accounts) to this address.\n\nExplorer: https://solscan.io/account/${addr}`,
        { kb: this.kb([[B('🔙 Wallet', 'm:wallet')]]) });
    });
    on('w:send', async (ctx) => {
      const doc = await this.docFor(this.uid(ctx));
      if (!this.tryWallet(doc)) { await this.showWallet(ctx); return; }
      this.pending.set(this.uid(ctx), { expect: 'send_addr' });
      await this.cbText(ctx, ' ');
      await this.answer(ctx,
        `📤 <b>SEND SOL</b> — ${this.activeWallet(doc)?.label}\n\nPaste the destination <b>wallet address</b> (or /cancel):`);
    });
    on('w:del', async (ctx) => {
      const doc = await this.docFor(this.uid(ctx));
      if (!doc.wallets.length) { await this.showWallet(ctx); return; }
      this.pending.set(this.uid(ctx), { expect: 'del_wallet' });
      await this.cbText(ctx, ' ');
      await this.answer(ctx,
        `🗑 Delete <b>${this.activeWallet(doc)?.label}</b>?\n\nType <b>DELETE</b> to confirm — this removes the wallet from KACHIBOT (funds on-chain remain yours; export first if you need the key again).`);
    });
    on('w:ren', async (ctx) => {
      const doc = await this.docFor(this.uid(ctx));
      if (!doc.wallets.length) { await this.showWallet(ctx); return; }
      this.pending.set(this.uid(ctx), { expect: 'ren_wallet' });
      await this.cbText(ctx, ' ');
      await this.answer(ctx, `✏️ New label for <b>${this.activeWallet(doc)?.label}</b> (max 24 chars, or /cancel):`);
    });
    on('w:sel', async (ctx, rest) => {
      const doc = await this.docFor(this.uid(ctx));
      if (doc.wallets.some((w) => w.id === rest)) {
        doc.activeWalletId = rest;
        const act = doc.wallets.find((w) => w.id === rest) || null;
        if ((act ? act.secret : null) !== doc.secret) {
          doc.secret = act ? act.secret : null;
          bustWalletCache(this.uid(ctx));
        }
        await this.saveDoc(doc);
      }
      await this.cbText(ctx, 'switched');
      await this.showWallet(ctx);
    });
    on('w:pin', async (ctx) => {
      this.pending.set(this.uid(ctx), { expect: 'set_pin' });
      await this.cbText(ctx, 'enter PIN');
      await this.answer(ctx, '🔐 Choose an export <b>PIN</b> (4–32 chars). Stored salted-hashed.\nType it now, /cancel to abort.');
    });
    on('w:exp', async (ctx) => {
      const doc = await this.docFor(this.uid(ctx));
      if (!doc.wallets.length) { await this.showWallet(ctx); return; }
      if (!doc.pinHash) {
        await this.answer(ctx, '🔐 No PIN set yet.\n\nExports are PIN-gated — set one first.', {
          kb: this.kb([[B('🔐 Set PIN', 'w:pin')], [B('🔙 Wallet', 'm:wallet')]]),
        });
        return;
      }
      this.pending.set(this.uid(ctx), { expect: 'export_pin' });
      await this.cbText(ctx, 'enter PIN');
      await this.answer(ctx, `📤 Export is PIN-gated. Type your PIN to export <b>${this.activeWallet(doc)?.label}</b> (or /cancel):`);
    });
    on('exp:x', async (ctx) => {
      this.pending.delete(this.uid(ctx));
      await this.cbText(ctx, 'cancelled');
    });
    on('exp:s', async (ctx) => {
      const doc = await this.docFor(this.uid(ctx));
      const w = this.activeWallet(doc);
      if (!w) { await this.cbText(ctx, 'no wallet'); return; }
      if (!w.mnemonic) {
        await this.answer(ctx, '❌ This wallet was imported as a raw private key — no seed phrase exists for it. Use <b>Export → Private key</b> instead.', {
          kb: this.kb([[B('🔑 Export private key', 'exp:k')], [B('🔙 Wallet', 'm:wallet')]]),
        });
        return;
      }
      const phrase = decryptSecret(w.mnemonic);
      this.pending.delete(this.uid(ctx));
      await this.cbText(ctx, ' ');
      await this.answer(ctx,
        `🪪 <b>SEED PHRASE</b> — ${w.label}\n\n<code>${phrase}</code>\n\nAnyone with it owns the wallet. Store offline. Never paste into untrusted apps.`,
        { kb: this.kb([[B('🔙 Wallet', 'm:wallet')]]) });
    });
    on('exp:k', async (ctx) => {
      const doc = await this.docFor(this.uid(ctx));
      const w = this.activeWallet(doc);
      if (!w) { await this.cbText(ctx, 'no wallet'); return; }
      const secret = decryptSecret(w.secret);
      this.pending.delete(this.uid(ctx));
      await this.cbText(ctx, ' ');
      await this.answer(ctx,
        `🔑 <b>PRIVATE KEY</b> (base58) — ${w.label}\n\n<code>${secret}</code>\n\nFull signing key. Anyone with it owns the wallet. Store offline.`,
        { kb: this.kb([[B('🪪 Seed phrase', w.mnemonic ? 'exp:s' : 'noop')], [B('🔙 Wallet', 'm:wallet')]]) });
    });

    on('w:bal', async (ctx) => {
      const doc = await this.docFor(this.uid(ctx));
      const kp = this.tryWallet(doc);
      if (!kp) { await this.showWallet(ctx); return; }
      await this.cbText(ctx, 'refreshing…');
      const b = await this.balanceRace(kp.kp.publicKey);
      if (b !== null) this.balCache.set(kp.kp.publicKey.toBase58(), b);
      await this.showWallet(ctx);
    });

    // watchlist
    on('w:add', async (ctx) => {
      this.pending.set(this.uid(ctx), { expect: 'watch_add' });
      await this.cbText(ctx, 'paste link');
      await this.answer(ctx, '👀 Paste a <b>wallet address</b> or <b>pump.fun coin/profile link</b> (or /cancel):');
    });
    on('wv', async (ctx, rest) => {
      const [watchId, action] = rest.split(':');
      if (!action) { await this.watchDetail(ctx, watchId); return; }
      const doc = await this.docFor(this.uid(ctx));
      const w = doc.watched.find((x) => x.id === watchId);
      if (!w) return;
      if (action === 'remove') {
        doc.watched = doc.watched.filter((x) => x.id !== watchId);
        await this.saveDoc(doc);
        // remove exactly this watch — the user's other watched wallets stay live
        await watcher.removeTargetForUser(this.uid(ctx), watchId);
        await this.cbText(ctx, 'removed');
        await this.showWatch(ctx);
        return;
      }
      if (action === 'pause') {
        w.paused = !w.paused;
        if (w.paused) w.pausedAt = Date.now();
        else w.pausedAt = undefined;
        await this.saveDoc(doc);
        if (w.paused) {
          await watcher.removeTargetForUser(this.uid(ctx), watchId); // free the stream
        } else {
          await watcher.addTargetForUser(this.uid(ctx)); // resume watching
        }
        await this.cbText(ctx, w.paused ? 'paused' : 'live');
        await this.watchDetail(ctx, watchId);
        return;
      }
    });

    // trades
    on('sell', async (ctx, rest) => {
      await this.cbText(ctx, '💸 selling…');
      const open = await getStore().listTrades(this.uid(ctx), 'open');
      const target = open.find((t) => t.id === rest);
      if (!target) return;
      await trader.sellOpenPosition(this.uid(ctx), rest, 'MANUAL');
    });
    on('pos', async (ctx, rest) => { await this.cbText(ctx, ' '); await this.positionCard(ctx, rest); });
    on('closeStale', async (ctx, rest) => {
      await this.cbText(ctx, '🧹 closing stale entry…');
      await trader.closeStalePosition(this.uid(ctx), String(rest)).catch(() => null);
      await this.showPositions(ctx);
    });
    on('sellfrac', async (ctx, rest) => {
      const [rowId, pctRaw] = String(rest).split(':');
      const pct = Number(pctRaw);
      if (!rowId || !Number.isFinite(pct) || pct <= 0) return;
      await this.cbText(ctx, `💸 selling ${pct}%…`);
      await trader.sellFraction(this.uid(ctx), rowId, Math.min(1, pct / 100), 'MANUAL').catch(() => null);
    });
    on('score', async (ctx, rest) => {
      const all = await getStore().listTrades(this.uid(ctx));
      const t = all.find((x) => x.id === rest);
      if (!t) return;
      const closed = all.filter((x) => x.status === 'closed');
      const running = closed.reduce((a, x) => a + (x.pnlLamports ?? 0), 0);
      const seq = Math.max(1, closed.findIndex((x) => x.id === rest) + 1);
      const solUsd = await getSolUsd().catch(() => null);
      await this.cbText(ctx, ' ');
      await this.answer(ctx, scorecardText(t, seq, running, solUsd), { kb: this.kb([[B('📖 History', 'm:history')]]) });
    });
    on('m:pnl', async (ctx) => { await this.cbText(ctx, ' '); await this.showPnl(ctx); });
    on('hist', async (ctx, rest) => { await this.cbText(ctx, ' '); await this.showHistory(ctx, Number(rest) || 0); });
    on('panic', async (ctx) => { await this.cbText(ctx, ' '); await this.confirmPanic(ctx); });
    on('a', async (ctx, rest) => {
      const doc = await this.docFor(this.uid(ctx));
      if (rest === 'snipes' || rest === 'sells' || rest === 'activity') {
        doc.settings.alerts[rest] = !doc.settings.alerts[rest];
        await this.saveDoc(doc);
      }
      await this.cbText(ctx, 'updated');
      await this.showAlerts(ctx);
    });
  }

  private async confirmPanic(ctx: Context): Promise<void> {
    const userId = this.uid(ctx);
    const doc = await this.docFor(userId);
    if (!doc.secret) { await this.answer(ctx, '🧯 no wallet → nothing to sell', {}); return; }
    const open = await getStore().listTrades(userId, 'open');
    if (!open.length) { await this.answer(ctx, '🧯 no open positions', {}); return; }
    if (doc.pinHash) {
      this.pending.set(userId, { expect: 'panic_pin' });
      await this.answer(ctx, `🧯 <b>PANIC SELL-ALL</b> — ${open.length} open position${open.length === 1 ? '' : 's'}.\n\nType your PIN to confirm (or /cancel):`);
    } else {
      this.pending.set(userId, { expect: 'panic_confirm' });
      await this.answer(ctx, `🧯 <b>PANIC SELL-ALL</b> — ${open.length} open position${open.length === 1 ? '' : 's'}, any reason.\n\nReply <b>yes</b> to dump everything (or /cancel):`);
    }
  }

  /* ------------------------------ text mode ------------------------------ */

  private textInputs(): void {
    this.bot.on('text', async (ctx) => {
      const userId = this.uid(ctx);
      const text = (ctx.message as { text: string }).text;
      if (text.startsWith('/')) return;
      const stage = this.pending.get(userId);
      if (!stage) {
        if (ctx.chat?.type === 'private') await this.showMain(ctx);
        return;
      }
      this.pending.delete(userId);
      const doc = await this.docFor(userId);
      try {
        if (stage.expect.startsWith('setting:')) {
          const key = stage.expect.slice(8);
          const res = validateAndApply(key, text, doc.settings);
          if (!res.ok) {
            await ctx.reply(`❌ ${res.error} — try again or /cancel.`, HTML);
            this.pending.set(userId, stage);
            return;
          }
          await this.saveDoc(doc);
          await ctx.reply(`✅ <b>${res.applied}</b>`, HTML);
          await this.showSettings(ctx);
          return;
        }
        if (stage.expect.startsWith('cwval:')) {
          const watchId = stage.expect.slice(6);
          const w = doc.watched.find((x) => x.id === watchId);
          if (!w) { await ctx.reply('target gone', HTML); return; }
          const sec = Number(text.trim());
          if (!Number.isFinite(sec) || sec < 5 || sec > 600) {
            await ctx.reply('❌ enter seconds between 5 and 600 — try again or /cancel.', HTML);
            this.pending.set(userId, stage);
            return;
          }
          w.confirmHoldMs = Math.round(sec * 1000);
          await this.saveDoc(doc);
          await ctx.reply(`✅ ${escTag(w.label)}: <b>${describeConfirmHold(w.confirmHoldMs)}</b>`, HTML);
          await this.watchDetail(ctx, watchId);
          return;
        }
        if (stage.expect.startsWith('bsval:')) {
          const [, watchId, mode] = stage.expect.split(':');
          const w = doc.watched.find((x) => x.id === watchId);
          if (!w) { await ctx.reply('target gone', HTML); return; }
          const n = Number(text.replace(/[%,]/g, '').replace(/sol/i, '').trim());
          if (!Number.isFinite(n) || n <= 0) {
            await ctx.reply('❌ enter a positive number — try again or /cancel.', HTML);
            this.pending.set(userId, stage);
            return;
          }
          const cfg: BuySizeConfig = mode === 'pct'
            ? { mode: 'pct', value: Math.min(2, n / 100) }
            : { mode: 'fixed', value: Math.floor(n * 1e9) };
          w.buySize = cfg;
          await this.saveDoc(doc);
          await ctx.reply(`✅ buy size for ${escTag(w.label)}: <b>${describeBuySize(cfg)}</b>`, HTML);
          await this.watchDetail(ctx, watchId);
          return;
        }
        if (stage.expect.startsWith('exitval:')) {
          const [, scope, mode] = stage.expect.split(':');
          const parsed = parseExitInput(mode as ExitMode, text);
          if (!parsed.ok) {
            await ctx.reply(`❌ ${parsed.error} — try again or /cancel.`, HTML);
            this.pending.set(userId, stage);
            return;
          }
          if (scope === 'g') doc.settings.exit = parsed.cfg;
          else {
            const w = doc.watched.find((x) => x.id === scope);
            if (!w) { await ctx.reply('target gone', HTML); return; }
            w.exit = parsed.cfg;
          }
          await this.saveDoc(doc);
          await ctx.reply(`✅ exit rule: <b>${describeExit(parsed.cfg)}</b>`, HTML);
          await this.afterExitChange(ctx, scope);
          return;
        }
        if (stage.expect === 'watch_add') { await this.addWatch(ctx, text); return; }
        if (stage.expect === 'import_confirm') {
          if (!/^yes$/i.test(text.trim())) { await ctx.reply('🚫 import cancelled.', HTML); return; }
          await this.askImport(ctx);
          return;
        }
        if (stage.expect === 'import_input') {
          try {
            const r = await this.runImport(userId, text);
            await ctx.reply(`✅ <b>WALLET IMPORTED &amp; ACTIVE</b> — ${escTag(r.label)}\n\nAddress: <code>${r.address}</code>\n\nStored encrypted (AES-256-GCM). Copy-trades now spend from this wallet.`, HTML);
          } catch (e) {
            await ctx.reply(`❌ import failed: ${(e as Error).message}`, HTML);
            this.pending.set(userId, stage);
          }
          return;
        }
        if (stage.expect === 'send_addr') {
          let to = text.trim();
          try { new PublicKey(to); } catch { await ctx.reply('❌ that is not a valid Solana address — try again or /cancel.', HTML); this.pending.set(userId, stage); return; }
          this.pending.set(userId, { expect: 'send_amt', payload: to });
          await ctx.reply(`📤 Send to <code>${to}</code>\n\nAmount in <b>SOL</b> (e.g. 0.05) — or /cancel:`, HTML);
          return;
        }
        if (stage.expect === 'send_amt') {
          const amt = Number(text.trim());
          const to = stage.payload || '';
          if (!Number.isFinite(amt) || amt <= 0) { await ctx.reply('❌ enter a positive number in SOL — try again or /cancel.', HTML); this.pending.set(userId, stage); return; }
          const lamports = Math.floor(amt * 1e9);
          const w = this.activeWallet(doc);
          const bal = w ? await this.balanceRace(keypairFromSecret(decryptSecret(w.secret)).publicKey) : null;
          if (bal !== null && bal < lamports + 10_000) {
            await ctx.reply(`❌ insufficient balance — have ${solShort(bal)}, need ${solShort(lamports)} + fees. /cancel`, HTML);
            this.pending.delete(userId);
            return;
          }
          if (doc.pinHash) {
            this.pending.set(userId, { expect: 'send_pin', payload: `${to}|${lamports}` });
            await ctx.reply(`🔐 Send <b>${solShort(lamports)}</b> to <code>${to.slice(0, 6)}…${to.slice(-4)}</code> is PIN-gated. Type your PIN (or /cancel):`, HTML);
          } else {
            this.pending.delete(userId);
            const r = await this.doSend(userId, to, lamports);
            await ctx.reply(r.ok
              ? `✅ <b>SENT</b> — ${r.message}\n\nhttps://solscan.io/tx/${r.sig}`
              : `❌ send failed: ${r.message}`, HTML);
          }
          return;
        }
        if (stage.expect === 'send_pin') {
          if (!doc.pinHash || this.hashPin(text.trim()) !== doc.pinHash) {
            await ctx.reply('❌ wrong PIN — try again or /cancel.', HTML);
            this.pending.set(userId, stage);
            return;
          }
          this.pending.delete(userId);
          const [to, lamportsStr] = (stage.payload || '|').split('|');
          const r = await this.doSend(userId, to, Number(lamportsStr));
          await ctx.reply(r.ok
            ? `✅ <b>SENT</b> — ${r.message}\n\nhttps://solscan.io/tx/${r.sig}`
            : `❌ send failed: ${r.message}`, HTML);
          return;
        }
        if (stage.expect === 'del_wallet') {
          if (text.trim() !== 'DELETE') { await ctx.reply('🚫 delete cancelled.', HTML); return; }
          const gone = this.activeWallet(doc);
          if (!gone) { await ctx.reply('no wallet', HTML); return; }
          doc.wallets = doc.wallets.filter((x) => x.id !== gone.id);
          this.normalizeWallets(doc);
          await this.saveDoc(doc);
          await getStore().flush();
          await ctx.reply(doc.wallets.length
            ? `🗑 <b>DELETED</b> ${gone.label}. Now active: ${this.activeWallet(doc)?.label}.`
            : '🗑 Deleted. Generate or import a wallet when ready.', HTML);
          return;
        }
        if (stage.expect === 'ren_wallet') {
          const w = this.activeWallet(doc);
          if (!w) { await ctx.reply('no wallet', HTML); return; }
          const label = text.trim().slice(0, 24);
          if (!label) { await ctx.reply('❌ empty label — /cancel', HTML); return; }
          w.label = label;
          await this.saveDoc(doc);
          await ctx.reply(`✅ renamed to <b>${label}</b>`, HTML);
          return;
        }
        if (stage.expect === 'gen_confirm') {
          if (!/^yes$/i.test(text.trim())) { await ctx.reply('🚫 generation cancelled.', HTML); return; }
          let phrase = stage.payload || '';
          let phraseMsgId: number | undefined;
          try {
            const j = JSON.parse(stage.payload || '{}');
            phrase = j.phrase || phrase;
            phraseMsgId = j.msgId;
          } catch { /* legacy plain-phrase payload */ }
          const kp = keypairFromMnemonic(phrase);
          const w = this.addWalletRecord(doc, { secret: encryptSecret(keypairToSecret(kp)), mnemonic: encryptSecret(phrase) });
          await this.saveDoc(doc);
          await getStore().flush(); // wallet secrets must survive a crash — write now
          // wipe the seed phrase from the chat — it was "shown once"
          if (phraseMsgId && ctx.chat?.id) {
            await ctx.telegram.deleteMessage(ctx.chat.id, phraseMsgId).catch(() => undefined);
          }
          await ctx.reply(`✅ <b>WALLET CREATED</b> — ${w.label}\n\nAddress: <code>${kp.publicKey.toBase58()}</code>\n\nSOL balance: ◎0 — send SOL to this address to fund snipes.`, {
            ...HTML,
            reply_markup: Markup.inlineKeyboard([[Markup.button.callback('💼 View wallet', 'm:wallet')]]).reply_markup,
          });
          return;
        }
        if (stage.expect === 'set_pin') {
          if (!/^[\x21-\x7E]{4,32}$/.test(text.trim())) {
            await ctx.reply('❌ PIN: 4–32 printable characters. Try again or /cancel.', HTML);
            this.pending.set(userId, stage);
            return;
          }
          doc.pinHash = this.hashPin(text.trim());
          await this.saveDoc(doc);
          await getStore().flush(); // PIN gates exports — write now
          await ctx.reply('✅ <b>PIN SET</b> — exports and panic sell-all now require it.', HTML);
          return;
        }
        if (stage.expect === 'export_pin') {
          if (!doc.pinHash || this.hashPin(text.trim()) !== doc.pinHash) {
            await ctx.reply('❌ wrong PIN — try again or /cancel.', HTML);
            this.pending.set(userId, stage);
            return;
          }
          const w = this.activeWallet(doc);
          if (!w) { await ctx.reply('❌ no wallet to export', HTML); return; }
          this.pending.set(userId, { expect: 'export_choice' });
          await ctx.reply(`✅ PIN OK — what do you want to copy for <b>${w.label}</b>?`, {
            ...HTML,
            reply_markup: Markup.inlineKeyboard([
              ...(w.mnemonic ? [[Markup.button.callback('🪪 Seed phrase', 'exp:s')]] : []),
              [Markup.button.callback('🔑 Private key', 'exp:k')],
              [Markup.button.callback('🚫 cancel', 'exp:x')],
            ]).reply_markup,
          });
          return;
        }
        if (stage.expect === 'panic_confirm' || stage.expect === 'panic_pin') {
          if (stage.expect === 'panic_pin') {
            if (!doc.pinHash || this.hashPin(text.trim()) !== doc.pinHash) {
              await ctx.reply('❌ wrong PIN — /cancel to abort.', HTML);
              this.pending.set(userId, stage);
              return;
            }
          } else if (!/^yes$/i.test(text.trim())) {
            await ctx.reply('🧯 panic cancelled.', HTML);
            return;
          }
          await ctx.reply('🧯 dumping everything…', HTML);
          const n = await trader.sellAll(userId, 'PANIC');
          await ctx.reply(n > 0 ? `🧯 done — ${n} position${n === 1 ? '' : 's'} closed.` : '🧯 nothing left to sell.', HTML);
          return;
        }
      } catch (e) {
        console.error('[bot] text:', (e as Error).message);
        await ctx.reply(`❌ ${(e as Error).message}`, HTML).catch(() => undefined);
      }
    });
  }

  /* -------------------------------- launch ------------------------------- */

  async launch(): Promise<void> {
    registerNotifier(async (userId, html, opts) => {
      const kb = opts?.buttons?.length
        ? Markup.inlineKeyboard(opts.buttons.map((r) => r.map(([label, data]) => Markup.button.callback(label, data))))
        : undefined;
      await this.bot.telegram.sendMessage(userId, html, { ...HTML, reply_markup: kb?.reply_markup });
    });
    await this.bot.launch();
    console.log('[bot] KACHIBOT polling on Telegram ✓');
  }

  async stop(): Promise<void> {
    try { await this.bot.stop('shutdown'); } catch { /* ignore */ }
  }
}

function escTag(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function startBot(token: string): KachiBot {
  const b = new KachiBot(token);
  b.launch().catch((err: Error) => {
    // 409 = another poller (duplicate instance or a manual getUpdates) stole
    // the long-poll. Telegraf's loop is dead after this — a silent deaf bot is
    // worse than a restart, so exit hard and let the supervisor bring us back.
    console.error('[bot] polling failed:', err?.message || err);
    console.error('[bot] exiting for supervisor restart (5s)…');
    setTimeout(() => process.exit(1), 5000).unref();
  });
  return b;
}
