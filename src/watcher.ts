/**
 * KACHIBOT — on-chain watcher.
 * One account-change WebSocket subscription per watched wallet + a slow
 * polling backstop (missed-signature recovery). Every pump-program
 * buy/sell instruction mentioning the watched wallet as the signer is
 * decoded (outer + CPI inner instructions, any router path) and forwarded
 * to the trader as a WatchSignal with spend estimation.
 */
import { Connection, PublicKey } from '@solana/web3.js';
import { getConnection } from './chain/conn';
import { getStore, Store } from './db';
import {
  classifyPumpIx, curvePhase, fetchCurve, loadPricingCtx,
  solLamportsForTokenAmount, isLiveCurve, captureTemplate, deriveAta,
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID,
} from './chain/pump';
import { trader, type WatchSignal } from './trader';
import { UserDoc, WatchedWallet, soldFractionOf } from './types';
import { notifyUser } from './notify';
import { decodeMessageView, allIxs, detectSwapSignals, determineSide, PRIME_STALE_MS, isStaleTx } from './chain/txview';
import BN from 'bn.js';
import { getTokenMeta } from './chain/meta';
import { coinTag, solExact, esc } from './format';

const FETCH_ATTEMPTS = 4;

type MintMetaLite = { at: number; name: string | null; symbol: string | null };
/** 30-min cache of full token identity so every alert can name the coin */
const mintMetaLite = new Map<string, MintMetaLite>();

async function resolveMintMeta(conn: Connection, mint: string): Promise<MintMetaLite> {
  const hit = mintMetaLite.get(mint);
  if (hit && Date.now() - hit.at < 30 * 60_000) return hit;
  try {
    const m = await getTokenMeta(conn, new PublicKey(mint));
    const rec: MintMetaLite = { at: Date.now(), name: m?.name ?? null, symbol: m?.symbol ?? null };
    mintMetaLite.set(mint, rec);
    return rec;
  } catch {
    const rec: MintMetaLite = { at: Date.now(), name: null, symbol: null };
    mintMetaLite.set(mint, rec);
    return rec;
  }
}

class Watcher {
  private store: Store = getStore();
  private conn: Connection = getConnection();

  /** address -> set of "userId:watchId" subscriptions */
  private targets = new Map<string, Set<string>>();
  /** address -> { wsId } when subscribed */
  private wsByAddress = new Map<string, number>();
  /** address -> next allowed resubscribe attempt (ms) — subscription self-heal */
  private subRetryAt = new Map<string, number>();
  /** address -> Set of processed tx signatures */
  private processed = new Map<string, Set<string>>();
  /** signature -> lastSeen (ms) for dedupe while processing */
  private inFlight = new Map<string, number>();
  /** address -> timestamp of last processed tx per target (cooldown) */
  private lastBuyAt = new Map<string, number>();
  private spamWarned = new Map<string, number>();

  /** read-only health snapshot for the /status endpoint (no full addresses) */
  async debugState(): Promise<Record<string, unknown>> {
    const users = await this.allUserDocs().catch(() => [] as UserDoc[]);
    const watches: Array<Record<string, unknown>> = [];
    for (const u of users) {
      for (const w of u.watched || []) {
        watches.push({
          label: w.label,
          prefix: String(w.address).slice(0, 6),
          paused: !!w.paused,
          subscribed: this.wsByAddress.has(w.address),
          addedAt: w.addedAt,
          lastBuySeenAt: w.lastBuySeenAt ?? null,
        });
      }
    }
    const lastPollAgesSec = [...this.lastPollAt.values()]
      .map((t) => Math.round((Date.now() - t) / 1000))
      .sort((a, b) => a - b)
      .slice(0, 12);
    return {
      targets: this.targets.size,
      subscriptions: this.wsByAddress.size,
      processedSets: this.processed.size,
      lastPollAgesSec,
      watches,
    };
  }

