/** Reads REAL sells by a watched wallet and reports the fraction-of-bag each moved. */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { getConnection } = require('../dist/chain/conn');
const { soldFractionOf } = require('../dist/types');
const { PublicKey } = require('@solana/web3.js');

const APE = process.argv[2] || 'FH5HjZ'; // prefix; resolved below
(async () => {
  const conn = getConnection();
  const { resolveWatchedAddress } = require('../dist/chain/txview');
  const addr = APE.length >= 32 ? APE : (resolveWatchedAddress ? APE : APE);
  const key = new PublicKey(addr);
  const sigs = await conn.getSignaturesForAddress(key, { limit: 24 });
  console.log(`wallet ${addr.slice(0, 8)}… — scanning ${sigs.length} recent txs for sells\n`);
  let found = 0;
  for (const { signature } of sigs) {
    if (found >= 4) break;
    const tx = await conn.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' }).catch(() => null);
    if (!tx?.meta) continue;
    const pre = tx.meta.preTokenBalances || [];
    const post = tx.meta.postTokenBalances || [];
    for (const b of post) {
      if (b.owner !== addr) continue;
      if (b.mint === 'So11111111111111111111111111111111111111112') continue;
      const p = pre.find((x) => x.accountIndex === b.accountIndex);
      const preAmt = BigInt(p?.uiTokenAmount?.amount ?? '0');
      const postAmt = BigInt(b.uiTokenAmount?.amount ?? '0');
      if (preAmt <= 0n || postAmt >= preAmt) continue; // not a sell
      const frac = soldFractionOf(preAmt.toString(), postAmt.toString());
      console.log(`  SELL ${signature.slice(0, 10)}… mint ${b.mint.slice(0, 6)}…`);
      console.log(`     bag before ${preAmt.toString()} -> after ${postAmt.toString()}  =>  sold ${(frac * 100).toFixed(1)}% of their bag`);
      found++;
      break;
    }
  }
  if (!found) console.log('  (no partial/full sells in the last 24 txs)');
})();
