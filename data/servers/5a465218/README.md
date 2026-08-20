# Telegram Keyword Forwarder

Userbot Telegram berbasis GramJS + bot admin Telegraf.

## Fitur
- Memantau semua grup yang diikuti akun userbot.
- Keyword forward otomatis.
- Grup tujuan bisa diatur dari bot admin.
- Ignore grup tertentu.
- Ambil nama, username, ID, dan bio pengirim jika tersedia.
- Login akun Telegram melalui bot: nomor HP -> OTP -> 2FA jika diperlukan.
- Session disimpan otomatis ke `data/sessions/` agar tetap login setelah restart.
- Monitoring ON/OFF dari panel.

## Instalasi
1. Salin `.env.example` menjadi `.env`.
2. Isi `BOT_TOKEN`, `OWNER_ID`, `API_ID`, `API_HASH`.
3. Jalankan `npm install`.
4. Jalankan `npm start`.

## Perintah utama
- `/addaccount` tambah akun Telegram.
- `/cancel` batalkan proses login.
- `/addkeyword gabutan` tambah keyword.
- `/delkeyword gabutan` hapus keyword.
- `/addtarget -1001234567890` tambah grup tujuan.
- `/deltarget -1001234567890` hapus grup tujuan.
- `/ignore -1001234567890` ignore grup sumber.
- `/unignore -1001234567890` hapus ignore.
- `/panel` buka panel.

## Catatan
Akun yang dipantau adalah akun Telegram biasa yang login melalui userbot. Akun harus dapat melihat pesan di grup sumber. Gunakan secara wajar dan patuhi aturan Telegram serta aturan grup.
