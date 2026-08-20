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

## PostgreSQL
Runtime data is stored in PostgreSQL. JSON files are used only as one-time migration input for legacy installations; after successful migration they are moved aside and are no longer the source of truth.

Set these in `.env` (or use `DATABASE_URL`):

```env
PGHOST=127.0.0.1
PGPORT=5432
PGDATABASE=telegram_saas
PGUSER=postgres
PGPASSWORD=change_me
PGSSL=false
```

The SaaS creates the required `saas_documents` table automatically on startup. Existing legacy SaaS/tenant JSON is migrated to PostgreSQL the first time the corresponding store is started.

Important: Telegram session files remain files, because Telegram session state is not ordinary JSON application data. They are kept under the tenant runtime and are included in the global backup/restore flow.

## PostgreSQL Cloud / Pterodactyl (disarankan)
Untuk deployment yang mudah dipindah VPS, gunakan PostgreSQL managed (Neon/Supabase atau provider lain). Cukup isi `DATABASE_URL` di `.env`. Startup akan:
1. membaca `DATABASE_URL`;
2. retry koneksi beberapa kali saat VPS baru boot;
3. membuat tabel `saas_documents` + index otomatis jika belum ada;
4. menjalankan migrasi legacy JSON sekali bila data lama ditemukan;
5. menyalakan SaaS dan memulihkan semua tenant sesuai `autostart`.

Tidak ada instalasi PostgreSQL di dalam Pterodactyl container. PostgreSQL berada di luar container sebagai managed service.

Contoh `.env` minimal:
```env
SAAS_BOT_TOKEN=TOKEN_BOT_SAAS
SAAS_OWNER_ID=123456789
DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/DATABASE?sslmode=require
TZ=Asia/Jakarta
```

Session Telegram tetap berupa file dan disimpan di `tenants/`, lalu ikut mekanisme backup/restore global.

## PostgreSQL lokal/VPS
Jika kamu memang menyediakan PostgreSQL lokal, variabel `PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD` tetap didukung. Pada Pterodactyl, service PostgreSQL harus tersedia di luar container.
