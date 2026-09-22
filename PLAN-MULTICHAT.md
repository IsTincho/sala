# Plan: Multichat por sala — el streamer lo abre, los espectadores lo usan

Fecha: 2026-09-22. Estado: **5.1 a 5.4 construidas**. El chat abierto se lee sin login, se
escribe con la cuenta de cada quien —Kick, Twitch o las dos—, el creador puede bloquear a
alguien en esta herramienta, los tokens de quien no vuelve se borran solos a los 60 días y
cada sala se instala como app. Ver la BITACORA del 2026-09-22. **La 5.5 queda afuera de
este plan**, por decisión del dueño.
Complemento de [PLAN.md](PLAN.md), que sigue mandando sobre todo lo demás.

---

## 0. La idea en una línea

Hoy `/chat` es la ventana del creador: ve Kick y Twitch juntos y escribe con
**su** cuenta. La idea es que cada creador pueda **abrir** esa ventana a su
comunidad: un link `/chat/<slug>` que le pasa a sus espectadores, donde cada uno
conecta **su** Kick y/o **su** Twitch y escribe con **su** cuenta en el chat
real de cada red.

```
Creador:     /crear → entra con Kick → vincula Twitch → "abrir mi chat" → copia el link
Espectador:  abre /chat/istincho → lee los dos chats → "Conectar Kick" / "Conectar Twitch" → escribe
```

---

## 1. Qué ya existe (no se rehace)

| Pieza | Dónde | Sirve para |
|---|---|---|
| Alta de creadores con Kick, planes, `/panel` | `creadores.js`, `/crear` | el lado del streamer, casi entero |
| Vincular Twitch del creador + EventSub WS + plan B IRC | `twitch.js`, `irc.js`, `vinculos.js` | leer el Twitch de cada sala |
| Webhook de Kick ruteado por sala | `webhook.js`, `creadores.js` | leer el Kick de cada sala |
| Espectador que entra con Kick y escribe en el chat real | `espectadores.js`, `/api/sala/:slug/chat` | escribir en Kick como espectador |
| Frenos de envío (tope Kick, 429 del canal, 1 cada 2 s) | `espectadores.js` | se reusan tal cual |
| Formato único de mensaje y el render | `mensajes.js`, `paginas/comun/mensajes.js` | pintar los dos chats igual |
| Filtro de redes **por conexión, en el servidor** | `canales.js`, `leDaEl` | decidir qué red ve cada espectador |
| Tokens cifrados, cookies `sala_dueno` / `sala_espectador` | `cifrado.js`, `sesion.js` | sesiones separadas |

O sea: **el streamer ya se registra y vincula sus cuentas.** Lo nuevo es el lado
del espectador en el Chat Global y que el espectador pueda sumar **Twitch**.

---

## 2. Lo que falta

1. **`/chat/<slug>`**: el Chat Global de una sala, abierto al público si el
   creador lo habilitó. Hoy `/chat` sin sesión de dueño sólo recibe Kick.
2. **Interruptor en el panel**: "Chat abierto a mi comunidad" (apagado por
   defecto) y qué redes muestra: Kick, Twitch o las dos.
3. **El espectador vincula Twitch**: OAuth con `user:write:chat`, token
   cifrado, "Salir" lo borra. Hoy el espectador sólo puede tener Kick.
4. **Envío a Twitch como espectador**: `POST helix/chat/messages` con
   `broadcaster_id` = el del creador y `sender_id` = el del espectador.
5. **Moderación propia mínima**: el creador puede bloquear a alguien **en esta
   herramienta** y cerrar el chat al toque.
6. **(Opcional, fase aparte) Creadores que sólo usan Twitch.** Hoy el slug de
   una sala **es** el slug de Kick. Ver sección 6.

---

## 3. Cómo funciona

### El espectador

- **Leer no pide login.** Abrís el link y ves el chat. Mismo criterio que la
  Sala: el chat ya es público en kick.com y twitch.tv.
- **Escribir pide la cuenta de esa red.** Botones "Conectar Kick" y "Conectar
  Twitch". El selector de envío muestra sólo las redes que conectaste: con Kick
  sólo, escribís sólo a Kick. Con las dos, elegís Kick, Twitch o **las dos**.
- **Una cuenta de espectador sirve para todas las salas.** La cookie es del
  dominio, así que quien conectó Kick en `/chat/istincho` ya está conectado en
  `/chat/otrocreador`. Es lo que la gente espera de un "multichat".
