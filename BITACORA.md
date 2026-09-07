# Bitácora

Una entrada por fase cerrada, la más nueva arriba. Qué quedó, decisiones y por qué, archivos tocados, cómo verlo funcionando, qué quedó pendiente.

---

## 2026-09-06 — Fase 1: los cabos sueltos del cierre

Los siete puntos que la entrada "Fase 1: CERRADA" dejó anotados como
pendientes, cerrados uno por uno. Ninguno era un bug del día: eran agujeros de
red sobre código correcto y puertas que la Fase 2 y la Fase 3 se iban a montar
encima. **238 pruebas en verde** (eran 224), corridas dos veces enteras, y
**once mutaciones aplicadas a mano, once cazadas**: cada arreglo se escribió
con la mutación al lado y el test se reescribió hasta que caía sin el arreglo.

Trabajo hecho en paralelo con la Fase 2, tocando sólo `servidor/chat.js`,
`servidor/twitch.js` y pruebas.

### El pedido de plan B ya no se pierde por coalescencia

`prenderPlanB` levantaba `planBPedido` **después** del `if (prendiendoPlanB)
return`. Un pedido que llegaba con otro en vuelo se colgaba de la promesa
vieja; si en el medio hubo un `apagarPlanB()`, esa promesa vieja despierta con
el pedido ya cancelado y aborta, así que el pedido nuevo no abría nada y nadie
volvía a intentarlo hasta el cambio de estado siguiente: chat de Twitch mudo,
sin plan B y sin un solo error. La bandera ahora se levanta primero.

Que hoy fuera casi inalcanzable dependía de que `ConexionEventSub` ponga
`intentosFallidosSeguidos = 0` **antes** de avisar `conectado`, o sea del mismo
acoplamiento que la guarda de `revisarPlanB` quiso dejar de usar. El test
(`chat-planb.test.js`) hace lo que la clase podría hacer el día que ese orden
cambie: `cortado(9)` → `conectado(9)` → `cortado(9)` en el mismo turno, y exige
una conexión IRC. Sin el arreglo daba cero.

### `parar()` en medio de un prendido, ahora con test

Sacar `planBPedido = false;` de `parar()` sobrevivía las 224 pruebas, y es la
línea que evita que un prendido a medio camino despierte después del apagado y
abra un IRC contra `irc.chat.twitch.tv` con su propio backoff, en un módulo que
ya se dio por apagado y cuyo `conexionIrc` nadie va a volver a mirar. La prueba
nueva pide el plan B, llama a `parar()` antes de que llegue el vínculo, y exige
cero sockets.

### La costura de las conexiones no se fija más a medias

`fijarConexiones({ eventSub })` sin `irc` dejaba la `ConexionIrc` **de verdad**
puesta, y `chat-suscripciones.test.js` fijaba sólo `eventSub`: el día que un
test de ese archivo llegara al cuarto fallo de EventSub, `npm test` abría un TLS
contra Twitch desde la máquina de quien lo corriera, sin que nada lo dijera.
Ahora son las dos o ninguna, y falla **al fijarlas** —que es cuando se puede
leer el error— y no al usarlas, que es cuando el test ya está a mitad de camino
y el error sale como rechazo suelto. `chat-suscripciones.test.js` fija un doble
de IRC que anota si alguien lo pide, y hay una prueba que verifica que nadie lo
pidió.

### El webhook ya no fabrica canales del bus con el slug del payload

`recibirDeKick` sacaba el slug de `broadcaster.channel_slug` y se lo pasaba a
`canales.recordar`, que **crea** el canal que no exista. Era la misma puerta que
la Fase 1 ya había cerrado del otro lado con el `canalPermitido` de
`/eventos/:slug`, abierta de este. Hoy inocuo (sólo entra lo que Kick firma y
sólo está suscripto el canal del dueño); en la Fase 3 es el chat de un canal
cayendo en la sala de otro. Ahora un slug que no es el del dueño sale como
`canal ajeno` y no toca nada.

**Decisión que trae cola:** para que eso funcione, el módulo tiene que saber
cuál es su canal **sin que nadie lo arranque**. `arrancar()` se lo fija, pero
`crearServidor()` no llama a `arrancar()`, y el camino del webhook existe desde
que hay servidor. Así que `chat.js` ahora lee `KICK_SLUG` del entorno al
cargarse, la misma variable y del mismo modo que `index.js`. Es una segunda
lectura de la misma variable, y se prefirió eso a que la puerta quedara abierta
cuando el módulo no fue arrancado. En la Fase 3 esto se reemplaza por resolver
el slug contra la suscripción (`Kick-Event-Subscription-Id`), no adivinando.

### `estado.kick.broadcasterId`: borrado

Se escribía en dos lugares y no lo leía nadie: no sale por `salud()` ni por
ninguna ruta. Misma especie que `kickSospechoso`, que ya se había limpiado por
el mismo motivo. **Se borró en vez de usarlo**, y el motivo es que el dato que
guardaba —un `broadcaster_user_id` suelto a nivel de módulo— es exactamente la
forma equivocada para la Fase 3: ahí la correspondencia entre id de broadcaster
y canal es un índice en `creadores`, no una variable. Dejarlo puesto invitaba a
que la Fase 3 lo leyera y se llevara la suposición de un solo canal adentro.

### Timers de EventSub con `unref()`

`servidor/twitch.js`: el del keepalive (45 s) y el del reintento (hasta 60 s)
venían de la Fase 0 sin `unref`, a diferencia del resto de los timers del
proyecto. Un proceso que ya cerró todo lo demás se quedaba esperando a Twitch en
vez de terminar. La prueba arma los dos con un WebSocket de mentira —sin red y
sin esperar— y mira `hasRef()`.

### Los tres agujeros de cobertura

- **El tope de Twitch se cuenta en puntos de código.** Dos pruebas, una por
  lado: 80 familias de emoji son 80 caracteres para Kick y 560 para Twitch (se
  rechaza, y con destino `ambos` no sale en ninguna de las dos); 300 emojis
  sueltos son 300 puntos de código y 600 unidades UTF-16 (pasa). Contarlo como
  lo cuenta Kick, o contar `texto.length`, ahora se cae.
- **El `Number(s.version)` de `verificarKick`.** El fixture usaba números y
  nunca miraba el caso `"1"`. Sin el `Number(...)`, la verificación creería que
  faltan las dos suscripciones y las volvería a crear cada cinco minutos, para
  siempre, contra la cuota de Kick.
- **Las tres traducciones dan el mismo juego de claves.** `deKick`, `deTwitch`
  y `deIrc` eran idénticas "verificado a mano": agregarle una clave a una sola
  sobrevivía las 224 pruebas. Y la que rompe es la tercera, `deIrc`, que es el
  plan B: una clave que exista en dos de las tres se descubriría justo la noche
  en que todo lo demás también está mal.

### Archivos tocados

`servidor/chat.js`, `servidor/twitch.js`, `pruebas/chat-planb.test.js`,
`pruebas/chat-suscripciones.test.js`, y dos archivos nuevos:
`pruebas/chat-cabos.test.js` y `pruebas/mensajes-forma.test.js`.
`servidor/mensajes.js` **no se tocó**: la prueba de las claves mira, no cambia.

### Cómo verlo

`npm test` (238 en verde). Para ver que la red atrapa: sacar
`planBPedido = false;` de `parar()`, o el `if (slug !== slugDueno)` de
`recibirDeKick`, o un `.unref?.()` de `twitch.js`, y correr de nuevo.

### Qué queda pendiente

De la lista de la entrada anterior quedan dos agujeros de cobertura que viven
en archivos de la página y no se tocaron acá: la poda de 300 mensajes por lista
y la validación del color antes del `style`. Y la decisión de comportamiento que
sigue abierta: con destino `ambos`, un mensaje que Kick aceptaría pero Twitch no
ya no sale en ninguna de las dos. Si molesta, se cambia.

---

## 2026-09-06 — Fase 1: CERRADA

Escrito por el director. La segunda verificación adversarial **no encontró
ninguna falla que bloquee**, y lo dijo explícito. Cómo lo verificó: `npm test`
seis veces (224/224, una de ellas en serie), **64 mutaciones propias** sobre una
copia limpia de HEAD, un reproductor propio de la carrera del plan B con cinco
escenarios, y el servidor levantado a mano para mirar el cable SSE de verdad.

Su reproductor mata el código viejo y no puede con el nuevo: 40 cambios de
estado seguidos daban **40 conexiones IRC, 39 imposibles de cerrar**; ahora dan
1 y ninguna queda viva tras `parar()`.

De sus 64 mutaciones, 49 caen. Las 15 que sobreviven **no son bugs**: son
agujeros de red sobre código correcto. La tabla de "21 de 21" de la entrada de
los arreglos es cierta para esas 21; con 64 la red tiene 15 huecos. Queda dicho
para que nadie lea "21 de 21" como cobertura total.

### Lo que queda pendiente de la Fase 1 (no bloquea, sí conviene cerrarlo)

- **El pedido de plan B se puede perder por coalescencia** (`servidor/chat.js:393-399`):
  si `prenderPlanB` se llama mientras hay otro en vuelo devuelve la promesa
  vieja sin volver a poner `planBPedido = true`, y si en el medio pasó un
  `apagarPlanB()` el pedido nuevo se pierde. Hoy es casi inalcanzable, pero
  **por una razón incómoda**: `ConexionEventSub` pone `intentosFallidosSeguidos = 0`
  antes de avisar `conectado`. O sea que la corrección depende justo del
  acoplamiento que el arreglo quiso evitar.
