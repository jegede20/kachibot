/**
 * KACHIBOT — entrypoint.
 * Boots config -> db -> chain -> trader checker -> watcher -> telegram bot,
 * then parks. Handles SIGINT/SIGTERM gracefully.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { PORT as PORT_NUM } from './config';
import { assertConfig, TELEGRAM_BOT_TOKEN } from './config';
import { getStore } from './db';
import { trader } from './trader';
import { watcher } from './watcher';
import { startBot } from './bot';
import { renderSampleCard, type SampleKind } from './card/sample';

async function main(): Promise<void> {
  assertConfig();
  const startedAt = Date.now();

  // 1) persistence
  getStore();

  // 2) recover from crashes: half-finished buys become failed rows
  await trader.sweepInterrupted();

  // 3) re-hydrate watchers for every user & wallet
  await watcher.syncAll();
  watcher.startBackstop(7000);

  // 4) TP / SL / rug sweeper
  trader.startChecker(5000);

  // 5) telegram UI
  const bot = startBot(TELEGRAM_BOT_TOKEN);

  // 6) keep-alive health endpoint: hosts like Render need an HTTP listener,
  //    and UptimeRobot pings it every 5 min so the free instance never sleeps.
  // user manual (plain markdown) served at /guide for humans on the web
  const guidePath = [path.join(process.cwd(), 'USER-GUIDE.md'), path.join(__dirname, '..', 'USER-GUIDE.md')]
    .find((p) => { try { return fs.existsSync(p); } catch { return false; } });
  const guide = guidePath ? fs.readFileSync(guidePath, 'utf8') : null;

  const health = http.createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];
    if (url === '/guide') {
      if (guide === null) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('guide file not found'); return; }
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(guide);
      return;
    }
    if (url === '/card') {
      const qs = new URL(req.url || '/', 'http://card').searchParams;
      const kind: SampleKind = qs.get('bear') ? 'bear' : qs.get('overall') ? 'overall' : 'bull';
      void renderSampleCard(kind)
        .then((png) => {
          res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
          res.end(png);
        })
        .catch((e: Error) => {
          res.writeHead(500, { 'content-type': 'text/plain' });
          res.end(`card render failed: ${e.message}`);
        });
      return;
    }
    if (url === '/status') {
      void watcher.debugState()
        .then((w) => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            ok: true,
            service: 'kachibot',
            uptimeSec: Math.round(process.uptime()),
            startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
            ts: Date.now(),
            watcher: w,
            trader: (() => {
              const c = trader.checkerState();
              return {
                checkerRunning: c.running,
                lastCheckAgeSec: c.lastTickAt ? Math.round((Date.now() - c.lastTickAt) / 1000) : null,
                lastCheckMs: c.lastPassMs,
              };
            })(),
          }));
        })
        .catch((e: Error) => {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        });
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'kachibot', ts: Date.now() }));
  });
  const PORT = PORT_NUM;
  health.listen(PORT, '0.0.0.0', () => console.log(`[main] health endpoint on :${PORT} (GET / = ok)`));
  health.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code === 'EADDRINUSE') console.warn(`[main] port ${PORT} busy — health endpoint skipped (harmless)`);
    else console.error('[main] health listener error:', e.message);
  });

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n[main] ${signal} — shutting down…`);
    await getStore().flush().catch(() => undefined); // persist pending user writes
    health.close(() => undefined);
    await bot.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  console.log(`[main] KACHIBOT up in ${((Date.now() - startedAt) / 1000).toFixed(1)}s — watching wallets, ready to mirror apes.`);

  // 24/7 resilience: never die silently. Supervisor (pm2/systemd) restarts on crash.
  process.on('unhandledRejection', (reason) => {
    console.error('[main] unhandledRejection:', reason instanceof Error ? reason.stack || reason.message : reason);
  });
  process.on('uncaughtException', (err) => {
    console.error('[main] uncaughtException:', err.stack || err.message);
    console.error('[main] exiting for supervisor restart…');
    process.exit(1);
  });
}

main().catch((e) => {
  console.error('[main] fatal:', e);
  process.exit(1);
});
