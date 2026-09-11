/** End-to-end check of the migrated Jupiter v1 route + the PumpSwap fallback. */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { getConnection } = require('../dist/chain/conn');
const { buildJupiterBuy, buildJupiterSell, quote } = require('../dist/chain/jupiter');
const { findPumpSwapPool } = require('../dist/chain/pumpswap');
const { OnlinePumpAmmSdk } = require('@pump-fun/pump-swap-sdk');
const { decryptSecret, keypairFromSecret } = require('../dist/crypto');
const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');
const { PublicKey } = require('@solana/web3.js');

const MINT = new PublicKey('J2EpCXn3Pt5UsyQ1DnJyCervJtYhskmcptU9ZNa9pump');

(async () => {
  const conn = getConnection();
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, { auth:{persistSession:false}, realtime:{transport:ws} });
  const { data } = await sb.from('kachi_users').select('doc').eq('user_id', '5777500448').maybeSingle();
  const kp = keypairFromSecret(decryptSecret(data.doc.wallets[0].secret));
  const wallet = { publicKey: kp.publicKey, secretKey: kp.secretKey };

  console.log('1) raw quote (0.005 SOL -> PACT)');
  const q = await quote(new PublicKey('So11111111111111111111111111111111111111112'), MINT, 5_000_000n, 2500);
  console.log('   quote:', q ? `out=${q.outAmount} route=${q.routePlan?.[0]?.swapInfo?.label} impact=${q.priceImpactPct}` : 'NULL (route unavailable)');

  console.log('2) buildJupiterBuy (production path)');
  try {
    const j = await buildJupiterBuy(conn, { mint: MINT, buyer: wallet.publicKey, budgetLamports: 5_000_000, slippagePct: 0.25 });
    console.log('   built: tokens ~', j.plan.tokenAmountRaw.toString(), '| route', j.plan.routeLabel, '| impact', j.plan.priceImpactPct.toFixed(3)+'%');
    // simulate (unsigned, signature check off)
    const sim = await conn.simulateTransaction(j.tx, { sigVerify: false });
    console.log('   simulate:', sim.value.err ? 'ERR ' + JSON.stringify(sim.value.err) : 'OK');
  } catch (e) {
    console.log('   buildJupiterBuy FAILED:', e.message);
  }

  console.log('3) buildJupiterSell (round trip)');
  try {
    const s = await buildJupiterSell(conn, { mint: MINT, seller: wallet.publicKey, tokenAmountRaw: 15_000_000_000n, slippagePct: 0.25 });
    console.log('   built: SOL out ~', s ? (Number(s.plan.solLamports)/1e9).toFixed(6) : 'null');
  } catch (e) { console.log('   sell FAILED:', e.message); }

  console.log('4) fallback valuation path (swapSolanaState with a placeholder user)');
  const pool = await findPumpSwapPool(conn, MINT);
  const st = await new OnlinePumpAmmSdk(conn).swapSolanaState(pool, MINT);
  const px = Number(st.poolQuoteAmount.toString()) / Number(st.poolBaseAmount.toString());
  console.log('   pool', pool.toBase58().slice(0,8)+'…', '| price/token', px.toExponential(3), '| value of 15B tokens ≈', (px*15e9/1e9).toFixed(5), 'SOL');
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
