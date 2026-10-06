'use strict';
/*
 * Bulk upload: pick several photos, or one photo with many cards (a binder page, cards laid out on a table).
 * Every collector number in a photo is a card; its set size narrows the candidates and the names printed above it
 * pick between the few that remain (logic.js bulkResolve). You review what was found, fix anything, choose the binder
 * for each photo or card, and add them all.
 */
const Bulk = (() => {
  const $ = (s, r = document) => r.querySelector(s);
  let st = null;
  let seq = 1;

  /** Reads a photo into OCR words and lines (image pixels). Replaceable, so it can be tested without an OCR engine. */
  const engine = {
    async read(file, onProgress) {
      let bmp;
      try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch (e) { bmp = await createImageBitmap(file); }
      const scale = Math.min(1, 3400 / Math.max(bmp.width, bmp.height));
      const W = Math.round(bmp.width * scale), H = Math.round(bmp.height * scale);
      const full = document.createElement('canvas'); full.width = W; full.height = H;
      full.getContext('2d').drawImage(bmp, 0, 0, W, H);
      if (bmp.close) bmp.close();
      await ocr.ready(app.lang);
      // tiles of about 1500 px with a little overlap, so small print is big enough to read
      const T = 1500, OV = 160;
      const cols = W > T * 1.15 ? Math.ceil(W / T) : 1, rows = H > T * 1.15 ? Math.ceil(H / T) : 1;
      const tw = cols === 1 ? W : Math.ceil(W / cols) + OV, th = rows === 1 ? H : Math.ceil(H / rows) + OV;
      const words = [], lines = [];
      let n = 0;
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        n++;
        onProgress(rows * cols > 1 ? `reading part ${n} of ${rows * cols}` : 'reading');
        const x = cols === 1 ? 0 : Math.min(W - tw, Math.round(c * (W - tw) / (cols - 1)));
        const y = rows === 1 ? 0 : Math.min(H - th, Math.round(r * (H - th) / (rows - 1)));
        const tc = document.createElement('canvas'); tc.width = tw; tc.height = th;
        const g = tc.getContext('2d', { willReadFrequently: true });
        g.drawImage(full, x, y, tw, th, 0, 0, tw, th);
        enhance(g, tw, th);
        const add = (res) => {
          for (const w of res.data.words || []) words.push({ text: w.text, x0: w.bbox.x0 + x, y0: w.bbox.y0 + y, x1: w.bbox.x1 + x, y1: w.bbox.y1 + y });
          for (const l of res.data.lines || []) lines.push({ text: l.text, x0: l.bbox.x0 + x, y0: l.bbox.y0 + y, x1: l.bbox.x1 + x, y1: l.bbox.y1 + y });
        };
        add(await ocr.numberWorker.recognize(tc));
        if (app.lang !== 'en' && ocr.nameWorker) add(await ocr.nameWorker.recognize(tc));    // Japanese / Chinese names
      }
      return { words, lines, w: W, h: H };
    },
  };

  const active = () => !!(st && st.phase !== 'closed');
  const defaultBinder = () => (store.collections.find(c => c.id === (st && st.binderId)) || store.collections[0]).id;
  const binderOf = id => store.collections.find(c => c.id === id) || store.collections[0];

  function makeItem(f, photo, extra = {}) {
    const chosen = f.chosen || null;
    return Object.assign({
      id: seq++, photo, number: f.number, total: f.total, status: f.status, candidates: f.candidates.slice(0, 8), chosenId: chosen ? chosen.id : null,
      qty: 1, binderId: st.binderId, cards: {}, variantIdx: 0, editing: false, setMatched: f.setMatched,
    }, extra);
  }

  // ---------- reading the photos ----------
  async function start(fileList) {
    const files = [...fileList].filter(f => /^image\//.test(f.type) || /\.(jpe?g|png|webp|heic|heif)$/i.test(f.name));
    if (!files.length) { toast('Pick one or more photos'); return; }
    st = { phase: 'reading', items: [], files: [], binderId: store.collections[0].id, progress: 'Getting the card list…', cancel: false, adding: false, newForm: false };
    render();
    let cat;
    try { cat = await catalogs[app.lang].load(); } catch (e) { toast("Couldn't get the card list. Check your connection."); close(); return; }
    await addPhotos(files, cat);
  }

  async function addPhotos(files, cat) {
    st.phase = 'reading'; st.cancel = false; render();
    for (const file of files) {
      if (st.cancel) break;
      const photo = st.files.push({ name: file.name || 'Photo', found: 0 }) - 1;
      const label = `Photo ${photo + 1}`;
      try {
        const r = await engine.read(file, msg => { st.progress = `${label}: ${msg}`; const p = $('#bulkProg'); if (p) p.textContent = st.progress; });
        const found = bulkResolve(r.lines, r.words, cat, { w: r.w, h: r.h });
        st.files[photo].found = found.length;
        for (const f of found) st.items.push(makeItem(f, photo));
      } catch (e) {
        st.files[photo].error = true;
      }
    }
    st.phase = 'review'; render(); loadDetails();
  }

  /** Pictures and prices for the matches, a few at a time. */
  async function loadDetails() {
    const need = [];
    for (const it of st.items) for (const b of (it.chosenId ? it.candidates.filter(c => c.id === it.chosenId) : it.candidates.slice(0, 6))) if (!it.cards[b.id]) need.push([it, b]);
    for (let i = 0; i < need.length && st && st.phase === 'review'; i += 8) {
      const batch = need.slice(i, i + 8);
      try {
        const cards = await cardDetails(batch.map(([, b]) => b));
        for (const c of cards) for (const [it] of batch) if (it.candidates.some(b => b.id === c.id)) it.cards[c.id] = c;
      } catch (e) { /* the row keeps showing its name; adding fetches the card again */ }
      if (st && st.phase === 'review') render();
    }
  }

  // ---------- fixing an item ----------
  async function briefsFor(p) {
    const cat = await catalogs[app.lang].load();
    if (app.lang !== 'en' && p.name && !hasCjk(p.name)) {
      const api = await species.load();
      const hit = api && api.localNamesFor(p.name, app.lang);
      if (hit) {
        let b = cat.cardsNamed(hit.locals);
        if (p.number) { const by = b.filter(x => x.localId && normalizeNumber(x.localId) === p.number); if (by.length) b = by; }
        return { briefs: b, exact: false };
      }
    }
    if (p.name) p.name = cat.resolveName(p.name) || p.name;
    return pickTier(cat, p, true);
  }

  async function resolveInto(it, p) {
    try {
      const { briefs, exact } = await briefsFor(p);
      const c = briefs.slice().reverse().slice(0, 8);
      it.candidates = c;
      it.status = c.length === 0 ? 'unknown' : (c.length === 1 || exact) ? 'matched' : 'pick';
      it.chosenId = it.status === 'matched' ? c[0].id : null;
      it.number = p.number || it.number; it.total = p.total || it.total;
    } catch (e) { toast("Couldn't search. Check your connection."); }
    it.editing = false; render(); loadDetails();
  }

  // ---------- adding ----------
  const chosenCard = it => it.chosenId && it.cards[it.chosenId];
  const priceOf = it => { const c = chosenCard(it); if (!c) return null; const v = c.prices[it.variantIdx] || c.prices[0]; return v && v.market != null ? v.market : null; };

  async function addAll() {
    if (st.adding) return;
    const todo = st.items.filter(it => it.chosenId);
    if (!todo.length) return;
    st.adding = true; render();
    let added = 0, top = null, priciest = null;
    const perBinder = new Map();
    // each binder's Pokédex before, to tell which Pokémon are new
    const dexBefore = new Map(species.dex ? store.collections.map(c => [c.id, new Set(binderDex(species.dex, c).keys())]) : []);
    for (const it of todo) {
      let card = chosenCard(it);
      if (!card) { try { [card] = await cardDetails(it.candidates.filter(b => b.id === it.chosenId)); } catch (e) { card = null; } }
      if (!card) continue;
      const variant = card.prices[it.variantIdx] || card.prices[0] || null;
      for (let i = 0; i < it.qty; i++) store.add(it.binderId, card, variant);
      added += it.qty; perBinder.set(it.binderId, (perBinder.get(it.binderId) || 0) + it.qty);
      const worth = (variant && variant.market) || 0;
      const v = cardValue(card, variant);
      if (v != null && (priciest == null || v > priciest)) priciest = v;
      if (!top || rarityRank(card.rarity) > rarityRank(top.rarity) || (rarityRank(card.rarity) === rarityRank(top.rarity) && worth > top.worth)) top = { name: card.name, rarity: card.rarity, worth, binderId: it.binderId };
    }
    buzz();
    if (added) Sounds.play(priciest);              // "omg" if any card added is worth more than $10
    const missed = todo.length - todo.filter(it => true).length;
    close();
    const bid = [...perBinder.entries()].sort((a, b) => b[1] - a[1])[0];
    const b = bid ? binderOf(bid[0]) : null;
    toast(added ? `Added ${added} card${added === 1 ? '' : 's'}${perBinder.size === 1 && b ? ` to ${b.name}` : ''}` : "Nothing was added");
    let line = null;
    if (added && b && species.dex && dexBefore.has(b.id)) {
      const had = dexBefore.get(b.id), now = binderDex(species.dex, b);
      const fresh = [...now.keys()].filter(n => !had.has(n));
      if (fresh.length) {
        line = fresh.length > 1 ? `${fresh.length} new Pokédex entries!` : 'New Pokédex entry!';
        setTimeout(() => toast(`New in the Pokédex: ${fresh.sort((x, y) => x - y).slice(0, 3).map(n => `#${Pokedex.pad(n)} ${species.dex.name(n)}`).join(', ')}${fresh.length > 3 ? ` and ${fresh.length - 3} more` : ''}`), 1200);
      }
    }
    if (added && b) Celebrate.show({ kid: kidOf(b), card: top, tier: BinderUI.tierOf(top && top.rarity), count: added, line });
    if (app.view === 'binders') renderBinders();
  }

  // ---------- the screen ----------
  const chip = (act, id, on, label, av) => `<button type="button" class="bulk-chip" data-bk="${act}" data-v="${esc(id)}" aria-pressed="${on}">${av ? `<img src="${av}" alt="">` : ''}${esc(label)}</button>`;
  const binderChips = (act, current, scopeAttr = '') => store.collections.map(c => {
    const av = Celebrate.avatar(kidOf(c));
    return `<button type="button" class="bulk-chip" data-bk="${act}" data-v="${esc(c.id)}" ${scopeAttr} aria-pressed="${c.id === current}">${av ? `<img src="${av}" alt="">` : ''}${esc(c.name)}</button>`;
  }).join('');

  function itemHtml(it) {
    const card = chosenCard(it), cand = it.candidates;
    const readText = `${esc(it.number)}${it.total ? `/${esc(it.total)}` : ''}`;
    let body;
    if (it.editing) {
      body = `<form class="bulk-edit" data-bkform="edit" data-id="${it.id}" autocomplete="off">
        <label>Name<input class="field" name="cardname" placeholder="${app.lang === 'en' ? 'for example Pikachu' : 'English name, for example Dragonair'}" value="${esc(card ? card.name : '')}"></label>
        <div class="row" style="align-items:flex-end;margin-top:8px"><label class="grow">Number<input class="field" name="cardnumber" value="${esc(it.number || '')}"></label><span style="padding-bottom:14px">of</span><label class="grow">Set size<input class="field" name="cardtotal" value="${esc(it.total || '')}"></label></div>
        <div class="row" style="margin-top:10px"><button class="btn btn-primary grow" type="submit">Search again</button><button class="btn btn-outline" type="button" data-bk="edit-cancel" data-id="${it.id}">Cancel</button></div></form>`;
    } else if (it.status === 'unknown') {
      body = `<div class="bulk-sub">Read ${readText} but couldn't find that card. <button class="bulk-link" data-bk="edit" data-id="${it.id}">Fix it</button></div>`;
    } else if (!it.chosenId) {
      body = `<div class="bulk-sub"><b>Which one is it?</b> Read ${readText}.</div>
        <div class="bulk-thumbs">${cand.map(b => { const c = it.cards[b.id]; return `<button type="button" data-bk="choose" data-id="${it.id}" data-v="${esc(b.id)}" aria-label="${esc(b.name)}">${c && c.imageSmall ? `<img src="${esc(c.imageSmall)}" alt="">` : `<span>${esc(b.name)}</span>`}</button>`; }).join('')}</div>
        <button class="bulk-link" data-bk="edit" data-id="${it.id}">None of these? Fix it</button>`;
    } else {
      const p = priceOf(it), variants = card && card.prices.length > 1;
      body = `<div class="bulk-name">${esc(card ? card.name : (cand.find(b => b.id === it.chosenId) || {}).name || '')}</div>
        <div class="bulk-sub">${card ? `${esc(card.setName || '')} · #${esc(card.number || it.number)}${card.setTotal ? ` of ${card.setTotal}` : ''}${card.rarity ? ` · ${esc(card.rarity)}` : ''}` : `Read ${readText}`}</div>
        <div class="bulk-sub bulk-price">${card ? (p != null ? usd(p) : 'No price yet') : 'Loading…'}${variants ? ` <select data-bk="variant" data-id="${it.id}" aria-label="Version">${card.prices.map((v, i) => `<option value="${i}" ${i === it.variantIdx ? 'selected' : ''}>${esc(v.label)}</option>`).join('')}</select>` : ''}</div>
        <div class="bulk-actions">${binderChips('item-binder', it.binderId, `data-id="${it.id}"`)}<button class="bulk-link" data-bk="edit" data-id="${it.id}">Not right?</button></div>`;
    }
    const img = card && card.imageSmall ? `<img class="bulk-thumb" src="${esc(card.imageSmall)}" alt="">` : '<span class="bulk-thumb bulk-noimg"></span>';
    return `<div class="bulk-item" data-status="${it.status}">${it.chosenId || it.editing ? img : '<span class="bulk-thumb bulk-noimg">?</span>'}
      <div class="bulk-main">${body}</div>
      <div class="bulk-side"><button class="bulk-x" data-bk="remove" data-id="${it.id}" aria-label="Remove">×</button>
        ${it.chosenId ? `<div class="bulk-qty"><button data-bk="qty-" data-id="${it.id}" aria-label="One fewer" ${it.qty <= 1 ? 'disabled' : ''}>−</button><b>${it.qty}</b><button data-bk="qty+" data-id="${it.id}" aria-label="One more">+</button></div>` : ''}</div></div>`;
  }

  function reviewHtml() {
    const ready = st.items.filter(it => it.chosenId), n = ready.reduce((a, it) => a + it.qty, 0);
    const worth = ready.reduce((a, it) => a + (priceOf(it) || 0) * it.qty, 0);
    const need = st.items.filter(it => !it.chosenId && it.status !== 'unknown').length, unknown = st.items.filter(it => it.status === 'unknown').length;
    const groups = st.files.map((f, i) => ({ f, i, items: st.items.filter(it => it.photo === i) }));
    const photos = st.files.length;
    return `<div class="bulk-wrap">
      <header class="bulk-top"><button type="button" class="bulk-back" data-bk="close"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>Back to scanner</button>
        <button type="button" class="bulk-pill" data-bk="more">Add more photos</button></header>
      <h1 class="bulk-title">${st.items.length ? `Found ${st.items.length} card${st.items.length === 1 ? '' : 's'}` : 'No cards found'}${photos > 1 ? ` in ${photos} photos` : ''}</h1>
      ${st.items.length ? `<p class="bulk-note">Check each one, then add them. Everything goes to the binder shown on its photo; change it for the whole photo or for a single card.</p>` : `<p class="bulk-note">The collector numbers (like 091/129, at the bottom of a card) weren't readable. Try a sharper, closer photo with the cards flat and well lit, or add a card by name below.</p>`}
      ${need ? `<div class="bulk-warn">${need} card${need === 1 ? ' needs' : 's need'} you to pick which one it is.</div>` : ''}
      ${unknown ? `<div class="bulk-warn">${unknown} number${unknown === 1 ? ' was' : 's were'} read but not found in the card list. Tap Fix it.</div>` : ''}
      ${groups.map(g => g.f.error ? `<section class="bulk-group"><h3>Photo ${g.i + 1}</h3><p class="bulk-note">Couldn't read this photo.</p></section>` : `
        <section class="bulk-group"><div class="bulk-gh"><h3>Photo ${g.i + 1}<small>${g.items.length} card${g.items.length === 1 ? '' : 's'}</small></h3>
          ${g.items.length ? `<div class="bulk-gb">Send to ${binderChips('photo-binder', (g.items[0] || {}).binderId, `data-photo="${g.i}"`)}</div>` : ''}</div>
        ${g.items.map(itemHtml).join('')}</section>`).join('')}
      <section class="bulk-group">
        ${st.newForm ? `<form class="bulk-edit" data-bkform="new" autocomplete="off"><h3>Add a card by name</h3>
          <label>Name<input class="field" name="cardname" placeholder="${app.lang === 'en' ? 'for example Pikachu' : 'English name, for example Dragonair'}"></label>
          <div class="row" style="align-items:flex-end;margin-top:8px"><label class="grow">Number<input class="field" name="cardnumber"></label><span style="padding-bottom:14px">of</span><label class="grow">Set size<input class="field" name="cardtotal"></label></div>
          <div class="row" style="margin-top:10px"><button class="btn btn-primary grow" type="submit">Find it</button><button class="btn btn-outline" type="button" data-bk="new-cancel">Cancel</button></div></form>`
        : '<button class="bulk-link" data-bk="new">+ Add a card the photo missed</button>'}
      </section>
      <div class="bulk-bar"><div><b>${n} card${n === 1 ? '' : 's'} ready</b><small>${worth > 0 ? `About ${usd(worth)}` : 'Prices appear as they load'}</small></div>
        <button type="button" class="btn btn-primary" data-bk="add" ${n && !st.adding ? '' : 'disabled'}>${st.adding ? 'Adding…' : `Add ${n || ''} to ${n ? 'binders' : 'binder'}`}</button></div>
    </div>`;
  }

  function readingHtml() {
    return `<div class="bulk-wrap bulk-center"><div class="spinner"></div><h1 class="bulk-title">Reading your photos</h1>
      <p class="bulk-note" id="bulkProg">${esc(st.progress)}</p><p class="bulk-note">This can take a little while for big photos. Everything is read on your phone.</p>
      <button class="btn btn-outline" data-bk="cancel">Stop and review what's found</button></div>`;
  }

  function render() {
    const el = $('#bulk'); if (!st || !el) return;
    const keep = el.scrollTop;
    el.hidden = st.phase === 'closed';
    el.innerHTML = st.phase === 'reading' ? readingHtml() : reviewHtml();
    el.scrollTop = keep;
  }

  function close() { if (st) { st.phase = 'closed'; st.cancel = true; } const el = $('#bulk'); if (el) { el.hidden = true; el.innerHTML = ''; } }
  const byId = id => st && st.items.find(i => i.id === Number(id));

  document.addEventListener('click', async ev => {
    const root = $('#bulk'); if (!st || !root || root.hidden || !root.contains(ev.target)) return;
    const b = ev.target.closest('[data-bk]'); if (!b) return;
    const k = b.dataset.bk, it = byId(b.dataset.id), v = b.dataset.v;
    if (k === 'close') close();
    else if (k === 'cancel') st.cancel = true;
    else if (k === 'more') { const f = $('#bulkFile'); if (f) f.click(); }
    else if (k === 'photo-binder') { st.items.filter(i => i.photo === Number(b.dataset.photo)).forEach(i => { i.binderId = v; }); render(); }
    else if (k === 'item-binder' && it) { it.binderId = v; render(); }
    else if (k === 'choose' && it) { it.chosenId = v; it.status = 'matched'; render(); loadDetails(); }
    else if (k === 'qty+' && it) { it.qty++; render(); }
    else if (k === 'qty-' && it) { it.qty = Math.max(1, it.qty - 1); render(); }
    else if (k === 'remove' && it) { st.items = st.items.filter(i => i !== it); render(); }
    else if (k === 'edit' && it) { it.editing = true; render(); }
    else if (k === 'edit-cancel' && it) { it.editing = false; render(); }
    else if (k === 'new') { st.newForm = true; render(); }
    else if (k === 'new-cancel') { st.newForm = false; render(); }
    else if (k === 'add') addAll();
  });
  document.addEventListener('change', ev => {
    const s = ev.target.closest && ev.target.closest('select[data-bk=variant]'); const it = s && byId(s.dataset.id);
    if (it) { it.variantIdx = Number(s.value); render(); }
  });
  document.addEventListener('submit', async ev => {
    const f = ev.target.closest && ev.target.closest('[data-bkform]'); if (!f || !st) return;
    ev.preventDefault();
    const d = new FormData(f), name = String(d.get('cardname') || '').trim(), num = String(d.get('cardnumber') || '').trim(), tot = String(d.get('cardtotal') || '').trim();
    if (!name && !num) { toast('Type a name or a card number'); return; }
    const p = { name: name || null, number: num ? normalizeNumber(num) : null, total: tot ? normalizeNumber(tot) : null };
    if (f.dataset.bkform === 'edit') { const it = byId(f.dataset.id); if (it) await resolveInto(it, p); }
    else {
      const photo = Math.max(0, st.files.length - 1);
      if (!st.files.length) st.files.push({ name: 'Added by hand', found: 0 });
      const it = makeItem({ number: p.number || '', total: p.total || '', status: 'unknown', candidates: [], chosen: null }, photo);
      st.items.push(it); st.newForm = false; await resolveInto(it, p);
    }
  });

  /** Called when more photos are picked while the review is open. */
  async function more(fileList) {
    const files = [...fileList].filter(f => /^image\//.test(f.type) || /\.(jpe?g|png|webp|heic|heif)$/i.test(f.name));
    if (!files.length || !st) return;
    st.binderId = st.binderId || store.collections[0].id;
    await addPhotos(files, await catalogs[app.lang].load());
  }

  return { start, more, close, active, engine, get state() { return st; } };
})();
