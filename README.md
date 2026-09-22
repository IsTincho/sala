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
| `ORIGENES` | **Los otros dominios desde los que se sirve este sitio**, separados por coma (hoy: el de Cloudflare Pages). Con eso se aceptan sus POST y se arman sus redirect de OAuth | Sólo vale `URL_BASE`: desde el otro dominio, escribir da 403 y el login termina en el dominio de Railway |
| `MODO` | `local` o `produccion` | Se asume `produccion` |
| `CLAVE_CIFRADO` | Cifrar tokens y firmar cookies | No hay sesiones ni tokens guardados |
| `KICK_CLIENT_ID` / `KICK_CLIENT_SECRET` | Login y chat de Kick | El login de Kick avisa y no arranca |
| `TWITCH_CLIENT_ID` / `TWITCH_CLIENT_SECRET` | Login y chat de Twitch | Ídem |
| `MONGODB_URI` | Guardar de verdad | Guarda en archivos, que en Railway se borran en cada deploy |
| `SALA_DATOS` | Sólo local: dónde deja los archivos JSON cuando no hay Mongo | `servidor/datos/` |

Y las de la Fase 3, que son las que hacen que un creador que no sea el dueño pueda subir y pagar:

| Variable | Hace falta para | Si falta |
|---|---|---|
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | **Firmar las URL de subida** de cada creador | Nadie puede subir un video: `POST /api/subida` contesta 503 y dice cuál falta |
| `R2_URL_PUBLICA` | Armar la URL pública del video (`https://pub-….r2.dev`) | Lo mismo que las otras cuatro: 503 con el nombre de la variable, **antes** de subir un byte. Hasta la Fase 3 esta faltaba en la comprobación, así que la subida arrancaba igual y el error aparecía una hora después, al guardar la ficha, como un `400 url invalida` que no nombra ninguna variable |
| `COBRO_PROVEEDOR` | Elegir la implementación de cobro | Se asume `paddle` |
| `PADDLE_API_KEY`, `PADDLE_PRECIO_ID` | Crear el checkout | El botón de suscribirse lo dice y no rompe nada |
| `PADDLE_CLAVE_WEBHOOK` | Verificar el aviso de pago | El plan nunca pasa a "pago": se cobra y no se habilita |
| `PADDLE_ENTORNO` | `sandbox` o `produccion` | Se asume `sandbox`: el descuido rompe una prueba, no cobra de verdad |
| `PRECIO_MENSUAL`, `MONEDA` | El precio que se **muestra** en el panel | El botón dice "Suscribirme" sin número |
| `GB_AMIGO`, `GB_PAGO` | Cuánto espacio da cada plan | 2 GB y 5 GB |
| `TOPE_CANALES` | Cuántas salas se admiten (tope de Kick) | 900 |
| `TOPE_TWITCH` | Cuántas conexiones EventSub sostiene el proceso | 50 |

> **El token de R2 pasó a ser una variable de Railway, y hasta la Fase 2 no lo era.**
> Hasta acá el único que subía era el dueño, con su script y su token en `herramientas/.env`. Desde que sube cualquier creador, no se le puede dar el token del bucket: con él leería, pisaría y borraría los videos de todos. La forma de dar permiso acotado es una **URL prefirmada**, y firmar es, por definición, tener el secreto. Lo que **no** cambia es que el video no pasa por Railway: el servidor firma una URL de unos cientos de bytes y los gigas van del creador a R2 y de R2 al espectador, directo.
>
> Conviene que el token de Railway sea **otro**, con permiso *Object Read & Write* sobre el bucket y nada más. El de la PC del dueño puede quedar como está.

**El precio que se muestra y el que se cobra son dos cosas.** `PRECIO_MENSUAL` y `MONEDA` son la etiqueta del botón; lo que se cobra es lo que esté cargado en Paddle. Es lo único del cobro que puede quedar desincronizado, y está anotado también arriba de `precio()` en `servidor/cobro.js`.

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

### El dominio lindo, delante de Railway

`cloudflare/multichat/_worker.js` es un Worker de Cloudflare Pages que **reenvía todo** al servidor de Railway, SSE incluido, y reescribe el `Location` de las redirecciones. No sirve nada propio: así el dominio de Cloudflare y el de Railway muestran exactamente lo mismo y hay una sola fuente de verdad.

