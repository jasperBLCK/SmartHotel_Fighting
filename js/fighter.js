/* ===================================================================
   fighter.js — арена, персонажи, физика боя и отрисовка бойца.

   Персонаж рисуется кодом как человеческая фигура: торс, две руки и две
   ноги по два сегмента. Позы задаются целевыми точками кистей и стоп,
   локти и колени считает двухзвенная IK (solveIK).
   Голова — фотография игрока, вырезанная по силуэту (см. js/face.js).

   Дворовая эстетика: спортивки с лампасами, кепки, папахи, борцовки.
   =================================================================== */

/* ---------------- Арена ---------------- */
const ARENA = {
  W: 1600, H: 900,
  GROUND: 800,
  PLATFORMS: [
    { x: 150,  y: 610, w: 320 },
    { x: 1130, y: 610, w: 320 },
    { x: 640,  y: 420, w: 320 },
  ],
  SPAWNS: [
    { x: 220,  y: 610 }, { x: 1380, y: 610 }, { x: 800, y: 420 },
    { x: 420,  y: 800 }, { x: 1180, y: 800 }, { x: 800, y: 800 },
  ],
};

/* ---------------- Биты клавиш ---------------- */
const K = { LEFT: 1, RIGHT: 2, UP: 4, DOWN: 8, PUNCH: 16, KICK: 32, BLOCK: 64 };

/* ---------------- Константы физики (кадр = 1/60 c) ---------------- */
const PHYS = {
  ACC: 1.5, AIR_ACC: 0.85, MAX_SPD: 8.0,
  FRICTION: 0.80, AIR_FRICTION: 0.94,
  GRAV: 0.90, MAX_FALL: 26, JUMP: -19.0, JUMP2: -16.0,
  BLOCK_SPD: 0.30,
  BLOCK_DMG: 0.18,        // сколько урона проходит сквозь блок
  BLOCK_KB: 0.45,
  W: 74, H: 134,
  MAX_HP: 100,
  RESPAWN_MS: 10000,
  INVULN_MS: 1600,

  GUARD_MAX: 62,          // прочность блока
  GUARD_REGEN: 0.42,      // восстановление за кадр вне блока
  GUARD_REGEN_HOLD: 0.10, // восстановление, пока блок держат
  BREAK_FRAMES: 52,       // стан после пролома блока

  STAM_MAX: 100,
  STAM_REGEN: 0.62,       // покой
  STAM_REGEN_MOVE: 0.34,  // в движении
  STAM_REGEN_BLOCK: 0.16, // в блоке
  STAM_JUMP: 5,
  WINDED_AT: 14,          // ниже этого порога боец «выдохся»
  WINDED_UNTIL: 42,       // отдышка держится, пока не восстановим столько
  WINDED_SPD: 0.70,       // множитель скорости на отдышке
};

/* ---------------- Пропорции тела ---------------- */
const BODY = {
  HIP_Y: -56, SHOULDER_Y: -96, NECK_Y: -102,
  HEAD_Y: -119, HEAD_R: 21,
  SHOULDER_HW: 25, WAIST_HW: 15, HIP_HW: 17,
  UPPER_ARM: 24, FOREARM: 25, GLOVE_R: 9,
  THIGH: 29, SHIN: 29, FOOT_L: 15,
  ARM_W: 13, FOREARM_W: 11, THIGH_W: 18, SHIN_W: 14,
};

/* ---------------- Удары ----------------
   kind    — рука или нога (влияет на позу),
   stam    — расход выносливости,
   guard   — сколько снимает с чужого блока,
   ox/oy   — угол хитбокса относительно центра бойца (ноги = y). */
const ATTACKS = {
  jab:      { kind: 'punch', startup: 3, active: 4, recovery: 7,  dmg: 6,  reach: 62, ox: 14, oy: -104, hh: 40, kbx: 6,  kby: -1.5, stun: 8,  stam: 7,  guard: 8,  label: 'джеб' },
  hook:     { kind: 'punch', startup: 7, active: 5, recovery: 14, dmg: 12, reach: 68, ox: 14, oy: -100, hh: 46, kbx: 11, kby: -3,   stun: 14, stam: 14, guard: 17, label: 'хук' },
  uppercut: { kind: 'punch', startup: 8, active: 5, recovery: 19, dmg: 15, reach: 54, ox: 10, oy: -88,  hh: 66, kbx: 5,  kby: -13,  stun: 20, stam: 20, guard: 24, label: 'апперкот' },
  airpunch: { kind: 'punch', startup: 4, active: 6, recovery: 10, dmg: 10, reach: 64, ox: 12, oy: -96,  hh: 48, kbx: 9,  kby: 1,    stun: 12, stam: 12, guard: 14, air: true, label: 'удар в прыжке' },
  highkick: { kind: 'kick',  startup: 9, active: 6, recovery: 18, dmg: 14, reach: 86, ox: 10, oy: -104, hh: 46, kbx: 13, kby: -6,   stun: 16, stam: 16, guard: 20, label: 'хай-кик' },
  midkick:  { kind: 'kick',  startup: 7, active: 5, recovery: 14, dmg: 11, reach: 84, ox: 10, oy: -62,  hh: 44, kbx: 12, kby: -4,   stun: 14, stam: 13, guard: 17, label: 'лоу-кик' },
  sweep:    { kind: 'kick',  startup: 6, active: 5, recovery: 16, dmg: 8,  reach: 82, ox: 8,  oy: -22,  hh: 32, kbx: 7,  kby: -2,   stun: 24, stam: 12, guard: 14, trip: true, label: 'подсечка' },
  divekick: { kind: 'kick',  startup: 4, active: 11, recovery: 12, dmg: 13, reach: 68, ox: 8, oy: -56,  hh: 58, kbx: 10, kby: 2,    stun: 15, stam: 14, guard: 19, air: true, label: 'удар с воздуха' },
};

/* ---------------- Персонажи ----------------
   Меняй здесь, чтобы добавить своего бойца: внешний вид + статы. */
const CHARACTERS = [
  { id: 'pacan',   name: 'ПАЦАН',    info: 'Ровный со всех сторон. Спортивка и кепка.',
    look: { top: 'track', hat: 'cap',    stripes: true,  skin: 0 },
    st: { hp: 100, spd: 1.00, dmg: 1.00, stam: 100, jump: 1.00, guard: 1.00, hands: 1.00 } },

  { id: 'starshiy', name: 'СТАРШОЙ', info: 'Медленный, зато с одного удара складывает.',
    look: { top: 'jacket', hat: 'none', stripes: false, skin: 1 },
    st: { hp: 116, spd: 0.90, dmg: 1.20, stam: 92,  jump: 0.92, guard: 1.10, hands: 1.15 } },

  { id: 'jigit',   name: 'ДЖИГИТ',   info: 'Лёгкий на ногу, высокий прыжок.',
    look: { top: 'vest',  hat: 'papaha', stripes: false, skin: 2 },
    st: { hp: 92,  spd: 1.14, dmg: 0.94, stam: 112, jump: 1.12, guard: 0.92, hands: 0.94 } },

  { id: 'borec',   name: 'БОРЕЦ',    info: 'Толстый блок и много здоровья.',
    look: { top: 'wrestle', hat: 'none', stripes: false, skin: 3 },
    st: { hp: 126, spd: 0.92, dmg: 1.02, stam: 98,  jump: 0.90, guard: 1.45, hands: 1.08 } },

  { id: 'boxer',   name: 'БОКСЁР',   info: 'Руки быстрые и дешёвые по выносливости.',
    look: { top: 'tank',  hat: 'none',  stripes: false, skin: 1 },
    st: { hp: 96,  spd: 1.06, dmg: 1.00, stam: 118, jump: 1.00, guard: 1.00, hands: 0.78 } },

  { id: 'dvorovy', name: 'ДВОРОВЫЙ', info: 'Выносливый: долго дерётся без отдышки.',
    look: { top: 'track', hat: 'beanie', stripes: true, skin: 0 },
    st: { hp: 106, spd: 1.00, dmg: 0.97, stam: 130, jump: 1.00, guard: 1.08, hands: 1.00 } },
];

