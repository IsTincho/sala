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
| `MODO` | `local` o `produccion` | Se asume `produccion` |
| `CLAVE_CIFRADO` | Cifrar tokens y firmar cookies | No hay sesiones ni tokens guardados |
| `KICK_CLIENT_ID` / `KICK_CLIENT_SECRET` | Login y chat de Kick | El login de Kick avisa y no arranca |
| `TWITCH_CLIENT_ID` / `TWITCH_CLIENT_SECRET` | Login y chat de Twitch | Ídem |
| `MONGODB_URI` | Guardar de verdad | Guarda en archivos, que en Railway se borran en cada deploy |

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
  kick.js       OAuth 2.1 + PKCE, chat, suscripción a eventos
  twitch.js     OAuth, Helix, y el cliente EventSub por WebSocket
  webhook.js    verificación RSA de los webhooks de Kick y deduplicación
paginas/        HTML, CSS y JS puros. Sin frameworks, sin bundler.
pruebas/        node --test, sin librerías
herramientas/   scripts que corren en la PC del dueño (Fase 2)
```

Reglas que no se negocian:

- **El servidor nunca sirve video.** El navegador le pide los segmentos directo a R2. Si una ruta devolviera un `.m3u8` o un `.ts`, el egreso de Railway se comería el presupuesto del mes en una noche.
- **Login identifica, no autoriza.** Quién es dueño, amigo o pago se decide en la colección `creadores`, no en el login.
- **Todo webhook de Kick se verifica con RSA y se deduplica** por `Kick-Event-Message-Id`.
- Cookies `HttpOnly`, `Secure`, `SameSite=Lax`.
- Sin frameworks ni bundlers. Única dependencia: `mongodb`.
- Nombres en español en código, rutas y comentarios.

---

## Rutas

| Ruta | Qué es |
|---|---|
| `/` | Página de estado: si el servidor está vivo y conectado al bus |
| `/eventos/:slug` | SSE. Manda un evento `estado` apenas te conectás, y un ping cada 25 s |
| `/api/estado` | JSON con modo, almacén, canales y qué variables faltan |
| `/oauth/kick/entrar` · `/oauth/kick/volver` | Login con Kick (OAuth 2.1 + PKCE) |
| `/oauth/twitch/entrar` · `/oauth/twitch/volver` | Vinculación de Twitch |
| `/kick/webhook` | Eventos de Kick. 401 si la firma no da |
| `/api/prueba/webhook` | **Sólo con `MODO=local`.** Inyecta un evento sin firma, para desarrollar sin webhooks reales |
