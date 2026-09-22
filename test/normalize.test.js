// test/normalize.test.js — Property tests de normalización (node --test nativo, sin deps npm).
// Cubre Property 6 (Invariantes de normalización) y Property 7 (Artista principal).
// Validates: Requirements 10.1, 10.2, 10.3, 14.3

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { normalize, normalizeArtist } = require('../normalize');

// ─────────────────────────────────────────────────────────────────────────────
// Generadores propios ligeros (PRNG determinista para reproducibilidad).
// ─────────────────────────────────────────────────────────────────────────────

// PRNG mulberry32: determinista, sembrable, suficiente para property testing.
function makeRng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ITER = 200; // ≥100 iteraciones por property

function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

function randInt(rng, min, max) {
  return min + Math.floor(rng() * (max - min + 1));
}

// Piezas para construir nombres de canción "sucios".
const ACCENTED_WORDS = [
  'canción', 'corazón', 'mañana', 'café', 'niño', 'José', 'ÁÉÍÓÚ', 'über',
  'Björk', 'naïve', 'résumé', 'jalapeño', 'crème', 'fiancé', 'Renée',
];
const PLAIN_WORDS = [
  'Ghost', 'Say', 'Something', 'Love', 'Dream', 'Fire', 'Rain', 'Night',
  'HELLO', 'World', 'Time', 'Home', 'Light', 'STARLIGHT', 'ocean',
];
const VERSION_SUFFIXES = [
  ' - Acoustic', ' - Remix', ' - Live', ' - Remastered',
  ' - acoustic', ' -remix', ' - Live 2020', ' - Remastered 2011',
];
const PAREN_BLOCKS = [
  '(feat. Someone)', '[Explicit]', '(Bonus Track)', '[Deluxe]',
  '(Radio Edit)', '(feat. X)', '[Remix]', '(2020 Version)',
];
const FEAT_SEGMENTS = [
  ' feat. Someone', ' ft. Artist', ' feat Artist Two', ' ft Person',
  ' feat. A B C',
];

// Construye un nombre de canción "sucio" combinando piezas al azar.
function genDirtyName(rng) {
  const parts = [];
  const wordCount = randInt(rng, 1, 3);
  for (let i = 0; i < wordCount; i++) {
    // Mezcla de palabras con y sin acento, con espacios múltiples ocasionales.
    parts.push(pick(rng, rng() < 0.5 ? ACCENTED_WORDS : PLAIN_WORDS));
    if (rng() < 0.4) parts.push('  '); // espacios dobles intercalados
  }
  let s = parts.join(' ');

  // Opcionalmente añadir bloque entre paréntesis/corchetes.
  if (rng() < 0.6) s += ' ' + pick(rng, PAREN_BLOCKS);
  // Opcionalmente añadir segmento feat./ft.
  if (rng() < 0.4) s += pick(rng, FEAT_SEGMENTS);
  // Opcionalmente añadir sufijo de versión (siempre al final, como en la vida real).
  if (rng() < 0.5) s += pick(rng, VERSION_SUFFIXES);
  // Padding en extremos y espacios múltiples.
  if (rng() < 0.5) s = '   ' + s + '   ';
  if (rng() < 0.3) s = s.replace(/ /g, '   ');

  return s;
}

// Separadores de artista que normalizeArtist debe cortar.
const ARTIST_SEPARATORS = [';', ', ', ' & ', ' feat ', ' feat. ', ' ft. '];
const ARTIST_NAMES = [
  'Jason Mraz', 'Colbie Caillat', 'Beyoncé', 'Björk', 'The Weeknd',
  'José González', 'DAFT PUNK', 'Sigur Rós', 'Måneskin', 'Renée',
];

// Construye un artista compuesto con >=1 separador.
function genMultiArtist(rng) {
  const count = randInt(rng, 2, 4);
  const first = pick(rng, ARTIST_NAMES);
  const rest = [];
  for (let i = 1; i < count; i++) rest.push(pick(rng, ARTIST_NAMES));
  // Une el primero con el resto usando separadores aleatorios.
  let s = first;
  for (const r of rest) s += pick(rng, ARTIST_SEPARATORS) + r;
  if (rng() < 0.5) s = '  ' + s + '  ';
  return { raw: s, first };
}

// ─────────────────────────────────────────────────────────────────────────────
// Aserciones de invariantes reutilizables.
// ─────────────────────────────────────────────────────────────────────────────