- **Qué se guarda:** por red, `user_id`, nombre y tokens cifrados. Nada más.
  Ni lista de salas visitadas ni "quién está conectado ahora" visible para nadie.
- **Salir** borra los tokens de las dos redes, no sólo la cookie (igual que hoy
  con Kick).

Modelo (colección `espectadores`, se extiende la que hay):

```json
{
  "_id": "esp_…",
  "kick":   { "userId": 123, "nombre": "unaespectadora", "tokens": "<cifrado>", "scopes": "user:read chat:write" },
  "twitch": { "userId": "456", "login": "unaespectadora", "tokens": "<cifrado>", "scopes": ["user:write:chat"] },
  "creado": "…", "ultimoUso": "…"
}
```

Con una red conectada y la otra no, el campo de la otra no existe.

> **Cómo quedó construido** (5.3): el `_id` es `esp_…` al azar, como dice el modelo, y
> los espectadores que ya estaban —que se guardaban en `tokens` bajo
> `espectador:<user_id de Kick>`— se migran al leerlos **conservando ese id viejo**,
> porque sus cookies están en navegadores ahora mismo. Cada red guarda además `login` y
> el momento en que se conectó. Dos navegadores son dos espectadores: ver la BITACORA.

### El creador

En `/panel`, bloque nuevo **"Chat para tu comunidad"**:

| Ajuste | Qué hace |
|---|---|
| Abierto / cerrado | Cerrado: `/chat/<slug>` muestra "este chat está cerrado" y los envíos rebotan con 403. **Corte de verdad, en el servidor.** |
| Redes que se ven | Kick, Twitch o las dos. Se aplica en `leDaEl`, por conexión: la red que no se comparte **no sale por el cable** |
| Link para copiar | `https://<dominio>/chat/<slug>`, con botón "copiar" y QR |
| Bloqueados | Lista de gente bloqueada en esta herramienta, por red + id. Se bloquea desde el menú de un mensaje en `/chat` |

Ajustes en el documento del creador:

```json
"chatAbierto": { "activo": false, "redes": ["kick", "twitch"], "bloqueados": [{ "red": "kick", "id": 123 }] }
```

### Quién puede qué en `/chat/<slug>`

| Quién | Ve | Escribe |
|---|---|---|
| Cualquiera sin sesión | las redes que el creador abrió | nada |
| Espectador con Kick | ídem | a Kick, con su cuenta |
| Espectador con Twitch | ídem | a Twitch, con su cuenta |
| Espectador con las dos | ídem | a una o a las dos |
| El creador (cookie de dueño de **esa** sala) | las dos, siempre | con su cuenta, como hoy en `/chat` |
| Bloqueado por el creador | ídem | nada: 403 con "el creador te bloqueó en este chat" |

**El slug sale del camino de la URL, nunca de un parámetro ni del cuerpo.**
Regla de la casa: cada sala es un inquilino.

### Rutas nuevas

| Ruta | Qué es |
|---|---|
| `GET /chat/:slug` | La página. 404 si la sala no existe; "cerrado" si existe y no la abrió |
| `GET /eventos/:slug` | Ya existe. Cambia qué redes le da a una conexión sin cookie de dueño: las de `chatAbierto.redes` si está abierto, sólo Kick si no (como hoy, la Sala depende de eso) |
| `POST /api/chat/:slug/enviar` | `{ red: "kick"\|"twitch"\|"ambas", texto }` con cookie de espectador. Pasa por los mismos frenos que `/api/sala/:slug/chat` |
| `GET /api/chat/:slug/yo` | Qué redes tiene conectadas esta persona y si puede escribir en esta sala. Nunca quién más está |
| `GET /oauth/twitch/entrar?rol=espectador` | Nuevo rol en el OAuth de Twitch. **Mismo redirect** que ya está registrado: no hay que tocar la app de Twitch |
| `POST /api/espectador/salir` | Borra los tokens de las dos redes |
| `POST /api/panel/chat` | Abrir/cerrar, redes, bloquear/desbloquear. Cookie de creador |

`/chat` a secas sigue siendo la ventana del creador logueado, como hoy.

### El envío a Twitch

- `POST https://api.twitch.tv/helix/chat/messages` con el token **del
  espectador**, `broadcaster_id` del creador y `sender_id` del espectador.
