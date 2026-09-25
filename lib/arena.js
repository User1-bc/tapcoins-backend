'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { cardStats, hash, mulberry32 } = require('./cards');

const BET_COST = 100000;
const WIN_PRIZE = 150000;
const MERIT_WIN = 30;
const MERIT_LOSE = 29;
const ROUND_TIMEOUT_MS = 25000;
const BOT_QUEUE_MS = 10000;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const DISCONNECT_GRACE_MS = 30000;
const MAX_ROUNDS = 30;
const DECK_SIZE = 4;

function currentMonthKey() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function isValidCode(code) {
  return typeof code === 'string' && /^[A-Z0-9]{6}$/.test(code);
}

// ---------------- estado persistente (merits, wins, losses) ----------------
const ARENA_FILE = path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'arena.json');
let arena = {};
let arenaWritesPending = false;
let arenaWriteTimer = null;

function persistArena() {
  if (arenaWritesPending) return;
  arenaWritesPending = true;
  clearTimeout(arenaWriteTimer);
  arenaWriteTimer = setTimeout(() => {
    arenaWritesPending = false;
    try {
      const dir = path.dirname(ARENA_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const tmp = ARENA_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(arena));
      fs.renameSync(tmp, ARENA_FILE);
    } catch (_) {}
  }, 500);
}

function flushArena() {
  clearTimeout(arenaWriteTimer);
  arenaWritesPending = false;
  try {
    const dir = path.dirname(ARENA_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = ARENA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(arena));
    fs.renameSync(tmp, ARENA_FILE);
  } catch (_) {}
}

function loadArena() {
  try {
    if (!fs.existsSync(ARENA_FILE)) return;
    const parsed = JSON.parse(fs.readFileSync(ARENA_FILE, 'utf8'));
    if (parsed && typeof parsed === 'object') arena = parsed;
  } catch (_) {
    arena = {};
  }
}

// Aplica el mes nuevo dejando la mitad de merits (y reinicia W/L mensuales).
function ensureArenaRec(pid) {
  const now = currentMonthKey();
  const rec = arena[pid] || { merits: 0, wins: 0, losses: 0 };
  if (rec.monthKey && rec.monthKey !== now) {
    rec.merits = Math.floor((rec.merits || 0) / 2);
    rec.wins = 0;
    rec.losses = 0;
  }
  rec.monthKey = now;
  rec.lastBattleAt = Date.now();
  arena[pid] = rec;
  return rec;
}

function applyMerits(pid, delta) {
  const rec = ensureArenaRec(pid);
  rec.merits = Math.max(0, (rec.merits || 0) + delta);
  persistArena();
  return rec.merits;
}

function arenaStateFor(pid) {
  const rec = ensureArenaRec(pid);
  return { merits: rec.merits, wins: rec.wins, losses: rec.losses, monthKey: rec.monthKey };
}

// ---------------- bots ----------------
function randomId(prefix, len) {
  return prefix + crypto.randomBytes(len).toString('hex').slice(0, len);
}

function makeBotDeck(seed) {
  const rnd = mulberry32(seed);
  const ids = new Set();
  while (ids.size < DECK_SIZE) {
    ids.add(1 + Math.floor(rnd() * 5000));
  }
  return [...ids].map((cardId) => ({ cardId, stats: cardStats(cardId) }));
}

// ---------------- estado vivo de partidas ----------------
const battles = {};       // battleId -> state
const queue = [];         // [{pid, deck, ws}]
const challenges = {};    // code -> {pid, deck, ws, createdAt}
const grace = {};         // battleId -> {pid, timer}
let challengeSweep = null;

function send(ws, obj) {
  if (ws && ws.readyState === ws.OPEN) {
    try { ws.send(JSON.stringify(obj)); } catch (_) {}
  }
}

