/* ============================================================
   La IMAGEN de cada insignia del chat. Hoy: solo Twitch.

   El formato unico ya traia el nombre de la insignia ("Broadcaster",
   "Moderator", "Verified channel") y la pagina lo dibujaba como una
   etiqueta de texto. Eso no es lo que la gente ve en twitch.tv. Aca se
   resuelve la imagen que corresponde a cada una y entra por el mismo
   array `insignias` del formato unico: la pagina pinta la imagen si
   hay `url` y la etiqueta de siempre si no.

   ---------------------------------------------------------------
   TWITCH SI, KICK NO, Y LA DE KICK ES UNA DECISION DEL DUEÑO

   TWITCH SIRVE LAS IMAGENES. `helix/chat/badges` (del canal) y
   `helix/chat/badges/global` devuelven, por cada `set_id`, una lista
   de `versions` con `id` e `image_url_1x/2x/4x`. El mensaje trae
   `{ set_id, id, info }` y el `id` matchea con `versions[].id`, asi
   que el casamiento es exacto. Piden app token o token de usuario y
   NINGUN scope (dev.twitch.tv/docs/api/reference): el dueño no tiene
   que autorizar nada nuevo. El pedido vive en `twitch.js`, que es
   donde estan las credenciales.

   KICK NO LAS SIRVE. El indice completo de `docs.kick.com/llms.txt`
   (26 paginas, revisado el 2026-09-23) no tiene una sola pagina de
   insignias, emotes ni assets, y la Channels API no devuelve ningun
   campo de badge. Lo unico que existe es `kick.com/api/v2/*`, que es
   exactamente lo que los terminos de dev.kick.com prohiben ("you will
   not access undocumented Program Materials ... without Kick's prior
   written permission", citado en INVESTIGACION-EMOTES.md).

   Se probo el plan B —dibujos propios, como los que tiene el repo
   hermano para su overlay— y EL DUEÑO LO RECHAZO (2026-09-23): no
   quiere iconos inventados en su chat. Asi que las insignias de Kick
   se quedan como estan, con su etiqueta de texto, hasta que haya una
   fuente oficial o hasta que alguien diseñe un set aparte y el dueño
   lo apruebe.

   POR ESO ACA NO HAY NINGUNA RAMA PARA KICK. No es un olvido ni un
   "todavia no": las insignias de Kick salen con `url: ''`, que es lo
   que la pagina lee como "mostrame el texto", y `chat.js` ni siquiera
   llama a `resolver()` en el embudo de Kick — seria una linea muerta
   que ninguna prueba puede vigilar.

   EL DIA QUE KICK PUBLIQUE UN ENDPOINT hay que hacer DOS cosas, y con
   una sola las insignias se ven por una red y no por la otra:

     1. agregar la rama de Kick en `conImagenes()`, aca abajo, y
     2. volver a poner `insignias.resolver(mensaje, c.slug)` en
        `recibirDeKick`, en chat.js, donde quedo el comentario.

   El resto —la cache, los tres vencimientos, el respaldo a texto— ya
   esta y no distingue redes.

   ---------------------------------------------------------------
   POR QUE ESTO ES OTRO MODULO Y NO UN PEDAZO DE emotes.js

   Porque no comparten ni la fuente, ni el casamiento, ni los
   vencimientos: un emote se busca por nombre y una insignia por
   (set, version), y un set de emotes se toca todas las semanas
   mientras que uno de insignias no se toca casi nunca.
   Lo que si comparten es la DISCIPLINA, y esa se copio entera:
   casillero por clave, tres vencimientos distintos, una sola bajada en
   vuelo por casillero, tope global de concurrencia, plazo sobre la
   bajada COMPLETA y no solo sobre el fetch, log cuando cambia el
   estado y no por mensaje.

   ---------------------------------------------------------------
   EL QUE PREGUNTA NUNCA ESPERA

   `resolver()` es sincrona, igual que la de los emotes y por el mismo
   motivo: un mensaje de chat sale al toque. Si la tabla todavia no
   esta, ese mensaje sale con las etiquetas de texto de siempre y la
   bajada queda agendada para el proximo.

   Cuantos salen asi: los que lleguen mientras se baja, y solo la
   primera vez por creador y por arranque. Menos que con los emotes,
   ademas, porque aca la bajada se agenda recien cuando llega un
   mensaje de Twitch CON insignias, que es una fraccion de los
   mensajes.

   ---------------------------------------------------------------
   TRES VENCIMIENTOS, Y POR QUE NO SON LOS DE LOS EMOTES

   Un set de insignias de canal cambia cuando el streamer sube una
   nueva, que pasa una vez cada mucho: no es un set de emotes, que se
   toca todas las semanas. Por eso el exito dura SEIS HORAS y no diez
   minutos. Con 900 creadores eso son unos 3.600 pedidos por dia
   contra Helix en vez de 130.000.

   "Este canal no tiene insignias propias" (Helix contesta 200 con
   `data` vacio, o 400/404, o el creador no tiene Twitch vinculado)
   vence a la HORA: es el caso de la mayoria y es estable, pero el dia
   que alguien se hace afiliado y sube su primera insignia lo nota, y
   una hora es el mismo trato que `emotes.js` le da al 404 de 7TV.

   Un fallo de verdad (timeout, 500, 401) vence al MINUTO y NO pisa la
   tabla que habia: una insignia vieja es mejor que ninguna.

   ---------------------------------------------------------------
   EL PESO NO NECESITA PRESUPUESTO, Y ESO SE MIDIO

   Con los emotes de 7TV hizo falta un tope en bytes porque la cola es
   carisima (un emote animado de 1,1 MB). Aca no: medido el 2026-09-23
   contra `static-cdn.jtvnw.net`, las insignias globales pesan entre
   320 B y 1.250 B, y Twitch fija las tres medidas (18, 36 y 72 px,
   comprobado leyendo el IHDR del PNG) y no acepta animadas. No hay
   cola que cortar, asi que no hay ningun knob de presupuesto.

   Se pide `image_url_2x` (36 px) porque el CSS muestra la insignia a
   1,1em, o sea unos 18 px: 2x cubre pantallas de hasta 2x de
   densidad. 4x serian 72 px para pintar 18.
   ============================================================ */

