const $ = (id) => document.getElementById(id);

const store = {
  get(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  },
  set(key, value) {
    try { localStorage.setItem(key, value); } catch { /* storage unavailable */ }
  },
  remove(key) {
    try { localStorage.removeItem(key); } catch { /* storage unavailable */ }
  },
};

let token = store.get('vb.token');
let eventsStarted = false;

// --- API -------------------------------------------------------------------

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    showLogin('That token was rejected. Sign in again.');
    throw new Error('Unauthorized');
  }
  if (!res.ok) throw new Error(data.error || `Request failed (HTTP ${res.status})`);
  return data;
}

function showMsg(el, kind, text) {
  el.className = `msg show ${kind}`;
  el.textContent = text;
}

function hideMsg(el) {
  el.className = 'msg';
  el.textContent = '';
}

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  for (const child of children) if (child != null) node.append(child);
  return node;
}

async function withBusy(button, fn) {
  button.disabled = true;
  try {
    return await fn();
  } finally {
    button.disabled = false;
  }
}

// --- Login -----------------------------------------------------------------

function showLogin(message) {
  $('login').classList.add('show');
  if (message) showMsg($('login-msg'), 'bad', message);
  $('token').focus();
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  token = $('token').value.trim();
  hideMsg($('login-msg'));
  try {
    await loadStatus();
    store.set('vb.token', token);
    $('login').classList.remove('show');
    start();
  } catch (err) {
    if (err.message !== 'Unauthorized') showMsg($('login-msg'), 'bad', err.message);
  }
});

$('logout').addEventListener('click', () => {
  store.remove('vb.token');
  token = null;
  location.reload();
});

// --- Setup card ------------------------------------------------------------

const REQUIRED_DESTINATIONS = ['PK', 'AE'];

function statusRow(state, label, value, { hint, action } = {}) {
  const row = el(
    'div',
    { className: 'row' },
    el('div', { className: 'label' }, el('span', { className: `dot ${state}` }), el('span', { textContent: label })),
    action || el('div', { className: 'value', textContent: value ?? '' })
  );
  const wrap = el('div', {}, row);
  if (hint) wrap.append(el('div', { className: 'hint', textContent: hint }));
  return wrap;
}

function actionButton(text, onClick, disabled = false) {
  const button = el('button', { className: 'small', textContent: text, type: 'button', disabled });
  button.addEventListener('click', () => withBusy(button, onClick));
  return button;
}

async function loadStatus() {
  const s = await api('GET', '/api/status');
  const rows = [];

  rows.push(statusRow(s.telnyxKey ? 'ok' : 'bad', 'Telnyx API key', s.telnyxKey ? 'Set' : 'Missing', {
    hint: s.telnyxKey ? null : 'Set TELNYX_API_KEY in the server environment.',
  }));
  rows.push(statusRow(s.geminiKey ? 'ok' : 'bad', 'Gemini API key', s.geminiKey ? `Set · ${s.model}` : 'Missing', {
    hint: s.geminiKey ? null : 'Set GEMINI_API_KEY in the server environment.',
  }));
  rows.push(statusRow(s.publicUrl ? 'ok' : 'warn', 'Public URL', s.publicUrl || 'None', {
    hint: s.publicUrl ? null : 'Running locally: you can verify numbers and allow countries here; calls need the Render deploy.',
  }));

  if (s.app) {
    rows.push(statusRow('ok', 'Call Control App', s.app.name));
  } else if (s.telnyxKey) {
    rows.push(statusRow('bad', 'Call Control App', '', {
      hint: s.publicUrl
        ? 'Creates "gemini-bridge" with webhooks pointing at this server.'
        : 'Needs the public URL, so create it from the deployed site.',
      action: actionButton('Create app', createApp, !s.publicUrl),
    }));
  }

  if (s.profile) {
    const missing = REQUIRED_DESTINATIONS.filter((c) => !s.profile.destinations.includes(c));
    const value = s.profile.destinations.join(', ') || 'None';
    rows.push(missing.length
      ? statusRow('warn', 'Allowed countries', value, {
          hint: `Profile "${s.profile.name}" allows ${value}. Pakistan/UAE calls are blocked until added.`,
          action: actionButton(`Allow ${missing.join(' + ')}`, () => allowCountries(missing)),
        })
      : statusRow('ok', 'Allowed countries', value));
  }

  if (s.balance) rows.push(statusRow('ok', 'Balance', `${s.balance.amount} ${s.balance.currency}`));
  for (const error of s.errors) rows.push(statusRow('bad', 'Telnyx error', '', { hint: error }));

  $('status-rows').replaceChildren(...rows);
  return s;
}

