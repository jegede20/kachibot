const fs = require('fs');
for (const line of fs.readFileSync('.env','utf8').split('\n')) {
  const m = /^([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g,'');
}
(async () => {
  const { getStore } = require('../dist/db');
  const { trader } = require('../dist/trader');
  const { tradeScorecardModel } = require('../dist/card/model');
  const { renderScorecard } = require('../dist/card/scorecard');
  const { getSolUsd } = require('../dist/chain/price');
  const store = getStore();
  const uid = Number(process.argv[2] || 5777500448);
  const want = process.argv[3] || null;
  const rows = await store.listTrades(uid);
  const row = rows.find((t) => t.status !== 'failed' && (!want || t.symbol.toUpperCase() === want.toUpperCase()));
  if (!row) { console.log('no row'); return; }
  const solUsd = await getSolUsd().catch(() => null);
  const exitMcap = await trader.mcapAtExitLamports(row).catch((e) => { console.log('mcap err', e.message); return null; });
  const m = tradeScorecardModel({ trade: row, exitMcapLamports: exitMcap, solUsd });
  const png = await renderScorecard(m);
  fs.writeFileSync('kachibot-card-hawg-real.png', png);
  console.log('SOL/USD        :', solUsd);
  console.log('exit mcap      :', exitMcap, exitMcap ? `(${(exitMcap/1e9).toFixed(3)} SOL)` : '(none)');
  console.log(JSON.stringify(m, null, 1));
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