- **Un 200 no significa que salió.** Hay que leer `is_sent` y `drop_reason`
  (baneado, modo sólo-seguidores, AutoMod, slow mode). El motivo se le muestra a
  la persona tal cual lo da Twitch. Ya está anotado en la BITACORA de la Fase 1.
- Los baneos, el slow mode y el AutoMod de cada plataforma **se aplican solos**:
  el mensaje sale como de esa persona, así que Twitch y Kick la tratan igual que
  si escribiera desde su web. La moderación propia de acá es un agregado, no un
  reemplazo.
- El mensaje **no se difunde por el bus al enviarlo**: vuelve por EventSub como
  cualquier otro. Mismo criterio que la Sala.

### Leer Twitch de muchas salas

Cada sala con Twitch vinculado ya tiene su conexión EventSub con el token del
creador (`channel.chat.message`, costo 0). Un proceso Node aguanta cientos de
conexiones sin problema. Si algún día pasan de unas doscientas salas con
Twitch, conviene pasar a **Conduits** (una sola tubería con token de app para
todos los canales). No hace falta para arrancar: anotado como riesgo.

---

## 4. Seguridad y abuso

- **CSRF:** los `POST` de envío exigen cookie `SameSite=Lax` **y** que el
  `Origin` sea el nuestro. Una página ajena no puede hacer escribir a alguien en
  un chat.
- **Scopes mínimos del espectador:** Kick `user:read chat:write` (ya es así),
  Twitch sólo `user:write:chat`. Leer no necesita nada del espectador porque el
  chat entra con el token del creador.
- **Frenos:** 1 mensaje cada 2 s por persona y por sala, y "las dos" cuenta como
  uno. Encima está el límite de cada plataforma (en Twitch, 20 mensajes cada 30 s
  para quien no es mod).
- **El creador corta en un click.** Cerrar el chat corta los envíos en el
  servidor, no sólo esconde la caja.
- **Nada de listas de presentes.** Se puede mostrar un número ("12 conectados")
  pero nunca quiénes.
- **Tokens de espectadores** con el mismo cifrado de siempre. Un espectador que
  no vuelve en 60 días pierde los tokens solo: guardar credenciales de gente
  que no usa el servicio es riesgo sin beneficio.
- **Términos:** `/terminos` tiene que decir qué se guarda del espectador y cómo
  borrarlo. Es texto, pero va antes de abrir esto a otros creadores.

### Twitch y el stream

`/chat/<slug>` es para que la comunidad lo use **fuera** del stream. El creador
**no** debería meterlo como fuente en OBS si transmite a Twitch: las reglas de
simulcast prohíben mostrar en el stream un chat combinado con otras plataformas.
El panel lo avisa al lado del link.

---

## 5. Fases

Cada fase se prueba sola y deja algo usable.

### Fase 5.1 — Chat abierto, sólo lectura — **CONSTRUIDA**

`/chat/:slug`, el interruptor del panel, las redes a compartir y el filtro en
`leDaEl`. La página es la de `/chat` con la caja de escribir escondida.

**Verificación:** con el chat cerrado, `curl /eventos/<slug>` no trae Twitch.
Abierto con las dos redes, sí. Una sala que no lo abrió muestra "cerrado", y
una que no existe da 404.

### Fase 5.2 — El espectador escribe en Kick — **CONSTRUIDA**

`POST /api/chat/:slug/enviar` con `red: "kick"`, reusando el camino de
`/api/sala/:slug/chat`. Botón "Conectar Kick" en `/chat/:slug`.

**Verificación:** desde otro navegador con una cuenta secundaria de Kick,
escribís en `/chat/istincho` y aparece en kick.com/istincho con esa cuenta.

### Fase 5.3 — El espectador conecta Twitch y escribe ahí — **CONSTRUIDA**

OAuth de Twitch con `rol=espectador`, token cifrado, `red: "twitch"` y
`"ambas"`, `is_sent`/`drop_reason` mostrados a la persona, y un "Salir" que
borra las dos redes.

**Verificación:** con una cuenta secundaria de Twitch escribís y sale en
twitch.tv/lstincho. Esa cuenta, baneada en Twitch, ve el motivo en pantalla y
no un "enviado". Con "las dos" sale en los dos chats. Después de "Salir", los
tokens ya no están en Mongo.

> **Esa verificación está pendiente**: las dos fases se probaron con dobles de `fetch` y
> a mano en un servidor local, pero ninguna tocó todavía la API real de Twitch. La lista
> exacta de lo que sólo se ve en producción está en la BITACORA del 2026-09-22.

