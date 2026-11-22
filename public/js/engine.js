/*
 * Darts Counter – Spiellogik
 * 1:1 portiert aus der iOS-App (Engine/*.swift). Keine Abhängigkeiten zur Oberfläche.
 */
(function (global) {
  'use strict';

  // ---------------------------------------------------------------- Dart

  const SINGLE = 1, DOUBLE = 2, TRIPLE = 3;

  /** Ein einzelner Dart. s: 0 = daneben, 1…20, 25 = Bull. m: 1/2/3 */
  function dart(s, m) { return { s: s, m: m || SINGLE }; }
  const MISS = dart(0, SINGLE);
  const score = (d) => d.s * d.m;
  const isDouble = (d) => d.m === DOUBLE && d.s > 0;
  function label(d) {
    if (d.s === 0) return 'Miss';
    if (d.s === 25) return d.m === DOUBLE ? 'Bull' : '25';
    if (d.m === SINGLE) return String(d.s);
    return (d.m === DOUBLE ? 'D' : 'T') + d.s;
  }
  const sum = (darts) => darts.reduce((a, d) => a + score(d), 0);

  // ---------------------------------------------------------------- CheckoutCalculator

  const Checkout = (function () {
    const preferredDoubles = [20, 16, 18, 12, 10, 8, 19, 17, 15, 14, 13, 11, 9, 7, 6, 5, 4, 3, 2, 1, 25];

    const setupDarts = [];
    for (let s = 20; s >= 1; s--) setupDarts.push(dart(s, TRIPLE));
    setupDarts.push(dart(25, DOUBLE));
    setupDarts.push(dart(25, SINGLE));
    for (let s = 20; s >= 1; s--) setupDarts.push(dart(s, SINGLE));
    for (let s = 20; s >= 1; s--) setupDarts.push(dart(s, DOUBLE));

    const setupCandidates = [];
    for (let s = 20; s >= 1; s--) setupCandidates.push(dart(s, SINGLE));
    for (let s = 20; s >= 1; s--) setupCandidates.push(dart(s, TRIPLE));
    setupCandidates.push(dart(25, SINGLE));
    for (let s = 20; s >= 1; s--) setupCandidates.push(dart(s, DOUBLE));
    setupCandidates.push(dart(25, DOUBLE));

    const cache = new Map();
    const setupCache = new Map();

    function isOneDartFinish(remaining, doubleOut) {
      if (remaining <= 0) return false;
      if (doubleOut) return remaining === 50 || (remaining <= 40 && remaining % 2 === 0);
      if (remaining <= 20 || remaining === 25 || remaining === 50) return true;
      if (remaining <= 40 && remaining % 2 === 0) return true;
      if (remaining <= 60 && remaining % 3 === 0) return true;
      return false;
    }

    function finishingDouble(remaining) {
      if (remaining === 50) return dart(25, DOUBLE);
      if (remaining >= 2 && remaining <= 40 && remaining % 2 === 0) return dart(remaining / 2, DOUBLE);
      return null;
    }

    function doubleRank(d) {
      const i = preferredDoubles.indexOf(d.s);
      return i < 0 ? 99 : i;
    }

    function search(remaining, darts) {
      if (darts === 1) {
        const f = finishingDouble(remaining);
        return f ? [f] : null;
      }
      let best = null, bestRank = Infinity;
      for (let index = 0; index < setupDarts.length; index++) {
        const first = setupDarts[index];
        const rest = remaining - score(first);
        if (rest < 2) continue;
        const tail = search(rest, darts - 1);
        if (!tail) continue;
        const rank = doubleRank(tail[tail.length - 1]) * 1000 + index;
        if (rank < bestRank) { bestRank = rank; best = [first].concat(tail); }
      }
      return best;
    }

    /** Finish-Vorschlag mit möglichst wenigen Darts, oder null. */
    function suggestion(remaining, dartsLeft) {
      if (dartsLeft === undefined) dartsLeft = 3;
      if (remaining < 2 || remaining > 170 || dartsLeft < 1) return null;
      const key = remaining * 10 + Math.min(dartsLeft, 3);
      if (cache.has(key)) { const c = cache.get(key); return c.length ? c : null; }
      let result = null;
      for (let count = 1; count <= Math.min(3, dartsLeft); count++) {
        const found = search(remaining, count);
        if (found) { result = found; break; }
      }
      cache.set(key, result || []);
      return result;
    }

    function setupCost(d) {
      if (d.s === 25) return d.m === DOUBLE ? 40 : 35;
      if (d.m === SINGLE) return 10;
      if (d.m === DOUBLE) return 38;
      if (d.s === 20) return 30;
      if (d.s === 19) return 31;
      if (d.s === 18) return 32;
      return 34;
    }

    function bestSetup(sc, darts) {
      if (sc <= 0 || darts <= 0) return null;
      const key = sc * 10 + darts;
      if (setupCache.has(key)) { const c = setupCache.get(key); return c.length ? c : null; }
      let best = null, bestCost = Infinity;
      for (const d of setupCandidates) {
        if (score(d) > sc) continue;
        let path;
        if (score(d) === sc) path = [d];
        else if (darts > 1) {
          const tail = bestSetup(sc - score(d), darts - 1);
          if (!tail) continue;
          path = [d].concat(tail);
        } else continue;
        const cost = path.reduce((a, x) => a + setupCost(x), 0);
        if (cost < bestCost) { bestCost = cost; best = path; }
      }
      setupCache.set(key, best || []);
      return best;
    }

    /** Einfachster Weg von remaining auf target (z. B. 160 → 32 = T20 · T20 · 8). */
    function setupPath(remaining, target, dartsLeft) {
      if (dartsLeft === undefined) dartsLeft = 3;
      const sc = remaining - target;
      if (sc <= 0 || dartsLeft < 1) return null;
      const p = bestSetup(sc, Math.min(dartsLeft, 3));
      // Stabile Sortierung: größte Würfe zuerst
      return p ? p.slice().sort((a, b) => score(b) - score(a)) : null;
    }

    return { isOneDartFinish, suggestion, setupPath };
  })();

  // ---------------------------------------------------------------- X01

  function settingsTitle(st) {
    let t = String(st.startScore);
    if (st.masterIn) t += ' · Masters In';
    t += ' · ' + (st.doubleOut ? 'Double Out' : 'Single Out');
    if (st.legsToWin > 1) t += ' · First to ' + st.legsToWin;
    return t;
  }

  const countingDarts = (v) => v.darts.slice(v.dartsBeforeIn || 0);
  const visitScored = (v) => v.bust ? 0 : sum(countingDarts(v));

  function stateDarts(st) { return st.visits.reduce((a, v) => a + v.darts.length, 0); }
  function statePoints(st) { return st.visits.reduce((a, v) => a + visitScored(v), 0); }
  function stateAverage(st) { const d = stateDarts(st); return d === 0 ? 0 : statePoints(st) / d * 3; }

  class X01Engine {
    /** settings: {startScore, legsToWin, doubleOut, masterIn}; players: [{id, name, colorIndex}] */
    constructor(settings, players) {
      this.settings = Object.assign({ startScore: 501, legsToWin: 1, doubleOut: true, masterIn: false }, settings);
      this.players = players;
      this.log = [];
      this._reset();
    }

    get isFinished() { return this.winnerIndex !== null; }
    get current() { return this.states[this.currentIndex]; }
    get dartsLeftInVisit() { return 3 - this.currentDarts.length; }
    get winnerName() { return this.winnerIndex === null ? null : this.states[this.winnerIndex].player.name; }

    get checkoutSuggestion() {
      if (this.isFinished || !this.settings.doubleOut || !this.current.isIn) return null;
      return Checkout.suggestion(this.current.remaining, this.dartsLeftInVisit);
    }

    throwDart(d) {
      if (this.isFinished) return;
      this.log.push(d);
      this._apply(d);
    }

    undo() {
      if (!this.log.length) return;
      this.log.pop();
      const darts = this.log.slice();
      this._reset();
      for (const d of darts) this._apply(d);
    }

    matchStats() {
      return this.states.map((st, i) => playerMatchStats(st, i === this.winnerIndex, this.settings.doubleOut));
    }

    _reset() {
      const s = this.settings;
      this.states = this.players.map((p) => ({ player: p, remaining: s.startScore, isIn: !s.masterIn, legsWon: 0, visits: [] }));
      this.currentIndex = 0;
      this.currentDarts = [];
      this.legIndex = 0;
      this.legStarter = 0;
      this.winnerIndex = null;
      this.lastMessage = null;
      this.visitStart = s.startScore;
      this.visitStartIsIn = !s.masterIn;
      this.dartsBeforeIn = 0;
    }

    _apply(d) {
      this.currentDarts.push(d);
      const st = this.states[this.currentIndex];

      // Masters In: Bis zum ersten Doppel zählt kein Dart.
      if (!st.isIn) {
        if (isDouble(d)) {
          st.isIn = true;
        } else {
          this.dartsBeforeIn += 1;
          if (this.currentDarts.length === 3) this._endVisit(false, false);
          return;
        }
      }

      const newRemaining = st.remaining - score(d);
      const bust = this.settings.doubleOut
        ? (newRemaining < 0 || newRemaining === 1 || (newRemaining === 0 && !isDouble(d)))
        : newRemaining < 0;

      if (bust) { this._endVisit(true, false); return; }
      st.remaining = newRemaining;
      if (newRemaining === 0) this._endVisit(false, true);
      else if (this.currentDarts.length === 3) this._endVisit(false, false);
    }

    _endVisit(bust, checkout) {
      const st = this.states[this.currentIndex];
      const visit = {
        leg: this.legIndex,
        startRemaining: this.visitStart,
        darts: this.currentDarts,
        bust: bust,
        checkout: checkout,
        dartsBeforeIn: this.dartsBeforeIn
      };
      st.visits.push(visit);
      this.currentDarts = [];
      this.dartsBeforeIn = 0;
      const name = st.player.name;

      if (bust) {
        st.remaining = this.visitStart;
        st.isIn = this.visitStartIsIn;
        this.lastMessage = 'Bust! ' + name + ' bleibt auf ' + this.visitStart;
      } else if (!st.isIn) {
        this.lastMessage = name + ': kein Doppel – noch nicht eröffnet';
      } else if (!checkout) {
        this.lastMessage = name + ': ' + visitScored(visit);
      }

      if (checkout) {
        st.legsWon += 1;
        if (st.legsWon >= this.settings.legsToWin) {
          this.winnerIndex = this.currentIndex;
          this.lastMessage = name + ' gewinnt mit ' + visitScored(visit) + ' Finish!';
          return;
        }
        this.lastMessage = name + ' gewinnt Leg ' + (this.legIndex + 1) + ' (' + visitScored(visit) + ' Finish)';
        this.legIndex += 1;
        for (const s of this.states) { s.remaining = this.settings.startScore; s.isIn = !this.settings.masterIn; }
        this.legStarter = (this.legStarter + 1) % this.states.length;
        this.currentIndex = this.legStarter;
      } else {
        this.currentIndex = (this.currentIndex + 1) % this.states.length;
      }
      this.visitStart = this.states[this.currentIndex].remaining;
      this.visitStartIsIn = this.states[this.currentIndex].isIn;
    }
  }

  // ---------------------------------------------------------------- PlayerMatchStats

  function emptyStats(id, name, colorIndex) {
    return {
      id: id, name: name, colorIndex: colorIndex || 0, won: false, legsWon: 0,
      dartsThrown: 0, pointsScored: 0, first9Points: 0, first9Darts: 0,
      checkoutAttempts: 0, checkoutHits: 0, highestVisit: 0, highestCheckout: 0,
      count180: 0, count140: 0, count100: 0, bestLeg: 0
    };
  }

  function playerMatchStats(state, won, doubleOut) {
    const s = emptyStats(state.player.id, state.player.name, state.player.colorIndex);
    s.won = won;
    s.legsWon = state.legsWon;
    s.dartsThrown = stateDarts(state);
    s.pointsScored = statePoints(state);

    const visitsPerLeg = {}, dartsPerLeg = {};
    for (const visit of state.visits) {
      const n = visitsPerLeg[visit.leg] || 0;
      const scored = visitScored(visit);
      if (n < 3) { s.first9Points += scored; s.first9Darts += visit.darts.length; }
      visitsPerLeg[visit.leg] = n + 1;
      dartsPerLeg[visit.leg] = (dartsPerLeg[visit.leg] || 0) + visit.darts.length;

      s.highestVisit = Math.max(s.highestVisit, scored);
      if (scored === 180) s.count180++;
      else if (scored >= 140) s.count140++;
      else if (scored >= 100) s.count100++;

      let remaining = visit.startRemaining;
      for (const d of countingDarts(visit)) {
        if (Checkout.isOneDartFinish(remaining, doubleOut)) s.checkoutAttempts++;
        remaining -= score(d);
      }

      if (visit.checkout) {
        s.checkoutHits++;
        s.highestCheckout = Math.max(s.highestCheckout, scored);
        const legDarts = dartsPerLeg[visit.leg] || 0;
        s.bestLeg = s.bestLeg === 0 ? legDarts : Math.min(s.bestLeg, legDarts);
      }
    }
    return s;
  }

  const statsAverage = (s) => s.dartsThrown > 0 ? s.pointsScored / s.dartsThrown * 3 : 0;
  const statsFirst9 = (s) => s.first9Darts > 0 ? s.first9Points / s.first9Darts * 3 : 0;

  /** Zusammenfassung über alle Spiele eines Spielers (results = Liste von stats). */
  function lifetimeStats(results) {
    const L = { games: 0, wins: 0, darts: 0, points: 0, attempts: 0, hits: 0, highestVisit: 0, highestCheckout: 0, count180: 0, bestLeg: 0 };
    for (const r of results) {
      L.games++;
      if (r.won) L.wins++;
      L.darts += r.dartsThrown;
      L.points += r.pointsScored;
      L.attempts += r.checkoutAttempts;
      L.hits += r.checkoutHits;
      L.highestVisit = Math.max(L.highestVisit, r.highestVisit);
      L.highestCheckout = Math.max(L.highestCheckout, r.highestCheckout);
      L.count180 += r.count180;
      if (r.bestLeg > 0) L.bestLeg = L.bestLeg === 0 ? r.bestLeg : Math.min(L.bestLeg, r.bestLeg);
    }
    L.average = L.darts > 0 ? L.points / L.darts * 3 : 0;
    return L;
  }

  // ---------------------------------------------------------------- Checkout-Training

  class CheckoutTrainingEngine {
    constructor(targets, dartsPerTarget) {
      this.targets = targets;
      this.dartsPerTarget = dartsPerTarget;
      this.log = [];
      this._reset();
    }

    /** Zufallszahlen von 2 bis maxScore, die mit 3 Darts auf Double checkbar sind. */
    static randomTargets(count, maxScore) {
      const upper = Math.max(2, Math.min(maxScore, 170));
      const pool = [];
      for (let n = 2; n <= upper; n++) if (Checkout.suggestion(n, 3)) pool.push(n);
      const out = [];
      for (let i = 0; i < count; i++) out.push(pool.length ? pool[Math.floor(Math.random() * pool.length)] : 40);
      return out;
    }

    get index() { return this.results.length; }
    get isFinished() { return this.results.length >= this.targets.length; }
    get currentTarget() { return this.isFinished ? 0 : this.targets[this.index]; }
    get dartsLeftForTarget() { return this.dartsPerTarget - this.dartsUsed; }
    get dartsLeftInVisit() { return 3 - this.visitDarts.length; }
    get successCount() { return this.results.filter((r) => r.success).length; }
    get totalDarts() { return this.log.length; }
    get averageDartsPerCheckout() {
      const ok = this.results.filter((r) => r.success);
      if (!ok.length) return null;
      return ok.reduce((a, r) => a + r.darts, 0) / ok.length;
    }
    get suggestion() {
      if (this.isFinished) return null;
      return Checkout.suggestion(this.remaining, this.dartsLeftInVisit);
    }

    throwDart(d) {
      if (this.isFinished) return;
      this.log.push(d);
      this._apply(d);
    }

    undo() {
      if (!this.log.length) return;
      this.log.pop();
      const darts = this.log.slice();
      this._reset();
      for (const d of darts) this._apply(d);
    }

    _reset() {
      this.results = [];
      this.visitDarts = [];
      this.dartsUsed = 0;
      this.dartsThrownForTarget = 0;
      this.lastMessage = null;
      this.remaining = this.targets.length ? this.targets[0] : 0;
      this.visitStart = this.remaining;
    }

    _apply(d) {
      this.visitDarts.push(d);
      this.dartsUsed++;
      this.dartsThrownForTarget++;
      const target = this.currentTarget;
      const newRemaining = this.remaining - score(d);

      if (newRemaining < 0 || newRemaining === 1 || (newRemaining === 0 && !isDouble(d))) {
        // Bust: Rest der Aufnahme verfällt
        this.dartsUsed += 3 - this.visitDarts.length;
        this.visitDarts = [];
        this.remaining = this.visitStart;
        this.lastMessage = 'Bust – zurück auf ' + this.visitStart;
        if (this.dartsUsed >= this.dartsPerTarget) {
          this.lastMessage = target + ' nicht gecheckt';
          this._finishTarget(false);
        }
        return;
      }

      this.remaining = newRemaining;
      if (newRemaining === 0) {
        this.lastMessage = target + ' gecheckt!';
        this._finishTarget(true);
        return;
      }
      if (this.visitDarts.length === 3) {
        this.visitDarts = [];
        this.visitStart = this.remaining;
        this.lastMessage = null;
      }
      if (this.dartsUsed >= this.dartsPerTarget) {
        this.lastMessage = target + ' nicht gecheckt';
        this._finishTarget(false);
      }
    }

    _finishTarget(success) {
      this.results.push({ target: this.targets[this.index], success: success, darts: this.dartsThrownForTarget });
      this.visitDarts = [];
      this.dartsUsed = 0;
      this.dartsThrownForTarget = 0;
      this.remaining = this.currentTarget;
      this.visitStart = this.remaining;
    }
  }

  // ---------------------------------------------------------------- Rund um die Uhr

  const ClockVariants = {
    single: { title: 'Beliebiges Segment' },
    double: { title: 'Nur Doubles' },
    triple: { title: 'Nur Triples' }
  };
  function clockLabel(variant, target) {
    if (target === 25) return variant === 'double' ? 'Bull' : 'Bull / 25';
    if (variant === 'single') return String(target);
    return (variant === 'double' ? 'D' : 'T') + target;
  }

  const BOARD_TARGETS = [];
  for (let i = 1; i <= 20; i++) BOARD_TARGETS.push(i);
  BOARD_TARGETS.push(25);

  class AroundTheClockEngine {
    constructor() { this.log = []; }
    static get targets() { return BOARD_TARGETS; }
    get hits() { return this.log.filter(Boolean).length; }
    get darts() { return this.log.length; }
    get isFinished() { return this.hits >= BOARD_TARGETS.length; }
    get currentTarget() { return this.isFinished ? 25 : BOARD_TARGETS[this.hits]; }
    record(hit) { if (!this.isFinished) this.log.push(!!hit); }
    undo() { if (this.log.length) this.log.pop(); }
  }

  // ---------------------------------------------------------------- Bob's 27

  class BobsEngine {
    constructor() { this.rounds = []; }
    static get targets() { return BOARD_TARGETS; }
    static value(t) { return t === 25 ? 50 : t * 2; }
    static label(t) { return t === 25 ? 'Bull' : 'D' + t; }
    get score() {
      let total = 27;
      this.rounds.forEach((hits, i) => {
        const v = BobsEngine.value(BOARD_TARGETS[i]);
        total += hits === 0 ? -v : hits * v;
      });
      return total;
    }
    get isFinished() { return this.rounds.length >= BOARD_TARGETS.length || this.score <= 0; }
    get survived() { return this.rounds.length >= BOARD_TARGETS.length && this.score > 0; }
    get currentTarget() { return BOARD_TARGETS[Math.min(this.rounds.length, BOARD_TARGETS.length - 1)]; }
    get totalHits() { return this.rounds.reduce((a, b) => a + b, 0); }
    record(hits) { if (!this.isFinished) this.rounds.push(Math.max(0, Math.min(3, hits))); }
    undo() { if (this.rounds.length) this.rounds.pop(); }
  }

  // ---------------------------------------------------------------- Trainingsmodi

  const TrainingModes = {
    checkout: {
      title: 'Checkout-Training', short: 'Checkout', chartTitle: 'Checkout-Quote',
      info: 'Du bekommst eine zufällige Zahl (Standard 2 bis 120) und musst sie mit Double Out auschecken. Bust setzt dich auf den Stand vor der Aufnahme zurück.'
    },
    aroundTheClock: {
      title: 'Rund um die Uhr', short: 'Uhr', chartTitle: 'Benötigte Darts',
      info: 'Triff nacheinander 1 bis 20 und zum Schluss das Bull. Gezählt wird, wie viele Darts du brauchst.'
    },
    bobs27: {
      title: "Bob's 27", short: "Bob's 27", chartTitle: 'Punkte',
      info: 'Du startest mit 27 Punkten und wirfst je 3 Darts auf D1 bis D20 und Bull. Jeder Treffer bringt den Wert des Doubles, keine Treffer ziehen ihn ab. Bei 0 oder weniger ist Schluss.'
    }
  };

  function trainingResultText(r) {
    if (r.mode === 'aroundTheClock') return r.dartsThrown + ' Darts';
    if (r.mode === 'bobs27') return r.score + ' Punkte';
    return r.hits + ' von ' + r.attempts + ' gecheckt';
  }

  // ---------------------------------------------------------------- Abgleich (Export/Import)

  const normalized = (n) => String(n || '').trim().toLowerCase();

  /**
   * Übernimmt alles aus payload, was in db noch fehlt (gleiche Regeln wie SyncMerger in der iOS-App).
   * Spieler werden über ID, dann über den Namen zugeordnet. Spiele/Trainings über ihre uuid.
   */
  function mergePayload(db, payload, uuid) {
    const result = { players: 0, games: 0, trainings: 0 };
    const knownGames = new Set(db.games.map((g) => g.uuid));
    const knownTrainings = new Set(db.trainings.map((t) => t.uuid));
    const map = {};

    for (const inc of payload.players || []) {
      const match = db.players.find((p) => p.uuid === inc.uuid) || db.players.find((p) => normalized(p.name) === normalized(inc.name));
      if (match) map[inc.uuid] = match;
      else {
        const p = { uuid: inc.uuid || uuid(), name: inc.name, colorIndex: inc.colorIndex || 0, createdAt: inc.createdAt || new Date().toISOString() };
        db.players.push(p);
        map[inc.uuid] = p;
        result.players++;
      }
    }

    for (const g of payload.games || []) {
      if (knownGames.has(g.uuid)) continue;
      const game = {
        uuid: g.uuid, date: g.date, startScore: g.startScore, legsToWin: g.legsToWin,
        doubleOut: g.doubleOut, masterIn: !!g.masterIn, winnerName: g.winnerName || '',
        results: (g.results || []).map((r) => {
          const stats = Object.assign({}, r.stats);
          const p = map[stats.id];
          if (p) { stats.id = p.uuid; stats.name = p.name; }
          return { order: r.order, stats: stats };
        })
      };
      db.games.push(game);
      result.games++;
    }

    for (const t of payload.trainings || []) {
      if (knownTrainings.has(t.uuid)) continue;
      const p = t.playerID ? map[t.playerID] : null;
      db.trainings.push({
        uuid: t.uuid, date: t.date, mode: t.mode || t.modeRaw || 'checkout', detail: t.detail || '',
        playerID: p ? p.uuid : (t.playerID || null), playerName: p ? p.name : (t.playerName || 'Gast'),
        score: t.score, hits: t.hits, attempts: t.attempts, dartsThrown: t.dartsThrown
      });
      result.trainings++;
    }
    return result;
  }

  function mergeSummary(r) {
    if (!r.players && !r.games && !r.trainings) return 'Alles war schon auf dem neuesten Stand.';
    const parts = [];
    if (r.games) parts.push(r.games + ' ' + (r.games === 1 ? 'Spiel' : 'Spiele'));
    if (r.trainings) parts.push(r.trainings + ' ' + (r.trainings === 1 ? 'Training' : 'Trainings'));
    if (r.players) parts.push(r.players + ' Spieler');
    const text = parts.length > 1 ? parts.slice(0, -1).join(', ') + ' und ' + parts[parts.length - 1] : parts[0];
    return text + ' übernommen.';
  }

  // ---------------------------------------------------------------- Testdaten (wie SampleGameGenerator)

  const Sample = (function () {
    const boardOrder = [20, 1, 18, 4, 13, 6, 10, 15, 2, 17, 3, 19, 7, 16, 8, 11, 14, 9, 12, 5];
    const variants = [
      { startScore: 501, legsToWin: 1, doubleOut: true, masterIn: false },
      { startScore: 501, legsToWin: 2, doubleOut: true, masterIn: false },
      { startScore: 301, legsToWin: 1, doubleOut: true, masterIn: false },
      { startScore: 501, legsToWin: 3, doubleOut: true, masterIn: false },
      { startScore: 701, legsToWin: 1, doubleOut: true, masterIn: false },
      { startScore: 301, legsToWin: 2, doubleOut: true, masterIn: true },
      { startScore: 501, legsToWin: 1, doubleOut: false, masterIn: false },
      { startScore: 501, legsToWin: 2, doubleOut: true, masterIn: true },
      { startScore: 101, legsToWin: 3, doubleOut: true, masterIn: false },
      { startScore: 501, legsToWin: 1, doubleOut: true, masterIn: false }
    ];
    const rnd = Math.random;
    const pick = (a) => a[Math.floor(rnd() * a.length)];

    function neighbor(seg) {
      const i = boardOrder.indexOf(seg);
      if (i < 0) return seg;
      const off = rnd() < 0.5 ? 1 : -1;
      return boardOrder[(i + off + boardOrder.length) % boardOrder.length];
    }

    function throwAt(t, skill) {
      const roll = rnd();
      if (t.s === 25) {
        const bull = t.m === DOUBLE ? 0.10 * skill : 0.35 * skill;
        if (roll < bull) return t;
        if (roll < bull + 0.35) return dart(25, SINGLE);
        return dart(pick(boardOrder), SINGLE);
      }
      const seg = t.s;
      if (t.m === TRIPLE) {
        const hit = 0.18 * skill;
        if (roll < hit) return t;
        if (roll < hit + 0.55) return dart(seg, SINGLE);
        if (roll < hit + 0.95) return dart(neighbor(seg), SINGLE);
        return dart(neighbor(seg), TRIPLE);
      }
      if (t.m === DOUBLE) {
        const hit = 0.22 * skill;
        if (roll < hit) return t;
        if (roll < hit + 0.35) return dart(seg, SINGLE);
        if (roll < hit + 0.45) return dart(neighbor(seg), SINGLE);
        return MISS;
      }
      if (roll < 0.85) return t;
      if (roll < 0.97) return dart(neighbor(seg), SINGLE);
      return dart(seg, TRIPLE);
    }

    function setupAim(remaining, dartsLeft) {
      if (remaining <= 100) {
        const target = remaining > 32 ? 32 : Math.floor((remaining - 1) / 2) * 2;
        if (target >= 2) {
          const p = Checkout.setupPath(remaining, target, dartsLeft);
          if (p && p.length) return p[0];
        }
      }
      return dart(20, TRIPLE);
    }

    function aim(e) {
      const st = e.current, rem = st.remaining;
      if (!st.isIn) return dart(20, DOUBLE);
      const sug = e.checkoutSuggestion;
      if (sug) return sug[0];
      if (!e.settings.doubleOut) {
        if (rem <= 20) return dart(rem, SINGLE);
        if (rem <= 60 && rem % 3 === 0) return dart(rem / 3, TRIPLE);
        if (rem < 60) return dart(20, SINGLE);
        return dart(20, TRIPLE);
      }
      return setupAim(rem, e.dartsLeftInVisit);
    }

    const progress = (i, n) => n > 1 ? i / (n - 1) : 1;
    const improved = (base, p) => base * (0.85 + 0.3 * p);
    const sampleDate = (i, n) => new Date(Date.now() - (n - i) * 60 * 60 * 17 * 1000).toISOString();

    /** Simuliert count komplette Spiele. players: [{uuid,name,colorIndex}] (mind. 2). */
    function games(players, count, uuid) {
      const skills = {};
      players.forEach((p) => { skills[p.uuid] = 0.6 + rnd() * 0.8; });
      const out = [];
      for (let gi = 0; gi < count; gi++) {
        const settings = variants[gi % variants.length];
        const n = Math.min(players.length, 2 + Math.floor(rnd() * 2));
        const mp = players.slice().sort(() => rnd() - 0.5).slice(0, n).map((p) => ({ id: p.uuid, name: p.name, colorIndex: p.colorIndex }));
        const pr = progress(gi, count);
        const e = new X01Engine(settings, mp);
        let safety = 0;
        while (!e.isFinished && safety < 5000) {
          const skill = improved(skills[e.current.player.id] || 1, pr);
          e.throwDart(throwAt(aim(e), skill));
          safety++;
        }
        if (!e.isFinished) continue;
        out.push({
          uuid: uuid(), date: sampleDate(gi, count), startScore: settings.startScore, legsToWin: settings.legsToWin,
          doubleOut: settings.doubleOut, masterIn: settings.masterIn, winnerName: e.winnerName || '',
          results: e.matchStats().map((s, order) => ({ order: order, stats: s }))
        });
      }
      return out;
    }

    function trainings(players, count, uuid) {
      const modes = ['checkout', 'aroundTheClock', 'bobs27'];
      const out = [];
      for (const p of players) {
        const base = 0.6 + rnd() * 0.8;
        for (let i = 0; i < count; i++) {
          const skill = improved(base, progress(i, count));
          let r;
          const mode = modes[i % modes.length];
          if (mode === 'checkout') {
            const maxScore = pick([60, 80, 100, 120]);
            const dpt = pick([3, 6]);
            const e = new CheckoutTrainingEngine(CheckoutTrainingEngine.randomTargets(10, maxScore), dpt);
            let safety = 0;
            while (!e.isFinished && safety < 2000) {
              const sug = e.suggestion;
              const t = sug ? sug[0] : setupAim(e.remaining, e.dartsLeftInVisit);
              e.throwDart(throwAt(t, skill));
              safety++;
            }
            r = { mode: mode, score: e.successCount, hits: e.successCount, attempts: e.results.length, dartsThrown: e.totalDarts, detail: 'Zahlen 2–' + maxScore + ', ' + dpt + ' Darts pro Zahl' };
          } else if (mode === 'aroundTheClock') {
            const variant = pick(['single', 'single', 'double', 'triple']);
            const baseChance = variant === 'single' ? 0.45 : variant === 'double' ? 0.16 : 0.15;
            const e = new AroundTheClockEngine();
            let safety = 0;
            while (!e.isFinished && safety < 3000) {
              const chance = baseChance * skill * (e.currentTarget === 25 ? 0.6 : 1);
              e.record(rnd() < chance);
              safety++;
            }
            r = { mode: mode, score: e.darts, hits: e.hits, attempts: e.darts, dartsThrown: e.darts, detail: ClockVariants[variant].title };
          } else {
            const e = new BobsEngine();
            while (!e.isFinished) {
              const chance = (e.currentTarget === 25 ? 0.10 : 0.22) * skill;
              let hits = 0;
              for (let k = 0; k < 3; k++) if (rnd() < chance) hits++;
              e.record(hits);
            }
            r = { mode: mode, score: e.score, hits: e.totalHits, attempts: e.rounds.length * 3, dartsThrown: e.rounds.length * 3, detail: e.survived ? 'Alle Runden geschafft' : 'Ausgeschieden in Runde ' + e.rounds.length };
          }
          r.uuid = uuid();
          r.date = sampleDate(i, count);
          r.playerID = p.uuid;
          r.playerName = p.name;
          out.push(r);
        }
      }
      return out;
    }

    return { games, trainings };
  })();

  global.Darts = {
    SINGLE, DOUBLE, TRIPLE, MISS, dart, score, isDouble, label, sum,
    Checkout, settingsTitle, X01Engine, stateAverage, visitScored,
    emptyStats, statsAverage, statsFirst9, lifetimeStats,
    CheckoutTrainingEngine, AroundTheClockEngine, BobsEngine, ClockVariants, clockLabel,
    TrainingModes, trainingResultText, mergePayload, mergeSummary, Sample
  };
  if (typeof module !== 'undefined') module.exports = global.Darts;
})(typeof window !== 'undefined' ? window : globalThis);
