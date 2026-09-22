// lib/extractors/deezer.js
// Extractor_Deezer — Requirement 3, 7.1
//
// Consume el endpoint público JSON de Deezer (sin auth). Es la fuente más
// fiable porque parsea un JSON estable en lugar de scraping de markup.

'use strict';

/**
 * @typedef {{ name: string, artist: string }} Track
 * @typedef {{ ok: true,  tracklist: Track[], playlistName: string|null }} ExtractOk
 * @typedef {{ ok: false, reason: 'EXTRACTION_FAILED', detail?: string }} ExtractFail
 * @typedef {ExtractOk | ExtractFail} ExtractResult
 */

const source = 'Deezer';

// User-Agent de navegador para peticiones HTTP salientes.
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * Extrae el id de playlist de la URL de Deezer.
 * Regex sobre url.pathname: /playlist\/(\d+)/
 * @param {URL} url
 * @returns {string|null}
 */
function idFrom(url) {
  const m = url.pathname.match(/playlist\/(\d+)/);
  return m ? m[1] : null;
}

/**
 * Solicita el recurso público `https://api.deezer.com/playlist/{id}` (Req 3.1),
 * lee el body como texto y delega el parseo puro en `parse`.
 * @param {URL} url
 * @param {typeof fetch} fetchFn
 * @param {AbortSignal} [signal]
 * @returns {Promise<ExtractResult>}
 */
async function extract(url, fetchFn, signal) {
  const id = idFrom(url);
  if (!id) return { ok: false, reason: 'EXTRACTION_FAILED' };

  try {
    const res = await fetchFn(`https://api.deezer.com/playlist/${id}`, {
      signal,
      headers: { 'User-Agent': USER_AGENT },
    });
    if (!res.ok) return { ok: false, reason: 'EXTRACTION_FAILED' };
    const body = await res.text();
    return parse(body);
  } catch (err) {
    return { ok: false, reason: 'EXTRACTION_FAILED', detail: err && err.message };
  }
}

/**
 * Parseo puro del JSON público de Deezer (Req 3.2, 3.3).
 * - JSON inválido → EXTRACTION_FAILED
 * - `j.error` presente (ids inexistentes) → EXTRACTION_FAILED
 * - `j.data` no es array → EXTRACTION_FAILED
 * - éxito → mapea data[] a {name: t.title, artist: t.artist?.name}
 * @param {string} body
 * @returns {ExtractResult}
 */
function parse(body) {
  let j;
  try {
    j = JSON.parse(body);
  } catch (_err) {
    return { ok: false, reason: 'EXTRACTION_FAILED' };
  }

  if (!j || j.error) {
    return { ok: false, reason: 'EXTRACTION_FAILED' };
  }

  // La API pública de playlist de Deezer anida las pistas en `tracks.data`.
  // Algunos endpoints (o respuestas paginadas de /tracks) las devuelven
  // directamente en `data`. Se soportan ambas formas.
  const rows =
    (j.tracks && Array.isArray(j.tracks.data) && j.tracks.data) ||
    (Array.isArray(j.data) && j.data) ||
    null;

  if (!rows) {
    return { ok: false, reason: 'EXTRACTION_FAILED' };
  }

  const tracklist = rows.map((t) => ({
    name: t.title,
    artist: t.artist && t.artist.name,
  }));
  const playlistName = j.title || null;

  return { ok: true, tracklist, playlistName };
}

module.exports = { source, idFrom, extract, parse };
