import { load, save, uid, today } from './lib/store.js';
import { normalize, TYPE_LABEL } from './lib/symbols.js';
import { fetchQuote } from './lib/prices.js';
import { summarize, riskFlags, fmtUsd } from './lib/portfolio.js';
import { parseLocal, settleTouch, describe, isMet } from './lib/alerts.js';
import { runCycle } from './lib/cycle.js';
import { localSuggest, remoteSuggest, merge } from './lib/search.js';
import * as ai from './lib/ai.js';

const hero = document.getElementById('hero');
const tabsEl = document.getElementById('tabs');
const view = document.getElementById('view');
const refreshBtn = document.getElementById('refresh');

let S;   // stored state
let sum; // computed portfolio summary
const ui = { tab: 'portfolio', adding: false, open: null, chatBusy: false, chatErr: '', alertDraft: '', chatDraft: '' };

const TABS = [['portfolio', 'Portfolio'], ['insights', 'Insights'], ['alerts', 'Alerts'], ['ask', 'Ask']];
const EXAMPLE_ALERTS = ['EUR/USD drops 1% today', 'BTC above 120000', 'AAPL moves 3% either way'];
const EXAMPLE_QUESTIONS = ['What moved my portfolio most today?', 'Which positions are below my cost?', 'What happens to my total if the dollar strengthens 5%?'];

/* ---------- small helpers ---------- */

function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'value') e.value = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false) continue;
    e.append(k.nodeType ? k : document.createTextNode(String(k)));
  }
  return e;
}

const signCls = (n) => (n > 0 ? 'up' : n < 0 ? 'down' : '');
const fmtPct = (n) => (n == null || !isFinite(n) ? '–' : `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toFixed(2)}%`);
const fmtQty = (n) => n.toLocaleString('en-US', { maximumFractionDigits: 8 });
const clock = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

function fmtPrice(type, q) {
  const p = q.price;
  const d = type === 'forex' ? (p >= 20 ? 2 : 4) : p >= 1 ? 2 : p >= 0.01 ? 4 : 6;
  const s = p.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  if (type === 'forex') return s;
  return q.currency === 'USD' ? `$${s}` : `${s} ${q.currency}`;
}

function ago(t) {
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  return `at ${clock(t)}`;
}

