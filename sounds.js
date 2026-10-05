'use strict';
/*
 * A sound when cards go into a binder: a card worth $10 or less takes turns between "ohhh", "what" and "wow";
 * anything worth more than $10 plays "omg". (A card with no price counts as $10 or less.)
 * Phones only allow sound after a tap, so the audio is woken up on the first tap anywhere.
 */
const Sounds = (() => {
  const SMALL = ['ohhh', 'what', 'wow'];
  let ctx = null, loading = null;
  const buffers = {};
  let turn = Number(localStorage.getItem('soundTurn') || 0) % SMALL.length;

  function context() {
    if (!ctx) { const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return null; ctx = new AC(); }
    return ctx;
  }
  function load() {
    if (loading) return loading;
    const c = context();
    if (!c) return Promise.resolve();
    loading = Promise.all([...SMALL, 'omg'].map(n => fetch(`sounds/${n}.mp3`).then(r => r.arrayBuffer())
      .then(b => new Promise((res, rej) => { const p = c.decodeAudioData(b, res, rej); if (p && p.catch) p.catch(() => {}); })).then(buf => { buffers[n] = buf; }).catch(() => {})));
    return loading;
  }
  function unlock() { const c = context(); if (c && c.state === 'suspended') c.resume(); load(); }
  for (const t of ['pointerdown', 'touchend', 'keydown']) document.addEventListener(t, unlock, { passive: true });

  /** Which sound a card of this value gets (and moves the turn along for the small ones). */
  function pick(value) {
    if (value != null && value > 10) return 'omg';
    const name = SMALL[turn];
    turn = (turn + 1) % SMALL.length;
    try { localStorage.setItem('soundTurn', String(turn)); } catch (e) { /* private mode */ }
    return name;
  }

  async function play(value) {
    const name = pick(value);
    Sounds.last = name;
    const c = context();
    if (!c) return name;
    try {
      if (c.state === 'suspended') await c.resume();
      await load();
      const buf = buffers[name];
      if (buf) { const src = c.createBufferSource(); src.buffer = buf; src.connect(c.destination); src.start(); }
    } catch (e) { /* no sound is fine */ }
    return name;
  }

  return { play, pick, last: null };
})();
