const PORT = process.env.PORT || 3000;

// Servidor HTTP simple sin dependencias externas
const http = require('http');
const fs = require('fs');
const path = require('path');
const { extractTracklist, buildPayload, wrapResponse } = require('./lib/extract');

/**
 * Mapea un `reason` de extracción fallida a su estado HTTP, código y mensaje
 * legible por el Frontend (via data.error.message). Tabla del design.md
 * (§Manejo de errores). Requirements: 11.1, 11.2, 11.3, 11.5, 12.5.
 *
 * @param {string} reason
 * @returns {{ status: number, code: string, message: string }}
 */
function mapError(reason) {
  switch (reason) {
    case 'INVALID_LINK':
      return { status: 400, code: reason, message: 'El enlace de playlist es inválido o está ausente.' };
    case 'UNSUPPORTED_SOURCE':
      return { status: 422, code: reason, message: 'Fuente no soportada. Usa Spotify, Apple Music, YouTube Music, Deezer o Tidal.' };
    case 'EXTRACTION_FAILED':
      return { status: 502, code: reason, message: 'No se pudieron extraer las canciones de la playlist.' };
    case 'TIMEOUT':
      return { status: 504, code: reason, message: 'La extracción tardó demasiado. Intenta de nuevo.' };
    case 'EMPTY_PLAYLIST':
      return { status: 422, code: reason, message: 'La playlist no contiene canciones.' };
    default:
      return { status: 500, code: reason || 'INTERNAL_ERROR', message: 'Error interno.' };
  }
}

const server = http.createServer((req, res) => {

  // ── CORS: permite que el HTML (desde cualquier origen) llame a este servidor
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Se enruta por pathname (sin query string): el navegador/Render pueden añadir
  // "?..." a la URL y no debe afectar el matching de rutas.
  let pathname = req.url;
  try { pathname = new URL(req.url, 'http://localhost').pathname; } catch (_) {}

  // Preflight OPTIONS
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Solo acepta POST en /analyze
  if (req.method === 'POST' && pathname === '/analyze') {

    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {

      let playlistLink;
      try {
        playlistLink = JSON.parse(body).link;
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'JSON inválido' }));
        return;
      }

      if (!playlistLink) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Falta el campo link' }));
        return;
      }

      // Orquestación de extracción: dispatch + timeout + truncado + normalización.
      // En fallo se mapea reason→HTTP; en éxito se arma el Envoltorio_Respuesta.
      (async () => {
        const result = await extractTracklist(playlistLink);
        if (!result.ok) {
          const { status, code, message } = mapError(result.reason);
          res.writeHead(status, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: { code, message } }));
        }
        const payload = buildPayload(result.tracklist, result.service, result.playlistName);
        const envelope = wrapResponse(payload);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(envelope));
      })();
    });

  } else if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    // Sirve el frontend. Así el mismo servidor entrega el HTML y los endpoints,
    // y el frontend puede usar rutas relativas (/analyze, /normalize.js) tanto
    // en local como en Render, sin URLs hardcodeadas.
    fs.readFile(path.join(__dirname, 'index.html'), (err, buf) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('index.html no disponible');
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(buf);
    });

  } else if (req.method === 'GET' && pathname === '/health') {
    // Health check — Render lo usa para verificar que el servidor está vivo.
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('SoundMatrix API server running OK');

  } else if (req.method === 'GET' && pathname === '/normalize.js') {
    // Sirve la fuente única de verdad de normalización al navegador, para que
    // index.html cargue la MISMA implementación que usa el server (Req 13.3, 14.3).
    // Los headers CORS '*' ya se fijaron arriba, así que aplican también aquí.
    fs.readFile(path.join(__dirname, 'normalize.js'), (err, buf) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('// normalize.js no disponible');
      }
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
      res.end(buf);
    });

  } else {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Ruta no encontrada' }));
  }
});

server.listen(PORT, () => {
  console.log(`SoundMatrix server corriendo en puerto ${PORT}`);
});