Para el navegador, eso son **dos sitios**, con dos juegos de cookies. Para el servidor son un proceso solo, y el dominio de verdad llega en `X-Forwarded-Host`. De ahí sale `ORIGENES`, que es la lista **explícita** de los dominios que son nuestros y se usa para dos cosas que no pueden contradecirse:

- **CSRF**: los POST del espectador exigen que el `Origin` sea uno de esa lista.
- **Los redirect de OAuth**: el login vuelve al **mismo dominio donde empezó**. Si volviera siempre al de `URL_BASE`, quien entra desde el dominio lindo terminaría el login en Railway, con la cookie puesta ahí, y al volver al link que tenía abierto no estaría conectado.

> **Un dominio en `ORIGENES` tiene que estar también registrado como redirect en la app de Kick y en la de Twitch** (`<dominio>/oauth/kick/volver` y `<dominio>/oauth/twitch/volver`), o el login desde ahí rebota del lado de ellos. Está anotado en `TAREAS-DUENO.md`.

Sin `ORIGENES`, todo sigue como antes: sólo vale `URL_BASE`.

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
  vinculos.js   los tokens de cada sala en cada red, cifrados, y su refresh
  creadores.js  quién tiene sala, con qué plan, y de qué sala es cada evento
  cobro.js      la interfaz de cobro (dos funciones) y el registro de proveedores
  cobro-paddle.js  Paddle Billing: checkout alojado y webhook firmado
  r2.js         SigV4 a mano: firma las URL de subida y borrado de cada creador
  kick.js       OAuth 2.1 + PKCE, chat, suscripción a eventos
  twitch.js     OAuth, Helix, y el cliente EventSub por WebSocket
  irc.js        IRC anónimo de Twitch: el plan B cuando EventSub se cae
  mensajes.js   traduce Kick y Twitch al formato único de mensaje
  chat.js       junta las dos redes, la salud y el envío
  webhook.js    verificación RSA de los webhooks de Kick y deduplicación
  videos.js     el catálogo de películas y la clave de subida (hasheada)
  reloj.js      en qué segundo va cada sala, y las órdenes del panel
  espectadores.js  la cuenta de quien entra a ver (Kick y/o Twitch) y el límite de envío
  envio.js      el mensaje de un espectador camino a Kick y a Twitch
  origenes.js   de qué dominios es este sitio: CSRF y redirect de OAuth
  metricas.js   mensajes por hora, envíos, 429 y espectadores pico
paginas/
  chat.html     el Chat Global, instalable como app; en /chat/<slug>, el chat abierto de una sala
                (la misma página: ahí la caja de escribir es la del espectador)
  sala.html     la Sala: cámara, película y chat
  panel.html    el panel de cada creador (el dueño incluido)
  crear.html    el alta: los términos y el botón de entrar con Kick
  terminos.html el texto que se acepta al crear la sala
  admin.html    la lista de creadores. Sólo la sirve el dueño del servicio
  chat/         css y js del chat, más demo.js para ?demo=1
  sala/         css y js de la Sala, más demo.js para ?demo=1
  panel/        css y js del panel
  crear/        css y js de /crear
  admin/        css y js de /admin
  comun/        base.css, bus.js (cliente SSE) y mensajes.js (el render)
  manifest.webmanifest, sw.js, icono-*.png   lo que hace la PWA instalable
