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

// Elementos (mismo orden que _elements en card_catalog.dart del cliente).
const ELEMENTS = [
  'Fuego', 'Agua', 'Tierra', 'Aire', 'Rayo', 'Hielo',
  'Luz', 'Sombra', 'Acero', 'Planta', 'Cósmico', 'Dragón',
];

function elementOf(id) {
  return ELEMENTS[hash(id * 67 + 13) % ELEMENTS.length];
}

const RARITY_BASE = {
  Comun: { hp: 300, atk: 30, range: 150, arange: 30, crit: 5 },
  Rara: { hp: 420, atk: 55, range: 200, arange: 40, crit: 8 },
  Epica: { hp: 580, atk: 85, range: 240, arange: 50, crit: 12 },
  Legendaria: { hp: 780, atk: 125, range: 300, arange: 65, crit: 15 },
  Mitica: { hp: 1000, atk: 175, range: 350, arange: 85, crit: 20 },
};

// ROLES: cada carta tiene un rol que define su estilo de juego.
const ROLES = {
  Golpe: { atk: 1.18, hp: 0.95, vel: 0, crit: 0 },
  Tanque: { atk: 0.85, hp: 1.25, vel: 0, crit: 0 },
  Veloz: { atk: 1.05, hp: 0.95, vel: 25, crit: 0 },
  Curacion: { atk: 0.80, hp: 1.05, vel: 0, crit: 0 },
  Tirador: { atk: 0.95, hp: 0.92, vel: 5, crit: 6 },
};

function roleOf(id) {
  const r = hash(id * 211 + 7) % 100;
  if (r < 35) return 'Golpe';
  if (r < 55) return 'Tanque';
  if (r < 75) return 'Veloz';
  if (r < 85) return 'Curacion';
  return 'Tirador';
}

// TRAITS: cada carta tiene 1 fortaleza y 1 debilidad, con efecto real en la
// simulación del servidor (no son solo texto).
const TRAITS = {
  Valiente: { pro: '+18% ATK', contra: '-12 VEL' },
  Blindado: { pro: '-22% daño recibido', contra: '-10% ATK' },
  Duro: { pro: '+18% HP', contra: '-8 VEL' },
  Certero: { pro: '+8% crítico', contra: '-10% HP' },
  Agile: { pro: '+25 VEL', contra: '-12% ATK' },
  Vital: { pro: 'regenera 5% HP/ronda', contra: '-10 VEL' },
  Sangrante: { pro: 'roba 25% del daño', contra: '-12% HP' },
  Orgulloso: { pro: '+12% ATK con HP>60%', contra: '-20% ATK con HP<30%' },
};

const TRAIT_KEYS = Object.keys(TRAITS);

function traitOf(id) {
  return TRAIT_KEYS[hash(id * 223 + 11) % TRAIT_KEYS.length];
}

// Stats de combate de una carta según su id.
function cardStats(id) {
  const rarity = rarityOf(id);
  const base = RARITY_BASE[rarity];
  const role = roleOf(id);
  const trait = traitOf(id);
  const r1 = hash(id * 101 + 37);
  const r2 = hash(id * 103 + 41);
  const r3 = hash(id * 107 + 43);
  const rm = ROLES[role];

  let hp = (base.hp + (r1 % base.range)) * rm.hp;
  let atk = (base.atk + (r2 % base.arange)) * rm.atk;
  let vel = 20 + (r3 % 81) + rm.vel;
  let crit = base.crit + rm.crit;

  if (trait === 'Duro') hp *= 1.18;
  if (trait === 'Valiente') atk *= 1.18;
  if (trait === 'Agile') {
    vel += 25;
    atk *= 0.88;
  }
  if (trait === 'Blindado') atk *= 0.90;
  if (trait === 'Certero') {
    crit += 8;
    hp *= 0.90;
  }
  if (trait === 'Vital') vel -= 10;
  if (trait === 'Valiente') vel -= 12;
  if (trait === 'Duro') vel -= 8;
  if (trait === 'Sangrante') hp *= 0.88;

  return {
    cardId: id,
    rarity,
    element: elementOf(id),
    role,
    trait,
    traitPro: TRAITS[trait].pro,
    traitContra: TRAITS[trait].contra,
    hp: Math.max(1, Math.round(hp)),
    atk: Math.max(1, Math.round(atk)),
    vel: Math.max(5, Math.min(200, Math.round(vel))),
    crit: Math.max(0, Math.round(crit)),
    revive: rarity === 'Mitica',
    // modificadores dinámicos que la simulación aplica en cada ronda
    dr: trait === 'Blindado' ? 0.78 : 1.0,
    regen: trait === 'Vital' ? 0.05 : 0,
    lifesteal: trait === 'Sangrante' ? 0.25 : 0,
    proud: trait === 'Orgulloso',
    thorns: role === 'Tanque' ? 0.15 : 0,
  };
}

// Sinergias de mazo: se evaluan una vez por batalla con las 4 cartas.
function deckCombos(cards) {
  const out = [];
  const hasRole = (role) => cards.some((c) => c.role === role);
  if (hasRole('Curacion')) out.push('Alivio');
  if (hasRole('Tanque')) out.push('Espinas');
  if (cards.some((c) => c.rarity === 'Mitica')) out.push('Vinculo');
  const counts = {};
  for (const c of cards) counts[c.element] = (counts[c.element] || 0) + 1;
  const shared = Object.keys(counts).find((e) => counts[e] >= 2);
  if (shared) out.push('Afinidad:' + shared);
  return out;
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

module.exports = {
  hash, rarityOf, cardStats, mulberry32,
  RARITY_BASE, ROLES, TRAITS, TRAIT_KEYS, ELEMENTS,
  roleOf, traitOf, elementOf, deckCombos,
};