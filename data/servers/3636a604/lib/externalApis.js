/**
 * lib/externalApis.js
 * -----------------------------------------------------------------------
 * Registry + generic caller untuk 2 provider endpoint eksternal:
 *   - fidzzcodex  (https://me.fidzzcodex.my.id/endpoints)  -> 70 endpoint
 *   - nexapi.fun  (https://nexapi.fun/docs)                -> 41 endpoint
 *     (nexapi.fun sebenarnya total 43 endpoint publik, tapi 2 di antaranya
 *     -- kategori "AM Premium": /api/am/send & /api/am/verify -- adalah
 *     bypass aktivasi premium Alight Motion tanpa bayar dan SENGAJA TIDAK
 *     didaftarkan di sini karena itu penyalahgunaan/pencurian layanan.)
 *
 * Dipakai oleh index.js (bot Telegram) untuk fitur Tools 2, Tools 3, dan Tools 4.
 *
 * Karena jumlah endpoint sangat banyak dan tiap provider punya nama
 * parameter yang berbeda-beda, pemanggilan endpoint memakai format
 * generik `key=value` (lihat `parseKeyValueArgs`), jadi tidak perlu bikin
 * 100 fungsi terpisah dan tetap gampang ditambah/diubah kalau provider
 * update param mereka. Param yang sudah diketahui pasti (dari dokumentasi
 * resmi) dicatat di field `params` tiap endpoint untuk ditampilkan sebagai
 * bantuan (/fidzz atau /nex tanpa argumen / dengan argumen kurang).
 * -----------------------------------------------------------------------
 */

const axios = require("axios");
const config = require("../config");

const SIPUTZX_BASE = "https://api.siputzx.my.id";
const RYZUMI_BASE = "https://api.ryzumi.net"; // sumber tambahan untuk Tools 4, juga gratis tanpa apikey
const DOA_BASE = "https://doa-doa-api-ahmadramadhan.fly.dev"; // kumpulan doa harian, gratis tanpa apikey
const EQURAN_BASE = "https://equran.id/api/v2"; // Al-Quran + audio 6 qari + tafsir, gratis tanpa apikey
const NEXRAY_BASE = "https://api.nexray.eu.cc"; // Nexray API - 100% gratis, TANPA apikey sama sekali
const FAA_BASE = "https://api-faa.my.id"; // API by Faa - 100% gratis, TANPA apikey sama sekali
const ALWAYSCODEX_BASE = "https://api.alwayscodex.eu.cc"; // AlwaysCodex API - 100% gratis, TANPA apikey sama sekali (domain lama .my.id sudah pindah ke .eu.cc)
const IZUKA_BASE = "https://my.izuka-api.xyz"; // Izuka API

// ------------------------------------------------------------------
// 1. REGISTRY - FIDZZCODEX (70 endpoint)
//    method: GET | POST | DELETE (sesuai dokumentasi resmi)
//    params: daftar nama param yang diketahui pasti dari docs (bisa kosong
//            kalau belum diverifikasi -> tetap bisa dipanggil generik)
// ------------------------------------------------------------------
const FIDZZ_ENDPOINTS = [
  // --- AI (16) ---
  { key: "gemini", category: "AI", method: "POST", path: "/ai/gemini", desc: "Chat dengan AI Gemini (support session)", params: ["prompt", "session_id?"] },
  { key: "chatday", category: "AI", method: "POST", path: "/ai/chatday", desc: "Chat dengan berbagai model AI via ChatDay", params: ["prompt"] },
  { key: "claude", category: "AI", method: "POST", path: "/ai/claude", desc: "Chat dengan Claude AI", params: ["prompt"] },
  { key: "deepseek", category: "AI", method: "POST", path: "/ai/deepseek-scrape", desc: "Chat dengan DeepSeek AI (support session)", params: ["prompt", "system?", "session_id?"] },
  { key: "rewind-gemini", category: "AI", method: "POST", path: "/ai/rewind-gemini", desc: "Chat dengan Google Gemini 2.5 Flash via Rewind AI", params: ["prompt"] },
  { key: "rewind-gemma", category: "AI", method: "POST", path: "/ai/rewind-gemma", desc: "Chat dengan Google Gemma 4 31B via Rewind AI", params: ["prompt"] },
  { key: "music", category: "AI", method: "POST", path: "/ai/music", desc: "Generate musik dengan AI dari prompt dan style", params: ["prompt", "style?"] },
  { key: "gptanon", category: "AI", method: "POST", path: "/ai/gptanon", desc: "Chat dengan AI tanpa login (support session)", params: ["prompt", "session_id?"] },
  { key: "hotbot", category: "AI", method: "POST", path: "/ai/hotbot", desc: "Chat dengan AI GPT-5 dari Hotbot (tanpa batasan)", params: ["prompt"] },
  { key: "muslim", category: "AI", method: "POST", path: "/ai/muslim", desc: "Chat dengan AI Muslim (konsultasi Islami)", params: ["prompt"] },
  { key: "notrack", category: "AI", method: "POST", path: "/ai/notrack", desc: "Chat dengan AI NoTrack (tanpa batasan)", params: ["prompt"] },
  { key: "rewind-chat", category: "AI", method: "POST", path: "/ai/rewind-chat", desc: "Chat dengan berbagai model AI via Rewind AI", params: ["prompt"] },
  { key: "surfsense", category: "AI", method: "POST", path: "/ai/surfsense", desc: "Chat dengan AI Surfsense (support session)", params: ["prompt", "session_id?"] },
  { key: "turboseek", category: "AI", method: "POST", path: "/ai/turboseek", desc: "Chat dengan AI TurboSeek (cari sumber & jawaban)", params: ["prompt"] },
  { key: "hdvideo", category: "AI", method: "POST", path: "/ai/hdvideo", desc: "Enhance video menjadi kualitas tinggi", params: ["url"] },
  { key: "unlimitedai", category: "AI", method: "POST", path: "/ai/unlimitedai", desc: "Chat dengan AI Unlimited (gratis)", params: ["prompt"] },
  { key: "chatgpt-mobile", category: "AI", method: "POST", path: "/ai/chatgpt-mobile", desc: "Chat dengan ChatGPT via Android API (tanpa akun)", params: ["prompt", "session_id?"] },

  // --- Tools (21) ---
  { key: "transcript", category: "Tools", method: "POST", path: "/tools/transcript", desc: "Transkrip video ke teks", params: ["url"] },
  { key: "bypass", category: "Tools", method: "POST", path: "/tools/bypass", desc: "Bypass link shortener (linkvertise, dll)", params: ["url"] },
  { key: "channel-id", category: "Tools", method: "GET", path: "/tools/channel-id", desc: "Ambil ID dan JID dari link WhatsApp Channel", params: ["url"] },
  { key: "getcode", category: "Tools", method: "GET", path: "/tools/getcode", desc: "Ambil source code HTML, CSS, dan JS dari sebuah URL", params: ["url"] },
  { key: "wa-channel", category: "Tools", method: "GET", path: "/tools/whatsapp-channel", desc: "Ambil informasi channel WhatsApp", params: ["url"] },
  { key: "wa-group", category: "Tools", method: "GET", path: "/tools/whatsapp-group", desc: "Ambil informasi grup WhatsApp", params: ["url"] },
  { key: "readqr", category: "Tools", method: "GET", path: "/tools/readqr", desc: "Decode QR code dari URL gambar", params: ["url"] },
  { key: "rewrite", category: "Tools", method: "POST", path: "/tools/rewrite", desc: "Rewrite teks dengan berbagai tone menggunakan NoteGPT AI", params: ["text", "tone?"] },
  { key: "ngl-spam", category: "Tools", method: "POST", path: "/tools/ngl-spam", desc: "Kirim pesan spam ke NGL.link", params: ["username", "message", "amount?"] },
  { key: "screenshot", category: "Tools", method: "POST", path: "/tools/screenshot", desc: "Screenshot website via Vivoldi", params: ["url"] },
  { key: "texttoqr", category: "Tools", method: "GET", path: "/tools/texttoqr", desc: "Generate QR Code dari teks", params: ["text"] },
  { key: "tourl", category: "Tools", method: "POST", path: "/tools/tourl", desc: "Upload file ke njy.my.id", params: ["file(url)"] },
  { key: "upload", category: "Tools", method: "POST", path: "/tools/upload", desc: "Upload file ke unggah.web.id", params: ["file(url)"] },
  { key: "enhance", category: "Tools", method: "POST", path: "/tools/enhance", desc: "Upscale dan enhance kualitas gambar", params: ["url"] },
  { key: "bypass2", category: "Tools", method: "POST", path: "/tools/bypass2", desc: "Bypass berbagai shortlink (SFL.gl, Linkvertise, dll)", params: ["url"] },
  { key: "crypto", category: "Tools", method: "GET", path: "/tools/crypto", desc: "Cek harga crypto real-time (BTC, ETH, SOL, dll)", params: ["coins"] },
  { key: "emojimix", category: "Tools", method: "GET", path: "/tools/emojimix", desc: "Mix dua emoji menjadi satu (Google Emoji Kitchen)", params: ["emoji"] },
  { key: "enhance-image", category: "Tools", method: "POST", path: "/tools/enhance-image", desc: "Enhance atau upscale gambar menggunakan AI (Imglarger)", params: ["file(url)"] },
  { key: "npm-check", category: "Tools", method: "GET", path: "/tools/npm-check", desc: "Cek versi terbaru package NPM", params: ["package"] },

  // --- Downloader (7) ---
  { key: "capcut", category: "Downloader", method: "GET", path: "/download/capcut", desc: "Download video Capcut", params: ["url"] },
  { key: "getpp", category: "Downloader", method: "GET", path: "/download/getpp", desc: "Ambil foto profil TikTok user", params: ["username"] },
  { key: "github-clone", category: "Downloader", method: "GET", path: "/download/github", desc: "Clone github repositori", params: ["url"] },
  { key: "savewave", category: "Downloader", method: "POST", path: "/downloader/savewave", desc: "Download video/audio dari berbagai platform (TikTok, YouTube, Instagram, dll)", params: ["url"] },
  { key: "youtube-dl", category: "Downloader", method: "GET", path: "/download/youtube", desc: "Download audio/video dari YouTube", params: ["url", "type?"] },
  { key: "spotify-dl-fidzz", category: "Downloader", method: "POST", path: "/download/spotify", desc: "Download lagu dari Spotify via Spotidown", params: ["url"] },
  { key: "tiktok-dl-fidzz", category: "Downloader", method: "GET", path: "/download/tiktok", desc: "Download video/audio dari TikTok tanpa watermark", params: ["url"] },

  // --- Pterodactyl (9) — SEMUA WAJIB param "plta" (application API key
  // panel Pterodactyl target, BUKAN apikey fidzzcodex — apikey fidzzcodex
  // sudah otomatis disisipkan callFidzz, jangan pakai nama param "apikey"
  // di sini karena bakal ketimpa/collision) ---
  { key: "ptero-clearserver", category: "Pterodactyl", method: "DELETE", path: "/pterodactyl/clearserver", desc: "Remove ALL servers from the panel (DESTRUKTIF)", params: ["domain", "plta"] },
  { key: "ptero-clearuser", category: "Pterodactyl", method: "DELETE", path: "/pterodactyl/clearuser", desc: "Remove ALL users from Pterodactyl (DESTRUKTIF)", params: ["domain", "plta"] },
  { key: "ptero-createadmin", category: "Pterodactyl", method: "GET", path: "/pterodactyl/createadmin", desc: "Create a new user as admin", params: ["domain", "plta", "username"] },
  { key: "ptero-createserver", category: "Pterodactyl", method: "GET", path: "/pterodactyl/createserver", desc: "Create Node.js users and servers directly di Pterodactyl", params: ["domain", "plta", "username", "disk", "cpu"] },
  { key: "ptero-deladmin", category: "Pterodactyl", method: "DELETE", path: "/pterodactyl/deladmin", desc: "Remove admin user from system (by id)", params: ["domain", "plta", "id"] },
  { key: "ptero-delpanel", category: "Pterodactyl", method: "DELETE", path: "/pterodactyl/delpanel", desc: "Deleting servers and users dari Pterodactyl (by id/username)", params: ["domain", "plta", "id"] },
  { key: "ptero-listadmin", category: "Pterodactyl", method: "GET", path: "/pterodactyl/listadmin", desc: "Displays all admin users", params: ["domain", "plta"] },
  { key: "ptero-listserver", category: "Pterodactyl", method: "GET", path: "/pterodactyl/listserver", desc: "Display all servers dari Pterodactyl panel", params: ["domain", "plta"] },
  { key: "ptero-listuser", category: "Pterodactyl", method: "GET", path: "/pterodactyl/listuser", desc: "Displays all users dari Pterodactyl panel", params: ["domain", "plta"] },

  // --- Search (11) ---
  { key: "code-search", category: "Search", method: "GET", path: "/search/code", desc: "Cari kode di GitHub via Searchcode API", params: ["q", "repository?", "case_sensitive?", "max_results?"] },
  { key: "spotify-search-fidzz", category: "Search", method: "GET", path: "/search/spotify", desc: "Cari lagu di Spotify via Spotidown", params: ["q"] },
  { key: "detik", category: "Search", method: "GET", path: "/search/detik", desc: "Cari informasi berita dari detik.com", params: ["query"] },
  { key: "lyrics", category: "Search", method: "GET", path: "/search/lyrics", desc: "Cari lirik lagu dari lyrics.com", params: ["query"] },
  { key: "modcombo", category: "Search", method: "GET", path: "/search/modcombo", desc: "Cari dan dapatkan informasi APK MOD dari Modcombo", params: ["query"] },
  { key: "npm-search", category: "Search", method: "GET", path: "/search/npm", desc: "Cari package di NPM registry", params: ["query"] },
  { key: "pinterest-search", category: "Search", method: "GET", path: "/search/pinterest", desc: "Cari pin di Pinterest", params: ["query"] },
  { key: "pinterest-video", category: "Search", method: "GET", path: "/search/pinterest-video", desc: "Cari video di Pinterest", params: ["query"] },
  { key: "tokopedia", category: "Search", method: "GET", path: "/search/tokopedia", desc: "Cari produk di Tokopedia", params: ["query"] },
  { key: "wikipedia", category: "Search", method: "GET", path: "/search/wikipedia", desc: "Cari artikel Wikipedia", params: ["query"] },
  { key: "youtube-search", category: "Search", method: "GET", path: "/search/youtube", desc: "Search video YouTube tanpa API key", params: ["query"] },

  // --- Stalker (4) ---
  { key: "gh-stalk", category: "Stalker", method: "GET", path: "/stalk/github", desc: "Stalking github account", params: ["username"] },
  { key: "ig-stories", category: "Stalker", method: "GET", path: "/stalk/instagram-stories", desc: "Lihat stories Instagram tanpa login", params: ["username"] },
  { key: "npm-stalk", category: "Stalker", method: "GET", path: "/stalk/npm", desc: "Lihat informasi package NPM", params: ["package"] },
  { key: "tt-stalk", category: "Stalker", method: "GET", path: "/stalk/tiktok", desc: "Stalking profile TikTok user", params: ["username"] },

  // --- System (1) ---
  { key: "status", category: "System", method: "GET", path: "/system/status", desc: "Check status REST API", params: [] },
];

