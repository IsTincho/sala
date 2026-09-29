/* ============================================================
   El chat de cada canal: lo que junta las dos redes en un solo lugar.

   Este modulo es el que sabe:
     - que el chat de Kick entra por webhook y el de Twitch por
       WebSocket (o por IRC, si el WebSocket se cae),
     - que los dos terminan en el mismo canal del bus, con el mismo
       formato de mensaje,
     - como esta la salud de cada via, para poder decirlo en pantalla
       en vez de dejar al creador mirando un chat mudo sin saber por
       que.

   ---------------------------------------------------------------
   UN JUEGO DE ESTADO POR SALA

   Hasta la Fase 2 todo esto era estado de modulo: UNA conexion de
   Twitch, UN plan B, UN "cuando llego el ultimo mensaje". Con varios
   creadores cada una de esas cosas es por sala, asi que viven adentro
   de `porCanal`, un Map de slug a "canal de chat".

   Lo que NO cambio es la logica: el plan B, la coalescencia del
   prendido, el dedupe y el orden de las banderas son exactamente los
   de la Fase 1, que costaron dos rondas de verificacion. Se movieron
   de lugar, no se reescribieron.

   El slug es obligatorio y va primero en todas las funciones. Sin
   valor por defecto, por el mismo motivo que en `vinculos.js`: un
   default que apunte al dueño convierte cualquier olvido en un mensaje
   de un creador cayendo en la sala de otro, y anda "bien" hasta que
   haya dos.

   ---------------------------------------------------------------
   POR QUE HACE FALTA UN INDICADOR DE SALUD Y NO ALCANZA CON "ANDA"

   Las dos vias fallan CALLADAS. Si la URL del webhook no esta
   cargada en el portal de Kick, las suscripciones se crean sin error
   y no llega ni un mensaje. Si la suscripcion de Twitch se revoca,
   el WebSocket sigue mandando keepalives felices. En los dos casos
   la pantalla se ve igual que un chat tranquilo, y la unica
   diferencia entre "no habla nadie" y "esto esta roto" es cuanto
   hace que no llega nada y si el canal esta en vivo. Por eso se
   guarda la ultima llegada de cada red y el estado de vivo.

   ---------------------------------------------------------------
   POR QUE LOS EMOTES DE 7TV Y LAS INSIGNIAS SE RESUELVEN ACA

   `emotes.resolver()` se llama en los DOS embudos de este archivo
   —`recibirDeKick` y `recibirDeTwitch`— y en ningun otro lado.
   `insignias.resolver()` se llama SOLO en el de Twitch, porque Kick no
   publica las imagenes de sus insignias (esta explicado en los dos
   lugares donde alguien lo va a buscar: arriba de la llamada que falta
   y en el encabezado de insignias.js).

   No van en `mensajes.js` porque los traductores de alla son puros:
   traducen un payload y no conocen ni el slug de la sala ni una
   cache. No van en `canales.recordar()` porque el bus reparte, no
   enriquece, y ahi tambien pasan eventos que no son mensajes.

   Que sean dos y no tres importa: el plan B de IRC NO es un tercer
   embudo, desemboca en `recibirDeTwitch`. Si algun dia aparece una via
   nueva, tiene que terminar en uno de estos dos o los emotes de 7TV y
   las insignias se van a ver por un camino y no por el otro, que es
   justo el tipo de bug que `pruebas/mensajes-forma.test.js` existe
   para atajar.

   ---------------------------------------------------------------
   EL DEDUPE ENTRE EVENTSUB E IRC

   Cuando se prende el plan B, EventSub sigue reintentando: durante
   un rato pueden estar los dos trayendo los mismos mensajes. El id
   de mensaje de Twitch es el mismo por las dos vias (el tag `id` de
   IRC es el `message_id` de EventSub), asi que alcanza con recordar
   los ultimos ids vistos. El anillo es POR SALA: dos creadores no
   comparten ids, y compartir el Set haria que el mensaje de uno
   silenciara el del otro si por casualidad coincidieran.

   ---------------------------------------------------------------
   EL TOPE DE CONEXIONES DE TWITCH

   Twitch permite hasta 3 WebSockets con suscripciones por par (client
   id, user id), o sea que una conexion por creador es legal por mas
   creadores que haya: cada uno es otro user id, y leer el chat propio
   con el token propio cuesta 0 del presupuesto de 10
   (dev.twitch.tv/docs/eventsub/handling-websocket-events).

   Lo que no escala es esta maquina: 900 WebSockets abiertos en un
   contenedor de Railway son 900 sockets, 900 timers de keepalive y
   900 buffers. Por eso hay un tope propio, chico y visible en el
   panel, en vez de un limite que se descubra la noche que se caiga
   todo. Twitch es opcional por creador; Kick, que es lo que la Sala
   necesita, entra por webhook y no gasta una conexion.
   ============================================================ */

import * as actividad from './actividad.js';
import * as canales from './canales.js';
import * as colores from './colores.js';
import * as emotes from './emotes.js';
import { numeroDeEntorno } from './entorno.js';
import * as envio from './envio.js';
import * as insignias from './insignias.js';
import * as kick from './kick.js';
import * as mensajes from './mensajes.js';
import * as twitch from './twitch.js';
import * as vinculos from './vinculos.js';
import { ConexionIrc } from './irc.js';

