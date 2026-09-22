# Documento de Diseño — Extracción de Tracklists de Playlist

## Introducción

Este diseño reemplaza la lógica actual de `server.js` (proxy a un LLM vía Kiro Gateway en `localhost:9000`) por un **servicio de extracción de tracklists por código**. El endpoint `POST /analyze` deja de "adivinar" canciones con un modelo y pasa a obtener la lista real desde la URL de la playlist, normalizarla con reglas deterministas y devolverla en el mismo envoltorio que el frontend ya consume.

Restricciones de partida (decisiones ya tomadas):

- **Sin LLM** en ningún camino (éxito o error). Se elimina el payload Anthropic, `tool_choice`, el `system` prompt y la llamada a `localhost:9000`.
- **Sin dependencias npm.** Solo Node 18+ nativo: `http`, `fetch` global, `AbortController`, `URL`, `String.prototype.normalize`.
- **Sin APIs de pago ni la API oficial de Spotify.** Todo por scraping de recursos públicos / embeds / endpoints públicos (Deezer).
- El **contrato con el frontend se preserva**: `index.html` lee `data.content.find(b=>b.type==='text').text`, le quita fences ```` ```json ```` y hace `JSON.parse` esperando `{songs:[{name,artist}], service, playlist_name}`. Los errores los lee de `data.error?.message` con `resp.ok === false`.

El lenguaje de los ejemplos es **JavaScript (Node.js, CommonJS)**, que es el del proyecto real.

---

## Arquitectura general

### Flujo de `POST /analyze`

```
Cliente (index.html)
   │  POST /analyze  { link: "<url>" }
   ▼
┌─────────────────────────────────────────────────────────────────┐
│ server.js  (handler POST /analyze)                                │
│                                                                   │
│  1. Parsear body → link                                           │
│  2. validarLink(link)         ──►  ¿ausente / sin http(s)?  ─────► ERROR 400 INVALID_LINK
│  3. detectarFuente(link)      ──►  ¿dominio no soportado?   ─────► ERROR 422 UNSUPPORTED_SOURCE
│  4. extractPlaylistId(link)   ──►  ¿id no extraíble?        ─────► ERROR 422 INVALID_LINK
│  5. registry[fuente]  →  extractor                                │
│                                                                   │
│  6. withTimeout(extractor.extract(url|id), 10s)  (AbortController) │
│         │                                                         │
│         ├─ timeout          ─────────────────────────────────────► ERROR 504 TIMEOUT
│         ├─ extracción falla ─────────────────────────────────────► ERROR 502 EXTRACTION_FAILED
│         └─ éxito → { tracklist:[{name,artist}], playlistName }     │
│                                                                   │
│  7. ¿tracklist vacío?       ─────────────────────────────────────► ERROR 422 EMPTY_PLAYLIST
│  8. truncar a 50 (preservando orden)                              │
│  9. normalizar cada pista (name + artist) con normalize()         │
│ 10. construir Payload_Frontend {songs, service, playlist_name}    │
│ 11. envolver → {content:[{type:'text',text:JSON.stringify(...)}]} │
│ 12. responder 200 application/json                                │
└─────────────────────────────────────────────────────────────────┘
   │  200 { content:[{type:'text', text:'<JSON>'}] }
   │  o    !ok { error:{ message } }
   ▼
Cliente: parsea text → JSON → songs → findDB() contra los 82.080
```

### Capas y responsabilidades

| Capa | Responsabilidad | Varía con input |
|------|-----------------|-----------------|
| **HTTP** (`server.js`) | Routing, CORS, parseo body, mapeo fallo→HTTP, envoltorio | No (I/O) |
| **Detector_Fuente** | `url → fuente` por dominio; `url → id` por regex | Sí (puro) |
| **Extractores** | `url|id → tracklist` vía red + parseo | Sí (parseo puro + I/O) |
| **Timeout** | Abortar extracción a los 10s | No (temporal) |
| **Normalizador** | `string → string` reglas deterministas | Sí (puro) |
| **Ensamblador** | `tracklist+meta → payload → envoltorio` | Sí (puro) |

El diseño separa deliberadamente la **lógica pura** (detección, extracción de id, parseo de un documento ya descargado, normalización, ensamblaje) de la **I/O** (`fetch` + timeout). Esto permite testear casi todo sin red.

---

## Estructura de archivos

El proyecto es minimalista y sin dependencias. Mantener todo en `server.js` lo volvería difícil de testear (los parsers quedarían atrapados dentro de callbacks HTTP). Se propone una separación ligera en módulos CommonJS nativos, **sin** herramientas de build:

```
Soundmatrix-server/
├── server.js                 # Solo HTTP: routing, CORS, orquestación, envoltorio, mapeo de errores, y SERVIR normalize.js
├── normalize.js              # normalize(str), normalizeArtist(str) — FUENTE ÚNICA DE VERDAD (isomorfa: Node + navegador)
├── lib/
│   ├── sources.js            # detectSource(url), extractPlaylistId(url), registry de extractores, dispatch
│   ├── extract.js            # extractTracklist(url) orquesta: dispatch + timeout + truncado + normalización
│   └── extractors/
│       ├── spotify.js
│       ├── deezer.js
│       ├── appleMusic.js
│       ├── youtubeMusic.js
│       └── tidal.js
├── test/
│   ├── fixtures/             # HTML/JSON reales guardados por fuente
│   ├── normalize.test.js
│   ├── sources.test.js
│   └── extractors/*.test.js
└── index.html                # Frontend: incluye <script src="/normalize.js"> (NO redefine normalize) — ver §Normalización
```

Cada módulo del backend se importa con `require`. `extract.js` no depende del HTTP; recibe una URL y devuelve un resultado, de modo que las pruebas pueden invocarlo directamente con `fetch` mockeado.

**Decisión clave (fuente única de verdad):** `normalize.js` deja de vivir en `lib/` y pasa a la raíz porque cumple un doble rol: (1) el backend lo consume con `require('./normalize')`, y (2) el mismo Servidor_SoundMatrix lo sirve como recurso estático en `GET /normalize.js`, de modo que `index.html` lo carga con `<script src="/normalize.js">`. Así **la lógica de las Reglas_Normalizacion existe físicamente en un solo archivo** y ambos lados (Node y navegador) ejecutan exactamente el mismo código, sin duplicación ni paso de build. Ver §"Módulo de normalización" para el detalle de por qué esta es la opción más estable dado que la Base_Canciones no puede salir del navegador.

Los tests usan el runner nativo `node --test` (Node 18+), sin instalar nada.

---

## Interfaz común del Extractor (Requirement 7)

Cada extractor es un objeto con una firma uniforme. La I/O (fetch) se inyecta para poder mockearla; el parseo es una función pura sobre el texto/JSON ya descargado.

```js
// Contrato del Extractor
/**
 * @typedef {{ name: string, artist: string }} Track
 * @typedef {{ ok: true,  tracklist: Track[], playlistName: string|null }} ExtractOk
 * @typedef {{ ok: false, reason: 'EXTRACTION_FAILED', detail?: string }} ExtractFail
 * @typedef {ExtractOk | ExtractFail} ExtractResult
 */

