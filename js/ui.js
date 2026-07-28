/* ===================================================================
   ui.js — экраны, лобби, склейка сети и игры.

   Сообщения протокола:
     клиент -> хост : {t:'hi', n:ник, a:аватар}   — профиль игрока
                      {t:'in', k:маска}           — инпут
     хост -> клиентам: {t:'lb', p:[...], kl}      — состояние лобби
                      {t:'go', p:[...], a:фон, kl}— старт боя
                      {t:'st', ...}               — снапшот боя
                      {t:'over', o:{...}}         — конец боя
                      {t:'lobby'}                 — вернуться в лобби
   =================================================================== */

const UI = (() => {
  const { $ } = U;

  const MAX_PLAYERS = 4;

  let isHost = false;
  let me = { name: '', avatar: null };     // мой профиль (аватар — dataURL)
  let players = [];                        // [{pid, name, avatar}] — порядок = слоты
  let arenaData = null;                    // фото арены (только у хоста)
  let killLimit = 10;
  let hudSig = '';                         // подпись табло, чтобы не дёргать DOM зря

  /* =================================================================
     ЭКРАНЫ
     ================================================================= */
  function showScreen(name) {
    ['menu', 'lobby', 'game'].forEach(s =>
      $('#screen-' + s).classList.toggle('active', s === name));
    // в лобби заранее подтягиваем детектор лиц, чтобы первая загрузка фото не ждала
    if (name === 'lobby') Face.warmup();
    if (name !== 'game') { $('#win-overlay').classList.remove('on'); $('#death-overlay').classList.remove('on'); }
  }

  /* =================================================================
     СТАРТ
     ================================================================= */
  function init() {
    Game.init();
    bindMenu();
    bindLobby();
    bindNet();

    // разблокировка звука по первому клику/нажатию (политика браузеров)
    const unlock = () => { U.sfx.unlock(); window.removeEventListener('pointerdown', unlock); window.removeEventListener('keydown', unlock); };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);

    // имя по умолчанию
    me.name = 'Боец ' + U.randInt(10, 99);
    $('#input-name').value = me.name;
    drawAvatarPreview(null);
  }

  /* =================================================================
     ГЛАВНОЕ МЕНЮ
     ================================================================= */
  function bindMenu() {
    const status = (msg, err) => {
      const el = $('#menu-status');
      el.textContent = msg;
      el.classList.toggle('err', !!err);
    };

    $('#btn-create').addEventListener('click', () => {
      U.sfx.ui();
      $('#btn-create').disabled = true;
      status('Создаём комнату…');
      Net.createRoom(
        (code) => {
          isHost = true;
          players = [{ pid: 'host', name: me.name, avatar: me.avatar }];
          $('#btn-create').disabled = false;
          $('#room-code').textContent = code;
          $('#host-panel').style.display = 'flex';
          $('#client-wait').style.display = 'none';
          showScreen('lobby');
          renderPlayers();
          status('');
        },
        (err) => { $('#btn-create').disabled = false; status(err, true); }
      );
    });

    const doJoin = () => {
      const code = $('#input-code').value.trim().toUpperCase();
      if (code.length < 4) return status('Введи код комнаты', true);
      U.sfx.ui();
      $('#btn-join').disabled = true;
      status('Подключаемся к ' + code + '…');
      Net.joinRoom(code,
        () => {
          isHost = false;
          $('#btn-join').disabled = false;
          $('#room-code').textContent = code;
          $('#host-panel').style.display = 'none';
          $('#client-wait').style.display = 'block';
          showScreen('lobby');
          sendProfile();
          status('');
        },
        (err) => { $('#btn-join').disabled = false; status(err, true); }
      );
    };

    $('#btn-join').addEventListener('click', doJoin);
    $('#input-code').addEventListener('keydown', e => { if (e.key === 'Enter') doJoin(); });
    $('#input-code').addEventListener('input', e => {
      e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    });
  }

  /* =================================================================
     ЛОББИ
     ================================================================= */
  function bindLobby() {
    /* --- ник --- */
    let nameTimer = null;
    $('#input-name').addEventListener('input', (e) => {
      me.name = e.target.value.trim().slice(0, 10) || 'Игрок';
      clearTimeout(nameTimer);
      nameTimer = setTimeout(profileChanged, 350);   // не спамим сеть на каждую букву
    });

    /* --- фото лица --- */
    const avaInput = $('#avatar-input');
    $('#avatar-drop').addEventListener('click', () => avaInput.click());
    avaInput.addEventListener('change', e => e.target.files[0] && loadFace(e.target.files[0]));
    U.dropZone($('#avatar-drop'), loadFace);

    /* --- фото арены (хост) --- */
    const arInput = $('#arena-input');
    $('#arena-drop').addEventListener('click', () => arInput.click());
    arInput.addEventListener('change', e => e.target.files[0] && loadArena(e.target.files[0]));
    U.dropZone($('#arena-drop'), loadArena);

    /* --- лимит киллов --- */
    $('#seg-kills').addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      U.sfx.ui();
      [...$('#seg-kills').children].forEach(x => x.classList.toggle('on', x === b));
      killLimit = parseInt(b.dataset.v, 10);
      if (isHost) broadcastLobby();
    });

    /* --- копирование кода --- */
    $('#btn-copy').addEventListener('click', async () => {
      const code = $('#room-code').textContent;
      try {
        await navigator.clipboard.writeText(code);
        U.toast('Код ' + code + ' скопирован');
      } catch (e) { U.toast('Код комнаты: ' + code); }
      U.sfx.ui();
    });

    /* --- старт боя --- */
    $('#btn-start').addEventListener('click', () => {
      if (!isHost || players.length < 2) return;
      U.sfx.ui();
      Net.broadcast({ t: 'go', p: players, a: arenaData, kl: killLimit });
      Game.start({ isHost: true, myPid: 'host', players, arena: arenaData, killLimit });
    });

    /* --- выход --- */
    $('#btn-leave').addEventListener('click', leave);

    /* --- кнопка на экране победы --- */
    $('#btn-again').addEventListener('click', () => {
      U.sfx.ui();
      if (isHost) {
        Net.broadcast({ t: 'lobby' });
        backToLobby();
      }
    });
  }

  /*
    Загрузка фото лица: ищем лицо и вырезаем голову (js/face.js).
    Если детектор не сработал — честно говорим об этом и берём центр кадра.
  */
  async function loadFace(file) {
    const st = $('#face-status');
    const setStatus = (txt, cls) => { st.textContent = txt; st.className = 'face-status ' + (cls || ''); };

    setStatus('Ищем лицо на фото…', 'busy');
    try {
      const res = await Face.cropHead(file);
      me.avatar = res.dataURL;
      drawAvatarPreview(me.avatar);
      $('#avatar-drop').classList.add('has-photo');
      profileChanged();
      U.sfx.join();

      if (res.detected) setStatus('Лицо найдено — голова вырезана автоматически.', 'ok');
      else setStatus('Лицо не распозналось — обрезали по центру. Попробуй фото, где лицо крупнее и анфас.', 'warn');
    } catch (e) {
      setStatus('Не удалось прочитать картинку.', 'warn');
      U.toast('Не удалось прочитать картинку');
    }
  }

  /* Загрузка фона арены: 1280x720, отправляется клиентам в момент старта. */
  async function loadArena(file) {
    try {
      arenaData = await U.fileToDataURL(file, 1280, 720, .72, 'cover');
      const cv = $('#arena-preview'), c = cv.getContext('2d');
      const img = await U.loadImage(arenaData);
      c.drawImage(img, 0, 0, cv.width, cv.height);
      $('#arena-drop').classList.add('has-photo');
      U.toast('Арена загружена');
      U.sfx.ui();
    } catch (e) { U.toast('Не удалось прочитать картинку'); }
  }

  async function drawAvatarPreview(data) {
    const cv = $('#avatar-preview'), c = cv.getContext('2d');
    const src = data || U.defaultAvatar(U.COLORS[0]);
    try {
      const img = await U.loadImage(src);
      c.clearRect(0, 0, cv.width, cv.height);
      c.drawImage(img, 0, 0, cv.width, cv.height);
    } catch (e) { }
  }

  /* Профиль изменился — рассылаем. */
  function profileChanged() {
    if (isHost) {
      const meRow = players.find(p => p.pid === 'host');
      if (meRow) { meRow.name = me.name; meRow.avatar = me.avatar; }
      broadcastLobby();
      renderPlayers();
    } else {
      sendProfile();
    }
  }
  function sendProfile() {
    Net.toHost({ t: 'hi', n: me.name, a: me.avatar });
  }

  function broadcastLobby() {
    Net.broadcast({ t: 'lb', p: players, kl: killLimit });
    renderPlayers();
  }

  /* --- отрисовка карточек игроков --- */
  function renderPlayers() {
    const strip = $('#players-strip');
    strip.innerHTML = '';
    for (let i = 0; i < MAX_PLAYERS; i++) {
      const p = players[i];
      const el = document.createElement('div');
      const color = U.COLORS[i];
      el.style.setProperty('--slot-color', color);
      if (!p) {
        el.className = 'pslot empty';
        el.innerHTML = `<div class="pwait">СЛОТ ${i + 1}</div><div class="pwait" style="opacity:.6">свободен</div>`;
      } else {
        const isMe = (p.pid === 'host' && isHost) || (p.pid === Net.myId);
        el.className = 'pslot filled';
        el.innerHTML = `
          <img class="pav" src="${p.avatar || U.defaultAvatar(color)}" alt="">
          <div class="pname">${escapeHtml(p.name)}</div>
          <div class="ptag">${p.pid === 'host' ? 'ХОСТ' : 'ИГРОК'}${isMe ? ' · ТЫ' : ''}</div>`;
      }
      strip.appendChild(el);
    }

    const n = players.length;
    $('#lobby-sub').textContent = n < 2
      ? 'нужен ещё минимум один игрок…'
      : `в комнате ${n} из ${MAX_PLAYERS}`;

    if (isHost) {
      $('#btn-start').disabled = n < 2;
      $('#host-note').textContent = n < 2
        ? 'Нужно минимум 2 игрока.'
        : `Готово: ${n} бойца(ов). Можно начинать!`;
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, m =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  }

  /* =================================================================
     СЕТЕВЫЕ ОБРАБОТЧИКИ
     ================================================================= */
  function bindNet() {

    /* --- ХОСТ: пришёл профиль клиента --- */
    Net.on('hi', (from, msg) => {
      if (!isHost) return;
      const row = players.find(p => p.pid === from);
      if (row) { row.name = msg.n || row.name; row.avatar = msg.a || row.avatar; }
      else {
        if (players.length >= MAX_PLAYERS) return;
        players.push({ pid: from, name: msg.n || 'Игрок', avatar: msg.a || null });
        U.toast((msg.n || 'Игрок') + ' подключился');
        U.sfx.join();
      }
      broadcastLobby();
    });

    /* --- ХОСТ: инпут клиента --- */
    Net.on('in', (from, msg) => Game.onHostInput(from, msg));

    /* --- ХОСТ: клиент отвалился --- */
    Net.on('leave', (pid) => {
      if (!isHost) return;
      const row = players.find(p => p.pid === pid);
      players = players.filter(p => p.pid !== pid);
      if (row) U.toast(row.name + ' вышел');
      Game.removePlayer(pid);
      broadcastLobby();
    });

    /* --- КЛИЕНТ: состояние лобби --- */
    Net.on('lb', (from, msg) => {
      if (isHost) return;
      players = msg.p || [];
      killLimit = msg.kl;
      renderPlayers();
    });

    /* --- КЛИЕНТ: старт боя --- */
    Net.on('go', (from, msg) => {
      if (isHost) return;
      Game.start({ isHost: false, myPid: Net.myId, players: msg.p, arena: msg.a, killLimit: msg.kl });
    });

    /* --- КЛИЕНТ: снапшот --- */
    Net.on('st', (from, msg) => Game.onSnapshot(msg));

    /* --- КЛИЕНТ: конец боя --- */
    Net.on('over', (from, msg) => Game.onOver(msg));

    /* --- КЛИЕНТ: обратно в лобби --- */
    Net.on('lobby', () => backToLobby());

    /* --- хост пропал --- */
    Net.on('hostgone', () => {
      U.toast('Хост отключился');
      leave();
    });

    Net.on('error', (m) => U.toast(m));
  }

  /* =================================================================
     ПЕРЕХОДЫ
     ================================================================= */
  function backToLobby() {
    Game.stop();
    hudSig = '';
    $('#win-overlay').classList.remove('on');
    $('#death-overlay').classList.remove('on');
    showScreen('lobby');
    renderPlayers();
  }

  function leave() {
    Game.stop();
    Net.destroy();
    isHost = false;
    players = [];
    arenaData = null;
    hudSig = '';
    $('#arena-drop').classList.remove('has-photo');
    $('#menu-status').textContent = 'Хост создаёт комнату и передаёт код друзьям.';
    $('#menu-status').classList.remove('err');
    showScreen('menu');
  }

  /* =================================================================
     ИГРОВОЙ HUD (вызывается каждый кадр из Game)
     ================================================================= */
  function updateHUD(st) {
    // табло очков перерисовываем только при изменениях
    const sig = st.players.map(p => `${p.pid}:${p.kills}:${p.dead ? 1 : 0}`).join('|') + '|' + st.killLimit;
    if (sig !== hudSig) {
      hudSig = sig;
      const box = $('#hud-score');
      box.innerHTML = '';
      st.players.slice().sort((a, b) => b.kills - a.kills).forEach(p => {
        const row = players.find(x => x.pid === p.pid);
        const el = document.createElement('div');
        el.className = 'sc' + (p.me ? ' me' : '') + (p.dead ? ' dead' : '');
        el.style.setProperty('--sc-color', p.color);
        el.innerHTML = `
          <img src="${(row && row.avatar) || U.defaultAvatar(p.color)}" alt="">
          <span class="sc-name">${escapeHtml(p.name)}</span>
          <span class="sc-kills">${p.kills}${st.killLimit ? '/' + st.killLimit : ''}</span>`;
        box.appendChild(el);
      });
    }

    // оверлей смерти с таймером респавна
    const dov = $('#death-overlay');
    if (st.meDead && !st.over) {
      dov.classList.add('on');
      $('#death-timer').textContent = Math.ceil(st.respawnLeft / 1000);
    } else {
      dov.classList.remove('on');
    }

    // индикатор сети
    $('#net-badge').textContent =
      `${st.isHost ? 'ХОСТ' : 'КЛИЕНТ'} · ${st.fps} FPS` + (st.isHost ? '' : ` · ${st.ping} мс`);
  }

  /* Экран победы. */
  function showWin(name, table, canRestart) {
    $('#win-name').textContent = name;
    const list = $('#win-list');
    list.innerHTML = '';
    table.forEach(r => {
      const row = players.find(x => x.pid === r.pid);
      const el = document.createElement('div');
      el.className = 'win-row';
      el.innerHTML = `
        <img src="${(row && row.avatar) || U.defaultAvatar(r.color)}" alt="">
        <span class="wn" style="color:${r.color}">${escapeHtml(r.name)}</span>
        <span class="wk">${r.kills}</span>`;
      list.appendChild(el);
    });
    // хост может вернуть всех в лобби, клиенты просто ждут
    const btn = $('#btn-again');
    btn.style.display = canRestart ? '' : 'none';
    let note = document.getElementById('win-wait');
    if (!canRestart) {
      if (!note) {
        note = document.createElement('div');
        note.id = 'win-wait';
        note.style.cssText = 'font-size:12px;color:#8a8aa8;letter-spacing:.14em';
        note.textContent = 'ЖДЁМ ХОСТА…';
        btn.after(note);
      }
      note.style.display = '';
    } else if (note) note.style.display = 'none';
    $('#win-overlay').classList.add('on');
  }

  return { init, showScreen, updateHUD, showWin };
})();

/* Поехали. */
window.addEventListener('DOMContentLoaded', UI.init);
