// lib/extractors/tidal.js
// Extractor_Tidal — Requirements 6.1, 6.2, 6.3, 7.1
//
// LA FUENTE MÁS FRÁGIL/INCIERTA: Tidal cambia su markup con frecuencia y a
// veces requiere región o ejecución de JS para poblar el tracklist. No expone
// un JSON público estable como Deezer, por lo que este extractor raspa el HTML
// (o su recurso embed) de la playlist. Se implementa de forma DEFENSIVA
// (try/catch en todos los caminos + validaciones) con una ruta de fallo bien
// definida (EXTRACTION_FAILED) para NUNCA devolver datos inventados.

'use strict';

/**
 * @typedef {{ name: string, artist: string }} Track
 * @typedef {{ ok: true,  tracklist: Track[], playlistName: string|null }} ExtractOk
 * @typedef {{ ok: false, reason: 'EXTRACTION_FAILED', detail?: string }} ExtractFail
 * @typedef {ExtractOk | ExtractFail} ExtractResult
 */

const source = 'Tidal';

// User-Agent de navegador: sin él Tidal puede devolver markup distinto,
// exigir región o bloquear la petición.
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

/**
 * Extrae el id de playlist de la URL de Tidal.
 * Regex sobre url.pathname: /playlist\/([a-f0-9-]+)/
 * @param {URL} url
 * @returns {string|null}
 */
function idFrom(url) {
  const m = url.pathname.match(/playlist\/([a-f0-9-]+)/);
  return m ? m[1] : null;
}

/**
 * Descarga el tracklist de la playlist de Tidal y delega en parse().
 *
 * La página normal (tidal.com/playlist/{id}) es una SPA: el HTML de servidor
 * solo trae metadatos (título, numTracks) pero NO el tracklist (se carga por
 * JS con token). En cambio el reproductor embed público
 * `https://embed.tidal.com/playlists/{id}` sí renderiza las pistas en el HTML
 * (<span slot="title"> / <span slot="artist">), sin token ni login. Se usa
 * ese embed como fuente.
 *
 * Requirement 6.1: GET con User-Agent de navegador. Pasa signal a fetchFn.
 * Re-lanza AbortError para que withTimeout lo mapee a TIMEOUT.
 * @param {URL} url
 * @param {typeof fetch} fetchFn
 * @param {AbortSignal} [signal]
 * @returns {Promise<ExtractResult>}
 */
async function extract(url, fetchFn, signal) {
  const id = idFrom(url);
  if (!id) return { ok: false, reason: 'EXTRACTION_FAILED' };

  const embedUrl = `https://embed.tidal.com/playlists/${id}`;

  let res;
  try {
    res = await fetchFn(embedUrl, {
      signal,
      headers: {
        'User-Agent': BROWSER_UA,
        'Accept-Language': 'en-US',
      },
    });
  } catch (err) {
    // AbortError se propaga arriba para que withTimeout lo mapee a TIMEOUT;
    // cualquier otro fallo de red es una extracción fallida.
    if (err && err.name === 'AbortError') throw err;
    return { ok: false, reason: 'EXTRACTION_FAILED', detail: err && err.message };
  }

  if (!res || !res.ok) {
    return { ok: false, reason: 'EXTRACTION_FAILED', detail: res && `HTTP ${res.status}` };
  }

  let body;
  try {
    body = await res.text();
  } catch (err) {
    if (err && err.name === 'AbortError') throw err;
    return { ok: false, reason: 'EXTRACTION_FAILED', detail: err && err.message };
  }

  return parse(body);
}

/**
 * Parseo puro y defensivo del documento de Tidal.
 *
 * Estrategias, en orden; se toma la PRIMERA que produzca una lista NO vacía:
 *   (1) <script type="application/ld+json"> (schema.org): objeto con
 *       track / itemListElement cuyos items tienen name y byArtist.name
 *       (o byArtist como string).
 *   (2) Estado embebido __NEXT_DATA__ o __INITIAL_STATE__ (JSON), del que se
 *       recorre recursivamente la estructura buscando items con título y
 *       artista.
 *
 * Requirement 6.3: si ninguna estrategia halla metadatos de pistas →
 * EXTRACTION_FAILED.
 *
 * @param {string} body
 * @returns {ExtractResult}
 */
