# Requirements Document

## Introduction

SoundMatrix es un recomendador musical que construye un perfil de gusto a partir de las canciones de la playlist de una persona. Anteriormente el backend (`server.js`) enviaba el enlace de la playlist directamente a un LLM (Claude) para que "adivine" las canciones. El LLM no tiene acceso a internet, por lo que no podía conocer el tracklist real y producía resultados inventados.

Este feature agrega un **servicio de extracción de tracklists** dentro del servidor que obtiene la lista real de canciones directamente desde la URL de la playlist usando métodos gratuitos, sin APIs de pago ni dependencias externas de npm. La extracción se realiza **por código** y, cuando tiene éxito, las canciones reales se devuelven directamente, sin pasar por ningún LLM. Los nombres de canción y artista se limpian mediante una **normalización determinista por código** aplicada con reglas fijas. Cuando la extracción falla o la fuente no está soportada, el servidor devuelve un error explícito, evitando datos inventados.

**El LLM se elimina por completo del flujo de este feature: no interviene en ningún escenario.** El feature debe preservar exactamente el contrato de respuesta que el frontend (`index.html`) ya consume, incluso si dicho contrato conserva la forma de envoltorio que antes producía el LLM.

## Glossary

- **Servidor_SoundMatrix**: El proceso Node.js definido en `server.js` que expone el endpoint `POST /analyze`.
- **Servicio_Extraccion**: Componente del Servidor_SoundMatrix responsable de obtener el tracklist real de una URL de playlist mediante código.
- **Extractor**: Módulo que implementa una interfaz común y sabe extraer el tracklist de una única fuente de streaming. Existen cinco: Extractor_Spotify, Extractor_AppleMusic, Extractor_YouTubeMusic, Extractor_Deezer y Extractor_Tidal.
- **Fuente_Soportada**: Una de las cinco plataformas de streaming reconocidas en v1: Spotify, Apple Music, YouTube Music, Deezer, Tidal.
- **Detector_Fuente**: Componente que determina la Fuente_Soportada a partir del dominio de la URL de la playlist y selecciona el Extractor correspondiente.
- **Tracklist**: Lista ordenada de pistas extraídas, donde cada pista tiene un nombre de canción y un artista.
- **Normalizador_Nombres**: Componente que aplica por código un conjunto fijo de reglas deterministas para limpiar y estandarizar cadenas de nombre de canción, nombre de artista y claves de la base de datos. No usa ningún LLM ni servicio de red.
- **Reglas_Normalizacion**: El conjunto ordenado de transformaciones que aplica el Normalizador_Nombres: (a) minúsculas y trim; (b) eliminación de acentos mediante normalización Unicode NFD; (c) eliminación de sufijos de versión conocidos (`- acoustic`, `- remix`, `- live`, `- remastered`); (d) eliminación de contenido entre paréntesis y corchetes y de segmentos `feat.`/`ft.`; (e) para el artista, conservación del artista principal cortando en el primer separador `;`, `,`, `&` o `feat`; (f) colapso de espacios múltiples en un solo espacio.
- **Base_Canciones**: La base de datos local de 82.080 canciones embebida en `index.html`.
- **Funcion_findDB**: La función `findDB(name, artist)` de `index.html` que cruza el nombre y artista de una canción contra la Base_Canciones para localizar coincidencias.
- **Envoltorio_Respuesta**: Estructura de respuesta con forma `{"content":[{"type":"text","text":"<JSON>"}]}` donde `<JSON>` es la cadena serializada del Payload_Frontend. El Frontend la consume leyendo `data.content[].text`; se conserva por compatibilidad aunque ya no la genere un LLM.
- **Payload_Frontend**: Objeto JSON con forma `{"songs":[{"name":<string>,"artist":<string>}],"service":<string>,"playlist_name":<string>}` que el frontend `index.html` parsea.
- **Frontend**: La página `index.html` que hace `POST /analyze`, lee el Envoltorio_Respuesta y cruza cada canción contra la Base_Canciones mediante la Funcion_findDB.
- **Limite_Canciones**: El máximo de 50 canciones permitidas en un Tracklist devuelto.
- **Timeout_Extraccion**: El límite de 10 segundos para completar la extracción de una fuente.

## Requirements

### Requirement 1: Detección de fuente