  /** called at boot: load every user's watches */
  async syncAll(): Promise<void> {
    const users = await this.allUserDocs();
    for (const u of users) {
      for (const w of u.watched) {
        if (w.paused) continue;
        this.addTarget(u, w);
      }
    }
    await this.reconcileSubscriptions();
    console.log(`[watcher] watching ${this.targets.size} unique wallet(s) for ${users.length} user(s)`);
  }

  private async allUserDocs(): Promise<UserDoc[]> {
    // store-specific list; local file store exposes listUsers internally
    const store = this.store as unknown as { listUsers?: () => Promise<UserDoc[]> };
    if (store.listUsers) return store.listUsers().catch(() => []);
    return [];
  }

  async addTargetForUser(userId: number): Promise<void> {
    const doc = await this.store.getUser(userId);
    for (const w of doc.watched) {
      if (w.paused) continue;
      this.addTarget(doc, w);
    }
    await this.reconcileSubscriptions();
  }

  private addTarget(doc: UserDoc, w: WatchedWallet): void {
    const key = `${doc.userId}:${w.id}`;
    const set = this.targets.get(w.address) || new Set<string>();
    set.add(key);
    this.targets.set(w.address, set);
  }

  /** remove one specific watch (watchId) — or all of the user's watches when omitted */
  async removeTargetForUser(userId: number, watchId?: string): Promise<void> {
    for (const [address, set] of this.targets) {
      for (const key of [...set]) {
        const remove = watchId
          ? key === `${userId}:${watchId}`
          : key.startsWith(`${userId}:`);
        if (remove) set.delete(key);
      }
      if (set.size === 0) this.targets.delete(address);
    }
    await this.reconcileSubscriptions();
  }

  private async reconcileSubscriptions(): Promise<void> {
    const wanted = new Set(this.targets.keys());
    for (const address of wanted) {
      if (!this.wsByAddress.has(address)) {
        await this.subscribe(address);
      }
    }
    for (const [address] of this.wsByAddress) {
      if (!wanted.has(address)) {
        await this.unsubscribe(address);
      }
    }
  }

  private async subscribe(address: string): Promise<void> {
    const pk = new PublicKey(address);
    try {
      const wsId = await this.conn.onAccountChange(pk, () => {
        // account mutated -> pull the newest signatures for this wallet
        void this.poll(address, false);
      }, 'confirmed');
      this.wsByAddress.set(address, wsId);
      // Prime: mark the wallet's existing recent txs as already-seen so a new
      // watch starts copying from NOW, not from its last few old buys.
      void this.prime(address);
    } catch (e) {
      console.error(`[watcher] account subscription failed for ${address}:`, (e as Error).message);
    }
  }

  /** mark the most recent signatures as processed WITHOUT analyzing them */
  private async prime(address: string): Promise<void> {
    try {
      // fetch MORE than poll() does, so a restart can never leave un-primed
      // signatures inside the poll window for re-analysis
      const sigs = await this.conn.getSignaturesForAddress(new PublicKey(address), { limit: 16 }, 'confirmed');
      const cutoff = Date.now() - PRIME_STALE_MS;
      for (const sg of sigs || []) {
        // Only swallow genuinely OLD history. Prime must never eat buys that
        // happened moments ago — that is exactly what happens when a host
        // restarts / wakes from sleep and the ape traded during the gap.
        const bt = (sg.blockTime || 0) * 1000;
        if (bt && bt >= cutoff) continue;
        this.markProcessed(address, sg.signature);
      }
    } catch {
      // best effort — the account-change stream + backstop still cover live buys
    }
  }

  private async unsubscribe(address: string): Promise<void> {
    const wsId = this.wsByAddress.get(address);
    if (wsId !== undefined) {
      try { await this.conn.removeAccountChangeListener(wsId); } catch { /* ignore */ }
      this.wsByAddress.delete(address);
    }
    // NB: keep the processed-signature history — wiping it would let a resumed
    // or re-added watch replay OLD buys and copy them at today's price.
  }

