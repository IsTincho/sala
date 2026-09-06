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
paginas/
  chat.html     el Chat Global, instalable como app
  panel.html    el panel del dueño (mínimo: entrar y vincular)
  chat/         css y js del chat, más demo.js para ?demo=1
  manifest.webmanifest, sw.js, icono-*.png   lo que hace la PWA instalable
pruebas/        node --test, sin librerías
herramientas/   scripts que corren en la PC del dueño (Fase 2)
```

Reglas que no se negocian:

- **El servidor nunca sirve video.** El navegador le pide los segmentos directo a R2. Si una ruta devolviera un `.m3u8` o un `.ts`, el egreso de Railway se comería el presupuesto del mes en una noche.
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
| `/panel` | Panel del dueño: entrar con Kick, vincular Twitch, ver la salud |
| `/eventos/:slug` | SSE. Manda un evento `estado` apenas te conectás, y un ping cada 25 s. `HEAD` contesta y no abre stream. **El slug tiene que ser el del dueño o el de un creador dado de alta**: cualquier otro da 404 |
| `/api/estado` | JSON con modo, almacén, canales y qué variables faltan |
| `/oauth/kick/entrar` · `/oauth/kick/volver` | Login con Kick (OAuth 2.1 + PKCE) |
| `/oauth/twitch/entrar` · `/oauth/twitch/volver` | Vinculación de Twitch |
| `/kick/webhook` | Eventos de Kick. 401 si la firma no da |
| `/api/chat/salud` | Cómo está cada red. Pide cookie de dueño |
| `/api/chat/enviar` | Manda un mensaje a Kick, a Twitch o a los dos. Pide cookie de dueño |
| `/api/chat/resuscribir` | Vuelve a crear las suscripciones de Kick. Pide cookie de dueño |
| `/api/prueba/webhook` | **Sólo con `MODO=local`.** Inyecta un evento sin firma, para desarrollar sin webhooks reales. Con `?tipo=chat.message.sent` entra por el mismo camino que uno real y sale traducido como `chat` |

### Cómo sale un evento por SSE

Todo evento va como el `message` por defecto, con el tipo **adentro del `data`**:

```
id: 7
data: {"tipo":"chat","red":"kick","id":"01JG…","usuario":"unaespectadora","texto":"hola","hora":"2026-09-06T19:31:00.477Z"}
```

No como `event: <tipo>`. Por la especificación de SSE, un evento con nombre sólo llega al listener de ese nombre y nunca dispara `message`: el cliente no puede suscribirse a un tipo que todavía no existe. Con el tipo adentro del `data`, `window.Sala.conectar(slug, (tipo, datos) => …)` recibe cualquier cosa que difunda el servidor, incluidos los tipos que agreguen las fases siguientes.

Los tipos que existen hoy: `estado` (al conectarse), `chat` (un mensaje, en el formato único) y `reloj` (Fase 2).

**Lo que NO sale por el bus: la salud.** El bus de un canal es público —en la Fase 2 lo escucha cualquiera que esté mirando la peli— y la salud dice si el dueño tiene vinculada cada red y en qué modo está su conexión. Eso se pide contra `/api/chat/salud`, que exige la cookie del dueño.

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
