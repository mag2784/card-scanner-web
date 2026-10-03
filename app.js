'use strict';
/* Card Scanner (web): camera + OCR, results, binders and Google Sheet backup. Uses logic.js. */

const APP_VERSION = '1.0';
const BINDER_COLORS = ['#E8336E', '#2F6BFF', '#00875A', '#E07A00', '#7A4DFF', '#0097A7'];
const CATALOG_MAX_AGE = 3 * 24 * 3600 * 1000;   // re-download card lists every 3 days
const PRICE_MAX_AGE = 12 * 3600 * 1000;         // refresh binder prices every 12 hours

// ---------- helpers ----------
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const usd = v => (v == null ? 'n/a' : '$' + v.toFixed(2));
const eur = v => (v == null ? 'n/a' : '€' + v.toFixed(2));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const uid = () => Math.random().toString(36).slice(2, 10);
const buzz = () => { try { navigator.vibrate && navigator.vibrate(30); } catch (e) { /* not supported */ } };

function timeAgo(t) {
  if (!t) return 'never';
  const m = Math.floor((Date.now() - t) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  if (m < 1440) return `${Math.floor(m / 60)} h ago`;
  return `${Math.floor(m / 1440)} days ago`;
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 2600);
}

function randomKey(n = 24) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return [...bytes].map(b => chars[b % chars.length]).join('');
}

