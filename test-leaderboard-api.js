// Prueba end-to-end de las rutas HTTP del ranking contra el server real.
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const PORT = 8099;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = path.join(os.tmpdir(), 'dmr-lb-api-' + Date.now());

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log('  ok   ' + name);
  } catch (e) {
    fail++;
    console.log('  FAIL ' + name + ' -> ' + e.message);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}
function eq(a, b, msg) {
  const same = Array.isArray(a) || (a && typeof a === 'object') ? JSON.stringify(a) === JSON.stringify(b) : a === b;
  if (!same) throw new Error(`${msg || ''} esperado ${JSON.stringify(b)} obtenido ${JSON.stringify(a)}`);
}

const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
child.stdout.on('data', (d) => (serverLog += d));
child.stderr.on('data', (d) => (serverLog += d));

const monthKey = (offset) => {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1 + offset).padStart(2, '0')}`;
};
const CUR = monthKey(0);
const PREV = monthKey(-1);

function save(playerId, points, earned, month, username) {
  return fetch(`${BASE}/v1/save/${playerId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      playerId,
      username,
      clientTime: Date.now(),
      data: { monthKey: month, monthPrestigePoints: points, totalEarned: earned, coins: earned },
    }),
  }).then((r) => r.json());
}

async function main() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }

  await t('health responde con el estado del ranking', async () => {
    const h = await (await fetch(`${BASE}/health`)).json();
    eq(h.ok, true);
    assert(h.leaderboard && Array.isArray(h.leaderboard.months), 'sin stats de leaderboard');
  });

  await t('GET /v1/leaderboard arranca vacio', async () => {
    const r = await (await fetch(`${BASE}/v1/leaderboard?month=${CUR}`)).json();
    eq(r.ok, true);
    eq(r.month, CUR);
    eq(r.entries.length, 0);
  });

  await t('un save con puntos entra al ranking', async () => {
    await save('g-ana0000000000000000001', 6, 5000000, CUR, 'Ana');
    const r = await (await fetch(`${BASE}/v1/leaderboard?month=${CUR}&me=g-ana0000000000000000001`)).json();
    eq(r.entries.length, 1);
    eq(r.entries[0].name, 'Ana');
    eq(r.entries[0].points, 6);
    eq(r.entries[0].verified, true);
    eq(r.entries[0].you, true);
    eq(r.entries[0].rank, 1);
  });

  await t('quien tiene 0 puntos no aparece', async () => {
    await save('s-bob0000000000000000002', 0, 9000000, CUR, 'Bob');
    const r = await (await fetch(`${BASE}/v1/leaderboard?month=${CUR}`)).json();
    eq(r.entries.length, 1);
    eq(r.entries[0].name, 'Ana');
  });

  await t('el id ajeno viene enmascarado', async () => {
    const r = await (await fetch(`${BASE}/v1/leaderboard?month=${CUR}`)).json();
    assert(r.entries[0].playerId.startsWith('…'), 'id sin mascarar: ' + r.entries[0].playerId);
    eq(r.entries[0].you, false);
  });

  await t('el ranking ordena por puntos y luego por monedas', async () => {
    await save('s-caro000000000000000003', 6, 99000000, CUR, 'Caro');
    await save('s-chico000000000000000004', 9, 1000, CUR, 'Chico');
    const r = await (await fetch(`${BASE}/v1/leaderboard?month=${CUR}`)).json();
    eq(r.entries.map((e) => e.name), ['Chico', 'Caro', 'Ana']);
    eq(r.entries.map((e) => e.rank), [1, 2, 3]);
  });

  await t('el cliente no puede inventarse puntos', async () => {
    await save('s-chico000000000000000004', 9, 1000, CUR, 'Chico');
    await save('s-chico000000000000000004', 2, 1000, CUR, 'Chico');
    const r = await (await fetch(`${BASE}/v1/leaderboard?month=${CUR}&me=s-chico000000000000000004`)).json();
    eq(r.entries.find((e) => e.you).points, 9);
  });

  await t('podio del mes anterior', async () => {
    await save('g-ganadora00000000000001', 12, 1e6, PREV, 'Ganadora');
    await save('s-segunda000000000000002', 8, 1e6, PREV, 'Segunda');
    await save('s-tercera000000000000003', 4, 1e6, PREV, 'Tercera');
    await save('s-cuarta0000000000000004', 2, 1e6, PREV, 'Cuarta');
    const r = await (await fetch(`${BASE}/v1/leaderboard/podium?month=${PREV}`)).json();
    eq(r.ok, true);
    eq(r.entries.map((e) => e.name), ['Ganadora', 'Segunda', 'Tercera']);
  });

  await t('reclamar el podio entrega el premio y no se repite', async () => {
    const first = await (
      await fetch(`${BASE}/v1/leaderboard/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playerId: 'g-ganadora00000000000001', month: PREV }),
      })
    ).json();
    eq(first.ok, true);
    eq(first.rank, 1);
    eq(first.coins, 5000000);
    eq(first.points, 12);

    const again = await (
      await fetch(`${BASE}/v1/leaderboard/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playerId: 'g-ganadora00000000000001', month: PREV }),
      })
    ).json();
    eq(again.ok, false);
    eq(again.error, 'ya_reclamado');
  });

  await t('un jugador fuera del podio no cobra nada', async () => {
    const r = await (
      await fetch(`${BASE}/v1/leaderboard/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playerId: 's-cuarta0000000000000004', month: PREV }),
      })
    ).json();
    eq(r.ok, false);
    eq(r.error, 'fuera_del_podio');
  });

  await t('no se puede reclamar el mes en curso', async () => {
    const r = await (
      await fetch(`${BASE}/v1/leaderboard/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playerId: 'g-ana0000000000000000001', month: CUR }),
      })
    ).json();
    eq(r.ok, false);
  });

  await t('un mes invalido cae al mes actual', async () => {
    const noMonth = await (await fetch(`${BASE}/v1/leaderboard?month=ESTO_NO_EXISTE`)).json();
    eq(noMonth.month, CUR);
    eq(noMonth.entries.length, 3);
  });

  await t('la pagina de privacidad ya es de Drag Master Royale', async () => {
    const html = await (await fetch(`${BASE}/privacidad`)).text();
    assert(!html.includes('TapCoins Idle'), 'sigue apareciendo TapCoins Idle');
    assert(html.includes('Drag Master Royale'), 'no aparece Drag Master Royale');
    assert(html.includes('Ranking mensual'), 'sin seccion de ranking');
  });

  await t('los datos sobreviven a un reinicio del server', async () => {
    const before = await (await fetch(`${BASE}/v1/leaderboard?month=${CUR}`)).json();
    await new Promise((r) => setTimeout(r, 600));
    const file = path.join(DATA_DIR, 'leaderboard.json');
    const onDisk = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : 'NO EXISTE';
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 1500));
    const afterKill = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : 'NO EXISTE';
    const restarted = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
      env: { ...process.env, PORT: String(PORT), DATA_DIR },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let restartLog = '';
    restarted.stdout.on('data', (d) => (restartLog += d));
    restarted.stderr.on('data', (d) => (restartLog += d));
    let healthy = false;
    for (let i = 0; i < 40; i++) {
      try {
        if ((await fetch(`${BASE}/health`)).ok) {
          healthy = true;
          break;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 250));
    }
    const after = await (await fetch(`${BASE}/v1/leaderboard?month=${CUR}`)).json();
    eq(after.entries.map((e) => e.name), before.entries.map((e) => e.name), `saludable=${healthy} antes=${onDisk} matastro=${afterKill} log=${restartLog}`);
    const claim = await (
      await fetch(`${BASE}/v1/leaderboard/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playerId: 'g-ganadora00000000000001', month: PREV }),
      })
    ).json();
    eq(claim.error, 'ya_reclamado');
    restarted.kill('SIGTERM');
  });

  console.log(`\n${pass} ok, ${fail} fail`);
  child.kill('SIGTERM');
  try {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  } catch {}
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('error fatal:', e.message);
  console.error(serverLog);
  child.kill('SIGTERM');
  process.exit(1);
});
