// test/frontend.test.js — Tests del cruce en el frontend y de la fuente única de
// la normalización (node --test nativo, sin dependencias npm).
//
// Cubre:
//   - Property 11 (Consistencia de normalización en el cruce): variaciones que
//     normalizan igual localizan la MISMA fila del DB que el original.
//   - Property 13 (findDB preserva las features de la fila): el objeto devuelto
//     conserva intactas las features (e,t,v,ac,i) de la fila esperada.
//   - Property 12 (Fuente única de la normalización): index.html no reimplementa
//     las reglas y carga /normalize.js; normalize.js evaluado en un contexto
//     tipo-navegador produce el mismo resultado que require('../normalize'); y
//     GET /normalize.js del server devuelve byte-a-byte el archivo.
//
// NOTA sobre la lógica replicada de findDB:
//   El findDB real vive dentro de index.html (dentro de un <script> junto al DB
//   de 82.080 filas y todo el recomendador), y no es importable como módulo. Por
//   eso este test REPLICA la lógica EXACTA de index.html (construcción de NIDX +
//   match exacto por nombre normalizado + fallback por substring normalizando
//   AMBOS lados), usando las funciones normalize/normalizeArtist REALES de
//   ../normalize (la misma fuente única que carga el navegador). La copia de
//   makeFindDB() abajo es idéntica, línea por línea, a la de index.html (§Cambios
//   concretos en index.html del design.md); si una cambia, la otra debe cambiar.
//
// Validates: Requirements 13.1, 13.2, 13.3, 14.3

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const { normalize, normalizeArtist } = require('../normalize');

const ROOT = path.join(__dirname, '..');
const NORMALIZE_PATH = path.join(ROOT, 'normalize.js');
const INDEX_HTML_PATH = path.join(ROOT, 'index.html');

// ─────────────────────────────────────────────────────────────────────────────
// PRNG determinista (mulberry32) — mismo estilo que test/normalize.test.js.
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

// ─────────────────────────────────────────────────────────────────────────────
// Réplica EXACTA de la lógica de cruce de index.html.
//
// index.html hace:
//   const NIDX={}; for(let i=0;i<DB.length;i++){ const k=normalize(DB[i][0]); if(!(k in NIDX)) NIDX[k]=i; }
//   function findDB(name,artist){
//     const nN = normalize(name);
//     const aN = normalizeArtist(artist);
//     let ei = NIDX[nN];
//     if(ei!==undefined){ const r=DB[ei]; return {n:r[0],a:r[1],e:r[2],t:r[3],v:r[4],ac:r[5],i:r[6]}; }
//     for(let i=0;i<DB.length;i++){
//       const dN=normalize(DB[i][0]); const daN=normalizeArtist(DB[i][1]);
//       if((dN.includes(nN)||nN.includes(dN)) && (!aN||daN.includes(aN)||aN.includes(daN)))
//         return {n:DB[i][0],a:DB[i][1],e:DB[i][2],t:DB[i][3],v:DB[i][4],ac:DB[i][5],i:DB[i][6]};
//     }
//     return null;
//   }
//
// Aquí se construye la misma NIDX sobre un DB de prueba y se expone la misma
// findDB, usando las funciones normalize/normalizeArtist reales de ../normalize.
// ─────────────────────────────────────────────────────────────────────────────
function makeFindDB(DB) {
  // Clave compuesta nombre|artista (Opción A): el match exacto exige título Y artista.
  const NIDX = {};
  for (let i = 0; i < DB.length; i++) {
    const k = normalize(DB[i][0]) + '|' + normalizeArtist(DB[i][1]);
    if (!(k in NIDX)) NIDX[k] = i;
  }
  function findDB(name, artist) {
    const nN = normalize(name);
    const aN = normalizeArtist(artist);
    // 1) match exacto por nombre + artista normalizados (clave compuesta).
    const ei = NIDX[nN + '|' + aN];
    if (ei !== undefined) {
      const r = DB[ei];
      return { n: r[0], a: r[1], e: r[2], t: r[3], v: r[4], ac: r[5], i: r[6] };
    }
    // 2) fallback por substring; el artista es OBLIGATORIO cuando viene informado.
    for (let i = 0; i < DB.length; i++) {
      const dN = normalize(DB[i][0]);
      const daN = normalizeArtist(DB[i][1]);
      const titleMatch = dN.includes(nN) || nN.includes(dN);
      if (!titleMatch) continue;
      if (aN) {
        if (daN && (daN.includes(aN) || aN.includes(daN)))
          return { n: DB[i][0], a: DB[i][1], e: DB[i][2], t: DB[i][3], v: DB[i][4], ac: DB[i][5], i: DB[i][6] };
      } else {
        return { n: DB[i][0], a: DB[i][1], e: DB[i][2], t: DB[i][3], v: DB[i][4], ac: DB[i][5], i: DB[i][6] };
      }
    }
    return null;
  }
  return { findDB, NIDX };
}

