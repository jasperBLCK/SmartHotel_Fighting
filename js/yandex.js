/* ===================================================================
   yandex.js — интеграция с Yandex Games SDK.

   Игра живёт в двух местах: на Яндекс Играх и на GitHub Pages. Поэтому
   SDK не вшит намертво: пробуем загрузить /sdk.js (на хостинге Яндекса
   он всегда есть, где угодно ещё — просто 404), и если его нет, каждый
   вызов ниже превращается в no-op. Игровой код от этого не зависит и
   ничего про площадку не знает — он просто дёргает YG.*.

   Что площадка требует от игры:

     • LoadingAPI.ready()      — «игра загрузилась, можно играть».
       Зовём, когда меню отрисовано и обработчики повешены.
     • GameplayAPI.start/stop  — когда идёт собственно бой. Стартуем на
       входе в бой, стопаем на нокаут-экране победы, выходе в лобби и
       при сворачивании вкладки (возврат — снова start).

   Что берём у площадки для удобства игрока:

     • ник из профиля Яндекса, если человек авторизован (без запроса
       доступа — scopes:false, окно логина не всплывает);
     • serverTime() — честное время площадки. Оно тут не для красоты:
       релеи отбрасывают объявления «из прошлого», и сбитые часы делают
       игроков невидимыми друг для друга. Проверка сети показывает
       расхождение, и на Яндексе она опирается на это время.

   Реклама (правила площадки, п. 1.12) — только через SDK, сторонняя
   запрещена. Правила простые и соблюдаются здесь буквально:

     • баннер висит в меню и лобби, в бою скрыт;
     • полноэкранная — только между боями, никогда во время драки и
       никогда сразу на старте игры;
     • на время ролика глушим звук и останавливаем GameplayAPI, после —
       возвращаем. Иначе из-под рекламы доносится бой.
   =================================================================== */

const YG = (() => {

  let ysdk = null;
  let playing = false;      // «бой идёт» с точки зрения игры
  let inAd = false;         // крутится полноэкранный ролик
  let bannerOn = false;     // баннер сейчас показан
  let player = null;        // профиль игрока, если авторизован

  /* Первый бой рекламой не портим: человек только зашёл. Дальше сам
     Яндекс держит паузу в 3 минуты между роликами, но подстрахуемся
     своей — на случай коротких боёв подряд. */
  const AD_GAP = 180000;
  let lastAd = 0;
  let fights = 0;

  function loadScript() {
    return new Promise((resolve) => {
      const s = document.createElement('script');
      s.src = '/sdk.js';
      s.onload = () => resolve(true);
      s.onerror = () => resolve(false);
      document.head.appendChild(s);
    });
  }

  /* Сообщаем площадке фактическое состояние: бой идёт, вкладка видима
     и мы не под рекламой. */
  function push() {
    const api = ysdk && ysdk.features && ysdk.features.GameplayAPI;
    if (!api) return;
    try {
      if (playing && !document.hidden && !inAd) api.start();
      else api.stop();
    } catch (e) { }
  }

  /* ---------------- Реклама ---------------- */

  /* Игра говорит «баннер уместен / не уместен» когда угодно, в том числе
     до того, как поднимется SDK: меню рисуется раньше. Поэтому желание
     запоминается, а применяется, когда есть чем. */
  let wantBanner = false;

  function applyBanner() {
    if (!ysdk || !ysdk.adv || wantBanner === bannerOn) return;
    bannerOn = wantBanner;
    try {
      const p = wantBanner ? ysdk.adv.showBannerAdv() : ysdk.adv.hideBannerAdv();
      // блок РСЯ может быть не подключён — это не ошибка игры
      if (p && p.catch) p.catch(() => { bannerOn = false; });
    } catch (e) { bannerOn = false; }
  }

  function showBanner() { wantBanner = true; applyBanner(); }
  function hideBanner() { wantBanner = false; applyBanner(); }

  /* Полноэкранная реклама между боями. Возвращает промис, который
     разрешается в любом случае — вызывающий код не должен зависеть от
     того, показалась она, не показалась или площадки нет вовсе. */
  function interstitial() {
    return new Promise((resolve) => {
      if (!ysdk || !ysdk.adv) return resolve(false);
      // первый бой не прерываем и паузу между роликами соблюдаем
      if (++fights < 2 || Date.now() - lastAd < AD_GAP) return resolve(false);

      let done = false;
      const fin = (shown) => {
        if (done) return; done = true;
        inAd = false;
        push();
        try { U.sfx.resume(); } catch (e) { }
        resolve(shown);
      };

      inAd = true;
      push();
      try { U.sfx.suspend(); } catch (e) { }

      try {
        ysdk.adv.showFullscreenAdv({
          callbacks: {
            onOpen: () => { lastAd = Date.now(); },
            onClose: (wasShown) => fin(!!wasShown),
            onError: () => fin(false),
          },
        });
      } catch (e) { return fin(false); }

      // страховка: если площадка не позвала ни один колбэк — не зависаем
      setTimeout(() => fin(false), 20000);
    });
  }

  /* ---------------- Запуск ---------------- */

  async function init() {
    try {
      if (!(await loadScript()) || !window.YaGames) return;
      ysdk = await YaGames.init();
      document.addEventListener('visibilitychange', push);

      /* Ник из профиля — чтобы человеку не приходилось придумывать имя.
         scopes:false: окно авторизации не всплывает, а неавторизованный
         игрок просто вернёт пустое имя, и останется наш «Боец 42». */
      try {
        player = await ysdk.getPlayer({ scopes: false });
        const name = (player.getName() || '').trim();
        if (name) emitName(name.slice(0, 10));
      } catch (e) { }

      /* Площадка знает про устройство больше, чем медиазапрос: экранные
         кнопки нужны и там, где браузер не признаётся, что он мобильный. */
      if (isMobile()) { try { Touch.enable(); } catch (e) { } }

      const loading = ysdk.features && ysdk.features.LoadingAPI;
      if (loading) loading.ready();

      // меню отрисовалось раньше нас и уже сказало, нужен ли баннер
      applyBanner();
    } catch (e) {
      console.warn('[yandex] SDK не инициализировался:', e && e.message);
      ysdk = null;
    }
  }

  /* Ник приезжает асинхронно и, скорее всего, уже после отрисовки меню —
     поэтому не «спросить», а «подписаться». */
  let nameCb = null;
  let namePending = null;
  function emitName(name) { if (nameCb) nameCb(name); else namePending = name; }
  function onName(fn) { nameCb = fn; if (namePending) { fn(namePending); namePending = null; } }

  /* Время площадки, если оно есть: на Яндексе не зависит от часов игрока. */
  function serverTime() {
    try { return ysdk && ysdk.serverTime ? ysdk.serverTime() : null; }
    catch (e) { return null; }
  }

  function isMobile() {
    try { return !!(ysdk && ysdk.deviceInfo && ysdk.deviceInfo.isMobile()); }
    catch (e) { return false; }
  }

  return {
    init, onName, serverTime, isMobile, interstitial, showBanner, hideBanner,
    get active() { return !!ysdk; },
    gameplayStart() { playing = true; push(); },
    gameplayStop()  { playing = false; push(); },
  };
})();