  /**
   * Backstop loop: every few seconds each live wallet gets a cheap
   * getSignaturesForAddress poll so nothing is missed between ws events.
   */
  startBackstop(intervalMs = 7000): void {
    const tick = (): void => {
      const now = Date.now();
      // poll every TARGET (not just successfully-subscribed addresses): if a
      // websocket subscription ever dies silently, polling must continue.
      const pollSet = new Set<string>([...this.wsByAddress.keys(), ...this.targets.keys()]);
      for (const address of pollSet) {
        void this.poll(address, true);
      }
      // self-heal: if a subscription failed or died, resubscribe (throttled)
      for (const address of this.targets.keys()) {
        if (this.wsByAddress.has(address)) continue;
        if (now - (this.subRetryAt.get(address) || 0) < 30_000) continue;
        this.subRetryAt.set(address, now);
        void this.subscribe(address);
      }
    };
    const t = setInterval(tick, intervalMs);
    if (typeof t.unref === 'function') t.unref();
  }

  private lastPollAt = new Map<string, number>();

  private async poll(address: string, backstop: boolean): Promise<void> {
    if (this.inFlight.has(address)) return; // serialize per address
    this.inFlight.set(address, Date.now());
    this.lastPollAt.set(address, Date.now());
    try {
      const sigs = await this.conn.getSignaturesForAddress(
        new PublicKey(address),
        { limit: 10 },
        'confirmed',
      );
      for (const s of sigs || []) {
        if (s.err) continue; // failed tx -> wallet's trade didn't happen
        if (this.isProcessed(address, s.signature)) continue;
        await this.processSignature(address, s.signature);
      }
    } catch {
      // RPC hiccup — next tick retries
    } finally {
      this.inFlight.delete(address);
    }
    void backstop;
  }

  private isProcessed(address: string, sig: string): boolean {
    const set = this.processed.get(address);
    if (!set) return false;
    return set.has(sig) || this.inFlight.has(sig);
  }

