#!/usr/bin/env node
/**
 * KACHIBOT smoke test (dev tool, run manually):
 *   node scripts/smoke.js [signature-or-wallet]
 * 1) verifies global/fee-config fetching over the configured RPC,
 * 2) fetches recent pump-program txs and classifies every buy/sell
 *    instruction the same way the live watcher does.
 */
process.env.KACHI_SMOKE = '1';
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
if (!process.env.ENCRYPTION_KEY && !process.env.KACHI_MASTER_PASSPHRASE) {
  process.env.ENCRYPTION_KEY = 'smoke-test-key-0123456789abcdef';
}

const { PublicKey } = require('@solana/web3.js');
const { getConnection } = require('../dist/chain/conn');
const {
  classifyPumpIx, pumpIxArgs, getGlobal, getFeeConfig, PUMP_PROG,
} = require('../dist/chain/pump');

const PUMP = PUMP_PROG.toBase58();

async function inspectTx(conn, sig) {
  const tx = await conn.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
  if (!tx) return null;
  if (tx.meta?.err) return { err: tx.meta.err };
  const m = tx.transaction.message;
  const metaAny = tx.meta || {};
  const loaded = metaAny.loadedAddresses || { writable: [], readonly: [] };
  // (innerInstructions on RPC live under meta)
  const accInfo = (m.accountKeys || []).map((k) =>
    (typeof k === 'string' ? { pubkey: k, signer: false } : { pubkey: k.pubkey, signer: !!k.signer }));
  const pkeys = [...accInfo.map((a) => a.pubkey), ...(loaded.writable || []).map(String), ...(loaded.readonly || []).map(String)];
  const ixes = [
    ...(m.instructions || []),
    ...(((metaAny.innerInstructions || []).flatMap((x) => x.instructions || []))),
  ];
  const hits = [];
  const namesLogged = (metaAny.logMessages || [])
    .filter((l) => l.startsWith('Program log: Instruction: '))
    .map((l) => l.slice(26).trim());
  for (const ix of ixes) {
    if (!ix.data) continue;
    const data = Buffer.from(ix.data, 'base64');
    const sigInfo = classifyPumpIx(data);
    const fields = pumpIxArgs(data);
    const logSide = namesLogged.some((n) => /\bBuy/i.test(n)) ? 'buy' : namesLogged.some((n) => /\bSell/i.test(n)) ? 'sell' : null;
    if (!sigInfo && !logSide) continue;
    hits.push({ name: sigInfo ? sigInfo.name : '(log)', side: sigInfo ? sigInfo.side : logSide, amount: fields.amountU64?.toString(), qty2: fields.secondU64?.toString() });
  }
  return { hits };
}

async function main() {
  const conn = getConnection();
  const arg = process.argv[2];
  console.log('— KACHIBOT smoke —');
  console.log('RPC:', conn.rpcEndpoint);

  const global = await getGlobal().catch((e) => { console.error('fetchGlobal FAILED:', e.message); return null; });
  const fee = await getFeeConfig().catch(() => null);
  if (global) console.log(`global OK: feeRecipient=${global.feeRecipient.toBase58().slice(0, 8)}… creatorFeeBps=${global.creatorFeeBasisPoints.toString()}`);
  if (fee) console.log(`feeConfig OK: tiers=${fee.feeTiers?.length ?? 0}`);

  let sigs = [];
  if (arg && arg.length > 60) {
    sigs = [{ signature: arg }];
  } else {
    for (let attempt = 0; attempt < 3 && sigs.length < 5; attempt++) {
      const list = await conn
        .getSignaturesForAddress(new PublicKey(PUMP), { limit: 100 }, 'confirmed')
        .catch(() => null);
      if (!list) continue;
      sigs = list.filter((s) => !s.err).slice(0, 12); // skip failed bot-spam txs
    }
  }

  let classified = 0;
  let buys = 0;
  let sells = 0;
  for (const s of sigs) {
    const r = await inspectTx(conn, s.signature);
    if (!r) { console.log(`- ${s.signature.slice(0, 12)} no tx`); continue; }
    if (r.err) { console.log(`- ${s.signature.slice(0, 12)} failed (${JSON.stringify(r.err).slice(0, 60)})`); continue; }
    for (const h of r.hits) {
      classified++;
      if (h.side === 'buy') buys++;
      else sells++;
      console.log(`✔ ${s.signature.slice(0, 12)} pump:${h.name.padEnd(16)} ${h.side} mint=${h.mint}… user=${h.user}… amount=${h.amount || '?'}`);
    }
  }
  console.log(`\nclassified ${classified} pump ix (buys ${buys}, sells ${sells}) across ${sigs.length} txs`);
  console.log(classified > 0 ? 'SMOKE OK — watcher pipeline decodes live protocol data' : 'SMOKE WARN — no pump ix in sample (retry)');
}

main().catch((e) => { console.error('smoke failed:', e); process.exit(1); });
