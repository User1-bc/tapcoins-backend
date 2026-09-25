'use strict';
// Verifica que un mazo bien elegido le gane al bot la mayoría de veces.
// Juega "inteligente": ataca con la carta viva de mayor ATK al rival más herido.
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const WebSocket = require('ws');

const PORT = 9877;
const DATA = path.join(process.env.TEMP, 'arena-balance');
fs.rmSync(DATA, { recursive: true, force: true });
const ROUNDS = 5;

const server = spawn(process.execPath, ['server.js'], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA },
  cwd: path.join(__dirname),
  stdio: 'ignore',
});

let exitCode = 0;
function api(method, p, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers: { 'Content-Type': 'application/json' } }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitHealth() {
  for (let i = 0; i < 50; i++) {
    try { await api('GET', '/health'); return; } catch (_) { await wait(200); }
  }
  throw new Error('server not up');
}

// Mazo: 1 Tanque, 1 Curacion, 1 Veloz, 1 Golpe (roles variados).
const DECK_IDS = [1, 58, 3, 99];

(async () => {
  await waitHealth();
  const PID = 'bal-' + Math.random().toString(16).slice(2, 10);
  const serials = [];
  for (const cardId of DECK_IDS) {
    const r = await api('POST', '/v1/card/claim', { playerId: PID, cardId });
    if (!r.ok) throw new Error('claim failed');
    serials.push(r.serial);
  }
  await api('PUT', '/v1/save/' + PID, { clientTime: Date.now(), data: { coins: 20000000 } });

  let wins = 0, losses = 0, draws = 0, rounds = 0;
  let lastCombos = null;
  for (let b = 0; b < ROUNDS; b++) {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?pid=${PID}`);
    const events = [];
    ws.on('message', (raw) => events.push(JSON.parse(raw.toString())));
    await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
    ws.send(JSON.stringify({ t: 'queue', deck: serials }));
    const deadline = Date.now() + 120000;
    let done = false;
    while (Date.now() < deadline && !done) {
      const result = events.find((e) => e.t === 'battle_result');
      if (result) {
        if (result.result === 'win') wins++;
        else if (result.result === 'lose') losses++;
        else draws++;
        rounds = Math.max(rounds, result.log.length);
        done = true;
        break;
      }
      const hp = events.filter((e) => e.t === 'battle_state').pop();
      const matched = events.find((e) => e.t === 'matched');
      if (matched) lastCombos = matched.combos;
      if (hp && matched && hp.battleId === matched.battleId) {
        const myHp = hp.hp[matched.you];
        const oppHp = hp.hp[1 - matched.you];
        let attacker = -1, bestAtk = -1;
        for (let i = 0; i < 4; i++) if (myHp[i] > 0 && matched.teams[matched.you][i].stats.atk > bestAtk) {
          bestAtk = matched.teams[matched.you][i].stats.atk; attacker = i;
        }
        let target = -1, lowest = Infinity;
        for (let i = 0; i < 4; i++) if (oppHp[i] > 0 && oppHp[i] < lowest) { lowest = oppHp[i]; target = i; }
        if (attacker >= 0 && target >= 0) {
          const sent = events.filter((e) => e.t === 'need_pick' && e.round === (hp.round || 0)).length;
          if (!events.some((e) => e.t === 'pick_sent' && e.round === hp.round)) {
            ws.send(JSON.stringify({ t: 'pick', battleId: matched.battleId, attacker, target }));
            events.push({ t: 'pick_sent', round: hp.round });
            void sent;
          }
        }
      }
      await wait(250);
    }
    ws.close();
    if (!done) throw new Error('battle timeout');
    await wait(300);
  }
  const total = ROUNDS;
  console.log(`BALANCE vs bot: ${wins}W ${losses}L ${draws}D de ${total}`);
  console.log(`combos del mazo: ${JSON.stringify(lastCombos)}`);
  if (wins < total / 2) {
    console.error('FAIL: el mazo balanceado pierde mas de la mitad contra el bot');
    exitCode = 1;
  }
})().catch((e) => { console.error('FAIL', e.stack); exitCode = 1; }).finally(() => {
  server.kill();
  setTimeout(() => process.exit(exitCode), 200);
});
