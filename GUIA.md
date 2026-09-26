# Guía: poner a andar el multichat y repartirlo

Fecha: 2026-09-22. Para el dueño del servicio (`istincho`). Lo que sigue es
todo lo que hay que hacer a mano; el código ya está en producción.

---

## 0. Qué es esto

`https://multichat-osmiumstudio.pages.dev` es una ventana que muestra el chat
de Kick y el de Twitch juntos, en vivo. Cada streamer abre el suyo y le pasa un
link a su comunidad; ahí cada espectador conecta su Kick y/o su Twitch y escribe
con **su** cuenta, a una red o a las dos a la vez.

**No va en OBS.** Las reglas de simulcast de Twitch prohíben mostrar en el
stream un chat combinado con otras plataformas. Se usa en otra ventana o en el
segundo monitor. Verlo en privado está permitido.

La Sala de películas existe en el código pero está **apagada para todos**. Se
prende desde el panel cuando se quiera; hasta entonces `/sala/<slug>` no existe.

---

## 1. Lo que sólo podés hacer vos (una sola vez)

Los dos primeros pasos son los que hacen que el login funcione con el dominio
lindo. **En este orden**: al revés, el login rebota con "redirect_uri mismatch".

### 1.1 Registrar el dominio en las dos apps

Las dos aceptan varios redirects. Los de Railway quedan como están.

| Dónde | Qué agregar |
|---|---|
| kick.com → Settings → Developer → tu app | `https://multichat-osmiumstudio.pages.dev/oauth/kick/volver` |
| dev.twitch.tv/console/apps → tu app | `https://multichat-osmiumstudio.pages.dev/oauth/twitch/volver` |

### 1.2 Una variable en Railway

Servicio `sala` → Variables → New Variable:

```
ORIGENES=https://multichat-osmiumstudio.pages.dev
```

No es un secreto. Railway se redeploya solo. Sin esta variable no se rompe
nada: el login sigue andando por el dominio de Railway.

### 1.3 Abrir tu propio chat

`/panel` → entrar con Kick → **Chat para tu comunidad** → **Abierto**.
Elegís qué redes se ven (por defecto las dos) y copiás el link.

Si Twitch te figura sin vincular, se vincula desde el mismo panel.

### 1.4 Probarlo antes de repartirlo

1. Abrí tu link en una ventana privada: tienen que verse los dos chats.
2. Conectá una cuenta secundaria de Kick y escribí: tiene que salir en
   kick.com con esa cuenta.
3. Lo mismo con una cuenta secundaria de Twitch.
4. Probá **"las dos"**: un mensaje, los dos chats.
5. Bloqueá a esa cuenta desde su mensaje y comprobá que ya no puede escribir.
6. Escribí el nombre exacto de un emote de tu 7TV (respeta mayúsculas, y tiene que ir
   como palabra suelta): tiene que verse la imagen, no la palabra.
7. Tocá **Emotes** al lado de la caja, elegí uno y mandalo. El botón está en tu ventana
   (`/chat`) y en la de tu comunidad (`/chat/<slug>`).
8. Tocá **Mi color**, elegí uno y guardá: tu nombre tiene que quedar pintado con ése, y los
   mensajes tuyos que ya estaban en pantalla también.

### El color de cada uno (2026-09-25)

Cualquiera que conecte su cuenta en tu chat puede elegir **su** color con el botón **Mi color**,
al lado de la caja. Tres cosas que conviene saber:

- **Se ve sólo acá.** En kick.com y en twitch.tv esa persona sigue saliendo con el color que le
  da cada plataforma. El panel se lo dice cuando elige.
- **Es de la persona, no de tu sala.** Lo elige una vez y le sirve en el chat de cualquier
  creador que use esto. Quien no elige nada queda con el color de su plataforma, como siempre.
- **Nadie puede quedar ilegible**: si el color que eligió no se lee sobre el fondo, se ajusta
  solo al tono más cercano que sí se lea, y funciona igual con el tema claro y con el oscuro.

Si alguien se pasa de vivo con el color, en **tu** ventana (`/chat`) cada mensaje de quien
eligió uno tiene un botón **color** al lado del de **bloquear**. Le saca el color y lo deja con
el de su plataforma; **no** lo bloquea, y puede volver a elegir otro (si insiste, ahí sí está
bloquear). **Ojo**: como el color es de la persona y no de tu sala, sacárselo también hace que
deje de verse en el chat de otros creadores.

Vos, para tener tu propio color, conectá tu cuenta como uno más en tu `/chat/<tu-slug>` y
elegilo ahí: después se ve también en tu ventana.

**Los emotes de 7TV ya se ven**, los tuyos y los globales, en Kick y en Twitch. Si sólo tenés
7TV activado en una de las dos redes, tus emotes también aparecen en los mensajes de la otra:
no hace falta tener cuenta de 7TV en las dos. Los que pesen
más de 128 KB hasta en su tamaño más chico no salen a propósito: se los bajaría el navegador de
cada persona que esté mirando. Si te hacés una cuenta de 7TV recién ahora, puede tardar hasta
una hora en aparecer; un deploy lo resuelve en el acto.