### Fase 5.4 — Moderación propia y cierre — **CONSTRUIDA**

Bloquear desde el menú del mensaje, la lista de bloqueados en el panel, el
vencimiento de 60 días, el contador de conectados, el QR, los términos y el
manifest de la PWA por sala (`start_url` = `/chat/<slug>`, así cada
espectador puede instalar el chat de su streamer como app).

**Verificación:** un bloqueado recibe 403 en Kick y en Twitch, el desbloqueo
anda al instante, y la PWA instalada abre directo en la sala.

> Construida. Lo que falta mirar con los ojos: **escanear el QR con un celular de verdad**
> (lo leyó jsQR 328 veces, pero una cámara agrega óptica y pantalla) e **instalar la PWA**
> de una sala desde un teléfono. El vencimiento de 60 días no corrió nunca contra datos
> viejos de verdad, por razones obvias.

### Fase 5.5 — Creadores que sólo usan Twitch — **AFUERA de este plan**

Ver la sección 6. Recién cuando alguien lo pida.

---

## 6. El problema grande: el slug es de Kick

Hoy **sala = slug de Kick**: el alta es con Kick, el dueño se reconoce con
`KICK_SLUG`, los webhooks se rutean por el id de Kick y los prefijos de R2 son
`<slug>/`. Un streamer que sólo está en Twitch no puede crear sala.

Para abrirlo haría falta:

- que el creador tenga un `slug` propio, único, que **no** sea el de ninguna red,
  y las redes colgando de él (`redes.kick`, `redes.twitch`);
- un `/crear` que acepte entrar con Twitch;
- una migración que deje a los creadores actuales con el mismo slug que ya
  tienen, para que ningún link ni ningún prefijo de R2 cambie;
- decidir qué pasa si el slug de Kick de uno coincide con el login de Twitch de
  otro (propuesta: el que llega primero; el segundo elige otro).

Toca identidad, planes, R2 y el dueño del servicio. **Por eso va aparte y al
final.** Las fases 5.1 a 5.4 no lo necesitan.

---

## 7. Lo que decide el dueño antes de construir

> **Decidido el 2026-09-22**: (1) todos los planes, incluido "pendiente";
> (2) leer sin login; (3) cuenta de espectador global; (4) el creador no ve
> quién escribió; (5) la 5.5 queda afuera de este plan.

1. **¿En qué plan entra el chat abierto?** Opciones: en todos, incluido
   "pendiente" (gancho para que prueben la herramienta), o sólo en amigo/pago.
   Recomiendo **todos**: es barato de correr (no hay video) y es lo que hace que
   un creador vuelva.
2. **¿Leer sin login?** Recomiendo **sí**. Pedir login para leer espanta a quien
   sólo quiere mirar.
3. **¿Cuenta de espectador global o por sala?** Recomiendo **global**: conectás
   una vez y te sirve para cualquier creador.
4. **¿El creador ve quién escribió desde acá?** Por ejemplo, con un iconito en
   su `/chat`. Útil para detectar abuso, pero es un dato más sobre la gente.
   Recomiendo **no** para arrancar.
5. **¿La Fase 5.5 entra en este plan?** Recomiendo esperar a que un creador de
   Twitch lo pida.

---

## 8. Qué hace falta de tu lado

Casi nada. La app de Kick y la de Twitch ya existen y el redirect es el mismo.

- [x] Responder la sección 7. Contestada el 2026-09-22.
- [ ] **Registrar el dominio de Cloudflare como redirect en las apps de Kick y de Twitch,
      y cargar `ORIGENES` en Railway** (tareas 20 y 21 de TAREAS-DUENO). Apareció al
      construir la 5.2/5.3: el sitio se sirve desde dos dominios y el login tiene que
      terminar en el mismo donde empezó. Sin esto, desde el dominio de Cloudflare no se
      puede escribir ni conectar ninguna cuenta.
- [ ] Revisar el texto nuevo de `/terminos` (qué se guarda del espectador y cómo se
      borra) y **decidir si sube a Versión 2**. Subirlo obliga a tocar también el link de
      `/crear`, que lleva `terminos=1` escrito; a los creadores que ya están no los afecta
      (los términos sólo se piden en el alta).
- [ ] Para las pruebas: una **cuenta secundaria** de Kick y otra de Twitch, para
      escribir como espectador sin usar la tuya.