// Minimal, safe rendering of the model's text: paragraphs, bullets, bold.
function prose(text) {
  const root = h('div', { class: 'prose' });
  let ul = null;
  const inline = (el, s) => {
    s.split(/(\*\*[^*]+\*\*)/).forEach((part) => {
      const m = part.match(/^\*\*([^*]+)\*\*$/);
      el.append(m ? h('strong', null, m[1]) : part);
    });
    return el;
  };
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (!line) { ul = null; continue; }
    const b = line.match(/^[-*•]\s+(.*)/);
    if (b) {
      if (!ul) { ul = h('ul'); root.append(ul); }
      ul.append(inline(h('li'), b[1]));
    } else {
      ul = null;
      root.append(inline(h('p'), line.replace(/^#+\s*/, '')));
    }
  }
  return root;
}

function spark(vals, cls) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 64 22'); svg.setAttribute('width', '64'); svg.setAttribute('height', '22');
  svg.setAttribute('class', 'spark'); svg.setAttribute('aria-hidden', 'true');
  if (!vals || vals.length < 2) return svg;
  const min = Math.min(...vals), max = Math.max(...vals), span = max - min || 1;
  const pts = vals.map((v, i) => `${(i / (vals.length - 1) * 62 + 1).toFixed(1)},${(20 - ((v - min) / span) * 18).toFixed(1)}`).join(' ');
  const line = document.createElementNS(NS, 'polyline');
  line.setAttribute('points', pts); line.setAttribute('fill', 'none');
  line.setAttribute('stroke', `var(--${cls === 'down' ? 'down' : cls === 'up' ? 'up' : 'ink-2'})`);
  line.setAttribute('stroke-width', '1.5'); line.setAttribute('stroke-linejoin', 'round'); line.setAttribute('stroke-linecap', 'round');
  svg.append(line);
  return svg;
}

// Runs an action from a button, showing progress on the button and errors beside it.
async function run(btn, label, errEl, fn) {
  const old = btn.textContent;
  btn.disabled = true; btn.textContent = label;
  if (errEl) errEl.textContent = '';
  try {
    await fn();
  } catch (e) {
    if (errEl) errEl.textContent = e.message || String(e);
    if (btn.isConnected) { btn.disabled = false; btn.textContent = old; }
    return;
  }
  if (btn.isConnected) { btn.disabled = false; btn.textContent = old; }
}

const hasKey = () => Boolean(S.settings.apiKey);
const keyNote = (what) => h('p', { class: 'note' }, `${what} needs an Anthropic API key. `, h('button', { class: 'link', onclick: () => go('settings') }, 'Add one in Settings'), '.');

/* ---------- rendering ---------- */

function refresh(force = true) {
  sum = summarize(S.holdings, S.quotes);
  renderHero(); renderTabs();
  if (!force) {
    const a = document.activeElement;
    const typing = a && view.contains(a) && /INPUT|TEXTAREA|SELECT/.test(a.tagName);
    if (typing || ui.adding || ui.open || ui.tab === 'settings') return; // don't wipe a form mid-edit
  }
  renderView();
}

function go(tab) {
  const touchesAlerts = tab === 'alerts' || ui.tab === 'alerts';
  ui.tab = tab; ui.adding = false; ui.open = null;
  if (touchesAlerts && S.alerts.some((a) => a.status === 'triggered' && !a.seen)) {
    S.alerts = S.alerts.map((a) => ({ ...a, seen: true }));
    save({ alerts: S.alerts });
  }
  refresh();
  view.scrollTop = 0;
}

function renderHero() {
  hero.replaceChildren();
  if (!S.holdings.length) return;
  const [whole, cents] = fmtUsd(sum.total, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).split('.');
  hero.append(h('div', { class: 'total' }, whole, h('small', null, `.${cents}`)));
  const day = h('div', { class: 'day' });
  if (sum.dayPct != null) day.append(h('span', { class: signCls(sum.dayPnl) }, `${fmtUsd(sum.dayPnl, { signed: true })} (${fmtPct(sum.dayPct)})`), ' today');
  if (sum.totalPnl != null) day.append(h('br'), h('span', { class: signCls(sum.totalPnl) }, `${fmtUsd(sum.totalPnl, { signed: true })} (${fmtPct(sum.totalPct)})`), ' since you bought');
  hero.append(day);
  if (sum.total > 0) {
    const strip = h('div', { class: 'strip', role: 'img', 'aria-label': 'Allocation by asset type' });
    const legend = h('div', { class: 'legend' });
    for (const k of ['stock', 'forex', 'crypto']) {
      const p = sum.classPct[k];
      if (p <= 0) continue;
      strip.append(h('i', { class: `seg-${k}`, style: `flex-grow:${p.toFixed(2)}` }));
      legend.append(h('span', null, h('span', { class: `dot seg-${k}` }), `${TYPE_LABEL[k]} `, h('b', null, `${p.toFixed(0)}%`)));
    }
    hero.append(strip, legend);
  }
}

function renderTabs() {
  const unseen = ui.tab === 'alerts' ? 0 : S.alerts.filter((a) => a.status === 'triggered' && !a.seen).length;
  tabsEl.replaceChildren(...TABS.map(([id, label]) => h('button', {
    class: 'tab', role: 'tab', 'aria-selected': String(ui.tab === id), onclick: () => go(id),
  }, label, id === 'alerts' && unseen ? h('span', { class: 'badge', 'aria-label': `${unseen} triggered` }, unseen) : null)));
}

function renderView() {
  const render = { portfolio: viewPortfolio, insights: viewInsights, alerts: viewAlerts, ask: viewAsk, settings: viewSettings }[ui.tab];
  view.replaceChildren(...[render()].flat(Infinity).filter(Boolean));
}

/* ---------- Portfolio ---------- */

// Symbol field with a dropdown of suggestions. Typing anything else still works.
function symbolPicker(getType) {
  const input = h('input', { name: 'symbol', required: true, autocomplete: 'off', placeholder: 'AAPL', spellcheck: 'false',
    role: 'combobox', 'aria-autocomplete': 'list', 'aria-expanded': 'false', 'aria-controls': 'symbol-options' });
  const list = h('ul', { class: 'options', id: 'symbol-options', role: 'listbox', hidden: true });
  let items = [], active = -1, timer = null, seq = 0;

  const close = () => { list.hidden = true; active = -1; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); };
  const choose = (it) => { input.value = it.symbol; close(); };
  const draw = () => {
    list.replaceChildren(...items.map((it, i) => h('li', { role: 'option', id: `symbol-option-${i}`, 'aria-selected': String(i === active),
      onmousedown: (e) => { e.preventDefault(); choose(it); } }, h('b', null, it.symbol), h('span', null, it.name))));
    list.hidden = !items.length;
    input.setAttribute('aria-expanded', String(!list.hidden));
    if (active >= 0) { input.setAttribute('aria-activedescendant', `symbol-option-${active}`); list.children[active]?.scrollIntoView({ block: 'nearest' }); }
    else input.removeAttribute('aria-activedescendant');
  };
  const update = () => {
    const type = getType(), q = input.value, mine = ++seq;
    const local = localSuggest(type, q);
    items = local; active = -1; draw();
    clearTimeout(timer);
    if (q.trim().length < 2) return;
    timer = setTimeout(async () => {
      const remote = await remoteSuggest(type, q);
      if (mine !== seq || document.activeElement !== input) return; // a newer keystroke won
      items = merge(local, remote); active = -1; draw();
    }, 250);
  };

  input.addEventListener('input', update);
  input.addEventListener('focus', update);
  input.addEventListener('blur', () => { seq++; clearTimeout(timer); close(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { if (!list.hidden) { e.stopPropagation(); close(); } return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (list.hidden) { update(); return; }
      if (!items.length) return;
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length + (active < 0 && e.key === 'ArrowUp' ? 1 : 0)) % items.length;
      draw();
    } else if (e.key === 'Enter' && !list.hidden && active >= 0) {
      e.preventDefault(); choose(items[active]);
    }
  });
  return { input, el: h('div', { class: 'combo' }, input, list), reset: () => { input.value = ''; close(); } };
}

