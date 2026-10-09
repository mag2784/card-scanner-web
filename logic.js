'use strict';
/*
 * Card Scanner (web): pure logic, no DOM.
 * Parsing OCR text, matching card names, the card catalog, and card lookups.
 * Mirrors the Android app's scan/ and data/ packages.
 */

const API = 'https://api.tcgdex.net/v2';

const LANGS = {
  en: { label: 'EN', codes: ['en'], tess: ['eng'], listName: 'card list' },
  ja: { label: 'JP', codes: ['ja'], tess: ['jpn'], listName: 'Japanese card list' },
  zh: { label: 'CN', codes: ['zh-tw', 'zh-cn'], tess: ['chi_tra', 'chi_sim'], listName: 'Chinese card lists' },
};

// ---------- text helpers ----------

function isCjk(ch) {
  const c = ch.codePointAt(0);
  return (c >= 0x3040 && c <= 0x30ff) || (c >= 0x31f0 && c <= 0x31ff) ||
    (c >= 0x3400 && c <= 0x4dbf) || (c >= 0x4e00 && c <= 0x9fff) ||
    (c >= 0xf900 && c <= 0xfaff) || (c >= 0xff00 && c <= 0xffef);
}
const hasCjk = s => [...(s || '')].some(isCjk);

/** Levenshtein distance; returns limit + 1 as soon as it can't be within limit. */
function lev(a, b, limit = Infinity) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let cur = new Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > limit) return limit + 1;
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

/** "032" -> "32"; "tg05" -> "TG05" */
function normalizeNumber(raw) {
  const s = String(raw || '');
  if (/^\d+$/.test(s)) return String(parseInt(s, 10));
  return s.toUpperCase();
}

// ---------- collector number ----------

// 4/102, 032/084, TG05/TG30, H12/H32. Only real prefixes, so "BB98/126" reads as 98/126.
// (No lookbehind: older iPhones don't support it.)
const NUMBER_RE = /(?:^|[^0-9])((?:TG|GG|SV|RC|SWSH|SM|XY|BW|H)?\d{1,3}[a-z]?)\s*\/\s*((?:TG|GG|SV|RC|H)?\d{1,3})(?![0-9])/;

/** Fixes common OCR slips around collector numbers ("O32|O84" -> "032/084"). */
function tidyNumberText(text) {
  return String(text || '')
    .replace(/(\d)[Oo]/g, (_, a) => `${a}0`)
    .replace(/[Oo](\d)/g, (_, a) => `0${a}`)
    .replace(/(\d)\s*[|\\lI]\s*(\d)/g, (_, a, b) => `${a}/${b}`);
}

/** Finds the collector number in OCR text; prefers the last (lowest) match. */
function parseNumber(text) {
  const lines = tidyNumberText(text).split(/\n+/);
  let hit = null;
  for (const line of lines) {
    const m = NUMBER_RE.exec(line);
    if (m) hit = { number: normalizeNumber(m[1]), total: normalizeNumber(m[2]) };
  }
  return hit;
}

// ---------- names ----------

const HEADER_WORDS = ['BASIC', 'STAGE', 'TRAINER', 'ITEM', 'SUPPORTER', 'STADIUM', 'ENERGY',
  'POKEMON', 'POKÉMON', 'TOOL', 'EVOLVES', 'ABILITY'];
const EXACT_SKIP = new Set(['HP', 'PUT', 'VSTAR', 'VMAX', 'TERA', 'EX', 'GX', 'V']);
const CJK_HEADERS = ['ポケモンのどうぐ', 'トレーナーズ', 'サポート', 'スタジアム', 'グッズ', 'エネルギー',
  '1進化', '2進化', '進化', 'たね',
  '宝可梦道具', '寶可夢道具', '1阶进化', '2阶进化', '1階進化', '2階進化',
  '训练家', '訓練家', '支援者', '竞技场', '競技場', '物品', '基础', '基礎'];

/** BASIC, STAGE 1, TRAINER... even when misread ("BASIG", "STAGF"). */
function isHeaderWord(word) {
  const w = word.toUpperCase().replace(/[.:,]/g, '');
  if (EXACT_SKIP.has(w)) return true;
  if (w.length < 4) return false;
  return HEADER_WORDS.some(h => lev(w.slice(0, h.length), h, 1) <= 1);
}

// ---------- matching names to candidate cards ----------

