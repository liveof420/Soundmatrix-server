# Plan de Implementación — Extracción de Tracklists de Playlist

## Overview

El plan construye el Servicio_Extraccion de abajo hacia arriba, empezando por la base compartida (`normalize.js`, la fuente única de verdad isomorfa) y su test, para eliminar el riesgo de divergencia desde el primer paso. Luego se levanta la detección de fuente y el registro (`lib/sources.js`), el orquestador con timeout y truncado (`lib/extract.js`), y los cinco extractores empezando por los fiables (Spotify, Deezer) antes que los frágiles (Apple, YouTube Music, Tidal). Finalmente se integra todo en `server.js` (eliminando el LLM y sirviendo `/normalize.js`), se conecta el frontend en `index.html`, y se cierra con la suite de tests (property-based + fixtures + mocks) que cubre las 13 Correctness Properties.

Lenguaje de implementación: **JavaScript (Node.js 18+, CommonJS)** — es el lenguaje del proyecto real, ya fijado en el diseño. Sin dependencias npm; runner de tests `node --test` nativo.

## Tasks

- [x] 1. Crear `normalize.js`: fuente única de verdad de la normalización
  - [x] 1.1 Implementar el módulo isomorfo `normalize.js` en la raíz del proyecto
    - Escribir el patrón UMD que exporta `{ normalize, normalizeArtist }` vía `module.exports` en Node y publica `globalThis.SM_NORMALIZE` en el navegador
    - Implementar `normalize(str)` aplicando las Reglas_Normalizacion en orden: (a) minúsculas + trim, (b) NFD + strip de marcas combinantes `[\u0300-\u036f]`, (c) sufijos de versión `- acoustic|- remix|- live|- remastered`, (d) paréntesis/corchetes y segmentos `feat.`/`ft.`, (f) colapso de espacios múltiples + trim final
    - Implementar `normalizeArtist(str)` cortando el string crudo en el primer separador `;`, `,`, `&` o `feat` (regla e) y normalizando el primer fragmento con `normalize`
    - Usar solo `String.prototype`/regex (nada exclusivo de Node) para que corra igual en navegador
    - _Requirements: 10.1, 10.2, 10.3, 14.3_

  - [x] 1.2 Escribir property tests de normalización en `test/normalize.test.js`
    - **Property 6: Invariantes de normalización** — generar (≥100 iter) strings con acentos, mayúsculas, paréntesis/corchetes, sufijos y espacios múltiples; verificar salida en minúsculas, sin acentos, sin paréntesis/corchetes, sin sufijos de versión, sin `feat.`/`ft.`, sin espacios dobles ni en extremos, e idempotencia `normalize(normalize(x)) === normalize(x)`. Casos dirigidos: `"Ghost - Acoustic"`→`"ghost"`, `"Say Something (feat. X)"`→`"say something"`
    - **Property 7: Artista principal** — generar (≥100 iter) artistas con separadores; verificar que `normalizeArtist` devuelve la normalización del primer segmento y su salida no contiene `;`, `,`, `&` ni `feat`. Caso dirigido: `"Jason Mraz;Colbie Caillat"`→`"jason mraz"`
    - **Validates: Requirements 10.1, 10.2, 10.3, 14.3**

- [x] 2. Implementar detección de fuente y registro de extractores en `lib/sources.js`
  - [x] 2.1 Implementar `detectSource(url)`, `extractPlaylistId`/`getExtractor` y el `REGISTRY`
    - Escribir `detectSource(url)` que mapea `url.hostname` a `'Spotify'`, `'Deezer'`, `'Apple Music'`, `'YouTube Music'`, `'Tidal'` o `null` (alineado con el detector del frontend)
    - Definir `REGISTRY` con exactamente las 5 fuentes → extractores (require de `./extractors/*`) y `getExtractor(source)`
    - Exponer la extracción de id por fuente vía el `idFrom(url)` de cada extractor (regex sobre `url.pathname` o `searchParams` para YouTube), coherente con la tabla de ids del diseño
    - _Requirements: 1.1, 1.2, 1.3, 7.2, 7.3_

  - [x] 2.2 Escribir property/smoke tests de fuentes en `test/sources.test.js`
    - **Property 1: Detección de fuente por dominio** — generar (≥100 iter) URLs válidas por dominio de cada Fuente_Soportada (devuelve la fuente exacta) y dominios aleatorios fuera del set (devuelve `null`)
    - Smoke: afirmar que `REGISTRY` tiene exactamente 5 extractores con las 5 fuentes esperadas
    - **Validates: Requirements 1.1, 1.2, 1.3, 11.2, 7.3**