function attachArena(server, ctx) {
  loadArena();

  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws, req) => {
    const query = (require('url').parse(req.url || '', true).query) || {};
    const pid = typeof query.pid === 'string' ? query.pid : '';
    if (!ctx.validPlayerId(pid)) {
      ws.close();
      return;
    }
    const conn = { ws, pid, battleId: null, queued: false };
    ws.conn = conn;

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
      handleMessage(conn, msg);
    });

    ws.on('close', () => handleDisconnect(conn));
  });

  if (!challengeSweep) {
    challengeSweep = setInterval(() => {
      const now = Date.now();
      for (const code of Object.keys(challenges)) {
        const ch = challenges[code];
        if (now - ch.createdAt > CHALLENGE_TTL_MS || !ch.ws || ch.ws.readyState !== ch.ws.OPEN) {
          delete challenges[code];
        }
      }
    }, 60000);
  }

  function handleMessage(conn, msg) {
    switch (msg.t) {
      case 'queue': return doQueue(conn, msg);
      case 'leave_queue':
        conn.queued = false;
        const qi = queue.findIndex((q) => q === conn);
        if (qi >= 0) queue.splice(qi, 1);
        return;
      case 'pick': return doPick(conn, msg);
      case 'concede': return doConcede(conn, msg);
      case 'challenge_create': return doChallengeCreate(conn, msg);
      case 'challenge_join': return doChallengeJoin(conn, msg);
      default: return send(conn.ws, { t: 'error', msg: 'mensaje desconocido' });
    }
  }

  function convertDeck(conn, deck) {
    if (!Array.isArray(deck) || deck.length !== DECK_SIZE) return null;
    const out = [];
    for (const serial of deck) {
      if (typeof serial !== 'string') return null;
      const rec = ctx.cards.serials[serial];
      if (!rec || rec.owner !== conn.pid) return null;
      out.push({ serial, cardId: rec.cardId, stats: cardStats(rec.cardId) });
    }
    return out;
  }

  function reserveBet(pid) {
    const s = ctx.saves[pid];
    const coins = s && s.data && typeof s.data.coins === 'number' ? s.data.coins : 0;
    if (coins < BET_COST) return null;
    s.data.coins = Math.round((coins - BET_COST) * 100) / 100;
    return s.data.coins;
  }

  function doQueue(conn, msg) {
    if (conn.battleId || conn.queued) return;
    const deck = convertDeck(conn, msg.deck);
    if (!deck) return send(conn.ws, { t: 'error', msg: 'Tus 4 cartas no son válidas' });
    const bet = reserveBet(conn.pid);
    if (bet === null) return send(conn.ws, { t: 'error', msg: 'Necesitás 100.000 monedas para pelear' });
    conn.betCoins = bet;
    conn.deck = deck;

    const pending = queue.find((q) => q !== conn && q.ws && q.ws.readyState === q.ws.OPEN);
    if (pending) {
      queue.splice(queue.indexOf(pending), 1);
      pending.queued = false;
      conn.queued = false;
      createBattle(pending, conn, { kind: 'random' });
      return;
    }
    conn.queued = true;
    queue.push(conn);
    send(conn.ws, { t: 'queued', coinsNow: bet });
    // Buscador de rival: si no aparece nadie en 10s aparece un bot.
    setTimeout(() => {
      const i = queue.indexOf(conn);
      if (i < 0) return;
      queue.splice(i, 1);
      conn.queued = false;
      const botConn = makeBotConn(conn.pid);
      createBattle(botConn, conn, { kind: 'bot' });
    }, BOT_QUEUE_MS);
  }

  function makeBotConn(opponentPid) {
    const seed = Date.now();
    const botPid = 'bot-' + (seed % 0x7fffffff).toString(16) + 'ab';
    const deck = makeBotDeck(seed ^ hash(opponentPid + 'x'));
    return { ws: null, pid: botPid, battleId: null, queued: false, isBot: true, deck, betCoins: 0, seed };
  }

  function doChallengeCreate(conn, msg) {
    if (conn.battleId) return send(conn.ws, { t: 'error', msg: 'Ya estás en una batalla' });
    if (!isValidCode(msg.code)) return send(conn.ws, { t: 'error', msg: 'Código inválido' });
    const deck = convertDeck(conn, msg.deck);
    if (!deck) return send(conn.ws, { t: 'error', msg: 'Tus 4 cartas no son válidas' });
    const bet = reserveBet(conn.pid);
    if (bet === null) return send(conn.ws, { t: 'error', msg: 'Necesitás 100.000 monedas para pelear' });
    const existing = challenges[msg.code];
    if (existing && existing.pid !== conn.pid) return send(conn.ws, { t: 'error', msg: 'Código en uso' });
    conn.betCoins = bet;
    challenges[msg.code] = { pid: conn.pid, deck, ws: conn.ws, createdAt: Date.now(), coinReserved: true };
    send(conn.ws, { t: 'challenge_created', code: msg.code, coinsNow: bet });
  }

  function doChallengeJoin(conn, msg) {
    if (conn.battleId) return send(conn.ws, { t: 'error', msg: 'Ya estás en una batalla' });
    if (!isValidCode(msg.code)) return send(conn.ws, { t: 'error', msg: 'Código inválido' });
    const ch = challenges[msg.code];
    if (!ch) return send(conn.ws, { t: 'error', msg: 'El reto ya no existe' });
    if (ch.pid === conn.pid) return send(conn.ws, { t: 'error', msg: 'Ese es tu propio reto' });
    const deck = convertDeck(conn, msg.deck);
    if (!deck) return send(conn.ws, { t: 'error', msg: 'Tus 4 cartas no son válidas' });
    const bet = reserveBet(conn.pid);
    if (bet === null) return send(conn.ws, { t: 'error', msg: 'Necesitás 100.000 monedas para pelear' });
    delete challenges[msg.code];
    const hostConn = { ws: ch.ws, pid: ch.pid, battleId: null, queued: false, isBot: false, deck: ch.deck, betCoins: 0 };
    conn.betCoins = bet;
    conn.deck = deck;
    createBattle(hostConn, conn, { kind: 'challenge' });
  }

  function handleDisconnect(conn) {
    conn.queued = false;
    const qi = queue.indexOf(conn);
    if (qi >= 0) queue.splice(qi, 1);
    for (const code of Object.keys(challenges)) {
      if (challenges[code].ws === conn.ws) delete challenges[code];
    }
    if (!conn.battleId) return;
    const b = battles[conn.battleId];
    if (!b || b.phase === 'done') return;
    if (!conn.isBot) {
      grace[b.id] = { pid: conn.pid, timer: setTimeout(() => {
        const bb = battles[b.id];
        if (!bb || bb.phase === 'done') return;
        if (bb.round <= 2) {
          finishBattle(bb, 'draw');
        } else {
          finishBattle(bb, bb.players[0] === conn.pid ? 1 : 0);
        }
      }, DISCONNECT_GRACE_MS) };
    }
  }

  function createBattle(a, b, opts) {
    const id = 'btl-' + crypto.randomBytes(8).toString('hex');
    const seed = (a.seed || 0) + hash(id);
    const teamA = a.isBot ? a.deck : a.deck.map((c) => ({ serial: c.serial, cardId: c.cardId, stats: c.stats }));
    const teamB = b.isBot ? b.deck : b.deck.map((c) => ({ serial: c.serial, cardId: c.cardId, stats: c.stats }));
    const state = {
      id,
      kind: opts && opts.kind,
      players: [a.pid, b.pid],
      ws: [a.ws || null, b.ws || null],
      coins: [a.betCoins || 0, b.betCoins || 0],
      seed,
      rng: mulberry32(seed),
      teams: [teamA, teamB],
      hp: [teamA.map((c) => c.stats.hp), teamB.map((c) => c.stats.hp)],
      alive: [teamA.map(() => true), teamB.map(() => true)],
      revive: [teamA.map(() => 0), teamB.map(() => 0)],
      round: 0,
      picks: [null, null],
      log: [],
      phase: 'playing',
      pickTimer: null,
    };
    battles[id] = state;
    state.conns = [a, b];
    a.battleId = id;
    b.battleId = id;
    if (!a.isBot) send(a.ws, { t: 'matched', battleId: id, you: 0, seed, teams: [serializeTeam(teamA), serializeTeam(teamB)] });
    if (!b.isBot) send(b.ws, { t: 'matched', battleId: id, you: 1, seed, teams: [serializeTeam(teamA), serializeTeam(teamB)] });
    scheduleRound(state);
  }

  function serializeTeam(team) {
    return team.map((c) => ({ cardId: c.cardId, stats: c.stats }));
  }

  function aliveCount(state, side) {
    return state.alive[side].filter(Boolean).length;
  }

  function scheduleRound(state) {
    if (state.phase !== 'playing') return;
    state.round++;
    state.picks = [null, null];
    const sendCs = [];
    for (let s = 0; s < 2; s++) {
      if (state.ws[s]) send(state.ws[s], { t: 'need_pick', battleId: state.id, round: state.round });
    }
    clearTimeout(state.pickTimer);
    state.pickTimer = setTimeout(() => {
      for (let s = 0; s < 2; s++) {
        if (!state.picks[s]) state.picks[s] = autoPick(state, s);
      }
      resolveRound(state);
    }, ROUND_TIMEOUT_MS);
  }

  function doPick(conn, msg) {
    const b = battles[msg.battleId];
    if (!b || b.phase !== 'playing') return;
    const idx = b.players.indexOf(conn.pid);
    if (idx < 0) return;
    if (b.picks[idx]) return;
    const attacker = Number(msg.attacker);
    const target = Number(msg.target);
    if (!Number.isInteger(attacker) || attacker < 0 || attacker > 3 ||
        !Number.isInteger(target) || target < 0 || target > 3) return;
    b.picks[idx] = { attacker, target };

    const opp = 1 - idx;
    // Rival bot: responde solo.
    if (!b.ws[opp]) {
      b.picks[opp] = botPick(b, opp);
    }
    if (b.picks[0] && b.picks[1]) {
      clearTimeout(b.pickTimer);
      resolveRound(b);
    }
  }

  function doConcede(conn, msg) {
    const b = battles[msg.battleId];
    if (!b || b.phase !== 'playing') return;
    const idx = b.players.indexOf(conn.pid);
    if (idx < 0) return;
    finishBattle(b, 1 - idx);
  }

  function autoPick(state, side) {
    let attacker = -1;
    let bestAtk = -1;
    for (let i = 0; i < 4; i++) {
      if (state.alive[side][i] && state.teams[side][i].stats.atk > bestAtk) {
        bestAtk = state.teams[side][i].stats.atk;
        attacker = i;
      }
    }
    const opp = 1 - side;
    let target = -1;
    let lowestHp = Infinity;
    for (let i = 0; i < 4; i++) {
      if (state.alive[opp][i] && state.hp[opp][i] < lowestHp) {
        lowestHp = state.hp[opp][i];
        target = i;
      }
    }
    if (attacker < 0 || target < 0) return null;
    return { attacker, target };
  }

  function botPick(state, side) {
    const aliveOwn = [];
    const aliveOpp = [];
    for (let i = 0; i < 4; i++) {
      if (state.alive[side][i]) aliveOwn.push(i);
      if (state.alive[1 - side][i]) aliveOpp.push(i);
    }
    if (!aliveOwn.length || !aliveOpp.length) return autoPick(state, side);
    const attacker = aliveOwn[Math.floor(state.rng() * aliveOwn.length)];
    const target = aliveOpp[Math.floor(state.rng() * aliveOpp.length)];
    return { attacker, target };
  }

  function resolveRound(state) {
    if (state.phase !== 'playing') return;
    clearTimeout(state.pickTimer);
    for (let s = 0; s < 2; s++) {
      const p = state.picks[s];
      if (!p || !state.alive[s][p.attacker] || !state.alive[1 - s][p.target]) {
        state.picks[s] = autoPick(state, s);
      }
    }

    const order = [];
    for (let s = 0; s < 2; s++) {
      const p = state.picks[s];
      if (p) order.push({ side: s, pick: p, vel: state.teams[s][p.attacker].stats.vel });
    }
    order.sort((x, y) => y.vel - x.vel || state.rng() - 0.5);

    for (const moved of order) {
      if (moved.side !== undefined) {
        applyAction(state, moved.side, moved.pick);
        if (aliveCount(state, 0) === 0 || aliveCount(state, 1) === 0) break;
      }
    }

    broadcastState(state);

    const a = aliveCount(state, 0);
    const bb = aliveCount(state, 1);
    if (a === 0 && bb === 0) return finishBattle(state, 'draw');
    if (a === 0) return finishBattle(state, 1);
    if (bb === 0) return finishBattle(state, 0);
    if (state.round >= MAX_ROUNDS) return finishBattle(state, 'draw');
    scheduleRound(state);
  }

  function applyAction(state, side, pick) {
    const opp = 1 - side;
    const card = state.teams[side][pick.attacker];
    const targetIdx = pick.target;
    if (!state.alive[opp][targetIdx]) return;
    const roll = state.rng();
    let dmg = card.stats.atk * (0.8 + 0.4 * roll);
    let crit = false;
    if (state.rng() < card.stats.crit / 100) {
      dmg *= 2;
      crit = true;
    }
    dmg = Math.max(1, Math.round(dmg));
    state.hp[opp][targetIdx] = Math.max(0, state.hp[opp][targetIdx] - dmg);
    let line = `${shortName(card)} ataca a ${shortName(state.teams[opp][targetIdx])} por ${dmg}`;
    if (crit) line += ' ¡CRÍTICO!';
    state.log.push(line);
    if (state.hp[opp][targetIdx] <= 0) {
      if (cardSidesRevive(state, opp, targetIdx)) {
        state.revive[opp][targetIdx] = 1;
        state.hp[opp][targetIdx] = Math.floor(state.teams[opp][targetIdx].stats.hp / 2);
        state.log.push(`${shortName(state.teams[opp][targetIdx])} ¡resucita con el 50% de vida!`);
      } else {
        state.alive[opp][targetIdx] = false;
        state.log.push(`${shortName(state.teams[opp][targetIdx])} cae fuera de combate 😵`);
      }
    }
  }

  function cardSidesRevive(state, side, idx) {
    return state.teams[side][idx].stats.revive && !state.revive[side][idx];
  }

  function shortName(c) {
    return `#${String(c.cardId).padStart(4, '0')}`;
  }

  function broadcastState(state) {
    const payload = {
      t: 'battle_state',
      battleId: state.id,
      round: state.round,
      log: state.log.slice(-6),
      hp: [state.hp[0].slice(), state.hp[1].slice()],
    };
    if (state.ws[0]) send(state.ws[0], payload);
    if (state.ws[1]) send(state.ws[1], payload);
  }

  function finishBattle(state, result) {
    if (state.phase === 'done') return;
    state.phase = 'done';
    clearTimeout(state.pickTimer);
    if (grace[state.id]) {
      clearTimeout(grace[state.id].timer);
      delete grace[state.id];
    }

    const winnerIdx = result === 'draw' ? -1 : result;
    for (let s = 0; s < 2; s++) {
      const pid = state.players[s];
      if (state.conns && state.conns[s] && !state.conns[s].isBot) {
        state.conns[s].battleId = null;
      }
      if (state.conns[s].isBot) continue;
      let coinsDelta = 0;
      let meritsDelta = 0;
      const save = ctx.saves[pid];
      if (result === 'draw') {
        coinsDelta = BET_COST;
        if (save && save.data) save.data.coins = Math.round(((save.data.coins || 0) + BET_COST) * 100) / 100;
      } else if (winnerIdx === s) {
        coinsDelta = WIN_PRIZE;
        meritsDelta = MERIT_WIN;
        if (save && save.data) save.data.coins = Math.round(((save.data.coins || 0) + WIN_PRIZE) * 100) / 100;
        const rec = ensureArenaRec(pid);
        rec.wins++;
      } else {
        meritsDelta = -MERIT_LOSE;
        const rec = ensureArenaRec(pid);
        rec.losses++;
      }
      const worth = meritsDelta === 0 ? 0 : meritsDelta;
      let meritsNow = 0;
      if (meritsDelta !== 0) meritsNow = applyMerits(pid, worth);
      const coinsNow = save && save.data ? save.data.coins : 0;
      send(state.ws[s], {
        t: 'battle_result',
        battleId: state.id,
        you: s,
        result: result === 'draw' ? 'draw' : (winnerIdx === s ? 'win' : 'lose'),
        coinsDelta,
        meritsDelta,
        coinsNow,
        meritsNow,
        log: state.log.slice(-12),
      });
    }

    ctx.markSaveDirty();
    ctx.markCardsDirty();
    flushArena();
    delete battles[state.id];
  }

  // expone utilidades por si server.js quiere consultar el estado de la arena
  attachArena.stateFor = arenaStateFor;
  attachArena.applyMerits = applyMerits;
  attachArena.flush = flushArena;
  attachArena.arenaStateFor = arenaStateFor;
}

module.exports = { attachArena, arenaStateFor, applyMerits, flushArena };