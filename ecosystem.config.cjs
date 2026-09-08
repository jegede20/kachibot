/**
 * KACHIBOT — PM2 process config (24/7 auto-restart).
 * Works on Windows, macOS and Linux. The easiest way to keep the bot alive.
 *
 *   npm install -g pm2          # one time
 *   pm2 start ecosystem.config.cjs
 *   pm2 save                    # make it survive reboot
 *   pm2 startup                 # prints a command — run it (Windows: skip,
 *                               #   pm2 save + pm2 startup works via pm2-windows-service)
 *
 * Useful: pm2 logs kachibot · pm2 restart kachibot · pm2 status
 */
module.exports = {
  apps: [
    {
      name: 'kachibot',
      cwd: __dirname,
      script: 'dist/index.js',
      autorestart: true,               // restart on crash, always
      restart_delay: 3000,             // 3s backoff between restarts
      max_restarts: 100,
      min_uptime: 5000,
      max_memory_restart: '400M',      // recycle if memory balloons
      kill_timeout: 8000,
      time: true,                      // timestamps in logs
      out_file: './data/pm2-out.log',
      error_file: './data/pm2-err.log',
      env: { NODE_ENV: 'production' },
    },
  ],
};