function holdingForm() {
  const err = h('p', { class: 'error', role: 'alert' });
  const submit = h('button', { class: 'btn', type: 'submit' }, 'Add holding');
  const picker = symbolPicker(() => type.value);
  const symbol = picker.input;
  const qtyLabel = h('span', null, 'Shares');
  const type = h('select', { name: 'type', onchange: () => {
    picker.reset();
    symbol.placeholder = { stock: 'AAPL', forex: 'EUR/USD', crypto: 'BTC' }[type.value];
    qtyLabel.textContent = { stock: 'Shares', forex: 'Units of the first currency', crypto: 'Coins' }[type.value];
  } }, Object.entries(TYPE_LABEL).map(([v, l]) => h('option', { value: v }, l)));
  const form = h('form', { class: 'card', onsubmit: (e) => {
    e.preventDefault();
    run(submit, 'Checking price…', err, async () => {
      const fd = new FormData(form);
      const n = normalize(fd.get('type'), fd.get('symbol'));
      const qty = parseFloat(fd.get('qty'));
      const cost = parseFloat(fd.get('cost'));
      if (!(qty > 0)) throw new Error('Enter a quantity above zero.');
      if (S.holdings.some((x) => x.key === n.key)) throw new Error(`${n.symbol} is already in your list. Select it there to change the quantity.`);
      let q;
      try { q = await fetchQuote(n.type, n.symbol); }
      catch { throw new Error(`No price found for ${n.symbol}. Check the symbol and the asset type.`); }
      S.holdings = [...S.holdings, { id: uid(), ...n, qty, cost: cost > 0 ? cost : null }];
      S.quotes = { ...S.quotes, [n.key]: q };
      await save({ holdings: S.holdings, quotes: S.quotes });
      ui.adding = false;
      refresh();
    });
  } },
  h('div', { class: 'fields' },
    h('label', null, 'Type', type),
    h('label', null, 'Symbol', picker.el),
    h('label', null, qtyLabel, h('input', { name: 'qty', type: 'number', step: 'any', min: '0', required: true, inputmode: 'decimal' })),
    h('label', null, 'Average price paid (optional)', h('input', { name: 'cost', type: 'number', step: 'any', min: '0', inputmode: 'decimal' }))),
  h('div', { class: 'actions' }, submit,
    S.holdings.length ? h('button', { class: 'btn quiet', type: 'button', onclick: () => { ui.adding = false; refresh(); } }, 'Cancel') : null),
  err);
  return form;
}

