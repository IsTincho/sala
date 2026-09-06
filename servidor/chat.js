/* ============================================================
   El Chat Global: lo que junta las dos redes en un solo lugar.

   Este modulo es el que sabe:
     - que el chat de Kick entra por webhook y el de Twitch por
       WebSocket (o por IRC, si el WebSocket se cae),
     - que los dos terminan en el mismo canal del bus, con el mismo
       formato de mensaje,
     - como esta la salud de cada via, para poder decirlo en pantalla
       en vez de dejar al dueño mirando un chat mudo sin saber por
       que.

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
   EL DEDUPE ENTRE EVENTSUB E IRC

   Cuando se prende el plan B, EventSub sigue reintentando: durante
   un rato pueden estar los dos trayendo los mismos mensajes. El id
   de mensaje de Twitch es el mismo por las dos vias (el tag `id` de
   IRC es el `message_id` de EventSub), asi que alcanza con recordar
   los ultimos ids vistos.
   ============================================================ */

import * as canales from './canales.js';
import * as kick from './kick.js';
import * as mensajes from './mensajes.js';
import * as twitch from './twitch.js';
import * as vinculos from './vinculos.js';
import { ConexionIrc } from './irc.js';

/* Cada cuanto se comprueba que la suscripcion de Kick siga estando.
   Cinco minutos es lo que pide el plan: seguido como para que un
   corte no se coma media transmision, espaciado como para no gastar
   la cuota de la API en algo que casi nunca cambia. */
const CADA_VERIFICACION = 5 * 60 * 1000;

/* Cuanto silencio de una red se considera sospechoso. Solo se avisa
   fuerte si ADEMAS el canal esta en vivo: con el canal apagado, cero
   mensajes en una hora es lo normal. */
export const SILENCIO_SOSPECHOSO = 5 * 60 * 1000;

/* Cuantos ids de mensaje de Twitch recordar para el dedupe entre
   EventSub e IRC. Un stream movido hace 500 mensajes en minutos, y
   las dos vias no llegan separadas por mas que segundos. */
const TOPE_VISTOS = 500;

/* --------------------------------------------------------- estado */

let slugDueno = '';
let urlBase = '';

const estado = {
  kick: { ultima: null, suscripcion: 'desconocida', vivo: false, broadcasterId: '', vinculado: false },
  twitch: { ultima: null, estado: 'cortado', modo: 'ninguno', vinculado: false },
};

let conexionTwitch = null;
let conexionIrc = null;
const vistosTwitch = new Set();

let timerVerificacion = null;

/** Solo para los tests: deja el modulo como recien cargado. */
export function reiniciar() {
  parar();
  slugDueno = '';
  urlBase = '';
  estado.kick = { ultima: null, suscripcion: 'desconocida', vivo: false, broadcasterId: '', vinculado: false };
  estado.twitch = { ultima: null, estado: 'cortado', modo: 'ninguno', vinculado: false };
  vistosTwitch.clear();
}

/* ------------------------------------------------------- arranque */

/**
 * Pone en marcha lo que se pueda con lo que haya guardado.
 *
 * Se llama al arrancar el servidor. No tira NUNCA: un vinculo que no
 * se puede levantar tiene que dejar el servidor arriba y decirlo en
 * la pagina de salud, no impedir que el sitio exista.
 */
export async function arrancar({ slug, base } = {}) {
  slugDueno = String(slug ?? '').toLowerCase();
  urlBase = String(base ?? '');
  if (!slugDueno) {
    console.warn('[chat] sin KICK_SLUG: el Chat Global no sabe de que canal es');
    return;
  }

  try { await verificarKick(); }
  catch (e) { console.warn('[chat] no se pudo verificar la suscripcion de Kick:', e.message); }

  try { await conectarTwitch(); }
  catch (e) { console.warn('[chat] no se pudo conectar Twitch:', e.message); }

  timerVerificacion = setInterval(() => {
    verificarKick().catch(e => console.warn('[chat] verificacion de Kick:', e.message));
  }, CADA_VERIFICACION);
  timerVerificacion.unref?.();
}

