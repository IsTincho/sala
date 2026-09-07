/* ============================================================
   El catalogo de videos de cada sala, y la clave con la que el
   script de subida escribe en el.

   Dos cosas distintas que viven juntas porque son las dos mitades del
   mismo tramite: `herramientas/subir.py` convierte el archivo, lo
   sube a R2 y despues le avisa a este modulo que existe.

   ---------------------------------------------------------------
   ACA NO HAY UN SOLO BYTE DE VIDEO

   Lo unico que se guarda es la ficha: id, titulo, duracion y la URL
   publica de la playlist en r2.dev. El navegador le pide los
   segmentos a R2 directo. Si algun dia una funcion de este archivo
   devuelve un .m3u8 o un .ts, el egreso de Railway se come el
   presupuesto del mes en una noche.

   ---------------------------------------------------------------
   POR QUE UNA CABECERA Y NO UNA COOKIE

   El script corre en una terminal en la PC del dueño, no en un
   navegador: no hay cookie que mandar ni flujo de OAuth que completar
   sin abrir un browser. Manda `X-Clave-Subida`, que el dueño genera
   una vez desde /panel y copia a `herramientas/.env`.

   La clave se guarda HASHEADA, como las sesiones. Es un secreto de 32
   bytes al azar, asi que un SHA-256 alcanza: no hay diccionario que
   ataque eso, y un bcrypt aca solo agregaria una dependencia. Un
   volcado de la base no deja subir ni borrar nada.

   Comparar hashes se hace con timingSafeEqual. La diferencia de
   tiempo entre "el primer byte no coincide" y "los primeros treinta
   si" es medible por la red, y con ella se puede adivinar un hash
   byte por byte.
   ============================================================ */

import crypto from 'node:crypto';
import net from 'node:net';
import * as almacen from './almacen.js';

/* El mismo id que valida `herramientas/subir.py` (validar_id). Tienen
   que coincidir: el script arma con el la clave de R2 y el servidor
   arma con el la del almacen. Si aca entrara algo que alla no, habria
   fichas apuntando a objetos que no existen. */
const ID_VALIDO = /^[a-z0-9][a-z0-9-]{0,59}$/;

/* El slug es el prefijo del bucket y la clave del canal. Se limita
   igual de fuerte: es parte de un id de documento y de una URL. */
const SLUG_VALIDO = /^[a-z0-9][a-z0-9_-]{0,49}$/;

const TOPE_TITULO = 200;
const TOPE_URL = 500;
const TOPE_SUBTITULOS = 20;
const TOPE_CALIDADES = 8;

/* Caracteres de control: C0, DEL, C1, y los dos separadores de linea de
   Unicode. Ninguno de estos se puede escribir en el nombre de un
   archivo por accidente, y cualquiera de ellos partido en el medio de
   un titulo es una linea de log inventada. Ver `limpiar`. */
const CONTROLES = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g;

/* Las direcciones que apuntan SIEMPRE a la maquina del que mira: todo
   127.0.0.0/8 y `0.0.0.0` del lado de IPv4, `::1` y `::` del lado de
   IPv6. Ver `esLoopback`, que es donde esta el por que de que esto sea
   un BlockList y no una regex. */
const LOOPBACK = new net.BlockList();
LOOPBACK.addSubnet('127.0.0.0', 8, 'ipv4');
LOOPBACK.addAddress('0.0.0.0', 'ipv4');
LOOPBACK.addAddress('::1', 'ipv6');
LOOPBACK.addAddress('::', 'ipv6');

/* Un video de 24 horas ya es absurdo; mas que eso es un dato roto que
   dejaria el reloj calculando posiciones sin sentido. */
const TOPE_DURACION = 24 * 60 * 60;

export const idValido = id => ID_VALIDO.test(String(id ?? ''));
export const slugValido = s => SLUG_VALIDO.test(String(s ?? ''));