// ---------- IndexedDB (card lists are too big for localStorage) ----------
const kv = (() => {
  let dbp = null;
  const open = () => dbp || (dbp = new Promise((res, rej) => {
    const r = indexedDB.open('card-scanner', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
  const run = async (mode, fn) => {
    const db = await open();
    return new Promise((res, rej) => {
      const tx = db.transaction('kv', mode);
      const req = fn(tx.objectStore('kv'));
      tx.oncomplete = () => res(req ? req.result : undefined);
      tx.onerror = () => rej(tx.error);
    });
  };
  return { get: k => run('readonly', s => s.get(k)), set: (k, v) => run('readwrite', s => s.put(v, k)) };
})();

// ---------- TCGdex ----------
async function fetchJSON(url, tries = 3) {
  for (let i = 0; ; i++) {
    let res;
    try {
      res = await fetch(url);
    } catch (e) {
      if (i >= tries - 1) throw new Error("Couldn't reach the card database. Check your connection and try again.");
      await sleep(700 * (i + 1));
      continue;
    }
    if (res.ok) return res.json();
    if (res.status >= 500 && i < tries - 1) { await sleep(700 * (i + 1)); continue; }
    throw new Error(`The card database returned an error (HTTP ${res.status}). Try again in a minute.`);
  }
}

async function cachedList(key, url) {
  const saved = await kv.get(key).catch(() => null);
  if (saved && Date.now() - saved.at < CATALOG_MAX_AGE) return saved.data;
  try {
    const data = await fetchJSON(url);
    kv.set(key, { at: Date.now(), data }).catch(() => {});
    return data;
  } catch (e) {
    if (saved) return saved.data;   // offline: use the older copy
    throw e;
  }
}

/** One card list per printing region, downloaded the first time it's used. */
const catalogs = {};
for (const key of Object.keys(LANGS)) {
  catalogs[key] = {
    data: null, promise: null, failedAt: 0,
    load() {
      if (this.data) return Promise.resolve(this.data);
      if (!this.promise) {
        this.promise = (async () => {
          const cards = [], sets = [];
          for (const code of LANGS[key].codes) {
            const list = await cachedList(`cards_${code}`, `${API}/${code}/cards`);
            for (const b of list) cards.push({ id: b.id, localId: b.localId, name: b.name, image: b.image, lang: code });
            sets.push(...await cachedList(`sets_${code}`, `${API}/${code}/sets`));
          }
          this.data = buildCatalog(cards, sets);
          this.failedAt = 0;
          return this.data;
        })().catch(e => { this.promise = null; this.failedAt = Date.now(); throw e; });
      }
      return this.promise;
    },
  };
}

const detailCache = new Map();
async function cardDetails(briefs) {
  const results = await Promise.all(briefs.map(async b => {
    const lang = b.lang || 'en';
    const k = `${lang}/${b.id}`;
    if (detailCache.has(k)) return { card: detailCache.get(k) };
    try {
      const card = toCard(await fetchJSON(`${API}/${lang}/cards/${encodeURIComponent(b.id)}`), lang);
      if (card) detailCache.set(k, card);
      return { card };
    } catch (error) { return { error }; }
  }));
  const cards = results.map(r => r.card).filter(Boolean);
  if (!cards.length) { const failed = results.find(r => r.error); if (failed) throw failed.error; }
  return cards;
}

// ---------- binders (saved on the phone) ----------
const store = {
  lib: null,
  init() {
    try { this.lib = JSON.parse(localStorage.getItem('library') || 'null'); } catch (e) { this.lib = null; }
    if (!this.lib || !Array.isArray(this.lib.collections) || !this.lib.collections.length) {
      this.lib = { collections: [{ id: uid(), name: 'My binder', cards: [] }] };
      this.save(false);
    }
    this.lib.collections.forEach(c => { c.cards = c.cards || []; });
  },
  get collections() { return this.lib.collections; },
  save(push = true) {
    try { localStorage.setItem('library', JSON.stringify(this.lib)); } catch (e) { toast("Couldn't save on this phone."); }
    if (push) sync.schedule();
  },
  replaceAll(collections) {
    this.lib = { collections: collections.map(c => ({ ...c, cards: c.cards || [] })) };
    this.save(false);
  },
  add(binderId, card, variant) {
    const c = this.collections.find(x => x.id === binderId);
    if (!c) return;
    const key = `${card.id}|${variant ? variant.label : ''}`;
    const existing = c.cards.find(e => e.key === key);
    const now = Date.now();
    if (existing) existing.quantity += 1;
    else {
      const price = variant ? variant.market : marketPrice(card, null);
      c.cards.push({
        key, cardId: card.id, name: card.name, setName: card.setName, number: card.number,
        setTotal: card.setTotal, rarity: card.rarity, imageSmall: card.imageSmall, imageLarge: card.imageLarge,
        variant: variant ? variant.label : null, quantity: 1, addedAt: now,
        priceWhenAdded: price ?? null, price: price ?? null, priceUpdatedAt: now,
        language: card.lang, priceEur: eurPrice(card), priceEurWhenAdded: eurPrice(card),
      });
    }
    this.save();
  },
  setQuantity(binderId, key, qty) {
    const c = this.collections.find(x => x.id === binderId);
    if (!c) return;
    if (qty <= 0) c.cards = c.cards.filter(e => e.key !== key);
    else { const e = c.cards.find(x => x.key === key); if (e) e.quantity = qty; }
    this.save();
  },
  applyPrices(fresh) {
    if (!fresh.size) return;
    const now = Date.now();
    for (const c of this.collections) for (const e of c.cards) {
      const card = fresh.get(`${e.language || 'en'}/${e.cardId}`);
      if (!card) continue;
      e.price = marketPrice(card, e.variant) ?? e.price;
      e.priceEur = eurPrice(card) ?? e.priceEur;
      e.rarity = card.rarity || e.rarity;
      e.priceUpdatedAt = now;
    }
    this.save();
  },
  addBinder(name) {
    const c = { id: uid(), name, cards: [] };
    this.collections.push(c);
    this.save();
    return c;
  },
};

/** "Harper" -> "Harper's binder"; "My binder" stays "My binder". */
const binderTitle = name => (/binder$/i.test(name) ? name : `${name}'s binder`);

const total = c => c.cards.reduce((s, e) => s + (e.price || 0) * e.quantity, 0);
const totalEurOnly = c => c.cards.filter(e => e.price == null).reduce((s, e) => s + (e.priceEur || 0) * e.quantity, 0);
const count = c => c.cards.reduce((s, e) => s + e.quantity, 0);

// ---------- Google Sheet backup ----------
const sync = {
  status: { syncing: false, last: Number(localStorage.getItem('syncLast')) || null, error: null },
  get link() { try { return JSON.parse(localStorage.getItem('syncLink') || 'null'); } catch (e) { return null; } },
  set link(v) { if (v) localStorage.setItem('syncLink', JSON.stringify(v)); else localStorage.removeItem('syncLink'); },

  /** Web app URL from the Deploy dialog, or the full link (with ?key=) from the sheet's Setup tab. */
  parse(raw) {
    const s = String(raw || '').trim();
    if (!s.startsWith('https://script.google.com/')) return null;
    const [url, query = ''] = s.split('?');
    const key = new URLSearchParams(query).get('key') || randomKey();
    return { url, key };
  },
  async call(link, body) {
    const res = await fetch(link.url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },   // "simple" request: no CORS preflight
      body: JSON.stringify({ key: link.key, ...body }),
    });
    const text = await res.text();
    let reply;
    try { reply = JSON.parse(text); } catch (e) {
      throw new Error(/<html/i.test(text)
        ? 'The script isn\'t published for "Anyone". Check the deployment settings.'
        : `Unexpected reply from the sheet (HTTP ${res.status}).`);
    }
    if (!reply.ok) throw new Error(reply.error || 'The sheet refused the request.');
    return reply;
  },
  schedule() {
    if (!this.link) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.push(), 2000);
  },
  markSynced() {
    this.status.last = Date.now();
    this.status.error = null;
    localStorage.setItem('syncLast', String(this.status.last));
  },
  async push() {
    const link = this.link;
    if (!link) return;
    this.status.syncing = true; this.status.error = null; refreshSyncUi();
    try {
      await this.call(link, { action: 'save', library: store.lib });
      this.markSynced();
    } catch (e) {
      this.status.error = e.message || 'Sync failed. It will retry on the next change.';
    } finally {
      this.status.syncing = false; refreshSyncUi();
    }
  },
  async connect(raw) {
    const link = this.parse(raw);
    if (!link) throw new Error('That doesn\'t look like the script link. It starts with https://script.google.com/');
    const remote = await this.call(link, { action: 'load' });
    this.link = link;
    const sheetCols = (remote.library && remote.library.collections) || [];
    const sheetCards = sheetCols.reduce((s, c) => s + (c.cards || []).reduce((a, e) => a + (e.quantity || 0), 0), 0);
    const phoneCards = store.collections.reduce((s, c) => s + count(c), 0);
    if (sheetCards === 0) { await this.push(); return 'Connected! Your binders were saved to the sheet.'; }
    if (phoneCards === 0) {
      store.replaceAll(sheetCols); this.markSynced();
      return `Connected and restored ${sheetCards} cards from the sheet.`;
    }
    const useSheet = confirm(`The sheet has ${sheetCards} cards and this phone has ${phoneCards}.\n\nOK: use the sheet's binders.\nCancel: keep this phone's binders and update the sheet.`);
    if (useSheet) { store.replaceAll(sheetCols); this.markSynced(); return 'Restored the binders from the sheet.'; }
    await this.push();
    return 'Kept this phone\'s binders and updated the sheet.';
  },
  async restore() {
    const link = this.link;
    if (!link) return false;
    const remote = await this.call(link, { action: 'load' });
    const cols = (remote.library && remote.library.collections) || [];
    if (!cols.length) return false;
    store.replaceAll(cols); this.markSynced();
    return true;
  },
};

// ---------- app state ----------
const app = {
  lang: LANGS[localStorage.getItem('lang')] ? localStorage.getItem('lang') : 'en',
  view: 'scan',
  scan: { state: 'scanning' },
  binderId: null,
  sort: 'value',
  rarity: null,
  refreshing: false,
  refreshMsg: null,
  scriptText: null,
};

// ---------- camera ----------
const video = $('#video');
const camera = {
  on: false, stream: null,
  async start() {
    if (this.on) return;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      });
      video.srcObject = this.stream;
      await video.play();
      this.on = true;
      $('#camera-msg').hidden = true;
      const track = this.stream.getVideoTracks()[0];
      try { await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }); } catch (e) { /* optional */ }
    } catch (e) {
      this.on = false;
      $('#camera-msg-text').textContent = e && e.name === 'NotAllowedError'
        ? 'Camera access is off. Allow it in your browser settings, then tap the button.'
        : 'The camera reads the card\'s name and number.';
      $('#camera-msg').hidden = false;
    }
  },
  stop() {
    if (this.stream) this.stream.getTracks().forEach(t => t.stop());
    this.stream = null;
    this.on = false;
  },
};

