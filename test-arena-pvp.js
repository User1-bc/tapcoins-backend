'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const WebSocket = require('ws');

const PORT = 9877;
const DATA = path.join(process.env.TEMP, 'arena-pvp-smoke');
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
  for (let i = 0; i < 50; i++) {
    try { await api('GET', '/health'); return; } catch (_) { await wait(200); }
  }
  throw new Error('not up');
}

async function setupPlayer(pid, cards) {
  const serials = [];
  for (const c of cards) {
    const r = await api('POST', '/v1/card/claim', { playerId: pid, cardId: c });
    if (!r.ok) throw new Error('claim ' + JSON.stringify(r));
    serials.push(r.serial);
  }
  await api('PUT', '/v1/save/' + pid, { clientTime: Date.now(), data: { coins: 2000000 } });
  return serials;
}

function connect(pid) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?pid=${pid}`);
  const events = [];
  ws.on('message', (raw) => events.push(JSON.parse(raw.toString())));
  return new Promise((res, rej) => {
    ws.on('open', () => res({ ws, events }));
    ws.on('error', rej);
  });
}

async function playToEnd(conn, battleId) {
  const deadline = Date.now() + 20000;
  let lastRound = 0;
  while (Date.now() < deadline) {
    const result = conn.events.find((e) => e.t === 'battle_result' && e.battleId === battleId);
    if (result) return result;
    const need = conn.events.find((e) => e.t === 'need_pick' && e.battleId === battleId && e.round > lastRound);
    if (need) {
      lastRound = need.round;
      conn.ws.send(JSON.stringify({ t: 'pick', battleId, attacker: 0, target: 0 }));
      await wait(250);
    } else {
      await wait(200);
    }
  }
  console.log('DEBUG conn events:', JSON.stringify(conn.events.map((e) => e.t)));
  return null;
}

(async () => {
  await waitHealth();
  const pa = await setupPlayer('pvp-' + '000000000001', [10, 20, 30, 40]);
  const pb = await setupPlayer('pvp-' + '000000000002', [50, 60, 70, 80]);
  const A = await connect('pvp-000000000001');
  const B = await connect('pvp-000000000002');

  A.ws.send(JSON.stringify({ t: 'queue', deck: pa }));
  await wait(400);
  B.ws.send(JSON.stringify({ t: 'queue', deck: pb }));

  await wait(1500);
  const ma = A.events.find((e) => e.t === 'matched');
  const mb = B.events.find((e) => e.t === 'matched');
  if (!ma) return fail('A: no matched');
  if (!mb) return fail('B: no matched');
  if (ma.battleId !== mb.battleId) return fail('battleId differ: ' + ma.battleId + ' vs ' + mb.battleId);
  if (ma.you !== 0 || mb.you !== 1) return fail('bad you indices');
  const oppOfA = ma.teams[1][0].cardId;
  const oppOfB = mb.teams[0][0].cardId;
  if (oppOfA !== 50) return fail('A deberia ver 50 como rival, vio ' + oppOfA);
  if (oppOfB !== 10) return fail('B deberia ver 10 como rival, vio ' + oppOfB);

  const [ra, rb] = await Promise.all([
    playToEnd(A, ma.battleId),
    playToEnd(B, mb.battleId),
  ]);
  if (!ra || !rb) return fail('no result');
  console.log('DEBUG resultA=' + JSON.stringify({ r: ra.result, c: ra.coinsNow, m: ra.meritsNow }) +
    ' resultB=' + JSON.stringify({ r: rb.result, c: rb.coinsNow, m: rb.meritsNow }));
  const consistent = (ra.result === 'win' && rb.result === 'lose') ||
                     (ra.result === 'lose' && rb.result === 'win') ||
                     (ra.result === 'draw' && rb.result === 'draw');
  if (!consistent) return fail(`result inconsistent ${ra.result} vs ${rb.result}`);
  const rw = ra.result === 'win' ? ra : rb;
  const rl = ra.result === 'win' ? rb : ra;
  if (ra.result === 'draw') {
    if (Math.abs(ra.coinsNow - 2000000) > 1) return fail('draw deberia devolver apuesta: ' + ra.coinsNow);
  } else {
    if (Math.abs(rw.coinsNow - 2050000) > 1) return fail('win no suma premio: ' + rw.coinsNow);
    if (Math.abs(rl.coinsNow - 1900000) > 1) return fail('lose no resta apuesta: ' + rl.coinsNow);
  }
  // méritos cruzados: el ganador +30, perdedor -29 (piso 0), nunca ambos 0
  const sa = await api('GET', '/v1/arena/state/pvp-000000000001');
  const sb = await api('GET', '/v1/arena/state/pvp-000000000002');
  console.log('OK PVP. ra=' + ra.result + ' coinsA=' + ra.coinsNow + ' meritsA=' + sa.merits + ' meritsB=' + sb.merits);
  A.ws.close(); B.ws.close();
})().catch((e) => { fail(e.stack); }).finally(() => {
  server.kill();
  setTimeout(() => process.exit(exitCode), 200);
});