function assertNormalizedInvariants(out, input) {
  // Minúsculas: la salida es igual a su versión en minúsculas.
  assert.strictEqual(out, out.toLowerCase(), `debe estar en minúsculas: ${JSON.stringify(input)} -> ${JSON.stringify(out)}`);

  // Sin marcas de acento combinantes (NFD strip).
  assert.ok(!/[\u0300-\u036f]/.test(out.normalize('NFD')) || out === out.normalize('NFD').replace(/[\u0300-\u036f]/g, ''),
    `no debe contener acentos: ${JSON.stringify(input)} -> ${JSON.stringify(out)}`);
  // Comprobación directa: aplicar el strip de nuevo no cambia nada.
  assert.strictEqual(out, out.normalize('NFD').replace(/[\u0300-\u036f]/g, ''),
    `sin marcas de acento: ${JSON.stringify(input)} -> ${JSON.stringify(out)}`);

  // Sin paréntesis ni corchetes.
  assert.ok(!/[()\[\]]/.test(out), `sin paréntesis/corchetes: ${JSON.stringify(input)} -> ${JSON.stringify(out)}`);

  // Sin sufijos de versión conocidos (patrón " - acoustic/remix/live/remastered").
  assert.ok(!/\s*-\s*(acoustic|remix|live|remastered)/.test(out),
    `sin sufijos de versión: ${JSON.stringify(input)} -> ${JSON.stringify(out)}`);

  // Sin feat./ft.
  assert.ok(!/\b(feat\.?|ft\.?)\b/.test(out), `sin feat./ft.: ${JSON.stringify(input)} -> ${JSON.stringify(out)}`);

  // Sin espacios dobles.
  assert.ok(!/ {2,}/.test(out), `sin espacios dobles: ${JSON.stringify(input)} -> ${JSON.stringify(out)}`);

  // Sin espacios en los extremos.
  assert.strictEqual(out, out.trim(), `sin espacios en extremos: ${JSON.stringify(input)} -> ${JSON.stringify(out)}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Property 6: Invariantes de normalización
// Validates: Requirements 10.1, 10.2, 14.3
// ─────────────────────────────────────────────────────────────────────────────

test('Property 6: normalize() cumple todas las invariantes de salida (>=200 iter)', () => {
  const rng = makeRng(0xC0FFEE);
  for (let i = 0; i < ITER; i++) {
    const input = genDirtyName(rng);
    const out = normalize(input);
    assertNormalizedInvariants(out, input);
  }
});

test('Property 6: normalize() es idempotente — normalize(normalize(x)) === normalize(x) (>=200 iter)', () => {
  const rng = makeRng(0x1DEA);
  for (let i = 0; i < ITER; i++) {
    const input = genDirtyName(rng);
    const once = normalize(input);
    const twice = normalize(once);
    assert.strictEqual(twice, once,
      `idempotencia rota: ${JSON.stringify(input)} -> ${JSON.stringify(once)} -> ${JSON.stringify(twice)}`);
  }
});

test('Property 6: casos dirigidos', () => {
  assert.strictEqual(normalize('Ghost - Acoustic'), 'ghost');
  assert.strictEqual(normalize('Say Something (feat. X)'), 'say something');
});

// ─────────────────────────────────────────────────────────────────────────────
// Property 7: Artista principal
// Validates: Requirements 10.3, 14.3
// ─────────────────────────────────────────────────────────────────────────────

test('Property 7: normalizeArtist() devuelve la normalización del primer segmento (>=200 iter)', () => {
  const rng = makeRng(0xBEEF);
  for (let i = 0; i < ITER; i++) {
    const { raw, first } = genMultiArtist(rng);
    const out = normalizeArtist(raw);

    // La salida coincide con normalizar el primer segmento (cortando en el primer
    // separador ; , & o feat sobre el string crudo).
    const expected = normalize(raw.split(/[;,&]|\bfeat\b/i)[0]);
    assert.strictEqual(out, expected,
      `primer segmento incorrecto: ${JSON.stringify(raw)} -> ${JSON.stringify(out)} (esperado ${JSON.stringify(expected)})`);

    // También debe coincidir con normalizar directamente el primer artista conocido.
    assert.strictEqual(out, normalize(first),
      `no coincide con el artista principal: ${JSON.stringify(raw)} -> ${JSON.stringify(out)}`);

    // La salida NO contiene separadores ni feat.
    assert.ok(!/[;,&]/.test(out), `salida con separador: ${JSON.stringify(raw)} -> ${JSON.stringify(out)}`);
    assert.ok(!/\bfeat\b/.test(out), `salida con feat: ${JSON.stringify(raw)} -> ${JSON.stringify(out)}`);

    // La salida de normalizeArtist también cumple las invariantes generales.
    assertNormalizedInvariants(out, raw);
  }
});

test('Property 7: caso dirigido — "Jason Mraz;Colbie Caillat" -> "jason mraz"', () => {
  assert.strictEqual(normalizeArtist('Jason Mraz;Colbie Caillat'), 'jason mraz');
});
