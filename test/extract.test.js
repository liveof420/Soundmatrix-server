// test/extract.test.js — Property tests del orquestador (node --test nativo, sin deps npm).
// Cubre:
//   - Property 5: Truncado con preservación de orden (extractTracklist, slice(0,50)).
//   - Property 8: Conservación de pistas en el payload (buildPayload).
//   - Property 9: Round-trip del envoltorio (wrapResponse).
//
// Generadores propios ligeros con PRNG determinista, al estilo de
// test/normalize.test.js y test/sources.test.js (>=100 iteraciones por property).
//
// Validates: Requirements 8.1, 8.2, 10.4, 10.5, 12.1, 12.2, 12.3

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { extractTracklist, buildPayload, wrapResponse } = require('../lib/extract');
const { normalize, normalizeArtist } = require('../normalize');
const sources = require('../lib/sources');

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

// Piezas para nombres de canción y artistas "reales" (con ruido de normalización).
const NAME_WORDS = [
  'Ghost', 'Say Something', 'Love', 'Dream', 'Fire', 'Rain', 'Night',
  'HELLO', 'Canción', 'Corazón', 'Starlight', 'Ocean', 'Café', 'Über',
];
const NAME_NOISE = [
  '', '', ' - Acoustic', ' - Remix', ' (feat. X)', ' [Explicit]',
  ' - Remastered 2011', ' (Radio Edit)', '   ',
];
const ARTIST_NAMES = [
  'Jason Mraz', 'Beyoncé', 'Björk', 'The Weeknd', 'José González',
  'DAFT PUNK', 'Sigur Rós', 'Måneskin', 'Renée', 'Coldplay',
];
const ARTIST_SEPARATORS = ['', '', ';', ', ', ' & ', ' feat ', ' feat. ', ' ft. '];

// Un nombre de canción crudo (posiblemente "sucio").
function genRawName(rng) {
  return pick(rng, NAME_WORDS) + pick(rng, NAME_NOISE);
}

// Un artista crudo (posiblemente compuesto con separadores).
function genRawArtist(rng) {
  let s = pick(rng, ARTIST_NAMES);
  const extra = randInt(rng, 0, 2);
  for (let i = 0; i < extra; i++) {
    const sep = pick(rng, ARTIST_SEPARATORS);
    if (sep) s += sep + pick(rng, ARTIST_NAMES);
  }
  return s;
}

// Una pista cruda {name, artist} tal como la devolvería un extractor.
function genTrack(rng) {
  return { name: genRawName(rng), artist: genRawArtist(rng) };
}

// Un tracklist de longitud dada.
function genTracklist(rng, len) {
  const t = [];
  for (let i = 0; i < len; i++) t.push(genTrack(rng));
  return t;
}

const SERVICES = ['Spotify', 'Deezer', 'Apple Music', 'YouTube Music', 'Tidal'];
const SONG_LIMIT = 50;

// ─────────────────────────────────────────────────────────────────────────────
// Property 5: Truncado con preservación de orden.
//
// El truncado ocurre DENTRO de extractTracklist (slice(0, 50)), que requiere un
// extractor real. Para probar la propiedad de forma pura y determinista sin red,
// se inyecta un extractor FAKE en el REGISTRY: su idFrom() siempre devuelve un id
// y su extract() devuelve un tracklist de N elementos etiquetados por posición.
// Como extract.js llama a extractor.extract(url, fetch, signal) y el fake no toca
// fetch, no se hace ninguna petición de red. El REGISTRY se restaura al final.
//
// Verifica: longitud == min(len, 50), y que las pistas resultantes son
// exactamente las primeras min(len,50) del tracklist original, en el mismo orden.
// Validates: Requirements 8.1, 8.2
// ─────────────────────────────────────────────────────────────────────────────

