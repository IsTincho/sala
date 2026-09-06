/* ============================================================
   Los vinculos del dueño con cada red.

   Un vinculo es "el dueño le dio permiso a Sala para hablar y
   escuchar en su nombre en esta red". Guarda quien es en esa red y
   los tokens para actuar por el.

   Se guardan en la coleccion `tokens`, un documento por red, con el
   id `kick:dueno` / `twitch:dueno`. Un documento por red y no uno
   solo con las dos adentro: vincular Twitch no tiene por que poder
   pisar el vinculo de Kick.

   ---------------------------------------------------------------
   LOS TOKENS VAN CIFRADOS, SIEMPRE

   El refresh token de Kick del dueño es permiso permanente para
   escribir en su chat con su nombre. Un volcado de Mongo que los
   traiga en claro es alguien hablando como el dueño en su propio
   canal. Van cifrados con AES-256-GCM y una clave que solo vive en
   las variables de Railway (servidor/cifrado.js). Sin CLAVE_CIFRADO
   no se guarda NADA: es preferible que el vinculo no se pueda hacer
   a que quede un token en claro esperando.

   El access token tambien se cifra, aunque dure una hora. Cuesta lo
   mismo y evita la conversacion de "este cual era".

   ---------------------------------------------------------------
   LA CARRERA DEL REFRESH DE TWITCH

   Twitch entrega un refresh token NUEVO cada vez que se usa uno, y
   el viejo deja de servir. Si dos pedidos refrescan a la vez, los dos
   parten del mismo refresh token: el segundo en llegar a Twitch se
   come un error y, peor, el que guarde ultimo puede dejar escrito un
   token que ya no vale. Por eso el refresh se serializa por red: el
   segundo que llega se cuelga de la promesa del primero.
   ============================================================ */

import * as almacen from './almacen.js';
import * as cifrado from './cifrado.js';
import * as kick from './kick.js';
import * as twitch from './twitch.js';

export const REDES = ['kick', 'twitch'];

const idDe = red => `${red}:dueno`;

/* Cuanto antes de que venza se considera que un access token ya no
   sirve. Un token que vence en el medio de un pedido da un 401 que
   despues cuesta entender. */
const MARGEN = 60_000;

function validarRed(red) {
  if (!REDES.includes(red)) throw new Error(`red desconocida: ${red}`);
  return red;
}

/* --------------------------------------------------------- guardar */

/**
 * Guarda (o reemplaza) el vinculo del dueño con una red.
 *
 * @param {'kick'|'twitch'} red
 * @param {object} datos  usuarioId, nombre, login, slug, accessToken,
 *                        refreshToken, venceEn, scopes
 */
export async function guardar(red, datos) {
  validarRed(red);
  if (!cifrado.hayClave()) {
    throw new Error(`no se puede guardar el vinculo sin CLAVE_CIFRADO (${cifrado.porQueNoHayClave()})`);
  }

  await almacen.poner('tokens', idDe(red), {
    red,
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
export async function leer(red) {
  validarRed(red);
  const doc = await almacen.obtener('tokens', idDe(red));
  if (!doc) return null;
  if (!cifrado.hayClave()) return null;

  try {
    return {
      red,
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
    console.warn(`[vinculos] no se pudo descifrar el vinculo de ${red} (${e.name}): hay que volver a vincular`);
    return null;
  }
}

export async function olvidar(red) {
  validarRed(red);
  return almacen.quitar('tokens', idDe(red));
}

export const hayVinculo = async red => Boolean(await leer(red));

/* ---------------------------------------------------------- acceso */

/* red -> promesa del refresh en curso. Ver el bloque de arriba sobre
   la rotacion del refresh token de Twitch. */
const refrescando = new Map();

/**
 * Un access token usable para esta red, refrescando si hace falta.
 *
 * Devuelve null si no hay vinculo. Tira si hay vinculo pero el
 * refresh fallo: eso es algo que el dueño tiene que ver, no algo que
 * se pueda ignorar en silencio.
 *
 * @returns {Promise<{accessToken:string, usuarioId:string, slug:string, login:string}|null>}
 */
export async function acceso(red) {
  validarRed(red);
  const v = await leer(red);
  if (!v) return null;

  if (v.accessToken && Date.now() + MARGEN < v.venceEn) return quedarse(v);

  if (!v.refreshToken) {
    throw new Error(`el vinculo de ${red} vencio y no hay refresh token: hay que volver a vincular`);
  }

  if (!refrescando.has(red)) {
    refrescando.set(red, refrescar(red, v).finally(() => refrescando.delete(red)));
  }
  return refrescando.get(red);
}

async function refrescar(red, viejo) {
  const nuevo = red === 'kick'
    ? await kick.refrescar(viejo.refreshToken)
    : await twitch.refrescar(viejo.refreshToken);

  await guardar(red, {
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
  slug: v.slug,
  login: v.login,
  nombre: v.nombre,
});

/* --------------------------------------------------------- resumen

   Lo que se puede mostrar en una pantalla. Sin tokens ni pedazos de
   tokens: esta pagina se mira con la pantalla al aire. */

export async function resumen() {
  const salida = {};
  for (const red of REDES) {
    const doc = await almacen.obtener('tokens', idDe(red));
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
