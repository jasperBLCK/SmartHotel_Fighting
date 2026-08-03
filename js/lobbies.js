/* ===================================================================
   lobbies.js — открытые комнаты: как незнакомцы находят друг друга.

   Зачем это вообще. Вход по коду хорош ровно в одном случае: игроки уже
   знакомы и могут передать друг другу пять символов. На Яндекс Играх это
   не работает — там человек открывает игру один, и передать код ему
   некому. Мультиплеер без списка комнат на такой площадке мёртв.

   Поэтому хост, если он не против, объявляет свою комнату публично, а
   остальные видят её списком и подсаживаются в один клик.

   Как устроено. Своего сервера у игры нет и не появляется: объявления
   идут по тем же Nostr-релеям, через которые игроки и так знакомятся.
   Это обычные ephemeral-события (kind 20000–29999): релеи их не хранят
   и никуда не записывают — просто раздают тем, кто слушает прямо
   сейчас. Отсюда два следствия, на которых держится вся логика ниже:

     • хост должен объявляться повторно, раз в несколько секунд —
       иначе его никто не увидит;
     • слушать нужно несколько секунд, чтобы застать всех, кто есть.

   Комнату видно ровно пока хост в лобби и в ней есть место. Начался
   бой, комната заполнилась, хост вышел — объявления прекращаются, и
   запись протухает у всех за 25 секунд сама.

   В объявлении только то, без чего не подсесть: код комнаты, ник хоста
   и сколько игроков внутри. Ни фото, ни адресов, ни чего-либо ещё.
   =================================================================== */

