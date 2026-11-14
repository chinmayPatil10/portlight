import assert from 'node:assert/strict';
import { parseLocal, settleTouch, isMet, describe, isValidRule } from '../lib/alerts.js';
import { summarize, riskFlags, snapshot } from '../lib/portfolio.js';
import { normalize, yahooSymbol } from '../lib/symbols.js';

const H = [{ type: 'stock', symbol: 'AAPL' }, { type: 'crypto', symbol: 'BTC' }, { type: 'stock', symbol: 'VOO' }];
const t = (s) => parseLocal(s, H);
assert.deepEqual(t('Tell me if EUR/USD drops 1% today'), { assetType: 'forex', symbol: 'EUR/USD', metric: 'day_change_pct', op: 'below', value: -1 });
assert.deepEqual(t('BTC above 120000'), { assetType: 'crypto', symbol: 'BTC', metric: 'price', op: 'above', value: 120000 });
assert.deepEqual(t('btc above 120k'), { assetType: 'crypto', symbol: 'BTC', metric: 'price', op: 'above', value: 120000 });
assert.deepEqual(t('AAPL moves 3% either way'), { assetType: 'stock', symbol: 'AAPL', metric: 'day_change_pct', op: 'abs_above', value: 3 });
assert.deepEqual(t('alert me when aapl falls below $180.50'), { assetType: 'stock', symbol: 'AAPL', metric: 'price', op: 'below', value: 180.5 });
assert.deepEqual(t('notify me if bitcoin gains 5 percent'), { assetType: 'crypto', symbol: 'BTC', metric: 'day_change_pct', op: 'above', value: 5 });
assert.deepEqual(t('TSLA hits 300'), { assetType: 'stock', symbol: 'TSLA', metric: 'price', op: 'touch', value: 300 });
assert.deepEqual(t('usd/jpy under 148.2'), { assetType: 'forex', symbol: 'USD/JPY', metric: 'price', op: 'below', value: 148.2 });
assert.equal(t('how is my portfolio doing'), null);
assert.equal(t('AAPL 200'), null);
assert.equal(settleTouch(t('TSLA hits 300'), 250).op, 'above');
assert.equal(settleTouch(t('TSLA hits 300'), 350).op, 'below');
assert.ok(isValidRule(t('BTC above 120000')));
assert.ok(!isValidRule({ assetType: 'stock', symbol: 'X', metric: 'price', op: 'abs_above', value: 1 }));

assert.ok(isMet({ metric: 'price', op: 'above', value: 100 }, { price: 100 }));
assert.ok(!isMet({ metric: 'price', op: 'below', value: 100 }, { price: 101 }));
assert.ok(isMet({ metric: 'day_change_pct', op: 'below', value: -1 }, { price: 1, changePct: -1.2 }));
assert.ok(!isMet({ metric: 'day_change_pct', op: 'below', value: -1 }, { price: 1, changePct: 0.5 }));
assert.ok(isMet({ metric: 'day_change_pct', op: 'abs_above', value: 3 }, { price: 1, changePct: -3.4 }));
assert.ok(!isMet({ metric: 'day_change_pct', op: 'above', value: 3 }, { price: 1, changePct: null }));
assert.equal(describe({ symbol: 'EUR/USD', metric: 'day_change_pct', op: 'below', value: -1 }), 'EUR/USD down 1% or more on the day');
assert.equal(describe({ symbol: 'BTC', metric: 'price', op: 'above', value: 120000 }), 'BTC price at or above 120,000');

assert.deepEqual(normalize('forex', 'eurusd'), { type: 'forex', symbol: 'EUR/USD', key: 'forex:EUR/USD' });
assert.equal(normalize('crypto', 'btc-usd').symbol, 'BTC');
assert.equal(normalize('crypto', 'bitcoin').symbol, 'BTC');
assert.equal(normalize('stock', ' brk.b ').symbol, 'BRK.B');
assert.throws(() => normalize('forex', 'EUR'));
assert.equal(yahooSymbol('forex', 'EUR/USD'), 'EURUSD=X');
assert.equal(yahooSymbol('crypto', 'BTC'), 'BTC-USD');

// Portfolio maths
const holdings = [
  { key: 'stock:AAPL', type: 'stock', symbol: 'AAPL', qty: 10, cost: 200 },
  { key: 'forex:USD/JPY', type: 'forex', symbol: 'USD/JPY', qty: 1000, cost: null },
  { key: 'crypto:BTC', type: 'crypto', symbol: 'BTC', qty: 0.1, cost: 50000 },
  { key: 'stock:NOPE', type: 'stock', symbol: 'NOPE', qty: 5, cost: null },
];
const quotes = {
  'stock:AAPL': { price: 250, prevClose: 245, currency: 'USD', usdRate: 1, changePct: 2.04 },
  'forex:USD/JPY': { price: 150, prevClose: 151.5, currency: 'JPY', usdRate: 1 / 150, changePct: -0.99 },
  'crypto:BTC': { price: 100000, prevClose: 104000, currency: 'USD', usdRate: 1, changePct: -3.85 },
  'stock:NOPE': { error: 'No data' },
};
const s = summarize(holdings, quotes);
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);
near(s.rows[0].value, 2500); near(s.rows[1].value, 1000); near(s.rows[2].value, 10000);
near(s.total, 13500);
near(s.dayPnl, 50 + (1000 * -1.5 / 150) + (0.1 * -4000));
near(s.totalPnl, 500 + 5000);
near(s.totalPct, 5500 / 7000 * 100);
near(s.classPct.crypto, 10000 / 13500 * 100);
assert.deepEqual(s.missing, ['NOPE']);
const flags = riskFlags(s);
assert.ok(flags.some((f) => f.level === 'high' && /BTC is 74%/.test(f.title)));
assert.ok(flags.some((f) => /Crypto is 74%/.test(f.title)));
assert.equal(snapshot(s).positions.length, 4);
assert.deepEqual(riskFlags(summarize([], {})), []);
console.log('logic tests passed');
