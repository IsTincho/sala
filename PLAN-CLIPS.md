# Plan: Clips — el creador sube un clip y se lleva el reel vertical

Fecha: 2026-10-28. Estado: **plan, nada construido ni aprobado para construir.**
Complemento de [PLAN.md](PLAN.md), que sigue mandando sobre todo lo demás.
Sale de la skill `clip-reel` (`~/.claude/skills/clip-reel`), con la que se editan
los reels de istincho desde octubre de 2026.

---

## 0. La idea en una línea

Hoy los reels salen de una sesión con Claude: scripts más criterio, clip por clip.
La idea es que cualquier creador de Sala haga la **versión rápida** solo, desde
la web: sube su clip horizontal y se lleva el mp4 vertical 1080x1920 a 60 fps
(cámara arriba, juego abajo, subtítulos palabra por palabra con un color por
voz, gancho al arranque, cartel de redes) más el texto para publicarlo.

```
Creador:  /panel → Clips → sube el clip → (la primera vez) marca su cámara
          → corrige subtítulos y elige quién habla → marca el gancho
          → "Armar reel" → descarga el mp4 y el texto
```

La **edición de autor** (cámara lenta, congelados, recuadros de cómic) queda
afuera: sale de decidir clip por clip y sigue siendo trabajo con Claude.

---

## 1. Qué hay hoy y qué se lleva

Los scripts viven fuera de git, en `~/.claude/skills/clip-reel/scripts`
(unas 370 líneas). Se copian adaptando a `trabajador/` (regla del repo:
copiar adaptando, no importar). En Linux desaparece el problema de las rutas
con `C:` dentro de los filtros de ffmpeg.

| Pieza de hoy | Qué hace | En Sala |
|---|---|---|
| `transcribe.py` | faster-whisper `large-v3-turbo`, CPU, int8, con prompt de nombres del juego | Igual, en el trabajador |
| `captions.py` | ASS palabra por palabra, pop + tilt, `layout()` + `\q2` para que no se buguee | Igual. El `captions.json` lo arma el editor web, no una persona a mano |
| `coldopen.py`, `hook.py` | Teaser del remate + "◀◀ UN RATO ANTES…", texto del gancho en caja amarilla | Igual. Los tiempos y el texto los marca el creador |
| `reel.sh` | Cámara en tarjeta de 740 px sobre su copia desenfocada, juego abajo 1080x1450, 60 fps, CRF 18, loudnorm -14 LUFS | Igual, con el marco de cada creador |
| `capture-badge.mjs` + `badges/<juego>/` | Cartel canvas con `seek(t)`, capturado en Edge | Plantillas genéricas, grabadas una vez por creador (ver 3) |
| Criterio de Claude | Quién habla (leyendo la franja de subtítulos del juego), ortografía rioplatense, elegir el remate, cartel por juego | Fase A: lo hace el creador en el editor. Fase B: lo sugiere un LLM |

Lo que hoy está fijo para istincho y pasa a ser **configuración del creador**:
el marco `512:287:42:46`, el rojo `FF3B3B` de su voz, los handles (Kick
`istincho`, Twitch `lstincho`), los logos y el cartel abajo a la derecha.

---

## 2. Lo que Sala ya tiene y se reutiliza

- **Login** con Kick y Twitch, un slug por creador, `planDe()` con los planes
  `pendiente / amigo / pago / vencido` y el dueño por slug.
- **`r2.js`**: `firmar(metodo, clave, slug, { segundos })` con el prefijo
  `<slug>/` como frontera. El clip va del navegador a R2 directo: el servidor
  sigue sin tocar video.
- **`cobro-paddle.js`**: checkout y webhook. La cuenta de Paddle sigue
  pendiente (TAREAS-DUENO, punto 14).
- **Cuotas por variable** (`GB_AMIGO`, `GB_PAGO`): mismo patrón para los
  minutos de clips.