import { numeroDeEntorno } from './entorno.js';
import * as twitch from './twitch.js';
import * as vinculos from './vinculos.js';

/* Se puede apagar sin tocar codigo, igual que `EMOTES_7TV`: si Helix
   empieza a contestar cualquier cosa, el chat tiene que poder seguir
   con las etiquetas de texto de siempre. Apagarlo deja el chat
   exactamente como estaba antes de este modulo. */
export const ACTIVO_TWITCH = process.env.INSIGNIAS_TWITCH !== '0';

export const CADUCA = 6 * 60 * 60 * 1000;
export const SIN_PROPIAS = 60 * 60 * 1000;
export const REINTENTO = 60 * 1000;

/* Cuantas bajadas pueden estar en vuelo a la vez en todo el proceso.
   Lo que no entra no se encola: el proximo mensaje lo reintenta. */
export const EN_VUELO_MAX = 6;

/* Cuanto puede durar una bajada ENTERA. No alcanza con el timeout del
   fetch: la bajada arranca pidiendole el id al almacen, y el cliente
   de Mongo se crea sin `socketTimeoutMS`, asi que un socket medio
   abierto no vence nunca. Seis promesas colgadas se quedan con los
   seis lugares y las insignias quedan apagadas para todos, para
   siempre y sin una linea de log. Es la misma trampa que casi se lleva
   puesto a `emotes.js`; el comentario largo esta alla. */
/* Se lee con `numeroDeEntorno` y no con `Number()`: con un valor que
   no es un numero —`INSIGNIAS_PLAZO_MS=20s`, que es el typo natural—
   `Number()` da NaN, `Math.max(1000, NaN)` da NaN, y
   `setTimeout(fn, NaN)` dispara a UN milisegundo. O sea que un typo no
   deja el plazo largo: apaga las insignias para siempre, y el log dice
   "tardo mas de NaN ms". El razonamiento entero esta en `entorno.js`,
   que es de donde salen ahora TODOS los numeros del servidor. */
