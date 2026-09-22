// test/server.test.js — Tests de integración "sin LLM" y de contrato del
// Servidor_SoundMatrix (node --test nativo, sin dependencias npm).
//
// Estrategia:
//   - Se espía `http.createServer` ANTES de `require('../server')` para capturar
//     la instancia del server (server.js NO la exporta y llama a listen() al
//     cargar). Con la instancia capturada podemos leer el puerto real
//     (server.address().port, con PORT=0 el SO asigna uno libre) y cerrarla
//     al final para no dejar handles colgados.
//   - Se mockea `global.fetch` para (a) registrar TODAS las URLs solicitadas y
//     (b) devolver el fixture embed de Spotify en un flujo de éxito SIN red real.
//     Así ninguna prueba toca la red y podemos afirmar que jamás se contacta
//     `localhost:9000` ni `api.anthropic.com` (Req 11.4).
//   - Las peticiones HTTP contra el server se hacen con `node:http` (sin deps).
//
// Cubre:
//   - Sin LLM (Req 11.4): ninguna petición apunta a `localhost:9000` ni
//     `anthropic`, en flujo de ÉXITO y de ERROR.
//   - Property 2 (Rechazo de enlaces inválidos): links ausentes o sin esquema
//     http/https → estado != 200 y error.message no vacío, sin extracción.
//   - Property 10 (Playlist vacía → error): extracción exitosa con tracklist
//     vacío → estado != 200 (422 EMPTY_PLAYLIST), error.message no vacío, sin
//     payload de canciones.
//   - Contrato de éxito (Req 12.4): flujo con fixture → status 200 y envoltorio
//     {content:[{type:'text',text:'<JSON>'}]} parseable con {songs,service,playlist_name}.
//
// Validates: Requirements 11.1, 11.3, 11.4, 11.5, 12.4, 12.5

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const FIXTURES = path.join(__dirname, 'fixtures');
const readFixture = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

// ─────────────────────────────────────────────────────────────────────────────
// Estado compartido del arranque del server.
// ─────────────────────────────────────────────────────────────────────────────
let server;            // instancia capturada de http.createServer
let baseUrl;           // http://127.0.0.1:<puerto>
let requestedUrls;     // registro de todas las URLs pasadas a fetch (mock)
let realFetch;         // fetch original para restaurar
let realCreateServer;  // http.createServer original para restaurar
let sources;           // ../lib/sources (para inyectar fakes en el REGISTRY)

// El fixture embed real de Spotify (para el flujo de éxito sin red).
const SPOTIFY_EMBED = readFixture('spotify-embed.html');

// ─────────────────────────────────────────────────────────────────────────────
// Mock de global.fetch:
//   - Registra CADA URL solicitada en `requestedUrls`.
//   - Para URLs de open.spotify.com devuelve el fixture embed (éxito).
//   - Para cualquier otra URL devuelve un 404 tipo Response (fallo controlado).
// Nunca hace una petición de red real.
// ─────────────────────────────────────────────────────────────────────────────
function installFetchMock() {
  requestedUrls = [];
  realFetch = global.fetch;
  global.fetch = async (url, _opts) => {
    const u = String(url);
    requestedUrls.push(u);
    if (u.includes('open.spotify.com')) {
      return {
        ok: true,
        status: 200,
        text: async () => SPOTIFY_EMBED,
      };
    }
    return {
      ok: false,
      status: 404,
      text: async () => '',
    };
  };
}

function restoreFetchMock() {
  if (realFetch !== undefined) global.fetch = realFetch;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cliente HTTP mínimo (node:http) para pegarle al server bajo prueba.
// Devuelve { status, body }.
// ─────────────────────────────────────────────────────────────────────────────
function request(method, urlPath, jsonBody) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlPath, baseUrl);
    const payload = jsonBody === undefined ? null : Buffer.from(JSON.stringify(jsonBody));
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': payload.length }
          : {},
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Arranque / apagado del server bajo prueba.
// ─────────────────────────────────────────────────────────────────────────────
before(async () => {
  // 1. Mockear fetch antes de cargar cualquier cosa que pudiera usarlo.
  installFetchMock();

  // 2. Espiar http.createServer para capturar la instancia que crea server.js.
  realCreateServer = http.createServer;
  http.createServer = function (...args) {
    const s = realCreateServer.apply(this, args);
    server = s; // capturamos la primera (y única) instancia de server.js
    return s;
  };

  // 3. PORT=0 → el SO asigna un puerto libre; evita colisiones en CI.
  process.env.PORT = '0';

  // 4. Cargar el server (llama a listen() al importar).
  require('../server');
  sources = require('../lib/sources');

  // Restaurar createServer inmediatamente (ya capturamos la instancia).
  http.createServer = realCreateServer;

  assert.ok(server, 'no se pudo capturar la instancia del server');

  // 5. Esperar a que el server esté escuchando y calcular baseUrl.
  await new Promise((resolve) => {
    if (server.listening) return resolve();
    server.once('listening', resolve);
  });
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  restoreFetchMock();
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
});

