/* ============================================================
   Traductores: de lo que manda cada plataforma al UNICO formato de
   mensaje que sale por SSE.

   El formato es este y no cambia:

     {
       tipo: "chat",
       red: "kick" | "twitch",
       id, usuario, usuarioId, color,
       insignias: [{ tipo, texto }],
       texto,
       emotes: [{ id, inicio, fin, url, fuente }],
       hora,                       // ISO
       respondeA?: { id, usuario, texto }
     }

   ---------------------------------------------------------------
   DE DONDE SALIO CADA EMOTE: `fuente`

   Vale 'kick' o 'twitch' para los que manda la plataforma, y '7tv'
   para los que resuelve `emotes.js` por palabra. Los traductores de
   aca solo ponen los dos primeros.

   Esta en TODOS los emotes y no solo en los de terceros a proposito:
   un array donde algunos elementos tienen una clave y otros no es la
   forma de que el dia que alguien la use se le rompa justo con los
   mensajes de una red. Es aditivo: un cliente viejo lo ignora. Hoy la
   pagina no lo mira; esta para quien quiera decir en pantalla de donde
   salio el emote, que es una decision de diseño todavia abierta.

   ---------------------------------------------------------------
   POR QUE VIAJA `usuarioId`

   Es el id de quien escribio EN SU RED, y esta para una sola cosa:
   que el creador pueda bloquear a alguien en esta herramienta desde
   el menu de su mensaje (Fase 5.4). Por nombre no sirve: los nombres
   se cambian, y el que se bloqueo ayer puede ser otra persona manana.

   Sale por el bus para todos, no solo para el creador, y eso se
   penso: es el mismo id que Kick manda en `sender.user_id` y Twitch
   en `chatter_user_id` (y en el tag `user-id` de IRC) a cualquiera
   que lea ese chat publico. No es un dato nuestro sobre nadie; es lo
   que la plataforma ya publica de un mensaje publico. Filtrarlo por
   conexion costaria una copia del objeto por mensaje y por persona
   mirando, para esconder algo que esta a un pedido de distancia.

   ---------------------------------------------------------------
   POR QUE UN SOLO FORMATO Y NO EL PAYLOAD CRUDO

   La pagina no tiene por que saber que Kick llama `content` a lo que
   Twitch llama `message.text`, ni que uno manda los emotes
   incrustados en el texto y el otro en un array de fragmentos. Si esa
   diferencia llega al navegador, cada pantalla que muestre un chat
   (la de /chat, la de la Sala en la Fase 2) tiene que aprenderla de
   nuevo, y el dia que se sume una tercera red hay que tocarlas todas.
   Aca se traduce una vez.

   ---------------------------------------------------------------
   LOS INDICES DE LOS EMOTES SON PUNTOS DE CODIGO, Y EL FIN ES
   EXCLUSIVO

   `inicio` y `fin` cuentan puntos de codigo Unicode sobre `texto`, y
   el emote ocupa [inicio, fin). Se eligio asi por dos motivos:

     1. Un indice de string de JavaScript cuenta unidades UTF-16, o
        sea que un emoji fuera del plano basico (💀, la mitad del chat
        de Kick) cuenta dos. Twitch, en cambio, indexa por punto de
        codigo en su tag `emotes` de IRC. Mezclar las dos unidades
        desalinea todos los emotes que vengan despues del primer
        emoji, que es exactamente el bug que nadie encuentra mirando
        el codigo.
     2. Fin exclusivo porque es la convencion de slice() y evita el
        +1 olvidado. Twitch por IRC manda el fin INCLUSIVO: la
        conversion se hace aca, una vez, y no en cada pagina.

   El cliente corta con `[...texto]`, no con `texto.slice`.

   ---------------------------------------------------------------
   DE DONDE SALEN LAS POSICIONES EN KICK

   Kick manda el emote dos veces: incrustado en `content` como
   `[emote:4148074:HYPERCLAP]` y aparte en un array `emotes` con
   posiciones `{s, e}`. NO se usan esas posiciones: son indices sobre
   el `content` con el markup adentro, o sea sobre un texto que el
   usuario nunca ve, y en los payloads observados no coinciden con el
   markup (arrancan corridas en uno). Aca se parsea el markup, que es
   la fuente de verdad de donde esta cada emote, se lo reemplaza por
   el nombre del emote —que es lo que se muestra si la imagen no
   carga— y se calculan las posiciones sobre el texto resultante.
   Coincidir con el array de Kick no sirve de nada; coincidir con lo
   que se ve en pantalla, si.
   ============================================================ */