// ------------------------------------------------------------------
// 2. REGISTRY - NEXAPI.FUN (41 endpoint) - semua method GET
// ------------------------------------------------------------------
const NEX_ENDPOINTS = [
  // --- AI (4) ---
  { key: "turboseek", category: "AI", method: "GET", path: "/ai/turboseek", desc: "Chat with Turboseek", params: ["question"] },
  { key: "webpilot", category: "AI", method: "GET", path: "/ai/webpilot", desc: "Chat with Webpilot", params: ["query"] },
  { key: "notrack", category: "AI", method: "GET", path: "/ai/notrack", desc: "Chat dengan AI anonymous & uncensored", params: ["text", "model?(default:C)", "mode?(default:usual)"] },
  { key: "text2image", category: "AI", method: "GET", path: "/ai/text2image", desc: "Generate gambar dari prompt teks", params: ["prompt", "model?(turbo/quality)", "width?", "height?"] },

  // --- Games (4) ---
  { key: "mlbb-check", category: "Games", method: "GET", path: "/games/mlbb-check", desc: "Cek data akun Mobile Legends via synnmlbb", params: ["userId", "zoneId"] },
  { key: "mlbb-counter", category: "Games", method: "GET", path: "/games/mlbb-counter", desc: "Cari hero counter terbaik di Mobile Legends", params: ["hero"] },
  { key: "grow-a-garden", category: "Games", method: "GET", path: "/games/grow-a-garden", desc: "Get Grow A Garden Stock", params: [] },
  { key: "ff-check", category: "Games", method: "GET", path: "/games/ff-check", desc: "Check username/nickname Free Fire dari ID", params: ["id"] },

  // --- Tools & Utilities (15) ---
  { key: "joke", category: "Tools", method: "GET", path: "/tools/joke", desc: "Fetch a random joke", params: [] },
  { key: "iplookup", category: "Tools", method: "GET", path: "/tools/iplookup", desc: "Get geolocation and ISP info for any IP address", params: ["ip"] },
  { key: "carbon", category: "Tools", method: "GET", path: "/tools/carbon", desc: "Convert code snippet jadi gambar Carbon", params: ["code", "theme?", "font?", "lang?", "bg?"] },
  { key: "create-struk", category: "Tools", method: "GET", path: "/tools/create-struk", desc: "Generate struk belanja HD bergaya kasir", params: ["storename", "items(Nama:qty:harga,...)", "ppn?", "bayar?", "timezone?"] },
  { key: "cek-rekening", category: "Tools", method: "GET", path: "/tools/cek-rekening", desc: "Validasi nomor rekening bank/e-wallet", params: ["bank", "nomor"] },
  { key: "create-strukpnl", category: "Tools", method: "GET", path: "/tools/create-strukpnl", desc: "Buat receipt untuk pembelian panel", params: ["username", "paket", "buyer", "ram", "storage", "cpu", "db", "backup", "swap", "durasi", "harga", "trx", "brand"] },
  { key: "am-preset", category: "Tools", method: "GET", path: "/tools/am-preset", desc: "Ambil metadata project Alight Motion dari share link", params: ["url"] },
  { key: "web2zip", category: "Tools", method: "GET", path: "/tools/web2zip", desc: "Ambil source code dari sebuah website", params: ["url"] },
  { key: "tts", category: "Tools", method: "GET", path: "/tools/text-to-speech", desc: "Membuat text menjadi suara", params: ["text"] },
  { key: "spamotp", category: "Tools", method: "GET", path: "/tools/spamotp", desc: "Spam OTP ke sebuah nomor", params: ["number"] },
  { key: "bypass-subs4unlock-id", category: "Tools", method: "GET", path: "/tools/bypass/subs4unlock-id", desc: "Bypass subs4unlock.id", params: ["url"] },
  { key: "bypass-sub2unlock-com", category: "Tools", method: "GET", path: "/tools/bypass/sub2unlock-com", desc: "Bypass sub2unlock.com", params: ["url"] },
  { key: "bypass-sub2unlock-io", category: "Tools", method: "GET", path: "/tools/bypass/sub2unlock-io", desc: "Bypass sub2unlock.io", params: ["url"] },
  { key: "bypass-sub2unlock-me", category: "Tools", method: "GET", path: "/tools/bypass/sub2unlock-me", desc: "Bypass sub2unlock.me", params: ["url"] },
  { key: "izen", category: "Tools", method: "GET", path: "/tools/izen", desc: "Bypass link ads (support delta executor key)", params: ["url"] },

  // --- Downloader (8) ---
  { key: "spotify-dl", category: "Downloader", method: "GET", path: "/dl/spotify", desc: "Download a Spotify track", params: ["url"] },
  { key: "aio-v1", category: "Downloader", method: "GET", path: "/dl/aio-v1", desc: "All in One Downloader V1", params: ["url"] },
  { key: "ytdl-v1", category: "Downloader", method: "GET", path: "/dl/ytdl-v1", desc: "YouTube Downloader V1 (video & audio)", params: ["url"] },
  { key: "apldl", category: "Downloader", method: "GET", path: "/dl/apldl", desc: "Apple Music Downloader", params: ["url"] },
  { key: "tiktok-dl", category: "Downloader", method: "GET", path: "/dl/tiktok", desc: "Download TikTok video HD", params: ["url"] },
  { key: "pin-dl", category: "Downloader", method: "GET", path: "/dl/pin", desc: "Download Pinterest image", params: ["url"] },
  { key: "terabox", category: "Downloader", method: "GET", path: "/dl/terabox", desc: "Download file/video/image dari Terabox", params: ["url"] },
  { key: "npm-dl", category: "Downloader", method: "GET", path: "/dl/npm", desc: "Download tarball (.tgz) package dari npm registry", params: ["url"] },

  // --- Information (3) ---
  { key: "gh-info", category: "Information", method: "GET", path: "/info/github", desc: "Fetch public GitHub profile information", params: ["username"] },
  { key: "weather", category: "Information", method: "GET", path: "/info/accuweather", desc: "Prakiraan cuaca 10 hari berdasarkan kota", params: ["city"] },
  { key: "kompas", category: "Information", method: "GET", path: "/info/kompas", desc: "Berita terbaru dari KompasNews", params: [] },

  // --- Maker (2) ---
  { key: "qris1", category: "Maker", method: "GET", path: "/maker/qris1", desc: "Buat QRIS beserta overlay Anime", params: ["qr"] },
  { key: "qris2", category: "Maker", method: "GET", path: "/maker/qris2", desc: "Buat QRIS beserta overlay Profesional", params: ["qr"] },

  // --- Shorten URL (1) ---
  { key: "ai6net", category: "Shorten URL", method: "GET", path: "/shorten/ai6net", desc: "Shorten URL dengan Ai6Net", params: ["url"] },

  // --- Searching (4) ---
  { key: "yt-search", category: "Searching", method: "GET", path: "/search/youtube", desc: "Searching video di YouTube", params: ["q", "limit"] },
  { key: "spotify-search", category: "Searching", method: "GET", path: "/search/spotify", desc: "Searching track di Spotify", params: ["q"] },
  { key: "pin-search", category: "Searching", method: "GET", path: "/search/pinterest", desc: "Search pin di Pinterest", params: ["q", "limit"] },
  { key: "playstore-search", category: "Searching", method: "GET", path: "/search/playstore", desc: "Search aplikasi di Play Store", params: ["q", "limit"] },
];

// Kategori yang cuma boleh dipakai owner (endpoint berbahaya: hapus massal user/server dsb)
const OWNER_ONLY_CATEGORIES = ["Pterodactyl"];
function isOwnerOnlyCategory(category) {
  return OWNER_ONLY_CATEGORIES.includes(category);
}