- [x] 3. Implementar el orquestador `lib/extract.js` (dispatch + timeout + truncado + ensamblaje)
  - [x] 3.1 Implementar `withTimeout`, `extractTracklist`, `buildPayload` y `wrapResponse`
    - Escribir `withTimeout(promiseFactory, ms)` con `AbortController` + `setTimeout`, mapeando `AbortError`→`{ok:false, reason:'TIMEOUT'}` y otros errores→`{ok:false, reason:'EXTRACTION_FAILED'}`, con `clearTimeout` en `finally`
    - Escribir `extractTracklist(link)` que valide el link (esquema http/https) → `detectSource` → `idFrom` → dispatch del extractor con `withTimeout(…, 10_000)`, mapeando cada fallo a su `reason` (`INVALID_LINK`, `UNSUPPORTED_SOURCE`, `EXTRACTION_FAILED`, `TIMEOUT`), verificando tracklist vacío (`EMPTY_PLAYLIST`) y truncando a 50 con `slice(0, 50)` preservando orden
    - Escribir `buildPayload(tracklist, service, playlistName)` que aplique `normalize` al `name` y `normalizeArtist` al `artist` de cada pista (require de `../normalize`) y arme `{songs, service, playlist_name}`; y `wrapResponse(payload)` que produzca `{content:[{type:'text',text:JSON.stringify(payload)}]}`
    - _Requirements: 8.1, 8.2, 9.1, 9.2, 10.4, 10.5, 12.1, 12.2, 12.3_

  - [x] 3.2 Escribir property tests del orquestador en `test/extract.test.js`
    - **Property 5: Truncado con preservación de orden** — generar (≥100 iter) tracklists de longitud 0..120; verificar que el truncado es `t.slice(0,50)`, longitud `min(len,50)` y mismo orden/posiciones
    - **Property 8: Conservación de pistas en el payload** — generar (≥100 iter) tracklists no vacíos; verificar que `songs` tiene la misma longitud que el tracklist truncado, `songs[i].name === normalize(t[i].name)`, `songs[i].artist === normalizeArtist(t[i].artist)` y que no hay canciones ajenas al tracklist
    - **Property 9: Round-trip del envoltorio** — generar (≥100 iter) payloads; verificar que `JSON.parse(envelope.content.find(b=>b.type==='text').text)` es profundamente igual al payload
    - **Validates: Requirements 8.1, 8.2, 10.4, 10.5, 12.1, 12.2, 12.3**