function parse(body) {
  if (typeof body !== 'string' || body.length === 0) {
    return { ok: false, reason: 'EXTRACTION_FAILED' };
  }

  // Estrategia 1 (preferida): HTML del reproductor embed de Tidal, que renderiza
  // cada pista como <span slot="title">...</span> y
  // <span slot="artist"><a>...</a></span>.
  try {
    const r = parseEmbedHtml(body);
    if (r && r.tracklist.length > 0) {
      return { ok: true, tracklist: r.tracklist, playlistName: r.playlistName };
    }
  } catch (_) {
    // Estrategia frágil: si lanza, se intenta la siguiente.
  }

  // Estrategia 2: schema.org ld+json (trae name/track cuando está disponible).
  try {
    const r = parseLdJson(body);
    if (r && r.tracklist.length > 0) {
      return { ok: true, tracklist: r.tracklist, playlistName: r.playlistName };
    }
  } catch (_) {
    // Ídem.
  }

  // Estrategia 3: estado embebido __NEXT_DATA__ / __INITIAL_STATE__.
  try {
    const r = parseEmbeddedState(body);
    if (r && r.tracklist.length > 0) {
      return { ok: true, tracklist: r.tracklist, playlistName: r.playlistName };
    }
  } catch (_) {
    // Ídem.
  }

  return { ok: false, reason: 'EXTRACTION_FAILED' };
}

// ---------------------------------------------------------------------------
// Estrategia 1: HTML del reproductor embed (embed.tidal.com)
// ---------------------------------------------------------------------------

/**
 * Parsea el HTML del reproductor embed de Tidal. Cada pista se renderiza como:
 *   <span slot="title">TÍTULO</span>
 *   <span slot="artist"><a ...>ARTISTA</a>[<a ...>OTRO</a>...]</span>
 * Se emparejan por posición: el i-ésimo título con el i-ésimo bloque de artista,
 * tomando el primer <a> como artista principal.
 *
 * @param {string} body
 * @returns {{ tracklist: Track[], playlistName: string|null }|null}
 */
function parseEmbedHtml(body) {
  const titles = [];
  const titleRe = /<span\s+slot="title">([\s\S]*?)<\/span>/g;
  let m;
  while ((m = titleRe.exec(body)) !== null) {
    titles.push(decodeEntities(stripTags(m[1]).trim()));
  }
  if (titles.length === 0) return null;

  const artists = [];
  const artistRe = /<span\s+slot="artist">([\s\S]*?)<\/span>/g;
  while ((m = artistRe.exec(body)) !== null) {
    const inner = m[1];
    const am = inner.match(/<a[^>]*>([\s\S]*?)<\/a>/);
    const raw = am ? am[1] : inner;
    artists.push(decodeEntities(stripTags(raw).trim()));
  }

  const n = Math.min(titles.length, artists.length);
  if (n === 0) return null;

  const tracklist = [];
  for (let i = 0; i < n; i++) {
    if (titles[i]) tracklist.push({ name: titles[i], artist: artists[i] || '' });
  }
  if (tracklist.length === 0) return null;

  return { tracklist, playlistName: null };
}

/** Quita etiquetas HTML de un fragmento. */
function stripTags(s) {
  return String(s).replace(/<[^>]+>/g, '');
}

/** Decodifica las entidades HTML más comunes. */
function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&apos;/g, "'");
}

// ---------------------------------------------------------------------------
// Estrategia 1: <script type="application/ld+json"> (schema.org)
// ---------------------------------------------------------------------------

/**
 * Recorre todos los bloques ld+json del HTML y devuelve el primer conjunto de
 * pistas hallado. Cada bloque puede ser un objeto o un array de objetos.
 * @param {string} body
 * @returns {{ tracklist: Track[], playlistName: string|null }|null}
 */
function parseLdJson(body) {
  const re =
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = re.exec(body)) !== null) {
    const raw = (match[1] || '').trim();
    if (!raw) continue;
    let json;
    try {
      json = JSON.parse(raw);
    } catch (_) {
      continue; // bloque no parseable, probar el siguiente
    }
    const candidates = Array.isArray(json) ? json : [json];
    for (const node of candidates) {
      const r = tracksFromSchemaNode(node);
      if (r && r.tracklist.length > 0) return r;
    }
  }
  return null;
}

/**
 * Extrae pistas de un nodo schema.org. Busca listas en `track` o
 * `itemListElement` (posiblemente anidadas en `mainEntity`/`@graph`).
 * @param {any} node
 * @returns {{ tracklist: Track[], playlistName: string|null }|null}
 */