/**
 * @typedef {Object} Extractor
 * @property {string} source                       // 'Spotify' | 'Deezer' | ...
 * @property {(url: URL) => string|null} idFrom     // extrae id de la URL (o null)
 * @property {(url: URL, fetchFn, signal) => Promise<ExtractResult>} extract
 * @property {(body: string) => ExtractResult}     parse  // parseo puro (sobre texto ya descargado)
 */
```

### Registro y dispatch (Requirements 1.2, 7.2, 7.3)

```js
// lib/sources.js
const spotify      = require('./extractors/spotify');
const deezer       = require('./extractors/deezer');
const appleMusic   = require('./extractors/appleMusic');
const youtubeMusic = require('./extractors/youtubeMusic');
const tidal        = require('./extractors/tidal');

// Exactamente 5 extractores (Requirement 7.3)
const REGISTRY = {
  Spotify:       spotify,
  Deezer:        deezer,
  'Apple Music': appleMusic,
  'YouTube Music': youtubeMusic,
  Tidal:         tidal,
};

// Detección por dominio (Requirement 1.1). Nota: alineada con detectSvc() del frontend.
function detectSource(url) {          // url: instancia de URL
  const h = url.hostname.toLowerCase();
  if (h.includes('spotify.com'))                       return 'Spotify';
  if (h.includes('deezer.com'))                        return 'Deezer';
  if (h.includes('apple.com') || h.includes('music.apple')) return 'Apple Music';
  if (h.includes('youtube.com') || h.includes('youtu.be'))  return 'YouTube Music';
  if (h.includes('tidal.com'))                         return 'Tidal';
  return null;                        // no soportada
}

function getExtractor(source) { return REGISTRY[source] || null; }

module.exports = { REGISTRY, detectSource, getExtractor };
```

El dispatch en `extract.js`:

```js
const src = detectSource(url);
if (!src) return { ok:false, reason:'UNSUPPORTED_SOURCE' };
const extractor = getExtractor(src);
const id = extractor.idFrom(url);
if (!id) return { ok:false, reason:'INVALID_LINK' };
const result = await withTimeout(extractor.extract(url, fetch, signal), 10_000, signal);
```

---

## Extracción de ID por dominio (Requirement 1, 2.1, 3.1)

Regex por fuente, aplicadas sobre `url.pathname` (más robusto que sobre el string completo con query/fragmentos).

| Fuente | URL de ejemplo | Regex de id | id |
|--------|----------------|-------------|----|
| Spotify | `open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M` | `/playlist\/([A-Za-z0-9]+)/` | `37i9dQZF1DXcBWIGoYBM5M` |
| Deezer | `www.deezer.com/en/playlist/1234567` | `/playlist\/(\d+)/` | `1234567` |
| Apple Music | `music.apple.com/us/playlist/xxx/pl.u-abc123` | `/(pl\.[A-Za-z0-9-]+)/` | `pl.u-abc123` |
| YouTube Music | `music.youtube.com/playlist?list=PLxxxx` | query `list` → `url.searchParams.get('list')` | `PLxxxx` |
| Tidal | `tidal.com/browse/playlist/uuid-....` | `/playlist\/([a-f0-9-]+)/` | `uuid-...` |

Para Spotify se ignoran query params de tracking (`?si=...`). Para YouTube Music el id viene en el query string, no en el path.

---

## Diseño detallado de cada extractor

### 1. Extractor_Spotify (Requirement 2) — YA PROBADO funcionando

- **Petición:** `GET https://open.spotify.com/embed/playlist/{id}` con header `User-Agent` de navegador (obligatorio; sin él Spotify devuelve markup distinto o bloquea — confirmado en pruebas).
- **Parseo:** localizar `<script id="__NEXT_DATA__" type="application/json">...</script>`, extraer el JSON interno y navegar la ruta exacta:

```js
const json = JSON.parse(scriptContent);
const entity = json.props.pageProps.state.data.entity;
const playlistName = entity.name || entity.title || null;
const tracks = entity.trackList;              // ruta confirmada
const tracklist = tracks.map(t => ({
  name:   t.title,
  artist: t.subtitle,                          // subtitle = artista(s)
}));
```

- **Fallo (2.3):** si no existe el `<script id="__NEXT_DATA__">`, si `JSON.parse` lanza, o si `entity.trackList` no es array → `{ ok:false, reason:'EXTRACTION_FAILED' }`.

### 2. Extractor_Deezer (Requirement 3) — más robusto (JSON público)

- **Petición:** `GET https://api.deezer.com/playlist/{id}` (endpoint público, sin auth). Igual conviene enviar `User-Agent`.
- **Parseo:** `JSON.parse(body)` y mapear:

```js
const j = JSON.parse(body);
if (!Array.isArray(j.data)) return { ok:false, reason:'EXTRACTION_FAILED' };
const tracklist = j.data.map(t => ({
  name:   t.title,
  artist: t.artist && t.artist.name,
}));
const playlistName = j.title || null;
```

- **Fallo (3.3):** si `j.data` no es array o el body no es JSON válido → `EXTRACTION_FAILED`. Deezer también responde `{ "error": {...} }` para ids inexistentes; detectar `j.error` y tratarlo como `EXTRACTION_FAILED`.

Este es el extractor más fiable porque consume un JSON estable en lugar de scraping.

### 3. Extractor_AppleMusic (Requirement 4) — frágil (HTML)

- **Petición:** `GET` de la URL de la playlist con `User-Agent` de navegador.
- **Estrategia de parseo (defensiva, en orden):**
  1. Buscar el `<script type="application/ld+json">` (schema.org). Apple suele incluir un objeto con `track` / `itemListElement` que contiene `name` y `byArtist.name`.
  2. Alternativa: bloque `<meta name="schema:music-playlist">` o el estado embebido en `<script id="serialized-server-data">` (JSON) del que se recorre la lista de canciones.
- Se toma la primera estrategia que produzca una lista no vacía. `name` → nombre de canción, artista desde `byArtist.name` (o campo equivalente).
- **Fallo (4.3):** si ninguna estrategia encuentra metadatos de pistas → `EXTRACTION_FAILED`. Se documenta explícitamente que este parser es sensible a cambios de markup de Apple.

### 4. Extractor_YouTubeMusic (Requirement 5) — frágil (JSON embebido)

- **Petición:** `GET` de la URL con `User-Agent` de navegador (y preferiblemente `Accept-Language: en-US`).
- **Estrategia de parseo:**
  1. Localizar `var ytInitialData = {...};` en el HTML (regex `ytInitialData\s*=\s*(\{.*?\});`), `JSON.parse`.
  2. Recorrer la estructura anidada hasta `musicPlaylistShelfRenderer` / `musicResponsiveListItemRenderer`, de donde se lee el título de la pista y el nombre del artista (los `flexColumns` → `runs[].text`).
- Como la ruta anidada es profunda y volátil, se implementa un **buscador recursivo** que colecta objetos con la forma de item de pista, en vez de codificar una ruta rígida.
- **Fallo (5.3):** si no hay `ytInitialData` o no se hallan items → `EXTRACTION_FAILED`.

### 5. Extractor_Tidal (Requirement 6) — frágil (HTML/embed)

- **Petición:** `GET` del HTML de la playlist (o su recurso embed) con `User-Agent`.
- **Estrategia de parseo:**
  1. Buscar `<script type="application/ld+json">` con datos de la playlist (`track`/`itemListElement`).
  2. Alternativa: estado `__NEXT_DATA__` o `__INITIAL_STATE__` si está presente, recorriendo la lista de items para leer título y artista.
- **Fallo (6.3):** sin metadatos → `EXTRACTION_FAILED`. Se documenta como la fuente más incierta (Tidal cambia markup y a veces requiere región/JS).

> **Nota de fragilidad:** Spotify (probado) y Deezer (JSON público) son las fuentes fiables. Apple, YouTube Music y Tidal dependen de scraping de markup que puede cambiar sin aviso; su ruta de fallo bien definida (`EXTRACTION_FAILED` → error explícito) es la garantía de no devolver datos inventados (Requirement 11).

---

## Módulo de normalización: archivo `.js` único servido por el backend (Requirements 10, 13)

### El problema real y la decisión de arquitectura

Las Reglas_Normalizacion deben aplicarse de forma **idéntica** en dos momentos:

1. En el **backend**, al normalizar los nombres/artistas recién extraídos antes de devolverlos (Requirement 10).
2. En el **frontend**, al normalizar tanto los nombres recibidos como las claves de la Base_Canciones antes del cruce en `findDB` (Requirement 13).

El riesgo que hay que eliminar es la **divergencia**: si `normalize` existe copiada en dos lugares (una en el server, otra en línea dentro de `index.html`), cualquier edición de un lado que no se replique al otro rompe silenciosamente el cruce, y el sistema volvería a producir coincidencias inconsistentes. El diseño anterior mitigaba esto con un test de sincronía que comparaba el **texto** de dos copias; funciona, pero sigue habiendo dos copias del código y el test solo detecta la divergencia *después* de que ocurre.