/** Names compared without accents, curly quotes or case: "Poké Ball" = "poke ball", "Boss’s Orders" = "boss's orders". */
const nameKey = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[’‘´`]/g, "'").replace(/[–—]/g, '-').toLowerCase().trim();

const SUFFIX = /[\s-]+(ex|gx|v|vmax|vstar|break|prime|lv\.?\s?x|star|δ)$/i;
const CJK_SUFFIX = /([^\x00-\x7F])(ex|gx|v|vmax|vstar)$/i;

/** Lowercase letters only, accents removed; keeps Japanese/Chinese. */
function letters(s) {
  return [...String(s || '').normalize('NFD').toLowerCase()]
    .filter(ch => (ch >= 'a' && ch <= 'z') || isCjk(ch)).join('');
}

/** 0..1: how well any seen text matches this card name. */
function nameScore(cardName, seen) {
  const base = letters(String(cardName || '').replace(SUFFIX, '').replace(CJK_SUFFIX, '$1'));
  if (base.length < 2) return 0;
  let best = 0;
  for (const line of seen) {
    const s = letters(line);
    let score;
    if (!s) score = 0;
    else if (s.includes(base)) score = 1;
    else if (s.length >= 3 && base.startsWith(s)) score = 0.6 + 0.4 * s.length / base.length;
    else {
      const n = base.length;
      score = 0;
      if (s.length <= n) score = 1 - lev(s, base) / n;
      else for (let i = 0; i + n <= s.length; i++) score = Math.max(score, 1 - lev(s.slice(i, i + n), base) / n);
    }
    if (score > best) best = score;
  }
  return best;
}

/** Picks the candidate whose name best matches the seen text, or null if unsure. */
/**
 * Two-stage scan: the name was read first, then the collector number up close. Which card is it?
 *   { cards, chosen, exact } - show these, with `chosen` first
 *   null                     - none of this number's cards has that name: search by name and number instead
 */
function decideTwoStage(found, name, evidence) {
  const cards = (found && found.cards) || [];
  if (!cards.length || cards.length > 40) return null;
  const agrees = cards.filter(c => nameScore(c.name, [name]) >= 0.8);
  if (!agrees.length) return null;
  const chosen = agrees.length === 1 ? agrees[0] : (pickCandidate(agrees, [name, ...(evidence || [])]) || agrees[0]);
  return { cards: [chosen, ...agrees.filter(c => c !== chosen)], chosen, exact: !!found.setMatched };
}

function pickCandidate(cands, seen) {
  if (cands.length === 1) return cands[0];
  if (!cands.length || !seen.length) return null;
  const scored = cands.map(c => [c, nameScore(c.name, seen)]).sort((a, b) => b[1] - a[1]);
  const [best, bestScore] = scored[0];
  const runner = scored[1];
  if (runner && String(runner[0].name).toLowerCase() === String(best.name).toLowerCase()) return null;
  const margin = bestScore - (runner ? runner[1] : 0);
  return bestScore >= 0.6 && margin >= 0.2 ? best : null;
}

// ---------- typed searches ----------

/** "pikachu 028/131", "Pikachu #28", "charizard ex", "28/131" */
function parseQuery(q) {
  let rest = String(q || '').trim();
  let number = null, total = null;
  const slash = /(?:^|[^A-Za-z0-9])([A-Za-z]{0,3}\d{1,3}[a-z]?)\s*\/\s*([A-Za-z]{0,3}\d{1,3})(?![0-9])/.exec(rest);
  if (slash) {
    number = normalizeNumber(slash[1]);
    total = normalizeNumber(slash[2]);
    rest = rest.slice(0, slash.index) + ' ' + rest.slice(slash.index + slash[0].length);
  } else {
    const lone = /(?:^|\s)(?:#|no\.?\s*)?([A-Za-z]{0,2}\d{1,3})\s*$/i.exec(rest);
    if (lone) {
      number = normalizeNumber(lone[1]);
      rest = rest.slice(0, lone.index);
    }
  }
  const name = rest.replace(/[#/]/g, ' ').replace(/\s+/g, ' ').trim();
  return { name: name || null, number, total };
}

// ---------- catalog ----------

const setIdOf = b => (b.id || '').slice(0, (b.id || '').lastIndexOf('-'));

/** Builds lookup indexes from TCGdex brief cards (tagged with lang) and sets. */
function buildCatalog(cards, sets) {
  const names = new Map();
  for (const b of cards) if (b.name) names.set(nameKey(b.name), b.name);
  const byLen = new Map();
  for (const k of names.keys()) {
    if (!byLen.has(k.length)) byLen.set(k.length, []);
    byLen.get(k.length).push(k);
  }
  const byNumber = new Map();
  for (const b of cards) {
    if (!b.localId) continue;
    const n = normalizeNumber(b.localId);
    if (!byNumber.has(n)) byNumber.set(n, []);
    byNumber.get(n).push(b);
  }
  const setSize = new Map();
  for (const s of sets) if (s.id) setSize.set(s.id, s.cardCount ? s.cardCount.official : null);

  return {
    cards,
    names,
    /** Cards with this collector number, narrowed to sets of the printed size when possible. */
    candidates(number, total) {
      const all = byNumber.get(number) || [];
      const t = /^\d+$/.test(total || '') ? parseInt(total, 10) : null;
      if (t == null) return { cards: all, setMatched: false };
      const inSet = all.filter(b => setSize.get(setIdOf(b)) === t);
      return inSet.length ? { cards: inSet, setMatched: true } : { cards: all, setMatched: false };
    },
    /** Cards whose name (without ex / V / GX) is one of these local names. */
    cardsNamed(localNames) {
      const want = new Set(localNames.map(n => String(n).toLowerCase()));
      return cards.filter(b => b.name && want.has(stripCardSuffix(b.name).toLowerCase()));
    },
    /** Names of sets that print this many cards, e.g. 129 -> the Chinese sets with 91/129. */
    setsOfSize(total) {
      return [...new Set(sets.filter(x => x.cardCount && x.cardCount.official === total).map(x => x.name).filter(Boolean))];
    },
    /** Closest real card name to what OCR read, or null. */
    resolveName(raw) {
      const key = nameKey(raw);
      if (!key) return null;
      if (names.has(key)) return names.get(key);
      const cjk = hasCjk(key);
      const tol = cjk ? (key.length >= 3 ? 1 : 0) : key.length <= 3 ? 0 : key.length <= 6 ? 1 : 2;
      if (!tol) return null;
      let best = null, bestD = tol + 1, tie = false;
      for (let len = key.length - tol; len <= key.length + tol; len++) {
        for (const cand of byLen.get(len) || []) {
          const d = lev(key, cand, bestD);
          if (d < bestD) { best = cand; bestD = d; tie = false; }
          else if (d === bestD && cand !== best) tie = true;
        }
      }
      return best && !tie ? names.get(best) : null;
    },
  };
}

/** Finds a real card name inside one OCR line ("BASIC Jynx HP 100 @" -> "Jynx"). */
function nameFromLine(cat, line) {
  if (!line) return null;
  if (hasCjk(line)) {
    let t = line.replace(/[\s\u3000]/g, '').replace(/HP\s*\d+.*$/i, '');
    for (const h of CJK_HEADERS) if (t.startsWith(h)) { t = t.slice(h.length); break; }
    t = [...t].filter(ch => isCjk(ch) || /[A-Za-z0-9]/.test(ch)).join('');
    for (let len = Math.min(t.length, 12); len >= 2; len--) {
      for (let i = 0; i + len <= t.length; i++) {
        const hit = cat.names.get(nameKey(t.slice(i, i + len)));
        if (hit) return hit;
      }
    }
    return t.length >= 3 ? cat.resolveName(t) : null;
  }
  const raw = line.replace(/[^A-Za-zÀ-ÿ'’.\-♀♂ ]/g, ' ').split(/\s+/).filter(Boolean);
  // First, real names exactly as printed, header words included: "Basic Fire Energy", "Boss's Orders", "Ultra Ball"
  for (let n = Math.min(5, raw.length); n >= 1; n--) {
    for (let i = 0; i + n <= raw.length; i++) {
      const s = raw.slice(i, i + n).join(' ');
      if (nameKey(s).length < 3) continue;
      const hit = cat.names.get(nameKey(s));
      if (hit) return hit;
    }
  }
  const words = raw.filter(w => w.length >= 2 && !isHeaderWord(w));
  for (let n = Math.min(3, words.length); n >= 1; n--) {
    for (let i = 0; i + n <= words.length; i++) {
      const s = words.slice(i, i + n).join(' ');
      if (s.length < 3) continue;
      const hit = cat.resolveName(s);
      if (hit) return hit;
    }
  }
  return null;
}

// ---------- card details ----------

const VARIANT_LABELS = {
  normal: 'Normal', holo: 'Holofoil', holofoil: 'Holofoil', reverse: 'Reverse holo',
  'reverse-holofoil': 'Reverse holo', '1st-edition': '1st Edition',
  '1st-edition-holofoil': '1st Edition holo', unlimited: 'Unlimited', 'unlimited-holofoil': 'Unlimited holo',
};
const variantLabel = k => VARIANT_LABELS[k] || (k.charAt(0).toUpperCase() + k.slice(1).replace(/-/g, ' '));

const pos = v => (typeof v === 'number' && v > 0 ? v : null);

/** TCGdex full card -> what the app shows. */
function toCard(r, lang) {
  if (!r || !r.id || !r.name) return null;
  const tp = (r.pricing && r.pricing.tcgplayer) || null;
  const cm = (r.pricing && r.pricing.cardmarket) || null;
  const prices = tp ? Object.entries(tp)
    .filter(([, v]) => v && typeof v === 'object')
    .map(([k, v]) => ({ label: variantLabel(k), market: pos(v.marketPrice), low: pos(v.lowPrice), high: pos(v.highPrice) }))
    : [];
  const group = r.category === 'Trainer' ? 'Trainer' : r.category === 'Energy' ? 'Energy' : (r.category || r.hp) ? 'Pokémon' : null;
  const kind = group === 'Trainer' ? (r.trainerType || 'Trainer') : group === 'Energy' ? (r.energyType ? `${r.energyType} Energy` : 'Energy')
    : group === 'Pokémon' ? (r.stage || 'Pokémon') : null;
  return {
    id: r.id,
    name: r.name,
    group, kind,
    number: r.localId ? normalizeNumber(r.localId) : null,
    setName: (r.set && r.set.name) || null,
    setId: (r.set && r.set.id) || null,
    setTotal: (r.set && r.set.cardCount && r.set.cardCount.official) || null,
    rarity: r.rarity || null,
    imageSmall: r.image ? r.image + '/low.png' : null,
    imageLarge: r.image ? r.image + '/high.png' : null,
    prices,
    tcgUpdated: tp && typeof tp.updated === 'string' ? tp.updated.slice(0, 10) : null,
    cmTrend: pos(cm && cm.trend),
    cmAvg1: pos(cm && cm.avg1),
    cmAvg7: pos(cm && cm.avg7),
    cmAvg30: pos(cm && cm.avg30),
    cmTrendHolo: pos(cm && cm['trend-holo']),
    lang: lang || 'en',
  };
}

const eurPrice = c => c.cmTrend ?? c.cmAvg30 ?? c.cmTrendHolo ?? null;
const marketPrice = (c, variant) =>
  (c.prices.find(p => p.label === variant) || {}).market ?? (c.prices.find(p => p.market != null) || {}).market ?? null;

// ---------- lookups (most to least specific) ----------

/**
 * Chooses which catalog cards to show for a read or a typed search.
 * Returns { briefs, exact }.
 */
function pickTier(cat, p, typed) {
  const name = p.name;
  const total = /^\d+$/.test(p.total || '') ? parseInt(p.total, 10) : null;
  const byNumber = p.number ? cat.cards.filter(b => b.localId && normalizeNumber(b.localId) === p.number) : [];
  const inSet = total != null ? cat.candidates(p.number, p.total) : { cards: [], setMatched: false };
  const inSetCards = inSet.setMatched ? inSet.cards : [];
  const lower = name ? name.toLowerCase() : null;
  const named = list => (lower ? list.filter(b => (b.name || '').toLowerCase() === lower) : []);
  const loose = list => (lower ? list.filter(b => (b.name || '').toLowerCase().includes(lower)) : []);
  const tiers = [
    [named(inSetCards), true],
    [loose(inSetCards), true],
    // Same name and number but a different set size: only "exact" if no set size was read
    [named(byNumber), total == null],
    [loose(byNumber), total == null],
    [named(cat.cards), !p.number && typed],
    [inSetCards, false],
    [loose(cat.cards), false],
  ];
  for (const [briefs, exact] of tiers) if (briefs.length) return { briefs, exact };
  return { briefs: [], exact: false };
}

/** Rarer = higher. */
function rarityRank(r) {
  const s = String(r || '').toLowerCase();
  if (!s) return 0;
  if (s.includes('special illustration')) return 9;
  if (/hyper|secret|rainbow|gold/.test(s)) return 10;
  if (s.includes('illustration')) return 8;
  if (/ultra|full art|ace spec/.test(s)) return 7;
  if (/double|holo ex|holo gx|holo v|shiny|amazing|radiant/.test(s)) return 6;
  if (s.includes('holo')) return 5;
  if (s.includes('uncommon')) return 2;
  if (s.includes('rare')) return 4;
  if (s.includes('common')) return 1;
  if (s.includes('promo')) return 3;
  return 0;
}


// ---------- backup price sources (used only when TCGdex has no TCGplayer price) ----------

const TCGCSV = 'https://tcgcsv.com/tcgplayer';   // nightly copy of TCGplayer's catalog; category 3 = Pokémon (English)
// Browsers can't read TCGCSV directly, so a daily GitHub Action copies it here (scripts/prices.mjs).
const PRICE_COPY = 'https://raw.githubusercontent.com/mag2784/card-scanner-web/prices';

/** The daily copy's set list -> TCGCSV's shape. */
const expandGroups = j => ((j && j.groups) || []).map(([groupId, name, abbreviation]) => ({ groupId, name, abbreviation }));

/** One set from the daily copy -> TCGCSV's { products, prices } shape, so the same matching code works on both. */
function expandGroupCopy(j) {
  const cards = (j && j.cards) || [];
  return {
    products: cards.map(([productId, cleanName, number]) => ({ productId, name: `${cleanName} - ${number}`, cleanName, extendedData: [{ name: 'Number', value: number }] })),
    prices: cards.flatMap(([productId, , , ps]) => (ps || []).map(([subTypeName, marketPrice, lowPrice, highPrice]) => ({ productId, subTypeName, marketPrice, lowPrice, highPrice }))),
  };
}
const PTCG = 'https://api.pokemontcg.io/v2';

const SUBTYPE_LABELS = {
  'normal': 'Normal', 'holofoil': 'Holofoil', 'reverse holofoil': 'Reverse holo',
  '1st edition holofoil': '1st Edition holo', '1st edition normal': '1st Edition', '1st edition': '1st Edition',
  'unlimited holofoil': 'Unlimited holo', 'unlimited': 'Unlimited', 'unlimited normal': 'Unlimited',
};
const subtypeLabel = s => SUBTYPE_LABELS[String(s || '').toLowerCase()] || String(s || 'Normal');

const PTCG_LABELS = {
  normal: 'Normal', holofoil: 'Holofoil', reverseHolofoil: 'Reverse holo', '1stEditionHolofoil': '1st Edition holo',
  '1stEditionNormal': '1st Edition', unlimitedHolofoil: 'Unlimited holo', unlimited: 'Unlimited',
};

/** "SV: Scarlet & Violet 151" and "Scarlet & Violet 151" both become "scarlet violet 151". */
function normSet(s) {
  return String(s || '').toLowerCase().replace(/^[^:]*:\s*/, '').replace(/&/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
}

/** TCGplayer "groups" (sets) matching a card's set, by name first and then by set code. */
function pickGroups(groups, setName, setId) {
  const want = normSet(setName);
  const id = String(setId || '').toLowerCase();
  const byName = want ? groups.filter(g => normSet(g.name) === want) : [];
  if (byName.length) return byName;
  return id ? groups.filter(g => String(g.abbreviation || '').toLowerCase() === id) : [];
}

const productNumber = p => {
  const x = (p.extendedData || []).find(e => e.name === 'Number' || e.displayName === 'Card Number');
  return x ? String(x.value || '') : '';
};

/** The TCGplayer product for this card: same collector number and name, plain printing preferred. */
function pickProduct(products, card) {
  const want = String(card.number || '');
  if (!want) return null;
  const matches = products.filter(p => {
    const n = productNumber(p);
    if (!n) return false;
    return normalizeNumber(n.split('/')[0].trim()) === want &&
      nameScore(p.cleanName || p.name || '', [card.name]) >= 0.9;
  });
  const totalOf = p => parseInt((productNumber(p).split('/')[1] || '').trim(), 10);
  const rank = p => (/\(/.test(p.name || '') ? 0 : 2) + (card.setTotal && totalOf(p) === card.setTotal ? 1 : 0);
  matches.sort((a, b) => rank(b) - rank(a));
  return matches[0] || null;
}

/** Price rows for one TCGplayer product -> the app's price list (one entry per printing). */
function pricesForProduct(rows, productId) {
  return rows
    .filter(r => r.productId === productId)
    .map(r => ({ label: subtypeLabel(r.subTypeName), market: pos(r.marketPrice), low: pos(r.lowPrice), high: pos(r.highPrice) }))
    .filter(p => p.market != null || p.low != null);
}

/** pokemontcg.io's tcgplayer block -> the app's price list. */
function ptcgPrices(tp) {
  if (!tp || !tp.prices) return [];
  return Object.entries(tp.prices)
    .filter(([, v]) => v && typeof v === 'object')
    .map(([k, v]) => ({ label: PTCG_LABELS[k] || k, market: pos(v.market), low: pos(v.low), high: pos(v.high) }))
    .filter(p => p.market != null || p.low != null);
}

function ptcgQuery(card) {
  return [`name:"${String(card.name).replace(/"/g, '')}"`, `number:${card.number}`,
    card.setTotal ? `set.printedTotal:${card.setTotal}` : ''].filter(Boolean).join(' ');
}

