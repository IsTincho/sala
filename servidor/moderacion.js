/* ============================================================
   Moderar el chat de una sala en Kick y en Twitch, de verdad.

   Lo hace el CREADOR desde /chat, con SU token y sobre SU canal: el
   dueño de un canal es moderador de su propio chat en las dos redes.
   Cuatro acciones:

     borrar      un mensaje (por su id en esa red)
     timeout     a una persona, N minutos
     ban         a una persona, sin vencimiento
     desbanear   saca el ban o el timeout (es el "deshacer" de los dos)

   No es el bloqueo de esta herramienta (`chatAbierto.bloqueados`). Ese
   solo frena lo que se escribe desde aca; esto pasa en kick.com y
   twitch.tv y lo ve todo el mundo. Los dos conviven: el boton de
   bloquear sigue para quien moleste solo por aca.

   ---------------------------------------------------------------
   ESTE MODULO NO SABE DE HTTP, COMO envio.js

   Devuelve `{ ok, motivo, estado, faltaPermiso }` y nunca tira. Lo que
   se hace con eso (y el aviso por el bus) lo decide la ruta.

   ---------------------------------------------------------------
   EL PERMISO SE MIRA ANTES DE PEDIR

   Los vinculos de antes de esto no tienen los scopes de moderacion.
   Mandar el pedido igual da un 401 que Kick y Twitch explican cada uno
   a su manera; mirarlo antes permite decir que hacer ("volve a entrar
   con Kick desde el panel") y no gastar un pedido. Un vinculo sin
   scopes anotados (no se sabe que tiene) se prueba igual, y si la red
   contesta 401 se dice lo mismo.

   ---------------------------------------------------------------
   UNIDADES

   Kick mide el timeout en MINUTOS (1 a 10.080) y Twitch en SEGUNDOS
   (1 a 1.209.600). Aca se habla en minutos y el tope es el de Kick,
   una semana, para que el mismo timeout valga en las dos.
   ============================================================ */

import * as kick from './kick.js';
import * as twitch from './twitch.js';
import * as vinculos from './vinculos.js';

export const ACCIONES = Object.freeze(['borrar', 'timeout', 'ban', 'desbanear']);
export const REDES = Object.freeze(['kick', 'twitch']);

export const MINUTOS_DEFECTO = 10;
export const TOPE_MINUTOS = kick.TOPE_MINUTOS;

/* Que scope pide cada accion en cada red. */
const PERMISO = {
  kick: { borrar: 'moderation:chat_message:manage', otra: 'moderation:ban' },
  twitch: { borrar: 'moderator:manage:chat_messages', otra: 'moderator:manage:banned_users' },
};

const COMO_ARREGLAR = {
  kick: 'falta el permiso de moderación de Kick: salí y volvé a entrar con Kick desde el panel',
  twitch: 'falta el permiso de moderación de Twitch: volvé a vincular Twitch desde el panel',
};

const NOMBRE = { kick: 'Kick', twitch: 'Twitch' };

/* Los ids de usuario de las dos redes son numeros; los de mensaje, UUID. */
const ID_USUARIO = /^\d{1,20}$/;
const ID_MENSAJE = /^[0-9a-zA-Z_-]{1,64}$/;

const bien = () => ({ ok: true, motivo: '', estado: 200, faltaPermiso: false });
const mal = (motivo, estado = 502, faltaPermiso = false) => ({ ok: false, motivo, estado, faltaPermiso });

/**
 * Por que este pedido no se puede ni intentar, o '' si se puede.
 * Pura: la usa la ruta para contestar 400 sin tocar ningun vinculo.
 *
 * @param {{accion?:string, red?:string, mensajeId?:string, usuarioId?:string, minutos?:number}} p
 */
export function porQueNo(p) {
  if (!ACCIONES.includes(p?.accion)) return 'accion desconocida: borrar, timeout, ban o desbanear';
  if (!REDES.includes(p?.red)) return 'hace falta una red: kick o twitch';
  if (p.accion === 'borrar') {
    return ID_MENSAJE.test(String(p.mensajeId ?? '')) ? '' : 'hace falta el id del mensaje';
  }
  if (!ID_USUARIO.test(String(p.usuarioId ?? ''))) return 'hace falta el id de la persona en esa red';
  if (p.accion === 'timeout' && p.minutos !== undefined) {
    const m = p.minutos;
    if (!Number.isInteger(m) || m < 1 || m > TOPE_MINUTOS) {
      return `el timeout va de 1 a ${TOPE_MINUTOS} minutos`;
    }
  }
  return '';
}

