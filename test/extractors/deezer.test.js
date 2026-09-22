// test/extractors/deezer.test.js — Tests del Extractor_Deezer (node --test nativo, sin deps npm).
//
// Parseo PURO sobre fixtures reales (sin red): se carga el JSON con
// fs.readFileSync y se llama deezer.parse(body).
//
// Cubre:
//   - Fixture realista deezer-playlist.json → tracklist esperado (name/artist, longitud, orden).
//   - Fixtures degradados deezer-error.json / deezer-no-data.json → EXTRACTION_FAILED (Req 3.3).
//   - Property 3: Mapeo de pistas de Deezer — para todo {data:[{title,artist:{name}}...], title}
//     el tracklist tiene longitud == data y name===data[i].title, artist===data[i].artist.name.
//   - Property 4: Forma del resultado del extractor — toda salida de parse es
//     {ok:true, tracklist:[{name,artist}], playlistName} o {ok:false, reason}, nunca intermedia.
//
// PRNG determinista al estilo de test/sources.test.js / test/extract.test.js.
//
// Validates: Requirements 3.2, 3.3, 7.1, 7.2

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const deezer = require('../../lib/extractors/deezer');

const FIXTURES = path.join(__dirname, '..', 'fixtures');
const readFixture = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

// ─────────────────────────────────────────────────────────────────────────────
// PRNG mulberry32: determinista, sembrable (mismo patrón que el resto de tests).
// ─────────────────────────────────────────────────────────────────────────────
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

const TITLE_POOL = [
  'One More Time', 'Bad Guy', "Don't Start Now", 'Harder Better Faster Stronger',
  'Canción', 'Über Alles', 'HELLO', 'A', 'Título con espacios   ', '', 'Track #1',
];
const ARTIST_POOL = [
  'Daft Punk', 'Billie Eilish', 'Dua Lipa', 'José González', 'Björk',
  'The Weeknd', 'Måneskin', '', 'A, B & C',
];

// Genera las filas de pistas de una playlist de Deezer.
function genDeezerRows(rng) {
  const len = randInt(rng, 0, 8);
  const rows = [];
  for (let k = 0; k < len; k++) {
    rows.push({
      id: randInt(rng, 1, 999999),
      title: pick(rng, TITLE_POOL),
      artist: { id: randInt(rng, 1, 99999), name: pick(rng, ARTIST_POOL) },
    });
  }
  return rows;
}

// Forma REAL de api.deezer.com/playlist/{id}: las pistas van en `tracks.data`.
function genDeezerPayload(rng) {
  const rows = genDeezerRows(rng);
  const obj = { id: randInt(rng, 1, 9999999), tracks: { data: rows, checksum: 'x' } };
  if (rng() < 0.5) obj.title = `Playlist ${randInt(rng, 1, 999)}`;
  // Exponemos las filas en `_rows` (no lo lee el parser) para que los asserts
  // del test comparen contra la fuente, sin depender de dónde estén anidadas.
  Object.defineProperty(obj, '_rows', { value: rows, enumerable: false });
  return obj;
}

