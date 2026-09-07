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
  - CORS policy → Add → pegá esto (reemplazando el dominio):
    ```json
    [
      {
        "AllowedOrigins": ["https://<dominio de Railway>", "http://localhost:8778"],
        "AllowedMethods": ["GET", "HEAD"],
        "AllowedHeaders": ["*"],
        "MaxAgeSeconds": 3600
      }
    ]
    ```
    Sin esto, hls.js no puede cargar el video desde la página.

- [ ] **10. Token de R2 para tu PC.** R2 → Manage R2 API Tokens → Create → permisos Object Read & Write, sólo bucket `sala-video`. Te da Access Key ID, Secret Access Key y el Account ID. Van a `herramientas/.env` en esta carpeta (el agente de Fase 2 deja `herramientas/.env.ejemplo` con los nombres exactos). Nunca a Railway, nunca al chat.

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

## Bloque 5 — Para otros creadores (Fase 3, más adelante)

- [ ] **14. Decidir el cobro.** Paddle (recomendado desde Argentina) o Stripe si tenés entidad afuera. Crear la cuenta en modo sandbox y cargar claves en Railway cuando el agente de Fase 3 diga cuáles.
- [ ] **15. Lista de amigos gratis** (slugs de Kick).
- [ ] **16. Qué contenido va a pasar por la Sala** y aceptar el texto de términos que proponga el agente.

---

## Datos públicos (se pueden escribir acá)

- Dominio de Railway: `(pendiente)`
- URL pública del bucket: `(pendiente)`
- Nombre del bucket: `sala-video`
- Slug del dueño: `istincho`
