# Tareas del dueño

Lo que sólo vos podés hacer. El director te las va pidiendo de a una, en este orden, mientras los agentes programan. Marcá `[x]` cuando esté, o decíselo al director y él lo marca.

Regla de oro: **ningún secreto pasa por el chat ni por la terminal.** Client secrets, claves y URIs con contraseña van directo al dashboard de Railway o a un `.env` local. Si un agente te pide un secreto, no se lo des: decile que ya está cargado.

Valores que NO son secretos y sí se anotan acá abajo, en "Datos públicos": dominio de Railway, URL pública del bucket, nombre del bucket.

---

## Bloque 1 — Para que la Fase 0 pueda desplegar (15 minutos)

- [x] **1. Repo en GitHub.** HECHO por el director el 2026-09-06 con `gh`, a pedido del dueño: repo privado `IsTincho/sala` creado vacío y `origin` configurado. Falta el primer push, que espera el ok del dueño. Crear repo privado `sala` en tu cuenta (`IsTincho`). Sin README ni .gitignore (ya existen). Después, desde esta carpeta:
  ```bash
  git remote add origin https://github.com/IsTincho/sala.git
  ```
  El primer push lo hace el director cuando la Fase 0 tenga algo que desplegar; vos sólo creás el repo.

- [ ] **2. Servicio en Railway.** En railway.com, dentro del mismo proyecto de CosasStream o en uno nuevo: New → GitHub Repo → `sala`. Cuando aparezca el servicio: Settings → Networking → Generate Domain. Copiá el dominio (algo como `sala-production.up.railway.app`) en "Datos públicos".

- [ ] **3. Variables base en Railway** (servicio `sala` → Variables):
  - `KICK_SLUG` = `istincho`
  - `URL_BASE` = `https://<el dominio del paso 2>`
  - `MODO` = `produccion`
  - `CLAVE_CIFRADO` = 32 bytes al azar en base64. Para generarla sin que se vea en pantalla, en PowerShell:
    ```powershell
    node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64'))" | Set-Clipboard
    ```
    Queda en el portapapeles; pegala en Railway y listo. No la pegues en ningún otro lado.

## Bloque 2 — Para que los logins funcionen (Fase 1)

- [ ] **4. App de Kick nueva.** En kick.com → Settings → Developer (requiere 2FA activo) → Create App:
  - Nombre: `Sala`
  - Redirect URI: `https://<dominio>/oauth/kick/volver`
  - Copiá Client ID y Client Secret **directo a Railway** como `KICK_CLIENT_ID` y `KICK_CLIENT_SECRET`. No uses la app de CosasStream: es otro producto y otro redirect.

- [ ] **4 bis. Prender los webhooks de Kick, en la misma pantalla.** En esa misma página del desarrollador hay una sección **Enable Webhooks**: un interruptor y un cuadro de texto. Prendelo y pegá:
  ```
  https://<dominio>/kick/webhook
  ```
  **Esto no lo puede hacer el código.** Kick no acepta la URL del webhook por API: la lee de ese cuadro de texto y de ningún otro lado (confirmado en docs.kick.com/events/introduction). Si este paso no está, todo lo demás parece andar —las suscripciones a eventos se crean sin error— pero no llega ni un mensaje y el chat queda mudo sin avisar por qué. Es el paso que más caro sale olvidarse.

- [ ] **5. App de Twitch.** En dev.twitch.tv/console/apps → Register Your Application:
  - Nombre: `Sala` (tiene que ser único en Twitch; si está tomado, `Sala de istincho`)
  - OAuth Redirect URL: `https://<dominio>/oauth/twitch/volver`
  - Category: Website Integration. Client Type: Confidential.
  - Manage → New Secret. Client ID y secret **directo a Railway** como `TWITCH_CLIENT_ID` y `TWITCH_CLIENT_SECRET`.

- [ ] **6. MongoDB Atlas.** En cloud.mongodb.com: en el cluster gratis que ya usa CosasStream (o uno nuevo M0), Database Access → usuario nuevo `sala` con contraseña generada. Connect → Drivers → copiá la URI, reemplazá `<password>` y agregá el nombre de base al final: `...mongodb.net/sala?retryWrites=true&w=majority`. **Directo a Railway** como `MONGODB_URI`. Network Access: 0.0.0.0/0 (Railway no tiene IP fija).

- [ ] **7. Redeploy.** Railway → servicio `sala` → Deployments → Redeploy, para que tome las variables. Después, avisale al director: "variables cargadas".

## Bloque 3 — Para el video (Fase 2)

