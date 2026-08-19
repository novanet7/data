/* =========================================================
   IJICHI VISUALIZER — app.js
   Render dilakukan frame-by-frame (bukan real-time recording),
   jadi hasil video TIDAK bergantung performa HP saat export,
   dan output langsung .mp4 (via native ffmpeg binary, bukan
   MediaRecorder/webm).
   ========================================================= */

const canvas = document.getElementById('previewCanvas');
const ctx = canvas.getContext('2d');

const state = {
  bgImage: null,
  bgFileName: '',
  audioFile: null,
  audioBuffer: null,
  audioArrayBuffer: null,
  duration: 0,
  peaks: [],          // downsampled waveform peaks (0..1)
  swaySeed: null,
};

// ---------- SWAY / AYUN ENGINE ----------
// Kombinasi beberapa gelombang sinus dengan frekuensi & fase acak
// (di-generate sekali per project) supaya gerakannya kerasa "random"
// tapi tetap halus & lambat — bukan Perlin-noise beneran, tapi efeknya mirip.
function makeSwaySeed(intensity) {
  const amp = intensity === 'medium' ? 1.6 : 1.0; // multiplier magnitude
  const rand = (min, max) => min + Math.random() * (max - min);
  return {
    // offset X: dua gelombang beda frekuensi, hasilnya gerak gak simetris
    x1: { freq: rand(0.035, 0.06), phase: rand(0, 6.28), amp: rand(10, 16) * amp },
    x2: { freq: rand(0.09, 0.14), phase: rand(0, 6.28), amp: rand(4, 8) * amp },
    y1: { freq: rand(0.03, 0.05), phase: rand(0, 6.28), amp: rand(8, 14) * amp },
    y2: { freq: rand(0.08, 0.12), phase: rand(0, 6.28), amp: rand(3, 6) * amp },
    scale: { freq: rand(0.025, 0.045), phase: rand(0, 6.28), amp: rand(0.015, 0.03) * amp },
    rot: { freq: rand(0.02, 0.035), phase: rand(0, 6.28), amp: rand(0.4, 0.9) * amp }, // derajat
  };
}

function swayAt(seed, t) {
  const w = (band) => Math.sin(t * band.freq * 2 * Math.PI + band.phase) * band.amp;
  return {
    x: w(seed.x1) + w(seed.x2),
    y: w(seed.y1) + w(seed.y2),
    scale: 1 + w(seed.scale),
    rotDeg: w(seed.rot),
  };
}

// ---------- WAVEFORM ----------
async function decodeAudio(file) {
  const arrayBuffer = await file.arrayBuffer();
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const actx = new AudioCtx();
  const audioBuffer = await actx.decodeAudioData(arrayBuffer.slice(0));
  actx.close();
  return { audioBuffer, arrayBuffer };
}

function buildPeaks(audioBuffer, numBars = 90) {
  const data = audioBuffer.getChannelData(0);
  const blockSize = Math.floor(data.length / numBars);
  const peaks = [];
  for (let i = 0; i < numBars; i++) {
    let sum = 0;
    const start = i * blockSize;
    for (let j = 0; j < blockSize; j++) sum += Math.abs(data[start + j] || 0);
    peaks.push(sum / blockSize);
  }
  const max = Math.max(...peaks, 0.0001);
  return peaks.map(p => p / max);
}

// ---------- DRAW ONE FRAME ----------
// drawFrame() dipakai preview (ctx bawaan canvas layar),
// _renderCore() adalah implementasi sesungguhnya yang menerima ctx apapun
// supaya bisa dipakai ulang persis sama untuk render export resolusi custom.
function drawFrame(t, W, H) {
  _renderCore(ctx, t, W, H);
}

function formatTime(t) {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ---------- LIVE PREVIEW LOOP (ringan, cuma buat preview di layar) ----------
let previewStart = null;
function previewLoop(ts) {
  if (!previewStart) previewStart = ts;
  const t = ((ts - previewStart) / 1000) % (state.duration || 20);
  drawFrame(t, canvas.width, canvas.height);
  document.getElementById('pvArtist').textContent = document.getElementById('artistName').value;
  document.getElementById('pvTitle').textContent = document.getElementById('songTitle').value;
  document.getElementById('pvTime').textContent = formatTime(t);
  requestAnimationFrame(previewLoop);
}
requestAnimationFrame(previewLoop);

// ---------- FILE INPUTS ----------
document.getElementById('bgFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  state.bgFileName = file.name;
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    state.bgImage = img;
    state.swaySeed = makeSwaySeed(document.getElementById('swayIntensity').value);
  };
  img.src = url;
  document.getElementById('bgFileName').textContent = file.name;
  document.getElementById('bgFileName').parentElement.classList.add('done');
});

