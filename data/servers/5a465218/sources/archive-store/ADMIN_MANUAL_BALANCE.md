# Admin Tambah Saldo Manual

Flow:
1. Admin -> 💰 Kelola Saldo -> ➕ Tambah Saldo Manual
2. Masukkan User ID
3. Bot membaca saldo buyer
4. Masukkan nominal
5. Bot menampilkan konfirmasi saldo sebelum/sesudah
6. Admin konfirmasi
7. Wallet buyer ditambah dalam transaksi repository/wallet yang atomik
8. Simpan audit record
9. Buyer diberi notifikasi

Validasi:
- User ID wajib diisi.
- Nominal harus integer positif.
- Admin tidak boleh menambah saldo tanpa konfirmasi.
- Riwayat manual top-up disimpan.

Catatan: `manualBalanceHandler.js` menyediakan flow/helper yang harus dipanggil oleh router owner/wallet repository yang sudah ada agar perubahan saldo dan audit berlangsung atomik.
