/* ============================================================
   El mensaje de un espectador, camino a Kick y a Twitch.

   Un solo lugar para las dos puertas que lo usan:

     POST /api/sala/:slug/chat    la Sala (solo Kick, como siempre)
     POST /api/chat/:slug/enviar  el chat abierto (Kick, Twitch o las dos)

   Antes esto vivia entero adentro del manejador de la Sala. Se saco
   aca para que la puerta nueva no sea una copia con los mismos frenos
   escritos de nuevo: el dia que cambie el tope de Kick, o el trato que
   se le da a un 429, tiene que cambiar en un lado solo.

   ---------------------------------------------------------------
   ESTE MODULO NO SABE DE HTTP, Y ES A PROPOSITO

   Devuelve `{ ok, motivo, estado, caduco }` y no toca `res` ni
   cookies. Quien decide que hacer con eso es cada ruta, porque no
   deciden lo mismo:

     - la Sala, con un token que ya no sirve, CIERRA LA SESION y borra
       al espectador entero. Es un producto de una sola red: si Kick lo
       rechaza no queda nada que hacer ahi, y dejar vivo un token de
       Twitch al que ninguna sesion apunta seria guardar credenciales
       de alguien que no las puede usar ni borrar.
     - el chat abierto DESCONECTA SOLO ESA RED y deja la sesion en pie,
       porque la otra red puede seguir andando.

   `caduco` es justamente eso: "este permiso no sirve mas", sin decir
   que hay que hacer al respecto.

   ---------------------------------------------------------------
   UN 200 DE TWITCH NO QUIERE DECIR QUE SALIO

   `POST helix/chat/messages` contesta 200 y adentro dice `is_sent`.
   Si es false, el mensaje no llego al chat (AutoMod, baneado, modo
   solo-seguidores, slow mode) y el motivo viene en `drop_reason`. Se
   lo devolvemos tal cual a la persona: decirle "enviado" cuando no
   salio es la peor mentira posible de un chat, porque se queda
   esperando una respuesta que nadie va a ver.
   ============================================================ */

import * as espectadores from './espectadores.js';
import * as kick from './kick.js';
import * as metricas from './metricas.js';
import * as twitch from './twitch.js';
import * as vinculos from './vinculos.js';

/** Las redes a las que un espectador puede mandar. */
export const REDES = Object.freeze(['kick', 'twitch']);

/** `red` del cuerpo -> a que redes va de verdad. `null` si no se entiende. */
export function redesDelPedido(red) {
  if (red === 'ambas') return [...REDES];
  return REDES.includes(red) ? [red] : null;
}

/**
 * Por que este texto no se puede mandar a estas redes, o ''.
 *
 * Los dos topes dicen "500" y no son el mismo numero: Kick cuenta
 * grapheme clusters (una familia de emojis es un caracter) y Twitch
 * cuenta puntos de codigo (esa misma familia son siete). Se miran los
 * de TODAS las redes a las que va antes de mandarle nada a ninguna:
 * si no, con "las dos" el mensaje sale en Kick y Twitch lo rechaza, y
 * ahi ya no se puede deshacer.
 */
export function porQueNoSePuedeMandar(texto, redes) {
  const cuerpo = String(texto ?? '').trim();
  if (!cuerpo) return 'el mensaje esta vacio';

  if (redes.includes('kick')) {
    const problema = kick.porQueNoSePuedeMandar(cuerpo);
    if (problema) return problema;
  }
  if (redes.includes('twitch')) {
    const puntos = [...cuerpo].length;
    if (puntos > 500) return `el mensaje tiene ${puntos} caracteres y el tope de Twitch es 500`;
  }
  return '';
}

/* El texto de un error se muestra en pantalla, asi que se recorta y no
   se le confia el largo a la API de nadie. */
const recortar = e => String(e?.message ?? 'no se pudo enviar').slice(0, 200);

/* Los errores de twitch.js traen el status adentro del texto porque no
   lo exponen como campo. Se lo saca de ahi para poder distinguir un
   429 de un 401. */
function estadoDeError(e) {
  if (e?.status) return e.status;
  const m = /respondio (\d{3})/.exec(String(e?.message ?? ''));
  return m ? Number(m[1]) : 0;
}

const bien = () => ({ ok: true, motivo: '', estado: 200, caduco: false });
const mal = (motivo, estado = 502, caduco = false) => ({ ok: false, motivo, estado, caduco });

/**
 * Manda el mensaje de un espectador a UNA red. Nunca tira: todo lo
 * que sale mal vuelve como `{ ok: false, motivo }`.
 *
 * @param {string} slug   la sala. Sale del camino de la URL, nunca del cuerpo.
 * @param {string} espId  el id del espectador (el de su cookie)
 * @param {'kick'|'twitch'} red
 * @param {string} texto
 */
