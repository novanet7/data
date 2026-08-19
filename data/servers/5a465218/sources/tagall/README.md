# Raxi Tagall Bot — Node.js

Node.js 22+ Telegram bot using Telegraf + GramJS + Node's built-in `node:sqlite`.

## Startup

```bash
npm start
```

## Required ENV

See `.env.example`.

- `BOT_TOKEN` — token bot API.
- `BOT_USERNAME` — username bot tanpa `@`.
- `OWNER_ID` — Telegram user ID owner.
- `API_ID` / `API_HASH` — Telegram API credentials for GramJS assistant sessions.
- `TARGET_GROUP_LINKS` — one or more target groups, separated by comma/newline.

## Important

Keep these when updating:

- `.env`
- `data/bot.sqlite3`
- `sessions/` (if created)

The database stores member cache, Welcome/Goodbye settings, queue, partners, assistant sessions, timer and export metadata.

## Flow

1. Bot starts even when no assistant is connected.
2. If an assistant session exists, auto-sync starts for all ENV targets.
3. If Sync is pressed without an assistant, the bot asks to connect an assistant first.
4. Sync only reads participants, stores cache, shows progress by editing one status message, then disconnects the GramJS client.
5. Tagall uses database cache only; assistant is not required to stay online.
6. `/tekal` and `/takal` are group-admin only, with 1–30 minute timer and Stop controls.
7. Partner requests enter queue; each partner run uses the admin-configured 1–30 minute timer, then fixed 5-minute cooldown before the next queued request.
8. Welcome/Goodbye settings are configured and saved from the bot for each ENV target. Join, approved Join Request, leave and kick are handled via `chat_member`/`chat_join_request` with deduplication.
9. Export/Import produces a single JSON backup containing application data and banner `file_id` values.


## Startup Pterodactyl
Use a single startup command:

```bash
npm start
```

The `start` script automatically runs `npm install --omit=dev`, then the startup doctor, then the bot.
