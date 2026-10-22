# Telnyx ↔ Gemini Live voice bridge

Places outbound phone calls with Telnyx Call Control and lets Gemini Live hold the conversation. A small web UI handles the Telnyx setup, caller-ID verification, dialing, and live transcripts.

```
Phone ⇄ Telnyx ──webhook──▶ POST /webhook ──streaming_start──▶ Telnyx
               ⇄ WS /media (μ-law 8 kHz) ⇄ bridge ⇄ Gemini Live WS (PCM 16k in / 24k out)
```

## Files

| File | What it does |
| --- | --- |
| `server.js` | Express app: UI, `/api/*`, `/webhook`, `/make-call`, and the `/media` WebSocket bridge |
| `telnyx.js` | Telnyx REST calls (dial, streaming, verified numbers, app/profile setup) |
| `gemini.js` | One Gemini Live session per call |
| `audio.js` | μ-law codec and 8k→16k / 24k→8k resampling |
| `events.js` | In-memory feed for the UI's live call panel |
| `public/` | The control UI |

## Environment

See [`.env.example`](.env.example). Required: `TELNYX_API_KEY`, `GEMINI_API_KEY`, `ADMIN_TOKEN`. Calls also need a public URL, which Render provides as `RENDER_EXTERNAL_URL` (or set `PUBLIC_URL`).

## Run locally

```bash
cd telnyx-bridge
npm install
cp .env.example .env   # then fill in the keys
npm start              # http://localhost:8080
```

Sign in with `ADMIN_TOKEN`. Locally you can verify caller IDs and allow destination countries. Placing calls needs Telnyx to reach the server, so use the Render deploy (or set `PUBLIC_URL` to an https tunnel such as ngrok).

## Deploy to Render

1. Push this repo to GitHub (the Blueprint is `render.yaml` at the repo root).
2. Open `https://dashboard.render.com/blueprint/new?repo=<your GitHub repo URL>`, paste `TELNYX_API_KEY` and `GEMINI_API_KEY`, and click **Apply**.
3. When the deploy is live, copy `ADMIN_TOKEN` from the service's **Environment** tab and open the service URL.

## First call

In the UI:

1. **Setup** card: click **Create app** (creates the `gemini-bridge` Call Control App with webhooks pointing at this server), and **Allow PK + AE** if those countries are missing from the outbound voice profile.
2. **Caller IDs** card: enter your number, choose SMS or Voice call, then type in the code. Telnyx only lets verified or Telnyx-owned numbers be the caller ID (otherwise calls fail with `403 D51`).
3. **Place a call**: pick the caller ID, enter the destination in E.164 format (e.g. `+923001234567`), and click **Call**.

The same call from a script:

```bash
curl -X POST https://<service>.onrender.com/api/calls \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"from":"+92XXXXXXXXXX","to":"+92XXXXXXXXXX"}'
```

`POST /make-call` is an alias of `/api/calls`; `from` defaults to `CALLER_ID` when omitted.

## Troubleshooting

- **`403 D51`**: the caller ID isn't verified. Verify it in the UI.
- **"does not allow calls to XX"**: add the country with the Setup card button.
- **Call connects but silence**: check the Render logs for `[gemini] closed …`; usually a bad `GEMINI_API_KEY` or model name.
- **First request is slow on the Free plan**: the service sleeps after 15 minutes idle and takes about a minute to wake.