function holdingEditor(r) {
  const err = h('p', { class: 'error', role: 'alert' });
  const saveBtn = h('button', { class: 'btn', type: 'submit' }, 'Save changes');
  const form = h('form', { class: 'editor', onsubmit: (e) => {
    e.preventDefault();
    run(saveBtn, 'Saving…', err, async () => {
      const fd = new FormData(form);
      const qty = parseFloat(fd.get('qty')), cost = parseFloat(fd.get('cost'));
      if (!(qty > 0)) throw new Error('Enter a quantity above zero, or remove the holding.');
      S.holdings = S.holdings.map((x) => (x.id === r.id ? { ...x, qty, cost: cost > 0 ? cost : null } : x));
      await save({ holdings: S.holdings });
      ui.open = null; refresh();
    });
  } },
  h('div', { class: 'fields' },
    h('label', null, 'Quantity', h('input', { name: 'qty', type: 'number', step: 'any', min: '0', required: true, value: r.qty })),
    h('label', null, 'Average price paid', h('input', { name: 'cost', type: 'number', step: 'any', min: '0', value: r.cost ?? '' }))),
  h('div', { class: 'actions' }, saveBtn,
    h('button', { class: 'btn danger', type: 'button', onclick: async () => {
      S.holdings = S.holdings.filter((x) => x.id !== r.id);
      await save({ holdings: S.holdings });
      ui.open = null; refresh();
    } }, `Remove ${r.symbol}`)),
  err);
  return form;
}

function viewPortfolio() {
  if (!S.holdings.length) {
    return [h('div', { class: 'empty' }, h('h2', null, 'Add your first holding'),
      h('p', { class: 'muted' }, 'Enter what you own and Portlight prices it, totals it in dollars and keeps watch.')), holdingForm()];
  }
  const rows = [...sum.rows].sort((a, b) => (b.value ?? -1) - (a.value ?? -1));
  const list = h('ul', { class: 'rows' }, rows.map((r) => {
    const open = ui.open === r.id;
    const ch = r.q?.changePct;
    const sub = r.ok ? `${fmtQty(r.qty)} × ${fmtPrice(r.type, r.q)}${r.q.stale ? ', last known price' : ''}` : (r.q?.error ? 'No price right now' : 'Fetching price…');
    return h('li', { class: `row${open ? ' open' : ''}` },
      h('button', { class: 'row-main', 'aria-expanded': String(open), onclick: () => { ui.open = open ? null : r.id; ui.adding = false; refresh(); } },
        h('div', null,
          h('div', { class: 'sym' }, h('span', { class: `dot seg-${r.type}`, title: TYPE_LABEL[r.type] }), r.symbol),
          h('div', { class: 'sub' }, sub)),
        spark(r.q?.spark, signCls(ch)),
        h('div', { class: 'num' },
          h('div', { class: 'val' }, fmtUsd(r.value)),
          h('div', { class: `small ${signCls(ch)}` }, fmtPct(ch)))),
      open ? holdingEditor(r) : null);
  }));
  const updated = Math.max(S.quotesAt || 0, ...sum.rows.map((r) => r.q?.at || 0));
  const sources = [...new Set(sum.rows.map((r) => r.q?.source).filter(Boolean))].join(' and ');
  return [
    list,
    ui.adding ? h('div', { class: 'add-line' }, holdingForm())
      : h('div', { class: 'add-line' }, h('button', { class: 'btn quiet', onclick: () => { ui.adding = true; ui.open = null; refresh(); } }, 'Add holding')),
    h('p', { class: 'stamp' }, updated ? `Prices updated ${ago(updated)}${sources ? ` from ${sources}` : ''}. Quotes can be delayed; the percentage is the change since the previous close.` : 'Fetching prices…'),
  ];
}

/* ---------- Insights ---------- */

function aiBlock({ title, saved, isFresh, emptyText, buttonNew, buttonAgain, busyLabel, action, needs }) {
  const err = h('p', { class: 'error', role: 'alert' });
  const btn = h('button', { class: saved ? 'btn quiet' : 'btn' }, saved ? buttonAgain : buttonNew);
  btn.addEventListener('click', () => run(btn, busyLabel, err, async () => { await action(); refresh(); }));
  return h('section', null, h('h2', null, title),
    saved ? [prose(saved.text), h('p', { class: 'stamp' }, `Written ${isFresh ? '' : `${new Date(saved.at).toLocaleDateString([], { month: 'short', day: 'numeric' })} `}at ${clock(saved.at)} by ${S.settings.model}. Not financial advice.`)]
      : h('p', { class: 'muted' }, emptyText),
    hasKey() ? h('div', { class: 'actions' }, btn) : keyNote(needs), err);
}

