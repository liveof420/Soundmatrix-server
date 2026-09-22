// test/extractors/tidal.test.js
// Tests con fixtures del Extractor_Tidal (parseo PURO, sin red).
// Runner: node --test nativo, sin dependencias npm.
//
// Cubre:
//   - Tracklist esperado del fixture válido (name/artist, longitud).
//   - Property 4: Forma del resultado del extractor (ok:true|ok:false).
//   - Edge case 6.3: fixture sin metadatos → EXTRACTION_FAILED.
//
// Validates: Requirements 6.2, 6.3, 7.1

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const tidal = require('../../lib/extractors/tidal');
const { assertExtractorShape } = require('./_shape');

const FIXTURES = path.join(__dirname, '..', 'fixtures');
function readFixture(name) {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf8');
}

// Tracklist esperado del fixture del reproductor embed (formato real):
// <span slot="title"> + <span slot="artist"><a>...</a></span>. La última pista
// tiene dos <a> (Queen + David Bowie); el parser toma el primero como artista
// principal → "Queen".
const TIDAL_EXPECTED = [
  { name: 'Bohemian Rhapsody', artist: 'Queen' },
  { name: 'Stairway to Heaven', artist: 'Led Zeppelin' },
  { name: 'Hotel California', artist: 'Eagles' },
  { name: 'Under Pressure', artist: 'Queen' },
];

test('Tidal: parse(fixture embed real) devuelve el tracklist esperado (Req 6.2)', () => {
  const body = readFixture('tidal-playlist.html');

  // El fixture DEBE reflejar el formato real del embed (slot="title"/"artist"),
  // porque la página normal de Tidal es una SPA sin tracklist en el HTML.
  assert.ok(/slot="title"/.test(body) && /slot="artist"/.test(body),
    'el fixture debe usar el formato real del reproductor embed de Tidal');

  const res = tidal.parse(body);

  assert.strictEqual(res.ok, true, `esperaba ok:true, fue ${JSON.stringify(res)}`);
  assert.strictEqual(res.tracklist.length, TIDAL_EXPECTED.length,
    `longitud del tracklist inesperada: ${res.tracklist.length}`);
  assert.deepStrictEqual(res.tracklist, TIDAL_EXPECTED,
    'el tracklist parseado no coincide con el esperado');
  // El embed no trae el nombre de la playlist → null (fallback "Playlist" lo pone buildPayload).
  assert.strictEqual(res.playlistName, null,
    `playlistName inesperado: ${JSON.stringify(res.playlistName)}`);
});

test('Property 4: Tidal — salida de parse(válido) cumple la forma del extractor (Req 7.1)', () => {
  const res = tidal.parse(readFixture('tidal-playlist.html'));
  assertExtractorShape(res, 'tidal.parse(tidal-playlist.html)');
});

test('Tidal: parse(fixture sin metadatos) → EXTRACTION_FAILED (edge case Req 6.3)', () => {
  const body = readFixture('tidal-no-data.html');
  const res = tidal.parse(body);

  assert.strictEqual(res.ok, false, `esperaba ok:false, fue ${JSON.stringify(res)}`);
  assert.strictEqual(res.reason, 'EXTRACTION_FAILED',
    `reason inesperado: ${JSON.stringify(res.reason)}`);
});

test('Property 4: Tidal — salida de parse(degradado) cumple la forma del extractor (Req 7.1)', () => {
  const inputs = [
    ['tidal-no-data.html', readFixture('tidal-no-data.html')],
    ['empty-string', ''],
    ['garbage', '<html>sin metadatos de pistas</html>'],
    ['null', null],
    ['__NEXT_DATA__ vacío', '<script id="__NEXT_DATA__" type="application/json">{}</script>'],
  ];
  for (const [label, body] of inputs) {
    const res = tidal.parse(body);
    assertExtractorShape(res, `tidal.parse(${label})`);
  }
});
