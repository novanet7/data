const axios = require("axios");

const NEVA_BASE = "https://app.nevapedia.com/api";

const toRupiah = (angka) => {
  return Number(angka).toLocaleString("id-ID", {
    style: "currency",
    currency: "IDR",
    minimumFractionDigits: 0
  }).replace("IDR", "Rp").trim();
};

async function downloadQrisImage(url) {
  try {
    if (!url || !url.startsWith('http')) return null;
    const response = await axios({
      method: 'GET',
      url: url,
      responseType: 'arraybuffer',
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    return Buffer.from(response.data);
  } catch (error) {
    return null;
  }
}

// Nevapedia kadang lambat merespon (server mereka, bukan bug di kode kita).
// Kalau errornya jenis timeout/koneksi, coba ulang sekali sebelum nyerah.
function isTimeoutOrNetworkError(e) {
  return (
    e.code === "ECONNABORTED" ||
    e.code === "ETIMEDOUT" ||
    e.code === "ECONNRESET" ||
    e.code === "ENOTFOUND" ||
    e.code === "ECONNREFUSED" ||
    /timeout/i.test(e.message || "") ||
    !e.response
  );
}

// Kasih pesan yang beda tergantung JENIS error koneksinya, supaya ketauan
// ini masalah DNS/domain salah, koneksi ditolak, atau beneran hang/timeout.
function describeConnectionError(e) {
  if (e.code === "ENOTFOUND" || e.code === "EAI_AGAIN") {
    return `Domain Nevapedia tidak bisa di-resolve (DNS gagal, kode: ${e.code}). Cek koneksi internet VPS atau apakah domain app.nevapedia.com masih aktif.`;
  }
  if (e.code === "ECONNREFUSED") {
    return `Koneksi ke server Nevapedia DITOLAK (kode: ECONNREFUSED). Server mereka kemungkinan down, atau port/firewall memblokir.`;
  }
  if (e.code === "ECONNABORTED" || /timeout/i.test(e.message || "")) {
    return (
      `Server Nevapedia tidak merespon sama sekali dalam waktu yang ditentukan (timeout). ` +
      `Bisa karena: (1) endpoint /api/invoice khusus yang lambat/bermasalah walau domain utamanya hidup, ` +
      `(2) API key sudah tidak valid/perlu di-generate ulang, atau (3) server mereka lagi down. ` +
      `Cek dulu pakai tombol "Tes Koneksi" — itu bakal tes domain utama & endpoint API secara terpisah.`
    );
  }
  return `Koneksi ke Nevapedia gagal (${e.code || "unknown"}): ${e.message}`;
}

// Tes konektivitas 2 tahap: domain utama (harusnya selalu bisa diakses kalau
// internet VPS normal) vs endpoint /api spesifik (yang kemungkinan bermasalah).
// Ini buat mastiin apakah masalahnya di level jaringan/DNS, atau spesifik di
// endpoint API-nya Nevapedia aja.
async function testNevapediaConnectivity(apikey) {
  const result = { baseDomain: null, apiEndpoint: null };

  // Tahap 1: domain utama (app.nevapedia.com/)
  const t1 = Date.now();
  try {
    await axios.get("https://app.nevapedia.com/", { timeout: 10000, validateStatus: () => true });
    result.baseDomain = { ok: true, elapsedSec: ((Date.now() - t1) / 1000).toFixed(1) };
  } catch (e) {
    result.baseDomain = { ok: false, elapsedSec: ((Date.now() - t1) / 1000).toFixed(1), error: describeConnectionError(e) };
  }

  // Tahap 2: endpoint API invoice yang sebenarnya dipakai buat bikin QRIS
  const t2 = Date.now();
  try {
    const url = `${NEVA_BASE}/invoice?apikey=${apikey}&amount=100`;
    const res = await axios.get(url, { timeout: 15000, validateStatus: () => true });
    result.apiEndpoint = {
      ok: true,
      elapsedSec: ((Date.now() - t2) / 1000).toFixed(1),
      httpStatus: res.status,
      rawResponse: JSON.stringify(res.data).slice(0, 300)
    };
  } catch (e) {
    result.apiEndpoint = { ok: false, elapsedSec: ((Date.now() - t2) / 1000).toFixed(1), error: describeConnectionError(e) };
  }

  return result;
}

async function withRetry(fn, retries = 1) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (attempt < retries && isTimeoutOrNetworkError(e)) {
        console.log(`[PAYMENT RETRY] Percobaan ${attempt + 1} gagal (${e.code || e.message}), coba lagi...`);
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

// ================= CIRCUIT BREAKER =================
// Payment itu kritikal — kalau Nevapedia lagi down, jangan bikin SETIAP user
// nunggu timeout lama dulu baru dapat pesan gagal. Setelah gagal beruntun
// (timeout/koneksi) N kali, request berikutnya langsung ditolak cepat tanpa
// coba hit API lagi, sampai masa cooldown-nya habis.
const CIRCUIT_FAIL_THRESHOLD = 3;
const CIRCUIT_COOLDOWN_MS = 2 * 60 * 1000; // 2 menit

const circuitState = {
  nevapedia: { failCount: 0, openUntil: 0, lastError: null },
};

function isCircuitOpen(method) {
  const s = circuitState[method];
  if (!s) return false;
  return Date.now() < s.openUntil;
}

function recordFailure(method, errMsg) {
  const s = circuitState[method];
  if (!s) return;
  s.failCount += 1;
  s.lastError = errMsg;
  if (s.failCount >= CIRCUIT_FAIL_THRESHOLD) {
    s.openUntil = Date.now() + CIRCUIT_COOLDOWN_MS;
    console.error(`[CIRCUIT] ${method} dibuka (skip sementara) selama ${CIRCUIT_COOLDOWN_MS / 60000} menit setelah ${s.failCount}x gagal beruntun. Terakhir: ${errMsg}`);
  }
}

function recordSuccess(method) {
  const s = circuitState[method];
  if (!s) return;
  s.failCount = 0;
  s.openUntil = 0;
  s.lastError = null;
}

function getGatewayStatus() {
  const now = Date.now();
  const s = circuitState.nevapedia;
  return {
    nevapedia: {
      healthy: now >= s.openUntil,
      failCount: s.failCount,
      cooldownRemainingSec: Math.max(0, Math.ceil((s.openUntil - now) / 1000)),
      lastError: s.lastError,
    },
  };
}

// ================= BUAT QRIS (NEVAPEDIA) =================
async function createdQris(harga, config, opts = {}) {
  const amount = Number(harga);
  const PAYMENT_TIMEOUT = 18000; // 2 percobaan x 18s = maksimal ~36s nunggu, gak sampe 75s kaya sebelumnya

  if (!opts.bypassCircuit && isCircuitOpen("nevapedia")) {
    const remain = Math.ceil((circuitState.nevapedia.openUntil - Date.now()) / 1000);
    return { error: `Nevapedia sedang di-skip sementara (server lagi bermasalah, coba lagi dalam ${remain} detik). Terakhir: ${circuitState.nevapedia.lastError}` };
  }

  try {
    if (!config.apikey) {
      return { error: "API key Nevapedia belum di-set di config." };
    }

    const url = `${NEVA_BASE}/invoice?apikey=${config.apikey}&amount=${amount}`;
    const { data } = await withRetry(() => axios.get(url, { timeout: PAYMENT_TIMEOUT }));

    if (!data || data.success !== true) {
      const reason = data?.message || data?.msg || JSON.stringify(data).slice(0, 300);
      console.error("[NEVAPEDIA CREATE ERROR]", reason);
      return { error: `Nevapedia menolak: ${reason}` };
    }

    recordSuccess("nevapedia");

    return {
      idtransaksi: data.invoice_id,
      jumlah: data.total || amount, // nominal yang HARUS dibayar via QRIS (sudah termasuk fee)
      amountAsli: data.amount || amount, // nominal sebelum fee, buat info tambahan
      fee: data.fee || 0,
      imageqris: data.qris_image || "",
      qr_string: "",
      nominal: amount,
      payment_link: data.payment_link || "",
      expired_at: data.expired_at || ""
    };

  } catch (e) {
    console.error("[NEVAPEDIA CREATE ERROR]", e.code || "", e.response?.data || e.message);
    if (isTimeoutOrNetworkError(e)) {
      const msg = describeConnectionError(e);
      recordFailure("nevapedia", msg);
      return { error: msg };
    }
    const reason = e.response?.data?.message || e.response?.data?.msg || e.message;
    return { error: `Nevapedia error: ${reason}` };
  }
}

// ================= CEK SALDO (BALANCE) =================
async function getNevapediaBalance(config) {
  try {
    if (!config.apikey) {
      return { error: "API key Nevapedia belum di-set di config." };
    }
    const url = `${NEVA_BASE}/balance?apikey=${config.apikey}`;
    const { data } = await withRetry(() => axios.get(url, { timeout: 15000 }));

    if (!data || (data.balance === undefined && !data.username)) {
      const reason = data?.message || data?.msg || JSON.stringify(data).slice(0, 300);
      return { error: `Nevapedia menolak: ${reason}` };
    }

    return {
      username: data.username || "-",
      email: data.email || "-",
      balance: data.balance || 0,
      pendingBalance: data.pending_balance || 0
    };
  } catch (e) {
    console.error("[NEVAPEDIA BALANCE ERROR]", e.code || "", e.response?.data || e.message);
    if (isTimeoutOrNetworkError(e)) {
      return { error: describeConnectionError(e) };
    }
    const reason = e.response?.data?.message || e.response?.data?.msg || e.message;
    return { error: `Nevapedia error: ${reason}` };
  }
}

// ================= CEK STATUS =================
async function cekStatus(id, amount, config) {
  try {
    const url = `${NEVA_BASE}/invoice/status?apikey=${config.apikey}&invoice_id=${id}`;
    const { data } = await axios.get(url, { timeout: 10000 });

    const status = data?.status?.toLowerCase();
    console.log(`[DEBUG] Status Nevapedia ID ${id}: ${status}`);

    return status === "paid";

  } catch (e) {
    console.error("[NEVAPEDIA STATUS ERROR]", e.response?.data || e.message);
    return false;
  }
}

// ================= NEVAPEDIA WITHDRAW =================
async function getNevapediaWdMethods(config) {
  try {
    const url = `${NEVA_BASE}/withdraw/methods?apikey=${config.apikey}`;
    const { data } = await axios.get(url, { timeout: 15000 });
    return {
      manual: Array.isArray(data?.manual_methods) ? data.manual_methods : [],
      instant: Array.isArray(data?.instant_methods) ? data.instant_methods : []
    };
  } catch (e) {
    console.error("[NEVAPEDIA WD METHODS ERROR]", e.response?.data || e.message);
    return null;
  }
}

async function createNevapediaWd(config, amount, method, accountNumber, instant = false) {
  try {
    const url = `${NEVA_BASE}/withdraw?apikey=${config.apikey}&amount=${amount}&method=${method}&account_number=${accountNumber}&instant=${instant ? "true" : "false"}`;
    const { data } = await axios.get(url, { timeout: 20000 });

    if (!data || data.success !== true) {
      return { success: false, message: data?.message || "Gagal melakukan withdraw." };
    }

    return { success: true, message: data.message, data: data.data };
  } catch (e) {
    return {
      success: false,
      message: e.response?.data?.message || e.message || "Unknown error"
    };
  }
}

async function cekNevapediaWdStatus(config, id) {
  try {
    const url = `${NEVA_BASE}/withdraw/status?apikey=${config.apikey}&id=${id}`;
    const { data } = await axios.get(url, { timeout: 15000 });
    return data;
  } catch (e) {
    console.error("[NEVAPEDIA WD STATUS ERROR]", e.response?.data || e.message);
    return null;
  }
}

module.exports = {
  createdQris,
  cekStatus,
  toRupiah,
  downloadQrisImage,
  getNevapediaWdMethods,
  createNevapediaWd,
  cekNevapediaWdStatus,
  getGatewayStatus,
  testNevapediaConnectivity,
  getNevapediaBalance
};