// ---------- OCR ----------
const ocr = {
  numberWorker: null, nameWorker: null, nameLang: null,
  async ready(lang) {
    if (!this.numberWorker) {
      const w = await Tesseract.createWorker('eng');
      await w.setParameters({ tessedit_pageseg_mode: '11' });   // sparse text: the number sits among other small text
      this.numberWorker = w;
    }
    if (this.nameLang !== lang) {
      const old = this.nameWorker;
      this.nameWorker = null; this.nameLang = null;
      if (old) await old.terminate();
      const w = await Tesseract.createWorker(LANGS[lang].tess);
      await w.setParameters({ tessedit_pageseg_mode: '6' });
      this.nameWorker = w; this.nameLang = lang;
    }
  },
};

/** Grayscale + stretch contrast, which helps OCR with holo and glare. */
function enhance(g, w, h) {
  const img = g.getImageData(0, 0, w, h), d = img.data;
  let min = 255, max = 0;
  for (let i = 0; i < d.length; i += 4) {
    const l = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
    d[i] = l;
    if (l < min) min = l;
    if (l > max) max = l;
  }
  const range = Math.max(1, max - min);
  for (let i = 0; i < d.length; i += 4) {
    const v = ((d[i] - min) * 255 / range) | 0;
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  g.putImageData(img, 0, 0);
}

/** Cuts the name strip (top) and number strip (bottom) of the card inside the viewfinder. */
function grabCrops() {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) return null;
  const vr = video.getBoundingClientRect(), fr = $('#finder').getBoundingClientRect();
  const scale = Math.max(vr.width / vw, vr.height / vh);   // object-fit: cover
  const ox = (vr.width - vw * scale) / 2, oy = (vr.height - vh * scale) / 2;
  const cx = (fr.left - vr.left - ox) / scale, cy = (fr.top - vr.top - oy) / scale;
  const cw = fr.width / scale, ch = fr.height / scale;

  const strip = (fx0, fy0, fx1, fy1, outW) => {
    const x0 = Math.max(0, cx + cw * fx0), y0 = Math.max(0, cy + ch * fy0);
    const x1 = Math.min(vw, cx + cw * fx1), y1 = Math.min(vh, cy + ch * fy1);
    if (x1 - x0 < 20 || y1 - y0 < 8) return null;
    const k = outW / (x1 - x0);
    const c = document.createElement('canvas');
    c.width = Math.round((x1 - x0) * k);
    c.height = Math.round((y1 - y0) * k);
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(video, x0, y0, x1 - x0, y1 - y0, 0, 0, c.width, c.height);
    enhance(g, c.width, c.height);
    return c;
  };
  const name = strip(0.0, 0.0, 0.82, 0.16, 800);
  const number = strip(0.0, 0.82, 1.0, 1.0, 1000);
  return name && number ? { name, number } : null;
}

function readFrom(numData, nameData) {
  const hit = parseNumber(numData.text);
  let lines = (nameData.lines || [])
    .map(l => ({ text: (l.text || '').trim(), h: l.bbox ? l.bbox.y1 - l.bbox.y0 : 0 }))
    .filter(l => l.text);
  if (!lines.length) lines = String(nameData.text || '').split('\n').map(t => ({ text: t.trim(), h: 0 })).filter(l => l.text);
  lines.sort((a, b) => b.h - a.h);   // the name is the tallest text
  return { number: hit && hit.number, total: hit && hit.total, nameLines: lines.map(l => l.text) };
}

// ---------- number-first locking with voting ----------
const votes = { numbers: [], names: [], evidence: [], locked: null, framesLocked: 0, framesNoNumber: 0 };
const VOTES_TO_LOCK = 2;     // of the last 4 reads (OCR in a browser is slower, so fewer frames)

function resetVotes() {
  Object.assign(votes, { numbers: [], names: [], evidence: [], locked: null, framesLocked: 0, framesNoNumber: 0 });
}
function push(list, item, max) { list.push(item); while (list.length > max) list.shift(); }
function winnerOf(list) {
  const counts = new Map();
  for (const v of list) if (v) counts.set(v, (counts.get(v) || 0) + 1);
  let best = null, n = 0;
  for (const [v, c] of counts) if (c > n) { best = v; n = c; }
  return n >= VOTES_TO_LOCK ? best : null;
}

function onRead(read) {
  if (app.scan.state !== 'scanning' || app.view !== 'scan') return;
  const catalog = catalogs[app.lang];
  const cat = catalog.data;
  if (!cat) {
    if (!catalog.promise && Date.now() - catalog.failedAt > 5000) catalog.load().catch(() => {});
    setLive(catalog.failedAt ? `Can't download the ${LANGS[app.lang].listName}. Retrying…`
                             : `Downloading the ${LANGS[app.lang].listName} (first time only)…`);
    return;
  }

  push(votes.numbers, read.number ? `${read.number}|${read.total || ''}` : null, 4);
  push(votes.names, read.nameLines.map(l => nameFromLine(cat, l)).find(Boolean) || null, 5);
  read.nameLines.forEach(l => push(votes.evidence, l, 30));

  const win = winnerOf(votes.numbers);
  const strong = winnerOf(votes.names);
  if (win !== votes.locked) {
    if (win && votes.locked) { votes.names = []; votes.evidence = []; }   // switched cards
    votes.locked = win;
    votes.framesLocked = 0;
  }

  if (!win) {
    setLive(strong ? `Reading: ${strong}` : 'Point at a card');
    votes.framesNoNumber++;
    if (strong && votes.framesNoNumber >= 6) search({ name: strong, number: null, total: null });
    return;
  }
  votes.framesNoNumber = 0;
  votes.framesLocked++;

  const [number, totalRaw] = win.split('|');
  const total = totalRaw || null;
  const found = cat.candidates(number, total);
  const usable = found.cards.length >= 1 && found.cards.length <= 40;
  const agrees = strong ? found.cards.filter(c => nameScore(c.name, [strong]) >= 0.8) : null;
  let chosen = null;
  if (usable) {
    if (agrees && agrees.length === 1) chosen = agrees[0];
    else {
      const p = pickCandidate(found.cards, votes.evidence);
      if (p && (!agrees || agrees.includes(p))) chosen = p;
    }
  }
  const numberText = total ? `#${number}/${total}` : `#${number}`;
  setLive('Reading: ' + [chosen ? chosen.name : strong, numberText].filter(Boolean).join(' '));

  // Name veto: the card clearly says a name none of this number's cards have
  if (usable && strong && agrees && !agrees.length) return search({ name: strong, number, total });
  if (chosen) return showCandidates(found.cards, chosen, found.setMatched, numberText);
  if (votes.framesLocked <= 2) return;   // give the name a moment
  if (usable) return showCandidates(found.cards, null, false, numberText);
  if (strong) return search({ name: strong, number, total });
  resetVotes();
  setScan({ state: 'notfound', label: numberText });
}

