/* ===================================================================
   net.js — сеть на PeerJS (WebRTC). Своего бэкенда нет.

   Топология «звезда»:
     ХОСТ  — создаёт Peer с фиксированным id вида "SHF-XXXXX",
             принимает подключения, считает физику, шлёт состояние.
     КЛИЕНТ— подключается к id хоста, шлёт только свой инпут.

   Все сообщения — обычные JS-объекты с полем t (тип).
   Ничего не сохраняется: ни на сервере, ни в localStorage.
   =================================================================== */

const Net = (() => {

  const PREFIX = 'SHF-';          // префикс peer id, чтобы код комнаты был коротким
  const PING_EVERY = 1000;        // как часто мерить задержку, мс

  let peer = null;
  let isHost = false;
  let myId = null;                // 'host' у хоста, peer id у клиента
  let code = null;                // код комнаты (заглавные буквы/цифры)
  const conns = new Map();        // (только хост) pid -> DataConnection
  let hostConn = null;            // (только клиент) соединение с хостом
  let pingTimer = null;
  let ping = 0;

  /* Подписки: Net.on('input', fn). Тип '*' — все сообщения. */
  const handlers = {};
  function on(type, fn) { (handlers[type] || (handlers[type] = [])).push(fn); }
  function emit(type, ...args) { (handlers[type] || []).forEach(f => f(...args)); }

  /*
    Конфиг PeerJS: публичный брокер + STUN и TURN.

    STUN хватает, когда хотя бы одна сторона за обычным NAT — это большинство
    домашних роутеров. Но мобильный интернет и строгие NAT так не пробиваются,
    поэтому добавлены бесплатные публичные TURN-серверы (трафик идёт через них).
    Хочешь стабильности — заведи свой TURN (coturn / metered.ca) и подставь сюда.
  */
  function peerOpts() {
    return {
      debug: 1,
      config: {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' },
          { urls: 'stun:global.stun.twilio.com:3478' },
          { urls: 'turn:openrelay.metered.ca:80',
            username: 'openrelayproject', credential: 'openrelayproject' },
          { urls: 'turn:openrelay.metered.ca:443',
            username: 'openrelayproject', credential: 'openrelayproject' },
          { urls: 'turn:openrelay.metered.ca:443?transport=tcp',
            username: 'openrelayproject', credential: 'openrelayproject' },
          { urls: 'turn:staticauth.openrelay.metered.ca:80',
            username: 'openrelayproject', credential: 'openrelayproject' },
        ],
        iceCandidatePoolSize: 4,
      },
    };
  }

  /* ---------------- ХОСТ ---------------- */

  /*
    Создать комнату. Пробуем занять id "SHF-КОД"; если занят — генерим новый код.
    onReady(code) вызывается, когда брокер подтвердил регистрацию.
  */
  function createRoom(onReady, onFail, attempt = 0) {
    destroy();
    isHost = true; myId = 'host';
    code = U.makeCode(5);

    peer = new Peer(PREFIX + code, peerOpts());

    peer.on('open', (id) => {
      emit('open', code);
      if (onReady) onReady(code);
    });

    /* Кто-то подключился к нам. */
    peer.on('connection', (conn) => {
      conn.on('open', () => {
        // больше 3 клиентов (4 игрока с хостом) не пускаем
        if (conns.size >= 3) {
          conn.send({ t: 'full' });
          setTimeout(() => conn.close(), 300);
          return;
        }
        conns.set(conn.peer, conn);
        emit('join', conn.peer);
      });
      conn.on('data', (msg) => route(conn.peer, msg));
      conn.on('close', () => {
        if (conns.delete(conn.peer)) emit('leave', conn.peer);
      });
      conn.on('error', () => {
        if (conns.delete(conn.peer)) emit('leave', conn.peer);
      });
    });

    peer.on('error', (err) => {
      // id занят — берём другой код и пробуем снова (до 5 раз)
      if (err.type === 'unavailable-id' && attempt < 5) {
        return createRoom(onReady, onFail, attempt + 1);
      }
      if (err.type === 'peer-unavailable') return; // не критично для хоста
      emit('error', humanError(err));
      if (onFail) onFail(humanError(err));
    });

    peer.on('disconnected', () => { try { peer.reconnect(); } catch (e) { } });
  }

  /* ---------------- КЛИЕНТ ---------------- */

  /* Подключиться к комнате по коду. */
  function joinRoom(roomCode, onReady, onFail) {
    destroy();
    isHost = false;
    code = String(roomCode || '').trim().toUpperCase();
    if (code.length < 4) { if (onFail) onFail('Слишком короткий код'); return; }

    peer = new Peer(null, peerOpts());

    let settled = false;
    const fail = (m) => { if (!settled) { settled = true; if (onFail) onFail(m); } };

    peer.on('open', (id) => {
      myId = id;
      // serialization по умолчанию (binarypack) — умеет резать большие сообщения
      // на чанки, это важно для фото арены (сотни килобайт).
      hostConn = peer.connect(PREFIX + code, { reliable: true });

      const timeout = setTimeout(() => fail('Комната не отвечает. Проверь код.'), 12000);

      hostConn.on('open', () => {
        clearTimeout(timeout);
        settled = true;
        startPing();
        emit('open', code);
        if (onReady) onReady(myId);
      });
      hostConn.on('data', (msg) => route('host', msg));
      hostConn.on('close', () => { stopPing(); emit('hostgone'); });
      hostConn.on('error', () => fail('Ошибка соединения с хостом'));
    });

    peer.on('error', (err) => {
      const m = humanError(err);
      if (err.type === 'peer-unavailable') return fail('Комната ' + code + ' не найдена');
      fail(m);
      emit('error', m);
    });
  }

  /* ---------------- Приём/маршрутизация ---------------- */

  function route(from, msg) {
    if (!msg || typeof msg !== 'object') return;

    // служебный пинг-понг для измерения задержки
    if (msg.t === 'png') { sendTo(from, { t: 'pog', ts: msg.ts }); return; }
    if (msg.t === 'pog') { ping = Math.max(0, Date.now() - msg.ts); return; }
    if (msg.t === 'full') { emit('error', 'Комната заполнена (уже 4 игрока)'); return; }

    emit(msg.t, from, msg);
    emit('*', from, msg);
  }

  /* ---------------- Отправка ---------------- */

  /* Клиент -> хосту. */
  function toHost(msg) {
    if (hostConn && hostConn.open) { try { hostConn.send(msg); } catch (e) { } }
  }
  /* Хост -> конкретному клиенту (или клиент -> хосту, если from='host'). */
  function sendTo(pid, msg) {
    if (pid === 'host') return toHost(msg);
    const c = conns.get(pid);
    if (c && c.open) { try { c.send(msg); } catch (e) { } }
  }
  /* Хост -> всем клиентам. exceptPid можно исключить. */
  function broadcast(msg, exceptPid) {
    conns.forEach((c, pid) => {
      if (pid === exceptPid) return;
      if (c.open) { try { c.send(msg); } catch (e) { } }
    });
  }

  /* ---------------- Пинг ---------------- */
  function startPing() {
    stopPing();
    pingTimer = setInterval(() => toHost({ t: 'png', ts: Date.now() }), PING_EVERY);
  }
  function stopPing() { if (pingTimer) clearInterval(pingTimer), pingTimer = null; }

  /* ---------------- Прочее ---------------- */

  function humanError(err) {
    const map = {
      'browser-incompatible': 'Браузер не поддерживает WebRTC',
      'network': 'Нет связи с сигнальным сервером',
      'server-error': 'Сигнальный сервер недоступен, попробуй позже',
      'socket-error': 'Обрыв связи с сервером',
      'ssl-unavailable': 'Проблема с SSL',
      'unavailable-id': 'Код комнаты занят',
      'webrtc': 'Ошибка WebRTC-соединения',
    };
    return map[err.type] || ('Ошибка сети: ' + (err.type || err.message || '?'));
  }

  /* Полностью разорвать всё и обнулить состояние. */
  function destroy() {
    stopPing();
    conns.forEach(c => { try { c.close(); } catch (e) { } });
    conns.clear();
    if (hostConn) { try { hostConn.close(); } catch (e) { } hostConn = null; }
    if (peer) { try { peer.destroy(); } catch (e) { } peer = null; }
    myId = null; code = null; ping = 0;
  }

  return {
    on, createRoom, joinRoom, toHost, sendTo, broadcast, destroy,
    get isHost() { return isHost; },
    get myId() { return myId; },
    get code() { return code; },
    get ping() { return ping; },
    get clientIds() { return Array.from(conns.keys()); },
    get clientCount() { return conns.size; },
  };
})();
