const express = require('express');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const SAVES_FILE = path.join(DATA_DIR, 'saves.json');
const EVENTS_FILE = path.join(DATA_DIR, 'events.log');

const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const MAX_SAVE_BYTES = 64 * 1024;

const app = express();
app.use(express.json({ limit: '128kb' }));

function ensureData() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(SAVES_FILE)) fs.writeFileSync(SAVES_FILE, '{}');
}

let saves = {};
let writesPending = false;
let writeTimer = null;

function flushSaves() {
  writesPending = false;
  const tmp = SAVES_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(saves));
  fs.renameSync(tmp, SAVES_FILE);
}

function markDirty() {
  if (writesPending) return;
  writesPending = true;
  clearTimeout(writeTimer);
  writeTimer = setTimeout(flushSaves, 300);
}

function loadSaves() {
  ensureData();
  try {
    saves = JSON.parse(fs.readFileSync(SAVES_FILE, 'utf8'));
  } catch {
    saves = {};
  }
}

function validPlayerId(id) {
  return typeof id === 'string' && /^[a-zA-Z0-9-]{8,64}$/.test(id);
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, time: Date.now(), players: Object.keys(saves).length });
});

app.get('/v1/save/:playerId', (req, res) => {
  const { playerId } = req.params;
  if (!validPlayerId(playerId)) return res.status(400).json({ error: 'bad playerId' });
  const record = saves[playerId];
  if (!record) return res.status(204).end();
  res.json({ playerId, savedAt: record.savedAt, username: record.username, data: record.data });
});

app.put('/v1/save/:playerId', (req, res) => {
  const { playerId } = req.params;
  if (!validPlayerId(playerId)) {
    return res.status(400).json({ error: 'bad playerId' });
  }
  const clientTime = Number(req.body && req.body.clientTime);
  const data = req.body && req.body.data;
  const usernameRaw = req.body && req.body.username;
  if (!Number.isFinite(clientTime) || typeof data !== 'object' || data === null) {
    return res.status(400).json({ error: 'bad payload' });
  }
  const raw = JSON.stringify(data);
  if (Buffer.byteLength(raw) > MAX_SAVE_BYTES) {
    return res.status(413).json({ error: 'save too big' });
  }
  const serverTime = Date.now();
  const skew = clientTime - serverTime;
  if (skew > MAX_CLOCK_SKEW_MS) {
    return res.status(400).json({ error: 'clock drift detected', serverTime });
  }
  const username = typeof usernameRaw === 'string' ? usernameRaw.slice(0, 32) : '';
  const savedAt = Math.max(Number(recordSavedAt(playerId) || 0), clientTime);
  saves[playerId] = { savedAt, serverTime, username, data };
  markDirty();
  res.json({ ok: true, savedAt, serverTime });
});

app.post('/v1/events', (req, res) => {
  const body = req.body || {};
  const playerId = body.playerId;
  const events = body.events;
  if (!validPlayerId(playerId) || !Array.isArray(events)) {
    return res.status(400).json({ error: 'bad payload' });
  }
  const line = JSON.stringify({ t: Date.now(), p: playerId, events: events.slice(0, 50) });
  fs.appendFileSync(EVENTS_FILE, line + '\n');
  res.json({ ok: true });
});

function recordSavedAt(playerId) {
  const r = saves[playerId];
  return r ? r.savedAt : 0;
}

loadSaves();

const server = app.listen(PORT, () => {
  console.log(`tapcoins-backend listening on :${PORT}`);
});

process.on('SIGTERM', () => {
  clearTimeout(writeTimer);
  if (writesPending) flushSaves();
  server.close(() => process.exit(0));
});