/** Corta todo: los timers y las dos conexiones de Twitch. */
export function parar() {
  clearInterval(timerVerificacion);
  timerVerificacion = null;
  if (conexionTwitch) { conexionTwitch.cerrar(); conexionTwitch = null; }
  if (conexionIrc) { conexionIrc.cerrar(); conexionIrc = null; }
  estado.twitch.modo = 'ninguno';
  estado.twitch.estado = 'cortado';
}

/* ----------------------------------------------------------- Kick */

/**
 * Se fija que la suscripcion a chat.message.sent siga existiendo y la
 * vuelve a crear si no.
 *
 * OJO: la API de Kick NO devuelve un estado por suscripcion. Lo unico
 * que se puede comprobar es que la suscripcion EXISTA; que Kick le
 * este entregando algo a nuestro webhook no se puede saber por aca.
 * Por eso esta verificacion es la mitad de la historia y la otra
 * mitad es `ultima` (cuando llego el ultimo mensaje de verdad).
 */
export async function verificarKick() {
  const v = await vinculos.acceso('kick').catch(e => {
    console.warn('[chat] el vinculo de Kick no sirve:', e.message);
    return null;
  });
  if (!v) {
    estado.kick.vinculado = false;
    estado.kick.suscripcion = 'desconocida';
    return { vinculado: false };
  }
  estado.kick.vinculado = true;

  /* En Kick, el broadcaster_user_id de un canal es el user_id de su
     dueño: el mismo numero que devuelve /users para el token. */
  estado.kick.broadcasterId = v.usuarioId;

  const actuales = await kick.listarSuscripciones(v.accessToken, v.usuarioId);
  const falta = kick.EVENTOS.filter(
    e => !actuales.some(s => s.event === e.name && Number(s.version) === e.version),
  );

  if (!falta.length) {
    estado.kick.suscripcion = 'activa';
    return { vinculado: true, resuscrito: false };
  }

  console.warn(`[chat] faltaban ${falta.length} suscripciones de Kick: se vuelven a crear`);
  await kick.suscribirEventos(v.accessToken, v.usuarioId, urlBase ? `${urlBase}/kick/webhook` : '');
  estado.kick.suscripcion = 'activa';
  return { vinculado: true, resuscrito: true };
}

/** Fuerza la resuscripcion, aunque parezca que esta todo bien. */
export async function resuscribirKick() {
  const v = await vinculos.acceso('kick');
  if (!v) throw new Error('no hay vinculo con Kick');
  estado.kick.broadcasterId = v.usuarioId;
  await kick.suscribirEventos(v.accessToken, v.usuarioId, urlBase ? `${urlBase}/kick/webhook` : '');
  estado.kick.suscripcion = 'activa';
  return { ok: true };
}

/**
 * Un evento de Kick ya verificado. Devuelve que se hizo con el, para
 * que el que llama pueda loguearlo.
 */
export function recibirDeKick(evento, cuerpo) {
  const slug = String(cuerpo?.broadcaster?.channel_slug ?? slugDueno ?? '').toLowerCase();
  if (!slug) return { hecho: 'sin canal' };

  if (evento?.tipo === 'chat.message.sent') {
    const mensaje = mensajes.deKick(cuerpo, { hora: evento.cuando });
    if (!mensaje) return { hecho: 'payload raro' };
    estado.kick.ultima = new Date();
    canales.recordar(slug, mensaje);
    return { hecho: 'chat', mensaje };
  }

  if (evento?.tipo === 'livestream.status.updated') {
    const vivo = mensajes.vivoDeKick(cuerpo);
    if (vivo !== null) {
      estado.kick.vivo = vivo;
    }
    return { hecho: 'vivo', vivo };
  }

  return { hecho: 'ignorado' };
}

/* --------------------------------------------------------- Twitch */

/**
 * Abre (o reabre) la conexion EventSub con el vinculo guardado.
 * Si no hay vinculo, no hace nada y lo dice.
 */