async function runLookup(label, fn) {
  setScan({ state: 'searching', label });
  try {
    setScan(await fn());
  } catch (e) {
    setScan({ state: 'error', message: e.message || 'Something went wrong. Try again.' });
  }
}

function search(p, typed = false) {
  const label = [p.name, p.number ? (p.total ? `#${p.number}/${p.total}` : `#${p.number}`) : null].filter(Boolean).join(' ');
  return runLookup(label, async () => {
    const cat = await catalogs[app.lang].load();
    const { briefs, exact } = pickTier(cat, p, typed);
    if (!briefs.length) return { state: 'notfound', label };
    let cards = await cardDetails(briefs.slice().reverse().slice(0, 8));   // newest first
    const t = /^\d+$/.test(p.total || '') ? parseInt(p.total, 10) : null;
    if (t != null) cards = cards.slice().sort((a, b) => (b.setTotal === t) - (a.setTotal === t));
    if (!cards.length) return { state: 'notfound', label };
    return { state: 'results', cards, selectedId: cards[0].id, exact, variantIdx: 0 };
  });
}

function showCandidates(cands, chosen, exact, label) {
  return runLookup(chosen ? chosen.name : label, async () => {
    const others = cands.filter(c => c !== chosen).reverse();
    const cards = await cardDetails([...(chosen ? [chosen] : []), ...others].slice(0, 8));
    if (!cards.length) return { state: 'notfound', label };
    return { state: 'results', cards, selectedId: cards[0].id, exact: exact && !!chosen, variantIdx: 0 };
  });
}

async function scanLoop() {
  for (;;) {
    if (!camera.on || app.view !== 'scan' || app.scan.state !== 'scanning' || document.hidden || typeof Tesseract === 'undefined') {
      await sleep(300);
      continue;
    }
    try {
      if (ocr.nameLang !== app.lang) setLive('Loading the text reader…');
      await ocr.ready(app.lang);
      const crops = grabCrops();
      if (!crops) { await sleep(200); continue; }
      const [num, name] = await Promise.all([
        ocr.numberWorker.recognize(crops.number),
        ocr.nameWorker.recognize(crops.name),
      ]);
      onRead(readFrom(num.data, name.data));
    } catch (e) {
      console.warn(e);
      await sleep(700);
    }
  }
}

// ---------- rendering: scanner ----------
function setLive(text) { $('#live').textContent = text || 'Point at a card'; }

function setScan(s) {
  if (s.state === 'results' && app.scan.state !== 'results') buzz();
  app.scan = s;
  if (s.state === 'scanning') { resetVotes(); setLive(''); }
  renderDock();
}

function renderLang() {
  $('#lang-switch').innerHTML = Object.entries(LANGS).map(([k, l]) =>
    `<button data-action="lang" data-lang="${k}" aria-pressed="${k === app.lang}">${esc(l.label)}</button>`).join('');
}

function renderDock() {
  const s = app.scan;
  const dock = $('#dock');
  $('#scan-view').classList.toggle('has-sheet', ['results', 'notfound', 'error'].includes(s.state));
  $('#finder').classList.toggle('locked', s.state === 'searching');

  if (s.state === 'scanning') {
    dock.innerHTML = `
      <p class="muted" style="margin:0 0 12px">Fit the card inside the corners. Keep the name and the number at the bottom sharp.</p>
      <form class="row" data-form="search">
        <input class="field grow" name="q" placeholder="Name and number, e.g. Pikachu 28/131" autocomplete="off" enterkeyhint="search">
        <button class="btn btn-primary" type="submit">Search</button>
      </form>
      <div class="row small muted" style="margin-top:10px">
        <span class="grow">Version ${APP_VERSION}</span>
        <button class="text-btn small" data-action="check-update">Check for updates</button>
      </div>`;
  } else if (s.state === 'searching') {
    dock.innerHTML = `<div class="row"><div class="spinner"></div><div><b>Looking it up</b><div class="muted">${esc(s.label)}</div></div></div>`;
  } else if (s.state === 'notfound' || s.state === 'error') {
    const body = s.state === 'notfound'
      ? `Couldn't find "${esc(s.label)}". The set may be too new for the database, or try typing the name.`
      : esc(s.message);
    dock.innerHTML = `
      <h2 class="display">${s.state === 'notfound' ? 'No match yet' : 'Lookup hiccup'}</h2>
      <p style="font-size:17px">${body}</p>
      <button class="btn btn-primary btn-block" data-action="rescan">${s.state === 'notfound' ? 'Scan again' : 'Try again'}</button>`;
  } else if (s.state === 'results') {
    dock.innerHTML = resultHtml();
  }
}