const PLAZO = numeroDeEntorno('INSIGNIAS_PLAZO_MS', 20000, { minimo: 1000 });

/* Cada cuanto, como mucho, se avisa que el tope esta lleno o que algo
   falla. Sin esto seria una linea por mensaje. */
const AVISO = 60 * 1000;

/* La URL de una insignia termina en el `src` de un <img> en la
   pantalla de cada espectador y la arma un tercero. Mismo estandar que
   `emotes.js`: https, anclada al dominio de Twitch y con tope de
   largo. Verificado alla que sin esto pasan `javascript:` y `data:`. */
const TOPE_URL = 300;

function urlSegura(candidata) {
  let u;
  try { u = new URL(String(candidata ?? '')); } catch { return ''; }
  if (u.protocol !== 'https:') return '';
  /* Al dominio y no al host exacto, para que un subdominio nuevo de
     ellos no apague las insignias. */
  if (u.hostname !== 'jtvnw.net' && !u.hostname.endsWith('.jtvnw.net')) return '';
  return u.href.length <= TOPE_URL ? u.href : '';
}

/* ------------------------------------------------------------ cache

   clave -> { tabla, vence, bajando, avisado }

   `tabla` es Map<set_id, Map<version, url>>. Dos niveles y no una
   clave `set_id/version` pegada porque asi el respaldo a los globales
   se pregunta set por set, que es como funciona de verdad: un canal
   que personaliza `subscriber` sigue usando el `moderator` global. */

const cache = new Map();

/* Un slug validado nunca tiene `/`, asi que la clave de los globales
   no puede chocar con la de ningun creador. */
const CLAVE_GLOBALES = '/globales';
const clave = slug => `${String(slug ?? '').toLowerCase()}/twitch`;

function casillero(k) {
  let c = cache.get(k);
  if (!c) {
    c = { tabla: new Map(), vence: 0, bajando: null, avisado: '' };
    cache.set(k, c);
  }
  return c;
}

let enVuelo = 0;

/** Borra todo lo cacheado. Para las pruebas y para un apagon de Helix. */
export function olvidarTodo() {
  cache.clear();
  enVuelo = 0;
}

/**
 * Marca la tabla de un creador como vencida: la proxima consulta la
 * vuelve a bajar sin esperar las seis horas.
 *
 * No se usa todavia en produccion. Es el gancho que necesitaria un
 * boton de "recargar mis insignias" en el panel, o el dia que se
 * escuche el evento de Twitch que avisa que el canal cambio las suyas.
 */
export function vencer(slug) {
  const c = cache.get(clave(slug));
  if (c) c.vence = 0;
}

/**
 * Lo que sabe el modulo de un casillero, para mirarlo desde afuera.
 * Sin slug, el de los globales. `null` si nunca se consulto.
 *
 * Existe para poder comprobar COMO quedo la cache y no solo que
 * devuelve: la diferencia entre "este canal no tiene insignias
 * propias" (vence a la hora) y "fallo, reintentar" (al minuto) no se
 * puede ver de ninguna otra forma desde afuera.
 */
export function comoEsta(slug) {
  const c = cache.get(slug === undefined ? CLAVE_GLOBALES : clave(slug));
  return c ? { sets: c.tabla.size, vence: c.vence, estado: c.avisado } : null;
}

/**
 * Espera a que no quede ninguna bajada en vuelo. Solo para las
 * pruebas: el camino de produccion nunca espera una bajada.
 */
export async function reposo() {
  for (let vuelta = 0; vuelta < 50; vuelta++) {
    const enCurso = [...cache.values()].map(c => c.bajando).filter(Boolean);
    if (!enCurso.length) return;
    await Promise.allSettled(enCurso);
  }
}

/* -------------------------------------------------------- identidad

   Quien es este creador en Twitch. Se puede reemplazar en las pruebas,
   igual que en `emotes.js`. */

