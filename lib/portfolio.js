// Pure maths: no network, no storage. Values are in US dollars.
export function summarize(holdings, quotes) {
  const rows = holdings.map((h) => {
    const q = quotes[h.key];
    const ok = q && typeof q.price === 'number';
    const rate = ok ? (q.usdRate ?? 1) : 1;
    const value = ok ? h.qty * q.price * rate : null;
    const dayPnl = ok && q.prevClose ? h.qty * (q.price - q.prevClose) * rate : null;
    const totalPnl = ok && h.cost ? h.qty * (q.price - h.cost) * rate : null;
    const costUsd = ok && h.cost ? h.qty * h.cost * rate : null;
    const exposure = h.type === 'crypto' ? 'crypto' : h.type === 'forex' ? h.symbol.split('/')[0] : (ok ? (q.currency || 'USD') : 'USD');
    return { ...h, q: q || null, ok, value, dayPnl, totalPnl, costUsd, exposure, weight: 0 };
  });

  const sum = (f) => rows.reduce((a, r) => a + (f(r) ?? 0), 0);
  const total = sum((r) => r.value);
  const dayPnl = sum((r) => r.dayPnl);
  const prevTotal = total - dayPnl;
  const costBasis = sum((r) => r.costUsd);
  const byClass = { stock: 0, forex: 0, crypto: 0 };
  for (const r of rows) {
    r.weight = total > 0 && r.value != null ? (r.value / total) * 100 : 0;
    byClass[r.type] += r.value ?? 0;
  }
  return {
    rows, total, dayPnl,
    dayPct: prevTotal > 0 ? (dayPnl / prevTotal) * 100 : null,
    totalPnl: costBasis > 0 ? sum((r) => r.totalPnl) : null,
    totalPct: costBasis > 0 ? (sum((r) => r.totalPnl) / costBasis) * 100 : null,
    byClass,
    classPct: Object.fromEntries(Object.entries(byClass).map(([k, v]) => [k, total > 0 ? (v / total) * 100 : 0])),
    missing: rows.filter((r) => !r.ok).map((r) => r.symbol),
  };
}

// Rule-based checks that work without AI. level: 'high' | 'medium' | 'note'
export function riskFlags(s) {
  const flags = [];
  const held = s.rows.filter((r) => r.value > 0).sort((a, b) => b.value - a.value);
  if (!held.length) return flags;
  const pct = (n) => `${n.toFixed(0)}%`;

  const top = held[0];
  if (held.length > 1 && top.weight >= 25) {
    flags.push({
      level: top.weight >= 40 ? 'high' : 'medium',
      title: `${top.symbol} is ${pct(top.weight)} of the portfolio`,
      detail: `A 10% move in ${top.symbol} changes the whole portfolio by about ${(top.weight / 10).toFixed(1)}%.`,
    });
  }
  if (held.length >= 5) {
    const top3 = held.slice(0, 3).reduce((a, r) => a + r.weight, 0);
    if (top3 >= 75) flags.push({ level: 'medium', title: `Top three positions hold ${pct(top3)}`, detail: `${held.slice(0, 3).map((r) => r.symbol).join(', ')} drive most of the result; the other ${held.length - 3} barely move it.` });
  }
  const c = s.classPct;
  if (c.crypto >= 15) flags.push({ level: c.crypto >= 30 ? 'high' : 'medium', title: `Crypto is ${pct(c.crypto)} of the portfolio`, detail: 'Crypto often moves several percent in a day, so this share sets most of the daily swing.' });
  if (c.forex >= 30) flags.push({ level: 'medium', title: `Forex is ${pct(c.forex)} of the portfolio`, detail: 'Portlight counts forex at full position size. If these positions are leveraged, losses can exceed the cash behind them.' });

  const hhi = held.reduce((a, r) => a + (r.weight / 100) ** 2, 0);
  const eff = 1 / hhi;
  if (held.length >= 4 && eff < held.length * 0.5) flags.push({ level: 'note', title: `${held.length} positions behave like about ${eff.toFixed(1)}`, detail: 'Weights are uneven, so diversification is thinner than the position count suggests.' });

  const nonUsd = held.filter((r) => r.exposure !== 'USD' && r.exposure !== 'crypto').reduce((a, r) => a + r.weight, 0);
  if (nonUsd >= 30) flags.push({ level: 'note', title: `${pct(nonUsd)} sits in currencies other than the dollar`, detail: 'The dollar value of these positions moves with exchange rates as well as prices.' });

  const classes = Object.values(s.byClass).filter((v) => v > 0).length;
  if (classes === 1 && held.length >= 2) flags.push({ level: 'note', title: 'Everything is in one asset class', detail: 'Positions in the same class tend to fall together in a sell-off.' });

  for (const r of held) {
    const ch = r.q?.changePct;
    if (typeof ch === 'number' && ch <= -5) flags.push({ level: 'note', title: `${r.symbol} is down ${Math.abs(ch).toFixed(1)}% today`, detail: `That is ${fmtUsd(r.dayPnl)} on this position.` });
  }
  return flags;
}

export function fmtUsd(n, opts = {}) {
  if (n == null || !isFinite(n)) return '–';
  const s = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: Math.abs(n) >= 100000 ? 0 : 2, ...opts }).format(Math.abs(n));
  return (n < 0 ? '−' : opts.signed && n > 0 ? '+' : '') + s;
}

// Compact picture of the portfolio for the AI features.
export function snapshot(s) {
  const r2 = (n) => (n == null ? null : Math.round(n * 100) / 100);
  return {
    date: new Date().toDateString(),
    totalUsd: r2(s.total), dayChangeUsd: r2(s.dayPnl), dayChangePct: r2(s.dayPct),
    gainSinceCostUsd: r2(s.totalPnl), gainSinceCostPct: r2(s.totalPct),
    allocationPct: Object.fromEntries(Object.entries(s.classPct).map(([k, v]) => [k, r2(v)])),
    positions: s.rows.map((r) => ({
      symbol: r.symbol, type: r.type, name: r.q?.name || undefined, quantity: r.qty,
      price: r.q?.price ?? null, priceCurrency: r.q?.currency, dayChangePct: r2(r.q?.changePct),
      valueUsd: r2(r.value), weightPct: r2(r.weight), avgCost: r.cost || null, gainUsd: r2(r.totalPnl),
    })),
  };
}