- **`metricas.js`** y `/panel`: dónde medir cuánto cuesta cada clip.
- **`terminos.html`**: se le suma una sección de clips.

---

## 3. Cómo funciona

### Las piezas

```
navegador del creador ──PUT firmado──►  R2, bucket de clips (borra solo a los 7 días)
        │                                    ▲            │
        │ /api/clips/...                     │ GET / PUT firmados (los firma Sala)
        ▼                                    │            ▼
servidor "sala" (el Node de hoy) ──red privada──►  servicio "trabajador" (Docker, se duerme)
        Mongo: clips, marcos, cola                  ffmpeg + faster-whisper + fuentes
```

- **El trabajador es un servicio aparte**, en el mismo proyecto de Railway.
  Transcribir y renderizar comen CPU durante minutos enteros: en el proceso de
  Sala trabarían el chat en vivo y el SSE. Es la excepción a "única dependencia:
  mongodb", y queda encerrada ahí: Dockerfile con ffmpeg, Python,
  faster-whisper con el modelo ya bajado en la imagen (los builds no se cobran)
  y Anton + Montserrat (OFL). Sala ya tiene Python en `herramientas/subir.py`.
- **El trabajador no tiene secretos de R2 ni de Mongo.** Sala le manda cada
  pedido con las URLs ya firmadas: GET del original, PUT de cada resultado.
  Sigue valiendo "el prefijo es la frontera y la comprueba quien firma". El
  único secreto del trabajador es un token compartido para aceptar pedidos sólo
  de Sala. Las firmas que recibe son más largas que los 10 minutos por defecto
  (hasta `VENCE_MAXIMO`), o las pide al empezar cada trabajo.
- **Se duerme cuando no hay trabajo** (Serverless de Railway, ver
  docs.railway.com/deployments/serverless). Railway lo duerme entre 5 y 10
  minutos después de su último tráfico saliente, y lo despierta un pedido por
  la red privada. De ahí salen cuatro reglas:
  - Nada de conexión abierta a Mongo en el trabajador: lo tendría despierto
    todo el mes. Habla sólo con Sala, por HTTP.
  - El primer pedido después de dormir puede dar 502: Sala reintenta.
  - Un render no manda tráfico. El trabajador avisa el progreso a Sala cada
    30 s: sirve para la barra del creador y evita que lo duerman a mitad.
  - Un trabajo por vez. La cola vive en Mongo, del lado de Sala.
- **Bucket aparte para los clips**, con una regla de ciclo de vida de R2
  "borrar a los 7 días" sobre todo el bucket. Las claves siguen empezando con
  `<slug>/`. En el bucket de las pelis no hay una regla por prefijo que sirva
  para todos los slugs, y los clips le comerían los GB a la Sala. `r2.js` tiene
  que aceptar el bucket como parámetro.

### Un clip, paso a paso

1. **Subir.** Sala firma un PUT a `<slug>/<id>/original.mp4` y el navegador
   sube directo. El largo y el peso se comprueban en el trabajador con
   `ffprobe`, no con lo que dice el navegador.
2. **Marco**, la primera vez o si cambió su overlay. Un cuadro del clip en
   pantalla: el creador arrastra un rectángulo sobre su cámara y otro sobre la
   parte del juego que quiere. Queda en su documento (`marco: { cam, juego }`).
   Casos que tiene que cubrir:
   - cámara arriba a la izquierda (como istincho), a la derecha o abajo;
   - sin cámara (todo juego);
   - charla, sólo cámara: el layout 4:5 de `reel_charla.py`
     (`E:\Videos-IA\herramientas`, tampoco está en git).

   Si el rectángulo del juego pisa la cámara, aviso: saldría dos veces.
3. **Transcribir.** El trabajador corre `transcribe.py` con el prompt del juego
   que eligió el creador y devuelve las palabras con sus tiempos.
