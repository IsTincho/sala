# Emotes: qué se puede mostrar, de dónde sale y qué cuesta

Investigación del 2026-09-22. Cubre Kick, Twitch, 7TV, BTTV y FFZ para los dos
repos: `CosasStream` (overlays de OBS + servidor de puente) y `Sala` (multichat).

Todo lo que dice **verificado** lo probé contra el servicio real el mismo día, y
está el comando o la respuesta al lado. Lo que dice **sin confirmar** no lo pude
comprobar y está marcado como tal, no rellenado con memoria.

---

## Resumen ejecutivo

La conclusión más importante, y la que el dueño quería: **los emotes
coleccionables de Kick ya se pintan solos, hoy, sin tocar una línea**. Lo
verifiqué: viajan dentro del `content` como un `[emote:ID:nombre]` común y
corriente, con el nombre arrancando en `collectibles`, y `files.kick.com` los
sirve igual que a cualquier otro. Tanto `partirTextoDeKick()` de Sala como el
overlay de Chat de CosasStream ya los resuelven sin saberlo. Lo que **no** hay
es forma soportada de *listarlos*: no aparecen en ninguna lista pública de
emotes, no hay endpoint oficial, y el único que los enumera es el de la sesión
del usuario logueado. O sea: mostrarlos sí, hacer un selector de coleccionables
no.

El segundo hallazgo es que hay un agujero al revés: **los emotes de Twitch no se
pintan en CosasStream**. Sala ya los resuelve bien (`URL_EMOTE_TWITCH` arma la
URL correcta del CDN), pero los dos overlays de CosasStream tienen
`files.kick.com` escrito a mano y tratan todo mensaje como si fuera de Kick.
Como las alertas de Twitch ya entran por EventSub, esto es el arreglo con mejor
relación valor/esfuerzo de toda la lista.

El tercero es de riesgo operativo: algunos coleccionables son **gifs de casi un
mega**. Uno de los seis que capturé pesa 947 KB. El overlay de Emotes aguanta 40
en pantalla. Conviene un tope de peso antes de que alguien spamee el pesado.

En 7TV, `emotesexternos.js` está sano y usa el id correcto, pero tiene dos cosas
desactualizadas: el comentario que dice que 7TV no manda CORS es falso hoy (sí
manda), y el polling de 10 minutos se puede reemplazar por la EventAPI, que
probé y funciona con el set de Kick del dueño. Sala, en cambio, no tiene nada de
emotes de terceros; el formato único ya tiene el campo donde meterlos.

En licencias hay un punto incómodo con Twitch (sus emotes globales están
explícitamente fuera de lo que le licencian a un desarrollador) y uno concreto
con Kick (prohíbe endpoints no documentados y limita el cacheo a 24 horas). Los
10 minutos actuales están bien; el endpoint no oficial `kick.com/emotes/{slug}`,
no.

---

## Tabla por plataforma

| Plataforma | Qué se puede | Cómo | Qué cuesta | Riesgo |
|---|---|---|---|---|
| **Kick nativos** (globales, emojis, de sub, y coleccionables) | Mostrarlos todos | El id y el nombre vienen en el `[emote:ID:nombre]` del mensaje; imagen en `https://files.kick.com/emotes/{id}/fullsize` | Cero: no hay pedido extra, ni token, ni API | Bajo. El CDN es público y manda `Access-Control-Allow-Origin: *` (verificado). Peso variable: png de 2 KB o gif de 950 KB |
| **Kick: listar los emotes de un canal** | Sí, pero por la puerta de atrás | `https://kick.com/emotes/{slug}` (no oficial, exige User-Agent de navegador) | Un pedido; no hay endpoint oficial | **Alto**: los términos de dev.kick.com prohíben endpoints no documentados sin permiso escrito |
| **Kick: listar coleccionables** | **No** | No existe API pública ni CDN indexado. `kick.com/emotes` sin slug da 401: es la lista del usuario logueado | — | No hay camino soportado. Ver sección 3 |
| **Twitch por EventSub** | Mostrar cualquier emote que aparezca en un mensaje, incluidos los de sub de otros canales | `message.fragments[].emote.id` + `https://static-cdn.jtvnw.net/emoticons/v2/{id}/default/dark/2.0` | Cero extra: ya viene en el evento que se recibe | Bajo técnicamente. Ver licencias |
| **Twitch por Helix** | Listar emotes de un canal, los globales y un set entero | `/helix/chat/emotes`, `/chat/emotes/global`, `/chat/emotes/set` | App token, sin scope. 800 puntos/min por client id | Bajo. Sólo hace falta si querés metadatos o un selector |
| **7TV** | Set del canal de Kick y del de Twitch, animados incluidos | `7tv.io/v3/users/kick/{userId}` o `/twitch/{twitchId}`; imágenes en `cdn.7tv.app/emote/{id}/4x.webp` | Sin auth. 5000 pedidos/min (cabecera `x-ratelimit-global-limit`, verificado) | Medio: servicio de terceros, sin SLA. Los términos no los pude leer |
| **7TV en vivo** | Enterarse cuando el streamer cambia su set | SSE o WS en `events.7tv.io/v3`, evento `emote_set.update` | Una conexión persistente. Límite de 500 suscripciones por conexión (verificado) | Medio: si se cae, se vuelve al polling |
| **BTTV** | Emotes de un canal de **Twitch** y globales | `api.betterttv.net/3/cached/users/twitch/{id}` y `/3/cached/emotes/global`; CDN `cdn.betterttv.net/emote/{id}/3x.webp` | Sin auth, CORS abierto, `Cache-Control: max-age=300` | Bajo. **No soporta Kick** (verificado: 404) |
| **FFZ** | Emotes de una sala de **Twitch** y globales | `api.frankerfacez.com/v1/room/id/{twitchId}` y `/v1/set/global`; cada emote trae sus `urls` ya armadas | Sin auth. 120 pedidos/min (cabecera `ratelimit-limit`, verificado) | Bajo. **No soporta Kick** (verificado: 404) |