- **La segunda mitad del arreglo de F1 no tiene test**: sacar
  `planBPedido = false` de `parar()` (`chat.js:156`) sobrevive las 224 pruebas,
  y es la línea que evita que quede un IRC vivo después de apagar.
- `estado.kick.broadcasterId` es **estado muerto**: se escribe en dos lugares y
  no lo lee nadie. Misma especie que `kickSospechoso`, que ya se limpió.
- `fijarConexiones({eventSub})` sin `irc` cae en la `ConexionIrc` de verdad
  (`chat.js:96-99`), y `pruebas/chat-suscripciones.test.js:149` sólo pasa
  `eventSub`: si esa prueba algún día dispara el plan B, abre un TLS real contra
  `irc.chat.twitch.tv`. Trampa para la fase que viene.
- **El webhook puede crear canales del bus con cualquier slug del payload**
  (`chat.js:257` → `canales.recordar`), salteando el `canalPermitido` que la
  Fase 1 puso en `/eventos/:slug`. Hoy inocuo; en la Fase 3 es la misma puerta,
  del otro lado.
- Timers sin `unref()` en `servidor/twitch.js:419` y `:464`. Vienen de la Fase 0.
- Agujeros de cobertura menores: la poda de 300 mensajes por lista, la
  validación del color antes del `style`, el tope de Twitch en puntos de código,
  el `Number(s.version)` de `verificarKick`, y que las tres traducciones tengan
  el mismo juego de claves (son idénticas hoy, verificado a mano).

### Una decisión que cambió de comportamiento

Con destino `ambos`, un mensaje que Kick aceptaría (400 grapheme clusters) pero
Twitch no (600 puntos de código) **ya no sale en ninguna de las dos**. Es lo que
dice la decisión escrita ("validar antes de mandarle nada a ninguna"), pero
antes salía en Kick. Si molesta, se cambia.

---

## 2026-09-06 — Fase 1: los arreglos de la verificación

La carrera está arreglada, los seis agujeros de cobertura cerrados y las dos
decisiones del aviso tomadas. **224 pruebas en verde** (eran 175), corridas
cuatro veces. Y lo que importa más que el número: **21 mutaciones aplicadas a
mano sobre una copia del árbol, 21 cazadas**. Un test que pasa contra el
código roto no es una red de seguridad, así que cada arreglo se escribió con
su mutación al lado.

Trabajo hecho en paralelo con el script de subida (la entrada de abajo),
tocando sólo `servidor/`, `paginas/` y `pruebas/`.

### F1 — la carrera del plan B (el único bug de verdad)

`prenderPlanB` era un check-then-act partido por un `await`: chequeaba
`if (conexionIrc) return`, pedía el vínculo de Twitch, y recién después
reservaba el lugar. `revisarPlanB()` sale de **cada** cambio de estado de
EventSub, y los estados vienen de a pares sin ceder el control (el corte y el
`conectando` del reintento): los dos pasaban la guarda, se creaban dos
`ConexionIrc`, y la primera quedaba conectada a `irc.chat.twitch.tv:6697`
**para siempre**, con su propio backoff. Ni `apagarPlanB()` ni `parar()` la
alcanzaban: las dos cierran `conexionIrc`, que ya era la segunda.

Ahora el lugar se reserva **antes** de ceder el control, con dos variables:
`prendiendoPlanB` (la promesa del prendido en curso, para que el segundo
llamado se cuelgue del primero en vez de arrancar otro) y `planBPedido` (para
que un prendido a medio camino no abra nada si EventSub volvió mientras se
leía el vínculo). `parar()` y `apagarPlanB()` bajan la bandera.

De paso, `revisarPlanB` no prende el plan B si EventSub dice `conectado`. La
clase pone el contador de fallos en cero al recibir el welcome, pero depender
de eso significa que el día que cambie, el plan B se prende justo después de
apagarse.

### F2 — el plan B, orquestado (`pruebas/chat-planb.test.js`)

`irc.test.js` probaba la clase; el entregable 6 es la decisión de `chat.js`, y
eso no tenía nada. Ocho pruebas nuevas: el umbral (con 3 no prende, con 4 sí),
el apagado cuando EventSub vuelve, que `parar()` cierre el IRC, que los
mensajes del plan B entren por el mismo camino con el mismo dedupe, y las dos
mitades de la carrera.

**La costura que faltaba:** `chat.fijarConexiones({ eventSub, irc })` cambia
con qué se abren las dos conexiones de Twitch. No es ceremonia: llegar al
cuarto fallo de EventSub de verdad son más de quince segundos de backoff, y
sin costura la única forma de probar el plan B sería abrir un socket contra
Twitch. En los tests, EventSub va por un doble (hay que provocar estados con N
fallos acumulados) y el **IRC va por la clase de verdad** con un `abrirSocket`
de mentira, que es la costura que la clase ya tenía: así lo que se cuenta son
conexiones reales abiertas y cerradas, no llamadas a un método de un doble.

### F3 — suscripciones y verificación (`pruebas/chat-suscripciones.test.js`)

Trece pruebas donde había cero. Se reemplaza `fetch` por un router chico que
contesta como Kick y anota qué se le pidió. Cubre: que `suscribirEventos` cree
sólo lo que falta, que `verificarKick` resuscriba cuando falta una y **no**
mienta diciendo "activa" sin haber mirado, que al arrancar con token de Twitch
guardado se reconecte solo, y que la verificación se repita cada cinco minutos
(con timers de mentira, sin esperar).

### F4 — el camino 429

Dos pruebas HTTP nuevas con el vínculo guardado de verdad y la API de Kick
falseada: un 429 de la plataforma sale como 429 con `Retry-After: 5` y
`esperar: 5`, y un 403 sigue saliendo como 502. Del lado de la página, otra
prueba comprueba que el 429 arranca la cuenta regresiva y que insistir mientras
tanto no manda nada. Si la página reintentara sola, empeoraría el rate limit
que la plataforma acaba de avisar.

### F5 — la página, probada de verdad (`pruebas/pagina-chat.test.js`)

691 renglones que deciden todo lo que se ve y no tenían un solo test: el bug de
la lista que quedaba vacía al cambiar de vista lo encontró una persona mirando
la pantalla. Veinticuatro pruebas nuevas sobre `pruebas/fijos/dom-falso.js`, un
DOM chico con tres decisiones que son las que hacen que el test no mienta:

1. **El árbol sale de `paginas/chat.html` de verdad**, parseado, no de una
   maqueta escrita en el test. Si alguien saca un id, los tests se caen.
2. **`innerHTML` no existe y tira.** El texto de un mensaje lo escribe gente
   desconocida y la página lo pone con `textContent` a propósito; si alguien
   vuelve a `innerHTML`, el test explota en vez de pasar. (Comprobado: esa
   mutación tira nueve pruebas.)
3. **Se corre el archivo real con `node:vm`**, y los scripts que la página
   carga sola (`chat/demo.js` para `?demo=1`) se cargan de verdad.

Cubre las tres listas, el filtro, la pausa del scroll con su contador, los
emotes con un emoji adelante, la salud, la caja de envío, el 429 y `?demo=1`
(que no toca la red: es para diseñar sin backend).

### F6 — una sola fuente de verdad para el aviso

`chat.kickSospechoso()` era código muerto: estaba probado y no lo llamaba
nadie. Y la página tenía **otra regla** para lo mismo: el servidor considera
sospechoso "en vivo y nunca llegó un mensaje", la página exigía que hubiera
llegado al menos uno. O sea que en el único caso para el que el aviso existe
—la URL del webhook sin cargar, donde no llega ni el primero— la banda no
aparecía nunca.

Ahora el veredicto viaja hecho: `salud().kick.sospechoso`. La página lo
muestra y la regla duplicada se borró. Es un campo nuevo del contrato de
`/api/chat/salud`, documentado en el README.

### F7 — la salud no vuelve al bus

Dos pruebas enganchan un cliente SSE de verdad al canal
(`pruebas/fijos/bus-falso.js`) y recorren todo lo que cambia la salud —
arranque, prendido y apagado del plan B, mensajes de las dos redes, el canal
en vivo — para después mirar qué salió por el cable: sólo `estado` y `chat`.
Reintroducir `canales.difundir(slug, {tipo:'salud'})` ahora rompe un test.

### D2 — el "está en vivo" sale de la API, no del webhook

Era lo más importante de la tanda y es un cambio de diseño, no un test.
`livestream.status.updated` avisa en las **transiciones**: un deploy en medio
del stream —o sea, la forma normal de trabajar acá: push a main es deploy—
dejaba `vivo` en `false` el resto de la noche, y en el caso que motiva el aviso
no llega ningún webhook, así que `vivo` nunca podía ser `true`. El aviso que
existe para detectar "no llegan webhooks" dependía de que llegaran webhooks.

Ahora el ciclo de cinco minutos consulta `GET /public/v1/channels` (que ya se
leía en `canalPorSlug()`, pero no la llamaba nadie) y cachea el resultado. El
webhook sigue siendo la vía rápida; la que manda es la API. Si la API no
contesta no se pisa lo que se sabía: que Kick tenga un mal minuto no es "se
apagó el stream". `canalPorSlug` ahora acepta un token opcional y el chequeo le
pasa el del dueño, que ya tiene en la mano: así no depende de que estén
cargadas las credenciales de app.

### D1 — el aviso se puede cerrar

Canal en vivo de madrugada y nadie hablando: la condición se cumple toda la
noche y la banda roja no se podía sacar. Ahora tiene su `×`, como el aviso de
envío. Cerrado se queda cerrado **mientras la condición siga igual**; si se
resuelve y vuelve a aparecer, el aviso vuelve. Tocar "Resuscribir" también lo
rearma. No se esconde para siempre: hay una prueba que lo exige.