/* Cada cuanto se comprueba que la suscripcion de Kick siga estando.
   Cinco minutos es lo que pide el plan: seguido como para que un
   corte no se coma media transmision, espaciado como para no gastar
   la cuota de la API en algo que casi nunca cambia. */
export const CADA_VERIFICACION = 5 * 60 * 1000;

/* Cuanto silencio de una red se considera sospechoso. Solo se avisa
   fuerte si ADEMAS el canal esta en vivo: con el canal apagado, cero
   mensajes en una hora es lo normal. */
export const SILENCIO_SOSPECHOSO = 5 * 60 * 1000;

/* Cuantos ids de mensaje de Twitch recordar para el dedupe entre
   EventSub e IRC. Un stream movido hace 500 mensajes en minutos, y
   las dos vias no llegan separadas por mas que segundos. */
const TOPE_VISTOS = 500;

/* Cuantas conexiones EventSub sostiene este proceso a la vez. Ver el
   bloque de arriba. Se puede subir por variable cuando se mida cuanto
   aguanta el contenedor de verdad.

   El piso es CERO y no uno: `TOPE_TWITCH=0` es una forma legitima de
   decir "no abras ninguna conexion a Twitch, dejame el webhook de Kick
   y nada mas". Con `Number()` pelado, un typo daba NaN y `>= NaN` es
   false siempre: el tope dejaba de existir justo cuando alguien queria
   bajarlo. */
export const TOPE_TWITCH = numeroDeEntorno('TOPE_TWITCH', 50, { minimo: 0 });

/* Mas de tres fallos seguidos de EventSub y se prende el IRC
   anonimo. Tres y no uno: una reconexion suelta es normal (Twitch
   recicla sus servidores) y prender el plan B por eso seria tener
   dos conexiones abiertas todo el tiempo. */
export const FALLOS_PARA_PLAN_B = 3;

/* --------------------------------------------------------- estado */

let urlBase = '';
let timerVerificacion = null;

const porCanal = new Map();   // slug -> canal de chat

const nuevoCanalDeChat = slug => ({
  slug,
  kick: { ultima: null, suscripcion: 'desconocida', vivo: false, vinculado: false },
  twitch: { ultima: null, estado: 'cortado', modo: 'ninguno', vinculado: false, tope: false },
  conexionTwitch: null,
  conexionIrc: null,
  vistos: new Set(),
  /* Prender el plan B tiene que pedir el vinculo, o sea que CEDE EL
     CONTROL en medio de la operacion. Estas dos son la reserva del
     lugar: sin ellas, entre el `if (conexionIrc)` y la asignacion
     entraba otra llamada y se abrian dos conexiones IRC. */
  prendiendoPlanB: null,
  planBPedido: false,
});

const normalizar = s => String(s ?? '').toLowerCase();

function exigirSlug(slug) {
  const s = normalizar(slug);
  if (!s) throw new Error('chat: falta el slug de la sala');
  return s;
}

/** El canal de chat de una sala, creandolo si es la primera vez. */
function canalDeChat(slug) {
  const s = exigirSlug(slug);
  if (!porCanal.has(s)) porCanal.set(s, nuevoCanalDeChat(s));
  return porCanal.get(s);
}

/* `salud()` NO crea la entrada: una pagina que pregunte por una sala
   cualquiera no tiene por que hacer crecer el Map. */
const canalSiHay = slug => porCanal.get(normalizar(slug)) ?? null;

/* ------------------------------------------------------- costuras

   Las dos conexiones de Twitch se crean a traves de estas fabricas y
   no con un `new` suelto.

   No es ceremonia: CUANDO se prende el plan B, cuando se apaga y que
   pasa si el estado cambia dos veces seguidas es logica de este
   modulo, no de las clases, y sin costura la unica forma de probarla
   seria abrir un socket contra irc.chat.twitch.tv y esperar los
   backoff de verdad (mas de quince segundos para llegar al cuarto
   fallo). `ConexionEventSub` acepta `url` y `ConexionIrc` acepta
   `abrirSocket` justamente para no salir a internet; la fabrica es lo
   que deja que un test se los pase sin que chat.js sepa que existe un
   test. */
const CONEXIONES_REALES = {
  eventSub: opciones => new twitch.ConexionEventSub(opciones),
  irc: opciones => new ConexionIrc(opciones),
};
let crearConexion = { ...CONEXIONES_REALES };

/**
 * Solo para los tests: con que se abren las conexiones de Twitch.
 *
 * O las DOS fabricas, o ninguna (que vuelve a las de verdad). Media
 * costura era una trampa: un test que fijaba solo `eventSub` se
 * quedaba con la `ConexionIrc` de verdad, y el dia que ese test
 * disparara el plan B abriria un TLS contra irc.chat.twitch.tv desde
 * la suite. Falla al fijarlas y no al usarlas, que es cuando el test
 * ya esta a mitad de camino y el error sale como rechazo suelto.
 */