/* La CDN de emotes de Kick. El id es el numero que viene en el
   markup. */
export const URL_EMOTE_KICK = id => `https://files.kick.com/emotes/${id}/fullsize`;

/* La CDN oficial de Twitch. `default` deja que Twitch elija entre la
   version estatica y la animada segun lo que exista para ese emote;
   `dark` porque la pagina es oscura por defecto y los emotes con
   borde claro se pierden sobre el fondo; `2.0` es el tamaño mediano,
   que en una lista de chat se ve bien sin pesar como el 3.0. */
export const URL_EMOTE_TWITCH = id =>
  `https://static-cdn.jtvnw.net/emoticons/v2/${id}/default/dark/2.0`;

/* Un color de chat va derecho a un atributo `style` del lado del
   cliente. Se valida aca ademas de alla: la pagina no tiene por que
   ser la unica que se acuerde. */
const COLOR_VALIDO = /^#[0-9a-f]{6}$/i;
const colorSeguro = c => (typeof c === 'string' && COLOR_VALIDO.test(c) ? c.toLowerCase() : '');

/* Un texto que llega de afuera y que se va a repartir a todo el que
   este mirando. El recorte no es cosmetico: sin tope, un mensaje
   armado a mano por la API de Kick (que permite mas que la caja del
   navegador) se guarda 200 veces en el buffer de cada canal. */
const TOPE_TEXTO = 2000;
const limpiar = s => String(s ?? '').slice(0, TOPE_TEXTO);

/* Cuantos puntos de codigo tiene un texto. `.length` contaria
   unidades UTF-16 y romperia los indices de emotes en cuanto haya un
   emoji. */
const largoEnPuntos = s => {
  let n = 0;
  for (const _ of s) n++;
  return n;
};

/* -------------------------------------------------------- insignias

   Kick manda el nombre legible de la insignia; Twitch manda solo el
   id del set ("moderator", "subscriber") y hay que traducirlo. Los
   que no estan en la tabla se muestran con su id: es feo, pero es
   mejor que esconder una insignia que existe, y avisa que hay una
   nueva para agregar. */

const NOMBRES_TWITCH = {
  broadcaster: 'Streamer',
  moderator: 'Mod',
  subscriber: 'Sub',
  vip: 'VIP',
  founder: 'Fundador',
  staff: 'Staff',
  admin: 'Admin',
  global_mod: 'Mod global',
  turbo: 'Turbo',
  premium: 'Prime',
  partner: 'Verificado',
  bits: 'Bits',
  'bits-leader': 'Bits',
  'sub-gifter': 'Regala subs',
  'sub-gift-leader': 'Regala subs',
  'hype-train': 'Hype train',
  'artist-badge': 'Artista',
  'moments': 'Momento',
  'predictions': 'Prediccion',
  'no_audio': 'Sin audio',
  'no_video': 'Sin video',
  'glhf-pledge': 'GLHF',
};

const TOPE_INSIGNIAS = 12;

function insigniasDeKick(identity) {
  const lista = Array.isArray(identity?.badges) ? identity.badges : [];
  return lista.slice(0, TOPE_INSIGNIAS).map(b => {
    const texto = String(b?.text ?? b?.type ?? '').slice(0, 40);
    /* El contador solo se muestra si dice algo: "Sub" y "Sub (1)" son
       lo mismo y el parentesis solo ocupa lugar. */
    const cuenta = Number(b?.count);
    return {
      tipo: String(b?.type ?? '').slice(0, 40),
      texto: Number.isFinite(cuenta) && cuenta > 1 ? `${texto} (${cuenta})` : texto,
    };
  }).filter(b => b.texto || b.tipo);
}

