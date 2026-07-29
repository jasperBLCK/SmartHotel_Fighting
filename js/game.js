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

  let arenaImg = null;            // фото арены (или null → рисуем процедурный двор)
  let particles = [];
  let floaters = [];              // всплывающие цифры урона
  let decals = [];                // следы крови на земле
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
  /* Раскладка: левая рука — движение, правая — удары.
     Верхний ряд U I O — руки, нижний J K L — ноги, блок на Shift. */
  const KEYMAP = {
    'KeyA': K.LEFT,  'ArrowLeft': K.LEFT,
    'KeyD': K.RIGHT, 'ArrowRight': K.RIGHT,
    'KeyW': K.UP,    'ArrowUp': K.UP, 'Space': K.UP,
    'KeyS': K.DOWN,  'ArrowDown': K.DOWN,
    'KeyU': K.JAB,   'KeyI': K.HOOK,  'KeyO': K.UPPER,
    'KeyJ': K.HIGH,  'KeyK': K.LOW,   'KeyL': K.SWEEP,
    'ShiftLeft': K.BLOCK, 'ShiftRight': K.BLOCK, 'KeyP': K.BLOCK,
  };

  function bindKeys() {
    window.addEventListener('keydown', (e) => {
      if (!running) return;
      // подколки на 1..5
      const m = /^(?:Digit|Numpad)([1-5])$/.exec(e.code);
      if (m) { e.preventDefault(); if (!e.repeat) doTaunt(+m[1] - 1); return; }
      const bit = KEYMAP[e.code];
      if (!bit) return;
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

  /* ---------------- Подколки (клавиши 1..5) ---------------- */
  let lastTauntAt = 0;
  const tauntCooldown = new Map();      // pid -> время следующей разрешённой подколки

  /* Нажали 1..5: хост применяет сразу, клиент просит хоста. */
  function doTaunt(i) {
    if (over) return;
    const now = performance.now();
    if (now - lastTauntAt < 1200) return;          // локальный антиспам
    lastTauntAt = now;
    if (isHost) applyTaunt(myPid, i);
    else Net.toHost({ t: 'tt', i });
  }

  /* Авторитетно у хоста: подколка стоит выносливости и имеет откат. */
  function applyTaunt(pid, i) {
    if (!isHost || over) return;
    const f = fighters.get(pid);
    if (!f || f.dead) return;
    const now = performance.now();
    if ((tauntCooldown.get(pid) || 0) > now) return;
    tauntCooldown.set(pid, now + 1200);
    f.stam = Math.max(0, f.stam - PHYS.STAM_TAUNT);
    addFx({ k: 'taunt', pid, i: U.clamp(i | 0, 0, TAUNTS.length - 1) });
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
    particles = []; floaters = []; decals = []; shake = 0; hitstop = 0;
    snaps = []; lastFxSeq = -1;
    fighters = new Map(); order = [];
    inputs.clear(); prevInputs.clear();
    localMask = 0; lastSentMask = -1;

    // фон арены
    arenaImg = null;
    if (cfg.arena) { try { arenaImg = await U.loadImage(cfg.arena); } catch (e) { } }

    // бойцы + аватары
    await Promise.all(cfg.players.map(async (p, i) => {
      const f = new Fighter(p.pid, i, p.name, p.char);
      // фото нет — оставляем null, тогда рисуется процедурная голова бойца
      if (p.avatar) { try { f.avatar = await U.loadImage(p.avatar); } catch (e) { } }
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
      // попытка ударить без выносливости
      if (f.fxNoStam) { f.fxNoStam = false; addFx({ k: 'nostam', x: f.x, y: f.y - 130, c: f.color }); }
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
          const dir = Math.sign(def.x - att.x) || 1;

          if (res.broken) {
            // блок проломлен — отдельный эффект и долгий хитстоп
            addFx({ k: 'break', x: def.x, y: def.y - 96, c: def.color, d: res.dmg, dir });
            hitstop = 9;
          } else {
            addFx({
              k: res.blocked ? 'block' : 'hit',
              x: cx, y: cy, c: def.color, d: res.dmg, dir,
              big: hb.heavy, kind: hb.kind,
              wound: res.blocked ? 0 : U.clamp(def.woundLevel + hb.dmg / 40, .25, 1),
            });
            hitstop = res.killed ? 7 : (hb.heavy ? 4 : 2);
          }

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
  /* Ближайшая поверхность под точкой — чтобы кровь ложилась на пол/платформу. */
  function surfaceUnder(x, y) {
    let best = ARENA.GROUND;
    for (const p of ARENA.PLATFORMS) {
      if (x > p.x && x < p.x + p.w && p.y >= y - 2 && p.y < best) best = p.y;
    }
    return best;
  }

  /* Пятно крови на земле (живёт ~25 секунд и выцветает). */
  function addDecal(x, y, r) {
    decals.push({ x, y, r, sx: U.rand(.7, 1.5), rot: U.rand(0, 6.28), life: 1500, max: 1500 });
    if (decals.length > 140) decals.shift();
  }

  /* Брызги крови: летят, притягиваются вниз, оставляют пятна. */
  function bloodSpray(x, y, dir, amount, force) {
    for (let i = 0; i < amount; i++) {
      const a = U.rand(-1.1, 1.1) + (dir > 0 ? 0 : Math.PI);
      const sp = U.rand(2, force);
      particles.push({
        x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - U.rand(1, 4),
        life: U.rand(26, 60), max: 60, c: i % 4 ? '#b8121b' : '#e03a2a',
        r: U.rand(1.6, 4.2), g: .55, blood: 1,
      });
    }
  }

  function spawnFx(fx) {
    const { k, x, y, c } = fx;
    if (k === 'hit') {
      const n = fx.big ? 18 : 11;
      for (let i = 0; i < n; i++) {
        const a = U.rand(0, 6.28), sp = U.rand(2, fx.big ? 13 : 9);
        particles.push({ x, y, vx: Math.cos(a) * sp + (fx.dir || 0) * 3, vy: Math.sin(a) * sp - 2,
                         life: U.rand(16, 30), max: 30, c: i % 3 ? '#fff' : c, r: U.rand(2, 5), g: .35 });
      }
      particles.push({ ring: 1, x, y, life: 14, max: 14, c: '#fff', r: fx.big ? 18 : 12 });
      // кровь тем сильнее, чем хуже дела у получившего
      const w = fx.wound || .3;
      bloodSpray(x, y, fx.dir || 1, Math.round(4 + w * 16 + (fx.big ? 5 : 0)), 7 + w * 7);
      floaters.push({ x, y: y - 12, vy: -1.5, life: 46, max: 46, txt: '-' + fx.d, c: '#fff', size: fx.big ? 30 : 22 });
      shake = Math.min(22, shake + (fx.big ? 13 : 7));
      fx.big ? U.sfx.kick() : U.sfx.punch();
    }
    else if (k === 'break') {
      // пролом блока: жёлтая вспышка, осколки и крик
      for (let i = 0; i < 26; i++) {
        const a = U.rand(0, 6.28), sp = U.rand(3, 12);
        particles.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 3,
                         life: U.rand(20, 42), max: 42, c: i % 2 ? '#ffd23a' : '#fff8d0',
                         r: U.rand(2, 5), g: .3 });
      }
      particles.push({ ring: 1, x, y, life: 22, max: 22, c: '#ffd23a', r: 26 });
      floaters.push({ x, y: y - 20, vy: -1.4, life: 62, max: 62, txt: 'БЛОК ПРОБИТ!', c: '#ffd23a', size: 30 });
      bloodSpray(x, y, fx.dir || 1, 6, 7);
      shake = Math.min(26, shake + 18);
      U.sfx.guardBreak();
    }
    else if (k === 'nostam') {
      floaters.push({ x, y, vy: -1.1, life: 40, max: 40, txt: 'ВЫДОХСЯ', c: '#ff9d2e', size: 20 });
      for (let i = 0; i < 5; i++) {
        particles.push({ x: x + U.rand(-8, 8), y, vx: U.rand(-1.5, 1.5), vy: U.rand(-.5, -2),
                         life: 20, max: 20, c: 'rgba(200,220,255,.5)', r: U.rand(2, 4), g: 0 });
      }
      U.sfx.winded();
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
      for (let i = 0; i < 34; i++) {
        const a = U.rand(0, 6.28), sp = U.rand(3, 16);
        particles.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 3,
                         life: U.rand(30, 70), max: 70, c: i % 2 ? c : '#fff', r: U.rand(2, 6), g: .3 });
      }
      bloodSpray(x, y, fx.dir || 1, 34, 15);
      particles.push({ ring: 1, x, y, life: 26, max: 26, c, r: 30 });
      // лужа под телом
      const gy = surfaceUnder(x, y);
      for (let i = 0; i < 5; i++) addDecal(x + U.rand(-30, 30), gy - 2, U.rand(8, 20));
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
    else if (k === 'taunt') {
      const f = fighters.get(fx.pid);
      if (f) {
        f.taunt = { i: fx.i, until: performance.now() + 2200 };
        U.sfx.taunt(fx.i);
      }
      return;
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
      // капля крови долетела до пола — оставляем пятно
      if (p.blood && p.vy > 0) {
        const gy = surfaceUnder(p.x, p.y);
        if (p.y >= gy) { addDecal(p.x, gy - 1, p.r * U.rand(1.3, 2.6)); return false; }
      }
      return p.life > 0;
    });
    decals = decals.filter(d => (d.life -= k) > 0);
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
    drawDecals();

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
      drawCourtyard(now);
    }
  }

  /* Стабильный псевдослучайный шум по индексу — фон не «кипит» между кадрами. */
  function n1(i) { const s = Math.sin(i * 127.1) * 43758.5453; return s - Math.floor(s); }

  /*
    Двор: панельки с горящими окнами, ряд гаражей, фонарь и снег.
    Всё рисуется кодом — можно заменить своим фото арены в лобби.
  */
  function drawCourtyard(now) {
    const W = ARENA.W, H = ARENA.H;

    // ночное небо
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#0b1020');
    g.addColorStop(.55, '#141a2c');
    g.addColorStop(1, '#0a0c14');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);

    // дальние панельные дома
    for (let b = 0; b < 7; b++) {
      const bw = 150 + n1(b) * 120;
      const bx = b * 240 - 60 + n1(b + 30) * 40;
      const bh = 300 + n1(b + 60) * 210;
      const by = 560 - bh;
      ctx.fillStyle = `rgba(${18 + b}, ${20 + b * 2}, ${34 + b * 2}, 1)`;
      ctx.fillRect(bx, by, bw, bh);

      // окна: часть горит тёплым
      for (let wy = by + 18; wy < 545; wy += 30) {
        for (let wx = bx + 12; wx < bx + bw - 16; wx += 26) {
          const r = n1(wx * 0.37 + wy * 0.11 + b);
          if (r > 0.62) {
            ctx.fillStyle = r > 0.93 ? 'rgba(255,214,140,.85)'
                          : r > 0.78 ? 'rgba(255,196,110,.55)' : 'rgba(160,190,230,.30)';
            ctx.fillRect(wx, wy, 13, 17);
          }
        }
      }
    }

    // ряд гаражей — кирпич и ржавые ворота
    const gy0 = 560, gh = 130;
    ctx.fillStyle = '#3a2a24';
    ctx.fillRect(0, gy0, W, gh);
    for (let x = 0; x < W; x += 96) {
      const r = n1(x);
      ctx.fillStyle = r > .5 ? '#6b4a34' : '#5c3f2c';
      ctx.fillRect(x + 4, gy0 + 10, 88, gh - 16);
      // ворота
      ctx.fillStyle = r > .66 ? '#41545c' : (r > .33 ? '#5a4a3a' : '#4a5a44');
      ctx.fillRect(x + 14, gy0 + 26, 68, gh - 34);
      ctx.strokeStyle = 'rgba(0,0,0,.35)'; ctx.lineWidth = 2;
      for (let i = 1; i < 4; i++) {
        ctx.beginPath();
        ctx.moveTo(x + 14 + i * 17, gy0 + 26);
        ctx.lineTo(x + 14 + i * 17, gy0 + gh - 8);
        ctx.stroke();
      }
    }
    // кирпичная кладка поверх
    ctx.strokeStyle = 'rgba(0,0,0,.18)'; ctx.lineWidth = 1;
    for (let y = gy0; y < gy0 + gh; y += 11) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }

    // фонарь и его пятно света
    const lx = 1290, ly = 250;
    ctx.strokeStyle = '#22242c'; ctx.lineWidth = 9; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(lx, ARENA.GROUND); ctx.lineTo(lx, ly); ctx.stroke();
    ctx.lineWidth = 7;
    ctx.beginPath(); ctx.moveTo(lx, ly); ctx.quadraticCurveTo(lx - 40, ly - 16, lx - 74, ly + 4); ctx.stroke();
    const flick = 0.82 + Math.sin(now / 90) * 0.05 + n1(Math.floor(now / 400)) * 0.13;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const lamp = ctx.createRadialGradient(lx - 78, ly + 8, 4, lx - 78, ly + 8, 520);
    lamp.addColorStop(0, `rgba(255,196,110,${.55 * flick})`);
    lamp.addColorStop(.35, `rgba(255,170,80,${.16 * flick})`);
    lamp.addColorStop(1, 'rgba(255,150,60,0)');
    ctx.fillStyle = lamp;
    ctx.beginPath(); ctx.arc(lx - 78, ly + 8, 520, 0, 7); ctx.fill();
    ctx.restore();
    ctx.fillStyle = `rgba(255,226,170,${flick})`;
    ctx.beginPath(); ctx.ellipse(lx - 78, ly + 10, 13, 8, 0, 0, 7); ctx.fill();

    // снег
    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,.55)';
    for (let i = 0; i < 90; i++) {
      const sp = 18 + n1(i) * 26;
      const sx = (n1(i + 7) * W + now / 1000 * (6 + n1(i) * 10)) % W;
      const sy = (n1(i + 11) * H + now / 1000 * sp) % H;
      const r = .8 + n1(i + 3) * 1.9;
      ctx.globalAlpha = .25 + n1(i + 5) * .45;
      ctx.beginPath(); ctx.arc(sx, sy, r, 0, 7); ctx.fill();
    }
    ctx.restore();
  }

  /* Бетонные плиты и асфальт: дворовая фактура вместо неоновых панелей. */
  function drawPlatforms(now) {
    const slab = (x, y, w, h) => {
      ctx.save();
      const g = ctx.createLinearGradient(0, y, 0, y + h);
      g.addColorStop(0, '#4a4a52');
      g.addColorStop(.16, '#33333c');
      g.addColorStop(1, '#1b1b22');
      ctx.fillStyle = g;
      rr(ctx, x, y, w, h, 4); ctx.fill();

      // снежная шапка сверху
      ctx.fillStyle = 'rgba(226,236,248,.82)';
      rr(ctx, x, y - 4, w, 7, 3); ctx.fill();
      // сколы и трещины
      ctx.strokeStyle = 'rgba(0,0,0,.35)'; ctx.lineWidth = 1.5;
      for (let i = 1; i * 90 < w; i++) {
        const cx = x + i * 90 + n1(x + i) * 20;
        ctx.beginPath(); ctx.moveTo(cx, y + 4); ctx.lineTo(cx + 4, y + h); ctx.stroke();
      }
      ctx.restore();
    };

    ARENA.PLATFORMS.forEach(p => slab(p.x, p.y, p.w, 26));

    // асфальт
    ctx.save();
    const gy = ARENA.GROUND;
    const g = ctx.createLinearGradient(0, gy, 0, ARENA.H);
    g.addColorStop(0, '#2e2f36');
    g.addColorStop(1, '#16171c');
    ctx.fillStyle = g;
    ctx.fillRect(-10, gy, ARENA.W + 20, ARENA.H - gy + 10);
    // укатанный снег у кромки
    ctx.fillStyle = 'rgba(226,236,248,.72)';
    ctx.fillRect(-10, gy - 4, ARENA.W + 20, 7);
    // выбоины
    ctx.fillStyle = 'rgba(0,0,0,.28)';
    for (let i = 0; i < 26; i++) {
      const px = n1(i) * ARENA.W, py = gy + 14 + n1(i + 50) * (ARENA.H - gy - 24);
      ctx.beginPath();
      ctx.ellipse(px, py, 10 + n1(i + 9) * 26, 3 + n1(i + 4) * 5, 0, 0, 7);
      ctx.fill();
    }
    // разметка
    ctx.strokeStyle = 'rgba(255,214,140,.10)'; ctx.lineWidth = 3;
    ctx.setLineDash([34, 26]);
    ctx.beginPath(); ctx.moveTo(0, gy + 56); ctx.lineTo(ARENA.W, gy + 56); ctx.stroke();
    ctx.setLineDash([]);
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

  /* Пятна крови на асфальте. */
  function drawDecals() {
    ctx.save();
    decals.forEach(d => {
      const a = U.clamp(d.life / d.max, 0, 1);
      ctx.globalAlpha = a * 0.7;
      ctx.fillStyle = '#7d0d13';
      ctx.save();
      ctx.translate(d.x, d.y);
      ctx.rotate(d.rot);
      ctx.beginPath();
      ctx.ellipse(0, 0, d.r * d.sx, d.r * 0.42, 0, 0, 7);
      ctx.fill();
      ctx.restore();
    });
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
  function onTaunt(from, msg) { applyTaunt(from, msg.i); }

  function onOver(msg) {
    over = msg.o;
    showOver();
  }

  return {
    init, start, stop, resize, removePlayer, taunt: doTaunt,
    onSnapshot, onHostInput, onOver, onTaunt,
    get running() { return running; },
    get isOver() { return !!over; },
    scoreTable,
    // отладка: краткий срез состояния боя (используется автотестами)
    debugState: () => [...fighters.values()].map(f => ({
      n: f.name, x: Math.round(f.x), hp: f.hp, st: Math.round(f.stam),
      gd: Math.round(f.guard), s: f.state, dead: f.dead, k: f.kills,
      blood: decals.length,
    })),
  };
})();