const SKIN = [
  { s: '#e0a878', d: '#b47c50' },
  { s: '#f0c9a0', d: '#c39a72' },
  { s: '#c98a5c', d: '#9c6238' },
  { s: '#a86a42', d: '#7d4826' },
];

const BLOOD = '#b8121b';

/* Скруглённый прямоугольник (с фолбэком). */
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

/* Двухзвенная IK: положение локтя/колена между A и целью B. */
function solveIK(ax, ay, bx, by, l1, l2, sign) {
  let dx = bx - ax, dy = by - ay;
  let d = Math.hypot(dx, dy);
  const maxD = (l1 + l2) * 0.999;
  if (d > maxD) { const k = maxD / (d || 1); dx *= k; dy *= k; d = maxD; }
  if (d < 0.001) d = 0.001;
  const base = Math.atan2(dy, dx);
  const cosA = U.clamp((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), -1, 1);
  const ang = base + sign * Math.acos(cosA);
  return { x: ax + Math.cos(ang) * l1, y: ay + Math.sin(ang) * l1, ex: ax + dx, ey: ay + dy };
}

/* Детерминированный «шум» по строке — чтобы раны у бойца всегда были на месте. */
function hashF(str, i) {
  let h = 2166136261;
  const s = str + '#' + i;
  for (let k = 0; k < s.length; k++) { h ^= s.charCodeAt(k); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 10000) / 10000;
}

class Fighter {
  constructor(pid, idx, name, charId) {
    this.pid = pid;
    this.idx = idx;
    this.name = name || ('Игрок ' + (idx + 1));
    this.color = U.COLORS[idx % U.COLORS.length];
    this.char = CHARACTERS.find(c => c.id === charId) || CHARACTERS[idx % CHARACTERS.length];
    this.skin = SKIN[this.char.look.skin % SKIN.length];
    this.avatar = null;

    const S = this.char.st;
    this.maxHp = Math.round(PHYS.MAX_HP * (S.hp / 100));
    this.stamMax = S.stam;
    this.guardMax = PHYS.GUARD_MAX * S.guard;

    // персональная таблица ударов с учётом статов персонажа
    this.moves = {};
    for (const [k, a] of Object.entries(ATTACKS)) {
      const hs = a.kind === 'punch' ? S.hands : 1;
      this.moves[k] = Object.assign({}, a, {
        startup: Math.max(2, Math.round(a.startup * hs)),
        recovery: Math.max(4, Math.round(a.recovery * hs)),
        dmg: Math.round(a.dmg * S.dmg),
        stam: Math.round(a.stam * (a.kind === 'punch' ? hs : 1)),
      });
    }

    const sp = ARENA.SPAWNS[idx % ARENA.SPAWNS.length];
    this.x = sp.x; this.y = sp.y;
    this.vx = 0; this.vy = 0;
    this.facing = 1;
    this.onGround = false; this.onFloor = false;
    this.jumps = 0;
    this.dropTimer = 0;

    this.hp = this.maxHp;
    this.stam = this.stamMax;
    this.guard = this.guardMax;
    this.winded = false;
    this.broken = 0;              // кадры стана после пролома блока
    this.slow = 0;                // кадры замедления после лоу-кика

    this.kills = 0; this.deaths = 0;
    this.dead = false;
    this.respawnLeft = 0;
    this.invuln = 0;

    this.state = 'idle';
    this.atk = null;
    this.stun = 0;
    this.blocking = false;
    this.lastHitBy = null;

    // визуальное
    this.animT = 0;
    this.flash = 0;
    this.squash = 0;
    this.rx = 0; this.ry = 0;
    this.prevState = 'idle';
    this.lastDraw = 0;
    this.breath = 0;
  }

  get box() { return { x: this.x - PHYS.W / 2, y: this.y - PHYS.H, w: PHYS.W, h: PHYS.H }; }
  get hpRatio() { return U.clamp(this.hp / this.maxHp, 0, 1); }
  get woundLevel() { return 1 - this.hpRatio; }

  respawn(spawn) {
    this.x = spawn.x; this.y = spawn.y;
    this.vx = 0; this.vy = 0;
    this.hp = this.maxHp;
    this.stam = this.stamMax;
    this.guard = this.guardMax;
    this.winded = false; this.broken = 0; this.slow = 0;
    this.dead = false; this.respawnLeft = 0;
    this.invuln = PHYS.INVULN_MS;
    this.state = 'idle'; this.atk = null; this.stun = 0;
    this.lastHitBy = null;
    this.rx = spawn.x; this.ry = spawn.y;
  }

  /* Какой именно удар выбрать по контексту (направление, приседание, воздух). */
  pickAttack(kind, mask) {
    const down = !!(mask & K.DOWN);
    const fwd = (mask & K.RIGHT && this.facing > 0) || (mask & K.LEFT && this.facing < 0);
    if (kind === 'punch') {
      if (!this.onGround) return 'airpunch';
      if (down) return 'uppercut';
      if (fwd) return 'hook';
      return 'jab';
    }
    if (!this.onGround) return 'divekick';
    if (down) return 'sweep';
    if (fwd) return 'midkick';
    return 'highkick';
  }