export function fijarConexiones(dobles) {
  if (dobles === undefined) {
    crearConexion = { ...CONEXIONES_REALES };
    return;
  }
  const { eventSub, irc } = dobles ?? {};
  if (typeof eventSub !== 'function' || typeof irc !== 'function') {
    throw new Error('fijarConexiones necesita las dos fabricas (eventSub e irc) o ninguna: ' +
                    'dejar una sin fijar deja la conexion de verdad puesta');
  }
  crearConexion = { eventSub, irc };
}

/** Solo para los tests: deja el modulo como recien cargado. */
export function reiniciar() {
  parar();
  fijarConexiones();
  urlBase = '';
  porCanal.clear();
}

/* ------------------------------------------------------- arranque */

/**
 * Pone en marcha lo que se pueda con lo que haya guardado, para TODAS
 * las salas vinculadas.
 *
 * Se llama al arrancar el servidor. No tira NUNCA: un vinculo que no
 * se puede levantar tiene que dejar el servidor arriba y decirlo en
 * la pagina de salud, no impedir que el sitio exista. Y un creador que
 * falla no puede dejar sin arrancar a los que vienen despues, por eso
 * cada uno va en su propio try.
 */
export async function arrancar({ base } = {}) {
  urlBase = String(base ?? '');

  /* Idempotente a proposito. Hoy lo llama solo index.arrancar(), pero
     un segundo llamado pisaba `timerVerificacion` y dejaba el
     setInterval viejo corriendo: dos verificaciones cada cinco
     minutos, para siempre, sin forma de apagar la primera. */
  clearInterval(timerVerificacion);
  timerVerificacion = null;

  await verificarTodas();

  for (const slug of await salasDe('twitch')) {
    try { await conectarTwitch(slug); }
    catch (e) { console.warn(`[chat] ${slug}: no se pudo conectar Twitch:`, e.message); }
  }

  timerVerificacion = setInterval(() => {
    verificarTodas().catch(e => console.warn('[chat] verificacion:', e.message));
  }, CADA_VERIFICACION);
  timerVerificacion.unref?.();
}

async function salasDe(red) {
  try { return await vinculos.salasCon(red); }
  catch (e) {
    console.warn(`[chat] no se pudieron listar las salas con ${red}:`, e.name);
    return [];
  }
}

/** Comprueba la suscripcion de Kick de cada sala vinculada. */
export async function verificarTodas() {
  for (const slug of await salasDe('kick')) {
    try { await verificarKick(slug); }
    catch (e) { console.warn(`[chat] ${slug}: no se pudo verificar la suscripcion de Kick:`, e.message); }
  }
}

/** Corta todo: los timers y las conexiones de Twitch de cada sala. */
export function parar() {
  clearInterval(timerVerificacion);
  timerVerificacion = null;
  for (const c of porCanal.values()) {
    /* Antes de cerrar: si hay un prendido de plan B a medio camino,
       esto es lo que evita que termine abriendo un IRC despues de que
       todo se apago. */
    c.planBPedido = false;
    if (c.conexionTwitch) { c.conexionTwitch.cerrar(); c.conexionTwitch = null; }
    if (c.conexionIrc) { c.conexionIrc.cerrar(); c.conexionIrc = null; }
    c.twitch.modo = 'ninguno';
    c.twitch.estado = 'cortado';
  }
}

/* ----------------------------------------------------------- Kick */

/**
 * Se fija que la suscripcion a chat.message.sent de una sala siga
 * existiendo y la vuelve a crear si no.
 *
 * OJO: la API de Kick NO devuelve un estado por suscripcion. Lo unico
 * que se puede comprobar es que la suscripcion EXISTA; que Kick le
 * este entregando algo a nuestro webhook no se puede saber por aca.
 * Por eso esta verificacion es la mitad de la historia, y la otra
 * mitad son los dos datos que si sirven, que se juntan en el mismo
 * ciclo: cuando llego el ultimo mensaje de verdad (`ultima`) y si el
 * canal esta transmitiendo segun la API (`vivo`).
 */
export async function verificarKick(slug) {
  const c = canalDeChat(slug);
  const v = await vinculos.acceso(c.slug, 'kick').catch(e => {
    console.warn(`[chat] ${c.slug}: el vinculo de Kick no sirve:`, e.message);
    return null;
  });
  if (!v) {
    c.kick.vinculado = false;
    c.kick.suscripcion = 'desconocida';
    return { vinculado: false };
  }
  c.kick.vinculado = true;

  await revisarSiEstaEnVivo(c, v.accessToken);

  const actuales = await kick.listarSuscripciones(v.accessToken, v.usuarioId);
  const falta = kick.EVENTOS.filter(
    e => !actuales.some(s => s.event === e.name && Number(s.version) === e.version),
  );

  if (!falta.length) {
    c.kick.suscripcion = 'activa';
    await asegurarActividadKick(c, v, actuales);
    return { vinculado: true, resuscrito: false };
  }

  console.warn(`[chat] ${c.slug}: faltaban ${falta.length} suscripciones de Kick: se vuelven a crear`);
  await kick.suscribirEventos(v.accessToken, v.usuarioId, urlBase ? `${urlBase}/kick/webhook` : '');
  c.kick.suscripcion = 'activa';
  await asegurarActividadKick(c, v, actuales);
  return { vinculado: true, resuscrito: true };
}