// ─────────────────────────────────────────────────────────────────────────────
// Generadores de nombres/artistas base y de variaciones que normalizan IGUAL.
// ─────────────────────────────────────────────────────────────────────────────

// Palabras base "limpias" (así el nombre base ya normaliza a sí mismo en minúsculas).
const BASE_WORDS = [
  'ghost', 'starlight', 'ocean', 'midnight', 'fire', 'rain', 'dream', 'echo',
  'gravity', 'sunrise', 'shadow', 'velvet', 'thunder', 'horizon', 'ember',
];
const BASE_ARTISTS = [
  'coldplay', 'radiohead', 'muse', 'phoenix', 'interpol', 'portishead',
  'aurora', 'bjork', 'lorde', 'metric',
];

// Genera un nombre base de 1..3 palabras limpias (normaliza a sí mismo).
function genBaseName(rng) {
  const n = randInt(rng, 1, 3);
  const parts = [];
  for (let i = 0; i < n; i++) parts.push(pick(rng, BASE_WORDS));
  return parts.join(' ');
}

function genBaseArtist(rng) {
  return pick(rng, BASE_ARTISTS);
}

// Mapa de letras → variante acentuada equivalente tras NFD-strip (misma letra base).
const ACCENT_MAP = {
  a: ['á', 'à', 'â', 'ä', 'ã'],
  e: ['é', 'è', 'ê', 'ë'],
  i: ['í', 'ì', 'î', 'ï'],
  o: ['ó', 'ò', 'ô', 'ö', 'õ'],
  u: ['ú', 'ù', 'û', 'ü'],
  n: ['ñ'],
  c: ['ç'],
};

// Aplica variaciones que NO cambian el resultado de normalize():
//   - mayúsculas/minúsculas aleatorias
//   - acentos (se eliminan por NFD-strip; letra base preservada)
//   - espacios múltiples y padding en extremos (se colapsan/recortan)
//   - sufijos de versión "- Acoustic/Remix/Live/Remastered" (se eliminan)
//   - bloques entre paréntesis/corchetes (se eliminan)
//   - segmentos "feat./ft." (se eliminan)
// El resultado normaliza EXACTAMENTE igual que el nombre base.
const VERSION_SUFFIXES = [
  ' - Acoustic', ' - Remix', ' - Live', ' - Remastered',
  ' - acoustic', ' - Live 2020', ' - Remastered 2011',
];
const PAREN_BLOCKS = [
  '(Bonus Track)', '[Explicit]', '(Radio Edit)', '[Deluxe]', '(2020 Version)',
];
const FEAT_SEGMENTS = [
  ' feat. Someone', ' ft. Artist', ' feat Another Name', ' ft Person',
];

function varyCase(rng, s) {
  let out = '';
  for (const ch of s) out += rng() < 0.5 ? ch.toUpperCase() : ch.toLowerCase();
  return out;
}

function varyAccents(rng, s) {
  let out = '';
  for (const ch of s) {
    const lower = ch.toLowerCase();
    if (ACCENT_MAP[lower] && rng() < 0.5) {
      const acc = pick(rng, ACCENT_MAP[lower]);
      out += ch === lower ? acc : acc.toUpperCase();
    } else {
      out += ch;
    }
  }
  return out;
}

