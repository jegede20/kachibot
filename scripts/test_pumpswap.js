/** Build + SIMULATE a PumpSwap buy for the coin that failed with "no route". */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { getConnection } = require('../dist/chain/conn');
const { findPumpSwapPool, buildPumpSwapBuy, buildPumpSwapSell } = require('../dist/chain/pumpswap');
const { simulate } = require('../dist/chain/send');
const { decryptSecret, keypairFromSecret } = require('../dist/crypto');
const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');
const { PublicKey } = require('@solana/web3.js');

(async () => {
  const MINT = new PublicKey('J2EpCXn3Pt5UsyQ1DnJyCervJtYhskmcptU9ZNa9pump'); // the failed copy
  const conn = getConnection();
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, { auth:{persistSession:false}, realtime:{transport:ws} });
  const { data } = await sb.from('kachi_users').select('doc').eq('user_id', '5777500448').maybeSingle();
  const kp = keypairFromSecret(decryptSecret(data.doc.wallets[0].secret));
  const bal = await conn.getBalance(kp.publicKey);
  console.log('user wallet:', kp.publicKey.toBase58().slice(0,8)+'…', '| balance', (bal/1e9).toFixed(4), 'SOL');

  console.log('\n1) find pool…');
  const pool = await findPumpSwapPool(conn, MINT);
  console.log('   pool:', pool ? pool.toBase58() : 'NONE');
  if (!pool) { console.log('   !! no PumpSwap pool — route cannot help this coin'); return; }

  console.log('\n2) build buy (0.005 SOL, 25% slippage)…');
  const plan = await buildPumpSwapBuy(conn, { mint: MINT, buyer: kp.publicKey, budgetLamports: 5_000_000, slippagePct: 0.25 });
  console.log('   instructions:', plan.ixs.length, '| est tokens out:', plan.tokenAmountRaw.toString());

  console.log('\n3) SIMULATE (no funds move)…');
  const sim = await simulate(conn, { publicKey: kp.publicKey, secretKey: kp.secretKey }, plan.ixs);
  console.log('   simulation ok:', sim.ok, sim.ok ? '' : '| error: ' + String(sim.err).slice(0, 200));

  console.log('\n4) build sell of the estimated amount (round-trip check)…');
  try {
    const sell = await buildPumpSwapSell(conn, { mint: MINT, seller: kp.publicKey, tokenAmountRaw: plan.tokenAmountRaw, slippagePct: 0.25 });
    console.log('   sell ixs:', sell.ixs.length, '| est SOL out:', (Number(sell.solLamports)/1e9).toFixed(6));
  } catch (e) {
    console.log('   sell build failed:', e.message);
  }
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
