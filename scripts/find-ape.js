#!/usr/bin/env node
/** find-ape v3: gentle live scan — poll newest pump txs in small batches,
 *  watch for a wallet that buys at least TWICE with meaningful spend. */
process.env.KACHI_SMOKE = '1';
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = 'findape-0000';
const { getConnection } = require('../dist/chain/conn');
const { PUMP_PROG } = require('../dist/chain/pump');
const { decodeMessageView, MONEY_MINTS, WSOL_MINT } = require('../dist/chain/txview');
const { PublicKey } = require('@solana/web3.js');

const EXCLUDE = new Set([
  'CcJX975YTw8owyuRwyC1m9pyC3ZhRp89VM12pfUfDBcf',
  'BJv6rCw7siVkbCnWaSSow5nD8QFkpt9is5USkF13XGu4',
  'FH5HjZvWREJC8C4aAL348UQp48fh2CZxDncLCpEwnuo2',
]);
const MIN_SPEND = 0.01 * 1e9;
const MIN_BAL = 0.5 * 1e9; // ape must hold real SOL, not dust
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const conn = getConnection();
  const seen = new Set();
  const buyers = new Map(); // addr -> {buys, spent, lastAt}
  const started = Date.now();
  let polls = 0;

  console.log('[scan] live-watching pump.fun buys — need a wallet seen buying twice…');
  while (Date.now() - started < 280_000) { // ~4.6 min budget
    polls++;
    let batch;
    try { batch = await conn.getSignaturesForAddress(PUMP_PROG, { limit: 15 }, 'confirmed'); }
    catch { await sleep(2000); continue; }
    const fresh = (batch || []).filter(s => !s.err && s.blockTime && !seen.has(s.signature) && Date.now() / 1000 - s.blockTime < 30);
    for (const s of fresh) seen.add(s.signature);
    for (const s of fresh.slice(0, 6)) {
      let tx = null;
      for (let i = 0; i < 3 && !tx; i++) {
        try { tx = await conn.getTransaction(s.signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }); }
        catch (e) { if (/429|Too Many/.test(String(e.message))) await sleep(1500); else break; }
      }
      if (!tx || !tx.meta || tx.meta.err) continue;
      const view = decodeMessageView(tx);
      if (!view) continue;
      const preT = (tx.meta.preTokenBalances || []).filter(b => b && b.owner);
      const postT = (tx.meta.postTokenBalances || []).filter(b => b && b.owner);
      for (const b of postT) {
        if (MONEY_MINTS.has(b.mint)) continue;
        const pre = preT.find(p => p.accountIndex === b.accountIndex);
        const cur = BigInt(b.uiTokenAmount?.amount || 0);
        const prv = pre ? BigInt(pre.uiTokenAmount?.amount || 0) : 0n;
        if (cur - prv <= 0n) continue;
        const owner = b.owner;
        if (EXCLUDE.has(owner) || owner === WSOL_MINT) continue;
        const wi = view.pkeys.indexOf(owner);
        if (wi < 0) continue;
        const spent = (tx.meta.preBalances?.[wi] ?? 0) - (tx.meta.postBalances?.[wi] ?? 0);
        if (spent < MIN_SPEND) continue;
        const m = buyers.get(owner) || { buys: 0, spent: 0, lastAt: 0, firstAt: 0, minSpent: Infinity, maxSpent: 0 };
        m.buys++;
        m.spent += spent;
        m.lastAt = Math.max(m.lastAt, (s.blockTime || 0) * 1000);
        m.firstAt = m.firstAt || (s.blockTime || 0) * 1000;
        m.minSpent = Math.min(m.minSpent, spent);
        m.maxSpent = Math.max(m.maxSpent, spent);
        buyers.set(owner, m);
      }
      await sleep(600);
    }
    // report a QUALIFIED buyer: repeat buys spread >= 60s apart, still active,
    // and holding real SOL (checked on-chain, excludes dust scalpers)
    const now = Date.now();
    const hits = [];
    for (const [addr, m] of [...buyers.entries()]) {
      if (m.buys < 3 || now - m.lastAt > 150_000 || m.lastAt - m.firstAt < 60_000) continue;
      let bal = 0;
      try { bal = await conn.getBalance(new PublicKey(addr)); } catch { /* skip */ }
      if (bal < MIN_BAL) continue;
      hits.push([addr, m, bal]);
    }
    if (hits.length) {
      console.log(`\n[FOUND] repeat buyer${hits.length > 1 ? 's' : ''} after ${Math.round((now - started) / 1000)}s:\n`);
      hits.sort((a, b) => b[1].spent - a[1].spent).forEach(([addr, m, bal], i) => {
        console.log(`${i + 1}. ${addr}`);
        console.log(`    buys: ${m.buys} | spent ~${(m.spent / 1e9).toFixed(3)} SOL (${(m.minSpent / 1e9).toFixed(3)}–${(m.maxSpent / 1e9).toFixed(3)} each) | last ${Math.round((now - m.lastAt) / 1000)}s ago | wallet SOL: ${(bal / 1e9).toFixed(2)}`);
      });
      process.exit(0);
    }
    await sleep(4000);
  }
  console.log('\n[timeout] no repeat buyer in window. Top single-buy wallets seen:');
  [...buyers.entries()].sort((a, b) => b[1].spent - a[1].spent).slice(0, 3)
    .forEach(([addr, m]) => console.log(`  ${addr} — 1 buy ~${(m.spent / 1e9).toFixed(3)} SOL ${Math.round((Date.now() - m.lastAt) / 1000)}s ago`));
})();
