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
    showLogin('That password didn\'t work. Please try again.');
    throw new Error('Unauthorized');
  }
  if (!res.ok) throw new Error(data.error || `Something went wrong (HTTP ${res.status}).`);
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

// --- Hidden setup panel: double-tap / double-click the title ----------------

let lastTap = 0;
$('title').addEventListener('pointerup', () => {
  const now = Date.now();
  if (now - lastTap < 350) {
    $('setup-card').classList.toggle('show');
    lastTap = 0;
  } else {
    lastTap = now;
  }
});

// --- Setup status (automatic) -------------------------------------------------

function statusRow(state, label, value, hint) {
  return el(
    'div',
    {},
    el(
      'div',
      { className: 'row' },
      el('div', { className: 'label' }, el('span', { className: `dot ${state}` }), el('span', { textContent: label })),
      el('div', { className: 'value', textContent: value ?? '' })
    ),
    hint ? el('div', { className: 'hint', textContent: hint }) : null
  );
}

async function loadStatus() {
  const s = await api('GET', '/api/status');
  const rows = [];

  rows.push(statusRow(s.telnyxKey ? 'ok' : 'bad', 'Telnyx key', s.telnyxKey ? 'Connected' : 'Missing'));
  rows.push(statusRow(s.geminiKey ? 'ok' : 'bad', 'Gemini key', s.geminiKey ? `Connected · ${s.model}` : 'Missing'));
  rows.push(statusRow(s.publicUrl ? 'ok' : 'warn', 'Online address', s.publicUrl || 'Running on this computer',
    s.publicUrl ? null : 'Calls work only on the online (Render) version.'));
  rows.push(s.app
    ? statusRow('ok', 'Telnyx call app', s.app.name)
    : statusRow('warn', 'Telnyx call app', 'Not yet', 'Created automatically when the online version starts.'));
  if (s.profile) {
    const missing = s.autoCountries.filter((c) => !s.profile.destinations.includes(c));
    rows.push(statusRow(missing.length ? 'warn' : 'ok', 'Countries you can call', s.profile.destinations.join(', ') || 'None',
      missing.length ? `${missing.join(', ')} will be added automatically.` : 'Any other country is added automatically when you call it.'));
  }
  if (s.balance) rows.push(statusRow('ok', 'Telnyx balance', `${s.balance.amount} ${s.balance.currency}`));
  for (const warning of s.warnings) rows.push(statusRow('bad', 'Needs your action', '', warning));
  for (const error of s.errors) rows.push(statusRow('bad', 'Telnyx problem', '', error));
  $('status-rows').replaceChildren(...rows);

  const problems = [];
  if (!s.telnyxKey) problems.push('the Telnyx key is missing');
  if (!s.geminiKey) problems.push('the Gemini key is missing');
  if (s.errors.length) problems.push('Telnyx reported a problem');
  let text = '';
  if (s.warnings.length) text = s.warnings.join(' ');
  else if (problems.length) text = `Setup needs attention: ${problems.join(', ')}. Double-tap "Voice Bridge" for details.`;
  else if (!s.publicUrl) text = 'You\'re on the computer version: you can add your number here, but calls work only on the online version.';
  renderNotice(text);
  return s;
}

// Shows the banner text, turning any https:// URL in it into a link.
function renderNotice(text) {
  const notice = $('notice');
  notice.replaceChildren(
    ...text.split(/(https:\/\/\S+?)(?=[\s,]|$)/).map((part) =>
      part.startsWith('https://') ? el('a', { href: part, textContent: part, target: '_blank', rel: 'noopener' }) : part
    )
  );
  notice.classList.toggle('show', Boolean(text));
}

$('rerun-setup').addEventListener('click', (e) =>
  withBusy(e.currentTarget, async () => {
    try {
      const { changes, warnings } = await api('POST', '/api/setup/auto');
      await loadStatus();
      if (warnings.length) showMsg($('setup-msg'), 'bad', warnings.join(' '));
      else showMsg($('setup-msg'), 'ok', changes.length ? `Done: ${changes.join('; ')}.` : 'Everything is already set up.');
    } catch (err) {
      showMsg($('setup-msg'), 'bad', err.message);
    }
  })
);

// --- Your number -------------------------------------------------------------

