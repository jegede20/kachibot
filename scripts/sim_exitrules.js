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

  console.log('\n=== E. reputation filter (no entry delay) ===');
  const pumpMod = D('chain/pump');
  pumpMod.curvePhase = async () => 'curve';
  const connMod2 = D('chain/conn');
  connMod2.getConnection = () => ({ getBalance: async () => 1_000_000_000 });

  const { encryptSecret: enc2 } = D('crypto');
  const bs58b = require('bs58');
  const b58b = (buf) => (bs58b.encode ? bs58b.encode(buf) : bs58b.default.encode(buf));
  const { Keypair: KP2 } = require('@solana/web3.js');
  const key2 = KP2.generate();

  const mkTrade = (watchId, pnl) => ({
    ...openRow(), id: `x-${Math.random()}`, watchId, status: 'closed',
    pnlLamports: pnl, pnlPct: pnl / 1e8, exitReason: 'TP',
  });
  // a wallet with a 10% win rate over 10 closed copies
  const badRows = [mkTrade('w1', 1e8), ...Array(9).fill(0).map(() => mkTrade('w1', -1e8))];

  const APE2 = KP2.generate().publicKey.toBase58();
  const buyDoc = (rep) => {
    const st = defaultSettings();
    st.honeypotCheck = false;
    st.alerts.activity = true;
    st.reputation = rep;
    return {
      userId: 1, settings: st, secret: enc2(b58b(key2.secretKey)), wallets: [], activeWalletId: null,
      pinHash: null, watched: [{ id: 'w1', address: 'A', label: 'ape #1', source: 'address', addedAt: Date.now(), paused: false }],
      createdAt: Date.now(), lastSeenAt: Date.now(), welcomed: true, daySpend: null,
    };
  };
  const MINT2 = KP2.generate().publicKey.toBase58();
  const buyEv = { ...ev, side: 'buy', mint: MINT2, watchedAddress: APE2, tokenAmountRaw: '1000', spendLamports: 100_000_000, spentSolLamports: 100_000_000 };
  const buys = [];
  trader.executeBuy = async (doc, e, budget, route) => { buys.push(`BUY ${(budget / 1e9).toFixed(4)} SOL via ${route}`); return null; };

  const runBuy = async (rep) => {
    buys.length = 0; notices.length = 0;
    const doc = buyDoc(rep);
    trader.store = {
      listTrades: async () => badRows,
      getUser: async () => doc,
      putTrade: async () => {},
    };
    await trader.handleWatchedBuy(doc, buyEv);
    return buys.join(', ') || (notices.length ? 'SKIPPED: ' + notices[0].replace(/<[^>]+>/g, '').split('\n')[0] : 'no action');
  };

  console.log('  reputation OFF                        →', await runBuy({ enabled: false, minTrades: 10, minWinRate: 0.3, onFail: 'skip' }));
  console.log('  ON, ape 10% win / 10 copies, → skip   →', await runBuy({ enabled: true, minTrades: 10, minWinRate: 0.3, onFail: 'skip' }));
  console.log('  ON, same ape, → halve size           →', await runBuy({ enabled: true, minTrades: 10, minWinRate: 0.3, onFail: 'halve' }));
  console.log('  ON, floor lowered to 5%              →', await runBuy({ enabled: true, minTrades: 10, minWinRate: 0.05, onFail: 'skip' }));

  console.log('\n=== F. confirm-hold delay ===');
  const holdDoc = (ms) => {
    const d = buyDoc({ enabled: false, minTrades: 10, minWinRate: 0.3, onFail: 'skip' });
    d.watched[0].confirmHoldMs = ms;
    return d;
  };
  const runHold = async (ms, balanceFn) => {
    buys.length = 0; notices.length = 0;
    const doc = holdDoc(ms);
    trader.store = { listTrades: async () => [], getUser: async () => doc, putTrade: async () => {} };
    trader.tokenBalanceOf = balanceFn;
    trader.pendingConfirms = new Set();
    await trader.handleWatchedBuy(doc, buyEv);
    const immediate = buys.length ? 'copied instantly' : 'waiting…';
    await new Promise((r) => setTimeout(r, ms + 700));
    const after = buys.length ? buys.join(', ') : (notices.length ? notices[notices.length - 1].replace(/<[^>]+>/g, '').split('\n')[0] : 'nothing');
    return `${immediate} → ${after}`;
  };
  console.log('  off (0ms)                             →', await runHold(0, async () => 1000n));
  console.log('  150ms delay, ape still holds          →', await runHold(150, async () => 1000n));
  console.log('  150ms delay, ape dumped everything    →', await runHold(150, async () => 0n));
  console.log('  150ms delay, ape sold 30% (under 50%) →', await runHold(150, async () => 700n));
  console.log('  150ms delay, balance check fails      →', await runHold(150, async () => { throw new Error('rpc down'); }), '(fails open)');

  console.log('\nAll simulations ran against stubs — no chain calls, no real trades.');
})();

/* ---------------- part C: the new risk rules (added later) ---------------- */