- [ ] **8. Cuenta de Cloudflare para Sala.** Recomendado: una cuenta nueva con otro mail, separada de la del panel de CosasStream (ver PLAN.md sección 2). Si preferís usar la misma, también sirve.

- [ ] **9. Bucket R2.** Cloudflare → R2 → Create bucket → nombre `sala-video`, ubicación automática. Después, en el bucket → Settings:
  - Public access → R2.dev subdomain → Allow. Copiá la URL pública (`https://pub-….r2.dev`) en "Datos públicos".
  - CORS policy → Add → pegá esto tal cual, que ya lleva tu dominio:
    ```json
    [
      {
        "AllowedOrigins": [
          "https://sala-production-2289.up.railway.app",
          "http://localhost:8778"
        ],
        "AllowedMethods": ["GET", "HEAD", "PUT"],
        "AllowedHeaders": ["*"],
        "ExposeHeaders": ["ETag"],
        "MaxAgeSeconds": 3600
      }
    ]
    ```
    Sin esto, hls.js no puede cargar el video desde la página.

    **`PUT` y `ETag` van desde ya, aunque hoy no hagan falta.** El script de subida
    sube desde Python y a eso el CORS no lo toca: es una regla del navegador. Pero la
    Fase 3 firma URL para que un creador suba **desde la web**, y ese día sin `PUT` la
    subida falla con un error de CORS que no dice qué falta. Ponerlo ahora es gratis;
    descubrirlo después es volver a esta pantalla sin saber por qué.

- [ ] **10. Token de R2 para tu PC.** R2 → Manage R2 API Tokens → Create → permisos Object Read & Write, sólo bucket `sala-video`. Te da Access Key ID, Secret Access Key y el Account ID. Van a `herramientas/.env` en esta carpeta (el agente de Fase 2 deja `herramientas/.env.ejemplo` con los nombres exactos). Nunca al chat.

  > **Esto cambió en la Fase 3, y es el único cambio de reglas que trajo.** Hasta la Fase 2 el token de R2 no iba a Railway, y estaba bien: el único que subía eras vos. Desde que sube cualquier creador, no se le puede dar el token del bucket (con él leería, pisaría y borraría los videos de todos), así que el **servidor** tiene que poder firmar URL de subida acotadas, y firmar es tener el secreto. Ver la tarea 17.
  >
  > Lo que **no** cambió: el video no pasa por Railway. El servidor firma una URL de unos cientos de bytes y los gigas van del creador a R2 y de R2 al espectador.

- [ ] **10.b Clave de subida.** Entrá a `/panel` con Kick y tocá **Generar una nueva** en "Clave de subida", después **Copiar**, y pegala en `herramientas/.env` como `CLAVE_SUBIDA`. Es lo que le permite al script avisarle al servidor que subiste una película. Se muestra una sola vez y el panel la copia al portapapeles **sin mostrarla**: si estás transmitiendo, no toques "Mostrar igual". Si la perdés, generás otra (la vieja deja de servir en el acto).

- [x] **11. ffmpeg y Python en tu PC.** HECHA, no hacía falta instalar casi nada: ya tenías ffmpeg 8.1.2 y Python 3.14.3. El director corrió `python -m pip install -r herramientas/requirements.txt` (boto3 1.43.89), que era lo único que faltaba. Lo de abajo queda como referencia por si alguna vez hay que rehacerlo en otra máquina. En PowerShell:
  ```powershell
  winget install Gyan.FFmpeg
  winget install Python.Python.3.12
  ```
  Cerrá y abrí la terminal después. Verificá con `ffmpeg -version` y `python --version`.

- [ ] **12. Un video de prueba propio** (algo tuyo, corto, 2 a 5 minutos) para probar la subida y la sincronización sin meter contenido con derechos en el bucket.

## Bloque 4 — Para probar como público

- [ ] **13. Cuenta secundaria de Kick** (otro mail) para entrar a la Sala como espectador, escribir, y ver que aparece en kick.com/istincho con esa cuenta.

## Bloque 5 — Para otros creadores (Fase 3)

La Fase 3 está construida. Todo esto es lo que falta para encenderla; sin nada de esto el servicio sigue funcionando igual para vos, y `/crear` deja crear salas que no van a poder reproducir hasta que las marques como amigo.

