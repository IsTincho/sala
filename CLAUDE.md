# Sala

Servicio web para un streamer de Kick: Chat Global (Kick + Twitch en una ventana aparte), Sala (peli en página propia con el chat real de Kick) y, después, lo mismo para otros creadores.

## Leer antes de tocar nada

1. `PLAN.md`: qué se construye y por qué. Manda sobre cualquier idea nueva.
2. `AGENTES.md`: brief común y prompt de cada fase. Si sos un agente de fase, tu contrato está ahí.
3. `BITACORA.md`: qué ya está hecho. No repetir trabajo.
4. `TAREAS-DUENO.md`: lo que sólo el dueño puede hacer (crear apps, cargar variables). Si algo te falta de ahí, decilo y seguí con lo que no dependa.

## Reglas cortas

- Node moderno, ES modules, `http` nativo. Única dependencia: `mongodb`. Páginas en HTML, CSS y JS puros. hls.js desde CDN con versión fijada.
- Nombres en español en código, rutas, variables y comentarios. Nombres de APIs externas quedan como son.
- Secretos: nunca en el repo, nunca impresos, nunca pedidos. `process.env` en el servidor, `.env` ignorado en local. El dueño trabaja con la pantalla al aire.
- El servidor nunca sirve video. El navegador lo pide directo a R2.
- Login identifica, no autoriza. Dueño = slug igual a `KICK_SLUG`. Planes en la colección `creadores`.
- Webhooks de Kick verificados con RSA y deduplicados. Cookies HttpOnly, Secure, SameSite=Lax.
- Commits chicos en español que digan qué cambia para el usuario. Push sólo si el dueño lo pide.
- Repo hermano de referencia: `../CosasStream` (patrones de OAuth, webhook, SSE, almacén). Copiar adaptando, no importar.

## Correr en local

`npm run local` (lee `servidor/.env` si existe), puerto 8778. Tests: `npm test`.