// ------------------------------------------------------------------
// 2b. REGISTRY - SIPUTZX (api.siputzx.my.id) - Tools 4, GRATIS TANPA APIKEY
//     Ditambahkan bertahap dari screenshot dokumentasi (app.siputzx.my.id/playground)
//     karena halaman docs-nya JS SPA yang tidak bisa di-fetch otomatis.
// ------------------------------------------------------------------
const SIPUTZX_ENDPOINTS = [
  // --- AI ---
  { key: "duckai", category: "AI", method: "GET", path: "/api/ai/duckai", desc: "Chat dengan DuckAI (berbagai model AI)", params: ["message", "model?(contoh: gpt-4o-mini)", "systemprompt?"] },

  // --- Downloader ---
  { key: "savefrom", category: "Downloader", method: "GET", path: "/api/d/savefrom", desc: "SaveFrom Downloader (multi-platform)", params: ["url"] },
  { key: "gh-download", category: "Downloader", method: "GET", path: "/api/d/github", desc: "Download/clone repositori GitHub", params: ["url"] },
  { key: "douyin", category: "Downloader", method: "GET", path: "/api/d/douyin", desc: "Download video Douyin/TikTok tanpa watermark", params: ["url"] },
  { key: "lahelu", category: "Downloader", method: "GET", path: "/api/d/lahelu", desc: "Ambil media & metadata dari post Lahelu.com", params: ["url"] },
  { key: "soundcloud", category: "Downloader", method: "GET", path: "/api/d/soundcloud", desc: "Download audio dari SoundCloud", params: ["url"] },
  { key: "snackvideo", category: "Downloader", method: "GET", path: "/api/d/snackvideo", desc: "Download video dari Snack Video", params: ["url"] },
  { key: "spotifyv2", category: "Downloader", method: "GET", path: "/api/d/spotifyv2", desc: "Download lagu dari Spotify (v2)", params: ["url"] },
  { key: "fastdl-ig", category: "Downloader", method: "GET", path: "/api/d/fastdl", desc: "FastDL — download foto/video Instagram", params: ["url"] },
  { key: "igram", category: "Downloader", method: "GET", path: "/api/d/igram", desc: "IGram — download foto/video/reels Instagram", params: ["url"] },
  { key: "tiktok-v2", category: "Downloader", method: "GET", path: "/api/d/tiktok/v2", desc: "Download video TikTok (v2, tanpa watermark)", params: ["url"], aliases: ["tiktok", "tik-tok", "tt", "tiktokdl"] },
  { key: "twitter", category: "Downloader", method: "GET", path: "/api/d/twitter", desc: "Download video dari Twitter/X", params: ["url"] },
  { key: "ssstwitter", category: "Downloader", method: "GET", path: "/api/d/ssstwiter", desc: "SSSTwitter — download video Twitter/X (alternatif)", params: ["url"] },
  { key: "facebook", category: "Downloader", method: "GET", path: "/api/d/facebook", desc: "Download video Facebook (SD/HD/4K via SnapVid)", params: ["url"] },

  // --- Downloader (sumber: ryzumi.net) ---
  { key: "rz-mediafire", category: "Downloader", method: "GET", path: "/api/downloader/mediafire", desc: "Download file dari MediaFire", params: ["url"], base: RYZUMI_BASE },
  { key: "rz-mega", category: "Downloader", method: "GET", path: "/api/downloader/mega", desc: "Download file dari Mega.nz", params: ["url"], base: RYZUMI_BASE },
  { key: "rz-allinone", category: "Downloader", method: "GET", path: "/api/downloader/all-in-one", desc: "All-in-One Downloader (multi platform)", params: ["url"], base: RYZUMI_BASE },
  { key: "rz-bilibili-dl", category: "Downloader", method: "GET", path: "/api/downloader/bilibili", desc: "Download video dari BiliBili/BSTATION", params: ["url"], base: RYZUMI_BASE },
  { key: "rz-danbooru", category: "Downloader", method: "GET", path: "/api/downloader/danbooru", desc: "Download gambar dari Danbooru", params: ["url"], base: RYZUMI_BASE },
  { key: "rz-douyin", category: "Downloader", method: "GET", path: "/api/downloader/douyin", desc: "Download video Douyin (alternatif)", params: ["url"], base: RYZUMI_BASE },
  { key: "rz-threads", category: "Downloader", method: "GET", path: "/api/downloader/threads", desc: "Download post dari Threads", params: ["url"], base: RYZUMI_BASE },
  { key: "rz-tiktok", category: "Downloader", method: "GET", path: "/api/downloader/tiktok", desc: "Download video TikTok (alternatif)", params: ["url"], base: RYZUMI_BASE },
  { key: "rz-twitter", category: "Downloader", method: "GET", path: "/api/downloader/twitter", desc: "Download video Twitter/X (alternatif)", params: ["url"], base: RYZUMI_BASE },
  { key: "rz-ytmp3v2", category: "Downloader", method: "GET", path: "/api/downloader/v2/ytmp3", desc: "Download audio YouTube (v2)", params: ["url"], base: RYZUMI_BASE },
  { key: "rz-ytmp4v2", category: "Downloader", method: "GET", path: "/api/downloader/v2/ytmp4", desc: "Download video YouTube (v2)", params: ["url"], base: RYZUMI_BASE },
  { key: "rz-videy", category: "Downloader", method: "GET", path: "/api/downloader/videy", desc: "Ambil file dari videy.co", params: ["url"], base: RYZUMI_BASE },
  { key: "rz-ytmp3", category: "Downloader", method: "GET", path: "/api/downloader/ytmp3", desc: "Download audio YouTube", params: ["url"], base: RYZUMI_BASE },
  { key: "rz-ytmp4", category: "Downloader", method: "GET", path: "/api/downloader/ytmp4", desc: "Download video YouTube", params: ["url"], base: RYZUMI_BASE },
  { key: "rz-spotify-dl", category: "Downloader", method: "GET", path: "/api/downloader/spotify", desc: "Download lagu dari Spotify", params: ["url"], base: RYZUMI_BASE },

  // --- Search (sumber: ryzumi.net) ---
  { key: "rz-bilibili-search", category: "Search", method: "GET", path: "/api/search/bilibili", desc: "Cari media di Bilibili", params: ["query"], base: RYZUMI_BASE },
  { key: "rz-bmkg", category: "Search", method: "GET", path: "/api/search/bmkg", desc: "Info gempa terkini dari BMKG", params: [], base: RYZUMI_BASE },
  { key: "rz-chord", category: "Search", method: "GET", path: "/api/search/chord", desc: "Cari chord lagu", params: ["query"], base: RYZUMI_BASE },
  { key: "rz-gimage", category: "Search", method: "GET", path: "/api/search/gimage", desc: "Google Image Search", params: ["query"], base: RYZUMI_BASE },
  { key: "rz-google", category: "Search", method: "GET", path: "/api/search/google", desc: "Google Search", params: ["query"], base: RYZUMI_BASE },
  { key: "rz-hargaemas", category: "Search", method: "GET", path: "/api/search/harga-emas", desc: "Cek harga emas Antam", params: [], base: RYZUMI_BASE },
  { key: "rz-jadwalsholat", category: "Search", method: "GET", path: "/api/search/jadwal-sholat", desc: "Jadwal sholat berdasarkan kota", params: ["kota"], base: RYZUMI_BASE },
  { key: "rz-kursbca", category: "Search", method: "GET", path: "/api/search/kurs-bca", desc: "Cek kurs mata uang BCA", params: [], base: RYZUMI_BASE },
  { key: "rz-lens", category: "Search", method: "GET", path: "/api/search/lens", desc: "Google Lens Search (cari dari link gambar)", params: ["url"], base: RYZUMI_BASE },
  { key: "rz-lyrics", category: "Search", method: "GET", path: "/api/search/lyrics", desc: "Cari lirik lagu", params: ["query"], base: RYZUMI_BASE },
  { key: "rz-mahasiswa", category: "Search", method: "GET", path: "/api/search/mahasiswa", desc: "Cari data mahasiswa (PDDIKTI)", params: ["query"], base: RYZUMI_BASE },
  { key: "rz-pinterest", category: "Search", method: "GET", path: "/api/search/pinterest", desc: "Cari gambar di Pinterest", params: ["query"], base: RYZUMI_BASE },
  { key: "rz-pixiv", category: "Search", method: "GET", path: "/api/search/pixiv", desc: "Cari artwork di Pixiv", params: ["query"], base: RYZUMI_BASE },
  { key: "rz-spotify-search", category: "Search", method: "GET", path: "/api/search/spotify", desc: "Cari lagu di Spotify", params: ["query"], base: RYZUMI_BASE },
  { key: "rz-wallpapermoe", category: "Search", method: "GET", path: "/api/search/wallpaper-moe", desc: "Cari wallpaper anime (wallpaper.moe)", params: ["query"], base: RYZUMI_BASE },

  // --- AI / Image tools (sumber: ryzumi.net) ---
  { key: "rz-remini", category: "AI", method: "GET", path: "/api/ai/remini", desc: "Perbesar & perjelas kualitas gambar (Remini)", params: ["url"], base: RYZUMI_BASE },
  { key: "rz-removebg", category: "AI", method: "GET", path: "/api/ai/removebg", desc: "Hapus background gambar otomatis", params: ["url"], base: RYZUMI_BASE },
  { key: "rz-upscaler", category: "AI", method: "GET", path: "/api/ai/upscaler", desc: "Upscale/perbesar resolusi gambar", params: ["url"], base: RYZUMI_BASE },
  { key: "rz-waifu2x", category: "AI", method: "GET", path: "/api/ai/waifu2x", desc: "Upscale gambar anime/artwork (Waifu2x)", params: ["url"], base: RYZUMI_BASE },
  { key: "rz-colorize", category: "AI", method: "GET", path: "/api/ai/colorize", desc: "Warnai gambar hitam-putih otomatis", params: ["url"], base: RYZUMI_BASE },

  // --- Islami (sumber: doa-doa-api-ahmadramadhan.fly.dev + equran.id, keduanya gratis tanpa apikey) ---
  { key: "doa-list", category: "Islami", method: "GET", path: "/api", desc: "Daftar semua doa harian Islami", params: [], base: DOA_BASE },
  { key: "doa-by-id", category: "Islami", method: "GET", path: "/api/{id}", desc: "Detail doa berdasarkan ID", params: ["id"], base: DOA_BASE },
  { key: "doa-by-name", category: "Islami", method: "GET", path: "/api/doa/{doa}", desc: "Cari doa berdasarkan nama (mis. 'sebelum makan')", params: ["doa"], base: DOA_BASE },
  { key: "doa-random", category: "Islami", method: "GET", path: "/api/doa/v1/random", desc: "Ambil doa harian secara acak", params: [], base: DOA_BASE },
  { key: "eq-surat-list", category: "Islami", method: "GET", path: "/surat", desc: "Daftar semua 114 surat Al-Quran", params: [], base: EQURAN_BASE },
  { key: "eq-surat-detail", category: "Islami", method: "GET", path: "/surat/{nomor}", desc: "Detail surat: ayat lengkap + audio 6 qari (nomor 1-114)", params: ["nomor"], base: EQURAN_BASE },
  { key: "eq-tafsir", category: "Islami", method: "GET", path: "/tafsir/{nomor}", desc: "Tafsir lengkap per surat (nomor 1-114)", params: ["nomor"], base: EQURAN_BASE },
  { key: "rz-chatgpt", category: "AI", method: "GET", path: "/api/ai/chatgpt", desc: "Chat dengan ChatGPT", params: ["text", "prompt?", "imageUrl?", "session?"], base: RYZUMI_BASE },
  { key: "rz-deepseek", category: "AI", method: "GET", path: "/api/ai/deepseek", desc: "Chat dengan DeepSeek AI", params: ["text", "prompt?", "session?"], base: RYZUMI_BASE },
  { key: "rz-mistral", category: "AI", method: "GET", path: "/api/ai/mistral", desc: "Chat dengan Mistral AI", params: ["text", "prompt?", "session?"], base: RYZUMI_BASE },
  { key: "rz-qwen", category: "AI", method: "GET", path: "/api/ai/qwen", desc: "Chat dengan QwenLM AI", params: ["text", "prompt?", "session?"], base: RYZUMI_BASE },

  // --- Tools (sumber: ryzumi.net) ---

  // --- Anime (sumber: ryzumi.net, kategori Otakudesu) ---
  { key: "rz-anime-search", category: "Anime", method: "GET", path: "/api/otakudesu/anime", desc: "Cari/list anime (filter status & genre opsional)", params: ["type?(ongoing/complete)", "genre?", "search?", "page?"], base: RYZUMI_BASE },
  { key: "rz-anime-info", category: "Anime", method: "GET", path: "/api/otakudesu/anime-info", desc: "Detail info anime", params: ["slug"], base: RYZUMI_BASE },
  { key: "rz-anime-episode", category: "Anime", method: "GET", path: "/api/otakudesu/anime/episode", desc: "Link streaming per episode anime", params: ["slug"], base: RYZUMI_BASE },
  { key: "rz-anime-batch", category: "Anime", method: "GET", path: "/api/otakudesu/download/batch", desc: "Link download batch anime", params: ["slug"], base: RYZUMI_BASE },
  { key: "rz-anime-genre", category: "Anime", method: "GET", path: "/api/otakudesu/genre", desc: "Daftar genre anime", params: [], base: RYZUMI_BASE },
  { key: "rz-anime-iframe", category: "Anime", method: "GET", path: "/api/otakudesu/get-iframe", desc: "Ambil URL iframe streaming", params: ["content", "nonce"], base: RYZUMI_BASE },
  { key: "rz-anime-jadwal", category: "Anime", method: "GET", path: "/api/otakudesu/jadwal", desc: "Jadwal rilis anime mingguan", params: [], base: RYZUMI_BASE },
  { key: "rz-anime-nonce", category: "Anime", method: "GET", path: "/api/otakudesu/nonce", desc: "Ambil nonce untuk aksi streaming", params: [], base: RYZUMI_BASE },

  // --- Anime batch baru (dari app.siputzx.my.id, base default = SIPUTZX_BASE) ---
  { key: "sp-animequotes", category: "Anime", method: "GET", path: "/api/s/animequotes", desc: "Cari quotes anime dari Otakotaku berdasarkan keyword/karakter/judul", params: ["query"] },
  { key: "sp-auratail-search", category: "Anime", method: "GET", path: "/api/anime/auratail-search", desc: "Cari anime di Auratail", params: ["query"] },
  { key: "sp-auratail-latest", category: "Anime", method: "GET", path: "/api/anime/auratail-latest", desc: "Update anime terbaru dari Auratail", params: [] },
  { key: "sp-auratail-schedule", category: "Anime", method: "GET", path: "/api/anime/auratail-schedule", desc: "Jadwal anime mingguan dari Auratail", params: [] },
  { key: "sp-auratail-detail", category: "Anime", method: "GET", path: "/api/anime/auratail-detail", desc: "Detail anime dari Auratail", params: ["url"] },
  { key: "sp-otakudesu-search", category: "Anime", method: "GET", path: "/api/anime/otakudesu/search", desc: "Cari anime di Otakudesu", params: ["s"] },
  { key: "sp-otakudesu-download", category: "Anime", method: "GET", path: "/api/anime/otakudesu/download", desc: "Link download episode anime Otakudesu", params: ["url"] },
  { key: "sp-otakudesu-detail", category: "Anime", method: "GET", path: "/api/anime/otakudesu/detail", desc: "Detail lengkap + daftar episode anime Otakudesu", params: ["url"] },
  { key: "sp-anichin-episode", category: "Anime", method: "GET", path: "/api/anime/anichin-episode", desc: "Daftar episode anime dari Anichin", params: ["url"] },
  { key: "sp-anichin-search", category: "Anime", method: "GET", path: "/api/anime/anichin-search", desc: "Cari anime di Anichin", params: ["query"] },
  { key: "sp-anichin-download", category: "Anime", method: "GET", path: "/api/anime/anichin-download", desc: "Link download berbagai resolusi dari halaman detail Anichin", params: ["url"] },
  { key: "sp-anichin-latest", category: "Anime", method: "GET", path: "/api/anime/anichin-latest", desc: "Update anime terbaru dari Anichin", params: [] },
  { key: "sp-anichin-popular", category: "Anime", method: "GET", path: "/api/anime/anichin-popular", desc: "Daftar anime populer dari Anichin", params: [] },
  { key: "sp-anichin-detail", category: "Anime", method: "GET", path: "/api/anime/anichin-detail", desc: "Detail anime dari Anichin", params: ["url"] },
  { key: "sp-oploverz-episode", category: "Anime", method: "GET", path: "/api/anime/oploverz-episode", desc: "Detail & daftar episode anime dari Oploverz", params: ["url"] },
  { key: "sp-oploverz-search", category: "Anime", method: "GET", path: "/api/anime/oploverz-search", desc: "Cari anime di Oploverz", params: ["query"] },
  { key: "sp-oploverz-ongoing", category: "Anime", method: "GET", path: "/api/anime/oploverz-ongoing", desc: "Daftar anime ongoing dari Oploverz", params: [] },
  { key: "sp-komikindo-detail", category: "Anime", method: "GET", path: "/api/anime/komikindo-detail", desc: "Detail komik/manga dari Komikindo", params: ["url"] },
  { key: "sp-komikindo-download", category: "Anime", method: "GET", path: "/api/anime/komikindo-download", desc: "Link download semua gambar chapter komik dari Komikindo", params: ["url"] },
  { key: "sp-samehadaku-search", category: "Anime", method: "GET", path: "/api/anime/samehadaku/search", desc: "Cari anime di Samehadaku (hasil detail)", params: ["query"] },
  { key: "sp-samehadaku-download", category: "Anime", method: "GET", path: "/api/anime/samehadaku/download", desc: "Link download episode anime dari Samehadaku", params: ["url"] },
  { key: "sp-samehadaku-latest", category: "Anime", method: "GET", path: "/api/anime/samehadaku/latest", desc: "Episode anime terbaru rilis dari Samehadaku", params: [] },
  { key: "sp-samehadaku-release", category: "Anime", method: "GET", path: "/api/anime/samehadaku/release", desc: "Jadwal rilis anime mingguan dari Samehadaku (per hari)", params: [] },
  { key: "sp-samehadaku-detail", category: "Anime", method: "GET", path: "/api/anime/samehadaku/detail", desc: "Detail & daftar episode anime dari Samehadaku", params: ["link"] },

  // --- Games (dari app.siputzx.my.id, base default = SIPUTZX_BASE) ---
  { key: "sp-susunkata", category: "Games", method: "GET", path: "/api/games/susunkata", desc: "Puzzle 'Susun Kata' (susun huruf jadi kata) acak", params: [] },
  { key: "sp-tebakwarna", category: "Games", method: "GET", path: "/api/games/tebakwarna", desc: "Kuis tebak warna acak", params: [] },
  { key: "sp-tebaklagu", category: "Games", method: "GET", path: "/api/games/tebaklagu", desc: "Kuis tebak lagu dari cuplikan audio", params: [] },
  { key: "sp-asahotak", category: "Games", method: "GET", path: "/api/games/asahotak", desc: "Pertanyaan asah otak (brain teaser) acak", params: [] },
  { key: "sp-tebaklirik", category: "Games", method: "GET", path: "/api/games/tebaklirik", desc: "Kuis tebak lirik lagu acak", params: [] },
  { key: "sp-maths", category: "Games", method: "GET", path: "/api/games/maths", desc: "Soal matematika acak", params: [] },

  // --- Canvas (image generator/effect, dari app.siputzx.my.id, base default = SIPUTZX_BASE) ---
  // Catatan: 2 endpoint canvas TIDAK didaftarkan secara sengaja karena berpotensi
  // disalahgunakan: "canvas/xnxx" & "canvas/fake-xnxx" (generate gambar palsu
  // situs porno dengan judul/foto bebas -> bisa dipakai memfitnah/mempermalukan
  // orang) dan "canvas/ektp" (generator KTP palsu -> rawan pemalsuan dokumen).
  { key: "sp-welcomev1", category: "Canvas", method: "GET", path: "/api/canvas/welcomev1", desc: "Generate gambar welcome (v1) via parameter", params: ["username", "guildname", "guildicon", "membercount", "avatar", "background", "quality?"] },
  { key: "sp-welcomev3", category: "Canvas", method: "GET", path: "/api/canvas/welcomev3", desc: "Generate gambar welcome (v3) via parameter", params: [] },
  { key: "sp-welcomev4", category: "Canvas", method: "GET", path: "/api/canvas/welcomev4", desc: "Generate gambar welcome (v4) via parameter", params: [] },
  { key: "sp-goodbyev1", category: "Canvas", method: "GET", path: "/api/canvas/goodbyev1", desc: "Generate gambar goodbye (v1) via parameter", params: ["username", "guildname", "guildicon", "membercount", "avatar", "background", "quality?"] },
  { key: "sp-goodbyev3", category: "Canvas", method: "GET", path: "/api/canvas/goodbyev3", desc: "Generate gambar goodbye (v3) via parameter", params: [] },
  { key: "sp-goodbyev4", category: "Canvas", method: "GET", path: "/api/canvas/goodbyev4", desc: "Generate gambar goodbye (v4) via parameter", params: [] },
  { key: "sp-goodbyev5", category: "Canvas", method: "GET", path: "/api/canvas/goodbyev5", desc: "Generate gambar goodbye (v5) via parameter", params: [] },
  { key: "sp-captcha", category: "Canvas", method: "GET", path: "/api/canvas/captcha", desc: "Generate gambar captcha dengan background URL", params: ["background", "captchakey?", "border?", "overlayopacity?"] },
  { key: "sp-profile", category: "Canvas", method: "GET", path: "/api/canvas/profile", desc: "Generate kartu profil via parameter", params: ["backgroundurl", "avatarurl", "rankname", "rankid", "exp", "requireexp", "level"] },
  { key: "sp-security", category: "Canvas", method: "GET", path: "/api/canvas/security", desc: "Generate kartu 'security suspect' via parameter", params: ["avatar", "background", "createdtimestamp", "suspecttimestamp", "locale"] },
  { key: "sp-sertifikat-tolol", category: "Canvas", method: "GET", path: "/api/canvas/sertifikat-tolol", desc: "Generate gambar 'sertifikat tolol' (meme)", params: [] },
  { key: "sp-facepalm", category: "Canvas", method: "GET", path: "/api/canvas/facepalm", desc: "Generate gambar meme facepalm dari foto", params: ["image"] },
  { key: "sp-ship", category: "Canvas", method: "GET", path: "/api/canvas/ship", desc: "Generate gambar 'ship' (jodoh-jodohan) dari dua foto", params: ["image1", "image2"] },
  { key: "sp-batslap", category: "Canvas", method: "GET", path: "/api/canvas/batslap", desc: "Generate meme Batman slap dari dua foto", params: ["image1", "image2"] },
  { key: "sp-greyscale", category: "Canvas", method: "GET", path: "/api/canvas/greyscale", desc: "Efek greyscale (hitam-putih) pada gambar dari URL", params: ["image"] },
  { key: "sp-darkness", category: "Canvas", method: "GET", path: "/api/canvas/darkness", desc: "Efek gelap (darkness) pada gambar dari URL", params: ["image", "amount?"] },
  { key: "sp-blur", category: "Canvas", method: "GET", path: "/api/canvas/blur", desc: "Efek blur pada gambar dari URL", params: ["image"] },
  { key: "sp-invert", category: "Canvas", method: "GET", path: "/api/canvas/invert", desc: "Efek invert warna pada gambar dari URL", params: ["image"] },
  { key: "sp-circle", category: "Canvas", method: "GET", path: "/api/canvas/circle", desc: "Crop gambar jadi bentuk lingkaran dari URL", params: ["image"] },
  { key: "sp-affect", category: "Canvas", method: "GET", path: "/api/canvas/affect", desc: "Generate meme 'affect' dari foto", params: ["image"] },
  { key: "sp-beautiful", category: "Canvas", method: "GET", path: "/api/canvas/beautiful", desc: "Efek 'beautiful' pada gambar dari URL", params: ["image"] },
  { key: "sp-kiss", category: "Canvas", method: "GET", path: "/api/canvas/kiss", desc: "Generate gambar kiss dari dua foto", params: ["image1", "image2"] },
  { key: "sp-spotify-card", category: "Canvas", method: "GET", path: "/api/canvas/spotify", desc: "Generate kartu 'now playing' bergaya Spotify", params: [] },
  { key: "sp-level-up", category: "Canvas", method: "GET", path: "/api/canvas/level-up", desc: "Generate kartu level up", params: [] },
];


