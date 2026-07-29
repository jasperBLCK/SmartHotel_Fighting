/* ===================================================================
   yandex.js — интеграция с Yandex Games SDK.

   Игра живёт в двух местах: на Яндекс Играх и на GitHub Pages. Поэтому
   SDK не вшит намертво: пробуем загрузить /sdk.js (на хостинге Яндекса
   он всегда есть, где угодно ещё — просто 404), и если его нет, каждый
   вызов ниже превращается в no-op. Игровой код от этого не зависит.

   Что площадка требует от игры:
     • LoadingAPI.ready()      — «игра загрузилась, можно играть».
       Зовём, когда меню отрисовано и обработчики повешены.
     • GameplayAPI.start/stop  — когда идёт собственно бой. Стартуем на
       входе в бой, стопаем на нокаут-экране победы, выходе в лобби и
       при сворачивании вкладки (возврат — снова start).
   =================================================================== */

const YG = (() => {

  let ysdk = null;
  let playing = false;   // «бой идёт» с точки зрения игры

  function loadScript() {
    return new Promise((resolve) => {
      const s = document.createElement('script');
      s.src = '/sdk.js';
      s.onload = () => resolve(true);
      s.onerror = () => resolve(false);
      document.head.appendChild(s);
    });
  }

  /* Сообщаем площадке фактическое состояние: бой идёт И вкладка видима. */
  function push() {
    const api = ysdk && ysdk.features && ysdk.features.GameplayAPI;
    if (!api) return;
    try {
      if (playing && !document.hidden) api.start();
      else api.stop();
    } catch (e) { }
  }

  async function init() {
    try {
      if (!(await loadScript()) || !window.YaGames) return;
      ysdk = await YaGames.init();
      document.addEventListener('visibilitychange', push);
      const loading = ysdk.features && ysdk.features.LoadingAPI;
      if (loading) loading.ready();
    } catch (e) {
      console.warn('[yandex] SDK не инициализировался:', e && e.message);
      ysdk = null;
    }
  }

  return {
    init,
    get active() { return !!ysdk; },
    gameplayStart() { playing = true; push(); },
    gameplayStop()  { playing = false; push(); },
  };
})();