**User Story:** Como usuario que pega un enlace de playlist, quiero que el servidor identifique automáticamente la plataforma de streaming, para que se use el método de extracción correcto.

#### Acceptance Criteria

1. WHEN el Servidor_SoundMatrix recibe una URL de playlist, THE Detector_Fuente SHALL determinar la Fuente_Soportada a partir del dominio de la URL.
2. WHEN el dominio de la URL corresponde a una Fuente_Soportada, THE Detector_Fuente SHALL seleccionar el Extractor asociado a esa Fuente_Soportada.
3. IF el dominio de la URL no corresponde a ninguna Fuente_Soportada, THEN THE Servidor_SoundMatrix SHALL responder con un error de fuente no soportada.
4. IF el campo de enlace está ausente o no es una URL con esquema `http` o `https`, THEN THE Servidor_SoundMatrix SHALL responder con un error de enlace inválido.

### Requirement 2: Extracción desde Spotify

**User Story:** Como usuario con una playlist de Spotify, quiero que el servidor obtenga las canciones reales de mi playlist, para que las recomendaciones se basen en datos verídicos.

#### Acceptance Criteria

1. WHEN el Detector_Fuente selecciona el Extractor_Spotify, THE Extractor_Spotify SHALL solicitar el recurso `https://open.spotify.com/embed/playlist/{id}` usando el identificador de playlist contenido en la URL.
2. WHEN el Extractor_Spotify recibe el documento HTML del recurso embed, THE Extractor_Spotify SHALL parsear el bloque JSON `__NEXT_DATA__` y construir el Tracklist tomando el título de cada pista como nombre de canción y el subtítulo como artista.
3. IF el bloque `__NEXT_DATA__` está ausente o no contiene una lista de pistas, THEN THE Extractor_Spotify SHALL reportar una extracción fallida.

### Requirement 3: Extracción desde Deezer

**User Story:** Como usuario con una playlist de Deezer, quiero que el servidor obtenga las canciones reales de mi playlist, para que las recomendaciones se basen en datos verídicos.

#### Acceptance Criteria

1. WHEN el Detector_Fuente selecciona el Extractor_Deezer, THE Extractor_Deezer SHALL solicitar el recurso `https://api.deezer.com/playlist/{id}` usando el identificador de playlist contenido en la URL.
2. WHEN el Extractor_Deezer recibe la respuesta JSON pública, THE Extractor_Deezer SHALL construir el Tracklist tomando el título de cada pista como nombre de canción y el nombre del artista como artista.
3. IF la respuesta JSON no contiene una lista de pistas, THEN THE Extractor_Deezer SHALL reportar una extracción fallida.

### Requirement 4: Extracción desde Apple Music

**User Story:** Como usuario con una playlist de Apple Music, quiero que el servidor obtenga las canciones reales de mi playlist, para que las recomendaciones se basen en datos verídicos.

#### Acceptance Criteria

1. WHEN el Detector_Fuente selecciona el Extractor_AppleMusic, THE Extractor_AppleMusic SHALL solicitar el documento HTML de la URL de la playlist.
2. WHEN el Extractor_AppleMusic recibe el documento HTML, THE Extractor_AppleMusic SHALL construir el Tracklist a partir de los metadatos de pistas embebidos en el HTML, tomando el nombre de canción y el artista de cada pista.
3. IF el documento HTML no contiene metadatos de pistas embebidos, THEN THE Extractor_AppleMusic SHALL reportar una extracción fallida.

### Requirement 5: Extracción desde YouTube Music

**User Story:** Como usuario con una playlist de YouTube Music, quiero que el servidor obtenga las canciones reales de mi playlist, para que las recomendaciones se basen en datos verídicos.

#### Acceptance Criteria

1. WHEN el Detector_Fuente selecciona el Extractor_YouTubeMusic, THE Extractor_YouTubeMusic SHALL solicitar el documento HTML de la URL de la playlist.
2. WHEN el Extractor_YouTubeMusic recibe el documento HTML, THE Extractor_YouTubeMusic SHALL parsear el bloque `ytInitialData` embebido y construir el Tracklist tomando el título de cada pista como nombre de canción y el artista asociado como artista.
3. IF el bloque `ytInitialData` está ausente o no contiene una lista de pistas, THEN THE Extractor_YouTubeMusic SHALL reportar una extracción fallida.

### Requirement 6: Extracción desde Tidal

