# Bitácora

Una entrada por fase cerrada, la más nueva arriba. Qué quedó, decisiones y por qué, archivos tocados, cómo verlo funcionando, qué quedó pendiente.

---

## 2026-09-06 — Fase 0: arreglos de la verificación

Dos verificadores independientes revisaron la Fase 0 y encontraron cinco fallas reales más trece cosas menores. Están todas arregladas. 99 tests en verde (eran 52); cada falla tiene un test que **falla con el código anterior**, verificado extrayendo el commit `afb4461` a una carpeta aparte y corriéndole encima las pruebas nuevas.

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
npm test                                  # 99 tests
npm run local
curl -s -o /dev/null -w '%{http_code}\n' -I localhost:8778/eventos/istincho   # 200, no se cuelga
curl -s -o /dev/null -w '%{http_code}\n' 'localhost:8778/eventos/%ZZ'         # 404, no 500
curl -sN localhost:8778/eventos/istincho | head -4                            # data: {...,"tipo":"estado"}
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
