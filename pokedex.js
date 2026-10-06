'use strict';
/*
 * A binder's Pokédex: all 1025 Pokémon by generation. The ones in the binder show their own card; the rest are dark
 * tiles with the number and name, so you know what to look for. A finished generation gets a star.
 * Which Pokémon a card is comes from makeDex (logic.js).
 */
const Pokedex = (() => {
  const st = { id: null, filter: 'all' };
  const pad = n => String(n).padStart(4, '0').replace(/^0(?=\d{3})/, '');      // 25 -> "025", 1025 -> "1025"
  const binder = () => store.collections.find(c => c.id === st.id);
  const title = name => (/binder$/i.test(name) ? `${name} Pokédex` : `${name}'s Pokédex`);

  /** The card that stands for a Pokémon: one with a picture, the most valuable first. */
  function face(cards) {
    return [...cards].sort((a, b) => (!!b.imageSmall - !!a.imageSmall) || ((usdOf(b) || 0) - (usdOf(a) || 0)))[0];
  }

  function tile(dex, n, cards) {
    const name = esc(dex.name(n));
    if (!cards) {
      return `<div class="dx-tile miss" aria-label="#${pad(n)} ${name}, not caught yet"><span class="dx-q">?</span>
        <span class="dx-num">#${pad(n)}</span><span class="dx-name">${name}</span></div>`;
    }
    const f = face(cards), more = cards.length > 1 ? `<span class="dx-more">×${cards.reduce((s, e) => s + e.quantity, 0)}</span>` : '';
    const pic = f.imageSmall ? `<img src="${esc(f.imageSmall)}" alt="" loading="lazy" decoding="async">` : `<span class="dx-noimg">${esc(f.name)}</span>`;
    return `<button type="button" class="dx-tile own" data-dx="tile" data-n="${n}" aria-label="#${pad(n)} ${name}, caught">
      ${pic}${more}<span class="dx-num">#${pad(n)}</span><span class="dx-name">${name}</span></button>`;
  }

  function render() {
    const el = $('#pokedex'), c = binder();
    if (!c) { close(); return; }
    const dex = species.dex;
    if (!dex) {
      el.innerHTML = '<div class="an-wrap"><p style="margin-top:40vh;text-align:center">Opening the Pokédex…</p></div>';
      species.load().then(() => { if (!el.hidden) render(); });
      return;
    }
    const keep = el.scrollTop;
    const caught = binderDex(dex, c);
    const idx = store.collections.indexOf(c);
    el.style.setProperty('--an-accent', BINDER_COLORS[idx % BINDER_COLORS.length]);
    const av = Celebrate.avatar(kidOf(c));
    const pct = Math.round(caught.size / dex.count * 1000) / 10;
    const gens = dex.gens.map(g => {
      let got = 0; for (let n = g.from; n <= g.to; n++) if (caught.has(n)) got++;
      return { ...g, got, size: g.to - g.from + 1 };
    });
    const sections = gens.map(g => {
      let tiles = '';
      for (let n = g.from; n <= g.to; n++) {
        const has = caught.has(n);
        if ((st.filter === 'caught' && !has) || (st.filter === 'missing' && has)) continue;
        tiles += tile(dex, n, caught.get(n));
      }
      const done = g.got === g.size;
      const empty = st.filter === 'caught' ? 'None caught here yet.' : 'Every one caught!';
      return `<section class="dx-gen" id="dx-gen-${g.n}">
        <h3>${done ? '<span class="dx-star" aria-label="complete">★</span>' : ''}${g.region} <small>Gen ${g.n} · ${g.got} of ${g.size}</small></h3>
        ${tiles ? `<div class="dx-grid">${tiles}</div>` : `<p class="dx-none">${empty}</p>`}
      </section>`;
    }).join('');
    el.innerHTML = `<div class="an-wrap dx-wrap">
      <header class="an-top"><button class="an-back" data-dx="close" aria-label="Back to the binder">‹ Binder</button></header>
      <h1 class="an-title">${av ? `<img class="av" src="${av}" alt="">` : ''}${esc(title(c.name))}</h1>
      <div class="an-card dx-hero">
        <div class="dx-count"><b>${caught.size}</b> of ${dex.count} caught</div>
        <div class="dx-bar"><span style="width:${Math.max(caught.size ? 1.5 : 0, pct)}%"></span></div>
        <div class="dx-chips" role="group" aria-label="Show">
          ${[['all', 'All'], ['caught', 'Caught'], ['missing', 'Still to find']].map(([k, l]) =>
            `<button type="button" data-dx="filter" data-v="${k}" aria-pressed="${st.filter === k}">${l}</button>`).join('')}
        </div>
        <div class="dx-gens">
          ${gens.map(g => `<button type="button" data-dx="gen" data-v="${g.n}" class="${g.got === g.size ? 'done' : ''}">${g.got === g.size ? '★ ' : ''}${g.region} <small>${g.got}/${g.size}</small></button>`).join('')}
        </div>
      </div>
      ${sections}
    </div>`;
    el.scrollTop = keep;
  }

  function open(id) {
    st.id = id; st.filter = 'all';
    const el = $('#pokedex'); el.hidden = false; el.scrollTop = 0; render();
  }
  function close() { $('#pokedex').hidden = true; }

  document.addEventListener('click', ev => {
    const root = $('#pokedex'); if (!root || root.hidden || !root.contains(ev.target)) return;
    const b = ev.target.closest('[data-dx]'); if (!b) return;
    const k = b.dataset.dx;
    if (k === 'close') close();
    else if (k === 'filter') { st.filter = b.dataset.v; root.scrollTop = 0; render(); }
    else if (k === 'gen') { const s = $(`#dx-gen-${b.dataset.v}`); if (s) root.scrollTo({ top: s.offsetTop - 8, behavior: 'smooth' }); }
    else if (k === 'tile') {
      const dex = species.dex, c = binder(); if (!dex || !c) return;
      const n = Number(b.dataset.n), cards = binderDex(dex, c).get(n) || [];
      if (cards.length === 1) { openCardDetails(cards[0]); return; }
      openSheet(`<h2 class="display">#${pad(n)} ${esc(dex.name(n))}</h2>
        <p class="muted">${cards.length} different cards in this binder</p>
        <div class="dx-list">${cards.map(e => `<button type="button" class="dx-row" data-dx-card="${esc(e.key)}">
          ${e.imageSmall ? `<img src="${esc(e.imageSmall)}" alt="">` : '<span class="dx-row-noimg"></span>'}
          <span><b>${esc(e.name)}</b><br><span class="small muted">${esc(e.setName || '')}${e.quantity > 1 ? ` · ×${e.quantity}` : ''}</span></span></button>`).join('')}</div>
        <button class="btn btn-outline btn-block" style="margin-top:12px" data-action="close-sheet">Close</button>`);
    }
  });
  // a card in the "which card?" list
  document.addEventListener('click', ev => {
    const row = ev.target.closest('[data-dx-card]'); if (!row) return;
    const c = binder(); const e = c && c.cards.find(x => x.key === row.dataset.dxCard);
    if (e) { closeSheet(); openCardDetails(e); }
  });

  return { open, close, render, title, pad };
})();
