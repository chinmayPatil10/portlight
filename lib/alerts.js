// Alert shape:
// {id, text, key, assetType, symbol, metric: 'price'|'day_change_pct',
//  op: 'above'|'below'|'abs_above', value, status: 'active'|'triggered', triggeredAt, triggeredDay, seen}
import { CRYPTO_IDS, CRYPTO_NAMES } from './symbols.js';

const UP = /\b(above|over|exceeds?|rises?|climbs?|gains?|up|jumps?|higher|more than|at least|tops?|breaks?|rall(y|ies))\b|>/i;
const DOWN = /\b(below|under|drops?|falls?|down|dips?|loses?|lower|less than|sinks?|slips?|declines?|crash(es)?)\b|</i;
const EITHER = /\b(moves?|changes?|swings?|either way|in either direction)\b/i;
const TOUCH = /\b(hits?|reach(es)?|touch(es)?|gets? to|at|is|equals?)\b/i;
const STOP = new Set(['I', 'A', 'USD', 'IF', 'ME', 'TELL', 'ALERT', 'WHEN', 'THE', 'TODAY', 'BY', 'TO', 'OR', 'AND', 'IN', 'ON', 'IT', 'IS', 'AT', 'UP', 'A.M', 'P.M', 'ANY', 'DAY', 'WAY', 'MY', 'PRICE', 'MORE', 'THAN', 'NOTIFY', 'PING', 'OF']);

// Understands simple phrasings without AI. Returns null when it can't tell.
export function parseLocal(text, holdings = []) {
  const t = String(text || '').trim();
  if (!t) return null;
  let assetType, symbol, rest = t;

  const pair = t.match(/\b([A-Za-z]{3})\s*\/\s*([A-Za-z]{3})\b/);
  if (pair) {
    assetType = 'forex'; symbol = `${pair[1]}/${pair[2]}`.toUpperCase(); rest = t.replace(pair[0], ' ');
  } else {
    const words = t.match(/[A-Za-z][A-Za-z0-9.\-]*/g) || [];
    const pick = (w, type, sym) => { assetType = type; symbol = sym; rest = t.replace(w, ' '); return true; };
    const tryWord = (w) => {
      const W = w.toUpperCase();
      if (CRYPTO_NAMES[W]) return pick(w, 'crypto', CRYPTO_NAMES[W]);
      if (STOP.has(W)) return false;
      const hold = holdings.find((h) => h.type !== 'forex' && h.symbol === W && (W.length >= 3 || w === W));
      if (hold) return pick(w, hold.type, hold.symbol);
      if (CRYPTO_IDS[W] && (W.length >= 3) && (w === W || W.length >= 4 || ['BTC', 'ETH', 'SOL', 'XRP', 'ADA'].includes(W))) return pick(w, 'crypto', W);
      if (w === W && /^[A-Z][A-Z0-9.\-]{0,5}$/.test(w)) return pick(w, 'stock', W);
      return false;
    };
    if (!words.some(tryWord)) return null;
  }

  const nums = [...rest.matchAll(/(\d[\d,]*\.?\d*|\.\d+)\s*(k|m)?\s*(%|percent|pct)?/gi)];
  if (!nums.length) return null;
  const m = nums.find((n) => n[3]) || nums.at(-1);
  let value = parseFloat(m[1].replace(/,/g, ''));
  if (!isFinite(value)) return null;
  if (m[2]) value *= m[2].toLowerCase() === 'k' ? 1e3 : 1e6;
  const isPct = Boolean(m[3]);

  const up = UP.test(rest), down = DOWN.test(rest), either = EITHER.test(rest);
  let metric, op;
  if (isPct) {
    metric = 'day_change_pct';
    if (down && !up) { op = 'below'; value = -Math.abs(value); }
    else if (up && !down) { op = 'above'; value = Math.abs(value); }
    else if (either || (up && down)) { op = 'abs_above'; value = Math.abs(value); }
    else return null;
  } else {
    metric = 'price';
    if (down && !up) op = 'below';
    else if (up && !down) op = 'above';
    else if (TOUCH.test(rest)) op = 'touch'; // settled against the current price when the alert is saved
    else return null;
  }
  return { assetType, symbol, metric, op, value };
}

// "hits 200" means whichever direction 200 lies in from the current price.
export function settleTouch(rule, price) {
  if (rule.op !== 'touch') return rule;
  return { ...rule, op: rule.value >= price ? 'above' : 'below' };
}

export function isValidRule(r) {
  return r && ['stock', 'forex', 'crypto'].includes(r.assetType) && typeof r.symbol === 'string'
    && ['price', 'day_change_pct'].includes(r.metric) && ['above', 'below', 'abs_above', 'touch'].includes(r.op)
    && typeof r.value === 'number' && isFinite(r.value) && !(r.metric === 'price' && r.op === 'abs_above');
}

export function isMet(a, q) {
  if (!q || typeof q.price !== 'number') return false;
  const x = a.metric === 'price' ? q.price : q.changePct;
  if (typeof x !== 'number') return false;
  if (a.op === 'above') return x >= a.value;
  if (a.op === 'below') return x <= a.value;
  if (a.op === 'abs_above') return Math.abs(x) >= a.value;
  return false;
}

const num = (v) => (Math.abs(v) >= 100 ? v.toLocaleString('en-US', { maximumFractionDigits: 2 }) : String(+v.toPrecision(6)));

export function describe(a) {
  if (a.metric === 'price') return `${a.symbol} price ${a.op === 'above' ? 'at or above' : 'at or below'} ${num(a.value)}`;
  if (a.op === 'abs_above') return `${a.symbol} moves ${num(a.value)}% or more in a day, either way`;
  return a.op === 'above' ? `${a.symbol} up ${num(a.value)}% or more on the day` : `${a.symbol} down ${num(Math.abs(a.value))}% or more on the day`;
}
