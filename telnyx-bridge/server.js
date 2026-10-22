import 'dotenv/config';
import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';

import { createDownsampler, createUpsampler, MULAW_SILENCE } from './audio.js';
import { publish, recentEvents, subscribe } from './events.js';
import { openGeminiSession } from './gemini.js';
import * as tx from './telnyx.js';

const PORT = Number(process.env.PORT) || 8080;
const DEFAULT_SYSTEM_PROMPT =
  'You are a friendly, professional AI voice assistant on a phone call. ' +
  'As soon as the call starts, greet the person warmly in Arabic, say you are an AI assistant, and ask how you can help. ' +
  'After that, always reply in the language the person is speaking: Arabic if they speak Arabic, English if they speak English. ' +
  'Keep every reply short and conversational, one or two sentences, because this is a phone call. ' +
  'Never use lists, markdown, or emojis.';
const GREETING_CUE = '(The phone call has just been answered. Greet the person now, following your instructions.)';

// Telnyx wants outbound media chunks of at least 20 ms: 160 μ-law bytes at 8 kHz.
const TELNYX_FRAME_BYTES = 160;
// Batch inbound audio to ~40 ms (16 kHz PCM16) before sending it to Gemini.
const GEMINI_BATCH_BYTES = 1280;

const publicUrl = () => (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, '');
const mediaStreamUrl = () => publicUrl().replace(/^http/, 'ws') + '/media';

// call_control_id → { to, from, state }
const activeCalls = new Map();

const app = express();
app.use(express.json());
app.use(express.static(path.join(path.dirname(fileURLToPath(import.meta.url)), 'public')));

app.get('/health', (_req, res) => res.json({ ok: true }));

// --- Auth ------------------------------------------------------------------

function requireAdmin(req, res, next) {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) return res.status(503).json({ error: 'ADMIN_TOKEN is not set on the server.' });
  const given = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'Invalid or missing admin token.' });
  }
  next();
}

const wrap = (handler) => (req, res) =>
  handler(req, res).catch((err) => {
    const status = err instanceof tx.TelnyxError && err.status < 500 ? 400 : 500;
    console.error(`[api] ${req.method} ${req.path}:`, err.message);
    res.status(status).json({ error: err.message });
  });

app.use('/api', requireAdmin);

// --- Setup status & one-click fixes -----------------------------------------

app.get(
  '/api/status',
  wrap(async (_req, res) => {
    const status = {
      telnyxKey: Boolean(process.env.TELNYX_API_KEY),
      geminiKey: Boolean(process.env.GEMINI_API_KEY),
      publicUrl: publicUrl() || null,
      model: process.env.GEMINI_MODEL || 'gemini-3.8-live',
      voice: process.env.GEMINI_VOICE || 'Kore',
      defaultCallerId: process.env.CALLER_ID || null,
      app: null,
      profile: null,
      balance: null,
      errors: [],
    };
    if (!status.telnyxKey) return res.json(status);

    const [appResult, balanceResult] = await Promise.allSettled([
      tx.resolveCallControlApp({ refresh: true }),
      tx.getBalance(),
    ]);
    if (appResult.status === 'fulfilled' && appResult.value) {
      const a = appResult.value;
      status.app = { id: a.id, name: a.application_name, webhookUrl: a.webhook_event_url || null };
    } else if (appResult.status === 'rejected') {
      status.errors.push(`Call Control Apps: ${appResult.reason.message}`);
    }
    if (balanceResult.status === 'fulfilled') {
      status.balance = { amount: balanceResult.value.balance, currency: balanceResult.value.currency };
    } else {
      status.errors.push(`Balance: ${balanceResult.reason.message}`);
    }

    try {
      const profile = await tx.resolveOutboundProfile(appResult.value);
      if (profile) {
        status.profile = { id: profile.id, name: profile.name, destinations: profile.whitelisted_destinations || [] };
      }
    } catch (err) {
      status.errors.push(`Outbound voice profiles: ${err.message}`);
    }
    res.json(status);
  })
);

