/**
 * PM2 Ecosystem Config — Production
 *
 * Usage:
 *   pm2 start ecosystem.config.js
 *   pm2 logs
 *   pm2 restart all
 *   pm2 stop all
 */

module.exports = {
  apps: [
    {
      name: 'backenly-nextjs',
      script: '.next/standalone/server.js',
      cwd: './',
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
      },
      // Restart policy
      autorestart: true,
      watch: false,
      max_restarts: 15,
      min_uptime: '10s',
      restart_delay: 4000,
      // Memory — restart before OOM kills the process
      max_memory_restart: '550M',
      // Scheduled restart every 12h to prevent slow memory leaks
      cron_restart: '0 */12 * * *',
      // Logs
      error_file: './logs/nextjs-error.log',
      out_file: './logs/nextjs-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
    },
    {
      name: 'backenly-runtime',
      script: 'node_modules/.bin/tsx',
      args: 'server/index.ts',
      cwd: './',
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
        RUNTIME_PORT: 3001,
      },
      // Restart policy
      autorestart: true,
      watch: false,
      max_restarts: 15,
      min_uptime: '10s',
      restart_delay: 4000,
      // Memory — restart before OOM kills the process
      max_memory_restart: '350M',
      // Scheduled restart every 12h to prevent slow memory leaks.
      //
      // NOT on a :00/:15/:30/:45 boundary. The contract probe sweep runs
      // `*/15 * * * *` (instrumentation.ts) and probes this process over
      // loopback, so a restart at :30 landed inside the sweep and every probe
      // got ECONNREFUSED. That filed four critical "your live API surfaces are
      // failing" findings against every project with tables, twice a day, with
      // a hint telling the owner to go check whether PM2 was running.
      cron_restart: '37 */12 * * *',
      // Logs
      error_file: './logs/runtime-error.log',
      out_file: './logs/runtime-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
    },
  ],
}