// ------------------------------------------------------------------
// 2c. REGISTRY - NEXRAY (api.nexray.eu.cc) - kategori Downloader, 42 endpoint
//     100% GRATIS, TANPA APIKEY sama sekali (dikonfirmasi di halaman resmi:
//     "Free Forever - No API Key Required"). Semua method GET.
// ------------------------------------------------------------------
const NEXRAY_ENDPOINTS = [
  { key: "aio", category: "Downloader", method: "GET", path: "/downloader/aio", desc: "All-in-One — download video dari berbagai platform sosmed", params: ["url"] },
  { key: "applemusic", category: "Downloader", method: "GET", path: "/downloader/applemusic", desc: "Download lagu dari Apple Music", params: ["url"] },
  { key: "bilibili", category: "Downloader", method: "GET", path: "/downloader/bilibili", desc: "Download video dan audio dari Bilibili", params: ["url"] },
  { key: "capcut", category: "Downloader", method: "GET", path: "/downloader/capcut", desc: "Download video/template dari CapCut", params: ["url"] },
  { key: "capcut-v1", category: "Downloader", method: "GET", path: "/downloader/v1/capcut", desc: "Download video/template dari CapCut (v1)", params: ["url"] },
  { key: "cocofun", category: "Downloader", method: "GET", path: "/downloader/cocofun", desc: "Download video dari Cocofun", params: ["url"] },
  { key: "douyin", category: "Downloader", method: "GET", path: "/downloader/douyin", desc: "Download video dari Douyin", params: ["url"] },
  { key: "douyin-v1", category: "Downloader", method: "GET", path: "/downloader/v1/douyin", desc: "Download video dari Douyin (v1)", params: ["url"] },
  { key: "facebook", category: "Downloader", method: "GET", path: "/downloader/facebook", desc: "Download video dari Facebook", params: ["url"] },
  { key: "github", category: "Downloader", method: "GET", path: "/downloader/github", desc: "Download repositori GitHub", params: ["url"] },
  { key: "googledrive", category: "Downloader", method: "GET", path: "/downloader/googledrive", desc: "Download file dari Google Drive", params: ["url"] },
  { key: "instagram", category: "Downloader", method: "GET", path: "/downloader/instagram", desc: "Download video/foto dari Instagram", params: ["url"] },
  { key: "instagram-v1", category: "Downloader", method: "GET", path: "/downloader/v1/instagram", desc: "Download media dari Instagram (v1)", params: ["url"] },
  { key: "instagram-v2", category: "Downloader", method: "GET", path: "/downloader/v2/instagram", desc: "Download media dari Instagram (v2)", params: ["url"] },
  { key: "krakenfiles", category: "Downloader", method: "GET", path: "/downloader/krakenfiles", desc: "Download media dari KrakenFiles", params: ["url"] },
  { key: "likee", category: "Downloader", method: "GET", path: "/downloader/likee", desc: "Download video dari Likee", params: ["url"] },
  { key: "mediafire", category: "Downloader", method: "GET", path: "/downloader/mediafire", desc: "Download file dari MediaFire dengan metadata", params: ["url"] },
  { key: "mega", category: "Downloader", method: "GET", path: "/downloader/mega", desc: "Download file dari MEGA.nz dengan metadata lengkap", params: ["url"] },
  { key: "npm", category: "Downloader", method: "GET", path: "/downloader/npm", desc: "Ambil informasi package NPM", params: ["q"] },
  { key: "pinterest", category: "Downloader", method: "GET", path: "/downloader/pinterest", desc: "Download video/foto dari Pinterest", params: ["url"] },
  { key: "rednote", category: "Downloader", method: "GET", path: "/downloader/rednote", desc: "Download media dari Rednote (Xiaohongshu)", params: ["url"] },
  { key: "savetube", category: "Downloader", method: "GET", path: "/downloader/savetube", desc: "Download video/audio YouTube via SaveTube", params: ["url", "quality?(mp3/144/240/360/480/720/1080, default:mp3)"] },
  { key: "scribd", category: "Downloader", method: "GET", path: "/downloader/scribd", desc: "Download file dari Scribd", params: ["url"] },
  { key: "sfile", category: "Downloader", method: "GET", path: "/downloader/sfile", desc: "Download file dari SFile", params: ["url"] },
  { key: "smule", category: "Downloader", method: "GET", path: "/downloader/smule", desc: "Download rekaman audio dari Smule", params: ["url"] },
  { key: "snackvideo", category: "Downloader", method: "GET", path: "/downloader/snackvideo", desc: "Download video dari SnackVideo dengan metadata lengkap", params: ["url"] },
  { key: "soundcloud", category: "Downloader", method: "GET", path: "/downloader/soundcloud", desc: "Download audio dari SoundCloud", params: ["url"] },
  { key: "spotify", category: "Downloader", method: "GET", path: "/downloader/spotify", desc: "Download audio dari Spotify", params: ["url"] },
  { key: "spotifyplay", category: "Downloader", method: "GET", path: "/downloader/spotifyplay", desc: "Cari & download audio MP3 dari Spotify berdasarkan judul", params: ["q"] },
  { key: "spotify-v1", category: "Downloader", method: "GET", path: "/downloader/v1/spotify", desc: "Download audio dari Spotify, support playlist (v1)", params: ["url"] },
  { key: "terabox", category: "Downloader", method: "GET", path: "/downloader/terabox", desc: "Download video dari Terabox", params: ["url"] },
  { key: "threads", category: "Downloader", method: "GET", path: "/downloader/threads", desc: "Download konten dari Threads", params: ["url"] },
  { key: "tiktok", category: "Downloader", method: "GET", path: "/downloader/tiktok", desc: "Download video/foto dari TikTok", params: ["url"] },
  { key: "twitter", category: "Downloader", method: "GET", path: "/downloader/twitter", desc: "Download video/gambar dari Twitter (X), bisa juga convert ke MP3", params: ["url"] },
  { key: "videy", category: "Downloader", method: "GET", path: "/downloader/videy", desc: "Download video dari Videy.co", params: ["url"] },
  { key: "webmusic", category: "Downloader", method: "GET", path: "/downloader/webmusic", desc: "Ambil link download dari WebMusic", params: ["url"] },
  { key: "ytmp3", category: "Downloader", method: "GET", path: "/downloader/ytmp3", desc: "Download MP3 dari YouTube", params: ["url"] },
  { key: "ytmp3-v1", category: "Downloader", method: "GET", path: "/downloader/v1/ytmp3", desc: "Download MP3 dari YouTube (v1)", params: ["url"] },
  { key: "ytmp4", category: "Downloader", method: "GET", path: "/downloader/ytmp4", desc: "Download video MP4 dari YouTube", params: ["url", "resolusi?(2160/1440/1080/720/480/360, default:360)"] },
  { key: "ytmp4-v1", category: "Downloader", method: "GET", path: "/downloader/v1/ytmp4", desc: "Download video MP4 dari YouTube (v1)", params: ["url", "resolusi?(1080/720/480/360/240/144, default:360)"] },
  { key: "ytplay", category: "Downloader", method: "GET", path: "/downloader/ytplay", desc: "Cari & download MP3 dari YouTube berdasarkan judul", params: ["q"] },
  { key: "ytplayvid", category: "Downloader", method: "GET", path: "/downloader/ytplayvid", desc: "Cari & download video MP4 dari YouTube berdasarkan judul", params: ["q"] },

  // --- AI (22 endpoint, batch ke-2 — sumber: https://api.nexray.eu.cc/category/ai) ---
  { key: "alisia", category: "AI", method: "GET", path: "/ai/alisia", desc: "Chat dengan Alisia AI", params: ["text"] },
  { key: "andisearch", category: "AI", method: "GET", path: "/ai/andisearch", desc: "Chat dengan Andisearch AI", params: ["text"] },
  { key: "bypass-ai", category: "AI", method: "GET", path: "/ai/bypass", desc: "Bypass AI Detector / humanize teks", params: ["text"] },
  { key: "chatgpt-nx", category: "AI", method: "GET", path: "/ai/chatgpt", desc: "Chat dengan ChatGPT", params: ["text"] },
  { key: "claude-nx", category: "AI", method: "GET", path: "/ai/claude", desc: "Chat dengan Claude AI", params: ["text"] },
  { key: "copilot", category: "AI", method: "GET", path: "/ai/copilot", desc: "Chat dengan Copilot AI", params: ["text"] },
  { key: "deepimg", category: "AI", method: "GET", path: "/ai/deepimg", desc: "Generate gambar menggunakan DeepImg AI", params: ["prompt"] },
  { key: "deepsearch", category: "AI", method: "GET", path: "/ai/deepsearch", desc: "Deep search dengan AI research assistant", params: ["text"] },
  { key: "deepseek-nx", category: "AI", method: "GET", path: "/ai/deepseek", desc: "Chat dengan DeepSeek", params: ["text"] },
  { key: "dgaf", category: "AI", method: "GET", path: "/ai/dgaf", desc: "Chat dengan Dgaf AI", params: ["text"] },
  { key: "dolphin", category: "AI", method: "GET", path: "/ai/dolphin", desc: "Chat dengan Dolphin AI dengan pilihan template", params: ["text", "template?(default:logical)"] },
  { key: "dracin-tts", category: "AI", method: "GET", path: "/ai/dracin-tts", desc: "Membuat suara Dracin TTS", params: ["text", "speed?(default:1.0)", "volume?(default:0.3)", "music?(default:true)"] },
  { key: "dreamanalyze", category: "AI", method: "GET", path: "/ai/dreamanalyze", desc: "Analisis mimpi dengan AI", params: ["text"] },
  { key: "duck", category: "AI", method: "GET", path: "/ai/duck", desc: "Chat dengan Duck AI", params: ["text", "model?(default:claude-haiku-4-5)"] },
  { key: "epsilon", category: "AI", method: "GET", path: "/ai/epsilon", desc: "Cari paper akademik dengan Epsilon AI", params: ["text"] },
  { key: "felo", category: "AI", method: "GET", path: "/ai/felo", desc: "Chat dengan Felo AI", params: ["text"] },
  { key: "flux-v1-nx", category: "AI", method: "GET", path: "/ai/v1/flux", desc: "Generate gambar menggunakan Flux AI v1", params: ["prompt"] },
  { key: "gemini-tts", category: "AI", method: "GET", path: "/ai/gemini-tts", desc: "Buat suara/pembicaraan menggunakan Gemini TTS", params: ["text"] },
  { key: "gitagpt", category: "AI", method: "GET", path: "/ai/gitagpt", desc: "Tanya jawab dengan GitaGPT", params: ["text"] },
  { key: "gpt-35-turbo", category: "AI", method: "GET", path: "/ai/gpt-3.5-turbo", desc: "Chat dengan GPT-3.5 Turbo", params: ["text"] },
  { key: "image2prompt", category: "AI", method: "GET", path: "/ai/image2prompt", desc: "Generate prompt teks dari sebuah gambar", params: ["url"] },
  { key: "gptimage", category: "AI", method: "POST", path: "/ai/gptimage", desc: "Edit gambar pakai GPT Vision sesuai prompt (upload file)", params: ["image(file)", "param(prompt)"] },
  { key: "islamcity", category: "AI", method: "GET", path: "/ai/islamcity", desc: "Chat dengan IslamCity AI tentang keislaman", params: ["text"] },
  { key: "muslim-nx", category: "AI", method: "GET", path: "/ai/muslim", desc: "Chat dengan AI tentang Islam", params: ["text"] },
  { key: "text2image-v1", category: "AI", method: "GET", path: "/ai/v1/text2image", desc: "Generate gambar dari prompt teks", params: ["prompt"] },

  // --- Tools (batch ke-3, dari kategori "Tools" Nexray) ---
  { key: "blurface", category: "Tools", method: "GET", path: "/tools/blurface", desc: "Membuat blur pada wajah dalam gambar", params: ["url"] },
  { key: "hdvideo-nx", category: "Tools", method: "GET", path: "/tools/hdvideo", desc: "Enhance kualitas video ke HD", params: ["url"] },
  { key: "hdvideo-v1-nx", category: "Tools", method: "GET", path: "/tools/v1/hdvideo", desc: "Upscale video ke resolusi HD/Full HD/2K/4K", params: ["url", "resolusi?(default:hd)"] },
  { key: "remini-nx", category: "Tools", method: "GET", path: "/tools/remini", desc: "Ubah gambar agar lebih jernih dan HD (Remini)", params: ["url"] },
  { key: "removebg-nx", category: "Tools", method: "GET", path: "/tools/removebg", desc: "Hapus background dari gambar dengan rapi", params: ["url"] },
  { key: "removebg-v1-nx", category: "Tools", method: "GET", path: "/tools/v1/removebg", desc: "Hapus background dari gambar (v1)", params: ["url"] },
  { key: "removebg-v2-nx", category: "Tools", method: "GET", path: "/tools/v2/removebg", desc: "Hapus background dari gambar (v2)", params: ["url"] },
  { key: "unblur", category: "Tools", method: "GET", path: "/tools/unblur", desc: "Menghilangkan blur pada gambar pakai AI", params: ["url"] },
  { key: "vcc", category: "Tools", method: "GET", path: "/tools/vcc", desc: "Generate nomor kartu kredit virtual (VCC)", params: ["type?(mastercard/visa, default:mastercard)"] },
  { key: "virtual-number", category: "Tools", method: "GET", path: "/tools/virtual-number", desc: "Dapatkan daftar nomor virtual/OTP berdasarkan nomor tertentu", params: ["number?"] },
  { key: "virtual-number-v1", category: "Tools", method: "GET", path: "/tools/v1/virtual-number", desc: "Dapatkan daftar nomor virtual/OTP (v1, by country_id & number_id)", params: ["country_id", "number_id"] },

  // --- Anime ---
  { key: "anichin-detail", category: "Anime", method: "GET", path: "/anime/anichin/detail", desc: "Detail anime dari Anichin (episode, batch download, metadata)", params: ["url"] },
  { key: "anichin-genre", category: "Anime", method: "GET", path: "/anime/anichin/genre", desc: "Daftar anime Anichin difilter berdasarkan genre", params: ["slug", "page?(default:1)"] },
  { key: "anichin-genres", category: "Anime", method: "GET", path: "/anime/anichin/genres", desc: "Daftar semua genre yang tersedia di Anichin", params: [] },
  { key: "anichin-home", category: "Anime", method: "GET", path: "/anime/anichin/home", desc: "Slider unggulan, populer hari ini, rilisan terbaru, dan ongoing dari Anichin", params: [] },
  { key: "anichin-schedule", category: "Anime", method: "GET", path: "/anime/anichin/schedule", desc: "Jadwal rilis anime per hari dari Anichin", params: [] },
  { key: "anichin-search", category: "Anime", method: "GET", path: "/anime/anichin/search", desc: "Cari anime di Anichin berdasarkan kata kunci", params: ["q", "page?(default:1)"] },
  { key: "anichin-stream", category: "Anime", method: "GET", path: "/anime/anichin/stream", desc: "Link streaming & download untuk sebuah episode Anichin", params: ["url"] },
  { key: "komiku-chapter", category: "Anime", method: "GET", path: "/anime/komiku/chapter", desc: "Ambil semua gambar dari satu chapter manga Komiku", params: ["url"] },
  { key: "komiku-detail", category: "Anime", method: "GET", path: "/anime/komiku/detail", desc: "Detail manga Komiku (chapter, genre, metadata)", params: ["url"] },
  { key: "komiku-home", category: "Anime", method: "GET", path: "/anime/komiku/home", desc: "Update manga terbaru dari homepage Komiku", params: [] },
  { key: "komiku-popular", category: "Anime", method: "GET", path: "/anime/komiku/popular", desc: "Daftar manga populer dari Komiku", params: ["page?(default:1)"] },
  { key: "komiku-search", category: "Anime", method: "GET", path: "/anime/komiku/search", desc: "Cari manga di Komiku berdasarkan kata kunci", params: ["q"] },
  { key: "samehadaku-detail", category: "Anime", method: "GET", path: "/anime/samehadaku/detail", desc: "Detail anime Samehadaku (episode & rekomendasi)", params: ["url"] },
  { key: "samehadaku-embed", category: "Anime", method: "GET", path: "/anime/samehadaku/embed", desc: "Ambil URL embed video player Samehadaku", params: ["post", "nume", "type", "url?"] },
  { key: "samehadaku-home", category: "Anime", method: "GET", path: "/anime/samehadaku/home", desc: "Top 10 mingguan, update terbaru, dan project movie dari Samehadaku", params: [] },
  { key: "samehadaku-page", category: "Anime", method: "GET", path: "/anime/samehadaku/page", desc: "Daftar semua anime Samehadaku (berhalaman)", params: ["page?(default:1)"] },
  { key: "samehadaku-schedule", category: "Anime", method: "GET", path: "/anime/samehadaku/schedule", desc: "Jadwal rilis anime mingguan Samehadaku (Senin-Minggu)", params: [] },
  { key: "samehadaku-search", category: "Anime", method: "GET", path: "/anime/samehadaku/search", desc: "Cari anime di Samehadaku berdasarkan kata kunci", params: ["q"] },
  { key: "samehadaku-stream", category: "Anime", method: "GET", path: "/anime/samehadaku/stream", desc: "Link streaming & opsi download untuk sebuah episode Samehadaku", params: ["url"] },

  // --- Ephoto (filter/efek foto, sumber: api.nexray.eu.cc/ephoto) ---
  { key: "ephoto-anime", category: "Tools", method: "GET", path: "/ephoto/anime", desc: "Ubah foto jadi gaya anime", params: ["url"] },
  { key: "ephoto-art", category: "Tools", method: "GET", path: "/ephoto/art", desc: "Ubah foto jadi gaya art/lukisan", params: ["url"] },
  { key: "ephoto-ascii", category: "Tools", method: "GET", path: "/ephoto/asci", desc: "Ubah gambar jadi ASCII art", params: ["url"] },
  { key: "ephoto-borealis", category: "Tools", method: "GET", path: "/ephoto/borealis", desc: "Ubah foto jadi gaya borealis (aurora)", params: ["url"] },
  { key: "ephoto-botak", category: "Tools", method: "GET", path: "/ephoto/botak", desc: "Ubah foto jadi gaya botak (meme)", params: ["url"] },
  { key: "ephoto-bravegreen", category: "Tools", method: "GET", path: "/ephoto/bravegreen", desc: "Terapkan filter duotone hijau-pink ke gambar", params: ["url"] },
  { key: "ephoto-chibi", category: "Tools", method: "GET", path: "/ephoto/chibi", desc: "Ubah foto jadi gaya chibi", params: ["url"] },
  { key: "ephoto-cinematic", category: "Tools", method: "GET", path: "/ephoto/cinematic", desc: "Ubah foto jadi gaya cinematic", params: ["url"] },
  { key: "ephoto-comic", category: "Tools", method: "GET", path: "/ephoto/comic", desc: "Ubah foto jadi gaya komik", params: ["url"] },
  { key: "ephoto-figure-v1", category: "Tools", method: "GET", path: "/ephoto/v1/figure", desc: "Ubah foto jadi gaya figure/action figure (v1)", params: ["url"] },
  { key: "ephoto-figure-v2", category: "Tools", method: "GET", path: "/ephoto/v2/figure", desc: "Ubah foto jadi gaya figure/action figure (v2)", params: ["url"] },
  { key: "ephoto-ghibli", category: "Tools", method: "GET", path: "/ephoto/ghibli", desc: "Ubah foto jadi gaya Studio Ghibli", params: ["url"] },
  // Catatan: "ephoto/hitam" (ubah warna kulit jadi hitam pekat) SENGAJA TIDAK
  // didaftarkan karena berpotensi disalahgunakan buat konten rasis/mengejek
  // (digital blackface).
  { key: "ephoto-luminare", category: "Tools", method: "GET", path: "/ephoto/luminare", desc: "Artwork musim dingin 3-panel sinematik dengan lentera", params: ["url"] },
  { key: "ephoto-mafia", category: "Tools", method: "GET", path: "/ephoto/mafia", desc: "Ubah foto jadi gaya mafia", params: ["url"] },
  { key: "ephoto-mirror", category: "Tools", method: "GET", path: "/ephoto/mirror", desc: "Ubah foto jadi mirror selfie profesional (aesthetic iPhone 17 Pro Max)", params: ["url"] },
  { key: "ephoto-monochrome", category: "Tools", method: "GET", path: "/ephoto/monochrome", desc: "Ubah foto jadi gaya monokrom", params: ["url"] },
  { key: "ephoto-mountain", category: "Tools", method: "GET", path: "/ephoto/mountain", desc: "Ubah foto jadi gaya hiking gunung", params: ["url"] },
  { key: "ephoto-nft", category: "Tools", method: "GET", path: "/ephoto/nft", desc: "Ubah foto jadi gaya pixel-art NFT", params: ["url"] },
  { key: "ephoto-playlist", category: "Tools", method: "GET", path: "/ephoto/playlist", desc: "Ubah foto jadi gaya cover playlist Spotify", params: ["url"] },
  { key: "ephoto-qin", category: "Tools", method: "GET", path: "/ephoto/qin", desc: "Ubah foto jadi gaya qin", params: ["url"] },
  { key: "ephoto-real", category: "Tools", method: "GET", path: "/ephoto/real", desc: "Ubah foto jadi gaya manusia realistis", params: ["url"] },
  { key: "ephoto-statue", category: "Tools", method: "GET", path: "/ephoto/statue", desc: "Ubah foto jadi gaya patung raksasa", params: ["url"] },
  { key: "ephoto-street", category: "Tools", method: "GET", path: "/ephoto/street", desc: "Ubah foto jadi gaya street art graffiti", params: ["url"] },
];