---

## 1. Emotes de Twitch

### Qué trae el payload de EventSub

`channel.chat.message` parte el mensaje en `message.fragments[]`. Cada fragmento
tiene `type`, que puede ser `text`, `cheermote`, `emote` o `mention`, y el objeto
correspondiente lleno y los otros en `null`
([dev.twitch.tv](https://dev.twitch.tv/docs/eventsub/eventsub-subscription-types/)).

El objeto `emote` trae cuatro campos:

```json
{ "type": "emote", "text": "HeyGuys", "cheermote": null,
  "emote": { "id": "30259", "emote_set_id": "0", "owner_id": "0", "format": ["static"] },
  "mention": null }
```

- `id`: lo único que hace falta para armar la imagen.
- `emote_set_id`: el set al que pertenece. Para los globales es `"0"`.
- `owner_id`: el id del broadcaster dueño del emote. Para los globales es `"0"`.
- `format`: array con `"static"` y/o `"animated"`
  ([dev.twitch.tv](https://dev.twitch.tv/docs/chat/send-receive-messages/)).

Los scopes: `user:read:chat` del que chatea. Con app access token hacen falta
además `user:bot` del chatter y `channel:bot` del broadcaster (o ser mod)
([dev.twitch.tv](https://dev.twitch.tv/docs/eventsub/eventsub-subscription-types/)).

`servidor/mensajes.js` de Sala ya concatena los fragmentos y calcula las
posiciones en la misma pasada. Eso está bien y es más robusto que usar
`message.text` aparte.

### Cómo se arma la URL del CDN

Plantilla oficial, tal cual la publica Twitch
([dev.twitch.tv](https://dev.twitch.tv/docs/irc/emotes/)):

```
https://static-cdn.jtvnw.net/emoticons/v2/{{id}}/{{format}}/{{theme_mode}}/{{scale}}
```

- `format`: `static`, `animated` o `default`.
- `theme_mode`: `light` o `dark`.
- `scale`: `1.0`, `2.0`, `3.0`.

Lo que verifiqué a mano hoy:

| URL | Resultado |
|---|---|
| `.../v2/25/default/dark/2.0` | 200, `image/png`, 1621 B |
| `.../v2/25/static/light/1.0` | 200, `image/png`, 1242 B |
| `.../v2/25/animated/dark/3.0` | **404** (el emote 25 es sólo estático) |
| `.../v1/25/2.0` | 200 (la URL vieja sigue viva) |
| `.../v2/25/default/dark/4.0` | 200, 1814 B (escala **no documentada**, no confiar) |

La conclusión práctica: **`default` es la elección correcta** y es la que ya usa
`URL_EMOTE_TWITCH` en Sala. Pedir `animated` sin mirar el campo `format` te da
404 en la mitad de los emotes. Si algún día se quiere forzar animado, el dato
para decidirlo (`format`) viene en el fragmento; no hace falta pedir nada.

**No hace falta ninguna API para pintar un emote de Twitch.** El CDN es público,
sin token, y sirve cualquier id.

### Emotes de suscriptor de otros canales

Este era el punto a mirar con cuidado y la respuesta es tranquilizadora: un
emote de sub de otro canal llega **igual que cualquier otro**, como fragmento
`emote` con su `id`, su `emote_set_id` y el `owner_id` del otro canal. El CDN lo
sirve sin permisos. O sea: se pinta solo.

Helix sólo hace falta si querés el *nombre* o los metadatos del emote, o listar
el set completo:

- `GET /helix/chat/emotes?broadcaster_id=` — emotes custom del canal (sub, bits
  tier, follower).
- `GET /helix/chat/emotes/global` — los globales.
- `GET /helix/chat/emotes/set?emote_set_id=` — un set por id. La doc dice hasta
  25 ids por llamada; hay reportes de que el máximo realmente aplicado es 10
  ([foro de devs de Twitch](https://discuss.dev.twitch.com/t/working-with-emotes/42012)).
- `GET /helix/chat/emotes/user` — qué emotes puede usar *un* usuario. Requiere
  `user:read:emotes` del propio usuario. No sirve para pintar mensajes ajenos.

Los tres primeros aceptan **app access token y no piden scope**
([dev.twitch.tv](https://dev.twitch.tv/docs/api/reference/)). El límite general
de Helix es 800 puntos por minuto por client id, con cabeceras `Ratelimit-Limit`,
`Ratelimit-Remaining` y `Ratelimit-Reset`, y 429 cuando se acaba
([dev.twitch.tv](https://dev.twitch.tv/docs/api/guide)).

Los valores de `emote_type` que devuelven esos endpoints son `subscriptions`,
`bitstier` y `follower` para los custom de un canal, y las respuestas incluyen
`template`, `format`, `scale` y `theme_mode` para armar las URLs
([dev.twitch.tv](https://dev.twitch.tv/docs/api/reference/)).

---

## 2. Emotes de Kick

### Formato en el webhook

`chat.message.sent` manda el emote **dos veces**: incrustado en `content` como
`[emote:4148074:HYPERCLAP]`, y aparte en un array `emotes` con `emote_id` y
`positions: [{s, e}]`
([docs.kick.com](https://docs.kick.com/events/event-types)).

El comentario de `servidor/mensajes.js` que dice que las posiciones del array no
sirven y que la fuente de verdad es el markup **sigue siendo correcto**, y la
decisión de reemplazar el token por el nombre del emote es la que hace que el
`alt` diga algo cuando la imagen no carga. No lo tocaría.

### CDN

`https://files.kick.com/emotes/{id}/fullsize`. Lo que probé:

| Variante | Resultado |
|---|---|
| `/fullsize` | 200 |
| `/original` | 200 |
| `/small`, `/medium`, `/thumbnail`, `/1x`, `/2x` | 403 |

O sea: **no hay tamaños**, hay un solo archivo y se escala por CSS. El
`Content-Type` varía según lo que subieron: vi `image/png`, `image/gif`,
`image/webp` y hasta `binary/octet-stream` en un emote global. Manda
`Access-Control-Allow-Origin: *`, así que el navegador lo carga sin problema.

### ¿Hay API pública para listar emotes?

**No en la API oficial.** Bajé `https://docs.kick.com/llms-full.txt` completo y
no hay ningún endpoint de emotes: están Categories, Users, Channels, Livestreams,
Chat, Channel Rewards, Moderation y Kicks, y nada más. El changelog tampoco lo
menciona.

Aclaración para que nadie se ilusione: `https://api.kick.com/public/v1/emotes`
devuelve 401, no 404, pero eso no prueba nada — un path inventado como
`/public/v1/pepitogrillo` **también** devuelve 401. Sin token, todo da 401.

**Sí hay uno no oficial**, que es el que usa la web de Kick:
`https://kick.com/emotes/{slug}`. Verificado con el canal del dueño: devuelve un
array de tres grupos —el canal (32 emotes), `Global` (64) y `Emojis` (66)— y cada
emote es `{ id, channel_id, name, subscribers_only }`. Requiere un User-Agent de
navegador; con el de curl da 403.

El problema no es técnico, es de términos: ver la sección 6.

---

## 3. Emotes coleccionables de Kick

**Esta es la sección que importa.**

### Qué son

Son los premios de **Daily Rewards**, el sistema de recompensas diarias de Kick.
Mirás una hora de stream (cualquier canal, acumulado en el día), se te habilita
un botón de reclamo, y una ruleta te revela lo que te tocó: casi siempre un
emote, a veces una insignia, con niveles de rareza
([help.kick.com](https://help.kick.com/en/articles/15715119-daily-rewards-on-kick)).
Se habla de 244 ítems distintos y de tiers hasta Mythic
([win.gg](https://win.gg/kick-daily-rewards-how-they-work/)). Se resetea todos
los días. Kick Support los llama "emotes que ya conocés" al anunciar una
remasterización del sistema
([@kicksupport](https://x.com/kicksupport/status/2079736651887280522)).

### Cómo aparecen en el chat — verificado

Tomé los mensajes recientes de dos canales grandes de Kick y extraje todos los
tokens `[emote:ID:nombre]`. De 13 emotes distintos, **6 eran coleccionables**:

| Nombre | id | Lo que sirve el CDN |
|---|---|---|
| `collectiblesMONKE` | 5748073 | `image/gif`, **947 KB** |
| `collectiblesRAGEY` | 5748013 | `image/webp`, **277 KB** |
| `collectiblesBIGBRAIN` | 5747854 | `image/png`, 5.0 KB |
| `collectiblessadKEK` | 5747946 | `image/png`, 4.4 KB |
| `collectiblescatsittingverycomfortable` | 5747951 | `image/png`, 3.8 KB |
| `collectiblesslayyy` | 5747994 | `image/png`, 2.5 KB |

(El demo del overlay de Chat de CosasStream ya tenía uno capturado sin saberlo:
`[emote:5747909:collectiblespeepoClown]`. Verifiqué que el 5747909 también
responde 200.)

Entonces, respondiendo lo que se preguntó:

- **Cómo aparecen**: como un `[emote:ID:nombre]` idéntico al de cualquier emote
  de Kick. El único rasgo distintivo es que el nombre arranca con
  `collectibles` y que los ids caen en la franja 574xxxx–575xxxx.
- **¿Viajan en el webhook?** Sí. No son un tipo de mensaje aparte ni un campo
  nuevo: van adentro del `content`, así que el webhook oficial
  `chat.message.sent` los trae. *(Esto lo infiero de que el markup es idéntico y
  de que el webhook manda el `content` crudo; no lo pude verificar contra un
  webhook real porque no tengo uno capturado a mano con un coleccionable — es
  la única pieza de esta sección que no probé directamente.)*
- **¿O en el WebSocket tipo Pusher?** También, por el mismo motivo: el
  `ChatMessageEvent` de Pusher lleva el mismo `content`.
- **¿Hay CDN?** Sí, el mismo de siempre:
  `https://files.kick.com/emotes/{id}/fullsize`. Verificado con los seis.

**Consecuencia práctica: no hay que hacer nada.** Tanto
`partirTextoDeKick()` de Sala como el `RE_EMOTE` del overlay de Chat y el del
overlay de Emotes ya los resuelven hoy. Si el dueño mira el chat de su propio
canal y ve coleccionables sin pintar, es un bug de otra cosa, no falta de
soporte.

### Lo que NO se puede, y por qué

**No hay forma soportada de listar los coleccionables.** Lo comprobé así:

- No aparecen en `kick.com/emotes/{slug}`: ni en el grupo del canal, ni en
  `Global`, ni en `Emojis`. Filtré los 162 emotes por `/collectible/i`: cero.
- `https://kick.com/emotes` **sin slug** devuelve **401**. Esa es la lista del
  usuario logueado: por eso pide sesión. Es coherente con que los coleccionables
  sean del *espectador*, no del canal.
- Probé `/api/v1/collectibles`, `/api/v2/collectibles`, `/api/v1/daily-rewards`,
  `/api/v1/rewards`, `/api/v1/user/collectibles` y
  `/api/v2/channels/{slug}/collectibles`: todos 404.
- La API oficial no tiene nada de emotes, mucho menos de coleccionables.

**Qué haría falta para tener un listado**, con el costo real de cada camino:

1. **Sesión del dueño contra `kick.com/emotes`.** Guardar la cookie de sesión de
   la cuenta de Kick del dueño en el servidor y pedirle la lista. Te daría *sus*
   coleccionables, no los de la comunidad. Riesgos: es un endpoint no
   documentado (prohibido por los términos de dev.kick.com, ver sección 6), la
   cookie es una credencial de cuenta completa que habría que guardar cifrada, y
   Kick puede cambiar la forma o cerrarlo sin avisar. **No lo recomiendo.**
2. **Catálogo armado a mano.** Ir juntando los ids y nombres que aparecen en el
   chat y guardarlos en un JSON del repo. Es legal, es estable, y crece solo:
   cada mensaje con un coleccionable nuevo lo agrega. Sirve para un selector o
   para una galería "los que se vieron en esta sala". No sirve para "todos los
   244".
3. **Esperar a que Kick lo publique.** Está en la línea de su API pública, que
   sigue creciendo (el changelog muestra endpoints nuevos cada pocos meses), pero
   el roadmap público no menciona emotes.

**El riesgo de depender de algo no público**, dicho claro: un endpoint no
documentado puede cambiar de forma, mudarse de path, empezar a pedir un header
nuevo o exigir autenticación de un día para el otro, y no hay a quién reclamarle.
Peor: los términos de desarrollador de Kick lo prohíben explícitamente, así que
si además rompe algo, la app del dueño está del lado equivocado del acuerdo. Para
una feature que es un adorno, no vale la pena poner en riesgo la app que maneja
los webhooks del canal.

**Riesgo operativo que sí hay que atender ya**: el peso. Un gif de 947 KB
multiplicado por los 40 emotes que aguanta el overlay son 37 MB de imágenes en
una fuente de navegador de OBS. Aunque el navegador las cachee, un spam de
`collectiblesMONKE` es un problema real de rendimiento en vivo.

---

## 4. 7TV

### Qué está vigente hoy

- **v3 REST (`https://7tv.io/v3`) sigue funcionando.** Verificado hoy: el
  endpoint del usuario de Kick del dueño devuelve 200 y 66 emotes en el set.
- El repo `SevenTV/API`, que es el de la v3, **figura archivado**. Una búsqueda
  lo da como archivado en abril de 2026; *no pude confirmar la fecha exacta
  abriendo el repo*, así que tomalo como "archivado, fecha sin confirmar". Que
  el repo esté archivado no quiere decir que el servicio esté apagado — hoy
  responde.
- **v4 GraphQL (`https://7tv.io/v4/gql`) está vivo.** Verificado con
  introspección: `POST` con `{"query":"{__schema{queryType{name}}}"}` devuelve
  200.

### Cómo pedir el set de un usuario

**v3, Kick** (lo que usa `emotesexternos.js`):

```
GET https://7tv.io/v3/users/kick/{kickUserId}
```

**Ojo con el id, que es el error fácil**: hay que pasar el **user_id** de Kick,
no el channel_id. Para el canal del dueño, `user_id` es 262387 y `channel_id` es
259881. Verificado: con 262387 da **200**; con 259881 da **404**.
`emotesexternos.js` usa `broadcasterUserId` de la API oficial de Kick, que es el
user_id. **Está bien.**

**v3, Twitch**: `GET https://7tv.io/v3/users/twitch/{twitchUserId}` — verificado,
200.

**v4, equivalente** (verificado contra el canal del dueño):

```graphql
query {
  users {
    userByConnection(platform: KICK, platformId: "262387") {
      id
      style { activeEmoteSetId }
    }
  }
}
```

Devuelve el mismo set id que la v3 (`01JTKZK7YMY7GWK0R35JBNNYYT`). El enum
`Platform` tiene `TWITCH`, `DISCORD`, `GOOGLE` y `KICK` (verificado por
introspección). Así que la migración a v4, el día que haga falta, es de una tarde.

### Formatos e imágenes

`https://cdn.7tv.app/emote/{id}/{tamaño}.{formato}`, con tamaños `1x` a `4x`.
Probado sobre un emote animado real:

| Archivo | Resultado |
|---|---|
| `4x.webp` | 200, `image/webp`, 62 KB |
| `4x.avif` | 200, `image/avif`, **36 KB** |
| `4x.gif` | 200, `image/gif`, 90 KB |
| `4x.png` | **404** |
| `2x.webp` | 200, 31 KB |
| `1x.webp` | 200, 13 KB |

AVIF pesa un 42 % menos que el WEBP y anima igual. El navegador de OBS (Chromium
reciente) lo soporta. Es una mejora barata si el peso llega a molestar, pero WEBP
está bien y es lo que ya se usa.

### Límites de uso

Verificado por cabeceras de respuesta:

```
x-ratelimit-global-limit: 5000
x-ratelimit-global-reset: 60
```

5000 pedidos por minuto. Para el uso que le damos (una bajada cada 10 minutos por
canal) sobra muchísimo, incluso con decenas de creadores en Sala.

### EventAPI: enterarse cuando el streamer cambia su set

Existe y funciona con Kick. Endpoints: `wss://events.7tv.io/v3` (WebSocket) y
`https://events.7tv.io/v3` (SSE)
([SevenTV/EventAPI](https://github.com/SevenTV/EventAPI)).

Lo probé con SSE y suscripción en la URL, usando el set del dueño:

```
https://events.7tv.io/v3@emote_set.update<object_id=01JTKZK7YMY7GWK0R35JBNNYYT>
```

Respondió `hello` con `subscription_limit: 500` y después un `ack` de la
suscripción. O sea: **se puede reemplazar el polling de 10 minutos por un push**,
y con una sola conexión alcanza para 500 sets, que en Sala son 500 creadores.

(El README de EventAPI no menciona Kick, pero el ack con un set de un usuario de
Kick lo confirma en la práctica.)

### ¿`emotesexternos.js` está desactualizado?

**Funcionalmente, no.** Lo probé contra el servicio y anda: el id que usa es el
correcto, el fallback por `connections`/`emote_set_id` está bien pensado, y el
orden de preferencia de tamaños webp es razonable.

Tres detalles:

1. **El comentario sobre CORS es falso hoy.** Dice que "la API de 7TV no manda
   cabeceras CORS parejas". Probé con `Origin: https://ejemplo.com` y 7TV
   responde `access-control-allow-origin: https://ejemplo.com`. El *otro* motivo
   del comentario —bajar la lista una vez por servidor en vez de una por overlay
   conectado— sigue siendo perfectamente válido, y es el que importa. Convendría
   corregir el comentario para que no confunda al próximo.
2. **Sólo cubre Kick.** El dueño también tiene canal de Twitch (`lstincho`) y su
   set de 7TV de Twitch no se baja.
3. **Polling en vez de EventAPI.** Ver arriba.

---

## 5. BTTV y FFZ

Los dos son ecosistema de Twitch y **ninguno soporta Kick**. Verificado:
`api.betterttv.net/3/cached/users/kick/262387` → 404, y
`api.frankerfacez.com/v1/room/kick/262387` → 404.

### BTTV

| Qué | URL |
|---|---|
| Emotes de un canal de Twitch | `https://api.betterttv.net/3/cached/users/twitch/{twitchId}` |
| Globales | `https://api.betterttv.net/3/cached/emotes/global` (65 emotes) |
| Imagen | `https://cdn.betterttv.net/emote/{id}/{1x\|2x\|3x}[.webp]` |

La respuesta del canal trae `channelEmotes` y `sharedEmotes` (hay que juntar los
dos; el canal del dueño no tiene ninguno). Cada emote es
`{ id, code, imageType, animated, userId, modifier }` — el campo `animated` dice
si anima, y `code` es el nombre a buscar en el texto. Sin auth, CORS abierto,
`Cache-Control: max-age=300`. Verifiqué que `cdn.betterttv.net/emote/{id}/3x.webp`
devuelve 200 `image/webp`.

### FFZ

| Qué | URL |
|---|---|
| Emotes de una sala de Twitch | `https://api.frankerfacez.com/v1/room/id/{twitchId}` |
| Globales | `https://api.frankerfacez.com/v1/set/global` |
| Imagen | viene armada en el propio emote |

La respuesta trae `{ room, sets }` y cada emote de `sets[*].emoticons` ya incluye
sus URLs:

```json
"urls": { "1": "https://cdn.frankerfacez.com/emote/246878/1",
          "2": "...", "4": "..." }
```

Conviene usar esas URLs tal cual en vez de armarlas: probé
`cdn.frankerfacez.com/emote/246878/4.webp` y devuelve **400**, mientras que
`/emote/246878/4` a secas devuelve 200 `image/png`. Sin auth, `Access-Control-Allow-Origin: *`,
y rate limit declarado en cabecera: `ratelimit-limit: 120` por minuto.

---

## 6. Licencias y reglas

### Twitch

El punto delicado. El Developer Services Agreement dice, sobre lo que Twitch le
licencia a un desarrollador, que *"Program Materials do not include any global
emotes or Cheermotes"* de twitch.tv
([legal.twitch.com](https://legal.twitch.com/legal/developer-agreement/)). O sea:
los emotes globales de Twitch y los Cheermotes están **expresamente fuera** de la
licencia. En la misma línea, las guías de Extensions prohíben usar emotes
globales de Twitch dentro de una extensión
([dev.twitch.tv](https://dev.twitch.tv/docs/extensions/guidelines-and-policies/)).

Qué significa esto en la práctica, con la honestidad de que esto es
interpretación y no asesoramiento legal:

- Los emotes **de suscriptor, de bits y de follower de un canal** son contenido
  del streamer, y Helix los expone justamente para que un desarrollador los
  muestre. Mostrarlos en un chat o en un overlay es el uso previsto.
- Los **globales** (Kappa, PogChamp, LUL) están en una zona gris: Twitch los
  entrega en el payload de EventSub y en `/chat/emotes/global`, pero dice que no
  te los licencia. Media Internet los muestra igual y no conozco casos de
  reclamo, pero eso no es una autorización.

**No pude confirmar la redacción vigente de 2026 palabra por palabra**:
`legal.twitch.com` se arma con JavaScript y lo que devuelve un fetch es la
cáscara HTML, sin el texto del acuerdo. La cita de arriba sale del índice del
buscador sobre esa misma página. Si esto importa para una decisión, conviene
abrirlo en el navegador y leer la cláusula completa.

### Kick

Los términos de dev.kick.com sí los pude leer, y tienen **dos cláusulas que nos
tocan directo**
([dev.kick.com/terms-of-service](https://dev.kick.com/terms-of-service)):

1. **Endpoints no documentados, prohibidos.** *"you will not access undocumented
   Program Materials ... without Kick's prior written permission"*. Esto alcanza
   a `kick.com/emotes/{slug}`, a `kick.com/api/v2/*` y a la idea de scrapear
   coleccionables con una sesión.
2. **El cacheo tiene tope de 24 horas.** Hay que *"cache such information for
   only a twenty-four hour time period without further sharing it with third
   parties"*, y borrar lo que Kick reporte como borrado o vencido.

También prohíben tapar u obstruir las Kick Marks en experiencias embebidas, y
exceder volúmenes razonables de pedidos.

Implicancia concreta: **el TTL de 10 minutos está perfecto** y el tope duro de 24
horas hay que respetarlo si alguna vez se guarda una tabla de emotes en disco o
en el almacén. Un JSON de emotes de Kick versionado en el repo sería una copia
permanente: ahí sí hay que pensarlo.

Aparte, la guía de emotes de Kick pone la responsabilidad del contenido del
emote en el streamer, no en quien lo muestra
([help.kick.com](https://help.kick.com/en/articles/10162055-emote-guide)).

### 7TV

**Sin confirmar.** `7tv.app/legal/terms` es una SPA y devuelve la cáscara: no
pude leer el texto. Lo que sí son datos verificables: la API es pública, no pide
auth, manda CORS abierto y publica su rate limit en cabeceras, y todo el
ecosistema (Chatterino, NipahTV, decenas de bots) la consume así desde hace años.
Eso es un indicio fuerte de que el uso por terceros es el esperado, pero **no es
una autorización leída**. Si al dueño le importa, hay que abrir la página en el
navegador o preguntarles.

### Overlays de OBS

No encontré ninguna regla específica sobre overlays en ninguna de las tres
plataformas. Un overlay de OBS es, desde el punto de vista de los términos, lo
mismo que cualquier otra app de terceros que muestra el contenido: aplican las
mismas cláusulas de arriba y ninguna extra.

---

## 7. Qué se puede hacer con lo que ya hay

### CosasStream

**Ya funciona:**

- Emotes de Kick en el overlay de Chat (tres estrategias: markup, posiciones y
  nombre) y en el de Emotes.
- Coleccionables de Kick, sin saberlo, porque son markup común.
- 7TV del canal de Kick, cacheado 10 minutos, expuesto en
  `/api/emotes-externos` y consumido por el overlay de Emotes.

**Falta:**

- **Twitch.** `Overlays/Chat/chat.js` tiene `https://files.kick.com/emotes/...`
  escrito a mano en `imgEmote()`, y `Overlays/Emotes/emotes.js` lo mismo en
  `URL_EMOTE`. Un mensaje de Twitch se pinta con texto pelado o, peor, si trae
  un id numérico, se lo pide al CDN equivocado.
- **7TV en el overlay de Chat.** Sólo lo usa el de Emotes.
- **Tope de peso** para los coleccionables gordos.

### Sala

**Ya funciona:**

- `deKick()` resuelve markup de Kick, coleccionables incluidos, con índices en
  puntos de código.
- `deTwitch()` arma las URLs del CDN de Twitch correctamente, y `deIrc()` hace lo
  mismo desde los tags de IRC con la conversión de fin inclusivo a exclusivo.
- `paginas/comun/mensajes.js` pinta el array `emotes` sin saber de qué red viene:
  sólo mira `url`, `inicio` y `fin`. **El formato único ya está listo para emotes
  de terceros sin cambiarlo.**

**Falta:**

- **Emotes de terceros, enteros.** No hay nada de 7TV, BTTV ni FFZ. Este es el
  agujero visible: alguien escribe `CHAD` en el chat de Kick y en Sala se ve la
  palabra, mientras que en la web de Kick con la extensión se ve el emote.

---

## 8. Propuesta de diseño

### La pieza central: un módulo de emotes externos, compartido

**Dónde vive.** Los dos repos son Node sin dependencias y ESM, y CosasStream
tiene "cero dependencias" como regla que no se negocia. Así que **no** un paquete
npm: el mismo archivo, copiado en los dos repos, con un comentario arriba que
diga cuál es el original. Propongo que el original viva en **`Sala/servidor/emotes.js`**,
porque Sala es multi-canal y multi-red y el módulo tiene que nacer con esas dos
dimensiones adentro; CosasStream después reemplaza `emotesexternos.js` por una
copia y le pasa un solo canal.

Es exactamente el mismo razonamiento que ya está escrito en `canales.js`: meter
la dimensión "slug" desde el día uno cuesta unas líneas y evita un refactor
entero.

**La interfaz, mínima:**

```
tabla(red, id)        -> Map nombre -> { url, proveedor }
comoObjeto(red, id)   -> lo mismo plano, para mandarlo por HTTP
```

`red` es `'kick'` o `'twitch'`, `id` es el user_id de esa red. La clave del cache
es el par, no una variable de módulo.

**Qué proveedores, por red:**

| red | proveedores |
|---|---|
| `kick` | 7TV |
| `twitch` | 7TV + BTTV + FFZ |

Los globales de cada proveedor se bajan una vez y se comparten entre canales (son
los mismos para todos): esa es una tabla aparte, con su propio TTL.

**Cacheo.** El mismo esquema que ya funciona en `emotesexternos.js` y que no hay
razón para cambiar: TTL de 10 minutos, una sola promesa en vuelo por clave, y si
la bajada falla se devuelve la tabla vieja aunque esté vencida —un emote viejo es
mejor que ninguno—, con reintento a los 60 segundos. Lo único a agregar es un
**tope duro de 24 horas** para cualquier cosa que se persista, por los términos
de Kick.

**Cuándo se refresca.** Dos caminos, y el segundo es opcional:

1. Por TTL, como ahora. Es lo que hay que implementar primero y alcanza.
2. Por push, con la EventAPI de 7TV: una sola conexión SSE a
   `events.7tv.io/v3`, suscripta a `emote_set.update` con el `object_id` del set
   de cada canal. Cuando llega un dispatch, se invalida esa clave y listo. Con
   500 suscripciones por conexión, sobra. **Esto sólo tiene sentido si molesta la
   demora de hasta 10 minutos cuando el streamer agrega un emote en vivo.**

### Cómo entra en el formato único de mensaje

**No hay que cambiar el formato.** El array `emotes: [{ id, inicio, fin, url }]`
ya sirve tal cual. Lo que se agrega es un paso más en el pipeline:

```
webhook/EventSub -> deKick()/deTwitch() -> resolverExternos() -> bus -> SSE
```

`resolverExternos(mensaje)` hace:

1. Pide `tabla(mensaje.red, idDelCanal)`.
2. Recorre `[...mensaje.texto]` (puntos de código, **nunca `.split(' ')` sobre el
   string crudo**) partiendo por espacios, y anota inicio y fin de cada palabra
   en puntos de código.
3. Descarta las palabras que caen adentro de un rango ya ocupado por un emote
   nativo — si no, el nombre que `partirTextoDeKick()` dejó en el texto se
   resolvería de nuevo como si fuera un emote de 7TV. El overlay de Emotes ya
   tiene este cuidado (saca los tokens antes de partir en palabras); acá hay que
   hacerlo con los rangos, porque el markup ya no está.
4. Por cada match, agrega `{ id, inicio, fin, url, fuente }`.
5. **Reordena `emotes` por `inicio`.** Esto es obligatorio:
   `agregarTextoConEmotes()` de `paginas/comun/mensajes.js` recorre el array de
   corrido con un cursor y asume que viene ordenado y sin solapamientos. Un
   array desordenado no tira error, pinta mal y es de esos bugs que cuestan una
   tarde.

**Un campo nuevo, `fuente`** (`'kick' | 'twitch' | '7tv' | 'bttv' | 'ffz'`), es
aditivo: el cliente viejo lo ignora y el nuevo lo puede usar para un `title` que
diga de dónde salió el emote. Opcional.

**Los nombres distinguen mayúsculas.** 7TV trata `CHAD` y `chad` como emotes
distintos, y `emotesexternos.js` ya lo respeta. Hay que seguir usando un `Map`
con la clave exacta, sin `toLowerCase()`.

### Cómo lo pinta el chat

**Sin cambios.** `paginas/comun/mensajes.js` ya crea un `<img class="emote">` con
`emote.url` y el texto original como `alt`. Un emote de 7TV entra por el mismo
camino que uno de Kick. Esto es exactamente el pago del diseño del formato único.

Lo único a considerar es CSS: los emotes de 7TV **no son cuadrados** (228x128 es
un tamaño común). Si el CSS fija ancho y alto, se aplastan. Hay que fijar el alto
y dejar el ancho en `auto`, que es lo que ya hace el overlay de Emotes de
CosasStream con su cálculo de proporción.

### Cómo lo usa el overlay de Emotes de CosasStream

Hoy `delMensaje()` re-parsea el markup de Kick con su propia regex y después
busca palabra por palabra en la tabla de 7TV. Eso duplica lógica que el servidor
ya tiene.

**Propuesta:** que el servidor mande el mensaje con el array `emotes` ya
resuelto (el mismo que Sala) y que el overlay se limite a
`m.emotes.map(e => e.url)`. Menos código en el overlay, una sola implementación,
y gratis quedan soportados Twitch y los proveedores nuevos.

**Y el tope de peso**, que es el arreglo nuevo que pide el hallazgo de los
coleccionables. Dos opciones, de menor a mayor esfuerzo:

- Bajar `maxPorMensaje` y `maxEnPantalla`. Es un parámetro del panel, cero
  código.
- Antes de soltar el emote, un `HEAD` al CDN y descartar si pasa de N KB. Cuesta
  un pedido extra por emote nuevo; con un `Set` de ids ya vistos se paga una sola
  vez por emote.

### Lo implementable, ordenado por valor sobre esfuerzo

| # | Qué | Dónde | Esfuerzo | Valor |
|---|---|---|---|---|
| 1 | **Nada**: confirmar que los coleccionables de Kick ya se pintan y anotarlo | los dos | cero | alto (era la duda principal) |
| 2 | Emotes de **Twitch** en los dos overlays de CosasStream | `Overlays/Chat`, `Overlays/Emotes` | bajo | alto: hoy no se ven |
| 3 | Tope de peso/animación para coleccionables gordos | `Overlays/Emotes` | bajo | alto: evita un problema en vivo |
| 4 | Corregir el comentario de CORS de `emotesexternos.js` | CosasStream | trivial | medio: evita que el próximo decida mal |
| 5 | **7TV en Sala**, con el módulo compartido y `resolverExternos()` | `Sala/servidor` | medio | alto: es el agujero visible del multichat |
| 6 | 7TV del canal de **Twitch** del dueño, además del de Kick | los dos | bajo | medio |
| 7 | **BTTV + FFZ** para Twitch | `Sala/servidor/emotes.js` | medio | medio: más cobertura, misma forma |
| 8 | EventAPI de 7TV en vez de polling | `Sala/servidor/emotes.js` | medio | bajo: ahorra 10 minutos de demora |
| 9 | Catálogo propio de coleccionables, que se llena solo con lo que pasa por el chat | `Sala/servidor` | medio | bajo: sólo si se quiere un selector |
| 10 | Listado completo de coleccionables de Kick | — | alto | **no hay camino soportado. No hacer** |

---

## 9. Preguntas abiertas para el dueño

1. **Coleccionables: ¿el problema era mostrarlos o listarlos?** Si era mostrarlos,
   ya está resuelto y hay que ver por qué no se ven (¿se ven mal en algún lado en
   particular?). Si era listarlos o hacer un selector, la respuesta es que no hay
   forma soportada y hay que elegir entre el catálogo propio y no hacerlo.
2. **¿Cuál es el user_id de Twitch del dueño (`lstincho`)?** Lo necesito para
   verificar su set de 7TV, BTTV y FFZ. Verifiqué el de Kick (262387) pero el de
   Twitch no lo tengo.
3. **¿Qué tan importante es que Sala muestre emotes de 7TV?** Es el ítem 5 y es
   el más caro de los que valen la pena. Si el chat de Sala lo mira poca gente,
   quizá conviene primero el ítem 2, que es de CosasStream y se ve en el stream.
4. **¿Los emotes globales de Twitch son un problema?** El acuerdo de
   desarrollador dice que no están licenciados. Todo el mundo los muestra igual.
   ¿Querés que los pintemos, que los dejemos en texto, o que lo consultes con
   alguien antes?
5. **¿Alguna vez se pensó persistir la tabla de emotes en disco o en el almacén?**
   Si sí, hay que meterle el tope de 24 horas por los términos de Kick.
6. **¿El overlay de Emotes tiene que seguir teniendo su propia lógica de parseo,
   o lo podemos simplificar a consumir el array del servidor?** Es un cambio de
   comportamiento chico pero toca un overlay que está en la colección real de OBS.
7. **¿Conviene la EventAPI de 7TV?** Sólo si te molesta esperar hasta 10 minutos
   para que aparezca un emote que acabás de agregar. Si no, no.
8. **¿Queremos que el chat diga de dónde viene cada emote** (el campo `fuente`),
   o es ruido?

---

## 10. Lo que no pude confirmar

Para que quede explícito y nadie lo tome por verificado:

- **El texto vigente del Twitch Developer Services Agreement.**
  `legal.twitch.com` se arma con JavaScript y devuelve la cáscara HTML. La cita
  sobre emotes globales sale del índice del buscador sobre esa página, no de
  haberla leído entera.
- **Los términos de 7TV.** `7tv.app/legal/terms` es una SPA y pasa lo mismo.
- **La fecha en que se archivó `SevenTV/API`** (la v3). Aparece como abril de
  2026 en una búsqueda; no lo abrí para confirmarlo. El servicio responde hoy.
- **Un webhook real de Kick con un coleccionable adentro.** Verifiqué que el
  markup llega idéntico en los mensajes del chat (vía la API de mensajes de la
  web) y que el CDN los sirve, pero no capturé un `chat.message.sent` con uno.
  La inferencia es fuerte —el webhook manda el `content` crudo y el markup es el
  mismo— pero es una inferencia.
- **Si la EventAPI de 7TV mantiene el soporte de Kick a largo plazo.** El README
  no lo menciona; el ack de mi suscripción con un set de Kick sí lo demuestra hoy.
- **El rate limit exacto de los endpoints de emotes de Helix.** El límite general
  es 800 puntos/min; si esos endpoints tienen un costo distinto al de 1 punto, no
  lo encontré documentado.

---

## Fuentes

**Twitch**
- [EventSub Subscription Types](https://dev.twitch.tv/docs/eventsub/eventsub-subscription-types/)
- [Sending and Receiving Chat Messages](https://dev.twitch.tv/docs/chat/send-receive-messages/)
- [Getting Twitch Emotes](https://dev.twitch.tv/docs/irc/emotes/)
- [API Reference](https://dev.twitch.tv/docs/api/reference/)
- [Twitch API Concepts (rate limits)](https://dev.twitch.tv/docs/api/guide)
- [Developer Services Agreement](https://legal.twitch.com/legal/developer-agreement/)
- [Extensions Guidelines & Policies](https://dev.twitch.tv/docs/extensions/guidelines-and-policies/)
- [Working with Emotes (foro de devs)](https://discuss.dev.twitch.com/t/working-with-emotes/42012)

**Kick**
- [Event Types (webhooks)](https://docs.kick.com/events/event-types)
- [Documentación completa](https://docs.kick.com/llms-full.txt)
- [Términos de servicio para desarrolladores](https://dev.kick.com/terms-of-service)
- [Daily Rewards](https://help.kick.com/en/articles/15715119-daily-rewards-on-kick)
- [Emote guide](https://help.kick.com/en/articles/10162055-emote-guide)
- [Kick Daily Rewards, cómo funcionan (win.gg)](https://win.gg/kick-daily-rewards-how-they-work/)
- [KICK Support sobre la remasterización de daily rewards](https://x.com/kicksupport/status/2079736651887280522)

**7TV**
- [SevenTV/API](https://github.com/SevenTV/API)
- [SevenTV/EventAPI](https://github.com/SevenTV/EventAPI)
- [Términos de servicio](https://7tv.app/legal/terms) *(no legible sin navegador)*

**BTTV / FFZ**
- Verificados directamente contra `api.betterttv.net`, `cdn.betterttv.net`,
  `api.frankerfacez.com` y `cdn.frankerfacez.com`.