#### ¿Se puede mover la Base_Canciones (y el cruce) al backend para que `normalize` viva solo en el server?

Esta era la opción "preferida" a evaluar (single source of truth en el backend sin código en el navegador). Tras inspeccionar `index.html`, **no es viable dentro del alcance de este feature**, por dos hechos concretos del frontend:

- El frontend **no solo cruza**: `computeRecs()` recorre **las 82.080 filas completas** de la Base_Canciones en el navegador para puntuar cada canción candidata contra el vector de gusto `p`, y toda el álgebra lineal (construcción de `ST.M`, transpuesta `T`, producto `mm`, matriz de Gram `MᵀM`, Gauss-Jordan `gj`) se ejecuta en el cliente sobre las features `(e,t,v,ac,i)`.
- Por tanto el navegador necesita **la Base_Canciones entera con sus features presente localmente**, con independencia del matching. Mover la DB al server obligaría a: o bien (a) reenviar 82.080 filas por la red en cada análisis (varios MB, lento, anula el beneficio), o bien (b) portar todo el recomendador (matrices, Gram, Gauss-Jordan, scoring) al backend — una reescritura mayor y **fuera del alcance** de una feature de extracción de tracklist.

Un endpoint auxiliar que reciba una canción y devuelva su match tampoco resuelve nada: aunque `/analyze` devolviera filas ya emparejadas, el recomendador **seguiría** necesitando la DB completa en el cliente para `computeRecs`. Y añadir un segundo camino de matching (server) mientras el scoring sigue en el cliente introduce *más* superficie de divergencia, no menos.

Conclusión: dado que la Base_Canciones —y con ella el segundo punto de llamada a `normalize`— **es inevitablemente del navegador**, la máxima estabilidad no se logra sacando `normalize` del cliente, sino garantizando que cliente y servidor ejecuten **el mismo archivo físico**.

### Opción elegida (la más estable): un único `normalize.js` isomorfo servido por el server

`normalize.js` se escribe **una sola vez** en la raíz del proyecto y se consume desde ambos entornos sin copiarlo ni transformarlo:

```js
// normalize.js  — FUENTE ÚNICA DE VERDAD. Isomorfo: corre en Node y en el navegador.
(function (root) {
  'use strict';

  // Las 6 reglas se aplican en orden fijo (Requirement 10.2). a→b→c→d→f;
  // el corte de artista principal (regla e) lo aplica normalizeArtist.
  function normalize(str) {
    let s = (str || '');
    s = s.toLowerCase().trim();                                     // (a) minúsculas + trim
    s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');         // (b) sin acentos (NFD + strip combinantes)
    s = s.replace(/\s*-\s*(acoustic|remix|live|remastered).*$/, ''); // (c) sufijos de versión
    s = s.replace(/\([^)]*\)|\[[^\]]*\]/g, '')                      // (d) paréntesis/corchetes
         .replace(/\b(feat\.?|ft\.?)\b.*$/, '');                    // (d) feat./ft.
    s = s.replace(/\s+/g, ' ').trim();                              // (f) colapsar espacios
    return s;
  }

  function normalizeArtist(str) {
    // (e) artista principal: cortar en el primer ; , & o "feat" sobre el string crudo,
    // luego normalizar el fragmento con las reglas a→b→c→d→f.
    const primary = (str || '').split(/[;,&]|\bfeat\b/i)[0];
    return normalize(primary);
  }

  const api = { normalize, normalizeArtist };

  // Doble exportación sin duplicar lógica:
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;            // Node:  const { normalize } = require('./normalize')
  } else {
    root.SM_NORMALIZE = api;         // Navegador: window.SM_NORMALIZE.normalize(...)
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
```

Notas de orden: el corte del artista (regla e) se hace sobre el string crudo para respetar separadores con acentos/mayúsculas; luego el fragmento pasa por `normalize`. El resto de reglas siguen el orden a→b→c→d→f del Requirement 10.2. Este archivo **no usa nada exclusivo de Node** (solo `String.prototype`/regex), por lo que corre sin cambios en el navegador.

### Cómo lo consume cada lado

- **Backend (`server.js` y `lib/extract.js`):** `const { normalize, normalizeArtist } = require('./normalize');` — el patrón UMD detecta `module.exports` y devuelve la API. Sin cambios de comportamiento respecto a un `require` normal.
- **Frontend (`index.html`):** una etiqueta `<script src="/normalize.js"></script>` **antes** del script principal. En el navegador el patrón detecta que no hay `module` y publica `globalThis.SM_NORMALIZE`. El script principal usa `const { normalize, normalizeArtist } = window.SM_NORMALIZE;`. `index.html` **no define** `normalize` en ninguna parte.
- **El server sirve el archivo:** se añade una ruta `GET /normalize.js` que responde el contenido de `normalize.js` con `Content-Type: application/javascript`. Como el frontend hoy hace `fetch` al mismo origen del server (`http://localhost:3000/analyze`), cargar `/normalize.js` desde ese mismo origen es directo y no requiere infraestructura extra. (Si en despliegue el HTML se sirviera desde otro origen, la ruta ya emite CORS `*` como el resto del server.)

### Por qué esta es la opción más estable