// ------------------------------------------------------------------
// 2d. REGISTRY - API BY FAA (api-faa.my.id) - 5 endpoint, gratis TANPA apikey
// ------------------------------------------------------------------
const FAA_ENDPOINTS = [
  { key: "faa-superhd", category: "AI HD", method: "GET", path: "/faa/superhd", desc: "Tingkatkan kualitas gambar secara otomatis ke HD", params: ["url"] },
  { key: "faa-hdv2", category: "AI HD", method: "GET", path: "/faa/hdv2", desc: "Tingkatkan kualitas gambar pakai teknologi Remini (cocok utk gambar blur)", params: ["url"] },
  { key: "faa-hdv3", category: "AI HD", method: "GET", path: "/faa/hdv3", desc: "Perbesar gambar otomatis pakai AI skala 4x", params: ["image"] },
  { key: "faa-hdv4", category: "AI HD", method: "GET", path: "/faa/hdv4", desc: "Perbesar & tingkatkan kualitas gambar pakai AI", params: ["image"] },
  { key: "faa-trackip", category: "Tools", method: "GET", path: "/faa/track-ip", desc: "Lacak informasi detail dari sebuah alamat IP", params: ["ip"] },
  { key: "faa-doa", category: "Islami", method: "GET", path: "/faa/doa", desc: "Cari doa harian Islam berdasarkan kata kunci, lengkap ayat, latin, dan artinya", params: ["q"] },
  { key: "faa-free-proxy", category: "Tools", method: "GET", path: "/faa/free-proxy", desc: "Dapatkan 1 proxy HTTP gratis yang sudah dicek dan dipastikan hidup", params: [] },
  { key: "faa-jadwalsholat", category: "Islami", method: "GET", path: "/faa/jadwal-sholat", desc: "Jadwal sholat harian berdasarkan nama kota", params: ["kota"] },
];