test('Property 5: extractTracklist trunca a 50 preservando el orden (>=200 iter)', async () => {
  const rng = makeRng(0x7A17A);
  const FAKE_SOURCE = 'Spotify'; // spotify.com es una fuente detectable por dominio
  const original = sources.REGISTRY[FAKE_SOURCE];

  // Cada corrida instala un fake distinto (tracklist de longitud variable).
  try {
    for (let i = 0; i < ITER; i++) {
      const len = randInt(rng, 0, 120);
      // Pistas etiquetadas por posición para verificar orden sin ambigüedad.
      const full = [];
      for (let k = 0; k < len; k++) {
        full.push({ name: `track-${k}`, artist: `artist-${k}` });
      }

      sources.REGISTRY[FAKE_SOURCE] = {
        source: FAKE_SOURCE,
        idFrom: () => 'FAKEID',
        extract: async () => ({ ok: true, tracklist: full.slice(), playlistName: 'P' }),
        parse: () => ({ ok: false, reason: 'EXTRACTION_FAILED' }),
      };

      const res = await extractTracklist('https://open.spotify.com/playlist/FAKEID');

      if (len === 0) {
        // Tracklist vacío → EMPTY_PLAYLIST (no hay truncado que verificar).
        assert.strictEqual(res.ok, false, `len=0 debería fallar: ${JSON.stringify(res)}`);
        assert.strictEqual(res.reason, 'EMPTY_PLAYLIST', `len=0 → EMPTY_PLAYLIST: ${JSON.stringify(res)}`);
        continue;
      }

      assert.strictEqual(res.ok, true, `len=${len} debería tener éxito: ${JSON.stringify(res)}`);

      const expectedLen = Math.min(len, SONG_LIMIT);
      assert.strictEqual(res.tracklist.length, expectedLen,
        `longitud truncada incorrecta: len=${len} -> ${res.tracklist.length} (esperado ${expectedLen})`);

      // Mismo orden y mismas posiciones que las primeras `expectedLen` del original.
      for (let k = 0; k < expectedLen; k++) {
        assert.strictEqual(res.tracklist[k].name, `track-${k}`,
          `orden alterado en pos ${k} (len=${len}): ${JSON.stringify(res.tracklist[k])}`);
        assert.strictEqual(res.tracklist[k].artist, `artist-${k}`,
          `orden alterado en pos ${k} (len=${len}): ${JSON.stringify(res.tracklist[k])}`);
      }

      // Equivalencia directa con slice(0, 50) sobre el original.
      assert.deepStrictEqual(res.tracklist, full.slice(0, SONG_LIMIT),
        `el truncado debe ser slice(0,50) del original (len=${len})`);
    }
  } finally {
    sources.REGISTRY[FAKE_SOURCE] = original; // restaurar SIEMPRE
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Property 8: Conservación de pistas en el payload.
//
// buildPayload NO trunca (el truncado lo hace extractTracklist), por lo que se
// generan tracklists no vacíos de longitud <=50 y se verifica que:
//   - songs tiene la misma longitud que el tracklist,
//   - songs[i].name === normalize(tracklist[i].name),
//   - songs[i].artist === normalizeArtist(tracklist[i].artist),
//   - no hay canciones ajenas (correspondencia 1:1 en orden con el tracklist).
// Validates: Requirements 8.1, 8.2, 10.4, 10.5
// ─────────────────────────────────────────────────────────────────────────────

test('Property 8: buildPayload conserva todas las pistas normalizadas y en orden (>=200 iter)', () => {
  const rng = makeRng(0x50FA8);
  for (let i = 0; i < ITER; i++) {
    const len = randInt(rng, 1, SONG_LIMIT); // no vacío, <=50 (buildPayload no trunca)
    const tracklist = genTracklist(rng, len);
    const service = pick(rng, SERVICES);
    const playlistName = rng() < 0.5 ? null : `Playlist ${i}`;

    const payload = buildPayload(tracklist, service, playlistName);

    // Misma longitud: ninguna pista se pierde ni se inventa.
    assert.strictEqual(payload.songs.length, tracklist.length,
      `longitud de songs distinta del tracklist: ${payload.songs.length} != ${tracklist.length}`);

    // Correspondencia 1:1 en orden con la normalización correcta.
    for (let k = 0; k < tracklist.length; k++) {
      assert.strictEqual(payload.songs[k].name, normalize(tracklist[k].name),
        `name[${k}] mal normalizado: ${JSON.stringify(tracklist[k].name)} -> ${JSON.stringify(payload.songs[k].name)}`);
      assert.strictEqual(payload.songs[k].artist, normalizeArtist(tracklist[k].artist),
        `artist[${k}] mal normalizado: ${JSON.stringify(tracklist[k].artist)} -> ${JSON.stringify(payload.songs[k].artist)}`);

      // Cada song tiene exactamente las claves name y artist (nada ajeno).
      assert.deepStrictEqual(Object.keys(payload.songs[k]).sort(), ['artist', 'name'],
        `song[${k}] tiene claves inesperadas: ${JSON.stringify(payload.songs[k])}`);
    }

    // Metadatos del payload.
    assert.strictEqual(payload.service, service, 'service debe preservarse tal cual');
    assert.strictEqual(payload.playlist_name, playlistName || 'Playlist',
      'playlist_name debe caer en "Playlist" cuando es null/vacío');
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Property 9: Round-trip del envoltorio.
//
// Genera payloads {songs, service, playlist_name} y verifica que
// JSON.parse(wrapResponse(payload).content.find(b=>b.type==='text').text)
// es profundamente igual al payload original.
// Validates: Requirements 12.1, 12.2, 12.3
// ─────────────────────────────────────────────────────────────────────────────

test('Property 9: wrapResponse round-trip — el text del bloque parsea al payload original (>=200 iter)', () => {
  const rng = makeRng(0x9EA9);
  for (let i = 0; i < ITER; i++) {
    const len = randInt(rng, 0, SONG_LIMIT);
    const tracklist = genTracklist(rng, len);
    const service = pick(rng, SERVICES);
    const playlistName = rng() < 0.5 ? null : `Playlist ${i}`;

    // Construimos el payload con buildPayload para que sea representativo del real.
    const payload = buildPayload(tracklist, service, playlistName);

    const envelope = wrapResponse(payload);

    // El envoltorio tiene la forma que el frontend consume.
    assert.ok(envelope && Array.isArray(envelope.content),
      `envoltorio sin content array: ${JSON.stringify(envelope)}`);
    const block = envelope.content.find((b) => b.type === 'text');
    assert.ok(block, `debe existir un bloque type==='text': ${JSON.stringify(envelope)}`);
    assert.strictEqual(typeof block.text, 'string', 'block.text debe ser string');

    const roundTripped = JSON.parse(block.text);
    assert.deepStrictEqual(roundTripped, payload,
      `round-trip roto: ${block.text}`);
  }
});

test('Property 9: caso dirigido — envoltorio parseable con un payload conocido', () => {
  const payload = {
    songs: [{ name: 'ghost', artist: 'jason mraz' }],
    service: 'Spotify',
    playlist_name: 'Mi Playlist',
  };
  const envelope = wrapResponse(payload);
  const text = envelope.content.find((b) => b.type === 'text').text;
  assert.deepStrictEqual(JSON.parse(text), payload);
});
