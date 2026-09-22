// test/extractors/appleMusic.test.js
// Tests con fixtures del Extractor_AppleMusic (parseo PURO, sin red).
// Runner: node --test nativo, sin dependencias npm.
//
// Cubre:
//   - Tracklist esperado del fixture válido (name/artist, longitud).
//   - Property 4: Forma del resultado del extractor (ok:true|ok:false).
//   - Edge case 4.3: fixture sin metadatos → EXTRACTION_FAILED.
//
// Validates: Requirements 4.2, 4.3, 7.1

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const appleMusic = require('../../lib/extractors/appleMusic');
const { assertExtractorShape } = require('./_shape');

const FIXTURES = path.join(__dirname, '..', 'fixtures');
function readFixture(name) {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf8');
}

// Tracklist esperado del fixture válido (ld+json schema.org: name + byArtist.name,
// byArtist también como string en la última pista).
const APPLE_EXPECTED = [
  { name: 'As It Was', artist: 'Harry Styles' },
  { name: 'Tití Me Preguntó', artist: 'Bad Bunny' },
  { name: 'Unholy (feat. Kim Petras)', artist: 'Sam Smith' },
  { name: 'Anti-Hero', artist: 'Taylor Swift' },
];

test('Apple Music: parse(fixture válido ld+json con byArtist) devuelve el tracklist esperado (Req 4.2)', () => {
  const body = readFixture('apple-playlist.html');
  const res = appleMusic.parse(body);

  assert.strictEqual(res.ok, true, `esperaba ok:true, fue ${JSON.stringify(res)}`);
  assert.strictEqual(res.tracklist.length, APPLE_EXPECTED.length,
    `longitud del tracklist inesperada: ${res.tracklist.length}`);
  assert.deepStrictEqual(res.tracklist, APPLE_EXPECTED,
    'el tracklist parseado no coincide con el esperado');
  assert.strictEqual(res.playlistName, 'Todo Éxitos',
    `playlistName inesperado: ${JSON.stringify(res.playlistName)}`);
});

// Tracklist esperado del fixture REAL de playlist. Refleja el bug corregido:
// en playlists reales de Apple Music el ld+json trae los nombres SIN artista,
// y el artista solo está en serialized-server-data. El parser debe preferir
// server-data (con artista) y tomar el nombre de playlist del ld+json.
const APPLE_REAL_EXPECTED = [
  { name: 'Un Verano en Nueva York', artist: 'El Gran Combo de Puerto Rico' },
  { name: 'Llorarás', artist: 'Dimensión Latina' },
  { name: 'El Cantante', artist: 'Héctor Lavoe' },
  { name: 'Pedro Navaja', artist: 'Willie Colón & Rubén Blades' },
];

test('Apple Music: playlist real (ld+json sin artista + server-data con artista) → artistas correctos (Req 4.2)', () => {
  const body = readFixture('apple-playlist-real.html');
  const res = appleMusic.parse(body);

  assert.strictEqual(res.ok, true, `esperaba ok:true, fue ${JSON.stringify(res)}`);
  assert.deepStrictEqual(res.tracklist, APPLE_REAL_EXPECTED,
    'debe tomar los artistas de serialized-server-data, no dejarlos vacíos');

  // Regresión clave: NINGÚN artista debe venir vacío (ese era el bug).
  for (const t of res.tracklist) {
    assert.ok(t.artist && t.artist.trim().length > 0,
      `artista vacío en pista "${t.name}" — server-data no se usó`);
  }

  // El nombre de la playlist sale del ld+json (no del texto de UI del server-data).
  assert.strictEqual(res.playlistName, 'Salsa clásica: imprescindibles',
    `playlistName inesperado: ${JSON.stringify(res.playlistName)}`);
});

test('Apple Music: ld+json SIN artista y sin server-data → EXTRACTION_FAILED (no devuelve tracks sin artista)', () => {
  // Si solo hay ld+json de playlist sin byArtist y no hay server-data, el parser
  // NO debe devolver pistas con artista vacío (romperían el matching): falla.
  const html = [
    '<html><head>',
    '<script type="application/ld+json">',
    JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'MusicPlaylist',
      name: 'Sin Artistas',
      track: [
        { '@type': 'MusicRecording', name: 'Cancion A' },
        { '@type': 'MusicRecording', name: 'Cancion B' },
      ],
    }),
    '</script></head><body></body></html>',
  ].join('');

  const res = appleMusic.parse(html);
  assert.strictEqual(res.ok, false,
    `ld+json sin artista y sin server-data debe fallar, fue ${JSON.stringify(res)}`);
  assert.strictEqual(res.reason, 'EXTRACTION_FAILED');
});

test('Property 4: Apple Music — salida de parse(válido) cumple la forma del extractor (Req 7.1)', () => {
  const res = appleMusic.parse(readFixture('apple-playlist.html'));
  assertExtractorShape(res, 'appleMusic.parse(apple-playlist.html)');
});

test('Apple Music: parse(fixture sin metadatos) → EXTRACTION_FAILED (edge case Req 4.3)', () => {
  const body = readFixture('apple-no-data.html');
  const res = appleMusic.parse(body);

  assert.strictEqual(res.ok, false, `esperaba ok:false, fue ${JSON.stringify(res)}`);
  assert.strictEqual(res.reason, 'EXTRACTION_FAILED',
    `reason inesperado: ${JSON.stringify(res.reason)}`);
});

test('Property 4: Apple Music — salida de parse(degradado) cumple la forma del extractor (Req 7.1)', () => {
  // Property 4 debe cumplirse para TODA entrada, no solo las válidas.
  const inputs = [
    ['apple-no-data.html', readFixture('apple-no-data.html')],
    ['empty-string', ''],
    ['garbage', '<html>no ld+json here</html>'],
    ['null', null],
    ['ld+json vacío', '<script type="application/ld+json">{}</script>'],
  ];
  for (const [label, body] of inputs) {
    const res = appleMusic.parse(body);
    assertExtractorShape(res, `appleMusic.parse(${label})`);
  }
});
