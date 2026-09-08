# Plan: Fase 4 — pasar la pantalla en vivo

Fecha: 2026-09-08. Estado: plan, nada construido. Complemento de [PLAN.md](PLAN.md),
que sigue mandando sobre todo lo demás.

**Qué resuelve:** hoy la Sala pasa un archivo que el creador subió antes. Esto agrega
la otra mitad: que el creador **comparta su pantalla en vivo** a su Sala, sin que eso
pase por su stream de Kick ni quede en su VOD.

**La regla de la casa se mantiene:** el servidor de Railway no sirve video. Sigue
repartiendo sólo el reloj, el chat y los eventos. El video en vivo sale de otro lado.

---

## 0. Decisiones tomadas

1. **El creador no sirve el video desde su casa.** Manda **un** stream a un relay y el
   relay reparte. Dos motivos, y el segundo es el que decide.
2. **La IP del creador no se expone nunca.** Su PC abre una conexión **saliente** al
   relay; nadie se conecta a su casa, su IP no aparece en ningún DNS ni en ningún
   candidato de WebRTC. Sembrar por P2P desde la casa quedó **descartado por esto**:
   el P2P intercambia direcciones entre pares, así que sembrar desde casa es publicar
   la IP a cada espectador.
3. **El relay arranca en un free tier de verdad.** Oracle Cloud Always Free: máquina
   ARM gratis para siempre, **10 TB de egreso por mes**. Con el P2P entre espectadores
   prendido, esos 10 TB rinden como 50.
4. **El P2P es entre espectadores, opcional y apagado por defecto.** Expone las IPs de
   los espectadores entre ellos: es inherente a la tecnología, no una falla de
   implementación. Para un grupo de amigos da igual; para público abierto hay que
   avisarlo. Se prende por sala.
5. **La Sala no cambia.** Consume HLS. Que el HLS venga de R2 o del relay es otra URL,
   no otra arquitectura. El reloj, el chat, el login de espectadores y el panel quedan
   igual.

---

## 1. La cuenta que manda el diseño

Cada espectador consume ancho de banda de quien le sirve el video. Servirlo desde la
casa del creador es la opción obvia y es la que no funciona:

**espectadores = subida del creador ÷ bitrate**

Con 30 Mbps de subida y video a 2,5 Mbps son **12 personas**. Por eso el video sale de
un relay y no de la casa.

**Con relay, la subida del creador deja de importar:** manda un solo stream, unos 4
Mbps. Un creador con 10 Mbps de subida ya entra. Los dos casos que tenemos medidos
—600 Mbps y 100 Mbps— sobran por dos y un órdenes de magnitud.

### Qué cuesta repartirlo

Una noche de 300 personas, 2 horas, 2,5 Mbps: **~675 GB**.

| Dónde | Costo por noche | Al mes |
|---|---|---|
| Cloudflare Stream Live | ~USD 180 | inviable |
| Video por Railway (USD 0.05/GB) | ~USD 34 | inviable |
| **Oracle Always Free (10 TB/mes)** | **USD 0** | **USD 0**, ~15 noches |
| Oracle + P2P al 80% | USD 0 | ~74 noches |
| Hetzner (20 TB incluidos) | USD 0 | €4,49 fijos |

El archivo subido a R2 sigue costando **cero** y sin tope: R2 no cobra egreso. Por eso
**el modo archivo no se reemplaza, se complementa**. Para contenido que el creador ya
tiene, subirlo sigue siendo la mejor opción por lejos.

---

## 2. Cómo funciona

```
   PC del creador                    relay (Oracle/Hetzner)              espectadores
        │                                     │                              │
        │  RTMP saliente, 1 stream            │  HLS                         │
        │  (~4 Mbps)             ────────────>│ ────────────────────────────>│
        │                                     │                              │
        │                                 (nginx/SRS)                    P2P entre
        │                                                                 ellos
        │
   Railway: reloj, chat, login, panel  ── SSE ──────────────────────────────>
```

