/* ============================================================
   Traductores: de lo que manda cada plataforma al UNICO formato de
   mensaje que sale por SSE.

   El formato es este y no cambia:

     {
       tipo: "chat",
       red: "kick" | "twitch",
       id, usuario, usuarioId, color,
       insignias: [{ tipo, version, texto, url }],
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
   nueva para agregar.

   ---------------------------------------------------------------
   `version` Y `url`, Y POR QUE ESTAN EN LAS TRES

   Cada insignia sale asi:

       { tipo, version, texto, url }

   `url` es la imagen, y la pone `insignias.js` DESPUES, con la misma
   division de trabajo que tienen los emotes de 7TV: los traductores de
   aca son puros —no conocen el slug de la sala ni una cache ni una
   API—, asi que salen con `url: ''` y el que sabe la completa.

   `version` es lo que hace falta para casarla. Twitch manda por
   mensaje `{ set_id, id, info }`, donde `id` NO son los meses sino
   cual de los dibujos del set corresponde: `subscriber` id "12" es el
   icono del tramo de 12 meses, y los meses de verdad van en `info`
   (verificado en el ejemplo de `channel.chat.message`, que trae
   `{"set_id":"subscriber","id":"12","info":"16"}`). Ese `id` es el que
   matchea con `versions[].id` de `helix/chat/badges`. Sin el, un sub
   de tres años se ve con el icono del primer mes.

   Las dos claves estan en TODAS las insignias y no solo en las que las
   necesitan —Kick no tiene versiones y su `version` es siempre ''—
   por el mismo motivo por el que `fuente` esta en todos los emotes: un
   array donde algunos elementos tienen una clave y otros no es la
   forma de que el dia que alguien la lea se le rompa justo con los
   mensajes de una red. Es aditivo: un cliente viejo las ignora. */

/* Sin prototipo, y no es purismo: `NOMBRES_TWITCH['constructor']`
   devolvia la funcion `Object`, y el `?? tipo` de abajo no la ataja
   porque no es null. Un `set_id` llamado `constructor`, `toString` o
   `hasOwnProperty` —que lo pone Twitch, no una persona, pero un
   traductor no tiene por que confiar en eso— salia en pantalla como el
   codigo fuente de una funcion, con el tope de 40 caracteres como unico
   freno. Con el prototipo nulo, cualquier nombre que no este en la
   tabla cae en el `?? tipo`, que es lo que hace desde siempre con un
   set_id que no conocemos. */
const NOMBRES_TWITCH = Object.assign(Object.create(null), {
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
});

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
      /* Kick no tiene versiones de insignia: manda un tipo y listo. */
      version: '',
      texto: Number.isFinite(cuenta) && cuenta > 1 ? `${texto} (${cuenta})` : texto,
      url: '',
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
    /* `id` es CUAL de los dibujos del set, no los meses. Ver el bloque
       de arriba: los meses son `info`, y mezclarlos le pone a un sub
       de tres años el icono del primer mes. */
    return { tipo, version: String(b?.id ?? '').slice(0, 40), texto, url: '' };
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
    /* `subscriber/12`: lo de despues de la barra es la VERSION, o sea
       cual de los dibujos del set. Es el mismo numero que EventSub
       manda como `id`, asi que las dos vias casan contra la misma
       tabla de `helix/chat/badges`. Antes se tiraba, y con el se
       tiraba el icono del tramo. */
    const [tipo, version] = par.split('/');
    if (!tipo) return null;
    const base = NOMBRES_TWITCH[tipo] ?? tipo;
    const n = Number(info.get(tipo));
    return {
      tipo,
      version: String(version ?? '').slice(0, 40),
      texto: Number.isFinite(n) && n > 1 ? `${base} (${n})` : base,
      url: '',
    };
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

