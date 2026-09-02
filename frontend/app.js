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
};

const history = []; // { snippet, lang, url, size }

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

  try {
    const url = `${API}?text=${encodeURIComponent(text)}&lang=${encodeURIComponent(lang)}`;
    const res = await fetch(url, { method: "POST" });

    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const body = await res.json();
        if (typeof body.detail === "string") detail = body.detail;
        else if (Array.isArray(body.detail)) detail = body.detail.map((d) => d.msg).join("; ");
      } catch { /* response was not JSON */ }
      throw new Error(detail);
    }

    const blob = await res.blob();
    addResult({
      snippet: text.length > 70 ? `${text.slice(0, 70)}…` : text,
      lang,
      url: URL.createObjectURL(blob),
      size: blob.size,
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

  el.empty.hidden = true;
  el.result.hidden = false;
  el.audio.src = item.url;
  el.download.href = item.url;
  el.download.download = `gtts-${item.lang}-${Date.now()}.mp3`;
  el.metaLang.textContent = `${LANGS[item.lang] ?? item.lang} · ${item.lang}`;
  el.metaSize.textContent = formatSize(item.size);

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
      <span class="tag">${item.lang} · ${formatSize(item.size)}</span>`;
    button.querySelector(".snippet").textContent = item.snippet;
    button.addEventListener("click", () => play(index, { autoplay: true }));
    el.history.append(button);
  });
}

function clearHistory() {
  for (const item of history) URL.revokeObjectURL(item.url);
  history.length = 0;
  el.audio.pause();
  el.audio.removeAttribute("src");
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
