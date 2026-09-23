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
   cookies. Quien decide que hacer con eso es cada ruta, pero las dos
   hacen lo mismo con un permiso vencido: DESCONECTAN ESA RED Y NADA
   MAS. La Sala, ademas, cierra la sesion si con eso la persona se
   quedo sin ninguna red.

   ASI NO ERA, Y EL MOTIVO ESCRITO ERA FALSO. La Sala llamaba a
   `espectadores.olvidar` —el documento entero, las dos redes— con este
   argumento: "es un producto de una sola red, y un token de Twitch al
   que ninguna sesion apunta es una credencial que su dueño no puede ni
   usar ni borrar". La premisa no se cumple desde la Fase 5.3: el
   espectador es UNO SOLO para todo el dominio y la MISMA cookie vale
   en /chat/<slug>, asi que despues de ese borrado sí habia una sesion
   apuntando al token de Twitch: la que estaba usando en la otra
   pagina. Borrarlo era hacerle perder una cuenta que andaba por un
   problema en la otra.

   `caduco` es justamente eso: "este permiso no sirve mas", sin decir
   que hay que hacer al respecto.

   ---------------------------------------------------------------
   Y ES EL UNICO QUE SABE A QUE RED LE HABLA

   Por eso la traduccion de los emotes vive aca (`comoViajaA`). El
   mismo emote no se escribe igual en las dos redes, y con
   `red: "ambas"` el mensaje sale a las dos a la vez: si la pagina
   armara el markup, tendria que elegir uno y el otro lado veria la
   eleccion equivocada. Ver el comentario largo de `comoViajaA`.

   ---------------------------------------------------------------
   UN 403 NO ES UN PERMISO VENCIDO

   Las dos plataformas contestan 401 cuando el token no sirve y 403
   cuando quien escribe no puede escribir EN ESE CANAL: baneado, modo
   solo-seguidores, solo-suscriptores. Tratarlos igual —como se hacia
   hasta el 2026-09-22— le borraba el permiso a alguien que lo tenia
   perfecto y lo mandaba a reconectar su cuenta para volver a chocar
   contra el mismo baneo. Solo el 401 marca `caduco`.

   ---------------------------------------------------------------
   UN 200 DE TWITCH NO QUIERE DECIR QUE SALIO

   `POST helix/chat/messages` contesta 200 y adentro dice `is_sent`.
   Si es false, el mensaje no llego al chat (AutoMod, baneado, modo
   solo-seguidores, slow mode) y el motivo viene en `drop_reason`. Se
   lo devolvemos tal cual a la persona: decirle "enviado" cuando no
   salio es la peor mentira posible de un chat, porque se queda
   esperando una respuesta que nadie va a ver.
   ============================================================ */

import * as creadores from './creadores.js';
import * as emotes from './emotes.js';
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
 * Las redes en las que el creador de ESTA sala bloqueo a esta persona.
 *
 * Una sola implementacion para las dos puertas, y por eso vive aca y no
 * en un manejador: `/api/sala/:slug/chat` y `/api/chat/:slug/enviar`
 * caen en el mismo canal de Kick, asi que un bloqueo que valga en una
 * sola no es un bloqueo. El creador bloquea a una PERSONA (por su id en
 * esa red), no a una pantalla.
 *
 * @param {string} slug
 * @param {object} v      el espectador leido (`espectadores.leer`)
 * @param {string[]} redes
 */
export async function bloqueadasPara(slug, v, redes) {
  const c = await creadores.chatAbierto(slug);
  return redes.filter(red => v?.[red] && creadores.estaBloqueado(c, red, v[red].usuarioId));
}

/**
 * El texto tal como va a viajar.
 *
 * EXISTE PARA QUE LO QUE SE MIDE SEA LO QUE SE MANDA. El tope se
 * comprobaba sobre el texto recortado y despues se mandaba el crudo:
 * 400 letras y 400 espacios pasaban como 400 caracteres y llegaban a
 * Twitch como 800. Kick zafaba de casualidad porque `kick.js` vuelve a
 * recortar adentro; Twitch manda `message: texto` tal cual, asi que con
 * "las dos" el mismo mensaje salia distinto en cada red.
 */
export const comoViaja = texto => String(texto ?? '').trim();

