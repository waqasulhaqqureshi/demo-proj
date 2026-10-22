// In-memory event bus feeding the UI's live call panel (Server-Sent Events).
// Keeps a short backlog so a page opened mid-call still sees what happened.

const BACKLOG_SIZE = 200;
const backlog = [];
const subscribers = new Set();

export function publish(type, data = {}) {
  const event = { type, at: new Date().toISOString(), ...data };
  backlog.push(event);
  if (backlog.length > BACKLOG_SIZE) backlog.shift();
  for (const fn of subscribers) {
    try {
      fn(event);
    } catch (err) {
      console.error('[events] subscriber failed:', err.message);
    }
  }
  return event;
}

export function subscribe(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

export function recentEvents() {
  return backlog.slice();
}