**User Story:** Como usuario con una playlist de Tidal, quiero que el servidor obtenga las canciones reales de mi playlist, para que las recomendaciones se basen en datos verídicos.

#### Acceptance Criteria

1. WHEN el Detector_Fuente selecciona el Extractor_Tidal, THE Extractor_Tidal SHALL solicitar el documento HTML o embed de la URL de la playlist.
2. WHEN el Extractor_Tidal recibe el documento, THE Extractor_Tidal SHALL construir el Tracklist a partir de los metadatos de pistas embebidos, tomando el nombre de canción y el artista de cada pista.
3. IF el documento no contiene metadatos de pistas embebidos, THEN THE Extractor_Tidal SHALL reportar una extracción fallida.

### Requirement 7: Interfaz común de extractores

**User Story:** Como desarrollador del servidor, quiero que los cinco extractores compartan una interfaz común, para que agregar o mantener fuentes sea consistente y el flujo de despacho sea uniforme.

#### Acceptance Criteria

1. THE Servicio_Extraccion SHALL definir una interfaz común de Extractor que recibe una URL de playlist y devuelve un Tracklist o un resultado de extracción fallida.
2. WHERE una Fuente_Soportada tiene un Extractor registrado, THE Servicio_Extraccion SHALL invocar ese Extractor a través de la interfaz común.
3. THE Servicio_Extraccion SHALL registrar exactamente cinco Extractores en v1: Extractor_Spotify, Extractor_AppleMusic, Extractor_YouTubeMusic, Extractor_Deezer y Extractor_Tidal.

### Requirement 8: Límite de canciones

**User Story:** Como operador del servidor, quiero limitar el tamaño del tracklist procesado, para que el tiempo de respuesta y el volumen de datos se mantengan acotados.

#### Acceptance Criteria

1. WHEN un Extractor produce un Tracklist con más de 50 pistas, THE Servicio_Extraccion SHALL truncar el Tracklist a las primeras 50 pistas antes de construir el Payload_Frontend.
2. THE Servicio_Extraccion SHALL preservar el orden original de las pistas al truncar el Tracklist.

### Requirement 9: Timeout de extracción

**User Story:** Como usuario, quiero que la extracción no se quede colgada indefinidamente, para que reciba una respuesta en un tiempo razonable.

#### Acceptance Criteria

1. IF un Extractor no completa la extracción dentro de 10 segundos, THEN THE Servicio_Extraccion SHALL abortar la extracción y reportar una extracción fallida por timeout.
2. WHEN el Servicio_Extraccion reporta una extracción fallida por timeout, THE Servidor_SoundMatrix SHALL responder con un error.

### Requirement 10: Normalización determinista por código tras extracción exitosa

**User Story:** Como usuario, quiero que los nombres de canción y artista extraídos se limpien y estandaricen mediante reglas fijas por código, para que coincidan mejor con la Base_Canciones sin depender de un LLM.

#### Acceptance Criteria

1. WHEN el Servicio_Extraccion produce un Tracklist no vacío, THE Normalizador_Nombres SHALL aplicar las Reglas_Normalizacion al nombre de canción y al artista de cada pista mediante código, sin invocar a ningún LLM.
2. WHEN el Normalizador_Nombres normaliza un nombre de canción o un nombre de artista, THE Normalizador_Nombres SHALL aplicar las Reglas_Normalizacion en el siguiente orden: (a) convertir a minúsculas y aplicar trim; (b) eliminar acentos mediante normalización Unicode NFD; (c) eliminar los sufijos de versión conocidos `- acoustic`, `- remix`, `- live` y `- remastered`; (d) eliminar el contenido entre paréntesis y corchetes y los segmentos que comienzan con `feat.` o `ft.`; (e) colapsar espacios múltiples consecutivos en un solo espacio.
3. WHERE la cadena procesada es un nombre de artista, THE Normalizador_Nombres SHALL conservar únicamente el artista principal cortando la cadena en el primer separador `;`, `,`, `&` o `feat`.
4. WHEN el Normalizador_Nombres termina de normalizar el Tracklist, THE Servidor_SoundMatrix SHALL construir el Payload_Frontend con la lista de canciones normalizadas, el nombre de la Fuente_Soportada en el campo `service` y el nombre de la playlist en el campo `playlist_name` cuando esté disponible.
5. THE Servidor_SoundMatrix SHALL usar únicamente las pistas del Tracklist extraído como fuente de las canciones del Payload_Frontend y SHALL abstenerse de agregar canciones que no estén en el Tracklist.