async function loadCallerIds(select) {
  const { callerIds, defaultCallerId } = await api('GET', '/api/caller-ids');

  $('caller-ids').replaceChildren(
    ...(callerIds.length
      ? callerIds.map((c) =>
          el('div', { className: 'num' },
            el('span', { textContent: c.number }),
            el('span', { className: 'badge', textContent: c.kind === 'owned' ? 'Telnyx number' : 'Ready' })))
      : [el('div', { className: 'empty', textContent: 'No number added yet. Add yours below.' })])
  );

  const fromSelect = $('from');
  const preferred = select || fromSelect.value || store.get('vb.from') || defaultCallerId;
  fromSelect.replaceChildren(
    ...(callerIds.length
      ? callerIds.map((c) => el('option', { value: c.number, textContent: c.number }))
      : [el('option', { value: '', textContent: 'Add your number first' })])
  );
  if (callerIds.some((c) => c.number === preferred)) fromSelect.value = preferred;
}

$('refresh-ids').addEventListener('click', (e) =>
  withBusy(e.currentTarget, () => loadCallerIds().catch((err) => showMsg($('verify-msg'), 'bad', err.message)))
);

let pendingNumber = null;

$('verify-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const method = new FormData(e.currentTarget).get('method');
  await withBusy($('send-code'), async () => {
    try {
      const { phoneNumber } = await api('POST', '/api/caller-ids/verify', {
        phone_number: $('verify-number').value,
        method,
      });
      pendingNumber = phoneNumber;
      $('confirm-number').textContent = phoneNumber;
      $('verify-form').hidden = true;
      $('confirm-form').hidden = false;
      $('verify-code').value = '';
      $('verify-code').focus();
      showMsg($('verify-msg'), 'ok',
        method === 'sms' ? `We texted a code to ${phoneNumber}.` : `We're calling ${phoneNumber} now to read out the code.`);
    } catch (err) {
      showMsg($('verify-msg'), 'bad', err.message);
    }
  });
});

$('confirm-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  await withBusy(e.submitter, async () => {
    try {
      await api('POST', `/api/caller-ids/${encodeURIComponent(pendingNumber)}/confirm`, { code: $('verify-code').value });
      showMsg($('verify-msg'), 'ok', `Done! ${pendingNumber} is ready to use.`);
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

// --- Call someone -------------------------------------------------------------

$('to').value = store.get('vb.to') || '';

$('call-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const from = $('from').value;
  const to = $('to').value.trim();
  hideMsg($('call-msg'));
  await withBusy($('call-btn'), async () => {
    try {
      const { callControlId } = await api('POST', '/api/calls', { from, to });
      store.set('vb.from', from);
      store.set('vb.to', to);
      live.callId = callControlId;
      showMsg($('call-msg'), 'ok', 'Calling…');
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

// --- Conversation -------------------------------------------------------------

const STEPS = [
  ['dialing', 'Calling'],
  ['ringing', 'Ringing'],
  ['answered', 'Picked up'],
  ['streaming', 'AI is talking'],
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
  $('timeline').replaceChildren(
    ...STEPS.map(([key, label]) => {
      let cls = 'step';
      if (key === live.state) cls += ' current';
      else if (live.reached.has(key)) cls += ' done';
      return el('span', { className: cls, textContent: label });
    }),
    ...(live.state === 'error' ? [el('span', { className: 'step failed', textContent: 'Problem' })] : [])
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
    if (event.state === 'dialing') resetLive(event.callId, `From ${event.from} to ${event.to}`);
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
      live.lastBubble = el('div', { className: `bubble ${speaker}` },
        el('span', { className: 'who', textContent: speaker === 'ai' ? 'AI' : 'Them' }), el('span'));
      live.lastBubble.dataset.speaker = speaker;
      $('transcript').append(live.lastBubble);
    }
    live.lastBubble.lastChild.textContent += event.text;
    scrollTranscript();
  } else if (event.type === 'interrupted') {
    addNote('They spoke over the AI, so it stopped to listen');
  }
}

// The server replays its recent backlog on every (re)connect, so the view is
// rebuilt from scratch each time.
async function streamEvents() {
  for (;;) {
    try {
      const res = await fetch('/api/events', { headers: { Authorization: `Bearer ${token}` } });
      if (res.status === 401) return showLogin('That password didn\'t work. Please try again.');
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
