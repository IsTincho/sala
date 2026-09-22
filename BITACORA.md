# Bitácora

Una entrada por fase cerrada, la más nueva arriba. Qué quedó, decisiones y por qué, archivos tocados, cómo verlo funcionando, qué quedó pendiente.

---

## 2026-09-22 — Fase 5.4: moderación propia, vencimiento y el chat como app

La última de [`PLAN-MULTICHAT.md`](PLAN-MULTICHAT.md). Seis cosas chicas que cierran el
chat abierto: bloquear a alguien, que los tokens de quien no vuelve se borren solos, el
contador de conectados, el QR del link, el manifest por sala y el texto nuevo de
`/terminos`.

**751 pruebas en verde** (eran 716), la suite corrida cuatro veces seguidas sin un solo
flake. **10 mutaciones, las 10 cazadas.**

### Bloquear a alguien, en esta herramienta

El creador toca **bloquear** en un mensaje, en su Chat Global, y esa persona deja de poder
escribir en su chat abierto. La lista queda en `/panel` con un botón para soltarla, y
`POST /api/panel/chat` la toca **de a uno** (`bloquear` / `desbloquear`), nunca la lista
entera: con dos pestañas del panel abiertas, mandar la lista completa haría que la segunda
pise el bloqueo de la primera.

**Es un bloqueo de acá y el panel lo dice con todas las letras**: en kick.com y en
twitch.tv esa persona sigue escribiendo, porque ahí manda la moderación de cada
plataforma. Creer lo contrario es el error caro.

**Por id y no por nombre**, porque los nombres se cambian: el que se bloqueó ayer puede ser
otra persona mañana. Para eso el formato único de mensaje pasa a traer `usuarioId`. Sale
por el bus para todos y eso se pensó: es el mismo id que Kick manda en `sender.user_id` y
Twitch en `chatter_user_id` (y en el tag `user-id` de IRC) a cualquiera que lea ese chat
público. No es un dato nuestro sobre nadie; es lo que la plataforma ya publica de un
mensaje público. Filtrarlo por conexión costaría una copia del objeto por mensaje y por
persona mirando, para esconder algo que está a un pedido de distancia.

**Al bloqueado se le dice.** `/api/chat/:slug/yo` devuelve en qué redes está bloqueado, así
la página lo explica en vez de esconderle la caja sin motivo: quedarse escribiendo contra
una pared que no avisa es peor que un "el creador te bloqueó en este chat". Y aclara que
en el canal del creador sigue pudiendo escribir como siempre. Con una red bloqueada y la
otra no, escribe por la que le queda y se dice cuál perdió; si no, parece que esa red
desapareció sola. **Quién está bloqueado no sale por ninguna ruta pública**: es del creador.

**La escucha del botón va en la lista, no en el botón.** `/chat` clona el `<li>` para
ponerlo en la columna de su red, y un clon no se lleva las escuchas: el botón de la
columna no haría nada y nadie se enteraría hasta tocarlo. Hay prueba de eso, con el clon.

### El espectador que no vuelve se borra solo

A los **60 días** sin usarse. Guardar el refresh token de alguien que no usa el servicio
hace dos meses es riesgo sin beneficio; si vuelve, lo conecta de nuevo en dos clicks. Se
poda al arrancar, que para este servicio pasa seguido, y **se barren los dos modelos**: el
viejo hace falta porque la migración corre al *leer* un espectador, y al que ya no tiene
sesión no lo lee nadie nunca más.

**Lo delicado fue anotar que alguien sigue viniendo.** Se hace al leerlo, como mucho una
vez cada seis horas, y **esa escritura se espera**. Escribe el documento entero (el almacén
no sabe actualizar un campo suelto), así que una escritura suelta volando podría aterrizar
después de un `conectar` y devolver el documento a como estaba, borrando la red que se
acababa de conectar. Es justo el caso de quien vuelve después de una semana a sumar Twitch:
hace más de seis horas que no viene, así que esa escritura se dispara. Esperarla cuesta una
escritura cada seis horas por persona.

### El chat de cada sala se instala aparte

`GET /chat/:slug/manifest.webmanifest`, con `start_url` y `scope` en `/chat/<slug>`, y el
service worker con el mismo alcance. Quien instala el chat de su streamer abre ahí y no en
la ventana del creador, que es lo que pasaba con el manifest de antes (`start_url: /chat`).
Dos salas instaladas son dos apps. `paraUnaSala` ya no le saca el manifest a la página: se
lo cambia.

Y arriba dice **cuánta gente está leyendo**. Un número y nada más: quiénes, nunca. Sale del
mismo evento de presencia que ya usaba la Sala.

### El QR, y cómo se verifica algo que no se puede mirar

`paginas/comun/qr.js`: modo byte, corrección M, versiones 1 a 10 (hasta 213 caracteres; un
link de acá son 55). Sin dependencias, porque un QR es un formato cerrado y bien
documentado: se escribe una vez y no se toca más, que es lo contrario de sumar una
dependencia que hay que auditar y actualizar.

Lo dibuja el **navegador** y no el servidor, por la misma razón que el link: el panel lo
arma con el origen desde el que se lo mira, y si lo armara el servidor, detrás del proxy de
Cloudflare el QR llevaría a Railway.

**El problema de verdad era verificarlo.** Un QR mal armado se ve perfecto: son cuadraditos
negros. Un test que compare mi encoder contra mis propias tablas no prueba nada, y no hay
cámara acá. Se resolvió con un **decodificador ajeno**: `herramientas/verificar-qr.mjs` baja
jsQR y le da de leer las diez versiones **al tope de su capacidad** (que es donde se nota
una tabla de bloques mal copiada), 300 textos al azar, los links de verdad del proyecto y
textos con acentos y emojis. **328 de 328 volvieron iguales.** Como jsQR lee la información
de formato, la de versión, los patrones de alineación y los bloques de corrección para
decodificar, que pase quiere decir que las tablas están bien.

Esa herramienta **sale a internet**, así que no es parte de `npm test`. La suite guarda la
**huella** del dibujo de un link conocido: si alguien toca el enmascarado, se cae, y hay
que volver a correr la verificación antes de dar el cambio por bueno. Está escrito en el
encabezado de `pruebas/qr.test.js` para que no quede en la memoria de nadie.

De paso, las dos tablas del código se cruzan solas: bloques × (datos + corrección) tiene
que dar el total de bytes de esa versión, y las diez cierran. Un número mal copiado en
cualquiera de las dos no pasa esa cuenta.

### Los términos

Sección 3 reescrita: qué se guarda por red, que los tokens van cifrados, y **las tres
formas de que eso desaparezca** (Salir, los 60 días, y quitarle el permiso a la app desde
la plataforma). También que un bloqueo guarda el id y el nombre que tenía, y que de la
gente conectada lo único que se muestra es cuánta hay.

**El número de versión NO subió.** Esa decisión es del dueño (tarea 16 de TAREAS-DUENO) y
tiene una consecuencia: subirlo obliga a tocar también el link de `/crear`, que lleva
`terminos=1` escrito. A los creadores que ya están no los afecta (sólo se piden términos en
el alta).

### Cómo se verificó

- **10 mutaciones sobre las guardas nuevas y las de la 5.2/5.3** (aceptar cualquier
  `Origin`, dejar escribir a un bloqueado, dejar escribir con el chat cerrado, anotar el
  freno después de mandar, quedarse con el manifest del creador, no borrar el documento
  viejo al migrar, migrar sin mirar el `tipo`, podar también a los que vuelven, escribir
  sin `chat:write`, el botón de bloquear en el chat público). **Las 10 las caza al menos
  una prueba.**
- **En vivo**, con un servidor local limpio y el navegador: se inyectó un mensaje de Kick
  con `/api/prueba/webhook`, se tocó **bloquear** en el mensaje, se vio el aviso con
  **Deshacer**, la lista apareció en el panel con su chip de red, y Deshacer la vació.
  `/chat/istincho` mostró "1 conectado" y su propio manifest. El QR del panel se decodificó
  de vuelta y dijo exactamente el link que el panel muestra.

### Archivos tocados

`servidor/{mensajes,creadores,espectadores,index}.js`, `paginas/comun/{mensajes,qr}.js`,
`paginas/chat.html`, `paginas/chat/{chat.js,chat.css}`, `paginas/panel.html`,
`paginas/panel/{panel.js,panel.css}`, `paginas/terminos.html`,
`herramientas/verificar-qr.mjs` (nueva). Pruebas: `pruebas/qr.test.js` (nueva, 12) y
agregados en `espectadores`, `chat-enviar`, `chat-abierto`, `pagina-chat`, `pagina-panel`,
`mensajes-forma` y el DOM de mentira.

### Pendiente

- **El vencimiento de 60 días nunca corrió contra datos viejos de verdad**, por razones
  obvias: el servicio tiene menos de 60 días. Lo que sí está probado es el corte con las
  fechas puestas a mano.
- **El QR no lo escaneó un celular.** Lo leyó jsQR 328 veces, que es una implementación
  ajena y completa, pero una cámara real agrega óptica, foco y una pantalla de por medio.
  Vale la pena que el dueño lo apunte una vez con el teléfono antes de ponerlo en cámara.
- **Bloquear se hace desde `/chat`, la ventana del creador, y no desde `/chat/<slug>`.** Un
  creador que abra su propio chat público no va a ver el botón ahí. No lo pidió nadie y
  mezclar las dos páginas sería mezclar dos roles.
- **`/chat` de un creador que no es el dueño sigue mirando la sala del dueño** (es de
  antes), así que el botón de bloquear ahí bloquearía en SU sala mientras mira el chat del
  dueño. Para el dueño del servicio, que es quien usa esa ventana hoy, está bien.
- **El número de versión de los términos**, que decide el dueño.
- La Fase 5.5 (creadores que sólo usan Twitch) sigue afuera del plan, por decisión del
  dueño.

---

## 2026-09-22 — Fases 5.2 y 5.3: el espectador escribe, en Kick y en Twitch

Las dos juntas, porque la gracia es que escribir a las dos sea **un solo envío**. En
`/chat/<slug>`, cada quien conecta **su** Kick y/o **su** Twitch y el mensaje sale en el
chat de verdad con su nombre. Sigue valiendo lo de la 5.1: **leer no pide login**.

**716 pruebas en verde** (eran 662). `herramientas/` no se tocó.

### Qué hay

- **Botones "Conectar Kick" y "Conectar Twitch"** arriba de la caja de escribir, y un
  selector que muestra **sólo las redes que la persona conectó Y que el creador abrió**.
  Con las dos aparece **"las dos"**, que es un pedido solo y un mensaje solo para el
  freno. Con una sola no hay nada que elegir y el selector se esconde.
- **`POST /api/chat/:slug/enviar`** `{ red: "kick" | "twitch" | "ambas", texto }`, con
  cookie de espectador. Los mismos frenos que la Sala y por el mismo camino: el tope de
  cada red antes de gastar un pedido, la espera del canal si Kick nos frenó, y uno cada
  dos segundos por persona. **403** si el chat está cerrado, si esa red no está abierta o
  si la persona no la conectó.
- **`GET /api/chat/:slug/yo`**: qué conectó y dónde puede escribir **acá**. Habla del que
  pregunta y de nadie más.
- **`POST /api/espectador/salir`**: borra los tokens de **las dos redes**, no sólo la
  cookie. Sin slug, porque la cuenta de espectador es del dominio.
- **OAuth de espectador para Twitch**: `?rol=espectador`, scope **`user:write:chat`** y
  nada más (leer entra con el token del creador). **Mismo redirect** que ya estaba: no
  hay que tocar nada en la app de Twitch por esto. El rol viaja en el `state` del
  servidor y no en la query del callback, igual que el destino.
- **El mensaje no se difunde por el bus**: vuelve por el webhook de Kick y por EventSub.
  Mismo criterio que la Sala. Hay prueba.

### El espectador dejó de ser una cuenta de Kick

Era literal: el documento vivía en `tokens`, bajo `espectador:<user_id de Kick>`. Con
Twitch adentro no cierra, porque alguien puede conectar **sólo** Twitch y no tener nunca
un id de Kick. Ahora tiene id propio (`esp_…`) en la colección `espectadores`, y las
redes le cuelgan con sus tokens cifrados por separado.

**La migración conserva el id viejo.** Esas cookies están en navegadores ahora mismo: si
la migración estrenara id, todas las sesiones vivas se caerían en el deploy. Al leer un
espectador que no está en el modelo nuevo se busca el viejo, se convierte **bajo la misma
clave** y se borra el original, para no dejar dos copias del mismo refresh token. Los
tokens no se vuelven a cifrar: ya están cifrados con la misma clave y descifrarlos ahí
sería pasearlos en claro por la memoria sin necesidad. Hay prueba de punta a punta: una
cookie vieja escribe por la ruta nueva y el documento queda migrado.

**Un vínculo de creador no se confunde con uno viejo.** En `tokens` también viven los
vínculos (`<slug>:<red>`), así que un creador con el slug "espectador" tendría documentos
llamados `espectador:kick`. La migración mira el campo `tipo`, y hay prueba.

### Decisiones que se apartan de lo previsto, y por qué

**1. Dos navegadores son dos espectadores.** Antes, como la clave era la cuenta de Kick,
entrar desde el celular y desde la compu daba un solo documento. Deduplicar ahora pediría
un índice por red (o recorrer la colección en cada login) y, sobre todo, haría que
"Salir" en el celular cerrara la sesión de la compu, que no es lo que nadie espera de un
"salir". Lo que cuesta: el freno de dos segundos es por espectador, así que la misma
persona con dos navegadores tiene dos frenos. Encima siguen los límites de Kick y de
Twitch, que son por cuenta.

**2. La espera del 429 sigue siendo de Kick y sólo de Kick.** El 429 de Kick es del
**canal** y frena a todos, como siempre. El límite de Twitch para escribir es por
**cuenta** (20 cada 30 s para quien no es mod): frenar el canal entero porque a una
persona la frenaron callaría a los demás sin motivo. Prueba: con Kick frenado, un mensaje
a Twitch sale igual.

**3. Un permiso que dejó de valer desconecta UNA red, no la cuenta.** En la Sala, un 401
de Kick cierra la sesión y borra al espectador entero, y así quedó: es un producto de una
sola red, y dejar vivo un token de Twitch al que ninguna sesión apunta sería guardar
credenciales que su dueño no puede ni usar ni borrar. En el chat abierto, en cambio, la
otra red no tiene la culpa: se desconecta la que falló, la sesión sigue en pie y la
respuesta trae `reconectar: ["twitch"]` para que la página vuelva a mostrar ese botón.

**4. "Ambas" con una sola red abierta rebota entero.** Mandar a media callado sería
mentirle a quien eligió las dos; la página no tendría que haber ofrecido esa opción ahí.

**5. Un 200 de Twitch con `is_sent: false` NO es un envío.** Se lee `drop_reason` y el
motivo se muestra tal cual lo da Twitch. Decir "enviado" cuando el AutoMod lo retuvo es
la peor mentira posible de un chat: la persona se queda esperando una respuesta que nadie
va a ver. Con "las dos", el resultado viene **por red**, así que "salió en Kick, falló en
Twitch: el AutoMod lo retuvo" se dice exactamente. Un error pelado ahí haría que lo
escriba de nuevo y quede repetido donde sí había salido.

**6. El envío se sacó a `servidor/envio.js`.** La Sala y el chat abierto usan el mismo
camino: el día que cambie el tope de Kick, o el trato que se le da a un 429, cambia en un
lado solo. `envio.js` no sabe de HTTP —devuelve `{ ok, motivo, estado, caduco }`— porque
las dos rutas no hacen lo mismo con un permiso vencido (ver el punto 3). **El contrato de
`/api/sala/:slug/chat` no cambió**, y sus pruebas de antes siguen tal cual.

**7. El freno de la persona se anota un poco antes que antes.** Estaba después de
comprobar el vínculo del canal; ahora está justo antes de mandar, en las dos rutas. O
sea: un 503 de "esta sala no vinculó Kick" ahora también consume el turno. Es un envío
intentado y el freno es contra el dedo pesado.

### Los dos dominios, que era la parte con trampa

El sitio se sirve desde Railway **y** desde `multichat-osmiumstudio.pages.dev`, un Worker
de Pages que reenvía todo (`cloudflare/multichat/_worker.js`). Para el navegador son dos
sitios con dos juegos de cookies; para el servidor, un proceso solo.

`servidor/origenes.js` tiene la lista **explícita**: `URL_BASE` siempre, más lo que diga
`ORIGENES` separado por comas. Sirve para dos cosas que no pueden contradecirse:

- **CSRF.** Los POST del espectador exigen, además de la cookie `SameSite=Lax`, que el
  `Origin` sea uno de esa lista. **Sin `Origin` no pasan**: los navegadores lo mandan en
  todo POST de `fetch`, así que exigirlo no rompe a nadie que use la página, y aceptarlo
  sin `Origin` dejaría la puerta abierta a cualquier cliente que simplemente no lo mande.
- **Los redirect de OAuth.** `baseDe` ahora usa **el origen por el que entró el pedido**,
  si es uno de los nuestros. Si volviera siempre al de `URL_BASE`, quien entra por el
  dominio lindo terminaría el login en Railway, con la cookie puesta ahí, y al volver al
  link que tenía abierto no estaría conectado. Como la lista es explícita, un `Host`
  inventado no puede mandar el redirect a ningún lado.

**Sin `ORIGENES` todo sigue exactamente como antes.** Es opt-in, y prenderlo tiene un
precio que está anotado en TAREAS-DUENO (tareas 20 y 21): **un dominio en la lista tiene
que estar registrado como redirect en la app de Kick y en la de Twitch**, o el login
desde ahí rebota del lado de ellos.

Sólo lo exigen las rutas nuevas. Las de antes (`/api/panel/*`, `/api/sala/:slug/*`) siguen
con `SameSite=Lax` a secas: cambiarles el contrato no lo pidió nadie y `sesion.js` explica
por qué el Lax alcanza mientras ninguna cookie sea `SameSite=None`.

### Cómo se verificó

- **Pruebas nuevas**: `pruebas/chat-enviar.test.js` (36, con el servidor levantado de
  verdad y dobles de `fetch` para Kick y Twitch), 13 en `pagina-chat` y 9 en
  `espectadores`. Cubren lo pedido: el selector según lo conectado y lo abierto, chat
  cerrado = 403, `is_sent:false` con su `drop_reason` mostrado, "ambas" con una red
  caída, el freno de 2 s con "ambas" contando como uno, `Origin` ajeno y `Origin`
  ausente rechazados, salir borrando las dos redes, y el espectador viejo migrado.
  También el OAuth de espectador entero, de `/entrar` a `/volver`, sin salir a internet.
- **En vivo**, con un servidor local limpio (carpeta temporal, sin `servidor/.env`, sin
  Mongo, clave de cifrado de relleno) y el navegador: `/chat/ana` sin conectar nada
  muestra los dos botones y ninguna caja; con las dos redes conectadas dice "Escribís
  como … en Kick y … en Twitch" y el selector ofrece Kick, Twitch y Las dos. Al mandar
  uno de verdad, **Kick contestó 401 al token de mentira** y se vio el camino completo:
  se desconectó **sólo** Kick, el botón "Conectar Kick" volvió solo, el texto pasó a
  "Escribís como … en Twitch" y el mensaje **no** se borró de la caja. En 375 px no hay
  scroll horizontal. Con `curl`: `Origin` ajeno 403, sin `Origin` 403, el segundo dominio
  200.

### Archivos tocados

`servidor/{espectadores,envio,origenes,index,almacen,twitch}.js`, `paginas/chat.html`,
`paginas/chat/{chat.js,chat.css}`. Pruebas: `pruebas/chat-enviar.test.js` (nueva) y
agregados en `espectadores`, `sala-http` y `pagina-chat`. Docs: `README.md`,
`TAREAS-DUENO.md` (bloque 6), `PLAN-MULTICHAT.md` (estado).

### Cómo verlo funcionando

```bash
npm test
npm run local
# /panel -> "Chat para tu comunidad" -> prender el interruptor
# y en otra ventana, sin sesion de creador:
curl -s localhost:8778/api/chat/<tu-slug>/yo
# /chat/<tu-slug> -> "Conectar Kick" -> escribir
```

### Pendiente