/** What someone typed as a dollar amount: "$93", "93.5", "1,200" -> number, or null. */
function parseMoney(input) {
  if (input == null) return null;
  const n = Number(String(input).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) && n > 0 && n < 1e6 ? Math.round(n * 100) / 100 : null;
}



// ---------- analytics: price history, trends and breakdowns ----------

const DAY = 86400000;

/** Adds a point to a history: one point a day (a newer reading the same day replaces it), newest last, at most `cap`. */
function pushPoint(hist, t, v, minGap = 20 * 3600 * 1000, cap = 400) {
  const h = (hist || []).slice();
  if (v == null || !isFinite(v)) return h;
  const last = h[h.length - 1];
  if (last && !last[2] && t - last[0] < minGap) h[h.length - 1] = [t, v];
  else h.push([t, v]);
  return h.length > cap ? h.slice(h.length - cap) : h;
}

/** The price of one copy at time t: a straight line between the two nearest points, flat before the first and after the last. */
function priceAt(hist, t) {
  if (!hist || !hist.length) return null;
  if (t <= hist[0][0]) return hist[0][1];
  const last = hist[hist.length - 1];
  if (t >= last[0]) return last[1];
  for (let i = 1; i < hist.length; i++) {
    if (t <= hist[i][0]) {
      const [t0, v0] = hist[i - 1], [t1, v1] = hist[i];
      return t1 === t0 ? v1 : v0 + (v1 - v0) * (t - t0) / (t1 - t0);
    }
  }
  return last[1];
}

