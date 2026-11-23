/*
 * Darts Counter – Oberfläche
 * Nachbau der SwiftUI-Bildschirme.
 *
 * Zwei Betriebsarten (body data-mode):
 *  - guest   (darts.pfleger.work/):     feste Spieler „Spieler 1–3“, nichts wird gespeichert, auch nicht im Browser.
 *  - friends (darts.pfleger.work/app/): hinter Cloudflare Access; gemeinsame Daten liegen in D1 (über /api),
 *            der Browser hält nur eine Arbeitskopie und eine Warteschlange für noch nicht gesendete Änderungen.
 */
(function () {
  'use strict';
  const D = window.Darts;
  const app = document.getElementById('app');

  // ================================================================ Speicher

  const MODE = document.body.dataset.mode === 'friends' ? 'friends' : 'guest';
  const GUEST = MODE === 'guest', FRIENDS = !GUEST;

  const KEY_DATA = 'darts.friends.data.v1', KEY_PREFS = 'darts.friends.prefs.v1', KEY_ACTIVE = 'darts.friends.active.v1', KEY_PENDING = 'darts.friends.pending.v1';
  // Im Gastmodus wird nichts dauerhaft abgelegt: alles lebt nur im Arbeitsspeicher dieser Seite.
  const LS = GUEST ? { get(k, def) { return def; }, set() {}, del() {} } : {
    get(k, def) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : def; } catch (e) { return def; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* Speicher nicht verfügbar */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* egal */ } }
  };
  // Reste der ersten Version (Daten lagen damals ohne Anmeldung im Browser) entfernen.
  try { ['darts.data.v1', 'darts.prefs.v1', 'darts.active.v1'].forEach((k) => localStorage.removeItem(k)); } catch (e) { /* egal */ }
  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID().toUpperCase();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    }).toUpperCase();
  }

  const GUEST_PLAYERS = [1, 2, 3].map((n) => ({ uuid: 'GAST-' + n, name: 'Spieler ' + n, colorIndex: n - 1, createdAt: '2000-01-01T00:00:0' + n + '.000Z' }));
  const db = GUEST ? { players: GUEST_PLAYERS.map((p) => Object.assign({}, p)), games: [], trainings: [] }
    : Object.assign({ players: [], games: [], trainings: [] }, LS.get(KEY_DATA, {}));
  const prefs = deepMerge({
    game: { variant: 'x01', killerLives: 3, startScore: 501, legsToWin: 1, randomOrder: false, selected: GUEST ? ['GAST-1', 'GAST-2'] : [] },
    trainingPlayer: '',
    checkout: { targetCount: 10, dartsPerTarget: 3, maxScore: 120 },
    clockVariant: 'single',
    deviceName: ''
  }, LS.get(KEY_PREFS, {}));
  // Ein- und Ausstiegsregel; alte Einstellungen (doubleOut/masterIn) werden übernommen.
  Object.assign(prefs.game, D.rules(prefs.game));
  delete prefs.game.doubleOut; delete prefs.game.masterIn;
  function deepMerge(base, over) {
    for (const k in over) {
      if (over[k] && typeof over[k] === 'object' && !Array.isArray(over[k]) && base[k] && typeof base[k] === 'object') deepMerge(base[k], over[k]);
      else base[k] = over[k];
    }
    return base;
  }
  const saveDb = () => { if (GUEST) return; LS.set(KEY_DATA, db); Sync.track(); };
  const savePrefs = () => LS.set(KEY_PREFS, prefs);

  const playersSorted = () => db.players.slice().sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const playerById = (id) => db.players.find((p) => p.uuid === id);
  const asMatchPlayer = (p) => ({ id: p.uuid, name: p.name, colorIndex: p.colorIndex });
  const gamesSorted = () => db.games.slice().sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const trainingsSorted = () => db.trainings.slice().sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const sortedResults = (g) => (g.results || []).slice().sort((a, b) => a.order - b.order);

  // ================================================================ Gemeinsame Daten (nur Freunde-Bereich)

  const KINDS = ['players', 'games', 'trainings'];
  const Sync = {
    state: 'idle',       // idle | syncing | offline | loggedOut | notMember | error
    joinError: '',
    joining: false,
    email: '',
    known: {},           // "kind/uuid" -> JSON des zuletzt bekannten Stands
    pending: LS.get(KEY_PENDING, {}), // "kind/uuid" -> Datensatz oder null (= löschen)
    timer: null,
    busy: false,
    loaded: false,

    snapshot() {
      const m = {};
      for (const k of KINDS) for (const r of db[k]) if (r && r.uuid) m[k + '/' + r.uuid] = JSON.stringify(r);
      return m;
    },
    // Nach jeder lokalen Änderung: Unterschiede zum letzten Stand in die Warteschlange legen.
    track() {
      if (GUEST) return;
      const now = this.snapshot();
      for (const key in now) if (now[key] !== this.known[key]) this.pending[key] = JSON.parse(now[key]);
      for (const key in this.known) if (!(key in now)) this.pending[key] = null;
      this.known = now;
      LS.set(KEY_PENDING, this.pending);
      this.schedule(300);
    },
    schedule(ms) { clearTimeout(this.timer); this.timer = setTimeout(() => this.run(), ms); },
    async request(method, path, body) {
      const res = await fetch(path, {
        method: method, credentials: 'same-origin', redirect: 'manual', cache: 'no-store',
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined
      });
      // Abgelaufene Anmeldung: Cloudflare Access leitet zur Login-Seite um.
      if (res.type === 'opaqueredirect' || res.status === 401) { const e = new Error('login'); e.login = true; throw e; }
      let data = null;
      try { data = await res.json(); } catch (err) { /* keine JSON-Antwort */ }
      if (res.status === 403 && data && data.error === 'not_member') { const e = new Error('member'); e.notMember = true; this.email = data.email || ''; throw e; }
      if (res.status === 403 && !data) { const e = new Error('login'); e.login = true; throw e; }
      if (!res.ok) { const e = new Error((data && data.message) || 'HTTP ' + res.status); e.status = res.status; e.data = data; throw e; }
      return data;
    },
    async push() {
      const keys = Object.keys(this.pending);
      for (let i = 0; i < keys.length; i += 200) {
        const chunk = keys.slice(i, i + 200);
        const sent = {};
        const ops = chunk.map((key) => {
          const cut = key.indexOf('/');
          sent[key] = JSON.stringify(this.pending[key]);
          return { kind: key.slice(0, cut), uuid: key.slice(cut + 1), data: this.pending[key] };
        });
        await this.request('POST', '/api/sync', { ops: ops });
        // Nur entfernen, was sich seit dem Senden nicht erneut geändert hat.
        for (const key of chunk) if (JSON.stringify(this.pending[key]) === sent[key]) delete this.pending[key];
        LS.set(KEY_PENDING, this.pending);
      }
    },
    async pull() {
      const data = await this.request('GET', '/api/data');
      this.email = data.email || '';
      for (const k of KINDS) db[k] = Array.isArray(data[k]) ? data[k] : [];
      // Noch nicht gesendete eigene Änderungen wieder obendrauf legen.
      for (const key in this.pending) {
        const cut = key.indexOf('/'), k = key.slice(0, cut), id = key.slice(cut + 1);
        db[k] = db[k].filter((r) => r.uuid !== id);
        if (this.pending[key]) db[k].push(this.pending[key]);
      }
      this.known = this.snapshot();
      LS.set(KEY_DATA, db);
      this.loaded = true;
    },
    async run() {
      if (GUEST || this.busy) return;
      this.busy = true;
      const before = this.state;
      this.state = 'syncing';
      try {
        await this.push();
        await this.pull();
        this.state = 'idle';
      } catch (e) {
        this.state = e.login ? 'loggedOut' : e.notMember ? 'notMember' : (navigator.onLine === false || e instanceof TypeError ? 'offline' : 'error');
        if (!e.login && !e.notMember) this.schedule(20000);
      }
      this.busy = false;
      if (Object.keys(this.pending).length && this.state === 'idle') this.schedule(500);
      // Neu zeichnen, aber kein Eingabefeld oder Dialog stören.
      const typing = document.activeElement && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
      if ((!ui.dialog && !typing) || before !== this.state && (before === 'notMember' || this.state === 'notMember')) render();
      else if (before !== this.state) { const el = document.getElementById('syncState'); if (el) el.outerHTML = syncBadge(); }
    }
  };
  if (FRIENDS) {
    Sync.known = Sync.snapshot();
    // Änderungen, die vor dem letzten Schließen noch nicht gesendet waren, sind schon in `pending`.
    for (const key in Sync.pending) delete Sync.known[key];
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') Sync.schedule(0); });
    window.addEventListener('online', () => Sync.schedule(0));
    setInterval(() => { if (document.visibilityState === 'visible' && !ui.game) Sync.schedule(0); }, 60000);
  }

  function syncBadge() {
    if (GUEST) return '';
    const n = Object.keys(Sync.pending).length;
    const txt = { notMember: 'Noch nicht freigeschaltet', idle: n ? 'Wird gespeichert …' : 'Gespeichert', syncing: 'Wird abgeglichen …', offline: 'Offline' + (n ? ' · ' + n + ' Änderung' + (n === 1 ? '' : 'en') + ' warten' : ''), loggedOut: 'Anmeldung abgelaufen', error: 'Server nicht erreichbar' }[Sync.state];
    return '<span id="syncState" class="sync-state s-' + Sync.state + '">' + esc(txt) + '</span>';
  }

  // ================================================================ Format

  const nf2 = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const nf1 = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const Fmt = {
    avg: (v) => nf2.format(v),
    rate: (h, a) => a > 0 ? nf1.format(h / a * 100) + ' %' : '–',
    percent: (h, a) => a > 0 ? nf1.format(h / a * 100) + ' % (' + h + '/' + a + ')' : '–',
    orDash: (v) => v > 0 ? String(v) : '–',
    date: (iso) => new Date(iso).toLocaleString('de-DE', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }),
    day: (iso) => new Date(iso).toLocaleDateString('de-DE', { day: 'numeric', month: 'short', year: 'numeric' })
  };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const COLORS = ['#ff3b30', '#007aff', '#34c759', '#ff9500', '#af52de', '#ff2d55', '#30b0c7', '#5856d6'];
  const pcolor = (i) => COLORS[((i % COLORS.length) + COLORS.length) % COLORS.length];
  const avatar = (name, ci, small) => '<span class="avatar' + (small ? ' s' : '') + '" style="--pc:' + pcolor(ci) + '" aria-hidden="true">' + esc(String(name || '?').trim().charAt(0).toUpperCase() || '?') + '</span>';

  // ================================================================ Icons

  const P = {
    target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/>',
    scope: '<circle cx="12" cy="12" r="8"/><path d="M12 2v5M12 17v5M2 12h5M17 12h5"/>',
    people: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.6 3.2-5.5 6.5-5.5s5.9 1.9 6.5 5.5"/><circle cx="17" cy="9" r="2.8"/><path d="M16.5 14.6c2.7.2 4.4 2 4.9 5"/>',
    chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    personPlus: '<circle cx="10" cy="8" r="3.5"/><path d="M3.5 20c.6-3.6 3.2-5.5 6.5-5.5 1.6 0 3 .4 4.1 1.2M18 13v6M15 16h6"/>',
    undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>',
    trophy: '<path d="M7 4h10v5a5 5 0 0 1-10 0V4Z" fill="currentColor"/><path d="M7 6H4v1.5A3.5 3.5 0 0 0 7.5 11M17 6h3v1.5a3.5 3.5 0 0 1-3.5 3.5M12 14v4M8 20h8"/>',
    check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    x: '<path d="M6 6l12 12M18 6 6 18"/>',
    play: '<path d="M7 4.5v15l12-7.5-12-7.5Z" fill="currentColor"/>',
    shuffle: '<path d="M3 7h3.5c4.5 0 6.5 10 11 10H21M3 17h3.5c1.8 0 3-1.6 4.1-3.5M13.4 10.5C14.5 8.6 15.7 7 17.5 7H21M18 4l3 3-3 3M18 14l3 3-3 3"/>',
    sync: '<path d="M20 11a8 8 0 0 0-14.5-4.5L4 8M4 4v4h4M4 13a8 8 0 0 0 14.5 4.5L20 16M20 20v-4h-4"/>',
    trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
    minus: '<circle cx="12" cy="12" r="10" fill="currentColor" stroke="none"/><path d="M7.5 12h9" stroke="#fff" stroke-width="2.4"/>',
    plusc: '<circle cx="12" cy="12" r="10" fill="currentColor" stroke="none"/><path d="M12 7.5v9M7.5 12h9" stroke="#fff" stroke-width="2.4"/>',
    chevR: '<path d="m9 5 7 7-7 7"/>',
    chevL: '<path d="m15 5-7 7 7 7"/>',
    up: '<path d="m6 15 6-6 6 6"/>',
    down: '<path d="m6 9 6 6 6-6"/>',
    flag: '<path d="M5 21V4M5 4h13l-2.5 4L18 12H5"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
    n27: '<circle cx="12" cy="12" r="9.5"/><text x="12" y="16" text-anchor="middle" font-size="10" font-weight="700" fill="currentColor" stroke="none" font-family="system-ui">27</text>',
    q: '<path d="M9.2 9a3 3 0 1 1 4.3 2.7c-.9.4-1.5 1.2-1.5 2.2v.6"/><circle cx="12" cy="18" r=".9" fill="currentColor"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>',
    arrowUR: '<path d="M7 17 17 7M8 7h9v9"/>',
    arrowDR: '<path d="M7 7l10 10M17 8v9H8"/>',
    arrowR: '<path d="M4 12h15M13 6l6 6-6 6"/>',
    mastersIn: '<path d="M3 12h12M10 7l5 5-5 5M20 4v16"/>',
    download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
    upload: '<path d="M12 20V9M7 14l5-5 5 5M5 4h14"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
    wand: '<path d="m4 20 11-11M14 4v3M12.5 5.5h3M19 9v3M17.5 10.5h3"/>',
    slider: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
    refresh: '<path d="M20 12a8 8 0 1 1-2.3-5.7L20 8.5M20 4v4.5h-4.5"/>',
    half: '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18Z" fill="currentColor"/>',
    medal: '<circle cx="12" cy="15" r="5.5"/><path d="M8.5 3h7l-2 7.2M8.5 3l2 7.2"/><path d="m12 12.6.9 1.6 1.8.3-1.3 1.2.3 1.8-1.7-.9-1.7.9.3-1.8-1.3-1.2 1.8-.3Z" fill="currentColor" stroke="none"/>',
    heart: '<path d="M12 20s-7.5-4.6-7.5-10A4.3 4.3 0 0 1 12 7.4 4.3 4.3 0 0 1 19.5 10c0 5.4-7.5 10-7.5 10Z" fill="currentColor"/>',
    dart: '<path d="M21 3l-5.5 1.8 3.7 3.7Z" fill="currentColor"/><path d="M17.3 6.7 6.5 17.5"/><path d="M6.5 17.5H3l2-2M6.5 17.5V21l2-2"/>',
    octagon: '<path d="M8 3h8l5 5v8l-5 5H8l-5-5V8l5-5Z"/><path d="m9 9 6 6M15 9l-6 6"/>'
  };
  const icon = (n, cls) => '<svg class="i' + (cls ? ' ' + cls : '') + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + P[n] + '</svg>';
  const MODE_ICON = { checkout: 'flag', aroundTheClock: 'clock', bobs27: 'n27', halveIt: 'half', jdc: 'medal' };
  const TRAINING_ORDER = ['checkout', 'aroundTheClock', 'bobs27', 'halveIt', 'jdc'];
  const VARIANTS = [['x01', 'X01'], ['cricket', 'Cricket'], ['killer', 'Killer']];
  /** Titel eines gespeicherten Spiels für Verlauf und Statistik */
  const gameTitle = (g) => g.variant === 'cricket' ? 'Cricket' : g.variant === 'killer' ? 'Killer · ' + (g.lives || 3) + ' Leben' : D.settingsTitle(g);

  // ================================================================ UI-Zustand

  const ui = {
    tab: 'play',
    stacks: { play: [{ v: 'newGame' }], training: [{ v: 'trainingMenu' }], players: [{ v: 'players' }], history: [{ v: 'history' }] },
    sheet: null,
    dialog: null,
    game: null,
    party: null,
    mult: 1,
    historyTab: 'games',
    toast: null
  };
  const route = () => { const s = ui.stacks[ui.tab]; return s[s.length - 1]; };
  const push = (r) => { ui.stacks[ui.tab].push(r); window.scrollTo(0, 0); render(); };
  const pop = () => { const s = ui.stacks[ui.tab]; if (s.length > 1) s.pop(); render(); };

  let toastTimer = null;
  function toast(text) {
    ui.toast = text;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { ui.toast = null; render(); }, 3200);
    render();
  }
  function buzz() { try { if (navigator.vibrate) navigator.vibrate(8); } catch (e) { /* egal */ } }

  // ================================================================ Bausteine

  function header(title, opts) {
    opts = opts || {};
    const stack = ui.stacks[ui.tab];
    const back = stack.length > 1 ? '<button class="back" data-a="back">' + icon('chevL') + esc(opts.backLabel || 'Zurück') + '</button>' : '';
    const left = opts.left || '';
    const right = opts.right || '';
    const small = stack.length > 1;
    return '<div class="header">' + back + left + '<span class="spacer"></span>' + right + '</div>' +
      '<div class="title-row"><h1' + (small ? ' class="sm"' : '') + '>' + esc(title) + '</h1></div>';
  }

  const section = (head, body, foot) =>
    '<div class="section">' + (head ? '<div class="section-head">' + head + '</div>' : '') +
    '<div class="card">' + body + '</div>' + (foot ? '<div class="section-foot">' + foot + '</div>' : '') + '</div>';

  const statRow = (label, value) => '<div class="row"><span class="label">' + esc(label) + '</span><span class="value">' + esc(value) + '</span></div>';

  const toggle = (id, label, checked, change, ico) =>
    '<label class="row" for="' + id + '">' + (ico ? '<span class="mode-icon" style="width:auto">' + icon(ico) + '</span>' : '') +
    '<span class="grow">' + esc(label) + '</span><span class="switch"><input type="checkbox" id="' + id + '" data-c="' + change + '"' + (checked ? ' checked' : '') + '><span></span></span></label>';

  const selectRow = (id, label, value, options, change) =>
    '<div class="row"><label class="grow" for="' + id + '">' + esc(label) + '</label><select class="plain" id="' + id + '" data-c="' + change + '">' +
    options.map((o) => '<option value="' + esc(o[0]) + '"' + (String(o[0]) === String(value) ? ' selected' : '') + '>' + esc(o[1]) + '</option>').join('') + '</select></div>';

  const segmented = (items, current, action) =>
    '<div class="segmented" role="group">' + items.map((it) => '<button data-a="' + action + '" data-v="' + esc(it[0]) + '" aria-pressed="' + (it[0] === current) + '">' + esc(it[1]) + '</button>').join('') + '</div>';

  function visitSlots(darts) {
    let h = '<div class="slots">';
    for (let i = 0; i < 3; i++) h += '<div class="slot">' + (i < darts.length ? esc(D.label(darts[i])) : '–') + '</div>';
    return h + '<div class="total">' + D.sum(darts) + '</div></div>';
  }
  const checkoutHint = (darts) => darts ? '<div class="hint">' + icon('flag') + 'Finish: ' + darts.map(D.label).join(' · ') + '</div>' : '';

  function keypad(opts) {
    const m = ui.mult;
    const cls = m === 2 ? 'k-double' : m === 3 ? 'k-triple' : 'k-single';
    const lab = (n) => m === 1 ? String(n) : (m === 2 ? 'D' : 'T') + n;
    const dis = opts.disabled ? ' disabled' : '';
    let h = '<div class="keypad">';
    h += '<div class="mods"><button class="key mod k-double' + (m === 2 ? ' on' : '') + '" data-a="mult" data-v="2"' + dis + '>Double</button>' +
      '<button class="key mod k-triple' + (m === 3 ? ' on' : '') + '" data-a="mult" data-v="3"' + dis + '>Triple</button></div>';
    h += '<div class="grid">';
    for (let n = 1; n <= 20; n++) h += '<button class="key ' + cls + '" data-a="dart" data-v="' + n + '"' + dis + '>' + lab(n) + '</button>';
    h += '</div><div class="bottom">';
    h += '<button class="key ' + cls + '" data-a="dart" data-v="25"' + (m === 3 || opts.disabled ? ' disabled' : '') + '>' + (m === 2 ? 'Bull' : '25') + '</button>';
    h += '<button class="key k-gray" data-a="dart" data-v="0"' + dis + '>Miss</button>';
    h += '<button class="key k-undo" data-a="undo" aria-label="Rückgängig"' + (opts.canUndo && !opts.disabled ? '' : ' disabled') + '>' + icon('undo') + '</button>';
    return h + '</div></div>';
  }

  function emptyState(ico, title, text, extra) {
    return '<div class="empty-state">' + icon(ico) + '<h2>' + esc(title) + '</h2><p>' + esc(text) + '</p>' + (extra || '') + '</div>';
  }

  // ================================================================ Neues Spiel

  const SCORES = [101, 201, 301, 401, 501, 601, 701, 801, 901];
  const selectedPlayers = () => prefs.game.selected.map(playerById).filter(Boolean);

  const IN_TEXT = { straight: 'Jeder Treffer zählt sofort.', double: 'Erst ein Doppel eröffnet das Spiel.', master: 'Erst ein Doppel oder Triple eröffnet das Spiel.' };
  const OUT_TEXT = { straight: 'Jeder Treffer darf beenden.', double: 'Der letzte Dart muss ein Doppel sein.', master: 'Der letzte Dart muss ein Doppel oder Triple sein.' };
  const ruleRow = (label, action, current, texts) =>
    '<div class="row rule"><span class="rule-head"><span class="strong">' + esc(label) + '</span><span class="sub2">' + esc(texts[current]) + '</span></span>' +
    segmented(D.MODES.map((m) => [m, D.MODE_NAMES[m]]), current, action) + '</div>';

  function viewNewGame() {
    const g = prefs.game;
    const sel = selectedPlayers();
    const r = route();
    const reorder = !!r.reorder && sel.length > 1;
    let h = header('Neues Spiel');
    const variant = g.variant || 'x01';
    h += '<div class="section">' + segmented(VARIANTS, variant, 'variant') + '</div>';

    if (variant === 'cricket') {
      h += section('Cricket', '<div class="row">Gespielt wird auf 15 bis 20 und Bull. Jede Zahl musst du 3-mal treffen, dann ist sie bei dir „zu“ (Double zählt 2, Triple 3). Triffst du eine Zahl, die bei dir zu ist und bei einem Gegner noch offen, bekommst du Punkte. Wer alles zu hat und mindestens so viele Punkte wie alle anderen, gewinnt.</div>');
    } else if (variant === 'killer') {
      h += section('Killer',
        '<div class="row">Jeder bekommt eine eigene Zahl. Triff zuerst das Doppel deiner Zahl, dann bist du Killer. Als Killer nimmst du anderen mit dem Doppel ihrer Zahl ein Leben. Triffst du als Killer dein eigenes Doppel, verlierst du selbst eins. Wer zuletzt noch Leben hat, gewinnt.</div>' +
        '<div class="row"><span class="grow">Leben pro Spieler</span>' + segmented([[3, '3'], [5, '5']].map((x) => [String(x[0]), x[1]]), String(g.killerLives), 'killerLives') + '</div>',
        'Die Zahlen werden beim Start ausgelost. Mindestens 2 Spieler.');
    }
    if (variant === 'x01') h += section('Spielmodus',
      selectRow('startScore', 'Startpunkte', g.startScore, SCORES.map((s) => [s, s]), 'startScore') +
      '<div class="row"><span class="grow">' + (g.legsToWin === 1 ? 'First to 1 Leg' : 'First to ' + g.legsToWin + ' Legs') + '</span>' +
      '<span class="stepper"><button data-a="legs" data-v="-1" aria-label="Weniger Legs"' + (g.legsToWin <= 1 ? ' disabled' : '') + '>−</button>' +
      '<button data-a="legs" data-v="1" aria-label="Mehr Legs"' + (g.legsToWin >= 11 ? ' disabled' : '') + '>+</button></span></div>');

    if (variant === 'x01') h += section('Ein- und Ausstieg', ruleRow('Check-In', 'inMode', g.inMode, IN_TEXT) + ruleRow('Check-Out', 'outMode', g.outMode, OUT_TEXT),
      'Gerade: ' + esc(D.settingsTitle(g)));

    let body = '';
    if (!sel.length) body += '<div class="row empty">Noch keine Spieler ausgewählt.</div>';
    sel.forEach((p, i) => {
      const badge = g.randomOrder && sel.length > 1 ? icon('q') : String(i + 1);
      body += '<div class="row"><span class="pos">' + badge + '</span>' + avatar(p.name, p.colorIndex) + '<span class="grow ellipsis">' + esc(p.name) + '</span>';
      if (reorder) {
        body += '<button class="mini" data-a="moveSel" data-id="' + p.uuid + '" data-v="-1" aria-label="Nach oben"' + (i === 0 ? ' disabled' : '') + '>' + icon('up') + '</button>' +
          '<button class="mini" data-a="moveSel" data-id="' + p.uuid + '" data-v="1" aria-label="Nach unten"' + (i === sel.length - 1 ? ' disabled' : '') + '>' + icon('down') + '</button>';
      } else {
        body += '<button class="del" data-a="unselect" data-id="' + p.uuid + '" aria-label="' + esc(p.name) + ' entfernen">' + icon('minus') + '</button>';
      }
      body += '</div>';
    });
    if (!reorder) {
      if (FRIENDS || sel.length < db.players.length) body += '<button class="row action" data-a="openAddPlayers">' + icon('personPlus') + (FRIENDS ? 'Neuer Spieler' : 'Spieler hinzufügen') + '</button>';
      if (sel.length > 1) body += toggle('randomOrder', 'Zufällige Startreihenfolge', g.randomOrder, 'randomOrder', 'shuffle');
    }
    let foot;
    if (reorder) foot = 'Verschiebe die Spieler mit den Pfeilen in die gewünschte Wurfreihenfolge.';
    else if (g.randomOrder && sel.length > 1) foot = 'Die Wurfreihenfolge wird beim Spielstart ausgelost. Zum Entfernen auf − tippen.';
    else foot = 'Reihenfolge = Wurfreihenfolge. Zum Entfernen auf − tippen.' + (FRIENDS ? ' Die Auswahl bleibt für das nächste Spiel erhalten.' : '');
    const headRight = sel.length > 1 ? '<button class="link-btn" data-a="toggleReorder">' + (reorder ? 'Fertig' : 'Reihenfolge ändern') + '</button>' : '';
    h += section('<span>Spieler</span>' + headRight, body, foot);

    h += '<div class="section"><button class="btn primary block" data-a="startGame"' + (sel.length >= (variant === 'killer' ? 2 : 1) ? '' : ' disabled') + '>' + icon('play') + 'Spiel starten</button></div>';
    return h;
  }

  function sheetAddPlayers() {
    const avail = playersSorted().filter((p) => prefs.game.selected.indexOf(p.uuid) < 0);
    let h = '<div class="sheet-head"><span class="side"></span><h2>Spieler hinzufügen</h2><span class="side"><button class="link-btn" data-a="closeSheet">Fertig</button></span></div>';
    if (FRIENDS) h += section('Neuen Spieler anlegen',
      '<form class="row" data-f="createSelect"><input class="name-input" id="newPlayerName" placeholder="Name" autocomplete="off" enterkeyhint="done"><button class="btn small" type="submit">Anlegen</button></form>');
    let body = '';
    if (!avail.length) body += '<div class="row empty">Alle Spieler sind bereits ausgewählt.</div>';
    if (GUEST) h += section('', '<div class="row sub" style="color:var(--fg)">Als Gast gibt es drei feste Spieler. Eigene Namen und gespeicherte Statistik gibt es im Freunde-Bereich.</div>');
    avail.forEach((p) => {
      body += '<button class="row link" data-a="selectPlayer" data-id="' + p.uuid + '">' + avatar(p.name, p.colorIndex) + '<span class="grow ellipsis">' + esc(p.name) + '</span><span class="ok" style="display:inline-flex">' + icon('plusc') + '</span></button>';
    });
    h += section('Vorhandene Spieler', body, 'Tippe auf einen Spieler, um ihn hinzuzufügen.');
    return h;
  }

  function createPlayer(rawName) {
    const name = String(rawName || '').trim();
    if (!name || GUEST) return null;
    const p = { uuid: uuid(), name: name, colorIndex: db.players.length, createdAt: new Date().toISOString() };
    db.players.push(p);
    saveDb();
    return p;
  }

  // ================================================================ X01-Spiel

  const SETUP_THRESHOLD = 160;
  let wakeLock = null;
  async function keepAwake(on) {
    try {
      if (on && 'wakeLock' in navigator && !wakeLock) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      } else if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
    } catch (e) { wakeLock = null; }
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && ui.game && !ui.game.engine.isFinished) keepAwake(true); });

  function startGame(settings, players, log) {
    const engine = new D.X01Engine(settings, players);
    (log || []).forEach((d) => engine.throwDart(d));
    ui.game = { engine: engine, saved: false, setupTargets: {}, picking: false, summary: null, confirmQuit: false, lastIndex: engine.currentIndex };
    ui.mult = 1;
    keepAwake(true);
    persistGame();
  }
  function persistGame() {
    const g = ui.game;
    if (!g || g.saved) { LS.del(KEY_ACTIVE); return; }
    LS.set(KEY_ACTIVE, { settings: g.engine.settings, players: g.engine.players, log: g.engine.log });
  }
  function closeGame() {
    ui.game = null;
    LS.del(KEY_ACTIVE);
    keepAwake(false);
    render();
  }
  function canOfferSetup(e) {
    return !e.isFinished && e.settings.outMode !== 'straight' && e.current.isIn && e.current.remaining >= 3 && e.current.remaining <= SETUP_THRESHOLD;
  }
  function activeSetupTarget(g) { return g.engine.isFinished ? null : (g.setupTargets[g.engine.current.player.id] || null); }
  function pruneSetupTargets(g) {
    const e = g.engine;
    for (const id of Object.keys(g.setupTargets)) {
      const st = e.states.find((s) => s.player.id === id);
      const t = g.setupTargets[id];
      if (!st || !(st.remaining > D.score(t) && st.remaining <= SETUP_THRESHOLD)) delete g.setupTargets[id];
    }
    if (e.isFinished) g.picking = false;
  }
  function afterGameChange() {
    const g = ui.game;
    if (g.engine.currentIndex !== g.lastIndex) { g.picking = false; g.lastIndex = g.engine.currentIndex; g.scrollTo = true; }
    pruneSetupTargets(g);
    persistGame();
    if (g.engine.isFinished) keepAwake(false);
  }
  function saveGame() {
    const g = ui.game;
    const e = g.engine;
    if (!e.isFinished || g.saved) return;
    const record = {
      uuid: uuid(), date: new Date().toISOString(),
      startScore: e.settings.startScore, legsToWin: e.settings.legsToWin, inMode: e.settings.inMode, outMode: e.settings.outMode,
      doubleOut: e.settings.doubleOut, masterIn: e.settings.masterIn,
      winnerName: e.winnerName || '',
      results: e.matchStats().map((s, order) => ({ order: order, stats: s }))
    };
    db.games.push(record);
    saveDb();
    g.saved = true;
    g.record = record;
    LS.del(KEY_ACTIVE);
  }

  function viewGame() {
    const g = ui.game, e = g.engine;
    if (g.summary) {
      return '<div class="stage" style="overflow-y:auto"><div class="stage-head"><span class="side"></span><h1>Statistik</h1><span class="side r"><button class="link-btn" data-a="closeGame">Fertig</button></span></div>' +
        '<div style="max-width:980px;width:100%;margin:0 auto;padding-bottom:20px">' + summaryHtml(g.record) + '</div></div>';
    }
    const target = activeSetupTarget(g);
    const setupMode = g.picking || !!target;
    const n = Math.min(Math.max(e.states.length, 1), window.innerWidth >= 820 ? 3 : 2);
    const showLegs = e.settings.legsToWin > 1;

    let board = '<div class="scoreboard" id="scoreboard" style="--n:' + n + '">';
    e.states.forEach((st, i) => {
      const active = i === e.currentIndex && !e.isFinished;
      board += '<div class="pcard' + (active ? ' active' : '') + '" style="--pc:' + pcolor(st.player.colorIndex) + '" data-idx="' + i + '">' +
        '<div class="who">' + avatar(st.player.name, st.player.colorIndex, true) + '<span class="ellipsis">' + esc(st.player.name) + '</span></div>' +
        '<div class="rest">' + st.remaining + '</div>' +
        '<div class="meta"><span>Ø ' + Fmt.avg(D.stateAverage(st)) + '</span>' + (!st.isIn ? '<span class="warn">nicht eröffnet</span>' : '') + (showLegs ? '<span>Legs ' + st.legsWon + '</span>' : '') + '</div></div>';
    });
    board += '</div>';

    let visit = '<div class="visit"><div class="turn">' + esc(e.current.player.name) + ' ist dran</div>' + visitSlots(e.currentDarts);
    if (!e.isFinished && !e.current.isIn) visit += '<div class="hint warn">' + icon('mastersIn') + (e.settings.inMode === 'master' ? 'Master In: Mit Doppel oder Triple beginnen' : 'Double In: Mit einem Doppel beginnen') + '</div>';
    visit += '<div class="msg">' + esc(e.lastMessage || '') + '</div>';
    visit += '</div>';

    // Hilfe-Kasten zwischen Wurfanzeige und Tastenfeld: Finish-Weg und „Was möchtest du dir stellen?“.
    // Die Knöpfe sind immer da und ausgegraut, solange sie nicht passen – so springt das Tastenfeld nicht.
    let helper = '<div class="helper">';
    if (setupMode && e.current.isIn && !e.isFinished) {
      if (target) {
        const path = D.Checkout.setupPath(e.current.remaining, D.score(target), e.dartsLeftInVisit);
        helper += path
          ? '<div class="hbox on setup">' + icon('scope') + '<span>Auf <b>' + D.label(target) + '</b> stellen: ' + path.map(D.label).join(' · ') + '</span></div>'
          : '<div class="hbox off">' + icon('scope') + '<span>' + D.label(target) + ' ist in dieser Aufnahme nicht erreichbar</span></div>';
        helper += '<button class="hbox act small" data-a="pickSetup">Ändern</button><button class="hbox act small danger" data-a="endSetup">Beenden</button>';
      } else {
        helper += '<div class="hbox on setup">' + icon('scope') + '<span>Welches Doppel möchtest du dir stellen?</span></div>';
      }
    } else {
      const sug = !e.isFinished && e.current.isIn ? e.checkoutSuggestion : null;
      helper += sug
        ? '<div class="hbox on">' + icon('flag') + '<span>Finish: <b>' + sug.map(D.label).join(' · ') + '</b></span></div>'
        : '<div class="hbox off">' + icon('flag') + '<span>Finish-Weg (ab 170)</span></div>';
      helper += '<button class="hbox act" data-a="pickSetup"' + (canOfferSetup(e) ? '' : ' disabled') + '>' + icon('scope') + '<span>Was möchtest du dir stellen?</span></button>';
    }
    helper += '</div>';
    visit += helper;

    let pad;
    if (g.picking) {
      pad = '<div class="keypad"><div class="grid">';
      for (let s = 1; s <= 20; s++) pad += '<button class="key k-double" data-a="setSetup" data-v="' + s + '"' + (s * 2 >= e.current.remaining ? ' disabled' : '') + '>D' + s + '</button>';
      pad += '</div><div class="bottom"><button class="key k-double" data-a="setSetup" data-v="25"' + (50 >= e.current.remaining ? ' disabled' : '') + '>Bull</button>' +
        '<button class="key k-gray" data-a="cancelSetup">Abbrechen</button></div></div>';
    } else {
      pad = keypad({ canUndo: e.log.length > 0 && !g.saved, disabled: e.isFinished });
    }

    let h = '<div class="stage' + (setupMode ? ' setup' : '') + '">';
    h += '<div class="stage-head"><span class="side"><button class="link-btn" data-a="quitGame">Beenden</button></span><h1>' + e.settings.startScore + ' · Leg ' + (e.legIndex + 1) + '</h1><span class="side r"></span></div>';
    h += '<div class="stage-body"><div class="stage-col info">' + board + visit + '</div><div class="stage-col pad">' + pad + '</div></div>';

    if (e.isFinished) {
      h += '<div class="overlay"><div class="dialog">' + icon('trophy', 'big-trophy') + '<h2>' + esc(e.winnerName || '') + ' gewinnt!</h2>' +
        '<button class="btn primary block" data-a="showSummary">Statistik anzeigen</button>' +
        (!g.saved ? '<button class="link-btn" data-a="undo">Letzten Dart zurücknehmen</button>' : '') + '</div></div>';
    }
    if (g.confirmQuit) {
      h += '<div class="overlay"><div class="dialog"><h2>Spiel abbrechen?</h2><p>Das Spiel wird nicht in der Statistik gespeichert.</p><div class="stack">' +
        '<button class="btn danger block" data-a="quitConfirmed">Abbrechen ohne Speichern</button><button class="btn block" data-a="quitCancel">Weiterspielen</button></div></div></div>';
    }
    return h + '</div>';
  }

  // ================================================================ Cricket und Killer

  function startParty(variant, players) {
    const engine = variant === 'cricket' ? new D.CricketEngine(players) : new D.KillerEngine({ lives: prefs.game.killerLives }, players);
    ui.party = { variant: variant, engine: engine, saved: false, record: null, summary: false, confirmQuit: false };
    ui.mult = 1;
    keepAwake(true);
  }
  function closeParty() { ui.party = null; keepAwake(false); render(); }
  function saveParty() {
    const p = ui.party, e = p.engine;
    if (!e.isFinished || p.saved) return;
    const record = { uuid: uuid(), date: new Date().toISOString(), variant: p.variant, winnerName: e.winnerName || '', results: e.stats().map((s, order) => ({ order: order, stats: s })) };
    if (p.variant === 'killer') record.lives = e.settings.lives;
    db.games.push(record);
    saveDb();
    p.saved = true;
    p.record = record;
  }

  const MARK_SVG = [
    '',
    '<svg viewBox="0 0 24 24" class="mk"><path d="M6 18 18 6"/></svg>',
    '<svg viewBox="0 0 24 24" class="mk"><path d="M6 18 18 6M6 6l12 12"/></svg>',
    '<svg viewBox="0 0 24 24" class="mk"><circle cx="12" cy="12" r="9"/><path d="M7.5 16.5l9-9M7.5 7.5l9 9"/></svg>'
  ];

  function cricketPad(opts) {
    const m = ui.mult;
    const cls = m === 2 ? 'k-double' : m === 3 ? 'k-triple' : 'k-single';
    const dis = opts.disabled ? ' disabled' : '';
    let h = '<div class="keypad">';
    h += '<div class="mods"><button class="key mod k-double' + (m === 2 ? ' on' : '') + '" data-a="mult" data-v="2"' + dis + '>Double</button>' +
      '<button class="key mod k-triple' + (m === 3 ? ' on' : '') + '" data-a="mult" data-v="3"' + dis + '>Triple</button></div>';
    h += '<div class="grid c3">';
    for (let n = 20; n >= 15; n--) h += '<button class="key ' + cls + '" data-a="dart" data-v="' + n + '"' + dis + '>' + (m === 1 ? '' : m === 2 ? 'D' : 'T') + n + '</button>';
    h += '</div><div class="bottom">';
    h += '<button class="key ' + cls + '" data-a="dart" data-v="25"' + (m === 3 || opts.disabled ? ' disabled' : '') + '>' + (m === 2 ? 'Bull' : '25') + '</button>';
    h += '<button class="key k-gray" data-a="dart" data-v="0"' + dis + '>Daneben</button>';
    h += '<button class="key k-undo" data-a="undo" aria-label="Rückgängig"' + (opts.canUndo && !opts.disabled ? '' : ' disabled') + '>' + icon('undo') + '</button>';
    return h + '</div></div>';
  }

  function viewParty() {
    const p = ui.party, e = p.engine;
    const title = p.variant === 'cricket' ? 'Cricket' : 'Killer';
    if (p.summary) {
      return '<div class="stage" style="overflow-y:auto"><div class="stage-head"><span class="side"></span><h1>Statistik</h1><span class="side r"><button class="link-btn" data-a="closeParty">Fertig</button></span></div>' +
        '<div style="max-width:980px;width:100%;margin:0 auto;padding-bottom:20px">' + summaryHtml(p.record) + '</div></div>';
    }
    let info;
    if (p.variant === 'cricket') {
      info = '<div class="cricket" style="--n:' + e.states.length + '"><div class="crow head"><span></span>' +
        e.states.map((s, i) => '<span class="cp' + (i === e.currentIndex && !e.isFinished ? ' active' : '') + '" style="--pc:' + pcolor(s.player.colorIndex) + '"><span class="ellipsis">' + esc(s.player.name) + '</span><b>' + s.points + '</b></span>').join('') + '</div>';
      for (const n of D.CricketEngine.targets) {
        info += '<div class="crow' + (e.isDead(n) ? ' dead' : '') + '"><span class="cn">' + (n === 25 ? 'Bull' : n) + '</span>' +
          e.states.map((s, i) => '<span class="cm' + (i === e.currentIndex && !e.isFinished ? ' active' : '') + '" style="--pc:' + pcolor(s.player.colorIndex) + '">' + MARK_SVG[s.marks[n]] + '</span>').join('') + '</div>';
      }
      info += '</div>';
    } else {
      info = '<div class="killers">' + e.states.map((s, i) => {
        const active = i === e.currentIndex && !e.isFinished;
        let hearts = '';
        for (let k = 0; k < e.settings.lives; k++) hearts += '<span class="hrt' + (k < s.lives ? '' : ' lost') + '">' + icon('heart') + '</span>';
        return '<div class="kcard' + (active ? ' active' : '') + (s.lives <= 0 ? ' out' : '') + '" style="--pc:' + pcolor(s.player.colorIndex) + '">' +
          avatar(s.player.name, s.player.colorIndex, true) + '<span class="grow ellipsis">' + esc(s.player.name) + '</span>' +
          (s.isKiller && s.lives > 0 ? '<span class="kbadge">Killer</span>' : '') +
          '<span class="knum">D' + s.number + '</span><span class="hearts">' + hearts + '</span></div>';
      }).join('') + '</div>';
    }
    const cur = e.current;
    let visit = '<div class="visit"><div class="turn">' + esc(cur.player.name) + ' ist dran</div>' + visitSlots(e.visit);
    if (p.variant === 'killer' && !e.isFinished) {
      visit += '<div class="hint' + (cur.isKiller ? '' : ' warn') + '">' + icon('scope') + (cur.isKiller ? 'Du bist Killer: Triff das Doppel eines Gegners' : 'Triff zuerst D' + cur.number + ', dann bist du Killer') + '</div>';
    }
    visit += '<div class="msg">' + esc(e.lastMessage || '') + '</div></div>';
    const opts = { canUndo: e.log.length > 0 && !p.saved, disabled: e.isFinished };
    const pad = p.variant === 'cricket' ? cricketPad(opts) : keypad(opts);

    let h = '<div class="stage">';
    h += '<div class="stage-head"><span class="side"><button class="link-btn" data-a="quitParty">Beenden</button></span><h1>' + title + '</h1><span class="side r"></span></div>';
    h += '<div class="stage-body"><div class="stage-col info">' + info + visit + '</div><div class="stage-col pad">' + pad + '</div></div>';
    if (e.isFinished) {
      h += '<div class="overlay"><div class="dialog">' + icon('trophy', 'big-trophy') + '<h2>' + esc(e.winnerName || '') + ' gewinnt!</h2>' +
        '<button class="btn primary block" data-a="partySummary">Statistik anzeigen</button>' +
        (!p.saved ? '<button class="link-btn" data-a="undo">Letzten Dart zurücknehmen</button>' : '') + '</div></div>';
    }
    if (p.confirmQuit) {
      h += '<div class="overlay"><div class="dialog"><h2>Spiel abbrechen?</h2><p>Das Spiel wird nicht gespeichert.</p><div class="stack">' +
        '<button class="btn danger block" data-a="closeParty">Abbrechen ohne Speichern</button><button class="btn block" data-a="partyQuitCancel">Weiterspielen</button></div></div></div>';
    }
    return h + '</div>';
  }

  function partySummaryHtml(game) {
    const stats = sortedResults(game).map((r) => r.stats);
    const winner = stats.find((s) => s.won);
    let h = '<div class="summary-head">';
    if (winner) h += icon('trophy') + '<h2>' + esc(winner.name) + ' gewinnt</h2>';
    h += '<div class="sub">' + esc(gameTitle(game)) + '</div><div class="sub" style="font-weight:400">' + Fmt.date(game.date) + '</div></div>';
    h += '<div class="stats-grid">';
    const list = game.variant === 'killer' ? stats.slice().sort((a, b) => (a.place || 9) - (b.place || 9)) : stats;
    for (const s of list) {
      let bigs, kv;
      if (game.variant === 'cricket') {
        bigs = [[s.points, 'Punkte'], [nf2.format(D.cricketMpr(s)), 'Marks pro Runde'], [s.marks, 'Marks']];
        kv = [['Darts geworfen', s.darts]];
      } else {
        bigs = [[s.place ? s.place + '.' : '–', 'Platz'], [s.kills, 'Leben genommen'], [s.lives, 'Leben übrig']];
        kv = [['Eigene Zahl', 'D' + s.number], ['Darts geworfen', s.darts]];
      }
      h += '<div class="scard" style="--pc:' + pcolor(s.colorIndex) + '"><div class="top">' + avatar(s.name, s.colorIndex) + '<span class="grow ellipsis">' + esc(s.name) + '</span>' + (s.won ? '<span class="trophy">' + icon('trophy') + '</span>' : '') + '</div>' +
        '<div class="bigs">' + bigs.map((b) => '<div><b>' + esc(b[0]) + '</b><span>' + esc(b[1]) + '</span></div>').join('') + '</div>' +
        kv.map((x) => '<div class="kv"><span>' + esc(x[0]) + '</span><span>' + esc(x[1]) + '</span></div>').join('') + '</div>';
    }
    return h + '</div>';
  }

  // ================================================================ Statistik

  function summaryHtml(game) {
    if (game.variant) return partySummaryHtml(game);
    const stats = sortedResults(game).map((r) => r.stats);
    const winner = stats.find((s) => s.won);
    let h = '<div class="summary-head">';
    if (winner) h += icon('trophy') + '<h2>' + esc(winner.name) + ' gewinnt</h2>';
    h += '<div class="sub">' + esc(D.settingsTitle(game)) + '</div><div class="sub" style="font-weight:400">' + Fmt.date(game.date) + '</div></div>';
    h += '<div class="stats-grid">';
    for (const s of stats) {
      h += '<div class="scard" style="--pc:' + pcolor(s.colorIndex) + '"><div class="top">' + avatar(s.name, s.colorIndex) + '<span class="grow ellipsis">' + esc(s.name) + '</span>' + (s.won ? '<span class="trophy">' + icon('trophy') + '</span>' : '') + '</div>' +
        '<div class="bigs"><div><b>' + Fmt.avg(D.statsAverage(s)) + '</b><span>3-Dart-Ø</span></div><div><b>' + Fmt.avg(D.statsFirst9(s)) + '</b><span>First 9 Ø</span></div><div><b>' + Fmt.rate(s.checkoutHits, s.checkoutAttempts) + '</b><span>Checkout</span></div></div>';
      const kv = [
        ['Darts geworfen', s.dartsThrown], ['Punkte', s.pointsScored], ['Checkout-Quote', Fmt.percent(s.checkoutHits, s.checkoutAttempts)],
        ['Legs gewonnen', s.legsWon], ['Bestes Leg', s.bestLeg > 0 ? s.bestLeg + ' Darts' : '–'], ['Höchste Aufnahme', Fmt.orDash(s.highestVisit)],
        ['Höchstes Finish', Fmt.orDash(s.highestCheckout)], ['180er', s.count180], ['140+', s.count140], ['100+', s.count100]
      ];
      h += kv.map((x) => '<div class="kv"><span>' + esc(x[0]) + '</span><span>' + esc(x[1]) + '</span></div>').join('') + '</div>';
    }
    return h + '</div>';
  }

  function viewSummary(r) {
    const game = db.games.find((g) => g.uuid === r.id);
    if (!game) return header('Statistik') + emptyState('chart', 'Spiel nicht gefunden', 'Das Spiel wurde gelöscht.');
    return header('Statistik') + summaryHtml(game);
  }

  // ================================================================ Training

  function trainee() {
    const p = playerById(prefs.trainingPlayer);
    return p ? asMatchPlayer(p) : null;
  }

  function viewTrainingMenu() {
    const t = trainee();
    let h = header('Training');
    const opts = [['', 'Gast']].concat(playersSorted().map((p) => [p.uuid, p.name]));
    h += section('Wer trainiert?', selectRow('trainingPlayer', 'Spieler', t ? t.id : '', opts, 'trainingPlayer'),
      GUEST ? 'Im Gastmodus wird nichts gespeichert. Die Ergebnisse siehst du nur, bis du die Seite schließt.'
        : t ? 'Das Training wird in der Statistik von ' + esc(t.name) + ' gespeichert.' : 'Als Gast wird das Training nicht in einer Spielerstatistik gespeichert.');
    let body = '';
    for (const m of TRAINING_ORDER) {
      const M = D.TrainingModes[m];
      body += '<button class="row link" data-a="openTraining" data-v="' + m + '" style="align-items:flex-start;padding-block:14px"><span class="mode-icon">' + icon(MODE_ICON[m]) + '</span>' +
        '<span class="grow"><span class="strong" style="display:block;font-size:16px">' + esc(M.title) + '</span><span class="sub">' + esc(M.info) + '</span></span><span class="chev">' + icon('chevR') + '</span></button>';
    }
    h += section('Trainingsmodi', body);
    return h;
  }

  function saveTraining(r, rec) {
    const t = r.trainee;
    const record = Object.assign({ uuid: uuid(), date: new Date().toISOString(), playerID: t ? t.id : null, playerName: t ? t.name : 'Gast' }, rec);
    db.trainings.push(record);
    saveDb();
    r.saved = true;
    r.recordId = record.uuid;
  }
  function deleteTrainingRecord(r) {
    if (r.recordId) { db.trainings = db.trainings.filter((x) => x.uuid !== r.recordId); saveDb(); }
    r.recordId = null;
    r.saved = false;
  }

  // ---- Checkout-Training

  function viewCheckout(r) {
    const c = prefs.checkout;
    const e = r.engine;
    if (!e) {
      let h = header(D.TrainingModes.checkout.title);
      h += section('', '<div class="row">' + esc(D.TrainingModes.checkout.info) + '</div>');
      h += section('Einstellungen',
        selectRow('targetCount', 'Anzahl Zahlen', c.targetCount, [5, 10, 20, 50].map((n) => [n, n]), 'targetCount') +
        selectRow('dartsPerTarget', 'Darts pro Zahl', c.dartsPerTarget, [3, 6, 9].map((n) => [n, n === 3 ? '3 (1 Aufnahme)' : n + ' (' + n / 3 + ' Aufnahmen)']), 'dartsPerTarget') +
        selectRow('maxScore', 'Zahlen von 2 bis', c.maxScore, [40, 60, 80, 100, 120, 170].map((n) => [n, n]), 'maxScore'));
      h += '<div class="section"><button class="btn primary block" data-a="startCheckout">' + icon('play') + 'Training starten</button></div>';
      return h;
    }
    if (e.isFinished) {
      let h = header(D.TrainingModes.checkout.title);
      h += section('Ergebnis', statRow('Checkout-Quote', Fmt.percent(e.successCount, e.results.length)) + statRow('Darts geworfen', e.totalDarts) +
        statRow('Ø Darts pro Checkout', e.averageDartsPerCheckout === null ? '–' : nf1.format(e.averageDartsPerCheckout)));
      h += section('Alle Zahlen', e.results.map((x) => '<div class="row"><span class="grow strong num" style="font-size:17px">' + x.target + '</span>' +
        (x.success ? '<span class="ok" style="display:inline-flex;gap:6px;align-items:center">' + icon('check') + 'in ' + x.darts + ' Darts</span>' : '<span class="bad" style="display:inline-flex;gap:6px;align-items:center">' + icon('x') + 'nicht gecheckt</span>') + '</div>').join(''));
      h += section('', '<button class="row action" data-a="startCheckout">' + icon('refresh') + 'Neue Runde</button><button class="row action" data-a="resetTraining">' + icon('slider') + 'Einstellungen ändern</button>');
      return h;
    }
    let info = '<div class="meta-row"><span>Zahl ' + (e.index + 1) + ' von ' + e.targets.length + '</span><span>' + e.successCount + ' gecheckt</span></div>' +
      '<div class="big-target">' + e.remaining + '</div>' +
      (e.remaining !== e.currentTarget ? '<div class="big-label">Ziel: ' + e.currentTarget + '</div>' : '') +
      '<div class="center strong">Noch ' + e.dartsLeftForTarget + ' Darts</div>' +
      '<div class="visit">' + visitSlots(e.visitDarts) + checkoutHint(e.suggestion) + '<div class="msg">' + esc(e.lastMessage || '') + '</div></div>';
    return stageWrap(D.TrainingModes.checkout.title, '<div class="stage-body"><div class="stage-col info">' + info + '</div><div class="stage-col pad">' + keypad({ canUndo: e.log.length > 0 }) + '</div></div>');
  }

  function stageWrap(title, inner) {
    return '<div class="stage"><div class="stage-head"><span class="side"><button class="back" data-a="leaveTraining">' + icon('chevL') + 'Training</button></span><h1>' + esc(title) + '</h1><span class="side r"></span></div>' + inner + '</div>';
  }

  // ---- Rund um die Uhr

  /** Drei Pfeile für die aktuelle Aufnahme: grün = Treffer, rot = daneben, grau = noch offen. */
  function visitArrows(results) {
    let h = '<span class="arrows" aria-label="Aufnahme: ' + results.length + ' von 3 Darts geworfen">';
    for (let i = 0; i < 3; i++) h += '<span class="arrow' + (i < results.length ? (results[i] ? ' hit' : ' miss') : '') + '">' + icon('dart') + '</span>';
    return h + '</span>';
  }

  function viewClock(r) {
    const e = r.engine;
    const variant = prefs.clockVariant;
    if (!e) {
      let h = header(D.TrainingModes.aroundTheClock.title);
      h += section('', '<div class="row">' + esc(D.TrainingModes.aroundTheClock.info) + '</div>');
      h += section('Variante', Object.keys(D.ClockVariants).map((k) => '<label class="row radio-row" for="cv-' + k + '"><span class="grow">' + esc(D.ClockVariants[k].title) + '</span><input type="radio" name="clockVariant" id="cv-' + k + '" value="' + k + '" data-c="clockVariant"' + (k === variant ? ' checked' : '') + '></label>').join(''));
      h += '<div class="section"><button class="btn primary block" data-a="startClock">' + icon('play') + 'Training starten</button></div>';
      return h;
    }
    if (e.isFinished) {
      let h = header(D.TrainingModes.aroundTheClock.title);
      h += section('Ergebnis', statRow('Variante', D.ClockVariants[variant].title) + statRow('Darts gebraucht', e.darts) + statRow('Trefferquote', Fmt.percent(e.hits, e.darts)));
      h += section('', '<button class="row action" data-a="clockUndoFinished">' + icon('undo') + 'Letzten Dart zurücknehmen</button><button class="row action" data-a="startClock">' + icon('refresh') + 'Neue Runde</button><button class="row action" data-a="resetTraining">' + icon('slider') + 'Einstellungen ändern</button>');
      return h;
    }
    const pct = e.hits / D.AroundTheClockEngine.targets.length * 100;
    const inner = '<div class="train"><div class="progress"><span style="width:' + pct + '%"></span></div>' +
      '<div class="meta-row"><span>' + e.darts + ' Darts</span>' + visitArrows(e.log.slice(e.darts - e.darts % 3)) + '</div>' +
      '<div class="grow"><div class="big-label">Ziel</div><div class="big-target">' + esc(D.clockLabel(variant, e.currentTarget)) + '</div></div>' +
      '<div class="two"><button class="key big k-triple" data-a="clockHit" data-v="0">' + icon('x') + 'Daneben</button><button class="key big k-double filled" data-a="clockHit" data-v="1">' + icon('check') + 'Treffer</button></div>' +
      '<div class="center"><button class="link-btn" data-a="trainUndo"' + (e.log.length ? '' : ' disabled') + '>' + icon('undo') + ' Rückgängig</button></div></div>';
    return stageWrap(D.TrainingModes.aroundTheClock.title, inner);
  }

  // ---- Bob's 27

  function viewBobs(r) {
    const e = r.engine;
    const B = D.BobsEngine;
    if (e.isFinished) {
      let h = header(D.TrainingModes.bobs27.title);
      const res = e.survived
        ? '<div class="row" style="color:var(--warn);font-weight:600">' + icon('trophy') + 'Alle Doubles geschafft!</div>'
        : '<div class="row bad strong">' + icon('octagon') + 'Ausgeschieden in Runde ' + e.rounds.length + ' (' + B.label(B.targets[e.rounds.length - 1]) + ')</div>';
      h += section('Ergebnis', res + statRow('Endstand', e.score) + statRow('Doubles getroffen', Fmt.percent(e.totalHits, e.rounds.length * 3)));
      h += section('Runden', e.rounds.map((hits, i) => statRow(B.label(B.targets[i]), hits + ' / 3')).join(''));
      h += section('', '<button class="row action" data-a="bobsUndoFinished">' + icon('undo') + 'Letzte Runde zurücknehmen</button><button class="row action" data-a="startBobs">' + icon('refresh') + 'Neue Runde</button>');
      return h;
    }
    const t = e.currentTarget;
    let buttons = '';
    for (let k = 0; k <= 3; k++) buttons += '<button class="key ' + (k === 0 ? 'k-triple' : 'k-double filled') + '" data-a="bobsHits" data-v="' + k + '">' + k + '</button>';
    const inner = '<div class="train"><div class="meta-row"><span>Runde ' + (e.rounds.length + 1) + ' von ' + B.targets.length + '</span><span>' + e.totalHits + ' Treffer</span></div>' +
      '<div class="grow"><div class="big-label">Punkte</div><div class="big-target">' + e.score + '</div>' +
      '<div style="font-size:22px;font-weight:700">Wirf 3 Darts auf ' + B.label(t) + '</div>' +
      '<div class="sub" style="color:var(--muted);font-size:13px">Treffer: +' + B.value(t) + ' je Dart · Kein Treffer: −' + B.value(t) + '</div></div>' +
      '<div class="center strong">Wie oft getroffen?</div><div class="hits4">' + buttons + '</div>' +
      '<div class="center"><button class="link-btn" data-a="trainUndo"' + (e.rounds.length ? '' : ' disabled') + '>' + icon('undo') + ' Rückgängig</button></div></div>';
    return stageWrap(D.TrainingModes.bobs27.title, inner);
  }

  // ---- Halve It

  function viewHalveIt(r) {
    const e = r.engine;
    const title = D.TrainingModes.halveIt.title;
    if (e.isFinished) {
      let h = header(title);
      h += section('Ergebnis', statRow('Endstand', e.score + ' Punkte') + statRow('Ziele getroffen', e.hitRounds + ' von ' + e.rounds.length) + statRow('Halbiert', e.halvedCount + '-mal'));
      h += section('Runden', e.rounds.map((x) => '<div class="row"><span class="grow strong">' + esc(x.label) + '</span>' +
        (x.halved ? '<span class="bad">halbiert</span>' : '<span class="ok">+' + x.points + '</span>') + '<span class="num" style="min-width:48px;text-align:right">' + x.score + '</span></div>').join(''));
      h += section('', '<button class="row action" data-a="trainUndoFinished">' + icon('undo') + 'Letzten Dart zurücknehmen</button><button class="row action" data-a="restartTraining">' + icon('refresh') + 'Neue Runde</button>');
      return h;
    }
    const t = e.currentTarget;
    const info = '<div class="meta-row"><span>Runde ' + (e.rounds.length + 1) + ' von ' + D.HalveItEngine.targets.length + '</span><span>' + e.halvedCount + '-mal halbiert</span></div>' +
      '<div class="big-label">Punkte</div><div class="big-target">' + e.score + '</div>' +
      '<div class="center strong" style="font-size:20px">Ziel: ' + esc(t.key === 'D' ? 'beliebiges Doppel' : t.key === 'T' ? 'beliebiges Triple' : t.label) + '</div>' +
      '<div class="visit">' + visitSlots(e.visit) + '<div class="hint">' + icon('half') + 'Kein Treffer in dieser Runde = Punkte halbiert</div><div class="msg">' + esc(e.lastMessage || '') + '</div></div>';
    return stageWrap(title, '<div class="stage-body"><div class="stage-col info">' + info + '</div><div class="stage-col pad">' + keypad({ canUndo: e.log.length > 0 }) + '</div></div>');
  }

  // ---- JDC Challenge

  function viewJdc(r) {
    const e = r.engine;
    const J = D.JdcEngine;
    const title = D.TrainingModes.jdc.title;
    if (e.isFinished) {
      let h = header(title);
      h += section('Ergebnis', statRow('Gesamt', e.total + ' Punkte') + statRow('Stufe', J.grade(e.total)) +
        J.parts.map((p, i) => statRow('Teil ' + (i + 1) + ': ' + p, e.parts[i])).join('') +
        statRow('Shanghais', e.shanghais) + statRow('Doppel getroffen', e.doublesHit + ' von 21'),
        'Stufen: Weiß ab 0, Lila ab 150, Gelb ab 300, Grün ab 450, Blau ab 600, Rot ab 700, Schwarz ab 850 Punkten.');
      h += section('', '<button class="row action" data-a="trainUndoFinished">' + icon('undo') + 'Letzten Dart zurücknehmen</button><button class="row action" data-a="restartTraining">' + icon('refresh') + 'Neue Runde</button>');
      return h;
    }
    const st = e.step;
    const head = '<div class="meta-row"><span>Teil ' + st.part + ' von 3 · ' + esc(J.parts[st.part - 1]) + '</span><span>' + e.total + ' Punkte</span></div>';
    if (st.kind === 'double') {
      const lab = st.n === 25 ? 'Bull' : 'D' + st.n;
      const inner = '<div class="train">' + head +
        '<div class="grow"><div class="big-label">Ein Dart auf</div><div class="big-target">' + lab + '</div>' +
        '<div class="sub" style="color:var(--muted);font-size:13px">Treffer: +' + (st.n === 25 ? 100 : 50) + ' Punkte</div><div class="msg">' + esc(e.lastMessage || '') + '</div></div>' +
        '<div class="two"><button class="key big k-triple" data-a="jdcDouble" data-v="0">' + icon('x') + 'Daneben</button><button class="key big k-double filled" data-a="jdcDouble" data-v="1">' + icon('check') + 'Treffer</button></div>' +
        '<div class="center"><button class="link-btn" data-a="trainUndo"' + (e.log.length ? '' : ' disabled') + '>' + icon('undo') + ' Rückgängig</button></div></div>';
      return stageWrap(title, inner);
    }
    const info = head + '<div class="big-label">Ziel</div><div class="big-target">' + st.n + '</div>' +
      '<div class="visit">' + visitSlots(e.visit) + '<div class="hint">' + icon('medal') + 'Single, Double und Triple von ' + st.n + ' = +100 Bonus</div><div class="msg">' + esc(e.lastMessage || '') + '</div></div>';
    return stageWrap(title, '<div class="stage-body"><div class="stage-col info">' + info + '</div><div class="stage-col pad">' + keypad({ canUndo: e.log.length > 0 }) + '</div></div>');
  }

  // ================================================================ Spieler

  function viewPlayers() {
    const ps = playersSorted();
    let h = header('Spieler', GUEST ? {} : {
      left: '<button class="icon-btn" data-a="openSync" aria-label="Importieren und exportieren">' + icon('sync') + '<span>Import/Export</span></button>',
      right: '<button class="icon-btn" data-a="newPlayerDialog" aria-label="Spieler hinzufügen">' + icon('plus') + '</button>'
    });
    if (!ps.length) {
      return h + emptyState('people', 'Noch keine Spieler', 'Tippe auf +, um einen Spieler anzulegen.',
        '<div class="btn-row" style="margin-top:16px"><button class="btn" data-a="newPlayerDialog">' + icon('plus') + 'Spieler anlegen</button><button class="btn" data-a="openSync">' + icon('wand') + 'Testdaten &amp; Import</button></div>');
    }
    const body = ps.map((p) => {
      const L = D.lifetimeStats(resultsOf(p.uuid).map((x) => x.r.stats));
      const sub = L.games > 0 ? L.games + ' ' + (L.games === 1 ? 'Spiel' : 'Spiele') + ' · Ø ' + Fmt.avg(L.average) : 'Noch keine Spiele';
      return '<button class="row link" data-a="openPlayer" data-id="' + p.uuid + '">' + avatar(p.name, p.colorIndex) + '<span class="grow"><span class="ellipsis" style="display:block">' + esc(p.name) + '</span><span class="sub">' + sub + '</span></span><span class="chev">' + icon('chevR') + '</span></button>';
    }).join('');
    return h + section('', body, GUEST ? 'Statistik nur für diese Sitzung. Beim Schließen der Seite wird alles verworfen.' : 'Alle angemeldeten Freunde sehen und bearbeiten dieselben Spieler.');
  }

  /** Ergebnisse eines Spielers, älteste zuerst: [{r, game}] */
  function resultsOf(id) {
    const out = [];
    for (const g of db.games) if (!g.variant) for (const r of g.results || []) if (r.stats.id === id) out.push({ r: r, game: g });
    return out.sort((a, b) => String(a.game.date).localeCompare(String(b.game.date)));
  }

  const GAME_METRICS = {
    average: { title: '3-Dart-Ø', value: (s) => s.dartsThrown > 0 ? D.statsAverage(s) : null, format: (v) => Fmt.avg(v) },
    first9: { title: 'First 9 Ø', value: (s) => s.first9Darts > 0 ? D.statsFirst9(s) : null, format: (v) => Fmt.avg(v) },
    checkout: { title: 'Checkout-Quote', value: (s) => s.checkoutAttempts > 0 ? s.checkoutHits / s.checkoutAttempts * 100 : null, format: (v) => nf1.format(v) + ' %', fixed: [0, 100] }
  };
  const TRAIN_CHART = {
    checkout: { value: (r) => r.attempts > 0 ? r.hits / r.attempts * 100 : null, format: (v) => nf1.format(v) + ' %', fixed: [0, 100] },
    aroundTheClock: { value: (r) => r.dartsThrown, format: (v) => Math.round(v) + ' Darts', lower: true },
    bobs27: { value: (r) => r.score, format: (v) => Math.round(v) + ' Punkte' },
    halveIt: { value: (r) => r.score, format: (v) => Math.round(v) + ' Punkte' },
    jdc: { value: (r) => r.score, format: (v) => Math.round(v) + ' Punkte' }
  };
  const CHART_LIMIT = 20, LIST_LIMIT = 10;
  const charts = {};

  function viewPlayer(r) {
    const p = playerById(r.id);
    if (!p) return header('Spieler') + emptyState('people', 'Spieler gelöscht', 'Dieser Spieler existiert nicht mehr.');
    r.metric = r.metric || 'average';
    r.tmode = r.tmode || 'checkout';
    const results = resultsOf(p.uuid);
    const trainings = trainingsSorted().filter((t) => t.playerID === p.uuid);
    const L = D.lifetimeStats(results.map((x) => x.r.stats));
    let h = header(p.name, { backLabel: 'Spieler' });

    h += section('', '<div class="tiles"><div class="tile"><b>' + L.games + '</b><span>Spiele</span></div><div class="tile"><b>' + Fmt.rate(L.wins, L.games) + '</b><span>Siege</span></div>' +
      '<div class="tile"><b>' + (L.games > 0 ? Fmt.avg(L.average) : '–') + '</b><span>3-Dart-Ø</span></div><div class="tile"><b>' + Fmt.rate(L.hits, L.attempts) + '</b><span>Checkout</span></div></div>');

    // Spiele-Graph
    const M = GAME_METRICS[r.metric];
    const gpoints = [];
    results.slice(-CHART_LIMIT).forEach((x, i) => { const v = M.value(x.r.stats); if (v !== null) gpoints.push({ index: i + 1, date: x.game.date, value: v }); });
    charts.game = { title: M.title, points: gpoints, format: M.format, fixed: M.fixed, lower: false, sel: null };
    h += section('Entwicklung in Spielen',
      '<div style="padding:10px 10px 0">' + segmented(Object.keys(GAME_METRICS).map((k) => [k, GAME_METRICS[k].title]), r.metric, 'metric') + '</div><div class="chart" data-chart="game"></div>',
      'Bis zu ' + CHART_LIMIT + ' letzte Spiele. Tippe oder ziehe im Graphen, um einzelne Spiele zu sehen. Gestrichelt: Trend.');

    // Letzte Spiele
    let rows = '';
    if (!results.length) rows = '<div class="row empty">Noch keine Spiele gespeichert.</div>';
    results.slice().reverse().slice(0, LIST_LIMIT).forEach((x) => { rows += playerGameRow(x); });
    if (results.length > LIST_LIMIT) rows += '<button class="row action" data-a="allGames" data-id="' + p.uuid + '">Alle ' + results.length + ' Spiele<span class="spacer" style="flex:1"></span><span class="chev">' + icon('chevR') + '</span></button>';
    h += section('Letzte Spiele', rows);

    h += section('Bestwerte', statRow('Höchste Aufnahme', Fmt.orDash(L.highestVisit)) + statRow('Höchstes Finish', Fmt.orDash(L.highestCheckout)) +
      statRow('Bestes Leg', L.bestLeg > 0 ? L.bestLeg + ' Darts' : '–') + statRow('180er', L.count180) + statRow('Checkouts', Fmt.percent(L.hits, L.attempts)));

    // Cricket und Killer
    const party = [];
    for (const g of db.games) if (g.variant) for (const x of g.results || []) if (x.stats.id === p.uuid) party.push({ g: g, s: x.stats });
    if (party.length) {
      const of = (v) => party.filter((x) => x.g.variant === v);
      const line = (v, label) => { const l = of(v); return l.length ? statRow(label, l.length + ' ' + (l.length === 1 ? 'Spiel' : 'Spiele') + ', ' + (() => { const w = l.filter((x) => x.s.won).length; return w + (w === 1 ? ' Sieg' : ' Siege'); })()) : ''; };
      const cr = of('cricket');
      const mpr = cr.reduce((a, x) => a + (x.s.darts || 0), 0);
      h += section('Cricket und Killer', line('cricket', 'Cricket') + (mpr ? statRow('Cricket: Marks pro Runde', nf2.format(cr.reduce((a, x) => a + x.s.marks, 0) / mpr * 3)) : '') + line('killer', 'Killer'));
    }

    // Training-Graph
    const ofMode = trainings.filter((t) => t.mode === r.tmode);
    const T = TRAIN_CHART[r.tmode];
    const tpoints = [];
    ofMode.slice(0, CHART_LIMIT).reverse().forEach((t, i) => { const v = T.value(t); if (v !== null) tpoints.push({ index: i + 1, date: t.date, value: v }); });
    charts.training = { title: D.TrainingModes[r.tmode].chartTitle, points: tpoints, format: T.format, fixed: T.fixed, lower: !!T.lower, sel: null };
    let tsum = '';
    if (ofMode.length) {
      tsum += statRow('Trainings', ofMode.length);
      if (r.tmode === 'checkout') tsum += statRow('Gesamt-Quote', Fmt.percent(ofMode.reduce((a, t) => a + t.hits, 0), ofMode.reduce((a, t) => a + t.attempts, 0)));
      if (r.tmode === 'aroundTheClock') tsum += statRow('Bestwert', Math.min.apply(null, ofMode.map((t) => t.dartsThrown)) + ' Darts');
      if (r.tmode === 'halveIt' || r.tmode === 'jdc') tsum += statRow('Bestwert', Math.max.apply(null, ofMode.map((t) => t.score)) + ' Punkte');
      if (r.tmode === 'bobs27') tsum += statRow('Bestwert', Math.max.apply(null, ofMode.map((t) => t.score)) + ' Punkte');
    }
    h += section('Entwicklung im Training',
      '<div style="padding:10px 10px 0">' + segmented(TRAINING_ORDER.map((k) => [k, D.TrainingModes[k].short]), r.tmode, 'tmode') + '</div><div class="chart" data-chart="training"></div>' + tsum,
      r.tmode === 'aroundTheClock' ? 'Bei Rund um die Uhr ist weniger besser.' : 'Bis zu ' + CHART_LIMIT + ' letzte Trainings dieses Modus.');

    let trows = '';
    if (!trainings.length) trows = '<div class="row empty">Noch kein Training gespeichert.</div>';
    trainings.slice(0, LIST_LIMIT).forEach((t) => { trows += trainingRow(t, false); });
    h += section('Letzte Trainings', trows);

    if (GUEST) return h;
    h += section('Profil',
      '<div class="row"><input class="name-input" id="playerName" data-c="playerName" data-id="' + p.uuid + '" value="' + esc(p.name) + '" aria-label="Name" autocomplete="off"></div>' +
      '<div class="colors">' + COLORS.map((c, i) => '<button style="--pc:' + c + '" data-a="playerColor" data-id="' + p.uuid + '" data-v="' + i + '" aria-pressed="' + (p.colorIndex % COLORS.length === i) + '" aria-label="Farbe ' + (i + 1) + '"></button>').join('') + '</div>');
    h += section('', '<button class="row danger" data-a="deletePlayer" data-id="' + p.uuid + '">' + icon('trash') + 'Spieler löschen</button>', 'Die Statistik in gespeicherten Spielen bleibt erhalten.');
    return h;
  }

  function playerGameRow(x) {
    const g = x.game, r = x.r;
    const opponents = sortedResults(g).filter((o) => o.stats.id !== r.stats.id).map((o) => o.stats.name);
    const sub = opponents.length ? 'gegen ' + opponents.join(', ') + ' · ' + Fmt.date(g.date) : Fmt.date(g.date);
    return '<button class="row link" data-a="openGame" data-id="' + g.uuid + '"><span class="grow"><span class="strong" style="display:block;font-size:14px">' + esc(D.settingsTitle(g)) + '</span><span class="sub2">' + esc(sub) + '</span></span>' +
      '<span style="text-align:right"><span class="strong num" style="display:block;font-size:14px">Ø ' + Fmt.avg(D.statsAverage(r.stats)) + '</span>' +
      (r.stats.won ? '<span class="win">' + icon('trophy') + 'Sieg</span>' : '<span class="sub2">Niederlage</span>') + '</span><span class="chev">' + icon('chevR') + '</span></button>';
  }

  function trainingRow(t, withPlayer, deletable) {
    const sub = withPlayer ? esc(t.playerName) + ' · ' + esc(t.detail) : esc(t.detail) + ' · ' + Fmt.date(t.date);
    const row = '<div class="row"><span class="mode-icon">' + icon(MODE_ICON[t.mode] || 'flag') + '</span><span class="grow"><span class="strong" style="display:block;font-size:14px">' + esc(D.TrainingModes[t.mode] ? D.TrainingModes[t.mode].title : t.mode) + '</span>' +
      '<span class="sub2" style="display:block">' + sub + '</span>' + (withPlayer ? '<span class="sub2">' + Fmt.date(t.date) + '</span>' : '') + '</span><span class="strong" style="text-align:right;font-size:14px">' + esc(D.trainingResultText(t)) + '</span></div>';
    if (!deletable) return row;
    return '<div class="rowwrap">' + row + '<button class="del" data-a="deleteTraining" data-id="' + t.uuid + '" aria-label="Training löschen" style="color:var(--muted)">' + icon('trash') + '</button></div>';
  }

  function viewAllGames(r) {
    const p = playerById(r.id);
    const results = resultsOf(r.id).reverse();
    return header('Spiele von ' + (p ? p.name : '')) + section('', results.map(playerGameRow).join('') || '<div class="row empty">Keine Spiele.</div>');
  }

  // ---- Graph

  function drawChart(el) {
    const c = charts[el.dataset.chart];
    if (!c) return;
    const pts = c.points;
    const sel = c.sel !== null ? pts.reduce((best, p) => (best === null || Math.abs(p.index - c.sel) < Math.abs(best.index - c.sel)) ? p : best, null) : null;
    const shown = sel || pts[pts.length - 1];
    let h = '<div class="chead"><h3>' + esc(c.title) + '</h3>' + (shown ? '<div class="cval"><b>' + esc(c.format(shown.value)) + '</b><span>' + (sel ? 'Nr. ' + sel.index + ' · ' + Fmt.day(sel.date) : 'zuletzt') + '</span></div>' : '') + '</div>';
    if (pts.length < 2) { el.innerHTML = h + '<div class="nodata">Für einen Graphen sind mindestens 2 Einträge nötig.</div>'; return; }

    const W = Math.max(240, el.clientWidth - 28), H = 190;
    const padL = 40, padR = 10, padT = 10, padB = 24;
    const x0 = pts[0].index, x1 = pts[pts.length - 1].index;
    const vals = pts.map((p) => p.value);
    let lo, hi;
    if (c.fixed) { lo = c.fixed[0]; hi = c.fixed[1]; }
    else { const mn = Math.min.apply(null, vals), mx = Math.max.apply(null, vals); const pad = Math.max((mx - mn) * 0.15, 1); lo = mn - pad; hi = mx + pad; }
    const X = (i) => padL + (x1 === x0 ? 0 : (i - x0) / (x1 - x0)) * (W - padL - padR);
    const Y = (v) => padT + (1 - (v - lo) / (hi - lo)) * (H - padT - padB);

    // y-Achse: "schöne" Schritte
    const rawStep = (hi - lo) / 4;
    const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
    const step = [1, 2, 2.5, 5, 10].map((f) => f * mag).find((s) => s >= rawStep) || rawStep;
    let svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '" role="img" aria-label="' + esc(c.title) + '">';
    for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) {
      const y = Y(v);
      svg += '<line class="grid" x1="' + padL + '" x2="' + (W - padR) + '" y1="' + y + '" y2="' + y + '"/>';
      svg += '<text class="axis" x="' + (padL - 6) + '" y="' + (y + 4) + '" text-anchor="end">' + (Math.abs(step) < 1 ? nf1.format(v) : Math.round(v)) + '</text>';
    }
    const xstep = Math.max(1, Math.ceil((x1 - x0) / 5));
    for (let i = x0; i <= x1; i += xstep) svg += '<text class="axis" x="' + X(i) + '" y="' + (H - 6) + '" text-anchor="middle">' + i + '</text>';

    const line = pts.map((p, i) => (i ? 'L' : 'M') + X(p.index).toFixed(1) + ' ' + Y(p.value).toFixed(1)).join(' ');
    svg += '<path class="area" d="' + line + ' L' + X(x1).toFixed(1) + ' ' + (H - padB) + ' L' + X(x0).toFixed(1) + ' ' + (H - padB) + ' Z"/>';
    svg += '<path class="ln" d="' + line + '"/>';

    const trend = regression(pts);
    if (trend) svg += '<line class="trend" x1="' + X(x0) + '" y1="' + Y(trend.start) + '" x2="' + X(x1) + '" y2="' + Y(trend.end) + '"/>';
    if (sel) svg += '<line class="rule" x1="' + X(sel.index) + '" x2="' + X(sel.index) + '" y1="' + padT + '" y2="' + (H - padB) + '"/>';
    for (const p of pts) svg += '<circle class="dot' + (sel && p.index === sel.index ? ' sel' : '') + '" cx="' + X(p.index) + '" cy="' + Y(p.value) + '" r="' + (sel && p.index === sel.index ? 6 : 3.5) + '"/>';
    svg += '</svg>';
    h += '<div class="plot" data-plot="' + el.dataset.chart + '" data-x0="' + x0 + '" data-x1="' + x1 + '" data-pl="' + padL + '" data-pr="' + padR + '" data-w="' + W + '">' + svg + '</div>';

    if (trend) {
      const change = trend.end - trend.start;
      const scale = Math.max(Math.abs(vals.reduce((a, b) => a + b, 0) / vals.length), 1);
      if (Math.abs(change) < scale * 0.02) h += '<div class="tl flat">' + icon('arrowR') + 'Stabil</div>';
      else {
        const improved = c.lower ? change < 0 : change > 0;
        h += '<div class="tl ' + (improved ? 'up' : 'down') + '">' + icon(change > 0 ? 'arrowUR' : 'arrowDR') + (improved ? 'Verbessert' : 'Verschlechtert') + ' um ' + esc(c.format(Math.abs(change))) + ' über ' + pts.length + ' Einträge</div>';
      }
    }
    el.innerHTML = h;
  }

  function regression(pts) {
    if (pts.length < 3) return null;
    const n = pts.length;
    const xs = pts.map((p) => p.index), ys = pts.map((p) => p.value);
    const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
    const den = xs.reduce((a, x) => a + (x - mx) * (x - mx), 0);
    if (den <= 0) return null;
    const slope = xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0) / den;
    const icpt = my - slope * mx;
    return { start: icpt + slope * xs[0], end: icpt + slope * xs[n - 1] };
  }

  function chartPointer(ev) {
    const plot = ev.target.closest('[data-plot]');
    if (!plot) return;
    const c = charts[plot.dataset.plot];
    const rect = plot.getBoundingClientRect();
    const W = +plot.dataset.w, pl = +plot.dataset.pl, pr = +plot.dataset.pr, x0 = +plot.dataset.x0, x1 = +plot.dataset.x1;
    const px = (ev.clientX - rect.left) * (W / rect.width);
    const frac = Math.min(1, Math.max(0, (px - pl) / (W - pl - pr)));
    const idx = Math.round(x0 + frac * (x1 - x0));
    if (c.sel !== idx) { c.sel = idx; drawChart(plot.closest('[data-chart]')); }
  }
  function chartRelease(ev) {
    const plot = ev.target.closest && ev.target.closest('[data-chart]');
    for (const k in charts) {
      if (charts[k].sel !== null) {
        charts[k].sel = null;
        const el = document.querySelector('[data-chart="' + k + '"]');
        if (el) drawChart(el);
      }
    }
    return plot;
  }

  // ================================================================ Abgleich (Export / Import)

  function exportPayload() {
    return {
      format: 'darts-counter', version: 1,
      deviceName: prefs.deviceName || 'Browser',
      exportedAt: new Date().toISOString(),
      players: db.players, games: db.games, trainings: db.trainings
    };
  }

  // Swift kodiert Datumswerte als Sekunden seit 1.1.2001 – beides wird akzeptiert.
  function normDate(v) {
    if (typeof v === 'number') return new Date((v + 978307200) * 1000).toISOString();
    return v || new Date().toISOString();
  }
  function importText(text) {
    let data;
    try { data = JSON.parse(text); } catch (e) { return toast('Die Datei ist kein gültiger Darts-Counter-Export.'); }
    if (!data || !Array.isArray(data.players) || !Array.isArray(data.games)) return toast('Die Datei ist kein gültiger Darts-Counter-Export.');
    data.players.forEach((p) => { p.createdAt = normDate(p.createdAt); });
    data.games.forEach((g) => { g.date = normDate(g.date); });
    (data.trainings || []).forEach((t) => { t.date = normDate(t.date); });
    const result = D.mergePayload(db, data, uuid);
    saveDb();
    toast('Import von „' + (data.deviceName || 'Gerät') + '“ fertig. ' + D.mergeSummary(result));
  }

  function viewSync() {
    let h = header('Import/Export', { backLabel: 'Spieler' });
    h += section('', '<div class="row" style="align-items:flex-start"><span class="mode-icon" style="width:auto">' + icon('info') + '</span><span class="grow sub" style="color:var(--fg)">Die Daten im Freunde-Bereich werden automatisch gespeichert und abgeglichen. Hier kannst du zusätzlich eine Sicherung exportieren oder einen Export aus der iOS-App übernehmen. Spiele und Trainings werden nur übernommen, wenn sie noch fehlen. Gleichnamige Spieler werden zusammengeführt.</span></div>');
    h += section('Exportieren',
      '<div class="row"><label class="grow" for="deviceName">Gerätename</label><input class="name-input" style="text-align:right;flex:0 1 50%" id="deviceName" data-c="deviceName" value="' + esc(prefs.deviceName) + '" placeholder="z. B. iPad" autocomplete="off"></div>' +
      '<button class="row action" data-a="exportFile">' + icon('download') + 'Als Datei exportieren</button>' +
      '<button class="row action" data-a="exportCopy">' + icon('copy') + 'Export in die Zwischenablage kopieren</button>',
      db.players.length + ' Spieler, ' + db.games.length + ' Spiele, ' + db.trainings.length + ' Trainings gemeinsam gespeichert.');
    h += section('Importieren',
      '<label class="row action" for="importFile" style="cursor:pointer">' + icon('upload') + 'Datei auswählen …<input type="file" id="importFile" accept="application/json,.json,text/plain" data-c="importFile" hidden></label>' +
      '<textarea class="paste" id="pasteBox" placeholder="… oder exportierten Text hier einfügen" aria-label="Exportierten Text einfügen"></textarea>' +
      '<button class="row action" data-a="importPaste">' + icon('check') + 'Eingefügten Text importieren</button>');
    return h;
  }

  // ================================================================ Verlauf

  function viewHistory() {
    let h = header('Verlauf');
    h += '<div style="margin-top:4px">' + segmented([['games', 'Spiele'], ['training', 'Training']], ui.historyTab, 'historyTab') + '</div>';
    if (ui.historyTab === 'games') {
      const gs = gamesSorted();
      let body = gs.length ? '' : '<div class="row empty">Noch keine Spiele gespielt.</div>';
      for (const g of gs) {
        body += '<div class="rowwrap"><button class="row link" data-a="openGame" data-id="' + g.uuid + '"><span class="grow"><span style="display:flex;gap:8px;justify-content:space-between;align-items:baseline"><span class="strong">' + esc(gameTitle(g)) + '</span><span class="sub2" style="white-space:nowrap">' + Fmt.date(g.date) + '</span></span>' +
          '<span style="display:block;font-size:14px">' + esc(sortedResults(g).map((r) => r.stats.name).join(' vs. ')) + '</span>' +
          (g.winnerName ? '<span class="win">' + icon('trophy') + esc(g.winnerName) + '</span>' : '') + '</span></button>' +
          '<button class="del" data-a="deleteGame" data-id="' + g.uuid + '" aria-label="Spiel löschen" style="color:var(--muted)">' + icon('trash') + '</button></div>';
      }
      h += section('', body, GUEST && gs.length ? 'Nur diese Sitzung. Nichts davon wird gespeichert.' : '');
    } else {
      const ts = trainingsSorted();
      h += section('', ts.length ? ts.map((t) => trainingRow(t, true, true)).join('') : '<div class="row empty">Noch kein Training gespeichert.</div>', GUEST && ts.length ? 'Nur diese Sitzung. Nichts davon wird gespeichert.' : '');
    }
    return h;
  }

  // ================================================================ Dialoge

  function dialogHtml(d) {
    if (d.type === 'newPlayer') {
      return '<div class="overlay" data-a="closeDialogBg"><form class="dialog" data-f="newPlayer"><h2>Neuer Spieler</h2><input type="text" id="dlgName" placeholder="Name" autocomplete="off" enterkeyhint="done">' +
        '<div class="two"><button type="button" class="btn" data-a="closeDialog">Abbrechen</button><button type="submit" class="btn primary">Anlegen</button></div></form></div>';
    }
    if (d.type === 'confirm') {
      return '<div class="overlay" data-a="closeDialogBg"><div class="dialog"><h2>' + esc(d.title) + '</h2>' + (d.message ? '<p>' + esc(d.message) + '</p>' : '') +
        '<div class="two"><button class="btn" data-a="closeDialog">Abbrechen</button><button class="btn ' + (d.destructive ? 'danger' : 'primary') + '" data-a="confirmOk">' + esc(d.ok) + '</button></div></div></div>';
    }
    return '';
  }
  function confirmDialog(title, message, ok, onOk, destructive) {
    ui.dialog = { type: 'confirm', title: title, message: message, ok: ok, onOk: onOk, destructive: destructive !== false };
    render();
  }

  // ================================================================ Rendern

  const TABS = [['play', 'Spielen', 'target'], ['training', 'Training', 'scope'], ['players', 'Spieler', 'people'], ['history', 'Verlauf', 'chart']];

  function viewFor(r) {
    switch (r.v) {
      case 'newGame': return viewNewGame();
      case 'trainingMenu': return viewTrainingMenu();
      case 'checkout': return viewCheckout(r);
      case 'clock': return viewClock(r);
      case 'bobs': return viewBobs(r);
      case 'halveIt': return viewHalveIt(r);
      case 'jdc': return viewJdc(r);
      case 'players': return viewPlayers();
      case 'player': return viewPlayer(r);
      case 'allGames': return viewAllGames(r);
      case 'sync': return viewSync();
      case 'history': return viewHistory();
      case 'summary': return viewSummary(r);
    }
    return '';
  }

  async function joinWithCode(code) {
    Sync.joining = true; Sync.joinError = ''; render();
    try {
      await Sync.request('POST', '/api/join', { code: code });
      Sync.joining = false;
      Sync.state = 'syncing';
      toast('Willkommen! Du bist jetzt freigeschaltet.');
      await Sync.run();
    } catch (e) {
      Sync.joining = false;
      if (e.login) Sync.state = 'loggedOut';
      Sync.joinError = e.login ? '' : (e.data && e.data.message) || (e instanceof TypeError ? 'Keine Verbindung. Bitte später noch einmal versuchen.' : 'Das hat nicht geklappt.');
      render();
    }
  }

  function viewJoin() {
    let h = '<div class="title-row" style="margin-top:28px"><h1>Willkommen</h1></div>';
    h += section('', '<div class="row" style="align-items:flex-start"><span class="mode-icon" style="width:auto">' + icon('info') + '</span><span class="grow sub" style="color:var(--fg)">' +
      'Du bist angemeldet' + (Sync.email ? ' als <b>' + esc(Sync.email) + '</b>' : '') + '. Um mitzuspielen, gib einmalig den Einladungscode ein, den du von Christian bekommen hast.</span></div>');
    h += section('Einladungscode',
      '<form class="row" data-f="join"><input class="name-input" id="joinCode" placeholder="Code" autocomplete="off" autocapitalize="none" spellcheck="false" enterkeyhint="go"' + (Sync.joining ? ' disabled' : '') + '>' +
      '<button class="btn small primary" type="submit"' + (Sync.joining ? ' disabled' : '') + '>' + (Sync.joining ? 'Prüfe …' : 'Freischalten') + '</button></form>',
      Sync.joinError ? '<span style="color:var(--triple)">' + esc(Sync.joinError) + '</span>' : 'Groß- und Kleinschreibung ist egal. Danach musst du den Code nie wieder eingeben.');
    h += '<div class="section" style="text-align:center"><a class="link-btn" href="/">Ohne Anmeldung als Gast spielen</a></div>';
    return h;
  }

  function modeBar() {
    if (GUEST) {
      return '<div class="modebar guest"><span class="grow"><b>Gastmodus</b> · Es wird nichts gespeichert.</span><a class="link-btn" href="/app/">Freunde-Login</a></div>';
    }
    if (Sync.state === 'loggedOut') {
      return '<div class="modebar warn"><span class="grow">Deine Anmeldung ist abgelaufen. Änderungen bleiben auf diesem Gerät, bis du dich wieder anmeldest.</span><button class="link-btn" data-a="relogin">Anmelden</button></div>';
    }
    return '<div class="modebar"><span class="grow ellipsis">' + (Sync.email ? esc(Sync.email) : 'Freunde-Bereich') + '</span>' + syncBadge() +
      '<a class="link-btn" href="/cdn-cgi/access/logout">Abmelden</a></div>';
  }

  function render() {
    const active = document.activeElement;
    const keepId = active && active.id && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA') ? active.id : null;
    const paste = document.getElementById('pasteBox');
    const pasteVal = paste ? paste.value : '';

    let h;
    if (ui.game) {
      h = viewGame();
    } else if (ui.party) {
      h = viewParty();
    } else {
      h = '<div class="layout"><nav class="tabbar" aria-label="Bereiche"><div class="brand">' + icon('target') + 'Darts Counter</div>' +
        TABS.map((t) => '<button class="tab" data-a="tab" data-v="' + t[0] + '"' + (ui.tab === t[0] ? ' aria-current="page"' : '') + '>' + icon(t[2]) + '<span>' + t[1] + '</span></button>').join('') +
        '</nav><main class="main">' + modeBar() + (FRIENDS && Sync.state === 'notMember' ? viewJoin() : viewFor(route())) +
        '<footer class="legal-foot"><a href="/impressum">Impressum</a> · <a href="/datenschutz">Datenschutz</a></footer></main></div>';
      if (ui.sheet === 'addPlayers') h += '<div class="sheet-wrap" data-a="closeSheetBg"><div class="sheet" role="dialog" aria-label="Spieler hinzufügen">' + sheetAddPlayers() + '</div></div>';
    }
    if (ui.dialog) h += dialogHtml(ui.dialog);
    if (ui.toast) h += '<div class="toast" role="status">' + esc(ui.toast) + '</div>';
    app.innerHTML = h;

    document.querySelectorAll('[data-chart]').forEach(drawChart);
    const newPaste = document.getElementById('pasteBox');
    if (newPaste && pasteVal) newPaste.value = pasteVal;
    if (keepId) { const el = document.getElementById(keepId); if (el) { el.focus(); } }
    if (ui.dialog && ui.dialog.type === 'newPlayer' && !keepId) { const el = document.getElementById('dlgName'); if (el) el.focus(); }
    if (ui.game && ui.game.scrollTo !== false) {
      const sb = document.getElementById('scoreboard');
      const card = sb && sb.querySelector('.pcard.active');
      if (card) sb.scrollTo({ left: card.offsetLeft - (sb.clientWidth - card.clientWidth) / 2 - sb.offsetLeft, behavior: ui.game.scrollTo ? 'smooth' : 'auto' });
      ui.game.scrollTo = false;
    }
  }

  // ================================================================ Aktionen

  const A = {
    tab(d) {
      if (ui.tab === d.v) { ui.stacks[d.v].length = 1; } // zweites Antippen = zurück zum Anfang
      ui.tab = d.v; window.scrollTo(0, 0); render();
    },
    back() { pop(); },
    relogin() { location.href = '/app/?' + Date.now(); },
    closeSheet() { ui.sheet = null; render(); },
    closeSheetBg(d, el, ev) { if (ev.target === el) { ui.sheet = null; render(); } },
    closeDialog() { ui.dialog = null; render(); },
    closeDialogBg(d, el, ev) { if (ev.target === el) { ui.dialog = null; render(); } },
    confirmOk() { const fn = ui.dialog && ui.dialog.onOk; ui.dialog = null; if (fn) fn(); render(); },

    // Neues Spiel
    legs(d) { prefs.game.legsToWin = Math.max(1, Math.min(11, prefs.game.legsToWin + +d.v)); savePrefs(); render(); },
    toggleReorder() { const r = route(); r.reorder = !r.reorder; render(); },
    moveSel(d) {
      const ids = selectedPlayers().map((p) => p.uuid);
      const i = ids.indexOf(d.id), j = i + +d.v;
      if (i < 0 || j < 0 || j >= ids.length) return;
      ids.splice(j, 0, ids.splice(i, 1)[0]);
      prefs.game.selected = ids;
      prefs.game.randomOrder = false; // Wer die Reihenfolge selbst festlegt, will sie nicht auslosen lassen.
      savePrefs(); render();
    },
    unselect(d) { prefs.game.selected = prefs.game.selected.filter((x) => x !== d.id); savePrefs(); render(); },
    openAddPlayers() { ui.sheet = 'addPlayers'; render(); },
    selectPlayer(d) { prefs.game.selected = selectedPlayers().map((p) => p.uuid).concat(d.id); savePrefs(); render(); },
    startGame() {
      const g = prefs.game;
      const order = selectedPlayers().map(asMatchPlayer);
      if (!order.length) return;
      if (g.randomOrder) for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = order[i]; order[i] = order[j]; order[j] = t; }
      if (g.variant === 'cricket' || g.variant === 'killer') {
        if (g.variant === 'killer' && order.length < 2) return;
        startParty(g.variant, order); render(); return;
      }
      startGame({ startScore: g.startScore, legsToWin: g.legsToWin, inMode: g.inMode, outMode: g.outMode }, order);
      ui.game.scrollTo = null;
      render();
    },

    // Tastenfeld (Spiel + Checkout-Training)
    mult(d) { ui.mult = ui.mult === +d.v ? 1 : +d.v; render(); },
    dart(d) {
      const s = +d.v;
      const dt = s === 0 ? D.MISS : D.dart(s, ui.mult);
      ui.mult = 1;
      buzz();
      if (ui.game) { ui.game.engine.throwDart(dt); afterGameChange(); }
      else if (ui.party) { ui.party.engine.throwDart(dt); if (ui.party.engine.isFinished) keepAwake(false); }
      else { const r = route(); if (r.engine) { r.engine.throwDart(dt); if (r.engine.isFinished) finishTraining(r); } }
      render();
    },
    undo() {
      if (ui.game) { if (!ui.game.saved) { ui.game.engine.undo(); afterGameChange(); if (!ui.game.engine.isFinished) keepAwake(true); } }
      else if (ui.party) { if (!ui.party.saved) { ui.party.engine.undo(); keepAwake(true); } }
      else { const r = route(); if (r.engine) r.engine.undo(); }
      render();
    },

    // Spiel
    quitGame() {
      const g = ui.game;
      if (g.engine.isFinished) { saveGame(); closeGame(); return; } // Gewonnenes Spiel nie verwerfen
      if (!g.engine.log.length || g.saved) { closeGame(); return; }
      g.confirmQuit = true; render();
    },
    quitConfirmed() { closeGame(); },
    quitParty() {
      const p = ui.party;
      if (p.engine.isFinished) { saveParty(); closeParty(); return; }
      if (!p.engine.log.length || p.saved) { closeParty(); return; }
      p.confirmQuit = true; render();
    },
    partyQuitCancel() { ui.party.confirmQuit = false; render(); },
    partySummary() { saveParty(); ui.party.summary = true; render(); },
    closeParty() { closeParty(); },
    variant(d) { prefs.game.variant = d.v; savePrefs(); render(); },
    killerLives(d) { prefs.game.killerLives = +d.v; savePrefs(); render(); },
    quitCancel() { ui.game.confirmQuit = false; render(); },
    showSummary() { saveGame(); ui.game.summary = true; render(); },
    closeGame() { closeGame(); },
    pickSetup() { ui.game.picking = true; render(); },
    cancelSetup() { ui.game.picking = false; render(); },
    setSetup(d) { const g = ui.game; g.setupTargets[g.engine.current.player.id] = D.dart(+d.v, D.DOUBLE); g.picking = false; render(); },
    endSetup() { const g = ui.game; delete g.setupTargets[g.engine.current.player.id]; g.picking = false; render(); },

    // Training
    openTraining(d) {
      const t = trainee();
      if (d.v === 'checkout') push({ v: 'checkout', trainee: t, engine: null });
      else if (d.v === 'aroundTheClock') push({ v: 'clock', trainee: t, engine: null });
      else if (d.v === 'halveIt') push({ v: 'halveIt', trainee: t, engine: new D.HalveItEngine() });
      else if (d.v === 'jdc') push({ v: 'jdc', trainee: t, engine: new D.JdcEngine() });
      else push({ v: 'bobs', trainee: t, engine: new D.BobsEngine() });
    },
    leaveTraining() { pop(); },
    resetTraining() { route().engine = null; route().saved = false; route().recordId = null; render(); },
    startCheckout() {
      const r = route(), c = prefs.checkout;
      r.engine = new D.CheckoutTrainingEngine(D.CheckoutTrainingEngine.randomTargets(c.targetCount, c.maxScore), c.dartsPerTarget);
      r.saved = false; r.recordId = null; ui.mult = 1; window.scrollTo(0, 0); render();
    },
    startClock() { const r = route(); r.engine = new D.AroundTheClockEngine(); r.saved = false; r.recordId = null; window.scrollTo(0, 0); render(); },
    clockHit(d) {
      const r = route(); r.engine.record(d.v === '1'); buzz();
      if (r.engine.isFinished && !r.saved) {
        const e = r.engine;
        saveTraining(r, { mode: 'aroundTheClock', score: e.darts, hits: e.hits, attempts: e.darts, dartsThrown: e.darts, detail: D.ClockVariants[prefs.clockVariant].title });
      }
      render();
    },
    clockUndoFinished() { const r = route(); r.engine.undo(); deleteTrainingRecord(r); render(); },
    trainUndo() { const r = route(); r.engine.undo(); render(); },
    trainUndoFinished() { const r = route(); r.engine.undo(); deleteTrainingRecord(r); render(); },
    restartTraining() { const r = route(); r.engine = r.v === 'jdc' ? new D.JdcEngine() : new D.HalveItEngine(); r.saved = false; r.recordId = null; ui.mult = 1; window.scrollTo(0, 0); render(); },
    jdcDouble(d) { const r = route(); r.engine.recordDouble(d.v === '1'); buzz(); if (r.engine.isFinished) finishTraining(r); render(); },
    startBobs() { const r = route(); r.engine = new D.BobsEngine(); r.saved = false; r.recordId = null; render(); },
    bobsHits(d) {
      const r = route(); r.engine.record(+d.v); buzz();
      const e = r.engine;
      if (e.isFinished && !r.saved) {
        saveTraining(r, { mode: 'bobs27', score: e.score, hits: e.totalHits, attempts: e.rounds.length * 3, dartsThrown: e.rounds.length * 3, detail: e.survived ? 'Alle Runden geschafft' : 'Ausgeschieden in Runde ' + e.rounds.length });
      }
      render();
    },
    bobsUndoFinished() { const r = route(); r.engine.undo(); deleteTrainingRecord(r); render(); },

    // Spieler
    newPlayerDialog() { ui.dialog = { type: 'newPlayer' }; render(); },
    openPlayer(d) { push({ v: 'player', id: d.id }); },
    allGames(d) { push({ v: 'allGames', id: d.id }); },
    inMode(d) { prefs.game.inMode = d.v; savePrefs(); render(); },
    outMode(d) { prefs.game.outMode = d.v; savePrefs(); render(); },
    metric(d) { route().metric = d.v; render(); },
    tmode(d) { route().tmode = d.v; render(); },
    playerColor(d) { const p = playerById(d.id); if (p) { p.colorIndex = +d.v; saveDb(); render(); } },
    deletePlayer(d) {
      const p = playerById(d.id);
      if (!p) return;
      confirmDialog(p.name + ' löschen?', 'Gespeicherte Spiele behalten ihre Statistik.', 'Löschen', () => {
        db.players = db.players.filter((x) => x.uuid !== d.id);
        prefs.game.selected = prefs.game.selected.filter((x) => x !== d.id);
        if (prefs.trainingPlayer === d.id) prefs.trainingPlayer = '';
        saveDb(); savePrefs(); pop();
      });
    },
    openSync() { if (ui.tab !== 'players') { ui.tab = 'players'; ui.stacks.players.length = 1; } push({ v: 'sync' }); },

    // Verlauf
    historyTab(d) { ui.historyTab = d.v; render(); },
    openGame(d) { push({ v: 'summary', id: d.id }); },
    deleteGame(d) {
      confirmDialog('Spiel löschen?', 'Das Spiel verschwindet aus dem Verlauf und aus der Statistik.', 'Löschen', () => {
        db.games = db.games.filter((g) => g.uuid !== d.id); saveDb();
      });
    },
    deleteTraining(d) {
      confirmDialog('Training löschen?', '', 'Löschen', () => { db.trainings = db.trainings.filter((t) => t.uuid !== d.id); saveDb(); });
    },

    // Abgleich
    exportFile() {
      const json = JSON.stringify(exportPayload(), null, 1);
      try {
        const blob = new Blob([json], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'darts-counter-' + new Date().toISOString().slice(0, 10) + '.json';
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 4000);
        toast('Export erstellt. Falls kein Download startet: in die Zwischenablage kopieren.');
      } catch (e) { toast('Download nicht möglich. Bitte in die Zwischenablage kopieren.'); }
    },
    exportCopy() {
      const json = JSON.stringify(exportPayload());
      const fallback = () => {
        const box = document.getElementById('pasteBox');
        if (box) { box.value = json; box.focus(); box.select(); }
        toast('Kopieren nicht erlaubt. Der Text steht unten im Feld und ist markiert.');
      };
      try { navigator.clipboard.writeText(json).then(() => toast('Export kopiert. Auf dem anderen Gerät unter „Importieren“ einfügen.'), fallback); } catch (e) { fallback(); }
    },
    importPaste() {
      const box = document.getElementById('pasteBox');
      const text = box ? box.value.trim() : '';
      if (!text) return toast('Füge zuerst den exportierten Text ein.');
      box.value = '';
      importText(text);
    }
  };

  function finishTraining(r) {
    const e = r.engine;
    if (r.saved) return;
    if (r.v === 'halveIt') {
      saveTraining(r, { mode: 'halveIt', score: e.score, hits: e.hitRounds, attempts: e.rounds.length, dartsThrown: e.log.length, detail: e.halvedCount ? e.halvedCount + '-mal halbiert' : 'Nie halbiert' });
      window.scrollTo(0, 0); return;
    }
    if (r.v === 'jdc') {
      saveTraining(r, { mode: 'jdc', score: e.total, hits: e.doublesHit, attempts: 21, dartsThrown: e.darts, detail: 'Stufe ' + D.JdcEngine.grade(e.total) + ' · ' + e.parts.join(' / ') });
      window.scrollTo(0, 0); return;
    }
    const c = prefs.checkout;
    saveTraining(r, { mode: 'checkout', score: e.successCount, hits: e.successCount, attempts: e.results.length, dartsThrown: e.totalDarts, detail: 'Zahlen 2–' + c.maxScore + ', ' + e.dartsPerTarget + ' Darts pro Zahl' });
    window.scrollTo(0, 0);
  }

  // Änderungen an Eingabefeldern
  const C = {
    startScore(el) { prefs.game.startScore = +el.value; savePrefs(); },
    randomOrder(el) { prefs.game.randomOrder = el.checked; savePrefs(); render(); },
    trainingPlayer(el) { prefs.trainingPlayer = el.value; savePrefs(); render(); },
    targetCount(el) { prefs.checkout.targetCount = +el.value; savePrefs(); },
    dartsPerTarget(el) { prefs.checkout.dartsPerTarget = +el.value; savePrefs(); },
    maxScore(el) { prefs.checkout.maxScore = +el.value; savePrefs(); },
    clockVariant(el) { if (el.checked) { prefs.clockVariant = el.value; savePrefs(); } },
    deviceName(el) { prefs.deviceName = el.value.trim(); savePrefs(); },
    playerName(el) {
      const p = playerById(el.dataset.id);
      const name = el.value.trim();
      if (p && name) { p.name = name; saveDb(); render(); } else if (p) { el.value = p.name; }
    },
    importFile(el) {
      const f = el.files && el.files[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => importText(String(reader.result));
      reader.onerror = () => toast('Die Datei konnte nicht gelesen werden.');
      reader.readAsText(f);
      el.value = '';
    }
  };
  const F = {
    join(form) {
      const code = form.querySelector('#joinCode').value.trim();
      if (!code) { Sync.joinError = 'Bitte den Code eingeben.'; render(); return; }
      joinWithCode(code);
    },
    newPlayer(form) {
      const name = form.querySelector('#dlgName').value;
      ui.dialog = null;
      if (createPlayer(name)) render(); else render();
    },
    createSelect(form) {
      const input = form.querySelector('#newPlayerName');
      const p = createPlayer(input.value);
      if (p) { prefs.game.selected = selectedPlayers().map((x) => x.uuid).concat(p.uuid); savePrefs(); }
      input.value = '';
      render();
    }
  };

  app.addEventListener('click', (ev) => {
    const el = ev.target.closest('[data-a]');
    if (!el || el.disabled) return;
    const fn = A[el.dataset.a];
    if (fn) fn(el.dataset, el, ev);
  });
  app.addEventListener('change', (ev) => {
    const el = ev.target.closest('[data-c]');
    if (el && C[el.dataset.c]) C[el.dataset.c](el);
  });
  app.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const f = ev.target.closest('[data-f]');
    if (f && F[f.dataset.f]) F[f.dataset.f](f);
  });
  app.addEventListener('pointerdown', (ev) => { if (ev.target.closest('[data-plot]')) chartPointer(ev); });
  app.addEventListener('pointermove', (ev) => { if (ev.buttons || ev.pointerType === 'mouse') { if (ev.target.closest('[data-plot]')) chartPointer(ev); } });
  app.addEventListener('pointerup', (ev) => { if (ev.pointerType !== 'mouse') chartRelease(ev); });
  app.addEventListener('pointerleave', (ev) => { if (ev.target.matches && ev.target.matches('[data-chart]')) chartRelease(ev); }, true);
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      if (ui.dialog) { ui.dialog = null; render(); }
      else if (ui.sheet) { ui.sheet = null; render(); }
      else if (ui.game && ui.game.picking) { ui.game.picking = false; render(); }
      else if (ui.party && ui.party.confirmQuit) { ui.party.confirmQuit = false; render(); }
    }
  });
  let resizeTimer = null;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(render, 120); });

  // Laufendes Spiel nach einem Neuladen wiederherstellen
  const active = LS.get(KEY_ACTIVE, null);
  if (active && active.settings && Array.isArray(active.players) && active.players.length) {
    try { startGame(active.settings, active.players, active.log || []); ui.game.scrollTo = null; } catch (e) { LS.del(KEY_ACTIVE); ui.game = null; }
  }
  render();
  if (FRIENDS) Sync.schedule(0);
})();