/* -------------------------------------------------------- actividad

   Canjes de puntos, subs y follows de las dos redes, al mismo formato:

     {
       tipo: "actividad",
       red: "kick" | "twitch",
       id,                          // el del canje o del evento en su red
       clase: "canje" | "sub" | "resub" | "regalo" | "follow",
       usuario,                     // nombre publico, nada mas
       regalo, mensaje, cantidad, meses, costo,
       hora,                        // ISO
       publico                      // si puede salir por el bus de la sala
     }

   `publico` es la unica decision de privacidad de este bloque y se toma
   aca, al traducir, para que nadie mas tenga que acordarse:

     - Canjes y subs SI. Kick y Twitch ya los muestran en su propio chat
       a cualquiera que lo este mirando: no se cuenta nada nuevo.
     - Follows NO. Twitch no los muestra en ningun lado publico, y el bus
       de una sala lo escucha cualquiera sin login. Un follow va solo a la
       lista que ven el creador y sus mods (`servidor/actividad.js`).

   Como en los mensajes, solo va el nombre: nada de ids, avatares ni
   colores. La lista no los necesita y lo que no se guarda no se filtra.
   Los traductores devuelven null con lo que no entienden o lo que se
   descarta a proposito (un canje rechazado, una sub regalada suelta). */

const texto80 = v => String(v ?? '').slice(0, 80);
const texto200 = v => String(v ?? '').slice(0, 200);
const numeroONull = v => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);

function actividad(red, clase, datos) {
  return {
    tipo: 'actividad',
    red,
    id: String(datos.id ?? ''),
    clase,
    usuario: texto80(datos.usuario) || 'anonimo',
    regalo: texto80(datos.regalo),
    mensaje: texto200(datos.mensaje),
    cantidad: numeroONull(datos.cantidad),
    meses: numeroONull(datos.meses),
    costo: numeroONull(datos.costo),
    hora: horaIso(datos.hora),
    publico: clase !== 'follow',
  };
}

/* Los tipos de Kick que traduce `actividadDeKick`. Estan aca y no solo
   en EVENTOS de kick.js para que el webhook pueda preguntar "¿esto es
   actividad?" sin conocer la lista de suscripciones. */
export const TIPOS_ACTIVIDAD_KICK = Object.freeze([
  'channel.followed',
  'channel.subscription.new',
  'channel.subscription.renewal',
  'channel.subscription.gifts',
  'channel.reward.redemption.updated',
]);

/**
 * Un webhook de actividad de Kick al formato de arriba.
 * @param {string} tipo   el Kick-Event-Type
 * @param {object} cuerpo el payload
 * @param {{hora?:string}} opciones  la hora del header, de respaldo
 */
export function actividadDeKick(tipo, cuerpo, { hora } = {}) {
  if (!cuerpo || typeof cuerpo !== 'object') return null;
  const cuando = cuerpo.created_at ?? cuerpo.redeemed_at ?? hora;
  const nombre = u => u?.username ?? '';
  switch (tipo) {
    /* Sin la persona no hay nada que contar: un payload al que le falta
       quien siguio, se suscribio o canjeo se descarta, no sale como
       "anonimo". */
    case 'channel.followed':
      if (!cuerpo.follower) return null;
      return actividad('kick', 'follow', {
        id: `follow:${cuerpo.follower?.user_id ?? ''}:${cuando ?? ''}`,
        usuario: nombre(cuerpo.follower), hora: cuando,
      });
    case 'channel.subscription.new':
    case 'channel.subscription.renewal':
      if (!cuerpo.subscriber) return null;
      return actividad('kick', tipo.endsWith('new') ? 'sub' : 'resub', {
        id: `${tipo}:${cuerpo.subscriber?.user_id ?? ''}:${cuando ?? ''}`,
        usuario: nombre(cuerpo.subscriber), meses: cuerpo.duration ?? null, hora: cuando,
      });
    case 'channel.subscription.gifts': {
      if (!cuerpo.gifter) return null;
      const receptores = Array.isArray(cuerpo.giftees) ? cuerpo.giftees : [];
      return actividad('kick', 'regalo', {
        id: `regalo:${cuerpo.gifter?.user_id ?? ''}:${cuando ?? ''}`,
        usuario: cuerpo.gifter?.is_anonymous ? 'anonimo' : nombre(cuerpo.gifter),
        cantidad: receptores.length || 1, hora: cuando,
      });
    }
    case 'channel.reward.redemption.updated': {
      /* Solo se descarta lo RECHAZADO. Segun como este configurada la
         recompensa, Kick puede mandar solo `pending` y nunca `accepted`:
         exigir `accepted` perdia canjes reales (pasó en CosasStream). El
         pending y el accepted del mismo canje traen el mismo `id`, y el
         dedupe de chat.js se queda con el primero. */
      if (String(cuerpo.status ?? '').toLowerCase() === 'rejected') return null;
      if (!cuerpo.reward && !cuerpo.reward_title) return null;
      const r = cuerpo.reward ?? {};
      return actividad('kick', 'canje', {
        id: cuerpo.id ?? '',
        usuario: nombre(cuerpo.redeemer ?? cuerpo.user),
        regalo: r.title ?? cuerpo.reward_title ?? '',
        mensaje: cuerpo.user_input ?? '',
        costo: r.cost ?? null,
        hora: cuando,
      });
    }
    default:
      return null;
  }
}