/**
 * Where the price was 1, 7 and 30 days ago, estimated from Cardmarket's averages (EUR) by assuming the dollar price moved
 * by the same percentage. cm = { trend, avg1, avg7, avg30 }. Oldest first; every point is flagged as an estimate.
 */
function cmEstimate(now, usdNow, cm) {
  if (!(usdNow > 0) || !cm || !(cm.trend > 0)) return [];
  const out = [];
  for (const [days, avg] of [[30, cm.avg30], [7, cm.avg7], [1, cm.avg1]]) {
    if (avg > 0) { const r = avg / cm.trend; if (r > .2 && r < 5) out.push([now - days * DAY, usdNow * r, 1]); }
  }
  return out;
}

/** A card's whole history: the Cardmarket estimates that come before its first real reading, then the real readings. */
function fullHist(e) {
  const real = e.hist || [];
  const firstReal = real.length ? real[0][0] : Infinity;
  return [...(e.est || []).filter(p => p[0] < firstReal), ...real];
}

/** Value of one copy now: its US price, or the euro price converted. */
function unitValue(e, rate) {
  if (e.price != null) return e.price;
  return e.priceEur != null && rate ? e.priceEur * rate : null;
}

/**
 * How a card's price changed over the last `days` days: { from, to, abs, pct, estimated }, or null when the history is
 * too short (less than half the window) to say.
 */
