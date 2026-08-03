/* ===================================================================
   net.js — сеть на WebRTC через Trystero (стратегия Nostr).

   Почему не PeerJS: у него один публичный брокер (0.peerjs.com), и если
   провайдер его режет — игра не работает вообще. Здесь для «знакомства»
   игроков используются публичные Nostr-релеи: их десятки, подключаемся
   сразу к нескольким, достаточно чтобы работал хоть один.

   Сама библиотека лежит в js/vendor — ничего не грузится с CDN, поэтому
   на GitHub Pages всё поднимается даже при заблокированных CDN.

   Адреса релеев, STUN и TURN вынесены в net-config.js — там же написано,
   как подключить свой ретранслятор, если прямое соединение не проходит.

   Топология прежняя, «звезда»:
     ХОСТ   — создаёт комнату, считает физику, рассылает состояние.
     КЛИЕНТ — подключается по коду, шлёт хосту только свой инпут.

   Никакого бэкенда и никаких данных игроков на стороне: в localStorage
   хранится ровно одна вещь — адрес TURN, если его передали ссылкой.
   =================================================================== */

const Net = (() => {

  const APP_ID = 'smart-hotel-fighting';
  const ROOM_PREFIX = 'shf-';
  const PING_EVERY = 2000;
  const HOST_WAIT = 25000;        // сколько ждём отклика хоста при входе
  const RELAY_WAIT = 20000;       // сколько ждём подключения к релеям

  let lib = null;                 // загруженный модуль Trystero
  let room = null;
  let sendMsg = null;
  let isHost = false;
  let myId = null;
  let code = null;
  let hostId = null;              // (клиент) id хоста
  const peers = new Set();        // (хост) id подключившихся клиентов
  let pingTimer = null;
  let ping = 0;
  let hostTimer = null;
  let pendingReady = null;        // колбэк клиента, ждущий отклика хоста
  let sawPeer = false;            // соперник найден через релей (до WebRTC)

  /* Подписки: Net.on('in', fn). Тип '*' — все сообщения. */
  const handlers = {};
  function on(type, fn) { (handlers[type] || (handlers[type] = [])).push(fn); }
  function emit(type, ...args) { (handlers[type] || []).forEach(f => f(...args)); }

  /* Библиотека лежит рядом с игрой, поэтому путь считаем от страницы. */
  async function load() {
    if (lib) return lib;
    const url = new URL('js/vendor/trystero-p2p-nostr.mjs', location.href).href;
    lib = await import(url);
    return lib;
  }

  /* Сколько релеев реально подключилось (для диагностики). */
  function liveRelays() {
    try {
      const s = lib && lib.getRelaySockets ? lib.getRelaySockets() : {};
      return Object.values(s).filter(x => x && x.readyState === 1).length;
    } catch (e) { return 0; }
  }

  /* Ждём, пока поднимется хотя бы один релей. */
  function waitForRelays(timeout) {
    return new Promise((res, rej) => {
      const t0 = Date.now();
      const tick = () => {
        if (liveRelays() > 0) return res(liveRelays());
        if (Date.now() - t0 > timeout) return rej(new Error('нет связи ни с одним релеем'));
        setTimeout(tick, 250);
      };
      tick();
    });
  }

  /* Сбой на этапе знакомства. Важно различать два случая: соперника не
     видно вообще (не та комната / релеи не доходят) и соперник найден, но
     WebRTC между вами не поднялся — это уже NAT, и лечится только TURN. */
  function onJoinError(err) {
    const e = err || {};
    if (e.peerId) sawPeer = true;
    console.warn('net:', e.error || err);
    // хосту важно знать: до него достучались, но канал не поднялся
    if (isHost && e.peerId) emit('icefail', e.peerId);
  }

  /* Понятное объяснение, почему клиент не достучался до хоста. */
  function joinFailReason() {
    if (!sawPeer) {
      return 'Комната ' + code + ' не найдена. Проверь код и что хост в игре.';
    }
    return 'Хост найден, но прямое соединение не установилось — так бывает на ' +
      'мобильном интернете и строгом NAT.' +
      (NetConfig.hasTurn ? ' Ретранслятор тоже не помог — попробуй другую сеть.'
                         : ' Нужен свой TURN-сервер, см. js/net-config.js.');
  }

  /* ---------------- Подбор релеев ----------------
     Фиксированный список рано или поздно протухает: у одного провайдера
     режут одно, у другого другое, человек переезжает на другой Wi-Fi — и
     игра «внезапно» перестаёт находить комнаты. Поэтому список не задан,
     а подбирается: пробуем кандидатов из пула и берём те, что работают
     из этой сети прямо сейчас.

     Ключевая деталь — идём по пулу строго сверху вниз и берём первые
     сработавшие. Порядок пула одинаков у всех, поэтому у двух игроков из
     разных сетей наборы получаются пересекающимися: каждый берёт начало
     одного и того же списка, просто пропуская недоступное ему. Если бы
     каждый выбирал «самые быстрые для себя», наборы могли бы не пересечься
     вовсе — и игроки не увидели бы друг друга при полностью рабочей сети. */

  const RELAY_TTL = 10 * 60 * 1000;   // как долго верим прошлому подбору
  let relayPick = null;               // { at, urls }
  let picking = null;                 // идущий подбор, чтобы не запускать дважды

  function forgetRelays() { relayPick = null; }

  async function pickRelays() {
    if (NetConfig.fixedRelays()) return NetConfig.relays();
    if (relayPick && Date.now() - relayPick.at < RELAY_TTL) return relayPick.urls;
    if (picking) return picking;

    picking = (async () => {
      const pool = NetConfig.relays();
      const want = NetConfig.want, batch = NetConfig.batch;
      const good = [];
      for (let i = 0; i < pool.length && good.length < want; i += batch) {
        emit('status', 'Подбираем связь… ' + good.length + ' из ' + want);
        const res = await Promise.all(pool.slice(i, i + batch).map(u => probeRelay(u, 6000)));
        // порядок ответов совпадает с порядком пула — он и задаёт приоритет
        res.forEach(r => { if (r.state === 'ok' && good.length < want) good.push(r.url); });
      }
      // не нашли ни одного — не сдаёмся молча, пробуем начало пула вслепую
      const urls = good.length ? good : pool.slice(0, want);
      relayPick = { at: Date.now(), urls };
      picking = null;
      return urls;
    })();

    return picking;
  }

  /* Сеть сменилась — прошлый подбор больше ничего не значит. */
  if (typeof addEventListener === 'function') {
    addEventListener('online', forgetRelays);
    try { navigator.connection.addEventListener('change', forgetRelays); } catch (e) { }
  }

  /* ---------------- Общий вход в комнату ---------------- */
  async function open(roomCode, asHost, onReady, onFail, waitMs) {
    destroy();
    isHost = asHost;
    code = roomCode;
    pendingReady = asHost ? null : onReady;

    let T;
    try {
      T = await load();
    } catch (e) {
      const m = 'Не удалось загрузить сетевой модуль';
      emit('error', m); if (onFail) onFail(m);
      return;
    }

    myId = T.selfId;

    let urls;
    try {
      urls = await pickRelays();
    } catch (e) {
      urls = NetConfig.relays().slice(0, NetConfig.want);
    }

    try {
      room = T.joinRoom(
        {
          appId: APP_ID,
          relayConfig: { urls: urls },
          rtcConfig: { iceServers: NetConfig.iceServers() },
        },
        ROOM_PREFIX + roomCode,
        { onJoinError: onJoinError }
      );
    } catch (e) {
      const m = 'Не удалось создать комнату: ' + (e.message || e);
      emit('error', m); if (onFail) onFail(m);
      return;
    }

    const act = room.makeAction('m');
    sendMsg = (msg, target) => act.send(msg, target ? { target } : undefined);
    act.onMessage = (data, meta) => route(meta && meta.peerId, data);

    /* --- кто-то появился в комнате --- */
    room.onPeerJoin = (pid) => {
      if (!isHost) return;   // клиент ждёт 'iam', другие клиенты ему не интересны
      if (peers.size >= 3) { // 4 игрока вместе с хостом
        sendMsg({ t: 'full' }, pid);
        return;
      }
      peers.add(pid);
      // представляемся хостом, чтобы клиент понял, к кому обращаться
      sendMsg({ t: 'iam', host: 1 }, pid);
      emit('join', pid);
    };

    room.onPeerLeave = (pid) => {
      if (isHost) {
        if (peers.delete(pid)) emit('leave', pid);
      } else if (pid === hostId) {
        stopPing();
        emit('hostgone');
      }
    };

    /* --- ждём релеи --- */
    try {
      await waitForRelays(RELAY_WAIT);
    } catch (e) {
      forgetRelays();   // подобранное больше не работает — в следующий раз заново
      const m = 'Не удалось подключиться ни к одному релею. Проверь интернет ' +
                'и нажми «ПРОВЕРИТЬ СЕТЬ» — станет видно, что именно не проходит.';
      emit('error', m); if (onFail) onFail(m);
      return;
    }

    if (isHost) {
      emit('open', code);
      if (onReady) onReady(code);
    } else {
      // клиент ждёт, пока хост его заметит и представится
      hostTimer = setTimeout(() => {
        if (hostId) return;
        // хоста не видно — возможно, мы разошлись по релеям; пересоберём набор
        if (!sawPeer) forgetRelays();
        const m = joinFailReason();
        emit('error', m); if (onFail) onFail(m);
        destroy();
      }, waitMs || HOST_WAIT);
    }
  }

  /* ---------------- Публичный вход ---------------- */
  function createRoom(onReady, onFail) {
    open(U.makeCode(5), true, onReady, onFail);
  }
  /* waitMs — сколько ждать отклика хоста. По умолчанию щедрые 25 секунд:
     человек ввёл код руками, и лучше подождать, чем зря обломать. При
     автоподборе (быстрый бой) время урезают: там комнат несколько, и
     проще перейти к следующей, чем стоять у закрытой двери. */
  function joinRoom(roomCode, onReady, onFail, waitMs) {
    const c = String(roomCode || '').trim().toUpperCase();
    if (c.length < 4) { if (onFail) onFail('Слишком короткий код'); return; }
    open(c, false, onReady, onFail, waitMs);
  }

  /* ---------------- Приём ---------------- */
  function route(from, msg) {
    if (!msg || typeof msg !== 'object') return;

    // хост представился — с этого момента клиент знает, куда слать инпут
    if (msg.t === 'iam') {
      if (isHost) return;
      hostId = from;
      if (hostTimer) { clearTimeout(hostTimer); hostTimer = null; }
      startPing();
      emit('open', code);
      if (pendingReady) { pendingReady(myId); pendingReady = null; }
      return;
    }
    if (msg.t === 'full') { emit('error', 'Комната заполнена (уже 4 игрока)'); return; }

    emit(msg.t, from, msg);
    emit('*', from, msg);
  }

  /* ---------------- Отправка ---------------- */
  function toHost(msg) {
    if (sendMsg && hostId) { try { sendMsg(msg, hostId); } catch (e) { } }
  }
  function sendTo(pid, msg) {
    if (pid === 'host') return toHost(msg);
    if (sendMsg && pid) { try { sendMsg(msg, pid); } catch (e) { } }
  }
  function broadcast(msg, exceptPid) {
    if (!sendMsg) return;
    const targets = [...peers].filter(p => p !== exceptPid);
    if (!targets.length) return;
    try { sendMsg(msg, targets); } catch (e) { }
  }

  /* ---------------- Пинг (Trystero умеет сам) ---------------- */
  function startPing() {
    stopPing();
    pingTimer = setInterval(async () => {
      if (!room || !hostId) return;
      try { ping = Math.round(await room.ping(hostId)); } catch (e) { }
    }, PING_EVERY);
  }
  function stopPing() { if (pingTimer) { clearInterval(pingTimer); pingTimer = null; } }

  /* ---------------- Завершение ---------------- */
  function destroy() {
    stopPing();
    if (hostTimer) { clearTimeout(hostTimer); hostTimer = null; }
    pendingReady = null;
    if (room) { try { room.leave(); } catch (e) { } room = null; }
    sendMsg = null;
    peers.clear();
    hostId = null; code = null; ping = 0;
    sawPeer = false;
  }

  /* ---------------- Диагностика ----------------
     Отвечает на вопрос «почему не соединяется»: отдельно проверяем
     доступность релеев и отдельно — проходят ли STUN/TURN. Ничего не
     ломает и не мешает игре: используются свои временные соединения. */

  /* Проверка релея «по-настоящему»: мало открыть сокет — релей должен
     принять наше объявление и вернуть его нам же по подписке. Ровно так
     игроки и находят друг друга. Релей, который пускает к себе, но не
     передаёт события (требует авторизацию, режет лимитами), для игры
     бесполезен — и снаружи выглядит как рабочий. */
  async function probeRelay(url, timeout = 9000) {
    let T;
    try { T = await load(); } catch (e) { return { url, state: 'nolib' }; }

    const topic = 'shf-probe-' + Math.random().toString(36).slice(2, 10);
    const subId = 'probe' + Math.random().toString(36).slice(2, 10);
    const req = T.subscribe(subId, topic);
    const event = await T.createEvent(topic, 'probe');

    return new Promise(res => {
      const t0 = Date.now();
      let ws, done = false;
      const fin = (state, note) => {
        if (done) return; done = true;
        clearTimeout(timer);
        try { ws && ws.close(); } catch (e) { }
        res({ url, state, note, ms: Date.now() - t0 });
      };
      /* Не всякий релей возвращает событие тому же соединению, откуда оно
         пришло. Поэтому подтверждение приёма («OK ... true») тоже считаем
         за успех — просто помечаем, что эхо не проверено. */
      let accepted = false;
      const timer = setTimeout(() => {
        if (accepted) return fin('ok', 'принято, эхо не проверено');
        fin(ws && ws.readyState === 1 ? 'silent' : 'offline');
      }, timeout);

      try { ws = new WebSocket(url); } catch (e) { return fin('offline'); }

      ws.onerror = () => fin('offline');
      ws.onclose = () => fin(accepted ? 'ok' : 'offline', accepted ? 'принято, эхо не проверено' : '');
      ws.onopen = () => { ws.send(req); ws.send(event); };
      ws.onmessage = (m) => {
        let f;
        try { f = JSON.parse(m.data); } catch (e) { return; }
        // наше же объявление вернулось по подписке — релей точно пригоден
        if (f[0] === 'EVENT' && f[1] === subId) return fin('ok');
        if (f[0] === 'OK' && f[2] === true) { accepted = true; return; }
        // релей отказался принимать объявление и сказал почему
        if (f[0] === 'OK' && f[2] === false) return fin('refused', f[3]);
        if (f[0] === 'CLOSED') return fin('refused', f[2]);
        if (f[0] === 'NOTICE') return fin('refused', f[1]);
      };
    });
  }

  /* Часы. Релеи отбрасывают объявления «из прошлого» относительно подписки,
     поэтому разъехавшиеся часы на одном из компьютеров делают игроков
     невидимыми друг для друга — а выглядит это как «комната не найдена».
     Точное время берём из заголовка ответа сервера, откуда открыта игра. */
  async function clockSkew() {
    /* На Яндексе время площадки уже под рукой и не зависит ни от прокси,
       ни от кэша — берём его. Заголовок ответа остаётся запасным путём
       для GitHub Pages и всего остального. */
    try {
      const t = YG.serverTime();
      if (t) return Math.round((t - Date.now()) / 1000);
    } catch (e) { }
    try {
      const t0 = Date.now();
      const r = await fetch(location.href, { method: 'HEAD', cache: 'no-store' });
      const d = r.headers.get('date');
      if (!d) return null;
      const rtt = Date.now() - t0;
      return Math.round((Date.parse(d) + rtt / 2 - Date.now()) / 1000);
    } catch (e) { return null; }
  }

  /* Собираем ICE-кандидатов: srflx значит «STUN работает и внешний адрес
     известен», relay — «TURN работает». Только host — почти наверняка
     соединимся лишь внутри одной локальной сети. */
  function probeIce(timeout = 8000) {
    return new Promise(res => {
      let pc, done = false;
      const types = new Set();
      const fin = () => {
        if (done) return; done = true;
        try { pc && pc.close(); } catch (e) { }
        res({ host: types.has('host'), srflx: types.has('srflx'), relay: types.has('relay') });
      };
      try {
        pc = new RTCPeerConnection({ iceServers: NetConfig.iceServers() });
      } catch (e) { return fin(); }
      const timer = setTimeout(fin, timeout);
      pc.onicecandidate = (ev) => {
        if (!ev.candidate) { clearTimeout(timer); return fin(); }
        const t = (ev.candidate.candidate.match(/ typ (\w+)/) || [])[1];
        if (t) types.add(t);
      };
      try {
        pc.createDataChannel('probe');
        pc.createOffer().then(o => pc.setLocalDescription(o)).catch(() => { clearTimeout(timer); fin(); });
      } catch (e) { clearTimeout(timer); fin(); }
    });
  }

  async function diagnose() {
    /* Пул большой, и печатать его целиком незачем: игра берёт первые
       сработавшие сверху списка, поэтому проверяем ровно ту же голову
       пула, что и подбор. Заодно список остаётся обозримым, чтобы его
       можно было сверить с другим компьютером. */
    const urls = NetConfig.relays().slice(0, NetConfig.batch);
    const [relays, ice, skew] = await Promise.all([
      Promise.all(urls.map(u => probeRelay(u))),
      probeIce(),
      clockSkew(),
    ]);
    return {
      relays,
      relaysOk: relays.filter(r => r.state === 'ok').length,
      relaysTotal: urls.length,
      relaysWant: NetConfig.want,
      relaysPool: NetConfig.relays().length,
      ice,
      skew,                       // сек; + значит часы отстают, − спешат
      hasTurn: NetConfig.hasTurn,
      selfId: myId || (lib && lib.selfId) || null,
    };
  }

  /* Подбор занимает несколько секунд, поэтому запускаем его заранее, пока
     игрок читает меню и вводит имя — к моменту «СОЗДАТЬ ЛОББИ» он готов. */
  function warmup() { pickRelays().catch(() => { }); }

  /* Наружу для lobbies.js: каталог открытых комнат живёт на тех же
     релеях и тем же модулем подписывается на топик. Отдельный подбор
     ему заводить нельзя — иначе объявления улетят на одни релеи, а
     слушать их будут на других. */
  async function relayUrls() {
    try { return await pickRelays(); }
    catch (e) { return NetConfig.relays().slice(0, NetConfig.want); }
  }

  return {
    on, createRoom, joinRoom, toHost, sendTo, broadcast, destroy, diagnose,
    warmup, forgetRelays, relayUrls,
    lib: load,
    get isHost() { return isHost; },
    get myId() { return myId; },
    get code() { return code; },
    get ping() { return ping; },
    get relays() { return liveRelays(); },
    get clientIds() { return [...peers]; },
    get clientCount() { return peers.size; },
  };
})();