- [ ] **14. Decidir el cobro.** Paddle (recomendado desde Argentina: es merchant of record, acepta vendedores argentinos y liquida en USD) o Stripe si tenés entidad afuera. **Está construido contra Paddle**; cambiar a Stripe es un archivo nuevo, no una cirugía.

  Cuando tengas la cuenta en **sandbox**, en paddle.com:
  - Catalog → Products → crear el producto y un **precio recurrente mensual**. Copiá el id del precio (empieza con `pri_`).
  - Developer tools → Authentication → **API key**.
  - Developer tools → Notifications → **New destination**, URL `https://<dominio>/cobro/webhook`, y suscribila a los eventos `subscription.*`. Copiá su **secret key** (empieza con `pdl_ntfset_`).

  En Railway, **directo al dashboard**:
  ```
  PADDLE_ENTORNO=sandbox
  PADDLE_API_KEY=<la api key>
  PADDLE_PRECIO_ID=<pri_...>
  PADDLE_CLAVE_WEBHOOK=<pdl_ntfset_...>
  PRECIO_MENSUAL=5
  MONEDA=USD
  ```
  Cuando pruebes de verdad, `PADDLE_ENTORNO=produccion`. **Sin `PADDLE_CLAVE_WEBHOOK` el plan nunca pasa a "pago": se cobra y no se habilita.** Es el paso que más caro sale olvidarse de este bloque, igual que el 4 bis lo era del otro.

- [ ] **15. Lista de amigos gratis** (slugs de Kick). No hace falta cargarla en ningún lado: entrás a `/admin` con tu cuenta y le tocás **Amigo** a cada uno. Sólo aparecen ahí los que ya se dieron de alta por `/crear`.

- [ ] **16. Leer el texto de términos** que quedó en `/terminos` y decir si va así. Está escrito en castellano claro y dice tres cosas: el contenido es del creador y responde por él, el servicio puede bajar contenido ante un reclamo, y no hay garantía de disponibilidad. Si cambia de fondo, hay que subir el número de versión (`TERMINOS_VERSION` en `servidor/creadores.js`) para que se lo vuelvan a aceptar.

- [ ] **17. Token de R2 para el servidor.** El de la tarea 10 se queda en tu PC. Este es **otro**, para Railway, y es lo que le permite al servidor firmar las subidas de cada creador sin darles el token del bucket.

  R2 → Manage R2 API Tokens → Create → permisos **Object Read & Write**, sólo bucket `sala-video`. En Railway, directo al dashboard:
  ```
  R2_ACCOUNT_ID=<el Account ID>
  R2_ACCESS_KEY_ID=<Access Key ID>
  R2_SECRET_ACCESS_KEY=<Secret Access Key>
  R2_BUCKET=sala-video
  R2_URL_PUBLICA=<la URL pública del bucket, la de "Datos públicos">
  ```
  Sin esto nadie puede subir un video: el panel lo dice con el nombre de la variable que falta.

- [ ] **18. Cuánto espacio regalás.** El bucket gratis son **10 GB en total**, así que la suma de lo que se reparte es lo que de verdad entra. Por defecto: 2 GB por amigo, 5 GB por creador que paga. Se cambia en Railway con `GB_AMIGO` y `GB_PAGO`. Pasado el bucket gratis son USD 0,015 por GB por mes: es el **primer gasto real del proyecto**.

- [ ] **19. Pedirle a Kick la verificación de la app, antes de llegar a 500 salas.** La app sin verificar admite 1.000 canales suscriptos a `chat.message.sent`. Pasado ese número, las suscripciones nuevas fallan y **el chat de los que entren queda mudo sin ningún error visible**. `/crear` corta solo en 900 y `/admin` te avisa a partir de la mitad, pero el trámite con Kick lleva tiempo: conviene empezarlo cuando el aviso aparezca, no cuando el tope llegue.

## Bloque 6 — Para que la comunidad escriba en el chat abierto (Fases 5.2 y 5.3)

Está construido. Sin esto, `/chat/<slug>` se sigue leyendo igual; lo que no anda es **escribir desde el dominio de Cloudflare**, y "Conectar Twitch" desde cualquiera de los dos.

- [ ] **20. Registrar el dominio de Cloudflare como redirect, en las dos apps.** Hoy las apps tienen sólo el dominio de Railway, así que quien entra por `multichat-osmiumstudio.pages.dev` y toca "Conectar Kick" termina el login en Railway, con la cookie puesta ahí: al volver al link que tenía abierto no está conectado.

  - Kick: kick.com → Settings → Developer → tu app `Sala` → agregar el redirect
    `https://multichat-osmiumstudio.pages.dev/oauth/kick/volver`
  - Twitch: dev.twitch.tv/console/apps → tu app → **Add** otra OAuth Redirect URL
    `https://multichat-osmiumstudio.pages.dev/oauth/twitch/volver`

  Las dos aceptan **varios** redirect: el de Railway se queda como está, no se toca.