function varySpaces(rng, s) {
  // Duplica algunos espacios; normalize colapsa a uno solo.
  let out = s.replace(/ /g, () => (rng() < 0.5 ? '   ' : ' '));
  if (rng() < 0.5) out = '   ' + out + '  ';
  return out;
}

// Produce una variación del nombre que normaliza IGUAL al original.
function varyName(rng, base) {
  let s = base;
  if (rng() < 0.8) s = varyCase(rng, s);
  if (rng() < 0.7) s = varyAccents(rng, s);
  // Los añadidos de versión/paréntesis/feat SIEMPRE al final (como en la vida real),
  // porque normalize solo los elimina cuando van tras el título.
  if (rng() < 0.5) s += pick(rng, PAREN_BLOCKS);
  if (rng() < 0.4) s += pick(rng, FEAT_SEGMENTS);
  if (rng() < 0.5) s += pick(rng, VERSION_SUFFIXES);
  if (rng() < 0.8) s = varySpaces(rng, s);
  return s;
}

// Variación de artista que normalizeArtist deja IGUAL al artista base (una sola
// palabra base sin separadores): case + acentos + espacios + un separador opcional
// con un artista secundario (que normalizeArtist descarta).
const SEP_TAILS = ['; Otro', ', Second', ' & Third', ' feat Guest', ' feat. Guest'];
function varyArtist(rng, base) {
  let s = base;
  if (rng() < 0.8) s = varyCase(rng, s);
  if (rng() < 0.7) s = varyAccents(rng, s);
  if (rng() < 0.6) s += pick(rng, SEP_TAILS); // artista secundario, descartado por normalizeArtist
  if (rng() < 0.8) s = varySpaces(rng, s);
  return s;
}

// Genera un DB de prueba pequeño con filas [name, artist, e, t, v, ac, i].
// Nombres únicos por normalize para que el match exacto por NIDX sea inequívoco.
function genTestDB(rng, size) {
  const DB = [];
  const seen = new Set();
  let guard = 0;
  while (DB.length < size && guard < size * 50) {
    guard++;
    const name = genBaseName(rng);
    const k = normalize(name);
    if (seen.has(k)) continue;
    seen.add(k);
    const artist = genBaseArtist(rng);
    const e = Math.round(rng() * 100) / 100;
    const t = Math.round(rng() * 100) / 100;
    const v = Math.round(rng() * 100) / 100;
    const ac = Math.round(rng() * 100) / 100;
    const inst = Math.round(rng() * 100) / 100;
    DB.push([name, artist, e, t, v, ac, inst]);
  }
  return DB;
}

// ─────────────────────────────────────────────────────────────────────────────
// Property 11: Consistencia de normalización en el cruce.
//
// Para cada fila del DB y cada variación de (name, artist) que normalice igual,
// findDB(variación) localiza la MISMA fila que findDB(original). Como las reglas
// se aplican idénticas a ambos lados (extraído y clave del DB), el índice de fila
// resuelto debe ser el mismo.
// Validates: Requirements 13.1, 13.2, 13.3
// ─────────────────────────────────────────────────────────────────────────────
test('Property 11: variaciones que normalizan igual localizan la misma fila (>=200 iter)', () => {
  const rng = makeRng(0xF00D11);
  const DB = genTestDB(rng, 30);
  const { findDB } = makeFindDB(DB);

  for (let it = 0; it < ITER; it++) {
    const row = DB[randInt(rng, 0, DB.length - 1)];
    const [name, artist] = row;

    const base = findDB(name, artist);
    assert.ok(base, `el original debe encontrarse: ${JSON.stringify([name, artist])}`);

    const vName = varyName(rng, name);
    const vArtist = varyArtist(rng, artist);

    // Precondición del test: la variación normaliza igual que el original.
    assert.strictEqual(normalize(vName), normalize(name),
      `precondición rota (nombre): ${JSON.stringify(vName)} vs ${JSON.stringify(name)}`);
    assert.strictEqual(normalizeArtist(vArtist), normalizeArtist(artist),
      `precondición rota (artista): ${JSON.stringify(vArtist)} vs ${JSON.stringify(artist)}`);

    const varied = findDB(vName, vArtist);
    assert.ok(varied, `la variación debe encontrarse: ${JSON.stringify([vName, vArtist])}`);

    // Debe ser exactamente la misma fila (todos los campos, incl. features).
    assert.deepStrictEqual(varied, base,
      `variación localizó otra fila: base=${JSON.stringify(base)} varied=${JSON.stringify(varied)} ` +
      `input=${JSON.stringify([vName, vArtist])}`);
  }
});