- [x] 4. Checkpoint — Base compartida y orquestación
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Implementar los extractores fiables (Spotify y Deezer)
  - [x] 5.1 Implementar `lib/extractors/spotify.js`
    - Definir `source:'Spotify'`, `idFrom(url)` con regex `/playlist\/([A-Za-z0-9]+)/` sobre `url.pathname` (ignorando `?si=`)
    - `extract(url, fetchFn, signal)` que hace `GET https://open.spotify.com/embed/playlist/{id}` con header `User-Agent` de navegador y pasa `signal`, delegando a `parse`
    - `parse(body)` puro: localizar `<script id="__NEXT_DATA__">`, `JSON.parse`, navegar `props.pageProps.state.data.entity`, mapear `entity.trackList` → `{name:t.title, artist:t.subtitle}` y leer `playlistName`; si falta el script, `JSON.parse` lanza o `trackList` no es array → `{ok:false, reason:'EXTRACTION_FAILED'}`
    - _Requirements: 2.1, 2.2, 2.3, 7.1_

  - [x] 5.2 Implementar `lib/extractors/deezer.js`
    - Definir `source:'Deezer'`, `idFrom(url)` con regex `/playlist\/(\d+)/`
    - `extract(url, fetchFn, signal)` que hace `GET https://api.deezer.com/playlist/{id}` con `User-Agent` y `signal`, delegando a `parse`
    - `parse(body)` puro: `JSON.parse`, mapear `data[]` → `{name:t.title, artist:t.artist && t.artist.name}` y `playlistName = j.title`; si `data` no es array, el body no es JSON válido o existe `j.error` → `{ok:false, reason:'EXTRACTION_FAILED'}`
    - _Requirements: 3.1, 3.2, 3.3, 7.1_

  - [x] 5.3 Escribir tests de Spotify y Deezer con fixtures en `test/extractors/`
    - **Property 3: Mapeo de pistas de Deezer** — generar (≥100 iter) objetos `{data:[{title, artist:{name}}...], title}`; verificar longitud igual a `data` y mapeo `name===data[i].title`, `artist===data[i].artist.name`
    - **Property 4: Forma del resultado del extractor** (Spotify y Deezer) — verificar que toda salida es `{ok:true, tracklist:[{name,artist}], playlistName}` o `{ok:false, reason}`, nunca intermedia
    - Fixtures reales: `spotify-embed.html`, `deezer-playlist.json` → tracklist esperado; y variantes degradadas (`*-empty`, `*-no-data`) → `EXTRACTION_FAILED`
    - **Validates: Requirements 2.2, 2.3, 3.2, 3.3, 7.1, 7.2**

- [x] 6. Implementar los extractores frágiles (Apple Music, YouTube Music, Tidal)
  - [x] 6.1 Implementar `lib/extractors/appleMusic.js`
    - Definir `source:'Apple Music'`, `idFrom(url)` con regex `/(pl\.[A-Za-z0-9-]+)/`
    - `extract(url, fetchFn, signal)` que hace `GET` del HTML con `User-Agent` y `Accept-Language: en-US`, delegando a `parse`
    - `parse(body)` puro y defensivo (en orden): `<script type="application/ld+json">` (schema.org `track`/`itemListElement`, `name` + `byArtist.name`), alternativa `<script id="serialized-server-data">`; tomar la primera estrategia con lista no vacía; sin metadatos → `{ok:false, reason:'EXTRACTION_FAILED'}`
    - _Requirements: 4.1, 4.2, 4.3, 7.1_

  - [x] 6.2 Implementar `lib/extractors/youtubeMusic.js`
    - Definir `source:'YouTube Music'`, `idFrom(url)` leyendo `url.searchParams.get('list')`
    - `extract(url, fetchFn, signal)` que hace `GET` del HTML con `User-Agent` y `Accept-Language: en-US`, delegando a `parse`
    - `parse(body)` puro: localizar `ytInitialData = ({...});` (regex), `JSON.parse`, y usar un buscador recursivo que colecte items tipo `musicResponsiveListItemRenderer` leyendo `flexColumns → runs[].text` para título y artista; sin `ytInitialData` o sin items → `{ok:false, reason:'EXTRACTION_FAILED'}`
    - _Requirements: 5.1, 5.2, 5.3, 7.1_

  - [x] 6.3 Implementar `lib/extractors/tidal.js`
    - Definir `source:'Tidal'`, `idFrom(url)` con regex `/playlist\/([a-f0-9-]+)/`
    - `extract(url, fetchFn, signal)` que hace `GET` del HTML/embed con `User-Agent`, delegando a `parse`
    - `parse(body)` puro y defensivo: `<script type="application/ld+json">` (`track`/`itemListElement`), alternativa `__NEXT_DATA__`/`__INITIAL_STATE__` recorriendo items para título y artista; sin metadatos → `{ok:false, reason:'EXTRACTION_FAILED'}`
    - _Requirements: 6.1, 6.2, 6.3, 7.1_

  - [x] 6.4 Escribir tests con fixtures de Apple, YouTube Music y Tidal en `test/extractors/`
    - **Property 4: Forma del resultado del extractor** (Apple, YouTube Music, Tidal) — verificar que toda salida es `{ok:true, tracklist:[{name,artist}], playlistName}` o `{ok:false, reason}`
    - Fixtures reales: `apple-playlist.html`, `ytmusic-playlist.html`, `tidal-playlist.html` → tracklist esperado; variantes degradadas (`*-empty.html`, `*-no-data.html`) → `EXTRACTION_FAILED` (edge cases 4.3, 5.3, 6.3)
    - **Validates: Requirements 4.2, 4.3, 5.2, 5.3, 6.2, 6.3, 7.1**

