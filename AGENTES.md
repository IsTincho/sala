# Sala — Instrucciones para agentes Opus

Prompts para que agentes construyan el proyecto Sala completo, fase por fase. Cada prompt es autónomo. El plan de referencia es `PLAN.md`. La forma normal de usarlos es a través del **director** (`ARRANQUE.md`), que los lanza como subagentes con modelo Opus; también se pueden pegar a mano en una sesión nueva.

---

## Cómo se usan

1. El director (o vos) pega el **Brief común** y, debajo, el **prompt de la fase**. Un agente por fase, en orden. No arrancar una fase sin cerrar la anterior, salvo trabajo de la siguiente que no dependa de lo pendiente.
2. Al terminar cada fase, un agente nuevo corre el **prompt del Verificador**. Si encuentra fallas, vuelven al agente de la fase y se repite hasta que apruebe.
3. Cada fase termina con una entrada en `BITACORA.md` y un commit. El agente siguiente lee la bitácora antes de tocar nada.

Dentro de una fase, si el agente reparte trabajo en subagentes: `scout` para buscar, `implementer` para módulos con spec clara, `architect` para decisiones, `verifier` al cierre. No más de tres en paralelo: comparten el working tree.

**Secretos, siempre:** los client secrets, la clave de cifrado, `MONGODB_URI` y el token de R2 se cargan desde el dashboard de Railway o desde un `.env` local ignorado por git. Ningún agente los pide, los imprime ni los pega. Si un agente necesita "probar el login", lo dice y espera a que el dueño cargue las variables.

---

## Brief común (pegar al inicio de cada sesión)

```
Contexto del proyecto "Sala"

Sos parte de un equipo de agentes que construye Sala, un servicio web para un streamer de Kick (usuario `istincho`, canal kick.com/istincho) que:
1. Muestra en una ventana aparte el chat de Kick y el de Twitch juntos, y permite escribir a los dos ("Chat Global").
2. Deja que el streamer pase una película o serie en una página propia, con su cámara de Kick embebida al lado y el chat real de Kick a la derecha; los espectadores se loguean con Kick y lo que escriben cae en el chat real del stream ("Sala").
3. Más adelante, ofrece lo mismo a otros creadores con planes gratis / amigo / pago.

El plan completo está en PLAN.md. Leelo entero antes de empezar. La bitácora de lo hecho está en BITACORA.md; leela también. No repitas trabajo que ya figure ahí.

El repo hermano está en ../CosasStream. Es la referencia de estilo y de patrones: leé su LEER.md y, cuando toque, servidor/acceso.js (OAuth Kick con PKCE y roles), servidor/webhook.js (verificación RSA y dedupe), servidor/bus.js (SSE), servidor/almacen.js (Mongo o JSON), Overlays/comun/bus.js (cliente SSE). Copiá lo que sirva, adaptado; no importes nada de ese repo en tiempo de ejecución.

Restricciones que no se negocian:
- Infraestructura: un servicio Node en Railway (ya pago), MongoDB Atlas gratis, Cloudflare R2 gratis con URL pública r2.dev para el video, dominio de Railway. Nada más con costo. El servidor nunca sirve video: el navegador lo pide directo a R2.
- Sin frameworks ni bundlers. Node moderno (ES modules, `http` nativo), sin dependencias salvo `mongodb`. Páginas en HTML, CSS y JS puros. hls.js desde CDN con versión fijada. Python sólo en herramientas/ para el script de subida.
- Nombres en español en código, rutas, variables y comentarios, como CosasStream: `canal`, `espectador`, `relojDeSala`, `/oauth/kick/volver`. Nombres de API externas quedan como son.
- Secretos: nunca en el repo, nunca impresos, nunca pedidos por chat. Se leen de process.env. Si necesitás uno para probar, avisá y esperá.
- Login identifica, no autoriza. Quién es dueño, amigo o pago se decide en la colección `creadores`, no en el login. El dueño es quien se loguea con Kick y cuyo slug coincide con KICK_SLUG.
- Cada webhook de Kick se verifica con RSA (clave pública de api.kick.com/public/v1/public-key) y se deduplica por Kick-Event-Message-Id.
- Cookies HttpOnly, Secure, SameSite=Lax. Sesión del dueño (`sala_dueno`) distinta de la del espectador (`sala_espectador`).
- Commits chicos con mensaje en español que explique qué cambia para el usuario. No hacer push sin que el dueño lo pida.

Cómo trabajar:
- Antes de escribir código de una API externa, leé su documentación oficial actual (Kick Dev API, Twitch EventSub WebSocket y Helix chat, R2 con S3 API). No inventes endpoints.
- Probá en local con `npm run local` (lee servidor/.env si existe) y con curl. Los webhooks reales no llegan a local: escribí fixtures con payloads reales (documentados) y un endpoint de prueba `/api/prueba/webhook` que sólo exista cuando MODO=local.
- Tests con `node --test`, sin librerías.
- Al terminar, agregá una entrada a BITACORA.md con: qué quedó, decisiones tomadas y por qué, archivos tocados, cómo verlo funcionando, qué quedó pendiente. Después hacé el commit.
- Terminá con un resumen corto para el dueño: qué hay, cómo probarlo, qué necesita de él (por ejemplo, cargar una variable en Railway).
```

