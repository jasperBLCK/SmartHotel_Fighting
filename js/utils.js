/* ===================================================================
   utils.js — общие мелочи: математика, работа с картинками, звук, тосты.
   Всё живёт в глобальном объекте U (никаких модулей/сборки).
   =================================================================== */

const U = (() => {

  /* ---------- DOM ---------- */
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  /* ---------- Математика ---------- */
  const clamp = (v, a, b) => v < a ? a : (v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const rand = (a, b) => a + Math.random() * (b - a);
  const randInt = (a, b) => Math.floor(rand(a, b + 1));
  const choice = (arr) => arr[Math.floor(Math.random() * arr.length)];

  /* ---------- Цвета игроков (по индексу слота) ---------- */
  const COLORS = ['#ff2d6f', '#00e5ff', '#7cff5a', '#ffb300'];

  /* Осветлить/затемнить hex-цвет. k>0 — светлее, k<0 — темнее. */
  function shade(hex, k) {
    const n = parseInt(hex.slice(1), 16);
    const r = clamp(((n >> 16) & 255) + 255 * k, 0, 255) | 0;
    const g = clamp(((n >> 8) & 255) + 255 * k, 0, 255) | 0;
    const b = clamp((n & 255) + 255 * k, 0, 255) | 0;
    return `rgb(${r},${g},${b})`;
  }
  /* hex -> rgba со своей альфой */
  function rgba(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }

  /* ---------- Картинки ---------- */

  /* Загрузить Image из dataURL/URL. */
  function loadImage(src) {
    return new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = rej;
      img.src = src;
    });
  }

  /*
    Прочитать файл и сжать до dataURL нужного размера.
    Важно: фото НЕ уходит на сервер — только FileReader в памяти браузера,
    а потом (уже сжатое) по P2P-каналу другим игрокам.
    mode 'cover'  — обрезать по центру в квадрат/прямоугольник (для аватара),
    mode 'contain'— вписать целиком (для арены не нужно, но пусть будет).
  */
  function fileToDataURL(file, maxW, maxH, quality = 0.82, mode = 'cover') {
    return new Promise((res, rej) => {
      if (!file || !file.type.startsWith('image/')) return rej(new Error('не картинка'));
      const fr = new FileReader();
      fr.onerror = rej;
      fr.onload = async () => {
        try {
          const img = await loadImage(fr.result);
          const cv = document.createElement('canvas');
          cv.width = maxW; cv.height = maxH;
          const c = cv.getContext('2d');
          c.imageSmoothingQuality = 'high';

          const sr = img.width / img.height, dr = maxW / maxH;
          let sw, sh, sx, sy;
          if (mode === 'cover') {
            if (sr > dr) { sh = img.height; sw = sh * dr; }
            else { sw = img.width; sh = sw / dr; }
            sx = (img.width - sw) / 2; sy = (img.height - sh) / 2;
            c.drawImage(img, sx, sy, sw, sh, 0, 0, maxW, maxH);
          } else {
            const s = Math.min(maxW / img.width, maxH / img.height);
            const w = img.width * s, h = img.height * s;
            c.drawImage(img, (maxW - w) / 2, (maxH - h) / 2, w, h);
          }
          res(cv.toDataURL('image/jpeg', quality));
        } catch (e) { rej(e); }
      };
      fr.readAsDataURL(file);
    });
  }

  /* Дефолтный аватар — неоновый смайлик в цвет игрока (с кэшем по цвету). */
  const avatarCache = {};
  function defaultAvatar(color) {
    if (avatarCache[color]) return avatarCache[color];
    const S = 180;
    const cv = document.createElement('canvas');
    cv.width = cv.height = S;
    const c = cv.getContext('2d');

    const g = c.createLinearGradient(0, 0, S, S);
    g.addColorStop(0, shade(color, .05));
    g.addColorStop(1, shade(color, -.32));
    c.fillStyle = g; c.fillRect(0, 0, S, S);

    // лёгкая сетка для фактуры
    c.strokeStyle = 'rgba(255,255,255,.10)'; c.lineWidth = 1;
    for (let i = 0; i < S; i += 18) {
      c.beginPath(); c.moveTo(i, 0); c.lineTo(i, S); c.stroke();
      c.beginPath(); c.moveTo(0, i); c.lineTo(S, i); c.stroke();
    }

    // мордочка
    c.fillStyle = 'rgba(0,0,0,.78)';
    c.beginPath(); c.ellipse(S * .35, S * .40, 11, 15, 0, 0, 7); c.fill();
    c.beginPath(); c.ellipse(S * .65, S * .40, 11, 15, 0, 0, 7); c.fill();
    c.strokeStyle = 'rgba(0,0,0,.78)'; c.lineWidth = 9; c.lineCap = 'round';
    c.beginPath(); c.arc(S * .5, S * .55, S * .24, .25 * Math.PI, .75 * Math.PI); c.stroke();

    return (avatarCache[color] = cv.toDataURL('image/jpeg', .85));
  }

  /* ---------- Звук: маленький синтезатор на WebAudio (без файлов) ---------- */
  const sfx = (() => {
    let ac = null;
    const ctx = () => {
      if (!ac) { try { ac = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { } }
      if (ac && ac.state === 'suspended') ac.resume();
      return ac;
    };
    let muted = false;

    /* Один тон с огибающей. */
    function tone({ f = 440, f2 = null, t = .09, type = 'square', vol = .18, delay = 0 }) {
      const a = ctx(); if (!a || muted) return;
      const t0 = a.currentTime + delay;
      const o = a.createOscillator(), g = a.createGain();
      o.type = type;
      o.frequency.setValueAtTime(f, t0);
      if (f2) o.frequency.exponentialRampToValueAtTime(Math.max(20, f2), t0 + t);
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(vol, t0 + .006);
      g.gain.exponentialRampToValueAtTime(.0001, t0 + t);
      o.connect(g).connect(a.destination);
      o.start(t0); o.stop(t0 + t + .02);
    }
    /* Шумовой всплеск — для ударов. */
    function noise({ t = .12, vol = .2, hp = 700, delay = 0 }) {
      const a = ctx(); if (!a || muted) return;
      const t0 = a.currentTime + delay;
      const len = Math.ceil(a.sampleRate * t);
      const buf = a.createBuffer(1, len, a.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
      const src = a.createBufferSource(); src.buffer = buf;
      const f = a.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = hp;
      const g = a.createGain(); g.gain.setValueAtTime(vol, t0);
      g.gain.exponentialRampToValueAtTime(.0001, t0 + t);
      src.connect(f).connect(g).connect(a.destination);
      src.start(t0);
    }

    return {
      unlock: () => ctx(),
      toggle: () => (muted = !muted, muted),
      isMuted: () => muted,
      swing:  () => noise({ t: .07, vol: .06, hp: 1800 }),                     // промах
      punch:  () => { noise({ t: .10, vol: .22, hp: 500 }); tone({ f: 190, f2: 60, t: .10, vol: .16 }); },
      kick:   () => { noise({ t: .16, vol: .28, hp: 260 }); tone({ f: 120, f2: 40, t: .18, vol: .22, type: 'sawtooth' }); },
      block:  () => { tone({ f: 900, f2: 1400, t: .07, vol: .13, type: 'triangle' }); noise({ t: .05, vol: .08, hp: 3000 }); },
      death:  () => { tone({ f: 320, f2: 45, t: .55, vol: .22, type: 'sawtooth' }); noise({ t: .4, vol: .16, hp: 200 }); },
      // пролом блока — резкий «хруст» с металлическим призвуком
      guardBreak: () => {
        noise({ t: .22, vol: .3, hp: 400 });
        tone({ f: 220, f2: 90, t: .25, vol: .2, type: 'square' });
        tone({ f: 1400, f2: 700, t: .18, vol: .12, type: 'triangle', delay: .03 });
      },
      // тяжёлый вдох на отдышке
      winded: () => { noise({ t: .3, vol: .12, hp: 900 }); noise({ t: .25, vol: .09, hp: 1400, delay: .3 }); },
      spawn:  () => { tone({ f: 420, f2: 880, t: .16, vol: .14, type: 'triangle' }); tone({ f: 660, f2: 1320, t: .16, vol: .10, type: 'triangle', delay: .07 }); },
      jump:   () => tone({ f: 340, f2: 620, t: .07, vol: .07, type: 'triangle' }),
      ui:     () => tone({ f: 620, f2: 780, t: .05, vol: .08, type: 'triangle' }),
      // подколка: дразнящая «ду-ду-дуу», у каждой кнопки свой мотив
      taunt:  (i = 0) => {
        const seq = [[660, 560, 440], [880, 700, 880], [330, 300, 260],
                     [520, 660, 780], [740, 620, 900]][i % 5];
        seq.forEach((f, n) => tone({ f, t: .13, vol: .13, type: 'square', delay: n * .11 }));
      },
      join:   () => { tone({ f: 520, t: .08, vol: .10, type: 'triangle' }); tone({ f: 780, t: .10, vol: .10, type: 'triangle', delay: .08 }); },
      win:    () => [0, .12, .24, .42].forEach((d, i) => tone({ f: [523, 659, 784, 1046][i], t: .3, vol: .16, type: 'triangle', delay: d })),
      bell:   () => { tone({ f: 880, t: .5, vol: .2, type: 'triangle' }); tone({ f: 1320, t: .5, vol: .12, type: 'triangle', delay: .01 }); },
    };
  })();

  /* ---------- Тосты ---------- */
  function toast(msg) {
    const box = document.getElementById('toast');
    const el = document.createElement('div');
    el.className = 'toast-item';
    el.textContent = msg;
    box.appendChild(el);
    setTimeout(() => el.remove(), 3100);
  }

  /* ---------- Код комнаты ---------- */
  const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // без похожих символов (0/O, 1/I)
  const makeCode = (n = 5) => Array.from({ length: n }, () => choice(ALPHABET.split(''))).join('');

  /* Поддержка drag&drop для элемента-дропзоны. */
  function dropZone(el, onFile) {
    ['dragenter', 'dragover'].forEach(ev => el.addEventListener(ev, e => {
      e.preventDefault(); el.classList.add('drag');
    }));
    ['dragleave', 'drop'].forEach(ev => el.addEventListener(ev, e => {
      e.preventDefault(); el.classList.remove('drag');
    }));
    el.addEventListener('drop', e => {
      const f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) onFile(f);
    });
  }

  return { $, $$, clamp, lerp, rand, randInt, choice, COLORS, shade, rgba,
           loadImage, fileToDataURL, defaultAvatar, sfx, toast, makeCode, dropZone };
})();