- **La PC del creador** manda su pantalla por RTMP con OBS —**un perfil aparte**, que
  no toca su stream de Kick ni su VOD— o con el capturador propio de la página.
- **El relay** recibe el RTMP y lo publica como HLS. Es lo único con cara pública.
- **La Sala** apunta el player a esa URL. Con P2P prendido, los espectadores se pasan
  los segmentos entre ellos y el relay sirve una fracción.
- **Railway** sigue haciendo lo mismo de siempre y no ve un byte de video.

### El problema de verdad: el chat va adelantado

El HLS en vivo tiene **10 a 30 segundos de retraso**. El chat de Kick llega por webhook
en menos de 2 segundos. Sin compensar, los espectadores leen el comentario de una escena
que todavía no vieron.

Es el trabajo real de esta fase, y hay que resolverlo del lado del chat, no del video:
retener cada mensaje el tiempo que dura el desfase antes de mostrarlo, midiendo ese
desfase contra el reloj del relay. Es la contracara del reloj de sala que ya existe.

---

## 3. Cómo entra con varios creadores

- Cada creador tiene su **clave de emisión** en el relay, generada desde su panel, con
  la misma mecánica de la clave de subida que ya existe (se muestra una vez, se guarda
  hasheada, se revoca sola al generar otra).
- Un relay aguanta varias salas mientras entre en el egreso. Cuando no entre, se parte
  por creador y ahí ya se cobra.
- **El plan del creador decide si puede emitir**, igual que hoy decide si puede
  reproducir.

---

## 4. Fases

**4.1 — El relay, a mano (1 bloque).** Levantar la VM, nginx-rtmp o SRS, y probar el
circuito entero con OBS empujando y VLC mirando. Sin tocar el repo. Sirve para saber
que la parte de infraestructura cierra antes de escribir una línea.

**4.2 — La Sala mira en vivo (1 bloque).** El panel elige "archivo" o "en vivo"; el
player apunta al HLS del relay; la pantalla de espera dice "todavía no empezó". El
reloj de sala no interviene: en vivo es en vivo.

**4.3 — El chat en hora (1 bloque).** Medir el desfase y retener los mensajes. Es lo
que hace que se sienta bien o se sienta roto.

**4.4 — P2P entre espectadores (1 bloque).** P2P Media Loader sobre el hls.js que ya
usa la Sala. Apagado por defecto, se prende por sala, con el aviso de las IPs.

**4.5 — Multi-creador (1 bloque).** Clave de emisión por creador, tope por plan, y el
consumo del relay a la vista en el panel.

---

## 5. Riesgos

| Riesgo | Efecto | Qué hacer |
|---|---|---|
| No se consigue la instancia ARM gratis de Oracle | No hay relay | Hetzner a €4,49, mismo diseño |
| Se agota el egreso del free tier | El video corta a mitad de noche | Contador en el panel y aviso antes del tope, no después |
| El P2P expone IPs entre espectadores | Privacidad de terceros | Apagado por defecto; aviso claro al prenderlo |
| El desfase del chat mal compensado | Spoilers de lo que todavía no se vio | Fase 4.3 es su propio bloque por esto |
| Contenido sin derechos | Baja de contenido y de cuenta | **Sacarlo del VOD de Kick no lo hace legal**: mueve el reclamo a la cuenta del relay y a la del dueño. Los términos por creador ya existen desde la Fase 3 |
| DRM (Netflix, Disney+, Prime) | Pantalla negra | **No tiene solución técnica y no se va a intentar.** La captura se corta en el origen, antes de que el navegador vea un pixel |

---

## 6. Qué hace falta del dueño

1. **Cuenta de Oracle Cloud** y conseguir la instancia ARM Always Free. Es el único
   paso con incertidumbre real: escasean por región.
2. **Decidir si el P2P se prende**, sabiendo lo de las IPs.
3. **Un perfil de OBS aparte** apuntando al relay, separado del que va a Kick.

Nada de esto hace falta para lo que ya está construido: el multichat y la Sala por
archivo funcionan sin una línea de esto.