/* Los canjes, subs y follows de Kick. Van despues del chat y no tiran:
   si Kick los rechaza, se dice en el log y el chat sigue igual. La
   suscripcion del chat es la que decide si la sala anda; esta es un
   agregado. Se reintenta sola en la vuelta de los cinco minutos. */
async function asegurarActividadKick(c, v, actuales) {
  try {
    await kick.suscribirActividad(v.accessToken, v.usuarioId, actuales);
  } catch (e) {
    console.warn(`[chat] ${c.slug}: no se pudo suscribir la actividad de Kick:`, e.message);
  }
}

/**
 * Cruza el "esta en vivo" con la API de Kick, que es la que manda.
 *
 * El webhook `livestream.status.updated` avisa en las TRANSICIONES.
 * Sirve como via rapida y no sirve como fuente, por dos motivos que
 * pasan los dos:
 *
 *   - Un deploy en medio del stream deja `vivo` en false el resto de
 *     la noche. Y aca deployar en medio del stream es la forma normal
 *     de trabajar: push a main es deploy.
 *   - En el caso que MOTIVA todo este aviso —la URL del webhook sin
 *     cargar a mano en el portal de Kick— no llega ningun webhook,
 *     asi que `vivo` nunca seria true y el aviso que existe para
 *     detectar "no llegan webhooks" no podria aparecer nunca.
 *
 * Se consulta en el ciclo de los cinco minutos, no en cada request:
 * es un dato que cambia dos veces por noche. Lo que queda guardado en
 * `c.kick.vivo` es la cache hasta la vuelta siguiente.
 */
async function revisarSiEstaEnVivo(c, accessToken) {
  try {
    const canal = await kick.canalPorSlug(c.slug, accessToken);
    c.kick.vivo = canal.vivo;
  } catch (e) {
    /* No se pisa lo que dijo el webhook: que la API no conteste no es
       "se apago el stream". */
    console.warn(`[chat] ${c.slug}: no se pudo consultar si el canal esta en vivo:`, e.message);
  }
}

/** Fuerza la resuscripcion de una sala, aunque parezca que esta todo bien. */
export async function resuscribirKick(slug) {
  const c = canalDeChat(slug);
  const v = await vinculos.acceso(c.slug, 'kick');
  if (!v) throw new Error('no hay vinculo con Kick');
  await kick.suscribirEventos(v.accessToken, v.usuarioId, urlBase ? `${urlBase}/kick/webhook` : '');
  c.kick.suscripcion = 'activa';
  const actuales = await kick.listarSuscripciones(v.accessToken, v.usuarioId).catch(() => []);
  await asegurarActividadKick(c, v, actuales);
  return { ok: true };
}

/**
 * Un evento de Kick ya verificado, para una sala YA RESUELTA.
 *
 * El slug NO sale de aca: lo resuelve `creadores.salaDelEvento()`
 * contra el indice de creadores y esta ruta solo recibe salas que
 * existen. Antes este modulo lo sacaba del payload y comparaba contra
 * el canal del dueño, que era la forma de un solo inquilino de decir
 * lo mismo. Que la atribucion viva en un lado y el chat en otro es lo
 * que hace que agregar una sala no toque este archivo.
 *
 * Devuelve que se hizo con el evento, para que el que llama lo loguee.
 */
export function recibirDeKick(slug, evento, cuerpo) {
  const c = canalDeChat(slug);

  if (evento?.tipo === 'chat.message.sent') {
    const mensaje = mensajes.deKick(cuerpo, { hora: evento.cuando });
    if (!mensaje) return { hecho: 'payload raro' };
    c.kick.ultima = new Date();
    emotes.resolver(mensaje, c.slug);
    /* ACA NO VA `insignias.resolver()`, y no es un olvido: Kick no
       publica las imagenes de sus insignias por ninguna API
       documentada, asi que no hay nada que resolver y la llamada seria
       una linea muerta que ninguna prueba puede vigilar.
       EL DIA QUE KICK LAS PUBLIQUE hay que volver a ponerla, o las
       insignias se van a ver por el camino de Twitch y no por este.
       Esta anotado tambien arriba de `resolver()` en insignias.js. */
    /* El color propio de quien escribio, si eligio uno en esta
       plataforma. Va en los DOS embudos, como `emotes.resolver`: el
       color es de la persona y no de la red. */
    colores.pintar(mensaje);
    /* Quien es mod lo dice la insignia de cada mensaje: ver actividad.js */
    actividad.mirarInsignias(c.slug, mensaje);
    canales.recordar(c.slug, mensaje);
    return { hecho: 'chat', mensaje };
  }

  if (mensajes.TIPOS_ACTIVIDAD_KICK.includes(evento?.tipo)) {
    const a = mensajes.actividadDeKick(evento.tipo, cuerpo, { hora: evento.cuando });
    if (!a) return { hecho: 'actividad descartada' };
    return { hecho: recibirActividad(c.slug, a) ? 'actividad' : 'actividad repetida' };
  }

  if (evento?.tipo === 'livestream.status.updated') {
    const vivo = mensajes.vivoDeKick(cuerpo);
    if (vivo !== null) c.kick.vivo = vivo;
    return { hecho: 'vivo', vivo };
  }

  return { hecho: 'ignorado' };
}

/* --------------------------------------------------------- Twitch */