- **Nada de esto tocó una API real todavía.** Lo que sólo se ve en producción, y en este
  orden: (1) que Twitch acepte un token de espectador con **`user:write:chat` solo** en
  `POST helix/chat/messages` —la doc lo dice, pero es el scope más ajustado posible—;
  (2) que `GET helix/users` conteste con ese mismo token (se usa para saber el nombre y
  el `sender_id`); (3) un `drop_reason` de verdad, con una cuenta baneada o el AutoMod
  prendido; (4) el login desde el dominio de Cloudflare, que depende de las tareas 20 y
  21 del dueño.
- **Los espectadores viejos huérfanos no se limpian solos.** La migración corre al leer,
  así que un documento de `tokens` cuya sesión ya venció se queda ahí. El vencimiento de
  60 días de la Fase 5.4 tiene que barrer también `tokens/espectador:*`.
- **La Fase 5.4 no está empezada**: bloqueados por el creador, el vencimiento de 60 días,
  el contador de conectados, el QR, el manifest por sala y el texto nuevo de
  `/terminos`. La moderación de cada plataforma sigue aplicándose sola mientras tanto
  (el mensaje sale como de esa persona), que es lo que dice el plan.
- **`/chat` de un creador que no es el dueño sigue mirando la sala del dueño.** Es de
  antes y no cambió.
- La caja de escribir del chat abierto **no responde mensajes** (`reply_parent_message_id`
  existe en las dos APIs y el creador ya lo usa). Nadie lo pidió para el espectador.

---

## 2026-09-22 — Fase 5.1: el chat abierto, sólo lectura

Primera fase de [`PLAN-MULTICHAT.md`](PLAN-MULTICHAT.md). Cada creador puede **abrir su
Chat Global a la comunidad**: un link `/chat/<slug>` donde cualquiera, sin login, lee su
chat de Kick y su chat de Twitch **juntos y en vivo**. Escribir desde ahí es la 5.2.

Lo que decidió el dueño antes de construir (sección 7 del plan): entra en **todos** los
planes, incluido "pendiente"; **leer no pide login**; la cuenta de espectador va a ser
global (no aplica todavía); el creador **no** ve quién escribió; la 5.5 queda afuera. Y el
énfasis: **Kick y Twitch a la vez**. Abrir sin elegir redes deja las dos, y la vista por
defecto es la mezclada.

**662 pruebas en verde** (eran 618). `herramientas/` no se tocó.

### Qué hay

- **`/panel` → "Chat para tu comunidad"**: interruptor abierto/cerrado, qué redes se ven
  (Kick, Twitch o las dos), el link para copiar, un botón para abrirlo, y el aviso de que
  **no va como fuente en OBS si se transmite a Twitch** (las reglas de simulcast de Twitch
  no dejan mostrar en el stream un chat mezclado con otras plataformas). Si Twitch está
  elegido y no vinculado, lo dice. Con plan "pendiente" la película está apagada y el chat no.
- **`POST /api/panel/chat`** `{ activo?, redes? }`, con cookie de creador. **El slug sale
  de la cookie**: un `slug` en el cuerpo no se lee. Lo que no viene queda como estaba; una
  red que no existe o una lista vacía dan 400 y no se guardan a medias.
- **`GET /chat/:slug`**: la **misma** `chat.html` en modo público. Sin salud (es de la
  cuenta del creador), sin caja de escribir, con título "Chat de <slug>". Mezclado,
  columnas, letra y pausa al subir el scroll son los de `/chat`, reusados tal cual. **404
  si la sala no existe**, con el mismo criterio que `/sala/:slug`.
- **Cerrado**, la página dice "este chat está cerrado", **no se conecta al bus** y vuelve a
  preguntar cada 30 s: cuando el creador lo abre, aparece sin recargar. Si lo cierra con la
  página abierta, llega un aviso por el bus (`chat-abierto`) y la página corta su conexión
  en el acto.
- **`GET /api/chat/:slug/abierto`**: `{ abierto, redes }`, público. Cerrado contesta
  `redes: []`: de un chat cerrado no se cuenta nada.

### El filtro del bus, que es lo que importa

| Quién se conecta a `/eventos/:slug` | Qué redes recibe |
|---|---|
| El dueño **de esa sala** | Las dos, siempre |
| Cualquier otro, chat abierto | Las que eligió el creador |
| Cualquier otro, chat cerrado | Sólo Kick, como siempre (la Sala depende de eso) |

**1. La regla se pregunta en cada evento, no al conectar.** Hasta ahora cada conexión
guardaba una lista fija. `canales.suscribir` acepta ahora que `redes` sea una **función**,
y `leDaEl` la llama en cada mensaje. `index.js` le pasa una que lee el chat abierto de la
sala. Así, cerrar o sacarle Twitch con gente mirando corta el Twitch **para el próximo
mensaje**, sin esperar la reconexión, y sin recorrer conexiones. `canales.js` sigue sin
saber qué es un chat abierto.

**2. La respuesta vive en memoria, y no vence.** El filtro corre por mensaje y por
conexión: no puede esperar a Mongo. `creadores.chatAbierto(slug)` lo lee del almacén la
primera vez y lo deja en un Map; después lo cambia sólo `ponerChatAbierto`. La carrera
"alguien se conecta, se lee el valor viejo, y en el medio el creador cierra" se cierra con
dos líneas: **la carga escribe el Map sólo si está vacío, y la escritura del creador lo pisa
siempre**. En cualquier orden gana la escritura. `/api/chat/:slug/abierto` contesta de la
misma memoria, así que la pantalla y el cable no se pueden contradecir.

**3. Si el almacén falla, no se memoriza nada.** Y acá apareció algo que no se veía:
**`almacen.obtener` no tira cuando Mongo se cae**. Degrada a archivo y contesta lo que haya
en el disco efímero del contenedor, que es nada. Memorizar eso habría dejado el chat
cerrado (o abierto) hasta el próximo deploy. Se agregó `almacen.degradado()` (Mongo
configurado pero guardando en archivo) y en ese estado la lectura se usa una vez y no se
guarda. Mientras no se sabe, el público recibe sólo Kick: ante la duda, lo cerrado.

**4. La política se carga ANTES de suscribir.** `suscribir` manda los últimos 200 mensajes
en el acto. Si la regla se cargara después, el primero en llegar tras un deploy recibiría
el buffer filtrado con "no se sabe" (sólo Kick). Hay prueba que lo exige.

**5. Arreglo de paso: "dueño" quería decir "cualquier creador".** `/eventos/:slug` le daba
las dos redes a **cualquier** cookie de creador, en cualquier sala. Con un solo creador era
lo mismo; con varios, Ana con su sesión leía el Twitch de Beto con un curl. Ahora es la
cookie del dueño **de esa** sala, como pide la tabla del plan. Prueba: "la cookie de OTRA
sala no destapa Twitch".

### Decisiones que se apartan de lo previsto, y por qué

**6. `/chat/:slug` sirve `chat.html` con `<base href="/">` y sin el manifest.** `chat.html`
pide sus archivos con rutas **relativas** a propósito: así `?demo=1` anda abriendo el archivo
suelto con `file://`. Desde `/chat/istincho` esas rutas apuntan a `/chat/comun/base.css`, y
la página cargaría sin estilos ni código. Se descartó pasarla a rutas absolutas (rompía el
demo con `file://`) y hacer una segunda página (dos copias del mismo HTML). El servidor le
agrega una `<base>` (una raíz del sitio, no un host: detrás del proxy de Cloudflare Pages
sigue andando) y le saca el manifest, que es el de la ventana del creador (`start_url:
/chat`): un espectador que "instalara" el chat terminaría abriendo el de otra persona. El
manifest por sala es de la 5.4. **`/chat` a secas sale byte por byte igual**, con prueba.
Y la misma trampa que `/sala/:slug`: la ruta tapa `/chat/chat.js`, `/chat/chat.css` y
`/chat/demo.js`, así que lo que no parece un slug va a los estáticos.

**7. La Sala sigue mostrando sólo Kick aunque el chat se abra con Twitch.** El pedido era
que el bus público mande las redes del chat abierto, y así quedó: `curl /eventos/<slug>`
trae Twitch si está abierto. Pero la Sala usa ese mismo bus, y sin hacer nada habría
empezado a mostrar Twitch en la sala de la película, donde la gente escribe a Kick y no
puede contestarle a nadie de Twitch. Nadie pidió ese cambio. Así que **`/eventos` acepta
`?redes=kick` para pedir menos (nunca más)** y la Sala lo pide. Lo resuelve el servidor, no
la página: la prueba "la página NO filtra por red" sigue en pie. **Si el dueño quiere
Twitch en la Sala cuando abre el chat, es sacar `{ redes: ['kick'] }` de `sala.js`.**

**8. El link del panel lo arma el navegador**, con el origen desde el que se mira el panel
(`new URL('/chat/<slug>', location.href)`). Si lo armara el servidor con `URL_BASE`, detrás
del proxy de Cloudflare Pages el link sería el de Railway.

**9. El dueño del servicio puede abrir su chat aunque no tenga documento.** Su sala existe
por `KICK_SLUG`, no por la base. El ajuste va al mismo lugar que el de todos (su documento
en `creadores`) y, si no lo tiene, se le crea con los valores del alta. El plan que queda
escrito ahí no se lee nunca: `planDe` contesta "dueno" antes de mirar el documento. Su
próximo login sólo completa id y nombre.

**10. Cerrado, la página no escucha el bus.** Quedarse conectada traería el Kick de la sala
a una pantalla que no lo muestra y contaría como alguien mirando la película. Al reabrir se
vacían las listas antes de conectar: el servidor manda los últimos mensajes a cada conexión
nueva, y si quedaban los viejos salían dos veces.

### Cómo se verificó

- **Mutaciones**: 10 sobre el servidor (cualquier cookie de creador, lista fija al conectar,
  slug del cuerpo, sin cargar la regla antes del buffer, la escritura sin pisar la memoria,
  sin la trampa de los estáticos, `?redes` ignorado, cerrado que cuenta las redes, sin
  aviso por el bus, cerrado que igual deja las redes), 7 sobre `chat.js`, 4 sobre
  `panel.js` y 2 sobre el camino de la Sala (`bus.js` que no manda `?redes`, `sala.js` que
  no lo pide). **Las 23 las caza al menos una prueba.**
- **En vivo**, con un servidor local limpio (archivos JSON en una carpeta temporal, sin
  `servidor/.env`, sin Mongo ni tokens reales, clave de cifrado descartable) y el navegador:
  `/chat/ana` cerrado → interruptor en el panel → la pestaña pública se abrió sola a los
  30 s → dos mensajes de Kick por `/api/prueba/webhook` aparecieron en vivo → cerrar desde
  el panel → la pestaña pasó a "cerrado" en el acto y **el canal quedó con 0 conexiones**.
  `/chat/ana?demo=1` muestra Kick y Twitch mezclados; en 375 px de ancho no hay scroll
  horizontal. La Sala pide `/eventos/ana?redes=kick`. `/chat` se ve como antes.

### Archivos tocados

`servidor/{canales,creadores,almacen,index}.js`, `paginas/chat.html`,
`paginas/chat/{chat.js,chat.css}`, `paginas/panel.html`, `paginas/panel/{panel.js,panel.css}`,
`paginas/comun/bus.js`, `paginas/sala/sala.js`. Pruebas: `pruebas/chat-abierto.test.js`
(nueva, 20), y agregados en `canales`, `pagina-chat`, `pagina-panel` y `pagina-sala`.
Docs: `README.md`, `PLAN-MULTICHAT.md` (estado).

### Cómo verlo funcionando

```bash
npm test
npm run local
# /panel → "Chat para tu comunidad" → prender el interruptor
curl -s localhost:8778/api/chat/<tu-slug>/abierto     # {"abierto":true,"redes":["kick","twitch"]}
curl -sN localhost:8778/eventos/<tu-slug>             # sin cookie: trae Twitch sólo si está abierto
# y /chat/<tu-slug> en otra ventana, sin sesión
```

### Pendiente

- **El Twitch del chat abierto no se vio en vivo, sólo en pruebas.** Localmente no hay forma
  de meter un mensaje de Twitch en el bus desde afuera (`/api/prueba/webhook` es de Kick).
  Lo que falta es mirarlo en producción: abrir el chat desde `/panel` y ver
  `/chat/istincho` en una ventana sin sesión mientras hay gente hablando en los dos chats.
- **Dos guardas sin prueba, declaradas**: el "la carga no pisa la escritura" de
  `creadores.chatAbierto` (es una carrera de milisegundos que no se puede provocar sin un
  almacén lento) y el `almacen.degradado()` (hace falta un Mongo que se caiga). Sacar
  cualquiera de las dos no rompe la suite.
- **`/chat` de un creador que no es el dueño muestra el bus del dueño.** Es de antes: la
  página saca el slug de `/api/estado`, que es `KICK_SLUG`. Con el arreglo del punto 5 ya
  no le filtra el Twitch del dueño, pero sigue mirando la sala equivocada. Tendría que usar
  el slug de su cookie.
- **"N mirando" de la Sala cuenta también a quien lee `/chat/<slug>`**: los dos usan el mismo
  bus. Con el chat cerrado no pasa (la página no se conecta).
- Reconectar el bus reenvía los últimos 200 mensajes y `/chat` y la Sala no deduplican por
  id: después de un corte puede verse un tramo repetido. Es de antes; `/chat/<slug>` lo
  evita al reabrir vaciando las listas.
- El navegador del panel de vista previa no deja registrar el service worker de `/chat`
  ("unknown error when fetching the script"). `/sw.js` sale bien por curl y no cambió; la
  página ya atrapa ese error.

---

## 2026-09-09 — Primera prueba contra las APIs reales: el Chat Global anda

Hasta hoy **nada del proyecto habia tocado una API de verdad**: las cuatro fases se
construyeron y se verificaron contra dobles, fixtures y servidores falsos. Esta es la
primera evidencia de afuera.

Desplegado en Railway con Mongo conectado, `/chat` muestra Kick y Twitch en vivo,
mezclados, con las insignias reales de cada red (Broadcaster / Moderator / Verified
channel del lado de Kick; Streamer y el badge de evento del lado de Twitch), los
colores por red y la salud midiendo bien ("Kick · hace 31 s", "Twitch · conectado").

Lo que eso confirma, y que ninguna prueba podia dar:

- Los dos OAuth reales, con los scopes que pide `SCOPES.dueno`.
- **El webhook de Kick esta llegando**, o sea que el paso 4 bis (prender *Enable
  Webhooks* a mano en el portal) quedo bien. Era el paso que mas caro salia olvidarse:
  sin el, todo parece andar y no llega un mensaje.
- **EventSub de Twitch conectado de verdad**, sin caer al plan B de IRC.
- Los traductores de `mensajes.js` contra payloads reales, no fixtures.

Pendiente de probar: el **envio** (la caja con Kick / Twitch / Ambos). Leer esta
confirmado; escribir es el otro camino y todavia no se ejercito contra lo real.

### Lo que costo llegar hasta aca, para el que despliegue la proxima

- **`ENOTFOUND` de Mongo**: la URI tenia el hostname de ejemplo que el director escribio
  al explicar como armarla (`cluster0.ab1cd.mongodb.net`), copiado literal. Ni red ni
  credenciales: el cluster no existia. **Al documentar una URI conviene poner un
  placeholder que no parezca un valor real.**
- El log solo imprimia `e.name`, asi que decia `Error` a secas y no distinguia una clave
  mal puesta de un host mal escrito. Se le agrego `code` y `codeName`, que son etiquetas
  del driver y no traen la URI adentro. Con eso el diagnostico fue inmediato.
- En local faltaba `npm install`: el modulo de mongo ausente sale disfrazado de
  `mongo fallo en listar (ERR_MODULE_NOT_FOUND)`.
- **Matar `npm run local` no mata el `node` de abajo.** Se midio un rato el proceso
  viejo, que seguia escuchando en el 8778, mientras el nuevo moria con `EADDRINUSE`.
  Hay que matar por el PID que escucha el puerto.
- El respaldo de DNS del almacen hace su trabajo: en la maquina del dueño el resolutor
  no contesta consultas SRV y salta solo a 1.1.1.1, avisando por consola.

### Cambio de permisos

Se saco del `.claude/settings.json` la prohibicion de leer y escribir `.env`. Venia del
blindaje para trabajar en vivo (pantalla al aire = un agente que lee un `.env` lo
imprime en camara), pero el dueño dejo de codear esto en directo y la traba impedia
hasta corregir un host mal escrito. **Sigue prohibido lo que vuelca el entorno entero**
(`printenv`, `env`, `set`, `railway variables`, `gh auth token`), que era el riesgo de
verdad, y los `.env` siguen fuera de git.

---


## 2026-09-07 — Fase 3: las tres dudas que dejó la verificación, cerradas

La Fase 3 **pasó** la verificación independiente. Lo que sigue no rehace nada de
eso: son las tres dudas que el verificador dejó anotadas y que el director
eligió cerrar, las tres baratas. **618 pruebas en verde** (eran 616), la suite
corrida **cuatro veces seguidas sin un solo flake**, las **121 de Python
intactas** y **`herramientas/` no se tocó**. No cambió una línea de `servidor/`:
las tres son pruebas.

### 1. El 403 de `conCreadorOClave` no tenía red

