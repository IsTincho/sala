# Los emotes de Kick en el selector: qué cambió y qué se puede hacer

Fecha: **2026-09-25**. Encargo del dueño: el selector de la caja arranca vacío
porque sólo ofrece los emotes de Kick que ya pasaron por ese chat; ¿hay forma de
conseguir la lista completa?

**Esto es una investigación, no un plan aprobado. No se implementó nada.**

Lo verificado el 2026-09-22 está en `INVESTIGACION-EMOTES.md` y no se repite:
acá va sólo **lo que cambió, lo que faltaba y lo que el dueño preguntó de nuevo**.

---

## Respuesta corta

No apareció nada nuevo. La API oficial sigue sin emotes, el pedido de la
comunidad sigue sin una sola respuesta, y el endpoint que sí los lista sigue
siendo el no documentado —el mismo que los términos de Kick prohíben tocar—.
**Lo que cambió es lo que sabemos de quién lo usa: nadie lo llama desde un
servidor con una app registrada. Lo llaman extensiones de navegador y apps de
escritorio, o sea desde la máquina de cada persona, sin poner en juego las
llaves de nadie.**

Recomendación: **no scrapear**. Mantener la lista viva que ya funciona y, si el
dueño quiere que el selector arranque lleno, agregar la opción 3 (el creador
pega su lista una vez). La diferencia de riesgo no la paga un selector.

---

## Lo que se volvió a verificar hoy

