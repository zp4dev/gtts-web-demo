// gTTS Web Demo — talks to the FastAPI backend via POST /audio?text=...&lang=...
// Requests go through /api/audio (same-origin proxy) so the browser never hits CORS.

const API = "/api/audio";
const MAX_WORDS = 150; // backend rejects text with more than 150 words

// gTTS supported languages (gtts.lang.tts_langs())
const LANGS = {
  af: "Afrikaans", am: "Amharic", ar: "Arabic", bg: "Bulgarian", bn: "Bengali",
  bs: "Bosnian", ca: "Catalan", cs: "Czech", cy: "Welsh", da: "Danish",
  de: "German", el: "Greek", en: "English", es: "Spanish", et: "Estonian",
  eu: "Basque", fi: "Finnish", fr: "French", "fr-CA": "French (Canada)",
  gl: "Galician", gu: "Gujarati", ha: "Hausa", hi: "Hindi", hr: "Croatian",
  hu: "Hungarian", id: "Indonesian", is: "Icelandic", it: "Italian",
  iw: "Hebrew", ja: "Japanese", jw: "Javanese", km: "Khmer", kn: "Kannada",
  ko: "Korean", la: "Latin", lt: "Lithuanian", lv: "Latvian", ml: "Malayalam",
  mr: "Marathi", ms: "Malay", my: "Myanmar (Burmese)", ne: "Nepali",
  nl: "Dutch", no: "Norwegian", pa: "Punjabi (Gurmukhi)", pl: "Polish",
  pt: "Portuguese (Brazil)", "pt-PT": "Portuguese (Portugal)", ro: "Romanian",
  ru: "Russian", si: "Sinhala", sk: "Slovak", sq: "Albanian", sr: "Serbian",
  su: "Sundanese", sv: "Swedish", sw: "Swahili", ta: "Tamil", te: "Telugu",
  th: "Thai", tl: "Filipino", tr: "Turkish", uk: "Ukrainian", ur: "Urdu",
  vi: "Vietnamese", yue: "Cantonese", "zh-CN": "Chinese (Simplified)",
  "zh-TW": "Chinese (Mandarin/Taiwan)", zh: "Chinese (Mandarin)",
};

const $ = (id) => document.getElementById(id);
const el = {
  text: $("text"), lang: $("lang"), generate: $("generate"),
  wordCount: $("wordCount"), counter: $("counter"), error: $("error"),
  empty: $("empty"), result: $("result"), audio: $("audio"),
  download: $("download"), metaLang: $("metaLang"), metaSize: $("metaSize"),
  history: $("history"), clearHistory: $("clearHistory"), status: $("status"),
  analysis: $("analysis"), waveform: $("waveform"),
  waveformWrap: $("waveformWrap"), waveformTime: $("waveformTime"),
};

const history = []; // { snippet, lang, url, size, info, timing, loudness }

let audioContext = null; // tạo trễ, dùng lại cho mọi lần decode
let current = -1;        // vị trí trong history đang hiển thị
let playheadFrame = 0;   // id requestAnimationFrame của vòng vẽ playhead
let hoverRatio = null;   // vị trí chuột trên waveform, 0..1

// ---------- setup ----------

function buildLangOptions() {
  const entries = Object.entries(LANGS).sort((a, b) => a[1].localeCompare(b[1]));
  for (const [code, name] of entries) {
    const opt = document.createElement("option");
    opt.value = code;
    opt.textContent = `${name} — ${code}`;
    el.lang.append(opt);
  }
  el.lang.value = localStorage.getItem("gtts.lang") || "vi";
}

