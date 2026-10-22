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
import { parsePhone } from './phone.js';
import * as tx from './telnyx.js';

const PORT = Number(process.env.PORT) || 8080;
// Destination countries the outbound voice profile is kept open for. The
// destination of each call is also allowed automatically when it is dialed.
const AUTO_ALLOW_COUNTRIES = (process.env.AUTO_ALLOW_COUNTRIES || 'PK,AE')
  .split(',')
  .map((c) => c.trim().toUpperCase())
  .filter(Boolean);
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

// The UI never names the telephony vendor; full details stay in the server logs.
const toClientText = (message) =>
  String(message)
    .replace(/(refer to )?https?:\/\/\S*telnyx\S*/gi, '')
    .replace(/TELNYX_API_KEY/g, 'calling service key')
    .replace(/telnyx/gi, 'calling service')
    .replace(/\s+([.,;])/g, '$1')
    .trim();

const wrap = (handler) => (req, res) =>
  handler(req, res).catch((err) => {
    const status = err instanceof tx.TelnyxError && err.status < 500 ? 400 : 500;
    console.error(`[api] ${req.method} ${req.path}:`, err.message);
    res.status(status).json({ error: toClientText(err.message) });
  });

app.use('/api', requireAdmin);

// --- Automatic Telnyx setup --------------------------------------------------

// Makes the Telnyx account ready to place calls: opens the needed destination
// countries on the outbound voice profile and, once this server has a public
// URL, creates the Call Control App (or re-points its webhook). Idempotent;
// concurrent callers share one run so the app is never created twice.
let setupRun = null;
let lastSetupWarnings = [];

const countryNames = new Intl.DisplayNames(['en'], { type: 'region' });
const describeCountries = (codes) => codes.map((c) => countryNames.of(c) || c).join(' and ');

function ensureTelnyxSetup(extraCountries = []) {
  const run = (setupRun || Promise.resolve()).catch(() => {}).then(async () => {
    const changes = [];
    const warnings = [];
    let blocked = [];
    let callApp = await tx.resolveCallControlApp({ refresh: true });
    const profile = await tx.resolveOutboundProfile(callApp);
    if (!profile) throw new Error('No enabled Outbound Voice Profile on the Telnyx account.');

    const allowed = profile.whitelisted_destinations || [];
    const missing = [...new Set([...AUTO_ALLOW_COUNTRIES, ...extraCountries])].filter((c) => !allowed.includes(c));
    if (missing.length) {
      try {
        await tx.allowDestinations(profile, missing);
        changes.push(`allowed calls to ${missing.join(', ')} on profile "${profile.name}"`);
      } catch (err) {
        blocked = missing;
        console.warn(`[setup] could not allow ${missing.join(', ')}: ${err.message}`);
        // 10039: the account level doesn't permit these destinations yet.
        warnings.push(
          err.errors?.some((e) => String(e.code) === '10039')
            ? `The calling account needs an upgrade before it can call ${describeCountries(missing)}. Once it's upgraded, they are added automatically.`
            : `Could not allow calls to ${describeCountries(missing)}: ${toClientText(err.message)}`
        );
      }
    }

    const webhookUrl = publicUrl() && `${publicUrl()}/webhook`;
    if (webhookUrl && !callApp) {
      callApp = await tx.createCallControlApp({ webhookUrl, outboundVoiceProfileId: profile.id });
      changes.push(`created Call Control App ${callApp.id}`);
    } else if (
      webhookUrl &&
      callApp.application_name === tx.APP_NAME &&
      (callApp.webhook_event_url !== webhookUrl || callApp.webhook_api_version !== '2')
    ) {
      callApp = await tx.updateCallControlAppWebhook(callApp, webhookUrl);
      changes.push(`pointed Call Control App webhooks at ${webhookUrl}`);
    }

    for (const change of changes) console.log(`[setup] ${change}`);
    lastSetupWarnings = warnings;
    return { app: callApp, changes, warnings, blocked };
  });
  setupRun = run;
  return run;
}