const Lobbies = (() => {

  const TOPIC = 'shf-open-v1';   // «доска» с открытыми комнатами
  const ANNOUNCE_EVERY = 4000;   // как часто хост напоминает о себе
  const FRESH = 25000;           // сколько верим объявлению без обновления
  const RELAYS = 8;              // на скольких релеях объявляемся и слушаем
  const RETRY = 4000;            // пауза перед переподключением сокета

  /* Сколько слушать в «быстром бою». Первую комнату обычно видно почти
     сразу, но давать ответ по первой попавшейся нельзя: за пару секунд
     подтянутся другие, и среди них будет та, где уже кто-то ждёт. */
  const FIND_MIN = 1800;
  const FIND_MAX = 6000;

  /* ---------------- Сокеты ----------------
     Один общий пул на объявление и на просмотр: и то, и другое — это
     «быть подключённым к релеям и слушать топик». Считаем пользователей,
     последний уходящий гасит свет. */

  let sockets = [];       // { url, ws, timer }
  let users = 0;          // сколько подсистем сейчас держат пул
  let subId = null;       // идентификатор нашей подписки на релее
  let reqFrame = null;    // готовая строка REQ, шлём её при каждом open
  let T = null;           // модуль Trystero (createEvent/subscribe)

  const listeners = new Set();   // кому отдавать пришедшие объявления

  async function lib() {
    if (T) return T;
    T = await Net.lib();
    return T;
  }

  /* Объявление и просмотр включаются независимо и часто одновременно, а
     поднять пул нужно ровно один раз: подбор релеев идёт секунды, и без
     общего «уже поднимаем» получилось бы два набора сокетов. */
  let starting = null;

  async function up() {
    users++;
    if (sockets.length) return;
    if (starting) { try { await starting; } catch (e) { } return; }

    starting = (async () => {
      const L = await lib();
      const urls = (await Net.relayUrls()).slice(0, RELAYS);
      // пока подбирались релеи, все могли разойтись — тогда и не начинаем
      if (users === 0 || sockets.length) return;
      subId = 'lob' + Math.random().toString(36).slice(2, 10);
      reqFrame = L.subscribe(subId, TOPIC);
      sockets = urls.map(open);
    })();

    try { await starting; } catch (e) { } finally { starting = null; }
  }

  function open(url) {
    const s = { url, ws: null, timer: null, dead: false };
    const connect = () => {
      if (s.dead) return;
      let ws;
      /* Заблокированный CSP адрес бросает прямо здесь — на Яндексе так
         ведёт себя любой хост, не вписанный в настройках игры. Это не
         повод падать: остальные релеи работают. */
      try { ws = new WebSocket(url); } catch (e) { s.dead = true; return; }
      s.ws = ws;
      ws.onopen = () => { try { ws.send(reqFrame); } catch (e) { } };
      ws.onmessage = (m) => {
        let f;
        try { f = JSON.parse(m.data); } catch (e) { return; }
        if (f[0] !== 'EVENT' || f[1] !== subId) return;
        const ev = f[2];
        if (!ev || typeof ev.content !== 'string') return;
        let body;
        try { body = JSON.parse(ev.content); } catch (e) { return; }
        listeners.forEach(fn => { try { fn(body); } catch (e) { } });
      };
      ws.onclose = () => {
        s.ws = null;
        if (s.dead) return;
        s.timer = setTimeout(connect, RETRY);   // релей отвалился — вернёмся
      };
      ws.onerror = () => { try { ws.close(); } catch (e) { } };
    };
    connect();
    return s;
  }

  function down() {
    users = Math.max(0, users - 1);
    if (users > 0) return;
    sockets.forEach(s => {
      s.dead = true;
      if (s.timer) clearTimeout(s.timer);
      try { s.ws && s.ws.close(); } catch (e) { }
    });
    sockets = [];
    subId = null;
    reqFrame = null;
  }

  function blast(frame) {
    sockets.forEach(s => {
      try { if (s.ws && s.ws.readyState === 1) s.ws.send(frame); } catch (e) { }
    });
  }

  /* ---------------- Объявление комнаты (хост) ---------------- */

  let ann = null;         // { info, timer, held }

  /* info: { code, name, n, max }. Зовётся и при старте, и при каждом
     изменении лобби — свежие данные уедут со следующим тиком. */
  async function announce(info) {
    const first = !ann;
    if (first) ann = { info: null, timer: null, held: false };
    ann.info = info;
    if (!first) return;

    /* held — «объявление держит сокеты». Пока поднимается пул, хост может
       успеть закрыть комнату; тогда снимать держание должен тот, кто его
       и поставил, иначе лишний down() погасит сокеты у просмотра. */
    const mine = ann;
    await up();
    if (ann !== mine) { down(); return; }
    mine.held = true;

    const tick = async () => {
      if (!ann) return;
      const i = ann.info;
      try {
        const L = await lib();
        blast(await L.createEvent(TOPIC, JSON.stringify({
          v: 1, c: i.code, h: i.name, n: i.n, m: i.max, t: Date.now(),
        })));
      } catch (e) { }
      if (ann) ann.timer = setTimeout(tick, ANNOUNCE_EVERY);
    };
    tick();
  }

  function unannounce() {
    if (!ann) return;
    const a = ann;
    ann = null;
    if (a.timer) clearTimeout(a.timer);
    if (a.held) down();   // если пул ещё поднимается — down() сделает announce
  }

  const announcing = () => !!ann;

  /* ---------------- Просмотр списка ---------------- */

  /* Слушаем топик и копим комнаты. onUpdate зовётся при каждом изменении
     списка — так строка «ищем…» превращается в список на глазах. */
  async function browse(onUpdate) {
    const rooms = new Map();
    let stopped = false;

    const push = (body) => {
      if (!body || body.v !== 1 || !body.c) return;
      // свою же комнату показывать незачем — мы в ней и сидим
      if (ann && ann.info && ann.info.code === body.c) return;
      const prev = rooms.get(body.c);
      const row = {
        code: String(body.c).toUpperCase().slice(0, 6),
        name: String(body.h || 'Игрок').slice(0, 12),
        n: Math.max(1, Math.min(4, body.n | 0 || 1)),
        max: Math.max(2, Math.min(4, body.m | 0 || 4)),
        at: Date.now(),
        first: prev ? prev.first : Date.now(),
      };
      rooms.set(row.code, row);
      if (!stopped) onUpdate(snapshot());
    };

    const snapshot = () => {
      const now = Date.now();
      const live = [...rooms.values()].filter(r => now - r.at < FRESH && r.n < r.max);
      /* Сначала те, где уже кто-то ждёт: подсесть к живому человеку
         лучше, чем создать вторую пустую комнату рядом. Дальше — кто
         дольше ждёт, чтобы люди не копились в вечном ожидании. */
      live.sort((a, b) => (b.n - a.n) || (a.first - b.first));
      return live;
    };

    listeners.add(push);
    await up();

    // подчистка протухших: список сам худеет, если хост ушёл молча
    const sweep = setInterval(() => { if (!stopped) onUpdate(snapshot()); }, 3000);

    return () => {
      if (stopped) return;
      stopped = true;
      clearInterval(sweep);
      listeners.delete(push);
      down();
    };
  }

  /* Разовый поиск для «быстрого боя»: слушаем FIND_MIN..FIND_MAX и
     отдаём то, что набралось. Ждём дольше минимума только пока пусто. */
  function find() {
    return new Promise(async (res) => {
      let best = [];
      const stop = await browse(list => { best = list; });
      const t0 = Date.now();
      const check = () => {
        const waited = Date.now() - t0;
        if (waited >= FIND_MAX || (waited >= FIND_MIN && best.length)) {
          stop();
          return res(best);
        }
        setTimeout(check, 250);
      };
      check();
    });
  }

  return { announce, unannounce, announcing, browse, find };
})();