Borrar el bloque `if (!await creadores.existe(slug))` de `index.js` **sobrevivía
la suite entera**, y no es una comodidad: es la línea que impide que **una clave
de subida siga firmando PUT y DELETE después de que la sala se dio de baja**. La
clave vive en `subidas` y la sala en `creadores`, así que darse de baja no la
revoca: sin la guarda, esa clave sigue firmando sobre un prefijo que ya no es de
nadie —y que puede volver a ser de otro dueño el día que alguien se dé de alta
con el mismo slug. El caso análogo de la **cookie** ya tenía prueba ("una sesion
de una sala borrada no abre ningun panel"); el de la clave, no.

`multicanal`: **"una clave de una sala dada de baja no firma nada mas"**. Crea
una sala efímera, saca su clave, **firma con la sala en pie** (para que el 403
de abajo no pueda estar pasando porque la clave nunca sirvió), borra la sala y
exige **403 en `/api/subida` y en `/api/subida/borrar`**. Los dos, porque el
DELETE es el que no necesita ni plan ni URL pública: una guarda puesta sólo del
lado de la subida lo dejaría pasar. Mutación aplicada tal cual —bloque borrado—:
el test se cae, y es el único que se cae.

### 2. La sexta aserción vacua, arreglada; la séptima, declarada

**La sexta** era `assert.equal(salud.estado, 'cortado')` en el test del tope de
`chat-suscripciones`. `EventSubFalso.conectar()` nunca tocaba `this.estado` y un
canal recién creado ya nace en `'cortado'`, así que la igualdad era verdadera
con tope y sin tope. **Se arregló donde estaba el problema, que era el doble**:
ahora `conectar()` pasa a `'conectando'`, igual que la clase de verdad apenas
abre el socket. Como `chat.salud()` contesta
`conexionTwitch?.estado ?? twitch.estado`, ahora una sala conectada y una que no
conectó nunca **no dicen lo mismo**. Comprobado con la mutación de la guarda del
tope (`if (false)`) sobre una copia del test **sin** las aserciones de `tope` ni
las de `eventSubs.length`: se cae, y se cae por esa línea (`+ 'conectando'`).

**La séptima** es `assert.ok(!r.texto.includes(BETO))` en el DELETE de
`multicanal`. Con el filtro sacado la respuesta es `{"error":"error del
servidor"}`, que tampoco contiene "beto": pasa exactamente en el caso que dice
cuidar, y es más débil que el `deepEqual` que tiene arriba. No se toca —cubre la
respuesta entera, no sólo `archivos[].clave`— pero **se declaró como control en
la lista de la entrada de abajo**, que hasta hoy decía que no faltaba ninguna.

### 3. La cache de creadores había dejado de ser LRU sin que nada lo notara

Borrar `cache.delete(slug)` de `guardarEnCache` **sobrevivía**: convertía la
política de desalojo en **FIFO por primera inserción**, lo contrario de lo que
promete el comentario del test ("el que acaba de entrar es el que está hablando
ahora"). El test viejo no podía verlo porque `'ana'` es la primera en los dos
órdenes.

Y la diferencia importa: con FIFO, la sala que está pasando una película —la que
se relee en cada latido del reloj— se suelta igual que una que nadie mira desde
hace horas, así que una ráfaga de slugs inventados le saca la entrada
justamente a la única sala que la estaba usando. Con LRU esa ráfaga sólo se pisa
a sí misma.

`creadores`: **"el tope suelta por ULTIMO USO, no por orden de llegada"**. Entran
`'ana'` y `'beto'` en ese orden, vencen las dos, y se **releen al revés**: la más
recién usada pasa a ser `'ana'` mientras la primera en llegar sigue siendo
`'ana'`. Después se hace lugar para soltar **exactamente una**
(`TOPE_CACHE - 1` slugs inventados) y se miran las dos: `'ana'` tiene que seguir
rancia (LRU) y `'beto'` tiene que salir fresca. Con FIFO se cae la primera; si no
se soltara ninguna, se cae la segunda. Mutación aplicada: se cae.

**De paso, el reloj del test del tope quedó anclado.** Medía ranciedad sin
`mock.timers`: si el loop de 5.001 `existe()` tardara más de `CACHE_MS` en una
máquina cargada, la entrada de `'ana'` habría vencido **por reloj** y el test
pasaba por el motivo equivocado (verde con el tope sacado). Hoy tarda ~140 ms,
36× de margen, pero el margen era de tiempo real. Con el reloj parado sigue
cazando las dos mutaciones que ya cazaba (sin tope, y tope que suelta al recién
llegado); se volvió a comprobar.

### Anotado, no arreglado

Cuatro cosas **documentadas y cumplidas por el código, que ninguna prueba
sostiene**. El director las deja para más adelante; están acá para que quien las
toque sepa que al romperlas la suite no dice nada:

- **`venceEn` en la respuesta de `/api/subida`.** Es el dato con el que
  `subir.py` tiene que decidir el corte de las tandas (la regla de las tandas de
  la entrada de abajo depende de él). Sacarlo no rompe ninguna prueba.
- **`archivos[].ruta` en esa misma respuesta.** El script empareja por ahí lo que
  pidió con lo que le firmaron.
- **`TOPE_ARCHIVOS = 500`** en `/api/subida`: existe para que un solo pedido no
  arme cien mil URL, y nada lo prueba.
- **`videos.idValido(id)`** en las **dos** rutas de subida (firmar y borrar): es
  lo que impide que el `id` se meta en la clave de R2 con cualquier forma.
- Y una más chica: **`CACHE_MS` se prueba por la constante exportada**
  (`tick(creadores.CACHE_MS + 1)`), así que lo probado es el **mecanismo** del
  vencimiento, no el **valor**. Cambiar los cinco segundos por cinco horas no
  rompe nada.

### Cómo verlo funcionando

```bash
npm test                                     # 618 en verde
node --test pruebas/multicanal.test.js       # el 403 de la clave que sobrevivió a la sala
node --test pruebas/creadores.test.js        # la cache: guarda, vence, tiene tope y es LRU
node --test pruebas/chat-suscripciones.test.js
python herramientas/pruebas_subir.py         # las 121 de Python, intactas
```

### Archivos tocados

`pruebas/`: `multicanal.test.js` (el test del 403), `creadores.test.js` (el test
de LRU y el reloj anclado en el del tope), `chat-suscripciones.test.js`
(`EventSubFalso.conectar()` cambia `estado`, y el mensaje de la aserción que
ahora muerde).

`BITACORA.md`: esta entrada, la corrección de la frase de `R2_URL_PUBLICA` y las
dos aserciones que le faltaban a la lista de controles de la entrada de abajo.

**Ni una línea de `servidor/`.** Sin dependencias nuevas. **`herramientas/` no se
tocó.**

### Qué queda pendiente

Lo mismo que la entrada de abajo, más los cinco puntos de "anotado, no
arreglado" de acá arriba.

---

## 2026-09-07 — Fase 3: lo que encontró la verificación, cerrado

Las cuatro fallas de la verificación independiente, cerradas, más tres guardas
que no tenían una sola prueba y una variable que faltaba en el lugar donde se
decide si la subida puede empezar. **616 pruebas en verde** (eran 607), la suite
corrida **tres veces seguidas sobre el código final sin un solo flake**, y **13
mutaciones nuevas aplicadas una por una, cada una tal como la describe su
renglón: las 13 se caen.** Las 121 de Python siguen en verde y
**`herramientas/` no se tocó**.

### Las cuatro fallas eran la misma falla

Ninguna era un bug de producción: las cuatro eran **aserciones que dan lo mismo
con el código bueno y con el código roto**, que es peor que no tener la prueba,
porque una prueba verde se lee como una promesa cumplida.

Y las cuatro tienen la misma forma, que conviene poder reconocer de acá en
adelante: **la prueba mira algo que la implementación no puede producir**. Una
respuesta que no emite el slug jamás va a contener "beto". Una ruta que ya fue
rechazada por `claveValida` nunca llega a la comprobación del prefijo. Un
default que sale de una variable de entorno que ese proceso no tiene se resuelve
al mismo `''` que la guarda ya atajaba. En los tres casos el test pasa, y pasa
por una razón que no es la que dice el nombre del test.

**F1 — `firmar()` recibe el slug y lo comprueba.** El encabezado de `r2.js`
prometía que la frontera del prefijo se comprobaba en el call site *y de nuevo*
al firmar; `firmar()` ni siquiera recibía el slug, así que
`r2.firmar('DELETE', 'otrocreador/loquesea.ts')` devolvía una URL válida para
borrarle la película a otro. Ahora el slug es **posicional y obligatorio**, la
comprobación vive adentro, y el comentario dice lo que hace el código. Un call
site viejo (`firmar(metodo, clave, { segundos })`) pasa el objeto de opciones
donde va el slug y **explota en el acto**: eso también tiene su prueba, porque
el encabezado lo promete.

**F2 — la frontera del bucket, del lado donde se puede alcanzar.** La prueba
vieja ("una ruta que se escapa del prefijo no se firma") usaba cuatro rutas
—`../beto/…`, `../../otro.ts`, `/absoluta.ts`, `a//b.ts`— que **rechaza
`claveValida` sola**: `esDeLaSala` no participaba, y sacarla no rompía nada.

Al mirarlo de cerca, el problema no era la prueba: era la guarda. En el camino
de la subida la clave se arma acá (`` `${slug}/${id}/${ruta}` ``), así que
empieza siempre con el prefijo y `esDeLaSala` **no podía dar false nunca**. Era
código muerto, y una mutación sobre código muerto no se cae jamás. Las dos
salidas honestas eran hacerla alcanzable o correrla a donde sí lo es; se hizo lo
segundo. Hoy:

- la comprobación vive en **`r2.firmar`**, que la aplica a los dos call sites y
  a los que se escriban mañana, con pruebas propias en `r2.test.js`;
- el camino del **DELETE** conserva su filtro, y ahí sí es alcanzable: **esas
  claves no las arma este servidor, las contesta R2 en un XML**. La prueba nueva
  le hace contestar a R2 un listado con una clave de la sala de al lado, una con
  el prefijo sin la barra (`anaconda` para `ana`) y una con `..` adentro, y
  exige que lo único firmado sea el archivo propio.

Los dos cinturones hacen falta y no son el mismo: sin el filtro, una sola clave
ajena en la respuesta de R2 hace que `firmar` tire y el creador **no pueda
borrar nada suyo** (la prueba lo ve como un 500 donde esperaba un 200).

**F3 — la salud del chat: la quinta aserción vacua de esta familia.** Decía
`assert.ok(!r.texto.includes(BETO))` sobre `/api/chat/salud`, y `chat.salud()`
**no emite el slug de nadie**: devuelve booleanos, fechas ISO y cuatro estados.
La cadena "beto" no podía aparecer bajo ninguna implementación. Con
`chat.salud('beto')` cableado en la ruta —o sea Ana viendo el estado de la
suscripción de Kick de Beto, su última llegada y su conexión de Twitch— el test
seguía en verde.

Ahora las dos salas se ponen en **estados distintos por el camino de verdad**
(webhooks firmados que entran por `/kick/webhook`: Ana al aire, Beto no, y un
mensaje que llega sólo a la sala de Beto) y se afirman **los dos lados**, así
que la ruta devolviendo la sala equivocada se cae mirando para cualquier lado.

Las otras cuatro de la familia se revisaron una por una y **no son vacuas**:
`/api/panel` y `/api/videos` sí emiten el slug y el catálogo, y las cuatro
tienen al lado una aserción positiva (`every(v => v.slug === …)`, un `deepEqual`
de claves). Lo que se agregó es que ninguna quede sola: la de string es el
cinturón contra un campo nuevo que traiga datos ajenos mañana, **nunca la única
prueba del aislamiento**.

**F4 — la promesa de `vinculos.js`, sostenida contra el bug que alguien
escribiría.** El encabezado dice, con todas las letras, que "lo cómodo habría
sido agregar el slug al final con el del dueño como default". Las ocho
aserciones que lo sostenían cazaban un default **literal**
(`slug || 'istincho'`) y no el que sale del entorno
(`slug || process.env.KICK_SLUG`), que es exactamente el que describe el
comentario. Motivo: `pruebas/vinculos.test.js` nunca seteaba `KICK_SLUG`, así
que en ese proceso el default se resolvía a `''` y la guarda disparaba igual.
**La mutación sobrevivía la suite entera.**

El arreglo son tres palabras (`process.env.KICK_SLUG = 'istincho'` en la
cabecera de ese archivo) y quince renglones de comentario explicando por qué
están, porque sin el comentario el próximo que ordene imports las borra por
inútiles. Con la variable puesta —como está en Railway y en cualquier proceso de
verdad— `leer(undefined, 'kick')` devuelve el vínculo del dueño en vez de tirar,
y las dos formas de la mutación se caen.

### Tres guardas que sobrevivían la suite entera

Ninguna es un bug: son tres topes que estaban puestos, bien argumentados en su
comentario, y que **se podían borrar sin que nada se pusiera rojo**. El
argumento de la bitácora anterior para el tope de métricas ("una cache negativa
sin tope es el mismo problema corrido un casillero") valía igual para la cache
de creadores, y esa no tenía ninguna prueba.

- **`TOPE_TWITCH`** (`chat.js`). Es lo que separa "este servidor llegó a su
  tope" de "Twitch está cortado", que es lo que vería el creador sin el campo
  `tope` en su panel. `chat-suscripciones.test.js` corre con `TOPE_TWITCH=2`
  —igual que `TOPE_CANALES=4` en `multicanal`— y prueba que la tercera sala no
  abra conexión, que su salud diga `tope: true` con `vinculado: true`, y, como
  control, que **reconectar una que ya estaba sí se pueda** aunque estemos en el
  tope: es lo que pasa cada vez que se refresca un token, y sin ese control
  "no conectar nunca a nadie" pasaría el resto del test.
- **El vencimiento de la cache de creadores** (`creadores.js`). Sin él, un
  documento cambiado por fuera de este proceso —el otro contenedor el día que
  haya dos, o el dueño tocando Mongo a mano— queda rancio **para siempre** y no
  cinco segundos. El test mueve el reloj con `mock.timers` en vez de dormir
  cinco segundos: un test que duerme cinco segundos es un test que alguien
  borra.
- **El tope del Map de esa cache** (`creadores.js`). La cache guarda también a
  los que no existen, que es lo que hace que `/eventos/<slug inventado>` no sea
  una consulta por pedido; sin tope, eso es el mismo ataque corrido un
  casillero, de la base a la memoria. El Map no se puede mirar desde afuera y
  **no se le abrió una costura al código de producción para que un test lo
  espíe**: se mide por lo único observable, la ranciedad de la entrada más
  vieja. Si sigue rancia después de llenar el Map, no se soltó. Se caen las dos
  mutaciones: sacar el tope, y soltar al recién llegado en vez de al más viejo.

`CACHE_MS` y `TOPE_CACHE` salieron exportados: una prueba que repita el número a
mano deja de probar el código el día que alguien lo cambie.

### `R2_URL_PUBLICA` entra en `hayCredenciales()`

`hayCredenciales()` miraba cuatro variables y `porQueNoHay()` nombraba cinco.
Con las cuatro primeras cargadas y esa sin cargar, `/api/subida` contestaba
**200** con `urlPublica: "/ana/ep1/"` —sin host—, el creador subía la película
entera contra URL que sí funcionaban, y el error aparecía recién en el
`POST /api/videos` siguiente como `400 "url invalida"`, **que no nombra ninguna
variable**. Es el error más caro posible de la única tarea que tarda una hora.

Ahora las dos funciones son la misma pregunta y contestan lo mismo
(`hayCredenciales()` es literalmente `!porQueNoHay()`): faltando cualquiera de
las cinco se contesta **503 con el nombre de la que falta, antes de subir un
byte**. Hay prueba de las dos mitades, la unitaria y la de la ruta.

**El precio, escrito con todas las letras:** sin `R2_URL_PUBLICA` tampoco se
firman los **DELETE**, que no la necesitan. Se eligió igual porque la
alternativa es una matriz de "qué se puede hacer con cuáles variables" que hay
que mantener y probar, y el caso que queda afuera es chico: sin esa variable no
se subió nada **por este servidor**, así que casi todo lo que se podría querer
borrar tampoco está. ⚠ *Corregido: "casi" no es "nada".* Lo que sí está es **lo
que el dueño subió en la Fase 2 con su propio token desde su PC**, que vive en
el bucket sin que este servidor haya tenido nunca esas variables: si algún día
`R2_URL_PUBLICA` se borra de Railway, `/api/subida/borrar` deja de firmar esos
DELETE. Impacto bajo —la salida es el script local, que tiene el token— y el
503 dice el nombre exacto de lo que hay que volver a poner.

### Lo que se corrigió de la entrada de abajo

Está marcado ⚠ ahí mismo, para que nadie la lea sin la corrección:

1. **Dos filas de la tabla de "38 mutaciones, 38 cazadas" eran falsas** —las de
   F2 y F4—: aplicadas como las describe su renglón, sobrevivían. Corregidas, y
   con las mutaciones nuevas al lado.
2. **La decisión 8** decía que la ruta que elige el creador pasa "por
   `claveValida` y `esDeLaSala`". Ya no: en ese camino `esDeLaSala` no podía dar
   false nunca. La frontera la exige `r2.firmar`.
3. **La especificación de `subir.py`, punto A**, presentaba `--sala <slug>` como
   trabajo por escribir. **Ya está escrito** desde `4f63d9e`, anterior a esta
   fase: `subir.py:1271` declara el argumento, `prefijo_de()` lo resuelve,
   `validar_slug()` lo valida —incluido el camino destructivo— y
   `PruebaValidarSala` lo prueba. Quien tome el entregable 5 empieza por B.
4. **Faltaba la regla que importa de las tandas.** La spec usaba el tope del
   servidor (500 archivos) como tamaño de tanda, y ese es justo el número que no
   funciona: 500 segmentos de 6 s a 720p y 2,5 Mbps son ~940 MB, que con una
   subida hogareña de 10 Mbps son **12,5 minutos**, y las URL vencen a los
   **600 segundos**. La última URL de cada tanda vence antes de llegar, y el
   síntoma es un 403 de R2 sin explicación que además cambia en cada máquina
   porque depende del ancho de banda de casa. **La tanda se corta por bytes, no
   por cantidad** (o se vuelven a pedir las URL vencidas); la respuesta trae
   `venceEn` justamente para poder decidir.
5. **Faltaba el 403.** `conCreadorOClave` contesta
   `403 "esa clave no corresponde a ninguna sala"` cuando la clave sobrevivió a
   la sala. Es distinto del 401 —la clave es válida— y merece su propio mensaje:
   decirle "generá otra" lo manda a un panel al que no puede entrar.

### Las 13 mutaciones nuevas, y qué las caza

Cada una se aplicó sobre el árbol de verdad con un arnés que compara en LF y
restaura siempre, se corrió la suite contra el código roto, y se restauró. Cada
renglón se aplicó **como está redactado**, no en la lectura más conveniente.

| Mutación | Pruebas que se caen |
|---|---|
| `vinculos.validar` cae en `process.env.KICK_SLUG` cuando falta el slug | `vinculos`: "sin slug no se lee, no se guarda…" |
| `vinculos.validar` cae en un slug literal | `vinculos`: la misma |
| `/api/chat/salud` contesta `chat.salud('beto')` | `multicanal`: "la salud del chat es la de su propia sala" |
| `/api/chat/salud` contesta `chat.salud('ana')` | `multicanal`: la misma |
| `firmar()` no comprueba `esDeLaSala` | `r2`: "firmar no firma una clave que no es de la sala…", "el DELETE de una clave ajena…", "un call site viejo…" |
| el camino del DELETE no filtra lo que contesta R2 | `multicanal`: "un listado de R2 con una clave de otra sala no firma ese borrado" |
| la subida arma la clave con el slug que manda el cliente | `multicanal`: "el prefijo sale de la cookie…" y "la clave de una sala no firma nada de otra" |
| la subida no comprueba `claveValida` | `multicanal`: "una ruta que se escapa del prefijo…" y "la clave de una sala no firma nada de otra" |
| `hayCredenciales()` vuelve a mirar cuatro variables | `r2`: "con todo cargado menos la URL publica…" · `multicanal`: "sin R2_URL_PUBLICA no se firma nada…" |
| no hay `TOPE_TWITCH` | `chat-suscripciones`: "el tope de conexiones de Twitch frena la que sobra…" |
| la cache de creadores no vence | `creadores`: "la cache se vence sola a los cinco segundos" |
| el Map de la cache no tiene tope | `creadores`: "la cache no crece para siempre…" |
| el tope de la cache suelta al recién llegado | `creadores`: la misma |

### Cuáles de las aserciones nuevas son controles, y por qué están

Se revisó cada una preguntando *"¿esto sería verdad igual si el arreglo no
existiera?"*. Estas contestan que sí y están puestas **a propósito**, con el
motivo escrito al lado en el archivo:

- `chat-suscripciones`: "reconectar a una que ya estaba no puede chocar contra
  el tope" impide que el arreglo sea "no conectar a nadie más nunca".
- `creadores`: "todavía adentro de la ventana: tiene que salir de la cache"
  impide que el vencimiento se arregle borrando la cache entera.
- `creadores`: "todavía rancia, como corresponde" (en el test del tope) impide
  que el test pase porque no hay cache, en vez de porque hay tope.
- `multicanal`: en el DELETE, `assert.equal(r.estado, 200)` impide que el filtro
  se "arregle" fallando el pedido entero, que dejaría al creador sin poder
  borrar nada suyo.
- `r2`: "y la clave de su propia sala se firma igual que siempre" impide que el
  arreglo sea no firmar nunca, que dejaría a todos sin poder subir.
- ⚠ *Agregada por la entrada de arriba:* `multicanal`, en el DELETE de la clave
  ajena, `assert.ok(!r.texto.includes(BETO))`. Es un cinturón por afuera del
  `deepEqual` que está arriba suyo y **más débil que él**: con el filtro sacado
  la respuesta es `{"error":"error del servidor"}`, que tampoco contiene "beto",
  así que pasa exactamente en el caso que dice cuidar. Se queda porque el
  `deepEqual` sólo mira `archivos[].clave` y esto mira la respuesta entera
  —incluidas las URL firmadas—, pero **no cuenta como cobertura de nada**.

Ninguna se cae con ninguna de las 13 mutaciones, y ninguna se cuenta como
cobertura en la tabla de arriba.

⚠ **Esta lista estaba incompleta**: le faltaban dos. La de arriba es una; la
otra —`assert.equal(salud.estado, 'cortado')` en el test del tope de
`chat-suscripciones`— no era un control sino un descuido, y **se arregló** en la
entrada de arriba en vez de declararse.

### Anotado, no arreglado

- **Un plan que vence en la mitad de la película tapa el reloj, no la
  proyección.** Si el vencimiento cae mientras la sala está pasando algo, el
  creador **no puede pausar ni detener** (402 sobre todas las acciones del
  reloj) pero la película sigue: el reloj ya está corriendo y los espectadores
  piden los segmentos directo a R2. Y el bucket es público, así que las URL son
  legibles con o sin plan. Es coherente con "el servidor nunca sirve video" —lo
  que se cobra es poder manejar la función, no el ancho de banda, que no es
  nuestro— y **lo confirmó el dueño**. Queda escrito porque es lo primero que va
  a sorprender el día que le pase a alguien.
- **El webhook de Paddle no deduplica ni ordena.** Se aplica lo que llegue
  último: dos eventos fuera de orden dentro de los 60 segundos de tolerancia —un
  `subscription.canceled` viejo entregado después de un `activated` nuevo—
  dejarían la sala en "vencido" con la suscripción activa. Riesgo bajo: Paddle
  rara vez reordena y el `subscription.updated` siguiente lo corrige solo. El
  arreglo, el día que se haga, es barato: el payload trae `event_id` y
  `occurred_at`, así que alcanza con guardar el último aplicado por sala e
  ignorar lo que sea más viejo.

### Cómo verlo funcionando

```bash
npm test                                     # 616 en verde
node --test pruebas/multicanal.test.js       # el aislamiento, por HTTP
node --test pruebas/r2.test.js               # la frontera del bucket
node --test pruebas/creadores.test.js        # la cache: guarda, vence y tiene tope
node --test pruebas/chat-suscripciones.test.js
python herramientas/pruebas_subir.py         # las 121 de Python, intactas
```

### Archivos tocados

`servidor/`: `r2.js` (el slug obligatorio en `firmar`, `hayCredenciales` con las
cinco variables), `index.js` (los dos call sites, el filtro del DELETE, la
guarda muerta de la subida), `creadores.js` (`CACHE_MS` y `TOPE_CACHE`
exportados; ni una línea de comportamiento).

`pruebas/`: `r2.test.js`, `multicanal.test.js`, `vinculos.test.js`,
`creadores.test.js`, `chat-suscripciones.test.js`.

`README.md`: la fila de `R2_URL_PUBLICA` (decía que sin ella "la ficha del video
apuntaría a ningún lado", y ahora la subida ni empieza) y el párrafo de la
frontera del prefijo, que nombraba una comprobación que en ese camino no podía
disparar.

`BITACORA.md`: esta entrada y las cinco correcciones de la de abajo.

Sin dependencias nuevas. **`herramientas/` no se tocó.**

### Qué queda pendiente

Lo mismo que dejó la entrada de abajo, sin cambios: el entregable 5 del lado de
`herramientas/subir.py` (puntos B a F de esa especificación, ya sin el punto A y
con la regla de las tandas), y todo lo que no se puede probar hasta que el dueño
cargue las variables (Kick con un creador de verdad, R2 aceptando la firma,
Paddle en sandbox, Twitch multi-creador contra el contenedor real).

---

## 2026-09-07 — Fase 3: otros creadores

Cualquier streamer de Kick entra por `/crear`, acepta los términos y tiene su
Sala en `/sala/<su-slug>`, con su panel, sus videos, su chat y su plan.
**607 pruebas en verde** (eran 449), la suite corrida **tres veces seguidas
sobre el código final sin un solo flake**, y **38 mutaciones aplicadas una por
una: las 38 se caen.** Las 121 pruebas de Python de `herramientas/` siguen en
verde y esa carpeta **no se tocó**.

Lo que cambia de verdad no es que haya páginas nuevas: es que **el slug dejó de
ser una constante**. Todo lo que antes decía "el dueño" ahora dice "esta sala",
y las tres minas que la Fase 2 dejó marcadas eran exactamente los lugares donde
esa diferencia todavía no existía.

### Las tres minas de la Fase 2, cerradas

**1. El chat del espectador ruteaba por el dueño, no por la sala.**
`apiSalaChat` mandaba el mensaje a `vinculos.identidad('kick')` —sin slug—, o
sea al canal del dueño del servicio, escribiera el espectador en la sala que
escribiera. La Fase 2 lo tapó con un 503 para las salas ajenas y su propio autor
lo llamó *"un cartel de obra, no la solución"*.

Ahora se rutea: `vinculos.identidad(slug, 'kick')`, con el slug del camino de la
URL, que ya pasó por `canalPermitido`. **El guard del 503 se sacó**, y el 503
que queda es el de siempre: esta sala todavía no vinculó Kick.

La prueba que lo cuida no mira un código de estado sino **a dónde fue el
mensaje**: abre el cuerpo que salió hacia Kick y exige que el
`broadcaster_user_id` sea el del otro creador (7777) y no el del dueño (4242).
Con el ruteo roto el pedido contesta 200 igual; la única forma de ver la
diferencia es abrir el pedido. Al lado va su control negativo, una sala que
existe y no vinculó Kick, para que "no salió nada" y "salió al lugar
equivocado" no se vean iguales desde afuera.

**2. El orden del guard, decidido.** La Fase 2 preguntó si era a propósito que
el chat contestara antes de leer la cookie y el reloj después. La respuesta es
que sí, y ahora **las dos rutas lo hacen igual: primero la sala, después la
cookie.**

El argumento: *"¿existe esta sala?"* es un hecho sobre la sala y no sobre quien
pregunta, y ya se puede averiguar sin ninguna cookie pidiendo `GET /sala/<slug>`,
que contesta 404. Contestarlo primero no cuenta nada que no se sepa, y evita el
caso raro de contestar 401 sobre una sala inexistente, que manda a buscar una
cookie para una puerta que no está. **El precio, escrito con todas las letras:
un POST sin cookie a una sala que no existe ahora da 404 y antes daba 401.** Hay
una prueba que fija las dos rutas hermanas contestando lo mismo.

**3. `canalPermitido` salía a `creadores` en cada `/eventos/:slug`.** Ahora pasa
por una cache de 5 segundos en `creadores.js`, con invalidación en cada
escritura (lo que hace que marcar a alguien como amigo desde `/admin` se sienta
instantáneo, sin depender del TTL).

La cache guarda **también los que no existen**, y eso no es un detalle de
rendimiento: sin la cache negativa, `/eventos/<slug inventado distinto cada vez>`
sigue siendo una consulta a Mongo por pedido, que es exactamente el modo barato
de voltear el servicio que `canalPermitido` vino a cerrar. Y por eso mismo el
Map tiene tope: una cache negativa sin tope es el mismo problema corrido un
casillero, de la base a la memoria.

**4. `metricas.js` tenía un Map sin tope.** Estaba a salvo por casualidad (todos
sus llamadores pasaban slugs ya validados). Ahora los slugs entran por el webhook
y por cada `/eventos/:slug`, así que tiene tope de 2.000 y suelta los más viejos.
Hay dos pruebas: que no crezca, y que el que se suelte sea el viejo y no el
recién llegado —soltar el nuevo dejaría el contador de la sala que está hablando
*ahora* siempre en cero—.

**5. La carrera de `/eventos/:slug`, confirmada con I/O de verdad.** El arreglo
de la Fase 2 anota la bandera de cerrado **antes** de los dos `await`, y la
ventana que preocupaba se abría justo cuando `canalPermitido` sale a Mongo, o
sea en esta fase. Sigue sin haber un solo `await` entre el `if (cerrado)` y el
`suscribir`, y ahora el primer `await` hace trabajo real (o cortocircuita en la
cache). El arreglo aguanta porque no depende de cuánto tarde lo de arriba, sino
de que no haya nada en el medio; la prueba de la Fase 2 sigue verde.

### Lo que quedó funcionando

- **`/crear`**: los términos con casilla obligatoria y "Entrar con Kick"
  (`rol=creador`, scopes `user:read channel:read chat:write events:subscribe`).
  Crea el creador en `creadores` con plan `pendiente`, guarda su vínculo de Kick
  cifrado, suscribe `chat.message.sent` de su canal con **su** token, y lo manda
  a `/panel`. **Tope de 900 canales**, con el motivo escrito: la app de Kick sin
  verificar admite 1.000, y pasado eso las suscripciones fallan y el chat de los
  que entren queda mudo sin ningún error visible.
- **`/terminos`**: texto en castellano claro, sin JavaScript. El contenido es del
  creador y responde por él; el servicio puede bajar contenido ante un reclamo;
  no hay garantía de disponibilidad.
- **Multi-canal de punta a punta.** El webhook de Kick se rutea a la sala del
  `broadcaster_user_id` (con el `channel_slug` de respaldo) y **descarta lo que
  no se pueda atribuir a una sala que existe**. `chat.js` pasó a tener un juego
  de estado por sala: conexión de Twitch, plan B, dedupe y salud, todo adentro de
  un Map por slug.
- **Twitch por creador**, opcional, desde su panel, con su token y su propia
  conexión EventSub. Con tope de conexiones simultáneas (ver abajo).
- **Planes** `pendiente | amigo | pago | vencido` en `creadores`, con `/admin`
  para el dueño del servicio. Un creador sin plan activo ve su panel en modo
  sólo lectura, con el botón de suscribirse.
- **`servidor/cobro.js`**: dos funciones y un registro de proveedores, con
  `servidor/cobro-paddle.js` (Paddle Billing, checkout alojado, webhook con firma
  verificada) como única implementación. Precio y moneda por variable.
- **`servidor/r2.js`**: SigV4 escrito a mano (sin dependencias) para firmar las
  URL de subida y de borrado de cada creador, y para medir cuánto ocupa cada sala
  en el bucket.
- **Aislamiento**, con pruebas: `pruebas/multicanal.test.js` levanta el servidor
  de verdad con dos creadores y prueba que no exista ninguna forma, por HTTP, de
  pedir los datos de otra sala.

### Las decisiones que importan, y por qué

**1. El slug va primero y es obligatorio, sin valor por defecto.** Es la decisión
más importante de la fase. `vinculos.leer('kick')` pasó a ser
`vinculos.leer(slug, 'kick')`, y lo cómodo habría sido agregar el slug al final
con el del dueño como default. No se hizo: **el bug que la Fase 2 dejó anotado
era exactamente ese**, y con un default cualquier call site nuevo que se olvide
lo repite y anda "bien" hasta el día que haya dos creadores hablando a la vez.
Sin default, olvidarse tira.

Esa promesa está escrita en el encabezado de `vinculos.js`, y **la mutación que
la rompe sobrevivía la suite entera** hasta que se le escribieron pruebas
propias: hoy todos los call sites pasan el slug, así que el default no cambiaba
nada observable. Un comentario que promete algo que ninguna prueba sostiene es
la falla que este proyecto ya cometió dos veces; ahora hay ocho aserciones que lo
sostienen.

**2. El plan del dueño del servicio NO sale de la base.** `planDe()` compara el
slug contra `KICK_SLUG` y contesta `'dueno'` **antes** de leer el documento, y
`existe()` contesta `true` para él sin tocar el almacén. Lo segundo no es sólo
seguridad: es lo que hace que su Sala funcione con la colección vacía, que es
como está hoy y como va a estar el primer día de producción.

Hay una prueba que le escribe a mano la fila con el peor valor posible
(`plan: 'vencido', vence: 1`) y exige que siga pudiendo reproducir.

**3. Un vencimiento que ya pasó baja el plan solo**, aunque el campo siga
diciendo "pago". El webhook de cobro es lo único del sistema que llega de afuera
y puede no llegar —se cayó el proveedor, cambió la clave, se desconfiguró la
notificación—. Si no llega, el servicio tiene que cortarse; lo contrario es el
error que no se descubre nunca. `/admin` muestra **los dos** planes cuando no
coinciden, porque esa diferencia es lo único que explica por qué alguien con
"pago" en la base no puede reproducir.

**4. Quién puede poner qué plan lo exige el modelo, no la ruta.**
`creadores.ponerPlan(slug, plan, { quien })` rechaza que el dueño ponga "pago" o
"vencido" y que el cobro ponga "amigo" o "pendiente". Vive ahí y no en `/admin`
para que valga también para el call site que se escriba mañana. Si el dueño
pudiera poner "pago" a mano, la base y el proveedor se irían separando y no
habría forma de saber cuál manda.

**5. El plan tapa el reloj entero, no sólo "reproducir".** Si sólo se tapara el
play, un plan vencido podría seguir pausando y saltando una película que ya
estaba andando, que es la misma función por otro nombre. Se contesta **402**, que
es el código que existe para esto.

**El chat NO pasa por el plan**, a propósito: es un proxy al chat de Kick del
propio creador, no cuesta ancho de banda y el creador lo podría hacer sin
nosotros. Lo que se cobra es pasar la película.

**6. El token de R2 pasó a Railway, y es el único cambio de reglas de la fase.**
Hasta la Fase 2 vivía sólo en la PC del dueño, y estaba bien: el único que subía
era él. A un creador no se le puede dar el token del bucket —con él leería,
pisaría y borraría los videos de todos, incluidos los del dueño—, así que el
servidor tiene que poder firmar URL acotadas, y **firmar es, por definición,
tener el secreto**.

Lo que **no** cambia, y es lo que importa: el video no pasa por Railway. El
servidor firma una URL de unos cientos de bytes; los gigas van del creador a R2 y
de R2 al espectador. Está en `TAREAS-DUENO.md` como tarea 17, con la recomendación
de que sea un token distinto del de la PC.

**7. El tope de GB se compara contra lo que dice R2, no contra lo declarado.**
Los bytes que manda el que sube los elige el mismo al que se le está poniendo el
límite. Por eso `r2.js` sabe listar: antes de firmar, se mide el prefijo de esa
sala contra el bucket. Hay una prueba que declara **un byte** con 2 GB ya usados
y exige un 409.

Cuando R2 no contesta se usa la última foto guardada, que es la dirección segura:
si un fallo se leyera como "no usa nada", el tope dejaría subir todo lo que se
quiera justo cuando R2 está caído.

**8. El prefijo se arma en el servidor.** La clave es
`` `${slug}/${id}/${ruta}` `` con el slug de la cookie (o de la clave de subida) y
el `id` ya validado; lo único que elige el creador es lo que va después, y aun eso
pasa por `claveValida`. `esDeLaSala` exige la barra: sin ella, el slug `ana`
firmaría claves de `anaconda`, que es el prefijo de otro creador.

> **Corregido el 2026-09-07:** este párrafo decía que la ruta pasaba "por
> `claveValida` y `esDeLaSala`", y en el camino de la subida `esDeLaSala` no
> podía dar false nunca: la clave se arma con el prefijo puesto. Era una guarda
> que ninguna prueba podía alcanzar y un renglón de la tabla de mutaciones que
> no se caía. Ahora la frontera la exige **`r2.firmar`**, que la comprueba para
> todos los call sites y tiene pruebas propias. Ver la entrada de arriba.

**9. Una conexión EventSub por creador es legal; lo que no escala es la RAM.**
Verificado en la doc de Twitch: el límite de 3 WebSockets es **por par (client
id, user id)**, y leer el chat propio con el token propio cuesta 0 del
presupuesto de 10. O sea que N creadores son N presupuestos independientes.

Lo que no aguanta 900 es este contenedor: 900 sockets, 900 timers de keepalive y
900 buffers. Va un tope propio (`TOPE_TWITCH`, 50) **visible en el panel**: el
creador que quede afuera ve "este servidor llegó a su tope" y no "cortado", que
es lo que diría sin ese campo y no se distinguiría de Twitch caído. Kick, que es
lo que la Sala necesita, entra por webhook y no gasta ninguna conexión.

**10. `/admin` da 404 y no 403 a quien no es el dueño.** Una dirección que
contesta distinto ya anuncia que existe un panel de administración y cómo se
llama. Es la única página del proyecto que se protege del lado del servidor; las
demás son HTML sin datos y lo que se cuida es la API.

**11. La ventana de la firma de Paddle es de 60 segundos y no de 5.** Paddle
documenta 5 y sus SDK usan ese número. Con 5, un contenedor con el reloj corrido
diez segundos rechaza **todos** los webhooks: el plan de todos los que pagan deja
de actualizarse y el síntoma es "pagué y no anda", el peor de todos.

Fallar cerrado sirve cuando algo se pierde al fallar abierto, y acá no se pierde
nada: **todos los campos de un evento de Paddle son absolutos** —el estado de la
suscripción y su `next_billed_at` vienen adentro—, así que reprocesar un evento
repetido escribe exactamente lo mismo. Un repetido no regala un mes porque el
vencimiento se copia del payload y no se calcula desde "ahora". Lo que la ventana
sigue atajando es un evento capturado hace meses, y 60 segundos alcanzan de
sobra. Se cambia con `PADDLE_TOLERANCIA_S`.

**12. `past_due` sigue como "pago".** Es un cobro que falló y que Paddle va a
reintentar durante días; cortarle el servicio en el primer rechazo a alguien cuya
tarjeta se venció es perder al cliente por un trámite. No queda abierto para
siempre: el `next_billed_at` que ya estaba guardado se pasa y `planDe` lo baja
solo.

**13. El precio que se muestra y el que se cobra son dos cosas.** El brief pide
precio y moneda por variable; lo que se cobra es lo que esté cargado en Paddle, y
este servidor no lo consulta. **Es lo único del cobro que puede quedar
desincronizado**, y está escrito arriba de `precio()` en `cobro.js` y en el
README en vez de dejarlo para que alguien lo descubra.

**14. La cookie `sala_dueno` no cambió de nombre.** Sigue queriendo decir lo
mismo que decía —"el dueño de esta sala"—; lo que cambió es que ahora hay más de
una sala. Lo que sí se separó, y está escrito en el encabezado de `index.js` y en
el README, es que **"dueño" quiere decir dos cosas**: dueño de *una sala* (la
cookie) y dueño del *servicio* (`KICK_SLUG`). `conDuenoDeLaSala` ya tenía el
nombre correcto desde la Fase 2.

**15. La atribución del evento salió de `chat.js`.** La guarda que decidía si un
evento del webhook entraba —el `if (slug !== slugDueno)` que devolvía
`canal ajeno`— era la forma de un solo inquilino de preguntar "¿de qué sala es
esto?". Ahora eso vive en `creadores.salaDelEvento()` y `chat.js` recibe una sala
ya resuelta. Es lo que hace que agregar un creador no toque el archivo del chat.

Se rutea por `broadcaster.user_id` antes que por `channel_slug`: los dos viajan
adentro del cuerpo que Kick firmó con RSA, así que ninguno es "más seguro"; el
número es el que **no cambia** si el streamer se renombra en Kick.

### Un cambio deliberado sobre una decisión de la Fase 2

**La clave de subida ahora también puede LEER el catálogo de su sala.** El test
de la Fase 2 decía que servía para escribir y no para leer.

Con un solo creador esa restricción no costaba nada; con la Fase 3 sí, porque
`subir.py --listar` de un creador no tiene otra forma de saber qué hay del lado
del servidor: no tiene cookie ni token de R2. Y la restricción **dejó de ser
coherente**: desde que la misma clave firma los `DELETE` de R2 de su prefijo (que
es lo que necesita `--borrar`), poder leer el catálogo es estrictamente menos que
lo que ya podía hacer.

La regla que queda es más simple de enunciar: **la clave puede todo sobre los
videos de SU sala, y nada más.** Hay una prueba para cada mitad, y la segunda
—que la clave no abre `/api/panel`, no genera otra clave, no toca el reloj y no
lee la salud del chat— es la que impide que "la clave puede leer" se estire hasta
"la clave es una sesión".

### Qué tiene que cambiar en `herramientas/subir.py`

**No se tocó `herramientas/`**, como estaba pedido. Esto es lo que hay que
escribir ahí para cerrar el entregable 5, con la precisión que la Fase 2 usó para
pedir sus dos rutas.

El servidor ya tiene todo lo necesario. Nada de esto necesita un cambio más del
lado de `servidor/`.

**A. El argumento `--sala <slug>`. YA ESTÁ ESCRITO: no hay nada que hacer acá.**

> **Corregido el 2026-09-07.** Esta entrada lo presentaba como trabajo
> pendiente y era un error de hecho. `--sala` entró en `4f63d9e`, anterior a
> esta fase: `subir.py:1271` declara el argumento, `prefijo_de()`
> (`subir.py:1014`) lo resuelve contra `SALA_SLUG` del `.env`, `validar_slug()`
> lo valida —incluido el camino destructivo, `--borrar X --sala "../otro"`— y
> `PruebaValidarSala` en `pruebas_subir.py` lo prueba. Decide las dos cosas que
> decía: el campo `slug` de la ficha y el prefijo de R2. Quien tome el
> entregable 5 empieza por B.

**B. Un modo de subida nuevo: por URL prefirmada.** El de hoy (boto3 con el token
de R2) sigue sirviendo para el dueño. El nuevo es el único que sirve para un
creador. Regla sugerida: **prefirmado si no hay `R2_ACCESS_KEY_ID` en el `.env`**,
forzable con `--prefirmado`.

Para cada tanda de archivos:

1. `POST {URL_SERVIDOR}/api/subida` con la cabecera `X-Clave-Subida: {CLAVE_SUBIDA}`
   y el cuerpo

   ```json
   { "id": "s01e03",
     "archivos": [ { "ruta": "720p/lista.m3u8", "bytes": 1234 },
                   { "ruta": "720p/000.ts",     "bytes": 5678 } ] }
   ```

   `ruta` es **relativa a la carpeta del video**, con barras normales y sin `..`,
   sin barra inicial y sin segmentos vacíos. Ojo con Windows: `clave_r2()` ya
   evita `os.path.join`, y acá vale lo mismo.

2. La respuesta:

   ```json
   { "slug": "ana", "id": "s01e03",
     "urlPublica": "https://pub-….r2.dev/ana/s01e03/",
     "archivos": [ { "ruta": "720p/lista.m3u8", "url": "https://….r2.cloudflarestorage.com/…?X-Amz-…" } ],
     "venceEn": 1788782400000 }
   ```

3. Subir cada archivo con un **PUT** contra su `url`, con el cuerpo del archivo y
   nada más.

**Cinco cosas que van a morder si no se anotan:**

- **Nada de `Authorization`.** La autenticación va adentro de la URL. Mandar un
  header de autorización además hace que R2 conteste 400.
- **El `Content-Type` y el `Cache-Control` NO están firmados** (sólo se firma
  `host`), así que se mandan libremente y se guardan igual. Hay que seguir
  mandando los que ya manda el script (`application/vnd.apple.mpegurl`,
  `video/mp2t`, `text/vtt`, y `public, max-age=31536000, immutable`): si van como
  `application/octet-stream`, hls.js no reproduce.
- **Las URL vencen a los 10 minutos.** No pedirlas todas al principio: una peli
  de dos horas en segmentos de 6 s son más de mil archivos por calidad y la
  última URL estaría vencida antes de llegar. Pedir una tanda, subirla, pedir la
  siguiente.
- **El tope es de 500 archivos por pedido** (`TOPE_ARCHIVOS` en `index.js`). Un
  pedido con más contesta 400 y lo dice.
- ⚠ **LA TANDA SE CORTA POR BYTES, NO POR CANTIDAD.** *(Agregado el 2026-09-07:
  faltaba, y sin esto los dos renglones de arriba se leen juntos como "tandas de
  500", que es justo el número que no funciona.)* 500 segmentos de 6 s a 720p y
  2,5 Mbps son unos **940 MB**; con una subida hogareña de 10 Mbps eso son
  **12,5 minutos**, y las URL vencen a los **600 segundos** (`VENCE_POR_DEFECTO`
  en `r2.js`). O sea que usar el tope del servidor como tamaño de tanda hace que
  la última URL de cada tanda venza antes de llegar, y el síntoma es un 403 de
  R2 sin explicación a mitad de la subida, distinto en cada máquina porque
  depende del ancho de banda de casa.

  Las dos salidas, y las dos sirven: **(a)** cortar la tanda por un presupuesto
  de bytes —tamaño de tanda ≈ subida medida × 300 s, la mitad de la ventana, con
  un piso de un archivo y el tope de 500 como techo—, o **(b)** reintentar
  pidiendo URL nuevas cuando una vence, que es más simple pero desperdicia la
  subida ya hecha del archivo que falló. La respuesta trae `venceEn` justamente
  para poder decidir: si falta menos de un minuto para esa marca, no empezar
  otro archivo, pedir la tanda siguiente.
- **La maestra se sube última y sola**, como ya hace el script. Mientras no
  exista, nadie puede empezar a mirar un video a medio subir aunque adivine la
  URL.

**C. `boto3` deja de ser obligatorio en este camino.** Un PUT se hace con
`urllib.request` de la biblioteca estándar. Conviene que el `import boto3` pase a
ser perezoso: un creador que sólo usa URL prefirmadas no tiene por qué instalar
nada.

**D. `--borrar <id>`**, para un creador:

1. `POST /api/subida/borrar` con `X-Clave-Subida` y `{ "id": "s01e03" }`.
2. La respuesta trae `archivos: [{ clave, url }]` con un DELETE firmado por
   objeto: mandarlos todos.
3. Después, el `DELETE /api/videos/:id` que ya existe. Un 404 ahí sigue sin ser
   un error.

**E. `--listar`**, para un creador: `GET /api/videos` con `X-Clave-Subida`
devuelve el catálogo de esa sala. **No** devuelve lo que hay en R2 (para eso hace
falta el token), así que para un creador `--listar` pasa a ser "lo que el
servidor sabe" en vez de "lo que hay en el bucket". Conviene que lo diga.

**F. Cinco errores nuevos que merecen un mensaje propio**, porque los cinco son
"no es tu culpa, es esto":

| Código | Qué pasó | Qué decir |
|---|---|---|
| 401 | La clave no sirve | "Generá una nueva en /panel y pegala en herramientas/.env" |
| ⚠ 403 | La clave era buena pero su sala ya no está | "Esa clave es de una sala que ya no existe. Entrá a /panel y generá una nueva." *(Agregado el 2026-09-07: faltaba. `conCreadorOClave` contesta `403 "esa clave no corresponde a ninguna sala"` cuando la clave sobrevivió a la sala —el dueño la dio de baja, o el creador se borró—. Es distinto del 401: la clave es válida, y decirle "generá otra" sin más lo manda a un panel al que no puede entrar.)* |
| 402 | El plan no deja subir | "Tu sala está en plan pendiente o vencido: no puede subir videos todavía" |
| 409 | No entra en el tope de GB | Mostrar `usadoGb` y `topeGb`, que vienen en la respuesta |
| 503 | El servidor no tiene credenciales de R2 | Mostrar el `error`, que dice el nombre de la variable que falta |

### Las 38 mutaciones, y qué las caza

Cada una se aplicó sobre una copia del árbol, se corrió la suite contra el código
roto, y se restauró. Las 38 se caen.

> **Corregido el 2026-09-07, después de la verificación.** Dos de estas filas
> eran falsas: el verificador no pudo reproducirlas tal como estaban redactadas
> porque, aplicadas en prosa y no en su lectura más estrecha, **sobrevivían**.
> Están corregidas abajo, marcadas con ⚠, y lo que faltaba está escrito en la
> entrada de arriba. La lección, que es la que importa: una mutación se aplica
> como la describe el renglón, no como convenga para que caiga.

| Mutación | Pruebas que se caen |
|---|---|
| el plan del dueño sale de la base | `creadores`: "escribirle pendiente al dueño…" · `multicanal`: "el dueño del servicio entra por la misma puerta…" |
| un vencimiento pasado no baja el plan | `creadores`: "un vencimiento que ya paso baja el plan…" · `multicanal`: "un creador VENCIDO tampoco reproduce" |
| cualquiera puede poner cualquier plan | `creadores`: "el dueño no puede poner pago…" · `multicanal`: "el dueño NO puede poner pago ni vencido a mano" |
| `existe()` del dueño sale del almacén | `creadores`: "el dueño existe sin tocar el almacen…" · `sala-http` |
| `salaDelEvento` cree en el `channel_slug` sin comprobar | `creadores`: "un evento de un canal que no es de nadie NO se atribuye" · `multicanal`: "un webhook de un canal que no es de nadie no crea ninguna sala" |
| la cache no guarda los que no existen | `creadores`: "la cache guarda TAMBIEN los que no existen" |
| el chat del espectador vuelve a rutear por el dueño | `sala-http`: "escribir en la sala de OTRO creador va al canal de ESE creador" |
| "tuya" se compara contra `KICK_SLUG` y no contra la cookie | `multicanal`: "un creador PENDIENTE no puede reproducir" y tres más |
| el reloj no mira el plan | `multicanal`: los tres del plan |
| el catálogo se elige por query | `multicanal`: "no hay ningun parametro…" · `sala-http`: "el catálogo del panel…" |
| `/api/panel` se elige por query | `multicanal`: "no hay ningun parametro…" |
| la clave de subida cae en la cookie cuando no sirve | `multicanal`: "una clave inventada no cae en la cookie…" |
| la clave abre también el panel | `sala-http`: "la clave NO abre nada que no sean los videos de su sala" |
| ⚠ ~~la subida no comprueba el prefijo~~ → **la subida arma la clave con el slug que manda el cliente** | La fila vieja era falsa: sacar `esDeLaSala` del camino de la subida no rompía nada, porque las cuatro rutas de "una ruta que se escapa del prefijo no se firma" las rechaza `claveValida` sola. Hoy: `multicanal`: "el prefijo sale de la cookie…" y "la clave de una sala no firma nada de otra" |
| `firmar()` no comprueba el prefijo (el cinturón que ahora sí existe) | `r2`: "firmar no firma una clave que no es de la sala que se le dice" y "el DELETE de una clave ajena tampoco se firma" |
| el DELETE firma lo que conteste R2, sin filtrar | `multicanal`: "un listado de R2 con una clave de otra sala no firma ese borrado" |
| el tope de GB mira los bytes declarados | `multicanal`: "el tope de GB se compara contra lo que hay en R2" |
| `/api/admin` no pide ser el dueño | `multicanal`: "la lista de creadores es solo del dueño" |
| el webhook de cobro aplica lo que no verificó | `multicanal`: "un webhook de cobro sin firma no cambia nada" |
| la firma de Paddle se da por buena | `cobro` + `multicanal`: los dos de la firma |
| Paddle firma sólo el cuerpo, sin el `ts` | `cobro`: "la firma se calcula sobre ts:cuerpo…" |
| el vencimiento de Paddle se calcula desde ahora | `cobro`: "una suscripcion activa pasa el plan a pago con el vencimiento del payload" |
| `codificar` usa `encodeURIComponent` | `r2`: "un nombre de archivo con parentesis…" |
| el método no entra en la firma de R2 | `r2`: "un DELETE firma distinto que un PUT" |
| el chat vuelve a sacar el slug del payload | `chat-cabos`: "el slug que manda es el que se le pasa" |
| `/admin` se sirve a cualquiera | `multicanal`: "/admin no existe para quien no es el dueño" |
| `/crear` no frena el click sin aceptar | `pagina-crear`: "un click con la casilla sin marcar no navega" |
| el panel no apaga los controles | `pagina-panel`: "un plan pendiente apaga los controles" |
| el alta no exige los términos | `multicanal`: "sin aceptar los terminos no se crea ninguna sala" |
| el alta no mira el tope de canales | `multicanal`: "llegado el tope no entran mas salas" |
| la clave de subida vale para cualquier sala | `sala-http` + `multicanal`: los dos de la clave |
| `existe()` dice que sí a cualquier slug | `creadores` + `multicanal` + `servidor` + `sala-http` |
| métricas sin tope | `metricas`: "el mapa de canales no crece para siempre" |
| el tope de métricas suelta al recién llegado | `metricas`: "el tope suelta los más viejos…" |
| el orden del guard: la cookie antes que la sala | `multicanal`: "una sala que no existe da 404 antes que 401" |
| ⚠ `vinculos` vuelve a tener el slug del dueño por defecto | `vinculos`: "sin slug no se lee, no se guarda…", pero **sólo desde que ese archivo carga `KICK_SLUG`**. La fila vieja valía para un default literal (`slug \|\| 'istincho'`); el default que alguien escribiría de verdad —`slug \|\| process.env.KICK_SLUG`, que es el que el propio comentario de `vinculos.js` describe— se resolvía a `''` en un proceso sin esa variable, la guarda disparaba igual y la mutación pasaba la suite entera |
| volver a entrar le pisa el plan al que ya estaba | `creadores`: "volver a entrar NO le pisa el plan…" · `multicanal`: "volver a entrar no le baja el plan…" |
| un proveedor de cobro desconocido cae en paddle | `cobro`: "cobro.js elige la implementacion por variable…" |
| el vencimiento de una URL prefirmada no se recorta | `r2`: "el vencimiento se recorta a lo que acepta S3" |
| suscribirse no mira si el cobro está configurado | `multicanal`: "sin el cobro configurado se avisa…" |

### Cuáles de las aserciones nuevas son controles, y por qué están

Se revisaron una por una preguntando *"¿esto sería verdad igual si el arreglo no
existiera?"*. Estas contestan que sí, y están puestas **a propósito**, cada una
con el motivo al lado en el archivo. Se anotan acá para que el próximo
verificador no las lea como el vicio de siempre. **Ninguna se cae con ninguna de
las 38 mutaciones, y ninguna se cuenta como cobertura en la tabla de arriba.**

- `creadores`: "un vencimiento futuro deja el plan como esta" impide que el
  arreglo sea "bajar todo a vencido".
- `creadores`: "un pendiente con vencimiento viejo sigue siendo pendiente"
  impide que "vencido" se coma un estado que quiere decir otra cosa.
- `multicanal`: "una sala sin Kick vinculado contesta 503 y no manda nada"
  impide que "no rutear nada" pase por "rutear bien".
- `multicanal`: "con el tope lleno, la que ya tenía sala entra" impide que el
  tope sea "no entra nadie".
- `pagina-crear`: "con la casilla marcada el click pasa derecho" impide que el
  arreglo sea "frenar siempre", que dejaría a nadie poder darse de alta.
- `pagina-admin`: "cuando coinciden se muestra uno solo, sin paréntesis" impide
  que el arreglo sea mostrar siempre los dos.
- `pagina-admin`: "con pocas salas el aviso del tope no está" impide que un
  aviso permanente deje de significar nada.
- `pagina-panel`: "con plan activo los controles se pueden tocar" impide que el
  arreglo sea apagarlos siempre.
- `r2`: "esDeLaSala" y "claveValida" con casos válidos impiden que el arreglo
  sea rechazar todo.
- `vinculos`: "una sala sin vínculo no hereda el del vecino" impide que
  "devolver siempre el primero que haya" pase el test de aislamiento.

### Tres trampas que costaron y quedan anotadas

**A. Un `finally` que restaura el `fetch` antes de que la promesa lo use.** Los
tres tests de `listarPrefijo` estaban escritos como `return r2.listarPrefijo(…).then(…)`
adentro de un `try/finally`. El `finally` corre apenas se crea la promesa, así que
para cuando el pedido salía, el `fetch` de mentira ya no estaba: **el test salía a
internet de verdad** y fallaba con un error de TLS contra un host que no existe.
Se `await`ea adentro del `try`, siempre. Lo cazó el propio test, que es lo único
bueno del asunto.

**B. Los caracteres de control se escriben con escapes, y las herramientas de
edición no siempre colaboran.** Una regex de `r2.js` quedó con bytes de control
literales adentro del archivo fuente —exactamente lo que la Fase 2 dejó anotado
como prohibido— y `grep` empezó a tratar el archivo como binario. Se arregló
armando la línea por código desde un script, y quedó verificado con un contador:
cero caracteres de control literales en `r2.js` y en `r2.test.js`.

**C. Los editores de Python convierten a CRLF en Windows.** `io.open(p, 'w')` sin
`newline=''` pasó media docena de archivos de LF a CRLF. Git lo normaliza al
commitear (`core.autocrlf=true`), así que el diff salió limpio y no cambia nada
del repo, pero **el arnés de mutaciones dejó de encontrar cuatro anclas
multilínea y las reportó como "no se pudo aplicar"**. Si eso se hubiera leído
como "cazadas", habrían quedado cuatro mutaciones sin verificar. El arnés ahora
compara en LF, y los archivos de código volvieron a LF.

### Cómo verlo funcionando

```bash
npm test                                # 607 en verde
node --test pruebas/multicanal.test.js  # la Fase 3 de punta a punta
node --test pruebas/r2.test.js          # SigV4 contra los vectores de boto3
python herramientas/pruebas_subir.py    # las 121 de Python, intactas
```

Sin ninguna credencial, con el servidor levantado a mano:

```bash
MODO=local KICK_SLUG=istincho node servidor/index.js
curl -s localhost:8778/api/estado      # dice qué falta, incluidas subida y cobro
curl -s -o /dev/null -w "%{http_code}\n" localhost:8778/crear      # 200
curl -s -o /dev/null -w "%{http_code}\n" localhost:8778/terminos   # 200
curl -s -o /dev/null -w "%{http_code}\n" localhost:8778/admin      # 404 sin ser el dueño
curl -s -o /dev/null -w "%{http_code}\n" localhost:8778/sala/nadie # 404
```

### Qué queda sin verificar contra lo real

Lo mismo que la Fase 2, más lo de esta fase. **Nada de esto se probó contra un
servicio de verdad**, y no se puede hasta que el dueño cargue las variables.

- **Kick.** Falta comprobar que el login con `rol=creador` devuelva el `scope`
  con esos nombres, que `channel:read` alcance para que `/channels` devuelva el
  slug de un creador que no es el dueño, y que `events/subscriptions` con el
  token de un tercero suscriba **su** canal y no el nuestro. Todo el camino está
  ejercitado con un `fetch` que contesta como la API.
- **R2.** La firma SigV4 está verificada contra **boto3** —byte por byte, con el
  reloj congelado, tres vectores— y eso es una implementación independiente, no la
  nuestra. Lo que **no** está verificado es que R2 la acepte igual que S3, ni que
  el CORS del bucket deje hacer PUT desde donde el script lo va a hacer (la
  política de la tarea 9 sólo abre `GET, HEAD`: **muy probablemente haya que
  agregarle `PUT` y `DELETE`** para que un creador pueda subir desde el navegador;
  desde el script no hace falta porque no hay origen).
- **Paddle.** Falta comprobar que `POST /transactions` acepte este cuerpo, que
  `data.checkout.url` sea el campo, y que los `event_type` se llamen así. La firma
  del webhook está implementada contra la documentación y probada con vectores
  propios.
- **Twitch multi-creador.** Una conexión por creador está probada con dobles. Con
  creadores de verdad falta medir cuánto aguanta el contenedor: `TOPE_TWITCH=50`
  es una estimación, no una medición.
- **Mongo.** Todo corrió en modo archivo. El índice inverso
  `broadcaster_user_id → slug` se arma con un `listar('creadores')` cada minuto:
  con 900 documentos chicos es una consulta barata, pero no está medida contra
  Atlas.

### Anotado, no arreglado

- **El índice inverso y la cache viven en memoria, y hay una sola instancia.** Con
  dos instancias en Railway, cada una tendría su copia y un alta hecha en una
  tardaría hasta un minuto en aparecer en la otra. Hoy hay una sola instancia;
  el día que haya dos, esto es lo primero que hay que mirar.
- **No hay forma de borrar un creador desde `/admin`.** Se puede ponerlo en
  "pendiente", que es lo que hace falta para cortarle el servicio. Borrar de
  verdad —sus videos en R2, sus tokens, su fila— es un trámite con más filos
  (¿qué pasa con la gente mirando?) y no entró en esta fase.
- **`/admin` no pagina.** Con 900 creadores la tabla es larga. Se arregla el día
  que haya cincuenta.
- **La aceptación de términos se registra en el callback de OAuth**, con la
  versión que viajó del lado del servidor en el Map de logins pendientes. Eso
  prueba que el flujo pasó por `/crear` con la casilla marcada en la interfaz; no
  prueba que la persona haya leído nada, que es lo que ninguna casilla prueba
  nunca.
- **La medición de uso de R2 no se hace en la subida de cada archivo**, sino al
  pedir cada tanda de URL. Entre que se firma una tanda y se sube, un creador
  puede pasarse del tope por el tamaño de esa tanda. El tope es un tope de costo,
  no una cuota dura, y con tandas de 500 archivos el margen es chico.

### Lo que necesita el dueño

Además de lo que ya estaba pendiente (tareas 2 a 13):

1. **Tarea 17: un token de R2 para Railway.** Sin esto ningún creador puede subir.
2. **Tarea 14: la cuenta de Paddle en sandbox** y sus cuatro variables. Sin
   `PADDLE_CLAVE_WEBHOOK` el plan nunca pasa a "pago": se cobra y no se habilita.
3. **Tarea 16: leer `/terminos`** y decir si va así.
4. **Tarea 18: decidir cuántos GB regala cada plan.** El bucket gratis son 10 GB
   en total y es el primer gasto real del proyecto.
5. **Tarea 19: pedirle a Kick la verificación de la app** antes de llegar a 500
   salas. `/admin` avisa a partir de la mitad, pero el trámite lleva tiempo.
6. **Probablemente, agregarle `PUT` y `DELETE` al CORS del bucket** (tarea 9) si
   alguna vez se sube desde el navegador. Desde el script no hace falta.

### Archivos tocados

Nuevos en `servidor/`: `creadores.js`, `cobro.js`, `cobro-paddle.js`, `r2.js`.

Nuevos en `paginas/`: `crear.html`, `terminos.html`, `admin.html`,
`crear/{crear.js,crear.css}`, `admin/{admin.js,admin.css}`.

Nuevos en `pruebas/`: `creadores.test.js`, `cobro.test.js`, `r2.test.js`,
`multicanal.test.js`, `pagina-crear.test.js`, `pagina-admin.test.js`.

Editados en `servidor/`: `index.js` (rutas de alta, admin, cobro y subida; el
ruteo por sala; el orden del guard; el plan en el reloj), `chat.js` (estado por
sala), `vinculos.js` (el slug primero y obligatorio), `kick.js` (el rol
`creador` y la versión de términos), `metricas.js` (el tope).

Editados en `paginas/`: `panel.html`, `panel/panel.js`, `panel/panel.css` (el
plan, el modo sólo lectura, el uso y la suscripción).

Editados en `pruebas/`: `vinculos`, `sala-http`, `metricas`, `pagina-panel`,
`chat`, `chat-cabos`, `chat-planb`, `chat-suscripciones`, `chat-http`,
`oauth-destino`, y `fijos/dom-falso.js` (`focus()`/`blur()` y el desescapado de
entidades en los atributos, que es lo que hace un navegador de verdad).

Documentación: `README.md`, `TAREAS-DUENO.md`, `servidor/.env.ejemplo`,
`BITACORA.md`.

**`herramientas/` no se tocó.** Sus 121 pruebas de Python se corrieron igual, y
lo que hay que cambiar ahí está especificado más arriba.

Sin dependencias nuevas: `node:net`, `node:crypto` y `fetch` son todo lo que usan
los módulos nuevos.

---

## 2026-09-07 — Fase 2: la segunda verificación, cerrada

Las dos fallas de la segunda pasada adversarial y los tres puntos que el
director agregó. **449 pruebas en verde** (eran 439), la suite corrida **tres
veces seguidas sobre el código final sin un solo flake**, y **siete mutaciones
aplicadas una por una: las siete se caen**, cada una verificada con la suite
corriendo contra el código roto.

**El código de servidor casi no se tocó, y eso es el titular.** El único archivo
de producción con cambios es `servidor/videos.js`. Las otras cuatro cosas eran
pruebas: en tres de ellas el código ya estaba bien y lo que estaba mal era que
nada lo sostenía. Es la contracara exacta de la F1 de la entrada de abajo (ahí
el comentario prometía lo que el código no hacía; acá el código hacía lo
correcto y la prueba miraba para otro lado).

### F-A. El loopback se esquivaba con la forma IPv4-mapeada de IPv6

`videos.js` chequeaba "esta misma máquina" con una regex:

```js
const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|\[?::1\]?|0\.0\.0\.0)$/i;
```

`POST /api/videos` con `url: https://[::ffff:127.0.0.1]/x.m3u8` contestaba **200
y guardaba la ficha**. Lo mismo `[::]`, que es el `0.0.0.0` de IPv6 y sí estaba
bloqueado en su forma IPv4. Equivalentes que también pasaban:
`[0:0:0:0:0:ffff:127.0.0.1]`, `[::ffff:7f00:1]`, `[0:0:0:0:0:0:0:0]`.

**La causa raíz no es "faltaban formas en la lista".** Es que se estaba
respondiendo una pregunta *sobre la dirección* con una comparación *sobre el
texto*. El parser de URL de Node canonicaliza las IPv6 a hexadecimal comprimido
y **no** las vuelve a cuartetos decimales: `[::ffff:127.0.0.1]` sale como
`[::ffff:7f00:1]`. Ninguna regex escrita sobre `127(\.\d{1,3}){3}` puede ver
eso, y agregarle alternativas dejaba el mismo defecto de categoría esperando a
la forma siguiente.

Va `net.BlockList`, de `node:net` (builtin: no agrega una dependencia). Compara
direcciones, no strings, y **entiende la forma IPv4-mapeada sola**:
`check('::ffff:7f00:1', 'ipv6')` cae adentro de una regla `addSubnet('127.0.0.0',
8, 'ipv4')` sin que haya que decodificar nada acá. Las cuatro reglas son todo
127.0.0.0/8, `0.0.0.0`, `::1` y `::`. `localhost` se mira aparte, por nombre,
porque no es una dirección.

Se dejó **afuera a propósito** lo que no es esta máquina: una IP de LAN
(`192.168.x`, `[::ffff:c0a8:1]`) o una link-local no son loopback, rechazarlas
sería ampliar la invariante sin motivo, y hay una prueba que cuida que no se
rechacen. Tampoco entra `[::7f00:1]`, la forma IPv4-*compatible* deprecada por
RFC 4291: nadie la rutea a 127.0.0.1.

**Lo que bloqueaba de verdad no era el daño** (chico: en producción `URL_BASE`
está cargada y el chequeo 1 tapa el host público) **sino la afirmación falsa**.
La entrada de abajo daba por verificado que Node "ya normaliza solo casi todas
las formas raras" y que la del punto final era "la que no normaliza". Es falso
para dos formas. Ese párrafo quedó corregido en su lugar, con un recuadro que
dice qué decía y por qué estaba mal, y el comentario de `videos.js` se reescribió
entero para que explique el defecto de categoría en vez de prometer completitud.

### F-B. Entrar con la peli ya empezada no tenía una sola prueba

La grande. Mutación de una línea en `servidor/reloj.js`:

```js
if (nuevo.estado === 'detenido') canales.olvidarReloj(s);   // original
canales.olvidarReloj(s);                                     // mutado
```

Con esa mutación **las 439 pruebas seguían en verde** y cualquiera que abriera
`/sala/istincho` con la película andando recibía `reloj: null` en el evento
`estado` y veía *"Todavía no empezó la película"* para siempre.

Por qué no la cazaba nada, que es lo que había que entender:

1. **Todos** los tests de reloj de `sala-http` abren el SSE *antes* de
   `reproducir`, así que el reloj siempre les llega como evento `reloj` en vivo.
   Por ese camino la mutación no se nota. El camino que sí importa —el del
   segundo navegador del criterio de aceptación (a), que entra *después* del
   play— es otro: el reloj viaja adentro del `estado` inicial que manda
   `canales.suscribir`, sacado de `canal.reloj`. **Nadie miraba ese campo.**
2. En `pagina-sala` el único `estado` que se inyectaba traía `reloj: null`, así
   que la rama `if (tipo === 'estado') { ...; aplicarReloj(datos.reloj) }` de
   `sala.js` no la ejercitaba nadie con un reloj adentro.
3. Y la prueba del arreglo anterior, `reloj.test.js`, asertaba
   `canales.hayCanal(slug) === true` después de `reproducir`. **`hayCanal` sigue
   siendo `true` con el reloj tirado**, porque hay un cliente conectado y
   `soltarSiVacio` no borra un canal con gente. La aserción era verdad sin que
   el `if` existiera. Es la **tercera** prueba de esta especie en esta fase.

El arreglo es todo de pruebas; `reloj.js` y `sala.js` no se tocaron:

- `reloj.test.js` ahora asierta `canales.canal(slug).reloj` (que esté, y que sea
  el de `reproduciendo` con el `videoId` que corresponde) y, del otro lado, que
  después de `detener` ese campo quede en `null`.
- `sala-http.test.js` gana el camino de punta a punta: `reproducir` primero y el
  SSE **después**, con el primer evento `estado` trayendo el reloj entero (ficha
  del video incluida) y un `empezoEn` usable. Y su control negativo: abriendo
  después de `detener`, `reloj` tiene que venir `null`.
- `pagina-sala.test.js` gana el mismo camino del lado del navegador: el `estado`
  llega por el bus (`p.llega('estado', …)`, no por la puerta de atrás
  `aplicarReloj`), la pantalla de espera se va, se carga la playlist de r2.dev y
  el player salta al segundo que corresponde —calculado con `empezoEn` y no con
  el campo `posicion`, que en ese evento viene viejo—.

### Los tres que entraron por decisión del director

**`soloRuta()` no tenía ninguna prueba.** Devolver `String(u ?? '')` en vez del
`pathname` dejaba las 439 en verde. Existe por una regla escrita con todas las
letras en `index.js`: `/oauth/kick/volver` lleva el `code` de OAuth en la query,
los logs de Railway no se borran, y una URL entera en un log lo deja ahí para
siempre. Ahora hay una prueba que provoca un 413 contra
`/kick/webhook?code=…&state=…` y mira la línea que sale: la ruta tiene que
estar, la query no. Es la misma función que escribe la línea del 500 con el
callback de OAuth (dos call sites, una implementación); el camino del 413 es el
único que se puede provocar desde afuera sin romper nada a propósito.

**`destinoSeguro()` (redirect abierto) no tenía ninguna prueba.** Aceptar
cualquier `d` dejaba las 439 en verde. Para Kick queda medio tapado porque
`kick.js` tiene su propia copia de la guarda, pero **para Twitch no**:
`twitchEntrar` mete el `?destino=` crudo en `pendientesTwitch` y el filtro de
`index.js` es lo único que hay entre eso y la cabecera `Location`.

Archivo nuevo `pruebas/oauth-destino.test.js`, y hace **el viaje entero** de
Twitch (entrar → sacar el `state` del `Location` → volver con la cookie del
dueño) y no una llamada a la función suelta, a propósito: el `destino` cruza el
servidor en dos tramos y un test de la función suelta pasaría con el filtro
puesto en cualquier lado, incluso en ninguno. Nada sale a internet: el `fetch`
global contesta como Twitch sólo para `id.twitch.tv` y `api.twitch.tv`, y las
conexiones de chat se fijan con `chat.fijarConexiones` para que el WebSocket de
EventSub no se abra de verdad.

La tercera aserción no mira la forma del string: resuelve el `Location` contra
`https://sala.example` y exige que el origen resultante siga siendo ése. Si
mañana aparece una forma que la regex no previó, esa la ve igual.

**El orden `limpiar` → `slice` estaba justificado mal.** La entrada de abajo
decía que recortando primero "el tope podía dejar afuera el último carácter útil
y adentro el control". No es así: `limpiar` después del `slice` saca los
controles igual, y los dos órdenes dan un título sin controles. Lo que el orden
actual evita es **desperdiciar el tope**. Corregido en los dos lugares donde
estaba escrito: la bitácora y el comentario de `videos.js`.

### Las siete mutaciones, y qué las caza

| Mutación | Pruebas que se caen |
|---|---|
| `esLoopback` vuelve a la regex original | `videos`: "la forma IPv4-mapeada de IPv6 tampoco esquiva el chequeo" · `sala-http`: "una ficha que apunta a NUESTRO servidor se rechaza con 400" |
| `addSubnet('127.0.0.0', 8)` → `addAddress('127.0.0.1')` | `videos`: "rechaza loopback aunque no haya URL_BASE cargada", "la forma IPv4-mapeada…" |
| `canales.olvidarReloj(s)` sin el `if` de "detenido" | `reloj`: "detener libera el canal…" · `sala-http`: "el que abre la sala con la peli YA ANDANDO recibe el reloj en el `estado` inicial" |
| borrar `canales.olvidarReloj(s)` del todo | `reloj`: "detener libera el canal…" · `sala-http`: "el que abre la sala después de detener recibe reloj: null" |
| sacar `aplicarReloj(datos.reloj)` de la rama `estado` de `sala.js` | `pagina-sala`: "el `estado` inicial con la peli andando saca la espera y salta al segundo que va" |
| `soloRuta` → `String(u ?? '')` | `servidor`: "en el log va la ruta y NO la query" |
| `destinoSeguro` acepta cualquier `d` | `oauth-destino`: "un destino de otro sitio NUNCA llega al Location", "un destino que se pasa de vivo no puede volverse absoluto al resolverse" |

### Cuáles de las aserciones nuevas son controles, y por qué están

Esta vez se revisó una por una preguntando *"¿esto sería verdad igual si el
arreglo no existiera?"*. Cuatro contestan que sí, y están puestas igual **a
propósito**, cada una con el motivo escrito al lado en el archivo. Se anotan acá
para que el próximo verificador no las lea como el vicio de siempre:

- `videos`: "esLoopback no se lleva puesto lo que NO es esta máquina" es la
  mitad que impide que el arreglo sea "rechazar todo".
- `oauth-destino`: "el destino bueno se respeta" impide que el arreglo sea
  "mandar siempre a /panel".
- `servidor`: `assert.match(linea, /\/kick\/webhook/)` impide que el arreglo sea
  loguear un string vacío.
- `pagina-sala`: "el `estado` inicial sin reloj deja la espera puesta" es lo que
  hace que el `dataset.espera === 'no'` de la prueba de al lado signifique algo.

Las cuatro son controles negativos declarados, no cobertura: **ninguna de las
cuatro se cae con ninguna de las siete mutaciones de arriba**, y ninguna se
cuenta como cobertura en esa tabla. Están para que la aserción de al lado
signifique algo.

### Anotado, no arreglado

- **El guard de Fase 3 del chat corre antes de `sesion.leer`**, al revés que
  `conDuenoDeLaSala`: un POST sin cookie a la sala de otro creador da **503** y
  a la del dueño da **401**. Hoy no importa (`creadores` está vacía y no hay más
  sala que la del dueño), pero en la Fase 3 hay que decidir si ese orden es a
  propósito. Argumento a favor de dejarlo: "esa sala no está vinculada" no
  depende de quién pregunte, así que contestarlo antes de leer la cookie es más
  barato y no filtra nada. Argumento en contra: dos rutas hermanas contestan
  distinto al mismo pedido sin cookie, y eso se copia.
- El verificador confirmó que la decisión del **503** (y no 403) del chat en
  salas ajenas está bien argumentada y bien anotada en los tres lugares. Sin
  cambios.

### Archivos tocados

Producción: **`servidor/videos.js`** y nada más (`esLoopback` con `net.BlockList`
en lugar de la regex, el comentario de `hostnameDe`, y el del orden
`limpiar`/`slice`).

Pruebas: `pruebas/videos.test.js`, `pruebas/sala-http.test.js`,
`pruebas/reloj.test.js`, `pruebas/pagina-sala.test.js`,
`pruebas/servidor.test.js` y **`pruebas/oauth-destino.test.js` (nuevo)**.

Documentación: `BITACORA.md` (esta entrada y los tres recuadros de corrección de
la entrada de abajo).

**`herramientas/` no se tocó**, como estaba pedido: quedó cerrado en la sesión
anterior y el cambio de `esLoopback` no lo afecta (`subir.py` arma la URL con
`R2_URL_PUBLICA`, que es un `pub-….r2.dev`).

Sin dependencias nuevas: `node:net` es builtin.

### Cómo verlo

```
npm test                                   # 449 en verde
node --test pruebas/oauth-destino.test.js  # el redirect abierto, solo
```

Y a mano, con el servidor levantado y una clave de subida generada en `/panel`:

```
curl -X POST localhost:8778/api/videos -H "X-Clave-Subida: <la clave>" \
     -H 'Content-Type: application/json' \
     -d '{"id":"x","slug":"istincho","titulo":"x","duracion":10,
          "url":"https://[::ffff:127.0.0.1]:8778/sala/x.m3u8"}'
# 400: la url no puede apuntar a esta misma maquina
```

### Qué queda pendiente

Nada de la verificación. Sigue en pie lo que la entrada de abajo dejó
señalizado para la Fase 3 (rutear el chat al vínculo de Kick **de esa sala** y no
al del dueño; cache corta para `canalPermitido`), más el orden del guard de
arriba.

---

## 2026-09-07 — Fase 2: lo que encontró la verificación, cerrado

Las tres fallas y los cuatro puntos que el director sacó de las dudas de la
entrada "Verificación de la Fase 2: NO PASA". **439 pruebas en verde** (eran
411), la suite corrida **cinco veces seguidas sobre el código final sin un solo
flake** (doce corridas en total durante el trabajo), y **doce mutaciones
aplicadas una por una: las doce se caen.**

> **CORREGIDO EL 2026-09-07.** Acá seguía la frase "Ninguna prueba nueva pasa
> contra el código roto". Las doce mutaciones listadas abajo sí se caen, pero la
> frase se leía como una garantía general y no lo era: la segunda verificación
> encontró **dos** agujeros más, uno de ellos una prueba de esta misma entrada
> que pasaba por el motivo equivocado. Ver la entrada de arriba.

### Las tres fallas

**F1. El chequeo de host que el comentario prometía y el código no hacía.**
`videos.js` decía textual que la URL tiene que ser https "y de otro host, [...]
no descubrirlo con la factura de egreso", y chequeaba el protocolo y el `.m3u8`
y nada más. Un `POST /api/videos` con `url: https://localhost:8821/sala/x.m3u8`
contestaba 200. Se escribió el chequeo y **el comentario se dejó como estaba**:
la invariante era correcta, lo que faltaba era el código.

Van **dos** comparaciones y no una, porque cada una tapa lo que la otra deja:

1. Contra el `hostname` de `URL_BASE`. Es la respuesta autoritativa en
   producción, donde `URL_BASE` no es opcional. Se compara `hostname` y no
   `host` a propósito: con el puerto adentro, `sala.example:8443` pasaría, y es
   igual de nuestra. Como la URL legítima vive en `r2.dev`, ignorar el puerto no
   puede dar un falso positivo.
2. Contra los nombres de la propia máquina (`localhost`, `127.x`, `::1`,
   `0.0.0.0`). Vale **aunque `URL_BASE` no esté cargada**, que es el caso de
   local y el que hacía que la primera sola no alcanzara —dejar el chequeo
   dependiendo de una variable opcional era repetir la trampa que la
   verificación acababa de encontrar—. Y es cierto por sí mismo: un playlist en
   loopback apunta a la máquina del que mira, así que no puede servirle a nadie.

Un detalle que salió de probar los bordes: el parser de URL de Node ya normaliza
solo varias formas raras de escribir la misma máquina —`127.1`, `0x7f.0.0.1`,
`2130706433` y `[0:0:0:0:0:0:0:1]` llegan al chequeo ya como `127.0.0.1` y
`[::1]`—. No normaliza el punto final de la forma absoluta: `localhost.` y
`sala.example.` resuelven al mismo lugar y se escapaban por un carácter. De ahí
`hostnameDe()`, que baja a minúsculas y saca ese punto antes de comparar.

> **CORREGIDO EL 2026-09-07.** Este párrafo decía que Node "ya normaliza solo
> casi todas las formas raras" y que la del punto final era "la que no
> normaliza", y de ahí sacaba que "una regex sola alcanza". **Las tres cosas son
> falsas**, y la segunda verificación adversarial las cazó: Node deja
> `[::ffff:127.0.0.1]` como `[::ffff:7f00:1]` y `[0:0:0:0:0:0:0:0]` como `[::]`,
> ninguna de las dos matcheaba la regex, y `POST /api/videos` con esas URL
> contestaba 200. La regex ya no está: ver la entrada del 2026-09-07 más arriba.

De dónde sale "nuestro host": `hostPropio()` lee `URL_BASE`, **nunca el header
`Host`**. El `Host` lo elige quien llama, y usarlo sería dejar que el que sube
la ficha decida contra qué se la compara. `revisarFicha` acepta el host por
parámetro opcional con ese default, así que la prueba es determinista y, a la
vez, un call site nuevo de la Fase 3 hereda el chequeo sin acordarse.

**F2. Inyección de líneas en el log por el título del video.** El título sale
del nombre de un archivo y `index.js` lo mete tal cual en un `console.log`. La
verificación consiguió una línea falsa `[http] POST /api/panel 200 clave=FALSA`
en el log. Ahora `revisarFicha` pasa el título por `limpiar()`: saca C0, DEL,
C1 y los dos separadores de línea de Unicode, y colapsa los espacios.

Se **reemplaza por un espacio y no se borra**: si se borrara, `"hola\nchau"`
quedaría `"holachau"` y el título diría otra cosa. Y se limpia **antes** del
corte a 200, aunque el orden no es lo que hace segura esa línea (ver el
recuadro). Los nombres de las pistas de subtítulos pasan por lo mismo: salen de
los metadatos del mismo archivo y valen igual.

> **CORREGIDO EL 2026-09-07.** Acá decía que recortando primero "el tope podía
> dejar afuera el último carácter útil y adentro el control". No es así:
> `limpiar` después del `slice` saca los controles igual, así que los dos
> órdenes dan un título sin controles y la seguridad no depende del orden. Lo
> que el orden actual sí evita es **desperdiciar el tope**: recortando primero,
> los 200 caracteres se los comen también los controles y los espacios de más,
> que después se colapsan a nada, y un título con basura al principio llegaría
> cortado mucho antes de sus 200 caracteres útiles. El comentario de
> `videos.js` decía lo mismo mal y quedó corregido igual.

**F3. Las cinco guardas sin prueba.** Las cinco tienen ahora la suya, y las
cinco mutaciones se caen. Están listadas abajo con el nombre del test.

### Los cuatro que entraron por decisión del director

**La carrera de `/eventos/:slug`.** `canales.suscribir` engancha su limpieza en
el `close` del pedido, pero recién después de dos `await`. Si el socket moría en
el medio, el `close` ya se había emitido: el listener tardío no dispara nunca, y
`res.write()` sobre una respuesta muerta no tira, así que ni `difundir` ni el
ping de 25 s la sacaban de la lista. Cliente fantasma para siempre, contador
inflado y canal que no se libera. Se anota la bandera **antes** de los `await` y
no se suscribe un pedido que ya murió. Entre el `if` y el `suscribir` no queda un
solo `await`, así que no hay ventana nueva.

**`/yo` y `/salir` no validaban el slug.** Eran las dos únicas rutas de
`/api/sala/` que no pasaban por `canalPermitido`. No filtraban nada; se cerró
igual, porque una excepción sin motivo es una excepción que alguien copia.

**El chat del espectador ruteaba por el dueño, no por la sala.** `apiSalaChat`
aceptaba cualquier slug permitido y después mandaba el mensaje a
`vinculos.identidad('kick')`, que es el canal del **dueño**. Un espectador
escribiendo en `/api/sala/otrocreador/chat` le publicaba en kick.com/istincho.
Se le puso el mismo guard `slug !== SLUG_DUENO` que ya tenía el reloj.

Contesta **503 y no 403**, y la diferencia importa: el reloj da 403 "esa sala no
es tuya" porque quien pide es el dueño y el problema es de permisos. Acá quien
pide es un espectador y el problema es otro —esa sala todavía no tiene a dónde
mandar—, que es exactamente el 503 "el canal todavía no está vinculado con Kick"
que ya existía tres líneas más abajo, detectado antes de gastar un pedido.

**El canal no se liberaba después de "detener".** `canales.js` no borra un canal
que tenga `reloj` puesto, y `aplicarYDifundir` dejaba puesto también el de
"detenido", que es un objeto igual de truthy y sin embargo es la *ausencia* de
estado. `restaurar()` ya trataba la ausencia como corresponde del otro lado (si
no hay nada guardado, no pone reloj ni crea el canal), así que las dos mitades
decían cosas distintas sobre lo mismo.

El arreglo va del lado de **`reloj.js`**, no de `canales.js`. Ese módulo no
conoce la forma del reloj a propósito ("la Fase 2 define qué hay adentro"), y
meterle un `estado === 'detenido'` rompería el límite justo antes de la fase que
lo va a estirar. Queda `canales.olvidarReloj(slug)`, que saca el reloj y libera
el canal si con eso quedó vacío; quien decide qué es "detenido" sigue siendo
`reloj.js`. Efecto visible: el que se conecta después de un "detener" recibe
`reloj: null` en el evento `estado`, que la sala ya interpreta como "todavía no
empezó" —es el mismo camino que un canal recién creado—.

### Qué prueba cada cosa

| Arreglo | Prueba | Mutación que se caza |
|---|---|---|
| F1 host propio | `videos`: "rechaza una url que apunta a nuestro propio dominio", "ignora el puerto y las mayusculas", "no se rechaza de mas", "loopback aunque no haya URL_BASE" (diez formas de escribirlo), "el punto final de la forma absoluta", "hostPropio sale de URL_BASE" · `sala-http`: "una ficha que apunta a NUESTRO servidor se rechaza con 400" | sacar las dos comparaciones de host |
| F2 log | `videos`: "no puede meter una linea falsa en el log", "sin ningun caracter de control", "limpiar no come el texto" · `sala-http`: "el título de un video no puede inventar una línea en el log" | volver el título a `String(...).trim()` |
| F3 salir olvida el token | `sala-http`: "salir borra el refresh token del espectador, no sólo la cookie" | borrar `espectadores.olvidar(...)` |
| F3 chat sin `canalPermitido` | `sala-http`: "no se puede escribir en una sala que no existe" | borrar `canalPermitido` de `apiSalaChat` |
| F3 XSS reflejado | `servidor`: "el error que Kick devuelve no puede meter HTML en la pagina", "un cuerpo de pagina con comillas y & se escapa entero" | sacar `escapar()` de `pagina()` |
| F3 fuga de tenant | `sala-http`: "el catálogo del panel es el del dueño y NO se elige por query" | `listar(searchParams.get('slug') ?? SLUG_DUENO)` |
| F3 desfase medido | `pagina-sala`: "el desfase medido contra /api/hora se aplica de verdad", "el reloj atrasado también se corrige" | borrar `if (mejor) desfase = mejor.desfase` |
| Carrera SSE | `servidor`: "un socket que muere mientras se resuelve el permiso no deja un cliente fantasma" | borrar el `if (cerrado ...) return` |
| `/yo` y `/salir` | `sala-http`: "/yo y /salir también validan el slug" | sacar `canalPermitido` de cualquiera de las dos |
| Chat en sala ajena | `sala-http`: "escribir en la sala de OTRO creador no le cae al dueño en el chat" | sacar el guard `slug !== SLUG_DUENO` |
| Canal liberado | `reloj`: "detener libera el canal de la memoria si no quedó nadie mirando" (+ dos que cuidan que no se libere de más) | borrar `canales.olvidarReloj(s)` |

### Dos trampas que aparecieron escribiendo estas pruebas

Las dos son la misma que ya había mordido dos veces en esta fase: **una prueba
que pasa por el motivo equivocado**.

1. El test de "escribir en la sala de OTRO creador" usaba `sesionEspectador`, la
   cookie compartida del archivo. Pero un test anterior (el del 401 de Kick) le
   cierra la sesión y le borra el token a propósito. Con esa cookie, el pedido
   moría en 401 antes de llegar al guard, y la aserción fuerte
   —`pedidosAKick.length === 0`, "nada salió al canal del dueño"— era verdad **sin
   que el guard existiera**. Se agregó `nuevoEspectador()`, que crea uno propio y
   vivo por test. Verificado: con la mutación puesta, ahora contesta 200, o sea
   que el mensaje llega a Kick de verdad.
2. La primera versión del test de XSS asertaba que `onerror=` no apareciera en
   la respuesta. Falla, y **el código tenía razón**: una vez que el `<img` de
   adelante quedó en `&lt;img`, un `onerror=alert(1)` suelto en el texto es
   inofensivo. Lo que hay que asertar es que no se pueda **abrir una etiqueta**, y
   que el payload no aparezca nunca tal cual. Una aserción de más habría dejado
   la prueba fallando por algo que no es un bug.

Y una tercera, de escritura: los caracteres de control en los archivos fuente se
escriben **con escapes** (`\u0000`, `\n`), nunca de verdad. Un `\n` literal adentro del
archivo de la prueba es exactamente lo que la prueba prohíbe, y encima no
sobrevive un copiar y pegar. Se arregló dos veces antes de que quedara.

### Anotado, no arreglado (decisión del director)

- **`DERIVA_TOLERADA = 1.5` es por navegador, el criterio es entre navegadores.**
  Dos pantallas a 1,49 s del servidor y para lados opuestos dan casi 3 s entre
  sí; en el papel el umbral tendría que ser 0,75. Se deja en 1,5 porque **la
  deriva real es de un solo signo**: lo que la produce es el player, que se
  atrasa al bufferear, al perder un cuadro o al volver de segundo plano, y
  ninguna de esas cosas *adelanta* un `<video>`. Atrasándose las dos para el
  mismo lado, la diferencia es la de sus atrasos y no la suma; medido con dos
  pestañas reales, 0,04 s. Bajarlo tiene costo: cada corrección es un seek
  visible y un segmento nuevo. El razonamiento entero quedó escrito arriba de la
  constante en `sala.js`, con dónde mirar y cuál es el arreglo si algún día
  aparecen dos pantallas de verdad a más de 1,5 s.
- **No hay token CSRF en ningún POST**; la defensa es `SameSite=Lax`, que es lo
  que pide el brief y alcanza. Lo anotado en `sesion.js` es que esa defensa es
  **un solo renglón**, y qué cinco POST quedan abiertos de golpe el día que algo
  pida `SameSite=None` (un embed de la Sala adentro de otro sitio es el caso
  realista). Los cinco están listados por nombre ahí.
- **El criterio (d), sin scroll horizontal en celular**, no lo puede cazar el DOM
  de mentira, que no hace layout. El CSS está defendido (`minmax(0,…)`,
  `min-width:0`, `overflow-wrap:anywhere`, `overflow-x:hidden` en el body). Queda
  como está.

### Archivos tocados

`servidor/videos.js` (`limpiar`, `hostPropio`, los dos chequeos de host),
`servidor/index.js` (carrera de `/eventos`, `canalPermitido` en `/yo` y
`/salir`, guard de sala en el chat), `servidor/canales.js` (`soltarSiVacio`
factorizado, `olvidarReloj`), `servidor/reloj.js` (olvidar el reloj al
detener), `servidor/sesion.js` (la nota de CSRF), `paginas/sala/sala.js` (la
nota de `DERIVA_TOLERADA`), `README.md`, y las pruebas de `videos`,
`sala-http`, `servidor`, `pagina-sala` y `reloj`.

**`herramientas/` no se tocó**, como estaba pedido. Sus 121 pruebas de Python se
corrieron igual para confirmar que el chequeo de host nuevo no le rompe nada:
`subir.py` arma la URL con `R2_URL_PUBLICA` (un `pub-….r2.dev`), y si alguna vez
quedara mal cargada, ahora el script imprime el error del servidor tal cual, que
es justo lo que hace falta para darse cuenta.

### Cómo verlo

```
npm test                      # 439 en verde
node --test pruebas/videos.test.js pruebas/sala-http.test.js
```

Y a mano, con el servidor levantado y una clave de subida generada en `/panel`:

```
curl -X POST localhost:8778/api/videos -H "X-Clave-Subida: <la clave>" \
     -H 'Content-Type: application/json' \
     -d '{"id":"x","slug":"istincho","titulo":"x","duracion":10,
          "url":"https://localhost:8778/sala/x.m3u8"}'
# 400: la url no puede apuntar a esta misma maquina
```

### Qué queda pendiente

Nada de la verificación. Para la Fase 3, dos cosas que este trabajo dejó
señalizadas y que **no** son opcionales cuando entre el segundo creador:

1. El 503 del chat en salas ajenas es un cartel de obra, no la solución: el
   mensaje tiene que rutearse al vínculo de Kick **de esa sala**, no al del
   dueño. Lo mismo el 403 del reloj (`conDuenoDeLaSala` ya lo tiene anotado).
2. `canalPermitido` sale a `creadores` en cada `/eventos/:slug`. Con la
   colección vacía cortocircuita; con Mongo y mil creadores es una consulta por
   conexión y conviene una cache corta.

---

## 2026-09-06 — Fase 2: los cuatro cabos que quedaron sueltos

Las cuatro cosas que la entrada de abajo dejó anotadas sin cerrar, cerradas.
**411 pruebas en verde** (eran 404) y **once mutaciones aplicadas a mano, once
cazadas** sobre una copia del árbol en un directorio aparte. La suite se corrió
entera diez veces: las primeras cuatro destaparon un test que fallaba una de
cada diez, y ese también se arregló.

Trabajo hecho en paralelo con el arreglo del script de subida, sin tocar
`herramientas/`.

### 1. El botón ▶ con la sala en pausa (el peor de los cuatro)

Con la sala pausada, tocar ▶ arrancaba la película. El reloj no se enteraba, y
diez segundos después la sincronización la tironeaba de vuelta al segundo donde
la sala estaba congelada. La persona veía el video moverse y después dar un
salto para atrás, sin nada que lo explicara; y volvía a pasar cada diez
segundos mientras siguiera insistiendo.

El botón existe porque el navegador puede no dejar arrancar solo, **no para
pelearse con el reloj de la sala**. Ahora el click levanta la pausa local,
sincroniza y le pasa la decisión a `aplicarReproduccion()`, que es la única que
decide si se reproduce y que con la sala en pausa deja el video quieto. Y como
"no pasó nada" es una respuesta pésima para un botón, se avisa por qué: *la
sala está en pausa: arranca sola cuando la reanuden* (o *todavía no empezó la
película*, si el reloj está detenido).

El efecto que importa: la pausa local queda **levantada**, así que cuando el
dueño reanuda, esa pantalla arranca sola sin que nadie toque nada. Hay una
prueba que sigue la historia entera: pausa → click → sigue quieto y lo dice →
llega el reloj reanudado → arranca.

### 2. `iniciar()` ya no depende de que `/api/hora` conteste

Era `await medirDesfase()` **antes** de conectar al bus, y el `fetch` no tenía
timeout. Un `/api/hora` colgado —un proxy que se traga la respuesta, una red
que se fue a mitad de camino— dejaba la sala **muda para siempre y sin un solo
error visible**: no conectaba, así que no llegaba ni el reloj, ni el chat, ni
el contador. En vivo eso parece "se rompió todo" y no deja rastro.

Dos cambios:

- **Primero el cable.** `conectar()` y el intervalo de sincronización van
  antes; la medición sale después y sin `await`, y cuando termina fuerza una
  sincronización. El desfase arranca en cero, que es una suposición razonable
  (el reloj de una máquina rara vez está a más de un segundo) y se corrige sola
  en cuanto la medición llega.
- **Corte de 3 s por pedido**, con `AbortController`. Si el primero se cortó,
  no se intentan los otros dos: son nueve segundos de espera para el mismo
  resultado. Queda para la medición de dentro de diez minutos, que ya existía.

### 3. El botón "Suscribirse"

Debajo del chat, ancho completo, en el verde de Kick. Es un link de verdad a
`https://kick.com/<canal>/subscribe`, con `target="_blank"` y
`rel="noopener noreferrer"` para que la película siga corriendo en esta
pestaña. El slug sale de la dirección, así que va con `encodeURIComponent` como
el del iframe de la cámara, y hay una prueba con un canal raro que lo verifica.
De este lado no se cobra nada: la suscripción se paga y se maneja en Kick.

### 4. La prueba de pantalla completa

Faltaba, y no era decorativa: prueba que se pide sobre `#caja-video` y **no
sobre el `<video>` pelado**. La diferencia se ve: la caja lleva los controles
adentro, así que pedirla sobre el video deja a la persona en pantalla completa
sin volumen, sin subtítulos y sin play.

Para eso, `pruebas/fijos/dom-falso.js` aprendió tres cosas chicas:
`requestFullscreen()` en los elementos, `fullscreenElement` / `exitFullscreen()`
en el documento, y `AbortController` en el contexto de la página. Además, ahora
**todo el árbol parseado sabe de qué documento es** (antes sólo lo sabían los
elementos creados desde el JS), que es lo que permite que un elemento del HTML
pida la pantalla completa.

### El test que pasaba nueve de cada diez veces

Corriendo la suite entera cuatro veces apareció `reloj.test.js` → *reanudar
arranca un tramo nuevo: el tiempo pausado no cuenta*, fallando **una de cada
diez**, y no por un bug: la posición se mide contra el reloj de pared después
de que `aplicar()` escriba en el almacén, y esa escritura a veces se toma 140
ms. Con 300 ms de pausa y 0,1 s de tolerancia, eso alcanzaba para fallar.

Se separaron los números en vez de aflojar la tolerancia sola: **1,2 s de pausa
contra 0,5 s de tolerancia**. El bug que ataja (que reanudar cuente el tiempo
pausado) da 1,2 s de diferencia y se sigue cazando —verificado con la mutación—
y el ruido de la máquina tiene tres veces más lugar del que necesita.

### Las once mutaciones, y qué las caza

| Mutación | La caza |
|---|---|
| ▶ con la sala en pausa vuelve a `intentarReproducir()` | *con la sala en pausa, ▶ no arranca la película* (y la de "detenida") |
| se saca el aviso de por qué no arrancó | las mismas dos |
| vuelve el `await medirDesfase()` antes de `conectar()` | *un /api/hora colgado no deja la sala muda* |
| se saca el corte de 3 s del `fetch` de la hora | *el pedido de la hora se corta solo* |
| se saca el `break` y se cuelga tres veces seguidas | la misma |
| pantalla completa sobre el `<video>` en vez de la caja | *pantalla completa es la caja del video* |
| el botón no sale de pantalla completa | la misma |
| el link de suscribirse sin `encodeURIComponent` | *un canal raro tampoco se cuela* |
| el link sin `rel="noopener noreferrer"` | *el botón de suscribirse es un link a kick.com* |
| el link se queda escondido | la misma |
| `reanudar` cuenta el tiempo que estuvo pausado | *reanudar arranca un tramo nuevo* (con el margen nuevo) |

### Una trampa que costó, y queda anotada

**Un `assert.equal` sobre un nodo del árbol cuelga la suite.** El primer test de
pantalla completa comparaba el elemento contra `p.el('caja-video')`. Cuando la
mutación lo hizo fallar, node se puso a armar el mensaje de error imprimiendo
los dos elementos —con sus padres, sus hijos y las referencias circulares— y la
corrida no terminó nunca: dos minutos y hubo que matarla. La mutación quedaba
como "la suite se cuelga" en vez de "este test falla", que es de lo peor que
puede pasar cuando lo que estás midiendo es si el test cae. Ahora se compara
por `id`. Vale para cualquier prueba de estas páginas.

### Cómo verlo funcionando

```bash
npm test                     # 411 pruebas
```

En `http://localhost:8778/sala/istincho?demo=1` se ve el botón "Suscribirse"
debajo del chat (apunta al canal de la dirección igual que la página de verdad).

### Pendiente, sin cambios

Lo de la entrada de abajo sigue igual: la cuenta secundaria de Kick para probar
el circuito completo del espectador, `chat.js` creando canales del bus con el
slug del payload, el límite de envío en memoria, y la corrección por seek en
vez de `playbackRate`. Nada de eso se tocó.

### Archivos tocados

`paginas/sala/sala.js` (el botón ▶, el arranque, el corte del fetch, el link de
suscribirse), `paginas/sala.html` (el link), `paginas/sala/sala.css` (su
estilo), `pruebas/pagina-sala.test.js` (siete pruebas nuevas),
`pruebas/fijos/dom-falso.js` (pantalla completa, `AbortController`, el árbol
sabe de su documento), `pruebas/reloj.test.js` (el margen de la prueba que
fallaba una de cada diez), `README.md`, `BITACORA.md`.

---

## 2026-09-06 — Fase 2: la Sala

Los entregables 2 a 5 del prompt, más las dos rutas que el script de subida ya
llamaba y todavía no existían. **404 pruebas en verde** (eran 238) y **30 de 30
mutaciones cazadas** sobre una copia limpia del árbol. La sincronización se
verificó **con dos navegadores de verdad** contra el servidor levantado a mano:
0,04 s de diferencia entre los dos, y 0,51 s después de pausar, saltar 300 s y
reanudar desde el panel.

Trabajo hecho en paralelo con el cierre de los cabos sueltos de la Fase 1,
sin tocar `servidor/chat.js`, `servidor/twitch.js` ni `pruebas/chat-*.test.js`.

### Lo que quedó funcionando

- **Las dos rutas que faltaban.** `POST /api/videos` y `DELETE /api/videos/:id`,
  con la cabecera `X-Clave-Subida` (no cookie: el script corre en una terminal).
  El mismo `id` pisa y no duplica. El `DELETE` contesta 404 si no lo tenía, que
  para el script no es error. Se acepta también la ficha corta de `--avisar`,
  que manda cinco campos y ninguna calidad.
- **La clave de subida** se genera y se revoca desde `/panel`, se guarda
  hasheada en la colección nueva `subidas`, y autoriza **una sola sala**.
- **`servidor/reloj.js`**: estado por canal, persistido, con `reproducir`,
  `pausar`, `reanudar`, `saltar` y `detener`. Cada cambio sale por SSE como
  `{tipo:"reloj", …}`. `GET /api/hora` para que cada navegador mida su desfase.
- **`/sala/:slug`**: hls.js clavado en 1.5.17 con `integrity`, cámara en un
  iframe de `player.kick.com`, chat de Kick con el render compartido, login de
  espectador, envío con límite de uno cada dos segundos, contador de gente
  conectada, y pantalla de espera con la cámara grande cuando el reloj está
  detenido. En celular se apila y **no hay scroll horizontal** (medido:
  `scrollWidth === clientWidth` a 375 px).
- **`/panel`** extendido: reloj con play/pausa/saltar/detener, lista de videos,
  espectadores conectados y pico, salud de Kick y Twitch, la URL del webhook
  que hay que pegar a mano, y la clave de subida.
- **`servidor/metricas.js`**: mensajes por hora, envíos, 429 y espectadores
  pico, mostrados en el panel.
- **`?demo=1`** en la Sala: se ve la página entera sin servidor ni credenciales.

### La decisión que la Fase 1 dejó anotada: qué ve el bus público

**El bus público manda sólo Kick. Las dos redes se desbloquean con la sesión
del dueño.**

Por el canal del dueño viaja también su chat de Twitch (`chat.js:356` hace
`recordar(slugDueno, mensaje)` para las dos redes) porque `/chat` las muestra
juntas. Pero `/eventos/:slug` no pide sesión, y desde esta fase lo escucha
cualquiera que abra la Sala a ver la película.

Se evaluaron tres caminos:

1. **Filtrar en el cliente.** Cero cambios en el servidor. Descartado: el chat
   de Twitch igual saldría por el cable hacia trescientas pestañas y un `curl
   /eventos/istincho` lo vería entero. Además es ancho de banda regalado por
   cada espectador.
2. **Filtrar en el servidor, por conexión.** Elegido. Cada conexión declara qué
   redes quiere (`canales.suscribir(slug, req, res, {redes})`), y la ruta decide:
   sin cookie de dueño, `['kick']`. Vive entero en `canales.js` + `index.js`, o
   sea que **no toca `servidor/chat.js`**, que lo tenía el otro agente.
3. **Partir el bus en dos canales.** Descartado por ahora: obliga a tocar
   `chat.js` y a duplicar el buffer, para el mismo resultado.

Dos detalles que importan:

- **El buffer de 200 mensajes pasa por el mismo filtro.** Sin eso, una sala que
  no recibe Twitch en vivo se comía igual los últimos 200 mensajes de Twitch al
  conectarse: la mitad del problema, y la más visible.
- **La página de la Sala NO vuelve a filtrar, a propósito.** Si filtrara, una
  regresión en la puerta del servidor sería invisible. Una sola fuente de
  verdad. Hay una prueba que deja escrito que un mensaje de Twitch entregado a
  la página se muestra, justamente para que nadie "arregle" eso.

Efecto buscado para la Fase 3: el día que haya varios creadores, "qué ve cada
conexión" ya es una pregunta que este código se hace.

### Otras decisiones, y por qué

**1. El reloj guarda `empezoEn`, no "el segundo actual".** Guardar la posición
obligaría a escribirla todo el tiempo y entre dos escrituras el estado estaría
mal. Con el momento en que arrancó el tramo, el estado sólo cambia cuando
alguien toca un botón, y un deploy en medio de la película no pierde nada
porque es una fecha absoluta. `arrancar()` lo levanta del almacén; si el video
ya no está en el catálogo, arranca detenido y limpia.

**2. `posicion` y `ahora` viajan en el evento pero no se usan para calcular.**
El reloj le llega al que se conecta adentro del evento `estado`, y ese objeto
está guardado en el canal desde que se tocó play: su `posicion` puede tener
horas de viejo. La página calcula siempre con `offsetInicial + (ahora −
empezoEn)`. Hay una prueba que lo hace cumplir (y una mutación que la caza).

**3. Seek duro por encima de 1,5 s, con tres guardas.** Se evaluó corregir con
`playbackRate` (más suave), pero converge en un minuto y el criterio de
aceptación pide menos de 1,5 s de diferencia. El riesgo del seek duro es
oscilar; lo matan las guardas: no se corrige con la pausa local puesta, ni
mientras el video busca o no tiene datos (ahí la deriva medida es el buffer),
ni dentro de los 5 s de una corrección anterior.

**4. La película arranca muda.** Ningún navegador deja reproducir con sonido sin
un gesto, y esperar ese gesto significa arrancar tarde y desincronizado. Muda
arranca siempre; el botón del parlante devuelve el sonido y no mueve nada más.
El `mudo` guardado en `localStorage` sólo puede apagar el sonido, nunca
prenderlo: si no, alguien que vuelve se quedaría esperando un gesto que quizás
no llegue.

**5. La clave de subida no se muestra en pantalla.** El dueño trabaja con la
transmisión al aire. El panel la copia al portapapeles y sólo la muestra si
alguien toca "Mostrar igual", con el aviso al lado. Se guarda hasheada con
SHA-256 (32 bytes al azar no necesitan bcrypt) y se compara con
`timingSafeEqual`.

**6. Las métricas viven en memoria.** Una escritura en Mongo por cada mensaje
del chat, todas las noches, para un número que se mira una vez, no se paga. El
precio es que un despliegue las pone en cero, y el panel lo dice al lado de los
números en vez de dejar creer que son de toda la noche.

**7. El contador de espectadores va por el bus, con rebote de 1 segundo.**
Cuando arranca la película entra gente de a decenas: difundir uno por uno serían
N eventos a N pestañas. El rebote además ordena la carrera del cierre (para
cuando el timer dispara, la cuenta ya está bien). Vive en `index.js`, no en
`canales.js`: el bus sigue siendo un caño tonto.

**8. El render de un mensaje se sacó a `paginas/comun/mensajes.js`.** La Sala
muestra los mismos mensajes con el mismo formato único; dos copias del armado
terminan siendo dos comportamientos el día que alguien arregla uno. `/chat`
ahora lo usa también (`crearElementoMensaje` quedó como una línea). Se hizo al
final, con el trabajo del otro agente ya commiteado.

### Tres trampas que costaron y quedan anotadas

**A. El enrutador contestaba 405 al método bueno.** Cortaba en la primera
coincidencia de camino: con `GET /api/videos` escrito más arriba en la tabla, un
`POST /api/videos` perfectamente válido se contestaba "solo acepta GET". Con una
ruta por camino no se notaba; desde que hay dos métodos por camino, sí. Ahora se
juntan todas las que coinciden y recién después se elige por método, y el
`Allow` del 405 lista los de verdad.

**B. `/sala/:slug` tapa todo lo que cuelgue de `/sala/`.** Y ahí viven
`sala.css`, `sala.js` y `demo.js`. `/sala/sala.css` se interpretaba como "la
sala del canal sala.css", daba 404, y la página se veía sin estilos ni script.
Un slug no lleva punto, así que lo que no parece slug se deja pasar a los
estáticos. Es una trampa de cualquier ruta con parámetro sobre un directorio de
estáticos.

**C. `elemento.hidden = true` no esconde nada si el CSS le puso un `display`.**
Las columnas y las bandas de aviso son flex, así que `[hidden]{display:none
!important}` no es decoración: sin esa línea la pantalla de espera convivía con
el video.

Y una que no es un bug pero se parece: **Chrome pausa solo el video mudo de una
pestaña que no se ve** ("video-only background media was paused to save power")
y al volver no lo arranca. Salió corriendo la página de verdad, no de un test.
Se atiende con `visibilitychange`. Además, un `play()` rechazado no siempre es
autoplay bloqueado: el `AbortError` de una carga que pisó a la anterior no tiene
que sacar el cartel de "tocá play".

### Cómo verlo funcionando

```bash
npm test                     # 404 pruebas
```

Sin credenciales de ningún tipo, la página entera con datos de mentira:

```
http://localhost:8778/sala/istincho?demo=1
```

Con el servidor de verdad y sin R2, usando un HLS público de prueba: se siembra
una ficha de video y una sesión de dueño en el almacén (`SALA_DATOS` apunta a
una carpeta propia), se levanta `node servidor/index.js`, y se maneja el reloj
con curl:

```bash
curl -s -X POST -H "Content-Type: application/json" -H "Cookie: sala_dueno=…" \
  -d '{"accion":"reproducir","videoId":"prueba"}' \
  http://localhost:8778/api/sala/istincho/reloj
```

Con dos pestañas abiertas en `/sala/istincho`, `video.currentTime` de las dos
quedó a 0,04 s; después de `pausar`, `saltar +300` y `reanudar`, a 0,51 s.

Para probar con un archivo propio sin bucket:

```bash
python herramientas/subir.py "algo.mkv" --solo-preparar
cd hls-<id> && python -m http.server 8001
```

y se carga esa `maestra.m3u8` como `url` de la ficha.

### Qué queda sin verificar contra lo real

- **Nada se probó contra Kick de verdad.** No hay `KICK_CLIENT_ID` ni secret
  (tareas 3 y 4 de `TAREAS-DUENO.md`). Lo que falta comprobar: que el login de
  espectador con `user:read chat:write` devuelva el `scope` con ese nombre
  exacto, que `POST /public/v1/chat` con `type:"user"` publique con el nombre
  del espectador y no con el de la app, y **cuál es el rate limit de envío**
  (no está documentado). El camino del 429 y su `Retry-After` se ejercita con un
  `fetch` de mentira que contesta como la API, así que el código está probado;
  el número, no.
- **Nada se probó contra R2 de verdad.** No existe el bucket (tareas 9 y 10).
  Sin el CORS del bucket, hls.js no carga nada: es lo primero a mirar cuando
  esté.
- **Nada se probó contra Mongo de verdad.** Todo corrió en modo archivo.
- **Una película de dos horas.** El reloj se probó con un HLS de prueba y con
  saltos de 300 s; el comportamiento con miles de segmentos y un buffer real de
  dos horas está sin medir.
- **`r2.dev` con trescientas personas.** El riesgo que anota PLAN.md sección 5.

### Lo que necesita el dueño

1. Cargar `KICK_CLIENT_ID`, `KICK_CLIENT_SECRET`, `CLAVE_CIFRADO`, `KICK_SLUG`,
   `URL_BASE` y `MONGODB_URI` en Railway (tareas 3 a 8).
2. Crear el bucket R2 con acceso público **y CORS** (tareas 9 y 10). Sin CORS el
   video no carga y el error del navegador no dice por qué.
3. Entrar a `/panel`, tocar **Generar una nueva** en la clave de subida,
   **Copiar**, y pegarla en `herramientas/.env` como `CLAVE_SUBIDA`. No hace
   falta que aparezca en pantalla; si estás transmitiendo, no toques "Mostrar
   igual".
4. Pegar la URL del webhook (`/panel` la muestra) en kick.com → Settings →
   Developer → Enable Webhooks. Sin eso el chat de la Sala queda mudo.

### Pendiente, anotado

- **La cuenta secundaria de Kick** para probar el circuito completo del
  espectador (login → escribir en la Sala → aparece en kick.com → vuelve por el
  webhook) es lo único que falta del criterio de aceptación y depende de las
  credenciales.
- **El botón "Suscribirse" a kick.com/istincho** que menciona el objetivo del
  prompt (no está en la lista de entregables). Es un link; se agrega en cinco
  minutos cuando el dueño diga dónde lo quiere.
- **`chat.js` todavía puede crear canales del bus con cualquier slug del
  payload** (anotado en la entrada "Fase 1: CERRADA"). El filtro por red no lo
  toca: sigue siendo la misma puerta, del otro lado.
- **El límite de envío y la espera del 429 viven en memoria.** Con más de una
  instancia en Railway dejarían de valer. Hoy hay una sola.
- **La sincronización no corrige con `playbackRate`.** Un seek de 1,5 s se ve.
  Si molesta, la alternativa está evaluada en la decisión 3.

### Archivos tocados

Nuevos: `servidor/{videos,reloj,espectadores,metricas}.js`,
`paginas/sala.html`, `paginas/sala/{sala.js,sala.css,demo.js}`,
`paginas/panel/{panel.js,panel.css}`, `paginas/comun/mensajes.js`,
`pruebas/{videos,metricas,reloj,espectadores,sala-http,pagina-sala,pagina-panel}.test.js`.

Editados: `servidor/index.js` (rutas nuevas, callback de espectador, filtro de
redes, presencia, enrutador), `servidor/canales.js` (filtro por red por
conexión), `servidor/almacen.js` (colección `subidas`), `servidor/vinculos.js`
(`identidad`), `servidor/kick.js` (`retryAfter` en el error),
`paginas/panel.html` (reescrita, el JS salió a `panel/panel.js`),
`paginas/chat.html` y `paginas/chat/chat.js` (usan el render compartido),
`pruebas/canales.test.js` (el filtro), `pruebas/pagina-chat.test.js` (carga el
render compartido), `pruebas/fijos/dom-falso.js` (elementos `<video>`, `append`,
scripts previos, ruta y globales), `README.md`, `BITACORA.md`.

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

## 2026-09-06 — Verificación de la Fase 2: NO PASA

Escrito por el director. La verificación la lanzó el propio agente de fase y
llegó **después** de que la sesión se cortara, así que **nada de esto está
arreglado**. Queda entero para la próxima sesión.

Cómo verificó: `npm test` tres veces sobre `715efec` (411/411, sin flakes),
**72 mutaciones propias** (63 cazadas, 9 vivas), y el servidor levantado a mano
en `:8821` sembrado con sesión de dueño, sesión de espectador, dos claves de
subida (una de una sala ajena) y una ficha de video. Ninguna mutación
sobreviviente prueba código incorrecto: son agujeros de red.

### Fallas

**F1. `servidor/videos.js:144-154` promete un chequeo de host que no existe.**
El comentario dice textual que la URL tiene que ser https *"y de otro host: el
servidor no sirve video, así que una ficha que apunte a nuestro propio dominio
es un error de configuración que conviene atajar acá y no descubrirlo con la
factura de egreso"*. El código chequea `protocol` y `.m3u8`, y **nada más**.
Verificado: un `POST /api/videos` con `url: https://localhost:8821/sala/x.m3u8`
devuelve 200. Hoy no cuesta plata porque ninguna ruta sirve `.m3u8`, pero es la
invariante más cara del proyecto **documentada como implementada sin estarlo**.
O se escribe el chequeo o se corrige el comentario: dejarlo así es que la Fase 3
lo lea y lo dé por hecho.

**F2. Inyección de líneas en el log por el título del video.** `videos.js:136`
recorta a 200 caracteres pero no saca caracteres de control, y `index.js:920`
lo mete en un `console.log`. El título sale del nombre de un archivo. Salida
real conseguida: una línea falsa `[http] POST /api/panel 200 clave=FALSA` en el
log. Necesita la clave de subida (o sea, es el dueño), pero los logs de Railway
no se borran y ésa es la única evidencia cuando algo falla.

**F3. Cinco guardas de la Fase 2 sin una sola prueba** (las mutaciones
sobreviven las 411):
- Borrar `await espectadores.olvidar(...)` de "Salir" (`index.js:795`): la
  sesión se cierra pero **el refresh token del espectador no se borra**. El
  README y el comentario prometen que sí. Es la única promesa de privacidad
  sobre datos de terceros de toda la fase, y no hay ninguna prueba HTTP de
  `POST /api/sala/:slug/salir`.
- Borrar `canalPermitido(slug)` de `apiSalaChat` (`index.js:812`).
- Sacar `escapar()` de `pagina()` (`index.js:102`): habilita **XSS reflejado sin
  autenticación** en `/oauth/kick/volver?error=…`, en el origen donde vive la
  cookie del dueño. Hoy escapa bien; nada lo sostiene.
- `videos.listar(SLUG_DUENO)` volviéndose elegible por query (`index.js:949`):
  la fuga de tenant que la Fase 3 hereda.
- Borrar `if (mejor) desfase = mejor.desfase;` (`paginas/sala/sala.js:153`): el
  desfase medido contra `/api/hora` **nunca se aplica**. Los tests de
  sincronización entran por `fijarDesfase()` y se saltean `medirDesfase()`. En
  una máquina con el reloj corrido, el criterio de aceptación (a) depende
  enteramente de esa línea.

### Dudas que conviene resolver antes de la Fase 3

- **Carrera en `/eventos/:slug` que deja un cliente fantasma**
  (`index.js:1091-1128`): `canales.suscribir` engancha el `close` después de dos
  `await`; si el socket muere en el medio, el listener tardío no dispara y
  `res.write()` no tira, así que nada lo saca. Contador de espectadores inflado,
  pico mentiroso, canal que no se libera. Hoy inalcanzable en el camino normal
  (los dos `await` cortocircuitan sin I/O); con Mongo y slugs de creador, real.
- `/api/sala/:slug/yo` y `/salir` no validan el slug: son las dos únicas rutas
  de `/api/sala/` que no pasan por `canalPermitido`.
- **El chat del espectador rutea por el dueño, no por la sala** (`index.js:841`).
  El reloj tiene su guard `slug !== SLUG_DUENO` con comentario de Fase 3; el
  chat no tiene ninguno. Hoy no explotable porque `creadores` está vacío.
- El canal nunca se libera después de "detener": `canales.js:211` no lo borra si
  `c.reloj` es truthy, y detener deja un objeto truthy. `restaurar()` evita
  justamente eso, así que las dos mitades no coinciden.
- `DERIVA_TOLERADA = 1.5` es **por navegador**, pero el criterio de aceptación es
  *entre* navegadores: dos pantallas podrían estar a 3 s. En la práctica la
  deriva es de un solo signo y se midieron 0,04 s con dos pestañas reales.
- `init.mp4` suelto en la raíz y `.gitignore` no ignora ningún formato de video:
  un `git add -A` lo commitea.

### Lo bueno

El filtro por red del bus es la parte mejor probada de la fase: seis mutaciones
distintas, las seis cazadas. El reloj se corrió en vivo (reproducir → pausar →
saltar +300 → reanudar) y la aritmética no pierde el tiempo de pausa. hls.js
1.5.17 clavado con `integrity`. El `<video>` no tiene `controls`, así que no hay
barra de adelantar. La autorización se probó con curl: reloj sin sesión 401, con
cookie de espectador 401, dueño en sala ajena 403, y la cookie de espectador
pegada en la ranura del dueño da 401 porque la firma está atada al nombre de la
cookie. Cero `innerHTML` en las tres páginas nuevas.

---

## 2026-09-06 — Dónde quedó todo (corte para dormir)

Escrito por el director al frenar la sesión. **`herramientas/` tiene trabajo a
medio hacer, sin commitear.** El agente que estaba arreglando el script de
subida se frenó por la mitad, a pedido del dueño. Los archivos modificados
(`subir.py`, `pruebas_subir.py`, `requirements.txt`, `LEEME.md`) están en el
disco pero **no se sabe cuánto de las cinco fallas quedó realmente arreglado ni
probado**: no hay que darles ninguna confianza. Lo primero de la próxima sesión
es mirar ese diff y decidir si se termina o se descarta con
`git checkout -- herramientas/`.

También quedó un `init.mp4` suelto en la raíz del repo: es basura de una prueba
con ffmpeg, no va al repo.

### Estado por fase

- **Fase 0: cerrada y pusheada.** Tres rondas de verificación adversarial.
- **Fase 1: cerrada.** Segunda verificación sin fallas, y los siete cabos
  sueltos cerrados después. Sin pushear.
- **Fase 2: construida, sin verificación independiente todavía.** 411 pruebas
  en verde. El script de subida (entregable 1) **fue rechazado** por su
  verificador: ver la entrada de esa verificación, con las cinco fallas. El
  resto de la fase (reloj, `/sala/:slug`, `/panel`, métricas, rutas de videos)
  está commiteado y todavía **nadie de afuera lo revisó**.
- **Fase 3: no arrancó.**

### Lo primero de la próxima sesión

1. Decidir qué hacer con el diff sin commitear de `herramientas/`.
2. Terminar los arreglos de las cinco fallas del script de subida.
3. Verificación independiente de la Fase 2 (falta por completo).
4. Recién ahí, Fase 3.

Nada de la Fase 1 ni de la Fase 2 está pusheado: los commits están sólo en la
máquina del dueño.

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