/**
 * Un texto que vino del nombre de un archivo, listo para meter en una
 * linea de log, en el HTML del panel o en un evento del bus.
 *
 * POR QUE, con nombre y apellido: el titulo sale del nombre del archivo
 * que el dueño le pasa a `herramientas/subir.py`, y despues aterriza en
 * un `console.log` de index.js. Un titulo con un \n adentro parte esa
 * linea en dos y la segunda mitad la escribe quien subio el video:
 * `[http] POST /api/panel 200 clave=FALSA` entra perfecto. Los logs de
 * Railway no se borran y son la unica evidencia cuando algo falla, asi
 * que una linea inventada ahi no es un detalle estetico.
 *
 * Los controles se reemplazan por un espacio y no se borran: "hola\nchau"
 * tiene que quedar "hola chau" y no "holachau". Despues se colapsan los
 * espacios seguidos, que es lo que deja un titulo legible.
 */
export const limpiar = s => String(s ?? '').replace(CONTROLES, ' ').replace(/\s+/g, ' ').trim();

/**
 * Un hostname comparable COMO TEXTO. Baja a minusculas y saca el punto
 * final de la forma absoluta (`localhost.`, `sala.example.`), que
 * resuelve al mismo lugar y se escapaba de la comparacion por un
 * caracter: el parser de URL de Node no lo saca.
 *
 * Esto alcanza para comparar contra un nombre (el chequeo 1 de
 * `revisarFicha`, contra URL_BASE) y NO alcanza para preguntar "¿esta
 * direccion es esta maquina?", que es una pregunta sobre la direccion y
 * no sobre como se escribio. Para eso esta `esLoopback`.
 */
const hostnameDe = h => String(h ?? '').toLowerCase().replace(/\.$/, '');

/**
 * Si un hostname apunta SIEMPRE a la maquina del que mira.
 *
 * POR QUE NO UNA REGEX, con nombre y apellido. Aca hubo una: una lista
 * de formas de escribir la misma direccion (`localhost`, `127.x.x.x`,
 * `::1`, `0.0.0.0`) apoyada en que el parser de URL de Node normaliza
 * el resto solo. Normaliza bastante —`127.1`, `0x7f.0.0.1` y
 * `2130706433` salen los tres como `127.0.0.1`, y `[0:0:0:0:0:0:0:1]`
 * como `[::1]`— pero NO convierte la forma IPv4-mapeada de IPv6 a
 * cuartetos decimales: `[::ffff:127.0.0.1]` sale como `[::ffff:7f00:1]`
 * y `[0:0:0:0:0:0:0:0]` como `[::]`. Ninguna de las dos matcheaba, asi
 * que las dos pasaban. Escribir mas alternativas en la regex no arregla
 * la categoria: la pregunta es sobre la DIRECCION, y la regex mira el
 * texto.
 *
 * `net.BlockList` compara direcciones y entiende la forma mapeada solo:
 * `check('::ffff:7f00:1', 'ipv6')` cae adentro de la regla de
 * `127.0.0.0/8` sin que aca haya que decodificar nada. Es de `node:net`,
 * asi que no agrega una dependencia.
 *
 * `localhost` se mira por nombre porque no es una direccion: es lo unico
 * que queda del lado del texto.
 */
export function esLoopback(host) {
  const h = hostnameDe(host);
  if (h === 'localhost') return true;
  /* `new URL(...).hostname` devuelve las IPv6 entre corchetes y `net`
     las quiere sin ellos. */
  const ip = h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h;
  const familia = net.isIP(ip);
  if (!familia) return false;
  return LOOPBACK.check(ip, familia === 4 ? 'ipv4' : 'ipv6');
}

/**
 * El host de este mismo servidor, o '' si no se sabe.
 *
 * Sale de URL_BASE y NO del header Host del pedido: el Host lo elige
 * quien llama, asi que usarlo aca seria dejar que el que sube la ficha
 * decida contra que se la compara.
 */
export function hostPropio() {
  const base = String(process.env.URL_BASE ?? '').trim();
  if (!base) return '';
  try { return hostnameDe(new URL(base).hostname); }
  catch { return ''; }
}

const claveDoc = (slug, id) => `${slug}:${id}`;

const hashDe = clave => crypto.createHash('sha256').update(String(clave)).digest('hex');

/* --------------------------------------------------- clave de subida */

/**
 * Genera una clave nueva para una sala y la devuelve EN CLARO una sola
 * vez. Lo que queda guardado es su hash: no hay forma de volver a
 * mostrarla. Si se pierde, se genera otra.
 */