let identidad = (slug, red) => vinculos.identidad(slug, red);

/** Cambia de donde sale el id de cada creador. Solo para las pruebas. */
export function fijarIdentidad(fn) {
  if (typeof fn !== 'function') throw new Error('fijarIdentidad quiere una funcion');
  identidad = fn;
}

/* ----------------------------------------------------------- bajada */

/** Lo que devuelve Helix, pasado a Map<set_id, Map<version, url>>. */
function tablaDeSets(sets) {
  const t = new Map();
  for (const s of sets ?? []) {
    const setId = String(s?.set_id ?? '');
    if (!setId) continue;
    const versiones = new Map();
    for (const v of s?.versions ?? []) {
      const id = String(v?.id ?? '');
      /* 2x y no 4x: el CSS la muestra a 18 px. Ver el bloque del peso. */
      const url = urlSegura(v?.image_url_2x);
      if (id && url) versiones.set(id, url);
    }
    if (versiones.size) t.set(setId, versiones);
  }
  return t;
}

async function bajarDelCanal(slug) {
  const quien = await identidad(slug, 'twitch');
  const id = String(quien?.usuarioId ?? '');
  /* Sin vinculo con Twitch no hay a quien preguntarle, y eso NO es un
     fallo: cuenta como "no tiene insignias propias" y no se vuelve a
     intentar por una hora. Un creador que nunca vinculo Twitch no
     puede generar un pedido por mensaje. */
  if (!id) throw new twitch.SinDatos('el creador no tiene Twitch vinculado');
  return tablaDeSets(await twitch.insigniasDelCanal(id));
}

async function bajarGlobales() {
  return tablaDeSets(await twitch.insigniasGlobales());
}

/**
 * La promesa, pero con fecha de vencimiento. Ver el comentario de
 * `PLAZO`: hay eslabones de la bajada que no tienen timeout propio.
 */
function conPlazo(promesa, ms) {
  let reloj;
  const vencimiento = new Promise((_, mal) => {
    reloj = setTimeout(() => mal(new Error(`tardo mas de ${ms} ms`)), ms);
    /* Sin unref, un plazo pendiente no deja cerrar el proceso. */
    reloj.unref?.();
  });
  return Promise.race([promesa, vencimiento]).finally(() => clearTimeout(reloj));
}

let ultimoAvisoTope = 0;

function avisar(c, nuevo, texto) {
  if (c.avisado === nuevo) return;
  c.avisado = nuevo;
  if (texto) console.log(texto);
}

/**
 * Agenda la bajada si hace falta. NO devuelve nada y NO se espera:
 * quien pregunta se lleva la tabla que haya ahora.
 */
function agendar(k, como, etiqueta) {
  const c = casillero(k);
  if (Date.now() < c.vence) return;
  /* La misma promesa para todos: dos mensajes en el mismo tick no son
     dos pedidos. */
  if (c.bajando) return;
  if (enVuelo >= EN_VUELO_MAX) {
    const ahora = Date.now();
    if (ahora - ultimoAvisoTope > AVISO) {
      ultimoAvisoTope = ahora;
      console.warn(`[insignias] ${enVuelo} bajadas en vuelo y no entran mas; ${etiqueta} espera al proximo mensaje`);
    }
    return;
  }

  enVuelo++;
  /* `Promise.resolve().then(como)` y no `como()`: asi una excepcion
     sincrona tambien cae en el catch y el contador no se fuga.
     `conPlazo` es lo que garantiza que el `.finally` SIEMPRE corra. */
  c.bajando = conPlazo(Promise.resolve().then(como), PLAZO)
    .then(t => {
      c.tabla = t;
      /* Una respuesta buena pero vacia es "este canal no tiene
         insignias propias", que es el caso de la mayoria: vence como
         tal y no como un exito, o se estaria preguntando cada seis
         horas por algo que no va a aparecer solo. */
      const vacia = t.size === 0;
      c.vence = Date.now() + (vacia ? SIN_PROPIAS : CADUCA);
      avisar(c, vacia ? 'sin-propias' : `ok:${t.size}`,
        vacia
          ? `[insignias] ${etiqueta}: sin insignias propias`
          : `[insignias] ${etiqueta}: ${t.size} juego${t.size === 1 ? '' : 's'}`);
    })
    .catch(e => {
      if (e instanceof twitch.SinDatos) {
        /* El creador no tiene Twitch vinculado, o Helix dijo que ese id
           no es un canal. Se deja la tabla vacia y se calla. */
        c.tabla = new Map();
        c.vence = Date.now() + SIN_PROPIAS;
        avisar(c, 'sin-propias', `[insignias] ${etiqueta}: sin insignias propias`);
        return;
      }
      /* NO se pisa `c.tabla`: si habia una que funcionaba, se sigue
         sirviendo aunque este vencida. */
      c.vence = Date.now() + REINTENTO;
      avisar(c, 'fallo', `[insignias] ${etiqueta}: no se pudo actualizar (${e.message})`);
    })
    .finally(() => {
      c.bajando = null;
      /* Con piso en cero: si alguien llama a `olvidarTodo()` con una
         bajada en vuelo, el contador no puede quedar en negativo y
         dejar el tope abierto para siempre. */
      enVuelo = Math.max(0, enVuelo - 1);
    });
}