// ------------------------------------------------------------------
// 2e. REGISTRY - AlwaysCodex API (api.alwayscodex.eu.cc) - 20 endpoint, gratis TANPA apikey
// ------------------------------------------------------------------
const ALWAYSCODEX_ENDPOINTS = [
  { key: "ac-encrypt", category: "Tools", method: "GET", path: "/api/tools/encrypt", desc: "Convert teks pakai berbagai metode enkripsi (tanpa key)", params: ["text", "mode?(encrypt/decrypt, default:encrypt)", "method?(base64/dll, default:base64)"] },
  { key: "ac-tempmail", category: "Tools", method: "GET", path: "/api/tempmail/multidomain", desc: "Email sementara (create/inbox/delete), 17+ pilihan domain, expired 1 hari", params: ["action", "domain?", "email?"] },
  { key: "ac-checknumber-simdopul", category: "Tools", method: "GET", path: "/api/checknumber/simdopul", desc: "Cek info nomor XL/AXIS (auto detect provider)", params: ["nomor"] },
  { key: "ac-checknumber-tricheck", category: "Tools", method: "GET", path: "/api/checknumber/tricheck", desc: "Cek info nomor kartu Tri", params: ["number"] },
  { key: "ac-checknumber-xlcheck", category: "Tools", method: "GET", path: "/api/checknumber/xlcheck", desc: "Cek info nomor kartu XL/Axis — paket, kuota, masa aktif", params: ["number"] },
  { key: "ac-asahotak", category: "Games", method: "GET", path: "/api/games/asahotak", desc: "Pertanyaan asah otak (brain teaser) acak", params: [] },
  { key: "ac-caklontong", category: "Games", method: "GET", path: "/api/games/caklontong", desc: "Pertanyaan Cak Lontong acak dengan jawaban jebakan", params: [] },
  { key: "ac-ccsd", category: "Games", method: "GET", path: "/api/games/cc-sd", desc: "Kuis mata pelajaran SD acak", params: ["matapelajaran", "jumlahsoal?(default:5)"] },
  { key: "ac-family100", category: "Games", method: "GET", path: "/api/games/family100", desc: "Pertanyaan Family 100 acak lengkap jawaban survei & skor", params: [] },
  { key: "ac-lengkapikalimat", category: "Games", method: "GET", path: "/api/games/lengkapikalimat", desc: "Pertanyaan lengkapi kalimat acak", params: [] },
  { key: "ac-math", category: "Games", method: "GET", path: "/api/games/math", desc: "Soal matematika acak dengan berbagai tingkat kesulitan", params: ["level?"] },
  { key: "ac-tebakan", category: "Games", method: "GET", path: "/api/games/tebakan", desc: "Teka-teki dan lelucon acak", params: [] },
  { key: "ac-tebakbendera", category: "Games", method: "GET", path: "/api/games/tebakbendera", desc: "Kuis tebak bendera negara", params: [] },
  { key: "ac-tebakbendera2", category: "Games", method: "GET", path: "/api/games/tebakbendera2", desc: "Kuis tebak bendera negara (versi alternatif)", params: [] },
  { key: "ac-tebakgambar", category: "Games", method: "GET", path: "/api/games/tebakgambar", desc: "Teka-teki gambar acak", params: [] },
  { key: "ac-tebakgame", category: "Games", method: "GET", path: "/api/games/tebakgame", desc: "Tebak nama video game acak", params: [] },
  { key: "ac-tebakheroml", category: "Games", method: "GET", path: "/api/games/tebakheroml", desc: "Tebak hero Mobile Legends dari audio", params: [] },
  { key: "ac-tebakjkt48", category: "Games", method: "GET", path: "/api/games/tebakjkt48", desc: "Tebak member JKT48 dari foto", params: [] },
  { key: "ac-tebakkabupaten", category: "Games", method: "GET", path: "/api/games/tebakkabupaten", desc: "Kuis tebak nama kabupaten/kota di Indonesia", params: [] },
  { key: "ac-tebakkalimat", category: "Games", method: "GET", path: "/api/games/tebakkalimat", desc: "Teka-teki kalimat acak", params: [] },

  // --- Canvas (batch baru) ---
  // Catatan: "canvas/struk-generator" (generate struk/receipt PDF custom toko+item+
  // pembayaran) SENGAJA TIDAK didaftarkan karena bisa dipakai bikin bukti belanja
  // palsu (penyalahgunaan untuk klaim refund/reimbursement/garansi palsu).
  { key: "ac-youtube-thumbnail", category: "Canvas", method: "GET", path: "/api/canvas/youtube", desc: "Generate thumbnail gaya YouTube dengan cover, judul, dan artis", params: ["title", "artist", "coverurl"] },
  { key: "ac-bratvid-vermeil", category: "Canvas", method: "GET", path: "/api/canvas/bratvid-vermeil", desc: "Generate video Vermeil dengan teks muncul bertahap per kata (support BPM/tempo/timestamps)", params: ["text", "duration?"] },
  { key: "ac-carbon", category: "Canvas", method: "GET", path: "/api/canvas/carbon", desc: "Generate gambar screenshot kode (Carbon) dengan tema/font/bahasa custom", params: ["code", "code_b64?", "theme?", "font?", "language?", "fontSize?", "background?", "lineNumbers?"] },
  { key: "ac-createlogo", category: "Canvas", method: "GET", path: "/api/canvas/createlogo", desc: "Generate logo profesional pakai AI berdasarkan judul, ide, dan slogan", params: ["title", "idea", "slogan"] },
  { key: "ac-roblox", category: "Canvas", method: "GET", path: "/api/canvas/roblox", desc: "Generate kartu profil Roblox otomatis dari username", params: ["username"] },
  { key: "ac-sertifikat-tolol", category: "Canvas", method: "GET", path: "/api/canvas/sertifikat-tolol", desc: "Generate sertifikat tolol dengan nama custom (meme)", params: [] },

  // --- Image AI (generate gambar) ---
  { key: "ac-bingimg", category: "Image AI", method: "GET", path: "/api/imageai/bingimg", desc: "Cari & ambil gambar random dari Bing", params: ["query"] },
  { key: "ac-dezgo", category: "Image AI", method: "GET", path: "/api/imageai/dezgo", desc: "Generate gambar AI via Dezgo.com (20+ model: flux, realdream, grok_imagine, dll)", params: ["text", "model?", "width?", "height?", "negative?"] },
  { key: "ac-pollinations", category: "Image AI", method: "GET", path: "/api/imageai/pollinations", desc: "Generate gambar AI via Pollinations", params: ["prompt"] },
  { key: "ac-quil-image", category: "Image AI", method: "GET", path: "/api/imageai/quil-image", desc: "Generate gambar AI via Quillbot dengan berbagai style dan aspect ratio", params: ["prompt", "style?", "aspect?"] },

  // --- Search ---
  { key: "ac-search-anime", category: "Search", method: "GET", path: "/api/search/anime", desc: "Cari detail anime dari LiveChart.me (title, genre, studio, rating, episode, sinopsis)", params: ["q"] },
  { key: "ac-search-cookpad", category: "Search", method: "GET", path: "/api/search/cookpad", desc: "Cari resep masakan dari Cookpad Indonesia beserta detail lengkap", params: ["action?", "query?", "id?"] },
  { key: "ac-search-dapodik", category: "Search", method: "GET", path: "/api/search/dapodik", desc: "Cari data sekolah dari Dapodik (Kemendikbud) berdasarkan nama/NPSN", params: ["action", "query?", "npsn?"] },
  { key: "ac-search-douyin", category: "Search", method: "GET", path: "/api/search/douyin-search", desc: "Cari video di Douyin (TikTok China) via so.douyin.com", params: ["query"] },
  { key: "ac-search-ipapelajaran", category: "Search", method: "GET", path: "/api/search/ipa-pelajaran", desc: "Cari materi pelajaran IPA dari ipa.pelajaran.co.id (support pagination & detail artikel)", params: ["query?", "page?", "slug?"] },
  { key: "ac-search-jadwalsepakbola", category: "Search", method: "GET", path: "/api/search/jadwal-sepakbola", desc: "Jadwal pertandingan sepakbola live dari jadwaltv.net", params: ["date?"] },
  { key: "ac-search-jadwalbola", category: "Search", method: "GET", path: "/api/search/jadwalbola", desc: "Jadwal acara siaran langsung sepakbola hari ini", params: [] },
  // Catatan: "search/lazada" berstatus OFFLINE di dokumentasi resmi saat didaftarkan
  // (server providernya sedang down) — dibiarkan terdaftar kalau-kalau online lagi.
  { key: "ac-search-lazada", category: "Search", method: "GET", path: "/api/search/lazada", desc: "Cari produk di Lazada Indonesia (status: OFFLINE saat ini)", params: ["query"] },
  { key: "ac-search-manhwaindo", category: "Search", method: "GET", path: "/api/search/manhwaindo", desc: "Scrape detail info manhwa dari manhwaindo.my (title, status, author, rating, genres, sinopsis)", params: ["query"] },
  { key: "ac-search-murotalquran", category: "Islami", method: "GET", path: "/api/search/murotal-quran", desc: "Cari & streaming audio murotal Al-Quran berdasarkan qari dan surat", params: ["murotal", "surat"] },
  { key: "ac-search-tiktok", category: "Search", method: "GET", path: "/api/search/tiktok-search", desc: "Cari video/foto di TikTok", params: ["query", "type", "count?"] },
  { key: "ac-search-youtube", category: "Search", method: "GET", path: "/api/search/youtube-search", desc: "Cari video di YouTube", params: ["query"] },

  // --- Image HD (upscaler/enhancer) ---
  { key: "ac-imagehd-sparkpix", category: "Image AI", method: "GET", path: "/api/imagehd/sparkpix", desc: "Upscale gambar HD 4K/6K/8K gratis, opsional face enhancement", params: ["url", "quality?", "face?"] },
  { key: "ac-imagehd-superresolution", category: "Image AI", method: "GET", path: "/api/imagehd/super-resolution", desc: "Perjelas resolusi & kualitas gambar sampai HD/4K pakai Visual Paradigm AI", params: ["url"] },
  // Catatan: "ai-enhancev3", "ai-enhancev5", "ai-enhancev7" SENGAJA TIDAK
  // didaftarkan karena statusnya PREMIUM & wajib apikey sendiri di dokumentasi
  // resmi. "upscalev2" & "upscalev3" juga TIDAK didaftarkan karena param
  // "image"-nya berupa upload file langsung (multipart), bukan URL teks
  // seperti endpoint lain — nggak sesuai arsitektur client di sini yang
  // berbasis URL/JSON.
  { key: "ac-imagehd-aienhance", category: "Image HD", method: "GET", path: "/api/imagehd/ai-enhance", desc: "Enhance resolusi & kualitas gambar pakai AI", params: ["url"] },
  { key: "ac-imagehd-aienhancev2", category: "Image HD", method: "GET", path: "/api/imagehd/ai-enhancev2", desc: "Enhance resolusi gambar pakai AI dengan opsi scale (2x/4x/6x/8x)", params: ["url", "size?"] },
  { key: "ac-imagehd-aienhancev4", category: "Image HD", method: "GET", path: "/api/imagehd/ai-enhancev4", desc: "Upscale gambar 2x/4x", params: ["url", "scale?"] },
  { key: "ac-imagehd-aienhancev6", category: "Image HD", method: "GET", path: "/api/imagehd/ai-enhancev6", desc: "Super-resolution cepat tanpa auth", params: ["url"] },
  { key: "ac-imagehd-aienhancev8", category: "Image HD", method: "GET", path: "/api/imagehd/ai-enhancev8", desc: "Upscale gambar via image-upscaling.net, support scale 2x/4x & face enhancement", params: ["url", "scale", "model"] },
  { key: "ac-imagehd-imageupscaler", category: "Image HD", method: "GET", path: "/api/imagehd/imageupscaler", desc: "Upscale gambar 2x/4x/6x via imageupscaler.com", params: ["url", "scale?"] },
  { key: "ac-imagehd-upscale", category: "Image HD", method: "GET", path: "/api/imagehd/upscale", desc: "Upscale resolusi & kualitas gambar", params: ["url"] },
  { key: "ac-imagehd-winkhd", category: "Image HD", method: "GET", path: "/api/imagehd/wink-hd", desc: "Enhance/upscale gambar pakai AI via wink.ai sampai Ultra HD", params: ["url"] },
  { key: "ac-imagehd-webability", category: "Image HD", method: "GET", path: "/api/imagehd/webability", desc: "Upscale gambar via WebAbility AI (scale 2x/4x, model esrgan, mode photo/anime)", params: ["url", "scale?", "model?", "mode?"] },
  // Catatan: 3 endpoint "am/sendv2", "am/verifv2", "am/verify" (kirim email
  // sign-in link + verifikasi + "apply premium Alight Motion") SENGAJA TIDAK
  // didaftarkan. Alurnya itu exploit Firebase Auth buat aktifin status
  // premium Alight Motion tanpa bayar (bypass verifikasi pembelian asli) --
  // sama persis kategorinya kayak endpoint bypass premium yang memang sudah
  // dikecualikan developer sendiri sejak awal file ini (penyalahgunaan/
  // pencurian layanan berbayar), jadi konsisten juga dikecualikan di sini.
];

/**
 * Izuka API (my.izuka-api.xyz). Cuma satu endpoint yang diminta pasang, belum
 * ada dokumentasi resmi yang dilampirkan -> parameter diasumsikan "url"
 * mengikuti konvensi hampir semua tool upscale/enhance gambar lain di
 * registry ini. Kalau ternyata provider ini butuh parameter/nama field lain,
 * tinggal sesuaikan baris "params" di bawah.
 */
const IZUKA_ENDPOINTS = [
  { key: "izuka-imglarger1", category: "Image HD", method: "GET", path: "/api/tools/imglarger", desc: "Perbesar & tingkatkan kualitas gambar (Image Larger)", params: ["url"] },
];

function parseKeyValueArgs(rawText) {
  const out = {};
  const regex = /(\w[\w.-]*)=("([^"]*)"|'([^']*)'|(\S+))/g;
  let m;
  while ((m = regex.exec(rawText)) !== null) {
    const key = m[1];
    const val = m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : m[5];
    out[key] = val;
  }
  return out;
}

