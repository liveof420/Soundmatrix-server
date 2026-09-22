// test/extractors/youtubeMusic.test.js
// Tests con fixtures del Extractor_YouTubeMusic (parseo PURO, sin red).
// Runner: node --test nativo, sin dependencias npm.
//
// FORMATO REAL: music.youtube.com NO usa `ytInitialData`. Entrega el contenido
// mediante llamadas `initialData.push({path:'/browse', params:..., data:'...'})`
// donde el JSON real viene en el campo `data` como string JavaScript
// HEX-ESCAPADO (\x22 → ", \x7b/\x7d → {/}, \/ → /, \x27 → '). El fixture
// `ytmusic-playlist.html` refleja ese formato real (regresión del bug de
// extracción). Se mantiene un fixture aparte con `ytInitialData` para verificar
// el camino de fallback/compatibilidad.
//
// Cubre:
//   - Tracklist esperado del fixture real (initialData.push + data hex-escapado).
//   - Camino de fallback: fixture con ytInitialData clásico.
//   - Property 4: Forma del resultado del extractor (ok:true|ok:false).
//   - Edge case 5.3: fixture sin datos → EXTRACTION_FAILED.
//
// Validates: Requirements 5.2, 5.3, 7.1

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const youtubeMusic = require('../../lib/extractors/youtubeMusic');
const { assertExtractorShape } = require('./_shape');

const FIXTURES = path.join(__dirname, '..', 'fixtures');
function readFixture(name) {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf8');
}

// Tracklist esperado del fixture válido. El parser lee flexColumns → runs[].text:
// texts[0] = título, texts[1] = artista. "Creepin'" incluye un apóstrofe, que en
// el formato real viene escapado dentro del string `data` (\x27) — así se
// verifica que el desescapado JS lo restaura correctamente.
const YT_EXPECTED = [
  { name: 'Flowers', artist: 'Miley Cyrus' },
  { name: 'Kill Bill', artist: 'SZA' },
  { name: "Creepin'", artist: 'Metro Boomin' },
  { name: 'Anti-Hero', artist: 'Taylor Swift' },
];

test('YouTube Music: parse(fixture real music.youtube.com initialData.push) devuelve el tracklist esperado (Req 5.2)', () => {
  const body = readFixture('ytmusic-playlist.html');

  // El fixture DEBE reflejar el formato real: initialData.push con data hex-escapado,
  // NO ytInitialData. Esto protege contra el bug donde el parser solo miraba ytInitialData.
  assert.ok(/initialData\.push/.test(body),
    'el fixture debe usar el formato real initialData.push de music.youtube.com');
  assert.ok(/\\x22/.test(body),
    'el fixture debe traer el campo data hex-escapado (\\x22, \\x7b, ...)');

  const res = youtubeMusic.parse(body);

  assert.strictEqual(res.ok, true, `esperaba ok:true, fue ${JSON.stringify(res)}`);
  assert.strictEqual(res.tracklist.length, YT_EXPECTED.length,
    `longitud del tracklist inesperada: ${res.tracklist.length}`);
  assert.deepStrictEqual(res.tracklist, YT_EXPECTED,
    'el tracklist parseado no coincide con el esperado');
  assert.strictEqual(res.playlistName, 'Fiesta 2023',
    `playlistName inesperado: ${JSON.stringify(res.playlistName)}`);
});

test('YouTube Music: parse(fixture fallback ytInitialData) sigue funcionando (compatibilidad)', () => {
  const body = readFixture('ytmusic-ytinitialdata.html');
  const res = youtubeMusic.parse(body);

  assert.strictEqual(res.ok, true, `esperaba ok:true, fue ${JSON.stringify(res)}`);
  assert.deepStrictEqual(res.tracklist, YT_EXPECTED,
    'el camino de fallback ytInitialData debe producir el mismo tracklist');
  assert.strictEqual(res.playlistName, 'Fiesta 2023');
});

test('Property 4: YouTube Music — salida de parse(válido) cumple la forma del extractor (Req 7.1)', () => {
  const res = youtubeMusic.parse(readFixture('ytmusic-playlist.html'));
  assertExtractorShape(res, 'youtubeMusic.parse(ytmusic-playlist.html)');
});

test('YouTube Music: parse(fixture sin ytInitialData) → EXTRACTION_FAILED (edge case Req 5.3)', () => {
  const body = readFixture('ytmusic-no-data.html');
  const res = youtubeMusic.parse(body);

  assert.strictEqual(res.ok, false, `esperaba ok:false, fue ${JSON.stringify(res)}`);
  assert.strictEqual(res.reason, 'EXTRACTION_FAILED',
    `reason inesperado: ${JSON.stringify(res.reason)}`);
});

test('Property 4: YouTube Music — salida de parse(degradado) cumple la forma del extractor (Req 7.1)', () => {
  const inputs = [
    ['ytmusic-no-data.html', readFixture('ytmusic-no-data.html')],
    ['empty-string', ''],
    ['garbage', '<html>sin ytInitialData</html>'],
    ['null', null],
    ['ytInitialData vacío', '<script>var ytInitialData = {};</script>'],
  ];
  for (const [label, body] of inputs) {
    const res = youtubeMusic.parse(body);
    assertExtractorShape(res, `youtubeMusic.parse(${label})`);
  }
});