- **Cero duplicación de lógica:** un único archivo contiene las Reglas_Normalizacion. Es *imposible* editar "un lado y no el otro" porque solo hay un lado.
- **Consistencia garantizada por construcción, no por vigilancia:** ya no hace falta un test que compare textos de dos copias para *detectar* divergencias; simplemente no pueden existir. El mismo bytecode se ejecuta en Node y en el navegador.
- **Sigue respetando todos los constraints:** sin build, sin dependencias npm, solo Node 18+ nativo. La "doble exportación" es un patrón UMD trivial de ~4 líneas, no una herramienta.
- **El frontend conserva sus features:** la Base_Canciones y sus columnas `(e,t,v,ac,i)` permanecen intactas en `index.html`; solo cambia *cómo se calcula la clave de comparación*, no *qué datos* tiene el cliente. El álgebra lineal y `computeRecs` no se tocan.

**Alternativas descartadas:**
- *Mover la DB/el matching al backend:* inviable sin portar todo el recomendador (fuera de alcance) o reenviar la DB por red en cada análisis.
- *Dos copias + test de sincronía (diseño anterior):* mantiene duplicación real y solo detecta la divergencia a posteriori.
- *Paso de build que inyecte el archivo en el HTML:* viola "sin herramientas/dependencias" y complica el despliegue estático.

---

## Timeout de 10s con `fetch` nativo (Requirement 9)

Se usa `AbortController` + `setTimeout`. Un helper envuelve la promesa de extracción:

```js
async function withTimeout(promiseFactory, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await promiseFactory(controller.signal);   // el extractor pasa signal a fetch()
  } catch (err) {
    if (err.name === 'AbortError') return { ok:false, reason:'TIMEOUT' };
    return { ok:false, reason:'EXTRACTION_FAILED', detail: err.message };
  } finally {
    clearTimeout(timer);
  }
}
```

Cada extractor recibe `signal` y lo pasa a `fetch(url, { signal, headers })`. Al abortar, `fetch` rechaza con `AbortError`, que se mapea a `TIMEOUT`. El `finally` limpia el timer para no dejar handles colgados.

---

## Manejo de errores (Requirements 11, 12.5)

Mapa de casos → HTTP → mensaje. Todos los cuerpos de error usan la forma que el frontend lee (`data.error.message`).

| Caso | `reason` | HTTP | `error.message` (es) |
|------|----------|------|-----------------------|
| Body sin `link` / no-URL / sin esquema http(s) | `INVALID_LINK` | 400 | "El enlace de playlist es inválido o está ausente." |
| Dominio no soportado | `UNSUPPORTED_SOURCE` | 422 | "Fuente no soportada. Usa Spotify, Apple Music, YouTube Music, Deezer o Tidal." |
| id no extraíble de una fuente soportada | `INVALID_LINK` | 422 | "No se pudo identificar la playlist en el enlace." |
| Fuente caída / markup cambiado / parseo falla | `EXTRACTION_FAILED` | 502 | "No se pudieron extraer las canciones de la playlist." |
| Extracción supera 10s | `TIMEOUT` | 504 | "La extracción tardó demasiado. Intenta de nuevo." |
| Tracklist vacío | `EMPTY_PLAYLIST` | 422 | "La playlist no contiene canciones." |

Formato del cuerpo de error (compatible con `data.error?.message`):

```json
{ "error": { "code": "EXTRACTION_FAILED", "message": "No se pudieron extraer las canciones de la playlist." } }
```

En **ningún** caso (éxito o error) se invoca un LLM (Requirement 11.4): el código no contiene cliente ni referencia al gateway `localhost:9000`.

---

## Formato de respuesta exitosa (Requirement 12)

```js
function buildPayload(tracklist, service, playlistName) {
  return {
    songs: tracklist.map(t => ({
      name:   normalize(t.name),
      artist: normalizeArtist(t.artist),
    })),
    service,
    playlist_name: playlistName || 'Playlist',
  };
}

function wrapResponse(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}
```

Respuesta final (HTTP 200, `application/json`):

```json
{ "content": [ { "type": "text", "text": "{\"songs\":[{\"name\":\"...\",\"artist\":\"...\"}],\"service\":\"Spotify\",\"playlist_name\":\"...\"}" } ] }
```

El frontend hace `data.content.find(b=>b.type==='text').text`, quita fences (ya no vienen, pero el `.replace(/```json|```/g,'')` es inocuo) y `JSON.parse`. Contrato preservado.

---

## Cambios concretos en `server.js`

**Se elimina:**
- `const https = require('https')` (no se usa) y todo lo relacionado con Anthropic.
- Variables `API_KEY`, `MODEL` y la validación de `ANTHROPIC_API_KEY`.
- El `payload` JSON de Anthropic: `model`, `max_tokens`, `tool_choice:{type:'none'}`, `system`, `messages`.
- `options` apuntando a `hostname:'localhost', port:9000, path:'/v1/messages'` y los headers `Authorization`/`anthropic-version`.
- `http.request(options, ...)` hacia el gateway, `apiReq.write/end` y su `on('error')`.

**Se conserva:**
- Creación del servidor `http`, cabeceras CORS, preflight `OPTIONS`, health check `GET /`, `404` por defecto, `server.listen(PORT)`.
- Lectura del body por streaming (`req.on('data'|'end')`) y `JSON.parse(body).link`.

**Se agrega** una ruta que sirve el archivo único de normalización, para que `index.html` cargue la MISMA implementación que usa el server (ver §Módulo de normalización):