function resultHtml() {
  const s = app.scan;
  const card = s.cards.find(c => c.id === s.selectedId) || s.cards[0];
  const prices = card.prices;
  const vIdx = Math.min(s.variantIdx || 0, Math.max(0, prices.length - 1));
  const variant = prices[vIdx] || null;
  const eurOnly = !prices.length ? eurPrice(card) : null;
  const numberText = card.number ? `Card ${esc(card.number)}${card.setTotal ? ` of ${card.setTotal}` : ''}` : '';

  let price = '';
  if (variant) {
    price = `
      ${prices.length > 1 ? `<div class="chips" style="margin-top:18px">${prices.map((p, i) =>
        `<button class="chip-btn" data-action="variant" data-i="${i}" aria-pressed="${i === vIdx}">${esc(p.label)}</button>`).join('')}</div>` : ''}
      <div class="price-label">${prices.length === 1 ? esc(variant.label) + ' market price' : 'Market price'}</div>
      <div class="price">${usd(variant.market)}</div>
      <div class="tiles">
        <div class="tile"><span>Lowest listing</span><b>${usd(variant.low)}</b></div>
        <div class="tile"><span>Highest listing</span><b>${usd(variant.high)}</b></div>
      </div>`;
  } else if (eurOnly != null) {
    price = `<div class="price-label">Cardmarket price (Europe)</div><div class="price">${eur(eurOnly)}</div>`;
  } else {
    price = `<div class="tile" style="margin-top:18px">${card.lang !== 'en'
      ? "No price for this card. Japanese and Chinese cards often aren't tracked by the price sites."
      : 'No price yet. Brand-new cards can take a few days to get one; tap TCGplayer to see listings.'}</div>`;
  }
  const cmParts = [card.cmTrend != null && `${eur(card.cmTrend)} trend`, card.cmAvg30 != null && `${eur(card.cmAvg30)} 30-day average`,
    card.cmTrendHolo != null && `${eur(card.cmTrendHolo)} holo trend`].filter(Boolean);

  const owned = store.collections.map(c => {
    const n = c.cards.filter(e => e.cardId === card.id).reduce((a, e) => a + e.quantity, 0);
    return n ? `${esc(c.name)} has ${n}` : null;
  }).filter(Boolean);
  const q = encodeURIComponent([card.name, card.number].filter(Boolean).join(' '));

  return `
    <div class="handle"></div>
    ${s.exact ? '' : '<div class="notice">Couldn\'t confirm the exact printing. Pick yours from the row below.</div>'}
    <div class="result-top">
      <div class="foil" data-key="${esc(card.id)}">${card.imageLarge ? `<img src="${esc(card.imageLarge)}" alt="${esc(card.name)}">` : ''}</div>
      <div class="grow">
        <h2 class="display">${esc(card.name)}</h2>
        ${card.setName ? `<div><b>${esc(card.setName)}</b></div>` : ''}
        ${numberText ? `<div class="muted">${numberText}</div>` : ''}
        ${card.rarity ? `<span class="badge">${esc(card.rarity)}</span>` : ''}
      </div>
    </div>
    ${price}
    ${cmParts.length ? `<p style="margin:12px 0 0">Cardmarket (Europe): ${cmParts.join(', ')}</p>` : ''}
    ${card.tcgUpdated ? `<p class="small muted" style="margin:4px 0 0">TCGplayer prices from ${esc(card.tcgUpdated)}</p>` : ''}

    ${s.cards.length > 1 ? `
      <h3>${s.exact ? 'Other possible matches' : 'Which one is yours?'}</h3>
      <div class="thumbs">${s.cards.map(c => `
        <button data-action="pick" data-id="${esc(c.id)}" aria-pressed="${c.id === card.id}" aria-label="${esc(c.name)}">
          ${c.imageSmall ? `<img src="${esc(c.imageSmall)}" alt="" loading="lazy">` : ''}</button>`).join('')}
      </div>` : ''}

    <h3>Add to a binder</h3>
    ${prices.length > 1 && variant ? `<div class="small muted">Adds the ${esc(variant.label)} version. Pick a different one with the buttons above.</div>` : ''}
    <div class="add-row">${store.collections.map((c, i) =>
      `<button class="btn" style="background:${BINDER_COLORS[i % BINDER_COLORS.length]}" data-action="add" data-binder="${esc(c.id)}">Add to ${esc(c.name)}</button>`).join('')}
    </div>
    ${owned.length ? `<p style="margin:8px 0 0"><b>${owned.join(' and ')} of this card.</b></p>` : ''}

    <div class="row" style="margin-top:22px">
      <a class="btn btn-outline grow" target="_blank" rel="noopener" href="https://www.tcgplayer.com/search/pokemon/product?q=${q}">TCGplayer</a>
      <a class="btn btn-outline grow" target="_blank" rel="noopener" href="https://www.cardmarket.com/en/Pokemon/Products/Search?searchString=${encodeURIComponent(card.name)}">Cardmarket</a>
    </div>
    <button class="btn btn-primary btn-block" style="margin-top:10px" data-action="rescan">Scan another card</button>`;
}

// ---------- rendering: binders ----------
function currentBinder() {
  const cols = store.collections;
  let cur = cols.find(c => c.id === app.binderId);
  if (!cur) { cur = cols[0]; app.binderId = cur.id; }
  return cur;
}

function priceText(e) { return e.price != null ? usd(e.price) : e.priceEur != null ? eur(e.priceEur) : 'No price'; }

function priceChange(e) {
  const useEur = e.price == null;
  const now = useEur ? e.priceEur : e.price, then = useEur ? e.priceEurWhenAdded : e.priceWhenAdded;
  if (now == null || then == null) return '';
  const d = now - then;
  if (Math.abs(d) < 0.01) return '';
  const f = useEur ? eur : usd;
  return d > 0 ? `<div class="up">▲ ${f(d)}</div>` : `<div class="down">▼ ${f(-d)}</div>`;
}

