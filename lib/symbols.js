export const TYPE_LABEL = { stock: 'Stocks and ETFs', forex: 'Forex', crypto: 'Crypto' };

// CoinGecko ids, used only as a fallback price source for crypto.
export const CRYPTO_IDS = {
  BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana', XRP: 'ripple', ADA: 'cardano',
  DOGE: 'dogecoin', BNB: 'binancecoin', DOT: 'polkadot', LTC: 'litecoin', LINK: 'chainlink',
  AVAX: 'avalanche-2', TRX: 'tron', XLM: 'stellar', ATOM: 'cosmos', UNI: 'uniswap',
  BCH: 'bitcoin-cash', NEAR: 'near', APT: 'aptos', ARB: 'arbitrum', OP: 'optimism',
  SHIB: 'shiba-inu', TON: 'the-open-network', USDT: 'tether', USDC: 'usd-coin',
};

export const CRYPTO_NAMES = {
  BITCOIN: 'BTC', ETHEREUM: 'ETH', ETHER: 'ETH', SOLANA: 'SOL', RIPPLE: 'XRP', CARDANO: 'ADA',
  DOGECOIN: 'DOGE', LITECOIN: 'LTC', CHAINLINK: 'LINK', POLKADOT: 'DOT',
};

// Returns {type, symbol, key} or throws with a message the user can act on.
export function normalize(type, raw) {
  const s = String(raw || '').trim().toUpperCase();
  if (!s) throw new Error('Enter a symbol.');
  let symbol;
  if (type === 'forex') {
    const letters = s.replace(/[^A-Z]/g, '');
    if (letters.length !== 6) throw new Error('Write a forex pair as two currency codes, like EUR/USD.');
    symbol = `${letters.slice(0, 3)}/${letters.slice(3)}`;
  } else if (type === 'crypto') {
    symbol = (CRYPTO_NAMES[s] || s).replace(/[-/ ]?USDT?$/, '') || s;
    if (!/^[A-Z0-9]{2,10}$/.test(symbol)) throw new Error('Write a crypto symbol like BTC or ETH.');
  } else if (type === 'stock') {
    symbol = s.replace(/\s+/g, '');
    if (!/^[A-Z0-9.\-^]{1,12}$/.test(symbol)) throw new Error('Write a ticker like AAPL or VOO.');
  } else {
    throw new Error('Choose stock, forex or crypto.');
  }
  return { type, symbol, key: `${type}:${symbol}` };
}

export function yahooSymbol(type, symbol) {
  if (type === 'forex') return symbol.replace('/', '') + '=X';
  if (type === 'crypto') return symbol + '-USD';
  return symbol;
}
