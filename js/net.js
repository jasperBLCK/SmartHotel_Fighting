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

  /* ---------------- Общий вход в комнату ---------------- */
  async function open(roomCode, asHost, onReady, onFail) {
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

    try {
      room = T.joinRoom(
        {
          appId: APP_ID,
          relayConfig: { urls: NetConfig.relays() },
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
        const m = joinFailReason();
        emit('error', m); if (onFail) onFail(m);
        destroy();
      }, HOST_WAIT);
    }
  }

  /* ---------------- Публичный вход ---------------- */
  function createRoom(onReady, onFail) {
    open(U.makeCode(5), true, onReady, onFail);
  }
  function joinRoom(roomCode, onReady, onFail) {
    const c = String(roomCode || '').trim().toUpperCase();
    if (c.length < 4) { if (onFail) onFail('Слишком короткий код'); return; }
    open(c, false, onReady, onFail);
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

  function probeRelay(url, timeout = 6000) {
    return new Promise(res => {
      const t0 = Date.now();
      let ws, done = false;
      const fin = (ok) => {
        if (done) return; done = true;
        try { ws && ws.close(); } catch (e) { }
        res({ url, ok, ms: Date.now() - t0 });
      };
      try { ws = new WebSocket(url); } catch (e) { return fin(false); }
      const timer = setTimeout(() => fin(false), timeout);
      ws.onopen = () => { clearTimeout(timer); fin(true); };
      ws.onerror = () => { clearTimeout(timer); fin(false); };
    });
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
    const urls = NetConfig.relays();
    const [relayResults, ice] = await Promise.all([
      Promise.all(urls.map(u => probeRelay(u))),
      probeIce(),
    ]);
    return {
      relays: relayResults,
      relaysOk: relayResults.filter(r => r.ok).length,
      relaysTotal: urls.length,
      ice,
      hasTurn: NetConfig.hasTurn,
    };
  }

  return {
    on, createRoom, joinRoom, toHost, sendTo, broadcast, destroy, diagnose,
    get isHost() { return isHost; },
    get myId() { return myId; },
    get code() { return code; },
    get ping() { return ping; },
    get relays() { return liveRelays(); },
    get clientIds() { return [...peers]; },
    get clientCount() { return peers.size; },
  };
})();
