module.exports = {
  apps: [
    {
      name: 'telegram-store-saas',
      script: 'src/app.js',
      instances: 1,          // Must be 1 — single process manages all bot instances
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'development',
      },
      env_production: {
        NODE_ENV: 'production',
      },
      log_file:     './logs/combined.log',
      out_file:     './logs/out.log',
      error_file:   './logs/error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      restart_delay: 5000,
      max_restarts: 10,
      min_uptime: '10s',
      kill_timeout: 8000,    // Give bots 8 s to shut down gracefully
    },
  ],
};