// Verifica que un resultado es UNA de las dos formas válidas del contrato de
// extractor y NUNCA una intermedia. Property 4.
function assertExtractorShape(res, ctx) {
  assert.ok(res && typeof res === 'object', `${ctx}: resultado no es objeto: ${JSON.stringify(res)}`);
  assert.strictEqual(typeof res.ok, 'boolean', `${ctx}: 'ok' debe ser boolean: ${JSON.stringify(res)}`);

  if (res.ok === true) {
    assert.ok(Array.isArray(res.tracklist), `${ctx}: ok:true requiere tracklist array: ${JSON.stringify(res)}`);
    assert.ok(
      res.playlistName === null || typeof res.playlistName === 'string',
      `${ctx}: playlistName debe ser string|null: ${JSON.stringify(res.playlistName)}`,
    );
    for (const trk of res.tracklist) {
      assert.ok(trk && typeof trk === 'object', `${ctx}: pista no es objeto: ${JSON.stringify(trk)}`);
      assert.strictEqual(typeof trk.name, 'string', `${ctx}: name debe ser string: ${JSON.stringify(trk)}`);
      assert.strictEqual(typeof trk.artist, 'string', `${ctx}: artist debe ser string: ${JSON.stringify(trk)}`);
    }
    assert.ok(!('reason' in res), `${ctx}: ok:true no debe incluir 'reason': ${JSON.stringify(res)}`);
  } else {
    assert.strictEqual(typeof res.reason, 'string', `${ctx}: ok:false requiere reason string: ${JSON.stringify(res)}`);
    assert.ok(res.reason.length > 0, `${ctx}: reason no vacío: ${JSON.stringify(res)}`);
    assert.ok(!('tracklist' in res), `${ctx}: ok:false no debe incluir 'tracklist': ${JSON.stringify(res)}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixture realista: deezer-playlist.json → tracklist esperado.
// Validates: Requirements 3.2, 7.1
// ─────────────────────────────────────────────────────────────────────────────

const EXPECTED_DEEZER = {
  playlistName: 'Verano 2024',
  tracklist: [
    { name: 'Harder, Better, Faster, Stronger', artist: 'Daft Punk' },
    { name: 'One More Time', artist: 'Daft Punk' },
    { name: 'Bad Guy', artist: 'Billie Eilish' },
    { name: "Don't Start Now", artist: 'Dua Lipa' },
  ],
};

test('Deezer: parse() del fixture playlist extrae el tracklist esperado (name/artist, longitud, orden)', () => {
  const body = readFixture('deezer-playlist.json');
  const res = deezer.parse(body);

  assert.strictEqual(res.ok, true, `debería tener éxito: ${JSON.stringify(res)}`);
  assert.strictEqual(res.playlistName, EXPECTED_DEEZER.playlistName, 'nombre de playlist incorrecto');

  assert.strictEqual(res.tracklist.length, EXPECTED_DEEZER.tracklist.length, 'longitud del tracklist incorrecta');
  assert.deepStrictEqual(res.tracklist, EXPECTED_DEEZER.tracklist,
    'tracklist extraído no coincide (name = title, artist = artist.name, en orden)');
});

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures degradados → EXTRACTION_FAILED (Req 3.3).
// Validates: Requirements 3.3, 7.1
// ─────────────────────────────────────────────────────────────────────────────

test('Deezer: parse() de fixture con {error} devuelve EXTRACTION_FAILED', () => {
  const body = readFixture('deezer-error.json');
  const res = deezer.parse(body);

  assert.strictEqual(res.ok, false, `debería fallar: ${JSON.stringify(res)}`);
  assert.strictEqual(res.reason, 'EXTRACTION_FAILED', `reason esperado EXTRACTION_FAILED: ${JSON.stringify(res)}`);
});

test('Deezer: parse() de fixture sin array data devuelve EXTRACTION_FAILED', () => {
  const body = readFixture('deezer-no-data.json');
  const res = deezer.parse(body);

  assert.strictEqual(res.ok, false, `debería fallar: ${JSON.stringify(res)}`);
  assert.strictEqual(res.reason, 'EXTRACTION_FAILED', `reason esperado EXTRACTION_FAILED: ${JSON.stringify(res)}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// Property 3: Mapeo de pistas de Deezer.
//
// Para todo payload {data:[{title, artist:{name}}...], title} con data array,
// el tracklist resultante tiene longitud == data y para cada i:
//   tracklist[i].name === data[i].title  y  tracklist[i].artist === data[i].artist.name
// (antes de truncar y normalizar). Se pasa como JSON.stringify a deezer.parse.
// Validates: Requirements 3.2
// ─────────────────────────────────────────────────────────────────────────────

test('Property 3 (Deezer): parse mapea tracks.data[] a tracklist con longitud y campos correctos (>=200 iter)', () => {
  const rng = makeRng(0xDEE2E5);
  for (let i = 0; i < ITER; i++) {
    const payload = genDeezerPayload(rng);
    const rows = payload._rows;
    const res = deezer.parse(JSON.stringify(payload));

    if (rows.length === 0) {
      // tracks.data vacío es un array válido → éxito con tracklist vacío (no es
      // la rama de fallo; el vacío lo maneja el orquestador como EMPTY_PLAYLIST).
      assert.strictEqual(res.ok, true, `tracks.data vacío debería parsear ok: ${JSON.stringify(res)}`);
      assert.strictEqual(res.tracklist.length, 0, 'tracklist vacío para tracks.data vacío');
      continue;
    }

    assert.strictEqual(res.ok, true, `debería tener éxito: ${JSON.stringify(res)}`);

    // Longitud igual a tracks.data.
    assert.strictEqual(res.tracklist.length, rows.length,
      `longitud del tracklist != tracks.data: ${res.tracklist.length} != ${rows.length}`);

    // Mapeo campo a campo, en orden.
    for (let k = 0; k < rows.length; k++) {
      assert.strictEqual(res.tracklist[k].name, rows[k].title,
        `name[${k}] != tracks.data[${k}].title`);
      assert.strictEqual(res.tracklist[k].artist, rows[k].artist.name,
        `artist[${k}] != tracks.data[${k}].artist.name`);
    }

    // playlistName === title (o null si no hay title).
    assert.strictEqual(res.playlistName, payload.title || null, 'playlistName debe ser title || null');
  }
});

test('Deezer: parse() soporta la forma antigua con `data` directo (fallback)', () => {
  // Algunos endpoints devuelven las pistas en `data` en vez de `tracks.data`.
  const payload = {
    id: 1,
    title: 'Directo',
    data: [
      { title: 'A', artist: { name: 'Artista A' } },
      { title: 'B', artist: { name: 'Artista B' } },
    ],
  };
  const res = deezer.parse(JSON.stringify(payload));
  assert.strictEqual(res.ok, true, `fallback data[] debe parsear: ${JSON.stringify(res)}`);
  assert.deepStrictEqual(res.tracklist, [
    { name: 'A', artist: 'Artista A' },
    { name: 'B', artist: 'Artista B' },
  ]);
});

// ─────────────────────────────────────────────────────────────────────────────
// Property 4: Forma del resultado del extractor (Deezer).
//
// Toda salida de parse() es {ok:true, tracklist:[{name,artist}], playlistName}
// o {ok:false, reason}, nunca intermedia — para JSON válido, {error},
// data no-array, JSON inválido y fixtures.
// Validates: Requirements 7.1, 7.2, 3.2, 3.3
// ─────────────────────────────────────────────────────────────────────────────

test('Property 4 (Deezer): toda salida de parse tiene forma de éxito o de fallo, nunca intermedia (>=200 iter)', () => {
  const rng = makeRng(0xDEE24);

  const GARBAGE = [
    '',
    'not json at all',
    '{ broken json',
    '{}',
    '{"data": "no soy array"}',
    '{"data": 42}',
    '{"data": null}',
    '{"error": {"code": 800, "message": "no data"}}',
    '{"error": {}, "data": []}',
    readFixture('deezer-error.json'),
    readFixture('deezer-no-data.json'),
    readFixture('deezer-playlist.json'),
  ];

  for (let i = 0; i < ITER; i++) {
    let body;
    const mode = rng();
    if (mode < 0.4) {
      body = pick(rng, GARBAGE);
    } else {
      // Payload bien formado (data array) de longitud variable.
      body = JSON.stringify(genDeezerPayload(rng));
    }

    const res = deezer.parse(body);
    assertExtractorShape(res, `iter=${i} mode=${mode.toFixed(3)}`);
  }
});