  /* ---------- Шаг физики (только на хосте) ---------- */
  step(mask, pressed, dtMs) {
    if (this.dead) {
      this.respawnLeft = Math.max(0, this.respawnLeft - dtMs);
      return;
    }
    if (this.invuln > 0) this.invuln = Math.max(0, this.invuln - dtMs);
    if (this.dropTimer > 0) this.dropTimer--;
    if (this.slow > 0) this.slow--;

    const busy = this.atk !== null;
    const stunned = this.stun > 0;
    if (stunned) this.stun--;
    if (this.broken > 0) this.broken--;
    const locked = stunned || this.broken > 0;

    /* --- блок --- */
    this.blocking = !!(mask & K.BLOCK) && this.onGround && !busy && !locked && this.broken === 0;

    /* --- выносливость --- */
    const moving = !!(mask & (K.LEFT | K.RIGHT));
    if (!busy) {
      const rg = this.blocking ? PHYS.STAM_REGEN_BLOCK : (moving ? PHYS.STAM_REGEN_MOVE : PHYS.STAM_REGEN);
      this.stam = Math.min(this.stamMax, this.stam + rg * (this.winded ? 0.85 : 1));
    }
    if (this.stam <= PHYS.WINDED_AT) this.winded = true;
    if (this.winded && this.stam >= PHYS.WINDED_UNTIL) this.winded = false;

    /* --- прочность блока --- */
    if (this.broken === 0) {
      this.guard = Math.min(this.guardMax,
        this.guard + (this.blocking ? PHYS.GUARD_REGEN_HOLD : PHYS.GUARD_REGEN));
    }

    /* --- горизонтальное движение --- */
    let move = 0;
    if (mask & K.LEFT) move -= 1;
    if (mask & K.RIGHT) move += 1;

    const spdMul = this.char.st.spd * (this.winded ? PHYS.WINDED_SPD : 1) * (this.slow > 0 ? 0.62 : 1);

    if (!locked) {
      if (move !== 0 && !busy) this.facing = move;
      let acc = (this.onGround ? PHYS.ACC : PHYS.AIR_ACC) * spdMul;
      if (this.blocking) acc *= PHYS.BLOCK_SPD;
      if (busy) acc *= 0.25;
      this.vx += move * acc;
    }

    const maxS = PHYS.MAX_SPD * spdMul * (this.blocking ? PHYS.BLOCK_SPD : 1);
    this.vx = U.clamp(this.vx, -maxS, maxS);
    if (move === 0 || locked) this.vx *= this.onGround ? PHYS.FRICTION : PHYS.AIR_FRICTION;
    if (Math.abs(this.vx) < 0.05) this.vx = 0;

    /* --- прыжок --- */
    if ((pressed & K.UP) && !locked && !this.blocking && this.jumps > 0 && this.stam >= PHYS.STAM_JUMP) {
      this.vy = (this.jumps === 2 ? PHYS.JUMP : PHYS.JUMP2) * this.char.st.jump;
      this.jumps--;
      this.onGround = false;
      this.stam -= PHYS.STAM_JUMP;
      this.fxJump = true;
    }

    /* --- спуск сквозь платформу --- */
    if ((pressed & K.DOWN) && this.onGround && !this.onFloor) this.dropTimer = 12;

    /* --- старт удара --- */
    if (!busy && !locked && !this.blocking && (pressed & (K.PUNCH | K.KICK))) {
      const kind = (pressed & K.PUNCH) ? 'punch' : 'kick';
      const name = this.pickAttack(kind, mask);
      const a = this.moves[name];
      if (this.stam >= a.stam) {
        this.stam -= a.stam;
        this.atk = { type: name, frame: 0, hit: new Set() };
        if (name === 'divekick') { this.vy = 9; this.vx = this.facing * 8; }
      } else {
        this.fxNoStam = true;                 // «выдохся» — удар не проходит
      }
    }

    /* --- гравитация и перемещение --- */
    this.vy = Math.min(this.vy + PHYS.GRAV, PHYS.MAX_FALL);
    this.x += this.vx;
    this.y += this.vy;

    const half = PHYS.W / 2;
    if (this.x < half) { this.x = half; this.vx = 0; }
    if (this.x > ARENA.W - half) { this.x = ARENA.W - half; this.vx = 0; }

    const wasAir = !this.onGround;
    this.onGround = false; this.onFloor = false;

    if (this.y >= ARENA.GROUND && this.vy >= 0) {
      this.y = ARENA.GROUND; this.vy = 0;
      this.onGround = true; this.onFloor = true;
    }
    if (!this.onGround && this.vy >= 0 && this.dropTimer === 0) {
      for (const p of ARENA.PLATFORMS) {
        const prevY = this.y - this.vy;
        if (this.x + half > p.x && this.x - half < p.x + p.w && prevY <= p.y + 6 && this.y >= p.y) {
          this.y = p.y; this.vy = 0; this.onGround = true;
          break;
        }
      }
    }
    if (this.onGround) {
      this.jumps = 2;
      if (wasAir) this.squash = 9;
      // приземлились посреди удара с воздуха — обрываем его
      if (this.atk && this.moves[this.atk.type].air) this.atk = null;
    }

    /* --- кадры удара --- */
    if (this.atk) {
      const a = this.moves[this.atk.type];
      this.atk.frame++;
      if (this.atk.frame > a.startup + a.active + a.recovery) this.atk = null;
    }

    /* --- состояние --- */
    if (this.broken > 0) this.state = 'broken';
    else if (this.stun > 0) this.state = 'hit';
    else if (this.atk) this.state = this.atk.type;
    else if (this.blocking) this.state = 'block';
    else if (!this.onGround) this.state = 'air';
    else if (Math.abs(this.vx) > 0.6) this.state = 'run';
    else this.state = 'idle';
  }

  hitbox() {
    if (!this.atk || this.dead) return null;
    const a = this.moves[this.atk.type];
    const f = this.atk.frame;
    if (f <= a.startup || f > a.startup + a.active) return null;
    return {
      x: this.facing > 0 ? this.x + a.ox : this.x - a.ox - a.reach,
      y: this.y + a.oy - a.hh / 2,
      w: a.reach, h: a.hh,
      dmg: a.dmg, kbx: a.kbx, kby: a.kby, stun: a.stun, guard: a.guard,
      type: this.atk.type, kind: a.kind, trip: a.trip, heavy: a.dmg >= 12,
    };
  }

  /* Получить удар. Возвращает {blocked, broken, killed, dmg}. */
  takeHit(hb, fromPid) {
    if (this.dead || this.invuln > 0) return null;
    const dir = Math.sign(this.x - (hb.x + hb.w / 2)) || 1;
    const blocked = this.blocking && Math.sign(this.facing) !== dir;

    let broke = false;
    if (blocked) {
      this.guard -= hb.guard;
      if (this.guard <= 0) {                 // блок проломлен
        this.guard = 0;
        this.broken = PHYS.BREAK_FRAMES;
        this.blocking = false;
        broke = true;
      }
    }

    const dmg = Math.round(hb.dmg * (blocked && !broke ? PHYS.BLOCK_DMG : 1));
    const kb = (blocked && !broke) ? PHYS.BLOCK_KB : 1;

    this.hp = Math.max(0, this.hp - dmg);
    this.vx += dir * hb.kbx * kb;
    this.vy += hb.kby * kb;
    if (!blocked || broke) {
      this.stun = broke ? 0 : hb.stun;       // при проломе действует свой стан
      this.atk = null;
      this.flash = 9;
      if (hb.kby < -3) this.onGround = false;
      if (hb.trip) { this.stun = Math.max(this.stun, hb.stun); this.slow = 90; }
    }
    this.lastHitBy = fromPid;

    const killed = this.hp <= 0;
    if (killed) {
      this.dead = true; this.deaths++;
      this.respawnLeft = PHYS.RESPAWN_MS;
      this.state = 'dead'; this.atk = null; this.blocking = false;
    }
    return { blocked: blocked && !broke, broken: broke, killed, dmg };
  }