/** Cuantas salas tienen ahora mismo una conexion EventSub abierta. */
export const conexionesTwitch = () =>
  [...porCanal.values()].filter(c => c.conexionTwitch).length;

/**
 * Abre (o reabre) la conexion EventSub de una sala con su vinculo
 * guardado. Si no hay vinculo, no hace nada y lo dice.
 */
export async function conectarTwitch(slug) {
  const c = canalDeChat(slug);
  const v = await vinculos.acceso(c.slug, 'twitch').catch(e => {
    console.warn(`[chat] ${c.slug}: el vinculo de Twitch no sirve:`, e.message);
    return null;
  });
  if (!v) {
    c.twitch.vinculado = false;
    c.twitch.modo = 'ninguno';
    c.twitch.estado = 'cortado';
    return { vinculado: false };
  }
  c.twitch.vinculado = true;
  /* Un vinculo de antes de que se pidieran los permisos de la
     actividad (canjes, subs, follows). El chat anda igual; el panel lo
     dice para que se sepa que falta volver a vincular. */
  c.twitch.faltaActividad = twitch.faltanScopesActividad(v.scopes).length > 0;
  /* Sin vinculo, `emotes.js` no tiene id que preguntarle a 7TV y lo
     anota como "este creador no tiene esa red", que vence a la hora.
     Vincular Twitch es justo el momento en que ese "no" dejo de ser
     cierto: si no se lo vence aca, el creador conecta su Twitch y sus
     emotes de 7TV tardan hasta una hora en aparecer. */
  emotes.vencer(c.slug, 'twitch');
  /* Y lo mismo con las insignias, por partida doble. Una: si no habia
     vinculo, la tabla quedo anotada como "sin insignias propias" y
     vence a la hora. Dos, y esta es peor: la clave de la cache es el
     SLUG, no el id de Twitch, asi que un creador que desvincula una
     cuenta y vincula OTRA seguiria mostrando las insignias de
     suscriptor del canal anterior hasta seis horas. Vincular es
     exactamente el momento en que lo cacheado dejo de valer. */
  insignias.vencer(c.slug);

  /* El tope se mira ANTES de cerrar la conexion vieja: si esta sala ya
     tenia una, reconectarla no suma ninguna y tiene que poder hacerse
     aunque estemos en el tope. */
  if (!c.conexionTwitch && conexionesTwitch() >= TOPE_TWITCH) {
    c.twitch.tope = true;
    c.twitch.modo = 'ninguno';
    c.twitch.estado = 'cortado';
    console.warn(`[chat] ${c.slug}: no se conecta Twitch, ya hay ${TOPE_TWITCH} conexiones abiertas ` +
                 `(TOPE_TWITCH). Kick sigue andando por webhook.`);
    return { vinculado: true, tope: true };
  }
  c.twitch.tope = false;

  if (c.conexionTwitch) c.conexionTwitch.cerrar();

  c.conexionTwitch = crearConexion.eventSub({
    /* El token se pide DE NUEVO en cada suscripcion, no se captura el
       de ahora: entre una reconexion y la siguiente pueden pasar
       horas y el access token dura una. */
    suscribir: async (sessionId) => {
      const actual = await vinculos.acceso(c.slug, 'twitch');
      if (!actual) throw new Error('se perdio el vinculo de Twitch');
      await twitch.suscribirChat({
        accessToken: actual.accessToken,
        sessionId,
        /* Cada creador escucha SU PROPIO canal: broadcaster y usuario
           que lee son la misma persona, y por eso la suscripcion
           cuesta 0 del presupuesto de Twitch. */
        broadcasterId: actual.usuarioId,
        usuarioId: actual.usuarioId,
      });
      /* La actividad va DESPUES del chat y no puede tirar: si falla un
         follow o un canje (el caso comun es un vinculo de antes de que
         se pidieran esos permisos), el chat sigue andando igual. Si
         tirara, la conexion entera se daria por fallida y se caeria el
         chat de Twitch por un adorno. */
      const r = await twitch.suscribirActividad({
        accessToken: actual.accessToken,
        sessionId,
        broadcasterId: actual.usuarioId,
        scopes: actual.scopes,
      }).catch(e => ({ ok: [], sinPermiso: [], fallaron: [e?.name ?? 'Error'] }));
      if (r.sinPermiso.length) {
        console.warn(`[chat] ${c.slug}: sin permiso para la actividad de Twitch ` +
                     `(${r.sinPermiso.length} eventos): hay que volver a vincular Twitch desde /panel`);
      }
      if (r.fallaron.length) {
        console.warn(`[chat] ${c.slug}: fallo la actividad de Twitch: ${r.fallaron.join(', ')}`);
      }
    },
    alMensaje: (evento, metadata) => {
      /* Por la misma conexion llegan el chat y la actividad. Sin tipo
         (las pruebas viejas, o una trama rara) se trata como chat, que
         es lo que era antes de que hubiera otra cosa. */
      const tipo = metadata?.subscription_type ?? 'channel.chat.message';
      if (tipo === 'channel.chat.message') {
        recibirDeTwitch(c.slug, mensajes.deTwitch(evento, metadata));
        return;
      }
      recibirActividad(c.slug, mensajes.actividadDeTwitch(tipo, evento, metadata));
    },
    alEstado: (nuevo) => {
      /* alEstado tambien avisa cosas que no son estados de conexion
         ("revocado:...", "error_suscripcion:..."). Esas se loguean y
         no pisan el estado, que tiene cuatro valores y nada mas. */
      if (['cortado', 'conectando', 'conectado', 'reconectando'].includes(nuevo)) {
        c.twitch.estado = nuevo;
        if (nuevo === 'conectado') {
          c.twitch.modo = 'eventsub';
          apagarPlanB(c);
        }
      } else {
        console.warn(`[chat] ${c.slug}: twitch avisa:`, nuevo);
      }
      revisarPlanB(c);
    },
  });

  c.twitch.modo = 'eventsub';
  c.conexionTwitch.conectar();
  return { vinculado: true };
}