**El botón Emotes** (2026-09-23) ofrece tres cosas: los emotes de tu 7TV, **los nativos de tu
Twitch** (los de suscriptor y los globales tipo Kappa) y **los de Kick que ya pasaron por ese
chat** — de Kick no hay forma de pedirle la lista, así que la lista crece con lo que la
comunidad usa y arranca vacía. El panel lo dice en un renglón, y el porqué completo se abre si
alguien toca ahí.

Lo de los emotes de Kick se volvió a investigar el 2026-09-25 (`INVESTIGACION-EMOTES-KICK.md`):
**sigue sin haber forma oficial**, y la que hay la prohíben los términos. Hay una salida sin
riesgo —que vos pegues tu lista una vez— que está descripta ahí y **no está construida**: es
para que decidas.

Dos cosas que conviene saber antes de que alguien pregunte:

- Un emote de Kick mandado **a las dos redes** sale dibujado en Kick y como palabra en Twitch.
  El panel avisa antes de mandar. Al revés es igual: un emote de tu Twitch, en Kick se lee.
- Tus emotes de suscriptor de Twitch los ve dibujados **quien esté suscripto**; al resto les
  llega la palabra. Eso lo decide Twitch y no se puede saber de antemano sin pedirle un permiso
  nuevo a cada espectador.

---

## 2. Lo de CosasStream (los overlays), aparte

Esto no es del multichat, es del stream.

1. **Fuera de cámara**: panel de CosasStream → Servidor → Twitch → **Volver a
   conectar**. Ahora pide un permiso más (leer el chat), que es lo que hace que
   los emotes de Twitch se pinten. Sin eso las alertas andan igual.
2. En OBS, **refrescar las fuentes Chat y Emotes** una vez.
3. Verificar: el panel dice "7/7 eventos" y `/salud` muestra `"chat":true`.

Pendiente de decidir: el overlay de Emotes tira emotes del chat de Kick
mientras transmitís a Twitch. Si eso cuenta como "mostrar el chat de otra
plataforma" es discutible y no hay respuesta oficial. El dato para filtrar por
plataforma ya viaja: es decidir, no programar.

---

## 3. Cómo se lo pasás a un colega

Le mandás **el link de alta**, no el tuyo:

```
https://multichat-osmiumstudio.pages.dev/crear
```

Lo que hace el colega, solo, en tres minutos:

1. Entra, acepta los términos y se loguea **con Kick**. Ahí queda creada su sala.
2. En su panel, **vincula Twitch**.
3. **Chat para tu comunidad** → Abierto → copia su link
   (`…/chat/<su-slug-de-kick>`).
4. Se lo pasa a su gente, o se lo guarda para él y lo abre en el segundo monitor.

No necesita crear ninguna app ni tocar ninguna clave: las apps de Kick y de
Twitch son las tuyas y el servidor se suscribe a los eventos de su canal cuando
autoriza.

### Lo que hay que decirle igual

- **No lo pongas en OBS** si transmitís a Twitch. Es contra sus reglas.
- Su chat nace **cerrado**: hasta que no lo abra, el link no muestra nada.
- Leer no pide login; escribir sí, y cada uno escribe con su propia cuenta.
- Hoy es **gratis** y sin límite de gente.

### Lo que NO le prometas todavía

- La Sala de películas está apagada.
- Un colega **sólo de Twitch** hoy no puede darse de alta: el alta es con Kick.
  Está planificado (fase 5.5 de `PLAN-MULTICHAT.md`) y no construido.

---

## 4. Los límites reales

| Qué | Límite | Qué pasa al llegar |
|---|---|---|
| Canales de Kick suscritos | 1.000 (app sin verificar) | El chat de los que entren queda mudo. `/crear` corta en 900 y `/admin` avisa a la mitad: **pedir la verificación antes de los 500** |
| Railway | USD 5/mes que ya pagás | El servidor no sirve video; un Node chico gasta 1 a 2 |
| Cloudflare Pages | Gratis | Es sólo la puerta de entrada: reenvía todo a Railway |
| Mensajes por persona | 1 cada 2 s | Encima está el límite de cada plataforma |

Quién tiene sala, con qué plan y cuánto usa se ve en `/admin`, que sólo abre
tu cuenta.

---

## 5. Si algo no anda

| Síntoma | Dónde mirar |
|---|---|
| El chat de alguien está mudo | `/panel` de esa persona: el indicador de salud dice si Kick o Twitch están caídos, y hay botón para resuscribir |
| "redirect_uri mismatch" al conectar | Falta el paso 1.1, o falta la variable del 1.2 |
| El link no muestra nada | Ese chat está cerrado. Panel → Chat para tu comunidad |
| Twitch no llega y Kick sí | La salud lo marca; si dice `modo: "irc"`, EventSub se cayó y está el plan B leyendo igual |

Estado general: `https://multichat-osmiumstudio.pages.dev/api/estado`