export async function aUnaRed(slug, espId, red, texto) {
  if (!REDES.includes(red)) return mal(`red desconocida: ${red}`, 400);
  return red === 'twitch'
    ? aTwitch(slug, espId, texto)
    : aKick(slug, espId, texto);
}

async function aKick(slug, espId, texto) {
  /*
   * EL MENSAJE CAE EN EL CANAL DE ESTA SALA.
   *
   * `identidad` y no `acceso`: hace falta el numero del canal, no el
   * token del creador. El refresh token del creador no tiene por que
   * pasar por el camino de un mensaje de un espectador.
   */
  const anfitrion = await vinculos.identidad(slug, 'kick');
  if (!anfitrion?.usuarioId) return mal('el canal todavia no esta vinculado con Kick', 503);

  const token = await espectadores.acceso(espId, 'kick');
  if (!token) return mal('tu permiso con Kick vencio: conecta Kick de nuevo', 401, true);

  try {
    const r = await kick.enviarMensaje(token, anfitrion.usuarioId, texto);
    metricas.registrarEnvio(slug, { ok: r.enviado });
    return r.enviado ? bien() : mal('Kick lo recibio pero no lo publico');
  } catch (e) {
    const estado = e.status ?? 0;
    metricas.registrarEnvio(slug, { ok: false, estado });

    if (estado === 429) {
      /* El 429 es del CANAL, no de la persona: se frena a todos por lo
         que diga Retry-After. Seguir mandando solo consigue mas 429. */
      const espera = espectadores.anotar429(slug, e.retryAfter);
      return { ...mal('Kick esta frenando los envios del canal', 429), esperar: Math.ceil(espera / 1000) };
    }
    if (estado === 401 || estado === 403) {
      return mal('Kick rechazo tu permiso: conecta Kick de nuevo', estado, true);
    }
    return mal(recortar(e));
  }
}

async function aTwitch(slug, espId, texto) {
  /* El canal es el del CREADOR de esta sala; quien habla es el
     espectador. Los dos ids van en el mismo pedido y son distintos:
     por eso el mensaje sale en twitch.tv con el nombre de la persona y
     Twitch le aplica sus propias reglas (baneos, slow mode, AutoMod)
     como si escribiera desde su web. */
  const anfitrion = await vinculos.identidad(slug, 'twitch');
  if (!anfitrion?.usuarioId) return mal('el canal todavia no esta vinculado con Twitch', 503);

  const v = await espectadores.leer(espId);
  if (!v?.twitch?.usuarioId) return mal('no tenes Twitch conectado', 401, true);

  const token = await espectadores.acceso(espId, 'twitch');
  if (!token) return mal('tu permiso con Twitch vencio: conecta Twitch de nuevo', 401, true);

  try {
    const r = await twitch.enviarMensaje({
      accessToken: token,
      broadcasterId: anfitrion.usuarioId,
      senderId: v.twitch.usuarioId,
      texto,
    });
    metricas.registrarEnvio(slug, { ok: r.enviado });
    /* 200 con is_sent=false: el motivo es de Twitch y se muestra tal
       cual. El estado sigue siendo 200 porque la red anduvo: lo que
       no paso es que el mensaje entrara al chat. */
    return r.enviado ? bien() : mal(r.motivo || 'Twitch lo retuvo sin decir por que', 200);
  } catch (e) {
    const estado = estadoDeError(e);
    metricas.registrarEnvio(slug, { ok: false, estado });

    if (estado === 429) {
      /* El limite de Twitch es por CUENTA (20 cada 30 s para quien no
         es mod), no por canal: se frena a quien lo pidio y a nadie mas. */
      return { ...mal('Twitch esta frenando tus envios', 429), esperar: 5 };
    }
    if (estado === 401 || estado === 403) {
      return mal('Twitch rechazo tu permiso: conecta Twitch de nuevo', estado, true);
    }
    return mal(recortar(e));
  }
}

/**
 * El mismo mensaje a varias redes, en paralelo.
 *
 * En paralelo y no una despues de la otra porque "las dos" es UN
 * envio: hacer esperar a Twitch a que Kick conteste duplicaria la
 * demora que siente la persona, y si Kick tarda 30 s en fallar el
 * mensaje llegaria a Twitch medio minuto tarde, fuera de conversacion.
 *
 * Devuelve `{ kick?: resultado, twitch?: resultado }`: el caso
 * interesante es el del medio, salio en una y no en la otra, y un
 * si/no global ahi haria que la persona lo escriba de nuevo y quede
 * repetido en la red donde si habia salido.
 */
export async function aVariasRedes(slug, espId, redes, texto) {
  const salida = {};
  await Promise.all(redes.map(async (red) => {
    salida[red] = await aUnaRed(slug, espId, red, texto);
  }));
  return salida;
}