function insigniasDeTwitch(badges) {
  const lista = Array.isArray(badges) ? badges : [];
  return lista.slice(0, TOPE_INSIGNIAS).map(b => {
    const tipo = String(b?.set_id ?? '').slice(0, 40);
    const base = NOMBRES_TWITCH[tipo] ?? tipo;
    /* `info` trae los meses de suscripcion o la cantidad de bits
       segun la insignia. Cuando es un numero mayor a uno vale la pena
       mostrarlo; el resto de las veces es ruido ("1", o vacio). */
    const info = String(b?.info ?? '').trim();
    const n = Number(info);
    const texto = Number.isFinite(n) && n > 1 ? `${base} (${n})` : base;
    return { tipo, texto };
  }).filter(b => b.texto || b.tipo);
}

/* ------------------------------------------------------------- Kick */

/* `[emote:ID:NOMBRE]`. El nombre puede traer cualquier cosa menos un
   corchete de cierre; el id de Kick es numerico. Con `g` para
   recorrer todas las apariciones. */
const MARCA_EMOTE_KICK = /\[emote:(\d+):([^\]]*)\]/g;

/**
 * Parte el `content` de Kick en el texto que ve la persona y las
 * posiciones de los emotes sobre ESE texto.
 */
export function partirTextoDeKick(content) {
  const crudo = limpiar(content);
  const emotes = [];
  let texto = '';
  let puntos = 0;      // cuantos puntos de codigo lleva `texto`
  let desde = 0;       // por donde va el recorrido de `crudo`

  MARCA_EMOTE_KICK.lastIndex = 0;
  for (let m = MARCA_EMOTE_KICK.exec(crudo); m; m = MARCA_EMOTE_KICK.exec(crudo)) {
    const antes = crudo.slice(desde, m.index);
    texto += antes;
    puntos += largoEnPuntos(antes);

    const id = m[1];
    /* El nombre es lo que se muestra si la imagen no carga, y es el
       alt de la etiqueta. Un emote sin nombre igual tiene que ocupar
       lugar: si no, `inicio` y `fin` serian iguales y el cliente no
       tendria nada que reemplazar. */
    const nombre = m[2] || `emote${id}`;
    const inicio = puntos;
    texto += nombre;
    puntos += largoEnPuntos(nombre);

    emotes.push({ id, inicio, fin: puntos, url: URL_EMOTE_KICK(id), fuente: 'kick' });
    desde = m.index + m[0].length;
  }
  texto += crudo.slice(desde);

  return { texto, emotes };
}

/**
 * Un `chat.message.sent` de Kick al formato unico.
 *
 * @param {object} cuerpo  el payload del webhook, ya parseado
 * @param {{hora?:string}} opciones  `hora` de respaldo (el header del
 *        webhook) para cuando el payload no trae created_at
 * @returns {object|null} null si no se parece a un mensaje de chat
 */
export function deKick(cuerpo, { hora } = {}) {
  if (!cuerpo || typeof cuerpo !== 'object') return null;
  const emisor = cuerpo.sender;
  if (!emisor) return null;

  const { texto, emotes } = partirTextoDeKick(cuerpo.content);
  const identidad = emisor.identity ?? null;   // puede venir null, y viene

  const mensaje = {
    tipo: 'chat',
    red: 'kick',
    id: String(cuerpo.message_id ?? ''),
    usuario: String(emisor.username ?? '').slice(0, 80),
    usuarioId: String(emisor.user_id ?? ''),
    color: colorSeguro(identidad?.username_color),
    insignias: insigniasDeKick(identidad),
    texto,
    emotes,
    hora: horaIso(cuerpo.created_at ?? hora),
  };

  const padre = cuerpo.replies_to;
  if (padre) {
    mensaje.respondeA = {
      id: String(padre.message_id ?? ''),
      usuario: String(padre.sender?.username ?? '').slice(0, 80),
      /* Del padre solo se muestra un recorte, asi que no vale la pena
         resolverle los emotes: se le saca el markup y listo. */
      texto: partirTextoDeKick(padre.content).texto.slice(0, 200),
    };
  }

  return mensaje;
}

/** Si un canal de Kick esta en vivo, segun livestream.status.updated. */
export function vivoDeKick(cuerpo) {
  if (!cuerpo || typeof cuerpo !== 'object') return null;
  if (typeof cuerpo.is_live === 'boolean') return cuerpo.is_live;
  return null;
}

/* ----------------------------------------------------------- Twitch */