document.getElementById('audioFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  state.audioFile = file;
  document.getElementById('audioFileName').textContent = file.name;
  document.getElementById('audioFileName').parentElement.classList.add('done');
  const { audioBuffer, arrayBuffer } = await decodeAudio(file);
  state.audioBuffer = audioBuffer;
  state.audioArrayBuffer = arrayBuffer;
  state.duration = audioBuffer.duration;
  state.peaks = buildPeaks(audioBuffer);
});

document.getElementById('swayIntensity').addEventListener('change', (e) => {
  if (state.bgImage) state.swaySeed = makeSwaySeed(e.target.value);
});

// ---------- EXPORT (frame-by-frame -> ffmpeg) ----------
document.getElementById('exportBtn').addEventListener('click', exportVideo);

async function exportVideo() {
  if (!state.bgImage) return alert('Pilih background dulu.');
  if (!state.audioFile || !state.duration) return alert('Pilih audio dulu.');

  const resMap = { '480': [854, 480], '720': [1280, 720], '1080': [1920, 1080] };
  const [W, H] = resMap[document.getElementById('resSelect').value];
  const fps = parseInt(document.getElementById('fpsSelect').value, 10);
  const totalFrames = Math.ceil(state.duration * fps);

  const exportBtn = document.getElementById('exportBtn');
  const progressWrap = document.getElementById('progressWrap');
  const progressFill = document.getElementById('progressFill');
  const progressLabel = document.getElementById('progressLabel');
  const resultPath = document.getElementById('resultPath');

  exportBtn.disabled = true;
  progressWrap.classList.remove('hidden');
  resultPath.classList.add('hidden');

  // offscreen canvas resolusi export (beda dari canvas preview)
  const off = document.createElement('canvas');
  off.width = W;
  off.height = H;
  const offCtx = off.getContext('2d');

  const { Filesystem, Directory } = window.CapacitorFilesystem || {};
  if (!Filesystem) {
    alert('Plugin Filesystem belum aktif. Jalankan di dalam APK (Capacitor), bukan browser biasa.');
    exportBtn.disabled = false;
    return;
  }

  const jobId = 'job_' + Date.now();
  const framesDir = `render/${jobId}/frames`;
  await Filesystem.mkdir({ path: framesDir, directory: Directory.Cache, recursive: true }).catch(() => {});

  // render tiap frame ke offscreen canvas lalu simpan sebagai jpg
  for (let i = 0; i < totalFrames; i++) {
    const t = i / fps;
    drawFrameTo(offCtx, t, W, H);
    const dataUrl = off.toDataURL('image/jpeg', 0.92);
    const base64 = dataUrl.split(',')[1];
    const name = `frame_${String(i).padStart(6, '0')}.jpg`;
    await Filesystem.writeFile({
      path: `${framesDir}/${name}`,
      data: base64,
      directory: Directory.Cache,
    });

    if (i % 5 === 0 || i === totalFrames - 1) {
      const pct = Math.round((i / totalFrames) * 70); // render frame = 0-70%
      progressFill.style.width = pct + '%';
      progressLabel.textContent = `Render frame ${i + 1}/${totalFrames}`;
      await new Promise((r) => setTimeout(r, 0)); // kasih napas ke UI thread
    }
  }

  // simpan file audio ke cache juga
  progressLabel.textContent = 'Menyiapkan audio…';
  const audioExt = (state.audioFile.name.split('.').pop() || 'mp3').toLowerCase();
  const audioBase64 = await blobToBase64(state.audioFile);
  const audioPath = `render/${jobId}/audio.${audioExt}`;
  await Filesystem.writeFile({ path: audioPath, data: audioBase64, directory: Directory.Cache });

  progressFill.style.width = '75%';
  progressLabel.textContent = 'Encoding ke .mp4 …';

  // ambil path absolut di filesystem device
  const framesUri = (await Filesystem.getUri({ path: framesDir, directory: Directory.Cache })).uri;
  const audioUri = (await Filesystem.getUri({ path: audioPath, directory: Directory.Cache })).uri;
  const outputName = `ijichi_${Date.now()}.mp4`;

  try {
    const FfmpegExec = window.Capacitor?.Plugins?.FfmpegExec;
    if (!FfmpegExec) throw new Error('Plugin FfmpegExec belum terpasang di native side.');

    const result = await FfmpegExec.run({
      framesDir: uriToPath(framesUri),
      audioPath: uriToPath(audioUri),
      fps: fps,
      width: W,
      height: H,
      outputName: outputName,
    });

    progressFill.style.width = '100%';
    progressLabel.textContent = 'Selesai!';
    resultPath.textContent = 'Tersimpan di: ' + result.outputPath;
    resultPath.classList.remove('hidden');
  } catch (err) {
    progressLabel.textContent = 'Gagal encode: ' + (err.message || err);
  } finally {
    exportBtn.disabled = false;
  }
}