app.post(
  '/api/setup/call-control-app',
  wrap(async (_req, res) => {
    if (!publicUrl()) {
      return res.status(400).json({
        error: 'This server has no public URL yet. Deploy to Render (or set PUBLIC_URL to an https tunnel) first.',
      });
    }
    const existing = await tx.resolveCallControlApp({ refresh: true });
    if (existing) return res.json({ app: existing, created: false });

    const profile = await tx.resolveOutboundProfile(null);
    if (!profile) return res.status(400).json({ error: 'No enabled Outbound Voice Profile found on the Telnyx account.' });

    const created = await tx.createCallControlApp({
      webhookUrl: `${publicUrl()}/webhook`,
      outboundVoiceProfileId: profile.id,
    });
    console.log(`[setup] created Call Control App ${created.id} linked to profile "${profile.name}"`);
    res.json({ app: created, created: true });
  })
);

app.post(
  '/api/setup/allow-destinations',
  wrap(async (req, res) => {
    const countries = (req.body?.countries || []).filter((c) => /^[A-Z]{2}$/.test(c));
    if (!countries.length) return res.status(400).json({ error: 'Pass countries as ISO alpha-2 codes, e.g. ["PK","AE"].' });

    const profile = await tx.resolveOutboundProfile(await tx.resolveCallControlApp());
    if (!profile) return res.status(400).json({ error: 'No enabled Outbound Voice Profile found on the Telnyx account.' });

    const updated = await tx.allowDestinations(profile, countries);
    console.log(`[setup] profile "${updated.name}" destinations: ${updated.whitelisted_destinations.join(', ')}`);
    res.json({ profile: { id: updated.id, name: updated.name, destinations: updated.whitelisted_destinations } });
  })
);

// --- Caller IDs -------------------------------------------------------------

async function callerIds() {
  const [verified, owned] = await Promise.all([tx.listVerifiedNumbers(), tx.listOwnedNumbers()]);
  return [
    ...verified.map((v) => ({ number: v.phone_number, kind: 'verified', verifiedAt: v.verified_at || null })),
    ...owned.map((n) => ({ number: n.phone_number, kind: 'owned' })),
  ];
}

app.get(
  '/api/caller-ids',
  wrap(async (_req, res) => res.json({ callerIds: await callerIds(), defaultCallerId: process.env.CALLER_ID || null }))
);

app.post(
  '/api/caller-ids/verify',
  wrap(async (req, res) => {
    const { phone_number: phoneNumber, method } = req.body || {};
    if (!tx.isE164(phoneNumber)) return res.status(400).json({ error: 'Use E.164 format, e.g. +923001234567.' });
    if (!['sms', 'call'].includes(method)) return res.status(400).json({ error: 'Method must be "sms" or "call".' });
    res.json(await tx.requestVerification(phoneNumber, method));
  })
);

app.post(
  '/api/caller-ids/:phone/confirm',
  wrap(async (req, res) => {
    const code = String(req.body?.code || '').trim();
    if (!code) return res.status(400).json({ error: 'Enter the verification code.' });
    res.json(await tx.submitVerificationCode(req.params.phone, code));
  })
);

// --- Calls -----------------------------------------------------------------

