'use strict';
/*
 * Analytics for a binder: how its value has moved, what drives it, and how each card is doing.
 * The math lives in logic.js (binderAnalytics, holdingsSeries, movement...); this file draws it.
 *
 * Price history is recorded each time prices refresh (about once a day you use the app). Until a card has a few days of
 * its own history, its recent trend is estimated from Cardmarket's 1-, 7- and 30-day averages and marked as an estimate.
 */
const Analytics = (() => {
  const $ = (s, r = document) => r.querySelector(s);
  const st = { id: null, tab: 'cards', range: 30, moves: 30, group: 'rarity', metric: 'value' };
  let binds = [];

  const signed = v => `${v < 0 ? '−' : '+'}${usd(Math.abs(v))}`;
  const pct = v => `${v < 0 ? '−' : '+'}${Math.abs(v).toFixed(Math.abs(v) < 10 ? 1 : 0)}%`;
  const day = t => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const money0 = v => v >= 1000 ? `$${(v / 1000).toFixed(1)}k` : v >= 100 ? `$${Math.round(v)}` : usd(v);
  const cls = v => (v > 0.004 ? 'up' : v < -0.004 ? 'down' : '');
  const binder = () => store.collections.find(c => c.id === st.id);
  const qty = e => e.quantity || 1;

  /** A line chart with a touch-and-drag cursor. Returns { svg, bind(root) }. */
  function chart(points, o = {}) {
    const w = o.w || 340, h = o.h || 160;
    if (!points || points.length < 2) return { svg: '', bind() {} };
    const x0 = points[0][0], x1 = points[points.length - 1][0];
    let lo = Math.min(...points.map(p => p[1])), hi = Math.max(...points.map(p => p[1]));
    if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
    const pad = (hi - lo) * .15; lo = Math.max(0, lo - pad); hi += pad;
    const L = 6, R = 6, T = 10, B = 22;
    const px = t => L + (t - x0) / (x1 - x0 || 1) * (w - L - R);
    const py = v => T + (1 - (v - lo) / (hi - lo)) * (h - T - B);
    const line = points.map((p, i) => `${i ? 'L' : 'M'}${px(p[0]).toFixed(1)} ${py(p[1]).toFixed(1)}`).join(' ');
    const area = `${line} L${px(x1).toFixed(1)} ${h - B} L${px(x0).toFixed(1)} ${h - B} Z`;
    const col = o.color || '#3EE0A5', id = 'ch' + Math.random().toString(36).slice(2, 8);
    const grid = [0, .5, 1].map(f => {
      const v = lo + (hi - lo) * (1 - f), y = T + f * (h - T - B);
      return `<line x1="${L}" x2="${w - R}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" class="an-grid"/><text x="${w - R}" y="${(y - 3).toFixed(1)}" text-anchor="end" class="an-axis">${money0(v)}</text>`;
    }).join('');
    const svg = `<svg viewBox="0 0 ${w} ${h}" class="an-chart" data-ch="${id}" role="img" aria-label="${esc(o.label || 'Price chart')}">
      <defs><linearGradient id="${id}g" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${col}" stop-opacity=".38"/><stop offset="1" stop-color="${col}" stop-opacity="0"/></linearGradient></defs>
      ${grid}<path d="${area}" fill="url(#${id}g)"/><path d="${line}" fill="none" stroke="${col}" stroke-width="2.6" stroke-linejoin="round" stroke-linecap="round"/>
      <text x="${L}" y="${h - 5}" class="an-axis">${day(x0)}</text><text x="${w - R}" y="${h - 5}" text-anchor="end" class="an-axis">${day(x1)}</text>
      <g class="an-cursor" hidden><line y1="${T}" y2="${h - B}" class="an-cur-line"/><circle r="5" fill="${col}" stroke="#fff" stroke-width="2"/></g>
      <rect x="0" y="0" width="${w}" height="${h}" fill="transparent"/></svg>`;
    const bind = root => {
      const el = root.querySelector(`[data-ch="${id}"]`); if (!el) return;
      const cur = el.querySelector('.an-cursor'), tip = o.tip ? root.querySelector(o.tip) : null, base = tip ? tip.textContent : '';
      const move = ev => {
        const r = el.getBoundingClientRect(), x = (ev.clientX - r.left) / r.width * w;
        let best = 0, bd = Infinity; points.forEach((p, i) => { const d = Math.abs(px(p[0]) - x); if (d < bd) { bd = d; best = i; } });
        const p = points[best];
        cur.hidden = false; cur.setAttribute('transform', `translate(${px(p[0]).toFixed(1)} 0)`);
        cur.querySelector('circle').setAttribute('cy', py(p[1]).toFixed(1));
        if (tip) tip.textContent = `${day(p[0])}: ${usd(p[1])}`;
      };
      const end = () => { cur.hidden = true; if (tip) tip.textContent = base; };
      el.style.touchAction = 'pan-y';
      el.addEventListener('pointerdown', move);
      el.addEventListener('pointermove', ev => { if (ev.buttons || ev.pointerType === 'mouse') move(ev); });
      for (const t of ['pointerup', 'pointerleave', 'pointercancel']) el.addEventListener(t, end);
    };
    return { svg, bind };
  }

  const spark = (points, color) => {
    if (!points || points.length < 2) return '<span class="an-nospark"></span>';
    const w = 64, h = 22, x0 = points[0][0], x1 = points[points.length - 1][0];
    let lo = Math.min(...points.map(p => p[1])), hi = Math.max(...points.map(p => p[1])); if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
    const d = points.map((p, i) => `${i ? 'L' : 'M'}${(2 + (p[0] - x0) / (x1 - x0 || 1) * (w - 4)).toFixed(1)} ${(2 + (1 - (p[1] - lo) / (hi - lo)) * (h - 4)).toFixed(1)}`).join(' ');
    return `<svg class="an-spark" viewBox="0 0 ${w} ${h}" aria-hidden="true"><path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  };

  const chips = (name, value, options) => `<div class="an-chips" role="group">${options.map(([v, l]) =>
    `<button type="button" class="an-chip" data-an="${name}" data-v="${v}" aria-pressed="${String(value) === String(v)}">${l}</button>`).join('')}</div>`;
  const tile = (label, value, sub, c = '') => `<div class="an-tile"><small>${esc(label)}</small><b class="${c}">${value}</b><span>${sub || ''}</span></div>`;
  const bar = (label, sub, frac, right, color) => `<div class="an-bar"><div class="an-bar-top"><span class="an-bar-l">${esc(label)}</span><span class="an-bar-r">${right}</span></div>
    <div class="an-track"><i style="width:${Math.max(1.5, Math.min(100, frac * 100)).toFixed(1)}%;${color ? `background:${color}` : ''}"></i></div>${sub ? `<small>${sub}</small>` : ''}</div>`;

  // ---------- sections ----------
  function heroHtml(c, a, now) {
    const rate = fx.rate;
    let pts, note = '';
    if (st.tab === 'cards') {
      const firsts = c.cards.map(e => fullHist(e)[0]).filter(Boolean).map(p => p[0]);
      const earliest = firsts.length ? Math.min(...firsts) : now - 7 * DAY;
      const from = st.range === 0 ? Math.min(earliest, now - 7 * DAY) : now - st.range * DAY;
      pts = holdingsSeries(c.cards, Math.max(from, earliest - 0), now, 56, rate);
      if (c.cards.some(e => { const h = fullHist(e); return h.length && h[0][2]; })) note = "Where a card has little history, its earlier prices are estimated from Cardmarket's 7- and 30-day averages.";
    } else {
      pts = (c.hist || []).filter(p => !st.range || p[0] >= now - st.range * DAY);
      note = 'This one includes cards as you added them, so it rises when you add cards.';
    }
    const ch = chart(pts, { tip: '#anTip', label: 'Value over time', color: st.tab === 'cards' ? '#3EE0A5' : '#FFD36B' });
    binds.push(ch.bind);
    let change = '';
    if (pts.length >= 2) {
      const d = pts[pts.length - 1][1] - pts[0][1], p = pts[0][1] > 0 ? d / pts[0][1] * 100 : null;
      change = `<span class="${cls(d)}">${signed(d)}${p != null ? ` (${pct(p)})` : ''}</span> over ${st.range ? `${st.range === 7 ? 'the last week' : st.range === 30 ? 'the last month' : 'the last 3 months'}` : 'all the history we have'}`;
    }
    return `<section class="an-card an-hero">
      ${chips('tab', st.tab, [['cards', 'Price trend'], ['worth', 'Total worth']])}
      <div class="an-value">${usd(a.value)}</div><div class="an-change" id="anTip">${pts.length >= 2 ? change : ''}</div>
      ${ch.svg || `<p class="an-empty">The chart appears after prices refresh a few times. Tap Refresh prices now, then come back tomorrow for a line.</p>`}
      ${chips('range', st.range, [[7, '1W'], [30, '1M'], [90, '3M'], [0, 'All']])}
      ${note ? `<p class="an-note">${esc(note)}</p>` : ''}
    </section>`;
  }

  function tilesHtml(a) {
    const best = a.ranked[0];
    return `<section class="an-tiles">
      ${tile('Cards', a.cards, `${a.unique} different`)}
      ${tile('Average card', a.avg != null ? usd(a.avg) : '–', a.median != null ? `Median ${usd(a.median)}` : '')}
      ${tile('Most valuable', best ? usd(best.unit) : '–', best ? esc(best.e.name) : '')}
      ${tile('Since you added them', a.cost > 0 ? signed(a.gain) : '–', a.gainPct != null ? `${pct(a.gainPct)} on ${usd(a.cost)}` : 'No starting prices yet', cls(a.gain))}
      ${tile('Top 5 cards', a.top5Share != null ? `${Math.round(a.top5Share)}%` : '–', 'of the total value')}
      ${tile('Price coverage', `${a.priced}/${a.unique}`, a.unpriced ? `${a.unpriced} without a price` : 'All priced')}
    </section>`;
  }

  function moverRow(x) {
    const e = x.e, m = x.m, c = m.abs >= 0 ? '#3EE0A5' : '#FF8A9B';
    return `<button type="button" class="an-mover" data-an-card="${esc(e.key)}">
      ${e.imageSmall ? `<img src="${esc(e.imageSmall)}" alt="" loading="lazy">` : '<span class="an-noimg"></span>'}
      <span class="an-mv-name"><b>${esc(e.name)}${qty(e) > 1 ? ` ×${qty(e)}` : ''}</b><small>${usd(m.from)} → ${usd(m.to)}${m.estimated ? ' (est.)' : ''}</small></span>
      ${spark(fullHist(e).map(p => [p[0], p[1]]).concat([[Date.now(), m.to]]), c)}
      <span class="an-mv-num ${cls(m.abs)}">${pct(m.pct)}<small>${signed(m.abs * qty(e))}</small></span></button>`;
  }

  function moversHtml(c, now) {
    const rate = fx.rate;
    const mv = c.cards.map(e => ({ e, m: movement(e, now, st.moves, rate) })).filter(x => x.m);
    const up = mv.filter(x => x.m.abs > 0.004).sort((a, b) => b.m.abs * qty(b.e) - a.m.abs * qty(a.e)).slice(0, 5);
    const down = mv.filter(x => x.m.abs < -0.004).sort((a, b) => a.m.abs * qty(a.e) - b.m.abs * qty(b.e)).slice(0, 5);
    const label = st.moves === 7 ? 'week' : 'month';
    return `<section class="an-card"><h3>Biggest movers this ${label}</h3>${chips('moves', st.moves, [[7, '7 days'], [30, '30 days']])}
      ${mv.length ? `
        ${up.length ? `<h4 class="up">Rising</h4>${up.map(moverRow).join('')}` : ''}
        ${down.length ? `<h4 class="down">Falling</h4>${down.map(moverRow).join('')}` : ''}
        ${!up.length && !down.length ? '<p class="an-empty">Nothing has moved this ' + label + '.</p>' : ''}`
        : `<p class="an-empty">Not enough price history yet. Cards with Cardmarket prices show an estimate after the next refresh; the rest fill in over the next few days.</p>`}
    </section>`;
  }

  function topHtml(a) {
    if (!a.ranked.length) return '';
    const max = a.ranked[0].v;
    return `<section class="an-card"><h3>Most valuable cards</h3>
      ${a.ranked.slice(0, 10).map(x => bar(`${x.e.name}${qty(x.e) > 1 ? ` ×${qty(x.e)}` : ''}`, `${esc(x.e.setName || '')}${x.e.number ? ` #${esc(x.e.number)}` : ''}`, x.v / max, `${usd(x.v)} <small>${a.value ? Math.round(x.v / a.value * 100) : 0}%</small>`)).join('')}
      ${a.top5Share != null ? `<p class="an-note">Your top 5 cards are ${Math.round(a.top5Share)}% of the binder's value.</p>` : ''}</section>`;
  }

  function breakdownHtml(a) {
    const groups = { rarity: ['Rarity', a.byRarity], set: ['Set', a.bySet], type: ['Type', a.byGroup], language: ['Language', a.byLanguage], variant: ['Version', a.byVariant] };
    const [, items] = groups[st.group] || groups.rarity;
    const metric = st.metric === 'count' ? 'count' : 'value';
    const sorted = items.slice().sort((x, y) => y[metric] - x[metric]).slice(0, 10);
    const max = Math.max(...sorted.map(x => x[metric]), 1), tot = items.reduce((s, x) => s + x[metric], 0) || 1;
    const palette = ['#FF8A9B', '#FFD36B', '#3EE0A5', '#7CC4FF', '#C38CFF', '#FF9BD2', '#9EC5FF', '#7CF2D1', '#FFE08A', '#BDB6E6'];
    return `<section class="an-card"><h3>Where the value comes from</h3>
      ${chips('group', st.group, Object.entries(groups).map(([k, [l]]) => [k, l]))}${chips('metric', st.metric, [['value', 'Value'], ['count', 'Cards']])}
      ${sorted.length ? sorted.map((x, i) => bar(x.label, metric === 'value' ? `${x.count} card${x.count === 1 ? '' : 's'}` : usd(x.value), x[metric] / max,
        `${metric === 'value' ? usd(x.value) : x.count} <small>${Math.round(x[metric] / tot * 100)}%</small>`, palette[i % palette.length])).join('') : '<p class="an-empty">Nothing to show yet.</p>'}
    </section>`;
  }

  function setsHtml(a) {
    const sets = a.bySet.filter(s => s.total).sort((x, y) => y.pct - x.pct || y.owned - x.owned).slice(0, 8);
    if (!sets.length) return '';
    return `<section class="an-card"><h3>Set completion</h3><p class="an-note" style="margin-top:0">How much of each set you have (the numbered cards, one of each).</p>
      ${sets.map(s => bar(s.label, `${s.owned} of ${s.total} cards`, s.pct / 100, `${s.pct < 10 ? s.pct.toFixed(1) : Math.round(s.pct)}%`, '#7B63FF')).join('')}</section>`;
  }

  function columns(items, fmt) {
    const max = Math.max(...items.map(i => i.count), 1);
    return `<div class="an-cols">${items.map(i => `<div class="an-col"><b>${i.count}</b><i style="height:${Math.max(3, i.count / max * 84)}px"></i><small>${fmt ? fmt(i.label) : esc(i.label)}</small></div>`).join('')}</div>`;
  }

  function distHtml(a) {
    const months = a.added.slice(-8);
    return `<section class="an-card"><h3>What kind of cards you have</h3><p class="an-note" style="margin-top:0">How many cards fall in each price range.</p>${columns(a.buckets)}
      ${months.length > 1 ? `<h3 style="margin-top:22px">Cards added by month</h3>${columns(months, l => new Date(l + '-15').toLocaleDateString(undefined, { month: 'short' }))}` : ''}</section>`;
  }

  function notesHtml(c, a) {
    const oldest = c.cards.length ? Math.min(...c.cards.map(e => e.priceUpdatedAt || 0)) : null;
    const lines = [`Prices are TCGplayer market prices, last updated ${timeAgo(oldest)}.`];
    if (a.converted > 0) lines.push(`${usd(a.converted)} of the total is estimated by converting Cardmarket euro prices.`);
    if (a.unpriced) lines.push(`${a.unpriced} card${a.unpriced === 1 ? ' has' : 's have'} no price yet and ${a.unpriced === 1 ? "isn't" : "aren't"} counted.`);
    lines.push('Trends are built from the prices recorded each day you open the app, plus estimates from Cardmarket where history is short.');
    return `<section class="an-card an-small"><h3>About these numbers</h3>${lines.map(l => `<p>${esc(l)}</p>`).join('')}</section>`;
  }

  // ---------- the screen ----------
  function render() {
    const el = $('#analytics'), c = binder();
    if (!c) { close(); return; }
    const keep = el.scrollTop, now = Date.now();
    const a = binderAnalytics(c.cards, now, fx.rate);
    const idx = store.collections.indexOf(c), color = BINDER_COLORS[idx % BINDER_COLORS.length];
    const av = Celebrate.avatar(kidOf(c));
    binds = [];
    el.style.setProperty('--an-accent', color);
    el.innerHTML = `<div class="an-wrap">
      <header class="an-top">
        <button type="button" class="an-back" data-an="close"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>Back to binder</button>
        <button type="button" class="an-pill" data-an="refresh" ${app.refreshing ? 'disabled' : ''}>${app.refreshing ? 'Refreshing…' : 'Refresh prices'}</button>
      </header>
      <h1 class="an-title">${av ? `<img class="av" src="${av}" alt="">` : ''}${esc(binderTitle(c.name))} analytics</h1>
      ${heroHtml(c, a, now)}${tilesHtml(a)}${moversHtml(c, now)}${topHtml(a)}${breakdownHtml(a)}${setsHtml(a)}${distHtml(a)}${notesHtml(c, a)}
    </div>`;
    binds.forEach(b => b(el));
    el.scrollTop = keep;
  }

  function open(id) {
    st.id = id;
    store.recordHistory(); store.save();                 // make sure every card has at least a starting point
    const el = $('#analytics'); el.hidden = false; el.scrollTop = 0; render();
  }
  function close() { $('#analytics').hidden = true; }

  document.addEventListener('click', async ev => {
    const root = $('#analytics'); if (!root || root.hidden || !root.contains(ev.target)) return;
    const card = ev.target.closest('[data-an-card]');
    if (card) { const e = (binder() || { cards: [] }).cards.find(x => x.key === card.dataset.anCard); if (e) openCardDetails(e); return; }
    const b = ev.target.closest('[data-an]'); if (!b) return;
    const k = b.dataset.an, v = b.dataset.v;
    if (k === 'close') close();
    else if (k === 'refresh') { await refreshPrices(st.id); if (!$('#analytics').hidden) render(); }
    else if (k === 'tab') { st.tab = v; render(); }
    else if (k === 'range') { st.range = Number(v); render(); }
    else if (k === 'moves') { st.moves = Number(v); render(); }
    else if (k === 'group') { st.group = v; render(); }
    else if (k === 'metric') { st.metric = v; render(); }
  });
  document.addEventListener('keydown', ev => { if (ev.key === 'Escape' && !$('#analytics').hidden && $('#overlay').hidden) close(); });

  /** The price trend section of the card details sheet (light background). */
  function trendHtml(e, card) {
    const rate = fx.rate, now = Date.now(), h = fullHist(e);
    const cm = card && (card.cmTrend || card.cmAvg30) ? { trend: card.cmTrend, avg1: card.cmAvg1, avg7: card.cmAvg7, avg30: card.cmAvg30 } : e.cm;
    const unit = unitValue(e, rate);
    const pts = h.map(p => [p[0], p[1]]);
    if (unit != null && (!pts.length || now - pts[pts.length - 1][0] > 3600e3)) pts.push([now, unit]);
    const sa = sinceAdded(e, rate), m7 = movement(e, now, 7, rate), m30 = movement(e, now, 30, rate);
    const cell = (label, m, est) => `<div><small>${label}</small>${m ? `<b class="${cls(m.abs)}">${pct(m.pct)}</b><span>${signed(m.abs)}${est || m.estimated ? ' est.' : ''}</span>` : '<b>–</b><span>not enough history</span>'}</div>`;
    const ch = chart(pts, { w: 320, h: 130, color: '#5B3FFF', label: 'Price of this card over time', tip: '#anCardTip' });
    detailBinds.push(ch.bind);
    const cmRows = cm ? [['30-day average', cm.avg30], ['7-day average', cm.avg7], ['1-day average', cm.avg1], ['Trend now', cm.trend]].filter(r => r[1] > 0) : [];
    const cmMax = Math.max(...cmRows.map(r => r[1]), 1);
    return `<h3>Price trend</h3>
      <div class="an-card-stats">${cell('Since added', sa ? { abs: sa.abs, pct: sa.pct } : null)}${cell('7 days', m7)}${cell('30 days', m30)}</div>
      ${ch.svg ? `<div class="an-tip-l" id="anCardTip">${pts.length ? `${usd(pts[pts.length - 1][1])} now` : ''}</div>${ch.svg}` : '<p class="small muted">The line appears once this card has been through a couple of price refreshes (about once a day you open the app).</p>'}
      ${cmRows.length ? `<h4 class="an-h4">Cardmarket averages (Europe)</h4>${cmRows.map(([l, v]) => `<div class="an-mini"><span>${l}</span><i style="width:${(v / cmMax * 100).toFixed(0)}%"></i><b>${eur(v)}</b></div>`).join('')}
        <p class="small muted" style="margin:6px 0 0">Short-term averages from Cardmarket. Where this card has little history of its own, the 7- and 30-day moves above are estimated from them.</p>` : ''}`;
  }
  let detailBinds = [];
  const bindDetails = root => { detailBinds.forEach(b => b(root)); detailBinds = []; };

  return { open, close, render, trendHtml, bindDetails };
})();
