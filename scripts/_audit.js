/**
 * One-shot audit: per-user watches vs. what the bot actually copied, plus a
 * health sweep. Read-only — it never trades.
 *   node scripts/_audit.js [hoursLookback]
 */
const fs = require('fs');
for (const line of fs.readFileSync('.env', 'utf8').split('\n')) {
  const m = /^([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
}

const { getStore } = require('../dist/db');
const { getConnection } = require('../dist/chain/conn');
const { PublicKey } = require('@solana/web3.js');
const { decodeMessageView, detectSwapSignals } = require('../dist/chain/txview');
const { decryptSecret, keypairFromSecret } = require('../dist/crypto');

const HOURS = Number(process.argv[2] || 48);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** classify one tx for a watched address -> list of { side, mint, solLamports, ts } */
function classifySwaps(tx, address) {
  const view = decodeMessageView(tx);
  if (!view) return [];
  return detectSwapSignals(view, tx.meta, address).map((s) => ({
    side: s.side,
    mint: s.mint,
    solLamports: s.solMovedLamports || 0,
    ts: tx.blockTime ? tx.blockTime * 1000 : null,
    via: 'dex',
  }));
}

/** pump-program instructions (logs + token deltas) */
function classify(tx, address) {
  if (!tx || !tx.meta) return null;
  if (tx.meta.err) return null;
  const logs = tx.meta.logMessages || [];
  const isBuy = logs.some((l) => /^Program log: Instruction: .*\bBuy\b/i.test(l));
  const isSell = logs.some((l) => /^Program log: Instruction: .*\bSell\b/i.test(l));
  if (!isBuy && !isSell) return null;
  const preTok = tx.meta.preTokenBalances || [];
  const postTok = tx.meta.postTokenBalances || [];
  const delta = new Map();
  for (const p of preTok) if (p.owner === address) delta.set(p.mint, -(BigInt(p.uiTokenAmount?.amount || '0')));
  for (const p of postTok) if (p.owner === address) delta.set(p.mint, (delta.get(p.mint) || 0n) + BigInt(p.uiTokenAmount?.amount || '0'));
  let mint = null, best = 0n;
  for (const [m, d] of delta) if (d !== 0n && (best === 0n || (d < 0n ? -d : d) > (best < 0n ? -best : best))) { mint = m; best = d; }
  const view = decodeMessageView(tx);
  const idx = view ? view.pkeys.indexOf(address) : -1;
  const solLamports = idx >= 0
    ? (tx.meta.preBalances?.[idx] ?? 0) - (tx.meta.postBalances?.[idx] ?? 0)
    : 0;
  return { side: isBuy ? 'buy' : 'sell', mint, solLamports, ts: tx.blockTime ? tx.blockTime * 1000 : null };
}

(async () => {
  const store = getStore();
  const conn = getConnection();
  const users = await store.listUsers();
  const cutoff = Date.now() - HOURS * 3600e3;

  for (const doc of users) {
    const s = doc.settings || {};
    const wallets = Array.isArray(doc.wallets) ? doc.wallets : [];
    const active = wallets.find((w) => w.active !== false) || wallets[0] || null;
    console.log(`\n${'='.repeat(78)}\nUSER ${doc.userId}   copySell=${s.copySell}/${s.copySellMode}  exit=${JSON.stringify(s.exit)}`);
    const sol = (l) => (l === undefined || l === null ? '—' : (l / 1e9).toFixed(4) + ' SOL');
    console.log(`  buy          : mode=${s.buyMode} amount=${sol(s.buyAmountLamports)} pct=${s.buyPctOfSpend} slippage=${(s.slippagePct * 100).toFixed(2)}% feeCap=${sol(s.maxFeeLamports)}`);
    console.log(`  filters      : ape spend ${sol(s.minSpendLamports)}..${sol(s.maxSpendLamports)}  perTradeCap=${sol(s.perTradeCapLamports)}  dailyCap=${sol(s.dailyCapLamports)}  cooldown=${s.watcherCooldownMs}ms`);
    console.log(`  exits        : TP ${JSON.stringify(s.tpMultiples)} SL ${(s.stopLossPct * 100).toFixed(0)}% breakEven=${s.breakEvenStop} maxHold=${s.maxHoldMs ? (s.maxHoldMs / 3600000).toFixed(1) + 'h' : 'never'} trailing=${JSON.stringify(s.trailing)}`);
    console.log(`  spent today  : ${doc.daySpend ? (doc.daySpend.lamports / 1e9).toFixed(4) + ' SOL (' + doc.daySpend.day + ')' : 'none'}`);
    console.log(`  guards       : honeypot=${s.honeypotCheck} reputation=${JSON.stringify(s.reputation || null)}`);
    let kp = null;
    try { kp = doc.secret ? keypairFromSecret(decryptSecret(doc.secret)) : null; } catch (e) { kp = null; }
    if (kp) {
      const bal = await conn.getBalance(kp.publicKey, 'confirmed').catch(() => null);
      console.log(`  wallet       : ${kp.publicKey.toBase58().slice(0, 8)}…  balance ${bal === null ? 'ERR' : (bal / 1e9).toFixed(4)} SOL  (vault entries: ${wallets.length})`);
      const need = (s.buyAmountLamports || 0) + (s.maxFeeLamports || 0) + 2_000_000;
      if (bal !== null && bal < need) console.log(`  ⚠️  LOW       : a copy needs ≈${(need / 1e9).toFixed(4)} SOL — buys will be BLOCKED until topped up`);
    } else {
      console.log('  wallet       : NONE — the bot cannot copy anything until a vault wallet exists');
    }

    const trades = await store.listTrades(doc.userId);
    const byStatus = trades.reduce((a, t) => { a[t.status] = (a[t.status] || 0) + 1; return a; }, {});
    console.log(`  trades       : ${JSON.stringify(byStatus)}`);

    for (const w of (doc.watched || [])) {
      const added = w.addedAt || 0;
      console.log(`\n  ── watch "${w.label || 'unnamed'}" ${(w.address || '').slice(0, 6)}…  ${w.paused ? 'PAUSED' : 'ACTIVE'}  added ${new Date(added).toISOString()}`);
      console.log(`     lastBuySeen ${w.lastBuySeenAt ? new Date(w.lastBuySeenAt).toISOString() : 'never'}  exit=${JSON.stringify(w.exit || null)} buySize=${JSON.stringify(w.buySize || null)} confirmHold=${w.confirmHoldMs ?? 0}ms`);

      const sigs = await conn.getSignaturesForAddress(new PublicKey(w.address), { limit: 16 }, 'confirmed').catch(() => []);
      const rows = [];
      for (const sg of sigs) {
        if (sg.blockTime && sg.blockTime * 1000 < cutoff) continue;
        const tx = await conn.getTransaction(sg.signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' }).catch(() => null);
        const ev = classify(tx, w.address);
        if (ev) rows.push({ ...ev, sig: sg.signature, via: (ev.via || 'pump') });
        for (const sw of classifySwaps(tx, w.address)) {
          if (!rows.some((r) => r.side === sw.side && r.mint === sw.mint)) rows.push({ ...sw, sig: sg.signature });
        }
        await sleep(120);
      }
      if (!rows.length) { console.log(`     no pump buys/sells by this wallet in the last ${HOURS}h`); continue; }
      for (const r of rows.sort((a, b) => (a.ts || 0) - (b.ts || 0))) {
        const copied = trades.find((t) => t.mint === r.mint && t.entryTime >= (r.ts || 0) - 120_000);
        const afterAdd = (r.ts || 0) >= added;
        const stale = (r.ts || 0) < Date.now() - 150_000;
        let verdict = '';
        if (r.side === 'sell') verdict = '(sell — copy-sell territory)';
        else if (!afterAdd) verdict = '→ before this watch existed';
        else if (copied) verdict = `→ COPIED (${copied.status}${copied.status === 'failed' ? ': ' + String(copied.error || '').slice(0, 60) : ''})`;
        else if (stale) verdict = '→ older than 150s (bot correctly skips stale trades)';
        else verdict = '→ ⚠️ NOT COPIED';
        const sym = trades.find((t) => t.mint === r.mint)?.symbol;
        console.log(`     ${new Date(r.ts).toISOString().slice(5, 19)} ${r.side.toUpperCase().padEnd(4)} ${(r.solLamports / 1e9).toFixed(4)} SOL  mint=${(r.mint || '?').slice(0, 6)}… ${sym ? '($' + sym + ')' : ''} [${r.via}] ${verdict}`);
      }
    }
  }
  console.log(`\n${'='.repeat(78)}`);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