function drawFrameTo(targetCtx, t, W, H) {
  _renderCore(targetCtx, t, W, H);
}

function _renderCore(c, t, W, H) {
  c.clearRect(0, 0, W, H);
  c.fillStyle = '#000';
  c.fillRect(0, 0, W, H);

  if (state.bgImage) {
    const sway = swayAt(state.swaySeed, t);
    const img = state.bgImage;
    const scaleBase = Math.max(W / img.width, H / img.height) * 1.12;
    const drawW = img.width * scaleBase * sway.scale;
    const drawH = img.height * scaleBase * sway.scale;

    c.save();
    c.translate(W / 2 + sway.x * (W / 720), H / 2 + sway.y * (W / 720));
    c.rotate((sway.rotDeg * Math.PI) / 180);
    c.drawImage(img, -drawW / 2, -drawH / 2, drawW, drawH);
    c.restore();
  }

  const grad = c.createLinearGradient(0, H * 0.55, 0, H);
  grad.addColorStop(0, 'rgba(0,0,0,0)');
  grad.addColorStop(1, 'rgba(0,0,0,0.75)');
  c.fillStyle = grad;
  c.fillRect(0, H * 0.55, W, H * 0.45);

  if (state.peaks.length) {
    const barCount = state.peaks.length;
    const barAreaW = W * 0.86;
    const startX = W * 0.07;
    const baseY = H * 0.86;
    const barW = (barAreaW / barCount) * 0.6;
    const gap = (barAreaW / barCount) * 0.4;
    const progress = state.duration ? t / state.duration : 0;
    for (let i = 0; i < barCount; i++) {
      const h = Math.max(3, state.peaks[i] * H * 0.09);
      const x = startX + i * (barW + gap);
      const played = i / barCount <= progress;
      c.fillStyle = played ? '#ff6a3d' : 'rgba(255,255,255,0.28)';
      c.fillRect(x, baseY - h / 2, barW, h);
    }
  }

  const artist = document.getElementById('artistName').value || '';
  const title = document.getElementById('songTitle').value || '';
  const watermark = document.getElementById('watermark').value || '';

  c.textBaseline = 'alphabetic';
  c.shadowColor = 'rgba(0,0,0,0.8)';
  c.shadowBlur = 10;

  c.font = `700 ${Math.round(H * 0.032)}px sans-serif`;
  c.fillStyle = '#fff';
  c.fillText(artist, W * 0.06, H * 0.75);

  c.font = `500 ${Math.round(H * 0.024)}px sans-serif`;
  c.fillStyle = 'rgba(255,255,255,0.9)';
  wrapTextOn(c, title, W * 0.06, H * 0.80, W * 0.88, H * 0.028);

  c.font = `400 ${Math.round(H * 0.016)}px monospace`;
  c.fillStyle = 'rgba(255,255,255,0.7)';
  c.fillText(formatTime(t), W * 0.06, H * 0.90);

  if (watermark) {
    c.font = `600 ${Math.round(H * 0.018)}px sans-serif`;
    c.textAlign = 'right';
    c.fillStyle = 'rgba(255,255,255,0.55)';
    c.fillText(watermark, W * 0.94, H * 0.94);
    c.textAlign = 'left';
  }
  c.shadowBlur = 0;
}

function wrapTextOn(c, text, x, y, maxWidth, lineHeight) {
  const words = text.split(' ');
  let line = '';
  let cy = y;
  let lines = 0;
  for (const word of words) {
    const test = line + word + ' ';
    if (c.measureText(test).width > maxWidth && line !== '') {
      c.fillText(line, x, cy);
      line = word + ' ';
      cy += lineHeight;
      lines++;
      if (lines >= 2) return;
    } else {
      line = test;
    }
  }
  c.fillText(line, x, cy);
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function uriToPath(uri) {
  return uri.startsWith('file://') ? uri.replace('file://', '') : uri;
}
