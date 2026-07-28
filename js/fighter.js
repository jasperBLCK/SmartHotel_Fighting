/* ===================================================================
   fighter.js — арена, боец, физика и его отрисовка.

   Персонаж рисуется кодом как человеческая фигура: торс, две руки и две
   ноги из двух сегментов каждая. Позы задаются целевыми точками кистей и
   стоп, а положение локтей/коленей считает двухзвенная IK (solveIK).
   Голова — фотография игрока, вырезанная по черепу (см. js/face.js).

   Мир фиксированного размера ARENA.W x ARENA.H, канвас просто
   масштабируется под экран, поэтому все игроки видят одно и то же.
   =================================================================== */

/* ---------------- Арена ---------------- */
const ARENA = {
  W: 1600, H: 900,
  GROUND: 800,                      // верх пола
  // Платформы (одностороннее столкновение — запрыгиваем снизу, слезаем вниз по S)
  PLATFORMS: [
    { x: 150,  y: 610, w: 320 },
    { x: 1130, y: 610, w: 320 },
    { x: 640,  y: 420, w: 320 },
  ],
  // Точки респавна
  SPAWNS: [
    { x: 220,  y: 610 }, { x: 1380, y: 610 }, { x: 800, y: 420 },
    { x: 420,  y: 800 }, { x: 1180, y: 800 }, { x: 800, y: 800 },
  ],
};

/* ---------------- Биты клавиш (инпут пакуется в одно число) ---------------- */
const K = { LEFT: 1, RIGHT: 2, UP: 4, DOWN: 8, PUNCH: 16, KICK: 32, BLOCK: 64 };

/* ---------------- Константы физики (кадр = 1/60 c) ---------------- */
const PHYS = {
  ACC: 1.5, AIR_ACC: 0.85, MAX_SPD: 8.0,
  FRICTION: 0.80, AIR_FRICTION: 0.94,
  GRAV: 0.90, MAX_FALL: 26, JUMP: -19.0, JUMP2: -16.0,
  BLOCK_SPD: 0.30,        // множитель скорости в блоке
  BLOCK_DMG: 0.20,        // множитель урона по блоку
  BLOCK_KB: 0.45,         // множитель отбрасывания по блоку
  W: 74, H: 134,          // хитбокс бойца
  MAX_HP: 100,
  RESPAWN_MS: 10000,      // 10 секунд до возрождения
  INVULN_MS: 1600,        // неуязвимость после респавна
};

/* ---------------- Пропорции тела (в мировых пикселях, от ступней вверх) ----
   Меняй здесь, если хочешь другое телосложение — отрисовка подстроится. */
const BODY = {
  HIP_Y: -56, SHOULDER_Y: -96, NECK_Y: -102,
  HEAD_Y: -119, HEAD_R: 21,
  SHOULDER_HW: 25,        // полуширина плеч
  WAIST_HW: 15, HIP_HW: 17,
  UPPER_ARM: 24, FOREARM: 25, GLOVE_R: 10,
  THIGH: 29, SHIN: 29, FOOT_L: 15,
  ARM_W: 13, FOREARM_W: 11, THIGH_W: 18, SHIN_W: 14,
};

/* ---------------- Параметры ударов ----------------
   startup — замах, active — активные кадры (есть хитбокс), recovery — отход.
   ox/oy — угол хитбокса относительно центра бойца (ноги = y). */
const ATTACKS = {
  punch: { startup: 4, active: 5, recovery: 8,  dmg: 7,  reach: 66, ox: 14, oy: -104, hh: 46, kbx: 7.5, kby: -2.5, stun: 10 },
  kick:  { startup: 8, active: 6, recovery: 17, dmg: 14, reach: 84, ox: 10, oy: -62,  hh: 46, kbx: 14,  kby: -6.5, stun: 16 },
};

/* Оттенки кожи — по слоту, чтобы бойцы не были клонами. */
const SKIN = [
  { s: '#e0a878', d: '#b47c50' },
  { s: '#f0c9a0', d: '#c39a72' },
  { s: '#c98a5c', d: '#9c6238' },
  { s: '#a86a42', d: '#7d4826' },
];

