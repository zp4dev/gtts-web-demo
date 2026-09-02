// Căn chữ theo thời gian phát, dựa trên chính tín hiệu audio.
//
// API /audio chỉ trả về mp3, không kèm timestamp, nên không có căn chỉnh thật
// (forced alignment). Cách làm ở đây: dò các đoạn CÓ TIẾNG bằng năng lượng RMS,
// rồi rải chữ vào đúng những đoạn đó theo độ dài từng từ. Nhờ bám vào khoảng lặng
// thật của giọng đọc, chữ không bao giờ chạy trong lúc im lặng — sai số chủ yếu
// nằm trong từng cụm, không tích luỹ dồn về cuối như kiểu chia đều tuyến tính.
//
// Đây vẫn là ƯỚC LƯỢNG, không phải mốc thời gian do TTS cung cấp.

(function (global) {
  "use strict";

  const FRAME_SECONDS = 0.02;   // cửa sổ tính RMS
  const MIN_GAP = 0.12;         // khoảng lặng ngắn hơn mức này thì nối liền hai đoạn
  const MIN_SEGMENT = 0.06;     // đoạn tiếng ngắn hơn mức này coi như nhiễu
  const PAD = 0.02;             // nới nhẹ hai đầu cho khỏi cắt cụt phụ âm

  /**
   * Dò các đoạn có tiếng nói.
   * @returns {{start:number,end:number}[]} tính bằng giây
   */
  function detectSpeechSegments(samples, sampleRate) {
    const frameSize = Math.max(1, Math.round(sampleRate * FRAME_SECONDS));
    const frameCount = Math.floor(samples.length / frameSize);
    if (!frameCount) return [];

    const energies = new Float32Array(frameCount);
    for (let f = 0; f < frameCount; f++) {
      let sum = 0;
      const from = f * frameSize;
      for (let i = from; i < from + frameSize; i++) sum += samples[i] * samples[i];
      energies[f] = Math.sqrt(sum / frameSize);
    }

    // Ngưỡng đặt tương đối: nền nhiễu lấy ở phân vị 10, đỉnh ở phân vị 95,
    // nên file to nhỏ khác nhau vẫn dùng chung một logic.
    const sorted = Float32Array.from(energies).sort();
    const floor = sorted[Math.floor(frameCount * 0.1)];
    const loud = sorted[Math.floor(frameCount * 0.95)] || sorted[frameCount - 1];
    const high = Math.max(floor * 3, loud * 0.08, 1e-5);
    const low = high * 0.6; // trễ ngưỡng: vào bằng high, ra bằng low

    const segments = [];
    let speaking = false;
    let start = 0;

    for (let f = 0; f < frameCount; f++) {
      const time = f * FRAME_SECONDS;
      if (!speaking && energies[f] >= high) {
        speaking = true;
        start = time;
      } else if (speaking && energies[f] < low) {
        speaking = false;
        segments.push({ start, end: time });
      }
    }
    if (speaking) segments.push({ start, end: frameCount * FRAME_SECONDS });

    // Nối các đoạn cách nhau quá gần rồi bỏ đoạn quá ngắn.
    const merged = [];
    for (const segment of segments) {
      const previous = merged[merged.length - 1];
      if (previous && segment.start - previous.end < MIN_GAP) previous.end = segment.end;
      else merged.push({ ...segment });
    }

    const duration = samples.length / sampleRate;
    return merged
      .filter((segment) => segment.end - segment.start >= MIN_SEGMENT)
      .map((segment) => ({
        start: Math.max(0, segment.start - PAD),
        end: Math.min(duration, segment.end + PAD),
      }));
  }

  // Tách văn bản thành từ, giữ lại vị trí gốc để dựng lại nguyên vẹn khoảng trắng.
  // `at`/`until` là chỉ số KÝ TỰ; `start`/`end` (gán sau khi căn) là mốc THỜI GIAN —
  // hai thứ khác đơn vị nên phải khác tên, đừng dùng chung `end`.
  function tokenize(text) {
    const tokens = [];
    const pattern = /\S+/g;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      tokens.push({ text: match[0], at: match.index, until: match.index + match[0].length });
    }
    return tokens;
  }

  // Từ dài đọc lâu hơn từ ngắn; dấu câu cuối từ thì thêm một nhịp nghỉ.
  function weigh(word) {
    const letters = word.replace(/[^\p{L}\p{N}]/gu, "").length;
    const pause = /[.!?…]$/.test(word) ? 2.2 : /[,;:]$/.test(word) ? 1.2 : 0;
    return Math.max(1, letters) + pause;
  }

  // Cắt theo dấu câu mạnh — mỗi cụm thường ứng với một đoạn hơi của giọng đọc.
  function chunkByPunctuation(tokens) {
    const chunks = [];
    let currentChunk = [];
    for (const token of tokens) {
      currentChunk.push(token);
      if (/[.!?…]["')\]]?$/.test(token.text)) {
        chunks.push(currentChunk);
        currentChunk = [];
      }
    }
    if (currentChunk.length) chunks.push(currentChunk);
    return chunks;
  }

  // Rải một nhóm từ vào khoảng [start, end] theo trọng số.
  function spread(tokens, start, end) {
    const total = tokens.reduce((sum, token) => sum + weigh(token.text), 0) || 1;
    const span = Math.max(0, end - start);
    let at = start;
    for (const token of tokens) {
      const share = (weigh(token.text) / total) * span;
      token.start = at;
      token.end = at + share;
      at += share;
    }
  }

  /**
   * Gán mốc thời gian cho từng từ.
   * @param {string} text văn bản đã gửi cho API
   * @param {{start:number,end:number}[]} segments đoạn có tiếng
   * @param {number} duration tổng thời lượng (giây)
   * @returns {{tokens:object[], segments:object[], matched:boolean}}
   */
  function alignWords(text, segments, duration) {
    const tokens = tokenize(text);
    if (!tokens.length) return { tokens, segments, matched: false };

    const speech = segments?.length ? segments : [{ start: 0, end: duration }];
    const chunks = chunkByPunctuation(tokens);

    // Trường hợp đẹp: số cụm câu đúng bằng số đoạn tiếng → ghép 1-1.
    if (chunks.length === speech.length) {
      chunks.forEach((chunk, index) => spread(chunk, speech[index].start, speech[index].end));
      return { tokens, segments: speech, matched: true };
    }

    // Ngược lại: dồn các đoạn tiếng thành một trục thời gian liên tục rồi rải đều
    // trên trục đó, sau đó ánh xạ ngược về thời gian thật. Cách này bỏ qua vị trí
    // dấu câu nhưng bảo đảm không có từ nào rơi vào khoảng lặng.
    const speechTime = speech.reduce((sum, s) => sum + (s.end - s.start), 0) || duration;
    const totalWeight = tokens.reduce((sum, token) => sum + weigh(token.text), 0) || 1;

    const toRealTime = (offset) => {
      let remaining = offset;
      for (const segment of speech) {
        const length = segment.end - segment.start;
        if (remaining <= length) return segment.start + remaining;
        remaining -= length;
      }
      return speech[speech.length - 1].end;
    };

    let cursor = 0;
    for (const token of tokens) {
      const share = (weigh(token.text) / totalWeight) * speechTime;
      token.start = toRealTime(cursor);
      token.end = toRealTime(cursor + share);
      cursor += share;
    }
    return { tokens, segments: speech, matched: false };
  }

  /**
   * Từ đang được đọc: từ cuối cùng đã bắt đầu tính tới thời điểm `time`.
   * Trả về -1 khi audio còn chưa tới từ đầu tiên. Trong lúc nghỉ giữa hai cụm,
   * từ vừa đọc xong vẫn được giữ sáng thay vì nhảy sớm sang từ kế tiếp.
   */
  function activeIndex(tokens, time) {
    let index = -1;
    for (let i = 0; i < tokens.length; i++) {
      if (time < tokens[i].start) break;
      index = i;
    }
    return index;
  }

  const api = { detectSpeechSegments, alignWords, activeIndex, tokenize, weigh };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  global.Align = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
