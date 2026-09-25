'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const WebSocket = require('ws');

const PORT = 9878;
const DATA = path.join(process.env.TEMP, 'arena-challenge-smoke');
fs.rmSync(DATA, { recursive: true, force: true });

const server = spawn(process.execPath, ['server.js'], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA },
  cwd: path.join(__dirname),
  stdio: 'inherit',
});
let exitCode = 0;
function fail(msg) { exitCode = 1; console.error('FAIL:', msg); }
function api(method, p, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers: { 'Content-Type': 'application/json' } }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('bad json')); } });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}
function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function waitHealth() {
  for (let i = 0; i < 50; i++) { try { await api('GET', '/health'); return; } catch (_) { await wait(200); } }
  throw new Error('not up');
}
async function setupPlayer(pid, cards) {
  const serials = [];
  for (const c of cards) {
    const r = await api('POST', '/v1/card/claim', { playerId: pid, cardId: c });
    if (!r.ok) throw new Error('claim');
    serials.push(r.serial);
  }
  await api('PUT', '/v1/save/' + pid, { clientTime: Date.now(), data: { coins: 500000 } });
  return serials;
}
function connect(pid) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?pid=${pid}`);
  const events = [];
  ws.on('message', (raw) => events.push(JSON.parse(raw.toString())));
  return new Promise((res, rej) => { ws.on('open', () => res({ ws, events })); ws.on('error', rej); });
}

(async () => {
  await waitHealth();
  const pa = await setupPlayer('chl-' + '0000000000A1', [10, 20, 30, 40]);
  const pb = await setupPlayer('chl-' + '0000000000B2', [50, 60, 70, 80]);
  const A = await connect('chl-0000000000A1');
  const B = await connect('chl-0000000000B2');

  A.ws.send(JSON.stringify({ t: 'challenge_create', code: 'ABC123', deck: pa }));
  await wait(400);
  const created = A.events.find((e) => e.t === 'challenge_created');
  if (!created) return fail('no challenge_created');

  B.ws.send(JSON.stringify({ t: 'challenge_join', code: 'ABC123', deck: pb }));
  await wait(800);
  const ma = A.events.find((e) => e.t === 'matched');
  const mb = B.events.find((e) => e.t === 'matched');
  if (!ma) return fail('A no matched en reto');
  if (!mb) return fail('B no matched en reto');
  if (ma.battleId !== mb.battleId) return fail('battleId difieren');

  // B se desconecta -> tras 30s de gracia deberia perder (round<=2 -> draw igual).
  B.ws.close();
  await wait(32000);
  const ra = A.events.find((e) => e.t === 'battle_result' && e.battleId === ma.battleId);
  if (!ra) return fail('sin resultado tras desconexion, events=' + JSON.stringify(A.events.map((e) => e.t)));
  // Con round<=2 se devuelve la apuesta (draw).
  if (ra.result !== 'draw') return fail('se esperaba draw con refund temprano, result=' + ra.result);
  const sa = await api('GET', '/v1/arena/state/chl-0000000000A1');
  console.log('OK CHALLENGE. result=' + ra.result + ' coinsNow=' + ra.coinsNow + ' meritsA=' + sa.merits);
  A.ws.close();
})().catch((e) => { fail(e.stack); }).finally(() => {
  server.kill();
  setTimeout(() => process.exit(exitCode), 200);
});