const placeCall = wrap(async (req, res) => {
  const to = String(req.body?.to || '').trim();
  const from = String(req.body?.from || process.env.CALLER_ID || '').trim();
  if (!tx.isE164(to)) return res.status(400).json({ error: '"to" must be in E.164 format, e.g. +923001234567.' });
  if (!tx.isE164(from)) return res.status(400).json({ error: 'Choose a caller ID ("from") in E.164 format.' });
  if (!publicUrl()) {
    return res.status(400).json({ error: 'No public URL: Telnyx cannot reach this server for webhooks and audio.' });
  }

  const callerIdList = await callerIds();
  if (!callerIdList.some((c) => c.number === from)) {
    return res.status(400).json({
      error: `${from} is not verified or owned on this Telnyx account, so Telnyx would reject it (403 D51). Verify it under Caller IDs first.`,
    });
  }

  const callApp = await tx.resolveCallControlApp({ refresh: true });
  if (!callApp) return res.status(400).json({ error: 'No Call Control App yet. Use "Create app" in the Setup card.' });

  const country = tx.countryOf(to);
  const profile = await tx.resolveOutboundProfile(callApp);
  const allowed = profile?.whitelisted_destinations || [];
  if (country && profile && !allowed.includes(country) && !(country === 'US' && allowed.includes('CA'))) {
    return res.status(400).json({
      error: `Outbound profile "${profile.name}" does not allow calls to ${country} (allowed: ${allowed.join(', ')}). Add it in the Setup card.`,
    });
  }

  const call = await tx.dial({ connectionId: callApp.id, to, from, webhookUrl: `${publicUrl()}/webhook` });
  activeCalls.set(call.call_control_id, { to, from, state: 'dialing' });
  publish('call', { callId: call.call_control_id, state: 'dialing', to, from });
  console.log(`[call] dialing ${to} from ${from} (${call.call_control_id})`);
  res.json({ callControlId: call.call_control_id, callSessionId: call.call_session_id });
});

app.post('/api/calls', placeCall);
app.post('/make-call', requireAdmin, placeCall);

app.post(
  '/api/calls/:id/hangup',
  wrap(async (req, res) => {
    await tx.hangup(req.params.id);
    res.json({ ok: true });
  })
);

// --- Live event feed (SSE) ---------------------------------------------------

