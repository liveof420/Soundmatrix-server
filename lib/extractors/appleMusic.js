// lib/extractors/appleMusic.js
// Extractor_AppleMusic — Requirement 4, 7.1
//
// FRÁGIL: Apple Music no expone un JSON público estable como Deezer.
// El tracklist se raspa del HTML de la página de la playlist, por lo que
// este parser es sensible a cambios de markup de Apple. Se implementa de
// forma DEFENSIVA (try/catch + validaciones) y con una ruta de fallo bien
// definida (EXTRACTION_FAILED) para nunca devolver datos inventados.

'use strict';

/**
 * @typedef {{ name: string, artist: string }} Track
 * @typedef {{ ok: true,  tracklist: Track[], playlistName: string|null }} ExtractOk
 * @typedef {{ ok: false, reason: 'EXTRACTION_FAILED', detail?: string }} ExtractFail
 * @typedef {ExtractOk | ExtractFail} ExtractResult
 */

const source = 'Apple Music';

// User-Agent de navegador: sin él Apple puede devolver markup distinto o bloquear.
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

/**
 * Extrae el id de playlist de la URL de Apple Music.
 * Regex sobre url.pathname: /(pl\.[A-Za-z0-9-]+)/
 * @param {URL} url
 * @returns {string|null}
 */
function idFrom(url) {
  const m = url.pathname.match(/(pl\.[A-Za-z0-9-]+)/);
  return m ? m[1] : null;
}

/**
 * Descarga el HTML de la playlist de Apple Music y delega en parse().
 * @param {URL} url
 * @param {typeof fetch} fetchFn
 * @param {AbortSignal} [signal]
 * @returns {Promise<ExtractResult>}
 */