  private async processSignature(address: string, signature: string): Promise<void> {
    this.inFlight.set(signature, Date.now());
    try {
      let tx: Awaited<ReturnType<Connection['getTransaction']>> | null = null;
      for (let i = 0; i < FETCH_ATTEMPTS && !tx; i++) {
        tx = await this.conn.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 })
          .catch(() => null);
        if (!tx) await sleep(1200);
      }
      this.markProcessed(address, signature);
      if (!tx || tx.meta?.err) return;
      await this.analyzeTx(address, signature, tx);
    } catch {
      this.markProcessed(address, signature);
    } finally {
      this.inFlight.delete(signature);
    }
  }

  private markProcessed(address: string, sig: string): void {
    let set = this.processed.get(address);
    if (!set) {
      set = new Set();
      this.processed.set(address, set);
    }
    set.add(sig);
    if (set.size > 200) {
      // keep the set bounded
      const first = set.values().next().value as string;
      set.delete(first);
    }
  }

  /* ------------------------------ analysis ------------------------------ */

  private async analyzeTx(
    address: string,
    signature: string,
    tx: NonNullable<Awaited<ReturnType<Connection['getTransaction']>>>,
  ): Promise<void> {
    // NOTE: the RPC returns two message shapes (legacy accountKeys vs
    // versioned staticAccountKeys+compiledInstructions+loadedAddresses).
    // decodeMessageView normalizes both into pkeys + instructions so v0 txs
    // (the norm in 2026) decode identically to legacy ones.
    // hard guard: never mirror a trade that happened too long ago (bot was
    // asleep / restarting). Prevents copying an old buy at today's price.
    if (isStaleTx(tx.blockTime, Date.now())) return;
    const view = decodeMessageView(tx);
    if (!view) return;
    const pkeys = view.pkeys;
    const allIxes = allIxs(view);
    // exact SOL that left the watched wallet in this tx (buys); negative on sells
    const watchedIdx = pkeys.indexOf(address);
    const watchedSolOut = watchedIdx >= 0 && tx.meta
      ? (tx.meta.preBalances?.[watchedIdx] ?? 0) - (tx.meta.postBalances?.[watchedIdx] ?? 0)
      : 0;

    // ---- pump-program trade detection (live empirical disc table + log names + balance deltas) ----
    const events: Array<{
      side: 'buy' | 'sell'; name: string; mint: string;
      tokenDeltaRaw: bigint | null; userAta: string | null;
      template: { dataB64: string; accAddrs: string[]; traderPos: number; traderAtaPos: number } | null;
      solMoved?: number | null;
    }> = [];
    const logs = (tx.meta as unknown as { logMessages?: string[] })?.logMessages || [];
    const logBuy = logs.some((l) => l.startsWith('Program log: Instruction: ') && /\bBuy/i.test(l));
    const logSell = logs.some((l) => l.startsWith('Program log: Instruction: ') && /\bSell/i.test(l));

    // watched wallet token deltas in this tx (owner-indexed balance entries)
    const preTok = ((tx.meta as unknown as { preTokenBalances?: Array<{ accountIndex: number; owner: string | null; mint: string; uiTokenAmount?: { amount: string } }> })?.preTokenBalances) || [];
    const postTok = ((tx.meta as unknown as { postTokenBalances?: Array<{ accountIndex: number; owner: string | null; mint: string; uiTokenAmount?: { amount: string } }> })?.postTokenBalances) || [];
    const deltaByOwner = new Map<string, Map<string, bigint>>(); // owner -> mint -> delta
    // owner -> mint -> balance before/after: lets us measure WHAT FRACTION of
    // the watched wallet's bag a sell actually was (60% sold = 60% copied).
    const balByOwner = new Map<string, Map<string, { pre: bigint; post: bigint }>>();
    for (const b of postTok) {
      if (!b.owner || !b.mint) continue;
      const pre = preTok.find((p) => p.accountIndex === b.accountIndex);
      const cur = BigInt(b.uiTokenAmount?.amount ?? '0');
      const prev = pre ? BigInt(pre.uiTokenAmount?.amount ?? '0') : 0n;
      if (!balByOwner.has(b.owner)) balByOwner.set(b.owner, new Map());
      balByOwner.get(b.owner)!.set(b.mint, { pre: prev, post: cur });
      const d = cur - prev;
      if (d === 0n) continue;
      if (!deltaByOwner.has(b.owner)) deltaByOwner.set(b.owner, new Map());
      const m = deltaByOwner.get(b.owner)!;
      m.set(b.mint, (m.get(b.mint) || 0n) + d);
    }
    const wsolStr = 'So11111111111111111111111111111111111111112';

    for (const ix of allIxes) {
      if (String(pkeys[ix.programIdIndex]) !== '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P') continue;
      if (!ix.data || ix.data.length < 8) continue;
      const data = Buffer.from(ix.data, 'base64');
      const sig = classifyPumpIx(data);
      if (!sig) continue; // non-trade pump call (fee collect, volume init, ...)
      const accIdx = (ix.accounts || []).map((v) => Number(v));
      const accAddrs = accIdx.map((i) => pkeys[i]).filter((x): x is string => !!x);
      const traderPos = accAddrs.indexOf(address);
      const watchedDeltas = deltaByOwner.get(address) || new Map<string, bigint>();
      // find the token this ix trades: any non-wSOL mint with a watched-wallet delta
      let mint: string | null = null;
      let tokenDeltaRaw: bigint | null = null;
      let deltaSign = 0;
      let userAta: string | null = null;
      for (const [m, d] of watchedDeltas) {
        if (m === wsolStr) continue;
        if (!mint) { mint = m; tokenDeltaRaw = d < 0n ? -d : d; deltaSign = d > 0n ? 1 : d < 0n ? -1 : 0; }
      }
      if (!mint) {
        // no balance delta recorded for this wallet — rely on canonical ATA presence
        for (const [m, d] of watchedDeltas) {
          if (m !== wsolStr) { mint = m; tokenDeltaRaw = d < 0n ? -d : d; break; }
        }
      }
      if (!mint) continue;
      // template capture: account vector + payload of this live trade
      const side = determineSide(sig.side, logBuy, logSell, traderPos, deltaSign);
      const canTok22 = deriveAta(new PublicKey(address), new PublicKey(mint), TOKEN_2022_PROGRAM_ID).toBase58();
      const canSpl = deriveAta(new PublicKey(address), new PublicKey(mint), TOKEN_PROGRAM_ID).toBase58();
      const tok22Idx = accAddrs.indexOf(canTok22);
      const splIdx = accAddrs.indexOf(canSpl);
      const tokenProg: 'token2022' | 'spl' = tok22Idx >= 0 ? 'token2022' : splIdx >= 0 ? 'spl' : 'token2022';
      const ataPos = userAta ? accAddrs.indexOf(userAta) : (tok22Idx >= 0 ? tok22Idx : splIdx);
      const tpl = traderPos >= 0 ? {
        mint,
        side,
        name: sig.name,
        discLe: data.readBigUInt64LE(0).toString(),
        dataB64: ix.data,
        accAddrs,
        traderPos,
        traderAtaPos: ataPos >= 0 ? ataPos : -1,
        traderAtaAddr: userAta ?? (ataPos >= 0 ? accAddrs[ataPos] : ''),
        tokenProgram: tokenProg,
        tokenDeltaRaw: tokenDeltaRaw !== null ? tokenDeltaRaw.toString() : null,
        quoteDeltaRaw: null,
        sig: signature,
      } : null;
      if (tpl) captureTemplate(tpl);
      events.push({ side, name: sig.name, mint, tokenDeltaRaw, userAta, template: tpl });
    }
    if (!events.length) {
      // Off-curve trade (graduated coin on PumpSwap/Raydium/Meteora/Orca/…):
      // no pump ix to catch, so mirror the wallet's swap via balance deltas.
      for (const sg of detectSwapSignals(view, tx.meta, address)) {
        events.push({
          side: sg.side,
          name: 'Swap',
          mint: sg.mint,
          tokenDeltaRaw: sg.tokenDeltaRaw,
          userAta: null,
          template: null,
          solMoved: sg.solMovedLamports ?? null,
        });
      }
    }
    if (!events.length) return;

    const targetKeys = this.targets.get(address);
    if (!targetKeys) return;
    // snapshot each subscriber doc once per tx (consistent settings)
    const subscribers: Array<{ userId: number; watch: WatchedWallet; doc: UserDoc }> = [];
    for (const key of targetKeys) {
      const [uidStr, watchId] = key.split(':');
      const userId = Number(uidStr);
      const doc = await this.store.getUser(userId).catch(() => null);
      if (!doc) continue;
      const watch = doc.watched.find((w) => w.id === watchId);
      if (!watch || watch.paused) continue;
      subscribers.push({ userId, watch, doc });
    }
    if (!subscribers.length) return;

    // resolve full coin identity once per mint in this tx
    const metaByMint = new Map<string, MintMetaLite>();
    for (const ev of events) {
      if (metaByMint.has(ev.mint)) continue;
      metaByMint.set(ev.mint, await resolveMintMeta(this.conn, ev.mint));
    }

    // estimateSpend hits RPC; two users watching the same wallet shouldn't
    // each pay for the same coin twice in one tx
    const spendEstCache = new Map<string, number | null>();
    // docs whose watch saw a buy — persist "last buy seen" once per tx
    const dirtyDocs = new Set<UserDoc>();
    for (const ev of events) {
      const now = Date.now();
      for (const sub of subscribers) {
        const settings = sub.doc.settings;
        if (ev.side === 'buy') {
          // remember the wallet's last seen buy (also counts buys skipped by cooldown)
          if (sub.watch.lastBuySeenAt !== now) {
            sub.watch.lastBuySeenAt = now;
            dirtyDocs.add(sub.doc);
          }
          // anti-spam: cooldown per user+watch
          const cdKey = `${sub.userId}:${sub.watch.id}`;
          const last = this.lastBuyAt.get(cdKey) || 0;
          if (now - last < settings.watcherCooldownMs) continue;
          this.lastBuyAt.set(cdKey, now);

          if (now - (this.spamWarned.get(cdKey) || 0) > 60_000 && events.length >= 3) {
            this.spamWarned.set(cdKey, now);
            await notifyUser(sub.userId, `⚡ <b>RAPID-FIRE</b> — ${sub.watch.label} fired ${events.length} buys in one block. Cooldown ${Math.round(settings.watcherCooldownMs / 1000)}s is guarding your ammo.`, { silent: true });
          }
        }

        // The spend estimate powers %-mode sizing AND the min/max spend
        // filters, so it must run on every buy regardless of whether the
        // RADAR alert happens to be enabled (it is off by default).
        let spend: number | null = null;
        let spentExact: number | null = null;
        if (ev.side === 'buy') {
          // exact measures first: the ape's own SOL out (swap path) or the
          // watched wallet's balance delta in this tx (curve path)
          if (ev.solMoved && ev.solMoved > 0) spentExact = ev.solMoved;
          else if (watchedSolOut > 0) spentExact = watchedSolOut;
          if (spentExact !== null) {
            spend = spentExact;
          } else if (ev.tokenDeltaRaw !== null) {
            // paid with a stablecoin / no SOL delta: fall back to curve pricing
            const ck = `${ev.mint}:${ev.tokenDeltaRaw}`;
            if (!spendEstCache.has(ck)) spendEstCache.set(ck, await this.estimateSpend(ev.mint, ev.tokenDeltaRaw));
            spend = spendEstCache.get(ck) ?? null;
          }
        }

        if (ev.side === 'buy' && settings.alerts.activity) {
          const mm = metaByMint.get(ev.mint);
          const spentTxt = solExact(spend);
          await notifyUser(
            sub.userId,
            `👁 <b>RADAR</b> — ${esc(sub.watch.label)} bought ${coinTag(mm?.name, mm?.symbol, ev.mint)}${spentTxt ? ` — spent ${spentTxt}` : ''} — mirroring now`,
            { silent: true },
          );
        }

        const metaEv = metaByMint.get(ev.mint);
        // did the ape dump everything, or take profit and keep a moonbag?
        const apeBal = ev.side === 'sell' ? balByOwner.get(address)?.get(ev.mint) : undefined;
        const apeSoldFraction = apeBal
          ? soldFractionOf(apeBal.pre.toString(), apeBal.post.toString())
          : null;
        const signal: WatchSignal = {
          userId: sub.userId,
          watchId: sub.watch.id,
          watchedAddress: address,
          watchedLabel: sub.watch.label,
          side: ev.side,
          mint: ev.mint,
          mintName: metaEv?.name ?? null,
          mintSymbol: metaEv?.symbol ?? null,
          spendLamports: spend,
          spentSolLamports: spentExact,
          tokenAmountRaw: ev.tokenDeltaRaw !== null ? ev.tokenDeltaRaw.toString() : null,
          apeSoldFraction,
          sig: signature,
          route: `pump:${ev.name}`,
        };
        // fire & forget: the trader has its own per-user serialization
        void trader.onWatchSignal(signal);
      }
    }
    // persist "last buy seen" stamps (store write is debounced — cheap)
    if (dirtyDocs.size) {
      for (const d of dirtyDocs) {
        try { await this.store.saveUser(d); } catch { /* best effort */ }
      }
    }
  }

  /** best-effort SOL spend estimate for a token-amount buy (pct mode / radar) */
  private async estimateSpend(mintStr: string, tokenAmount: bigint): Promise<number | null> {
    try {
      const mint = new PublicKey(mintStr);
      const conn = this.conn;
      const st = await fetchCurve(conn, mint);
      if (!st || !isLiveCurve(st)) return null;
      const phase = await curvePhase(conn, mint);
      if (phase !== 'curve') return null;
      const cx = await loadPricingCtx(st.curve);
      const v = solLamportsForTokenAmount(cx, new BN(tokenAmount.toString()));
      return Number(v.toString());
    } catch {
      return null;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export const watcher = new Watcher();
