# Sala

Servicio web para un streamer de Kick. Dos cosas:

- **Chat Global**: el chat de Kick y el de Twitch juntos en una ventana aparte, con una caja para escribir a los dos.
- **Sala**: pasar una película o serie en una página propia, con la cámara de Kick al lado y el chat real de Kick a la derecha. Los espectadores se loguean con Kick y lo que escriben cae en el chat de verdad del stream.

Plan completo en [`PLAN.md`](PLAN.md). Qué está hecho, en [`BITACORA.md`](BITACORA.md). Cómo trabajan los agentes, en [`AGENTES.md`](AGENTES.md).

---

## Correr en local

```bash
npm install                      # única dependencia: mongodb
cp servidor/.env.ejemplo servidor/.env
npm run local                    # http://localhost:8778
```

Sin `servidor/.env` el servidor arranca igual: guarda en archivos JSON dentro de `servidor/datos/` y avisa por consola qué le falta. La página de estado (`/`) muestra exactamente eso.

| Script | Qué hace |
|---|---|
| `npm start` | Lo que corre Railway. |
| `npm run local` | Igual, leyendo `servidor/.env` si existe. |
| `npm run dev` | Igual, reiniciando al guardar. |
| `npm test` | Toda la suite, con `node --test`. Sin librerías. |

---

## Variables

Se cargan **desde el dashboard de Railway**, nunca desde la terminal ni desde un archivo en el servidor: el dueño trabaja con la pantalla al aire. Los nombres y para qué sirve cada una están comentados en [`servidor/.env.ejemplo`](servidor/.env.ejemplo).

| Variable | Hace falta para | Si falta |
|---|---|---|
| `KICK_SLUG` | Saber cuál es el canal del dueño | No se reconoce al dueño |
| `URL_BASE` | Armar los redirect de OAuth | Se deduce del pedido, que un cliente puede mentir |
| `MODO` | `local` o `produccion` | Se asume `produccion` |
| `CLAVE_CIFRADO` | Cifrar tokens y firmar cookies | No hay sesiones ni tokens guardados |
| `KICK_CLIENT_ID` / `KICK_CLIENT_SECRET` | Login y chat de Kick | El login de Kick avisa y no arranca |
| `TWITCH_CLIENT_ID` / `TWITCH_CLIENT_SECRET` | Login y chat de Twitch | Ídem |
| `MONGODB_URI` | Guardar de verdad | Guarda en archivos, que en Railway se borran en cada deploy |
| `SALA_DATOS` | Sólo local: dónde deja los archivos JSON cuando no hay Mongo | `servidor/datos/` |

### Generar `CLAVE_CIFRADO`

Son 32 bytes al azar en base64. En PowerShell, sin que aparezcan en pantalla:

```powershell
node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64'))" | Set-Clipboard
```

Queda en el portapapeles: se pega en Railway y listo. **Si se cambia, se caen todas las sesiones y los tokens guardados dejan de poder descifrarse.**

---

## Desplegar

Railway despliega desde `main` en GitHub: cada push es un deploy.

1. Repo `sala` en GitHub, conectado como remoto de esta carpeta.
2. En Railway: New → GitHub Repo → `sala`. Después Settings → Networking → **Generate Domain**.
3. Cargar las variables de la tabla de arriba en Variables.
4. Redeploy para que las tome.

`.railwayignore` deja afuera los tests, las herramientas y la documentación: al contenedor sólo va `servidor/`, `paginas/` y `package.json`.

### Lo que hay que hacer a mano una vez

**La URL del webhook de Kick no se puede registrar por API.** Kick la toma de un campo de texto en el portal del desarrollador: kick.com → Settings → Developer → *Enable Webhooks* → pegar `https://<dominio>/kick/webhook`. Sin ese paso las suscripciones a eventos se crean bien pero no llega ni un webhook, y el chat queda mudo sin ningún error visible.

---

## Cómo está armado