### Requirement 11: Manejo estricto de errores sin LLM

**User Story:** Como usuario, quiero recibir un error claro en lugar de recomendaciones inventadas cuando la extracción no funciona, para que confíe en que los resultados provienen de datos reales.

#### Acceptance Criteria

1. IF el Servicio_Extraccion reporta una extracción fallida por fuente caída, enlace inválido, timeout o cambio de markup, THEN THE Servidor_SoundMatrix SHALL responder con un error.
2. IF la URL corresponde a una fuente que no es una Fuente_Soportada, THEN THE Servidor_SoundMatrix SHALL responder con un error de fuente no soportada.
3. IF el Tracklist extraído está vacío, THEN THE Servidor_SoundMatrix SHALL responder con un error de playlist vacía.
4. THE Servidor_SoundMatrix SHALL abstenerse de invocar a cualquier LLM en todos los escenarios de este feature, incluyendo los escenarios de error y los de éxito.
5. WHEN el Servidor_SoundMatrix responde con un error de este requisito, THE Servidor_SoundMatrix SHALL incluir un mensaje de error legible en un campo accesible por el Frontend como `error.message`.

### Requirement 12: Preservación del contrato de respuesta con el frontend

**User Story:** Como mantenedor del frontend, quiero que la respuesta del servidor conserve la estructura actual, para que `index.html` siga funcionando sin cambios.

#### Acceptance Criteria

1. WHEN la extracción y la normalización por código son exitosas, THE Servidor_SoundMatrix SHALL responder con el Envoltorio_Respuesta `{"content":[{"type":"text","text":"<JSON>"}]}` donde `<JSON>` es la cadena serializada del Payload_Frontend.
2. THE Servidor_SoundMatrix SHALL conservar el Envoltorio_Respuesta porque el Frontend extrae el Payload_Frontend leyendo `data.content[].text`, con independencia de que ningún LLM genere dicha respuesta.
3. THE Payload_Frontend SHALL contener las claves `songs`, `service` y `playlist_name`, donde `songs` es una lista de objetos con las claves `name` y `artist`.
4. WHEN el Servidor_SoundMatrix responde con éxito, THE Servidor_SoundMatrix SHALL usar el código de estado HTTP 200.
5. WHEN el Servidor_SoundMatrix responde con un error, THE Servidor_SoundMatrix SHALL usar un código de estado HTTP distinto de 200 y un cuerpo JSON con el mensaje de error.

### Requirement 13: Normalización consistente en el cruce contra la base de canciones

**User Story:** Como usuario, quiero que el nombre y el artista de mis canciones y las claves de la Base_Canciones se limpien con las mismas reglas antes de cruzarse, para que las coincidencias en la Funcion_findDB sean máximas.

#### Acceptance Criteria

1. WHEN el Frontend cruza una canción contra la Base_Canciones mediante la Funcion_findDB, THE Normalizador_Nombres SHALL aplicar las Reglas_Normalizacion al nombre de canción y al artista extraídos antes de la comparación.
2. WHEN el Frontend cruza una canción contra la Base_Canciones mediante la Funcion_findDB, THE Normalizador_Nombres SHALL aplicar las mismas Reglas_Normalizacion a la clave de nombre y a la clave de artista provenientes de la Base_Canciones antes de la comparación.
3. THE Normalizador_Nombres SHALL aplicar Reglas_Normalizacion idénticas y en el mismo orden tanto a la cadena extraída como a la cadena proveniente de la Base_Canciones.

### Requirement 14: Sin dependencias externas ni LLM

**User Story:** Como operador del servidor, quiero que la extracción y la normalización usen solo capacidades nativas de Node, para mantener costo cero y despliegue simple.

#### Acceptance Criteria

1. THE Servicio_Extraccion SHALL realizar todas las peticiones de red usando módulos nativos de Node 18 o superior, incluyendo la función `fetch` global.
2. THE Servicio_Extraccion SHALL abstenerse de usar APIs de pago, la API oficial de Spotify y cualquier servicio de LLM para extraer el Tracklist.
3. THE Normalizador_Nombres SHALL realizar toda la normalización mediante código nativo de Node sin invocar servicios de red ni LLM.
