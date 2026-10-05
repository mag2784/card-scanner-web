'use strict';
/* Card Scanner (web): camera + OCR, results, binders and Google Sheet backup. Uses logic.js. */

const APP_VERSION = '2.0';
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

async function fetchTimeout(url, ms = 8000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res;
  } finally { clearTimeout(timer); }
}

// ---------- euro → dollar rate (for cards that only have a Cardmarket price) ----------
const fx = {
  rate: null, at: 0,
  init() {
    try {
      const saved = JSON.parse(localStorage.getItem('fx') || 'null');
      if (saved && saved.rate > 0) { this.rate = saved.rate; this.at = saved.at || 0; }
    } catch (e) { /* no saved rate */ }
    if (Date.now() - this.at > 12 * 3600 * 1000) this.refresh();
  },
  async refresh() {
    const sources = [
      'https://api.frankfurter.dev/v1/latest?base=EUR&symbols=USD',
      'https://api.frankfurter.app/latest?from=EUR&to=USD',
      'https://open.er-api.com/v6/latest/EUR',
    ];
    for (const url of sources) {
      try {
        const data = await (await fetchTimeout(url, 6000)).json();
        const rate = Number(data && data.rates && data.rates.USD);
        if (rate > 0.5 && rate < 2.5) {
          this.rate = rate; this.at = Date.now();
          localStorage.setItem('fx', JSON.stringify({ rate, at: this.at }));
          if (app.view === 'binders') renderBinders();
          else if (app.scan.state === 'results') renderDock();
          return;
        }
      } catch (e) { /* try the next source */ }
    }
  },
};

// ---------- backup price sources ----------
// Used only when TCGdex has no TCGplayer price for an English card. Each source is optional:
// if one is down or blocked, it is skipped for a few minutes and the next one is tried.
const backup = { failedAt: {}, groups: null, groupData: new Map() };

function tcgcsvGroups() {
  if (!backup.groups) {
    backup.groups = fetchTimeout(`${TCGCSV}/3/groups`, 12000).then(r => r.json()).then(j => j.results || [])
      .catch(e => { backup.groups = null; throw e; });
  }
  return backup.groups;
}

function tcgcsvGroupData(groupId) {
  if (!backup.groupData.has(groupId)) {
    const get = what => fetchTimeout(`${TCGCSV}/3/${groupId}/${what}`, 25000).then(r => r.json()).then(j => j.results || []);
    backup.groupData.set(groupId, Promise.all([get('products'), get('prices')])
      .then(([products, prices]) => ({ products, prices }))
      .catch(e => { backup.groupData.delete(groupId); throw e; }));
  }
  return backup.groupData.get(groupId);
}

/** Plain-words reason for a failed request, for the "Checked for a US price" line. */
function errText(e) {
  if (!e) return 'unknown error';
  if (e.name === 'AbortError') return 'timed out';
  if (e.name === 'TypeError') return 'the browser was not allowed to read it, or the network is down';
  return e.message || String(e);
}

async function tcgcsvPrice(card) {
  if (!card.number || !card.setName) return { prices: null, note: 'not enough to look up (no set name or number)' };
  const groups = pickGroups(await tcgcsvGroups(), card.setName, card.setId);
  if (!groups.length) return { prices: null, note: `no set called "${card.setName}"` };
  for (const g of groups.slice(0, 2)) {
    const data = await tcgcsvGroupData(g.groupId);
    const product = pickProduct(data.products, card);
    if (!product) continue;
    const prices = pricesForProduct(data.prices, product.productId);
    if (prices.length) return { prices, note: null };
    return { prices: null, note: `found the card (product ${product.productId}) but it has no price yet` };
  }
  return { prices: null, note: `found the set (${groups.map(g => g.name).join(', ')}) but not ${card.name} #${card.number} in it` };
}

async function ptcgPrice(card) {
  if (!card.number) return { prices: null, note: 'no card number to look up' };
  const url = `${PTCG}/cards?q=${encodeURIComponent(ptcgQuery(card))}&select=name,number,set,tcgplayer&pageSize=6`;
  const list = (await (await fetchTimeout(url, 9000)).json()).data || [];
  const hit = list.find(c => c.tcgplayer && nameScore(c.name, [card.name]) >= 0.9);
  return hit ? { prices: ptcgPrices(hit.tcgplayer), note: null } : { prices: null, note: 'no matching card' };
}

/**
 * Looks for a dollar price outside TCGdex. Always returns { prices, source, notes }: prices is null when nothing was
 * found, and notes says what each source answered, so the screen can show why.
 */
async function backupPrice(card) {
  const tries = [['TCGplayer copy', 'TCGplayer (via tcgcsv.com)', tcgcsvPrice], ['pokemontcg.io', 'pokemontcg.io', ptcgPrice]];
  const notes = [];
  for (const [label, name, fn] of tries) {
    if (Date.now() - (backup.failedAt[name] || 0) < 5 * 60 * 1000) { notes.push(`${label}: skipped, it failed a moment ago`); continue; }
    try {
      const r = await fn(card);
      if (r && r.prices && r.prices.length) return { prices: r.prices, source: name, notes };
      notes.push(`${label}: ${(r && r.note) || 'no match'}`);
    } catch (e) {
      backup.failedAt[name] = Date.now();
      notes.push(`${label}: couldn't connect (${errText(e)})`);
    }
  }
  return { prices: null, source: null, notes };
}

/** On the results screen: fill in a missing price in the background, then redraw. */
function kickBackup(card) {
  if (!card || card.lang !== 'en' || card.prices.length) return;
  if (card.priceState === 'pending' || (card.priceCheckedAt && Date.now() - card.priceCheckedAt < 30 * 60 * 1000)) return;
  card.priceState = 'pending';
  backupPrice(card)
    .then(found => { if (found.prices) { card.prices = found.prices; card.priceSource = found.source; } else card.priceNotes = found.notes; })
    .catch(() => {})
    .finally(() => {
      card.priceState = 'done';
      card.priceCheckedAt = Date.now();
      if (app.view === 'scan' && app.scan.state === 'results' && app.scan.selectedId === card.id) renderDock();
      if (app.detail && app.detail.card === card) renderDetails();
    });
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

/** Pokémon names in English / Japanese / Chinese (species.json), loaded once in the background. */
const species = {
  api: null, promise: null,
  load() {
    if (!this.promise) {
      this.promise = fetch('species.json').then(r => r.json()).then(rows => {
        this.api = makeSpecies(rows);
        if (app.view === 'scan' && app.scan.state === 'results') renderDock();
        return this.api;
      }).catch(() => { this.promise = null; return null; });
    }
    return this.promise;
  },
  english(name) { return this.api ? this.api.englishFor(name) : null; },
};

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
/** This phone's id, so two phones sharing a sheet each keep their own count of every card. */
function deviceId() {
  let d = localStorage.getItem('deviceId');
  if (!d) { d = 'p' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36); localStorage.setItem('deviceId', d); }
  return d;
}