/**
 * Un `channel.chat.message` de EventSub al formato unico.
 *
 * El texto se rearma concatenando los fragmentos y no se toma
 * `message.text` directamente: asi las posiciones de los emotes salen
 * de la misma pasada que el texto y no pueden desincronizarse. Los
 * dos tienen que dar lo mismo; si algun dia no dieran, el que manda
 * es el que se ve.
 *
 * @param {object} evento    payload.event de la notificacion
 * @param {object} metadata  metadata de la trama (trae el timestamp:
 *                           el evento no lo trae)
 */
export function deTwitch(evento, metadata = {}) {
  if (!evento || typeof evento !== 'object') return null;

  const fragmentos = Array.isArray(evento.message?.fragments)
    ? evento.message.fragments
    : null;

  let texto = '';
  let puntos = 0;
  const emotes = [];

  if (fragmentos) {
    for (const f of fragmentos) {
      const trozo = String(f?.text ?? '');
      const inicio = puntos;
      texto += trozo;
      puntos += largoEnPuntos(trozo);
      const id = f?.type === 'emote' ? f?.emote?.id : null;
      /* `puntos > inicio` y no solo `id`: un fragmento de emote con el
         texto vacio daria un rango de largo CERO. Los otros dos
         traductores ya no pueden emitir uno (Kick le pone un nombre de
         respaldo al emote sin nombre, y `deIrc` descarta `fin <=
         inicio`); este era el unico que si. Un rango vacio no tapa
         ningun texto, no se ve, y hace que lo que se dibuje encima se
         dibuje dos veces. */
      if (id && puntos > inicio) {
        emotes.push({
          id: String(id), inicio, fin: puntos, url: URL_EMOTE_TWITCH(id), fuente: 'twitch',
        });
      }
      if (texto.length > TOPE_TEXTO) break;
    }
  } else {
    texto = limpiar(evento.message?.text);
  }
  texto = limpiar(texto);

  /* EL RECORTE PUEDE DEJAR EMOTES FUERA DEL TEXTO, y hay que tirarlos.

     Son dos cortes que no miden lo mismo: el `break` de arriba corta
     DESPUES de haber agregado el fragmento, y `limpiar()` recorta por
     unidades UTF-16 mientras los indices de los emotes cuentan puntos
     de codigo. Con un mensaje en el limite, el ultimo emote queda
     apuntando mas alla del final del texto, y `agregarTextoConEmotes()`
     de la pagina, que avanza un cursor y corta `[...texto]` con esos
     indices, se come el texto que viniera despues.

     `deIrc` ya descarta los indices que caen fuera del texto por este
     mismo motivo; esto es lo mismo, del otro lado. */
  const largoFinal = largoEnPuntos(texto);
  const dentro = emotes.filter(e => e.fin <= largoFinal);

  const mensaje = {
    tipo: 'chat',
    red: 'twitch',
    id: String(evento.message_id ?? ''),
    /* chatter_user_name es el nombre con mayusculas que la persona
       eligio; chatter_user_login es el de la URL, todo en minuscula.
       Se muestra el primero. */
    usuario: String(evento.chatter_user_name ?? evento.chatter_user_login ?? '').slice(0, 80),
    usuarioId: String(evento.chatter_user_id ?? ''),
    color: colorSeguro(evento.color),
    insignias: insigniasDeTwitch(evento.badges),
    texto,
    emotes: dentro,
    hora: horaIso(metadata?.message_timestamp),
  };

  const padre = evento.reply;
  if (padre) {
    mensaje.respondeA = {
      id: String(padre.parent_message_id ?? ''),
      usuario: String(padre.parent_user_name ?? padre.parent_user_login ?? '').slice(0, 80),
      texto: String(padre.parent_message_body ?? '').slice(0, 200),
    };
  }

  return mensaje;
}

/* -------------------------------------------------- Twitch, por IRC

   El plan B. Los mismos mensajes llegan con otra forma: tags IRCv3 en
   vez de JSON.

   Dos diferencias con EventSub que hay que tener presentes:

     - El tag `emotes` da los indices INCLUSIVOS y en puntos de
       codigo. El formato unico los quiere exclusivos, asi que va un
       +1. Este es el unico +1 del proyecto y esta aca.
     - No hay fragmentos: el texto llega entero y los emotes se ubican
       por indice. Si el indice cae fuera del texto (pasa con mensajes
       con /me o con tags de otra version) el emote se descarta en vez
       de mandar un rango invalido al navegador. */