function renderBinders() {
  const view = $('#binders-view');
  const cols = store.collections;
  const cur = currentBinder();
  const idx = cols.indexOf(cur);
  const color = BINDER_COLORS[idx % BINDER_COLORS.length];

  let list = cur.cards.filter(e => !app.rarity || (e.rarity || 'Unknown') === app.rarity);
  const val = e => (e.price ?? e.priceEur ?? 0) * e.quantity;
  if (app.sort === 'value') list = list.slice().sort((a, b) => val(b) - val(a));
  if (app.sort === 'rarity') list = list.slice().sort((a, b) => rarityRank(b.rarity) - rarityRank(a.rarity) || val(b) - val(a));
  if (app.sort === 'newest') list = list.slice().sort((a, b) => b.addedAt - a.addedAt);
  if (app.sort === 'name') list = list.slice().sort((a, b) => a.name.localeCompare(b.name));

  const rarities = {};
  for (const e of cur.cards) rarities[e.rarity || 'Unknown'] = (rarities[e.rarity || 'Unknown'] || 0) + e.quantity;
  const rarityChips = Object.entries(rarities).sort((a, b) => rarityRank(b[0]) - rarityRank(a[0]));
  const top = cur.cards.slice().sort((a, b) => (b.price || 0) - (a.price || 0))[0];
  const unique = new Set(cur.cards.map(e => e.cardId)).size;
  const n = count(cur);
  const oldest = cur.cards.length ? Math.min(...cur.cards.map(e => e.priceUpdatedAt || 0)) : null;
  const eurExtra = totalEurOnly(cur);

  view.innerHTML = `
    <div class="b-header" style="background:${color}">
      <div class="top">
        <button class="back" data-action="close-binders">← Back to scanner</button>
        <button class="pill" style="color:${color}" data-action="open-backup">${sync.link ? 'Backed up' : 'Back up'}</button>
      </div>
      <h1>Binders</h1>
      <div class="tabs">
        ${cols.map((c, i) => `<button data-action="binder" data-id="${esc(c.id)}" aria-pressed="${c.id === cur.id}"
            style="${c.id === cur.id ? `color:${BINDER_COLORS[i % BINDER_COLORS.length]}` : ''}">${esc(c.name)}</button>`).join('')}
        <button data-action="new-binder" aria-label="Add a binder">+ New</button>
      </div>
    </div>
    <div class="b-body">
      <div class="card-box">
        <div class="muted"><b>${esc(binderTitle(cur.name))} is worth</b></div>
        <div class="price">${usd(total(cur))}</div>
        ${eurExtra > 0 ? `<div class="up" style="font-size:16px">Plus ${eur(eurExtra)} in cards with only European prices</div>` : ''}
        <div style="font-size:17px">${n} card${n === 1 ? '' : 's'}, ${unique} different</div>
        ${top && top.price ? `<div>Top card: ${esc(top.name)}, ${usd(top.price)}</div>` : ''}
        ${cur.cards.length ? `
          <div class="row" style="margin-top:6px">
            <span class="grow small muted">TCGplayer market prices, updated ${timeAgo(oldest)}</span>
            ${app.refreshing ? '<div class="spinner"></div>' : '<button class="text-btn" data-action="refresh">Refresh prices</button>'}
          </div>
          ${app.refreshMsg ? `<div class="small down">${esc(app.refreshMsg)}</div>` : ''}` : ''}
        <div class="row small" style="margin-top:6px">
          <button class="text-btn small" data-action="rename-binder">Rename</button>
          ${cols.length > 1 ? '<button class="text-btn small danger" data-action="delete-binder">Delete binder</button>' : ''}
        </div>
      </div>

      ${!cur.cards.length ? `
        <div style="text-align:center;padding:32px 8px">
          <h2 class="display">${esc(binderTitle(cur.name))} is empty</h2>
          <p class="muted" style="font-size:17px">Scan a card, then tap "Add to ${esc(cur.name)}" on the result.</p>
        </div>` : `
        <div class="label">Sort by</div>
        <div class="chips">${[['value', 'Value'], ['rarity', 'Rarity'], ['newest', 'Newest'], ['name', 'Name']].map(([k, l]) =>
          `<button class="chip-btn" data-action="sort" data-sort="${k}" aria-pressed="${app.sort === k}">${l}</button>`).join('')}</div>
        <div class="label">Rarity</div>
        <div class="chips">
          <button class="chip-btn" data-action="rarity" data-r="" aria-pressed="${!app.rarity}">All ${n}</button>
          ${rarityChips.map(([r, c]) => `<button class="chip-btn" data-action="rarity" data-r="${esc(r)}" aria-pressed="${app.rarity === r}">${esc(r)} ${c}</button>`).join('')}
        </div>
        <div class="grid">${list.map(e => `
          <button class="cell" data-action="entry" data-key="${esc(e.key)}">
            <div class="pic">${e.imageSmall ? `<img src="${esc(e.imageSmall)}" alt="${esc(e.name)}" loading="lazy">` : ''}
              ${e.quantity > 1 ? `<span class="qty">×${e.quantity}</span>` : ''}</div>
            <div class="nm">${esc(e.name)}</div>
            <div class="pr">${priceText(e)}</div>
            ${priceChange(e)}
          </button>`).join('')}
        </div>`}
    </div>`;
}

function openBinders() {
  app.view = 'binders';
  camera.stop();
  $('#scan-view').hidden = true;
  $('#binders-view').hidden = false;
  renderBinders();
  maybeRefresh();
}

function closeBinders() {
  app.view = 'scan';
  $('#binders-view').hidden = true;
  $('#scan-view').hidden = false;
  renderDock();
  camera.start();
}

function maybeRefresh() {
  const cur = currentBinder();
  if (!cur.cards.length) return;
  const oldest = Math.min(...cur.cards.map(e => e.priceUpdatedAt || 0));
  if (Date.now() - oldest > PRICE_MAX_AGE) refreshPrices(cur.id);
}

