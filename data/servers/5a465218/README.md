# Telegram SaaS 4-Bot

## New in this build
- Tenant auto-restore after SaaS/server restart for tenants whose runtime record is still active.
- Tenant crash auto-restart while the subscription is still active.
- Owner price setup is now numeric: choose bot **1 / 2 / 3 / 4**, send the price, then send the active days.
- Buyers can change the Bot Token of an existing tenant from **📦 Bot Saya** without buying the bot again; the remaining expiry is preserved.
- Existing four bot source directories are kept unchanged; SaaS changes are isolated to the provisioning/control layer.
- QRIS remains controlled from the SaaS admin bot, not from `.env`.

## Pterodactyl
```bash
npm install --ignore-scripts && npm start
```

Required `.env` values:
- `SAAS_BOT_TOKEN`
- `SAAS_OWNER_ID`
- `TELEGRAM_API_ID` / `TELEGRAM_API_HASH` when a tenant type requires Telegram MTProto.

Do not put QRIS settings or tenant Bot Tokens into the SaaS `.env`; tenant tokens are stored in each tenant's own runtime `.env`.


## Auto Recovery Server / Tenant
- Tenant data and account sessions stay inside each tenant runtime and are not overwritten after first creation.
- On SaaS startup, tenants previously marked as running/crashed/restarting with `autostart=true` are restored automatically.
- Auto Comment/Jaseb reuses the existing custom-emoji IDs from `emoji/custom_emojis.json` and fills gaps from the existing Tagall emoji table; no new emoji IDs are created.
- For VPS reboot persistence with PM2: `pm2 start ecosystem.config.js && pm2 save && pm2 startup`.
