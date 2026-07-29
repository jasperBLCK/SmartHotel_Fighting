/* ===================================================================
   touch.js — экранное управление для телефона.

   Кнопки складываются в ту же маску ввода, что и клавиши на компьютере
   (см. K в fighter.js), поэтому по сети мобильный игрок неотличим от
   компьютерного: протокол один, кроссплей получается сам собой.

   Что здесь важного и неочевидного:

   1. Касания обрабатываются на уровне всей панели, а не каждой кнопкой
      по отдельности. Только так работает и мультитач (идти и бить
      одновременно — это два пальца), и скольжение пальцем с «влево» на
      «вправо» без отрыва. Если вешать обработчики на кнопки, палец,
      уехавший за границу, оставляет кнопку нажатой навсегда.

   2. Любой уход в сторону — сворачивание приложения, звонок, погасший
      экран — отпускает всё разом. Иначе боец останется бежать в стену.

   3. Панель живёт внутри экрана боя, поэтому в меню и лобби её нет.
   =================================================================== */

const Touch = (() => {

  /* Телефон/планшет определяем по «грубому» указателю: у мыши он точный.
     Ноутбуки с сенсорным экраном получат и кнопки, и клавиатуру — пусть
     человек сам решает, чем играть. */
  const isTouch = (() => {
    try { return matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window; }
    catch (e) { return 'ontouchstart' in window; }
  })();

  /* Раскладка. Руки — верхний ряд, ноги — нижний: та же логика, что и на
     клавиатуре (U I O над J K L), чтобы объяснение управления было одно
     на всех. */
  const MOVE = [
    { k: 'UP',    t: '▲', cls: 'tb-u' },
    { k: 'LEFT',  t: '◀', cls: 'tb-l' },
    { k: 'RIGHT', t: '▶', cls: 'tb-r' },
    { k: 'DOWN',  t: '▼', cls: 'tb-d' },
  ];
  const HITS = [
    { k: 'JAB',   t: 'ДЖЕБ',  cls: 'tb-hand' },
    { k: 'HOOK',  t: 'ХУК',   cls: 'tb-hand' },
    { k: 'UPPER', t: 'АППЕР', cls: 'tb-hand' },
    { k: 'HIGH',  t: 'ХАЙ',   cls: 'tb-leg' },
    { k: 'LOW',   t: 'ЛОУ',   cls: 'tb-leg' },
    { k: 'SWEEP', t: 'ПОДС',  cls: 'tb-leg' },
  ];
  const BLOCK = { k: 'BLOCK', t: 'БЛОК', cls: 'tb-block' };

  let root = null;
  const held = new Map();          // id касания -> кнопка, которую он держит

  function button(def) {
    const el = document.createElement('div');
    el.className = 'tbtn ' + def.cls;
    el.dataset.bit = def.k;
    el.innerHTML = '<span class="tbl">' + def.t + '</span>' +
                   (def.sub ? '<span class="tbs">' + def.sub + '</span>' : '');
    return el;
  }

  function build() {
    root = document.createElement('div');
    root.className = 'touch-pad';

    /* Блок — на левой стороне, рядом с движением: на компьютере он тоже
       под левой рукой (Shift), и держать его, отступая, надо одновременно
       с шагами. Правый палец при этом свободен для ударов. */
    const left = document.createElement('div');
    left.className = 'tp-left';
    const pad = document.createElement('div');
    pad.className = 'tp-pad';
    MOVE.forEach(d => pad.appendChild(button(d)));
    left.appendChild(pad);
    left.appendChild(button(BLOCK));

    const right = document.createElement('div');
    right.className = 'tp-right';
    HITS.forEach(d => right.appendChild(button(d)));

    root.appendChild(left);
    root.appendChild(right);
    document.getElementById('screen-game').appendChild(root);
  }

  /* Какая кнопка под пальцем прямо сейчас. */
  function under(touch) {
    const el = document.elementFromPoint(touch.clientX, touch.clientY);
    return el ? el.closest('.tbtn') : null;
  }

  function press(el) {
    if (!el) return;
    el.classList.add('on');
    Game.setInput(K[el.dataset.bit], true);
  }

  /* Отпускаем кнопку, только если её не держит какой-нибудь другой палец:
     двумя пальцами на одной кнопке никого не удивишь. */
  function release(el, exceptId) {
    if (!el) return;
    for (const [id, e] of held) if (e === el && id !== exceptId) return;
    el.classList.remove('on');
    Game.setInput(K[el.dataset.bit], false);
  }

  /* Палец появился или переехал: снимаем старую кнопку, жмём новую. */
  function move(touch) {
    const el = under(touch);
    const was = held.get(touch.identifier) || null;
    if (was === el) return;
    if (el) held.set(touch.identifier, el); else held.delete(touch.identifier);
    if (was) release(was, touch.identifier);
    press(el);
  }

  function lift(touch) {
    const was = held.get(touch.identifier);
    held.delete(touch.identifier);
    release(was, touch.identifier);
  }

  function bind() {
    const opts = { passive: false };

    root.addEventListener('touchstart', (e) => {
      e.preventDefault();          // иначе двойной тап зумит, долгий — выделяет
      for (const t of e.changedTouches) move(t);
    }, opts);

    root.addEventListener('touchmove', (e) => {
      e.preventDefault();
      for (const t of e.changedTouches) move(t);
    }, opts);

    const end = (e) => {
      e.preventDefault();
      for (const t of e.changedTouches) lift(t);
    };
    root.addEventListener('touchend', end, opts);
    root.addEventListener('touchcancel', end, opts);

    /* Свернули игру, позвонили, экран погас — отпускаем всё. */
    const panic = () => {
      held.forEach(el => el.classList.remove('on'));
      held.clear();
      Game.releaseAll();
    };
    document.addEventListener('visibilitychange', () => { if (document.hidden) panic(); });
    window.addEventListener('pagehide', panic);
    window.addEventListener('blur', panic);
  }

  function init() {
    if (!isTouch) return;
    document.body.classList.add('touch');
    build();
    bind();
  }

  return { init, get isTouch() { return isTouch; } };
})();