pruebas/        node --test, sin librerías
herramientas/   scripts que corren en la PC del dueño (Fase 2)
cloudflare/     el Worker de Pages que pone un dominio lindo delante de Railway
```

Reglas que no se negocian:

- **El servidor nunca sirve video.** El navegador le pide los segmentos directo a R2. Si una ruta devolviera un `.m3u8` o un `.ts`, el egreso de Railway se comería el presupuesto del mes en una noche. La otra mitad de la regla la hace cumplir `revisarFicha`: una ficha cuya `url` apunte a nuestro propio dominio (el de `URL_BASE`) o a esta misma máquina se rechaza con 400, porque mandaría a trescientos navegadores a pedirle los segmentos a Railway sin que ninguna ruta tenga la culpa.
- **Login identifica, no autoriza.** Quién es amigo, pago o pendiente se decide en la colección `creadores`, no en el login. Y **quién es el dueño del servicio no se decide ahí tampoco**: se compara el slug contra `KICK_SLUG`, una variable de entorno, así que ni un volcado de Mongo ni un bug de escritura pueden degradarlo ni ascender a nadie.
- **"Dueño" quiere decir dos cosas y no se mezclan.** *Dueño de una sala* es cualquier creador en la suya, y es lo que identifica la cookie `sala_dueno`. *Dueño del servicio* es el de `KICK_SLUG`: el único que entra a `/admin` y el único que regala el plan "amigo".
- **Cada sala es un inquilino.** El slug con el que se lee o se escribe sale **siempre de la cookie o del camino de la URL**, nunca de un parámetro. No hay ninguna ruta de `/api/panel` que acepte un slug, y las de `/api/sala/:slug` comprueban que la sesión sea la de *esa* sala.
- **Todo webhook de Kick se verifica con RSA y se deduplica** por `Kick-Event-Message-Id`.
- Cookies `HttpOnly`, `Secure`, `SameSite=Lax`. Los POST del espectador piden **además** que el `Origin` sea uno de los nuestros (`URL_BASE` + `ORIGENES`): son los que hacen que alguien escriba con su nombre en el chat de un tercero.
- Sin frameworks ni bundlers. Única dependencia: `mongodb`.
- Nombres en español en código, rutas y comentarios.

---

## Rutas

| Ruta | Qué es |
|---|---|
| `/` | Página de estado: si el servidor está vivo y conectado al bus |
| `/chat` | **Chat Global**: Kick y Twitch juntos, con caja para escribir a los dos. Se instala como app |
| `/chat/:slug` | **El chat abierto de una sala**: la misma página que `/chat`, para la comunidad del creador. **Leer no pide login**: las redes que el creador eligió, mezcladas en vivo, sin la salud (que es de la cuenta del creador). **Escribir pide conectar la cuenta propia**: "Conectar Kick" y "Conectar Twitch", y el selector muestra sólo las redes que la persona conectó Y que el creador abrió (con las dos, aparece "las dos"). Si el creador no lo abrió dice "este chat está cerrado" y se vuelve a fijar sola cada 30 s. **404 si la sala no existe**, igual que `/sala/:slug`. Se sirve `chat.html` con `<base href="/">` y sin el manifest del creador; `/chat` a secas sale byte por byte igual. No va como fuente en OBS si se transmite a Twitch (reglas de simulcast) |
| `/panel` | Panel de **cada creador**: entrar con Kick, vincular Twitch, ver la salud, manejar la película, la clave de subida y el plan. Con un plan sin reproducción se ve en modo sólo lectura, con el botón de suscribirse |
| `/crear` | El alta. Aceptar los términos y entrar con Kick: crea la sala con plan "pendiente" |
| `/terminos` | El texto que se acepta al crear la sala |
| `/admin` | La lista de creadores, su plan y su uso. **Da 404 a todo el que no sea el dueño del servicio**: un 403 ya anunciaría que existe |
| `/sala/:slug` | **La Sala**: cámara, película en HLS y chat de Kick. Da 404 si el canal no existe |
| `/eventos/:slug` | SSE. Manda un evento `estado` apenas te conectás, y un ping cada 25 s. `HEAD` contesta y no abre stream. **El slug tiene que ser el del dueño o el de un creador dado de alta**: cualquier otro da 404. Qué redes manda depende de quién pregunta y del chat abierto de la sala (ver "Qué redes ve cada conexión"). `?redes=kick` pide menos, nunca más |
| `/api/estado` | JSON con modo, almacén, canales y qué variables faltan |
| `/oauth/kick/entrar` · `/oauth/kick/volver` | Login con Kick (OAuth 2.1 + PKCE) |
| `/oauth/twitch/entrar` · `/oauth/twitch/volver` | Vinculación de Twitch. Con `?rol=espectador` es el login de un espectador y pide **sólo `user:write:chat`**: leer entra con el token del creador. El rol viaja en el `state` del servidor, nunca en la query del callback. **Mismo redirect** en los dos casos |
| `/kick/webhook` | Eventos de Kick. 401 si la firma no da. **Se rutea a la sala del `broadcaster_user_id`** (y en su defecto del `channel_slug`); lo que no se pueda atribuir a una sala que existe se descarta |
| `/cobro/webhook` | Los avisos del proveedor de cobro, con la firma verificada. Es lo único que pone los planes "pago" y "vencido" |
| `/api/chat/salud` | Cómo está cada red **de la sala de quien pregunta**. Pide cookie de creador |
| `/api/chat/enviar` | Manda un mensaje a Kick, a Twitch o a los dos, con la cuenta de quien pide. Pide cookie de creador |
| `/api/chat/resuscribir` | Vuelve a crear las suscripciones de Kick de su sala. Pide cookie de creador |
| `/api/chat/:slug/abierto` | `GET` público: `{ abierto, redes }`. Cerrado contesta `redes: []`: de un chat cerrado no se cuenta nada. 404 si la sala no existe. Contesta de la misma memoria que usa el filtro del bus |
| `/api/chat/:slug/yo` | `GET` con cookie de espectador: qué redes conectó esa persona y en cuáles puede escribir **acá** (lo suyo cruzado con lo que el creador abrió). Habla del que pregunta y de nadie más |
| `/api/chat/:slug/enviar` | `POST { red: "kick" \| "twitch" \| "ambas", texto }` con cookie de espectador **y `Origin` propio**. Mismos frenos que `/api/sala/:slug/chat`, y **"ambas" cuenta como un solo mensaje**. 403 si el chat está cerrado, si esa red no está abierta o si la persona no la conectó. El resultado viene **por red**: `{ ok, kick: {ok, motivo}, twitch: {ok, motivo} }` |
| `/api/espectador/salir` | `POST` con `Origin` propio: cierra la sesión y **borra los tokens de las dos redes**. Sin slug: la cuenta de espectador es del dominio, no de una sala |
| `/api/hora` | La hora del servidor, y nada más. Con esto cada navegador mide su desfase y calcula en qué segundo va la peli |
| `/api/videos` | `POST` guarda una ficha (cabecera `X-Clave-Subida`); la `url` tiene que ser `https`, terminar en `.m3u8` y **no ser la nuestra**. La clave autoriza **una sola sala**. `GET` lista el catálogo **de la sala de la cookie o de la clave**: no hay parámetro que lo cambie |
| `/api/videos/:id` | `DELETE` borra la ficha (misma cabecera). Un 404 no es error para el script |
| `/api/sala/:slug/reloj` | Play, pausa, reanudar, saltar y detener. Cookie del dueño **de esa sala**, y **402 si su plan no reproduce** |
| `/api/sala/:slug/chat` | El mensaje de un espectador, que sale en kick.com con SU cuenta, **en el canal de esa sala**. Cookie de espectador. 503 sólo si esa sala todavía no vinculó Kick |
| `/api/sala/:slug/yo` | Si esta persona entró y si puede escribir. Nunca la lista de quién está en la sala |
| `/api/sala/:slug/salir` | Cierra la sesión del espectador y **olvida su token**: el refresh token es de esa persona, no del dueño |

| `/api/panel` | Todo lo que muestra `/panel` en un pedido: plan, salud, reloj, videos, métricas, clave, uso de R2 y el chat abierto (`chatAbierto: { activo, redes }`). El link del chat abierto no viaja: lo arma la página con el origen desde el que se la mira. Cookie de creador |
| `/api/panel/clave` | `POST` genera la clave de subida de su sala (se devuelve una sola vez), `DELETE` la revoca |
| `/api/panel/twitch` | `DELETE` desvincula Twitch de su sala: cierra la conexión y borra el token |
| `/api/panel/suscribirse` | `POST` devuelve la URL del checkout del proveedor de cobro |
| `/api/panel/chat` | `POST { activo?, redes? }` abre o cierra el chat abierto de **su** sala y elige las redes (`kick`, `twitch` o las dos). Lo que no viene queda como estaba; una red desconocida o una lista vacía da 400. **El slug sale de la cookie**: un `slug` en el cuerpo no se lee. Entra en todos los planes. Vale en el acto para la gente conectada y se avisa por el bus (`chat-abierto`) |
| `/api/subida` | `POST` firma las URL de subida a R2 de su prefijo `<slug>/<id>/`. **402 si su plan no sube, 409 si no entra en su tope de GB.** Acepta la cookie **o** la cabecera `X-Clave-Subida`: el script corre en una terminal |
| `/api/subida/borrar` | `POST` firma los DELETE de todo lo que haya bajo `<slug>/<id>/`. Misma autenticación |
| `/api/admin/creadores` | La lista con plan, vencimiento y uso. Sólo el dueño del servicio |
| `/api/admin/plan` | `POST {slug, plan}`. **Sólo acepta "amigo" y "pendiente"**: los otros dos los pone el webhook de cobro |
| `/api/prueba/webhook` | **Sólo con `MODO=local`.** Inyecta un evento sin firma, para desarrollar sin webhooks reales. Con `?tipo=chat.message.sent` entra por el mismo camino que uno real y sale traducido como `chat` |

Las cuatro rutas de `/api/sala/:slug/` dan 404 si el slug no es el del dueño del servicio ni el de un creador dado de alta, igual que `/eventos/:slug` y `/sala/:slug`. Y las cuatro contestan **la sala primero y la cookie después**: un pedido sin sesión a una sala que no existe da 404 y no 401, porque "¿existe esta sala?" es un hecho sobre la sala y ya se puede averiguar con un `GET /sala/<slug>`.

---

## Otros creadores

Cualquier streamer de Kick entra por `/crear`, acepta los términos y se loguea. Su sala queda en `/sala/<su-slug>` con plan **pendiente**: se abre, se lee el chat, y no reproduce.

| Plan | Quién lo pone | Reproduce | GB |
|---|---|---|---|
| `pendiente` | El alta | No | 0 |
| `amigo` | El dueño, desde `/admin` | Sí | `GB_AMIGO` |
| `pago` | El webhook de cobro | Sí | `GB_PAGO` |
| `vencido` | El webhook de cobro | No | 0 |

Dos cosas que no se ven en la tabla:

- **El plan del dueño del servicio no está en la lista.** Sale de `KICK_SLUG` y no de la base: `planDe()` lo contesta antes de leer el documento, y `/admin` no le ofrece ningún botón.
- **Un vencimiento que ya pasó baja el plan solo**, aunque el campo siga diciendo "pago". El webhook de cobro es lo único del sistema que llega de afuera y puede no llegar; si no llega, el servicio tiene que cortarse, no seguir dando.

### El tope de canales

La app de Kick sin verificar admite **1.000 canales suscriptos** a `chat.message.sent`. Pasado ese número las suscripciones fallan y el chat de los que entren queda mudo sin ningún error visible. `/crear` corta en `TOPE_CANALES` (900) y `/admin` avisa a partir de la mitad: **antes de los 500 hay que pedirle a Kick la verificación de la app.**

### La subida de un creador

El creador no tiene el token de R2. Pide URL prefirmadas:

1. `POST /api/subida` con `{ id, archivos: [{ ruta, bytes }] }`, autenticado con la cookie del panel **o** con `X-Clave-Subida` (el script corre en una terminal y no tiene cookie).
2. El servidor comprueba el plan, mide **contra R2** cuánto ocupa ya esa sala, y firma un `PUT` por archivo sobre `<slug>/<id>/<ruta>`, válido diez minutos.
3. El creador sube contra esas URL. Los bytes van del creador a R2, sin pasar por Railway.

El prefijo se arma **en el servidor** con el slug de la cookie: lo único que elige el creador es lo que va después del `<id>/`, y aun eso pasa por `claveValida`, que rechaza `..`, la barra inicial, los segmentos vacíos y la barra invertida. Es la única línea que separa los videos de una sala de los de otra.

Que la clave empiece con `<slug>/` lo vuelve a exigir **`r2.firmar`**, que no firma nada sin que le digan de qué sala es. Vive ahí y no en cada ruta porque el otro camino que firma —el `DELETE` de `--borrar`— trabaja con claves que **no arma este servidor**: se las contesta R2 en un XML.

El tope de GB se compara contra lo que **R2 dice que hay**, no contra los bytes declarados en el pedido: esos los elige el mismo al que se le está poniendo el límite.

### El cobro

`servidor/cobro.js` expone dos funciones —`crearCheckout(creador)` y `procesarWebhook(pedido)`— y elige la implementación con `COBRO_PROVEEDOR`. Hoy hay una: Paddle Billing, con checkout alojado y webhook `HMAC-SHA256` sobre `{ts}:{cuerpo crudo}`.

Para cambiar a Stripe: escribir `servidor/cobro-stripe.js` con las mismas funciones, agregarlo al registro de `cobro.js` y poner `COBRO_PROVEEDOR=stripe`. Ninguna ruta ni ninguna página se entera.

El slug vuelve del proveedor en `custom_data`. Es el punto delicado: sin él, el pago entra y el plan no cambia. `crearCheckout` falla ruidoso antes de crear una transacción que después no se pueda atribuir.

---

## El bus y los mensajes

### Cómo sale un evento por SSE

Todo evento va como el `message` por defecto, con el tipo **adentro del `data`**:

```
id: 7
data: {"tipo":"chat","red":"kick","id":"01JG…","usuario":"unaespectadora","texto":"hola","hora":"2026-09-06T19:31:00.477Z"}
```

No como `event: <tipo>`. Por la especificación de SSE, un evento con nombre sólo llega al listener de ese nombre y nunca dispara `message`: el cliente no puede suscribirse a un tipo que todavía no existe. Con el tipo adentro del `data`, `window.Sala.conectar(slug, (tipo, datos) => …)` recibe cualquier cosa que difunda el servidor, incluidos los tipos que agreguen las fases siguientes.

Los tipos que existen hoy: `estado` (al conectarse), `chat` (un mensaje, en el formato único), `reloj` (en qué segundo va la película), `presencia` (cuánta gente está mirando) y `chat-abierto` (`{ abierto, redes }`, cuando el creador abre, cierra o cambia las redes de su chat abierto; la Sala lo ignora).

**Lo que NO sale por el bus: la salud.** El bus de un canal es público —lo escucha cualquiera que esté mirando la peli— y la salud dice si el dueño tiene vinculada cada red y en qué modo está su conexión. Eso se pide contra `/api/chat/salud`, que exige la cookie del dueño.

### Qué redes ve cada conexión

| Quién se conecta a `/eventos/:slug` | Qué redes recibe |
|---|---|
| El dueño **de esa sala** (su cookie de creador) | Las dos, siempre |
| Cualquier otro, con el chat abierto | Las que el creador eligió en `/panel` |
| Cualquier otro, con el chat cerrado (como nace) | Sólo Kick, como siempre: la Sala depende de eso |

Por el canal de cada sala viaja también su chat de Twitch, porque `/chat` los muestra juntos. Pero ese bus no pide sesión, y desde la Fase 2 lo escucha cualquiera que abra la Sala a ver la película: esa gente no tiene nada que ver con la comunidad de Twitch del streamer, ni al revés. Desde la Fase 5.1 el creador puede **abrir** su chat (`/chat/<slug>`), y recién ahí el bus público lleva Twitch.

"De esa sala" importa: hasta la Fase 5.1 alcanzaba **cualquier** cookie de creador para recibir las dos redes de cualquier sala.

Se filtra **en el servidor y por conexión** (`canales.js`, `leDaEl`), no en el navegador: filtrando en el navegador, el chat de Twitch igual saldría por el cable hacia trescientas pestañas y un `curl /eventos/istincho` lo vería entero. La página de la Sala **no** vuelve a filtrar, a propósito: si lo hiciera, una regresión en esa puerta sería invisible. Una sola fuente de verdad, y es el servidor.

**La regla del público se pregunta en cada evento, no al conectar.** La conexión guarda una función, no una lista. Así, si el creador cierra el chat o le saca Twitch con gente mirando, el próximo mensaje de Twitch ya no sale por el cable hacia esas conexiones, sin esperar a que reconecten. La respuesta vive en memoria (`creadores.chatAbierto`): se lee del almacén la primera vez y después la cambia sólo `POST /api/panel/chat`. Con una sola instancia en Railway no se desincroniza; si algún día hay dos, hay que moverla.

**`?redes=kick` pide menos, nunca más.** La Sala lo manda (`Sala.conectar(slug, fn, { redes: ['kick'] })`): la gente de la película escribe a Kick, así que aunque el creador abra su chat con Twitch, la Sala sigue mostrando sólo Kick. Lo decide el servidor, no la página.

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

Entra con `/oauth/kick/entrar?rol=espectador` (scopes `user:read chat:write`) y, en el chat abierto, también con `/oauth/twitch/entrar?rol=espectador` (scope `user:write:chat` y nada más). Se le guarda **lo mínimo**: por cada red conectada, su `user_id`, su nombre y sus tokens cifrados. El refresh token hace falta de verdad —el access dura una hora y una película dura dos y media—, y **"Salir" borra los de las dos redes**, no sólo tira la cookie.

**Una cuenta de espectador sirve para todas las salas.** La cookie es del dominio, así que quien conectó Kick en `/chat/unocualquiera` ya está conectado en `/chat/otro`. No se guarda qué salas visitó ni se publica en ningún lado quién está mirando.

**El espectador ya no es una cuenta de Kick.** Tiene id propio (`esp_…`) y las redes le cuelgan, porque alguien puede conectar sólo Twitch y no tener nunca un id de Kick. Los que ya estaban —que se guardaban en `tokens`, bajo `espectador:<user_id de Kick>`— se migran al leerlos **conservando su id**: esas cookies están en navegadores ahora mismo y tienen que seguir sirviendo.

Dos navegadores son dos espectadores, aunque sea la misma cuenta de Kick: deduplicar pediría un índice por red y, sobre todo, haría que "Salir" en el celular cerrara la sesión de la compu. Cada uno se va cuando quiere.

Al escribir —`POST /api/sala/:slug/chat` en la Sala, `POST /api/chat/:slug/enviar` en el chat abierto— se pasa por los mismos tres frenos, en este orden y por el mismo camino (`servidor/envio.js`):

1. el tope de cada red a la que va: Kick cuenta 500 **grapheme clusters** y 2048 bytes; Twitch, 500 puntos de código. Se miran los dos **antes** de mandarle nada a ninguna, porque si no, con "las dos" el mensaje sale en Kick y Twitch lo rechaza, y ahí ya no se puede deshacer;
2. la espera del **canal**, si Kick nos frenó hace poco: el 429 es del canal, no de la persona, y seguir mandando sólo consigue más. Es de Kick y sólo de Kick: el límite de Twitch es por cuenta (20 cada 30 s para quien no es mod), así que frenar el canal entero por una persona callaría a los demás sin motivo;
3. la espera de la persona: **uno cada dos segundos**, y **"las dos" cuenta como uno**.

#### Un 200 de Twitch no quiere decir que salió

`POST helix/chat/messages` contesta 200 y adentro dice `is_sent`. Si es `false`, el mensaje **no llegó al chat** (AutoMod, baneado, modo sólo-seguidores, slow mode) y el motivo viene en `drop_reason`. Se lo devolvemos a la persona tal cual: decirle "enviado" cuando no salió es la peor mentira posible de un chat, porque se queda esperando una respuesta que nadie va a ver.

Por eso el resultado de `/api/chat/:slug/enviar` viene **por red** y no como un sí/no global: el caso interesante es el del medio, salió en una y no en la otra. Un "error" pelado ahí haría que la persona lo escriba de nuevo y quede repetido en la red donde sí había salido.

Los baneos, el slow mode y el AutoMod de cada plataforma **se aplican solos**: el mensaje sale como de esa persona, así que Kick y Twitch la tratan igual que si escribiera desde su web.

Debajo del chat hay un **"Suscribirse"**: es un link a `https://kick.com/<canal>/subscribe`, se abre en otra pestaña (`rel="noopener noreferrer"`, así la película sigue corriendo acá) y no hay nada que cobrar de este lado.

