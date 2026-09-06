# Bitácora

Una entrada por fase cerrada, la más nueva arriba. Qué quedó, decisiones y por qué, archivos tocados, cómo verlo funcionando, qué quedó pendiente.

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