/* Nombres para las recompensas de fabrica de Twitch, que no traen
   titulo sino un `type`. Una que no este aca sale con el type crudo. */
const CANJES_DE_FABRICA = Object.assign(Object.create(null), {
  single_message_bypass_sub_mode: 'Mensaje en modo solo subs',
  send_highlighted_message: 'Mensaje resaltado',
  random_sub_emote_unlock: 'Desbloquear un emote al azar',
  chosen_sub_emote_unlock: 'Desbloquear un emote',
  chosen_modified_sub_emote_unlock: 'Emote modificado',
  message_effect: 'Efecto en el mensaje',
  gigantify_an_emote: 'Emote gigante',
  celebration: 'Celebracion',
});

/**
 * Una notificacion de actividad de EventSub al formato de arriba.
 * @param {string} tipo      metadata.subscription_type
 * @param {object} evento    payload.event
 * @param {object} metadata  la de la trama (trae la hora)
 */
export function actividadDeTwitch(tipo, evento, metadata = {}) {
  if (!evento || typeof evento !== 'object') return null;
  const nombre = (anonimo = false) =>
    (anonimo ? 'anonimo' : (evento.user_name ?? evento.user_login ?? ''));
  const hora = evento.redeemed_at ?? evento.followed_at ?? metadata?.message_timestamp;
  /* Los eventos de sub no traen id propio: el de la trama sirve igual
     para el dedupe, porque Twitch reenvia con el mismo message_id. */
  const idTrama = String(metadata?.message_id ?? '');
  switch (tipo) {
    case 'channel.follow':
      return actividad('twitch', 'follow', { id: idTrama, usuario: nombre(), hora });
    /* channel.subscribe llega tambien una vez POR CADA sub regalada
       (is_gift), ademas del regalo de quien regalo. Sin este corte, un
       regalo de 20 subs serian 21 lineas. */
    case 'channel.subscribe':
      if (evento.is_gift) return null;
      return actividad('twitch', 'sub', { id: idTrama, usuario: nombre(), meses: 1, hora });
    case 'channel.subscription.message':
      return actividad('twitch', 'resub', {
        id: idTrama, usuario: nombre(),
        meses: evento.cumulative_months ?? evento.duration_months ?? null,
        mensaje: evento.message?.text ?? '', hora,
      });
    case 'channel.subscription.gift':
      return actividad('twitch', 'regalo', {
        id: idTrama, usuario: nombre(evento.is_anonymous), cantidad: evento.total ?? 1, hora,
      });
    case 'channel.channel_points_custom_reward_redemption.add':
      if (String(evento.status ?? '').toLowerCase() === 'canceled') return null;
      return actividad('twitch', 'canje', {
        id: evento.id ?? idTrama, usuario: nombre(),
        regalo: evento.reward?.title ?? '', mensaje: evento.user_input ?? '',
        costo: evento.reward?.cost ?? null, hora,
      });
    case 'channel.channel_points_automatic_reward_redemption.add': {
      const clase = String(evento.reward?.type ?? '');
      return actividad('twitch', 'canje', {
        id: evento.id ?? idTrama, usuario: nombre(),
        regalo: CANJES_DE_FABRICA[clase] ?? clase,
        mensaje: evento.message?.text ?? evento.user_input ?? '',
        costo: evento.reward?.channel_points ?? evento.reward?.cost ?? null, hora,
      });
    }
    default:
      return null;
  }
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
