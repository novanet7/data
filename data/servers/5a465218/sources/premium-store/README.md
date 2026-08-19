# Telegram Auto Premium Store V10

Node.js + Telegraf auto-order premium store.

## V10 admin roles
- Owner ditentukan dari `OWNER_IDS` di `.env`.
- Owner dapat menambah dan menghapus Admin berdasarkan **Telegram User ID**.
- Admin memiliki semua fitur operasional toko: tambah/edit/hapus produk, restock per paket, cek stok, saldo user, deposit, order/resi, statistik, broadcast, banner/QRIS/sticker, dll.
- Admin **tidak** dapat membeli produk.
- Admin **tidak** dapat menambah atau menghapus Admin.
- Menu **Kelola Admin** hanya muncul untuk Owner.

## V10 queue + stock safety
- Checkout stok memakai **queue per produk + paket** agar order bersamaan diproses satu per satu.
- Stok dikunci/reserve sebelum delivery.
- Saldo buyer dipotong saat reservation dibuat.
- Jika pesan delivery Telegram gagal, sistem melakukan **rollback**: stok dikembalikan ke paket yang benar dan saldo buyer otomatis direfund.
- Order yang sedang `processing` dipulihkan otomatis setelah bot restart bila sudah stale, dengan restore stock + refund.
- Produk tidak dapat dihapus ketika masih ada order aktif `processing`/`paid` yang bisa membuat rollback tidak aman.
- Semua proses penting dicatat di **resi/order log**.

## Stock per package
- Restock: **Produk -> Paket/Durasi -> Stok**.
- Stock disimpan terpisah per paket (1 Bulan, 3 Bulan, 6 Bulan, dst.).
- Buyer hanya dapat membeli paket yang harga > 0 dan stok tersedia.
- Paket habis memunculkan tombol `❌` dan owner/admin mendapat notifikasi stok habis.

## Deposit
- Buyer memasukkan nominal deposit.
- QRIS yang dipasang admin ditampilkan.
- Buyer mengirim bukti foto.
- Owner/Admin menerima foto + nominal + User ID dengan tombol Approve/Cancel.
- Approve menambah saldo; Cancel menolak deposit.

## Run
```bash
npm install
npm start
```

`.env`:
```env
BOT_TOKEN=TOKEN_BOT_KAMU
OWNER_IDS=123456789
```

ZIP contents are flat (no wrapper folder).

## Pengaturan Store via Bot
Nama store dan pesan welcome `/start` sekarang disimpan di `data/store.json` dan dapat diubah langsung dari **Admin Panel → Pengaturan**. Tidak perlu menaruh nama store di `.env`.

Placeholder welcome yang tersedia:
- `{name}` = nama buyer
- `{store}` = nama store

`.env` hanya membutuhkan `BOT_TOKEN` dan `OWNER_IDS` untuk identitas bot/owner.
