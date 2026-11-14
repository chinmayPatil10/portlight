// Everything Portlight remembers lives in chrome.storage.local on this computer.
export const DEFAULT_SETTINGS = {
  apiKey: '',
  model: 'claude-haiku-5-5',
  webSearch: false,
  autoBrief: true,
  briefHour: 8,
};

const DEFAULTS = {
  holdings: [], // {id, key, type, symbol, qty, cost}
  alerts: [],   // see lib/alerts.js
  quotes: {},   // key -> quote
  quotesAt: 0,
  brief: null,  // {date, text, at}
  review: null, // {text, at}
  chat: [],     // {role, content}
};

export async function load() {
  const d = await chrome.storage.local.get(null);
  return { ...DEFAULTS, ...d, settings: { ...DEFAULT_SETTINGS, ...(d.settings || {}) } };
}

export function save(patch) {
  return chrome.storage.local.set(patch);
}

export const uid = () => crypto.randomUUID();
export const today = () => new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD, local time