| Pregunta | Al 2026-09-22 | Al 2026-09-25 |
|---|---|---|
| ¿Endpoint oficial de emotes en `docs.kick.com`? | No | **Sigue sin haberlo.** La doc completa (`llms-full.txt`) lista Categories, Users, Channels, Channel Rewards, Chat, Moderation y Livestreams. Ni uno de emotes. La API sí creció (`/public/v2/categories`, `/public/v2/livestreams`, Channel Rewards): no es que esté congelada, es que los emotes no están en el plan |
| ¿Changelog? | Última entrada 11/08/2026 | **La misma, 11/08/2026** (`active_subscribers_count`). Nada de emotes |
| ¿Algo sobre coleccionables? | Nada | **Nada**, por ningún lado de la doc oficial |
| Pedido de la comunidad [KickDevDocs#323](https://github.com/KickEngineering/KickDevDocs/issues/323) | Abierto desde 29/12/2025, sin respuesta | **Abierto, con cero comentarios.** Nueve meses y nadie de Kick contestó. Pide exactamente lo que necesitamos: `GET /v1/emotes` con `broadcaster_user_id` opcional |
| `kick.com/emotes/<slug>` | Existe, devuelve 3 grupos (canal, `Global`, `Emojis`), pide User-Agent de navegador | **No lo volví a probar, a propósito** (ver abajo). Sigue vivo según el código de terceros que lo usa hoy |

### Por qué no volví a pegarle al endpoint

Porque pegarle *es* la cosa que estamos evaluando si conviene hacer. Los
términos no distinguen entre "lo probé una vez para ver si existía" y "lo uso en
producción": hablan de **acceder**. Ya está verificado del 22/09 y hay código
público de terceros que lo llama hoy; no hacía falta un pedido más para
contestar la pregunta.

**Qué pide**, según el código de quienes lo usan y la auditoría pública de OBS
Blade: un `User-Agent` de navegador (con el de `curl` da 403, es Cloudflare
adelante), sin token, sin scopes. Los límites de pedidos **no están publicados**:
"Numeric rate limits are unpublished; handle 429"
([obs_blade/docs/kick-chat-audit.md](https://github.com/Kounex/obs_blade/blob/master/docs/kick-chat-audit.md)).

---

## Qué dicen los términos, textual

De [dev.kick.com/terms-of-service](https://dev.kick.com/terms-of-service),
leído el 2026-09-25. Las cuatro cláusulas que tocan esto, con su sección:

1. **§10.1, Developer Representation and Warranties** — *"you will not access
   undocumented Program Materials or otherwise attempt to derive or use the
   underlying source code of undocumented Program Materials without Kick's prior
   written permission."*
   `kick.com/emotes/<slug>` no está en el Kick Developer Site: es material no
   documentado. Sin permiso escrito, tocarlo es incumplir esta cláusula.

2. **§3.5, App Acceptance Criteria** — *"The App must not be developed with the
   intent to exploit, deceive, or harm Kick or its users, including but not
   limited to malicious activities such as data scraping, fraud, or unauthorised
   data collection…"*
   Acá "data scraping" aparece con nombre y apellido, atado a la intención de
   perjudicar. Se puede discutir que pedir una lista pública de emotes no
   perjudica a nadie; no es una discusión que uno quiera tener con quien decide
   sin tener que explicar por qué.

3. **§3.6, Developer Accounts** — no *"use the Program Materials or Kick
   Developer Site in a manner that exceeds reasonable request volume or
   velocity, or constitutes excessive or abusive usage."* Y, en la misma
   sección: *"Kick maintains the right to revoke your Keys for any reason or no
   reason at all, at any time."*

4. **Schedule 1, §C, Storage of Program Materials** — *"cache such information
   for only a twenty-four hour time period without further sharing it with third
   parties."* Es la de siempre: cualquier lista que se guarde vence a las 24 h y
   no se re-reparte. Los vistos de hoy caducan a las 12 h, así que entran.

Y la de terminación, **§8.2**: *"Kick may immediately terminate or suspend this
Agreement, any rights granted herein, and/or your license to the Program
Materials or access to the Kick Developer Site, at its sole discretion at any
time, for any reason or no reason at all, with or without advance notice."*

---

## El riesgo concreto: ¿qué se cae?

**Se cae la app, y con la app se cae el multichat de todos los colegas.** No es
una cuenta personal.

- El castigo que nombra el acuerdo es sobre **las llaves y la licencia** (§3.6 y
  §8.2), no sobre el canal de nadie. Del canal personal del dueño el acuerdo de
  desarrollador **no dice nada** (ese lo gobiernan los términos del sitio, que
  son otro documento).
- Pero las llaves son **una sola app para todo el servicio**: los webhooks de
  Kick de cada creador que se da de alta se suscriben con la app del dueño
  (`GUIA.md`, sección 3: *"las apps de Kick y de Twitch son las tuyas"*). Si Kick
  revoca esas llaves, **el chat de Kick se apaga para todos los colegas a la
  vez**, en lectura y en escritura, y no hay plan B: a diferencia de Twitch, que
  tiene IRC como respaldo, Kick sólo entra por webhook.
- **§8.4**: *"Upon termination of this Agreement, all licenses granted herein
  immediately expire and you must cease use of all Program Materials, and delete
  all Kick Data."* El acuerdo no dice una palabra sobre qué pasa con los
  usuarios de la app. Se apaga y listo.
- Hay un agravante de momento: el tope de 1.000 canales de una app sin verificar
  obliga a **pedirle a Kick la verificación** antes de los 500
  (`GUIA.md`, sección 4). Estar del lado equivocado del acuerdo justo cuando hay
  que pedir un favor es el peor momento posible.

No encontré **ni un caso público** de alguien a quien Kick le haya revocado las
llaves por esto. Tampoco encontré a nadie que lo esté haciendo desde un servidor
con app registrada, que es la única forma en que nos encontrarían: lo que se ve
es todo del lado del cliente (abajo). Ausencia de evidencia, no evidencia de
ausencia.

---

## Cómo lo hacen los demás

Buscado en el código de verdad, no en los blogs (`gh search code`).

| Quién | Qué hace con los emotes nativos de Kick | Desde dónde |
|---|---|---|
| **7TV** (extensión) | Los lista: `fetch("https://kick.com/emotes/" + username)` en su menú de emotes ([`EmoteMenuModule.vue`](https://github.com/SevenTV/Extension/blob/master/src/site/kick.com/modules/emote-menu/EmoteMenuModule.vue)) | **El navegador de cada persona**, en kick.com. Es una extensión: corre en el sitio, con la sesión de esa persona, sin app registrada |
| **NipahTV** (extensión) | Lo mismo: `RESTFromMainService.get("https://kick.com/emotes/" + channelName)` ([`KickEmoteProvider.ts`](https://github.com/Xzensi/NipahTV/blob/master/src/Sites/Kick/KickEmoteProvider.ts)) | Ídem. El pedido sale del *service worker* de la extensión |
| **OBS Blade** (app de celular) | Selector de emotes con `GET /emotes/{slug}` → secciones Channel/Global/Emojis | **El teléfono del streamer** |
| **multistream** (app de escritorio) | `emotesUrl: (channel) => "https://kick.com/emotes/" + channel` | **La máquina de cada persona** |
| **Streamer.bot** | Kick entra **por webhooks oficiales**. Sus disparadores de emotes son de 7TV, no de Kick | Servidor/PC, con la API oficial |
| **Botrix** | Trabaja con el markup `[emote:id:nombre]` en los mensajes, igual que nosotros. No encontré que liste nada | — |
| **Firebot** | No soporta Kick: es sólo Twitch | — |

**El patrón es el hallazgo.** Todos los que listan emotes de Kick lo hacen
**desde el dispositivo de la persona** —extensión o app instalada—, donde no hay
app registrada, no hay llaves que revocar y el pedido es indistinguible del que
hace la propia web de Kick. Ninguno lo hace desde un servidor. Nosotros somos un
servidor: el mismo pedido, hecho por nosotros, tiene otro apellido.

Y no alcanza con mudarlo al navegador del espectador: nuestra página vive en
`multichat-osmiumstudio.pages.dev`, otro origen. Las extensiones pueden saltear
la política de origen cruzado y una app de escritorio no la tiene; **una página
web no**. Salvo que Kick mande `Access-Control-Allow-Origin` en ese endpoint
—cosa que nadie necesita y que no verifiqué—, el navegador del espectador no
podría leer la respuesta. Que las extensiones tengan que rutear el pedido por su
service worker es un indicio fuerte de que no la manda.

---

## Las opciones, con lo que cuesta cada una

| # | Opción | Qué da | Qué cuesta | Riesgo | ¿Viola los términos? |
|---|---|---|---|---|---|
| 1 | **Dejarlo como está**: la lista viva, los que pasaron por ese chat | Lo que la comunidad usa de verdad, coleccionables incluidos (no se listan en ningún lado). Arranca vacía | Cero: ya está hecho y probado | Ninguno | No |
| 2 | **Scrapear `kick.com/emotes/<slug>` desde el servidor** | La lista completa del canal + `Global` + `Emojis` (162 emotes en el canal del dueño). Sin coleccionables | Un módulo con caché de ≤24 h, User-Agent de navegador, manejo de 429 y de que cambie la forma sin aviso | **Alto, y no es nuestro**: si Kick revoca las llaves se apaga el chat de Kick de todos los colegas, sin plan B | **Sí**, §10.1. Y §3.5 nombra "data scraping" |
| 3 | **Que el creador pegue su lista una vez** | Los emotes de su canal, desde el día uno, sin esperar a que alguien los use | Un campo en el panel (pegar el JSON que ve en `kick.com/emotes/<su-slug>` estando logueado, o cargar nombre+id a mano) y guardarlo en su documento. Medio día | Bajo. Lo pide **su** navegador, con **su** sesión, en **su** canal: no hay app de por medio | No. El dato lo trae la persona dueña del canal, como quien pega su propio link |
| 4 | **Pedirle permiso a Kick por escrito** | Lo mismo que 2, pero legal | Un mail y esperar. §10.1 admite el permiso previo por escrito | Ninguno mientras no contesten | No |
| 5 | **Apoyarse en 7TV** | Ya está hecho y anda | — | — | No |
| 6 | **Esperar** a #323 | La lista, bien | Nueve meses sin una respuesta | Ninguno | No |

### Detalle de la 3, que es la única que agrega algo

El creador entra a `kick.com/emotes/<su-slug>` en su navegador (logueado, es su
canal), copia lo que ve y lo pega en el panel. El servidor valida la forma
(`{ id, name }`), se queda con nombre e id y arma la lista. Después eso alimenta
el selector igual que los vistos.

Tres cosas que hay que decidir antes de escribir una línea, y por eso esto no se
hizo:

- **Vence a las 24 h** (Schedule 1 §C). O se le pide al creador que lo repegue
  —ridículo— o se acepta que es una lista que envejece. Lo honesto es mostrar
  desde cuándo es y dejar el botón de actualizar.
- **Es contenido de Kick guardado por nosotros.** Guardarlo en el documento del
  creador y no en el repo (un JSON versionado sería una copia permanente *y* una
  redistribución).
- **Quién lo pega.** Si lo pega cualquiera, es una lista de emotes de otro canal
  metida en el tuyo. Tiene que ser el creador, con su cookie, sobre su sala.

---

## Lo que no pude confirmar

- **Si `kick.com/emotes/<slug>` sigue devolviendo lo mismo hoy.** No lo probé a
  propósito (explicado arriba). La evidencia de que sigue vivo es indirecta:
  código de terceros que lo llama y está mantenido.
- **Si ese endpoint manda CORS abierto.** El razonamiento de arriba dice que casi
  seguro no, pero es una inferencia.
- **Si alguna vez Kick revocó llaves por esto.** No hay casos públicos; tampoco
  hay forma de saber si los hubo en privado.
- **El texto completo del acuerdo.** Las citas son verbatim y con su sección,
  pero leí las cláusulas que importan, no las 40 páginas.