  /* ---------- Сеть ---------- */
  toNet() {
    return {
      i: this.pid,
      x: Math.round(this.x * 10) / 10, y: Math.round(this.y * 10) / 10,
      f: this.facing, h: this.hp, s: this.state,
      af: this.atk ? this.atk.frame : 0,
      k: this.kills, d: this.deaths,
      dd: this.dead ? 1 : 0,
      r: Math.round(this.respawnLeft), v: Math.round(this.invuln),
      b: this.blocking ? 1 : 0, fl: Math.round(this.flash),
      sm: Math.round(this.stam), gd: Math.round(this.guard),
      w: this.winded ? 1 : 0,
    };
  }
  fromNet(s) {
    this.x = s.x; this.y = s.y;
    this.facing = s.f; this.hp = s.h; this.state = s.s;
    this.atk = (s.af && ATTACKS[s.s]) ? { type: s.s, frame: s.af, hit: null } : null;
    this.kills = s.k; this.deaths = s.d;
    this.dead = !!s.dd; this.respawnLeft = s.r; this.invuln = s.v;
    this.blocking = !!s.b;
    this.stam = s.sm; this.guard = s.gd; this.winded = !!s.w;
    if (s.fl > this.flash) this.flash = s.fl;
  }

  /* =================================================================
     ПОЗА
     ================================================================= */
  pose(now) {
    const f = this.facing, x = this.rx, y = this.ry;
    const st = this.state;
    const B = BODY;
    const a = this.moves[st] || null;
    const prog = (a && this.atk) ? this.attackProgress(a) : 0;

    const squash = (this.squash / 9) * 7;
    const crouch = squash + (st === 'block' ? 6 : 0) + (st === 'broken' ? 9 : 0)
                 + (this.winded && (st === 'idle' || st === 'run') ? 3 : 0)
                 + (st === 'uppercut' ? -Math.max(0, prog) * 6 : 0)
                 + (st === 'sweep' ? 16 : 0);

    // дыхание: на отдышке грудь ходит заметно чаще и глубже
    const bs = this.winded ? 260 : 620;
    const ba = this.winded ? 3.2 : 1.1;
    const breathe = Math.sin(now / bs) * ba;
    this.breath = breathe;

    let lean = 2;
    if (st === 'run') lean = 7;
    else if (a && a.kind === 'punch') lean = 9;
    else if (a && a.kind === 'kick') lean = -7;
    else if (st === 'hit') lean = -10;
    else if (st === 'broken') lean = -14;
    else if (st === 'block') lean = 4;
    else if (st === 'air') lean = 3;
    if (st === 'divekick') lean = 12;

    const hipX = x - f * lean * 0.25;
    const hipY = y + B.HIP_Y + crouch;
    const shX = x + f * lean * 0.75;
    const shY = y + B.SHOULDER_Y + crouch * 1.25 + breathe;

    const shFront = { x: shX + f * 7, y: shY + 2 };
    const shBack  = { x: shX - f * 9, y: shY };

    const p = { f, x, y, hipX, hipY, shX, shY, shFront, shBack, crouch, lean, breathe,
                headX: shX + f * 4, headY: y + B.HEAD_Y + crouch * 1.3 + breathe,
                neckY: y + B.NECK_Y + crouch * 1.25 + breathe };

    /* ---------- стопы ---------- */
    if (st === 'run') {
      const ph = this.animT * Math.PI * 2;
      const foot = (phase) => ({
        x: hipX + f * Math.cos(phase) * 21,
        y: y - Math.max(0, Math.sin(phase)) * 17,
      });
      p.footFront = foot(ph); p.footBack = foot(ph + Math.PI);
    } else if (st === 'divekick') {
      p.footFront = { x: hipX + f * (30 + prog * 44), y: y + this.moves.divekick.oy + 18 };
      p.footBack  = { x: hipX - f * 16, y: y - 26 };
    } else if (st === 'air' || (a && a.air)) {
      const up = U.clamp(-this.vy / 18, -1, 1);
      p.footFront = { x: hipX + f * 19, y: y - 20 - up * 8 };
      p.footBack  = { x: hipX - f * 11, y: y - 8 + up * 6 };
    } else if (a && a.kind === 'kick') {
      const reach = 18 + Math.max(0, prog) * (st === 'sweep' ? 62 : 70);
      p.footFront = { x: hipX + f * reach, y: y + a.oy + (st === 'sweep' ? 14 : 8) };
      p.footBack  = { x: hipX - f * 15, y: y };
    } else if (st === 'hit' || st === 'broken') {
      p.footFront = { x: hipX + f * 20, y: y };
      p.footBack  = { x: hipX - f * 9, y: y - 3 };
    } else if (a && a.kind === 'punch') {
      p.footFront = { x: hipX + f * 22, y: y };
      p.footBack  = { x: hipX - f * 17, y: y };
    } else {
      const sway = Math.sin(now / 700) * 1.5;
      p.footFront = { x: hipX + f * (16 + sway), y: y };
      p.footBack  = { x: hipX - f * (15 + sway), y: y };
    }

    /* ---------- кисти ---------- */
    const chinF = { x: shFront.x + f * 13, y: shY - 12 };
    const chinB = { x: shBack.x + f * 8,  y: shY - 8 };

    if (a && a.kind === 'punch') {
      const pr = Math.max(0, prog);
      if (st === 'uppercut') {
        // снизу вверх по дуге
        p.handFront = { x: shFront.x + f * (10 + pr * 34), y: shY + 26 - pr * 76 };
      } else if (st === 'hook') {
        // сбоку по дуге
        const ang = (1 - pr) * 1.5;
        p.handFront = { x: shFront.x + f * (14 + pr * 54) - f * Math.sin(ang) * 16,
                        y: shY - 6 - Math.cos(ang) * 10 };
      } else {
        p.handFront = { x: shFront.x + f * (16 + pr * 58), y: y + a.oy + 6 };
      }
      p.handBack = chinB;
    } else if (a && a.kind === 'kick') {
      p.handFront = { x: shFront.x - f * 10, y: shY + 6 };
      p.handBack  = { x: shBack.x - f * 20, y: shY - 6 };
    } else if (st === 'block') {
      p.handFront = { x: shFront.x + f * 20, y: shY - 14 };
      p.handBack  = { x: shBack.x + f * 17, y: shY - 2 };
    } else if (st === 'broken') {
      p.handFront = { x: shFront.x - f * 12, y: shY + 30 };     // руки повисли
      p.handBack  = { x: shBack.x - f * 18, y: shY + 26 };
    } else if (st === 'run') {
      const ph = this.animT * Math.PI * 2;
      p.handFront = { x: shFront.x + f * (10 + Math.cos(ph + Math.PI) * 15), y: shY + 24 };
      p.handBack  = { x: shBack.x + f * (6 + Math.cos(ph) * 15), y: shY + 26 };
    } else if (st === 'air') {
      p.handFront = { x: shFront.x + f * 20, y: shY - 16 };
      p.handBack  = { x: shBack.x - f * 16, y: shY - 14 };
    } else if (st === 'hit') {
      p.handFront = { x: shFront.x + f * 6, y: shY - 22 };
      p.handBack  = { x: shBack.x - f * 14, y: shY - 18 };
    } else if (this.winded) {
      // руки на коленях — отдышка
      p.handFront = { x: shFront.x + f * 14, y: hipY + 4 + breathe };
      p.handBack  = { x: shBack.x + f * 6,  y: hipY + 6 - breathe };
    } else {
      const b = Math.sin(now / 480) * 2;
      p.handFront = { x: chinF.x, y: chinF.y + b };
      p.handBack  = { x: chinB.x, y: chinB.y - b };
    }

    /* ---------- суставы ---------- */
    p.kneeFront = solveIK(hipX + f * 5, hipY, p.footFront.x, p.footFront.y - 9, B.THIGH, B.SHIN, -f);
    p.kneeBack  = solveIK(hipX - f * 5, hipY, p.footBack.x,  p.footBack.y - 9,  B.THIGH, B.SHIN, -f);
    p.elbowFront = solveIK(shFront.x, shFront.y, p.handFront.x, p.handFront.y, B.UPPER_ARM, B.FOREARM, f);
    p.elbowBack  = solveIK(shBack.x,  shBack.y,  p.handBack.x,  p.handBack.y,  B.UPPER_ARM, B.FOREARM, f);

    p.handFront = { x: p.elbowFront.ex, y: p.elbowFront.ey };
    p.handBack  = { x: p.elbowBack.ex,  y: p.elbowBack.ey };
    p.footFront = { x: p.kneeFront.ex,  y: p.kneeFront.ey + 9 };
    p.footBack  = { x: p.kneeBack.ex,   y: p.kneeBack.ey + 9 };

    return p;
  }

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
    const dt = this.lastDraw ? U.clamp(now - this.lastDraw, 0, 100) : 16;
    this.lastDraw = now;
    const k = dt / 16.67;
    if (this.flash > 0) this.flash = Math.max(0, this.flash - k);
    if (this.squash > 0) this.squash = Math.max(0, this.squash - k);
    if (this.prevState === 'air' && this.state !== 'air' && this.state !== 'dead') this.squash = 9;
    if (this.state === 'run') this.animT += dt / 1000 * 2.6;
    this.prevState = this.state;

