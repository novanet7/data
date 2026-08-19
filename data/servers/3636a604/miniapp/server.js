/**
 * miniapp/server.js
 * -----------------------------------------------------------------------
 * Server kecil buat Telegram Mini App (Web App) toko ini.
 * Tugasnya cuma DUA hal, sengaja dibikin simpel & aman:
 *   1. Sajikan halaman katalog (public/index.html) yang tampilannya modern
 *      dan bisa dibuka di dalam Telegram sebagai Mini App.
 *   2. Sediakan GET /api/catalog -> data produk (nama, harga, deskripsi,
 *      stok) buat ditampilkan di halaman itu. Field sensitif (akun/pass)
 *      TIDAK pernah dikirim ke browser.
 *
 * Checkout/pembayaran SENGAJA TIDAK diproses di sini. Tombol "Beli" di
 * Mini App cuma deep-link balik ke chat bot Telegram (t.me/<bot>?start=...),
 * lalu index.js (bot utama) yang lanjutin pakai alur pembayaran yang SUDAH
 * ada & teruji (QRIS Atlantic/Nevapedia + Telegram Stars). Jadi tidak ada
 * logic pembayaran/duplikasi apikey yang perlu "diekspos" ke halaman web.
 * -----------------------------------------------------------------------
 */

const express = require("express");
const path = require("path");
const fs = require("fs");
const config = require("../config");

const app = express();
const PORT = config.miniApp?.port || 3400;
const DB_PATH = path.join(__dirname, "..", "database.json");

function readDb() {
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
  } catch (e) {
    console.error("[MINIAPP] Gagal baca database.json:", e.message);
    return { apps: [], scripts: [] };
  }
}

// CORS longgar untuk domain Telegram Web App preview (t.me embed) + biar gampang di-tes dari mana saja
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  next();
});

app.use(express.static(path.join(__dirname, "public")));

app.get("/api/catalog", (req, res) => {
  const db = readDb();

  const mapItem = (item, idx, kind) => ({
    id: `${kind}_${idx}`,
    kind,
    idx,
    nama: item.nama,
    harga: parseInt(item.harga) || 0,
    deskripsi: item.deskripsi || "",
    stok: kind === "app" ? (item.accounts || []).length : null, // scripts biasanya unlimited/manual, apps ada stok akun
  });

  const apps = (db.apps || []).map((it, i) => mapItem(it, i, "app"));
  // Catatan: kategori "scripts" sengaja belum ditampilkan di Mini App karena saat ini
  // belum punya alur pembelian (buy_script_N) yang bisa di-deep-link seperti "apps".
  // Kalau nanti alur beli script sudah ada di bot, tinggal tambahkan lagi di sini.

  res.json({
    botName: config.botName || "Toko",
    botUsername: config.miniApp?.botUsername || "",
    categories: [
      { key: "app", label: "Produk", items: apps },
    ],
  });
});

app.listen(PORT, () => {
  console.log(`🛍️  Mini App server jalan di http://localhost:${PORT}`);
  console.log(`    Deploy folder ini ke hosting HTTPS (VPS+nginx, Vercel, dll),`);
  console.log(`    lalu isi URL publiknya di config.js -> miniApp.url`);
});