function countWords(value) {
  const trimmed = value.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

function updateCounter() {
  const words = countWords(el.text.value);
  el.wordCount.textContent = words;
  el.counter.classList.toggle("over", words > MAX_WORDS);
  el.generate.disabled = words === 0 || words > MAX_WORDS;
}

function setStatus(state, text) {
  el.status.dataset.state = state;
  el.status.querySelector(".status-text").textContent = text;
}

function showError(message) {
  el.error.textContent = message;
  el.error.hidden = false;
}

function clearError() {
  el.error.hidden = true;
}

function formatSize(bytes) {
  return bytes < 1024 * 1024
    ? `${(bytes / 1024).toFixed(1)} KB`
    : `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function formatDuration(seconds) {
  const mm = Math.floor(seconds / 60);
  const ss = seconds % 60;
  return mm ? `${mm}:${ss.toFixed(2).padStart(5, "0")}` : `${ss.toFixed(3)} s`;
}

function formatMs(ms) {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
  return ms < 10 ? `${ms.toFixed(2)} ms` : `${ms.toFixed(0)} ms`;
}

function toDbfs(value) {
  return value > 0 ? `${(20 * Math.log10(value)).toFixed(1)} dBFS` : "−∞ dBFS";
}

// ---------- phân tích âm lượng + dạng sóng (Web Audio) ----------

async function decodeAudio(buffer) {
  audioContext ??= new (window.AudioContext || window.webkitAudioContext)();
  // decodeAudioData "nuốt" ArrayBuffer nên phải đưa bản sao.
  const decoded = await audioContext.decodeAudioData(buffer.slice(0));
  const samples = decoded.getChannelData(0);

  let peak = 0;
  let sumSquares = 0;
  for (const sample of samples) {
    const abs = Math.abs(sample);
    if (abs > peak) peak = abs;
    sumSquares += sample * sample;
  }

  // Khoảng lặng đầu/cuối: ngưỡng −60 dBFS.
  const floor = 0.001;
  let lead = 0;
  while (lead < samples.length && Math.abs(samples[lead]) < floor) lead++;
  let trail = samples.length - 1;
  while (trail > lead && Math.abs(samples[trail]) < floor) trail--;

  return {
    peak,
    rms: Math.sqrt(sumSquares / samples.length),
    leadSilence: lead / decoded.sampleRate,
    trailSilence: (samples.length - 1 - trail) / decoded.sampleRate,
    decodedRate: decoded.sampleRate,
    decodedDuration: decoded.duration,
    samples,
  };
}

// Gộp sample thành từng cột min/max theo bề rộng canvas. Tính một lần rồi
// dùng lại cho mọi khung hình khi phát — mỗi frame chỉ việc vẽ lại các cột.
function computePeaks(samples, width) {
  const peaks = new Float32Array(width * 2);
  const step = samples.length / width;
  for (let x = 0; x < width; x++) {
    const from = Math.floor(x * step);
    const to = Math.min(Math.floor((x + 1) * step), samples.length);
    let min = 0;
    let max = 0;
    for (let i = from; i < to; i++) {
      if (samples[i] < min) min = samples[i];
      if (samples[i] > max) max = samples[i];
    }
    peaks[x * 2] = min;
    peaks[x * 2 + 1] = max;
  }
  return peaks;
}

function waveformWidth() {
  return Math.max(1, Math.round(el.waveform.clientWidth || 900));
}

// progress/hover là tỉ lệ 0..1; phần đã nghe được tô sáng, phần còn lại xám mờ.
function drawWaveform(peaks, progress = 0, hover = null) {
  const canvas = el.waveform;
  const ratio = window.devicePixelRatio || 1;
  const width = waveformWidth();
  const height = 90;

  canvas.width = width * ratio;
  canvas.height = height * ratio;
  canvas.style.height = `${height}px`;

  const ctx = canvas.getContext("2d");
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const middle = height / 2;
  ctx.strokeStyle = "rgba(139, 147, 167, 0.30)";
  ctx.beginPath();
  ctx.moveTo(0, middle);
  ctx.lineTo(width, middle);
  ctx.stroke();

  if (!peaks) return;

  const headX = Math.round(progress * width);
  const gradient = ctx.createLinearGradient(0, 0, width, 0);
  gradient.addColorStop(0, "#6d7cff");
  gradient.addColorStop(1, "#29d3b0");

  const columns = Math.min(width, peaks.length / 2);
  for (let x = 0; x < columns; x++) {
    const min = peaks[x * 2];
    const max = peaks[x * 2 + 1];
    const top = middle - max * middle * 0.92;
    const barHeight = Math.max(1, (max - min) * middle * 0.92);
    ctx.fillStyle = x < headX ? gradient : "rgba(139, 147, 167, 0.42)";
    ctx.fillRect(x, top, 1, barHeight);
  }

  if (hover !== null) {
    const hoverX = Math.round(hover * width);
    ctx.fillStyle = "rgba(231, 233, 240, 0.22)";
    ctx.fillRect(hoverX, 0, 1, height);
  }

  if (progress > 0 || !el.audio.paused) {
    ctx.fillStyle = "#e7e9f0";
    ctx.fillRect(Math.min(headX, width - 2), 0, 2, height);
    ctx.fillStyle = "#29d3b0";
    ctx.fillRect(Math.min(headX, width - 2) - 1, 0, 4, 3);
    ctx.fillRect(Math.min(headX, width - 2) - 1, height - 3, 4, 3);
  }
}

function formatClock(seconds) {
  if (!Number.isFinite(seconds)) return "0:00.0";
  const mm = Math.floor(seconds / 60);
  const ss = seconds - mm * 60;
  return `${mm}:${ss.toFixed(1).padStart(4, "0")}`;
}

// Thời lượng lấy từ parser: chính xác hơn audio.duration, vốn có thể là NaN
// lúc metadata chưa nạp xong hoặc Infinity với stream không có Xing header.
function trackDuration() {
  const item = history[current];
  const parsed = item?.info?.ok ? item.info.duration : 0;
  return Number.isFinite(el.audio.duration) && el.audio.duration > 0
    ? el.audio.duration
    : parsed;
}

function renderPlayhead() {
  const item = history[current];
  if (!item) return;
  const total = trackDuration();
  const progress = total > 0 ? Math.min(1, el.audio.currentTime / total) : 0;
  drawWaveform(item.peaks, progress, hoverRatio);
  el.waveformTime.textContent = `${formatClock(el.audio.currentTime)} / ${formatClock(total)}`;
}

// Chỉ chạy vòng rAF khi đang phát, để lúc dừng không tốn CPU.
function startPlayheadLoop() {
  cancelAnimationFrame(playheadFrame);
  const tick = () => {
    renderPlayhead();
    if (!el.audio.paused && !el.audio.ended) playheadFrame = requestAnimationFrame(tick);
  };
  tick();
}

function seekFromPointer(event) {
  const total = trackDuration();
  if (!total) return;
  const rect = el.waveform.getBoundingClientRect();
  const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
  el.audio.currentTime = ratio * total;
  renderPlayhead();
}

// ---------- bảng thông số ----------

function renderAnalysis(item) {
  const { info, timing, loudness } = item;
  el.analysis.replaceChildren();

  if (!info?.ok) {
    const warning = document.createElement("p");
    warning.className = "analysis-warning";
    warning.textContent = info?.error ?? "Không phân tích được file.";
    el.analysis.append(warning);
    return;
  }

  const kbps = (bps) => `${Math.round(bps / 1000)} kbps`;
  // VBR thì bitrate của frame đầu không đại diện cho cả file — hiện giá trị trung bình.
  const bitrateText = info.mode === "VBR"
    ? `~${kbps(info.averageBitrate)} · VBR`
    : `${kbps(info.bitrate)} · CBR`;

  const groups = [
    ["Định dạng", [
      ["Chuẩn", `${info.version} ${info.layer}`],
      ["Bitrate", bitrateText],
      ["Tần số lấy mẫu", `${info.sampleRate.toLocaleString("vi-VN")} Hz`],
      ["Kênh", `${info.channelMode} (${info.channels}ch)`],
      ["CRC", info.crc ? "có" : "không"],
      ["Emphasis", info.emphasis],
    ]],
    ["Nội dung", [
      ["Thời lượng", formatDuration(info.duration)],
      ["Số frame", info.frameCount.toLocaleString("vi-VN")],
      ["Sample/frame", info.samplesPerFrame],
      ["Tổng sample", info.totalSamples.toLocaleString("vi-VN")],
      ["Kích thước", formatSize(info.bytes)],
      ["Ngoài audio", `${info.overheadBytes} B`],
    ]],
    ["Encoder", [
      ["Tên", info.encoder ?? "không khai báo"],
      ["VBR header", info.vbrTag ?? "không có"],
      ["Delay đầu", `${info.encoderDelay} sample`],
      ["Padding cuối", `${info.encoderPadding} sample`],
      ["Thời lượng thô", formatDuration(info.rawDuration)],
      ["ID3", [info.id3v2 && "v2", info.id3v1 && "v1"].filter(Boolean).join(" + ") || "không có"],
    ]],
    ["Âm lượng", loudness ? [
      ["Đỉnh", toDbfs(loudness.peak)],
      ["RMS", toDbfs(loudness.rms)],
      ["Lặng đầu", `${loudness.leadSilence.toFixed(3)} s`],
      ["Lặng cuối", `${loudness.trailSilence.toFixed(3)} s`],
    ] : [["Trạng thái", "trình duyệt không decode được"]]],
    ["Thời gian tạo", [
      ["Backend xử lý", formatMs(timing.server)],
      ["Tải về", formatMs(timing.download)],
      ["Phân tích", formatMs(timing.analyze)],
      ["Tổng", formatMs(timing.total)],
      ["Tốc độ", `${(info.bytes / 1024 / (timing.total / 1000)).toFixed(0)} KB/s`],
      ["So với realtime", `${(info.duration / (timing.total / 1000)).toFixed(1)}×`],
    ]],
  ];

  for (const [title, rows] of groups) {
    const section = document.createElement("section");
    section.className = "analysis-group";

    const heading = document.createElement("h3");
    heading.textContent = title;
    section.append(heading);

    const list = document.createElement("dl");
    for (const [label, value] of rows) {
      const dt = document.createElement("dt");
      dt.textContent = label;
      const dd = document.createElement("dd");
      dd.textContent = value;
      list.append(dt, dd);
    }
    section.append(list);
    el.analysis.append(section);
  }

  // Chỉ ghi chú những thứ bất thường; phần bình thường đã nằm trong bảng.
  const notes = [];
  if (info.id3v2) notes.push(`ID3v2 chiếm ${info.id3v2Size} B đầu file`);
  if (info.skippedBytes) notes.push(`${info.skippedBytes} B không phải frame, đã bỏ qua khi resync`);
  if (info.declaredFrames !== null && info.declaredFrames !== info.frameCount) {
    notes.push(`header khai ${info.declaredFrames} frame nhưng đếm được ${info.frameCount}`);
  }
  if (notes.length) {
    const note = document.createElement("p");
    note.className = "analysis-note";
    note.textContent = notes.join(" · ");
    el.analysis.append(note);
  }
}

// ---------- API ----------

async function checkHealth() {
  setStatus("checking", "Đang kiểm tra API…");
  try {
    const res = await fetch("/api/health");
    const body = await res.json();
    if (body.ok) setStatus("online", "API sẵn sàng");
    else setStatus("offline", "Backend chưa chạy");
  } catch {
    setStatus("offline", "Không kết nối được");
  }
}

async function generate() {
  const text = el.text.value.trim();
  const lang = el.lang.value;
  if (!text) return;

  clearError();
  el.generate.disabled = true;
  el.generate.classList.add("loading");
  el.generate.querySelector(".label").textContent = "Đang tạo…";

  const started = performance.now();

  try {
    const url = `${API}?text=${encodeURIComponent(text)}&lang=${encodeURIComponent(lang)}`;
    const res = await fetch(url, { method: "POST" });
    // fetch() resolve khi header về → mốc này là thời gian backend tạo xong mp3.
    const headersAt = performance.now();

    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const body = await res.json();
        if (typeof body.detail === "string") detail = body.detail;
        else if (Array.isArray(body.detail)) detail = body.detail.map((d) => d.msg).join("; ");
      } catch { /* response was not JSON */ }
      throw new Error(detail);
    }

    const buffer = await res.arrayBuffer();
    const downloadedAt = performance.now();

    const info = MP3.analyze(buffer);
    const analyzedAt = performance.now();

    // Decode chỉ để lấy đỉnh/RMS + dạng sóng; hỏng thì bảng thông số vẫn hiện.
    let loudness = null;
    try {
      loudness = await decodeAudio(buffer);
    } catch (err) {
      console.warn("Web Audio không decode được:", err);
    }

    const blob = new Blob([buffer], { type: "audio/mpeg" });
    addResult({
      snippet: text.length > 70 ? `${text.slice(0, 70)}…` : text,
      lang,
      url: URL.createObjectURL(blob),
      size: blob.size,
      info,
      loudness,
      timing: {
        server: headersAt - started,
        download: downloadedAt - headersAt,
        analyze: analyzedAt - downloadedAt,
        total: analyzedAt - started,
      },
    });
    localStorage.setItem("gtts.lang", lang);
    setStatus("online", "API sẵn sàng");
  } catch (err) {
    showError(`Tạo audio thất bại: ${err.message}`);
    setStatus("offline", "Lỗi khi gọi API");
  } finally {
    el.generate.classList.remove("loading");
    el.generate.querySelector(".label").textContent = "Tạo audio";
    updateCounter();
  }
}

// ---------- results & history ----------

function addResult(item) {
  history.unshift(item);
  renderHistory();
  play(0, { autoplay: true });
}

function play(index, { autoplay = false } = {}) {
  const item = history[index];
  if (!item) return;

  current = index;
  el.empty.hidden = true;
  el.result.hidden = false;
  el.audio.src = item.url;
  el.download.href = item.url;
  el.download.download = `gtts-${item.lang}-${Date.now()}.mp3`;
  el.metaLang.textContent = `${LANGS[item.lang] ?? item.lang} · ${item.lang}`;
  el.metaSize.textContent = item.info?.ok
    ? `${formatSize(item.size)} · ${formatDuration(item.info.duration)}`
    : formatSize(item.size);

  renderAnalysis(item);
  // Peaks phụ thuộc bề rộng canvas nên cache kèm bề rộng đã dùng.
  const width = waveformWidth();
  if (item.loudness?.samples && item.peaksWidth !== width) {
    item.peaks = computePeaks(item.loudness.samples, width);
    item.peaksWidth = width;
  }
  el.audio.currentTime = 0;
  renderPlayhead();

  if (autoplay) el.audio.play().catch(() => { /* autoplay may be blocked */ });

  for (const [i, node] of [...el.history.children].entries()) {
    node.classList.toggle("active", i === index);
  }
}

function renderHistory() {
  el.history.replaceChildren();
  el.clearHistory.hidden = history.length === 0;

  history.forEach((item, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "history-item" + (index === 0 ? " active" : "");
    button.innerHTML = `
      <span class="play"><svg viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 20 12 6 20"/></svg></span>
      <span class="snippet"></span>
      <span class="tag"></span>`;
    button.querySelector(".tag").textContent = item.info?.ok
      ? `${item.lang} · ${item.info.duration.toFixed(1)}s · ${formatSize(item.size)}`
      : `${item.lang} · ${formatSize(item.size)}`;
    button.querySelector(".snippet").textContent = item.snippet;
    button.addEventListener("click", () => play(index, { autoplay: true }));
    el.history.append(button);
  });
}

function clearHistory() {
  for (const item of history) URL.revokeObjectURL(item.url);
  history.length = 0;
  current = -1;
  el.audio.pause();
  el.audio.removeAttribute("src");
  el.analysis.replaceChildren();
  el.result.hidden = true;
  el.empty.hidden = false;
  renderHistory();
}

// ---------- events ----------

el.text.addEventListener("input", updateCounter);

el.text.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && !el.generate.disabled) {
    event.preventDefault();
    generate();
  }
});

el.generate.addEventListener("click", generate);
el.clearHistory.addEventListener("click", clearHistory);

// --- playhead: bám theo audio và cho phép tua bằng chuột ---

el.audio.addEventListener("play", startPlayheadLoop);
for (const event of ["pause", "ended", "seeked", "loadedmetadata"]) {
  el.audio.addEventListener(event, renderPlayhead);
}

el.waveform.addEventListener("pointerdown", (event) => {
  el.waveform.setPointerCapture(event.pointerId);
  seekFromPointer(event);
});

el.waveform.addEventListener("pointermove", (event) => {
  const rect = el.waveform.getBoundingClientRect();
  hoverRatio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
  // Giữ nút chuột và rê ngang = tua liên tục.
  if (el.waveform.hasPointerCapture(event.pointerId)) seekFromPointer(event);
  else renderPlayhead();
});

el.waveform.addEventListener("pointerup", (event) => {
  el.waveform.releasePointerCapture(event.pointerId);
});

el.waveform.addEventListener("pointerleave", () => {
  hoverRatio = null;
  renderPlayhead();
});

// Canvas vẽ theo pixel thật nên phải dựng lại peaks khi khung đổi kích thước.
let resizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const item = history[current];
    if (!item?.loudness?.samples) return;
    const width = waveformWidth();
    if (item.peaksWidth !== width) {
      item.peaks = computePeaks(item.loudness.samples, width);
      item.peaksWidth = width;
    }
    renderPlayhead();
  }, 120);
});

for (const chip of document.querySelectorAll(".chip")) {
  chip.addEventListener("click", () => {
    el.text.value = chip.dataset.text;
    el.lang.value = chip.dataset.lang;
    el.text.focus();
    updateCounter();
  });
}

buildLangOptions();
updateCounter();
checkHealth();