export async function generarClave(slug) {
  if (!slugValido(slug)) throw new Error(`slug invalido: ${slug}`);
  const clave = crypto.randomBytes(32).toString('base64url');
  await almacen.poner('subidas', slug, { hash: hashDe(clave), creada: Date.now() });
  return clave;
}

export async function revocarClave(slug) {
  if (!slugValido(slug)) throw new Error(`slug invalido: ${slug}`);
  return almacen.quitar('subidas', slug);
}

/** Si hay clave y desde cuando. Nunca la clave ni su hash. */
export async function estadoClave(slug) {
  const doc = await almacen.obtener('subidas', String(slug ?? ''));
  return { hay: Boolean(doc?.hash), creada: doc?.creada ?? 0 };
}

/**
 * De que sala es esta clave, o '' si no es de ninguna.
 *
 * Se recorren todas porque la clave presentada no dice a quien dice
 * ser: son cuatro documentos hoy y unos cientos en la Fase 3, y todas
 * las comparaciones se hacen igual aunque la primera acierte, para no
 * filtrar por tiempo cual fue la que coincidio.
 */
export async function salaDeLaClave(clave) {
  const presentada = String(clave ?? '');
  if (!presentada) return '';
  const esperado = Buffer.from(hashDe(presentada), 'utf8');

  let encontrado = '';
  for (const doc of await almacen.listar('subidas')) {
    const guardado = Buffer.from(String(doc?.hash ?? ''), 'utf8');
    if (guardado.length !== esperado.length) continue;
    if (crypto.timingSafeEqual(guardado, esperado) && !encontrado) encontrado = doc.id;
  }
  return encontrado;
}

/* ------------------------------------------------------- catalogo */

/**
 * Normaliza y valida lo que manda el script.
 *
 * Devuelve `{ error }` si algo no sirve, o `{ ficha }` lista para
 * guardar. Es una funcion aparte y exportada para poder probar cada
 * rechazo sin levantar el servidor.
 *
 * `calidades`, `subtitulos` y `bytes` son OPCIONALES a proposito:
 * `subir.py --avisar` (el reintento del paso 5, cuando la subida salio
 * bien y el servidor estaba caido) manda solo id, slug, titulo,
 * duracion y url.
 */
export function revisarFicha(datos, opciones = {}) {
  const d = datos ?? {};

  const id = String(d.id ?? '');
  if (!idValido(id)) return { error: 'id invalido: solo minusculas, numeros y guiones' };

  const slug = String(d.slug ?? '').toLowerCase();
  if (!slugValido(slug)) return { error: 'slug invalido' };

  /* `limpiar` ANTES del corte. Al reves TAMBIEN quedaria sin controles
     —limpiar despues del slice los saca igual—, asi que el orden no es
     lo que hace segura esta linea: lo que hace es no desperdiciar el
     tope. Recortando primero, los 200 caracteres se los comen tambien
     los controles y los espacios de mas, que despues se colapsan a
     nada; un titulo con basura al principio llegaria cortado mucho
     antes de los 200 caracteres utiles. */
  const titulo = limpiar(d.titulo ?? id).slice(0, TOPE_TITULO);
  if (!titulo) return { error: 'falta el titulo' };

  const duracion = Number(d.duracion);
  if (!Number.isFinite(duracion) || duracion <= 0 || duracion > TOPE_DURACION) {
    return { error: 'duracion invalida' };
  }

  /* La URL tiene que ser https y de otro host: el servidor no sirve
     video, asi que una ficha que apunte a nuestro propio dominio es un
     error de configuracion que conviene atajar aca y no descubrirlo
     con la factura de egreso. */
  const url = String(d.url ?? '');
  if (url.length > TOPE_URL) return { error: 'la url es demasiado larga' };
  let parseada;
  try { parseada = new URL(url); }
  catch { return { error: 'url invalida' }; }
  if (parseada.protocol !== 'https:') return { error: 'la url tiene que ser https' };
  if (!/\.m3u8$/i.test(parseada.pathname)) return { error: 'la url tiene que apuntar a una playlist .m3u8' };

  /* Y ahora el "de otro host", que es la mitad cara de la invariante.
     Van dos chequeos y no uno porque cada uno tapa lo que el otro deja:

     1. Contra el host de URL_BASE. Es la respuesta autoritativa en
        produccion, donde URL_BASE no es opcional. Se compara `hostname`
        y no `host`: una ficha en sala.example:8443 es igual de nuestra,
        y la URL legitima vive en r2.dev, asi que no hay falso positivo
        posible por ignorar el puerto.

     2. Contra las direcciones de esta misma maquina (`esLoopback`).
        Vale AUNQUE URL_BASE no este cargada, que es el caso de local y
        el que hizo que el chequeo 1 solo no alcance. Ademas es cierto
        por si mismo: un playlist en 127.0.0.1 apunta a la maquina del
        que mira, no a la nuestra, asi que no le puede servir a nadie. */
  const propio = hostnameDe(opciones.hostPropio ?? hostPropio());
  const suyo = hostnameDe(parseada.hostname);
  if (propio && suyo === propio) {
    return { error: 'la url no puede apuntar a este mismo servidor: el video se sirve desde R2' };
  }
  if (esLoopback(suyo)) {
    return { error: 'la url no puede apuntar a esta misma maquina: el video se sirve desde R2' };
  }

  const calidades = Array.isArray(d.calidades)
    ? d.calidades.map(Number).filter(n => Number.isFinite(n) && n > 0 && n <= 4320).slice(0, TOPE_CALIDADES)
    : [];

  /* Los nombres de las pistas salen de los metadatos del archivo, o
     sea del mismo lugar que el titulo y con la misma confianza: pasan
     por `limpiar` por el mismo motivo. */
  const subtitulos = Array.isArray(d.subtitulos)
    ? d.subtitulos.slice(0, TOPE_SUBTITULOS).map(s => ({
        idioma: limpiar(s?.idioma).slice(0, 20),
        nombre: limpiar(s?.nombre).slice(0, 60),
      })).filter(s => s.idioma || s.nombre)
    : [];

  const bytes = Number.isFinite(Number(d.bytes)) && Number(d.bytes) >= 0 ? Math.floor(Number(d.bytes)) : 0;

  return {
    ficha: {
      id, slug, titulo,
      duracion: Math.round(duracion * 1000) / 1000,
      url,
      calidades,
      subtitulos,
      bytes,
    },
  };
}