```
servidor/
  index.js      servidor http nativo, enrutador propio, estáticos
  canales.js    un canal por slug: conexiones SSE, reloj, últimos 200 mensajes
  almacen.js    Mongo si hay MONGODB_URI, archivos JSON si no
  cifrado.js    AES-256-GCM para los tokens, HMAC para las cookies
  sesion.js     sala_dueno y sala_espectador, dos cosas separadas
  vinculos.js   los tokens del dueño en cada red, cifrados, y su refresh
  kick.js       OAuth 2.1 + PKCE, chat, suscripción a eventos
  twitch.js     OAuth, Helix, y el cliente EventSub por WebSocket
  irc.js        IRC anónimo de Twitch: el plan B cuando EventSub se cae
  mensajes.js   traduce Kick y Twitch al formato único de mensaje
  chat.js       junta las dos redes, la salud y el envío
  webhook.js    verificación RSA de los webhooks de Kick y deduplicación
  videos.js     el catálogo de películas y la clave de subida (hasheada)
  reloj.js      en qué segundo va cada sala, y las órdenes del panel
  espectadores.js  los tokens de quien entra a ver, y el límite de envío
  metricas.js   mensajes por hora, envíos, 429 y espectadores pico
paginas/
  chat.html     el Chat Global, instalable como app
  sala.html     la Sala: cámara, película y chat
  panel.html    el panel del dueño
  chat/         css y js del chat, más demo.js para ?demo=1
  sala/         css y js de la Sala, más demo.js para ?demo=1
  panel/        css y js del panel
  comun/        base.css, bus.js (cliente SSE) y mensajes.js (el render)
  manifest.webmanifest, sw.js, icono-*.png   lo que hace la PWA instalable
pruebas/        node --test, sin librerías
herramientas/   scripts que corren en la PC del dueño (Fase 2)
```

Reglas que no se negocian:

- **El servidor nunca sirve video.** El navegador le pide los segmentos directo a R2. Si una ruta devolviera un `.m3u8` o un `.ts`, el egreso de Railway se comería el presupuesto del mes en una noche. La otra mitad de la regla la hace cumplir `revisarFicha`: una ficha cuya `url` apunte a nuestro propio dominio (el de `URL_BASE`) o a esta misma máquina se rechaza con 400, porque mandaría a trescientos navegadores a pedirle los segmentos a Railway sin que ninguna ruta tenga la culpa.
- **Login identifica, no autoriza.** Quién es dueño, amigo o pago se decide en la colección `creadores`, no en el login.
- **Todo webhook de Kick se verifica con RSA y se deduplica** por `Kick-Event-Message-Id`.
- Cookies `HttpOnly`, `Secure`, `SameSite=Lax`.
- Sin frameworks ni bundlers. Única dependencia: `mongodb`.
- Nombres en español en código, rutas y comentarios.

---

## Rutas

| Ruta | Qué es |
|---|---|
| `/` | Página de estado: si el servidor está vivo y conectado al bus |
| `/chat` | **Chat Global**: Kick y Twitch juntos, con caja para escribir a los dos. Se instala como app |
| `/panel` | Panel del dueño: entrar con Kick, vincular Twitch, ver la salud, manejar la película y la clave de subida |
| `/sala/:slug` | **La Sala**: cámara, película en HLS y chat de Kick. Da 404 si el canal no existe |
| `/eventos/:slug` | SSE. Manda un evento `estado` apenas te conectás, y un ping cada 25 s. `HEAD` contesta y no abre stream. **El slug tiene que ser el del dueño o el de un creador dado de alta**: cualquier otro da 404 |
| `/api/estado` | JSON con modo, almacén, canales y qué variables faltan |
| `/oauth/kick/entrar` · `/oauth/kick/volver` | Login con Kick (OAuth 2.1 + PKCE) |
| `/oauth/twitch/entrar` · `/oauth/twitch/volver` | Vinculación de Twitch |
| `/kick/webhook` | Eventos de Kick. 401 si la firma no da |
| `/api/chat/salud` | Cómo está cada red. Pide cookie de dueño |
| `/api/chat/enviar` | Manda un mensaje a Kick, a Twitch o a los dos. Pide cookie de dueño |
| `/api/chat/resuscribir` | Vuelve a crear las suscripciones de Kick. Pide cookie de dueño |
| `/api/hora` | La hora del servidor, y nada más. Con esto cada navegador mide su desfase y calcula en qué segundo va la peli |
| `/api/videos` | `POST` guarda una ficha (cabecera `X-Clave-Subida`); la `url` tiene que ser `https`, terminar en `.m3u8` y **no ser la nuestra**. `GET` lista **siempre el catálogo del dueño**: no hay parámetro que lo cambie |
| `/api/videos/:id` | `DELETE` borra la ficha (misma cabecera). Un 404 no es error para el script |
| `/api/sala/:slug/reloj` | Play, pausa, reanudar, saltar y detener. Cookie de dueño |
| `/api/sala/:slug/chat` | El mensaje de un espectador, que sale en kick.com con SU cuenta. Cookie de espectador. Hasta la Fase 3, sólo la sala del dueño: cualquier otra da 503, porque el mensaje se rutea al canal vinculado y ése es el suyo |
| `/api/sala/:slug/yo` | Si esta persona entró y si puede escribir. Nunca la lista de quién está en la sala |
| `/api/sala/:slug/salir` | Cierra la sesión del espectador y **olvida su token**: el refresh token es de esa persona, no del dueño |