test('Property 11: caso dirigido — "Ghost - Acoustic" y "GHÓST" cruzan la fila "ghost"', () => {
  const DB = [
    ['ghost', 'coldplay', 0.5, 0.4, 0.6, 0.1, 0.0],
    ['ocean', 'muse', 0.3, 0.2, 0.7, 0.2, 0.1],
  ];
  const { findDB } = makeFindDB(DB);
  const base = findDB('ghost', 'coldplay');
  assert.deepStrictEqual(findDB('Ghost - Acoustic', 'COLDPLAY'), base);
  assert.deepStrictEqual(findDB('  GHÓST  (Bonus Track)', 'Coldplay & Someone'), base);
});

// ─────────────────────────────────────────────────────────────────────────────
// Regresión del bug de falso positivo por título (clave compuesta, Opción A):
// findDB NO debe emparejar por título ignorando el artista. Si en la base existe
// una canción con el mismo título pero OTRO artista, y el artista consultado no
// está, el resultado debe ser null (no encontrada), no la fila del otro artista.
// Validates: Requirements 13.1, 13.3
// ─────────────────────────────────────────────────────────────────────────────
test('Regresión: "KOKO / Omar Courtz" no debe emparejarse con la "Koko" de otro artista', () => {
  // La base tiene una "Koko" de Karen Nyame KG (no de Omar Courtz).
  const DB = [
    ['Koko', 'Karen Nyame KG;Mista Silva', 0.7, 0.6, 0.5, 0.1, 0.0],
    ['Otra', 'Alguien', 0.2, 0.2, 0.2, 0.2, 0.0],
  ];
  const { findDB } = makeFindDB(DB);

  // KOKO de Omar Courtz NO está en la base → debe ser null (antes: falso positivo).
  assert.strictEqual(findDB('KOKO', 'Omar Courtz'), null,
    'no debe emparejar por título ignorando el artista');

  // La "Koko" con su artista correcto SÍ se encuentra.
  const hit = findDB('Koko', 'Karen Nyame KG');
  assert.ok(hit, 'la "Koko" con artista correcto debe encontrarse');
  assert.strictEqual(hit.n, 'Koko');
  assert.strictEqual(hit.a, 'Karen Nyame KG;Mista Silva');
});

test('Regresión: mismo título con dos artistas distintos resuelve a la fila correcta por artista', () => {
  const DB = [
    ['Angel', 'Artist One', 0.1, 0.1, 0.1, 0.1, 0.0],
    ['Angel', 'Artist Two', 0.9, 0.9, 0.9, 0.9, 0.0],
  ];
  const { findDB } = makeFindDB(DB);

  const a = findDB('Angel', 'Artist One');
  const b = findDB('Angel', 'Artist Two');
  assert.strictEqual(a.e, 0.1, 'debe resolver a la fila de Artist One');
  assert.strictEqual(b.e, 0.9, 'debe resolver a la fila de Artist Two');

  // Un artista que no existe con ese título → null.
  assert.strictEqual(findDB('Angel', 'Artist Three'), null,
    'título existente pero artista inexistente → null');
});