function findEndpoint(list, key) {
  const raw = (key || "").toLowerCase().trim().replace(/[.,!?;:]+$/, "");
  if (!raw) return null;

  // Normalisasi: user kadang ketik dengan spasi ("tik tok") padahal key aslinya
  // pakai tanda hubung ("tik-tok") atau nempel ("tiktok"), atau kepencet tanda
  // baca nyasar di ujung (autocorrect keyboard, mis. "rz-tiktok."). Coba beberapa varian.
  const spaced = raw;
  const hyphenated = raw.replace(/\s+/g, "-");
  const squashed = raw.replace(/\s+/g, "");
  const candidates = [spaced, hyphenated, squashed];

  // 1) Exact match di key, path, atau alias untuk salah satu varian
  for (const k of candidates) {
    const hit = list.find(
      (e) =>
        e.key.toLowerCase() === k ||
        e.path.toLowerCase() === k ||
        e.path.toLowerCase() === "/" + k ||
        (e.aliases || []).some((a) => a.toLowerCase() === k)
    );
    if (hit) return hit;
  }

  return null;
}

/** Kalau exact match gagal, cari kandidat terdekat (buat saran di pesan error). */
function suggestEndpoints(list, key, limit = 5) {
  const k = (key || "").toLowerCase().replace(/\s+/g, "");
  if (!k) return [];
  return list
    .filter(
      (e) =>
        e.key.toLowerCase().replace(/-/g, "").includes(k) ||
        (e.aliases || []).some((a) => a.toLowerCase().replace(/-/g, "").includes(k)) ||
        e.desc.toLowerCase().includes(key.toLowerCase())
    )
    .slice(0, limit);
}

/** Cari endpoint lintas kategori berdasarkan kata kunci (cocok di key, desc, atau category). */
function searchEndpoints(list, keyword) {
  const k = (keyword || "").toLowerCase().trim();
  if (!k) return [];
  return list.filter(
    (e) =>
      e.key.toLowerCase().includes(k) ||
      e.desc.toLowerCase().includes(k) ||
      e.category.toLowerCase().includes(k) ||
      (e.aliases || []).some((a) => a.toLowerCase().includes(k))
  );
}

function groupByCategory(list) {
  const grouped = {};
  for (const e of list) {
    if (!grouped[e.category]) grouped[e.category] = [];
    grouped[e.category].push(e);
  }
  return grouped;
}

function paramsHint(ep) {
  if (!ep.params || ep.params.length === 0) return "(tidak ada parameter wajib)";
  return ep.params.join(", ");
}

// ------------------------------------------------------------------
// 4. Generic caller
// ------------------------------------------------------------------
async function callFidzz(ep, args) {
  const cfg = config.externalApi.fidzzcodex;
  if (!cfg.apikey || cfg.apikey === "-") {
    throw new Error("Apikey fidzzcodex belum diisi di config.js (externalApi.fidzzcodex.apikey)");
  }
  const url = cfg.baseUrl.replace(/\/$/, "") + ep.path;
  const method = (ep.method || "GET").toUpperCase();

  let res;
  try {
    if (method === "GET") {
      res = await axios.get(url, { params: { ...args, apikey: cfg.apikey }, timeout: 60000 });
    } else if (method === "DELETE") {
      res = await axios.delete(url, { data: { ...args, apikey: cfg.apikey }, timeout: 60000 });
    } else {
      // POST (default) dan method lain kirim di body
      res = await axios.post(url, { ...args, apikey: cfg.apikey }, { timeout: 60000 });
    }
  } catch (e) {
    if (e.response) {
      const detail = e.response.data && typeof e.response.data === "object"
        ? extractFailMessage(e.response.data)
        : `HTTP ${e.response.status}`;
      throw new Error(detail);
    }
    throw e;
  }

  const data = res.data;
  if (typeof data === "string") {
    throw new Error("Provider tidak mengembalikan JSON (kemungkinan endpoint sedang down/limit). Coba lagi beberapa saat.");
  }
  if (isFailedResponse(data)) {
    throw new Error(extractFailMessage(data));
  }
  return data;
}

/** Nexray (api.nexray.eu.cc) — 100% gratis, TANPA apikey. Semua method GET. */
async function callNexray(ep, args) {
  const url = NEXRAY_BASE.replace(/\/$/, "") + ep.path;
  let res;
  try {
    res = await axios.get(url, {
      params: args,
      timeout: 60000,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "application/json, text/plain, */*",
      },
    });
  } catch (e) {
    // Axios error dengan response (4xx/5xx) -> tetap coba baca body-nya (biasanya JSON berisi message)
    if (e.response) {
      const detail = e.response.data && typeof e.response.data === "object"
        ? extractFailMessage(e.response.data)
        : `HTTP ${e.response.status}`;
      throw new Error(detail);
    }
    throw e;
  }

  const data = res.data;
  // Provider kadang balikin HTML (mis. halaman error/limit) walau status 200
  // -> res.data akan berupa string yang bukan JSON. Deteksi ini biar pesan
  // errornya jelas ketimbang bot nyoba parse HTML sebagai hasil.
  if (typeof data === "string") {
    throw new Error("Provider tidak mengembalikan JSON (kemungkinan endpoint sedang down/limit). Coba lagi beberapa saat.");
  }
  if (isFailedResponse(data)) {
    throw new Error(extractFailMessage(data));
  }
  return data;
}

/** API by Faa (api-faa.my.id) — 100% gratis, TANPA apikey. Semua method GET. */
async function callFaa(ep, args) {
  const url = FAA_BASE.replace(/\/$/, "") + ep.path;
  let res;
  try {
    res = await axios.get(url, {
      params: args,
      timeout: 60000,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "application/json, text/plain, */*",
      },
    });
  } catch (e) {
    if (e.response) {
      const detail = e.response.data && typeof e.response.data === "object"
        ? extractFailMessage(e.response.data)
        : `HTTP ${e.response.status}`;
      throw new Error(detail);
    }
    throw e;
  }

  const data = res.data;
  if (typeof data === "string") {
    throw new Error("Provider tidak mengembalikan JSON (kemungkinan endpoint sedang down/limit). Coba lagi beberapa saat.");
  }
  if (isFailedResponse(data)) {
    throw new Error(extractFailMessage(data));
  }
  return data;
}

/** Izuka API (my.izuka-api.xyz). Method GET, params dikirim sebagai query string. */
async function callIzuka(ep, args) {
  const url = IZUKA_BASE.replace(/\/$/, "") + ep.path;
  let res;
  try {
    res = await axios.get(url, {
      params: args,
      timeout: 60000,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "application/json, text/plain, */*",
      },
    });
  } catch (e) {
    if (e.response) {
      const detail = e.response.data && typeof e.response.data === "object"
        ? extractFailMessage(e.response.data)
        : `HTTP ${e.response.status}`;
      throw new Error(detail);
    }
    throw e;
  }

  const data = res.data;
  if (typeof data === "string") {
    throw new Error("Provider tidak mengembalikan JSON (kemungkinan endpoint sedang down/limit). Coba lagi beberapa saat.");
  }
  if (isFailedResponse(data)) {
    throw new Error(extractFailMessage(data));
  }
  return data;
}


/** AlwaysCodex (api.alwayscodex.eu.cc) — 100% gratis, TANPA apikey. Semua method GET. */
async function callAlwaysCodex(ep, args) {
  const url = ALWAYSCODEX_BASE.replace(/\/$/, "") + ep.path;
  let res;
  try {
    res = await axios.get(url, {
      params: args,
      timeout: 60000,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "application/json, text/plain, */*",
      },
    });
  } catch (e) {
    if (e.response) {
      const detail = e.response.data && typeof e.response.data === "object"
        ? extractFailMessage(e.response.data)
        : `HTTP ${e.response.status}`;
      throw new Error(detail);
    }
    throw e;
  }

  const data = res.data;
  if (typeof data === "string") {
    throw new Error("Provider tidak mengembalikan JSON (kemungkinan endpoint sedang down/limit). Coba lagi beberapa saat.");
  }
  if (isFailedResponse(data)) {
    throw new Error(extractFailMessage(data));
  }
  return data;
}

async function callNex(ep, args) {
  const cfg = config.externalApi.nexapi;
  if (!cfg.apikey || cfg.apikey === "-") {
    throw new Error("Apikey nexapi.fun belum diisi di config.js (externalApi.nexapi.apikey)");
  }
  const url = cfg.baseUrl.replace(/\/$/, "") + ep.path;
  const res = await axios.get(url, { params: { ...args, apikey: cfg.apikey }, timeout: 60000 });
  return res.data;
}

