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
     Список проверен 29.07.2026: все адреса отвечали на подключение.
     Специально разношёрстный — разные страны и хостинги, часть без
     Cloudflare, который у российских провайдеров бывает медленным. */
  const RELAYS = [
    'wss://nostr.mom',
    'wss://relay.mostr.pub',
    'wss://nostr.data.haus',
    'wss://relay.primal.net',
    'wss://purplerelay.com',
    'wss://nos.lol',
    'wss://schnorr.me',
    'wss://nostr.oxtr.dev',
    'wss://nostr-pub.wellorder.net',
    'wss://relay.nostr.wirednet.jp',
    'wss://offchain.pub',
    'wss://relay.damus.io',
  ];

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

  /* Свой список релеев, если очень надо: ?relays=wss://a,wss://b */
  function relays() {
    let p;
    try { p = new URLSearchParams(location.search).get('relays'); } catch (e) { p = null; }
    if (!p) return RELAYS.slice();
    const list = p.split(',').map(s => s.trim()).filter(s => /^wss?:\/\//.test(s));
    return list.length ? list : RELAYS.slice();
  }

  function turnServers() {
    const fromUrl = turnFromUrl();
    return TURN.concat(fromUrl ? parseTurn(fromUrl) : []);
  }

  function iceServers() {
    return [{ urls: STUN }].concat(turnServers());
  }

  return {
    relays, iceServers, turnServers,
    get hasTurn() { return turnServers().length > 0; },
    setTurn(str) { store(str); },
    clearTurn() { store(''); },
  };
})();