function movement(e, now, days, rate) {
  const h = fullHist(e);
  const to = unitValue(e, rate);
  if (!h.length || to == null) return null;
  if ((now - h[0][0]) < days * DAY * 0.5) return null;
  const t0 = now - days * DAY;
  const from = priceAt(h, t0);
  if (from == null || from <= 0) return null;
  const nearest = h.filter(p => p[0] <= t0).pop() || h[0];
  return { from, to, abs: to - from, pct: (to - from) / from * 100, estimated: !!nearest[2] || h[0][0] > t0 - DAY && !!h[0][2] };
}

/** Change since the card was added to the binder. */
function sinceAdded(e, rate) {
  const to = unitValue(e, rate);
  if (to == null || e.priceWhenAdded == null || e.priceWhenAdded <= 0) return null;
  return { from: e.priceWhenAdded, to, abs: to - e.priceWhenAdded, pct: (to - e.priceWhenAdded) / e.priceWhenAdded * 100 };
}

/** What the cards you have now were worth at past prices: n points between `from` and `to`. */
function holdingsSeries(entries, from, to, n, rate) {
  const hs = entries.map(e => ({ h: fullHist(e), q: e.quantity || 1, now: unitValue(e, rate) }));
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = from + (to - from) * i / (n - 1);
    let total = 0;
    for (const x of hs) {
      const v = x.h.length ? priceAt(x.h, t) : x.now;
      if (v != null) total += v * x.q;
    }
    out.push([t, total]);
  }
  return out;
}