const store = {
  lib: null,
  init() {
    try { this.lib = JSON.parse(localStorage.getItem('library') || 'null'); } catch (e) { this.lib = null; }
    if (!this.lib || !Array.isArray(this.lib.collections) || !this.lib.collections.length) {
      this.lib = { collections: [{ id: uid(), name: 'My binder', cards: [] }] };
      this.save(false);
    }
    this.lib.collections.forEach(c => { c.cards = c.cards || []; c.dead = c.dead || []; });
    this.lib.gone = this.lib.gone || {};
  },
  get collections() { return this.lib.collections; },
  save(push = true) {
    try { localStorage.setItem('library', JSON.stringify(this.lib)); } catch (e) { toast("Couldn't save on this phone."); }
    if (push) sync.schedule();
  },
  /** Use this library as the phone's own (restoring from the sheet, or the result of a merge). */
  replaceLib(lib) {
    this.lib = { collections: (lib.collections || []).map(c => ({ ...c, cards: c.cards || [], dead: c.dead || [] })), gone: lib.gone || {} };
    if (!this.lib.collections.length) this.lib.collections.push({ id: uid(), name: 'My binder', cards: [], dead: [] });
    this.save(false);
  },
  add(binderId, card, variant) {
    const c = this.collections.find(x => x.id === binderId);
    if (!c) return;
    const key = `${card.id}|${variant ? variant.label : ''}`;
    let existing = c.cards.find(e => e.key === key);
    const now = Date.now();
    if (!existing) {                                   // removed earlier? bring it back, with its history
      const i = (c.dead || []).findIndex(e => e.key === key);
      if (i >= 0) { existing = c.dead.splice(i, 1)[0]; c.cards.push(existing); }
    }
    if (existing) bumpQty(existing, 1, deviceId(), now);
    else {
      const real = variant && variant.market != null ? variant.market : marketPrice(card, null);
      const price = real ?? card.manualPrice ?? null;
      c.cards.push({
        key, cardId: card.id, name: card.name, setName: card.setName, number: card.number,
        setTotal: card.setTotal, rarity: card.rarity, imageSmall: card.imageSmall, imageLarge: card.imageLarge,
        group: card.group || null, kind: card.kind || null,
        variant: variant ? variant.label : null, quantity: 1, qd: { [deviceId()]: [1, now] }, addedAt: now,
        priceWhenAdded: price, price, priceUpdatedAt: now,
        ...(real == null && card.manualPrice != null ? { priceManual: true } : {}),
        language: card.lang, priceEur: eurPrice(card), priceEurWhenAdded: eurPrice(card),
      });
    }
    this.save();
  },
  setQuantity(binderId, key, qty) {
    const c = this.collections.find(x => x.id === binderId);
    if (!c) return;
    const i = c.cards.findIndex(e => e.key === key);
    if (i < 0) return;
    const e = c.cards[i], q = Math.max(0, qty);
    bumpQty(e, q - e.quantity, deviceId(), Date.now());
    if (q <= 0) { c.cards.splice(i, 1); (c.dead = c.dead || []).push(e); }      // kept, so the removal also reaches the other phone
    this.save();
  },
  applyPrices(fresh) {
    if (!fresh.size) return;
    const now = Date.now();
    for (const c of this.collections) for (const e of c.cards) {
      const card = fresh.get(`${e.language || 'en'}/${e.cardId}`);
      if (!card) continue;
      const real = marketPrice(card, e.variant);
      if (real != null) {
        // A real price replaces one the user typed in; restart the "change since added" from it
        if (e.priceManual || e.priceWhenAdded == null) e.priceWhenAdded = real;
        e.price = real;
        delete e.priceManual;
      }
      const eurNow = eurPrice(card);
      if (eurNow != null) {
        e.priceEur = eurNow;
        if (e.priceEurWhenAdded == null) e.priceEurWhenAdded = eurNow;
      }
      e.rarity = card.rarity || e.rarity;
      e.group = card.group || e.group || null;
      e.kind = card.kind || e.kind || null;
      e.cm = { trend: card.cmTrend, avg1: card.cmAvg1, avg7: card.cmAvg7, avg30: card.cmAvg30 };
      e.priceUpdatedAt = now;
    }
    this.recordHistory(now);
    this.save();
  },

  /** One price point per card and per binder per day, so trends can be drawn. Also refreshes the Cardmarket-based estimates. */
  recordHistory(now = Date.now()) {
    for (const c of this.collections) {
      for (const e of c.cards) {
        if (!(e.hist && e.hist.length) && e.priceWhenAdded != null) e.hist = [[e.addedAt || now, e.priceWhenAdded]];
        const v = unitValue(e, fx.rate);
        e.hist = pushPoint(e.hist, now, v);
        if (e.cm) e.est = cmEstimate(now, v, e.cm);
      }
      c.hist = pushPoint(c.hist, now, total(c));
    }
  },
  addBinder(name) {
    const c = { id: uid(), name, cards: [], dead: [] };
    this.collections.push(c);
    this.save();
    return c;
  },
  renameBinder(id, name) {
    const c = this.collections.find(x => x.id === id);
    if (c) { c.name = name; c.nameT = Date.now(); this.save(); }
  },
  deleteBinder(id) {
    this.lib.collections = this.collections.filter(c => c.id !== id);
    this.lib.gone[id] = Date.now();                    // remembered, so the other phone doesn't bring it back
    this.save();
  },
};

/** "Harper" -> "Harper's binder"; "My binder" stays "My binder". */
const binderTitle = name => (/binder$/i.test(name) ? name : `${name}'s binder`);

/** Dollar value of a binder entry: the US price, or the euro price converted at today's rate. */
const isConverted = e => e.price == null && e.priceEur != null && !!fx.rate;
const usdOf = e => (e.price != null ? e.price : isConverted(e) ? e.priceEur * fx.rate : null);
const total = c => c.cards.reduce((s, e) => s + (usdOf(e) || 0) * e.quantity, 0);
/** How much of a binder's total came from converted euro prices. */
const convertedPart = c => c.cards.filter(isConverted).reduce(
  (a, e) => ({ usd: a.usd + e.priceEur * fx.rate * e.quantity, eur: a.eur + e.priceEur * e.quantity }), { usd: 0, eur: 0 });
