/* ===================================================================
   game.js — игровой цикл, авторитетная симуляция хоста, отрисовка.

   Схема:
     ХОСТ   считает физику 60 раз в секунду и рассылает снапшоты ~25 Гц.
     КЛИЕНТ шлёт хосту только маску нажатых клавиш, рисует то, что пришло,
            интерполируя между двумя последними снапшотами.
   =================================================================== */

const Game = (() => {

  const TICK = 1000 / 60;         // шаг симуляции
  const SEND_EVERY = 40;          // как часто хост шлёт состояние (мс)
  const INTERP_MS = 110;          // буфер интерполяции у клиента (мс)

  let canvas, ctx, dpr = 1;
  let view = { scale: 1, ox: 0, oy: 0 };   // масштаб/сдвиг мира внутри канваса

  let running = false;
  let isHost = false;
  let myPid = null;
  let killLimit = 10;
  let over = null;                // {winner, table} когда бой окончен

  let fighters = new Map();       // pid -> Fighter
  let order = [];                 // порядок слотов (для цветов и табло)

  let arenaImg = null;            // фото арены (или null → рисуем процедурный фон)
  let particles = [];
  let floaters = [];              // всплывающие цифры урона
  let shake = 0, hitstop = 0;

  // ---- инпут ----
  let localMask = 0, lastSentMask = -1, lastSendTime = 0;
  const inputs = new Map();       // pid -> текущая маска (у хоста)
  const prevInputs = new Map();   // pid -> маска прошлого тика

  // ---- сетевые буферы клиента ----
  let snaps = [];                 // [{ts, players:[...]}]
  let lastFxSeq = -1;

  let acc = 0, lastT = 0, fps = 60, fpsT = 0, fpsN = 0;

  /* =================================================================
     ИНИЦИАЛИЗАЦИЯ
     ================================================================= */
  function init() {
    canvas = document.getElementById('canvas');
    ctx = canvas.getContext('2d', { alpha: false });
    window.addEventListener('resize', resize);
    bindKeys();
    resize();
  }

  function resize() {
    if (!canvas) return;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    // вписываем мир 1600x900 целиком (letterbox)
    const s = Math.min(w / ARENA.W, h / ARENA.H);
    view.scale = s;
    view.ox = (w - ARENA.W * s) / 2;
    view.oy = (h - ARENA.H * s) / 2;
  }

  /* ---------------- Клавиатура ---------------- */
  const KEYMAP = {
    'KeyA': K.LEFT, 'ArrowLeft': K.LEFT,
    'KeyD': K.RIGHT, 'ArrowRight': K.RIGHT,
    'KeyW': K.UP, 'ArrowUp': K.UP, 'Space': K.UP,
    'KeyS': K.DOWN, 'ArrowDown': K.DOWN,
    'KeyJ': K.PUNCH,
    'KeyK': K.KICK,
    'KeyL': K.BLOCK, 'ShiftLeft': K.BLOCK, 'ShiftRight': K.BLOCK,
  };

  function bindKeys() {
    window.addEventListener('keydown', (e) => {
      const bit = KEYMAP[e.code];
      if (!bit || !running) return;
      e.preventDefault();
      if (e.repeat) return;
      localMask |= bit;
      pushLocalInput();
    });
    window.addEventListener('keyup', (e) => {
      const bit = KEYMAP[e.code];
      if (!bit) return;
      localMask &= ~bit;
      if (running) pushLocalInput();
    });
    // при потере фокуса отпускаем всё, иначе персонаж «залипает»
    window.addEventListener('blur', () => { localMask = 0; pushLocalInput(); });
  }

  /* Клиент отправляет маску хосту; хост просто кладёт себе. */
  function pushLocalInput() {
    if (isHost) { inputs.set(myPid, localMask); return; }
    if (localMask !== lastSentMask) {
      lastSentMask = localMask;
      Net.toHost({ t: 'in', k: localMask });
    }
  }

  /* =================================================================
     СТАРТ / СТОП БОЯ
     players: [{pid, name, avatar(dataURL|null)}] — порядок задаёт слоты
     ================================================================= */
  async function start(cfg) {
    isHost = cfg.isHost;
    myPid = cfg.myPid;
    killLimit = cfg.killLimit | 0;
    over = null;
    particles = []; floaters = []; shake = 0; hitstop = 0;
    snaps = []; lastFxSeq = -1;
    fighters = new Map(); order = [];
    inputs.clear(); prevInputs.clear();
    localMask = 0; lastSentMask = -1;

    // фон арены
    arenaImg = null;
    if (cfg.arena) { try { arenaImg = await U.loadImage(cfg.arena); } catch (e) { } }

    // бойцы + аватары
    await Promise.all(cfg.players.map(async (p, i) => {
      const f = new Fighter(p.pid, i, p.name);
      const src = p.avatar || U.defaultAvatar(f.color);
      try { f.avatar = await U.loadImage(src); } catch (e) { }
      // разводим по разным спавнам
      const sp = ARENA.SPAWNS[i % ARENA.SPAWNS.length];
      f.x = sp.x; f.y = sp.y; f.invuln = PHYS.INVULN_MS;
      f.facing = f.x < ARENA.W / 2 ? 1 : -1;
      fighters.set(p.pid, f);
      order.push(p.pid);
      inputs.set(p.pid, 0); prevInputs.set(p.pid, 0);
    }));

    UI.showScreen('game');
    resize();
    running = true;
    lastT = performance.now(); acc = 0;
    U.sfx.bell();
    requestAnimationFrame(loop);
  }

  function stop() {
    running = false;
    localMask = 0;
  }

  /* Игрок отключился посреди боя. */
  function removePlayer(pid) {
    if (!fighters.has(pid)) return;
    fighters.delete(pid);
    order = order.filter(p => p !== pid);
    inputs.delete(pid); prevInputs.delete(pid);
  }

  /* =================================================================
     ГЛАВНЫЙ ЦИКЛ
     ================================================================= */
  function loop(now) {
    if (!running) return;
    requestAnimationFrame(loop);

    let dt = now - lastT;
    lastT = now;
    if (dt > 250) dt = 250;             // после сворачивания вкладки не «догоняем»

    // счётчик FPS
    fpsN++; fpsT += dt;
    if (fpsT >= 500) { fps = Math.round(fpsN / (fpsT / 1000)); fpsN = 0; fpsT = 0; }

    if (isHost) {
      acc += dt;
      while (acc >= TICK) {
        acc -= TICK;
        if (hitstop > 0) { hitstop--; }   // короткая заморозка для «веса» удара
        else hostTick(TICK);
      }
      maybeSendState(now);
    } else {
      clientInterpolate(now);
    }

    updateEffects(dt);
    render(now);
    UI.updateHUD(publicState());
  }

  /* =================================================================
     СИМУЛЯЦИЯ ХОСТА
     ================================================================= */
  function hostTick(dt) {
    if (over) return;

    // 1) шаг каждого бойца
    fighters.forEach((f, pid) => {
      const mask = inputs.get(pid) || 0;
      const prev = prevInputs.get(pid) || 0;
      const pressed = mask & ~prev;
      prevInputs.set(pid, mask);
      f.step(mask, pressed, dt);
      if (f.fxJump) { f.fxJump = false; addFx({ k: 'jump', x: f.x, y: f.y, c: f.color }); }
    });

    // 2) мягкое расталкивание, чтобы бойцы не слипались в одну точку
    const alive = [...fighters.values()].filter(f => !f.dead);
    for (let i = 0; i < alive.length; i++) {
      for (let j = i + 1; j < alive.length; j++) {
        const a = alive[i], b = alive[j];
        const dx = b.x - a.x, dy = Math.abs(b.y - a.y);
        if (dy < PHYS.H * .8 && Math.abs(dx) < PHYS.W * .8) {
          const push = (PHYS.W * .8 - Math.abs(dx)) * 0.045 * (dx >= 0 ? 1 : -1);
          a.vx -= push; b.vx += push;
        }
      }
    }

    // 3) попадания
    fighters.forEach((att) => {
      const hb = att.hitbox();
      if (!hb || !att.atk) return;
      fighters.forEach((def) => {
        if (def === att || def.dead) return;
        if (att.atk.hit && att.atk.hit.has(def.pid)) return;   // уже задели этой атакой
        const b = def.box;
        if (hb.x < b.x + b.w && hb.x + hb.w > b.x && hb.y < b.y + b.h && hb.y + hb.h > b.y) {
          const res = def.takeHit(hb, att.pid);
          if (!res) return;
          if (att.atk.hit) att.atk.hit.add(def.pid);

          const cx = (hb.x + hb.w / 2 + def.x) / 2;
          const cy = hb.y + hb.h / 2;
          addFx({ k: res.blocked ? 'block' : 'hit', x: cx, y: cy, c: def.color,
                  d: res.dmg, dir: Math.sign(def.x - att.x) || 1, big: hb.type === 'kick' });
          hitstop = res.killed ? 7 : (hb.type === 'kick' ? 4 : 2);

          if (res.killed) {
            if (att.pid !== def.pid) att.kills++;
            addFx({ k: 'kill', x: def.x, y: def.y - 60, c: def.color });
            checkWin(att);
          }
        }
      });
    });

    // 4) респавн
    fighters.forEach((f) => {
      if (f.dead && f.respawnLeft <= 0) {
        f.respawn(pickSpawn());
        addFx({ k: 'spawn', x: f.x, y: f.y, c: f.color });
      }
    });
  }

  /* Спавн подальше от живых игроков. */
  function pickSpawn() {
    const alive = [...fighters.values()].filter(f => !f.dead);
    let best = ARENA.SPAWNS[0], bestD = -1;
    for (const s of ARENA.SPAWNS) {
      let d = 1e9;
      for (const f of alive) d = Math.min(d, Math.hypot(f.x - s.x, f.y - s.y));
      d += U.rand(0, 120);                          // немного случайности
      if (d > bestD) { bestD = d; best = s; }
    }
    return best;
  }

  /* Достигнут лимит киллов? */
  function checkWin(f) {
    if (killLimit <= 0) return;
    if (f.kills >= killLimit) {
      over = { winner: f.pid, table: scoreTable() };
      Net.broadcast({ t: 'over', o: over });
      showOver();
    }
  }

  function scoreTable() {
    return order.map(pid => {
      const f = fighters.get(pid);
      return f ? { pid, name: f.name, kills: f.kills, deaths: f.deaths, color: f.color } : null;
    }).filter(Boolean).sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
  }

  function showOver() {
    const w = fighters.get(over.winner);
    UI.showWin(w ? w.name : '—', over.table, isHost);
    U.sfx.win();
  }

  /* =================================================================
     СЕТЬ: ОТПРАВКА И ПРИЁМ СОСТОЯНИЯ
     ================================================================= */
  let pendingFx = [];
  let fxSeq = 0;

  function addFx(fx) {
    spawnFx(fx);                         // локально сразу
    if (isHost) pendingFx.push(fx);      // и в следующий снапшот клиентам
  }

  function maybeSendState(now) {
    if (now - lastSendTime < SEND_EVERY) return;
    lastSendTime = now;
    if (Net.clientCount === 0) { pendingFx = []; return; }
    Net.broadcast({
      t: 'st',
      p: order.map(pid => fighters.get(pid)).filter(Boolean).map(f => f.toNet()),
      fx: pendingFx.length ? pendingFx : undefined,
      q: ++fxSeq,
    });
    pendingFx = [];
  }

  /* Клиент получил снапшот. */
  function onSnapshot(msg) {
    if (!running) return;
    snaps.push({ ts: performance.now(), p: msg.p });
    if (snaps.length > 20) snaps.shift();
    if (msg.fx && msg.q !== lastFxSeq) {
      lastFxSeq = msg.q;
      msg.fx.forEach(spawnFx);
    }
  }

  /* Плавная интерполяция между двумя снапшотами. */
  function clientInterpolate(now) {
    if (snaps.length === 0) return;
    const rt = now - INTERP_MS;

    let s0 = null, s1 = null;
    for (let i = snaps.length - 1; i >= 0; i--) {
      if (snaps[i].ts <= rt) { s0 = snaps[i]; s1 = snaps[i + 1] || null; break; }
    }
    if (!s0) { s0 = snaps[0]; s1 = snaps[1] || null; }

    const apply = (arr, blendArr, t) => {
      const seen = new Set();
      arr.forEach((s, idx) => {
        seen.add(s.i);
        let f = fighters.get(s.i);
        if (!f) return;                             // новых игроков в бою не бывает
        f.fromNet(s);
        if (blendArr) {
          const n = blendArr.find(z => z.i === s.i);
          if (n) { f.x = U.lerp(s.x, n.x, t); f.y = U.lerp(s.y, n.y, t); }
        }
      });
      // кто пропал из снапшота — того убираем
      [...fighters.keys()].forEach(pid => { if (!seen.has(pid)) removePlayer(pid); });
    };

    if (s1) {
      const span = s1.ts - s0.ts || 1;
      apply(s0.p, s1.p, U.clamp((rt - s0.ts) / span, 0, 1));
    } else {
      apply(snaps[snaps.length - 1].p, null, 0);
    }
  }

  /* =================================================================
     ЭФФЕКТЫ
     ================================================================= */
  function spawnFx(fx) {
    const { k, x, y, c } = fx;
    if (k === 'hit') {
      const n = fx.big ? 20 : 12;
      for (let i = 0; i < n; i++) {
        const a = U.rand(0, 6.28), sp = U.rand(2, fx.big ? 13 : 9);
        particles.push({ x, y, vx: Math.cos(a) * sp + (fx.dir || 0) * 3, vy: Math.sin(a) * sp - 2,
                         life: U.rand(18, 34), max: 34, c: i % 3 ? '#fff' : c, r: U.rand(2, 5), g: .35 });
      }
      particles.push({ ring: 1, x, y, life: 14, max: 14, c: '#fff', r: fx.big ? 18 : 12 });
      floaters.push({ x, y: y - 12, vy: -1.5, life: 46, max: 46, txt: '-' + fx.d, c: '#fff', size: fx.big ? 30 : 22 });
      shake = Math.min(22, shake + (fx.big ? 13 : 7));
      fx.big ? U.sfx.kick() : U.sfx.punch();
    }
    else if (k === 'block') {
      for (let i = 0; i < 10; i++) {
        const a = U.rand(-1, 1) + (fx.dir > 0 ? 0 : Math.PI);
        particles.push({ x, y, vx: Math.cos(a) * U.rand(2, 7), vy: Math.sin(a) * U.rand(2, 7) - 1,
                         life: U.rand(10, 22), max: 22, c: '#9fe8ff', r: U.rand(1.5, 3.5), g: .2 });
      }
      particles.push({ ring: 1, x, y, life: 12, max: 12, c: '#9fe8ff', r: 14 });
      floaters.push({ x, y: y - 10, vy: -1.2, life: 34, max: 34, txt: 'БЛОК', c: '#9fe8ff', size: 18 });
      shake = Math.min(14, shake + 4);
      U.sfx.block();
    }
    else if (k === 'kill') {
      for (let i = 0; i < 46; i++) {
        const a = U.rand(0, 6.28), sp = U.rand(3, 16);
        particles.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 3,
                         life: U.rand(30, 70), max: 70, c: i % 2 ? c : '#fff', r: U.rand(2, 6), g: .3 });
      }
      particles.push({ ring: 1, x, y, life: 26, max: 26, c, r: 30 });
      shake = 26;
      U.sfx.death();
    }
    else if (k === 'spawn') {
      for (let i = 0; i < 26; i++) {
        const a = U.rand(0, 6.28);
        particles.push({ x: x + Math.cos(a) * 70, y: y - 60 + Math.sin(a) * 70,
                         vx: -Math.cos(a) * 4, vy: -Math.sin(a) * 4,
                         life: 22, max: 22, c, r: U.rand(2, 4), g: 0 });
      }
      U.sfx.spawn();
    }
    else if (k === 'jump') {
      for (let i = 0; i < 7; i++) {
        particles.push({ x: x + U.rand(-16, 16), y, vx: U.rand(-2.5, 2.5), vy: U.rand(-1, -3),
                         life: 16, max: 16, c: 'rgba(255,255,255,.6)', r: U.rand(1.5, 3.5), g: .1 });
      }
      U.sfx.jump();
    }
  }

  function updateEffects(dt) {
    const k = dt / TICK;
    particles = particles.filter(p => {
      p.life -= k;
      if (p.ring) return p.life > 0;
      p.x += p.vx * k; p.y += p.vy * k;
      p.vy += (p.g || 0) * k; p.vx *= 0.97; p.vy *= 0.99;
      return p.life > 0;
    });
    floaters = floaters.filter(f => {
      f.life -= k; f.y += f.vy * k; f.vy *= 0.96;
      return f.life > 0;
    });
    if (shake > 0) shake = Math.max(0, shake - 0.9 * k);
  }

  /* =================================================================
     ОТРИСОВКА
     ================================================================= */
  function render(now) {
    const w = canvas.width, h = canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#04040a';
    ctx.fillRect(0, 0, w, h);

    // мир → экран (+ тряска)
    const sh = shake > 0 ? shake : 0;
    ctx.setTransform(
      dpr * view.scale, 0, 0, dpr * view.scale,
      dpr * (view.ox + (sh ? U.rand(-sh, sh) : 0)),
      dpr * (view.oy + (sh ? U.rand(-sh, sh) : 0))
    );

    drawBackground(now);
    drawPlatforms(now);

    // бойцы: сначала мёртвые/дальние, потом живые
    const list = order.map(p => fighters.get(p)).filter(Boolean);
    list.filter(f => f.dead).forEach(f => f.draw(ctx, now));
    list.filter(f => !f.dead).forEach(f => f.draw(ctx, now));

    // указатель «это ты»
    const me = fighters.get(myPid);
    if (me && !me.dead) drawYouMarker(me, now);

    drawParticles();
    drawFloaters();
    drawVignette();
  }

  function drawBackground(now) {
    if (arenaImg) {
      // фото арены — вписываем по «cover» в 1600x900
      const ir = arenaImg.width / arenaImg.height, ar = ARENA.W / ARENA.H;
      let dw, dh;
      if (ir > ar) { dh = ARENA.H; dw = dh * ir; } else { dw = ARENA.W; dh = dw / ir; }
      ctx.drawImage(arenaImg, (ARENA.W - dw) / 2, (ARENA.H - dh) / 2, dw, dh);
      // затемняем, чтобы бойцы читались поверх любого фото
      const g = ctx.createLinearGradient(0, 0, 0, ARENA.H);
      g.addColorStop(0, 'rgba(4,4,12,.62)');
      g.addColorStop(.55, 'rgba(4,4,12,.42)');
      g.addColorStop(1, 'rgba(4,4,12,.78)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, ARENA.W, ARENA.H);
    } else {
      // процедурный неоновый фон
      const g = ctx.createLinearGradient(0, 0, 0, ARENA.H);
      g.addColorStop(0, '#0a0a1c'); g.addColorStop(.6, '#140a24'); g.addColorStop(1, '#05050c');
      ctx.fillStyle = g; ctx.fillRect(0, 0, ARENA.W, ARENA.H);

      // «солнце»
      ctx.save();
      ctx.globalAlpha = .5;
      const s = ctx.createRadialGradient(ARENA.W / 2, 470, 20, ARENA.W / 2, 470, 320);
      s.addColorStop(0, 'rgba(255,45,111,.85)'); s.addColorStop(1, 'rgba(255,45,111,0)');
      ctx.fillStyle = s; ctx.beginPath(); ctx.arc(ARENA.W / 2, 470, 320, 0, 7); ctx.fill();
      ctx.restore();

      // перспективная сетка
      ctx.save();
      ctx.strokeStyle = 'rgba(0,229,255,.20)'; ctx.lineWidth = 2;
      for (let i = -10; i <= 10; i++) {
        ctx.beginPath();
        ctx.moveTo(ARENA.W / 2 + i * 40, 520);
        ctx.lineTo(ARENA.W / 2 + i * 420, ARENA.H);
        ctx.stroke();
      }
      for (let i = 0; i < 12; i++) {
        const y = 520 + Math.pow(i / 11, 2.4) * (ARENA.H - 520);
        ctx.globalAlpha = .10 + i * .02;
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(ARENA.W, y); ctx.stroke();
      }
      ctx.restore();
    }
  }

  function drawPlatforms(now) {
    const drawSlab = (x, y, w, h, glow) => {
      ctx.save();
      ctx.shadowColor = glow; ctx.shadowBlur = 26;
      const g = ctx.createLinearGradient(0, y, 0, y + h);
      g.addColorStop(0, 'rgba(40,40,64,.98)');
      g.addColorStop(1, 'rgba(12,12,22,.96)');
      ctx.fillStyle = g;
      rr(ctx, x, y, w, h, 8); ctx.fill();
      // неоновая кромка сверху
      ctx.shadowBlur = 18;
      ctx.fillStyle = glow;
      rr(ctx, x, y - 3, w, 5, 3); ctx.fill();
      ctx.restore();
    };

    ARENA.PLATFORMS.forEach((p, i) => drawSlab(p.x, p.y, p.w, 26, i === 2 ? '#7cff5a' : '#00e5ff'));
    drawSlab(-10, ARENA.GROUND, ARENA.W + 20, ARENA.H - ARENA.GROUND + 10, '#ff2d6f');

    // полосы на полу
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,.05)'; ctx.lineWidth = 2;
    for (let x = 0; x < ARENA.W; x += 64) {
      ctx.beginPath(); ctx.moveTo(x, ARENA.GROUND + 8); ctx.lineTo(x - 40, ARENA.H); ctx.stroke();
    }
    ctx.restore();
  }

  function drawYouMarker(f, now) {
    const y = f.y - PHYS.H - 66 + Math.sin(now / 300) * 4;
    ctx.save();
    ctx.fillStyle = f.color;
    ctx.shadowColor = f.color; ctx.shadowBlur = 14;
    ctx.beginPath();
    ctx.moveTo(f.x, y + 12); ctx.lineTo(f.x - 9, y); ctx.lineTo(f.x + 9, y);
    ctx.closePath(); ctx.fill();
    ctx.restore();
  }

  function drawParticles() {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    particles.forEach(p => {
      const a = U.clamp(p.life / p.max, 0, 1);
      if (p.ring) {
        ctx.globalAlpha = a * .9;
        ctx.strokeStyle = p.c; ctx.lineWidth = 3 * a + 1;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r * (1 + (1 - a) * 2.6), 0, 7); ctx.stroke();
      } else {
        ctx.globalAlpha = a;
        ctx.fillStyle = p.c;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r * a, 0, 7); ctx.fill();
      }
    });
    ctx.restore();
  }

  function drawFloaters() {
    ctx.save();
    ctx.textAlign = 'center';
    floaters.forEach(f => {
      const a = U.clamp(f.life / f.max, 0, 1);
      ctx.globalAlpha = a;
      ctx.font = `700 ${f.size}px "Bebas Neue", sans-serif`;
      ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(0,0,0,.8)';
      ctx.strokeText(f.txt, f.x, f.y);
      ctx.fillStyle = f.c;
      ctx.fillText(f.txt, f.x, f.y);
    });
    ctx.restore();
  }

  function drawVignette() {
    const g = ctx.createRadialGradient(ARENA.W / 2, ARENA.H / 2, ARENA.H * .35,
                                       ARENA.W / 2, ARENA.H / 2, ARENA.H * .95);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,.55)');
    ctx.fillStyle = g;
    ctx.fillRect(-200, -200, ARENA.W + 400, ARENA.H + 400);
  }

  /* Состояние для DOM-интерфейса (табло, таймер респавна). */
  function publicState() {
    const me = fighters.get(myPid);
    return {
      players: order.map(pid => {
        const f = fighters.get(pid);
        return f && { pid, name: f.name, color: f.color, kills: f.kills,
                      dead: f.dead, hp: f.hp, me: pid === myPid };
      }).filter(Boolean),
      meDead: !!(me && me.dead),
      respawnLeft: me ? me.respawnLeft : 0,
      killLimit, fps, ping: Net.ping, isHost, over: !!over,
    };
  }

  /* =================================================================
     ПРИЁМ СЕТЕВЫХ СООБЩЕНИЙ (подписки навешивает ui.js)
     ================================================================= */
  function onHostInput(from, msg) {
    if (!isHost) return;
    inputs.set(from, msg.k | 0);
  }
  function onOver(msg) {
    over = msg.o;
    showOver();
  }

  return {
    init, start, stop, resize, removePlayer,
    onSnapshot, onHostInput, onOver,
    get running() { return running; },
    get isOver() { return !!over; },
    scoreTable,
  };
})();
