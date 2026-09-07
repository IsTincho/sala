/* ============================================================
   Los vinculos de cada creador con cada red.

   Un vinculo es "el dueño de esta sala le dio permiso a Sala para
   hablar y escuchar en su nombre en esta red". Guarda quien es en esa
   red y los tokens para actuar por el.

   Se guardan en la coleccion `tokens`, un documento por sala y por
   red, con el id `kick:<slug>` / `twitch:<slug>`. Un documento por red
   y no uno solo con las dos adentro: vincular Twitch no tiene por que
   poder pisar el vinculo de Kick.

   ---------------------------------------------------------------
   EL SLUG VA PRIMERO Y NO TIENE VALOR POR DEFECTO

   Hasta la Fase 2 esto guardaba UN vinculo, el del dueño, con el id
   literal `kick:dueno`, y la firma era `leer('kick')`. Al pasar a
   varios creadores lo comodo habria sido agregar el slug al final con
   el del dueño como default. No se hizo, a proposito, y es la decision
   mas importante de este archivo.

   El bug que la Fase 2 dejo anotado para esta fase era exactamente
   ese: `apiSalaChat` llamaba a `identidad('kick')` y le mandaba el
   mensaje del espectador al canal del DUEÑO, estuviera en la sala que
   estuviera. Con un default, cualquier call site nuevo que se olvide
   del slug repite el bug y anda "bien" hasta el dia que haya dos
   creadores hablando a la vez. Sin default, olvidarse tira.

   Va primero porque es la dimension que manda: se lee "el vinculo de
   ESTA sala con Kick", y quien escribe la llamada tiene que pensar de
   que sala esta hablando antes que en ninguna otra cosa.

   ---------------------------------------------------------------
   LOS TOKENS VAN CIFRADOS, SIEMPRE

   El refresh token de Kick de un creador es permiso permanente para
   escribir en su chat con su nombre. Un volcado de Mongo que los
   traiga en claro es alguien hablando como el en su propio canal. Van
   cifrados con AES-256-GCM y una clave que solo vive en las variables
   de Railway (servidor/cifrado.js). Sin CLAVE_CIFRADO no se guarda
   NADA: es preferible que el vinculo no se pueda hacer a que quede un
   token en claro esperando.

   El access token tambien se cifra, aunque dure una hora. Cuesta lo
   mismo y evita la conversacion de "este cual era".

   ---------------------------------------------------------------
   LA CARRERA DEL REFRESH DE TWITCH

   Twitch entrega un refresh token NUEVO cada vez que se usa uno, y
   el viejo deja de servir. Si dos pedidos refrescan a la vez, los dos
   parten del mismo refresh token: el segundo en llegar a Twitch se
   come un error y, peor, el que guarde ultimo puede dejar escrito un
   token que ya no vale. Por eso el refresh se serializa POR SALA Y
   POR RED: el segundo que llega se cuelga de la promesa del primero.
   La clave del Map es `${red}:${slug}` y no solo la red, que con
   varios creadores haria que el refresh de uno bloqueara al de otro y,
   peor, le devolviera su token.
   ============================================================ */

import * as almacen from './almacen.js';
import * as cifrado from './cifrado.js';
import * as kick from './kick.js';
import * as twitch from './twitch.js';

export const REDES = ['kick', 'twitch'];

/* El mismo slug que aceptan `creadores.js` y `videos.js`. Se valida
   aca tambien porque de este id depende que documento se lee: un slug
   raro que se colara escribiria en la fila de otro. */
const SLUG_VALIDO = /^[a-z0-9][a-z0-9_-]{0,49}$/;

const idDe = (slug, red) => `${red}:${slug}`;

/* Cuanto antes de que venza se considera que un access token ya no
   sirve. Un token que vence en el medio de un pedido da un 401 que
   despues cuesta entender. */
const MARGEN = 60_000;

function validar(slug, red) {
  if (!REDES.includes(red)) throw new Error(`red desconocida: ${red}`);
  const s = String(slug ?? '').toLowerCase();
  if (!SLUG_VALIDO.test(s)) throw new Error(`slug invalido: ${JSON.stringify(String(slug ?? ''))}`);
  return s;
}