/** Cierra la conexion de Twitch de una sala y olvida su vinculo. */
export async function desvincularTwitch(slug) {
  const c = canalDeChat(slug);
  c.planBPedido = false;
  if (c.conexionTwitch) { c.conexionTwitch.cerrar(); c.conexionTwitch = null; }
  if (c.conexionIrc) { c.conexionIrc.cerrar(); c.conexionIrc = null; }
  c.twitch = { ultima: null, estado: 'cortado', modo: 'ninguno', vinculado: false, tope: false };
  await vinculos.olvidar(c.slug, 'twitch');
  return { ok: true };
}

/** Un mensaje de Twitch de una sala, venga por donde venga. */
export function recibirDeTwitch(slug, mensaje) {
  if (!mensaje) return false;
  const c = canalDeChat(slug);
  /* El dedupe existe por la ventana en la que EventSub y el plan B
     estan los dos prendidos. El id es el mismo por las dos vias. */
  if (mensaje.id) {
    if (c.vistos.has(mensaje.id)) return false;
    c.vistos.add(mensaje.id);
    if (c.vistos.size > TOPE_VISTOS) {
      c.vistos.delete(c.vistos.values().next().value);
    }
  }
  c.twitch.ultima = new Date();
  emotes.resolver(mensaje, c.slug);
  insignias.resolver(mensaje, c.slug);
  colores.pintar(mensaje);
  actividad.mirarInsignias(c.slug, mensaje);
  canales.recordar(c.slug, mensaje);
  return true;
}

/* ------------------------------------------------------- actividad */

/**
 * Un canje, sub o follow de cualquiera de las dos redes, ya traducido
 * (`mensajes.actividadDe*`). Se anota en la lista del creador y, si es
 * `publico`, sale tambien por el bus de la sala como una linea mas del
 * chat. Los follows no: ver el encabezado de la actividad en mensajes.js.
 *
 * El dedupe usa el mismo anillo que los mensajes de Twitch, con un
 * prefijo: Kick manda el mismo canje como `pending` y despues como
 * `accepted`, y reintenta los webhooks con otro message id.
 *
 * Devuelve si era nuevo.
 */
export function recibirActividad(slug, a) {
  if (!a) return false;
  const c = canalDeChat(slug);
  if (a.id) {
    const clave = `act:${a.red}:${a.clase}:${a.id}`;
    if (c.vistos.has(clave)) return false;
    c.vistos.add(clave);
    if (c.vistos.size > TOPE_VISTOS) c.vistos.delete(c.vistos.values().next().value);
  }
  actividad.anotar(c.slug, a);
  const { publico, ...paraElBus } = a;
  if (publico) canales.recordar(c.slug, paraElBus);
  return true;
}

/* --------------------------------------------------------- plan B */

function revisarPlanB(c) {
  if (!c.conexionTwitch) return;
  /* Con EventSub conectado no hay nada que suplir, por mas fallos que
     haya acumulado antes. La clase pone el contador en cero al recibir
     el welcome, pero depender de eso significa que el dia que cambie,
     el plan B se prende justo despues de apagarse. */
  if (c.conexionTwitch.estado === 'conectado') return;
  if (c.conexionTwitch.intentosFallidosSeguidos > FALLOS_PARA_PLAN_B) prenderPlanB(c);
}

function prenderPlanB(c) {
  if (c.conexionIrc) return Promise.resolve();
  /* La bandera se levanta ANTES de colgarse del prendido en vuelo, y
     no despues. Al reves, un pedido que llegaba con otro en camino
     devolvia la promesa vieja y se perdia: si en el medio hubo un
     `apagarPlanB()`, esa promesa vieja ya venia con el pedido
     cancelado y aborta al despertar, asi que el pedido nuevo no
     abria nada y nadie volvia a intentarlo hasta el cambio de estado
     siguiente. */
  c.planBPedido = true;
  if (c.prendiendoPlanB) return c.prendiendoPlanB;      // ya hay uno en camino
  c.prendiendoPlanB = abrirPlanB(c).finally(() => { c.prendiendoPlanB = null; });
  return c.prendiendoPlanB;
}