// Afirma que NINGUNA URL registrada por el mock de fetch apunta al gateway LLM
// (localhost:9000) ni a Anthropic. Requirement 11.4.
function assertNoLlmCalls(ctx) {
  for (const u of requestedUrls) {
    assert.ok(!u.includes('localhost:9000'),
      `${ctx}: se contactó el gateway LLM (localhost:9000): ${u}`);
    assert.ok(!/anthropic/i.test(u),
      `${ctx}: se contactó Anthropic: ${u}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Sin LLM (Req 11.4) — flujo de ÉXITO.
//
// Con el mock de Spotify, POST /analyze con un link de Spotify tiene éxito
// usando SOLO fetch mockeado. Verificamos que las URLs solicitadas son de
// open.spotify.com y NUNCA de localhost:9000 ni anthropic.
// Validates: Requirements 11.4
// ─────────────────────────────────────────────────────────────────────────────
test('Sin LLM (Req 11.4): flujo de éxito no contacta localhost:9000 ni anthropic', async () => {
  requestedUrls.length = 0;
  const res = await request('POST', '/analyze', {
    link: 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M',
  });

  assert.strictEqual(res.status, 200, `esperado 200 en éxito: ${res.status} ${res.body}`);
  assertNoLlmCalls('éxito');

  // Se hizo al menos una petición y toda petición fue a Spotify (nunca al gateway).
  assert.ok(requestedUrls.length > 0, 'el flujo de éxito debió solicitar el embed de Spotify');
  for (const u of requestedUrls) {
    assert.ok(u.includes('open.spotify.com'),
      `toda petición del flujo de éxito debe ser a Spotify, fue: ${u}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Sin LLM (Req 11.4) — flujo de ERROR (link no soportado).
//
// Un dominio no soportado nunca dispara extracción de red; verificamos además
// que jamás se contacta el gateway ni Anthropic.
// Validates: Requirements 11.4
// ─────────────────────────────────────────────────────────────────────────────
test('Sin LLM (Req 11.4): flujo de error no contacta localhost:9000 ni anthropic', async () => {
  requestedUrls.length = 0;
  const res = await request('POST', '/analyze', {
    link: 'https://example.com/some/playlist',
  });

  assert.notStrictEqual(res.status, 200, `un link no soportado no debe devolver 200: ${res.body}`);
  assertNoLlmCalls('error');
});

// ─────────────────────────────────────────────────────────────────────────────
// Property 2: Rechazo de enlaces inválidos.
//
// Para links ausentes o sin esquema http/https, el server responde estado != 200
// y error.message no vacío, sin realizar extracción (ninguna petición de red).
// Validates: Requirements 11.5, 12.5
// ─────────────────────────────────────────────────────────────────────────────
test('Property 2: enlaces inválidos/ausentes → estado != 200, error.message no vacío, sin extracción', async () => {
  // Casos: body {} (sin link), link vacío, "notaurl" (sin esquema), esquema ftp.
  const cases = [
    { desc: 'body sin link', body: {} },
    { desc: 'link vacío', body: { link: '' } },
    { desc: 'link sin esquema', body: { link: 'notaurl' } },
    { desc: 'esquema no http/https', body: { link: 'ftp://x' } },
  ];

  for (const c of cases) {
    requestedUrls.length = 0;
    const res = await request('POST', '/analyze', c.body);

    assert.notStrictEqual(res.status, 200, `${c.desc}: no debe devolver 200 (${res.body})`);

    // El cuerpo debe traer un mensaje de error legible y no vacío.
    let parsed;
    try {
      parsed = JSON.parse(res.body);
    } catch (_) {
      assert.fail(`${c.desc}: cuerpo de error no es JSON: ${res.body}`);
    }
    // El frontend lee data.error.message (formato del design); toleramos también
    // el mensaje de guardas previas del server (JSON inválido / falta el campo link).
    const message =
      (parsed.error && typeof parsed.error === 'object' && parsed.error.message) ||
      (typeof parsed.error === 'string' ? parsed.error : null);
    assert.ok(typeof message === 'string' && message.length > 0,
      `${c.desc}: error.message debe ser string no vacío, fue: ${res.body}`);

    // Sin extracción: no se debió solicitar NINGUNA URL de red.
    assert.strictEqual(requestedUrls.length, 0,
      `${c.desc}: no debe realizarse extracción (fetch), URLs: ${JSON.stringify(requestedUrls)}`);
    assertNoLlmCalls(c.desc);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Property 10: Playlist vacía produce error.
//
// Se inyecta un extractor FAKE de Spotify en el REGISTRY que devuelve un
// tracklist vacío (extracción "exitosa" pero sin canciones). El server debe
// responder estado != 200 (422 EMPTY_PLAYLIST) con error.message no vacío y
// sin payload de canciones (sin envoltorio content/songs).
// Validates: Requirements 11.3, 11.5, 12.5
// ─────────────────────────────────────────────────────────────────────────────
test('Property 10: extracción exitosa con tracklist vacío → 422 EMPTY_PLAYLIST, sin payload', async () => {
  const original = sources.REGISTRY.Spotify;
  sources.REGISTRY.Spotify = {
    source: 'Spotify',
    idFrom: () => 'FAKEID',
    // "Éxito" del extractor pero con tracklist vacío.
    extract: async () => ({ ok: true, tracklist: [], playlistName: 'Vacía' }),
    parse: () => ({ ok: false, reason: 'EXTRACTION_FAILED' }),
  };

  try {
    requestedUrls.length = 0;
    const res = await request('POST', '/analyze', {
      link: 'https://open.spotify.com/playlist/FAKEID',
    });

    assert.notStrictEqual(res.status, 200, `tracklist vacío no debe devolver 200: ${res.body}`);
    assert.strictEqual(res.status, 422, `EMPTY_PLAYLIST debe mapear a 422: ${res.status} ${res.body}`);

    const parsed = JSON.parse(res.body);
    assert.ok(parsed.error && typeof parsed.error === 'object',
      `debe traer error objeto: ${res.body}`);
    assert.strictEqual(parsed.error.code, 'EMPTY_PLAYLIST',
      `code esperado EMPTY_PLAYLIST: ${res.body}`);
    assert.ok(typeof parsed.error.message === 'string' && parsed.error.message.length > 0,
      `error.message no vacío: ${res.body}`);

    // Sin payload de canciones: no hay envoltorio content ni songs.
    assert.ok(!('content' in parsed), `error EMPTY_PLAYLIST no debe traer envoltorio content: ${res.body}`);
    assert.ok(!('songs' in parsed), `error EMPTY_PLAYLIST no debe traer songs: ${res.body}`);

    assertNoLlmCalls('empty-playlist');
  } finally {
    sources.REGISTRY.Spotify = original; // restaurar SIEMPRE
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Contrato de éxito (Req 12.4): status 200 + Envoltorio_Respuesta parseable.
//
// Con el mock del embed de Spotify, el flujo de éxito debe devolver 200 y un
// cuerpo {content:[{type:'text',text:'<JSON>'}]} cuyo JSON tiene
// {songs:[{name,artist}], service, playlist_name}.
// Validates: Requirements 12.1, 12.2, 12.3, 12.4
// ─────────────────────────────────────────────────────────────────────────────
test('Contrato de éxito (Req 12.4): 200 + envoltorio content/text parseable con {songs,service,playlist_name}', async () => {
  requestedUrls.length = 0;
  const res = await request('POST', '/analyze', {
    link: 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M',
  });

  assert.strictEqual(res.status, 200, `esperado 200: ${res.status} ${res.body}`);

  // Envoltorio de nivel superior.
  const envelope = JSON.parse(res.body);
  assert.ok(Array.isArray(envelope.content), `content debe ser array: ${res.body}`);
  const block = envelope.content.find((b) => b && b.type === 'text');
  assert.ok(block, `debe existir un bloque type==='text': ${res.body}`);
  assert.strictEqual(typeof block.text, 'string', 'block.text debe ser string');

  // Payload_Frontend serializado dentro de text.
  const payload = JSON.parse(block.text);
  assert.ok(Array.isArray(payload.songs), `payload.songs debe ser array: ${block.text}`);
  assert.ok(payload.songs.length > 0, 'el fixture de Spotify produce canciones');
  for (const s of payload.songs) {
    assert.strictEqual(typeof s.name, 'string', `song.name debe ser string: ${JSON.stringify(s)}`);
    assert.strictEqual(typeof s.artist, 'string', `song.artist debe ser string: ${JSON.stringify(s)}`);
    assert.deepStrictEqual(Object.keys(s).sort(), ['artist', 'name'],
      `cada song solo tiene name/artist: ${JSON.stringify(s)}`);
  }
  assert.strictEqual(payload.service, 'Spotify', `service debe ser Spotify: ${block.text}`);
  assert.ok(typeof payload.playlist_name === 'string' && payload.playlist_name.length > 0,
    `playlist_name debe ser string no vacío: ${block.text}`);

  // Y por supuesto, ninguna llamada al LLM en el camino de éxito.
  assertNoLlmCalls('contrato-éxito');
});
