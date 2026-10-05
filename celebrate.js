'use strict';
/*
 * Harper and Jaxon pop up from behind the bottom sheet and cheer when a card goes into their binder.
 * Rarer cards get a bigger reaction. Other binders get the confetti without a kid.
 *
 * Which kid is which lives in KIDS below: swap the two image names to swap them.
 */
const Celebrate = (() => {
  const KIDS = {
    harper: { img: 'char-harper.webp', thumb: 'thumbs-harper.webp', side: 'left' },
    jaxon: { img: 'char-jaxon.webp', thumb: 'thumbs-jaxon.webp', side: 'right' },
  };
  const LINES = {
    common: ['Nice one!', 'Into the binder!', 'Yay!', 'Got it!'],
    uncommon: ['Ooh, nice!', 'Good one!', 'Cool card!'],
    rare: ['Whoa, a rare!', 'So sparkly!', 'Ooh, shiny!'],
    double: ['WOW! So cool!', 'Look at that!!', 'Amazing!'],
    sir: ['NO WAY!!', 'SO SHINY!!', 'BEST CARD EVER!!'],
  };
  const PALETTE = {
    common: ['#BFD9FF', '#FFFFFF', '#9EC5FF'], uncommon: ['#9CFFE2', '#FFFFFF', '#7CF2D1'],
    rare: ['#FFE08A', '#FFFFFF', '#FFD36B'], double: ['#FFB6DE', '#FFE08A', '#FFFFFF'],
    sir: ['#ff7ab6', '#ffd36b', '#7dffc0', '#7cc4ff', '#c38cff', '#ffffff'],
  };
  const AMOUNT = { common: 36, uncommon: 50, rare: 70, double: 95, sir: 130 };
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const pick = a => a[Math.floor(Math.random() * a.length)];
  let timer = null;

  /** 'harper' / 'jaxon' for a binder called that (any capitals, any extra words), else null. */
  function whoIs(binderName) {
    const n = String(binderName || '').toLowerCase();
    return n.includes('harper') ? 'harper' : n.includes('jaxon') ? 'jaxon' : null;
  }

  function confetti(tier, x, y) {
    if (reduce) return;
    const c = document.createElement('canvas');
    c.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:90';
    const dpr = Math.min(2, devicePixelRatio || 1);
    c.width = innerWidth * dpr; c.height = innerHeight * dpr;
    document.body.appendChild(c);
    const g = c.getContext('2d'); g.scale(dpr, dpr);
    const pal = PALETTE[tier] || PALETTE.common;
    const ps = Array.from({ length: AMOUNT[tier] || 36 }, () => {
      const a = -Math.PI / 2 + (Math.random() - .5) * 2.4, v = 260 + Math.random() * 420;
      return { x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, r: 3 + Math.random() * 5, rot: Math.random() * 6, vr: (Math.random() - .5) * 12,
        col: pick(pal), life: 1.1 + Math.random() * 0.9, star: Math.random() < .3 };
    });
    let last = performance.now(), age = 0;
    (function tick(now) {
      const dt = Math.min(.05, (now - last) / 1000); last = now; age += dt;
      g.clearRect(0, 0, innerWidth, innerHeight);
      let alive = 0;
      for (const p of ps) {
        p.vy += 900 * dt; p.vx *= (1 - 0.9 * dt); p.x += p.vx * dt; p.y += p.vy * dt; p.rot += p.vr * dt;
        const t = age / p.life; if (t >= 1) continue; alive++;
        g.save(); g.globalAlpha = 1 - t * t; g.translate(p.x, p.y); g.rotate(p.rot); g.fillStyle = p.col;
        if (p.star) { g.beginPath(); for (let i = 0; i < 8; i++) { const rr = i % 2 ? p.r * .45 : p.r * 1.3, an = i * Math.PI / 4; g.lineTo(Math.cos(an) * rr, Math.sin(an) * rr); } g.fill(); }
        else g.fillRect(-p.r, -p.r * .6, p.r * 2, p.r * 1.2);
        g.restore();
      }
      if (alive) requestAnimationFrame(tick); else c.remove();
    })(last);
  }

  /**
   * @param binder   the binder name (picks the kid)
   * @param card     what was added (its name is used in the speech bubble for rarer cards)
   * @param tier     'common'..'sir' (BinderUI.tierOf)
   * @param count    how many cards were added at once
   * @param anchor   the element whose top edge the kid peeks over (default: the result sheet)
   * @param z        stacking order of the kid (below the anchor)
   */
  function show({ binder, card, tier = 'common', count = 1, anchor = null, z = 3 }) {
    const el = anchor || document.getElementById('dock');
    const kid = whoIs(binder);
    clearTimeout(timer);
    document.querySelectorAll('.cele').forEach(n => n.remove());
    const rect = el ? el.getBoundingClientRect() : { top: innerHeight * .6 };
    const H = Math.round(Math.min(260, innerHeight * 0.32));
    // Room above the sheet: peek over its top edge (the sheet covers the kid's lower half).
    // A tall sheet: pop up from the bottom corner of the screen, in front.
    const behind = !!(el && el.closest && el.closest('#scan-view')) && rect.top - 70 >= H * 0.62;
    const top = behind ? Math.max(70, rect.top - H * 0.66) : innerHeight - H * 0.9;
    confetti(tier, kid && KIDS[kid].side === 'right' ? innerWidth * .78 : innerWidth * .22, Math.max(120, top + H * .25));
    if (!kid) return;

    const k = KIDS[kid];
    const line = count > 1 ? `${count} cards added!`
      : (tier === 'common' || tier === 'uncommon') ? pick(LINES[tier]) : (Math.random() < .5 && card ? `${card.name}!!` : pick(LINES[tier]));
    const root = document.createElement('div');
    root.className = 'cele'; root.style.setProperty('--z', behind ? 3 : (z > 3 ? z : 55));
    const host = behind ? el.closest('#scan-view') : document.body;
    root.style.position = host === document.body ? 'fixed' : 'absolute';
    root.innerHTML = `<div class="cele-kid ${k.side}" style="top:${top}px;height:${H}px">
      <img class="cele-kidimg" src="${k.img}" alt="" draggable="false"><img class="cele-thumb" src="${k.thumb}" alt="" draggable="false"><div class="cele-bubble">${String(line).replace(/[<>&]/g, '')}</div></div>`;
    host.appendChild(root);
    const kidEl = root.firstElementChild, bubble = kidEl.querySelector('.cele-bubble'), thumb = kidEl.querySelector('.cele-thumb');
    const D = reduce ? 1600 : 2700;
    if (reduce) {
      kidEl.animate([{ opacity: 0 }, { opacity: 1, offset: .15 }, { opacity: 1, offset: .85 }, { opacity: 0 }], { duration: D });
    } else {
      kidEl.animate([
        { transform: 'translateY(108%) scale(1,1)', offset: 0 },
        { transform: 'translateY(-9%) scale(.93,1.1)', offset: .14 },
        { transform: 'translateY(3%) scale(1.07,.93)', offset: .22 },
        { transform: 'translateY(0) scale(1,1) rotate(0deg)', offset: .3 },
        { transform: 'translateY(-3%) rotate(-5deg)', offset: .42 },
        { transform: 'translateY(0) rotate(5deg)', offset: .54 },
        { transform: 'translateY(-4%) rotate(-4deg)', offset: .66 },
        { transform: 'translateY(0) rotate(3deg)', offset: .78 },
        { transform: 'translateY(0) rotate(0deg)', offset: .86 },
        { transform: 'translateY(108%)', offset: 1 },
      ], { duration: D, easing: 'cubic-bezier(.3,.7,.3,1)' });
    }
    // the drawn thumbs-up pops in next to the kid and stays until the kid goes
    if (reduce) thumb.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300, delay: 300, fill: 'both' });
    else thumb.animate([
      { transform: 'scale(0) rotate(-24deg)', opacity: 0, offset: 0 },
      { transform: 'scale(1.22) rotate(7deg)', opacity: 1, offset: .55 },
      { transform: 'scale(.95) rotate(-5deg)', opacity: 1, offset: .8 },
      { transform: 'scale(1) rotate(-3deg)', opacity: 1, offset: 1 },
    ], { duration: 560, delay: 760, easing: 'cubic-bezier(.3,.7,.3,1)', fill: 'both' });
    bubble.animate([{ transform: 'scale(0)', opacity: 0 }, { transform: 'scale(1.12)', opacity: 1, offset: .14 }, { transform: 'scale(1)', opacity: 1, offset: .22 },
      { transform: 'scale(1)', opacity: 1, offset: .8 }, { transform: 'scale(.6)', opacity: 0 }], { duration: D - 500, delay: 420, fill: 'both' });
    timer = setTimeout(() => root.remove(), D + 120);
  }

  return { show, whoIs, avatar: kid => (KIDS[kid] ? KIDS[kid].img.replace('char-', 'avatar-') : null) };
})();