app.get('/api/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  const write = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  recentEvents().forEach(write);
  const unsubscribe = subscribe(write);
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

// --- Telnyx webhooks ---------------------------------------------------------

function setCallState(callId, state, extra = {}) {
  const call = activeCalls.get(callId);
  if (call) call.state = state;
  publish('call', { callId, state, ...extra });
}

app.post('/webhook', (req, res) => {
  res.sendStatus(200);

  const eventType = req.body?.data?.event_type;
  const payload = req.body?.data?.payload || {};
  const callId = payload.call_control_id;
  if (!eventType) return;
  if (!activeCalls.has(callId)) {
    console.log(`[webhook] ${eventType} for a call this server did not place; ignoring`);
    return;
  }
  console.log(`[webhook] ${eventType} (${callId})`);

  switch (eventType) {
    case 'call.initiated':
      setCallState(callId, 'ringing');
      break;
    case 'call.answered':
      setCallState(callId, 'answered');
      tx.startStreaming(callId, mediaStreamUrl()).catch((err) => {
        console.error('[call] streaming_start failed:', err.message);
        setCallState(callId, 'error', { detail: `Could not start media stream: ${err.message}` });
        tx.hangup(callId).catch(() => {});
      });
      break;
    case 'streaming.failed':
    case 'call.streaming.failed':
      setCallState(callId, 'error', { detail: payload.failure_reason || 'Media stream failed' });
      break;
    case 'call.hangup':
      setCallState(callId, 'ended', {
        detail: [payload.hangup_cause, payload.sip_hangup_cause && `SIP ${payload.sip_hangup_cause}`]
          .filter(Boolean)
          .join(', '),
      });
      activeCalls.delete(callId);
      break;
  }
});

// --- Media bridge: Telnyx WebSocket ↔ Gemini Live -----------------------------

function bridgeCall(telnyxWs) {
  const upsample = createUpsampler();
  const downsample = createDownsampler();
  let callId = null;
  let gemini = null;
  let inboundBatch = [];
  let inboundBytes = 0;
  let outbound = Buffer.alloc(0);
  const transcript = { speaker: null, text: '' };

  const sendToTelnyx = (mulaw) => {
    if (telnyxWs.readyState === telnyxWs.OPEN) {
      telnyxWs.send(JSON.stringify({ event: 'media', media: { payload: mulaw.toString('base64') } }));
    }
  };

  const flushTranscriptLog = () => {
    if (transcript.text.trim()) console.log(`[transcript] ${transcript.speaker}: ${transcript.text.trim()}`);
    transcript.text = '';
  };

  const startGemini = () => {
    gemini = openGeminiSession({
      systemPrompt: process.env.SYSTEM_PROMPT || DEFAULT_SYSTEM_PROMPT,
      onReady() {
        console.log(`[gemini] session ready (${callId})`);
        setCallState(callId, 'streaming');
        gemini.sendText(GREETING_CUE);
      },
      onAudio(pcm24k) {
        outbound = Buffer.concat([outbound, downsample(pcm24k)]);
        const sendable = outbound.length - (outbound.length % TELNYX_FRAME_BYTES);
        if (sendable > 0) {
          sendToTelnyx(outbound.subarray(0, sendable));
          outbound = outbound.subarray(sendable);
        }
      },
      onTurnComplete() {
        if (outbound.length) {
          const padded = Buffer.alloc(TELNYX_FRAME_BYTES, MULAW_SILENCE);
          outbound.copy(padded);
          sendToTelnyx(padded);
          outbound = Buffer.alloc(0);
        }
        flushTranscriptLog();
      },
      onInterrupted() {
        outbound = Buffer.alloc(0);
        if (telnyxWs.readyState === telnyxWs.OPEN) telnyxWs.send(JSON.stringify({ event: 'clear' }));
        publish('interrupted', { callId });
      },
      onTranscript(speaker, text) {
        if (transcript.speaker !== speaker) {
          flushTranscriptLog();
          transcript.speaker = speaker;
        }
        transcript.text += text;
        publish('transcript', { callId, speaker, text });
      },
      onClose(code, reason) {
        console.log(`[gemini] closed ${code} ${reason} (${callId})`);
        flushTranscriptLog();
        if (activeCalls.has(callId)) {
          setCallState(callId, 'error', { detail: `AI session closed (${code}${reason ? `: ${reason}` : ''})` });
          tx.hangup(callId).catch(() => {});
        }
        if (telnyxWs.readyState === telnyxWs.OPEN) telnyxWs.close();
      },
    });
  };

  telnyxWs.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (msg.event) {
      case 'start':
        callId = msg.start?.call_control_id;
        if (!activeCalls.has(callId)) {
          console.warn(`[media] rejecting stream for unknown call ${callId}`);
          telnyxWs.close(1008, 'unknown call');
          return;
        }
        console.log(`[media] stream started (${callId}) format=${JSON.stringify(msg.start?.media_format || {})}`);
        startGemini();
        break;

      case 'media': {
        if (!gemini || !msg.media?.payload) return;
        if (msg.media.track && msg.media.track !== 'inbound') return;
        const pcm16k = upsample(Buffer.from(msg.media.payload, 'base64'));
        inboundBatch.push(pcm16k);
        inboundBytes += pcm16k.length;
        if (inboundBytes >= GEMINI_BATCH_BYTES) {
          gemini.sendAudio(Buffer.concat(inboundBatch));
          inboundBatch = [];
          inboundBytes = 0;
        }
        break;
      }

      case 'stop':
        console.log(`[media] stream stopped (${callId})`);
        gemini?.close();
        break;

      case 'error':
        console.error('[media] Telnyx stream error:', JSON.stringify(msg));
        break;
    }
  });

  telnyxWs.on('close', () => gemini?.close());
  telnyxWs.on('error', (err) => console.error('[media] socket error:', err.message));
}

// --- Start -----------------------------------------------------------------

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname !== '/media') return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => bridgeCall(ws));
});

server.listen(PORT, () => {
  console.log(`[server] listening on :${PORT}`);
  console.log(`[server] public URL: ${publicUrl() || '(none — calls need PUBLIC_URL or Render)'}`);
  for (const key of ['TELNYX_API_KEY', 'GEMINI_API_KEY', 'ADMIN_TOKEN']) {
    if (!process.env[key]) console.warn(`[server] ${key} is not set`);
  }
  if (process.env.TELNYX_API_KEY) {
    tx.resolveCallControlApp()
      .then((a) => console.log(`[server] Call Control App: ${a ? `${a.application_name} (${a.id})` : 'none yet — use "Create app" in the UI'}`))
      .catch((err) => console.warn('[server] could not look up Call Control Apps:', err.message));
  }
});
