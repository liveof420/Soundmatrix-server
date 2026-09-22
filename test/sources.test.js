// test/sources.test.js — Property/smoke tests de detección de fuente y registro.
// Runner nativo `node --test` (Node 18+), sin dependencias npm.
//
// Cubre:
//   - Property 1: Detección de fuente por dominio (detectSource(new URL(...))).
//   - Smoke: REGISTRY tiene exactamente 5 extractores con las 5 fuentes esperadas.
//
// Validates: Requirements 1.1, 1.2, 1.3, 11.2, 7.3

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { REGISTRY, detectSource } = require('../lib/sources');

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

// Segmentos aleatorios para path/id de playlist (alfanuméricos y guiones).
const ID_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
function randId(rng, min, max) {
  const len = randInt(rng, min, max);
  let s = '';
  for (let i = 0; i < len; i++) s += ID_CHARS[Math.floor(rng() * ID_CHARS.length)];
  return s;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fuentes soportadas: cada una con sus dominios válidos y una plantilla que
// construye una URL realista para ese dominio. detectSource() sólo mira el
// hostname (substring), pero construimos rutas plausibles por fuente.
// ─────────────────────────────────────────────────────────────────────────────

const SUPPORTED = [
  {
    source: 'Spotify',
    hosts: ['open.spotify.com', 'spotify.com'],
    build: (rng, host) => `https://${host}/playlist/${randId(rng, 8, 22)}?si=${randId(rng, 8, 16)}`,
  },
  {
    source: 'Deezer',
    hosts: ['deezer.com', 'www.deezer.com'],
    build: (rng, host) => `https://${host}/en/playlist/${randInt(rng, 1, 999999999)}`,
  },
  {
    source: 'Apple Music',
    hosts: ['music.apple.com'],
    build: (rng, host) => `https://${host}/us/playlist/${randId(rng, 3, 10)}/pl.${randId(rng, 8, 16)}`,
  },
  {
    // Solo music.youtube.com está soportado. youtube.com / youtu.be normales
    // NO se soportan (ver OUTSIDE_HOST_PARTS y el test de no-soportadas).
    source: 'YouTube Music',
    hosts: ['music.youtube.com'],
    build: (rng, host) => `https://${host}/playlist?list=${randId(rng, 10, 34)}`,
  },
  {
    source: 'Tidal',
    hosts: ['tidal.com', 'www.tidal.com', 'listen.tidal.com'],
    build: (rng, host) => `https://${host}/browse/playlist/${randId(rng, 6, 12)}-${randId(rng, 4, 8)}`,
  },
];

// Hosts que NO deben quedar dentro del set soportado. Incluye deliberadamente
// YouTube normal (youtube.com / youtu.be / www.youtube.com): solo se soporta
// music.youtube.com, así que estos deben devolver null.
const OUTSIDE_HOSTS = [
  'example.com', 'google.com', 'soundcloud.com', 'bandcamp.com',
  'napster.com', 'pandora.com', 'amazon.com', 'music.amazon.com',
  'mixcloud.com', 'audiomack.com', 'last.fm', 'genius.com',
  'facebook.com', 'twitter.com', 'reddit.com', 'wikipedia.org',
  'vimeo.com', 'twitch.tv', 'dailymotion.com', 'myspace.com',
  'qobuz.com', 'anghami.com', 'boomplay.com', 'jiosaavn.com',
  // YouTube normal NO soportado (solo music.youtube.com):
  'youtube.com', 'www.youtube.com', 'youtu.be', 'gaming.youtube.com',
];

// Devuelve un host de la lista de no-soportados. Para los que NO son de YouTube
// se les puede anteponer un subdominio aleatorio; los de YouTube se dejan tal
// cual (añadir 'music.' a 'youtube.com' lo convertiría en soportado a propósito).
function genOutsideHost(rng) {
  const base = pick(rng, OUTSIDE_HOSTS);
  const isYouTube = base.includes('youtube.com') || base === 'youtu.be';
  if (isYouTube || rng() < 0.5) return base;
  const sub = pick(rng, ['app', 'open', 'www', 'listen', 'play', 'api', 'web']);
  return `${sub}.${base}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Property 1: Detección de fuente por dominio
// Validates: Requirements 1.1, 1.2, 1.3, 11.2
// ─────────────────────────────────────────────────────────────────────────────

test('Property 1: detectSource() devuelve la fuente exacta para URLs válidas por dominio (>=200 iter)', () => {
  const rng = makeRng(0x50FA);
  for (let i = 0; i < ITER; i++) {
    const entry = pick(rng, SUPPORTED);
    const host = pick(rng, entry.hosts);
    const urlStr = entry.build(rng, host);
    const url = new URL(urlStr);
    const got = detectSource(url);
    assert.strictEqual(got, entry.source,
      `dominio soportado mal detectado: ${JSON.stringify(urlStr)} -> ${JSON.stringify(got)} (esperado ${JSON.stringify(entry.source)})`);
  }
});

test('Property 1: detectSource() cubre las 5 fuentes soportadas al menos una vez', () => {
  // Barrido determinista de todos los hosts declarados por fuente.
  const rng = makeRng(0x0DDBA11);
  const seen = new Set();
  for (const entry of SUPPORTED) {
    for (const host of entry.hosts) {
      const url = new URL(entry.build(rng, host));
      assert.strictEqual(detectSource(url), entry.source,
        `host ${host} debería mapear a ${entry.source}`);
      seen.add(entry.source);
    }
  }
  assert.deepStrictEqual(
    [...seen].sort(),
    ['Apple Music', 'Deezer', 'Spotify', 'Tidal', 'YouTube Music'],
    'las 5 fuentes deben quedar cubiertas',
  );
});

test('Property 1: detectSource() devuelve null para dominios fuera del set (>=200 iter)', () => {
  const rng = makeRng(0xBADD0);
  for (let i = 0; i < ITER; i++) {
    const host = genOutsideHost(rng);
    const urlStr = `https://${host}/playlist/${randId(rng, 6, 16)}`;
    const url = new URL(urlStr);
    const got = detectSource(url);
    assert.strictEqual(got, null,
      `dominio fuera del set debería devolver null: ${JSON.stringify(urlStr)} -> ${JSON.stringify(got)}`);
  }
});

