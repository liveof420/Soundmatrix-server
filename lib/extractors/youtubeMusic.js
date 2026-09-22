// lib/extractors/youtubeMusic.js
// Extractor_YouTubeMusic — Requirements 5.1, 5.2, 5.3, 7.1
//
// Extrae el tracklist real de una playlist de YouTube Music desde el HTML de
// la página, parseando el bloque JSON embebido `ytInitialData`. Este parser es
// FRÁGIL: depende de markup que YouTube puede cambiar sin aviso, por lo que se
// implementa defensivamente (try/catch + recorrido recursivo sin ruta rígida).

'use strict';

/**
 * @typedef {{ name: string, artist: string }} Track
 * @typedef {{ ok: true,  tracklist: Track[], playlistName: string|null }} ExtractOk
 * @typedef {{ ok: false, reason: 'EXTRACTION_FAILED', detail?: string }} ExtractFail
 * @typedef {ExtractOk | ExtractFail} ExtractResult
 */

const source = 'YouTube Music';

// User-Agent de navegador para obtener el markup con ytInitialData embebido.
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * Extrae el id de playlist de la URL de YouTube Music.
 * El id viene en el query string, no en el path: url.searchParams.get('list')
 * @param {URL} url
 * @returns {string|null}
 */
function idFrom(url) {
  return url.searchParams.get('list') || null;
}

/**
 * Solicita el HTML de la URL de la playlist y delega el parseo en parse().
 * Requirement 5.1: GET del documento HTML con User-Agent de navegador y
 * Accept-Language: en-US. Pasa signal a fetchFn.
 * @param {URL} url
 * @param {typeof fetch} fetchFn
 * @param {AbortSignal} [signal]
 * @returns {Promise<ExtractResult>}
 */
async function extract(url, fetchFn, signal) {
  try {
    const res = await fetchFn(String(url), {
      signal,
      headers: {
        'User-Agent': USER_AGENT,
        'Accept-Language': 'en-US',
      },
    });
    if (!res || !res.ok) return { ok: false, reason: 'EXTRACTION_FAILED' };
    const body = await res.text();
    return parse(body);
  } catch (err) {
    return { ok: false, reason: 'EXTRACTION_FAILED', detail: err && err.message };
  }
}

/**
 * Extrae el objeto JSON con los datos de la playlist del HTML.
 *
 * music.youtube.com NO usa `ytInitialData`; entrega el contenido mediante
 * llamadas `initialData.push({path:'/browse', params:..., data:'...'})`, donde
 * el JSON real viene dentro del campo `data` como string JavaScript
 * hex-escapado (\x22, \x7b, \/, ...). Se intenta primero ese formato y se
 * mantiene `ytInitialData` como fallback para compatibilidad.
 *
 * @param {string} body
 * @returns {any|null}
 */