/* --------------------------------------------------------- guardar */

/**
 * Guarda (o reemplaza) el vinculo de una sala con una red.
 *
 * @param {string} slug            la sala
 * @param {'kick'|'twitch'} red
 * @param {object} datos  usuarioId, nombre, login, slug (el de la red),
 *                        accessToken, refreshToken, venceEn, scopes
 */
export async function guardar(slug, red, datos) {
  const s = validar(slug, red);
  if (!cifrado.hayClave()) {
    throw new Error(`no se puede guardar el vinculo sin CLAVE_CIFRADO (${cifrado.porQueNoHayClave()})`);
  }

  await almacen.poner('tokens', idDe(s, red), {
    red,
    sala: s,
    usuarioId: String(datos.usuarioId ?? ''),
    nombre: String(datos.nombre ?? ''),
    login: String(datos.login ?? ''),
    slug: String(datos.slug ?? ''),
    acceso: cifrado.cifrar(String(datos.accessToken ?? '')),
    refresco: datos.refreshToken ? cifrado.cifrar(String(datos.refreshToken)) : '',
    venceEn: Number(datos.venceEn ?? 0),
    /* Los scopes se guardan para poder decir en el panel POR QUE algo
       no anda ("el vinculo es viejo y no tiene chat:write") en vez de
       mostrar un 401 pelado. */
    scopes: Array.isArray(datos.scopes) ? datos.scopes.join(' ') : String(datos.scopes ?? ''),
    vinculado: Date.now(),
  });
}

/**
 * El vinculo con los tokens ya descifrados, o null si no hay.
 *
 * Si el descifrado falla (cambio la CLAVE_CIFRADO, o alguien toco la
 * base) se devuelve null y se avisa: un vinculo que no se puede leer
 * es un vinculo que no existe, y hay que volver a entrar. No se
 * borra solo, para que quede el rastro de que hubo uno.
 */
export async function leer(slug, red) {
  const s = validar(slug, red);
  const doc = await almacen.obtener('tokens', idDe(s, red));
  if (!doc) return null;
  if (!cifrado.hayClave()) return null;

  try {
    return {
      red,
      sala: s,
      usuarioId: doc.usuarioId ?? '',
      nombre: doc.nombre ?? '',
      login: doc.login ?? '',
      slug: doc.slug ?? '',
      accessToken: doc.acceso ? cifrado.descifrar(doc.acceso) : '',
      refreshToken: doc.refresco ? cifrado.descifrar(doc.refresco) : '',
      venceEn: Number(doc.venceEn ?? 0),
      scopes: doc.scopes ?? '',
      vinculado: doc.vinculado ?? 0,
    };
  } catch (e) {
    /* e.name y no e.message: los errores de descifrado no traen el
       secreto, pero la regla de la casa es no confiar en eso. */
    console.warn(`[vinculos] no se pudo descifrar el vinculo de ${red} de ${s} (${e.name}): hay que volver a vincular`);
    return null;
  }
}

export async function olvidar(slug, red) {
  const s = validar(slug, red);
  return almacen.quitar('tokens', idDe(s, red));
}

/**
 * Quien es esta sala en esta red, SIN tokens y sin refrescar nada.
 *
 * Existe para el camino del espectador: para mandarle un mensaje al
 * chat de un canal hace falta su `broadcaster_user_id` y nada mas. Con
 * `acceso(slug, 'kick')` se conseguiria igual, pero refrescaria el
 * token del creador (un pedido a Kick) en cada mensaje que escriba
 * cualquiera, y ademas devolveria un access token a un camino que no
 * tiene por que verlo. El refresh token no sale de este modulo nunca.
 */
export async function identidad(slug, red) {
  const s = validar(slug, red);
  const doc = await almacen.obtener('tokens', idDe(s, red));
  if (!doc) return null;
  return {
    red,
    sala: s,
    usuarioId: doc.usuarioId ?? '',
    nombre: doc.nombre ?? '',
    login: doc.login ?? '',
    slug: doc.slug ?? '',
  };
}