### Lo chico que entró de paso

- **D7.** El tope de Twitch se validaba sólo con destino `twitch`. Los dos
  topes dicen 500 y no son el mismo número: Kick cuenta grapheme clusters y
  Twitch cuenta puntos de código, así que una familia de emojis es un carácter
  para uno y cinco para el otro. Con destino "ambos" el mensaje salía en Kick y
  Twitch lo rechazaba con un 400: el error llegaba tarde y en kick.com ya
  estaba. Ahora se valida el tope de cada red **antes** de mandarle nada a
  ninguna.
- **D8.** `chat-http.test.js` tardaba **308 segundos** en fallar cuando fallaba:
  `await r.text()` contra un SSE que no termina nunca. Ahora todos los pedidos
  del archivo llevan tope de 5 s y el status se mira antes de leer el cuerpo.
  Con la validación de slug rota, el test falla en 50 ms.
- **D9.** El ejemplo de SSE del README mostraba un `{"tipo":"kick",…}` que ya
  no emite nadie.
- **D12.** `chat.arrancar()` es idempotente: un segundo llamado pisaba
  `timerVerificacion` y dejaba el `setInterval` viejo corriendo para siempre,
  sin nadie que pudiera apagarlo.

### Las 21 mutaciones, y qué las caza

Cada una se aplicó sobre una copia limpia del árbol y se corrió la suite encima.

| Mutación | La caza |
|---|---|
| `prenderPlanB` sin reservar el lugar (el bug original) | 2 pruebas de `chat-planb` |
| plan B sin umbral (`prenderPlanB()` incondicional) | 2 |
| `apagarPlanB()` con `return` inmediato | 2 |
| `parar()` no cierra el IRC | 2 |
| difundir la salud por el bus | 1 |
| `verificarKick`: `if (!falta.length)` → `if (true)` | 1 |
| `suscribirEventos`: `if (faltan.length)` → `if (false)` | 2 |
| sacar el cruce con la API de Kick (el "en vivo") | 2 |
| `arrancar` sin `clearInterval` | 1 |
| `arrancar` sin `conectarTwitch` | 1 |
| el 429 del servidor → `if (false)` | 1 |
| sacar la validación de slug de `/eventos/:slug` | 1, **en 50 ms** |
| `salud()` sin `sospechoso` | 2 |
| el tope de Twitch sólo con destino `twitch` | 1 |
| el mensaje a una sola lista según la vista | 2 |
| la página recalcula el aviso con su regla vieja | 3 |
| cerrar el aviso lo esconde para siempre | 1 |
| el 429 de la página sin cuenta regresiva | 1 |
| el texto del mensaje con `innerHTML` | 9 |
| subir el scroll ya no pausa | 1 |
| el filtro de la vista mezclada no hace nada | 1 |

### Cómo verlo funcionando

```bash
npm test                                  # 224 pruebas
npm run local                             # y abrir /chat?demo=1
```

Se miró además en el navegador (`/chat?demo=1`): la banda roja aparece con su
`×`, cerrarla la cierra y no vuelve sola, y al pasar a columnas el historial
está en las dos.

### Pendiente, sin cambios

- **Nada de esto tocó una API real.** Sigue valiendo entera la lista de "lo que
  hay que verificar cuando estén las credenciales" de la entrada de la Fase 1.
- El bus público lleva el chat de Twitch del dueño (`chat.js` hace `recordar`
  también para Twitch y `/eventos/istincho` no pide sesión). Se decide en la
  Fase 2, cuando la audiencia de la peli escuche ese bus.
- `/api/estado` sigue público.
- El plan B no se probó contra el IRC real de Twitch: los tests usan un socket
  de mentira, así que el TLS y el handshake real siguen sin cubrir.
- `pruebas/fijos/chat-mensaje.json` cambió `{s:20,e:44}` por `{s:19,e:43}` en la
  Fase 1. La corrección es correcta (verificada contra el ejemplo oficial de
  Kick) y queda anotada acá por la regla de traspaso entre fases.

### Archivos tocados

Nuevos: `pruebas/{chat-planb,chat-suscripciones,pagina-chat}.test.js`,
`pruebas/fijos/{bus-falso,dom-falso}.js`.
Editados: `servidor/{chat,kick}.js`, `paginas/chat.html`,
`paginas/chat/{chat.js,chat.css,demo.js}`,
`pruebas/{chat,chat-http}.test.js`, `README.md`, `BITACORA.md`.

---

## 2026-09-06 — Fase 2, pieza 1: el script de subida

`herramientas/subir.py` completo: convierte un archivo de video a HLS, lo sube
a R2 y le avisa al servidor. Es la única parte del proyecto en Python y corre
en la PC del dueño, no en Railway. 57 pruebas en verde y 21 de 21 mutaciones
cazadas. **No se pudo probar contra R2 de verdad**: el bucket todavía no
existe (tareas 9 y 10 de `TAREAS-DUENO.md`).

Trabajo hecho en paralelo con el arreglo de la Fase 1, tocando sólo
`herramientas/`.

### Lo que quedó funcionando

- `herramientas/subir.py`:
  - `python herramientas/subir.py "S01E03.mkv"` hace los cinco pasos:
    revisa el archivo con ffprobe, convierte con un solo ffmpeg a 720p
    (2500k) y 1080p (5000k) con segmentos de 6 s y playlist maestra, saca los
    subtítulos de texto a WebVTT, sube todo a `istincho/<id>/` y hace
    `POST /api/videos`.
  - `--listar` agrupa lo que hay en R2 por id y dice cuánto queda de los
    10 GB. `--borrar <id>` borra de R2 y del servidor, pidiendo confirmación.
  - `--avisar <id> --duracion <s>` reintenta sólo el paso 5, para cuando la
    subida salió bien y el servidor estaba caído.
  - `--solo-preparar` convierte sin subir y sin necesitar credenciales.
  - Progreso: una barra por fase con porcentaje y tiempo restante. La de
    ffmpeg sale de `-progress pipe:1`; la de la subida, del `Callback` de
    `upload_file`.
  - Si falta ffmpeg, ffprobe o boto3, o falta una variable, sale con una
    línea que dice qué instalar o qué completar. Nunca un stack trace, nunca
    un valor del `.env` impreso.
- `herramientas/requirements.txt`: `boto3>=1.36,<2`, y nada más. El repo de
  Node sigue con `mongodb` como única dependencia.
- `herramientas/.env.ejemplo`: los nombres exactos de las ocho variables
  (`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`,
  `R2_URL_PUBLICA`, `URL_SERVIDOR`, `CLAVE_SUBIDA`, `SALA_SLUG`), que era lo
  que la tarea 10 dejaba pendiente. Reescrito por shell: la regla
  `Read(./**/.env.*)` del `settings.json` tapa también los `.env.ejemplo`.
- `herramientas/LEEME.md`: cómo preparar la PC y los tres comandos de la
  noche.
- `herramientas/pruebas_subir.py`: 57 pruebas con `unittest` de la biblioteca
  estándar. No hizo falta pytest.

### Decisiones y por qué

**1. Nunca agrandar.** Si el archivo es 720p, no se genera el 1080p: sería un
upscale que ocupa el doble en un bucket de 10 GB y no se ve mejor. Si el
archivo es más chico que 720p, sale una sola calidad a la altura de la fuente
(redondeada a par, que es lo que acepta libx264 con yuv420p). Se aparta de la
letra del prompt ("dos calidades"), que asume material de 1080p.

**2. Los subtítulos no pasan por el HLS de ffmpeg.** Meter los subtítulos en
el `var_stream_map` es frágil. En su lugar, cada pista de texto sale como un
WebVTT entero, con una playlist de un solo segmento, y la maestra se reescribe
agregando los `#EXT-X-MEDIA` y un `SUBTITLES="subs"` en cada calidad. Es el
patrón que entiende hls.js. Las pistas de imagen (PGS de Blu-ray, VobSub de
DVD) se saltean con aviso: pasarlas a texto necesita OCR.

**3. `-force_key_frames expr:gte(t,n_forced*6)`.** Sin un keyframe justo en
cada corte, ffmpeg estira los segmentos más allá de 6 s y el reloj de la sala
pierde precisión para saltar a un segundo exacto.

**4. La maestra se sube última, y sola.** Todo lo demás va en paralelo (6
hilos). Mientras la maestra no exista, nadie puede empezar a mirar un video a
medio subir aunque adivine la URL.

**5. `Cache-Control: public, max-age=31536000, immutable` en todo.** Cada
video vive bajo un id nuevo, así que ningún objeto cambia jamás de contenido.
Menos lecturas repetidas de R2 es menos consumo de las 10 millones gratis.

**6. Cada archivo con su `Content-Type`.** `.m3u8` como
`application/vnd.apple.mpegurl`, `.ts` como `video/mp2t`, `.vtt` como
`text/vtt`. Si van como `application/octet-stream`, hls.js no reproduce.

### Tres cosas de R2 que costaron y quedan anotadas

