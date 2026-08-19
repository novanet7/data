# Telegram Session Backup / Recovery

Backup SaaS global sekarang menyertakan file session Telegram (`*.session`) yang berada di runtime tenant, termasuk folder `sessions` dan `seller_sessions`.

Yang ikut tersimpan:
- Session akun Telegram Archive.
- Session seller.
- Seluruh data tenant/store yang berada di runtime.
- Metadata tenant agar tenant yang `autostart` dapat dihidupkan kembali setelah restore.

Session tidak dipakai sebagai trigger backup berdasarkan perubahan isi file, karena file session dapat berubah saat aktivitas Telegram dan itu bisa menyebabkan spam backup. Sistem hanya menganggap perubahan **keberadaan file session** (session baru ditambahkan atau session dihapus) sebagai perubahan yang layak membuat snapshot baru.

Saat restore, manifest memuat jumlah file session dan restore akan menolak backup sebelum mengganti data live jika jumlah session di dalam arsip lebih sedikit daripada yang dinyatakan manifest. Setelah restore, SaaS melakukan restart dan tenant yang memiliki `autostart` akan dipulihkan menggunakan runtime/session yang sudah direstore.