function extractYtInitialData(body) {
  // Formato 1 (music.youtube.com): initialData.push({path:'/browse', data:'...'}).
  const fromPush = extractFromInitialDataPush(body);
  if (fromPush) return fromPush;

  // Formato 2 (fallback): ytInitialData = ({...}); / var ytInitialData = {...};
  // El objeto puede contener llaves anidadas, así que no basta con /\{.*?\}/.
  // Estrategia: localizar el inicio del literal y balancear llaves.
  const anchors = [
    /ytInitialData\s*=\s*\(\s*\{/,
    /ytInitialData\s*=\s*\{/,
  ];

  for (const anchor of anchors) {
    const m = body.match(anchor);
    if (!m) continue;
    // El índice de la primera '{' es el final del match menos 1.
    const braceStart = body.indexOf('{', m.index);
    if (braceStart === -1) continue;
    const jsonStr = sliceBalancedObject(body, braceStart);
    if (!jsonStr) continue;
    try {
      return JSON.parse(jsonStr);
    } catch (_) {
      // Intentar el siguiente anchor.
    }
  }
  return null;
}

/**
 * Formato de music.youtube.com: localiza los bloques
 * `initialData.push({ ... path: '/browse' ... data: '<json escapado>' ... })`
 * y devuelve el objeto parseado del bloque cuyo `path` sea `/browse`.
 *
 * El campo `data` es un string JavaScript hex-escapado (\x22 → ", \x7b → {,
 * \/ → /, ...) que hay que desescapar antes de JSON.parse.
 *
 * Puede haber varios `initialData.push(...)`; solo el de `path:'/browse'`
 * contiene el tracklist. Se recorren todos y se devuelve el primero cuyo
 * `data` parsee a un objeto.
 *
 * @param {string} body
 * @returns {any|null}
 */
function extractFromInitialDataPush(body) {
  const pushAnchor = /initialData\.push\s*\(\s*\{/g;
  let m;
  while ((m = pushAnchor.exec(body)) !== null) {
    const braceStart = body.indexOf('{', m.index);
    if (braceStart === -1) continue;
    const objStr = sliceBalancedObject(body, braceStart);
    if (!objStr) continue;

    // Nos interesa el push cuyo path sea '/browse' (contiene el tracklist).
    // El path viene escapado (\/browse) dentro del literal JS.
    if (!/path\s*:\s*'(?:\\?\/)browse'/.test(objStr) &&
        !/path\s*:\s*"(?:\\?\/)browse"/.test(objStr)) {
      continue;
    }

    const dataStr = extractDataFieldString(objStr);
    if (!dataStr) continue;

    const unescaped = unescapeJsString(dataStr);
    try {
      const parsed = JSON.parse(unescaped);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch (_) {
      // Bloque no parseable; probar el siguiente push.
    }
  }
  return null;
}

/**
 * Extrae el contenido crudo (aún escapado) del campo `data: '...'` de un
 * literal `initialData.push({...})`. Soporta comillas simples o dobles y
 * respeta los escapes (\' , \" , \\) dentro del string.
 *
 * @param {string} objStr  el literal del objeto push, empezando en '{'
 * @returns {string|null}  el contenido del string data sin las comillas, o null
 */
function extractDataFieldString(objStr) {
  const keyRe = /data\s*:\s*(['"])/g;
  const km = keyRe.exec(objStr);
  if (!km) return null;
  const quote = km[1];
  const start = km.index + km[0].length; // primer carácter tras la comilla de apertura
  let escaped = false;
  for (let i = start; i < objStr.length; i++) {
    const ch = objStr[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === quote) {
      return objStr.slice(start, i);
    }
  }
  return null;
}

/**
 * Desescapa un string JavaScript tal como aparece embebido en el HTML de
 * music.youtube.com: \xNN → carácter, \uNNNN → carácter, \/ → /, y los escapes
 * habituales (\" \' \\ \n \r \t \b \f). Deja intacto cualquier otro carácter.
 *
 * @param {string} s
 * @returns {string}
 */
function unescapeJsString(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = s[i + 1];
    if (next === undefined) {
      out += ch;
      break;
    }
    switch (next) {
      case 'x': {
        const hex = s.slice(i + 2, i + 4);
        if (/^[0-9a-fA-F]{2}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16));
          i += 3;
        } else {
          out += next;
          i += 1;
        }
        break;
      }
      case 'u': {
        const hex = s.slice(i + 2, i + 6);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16));
          i += 5;
        } else {
          out += next;
          i += 1;
        }
        break;
      }
      case 'n': out += '\n'; i += 1; break;
      case 'r': out += '\r'; i += 1; break;
      case 't': out += '\t'; i += 1; break;
      case 'b': out += '\b'; i += 1; break;
      case 'f': out += '\f'; i += 1; break;
      case '/': out += '/'; i += 1; break;
      case '"': out += '"'; i += 1; break;
      case "'": out += "'"; i += 1; break;
      case '\\': out += '\\'; i += 1; break;
      default:
        // Escape desconocido: conservar el carácter siguiente tal cual.
        out += next;
        i += 1;
        break;
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
  let strCh = '';      // comilla que abrió el string actual (" o ')
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === strCh) {
        inStr = false;
      }
      continue;
    }
    // Reconocer strings con comillas dobles Y simples: los literales
    // initialData.push({...}) de music.youtube.com usan comillas simples para
    // los campos path/params/data, y su contenido incluye llaves escapadas
    // (\x7b/\x7d) que NO deben contarse como llaves del objeto.
    if (ch === '"' || ch === "'") {
      inStr = true;
      strCh = ch;
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
 * Extrae {name, artist} de un musicResponsiveListItemRenderer.
 * Lee los flexColumns → runs[].text: el primer run suele ser el título y un
 * run posterior el artista. Defensivo ante ausencia de campos.
 * @param {any} renderer
 * @returns {Track|null}
 */
function trackFromRenderer(renderer) {
  try {
    const cols = renderer && renderer.flexColumns;
    if (!Array.isArray(cols) || cols.length === 0) return null;

    // Recolectar los textos de runs de cada columna, en orden.
    const texts = [];
    for (const col of cols) {
      const runs =
        col &&
        col.musicResponsiveListItemFlexColumnRenderer &&
        col.musicResponsiveListItemFlexColumnRenderer.text &&
        col.musicResponsiveListItemFlexColumnRenderer.text.runs;
      if (!Array.isArray(runs)) continue;
      for (const run of runs) {
        if (run && typeof run.text === 'string') {
          const t = run.text.trim();
          // Descartar separadores tipo " • " que YouTube intercala.
          if (t && t !== '•' && t !== '&') texts.push(t);
        }
      }
    }

    if (texts.length === 0) return null;

    const name = texts[0];
    // El artista suele ser el segundo texto significativo. Si no hay, cadena vacía.
    const artist = texts.length > 1 ? texts[1] : '';
    if (!name) return null;

    return { name, artist };
  } catch (_) {
    return null;
  }
}

/**
 * Recorrido recursivo defensivo: colecta todos los objetos con forma de item de
 * pista (musicResponsiveListItemRenderer) en cualquier profundidad de `node`.
 * No codifica una ruta rígida porque la estructura anidada es profunda y volátil.
 * @param {any} node
 * @param {Track[]} out
 */
function collectTracks(node, out) {
  if (node == null || typeof node !== 'object') return;

  if (Array.isArray(node)) {
    for (const item of node) collectTracks(item, out);
    return;
  }

  const renderer = node.musicResponsiveListItemRenderer;
  if (renderer && typeof renderer === 'object') {
    const track = trackFromRenderer(renderer);
    if (track) out.push(track);
    // No hacemos return: por seguridad, seguimos recorriendo hijos del nodo.
  }

  for (const key of Object.keys(node)) {
    collectTracks(node[key], out);
  }
}

/**
 * Intento defensivo de leer el nombre de la playlist desde la estructura.
 * Busca la primera cadena razonable en headers conocidos; si no, null.
 * @param {any} data
 * @returns {string|null}
 */
function extractPlaylistName(data) {
  try {
    const header = data && data.header;
    if (header && typeof header === 'object') {
      // Recorrer el header buscando un title.runs[].text.
      const name = findTitleText(header);
      if (name) return name;
    }
    return null;
  } catch (_) {
    return null;
  }
}

/**
 * Busca recursivamente un `title.runs[0].text` (o `title.simpleText`) en el nodo.
 * @param {any} node
 * @returns {string|null}
 */
function findTitleText(node) {
  if (node == null || typeof node !== 'object') return null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const r = findTitleText(item);
      if (r) return r;
    }
    return null;
  }

  const title = node.title;
  if (title && typeof title === 'object') {
    if (Array.isArray(title.runs) && title.runs[0] && typeof title.runs[0].text === 'string') {
      const t = title.runs[0].text.trim();
      if (t) return t;
    }
    if (typeof title.simpleText === 'string' && title.simpleText.trim()) {
      return title.simpleText.trim();
    }
  }

  for (const key of Object.keys(node)) {
    const r = findTitleText(node[key]);
    if (r) return r;
  }
  return null;
}

/**
 * Parseo puro del HTML de YouTube Music.
 * Requirement 5.2: localizar ytInitialData, JSON.parse, y con un buscador
 * recursivo colectar items musicResponsiveListItemRenderer leyendo
 * flexColumns → runs[].text para título y artista.
 * Requirement 5.3: sin ytInitialData o sin items → EXTRACTION_FAILED.
 * @param {string} body
 * @returns {ExtractResult}
 */
function parse(body) {
  try {
    if (typeof body !== 'string' || body.length === 0) {
      return { ok: false, reason: 'EXTRACTION_FAILED' };
    }

    const data = extractYtInitialData(body);
    if (!data) return { ok: false, reason: 'EXTRACTION_FAILED' };

    const tracklist = [];
    collectTracks(data, tracklist);

    if (tracklist.length === 0) {
      return { ok: false, reason: 'EXTRACTION_FAILED' };
    }

    const playlistName = extractPlaylistName(data);

    return { ok: true, tracklist, playlistName: playlistName || null };
  } catch (err) {
    return { ok: false, reason: 'EXTRACTION_FAILED', detail: err && err.message };
  }
}

module.exports = { source, idFrom, extract, parse };
