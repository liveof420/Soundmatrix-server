// lib/extract.js
// Orquestador del Servicio_Extraccion: dispatch + timeout + truncado + ensamblaje.
// Requirements: 8.1, 8.2, 9.1, 9.2, 10.4, 10.5, 12.1, 12.2, 12.3
//
// No depende del HTTP: recibe un link (string) y devuelve un resultado crudo,
// de modo que las pruebas pueden invocarlo directamente con fetch mockeado.
//
// - withTimeout(promiseFactory, ms): AbortController + setTimeout; mapea
//   AbortError → TIMEOUT y otros errores → EXTRACTION_FAILED; clearTimeout en finally.
// - extractTracklist(link): valida link → detectSource → idFrom → dispatch con
//   timeout de 10s → verifica vacío (EMPTY_PLAYLIST) → trunca a 50 preservando orden.
// - buildPayload(tracklist, service, playlistName): normaliza y arma el Payload_Frontend.
// - wrapResponse(payload): produce el Envoltorio_Respuesta que el frontend consume.

'use strict';

const { detectSource, getExtractor } = require('./sources');
const { normalize, normalizeArtist } = require('../normalize');

/** Límite de canciones (Requirement 8.1). */
const SONG_LIMIT = 50;

/** Timeout de extracción en milisegundos (Requirement 9.1). */
const EXTRACTION_TIMEOUT_MS = 10_000;

/**
 * @typedef {{ name: string, artist: string }} Track
 * @typedef {{ ok: true, tracklist: Track[], service: string, playlistName: string|null }} ExtractTracklistOk
 * @typedef {{ ok: false, reason: string, detail?: string }} ExtractTracklistFail
 * @typedef {ExtractTracklistOk | ExtractTracklistFail} ExtractTracklistResult
 */

/**
 * Envuelve una promesa de extracción con un timeout basado en AbortController.
 * El promiseFactory recibe el `signal` para pasárselo a fetch(). Al superar `ms`,
 * el controller aborta, fetch rechaza con AbortError y se mapea a TIMEOUT.
 * Cualquier otro error se mapea a EXTRACTION_FAILED con su detalle.
 *
 * @param {(signal: AbortSignal) => Promise<any>} promiseFactory
 * @param {number} ms
 * @returns {Promise<any>}
 */
async function withTimeout(promiseFactory, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await promiseFactory(controller.signal); // el extractor pasa signal a fetch()
  } catch (err) {
    if (err && err.name === 'AbortError') {
      return { ok: false, reason: 'TIMEOUT' };
    }
    return { ok: false, reason: 'EXTRACTION_FAILED', detail: err && err.message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Orquesta la extracción del tracklist a partir de un link de playlist.
 * Flujo: validar link (esquema http/https) → detectar fuente → extraer id →
 * dispatch del extractor con timeout de 10s → verificar vacío → truncar a 50.
 * Devuelve los datos CRUDOS; la normalización final la hace buildPayload.
 *
 * @param {string} link
 * @returns {Promise<ExtractTracklistResult>}
 */
async function extractTracklist(link) {
  console.log(`[DEBUG] extractTracklist link: ${link}`);

  // 1. Validar link: debe ser una URL con esquema http o https (Requirement 1.4).
  let url;
  try {
    url = new URL(link);
  } catch (_) {
    console.log(`[ERROR] Link inválido (no es URL): ${link}`);
    return { ok: false, reason: 'INVALID_LINK' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    console.log(`[ERROR] Esquema no soportado: ${url.protocol}`);
    return { ok: false, reason: 'INVALID_LINK' };
  }

  // 2. Detectar fuente por dominio (Requirement 1.1, 1.3).
  const service = detectSource(url);
  if (!service) {
    console.log(`[ERROR] Fuente no soportada para dominio: ${url.hostname}`);
    return { ok: false, reason: 'UNSUPPORTED_SOURCE' };
  }
  console.log(`[DEBUG] Fuente detectada: ${service}`);

  // 3. Obtener extractor e id de la playlist (Requirement 1.2).
  const extractor = getExtractor(service);
  if (!extractor) {
    console.log(`[ERROR] Sin extractor registrado para: ${service}`);
    return { ok: false, reason: 'UNSUPPORTED_SOURCE' };
  }
  const id = extractor.idFrom(url);
  if (!id) {
    console.log(`[ERROR] No se pudo extraer el id de la playlist de: ${url.href}`);
    return { ok: false, reason: 'INVALID_LINK' };
  }
  console.log(`[DEBUG] Playlist id: ${id}`);

  // 4. Dispatch del extractor con timeout de 10s (Requirement 9.1, 9.2).
  console.log(`[DEBUG] Extrayendo tracklist de ${service}...`);
  const result = await withTimeout(
    (signal) => extractor.extract(url, fetch, signal),
    EXTRACTION_TIMEOUT_MS
  );

  // 5. Mapear fallos del extractor a su reason (Requirement 11.1).
  if (!result || !result.ok) {
    const reason = (result && result.reason) || 'EXTRACTION_FAILED';
    console.log(`[ERROR] Extracción fallida (${service}): ${reason}` +
      (result && result.detail ? ` — ${result.detail}` : ''));
    const out = { ok: false, reason };
    if (result && result.detail !== undefined) out.detail = result.detail;
    return out;
  }

  // 6. Verificar tracklist vacío (Requirement 11.3).
  const rawTracklist = Array.isArray(result.tracklist) ? result.tracklist : [];
  if (rawTracklist.length === 0) {
    console.log(`[ERROR] Playlist vacía (${service})`);
    return { ok: false, reason: 'EMPTY_PLAYLIST' };
  }

  // 7. Truncar a 50 preservando el orden original (Requirement 8.1, 8.2).
  const tracklist = rawTracklist.slice(0, SONG_LIMIT);

  // Log resumen de lo encontrado por el extractor (sin listar las canciones).
  const playlistName = result.playlistName != null ? result.playlistName : null;
  console.log(`[DEBUG] ${service} — playlist "${playlistName || '(sin nombre)'}" — ` +
    `${rawTracklist.length} canciones extraídas` +
    (rawTracklist.length > SONG_LIMIT ? ` (truncadas a ${SONG_LIMIT})` : ''));

  // Datos crudos; la normalización final la hace buildPayload.
  return {
    ok: true,
    tracklist,
    service,
    playlistName,
  };
}

/**
 * Construye el Payload_Frontend a partir del tracklist crudo, normalizando
 * cada nombre de canción con `normalize` y cada artista con `normalizeArtist`
 * (Requirement 10.4, 10.5). Solo usa las pistas del tracklist como fuente.
 *
 * @param {Track[]} tracklist
 * @param {string} service
 * @param {string|null} playlistName
 * @returns {{ songs: Array<{name: string, artist: string}>, service: string, playlist_name: string }}
 */
function buildPayload(tracklist, service, playlistName) {
  return {
    songs: tracklist.map((t) => ({
      name: normalize(t.name),
      artist: normalizeArtist(t.artist),
    })),
    service,
    playlist_name: playlistName || 'Playlist',
  };
}

/**
 * Envuelve el Payload_Frontend en el Envoltorio_Respuesta que el frontend
 * consume leyendo `data.content[].text` (Requirement 12.1, 12.2, 12.3).
 *
 * @param {object} payload
 * @returns {{ content: Array<{type: 'text', text: string}> }}
 */
function wrapResponse(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

module.exports = { extractTracklist, buildPayload, wrapResponse, withTimeout };
