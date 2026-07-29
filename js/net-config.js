/* ===================================================================
   net-config.js — адреса, по которым игра ищет соперников и пробивает NAT.

   Вынесено отдельно от логики, чтобы это можно было править, ничего не
   ломая: список релеев и свой TURN меняются здесь, net.js не трогаем.

   Три вещи, которые нужны браузерам, чтобы соединиться напрямую:

     1. РЕЛЕЙ (Nostr) — «доска объявлений», через которую игроки находят
        друг друга и обмениваются техническими адресами. Данные боя через
        неё НЕ идут. Релеев много и они независимые: если часть недоступна,
        хватит одного живого.

     2. STUN — сервер, который сообщает браузеру его внешний адрес.
        Отвечает одним UDP-пакетом, трафик через него не идёт.

     3. TURN — ретранслятор на случай, когда напрямую соединиться нельзя
        (симметричный NAT, мобильный интернет с CGNAT). Весь трафик боя
        идёт через него, поэтому бесплатных публичных TURN практически не
        осталось — свой нужно указать самому, см. ниже.

   Без TURN игра работает у большинства пар игроков, но не у всех.
   =================================================================== */

const NetConfig = (() => {

  const TURN_STORE = 'shf.turn';   // сюда кладём TURN, переданный ссылкой

  /* ---------------- Nostr-релеи ----------------
     Это не «список, по которому работаем», а пул кандидатов: игра сама
     проверяет их из твоей сети и берёт те, что реально работают здесь и
     сейчас. Меняешь Wi-Fi, провайдер что-то прикрыл — подбор произойдёт
     заново, править ничего не нужно.

     Проверяется не «отвечает ли адрес», а сквозная проба: релей должен
     принять объявление и вернуть его по подписке. Разница существенная —
     relay.nostr.wirednet.jp, например, исправно пускает к себе, но режет
     события того типа, которым игра объявляет о себе.

     ВАЖНО — порядок здесь значимый, и его нельзя перемешивать «для
     красоты». Оба игрока идут по этому списку сверху вниз и берут первые
     сработавшие. Порядок одинаковый у всех, поэтому наборы получаются
     пересекающимися даже у людей из разных сетей, где доступны разные
     релеи. Перетасуй список у одного игрока — и он рискует оказаться на
     релеях, которых нет у второго, а значит, они не найдут друг друга.

     Сверху — те, что подтверждённо работают из российских сетей у двух
     разных провайдеров. Дальше — проверенные 29.07.2026. */
  const POOL = [
    'wss://nostr.data.haus',
    'wss://relay.primal.net',
    'wss://nostr.oxtr.dev',
    'wss://nostr-pub.wellorder.net',
    'wss://offchain.pub',
    'wss://nostr.bitcoiner.social',
    'wss://relay.snort.social',
    'wss://nos.lol',
    'wss://nostr.mom',
    'wss://relay.mostr.pub',
    'wss://purplerelay.com',
    'wss://schnorr.me',
    'wss://relay.damus.io',
    'wss://relay.nostr.place',
    'wss://nostr.vulpem.com',
    'wss://nostr.islandarea.net',
    'wss://bucket.coracle.social',
    'wss://communities.nos.social',
    'wss://chorus.pjv.me',
    'wss://hol.is',
    'wss://koru.bitcointxoko.org',
    'wss://nostr-01.uid.ovh',
    'wss://nostr-relay.corb.net',
    'wss://nostr.sathoarder.com',
    'wss://relay.agorist.space',
    'wss://relay.angor.io',
    'wss://relay2.angor.io',
    'wss://relay.binaryrobot.com',
    'wss://relay.libernet.app',
    'wss://relay.mostro.network',
    'wss://relay.sigit.io',
    'wss://relay02.lnfi.network',
    'wss://relay-rpi.edufeed.org',
    'wss://relay-can.zombi.cloudrodion.com',
    'wss://slick.mjex.me',
    'wss://social.amanah.eblessing.co',
    'wss://staging.yabu.me',
    'wss://yabu.me/v2',
    'wss://strfry.shock.network',
    'wss://testnet-relay.samt.st',
    'wss://top.testrelay.top',
    'wss://x.kojira.io',
    'wss://ftp.halifax.rwth-aachen.de/nostr',
  ];

  /* Сколько рабочих релеев набираем, прежде чем остановиться.

     Число выбрано не на глаз. Считали долю пар игроков, у которых не
     оказалось ни одного общего релея (30 000 пар на каждый вариант, у
     каждой стороны случайно доступна часть пула):

       доступна половина пула:   10 штук — 0.23%,  16 штук — 0.00%
       доступна четверть пула:   10 штук — 9.12%,  16 штук — 6.46%

     При 16 результат совпадает с теоретическим пределом «взять вообще
     все рабочие» (6.28%), но обходится в полтора раза меньшим числом
     соединений. Дальше увеличивать бессмысленно.

     Отдельно проверяли соблазнительный вариант «брать всё рабочее из
     первых N пула»: он экономит соединения, но проваливается втрое чаще
     (35.76% против 9.12% при доступной четверти) — у игрока с плохим
     доступом набор просто не набирается. Поэтому именно «первые
     сработавшие», без ограничения по глубине. */
  const WANT = 16;

  /* Проверяем пул порциями, а не целиком: обычно хватает первой. */
  const BATCH = 16;

  /* ---------------- STUN ----------------
     Тоже проверены 29.07.2026 живыми STUN-запросами. Первым идёт
     российский: он доступен без VPN и отвечает быстрее прочих.
     Google-адреса оставлены в конце — они популярны, но отзываются
     не из любой сети. */
  const STUN = [
    'stun:stun.sipnet.ru:3478',
    'stun:stun.cloudflare.com:3478',
    'stun:global.stun.twilio.com:3478',
    'stun:stun.miwifi.com:3478',
    'stun:stun.l.google.com:19302',
  ];

  /* ---------------- TURN ----------------
     Публичный openrelay.metered.ca, который тут стоял раньше, закрыт и
     больше не отвечает — поэтому здесь пусто.

     Чтобы игра соединяла вообще всех, нужен свой ретранслятор. Варианты:

       • бесплатный тариф metered.ca или expressturn.com — регистрация,
         дают адрес, логин и пароль;
       • свой coturn на любом VPS (лучше российском — меньше задержка
         и никаких блокировок).

     Дальше либо впиши сюда:

       { urls: 'turn:my-server.ru:3478', username: 'user', credential: 'pass' },

     либо, не трогая код, открой игру со ссылкой вида

       ?turn=turn:my-server.ru:3478|user|pass

     Такая ссылка запоминается в браузере, так что достаточно открыть её
     один раз — и можно раздать её друзьям. Сбросить: ?turn=off */
  const TURN = [
  ];

  /* ---------------- Разбор ссылки ---------------- */

  function parseTurn(str) {
    return String(str).split(';').map(part => {
      const [urls, username, credential] = part.split('|').map(s => (s || '').trim());
      if (!urls || !/^turns?:/.test(urls)) return null;
      // без логина и пароля TURN бессмыслен — почти все требуют авторизацию
      return username ? { urls, username, credential } : { urls };
    }).filter(Boolean);
  }

  function stored() {
    try { return localStorage.getItem(TURN_STORE) || ''; } catch (e) { return ''; }
  }
  function store(v) {
    try { v ? localStorage.setItem(TURN_STORE, v) : localStorage.removeItem(TURN_STORE); }
    catch (e) { }
  }

  /* TURN из ссылки: применяем и запоминаем, чтобы работало и без параметра. */
  function turnFromUrl() {
    let p;
    try { p = new URLSearchParams(location.search).get('turn'); } catch (e) { return ''; }
    if (p === null) return stored();
    if (p === 'off' || p === '0' || p === '') { store(''); return ''; }
    store(p);
    return p;
  }

  /* Свой список релеев, если очень надо: ?relays=wss://a,wss://b
     Заданный вручную список используется как есть, без подбора. */
  function relays() {
    let p;
    try { p = new URLSearchParams(location.search).get('relays'); } catch (e) { p = null; }
    if (!p) return POOL.slice();
    const list = p.split(',').map(s => s.trim()).filter(s => /^wss?:\/\//.test(s));
    return list.length ? list : POOL.slice();
  }

  function fixedRelays() {
    try { return !!new URLSearchParams(location.search).get('relays'); }
    catch (e) { return false; }
  }

  function turnServers() {
    const fromUrl = turnFromUrl();
    return TURN.concat(fromUrl ? parseTurn(fromUrl) : []);
  }

  function iceServers() {
    return [{ urls: STUN }].concat(turnServers());
  }

  return {
    relays, iceServers, turnServers, fixedRelays,
    get want() { return WANT; },
    get batch() { return BATCH; },
    get hasTurn() { return turnServers().length > 0; },
    setTurn(str) { store(str); },
    clearTurn() { store(''); },
  };
})();