function tracksFromSchemaNode(node) {
  if (!node || typeof node !== 'object') return null;

  const playlistName =
    typeof node.name === 'string' && node.name.trim() ? node.name.trim() : null;

  // Posibles ubicaciones de la lista de pistas.
  const lists = [];
  if (Array.isArray(node.track)) lists.push(node.track);
  if (Array.isArray(node.itemListElement)) lists.push(node.itemListElement);
  if (node.mainEntity) {
    const inner = tracksFromSchemaNode(node.mainEntity);
    if (inner && inner.tracklist.length > 0) {
      return { tracklist: inner.tracklist, playlistName: playlistName || inner.playlistName };
    }
  }
  if (Array.isArray(node['@graph'])) {
    for (const g of node['@graph']) {
      const inner = tracksFromSchemaNode(g);
      if (inner && inner.tracklist.length > 0) {
        return { tracklist: inner.tracklist, playlistName: playlistName || inner.playlistName };
      }
    }
  }

  for (const list of lists) {
    const tracklist = [];
    for (const el of list) {
      // itemListElement suele envolver la pista en `item`.
      const item = el && typeof el === 'object' && el.item ? el.item : el;
      const track = trackFromSchemaItem(item);
      if (track) tracklist.push(track);
    }
    if (tracklist.length > 0) return { tracklist, playlistName };
  }

  return null;
}

/**
 * Convierte un item schema.org (MusicRecording) en un Track validado.
 * name → nombre de canción; artista desde byArtist.name o byArtist string.
 * @param {any} item
 * @returns {Track|null}
 */
function trackFromSchemaItem(item) {
  if (!item || typeof item !== 'object') return null;

  const name = typeof item.name === 'string' ? item.name.trim() : '';
  if (!name) return null;

  const artist = artistFromByArtist(item.byArtist);
  return { name, artist };
}

/**
 * Resuelve el nombre de artista desde el campo byArtist, que puede ser:
 *   - un string ("Artist Name")
 *   - un objeto { name: "Artist Name" }
 *   - un array de cualquiera de los anteriores (se toma el primero válido)
 * @param {any} byArtist
 * @returns {string}
 */
function artistFromByArtist(byArtist) {
  if (!byArtist) return '';
  if (typeof byArtist === 'string') return byArtist.trim();
  if (Array.isArray(byArtist)) {
    for (const a of byArtist) {
      const name = artistFromByArtist(a);
      if (name) return name;
    }
    return '';
  }
  if (typeof byArtist === 'object' && typeof byArtist.name === 'string') {
    return byArtist.name.trim();
  }
  return '';
}

// ---------------------------------------------------------------------------
// Estrategia 2: estado embebido __NEXT_DATA__ / __INITIAL_STATE__
// ---------------------------------------------------------------------------

/**
 * Localiza el primer bloque de estado embebido (__NEXT_DATA__ como
 * <script id="__NEXT_DATA__" type="application/json">, o una asignación
 * `window.__INITIAL_STATE__ = {...};`), parsea su JSON y recorre la estructura
 * recursivamente buscando items con forma de pista.
 * @param {string} body
 * @returns {{ tracklist: Track[], playlistName: string|null }|null}
 */
function parseEmbeddedState(body) {
  const candidates = extractStateObjects(body);
  for (const json of candidates) {
    const tracklist = [];
    collectTracks(json, tracklist);
    if (tracklist.length > 0) {
      const playlistName = findPlaylistName(json);
      return { tracklist, playlistName };
    }
  }
  return null;
}

/**
 * Devuelve los objetos JSON candidatos de los bloques de estado embebido.
 * Soporta:
 *   - <script id="__NEXT_DATA__" type="application/json">{...}</script>
 *   - window.__INITIAL_STATE__ = {...};  /  __INITIAL_STATE__ = {...}
 *   - window.__NEXT_DATA__ = {...};
 * @param {string} body
 * @returns {any[]}
 */