/* Скруглённый прямоугольник (с фолбэком для старых браузеров). */
function rr(c, x, y, w, h, r) {
  if (c.roundRect) { c.beginPath(); c.roundRect(x, y, w, h, r); return; }
  r = Math.min(r, w / 2, h / 2);
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

/*
  Двухзвенная IK: где встанет локоть/колено, если из точки A до точки B
  тянутся два сегмента длиной l1 и l2. sign задаёт, в какую сторону
  выгибается сустав.
*/
function solveIK(ax, ay, bx, by, l1, l2, sign) {
  let dx = bx - ax, dy = by - ay;
  let d = Math.hypot(dx, dy);
  const maxD = (l1 + l2) * 0.999;
  if (d > maxD) { const k = maxD / (d || 1); dx *= k; dy *= k; d = maxD; }
  if (d < 0.001) d = 0.001;
  const base = Math.atan2(dy, dx);
  const cosA = U.clamp((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), -1, 1);
  const ang = base + sign * Math.acos(cosA);
  return { x: ax + Math.cos(ang) * l1, y: ay + Math.sin(ang) * l1,
           ex: ax + dx, ey: ay + dy };          // ex/ey — достижимая цель
}

class Fighter {
  constructor(pid, idx, name) {
    this.pid = pid;
    this.idx = idx;                       // слот 0..3 — определяет цвет
    this.name = name || ('Игрок ' + (idx + 1));
    this.color = U.COLORS[idx % U.COLORS.length];
    this.skin = SKIN[idx % SKIN.length];
    this.avatar = null;                   // Image с фото головы (или дефолт)

    const sp = ARENA.SPAWNS[idx % ARENA.SPAWNS.length];
    this.x = sp.x; this.y = sp.y;
    this.vx = 0; this.vy = 0;
    this.facing = 1;
    this.onGround = false;
    this.onFloor = false;
    this.jumps = 0;
    this.dropTimer = 0;                   // игнор платформ при спуске вниз

    this.hp = PHYS.MAX_HP;
    this.kills = 0; this.deaths = 0;
    this.dead = false;
    this.respawnLeft = 0;                 // мс до возрождения (для UI)
    this.invuln = 0;                      // мс неуязвимости

    this.state = 'idle';                  // idle|run|air|punch|kick|block|hit|dead
    this.atk = null;                      // {type, frame, hitSet}
    this.stun = 0;                        // кадры хитстана
    this.blocking = false;
    this.lastHitBy = null;

    // чисто визуальное (живёт и на хосте, и на клиенте)
    this.animT = 0;                       // фаза цикла бега
    this.flash = 0;                       // вспышка при получении урона
    this.squash = 0;                      // приседание при приземлении
    this.rx = 0; this.ry = 0;             // сглаженные координаты
    this.prevState = 'idle';
    this.lastDraw = 0;
  }

  /* AABB бойца (x — центр, y — ноги). */
  get box() {
    return { x: this.x - PHYS.W / 2, y: this.y - PHYS.H, w: PHYS.W, h: PHYS.H };
  }

  /* ---------- Возрождение ---------- */
  respawn(spawn) {
    this.x = spawn.x; this.y = spawn.y;
    this.vx = 0; this.vy = 0;
    this.hp = PHYS.MAX_HP;
    this.dead = false; this.respawnLeft = 0;
    this.invuln = PHYS.INVULN_MS;
    this.state = 'idle'; this.atk = null; this.stun = 0;
    this.lastHitBy = null;
    this.rx = spawn.x; this.ry = spawn.y;
  }

  /* ---------- Шаг физики (выполняется ТОЛЬКО на хосте) ----------
     mask    — текущие зажатые клавиши,
     pressed — клавиши, нажатые именно в этом кадре (для прыжка/ударов). */
  step(mask, pressed, dtMs) {
    if (this.dead) {
      this.respawnLeft = Math.max(0, this.respawnLeft - dtMs);
      return;
    }
    if (this.invuln > 0) this.invuln = Math.max(0, this.invuln - dtMs);
    if (this.dropTimer > 0) this.dropTimer--;

    const busy = this.atk !== null;
    const stunned = this.stun > 0;
    if (stunned) this.stun--;

    /* --- блок: только на земле, не во время удара/стана --- */
    this.blocking = !!(mask & K.BLOCK) && this.onGround && !busy && !stunned;

    /* --- горизонтальное движение --- */
    let move = 0;
    if (mask & K.LEFT) move -= 1;
    if (mask & K.RIGHT) move += 1;

    if (!stunned) {
      if (move !== 0 && !busy) this.facing = move;     // разворот только когда свободен
      let acc = this.onGround ? PHYS.ACC : PHYS.AIR_ACC;
      if (this.blocking) acc *= PHYS.BLOCK_SPD;
      if (busy) acc *= 0.25;                            // во время удара почти не рулим
      this.vx += move * acc;
    }

    const maxS = PHYS.MAX_SPD * (this.blocking ? PHYS.BLOCK_SPD : 1);
    this.vx = U.clamp(this.vx, -maxS, maxS);
    if (move === 0 || stunned) this.vx *= this.onGround ? PHYS.FRICTION : PHYS.AIR_FRICTION;
    if (Math.abs(this.vx) < 0.05) this.vx = 0;

    /* --- прыжок (двойной) --- */
    if ((pressed & K.UP) && !stunned && !this.blocking && this.jumps > 0) {
      this.vy = this.jumps === 2 ? PHYS.JUMP : PHYS.JUMP2;
      this.jumps--;
      this.onGround = false;
      this.fxJump = true;                               // хост положит в снапшот
    }

    /* --- спуск сквозь платформу --- */
    if ((pressed & K.DOWN) && this.onGround && !this.onFloor) this.dropTimer = 12;

    /* --- старт удара --- */
    if (!busy && !stunned && !this.blocking) {
      if (pressed & K.PUNCH) this.atk = { type: 'punch', frame: 0, hit: new Set() };
      else if (pressed & K.KICK) this.atk = { type: 'kick', frame: 0, hit: new Set() };
    }

    /* --- гравитация --- */
    this.vy = Math.min(this.vy + PHYS.GRAV, PHYS.MAX_FALL);

    /* --- перемещение и столкновения --- */
    this.x += this.vx;
    this.y += this.vy;

    const half = PHYS.W / 2;
    if (this.x < half) { this.x = half; this.vx = 0; }
    if (this.x > ARENA.W - half) { this.x = ARENA.W - half; this.vx = 0; }

    const wasAir = !this.onGround;
    this.onGround = false;
    this.onFloor = false;

    // пол
    if (this.y >= ARENA.GROUND && this.vy >= 0) {
      this.y = ARENA.GROUND; this.vy = 0;
      this.onGround = true; this.onFloor = true;
    }
    // платформы (только сверху вниз и если не «проваливаемся» специально)
    if (!this.onGround && this.vy >= 0 && this.dropTimer === 0) {
      for (const p of ARENA.PLATFORMS) {
        const prevY = this.y - this.vy;
        if (this.x + half > p.x && this.x - half < p.x + p.w &&
            prevY <= p.y + 6 && this.y >= p.y) {
          this.y = p.y; this.vy = 0; this.onGround = true;
          break;
        }
      }
    }
    if (this.onGround) {
      this.jumps = 2;
      if (wasAir) this.squash = 9;
    }

    /* --- продвижение удара по кадрам --- */
    if (this.atk) {
      const a = ATTACKS[this.atk.type];
      this.atk.frame++;
      if (this.atk.frame > a.startup + a.active + a.recovery) this.atk = null;
    }

    /* --- итоговое состояние --- */
    if (this.stun > 0) this.state = 'hit';
    else if (this.atk) this.state = this.atk.type;
    else if (this.blocking) this.state = 'block';
    else if (!this.onGround) this.state = 'air';
    else if (Math.abs(this.vx) > 0.6) this.state = 'run';
    else this.state = 'idle';
  }

  /* Активный хитбокс удара или null. */
  hitbox() {
    if (!this.atk || this.dead) return null;
    const a = ATTACKS[this.atk.type];
    const f = this.atk.frame;
    if (f <= a.startup || f > a.startup + a.active) return null;
    const w = a.reach, h = a.hh;
    return {
      x: this.facing > 0 ? this.x + a.ox : this.x - a.ox - w,
      y: this.y + a.oy - h / 2,
      w, h, dmg: a.dmg, kbx: a.kbx, kby: a.kby, stun: a.stun, type: this.atk.type,
    };
  }

  /* Получить урон. Возвращает {blocked, killed, dmg}. */
  takeHit(hb, fromPid) {
    if (this.dead || this.invuln > 0) return null;
    const dir = Math.sign(this.x - (hb.x + hb.w / 2)) || 1;
    // блок работает, если смотрим в сторону атакующего
    const blocked = this.blocking && Math.sign(this.facing) !== dir;

    const dmg = Math.round(hb.dmg * (blocked ? PHYS.BLOCK_DMG : 1));
    const kb = blocked ? PHYS.BLOCK_KB : 1;

    this.hp = Math.max(0, this.hp - dmg);
    this.vx += dir * hb.kbx * kb;
    this.vy += hb.kby * kb;
    if (!blocked) {
      this.stun = hb.stun;
      this.atk = null;
      this.flash = 9;
      this.onGround = false;
    }
    this.lastHitBy = fromPid;

    const killed = this.hp <= 0;
    if (killed) {
      this.dead = true; this.deaths++;
      this.respawnLeft = PHYS.RESPAWN_MS;
      this.state = 'dead'; this.atk = null; this.blocking = false;
    }
    return { blocked, killed, dmg };
  }

  /* ---------- Сериализация для сети ---------- */
  toNet() {
    return {
      i: this.pid,
      x: Math.round(this.x * 10) / 10,
      y: Math.round(this.y * 10) / 10,
      f: this.facing,
      h: this.hp,
      s: this.state,
      af: this.atk ? this.atk.frame : 0,
      k: this.kills, d: this.deaths,
      dd: this.dead ? 1 : 0,
      r: Math.round(this.respawnLeft),
      v: Math.round(this.invuln),
      b: this.blocking ? 1 : 0,
      fl: this.flash,
    };
  }
  /* Применить состояние с хоста (у клиента). */
  fromNet(s) {
    this.x = s.x; this.y = s.y;
    this.facing = s.f; this.hp = s.h;
    this.state = s.s;
    this.atk = s.af ? { type: (s.s === 'kick' ? 'kick' : 'punch'), frame: s.af, hit: null } : null;
    this.kills = s.k; this.deaths = s.d;
    this.dead = !!s.dd; this.respawnLeft = s.r; this.invuln = s.v;
    this.blocking = !!s.b;
    if (s.fl > this.flash) this.flash = s.fl;      // вспышку не гасим раньше времени
  }

  /* =================================================================
     ПОЗА
     Считаем ключевые точки скелета. Всё в мировых координатах,
     this.rx/ry — сглаженный центр (ноги на ry).
     ================================================================= */
  pose(now) {
    const f = this.facing, x = this.rx, y = this.ry;
    const st = this.state;
    const t = this.animT;
    const B = BODY;

    // приседание при приземлении и в блоке
    const squash = (this.squash / 9) * 7;
    const crouch = squash + (st === 'block' ? 6 : 0);
    const breathe = Math.sin(now / 620) * 1.1;

    let lean = 0;                            // наклон корпуса вперёд (по facing)
    if (st === 'run') lean = 7;
    else if (st === 'punch') lean = 9;
    else if (st === 'kick') lean = -7;
    else if (st === 'hit') lean = -10;
    else if (st === 'block') lean = 4;
    else if (st === 'air') lean = 3;
    else lean = 2;

    const hipX = x - f * lean * 0.25;
    const hipY = y + B.HIP_Y + crouch;
    const shX = x + f * lean * 0.75;
    const shY = y + B.SHOULDER_Y + crouch * 1.25 + breathe;

    // плечи: переднее ближе к зрителю по направлению взгляда
    const shFront = { x: shX + f * 7, y: shY + 2 };
    const shBack  = { x: shX - f * 9, y: shY };

    const p = { f, x, y, hipX, hipY, shX, shY, shFront, shBack,
                headX: shX + f * 4, headY: y + B.HEAD_Y + crouch * 1.3 + breathe,
                neckY: y + B.NECK_Y + crouch * 1.25 + breathe, lean, crouch };

    // прогресс выброса конечности в ударе: замах → выброс → возврат
    const a = this.atk ? ATTACKS[this.atk.type] : null;
    const prog = a ? this.attackProgress(a) : 0;

    /* --- цели для стоп --- */
    if (st === 'run') {
      const ph = t * Math.PI * 2;
      const foot = (phase) => ({
        x: hipX + f * Math.cos(phase) * 21,
        y: y - Math.max(0, Math.sin(phase)) * 17,
      });
      p.footFront = foot(ph);
      p.footBack = foot(ph + Math.PI);
    } else if (st === 'air') {
      const up = U.clamp(-this.vy / 18, -1, 1);
      p.footFront = { x: hipX + f * 19, y: y - 20 - up * 8 };
      p.footBack  = { x: hipX - f * 11, y: y - 8 + up * 6 };
    } else if (st === 'kick' && a) {
      const reach = 18 + Math.max(0, prog) * 72;
      p.footFront = { x: hipX + f * reach, y: y + a.oy + 6 - Math.max(0, prog) * 4 };
      p.footBack  = { x: hipX - f * 15, y: y };
    } else if (st === 'hit') {
      p.footFront = { x: hipX + f * 20, y: y };
      p.footBack  = { x: hipX - f * 8, y: y - 4 };
    } else if (st === 'punch') {
      p.footFront = { x: hipX + f * 22, y: y };
      p.footBack  = { x: hipX - f * 17, y: y };
    } else {  // idle / block — боевая стойка
      const sway = Math.sin(now / 700) * 1.5;
      p.footFront = { x: hipX + f * (16 + sway), y: y };
      p.footBack  = { x: hipX - f * (15 + sway), y: y };
    }

    /* --- цели для кистей --- */
    const chinF = { x: shFront.x + f * 13, y: shY - 12 };   // передняя перчатка у подбородка
    const chinB = { x: shBack.x + f * 8,  y: shY - 8 };

    if (st === 'punch' && a) {
      const reach = 16 + Math.max(0, prog) * 62;
      p.handFront = { x: shFront.x + f * reach, y: y + a.oy + 6 };
      p.handBack  = chinB;
    } else if (st === 'kick') {
      p.handFront = { x: shFront.x - f * 10, y: shY + 6 };   // руки на балансе
      p.handBack  = { x: shBack.x - f * 20, y: shY - 6 };
    } else if (st === 'block') {
      p.handFront = { x: shFront.x + f * 20, y: shY - 14 };
      p.handBack  = { x: shBack.x + f * 17, y: shY - 2 };
    } else if (st === 'run') {
      const ph = t * Math.PI * 2;
      p.handFront = { x: shFront.x + f * (10 + Math.cos(ph + Math.PI) * 15), y: shY + 24 };
      p.handBack  = { x: shBack.x + f * (6 + Math.cos(ph) * 15), y: shY + 26 };
    } else if (st === 'air') {
      p.handFront = { x: shFront.x + f * 20, y: shY - 16 };
      p.handBack  = { x: shBack.x - f * 16, y: shY - 14 };
    } else if (st === 'hit') {
      p.handFront = { x: shFront.x + f * 6, y: shY - 22 };
      p.handBack  = { x: shBack.x - f * 14, y: shY - 18 };
    } else {  // idle — стойка с поднятыми кулаками
      const b = Math.sin(now / 480) * 2;
      p.handFront = { x: chinF.x, y: chinF.y + b };
      p.handBack  = { x: chinB.x, y: chinB.y - b };
    }

    /* --- суставы через IK ---
       колено выгибается вперёд (-facing), локоть — вниз/назад (+facing) */
    p.kneeFront = solveIK(hipX + f * 5, hipY, p.footFront.x, p.footFront.y - 9, B.THIGH, B.SHIN, -f);
    p.kneeBack  = solveIK(hipX - f * 5, hipY, p.footBack.x,  p.footBack.y - 9,  B.THIGH, B.SHIN, -f);
    p.elbowFront = solveIK(shFront.x, shFront.y, p.handFront.x, p.handFront.y, B.UPPER_ARM, B.FOREARM, f);
    p.elbowBack  = solveIK(shBack.x,  shBack.y,  p.handBack.x,  p.handBack.y,  B.UPPER_ARM, B.FOREARM, f);

    // если цель дальше вытянутой руки/ноги — подтягиваем её к достижимой
    p.handFront = { x: p.elbowFront.ex, y: p.elbowFront.ey };
    p.handBack  = { x: p.elbowBack.ex,  y: p.elbowBack.ey };
    p.footFront = { x: p.kneeFront.ex,  y: p.kneeFront.ey + 9 };
    p.footBack  = { x: p.kneeBack.ex,   y: p.kneeBack.ey + 9 };

    return p;
  }

  /* Прогресс выброса конечности: <0 в замахе → 1 на активных кадрах → назад. */
  attackProgress(a) {
    const f = this.atk.frame;
    if (f <= a.startup) return -0.22 * (f / a.startup);
    if (f <= a.startup + a.active) return 1;
    return 1 - (f - a.startup - a.active) / a.recovery;
  }

  /* =================================================================
     ОТРИСОВКА
     ================================================================= */
  draw(c, now) {
    // --- визуальные счётчики тикают по реальному времени (и на клиенте тоже) ---
    const dt = this.lastDraw ? U.clamp(now - this.lastDraw, 0, 100) : 16;
    this.lastDraw = now;
    const k = dt / 16.67;
    if (this.flash > 0) this.flash = Math.max(0, this.flash - k);
    if (this.squash > 0) this.squash = Math.max(0, this.squash - k);
    // приземление: ловим переход «в воздухе» -> «на земле» (работает у клиента)
    if (this.prevState === 'air' && this.state !== 'air' && this.state !== 'dead') this.squash = 9;
    // фаза бега крутится, только пока бежим
    if (this.state === 'run') this.animT += dt / 1000 * 2.6;
    this.prevState = this.state;

    // сглаживание позиции (убирает дрожь между снапшотами)
    if (this.rx === 0 && this.ry === 0) { this.rx = this.x; this.ry = this.y; }
    this.rx = U.lerp(this.rx, this.x, U.clamp(0.35 * k, 0, 1));
    this.ry = U.lerp(this.ry, this.y, U.clamp(0.45 * k, 0, 1));

    const x = this.rx, y = this.ry;

    /* --- тень на ближайшей поверхности --- */
    const gy = this.groundBelow();
    c.save();
    c.globalAlpha = U.clamp(1 - (gy - y) / 500, .08, .38);
    c.fillStyle = '#000';
    c.beginPath();
    c.ellipse(x, gy - 2, 38 * U.clamp(1 - (gy - y) / 900, .4, 1), 8, 0, 0, 7);
    c.fill();
    c.restore();

    if (this.dead) { this.drawGhost(c, x, y, now); return; }

    c.save();
    // мигание при неуязвимости после респавна
    if (this.invuln > 0 && Math.floor(now / 90) % 2 === 0) c.globalAlpha = 0.4;

    const p = this.pose(now);
    const col = this.color, sk = this.skin;

    // лёгкое подрагивание при получении урона
    if (this.state === 'hit') {
      c.translate(x, y); c.rotate(Math.sin(now / 22) * 0.05 * this.facing); c.translate(-x, -y);
    }

    /* ---------- ДАЛЬНЯЯ (задняя) РУКА И НОГА — темнее ---------- */
    this.drawLeg(c, p, p.kneeBack, p.footBack, sk.d, U.shade(col, -.30), true);
    this.drawArm(c, p.shBack, p.elbowBack, p.handBack, sk.d, U.shade(col, -.25));

    /* ---------- ТОРС ---------- */
    this.drawTorso(c, p, sk, col);

    /* ---------- БЛИЖНЯЯ НОГА И РУКА ---------- */
    this.drawLeg(c, p, p.kneeFront, p.footFront, sk.s, col, false);
    this.drawArm(c, p.shFront, p.elbowFront, p.handFront, sk.s, col);

    /* ---------- ГОЛОВА ---------- */
    this.drawHead(c, p, now);

    /* ---------- ЩИТ БЛОКА ---------- */
    if (this.blocking) {
      c.save();
      const t = now / 200;
      c.strokeStyle = U.rgba('#ffffff', .5 + Math.sin(t) * .15);
      c.shadowColor = '#fff'; c.shadowBlur = 18; c.lineWidth = 4;
      c.beginPath();
      c.arc(p.shX + p.f * 10, y - 70, 60,
            p.f > 0 ? -1.15 : Math.PI - 1.15,
            p.f > 0 ? 1.15 : Math.PI + 1.15);
      c.stroke();
      c.restore();
    }

    c.restore();

    this.drawHUD(c, x, y + BODY.HEAD_Y - BODY.HEAD_R - 26);
  }

  /* Нога: бедро + голень + ботинок. */
  drawLeg(c, p, knee, foot, skin, bootCol, back) {
    const B = BODY;
    const hipX = p.hipX + p.f * (back ? -5 : 5);
    c.save();
    c.lineCap = 'round';
    c.strokeStyle = skin;
    c.lineWidth = B.THIGH_W; c.beginPath(); c.moveTo(hipX, p.hipY); c.lineTo(knee.x, knee.y); c.stroke();
    c.lineWidth = B.SHIN_W;  c.beginPath(); c.moveTo(knee.x, knee.y); c.lineTo(foot.x, foot.y - 9); c.stroke();
    // колено
    c.fillStyle = U.shade(skin, -.06);
    c.beginPath(); c.arc(knee.x, knee.y, B.SHIN_W / 2 + 1, 0, 7); c.fill();
    // ботинок
    c.fillStyle = bootCol;
    c.strokeStyle = 'rgba(0,0,0,.35)'; c.lineWidth = 1.5;
    rr(c, foot.x - (p.f > 0 ? 5 : B.FOOT_L - 5), foot.y - 11, B.FOOT_L, 11, 4);
    c.fill(); c.stroke();
    c.restore();
  }

  /* Рука: плечо + предплечье + перчатка. */
  drawArm(c, sh, elbow, hand, skin, gloveCol) {
    const B = BODY;
    c.save();
    c.lineCap = 'round';
    c.strokeStyle = skin;
    c.lineWidth = B.ARM_W;     c.beginPath(); c.moveTo(sh.x, sh.y); c.lineTo(elbow.x, elbow.y); c.stroke();
    c.lineWidth = B.FOREARM_W; c.beginPath(); c.moveTo(elbow.x, elbow.y); c.lineTo(hand.x, hand.y); c.stroke();
    // локоть
    c.fillStyle = U.shade(skin, -.06);
    c.beginPath(); c.arc(elbow.x, elbow.y, B.FOREARM_W / 2 + .5, 0, 7); c.fill();
    // перчатка
    c.shadowColor = U.rgba(gloveCol, .8); c.shadowBlur = 12;
    const g = c.createRadialGradient(hand.x - 3, hand.y - 4, 2, hand.x, hand.y, B.GLOVE_R + 2);
    g.addColorStop(0, U.shade(gloveCol, .22));
    g.addColorStop(1, U.shade(gloveCol, -.22));
    c.fillStyle = g;
    c.beginPath(); c.arc(hand.x, hand.y, B.GLOVE_R, 0, 7); c.fill();
    c.shadowBlur = 0;
    c.strokeStyle = 'rgba(0,0,0,.35)'; c.lineWidth = 1.5; c.stroke();
    c.restore();
  }

  /* Торс: плечи → талия → таз, плюс шорты, пояс и намёк на мышцы. */
  drawTorso(c, p, sk, col) {
    const B = BODY;
    const f = p.f;
    const sL = p.shX - B.SHOULDER_HW, sR = p.shX + B.SHOULDER_HW;
    const wY = (p.shY + p.hipY) / 2 + 4;
    const wL = p.hipX - B.WAIST_HW, wR = p.hipX + B.WAIST_HW;
    const hL = p.hipX - B.HIP_HW,   hR = p.hipX + B.HIP_HW;

    c.save();

    // силуэт
    const g = c.createLinearGradient(sL, p.shY, sR, p.hipY);
    g.addColorStop(0, U.shade(sk.s, .06));
    g.addColorStop(.55, sk.s);
    g.addColorStop(1, U.shade(sk.s, -.14));
    c.fillStyle = g;
    c.beginPath();
    c.moveTo(sL, p.shY + 4);
    c.quadraticCurveTo(sL - 2, wY - 6, wL, wY);
    c.lineTo(hL, p.hipY + 6);
    c.lineTo(hR, p.hipY + 6);
    c.quadraticCurveTo(wR + 2, wY - 6, sR, p.shY + 4);
    c.quadraticCurveTo(p.shX, p.shY - 12, sL, p.shY + 4);   // трапеции/плечи
    c.closePath();
    c.fill();

    // тень с дальней стороны — объём
    c.save();
    c.clip();
    const sg = c.createLinearGradient(p.shX - f * 26, 0, p.shX + f * 26, 0);
    sg.addColorStop(0, 'rgba(0,0,0,.28)');
    sg.addColorStop(.6, 'rgba(0,0,0,0)');
    c.fillStyle = sg;
    c.fillRect(sL - 10, p.shY - 20, (sR - sL) + 20, p.hipY - p.shY + 40);
    c.restore();

    // грудные и пресс
    c.strokeStyle = U.rgba('#000000', .18); c.lineWidth = 2;
    c.beginPath();
    c.moveTo(p.shX + f * 2, p.shY + 6); c.lineTo(p.shX + f * 2, wY + 4);   // центральная линия
    c.stroke();
    c.beginPath();
    c.arc(p.shX + f * 2, p.shY + 4, 15, .15, Math.PI - .15);               // грудь
    c.stroke();
    c.globalAlpha = .55;
    for (let i = 0; i < 2; i++) {
      const yy = wY - 6 + i * 9;
      c.beginPath(); c.moveTo(p.hipX - 9, yy); c.lineTo(p.hipX + 9, yy); c.stroke();
    }
    c.globalAlpha = 1;

    // шорты
    c.fillStyle = U.shade(col, -.12);
    c.beginPath();
    c.moveTo(wL + 1, wY + 8);
    c.lineTo(wR - 1, wY + 8);
    c.lineTo(hR + 2, p.hipY + 14);
    c.lineTo(p.hipX, p.hipY + 6);
    c.lineTo(hL - 2, p.hipY + 14);
    c.closePath();
    c.fill();
    // пояс
    c.fillStyle = U.shade(col, .18);
    rr(c, wL, wY + 4, wR - wL, 7, 3); c.fill();

    // шея
    c.strokeStyle = U.shade(sk.s, -.08); c.lineWidth = 15; c.lineCap = 'round';
    c.beginPath(); c.moveTo(p.headX - f * 1, p.neckY + 8); c.lineTo(p.headX, p.neckY - 4); c.stroke();

    c.restore();
  }

  /* Голова: фото игрока в круге + ободок цвета игрока и повязка. */
  drawHead(c, p, now) {
    const R = BODY.HEAD_R;
    const hx = p.headX, hy = p.headY, col = this.color;

    c.save();
    // подложка/свечение
    c.shadowColor = U.rgba(col, .65); c.shadowBlur = 18;
    c.fillStyle = '#0b0b14';
    c.beginPath(); c.arc(hx, hy, R + 2.5, 0, 7); c.fill();
    c.restore();

    // само фото
    c.save();
    c.beginPath(); c.arc(hx, hy, R, 0, 7); c.clip();
    if (this.avatar && this.avatar.complete && this.avatar.naturalWidth) {
      // фото уже обрезано по черепу — рисуем как есть
      c.drawImage(this.avatar, hx - R, hy - R, R * 2, R * 2);
    } else {
      c.fillStyle = this.skin.s;
      c.fillRect(hx - R, hy - R, R * 2, R * 2);
    }
    if (this.flash > 0) {
      c.fillStyle = `rgba(255,255,255,${U.clamp(this.flash / 14, 0, .8)})`;
      c.fillRect(hx - R, hy - R, R * 2, R * 2);
    }
    c.restore();

    // ободок
    c.save();
    c.strokeStyle = col; c.lineWidth = 3;
    c.beginPath(); c.arc(hx, hy, R, 0, 7); c.stroke();

    // повязка на лбу — заодно подсказка, куда смотрит боец
    c.strokeStyle = U.shade(col, .12); c.lineWidth = 6;
    c.beginPath();
    c.arc(hx, hy, R - 2.5, Math.PI + .35, Math.PI * 2 - .35);
    c.stroke();
    // хвостик повязки сзади
    c.lineWidth = 4; c.lineCap = 'round';
    c.beginPath();
    c.moveTo(hx - p.f * (R - 4), hy - 8);
    c.quadraticCurveTo(hx - p.f * (R + 12), hy - 4 + Math.sin(now / 180) * 3, hx - p.f * (R + 18), hy + 6);
    c.stroke();
    c.restore();
  }

  /* Ближайшая поверхность под бойцом — для тени. */
  groundBelow() {
    let best = ARENA.GROUND;
    for (const p of ARENA.PLATFORMS) {
      if (this.rx > p.x && this.rx < p.x + p.w && p.y >= this.ry - 2 && p.y < best) best = p.y;
    }
    return best;
  }

  /* Полоска HP + ник над головой. */
  drawHUD(c, x, y) {
    const w = 92, h = 9;
    c.save();
    c.font = '600 13px "JetBrains Mono", monospace';
    c.textAlign = 'center';
    c.fillStyle = 'rgba(0,0,0,.6)';
    c.fillText(this.name, x + 1, y - 7 + 1);
    c.fillStyle = this.color;
    c.fillText(this.name, x, y - 7);

    c.fillStyle = 'rgba(0,0,0,.72)';
    rr(c, x - w / 2 - 2, y - 2, w + 4, h + 4, 6); c.fill();

    const pr = U.clamp(this.hp / PHYS.MAX_HP, 0, 1);
    const g = c.createLinearGradient(x - w / 2, 0, x + w / 2, 0);
    if (pr > .5)       { g.addColorStop(0, '#7cff5a'); g.addColorStop(1, '#39d97a'); }
    else if (pr > .25) { g.addColorStop(0, '#ffd23a'); g.addColorStop(1, '#ff9d2e'); }
    else               { g.addColorStop(0, '#ff5a5a'); g.addColorStop(1, '#ff2d6f'); }
    c.fillStyle = g;
    rr(c, x - w / 2, y, w * pr, h, 4); c.fill();

    c.strokeStyle = 'rgba(0,0,0,.45)'; c.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const sx = x - w / 2 + (w * i) / 4;
      c.beginPath(); c.moveTo(sx, y); c.lineTo(sx, y + h); c.stroke();
    }
    c.restore();
  }

  /* «Дух» павшего бойца + таймер респавна. */
  drawGhost(c, x, y, now) {
    c.save();
    c.globalAlpha = .30 + Math.sin(now / 340) * .08;
    const fy = y - 120 - Math.sin(now / 700) * 12;
    c.fillStyle = U.rgba(this.color, .5);
    c.beginPath(); c.arc(x, fy, 30, 0, 7); c.fill();
    if (this.avatar && this.avatar.complete && this.avatar.naturalWidth) {
      c.save();
      c.beginPath(); c.arc(x, fy, 27, 0, 7); c.clip();
      c.filter = 'grayscale(1)';
      c.drawImage(this.avatar, x - 27, fy - 27, 54, 54);
      c.restore();
    }
    c.globalAlpha = 1;
    c.font = '700 20px "JetBrains Mono", monospace';
    c.textAlign = 'center';
    c.fillStyle = U.rgba(this.color, .85);
    c.fillText(Math.ceil(this.respawnLeft / 1000) + 'с', x, fy + 58);
    c.restore();
  }
}
