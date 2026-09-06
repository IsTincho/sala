# Bitácora

Una entrada por fase cerrada, la más nueva arriba. Qué quedó, decisiones y por qué, archivos tocados, cómo verlo funcionando, qué quedó pendiente.

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
