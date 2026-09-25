'use strict';

// Fórmulas DETERMINISTAS de las cartas (espejo de lib/data/card_catalog.dart
// del cliente Flutter). El servidor usa estas mismas funciones para simular
// las batallas sin depender de lo que mande el cliente.

function hash(x) {
  let h = Math.imul(x, 2654435761) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0x5BD1E995) >>> 0;
  h ^= h >>> 15;
  return h >>> 0;
}

function rarityOf(id) {
  const r = hash(id * 31 + 7) % 10000;
  if (r < 5000) return 'Comun';
  if (r < 7800) return 'Rara';
  if (r < 9300) return 'Epica';
  if (r < 9900) return 'Legendaria';
  return 'Mitica';
}

const RARITY_BASE = {
  Comun: { hp: 300, atk: 30, range: 150, arange: 30, crit: 5 },
  Rara: { hp: 420, atk: 55, range: 200, arange: 40, crit: 8 },
  Epica: { hp: 580, atk: 85, range: 240, arange: 50, crit: 12 },
  Legendaria: { hp: 780, atk: 125, range: 300, arange: 65, crit: 15 },
  Mitica: { hp: 1000, atk: 175, range: 350, arange: 85, crit: 20 },
};

// Stats de combate de una carta según su id.
function cardStats(id) {
  const rarity = rarityOf(id);
  const base = RARITY_BASE[rarity];
  const r1 = hash(id * 101 + 37);
  const r2 = hash(id * 103 + 41);
  const r3 = hash(id * 107 + 43);
  const hp = base.hp + (r1 % base.range);
  const atk = base.atk + (r2 % base.arange);
  const vel = 20 + (r3 % 81);
  return {
    cardId: id,
    rarity,
    hp,
    atk,
    vel,
    crit: base.crit,
    revive: rarity === 'Mitica',
  };
}

// RNG con semilla (mulberry32) para la varianza de daño y las
// decisiones del bot: la batalla queda determinista por su seed.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

module.exports = { hash, rarityOf, cardStats, mulberry32, RARITY_BASE };