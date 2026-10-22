// Thin wrapper over the Telnyx v2 REST API (built-in fetch, no SDK).

const API_BASE = 'https://api.telnyx.com/v2';
export const APP_NAME = 'gemini-bridge';

export class TelnyxError extends Error {
  constructor(status, errors = []) {
    const detail = errors.map((e) => [e.code, e.detail || e.title].filter(Boolean).join(' ')).join('; ');
    super(detail || `Telnyx request failed with HTTP ${status}`);
    this.status = status;
    this.errors = errors;
  }
}

export async function telnyx(method, path, body) {
  const key = process.env.TELNYX_API_KEY;
  if (!key) throw new TelnyxError(500, [{ title: 'TELNYX_API_KEY is not set' }]);

  const res = await fetch(API_BASE + path, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { errors: [{ title: text.slice(0, 200) }] };
  }
  if (!res.ok) throw new TelnyxError(res.status, json.errors);
  return json;
}

// --- Account & setup -------------------------------------------------------

export async function getBalance() {
  return (await telnyx('GET', '/balance')).data;
}

export async function listCallControlApps() {
  return (await telnyx('GET', '/call_control_applications?page[size]=250')).data || [];
}

export async function listOutboundProfiles() {
  return (await telnyx('GET', '/outbound_voice_profiles?page[size]=250')).data || [];
}

let cachedApp = null;

// The Call Control App used for dialing: TELNYX_CONNECTION_ID if set, otherwise
// an active app with an outbound voice profile (preferring the one this server creates).
export async function resolveCallControlApp({ refresh = false } = {}) {
  if (process.env.TELNYX_CONNECTION_ID) {
    return { id: process.env.TELNYX_CONNECTION_ID, application_name: '(TELNYX_CONNECTION_ID)', outbound: {} };
  }
  if (cachedApp && !refresh) return cachedApp;

  const usable = (await listCallControlApps()).filter((a) => a.active && a.outbound?.outbound_voice_profile_id);
  cachedApp = usable.find((a) => a.application_name === APP_NAME) || usable[0] || null;
  return cachedApp;
}

// The outbound voice profile that governs which countries calls can reach.
export async function resolveOutboundProfile(app) {
  const profiles = await listOutboundProfiles();
  const linkedId = app?.outbound?.outbound_voice_profile_id;
  return (
    profiles.find((p) => p.id === linkedId) ||
    profiles.find((p) => p.name === 'Default' && p.enabled) ||
    profiles.find((p) => p.enabled) ||
    null
  );
}

export async function createCallControlApp({ webhookUrl, outboundVoiceProfileId }) {
  const { data } = await telnyx('POST', '/call_control_applications', {
    application_name: APP_NAME,
    webhook_event_url: webhookUrl,
    webhook_api_version: '2',
    active: true,
    outbound: { outbound_voice_profile_id: outboundVoiceProfileId },
  });
  cachedApp = data;
  return data;
}

export async function allowDestinations(profile, countries) {
  const destinations = [...new Set([...(profile.whitelisted_destinations || []), ...countries])];
  const { data } = await telnyx('PATCH', `/outbound_voice_profiles/${profile.id}`, {
    name: profile.name,
    whitelisted_destinations: destinations,
  });
  return data;
}

// --- Caller IDs ------------------------------------------------------------

export async function listVerifiedNumbers() {
  return (await telnyx('GET', '/verified_numbers?page[size]=250')).data || [];
}

export async function listOwnedNumbers() {
  return (await telnyx('GET', '/phone_numbers?page[size]=250&filter[status]=active')).data || [];
}

export async function requestVerification(phoneNumber, method) {
  return (await telnyx('POST', '/verified_numbers', { phone_number: phoneNumber, verification_method: method }))
    .data;
}

export async function submitVerificationCode(phoneNumber, code) {
  const path = `/verified_numbers/${encodeURIComponent(phoneNumber)}/actions/verify`;
  return (await telnyx('POST', path, { verification_code: code })).data;
}

// --- Calls -----------------------------------------------------------------

export async function dial({ connectionId, to, from, webhookUrl }) {
  return (await telnyx('POST', '/calls', { connection_id: connectionId, to, from, webhook_url: webhookUrl })).data;
}

export async function startStreaming(callControlId, streamUrl) {
  return telnyx('POST', `/calls/${encodeURIComponent(callControlId)}/actions/streaming_start`, {
    stream_url: streamUrl,
    stream_track: 'inbound_track',
    stream_bidirectional_mode: 'rtp',
    stream_bidirectional_codec: 'PCMU',
  });
}

export async function hangup(callControlId) {
  return telnyx('POST', `/calls/${encodeURIComponent(callControlId)}/actions/hangup`, {});
}

// --- Helpers ---------------------------------------------------------------

// Calling codes for the destinations this project is likely to dial. Unknown
// prefixes return null and skip the client-side destination check.
const CALLING_CODES = [
  ['971', 'AE'], ['966', 'SA'], ['974', 'QA'], ['973', 'BH'], ['968', 'OM'], ['965', 'KW'],
  ['92', 'PK'], ['91', 'IN'], ['44', 'GB'], ['49', 'DE'], ['33', 'FR'], ['61', 'AU'], ['1', 'US'],
];

export function countryOf(e164) {
  const digits = e164.replace(/^\+/, '');
  const match = CALLING_CODES.find(([code]) => digits.startsWith(code));
  return match ? match[1] : null;
}

export const isE164 = (value) => typeof value === 'string' && /^\+[1-9]\d{6,14}$/.test(value);
