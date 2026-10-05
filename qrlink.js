'use strict';
/*
 * Moving the sync link to another device without typing it: the connected device shows the link as a QR code,
 * and the new device scans it with its camera (handy on tablets where pasting is awkward).
 * The QR libraries (vendor/) load only when needed.
 */
const QRLink = (() => {
  let stream = null, running = false;

  function loadScript(src, globalName) {
    if (window[globalName]) return Promise.resolve();
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src; s.onload = () => res(); s.onerror = () => rej(new Error(`Couldn't load ${src}`));
      document.head.appendChild(s);
    });
  }

  /** An SVG QR code for this text. */
  async function svg(text) {
    await loadScript('vendor/qrcode.min.js', 'qrcode');
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    return qr.createSvgTag({ cellSize: 8, margin: 4, scalable: true });
  }

  /** Watches the camera until it sees a sync link, then calls onFound(link). */
  async function scan(video, onFound) {
    await loadScript('vendor/jsQR.min.js', 'jsQR');
    stop();
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } }, audio: false });
    video.srcObject = stream;
    video.setAttribute('playsinline', ''); video.muted = true;
    await video.play();
    const c = document.createElement('canvas'), g = c.getContext('2d', { willReadFrequently: true });
    running = true;
    const tick = () => {
      if (!running) return;
      if (video.readyState >= 2 && video.videoWidth) {
        const w = Math.min(800, video.videoWidth), h = Math.round(video.videoHeight * w / video.videoWidth);
        c.width = w; c.height = h;
        g.drawImage(video, 0, 0, w, h);
        const code = jsQR(g.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'attemptBoth' });
        const text = code && code.data ? code.data.trim() : '';
        if (text.startsWith('https://script.google.com/')) { stop(); onFound(text); return; }
      }
      setTimeout(tick, 180);                         // about five looks a second
    };
    tick();
  }

  function stop() {
    running = false;
    if (stream) stream.getTracks().forEach(t => t.stop());
    stream = null;
  }

  return { svg, scan, stop, get scanning() { return running; } };
})();
