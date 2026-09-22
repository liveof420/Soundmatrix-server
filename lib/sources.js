// lib/sources.js
// Detector_Fuente + registro de extractores.
// Requirements: 1.1, 1.2, 1.3, 7.2, 7.3
//
// - detectSource(url): mapea el dominio de la URL a una Fuente_Soportada o null.
//   Alineado con detectSvc() del frontend (index.html).
// - REGISTRY: exactamente las 5 fuentes → sus extractores (Requirement 7.3).
// - getExtractor(source): devuelve el extractor de una fuente o null.
// - extractPlaylistId(url): extrae el id de la playlist delegando en el
//   idFrom(url) del extractor de la fuente detectada (o null).

'use strict';

const spotify = require('./extractors/spotify');
const deezer = require('./extractors/deezer');
const appleMusic = require('./extractors/appleMusic');
const youtubeMusic = require('./extractors/youtubeMusic');
const tidal = require('./extractors/tidal');

// Exactamente 5 extractores (Requirement 7.3).
const REGISTRY = {
  Spotify: spotify,
  Deezer: deezer,
  'Apple Music': appleMusic,
  'YouTube Music': youtubeMusic,
  Tidal: tidal,
};

/**
 * Detección de fuente por dominio (Requirement 1.1).
 * Nota: alineada con detectSvc() del frontend.
 * @param {URL} url  instancia de URL
 * @returns {string|null}  nombre de la Fuente_Soportada o null si no soportada
 */
function detectSource(url) {
  const h = url.hostname.toLowerCase();
  if (h.includes('spotify.com')) return 'Spotify';
  if (h.includes('deezer.com')) return 'Deezer';
  if (h.includes('apple.com') || h.includes('music.apple')) return 'Apple Music';
  // Solo se soporta music.youtube.com. YouTube normal (youtube.com / youtu.be)
  // usa otro formato (playlistVideoRenderer) y muro de consentimiento al hacer
  // fetch de servidor, por lo que NO se soporta: cae como fuente no soportada.
  if (h === 'music.youtube.com' || h.endsWith('.music.youtube.com')) return 'YouTube Music';
  if (h.includes('tidal.com')) return 'Tidal';
  return null; // no soportada
}

/**
 * Devuelve el Extractor registrado para una Fuente_Soportada (Requirement 7.2).
 * @param {string} source
 * @returns {object|null}
 */
function getExtractor(source) {
  return REGISTRY[source] || null;
}

/**
 * Extrae el id de la playlist de la URL, delegando en el idFrom() del
 * extractor de la fuente detectada. Devuelve null si la fuente no está
 * soportada o si el id no es extraíble.
 * @param {URL} url  instancia de URL
 * @returns {string|null}
 */
function extractPlaylistId(url) {
  const source = detectSource(url);
  if (!source) return null;
  const extractor = getExtractor(source);
  if (!extractor) return null;
  return extractor.idFrom(url);
}

module.exports = { REGISTRY, detectSource, getExtractor, extractPlaylistId };