export async function conectarTwitch() {
  const v = await vinculos.acceso('twitch').catch(e => {
    console.warn('[chat] el vinculo de Twitch no sirve:', e.message);
    return null;
  });
  if (!v) {
    estado.twitch.vinculado = false;
    estado.twitch.modo = 'ninguno';
    estado.twitch.estado = 'cortado';
    return { vinculado: false };
  }
  estado.twitch.vinculado = true;

  if (conexionTwitch) conexionTwitch.cerrar();

  conexionTwitch = new twitch.ConexionEventSub({
    /* El token se pide DE NUEVO en cada suscripcion, no se captura el
       de ahora: entre una reconexion y la siguiente pueden pasar
       horas y el access token dura una. */
    suscribir: async (sessionId) => {
      const actual = await vinculos.acceso('twitch');
      if (!actual) throw new Error('se perdio el vinculo de Twitch');
      await twitch.suscribirChat({
        accessToken: actual.accessToken,
        sessionId,
        /* El dueño escucha SU PROPIO canal: broadcaster y usuario que
           lee son la misma persona. En la Fase 3, con otros
           creadores, esto deja de ser cierto. */
        broadcasterId: actual.usuarioId,
        usuarioId: actual.usuarioId,
      });
    },
    alMensaje: (evento, metadata) => {
      const mensaje = mensajes.deTwitch(evento, metadata);
      recibirDeTwitch(mensaje);
    },
    alEstado: (nuevo) => {
      /* alEstado tambien avisa cosas que no son estados de conexion
         ("revocado:...", "error_suscripcion:..."). Esas se loguean y
         no pisan el estado, que tiene cuatro valores y nada mas. */
      if (['cortado', 'conectando', 'conectado', 'reconectando'].includes(nuevo)) {
        estado.twitch.estado = nuevo;
        if (nuevo === 'conectado') {
          estado.twitch.modo = 'eventsub';
          apagarPlanB();
        }
      } else {
        console.warn('[chat] twitch avisa:', nuevo);
      }
      revisarPlanB();
    },
  });

  estado.twitch.modo = 'eventsub';
  conexionTwitch.conectar();
  return { vinculado: true };
}

/** Un mensaje de Twitch, venga por donde venga. */
export function recibirDeTwitch(mensaje) {
  if (!mensaje) return false;
  /* El dedupe existe por la ventana en la que EventSub y el plan B
     estan los dos prendidos. El id es el mismo por las dos vias. */
  if (mensaje.id) {
    if (vistosTwitch.has(mensaje.id)) return false;
    vistosTwitch.add(mensaje.id);
    if (vistosTwitch.size > TOPE_VISTOS) {
      vistosTwitch.delete(vistosTwitch.values().next().value);
    }
  }
  estado.twitch.ultima = new Date();
  if (slugDueno) canales.recordar(slugDueno, mensaje);
  return true;
}

/* --------------------------------------------------------- plan B */

/* Mas de tres fallos seguidos de EventSub y se prende el IRC
   anonimo. Tres y no uno: una reconexion suelta es normal (Twitch
   recicla sus servidores) y prender el plan B por eso seria tener
   dos conexiones abiertas todo el tiempo. */
export const FALLOS_PARA_PLAN_B = 3;

function revisarPlanB() {
  if (!conexionTwitch) return;
  if (conexionTwitch.intentosFallidosSeguidos > FALLOS_PARA_PLAN_B) prenderPlanB();
}

async function prenderPlanB() {
  if (conexionIrc) return;
  const v = await vinculos.leer('twitch');
  const canalTwitch = v?.login ?? '';
  if (!canalTwitch) {
    console.warn('[chat] no se puede prender el plan B: no se sabe el canal de Twitch');
    return;
  }

  console.warn(`[chat] EventSub fallo ${FALLOS_PARA_PLAN_B}+ veces seguidas: ` +
               `se prende el IRC anonimo mientras se sigue reintentando`);
  estado.twitch.modo = 'irc';
  conexionIrc = new ConexionIrc({
    canal: canalTwitch,
    alMensaje: mensaje => recibirDeTwitch(mensaje),
  });
  conexionIrc.conectar();
}

function apagarPlanB() {
  if (!conexionIrc) return;
  console.log('[chat] EventSub volvio: se apaga el IRC anonimo');
  conexionIrc.cerrar();
  conexionIrc = null;
}

/* --------------------------------------------------------- enviar */

