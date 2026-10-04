'use strict';
/*
 * Binders: a real binder to flip through, and a card you can bring out of its pocket.
 * app.js hands this file the cards and a few callbacks; everything about how it looks and moves lives here.
 */
const BinderUI = (() => {
  const $ = (s, r = document) => r.querySelector(s);
  const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const easeOutCubic = t => 1 - Math.pow(1 - t, 3);
  const easeInCubic = t => t * t * t;
  const easeInOutCubic = t => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  const easeOutBack = t => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); };
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const hash = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
  const mulberry = a => () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };

  /* ---------- rarity tiers: how much magic a card gets ---------- */
  const TIER = {
    common:   { label: 'Common', glow: '#9EC5FF', n: 30, rays: 0, spin: 0, bg: '#3A4170', fg: '#fff', pal: ['#BFD9FF', '#FFFFFF', '#9EC5FF'] },
    uncommon: { label: 'Uncommon', glow: '#7CF2D1', n: 46, rays: 0, spin: 0, bg: '#0E7A64', fg: '#fff', pal: ['#9CFFE2', '#FFFFFF', '#7CF2D1'] },
    rare:     { label: 'Rare', glow: '#FFD36B', n: 70, rays: .3, spin: 1, bg: '#FFD36B', fg: '#2B1A00', pal: ['#FFE08A', '#FFFFFF', '#FFD36B'] },
    double:   { label: 'Double rare', glow: '#FF9BD2', n: 92, rays: .42, spin: 1, bg: '#A3257A', fg: '#fff', pal: ['#FFB6DE', '#FFE08A', '#FFFFFF'] },
    sir:      { label: 'Special rare', glow: '#B79BFF', n: 130, rays: .5, spin: 2, bg: '#C21F57', fg: '#fff', pal: ['#ff7ab6', '#ffd36b', '#7dffc0', '#7cc4ff', '#c38cff', '#ffffff'] },
  };
  /** Uses rarityRank() from logic.js: promo/rare -> rare, double rare and ultra -> double, illustration and above -> sir. */
  function tierOf(rarity) {
    const r = rarityRank(rarity);
    return r >= 8 ? 'sir' : r >= 6 ? 'double' : r >= 3 ? 'rare' : r === 2 ? 'uncommon' : 'common';
  }
  const badgeStyle = rarity => { const t = TIER[tierOf(rarity)]; return `--bg-b:${t.bg};--fg-b:${t.fg}`; };

  /* ---------- sigils and runes (drawn, so they look the same everywhere) ---------- */
  function glyph(rng, s) {
    let d = `M0 ${-s} L0 ${s}`;
    const n = 1 + Math.floor(rng() * 3);
    for (let i = 0; i < n; i++) {
      const y = (rng() * 1.4 - .7) * s, dir = rng() < .5 ? -1 : 1, len = s * (.45 + rng() * .35);
      d += ` M0 ${y.toFixed(1)} L${(dir * len).toFixed(1)} ${(y + (rng() - .5) * 1.3 * s).toFixed(1)}`;
    }
    return d;
  }
  function runeRing(n, r, s, seed) {
    const rng = mulberry(seed); let out = '';
    for (let i = 0; i < n; i++) out += `<g transform="rotate(${(i * 360 / n).toFixed(2)}) translate(0 ${-r})"><path d="${glyph(rng, s)}"/></g>`;
    return out;
  }
  const poly = (R, off) => [0, 1, 2].map(i => { const a = (off + i * 120) * Math.PI / 180; return `${(Math.cos(a) * R).toFixed(1)},${(Math.sin(a) * R).toFixed(1)}`; }).join(' ');
  function sigilSVG(runes) {
    return `<svg class="bk-sigil" viewBox="-200 -200 400 400" aria-hidden="true">
      <g class="r1"><circle r="190"/><circle r="164"/>${runeRing(28, 177, 9, 11)}</g>
      <g class="r2"><circle r="150" stroke-dasharray="2 9"/><circle r="118"/>${runeRing(runes, 134, 8, 29)}</g>
      <polygon class="star" points="${poly(112, -90)}"/><polygon class="star" points="${poly(112, 90)}"/>
      <circle r="48"/><circle r="6"/></svg>`;
  }
  function backSVG() {
    return `<svg viewBox="0 0 100 140" aria-hidden="true"><g fill="none" stroke="#F2C14D" stroke-width=".8" stroke-linecap="round" stroke-linejoin="round" opacity=".95">
      <rect x="5" y="5" width="90" height="130" rx="5"/><rect x="9" y="9" width="82" height="122" rx="3.5" opacity=".5"/>
      <circle cx="50" cy="70" r="31"/><circle cx="50" cy="70" r="23" opacity=".6"/>
      <g transform="translate(50 70)"><polygon points="${poly(27, -90)}"/><polygon points="${poly(27, 90)}"/></g>
      <circle cx="50" cy="70" r="3" fill="#F2C14D"/></g>
      <g fill="#fff" opacity=".75"><circle cx="22" cy="24" r=".9"/><circle cx="78" cy="30" r=".7"/><circle cx="18" cy="112" r=".8"/><circle cx="82" cy="116" r=".9"/><circle cx="50" cy="20" r=".7"/><circle cx="50" cy="122" r=".7"/></g></svg>`;
  }
  function emblemSVG() {
    return `<svg class="bk-emblem" viewBox="-60 -60 120 120" aria-hidden="true"><g fill="none" stroke="#FFE08A" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
      <circle r="56"/><circle r="48" stroke-dasharray="1.5 5"/><circle r="30"/>
      <polygon points="${poly(34, -90)}"/><polygon points="${poly(34, 90)}"/><circle r="5" fill="#FFE08A"/></g></svg>`;
  }

  /* ---------- a card ---------- */
  function cardHTML(e, flat) {
    const tier = tierOf(e.rarity);
    const src = flat ? (e.imageSmall || e.imageLarge) : (e.imageLarge || e.imageSmall);
    const img = src ? `<img src="${esc(src)}" alt="" draggable="false" decoding="async">` : `<div class="bk-noimg">${esc(e.name)}</div>`;
    const front = `<div class="bk-face bk-front">${img}<div class="bk-holo"></div><div class="bk-glare"></div></div>`;
    if (flat) return `<div class="bk-card bk-flat bk-t-${tier}" style="--d:-${(hash(e.key) % 70) / 10}s">${front}</div>`;
    return `<div class="bk-card bk-t-${tier}">${front}<div class="bk-face bk-cback">${backSVG()}<img class="bk-backimg" src="card-back.webp" alt="" draggable="false" decoding="async" onerror="this.style.display='none'"></div><i class="bk-edge l"></i><i class="bk-edge r"></i><i class="bk-edge t"></i><i class="bk-edge b"></i></div>`;
  }
  function pocketHTML(e, o) {
    const tier = tierOf(e.rarity), tag = o.priceTag(e);
    return `<div class="bk-pocket" data-key="${esc(e.key)}" tabindex="0" role="button" aria-label="${esc(e.name)}${e.rarity ? ', ' + esc(e.rarity) : ''}, ${esc(tag)}">
      <div class="bk-cw">${cardHTML(e, true)}</div>${e.quantity > 1 ? `<span class="bk-qty">×${e.quantity}</span>` : ''}
      <i class="bk-gem bk-g-${tier}"></i><span class="bk-tag${tag === 'No price' ? ' bk-none' : ''}">${esc(tag)}</span></div>`;
  }

  /* ---------- the binder ---------- */
  let B = null;            // the book on screen
  let handlers = null;     // how to read and change a card, supplied by app.js

  const CHEV_L = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>';
  const CHEV_R = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg>';

  /**
   * o: { name, coverInfo, entries, page, opened, fade, emptyMessage, priceTag(e), onPage(n), onOpened(),
   *      summon: { getEntry(key), sheetHTML(e), onAction(act, e) } }
   */
  function render(root, o) {
    if (B) B.dead = true;
    handlers = o.summon;
    const pages = [];
    for (let i = 0; i < o.entries.length; i += 9) pages.push(o.entries.slice(i, i + 9));
    if (!pages.length) pages.push([]);
    const b = B = { root, o, pages, leaves: [], cur: o.opened ? clamp(o.page || 1, 1, pages.length) : 0, busy: false, turn: null, drag: null, touched: !!o.opened, dead: false };

    root.innerHTML = `<div class="bk-bookwrap"><div class="bk-tshadow" aria-hidden="true"></div>
      <div class="bk-book${o.fade ? ' bk-fade' : ''}"><div class="bk-leather bk-backcover" aria-hidden="true"></div><div class="bk-leaves"></div>
      <div class="bk-rings" aria-hidden="true"><i class="bk-ring"></i><i class="bk-ring"></i><i class="bk-ring"></i></div></div></div>
      <nav class="bk-pager" aria-label="Turn pages"><button class="bk-nav" type="button" data-bk="prev" aria-label="Previous page">${CHEV_L}</button>
        <div class="bk-dots" aria-hidden="true"></div><button class="bk-nav" type="button" data-bk="next" aria-label="Next page">${CHEV_R}</button></nav>
      ${o.opened ? '' : '<p class="bk-hint">Swipe the page to turn it. Tap a card to bring it out.</p>'}`;
    const book = $('.bk-book', root), host = $('.bk-leaves', root);

    const cover = document.createElement('div');
    cover.className = 'bk-leaf bk-cover';
    cover.innerHTML = `<div class="bk-leather"></div><div class="bk-stitch"></div>
      <div class="bk-cover-in">${emblemSVG()}<h2>${esc(o.name)}</h2><div class="bk-kind">Card binder</div><div class="bk-count">${esc(o.coverInfo)}</div></div>
      <div class="bk-open-hint">Tap to open</div><div class="bk-shade"></div><div class="bk-cast"></div>`;
    b.leaves.push(cover);
    pages.forEach((cards, pi) => {
      const L = document.createElement('div');
      L.className = 'bk-leaf';
      let pk = ''; for (let i = 0; i < 9; i++) pk += cards[i] ? pocketHTML(cards[i], o) : '<div class="bk-pocket bk-empty"></div>';
      const empty = !o.entries.length ? `<div class="bk-empty-msg">${o.emptyMessage || ''}</div>` : '';
      L.innerHTML = `<div class="bk-page"><div class="bk-holes"><i></i><i></i><i></i></div><div class="bk-grid">${pk}</div>${empty}<div class="bk-pno">Page ${pi + 1} of ${pages.length}</div></div><div class="bk-shade"></div><div class="bk-cast"></div>`;
      b.leaves.push(L);
    });
    b.leaves.forEach(L => host.appendChild(L));
    $('.bk-dots', root).innerHTML = pages.map(() => '<i></i>').join('');
    layout(b);

    book.addEventListener('pointerdown', e => {
      if (b.dead || b.busy || e.button > 0) return;
      b.drag = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false, target: e.target, lx: e.clientX, lt: performance.now(), vx: 0, dir: 0 };
    });
    book.addEventListener('pointermove', e => {
      const d = b.drag; if (!d || e.pointerId !== d.id) return;
      const dx = e.clientX - d.x, dy = e.clientY - d.y, now = performance.now();
      d.vx = (e.clientX - d.lx) / Math.max(1, now - d.lt); d.lx = e.clientX; d.lt = now;
      if (!d.moved) {
        if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy) * 1.2) {
          d.moved = true; d.dir = dx < 0 ? 1 : -1; startTurn(b, d.dir); touched(b);
          try { book.setPointerCapture(e.pointerId); } catch (_) { /* fine */ }
        } else return;
      }
      if (b.turn) { b.turn.p = clamp((d.dir === 1 ? -dx : dx) / (book.clientWidth * .8)); applyTurn(b, b.turn); }
    });
    const endDrag = e => {
      const d = b.drag; if (!d || (e && e.pointerId !== d.id)) return;
      b.drag = null;
      if (d.moved) {
        if (!b.turn) return;
        const flick = Math.abs(d.vx) > .5 && ((d.vx < 0 && b.turn.dir === 1) || (d.vx > 0 && b.turn.dir === -1));
        finishTurn(b, b.turn.p > .35 || flick);
      } else if (b.cur === 0 && d.target.closest('.bk-cover')) { go(b, 1); }
      else {
        const pk = d.target.closest('.bk-pocket:not(.bk-empty)');
        if (pk && !b.turn && !b.busy) openSummon(pk.dataset.key, pk);
      }
    };
    book.addEventListener('pointerup', endDrag);
    book.addEventListener('pointercancel', endDrag);
    book.addEventListener('keydown', e => {
      if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('bk-pocket') && !e.target.classList.contains('bk-empty')) { e.preventDefault(); openSummon(e.target.dataset.key, e.target); }
    });
    $('[data-bk="prev"]', root).addEventListener('click', () => go(b, -1));
    $('[data-bk="next"]', root).addEventListener('click', () => go(b, 1));

    if (!o.opened) setTimeout(() => { if (!b.dead && !b.touched && b.cur === 0 && !b.busy && !H) go(b, 1); }, 850);
  }

  function touched(b) { b.touched = true; const h = $('.bk-hint', b.root); if (h) h.style.opacity = 0; }
  function commit(b) { b.o.onPage && b.o.onPage(b.cur); if (b.cur > 0 && b.o.onOpened) b.o.onOpened(); }

  function layout(b) {
    b.leaves.forEach((L, i) => {
      L.style.transition = 'none';
      L.style.setProperty('--shade', 0); L.style.setProperty('--cast', 0);
      if (i < b.cur) { L.style.transform = 'rotateY(-105deg)'; L.style.visibility = 'hidden'; L.style.zIndex = i; }
      else if (i === b.cur) { L.style.transform = 'rotateY(0deg)'; L.style.visibility = 'visible'; L.style.zIndex = 60; }
      else if (i === b.cur + 1) { L.style.transform = 'rotateY(0deg)'; L.style.visibility = 'visible'; L.style.zIndex = 40; }
      else { L.style.transform = 'rotateY(0deg)'; L.style.visibility = 'hidden'; L.style.zIndex = 1; }
    });
    const prev = $('[data-bk="prev"]', b.root), next = $('[data-bk="next"]', b.root);
    if (prev) prev.disabled = b.cur === 0;
    if (next) next.disabled = b.cur >= b.leaves.length - 1;
    [...$('.bk-dots', b.root).children].forEach((d, i) => d.classList.toggle('bk-on', i === b.cur - 1));
  }

  function tween(dur, fn) {
    return new Promise(res => { const s = performance.now(); (function step(now) { const k = clamp((now - s) / dur); fn(k); if (k < 1) requestAnimationFrame(step); else res(); })(s); });
  }
  function startTurn(b, dir) {
    b.turn = null;
    if (dir === 1) {
      const L = b.leaves[b.cur];
      if (b.cur >= b.leaves.length - 1) { b.turn = { dir, rubber: true, leaf: L, p: 0 }; return; }
      L.style.zIndex = 70; b.turn = { dir, leaf: L, under: b.leaves[b.cur + 1], p: 0 };
    } else if (b.cur > 0) {
      const L = b.leaves[b.cur - 1];
      L.style.visibility = 'visible'; L.style.zIndex = 70; b.turn = { dir, leaf: L, under: b.leaves[b.cur], p: 0 };
    }
  }
  function applyTurn(b, t) {
    if (t.rubber) { t.leaf.style.transform = `rotateY(${-7 * t.p}deg)`; return; }
    const a = t.dir === 1 ? -105 * t.p : -105 * (1 - t.p);
    const q = t.dir === 1 ? t.p : 1 - t.p;                  // how far the page has turned away
    t.leaf.style.transform = `rotateY(${a.toFixed(2)}deg)`;
    t.leaf.style.setProperty('--shade', (clamp(Math.abs(a) / 90) * .7).toFixed(3));
    if (t.under) t.under.style.setProperty('--cast', (Math.sin(Math.PI * clamp(q)) * .6).toFixed(3));
  }
  async function finishTurn(b, commitIt) {
    const t = b.turn; if (!t) return;
    b.busy = true; touched(b);
    const from = t.p, to = commitIt ? 1 : 0;
    await tween(reduce ? 1 : Math.max(200, 520 * Math.abs(to - from) + 150), k => { if (b.dead) return; t.p = lerp(from, to, easeOutCubic(k)); applyTurn(b, t); });
    if (b.dead) return;
    if (commitIt && !t.rubber) b.cur += t.dir;
    b.turn = null; layout(b); b.busy = false; commit(b);
  }
  function go(b, dir) {
    if (b.dead || b.busy || b.turn) return;
    const n = b.cur + dir; if (n < 0 || n >= b.leaves.length) return;
    startTurn(b, dir); if (b.turn) finishTurn(b, true);
  }

  /* ---------- the summon: the card leaves its pocket ---------- */
  let H = null, raf = 0;
  const sprites = {};
  function sprite(color, kind) {
    const key = color + kind; if (sprites[key]) return sprites[key];
    const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d');
    if (kind === 'glow') {
      const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32); gr.addColorStop(0, '#fff'); gr.addColorStop(.25, color); gr.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
    } else {
      g.translate(32, 32); g.fillStyle = color; g.shadowColor = color; g.shadowBlur = 8;
      g.beginPath(); for (let i = 0; i < 8; i++) { const a = i * Math.PI / 4, r = i % 2 ? 4 : 26; g.lineTo(Math.cos(a) * r, Math.sin(a) * r); } g.closePath(); g.fill();
    }
    return (sprites[key] = c);
  }
  const place = (el, x, y, w, h) => { el.style.left = x + 'px'; el.style.top = y + 'px'; if (w) { el.style.width = w + 'px'; el.style.height = (h || w) + 'px'; } };
  function sizeCanvases() {
    const dpr = Math.min(2, devicePixelRatio || 1);
    [['#bkSpB'], ['#bkSpF']].forEach(([id]) => { const cv = $(id), g = cv.getContext('2d'); cv.width = innerWidth * dpr; cv.height = innerHeight * dpr; cv.style.width = innerWidth + 'px'; cv.style.height = innerHeight + 'px'; g.setTransform(dpr, 0, 0, dpr, 0, 0); });
  }

  function openSummon(key, pocket) {
    if (H || !handlers) return;
    const e = handlers.getEntry(key); if (!e) return;
    touched(B);
    const tier = tierOf(e.rarity), T = TIER[tier], S = $('#bkSummon'), sheet = $('#bkSheet');
    const cw = pocket.querySelector('.bk-cw'), rect = cw.getBoundingClientRect();
    const vw = innerWidth, vh = innerHeight;
    sheet.innerHTML = handlers.sheetHTML(e);
    S.classList.add('bk-on'); S.dataset.tier = tier; S.style.setProperty('--glow', T.glow); S.style.setProperty('--rays', T.rays);
    const sheetH = sheet.offsetHeight || 280;
    const Wt = Math.max(150, Math.min(vw * .72, 300, (vh - sheetH - 90) * 63 / 88)), Ht = Wt * 88 / 63;
    const cx = vw / 2, cy = Math.max(Ht / 2 + 64, (vh - sheetH) / 2 + 6);
    const ox = rect.left + rect.width / 2, oy = rect.top + rect.height / 2, os = rect.width / Wt;

    const tmp = document.createElement('div');
    tmp.innerHTML = cardHTML(e, false);
    const el = tmp.firstElementChild; el.classList.add('bk-hero'); el.style.width = Wt + 'px'; el.style.height = Ht + 'px';
    el.style.transform = `translate3d(${ox - Wt / 2}px,${oy - Ht / 2}px,0) scale(${os})`;
    S.appendChild(el);

    const sg = Math.min(vw * 1.15, 520);
    $('#bkSigilHost').innerHTML = sigilSVG(Math.round(10 + T.n / 12));
    place($('#bkSigilHost .bk-sigil'), cx - sg / 2, cy - sg / 2, sg);
    place($('#bkRays'), cx, cy); place($('#bkAura'), cx - Wt * 1.15, cy - Wt * 1.15, Wt * 2.3);
    place($('#bkBurst1'), ox, oy); place($('#bkBurst2'), ox, oy);
    sizeCanvases();

    pocket.classList.add('bk-vacant');
    H = { key, tier, T, pocket, el, ox, oy, os, cx, cy, Wt, Ht, t0: performance.now(), last: performance.now(), mode: 'open',
          rx: 0, ry: 0, fl: 0, flip: false, ptr: null, hover: null, P: [], motes: [], emit: 0, burst: false, trail: 0, snap: null, pose: null,
          spins: reduce ? 0 : T.spin, rate: reduce ? 0 : 10 + T.n * .35, dissolve: false };
    const nm = reduce ? 0 : Math.round(T.n * .22);
    for (let i = 0; i < nm; i++) H.motes.push({ a: Math.random() * 6.283, R: Wt * (.62 + Math.random() * .38), sp: (Math.random() < .5 ? -1 : 1) * (.45 + Math.random() * .9), s: 5 + Math.random() * 9, col: T.pal[i % T.pal.length], kind: Math.random() < .35 ? 'star' : 'glow', ph: Math.random() * 6 });
    S.setAttribute('aria-hidden', 'false');
    requestAnimationFrame(() => S.classList.add('bk-open'));
    setTimeout(() => { if (H && H.mode !== 'close') S.classList.add('bk-sheet-in'); }, reduce ? 50 : 900);
    cancelAnimationFrame(raf); raf = requestAnimationFrame(frame);
  }

  function openPose(t) {
    const { ox, oy, os, cx, cy } = H, A = reduce ? .01 : .24, Bt = A + (reduce ? .35 : .95);
    if (t < A) { const k = easeOutCubic(t / A); return { x: ox, y: oy - 12 * k, s: os * (1 + .16 * k), z: 30 * k, rx: 0, ry: 0, rz: 0, done: false }; }
    const k = clamp((t - A) / (Bt - A)), e = easeInOutCubic(k), sw = Math.sin(k * Math.PI), dirx = ox < cx ? -1 : 1;
    return { x: lerp(ox, cx, e) + sw * dirx * 26, y: lerp(oy - 12, cy, e) - sw * 40, s: lerp(os * 1.16, 1, easeOutBack(k)), z: lerp(30, 0, e) + sw * 90,
      rx: H.spins ? 0 : sw * 12, ry: -360 * H.spins * (1 - easeOutCubic(k)), rz: sw * dirx * 7, done: k >= 1 };
  }

  function frame(now) {
    if (!H) return;
    const dt = Math.min(.05, (now - H.last) / 1000); H.last = now;
    const t = (now - H.t0) / 1000, { Wt, Ht, cx, cy } = H;
    let p;
    if (H.mode === 'open') {
      p = openPose(t);
      if (p.done) H.mode = 'idle';
      H.rx = p.rx; H.ry = p.ry;
    }
    if (H.mode === 'idle') {
      let tx, ty;
      if (H.ptr) { tx = -clamp((H.ptr.y - cy) / (Ht / 2), -1.2, 1.2) * 26; ty = clamp((H.ptr.x - cx) / (Wt / 2), -1.2, 1.2) * 30; }
      else if (H.hover) { tx = -clamp((H.hover.y - cy) / (Ht / 2), -1, 1) * 14; ty = clamp((H.hover.x - cx) / (Wt / 2), -1, 1) * 16; }
      else { tx = reduce ? 0 : Math.cos(t * .7) * 5; ty = reduce ? 0 : Math.sin(t * .9) * 7; }
      const k = 1 - Math.exp(-dt * 9);
      H.rx += (tx - H.rx) * k; H.ry += (ty - H.ry) * k;
      H.fl += ((H.flip ? 180 : 0) - H.fl) * (1 - Math.exp(-dt * 8));
      p = { x: cx, y: cy + (reduce ? 0 : Math.sin(t * 1.25) * 6), s: 1, z: 0, rx: H.rx, ry: H.ry, rz: 0 };
    }
    let opacity = 1;
    if (H.mode === 'close') {
      const k = clamp((now - H.tc) / (reduce ? 80 : 560)), e = easeInCubic(k), s0 = H.snap;
      if (H.dissolve) { p = { x: s0.x, y: s0.y, s: lerp(s0.s, s0.s * .6, e), z: 0, rx: s0.rx, ry: s0.ry, rz: 0 }; opacity = 1 - e; }
      else p = { x: lerp(s0.x, H.ox, e), y: lerp(s0.y, H.oy, e), s: lerp(s0.s, H.os, e), z: lerp(s0.z, 0, e), rx: lerp(s0.rx, 0, e), ry: lerp(s0.ry, 0, e), rz: 0 };
      if (k >= 1) { finishClose(); return; }
    }
    H.pose = p;
    const total = p.ry + (H.mode === 'close' ? 0 : H.fl);
    H.el.style.transform = `translate3d(${(p.x - Wt / 2).toFixed(1)}px,${(p.y - Ht / 2).toFixed(1)}px,${p.z.toFixed(1)}px) scale(${p.s.toFixed(4)}) rotateX(${p.rx.toFixed(2)}deg) rotateY(${total.toFixed(2)}deg) rotateZ(${p.rz.toFixed(2)}deg)`;
    H.el.style.opacity = opacity;
    const ry = ((p.ry % 360) + 360) % 360, tiltY = ry > 180 ? ry - 360 : ry;
    H.el.style.setProperty('--hx', (50 + tiltY * 1.5).toFixed(1) + '%'); H.el.style.setProperty('--hy', (50 - p.rx * 1.5).toFixed(1) + '%');
    H.el.style.setProperty('--gx', (50 + tiltY * 1.6).toFixed(1) + '%'); H.el.style.setProperty('--gy', (35 - p.rx * 1.6).toFixed(1) + '%');
    H.el.style.setProperty('--ga', (.35 + clamp(Math.hypot(tiltY, p.rx) / 40) * .45).toFixed(2));
    const sh = $('#bkGshadow'), lift = clamp((cy - p.y + 6) / 12 * .5 + .5);
    place(sh, p.x - Wt * .45 - tiltY * .5, cy + Ht / 2 + 26, Wt * .9, 30);
    sh.style.opacity = (H.mode === 'close' ? 0 : clamp((t - .55) / .5) * (.34 + .26 * lift)).toFixed(2);
    sh.style.transform = `scaleX(${(1 - .08 * (1 - lift)).toFixed(3)})`;
    if (!reduce) particles(dt, p, t);
    raf = requestAnimationFrame(frame);
  }

  function particles(dt, p, t) {
    const T = H.T, P = H.P, { Wt, Ht, cx, cy } = H;
    const gB = $('#bkSpB').getContext('2d'), gF = $('#bkSpF').getContext('2d');
    const mk = (x, y, vx, vy, life, size, ay, layer) => {
      const col = T.pal[(Math.random() * T.pal.length) | 0];
      P.push({ x, y, vx, vy, life, age: 0, size, ay, layer, spr: sprite(col, Math.random() < .3 ? 'star' : 'glow'), drag: 1.4 });
    };
    if (!H.burst && t > .02) {
      H.burst = true;
      for (let i = 0; i < T.n * .9; i++) { const a = Math.random() * 6.283, sp = 120 + Math.random() * 380; mk(H.ox, H.oy, Math.cos(a) * sp, Math.sin(a) * sp, .7 + Math.random() * .9, 10 + Math.random() * 18, 0, Math.random() < .3 ? 1 : 0); }
    }
    if (H.mode === 'open' && t > .24 && P.length < 260) {            // a trail behind the flying card
      H.trail += dt * (60 + T.n); while (H.trail >= 1) { H.trail--; mk(p.x + (Math.random() - .5) * Wt * p.s, p.y + (Math.random() - .5) * Ht * p.s, (Math.random() - .5) * 60, 30 + Math.random() * 60, .5 + Math.random() * .7, 6 + Math.random() * 12, 40, 0); }
    }
    if (H.mode === 'idle' && P.length < 240) {                       // embers rising from the card
      H.emit += dt * H.rate; while (H.emit >= 1) { H.emit--; mk(cx + (Math.random() - .5) * Wt * .95, cy + Ht * (.1 + Math.random() * .42), (Math.random() - .5) * 24, -(30 + Math.random() * 70), 1.5 + Math.random() * 1.4, 5 + Math.random() * 10, -8, Math.random() < .25 ? 1 : 0); }
    }
    gB.clearRect(0, 0, innerWidth, innerHeight); gF.clearRect(0, 0, innerWidth, innerHeight);
    gB.globalCompositeOperation = gF.globalCompositeOperation = 'lighter';
    for (let i = P.length - 1; i >= 0; i--) {
      const q = P[i]; q.age += dt; if (q.age >= q.life) { P.splice(i, 1); continue; }
      q.vx *= 1 - q.drag * dt; q.vy *= 1 - q.drag * dt; q.vy += q.ay * dt; q.x += q.vx * dt; q.y += q.vy * dt;
      const g = q.layer ? gF : gB;
      g.globalAlpha = clamp(Math.sin(Math.PI * q.age / q.life)) * .9; g.drawImage(q.spr, q.x - q.size / 2, q.y - q.size / 2, q.size, q.size);
    }
    if (H.mode !== 'close') for (const m of H.motes) {               // motes circling the card like a small orbit
      m.a += m.sp * dt; const ex = Math.cos(m.a) * m.R, ey = Math.sin(m.a) * m.R * .36, th = -.2;
      const x = cx + ex * Math.cos(th) - ey * Math.sin(th), y = cy + ex * Math.sin(th) + ey * Math.cos(th);
      const g = ey > 0 ? gF : gB, s = m.s * (.85 + .4 * Math.sin(m.a)) * (.8 + .3 * Math.sin(t * 3 + m.ph));
      g.globalAlpha = (H.mode === 'open' ? clamp((t - .6) / .6) : 1) * .85;
      g.drawImage(sprite(m.col, m.kind), x - s / 2, y - s / 2, s, s);
    }
    gB.globalAlpha = gF.globalAlpha = 1;
  }

  /** Puts the card back. opts.dissolve fades it away instead (used when the card was removed). */
  function closeSummon(opts) {
    if (!H || H.mode === 'close') return;
    const pk = document.querySelector(`.bk-pocket[data-key="${CSS.escape(H.key)}"]`), cw = pk && pk.querySelector('.bk-cw');
    if (cw && !(opts && opts.dissolve)) {
      const r = cw.getBoundingClientRect();
      H.ox = r.left + r.width / 2; H.oy = r.top + r.height / 2; H.os = r.width / H.Wt; H.pocket = pk; pk.classList.add('bk-vacant');
    } else { H.dissolve = true; H.pocket = null; }
    H.snap = Object.assign({}, H.pose, { ry: (((H.pose.ry + H.fl) % 360) + 540) % 360 - 180 });
    H.fl = 0; H.mode = 'close'; H.tc = performance.now();
    const S = $('#bkSummon'); S.classList.remove('bk-sheet-in', 'bk-open');
  }
  function finishClose() {
    const h = H; H = null; cancelAnimationFrame(raf);
    h.el.remove();
    if (h.pocket) { h.pocket.classList.remove('bk-vacant'); h.pocket.classList.add('bk-landed'); setTimeout(() => h.pocket.classList.remove('bk-landed'), 800); }
    const S = $('#bkSummon'); S.classList.remove('bk-on', 'bk-open', 'bk-sheet-in'); S.setAttribute('aria-hidden', 'true');
    ['#bkSpB', '#bkSpF'].forEach(id => $(id).getContext('2d').clearRect(0, 0, innerWidth, innerHeight));
    $('#bkSigilHost').innerHTML = ''; $('#bkGshadow').style.opacity = 0;
  }
  /** Redraws the info sheet after the card changed (a new count, a price). Closes the summon if the card is gone. */
  function refreshSheet() {
    if (!H || !handlers) return;
    const e = handlers.getEntry(H.key);
    if (!e) closeSummon({ dissolve: true });
    else $('#bkSheet').innerHTML = handlers.sheetHTML(e);
  }

  function wireSummon() {
    const S = $('#bkSummon'); if (!S || S.dataset.wired) return; S.dataset.wired = '1';
    S.addEventListener('pointerdown', e => {
      if (!H || H.mode !== 'idle' || e.target.closest('.bk-sheet,.bk-x')) return;
      H.ptr = { id: e.pointerId, x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, moved: false };
    });
    S.addEventListener('pointermove', e => {
      if (!H) return;
      if (H.ptr && e.pointerId === H.ptr.id) { H.ptr.x = e.clientX; H.ptr.y = e.clientY; if (Math.hypot(e.clientX - H.ptr.sx, e.clientY - H.ptr.sy) > 8) H.ptr.moved = true; }
      else if (e.pointerType === 'mouse' && !H.ptr && !e.target.closest('.bk-sheet')) H.hover = { x: e.clientX, y: e.clientY };
    });
    S.addEventListener('pointerleave', () => { if (H) H.hover = null; });
    const up = e => {
      if (!H || !H.ptr || e.pointerId !== H.ptr.id) return;
      const pt = H.ptr; H.ptr = null;
      if (!pt.moved && H.mode === 'idle') {
        const inside = Math.abs(e.clientX - H.cx) < H.Wt / 2 && Math.abs(e.clientY - H.cy) < H.Ht / 2;
        if (inside) H.flip = !H.flip; else closeSummon();
      }
    };
    S.addEventListener('pointerup', up); S.addEventListener('pointercancel', up);
    $('#bkSheet').addEventListener('click', e => {
      const b = e.target.closest('[data-bk]'); if (!b || !H) return;
      const act = b.dataset.bk;
      if (act === 'flip') H.flip = !H.flip;
      else if (act === 'close') closeSummon();
      else if (handlers) { const en = handlers.getEntry(H.key); if (en) handlers.onAction(act, en); }
    });
    $('#bkX').addEventListener('click', () => closeSummon());
    addEventListener('resize', () => { if (H) sizeCanvases(); });
    document.addEventListener('keydown', e => {
      if (H) { if (e.key === 'Escape') closeSummon(); return; }
      if (!B || B.dead || !$('#binders-view') || $('#binders-view').hidden) return;
      if (e.key === 'ArrowRight') go(B, 1); if (e.key === 'ArrowLeft') go(B, -1);
    });
  }
  wireSummon();

  return { render, tierOf, badgeStyle, tierLabel: r => TIER[tierOf(r)].label,
           summon: { close: closeSummon, refresh: refreshSheet, isOpen: () => !!H, key: () => H && H.key } };
})();