async function extract(url, fetchFn, signal) {
  let res;
  try {
    res = await fetchFn(url.toString(), {
      signal,
      headers: {
        'User-Agent': BROWSER_UA,
        'Accept-Language': 'en-US',
      },
    });
  } catch (err) {
    // Errores de red / abort se propagan como AbortError arriba (withTimeout),
    // pero cualquier fallo aquí es una extracción fallida.
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
 * Parseo puro y defensivo del HTML de Apple Music.
 *
 * Estrategias, en orden; se toma la PRIMERA que produzca una lista NO vacía:
 *   (1) <script type="application/ld+json"> (schema.org): objeto con
 *       track / itemListElement cuyos items tienen name y byArtist.name
 *       (o byArtist como string).
 *   (2) <script id="serialized-server-data" type="application/json">: se
 *       recorre recursivamente el JSON en busca de la lista de canciones.
 *
 * @param {string} body
 * @returns {ExtractResult}
 */
function parse(body) {
  if (typeof body !== 'string' || body.length === 0) {
    return { ok: false, reason: 'EXTRACTION_FAILED' };
  }

  // Estrategia 1 (preferida): serialized-server-data.
  // El ld+json de las playlists de Apple Music trae los nombres de canción pero
  // NO el artista (no incluye byArtist), lo que rompe el cruce contra la base.
  // serialized-server-data sí trae title + artistName por pista, así que se
  // intenta primero.
  try {
    const r = parseSerializedServerData(body);
    if (r && r.tracklist.length > 0) {
      return { ok: true, tracklist: r.tracklist, playlistName: r.playlistName };
    }
  } catch (_) {
    // Estrategia frágil: si lanza, se intenta la siguiente.
  }

  // Estrategia 2 (fallback): schema.org ld+json. Solo se acepta si al menos una
  // pista trae artista; de lo contrario, tracks sin artista arruinarían el
  // matching en el frontend, así que preferimos fallar explícitamente.
  try {
    const r = parseLdJson(body);
    if (r && r.tracklist.length > 0 && r.tracklist.some((t) => t.artist && t.artist.trim())) {
      return { ok: true, tracklist: r.tracklist, playlistName: r.playlistName };
    }
  } catch (_) {
    // Ídem.
  }

  return { ok: false, reason: 'EXTRACTION_FAILED' };
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
// Estrategia 2: <script id="serialized-server-data" type="application/json">
// ---------------------------------------------------------------------------

/**
 * Localiza el bloque serialized-server-data y recorre su JSON buscando la
 * primera lista de objetos que parezcan pistas (title/name + artistName).
 * @param {string} body
 * @returns {{ tracklist: Track[], playlistName: string|null }|null}
 */
function parseSerializedServerData(body) {
  const re =
    /<script[^>]*id=["']serialized-server-data["'][^>]*>([\s\S]*?)<\/script>/i;
  const match = body.match(re);
  if (!match) return null;

  const raw = (match[1] || '').trim();
  if (!raw) return null;

  let json;
  try {
    json = JSON.parse(raw);
  } catch (_) {
    return null;
  }

  const tracklist = [];
  collectTracks(json, tracklist);
  if (tracklist.length === 0) return null;

  // El nombre de la playlist es más fiable en el ld+json (MusicPlaylist.name)
  // que rastreándolo en el server-data (donde aparecen textos de UI como
  // "Previsualizar"). Se usa el ld+json como fuente preferente y el server-data
  // como respaldo.
  const playlistName = playlistNameFromLdJson(body) || findPlaylistName(json);
  return { tracklist, playlistName };
}

/**
 * Extrae el nombre de la playlist/álbum desde el primer bloque ld+json cuyo
 * @type sea MusicPlaylist o MusicAlbum. Devuelve null si no lo encuentra.
 * @param {string} body
 * @returns {string|null}
 */
function playlistNameFromLdJson(body) {
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
      continue;
    }
    const nodes = Array.isArray(json) ? json : [json];
    for (const n of nodes) {
      if (n && typeof n === 'object' &&
          (n['@type'] === 'MusicPlaylist' || n['@type'] === 'MusicAlbum') &&
          pickString(n.name)) {
        return pickString(n.name);
      }
    }
  }
  return null;
}

/**
 * Recorrido recursivo que colecta objetos con forma de pista. Un objeto se
 * considera pista si tiene un título de canción y un nombre de artista en
 * alguno de los campos habituales de Apple.
 * @param {any} node
 * @param {Track[]} out
 */
function collectTracks(node, out) {
  if (!node || typeof node !== 'object') return;

  if (Array.isArray(node)) {
    for (const el of node) collectTracks(el, out);
    return;
  }

  const track = trackFromServerItem(node);
  if (track) {
    // Este nodo ES una pista; sus hijos son metadatos (attributes, etc.),
    // no más pistas. No se desciende para evitar dobles conteos.
    out.push(track);
    return;
  }

  for (const key of Object.keys(node)) {
    collectTracks(node[key], out);
  }
}

/**
 * Intenta interpretar un objeto del server-data como pista. Apple suele anidar
 * los datos en `attributes` con `name`/`artistName`.
 * @param {any} node
 * @returns {Track|null}
 */
function trackFromServerItem(node) {
  // Apple entrega las pistas de playlist con el título/artista en el nivel del
  // objeto (title + artistName), y en otros contextos dentro de `attributes`.
  // Se soportan ambas formas.
  const attrs = node && typeof node.attributes === 'object' ? node.attributes : node;
  if (!attrs || typeof attrs !== 'object') return null;

  const name =
    pickString(attrs.title) ||
    pickString(attrs.name) ||
    pickString(attrs.songName);
  if (!name) return null;

  const artist =
    pickString(attrs.artistName) ||
    pickString(attrs.artist) ||
    (Array.isArray(attrs.artistNames) && pickString(attrs.artistNames[0])) ||
    '';

  // Solo aceptar como pista si hay artista: así se descartan álbumes, secciones
  // de recomendación y metadatos arbitrarios que casualmente tengan un título.
  if (!artist) return null;

  return { name, artist };
}

/**
 * Busca de forma recursiva el nombre de la playlist en el server-data.
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

  // Nodo con kind/type de playlist y un name en attributes o directo.
  const kind = pickString(node.kind) || pickString(node.type);
  if (kind && /playlist/i.test(kind)) {
    const attrs = node.attributes && typeof node.attributes === 'object' ? node.attributes : node;
    const name = pickString(attrs && attrs.name);
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
