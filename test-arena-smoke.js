'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const WebSocket = require('ws');

const PORT = 9876;
const DATA = path.join(process.env.TEMP, 'arena-smoke');
fs.rmSync(DATA, { recursive: true, force: true });

const server = spawn(process.execPath, ['server.js'], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA },
  cwd: path.join(__dirname),
  stdio: 'inherit',
});

let exitCode = 0;
function fail(msg) {
  exitCode = 1;
  console.error('FAIL:', msg);
}

function api(method, p, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers: { 'Content-Type': 'application/json' } }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('bad json: ' + data)); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitHealth() {
  for (let i = 0; i < 50; i++) {
    try {
      await api('GET', '/health');
      return;
    } catch (_) { await wait(200); }
  }
  throw new Error('server not up');
}

const PID = 'test-' + 'a1b2c3d4e5f6';

(async () => {
  await waitHealth();
  const serials = [];
  for (let c = 1; c <= 4; c++) {
    const r = await api('POST', '/v1/card/claim', { playerId: PID, cardId: c });
    if (!r.ok) return fail('claim failed: ' + JSON.stringify(r));
    serials.push(r.serial);
  }
  await api('PUT', '/v1/save/' + PID, { clientTime: Date.now(), data: { coins: 1000000 } });

  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?pid=${PID}`);
  const events = [];
  ws.on('message', (raw) => events.push(JSON.parse(raw.toString())));
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });

  ws.send(JSON.stringify({ t: 'queue', deck: serials }));
  await wait(500);
  if (!events.some((e) => e.t === 'queued')) return fail('expected queued');
  await wait(11000);
  const matched = events.find((e) => e.t === 'matched');
  if (!matched) return fail('expected matched (bot)');
  if (!Array.isArray(matched.teams) || matched.teams.length !== 2 || matched.teams[0].length !== 4) {
    return fail('bad teams: ' + JSON.stringify(matched.teams));
  }
  const need = events.find((e) => e.t === 'need_pick');
  if (!need) return fail('expected need_pick');
  const hp = matched.teams[0][0].stats.hp;
  if (!Number.isFinite(hp) || hp <= 0) return fail('bad hp stat: ' + hp);

  // Auto-jugar cada ronda hasta que termine la batalla.
  const deadline = Date.now() + 45000;
  let lastRound = 0;
  while (Date.now() < deadline) {
    const needNow = events.find((e) => e.t === 'need_pick' && e.battleId === matched.battleId && e.round > lastRound);
    const result = events.find((e) => e.t === 'battle_result' && e.battleId === matched.battleId);
    if (result) break;
    if (needNow) {
      lastRound = needNow.round;
      ws.send(JSON.stringify({ t: 'pick', battleId: matched.battleId, attacker: 0, target: 0 }));
      await wait(300);
    } else {
      await wait(200);
    }
  }
  let msgs = events.filter((e) => e.t === 'battle_state');
  if (msgs.length) {
    const dmg = matched.teams[0][0].stats.hp - msgs[0].hp[0][0];
    if (dmg < 0) return fail('attacker took damage? hp went ' + dmg);
  }
  const result = events.find((e) => e.t === 'battle_result');
  if (!result) return fail('expected battle_result');
  if (!['win', 'lose', 'draw'].includes(result.result)) return fail('bad result ' + result.result);
  if (typeof result.coinsNow !== 'number' || typeof result.meritsNow !== 'number') {
    return fail('missing coinsNow/meritsNow');
  }
  // verify arena state endpoint
  const st = await api('GET', '/v1/arena/state/' + PID);
  if (!st.ok) return fail('arena state missing');
  if (st.merits !== result.meritsNow) return fail(`merit mismatch ${st.merits} vs ${result.meritsNow}`);
  // verify save coins ledger coherent: inicio 1000000-100000=900000 (perdida) o +150000 (ganancia)
  const sv = await api('GET', '/v1/save/' + PID);
  console.log('OK. result=' + result.result + ' meritsNow=' + result.meritsNow + ' coinsNow=' + result.coinsNow + ' savedCoins=' + (sv.data ? sv.data.coins : 'n/a'));
  ws.close();
})().catch((e) => { fail(e.stack); }).finally(() => {
  server.kill();
  setTimeout(() => process.exit(exitCode), 200);
});