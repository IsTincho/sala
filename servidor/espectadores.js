/* ============================================================
   Los espectadores: la gente que entra a la Sala a ver la peli y
   escribir en el chat con SU cuenta de Kick.

   Es la parte del proyecto que guarda datos de terceros, y por eso es
   la que se escribe con mas cuidado.

   ---------------------------------------------------------------
   QUE SE GUARDA, Y POR QUE TAN POCO

   De cada espectador que entra: su user_id de Kick, su nombre para
   mostrar, y sus tokens CIFRADOS. Nada mas. No hay email, no hay IP,
   no hay historial de lo que escribio (lo que escribe va a Kick y
   vuelve por el webhook como cualquier otro mensaje del chat: no lo
   guardamos aparte).

   El refresh token hace falta de verdad: un access token de Kick dura
   una hora y una peli dura dos y media. Sin el, a la mitad de la
   pelicula todos dejarian de poder escribir. Va cifrado con
   AES-256-GCM, igual que el del dueño: `servidor/cifrado.js`.

   "Salir" borra el token Y la sesion. No es un logout de mentira que
   solo tira la cookie.

   ---------------------------------------------------------------
   POR QUE NO SE REUSA vinculos.js

   `vinculos.js` guarda UN documento por red (`kick:dueno`) y su API
   entera esta escrita alrededor de eso: `leer('kick')`,
   `acceso('kick')`. Los espectadores son N y su ciclo de vida es
   distinto (entran, se van, se los olvida). Meterlos ahi seria
   ensanchar una interfaz que hoy es clara para que sirva a dos cosas
   que no se parecen. Comparten la coleccion `tokens` y el cifrado,
   que es lo que de verdad tienen en comun.

   ---------------------------------------------------------------
   EL LIMITE DE ENVIO

   Uno cada dos segundos por persona, en memoria. En memoria y no en
   el almacen porque el limite es una defensa contra el dedo pesado y
   contra el spam de una noche, no un contrato: perderlo en un deploy
   cuesta que alguien pueda mandar dos mensajes seguidos una vez.
   Escribir en Mongo en cada mensaje del chat, en cambio, cuesta todas
   las noches.
   ============================================================ */

import * as almacen from './almacen.js';
import * as cifrado from './cifrado.js';
import * as kick from './kick.js';

/** Lo que espera un espectador entre dos mensajes. */
export const ESPERA_ENTRE_MENSAJES = 2000;

/* Margen antes del vencimiento para considerar que un access token ya
   no sirve: un token que vence en medio del pedido da un 401 que
   despues cuesta entender. */
const MARGEN = 60_000;

const idDe = usuarioId => `espectador:${usuarioId}`;

const valido = usuarioId => /^[0-9a-zA-Z_-]{1,64}$/.test(String(usuarioId ?? ''));

/* --------------------------------------------------------- guardar */

/**
 * Guarda (o pisa) el vinculo de un espectador con Kick.
 *
 * Sin CLAVE_CIFRADO no se guarda NADA: es preferible que la persona no
 * pueda escribir a que su refresh token quede en claro en una base.
 */
export async function guardar({ usuarioId, nombre, accessToken, refreshToken, venceEn, scopes }) {
  if (!valido(usuarioId)) throw new Error('usuario invalido');
  if (!cifrado.hayClave()) {
    throw new Error(`no se puede guardar el vinculo sin CLAVE_CIFRADO (${cifrado.porQueNoHayClave()})`);
  }
  await almacen.poner('tokens', idDe(usuarioId), {
    tipo: 'espectador',
    usuarioId: String(usuarioId),
    nombre: String(nombre ?? '').slice(0, 80),
    acceso: cifrado.cifrar(String(accessToken ?? '')),
    refresco: refreshToken ? cifrado.cifrar(String(refreshToken)) : '',
    venceEn: Number(venceEn ?? 0),
    scopes: Array.isArray(scopes) ? scopes.join(' ') : String(scopes ?? ''),
    entro: Date.now(),
  });
}

/** El vinculo con los tokens descifrados, o null. */
export async function leer(usuarioId) {
  if (!valido(usuarioId)) return null;
  const doc = await almacen.obtener('tokens', idDe(usuarioId));
  if (!doc || !cifrado.hayClave()) return null;
  try {
    return {
      usuarioId: doc.usuarioId ?? String(usuarioId),
      nombre: doc.nombre ?? '',
      accessToken: doc.acceso ? cifrado.descifrar(doc.acceso) : '',
      refreshToken: doc.refresco ? cifrado.descifrar(doc.refresco) : '',
      venceEn: Number(doc.venceEn ?? 0),
      scopes: doc.scopes ?? '',
    };
  } catch (e) {
    /* e.name y no e.message: la regla de la casa es no confiar en que
       el error de descifrado no traiga nada delicado. */
    console.warn(`[espectadores] no se pudo descifrar un vinculo (${e.name}): hay que volver a entrar`);
    return null;
  }
}