async function createApp() {
  try {
    const { created } = await api('POST', '/api/setup/call-control-app');
    showMsg($('setup-msg'), 'ok', created ? 'Call Control App created.' : 'A Call Control App already exists.');
    await loadStatus();
  } catch (err) {
    showMsg($('setup-msg'), 'bad', err.message);
  }
}

async function allowCountries(countries) {
  try {
    const { profile } = await api('POST', '/api/setup/allow-destinations', { countries });
    showMsg($('setup-msg'), 'ok', `Allowed countries are now: ${profile.destinations.join(', ')}.`);
    await loadStatus();
  } catch (err) {
    showMsg($('setup-msg'), 'bad', err.message);
  }
}

$('refresh-status').addEventListener('click', (e) =>
  withBusy(e.currentTarget, () => loadStatus().catch((err) => showMsg($('setup-msg'), 'bad', err.message)))
);

// --- Caller IDs card -------------------------------------------------------

async function loadCallerIds(select) {
  const { callerIds, defaultCallerId } = await api('GET', '/api/caller-ids');

  $('caller-ids').replaceChildren(
    ...(callerIds.length
      ? callerIds.map((c) =>
          el('div', { className: 'num' },
            el('span', { textContent: c.number }),
            el('span', { className: `badge ${c.kind}`, textContent: c.kind === 'owned' ? 'Telnyx number' : 'Verified' })))
      : [el('div', { className: 'empty', textContent: 'No verified numbers yet. Verify your number below.' })])
  );

  const fromSelect = $('from');
  const preferred = select || fromSelect.value || store.get('vb.from') || defaultCallerId;
  fromSelect.replaceChildren(
    ...(callerIds.length
      ? callerIds.map((c) => el('option', { value: c.number, textContent: c.number }))
      : [el('option', { value: '', textContent: 'Verify a number first' })])
  );
  if (callerIds.some((c) => c.number === preferred)) fromSelect.value = preferred;
}

$('refresh-ids').addEventListener('click', (e) =>
  withBusy(e.currentTarget, () => loadCallerIds().catch((err) => showMsg($('verify-msg'), 'bad', err.message)))
);

let pendingNumber = null;

$('verify-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const number = $('verify-number').value.replace(/[\s()-]/g, '');
  const method = new FormData(e.currentTarget).get('method');
  await withBusy($('send-code'), async () => {
    try {
      await api('POST', '/api/caller-ids/verify', { phone_number: number, method });
      pendingNumber = number;
      $('confirm-number').textContent = number;
      $('verify-form').hidden = true;
      $('confirm-form').hidden = false;
      $('verify-code').value = '';
      $('verify-code').focus();
      showMsg($('verify-msg'), 'ok', method === 'sms' ? 'Code sent by SMS.' : 'Telnyx is calling the number with the code.');
    } catch (err) {
      showMsg($('verify-msg'), 'bad', err.message);
    }
  });
});

$('confirm-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const button = e.submitter;
  await withBusy(button, async () => {
    try {
      await api('POST', `/api/caller-ids/${encodeURIComponent(pendingNumber)}/confirm`, { code: $('verify-code').value });
      showMsg($('verify-msg'), 'ok', `${pendingNumber} is verified and can be used as caller ID.`);
      resetVerify();
      await loadCallerIds(pendingNumber);
    } catch (err) {
      showMsg($('verify-msg'), 'bad', err.message);
    }
  });
});

function resetVerify() {
  $('verify-form').hidden = false;
  $('confirm-form').hidden = true;
  $('verify-number').value = '';
}

$('cancel-verify').addEventListener('click', () => {
  resetVerify();
  hideMsg($('verify-msg'));
});

// --- Place a call card -----------------------------------------------------

$('to').value = store.get('vb.to') || '';

$('call-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const from = $('from').value;
  const to = $('to').value.replace(/[\s()-]/g, '');
  hideMsg($('call-msg'));
  await withBusy($('call-btn'), async () => {
    try {
      const { callControlId } = await api('POST', '/api/calls', { from, to });
      store.set('vb.from', from);
      store.set('vb.to', to);
      live.callId = callControlId;
      showMsg($('call-msg'), 'ok', 'Dialing…');
    } catch (err) {
      showMsg($('call-msg'), 'bad', err.message);
    }
  });
});

