#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

pm2 start ecosystem.config.js
pm2 save
echo
 echo "PM2 startup command berikut akan dicetak. Jalankan perintah sudo yang diberikan PM2, lalu server akan menghidupkan Telegram SaaS otomatis setiap boot."
pm2 startup
