/* ============================================================
   Actividad de cada sala: canjes, subs y follows de las dos redes, y
   quienes son sus mods.

   Es lo que el creador y sus mods abren desde el chat con el boton
   "Actividad": lo ultimo que paso, aunque hayan estado mirando para
   otro lado. Lo lee GET /api/chat/:slug/actividad.

   ---------------------------------------------------------------
   QUIEN ES MOD: LA INSIGNIA, VISTA POR EL SERVIDOR

   Sala no tiene una lista de mods, y no hace falta inventarla: Kick y
   Twitch ya dicen quien es moderador en cada mensaje, con la insignia
   `moderator`. Esa insignia llega por el webhook firmado de Kick y por
   EventSub (o el IRC del plan B), no por algo que mande el navegador,
   asi que nadie se la puede poner a mano.

   Se recuerda por red + id de usuario, que es lo que despues se cruza
   con la cuenta con la que el espectador entro. Y se OLVIDA igual de
   solo: si alguien que era mod escribe sin la insignia, le sacaron el
   rol y deja de ver la lista en ese momento.

   La contra, asumida: un mod tiene que haber escrito al menos una vez
   con la insignia. Por eso se guarda en el almacen y no en memoria —un
   deploy no le borra el rol a nadie— y vence a los 30 dias sin verlo,
   para que alguien que dejo de ser mod sin volver a escribir no quede
   con acceso para siempre.

   ---------------------------------------------------------------
   POR QUE SE GUARDA, Y CADA CUANTO

   Un deploy en pleno directo no puede vaciar la lista: es justo cuando
   alguien la va a querer mirar. Las escrituras se agrupan cada unos
   segundos por sala; perder los ultimos si el proceso se cae es
   aceptable, es un registro y no algo que alguien pago.
   ============================================================ */

import * as almacen from './almacen.js';
import { numeroDeEntorno } from './entorno.js';

const COLECCION = 'actividad';
const TOPE = 150;
const MOD_VENCE = 30 * 24 * 60 * 60 * 1000;
/* Sale por variable solo para que las pruebas no esperen cinco segundos. */
const DEMORA_GUARDAR = numeroDeEntorno('ACTIVIDAD_DEMORA_MS', 5000, { minimo: 0 });

/* Las insignias que cuentan como "puede ver la lista". El streamer
   entra por su cookie de creador, pero si mira desde una cuenta de
   espectador con la insignia de su propio canal, tambien. */
const INSIGNIAS_DE_MOD = new Set(['moderator', 'broadcaster']);

const salas = new Map();   // slug -> { items, mods, cargado: Promise, timer }

function sala(slug) {
  const clave = String(slug).toLowerCase();
  if (!salas.has(clave)) {
    const s = { slug: clave, items: [], mods: {}, timer: null, cargado: null };
    s.cargado = almacen.obtener(COLECCION, clave)
      .then(doc => {
        /* Lo que ya haya llegado mientras se leia va primero: es mas nuevo. */
        s.items = [...s.items, ...(Array.isArray(doc?.items) ? doc.items : [])].slice(0, TOPE);
        s.mods = { ...(doc?.mods ?? {}), ...s.mods };
      })
      .catch(e => console.warn(`[actividad] ${clave}: no se pudo leer:`, e.name));
    salas.set(clave, s);
  }
  return salas.get(clave);
}

function programarGuardado(s) {
  if (s.timer) return;
  s.timer = setTimeout(() => {
    s.timer = null;
    almacen.poner(COLECCION, s.slug, { items: s.items, mods: s.mods })
      .catch(e => console.warn(`[actividad] ${s.slug}: no se pudo guardar:`, e.name));
  }, DEMORA_GUARDAR);
  s.timer.unref?.();
}

/**
 * Anota un evento ya traducido (`mensajes.actividadDe*`).
 * Guarda lo que muestra la lista y nada mas.
 */
export function anotar(slug, a) {
  if (!a || a.tipo !== 'actividad') return null;
  const s = sala(slug);
  const entrada = {
    red: a.red,
    clase: a.clase,
    usuario: a.usuario,
    regalo: a.regalo,
    mensaje: a.mensaje,
    cantidad: a.cantidad,
    meses: a.meses,
    costo: a.costo,
    hora: a.hora,
  };
  s.items.unshift(entrada);
  if (s.items.length > TOPE) s.items.length = TOPE;
  programarGuardado(s);
  return entrada;
}

/** Lo mas nuevo primero. `clases` vacio = todas. */
export async function ver(slug, { clases = [], n = 100 } = {}) {
  const s = sala(slug);
  await s.cargado;
  const lista = clases.length ? s.items.filter(x => clases.includes(x.clase)) : s.items;
  return lista.slice(0, Math.max(1, Math.min(TOPE, Number(n) || 100)));
}

/* ------------------------------------------------------------- mods */

const claveMod = (red, usuarioId) => `${red}:${usuarioId}`;

/**
 * Mira las insignias de un mensaje de chat YA TRADUCIDO y anota o
 * borra a quien escribio. Lo llama chat.js en los dos embudos, asi
 * que pasa por aca todo lo que entra, venga por webhook, EventSub o IRC.
 */
export function mirarInsignias(slug, mensaje) {
  const red = mensaje?.red;
  const id = String(mensaje?.usuarioId ?? '');
  if (!red || !id) return;
  const esMod = (mensaje.insignias ?? []).some(b => INSIGNIAS_DE_MOD.has(String(b?.tipo ?? '')));
  const s = sala(slug);
  const clave = claveMod(red, id);
  if (esMod) {
    /* Se toca el almacen como mucho una vez por hora por mod: un mod
       que habla mucho no puede convertirse en una escritura por mensaje. */
    const antes = s.mods[clave] ?? 0;
    s.mods[clave] = Date.now();
    if (Date.now() - antes > 60 * 60 * 1000) programarGuardado(s);
  } else if (s.mods[clave]) {
    delete s.mods[clave];
    programarGuardado(s);
  }
}

/**
 * Si alguna de estas cuentas es mod de la sala.
 * @param {Array<{red:string, usuarioId:string}>} cuentas
 */
export async function esMod(slug, cuentas) {
  const s = sala(slug);
  await s.cargado;
  const ahora = Date.now();
  return cuentas.some(({ red, usuarioId }) => {
    if (!red || !usuarioId) return false;
    const visto = s.mods[claveMod(red, String(usuarioId))];
    return Boolean(visto) && ahora - visto < MOD_VENCE;
  });
}

/** Solo para las pruebas: olvida todo lo que hay en memoria. */
export function reiniciar() {
  for (const s of salas.values()) clearTimeout(s.timer);
  salas.clear();
}
