/* ===================================================================
   fighter.js — арена, боец, физика и его отрисовка.

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
  W: 76, H: 132,          // хитбокс бойца
  MAX_HP: 100,
  RESPAWN_MS: 10000,      // 10 секунд до возрождения
  INVULN_MS: 1600,        // неуязвимость после респавна
};

/* ---------------- Параметры ударов ----------------
   startup — замах, active — активные кадры (есть хитбокс), recovery — отход. */
const ATTACKS = {
  punch: { startup: 4,  active: 5, recovery: 8,  dmg: 7,  reach: 78,  hh: 46, oy: -92, kbx: 7.5, kby: -2.5, stun: 10, sfx: 'punch' },
  kick:  { startup: 8,  active: 6, recovery: 17, dmg: 14, reach: 108, hh: 40, oy: -52, kbx: 14,  kby: -6.5, stun: 16, sfx: 'kick'  },
};

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

class Fighter {
  constructor(pid, idx, name) {
    this.pid = pid;
    this.idx = idx;                       // слот 0..3 — определяет цвет
    this.name = name || ('Игрок ' + (idx + 1));
    this.color = U.COLORS[idx % U.COLORS.length];
    this.avatar = null;                   // Image с фото лица (или дефолтный)

    this.x = ARENA.SPAWNS[idx % ARENA.SPAWNS.length].x;
    this.y = ARENA.SPAWNS[idx % ARENA.SPAWNS.length].y;
    this.vx = 0; this.vy = 0;
    this.facing = 1;
    this.onGround = false;
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

    // чисто визуальное
    this.animT = 0;
    this.flash = 0;                       // вспышка при получении урона
    this.squash = 0;                      // сплющивание при приземлении
    this.rx = 0; this.ry = 0;             // сглаженные координаты для отрисовки
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
    if (this.flash > 0) this.flash--;
    if (this.squash > 0) this.squash--;
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

    // границы арены по бокам
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
      if (wasAir) this.squash = 8;
    }

    /* --- продвижение удара по кадрам --- */
    if (this.atk) {
      const a = ATTACKS[this.atk.type];
      this.atk.frame++;
      if (this.atk.frame > a.startup + a.active + a.recovery) this.atk = null;
    }

