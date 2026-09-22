# SoundMatrix

Recomendador musical basado en **álgebra lineal**. A partir de las canciones de una
playlist construye un perfil de gusto y recomienda temas compatibles de una base de
**82.080 canciones reales**, resolviendo un sistema de ecuaciones normales
(`MᵀM·p = Mᵀb`) por eliminación de Gauss-Jordan — todo de forma manual, sin librerías
de machine learning.

El proyecto es un único servicio Node.js que sirve tanto el frontend (`index.html`)
como una pequeña API de extracción de tracklists. **No usa ningún LLM ni servicios de
pago**: las canciones se extraen directamente de cada servicio de streaming y el
matching se hace por código.

## Cómo funciona

```
Navegador (index.html)
   │  1. Pegas el link de una playlist
   │  POST /analyze  { link }
   ▼
server.js
   │  2. Detecta la fuente por el dominio del link
   │  3. Extrae el tracklist REAL del servicio (por código, sin adivinar)
   │  4. Normaliza nombres/artistas y responde el JSON de canciones
   ▼
Navegador
   5. Cruza cada canción contra la base de 82.080 (findDB)
   6. Construye la Matriz M (n × 5) con las features E,T,V,A,I
   7. Resuelve MᵀM·p = Mᵀb (Gauss-Jordan) → perfil de gusto p
   8. Ordena las 82.080 por producto punto p·c → Top 10 recomendaciones
```

Las **5 características** de cada canción (vector en R⁵):

| Símbolo | Feature | Descripción |
|---------|---------|-------------|
| E | Energía | Intensidad perceptual [0→1] |
| T | Tempo | BPM normalizado a [0,1] |
| V | Valencia | Positividad musical [0→1] |
| A | Acústica | Probabilidad de grabación acústica |
| I | Instrumental | Ausencia de voz humana |

## Fuentes de playlist soportadas

La extracción del tracklist es gratuita, sin API keys ni login, usando recursos
públicos de cada servicio:

| Fuente | Método de extracción |
|--------|----------------------|
| **Spotify** | Página embed (`open.spotify.com/embed/playlist/{id}`) → JSON `__NEXT_DATA__` |
| **Deezer** | API pública `api.deezer.com/playlist/{id}` (JSON, campo `tracks.data`) |
| **Apple Music** | HTML de la playlist → `serialized-server-data` (título + artista) |
| **YouTube Music** | HTML de `music.youtube.com` → `initialData.push` (JSON hex-escapado) |
| **Tidal** | Reproductor embed (`embed.tidal.com/playlists/{id}`) |

Notas:
- Solo se soporta **`music.youtube.com`** (YouTube normal no).
- Se aceptan links de **playlist**, no de álbum ni canción individual.
- Si la extracción falla o la fuente no está soportada, el servidor devuelve un
  error explícito — nunca inventa canciones.
- Máximo 50 canciones por playlist; timeout de extracción de 10 s.

## Ejecutar en local

Requiere **Node.js 18+** (sin dependencias de npm — solo módulos nativos).

```bash
node server.js
# o
npm start
```

Luego abre `http://localhost:3000` en el navegador.

El servidor sirve todo desde el mismo puerto:
- `GET /` → el frontend (`index.html`)
- `GET /normalize.js` → la función de normalización compartida
- `GET /health` → health check
- `POST /analyze` → extracción del tracklist

Puedes cambiar el puerto con la variable de entorno `PORT`.

## Ejecutar los tests

```bash
npm test
# equivale a: node --test "test/**/*.test.js"
```

Usa el runner nativo `node --test` (sin dependencias). Cubre normalización,
detección de fuente, los 5 extractores (con fixtures del formato real de cada
servicio), truncado, manejo de errores, el contrato de respuesta y el cruce
contra la base de datos.

## Despliegue en Render

1. Sube el repositorio a GitHub.
2. En Render: **New → Web Service** y conecta el repositorio.
3. Configuración:
   - **Start Command:** `node server.js`
   - **Health Check Path:** `/health`
   - No necesita variables de entorno ni API keys.
4. Deploy.

Como el frontend usa **rutas relativas** (`/analyze`, `/normalize.js`), funciona
igual en local y en Render sin cambiar ninguna URL.

## API

### `POST /analyze`

Extrae el tracklist real de una playlist.

**Request**
```json
{ "link": "https://open.spotify.com/playlist/37i9dQZF1DX10zKzsJ2jva" }
```

**Respuesta (200)** — envoltorio con el JSON de canciones:
```json
{
  "content": [
    {
      "type": "text",
      "text": "{\"songs\":[{\"name\":\"...\",\"artist\":\"...\"}],\"service\":\"Spotify\",\"playlist_name\":\"...\"}"
    }
  ]
}
```

**Errores** — código HTTP ≠ 200 con `{ "error": { "code", "message" } }`:

| code | HTTP | Cuándo |
|------|------|--------|
| `INVALID_LINK` | 400 | Link ausente o sin esquema http/https |
| `UNSUPPORTED_SOURCE` | 422 | Dominio que no es una de las 5 fuentes |
| `EMPTY_PLAYLIST` | 422 | La playlist no tiene canciones |
| `EXTRACTION_FAILED` | 502 | Fuente caída o markup cambiado |
| `TIMEOUT` | 504 | La extracción superó los 10 s |

## Estructura del proyecto

```
├── index.html              # Frontend completo (UI + base de 82.080 canciones + álgebra lineal)
├── server.js               # Servidor HTTP: sirve el frontend y expone la API
├── normalize.js            # Normalización de nombres (fuente única, usada por server y frontend)
├── lib/
│   ├── sources.js          # Detección de fuente por dominio + registro de extractores
│   ├── extract.js          # Orquestador: dispatch + timeout + truncado + ensamblaje
│   └── extractors/         # Un extractor por fuente
│       ├── spotify.js
│       ├── deezer.js
│       ├── appleMusic.js
│       ├── youtubeMusic.js
│       └── tidal.js
├── test/                   # Tests con node --test (property-based + fixtures)
└── package.json
```

### Normalización compartida (`normalize.js`)

Es la **fuente única de verdad** para limpiar títulos y artistas. El servidor la usa
con `require`, y el navegador la carga vía `GET /normalize.js` (mismo archivo, sin
duplicar lógica). Reglas: minúsculas + trim, quita acentos (NFD), sufijos de versión
(`- acoustic`, `- remix`, `- live`, `- remastered`), contenido entre paréntesis/corchetes
y segmentos `feat.`/`ft.`, y toma solo el artista principal. El cruce contra la base
(`findDB`) usa una clave compuesta **título + artista** para evitar falsos positivos
entre canciones distintas con el mismo título.

---

Proyecto de Grado 11 · Implementación manual de álgebra lineal · 82.080 canciones reales.