**A. boto3 >= 1.36 rompe las subidas a R2 si no se lo apaga.** Desde esa
versión, boto3 calcula y manda un checksum CRC32 en cada `PutObject` y
`UploadPart`. R2 **no implementa** esos encabezados
(`x-amz-sdk-checksum-algorithm`, `x-amz-checksum-*`): sólo soporta CRC-64/NVME
de objeto completo. `crear_cliente` arma el `botocore.config.Config` con
`request_checksum_calculation="when_required"` y
`response_checksum_validation="when_required"`. Hay una prueba que mira los
encabezados que salen por el cable y falla si alguien saca ese Config.
Fuentes: [boto3#4392](https://github.com/boto/boto3/issues/4392),
[developers.cloudflare.com/r2/api/s3/api](https://developers.cloudflare.com/r2/api/s3/api/).

**B. Endpoint por cuenta, región `auto`.** `https://<account
id>.r2.cloudflarestorage.com`, no por bucket, y `region_name="auto"` siempre.

**C. Nada de ACL ni `ChecksumAlgorithm`.** R2 no los implementa; el bucket se
hace público desde el panel (tarea 9), no por objeto.

### Un bug de Windows que sólo aparece corriendo el script

**ffmpeg en Windows escribe `720p\lista.m3u8` en la playlist maestra**, con
barra invertida. En una URL la barra invertida no separa carpetas: el
navegador pediría `720p%5Clista.m3u8` y R2 contestaría 404. El video no
arrancaría y el error no diría por qué. `normalizar_uris()` pasa todas las
playlists a barras normales antes de subir. No lo encontró ningún test: salió
de correr ffmpeg de verdad y mirar el archivo. La prueba se escribió después.
Lo mismo con las claves de R2: `clave_r2()` nunca usa `os.path.join`.

Y un error del propio ffmpeg: `var_stream_map` quiere `name:720p`, con dos
puntos. Con `name=720p` contesta `Invalid keyval` y no escribe nada.

### Cómo verlo funcionando

```bash
python herramientas/pruebas_subir.py     # 57 pruebas
```

Sin credenciales de ningún tipo, con un archivo de video cualquiera:

```bash
python herramientas/subir.py "algo.mkv" --solo-preparar
```

Deja `hls-<id>/` con la maestra, `720p/`, `1080p/` y `subtitulos/`. Se puede
mirar con VLC abriendo `maestra.m3u8`.

Lo que se probó de la subida en sí (`pruebas_subir.py`, clase
`PruebaContraDobleS3`): un cliente **boto3 de verdad** contra un doble local
del API S3 levantado con `http.server`, que habla PUT, GET, `list-type=2` y
`DeleteObjects`. Eso ejercita la firma SigV4 y los encabezados que salen por
el cable. Además se corrió el circuito entero —video real, ffmpeg, subida,
`POST /api/videos`, `--listar`, `--borrar`— contra ese doble más un servidor
HTTP de mentira, y salió bien de punta a punta.

### Qué queda sin verificar

- **Nada se probó contra R2 de verdad.** No existe el bucket. Lo que puede
  fallar y el doble local no ve: que R2 acepte exactamente estos encabezados,
  el CORS del bucket (tarea 9; sin él hls.js no carga nada), y que la URL
  `r2.dev` sirva los `.ts` con el `Content-Type` que guardamos.
- **Subidas multiparte.** `upload_file` parte solo los archivos de más de
  8 MB. Los segmentos de 6 s pesan bastante menos, así que en la práctica no
  se usa, pero tampoco está probado: los archivos del doble local son chicos.
- **Un archivo de 2 GB de verdad.** El tiempo de ffmpeg, la memoria y el
  comportamiento de la barra con miles de archivos están probados con clips
  de 14 segundos.
- **Que ffmpeg encuentre los subtítulos en un .mkv real de una serie.** Se
  probó con un mkv armado a mano con una pista SRT.

### Lo que necesita el agente que cierre la Fase 2

El script ya llama a estas dos rutas; hay que escribirlas en `servidor/`. No
las escribí yo para no pisar el trabajo de la Fase 1.

1. **`POST /api/videos`**, autenticada con la cabecera **`X-Clave-Subida`**
   (no cookie: el script corre en una terminal). Cuerpo JSON:

   ```json
   {
     "id": "s01e03",
     "slug": "istincho",
     "titulo": "S01E03",
     "duracion": 2712.048,
     "url": "https://pub-….r2.dev/istincho/s01e03/maestra.m3u8",
     "calidades": [720, 1080],
     "subtitulos": [{"idioma": "spa", "nombre": "Espanol"}],
     "bytes": 1633665787
   }
   ```

   Guarda en la colección `videos`. Repetir el mismo `id` tiene que pisar la
   entrada, no duplicarla: el script se puede correr dos veces. Cualquier
   respuesta >= 400 hace que el script diga cómo reintentar con `--avisar`.

2. **`DELETE /api/videos/:id`**, misma cabecera. Un **404** no es error para
   el script: significa "el servidor no lo tenía" y sigue.

3. **La clave de subida se genera y se revoca en `/panel`** (entregable 4 de
   la Fase 2). Guardarla **hasheada**, como las sesiones. El dueño la copia
   una vez a `herramientas/.env` como `CLAVE_SUBIDA`.

4. Si el reloj de sala está reproduciendo un video y llega el `DELETE` de ese
   mismo id, hay que detener el reloj: si no, la sala queda pidiendo segmentos
   que ya no existen.

### Archivos tocados

Nuevos: `herramientas/{subir.py,pruebas_subir.py,requirements.txt,LEEME.md}`.
Editados: `herramientas/.env.ejemplo` (reescrito con los nombres definitivos),
`BITACORA.md`. Nada de `servidor/`, `paginas/` ni `pruebas/`.

---

## 2026-09-06 — Verificación de la Fase 1: NO PASA

Escrito por el director, no por un agente de fase. La Fase 1 está construida y
commiteada, pero **no cerrada**: un verificador adversarial la revisó con
mutación sobre HEAD (18 mutaciones) y encontró un bug real y cinco agujeros de
cobertura. No se pushea nada de la Fase 1 hasta arreglar esto.

Los 175 tests están en verde y no son flakey (5 corridas). El problema no es lo
que prueban, es lo que no.

### Falla real (un bug, no una omisión)

**F1. Carrera en `prenderPlanB` (`servidor/chat.js:298-315`): quedan dos
conexiones IRC vivas y una es imposible de cerrar.** Es un check-then-act
partido por un `await`: se chequea `if (conexionIrc) return` en la línea 299 y
recién se reserva el lugar en la 310, con un `await vinculos.leer('twitch')` en
el medio. `revisarPlanB()` se llama desde cada `alEstado`, así que dos cambios
de estado seguidos mientras el `findOne` está en vuelo pasan los dos la guarda.
`conexionIrc` apunta a la segunda y la primera queda conectada a
`irc.chat.twitch.tv:6697` para siempre: ni `apagarPlanB()` ni `parar()` la
alcanzan, y reconecta sola con su propio backoff. Reproducido con dobles de
`irc.js`, `twitch.js` y `vinculos.js`.

### Agujeros de cobertura (mutaciones que ningún test caza)

- **F2. El plan B no tiene ni un test de orquestación.** `irc.test.js` prueba la
  clase sola; el entregable 6 es la orquestación en `chat.js`, y ahí no hay
  nada. Sobreviven tres mutaciones: prender el plan B sin umbral, no apagarlo
  nunca cuando EventSub vuelve, y que `parar()` no cierre el IRC. Además
  `chat.js` no tiene costura para testearlo: construye `ConexionIrc` y
  `ConexionEventSub` sin pasarles `abrirSocket` / `url`, que es justo lo que los
  tests de esos módulos usan para no salir a internet.
- **F3. El entregable 2 (suscripciones y verificación cada 5 min) no tiene
  ningún test.** Cero apariciones de `verificarKick`, `conectarTwitch`,
  `chat.arrancar`, `suscribirEventos` en `pruebas/`. Sobreviven: que
  `verificarKick` nunca resuscriba y diga siempre "activa", y que
  `suscribirEventos` no cree ninguna suscripción.
- **F4. El camino 429 no tiene test**, y el prompt lo pide en letra.
- **F5. La página entera (691 renglones) tiene cobertura cero.** Ningún archivo
  de `pruebas/` menciona `paginas/chat/chat.js` ni `demo.js`. El bug de la lista
  vacía al cambiar de vista —que el agente encontró mirando la pantalla, no con
  los tests— está arreglado, pero sin red que lo sostenga.
- **F6. `chat.kickSospechoso()` es código muerto y contradice a la página.**
  Está exportado y probado, pero ninguna ruta lo llama y `salud()` no lo
  incluye. La regla real vive en `paginas/chat/chat.js:427` y **no coincide**:
  el servidor considera sospechoso "en vivo y nunca llegó un mensaje", la página
  exige que haya llegado al menos uno. Los tests afirman un comportamiento que
  en pantalla no existe.
- **F7. La decisión de sacar la salud del bus SSE no tiene test que la
  proteja.** Volver a difundirla por el bus público no rompe nada.

### Dos problemas de diseño del aviso de los 5 minutos

**D1. Falso positivo de madrugada.** Canal en vivo y nadie hablando: a los 5
minutos aparece la banda roja de "resuscribir" y se queda toda la noche. No
tiene botón de cerrar, a diferencia del aviso de envío.

**D2. Falso negativo total, que es peor.** `estado.kick.vivo` sale sólo del
webhook `livestream.status.updated`, que Kick emite **en las transiciones**. Dos
consecuencias: un redeploy en medio del stream (o sea, la forma normal de
trabajar acá: push a main = deploy) deja `vivo` en `false` el resto de la noche;
y en el caso que motiva el aviso —la URL del webhook sin cargar a mano, tarea
4 bis— no llega ningún webhook, así que `vivo` nunca es `true` y **el aviso no
puede aparecer nunca**. El dato existe y ya está a mano: `GET /public/v1/channels`
devuelve `stream.is_live` y `servidor/kick.js:277` lo lee en `canalPorSlug()`,
pero nadie llama a esa función. El chequeo debería cruzarse con la API, no con
el webhook.

### Lo que el verificador sí confirmó

- El **formato único** es idéntico en los tres traductores, mismas claves y
  mismo orden, y los índices de emote son puntos de código con fin exclusivo
  (probado con acentos y con un emoji fuera del plano básico).
- **No se reintrodujo `event: <tipo>`** en el cable SSE.
- `/eventos/:slug` **valida el slug** (era una nota pendiente de la Fase 0).
- `/chat?demo=1` se ve completa de verdad, con el XSS quedando como texto
  literal.
- La decisión de **sacar la salud del bus** se sostiene: `/api/chat/salud` da
  401 sin cookie, con cookie de espectador y con firma adulterada, y la misma
  información no se filtra por otro lado.
- Que **la API de Kick no expone el estado de una suscripción** es cierto: la
  respuesta de `GET /public/v1/events/subscriptions` no tiene ningún campo de
  estado. La premisa del agente era correcta; lo que falla es el cruce (D1, D2).
- El plan B, salvo la carrera: umbral correcto (con 3 no prende, con 4 sí),
  EventSub sigue reintentando por debajo, sólo lectura confirmado (no hay un
  solo `PRIVMSG` de salida), puerto y TLS correctos.
- Sin dependencias nuevas (`git diff` de `package.json` vacío), sin secretos en
  el árbol, cookies correctas, tokens cifrados, el servidor no sirve video.
- **La preocupación de la bitácora sobre el scope de Twitch es infundada:** la
  documentación de *Send Chat Message* pide `user:write:chat`, que ya está en
  `SCOPES_DEFECTO`. No hace falta `chat:edit`.

### Para la próxima sesión

Arreglar F1 y cubrir F2 a F7, decidir D1 y D2, y recién ahí cerrar la fase y
pushear. Quedan además anotadas para más adelante: el bus público lleva el chat
de Twitch del dueño (a revisar en la Fase 2, cuando la audiencia de la peli lo
escuche), `/api/estado` sigue público, el tope de Twitch no se aplica cuando el
destino es "ambos", y el ejemplo de SSE del README quedó viejo (menciona un tipo
`kick` que ya no emite nadie).

---

## 2026-09-06 — Fase 1: Chat Global

La página `/chat` muestra el chat de Kick y el de Twitch juntos, en vivo, y permite escribir a los dos con la cuenta del dueño. Se instala como app. `/panel` sirve para entrar con Kick y vincular Twitch. 175 tests en verde (eran 103).

**Nada de esto está probado contra las APIs de verdad**, porque las credenciales todavía no existen (tareas 4, 5 y 6 de `TAREAS-DUENO.md`). Al final de esta entrada está la lista exacta de lo que falta verificar y de lo que puede llegar a fallar la primera vez.

### Lo que quedó funcionando

- `servidor/mensajes.js`: traduce `chat.message.sent` de Kick, `channel.chat.message` de Twitch y un PRIVMSG de IRC al **formato único** documentado en el README. Un solo lugar en todo el proyecto sabe cómo es el payload de cada plataforma.
- `servidor/vinculos.js`: los tokens del dueño en cada red, cifrados con AES-256-GCM en la colección `tokens`, con el refresh serializado por red (Twitch rota el refresh token en cada uso: dos refrescos en paralelo se pisan y dejan escrito uno que ya no vale).
- `servidor/chat.js`: junta las dos vías, la salud, el envío y el plan B.
- `servidor/irc.js`: cliente de IRC anónimo (`justinfan`) sobre TLS, sólo lectura, con reconexión propia.
- `/panel`, `/chat`, `/api/chat/salud`, `/api/chat/enviar`, `/api/chat/resuscribir`, más `manifest.webmanifest`, `sw.js` y los dos íconos PNG (generados a mano con `node:zlib`, sin dependencias).
- Los callbacks de OAuth ya no se plantan en "sos fulano": guardan el vínculo cifrado, abren la sesión del dueño y suscriben los eventos de su canal.

### Decisiones y por qué

**1. Las posiciones de emote de Kick no se usan; se parsea el markup.** Kick manda el emote dos veces: incrustado en `content` como `[emote:4148074:HYPERCLAP]` y aparte en un array con posiciones `s`/`e`. Esas posiciones son índices sobre `content` **con el markup adentro**, o sea sobre un texto que nadie ve nunca. Como igual hay que sacar el markup para mostrar el mensaje, quedarse con los índices de Kick obligaría a recalcularlos; parsear el markup da la respuesta directa. De paso: el fixture de la Fase 0 tenía las posiciones corridas en uno (decía 20–44 donde el markup está en 19–43). Se corrigió y se documentó adentro del propio fixture, porque hoy no las lee nadie pero alguien las va a copiar.

**2. Los índices de emote son puntos de código, con el fin exclusivo.** `.length` de JavaScript cuenta unidades UTF-16, así que un emoji fuera del plano básico cuenta dos. Twitch, por IRC, indexa por punto de código y con el fin **inclusivo**. Mezclar las dos unidades desalinea todos los emotes que vengan después del primer emoji del mensaje: la imagen aparece comiéndose una letra, sólo en algunos mensajes, y mirando el código no se ve. El formato único fija una sola convención (puntos de código, `[inicio, fin)`), la conversión del `+1` de IRC se hace en un solo lugar, y **cada test de posiciones lleva un emoji adelante a propósito**: sin él, el código roto pasa igual. Se comprobó rompiendo `mensajes.js` a mano (contar con `.length`, sacar el `+1`) y verificando que caen 5 tests.

**3. La salud NO sale por el bus SSE.** Estaba difundiéndose como un evento más y se sacó antes de cerrar la fase. El bus de un canal es público: en la Fase 2 lo escucha cualquiera que esté mirando la peli, y la salud dice qué redes tiene vinculadas el dueño, en qué modo está su conexión y si su canal está en vivo. No es un secreto, pero es información de su cuenta y no tiene por qué viajarle a todo el que abra la sala. Ahora `/chat` la pide cada 15 segundos contra `/api/chat/salud`, que exige la cookie del dueño; el reloj de "hace N minutos" lo mueve la página sola cada segundo, así que entre pedido y pedido igual avanza.

**4. La verificación de la suscripción de Kick es la mitad de la historia, y hay que saberlo.** La API de Kick **no devuelve ningún estado por suscripción**: `GET /events/subscriptions` trae id, evento, versión y fechas, y nada más. O sea que "sigue activa" sólo se puede comprobar como "sigue existiendo". Si Kick dejara de entregar webhooks —el caso típico: la URL del webhook no cargada a mano en el portal— la suscripción aparecería igual de sana. Por eso el chequeo de los 5 minutos va acompañado del dato que sí sirve: cuándo llegó el último mensaje de verdad, cruzado con si el canal está en vivo (`livestream.status.updated`). El aviso grande de `/chat` sale de ese cruce, no de la API.

**5. `/eventos/:slug` valida el slug** contra `KICK_SLUG` y contra la colección `creadores`, que era una de las notas que la Fase 0 dejó anotadas. Antes, cualquier slug inventado contestaba 200 y creaba una entrada en el Map de canales mientras la conexión viviera: memoria del servidor a pedido de cualquiera, y `/api/estado` devolvía esa lista de basura. Como consecuencia, tres tests de la Fase 0 que usaban canales propios ahora los dan de alta en `creadores` en su `before`.

**6. El endpoint de prueba local ahora puede inyectar un chat de verdad.** Con `?tipo=chat.message.sent`, `/api/prueba/webhook` entra por el mismo camino que un webhook real (traductor incluido) y sale como `chat`. Sin eso no había forma de ver `/chat` con mensajes andando en una máquina de casa: los webhooks de Kick no llegan a localhost y firmar uno a mano necesitaría la clave privada de Kick. Sin `?tipo=` sigue haciendo exactamente lo de antes, que es lo que prueba la Fase 0.

**7. Cada mensaje entra en las tres listas del DOM, no en la que corresponde a la vista.** Es un bug que se encontró mirando la página en el navegador, no en los tests: la versión anterior elegía la lista al recibir el mensaje, así que tocar el botón de vista mostraba una lista vacía —el historial estaba en la otra— hasta que alguien volviera a hablar. Ahora el mensaje se agrega a la lista mezclada y a la columna de su red siempre, y lo que se ve lo decide el CSS. Cuesta tener el mensaje dos veces en el DOM (dos listas de 300 como máximo) y ahorra tener que rearmar el historial cada vez que se toca un botón. Lo mismo con el filtro por red en la vista mezclada: esconde con CSS en vez de no agregar, porque si no volver a "todas" no podría traer de vuelta lo que ya pasó.

**8. El plan B es de sólo lectura y se prende solo.** Después de más de 3 fallos seguidos de EventSub se abre el IRC anónimo, y se apaga en cuanto EventSub vuelve a conectar. Mientras los dos están prendidos llegan mensajes repetidos; el dedupe es por id de mensaje, que **es el mismo por las dos vías** (el tag `id` de IRC es el `message_id` de EventSub). Escribir sigue yendo por Helix con el token del dueño: un `justinfan` no puede hablar. El modo aparece en el indicador de salud, así que si el chat viene por el plan B se ve en pantalla.

  El modo anónimo de IRC es lo único de todo el proyecto que **no está documentado oficialmente** por Twitch: está confirmado en sus foros de desarrolladores y lo usa toda librería de chat que existe. Por eso es el plan B y no el plan A.

**9. Twitch se vincula, no se loguea.** `/oauth/twitch/volver` exige la cookie de dueño antes de canjear el código. Sin esa guarda, cualquiera podía completar el flujo de Twitch y su token quedaba guardado como si fuera el del dueño: el servidor terminaría mandando los mensajes del Chat Global al chat de esa persona. La identidad de esta Sala la da Kick y sólo Kick.

### Lo que hay que verificar cuando estén las credenciales

Esto es lo que puede fallar la primera vez, con lo que hay que mirar:

1. **El scope de Twitch para enviar.** El brief pide `user:read:chat user:write:chat` y eso es lo que se pide. La referencia de Helix que se leyó para esta fase quedó truncada justo ahí y una de las lecturas devolvió `chat:edit`, que es el scope viejo de IRC. Si el primer envío a Twitch da 401 con un token recién sacado, es esto: hay que agregar el scope que pida el error en `SCOPES_DEFECTO` de `servidor/twitch.js` y volver a vincular.
2. **La URL del webhook de Kick cargada a mano** (paso 4 bis de `TAREAS-DUENO.md`). Sin eso, todo parece andar: la suscripción se crea, `/api/chat/salud` dice "activa" y no llega ni un mensaje. El aviso de los 5 minutos con el canal en vivo existe justamente para este caso.
3. **Que el `broadcaster_user_id` de Kick sea el `user_id` del dueño.** El código lo asume (es lo que dice la doc y lo que devuelve `/channels`). Si las suscripciones se crean pero para el canal equivocado, es acá.
4. **Que la página sea instalable.** No se pudo comprobar: el navegador con el que se probó bloquea el registro de service workers, así que `navigator.serviceWorker.register` falla con "unknown error occurred when fetching the script" en cualquier scope, incluso con el `/sw.js` sirviéndose 200 y con el tipo correcto. El registro está en un `try/catch` y la página funciona igual. Hay que abrir `/chat` en el dominio de Railway (HTTPS de verdad) y mirar Lighthouse.
5. **`files.kick.com/emotes/{id}/fullsize`** tampoco está documentado por Kick: es la URL que sirve su propio front. Si un día los emotes de Kick dejan de cargar, es una línea en `servidor/mensajes.js`. La CDN de Twitch sí está documentada, y se comprobó que `default/dark/2.0` contesta 200 (`animated` da 404 para un emote estático, así que `default` es la opción correcta).

### Archivos tocados

Nuevos: `servidor/{mensajes,vinculos,chat,irc}.js`, `paginas/{chat.html,panel.html,manifest.webmanifest,sw.js,icono-192.png,icono-512.png}`, `paginas/chat/{chat.css,chat.js,demo.js}`, `pruebas/{mensajes,vinculos,chat,chat-http,irc}.test.js`.
Editados: `servidor/index.js`, `pruebas/servidor.test.js`, `pruebas/fijos/chat-mensaje.json`, `README.md`, `BITACORA.md`.

### Cómo verlo funcionando

```bash
npm test                                  # 175 tests
npm run local                             # con MODO=local y KICK_SLUG cargados
```

La página entera, sin backend ni credenciales:

- `http://localhost:8778/chat?demo=1`
- `http://localhost:8778/chat?demo=1&vista=columnas&letra=grande`

Un mensaje de verdad, traducido, entrando por el bus:

```bash
curl -s -X POST -H 'Content-Type: application/json' \
  --data-binary @pruebas/fijos/chat-mensaje.json \
  'localhost:8778/api/prueba/webhook?tipo=chat.message.sent&canal=istincho'

curl -sN localhost:8778/eventos/istincho | head -4     # sale como "tipo":"chat"
curl -s -o /dev/null -w '%{http_code}\n' localhost:8778/eventos/inventado   # 404
curl -s -o /dev/null -w '%{http_code}\n' localhost:8778/api/chat/salud      # 401 sin cookie
```

### Pendiente

- Todo lo de la lista de arriba: nada de esto tocó una API real.
- El envío con "Ambos" no se pudo probar de punta a punta por lo mismo. La lógica de "salió en una y falló en la otra" está escrita y tiene tests con las dos redes fallando, pero el camino feliz nunca corrió.
- **`/api/estado` sigue siendo público y sigue devolviendo `canales.resumen()` de todos los canales.** La Fase 0 lo anotó y sigue anotado: hoy es inocuo, en la Fase 3 es la lista de creadores servida a cualquiera.
- **Los índices y el TTL de sesiones en el almacén** (la otra nota de la Fase 0) no entraron: no hacía falta ninguno para esta fase, y escribirlos sin Mongo cargado sería escribir código que nadie puede probar.
- El plan B no se probó contra el IRC real de Twitch, sólo contra un servidor de mentira en `node:net`. Lo que eso no cubre es el TLS y el handshake real.
- `SCOPES.dueno` de Kick pide `channel:read` además de los tres del brief. Viene de la Fase 0 y hace falta: sin él no se puede saber el slug del canal de quien entró, que es exactamente lo que decide si es el dueño.

---

## 2026-09-06 — Fase 0: arreglos de la verificación

Dos verificadores independientes revisaron la Fase 0 y encontraron cinco fallas reales más trece cosas menores. Están todas arregladas, y una segunda pasada del verificador encontró cuatro cosas más que también entraron (abajo). 103 tests en verde (eran 52); cada falla tiene un test que **falla con el código anterior**, verificado extrayendo el commit viejo a una carpeta aparte y corriéndole encima las pruebas nuevas (`afb4461` para la primera tanda, `23f6d9c` para la segunda).

### Las cinco fallas

**F1. Un emoji partido entre dos paquetes TCP rompía la firma del webhook.** `leerCuerpo` hacía `d += trozo`, o sea que decodificaba cada pedazo por separado. El corte entre paquetes cae donde quiere: si partía un carácter UTF-8 al medio, los bytes partidos se volvían U+FFFD, el cuerpo reconstruido dejaba de ser el que Kick firmó y salía 401. Kick reintenta, así que el mensaje llegaba tarde o no llegaba, sólo con mensajes con emoji o acento y sólo a veces. Ahora se acumulan `Buffer` y se concatenan al final, el cuerpo viaja como bytes hasta la verificación (que ya no lo decodifica nunca), y el tope de 1 MB cuenta bytes y no unidades UTF-16. El repo hermano ya tenía la forma correcta en `leerCuerpoBinario`; se había copiado la otra. Test: el mismo cuerpo firmado mandado por socket crudo entero, cortado en limpio y cortado en el medio del emoji — los tres 200.

**F2. Después de un `session_reconnect` de Twitch, la caída del socket no se detectaba.** Los listeners capturaban al abrirse una bandera "soy de reconexión". Cuando el welcome promovía ese socket a socket activo, la bandera seguía diciendo lo mismo, así que su listener de `close` entraba por la rama del entrante y hacía `return`: socket muerto, `estado` diciendo "conectado", cero reintentos. Lo único que lo rescataba era el timer de keepalive (`timeout * 1.5`): con el default de 10 s de Twitch, **15 segundos de chat mudo mintiendo que todo bien**, y más si la sesión pidió un timeout mayor. Twitch manda `session_reconnect` de rutina en cada deploy suyo, así que toda conexión larga pasa por ahí. Ahora los listeners preguntan contra `#socket` / `#entrante` en el momento del cierre, y un socket que ya no es ninguno de los dos se ignora. Test: se mata el socket promovido y se exige que en menos de 3 s el estado deje de decir "conectado" y haya reintento programado.

**F3. Un `error` tardío dejaba huérfano al que llegó después.** `soltar` borraba del Map por slug sin mirar si el Map seguía apuntando al mismo canal, y está enganchado a `close` **y** a `error`. Si A se iba, entraba B con el mismo slug y después llegaba el `error` tardío de A, el canal de B salía del Map: B se quedaba con el `EventSource` abierto, sin eventos ni pings, sin error, para siempre. Ahora `soltar` es idempotente y sólo borra si el Map sigue apuntando a ese mismo objeto.

**F4. Lo que el servidor difundía, el cliente no lo escuchaba.** El servidor mandaba cada evento como `event: <tipo>` y `bus.js` escuchaba tres nombres fijos. Por la especificación de SSE, un evento con nombre llega **sólo** al listener de ese nombre y nunca dispara `message`: `kick` (el webhook real) y `prueba` llegaban al navegador y se perdían ahí, sin un solo error. El test viejo miraba el stream crudo, así que pasaba igual.

  Arreglo: **el tipo viaja adentro del `data` y los eventos salen sin nombre**. Es un cambio de contrato del cable, y se eligió así porque una lista blanca en el cliente —fija o aprendida del servidor— no puede conocer los tipos que agrega una fase posterior, y en la Fase 1 el tipo va a salir de payloads de webhook. El nombre del evento no puede ser lo que decide si el evento llega. De paso cierra la inyección SSE (punto 3 de abajo) de raíz. Documentado en el README.

  Tests: uno corre `bus.js` de verdad en node contra un `EventSource` falso que implementa la regla de despacho del navegador, y además se verificó a mano en el navegador (`window.Sala.conectar` recibe el evento `prueba` con su cuerpo entero).

**F5. El almacén no tenía ni un test**, justo el módulo que más se apartó del patrón de referencia. Ahora `pruebas/almacen.test.js`: obtener/poner/quitar/listar con filtro, reemplazo entero, el id como clave, colección desconocida, 50 escrituras concurrentes a la misma colección, borrar y escribir a la vez, temp+rename sin `.tmp` huérfanos, persistencia tras `olvidarCache`, y la degradación a archivo con Mongo caído (comprobando además que el motivo no filtra la connection string). Se agregaron también `pruebas/canales.test.js` (buffer de 200, `recordar`, `ponerReloj`, el canal que no se borra con reloj puesto) y `pruebas/kick.test.js`.

### Lo demás que entró

1. **`.gitignore` y `.railwayignore` no ignoraban lo que prometían.** `*.env` no cubre `.env.local` ni `.env.produccion`: el comodín va antes del punto, no después. Y `!*.env.ejemplo` era un no-op porque esos nombres nunca habían matcheado. Ahora `*.env` + `*.env.*` + `!*.env.ejemplo`, verificado con `git check-ignore -v` sobre los siete casos.
2. **El catch general logueaba la URL entera**, y `/oauth/kick/volver?code=…` lleva el código OAuth de un solo uso; los logs de Railway no se borran. Ahora sólo el pathname.
3. **Inyección SSE latente**: el tipo se interpolaba crudo en `event: ${tipo}`. Con F4 ya no se interpola en ningún lado, y además se valida (un tipo que no sirve se reemplaza por `mensaje`). Con test.
4. **El id del webhook se marcaba como visto antes de procesar**: si el procesamiento fallaba, el reintento de Kick contestaba "repetido" y el evento se perdía. Se sigue marcando antes (para que dos entregas simultáneas no se procesen dos veces) pero se desmarca en todo camino que no termine procesando. Test: un JSON roto firmado da 400 las dos veces, no "repetido" la segunda.
5. **`HEAD /eventos/:slug` no terminaba nunca**: el enrutador deja pasar HEAD como GET y el handler SSE escribía en una respuesta sin cuerpo. Cualquier monitor de uptime sostenía un socket y un cliente fantasma. Ahora HEAD contesta las cabeceras y no abre stream (`curl -I`: 200 en 2 ms).
6. **`/eventos/%ZZ` daba 500** con stack trace por el `decodeURIComponent` del enrutador. Ahora 404, igual que hace `estatico()`.
7. **La página tenía el slug `istincho` escrito a mano**. Ahora sale de `/api/estado`; sin `KICK_SLUG` lo dice en vez de mirar un canal fantasma.
8. **`package-lock.json`** generado y versionado: Railway ya no resuelve `mongodb: ^7.6.0` en cada build. `engines.node` ya estaba en `>=22`.
9. **`poner(coleccion, '__proto__', …)` devolvía `true` sin guardar nada** (y `quitar` decía que había borrado algo que nunca existió), porque sobre un objeto normal esa asignación activa el setter del prototipo. El almacén de archivos usa `Object.create(null)`. Hoy los ids los generamos nosotros; en la Fase 3 vienen de afuera.
10. **`cifrado.js` tenía código muerto**: `Buffer.from(x, 'base64')` no tira nunca, ignora en silencio lo que no entiende, así que la rama "no es base64 válido" era inalcanzable y una clave con un carácter de más se aceptaba igual. Ahora se valida con expresión regular, y se le perdona el salto de línea del copiar y pegar.
11. **El `state` de Kick no chequeaba `vence` al canjear**, y lo pendiente sólo se purgaba cuando alguien empezaba otro login: la ventana de 10 minutos se estiraba sola. Se chequea al canjear, en Kick y en Twitch, y los dos Maps tienen tope de 1000.
12. **Ventana de antigüedad en el webhook.** Una firma RSA no vence: un webhook capturado se podía reenviar y el único freno era el anillo de 500 ids, que en un chat movido se vacía en media hora. Ahora se descartan los eventos de más de 10 minutos (contestando 200, para que Kick no reintente para siempre). **La ventana falla abierta si no entiende la fecha**: el timestamp entra en la firma, así que es auténtico aunque no sepamos leerlo, y si Kick cambiara el formato fallar cerrado dejaría el chat mudo al 100 %. En ese caso avisa una vez por consola. Acepta ISO 8601 y los dos formatos de epoch.
13. **El test de reconexión de Twitch no asertaba el orden**, así que un código que cerrara el socket viejo antes del welcome nuevo lo pasaba igual. Ahora asserta la secuencia.

### Anotado, no arreglado (trabajo de fases siguientes)

- **`index.js`, `procesarEvento`**: `const slug = cuerpo?.broadcaster?.channel_slug ?? SLUG_DUENO`. Con un solo canal está bien. En la Fase 3, un evento sin `channel_slug` se difundiría en el canal del **dueño**: el chat de un creador cayendo en la sala de otro. Cuando entre el segundo creador hay que resolver el slug contra la suscripción (`Kick-Event-Subscription-Id`) y descartar lo que no se pueda atribuir, en vez de adivinar. Queda el comentario en el código.
- **`/api/estado` es público y devuelve `canales.resumen()` de todos los canales.** Hoy es inocuo (hay uno). En la Fase 3 es la lista de creadores servida a cualquiera: hay que recortarla al canal que se pregunta, o pedir sesión.
- **`/eventos/:slug` acepta cualquier slug inventado** y crea la entrada en el Map mientras la conexión viva. Validar contra `creadores` es trabajo de la Fase 1.
- **Desviación de contrato:** `AGENTES.md` pide `enviarMensaje(token, broadcasterId, senderId, texto)` posicional y `servidor/twitch.js` expone `enviarMensaje({accessToken, broadcasterId, senderId, texto, respondeA})` con objeto. Aceptada por el director: son cuatro parámetros del mismo tipo (tres strings seguidos que es fácil intercambiar sin que nada avise) más `respondeA`, que en la Fase 1 hace falta para las respuestas del chat y en la firma posicional no tenía dónde ir. Misma clase de desviación que la de `suscribirEventos`.
- **No cubierto por tests:** el reintento del almacén a los 60 s (haría falta viajar en el tiempo dentro de un módulo que ya está cargado) y el tope del Map de pendientes de Twitch (mismas tres líneas que el de Kick, que sí está probado).

### Archivos tocados

Nuevos: `package-lock.json`, `pruebas/{almacen,canales,kick}.test.js`, `pruebas/fijos/eventsource-falso.js`.
Editados: `servidor/{index,canales,almacen,cifrado,kick,twitch,webhook}.js`, `paginas/index.html`, `paginas/comun/bus.js`, `pruebas/{servidor,twitch,webhook,cifrado}.test.js`, `.gitignore`, `.railwayignore`, `README.md`.

### Cómo verlo funcionando

```bash
npm test                                  # 103 tests
npm run local
curl -s -o /dev/null -w '%{http_code}\n' -I localhost:8778/eventos/istincho   # 200, no se cuelga
curl -s -o /dev/null -w '%{http_code}\n' 'localhost:8778/eventos/%ZZ'         # 404, no 500
curl -sN localhost:8778/eventos/istincho | head -4                            # data: {...,"tipo":"estado"}
```

### Segunda pasada de la verificación

Un verificador adversarial revisó los arreglos de arriba, confirmó que las cuatro fallas grandes están arregladas de verdad y encontró cuatro cosas más. Entraron todas.

1. **`GET //` daba 500 con stack trace en vez de 404.** `new URL('//', 'http://sala')` es una referencia scheme-relative con el host vacío y tira `ERR_INVALID_URL`. Ese parseo está una línea antes del `decodeURIComponent` que ya se había atajado, así que quedó afuera: el error salía del manejador y el catch general contestaba 500 y dejaba un stack en los logs. `//` es de lo primero que prueba cualquier bot, o sea que era un stack por bot en Railway. Ahora el parseo va en un `try` y una URL que no parsea da 404, igual que el `%ZZ`. Test: `//` por socket crudo tiene que dar 404.

2. **El test de `HEAD /eventos/:slug` no protegía su arreglo.** Usaba `fetch(..., {method:'HEAD'})`, y undici da la respuesta por terminada al recibir las cabeceras y cierra el socket; ese cierre disparaba el `close` que limpia al cliente del canal antes del assert. Resultado: el test pasaba **también con el código roto** (comprobado copiando las pruebas nuevas sobre `afb4461`). El arreglo del código era real, pero no había red de seguridad: sacar las ocho líneas de `eventos()` dejaba la suite en verde igual. Ahora el pedido va por socket crudo y **no cierra**, con un tope de 3 s: contra el código sin la guarda el test falla por lo que falla de verdad —"HEAD /eventos/canal-head no contestó en 3000 ms", que es exactamente lo que le pasaba a `curl -I`—, y si contestara, el cliente fantasma quedaría contando y el assert lo vería.

3. **Carrera en `ConexionEventSub`: un socket promovido podía quedar huérfano.** Si el socket activo se caía *mientras* el entrante de un `session_reconnect` todavía no había mandado su welcome, `#alCerrarSocket` programaba un reintento; después llegaba el welcome, el entrante se promovía a `#socket` y nadie cancelaba ese reintento. Al disparar, `#abrir()` pisaba `this.#socket` sin cerrar el anterior: quedaba una conexión viva a Twitch que ni `cerrar()` alcanzaba. No es regresión (el código viejo hacía lo mismo) y no afectaba a la Fase 0 porque Twitch todavía no se conecta; se cierra ahora para que la Fase 1 no se monte encima. Arreglo: `clearTimeout(this.#timerReintento)` en el camino de promoción de `#alWelcome`. Test con servidor WS falso: se corta el activo con el entrante sin welcome, se promueve, y después de esperar la ventana del backoff no puede haber una segunda conexión al servidor viejo ni sockets vivos tras `cerrar()`.

4. **Un cuerpo de más de 1 MB en `/kick/webhook` dejaba un stack trace por pedido y el cliente veía ECONNRESET.** `leerCuerpo` rechazaba y hacía `req.destroy()` ahí mismo, así que el 500 se escribía sobre un socket ya muerto. El proceso no se caía, pero es un endpoint **sin autenticar**: cualquiera podía llenar los logs de Railway a voluntad. Ahora se corta la lectura sin destruir, se contesta **413** con una línea de aviso y sin stack, se tira el resto del cuerpo (cerrar con bytes sin leer manda un RST y el cliente vería ECONNRESET en vez del 413) y hay un timer de 5 s por si el que manda no termina nunca. Test: 1,2 MB por socket crudo tiene que dar 413 y no llamar a `console.error` ni una vez.

También se tocó **`AGENTES.md`**, que no había cambiado con el resto. El cambio de contrato del cable SSE (F4: el tipo adentro del `data`, eventos sin nombre) estaba documentado en README.md y acá, pero `AGENTES.md` es donde vive el contrato del agente de la Fase 1 y su prompt dice "Formato único de mensaje que sale por SSE **en el canal `chat`**", que se puede leer como nombre de evento SSE. No había contradicción real —el formato que pide ya es compatible— pero se agregó una línea al prompt de la Fase 1 aclarando que "canal" es el slug del bus, que todo sale como `message` con el tipo adentro del `data`, y que no se vuelva a usar `event: <tipo>`.

Archivos tocados en esta pasada: `servidor/index.js`, `servidor/twitch.js`, `pruebas/servidor.test.js`, `pruebas/twitch.test.js`, `AGENTES.md`, `BITACORA.md`.

```bash
npm test                                                                      # 103 tests
curl -s -o /dev/null -w '%{http_code}
' 'localhost:8778//'                    # 404, no 500
curl -s -o /dev/null -w '%{http_code}
' -I --max-time 3 localhost:8778/eventos/istincho   # 200 en 2 ms
head -c 1200000 /dev/zero | curl -s -o /dev/null -w '%{http_code}
' -X POST --data-binary @- localhost:8778/kick/webhook   # 413
```

---

## 2026-09-06 — Fase 0: cimientos

Servidor Node listo para desplegar, con la base sobre la que se apoyan las fases siguientes. Abrir la raíz muestra la página de estado con el punto verde de "conectado al bus"; OAuth de Kick y de Twitch, webhook verificado y bus SSE existen y están probados. 52 tests en verde en 4,4 segundos.

### Lo que quedó funcionando

- `servidor/index.js`: http nativo con enrutador propio (tabla literal de rutas, `:param`, 405 cuando la ruta existe pero el método no). Estáticos desde `paginas/` con código en `no-cache` e imágenes en `max-age=86400`.
- `servidor/canales.js`: un canal por slug con conexiones SSE, reloj, buffer de 200 mensajes y `difundir(slug, evento)`. Ping cada 25 s.
- `servidor/almacen.js`: Mongo si hay `MONGODB_URI`, archivos JSON si no, con degradación avisada y reintento a los 60 s.
- `servidor/cifrado.js`: AES-256-GCM + HMAC para cookies. `servidor/sesion.js`: `sala_dueno` y `sala_espectador`.
- `servidor/kick.js`: OAuth 2.1 con PKCE (S256), refresh, app token cacheado, `usuarioActual`, `enviarMensaje`, `suscribirEventos`.
- `servidor/twitch.js`: OAuth code flow, Helix, y cliente EventSub por WebSocket con el `WebSocket` global de Node 22, sin conectar todavía.
- `servidor/webhook.js`: verificación RSA con caché de la clave pública y dedupe por id.
- `paginas/`: página de estado, `base.css` con el sistema visual y `comun/bus.js` con `window.Sala.conectar(slug, alRecibir)`.

### Decisiones que se apartan de lo previsto, y por qué

**1. La URL del webhook de Kick no se puede registrar por API.** Es el hallazgo más caro de la fase. Kick la lee de un cuadro de texto en el portal del desarrollador (*Enable Webhooks*) y de ningún otro lado; la API sólo dice a qué eventos y de qué canal. Consecuencia: `suscribirEventos(token, broadcasterUserId, urlWebhook)` conserva la firma que pedía el contrato, pero el tercer parámetro **no se manda**: sólo se registra en el log para poder avisar. Se agregó el paso **4 bis** a `TAREAS-DUENO.md` porque, sin él, todo parece andar —las suscripciones se crean sin error— y no llega ni un mensaje. Fuente: docs.kick.com/events/introduction.

**2. El almacén dejó de ser clave→valor.** En CosasStream es una sola colección `config` con un documento por clave, y alcanza porque ahí todo lo guardado es configuración. Acá `sesiones`, `tokens` y `videos` crecen con cada espectador y cada video: un solo documento por colección caminaría hacia el tope de 16 MB de Mongo y, peor, haría que dos escrituras simultáneas se pisen. La interfaz nueva es `obtener` / `poner` / `quitar` / `listar` por colección y documento. El backend de archivos mantiene la copia en memoria como fuente de verdad, que es lo que elimina la carrera de leer-modificar-escribir.

**3. Los canales llevan slug desde el día uno.** Hoy hay un solo streamer y un bus global sería más corto. Pero la Fase 3 mete muchos creadores, y partir después un bus global obligaría a tocar todas las rutas, el webhook y el cliente. Es la única decisión de esta fase que se toma mirando la Fase 3.

**4. `MODO` es `produccion` por defecto, no `local`.** `MODO=local` habilita `/api/prueba/webhook`, que inyecta eventos salteándose la firma. Si el default fuera local, olvidarse de cargar la variable en Railway dejaría esa puerta abierta en producción. Que el descuido rompa el desarrollo y no la seguridad.

**5. El callback de OAuth llega hasta "sos fulano" y ahí se planta.** Canjea el código, pregunta quién sos y descarta el token sin guardarlo. Guardar refresh tokens cifrados y decidir roles es de la Fase 1: hacerlo a medias ahora dejaría tokens de verdad en la base antes de que exista el código que los cuida. Así el dueño puede probar el circuito entero de OAuth apenas cargue las credenciales.

**6. La clave privada del fixture firmado no está en el repo.** Los tests generan un par RSA al vuelo y le fijan la pública al módulo. Una clave privada versionada, aunque sea de prueba, es una que algún día alguien confunde con una de verdad. Por eso el criterio de "200 al fixture firmado" se prueba dentro de `npm test` y no con un curl a mano.

**7. El SSE no lleva `Access-Control-Allow-Origin: *`.** En CosasStream sí, porque los overlays los abre OBS desde otro origen. Acá todas las páginas salen del mismo servidor, y abrir el stream a cualquier origen sería regalarle el chat en vivo a cualquier sitio que lo quiera embeber.

**8. Diferencias entre las dos APIs que van a morder más adelante:** en Kick los ids son números y la versión del evento es entero; en Twitch los ids son strings y la versión es `"1"`. Twitch rota el refresh token en cada refresh y hay que guardar el nuevo. Un HTTP 200 de Twitch al enviar un mensaje no garantiza que se envió: hay que mirar `is_sent` y `drop_reason`. Kick limita el chat a 500 grapheme clusters **y** 2048 bytes UTF-8, así que contar con `.length` estaría mal en los dos sentidos.

### Archivos tocados

Nuevos: `package.json`, `.railwayignore`, `README.md`, `servidor/{index,canales,almacen,cifrado,sesion,kick,twitch,webhook}.js`, `servidor/.env.ejemplo`, `herramientas/.env.ejemplo`, `paginas/index.html`, `paginas/comun/{base.css,bus.js}`, `pruebas/{cifrado,sesion,webhook,servidor,twitch}.test.js`, `pruebas/fijos/{chat-mensaje.json,ws-falso.js}`.
Editados: `TAREAS-DUENO.md` (paso 4 bis), `BITACORA.md`.

### Cómo verlo funcionando

```bash
npm test                                     # 52 tests
cp servidor/.env.ejemplo servidor/.env       # opcional
npm run local                                # http://localhost:8778
```

La raíz muestra el punto verde y los datos del canal. Con `curl`:

```bash
curl -s localhost:8778/api/estado                       # qué variables faltan
curl -si localhost:8778/oauth/kick/entrar | grep -i location   # PKCE con code_challenge
curl -s -o /dev/null -w '%{http_code}\n' -X POST -d '{}' localhost:8778/kick/webhook   # 401
curl -sN localhost:8778/eventos/istincho | head -5      # evento estado al conectar
```

### Pendiente

- **Deploy en Railway sin verificar.** Depende de tareas del dueño que todavía no están hechas (repo en GitHub, servicio en Railway, variables base). El código está listo y `.railwayignore` deja afuera tests, herramientas y documentación. Falta confirmar que la raíz responde en el dominio real.
- **Ningún login probado contra las APIs de verdad**, porque no hay credenciales cargadas. Todo lo verificado es local: los endpoints salen de la documentación oficial de enero de 2026, no de suposiciones.
- El webhook de la Fase 0 reparte el evento crudo por SSE. La traducción al formato único de mensaje (`servidor/mensajes.js`) es de la Fase 1: no se inventó un formato provisorio, porque un formato provisorio que se filtra al cliente después es imposible de cambiar.
- La regla de permisos del repo (`Read(./**/.env.*)` en `.claude/settings.json`) también alcanza a los `.env.ejemplo`, que no tienen ningún secreto. Hubo que crearlos por shell. Conviene afinarla a `.env` y `.env.*` que no terminen en `.ejemplo`.

---

## 2026-09-06 — Arranque

Repo creado con el plan (`PLAN.md`), los prompts para agentes (`AGENTES.md`), el prompt del director (`ARRANQUE.md`) y la lista de tareas del dueño (`TAREAS-DUENO.md`). Nada de código todavía. Puerto local reservado: 8778 (CosasStream usa 8777).
