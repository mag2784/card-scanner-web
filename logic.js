'use strict';
/*
 * Card Scanner (web): pure logic, no DOM.
 * Parsing OCR text, matching card names, the card catalog, and card lookups.
 * Mirrors the Android app's scan/ and data/ packages.
 */

const API = 'https://api.tcgdex.net/v2';

const LANGS = {
  en: { label: 'EN', codes: ['en'], tess: ['eng'], listName: 'card list' },
  ja: { label: '日本語', codes: ['ja'], tess: ['jpn'], listName: 'Japanese card list' },
  zh: { label: '中文', codes: ['zh-tw', 'zh-cn'], tess: ['chi_tra', 'chi_sim'], listName: 'Chinese card lists' },
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
  for (const b of cards) if (b.name) names.set(b.name.toLowerCase(), b.name);
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
    /** Closest real card name to what OCR read, or null. */
    resolveName(raw) {
      const key = String(raw || '').toLowerCase().trim();
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
        const hit = cat.names.get(t.slice(i, i + len).toLowerCase());
        if (hit) return hit;
      }
    }
    return t.length >= 3 ? cat.resolveName(t) : null;
  }
  const words = line
    .replace(/[^A-Za-zÀ-ÿ'’.\-♀♂ ]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 2 && !isHeaderWord(w));
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

/** TCGdex full card -> what the app shows. */
function toCard(r, lang) {
  if (!r || !r.id || !r.name) return null;
  const pos = v => (typeof v === 'number' && v > 0 ? v : null);
  const tp = (r.pricing && r.pricing.tcgplayer) || null;
  const cm = (r.pricing && r.pricing.cardmarket) || null;
  const prices = tp ? Object.entries(tp)
    .filter(([, v]) => v && typeof v === 'object')
    .map(([k, v]) => ({ label: variantLabel(k), market: pos(v.marketPrice), low: pos(v.lowPrice), high: pos(v.highPrice) }))
    : [];
  return {
    id: r.id,
    name: r.name,
    number: r.localId ? normalizeNumber(r.localId) : null,
    setName: (r.set && r.set.name) || null,
    setTotal: (r.set && r.set.cardCount && r.set.cardCount.official) || null,
    rarity: r.rarity || null,
    imageSmall: r.image ? r.image + '/low.png' : null,
    imageLarge: r.image ? r.image + '/high.png' : null,
    prices,
    tcgUpdated: tp && typeof tp.updated === 'string' ? tp.updated.slice(0, 10) : null,
    cmTrend: pos(cm && cm.trend),
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

if (typeof module !== 'undefined') {
  module.exports = {
    LANGS, isCjk, hasCjk, lev, normalizeNumber, parseNumber, tidyNumberText, isHeaderWord, nameScore,
    pickCandidate, parseQuery, buildCatalog, nameFromLine, toCard, eurPrice, marketPrice, pickTier, rarityRank,
  };
}