export async function olvidar(usuarioId) {
  if (!valido(usuarioId)) return false;
  limpiarLimite(usuarioId);
  return almacen.quitar('tokens', idDe(usuarioId));
}

/* ---------------------------------------------------------- acceso */

/* usuarioId -> promesa del refresh en curso. Dos mensajes seguidos de
   la misma persona con el token recien vencido saldrian a refrescar
   los dos: Kick rota el refresh token, asi que el segundo usaria uno
   que el primero ya quemo. */
const refrescando = new Map();

/**
 * Un access token usable de este espectador, refrescando si hace
 * falta. Devuelve null si no hay vinculo o si el refresh ya no sirve
 * (ahi la persona tiene que volver a entrar).
 */
export async function acceso(usuarioId) {
  const v = await leer(usuarioId);
  if (!v) return null;
  if (v.accessToken && Date.now() + MARGEN < v.venceEn) return v.accessToken;
  if (!v.refreshToken) return null;

  if (!refrescando.has(usuarioId)) {
    refrescando.set(usuarioId, refrescar(usuarioId, v).finally(() => refrescando.delete(usuarioId)));
  }
  return refrescando.get(usuarioId);
}

async function refrescar(usuarioId, viejo) {
  let nuevo;
  try {
    nuevo = await kick.refrescar(viejo.refreshToken);
  } catch (e) {
    /* Un refresh rechazado es la persona que revoco el permiso desde
       Kick, o un token que caduco del todo. Se borra: dejarlo seria
       reintentar contra Kick en cada mensaje que escriba. */
    console.warn('[espectadores] el refresh fallo, se olvida el vinculo:', e.status ?? e.name);
    await olvidar(usuarioId);
    return null;
  }
  await guardar({
    usuarioId,
    nombre: viejo.nombre,
    accessToken: nuevo.accessToken,
    refreshToken: nuevo.refreshToken,
    venceEn: nuevo.venceEn,
    scopes: nuevo.scopes,
  });
  return nuevo.accessToken;
}

/* ---------------------------------------------------------- limite */

const ultimoEnvio = new Map();    // usuarioId -> ms del ultimo mensaje

/* Tope del Map: una noche con mucha gente lo llena y nadie lo vacia.
   Se sueltan los mas viejos (Map conserva el orden de insercion). */
const TOPE_RECORDADOS = 5000;

/**
 * Cuantos ms le faltan a esta persona para poder mandar otro mensaje.
 * 0 si puede ahora.
 */
export function esperaQueLeFalta(usuarioId, ahora = Date.now()) {
  const ultimo = ultimoEnvio.get(String(usuarioId));
  if (!ultimo) return 0;
  return Math.max(0, ultimo + ESPERA_ENTRE_MENSAJES - ahora);
}

/** Anota que esta persona acaba de mandar. */
export function anotarEnvio(usuarioId, ahora = Date.now()) {
  const clave = String(usuarioId);
  ultimoEnvio.delete(clave);          // que vuelva al final del orden
  ultimoEnvio.set(clave, ahora);
  while (ultimoEnvio.size > TOPE_RECORDADOS) {
    ultimoEnvio.delete(ultimoEnvio.keys().next().value);
  }
}

export function limpiarLimite(usuarioId) {
  if (usuarioId === undefined) ultimoEnvio.clear();
  else ultimoEnvio.delete(String(usuarioId));
}

/* ------------------------------------------------- la espera del 429

   Kick no documenta su rate limit de envio. Cuando contesta 429, el
   429 es del CANAL, no de la persona: seguir mandando el resto de los
   mensajes de esa noche solo consigue mas 429. Se para todo el canal
   por lo que diga Retry-After (y unos segundos si no lo dice). */

const esperaDelCanal = new Map();   // slug -> ms epoch hasta cuando esperar

export const ESPERA_429_POR_DEFECTO = 5000;
const TOPE_ESPERA_429 = 60_000;

export function anotar429(slug, retryAfter, ahora = Date.now()) {
  const segundos = Number(retryAfter);
  const espera = Number.isFinite(segundos) && segundos > 0
    ? Math.min(segundos * 1000, TOPE_ESPERA_429)
    : ESPERA_429_POR_DEFECTO;
  esperaDelCanal.set(String(slug).toLowerCase(), ahora + espera);
  return espera;
}

/** Ms que le faltan al canal entero para poder volver a mandar. */
export function esperaDelCanalQueFalta(slug, ahora = Date.now()) {
  const hasta = esperaDelCanal.get(String(slug).toLowerCase());
  if (!hasta) return 0;
  if (hasta <= ahora) { esperaDelCanal.delete(String(slug).toLowerCase()); return 0; }
  return hasta - ahora;
}

/** Solo para los tests. */
export function reiniciar() {
  ultimoEnvio.clear();
  esperaDelCanal.clear();
  refrescando.clear();
}