const totalEurNoRate = c => c.cards.filter(e => e.price == null && e.priceEur != null && !fx.rate)
  .reduce((s, e) => s + e.priceEur * e.quantity, 0);
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
    this.timer = setTimeout(() => this.sync(), 2000);
  },
  /** Syncs when the app opens, when it comes back to the front, and every few minutes while it is open. */
  start() {
    if (this.started || !this.link) return;
    this.started = true;
    this.sync();
    setInterval(() => { if (!document.hidden) this.sync(); }, 3 * 60 * 1000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden && Date.now() - (this.status.last || 0) > 30 * 1000) this.sync(); });
  },
  markSynced() {
    this.status.last = Date.now();
    this.status.error = null;
    localStorage.setItem('syncLast', String(this.status.last));
  },
  /**
   * Two-way sync: read the sheet, merge it with this phone's binders (nothing is lost on either side), keep the result here,
   * and save it back if the sheet was missing anything. Several phones can do this at once; each converges on the same binders.
   */
  async sync() {
    const link = this.link;
    if (!link) return;
    if (this.busy) { this.again = true; return; }
    this.busy = true; this.status.syncing = true; this.status.error = null; refreshSyncUi();
    try {
      const remote = await this.call(link, { action: 'load' });
      const rl = remote.library || {};
      const merged = mergeLibraries(store.lib, rl, deviceId(), Date.now());
      if (stableStringify(merged) !== stableStringify(store.lib)) { store.replaceLib(merged); refreshAfterSync(); }
      if (stableStringify({ collections: rl.collections || [], gone: rl.gone || {} }) !== stableStringify(merged)) {
        await this.call(link, { action: 'save', library: merged });
      }
      this.markSynced();
    } catch (e) {
      this.status.error = e.message || 'Sync failed. It will retry on the next change.';
    } finally {
      this.busy = false; this.status.syncing = false; refreshSyncUi();
      if (this.again) { this.again = false; this.schedule(); }
    }
  },
  push() { return this.sync(); },
  async connect(raw) {
    const link = this.parse(raw);
    if (!link) throw new Error('That doesn\'t look like the script link. It starts with https://script.google.com/');
    const remote = await this.call(link, { action: 'load' });
    this.link = link;
    const rl = remote.library || {};
    const sheetCols = rl.collections || [];
    const sheetCards = sheetCols.reduce((s, c) => s + (c.cards || []).reduce((a, e) => a + (e.quantity || 0), 0), 0);
    const phoneCards = store.collections.reduce((s, c) => s + count(c), 0);
    this.started = false;
    if (phoneCards === 0 && sheetCards > 0) {                  // a new phone: take the sheet's binders
      store.replaceLib(rl); this.markSynced(); refreshAfterSync(); this.start();
      return `Connected and loaded ${sheetCards} cards from the sheet.`;
    }
    await this.sync(); this.start();
    if (this.status.error) throw new Error(this.status.error);
    return sheetCards === 0 ? 'Connected! Your binders were saved to the sheet.'
      : 'Connected. This phone\'s binders and the sheet\'s were combined, and they stay in step from now on.';
  },
  async restore() {
    const link = this.link;
    if (!link) return false;
    const remote = await this.call(link, { action: 'load' });
    const rl = remote.library || {};
    if (!(rl.collections || []).length) return false;
    store.replaceLib(rl); this.markSynced();
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
  bookOpened: false,   // has the binder cover been opened this visit
  bookPage: 1,         // which page the binder is showing
  bookFade: false,     // fade the binder in (after switching binder or sorting)
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
  if (chosen) return showCandidates(found.cards, chosen, found.setMatched, numberText, { name: chosen.name, number, total });
  if (votes.framesLocked <= 2) return;   // give the name a moment
  if (usable) return showCandidates(found.cards, null, false, numberText, { name: strong || null, number, total });
  if (strong) return search({ name: strong, number, total });
  if (app.lang !== 'en') return search({ name: null, number, total });
  resetVotes();
  setScan({ state: 'notfound', label: numberText, read: { name: strong || null, number, total } });
}

async function runLookup(label, fn, read) {
  setScan({ state: 'searching', label });
  try {
    const r = await fn();
    if (read && r) r.read = read;
    setScan(r);
  } catch (e) {
    setScan({ state: 'error', message: e.message || 'Something went wrong. Try again.' });
  }
}

/**
 * Japanese / Chinese cards the database doesn't have (many Simplified Chinese sets are empty there): offer the card
 * as we can identify it, so it can still be added to a binder.
 */
function identifiedResults(cat, p, existing) {
  const lang = app.lang === 'ja' ? 'ja' : 'zh-cn';
  const total = /^\d+$/.test(p.total || '') ? parseInt(p.total, 10) : null;
  const card = identifiedCard(lang, p.name, p.number, p.total, total ? cat.setsOfSize(total) : []);
  const cards = [...existing, card];
  return { state: 'results', cards, selectedId: cards[0].id, exact: false, variantIdx: 0 };
}

/** Search by English name in Japanese / Chinese mode: "Dragonair" finds the ハクリュー / 哈克龙 cards. */
function searchLocal(hit, p) {
  const label = [hit.english, p.number ? (p.total ? `#${p.number}/${p.total}` : `#${p.number}`) : null].filter(Boolean).join(' ');
  return runLookup(label, async () => {
    const cat = await catalogs[app.lang].load();
    let briefs = cat.cardsNamed(hit.locals);
    if (p.number) {
      const byNum = briefs.filter(b => b.localId && normalizeNumber(b.localId) === p.number);
      if (byNum.length) briefs = byNum;
    }
    const cards = briefs.length ? await cardDetails(briefs.slice().reverse().slice(0, 8)) : [];
    return identifiedResults(cat, { name: hit.locals[0], number: p.number, total: p.total }, cards);
  }, { name: hit.english, number: p.number || null, total: p.total || null });
}

function search(p, typed = false) {
  const label = [p.name, p.number ? (p.total ? `#${p.number}/${p.total}` : `#${p.number}`) : null].filter(Boolean).join(' ');
  return runLookup(label, async () => {
    const cat = await catalogs[app.lang].load();
    const { briefs, exact } = pickTier(cat, p, typed);
    const other = app.lang !== 'en' && (p.name || p.number);          // Japanese / Chinese
    if (!briefs.length) return other ? identifiedResults(cat, p, []) : { state: 'notfound', label };
    let cards = await cardDetails(briefs.slice().reverse().slice(0, 8));   // newest first
    const t = /^\d+$/.test(p.total || '') ? parseInt(p.total, 10) : null;
    if (t != null) cards = cards.slice().sort((a, b) => (b.setTotal === t) - (a.setTotal === t));
    if (!cards.length) return other ? identifiedResults(cat, p, []) : { state: 'notfound', label };
    if (other && !exact) return identifiedResults(cat, p, cards);       // add "not listed" as the last choice
    return { state: 'results', cards, selectedId: cards[0].id, exact, variantIdx: 0 };
  }, { name: p.name || null, number: p.number || null, total: p.total || null });
}

function showCandidates(cands, chosen, exact, label, read) {
  return runLookup(chosen ? chosen.name : label, async () => {
    const others = cands.filter(c => c !== chosen).reverse();
    const cards = await cardDetails([...(chosen ? [chosen] : []), ...others].slice(0, 8));
    if (!cards.length) return { state: 'notfound', label };
    return { state: 'results', cards, selectedId: cards[0].id, exact: exact && !!chosen, variantIdx: 0 };
  }, read);
}