El mensaje **no se difunde por el bus**: vuelve por el webhook como cualquier otro. Pintarlo al enviarlo lo mostraría dos veces y encima mentiría si Kick lo retuvo.

### La clave de subida

`herramientas/subir.py` corre en una terminal, no en un navegador: se autentica con la cabecera **`X-Clave-Subida`** y no con una cookie. La clave se genera y se revoca desde `/panel`, y se guarda **hasheada** (SHA-256), como las sesiones: un volcado de la base no deja subir ni borrar nada. La comparación es `timingSafeEqual`.

La clave autoriza **una sola sala**: si el JSON dice otro `slug`, el servidor contesta 403.

**No se muestra en pantalla.** El dueño trabaja con la transmisión al aire, así que el panel la copia al portapapeles y sólo la muestra si alguien toca "Mostrar igual", con el aviso al lado.

**Borrar el video que se está pasando detiene el reloj.** Si no, la sala se queda pidiendo segmentos que ya no existen en R2: el player no falla con un error claro, se queda cargando para siempre.

### Las métricas

Mensajes por hora (anillo de 24 casilleros con marca de hora, así el de las 3 de la mañana de hoy no se suma al de ayer), envíos, errores 429 y espectadores pico. **Viven en memoria** y se dicen así en pantalla: una escritura en Mongo por cada mensaje del chat, todas las noches, para un número que se mira una vez, no se paga. Un despliegue las pone en cero.