```js
const fs   = require('fs');
const path = require('path');

// GET /normalize.js  → sirve la fuente única de verdad al navegador
if (req.method === 'GET' && req.url === '/normalize.js') {
  fs.readFile(path.join(__dirname, 'normalize.js'), (err, buf) => {
    if (err) { res.writeHead(500); return res.end('// normalize.js no disponible'); }
    res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
    res.end(buf);
  });
  return;
}
```

> Nota: los headers CORS (`Access-Control-Allow-Origin: *`) ya se fijan al inicio del handler, así que `/normalize.js` es cargable también desde un origen distinto si en el futuro el HTML no se sirve desde el mismo host que la API.

**Se agrega** dentro del `req.on('end')` de `POST /analyze`:

```js
const { extractTracklist } = require('./lib/extract');   // orquesta dispatch+timeout+truncado+normalización
const { buildPayload, wrapResponse } = require('./lib/extract');
// extract.js normaliza con:  const { normalize, normalizeArtist } = require('../normalize');

(async () => {
  const result = await extractTracklist(playlistLink);   // {ok, tracklist, service, playlistName} | {ok:false, reason}
  if (!result.ok) {
    const { status, message, code } = mapError(result.reason);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: { code, message } }));
  }
  const payload  = buildPayload(result.tracklist, result.service, result.playlistName);
  const envelope = wrapResponse(payload);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(envelope));
})();
```

`mapError(reason)` implementa la tabla de la sección de errores. `extractTracklist` internamente: valida link → detecta fuente → extrae id → dispatch con timeout → verifica vacío → trunca a 50 → devuelve datos crudos (la normalización final la hace `buildPayload`).

---

## Cambios concretos en `index.html` (Requirement 13)

El cambio funcional es aplicar la **misma** normalización a ambos lados del cruce en `findDB`, **sin reimplementar** las reglas en el HTML. Hoy:

```js
function findDB(name,artist){
  const nL=name.toLowerCase().trim(), aL=(artist||'').toLowerCase().trim();
  const ei=IDX[nL];
  ...
```

`IDX` está construido con nombres solo en minúsculas/trim. La Base_Canciones (`DB`, 82.080 filas con `(e,t,v,ac,i)`) y todo el recomendador (`computeRecs`, matrices, Gram, Gauss-Jordan) **no se tocan**. Cambios:

1. **Cargar la fuente única de verdad servida por el backend**, antes del `<script>` principal. NO se copia ninguna función de normalización dentro de `index.html`:

```html
<!-- se sirve desde el mismo Servidor_SoundMatrix: expone window.SM_NORMALIZE -->
<script src="http://localhost:3000/normalize.js"></script>
<!-- en despliegue: src apuntando al host real de la API, p.ej. .../normalize.js -->
```

Y al inicio del script principal:

```js
const { normalize, normalizeArtist } = window.SM_NORMALIZE;   // MISMA implementación que el server
```

2. **Reconstruir el índice normalizado** una sola vez a partir del DB, aplicando `normalize` a la clave (Requirement 13.2). Las features `(e,t,v,ac,i)` no intervienen en la clave; siguen accesibles por índice de fila:

```js
const NIDX = {};                       // clave normalizada → índice de fila
for (let i=0;i<DB.length;i++){ const k=normalize(DB[i][0]); if(!(k in NIDX)) NIDX[k]=i; }
```

3. **Cruzar con ambos lados normalizados** (Requirement 13.1, 13.3):

```js
function findDB(name,artist){
  const nN = normalize(name);
  const aN = normalizeArtist(artist);
  // 1) match exacto por nombre normalizado
  let ei = NIDX[nN];
  if (ei!==undefined){ const r=DB[ei]; return {n:r[0],a:r[1],e:r[2],t:r[3],v:r[4],ac:r[5],i:r[6]}; }
  // 2) fallback por substring, normalizando también la clave del DB
  for (let i=0;i<DB.length;i++){
    const dN = normalize(DB[i][0]);
    const daN = normalizeArtist(DB[i][1]);
    if ((dN.includes(nN)||nN.includes(dN)) && (!aN || daN.includes(aN) || aN.includes(daN)))
      return {n:DB[i][0],a:DB[i][1],e:DB[i][2],t:DB[i][3],v:DB[i][4],ac:DB[i][5],i:DB[i][6]};
  }
  return null;
}
```

El `IDX` original puede conservarse o retirarse; `NIDX` lo reemplaza en el emparejamiento. `findDB` **sigue devolviendo la fila completa con sus features** `{n,a,e,t,v,ac,i}`, de modo que `useFoundSongs`, `startAnalysis` (que arma `ST.M` con `FKEYS`), el álgebra lineal y `computeRecs` funcionan igual que antes: la normalización solo afecta a la *clave de comparación*, nunca a los *datos* que el frontend usa para sus cálculos. `processLink` no cambia: sigue leyendo `data.content.find(...).text`, parseando y llamando `findDB(s.name, s.artist)`.

Como los nombres/artistas ya llegan normalizados desde el server (Requirement 10) y `findDB` vuelve a normalizarlos con la **misma** función servida, `normalize` es idempotente y aplicar la normalización dos veces no altera el resultado. El riesgo de divergencia queda eliminado por construcción: solo existe una implementación de las Reglas_Normalizacion (`/normalize.js`).

---

## Correctness Properties

*Una propiedad es una característica o comportamiento que debe cumplirse en todas las ejecuciones válidas del sistema; es un enunciado formal de lo que el sistema debe hacer, y sirve de puente entre la especificación legible y garantías verificables por máquina.*

### Property 1: Detección de fuente por dominio