    /* --- визуальное состояние --- */
    this.animT += Math.abs(this.vx) * 0.06 + 0.02;
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
      x: this.facing > 0 ? this.x + 20 : this.x - 20 - w,
      y: this.y + a.oy - h / 2,
      w, h, dmg: a.dmg, kbx: a.kbx, kby: a.kby, stun: a.stun, type: this.atk.type,
    };
  }

  /* Получить урон. Возвращает {blocked, killed}. */
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
      this.flash = 8;
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
  /* Применить состояние с хоста (у клиента). smooth=true — плавно тянем позицию. */
  fromNet(s) {
    this.x = s.x; this.y = s.y;
    this.facing = s.f; this.hp = s.h;
    this.state = s.s;
    this.atk = s.af ? { type: (s.s === 'kick' ? 'kick' : 'punch'), frame: s.af, hit: null } : null;
    this.kills = s.k; this.deaths = s.d;
    this.dead = !!s.dd; this.respawnLeft = s.r; this.invuln = s.v;
    this.blocking = !!s.b; this.flash = s.fl;
  }

  /* =================================================================
     ОТРИСОВКА
     Персонаж — «кулак» с головой-фотографией. Всё рисуется кодом,
     никаких спрайтов: легко менять пропорции ниже.
     ================================================================= */
  draw(c, now) {
    const col = this.color;

    // сглаживание позиции (визуальный лаг ~2 кадра, убирает дёрганье)
    if (this.rx === 0 && this.ry === 0) { this.rx = this.x; this.ry = this.y; }
    this.rx = U.lerp(this.rx, this.x, 0.5);
    this.ry = U.lerp(this.ry, this.y, 0.5);
    const x = this.rx, y = this.ry;

    /* --- тень на ближайшей поверхности --- */
    const gy = this.groundBelow();
    c.save();
    c.globalAlpha = U.clamp(1 - (gy - y) / 500, .08, .38);
    c.fillStyle = '#000';
    c.beginPath();
    c.ellipse(x, gy - 2, 40 * U.clamp(1 - (gy - y) / 900, .4, 1), 9, 0, 0, 7);
    c.fill();
    c.restore();

    if (this.dead) { this.drawGhost(c, x, y, now); return; }

    c.save();

    // мигание при неуязвимости после респавна
    if (this.invuln > 0 && Math.floor(now / 90) % 2 === 0) c.globalAlpha = 0.35;

    // squash&stretch: приземление сплющивает, полёт вытягивает
    const sq = this.squash / 8;
    const sx = 1 + sq * 0.22 - U.clamp(this.vy / 90, -.1, .12);
    const sy = 1 - sq * 0.22 + U.clamp(this.vy / 90, -.1, .12);
    c.translate(x, y);
    c.scale(sx, sy);
    if (this.state === 'hit') c.rotate(Math.sin(now / 25) * 0.06 * this.facing);
    c.translate(-x, -y);

    const BW = 74, BH = 74, LEG = 20;
    const bodyBottom = y - LEG;
    const bodyTop = bodyBottom - BH;
    const headR = 31;
    const headY = bodyTop - headR + 8;
    const bob = Math.sin(this.animT * 6) * (this.state === 'run' ? 3 : 1.2);

    const a = this.atk ? ATTACKS[this.atk.type] : null;
    const prog = a ? this.attackProgress(a) : 0;   // 0..1 «выброс» конечности

    /* --- ноги --- */
    const legSwing = this.state === 'run' ? Math.sin(this.animT * 6) * 9 : 0;
    this.limb(c, x - 15, bodyBottom - 4, x - 15 - legSwing, y, 15, U.shade(col, -.30));
    if (this.state === 'kick' && a) {
      // бьющая нога вылетает вперёд
      const kx = x + this.facing * (26 + prog * (a.reach - 26));
      const ky = y + a.oy + 44;
      this.limb(c, x + 12, bodyBottom - 6, kx, ky, 17, U.shade(col, -.15));
      c.fillStyle = U.shade(col, .12);
      c.beginPath(); c.ellipse(kx, ky, 20, 14, 0, 0, 7); c.fill();
    } else {
      this.limb(c, x + 15, bodyBottom - 4, x + 15 + legSwing, y, 15, U.shade(col, -.30));
    }

    /* --- тело-кулак --- */
    c.save();
    c.shadowColor = U.rgba(col, .55); c.shadowBlur = 26;
    const g = c.createLinearGradient(x - BW / 2, bodyTop, x + BW / 2, bodyBottom);
    g.addColorStop(0, U.shade(col, .16));
    g.addColorStop(.55, col);
    g.addColorStop(1, U.shade(col, -.34));
    c.fillStyle = g;
    rr(c, x - BW / 2, bodyTop + bob * .3, BW, BH, 22);
    c.fill();
    c.shadowBlur = 0;

    // костяшки со стороны взгляда
    c.fillStyle = U.shade(col, .22);
    for (let i = 0; i < 4; i++) {
      const ky = bodyTop + 14 + i * 15 + bob * .3;
      const kx = x + this.facing * (BW / 2 - 7);
      c.beginPath(); c.ellipse(kx, ky, 7, 6.5, 0, 0, 7); c.fill();
    }
    // контур
    c.strokeStyle = U.rgba('#ffffff', .22); c.lineWidth = 2;
    rr(c, x - BW / 2, bodyTop + bob * .3, BW, BH, 22); c.stroke();
    c.restore();

    /* --- бьющая рука --- */
    if (this.state === 'punch' && a) {
      const px = x + this.facing * (30 + prog * (a.reach - 12));
      const py = bodyTop + 26;
      this.limb(c, x + this.facing * 20, bodyTop + 30, px, py, 16, U.shade(col, -.10));
      c.save();
      c.shadowColor = U.rgba(col, .8); c.shadowBlur = 20;
      c.fillStyle = U.shade(col, .18);
      c.beginPath(); c.arc(px, py, 19, 0, 7); c.fill();
      c.strokeStyle = U.rgba('#fff', .35); c.lineWidth = 2; c.stroke();
      c.restore();
    } else if (this.state !== 'block') {
      const swing = this.state === 'run' ? -Math.sin(this.animT * 6) * 8 : 0;
      this.limb(c, x - this.facing * 22, bodyTop + 30, x - this.facing * 30 + swing, bodyTop + 58, 14, U.shade(col, -.24));
    }

    /* --- голова с фотографией --- */
    const hx = x + this.facing * 4, hy = headY + bob;
    c.save();
    c.shadowColor = U.rgba(col, .7); c.shadowBlur = 22;
    c.fillStyle = '#0b0b14';
    c.beginPath(); c.arc(hx, hy, headR + 3, 0, 7); c.fill();
    c.restore();

    c.save();
    c.beginPath(); c.arc(hx, hy, headR, 0, 7); c.clip();
    if (this.avatar && this.avatar.complete) {
      c.drawImage(this.avatar, hx - headR, hy - headR, headR * 2, headR * 2);
    } else {
      c.fillStyle = U.shade(col, -.2);
      c.fillRect(hx - headR, hy - headR, headR * 2, headR * 2);
    }
    // вспышка урона поверх лица
    if (this.flash > 0) {
      c.fillStyle = `rgba(255,255,255,${this.flash / 14})`;
      c.fillRect(hx - headR, hy - headR, headR * 2, headR * 2);
    }
    c.restore();

    // ободок головы + «взгляд» в сторону движения
    c.strokeStyle = col; c.lineWidth = 3.5;
    c.beginPath(); c.arc(hx, hy, headR, 0, 7); c.stroke();
    c.strokeStyle = U.rgba('#fff', .5); c.lineWidth = 1.5;
    c.beginPath(); c.arc(hx, hy, headR - 4, -.9 + (this.facing > 0 ? 0 : Math.PI), .6 + (this.facing > 0 ? 0 : Math.PI));
    c.stroke();

    /* --- щит блока --- */
    if (this.blocking) {
      c.save();
      const t = now / 200;
      c.strokeStyle = U.rgba('#ffffff', .55 + Math.sin(t) * .15);
      c.shadowColor = '#fff'; c.shadowBlur = 18; c.lineWidth = 4;
      c.beginPath();
      c.arc(x + this.facing * 12, y - PHYS.H / 2, 62,
            this.facing > 0 ? -1.1 : Math.PI - 1.1,
            this.facing > 0 ? 1.1 : Math.PI + 1.1);
      c.stroke();
      c.restore();
    }

    c.restore();

    this.drawHUD(c, x, headY - headR - 30);
  }

  /* Прогресс выброса конечности: 0 в замахе → 1 на активных кадрах → назад. */
  attackProgress(a) {
    const f = this.atk.frame;
    if (f <= a.startup) return -0.25 * (f / a.startup);            // замах назад
    if (f <= a.startup + a.active) return 1;
    const back = (f - a.startup - a.active) / a.recovery;
    return 1 - back;
  }

  /* Конечность = толстая линия с закруглением. */
  limb(c, x1, y1, x2, y2, w, color) {
    c.save();
    c.strokeStyle = color; c.lineWidth = w; c.lineCap = 'round';
    c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke();
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
    // ник
    c.font = '600 13px "JetBrains Mono", monospace';
    c.textAlign = 'center';
    c.fillStyle = 'rgba(0,0,0,.6)';
    c.fillText(this.name, x + 1, y - 7 + 1);
    c.fillStyle = this.color;
    c.fillText(this.name, x, y - 7);

    // фон полоски
    c.fillStyle = 'rgba(0,0,0,.72)';
    rr(c, x - w / 2 - 2, y - 2, w + 4, h + 4, 6); c.fill();

    // заливка
    const p = U.clamp(this.hp / PHYS.MAX_HP, 0, 1);
    const g = c.createLinearGradient(x - w / 2, 0, x + w / 2, 0);
    if (p > .5)      { g.addColorStop(0, '#7cff5a'); g.addColorStop(1, '#39d97a'); }
    else if (p > .25){ g.addColorStop(0, '#ffd23a'); g.addColorStop(1, '#ff9d2e'); }
    else             { g.addColorStop(0, '#ff5a5a'); g.addColorStop(1, '#ff2d6f'); }
    c.fillStyle = g;
    rr(c, x - w / 2, y, w * p, h, 4); c.fill();

    // деления по 25 HP
    c.strokeStyle = 'rgba(0,0,0,.45)'; c.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const sx = x - w / 2 + (w * i) / 4;
      c.beginPath(); c.moveTo(sx, y); c.lineTo(sx, y + h); c.stroke();
    }
    c.restore();
  }

  /* Отрисовка «духа» павшего бойца + таймер респавна. */
  drawGhost(c, x, y, now) {
    c.save();
    c.globalAlpha = .30 + Math.sin(now / 340) * .08;
    const fy = y - 120 - Math.sin(now / 700) * 12;
    c.fillStyle = U.rgba(this.color, .5);
    c.beginPath(); c.arc(x, fy, 30, 0, 7); c.fill();
    if (this.avatar && this.avatar.complete) {
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