async function scanLoop() {
  for (;;) {
    if (!camera.on || app.view !== 'scan' || app.scan.state !== 'scanning' || document.hidden || typeof Tesseract === 'undefined' || Bulk.active()) {
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
  if (s.state === 'results') kickBackup(s.cards.find(c => c.id === s.selectedId));
  renderDock();
}

function renderLang() {
  $('#lang-switch').innerHTML = Object.entries(LANGS).map(([k, l]) =>
    `<button data-action="lang" data-lang="${k}" aria-pressed="${k === app.lang}">${esc(l.label)}</button>`).join('');
}

/** "Wrong name or number? Edit and search again" */
function editReadHtml() {
  const s = app.scan, r = s.read || { name: null, number: null, total: null };
  if (!s.editing) return '<button class="text-btn" data-action="edit-read" style="margin-top:6px">Wrong name or number? Edit and search again</button>';
  return `<form class="edit-read" data-form="edit-read" autocomplete="off">
    <label class="small muted">Name<input class="field" name="cardname" value="${esc(r.name || '')}" placeholder="${app.lang === 'en' ? 'for example Pikachu' : 'English name, for example Dragonair'}"></label>
    <div class="row" style="margin-top:8px;align-items:flex-end">
      <label class="small muted grow">Card number<input class="field" name="cardnumber" value="${esc(r.number || '')}" placeholder="28"></label>
      <span class="muted" style="padding-bottom:14px">of</span>
      <label class="small muted grow">Set size<input class="field" name="cardtotal" value="${esc(r.total || '')}" placeholder="131"></label>
    </div>
    <div class="row" style="margin-top:12px"><button class="btn btn-primary grow" type="submit">Search again</button><button class="btn btn-outline" type="button" data-action="edit-read-cancel">Cancel</button></div>
  </form>`;
}

/** Typed search / edited read: English names work in Japanese and Chinese mode, and typos are fixed to real card names. */
async function runTypedSearch(p) {
  if (!p.name && !p.number) return;
  if (app.lang !== 'en' && p.name && !hasCjk(p.name)) {
    const api = await species.load();
    const hit = api && api.localNamesFor(p.name, app.lang);
    if (hit) return searchLocal(hit, p);
  }
  try {
    const cat = await catalogs[app.lang].load();
    if (p.name) p.name = cat.resolveName(p.name) || p.name;   // "pickachu" -> "Pikachu"
  } catch (e) { /* search() reports it */ }
  search(p, true);
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
        <input class="field grow" name="q" placeholder="${app.lang === 'en' ? 'Name and number, e.g. Pikachu 28/131' : 'English name or number, e.g. Dragonair 91/129'}" autocomplete="off" enterkeyhint="search">
        <button class="btn btn-primary" type="submit">Search</button>
      </form>
      <button class="btn btn-outline btn-block" style="margin-top:10px" data-action="bulk-pick"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:-4px;margin-right:8px"><rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-8 8"/></svg>Upload photos of cards</button>
      <div class="row small muted" style="margin-top:10px">
        <span class="grow">Version ${APP_VERSION}</span>
        <button class="text-btn small" data-action="check-update">Check for updates</button>
      </div>`;
  } else if (s.state === 'searching') {
    dock.innerHTML = `<div class="row"><div class="spinner"></div><div><b>Looking it up</b><div class="muted">${esc(s.label)}</div></div></div>`;
  } else if (s.state === 'notfound' || s.state === 'error') {
    const body = s.state === 'notfound'
      ? `Couldn't find "${esc(s.label)}". The set may be too new for the database, or try typing the name.${app.lang !== 'en' ? ' For Japanese and Chinese cards, type the English name, like Dragonair, or the number at the bottom, like 91/129.' : ''}`
      : esc(s.message);
    dock.innerHTML = `
      <h2 class="display">${s.state === 'notfound' ? 'No match yet' : 'Lookup hiccup'}</h2>
      <p style="font-size:17px">${body}</p>
      ${s.state === 'notfound' ? editReadHtml() : ''}
      <button class="btn btn-primary btn-block" style="margin-top:12px" data-action="rescan">${s.state === 'notfound' ? 'Scan again' : 'Try again'}</button>`;
  } else if (s.state === 'results') {
    dock.innerHTML = resultHtml();
  }
}

/** The price area of a result: real prices, a spinner, an estimate from euros, the user's own price, or nothing. */
function notesHtml(card) {
  return card.priceNotes && card.priceNotes.length && !card.prices.length
    ? `<p class="small muted" style="margin:8px 0 0">Checked for a US price: ${card.priceNotes.map(esc).join('; ')}.</p>` : '';
}

function priceHtml(card, prices, vIdx, variant) {
  if (variant) {
    return `
      ${prices.length > 1 ? `<div class="chips" style="margin-top:18px">${prices.map((p, i) =>
        `<button class="chip-btn" data-action="variant" data-i="${i}" aria-pressed="${i === vIdx}">${esc(p.label)}</button>`).join('')}</div>` : ''}
      <div class="price-label">${prices.length === 1 ? esc(variant.label) + ' market price' : 'Market price'}</div>
      <div class="price">${usd(variant.market)}</div>
      <div class="tiles">
        <div class="tile"><span>Lowest listing</span><b>${usd(variant.low)}</b></div>
        <div class="tile"><span>Highest listing</span><b>${usd(variant.high)}</b></div>
      </div>`;
  }
  if (card.priceState === 'pending') {
    return `<div class="tile" style="margin-top:18px;display:flex;gap:12px;align-items:center"><div class="spinner"></div><span>Checking other sources for a dollar price…</span></div>`;
  }
  const euros = eurPrice(card);
  if (card.manualPrice != null) {
    return `
      <div class="price-label">Your price</div>
      <div class="price">${usd(card.manualPrice)}</div>
      <p class="small muted" style="margin:4px 0 0">You entered this. It's used until a price site has one.</p>
      <button class="text-btn" data-action="manual-price">Change my price</button>`;
  }
  if (euros != null && fx.rate) {
    return `
      <div class="price-label">Estimated price</div>
      <div class="price">≈ ${usd(euros * fx.rate)}</div>
      <p class="small muted" style="margin:4px 0 0">Converted from ${eur(euros)} (Cardmarket, Europe). No US price was found.</p>
      ${notesHtml(card)}
      <button class="text-btn" data-action="manual-price">Enter a price yourself</button>`;
  }
  if (euros != null) {
    return `
      <div class="price-label">Cardmarket price (Europe)</div>
      <div class="price">${eur(euros)}</div>
      ${notesHtml(card)}
      <button class="text-btn" data-action="manual-price">Enter a US price yourself</button>`;
  }
  return `
    <div class="tile" style="margin-top:18px">${card.lang !== 'en'
      ? "No price found. Japanese and Chinese cards often aren't tracked by the price sites."
      : "No price found. Very new cards sometimes aren't in the price feeds yet, but TCGplayer may have one."}</div>
    ${notesHtml(card)}
    <button class="btn btn-outline btn-block" style="margin-top:10px" data-action="manual-price">Enter price yourself</button>`;
}

function resultHtml() {
  const s = app.scan;
  const card = s.cards.find(c => c.id === s.selectedId) || s.cards[0];
  const prices = card.prices;
  const vIdx = Math.min(s.variantIdx || 0, Math.max(0, prices.length - 1));
  const variant = prices[vIdx] || null;
  const numberText = card.number ? `Card ${esc(card.number)}${card.setTotal ? ` of ${card.setTotal}` : ''}` : '';

  const price = priceHtml(card, prices, vIdx, variant);
  const cmParts = [card.cmTrend != null && `${eur(card.cmTrend)} trend`, card.cmAvg30 != null && `${eur(card.cmAvg30)} 30-day average`,
    card.cmTrendHolo != null && `${eur(card.cmTrendHolo)} holo trend`].filter(Boolean);

  const owned = store.collections.map(c => {
    const n = c.cards.filter(e => e.cardId === card.id).reduce((a, e) => a + e.quantity, 0);
    return n ? `${esc(c.name)} has ${n}` : null;
  }).filter(Boolean);
  const en = card.lang !== 'en' ? species.english(card.name) : null;
  const q = encodeURIComponent([en || card.name, card.number].filter(Boolean).join(' '));
  const notice = card.identified
    ? "This card isn't in the card database yet, so there's no picture or price. You can still add it to a binder and type in a price yourself."
    : s.exact ? '' : "Couldn't confirm the exact printing. Pick yours from the row below.";

  return `
    <div class="handle"></div>
    ${notice ? `<div class="notice">${esc(notice)}</div>` : ''}
    <div class="result-top">
      <div class="foil" data-key="${esc(card.id)}">${card.imageLarge ? `<img src="${esc(card.imageLarge)}" alt="${esc(card.name)}">` : `<div class="noimg">${esc(card.name)}</div>`}</div>
      <div class="grow">
        <h2 class="display">${esc(card.name)}</h2>
        ${en ? `<div class="muted">English: <b>${esc(en)}</b></div>` : ''}
        ${card.setName ? `<div><b>${esc(card.setName)}</b></div>` : (card.setNames && card.setNames.length > 1 ? `<div class="muted">One of the ${card.setTotal}-card sets: ${esc(card.setNames.join(' or '))}</div>` : '')}
        ${numberText ? `<div class="muted">${numberText}</div>` : ''}
        ${card.rarity ? `<span class="badge">${esc(card.rarity)}</span>` : ''}${card.kind ? `<span class="badge alt">${esc(card.kind)}</span>` : ''}
      </div>
    </div>
    ${editReadHtml()}
    ${price}
    ${cmParts.length ? `<p style="margin:12px 0 0">Cardmarket (Europe): ${cmParts.join(', ')}</p>` : ''}
    ${card.priceSource ? `<p class="small muted" style="margin:4px 0 0">Price from ${esc(card.priceSource)}. TCGdex had none for this card.</p>`
      : card.tcgUpdated ? `<p class="small muted" style="margin:4px 0 0">TCGplayer prices from ${esc(card.tcgUpdated)}</p>` : ''}

    ${s.cards.length > 1 ? `
      <h3>${s.exact ? 'Other possible matches' : 'Which one is yours?'}</h3>
      <div class="thumbs">${s.cards.map(c => `
        <button data-action="pick" data-id="${esc(c.id)}" aria-pressed="${c.id === card.id}" aria-label="${esc(c.name)}">
          ${c.imageSmall ? `<img src="${esc(c.imageSmall)}" alt="" loading="lazy">` : `<span class="thumb-add">${c.identified ? 'Not listed' : esc(c.name)}</span>`}</button>`).join('')}
      </div>` : ''}

    <h3>Add to a binder</h3>
    ${prices.length > 1 && variant ? `<div class="small muted">Adds the ${esc(variant.label)} version. Pick a different one with the buttons above.</div>` : ''}
    <div class="add-row">${store.collections.map((c, i) =>
      `<button class="btn" style="background:${BINDER_COLORS[i % BINDER_COLORS.length]}" data-action="add" data-binder="${esc(c.id)}">${Celebrate.avatar(Celebrate.whoIs(c.name)) ? `<img class="av" src="${Celebrate.avatar(Celebrate.whoIs(c.name))}" alt="">` : ''}Add to ${esc(c.name)}</button>`).join('')}
    </div>
    ${owned.length ? `<p style="margin:8px 0 0"><b>${owned.join(' and ')} of this card.</b></p>` : ''}

    <div class="row" style="margin-top:22px">
      <a class="btn btn-outline grow" target="_blank" rel="noopener" href="https://www.tcgplayer.com/search/pokemon/product?q=${q}">${!prices.length && card.manualPrice == null ? 'See price on TCGplayer' : 'TCGplayer'}</a>
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

function priceText(e) {
  if (e.price != null) return usd(e.price);
  if (isConverted(e)) return '≈ ' + usd(e.priceEur * fx.rate);
  if (e.priceEur != null) return eur(e.priceEur);
  return 'No price';
}

/** The change since the card was added, in the same currency the price is shown in. */
function priceDelta(e) {
  let now, then, f = usd, tilde = '';
  if (e.price != null) { now = e.price; then = e.priceWhenAdded; }
  else if (isConverted(e)) {
    now = e.priceEur * fx.rate;
    then = e.priceEurWhenAdded != null ? e.priceEurWhenAdded * fx.rate : null;
    tilde = '≈ ';
  } else { now = e.priceEur; then = e.priceEurWhenAdded; f = eur; }
  if (now == null || then == null) return null;
  const d = now - then;
  if (Math.abs(d) < 0.01) return null;
  return { up: d > 0, text: `${d > 0 ? '▲' : '▼'} ${tilde}${f(Math.abs(d))} since added` };
}

const hexToRgb = h => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const darken = (h, k = .8) => '#' + hexToRgb(h).map(v => Math.round(v * k).toString(16).padStart(2, '0')).join('');

/** What opens when you tap a card in the binder: the information under the floating card. */
function entrySheetHTML(e) {
  const cur = currentBinder();
  const langName = { ja: 'Japanese card', 'zh-tw': 'Chinese card (Traditional)', 'zh-cn': 'Chinese card (Simplified)' }[e.language];
  const delta = priceDelta(e);
  const where = [e.setName, e.number ? `card ${e.number}${e.setTotal ? ' of ' + e.setTotal : ''}` : null].filter(Boolean).join(', ');
  const more = [e.variant, langName, 'Added ' + new Date(e.addedAt).toLocaleDateString()].filter(Boolean).join(', ');
  return `<div class="bk-grab"></div>
    <h2>${esc(e.name)}</h2>
    ${e.language && e.language !== 'en' && species.english(e.name) ? `<p class="bk-sub" style="margin:2px 0 0">English: ${esc(species.english(e.name))}</p>` : ''}
    <div class="bk-meta-row"><span class="bk-badge" style="${BinderUI.badgeStyle(e.rarity)}">${esc(e.rarity || 'Rarity unknown')}</span>${where ? `<span class="bk-sub">${esc(where)}</span>` : ''}</div>
    <div class="bk-price-row"><span class="bk-big">${esc(priceText(e))}</span>${delta ? `<span class="${delta.up ? 'bk-up' : 'bk-down'}">${delta.text}</span>` : ''}</div>
    <p class="bk-sub">${esc(more)}</p>
    ${e.priceManual ? '<p class="bk-sub" style="margin-top:6px">This is a price you entered. It is replaced automatically once a price site has one.</p>' : ''}
    ${e.price == null || e.priceManual ? `<button class="bk-link" type="button" data-bk="price">${e.priceManual ? 'Change my price' : 'Enter a price yourself'}</button>` : ''}
    <div class="bk-qty-row"><span>In ${esc(binderTitle(cur.name))}</span>
      <div class="bk-step"><button type="button" data-bk="qty-" aria-label="One less" ${e.quantity <= 1 ? 'disabled' : ''}>−</button><b>${e.quantity}</b><button type="button" data-bk="qty+" aria-label="One more">+</button></div></div>
    <div class="bk-btns"><button class="bk-btn out" type="button" data-bk="flip">Flip card</button><button class="bk-btn out" type="button" data-bk="details">Card details</button></div>
    <div class="bk-btns" style="margin-top:10px"><button class="bk-btn pri" type="button" data-bk="close">Back to binder</button></div>
    <div style="display:flex;justify-content:space-between;align-items:center;gap:12px"><button class="bk-link danger" type="button" data-bk="remove">Remove from binder</button><span class="bk-tip" style="margin:0">Drag the card to tilt it.</span></div>`;
}

function entryAction(act, e) {
  const cur = currentBinder();
  if (act === 'details') return openCardDetails(e);
  if (act === 'qty+' || act === 'qty-') {
    const q = e.quantity + (act === 'qty+' ? 1 : -1);
    if (q < 1) return;
    store.setQuantity(cur.id, e.key, q);
    renderBinders(); BinderUI.summon.refresh();
  } else if (act === 'remove') {
    if (!confirm(`Remove ${e.name} from ${binderTitle(cur.name)}?`)) return;
    store.setQuantity(cur.id, e.key, 0);
    BinderUI.summon.close({ dissolve: true });
    renderBinders();
  } else if (act === 'price') {
    const v = parseMoney(prompt(`What is ${e.name} worth in US dollars?`, e.priceManual ? String(e.price) : ''));
    if (v != null) {
      e.price = v; e.priceManual = true; e.priceUpdatedAt = Date.now();
      if (e.priceWhenAdded == null) e.priceWhenAdded = v;
      store.save(); renderBinders(); BinderUI.summon.refresh();
    }
  }
}

// ---------- card details, opened from a binder card ----------

/** A card-shaped object from what the binder saved, so the details can show something before (or without) the lookup. */
function entryCard(e) {
  return {
    id: e.cardId, name: e.name, number: e.number, setName: e.setName, setId: null, setTotal: e.setTotal, rarity: e.rarity,
    imageSmall: e.imageSmall, imageLarge: e.imageLarge, prices: [], tcgUpdated: null, cmTrend: null, cmAvg30: null, cmTrendHolo: null,
    lang: e.language || 'en', identified: isIdentified(e.cardId), manualPrice: e.priceManual ? e.price : null,
  };
}

/** The same card details you get after scanning (price versions, Cardmarket, where the price came from), for a card in a binder. */
async function openCardDetails(e) {
  const identified = isIdentified(e.cardId);
  app.detail = { entry: e, card: entryCard(e), variantIdx: 0, loading: !identified, error: false };
  renderDetails();
  if (identified) return;
  const mine = app.detail;
  try {
    const [card] = await cardDetails([{ id: e.cardId, lang: e.language || 'en' }]);
    if (app.detail !== mine) return;                       // closed while loading
    if (e.priceManual) card.manualPrice = e.price;
    mine.card = card; mine.loading = false;
    const i = card.prices.findIndex(p => p.label === e.variant);
    mine.variantIdx = i >= 0 ? i : 0;
    renderDetails();
    kickBackup(card);                                      // no US price from TCGdex: look in the backup sources
    if (card.priceState === 'pending') renderDetails();
  } catch (err) {
    if (app.detail !== mine) return;
    mine.loading = false; mine.error = true;
    renderDetails();
  }
}

function renderDetails() {
  const html = detailsHtml();
  const open = app.sheet === 'details' && !$('#overlay').hidden && $('#overlay .sheet');
  if (open) {
    const top = open.scrollTop;
    open.innerHTML = `<div class="handle"></div>${html}`;
    open.scrollTop = top;
  } else {
    openSheet(html);
    app.sheet = 'details';
  }
  Analytics.bindDetails($('#overlay'));
}

function detailsHtml() {
  const d = app.detail, card = d.card, e = d.entry;
  const prices = card.prices;
  const vIdx = Math.min(d.variantIdx || 0, Math.max(0, prices.length - 1));
  const variant = prices[vIdx] || null;
  const numberText = card.number ? `Card ${esc(card.number)}${card.setTotal ? ` of ${card.setTotal}` : ''}` : '';
  const cmParts = [card.cmTrend != null && `${eur(card.cmTrend)} trend`, card.cmAvg30 != null && `${eur(card.cmAvg30)} 30-day average`,
    card.cmTrendHolo != null && `${eur(card.cmTrendHolo)} holo trend`].filter(Boolean);
  const en = card.lang !== 'en' ? species.english(card.name) : null;
  const q = encodeURIComponent([en || card.name, card.number].filter(Boolean).join(' '));
  const price = d.loading
    ? '<div class="tile" style="margin-top:18px;display:flex;gap:12px;align-items:center"><div class="spinner"></div><span>Loading the latest prices…</span></div>'
    : d.error
      ? `<div class="notice" style="margin-top:18px">Couldn't load the latest details (check your connection). The binder saved ${esc(priceText(e))}.</div>`
      : priceHtml(card, prices, vIdx, variant);
  return `
    ${card.identified ? '<div class="notice">This card isn\'t in the card database, so there\'s no picture or price feed. You can type in a price yourself.</div>' : ''}
    <div class="result-top">
      <div class="foil">${card.imageLarge ? `<img src="${esc(card.imageLarge)}" alt="${esc(card.name)}">` : `<div class="noimg">${esc(card.name)}</div>`}</div>
      <div class="grow">
        <h2 class="display">${esc(card.name)}</h2>
        ${en ? `<div class="muted">English: <b>${esc(en)}</b></div>` : ''}
        ${card.setName ? `<div><b>${esc(card.setName)}</b></div>` : ''}
        ${numberText ? `<div class="muted">${numberText}</div>` : ''}
        ${card.rarity ? `<span class="badge">${esc(card.rarity)}</span>` : ''}
      </div>
    </div>
    ${price}
    ${!d.loading && cmParts.length ? `<p style="margin:12px 0 0">Cardmarket (Europe): ${cmParts.join(', ')}</p>` : ''}
    ${!d.loading && card.priceSource ? `<p class="small muted" style="margin:4px 0 0">Price from ${esc(card.priceSource)}. TCGdex had none for this card.</p>`
      : !d.loading && card.tcgUpdated ? `<p class="small muted" style="margin:4px 0 0">TCGplayer prices from ${esc(card.tcgUpdated)}</p>` : ''}
    ${d.loading || card.identified ? '' : Analytics.trendHtml(e, card)}
    <p style="margin:14px 0 0"><b>In ${esc(binderTitle(currentBinder().name))}: ${e.quantity}${e.variant ? ` (${esc(e.variant)})` : ''}</b></p>
    <div class="row" style="margin-top:18px">
      <a class="btn btn-outline grow" target="_blank" rel="noopener" href="https://www.tcgplayer.com/search/pokemon/product?q=${q}">TCGplayer</a>
      <a class="btn btn-outline grow" target="_blank" rel="noopener" href="https://www.cardmarket.com/en/Pokemon/Products/Search?searchString=${encodeURIComponent(card.name)}">Cardmarket</a>
    </div>
    <button class="btn btn-primary btn-block" style="margin-top:10px" data-action="close-sheet">Back to the binder</button>`;
}

function renderBinders() {
  const view = $('#binders-view');
  const cols = store.collections;
  const cur = currentBinder();
  const idx = cols.indexOf(cur);
  const color = BINDER_COLORS[idx % BINDER_COLORS.length];
  view.style.setProperty('--accent-rgb', hexToRgb(color).join(','));
  view.style.setProperty('--accent-text', darken(color));
  const keepScroll = view.scrollTop;

  let list = cur.cards.filter(e => !app.rarity || (e.rarity || 'Unknown') === app.rarity);
  const val = e => (usdOf(e) ?? 0) * e.quantity;
  if (app.sort === 'value') list = list.slice().sort((a, b) => val(b) - val(a));
  if (app.sort === 'rarity') list = list.slice().sort((a, b) => rarityRank(b.rarity) - rarityRank(a.rarity) || val(b) - val(a));
  if (app.sort === 'newest') list = list.slice().sort((a, b) => b.addedAt - a.addedAt);
  if (app.sort === 'name') list = list.slice().sort((a, b) => a.name.localeCompare(b.name));

  const rarities = {};
  for (const e of cur.cards) rarities[e.rarity || 'Unknown'] = (rarities[e.rarity || 'Unknown'] || 0) + e.quantity;
  const rarityChips = Object.entries(rarities).sort((a, b) => rarityRank(b[0]) - rarityRank(a[0]));
  const top = cur.cards.slice().sort((a, b) => (usdOf(b) || 0) - (usdOf(a) || 0))[0];
  const unique = new Set(cur.cards.map(e => e.cardId)).size;
  const n = count(cur);
  const oldest = cur.cards.length ? Math.min(...cur.cards.map(e => e.priceUpdatedAt || 0)) : null;
  const conv = convertedPart(cur);
  const eurNoRate = totalEurNoRate(cur);
  const worthNow = usd(total(cur));

  view.innerHTML = `
    <div class="bk-stars" aria-hidden="true"></div>
    <div class="bk-app">
      <header class="bk-top">
        <button class="bk-backbtn" type="button" data-action="close-binders"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg><span>Back to scanner</span></button>
        <button class="bk-pill" type="button" data-action="open-backup">${sync.link ? 'Backed up' : 'Back up'}</button>
      </header>
      <h1 class="bk-title">Binders</h1>
      <div class="bk-tabs" role="group" aria-label="Choose a binder">
        ${cols.map(c => `<button class="bk-tab" type="button" data-action="binder" data-id="${esc(c.id)}" aria-pressed="${c.id === cur.id}">${esc(c.name)}</button>`).join('')}
        <button class="bk-tab bk-new" type="button" data-action="new-binder" aria-label="Add a binder">+ New</button>
      </div>
      <section class="bk-worth" aria-live="polite">
        <div class="bk-worth-row">
          <div><small>${esc(binderTitle(cur.name))} is worth</small><div class="bk-big">${worthNow}</div></div>
          <div class="bk-meta">${n} card${n === 1 ? '' : 's'}, ${unique} different${top && usdOf(top) ? `<br>Top card: ${esc(top.name)}` : ''}</div>
        </div>
        ${conv.eur > 0 ? `<div class="bk-note">Includes about ${usd(conv.usd)} converted from ${eur(conv.eur)} (cards with only European prices)</div>` : ''}
        ${eurNoRate > 0 ? `<div class="bk-note">Plus ${eur(eurNoRate)} in cards with only European prices</div>` : ''}
      </section>
      ${cur.cards.length ? '<button class="bk-analytics-btn" type="button" data-action="open-analytics"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/></svg>Analytics and price trends</button>' : ''}
      <div id="bkStage" class="bk-stage"></div>
      ${cur.cards.length ? `
        <div class="bk-chips" role="group" aria-label="Sort the cards">${[['value', 'Value'], ['rarity', 'Rarity'], ['newest', 'Newest'], ['name', 'Name']].map(([k, l]) =>
          `<button class="bk-chip" type="button" data-action="sort" data-sort="${k}" aria-pressed="${app.sort === k}">${l}</button>`).join('')}</div>
        <div class="bk-chips" role="group" aria-label="Show one rarity">
          <button class="bk-chip" type="button" data-action="rarity" data-r="" aria-pressed="${!app.rarity}">All ${n}</button>
          ${rarityChips.map(([r, c]) => `<button class="bk-chip" type="button" data-action="rarity" data-r="${esc(r)}" aria-pressed="${app.rarity === r}">${esc(r)} ${c}</button>`).join('')}
        </div>` : ''}
      <div class="bk-manage">
        ${cur.cards.length ? `${app.refreshing ? '<div class="bk-spin" aria-label="Updating prices"></div>' : '<button class="bk-link" type="button" data-action="refresh">Refresh prices</button>'}
          <span>TCGplayer market prices, updated ${timeAgo(oldest)}</span>` : ''}
        ${app.refreshMsg ? `<span style="color:var(--bk-rose)">${esc(app.refreshMsg)}</span>` : ''}
        <button class="bk-link" type="button" data-action="rename-binder">Rename</button>
        ${cols.length > 1 ? '<button class="bk-link danger" type="button" data-action="delete-binder">Delete binder</button>' : ''}
      </div>
    </div>`;

  BinderUI.render($('#bkStage'), {
    name: cur.name,
    coverInfo: `${n} card${n === 1 ? '' : 's'}, worth ${worthNow}`,
    entries: list,
    page: app.bookPage, opened: app.bookOpened, fade: app.bookFade,
    emptyMessage: list.length ? '' : cur.cards.length
      ? '<b>No cards here</b><span>Pick a different rarity below.</span>'
      : `<b>${esc(binderTitle(cur.name))} is empty</b><span>Scan a card, then tap Add to ${esc(cur.name)}.</span>`,
    priceTag: priceText,
    onPage: p => { app.bookPage = p; },
    onOpened: () => { app.bookOpened = true; },
    summon: { getEntry: key => currentBinder().cards.find(e => e.key === key), sheetHTML: entrySheetHTML, onAction: entryAction },
  });
  app.bookFade = false;
  view.scrollTop = keepScroll;
}

function openBinders() {
  app.view = 'binders';
  app.bookOpened = false; app.bookPage = 1;
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
  const missing = cur.cards.some(e => e.price == null && !e.priceManual && (e.language || 'en') === 'en' &&
    Date.now() - (e.priceUpdatedAt || 0) > 3600 * 1000);
  if (Date.now() - oldest > PRICE_MAX_AGE || missing) refreshPrices(cur.id);
}

async function refreshPrices(binderId) {
  if (app.refreshing) return;
  const c = store.collections.find(x => x.id === binderId);
  const pairs = [...new Set(c.cards.filter(e => !isIdentified(e.cardId)).map(e => `${e.language || 'en'}|${e.cardId}`))].map(s => s.split('|'));
  if (!pairs.length) return;
  app.refreshing = true; app.refreshMsg = null; renderBinders();
  const fresh = new Map();
  let failed = 0;
  for (let i = 0; i < pairs.length; i += 6) {
    const res = await Promise.all(pairs.slice(i, i + 6).map(async ([lang, id]) => {
      try {
        const card = toCard(await fetchJSON(`${API}/${lang}/cards/${encodeURIComponent(id)}`), lang);
        if (card && lang === 'en' && !card.prices.length) {
          const found = await backupPrice(card);
          if (found.prices) { card.prices = found.prices; card.priceSource = found.source; }
        }
        return [`${lang}/${id}`, card];
      } catch (e) { return [null, null]; }
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
function closeSheet() { $('#overlay').hidden = true; $('#overlay').innerHTML = ''; app.sheet = null; app.detail = null; }

function backupStatus() {
  const s = sync.status;
  if (!sync.link) return 'Not connected yet.';
  if (s.syncing) return 'Syncing with the sheet…';
  if (s.error) return `Last sync failed: ${esc(s.error)}`;
  return `Connected. Last synced ${timeAgo(s.last)}. Phones that use this link share the binders.`;
}

function openBackup(note) {
  app.sheet = { type: 'backup' };
  if (!app.scriptText) fetch('apps-script.txt').then(r => r.text()).then(t => { app.scriptText = t; }).catch(() => {});
  const link = sync.link;
  openSheet(`
    <h2 class="display">Google Sheet backup</h2>
    <p class="muted">Keeps your binders in your own Google Sheet, so they survive a new phone or a cleared browser. Use the same link on a second phone and you both see and change the same binders: what each phone adds or removes is combined, never overwritten.</p>
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

/** Another phone's changes just arrived: redraw whatever is showing. */
function refreshAfterSync() {
  try {
    if (app.view === 'binders') renderBinders();
    const an = $('#analytics'); if (an && !an.hidden) Analytics.render();
    if (app.scan.state === 'results') renderDock();
  } catch (e) { /* the next screen change redraws */ }
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
  else if (a === 'edit-read') { s.editing = true; renderDock(); }
  else if (a === 'edit-read-cancel') { s.editing = false; renderDock(); }
  else if (a === 'variant' && app.detail) { app.detail.variantIdx = Number(el.dataset.i); renderDetails(); }
  else if (a === 'variant') { s.variantIdx = Number(el.dataset.i); renderDock(); }
  else if (a === 'manual-price' && app.detail) {
    entryAction('price', app.detail.entry);
    app.detail.card.manualPrice = app.detail.entry.priceManual ? app.detail.entry.price : null;
    renderDetails();
  }
  else if (a === 'pick') {
    s.selectedId = el.dataset.id; s.variantIdx = 0;
    kickBackup(s.cards.find(c => c.id === s.selectedId));
    renderDock();
  }
  else if (a === 'manual-price') {
    const card = s.cards.find(c => c.id === s.selectedId);
    if (!card) return;
    const v = parseMoney(prompt(`What is ${card.name} worth in US dollars?`, card.manualPrice != null ? String(card.manualPrice) : ''));
    if (v != null) { card.manualPrice = v; renderDock(); }
  }
  else if (a === 'add') {
    const card = s.cards.find(c => c.id === s.selectedId) || s.cards[0];
    const variant = card.prices[Math.min(s.variantIdx || 0, card.prices.length - 1)] || null;
    store.add(el.dataset.binder, card, variant);
    buzz();
    const b = store.collections.find(c => c.id === el.dataset.binder);
    toast(`Added to ${b ? b.name : 'binder'}`);
    renderDock();
    Celebrate.show({ binder: b && b.name, card, tier: BinderUI.tierOf(card.rarity) });
  }
  else if (a === 'check-update') {
    toast('Checking for updates…');
    try { const reg = await navigator.serviceWorker.getRegistration(); if (reg) await reg.update(); } catch (e) { /* ignore */ }
    setTimeout(() => location.reload(), 600);
  }
  else if (a === 'open-analytics') Analytics.open(currentBinder().id);
  else if (a === 'bulk-pick') { const f = $('#bulkFile'); if (f) f.click(); }
  else if (a === 'open-binders') openBinders();
  else if (a === 'close-binders') closeBinders();
  else if (a === 'binder') { app.binderId = el.dataset.id; app.rarity = null; app.bookOpened = false; app.bookPage = 1; app.bookFade = true; renderBinders(); maybeRefresh(); }
  else if (a === 'new-binder') {
    const name = (prompt('Name for the new binder (for example, a child\'s name):') || '').trim();
    if (name) { app.binderId = store.addBinder(name.slice(0, 24)).id; app.rarity = null; app.bookOpened = false; app.bookPage = 1; app.bookFade = true; renderBinders(); }
  }
  else if (a === 'rename-binder') {
    const cur = currentBinder();
    const name = (prompt('Rename this binder:', cur.name) || '').trim();
    if (name) { store.renameBinder(cur.id, name.slice(0, 24)); renderBinders(); }
  }
  else if (a === 'delete-binder') {
    const cur = currentBinder();
    if (store.collections.length > 1 && confirm(`Delete "${cur.name}" and its ${count(cur)} cards? This can't be undone.`)) {
      store.deleteBinder(cur.id);
      app.binderId = null; app.bookOpened = false; app.bookPage = 1; app.bookFade = true;
      renderBinders();
    }
  }
  else if (a === 'sort') { app.sort = el.dataset.sort; app.bookPage = 1; app.bookFade = true; renderBinders(); }
  else if (a === 'rarity') { app.rarity = el.dataset.r || null; app.bookPage = 1; app.bookFade = true; renderBinders(); }
  else if (a === 'refresh') refreshPrices(currentBinder().id);
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
  else if (a === 'sync-now') { await sync.sync(); openBackup(sync.status.error ? null : 'Synced with the sheet.'); }
  else if (a === 'restore') {
    if (!confirm('Replace the binders on this phone with the ones saved in the Google Sheet?')) return;
    try {
      const ok = await sync.restore();
      app.binderId = null; app.bookOpened = false; app.bookPage = 1;
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
    runTypedSearch(p);
  } else if (form.dataset.form === 'edit-read') {
    const f = new FormData(form);
    const name = String(f.get('cardname') || '').trim(), num = String(f.get('cardnumber') || '').trim(), tot = String(f.get('cardtotal') || '').trim();
    if (!name && !num) { toast('Type a name or a card number'); return; }
    runTypedSearch({ name: name || null, number: num ? normalizeNumber(num) : null, total: tot ? normalizeNumber(tot) : null });
  } else if (form.dataset.form === 'connect') {
    const btn = form.querySelector('button');
    btn.disabled = true; btn.textContent = 'Connecting…';
    try {
      const note = await sync.connect(form.link.value);
      app.binderId = null; app.bookOpened = false; app.bookPage = 1;
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
sync.start();
fx.init();
renderLang();
renderDock();
camera.start();
catalogs[app.lang].load().catch(() => {});
setTimeout(() => species.load(), 1200);
scanLoop();
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

// the file picker for bulk upload: one handler for the scan screen and for "Add more photos"
document.addEventListener('change', ev => {
  if (ev.target && ev.target.id === 'bulkFile') {
    const files = [...ev.target.files]; ev.target.value = '';
    if (!files.length) return;
    if (Bulk.active() && Bulk.state && Bulk.state.phase === 'review') Bulk.more(files); else Bulk.start(files);
  }
});
