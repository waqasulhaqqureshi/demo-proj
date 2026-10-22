// Audio conversion between Telnyx (G.711 μ-law, 8 kHz) and Gemini Live
// (16-bit little-endian PCM: 16 kHz in, 24 kHz out).

const BIAS = 0x84;
const CLIP = 32635;

const MULAW_DECODE = new Int16Array(256);
for (let i = 0; i < 256; i++) {
  const u = ~i & 0xff;
  const magnitude = ((((u & 0x0f) << 3) + BIAS) << ((u >> 4) & 0x07)) - BIAS;
  MULAW_DECODE[i] = u & 0x80 ? -magnitude : magnitude;
}

function encodeMulawSample(sample) {
  const sign = (sample >> 8) & 0x80;
  if (sign) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

export const MULAW_SILENCE = 0xff;

export function mulawDecode(mulaw) {
  const pcm = new Int16Array(mulaw.length);
  for (let i = 0; i < mulaw.length; i++) pcm[i] = MULAW_DECODE[mulaw[i]];
  return pcm;
}

export function mulawEncode(pcm) {
  const out = Buffer.alloc(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = encodeMulawSample(pcm[i]);
  return out;
}

function int16ToBuffer(samples) {
  const buf = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(samples[i], i * 2);
  return buf;
}

// Telnyx → Gemini: μ-law 8 kHz → PCM16LE 16 kHz. Linear interpolation, with the
// last sample carried across frames so frame boundaries stay smooth.
export function createUpsampler() {
  let prev = 0;
  return function upsample(mulaw) {
    const input = mulawDecode(mulaw);
    const out = new Int16Array(input.length * 2);
    for (let i = 0; i < input.length; i++) {
      out[2 * i] = (prev + input[i]) >> 1;
      out[2 * i + 1] = input[i];
      prev = input[i];
    }
    return int16ToBuffer(out);
  };
}

// Gemini → Telnyx: PCM16LE 24 kHz → μ-law 8 kHz. A windowed-sinc low-pass
// (cutoff 3.4 kHz) runs before keeping every third sample, so speech above the
// 4 kHz phone band doesn't alias. Filter history and leftover samples carry over.
const DECIMATION = 3;
const TAPS = (() => {
  const n = 31;
  const cutoff = 3400 / 24000;
  const taps = new Float64Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const m = i - (n - 1) / 2;
    const sinc = m === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * m) / (Math.PI * m);
    const hamming = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (n - 1));
    taps[i] = sinc * hamming;
    sum += taps[i];
  }
  for (let i = 0; i < n; i++) taps[i] /= sum;
  return taps;
})();

export function createDownsampler() {
  let history = new Float64Array(TAPS.length - 1);
  let pendingByte = null;
  let phase = 0;

  return function downsample(pcm24k) {
    let bytes = pcm24k;
    if (pendingByte) {
      bytes = Buffer.concat([pendingByte, bytes]);
      pendingByte = null;
    }
    if (bytes.length % 2) {
      pendingByte = bytes.subarray(bytes.length - 1);
      bytes = bytes.subarray(0, bytes.length - 1);
    }

    const count = bytes.length / 2;
    const window = new Float64Array(history.length + count);
    window.set(history);
    for (let i = 0; i < count; i++) window[history.length + i] = bytes.readInt16LE(i * 2);

    const out = [];
    for (let i = 0; i < count; i++) {
      if ((phase + i) % DECIMATION !== 0) continue;
      let acc = 0;
      for (let t = 0; t < TAPS.length; t++) acc += TAPS[t] * window[i + t];
      out.push(Math.max(-32768, Math.min(32767, Math.round(acc))));
    }
    phase = (phase + count) % DECIMATION;
    history = window.slice(window.length - history.length);
    return mulawEncode(out);
  };
}