app.get(
  '/api/status',
  wrap(async (_req, res) => {
    const status = {
      callingKey: Boolean(process.env.TELNYX_API_KEY),
      aiKey: Boolean(process.env.GEMINI_API_KEY),
      publicUrl: publicUrl() || null,
      model: process.env.GEMINI_MODEL || 'gemini-3.8-live',
      voice: process.env.GEMINI_VOICE || 'Kore',
      defaultCallerId: process.env.CALLER_ID || null,
      autoCountries: AUTO_ALLOW_COUNTRIES,
      warnings: lastSetupWarnings,
      app: null,
      profile: null,
      balance: null,
      errors: [],
    };
    if (!status.callingKey) return res.json(status);

    const [appResult, balanceResult] = await Promise.allSettled([
      tx.resolveCallControlApp({ refresh: true }),
      tx.getBalance(),
    ]);
    if (appResult.status === 'fulfilled' && appResult.value) {
      const a = appResult.value;
      status.app = { id: a.id, name: a.application_name };
    } else if (appResult.status === 'rejected') {
      status.errors.push(`Calling app: ${toClientText(appResult.reason.message)}`);
    }
    if (balanceResult.status === 'fulfilled') {
      status.balance = { amount: balanceResult.value.balance, currency: balanceResult.value.currency };
    } else {
      status.errors.push(`Credit: ${toClientText(balanceResult.reason.message)}`);
    }

    try {
      const profile = await tx.resolveOutboundProfile(appResult.value);
      if (profile) {
        status.profile = { id: profile.id, name: profile.name, destinations: profile.whitelisted_destinations || [] };
      }
    } catch (err) {
      status.errors.push(`Allowed countries: ${toClientText(err.message)}`);
    }
    res.json(status);
  })
);

app.post(
  '/api/setup/auto',
  wrap(async (_req, res) => {
    const { changes, warnings } = await ensureTelnyxSetup();
    res.json({ changes, warnings });
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
    const phone = parsePhone(req.body?.phone_number);
    const method = req.body?.method;
    if (!phone) {
      return res.status(400).json({ error: 'That number doesn\'t look right. Start with + and the country code, e.g. +92 300 1234567.' });
    }
    if (!['sms', 'call'].includes(method)) return res.status(400).json({ error: 'Choose text message or phone call.' });
    await tx.requestVerification(phone.e164, method);
    res.json({ phoneNumber: phone.e164 });
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
  const target = parsePhone(req.body?.to);
  const caller = parsePhone(req.body?.from || process.env.CALLER_ID);
  if (!target) {
    return res.status(400).json({ error: 'The number to call doesn\'t look right. Start with + and the country code, e.g. +92 300 1234567.' });
  }
  if (!caller) return res.status(400).json({ error: 'Pick the number to call from.' });
  if (!publicUrl()) {
    return res.status(400).json({ error: 'Calls only work on the online (Render) version of this page.' });
  }

  const callerIdList = await callerIds();
  if (!callerIdList.some((c) => c.number === caller.e164)) {
    return res.status(400).json({
      error: `${caller.e164} isn't confirmed yet, so the call would be blocked. Add it under "Your number" first.`,
    });
  }

  // Opens the destination's country and makes sure the call app exists.
  const { app: callApp, blocked, warnings } = await ensureTelnyxSetup(target.country ? [target.country] : []);
  if (blocked.includes(target.country)) return res.status(400).json({ error: warnings.join(' ') });
  if (!callApp) return res.status(500).json({ error: 'Could not set up the calling app. Check the server logs.' });

  const to = target.e164;
  const from = caller.e164;
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
    if (req.params.id.startsWith('test-')) endTestCall(req.params.id, 'Test finished');
    else await tx.hangup(req.params.id);
    res.json({ ok: true });
  })
);

// Browser test calls: the page streams microphone audio over /media in the same
// format the phone network uses, so the whole bridge runs without a real call.
app.post('/api/test-calls', (_req, res) => {
  const callId = `test-${crypto.randomUUID()}`;
  activeCalls.set(callId, { test: true, state: 'dialing' });
  publish('call', { callId, state: 'dialing', test: true });
  console.log(`[call] browser test started (${callId})`);
  res.json({ callId });
});

function endTestCall(callId, detail) {
  if (!activeCalls.get(callId)?.test) return;
  setCallState(callId, 'ended', { detail });
  activeCalls.delete(callId);
}

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
  // Set once the stream is closing normally, so the AI session closing with it
  // isn't reported as a failure.
  let ending = false;
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
        if (!ending && activeCalls.has(callId)) {
          setCallState(callId, 'error', { detail: `AI session closed (${code}${reason ? `: ${reason}` : ''})` });
          if (activeCalls.get(callId).test) activeCalls.delete(callId);
          else tx.hangup(callId).catch(() => {});
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
        if (activeCalls.get(callId).test) setCallState(callId, 'answered');
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
        ending = true;
        endTestCall(callId, 'Test finished');
        gemini?.close();
        break;

      case 'error':
        console.error('[media] Telnyx stream error:', JSON.stringify(msg));
        break;
    }
  });

  telnyxWs.on('close', () => {
    ending = true;
    endTestCall(callId, 'Test finished');
    gemini?.close();
  });
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
    ensureTelnyxSetup()
      .then(({ app: a }) =>
        console.log(`[setup] Call Control App: ${a ? `${a.application_name} (${a.id})` : 'created automatically once the server has a public URL'}`)
      )
      .catch((err) => console.warn('[setup] automatic Telnyx setup failed:', err.message));
  }
});