/**
 * Guarda (o pisa) la ficha de un video.
 *
 * PISA, no duplica: el script se puede correr dos veces sobre el mismo
 * archivo y la segunda tiene que dejar una sola entrada. Por eso la
 * clave del documento es `<slug>:<id>` y se usa `poner`, que reemplaza.
 */
export async function guardar(ficha) {
  await almacen.poner('videos', claveDoc(ficha.slug, ficha.id), {
    videoId: ficha.id,
    slug: ficha.slug,
    titulo: ficha.titulo,
    duracion: ficha.duracion,
    url: ficha.url,
    calidades: ficha.calidades,
    subtitulos: ficha.subtitulos,
    bytes: ficha.bytes,
    subido: Date.now(),
  });
  return ficha;
}

const aFicha = doc => (doc ? {
  id: doc.videoId ?? String(doc.id ?? '').split(':').slice(1).join(':'),
  slug: doc.slug ?? '',
  titulo: doc.titulo ?? '',
  duracion: Number(doc.duracion ?? 0),
  url: doc.url ?? '',
  calidades: Array.isArray(doc.calidades) ? doc.calidades : [],
  subtitulos: Array.isArray(doc.subtitulos) ? doc.subtitulos : [],
  bytes: Number(doc.bytes ?? 0),
  subido: Number(doc.subido ?? 0),
} : null);

export async function obtener(slug, id) {
  if (!slugValido(slug) || !idValido(id)) return null;
  return aFicha(await almacen.obtener('videos', claveDoc(String(slug).toLowerCase(), String(id))));
}

/** Los videos de una sala, del mas nuevo al mas viejo. */
export async function listar(slug) {
  const s = String(slug ?? '').toLowerCase();
  if (!slugValido(s)) return [];
  const docs = await almacen.listar('videos', { slug: s });
  return docs.map(aFicha).filter(Boolean).sort((a, b) => b.subido - a.subido);
}

/** Borra la ficha. Devuelve si habia algo que borrar. */
export async function borrar(slug, id) {
  if (!slugValido(slug) || !idValido(id)) return false;
  return almacen.quitar('videos', claveDoc(String(slug).toLowerCase(), String(id)));
}