// ─────────────────────────────────────────────────────────────────────────────
// Property 13: findDB preserva las features de la fila.
//
// Para cada fila con features aleatorias (e,t,v,ac,i), findDB(variación) devuelve
// exactamente esas features intactas y los nombres/artista ORIGINALES de la fila.
// La normalización solo decide QUÉ fila, nunca modifica los valores.
// Validates: Requirements 13.1, 13.2
// ─────────────────────────────────────────────────────────────────────────────
test('Property 13: findDB devuelve las features intactas de la fila esperada (>=200 iter)', () => {
  const rng = makeRng(0xFEA731E);

  for (let it = 0; it < ITER; it++) {
    // DB fresco por iteración con features aleatorias.
    const DB = genTestDB(rng, randInt(rng, 3, 12));
    const { findDB } = makeFindDB(DB);
    const idx = randInt(rng, 0, DB.length - 1);
    const row = DB[idx];
    const [name, artist, e, t, v, ac, inst] = row;

    const vName = varyName(rng, name);
    const vArtist = varyArtist(rng, artist);

    const res = findDB(vName, vArtist);
    assert.ok(res, `debe encontrar la fila: ${JSON.stringify([vName, vArtist])}`);

    // Objeto con la forma esperada {n,a,e,t,v,ac,i}.
    assert.deepStrictEqual(Object.keys(res).sort(), ['a', 'ac', 'e', 'i', 'n', 't', 'v'],
      `forma del objeto incorrecta: ${JSON.stringify(res)}`);

    // Features EXACTAS de la fila esperada (no las de otra fila).
    // Nota: el match exacto por NIDX devuelve la PRIMERA fila con esa clave
    // normalizada; genTestDB garantiza claves únicas, así que es esta fila.
    const expected = { n: name, a: artist, e, t, v, ac, i: inst };
    assert.deepStrictEqual(res, expected,
      `features/campos alterados: got=${JSON.stringify(res)} expected=${JSON.stringify(expected)}`);

    // Reforzar: los valores numéricos de features son idénticos (===).
    assert.strictEqual(res.e, e, 'feature e alterada');
    assert.strictEqual(res.t, t, 'feature t alterada');
    assert.strictEqual(res.v, v, 'feature v alterada');
    assert.strictEqual(res.ac, ac, 'feature ac alterada');
    assert.strictEqual(res.i, inst, 'feature i alterada');
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Property 12 (a): index.html NO reimplementa las reglas y SÍ carga /normalize.js.
// Validates: Requirements 13.3, 14.3
// ─────────────────────────────────────────────────────────────────────────────
test('Property 12a: index.html no define normalize/normalizeArtist y carga /normalize.js', () => {
  const html = fs.readFileSync(INDEX_HTML_PATH, 'utf8');

  // NO reimplementa las funciones.
  assert.ok(!/function\s+normalize\b/.test(html),
    'index.html no debe declarar "function normalize"');
  assert.ok(!/function\s+normalizeArtist\b/.test(html),
    'index.html no debe declarar "function normalizeArtist"');

  // SÍ carga la fuente única servida por el backend.
  assert.ok(/<script\s+src=["'][^"']*normalize\.js["']><\/script>/.test(html),
    'index.html debe incluir <script src=".../normalize.js"></script>');

  // Y usa window.SM_NORMALIZE (misma implementación que el server).
  assert.ok(/window\.SM_NORMALIZE/.test(html),
    'index.html debe usar window.SM_NORMALIZE');
});

// ─────────────────────────────────────────────────────────────────────────────
// Property 12 (b): normalize.js evaluado en contexto tipo-navegador (sin module)
// produce el MISMO resultado que require('../normalize').
//
// Se lee el archivo como texto y se ejecuta con vm en un contexto donde `module`
// es undefined, de modo que el UMD cae en la rama `root.SM_NORMALIZE = api`.
// Luego se compara SM_NORMALIZE.normalize(s) === require('../normalize').normalize(s)
// para un lote de entradas generadas (y lo mismo con normalizeArtist).
// Validates: Requirements 13.3, 14.3
// ─────────────────────────────────────────────────────────────────────────────
test('Property 12b: normalize.js en contexto navegador == require(../normalize) (>=200 iter)', () => {
  const code = fs.readFileSync(NORMALIZE_PATH, 'utf8');

  // Contexto "navegador": un objeto global fake sin `module` ni `module.exports`.
  // El UMD usa `typeof module !== 'undefined' && module.exports`; al no existir
  // `module`, evalúa a false y ejecuta la rama `root.SM_NORMALIZE = api`.
  // `root` es `typeof globalThis !== 'undefined' ? globalThis : this` → el
  // globalThis del sandbox de vm.
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'normalize.js' });

  const browserApi = sandbox.SM_NORMALIZE;
  assert.ok(browserApi && typeof browserApi.normalize === 'function',
    'el contexto navegador debe publicar SM_NORMALIZE.normalize');
  assert.ok(typeof browserApi.normalizeArtist === 'function',
    'el contexto navegador debe publicar SM_NORMALIZE.normalizeArtist');

  // Lote de entradas generadas (reutiliza los generadores de variación).
  const rng = makeRng(0x5A11CE);
  for (let it = 0; it < ITER; it++) {
    const baseName = genBaseName(rng);
    const s = varyName(rng, baseName);
    assert.strictEqual(browserApi.normalize(s), normalize(s),
      `normalize divergió browser vs node: ${JSON.stringify(s)}`);

    const baseArtist = genBaseArtist(rng);
    const a = varyArtist(rng, baseArtist);
    assert.strictEqual(browserApi.normalizeArtist(a), normalizeArtist(a),
      `normalizeArtist divergió browser vs node: ${JSON.stringify(a)}`);
  }

  // También un puñado de casos dirigidos con acentos/separadores.
  for (const s of ['Ghost - Acoustic', 'Say Something (feat. X)', 'ÁÉÍÓÚ  café']) {
    assert.strictEqual(browserApi.normalize(s), normalize(s), `dirigido normalize: ${s}`);
  }
  for (const a of ['Jason Mraz;Colbie Caillat', 'A & B', 'X feat Y']) {
    assert.strictEqual(browserApi.normalizeArtist(a), normalizeArtist(a), `dirigido normalizeArtist: ${a}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Property 12 (c): GET /normalize.js del server devuelve byte-a-byte normalize.js
// con Content-Type de JavaScript.
//
// Mismo patrón que test/server.test.js: se espía http.createServer ANTES de
// require('../server') (que llama a listen() al cargar) con PORT=0, se hace la
// request y se compara el body con fs.readFileSync('normalize.js'). Se cierra el
// server al final.
// Validates: Requirements 13.3, 14.3
// ─────────────────────────────────────────────────────────────────────────────
let server;
let baseUrl;
let realCreateServer;
let realFetch;

before(async () => {
  // Evitar cualquier red real accidental si el server intentara usar fetch.
  realFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 404, text: async () => '' });

  realCreateServer = http.createServer;
  http.createServer = function (...args) {
    const s = realCreateServer.apply(this, args);
    server = s;
    return s;
  };

  process.env.PORT = '0';
  require('../server'); // llama a listen() al importar
  http.createServer = realCreateServer;

  assert.ok(server, 'no se pudo capturar la instancia del server');
  await new Promise((resolve) => {
    if (server.listening) return resolve();
    server.once('listening', resolve);
  });
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  if (realFetch !== undefined) global.fetch = realFetch;
  if (server) await new Promise((resolve) => server.close(resolve));
});

// GET simple que devuelve { status, headers, body }.
function httpGet(urlPath) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlPath, baseUrl);
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET' },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

test('Property 12c: GET /normalize.js devuelve byte-a-byte normalize.js con Content-Type JS', async () => {
  const res = await httpGet('/normalize.js');

  assert.strictEqual(res.status, 200, `esperado 200: ${res.status}`);

  // Content-Type de JavaScript.
  const ct = String(res.headers['content-type'] || '');
  assert.ok(/javascript/i.test(ct), `Content-Type debe ser de JavaScript, fue: ${ct}`);

  // Byte-a-byte igual al archivo en disco.
  const onDisk = fs.readFileSync(NORMALIZE_PATH);
  const served = Buffer.from(res.body, 'utf8');
  assert.ok(served.equals(onDisk),
    'el body servido debe ser byte-a-byte igual a normalize.js en disco');
});
