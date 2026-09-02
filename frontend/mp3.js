// Phân tích file MP3 ngay trong trình duyệt: đọc thẳng MPEG frame header,
// không dùng thư viện ngoài. Trả về thông số định dạng + thống kê frame.
//
// Tham chiếu: ISO/IEC 11172-3 (MPEG-1) và 13818-3 (MPEG-2), phần frame header.
//
//   byte0    byte1    byte2    byte3
//   11111111 111VVLLP BBBBSSPp CCXXCORR
//   V=version L=layer P=protection B=bitrate S=samplerate p=padding
//   C=channel mode X=mode extension O=original R=emphasis

(function (global) {
  "use strict";

  const VERSIONS = { 0: "MPEG 2.5", 1: null, 2: "MPEG 2", 3: "MPEG 1" };
  const LAYERS = { 0: null, 1: "Layer III", 2: "Layer II", 3: "Layer I" };

  // [version][layer] → bảng bitrate (kbps); index 0 = "free", 15 = không hợp lệ
  const BITRATES = {
    // MPEG 1
    "3-3": [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448], // Layer I
    "3-2": [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],    // Layer II
    "3-1": [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],     // Layer III
    // MPEG 2 / 2.5
    "2-3": [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],    // Layer I
    "2-2": [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],         // Layer II
    "2-1": [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],         // Layer III
  };

  const SAMPLE_RATES = {
    3: [44100, 48000, 32000], // MPEG 1
    2: [22050, 24000, 16000], // MPEG 2
    0: [11025, 12000, 8000],  // MPEG 2.5
  };

  const CHANNEL_MODES = ["Stereo", "Joint stereo", "Dual channel", "Mono"];
  const EMPHASIS = ["none", "50/15 ms", "reserved", "CCIT J.17"];

  function bitrateTable(versionBits, layerBits) {
    const version = versionBits === 3 ? "3" : "2"; // MPEG 2.5 dùng chung bảng với MPEG 2
    return BITRATES[`${version}-${layerBits}`];
  }

  // Số sample mỗi frame: Layer I luôn 384; Layer II 1152;
  // Layer III là 1152 ở MPEG 1 nhưng chỉ 576 ở MPEG 2/2.5.
  function samplesPerFrame(versionBits, layerBits) {
    if (layerBits === 3) return 384;
    if (layerBits === 2) return 1152;
    return versionBits === 3 ? 1152 : 576;
  }

  function parseHeader(bytes, offset) {
    if (offset + 4 > bytes.length) return null;
    if (bytes[offset] !== 0xff || (bytes[offset + 1] & 0xe0) !== 0xe0) return null;

    const b1 = bytes[offset + 1];
    const b2 = bytes[offset + 2];
    const b3 = bytes[offset + 3];

    const versionBits = (b1 >> 3) & 0x03;
    const layerBits = (b1 >> 1) & 0x03;
    const bitrateIndex = (b2 >> 4) & 0x0f;
    const rateIndex = (b2 >> 2) & 0x03;

    if (versionBits === 1 || layerBits === 0) return null;      // giá trị reserved
    if (bitrateIndex === 0 || bitrateIndex === 15) return null; // free / invalid
    if (rateIndex === 3) return null;

    const sampleRate = SAMPLE_RATES[versionBits][rateIndex];
    const bitrate = bitrateTable(versionBits, layerBits)[bitrateIndex] * 1000;
    const padding = (b2 >> 1) & 0x01;
    const samples = samplesPerFrame(versionBits, layerBits);

    // Layer I tính theo slot 4 byte, Layer II/III theo slot 1 byte.
    const frameLength = layerBits === 3
      ? (Math.floor((12 * bitrate) / sampleRate) + padding) * 4
      : Math.floor(((samples / 8) * bitrate) / sampleRate) + padding;

    if (frameLength < 4) return null;

    return {
      version: VERSIONS[versionBits],
      layer: LAYERS[layerBits],
      versionBits,
      layerBits,
      bitrate,
      sampleRate,
      samples,
      frameLength,
      padding: Boolean(padding),
      crc: (b1 & 0x01) === 0,                       // bit protection: 0 = CÓ CRC
      channelMode: CHANNEL_MODES[(b3 >> 6) & 0x03],
      channels: ((b3 >> 6) & 0x03) === 3 ? 1 : 2,
      modeExtension: (b3 >> 4) & 0x03,
      copyright: Boolean((b3 >> 3) & 0x01),
      original: Boolean((b3 >> 2) & 0x01),
      emphasis: EMPHASIS[b3 & 0x03],
      private: Boolean((b2 >> 0) & 0x01),
    };
  }

  // ID3v2 nằm đầu file: "ID3" + ver(2) + flags(1) + size(4, syncsafe 7-bit).
  function id3v2Size(bytes) {
    if (bytes.length < 10) return 0;
    if (bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return 0;
    const size = ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) |
                 ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f);
    const footer = (bytes[5] & 0x10) ? 10 : 0;
    return 10 + size + footer;
  }

  function hasId3v1(bytes) {
    const at = bytes.length - 128;
    return at > 0 && bytes[at] === 0x54 && bytes[at + 1] === 0x41 && bytes[at + 2] === 0x47;
  }

  // Xing/Info/VBRI nằm trong frame ĐẦU TIÊN và không chứa audio — frame này phải
  // bị loại khỏi thời lượng, nếu không file sẽ dài dôi ra đúng một frame.
  //
  // Xing: "Xing"|"Info" + flags(4) + [frames(4)] + [bytes(4)] + [TOC(100)] + [quality(4)]
  // rồi tới LAME tag: 9 byte tên encoder … và ở offset 21 là 12 bit delay + 12 bit padding
  // (số sample encoder chèn thêm ở đầu/cuối; player bỏ đi để phát gapless).
  function parseVbrTag(bytes, frameStart, frameLength) {
    const end = Math.min(frameStart + frameLength, bytes.length);
    const text = (at, len) =>
      String.fromCharCode(...bytes.subarray(at, at + len)).replace(/\0+$/, "");
    const uint32 = (at) =>
      ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;

    for (let i = frameStart + 4; i + 4 <= end; i++) {
      const tag = text(i, 4);
      if (tag !== "Xing" && tag !== "Info" && tag !== "VBRI") continue;

      const result = { tag, frames: null, bytes: null, delay: 0, padding: 0, encoder: null };
      if (tag === "VBRI") {
        // VBRI (Fraunhofer): frame count là 4 byte ở offset 14 tính từ magic.
        if (i + 18 <= end) result.frames = uint32(i + 14);
        return result;
      }

      const flags = uint32(i + 4);
      let at = i + 8;
      if (flags & 0x01) { result.frames = uint32(at); at += 4; }
      if (flags & 0x02) { result.bytes = uint32(at); at += 4; }
      if (flags & 0x04) at += 100;   // bảng TOC
      if (flags & 0x08) at += 4;     // quality

      // LAME/Lavc tag ngay sau phần Xing, nếu còn đủ chỗ trong frame.
      if (at + 24 <= end) {
        const encoder = text(at, 9);
        if (/^(LAME|Lavc|Lavf)/.test(encoder)) {
          result.encoder = encoder;
          result.delay = (bytes[at + 21] << 4) | (bytes[at + 22] >> 4);
          result.padding = ((bytes[at + 22] & 0x0f) << 8) | bytes[at + 23];
        }
      }
      return result;
    }
    return null;
  }

  /**
   * @param {ArrayBuffer} buffer nội dung file mp3
   * @returns {object} thông số định dạng, thống kê frame, cảnh báo nếu có
   */
  function analyze(buffer) {
    const bytes = new Uint8Array(buffer);
    const id3Size = id3v2Size(bytes);

    const frames = [];
    const bitrates = new Set();
    const sampleRates = new Set();
    let totalSamples = 0;
    let audioBytes = 0;
    let firstFrame = null;      // frame đầu tiên đọc được (có thể là frame Xing)
    let firstAudioFrame = null; // frame audio thật đầu tiên
    let vbr = null;
    let garbage = 0; // số byte phải bỏ qua khi resync

    let i = id3Size;
    while (i + 4 <= bytes.length) {
      const header = parseHeader(bytes, i);
      if (!header) { i++; garbage++; continue; }

      if (!firstFrame) {
        firstFrame = header;
        vbr = parseVbrTag(bytes, i, header.frameLength);
        if (vbr) {
          // Frame chứa Xing/VBRI: chỉ là metadata, không tính vào audio.
          // Bitrate của nó cũng khác phần còn lại nên đừng gộp vào thống kê.
          vbr.frameBytes = header.frameLength;
          i += header.frameLength;
          continue;
        }
      }
      firstAudioFrame ??= header;
      frames.push(header.bitrate);
      bitrates.add(header.bitrate);
      sampleRates.add(header.sampleRate);
      totalSamples += header.samples;
      audioBytes += header.frameLength;
      i += header.frameLength;
    }

    if (!firstFrame) {
      return { ok: false, bytes: bytes.length, error: "Không tìm thấy MPEG frame hợp lệ" };
    }

    // Frame Xing (nếu có) đã bị loại, nên lấy mốc từ frame audio thật đầu tiên.
    const base = firstAudioFrame ?? firstFrame;
    const sampleRate = base.sampleRate;
    const averageBitrate = frames.length
      ? frames.reduce((sum, b) => sum + b, 0) / frames.length
      : base.bitrate;

    // Thời lượng thô = tổng sample / tần số. Nếu encoder ghi lại delay + padding
    // (LAME tag) thì trừ ra để khớp con số player/ffprobe hiển thị.
    const rawDuration = totalSamples / sampleRate;
    const trimmed = Math.max(0, totalSamples - (vbr?.delay ?? 0) - (vbr?.padding ?? 0));
    const duration = vbr?.encoder ? trimmed / sampleRate : rawDuration;

    return {
      ok: true,
      bytes: bytes.length,
      // định dạng
      version: base.version,
      layer: base.layer,
      bitrate: base.bitrate,
      averageBitrate,
      mode: bitrates.size > 1 || vbr?.tag === "Xing" ? "VBR" : "CBR",
      sampleRate,
      channelMode: base.channelMode,
      channels: base.channels,
      emphasis: base.emphasis,
      crc: base.crc,
      copyright: base.copyright,
      original: base.original,
      // nội dung
      duration,
      rawDuration,
      frameCount: frames.length,
      samplesPerFrame: base.samples,
      totalSamples,
      audioBytes,
      overheadBytes: bytes.length - audioBytes,
      // encoder / metadata
      vbrTag: vbr?.tag ?? null,
      encoder: vbr?.encoder ?? null,
      encoderDelay: vbr?.delay ?? 0,
      encoderPadding: vbr?.padding ?? 0,
      declaredFrames: vbr?.frames ?? null,
      id3v2: id3Size > 0,
      id3v2Size: id3Size,
      id3v1: hasId3v1(bytes),
      skippedBytes: garbage,
    };
  }

  const api = { analyze, parseHeader };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  global.MP3 = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