function viewInsights() {
  if (!S.holdings.length) return h('p', { class: 'muted' }, 'Add a holding on the Portfolio tab and the brief and risk check appear here.');
  const brief = aiBlock({
    title: "Today's brief", saved: S.brief, isFresh: S.brief?.date === today(),
    emptyText: 'A short read on what moved your total today and what to watch.',
    buttonNew: "Write today's brief", buttonAgain: 'Rewrite brief', busyLabel: 'Writing…', needs: 'The brief',
    action: async () => { S.brief = { date: today(), text: await ai.writeBrief(S), at: Date.now() }; await save({ brief: S.brief }); },
  });

  const flags = riskFlags(sum);
  const held = sum.rows.filter((r) => r.value > 0).sort((a, b) => b.value - a.value);
  const risk = h('section', null, h('h2', null, 'Risk check'),
    flags.length
      ? h('ul', { class: 'flags' }, flags.map((f) => h('li', { class: `flag lvl-${f.level}` }, h('strong', null, f.title), h('span', null, f.detail))))
      : h('p', { class: 'muted' }, 'No concentration flags. No single position, asset type or currency dominates.'),
    h('ul', { class: 'weights', 'aria-label': 'Position weights' }, held.slice(0, 8).map((r) => h('li', null,
      h('span', null, r.symbol),
      h('span', { class: 'track' }, h('i', { class: `seg-${r.type}`, style: `width:${r.weight.toFixed(1)}%` })),
      h('span', { class: 'num' }, `${r.weight.toFixed(0)}%`)))));

  const review = aiBlock({
    title: 'AI review', saved: S.review, isFresh: S.review && new Date(S.review.at).toLocaleDateString('en-CA') === today(),
    emptyText: 'A second opinion on what the rules above miss: positions that move together, and what a bad day could cost.',
    buttonNew: 'Review my risk', buttonAgain: 'Review again', busyLabel: 'Reviewing…', needs: 'The review',
    action: async () => { S.review = { text: await ai.writeReview(S), at: Date.now() }; await save({ review: S.review }); },
  });
  return [brief, risk, review];
}

/* ---------- Alerts ---------- */

async function addAlert(text) {
  let rule;
  const local = parseLocal(text, S.holdings);
  if (hasKey()) {
    try { rule = await ai.parseAlert(S, text); }
    catch (e) { if (!local) throw e; rule = local; }
  } else {
    rule = local;
    if (!rule) throw new Error('Portlight could not read that. Try "AAPL above 250" or "EUR/USD drops 1%". With an API key in Settings it understands freer wording.');
  }
  const n = normalize(rule.assetType, rule.symbol);
  let q;
  try { q = await fetchQuote(n.type, n.symbol); }
  catch { throw new Error(`No price found for ${n.symbol}, so Portlight can't watch it.`); }
  rule = settleTouch(rule, q.price);
  const a = { id: uid(), text, key: n.key, assetType: n.type, symbol: n.symbol, metric: rule.metric, op: rule.op, value: rule.value, status: 'active', createdAt: Date.now() };
  if (isMet(a, q)) throw new Error(`That is already true: ${n.symbol} is at ${fmtPrice(n.type, q)}${a.metric === 'price' ? '' : `, ${fmtPct(q.changePct)} on the day`}. Choose a level it hasn't reached.`);
  S.alerts = [a, ...S.alerts];
  S.quotes = { ...S.quotes, [n.key]: q };
  await save({ alerts: S.alerts, quotes: S.quotes });
}

