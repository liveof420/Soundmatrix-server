// lib/extractors/spotify.js
// Extractor_Spotify — Requirements 2.1, 2.2, 2.3, 7.1
//
// Extrae el tracklist real de una playlist de Spotify desde su página embed
// parseando el bloque JSON __NEXT_DATA__. Método validado manualmente.

'use strict';

/**
 * @typedef {{ name: string, artist: string }} Track
 * @typedef {{ ok: true,  tracklist: Track[], playlistName: string|null }} ExtractOk
 * @typedef {{ ok: false, reason: 'EXTRACTION_FAILED', detail?: string }} ExtractFail
 * @typedef {ExtractOk | ExtractFail} ExtractResult
 */

const source = 'Spotify';

// User-Agent de navegador OBLIGATORIO: sin él Spotify devuelve markup distinto.
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * Extrae el id de playlist de la URL de Spotify.
 * Regex sobre url.pathname: /playlist\/([A-Za-z0-9]+)/
 * Ignora query params de tracking (?si=...).
 * @param {URL} url
 * @returns {string|null}
 */
function idFrom(url) {
  const m = url.pathname.match(/playlist\/([A-Za-z0-9]+)/);
  return m ? m[1] : null;
}

/**
 * Solicita el recurso embed de Spotify y delega el parseo en parse().
 * Requirement 2.1: GET https://open.spotify.com/embed/playlist/{id} con User-Agent.
 * @param {URL} url
 * @param {typeof fetch} fetchFn
 * @param {AbortSignal} [signal]
 * @returns {Promise<ExtractResult>}
 */
async function extract(url, fetchFn, signal) {
  const id = idFrom(url);
  if (!id) return { ok: false, reason: 'EXTRACTION_FAILED' };

  const embedUrl = `https://open.spotify.com/embed/playlist/${id}`;
  try {
    const res = await fetchFn(embedUrl, {
      signal,
      headers: { 'User-Agent': USER_AGENT },
    });
    if (!res || !res.ok) return { ok: false, reason: 'EXTRACTION_FAILED' };
    const body = await res.text();
    return parse(body);
  } catch (err) {
    return { ok: false, reason: 'EXTRACTION_FAILED', detail: err && err.message };
  }
}

/**
 * Parseo puro del HTML embed de Spotify.
 * Requirement 2.2: localizar <script id="__NEXT_DATA__" type="application/json">,
 * extraer el JSON, navegar props.pageProps.state.data.entity y mapear
 * entity.trackList → [{name: t.title, artist: t.subtitle}].
 * Requirement 2.3: script ausente, JSON inválido o trackList no-array → EXTRACTION_FAILED.
 * @param {string} body
 * @returns {ExtractResult}
 */
function parse(body) {
  try {
    const m = body.match(
      /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/
    );
    if (!m) return { ok: false, reason: 'EXTRACTION_FAILED' };

    const json = JSON.parse(m[1]);
    const entity = json.props.pageProps.state.data.entity;
    const tracks = entity.trackList;
    if (!Array.isArray(tracks)) return { ok: false, reason: 'EXTRACTION_FAILED' };

    const playlistName = entity.name || entity.title || null;
    const tracklist = tracks.map((t) => ({
      name: t.title,
      artist: t.subtitle,
    }));

    return { ok: true, tracklist, playlistName };
  } catch (err) {
    return { ok: false, reason: 'EXTRACTION_FAILED', detail: err && err.message };
  }
}

module.exports = { source, idFrom, extract, parse };
