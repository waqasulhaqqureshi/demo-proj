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
| `phone.js` | Phone number parsing and country detection |
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

## Automatic Telnyx setup

On startup (and before every call) the server:

- opens `AUTO_ALLOW_COUNTRIES` (default `PK,AE`) on the outbound voice profile, plus the destination country of each call it places;
- creates the `gemini-bridge` Call Control App once it has a public URL, and keeps that app's webhook pointed at this server.

The status panel is hidden; double-tap (or double-click) the **Voice Bridge** title to show it.

## First call

In the UI:

1. **Your number**: enter the number you'll call from, choose text message or phone call, then type in the code. Telnyx only lets confirmed or Telnyx-owned numbers be the caller ID (otherwise calls fail with `403 D51`).
2. **Call someone**: pick the number to call from, enter the number to call with its country code (e.g. `+92 300 1234567`), and click **Call now**.

The same call from a script:

```bash
curl -X POST https://<service>.onrender.com/api/calls \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"from":"+92XXXXXXXXXX","to":"+92XXXXXXXXXX"}'
```

`POST /make-call` is an alias of `/api/calls`; `from` defaults to `CALLER_ID` when omitted.

## Troubleshooting

- **`403 D51`**: the caller ID isn't confirmed. Add it under **Your number**.
- **Call connects but silence**: check the Render logs for `[gemini] closed …`; usually a bad `GEMINI_API_KEY` or model name.
- **First request is slow on the Free plan**: the service sleeps after 15 minutes idle and takes about a minute to wake.
