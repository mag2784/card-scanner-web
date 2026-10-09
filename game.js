'use strict';
/*
 * "Who's that Pokémon?": a quiz with the binder's own cards. Each round hides one card one of three ways and slowly
 * gives more away; pick the right name of four. The faster the answer, the more points.
 *   shadow - the card starts as stark black-and-white shapes and slowly gets its colour back
 *   peek   - tiles come off the card one by one
 *   zoom   - starts zoomed into one small part and zooms out
 * The printed name stays covered; hints show its first letters part way through.
 * Two modes: "My binder" (the binder's own Pokémon) and "All Pokémon" (any Pokémon from the whole card list).
 * Scores are kept on the binder (best + top 5, separately per mode), so they sync like the cards do.
 */
const Game = (() => {
  const ROUNDS = 10, SECONDS = 12, CELLS = 48, MODES = ['shadow', 'peek', 'zoom'];
  let allPool = null;                                         // "All Pokémon": Pokédex number -> cards, built once
  const st = { mode: (() => { try { return localStorage.getItem('gameMode') === 'all' ? 'all' : 'binder'; } catch (e) { return 'binder'; } })(), id: null, phase: 'start', rounds: [], i: 0, score: 0, correct: 0, t0: 0, raf: 0, answered: false, timer: 0, last: null };
  const binder = () => store.collections.find(c => c.id === st.id);
  const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const fmt = n => n.toLocaleString('en-US');
  /** The shadow look at progress p (0..1): stark black-and-white shapes, colour coming back. */
  const shadow = p => `grayscale(${(1 - p * p).toFixed(3)}) contrast(${(9 - 8 * Math.pow(p, .8)).toFixed(2)}) brightness(${(.62 + .38 * p).toFixed(3)})`;
  const pointsFor = t => (t >= SECONDS ? 100 : Math.max(100, Math.round((1000 - 900 * t / SECONDS) / 10) * 10));

  /** Pokédex number -> this binder's cards of it that have a picture. */
  function pool(c) {
    const out = new Map();
    for (const [n, cards] of binderDex(species.dex, c)) {
      const pics = cards.filter(e => e.imageLarge || e.imageSmall);
      if (pics.length) out.set(n, pics);
    }
    return out;
  }

  const keys = () => (st.mode === 'all' ? ['bestAll', 'topAll'] : ['best', 'top']);

  /** The whole English card list as a game pool (downloads it the first time). */
  async function loadAll() {
    if (allPool) return allPool;
    const cat = await catalogs.en.load();
    allPool = allPokemonPool(species.dex, cat.cards);
    return allPool;
  }

  /** "All Pokémon": 10 random Pokémon from the whole card list; the wrong answers come from the same generation. */
  function makeAllRounds() {
    const dex = species.dex, p = allPool, have = [...p.keys()];
    const modes = shuffle([...MODES, ...MODES, ...MODES, ...MODES]);
    return shuffle(have.slice()).slice(0, ROUNDS).map((n, k) => {
      const list = p.get(n), b = list[Math.floor(Math.random() * list.length)];
      const g = dex.gens.find(x => n >= x.from && n <= x.to), others = [];
      while (others.length < 3) {
        const r = g.from + Math.floor(Math.random() * (g.to - g.from + 1));
        if (r !== n && !others.includes(r)) others.push(r);
      }
      return {
        n, e: { name: b.name }, img: `${b.image}/high.png`, mode: modes[k],
        choices: shuffle([n, ...others]), cells: shuffle([...Array(CELLS).keys()]),
        origin: `${Math.round(25 + Math.random() * 50)}% ${Math.round(18 + Math.random() * 20)}%`,
      };
    });
  }

  function makeRounds(c) {
    const dex = species.dex, p = pool(c), owned = [...p.keys()];
    const modes = shuffle([...MODES, ...MODES, ...MODES, ...MODES]);
    return shuffle(owned.slice()).slice(0, ROUNDS).map((n, k) => {
      const cards = p.get(n), e = cards[Math.floor(Math.random() * cards.length)];
      const others = shuffle(owned.filter(x => x !== n)).slice(0, 3);
      const g = dex.gens.find(x => n >= x.from && n <= x.to);
      while (others.length < 3) {                     // not enough in the binder: Pokémon from the same generation
        const r = g.from + Math.floor(Math.random() * (g.to - g.from + 1));
        if (r !== n && !others.includes(r)) others.push(r);
      }
      return {
        n, e, img: e.imageLarge || e.imageSmall, mode: modes[k],
        choices: shuffle([n, ...others]), cells: shuffle([...Array(CELLS).keys()]),
        origin: `${Math.round(25 + Math.random() * 50)}% ${Math.round(18 + Math.random() * 20)}%`,    // inside the art
      };
    });
  }

  function hint(name, p) {
    if (p < .5) return '';
    const show = p < .75 ? 1 : Math.min(name.length - 1, 2);
    return 'Hint: ' + [...name].map((ch, i) => (i < show || !/[a-z0-9]/i.test(ch) ? ch : '_')).join(' ');
  }

  // ---------- screens ----------
  function startHtml(c) {
    const dex = species.dex, n = dex ? pool(c).size : 0, av = Celebrate.avatar(kidOf(c)), all = st.mode === 'all';
    const [bk, tk] = keys();
    const top = (c[tk] || []).map((s, i) => `<li><b>${i + 1}.</b> ${fmt(s[0])} <span class="muted">${new Date(s[1]).toLocaleDateString()}</span></li>`).join('');
    return `<div class="an-wrap gm-start">
      <header class="an-top"><button class="an-back" data-gm="close">‹ Binder</button></header>
      <h1 class="an-title">${av ? `<img class="av" src="${av}" alt="">` : ''}Who's that Pokémon?</h1>
      <div class="gm-modes" role="group" aria-label="Which Pokémon">
        <button type="button" data-gm="mode" data-v="binder" aria-pressed="${!all}">My binder</button>
        <button type="button" data-gm="mode" data-v="all" aria-pressed="${all}">All Pokémon</button>
      </div>
      <div class="an-card">
        <p>${all ? 'A card of any Pokémon, from every set, is hidden.' : `A card from ${esc(binderTitle(c.name))} is hidden.`} Pick its name as fast as you can: quick answers score up to 1,000 points.</p>
        <p class="muted small">10 rounds. Shadows get their colour back, tiles come off, or the picture zooms out, a little more every second.${all ? ' Tricky: the other answers are Pokémon from the same region.' : ''}</p>
        ${all || n >= 4 ? `<button class="gm-play" data-gm="play">Play</button>`
          : `<p class="gm-need">You need at least 4 different Pokémon cards with pictures in this binder to play (it has ${n}). Try All Pokémon!</p>`}
      </div>
      <div class="an-card"><h3>Best scores${all ? ': All Pokémon' : ''}</h3>${c[bk] ? `<div class="gm-best">${fmt(c[bk])}</div><ol class="gm-top">${top}</ol>` : '<p class="muted">No games yet. Be the first!</p>'}</div>
    </div>`;
  }

  function roundHtml() {
    const r = st.rounds[st.i], dex = species.dex;
    return `<div class="an-wrap gm-round">
      <header class="gm-head"><button class="an-back" data-gm="quit">‹ Quit</button>
        <span>Round ${st.i + 1} of ${st.rounds.length}</span><b id="gmScore">${fmt(st.score)}</b></header>
      <div class="gm-timer"><span id="gmBar"></span></div>
      <div class="gm-stage">
        <div class="gm-card mode-${r.mode}" id="gmCard">
          <img id="gmImg" src="${esc(r.img)}" alt="Hidden card" draggable="false">
          ${r.mode === 'peek' ? `<div class="gm-peek">${r.cells.map(i => `<i data-c="${i}"></i>`).join('')}</div>` : ''}
          <div class="gm-namebar" id="gmName">? ? ?</div>
          <div class="gm-pts" id="gmPts"></div>
        </div>
        <div class="gm-hint" id="gmHint" aria-live="polite"></div>
      </div>
      <div class="gm-choices">${r.choices.map(n => `<button type="button" data-gm="pick" data-n="${n}">${esc(dex.name(n))}</button>`).join('')}</div>
    </div>`;
  }

  function endHtml(c, res) {
    const av = Celebrate.avatar(kidOf(c));
    const [bk, tk] = keys();
    const top = (c[tk] || []).map((s, i) => `<li class="${s[1] === res.at ? 'me' : ''}"><b>${i + 1}.</b> ${fmt(s[0])}</li>`).join('');
    return `<div class="an-wrap gm-end">
      <header class="an-top"><button class="an-back" data-gm="close">‹ Binder</button></header>
      <h1 class="an-title">${av ? `<img class="av" src="${av}" alt="">` : ''}${res.isBest ? 'New best score!' : 'Nice playing!'}</h1>
      <div class="an-card gm-final"><div class="gm-best">${fmt(st.score)}</div>
        <p>${st.correct} of ${st.rounds.length} right${res.isBest ? '' : ` · best ${fmt(c[bk])}`}${st.mode === 'all' ? ' · All Pokémon' : ''}</p>
        <button class="gm-play" data-gm="play">Play again</button></div>
      <div class="an-card"><h3>Best scores</h3><ol class="gm-top">${top}</ol></div>
    </div>`;
  }

  // ---------- a round ----------
  function tick() {
    if (st.answered) return;
    const r = st.rounds[st.i], el = $('#game');
    const t = (performance.now() - st.t0) / 1000, p = Math.min(1, t / SECONDS);
    const bar = $('#gmBar'); if (bar) bar.style.width = `${(1 - p) * 100}%`;
    const img = $('#gmImg');
    if (img && r.mode === 'shadow') img.style.filter = shadow(p);
    if (img && r.mode === 'zoom') img.style.transform = `scale(${(1 + 3.6 * Math.pow(1 - p, 1.4)).toFixed(3)})`;
    if (r.mode === 'peek') {
      const show = Math.floor(CELLS * Math.min(1, p * 1.05));
      el.querySelectorAll('.gm-peek i').forEach(cell => { if (r.cells.indexOf(Number(cell.dataset.c)) < show) cell.classList.add('off'); });
    }
    const h = $('#gmHint'); if (h) h.textContent = hint(species.dex.name(r.n), p);
    if (p >= 1) { answer(null); return; }
    st.raf = requestAnimationFrame(tick);
  }

  function beginRound() {
    st.answered = false;
    const el = $('#game'); el.innerHTML = roundHtml(); el.scrollTop = 0;
    const r = st.rounds[st.i], img = $('#gmImg');
    if (r.mode === 'zoom') img.style.transformOrigin = r.origin;
    if (r.mode === 'shadow') img.style.filter = shadow(0);
    if (r.mode === 'zoom') img.style.transform = 'scale(4.6)';
    const go = () => { if (st.phase === 'round' && !st.answered && !st.raf) { st.t0 = performance.now(); st.raf = requestAnimationFrame(tick); } };
    st.raf = 0;
    if (img.complete && img.naturalWidth) go(); else { img.onload = go; img.onerror = go; }  // the clock starts when the card shows
    const next = st.rounds[st.i + 1]; if (next) { const pre = new Image(); pre.src = next.img; }
  }

  function answer(n) {
    if (st.answered) return;
    st.answered = true; cancelAnimationFrame(st.raf); st.raf = 0;
    const r = st.rounds[st.i], t = (performance.now() - st.t0) / 1000, right = n === r.n;
    const pts = right ? pointsFor(t) : 0;
    st.score += pts; if (right) st.correct++;
    const card = $('#gmCard'); card.classList.add('shown');
    const img = $('#gmImg'); img.style.filter = ''; img.style.transform = '';
    $('#gmName').textContent = species.dex.name(r.n);
    $('#gmHint').textContent = right ? '' : n == null ? `Time's up! It's ${species.dex.name(r.n)}.` : `It's ${species.dex.name(r.n)}!`;
    $('#gmPts').textContent = right ? `+${pts}` : '';
    $('#gmScore').textContent = fmt(st.score);
    document.querySelectorAll('[data-gm=pick]').forEach(b => {
      const bn = Number(b.dataset.n); b.disabled = true;
      if (bn === r.n) b.classList.add('right'); else if (bn === n) b.classList.add('wrong');
    });
    buzz();
    st.timer = setTimeout(() => { st.i++; if (st.i < st.rounds.length) beginRound(); else finish(); }, right ? 1500 : 2300);
  }

  function finish() {
    st.phase = 'end';
    const c = binder(); if (!c) { close(); return; }
    const res = store.recordScore(c.id, st.score, st.mode === 'all');
    $('#game').innerHTML = endHtml(binder(), res);
    if (res.isBest && st.score > 0) { Celebrate.show({ kid: kidOf(c), card: null, tier: 'sir', line: 'New best score!', z: 50 }); Sounds.play(99); }
  }

  function stop() { cancelAnimationFrame(st.raf); st.raf = 0; clearTimeout(st.timer); st.answered = true; }

  async function open(id) {
    st.id = id; st.phase = 'start';
    const el = $('#game'); el.hidden = false; el.scrollTop = 0;
    if (!species.dex) { el.innerHTML = '<div class="an-wrap"><p style="margin-top:40vh;text-align:center">Getting ready…</p></div>'; await species.load(); }
    const c = binder(); if (!c) { close(); return; }
    el.innerHTML = startHtml(c);
  }
  async function play() {
    const c = binder(); if (!c || !species.dex) return;
    if (st.mode === 'all') {
      if (!allPool) {
        const btn = $('#game [data-gm=play]'); if (btn) { btn.disabled = true; btn.textContent = 'Getting the card list…'; }
        try { await loadAll(); } catch (e) {
          if (btn) { btn.disabled = false; btn.textContent = 'Play'; }
          toast("Couldn't download the card list. Check the internet and try again."); return;
        }
        if ($('#game').hidden || st.mode !== 'all') return;
      }
      st.rounds = makeAllRounds();
    } else st.rounds = makeRounds(c);
    st.i = 0; st.score = 0; st.correct = 0; st.phase = 'round';
    if (st.rounds.length < 4) { open(st.id); return; }
    beginRound();
  }
  function close() { stop(); st.phase = 'start'; $('#game').hidden = true; if (app.view === 'binders') renderBinders(); }

  document.addEventListener('click', ev => {
    const root = $('#game'); if (!root || root.hidden || !root.contains(ev.target)) return;
    const b = ev.target.closest('[data-gm]'); if (!b) return;
    const k = b.dataset.gm;
    if (k === 'close') close();
    else if (k === 'quit') { stop(); open(st.id); }
    else if (k === 'play') play();
    else if (k === 'mode') { st.mode = b.dataset.v; try { localStorage.setItem('gameMode', st.mode); } catch (e) { /* private mode */ } open(st.id); }
    else if (k === 'pick') answer(Number(b.dataset.n));
  });

  return { open, close, pointsFor, hint };
})();
