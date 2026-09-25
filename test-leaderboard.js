// Prueba del ranking real: Derivado del save, sin bots, con podio validado por el servidor.
process.env.DATA_DIR = require('path').join(require('os').tmpdir(), 'dmr-lb-test-' + Date.now());

const assert = require('assert');
const leaderboard = require('./lib/leaderboard');
const { validPlayerId } = { validPlayerId: (id) => typeof id === 'string' && /^[a-zA-Z0-9-]{8,64}$/.test(id) };

leaderboard.load();

const month = leaderboard.currentMonth();
const prev = leaderboard.previousMonth();

function save(playerId, points, earned, mk = month, name = 'Jugador') {
  leaderboard.upsertFromSave(playerId, name, { monthKey: mk, monthPrestigePoints: points, totalEarned: earned });
}

function ids(n) {
  return Array.from({ length: n }, (_, i) => 'testplayer' + String(i).padStart(3, '0'));
}

let pass = 0;
let fail = 0;
function t(name, fn) {
  try {
    fn();
    pass++;
    console.log('  ok   ' + name);
  } catch (e) {
    fail++;
    console.log('  FAIL ' + name + ' -> ' + e.message);
  }
}

t('ranking vacio al empezar', () => {
  assert.strictEqual(leaderboard.ranking(month, 50, '').length, 0);
});

t('jugador sin puntos no aparece', () => {
  save(ids(1)[0], 0, 5000);
  assert.strictEqual(leaderboard.ranking(month, 50, '').length, 0);
});

t('solo aparecen los que tienen puntos de prestigio', () => {
  const [a, b] = ids(2);
  save(a, 4, 1e6, month, 'Alice');
  save(b, 7, 1e6, month, 'Bob');
  const r = leaderboard.ranking(month, 50, '');
  assert.strictEqual(r.length, 2);
  assert.strictEqual(r[0].name, 'Bob');
  assert.strictEqual(r[0].rank, 1);
  assert.strictEqual(r[1].name, 'Alice');
});

t('empate se resuelve con monedas ganadas', () => {
  const c = ids(3)[0];
  save(c, 5, 9e9, month, 'rico');
  const d = ids(4)[0];
  save(d, 5, 1e6, month, 'pobre');
  const r = leaderboard.ranking(month, 50, '');
  assert.ok(r.findIndex((e) => e.name === 'rico') < r.findIndex((e) => e.name === 'pobre'));
});

t('el jugador se marca como you y su id se oculta a los demas', () => {
  const e = ids(5)[0];
  const r = leaderboard.ranking(month, 50, e);
  const mine = r.find((x) => x.name && x.playerId.includes('testp'));
  assert.ok(mine);
  const others = r.filter((x) => x.playerId !== e);
  for (const o of others) {
    assert.ok(!validPlayerId(o.playerId) || o.playerId.startsWith('…'), 'id ajeno en claro: ' + o.playerId);
  }
});

t('los puntos nunca bajan aunque el save venga atrasado', () => {
  const e = ids(6)[0];
  save(e, 9, 1e6);
  save(e, 3, 1e6);
  const row = leaderboard.ranking(month, 50, e).find((x) => x.you);
  assert.strictEqual(row.points, 9);
});

t('cuenta verificada solo con id de Google', () => {
  const g = 'g-abcdef0123456789abcdef01';
  assert.ok(validPlayerId(g));
  save(g, 12, 1e6, month, 'Verificado');
  save('s-abcdef0123456789abcdef01', 11, 1e6, month, 'Sin Google');
  const r = leaderboard.ranking(month, 50, g);
  assert.strictEqual(r.find((x) => x.name === 'Verificado').verified, true);
  assert.strictEqual(r.find((x) => x.name === 'Sin Google').verified, false);
});

t('los nombres se limpian y se recortan', () => {
  save(ids(7)[0], 1, 1e6, month, '  ' + 'x'.repeat(60) + '  ');
  const row = leaderboard.ranking(month, 50, ids(7)[0]).find((x) => x.you);
  assert.strictEqual(row.name.length, 24);
  save(ids(8)[0], 1, 1e6, month, '');
  const row2 = leaderboard.ranking(month, 50, ids(8)[0]).find((x) => x.you);
  assert.strictEqual(row2.name, 'Jugador');
});

t('no se puede reclamar el mes en curso ni uno futuro', () => {
  const e = ids(9)[0];
  save(e, 3, 1e6, month, 'Tramposo');
  assert.strictEqual(leaderboard.claim(e, month).ok, false);
  assert.strictEqual(leaderboard.claim(e, '2099-01').ok, false);
  assert.strictEqual(leaderboard.claim(e, 'basura').ok, false);
});

t('podio del mes anterior se reclama una sola vez', () => {
  const winner = 'g-previous0000000000001';
  save(winner, 8, 1e6, prev, 'Campeona');
  const second = 's-previous0000000000002';
  save(second, 5, 1e6, prev, 'Segunda');
  const third = 's-previous0000000000003';
  save(third, 2, 1e6, prev, 'Tercera');
  const fourth = 's-previous0000000000004';
  save(fourth, 1, 1e6, prev, 'Cuarta');

  const first = leaderboard.claim(winner, prev);
  assert.strictEqual(first.ok, true);
  assert.strictEqual(first.rank, 1);
  assert.strictEqual(first.coins, 5000000);
  assert.strictEqual(first.points, 8);

  const again = leaderboard.claim(winner, prev);
  assert.strictEqual(again.ok, false);
  assert.strictEqual(again.error, 'ya_reclamado');

  const secondClaim = leaderboard.claim(second, prev);
  assert.strictEqual(secondClaim.coins, 2000000);
  assert.strictEqual(leaderboard.claim(third, prev).coins, 1000000);

  const out = leaderboard.claim(fourth, prev);
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.error, 'fuera_del_podio');
});

t('el podio solo devuelve los tres primeros con puntos', () => {
  const p = leaderboard.podium(prev);
  assert.strictEqual(p.length, 3);
  assert.ok(p.every((e) => e.points > 0));
  assert.deepStrictEqual(p.map((e) => e.rank), [1, 2, 3]);
  assert.deepStrictEqual(p.map((e) => e.name), ['Campeona', 'Segunda', 'Tercera']);
});

t('limite de resultados respetado', () => {
  assert.ok(leaderboard.ranking(month, 1, '').length <= 1);
  assert.strictEqual(leaderboard.ranking('1999-01', 50, '').length, 0);
});

t('puntos absurdos se recortan', () => {
  const e = ids(10)[0];
  leaderboard.upsertFromSave(e, 'Hack', { monthKey: month, monthPrestigePoints: 1e12, totalEarned: -5 });
  const row = leaderboard.ranking(month, 50, e).find((x) => x.you);
  assert.ok(row.points <= 100000, 'puntos: ' + row.points);
  assert.strictEqual(row.earned, 0);
});

console.log(`\n${pass} ok, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
