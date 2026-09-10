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
  console.log('\n=== C. trailing stop / break-even / max hold ===');
  const mkRow = (over = {}) => {
    const r = openRow();
    r.id = `T-sim-${Math.random().toString(36).slice(2, 8)}`; // unique: peaks are keyed by row id
    r.settingsAtEntry.tpMultiples = [];   // isolate the rule under test
    Object.assign(r, over);
    return r;
  };
  const runChecks = async (row, values) => {
    calls.length = 0;
    trader.sellOpenPosition = async (u, id, reason) => { calls.push(`SELL_ALL(${reason})`); return null; };
    trader.sellTpStepLocked = async (u, r, target) => { calls.push(`LADDER(${target}x)`); };
    for (const v of values) {
      trader.liveValueLamports = async () => v;
      await trader.checkThresholds(1, row).catch((e) => console.log('  ERR', e.message));
      if (calls.length) break;
    }
    return calls.join(', ') || 'no exit';
  };

  const trailCfg = { enabled: true, armAtMult: 3, trailPct: 0.25 };
  let row = mkRow();
  row.settingsAtEntry = { ...row.settingsAtEntry, trailing: trailCfg };
  console.log('  armed 3x/-25%, price 2.5x → 4x → 2.9x  →', await runChecks(row, [250e6, 400e6, 290e6]), '(4x peak, stop 3.0x)');

  row = mkRow();
  row.settingsAtEntry = { ...row.settingsAtEntry, trailing: trailCfg };
  console.log('  armed 3x/-25%, price 2.5x → 3.4x        →', await runChecks(row, [250e6, 340e6]), '(peak 3.4x, stop 2.55x)');

  row = mkRow();
  row.settingsAtEntry = { ...row.settingsAtEntry, trailing: { ...trailCfg, enabled: false } };
  console.log('  trailing OFF, price 1x → 5x → 0.5x      →', await runChecks(row, [100e6, 500e6, 50e6]), '(ladder/stop-loss own it)');

  // break-even: a TP rung already banked profit
  row = mkRow({ partialSells: [{ time: Date.now(), reason: 'TP', multiple: 2, tokenAmountRaw: '500', quoteLamports: 200e6, txSignature: null }] });
  row.settingsAtEntry = { ...row.settingsAtEntry, breakEvenStop: true };
  console.log('  break-even armed, remainder falls to 0.98x →', await runChecks(row, [49e6]), '(sold at break-even, not -50%)');

  row = mkRow();
  row.settingsAtEntry = { ...row.settingsAtEntry, breakEvenStop: true };
  console.log('  no TP rung yet, price falls to 0.60x      →', await runChecks(row, [60e6]), '(normal -50% stop still rules)');

  // max hold
  row = mkRow({ entryTime: Date.now() - 7 * 3600_000 });
  row.settingsAtEntry = { ...row.settingsAtEntry, maxHoldMs: 6 * 3600_000 };
  console.log('  max hold 6h, position is 7h old          →', await runChecks(row, [150e6]), '(time exit)');

  row = mkRow({ entryTime: Date.now() - 60_000 });
  row.settingsAtEntry = { ...row.settingsAtEntry, maxHoldMs: 6 * 3600_000 };
  console.log('  max hold 6h, position is 1m old          →', await runChecks(row, [150e6]), '(ladder still rules)');

  console.log('\n=== D. low-balance heads-up ===');
  const { encryptSecret } = D('crypto');
  const conn = D('chain/conn');
  conn.getConnection = () => ({ getBalance: async () => 8_000_000 }); // wallet: 0.008 SOL
  const bs58mod = require('bs58');
  const b58 = (buf) => (bs58mod.encode ? bs58mod.encode(buf) : bs58mod.default.encode(buf));
  const { Keypair } = require('@solana/web3.js');
  const real = Keypair.generate();
  const s = defaultSettings();
  s.lowBalanceWarnLamports = 20_000_000;
  s.buyAmountLamports = 5_000_000;
  const doc = { ...docFor(null), settings: s, secret: encryptSecret(b58(real.secretKey)) };

  notices.length = 0;
  trader.balanceCheckedAt = new Map();
  trader.balanceWarnedAt = new Map();
  await trader.checkLowBalance(doc);
  console.log('  balance 0.008 SOL, alert below 0.02      →', notices.length ? notices[0].replace(/<[^>]+>/g, '') : 'NO MESSAGE');
  notices.length = 0;
  await trader.checkLowBalance(doc);
  console.log('  same user again immediately              →', notices.length ? 'unexpected second message' : 'silent (throttled)');
  notices.length = 0;
  await trader.checkLowBalance({ ...doc, settings: { ...s, lowBalanceWarnLamports: 0 } });
  console.log('  user turned the alert off                →', notices.length ? 'unexpected message' : 'silent');
  notices.length = 0;
  await trader.checkLowBalance({ ...doc, watched: [] });
  console.log('  user with an empty watchlist             →', notices.length ? 'unexpected message' : 'silent');

  console.log('\nAll simulations ran against stubs — no chain calls, no real trades.');
})();

/* ---------------- part C: the new risk rules (added later) ---------------- */