    if (this.rx === 0 && this.ry === 0) { this.rx = this.x; this.ry = this.y; }
    this.rx = U.lerp(this.rx, this.x, U.clamp(0.35 * k, 0, 1));
    this.ry = U.lerp(this.ry, this.y, U.clamp(0.45 * k, 0, 1));

    const x = this.rx, y = this.ry;

    /* тень */
    const gy = this.groundBelow();
    c.save();
    c.globalAlpha = U.clamp(1 - (gy - y) / 500, .08, .38);
    c.fillStyle = '#000';
    c.beginPath(); c.ellipse(x, gy - 2, 38 * U.clamp(1 - (gy - y) / 900, .4, 1), 8, 0, 0, 7); c.fill();
    c.restore();

    if (this.dead) { this.drawDown(c, x, y, now); return; }

    c.save();
    if (this.invuln > 0 && Math.floor(now / 90) % 2 === 0) c.globalAlpha = 0.4;

    const p = this.pose(now);
    if (this.state === 'hit' || this.state === 'broken') {
      c.translate(x, y);
      c.rotate(Math.sin(now / (this.state === 'broken' ? 60 : 22)) * 0.05 * this.facing);
      c.translate(-x, -y);
    }

    // дальние конечности
    this.drawLeg(c, p, p.kneeBack, p.footBack, true);
    this.drawArm(c, p.shBack, p.elbowBack, p.handBack, true);
    // корпус
    this.drawTorso(c, p);
    // ближние конечности
    this.drawLeg(c, p, p.kneeFront, p.footFront, false);
    this.drawArm(c, p.shFront, p.elbowFront, p.handFront, false);
    // голова
    this.drawHead(c, p, now);
    // кровь на теле
    this.drawWounds(c, p, now);

    /* щит блока — толщина показывает остаток прочности */
    if (this.blocking) {
      const gr = U.clamp(this.guard / this.guardMax, 0, 1);
      c.save();
      c.strokeStyle = gr > .35 ? U.rgba('#ffffff', .30 + gr * .35) : U.rgba('#ff5a5a', .75);
      c.shadowColor = gr > .35 ? '#fff' : '#ff5a5a';
      c.shadowBlur = 14; c.lineWidth = 2 + gr * 4;
      c.beginPath();
      c.arc(p.shX + p.f * 10, y - 70, 60,
            p.f > 0 ? -1.15 : Math.PI - 1.15, p.f > 0 ? 1.15 : Math.PI + 1.15);
      c.stroke();
      c.restore();
    }

    /* звёздочки над головой при проломленном блоке */
    if (this.broken > 0 || this.state === 'broken') {
      c.save();
      c.fillStyle = '#ffd23a';
      for (let i = 0; i < 3; i++) {
        const ang = now / 260 + i * 2.1;
        c.beginPath();
        c.arc(p.headX + Math.cos(ang) * 26, p.headY - 30 + Math.sin(ang) * 8, 3.5, 0, 7);
        c.fill();
      }
      c.restore();
    }

    /* пар изо рта на отдышке */
    if (this.winded) {
      const t = (now % 900) / 900;
      c.save();
      c.globalAlpha = (1 - t) * 0.45;
      c.fillStyle = '#cfe6ff';
      c.beginPath();
      c.ellipse(p.headX + p.f * (18 + t * 26), p.headY + 8 + t * 4, 6 + t * 11, 4 + t * 7, 0, 0, 7);
      c.fill();
      c.restore();
    }