Las cuatro rutas de `/api/sala/:slug/` dan 404 si el slug no es el del dueño ni el de un creador dado de alta, igual que `/eventos/:slug` y `/sala/:slug`.
| `/api/panel` | Todo lo que muestra `/panel` en un pedido: salud, reloj, videos, métricas, clave. Cookie de dueño |
| `/api/panel/clave` | `POST` genera la clave de subida (se devuelve una sola vez), `DELETE` la revoca |
| `/api/prueba/webhook` | **Sólo con `MODO=local`.** Inyecta un evento sin firma, para desarrollar sin webhooks reales. Con `?tipo=chat.message.sent` entra por el mismo camino que uno real y sale traducido como `chat` |

### Cómo sale un evento por SSE

Todo evento va como el `message` por defecto, con el tipo **adentro del `data`**:

```
id: 7
data: {"tipo":"chat","red":"kick","id":"01JG…","usuario":"unaespectadora","texto":"hola","hora":"2026-09-06T19:31:00.477Z"}
```

No como `event: <tipo>`. Por la especificación de SSE, un evento con nombre sólo llega al listener de ese nombre y nunca dispara `message`: el cliente no puede suscribirse a un tipo que todavía no existe. Con el tipo adentro del `data`, `window.Sala.conectar(slug, (tipo, datos) => …)` recibe cualquier cosa que difunda el servidor, incluidos los tipos que agreguen las fases siguientes.

Los tipos que existen hoy: `estado` (al conectarse), `chat` (un mensaje, en el formato único), `reloj` (en qué segundo va la película) y `presencia` (cuánta gente está mirando).

**Lo que NO sale por el bus: la salud.** El bus de un canal es público —lo escucha cualquiera que esté mirando la peli— y la salud dice si el dueño tiene vinculada cada red y en qué modo está su conexión. Eso se pide contra `/api/chat/salud`, que exige la cookie del dueño.

### Qué redes ve cada conexión

`/eventos/:slug` **sin sesión manda sólo Kick**. Con la cookie del dueño manda las dos redes.

Por el canal del dueño viaja también su chat de Twitch, porque `/chat` los muestra juntos. Pero ese bus no pide sesión, y desde la Fase 2 lo escucha cualquiera que abra la Sala a ver la película: esa gente no tiene nada que ver con la comunidad de Twitch del streamer, ni al revés.

Se filtra **en el servidor y por conexión** (`canales.js`, `leDaEl`), no en el navegador: filtrando en el navegador, el chat de Twitch igual saldría por el cable hacia trescientas pestañas y un `curl /eventos/istincho` lo vería entero. La página de la Sala **no** vuelve a filtrar, a propósito: si lo hiciera, una regresión en esa puerta sería invisible. Una sola fuente de verdad, y es el servidor.

### El formato único de mensaje

```json
{
  "tipo": "chat", "red": "kick",
  "id": "01JG…", "usuario": "unaespectadora", "color": "#ff5733",
  "insignias": [{ "tipo": "moderator", "texto": "Moderator" }],
  "texto": "que peli mas larga HYPERCLAP",
  "emotes": [{ "id": "4148074", "inicio": 19, "fin": 28, "url": "https://files.kick.com/emotes/4148074/fullsize" }],
  "hora": "2026-01-14T16:08:06.000Z"
}
```

`inicio` y `fin` cuentan **puntos de código Unicode** sobre `texto`, y el emote ocupa `[inicio, fin)`. Se corta con `[...texto]`, nunca con `texto.slice`: un índice de string cuenta unidades UTF-16, y un solo emoji antes de un emote corre de lugar todos los que vengan después.

### El indicador de salud

`GET /api/chat/salud` (cookie de dueño) contesta:

```json
{
  "kick":   { "vinculado": true, "ultima": "2026-01-14T16:08:06.000Z",
              "suscripcion": "activa", "vivo": true, "sospechoso": false },
  "twitch": { "vinculado": true, "ultima": "…", "estado": "conectado", "modo": "eventsub" },
  "ahora":  "2026-01-14T16:09:00.000Z"
}
```

Dos cosas para no romper:

- **`sospechoso` es un veredicto, no un dato.** Vale `true` cuando el canal está en vivo y hace más de cinco minutos que no llega un mensaje de Kick (nunca haber recibido ninguno cuenta como silencio: es justo el caso de la URL del webhook sin cargar). La regla vive en `chat.kickSospechoso()` y en ningún otro lado; la página muestra el veredicto y no lo recalcula. Antes lo calculaba por su cuenta con una regla distinta y el aviso no aparecía nunca en el único caso para el que existe.
- **`vivo` sale de la API de Kick** (`GET /public/v1/channels`), consultado en el mismo ciclo de cinco minutos que las suscripciones y cacheado hasta la vuelta siguiente. El webhook `livestream.status.updated` sigue siendo la vía rápida, pero no puede ser la fuente: avisa sólo las transiciones, así que un deploy en medio del stream —o sea, la forma normal de trabajar acá— dejaría `vivo` en `false` el resto de la noche.

El aviso grande de `/chat` se puede cerrar. Cerrado se queda cerrado mientras la condición siga igual; si se resuelve y vuelve a aparecer, el aviso vuelve.

### El plan B de Twitch

Después de más de tres fallos seguidos de EventSub se abre el IRC anónimo (`justinfan`, sólo lectura) y se apaga en cuanto EventSub vuelve. Mientras los dos están prendidos llegan mensajes repetidos: el dedupe es por id, que es el mismo por las dos vías. El modo aparece en la salud (`modo: "irc"`), así que se ve en pantalla.

Las dos conexiones de Twitch se crean a través de `chat.fijarConexiones()`, que existe para los tests: `ConexionEventSub` acepta `url` y `ConexionIrc` acepta `abrirSocket`, y así la orquestación (cuándo se prende, cuándo se apaga) se prueba sin salir a internet ni esperar los backoff de verdad.

---

## La Sala

`/sala/:slug` es tres columnas en escritorio —cámara, película, chat— y en celular se apila: video, cámara chica, chat. La regla que manda sobre el layout: **nunca hay scroll horizontal**.

### El reloj de sala

El servidor **no manda "andá al segundo 812"**. Guarda cuatro números por canal y los difunde una vez por cambio:

```json
{ "tipo": "reloj", "estado": "reproduciendo",
  "videoId": "s01e03", "empezoEn": 1788742760001,
  "pausadoEn": null, "offsetInicial": 0,
  "url": "https://pub-….r2.dev/istincho/s01e03/maestra.m3u8",
  "titulo": "S01E03", "duracion": 2712, "subtitulos": [],
  "posicion": 812.4, "ahora": 1788743572000 }
```

Cada navegador hace la cuenta:

```
corriendo:  offsetInicial + (ahora − empezoEn) / 1000
pausado:    offsetInicial + (pausadoEn − empezoEn) / 1000
```

con `ahora` corregido por el desfase que midió contra `/api/hora`. Trescientas personas cuestan trescientas conexiones SSE abiertas y **ni un byte de video por Railway**.

**`posicion` y `ahora` son una foto, no la fuente.** El reloj le llega al que se conecta adentro del evento `estado`, y ese objeto está guardado en el canal desde que se tocó play: su `posicion` puede tener horas de viejo. La página los muestra y los ignora para calcular. Hay una prueba que lo hace cumplir.

**Por qué `empezoEn` y no "el segundo actual":** guardando el momento en que arrancó el tramo, el estado no cambia mientras la película corre, así que sólo se escribe cuando alguien toca un botón. Un deploy en el medio —que acá es la forma normal de trabajar— no pierde nada, porque `empezoEn` es una fecha absoluta.

### Cómo corrige la deriva

Cada 10 s se compara `video.currentTime` con el objetivo y se salta si la diferencia pasa de **1,5 s**. Con tres guardas, y cada una evita un salto que se ve:

- si la persona pausó a mano, es su pantalla;
- si el video está buscando o todavía no tiene datos (`readyState < 3`), la deriva que se mide es el buffer, no la deriva;
- después de corregir se dan 5 s, porque un seek tarda en asentarse y volver a medir enseguida encadena saltos.

