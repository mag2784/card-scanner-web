// Saves a compact daily copy of TCGplayer's Pokémon prices from TCGCSV, for the web app.
// Browsers aren't allowed to read TCGCSV directly (its CORS policy), so a nightly GitHub Action runs this and publishes
// the files to this repo's `prices` branch, which the app reads from raw.githubusercontent.com.
//
// Follows TCGCSV's guidelines: a descriptive User-Agent, a few hundred requests a day, a little at a time.
//   node scripts/prices.mjs <outDir>
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const UA = 'CardScannerWeb/1.0 (personal card collection app; github.com/mag2784/card-scanner-web)';
const BASE = 'https://tcgcsv.com/tcgplayer/3';          // category 3 = Pokémon (English)

const r2 = v => (v == null || !isFinite(v) ? null : Math.round(v * 100) / 100);
const numberOf = p => ((p.extendedData || []).find(e => e.name === 'Number') || {}).value || null;

/**
 * One set in a small form: the single cards only (they have a collector number), each with its prices per version.
 *   { g, name, abbr, cards: [[productId, name, number, [[version, market, low, high], ...]], ...] }
 */
export function compactGroup(group, products, prices) {
  const byProduct = new Map();
  for (const p of prices || []) {
    if (!byProduct.has(p.productId)) byProduct.set(p.productId, []);
    byProduct.get(p.productId).push([p.subTypeName || 'Normal', r2(p.marketPrice), r2(p.lowPrice), r2(p.highPrice)]);
  }
  const cards = [];
  for (const p of products || []) {
    const n = numberOf(p);
    if (!n) continue;                                   // sealed products, code cards...
    cards.push([p.productId, p.cleanName || p.name, n, byProduct.get(p.productId) || []]);
  }
  return { g: group.groupId, name: group.name, abbr: group.abbreviation || null, cards };
}

async function get(url, tries = 3) {
  for (let i = 1; ; i++) {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
    if (r.ok) return (await r.json()).results || [];
    const body = (await r.text()).slice(0, 200);
    if (i >= tries || r.status < 500) throw new Error(`${url} -> HTTP ${r.status}: ${body}`);
    await new Promise(s => setTimeout(s, 1500 * i));
  }
}

async function main(out) {
  await mkdir(out, { recursive: true });
  const groups = await get(`${BASE}/groups`);
  const at = new Date().toISOString();
  let done = 0, singles = 0, failed = 0;
  const queue = groups.slice();
  async function worker() {
    for (let g; (g = queue.shift());) {
      try {
        const [products, prices] = await Promise.all([get(`${BASE}/${g.groupId}/products`), get(`${BASE}/${g.groupId}/prices`)]);
        const c = compactGroup(g, products, prices);
        c.at = at;
        await writeFile(`${out}/${g.groupId}.json`, JSON.stringify(c));
        singles += c.cards.length;
      } catch (e) { failed++; console.error(String(e)); }
      done++;
      if (done % 25 === 0) console.log(`${done}/${groups.length} sets`);
    }
  }
  await Promise.all([worker(), worker(), worker()]);   // three at a time
  await writeFile(`${out}/groups.json`, JSON.stringify({ at, groups: groups.map(g => [g.groupId, g.name, g.abbreviation || null]) }));
  console.log(`Saved ${groups.length} sets, ${singles} cards; ${failed} sets failed.`);
  if (failed > groups.length / 4) throw new Error('Too many sets failed; not publishing.');
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main(process.argv[2] || 'out').catch(e => { console.error(e); process.exit(1); });
}