*Para toda* URL con esquema http/https cuyo hostname pertenezca a una Fuente_Soportada, `detectSource(url)` devuelve exactamente esa fuente; y *para toda* URL cuyo hostname no pertenezca a ninguna Fuente_Soportada, devuelve `null`.

**Validates: Requirements 1.1, 1.2, 1.3, 11.2**

### Property 2: Rechazo de enlaces inválidos

*Para todo* valor de `link` que esté ausente o que no sea una URL con esquema `http` o `https`, el Servidor_SoundMatrix responde con estado ≠ 200 y `error.message` no vacío, sin realizar ninguna extracción.

**Validates: Requirements 1.4, 11.1, 11.5, 12.5**

### Property 3: Mapeo de pistas de Deezer

*Para todo* payload JSON con la forma de `api.deezer.com/playlist` cuyo `data` es un array, el tracklist resultante tiene la misma longitud que `data` y para cada índice `i`, `tracklist[i].name === data[i].title` y `tracklist[i].artist === data[i].artist.name` (antes de truncar y normalizar).

**Validates: Requirements 3.2**

### Property 4: Forma del resultado del extractor

*Para todo* extractor del registro y *para toda* entrada, su resultado es o bien `{ok:true, tracklist:[{name,artist}], playlistName}` (con `name` y `artist` string) o bien `{ok:false, reason}`; nunca una forma intermedia.

**Validates: Requirements 7.1, 7.2**

### Property 5: Truncado con preservación de orden

*Para todo* tracklist `t`, el tracklist truncado es exactamente `t.slice(0, 50)`; en consecuencia su longitud es `min(len(t), 50)` y sus elementos aparecen en el mismo orden y posiciones que en `t`.

**Validates: Requirements 8.1, 8.2**

### Property 6: Invariantes de normalización

*Para toda* cadena de entrada, la salida de `normalize` está en minúsculas, no contiene marcas de acento (categoría Unicode combinante), no contiene paréntesis ni corchetes, no contiene sufijos de versión conocidos (`- acoustic`, `- remix`, `- live`, `- remastered`) ni segmentos `feat.`/`ft.`, no contiene espacios dobles ni espacios en los extremos, y `normalize` es idempotente: `normalize(normalize(x)) === normalize(x)`.

**Validates: Requirements 10.1, 10.2, 14.3**

### Property 7: Artista principal

*Para toda* cadena de artista, `normalizeArtist` devuelve la normalización del primer segmento obtenido al cortar en el primer separador `;`, `,`, `&` o `feat`, y su salida no contiene ninguno de esos separadores de artista.

**Validates: Requirements 10.3**

### Property 8: Conservación de pistas en el payload

*Para todo* tracklist extraído no vacío, el `Payload_Frontend` construido tiene `songs` de la misma longitud que el tracklist ya truncado y, para cada índice `i`, `songs[i].name === normalize(tracklist[i].name)` y `songs[i].artist === normalizeArtist(tracklist[i].artist)`; el payload no contiene ninguna canción que no provenga de una pista del tracklist.

**Validates: Requirements 10.4, 10.5, 12.3**

### Property 9: Round-trip del envoltorio de respuesta

*Para todo* `Payload_Frontend`, el envoltorio construido cumple que `JSON.parse(envelope.content.find(b => b.type==='text').text)` es profundamente igual al payload original.

**Validates: Requirements 12.1, 12.2**

### Property 10: Playlist vacía produce error

*Para toda* extracción exitosa cuyo tracklist sea vacío, el Servidor_SoundMatrix responde con estado ≠ 200 y `error.message` no vacío (código `EMPTY_PLAYLIST`), sin construir un payload de canciones.

**Validates: Requirements 11.3, 11.5, 12.5**

### Property 11: Consistencia de normalización en el cruce

*Para todo* par `(name, artist)` presente en la Base_Canciones y *para toda* variación de esas cadenas que normalice al mismo valor (diferencias de mayúsculas, acentos, sufijos de versión, paréntesis o espacios), `findDB(variación_name, variación_artist)` localiza la misma fila de la Base_Canciones que `findDB(name, artist)`, porque las Reglas_Normalizacion se aplican de forma idéntica y en el mismo orden a la cadena extraída y a la clave proveniente de la Base_Canciones.

**Validates: Requirements 13.1, 13.2, 13.3**

### Property 12: Fuente única de la normalización (server = frontend)

*Para toda* cadena de entrada `s`, la función `normalize` (y `normalizeArtist`) que ejecuta el backend produce exactamente el mismo resultado que la función `normalize` que ejecuta el frontend, porque ambos entornos importan/cargan el **mismo archivo `normalize.js`**: el backend vía `require('./normalize')` y el navegador vía `<script src="/normalize.js">` (que el server responde con el contenido de ese mismo archivo). No existe ninguna segunda implementación cuyo resultado pueda diverger.

**Validates: Requirements 13.3, 14.3**

### Property 13: `findDB` preserva las features de la fila

*Para toda* canción que `findDB` encuentre en la Base_Canciones, el objeto devuelto contiene las cinco features `(e, t, v, ac, i)` con exactamente los valores de la fila correspondiente del DB; la normalización solo determina *qué* fila se selecciona, nunca modifica los valores de features que el frontend usa para el álgebra lineal.

**Validates: Requirements 13.1, 13.2**

---

## Estrategia de testing

Runner: `node --test` (nativo, sin dependencias). Property tests: generadores propios ligeros (funciones que producen entradas aleatorias) con **≥100 iteraciones** por propiedad; cada test etiqueta su propiedad de diseño.

