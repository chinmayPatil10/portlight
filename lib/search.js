// Symbol suggestions for the "Add holding" form: a built-in list that answers
// instantly, topped up by Yahoo Finance's search for anything not on it.
const STOCKS = [
  ['AAPL', 'Apple'], ['MSFT', 'Microsoft'], ['NVDA', 'Nvidia'], ['GOOGL', 'Alphabet'], ['AMZN', 'Amazon'],
  ['META', 'Meta Platforms'], ['TSLA', 'Tesla'], ['BRK.B', 'Berkshire Hathaway'], ['JPM', 'JPMorgan Chase'], ['V', 'Visa'],
  ['AVGO', 'Broadcom'], ['AMD', 'Advanced Micro Devices'], ['NFLX', 'Netflix'], ['COST', 'Costco'], ['WMT', 'Walmart'],
  ['DIS', 'Walt Disney'], ['KO', 'Coca-Cola'], ['PLTR', 'Palantir'], ['HOOD', 'Robinhood Markets'], ['COIN', 'Coinbase'],
  ['VOO', 'Vanguard S&P 500 ETF'], ['SPY', 'SPDR S&P 500 ETF'], ['VTI', 'Vanguard Total Stock Market ETF'], ['QQQ', 'Invesco QQQ (Nasdaq-100)'],
  ['VXUS', 'Vanguard Total International Stock ETF'], ['SCHD', 'Schwab US Dividend Equity ETF'], ['BND', 'Vanguard Total Bond Market ETF'],
  ['IWM', 'iShares Russell 2000 ETF'], ['GLD', 'SPDR Gold Shares'], ['VNQ', 'Vanguard Real Estate ETF'],
];
const CURRENCY = { EUR: 'Euro', USD: 'US dollar', GBP: 'British pound', JPY: 'Japanese yen', CHF: 'Swiss franc', AUD: 'Australian dollar', CAD: 'Canadian dollar', NZD: 'New Zealand dollar', INR: 'Indian rupee', MXN: 'Mexican peso', CNY: 'Chinese yuan', SGD: 'Singapore dollar' };
const PAIRS = ['EUR/USD', 'USD/JPY', 'GBP/USD', 'USD/CHF', 'AUD/USD', 'USD/CAD', 'NZD/USD', 'EUR/GBP', 'EUR/JPY', 'GBP/JPY', 'EUR/CHF', 'AUD/JPY', 'EUR/AUD', 'EUR/CAD', 'GBP/CHF', 'CAD/JPY', 'USD/INR', 'USD/MXN', 'USD/CNY', 'USD/SGD'];
const FOREX = PAIRS.map((p) => [p, p.split('/').map((c) => CURRENCY[c]).join(' / ')]);
const CRYPTO = [
  ['BTC', 'Bitcoin'], ['ETH', 'Ethereum'], ['SOL', 'Solana'], ['XRP', 'XRP'], ['BNB', 'BNB'], ['DOGE', 'Dogecoin'], ['ADA', 'Cardano'],
  ['LINK', 'Chainlink'], ['AVAX', 'Avalanche'], ['LTC', 'Litecoin'], ['DOT', 'Polkadot'], ['TRX', 'TRON'], ['XLM', 'Stellar'], ['BCH', 'Bitcoin Cash'],
  ['UNI', 'Uniswap'], ['ATOM', 'Cosmos'], ['NEAR', 'NEAR Protocol'], ['SHIB', 'Shiba Inu'], ['TON', 'Toncoin'], ['USDC', 'USD Coin'], ['USDT', 'Tether'],
];
const LISTS = { stock: STOCKS, forex: FOREX, crypto: CRYPTO };

const squash = (s) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');

// Instant matches. With nothing typed, returns the most common picks.
export function localSuggest(type, query, limit = 7) {
  const list = LISTS[type] || [];
  const q = squash(query || '');
  if (!q) return list.slice(0, limit).map(([symbol, name]) => ({ symbol, name }));
  const rank = ([sym, name]) => {
    const s = squash(sym), n = squash(name);
    if (s === q) return 0;
    if (s.startsWith(q)) return 1;
    if (n.startsWith(q) || name.toUpperCase().split(/[^A-Z0-9]+/).some((w) => w.startsWith(q))) return 2;
    if (q.length >= 3 && (s.includes(q) || n.includes(q))) return 3;
    return -1;
  };
  return list.map((x) => [rank(x), x]).filter(([r]) => r >= 0).sort((a, b) => a[0] - b[0]).slice(0, limit).map(([, [symbol, name]]) => ({ symbol, name }));
}

// Wider search. Returns [] on any failure so the form keeps working.
export async function remoteSuggest(type, query, limit = 7) {
  const q = (query || '').trim();
  if (q.length < 2) return [];
  try {
    const r = await fetch(`https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=12&newsCount=0`, { credentials: 'omit' });
    if (!r.ok) return [];
    const out = [];
    for (const x of (await r.json())?.quotes || []) {
      const name = x.shortname || x.longname || '';
      const sym = String(x.symbol || '');
      if (type === 'stock' && ['EQUITY', 'ETF', 'MUTUALFUND'].includes(x.quoteType)) out.push({ symbol: sym, name: [name, x.exchDisp].filter(Boolean).join(', ') });
      else if (type === 'crypto' && x.quoteType === 'CRYPTOCURRENCY' && sym.endsWith('-USD')) out.push({ symbol: sym.slice(0, -4), name: name.replace(/\s+USD$/, '') });
      else if (type === 'forex' && x.quoteType === 'CURRENCY' && /^[A-Z]{6}=X$/.test(sym)) out.push({ symbol: `${sym.slice(0, 3)}/${sym.slice(3, 6)}`, name });
    }
    return out.slice(0, limit);
  } catch {
    return [];
  }
}

export function merge(a, b, limit = 7) {
  const seen = new Set();
  return [...a, ...b].filter((x) => !seen.has(x.symbol) && seen.add(x.symbol)).slice(0, limit);
}