function emotesDeTag(tag, texto) {
  if (!tag) return [];
  const puntos = [...texto];
  const emotes = [];
  for (const grupo of String(tag).split('/')) {
    const dosPuntos = grupo.indexOf(':');
    if (dosPuntos < 0) continue;
    const id = grupo.slice(0, dosPuntos);
    for (const rango of grupo.slice(dosPuntos + 1).split(',')) {
      const [a, b] = rango.split('-');
      const inicio = Number(a);
      const finInclusivo = Number(b);
      if (!Number.isInteger(inicio) || !Number.isInteger(finInclusivo)) continue;
      const fin = finInclusivo + 1;
      if (inicio < 0 || fin <= inicio || fin > puntos.length) continue;
      emotes.push({ id, inicio, fin, url: URL_EMOTE_TWITCH(id), fuente: 'twitch' });
    }
  }
  emotes.sort((x, y) => x.inicio - y.inicio);
  return emotes;
}

function insigniasDeTagIrc(badges, badgeInfo) {
  if (!badges) return [];
  /* badge-info trae el dato fino (los meses reales de suscripcion)
     que badges no tiene: en badges el subscriber siempre dice la
     version del icono, no los meses. */
  const info = new Map();
  for (const par of String(badgeInfo ?? '').split(',')) {
    const [k, v] = par.split('/');
    if (k) info.set(k, v ?? '');
  }
  return String(badges).split(',').slice(0, TOPE_INSIGNIAS).map(par => {
    const [tipo] = par.split('/');
    if (!tipo) return null;
    const base = NOMBRES_TWITCH[tipo] ?? tipo;
    const n = Number(info.get(tipo));
    return { tipo, texto: Number.isFinite(n) && n > 1 ? `${base} (${n})` : base };
  }).filter(Boolean);
}

/**
 * Un PRIVMSG de IRC al formato unico.
 * @param {Map<string,string>} tags  los tags ya desescapados
 * @param {string} usuarioIrc        el nick del prefijo, por si no hay display-name
 * @param {string} texto             el cuerpo del PRIVMSG
 */
export function deIrc(tags, usuarioIrc, texto) {
  const t = tags instanceof Map ? tags : new Map(Object.entries(tags ?? {}));
  const cuerpo = limpiar(texto);

  const marca = Number(t.get('tmi-sent-ts'));
  const mensaje = {
    tipo: 'chat',
    red: 'twitch',
    id: String(t.get('id') ?? ''),
    usuario: String(t.get('display-name') || usuarioIrc || '').slice(0, 80),
    usuarioId: String(t.get('user-id') ?? ''),
    color: colorSeguro(t.get('color')),
    insignias: insigniasDeTagIrc(t.get('badges'), t.get('badge-info')),
    texto: cuerpo,
    emotes: emotesDeTag(t.get('emotes'), cuerpo),
    hora: horaIso(Number.isFinite(marca) && marca > 0 ? new Date(marca).toISOString() : null),
  };

  const padreId = t.get('reply-parent-msg-id');
  if (padreId) {
    mensaje.respondeA = {
      id: String(padreId),
      usuario: String(t.get('reply-parent-display-name') || t.get('reply-parent-user-login') || '').slice(0, 80),
      texto: String(t.get('reply-parent-msg-body') ?? '').slice(0, 200),
    };
  }

  return mensaje;
}

/* ------------------------------------------------------------ horas */

/**
 * Una fecha en ISO, siempre. Si lo que llego no se entiende, se usa
 * ahora: un mensaje con una hora rara es un mensaje que igual hay que
 * mostrar, y "sin hora" obligaria a cada pagina a tener un camino
 * aparte para eso.
 */
export function horaIso(cuando) {
  if (cuando instanceof Date && !Number.isNaN(cuando.getTime())) return cuando.toISOString();
  const t = Date.parse(String(cuando ?? ''));
  return Number.isFinite(t) ? new Date(t).toISOString() : new Date().toISOString();
}