/**
 * Las insignias propias de un canal. Sincrona: devuelve lo que hay
 * AHORA y deja agendada la bajada.
 *
 * @returns {Map<string, Map<string,string>>}
 */
export function tabla(slug) {
  if (!ACTIVO_TWITCH || !slug) return new Map();
  const k = clave(slug);
  agendar(k, () => bajarDelCanal(slug), `${slug}/twitch`);
  return casillero(k).tabla;
}

/** Las insignias globales de Twitch, compartidas por todos los canales. */
export function globales() {
  if (!ACTIVO_TWITCH) return new Map();
  agendar(CLAVE_GLOBALES, bajarGlobales, 'globales');
  return casillero(CLAVE_GLOBALES).tabla;
}

/* ---------------------------------------------- lo que sabe la tabla

   LOS SETS QUE UN CANAL PUEDE TENER PROPIOS.

   `helix/chat/badges` devuelve exactamente estos dos: la doc dice que
   son "the broadcaster's list of custom chat badges" y manda a leer
   "subscriber badges and Bits badges". O sea que son los unicos sets en
   los que la tabla del canal puede cambiar la respuesta; para
   `moderator`, `vip`, `premium`, `partner` y los demas, la global ES la
   verdad en todos los canales.

   NO ES UNA LISTA QUE TENGA QUE ESTAR COMPLETA PARA SER CORRECTA, y eso
   es lo que la hace segura: si Twitch agrega una tercera familia
   personalizable, esa familia se comporta como se comportaba TODO antes
   de esta lista (cae a la global mientras no sepamos), o sea que
   equivocarse aca no empeora nada respecto de no tener la lista. */
const PERSONALIZABLES = new Set(['subscriber', 'bits']);

/**
 * Si YA SABEMOS que sets propios tiene este canal.
 *
 * La diferencia entre "este canal no personalizo nada" y "todavia no se
 * bajo" no se ve en la tabla —las dos son un Map vacio— pero si en el
 * estado del casillero, que es exactamente el mismo truco que usa
 * `tablaConRespaldo` en `emotes.js` para no adivinar.
 *
 * Con la tabla NO vacia alcanza con la tabla: si la ultima bajada buena
 * dijo que este canal tiene `bits` y no `subscriber`, eso es una
 * respuesta, no una duda, aunque despues un reintento haya fallado.
 */
function sabemosDelCanal(slug, delCanal) {
  if (delCanal.size > 0) return true;
  const estado = cache.get(clave(slug))?.avisado ?? '';
  return estado === 'sin-propias' || estado.startsWith('ok:');
}

/* -------------------------------------------------------- resolucion */

let ultimoAvisoFalla = 0;