    c.restore();
    this.drawHUD(c, x, y + BODY.HEAD_Y - BODY.HEAD_R - 32);
  }

  /* ---- одежда: цвета ---- */
  get suitColor() { return this.color; }
  get pantsColor() { return U.shade(this.color, -.34); }

  /* Нога: штанина/голая нога + ботинок. */
  drawLeg(c, p, knee, foot, back) {
    const B = BODY, look = this.char.look;
    const skin = back ? this.skin.d : this.skin.s;
    const pants = back ? U.shade(this.pantsColor, -.12) : this.pantsColor;
    const hipX = p.hipX + p.f * (back ? -5 : 5);
    const shorts = look.top === 'wrestle' || look.top === 'tank';   // короткие — голень голая

    c.save();
    c.lineCap = 'round';

    // бедро всегда в штанине/трусах
    c.strokeStyle = pants; c.lineWidth = B.THIGH_W + 2;
    c.beginPath(); c.moveTo(hipX, p.hipY); c.lineTo(knee.x, knee.y); c.stroke();

    // голень
    c.strokeStyle = shorts ? skin : pants;
    c.lineWidth = shorts ? B.SHIN_W : B.SHIN_W + 2;
    c.beginPath(); c.moveTo(knee.x, knee.y); c.lineTo(foot.x, foot.y - 9); c.stroke();

    // лампасы по внешней стороне штанины
    if (look.stripes && !shorts) {
      const stripe = (x1, y1, x2, y2) => {
        const dx = x2 - x1, dy = y2 - y1, l = Math.hypot(dx, dy) || 1;
        const nx = -dy / l * 5.5, ny = dx / l * 5.5;
        c.beginPath(); c.moveTo(x1 + nx, y1 + ny); c.lineTo(x2 + nx, y2 + ny); c.stroke();
      };
      c.strokeStyle = 'rgba(255,255,255,.85)'; c.lineWidth = 2.5;
      stripe(hipX, p.hipY, knee.x, knee.y);
      stripe(knee.x, knee.y, foot.x, foot.y - 9);
    }

    // колено
    c.fillStyle = shorts ? U.shade(skin, -.06) : U.shade(pants, -.08);
    c.beginPath(); c.arc(knee.x, knee.y, (shorts ? B.SHIN_W : B.SHIN_W + 2) / 2, 0, 7); c.fill();

    // кроссовок
    c.fillStyle = back ? '#dcdcdc' : '#f2f2f2';
    c.strokeStyle = 'rgba(0,0,0,.4)'; c.lineWidth = 1.5;
    rr(c, foot.x - (p.f > 0 ? 5 : B.FOOT_L - 5), foot.y - 11, B.FOOT_L, 11, 4);
    c.fill(); c.stroke();
    c.fillStyle = this.suitColor;                       // цветная полоса на кроссовке
    rr(c, foot.x - (p.f > 0 ? 5 : B.FOOT_L - 5), foot.y - 5, B.FOOT_L, 3, 1.5); c.fill();
    c.restore();
  }

  /* Рука: рукав/голая рука + кулак (у боксёра — бинты). */
  drawArm(c, sh, elbow, hand, back) {
    const B = BODY, look = this.char.look;
    const skin = back ? this.skin.d : this.skin.s;
    const sleeve = back ? U.shade(this.suitColor, -.18) : this.suitColor;
    const sleeved = look.top === 'track' || look.top === 'jacket';

    c.save();
    c.lineCap = 'round';

    c.strokeStyle = sleeved ? sleeve : skin;
    c.lineWidth = sleeved ? B.ARM_W + 2 : B.ARM_W;
    c.beginPath(); c.moveTo(sh.x, sh.y); c.lineTo(elbow.x, elbow.y); c.stroke();

    c.strokeStyle = sleeved ? sleeve : skin;
    c.lineWidth = sleeved ? B.FOREARM_W + 2 : B.FOREARM_W;
    c.beginPath(); c.moveTo(elbow.x, elbow.y); c.lineTo(hand.x, hand.y); c.stroke();

    if (look.stripes && sleeved) {
      const dx = elbow.x - sh.x, dy = elbow.y - sh.y, l = Math.hypot(dx, dy) || 1;
      const nx = -dy / l * 5, ny = dx / l * 5;
      c.strokeStyle = 'rgba(255,255,255,.85)'; c.lineWidth = 2.2;
      c.beginPath(); c.moveTo(sh.x + nx, sh.y + ny); c.lineTo(elbow.x + nx, elbow.y + ny); c.stroke();
    }

    c.fillStyle = U.shade(sleeved ? sleeve : skin, -.08);
    c.beginPath(); c.arc(elbow.x, elbow.y, B.FOREARM_W / 2 + .5, 0, 7); c.fill();

    // кулак
    const fistCol = this.char.id === 'boxer' ? '#e9e4d8' : skin;
    const g = c.createRadialGradient(hand.x - 3, hand.y - 3, 1, hand.x, hand.y, B.GLOVE_R + 2);
    g.addColorStop(0, U.shade(fistCol, .12));
    g.addColorStop(1, U.shade(fistCol, -.18));
    c.fillStyle = g;
    c.beginPath(); c.arc(hand.x, hand.y, B.GLOVE_R, 0, 7); c.fill();
    c.strokeStyle = 'rgba(0,0,0,.35)'; c.lineWidth = 1.4; c.stroke();
    if (this.char.id === 'boxer') {                     // бинты
      c.strokeStyle = 'rgba(0,0,0,.18)'; c.lineWidth = 1;
      c.beginPath(); c.moveTo(hand.x - 7, hand.y - 2); c.lineTo(hand.x + 7, hand.y - 2); c.stroke();
      c.beginPath(); c.moveTo(hand.x - 7, hand.y + 2); c.lineTo(hand.x + 7, hand.y + 2); c.stroke();
    }
    c.restore();
  }

  /* Торс + одежда по типу персонажа. */
  drawTorso(c, p) {
    const B = BODY, f = p.f, look = this.char.look;
    const sL = p.shX - B.SHOULDER_HW, sR = p.shX + B.SHOULDER_HW;
    const wY = (p.shY + p.hipY) / 2 + 4;
    const wL = p.hipX - B.WAIST_HW, wR = p.hipX + B.WAIST_HW;
    const hL = p.hipX - B.HIP_HW,   hR = p.hipX + B.HIP_HW;

    // силуэт корпуса
    const path = () => {
      c.beginPath();
      c.moveTo(sL, p.shY + 4);
      c.quadraticCurveTo(sL - 2, wY - 6, wL, wY);
      c.lineTo(hL, p.hipY + 6);
      c.lineTo(hR, p.hipY + 6);
      c.quadraticCurveTo(wR + 2, wY - 6, sR, p.shY + 4);
      c.quadraticCurveTo(p.shX, p.shY - 12, sL, p.shY + 4);
      c.closePath();
    };

    c.save();

    const bare = look.top === 'tank' || look.top === 'wrestle' || look.top === 'vest';
    const cloth = look.top === 'jacket' ? U.shade(this.suitColor, -.42) : this.suitColor;

    // кожа (видна у маек/жилетов) или ткань
    const base = bare ? this.skin.s : cloth;
    const g = c.createLinearGradient(sL, p.shY, sR, p.hipY);
    g.addColorStop(0, U.shade(base, .07));
    g.addColorStop(.55, base);
    g.addColorStop(1, U.shade(base, -.15));
    c.fillStyle = g;
    path(); c.fill();

    // объём: тень с дальней стороны
    c.save(); path(); c.clip();
    const sg = c.createLinearGradient(p.shX - f * 26, 0, p.shX + f * 26, 0);
    sg.addColorStop(0, 'rgba(0,0,0,.30)');
    sg.addColorStop(.6, 'rgba(0,0,0,0)');
    c.fillStyle = sg;
    c.fillRect(sL - 12, p.shY - 22, (sR - sL) + 24, p.hipY - p.shY + 44);

    // детали одежды поверх (внутри клипа корпуса)
    if (look.top === 'tank') {
      c.fillStyle = U.shade(this.suitColor, .04);
      c.beginPath();
      c.moveTo(p.shX - 13, p.shY - 2); c.lineTo(p.shX + 13, p.shY - 2);
      c.lineTo(wR, p.hipY + 8); c.lineTo(wL, p.hipY + 8);
      c.closePath(); c.fill();
    } else if (look.top === 'wrestle') {
      c.fillStyle = U.shade(this.suitColor, -.05);
      c.beginPath();
      c.moveTo(p.shX - 16, p.shY + 2); c.lineTo(p.shX + 16, p.shY + 2);
      c.lineTo(hR + 2, p.hipY + 10); c.lineTo(hL - 2, p.hipY + 10);
      c.closePath(); c.fill();
      c.fillStyle = U.shade(this.suitColor, .14);        // лямка через плечо
      c.fillRect(p.shX + f * 4 - 6, p.shY - 6, 12, 30);
    } else if (look.top === 'vest') {
      c.fillStyle = U.shade(this.suitColor, -.18);
      c.fillRect(sL + 2, p.shY - 2, 16, p.hipY - p.shY + 10);
      c.fillRect(sR - 18, p.shY - 2, 16, p.hipY - p.shY + 10);
    } else {
      // спортивка/куртка: молния и лампасы по бокам
      c.strokeStyle = 'rgba(0,0,0,.35)'; c.lineWidth = 2;
      c.beginPath(); c.moveTo(p.shX + f * 3, p.shY - 4); c.lineTo(p.shX + f * 3, p.hipY + 6); c.stroke();
      if (look.stripes) {
        c.strokeStyle = 'rgba(255,255,255,.85)'; c.lineWidth = 2.5;
        c.beginPath(); c.moveTo(sL + 6, p.shY + 4); c.lineTo(wL + 4, wY + 10); c.stroke();
        c.beginPath(); c.moveTo(sR - 6, p.shY + 4); c.lineTo(wR - 4, wY + 10); c.stroke();
      }
    }

    // мышцы под голым торсом
    if (bare) {
      c.strokeStyle = 'rgba(0,0,0,.16)'; c.lineWidth = 2;
      c.beginPath(); c.arc(p.shX + f * 2, p.shY + 4, 15, .15, Math.PI - .15); c.stroke();
      c.globalAlpha = .5;
      for (let i = 0; i < 2; i++) {
        const yy = wY - 6 + i * 9;
        c.beginPath(); c.moveTo(p.hipX - 9, yy); c.lineTo(p.hipX + 9, yy); c.stroke();
      }
      c.globalAlpha = 1;
    }
    c.restore();

    // штаны/шорты на тазе
    c.fillStyle = this.pantsColor;
    c.beginPath();
    c.moveTo(wL + 1, wY + 8); c.lineTo(wR - 1, wY + 8);
    c.lineTo(hR + 2, p.hipY + 14); c.lineTo(p.hipX, p.hipY + 6); c.lineTo(hL - 2, p.hipY + 14);
    c.closePath(); c.fill();
    c.fillStyle = U.shade(this.pantsColor, .22);
    rr(c, wL, wY + 4, wR - wL, 6, 3); c.fill();

    // шея
    c.strokeStyle = U.shade(this.skin.s, -.10); c.lineWidth = 15; c.lineCap = 'round';
    c.beginPath(); c.moveTo(p.headX - f, p.neckY + 8); c.lineTo(p.headX, p.neckY - 4); c.stroke();

    c.restore();
  }

  /* Голова: вырезанное фото по силуэту, без свечения. Плюс головной убор. */
  drawHead(c, p, now) {
    const R = BODY.HEAD_R;
    const hx = p.headX, hy = p.headY;

    c.save();
    if (this.avatar && this.avatar.complete && this.avatar.naturalWidth) {
      // фото уже с прозрачным фоном — рисуем силуэт как есть
      const w = R * 2.34, h = R * 2.34;
      c.save();
      c.translate(hx, hy);
      if (p.f < 0) c.scale(-1, 1);                    // разворачиваем вместе с бойцом
      // мягкая тень под головой, чтобы силуэт не «висел» в воздухе
      c.globalAlpha = 0.28; c.fillStyle = '#000';
      c.beginPath(); c.ellipse(0, R * 0.86, R * 0.72, R * 0.26, 0, 0, 7); c.fill();
      c.globalAlpha = 1;
      c.drawImage(this.avatar, -w / 2, -h / 2 - R * 0.08, w, h);
      c.restore();
    } else {
      // болванка, если фото нет: овал головы + причёска + ухо
      c.fillStyle = this.skin.s;
      c.beginPath(); c.ellipse(hx, hy, R * 0.86, R, 0, 0, 7); c.fill();
      c.fillStyle = U.shade(this.skin.s, -.22);
      c.beginPath(); c.ellipse(hx - p.f * R * 0.7, hy + 2, 4, 6, 0, 0, 7); c.fill();  // ухо
      c.fillStyle = '#2b2118';
      c.beginPath(); c.ellipse(hx, hy - R * 0.42, R * 0.88, R * 0.62, 0, Math.PI, 0); c.fill();
      c.fillStyle = 'rgba(0,0,0,.65)';
      c.beginPath(); c.ellipse(hx + p.f * 6, hy - 1, 2.4, 3, 0, 0, 7); c.fill();
    }

    // вспышка при получении урона
    if (this.flash > 0) {
      c.save();
      c.globalAlpha = U.clamp(this.flash / 16, 0, .5);
      c.fillStyle = '#fff';
      c.beginPath(); c.ellipse(hx, hy, R * .95, R * 1.05, 0, 0, 7); c.fill();
      c.restore();
    }

    this.drawHat(c, p, hx, hy, R, now);
    c.restore();
  }

  /* Головной убор — заодно метка персонажа. */
  drawHat(c, p, hx, hy, R, now) {
    const f = p.f, hat = this.char.look.hat;
    if (hat === 'none') return;
    c.save();

    if (hat === 'cap') {
      const top = hy - R * 0.92;
      c.fillStyle = U.shade(this.suitColor, -.20);
      c.beginPath(); c.ellipse(hx, top + 7, R * 0.92, R * 0.62, 0, Math.PI, 0); c.fill();
      c.fillRect(hx - R * 0.92, top + 5, R * 1.84, 5);
      c.fillStyle = U.shade(this.suitColor, -.34);       // козырёк
      c.beginPath();
      c.ellipse(hx + f * R * 0.55, top + 9, R * 0.80, 5.5, 0, Math.PI, 0);
      c.fill();
      c.fillStyle = 'rgba(255,255,255,.65)';             // кнопка
      c.beginPath(); c.arc(hx, top + 1, 2.2, 0, 7); c.fill();
    }
    else if (hat === 'papaha') {
      const top = hy - R * 0.86;
      c.fillStyle = '#2c2620';
      rr(c, hx - R * 0.98, top - R * 0.86, R * 1.96, R * 1.05, 6); c.fill();
      // мохнатый край
      c.fillStyle = '#3a332b';
      for (let i = 0; i < 9; i++) {
        const px = hx - R * 0.98 + (i + .5) * (R * 1.96 / 9);
        c.beginPath(); c.arc(px, top + R * 0.16, 5.2, 0, 7); c.fill();
      }
      c.fillStyle = 'rgba(255,255,255,.06)';
      rr(c, hx - R * 0.9, top - R * 0.78, R * 0.7, R * 0.85, 5); c.fill();
    }
    else if (hat === 'beanie') {
      const top = hy - R * 0.9;
      c.fillStyle = U.shade(this.suitColor, -.28);
      c.beginPath(); c.ellipse(hx, top + 8, R * 0.94, R * 0.70, 0, Math.PI, 0); c.fill();
      c.fillStyle = U.shade(this.suitColor, -.14);
      rr(c, hx - R * 0.94, top + 4, R * 1.88, 7, 3); c.fill();
      c.fillStyle = U.shade(this.suitColor, -.28);       // помпон
      c.beginPath(); c.arc(hx - f * 2, top - R * 0.42, 5, 0, 7); c.fill();
    }
    c.restore();
  }

  /* Кровь и ссадины: чем меньше HP, тем больше. Позиции стабильны для бойца. */
  drawWounds(c, p, now) {
    const w = this.woundLevel;
    if (w < 0.22) return;
    const n = Math.min(6, Math.floor(w * 7));
    c.save();
    c.globalAlpha = U.clamp(w * 1.1, 0, .92);
    c.fillStyle = BLOOD;

    for (let i = 0; i < n; i++) {
      const r1 = hashF(this.pid, i), r2 = hashF(this.pid, i + 40), r3 = hashF(this.pid, i + 80);
      if (i < 2) {
        // на лице: рассечение брови и кровь из носа
        const hx = p.headX + (r1 - .5) * BODY.HEAD_R * 1.1;
        const hy = p.headY + (r2 - .3) * BODY.HEAD_R * 0.8;
        c.beginPath(); c.ellipse(hx, hy, 2 + r3 * 2, 1.2 + r3 * 1.4, r1 * 3, 0, 7); c.fill();
        // потёк вниз
        c.fillRect(hx - .8, hy, 1.7, 4 + w * 9 + r3 * 4);
      } else {
        // на корпусе
        const bx = p.hipX + (r1 - .5) * 30;
        const by = p.shY + 8 + r2 * (p.hipY - p.shY);
        c.beginPath(); c.ellipse(bx, by, 2 + r3 * 3.4, 1.5 + r3 * 2.4, r2 * 3, 0, 7); c.fill();
        c.fillRect(bx - 1, by, 2, 5 + w * 12 * r3);
      }
    }
    c.restore();
  }

  /* Полоски над головой: HP, выносливость, прочность блока. */
  drawHUD(c, x, y) {
    const w = 92;
    c.save();
    c.font = '600 13px "JetBrains Mono", monospace';
    c.textAlign = 'center';
    c.fillStyle = 'rgba(0,0,0,.65)';
    c.fillText(this.name, x + 1, y - 9);
    c.fillStyle = this.color;
    c.fillText(this.name, x, y - 10);

    // фон под все полоски
    c.fillStyle = 'rgba(0,0,0,.72)';
    rr(c, x - w / 2 - 2, y - 2, w + 4, 18, 6); c.fill();

    // HP
    const p = this.hpRatio;
    const g = c.createLinearGradient(x - w / 2, 0, x + w / 2, 0);
    if (p > .5)       { g.addColorStop(0, '#7cff5a'); g.addColorStop(1, '#39d97a'); }
    else if (p > .25) { g.addColorStop(0, '#ffd23a'); g.addColorStop(1, '#ff9d2e'); }
    else              { g.addColorStop(0, '#ff5a5a'); g.addColorStop(1, '#ff2d6f'); }
    c.fillStyle = g;
    rr(c, x - w / 2, y, w * p, 9, 4); c.fill();
    c.strokeStyle = 'rgba(0,0,0,.45)'; c.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const sx = x - w / 2 + (w * i) / 4;
      c.beginPath(); c.moveTo(sx, y); c.lineTo(sx, y + 9); c.stroke();
    }

    // выносливость (мигает красным на отдышке)
    const sp = U.clamp(this.stam / this.stamMax, 0, 1);
    c.fillStyle = this.winded ? '#ff5a5a' : '#8fd6ff';
    rr(c, x - w / 2, y + 11, w * sp, 4, 2); c.fill();

    // прочность блока — показываем, только когда она просела
    const gp = U.clamp(this.guard / this.guardMax, 0, 1);
    if (gp < 0.995) {
      c.fillStyle = gp > .3 ? 'rgba(255,255,255,.75)' : '#ffb300';
      rr(c, x - w / 2, y + 16, w * gp, 3, 1.5); c.fill();
    }
    c.restore();
  }

  /* Павший боец: лежит на земле, лужа крови и таймер. */
  drawDown(c, x, y, now) {
    const R = BODY.HEAD_R;
    c.save();

    // лужа
    c.globalAlpha = .55;
    c.fillStyle = BLOOD;
    c.beginPath(); c.ellipse(x, y - 3, 46, 9, 0, 0, 7); c.fill();
    c.globalAlpha = 1;

    // тело лёжа
    c.save();
    c.translate(x, y);
    c.rotate(-Math.PI / 2 * this.facing);
    c.translate(0, 6);
    c.fillStyle = this.char.look.top === 'jacket' ? U.shade(this.suitColor, -.42) : this.suitColor;
    rr(c, -16, -46, 32, 52, 12); c.fill();
    c.strokeStyle = this.pantsColor; c.lineWidth = 15; c.lineCap = 'round';
    c.beginPath(); c.moveTo(-8, 4); c.lineTo(-10, 42); c.stroke();
    c.beginPath(); c.moveTo(8, 4); c.lineTo(12, 42); c.stroke();
    c.strokeStyle = this.skin.d; c.lineWidth = 11;
    c.beginPath(); c.moveTo(-12, -34); c.lineTo(-26, -6); c.stroke();
    c.beginPath(); c.moveTo(12, -34); c.lineTo(26, -8); c.stroke();
    c.restore();

    // голова сбоку
    const hx = x + this.facing * 38, hy = y - 14;
    if (this.avatar && this.avatar.complete && this.avatar.naturalWidth) {
      c.save();
      c.translate(hx, hy);
      c.rotate(this.facing * 1.35);
      if (this.facing < 0) c.scale(-1, 1);
      c.globalAlpha = .92;
      c.drawImage(this.avatar, -R * 1.1, -R * 1.1, R * 2.2, R * 2.2);
      c.restore();
    } else {
      c.fillStyle = this.skin.s;
      c.beginPath(); c.ellipse(hx, hy, R * 0.9, R * 0.8, 0, 0, 7); c.fill();
    }

    // таймер респавна
    c.globalAlpha = .55 + Math.sin(now / 300) * .12;
    c.font = '700 26px "Bebas Neue", sans-serif';
    c.textAlign = 'center';
    c.fillStyle = this.color;
    c.fillText(Math.ceil(this.respawnLeft / 1000) + 'с', x, y - 66);
    c.restore();
  }

  groundBelow() {
    let best = ARENA.GROUND;
    for (const p of ARENA.PLATFORMS) {
      if (this.rx > p.x && this.rx < p.x + p.w && p.y >= this.ry - 2 && p.y < best) best = p.y;
    }
    return best;
  }
}