4. **Editor de subtítulos.** Chunks de 1 a 4 palabras ya armados. El creador:
   - corrige palabras;
   - une o parte chunks;
   - toca cada línea para elegir la voz: él o un personaje, cada uno con su color;
   - marca "sin subtítulo" lo que no se entiende;
   - opcional: censura con asteriscos y silencio en el audio, como `reel_charla.py`.

   La vista previa es CSS aproximado; el render final lo hace libass. El editor
   se muestra siempre antes de armar.
5. **Gancho.** Línea de tiempo con la forma de onda: el creador marca el remate
   (2 a 3 s) y escribe dos renglones. Si el clip ya arranca fuerte, sólo el
   texto. El nombre del juego va en `--game` (TikTok lo lee para la búsqueda).
6. **Cartel.** El creador elige una plantilla. Sólo depende de sus handles y
   logos, así que se graba una vez por creador y plantilla y se reutiliza: no
   hace falta un navegador en cada render. Va unos 5 s a mitad del clip.
7. **Armar.** El trabajador corre `coldopen` → `captions` → `hook` → `reel.sh`
   → loudnorm. Sube `final.mp4` y la portada (el cuadro 0). Si todo salió bien,
   borra el original: el creador puede re-armar desde el `final` o subir de nuevo.
8. **Entregar.** Descarga firmada del mp4 y el texto del post: frase, pregunta,
   "En vivo en Kick (…) y Twitch (…)" con sus handles y 5 hashtags. En la
   Fase A sale de una plantilla con lo que escribió; en la B lo sugiere un LLM.

### Seguridad, en corto

- Ids de clip generados por el servidor. El trabajador recibe números y textos
  validados, nunca nombres de archivo ni pedazos de filtro de ffmpeg.
