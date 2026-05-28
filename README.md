# SoundMatrix Server

Servidor proxy que protege la API key de Anthropic.
El HTML llama a este servidor, y este servidor llama a Anthropic.
La key nunca llega al navegador del usuario.

## Despliegue en Render

1. Sube esta carpeta a un repositorio de GitHub
2. En Render: New > Web Service > conecta el repositorio
3. En Environment Variables agrega:
   - Key: ANTHROPIC_API_KEY
   - Value: tu key (sk-ant-...)
4. Start Command: node server.js
5. Deploy

## Endpoint

POST /analyze
Body: { "link": "https://open.spotify.com/playlist/..." }
