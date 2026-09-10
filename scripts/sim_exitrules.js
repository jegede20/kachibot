/**
 * Simulates the new exit-rule engine against a stubbed store/wallet.
 * Proves: which branch fires for each rule, and that target exits (X / mcap)
 * trigger from the checker without touching the chain or the real DB.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'sim-only-key-abcdef';
const path = require('path');
const D = (p) => require(path.join(__dirname, '..', 'dist', p));

const notify = D('notify');
const notices = [];
notify.notifyUser = async (_uid, text) => { notices.push(text); return true; };

const price = D('chain/price');
price.getSolUsd = async () => 200; // $200 SOL for the mcap math

const { defaultSettings } = D('types');
const { trader } = D('trader');

const calls = [];
const openRow = () => ({
  id: 't1', userId: 1, watchId: 'w1', watchedAddress: 'A', watchedLabel: 'ape #1',
  mint: 'MINT', symbol: 'SIM', name: 'Sim Coin', tokenProgram: 'spl',
  entryTime: Date.now(), exitTime: null,
  spentLamports: 100_000_000, entryTokenAmount: '1000', entryPriceLamports: 100_000,
  entryMcapLamports: 30_000_000_000, walletBalanceBefore: null,
  settingsAtEntry: { tpMultiples: [2, 3], stopLossPct: 0.5, copySell: true, slippagePct: 0.25, maxFeeLamports: 1_000_000, exit: null },
  partialSells: [], status: 'open', exitReason: null, realizedQuoteLamports: null,
  exitPriceLamports: null, walletBalanceAfter: null, pnlLamports: null, pnlPct: null,
  netMultiple: null, holdMs: null, error: null, txSignatures: [],
});

function docFor(exit, copySell = true) {
  const s = defaultSettings();
  s.copySell = copySell;
  s.alerts.activity = true;
  return {
    userId: 1, settings: s, secret: null, wallets: [], activeWalletId: null, pinHash: null,
    watched: [{ id: 'w1', address: 'A', label: 'ape #1', source: 'address', addedAt: Date.now(), paused: false, exit }],
    createdAt: Date.now(), lastSeenAt: Date.now(), welcomed: true, daySpend: null,
  };
}

const ev = { userId: 1, watchId: 'w1', watchedAddress: 'A', watchedLabel: 'ape #1', side: 'sell',
  mint: 'MINT', mintName: 'Sim Coin', mintSymbol: 'SIM', spendLamports: 100_000_000,
  spentSolLamports: 100_000_000, tokenAmountRaw: '1000', sig: 'x', route: 'pump:Sell' };

(async () => {
  console.log('=== A. watched wallet SELLS → what does KACHIBOT do? ===');
  const cases = [
    ['follow (sell all)', { mode: 'follow', pct: 1, mult: null, mcapUsd: null }],
    ['pct 50%', { mode: 'pct', pct: 0.5, mult: null, mcapUsd: null }],
    ['pct 25%', { mode: 'pct', pct: 0.25, mult: null, mcapUsd: null }],
    ['hold', { mode: 'hold', pct: 1, mult: null, mcapUsd: null }],
    ['mult 3x', { mode: 'mult', pct: 1, mult: 3, mcapUsd: null }],
    ['mcap $100k', { mode: 'mcap', pct: 1, mult: null, mcapUsd: 100_000 }],
  ];
  for (const [name, cfg] of cases) {
    calls.length = 0; notices.length = 0;
    trader.store = { listTrades: async () => [openRow()], getUser: async () => docFor(cfg), putTrade: async () => {} };
    trader.sellOpenPosition = async (u, id, reason) => { calls.push(`SELL_ALL(${reason})`); return null; };
    trader.sellFraction = async (u, id, frac, reason) => { calls.push(`SELL_${Math.round(frac * 100)}%(${reason})`); return null; };
    await trader.handleWatchedSell(docFor(cfg), ev);
    console.log(`  ${name.padEnd(16)} → ${calls.length ? calls.join(', ') : 'no sell (holds)'}  ${notices.length ? '| msg: ' + notices[0].replace(/<[^>]+>/g, '').slice(0, 78) : ''}`);
  }

  console.log('\n=== B. checker at 3x → which target fires? ===');
  const checkerCases = [
    ['exit = follow (ladder)', { mode: 'follow', pct: 1, mult: null, mcapUsd: null }, null],
    ['exit = mult 3x', { mode: 'mult', pct: 1, mult: 3, mcapUsd: null }, null],
    ['exit = mult 10x (not yet)', { mode: 'mult', pct: 1, mult: 10, mcapUsd: null }, null],
    ['exit = mcap $10k (hit)', { mode: 'mcap', pct: 1, mult: null, mcapUsd: 10_000 }, null],
    ['exit = mcap $500k (not yet)', { mode: 'mcap', pct: 1, mult: null, mcapUsd: 500_000 }, null],
  ];
  for (const [name, cfg, _] of checkerCases) {
    calls.length = 0;
    const row = openRow();
    row.settingsAtEntry.exit = cfg;
    trader.sellOpenPosition = async (u, id, reason, mult) => { calls.push(`SELL_ALL(${reason}${mult ? ' @' + mult + 'x' : ''})`); return null; };
    trader.sellTpStepLocked = async (u, r, target) => { calls.push(`LADDER_STEP(${target}x)`); };
    trader.liveValueLamports = async () => 300_000_000; // 3x
    await trader.checkThresholds(1, row).catch((e) => console.log('  ERR', e.message));
    console.log(`  ${name.padEnd(26)} → ${calls.length ? calls.join(', ') : 'no exit (waiting)'}`);
  }
  console.log('\nAll simulations ran against stubs — no chain calls, no real trades.');
})();
