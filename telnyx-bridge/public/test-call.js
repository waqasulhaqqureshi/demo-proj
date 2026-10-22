// Browser test call: acts like the phone network on the /media WebSocket.
// Microphone → μ-law 8 kHz frames in; μ-law 8 kHz audio out → speakers.

const FRAME_SAMPLES = 160; // 20 ms at 8 kHz

const MULAW_DECODE = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const u = ~i & 0xff;
  const magnitude = ((((u & 0x0f) << 3) + 0x84) << ((u >> 4) & 0x07)) - 0x84;
  MULAW_DECODE[i] = (u & 0x80 ? -magnitude : magnitude) / 32768;
}

function mulawEncode(sample) {
  const sign = (sample >> 8) & 0x80;
  if (sign) sample = -sample;
  if (sample > 32635) sample = 32635;
  sample += 0x84;
  let exponent = 7;
  for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
  return ~(sign | (exponent << 4) | ((sample >> (exponent + 3)) & 0x0f)) & 0xff;
}

const toBase64 = (bytes) => btoa(String.fromCharCode(...bytes));
const fromBase64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

export async function startTestCall({ callId, onEnd }) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const ctx = new AudioContext();
  await ctx.audioWorklet.addModule('mic-worklet.js');

  const source = ctx.createMediaStreamSource(stream);
  const capture = new AudioWorkletNode(ctx, 'mic-capture');
  const mute = ctx.createGain();
  mute.gain.value = 0;
  source.connect(capture).connect(mute).connect(ctx.destination);

  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/media`);
  let ended = false;

  // Microphone: average down to 8 kHz, then send 20 ms μ-law frames.
  const ratio = ctx.sampleRate / 8000;
  let carry = new Float32Array(0);
  let frame = [];
  capture.port.onmessage = ({ data }) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    const input = new Float32Array(carry.length + data.length);
    input.set(carry);
    input.set(data, carry.length);
    const count = Math.floor(input.length / ratio);
    for (let i = 0; i < count; i++) {
      const start = Math.floor(i * ratio);
      const end = Math.floor((i + 1) * ratio);
      let sum = 0;
      for (let j = start; j < end; j++) sum += input[j];
      const value = Math.max(-1, Math.min(1, sum / (end - start)));
      frame.push(mulawEncode(Math.round(value * 32767)));
      if (frame.length === FRAME_SAMPLES) {
        ws.send(JSON.stringify({ event: 'media', media: { track: 'inbound', payload: toBase64(frame) } }));
        frame = [];
      }
    }
    carry = input.slice(Math.floor(count * ratio));
  };

  // AI audio: queue 8 kHz buffers back to back; "clear" drops what's queued.
  let playAt = 0;
  const playing = new Set();
  ws.onmessage = ({ data }) => {
    const msg = JSON.parse(data);
    if (msg.event === 'media') {
      const bytes = fromBase64(msg.media.payload);
      const buffer = ctx.createBuffer(1, bytes.length, 8000);
      const samples = buffer.getChannelData(0);
      for (let i = 0; i < bytes.length; i++) samples[i] = MULAW_DECODE[bytes[i]];
      const node = ctx.createBufferSource();
      node.buffer = buffer;
      node.connect(ctx.destination);
      playAt = Math.max(playAt, ctx.currentTime + 0.05);
      node.start(playAt);
      playAt += buffer.duration;
      playing.add(node);
      node.onended = () => playing.delete(node);
    } else if (msg.event === 'clear') {
      for (const node of playing) node.stop();
      playing.clear();
      playAt = 0;
    }
  };

  ws.onopen = () =>
    ws.send(JSON.stringify({
      event: 'start',
      start: { call_control_id: callId, media_format: { encoding: 'PCMU', sample_rate: 8000, channels: 1 } },
    }));

  const stop = () => {
    if (ended) return;
    ended = true;
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ event: 'stop' }));
      ws.close();
    }
    stream.getTracks().forEach((t) => t.stop());
    ctx.close();
    onEnd?.();
  };
  ws.onclose = stop;
  ws.onerror = stop;

  return { stop };
}