async function refreshPrices(binderId) {
  if (app.refreshing) return;
  const c = store.collections.find(x => x.id === binderId);
  const pairs = [...new Set(c.cards.map(e => `${e.language || 'en'}|${e.cardId}`))].map(s => s.split('|'));
  if (!pairs.length) return;
  app.refreshing = true; app.refreshMsg = null; renderBinders();
  const fresh = new Map();
  let failed = 0;
  for (let i = 0; i < pairs.length; i += 6) {
    const res = await Promise.all(pairs.slice(i, i + 6).map(async ([lang, id]) => {
      try { return [`${lang}/${id}`, toCard(await fetchJSON(`${API}/${lang}/cards/${encodeURIComponent(id)}`), lang)]; }
      catch (e) { return [null, null]; }
    }));
    for (const [k, card] of res) { if (card) fresh.set(k, card); else failed++; }
  }
  store.applyPrices(fresh);
  app.refreshing = false;
  app.refreshMsg = failed ? `Couldn't update ${failed} card(s). Try again later.` : null;
  if (app.view === 'binders') renderBinders();
}

// ---------- modal sheets ----------
function openSheet(html) {
  const o = $('#overlay');
  o.innerHTML = `<div class="sheet" role="dialog" aria-modal="true"><div class="handle"></div>${html}</div>`;
  o.hidden = false;
}
function closeSheet() { $('#overlay').hidden = true; $('#overlay').innerHTML = ''; app.sheet = null; }

function openEntry(key) {
  const cur = currentBinder();
  const e = cur.cards.find(x => x.key === key);
  if (!e) return closeSheet();
  app.sheet = { type: 'entry', key };
  const useEur = e.price == null && e.priceEur != null;
  const langName = { ja: 'Japanese card', 'zh-tw': 'Chinese card (Traditional)', 'zh-cn': 'Chinese card (Simplified)' }[e.language];
  openSheet(`
    <div class="result-top">
      <div class="foil" style="width:140px">${e.imageLarge || e.imageSmall ? `<img src="${esc(e.imageLarge || e.imageSmall)}" alt="${esc(e.name)}">` : ''}</div>
      <div class="grow">
        <h2 class="display">${esc(e.name)}</h2>
        ${e.setName ? `<div><b>${esc(e.setName)}</b></div>` : ''}
        ${e.number ? `<div class="muted">Card ${esc(e.number)}${e.setTotal ? ` of ${e.setTotal}` : ''}</div>` : ''}
        ${e.variant ? `<div>${esc(e.variant)}</div>` : ''}
        ${langName ? `<div>${langName}</div>` : ''}
        ${e.rarity ? `<span class="badge">${esc(e.rarity)}</span>` : ''}
      </div>
    </div>
    <div class="tiles" style="margin-top:18px">
      <div class="tile"><span>Worth now</span><b>${useEur ? eur(e.priceEur) : usd(e.price)}</b></div>
      <div class="tile"><span>When added</span><b>${useEur ? eur(e.priceEurWhenAdded) : usd(e.priceWhenAdded)}</b></div>
    </div>
    <p class="small muted">Added ${new Date(e.addedAt).toLocaleDateString()}</p>
    <h3>How many are in ${esc(binderTitle(cur.name))}?</h3>
    <div class="stepper">
      <button data-action="qty" data-d="-1" aria-label="One less">−</button>
      <b>${e.quantity}</b>
      <button data-action="qty" data-d="1" aria-label="One more">+</button>
    </div>
    <button class="text-btn danger" style="margin-top:12px" data-action="remove">Remove from ${esc(binderTitle(cur.name))}</button>
    <button class="btn btn-outline btn-block" style="margin-top:8px" data-action="close-sheet">Done</button>`);
}

function backupStatus() {
  const s = sync.status;
  if (!sync.link) return 'Not connected yet.';
  if (s.syncing) return 'Saving to the sheet…';
  if (s.error) return `Last sync failed: ${esc(s.error)}`;
  return `Connected. Last saved to the sheet ${timeAgo(s.last)}.`;
}

function openBackup(note) {
  app.sheet = { type: 'backup' };
  if (!app.scriptText) fetch('apps-script.txt').then(r => r.text()).then(t => { app.scriptText = t; }).catch(() => {});
  const link = sync.link;
  openSheet(`
    <h2 class="display">Google Sheet backup</h2>
    <p class="muted">Keeps your binders in your own Google Sheet, so they survive a new phone or a cleared browser, and you can see them on any device.</p>
    <div class="tile" id="backup-status" style="${sync.status.error ? 'color:var(--error)' : ''}">${backupStatus()}</div>
    ${note ? `<p><b>${esc(note)}</b></p>` : ''}
    ${!link ? `
      <h3>One-time setup (about 10 minutes)</h3>
      <ol class="steps">
        <li><a href="https://sheets.new" target="_blank" rel="noopener">Create a new Google Sheet</a> and give it a name, like "Card binders".</li>
        <li>Open the sheet in a browser (on a phone, turn on <b>Desktop site</b>) and choose <b>Extensions › Apps Script</b>.</li>
        <li><button class="text-btn" data-action="copy-script" style="padding:0">Copy the script</button>, delete the sample code, paste, and tap Save.</li>
        <li><b>Deploy › New deployment</b>, gear › <b>Web app</b>. Execute as: <b>Me</b>. Who has access: <b>Anyone</b>. Tap Deploy and allow access ("unverified app" is expected for your own script: Advanced › Go to… › Allow).</li>
        <li>Copy the <b>Web app URL</b> (ends in <code>/exec</code>) and paste it below.</li>
      </ol>
      <form data-form="connect">
        <input class="field" name="link" placeholder="https://script.google.com/macros/s/…/exec" autocomplete="off">
        <button class="btn btn-primary btn-block" style="margin-top:12px" type="submit">Connect</button>
      </form>
      <p class="small muted">Setting up a second phone, or reinstalled? Paste the link from the <b>Setup</b> tab of your sheet instead.</p>` : `
      <div class="row" style="margin-top:14px">
        <button class="btn btn-primary grow" data-action="sync-now">Sync now</button>
        <button class="btn btn-outline grow" data-action="restore">Restore</button>
      </div>
      <button class="text-btn" data-action="copy-link">Copy sync link for another phone</button>
      <button class="text-btn danger" data-action="disconnect">Disconnect this phone</button>`}
    <button class="btn btn-outline btn-block" style="margin-top:8px" data-action="close-sheet">Close</button>`);
}

