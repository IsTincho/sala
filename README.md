# Sala

Servicio web para un streamer de Kick. Tres cosas:

- **Chat Global**: el chat de Kick y el de Twitch juntos en una ventana aparte, con una caja para escribir a los dos.
- **Chat abierto**: el mismo chat, pero para la comunidad del creador (`/chat/<slug>`). Leer no pide login; para escribir, cada quien conecta **su** Kick y/o **su** Twitch y el mensaje sale en el chat de verdad con su nombre, en una red o en las dos.
- **Sala**: pasar una película o serie en una página propia, con la cámara de Kick al lado y el chat real de Kick a la derecha. Los espectadores se loguean con Kick y lo que escriben cae en el chat de verdad del stream. **Apagada desde el 2026-09-22**: ver abajo.

> **Lo que se ofrece hoy es el multichat.** La Sala está entera y probada, pero **nace cerrada para todos** —incluido el dueño del servicio— y con el interruptor apagado `/sala/<slug>` no existe para nadie. Es un interruptor por creador (`salaAbierta`), no un borrado: se prende desde `/panel` (la del dueño del servicio) o desde `/admin` (la de cualquiera). Ver [La Sala](#la-sala).

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
| `EMOTES_7TV` | Poner `0` apaga los emotes de 7TV sin tocar código | Prendido |
| `EMOTES_7TV_RESPALDO` | Poner `0` apaga el respaldo entre redes (ver más abajo) | Prendido |
| `EMOTES_KB` | Cuánto puede pesar **un** emote de 7TV | 128 KB |
| `EMOTES_POR_MENSAJE` | Cuántos emotes de 7TV puede meter un solo mensaje | 30 |
| `EMOTES_PLAZO_MS` | Cuánto puede durar **una bajada entera** de 7TV antes de darla por perdida | 20 s |
| `EMOTES_TWITCH` | Poner `0` apaga los emotes **nativos de Twitch** del selector, sin tocar 7TV ni las insignias | Prendido |
| `INSIGNIAS_TWITCH` | Poner `0` apaga las imágenes de las insignias de Twitch: quedan las etiquetas de texto de siempre | Prendido |
| `INSIGNIAS_PLAZO_MS` | Lo mismo que `EMOTES_PLAZO_MS`, para las insignias | 20 s |

### Las numéricas son números, y un typo se avisa

Todas las de arriba que llevan un número pasan por `servidor/entorno.js`. **El valor es un número pelado**: `EMOTES_PLAZO_MS=20s` no es un número, así que se usa el defecto y sale una línea en el log con el nombre de la variable (nunca con su valor: el dueño trabaja con la pantalla al aire).

No es ceremonia, era un bug real: `Number('20s')` da `NaN`, y `setTimeout(fn, NaN)` **no espera para siempre, dispara a un milisegundo**. O sea que ese typo no alargaba el plazo, hacía vencer todas las bajadas y **apagaba los emotes de 7TV para siempre**, dejando como único rastro un log que decía *"tardó más de NaN ms"*. Un tope en `NaN` es peor todavía: `cuenta >= NaN` es `false` siempre, así que un tope con typo no es un tope más grande, es ninguno.

Y **el cero se respeta**, que es lo que hace que esto no sea un `Number(x) || defecto`: `TOPE_TWITCH=0` ("no abras ninguna conexión de EventSub"), `GB_AMIGO=0` ("este plan no sube videos") y `PADDLE_TOLERANCIA_S=0` ("sin tolerancia de reloj") quieren decir algo, y con `||` se convertían callados en 50, en 2 y en 60.

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
  emotes.js     los emotes del selector: los de 7TV por (slug, red), los nativos de
                Twitch por creador y los de Kick que cada chat vio pasar
  insignias.js  la imagen de cada insignia de Twitch, cacheada por creador
  entorno.js    los numeros que salen de process.env, leidos una sola vez bien
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
  comun/        base.css, bus.js (cliente SSE), mensajes.js (el render) y qr.js
  manifest.webmanifest, sw.js, icono-*.png   lo que hace la PWA instalable
pruebas/        node --test, sin librerías
herramientas/   scripts que corren en la PC del dueño: subir.py y verificar-qr.mjs
cloudflare/     el Worker de Pages que pone un dominio lindo delante de Railway
```

Reglas que no se negocian:

- **El servidor nunca sirve video.** El navegador le pide los segmentos directo a R2. Si una ruta devolviera un `.m3u8` o un `.ts`, el egreso de Railway se comería el presupuesto del mes en una noche. La otra mitad de la regla la hace cumplir `revisarFicha`: una ficha cuya `url` apunte a nuestro propio dominio (el de `URL_BASE`) o a esta misma máquina se rechaza con 400, porque mandaría a trescientos navegadores a pedirle los segmentos a Railway sin que ninguna ruta tenga la culpa.
- **Login identifica, no autoriza.** Quién es amigo, pago o pendiente se decide en la colección `creadores`, no en el login. Y **quién es el dueño del servicio no se decide ahí tampoco**: se compara el slug contra `KICK_SLUG`, una variable de entorno, así que ni un volcado de Mongo ni un bug de escritura pueden degradarlo ni ascender a nadie.
- **"Dueño" quiere decir dos cosas y no se mezclan.** *Dueño de una sala* es cualquier creador en la suya, y es lo que identifica la cookie `sala_dueno`. *Dueño del servicio* es el de `KICK_SLUG`: el único que entra a `/admin` y el único que regala el plan "amigo".
- **Cada sala es un inquilino.** El slug con el que se lee o se escribe sale **siempre de la cookie o del camino de la URL**, nunca de un parámetro. No hay ninguna ruta de `/api/panel` que acepte un slug, y las de `/api/sala/:slug` comprueban que la sesión sea la de *esa* sala.
- **Todo webhook de Kick se verifica con RSA y se deduplica** por `Kick-Event-Message-Id`.
- **Un documento se cambia de a uno por vez.** El almacén no sabe actualizar un campo suelto: `poner` reemplaza el documento entero, así que todo cambio es leer-cambiar-guardar y dos a la vez se pisan en silencio. Por eso **toda** escritura del documento de un creador pasa por `escribir`, que la encola por slug (`almacen.enCola`), y quien necesita mirar lo que había lo lee **adentro** de esa cola. Lo mismo en `espectadores.js`. No es teórico: con la cola sólo en los dos interruptores, prenderle la Sala a alguien desde `/admin` justo cuando entraba su pago **perdía el plan pagado** 20 de 20 veces.
- Cookies `HttpOnly`, `Secure`, `SameSite=Lax`. Los POST del espectador piden **además** que el `Origin` sea uno de los nuestros (`URL_BASE` + `ORIGENES`): son los que hacen que alguien escriba con su nombre en el chat de un tercero.
- Sin frameworks ni bundlers. Única dependencia: `mongodb`.
- Nombres en español en código, rutas y comentarios.

---

## Rutas

| Ruta | Qué es |
|---|---|
| `/` | Página de estado: si el servidor está vivo y conectado al bus |
| `/chat` | **Chat Global**: Kick y Twitch juntos, con caja para escribir a los dos. Se instala como app |
| `/chat/:slug` | **El chat abierto de una sala**: la misma página que `/chat`, para la comunidad del creador. **Leer no pide login**: las redes que el creador eligió, mezcladas en vivo, sin la salud (que es de la cuenta del creador). **Escribir pide conectar la cuenta propia**: "Conectar Kick" y "Conectar Twitch", y el selector muestra sólo las redes que la persona conectó Y que el creador abrió (con las dos, aparece "las dos"). Arriba dice cuánta gente está leyendo —un número, nunca quiénes— y se puede **instalar como app**: cada sala tiene su propio manifest. Si el creador no lo abrió dice "este chat está cerrado" y se vuelve a fijar sola cada 30 s. **404 si la sala no existe**, igual que `/sala/:slug`. Se sirve `chat.html` con `<base href="/">` y sin el manifest del creador; `/chat` a secas sale byte por byte igual. No va como fuente en OBS si se transmite a Twitch (reglas de simulcast) |
| `/panel` | Panel de **cada creador**: entrar con Kick, vincular Twitch, ver la salud, manejar la película, la clave de subida y el plan. Con un plan sin reproducción se ve en modo sólo lectura, con el botón de suscribirse — que **con la Sala apagada no aparece**, porque no habría qué suscribir |
| `/crear` | El alta. Aceptar los términos y entrar con Kick: crea la sala con plan "pendiente" |
| `/terminos` | El texto que se acepta al crear la sala |
| `/admin` | La lista de creadores, su plan y su uso. **Da 404 a todo el que no sea el dueño del servicio**: un 403 ya anunciaría que existe |
| `/sala/:slug` | **La Sala**: cámara, película en HLS y chat de Kick. Da 404 si el canal no existe **o si tiene la Sala apagada**, y el 404 es el mismo en los dos casos |
| `/eventos/:slug` | SSE. Manda un evento `estado` apenas te conectás, y un ping cada 25 s. `HEAD` contesta y no abre stream. **El slug tiene que ser el del dueño o el de un creador dado de alta**: cualquier otro da 404. Qué redes manda depende de quién pregunta y del chat abierto de la sala (ver "Qué redes ve cada conexión"). `?redes=kick` pide menos, nunca más. El `estado` inicial lleva el reloj **sólo si la Sala de ese creador está prendida**, o si quien escucha es el dueño de *esa* sala |
| `/api/estado` | JSON con modo, almacén, canales y qué variables faltan. **Público y sin sesión**, así que de cada canal dice sólo `conReloj` (un booleano, que explica por qué un canal sin nadie sigue vivo) y nunca qué película es |
| `/oauth/kick/entrar` · `/oauth/kick/volver` | Login con Kick (OAuth 2.1 + PKCE) |
| `/oauth/twitch/entrar` · `/oauth/twitch/volver` | Vinculación de Twitch. Con `?rol=espectador` es el login de un espectador y pide **sólo `user:write:chat`**: leer entra con el token del creador. El rol viaja en el `state` del servidor, nunca en la query del callback. **Mismo redirect** en los dos casos |
| `/kick/webhook` | Eventos de Kick. 401 si la firma no da. **Se rutea a la sala del `broadcaster_user_id`** (y en su defecto del `channel_slug`); lo que no se pueda atribuir a una sala que existe se descarta |
| `/cobro/webhook` | Los avisos del proveedor de cobro, con la firma verificada. Es lo único que pone los planes "pago" y "vencido" |
| `/api/chat/salud` | Cómo está cada red **de la sala de quien pregunta**. Pide cookie de creador |
| `/api/chat/enviar` | `POST { destino: "kick" \| "twitch" \| "ambos", texto }` con la cuenta de quien pide. Pide cookie de creador. **El texto se traduce por red** con la misma `envio.comoViajaA` que la puerta del espectador, y el tope de cada red se mide contra el texto que esa red va a recibir |
| `/api/chat/emotes` | `GET` con cookie de creador: los emotes que puede ofrecer el selector de **su** ventana, con la misma forma que la ruta pública. El slug sale de la sesión y **no mira el interruptor del chat abierto**: el creador escribe en su propio chat con el chat cerrado |
| `/api/chat/resuscribir` | Vuelve a crear las suscripciones de Kick de su sala. Pide cookie de creador |
| `/api/chat/:slug/abierto` | `GET` público: `{ abierto, redes }`. Cerrado contesta `redes: []`: de un chat cerrado no se cuenta nada. 404 si la sala no existe. Contesta de la misma memoria que usa el filtro del bus |
| `/api/chat/:slug/emotes` | `GET` público: los emotes que puede ofrecer el selector de la caja de escribir, cada uno con la `marca` que hay que poner en la caja y en qué `redes` sirve. **Sin sesión**, igual que `/abierto`: leer el chat nunca pidió login y esto es parte de leerlo. Con el chat cerrado contesta `emotes: []`. `?red=` acota a qué red va a ir el mensaje y **pide menos, nunca más**: se cruza contra las redes que el creador abrió. 404 si la sala no existe |
| `/api/chat/:slug/yo` | `GET` con cookie de espectador: qué redes conectó esa persona y en cuáles puede escribir **acá** (lo suyo cruzado con lo que el creador abrió). Habla del que pregunta y de nadie más |
| `/api/chat/:slug/enviar` | `POST { red: "kick" \| "twitch" \| "ambas", texto }` con cookie de espectador **y `Origin` propio**. Mismos frenos que `/api/sala/:slug/chat`, y **"ambas" cuenta como un solo mensaje**. 403 si el chat está cerrado, si esa red no está abierta o si la persona no la conectó. El resultado viene **por red**: `{ ok, kick: {ok, motivo}, twitch: {ok, motivo} }` |
| `/api/espectador/salir` | `POST` con `Origin` propio: cierra la sesión y **borra los tokens de las dos redes**. Sin slug: la cuenta de espectador es del dominio, no de una sala |
| `/chat/:slug/manifest.webmanifest` | El manifest de la PWA de **esa** sala: `start_url` y `scope` son `/chat/<slug>`, así cada espectador instala el chat de su streamer y abre ahí. 404 si la sala no existe |
| `/api/hora` | La hora del servidor, y nada más. Con esto cada navegador mide su desfase y calcula en qué segundo va la peli |
| `/api/videos` | `POST` guarda una ficha (cabecera `X-Clave-Subida`); la `url` tiene que ser `https`, terminar en `.m3u8` y **no ser la nuestra**. La clave autoriza **una sola sala**. `GET` lista el catálogo **de la sala de la cookie o de la clave**: no hay parámetro que lo cambie. **404 con la Sala apagada** |
| `/api/videos/:id` | `DELETE` borra la ficha (misma cabecera). Un 404 no es error para el script. **404 con la Sala apagada** |
| `/api/sala/:slug/reloj` | Play, pausa, reanudar, saltar y detener. Cookie del dueño **de esa sala**, y **402 si su plan no reproduce** |
| `/api/sala/:slug/chat` | El mensaje de un espectador, que sale en kick.com con SU cuenta, **en el canal de esa sala**. Cookie de espectador **y `Origin` propio**. **403 si el creador lo bloqueó**: es la misma lista que `/api/chat/:slug/enviar`, porque son dos puertas al mismo canal. 503 sólo si esa sala todavía no vinculó Kick |
| `/api/sala/:slug/yo` | Si esta persona entró, si puede escribir y **si el creador la bloqueó** (`bloqueado`, igual que su hermana de `/api/chat/`: el corte ya existía en el envío y la pantalla no se enteraba). Nunca la lista de quién está en la sala |
| `/api/sala/:slug/salir` | `POST` con `Origin` propio: cierra la sesión del espectador y **olvida sus tokens**. El refresh token es de esa persona, no del dueño |

| `/api/panel` | Todo lo que muestra `/panel` en un pedido: plan, salud, reloj, videos, métricas, clave, uso de R2 y el chat abierto (`chatAbierto: { activo, redes }`). Trae también `salaAbierta`, para que el panel no pinte los controles de una película que el servidor va a rechazar. **Esta ruta no se apaga**: el creador tiene que poder ver su panel igual. El link del chat abierto no viaja: lo arma la página con el origen desde el que se la mira. Cookie de creador |
| `/api/panel/clave` | `POST` genera la clave de subida de su sala (se devuelve una sola vez), `DELETE` la revoca. **404 con la Sala apagada** |
| `/api/panel/twitch` | `DELETE` desvincula Twitch de su sala: cierra la conexión y borra el token |
| `/api/panel/suscribirse` | `POST` devuelve la URL del checkout del proveedor de cobro. **404 con la Sala apagada**: lo único que se cobra es pasar una película, así que con la Sala cerrada no hay nada que suscribir, y el panel tampoco pinta el botón |
| `/api/panel/sala` | `POST { abierta }` prende o apaga **su** Sala. Existe para cualquier creador con sesión y contesta **403 al que no sea el dueño del SERVICIO**: `esDueno` se pregunta acá, contra `KICK_SLUG`, no en la base. Un `abierta` que no sea `true`/`false` da 400 |
| `/api/panel/chat` | `POST { activo?, redes?, bloquear?, desbloquear? }` abre o cierra el chat abierto de **su** sala, elige las redes (`kick`, `twitch` o las dos) y maneja la lista de bloqueados. Lo que no viene queda como estaba; una red desconocida o una lista vacía da 400. **El slug sale de la cookie**: un `slug` en el cuerpo no se lee. Los bloqueados se tocan **de a uno** (`{ red, id, nombre? }`), nunca la lista entera: con dos pestañas del panel abiertas, mandar la lista completa haría que la segunda pise el bloqueo de la primera. Entra en todos los planes. Vale en el acto para la gente conectada y se avisa por el bus (`chat-abierto`) |
| `/api/subida` | `POST` firma las URL de subida a R2 de su prefijo `<slug>/<id>/`. **404 con la Sala apagada** (antes que el plan), 402 si su plan no sube, 409 si no entra en su tope de GB. Acepta la cookie **o** la cabecera `X-Clave-Subida`: el script corre en una terminal |
| `/api/subida/borrar` | `POST` firma los DELETE de todo lo que haya bajo `<slug>/<id>/`. Misma autenticación, y **404 con la Sala apagada**: `DELETE /api/videos/:id` también lo está, así que dejarlo abierto sería borrar a medias (los bytes de R2 sí, la ficha del catálogo no) |
| `/api/admin/creadores` | La lista con plan, vencimiento, uso y si tiene la Sala prendida. Sólo el dueño del servicio |
| `/api/admin/plan` | `POST {slug, plan}`. **Sólo acepta "amigo" y "pendiente"**: los otros dos los pone el webhook de cobro |
| `/api/admin/sala` | `POST {slug, abierta}` prende o apaga la Sala de cualquier creador. Sólo el dueño del servicio, y es la **única** forma de habilitársela a otro. A diferencia de `/api/admin/plan`, acá el dueño **sí** se puede tocar a sí mismo: su plan no sale de la base y este interruptor sí |
| `/api/prueba/webhook` | **Sólo con `MODO=local`.** Inyecta un evento sin firma, para desarrollar sin webhooks reales. Con `?tipo=chat.message.sent` entra por el mismo camino que uno real y sale traducido como `chat` |

**Las páginas se sirven por su dirección y no por su nombre de archivo.** `/sala.html`, `/panel.html` y `/admin.html` dan 404: los archivos viven en `paginas/` y de ahí salen los estáticos, así que pedirlos por el nombre salteaba la guarda de su ruta (una Sala apagada abría igual su cáscara, y `/admin` contesta 404 al que no es el dueño justamente para no anunciar que hay un panel de administración). El CSS y el JS de cada página se siguen sirviendo normalmente.

Las cuatro rutas de `/api/sala/:slug/` dan 404 si el slug no es el del dueño del servicio ni el de un creador dado de alta, igual que `/eventos/:slug` y `/sala/:slug`. Y las cuatro contestan **la sala primero y la cookie después**: un pedido sin sesión a una sala que no existe da 404 y no 401, porque "¿existe esta sala?" es un hecho sobre la sala y ya se puede averiguar con un `GET /sala/<slug>`.

**Y con la Sala apagada contestan exactamente lo mismo.** `/sala/:slug` y las cuatro de `/api/sala/:slug/` no distinguen "no existe" de "existe pero está apagada": mismo código y mismo cuerpo. Un 403, o un 404 con otro texto, ya anunciaría que ahí hay algo esperando que alguien insista, y una Sala cerrada no es un permiso que falte sino una función que no se está ofreciendo. El interruptor se mira **en el mismo lugar** que la existencia, antes de la cookie: mirarlo después haría que la diferencia entre el 401 y el 404 cuente justo lo que el 404 viene a no contar.

Las que sacan el slug de la cookie o de la clave de subida (`/api/panel/clave`, `/api/subida`, `/api/subida/borrar`, `/api/videos`, `/api/panel/suscribirse`) también dan 404, pero **sí dicen por qué**: quien llega ahí ya demostró que la sala es suya, así que "está apagada" no le cuenta nada que no sepa, y un 404 mudo sobre su propio panel lo mandaría a buscar un bug que no hay. El chequeo va **antes que el del plan**: contestar "tu plan no sube videos" con la Sala apagada manda a alguien a pagar por algo que no se le va a dar.

**Lo que NO se apaga**, porque es el chat abierto y es lo que hoy se ofrece: `/eventos/:slug`, `/chat/:slug`, `/chat/:slug/manifest.webmanifest`, `/api/chat/:slug/*`, `/api/espectador/salir`, `/api/panel` y `/api/panel/chat`.

---

## Otros creadores

Cualquier streamer de Kick entra por `/crear`, acepta los términos y se loguea. Su sala queda en `/sala/<su-slug>` con plan **pendiente**: se abre, se lee el chat, y no reproduce.

| Plan | Quién lo pone | Reproduce | GB |
|---|---|---|---|
| `pendiente` | El alta | No | 0 |
| `amigo` | El dueño, desde `/admin` | Sí | `GB_AMIGO` |
| `pago` | El webhook de cobro | Sí | `GB_PAGO` |
| `vencido` | El webhook de cobro | No | 0 |

Tres cosas que no se ven en la tabla:

- **El plan del dueño del servicio no está en la lista.** Sale de `KICK_SLUG` y no de la base: `planDe()` lo contesta antes de leer el documento, y `/admin` no le ofrece ningún botón.
- **Un vencimiento que ya pasó baja el plan solo**, aunque el campo siga diciendo "pago". El webhook de cobro es lo único del sistema que llega de afuera y puede no llegar; si no llega, el servicio tiene que cortarse, no seguir dando.
- **El plan no es el único interruptor.** Desde el 2026-09-22 la Sala está apagada para todos y lo que decide si existe es `salaAbierta`, que no tiene nada que ver con el plan: apagada da 404 tenga el plan que tenga, y el chequeo va **antes**. El chat abierto entra en todos los planes y no depende de ninguno de los dos.

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
  "id": "01JG…", "usuario": "unaespectadora", "usuarioId": "12345", "color": "#ff5733",
  "insignias": [{ "tipo": "moderator", "version": "1", "texto": "Moderator", "url": "https://static-cdn.jtvnw.net/badges/v1/…/2" }],
  "texto": "que peli mas larga HYPERCLAP",
  "emotes": [{ "id": "4148074", "inicio": 19, "fin": 28, "url": "https://files.kick.com/emotes/4148074/fullsize" }],
  "hora": "2026-01-14T16:08:06.000Z"
}
```

`usuarioId` es el id de quien escribió **en su red**, y está para una sola cosa: que el creador pueda bloquearlo en esta herramienta desde el menú de su mensaje. Por nombre no serviría, porque los nombres se cambian. Sale por el bus para todos y eso se pensó: es el mismo id que Kick manda en `sender.user_id` y Twitch en `chatter_user_id` a cualquiera que lea ese chat público.

`inicio` y `fin` cuentan **puntos de código Unicode** sobre `texto`, y el emote ocupa `[inicio, fin)`. Se corta con `[...texto]`, nunca con `texto.slice`: un índice de string cuenta unidades UTF-16, y un solo emoji antes de un emote corre de lugar todos los que vengan después.

`fuente` dice de dónde salió cada emote: `kick`, `twitch` o `7tv`. Está en **todos** los emotes y no sólo en los de terceros, porque un array donde algunos elementos tienen una clave y otros no es la forma de que, el día que alguien la lea, se rompa justo con los mensajes de una red. Es aditivo: un cliente viejo lo ignora. Hoy la página no lo mira; está para quien quiera mostrar en pantalla de dónde viene el emote, que es una decisión de diseño todavía sin tomar.

Cada insignia lleva `tipo`, `version`, `texto` y `url`, por el mismo motivo de arriba: las cuatro están en **todas**, aunque a las de Kick `version` y `url` les queden siempre vacías. `url` la completa el servidor (ver "Las insignias") y `version` es lo que hace falta para casarla: Twitch manda `{ set_id: "subscriber", id: "12", info: "16" }`, donde el `12` es **cuál de los dibujos** del set y el `16` son los meses de verdad. Confundirlos le pone a un suscriptor de tres años el ícono del primer mes, sin romper nada y sin avisar.

### Los emotes de 7TV

Alguien escribe `CHAD` en el chat de Kick, lo ve como emote en kick.com porque tiene la extensión de 7TV puesta, y en el multichat lo veía como una palabra. Eso es lo que arregla `servidor/emotes.js`: ni Kick ni Twitch saben que 7TV existe, así que el emote llega como texto pelado y hay que resolverlo contra el set del creador.

Entra por el **mismo array `emotes`** del formato único, con `fuente: "7tv"`. La página no cambió una línea: `agregarTextoConEmotes()` pinta un emote de 7TV por el mismo camino que uno de Kick. Ese es el pago del formato único.

**Por creador y por red.** La caché es por `(slug, red)`: el set del Kick de alguien no es el de su Twitch, y el de un creador no es el de otro. Con la clave por red sola —que es lo que alcanza en el repo hermano, que tiene un solo canal— el set de uno se le pintaría a los mensajes del otro: no rompe nada, muestra el emote equivocado en la pantalla de otra comunidad. Cada casillero tiene su propio vencimiento y su propia bajada en vuelo, así que un 7TV que falla para uno no toca la tabla de los demás.

El id con el que se pregunta es el **`user_id` de Kick** (el mismo que usamos como `broadcaster_user_id` para el webhook) o el de Twitch, según la red. Ojo, que es el error fácil: el `channel_id` de Kick da 404 en 7TV.

**El respaldo entre redes.** Verificado el 2026-09-22 contra el 7TV real: el Kick del dueño tiene set propio (66 emotes) y su Twitch no tiene `emote_set` en la respuesta — es el caso normal de quien usa 7TV sólo en una red. Sin respaldo, sus mensajes de Twitch saldrían sin un solo emote de 7TV aunque tenga 66 cargados del otro lado. Cuando la red de un mensaje no tiene set propio (7TV contestó 404, o contestó bien pero sin `emote_set`) **y esa red está vinculada**, se resuelve con el set de la **otra** red del mismo creador, si el creador la tiene vinculada también. Vale en las dos direcciones. La red propia **siempre gana**: el respaldo sólo entra cuando ya está confirmado que la propia no tiene nada, nunca mientras la bajada está en curso o mientras la caché guarda un fallo de verdad (esos dos casos se sirven sin respaldo, a la espera del próximo mensaje).

No hay una cuarta caché para esto: el respaldo se lee con la misma `tabla(slug, otraRed)`, con sus mismos tres vencimientos, su misma bajada compartida y su mismo tope de seis en vuelo. Si alguien ya mira el chat de esa otra red, la tabla ya está cacheada y el respaldo la lee gratis. Se apaga con `EMOTES_7TV_RESPALDO=0`; viene prendido.

**Los globales de 7TV van incluidos**, en una tabla sola para todo el proceso. Son los que ve cualquiera con la extensión puesta en cualquier canal, tenga o no el streamer cuenta de 7TV; dejarlos afuera haría que el multichat muestre menos de lo que la gente ya ve. Son 45 emotes y pesan poco: mediana 4,5 KB en 2x y 852 KB el set entero (medido el 2026-09-22 contra `7tv.io/v3/emote-sets/global`). Si un creador le pone a un emote suyo el nombre de uno global, gana el suyo.

**Ganan los nativos.** Si una palabra cae, aunque sea en parte, adentro del rango de un emote de Kick o de Twitch, se deja como está. No es un empate arbitrario: en Kick el texto que se ve no es el que la persona escribió —`partirTextoDeKick()` reemplaza `[emote:4148074:HYPERCLAP]` por la palabra `HYPERCLAP` para que sirva de `alt`—, así que esa palabra quedaría lista para resolverse **dos veces**. Y el nativo es el que la persona efectivamente eligió del selector de su plataforma.

7TV resuelve por **palabra entera y distinguiendo mayúsculas**: `CHAD` y `chad` son dos emotes distintos y pueden ser dos dibujos distintos; `CHAD!` y `xCHAD` no son nada. Así funciona la extensión.

#### El peso

Un emote de 7TV se lo baja el navegador de **cada espectador**, así que el problema acá es el ancho de banda de la gente, no los frames de OBS (que es el problema del repo hermano, y por eso el número no es el mismo). Medido contra un set real de 66 emotes pidiendo `2x.webp`: mediana 29,8 KB, p90 245 KB, máximo 1.100 KB. La mediana es barata y la cola es carísima.

El criterio es: se pide en **2x** (64 px de alto; el CSS muestra el emote en 1,6em, o sea unos 24 px, así que 2x cubre pantallas de hasta 2,6x de densidad); si no entra en el presupuesto se pide en **1x**; si tampoco entra, **el emote no sale** y la palabra se lee como texto, que es exactamente lo que se veía antes.

Con el presupuesto por defecto de **128 KB**, sobre ese set de 66:

| Presupuesto | En 2x | En 1x | Afuera | Si un espectador ve el set entero |
|---|---|---|---|---|
| 64 KB | 42 | 15 | 9 | 1,3 MB |
| **128 KB** | **56** | **7** | **3** | **2,6 MB** |
| 256 KB | 62 | 3 | 1 | 3,6 MB |

Los tres que quedan afuera con 128 KB son animaciones largas; la peor, `maxwin`, pesa 1,1 MB en 2x y 505 KB hasta en 1x. Se pide **WEBP y no AVIF** aunque AVIF pese la mitad: un Safari o un WebView de Android viejos no lo dibujan, y en un chat eso es un ícono roto por mensaje.

El peso no hay que ir a medirlo: 7TV lo dice en la misma respuesta, para cada tamaño.

#### Cuándo se refresca

Sin esperar nunca. Un mensaje de chat sale al toque: si la tabla todavía no está, sale sin emotes de 7TV y la bajada queda agendada.

**Cuántos mensajes salen pelados**, con el número medido y no con la frase linda: todos los que lleguen *mientras* se baja la tabla. Con un creador solo y 7TV contestando rápido es uno. Pero la bajada tarda lo que tarda y además hay un tope de seis simultáneas: medido con 20 creadores mandando un mensaje cada 250 ms y 7TV a 600 ms, salieron 130 mensajes sin emotes y el peor creador se comió 11 seguidos. Pasa una sola vez por creador y por arranque —al vencer se sigue sirviendo la tabla vieja mientras se baja la nueva, así que ahí no hay hueco— y lo que se pierde es un adorno, no el mensaje.

**El tope de seis bajadas simultáneas tiene plazo propio, y eso no es un detalle.** Una bajada empieza pidiéndole el id al almacén, y el cliente de Mongo se crea sin `socketTimeoutMS`: un socket medio abierto no vence nunca. Sin un plazo que cubra la bajada **entera** —no sólo el `fetch`—, seis promesas colgadas se quedan con los seis lugares y 7TV queda apagado para todos los creadores, para siempre, sin un pedido y sin una línea de log. Por eso hay `EMOTES_PLAZO_MS` y por eso el tope lleno se avisa (como mucho una vez por minuto).

Tres vencimientos, y no uno:

| Qué pasó | Vence en | Por qué |
|---|---|---|
| Se bajó bien | 10 min | Lo mismo que usa el repo hermano. Acá no se persiste nada: todo muere con el proceso, así que el tope de 24 h de cacheo de los términos de Kick no llega a tocarnos |
| 7TV contestó 404 | 1 hora | Es el caso de la **mayoría** de los creadores y es un hecho estable. No tiene sentido preguntarlo 144 veces por día por cada uno |
| Falló de verdad (timeout, 500) | 1 min | Y **no** se pisa la tabla que había: un emote viejo es mejor que ninguno |

El precio del 404 de una hora: quien se acaba de hacer la cuenta de 7TV puede tardar hasta una hora en ver sus emotes en el multichat. Un redeploy lo resuelve en el acto.

Se loguea cuando **cambia** algo, no cada vez que se confirma: un creador sin 7TV deja una línea por proceso, no una por mensaje ni una cada diez minutos.

#### La EventAPI de 7TV: anotada, no hecha

7TV tiene un push (`emote_set.update` por SSE o WebSocket en `events.7tv.io/v3`, 500 suscripciones por conexión, verificado en `INVESTIGACION-EMOTES.md`). **No está puesto, a propósito.** Lo único que compra es bajar de "hasta 10 minutos" a "en el acto" la demora con la que aparece un emote que el streamer acaba de agregar; lo que cuesta es una conexión persistente más que mantener, reconectar y vigilar, y una lista de set ids para suscribir y desuscribir a medida que entran y salen creadores. Para un adorno, no compensa todavía.

El gancho ya está: `emotes.vencer(slug, red)` marca una tabla como vencida. El día que se haga la EventAPI, es llamarlo cuando llegue el dispatch.

### El selector de emotes de la caja

Al lado de la caja hay un botón **Emotes**: se abre un panel con buscador, se elige uno y se inserta en el mensaje. Existe para mandar un emote sin acordarse del nombre exacto.

Está en **las dos cajas**: en `/chat/<slug>`, la del espectador, y en `/chat`, la ventana del creador. La única diferencia es de dónde sale la lista: `GET /api/chat/<slug>/emotes` (pública) o `GET /api/chat/emotes` (con el slug de la sesión del creador). Ver [*La otra caja*](#la-otra-caja-chat-la-ventana-del-creador) más abajo.

#### El problema de fondo: el mismo emote no se escribe igual en las dos redes

| Qué emote | Cómo viaja a Kick | Cómo viaja a Twitch |
|---|---|---|
| Nativo de Kick | `[emote:5747892:collectiblesMEGALUL]` | no existe |
| Nativo de Twitch | no existe | el nombre pelado (`Kappa`) |
| De 7TV | el nombre pelado | el nombre pelado |

Y con `red: "ambas"` el mensaje sale **a las dos a la vez**. Si la página armara el markup tendría que elegir uno, y el otro lado vería un `[emote:5747892:…]` literal en pantalla.

Por eso **la caja guarda una sola forma del mensaje y la traducción la hace el servidor**, en `servidor/envio.js` (`comoViajaA`), que es el único lugar del proyecto que sabe a qué red le está hablando. **Las dos puertas de envío pasan por ahí**: la del espectador (`POST /api/chat/:slug/enviar`) y la del creador (`POST /api/chat/enviar` → `chat.enviar`, que también importa esa misma función en vez de tener su propia copia). A Kick le va el markup tal cual; a Twitch se le reemplaza cada `[emote:id:nombre]` por `nombre`, que es lo mejor que se puede hacer con un emote que ahí no existe: que se lea la palabra.

**Esto no es sólo para el selector.** Cualquiera podía escribir `[emote:1:X]` a mano en la caja, y hasta ahora eso llegaba a Twitch con los corchetes puestos. El arreglo es el mismo y vale para los dos casos. El precio, dicho sin adornos: quien quiera escribir esos corchetes *literalmente* en Twitch no va a poder. Es un texto que nadie escribe.

La marca la arma el servidor y viaja en cada emote del catálogo: **la página nunca escribe markup de ninguna plataforma**. El día que Kick cambie el formato, cambia en un archivo.

#### Contra qué se mide el tope de 500

**Contra lo que cada red va a recibir.** Desde que hay emotes el mensaje ya no es el mismo string en las dos: `[emote:5747892:collectiblesMEGALUL]` son 36 caracteres para Kick y `collectiblesMEGALUL` son 19 para Twitch. Medir los dos topes contra un solo texto obligaría a mentir en uno: con el largo de Twitch se dejarían pasar mensajes que Kick rechaza, y con el de Kick se frenarían mensajes que Twitch aceptaba.

La invariante que hubo que cuidar —la que ya había costado un bug— **no era "el mismo string a las dos redes"**: era **lo que se mide es lo que se manda**. Eso sigue en pie, ahora por red: `aUnaRed` manda exactamente `comoViajaA(texto, red)`, que es lo mismo que midió `porQueNoSePuedeMandar`. Y se sostiene sin acordarse de nada, porque `comoViajaA` es una **función pura**: no mira tablas, ni cachés, ni el reloj, así que no hay estado que pueda cambiar entre la medición y el envío.

El contador de la página cuenta el texto crudo, que es exactamente lo que recibe Kick. Para Twitch siempre es más corto, así que nunca promete lugar que no hay.

#### De dónde salen los emotes que ofrece

- **7TV**: ya estaban resueltos por `(slug, red)` con su caché, su respaldo entre redes y sus globales. El selector los lee de la **misma tabla** que usan los mensajes, así que abrir el panel no cuesta un pedido extra y un creador sin 7TV no genera ninguno.
- **Nativos de Kick**: **los que ese chat vio pasar**. No hay de dónde pedir la lista (abajo el porqué). Cada mensaje de Kick ya llega con sus emotes resueltos —id, nombre y url, sacados del `[emote:id:nombre]` del `content`—, así que anotarlos no le cuesta un pedido a nadie. Es una lista **viva**: crece con lo que la comunidad usa e incluye **coleccionables**, que no se pueden listar de ninguna otra forma. Arranca vacía, y el panel lo dice con todas las letras en vez de aparentar un catálogo completo.
- **Nativos de Twitch**: los del canal (`helix/chat/emotes`) y los globales (`/emotes/global`), con el **token de app** que ya usan las insignias. Ver abajo.

Se anotan en memoria, hasta 100 por sala y 300 salas (techo ~4,5 MB, y para llegar ahí hacen falta 300 chats vivos con 100 emotes distintos cada uno). Las salas se desalojan por la que hace más que no ve un emote, así que lo que se tira es siempre un chat dormido.

**Caducan a las 12 horas**, y el número no es al azar: los términos de `dev.kick.com` dejan guardar su contenido *"for only a twenty-four hour time period"*. Doce horas entra con margen, no depende de que el proceso se reinicie seguido para cumplir, y es más o menos un ciclo de stream. Nada se persiste: vive en memoria y muere con el proceso. Un JSON de emotes de Kick versionado en el repo sería una copia permanente **y** una redistribución, y los términos prohíben las dos cosas.

#### Por qué no se le pide a Kick la lista

Porque no existe, y está verificado el **2026-09-23**, no supuesto:

- La documentación completa de Kick (`docs.kick.com/llms-full.txt`) **no tiene un solo endpoint de emotes**: la palabra aparece únicamente dentro del payload de ejemplo de `chat.message.sent`. El changelog está vivo (última entrada, 11/08/2026) y nunca los menciona.
- Hay un pedido formal de la comunidad, **abierto y sin respuesta desde diciembre de 2025** ([KickDevDocs#323](https://github.com/KickEngineering/KickDevDocs/issues/323)).
- Los **coleccionables** no se listan por ningún lado: no aparecen en `kick.com/emotes/<slug>` y `kick.com/emotes` sin slug da 401, porque es la lista del usuario logueado.
- El único endpoint que enumera los emotes de un canal, `kick.com/emotes/<slug>`, **no está documentado**, y los términos de desarrollador dicen que uno *"will only access Program Materials documented on the Kick Developer Site"*. Usarlo —o scrapear con la cookie de sesión del dueño— pondría su app del lado equivocado del acuerdo. No se hace.

Dato al pasar que confirma la decisión de `mensajes.js`: el array `emotes` del webhook **viene `null` en la práctica** pese a que la doc lo muestra lleno ([KickDevDocs#210](https://github.com/KickEngineering/KickDevDocs/issues/210), cerrada como resuelta). El markup del `content` no es sólo la fuente preferible: es la única que llega.

#### Los nativos de Twitch

`GET helix/chat/emotes?broadcaster_id=` (los del canal: suscriptor, seguidor y tramos de bits) y `GET helix/chat/emotes/global` (Kappa, LUL…) los dan con **un app access token y sin ningún scope** — verificado el 2026-09-23 en `dev.twitch.tv/docs/api/reference`, donde los tres endpoints de emotes dicen literalmente *"Requires an app access token or user access token"* (el único que pide scope es `/emotes/user`, con `user:read:emotes`). **No hace falta pedirle un permiso nuevo a nadie** ni que el creador vuelva a vincular: es el mismo `tokenDeApp()` de `servidor/twitch.js` que trajeron las insignias.

**La caché y los tres vencimientos son los de 7TV, literalmente los mismos**: casillero por creador, una sola bajada en vuelo por casillero, el tope global de seis simultáneas, el plazo sobre la bajada **completa** y el log cuando cambia el estado. El casillero es otro (`<slug>/twitch-nativos`, más `/globales-twitch` para los compartidos), así que un Helix caído no toca las tablas de 7TV ni al revés. Una respuesta **200 con la lista vacía** —un canal que no tiene emotes propios, que es el caso de la mayoría— cuenta como *"no tiene"* y vence **a la hora**, no como un éxito a los diez minutos: con 900 creadores, confundirlas es pasar de 3.600 pedidos por día a 130.000.

**Se piden cuando alguien abre el selector**, no cuando llega un mensaje. Un emote nativo de Twitch ya viene resuelto en el mensaje de EventSub, así que esta tabla no pinta nada: existe sólo para ofrecerlos, y un chat donde nadie abre el panel no le cuesta un pedido a Twitch.

**La URL la arma `mensajes.URL_EMOTE_TWITCH`, y el campo `template` de Helix se ignora a propósito.** Helix manda, al lado de `data`, un `https://static-cdn.jtvnw.net/emoticons/v2/{{id}}/{{format}}/{{theme_mode}}/{{scale}}`; la URL de un emote de Twitch ya la arma `mensajes.js` desde la Fase 1, es la que el chat pinta en cada mensaje y viene funcionando contra el CDN de verdad. Con dos formas de armar la misma URL, el panel mostraría una imagen y el mensaje otra, y una plantilla interpolada a mano es justo donde se cuela el orden equivocado de los placeholders (la doc los enumera "id, format, scale, and theme_mode", que **no** es el orden de la URL). De paso, el navegador se baja una sola imagen: la que ya tiene del chat.

**Los del canal se ofrecen aunque no todos puedan usarlos, y el panel lo dice.** Un emote de suscriptor lo dibuja Twitch sólo para quien está suscripto; a los demás les sale la palabra. Saber quién tiene cuál es `helix/chat/emotes/user`, que pide el scope `user:read:emotes` **a cada espectador**: un permiso nuevo por persona para un adorno no se paga. Así que se ofrecen igual, la nota del panel lo aclara, y lo peor que pasa es que salga la palabra — que es exactamente lo que pasa hoy si alguien la escribe a mano. En la ventana del creador el problema no existe: el streamer tiene todos los suyos desbloqueados.

**Un nombre que es nativo en las dos redes sale en las dos.** Si el chat vio pasar un `[emote:5747892:KEKW]` de Kick y Twitch también tiene un `KEKW`, se ofrece **uno solo**, con la marca de Kick y `redes: ["kick","twitch"]`: a Kick le va el markup, que es lo único que Kick dibuja, y a Twitch le llega la palabra pelada, que allá es su propio emote. Marcarlo como *"en Twitch se lee como texto"* sería mentirle a quien lo elige. Las tres fuentes se deduplican por nombre con el orden Kick → Twitch → 7TV, que es la misma regla que usa `conEmotes` para pintar: ganan los nativos.

**El tope (`TOPE_NATIVOS_TWITCH`, 300 por tabla) es un freno, no una medida.** No se probó contra el Helix de verdad cuántos emotes tiene un canal grande; cada entrada son ~150 bytes.

#### Lo que muestra el panel

Cada emote dice **de qué fuente es** (agrupados, en este orden: "De Kick · los que pasaron por este chat", "De Twitch · del canal y los globales", "De 7TV · del canal y los globales" — Kick primero porque son los que no se pueden buscar en ningún otro lado) y **en qué red va a salir**, en palabras y no sólo con un borde: el color no puede ser el único canal de información. Un emote que no sirve en todas las redes elegidas se ofrece igual pero marcado —esconder los de Kick apenas alguien elige "las dos", que es lo que elige casi todo el mundo, sería esconder justo los que no se consiguen en ningún otro lado— y al usarlo aparece el aviso: *"collectiblesMEGALUL es un emote de Kick: en Twitch va a salir como texto"*. **Se dice antes de mandar, no después**, y también cuando el cambio es del selector de red y no de lo que se escribió, que es el caso fácil de olvidar.

Con **Twitch sola** elegida, los nativos de Kick directamente no se ofrecen: ahí no sirven para nada. Y con **Kick sola**, los nativos de Twitch tampoco.

La nota del panel dice las dos cosas que la lista **no** puede saber: que de Kick sólo están los que pasaron por ese chat, y que los de Twitch que son del canal salen dibujados sólo para quien los tenga desbloqueados.

El emote se inserta **separado con espacios**, y eso no es cosmético: los emotes se resuelven por palabra entera, así que pegado a una letra dejaría de ser un emote. El panel **no se cierra al elegir** (poner tres seguidos es lo normal) y se maneja con teclado: flechas para recorrer, Enter para poner el marcado —o el primero de la lista si no se bajó—, Escape para cerrar devolviendo el foco a la caja.

**La lista se pide la primera vez que alguien abre el panel**, no al cargar la página: quien no lo usa no gasta un pedido. Después no se vuelve a pedir más seguido que cada 30 s.

El botón aparece **con la caja de escribir**, o sea sólo cuando la persona puede escribir. La *lista*, en cambio, no pide sesión: leer el chat nunca pidió login y esto es parte de leerlo.

#### La otra caja: `/chat`, la ventana del creador

El selector estuvo escondido ahí hasta el 2026-09-23, y el motivo era real: esa caja manda por `POST /api/chat/enviar` → `chat.enviar`, que mandaba **el mismo string a las dos redes**. Ofrecer el selector ahí habría mandado markup de Kick a Twitch, justo lo que todo esto viene a evitar.

Ahora `chat.enviar` **importa `envio.comoViajaA`** —la misma función, no una copia— y mide el tope de cada red contra el texto que esa red va a recibir. Con eso, el botón deja de tener motivo para esconderse.

La lista sale de `GET /api/chat/emotes`, que es la hermana de la pública con dos diferencias que no son de estilo:

1. **El slug sale de la sesión**, como en todas las de `/api/chat/` sin slug en el camino.
2. **No mira el interruptor del chat abierto.** Ese interruptor es *"mi comunidad puede escribir desde mi página"*; el creador escribe en su propio chat desde su propia ventana con el chat cerrado, y el selector tiene que seguir andando ahí. La hermana pública, en cambio, con el chat cerrado no cuenta ni un emote: de un chat cerrado no se cuenta nada.

El vocabulario de cada caja se mantiene: la del creador manda `destino: "kick" | "twitch" | "ambos"` (elige entre **sus** canales) y la del espectador `red: "kick" | "twitch" | "ambas"` (elige entre **sus** cuentas). Son dos cosas distintas y por eso son dos palabras distintas.

### Las insignias

En `/chat/<slug>` las insignias se veían como etiquetas de texto: "Broadcaster", "Moderator", "Verified channel". Las de **Twitch** ahora se ven con **la imagen oficial**, la misma que se ve en twitch.tv. Las de **Kick** siguen siendo texto, y eso no es una tarea pendiente: es una decisión, y está explicada abajo.

Se resuelven **en el servidor** (`servidor/insignias.js`), igual que los emotes de 7TV y por el mismo motivo: la página no habla con APIs de terceros. Entran por el mismo array `insignias` del formato único, con una clave `url` nueva.

#### Twitch: de dónde sale la imagen

`GET helix/chat/badges?broadcaster_id=…` da las insignias **propias del canal** (las de suscriptor, una por tramo de meses, y las de bits) y `GET helix/chat/badges/global` las que valen en todos lados (streamer, mod, VIP, Prime, verificado…). Las dos devuelven, por cada `set_id`, una lista de `versions` con su `id` y sus `image_url_1x/2x/4x`.

**No hace falta ningún scope nuevo ni que el creador vuelva a vincular nada.** Los dos endpoints piden *"an app access token or user access token"* y ningún scope ([dev.twitch.tv/docs/api/reference](https://dev.twitch.tv/docs/api/reference/#get-channel-chat-badges)). Se usa un **token de app** (client credentials, uno para todo el proceso) y no el del creador: con el del creador haría falta un vínculo sano —alguien con el refresh vencido se quedaría sin insignias además de sin chat— y sería un camino más que dispara el refresh, que en Twitch **rota** el token en cada uso. El token vive en `servidor/twitch.js` y no sale de ahí.

El `broadcaster_id` sale de `vinculos.identidad()`, sin tocar tokens. **Un creador que no vinculó Twitch no genera un solo pedido**, y tampoco lo genera un mensaje de Kick.

El casamiento es exacto: el mensaje trae `{ set_id, id, info }` y ese `id` es el mismo que `versions[].id`. **El canal le gana a los globales set por set**, no en bloque: un canal que personalizó `subscriber` sigue usando el `moderator` global. Y si el canal tiene ese set pero no esa versión, **no** se cae a la global: se muestra la etiqueta, porque mostrar el escudo genérico de Twitch como si fuera el del canal es peor que no mostrar ninguno.

**Y mientras no se sabe qué tiene el canal, tampoco.** Con la tabla del canal vacía —porque todavía no se bajó, o porque la bajada falló— no hay con qué distinguir *"este canal no personalizó `subscriber`"* de *"no sabemos todavía"*, y hasta el 2026-09-23 el suscriptor salía con el escudo genérico de Twitch como si fuera el de esta comunidad. Estaba anotado como decisión consciente, con este argumento: exigir el casillero confirmado para **todo** haría perder también las globales bien resueltas (mod, VIP, Prime) en esa misma ventana.

Se reevaluó, y el argumento era correcto pero la conclusión no: **no hay que elegir entre las dos cosas**. La tercera opción es preguntar **por set**, que es como funciona el resto de esta función: `helix/chat/badges` sólo devuelve `subscriber` y `bits` (la doc: *"the broadcaster's list of custom chat badges"*, y manda a leer sobre badges de suscriptor y de bits), así que son los únicos dos sets donde la tabla del canal puede cambiar la respuesta. Mientras no se sepa, esos dos se quedan con la etiqueta de texto y **todos los demás se resuelven con la global**, que en ellos es la verdad en cualquier canal.

"No se sabe" sale del estado del casillero —el mismo truco que usa `tablaConRespaldo` en `emotes.js` para no adivinar—, así que un canal que **confirmó** que no tiene sub propio sí usa el genérico: ahí el genérico es lo que se ve en twitch.tv. Y la lista de dos no necesita estar completa para ser correcta: si Twitch agrega una tercera familia personalizable, esa familia se comporta como se comportaba todo antes, así que equivocarse en la lista no empeora nada.

Se pide **`image_url_2x`** (36 px) porque el CSS la muestra a 1,1em, o sea unos 18 px. No hay presupuesto en bytes como el de los emotes y no hace falta: medido el 2026-09-23 contra `static-cdn.jtvnw.net`, las globales pesan entre **320 B y 1.250 B**, y Twitch fija las tres medidas (18, 36 y 72 px, comprobado leyendo el IHDR del PNG) y no acepta animadas. No hay cola cara que cortar.

#### Kick: por qué no hay imagen

**Kick no las publica.** El índice completo de `docs.kick.com/llms.txt` (26 páginas, revisado el 2026-09-23) no tiene una sola página de insignias, emotes ni assets, y la Channels API no devuelve ningún campo de badge. Lo único que existe es `kick.com/api/v2/*`, que es exactamente lo que prohíben los términos de dev.kick.com: *"you will not access undocumented Program Materials … without Kick's prior written permission"* (la cita completa está en `INVESTIGACION-EMOTES.md`, sección 6).

Se probó el plan B —dibujos propios, como los que tiene el repo hermano para su overlay— y **el dueño lo rechazó** (2026-09-23): no quiere íconos inventados en su chat. Así que las de Kick se quedan con su etiqueta de texto hasta que haya una fuente oficial, o hasta que alguien diseñe un set aparte y el dueño lo apruebe.

Por eso `insignias.js` no tiene ninguna rama para Kick: un mensaje de Kick pasa y sale intacto, con `url: ""`. El día que Kick publique un endpoint, lo único que hay que agregar es esa rama; la caché, los vencimientos y el respaldo a texto ya están.

#### Siempre hay texto

`alt` y `title` llevan **siempre** el nombre de la insignia. Una insignia dice quién es esa persona en ese chat: un lector de pantalla tiene que poder decirlo y el que pasa el mouse tiene que poder averiguarlo.

Y si la imagen no carga —un 404, un bloqueador, el CDN caído— la página la reemplaza **en su lugar** por la etiqueta de texto de siempre. Nunca queda un hueco, y nunca se ve peor que antes de este cambio.

La imagen va a **1,1em**, que es la altura que no cambia el alto de línea del chat: la fila del nombre ya mide 1em. Probado con tres insignias seguidas, que es el caso del streamer hablando en su propio canal.

#### Cuándo se refresca

Sin esperar nunca, igual que los emotes: `resolver()` es síncrona, y si la tabla todavía no está el mensaje sale con las etiquetas de texto y la bajada queda agendada. Pasa una vez por creador y por arranque, y menos veces que con los emotes, porque la bajada se agenda recién cuando llega un mensaje de Twitch **con** insignias.

Tres vencimientos, y no son los de los emotes:

| Qué pasó | Vence en | Por qué |
|---|---|---|
| El canal tiene insignias propias | 6 h | Un set de insignias cambia cuando el streamer sube una nueva, que pasa una vez cada mucho. No es un set de emotes, que se toca todas las semanas. Con 900 creadores son unos 3.600 pedidos por día en vez de 130.000 |
| No tiene propias (200 vacío, 400, 404, o sin Twitch vinculado) | 1 hora | Es el caso de la mayoría y es estable, pero el día que alguien se hace afiliado y sube su primera insignia lo nota. Mismo trato que le da `emotes.js` al 404 de 7TV |
| Falló de verdad (timeout, 500, 401) | 1 min | Y **no** se pisa la tabla que había: una insignia vieja es mejor que ninguna |

Un 401 además tira el token de app cacheado, para que el próximo intento pida uno nuevo en vez de repetir el mismo 401 hasta que alguien reinicie el proceso.

El resto de la disciplina es la de `emotes.js`, entera: una sola bajada en vuelo por casillero, tope de seis en todo el proceso, plazo sobre la bajada **completa** y no sólo sobre el `fetch` (la trampa del socket de Mongo que no vence nunca está explicada allá), y log cuando **cambia** el estado, no por mensaje. Se apaga con `INSIGNIAS_TWITCH=0`, que deja el chat exactamente como estaba.

**Lo que no está medido:** el tamaño del bucket de rate limit de Helix. La guía de Twitch documenta las cabeceras `Ratelimit-Limit` / `Remaining` / `Reset` pero no publica el número del bucket por defecto. Con estos vencimientos el peor caso son ~21.600 pedidos por día (unos 15 por minuto), así que el número no debería importar; si algún día importa, está en esas cabeceras.

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

> **APAGADA POR DECISIÓN DEL DUEÑO, 2026-09-22.** Lo que se ofrece hoy es el multichat. Todo lo que dice esta sección sigue siendo cierto y sigue probado: no se borró una línea. Lo que cambió es que hay un interruptor por creador, `salaAbierta`, que **nace apagado para todos** —incluido el dueño del servicio, que por todo lo demás es la excepción de la casa—, y que apagado hace que `/sala/<slug>`, las cuatro rutas de `/api/sala/<slug>/`, la clave de subida, la subida a R2 y el catálogo contesten 404.
>
> **Cómo se vuelve a prender.** La del dueño del servicio, desde `/panel`: aparece la tarjeta «La Sala (ver una peli juntos)» con su interruptor (`POST /api/panel/sala {"abierta": true}`). La de cualquier otro creador, desde `/admin`, con el botón **Abrir** de la columna *Sala* (`POST /api/admin/sala {"slug": "…", "abierta": true}`). Ningún creador puede prender la suya: `/api/panel/sala` le contesta 403. Prender la Sala no toca el plan, así que un creador "pendiente" con la Sala prendida sigue sin reproducir hasta que además tenga plan activo.
>
> **Por qué el dueño no es la excepción acá.** `existe()` sí lo trata aparte, para que su Sala funcione con la colección `creadores` vacía. Copiar ese criterio en el interruptor habría dejado prendida justamente la única Sala que hoy tiene una película puesta, que es la que había que apagar.
>
> **Qué NO se apagó.** El chat abierto entero, que es lo que está en producción: `/chat/:slug`, su manifest, `/api/chat/:slug/*` y el bus `/eventos/:slug`. Ese bus es compartido, así que su evento `estado` dejó de llevar el reloj a quien no sea el dueño de esa sala cuando está apagada: los eventos sin `red` pasan todos los filtros por definición, y sin eso un `curl` seguiría contando qué película quedó puesta.
>
> **Apagarla detiene la película.** El interruptor no escribe sólo el campo: si había algo puesto, difunde `reloj: detenido` por el bus y borra el reloj guardado. Sin eso, quien ya estaba mirando se quedaba con el sobre entero —título, URL de R2 y el instante en que empezó— y la posición la calcula sola la página, así que seguía viendo la peli hasta el final mientras para el servidor esa Sala ya no existía. Y el dueño se quedaba sin palanca: con la Sala cerrada, `POST /api/sala/:slug/reloj` contesta 404 como todo lo demás. Por lo mismo, un deploy **no repone** en memoria el reloj de una Sala apagada.
>
> **Lo que apagar la Sala NO hace: despublicar los archivos.** Los videos siguen en el bucket de R2 y el bucket es público, así que quien ya tenga una URL (`https://pub-….r2.dev/<slug>/<id>/…`) la sigue pudiendo abrir. Es inherente a servir video sin pasar por el servidor, que es la regla de la casa: apagar la Sala cierra el servicio, no el bucket. Para que un video deje de estar accesible hay que borrarlo (`subir.py --borrar`, o la consola de Cloudflare).

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

**Un permiso vencido y un baneo no son lo mismo.** Las dos plataformas contestan **401** cuando el token ya no sirve y **403** cuando esa persona no puede escribir *en ese canal* (baneada, sólo-seguidores, sólo-suscriptores). Sólo el 401 desconecta esa red y le pide que vuelva a conectar; el 403 se le cuenta y no se le toca nada, porque reconectar la cuenta no arregla un baneo. Y **se desconecta sólo esa red**: el espectador es uno solo para todo el dominio, así que un permiso de Kick vencido mientras mira una peli no puede llevarse puesto el Twitch que está usando en `/chat/<slug>`. Si no le queda ninguna red, ahí sí se le cierra la sesión.

**Lo que se mide es lo que viaja.** El tope se comprueba sobre el texto recortado y es ese mismo texto el que sale (`envio.comoViaja`): antes se medía recortado y se mandaba crudo, así que 400 letras y 400 espacios pasaban como 400 caracteres y llegaban a Twitch como 800 —y distintos de los que recibía Kick, que recorta por su cuenta.

Desde los emotes, el mensaje **ya no es el mismo string en las dos redes** (`envio.comoViajaA` traduce el markup de Kick para Twitch), así que **cada tope se mide contra el texto de su red**. La invariante no cambió, se precisó: lo que se mide para una red es lo que se le manda a esa red. Ver "El selector de emotes de la caja".

**Los dos POST del espectador exigen `Origin` nuestro**, tanto en la Sala como en el chat abierto: hacen que alguien escriba con su nombre en el chat de un tercero, o que se quede sin cuenta. La cookie es `SameSite=Lax` y el `Origin` es la otra mitad (`servidor/origenes.js`).

#### Un 200 de Twitch no quiere decir que salió

`POST helix/chat/messages` contesta 200 y adentro dice `is_sent`. Si es `false`, el mensaje **no llegó al chat** (AutoMod, baneado, modo sólo-seguidores, slow mode) y el motivo viene en `drop_reason`. Se lo devolvemos a la persona tal cual: decirle "enviado" cuando no salió es la peor mentira posible de un chat, porque se queda esperando una respuesta que nadie va a ver.

Por eso el resultado de `/api/chat/:slug/enviar` viene **por red** y no como un sí/no global: el caso interesante es el del medio, salió en una y no en la otra. Un "error" pelado ahí haría que la persona lo escriba de nuevo y quede repetido en la red donde sí había salido.

Los baneos, el slow mode y el AutoMod de cada plataforma **se aplican solos**: el mensaje sale como de esa persona, así que Kick y Twitch la tratan igual que si escribiera desde su web.

Debajo del chat hay un **"Suscribirse"**: es un link a `https://kick.com/<canal>/subscribe`, se abre en otra pestaña (`rel="noopener noreferrer"`, así la película sigue corriendo acá) y no hay nada que cobrar de este lado.

El mensaje **no se difunde por el bus**: vuelve por el webhook como cualquier otro. Pintarlo al enviarlo lo mostraría dos veces y encima mentiría si Kick lo retuvo.

#### Cuánto vive una cuenta de espectador

- **"Salir"** borra los tokens de las dos redes y la sesión, en el momento.
- **A los 60 días** sin usarse, se borra sola. Se poda al arrancar, que para este servicio pasa seguido (cada deploy es un arranque), y se barren también los documentos del modelo viejo que nunca se migraron: la migración corre al *leer* un espectador, y al que ya no tiene sesión no lo lee nadie nunca más.
- **Leer un espectador anota que sigue viniendo**, como mucho una vez cada seis horas. Esa escritura **se espera y relee el documento adentro de la cola**: escribe el documento entero, así que con la foto que había leído `leer` —como estaba hasta el 2026-09-22— aterrizaba después de un `conectar` y borraba la red recién conectada. Justo el caso de quien vuelve después de una semana a sumar Twitch, y medido: 20 de 20 veces.

### Moderación propia: bloquear en esta herramienta

El creador toca **bloquear** en un mensaje, en su Chat Global (`/chat`), y esa persona deja de poder escribir en su chat abierto. La lista queda en `/panel`, con un botón para soltarla.

- **Es un bloqueo de acá.** En kick.com y en twitch.tv esa persona sigue escribiendo: ahí manda la moderación de cada plataforma. El panel lo dice con todas las letras, porque creer lo contrario es el error caro.
- **Por id y no por nombre**, porque los nombres se cambian. El nombre se guarda igual, pero sólo para que el creador reconozca a quién bloqueó.
- **Es por sala.** Que Ana bloquee a alguien no lo bloquea en el chat de Beto: cada sala es un inquilino.
- **Pero vale por las dos puertas de esa sala.** `/api/chat/:slug/enviar` y `/api/sala/:slug/chat` caen en el mismo canal de Kick, así que las dos miran la misma lista (`envio.bloqueadasPara`). Hasta el 2026-09-22 sólo la miraba la primera, y al bloqueado le alcanzaba con abrir `/sala/<slug>` para seguir escribiendo con su nombre.
- **El interruptor del chat abierto no calla la Sala.** Son dos productos: `chatAbierto.activo` decide si se ofrece la página pública del Chat Global, y la Sala la abre `salaAbierta`. Atarlos sería además un apagón silencioso, porque el chat abierto **nace cerrado**: toda Sala prendida se quedaría sin caja de escribir sin que su dueño tocara nada.
- **Al bloqueado se le dice, por las dos puertas.** `GET /api/chat/:slug/yo` devuelve en qué redes está bloqueado y `GET /api/sala/:slug/yo` devuelve `bloqueado`, así cada página lo explica en vez de esconderle la caja sin motivo. La de la Sala no lo decía hasta el 2026-09-23 y no era una decisión: el corte ya existía en el envío, y el motivo aparecía recién al mandar un mensaje que no iba a salir. Las dos leen `envio.bloqueadasPara`, la misma que usa el envío, para que la pantalla no pueda decir una cosa y la puerta hacer otra.
- **Quién está bloqueado no sale por ninguna ruta pública**: es del creador.

La escucha del botón vive en la **lista** y no en el botón, porque `/chat` clona el `<li>` para ponerlo en la columna de su red y un clon no se lleva las escuchas: el botón de la columna no haría nada y nadie se enteraría hasta tocarlo.

### El QR del link

`paginas/comun/qr.js` dibuja el QR del link del chat abierto, sin dependencias: modo byte, corrección M, versiones 1 a 10 (hasta 213 caracteres). Lo dibuja el **navegador** y no el servidor porque el link también se arma ahí, con el origen desde el que se mira el panel: si lo armara el servidor, detrás del proxy el QR llevaría al dominio de Railway.

**Está verificado contra un decodificador ajeno, no contra sí mismo.** `herramientas/verificar-qr.mjs` baja jsQR y le da de leer las diez versiones al tope de su capacidad, 300 textos al azar, los links de verdad y textos con acentos y emojis: 328 de 328 volvieron iguales. Esa herramienta sale a internet, así que **no** es parte de `npm test`; la suite guarda la huella del dibujo de un link conocido, y si alguien toca el enmascarado se entera y hay que volver a verificar.

### La clave de subida

`herramientas/subir.py` corre en una terminal, no en un navegador: se autentica con la cabecera **`X-Clave-Subida`** y no con una cookie. La clave se genera y se revoca desde `/panel`, y se guarda **hasheada** (SHA-256), como las sesiones: un volcado de la base no deja subir ni borrar nada. La comparación es `timingSafeEqual`.

La clave autoriza **una sola sala**: si el JSON dice otro `slug`, el servidor contesta 403.

**No se muestra en pantalla.** El dueño trabaja con la transmisión al aire, así que el panel la copia al portapapeles y sólo la muestra si alguien toca "Mostrar igual", con el aviso al lado.

**Borrar el video que se está pasando detiene el reloj.** Si no, la sala se queda pidiendo segmentos que ya no existen en R2: el player no falla con un error claro, se queda cargando para siempre.

### Las métricas

Mensajes por hora (anillo de 24 casilleros con marca de hora, así el de las 3 de la mañana de hoy no se suma al de ayer), envíos, errores 429 y espectadores pico. **Viven en memoria** y se dicen así en pantalla: una escritura en Mongo por cada mensaje del chat, todas las noches, para un número que se mira una vez, no se paga. Un despliegue las pone en cero.