const median = a => { const s = a.filter(x => x != null).sort((x, y) => x - y); if (!s.length) return null; const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

const VALUE_BUCKETS = [[0, 1, 'Under $1'], [1, 5, '$1 – $5'], [5, 20, '$5 – $20'], [20, 100, '$20 – $100'], [100, Infinity, '$100 and up']];

/** Everything the analytics screen shows, from a binder's cards. */
function binderAnalytics(entries, now, rate) {
  const q = e => e.quantity || 1;
  const val = e => unitValue(e, rate);
  const priced = entries.filter(e => val(e) != null);
  const total = priced.reduce((a, e) => a + val(e) * q(e), 0);
  const converted = entries.filter(e => e.price == null && e.priceEur != null && rate).reduce((a, e) => a + e.priceEur * rate * q(e), 0);
  const costed = entries.filter(e => e.priceWhenAdded != null && val(e) != null);
  const cost = costed.reduce((a, e) => a + e.priceWhenAdded * q(e), 0);
  const worthOfCosted = costed.reduce((a, e) => a + val(e) * q(e), 0);
  const cards = entries.reduce((a, e) => a + q(e), 0);

  const ranked = priced.map(e => ({ e, v: val(e) * q(e), unit: val(e) })).sort((a, b) => b.v - a.v);
  const top5 = ranked.slice(0, 5).reduce((a, x) => a + x.v, 0);

  const group = (keyOf) => {
    const m = new Map();
    for (const e of entries) {
      const k = keyOf(e) || 'Unknown';
      const g = m.get(k) || { label: k, value: 0, count: 0 };
      g.value += (val(e) || 0) * q(e); g.count += q(e); m.set(k, g);
    }
    return [...m.values()].sort((a, b) => b.value - a.value || b.count - a.count);
  };

  const sets = new Map();
  for (const e of entries) {
    const k = e.setName || 'Unknown set';
    const g = sets.get(k) || { label: k, value: 0, count: 0, nums: new Set(), total: null };
    g.value += (val(e) || 0) * q(e); g.count += q(e);
    if (e.number != null) g.nums.add(String(e.number));
    if (e.setTotal) g.total = e.setTotal;
    sets.set(k, g);
  }
  const bySet = [...sets.values()].map(g => ({ label: g.label, value: g.value, count: g.count, owned: g.nums.size, total: g.total,
    pct: g.total ? Math.min(100, g.nums.size / g.total * 100) : null })).sort((a, b) => b.value - a.value);

  const buckets = VALUE_BUCKETS.map(([lo, hi, label]) => ({ label, count: entries.filter(e => { const v = val(e); return v != null && v >= lo && v < hi; }).reduce((a, e) => a + q(e), 0) }));
  buckets.push({ label: 'No price yet', count: entries.filter(e => val(e) == null).reduce((a, e) => a + q(e), 0) });

  const months = new Map();
  for (const e of entries) {
    const d = new Date(e.addedAt || now);
    const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    months.set(k, (months.get(k) || 0) + q(e));
  }
  const added = [...months.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([label, count]) => ({ label, count }));

  const sa = entries.map(e => ({ e, s: sinceAdded(e, rate) })).filter(x => x.s);
  const gainers = sa.slice().sort((a, b) => b.s.abs * q(b.e) - a.s.abs * q(a.e)).filter(x => x.s.abs > 0.004);
  const losers = sa.slice().sort((a, b) => a.s.abs * q(a.e) - b.s.abs * q(b.e)).filter(x => x.s.abs < -0.004);

  return {
    cards, unique: entries.length, value: total, converted, cost, gain: worthOfCosted - cost, gainPct: cost > 0 ? (worthOfCosted - cost) / cost * 100 : null,
    priced: priced.length, unpriced: entries.length - priced.length,
    avg: cards && priced.length ? total / priced.reduce((a, e) => a + q(e), 0) : null,
    median: median(priced.flatMap(e => Array(q(e)).fill(val(e)))),
    ranked, top5Share: total > 0 ? top5 / total * 100 : null,
    byRarity: group(e => e.rarity), byGroup: group(e => e.group), byLanguage: group(e => ({ en: 'English', ja: 'Japanese', 'zh-tw': 'Chinese (Traditional)', 'zh-cn': 'Chinese (Simplified)' }[e.language || 'en'])),
    byVariant: group(e => e.variant), bySet, buckets, added, gainers, losers,
  };
}


// ---------- bulk: many cards in one photo ----------

const median0 = a => { const s = a.slice().sort((x, y) => x - y); if (!s.length) return null; const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/**
 * Collector numbers with their positions, from OCR words ({ text, x0, y0, x1, y1 }). "091/129" may come as one word or as
 * "091", "/", "129". A set size is required: a lone "12" is too easy to misread.
 */
function findNumberTokens(words) {
  const ws = (words || []).filter(w => w && w.text && w.x1 > w.x0);
  const out = [], used = new Set();
  for (let i = 0; i < ws.length; i++) {
    if (used.has(i)) continue;
    for (const span of [1, 2, 3]) {
      const part = ws.slice(i, i + span);
      if (part.length < span) break;
      if (span > 1) {
        const h = Math.max(...part.map(w => w.y1 - w.y0));
        const cy0 = (part[0].y0 + part[0].y1) / 2;
        const ok = part.every((w, k) => k === 0 || (Math.abs((w.y0 + w.y1) / 2 - cy0) < h * 0.6 && w.x0 - part[k - 1].x1 < h * 1.6 && w.x0 >= part[k - 1].x0));
        if (!ok) break;
      }
      const p = parseNumber(part.map(w => w.text).join(''));
      if (p && p.total) {
        const x0 = Math.min(...part.map(w => w.x0)), x1 = Math.max(...part.map(w => w.x1)), y0 = Math.min(...part.map(w => w.y0)), y1 = Math.max(...part.map(w => w.y1));
        out.push({ number: p.number, total: p.total, x0, y0, x1, y1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, h: y1 - y0 });
        for (let k = 0; k < span; k++) used.add(i + k);
        break;
      }
    }
  }
  // the same number seen twice in the overlap between two tiles of one photo
  return out.filter((t, i) => !out.slice(0, i).some(u => u.number === t.number && u.total === t.total && Math.abs(u.cx - t.cx) < Math.max(u.h, t.h) * 3 && Math.abs(u.cy - t.cy) < Math.max(u.h, t.h) * 2));
}

/**
 * Finds every card in one OCR'd photo (a single card, a binder page, cards laid out on a table) and matches each to the
 * catalog: each collector number is a card; its set size narrows the candidates; the names printed above it pick between
 * the few that remain. lines / words: { text, x0, y0, x1, y1 } in image pixels. Returns items in reading order:
 *   { number, total, status: 'matched' | 'pick' | 'unknown', candidates, chosen, evidence, x, y }
 */
function bulkResolve(lines, words, cat, size) {
  const toks = findNumberTokens(words);
  if (!toks.length) return [];
  toks.sort((a, b) => a.cy - b.cy);
  // rows: numbers at about the same height belong to one row of cards
  const rowTol = Math.max(0.07 * size.h, 2.5 * median0(toks.map(t => t.h)));
  const rows = [];
  for (const t of toks) {
    const r = rows[rows.length - 1];
    if (r && t.cy - r.cy0 <= rowTol) { r.items.push(t); r.cy0 = (r.cy0 * (r.items.length - 1) + t.cy) / r.items.length; } else rows.push({ cy0: t.cy, items: [t] });
  }
  rows.forEach(r => r.items.sort((a, b) => a.cx - b.cx));
  const rowPitch = rows.length > 1 ? median0(rows.slice(1).map((r, i) => r.cy0 - rows[i].cy0)) : null;
  const colGaps = rows.flatMap(r => r.items.slice(1).map((t, i) => t.cx - r.items[i].cx));
  const pitchX = colGaps.length ? median0(colGaps) : size.w / Math.max(...rows.map(r => r.items.length));
  const cardH = rowPitch || pitchX * 88 / 63;

  // each text line goes to the card whose number is below it: close in x, one card height away in y
  const own = new Map(toks.map(t => [t, []]));
  for (const l of lines || []) {
    if (!l || !l.text) continue;
    const lx = (l.x0 + l.x1) / 2, ly = (l.y0 + l.y1) / 2;
    let best = null, bc = Infinity;
    for (const t of toks) {
      const dy = t.cy - ly;
      if (dy < t.h || dy > 1.2 * cardH) continue;
      const c = Math.abs(lx - t.cx) / pitchX + 0.35 * dy / cardH;
      if (c < bc && Math.abs(lx - t.cx) < 1.1 * pitchX) { bc = c; best = t; }
    }
    if (best) own.get(best).push(l.text);
  }

  const items = [];
  for (const r of rows) for (const t of r.items) {
    const found = cat.candidates(t.number, t.total);
    const cands = found.cards.slice(0, 40);
    const evidence = own.get(t) || [];
    let chosen = null, status = 'unknown';
    if (cands.length === 1) { chosen = cands[0]; status = 'matched'; }
    else if (cands.length > 1) {
      chosen = pickCandidate(cands, evidence);
      status = chosen ? 'matched' : 'pick';
    }
    items.push({ number: t.number, total: t.total, status, candidates: cands, chosen, evidence, x: t.cx, y: t.cy, setMatched: found.setMatched });
  }
  return items;
}


/** JSON with sorted keys, ignoring empty values, so two copies of the same data compare equal (the Android app leaves nulls out). */
function stableStringify(v) {
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().filter(k => v[k] !== undefined && v[k] !== null).map(k => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
  return JSON.stringify(v);
}

// ---------- two phones, one sheet: merging binders ----------
//
// Every phone keeps its own running count for each card: e.qd = { phoneId: [count, time] }. The quantity is the sum.
// A phone only ever changes its own count, so merging two copies is simple and nothing is lost: for each phone, take the
// newer of its two counts. Adding a card on two phones gives 2; removing it on one phone takes one away.
// A card whose total is 0 moves to the binder's `dead` list (kept, so the removal still wins), a deleted binder is
// remembered in `gone`.

const qtyOf = e => (e.qd ? Object.values(e.qd).reduce((a, p) => a + p[0], 0) : (e.quantity || 0));

/** Changes this phone's share of a card's count by `delta`, and the quantity with it. */
function bumpQty(e, delta, dev, now) {
  if (!e.qd) e.qd = { [dev]: [e.quantity || 0, e.addedAt || now] };    // a card saved by an older version: its count becomes this phone's
  e.qd[dev] = [(e.qd[dev] ? e.qd[dev][0] : 0) + delta, now];
  e.quantity = qtyOf(e);
  return e;
}

/** A history point as [time, price] (or [time, price, 1] for an estimate). Older Android versions wrote {t, v, est}. */
const asPoint = p => (Array.isArray(p) ? p : p && typeof p === 'object' ? (p.est ? [p.t, p.v, 1] : [p.t, p.v]) : p);

/** Every history in the binders in [time, price] form (reading what older Android versions saved). */
function normalizePoints(lib) {
  const fix = h => (Array.isArray(h) ? h.map(asPoint).filter(p => Array.isArray(p) && isFinite(p[0]) && isFinite(p[1])) : h);
  for (const c of (lib && lib.collections) || []) {
    if (c.hist) c.hist = fix(c.hist);
    for (const e of [...(c.cards || []), ...(c.dead || [])]) { if (e.hist) e.hist = fix(e.hist); if (e.est) e.est = fix(e.est); }
  }
  return lib;
}

/** Two price histories in one: every point once, oldest first, at most one real reading per ~6 hours. */
function mergeHist(a, b) {
  const all = [...(a || []), ...(b || [])].map(asPoint).filter(Array.isArray).sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const p of all) {
    const last = out[out.length - 1];
    if (last && last[0] === p[0]) continue;
    if (last && !last[2] && !p[2] && p[0] - last[0] < 6 * 3600 * 1000) out[out.length - 1] = p;
    else out.push(p);
  }
  return out.length > 400 ? out.slice(out.length - 400) : out;
}

/** Top-5 game scores from two copies: each [score, time] once, best first. */
function mergeTop(a, b) {
  const seen = new Set(), out = [];
  for (const s of [...(a || []), ...(b || [])]) { if (!Array.isArray(s) || seen.has(s[1])) continue; seen.add(s[1]); out.push(s); }
  return out.sort((x, y) => y[0] - x[0] || x[1] - y[1]).slice(0, 5);
}

/** One card from two copies (a = this phone's, b = the sheet's). */
function mergeEntry(a, b) {
  if (!a) return b;
  if (!b) return a;
  if (!a.qd && b.qd) return b;       // a copy from an older version gives way to one with per-phone counts
  if (!b.qd) return a;               // (both old: keep this phone's; it gets its own counts afterwards)
  const newer = (b.priceUpdatedAt || 0) > (a.priceUpdatedAt || 0) ? b : a, older = newer === a ? b : a;
  const out = { ...older, ...newer };
  const qd = {};
  for (const d of new Set([...Object.keys(a.qd), ...Object.keys(b.qd)])) {
    const x = a.qd[d], y = b.qd[d];
    qd[d] = !x ? y : !y ? x : (y[1] > x[1] ? y : x);
  }
  out.qd = qd; out.quantity = qtyOf(out);
  const first = (a.addedAt || Infinity) <= (b.addedAt || Infinity) ? a : b;
  out.addedAt = first.addedAt;
  if (first.priceWhenAdded != null) out.priceWhenAdded = first.priceWhenAdded;
  const h = mergeHist(a.hist, b.hist);
  if (h.length) out.hist = h;
  return out;
}

function mergeBinder(a, b, id) {
  if (!a || !b) { const x = a || b; return { ...x, id, cards: [...(x.cards || [])], dead: [...(x.dead || [])] }; }
  const map = new Map();
  for (const e of [...(a.cards || []), ...(a.dead || [])]) map.set(e.key, e);
  for (const e of [...(b.cards || []), ...(b.dead || [])]) map.set(e.key, mergeEntry(map.get(e.key), e));
  const all = [...map.values()];
  const useB = (b.nameT || 0) > (a.nameT || 0);
  const out = { ...b, ...a, id, name: useB ? b.name : a.name, cards: all.filter(e => qtyOf(e) > 0), dead: all.filter(e => qtyOf(e) <= 0 && e.qd) };
  const nameT = Math.max(a.nameT || 0, b.nameT || 0); if (nameT) out.nameT = nameT;
  const kid = ((b.kidT || 0) > (a.kidT || 0) ? b.kid : a.kid) || b.kid || a.kid;     // the newest choice of character
  const best = Math.max(a.best || 0, b.best || 0); if (best) out.best = best;           // "Who's that Pokémon?" scores
  const top = mergeTop(a.top, b.top); if (top.length) out.top = top;
  if (kid) out.kid = kid;
  const kidT = Math.max(a.kidT || 0, b.kidT || 0); if (kidT) out.kidT = kidT;
  const h = mergeHist(a.hist, b.hist); if (h.length) out.hist = h;
  return out;
}

/**
 * The binders from this phone (`local`) and the sheet (`remote`) in one. Binders match by id, or by name when the ids
 * differ (a binder made separately on each phone). `dev` is this phone's id.
 */
function mergeLibraries(local, remote, dev, now) {
  local = local || {}; remote = remote || {};
  const gone = { ...(remote.gone || {}) };
  for (const [id, t] of Object.entries(local.gone || {})) gone[id] = Math.max(gone[id] || 0, t);
  const L = (local.collections || []).slice(), R = (remote.collections || []).slice();
  const pairs = [];                               // [localBinder, remoteBinder, id]
  const usedR = new Set();
  for (const l of L) { const r = R.find(x => x.id === l.id); if (r) { pairs.push([l, r, r.id]); usedR.add(r); } }
  for (const l of L) {
    if (pairs.some(p => p[0] === l)) continue;
    const r = R.find(x => !usedR.has(x) && String(x.name).trim().toLowerCase() === String(l.name).trim().toLowerCase() && !gone[x.id]);
    if (r) { pairs.push([l, r, r.id]); usedR.add(r); } else pairs.push([l, null, l.id]);
  }
  for (const r of R) if (!usedR.has(r)) pairs.push([null, r, r.id]);
  const collections = pairs.filter(p => !gone[p[2]] && !gone[(p[0] || {}).id]).map(([l, r, id]) => mergeBinder(l, r, id));
  // cards still without per-phone counts (first time with this version) become this phone's
  for (const c of collections) for (const e of c.cards) if (!e.qd) e.qd = { [dev]: [e.quantity || 0, e.addedAt || now] };
  return { collections, gone };
}

// ---------- Pokémon names in English, Japanese and Chinese ----------

/** "ミニリュウex" -> "ミニリュウ", "Pikachu ex" -> "Pikachu". A glued suffix only counts after a non-Latin letter. */
function stripCardSuffix(name) {
  const s = String(name || '').trim();
  const m = /^(.*?)(\s*)(ex|gx|vmax|vstar|break|v)$/i.exec(s);
  if (!m || !m[1]) return s;
  return (m[2] || m[1].slice(-1).charCodeAt(0) > 127) ? m[1].trim() : s;
}

/**
 * rows[i] = [English, Japanese, Simplified Chinese, Traditional Chinese] for Pokédex number i + 1
 * (names from PokeAPI's open data). Lets you type "Dragonair" to find ハクリュー or 哈克龙 cards,
 * and tells you what a card in a language you can't read is called in English.
 */
function makeSpecies(rows) {
  const key = x => String(x || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const local = new Map(), english = [];
  for (const r of rows) {
    const [en, ja, hans, hant] = r;
    if (!en) continue;
    for (const n of [ja, hans, hant]) { const k = key(n); if (k && !local.has(k)) local.set(k, en); }
    english.push({ k: key(en), en, ja, zh: [...new Set([hans, hant].filter(Boolean))] });
  }
  return {
    count: english.length,
    /** English species name for a Japanese or Chinese card name, or null. */
    englishFor(cardName) { return local.get(key(stripCardSuffix(cardName))) || null; },
    /** What an English name is called on cards in this language ('ja' or 'zh'), or null if nothing is close. */
    localNamesFor(query, langKey) {
      const q = key(query);
      if (q.length < 3) return null;
      let hits = english.filter(e => e.k === q);
      if (!hits.length) hits = english.filter(e => e.k.startsWith(q)).slice(0, 3);
      if (!hits.length) {
        const tol = q.length >= 8 ? 2 : q.length >= 5 ? 1 : 0;
        let best = null, bd = tol + 1;
        if (tol) for (const e of english) { const d = lev(q, e.k, bd); if (d < bd) { bd = d; best = e; } }
        if (best) hits = [best];
      }
      if (!hits.length) return null;
      const locals = [...new Set(hits.flatMap(e => (langKey === 'ja' ? [e.ja] : e.zh)).filter(Boolean))];
      return { english: hits.map(e => e.en).join(' / '), locals };
    },
  };
}

// ---------- Pokédex: which Pokémon a card shows ----------

/** The nine generations, by Pokédex number. */
const DEX_GENS = [
  { n: 1, region: 'Kanto', from: 1, to: 151 }, { n: 2, region: 'Johto', from: 152, to: 251 },
  { n: 3, region: 'Hoenn', from: 252, to: 386 }, { n: 4, region: 'Sinnoh', from: 387, to: 493 },
  { n: 5, region: 'Unova', from: 494, to: 649 }, { n: 6, region: 'Kalos', from: 650, to: 721 },
  { n: 7, region: 'Alola', from: 722, to: 809 }, { n: 8, region: 'Galar', from: 810, to: 905 },
  { n: 9, region: 'Paldea', from: 906, to: 1025 },
];

/**
 * Which Pokémon (Pokédex numbers) a card shows, from its name in English, Japanese or Chinese:
 * "Team Rocket's Mewtwo ex" -> [150], "Pikachu & Zekrom-GX" -> [25, 644], "Mr. Mime" isn't "Mime Jr.",
 * "ロケット団のミュウツーex" -> [150]. Trainer and Energy cards -> [].
 */
function makeDex(rows) {
  const words = s => nameKey(s).replace(/♀/g, ' f ').replace(/♂/g, ' m ')
    .replace(/[^a-z0-9\u3040-\u30ff\u3400-\u9fff]+/g, ' ').trim().split(' ').filter(Boolean);
  const cjk = s => String(s || '').normalize('NFKC').toLowerCase().replace(/[\s・·.'’\-:]/g, '');
  const byFirst = new Map(), local = [], names = [];
  rows.forEach((r, i) => {
    const n = i + 1;
    names[n] = r[0];
    const t = words(r[0]);
    if (t.length) { if (!byFirst.has(t[0])) byFirst.set(t[0], []); byFirst.get(t[0]).push({ n, t }); }
    for (const x of r.slice(1)) { const k = cjk(x); if (k) local.push({ n, k }); }
  });
  for (const list of byFirst.values()) list.sort((a, b) => b.t.length - a.t.length);    // "mr mime" before "mr"
  local.sort((a, b) => b.k.length - a.k.length);                                        // ミュウツー before ミュウ
  return {
    count: rows.length,
    gens: DEX_GENS,
    name: n => names[n] || `#${n}`,
    speciesOf(cardName, group) {
      if (group && !/^pok/i.test(group)) return [];                                     // Trainer, Energy
      const found = new Set();
      const t = words(cardName);
      for (let i = 0; i < t.length; i++) {
        for (const sp of byFirst.get(t[i]) || []) {
          if (sp.t.every((w, j) => t[i + j] === w)) { found.add(sp.n); i += sp.t.length - 1; break; }
        }
      }
      let k = cjk(cardName);
      if (/[^\x00-\x7f]/.test(k)) {
        for (const sp of local) if (k.includes(sp.k)) { found.add(sp.n); k = k.split(sp.k).join('\u0000'); }
      }
      return [...found].sort((a, b) => a - b);
    },
  };
}

/** A binder's Pokédex: Pokédex number -> the binder's cards of that Pokémon. */
function binderDex(dex, binder) {
  const caught = new Map();
  for (const e of (binder && binder.cards) || []) {
    for (const n of dex.speciesOf(e.name, e.group)) {
      if (!caught.has(n)) caught.set(n, []);
      caught.get(n).push(e);
    }
  }
  return caught;
}

/**
 * A card the database doesn't have (many Simplified Chinese sets are empty there). We still know what it is
 * from the name and the printed number, so it can go in a binder with no picture and a price you type.
 */
function identifiedCard(lang, name, number, total, setNames) {
  const t = /^\d+$/.test(total || '') ? parseInt(total, 10) : null;
  return {
    id: `manual|${lang}|${t || ''}|${number || ''}|${name || ''}`,
    name: name || 'Unknown card', number: number || null,
    setName: setNames && setNames.length === 1 ? setNames[0] : null, setNames: setNames || [], setId: null, setTotal: t,
    rarity: null, imageSmall: null, imageLarge: null, prices: [], tcgUpdated: null,
    cmTrend: null, cmAvg30: null, cmTrendHolo: null, lang, identified: true,
  };
}
const isIdentified = id => String(id || '').startsWith('manual|');

if (typeof module !== 'undefined') {
  module.exports = {
    LANGS, isCjk, hasCjk, lev, normalizeNumber, parseNumber, tidyNumberText, isHeaderWord, nameScore,
    pickCandidate, decideTwoStage, parseQuery, buildCatalog, nameFromLine, toCard, eurPrice, marketPrice, pickTier, rarityRank,
    normSet, pickGroups, pickProduct, pricesForProduct, ptcgPrices, ptcgQuery, parseMoney, subtypeLabel,
    stripCardSuffix, makeSpecies, identifiedCard, isIdentified, nameKey, DEX_GENS, makeDex, binderDex,
    findNumberTokens, bulkResolve, asPoint, normalizePoints, mergeTop, PRICE_COPY, expandGroups, expandGroupCopy, stableStringify, qtyOf, bumpQty, mergeHist, mergeEntry, mergeBinder, mergeLibraries,
    DAY, pushPoint, priceAt, cmEstimate, fullHist, unitValue, movement, sinceAdded, holdingsSeries, binderAnalytics,
  };
}