function refreshSyncUi() {
  const el = $('#backup-status');
  if (el) el.innerHTML = backupStatus();
  if (app.view === 'binders') {
    const pill = $('#binders-view [data-action="open-backup"]');
    if (pill) pill.textContent = sync.link ? 'Backed up' : 'Back up';
  }
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch (e) { return false; }
}

// ---------- events ----------
document.addEventListener('click', async ev => {
  const el = ev.target.closest('[data-action]');
  if (!el) {
    if (ev.target.id === 'overlay') closeSheet();   // tap outside a sheet
    return;
  }
  const a = el.dataset.action;
  const s = app.scan;

  if (a === 'start-camera') camera.start();
  else if (a === 'lang') {
    if (el.dataset.lang === app.lang) return;
    app.lang = el.dataset.lang;
    localStorage.setItem('lang', app.lang);
    renderLang();
    setScan({ state: 'scanning' });
    catalogs[app.lang].load().catch(() => {});
  }
  else if (a === 'rescan') setScan({ state: 'scanning' });
  else if (a === 'variant') { s.variantIdx = Number(el.dataset.i); renderDock(); }
  else if (a === 'pick') { s.selectedId = el.dataset.id; s.variantIdx = 0; renderDock(); }
  else if (a === 'add') {
    const card = s.cards.find(c => c.id === s.selectedId) || s.cards[0];
    const variant = card.prices[Math.min(s.variantIdx || 0, card.prices.length - 1)] || null;
    store.add(el.dataset.binder, card, variant);
    buzz();
    const b = store.collections.find(c => c.id === el.dataset.binder);
    toast(`Added to ${b ? b.name : 'binder'}`);
    renderDock();
  }
  else if (a === 'check-update') {
    toast('Checking for updates…');
    try { const reg = await navigator.serviceWorker.getRegistration(); if (reg) await reg.update(); } catch (e) { /* ignore */ }
    setTimeout(() => location.reload(), 600);
  }
  else if (a === 'open-binders') openBinders();
  else if (a === 'close-binders') closeBinders();
  else if (a === 'binder') { app.binderId = el.dataset.id; app.rarity = null; renderBinders(); maybeRefresh(); }
  else if (a === 'new-binder') {
    const name = (prompt('Name for the new binder (for example, a child\'s name):') || '').trim();
    if (name) { app.binderId = store.addBinder(name.slice(0, 24)).id; app.rarity = null; renderBinders(); }
  }
  else if (a === 'rename-binder') {
    const cur = currentBinder();
    const name = (prompt('Rename this binder:', cur.name) || '').trim();
    if (name) { cur.name = name.slice(0, 24); store.save(); renderBinders(); }
  }
  else if (a === 'delete-binder') {
    const cur = currentBinder();
    if (store.collections.length > 1 && confirm(`Delete "${cur.name}" and its ${count(cur)} cards? This can't be undone.`)) {
      store.lib.collections = store.collections.filter(c => c !== cur);
      store.save();
      app.binderId = null;
      renderBinders();
    }
  }
  else if (a === 'sort') { app.sort = el.dataset.sort; renderBinders(); }
  else if (a === 'rarity') { app.rarity = el.dataset.r || null; renderBinders(); }
  else if (a === 'refresh') refreshPrices(currentBinder().id);
  else if (a === 'entry') openEntry(el.dataset.key);
  else if (a === 'qty' || a === 'remove') {
    const cur = currentBinder();
    const e = cur.cards.find(x => x.key === app.sheet.key);
    if (!e) return closeSheet();
    const q = a === 'remove' ? 0 : e.quantity + Number(el.dataset.d);
    store.setQuantity(cur.id, e.key, q);
    renderBinders();
    if (q <= 0) closeSheet(); else openEntry(e.key);
  }
  else if (a === 'close-sheet') closeSheet();
  else if (a === 'open-backup') openBackup();
  else if (a === 'copy-script') {
    if (app.scriptText && await copyText(app.scriptText)) toast('Script copied. Paste it into Apps Script.');
    else window.open('apps-script.txt', '_blank');   // fallback: open it to copy by hand
  }
  else if (a === 'copy-link') {
    const l = sync.link;
    if (l && await copyText(`${l.url}?key=${l.key}`)) toast('Sync link copied. Keep it private.');
  }
  else if (a === 'sync-now') { await sync.push(); openBackup(sync.status.error ? null : 'Saved to the sheet.'); }
  else if (a === 'restore') {
    if (!confirm('Replace the binders on this phone with the ones saved in the Google Sheet?')) return;
    try {
      const ok = await sync.restore();
      app.binderId = null;
      renderBinders();
      openBackup(ok ? 'Restored the binders from the sheet.' : 'The sheet has no binders to restore yet.');
    } catch (e) { openBackup(e.message); }
  }
  else if (a === 'disconnect') {
    if (confirm('Stop backing up this phone? The sheet keeps its copy.')) { sync.link = null; openBackup('Disconnected.'); renderBinders(); }
  }
});

document.addEventListener('submit', async ev => {
  const form = ev.target.closest('[data-form]');
  if (!form) return;
  ev.preventDefault();
  if (form.dataset.form === 'search') {
    const q = form.q.value.trim();
    if (!q) return;
    form.q.blur();
    const p = parseQuery(q);
    if (!p.name && !p.number) return;
    try {
      const cat = await catalogs[app.lang].load();
      if (p.name) p.name = cat.resolveName(p.name) || p.name;   // "pickachu" -> "Pikachu"
    } catch (e) { /* search() reports it */ }
    search(p, true);
  } else if (form.dataset.form === 'connect') {
    const btn = form.querySelector('button');
    btn.disabled = true; btn.textContent = 'Connecting…';
    try {
      const note = await sync.connect(form.link.value);
      app.binderId = null;
      renderBinders();
      openBackup(note);
    } catch (e) {
      openBackup(e.message);
    }
  }
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && app.view === 'scan' && !camera.on) camera.start();
});

// ---------- start ----------
store.init();
renderLang();
renderDock();
camera.start();
catalogs[app.lang].load().catch(() => {});
scanLoop();
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
