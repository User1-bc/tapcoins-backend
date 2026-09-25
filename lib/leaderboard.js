const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'leaderboard.json');

const MAX_NAME = 24;
const MAX_LIMIT = 100;
const KEEP_MONTHS = 4;
const PRIZES = [5000000, 2000000, 1000000];

let state = { months: {} };
let writesPending = false;
let writeTimer = null;

function ensureData() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function flush() {
  writesPending = false;
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, FILE);
}

function markDirty() {
  if (writesPending) return;
  writesPending = true;
  clearTimeout(writeTimer);
  writeTimer = setTimeout(flush, 300);
}

function load() {
  ensureData();
  try {
    state = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (!state || typeof state !== 'object' || !state.months) state = { months: {} };
    state.months = state.months || {};
  } catch {
    state = { months: {} };
  }
}

function monthBucket(month) {
  if (!state.months || typeof state.months !== 'object') state.months = {};
  const m = state.months[month];
  if (m && typeof m === 'object') {
    if (!m.entries || typeof m.entries !== 'object') m.entries = {};
    if (!m.claimed || typeof m.claimed !== 'object') m.claimed = {};
    return m;
  }
  const created = { entries: {}, claimed: {} };
  state.months[month] = created;
  return created;
}

function monthOf(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function currentMonth() {
  return monthOf(new Date());
}

function previousMonth() {
  const now = new Date();
  return monthOf(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)));
}

function isValidMonth(value) {
  return typeof value === 'string' && /^(20[2-9]\d|21\d{2})-(0[1-9]|1[0-2])$/.test(value);
}

function isPastMonth(month) {
  return isValidMonth(month) && month < currentMonth();
}

function toInt(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(Math.floor(n), 100000);
}

function toAmount(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(Math.round(n), Number.MAX_SAFE_INTEGER);
}

function cleanName(value) {
  if (typeof value !== 'string') return 'Jugador';
  const clean = value.replace(/[\p{C}]/gu, '').trim().slice(0, MAX_NAME);
  return clean || 'Jugador';
}

function isVerified(playerId) {
  return typeof playerId === 'string' && playerId.startsWith('g-');
}

function compare(a, b) {
  if (b.p !== a.p) return b.p - a.p;
  if (b.e !== a.e) return b.e - a.e;
  return a.t - b.t;
}

function prune() {
  const keys = Object.keys(state.months).sort();
  while (keys.length > KEEP_MONTHS) {
    const old = keys.shift();
    if (old !== currentMonth() && old !== previousMonth()) delete state.months[old];
  }
}

/**
 * El score SIEMPRE sale de la partida ya guardada: el cliente no puede
 * inyectar puntos propios. Cada push de /v1/save actualiza la tabla.
 */
function upsertFromSave(playerId, username, data) {
  if (!isValidMonth(data.monthKey)) return;
  const points = toInt(data.monthPrestigePoints);
  if (points <= 0) return;
  const month = monthBucket(data.monthKey);
  const name = cleanName(username || data.username);
  const earned = toAmount(data.totalEarned);
  const prev = month.entries[playerId];
  if (prev && prev.p >= points) {
    if (prev.n !== name) {
      prev.n = name;
      markDirty();
    }
    return;
  }
  month.entries[playerId] = { n: name, p: points, e: earned, v: isVerified(playerId), t: Date.now() };
  prune();
  markDirty();
}

function ranking(month, limit, me) {
  if (!isValidMonth(month)) return [];
  const bucket = state.months[month];
  if (!bucket || !bucket.entries) return [];
  const cap = Math.max(1, Math.min(Number(limit) || 50, MAX_LIMIT));
  return Object.keys(bucket.entries)
    .sort((a, b) => compare(bucket.entries[a], bucket.entries[b]))
    .slice(0, cap)
    .map((playerId, i) => {
      const e = bucket.entries[playerId];
      return {
        rank: i + 1,
        playerId: playerId === me ? playerId : `…${playerId.slice(-4)}`,
        name: e.n,
        points: e.p,
        earned: e.e,
        verified: !!e.v,
        you: playerId === me,
      };
    });
}

function podium(month) {
  return ranking(month, 3, '').filter((e) => e.points > 0);
}

/**
 * Premio del mes anterior validado por el servidor: un cliente modificado no
 * puede inventarse la medalla ni repetirla.
 */
function claim(playerId, month) {
  if (!isPastMonth(month)) return { ok: false, error: 'mes_invalido' };
  const bucket = monthBucket(month);
  if (bucket.claimed[playerId]) return { ok: false, error: 'ya_reclamado' };
  const top = ranking(month, 3, playerId);
  const found = top.find((e) => e.you);
  if (!found) return { ok: false, error: 'fuera_del_podio' };
  bucket.claimed[playerId] = Date.now();
  prune();
  markDirty();
  return {
    ok: true,
    month,
    rank: found.rank,
    points: found.points,
    coins: PRIZES[found.rank - 1] || 0,
  };
}

function flushNow() {
  clearTimeout(writeTimer);
  if (writesPending) flush();
}

module.exports = {
  load,
  upsertFromSave,
  ranking,
  podium,
  claim,
  currentMonth,
  previousMonth,
  isValidMonth,
  flushNow,
  stats() {
    const months = Object.keys(state.months || {});
    let players = 0;
    for (const m of months) players += Object.keys(state.months[m].entries || {}).length;
    return { months, players };
  },
};