$('hangup-btn').addEventListener('click', (e) =>
  withBusy(e.currentTarget, async () => {
    if (!live.callId) return;
    try {
      await api('POST', `/api/calls/${encodeURIComponent(live.callId)}/hangup`);
    } catch (err) {
      showMsg($('call-msg'), 'bad', err.message);
    }
  })
);

// --- Live call card --------------------------------------------------------

const STEPS = [
  ['dialing', 'Dialing'],
  ['ringing', 'Ringing'],
  ['answered', 'Answered'],
  ['streaming', 'AI connected'],
  ['ended', 'Ended'],
];

const live = { callId: null, state: null, reached: new Set(), lastBubble: null };

function resetLive(callId, meta) {
  live.callId = callId;
  live.state = null;
  live.reached = new Set();
  live.lastBubble = null;
  $('transcript').replaceChildren();
  $('call-meta').textContent = meta;
}

function renderTimeline() {
  const failed = live.state === 'error';
  $('timeline').replaceChildren(
    ...STEPS.map(([key, label]) => {
      let cls = 'step';
      if (key === live.state) cls += ' current';
      else if (live.reached.has(key)) cls += ' done';
      return el('span', { className: cls, textContent: label });
    }),
    ...(failed ? [el('span', { className: 'step failed', textContent: 'Failed' })] : [])
  );
  const active = live.callId && !['ended', 'error'].includes(live.state);
  $('hangup-btn').hidden = !active;
  $('call-btn').hidden = active;
}

function addNote(text) {
  $('transcript').append(el('div', { className: 'system-note', textContent: text }));
  live.lastBubble = null;
  scrollTranscript();
}

function scrollTranscript() {
  const box = $('transcript');
  box.scrollTop = box.scrollHeight;
}

function handleEvent(event) {
  if (event.type === 'call') {
    if (event.state === 'dialing') resetLive(event.callId, `${event.from} → ${event.to}`);
    if (event.callId !== live.callId) return;
    live.state = event.state;
    live.reached.add(event.state);
    renderTimeline();
    if (event.state === 'ended') {
      addNote(`Call ended${event.detail ? ` (${event.detail})` : ''}`);
      hideMsg($('call-msg'));
    }
    if (event.state === 'error') addNote(event.detail || 'Something went wrong');
    return;
  }

  if (event.callId !== live.callId) return;

  if (event.type === 'transcript') {
    const speaker = event.speaker === 'ai' ? 'ai' : 'caller';
    if (!live.lastBubble || live.lastBubble.dataset.speaker !== speaker) {
      const text = el('span');
      live.lastBubble = el('div', { className: `bubble ${speaker}` },
        el('span', { className: 'who', textContent: speaker === 'ai' ? 'AI' : 'Caller' }), text);
      live.lastBubble.dataset.speaker = speaker;
      $('transcript').append(live.lastBubble);
    }
    live.lastBubble.lastChild.textContent += event.text;
    scrollTranscript();
  } else if (event.type === 'interrupted') {
    addNote('Caller interrupted the AI');
  }
}

// The server replays its recent backlog on every (re)connect, so the view is
// rebuilt from scratch each time.
async function streamEvents() {
  for (;;) {
    try {
      const res = await fetch('/api/events', { headers: { Authorization: `Bearer ${token}` } });
      if (res.status === 401) return showLogin('That token was rejected. Sign in again.');
      resetLive(null, 'No call yet.');
      renderTimeline();
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        let split;
        while ((split = buffer.indexOf('\n\n')) >= 0) {
          const chunk = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          const line = chunk.split('\n').find((l) => l.startsWith('data: '));
          if (line) handleEvent(JSON.parse(line.slice(6)));
        }
      }
    } catch {
      /* reconnect below */
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
}

// --- Boot ------------------------------------------------------------------

function start() {
  loadCallerIds().catch((err) => showMsg($('verify-msg'), 'bad', err.message));
  renderTimeline();
  if (!eventsStarted) {
    eventsStarted = true;
    streamEvents();
  }
}

if (!token) {
  showLogin();
} else {
  loadStatus()
    .then(start)
    .catch((err) => {
      if (err.message !== 'Unauthorized') showMsg($('setup-msg'), 'bad', err.message);
    });
}