function viewAlerts() {
  const err = h('p', { class: 'error', role: 'alert' });
  const btn = h('button', { class: 'btn', type: 'submit' }, 'Add alert');
  const input = h('textarea', { name: 'text', required: true, rows: '2', placeholder: `Tell me if ${EXAMPLE_ALERTS[0]}`, 'aria-label': 'Describe the alert', oninput: () => { ui.alertDraft = input.value; } });
  input.value = ui.alertDraft;
  const form = h('form', { class: 'card', onsubmit: (e) => {
    e.preventDefault();
    run(btn, 'Setting up…', err, async () => { await addAlert(input.value.trim()); ui.alertDraft = ''; refresh(); });
  } },
  h('label', null, 'Describe what to watch for, in your own words', input),
  h('div', { class: 'actions' }, btn),
  h('p', { class: 'small muted', style: 'margin:10px 0 0' }, `Examples: ${EXAMPLE_ALERTS.map((x) => `"${x}"`).join(', ')}.`),
  err);

  const list = S.alerts.length
    ? S.alerts.map((a) => {
      const q = S.quotes[a.key];
      const hit = a.status === 'triggered';
      const nowText = q && typeof q.price === 'number' ? `Now ${fmtPrice(a.assetType, q)}${typeof q.changePct === 'number' ? `, ${fmtPct(q.changePct)} on the day` : ''}.` : '';
      return h('div', { class: 'alert' },
        h('div', { class: 'alert-head' }, h('strong', null, describe(a)), h('span', { class: `state${hit ? ' hit' : ''}` }, hit ? `Triggered ${ago(a.triggeredAt)}` : 'Watching')),
        h('div', { class: 'small muted' }, hit ? `${a.triggeredNote}.` : nowText, a.text && a.text !== describe(a) ? ` You wrote: "${a.text}"` : ''),
        h('div', { class: 'actions' },
          hit ? h('button', { class: 'link', onclick: async () => { S.alerts = S.alerts.map((x) => (x.id === a.id ? { ...x, status: 'active', triggeredDay: null } : x)); await save({ alerts: S.alerts }); refresh(); } }, 'Watch again') : null,
          h('button', { class: 'link', onclick: async () => { S.alerts = S.alerts.filter((x) => x.id !== a.id); await save({ alerts: S.alerts }); refresh(); } }, 'Delete')));
    })
    : h('p', { class: 'muted' }, 'No alerts yet.');

  return [form, h('section', null, h('h2', null, 'Your alerts'), list,
    h('p', { class: 'stamp' }, 'Portlight checks prices every 5 minutes while Chrome is running and sends a desktop notification. Daily-change alerts reset each day.'))];
}

/* ---------- Ask ---------- */

async function sendChat(text) {
  if (!text || ui.chatBusy) return;
  const before = S.chat;
  const history = [...before, { role: 'user', content: text }];
  S.chat = history;
  ui.chatBusy = true; ui.chatErr = ''; ui.chatDraft = '';
  await save({ chat: history }); // saved first so a background price refresh can't drop the question
  refresh();
  view.scrollTop = view.scrollHeight;
  try {
    const answer = await ai.chat(S, history);
    S.chat = [...history, { role: 'assistant', content: answer }].slice(-30);
  } catch (e) {
    ui.chatErr = e.message || String(e);
    ui.chatDraft = text;
    S.chat = before;
  }
  await save({ chat: S.chat });
  ui.chatBusy = false;
  if (ui.tab === 'ask') { refresh(); view.scrollTop = view.scrollHeight; }
}

function viewAsk() {
  if (!S.holdings.length) return h('p', { class: 'muted' }, 'Add a holding on the Portfolio tab, then ask questions about it here.');
  if (!hasKey()) return [h('h2', null, 'Ask about your portfolio'), keyNote('Chat')];
  const input = h('textarea', { rows: '1', placeholder: 'Ask about your holdings', 'aria-label': 'Your question', oninput: () => { ui.chatDraft = input.value; },
    onkeydown: (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(input.value.trim()); } } });
  input.value = ui.chatDraft;
  const intro = S.chat.length ? null : [
    h('h2', null, 'Ask about your portfolio'),
    h('p', { class: 'muted' }, 'Answers use your current holdings and prices.'),
    h('div', { class: 'chips' }, EXAMPLE_QUESTIONS.map((q) => h('button', { class: 'chip', onclick: () => sendChat(q) }, q)))];
  return [intro,
    h('div', { class: 'chat', 'aria-live': 'polite' },
      S.chat.map((m) => h('div', { class: `msg ${m.role}` }, m.role === 'assistant' ? prose(m.content) : m.content)),
      ui.chatBusy ? h('div', { class: 'msg assistant muted' }, 'Thinking…') : null),
    ui.chatErr ? h('p', { class: 'error', role: 'alert' }, ui.chatErr) : null,
    h('form', { class: 'ask', onsubmit: (e) => { e.preventDefault(); sendChat(input.value.trim()); } }, input,
      h('button', { class: 'btn', type: 'submit', disabled: ui.chatBusy }, 'Send')),
    S.chat.length ? h('p', { class: 'stamp' }, 'Not financial advice. ', h('button', { class: 'link small', onclick: async () => { S.chat = []; await save({ chat: [] }); refresh(); } }, 'Clear conversation')) : null];
}