- [ ] **21. Cargar `ORIGENES` en Railway** (servicio `sala` → Variables):
  ```
  ORIGENES=https://multichat-osmiumstudio.pages.dev
  ```
  No es un secreto: es un dominio público. Es lo que hace que el servidor acepte los POST que vienen de ese dominio **y** que arme los redirect de OAuth apuntando ahí.

  `URL_BASE` **no se toca**: sigue siendo el de Railway, y es el que se usa cuando el pedido no viene por ninguno de los dos.

  > Los pasos 20 y 21 van juntos y en ese orden. Si cargás `ORIGENES` sin registrar los redirect, el login desde el dominio lindo rebota del lado de Kick y de Twitch ("redirect_uri mismatch"). Si registrás los redirect y no cargás `ORIGENES`, no pasa nada malo: sigue todo como hoy.

  **Cómo saber si quedó bien:** entrá a `https://multichat-osmiumstudio.pages.dev/chat/<tu-slug>` y tocá "Conectar Kick". Tenés que volver **a ese mismo dominio**, conectado. Si volvés al dominio de Railway, avisame: quiere decir que Railway está pisando la cabecera `X-Forwarded-Host` que manda el Worker, y se arregla del lado del Worker con una cabecera propia (dos líneas).

- [ ] **22. Cuenta secundaria de Twitch** (además de la de Kick de la tarea 13), para probar el chat abierto como espectador: conectar las dos, escribir con "las dos" y ver que sale en los dos chats con esa cuenta.

- [ ] **23. Apuntarle el celular al QR, una vez.** En `/panel`, al lado del link del chat, hay un QR. Lo verificó un decodificador de verdad 328 veces, pero una cámara agrega óptica, foco y una pantalla de por medio: conviene mirarlo una vez con el teléfono antes de ponerlo en cámara. De paso, probá **instalar** `/chat/<tu-slug>` desde el celular (Compartir → Agregar a inicio): tiene que abrir en tu chat y no en el Chat Global.

- [ ] **24. Decidir si los términos suben a Versión 2.** El texto de `/terminos` cambió de fondo: ahora dice qué se guarda de cada espectador por red y las tres formas de borrarlo. **La versión quedó en 1 a propósito**, porque subirla es una decisión tuya y tiene una consecuencia: hay que cambiar `TERMINOS_VERSION` en `servidor/creadores.js` **y** el `terminos=1` del link de `/crear` (`paginas/crear.html`), o el alta deja de funcionar. A los creadores que ya están no los afecta: los términos sólo se piden en el alta.

## Bloque 7 — Canjes, subs y follows en el chat (2026-09-29)

Está construido. Kick no pide nada: las suscripciones nuevas se crean solas en la vuelta de los cinco minutos (o con **Resuscribir Kick** en `/panel`). Twitch sí:

- [ ] **25. Volver a vincular Twitch, fuera de cámara.** `/panel` → **Volver a vincular Twitch**. Twitch ahora pide tres permisos más, todos de lectura: seguidores (`moderator:read:followers`), suscripciones (`channel:read:subscriptions`) y canjes de puntos (`channel:read:redemptions`). Mientras no lo hagas, el chat de Twitch anda igual; lo único que falta es la actividad de Twitch, y el panel lo dice con esas palabras.

- [ ] **25 bis. Volver a entrar con Kick, fuera de cámara.** `/panel` → **Volver a entrar con Kick**. Kick ahora pide también leer los canjes de puntos (`channel:rewards:read`). Después abrí **Actividad** en el chat: arriba dice qué está escuchando cada red, y si alguna rechazó algo, el motivo.

- [ ] **26. Que tus mods escriban una vez.** Quién es mod lo dice la insignia de moderador de Kick o de Twitch en sus mensajes. Para ver el botón **Actividad** en `/chat/<tu-slug>`, cada mod tiene que conectar ahí la misma cuenta con la que modera (Conectar Kick o Conectar Twitch) y haber escrito al menos una vez en tu chat con la insignia puesta. Si le sacás el rol, en cuanto escriba sin la insignia deja de verlo.

- [ ] **27. Decidir si `/terminos` lo menciona.** La lista de actividad guarda el **nombre público** de quien canjeó, se suscribió o siguió (los últimos 150 por sala), y para reconocer a los mods se guarda su **id de Kick o de Twitch** (vence a los 30 días sin verlo). No se agregó al texto de los términos: es tu decisión, igual que la de la versión (tarea 24).

---

## Datos públicos (se pueden escribir acá)

- Dominio de Railway: `https://sala-production-2289.up.railway.app`
- URL pública del bucket: `(pendiente)`
- Nombre del bucket: `sala-video`
- Slug del dueño: `istincho`
