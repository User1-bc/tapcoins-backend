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
  saves[playerId] = { savedAt: serverTime, serverTime, username, data };
  markDirty();
  res.json({ ok: true, savedAt: serverTime, serverTime });
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

app.get('/privacidad', (_req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Política de Privacidad - TapCoins Idle</title>
<style>
  body{margin:0;background:#0f1626;color:#e6e6e6;font-family:'Segoe UI',Arial,sans-serif;line-height:1.6}
  .wrap{max-width:720px;margin:0 auto;padding:32px 20px 60px}
  h1{color:#ffd700;font-size:26px;margin-top:8px}
  h2{color:#ffd700;font-size:18px;margin-top:28px}
  p{font-size:15px;color:#d6d6d6}
  .tag{display:inline-block;background:#1b2437;border:1px solid #ffd700;color:#ffd700;border-radius:8px;padding:4px 10px;font-size:13px}
  footer{margin-top:40px;color:#888;font-size:12px}
</style>
</head>
<body>
<div class="wrap">
  <div class="tag">TapCoins Idle</div>
  <h1>Política de Privacidad</h1>
  <p><strong>Última actualización:</strong> septiembre 2026</p>

  <h2>Qué datos guardamos</h2>
  <p>TapCoins Idle usa un <strong>nombre elegido por el jugador</strong> y una <strong>identificación anónima</strong> generada en el celular para sincronizar el progreso entre dispositivos. No pedimos correo, no pedimos contraseña y no publicamos el nombre de los jugadores.</p>

  <h2>Menores de edad</h2>
  <p>La app es apta para toda la familia. Si el jugador tiene menos de 13 años, sus padres o tutores deben revisar estas condiciones y acompañarlo mientras juega.</p>

  <h2>No compartimos tus datos</h2>
  <p>Tus datos se usan únicamente para guardar tu partida entre dispositivos. No se venden ni se comparten con terceros publicitarios.</p>

  <h2>Compras dentro de la app</h2>
  <p>Las compras de monedas se procesan por Google Play. TapCoins Idle no ve el método de pago. Las compras se gestionan según las políticas de reembolso de Google.</p>

  <h2>Notificaciones y sonido</h2>
  <p>Las notificaciones y el sonido se generan en el propio celular y se pueden desactivar desde el menú Misiones dentro de la app.</p>

  <h2>Borrar tus datos</h2>
  <p>El jugador puede borrar su progreso en cualquier momento desde Privacidad y términos en la app (botón "Borrar mi progreso").</p>

  <h2>Contacto</h2>
  <p>Para cualquier pregunta o pedido de borrado de datos, escribí a: <strong>bcarvjal1129@gmail.com</strong></p>

  <footer>TapCoins Idle - hecho en RD 🇩🇴</footer>
</div>
</body>
</html>`);
});

function recordSavedAt(playerId) {
  const r = saves[playerId];
  return r ? r.savedAt : 0;
}

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