// One Gemini Live API session per phone call.

import WebSocket from 'ws';

const GEMINI_WS_URL =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

// Audio queued before setupComplete; ~5 s of 16 kHz PCM16 is plenty.
const MAX_QUEUED_BYTES = 16000 * 2 * 5;

export function openGeminiSession({ systemPrompt, onReady, onAudio, onInterrupted, onTranscript, onTurnComplete, onClose }) {
  const ws = new WebSocket(`${GEMINI_WS_URL}?key=${encodeURIComponent(process.env.GEMINI_API_KEY || '')}`);
  let ready = false;
  let closed = false;
  let queue = [];
  let queuedBytes = 0;

  const send = (msg) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };

  const sendAudioNow = (pcm16k) =>
    send({ realtimeInput: { audio: { data: pcm16k.toString('base64'), mimeType: 'audio/pcm;rate=16000' } } });

  ws.on('open', () => {
    send({
      setup: {
        model: `models/${process.env.GEMINI_MODEL || 'gemini-3.8-live'}`,
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: process.env.GEMINI_VOICE || 'Kore' } } },
        },
        systemInstruction: { parts: [{ text: systemPrompt }] },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
      },
    });
  });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.setupComplete) {
      ready = true;
      for (const chunk of queue) sendAudioNow(chunk);
      queue = [];
      queuedBytes = 0;
      onReady?.();
      return;
    }

    if (msg.goAway) console.warn('[gemini] server will disconnect soon:', msg.goAway.timeLeft);

    const content = msg.serverContent;
    if (!content) return;

    if (content.interrupted) onInterrupted?.();
    for (const part of content.modelTurn?.parts || []) {
      if (part.inlineData?.data && part.inlineData.mimeType?.startsWith('audio/')) {
        onAudio?.(Buffer.from(part.inlineData.data, 'base64'));
      }
    }
    if (content.inputTranscription?.text) onTranscript?.('caller', content.inputTranscription.text);
    if (content.outputTranscription?.text) onTranscript?.('ai', content.outputTranscription.text);
    if (content.turnComplete) onTurnComplete?.();
  });

  ws.on('error', (err) => console.error('[gemini] socket error:', err.message));

  ws.on('close', (code, reason) => {
    closed = true;
    onClose?.(code, reason.toString());
  });

  return {
    sendAudio(pcm16k) {
      if (ready) return sendAudioNow(pcm16k);
      if (queuedBytes + pcm16k.length > MAX_QUEUED_BYTES) return;
      queue.push(pcm16k);
      queuedBytes += pcm16k.length;
    },
    sendText(text) {
      send({ realtimeInput: { text } });
    },
    close() {
      if (!closed) ws.close(1000, 'call ended');
    },
  };
}