const lista = scopes => (Array.isArray(scopes) ? scopes : String(scopes ?? '').split(/\s+/)).filter(Boolean);

/** El scope que le falta a este vinculo para esta accion, o ''. */
export function permisoQueFalta(red, scopes, accion) {
  const tiene = lista(scopes);
  /* Sin scopes anotados no se sabe: se prueba. Ver el encabezado. */
  if (!tiene.length) return '';
  const hace = PERMISO[red]?.[accion === 'borrar' ? 'borrar' : 'otra'];
  return hace && !tiene.includes(hace) ? hace : '';
}

/* El `message` que contesto Kick, si vino en JSON. `pedir` lo deja en
   el texto del error despues de "-> NNN: ". Nunca trae el token. */
function detalleDeKick(e) {
  const m = /-> \d{3}: (.*)$/s.exec(String(e?.message ?? ''));
  if (!m) return '';
  try { return String(JSON.parse(m[1])?.message ?? '').slice(0, 200); }
  catch { return m[1].slice(0, 200); }
}

/**
 * Hace la accion en la red. Nunca tira.
 *
 * @param {string} slug  la sala. Sale de la cookie del creador, nunca del cuerpo.
 * @param {{accion:string, red:string, mensajeId?:string, usuarioId?:string, minutos?:number, motivo?:string}} p
 */
export async function moderar(slug, p) {
  const problema = porQueNo(p);
  if (problema) return mal(problema, 400);
  const { accion, red } = p;

  let yo;
  try { yo = await vinculos.acceso(slug, red); }
  catch { return mal(`el permiso con ${NOMBRE[red]} venció: volvé a vincularlo desde el panel`, 401, true); }
  if (!yo?.usuarioId) return mal(`el canal todavía no está vinculado con ${NOMBRE[red]}`, 503);

  if (permisoQueFalta(red, yo.scopes, accion)) return mal(COMO_ARREGLAR[red], 403, true);

  /* Kick y Twitch no dejan banear al dueño del canal, pero el error de
     cada uno es criptico. Esto es un click equivocado: se dice claro. */
  if (accion !== 'borrar' && String(p.usuarioId) === String(yo.usuarioId)) {
    return mal('no te podés moderar a vos mismo', 400);
  }

  const minutos = accion === 'timeout' ? (p.minutos ?? MINUTOS_DEFECTO) : undefined;
  const motivo = String(p.motivo ?? '').trim();

  try {
    if (red === 'kick') {
      if (accion === 'borrar') await kick.borrarMensaje(yo.accessToken, p.mensajeId);
      else if (accion === 'desbanear') await kick.desbanear(yo.accessToken, yo.usuarioId, p.usuarioId);
      else await kick.banear(yo.accessToken, yo.usuarioId, p.usuarioId, { minutos, motivo });
    } else {
      const base = { accessToken: yo.accessToken, broadcasterId: yo.usuarioId };
      if (accion === 'borrar') await twitch.borrarMensaje({ ...base, mensajeId: p.mensajeId });
      else if (accion === 'desbanear') await twitch.desbanear({ ...base, usuarioId: p.usuarioId });
      else {
        await twitch.banear({
          ...base,
          usuarioId: p.usuarioId,
          segundos: minutos === undefined ? undefined : minutos * 60,
          motivo,
        });
      }
    }
  } catch (e) {
    const estado = e?.status ?? 0;
    const detalle = red === 'kick' ? detalleDeKick(e) : String(e?.detalle ?? '');
    if (estado === 401) return mal(COMO_ARREGLAR[red], 401, true);
    if (estado === 429) return mal(`${NOMBRE[red]} está frenando los pedidos: probá en un rato`, 429);
    if (estado === 404 && accion === 'borrar') {
      return mal(`${NOMBRE[red]} no encontró ese mensaje (ya lo borraron, o en Twitch tiene más de 6 horas)`, 404);
    }
    /* El resto (400, 403, 409) lo explica la red mejor que nosotros:
       "user is already banned", "no podes borrar mensajes de otro mod". */
    return mal(`${NOMBRE[red]} no lo hizo${detalle ? `: ${detalle}` : ` (${estado || 'sin respuesta'})`}`,
      estado >= 400 && estado < 500 ? estado : 502);
  }
  return bien();
}