/** Tools 4 gratis tanpa apikey sama sekali (gabungan siputzx.my.id + ryzumi.net, per-endpoint `base`). */
async function callSiputzx(ep, args) {
  const base = ep.base || SIPUTZX_BASE;
  const remaining = { ...args };
  // Dukung path-param gaya REST, contoh: /surat/{nomor} -> /surat/1
  // (param yang dipakai di path otomatis tidak dikirim lagi sebagai query/body)
  const path = ep.path.replace(/\{(\w+)\}/g, (match, key) => {
    if (remaining[key] === undefined) return match;
    const val = remaining[key];
    delete remaining[key];
    return encodeURIComponent(val);
  });
  const url = base.replace(/\/$/, "") + path;
  const method = (ep.method || "GET").toUpperCase();
  const reqOpts = {
    timeout: 60000,
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Accept": "application/json, text/plain, */*",
    },
  };

  let res;
  try {
    res = method === "POST"
      ? await axios.post(url, remaining, reqOpts)
      : await axios.get(url, { ...reqOpts, params: remaining });
  } catch (e) {
    if (e.response) {
      const detail = e.response.data && typeof e.response.data === "object"
        ? extractFailMessage(e.response.data)
        : `HTTP ${e.response.status}`;
      throw new Error(detail);
    }
    throw e;
  }

  const data = res.data;
  if (typeof data === "string") {
    throw new Error("Provider tidak mengembalikan JSON (kemungkinan endpoint sedang down/limit). Coba lagi beberapa saat.");
  }
  if (isFailedResponse(data)) {
    throw new Error(extractFailMessage(data));
  }
  return data;
}

// ------------------------------------------------------------------
// 5. Format hasil jadi teks rapi (HTML, sesuai parse_mode yang dipakai bot)
//    + deteksi otomatis url media (gambar/audio/video) dari response JSON,
//    yang bentuknya beda-beda tiap provider (kadang video_url, kadang
//    result.video, kadang result.download.video, dst) — makanya dicari
//    secara rekursif berdasarkan POLA NAMA KEY, bukan cuma beberapa nama
//    tetap, dan bukan cuma dari EKSTENSI url (banyak CDN video/audio yang
//    urlnya nggak punya ekstensi .mp4/.mp3 di akhir).
// ------------------------------------------------------------------
function findUrlByKeyPattern(obj, pattern, depth = 3, allowPlainArrayStrings = false) {
  if (!obj || typeof obj !== "object" || depth < 0) return null;

  // Array: elemen object (mis. medias: [{url:"...", type:"video"}, ...], yang umum
  // dipakai response TikTok/Instagram/Twitter/AIO downloader multi-kualitas/multi-media)
  // selalu dicek dulu terlepas dari pattern, karena masing-masing object masih bisa
  // dicocokkan ke key video/audio/image secara spesifik.
  if (Array.isArray(obj)) {
    for (const item of obj) {
      if (item && typeof item === "object") {
        const found = findUrlByKeyPattern(item, pattern, depth - 1, allowPlainArrayStrings);
        if (found) return found;
      }
    }
    // Array isi STRING URL langsung (mis. links: ["https://...jpg", ...]) TIDAK punya info
    // tipe (video/audio/image) sama sekali -> hanya boleh diambil di pass generik terakhir,
    // supaya tidak salah tebak jadi "video" padahal misal itu daftar gambar chapter komik.
    if (allowPlainArrayStrings) {
      for (const item of obj) {
        if (typeof item === "string" && /^https?:\/\//i.test(item)) return item;
      }
    }
    return null;
  }

  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (typeof val === "string" && pattern.test(key) && /^https?:\/\//i.test(val)) return val;
  }
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (val && typeof val === "object") {
      const found = findUrlByKeyPattern(val, pattern, depth - 1, allowPlainArrayStrings);
      if (found) return found;
    }
  }
  return null;
}

/** Deteksi respons gagal walau HTTP status 200 (pola umum: status/success false, atau ada field error/message tanpa data). */
function isFailedResponse(data) {
  if (!data || typeof data !== "object") return false;
  if (data.status === false || data.success === false || data.ok === false) return true;
  if (data.error && typeof data.error === "string" && data.error.trim()) return true;
  return false;
}

function extractFailMessage(data) {
  if (!data || typeof data !== "object") return "Request gagal diproses oleh provider.";
  return (
    data.message || data.msg || data.error || data.reason || "Request gagal diproses oleh provider (tidak ada detail error)."
  );
}

/** Cari media di response, urut prioritas video > audio > gambar > url generik. Return {url, type} atau null. */
function extractMedia(data) {
  if (!data || typeof data !== "object") return null;
  const video = findUrlByKeyPattern(data, /video/i, 3, false);
  if (video) return { url: video, type: "video" };
  const audio = findUrlByKeyPattern(data, /audio|music|song/i, 3, false);
  if (audio) return { url: audio, type: "audio" };
  const image = findUrlByKeyPattern(data, /image|photo|picture|avatar|thumb/i, 3, false);
  if (image) return { url: image, type: "image" };
  // Pass generik terakhir: di sinilah array isi string URL polos (tanpa info tipe di key-nya)
  // baru boleh diambil, dan tipenya ditebak dari ekstensi file -> supaya array gambar
  // (mis. hasil chapter komik) nggak salah kelabelan jadi "video".
  const generic = findUrlByKeyPattern(data, /url|link|download/i, 3, true);
  if (generic) return { url: generic, type: guessMediaType(generic) || "file" };
  return null;
}

/** Kompatibilitas lama: cuma balikin url-nya aja. */
function extractMediaUrl(data) {
  const m = extractMedia(data);
  return m ? m.url : null;
}

/**
 * Download file media (video/audio/image) sebagai Buffer memakai header
 * yang menyerupai browser biasa. Dipakai sebagai fallback ketika Telegram
 * gagal fetch URL secara langsung (umum terjadi di CDN TikTok/IG/dll yang
 * menolak request tanpa User-Agent/Referer yang sesuai, atau saat linknya
 * cepat kedaluwarsa) -> error "400: Bad Request: failed to get HTTP URL content".
 */
async function downloadMediaBuffer(url, refererUrl) {
  const res = await axios.get(url, {
    responseType: "arraybuffer",
    timeout: 60000,
    maxContentLength: 100 * 1024 * 1024, // 100MB
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Referer": refererUrl || url,
      "Accept": "*/*",
    },
  });
  return Buffer.from(res.data);
}

function guessMediaType(url) {
  if (!url) return null;
  const clean = url.split("?")[0].toLowerCase();
  if (/\.(jpe?g|png|webp|gif)$/.test(clean)) return "image";
  if (/\.(mp3|wav|ogg|m4a)$/.test(clean)) return "audio";
  if (/\.(mp4|mkv|webm|mov)$/.test(clean)) return "video";
  return null;
}

function escapeHtml(str) {
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Format hasil endpoint jadi teks HTML rapi buat dikirim ke Telegram
 * (parse_mode: "HTML" — sesuai dengan yang dipakai di seluruh bot ini,
 * BUKAN markdown gaya asterisk/backtick) dan TANPA menyebut nama provider
 * eksternal. Kalau ada field yang umum dan gampang dibaca
 * (username/caption/title/dst) ditampilkan sebagai daftar ringkas; kalau
 * tidak, fallback ke JSON rapi di dalam <pre> (tetap HTML-safe & tanpa
 * nama provider).
 */
/** Cari string pertama yang "masuk akal" ditampilkan (bukan URL, bukan terlalu pendek/panjang), rekursif ke dalam object/array. */
function findFirstTextValue(obj, depth = 3) {
  if (!obj || depth < 0) return null;
  if (typeof obj === "string") {
    const trimmed = obj.trim();
    if (trimmed.length >= 2 && trimmed.length <= 2000 && !/^https?:\/\//i.test(trimmed)) return trimmed;
    return null;
  }
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = findFirstTextValue(item, depth - 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof obj === "object") {
    // Prioritaskan key yang biasanya berisi teks utama
    const priorityKeys = ["text", "message", "response", "caption", "result", "answer", "output", "data"];
    for (const key of priorityKeys) {
      if (key in obj) {
        const found = findFirstTextValue(obj[key], depth - 1);
        if (found) return found;
      }
    }
    for (const key of Object.keys(obj)) {
      if (priorityKeys.includes(key)) continue;
      const found = findFirstTextValue(obj[key], depth - 1);
      if (found) return found;
    }
  }
  return null;
}

function humanizeKey(key) {
  return key
    .replace(/[_\-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

/**
 * Dump SEMUA field primitif (string/number/boolean) yang ada di response, apa pun nama key-nya,
 * dalam format rapi "▫️ Label: value" — bukan JSON mentah, bukan cuma 1-2 field tebakan.
 * Dipakai untuk endpoint yang bentuk datanya nggak bisa ditebak (VCC, Virtual Number, dll)
 * supaya SEMUA data yang dikembalikan API ikut tampil, nggak ada yang kepotong/kosong.
 */
function formatDataDump(title, data, { maxItems = 10, maxFieldsPerItem = 20, maxLen = 3800 } = {}) {
  let container = data;
  if (data && typeof data === "object" && !Array.isArray(data) && data.result !== undefined) {
    container = data.result;
  }

  const renderObject = (obj) => {
    const lines = [];
    for (const key of Object.keys(obj)) {
      if (lines.length >= maxFieldsPerItem) break;
      const val = obj[key];
      if (val === null || val === undefined || val === "") continue;
      if (typeof val === "object") continue; // nested object/array ditangani terpisah di bawah
      if (/^(status|success|ok|code)$/i.test(key)) continue; // field teknis, gak perlu ditampilkan ke user
      lines.push(`▫️ <b>${escapeHtml(humanizeKey(key))}:</b> <code>${escapeHtml(String(val))}</code>`);
    }
    return lines;
  };

  const blocks = [];
  if (Array.isArray(container)) {
    container.slice(0, maxItems).forEach((item, i) => {
      if (item && typeof item === "object") {
        const lines = renderObject(item);
        if (lines.length) blocks.push(`<b>#${i + 1}</b>\n${lines.join("\n")}`);
      } else if (item !== null && item !== undefined && item !== "") {
        blocks.push(`<b>#${i + 1}:</b> <code>${escapeHtml(String(item))}</code>`);
      }
    });
  } else if (container && typeof container === "object") {
    const topLines = renderObject(container);
    if (topLines.length) blocks.push(topLines.join("\n"));

    for (const key of Object.keys(container)) {
      const val = container[key];
      if (val && typeof val === "object" && !Array.isArray(val)) {
        const nestedLines = renderObject(val);
        if (nestedLines.length) blocks.push(`<b>${escapeHtml(humanizeKey(key))}:</b>\n${nestedLines.join("\n")}`);
      } else if (Array.isArray(val)) {
        val.slice(0, maxItems).forEach((item, i) => {
          if (item && typeof item === "object") {
            const lines = renderObject(item);
            if (lines.length) blocks.push(`<b>${escapeHtml(humanizeKey(key))} #${i + 1}</b>\n${lines.join("\n")}`);
          } else if (item !== null && item !== undefined && item !== "") {
            blocks.push(`<b>${escapeHtml(humanizeKey(key))} #${i + 1}:</b> <code>${escapeHtml(String(item))}</code>`);
          }
        });
      }
    }
  }

  if (blocks.length === 0) return null;
  let text = `✅ <b>${escapeHtml(title)}</b>\n\n${blocks.join("\n\n")}`;
  if (text.length > maxLen) text = text.slice(0, maxLen) + "\n...";
  return text;
}

/**
 * Kumpulkan item {title, url} dari struktur data apa pun secara rekursif — dipakai untuk
 * endpoint yang balikin LIST (daftar anime, hasil pencarian, jadwal, dll) supaya bisa
 * ditampilkan sebagai daftar rapi bernomor, bukan JSON mentah.
 */
function collectListItems(obj, depth = 4, results = [], seen = new Set()) {
  if (!obj || depth < 0 || results.length >= 30) return results;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      if (results.length >= 30) break;
      if (item && typeof item === "object") {
        const title = item.title || item.name || item.judul || item.anime_name || item.text;
        const url = item.url || item.link || item.href;
        if (typeof title === "string" && title.trim()) {
          const key = title + "|" + (url || "");
          if (!seen.has(key)) {
            seen.add(key);
            results.push({ title: title.trim(), url: typeof url === "string" ? url : null });
          }
        } else {
          collectListItems(item, depth - 1, results, seen);
        }
      }
    }
  } else if (typeof obj === "object") {
    for (const key of Object.keys(obj)) {
      collectListItems(obj[key], depth - 1, results, seen);
    }
  }
  return results;
}

function formatListText(title, data, maxItems = 15) {
  const items = collectListItems(data).slice(0, maxItems);
  if (items.length === 0) return null;
  const lines = items.map((it, i) => `${i + 1}. ${escapeHtml(it.title)}${it.url ? `\n   🔗 ${escapeHtml(it.url)}` : ""}`);
  return `✅ <b>${escapeHtml(title)}</b>\n\n${lines.join("\n")}`;
}

/**
 * Bungkus teks hasil (yang sudah dirapikan formatDataDump/formatListText/dll) ke dalam
 * "box" bergaya sama seperti menu bot (border ╭━╰), biar tampilannya lebih rapi & konsisten.
 * bodyText: string multi-baris, HTML tags boleh (b/i/code sudah aman karena border-nya
 * bukan bagian dari teks yang di-escape).
 */
function formatBox(title, bodyText) {
  const lines = String(bodyText || "").split("\n");
  const boxedLines = lines.map((l) => `┃ ${l}`).join("\n");
  return `╭━━━✧「 ${escapeHtml(title)} 」✧━━━❍\n${boxedLines}\n╰━━━━━━━━━━━━━━━━━━━━━━━━❍`;
}

function formatResultText(ep, data) {
  const title = (ep && (ep.desc || ep.path)) || "Hasil";
  const clean = deepStripCredit(data);
  const container = clean && typeof clean === "object"
    ? (clean.result && typeof clean.result === "object" ? clean.result : clean)
    : null;

  const lines = [];
  if (container && typeof container === "object") {
    const fieldMap = [
      ["username", "👤 Username"],
      ["title", "📌 Judul"],
      ["caption", "📝 Caption"],
      ["text", "💬 Teks"],
      ["message", "💬 Pesan"],
      ["name", "📛 Nama"],
      ["price", "💰 Harga"],
      ["version", "🔢 Versi"],
      ["latest", "🔢 Versi Terbaru"],
    ];
    for (const [key, label] of fieldMap) {
      const val = container[key];
      if (typeof val === "string" && val.trim() && val.length < 300) {
        lines.push(`${label}: ${escapeHtml(val)}`);
      } else if (typeof val === "number") {
        lines.push(`${label}: ${val}`);
      }
    }
  }

  if (lines.length > 0) {
    return `✅ <b>${escapeHtml(title)}</b>\n\n${lines.join("\n")}`;
  }

  // Coba cari teks bebas apa pun yang masuk akal ditampilkan (bukan raw JSON)
  const freeText = findFirstTextValue(clean);
  if (freeText) {
    const trimmed = freeText.length > 2000 ? freeText.slice(0, 2000) + "..." : freeText;
    return `✅ <b>${escapeHtml(title)}</b>\n\n${escapeHtml(trimmed)}`;
  }

  // Tidak ada teks/media yang bisa ditampilkan -> pesan bersih, BUKAN dump JSON mentah
  return `✅ <b>${escapeHtml(title)}</b>\n\n<i>Request berhasil diproses, tapi responsnya tidak mengandung teks atau media yang bisa ditampilkan.</i>`;
}


// ------------------------------------------------------------------
// 6. Shortcut - fitur populer yang dipendekkan jadi 1 command (tanpa perlu
//    ketik /tools2 atau /tools3 + nama endpoint + key=value)
// ------------------------------------------------------------------
const SHORTCUTS = [
  { cmd: "ai", sourceKey: "tools2", epKey: "gemini", mainParam: "prompt", desc: "Chat cepat dengan AI Gemini" },
  { cmd: "ttdl", sourceKey: "tools3", epKey: "tiktok-dl", mainParam: "url", desc: "Download video TikTok (tanpa watermark)" },
  { cmd: "ytdl", sourceKey: "tools3", epKey: "ytdl-v1", mainParam: "url", desc: "Download video/audio YouTube" },
  { cmd: "igstory", sourceKey: "tools2", epKey: "ig-stories", mainParam: "username", desc: "Lihat story Instagram tanpa login" },
  { cmd: "tts", sourceKey: "tools3", epKey: "tts", mainParam: "text", desc: "Ubah teks jadi suara" },
  { cmd: "cuaca", sourceKey: "tools3", epKey: "weather", mainParam: "city", desc: "Prakiraan cuaca 10 hari" },
  { cmd: "ghstalk", sourceKey: "tools3", epKey: "gh-info", mainParam: "username", desc: "Info profil GitHub" },
  { cmd: "spotifydl", sourceKey: "tools3", epKey: "spotify-dl", mainParam: "url", desc: "Download lagu dari Spotify" },
];

/**
 * Sejumlah API pihak ketiga yang dipakai bot ini nyisipin baris promosi/credit
 * developer mereka sendiri langsung di dalam field teks respons (message/text/
 * caption/dll), misalnya "Virtual Number v1\n\n@nexray - ElrayyXml". Field itu
 * ikut ditampilkan apa adanya ke user kalau nggak disaring dulu. Fungsi ini
 * menghapus baris-baris semacam itu tanpa mengubah isi jawaban yang sebenarnya.
 */
const CREDIT_LINE_KEYWORDS = /\b(developer|dev\.?|creator|credit|cr\s*:|created\s*by|made\s*by|powered\s*by|script\s*by|author|owner|source\s*code|repo(sitory)?|api\s*by|by\s*:|channel\s*:|group\s*:|whatsapp\.com\/channel|wa\.me\/|t\.me\/|instagram\.com\/|github\.com\/|youtube\.com\/(@|channel)|tiktok\.com\/@)\b/i;
const HANDLE_ONLY_LINE = /^@[\w.]{2,32}(\s*[-|—:]\s*.{0,60})?$/i;
const HANDLE_WITH_DASH_LINE = /^.{0,20}@[\w.]{2,32}\s*[-|—]\s*[\w .]{2,50}$/i;

function stripProviderCredit(text) {
  if (typeof text !== "string" || !text) return text;
  const lines = text.split("\n");
  const filtered = lines.filter((line) => {
    const trimmed = line.trim();
    if (!trimmed) return true; // baris kosong dipertahankan dulu, dirapikan di akhir
    if (CREDIT_LINE_KEYWORDS.test(trimmed)) return false;
    if (HANDLE_ONLY_LINE.test(trimmed)) return false;
    if (HANDLE_WITH_DASH_LINE.test(trimmed)) return false;
    return true;
  });
  return filtered.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Terapkan stripProviderCredit secara rekursif ke semua string di dalam object/array hasil API. */
function deepStripCredit(value, depth = 4) {
  if (depth < 0) return value;
  if (typeof value === "string") return stripProviderCredit(value);
  if (Array.isArray(value)) return value.map((v) => deepStripCredit(v, depth - 1));
  if (value && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value)) out[k] = deepStripCredit(value[k], depth - 1);
    return out;
  }
  return value;
}

module.exports = {
  FIDZZ_ENDPOINTS,
  NEX_ENDPOINTS,
  SIPUTZX_ENDPOINTS,
  NEXRAY_ENDPOINTS,
  FAA_ENDPOINTS,
  ALWAYSCODEX_ENDPOINTS,
  IZUKA_ENDPOINTS,
  SHORTCUTS,
  OWNER_ONLY_CATEGORIES,
  isOwnerOnlyCategory,
  parseKeyValueArgs,
  findEndpoint,
  suggestEndpoints,
  searchEndpoints,
  groupByCategory,
  paramsHint,
  downloadMediaBuffer,
  callFidzz,
  callNex,
  callSiputzx,
  callNexray,
  callFaa,
  callAlwaysCodex,
  callIzuka,
  isFailedResponse,
  extractFailMessage,
  extractMedia,
  extractMediaUrl,
  findFirstTextValue,
  formatDataDump,
  formatListText,
  formatBox,
  collectListItems,
  escapeHtml,
  guessMediaType,
  formatResultText,
  stripProviderCredit,
  deepStripCredit,
};