export const hayVinculo = async (slug, red) => Boolean(await leer(slug, red));

/**
 * Las salas que tienen vinculo con una red.
 *
 * Lo usa el arranque: hay que levantar la conexion EventSub de cada
 * creador que haya vinculado Twitch, y comprobar la suscripcion de
 * Kick de cada uno. Devuelve solo los slugs, sin tocar los tokens.
 */
export async function salasCon(red) {
  if (!REDES.includes(red)) throw new Error(`red desconocida: ${red}`);
  const docs = await almacen.listar('tokens', { red });
  return docs
    .map(d => String(d.sala ?? '').toLowerCase())
    .filter(s => SLUG_VALIDO.test(s));
}

/* ---------------------------------------------------------- acceso */

/* `${red}:${slug}` -> promesa del refresh en curso. Ver el bloque de
   arriba sobre la rotacion del refresh token de Twitch. */
const refrescando = new Map();

/**
 * Un access token usable para esta sala y esta red, refrescando si
 * hace falta.
 *
 * Devuelve null si no hay vinculo. Tira si hay vinculo pero el
 * refresh fallo: eso es algo que el creador tiene que ver, no algo que
 * se pueda ignorar en silencio.
 *
 * @returns {Promise<{accessToken:string, usuarioId:string, slug:string, login:string}|null>}
 */
export async function acceso(slug, red) {
  const s = validar(slug, red);
  const v = await leer(s, red);
  if (!v) return null;

  if (v.accessToken && Date.now() + MARGEN < v.venceEn) return quedarse(v);

  if (!v.refreshToken) {
    throw new Error(`el vinculo de ${red} de ${s} vencio y no hay refresh token: hay que volver a vincular`);
  }

  const clave = idDe(s, red);
  if (!refrescando.has(clave)) {
    refrescando.set(clave, refrescar(s, red, v).finally(() => refrescando.delete(clave)));
  }
  return refrescando.get(clave);
}

async function refrescar(slug, red, viejo) {
  const nuevo = red === 'kick'
    ? await kick.refrescar(viejo.refreshToken)
    : await twitch.refrescar(viejo.refreshToken);

  await guardar(slug, red, {
    ...viejo,
    accessToken: nuevo.accessToken,
    /* Twitch rota el refresh token; Kick a veces no manda uno nuevo y
       su cliente ya devuelve el viejo en ese caso. Se guarda siempre
       lo que vuelve, nunca lo que habia. */
    refreshToken: nuevo.refreshToken,
    venceEn: nuevo.venceEn,
    scopes: nuevo.scopes,
  });

  return quedarse({ ...viejo, accessToken: nuevo.accessToken });
}

/* Lo unico que sale de este modulo hacia afuera: el access token y
   quien es. El refresh token NO se entrega a nadie. */
const quedarse = v => ({
  accessToken: v.accessToken,
  usuarioId: v.usuarioId,
  sala: v.sala,
  slug: v.slug,
  login: v.login,
  nombre: v.nombre,
});

/* --------------------------------------------------------- resumen

   Lo que se puede mostrar en una pantalla. Sin tokens ni pedazos de
   tokens: esta pagina se mira con la pantalla al aire. */

export async function resumen(slug) {
  const salida = {};
  for (const red of REDES) {
    const s = validar(slug, red);
    const doc = await almacen.obtener('tokens', idDe(s, red));
    salida[red] = doc
      ? {
          vinculado: true,
          usuario: doc.nombre || doc.login || '',
          slug: doc.slug ?? '',
          desde: doc.vinculado ?? 0,
          /* Si no hay clave, el vinculo esta pero es ilegible. Decirlo
             es la diferencia entre "volve a entrar" y media hora
             mirando logs. */
          legible: cifrado.hayClave(),
        }
      : { vinculado: false, usuario: '', slug: '', desde: 0, legible: cifrado.hayClave() };
  }
  return salida;
}