/**
 * Manda un mensaje a una red o a las dos, con la cuenta del dueño.
 *
 * Devuelve un resultado POR RED. No tira si una falla: que Twitch
 * rechace no tiene por que borrar el hecho de que en Kick salio, y
 * la pagina tiene que poder decir exactamente eso.
 *
 * @param {{texto:string, destino:'kick'|'twitch'|'ambos', respondeA?:string}} pedido
 */
export async function enviar({ texto, destino = 'kick', respondeA } = {}) {
  const cuerpo = String(texto ?? '').trim();
  if (!cuerpo) return { error: 'el mensaje esta vacio' };

  const problema = kick.porQueNoSePuedeMandar(cuerpo);
  /* El tope de Kick (500 caracteres y 2048 bytes) es mas estricto que
     el de Twitch (500 caracteres), asi que se valida con el de Kick
     cuando el mensaje va a Kick. */
  if (problema && destino !== 'twitch') return { error: problema };
  if (destino === 'twitch' && [...cuerpo].length > 500) {
    return { error: `el mensaje tiene ${[...cuerpo].length} caracteres y el tope de Twitch es 500` };
  }

  const salida = {};
  const tareas = [];
  if (destino === 'kick' || destino === 'ambos') tareas.push(enviarAKick(cuerpo, respondeA, salida));
  if (destino === 'twitch' || destino === 'ambos') tareas.push(enviarATwitch(cuerpo, respondeA, salida));
  if (!tareas.length) return { error: `destino desconocido: ${destino}` };

  await Promise.all(tareas);
  return salida;
}

async function enviarAKick(texto, respondeA, salida) {
  try {
    const v = await vinculos.acceso('kick');
    if (!v) { salida.kick = { ok: false, motivo: 'no hay vinculo con Kick' }; return; }
    const r = await kick.enviarMensaje(v.accessToken, v.usuarioId, texto, { respondeA });
    salida.kick = r.enviado
      ? { ok: true, motivo: '' }
      : { ok: false, motivo: 'Kick lo recibio pero no lo publico' };
  } catch (e) {
    salida.kick = { ok: false, motivo: recortarError(e), estado: e.status ?? 0 };
  }
}

async function enviarATwitch(texto, respondeA, salida) {
  try {
    const v = await vinculos.acceso('twitch');
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

/**
 * Como esta cada via, en un objeto listo para mandar tal cual.
 *
 * NO SALE POR EL BUS SSE, y es a proposito. El bus de un canal es
 * publico: en la Fase 2 lo escucha cualquiera que este mirando la
 * peli. La salud dice si el dueño tiene vinculada cada red, si su
 * conexion esta en el plan B y si su canal esta en vivo: no es un
 * secreto, pero es informacion de la cuenta del dueño y no tiene por
 * que viajar a todo el que abra la sala. La pide /chat contra
 * /api/chat/salud, que exige la cookie del dueño.
 */
export function salud() {
  const twitchEstado = conexionTwitch?.estado ?? estado.twitch.estado;
  const ultimaTwitch = ultimaDe(estado.twitch.ultima, conexionIrc?.ultimaLlegada);
  return {
    kick: {
      vinculado: estado.kick.vinculado,
      ultima: estado.kick.ultima ? estado.kick.ultima.toISOString() : null,
      suscripcion: estado.kick.suscripcion,
      vivo: estado.kick.vivo,
    },
    twitch: {
      vinculado: estado.twitch.vinculado,
      ultima: ultimaTwitch ? ultimaTwitch.toISOString() : null,
      estado: twitchEstado,
      modo: conexionIrc ? 'irc' : estado.twitch.modo,
    },
    ahora: new Date().toISOString(),
  };
}

const ultimaDe = (a, b) => {
  if (!a) return b ?? null;
  if (!b) return a;
  return a > b ? a : b;
};

/** Si hace demasiado que Kick no dice nada con el canal en vivo. */
export function kickSospechoso(ahora = Date.now()) {
  if (!estado.kick.vivo) return false;
  const t = estado.kick.ultima?.getTime() ?? 0;
  return ahora - t > SILENCIO_SOSPECHOSO;
}

/* Solo para los tests y para el arranque: dejar anotado el canal sin
   levantar conexiones. */
export function fijarCanal(slug) {
  slugDueno = String(slug ?? '').toLowerCase();
}
