const https = require('https');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY;

// Servidor HTTP simple sin dependencias externas
const http = require('http');

const server = http.createServer((req, res) => {

  // ── CORS: permite que el HTML (desde cualquier origen) llame a este servidor
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Preflight OPTIONS
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Solo acepta POST en /analyze
  if (req.method === 'POST' && req.url === '/analyze') {

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

      // Payload para la API de Anthropic
      const payload = JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        system: `Eres un experto en música. Recibirás un link de playlist de cualquier servicio de streaming. Identifica las canciones más probables basándote en el identificador del link, el servicio, o el género/mood implícito. Responde ÚNICAMENTE con JSON válido sin markdown ni texto extra: {"songs":[{"name":"nombre exacto","artist":"artista"}],"service":"servicio","playlist_name":"nombre si se conoce"}. Devuelve entre 8 y 15 canciones con nombres exactos como aparecen en las plataformas.`,
        messages: [{ role: 'user', content: 'Extrae las canciones de esta playlist: ' + playlistLink }]
      });

      // Opciones de la petición a Anthropic
      const options = {
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': API_KEY,
          'anthropic-version': '2023-06-01',
          'Content-Length': Buffer.byteLength(payload)
        }
      };

      // Llamar a la API de Anthropic desde el servidor (la key nunca sale al navegador)
      const apiReq = https.request(options, apiRes => {
        let data = '';
        apiRes.on('data', chunk => data += chunk);
        apiRes.on('end', () => {
          res.writeHead(apiRes.statusCode, { 'Content-Type': 'application/json' });
          res.end(data);
        });
      });

      apiReq.on('error', err => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Error conectando con Anthropic: ' + err.message }));
      });

      apiReq.write(payload);
      apiReq.end();
    });

  } else if (req.method === 'GET' && req.url === '/') {
    // Health check — Render lo usa para verificar que el servidor está vivo
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('SoundMatrix API server running OK');

  } else {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Ruta no encontrada' }));
  }
});

server.listen(PORT, () => {
  console.log(`SoundMatrix server corriendo en puerto ${PORT}`);
});
