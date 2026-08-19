
## UI Style
All bot text screens are normalized to a consistent blockquote layout with a bold `✦` heading, separator, mixed bold/regular text, and dynamic screen copy. User-entered messages such as phone numbers, OTPs, and credentials are never deleted by the UI cleanup middleware.
# Telegram Account Store

Single-store Telegram account marketplace dengan:

- Buyer shop + saldo internal
- Top Up QRIS Manual dan Valqenix
- Restock admin Telegram via OTP/2FA dengan auto-detect ID
- Seller Marketplace + setor akun Telegram
- Penarikan seller + riwayat saldo
- Pricelist buyer berdasarkan ID 1–9 dan digit 8D/9D/10D
- Harga seller langsung berdasarkan ID 1–8 dan digit 8D/9D/10D
- JSON file database tanpa MongoDB

## Instalasi bersih

```bash
npm install
npm run setup
```

`npm install` otomatis membuat folder runtime dan menjalankan static/dependency check.
`npm run setup` membuat `.env` jika belum ada.

Isi `.env` minimal:

- `PLATFORM_BOT_TOKEN`
- `PLATFORM_OWNER_ID`
- `TG_API_ID`
- `TG_API_HASH`

Setelah itu:

```bash
npm run doctor
npm start
```

## Restock Admin

Admin tidak memilih ID atau digit saat login.

```text
Restock Telegram
→ nomor Telegram
→ OTP / 2FA
→ bot membaca Telegram ID asli
→ otomatis masuk bucket ID + digit yang sesuai
```

Bucket buyer hanya mendukung **8D, 9D, 10D**.

## Seller Marketplace

Pengaturan harga seller tidak memakai CLEAR/WARNING/LIMITED/UNKNOWN dan tidak memakai persentase.

```text
Atur Seller
→ ID 1–8
→ 8D / 9D / 10D
→ masukkan harga Rupiah langsung
```

Contoh: `ID 7 → 10D → Rp35.000`.

## Pembayaran Buyer

Admin dapat mengaktifkan QRIS Manual dan/atau Valqenix. Menu buyer selalu membaca setting terbaru dari database, sehingga metode yang OFF tidak ditampilkan. QRIS Manual menggunakan Telegram `file_id` yang disimpan sebagai `imageUrl`.

## Database & session

Data disimpan di `data/`. Session akun Telegram admin/seller disimpan di:

- `data/sessions/`
- `data/seller_sessions/`

Jangan menghapus folder tersebut jika stok/session masih diperlukan.

## Docker

```bash
docker compose up -d --build
```

Compose menjalankan satu process Node untuk satu toko. `.env` berada di host dan tidak dibundel ke image.

## UI & Backup behavior
- `BACKUP_INTERVAL_HOURS` and `BACKUP_RETENTION` control scheduled database backups. Default: every 6 hours, keep 20 backups.
- Scheduled/startup backups are the normal automatic backup mechanism; stock changes do not create a backup on every click.
- Buyer, seller, and admin bot UI keeps the chat compact: when a new bot screen is produced by a button action, the previous bot screen is removed.
- User-entered messages (numbers, OTP, account/login input, etc.) are never deleted by the UI cleanup middleware.
- Bot UI is rendered as HTML blockquotes with mixed bold/regular text where the legacy Markdown format can be converted safely.

## Mandatory channel subscription
Set these variables to require every non-owner user to join a channel before using the bot:

```env
REQUIRED_SUBSCRIPTION_CHANNEL_ID=-1001234567890
REQUIRED_SUBSCRIPTION_CHANNEL_URL=https://t.me/yourchannel
```

The bot shows a **Gabung Channel** button and a **Cek Verifikasi** button. Membership is checked with Telegram `getChatMember`. Owners are exempt. If the check cannot be performed, access is denied rather than bypassing the gate.

For backwards compatibility, if `REQUIRED_SUBSCRIPTION_CHANNEL_ID` is empty, `NOTIFICATION_CHANNEL_ID` and `NOTIFICATION_CHANNEL_URL` are used as the subscription channel configuration.

README additions:

### FS / NFS detection
Saat session Telegram berhasil login melalui Restock, bot dapat otomatis meminta status akun melalui `@SangMata_BOT`. Balasan "History for ..." diklasifikasikan sebagai `NFS`, sedangkan "Tidak ada data ..." / "No data available ..." diklasifikasikan sebagai `FS`. Harga FS dan NFS disimpan terpisah di `settings.idPricing.fsPrices` dan `settings.idPricing.nfsPrices`.