test('Property 1: casos dirigidos de detección', () => {
  const cases = [
    ['https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M', 'Spotify'],
    ['https://www.deezer.com/en/playlist/1234567', 'Deezer'],
    ['https://music.apple.com/us/playlist/x/pl.u-abc123', 'Apple Music'],
    ['https://music.youtube.com/playlist?list=PLxxxx', 'YouTube Music'],
    // YouTube normal NO soportado (solo music.youtube.com):
    ['https://www.youtube.com/playlist?list=PLxxxx', null],
    ['https://youtube.com/playlist?list=PLxxxx', null],
    ['https://youtu.be/abc123', null],
    ['https://tidal.com/browse/playlist/uuid-1234', 'Tidal'],
    ['https://example.com/playlist/abc', null],
    ['https://soundcloud.com/sets/foo', null],
  ];
  for (const [urlStr, expected] of cases) {
    assert.strictEqual(detectSource(new URL(urlStr)), expected,
      `caso dirigido: ${urlStr} -> esperado ${expected}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Smoke: REGISTRY tiene exactamente 5 extractores con las 5 fuentes esperadas.
// Validates: Requirements 7.3
// ─────────────────────────────────────────────────────────────────────────────

test('Smoke: REGISTRY registra exactamente las 5 fuentes esperadas', () => {
  const expectedSources = ['Spotify', 'Deezer', 'Apple Music', 'YouTube Music', 'Tidal'];

  const keys = Object.keys(REGISTRY);
  assert.strictEqual(keys.length, 5, `REGISTRY debe tener exactamente 5 extractores, tiene ${keys.length}`);

  assert.deepStrictEqual(
    keys.slice().sort(),
    expectedSources.slice().sort(),
    'las claves de REGISTRY deben ser exactamente las 5 fuentes soportadas',
  );

  // Cada extractor existe y declara su propio source coherente con la clave.
  for (const source of expectedSources) {
    const extractor = REGISTRY[source];
    assert.ok(extractor, `debe existir un extractor para ${source}`);
    assert.strictEqual(extractor.source, source,
      `el extractor de ${source} debe declarar source === ${JSON.stringify(source)}`);
  }
});
