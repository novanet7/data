module.exports = {
    // --- TELEGRAM SETTINGS ---
    botToken: "7761298553:AAHltgl2HgEP-5idBfWbZRdtF5c9jtyRiMA",
    ownerId: 5078284381,
    ownerName: "dimas_store19",
    ownerWa: "-", // nomor WA owner, ditampilkan di menu "Contact Owner" bot Telegram
    ownerUser: "@dimas_store19",
    botName: "bot order",
    startPhoto: "https://files.catbox.moe/dtaym2.jpg",
    startProduk: "https://files.catbox.moe/dtaym2.jpg",
    startAdminPanel: "https://files.catbox.moe/dtaym2.jpg",
    startMuridPanel: "https://files.catbox.moe/dtaym2.jpg",
    startScript: "https://files.catbox.moe/dtaym2.jpg",
    startMedia: "https://files.catbox.moe/dtaym2.jpg",
    startAudio: "https://files.catbox.moe/1u42o5.mp3",
    startVps: "https://files.catbox.moe/dtaym2.jpg",
    startDoneProduk: "https://files.catbox.moe/dtaym2.jpg",
    startDoneVoucher: "https://files.catbox.moe/dtaym2.jpg",
    startTransaksi: "https://files.catbox.moe/dtaym2.jpg",
    startAudioCaption: "𝗪𝗲𝗹𝗰𝗼𝗺𝗲 𝗧𝗼 𝗧𝗼𝗸𝗼",
    testimoniChannel: "@dimas_storebot",
    infobotChannel: "@dimas_storebot",
    
    // --- Link Group Buyer AdminPanel 
    
    GbAdminPanel: "-",
    
    menuEffects: [
    "5104841245755180586", // Fire 🔥
    "5107584321108051014", // Love ❤️  
    "5159385139981059251", // Trumpet 🎺
    "5046509860389126442"  // Thumbs up 👍
    ],
    
    // --- Nokos Setting ( Rumah Otp )
    RUMAHOTP: "rk-dev-wqyTOCudXbWmJl9HtkmbWKAs6XO771Ws",
    UNTUNG_NOKOS: 100,
    UNTUNG_DEPOSIT: 300,
    ppthumb: "dimas_storebot",

    // --- HARGA DEFAULT PRODUK GMAIL (dipakai saat produk Gmail pertama kali dibuat) ---
    hargaGmailDefault: 5000,

    // --- HARGA DEFAULT PRODUK NOTEL (nomor telepon, dipakai saat produk pertama kali dibuat) ---
    hargaNotelDefault: 3000,

    smm: {
        apiId: '-', // API ID
        apiKey: 'ugedpr-xzkxgw-m6ucqz-au6vu2-nosmyt', // APIKEY
        baseUrl: 'https://fayupedia.id/api' 
    },
    
    // --- SUBDOMAIN ---
subdomain: {
  "mypanelpeteroku.web.id": {
    zone: "ae9218e405aaf6c550738b9d9abb6212",
    apitoken: "Dd8WMmC5KGWHInCjbeitM3LNhQoX8kMMl1mlmsb5"
  },
  "rafatharcode.biz.id": {
    zone: "2bd50e657ae8b18e6d8e7e9d61a361af", 
    apitoken: "ad8dB05uFkf0Y6SGcDir33NADWVTXXA-kMVvHNSO"
  }
},
    // --- PAYMENT NEVAPEDIA ---
    nevapedia: {
        apikey: "SKY_1b24b0f1d2dc467b"
    },

    wd_balance: {
        bank_code: "DANA", // DANA, BCA, BRI, dll
        destination_number: "-",
        destination_name: "A/N",
    },
    
    // --- Qris Manual Setting ---
    manualQrisPhoto: "https://files.catbox.moe/o3ha98.jpg",
    
    // --- Vps Setting ---
    ApiDO1: "-", // ganti api do lu
    hargaVPS: {
       low: {
        "2c2": 20000,
        "4c2": 23000,
        "8c4": 25000,
        "16c4": 28000,
        "16c8": 30000
      },
       medium: {
        "2c2": 23000,
        "4c2": 25000,
        "8c4": 30000,
        "16c4": 35000,
        "16c8": 40000
      },
       high: {
        "2c2": 30000,
        "4c2": 50000,
        "8c4": 70000,
        "16c4": 95000,
        "16c8": 110000
    }
  },
    // --- Fix Error Setting
    USER_LIMIT: 3,
    GEMINI_API_KEY: "AIzaSyB47adRUMkO-Yn_MOcOZBDV0PFIpzqKBy4",
    
    // --- PTERODACTYL ADMIN PANEL ----
    
adminPanel: {
  // Panel Private (admin/root access)
  private: {
    domain: "-", // Domain panel private
    apikey: "-",     // API key untuk private panel
    harga: {
      bulanan: 20000,   // harga untuk 1 bulan
      permanen: 25000   // harga untuk permanen
    }
  },
  
  // Panel Public (user regular access)
  public: {
    domain: "-",   // Domain panel public
    apikey: "-",      // API key untuk public panel
    harga: {
      bulanan: 15000,   // harga untuk 1 bulan
      permanen: 20000   // harga untuk permanen
    }
  }
},
    
    // --- PTERODACTYL MURID PANEL ---

muridPanel: {
  OWNERPANEL: {
    private: {
      domain: "-", // domain panel owner
      apikey: "-",    // API key ownerpanel private
      harga: {
        bulanan: 20000,
        permanen: 25000
      }
    },
    public: {
      domain: "-", // domain panel owner public
      apikey: "-",     // API key ownerpanel public
      harga: {
        bulanan: 15000,
        permanen: 20000
      }
    }
  },
  PTPANEL: {
    private: {
      domain: "-",    // domain PT panel
      apikey: "-",       // API key PT panel private
      harga: {
        bulanan: 30000,
        permanen: 35000
      }
    },
    public: {
      domain: "-",    // domain PT panel public
      apikey: "-",        // API key PT panel public
      harga: {
        bulanan: 25000,
        permanen: 30000
      }
    }
  },
  linkGb: "-" // link guide murid panel
},
    
    // --- PTERODACTYL PANEL ---
    panel: {
        domain: "https://panelprivatex.khz.web.id",
        apikey: "ptla_bapGoM5LuyGDueceZmIchw0ECzLIlgwbDIHACDV7QKn",
        nestId: 5,
        eggId: 15,
        locationId: 1,
        startup: "npm start",
        image: "ghcr.io/parkervcp/yolks:nodejs_18"
    },

    // --- HARGA PANEL ---
    hargaPanel: {
        unlimited: 3000,
        perGB: 1000,  
    },

    // --- EXTERNAL API (Fitur Tools 2/3/4 di Telegram bot) ---
    // Isi apikey masing-masing di bawah ini. JANGAN pakai apikey yang sama untuk keduanya, beda provider.
    // --- TELEGRAM MINI APP (Web App katalog produk) ---
    miniApp: {
        enabled: false, // set true setelah miniapp di-deploy & url diisi
        url: "-", // URL HTTPS publik hasil deploy folder miniapp/ (contoh: https://toko-kamu.vercel.app)
        botUsername: "-", // username bot TANPA @ (contoh: "dimas_storebot"), dipakai Mini App buat deep-link balik ke chat
        port: 3400 // port lokal buat server miniapp/server.js
    },

    // --- TELEGRAM STARS (metode bayar alternatif native Telegram, tanpa keluar app) ---
    // --- FILTER KATA KASAR/TOXIC (AI Customer Support) ---
    // Kalau pesan user mengandung salah satu kata ini, AI CS tidak akan diproses,
    // langsung dibalas pesan netral. Tambah/kurangi sesuai kebutuhan.
    toxicWordFilter: ["anjing", "bangsat", "goblok", "tolol", "kontol", "memek", "babi lu", "asu", "jancok", "bego lu"],

    // --- STOK ---
    lowStockThreshold: 2, // owner di-notif otomatis kalau stok produk (accounts) turun sampai/di bawah angka ini

    aiCsSummaryHour: 21, // jam berapa (0-23) ringkasan harian AI Customer Support dikirim ke owner

    sleepHours: {
        enabled: false, // set true buat aktifin mode "sedang istirahat" owner
        start: 0, // jam mulai istirahat (0-23)
        end: 6 // jam selesai istirahat (0-23)
    },

    telegramStars: {
        enabled: false, // set true buat aktifin pilihan bayar pakai Telegram Stars di semua transaksi
        idrPerStar: 250 // kurs: berapa Rupiah per 1 Star. Contoh: harga 10.000 -> 40 Stars (dibulatkan ke atas)
    },

    externalApi: {
        fidzzcodex: {
            apikey: "fidzzcodex", // isi apikey dari https://me.fidzzcodex.my.id
            baseUrl: "https://me.fidzzcodex.my.id"
        },
        nexapi: {
            apikey: "-", // isi apikey dari https://nexapi.fun/auth/register (login -> dashboard -> copy API key)
            baseUrl: "https://nexapi.fun/api"
        }
    }
};