async function abrirPlanB(c) {
  const v = await vinculos.leer(c.slug, 'twitch').catch(e => {
    console.warn(`[chat] ${c.slug}: no se pudo leer el vinculo de Twitch para el plan B:`, e.message);
    return null;
  });

  /* Mientras se leia el vinculo, EventSub pudo volver (apagarPlanB) o
     el modulo pudo pararse. Abrir ahora dejaria prendido un IRC que
     ya nadie quiere y que nadie va a cerrar. */
  if (!c.planBPedido || c.conexionIrc) return;

  const canalTwitch = v?.login ?? '';
  if (!canalTwitch) {
    console.warn(`[chat] ${c.slug}: no se puede prender el plan B: no se sabe el canal de Twitch`);
    return;
  }

  console.warn(`[chat] ${c.slug}: EventSub fallo ${FALLOS_PARA_PLAN_B}+ veces seguidas: ` +
               `se prende el IRC anonimo mientras se sigue reintentando`);
  c.twitch.modo = 'irc';
  c.conexionIrc = crearConexion.irc({
    canal: canalTwitch,
    alMensaje: mensaje => recibirDeTwitch(c.slug, mensaje),
  });
  c.conexionIrc.conectar();
}

function apagarPlanB(c) {
  /* Primero se cancela el pedido, aunque todavia no haya conexion:
     puede haber un prendido en vuelo esperando el vinculo. */
  c.planBPedido = false;
  if (!c.conexionIrc) return;
  console.log(`[chat] ${c.slug}: EventSub volvio: se apaga el IRC anonimo`);
  c.conexionIrc.cerrar();
  c.conexionIrc = null;
}

/* --------------------------------------------------------- enviar */

/* `destino` (el vocabulario de la ventana del creador: elige entre SUS
   canales) a las redes de verdad. El de la otra puerta dice "ambas" y
   habla de las cuentas de quien mira; son dos cosas distintas y por eso
   son dos palabras distintas.

   Objeto no, `if` si: con un objeto, `destino = "constructor"` devuelve
   un miembro del prototipo y eso no es una red. */
function redesDelDestino(destino) {
  if (destino === 'ambos') return ['kick', 'twitch'];
  return destino === 'kick' || destino === 'twitch' ? [destino] : null;
}

/**
 * Manda un mensaje a una red o a las dos, con la cuenta del creador de
 * esta sala.
 *
 * Devuelve un resultado POR RED. No tira si una falla: que Twitch
 * rechace no tiene por que borrar el hecho de que en Kick salio, y
 * la pagina tiene que poder decir exactamente eso.
 *
 * ---------------------------------------------------------------
 * EL TEXTO SE TRADUCE POR RED, Y LA TRADUCCION ES LA DE `envio.js`
 *
 * Esta puerta mandaba el MISMO string a las dos redes, y eso estaba
 * mal desde que existen los emotes: un `[emote:5747892:MEGALUL]` es un
 * dibujo en Kick y son esos corchetes literales en Twitch, delante de
 * toda la comunidad del otro lado. Con destino "ambos" no hay un texto
 * que sirva para las dos.
 *
 * No se escribe una traduccion nueva aca: se usa la MISMA
 * (`envio.comoViajaA`) que ya usa `/api/chat/:slug/enviar`. Es una
 * funcion pura, y es lo que sostiene la invariante que ya habia costado
 * un bug: LO QUE SE MIDE ES LO QUE SE MANDA. `porQueNoSePuedeMandar`
 * mide el texto de cada red y abajo se manda exactamente ese.
 *
 * (Si, este modulo importa uno de mas arriba. La alternativa era
 * copiar la traduccion, que es justo lo que este arreglo vino a
 * borrar: el formato de Kick tiene que vivir en un solo lado.)
 *
 * @param {string} slug
 * @param {{texto:string, destino:'kick'|'twitch'|'ambos', respondeA?:string}} pedido
 */
export async function enviar(slug, { texto, destino = 'kick', respondeA } = {}) {
  const s = exigirSlug(slug);
  const redes = redesDelDestino(destino);
  if (!redes) return { error: `destino desconocido: ${destino}` };

  /* El tope de CADA red, medido contra SU texto y antes de mandarle
     nada a ninguna: los dos dicen "500" y no son el mismo numero (Kick
     cuenta grapheme clusters, Twitch cuenta puntos de codigo), asi que
     hay mensajes que Kick acepta y Twitch rechaza. Si esto se mirara
     despues, con "ambos" el mensaje ya estaria en kick.com cuando
     Twitch lo rechaza y no habria forma de deshacerlo. */
  const problema = envio.porQueNoSePuedeMandar(texto, redes);
  if (problema) return { error: problema };

  const salida = {};
  await Promise.all(redes.map((red) => {
    const cuerpo = envio.comoViajaA(texto, red);
    return red === 'kick'
      ? enviarAKick(s, cuerpo, respondeA, salida)
      : enviarATwitch(s, cuerpo, respondeA, salida);
  }));
  return salida;
}

async function enviarAKick(slug, texto, respondeA, salida) {
  try {
    const v = await vinculos.acceso(slug, 'kick');
    if (!v) { salida.kick = { ok: false, motivo: 'no hay vinculo con Kick' }; return; }
    const r = await kick.enviarMensaje(v.accessToken, v.usuarioId, texto, { respondeA });
    salida.kick = r.enviado
      ? { ok: true, motivo: '' }
      : { ok: false, motivo: 'Kick lo recibio pero no lo publico' };
  } catch (e) {
    salida.kick = { ok: false, motivo: recortarError(e), estado: e.status ?? 0 };
  }
}