### Property-based tests (lógica pura, sin red)

- **Normalización (Props 6, 7):** generar strings con acentos, mayúsculas, paréntesis/corchetes, sufijos y espacios múltiples; verificar invariantes de salida e idempotencia. Casos dirigidos: `"Ghost - Acoustic"` → `"ghost"`, `"Say Something (feat. X)"` → `"say something"`, `"Jason Mraz;Colbie Caillat"` → `"jason mraz"`.
- **Detección de fuente (Prop 1):** generar URLs por dominio + dominios aleatorios fuera del set.
- **Deezer mapping (Prop 3):** generar objetos `{data:[{title, artist:{name}}, ...], title}`.
- **Truncado (Prop 5):** listas de longitud 0..120.
- **Envoltorio (Prop 9):** generar payloads y round-trip.
- **Conservación (Prop 8)** y **cruce consistente (Prop 11):** generar variaciones que normalicen igual a filas del DB.
- **Preservación de features en `findDB` (Prop 13):** generar filas de DB con features aleatorias y variaciones del nombre; verificar que `findDB` devuelve las features intactas de la fila esperada.

### Tests basados en fixtures (parsers frágiles)

Guardar en `test/fixtures/` documentos **reales** por fuente:
- `spotify-embed.html` (el caso ya probado), `deezer-playlist.json`, `apple-playlist.html`, `ytmusic-playlist.html`, `tidal-playlist.html`.
- Y variantes degradadas (`*-empty.html`, `*-no-data.html`) para los caminos `EXTRACTION_FAILED` (edge cases 2.3, 3.3, 4.3, 5.3, 6.3).

El parseo se prueba puro: `extractor.parse(fixtureBody)` → tracklist esperado. Así los tests no tocan la red y son deterministas aunque las plataformas cambien.

### Tests de integración / mocks

- **Timeout (Req 9):** inyectar un `fetch` que nunca resuelve + timers falsos; verificar `TIMEOUT`.
- **Fuente caída:** `fetch` que rechaza o responde 5xx; verificar `EXTRACTION_FAILED`.
- **Sin LLM (Req 11.4):** espiar `fetch`/`http.request`; afirmar que ninguna llamada apunta a `localhost:9000` ni a `api.anthropic.com`, en flujos de éxito y de error.
- **Contrato de respuesta (Req 12.4):** flujo de éxito con fixture → status 200 y envoltorio parseable.

### Smoke / configuración

- `package.json` sin dependencias de runtime (Req 14).
- `REGISTRY` tiene exactamente 5 extractores con las 5 fuentes (Req 7.3).
- **Fuente única de `normalize` (Prop 12):** en vez de un test de sincronía entre dos copias (ya no existen), se verifica que (a) `index.html` **no** define `function normalize`/`function normalizeArtist` propias y sí incluye `<script src=".../normalize.js">`, y (b) `GET /normalize.js` responde con `Content-Type` de JavaScript el contenido byte-a-byte de `normalize.js`. Adicionalmente, un test carga `normalize.js` como texto, lo evalúa en un contexto tipo-navegador (sin `module`) y confirma que `SM_NORMALIZE.normalize(s)` es igual a `require('../normalize').normalize(s)` para un lote de entradas generadas — demostrando que server y frontend ejecutan la misma implementación.

---

## Consideraciones

- **Fragilidad del scraping.** Spotify (probado) y Deezer (JSON público) son fiables; Apple, YouTube Music y Tidal dependen de markup que puede cambiar. Cuando un parser deja de encajar, cae en `EXTRACTION_FAILED` → error explícito al usuario, nunca datos inventados (alineado con Req 11 y con el objetivo de la feature). Los fixtures guardados permiten detectar rápido un cambio de markup al re-capturarlos.
- **Header `User-Agent`.** Obligatorio en todas las peticiones (confirmado con Spotify): sin un UA de navegador, varias fuentes bloquean o devuelven HTML distinto. Se define un UA común reutilizable.
- **Rate limiting.** Deezer y las páginas embed pueden limitar por IP. Mitigaciones: una sola petición por análisis, timeout de 10s, y respuesta de error clara si la fuente responde 429 (tratado como `EXTRACTION_FAILED`). No se implementa reintento agresivo para no empeorar el rate limit.
- **Región / idioma.** YouTube Music y Apple pueden variar el markup por región; enviar `Accept-Language: en-US` reduce variación.
- **Codificación.** Los nombres pueden traer caracteres no-ASCII; `normalize` (NFD + strip de acentos) los estandariza. El DB embebido ya contiene entradas con mojibake, pero eso no afecta al server; el cruce normalizado maximiza coincidencias del lado limpio.
- **Fuente única de `normalize`.** La normalización vive en un solo archivo `normalize.js` (isomorfo Node/navegador) que el server consume con `require` y sirve en `GET /normalize.js` para que el HTML lo cargue con `<script src>`. Se elimina la duplicación de la función en el frontend y, con ella, el riesgo de divergencia entre las Reglas_Normalizacion del server y las del cruce en `findDB`. La Base_Canciones y sus features `(e,t,v,ac,i)` permanecen en el navegador porque el recomendador (`computeRecs`, matrices, Gram, Gauss-Jordan) las necesita localmente; mover la DB al backend quedaba fuera del alcance de esta feature y habría exigido portar todo el recomendador o reenviar la DB por red.
