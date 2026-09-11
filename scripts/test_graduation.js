/**
 * Exercises the REAL production planner (Trader.planGraduatedBuy) across the
 * graduation window. Run with a scenario name:
 *   node scripts/test_graduation.js live|dead|ghost
 * (JUPITER_API_URL is read at startup, so the "dead" run must be a fresh process.)
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { PublicKey, Keypair } = require('@solana/web3.js');
const { Trader } = require('../dist/trader');
const { getConnection } = require('../dist/chain/conn');
const planGraduatedBuy = Trader.prototype.planGraduatedBuy;

const PACT = new PublicKey('J2EpCXn3Pt5UsyQ1DnJyCervJtYhskmcptU9ZNa9pump'); // graduated, has a PumpSwap pool
const scenario = process.argv[2] || 'live';
console.log('  jupiter endpoint:', process.env.JUPITER_API_URL || 'https://lite-api.jup.ag/swap/v1 (default)');

(async () => {
  const conn = getConnection();
  const buyer = Keypair.generate().publicKey;
  const mint = scenario === 'ghost' ? Keypair.generate().publicKey : PACT;
  const t0 = Date.now();
  try {
    const leg = await planGraduatedBuy.call({}, conn, { mint, buyer, budgetLamports: 5_000_000, slippagePct: 0.25 });
    const detail = leg.kind === 'pumpswap'
      ? `pool ${leg.plan.pool.slice(0, 8)}… ~${leg.plan.tokenAmountRaw.toString()} tokens`
      : `route ${leg.plan.routeLabel}`;
    console.log(`  RESULT: ${leg.kind} (${detail}) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } catch (e) {
    console.log(`  RESULT: FAILED after ${((Date.now() - t0) / 1000).toFixed(1)}s: ${e.message}`);
  }
})();