Medido con dos navegadores contra el servidor de verdad: **0,04 s de diferencia** entre los dos, y **0,51 s** después de pausar, saltar 300 s y reanudar desde el panel.

El botón ▶ **no arranca nada por su cuenta**: existe porque el navegador puede no dejar reproducir sin un gesto, no para pelearse con el reloj. Con la sala en pausa, tocarlo levanta la pausa local, deja el video quieto y avisa que la sala está en pausa; si arrancara, la película correría unos segundos y la corrección de los 10 s la tironearía para atrás, que es exactamente el salto que la persona no entiende. Cuando la sala reanuda, esa pantalla arranca sola.

Y la medición del desfase (`/api/hora`, tres muestras, se elige la del viaje más corto) **no bloquea el arranque de la página**: se conecta al bus primero y el desfase se acomoda cuando llega, con un corte de 3 s por pedido. Antes era un `await` sin timeout: un `/api/hora` colgado dejaba la sala sin bus, o sea sin reloj y sin chat, y sin un solo error a la vista.

Además: Chrome **pausa solo** el video mudo de una pestaña que no se ve, y al volver no lo arranca. Por eso hay un `visibilitychange` que resincroniza y vuelve a reproducir; sin él, quien se va a otra pestaña media hora vuelve a una película congelada media hora atrás.

### hls.js

Se carga desde jsDelivr con la **versión clavada** (`1.5.17`) y con `integrity`. Clavada porque un `latest` es código de un tercero que puede cambiar solo en medio de una película; con `integrity` porque un CDN comprometido serviría un script con permisos completos sobre la página. Si se sube de versión hay que recalcular el hash:

```bash
curl -sL https://cdn.jsdelivr.net/npm/hls.js@<version>/dist/hls.min.js | openssl dgst -sha384 -binary | openssl base64 -A
```

Si el CDN no responde, la página lo dice y prueba con el HLS nativo del navegador (Safari y iOS lo tienen).

### El espectador

Entra con `/oauth/kick/entrar?rol=espectador` (scopes `user:read chat:write`). Se le guarda **lo mínimo**: su `user_id`, su nombre y sus tokens cifrados. El refresh token hace falta de verdad —el access dura una hora y una película dura dos y media—, y **"Salir" lo borra**, no sólo tira la cookie.

Al escribir, `POST /api/sala/:slug/chat` pasa por tres frenos en este orden:

1. el tope de Kick (500 caracteres / 2048 bytes), antes de gastar un pedido en algo que va a rebotar;
2. la espera del **canal**, si Kick nos frenó hace poco: el 429 es del canal, no de la persona, y seguir mandando sólo consigue más;
3. la espera de la persona: **uno cada dos segundos**.

Debajo del chat hay un **"Suscribirse"**: es un link a `https://kick.com/<canal>/subscribe`, se abre en otra pestaña (`rel="noopener noreferrer"`, así la película sigue corriendo acá) y no hay nada que cobrar de este lado.

El mensaje **no se difunde por el bus**: vuelve por el webhook como cualquier otro. Pintarlo al enviarlo lo mostraría dos veces y encima mentiría si Kick lo retuvo.

### La clave de subida

`herramientas/subir.py` corre en una terminal, no en un navegador: se autentica con la cabecera **`X-Clave-Subida`** y no con una cookie. La clave se genera y se revoca desde `/panel`, y se guarda **hasheada** (SHA-256), como las sesiones: un volcado de la base no deja subir ni borrar nada. La comparación es `timingSafeEqual`.

La clave autoriza **una sola sala**: si el JSON dice otro `slug`, el servidor contesta 403.

**No se muestra en pantalla.** El dueño trabaja con la transmisión al aire, así que el panel la copia al portapapeles y sólo la muestra si alguien toca "Mostrar igual", con el aviso al lado.

**Borrar el video que se está pasando detiene el reloj.** Si no, la sala se queda pidiendo segmentos que ya no existen en R2: el player no falla con un error claro, se queda cargando para siempre.

### Las métricas

Mensajes por hora (anillo de 24 casilleros con marca de hora, así el de las 3 de la mañana de hoy no se suma al de ayer), envíos, errores 429 y espectadores pico. **Viven en memoria** y se dicen así en pantalla: una escritura en Mongo por cada mensaje del chat, todas las noches, para un número que se mira una vez, no se paga. Un despliegue las pone en cero.
