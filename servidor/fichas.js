/* ============================================================
   La ficha de quien escribe: lo que el creador ve al tocar un nombre
   en /chat.

   Dos partes, y de dos lugares distintos:

     lo que dijo      los mensajes de esa persona que estan en el buffer
                      de la sala (los ultimos 200 de todo el chat). Es lo
                      mismo que ya vio pasar: no se guarda nada nuevo.
     quien es         lo que la plataforma dice de la cuenta. Twitch da
                      la fecha de creacion, si sigue al canal y si es sub
                      (con permisos que el vinculo ya tiene por la
                      actividad). Kick, por su API publica, solo nombre y
                      foto.

   ---------------------------------------------------------------
   NUNCA TIRA, Y LO QUE FALTA DICE POR QUE

   Una ficha sin la parte de la plataforma (sin credenciales, Twitch
   caido, un vinculo sin el permiso) sigue sirviendo: los mensajes y los
   botones de moderar estan igual. Cada dato que no se pudo traer sale
   como null y `faltan` dice que no se pudo y por que, para que la
   pagina no muestre un "no sigue al canal" que en realidad es "no se
   pudo preguntar".

   ---------------------------------------------------------------
   CACHE CORTA

   Tocar el mismo nombre tres veces seguidas no puede ser nueve pedidos
   a Twitch. Lo de la cuenta cambia poco (10 minutos); lo de seguir y
   ser sub es por sala y cambia en vivo (1 minuto). Con tope, como todas
   las caches del proyecto.
   ============================================================ */

import * as canales from './canales.js';
import * as kick from './kick.js';
import * as twitch from './twitch.js';
import * as vinculos from './vinculos.js';

export const REDES = Object.freeze(['kick', 'twitch']);
export const TOPE_MENSAJES = 30;

const CUENTA_MS = 10 * 60_000;
const RELACION_MS = 60_000;
const TOPE_CACHE = 500;

const ID_USUARIO = /^\d{1,20}$/;

const cache = new Map();   // clave -> { vence, valor }

async function conCache(clave, ms, traer) {
  const hay = cache.get(clave);
  if (hay && hay.vence > Date.now()) return hay.valor;
  const valor = await traer();
  if (cache.size >= TOPE_CACHE) cache.delete(cache.keys().next().value);
  cache.set(clave, { vence: Date.now() + ms, valor });
  return valor;
}

/** Para los tests. */
export const olvidarCache = () => cache.clear();

/** Por que no se puede pedir esta ficha, o ''. */
export function porQueNo(red, id) {
  if (!REDES.includes(red)) return 'hace falta una red: kick o twitch';
  if (!ID_USUARIO.test(String(id ?? ''))) return 'hace falta el id de la persona en esa red';
  return '';
}

/* Lo que se le muestra al creador de un error, sin nada del pedido. */
const motivo = e => (e instanceof twitch.SinDatos || /credenciales|KICK_CLIENT/.test(String(e?.message))
  ? 'el servidor no tiene las credenciales de la app'
  : e?.status === 401 || e?.status === 403
    ? 'falta el permiso: volvé a vincular desde el panel'
    : 'la plataforma no contestó');

/** Los mensajes de esa persona en el buffer de la sala, del mas viejo al mas nuevo. */
export function mensajesDe(slug, red, id) {
  return canales.ultimos(slug)
    .filter(m => m?.tipo === 'chat' && m.red === red && String(m.usuarioId ?? '') === String(id))
    .slice(-TOPE_MENSAJES);
}

async function cuentaDeTwitch(slug, id, faltan) {
  const salida = { avatar: '', login: '', creada: '', sigueDesde: null, sub: null };
  try {
    const u = await conCache(`twitch:cuenta:${id}`, CUENTA_MS, () => twitch.usuarioPorId(id));
    if (u) Object.assign(salida, { avatar: u.avatar, login: u.login, nombre: u.nombre, creada: u.creada });
  } catch (e) {
    faltan.push({ dato: 'cuenta', motivo: motivo(e) });
  }

  let yo = null;
  try { yo = await vinculos.acceso(slug, 'twitch'); }
  catch (e) { faltan.push({ dato: 'relacion', motivo: 'el permiso con Twitch venció: volvé a vincularlo desde el panel' }); }
  if (!yo?.usuarioId) {
    if (!faltan.some(f => f.dato === 'relacion')) faltan.push({ dato: 'relacion', motivo: 'el canal no está vinculado con Twitch' });
    return salida;
  }
  const base = { accessToken: yo.accessToken, broadcasterId: yo.usuarioId, usuarioId: id };
  /* El dueño del canal no se sigue ni se suscribe a si mismo. */
  if (String(id) === String(yo.usuarioId)) return { ...salida, esElCanal: true };

  await Promise.all([
    conCache(`twitch:sigue:${slug}:${id}`, RELACION_MS, () => twitch.sigueDesde(base))
      .then(d => { salida.sigueDesde = d; })
      .catch(e => faltan.push({ dato: 'sigue', motivo: motivo(e) })),
    conCache(`twitch:sub:${slug}:${id}`, RELACION_MS, () => twitch.subAlCanal(base))
      .then(d => { salida.sub = d ?? false; })
      .catch(e => faltan.push({ dato: 'sub', motivo: motivo(e) })),
  ]);
  return salida;
}

async function cuentaDeKick(id, faltan) {
  const salida = { avatar: '' };
  try {
    const u = await conCache(`kick:cuenta:${id}`, CUENTA_MS, () => kick.usuarioPorId(id));
    if (u) Object.assign(salida, { avatar: u.avatar, nombre: u.nombre });
  } catch (e) {
    faltan.push({ dato: 'cuenta', motivo: motivo(e) });
  }
  return salida;
}

/**
 * La ficha entera. `slug` sale de la cookie del creador.
 *
 * @param {string} slug
 * @param {'kick'|'twitch'} red
 * @param {string} id      el id de la persona en esa red
 */
export async function ficha(slug, red, id) {
  const mensajes = mensajesDe(slug, red, id);
  const ultimo = mensajes.at(-1);
  const faltan = [];
  const cuenta = red === 'twitch' ? await cuentaDeTwitch(slug, id, faltan) : await cuentaDeKick(id, faltan);
  const nombre = String(ultimo?.usuario || cuenta.nombre || '');
  /* El link al perfil: el login en Twitch; en Kick el slug del canal es
     el nombre en minusculas (asi lo arma kick.com). */
  const login = red === 'twitch' ? cuenta.login : nombre.toLowerCase();
  return {
    red,
    id: String(id),
    nombre,
    color: String(ultimo?.color ?? ''),
    insignias: Array.isArray(ultimo?.insignias) ? ultimo.insignias : [],
    perfil: login ? (red === 'twitch' ? `https://www.twitch.tv/${encodeURIComponent(login)}` : `https://kick.com/${encodeURIComponent(login)}`) : '',
    avatar: cuenta.avatar ?? '',
    creada: cuenta.creada ?? '',
    sigueDesde: cuenta.sigueDesde ?? null,
    sub: cuenta.sub ?? null,
    esElCanal: Boolean(cuenta.esElCanal),
    mensajes: mensajes.map(m => ({
      id: String(m.id ?? ''),
      texto: String(m.texto ?? ''),
      emotes: Array.isArray(m.emotes) ? m.emotes : [],
      hora: String(m.hora ?? ''),
    })),
    faltan,
  };
}