/**
 * El texto tal como lo va a recibir ESA red.
 *
 * ---------------------------------------------------------------
 * EL MISMO EMOTE NO SE ESCRIBE IGUAL EN LAS DOS REDES
 *
 * Un emote nativo de Kick viaja como `[emote:5747892:MEGALUL]`: eso
 * es lo que kick.com pone en el `content` y lo que hay que mandarle a
 * su API para que salga dibujado. En Twitch ese markup no significa
 * nada: sale en pantalla como esos corchetes, literales, delante de
 * toda la comunidad del otro lado.
 *
 * Por eso la traduccion la hace ESTE modulo y no la pagina: aca es el
 * unico lugar del proyecto por el que pasan los dos envios, y es el
 * unico que sabe a que red le esta hablando. La caja de escribir
 * guarda UNA sola forma del mensaje y nunca decide markup.
 *
 * NO ES SOLO PARA EL SELECTOR. Cualquiera puede escribir
 * `[emote:1:X]` a mano en la caja, y hasta hoy eso llegaba a Twitch
 * tal cual. O sea que esto arregla algo que ya estaba mal, ademas de
 * habilitar el selector.
 *
 * El precio, dicho sin adornos: quien quiera escribir esos corchetes
 * literalmente en Twitch no va a poder. Es un texto que nadie escribe
 * y el cambio se lleva puesto un bug real.
 *
 * ES UNA FUNCION PURA, y eso es lo que sostiene la garantia de abajo:
 * no mira ninguna tabla, ninguna cache y ningun reloj. La misma
 * entrada da siempre la misma salida, asi que medir y mandar por
 * separado no puede dar distinto.
 */
export function comoViajaA(texto, red) {
  const cuerpo = comoViaja(texto);
  /* Kick recibe el markup tal cual: es el suyo. */
  if (red !== 'twitch') return cuerpo;
  /* Twitch recibe la palabra: un emote de Kick no existe ahi, y que
     se lea el nombre es lo mejor que se puede hacer. Se vuelve a
     recortar porque un emote sin nombre desaparece entero y puede
     dejar espacios sueltos en las puntas. */
  return emotes.sinMarcasDeKick(cuerpo).trim();
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
 *
 * ---------------------------------------------------------------
 * CONTRA QUE SE MIDE CADA TOPE: CONTRA LO QUE ESA RED VA A RECIBIR
 *
 * Desde que hay emotes, el mensaje YA NO ES EL MISMO string en las
 * dos redes: `[emote:5747892:collectiblesMEGALUL]` son 36 caracteres
 * para Kick y `collectiblesMEGALUL` son 19 para Twitch. Medir los dos
 * topes contra un unico texto tendria que elegir cual de los dos
 * mentir, y las dos mentiras son caras: medir el largo de Kick contra
 * el de Twitch deja pasar mensajes que Kick rechaza, y al reves frena
 * mensajes que Twitch aceptaba perfecto.
 *
 * Asi que cada red se mide contra SU texto. El tope existe para
 * adivinar si esa plataforma lo va a aceptar, y la plataforma cuenta
 * lo que le llega.
 *
 * LA INVARIANTE QUE SE CONSERVA —la que tenia `comoViaja` y por la
 * que hubo un bug— no era "el mismo string a las dos redes": era LO
 * QUE SE MIDE ES LO QUE SE MANDA. Eso sigue en pie y ahora por red:
 * `aUnaRed` manda exactamente `comoViajaA(texto, red)`, que es lo
 * mismo que se midio aca. Y se sostiene sin acordarse de nada, porque
 * `comoViajaA` es pura: no hay estado que pueda cambiar entre la
 * medicion y el envio.
 */
export function porQueNoSePuedeMandar(texto, redes) {
  if (!comoViaja(texto)) return 'el mensaje esta vacio';

  if (redes.includes('kick')) {
    const problema = kick.porQueNoSePuedeMandar(comoViajaA(texto, 'kick'));
    if (problema) return problema;
  }
  if (redes.includes('twitch')) {
    const cuerpo = comoViajaA(texto, 'twitch');
    /* Un mensaje que era SOLO un emote de Kick sin nombre no deja
       nada para Twitch. Se dice por que, en vez del "el mensaje esta
       vacio" de arriba, que mirando la caja llena seria un misterio. */
    if (!cuerpo) return 'en Twitch no queda nada que leer: ese mensaje es solo un emote de Kick';
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
  /* Acá y no en cada ruta: lo que viaja es lo que se midio, venga de
     donde venga. La MISMA funcion pura que uso
     `porQueNoSePuedeMandar`, con el mismo texto y la misma red, asi
     que no hay forma de que le salga distinto. */
  const cuerpo = comoViajaA(texto, red);
  return red === 'twitch'
    ? aTwitch(slug, espId, cuerpo)
    : aKick(slug, espId, cuerpo);
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
    if (estado === 401) {
      return mal('Kick rechazo tu permiso: conecta Kick de nuevo', 401, true);
    }
    if (estado === 403) {
      /* No es el token: es el canal. Kick contesta 403 a quien esta
         baneado o a quien escribe en un chat en modo solo-seguidores.
         Reconectar la cuenta no lo arregla, asi que no se le toca. */
      return mal('Kick no te deja escribir en este canal', 403);
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
    if (estado === 401) {
      return mal('Twitch rechazo tu permiso: conecta Twitch de nuevo', 401, true);
    }
    if (estado === 403) {
      /* Mismo caso que en Kick: 403 de Helix es "este canal no te deja
         escribir" (baneado, solo seguidores, solo suscriptores), no
         "tu token vencio". */
      return mal('Twitch no te deja escribir en este canal', 403);
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