- Lo que escribe el creador (subtítulos, gancho) termina dentro de un ASS:
  escapar `{`, `}`, `\` y los saltos de línea, o puede meter tags de libass.
  Fuentes, sólo las de la imagen.
- Tope de largo y de peso antes de transcribir: un archivo de 2 horas trabaría
  la cola de todos.
- Hay caras y voces, a veces de terceros. Todo se borra a los 7 días, y así lo
  dicen los términos y la privacidad. Si en la Fase B el audio va a un servicio
  externo, se avisa ahí.

---

## 4. Costos

Precios de docs.railway.com/pricing/plans, mirados el 2026-10-28:
**CPU USD 0,000463 por vCPU-minuto, RAM USD 0,000231 por GB-minuto, builds
gratis, el plan Hobby incluye USD 5 de uso.**

Estimación por clip de 30 s, a medir con el primero:

| Qué | Cuánto | USD |
|---|---|---|
| Transcribir + armar | 3 a 4 min con 4 a 8 vCPU ocupados (20 a 30 vCPU-min) | 0,010 a 0,014 |
| RAM | unos 3 GB mientras trabaja + 5 a 10 min despierto después | 0,005 a 0,010 |
| **Por clip** | | **0,015 a 0,025** |

- 100 clips al mes son USD 1,5 a 2,5: entran en los USD 5 que ya se pagan
  (el servidor de Sala gasta 1 a 2).
- **Sin Serverless no cierra:** el modelo cargado ocupa 2 GB, y prendido todo
  el mes son USD 10 sólo de RAM. Por eso es una condición, no una opción.
- **R2:** los 10 GB gratis son por cuenta, así que pelis y clips los
  comparten. Un reel de 50 s pesa unos 28 MB. Borrando el original al terminar
  y el resto a los 7 días, 100 clips por semana ocupan unos 3 GB.
- **LLM de la Fase B:** es un gasto fuera de Railway y se decide con esa fase.

---

## 5. Fases

### Fase A — Clips para vos y amigos (2 a 3 semanas)

Trabajador con su Dockerfile, cola, subida, marco, editor de subtítulos,
gancho, 2 o 3 plantillas de cartel, armado, descarga y texto del post. Sólo
para los planes dueño y amigo; no hay cobro nuevo.

**Hecho cuando:** istincho sube un clip de Kick y sale el mismo reel que hoy
con la skill. Se compara lado a lado con uno que ya esté en `PUBLICADO.md` de
CosasStream.

### Fase B — Ayuda automática (1 a 2 semanas)

Un LLM propone:
- las correcciones de ortografía rioplatense;
- quién habla, leyendo la franja de subtítulos del juego (con visión);
- el remate para el *cold open* y el texto del gancho;
- la frase del post y los hashtags.

Siempre como propuesta que el creador acepta, nunca directo.

### Fase C — Cobro y comodidades

- Clips en el plan pago, con minutos por mes en una variable, como `GB_PAGO`.
- Importar por link de clip de Kick o Twitch. Antes, verificar si las
  plataformas lo permiten oficialmente.
- Separar la música con Demucs (copyright). Es pesado: unas 2 veces el tiempo
  real en CPU.
- Publicar directo en TikTok, YouTube o Instagram: cada API pide revisión de
  la app, una por una.

### Fuera de este plan

- **Edición de autor.** Cámara lenta interpolada, congelados, recuadros de
  cómic, el reloj de RE0.
- **Carteles temáticos de juegos** (RE, Lies of P, Marvel Rivals, Detroit).
  Usan la identidad visual de cada juego, y en un producto pago es riesgo de
  marca. Siguen en la skill para el canal de istincho.

---

## 6. Riesgos

| Riesgo | Qué pasa | Qué hacemos |
|---|---|---|
| Railway duerme el trabajador a mitad de un render | Se pierde el trabajo | Progreso cada 30 s; si igual se corta, Sala lo reencola |
| Muchos creadores a la vez | La cola espera | Tope por plan. Si crece, una segunda réplica (Hobby deja hasta 6) |
| Whisper falla con otros acentos o con la música del juego | Subtítulos malos | El editor se muestra siempre antes de armar |
| Clip con música con copyright | Reclamo en YouTube o Instagram | Aviso al subir; Demucs en la Fase C |
| Short de más de 60 s con reclamo de Content ID | Bloqueado en todo el mundo | Tope de 60 s para el reel |
| Cámara en un lugar raro o sin marco | Layout feo | Rectángulos libres y vista previa del cuadro antes de armar |
| Texto del creador o datos del cliente dentro de un ASS o de ffmpeg | Render roto o algo peor | Ver "Seguridad, en corto" |
| El uso pasa de USD 5 | Cobro extra | Costo por clip en `/panel` y tope por plan |

---

## 7. Decisiones del dueño, antes de la Fase A

- [ ] **Dónde se renderiza.** En el trabajador de Railway (recomendado:
  reusa los scripts como están) o en el navegador del creador (gratis, pero es
  reescribir todo y la transcripción sale peor).
- [ ] **Transcripción.** Con la CPU del trabajador (recomendado para la A:
  respeta "sólo Railway pago") o con una API externa (más rápida, pero suma un
  proveedor y el audio sale a terceros).
- [ ] **Plantillas de cartel de arranque.** Cuántas y cuáles. Propuesta: una
  limpia, una de HUD genérico y una de cómic.
- [ ] **Largo máximo del reel.** Propuesta: 60 s (ver Riesgos).
- [ ] **Clips en el plan pago de hoy o como agregado con precio propio.** Se
  decide antes de la Fase C.

## 8. Qué va a hacer falta de tu lado

Se pasa a `TAREAS-DUENO.md` cuando arranque la Fase A. Todo por el dashboard,
nunca por la terminal (pantalla al aire):

- Servicio nuevo `trabajador` en el proyecto de Railway de Sala, con
  Serverless prendido.
- Bucket de R2 nuevo para los clips, con la regla de borrar a los 7 días.
- Un token compartido Sala ↔ trabajador, cargado como variable en los dos
  servicios. Los nombres de las variables los define la fase.