---

## Fase 0 — Cimientos

```
Fase 0: cimientos del proyecto Sala.

Objetivo: un servidor desplegable en Railway con la base sobre la que se construyen las otras fases. Al final, abrir la raíz muestra una página mínima que dice "Sala" y el estado de conexión al bus SSE; los flujos de OAuth y el webhook existen y están verificados con fixtures, aunque los secretos reales todavía no estén cargados.

Entregables:
1. Estructura del repo:
   - `package.json` con scripts `start` (node servidor/index.js), `local` (node --env-file-if-exists=servidor/.env servidor/index.js), `dev` (igual con --watch), `test` (node --test). Única dependencia: mongodb.
   - `servidor/index.js`: servidor http nativo con enrutador propio. Rutas: `/oauth/kick/entrar`, `/oauth/kick/volver`, `/oauth/twitch/entrar`, `/oauth/twitch/volver`, `/kick/webhook`, `/eventos/:slug` (SSE), `/api/*`. Todo lo demás sirve archivos de `paginas/` con cache como CosasStream (código no-cache, imágenes max-age).
   - `servidor/canales.js`: registro en memoria de canales por slug: conexiones SSE, `relojDeSala`, buffer de últimos 200 mensajes, `difundir(slug, evento)`. Ping cada 25 s.
   - `servidor/almacen.js`: copiado y adaptado de CosasStream (Mongo si hay MONGODB_URI, JSON en servidor/datos/ en local). Colecciones: `creadores`, `tokens`, `sesiones`, `videos`, `reloj`.
   - `servidor/kick.js`: OAuth 2.1 con PKCE (S256), intercambio de código, refresh, `usuarioActual(token)`, `enviarMensaje(token, broadcasterUserId, texto)`, `suscribirEventos(token, broadcasterUserId, urlWebhook)`, app token por client_credentials cacheado.
   - `servidor/webhook.js`: verificación RSA con cache de la clave pública y dedupe por id, copiado de CosasStream.
   - `servidor/twitch.js`: OAuth code flow, refresh, `usuarioActual`, cliente EventSub WebSocket con `ws` nativo de Node 22 (WebSocket global), suscripción a channel.chat.message por sesión, manejo de reconnect_url y keepalive, reconexión con espera creciente; `enviarMensaje(token, broadcasterId, senderId, texto)`. Sin conectar todavía (eso es Fase 1): dejar la clase lista y testeada con un servidor WebSocket falso en el test.
   - `servidor/cifrado.js`: AES-256-GCM con crypto nativo, clave desde CLAVE_CIFRADO (base64, 32 bytes). `cifrar(texto)`, `descifrar(blob)`.
   - `servidor/sesion.js`: cookies firmadas (HMAC con CLAVE_CIFRADO), dos nombres: `sala_dueno` y `sala_espectador`. Sesiones guardadas hasheadas en almacén, como CosasStream.
   - `paginas/index.html`, `paginas/comun/base.css`, `paginas/comun/bus.js` (cliente SSE con reconexión, expone `window.Sala.conectar(slug, alRecibir)`).
   - `herramientas/.env.ejemplo`, `servidor/.env.ejemplo` y `README.md` con: variables de Railway (KICK_SLUG, KICK_CLIENT_ID, KICK_CLIENT_SECRET, TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET, CLAVE_CIFRADO, MONGODB_URI, URL_BASE, MODO), cómo generar CLAVE_CIFRADO, cómo desplegar.
   - `.railwayignore` que excluya herramientas/ y tests.
2. Tests con node --test: verificación RSA con payload de fixture y clave de prueba; cifrar/descifrar ida y vuelta; cookie firmada válida e inválida; enrutador devuelve 404 para rutas desconocidas; cliente EventSub maneja welcome, keepalive y reconnect contra un servidor falso.
3. Deploy en Railway hecho (el dueño conecta el repo; vos dejás todo listo) y la raíz responde.

Qué no hacer: no construir todavía el chat, la sala ni el panel. No agregar dependencias. No escribir UI más allá de la página de estado.

Aceptación: tests verdes, `/eventos/istincho` abre SSE y manda un evento `estado` al conectar, `/oauth/kick/entrar` redirige a id.kick.com con code_challenge, `/kick/webhook` responde 401 a un cuerpo sin firma y 200 al fixture firmado en modo local.
```

---

## Fase 1 — Chat Global

```
Fase 1: Chat Global.

Objetivo: la página /chat, para uso exclusivo del dueño, que muestra en tiempo real el chat de Kick y el de Twitch de su canal, mezclados o en dos columnas, y permite escribir a Kick, a Twitch o a los dos. Se instala como app (PWA) y se usa en una ventana aparte. No es un overlay de OBS.

Leé BITACORA.md: la Fase 0 dejó el servidor, el bus SSE, OAuth de las dos redes, el webhook verificado y el cliente EventSub sin conectar.

Entregables:
1. Login del dueño. `/panel` (mínimo por ahora) con dos botones: "Entrar con Kick" (scopes user:read chat:write events:subscribe) y "Vincular Twitch" (scopes user:read:chat user:write:chat). Guardar refresh tokens cifrados en `tokens`.
2. Suscripciones. Al vincular Kick: suscribir chat.message.sent para el canal del dueño con webhook a /kick/webhook (con el token del dueño). Al vincular Twitch: abrir la conexión EventSub y suscribirse a channel.chat.message (broadcaster_user_id = user_id = el dueño). Al arrancar el servidor, si hay token de Twitch guardado, reconectar solo. Cada 5 minutos: verificar que la suscripción de Kick siga activa y resuscribir si no.
3. Formato único de mensaje que sale por SSE en el canal `chat`:
   { tipo: "chat", red: "kick"|"twitch", id, usuario, color, insignias: [{tipo, texto}], texto, emotes: [{id, inicio, fin, url}], hora, respondeA? }
   Traductores en servidor/mensajes.js: de payload de Kick y de payload de Twitch a este formato. Emotes de Kick con URL https://files.kick.com/emotes/{id}/fullsize; de Twitch con la CDN oficial.
4. Página /chat:
   - Vista mezclada (por defecto) o en dos columnas (?vista=columnas). Filtro por red. Letra grande (?letra=grande). Etiqueta de red con color: Kick verde, Twitch violeta. Pausa automática del scroll cuando el usuario sube; botón "volver abajo" con contador.
   - Caja de escritura con selector Kick / Twitch / Ambos. `POST /api/chat/enviar` con cookie del dueño; el servidor llama a la API correspondiente con el token del dueño. Error visible (por ejemplo, 429).
   - Indicador de salud: última llegada de cada red y estado de la conexión Twitch; si pasan más de 5 minutos sin mensajes de Kick mientras el canal está en vivo (livestream.status.updated), aviso y botón "resuscribir".
   - ?demo=1 muestra mensajes de ejemplo sin servidor, para diseñar.
   - manifest.webmanifest e ícono para instalar como app. Service worker mínimo, sólo para que sea instalable.
5. Buffer: al conectar, el SSE manda los últimos 200 mensajes.
6. Plan B: si la conexión EventSub falla más de 3 veces seguidas, conectar por IRC anónimo (justinfan) a irc.chat.twitch.tv mientras se sigue reintentando EventSub. Aviso visible de en qué modo está.

Qué no hacer: no tocar la Sala, el reloj ni los espectadores. No usar la conexión Pusher no oficial de Kick en esta fase (queda anotada como plan B en PLAN.md).

Aceptación: con las variables cargadas y el dueño vinculado, un mensaje escrito en kick.com y otro en twitch.tv aparecen en /chat en menos de 2 segundos con nombre, color y red correctos; un mensaje escrito en /chat con "Ambos" aparece en las dos plataformas con la cuenta del dueño; /chat?demo=1 se ve completa sin backend; Lighthouse marca la página como instalable. Si las variables no están, dejar todo listo y decirlo.
```

---

## Fase 2 — Sala

```
Fase 2: la Sala.

Objetivo: /sala/istincho funcionando con público real. Tres columnas: izquierda la cámara del dueño (iframe de player.kick.com, muteado), centro el video en HLS con sólo botón de play y sin barra de adelantar (se ve "en directo"), derecha el chat de Kick en tiempo real con caja para escribir y, debajo, botón "Suscribirse" a kick.com/istincho. Sin login se lee; para escribir, login con Kick. En celular se apila: video, cámara chica, chat.

Leé BITACORA.md: la Fase 1 dejó el formato de mensaje, el bus SSE difundiendo y el login del dueño.

Entregables:
1. herramientas/subir.py (Python 3, sólo ffmpeg y boto3): recibe un archivo de video, genera HLS con dos calidades (720p ~2.5 Mbps, 1080p ~5 Mbps), segmentos de 6 segundos, playlist maestra, subtítulos WebVTT si el archivo trae pista, y sube todo a R2 bajo `istincho/<id>/`. Al terminar, avisa al servidor (`POST /api/videos` con una clave de subida generada en /panel) con título, duración y URL de la playlist en r2.dev. `--borrar <id>` elimina de R2 y del almacén. `--listar` muestra qué hay. Credenciales de R2 desde herramientas/.env. Progreso legible.
2. Reloj de sala en servidor/reloj.js: estado por canal { videoId, empezoEn (ms epoch del servidor), pausadoEn (ms o null), offsetInicial }, persistido en la colección `reloj`. `POST /api/sala/:slug/reloj` (solo dueño) con acciones reproducir(videoId), pausar, reanudar, saltar(segundos), detener. Cada cambio se difunde por SSE como { tipo: "reloj", ... }. `GET /api/hora` devuelve la hora del servidor para que el cliente calcule su desfase.
3. Página /sala/:slug:
   - Player con hls.js desde CDN (versión fijada). Calcula posición = (ahora - empezoEn - pausas) y hace seek al conectar; cada 10 s corrige si la deriva supera 1,5 s. Sin controles nativos: sólo play/pausa local (por autoplay bloqueado), volumen, pantalla completa y selector de subtítulos. Si el reloj dice "detenido", pantalla de espera con la cámara grande.
   - Chat: reutiliza el cliente y el render de /chat, filtrado a Kick. Caja de escritura deshabilitada hasta login.
   - Login de espectador: /oauth/kick/entrar?rol=espectador con scopes user:read chat:write; callback guarda refresh cifrado en `tokens` y cookie sala_espectador. Botón "Salir".
   - Envío: `POST /api/sala/:slug/chat` con cookie de espectador. El servidor aplica límite de 1 mensaje cada 2 s por espectador y 500 caracteres, consigue access token (refresca si venció), llama a Kick con broadcaster_user_id del dueño, responde ok o error con motivo. Respetar 429 con espera.
   - Contador de espectadores conectados (conexiones SSE del canal).
4. /panel para el dueño: lista de videos, botones reproducir/pausar/saltar/detener, estado del reloj, espectadores conectados, salud de webhooks y de Twitch, botón para generar/revocar clave de subida.
5. Métricas mínimas: mensajes por hora, envíos, errores 429, espectadores pico. Mostrarlas en /panel.

Qué no hacer: no servir video desde el servidor bajo ninguna circunstancia. No agregar cuentas de otros creadores. No transcodificar en el servidor.

Aceptación: con un archivo de prueba propio subido con el script, dos navegadores distintos muestran el mismo segundo (diferencia menor a 1,5 s) y se resincronizan tras pausar y reanudar desde /panel; desde un navegador con una cuenta secundaria de Kick, un mensaje escrito en la Sala aparece en kick.com/istincho con esa cuenta y vuelve a la Sala por webhook; un espectador sin login puede leer pero no escribir; la vista en celular no tiene scroll horizontal.
```

---

## Fase 3 — Otros creadores

```
Fase 3: Sala para otros creadores.

Objetivo: cualquier streamer de Kick puede crear su propia Sala en /sala/<su-slug>, con su panel, sus videos y su chat. El dueño decide quién entra gratis (amigos) y el proveedor de cobro decide quién está al día (pago).

Leé BITACORA.md y PLAN.md, sección 0 punto 4 (cobro).

Entregables:
1. Alta: /crear. Login con Kick (scopes user:read chat:write events:subscribe). Crea el creador en `creadores` con plan "pendiente", registra su canal en memoria, suscribe chat.message.sent para su canal con su token, y lo manda a /panel. Tope: si hay 900 canales con suscripción, /crear avisa y no crea más (límite de app no verificada en Kick).
2. Multi-canal: todas las rutas y el webhook enrutan por slug o broadcaster_user_id al canal correcto (índice en `creadores`). Twitch es opcional por creador (vincular desde su panel; una conexión EventSub por creador vinculado, con su token).
3. Planes en `creadores`: pendiente | amigo | pago | vencido. Sólo el dueño (KICK_SLUG) puede poner "amigo" o "pendiente" desde /admin (lista de creadores, plan, vencimiento, uso). "pago" y "vencido" los pone el webhook de cobro. Un creador pendiente o vencido ve su panel en modo solo lectura con el botón de suscribirse.
4. Cobro: servidor/cobro.js con interfaz única { crearCheckout(creador), procesarWebhook(request) } y una implementación Paddle (Billing, checkout alojado, webhook con firma verificada). Dejar la interfaz lista para Stripe. Precio y moneda desde variables. Sin claves reales hasta que el dueño las cargue.
5. Subida por creador: /panel genera URL prefirmada de R2 (PUT) para su prefijo `<slug>/`, con tope de GB por plan; herramientas/subir.py acepta `--sala <slug>` y usa las URL prefirmadas en vez del token de R2. Contador de GB usados por creador.
6. Términos: página /terminos que cada creador acepta en /crear (checkbox obligatorio, fecha guardada). Texto en español, claro: el contenido es del creador y responde por él; el servicio puede bajar contenido ante reclamo.
7. Aislamiento: un creador jamás ve el panel, los videos ni los tokens de otro. Tests que lo prueben.

Qué no hacer: no cambiar el formato de mensaje ni el reloj. No agregar base de datos externa. No mover el video a Railway.

Aceptación: con una segunda cuenta de Kick se crea una Sala nueva, se marca como "amigo" desde /admin, sube un video de prueba con URL prefirmada, y su Sala funciona igual que la del dueño sin tocar la del dueño; un creador "pendiente" no puede reproducir; el webhook de Paddle en modo sandbox cambia el plan a "pago"; los tests de aislamiento pasan.
```

---

## Verificador (después de cada fase)

```
Sos el verificador de la Fase N del proyecto Sala. Tu default es que hay un bug.

Leé PLAN.md, AGENTES.md (el prompt de la fase que verificás) y la última entrada de BITACORA.md. Después:
1. Corré `npm test`. Si no hay tests para algo que el prompt pedía, eso es una falla.
2. Recorré cada entregable y cada criterio de aceptación del prompt de la fase y decí, uno por uno, si está cumplido, con evidencia (comando corrido, archivo y línea, salida).
3. Buscá específicamente: secretos en el repo o en logs; video servido por el servidor; rutas sin verificación de firma; tokens guardados sin cifrar; cookies sin HttpOnly/Secure; falta de deduplicación de webhooks; dependencias nuevas; nombres en inglés donde el brief pide español; conexiones SSE que no se limpian al cerrar.
4. Reportá en tres listas: falla (bloquea la fase), duda (hay que preguntar al dueño), ok. Para cada falla, un párrafo con cómo reproducirla.
No arregles nada. No hagas commits.
```

---

## Reglas de traspaso entre fases

- El agente de la fase N no toca lo que la fase N-1 dio por cerrado, salvo que el Verificador lo haya marcado como falla.
- Toda decisión que se aparte de PLAN.md se anota en BITACORA.md con el motivo. Si cambia el plan, se edita PLAN.md en el mismo commit.
- Lo que un agente necesite del dueño (cargar una variable, crear una app, confirmar un precio) va al final de su resumen, en una lista corta y accionable. No se bloquea el resto del trabajo por eso.