/* ---------- Settings ---------- */

function viewSettings() {
  const st = S.settings;
  const msg = h('p', { class: 'error', role: 'status' });
  const btn = h('button', { class: 'btn', type: 'submit' }, 'Save settings');
  const models = [...new Set(['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', st.model])];
  const form = h('form', { class: 'card', onsubmit: (e) => {
    e.preventDefault();
    run(btn, 'Saving…', msg, async () => {
      const fd = new FormData(form);
      S.settings = { apiKey: String(fd.get('apiKey') || '').trim(), model: fd.get('model'), webSearch: fd.has('webSearch'), autoBrief: fd.has('autoBrief'), briefHour: Number(fd.get('briefHour')) };
      await save({ settings: S.settings });
      go('portfolio');
    });
  } },
  h('div', { class: 'fields' },
    h('label', { class: 'wide' }, 'Anthropic API key', h('input', { name: 'apiKey', type: 'password', autocomplete: 'off', placeholder: 'sk-ant-…', value: st.apiKey })),
    h('label', { class: 'wide' }, 'Model', h('select', { name: 'model' }, models.map((m) => h('option', { value: m, selected: m === st.model }, m)))),
    h('label', { class: 'wide check' }, h('input', { name: 'webSearch', type: 'checkbox', checked: st.webSearch }), 'Let the brief and chat search the web for news'),
    h('label', { class: 'wide check' }, h('input', { name: 'autoBrief', type: 'checkbox', checked: st.autoBrief }), 'Write the brief automatically each day'),
    h('label', null, 'Earliest time for the brief', h('select', { name: 'briefHour' }, Array.from({ length: 24 }, (_, i) => h('option', { value: i, selected: i === st.briefHour }, new Date(2000, 0, 1, i).toLocaleTimeString([], { hour: 'numeric' })))))),
  h('div', { class: 'actions' }, btn, h('button', { class: 'btn quiet', type: 'button', onclick: () => go('portfolio') }, 'Cancel')),
  msg);

  const exportBtn = h('button', { class: 'btn quiet', onclick: () => {
    const blob = new Blob([JSON.stringify({ holdings: S.holdings, alerts: S.alerts }, null, 2)], { type: 'application/json' });
    const a = h('a', { href: URL.createObjectURL(blob), download: `portlight-${today()}.json` });
    a.click(); URL.revokeObjectURL(a.href);
  } }, 'Export holdings and alerts');
  let armed = false;
  const wipe = h('button', { class: 'btn danger', style: 'margin-left:0', onclick: async () => {
    if (!armed) { armed = true; wipe.textContent = 'Select again to delete everything'; return; }
    await chrome.storage.local.clear(); S = await load(); go('portfolio');
  } }, 'Delete all Portlight data');

  return [h('h2', null, 'Settings'), form,
    h('section', null, h('h2', null, 'Your data'),
      h('p', { class: 'muted small' }, 'Holdings, alerts and the API key are stored in Chrome on this computer only. The key is not encrypted, so use one with a spending limit. Your holdings are sent to Anthropic only when you use the brief, review, chat or a free-form alert. Prices come from Yahoo Finance, with CoinGecko and open.er-api.com as backups.'),
      h('div', { class: 'actions' }, exportBtn, wipe))];
}

/* ---------- wiring ---------- */

async function refreshPrices(force) {
  refreshBtn.classList.add('spin');
  try { await runCycle({ force }); } catch { /* shown per row */ }
  refreshBtn.classList.remove('spin');
  S = await load();
  refresh(false);
}

refreshBtn.addEventListener('click', () => refreshPrices(true));
document.getElementById('open-settings').addEventListener('click', () => go(ui.tab === 'settings' ? 'portfolio' : 'settings'));

chrome.storage.onChanged.addListener(async (_changes, area) => {
  if (area !== 'local') return;
  S = await load();
  refresh(false);
});

S = await load();
refresh();
refreshPrices(false);
setInterval(() => { if (document.visibilityState === 'visible') refreshPrices(false); }, 60_000);