async function enviarATwitch(slug, texto, respondeA, salida) {
  try {
    const v = await vinculos.acceso(slug, 'twitch');
    if (!v) { salida.twitch = { ok: false, motivo: 'no hay vinculo con Twitch' }; return; }
    const r = await twitch.enviarMensaje({
      accessToken: v.accessToken,
      broadcasterId: v.usuarioId,
      senderId: v.usuarioId,
      texto,
      respondeA,
    });
    salida.twitch = r.enviado
      ? { ok: true, motivo: '' }
      /* Un 200 de Twitch no quiere decir que salio: el automod lo
         puede retener en silencio y ahi viene el drop_reason. */
      : { ok: false, motivo: r.motivo || 'Twitch lo retuvo sin decir por que' };
  } catch (e) {
    salida.twitch = { ok: false, motivo: recortarError(e), estado: estadoDeError(e) };
  }
}

/* El mensaje de error se muestra en pantalla, asi que se recorta y no
   se le confia el largo a la API de nadie. */
const recortarError = e => String(e?.message ?? 'error').slice(0, 200);

/* Los errores de twitch.js traen el status adentro del texto porque
   no lo exponen como campo. Se lo saca de ahi para poder contestar
   429 cuando corresponde. */
function estadoDeError(e) {
  if (e?.status) return e.status;
  const m = /respondio (\d{3})/.exec(String(e?.message ?? ''));
  return m ? Number(m[1]) : 0;
}

/* ---------------------------------------------------------- salud */

const SIN_NADA = {
  kick: { vinculado: false, ultima: null, suscripcion: 'desconocida', vivo: false, sospechoso: false },
  twitch: { vinculado: false, ultima: null, estado: 'cortado', modo: 'ninguno', tope: false, faltaActividad: false },
};

/**
 * Como esta cada via de una sala, en un objeto listo para mandar tal
 * cual.
 *
 * NO SALE POR EL BUS SSE, y es a proposito. El bus de un canal es
 * publico: desde la Fase 2 lo escucha cualquiera que este mirando la
 * peli. La salud dice si el creador tiene vinculada cada red, si su
 * conexion esta en el plan B y si su canal esta en vivo: no es un
 * secreto, pero es informacion de la cuenta del creador y no tiene por
 * que viajar a todo el que abra la sala. La piden /chat y /panel
 * contra rutas que exigen la cookie de esa sala.
 */
export function salud(slug, ahora = Date.now()) {
  const c = canalSiHay(slug);
  if (!c) return { ...SIN_NADA, ahora: new Date(ahora).toISOString() };

  const twitchEstado = c.conexionTwitch?.estado ?? c.twitch.estado;
  const ultimaTwitch = ultimaDe(c.twitch.ultima, c.conexionIrc?.ultimaLlegada);
  return {
    kick: {
      vinculado: c.kick.vinculado,
      ultima: c.kick.ultima ? c.kick.ultima.toISOString() : null,
      suscripcion: c.kick.suscripcion,
      vivo: c.kick.vivo,
      /* El veredicto viaja hecho, no los ingredientes. La pagina lo
         calculaba por su cuenta y con OTRA regla (pedia que hubiera
         llegado al menos un mensaje), asi que el caso que motiva todo
         el aviso —canal en vivo y ni un webhook en la vida— no
         prendia la banda en pantalla aunque el servidor lo
         considerara sospechoso. Una sola fuente de verdad, y es
         esta. */
      sospechoso: kickSospechoso(slug, ahora),
    },
    twitch: {
      vinculado: c.twitch.vinculado,
      ultima: ultimaTwitch ? ultimaTwitch.toISOString() : null,
      estado: twitchEstado,
      modo: c.conexionIrc ? 'irc' : c.twitch.modo,
      /* Que la conexion no se abrio por el tope de este proceso, no
         por un problema del creador. Sin esto, su panel diria
         "cortado" y no habria forma de distinguirlo de Twitch caido. */
      tope: Boolean(c.twitch.tope),
      /* Si al vinculo le faltan los permisos de canjes, subs y follows */
      faltaActividad: Boolean(c.twitch.vinculado && c.twitch.faltaActividad),
    },
    ahora: new Date(ahora).toISOString(),
  };
}

const ultimaDe = (a, b) => {
  if (!a) return b ?? null;
  if (!b) return a;
  return a > b ? a : b;
};

/**
 * Si hace demasiado que Kick no dice nada con el canal en vivo.
 *
 * Es la regla del aviso grande de /chat y de /panel, y vive aca y en
 * ningun otro lado: sale por `salud()` y la pagina la muestra, no la
 * recalcula.
 *
 * "Nunca llego un mensaje" cuenta como silencio, no como excusa: el
 * caso tipico de esto es la URL del webhook sin cargar en el portal
 * de Kick, donde no llega ni el primero.
 */
export function kickSospechoso(slug, ahora = Date.now()) {
  const c = canalSiHay(slug);
  if (!c || !c.kick.vivo) return false;
  const t = c.kick.ultima?.getTime() ?? 0;
  return ahora - t > SILENCIO_SOSPECHOSO;
}