- [x] 7. Checkpoint — Los cinco extractores
  - Ensure all tests pass, ask the user if questions arise.

- [x] 8. Integrar el servicio en `server.js` (eliminar LLM + orquestación + ruta /normalize.js)
  - [x] 8.1 Eliminar toda la lógica del LLM de `server.js`
    - Quitar `require('https')`, `API_KEY`, `MODEL` y la validación de `ANTHROPIC_API_KEY`
    - Quitar el `payload` de Anthropic (`model`, `max_tokens`, `tool_choice`, `system`, `messages`), las `options` a `localhost:9000`/headers `Authorization`/`anthropic-version`, y el `http.request` al gateway con su `write/end` y `on('error')`
    - Conservar creación del servidor, CORS, preflight `OPTIONS`, health check `GET /`, `404` por defecto, `server.listen(PORT)` y el streaming del body con `JSON.parse(body).link`
    - _Requirements: 11.4, 14.1, 14.2_

  - [x] 8.2 Agregar la orquestación de extracción y el mapeo de errores en `POST /analyze`
    - Dentro de `req.on('end')`: `require('./lib/extract')` y llamar `await extractTracklist(playlistLink)`
    - Implementar `mapError(reason)` con la tabla reason→HTTP→message: `INVALID_LINK` 400/422, `UNSUPPORTED_SOURCE` 422, `EXTRACTION_FAILED` 502, `TIMEOUT` 504, `EMPTY_PLAYLIST` 422; en error responder cuerpo `{error:{code,message}}`
    - En éxito: `buildPayload` → `wrapResponse` → responder HTTP 200 `application/json` con el envoltorio
    - _Requirements: 1.3, 1.4, 9.2, 11.1, 11.2, 11.3, 11.5, 12.1, 12.4, 12.5_

  - [x] 8.3 Agregar la ruta `GET /normalize.js` que sirve la fuente única de verdad
    - Añadir `require('fs')` y `require('path')`; ante `GET /normalize.js` leer `normalize.js` y responder con `Content-Type: application/javascript; charset=utf-8` (y CORS `*` ya presente); ante error de lectura responder 500
    - _Requirements: 13.3, 14.3_

  - [x] 8.4 Escribir tests de integración "sin LLM" y contrato en `test/server.test.js`
    - **Sin LLM (Req 11.4):** espiar `fetch`/`http.request` y afirmar que NINGUNA llamada apunta a `localhost:9000` ni a `api.anthropic.com`, en flujos de éxito y de error
    - **Property 2: Rechazo de enlaces inválidos** — para links ausentes o sin esquema http/https, estado ≠ 200 y `error.message` no vacío, sin extracción
    - **Property 10: Playlist vacía produce error** — extracción exitosa con tracklist vacío → estado ≠ 200, `error.message` no vacío (`EMPTY_PLAYLIST`), sin payload de canciones
    - Contrato de éxito (Req 12.4): flujo con fixture → status 200 y envoltorio parseable
    - **Validates: Requirements 11.1, 11.3, 11.4, 11.5, 12.4, 12.5**

