// Price sources. Yahoo Finance's chart endpoint covers all three asset types;
// CoinGecko (crypto) and open.er-api.com (forex) step in if Yahoo fails.
// All are free and keyless, and none is an official real-time feed.
import { CRYPTO_IDS, yahooSymbol } from './symbols.js';

async function getJson(url) {
  const r = await fetch(url, { credentials: 'omit' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function yahoo(ySym) {
  let lastErr;
  for (const host of ['query1', 'query2']) {
    try {
      const j = await getJson(`https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ySym)}?interval=1d&range=1mo`);
      const res = j?.chart?.result?.[0];
      if (!res) throw new Error(j?.chart?.error?.description || 'No data');
      const meta = res.meta || {};
      const closes = (res.indicators?.quote?.[0]?.close || []).filter((v) => typeof v === 'number' && isFinite(v));
      const price = typeof meta.regularMarketPrice === 'number' ? meta.regularMarketPrice : closes.at(-1);
      if (typeof price !== 'number') throw new Error('No price');
      const prevClose = closes.length >= 2 ? closes.at(-2) : (meta.chartPreviousClose ?? null);
      return {
        price,
        prevClose,
        currency: meta.currency || 'USD',
        name: meta.shortName || meta.longName || '',
        spark: closes.slice(-22),
        source: 'Yahoo Finance',
      };
    } catch (e) {
      lastErr = e;
      if (/No data|Not Found|delisted/i.test(e.message)) break; // a second host won't help
    }
  }
  throw lastErr;
}

async function coingecko(symbol) {
  const id = CRYPTO_IDS[symbol];
  if (!id) throw new Error('Unknown coin');
  const j = await getJson(`https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd&include_24hr_change=true`);
  const p = j?.[id]?.usd;
  if (typeof p !== 'number') throw new Error('No price');
  const ch = j[id].usd_24h_change;
  return {
    price: p,
    prevClose: typeof ch === 'number' ? p / (1 + ch / 100) : null,
    currency: 'USD', name: '', spark: [], source: 'CoinGecko',
  };
}

async function erApi(base, quote) {
  const j = await getJson(`https://open.er-api.com/v6/latest/${base}`);
  const p = j?.rates?.[quote];
  if (typeof p !== 'number') throw new Error('No rate');
  return { price: p, prevClose: null, currency: quote, name: '', spark: [], source: 'open.er-api.com' };
}

// How many US dollars one unit of `cur` is worth.
async function usdRate(cur, cache) {
  if (!cur || cur === 'USD') return 1;
  if (cur === 'GBp' || cur === 'GBX') return (await usdRate('GBP', cache)) / 100; // London prices in pence
  if (!cache.has(cur)) {
    cache.set(cur, (async () => {
      try { return (await yahoo(`${cur}USD=X`)).price; }
      catch { return (await erApi(cur, 'USD')).price; }
    })());
  }
  return cache.get(cur);
}

export async function fetchQuote(type, symbol, cache = new Map()) {
  let q;
  try {
    q = await yahoo(yahooSymbol(type, symbol));
  } catch (e) {
    if (type === 'crypto') q = await coingecko(symbol);
    else if (type === 'forex') q = await erApi(...symbol.split('/'));
    else throw e;
  }
  if (type === 'forex') q.currency = symbol.split('/')[1];
  if (type === 'crypto') q.currency = 'USD';
  q.usdRate = await usdRate(q.currency, cache);
  q.changePct = q.prevClose ? ((q.price - q.prevClose) / q.prevClose) * 100 : null;
  q.at = Date.now();
  return q;
}

// items: [{key, type, symbol}] -> {key: quote | {error}}
export async function fetchAll(items) {
  const out = {};
  const cache = new Map();
  const queue = [...items];
  const worker = async () => {
    while (queue.length) {
      const it = queue.shift();
      try { out[it.key] = await fetchQuote(it.type, it.symbol, cache); }
      catch (e) { out[it.key] = { error: e.message || 'Price lookup failed', at: Date.now() }; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker));
  return out;
}
