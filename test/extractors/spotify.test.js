// test/extractors/spotify.test.js — Tests del Extractor_Spotify (node --test nativo, sin deps npm).
//
// Parseo PURO sobre fixtures reales (sin red): se carga el HTML embed con
// fs.readFileSync y se llama spotify.parse(body).
//
// Cubre:
//   - Fixture realista spotify-embed.html → tracklist esperado (name/artist, longitud, orden).
//   - Fixture degradado spotify-no-data.html → {ok:false, reason:'EXTRACTION_FAILED'} (Req 2.3).
//   - Property 4: Forma del resultado del extractor — toda salida de parse es
//     {ok:true, tracklist:[{name,artist}], playlistName} o {ok:false, reason}, nunca intermedia.
//
// PRNG determinista al estilo de test/sources.test.js / test/extract.test.js.
//
// Validates: Requirements 2.2, 2.3, 7.1, 7.2

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const spotify = require('../../lib/extractors/spotify');

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

// Verifica que un resultado es UNA de las dos formas válidas del contrato de
// extractor y NUNCA una intermedia. Property 4.
function assertExtractorShape(res, ctx) {
  assert.ok(res && typeof res === 'object', `${ctx}: resultado no es objeto: ${JSON.stringify(res)}`);
  assert.strictEqual(typeof res.ok, 'boolean', `${ctx}: 'ok' debe ser boolean: ${JSON.stringify(res)}`);

  if (res.ok === true) {
    // Forma de éxito: {ok:true, tracklist:[{name,artist}], playlistName}
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
    // No debe existir 'reason' en la forma de éxito.
    assert.ok(!('reason' in res), `${ctx}: ok:true no debe incluir 'reason': ${JSON.stringify(res)}`);
  } else {
    // Forma de fallo: {ok:false, reason}
    assert.strictEqual(typeof res.reason, 'string', `${ctx}: ok:false requiere reason string: ${JSON.stringify(res)}`);
    assert.ok(res.reason.length > 0, `${ctx}: reason no vacío: ${JSON.stringify(res)}`);
    // No debe filtrar tracklist en la forma de fallo.
    assert.ok(!('tracklist' in res), `${ctx}: ok:false no debe incluir 'tracklist': ${JSON.stringify(res)}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixture realista: spotify-embed.html → tracklist esperado.
// Validates: Requirements 2.2, 7.1
// ─────────────────────────────────────────────────────────────────────────────

const EXPECTED_SPOTIFY = {
  playlistName: 'Chill Mix',
  tracklist: [
    { name: 'Sunflower', artist: 'Post Malone, Swae Lee' },
    { name: 'Blinding Lights', artist: 'The Weeknd' },
    { name: 'Levitating', artist: 'Dua Lipa, DaBaby' },
    { name: 'Watermelon Sugar', artist: 'Harry Styles' },
  ],
};

test('Spotify: parse() del fixture embed extrae el tracklist esperado (name/artist, longitud, orden)', () => {
  const body = readFixture('spotify-embed.html');
  const res = spotify.parse(body);

  assert.strictEqual(res.ok, true, `debería tener éxito: ${JSON.stringify(res)}`);
  assert.strictEqual(res.playlistName, EXPECTED_SPOTIFY.playlistName, 'nombre de playlist incorrecto');

  // Longitud y orden exactos.
  assert.strictEqual(res.tracklist.length, EXPECTED_SPOTIFY.tracklist.length, 'longitud del tracklist incorrecta');
  assert.deepStrictEqual(res.tracklist, EXPECTED_SPOTIFY.tracklist,
    'tracklist extraído no coincide (name = title, artist = subtitle, en orden)');
});

// ─────────────────────────────────────────────────────────────────────────────
// Fixture degradado: spotify-no-data.html → EXTRACTION_FAILED (Req 2.3).
// Validates: Requirements 2.3, 7.1
// ─────────────────────────────────────────────────────────────────────────────

test('Spotify: parse() de fixture sin __NEXT_DATA__ devuelve EXTRACTION_FAILED', () => {
  const body = readFixture('spotify-no-data.html');
  const res = spotify.parse(body);

  assert.strictEqual(res.ok, false, `debería fallar: ${JSON.stringify(res)}`);
  assert.strictEqual(res.reason, 'EXTRACTION_FAILED', `reason esperado EXTRACTION_FAILED: ${JSON.stringify(res)}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// Property 4: Forma del resultado del extractor (Spotify).
//
// Toda salida de parse() es {ok:true, tracklist:[{name,artist}], playlistName}
// o {ok:false, reason}, nunca una forma intermedia — para bodies válidos,
// degradados y basura arbitraria.
// Validates: Requirements 7.1, 7.2, 2.2, 2.3
// ─────────────────────────────────────────────────────────────────────────────

// Construye un HTML __NEXT_DATA__ con un entity arbitrario (posiblemente malformado).
function buildSpotifyHtml(entity) {
  const json = JSON.stringify({ props: { pageProps: { state: { data: { entity } } } } });
  return `<html><body><script id="__NEXT_DATA__" type="application/json">${json}</script></body></html>`;
}

test('Property 4 (Spotify): toda salida de parse tiene forma de éxito o de fallo, nunca intermedia (>=200 iter)', () => {
  const rng = makeRng(0x5907);

  // Bodies degradados/basura que deben caer en la rama de fallo o de éxito, pero
  // SIEMPRE respetando la forma del contrato.
  const GARBAGE = [
    '',
    'no script here',
    '<script id="__NEXT_DATA__" type="application/json">not json</script>',
    '<script id="__NEXT_DATA__" type="application/json">{}</script>',
    '<script id="__NEXT_DATA__" type="application/json">{"props":{}}</script>',
    readFixture('spotify-no-data.html'),
    readFixture('spotify-embed.html'),
  ];

  const TITLES = ['Ghost', 'HELLO', 'Canción', 'Über', 'A'.repeat(30), ''];
  const SUBS = ['Artist One', 'A, B', 'X & Y feat Z', 'José', ''];

  for (let i = 0; i < ITER; i++) {
    let body;
    const mode = rng();
    if (mode < 0.35) {
      // Body arbitrario de la lista de basura.
      body = pick(rng, GARBAGE);
    } else if (mode < 0.7) {
      // entity con trackList bien formado de longitud variable.
      const len = randInt(rng, 0, 6);
      const trackList = [];
      for (let k = 0; k < len; k++) {
        trackList.push({ title: pick(rng, TITLES), subtitle: pick(rng, SUBS) });
      }
      const entity = { name: pick(rng, ['P', 'Mix', '']), trackList };
      body = buildSpotifyHtml(entity);
    } else {
      // entity con trackList inválido (no-array): debe caer en EXTRACTION_FAILED.
      const bad = pick(rng, [{ trackList: 'nope' }, { trackList: 42 }, { trackList: null }, { foo: 'bar' }]);
      body = buildSpotifyHtml(bad);
    }

    const res = spotify.parse(body);
    assertExtractorShape(res, `iter=${i} mode=${mode.toFixed(3)}`);
  }
});
