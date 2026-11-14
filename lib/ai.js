// Calls the Anthropic API directly from the extension with the user's own key.
import { summarize, riskFlags, snapshot } from './portfolio.js';
import { isValidRule } from './alerts.js';

const BASE = `You are the analysis engine inside Portlight, a personal asset tracker for stocks, ETFs, forex and crypto. You receive the user's portfolio as JSON; values are in US dollars unless a field says otherwise. Use the actual numbers. Write plainly and briefly for a small side panel: short paragraphs, "- " bullets, **bold** sparingly, no headings, no tables. You are not a financial advisor: describe, compare, quantify and flag risks, and lay out trade-offs, but do not tell the user to buy or sell a specific asset. Never invent prices, news or reasons for a move; if you don't know why something moved, say so.`;

export class AiError extends Error {}

export async function callClaude(settings, { system, messages, maxTokens = 700, webSearch = false }) {
  if (!settings.apiKey) throw new AiError('Add your Anthropic API key in Settings to use this.');
  const send = async (withSearch) => {
    const body = { model: settings.model, max_tokens: maxTokens, system, messages };
    if (withSearch) body.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }];
    return fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': settings.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify(body),
    });
  };
  let r;
  try {
    r = await send(webSearch);
    if (webSearch && r.status === 400) r = await send(false); // search not available for this key or model
  } catch {
    throw new AiError('Could not reach Anthropic. Check your connection and try again.');
  }
  if (!r.ok) {
    let detail = '';
    try { detail = (await r.json())?.error?.message || ''; } catch { /* ignore */ }
    if (r.status === 401) throw new AiError('Anthropic rejected the API key. Check it in Settings.');
    if (r.status === 404) throw new AiError(`Model "${settings.model}" was not found. Choose another in Settings.`);
    if (r.status === 429) throw new AiError('Anthropic rate limit reached. Wait a minute and try again.');
    throw new AiError(`Anthropic returned an error (${r.status}). ${detail}`.trim());
  }
  const j = await r.json();
  const text = (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  if (!text) throw new AiError('The model returned an empty answer. Try again.');
  return text;
}

const ctx = (s) => {
  const sum = summarize(s.holdings, s.quotes);
  return { sum, json: JSON.stringify(snapshot(sum)) };
};

export async function writeBrief(s) {
  const { json } = ctx(s);
  const search = s.settings.webSearch;
  return callClaude(s.settings, {
    system: BASE,
    webSearch: search,
    maxTokens: 600,
    messages: [{
      role: 'user',
      content: `Portfolio:\n${json}\n\nWrite today's brief in under 130 words. Start with one sentence on the overall move in dollars and percent. Then 2 to 4 bullets on the positions that moved the total most, by dollar impact. End with one line on what to watch.${search ? ' Search the web for why the two biggest movers moved today and name the source in a few words; if nothing clear turns up, say the reason is unclear.' : ' You have no news access, so do not guess at reasons for moves.'}`,
    }],
  });
}

export async function writeReview(s) {
  const { sum, json } = ctx(s);
  const flags = riskFlags(sum).map((f) => `${f.level}: ${f.title}`).join('\n') || 'none';
  return callClaude(s.settings, {
    system: BASE,
    maxTokens: 650,
    messages: [{
      role: 'user',
      content: `Portfolio:\n${json}\n\nPortlight's rule-based checks already flagged:\n${flags}\n\nReview risk and allocation in under 150 words. Do not repeat the flags verbatim. Cover what the rules miss: positions likely to move together, a rough sense of what a bad day or a 20% equity drop could cost in dollars, currency or leverage exposure, and one or two questions the holder should be able to answer about this mix.`,
    }],
  });
}

export async function chat(s, history) {
  const { json } = ctx(s);
  return callClaude(s.settings, {
    system: `${BASE}\n\nAnswer in under 150 words unless asked for more.\n\nCurrent portfolio:\n${json}`,
    webSearch: s.settings.webSearch,
    maxTokens: 800,
    messages: history.slice(-12).map((m) => ({ role: m.role, content: m.content })),
  });
}

// Turns "tell me if the euro slides 1% against the dollar" into a rule.
export async function parseAlert(s, text) {
  const held = s.holdings.map((h) => `${h.symbol} (${h.type})`).join(', ') || 'none';
  const out = await callClaude(s.settings, {
    maxTokens: 200,
    system: `Convert a price alert request into JSON. Reply with JSON only, no prose.
Schema: {"assetType":"stock"|"forex"|"crypto","symbol":string,"metric":"price"|"day_change_pct","op":"above"|"below"|"abs_above","value":number}
- symbol: US-style ticker for stocks and ETFs (AAPL), "BASE/QUOTE" for forex (EUR/USD), bare coin symbol for crypto (BTC).
- metric "price": value is the price level; op is above or below.
- metric "day_change_pct": value is percent change since the previous close. A fall of 1% is op "below", value -1. A rise of 2% is op "above", value 2. A move of 3% in either direction is op "abs_above", value 3.
- The user holds: ${held}. Prefer these when the request is ambiguous.
- If the request is not a price or daily-change alert on one asset, reply {"error":"<one short sentence saying what is missing>"}.`,
    messages: [{ role: 'user', content: text }],
  });
  const m = out.match(/\{[\s\S]*\}/);
  let rule;
  try { rule = JSON.parse(m[0]); } catch { throw new AiError('Could not understand that alert. Try "AAPL above 250" or "EUR/USD drops 1%".'); }
  if (rule.error) throw new AiError(rule.error);
  if (!isValidRule(rule)) throw new AiError('Could not understand that alert. Try "AAPL above 250" or "EUR/USD drops 1%".');
  return rule;
}
