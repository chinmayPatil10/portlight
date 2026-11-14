// One refresh pass: fetch prices, check alerts, and (in the background) write the daily brief.
import { load, save, today } from './store.js';
import { fetchAll } from './prices.js';
import { isMet, describe } from './alerts.js';
import { writeBrief } from './ai.js';

function notify(id, title, message) {
  try {
    chrome.notifications.create(id, {
      type: 'basic', iconUrl: chrome.runtime.getURL('icons/icon128.png'), title, message, priority: 2,
    });
  } catch { /* notifications unavailable */ }
}

let running = null;

export function runCycle(opts = {}) {
  if (!running) running = cycle(opts).finally(() => { running = null; });
  return running;
}

async function cycle({ force = false, background = false } = {}) {
  const s = await load();
  const items = new Map();
  for (const h of s.holdings) items.set(h.key, { key: h.key, type: h.type, symbol: h.symbol });
  for (const a of s.alerts) items.set(a.key, { key: a.key, type: a.assetType, symbol: a.symbol });

  if (items.size && (force || Date.now() - s.quotesAt > 60_000)) {
    const fresh = await fetchAll([...items.values()]);
    const quotes = {};
    for (const key of items.keys()) {
      const f = fresh[key], old = s.quotes[key];
      // Keep the last good price if a refresh fails, and mark it stale.
      quotes[key] = f?.error && old && typeof old.price === 'number' ? { ...old, stale: true } : f;
    }
    const day = today();
    const alerts = s.alerts.map((a) => {
      // Daily-change alerts re-arm themselves each new day.
      if (a.status === 'triggered' && a.metric === 'day_change_pct' && a.triggeredDay !== day) a = { ...a, status: 'active' };
      const q = quotes[a.key];
      if (a.status !== 'active' || !q || q.stale || !isMet(a, q)) return a;
      const px = Number(q.price.toPrecision(7)).toLocaleString('en-US', { maximumFractionDigits: 6 });
      const now = a.metric === 'price' ? `Now ${px}` : `Now ${q.changePct >= 0 ? '+' : ''}${q.changePct.toFixed(2)}% on the day, at ${px}`;
      notify(`alert-${a.id}-${Date.now()}`, describe(a), now);
      return { ...a, status: 'triggered', triggeredAt: Date.now(), triggeredDay: day, triggeredNote: now, seen: false };
    });
    await save({ quotes, quotesAt: Date.now(), alerts });
    s.quotes = quotes; s.alerts = alerts;
  }

  if (background && s.settings.autoBrief && s.settings.apiKey && s.holdings.length
    && new Date().getHours() >= s.settings.briefHour && s.brief?.date !== today()) {
    try {
      const text = await writeBrief(s);
      await save({ brief: { date: today(), text, at: Date.now() } });
      notify(`brief-${today()}`, "Today's brief is ready", text.split('\n')[0].replace(/\*\*/g, '').slice(0, 180));
    } catch { /* try again on the next pass */ }
  }
  return s;
}