function extractStateObjects(body) {
  const out = [];

  // __NEXT_DATA__ como script JSON (forma habitual en apps Next.js).
  const nextScriptRe =
    /<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i;
  const nextMatch = body.match(nextScriptRe);
  if (nextMatch) {
    const raw = (nextMatch[1] || '').trim();
    if (raw) {
      try {
        out.push(JSON.parse(raw));
      } catch (_) {
        // Ignorar bloque no parseable.
      }
    }
  }

  // Asignaciones JS: __INITIAL_STATE__ / __NEXT_DATA__ = {...}.
  const assignAnchors = [
    /__INITIAL_STATE__\s*=\s*\{/,
    /__NEXT_DATA__\s*=\s*\{/,
  ];
  for (const anchor of assignAnchors) {
    const m = body.match(anchor);
    if (!m) continue;
    const braceStart = body.indexOf('{', m.index);
    if (braceStart === -1) continue;
    const jsonStr = sliceBalancedObject(body, braceStart);
    if (!jsonStr) continue;
    try {
      out.push(JSON.parse(jsonStr));
    } catch (_) {
      // Ignorar y seguir con el siguiente anchor.
    }
  }

  return out;
}

/**
 * Devuelve el substring del objeto JSON balanceado que empieza en `start`
 * (que debe apuntar a un '{'), respetando strings y escapes. Null si no cierra.
 * @param {string} s
 * @param {number} start
 * @returns {string|null}
 */
function sliceBalancedObject(s, start) {
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inStr = false;
      }
      continue;
    }
    if (ch === '"') {
      inStr = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return s.slice(start, i + 1);
      }
    }
  }
  return null;
}

/**
 * Recorrido recursivo que colecta objetos con forma de pista. Un objeto se
 * considera pista si tiene un título de canción y un nombre de artista en
 * alguno de los campos habituales de Tidal.
 * @param {any} node
 * @param {Track[]} out
 */
function collectTracks(node, out) {
  if (!node || typeof node !== 'object') return;

  if (Array.isArray(node)) {
    for (const el of node) collectTracks(el, out);
    return;
  }

  const track = trackFromStateItem(node);
  if (track) {
    // Este nodo ES una pista; sus hijos son metadatos, no más pistas.
    // No se desciende para evitar dobles conteos.
    out.push(track);
    return;
  }

  for (const key of Object.keys(node)) {
    collectTracks(node[key], out);
  }
}

/**
 * Intenta interpretar un objeto del estado embebido como pista. Tidal expone
 * el título en `title` y el artista en `artist.name`, `artists[].name` o
 * `artistName`. Solo se acepta si hay título Y artista, para no confundir
 * álbumes o metadatos arbitrarios con canciones.
 * @param {any} node
 * @returns {Track|null}
 */
function trackFromStateItem(node) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return null;

  const name =
    pickString(node.title) ||
    pickString(node.name) ||
    pickString(node.trackTitle);
  if (!name) return null;

  const artist = artistFromStateItem(node);
  if (!artist) return null;

  return { name, artist };
}

/**
 * Resuelve el artista de un item de estado de Tidal desde los campos habituales:
 *   - artist.name (objeto)
 *   - artists[].name (array; se toma el primero válido)
 *   - artist (string)  /  artistName (string)
 * @param {any} node
 * @returns {string}
 */
function artistFromStateItem(node) {
  if (node.artist) {
    if (typeof node.artist === 'string') {
      const s = node.artist.trim();
      if (s) return s;
    } else if (typeof node.artist === 'object' && typeof node.artist.name === 'string') {
      const s = node.artist.name.trim();
      if (s) return s;
    }
  }

  if (Array.isArray(node.artists)) {
    for (const a of node.artists) {
      if (a && typeof a === 'object' && typeof a.name === 'string' && a.name.trim()) {
        return a.name.trim();
      }
      if (typeof a === 'string' && a.trim()) return a.trim();
    }
  }

  return pickString(node.artistName);
}

/**
 * Busca de forma recursiva el nombre de la playlist en el estado embebido.
 * Un nodo se considera playlist si su `type`/`kind` menciona "playlist" y
 * tiene un `title`/`name` legible.
 * @param {any} node
 * @returns {string|null}
 */
function findPlaylistName(node) {
  if (!node || typeof node !== 'object') return null;

  if (Array.isArray(node)) {
    for (const el of node) {
      const found = findPlaylistName(el);
      if (found) return found;
    }
    return null;
  }

  const kind = pickString(node.type) || pickString(node.kind);
  if (kind && /playlist/i.test(kind)) {
    const name = pickString(node.title) || pickString(node.name);
    if (name) return name;
  }

  for (const key of Object.keys(node)) {
    const found = findPlaylistName(node[key]);
    if (found) return found;
  }
  return null;
}

/**
 * Devuelve el string recortado si `v` es un string no vacío, si no ''.
 * @param {any} v
 * @returns {string}
 */
function pickString(v) {
  return typeof v === 'string' && v.trim() ? v.trim() : '';
}

module.exports = { source, idFrom, extract, parse };