/**
 * Le pone a cada insignia de un mensaje la URL de su imagen, si la
 * hay. Modifica el mensaje y lo devuelve.
 *
 * @param {object} mensaje  un mensaje del formato unico
 * @param {string} slug     de que sala es
 */
export function resolver(mensaje, slug) {
  /* ESTO NO PUEDE TIRAR NUNCA. Decora un mensaje; no es el mensaje.
     Corre adentro de `recibirDeKick`, DESPUES de que el evento quedo
     marcado como visto y sin try alrededor: una excepcion aca no seria
     una insignia que falta, seria el mensaje perdido y un 500 en el
     webhook de Kick. El aviso sale como mucho una vez por minuto,
     porque si algo lo dispara lo va a disparar en todos. */
  try {
    return conImagenes(mensaje, slug);
  } catch (e) {
    const ahora = Date.now();
    if (ahora - ultimoAvisoFalla > AVISO) {
      ultimoAvisoFalla = ahora;
      console.warn('[insignias] no se pudo resolver un mensaje:', e?.message ?? e?.name ?? 'Error');
    }
    return mensaje;
  }
}

function conImagenes(mensaje, slug) {
  if (!mensaje || mensaje.tipo !== 'chat') return mensaje;
  const lista = Array.isArray(mensaje.insignias) ? mensaje.insignias : [];
  /* Sin insignias no hay nada que resolver Y NO SE AGENDA NADA. Es lo
     que hace que un chat donde nadie tiene insignias no genere un solo
     pedido a Helix. */
  if (!lista.length) return mensaje;

  /* Kick sale intacto: sus insignias se quedan con `url: ''` y la
     pagina muestra la etiqueta de texto. Ver el bloque de arriba: no
     hay imagen oficial y el dueño no quiere iconos inventados. */
  if (mensaje.red !== 'twitch' || !ACTIVO_TWITCH) return mensaje;

  const delCanal = tabla(slug);
  const comunes = globales();
  if (!delCanal.size && !comunes.size) return mensaje;
  /* Se pregunta DESPUES de `tabla()`, que es la que agenda la bajada y
     crea el casillero. */
  const seSabe = sabemosDelCanal(slug, delCanal);

  for (const i of lista) {
    const tipo = String(i?.tipo ?? '');
    const version = String(i?.version ?? '');
    /* EL CANAL LE GANA A LOS GLOBALES, set por set y no en bloque: un
       canal que personalizo `subscriber` sigue usando el `moderator`
       global, y su version 12 de suscriptor no puede caer en la 12
       global (que es otro dibujo, el generico de Twitch). Si el canal
       tiene ese set pero no esa version, tampoco se cae al global: se
       deja sin imagen y se ve la etiqueta, que es mejor que mostrar la
       insignia de otro. */
    const propio = delCanal.get(tipo);
    if (propio) {
      i.url = propio.get(version) ?? '';
      continue;
    }

    /* Y MIENTRAS NO SEPAMOS QUE TIENE ESTE CANAL, un set que el canal
       PODRIA tener propio no se resuelve con el global.

       Esto era deuda anotada: con la tabla del canal vacia —porque
       todavia no se bajo, o porque la bajada fallo— un suscriptor
       salia con el escudo generico de Twitch como si fuera el de esta
       comunidad. Estaba anotado como decision consciente con este
       argumento: exigir el casillero confirmado para TODO haria perder
       tambien las globales bien resueltas (mod, VIP, Prime) en esa
       misma ventana, que es mas de lo que se gana.

       El argumento era correcto y la conclusion no: no hay que elegir
       entre las dos cosas. La tercera opcion es preguntar POR SET, que
       es como funciona el resto de esta funcion. `moderator` no puede
       ser propio de nadie, asi que la global es la verdad y se pinta;
       `subscriber` si puede, asi que mientras no sepamos se deja sin
       imagen y se ve la etiqueta. Se conservan las globales Y no se
       muestra el escudo de nadie mas. */
    if (!seSabe && PERSONALIZABLES.has(tipo)) {
      i.url = '';
      continue;
    }

    i.url = comunes.get(tipo)?.get(version) ?? '';
  }
  return mensaje;
}
