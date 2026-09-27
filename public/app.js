(() => {
  'use strict';

  // =========================================================================
  // Segédfüggvények
  // =========================================================================
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const icon = (name, cls = '') => `<svg class="i ${cls}"><use href="#i-${name}"/></svg>`;
  const initials = (name) =>
    String(name || '?').trim().split(/\s+/).map((p) => p[0]).join('').slice(0, 2).toUpperCase();
  const avatar = (u, cls = '') =>
    `<div class="avatar ${cls}" style="--c:${esc(u.color)}">${esc(initials(u.name))}</div>`;
  const pad = (n) => String(n).padStart(2, '0');
  const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const sameDay = (a, b) => a.toDateString() === b.toDateString();

  const local = {
    get(key, fallback) {
      try {
        const v = localStorage.getItem(key);
        return v === null ? fallback : JSON.parse(v);
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try {
        if (value === null || value === undefined) localStorage.removeItem(key);
        else localStorage.setItem(key, JSON.stringify(value));
      } catch {}
    },
  };

  function formatSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
    if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
    return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  }

  function linkify(text) {
    return esc(text).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.append(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
  }

  const roomUrl = (id) => `${location.origin}/#/room/${id}`;

  function toast(html, { type = '', onClick, ms = 3800 } = {}) {
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.innerHTML = html;
    if (onClick) {
      el.style.cursor = 'pointer';
      el.addEventListener('click', () => {
        onClick();
        el.remove();
      });
    }
    $('#toasts').append(el);
    setTimeout(() => {
      el.classList.add('hide');
      setTimeout(() => el.remove(), 300);
    }, ms);
  }

  // =========================================================================
  // Állapot + API
  // =========================================================================
  const S = {
    token: local.get('tg_token', null),
    user: null,
    config: { allowRegistration: true, maxUploadMb: 1024 },
    users: [],
    meetings: [],
    live: {},
    online: [],
    clientId: (crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`).replace(/[^a-z0-9-]/gi, ''),
  };

  async function api(path, { method = 'GET', body } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (S.token) headers.Authorization = `Bearer ${S.token}`;
    const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && S.token) {
      logoutLocal();
      throw new Error(data.error || 'Lépj be újra.');
    }
    if (!res.ok) throw new Error(data.error || 'Hiba történt.');
    return data;
  }

  // =========================================================================
  // Nézetek + útválasztás
  // =========================================================================
  function show(view) {
    $$('.view').forEach((v) => (v.hidden = v.id !== `view-${view}`));
    document.body.classList.toggle('in-room', view === 'room');
    S.view = view;
  }

  function route() {
    if (!S.user) return showAuth();
    const m = location.hash.match(/^#\/room\/([a-f0-9]+)/);
    if (m) {
      if (call.id === m[1]) return show('room');
      if (call.id) leaveCall(false);
      return openLobby(m[1]);
    }
    if (call.id) leaveCall(false);
    showHome();
  }

  window.addEventListener('hashchange', route);
  document.addEventListener('click', (e) => {
    const nav = e.target.closest('[data-nav]');
    if (nav) location.hash = nav.dataset.nav;
  });

  // =========================================================================
  // PIN beviteli mező (4 doboz)
  // =========================================================================
  function createPin(container, onComplete) {
    container.innerHTML = Array.from(
      { length: 4 },
      () => '<input inputmode="numeric" pattern="[0-9]*" maxlength="1" autocomplete="off" />'
    ).join('');
    const inputs = $$('input', container);
    let busy = false;

    const value = () => inputs.map((i) => i.value).join('');
    const sync = () => inputs.forEach((i) => i.classList.toggle('filled', !!i.value));

    function check() {
      sync();
      const v = value();
      if (v.length === 4 && !busy) {
        busy = true;
        Promise.resolve(onComplete(v)).finally(() => (busy = false));
      }
    }

    inputs.forEach((input, idx) => {
      input.addEventListener('input', () => {
        container.classList.remove('error');
        input.value = input.value.replace(/\D/g, '').slice(-1);
        if (input.value && idx < 3) inputs[idx + 1].focus();
        check();
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Backspace' && !input.value && idx > 0) {
          inputs[idx - 1].value = '';
          inputs[idx - 1].focus();
          sync();
          e.preventDefault();
        } else if (e.key === 'ArrowLeft' && idx > 0) inputs[idx - 1].focus();
        else if (e.key === 'ArrowRight' && idx < 3) inputs[idx + 1].focus();
      });
      input.addEventListener('paste', (e) => {
        const digits = (e.clipboardData.getData('text') || '').replace(/\D/g, '').slice(0, 4);
        if (!digits) return;
        e.preventDefault();
        digits.split('').forEach((d, i) => (inputs[i].value = d));
        inputs[Math.min(digits.length, 3)].focus();
        check();
      });
      input.addEventListener('focus', () => input.select());
    });

    return {
      clear() {
        inputs.forEach((i) => (i.value = ''));
        container.classList.remove('error', 'ok');
        sync();
      },
      focus: () => setTimeout(() => inputs[0].focus(), 60),
      error() {
        container.classList.remove('ok');
        void container.offsetWidth;
        container.classList.add('error');
        setTimeout(() => {
          inputs.forEach((i) => (i.value = ''));
          sync();
          inputs[0].focus();
        }, 420);
      },
      ok: () => container.classList.add('ok'),
    };
  }

  // =========================================================================
  // Belépés + regisztráció
  // =========================================================================
  const reg = { name: '', role: 'CEO', pin: '' };
  let loginUser = null;

  function authStep(step) {
    $$('.auth-step').forEach((s) => s.classList.toggle('active', s.dataset.step === step));
    $$('.form-error', $('#view-auth')).forEach((e) => (e.textContent = ''));
    if (step === 'login-pin') (pinLogin.clear(), pinLogin.focus());
    if (step === 'reg-name') setTimeout(() => $('#reg-name').focus(), 60);
    if (step === 'reg-pin') (pinReg1.clear(), pinReg2.clear(), pinReg1.focus());
    if (step === 'reg-pin2') (pinReg2.clear(), pinReg2.focus());
  }

  $('#view-auth').addEventListener('click', (e) => {
    const go = e.target.closest('[data-go]');
    if (go) authStep(go.dataset.go);
  });

  async function showAuth() {
    show('auth');
    if (S.config.db === 'missing') return authStep('setup');
    try {
      S.users = await api('/api/users');
    } catch {
      S.users = [];
    }
    const picker = $('#user-picker');
    picker.innerHTML = S.users.length
      ? S.users
          .map(
            (u) => `<button class="user-option" data-id="${u.id}">
              ${avatar(u)}
              <div><div class="name">${esc(u.name)}</div><span class="role-badge">${esc(u.role)}</span></div>
              ${icon('back', 'go')}
            </button>`
          )
          .join('')
      : '<div class="empty-note">Még nincs fiók. Hozd létre az elsőt!</div>';
    $('[data-go="reg-name"]', $('[data-step="pick"]')).hidden = !S.config.allowRegistration;
    authStep(S.users.length || !S.config.allowRegistration ? 'pick' : 'reg-name');
  }

  $('#user-picker').addEventListener('click', (e) => {
    const btn = e.target.closest('.user-option');
    if (!btn) return;
    loginUser = S.users.find((u) => u.id === btn.dataset.id);
    $('#login-who').innerHTML = `${avatar(loginUser, 'avatar-lg')}<div><div class="name">${esc(loginUser.name)}</div><span class="role-badge">${esc(loginUser.role)}</span></div>`;
    authStep('login-pin');
  });

  const pinLogin = createPin($('#pin-login'), async (pin) => {
    try {
      const res = await api('/api/login', { method: 'POST', body: { name: loginUser.name, pin } });
      pinLogin.ok();
      setTimeout(() => setSession(res), 250);
    } catch (err) {
      $('#login-error').textContent = err.message;
      pinLogin.error();
    }
  });

  // Szerep kiválasztása
  $('#reg-role').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    $$('#reg-role button').forEach((b) => b.classList.toggle('on', b === btn));
    const custom = btn.dataset.role === '';
    $('#reg-role-custom').hidden = !custom;
    if (custom) $('#reg-role-custom').focus();
    reg.role = btn.dataset.role;
  });

  $('#reg-name-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('#reg-name').value.trim();
    const role = reg.role || $('#reg-role-custom').value.trim();
    const err = $('#reg-name-error');
    if (name.length < 2) return (err.textContent = 'A név legalább 2 karakter legyen.');
    if (!role) return (err.textContent = 'Add meg a szereped.');
    if (S.users.some((u) => u.name.toLowerCase() === name.toLowerCase())) {
      return (err.textContent = 'Ez a név már foglalt – válaszd ki a listából és lépj be.');
    }
    reg.name = name;
    reg.finalRole = role;
    authStep('reg-pin');
  });

  const pinReg1 = createPin($('#pin-reg1'), (pin) => {
    reg.pin = pin;
    setTimeout(() => authStep('reg-pin2'), 180);
  });

  const pinReg2 = createPin($('#pin-reg2'), async (pin) => {
    const err = $('#reg-pin-error');
    if (pin !== reg.pin) {
      err.textContent = 'A két kód nem egyezik. Kezdjük újra.';
      pinReg2.error();
      setTimeout(() => authStep('reg-pin'), 1100);
      return;
    }
    try {
      const res = await api('/api/register', {
        method: 'POST',
        body: { name: reg.name, role: reg.finalRole, pin: reg.pin, pin2: pin },
      });
      pinReg2.ok();
      toast(`${icon('check')} Fiók létrehozva. Üdv, ${esc(res.user.name)}!`);
      setTimeout(() => setSession(res), 250);
    } catch (e) {
      err.textContent = e.message;
      pinReg2.error();
    }
  });

  function setSession({ token, user }) {
    S.token = token;
    S.user = user;
    local.set('tg_token', token);
    route();
    poll();
  }

  function logoutLocal() {
    if (call.id) leaveCall(false);
    stopLocalMedia();
    clearTimeout(pollTimer);
    S.user = null;
    S.token = null;
    local.set('tg_token', null);
    showAuth();
  }

  $('#btn-logout').addEventListener('click', async () => {
    try {
      await api('/api/logout', { method: 'POST' });
    } catch {}
    logoutLocal();
  });

  // =========================================================================
  // Jelenlét: pár másodpercenként bejelentkezünk a szerverre, és visszakapjuk,
  // ki van online, ki melyik hívásban ül, és a meetingek listáját.
  // =========================================================================
  let pollTimer = null;
  let polling = false;

  async function poll() {
    clearTimeout(pollTimer);
    if (!S.user) return;
    if (polling) return (pollTimer = setTimeout(poll, 500));
    polling = true;
    try {
      const res = await api('/api/presence', {
        method: 'POST',
        body: { clientId: S.clientId, roomId: call.id, peerId: call.peerId, since: call.since, state: localState() },
      });
      applyPresence(res);
    } catch {
      /* hálózati hiba – a következő kör újrapróbálja */
    } finally {
      polling = false;
    }
    if (S.user) pollTimer = setTimeout(poll, call.id ? 10000 : document.hidden ? 30000 : 8000);
  }

  function applyPresence(res) {
    notifyNewLive(S.live, res.live);
    S.live = res.live;
    S.online = res.online;
    S.users = res.users;
    S.meetings = res.meetings;
    if (S.view === 'home') renderHome();
    if (S.view === 'lobby') renderLobbyLive();
    if (call.id) {
      reconcileMembers(res.members);
      if (res.msgCount > call.messages.length) syncMessages();
    }
  }

  document.addEventListener('visibilitychange', () => !document.hidden && S.user && poll());
  window.addEventListener('pagehide', () => {
    if (!S.token) return;
    const body = JSON.stringify({ token: S.token, clientId: S.clientId, gone: true });
    navigator.sendBeacon?.('/api/presence', new Blob([body], { type: 'application/json' }));
  });

  function notifyNewLive(prev, next) {
    for (const [roomId, users] of Object.entries(next)) {
      if (roomId === call.id) continue;
      const before = new Set((prev[roomId] || []).map((u) => u.id));
      const joined = users.filter((u) => !before.has(u.id) && u.id !== S.user?.id);
      if (!joined.length) continue;
      const meeting = S.meetings.find((m) => m.id === roomId);
      const u = joined[0];
      toast(
        `${avatar(u)}<span><b>${esc(u.name)}</b> belépett: ${esc(meeting?.title || 'meeting')} – kattints a csatlakozáshoz</span>`,
        { onClick: () => (location.hash = `#/room/${roomId}`), ms: 8000 }
      );
    }
  }

  // =========================================================================
  // Főoldal
  // =========================================================================
  function greeting() {
    const h = new Date().getHours();
    if (h < 10) return 'Jó reggelt';
    if (h < 18) return 'Szép napot';
    return 'Jó estét';
  }

  function showHome() {
    stopLocalMedia();
    show('home');
    document.title = 'Tárgyaló';
    const u = S.user;
    $('#me-pill').innerHTML = `${avatar(u)}<span class="name">${esc(u.name)}</span><span class="role-badge">${esc(u.role)}</span>`;
    renderHome();
    loadMeetings();
  }

  const loadMeetings = () => poll();

  const monthFmt = new Intl.DateTimeFormat('hu-HU', { month: 'short' });
  const longDate = new Intl.DateTimeFormat('hu-HU', { weekday: 'long', month: 'long', day: 'numeric' });
  const fullDate = new Intl.DateTimeFormat('hu-HU', { month: 'long', day: 'numeric', weekday: 'long' });

  function meetingTimes(m) {
    const start = new Date(m.startsAt);
    const end = new Date(start.getTime() + m.durationMin * 60000);
    return { start, end };
  }

  function relativeWhen(m) {
    const now = new Date();
    const { start, end } = meetingTimes(m);
    if (start <= now && now < end) return { text: 'Most esedékes', soon: true };
    if (end <= now) return { text: fullDate.format(start) };
    const mins = Math.round((start - now) / 60000);
    if (mins < 60) return { text: `${mins || 1} perc múlva`, soon: true };
    if (sameDay(start, now)) return { text: `ma ${hm(start)}` };
    const tomorrow = new Date(now);
    tomorrow.setDate(now.getDate() + 1);
    if (sameDay(start, tomorrow)) return { text: `holnap ${hm(start)}` };
    const days = Math.ceil((start - now) / 86400000);
    return { text: `${days} nap múlva` };
  }

  function meetingCard(m, kind) {
    const { start, end } = meetingTimes(m);
    const live = S.live[m.id] || [];
    const when = relativeWhen(m);
    const mine = m.createdBy === S.user.id;
    const whenHtml = live.length
      ? `<span class="m-live">${live.length} fő bent van</span>`
      : `<span class="${when.soon ? 'm-when-soon' : ''}">${esc(when.text)}</span>`;
    return `<div class="meeting ${kind === 'live' ? 'is-live' : ''} ${kind === 'past' ? 'is-past' : ''}" data-id="${m.id}">
      <div class="m-date"><span class="mon">${esc(monthFmt.format(start).replace('.', ''))}</span><span class="day">${start.getDate()}</span></div>
      <div class="m-body">
        <div class="m-title">${esc(m.title)}</div>
        ${m.description ? `<div class="m-desc">${esc(m.description)}</div>` : ''}
        <div class="m-meta">
          <span>${icon('clock')}${hm(start)}–${hm(end)}</span>
          ${whenHtml}
          ${m.creator ? `<span>Szervező: ${esc(m.creator.name)}</span>` : ''}
          ${live.length ? `<span class="stack-avatars">${live.map((u) => avatar(u)).join('')}</span>` : ''}
        </div>
      </div>
      <div class="m-actions">
        <button class="icon-btn" data-act="copy" title="Link másolása">${icon('link')}</button>
        ${mine ? `<button class="icon-btn" data-act="delete" title="Törlés">${icon('trash')}</button>` : ''}
        <button class="btn ${kind === 'live' || when.soon ? 'btn-primary' : 'btn-ghost'} btn-sm" data-act="join">${kind === 'live' ? 'Belépés' : 'Megnyitás'}</button>
      </div>
    </div>`;
  }

  function renderHome() {
    if (!S.user) return;
    const now = new Date();
    $('#home-greeting').textContent = `${greeting()}, ${S.user.name}!`;
    $('#home-date').textContent = longDate.format(now);

    const live = [];
    const upcoming = [];
    const past = [];
    for (const m of S.meetings) {
      const { end } = meetingTimes(m);
      if ((S.live[m.id] || []).length) live.push(m);
      else if (end > now) upcoming.push(m);
      else past.push(m);
    }
    past.reverse();

    $('#live-section').hidden = !live.length;
    $('#live-list').innerHTML = live.map((m) => meetingCard(m, 'live')).join('');
    $('#upcoming-list').innerHTML = upcoming.length
      ? upcoming.map((m) => meetingCard(m, 'upcoming')).join('')
      : '<div class="empty">Nincs meghirdetett meeting. Hirdess meg egyet, vagy indíts azonnalit!</div>';
    $('#past-section').hidden = !past.length;
    $('#past-count').textContent = past.length ? `(${past.length})` : '';
    $('#past-list').innerHTML = past.slice(0, 30).map((m) => meetingCard(m, 'past')).join('');
    renderTeam();
  }

  function renderTeam() {
    const liveTitle = (userId) => {
      for (const [roomId, users] of Object.entries(S.live)) {
        if (users.some((u) => u.id === userId)) return S.meetings.find((m) => m.id === roomId)?.title || 'meetingben';
      }
      return null;
    };
    $('#team-list').innerHTML = S.users
      .map((u) => {
        const on = S.online.includes(u.id);
        const inCall = liveTitle(u.id);
        const status = inCall ? `Hívásban · ${esc(inCall)}` : on ? 'Online' : 'Offline';
        return `<div class="team-member">
          ${avatar(u, on ? 'online' : '')}
          <div class="who">
            <div class="name">${esc(u.name)}${u.id === S.user.id ? ' <span class="muted">(te)</span>' : ''}</div>
            <div class="status ${on ? 'on' : ''}">${status}</div>
          </div>
          <span class="role-badge">${esc(u.role)}</span>
        </div>`;
      })
      .join('');
  }

  $('#view-home').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const id = btn.closest('.meeting').dataset.id;
    const act = btn.dataset.act;
    if (act === 'join') location.hash = `#/room/${id}`;
    if (act === 'copy') {
      await copyText(roomUrl(id));
      toast(`${icon('check')} Meghívó link a vágólapon`);
    }
    if (act === 'delete') {
      const m = S.meetings.find((x) => x.id === id);
      if (!confirm(`Biztosan törlöd: „${m.title}”?`)) return;
      try {
        await api(`/api/meetings/${id}`, { method: 'DELETE' });
        toast('Meeting törölve');
        loadMeetings();
      } catch (err) {
        toast(esc(err.message), { type: 'error' });
      }
    }
  });

  $('#btn-instant').addEventListener('click', async () => {
    try {
      const m = await api('/api/meetings', { method: 'POST', body: { instant: true, title: `${S.user.name} azonnali meetingje` } });
      await copyText(roomUrl(m.id));
      toast(`${icon('check')} Meeting létrehozva – a link a vágólapon`);
      location.hash = `#/room/${m.id}`;
    } catch (e) {
      toast(esc(e.message), { type: 'error' });
    }
  });

  // Meghirdetés dialógus
  const dlg = $('#dlg-schedule');
  $('#btn-schedule').addEventListener('click', () => {
    const form = $('#schedule-form');
    form.reset();
    const d = new Date(Date.now() + 30 * 60000);
    d.setMinutes(d.getMinutes() < 30 ? 30 : 60, 0, 0);
    form.date.value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    form.time.value = hm(d);
    $('#schedule-error').textContent = '';
    dlg.showModal();
    setTimeout(() => form.title.focus(), 50);
  });
  dlg.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]') || e.target === dlg) dlg.close();
  });
  $('#schedule-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const startsAt = new Date(`${f.date.value}T${f.time.value}`);
    try {
      const m = await api('/api/meetings', {
        method: 'POST',
        body: {
          title: f.title.value,
          description: f.description.value,
          startsAt: startsAt.toISOString(),
          durationMin: Number(f.durationMin.value),
        },
      });
      dlg.close();
      await copyText(roomUrl(m.id));
      toast(`${icon('check')} „${esc(m.title)}” meghirdetve – link a vágólapon`);
      loadMeetings();
    } catch (err) {
      $('#schedule-error').textContent = err.message;
    }
  });

  // Óra és visszaszámlálók frissítése
  let lastMinute = -1;
  setInterval(() => {
    const now = new Date();
    const clock = hm(now);
    $('#home-clock').textContent = clock;
    $('#room-clock').textContent = clock;
    if (call.id) {
      const s = Math.floor((Date.now() - call.startedAt) / 1000);
      $('#room-timer').textContent = s >= 3600
        ? `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`
        : `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
    }
    if (now.getMinutes() !== lastMinute) {
      lastMinute = now.getMinutes();
      if (S.view === 'home') renderHome();
    }
  }, 1000);

  // =========================================================================
  // Helyi média (mikrofon, kamera, képernyő)
  // =========================================================================
  const prefs = Object.assign({ mic: true, cam: true, micId: '', camId: '' }, local.get('tg_prefs', {}));
  const savePrefs = () => local.set('tg_prefs', prefs);

  const media = { audio: null, video: null, screen: null };
  const micOn = () => prefs.mic && !!media.audio;
  const camOn = () => prefs.cam && !!media.video;
  const currentVideo = () => media.screen || (camOn() ? media.video : null);

  const audioConstraints = () => ({
    deviceId: prefs.micId ? { exact: prefs.micId } : undefined,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  });
  const videoConstraints = () => ({
    deviceId: prefs.camId ? { exact: prefs.camId } : undefined,
    width: { ideal: 1280 },
    height: { ideal: 720 },
    frameRate: { ideal: 30 },
  });

  const hasMediaApi = () => !!navigator.mediaDevices?.getUserMedia;

  async function getTrack(kind) {
    if (!hasMediaApi()) return null;
    const constraints = kind === 'audio' ? { audio: audioConstraints() } : { video: videoConstraints() };
    try {
      const s = await navigator.mediaDevices.getUserMedia(constraints);
      return s.getTracks()[0];
    } catch (err) {
      // ha a mentett eszköz eltűnt, próbáljuk az alapértelmezettel
      if (err.name === 'OverconstrainedError' || err.name === 'NotFoundError') {
        if (kind === 'audio' && prefs.micId) return (prefs.micId = ''), getTrack(kind);
        if (kind === 'video' && prefs.camId) return (prefs.camId = ''), getTrack(kind);
      }
      const what = kind === 'audio' ? 'mikrofonhoz' : 'kamerához';
      const msg =
        err.name === 'NotAllowedError'
          ? `Nincs engedély a ${what}. Engedélyezd a böngésző címsorában.`
          : `Nem sikerült hozzáférni a ${what}.`;
      toast(esc(msg), { type: 'error' });
      return null;
    }
  }

  async function startLocalMedia() {
    if (!hasMediaApi()) {
      toast('A kamera és mikrofon csak HTTPS-en vagy localhoston működik.', { type: 'error', ms: 7000 });
      return;
    }
    const wantAudio = !media.audio;
    const wantVideo = prefs.cam && !media.video;
    if (!wantAudio && !wantVideo) return;
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        audio: wantAudio ? audioConstraints() : false,
        video: wantVideo ? videoConstraints() : false,
      });
      if (wantAudio) media.audio = s.getAudioTracks()[0] || null;
      if (wantVideo) media.video = s.getVideoTracks()[0] || null;
    } catch {
      if (wantAudio) media.audio = await getTrack('audio');
      if (wantVideo) media.video = await getTrack('video');
    }
    if (media.audio) media.audio.enabled = prefs.mic;
    watchLevel('local', media.audio, onLocalLevel);
    // ha közben már csatlakozott a hívásba, a sávokat is frissíteni kell
    replaceSenders('audio', media.audio);
    replaceSenders('video', currentVideo());
    refreshLocal();
    fillDeviceSelects();
  }

  function stopLocalMedia() {
    unwatch('local');
    media.audio?.stop();
    media.video?.stop();
    media.screen?.stop();
    media.audio = media.video = media.screen = null;
  }

  async function setMic(on) {
    prefs.mic = on;
    savePrefs();
    if (on && !media.audio) {
      media.audio = await getTrack('audio');
      if (!media.audio) prefs.mic = false;
      watchLevel('local', media.audio, onLocalLevel);
      replaceSenders('audio', media.audio);
    }
    if (media.audio) media.audio.enabled = prefs.mic;
    refreshLocal();
  }

  async function setCam(on) {
    prefs.cam = on;
    savePrefs();
    if (on && !media.video) {
      media.video = await getTrack('video');
      if (!media.video) prefs.cam = false;
    } else if (!on && media.video) {
      media.video.stop(); // a kamera lámpája is kialszik
      media.video = null;
    }
    replaceSenders('video', currentVideo());
    refreshLocal();
  }

  async function toggleScreen() {
    if (media.screen) return stopScreen();
    if (!navigator.mediaDevices?.getDisplayMedia) {
      return toast('Ez a böngésző / eszköz nem támogatja a képernyőmegosztást.', { type: 'error' });
    }
    try {
      const s = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30 } }, audio: false });
      const track = s.getVideoTracks()[0];
      track.contentHint = 'detail';
      track.addEventListener('ended', stopScreen);
      media.screen = track;
      replaceSenders('video', currentVideo());
      refreshLocal();
      toast(`${icon('screen')} Képernyőmegosztás elindítva`);
    } catch {
      /* a felhasználó megszakította */
    }
  }

  function stopScreen() {
    if (!media.screen) return;
    media.screen.stop();
    media.screen = null;
    replaceSenders('video', currentVideo());
    refreshLocal();
  }

  function refreshLocal() {
    if (S.view === 'lobby') paintLobby();
    if (call.id) {
      paintLocalTile();
      sendState();
      paintControls();
      renderPeople();
      layout();
    }
  }

  // Eszközválasztó
  async function fillDeviceSelects() {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const devices = await navigator.mediaDevices.enumerateDevices();
    const fill = (sel, kind, current, label) => {
      const list = devices.filter((d) => d.kind === kind);
      sel.innerHTML = list.length
        ? list.map((d, i) => `<option value="${esc(d.deviceId)}">${esc(d.label || `${label} ${i + 1}`)}</option>`).join('')
        : '<option value="">Nem található</option>';
      if (current) sel.value = current.getSettings().deviceId || '';
    };
    fill($('#sel-mic'), 'audioinput', media.audio, 'Mikrofon');
    fill($('#sel-cam'), 'videoinput', media.video, 'Kamera');
  }

  $('#sel-mic').addEventListener('change', async (e) => {
    prefs.micId = e.target.value;
    savePrefs();
    const track = await getTrack('audio');
    if (!track) return;
    media.audio?.stop();
    media.audio = track;
    track.enabled = prefs.mic;
    watchLevel('local', track, onLocalLevel);
    replaceSenders('audio', track);
  });

  $('#sel-cam').addEventListener('change', async (e) => {
    prefs.camId = e.target.value;
    savePrefs();
    if (!prefs.cam) return;
    const track = await getTrack('video');
    if (!track) return;
    media.video?.stop();
    media.video = track;
    replaceSenders('video', currentVideo());
    refreshLocal();
  });

  // =========================================================================
  // Hangszint mérés (beszéd kijelzés)
  // =========================================================================
  let actx = null;
  const meters = new Map();

  function audioCtx() {
    if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === 'suspended') actx.resume().catch(() => {});
    return actx;
  }

  function watchLevel(key, track, cb) {
    unwatch(key);
    if (!track) return;
    try {
      const ctx = audioCtx();
      const src = ctx.createMediaStreamSource(new MediaStream([track]));
      const an = ctx.createAnalyser();
      an.fftSize = 512;
      src.connect(an);
      meters.set(key, { src, an, data: new Uint8Array(an.fftSize), cb });
    } catch {}
  }

  function unwatch(key) {
    const m = meters.get(key);
    if (!m) return;
    m.src.disconnect();
    meters.delete(key);
  }

  setInterval(() => {
    for (const m of meters.values()) {
      m.an.getByteTimeDomainData(m.data);
      let sum = 0;
      for (const v of m.data) sum += ((v - 128) / 128) ** 2;
      m.cb(Math.sqrt(sum / m.data.length));
    }
  }, 100);

  function setSpeaking(el, on) {
    if (!el) return;
    if (on) {
      el._spokeAt = Date.now();
      el.classList.add('speaking');
    } else if (Date.now() - (el._spokeAt || 0) > 500) {
      el.classList.remove('speaking');
    }
  }

  function onLocalLevel(level) {
    const active = prefs.mic && level > 0.03;
    if (call.id) setSpeaking(call.localTile, active);
    else if (S.view === 'lobby') {
      const bars = $$('#lobby-meter i');
      const n = prefs.mic ? Math.min(5, Math.round(level * 60)) : 0;
      bars.forEach((b, i) => (b.style.height = i < n ? `${6 + i * 3}px` : '4px'));
    }
  }

  // =========================================================================
  // Előcsarnok
  // =========================================================================
  const call = {
    id: null,
    meeting: null,
    peers: new Map(),
    iceServers: [],
    startedAt: 0,
    localTile: null,
    messages: [],
    unread: 0,
    pinned: null,
    tab: 'chat',
    sideOpen: false,
    lastGroup: null,
    peer: null, // PeerJS kapcsolat a jelzőszerverhez
    peerId: null,
    since: 0,
    msgIds: new Set(),
  };
  let lobbyMeeting = null;

  async function openLobby(id) {
    try {
      lobbyMeeting = await api(`/api/meetings/${id}`);
    } catch (e) {
      toast(esc(e.message), { type: 'error' });
      location.hash = '#/';
      return;
    }
    show('lobby');
    const m = lobbyMeeting;
    const { start, end } = meetingTimes(m);
    document.title = `${m.title} – Tárgyaló`;
    $('#lobby-when').textContent = `${fullDate.format(start)} · ${hm(start)}–${hm(end)}`;
    $('#lobby-title').textContent = m.title;
    $('#lobby-desc').textContent = m.description || (m.creator ? `Szervező: ${m.creator.name}` : '');
    $('#lobby-avatar').innerHTML = avatar(S.user);
    renderLobbyLive();
    paintLobby();
    await startLocalMedia();
    paintLobby();
  }

  function renderLobbyLive() {
    if (!lobbyMeeting) return;
    const users = S.live[lobbyMeeting.id] || [];
    $('#lobby-live').innerHTML = users.length
      ? `<span class="stack-avatars">${users.map((u) => avatar(u)).join('')}</span>
         <span>${users.map((u) => esc(u.name)).join(', ')} már bent ${users.length > 1 ? 'vannak' : 'van'}</span>`
      : '<span>Még senki sincs bent – te leszel az első.</span>';
  }

  function paintLobby() {
    const video = $('#lobby-video');
    const tile = $('#lobby-tile');
    const v = camOn() ? media.video : null;
    if (video.srcObject?.getVideoTracks()[0] !== v) video.srcObject = v ? new MediaStream([v]) : null;
    tile.classList.toggle('has-video', !!v);
    tile.classList.add('mirror');
    paintToggle($('#lobby-mic'), micOn(), 'mic');
    paintToggle($('#lobby-cam'), camOn(), 'cam');
  }

  function paintToggle(btn, on, name) {
    btn.classList.toggle('off', !on);
    $('use', btn).setAttribute('href', `#i-${name}${on ? '' : '-off'}`);
  }

  $('#lobby-mic').addEventListener('click', () => (audioCtx(), setMic(!micOn())));
  $('#lobby-cam').addEventListener('click', () => setCam(!camOn()));
  $('#btn-copy-lobby').addEventListener('click', async () => {
    await copyText(roomUrl(lobbyMeeting.id));
    toast(`${icon('check')} Meghívó link a vágólapon`);
  });
  $('#btn-join').addEventListener('click', () => joinCall(lobbyMeeting));

  // =========================================================================
  // Hívás
  // =========================================================================
  const stage = $('#stage');

  async function joinCall(meeting) {
    audioCtx();
    call.id = meeting.id;
    call.meeting = meeting;
    call.startedAt = call.since = Date.now();
    call.messages = [];
    call.msgIds = new Set();
    call.unread = 0;
    call.pinned = null;
    call.lastGroup = null;
    stage.innerHTML = '';
    $('#messages').innerHTML = '';
    $('#room-title').textContent = meeting.title;
    document.title = `● ${meeting.title} – Tárgyaló`;
    show('room');

    call.localTile = createTile('local', S.user, true);
    paintLocalTile();
    paintControls();
    setSide(window.innerWidth > 1200, 'chat');

    try {
      await openPeer(meeting.id);
    } catch {
      toast('Nem sikerült elérni a hívásszervert. Ellenőrizd a netet, és próbáld újra.', { type: 'error', ms: 7000 });
      return leaveCall();
    }
    if (call.id !== meeting.id) return;
    call.joining = true; // az első körben mi hívunk mindenkit, aki már bent van
    await poll();
    call.joining = false;
    await syncMessages();
    renderMessagesEmpty();
  }

  // Kapcsolódás a PeerJS ingyenes jelzőszerveréhez. Ez csak a két böngésző
  // összekötéséhez kell, maga a kép, hang és chat közvetlenül megy.
  function openPeer(roomId) {
    return new Promise((resolve, reject) => {
      const id = `tg-${roomId}-${Math.random().toString(36).slice(2, 10)}`;
      const peer = new Peer(id, { debug: 1 });
      call.peer = peer;
      const timer = setTimeout(() => reject(new Error('timeout')), 15000);

      peer.on('open', (pid) => {
        clearTimeout(timer);
        call.peerId = pid;
        resolve();
      });
      peer.on('error', (err) => {
        if (err.type === 'peer-unavailable') {
          const gone = /peer (\S+)$/.exec(err.message)?.[1];
          if (gone) removePeer(gone, false);
        } else if (!call.peerId) {
          clearTimeout(timer);
          reject(err);
        } else {
          console.warn('PeerJS', err.type, err);
        }
      });
      peer.on('disconnected', () => {
        if (call.peer === peer && !peer.destroyed) setTimeout(() => !peer.destroyed && peer.reconnect(), 1500);
      });
      peer.on('connection', (conn) => call.peer === peer && adoptConn(conn, false));
      peer.on('call', (mc) => call.peer === peer && adoptMedia(mc, false));
    });
  }

  function leaveCall(navigate = true) {
    if (!call.id) return;
    broadcast({ type: 'bye' });
    const peer = call.peer;
    for (const id of [...call.peers.keys()]) removePeer(id, false);
    setTimeout(() => peer?.destroy(), 400); // hadd menjen ki a „bye”
    call.peer = null;
    call.peerId = null;
    stopLocalMedia();
    call.id = null;
    call.localTile = null;
    stage.innerHTML = '';
    setSide(false);
    poll();
    if (navigate) location.hash = '#/';
  }

  const localState = () => ({ mic: micOn(), cam: camOn(), screen: !!media.screen });
  const sendState = () => call.id && broadcast({ type: 'state', state: localState() });

  // Kikapcsolt kamera/mikrofon helyett néma hang és fekete kép megy, így a
  // kapcsolat sávjai mindig megvannak, és csak cserélni kell őket.
  let silentTrack = null;
  let blackTrack = null;
  function placeholder(kind) {
    if (kind === 'audio') {
      if (!silentTrack || silentTrack.readyState === 'ended') {
        silentTrack = audioCtx().createMediaStreamDestination().stream.getAudioTracks()[0];
      }
      return silentTrack;
    }
    if (!blackTrack || blackTrack.readyState === 'ended') {
      const c = Object.assign(document.createElement('canvas'), { width: 640, height: 360 });
      c.getContext('2d').fillRect(0, 0, c.width, c.height);
      blackTrack = c.captureStream(1).getVideoTracks()[0];
    }
    return blackTrack;
  }

  const outStream = () =>
    new MediaStream([media.audio || placeholder('audio'), currentVideo() || placeholder('video')]);

  function replaceSenders(kind, track) {
    const t = track || placeholder(kind);
    for (const p of call.peers.values()) {
      const pc = p.media?.peerConnection;
      const sender = pc?.getSenders().find((s) => s.track?.kind === kind);
      sender?.replaceTrack(t).catch(() => {});
    }
  }

  // --- Csempék ---------------------------------------------------------------
  function createTile(key, user, isLocal) {
    const el = document.createElement('div');
    el.className = 'tile';
    el.dataset.key = key;
    el.innerHTML = `
      <video autoplay playsinline ${isLocal ? 'muted' : ''}></video>
      <div class="tile-avatar">${avatar(user)}</div>
      <div class="tile-label"><span class="mic"></span><span class="nm">${esc(user.name)}${isLocal ? ' (te)' : ''}</span><span class="role">${esc(user.role)}</span></div>
      <div class="tile-badge" hidden></div>
      <button class="icon-btn tile-pin" title="Kiemelés">${icon('expand')}</button>`;
    $('.tile-pin', el).addEventListener('click', () => {
      call.pinned = call.pinned === key ? null : key;
      layout();
    });
    el.addEventListener('dblclick', () => {
      call.pinned = call.pinned === key ? null : key;
      layout();
    });
    stage.append(el);
    return el;
  }

  function paintTile(el, { mic, cam, screen }) {
    el.classList.toggle('has-video', cam || screen);
    el.classList.toggle('is-screen', screen);
    $('.mic', el).innerHTML = mic ? '' : icon('mic-off', 'mic-off');
  }

  function setBadge(el, html, cls = '') {
    const b = $('.tile-badge', el);
    b.hidden = !html;
    b.className = `tile-badge ${cls}`;
    b.innerHTML = html || '';
  }

  function paintLocalTile() {
    const el = call.localTile;
    if (!el) return;
    const video = $('video', el);
    const v = currentVideo();
    if (video.srcObject?.getVideoTracks()[0] !== v) video.srcObject = v ? new MediaStream([v]) : null;
    el.classList.toggle('mirror', !media.screen);
    paintTile(el, localState());
    setBadge(el, media.screen ? `${icon('screen')}Te osztod meg a képernyőd` : '');
  }

  function paintControls() {
    paintToggle($('#ctl-mic'), micOn(), 'mic');
    paintToggle($('#ctl-cam'), camOn(), 'cam');
    $('#ctl-screen').classList.toggle('active', !!media.screen);
  }

  // Rács elrendezés: a csempék mindig kitöltik a helyet torzítás nélkül
  function layout() {
    const tiles = [...stage.children];
    if (!tiles.length) return;
    const keys = tiles.map((t) => t.dataset.key);
    if (call.pinned && !keys.includes(call.pinned)) call.pinned = null;
    const remoteScreen = tiles.find((t) => t.classList.contains('is-screen') && t.dataset.key !== 'local');
    const localScreen = tiles.find((t) => t.classList.contains('is-screen'));
    const featured = call.pinned || (remoteScreen || localScreen)?.dataset.key || null;
    const spotlight = !!featured && tiles.length > 1;

    stage.classList.toggle('spotlight', spotlight);
    tiles.forEach((t) => {
      t.classList.toggle('featured', spotlight && t.dataset.key === featured);
      t.style.gridRow = '';
    });

    if (spotlight) {
      const narrow = window.innerWidth <= 900;
      const others = tiles.length - 1;
      stage.style.gridTemplateColumns = narrow ? '1fr' : 'minmax(0, 1fr) 240px';
      stage.style.gridTemplateRows = narrow ? '1fr' : `repeat(${others}, auto) 1fr`;
      tiles.find((t) => t.dataset.key === featured).style.gridRow = narrow ? '1' : `1 / span ${others + 1}`;
      return;
    }

    const n = tiles.length;
    const W = stage.clientWidth;
    const H = stage.clientHeight;
    const gap = 12;
    let best = { w: 0, cols: 1 };
    for (let cols = 1; cols <= n; cols++) {
      const rows = Math.ceil(n / cols);
      const w = Math.min((W - gap * (cols - 1)) / cols, ((H - gap * (rows - 1)) / rows) * (16 / 9));
      if (w > best.w) best = { w, cols };
    }
    stage.style.gridTemplateRows = '';
    stage.style.gridTemplateColumns = `repeat(${best.cols}, ${Math.floor(best.w)}px)`;
  }

  new ResizeObserver(() => call.id && layout()).observe(stage);

  // --- Kapcsolatok ----------------------------------------------------------
  // Minden résztvevővel két kapcsolat van: egy adatcsatorna (chat, állapot,
  // reakciók) és egy médiahívás (kép + hang). Ha véletlenül mindkét fél egyszerre
  // hívja a másikat, mindkét oldalon a kisebb azonosítójú fél hívása marad meg.
  const isDead = (c) => !c || c._dead;

  function ensurePeer(peerId, user, state) {
    let p = call.peers.get(peerId);
    if (p) {
      clearTimeout(p.removeTimer);
      return p;
    }
    p = {
      id: peerId,
      user: user || { name: '…', role: '', color: '#555' },
      state: state || { mic: false, cam: false, screen: false },
      conn: null,
      media: null,
      waits: 0,
      tile: createTile(peerId, user || { name: '…', role: '', color: '#555' }, false),
    };
    call.peers.set(peerId, p);
    paintPeer(p);
    renderPeople();
    layout();
    return p;
  }

  function reconcileMembers(members) {
    const present = new Set(members.map((m) => m.peerId));
    for (const m of members) {
      const p = call.peers.get(m.peerId);
      if (p && !isDead(p.conn) && !isDead(p.media)) continue;
      // Belépéskor mi hívunk mindenkit; utána csak a kisebb azonosítójú fél,
      // vagy ha két kör óta senki sem kezdeményezett.
      const waits = (p?.waits || 0) + 1;
      if (call.joining || call.peerId < m.peerId || waits > 2) connectTo(m);
      else ensurePeer(m.peerId, m.user, m.state).waits = waits;
    }
    for (const [id, p] of call.peers) {
      if (!present.has(id) && isDead(p.conn) && isDead(p.media)) removePeer(id, true);
    }
  }

  function connectTo(m) {
    if (!call.peer || call.peer.destroyed) return;
    const p = ensurePeer(m.peerId, m.user, m.state);
    p.waits = 0;
    if (isDead(p.conn)) {
      adoptConn(call.peer.connect(m.peerId, { reliable: true, metadata: { user: S.user, state: localState() } }), true);
    }
    if (isDead(p.media)) {
      adoptMedia(call.peer.call(m.peerId, outStream(), { metadata: { user: S.user, state: localState() } }), true);
    }
  }

  // true, ha az új kapcsolatot kell megtartani a meglévő helyett
  function preferNew(existing, existingInit, newInit) {
    return isDead(existing) || newInit < existingInit;
  }

  function adoptConn(conn, outgoing) {
    if (!conn) return;
    const p = ensurePeer(conn.peer, outgoing ? null : conn.metadata?.user, outgoing ? null : conn.metadata?.state);
    const init = outgoing ? call.peerId : conn.peer;
    if (p.conn && p.conn !== conn) {
      if (!preferNew(p.conn, p.connInit, init)) return conn.close();
      const old = p.conn;
      p.conn = null;
      old.close();
    }
    p.conn = conn;
    p.connInit = init;
    conn.on('open', () => {
      if (p.conn !== conn) return;
      conn.send({ type: 'hello', user: S.user, state: localState() });
    });
    conn.on('data', (d) => p.conn === conn && onData(p, d));
    conn.on('close', () => {
      conn._dead = true;
      if (p.conn === conn) scheduleRemove(p);
    });
    conn.on('error', () => (conn._dead = true));
  }

  function adoptMedia(mc, outgoing) {
    if (!mc) return;
    const p = ensurePeer(mc.peer, outgoing ? null : mc.metadata?.user, outgoing ? null : mc.metadata?.state);
    const init = outgoing ? call.peerId : mc.peer;
    if (p.media && p.media !== mc) {
      if (!preferNew(p.media, p.mediaInit, init)) return mc.close();
      const old = p.media;
      p.media = null;
      old.close();
    }
    p.media = mc;
    p.mediaInit = init;
    if (!outgoing) mc.answer(outStream());

    const video = $('video', p.tile);
    mc.on('stream', (stream) => {
      if (p.media !== mc) return;
      video.srcObject = stream;
      video.play().catch(() => {});
      const audio = stream.getAudioTracks()[0];
      if (audio) watchLevel(`peer:${p.id}`, audio, (lvl) => setSpeaking(p.tile, p.state.mic && lvl > 0.03));
    });
    mc.on('close', () => {
      mc._dead = true;
      if (p.media === mc) scheduleRemove(p);
    });
    mc.on('error', () => (mc._dead = true));
    mc.peerConnection?.addEventListener('connectionstatechange', () => {
      if (p.media !== mc) return;
      paintPeer(p);
      // végleg megszakadt: eldobjuk, a következő szívverés újraépíti
      if (mc.peerConnection.connectionState === 'failed') {
        mc._dead = true;
        mc.close();
      }
    });
    paintPeer(p);
  }

  // A kapcsolat bezárult – ha pár másodpercen belül nem épül újra, eltávolítjuk
  function scheduleRemove(p) {
    clearTimeout(p.removeTimer);
    p.removeTimer = setTimeout(() => {
      if (isDead(p.conn) && isDead(p.media)) removePeer(p.id, true);
      else paintPeer(p);
    }, 4000);
    paintPeer(p);
  }

  function onData(p, d) {
    if (!d || typeof d !== 'object') return;
    if (d.type === 'hello' || d.type === 'state') {
      const startedScreen = d.state?.screen && !p.state.screen;
      p.state = { mic: !!d.state?.mic, cam: !!d.state?.cam, screen: !!d.state?.screen };
      if (d.type === 'hello' && d.user) {
        const first = !p.greeted;
        p.user = d.user;
        p.greeted = true;
        $('.nm', p.tile).textContent = d.user.name;
        $('.role', p.tile).textContent = d.user.role;
        $('.tile-avatar', p.tile).innerHTML = avatar(d.user);
        if (first) toast(`${avatar(d.user)}<span><b>${esc(d.user.name)}</b> csatlakozott</span>`);
      }
      paintPeer(p);
      renderPeople();
      layout();
      if (startedScreen) toast(`${avatar(p.user)}<span><b>${esc(p.user.name)}</b> megosztja a képernyőjét</span>`);
    } else if (d.type === 'chat' && d.msg) {
      onChat(d.msg);
    } else if (d.type === 'reaction' && typeof d.emoji === 'string') {
      floatEmoji(p.tile, d.emoji.slice(0, 8));
    } else if (d.type === 'bye') {
      removePeer(p.id, true);
    }
  }

  function broadcast(msg) {
    for (const p of call.peers.values()) {
      if (p.conn?.open) {
        try {
          p.conn.send(msg);
        } catch {}
      }
    }
  }

  function paintPeer(p) {
    paintTile(p.tile, p.state);
    const st = p.media?.peerConnection?.connectionState;
    if (isDead(p.media) && isDead(p.conn)) setBadge(p.tile, 'Kapcsolat megszakadt…', 'warn');
    else if (st === 'failed') setBadge(p.tile, 'Kapcsolat sikertelen', 'warn');
    else if (st === 'disconnected') setBadge(p.tile, 'Kapcsolat akadozik…', 'warn');
    else if (st !== 'connected') setBadge(p.tile, 'Kapcsolódás…');
    else setBadge(p.tile, p.state.screen ? `${icon('screen')}Képernyőt oszt meg` : '');
  }

  function removePeer(id, announce) {
    const p = call.peers.get(id);
    if (!p) return;
    call.peers.delete(id);
    clearTimeout(p.removeTimer);
    unwatch(`peer:${id}`);
    for (const c of [p.conn, p.media]) {
      if (c) {
        c._dead = true;
        try {
          c.close();
        } catch {}
      }
    }
    p.tile.remove();
    if (announce && p.greeted) toast(`${avatar(p.user)}<span><b>${esc(p.user.name)}</b> kilépett</span>`);
    renderPeople();
    layout();
  }

  // --- Vezérlők --------------------------------------------------------------
  $('#ctl-mic').addEventListener('click', () => setMic(!micOn()));
  $('#ctl-cam').addEventListener('click', () => setCam(!camOn()));
  $('#ctl-screen').addEventListener('click', toggleScreen);
  $('#ctl-leave').addEventListener('click', () => leaveCall());
  $('#ctl-chat').addEventListener('click', () => toggleSide('chat'));
  $('#ctl-people').addEventListener('click', () => toggleSide('people'));
  $('#ctl-files').addEventListener('click', () => toggleSide('files'));
  $('#btn-side-close').addEventListener('click', () => setSide(false));
  $('#btn-copy-room').addEventListener('click', async () => {
    await copyText(roomUrl(call.id));
    toast(`${icon('check')} Meghívó link a vágólapon`);
  });

  $('#ctl-react').addEventListener('click', (e) => {
    e.stopPropagation();
    $('#react-pop').hidden = !$('#react-pop').hidden;
  });
  $('#react-pop').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const emoji = btn.textContent;
    broadcast({ type: 'reaction', emoji });
    floatEmoji(call.localTile, emoji);
    $('#react-pop').hidden = true;
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.react-wrap')) $('#react-pop').hidden = true;
  });

  function floatEmoji(tile, emoji) {
    if (!tile) return;
    const el = document.createElement('div');
    el.className = 'float-emoji';
    el.textContent = emoji;
    el.style.left = `${20 + Math.random() * 60}%`;
    tile.append(el);
    setTimeout(() => el.remove(), 2500);
  }

  document.addEventListener('keydown', (e) => {
    if (!call.id || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target.closest('input, textarea, select')) return;
    const k = e.key.toLowerCase();
    if (k === 'm') setMic(!micOn());
    else if (k === 'v') setCam(!camOn());
    else if (k === 's') toggleScreen();
    else if (k === 'escape') setSide(false);
  });

  // --- Oldalpanel ------------------------------------------------------------
  function setSide(open, tab = call.tab) {
    call.sideOpen = open;
    call.tab = tab;
    $('#side').hidden = !open;
    $$('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
    $$('.tab-pane').forEach((p) => (p.hidden = p.dataset.pane !== tab));
    $('#ctl-chat').classList.toggle('active', open && tab === 'chat');
    $('#ctl-people').classList.toggle('active', open && tab === 'people');
    $('#ctl-files').classList.toggle('active', open && tab === 'files');
    if (open && tab === 'chat') {
      call.unread = 0;
      paintUnread();
      scrollMessages();
      if (window.innerWidth > 900) setTimeout(() => $('#chat-input').focus(), 50);
    }
    requestAnimationFrame(layout);
  }

  function toggleSide(tab) {
    setSide(!(call.sideOpen && call.tab === tab), tab);
  }

  $('.tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) setSide(true, b.dataset.tab);
  });

  function paintUnread() {
    const b = $('#chat-badge');
    b.hidden = !call.unread;
    b.textContent = call.unread > 9 ? '9+' : call.unread;
  }

  function renderPeople() {
    const entries = [
      { user: S.user, state: localState(), me: true },
      ...[...call.peers.values()].map((p) => ({ user: p.user, state: p.state })),
    ];
    $('#people-count').textContent = `(${entries.length})`;
    $('#people-list').innerHTML = entries
      .map(
        ({ user, state, me }) => `<div class="team-member">
          ${avatar(user)}
          <div class="who"><div class="name">${esc(user.name)}${me ? ' <span class="muted">(te)</span>' : ''}</div>
          <div class="status">${esc(user.role)}</div></div>
          <div class="icons">
            ${state.screen ? icon('screen') : ''}
            ${icon(state.cam ? 'cam' : 'cam-off', state.cam ? '' : 'off')}
            ${icon(state.mic ? 'mic' : 'mic-off', state.mic ? '' : 'off')}
          </div>
        </div>`
      )
      .join('');
  }

  // --- Chat ------------------------------------------------------------------
  function onChat(msg) {
    if (!call.id || call.msgIds.has(msg.id)) return;
    addMessage(msg, true);
    renderFiles();
    const mine = msg.user.id === S.user.id;
    if (!mine && !(call.sideOpen && call.tab === 'chat')) {
      call.unread++;
      paintUnread();
      const preview = msg.type === 'file' ? `📎 ${msg.file.name}` : msg.text;
      toast(`${avatar(msg.user)}<span><b>${esc(msg.user.name)}:</b> ${esc(preview.slice(0, 80))}</span>`, {
        onClick: () => setSide(true, 'chat'),
      });
    }
  }

  function fileExt(name) {
    const m = /\.([a-z0-9]{1,5})$/i.exec(name);
    return m ? m[1] : 'fájl';
  }

  function fileCardHtml(f) {
    return `<div class="file-card">
      <div class="fi">${esc(fileExt(f.name))}</div>
      <div class="fmeta"><div class="fname" title="${esc(f.name)}">${esc(f.name)}</div><div class="fsize">${formatSize(f.size)}</div></div>
      <a class="icon-btn" href="${esc(f.downloadUrl || f.url)}" download="${esc(f.name)}" target="_blank" rel="noopener" title="Letöltés">${icon('download')}</a>
    </div>`;
  }

  function messageBodyHtml(msg) {
    if (msg.type !== 'file') return `<div class="bubble">${linkify(msg.text)}</div>`;
    const f = msg.file;
    if (/^image\//.test(f.mime)) {
      return `<img class="file-thumb" src="${esc(f.url)}" alt="${esc(f.name)}" loading="lazy" data-full="${esc(f.url)}" />${fileCardHtml(f)}`;
    }
    return fileCardHtml(f);
  }

  function addMessage(msg, live) {
    if (call.msgIds.has(msg.id)) return;
    call.msgIds.add(msg.id);
    call.messages.push(msg);
    const box = $('#messages');
    $('.msg-empty', box)?.remove();
    const ts = new Date(msg.ts);
    const last = call.lastGroup;
    const stickToBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;

    if (last && last.userId === msg.user.id && ts - last.ts < 5 * 60000) {
      last.stack.insertAdjacentHTML('beforeend', messageBodyHtml(msg));
      last.ts = ts;
    } else {
      const mine = msg.user.id === S.user.id;
      const g = document.createElement('div');
      g.className = `msg-group ${mine ? 'mine' : ''}`;
      const day = sameDay(ts, new Date()) ? '' : `${monthFmt.format(ts)} ${ts.getDate()}. `;
      g.innerHTML = `${avatar(msg.user)}<div class="msg-stack">
        <div class="msg-head"><b>${mine ? 'Te' : esc(msg.user.name)}</b>${day}${hm(ts)}</div>
        ${messageBodyHtml(msg)}</div>`;
      box.append(g);
      call.lastGroup = { userId: msg.user.id, ts, stack: $('.msg-stack', g) };
    }
    if (!live || stickToBottom || msg.user.id === S.user.id) scrollMessages();
  }

  // Előzmények betöltése, illetve ami az adatcsatornán esetleg elveszett
  async function syncMessages() {
    const roomId = call.id;
    try {
      const since = Math.max(0, call.messages.length - 20);
      const list = await api(`/api/rooms/${roomId}/messages?since=${since}`);
      if (call.id !== roomId) return;
      const first = !call.messages.length;
      list.forEach((m) => (first ? addMessage(m, false) : onChat(m)));
      renderFiles();
    } catch {}
  }

  async function postMessage(body) {
    const msg = await api(`/api/rooms/${call.id}/messages`, { method: 'POST', body });
    onChat(msg);
    broadcast({ type: 'chat', msg });
    return msg;
  }

  function renderMessagesEmpty() {
    if (!call.messages.length) {
      $('#messages').innerHTML = `<div class="msg-empty">${icon('chat')}<br />Még nincs üzenet.<br />Írj valamit, vagy húzz ide egy fájlt.</div>`;
    }
  }

  function scrollMessages() {
    const box = $('#messages');
    requestAnimationFrame(() => (box.scrollTop = box.scrollHeight));
  }

  $('#messages').addEventListener('click', (e) => {
    const img = e.target.closest('.file-thumb');
    if (!img) return;
    const lb = document.createElement('div');
    lb.className = 'lightbox';
    lb.innerHTML = `<img src="${img.dataset.full}" alt="" />`;
    lb.addEventListener('click', () => lb.remove());
    document.body.append(lb);
  });
  // képek betöltése után görgessünk le
  $('#messages').addEventListener('load', (e) => e.target.matches('.file-thumb') && scrollMessages(), true);

  function renderFiles() {
    const files = call.messages.filter((m) => m.type === 'file').reverse();
    $('#files-count').textContent = files.length ? `(${files.length})` : '';
    $('#files-list').innerHTML = files.length
      ? files
          .map((m) => `<div><div class="who">${esc(m.user.name)} · ${hm(new Date(m.ts))}</div>${fileCardHtml(m.file)}</div>`)
          .join('')
      : '<div class="msg-empty">Még nem osztottatok meg fájlt.</div>';
  }

  const input = $('#chat-input');
  function autosize() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
  }
  input.addEventListener('input', autosize);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      $('#composer').requestSubmit();
    }
  });
  input.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) {
      e.preventDefault();
      files.forEach(uploadFile);
    }
  });
  $('#composer').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    autosize();
    postMessage({ type: 'text', text }).catch((err) => {
      input.value = text;
      autosize();
      toast(esc(err.message), { type: 'error' });
    });
  });

  // --- Fájlfeltöltés ---------------------------------------------------------
  $('#btn-attach').addEventListener('click', () => $('#file-input').click());
  $('#file-input').addEventListener('change', (e) => {
    [...e.target.files].forEach(uploadFile);
    e.target.value = '';
  });

  async function uploadFile(file) {
    if (!call.id) return;
    if (S.config.storage === 'none') {
      return toast('A fájlmegosztáshoz kapcsold be a Vercel Blobot (Storage → Blob → Connect).', { type: 'error', ms: 7000 });
    }
    const max = S.config.maxUploadMb * 1024 * 1024;
    if (file.size > max) return toast(`${esc(file.name)} túl nagy (max ${S.config.maxUploadMb} MB).`, { type: 'error' });

    if (!call.sideOpen || call.tab !== 'chat') setSide(true, 'chat');
    const row = document.createElement('div');
    row.className = 'upload-row';
    row.innerHTML = `<div>Feltöltés: <b>${esc(file.name)}</b> · <span class="pct">0%</span></div><div class="bar"><i></i></div>`;
    $('#uploads').append(row);
    const progress = (pct) => {
      $('.bar i', row).style.width = `${pct}%`;
      $('.pct', row).textContent = `${Math.round(pct)}%`;
    };

    try {
      const stored = S.config.storage === 'blob' ? await uploadToBlob(file, progress) : await uploadLocal(file, progress);
      await postMessage({
        type: 'file',
        file: { name: file.name, size: file.size, mime: file.type, url: stored.url, downloadUrl: stored.downloadUrl },
      });
    } catch (err) {
      toast(esc(err.message || 'Feltöltési hiba.'), { type: 'error' });
    } finally {
      row.remove();
    }
  }

  // Vercel Blob: a fájl közvetlenül a tárhelyre megy, a szerver csak engedélyt ad
  async function uploadToBlob(file, progress) {
    const safe = file.name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w.-]+/g, '_') || 'fajl';
    const blob = await VercelBlob.upload(`${call.id}/${safe}`, file, {
      access: 'public',
      handleUploadUrl: '/api/upload',
      clientPayload: S.token,
      contentType: file.type || undefined,
      multipart: file.size > 20 * 1024 * 1024,
      onUploadProgress: ({ percentage }) => progress(percentage),
    });
    return { url: blob.url, downloadUrl: blob.downloadUrl };
  }

  function uploadLocal(file, progress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `/api/local-upload?name=${encodeURIComponent(file.name)}`);
      xhr.setRequestHeader('Authorization', `Bearer ${S.token}`);
      xhr.upload.onprogress = (e) => e.lengthComputable && progress((e.loaded / e.total) * 100);
      xhr.onload = () => {
        let data = {};
        try {
          data = JSON.parse(xhr.responseText);
        } catch {}
        if (xhr.status >= 300) reject(new Error(data.error || 'Feltöltési hiba.'));
        else resolve(data);
      };
      xhr.onerror = () => reject(new Error('Feltöltési hiba – ellenőrizd a kapcsolatot.'));
      xhr.send(file);
    });
  }

  // Húzd és ejtsd az egész hívás ablakra
  let dragDepth = 0;
  const roomView = $('#view-room');
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  roomView.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    $('#drop-overlay').hidden = false;
  });
  roomView.addEventListener('dragover', (e) => hasFiles(e) && e.preventDefault());
  roomView.addEventListener('dragleave', () => {
    if (--dragDepth <= 0) {
      dragDepth = 0;
      $('#drop-overlay').hidden = true;
    }
  });
  roomView.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    $('#drop-overlay').hidden = true;
    [...(e.dataTransfer?.files || [])].forEach(uploadFile);
  });

  window.addEventListener('resize', () => call.id && layout());

  // =========================================================================
  // Indulás
  // =========================================================================
  (async function boot() {
    try {
      S.config = await api('/api/config');
    } catch {}
    if (!S.token) return showAuth();
    try {
      const { user } = await api('/api/me');
      setSession({ token: S.token, user });
    } catch {
      showAuth();
    }
  })();
})();
