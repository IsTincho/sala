# Plan: Sala (ver pelis con el chat de Kick) + Chat Global

Fecha: 2026-09-06. Estado: plan aprobado en principio, nada construido. Regla del dueño: **la única infraestructura paga es Railway (USD 5 al mes, ya se paga). Todo lo demás, gratis hasta monetizar.**

Instrucciones para agentes: `AGENTES.md`. Prompt del director: `ARRANQUE.md`. Tareas tuyas: `TAREAS-DUENO.md`.

---

## 0. Decisiones tomadas

1. **Proyecto aparte.** Repo nuevo `sala`, servicio nuevo en Railway (mismo plan que CosasStream), app de Kick nueva, app de Twitch propia. CosasStream no se toca; se copian sus patrones: OAuth con PKCE, verificación de webhooks, bus SSE, almacén, roles, nombres en español, sin dependencias.
2. **Chat Global es herramienta externa, no overlay.** Página para abrir en ventana aparte o segundo monitor, instalable como app. No va a OBS. Motivo: las guías de simulcast de Twitch (sección 11) prohíben mostrar en el stream de Twitch chats combinados de otras plataformas; Twitch pausó las sanciones en febrero de 2026, la regla escrita sigue. Uso privado para monitorear está permitido. Fuentes: [upstream.so](https://upstream.so/blog/twitch-allows-unified-chat-simulcasting-rules/), [Lightstream](https://golightstream.com/how-to-comply-with-twitch-tos-when-simulcasting/).
3. **Costo: sólo Railway.** Servidor Node en Railway (dentro de los USD 5 de uso incluidos: un servicio chico gasta USD 1 a 2). Video en Cloudflare R2 gratis (10 GB, egreso cero). Datos en MongoDB Atlas gratis (512 MB), como ya hace CosasStream. Dominio de Railway gratis. Detalle en sección 3. Alternativa cero absoluto (Cloudflare Workers + Durable Objects) descartada por ahora: más restricciones, sin ventaja real.
4. **Cobro en dólares, recién en Fase 3.** Stripe no abre cuentas en Argentina ([stripe.com/global](https://stripe.com/global): en Latinoamérica sólo Brasil y México). Recomendado **Paddle** (merchant of record, acepta vendedores argentinos, liquida en USD por transferencia o Payoneer, comisión aprox. 5 % + USD 0.50). Stripe sólo con entidad afuera. El código lleva una capa de "plan" que no depende del proveedor.

---

## 1. Qué averigüé (lo que manda el diseño)

### Kick

| Tema | Dato | Fuente |
|---|---|---|
| Escribir como el espectador | `POST https://api.kick.com/public/v1/chat` con `type: "user"`, `broadcaster_user_id`, `content` (máx. 500 caracteres). Scope `chat:write`. El mensaje sale con el nombre del espectador, en el chat real. | [docs.kick.com/apis/chat](https://docs.kick.com/apis/chat) |
| Qué hace el espectador | Se loguea con Kick una vez (OAuth 2.1 + PKCE) aceptando `user:read` y `chat:write`. Queda el refresh token. | [scopes](https://docs.kick.com/getting-started/scopes) |
| Leer el chat | Webhook `chat.message.sent` a una URL HTTPS, firmado con RSA (clave pública en `/public/v1/public-key`). Ya está hecho en CosasStream. Para el canal de otro creador, ese creador autoriza la app (`events:subscribe`). | [KickDevDocs #214](https://github.com/KickEngineering/KickDevDocs/discussions/214) |
| Tope de app no verificada | 1.000 suscripciones a `chat.message.sent` por app. Tope de **canales**, no de mensajes. | [subscribe-to-events](https://docs.kick.com/events/subscribe-to-events) |
| Confiabilidad de webhooks | Issue abierto (dic 2025) con entregas que se cortan. Hace falta aviso visible y resuscripción. | [KickDevDocs #300](https://github.com/KickEngineering/KickDevDocs/issues/300) |
| Plan B para leer | WebSocket público de Pusher (`ws-us2.pusher.com`), sin login, no oficial. Sólo para tu ventana. | [kick_live_ws](https://socket.dev/npm/package/kick_live_ws) |
| Rate limit de envío | No documentado. Medir y respetar 429. | — |
| Embed de la cámara | `<iframe src="https://player.kick.com/{slug}?autoplay=true&muted=true">`. | [help.kick.com](https://help.kick.com/en/articles/8010826-how-to-embed-your-kick-livestream) |

### Twitch

| Tema | Dato | Fuente |
|---|---|---|
| Leer chat | EventSub por **WebSocket** (`wss://eventsub.wss.twitch.tv/ws`), evento `channel.chat.message`, con tu token de usuario y scope `user:read:chat`. Leer tu propio canal cuesta 0 del presupuesto de 10. Un proceso vivo en Railway lo sostiene sin problema. | [dev.twitch.tv](https://dev.twitch.tv/docs/eventsub/eventsub-subscription-types/) |
| Plan B | IRC anónimo (`justinfan`), sin token. Sigue vivo pero Twitch lo apaga de a poco. | [foro](https://discuss.dev.twitch.com/t/deprecation-of-chat-commands-through-irc/40486) |
| Escribir en Twitch | `POST https://api.twitch.tv/helix/chat/messages` con tu token (`user:write:chat`). | [dev.twitch.tv](https://dev.twitch.tv/docs/chat/send-receive-messages/) |
| Qué hace falta | App en `dev.twitch.tv/console` (sin revisión) y un login tuyo desde el panel. | — |

### Costos

| Pieza | Con qué | Gratis hasta | Fuente |
|---|---|---|---|
| Servidor | Segundo servicio en el plan de Railway que ya pagás | Un Node chico gasta USD 1 a 2 de los USD 5 incluidos. Egreso USD 0.05 por GB, pero el servidor nunca sirve video. | [Railway](https://makerkit.dev/pricing-calculator/railway) |
| Video | Cloudflare R2, URL pública `r2.dev` | 10 GB guardados, egreso cero, 10 millones de lecturas al mes. Una peli de 2 h a 720p pesa 1,5 a 2 GB. 300 personas por 2 h con segmentos de 6 s son 360.000 lecturas: 25 noches al mes. Más de 10 GB: USD 0.015 por GB al mes. | [R2](https://egresscost.com/cloudflare/) |
| Datos | MongoDB Atlas M0 | 512 MB. Tokens, sesiones, videos y planes ocupan kilobytes. | — |
| Chat | APIs de Kick y Twitch | Sin costo. | — |
| Cámara | Embed de `player.kick.com` | Sin costo. | — |
| Dominio | `sala-production.up.railway.app` | Sin costo. Dominio propio cuando quieras. | — |

**Único "centavo" posible:** la URL pública `r2.dev` está pensada para desarrollo y se limita a "cientos de requests por segundo", con posible baja de ancho de banda ([docs](https://developers.cloudflare.com/r2/buckets/public-buckets/)). 300 personas con segmentos de 6 s son 50 requests por segundo: entra. Si una noche se ahoga, la salida es un dominio propio en Cloudflare (unos USD 10 por año) conectado al bucket. Se decide cuando pase.

---

## 2. Aviso antes de construir

**Pelis y series con derechos.** Servir el archivo desde R2 a espectadores es distribución pública. Cloudflare y Railway bajan contenido por DMCA y pueden cerrar la cuenta. Kick no ve la peli, pero el link va a estar en tu chat. Con contenido propio, de dominio público o con licencia no hay problema. En el SaaS, cada creador sube su archivo y acepta términos. Decisión tuya; el plan técnico no cambia. Lo que sí ayuda: **cuenta de Cloudflare separada** para el bucket de Sala, así un reclamo no arrastra al panel de CosasStream.

---

## 3. Cómo funciona (de punta a punta)

### Las piezas

```
                Kick ──webhook chat.message.sent (RSA)──────┐
              Twitch ──EventSub WebSocket (token del dueño)──┤
                                                             ▼
   OBS → Kick (sólo cámara)                     servidor "sala" (Node, Railway)
                                     rutas: /oauth/*  /kick/webhook  /api/*  /eventos/:slug (SSE)
                                     páginas estáticas: /  /chat  /sala/:slug  /panel
                                     memoria por canal: conexiones SSE, reloj de sala, últimos 200 mensajes
                                     almacén (Mongo Atlas): tokens cifrados, sesiones, videos, creadores
                                                             │
                     ┌───────────────────────────────────────┼──────────────────┐
                     ▼                                       ▼                  ▼
              /chat (tu ventana)                    /sala/:slug            /panel (dueño)
              Kick+Twitch mezclados             cámara | video | chat      play, pausa, episodio
              caja para escribir a los dos      hls.js ← R2 (pub-….r2.dev)
```

- **Servidor**: un Node sin dependencias (sólo el cliente de MongoDB), igual que CosasStream. Un proceso vivo que mantiene la conexión con Twitch, recibe los webhooks de Kick y reparte todo por SSE. Nunca sirve video.
- **Canal**: en memoria, uno por creador: conexiones SSE abiertas, reloj de sala, últimos 200 mensajes. Lo persistente (reloj, videos) se espeja en el almacén para sobrevivir reinicios.
- **Almacén**: MongoDB Atlas gratis, con el mismo `almacen.js` de CosasStream (Mongo si hay `MONGODB_URI`, archivo JSON en local).
- **R2**: el video ya cortado en HLS, con URL pública `r2.dev`. El navegador lo pide directo. Por eso el egreso de Railway no importa.
- **Páginas**: HTML, CSS y JS puros, servidas por el mismo servidor (mismo origen que el callback OAuth, así las cookies funcionan). hls.js desde CDN.

### Una noche, paso a paso

1. **Antes del stream**, en tu PC: `python herramientas/subir.py "S01E03.mkv"`. Convierte con ffmpeg a HLS (720p y 1080p, segmentos de 6 s, subtítulos WebVTT si hay), sube al bucket con el token de R2 que vive en un `.env` local, y avisa al servidor que existe el video.
2. **Prendés OBS** como siempre: cámara a Kick. Nada cambia.
3. **Abrís `/panel`**, logueado con Kick como dueño. Elegís el episodio, tocás Play. El servidor guarda `{video, empezoEn: ahora, pausado: false}` y lo manda a todas las pestañas por SSE.
4. **La gente entra a `/sala/istincho`** desde tu link. La página abre SSE, recibe el reloj, carga la playlist desde R2 y salta al segundo que corresponde. Sólo botón de play, sin barra: se ve "en directo". Cada 10 s compara su posición con el reloj y corrige si se fue más de 1,5 s. Izquierda tu cámara (embed de Kick), derecha el chat.
5. **Chat en vivo**: cada mensaje en Kick llega por webhook, el servidor verifica la firma y lo reparte. Menos de 2 s.
6. **Alguien escribe desde la Sala**: sin login, botón "Entrar con Kick" (OAuth, scopes `user:read chat:write`). El servidor guarda su refresh token cifrado (AES-256-GCM con una clave secreta en Railway) en el almacén. Al enviar (`POST /api/sala/istincho/chat`), consigue un access token, llama a Kick con tu `broadcaster_user_id`, y el mensaje aparece en kick.com con el nombre del espectador. Vuelve por el webhook y se ve en la Sala. Límite propio: 1 mensaje cada 2 s por persona.
7. **Pausás o cambiás de episodio** desde el panel; todos se sincronizan.
8. **Después del stream**: `python herramientas/subir.py --borrar S01E03` libera espacio, o dejás la temporada si entra en 10 GB.

### El Chat Global, en la misma base

`/chat` es una página del mismo servidor, sólo para vos. Recibe por SSE Kick y Twitch, los muestra mezclados o en dos columnas, con color por red, letra grande, pausa al hacer scroll. Caja para escribir con selector: Kick, Twitch o los dos. Kick con tu token; Twitch con `helix/chat/messages` y tu token. Se instala como app (manifest PWA) y se abre en el segundo monitor. Nada que ver con OBS.

Twitch entra por EventSub WebSocket: te logueás con Twitch una vez desde `/panel` (scopes `user:read:chat user:write:chat`), el servidor abre la conexión, se suscribe a `channel.chat.message` de tu canal y la mantiene con reconexión. Si se cae, cae a IRC anónimo mientras reintenta.

### Seguridad, en corto

- Secretos (client secrets de Kick y Twitch, clave de cifrado, `MONGODB_URI`) sólo como variables de Railway, cargadas desde su dashboard. Nunca en el repo, nunca en la terminal en stream.
- Token de R2 sólo en tu PC, en `.env` ignorado por git, para el script de subida.
- Webhooks de Kick verificados con RSA y deduplicados por id (copiar `webhook.js`).
- Cookies `HttpOnly`, `Secure`, `SameSite=Lax`. Sesión del dueño distinta de la del espectador (como panel vs mural en CosasStream).
- Login identifica; el plan y la lista de amigos autorizan. Regla de la casa.

---

## 4. Fases

### Fase 0 — Cimientos (1 bloque)

Repo nuevo, servidor Node con enrutador propio, OAuth de Kick y de Twitch, webhook de Kick verificado, bus SSE por canal, almacén, cifrado, deploy en Railway. Página mínima que muestre "conectado".

### Fase 1 — Chat Global (2 a 3 bloques)

`/chat` completo: leer los dos, escribir a los dos, PWA, `?demo=1` para diseñar sin datos.

Verificación: hablás desde el celular en los dos chats y aparece en menos de 2 s con nombre y red; escribís desde la ventana y sale en kick.com y twitch.tv con tu cuenta.

### Fase 2 — Sala para vos (2 semanas)

Script de subida, reloj de sala, página de tres columnas, login de espectador, envío al chat de Kick, panel con play/pausa/episodio.

Verificación: desde otro navegador con una cuenta secundaria, escribís en la Sala y aparece en kick.com/istincho con esa cuenta; dos navegadores muestran el mismo segundo.

### Fase 3 — Otros creadores (2 a 3 semanas)

Alta con `/crear`, un canal por creador, panel reducido, planes gratis/amigo/pago, Paddle (o Stripe), términos, subida por creador con URL prefirmada. Primer gasto real: almacenamiento por creador y dominio propio. Para entonces ya cobrás.

---

## 5. Riesgos

| Riesgo | Efecto | Qué hacer |
|---|---|---|
| Derechos de las pelis | Baja de contenido o de cuenta | Sección 2. Cuenta de Cloudflare separada. Términos por creador. |
| `r2.dev` se ahoga | Video se traba con mucha gente | Segmentos de 6 s; si pasa, dominio propio (USD 10 al año). |
| Uso de Railway pasa de USD 5 | Cobro extra | Servidor liviano, video nunca por Railway, medir en `/panel`. |
| Webhooks de Kick se cortan | Chat mudo | Aviso visible en `/chat` y `/panel`; botón "resuscribir"; Pusher sólo para tu ventana. |
| Rate limit de envío desconocido | 429 a espectadores | Límite propio, cola con reintento, medir en Fase 2. |
| Tope de 1.000 canales | No entran más creadores | Pedir verificación a Kick antes de los 500. |
| Pantalla al aire | Secretos visibles | Variables por dashboard de Railway; nada por terminal. |

---

## 6. Qué hace falta de tu lado

1. **Repo** `sala` en GitHub, conectado a esta carpeta (ya inicializada con git).
2. **Repo en GitHub** y **servicio en Railway** conectado a ese repo (deploy desde `main`, como CosasStream). Con eso sale el dominio.
3. **App de Kick** en `kick.com/settings/developer`, redirect `https://<dominio>/oauth/kick/volver`. Client ID y secret cargados en Railway como `KICK_CLIENT_ID` y `KICK_CLIENT_SECRET`.
4. **App de Twitch** en `dev.twitch.tv/console`, redirect `https://<dominio>/oauth/twitch/volver`. En Railway como `TWITCH_CLIENT_ID` y `TWITCH_CLIENT_SECRET`.
5. **MongoDB Atlas** gratis (nuevo cluster o base nueva en el que ya usa CosasStream). En Railway como `MONGODB_URI`.
6. **Bucket R2** `sala-video` con acceso público `r2.dev` y un token de API de R2 (sólo para tu PC, en `.env`). Ideal en una cuenta de Cloudflare separada.
7. Lista corta de amigos gratis y qué contenido va a pasar por la Sala.

Con el nombre alcanza para arrancar la Fase 0; los logins se prueban cuando estén 3 y 4.