- [x] 9. Conectar el frontend en `index.html` (cargar /normalize.js + cruce normalizado)
  - [x] 9.1 Cargar `/normalize.js` y usar `window.SM_NORMALIZE` sin reimplementar reglas
    - Añadir `<script src="http://localhost:3000/normalize.js"></script>` antes del script principal y, al inicio de este, `const { normalize, normalizeArtist } = window.SM_NORMALIZE;`
    - Eliminar cualquier definición propia de `normalize`/`normalizeArtist` dentro de `index.html`
    - _Requirements: 13.1, 13.3, 14.3_

  - [x] 9.2 Reconstruir el índice normalizado y actualizar `findDB`
    - Construir `NIDX` (clave `normalize(DB[i][0])` → índice de fila) una sola vez
    - Reescribir `findDB(name, artist)` para normalizar ambos lados (`normalize(name)`, `normalizeArtist(artist)` y las claves del DB en el fallback por substring) y seguir devolviendo la fila completa `{n,a,e,t,v,ac,i}`; no tocar `DB`, `computeRecs`, matrices ni `processLink`
    - _Requirements: 13.1, 13.2, 13.3_

  - [x] 9.3 Escribir tests de cruce y de fuente única en `test/frontend.test.js`
    - **Property 11: Consistencia de normalización en el cruce** — generar (≥100 iter) variaciones (mayúsculas, acentos, sufijos, paréntesis, espacios) que normalicen igual a filas del DB; verificar que `findDB(variación)` localiza la misma fila que `findDB(original)`
    - **Property 13: `findDB` preserva las features de la fila** — generar (≥100 iter) filas con features aleatorias `(e,t,v,ac,i)` y variaciones del nombre; verificar que `findDB` devuelve las features intactas de la fila esperada
    - **Property 12: Fuente única de la normalización** — afirmar que `index.html` NO define `function normalize`/`normalizeArtist` y sí incluye `<script src=".../normalize.js">`; cargar `normalize.js` como texto, evaluarlo en contexto tipo-navegador (sin `module`) y confirmar que `SM_NORMALIZE.normalize(s) === require('../normalize').normalize(s)` para un lote de entradas; verificar que `GET /normalize.js` devuelve byte-a-byte el contenido de `normalize.js` con `Content-Type` de JavaScript
    - **Validates: Requirements 13.1, 13.2, 13.3, 14.3**

- [x] 10. Verificar ausencia de dependencias de runtime
  - [x] 10.1 Añadir smoke test de `package.json` sin dependencias en `test/package.test.js`
    - Verificar que `package.json` no declara `dependencies` de runtime (Req 14) y que el script de test usa `node --test`
    - **Validates: Requirements 14.1, 14.2, 14.3**

- [x] 11. Checkpoint final — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Las tareas marcadas con `*` son opcionales (tests: property-based, fixtures, integración, smoke) y pueden omitirse para un MVP más rápido, aunque cubren las 13 Correctness Properties del diseño.
- Los cinco extractores (Spotify, Deezer, Apple Music, YouTube Music, Tidal) son tareas de implementación **no opcionales**: el usuario pidió las 5 fuentes. Solo sus tests son opcionales.
- Cada tarea referencia sub-requisitos específicos para trazabilidad; los checkpoints aseguran validación incremental.
- Los property tests usan generadores propios ligeros con ≥100 iteraciones y `node --test` nativo; los parsers frágiles se prueban con fixtures reales (parseo puro, sin red).
- Orden deliberado: primero `normalize.js` (base compartida) para eliminar la divergencia desde el inicio, luego detección/orquestación, luego extractores fiables antes que frágiles, y por último integración y suite completa.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "2.1"] },
    { "id": 2, "tasks": ["2.2", "3.1"] },
    { "id": 3, "tasks": ["3.2", "5.1", "5.2", "6.1", "6.2", "6.3"] },
    { "id": 4, "tasks": ["5.3", "6.4", "8.1"] },
    { "id": 5, "tasks": ["8.2", "8.3"] },
    { "id": 6, "tasks": ["8.4", "9.1"] },
    { "id": 7, "tasks": ["9.2"] },
    { "id": 8, "tasks": ["9.3", "10.1"] }
  ]
}
```
