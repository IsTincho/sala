/* ============================================================
   Emotes de 7TV, por creador y por red.

   Ni Kick ni Twitch saben que 7TV existe. Quien tiene la extension
   puesta los ve en su navegador; para todos los demas —y para
   nosotros— el mensaje llega con la palabra pelada. En el webhook de
   Kick "CHAD" es texto, no un `[emote:...]`, y en el fragmento de
   EventSub es un fragmento `text`. Por eso alguien escribe CHAD en el
   chat, lo ve como emote en kick.com y como palabra en el multichat.

   Aca se baja la tabla `nombre -> imagen` del set de 7TV de cada
   creador y se resuelven las palabras del mensaje contra ella, ANTES
   de que el mensaje salga al bus. La pagina no se entera: entran por
   el mismo array `emotes` del formato unico que los nativos.

   ---------------------------------------------------------------
   POR QUE LA CACHE ES POR (SLUG, RED) Y NO POR RED

   Porque este servidor es de muchos creadores. El repo hermano
   (CosasStream) tiene un solo canal y le alcanza con una tabla por
   red; aca, dos creadores comparten la red y no comparten el set. Con
   la clave por red, el set de uno se le pintaria a los mensajes del
   otro, que es la peor clase de bug: no rompe nada, muestra el emote
   equivocado en la pantalla de otra comunidad.

   Y cada casillero tiene su propio vencimiento y su propia promesa en
   vuelo, asi que un 7TV que contesta mal para un creador no toca la
   tabla de los demas.

   ---------------------------------------------------------------
   EL QUE PREGUNTA NUNCA ESPERA

   `resolver()` es sincrono a proposito. Un mensaje de chat tiene que
   salir al toque; no puede quedarse esperando a un tercero que a
   veces tarda. Si la tabla todavia no esta, el mensaje sale sin
   emotes de 7TV y la bajada queda agendada para el proximo.

   En la practica eso es UN mensaje por creador y por arranque: cuando
   la tabla vence, se sigue sirviendo la vieja mientras se baja la
   nueva, asi que no hay un segundo hueco. El unico mensaje que se
   pierde los emotes es el primero que llega despues de un deploy. Lo
   contrario —precalentar la tabla de los 900 creadores cada diez
   minutos— seria 1800 pedidos cada diez minutos a un servicio
   gratuito ajeno para chats que en su mayoria estan callados.

   ---------------------------------------------------------------
   TRES VENCIMIENTOS, NO UNO

   Un exito vence a los diez minutos (lo mismo que usa CosasStream, y
   comodo frente al tope de 24 h de cacheo que ponen los terminos de
   Kick: aca no se persiste NADA, todo muere con el proceso).

   Un 404 de 7TV —"este usuario no tiene cuenta"— vence a la hora. Es
   el caso de la MAYORIA de los creadores y es un hecho estable: no
   tiene sentido volver a preguntarlo 144 veces por dia por cada uno.
   El precio es que quien se acaba de hacer una cuenta de 7TV espera
   hasta una hora; esta escrito en el README.

   Un fallo de verdad (timeout, 500, red) vence al minuto y NO pisa la
   tabla que habia: un emote viejo es mejor que ninguno.

   ---------------------------------------------------------------
   DE DONDE SALE EL ID

   7TV indexa por el id de usuario de cada plataforma. El de Kick es
   el `user_id` que devuelve `/public/v1/users`, que es el mismo que
   usamos como `broadcaster_user_id` para suscribir el webhook. OJO,
   que es el error facil: el `channel_id` de Kick NO sirve, 7TV
   contesta 404 (verificado en INVESTIGACION-EMOTES.md).

   Los dos salen de `vinculos.identidad()`, que lee el vinculo sin
   descifrar ni refrescar tokens. Si el creador no vinculo esa red, no
   hay id y no se pide nada.
   ============================================================ */

import * as vinculos from './vinculos.js';

const API = 'https://7tv.io/v3';

/* Se puede apagar entero sin tocar codigo. 7TV es un tercero: si un
   dia empieza a contestar cualquier cosa, el multichat tiene que
   poder seguir andando con los emotes nativos y nada mas. */
export const ACTIVO = process.env.EMOTES_7TV !== '0';

/* CUANTO SE ESTA DISPUESTO A GASTAR EN UN EMOTE, en bytes.

   Esto NO es el numero de CosasStream y no tiene por que serlo. Alla
   el problema son los frames que le cuesta a OBS repintar un gif, y
   el presupuesto solo elige de que tamaño se pide el emote: el
   descarte lo hace despues el tope de animados en pantalla. Aca el
   problema es el ancho de banda del navegador de CADA espectador, no
   hay ningun tope aguas abajo, y lo que el servidor mete en el
   mensaje se lo baja todo el mundo.

   Medido hoy contra el set real del dueño (66 emotes, 49 animados),
   pidiendo `2x.webp`, que es el tamaño que se muestra (el CSS pone
   el emote en 1.6em, o sea ~24 px de alto; 2x son 64 px y cubren
   pantallas de hasta 2,6x de densidad):

     mediana  29,8 KB      p90  245,0 KB      maximo  1.100,5 KB

   La mediana es barata y la cola es carisima. El peor, `maxwin`, pesa
   1,1 MB en 2x y 505 KB hasta en 1x.

   La escalera medida, con el criterio "2x si entra, si no 1x, si no
   no sale", sobre esos 66 emotes:

      64 KB -> 42 en 2x, 15 en 1x,  9 afuera, set entero 1,3 MB
      96 KB -> 52 en 2x,  7 en 1x,  7 afuera, set entero 1,9 MB
     128 KB -> 56 en 2x,  7 en 1x,  3 afuera, set entero 2,6 MB
     256 KB -> 62 en 2x,  3 en 1x,  1 afuera, set entero 3,6 MB

   Se eligen 128 KB: el 85% del set sale en calidad plena, 7 mas salen
   un poco mas borrosos y solo 3 no salen (`Vibe`, `cenaJAM` y
   `maxwin`, los tres animaciones largas). El techo por espectador que
   vio el set entero queda en 2,6 MB en vez de los 5,3 MB de mandar
   todo en 2x o los 11 MB de mandarlo en 4x. Con 256 KB entra casi
   todo, pero un solo emote de 1,1 MB repetido en una sala llena es
   justo lo que esto tiene que evitar.

   Un emote que ni en 1x entra se descarta: la palabra se ve como
   texto, que es exactamente lo que se ve hoy. Nunca se empeora. */
export const PRESUPUESTO = Math.max(8, Number(process.env.EMOTES_KB ?? 128)) * 1024;

/* Los dos tamaños candidatos, del que se prefiere al de respaldo.
   No se miran 3x ni 4x: son para pintar el emote grande (el overlay
   de CosasStream los usa), y aca el emote se muestra en 24 px.
   Se pide WEBP y no AVIF aunque AVIF pese la mitad, porque un Safari
   viejo o un WebView de Android viejo no lo dibujan y en un chat eso
   es un icono roto por mensaje. El dia que se decida dejar esos
   navegadores afuera, es cambiar esta lista. */
const TAMANOS = ['2x.webp', '1x.webp'];

const CADUCA = 10 * 60 * 1000;
const SIN_CUENTA = 60 * 60 * 1000;
const REINTENTO = 60 * 1000;
const ESPERA = 8000;

/* Cuantas bajadas pueden estar en vuelo a la vez, en todo el proceso.
   Sin esto, un arranque con 900 creadores recibiendo su primer
   mensaje son 900 fetch de una. Las que no entran no se encolan: el
   proximo mensaje de ese canal lo vuelve a intentar, que es el mismo
   trato que ya tiene el primero. */
const EN_VUELO_MAX = 6;

/* Cuantos emotes de 7TV puede agregar UN mensaje.

   El texto viene topeado en 2000 puntos de codigo, asi que un mensaje
   de "CHAD CHAD CHAD..." son 400 palabras: 400 <img> en el DOM de
   cada pestaña abierta, por un solo mensaje. Los nativos no necesitan
   este tope porque su markup ocupa mucho mas lugar en el texto; los
   de 7TV son una palabra corta y ahi esta la diferencia. Pasado el
   tope, el resto de las palabras quedan como texto. */
export const TOPE_POR_MENSAJE = Math.max(1, Number(process.env.EMOTES_POR_MENSAJE ?? 30));

/* El nombre de la fuente que viaja en cada emote. */
export const FUENTE = '7tv';

/* ------------------------------------------------------------ cache

   clave -> { tabla, vence, bajando, avisado }

   `avisado` es lo que evita el log por mensaje y el log por creador
   cada diez minutos: se cuenta lo que pasa cuando CAMBIA, no cada vez
   que se confirma. */

const cache = new Map();

/* Un slug validado nunca tiene `/`, asi que la clave del set global no
   puede chocar con la de ningun creador. */
const CLAVE_GLOBALES = '/globales';
const clave = (slug, red) => `${String(slug ?? '').toLowerCase()}/${red}`;

function casillero(k) {
  let c = cache.get(k);
  if (!c) {
    c = { tabla: new Map(), vence: 0, bajando: null, avisado: '' };
    cache.set(k, c);
  }
  return c;
}

let enVuelo = 0;

/** Borra todo lo cacheado. Para las pruebas y para un apagon de 7TV. */
export function olvidarTodo() {
  cache.clear();
  enVuelo = 0;
}

/**
 * Marca la tabla de un creador como vencida: la proxima consulta la
 * vuelve a bajar, sin esperar a que se cumplan los diez minutos.
 *
 * No se usa todavia en produccion. Es, a proposito, el gancho que
 * necesitaria la EventAPI de 7TV (ver el README): cuando llega un
 * `emote_set.update` de un set, se vence esa clave y listo. Tambien
 * seria lo que llame un boton de "recargar mis emotes" en el panel.
 */
export function vencer(slug, red) {
  const c = cache.get(red ? clave(slug, red) : String(slug ?? ''));
  if (c) c.vence = 0;
}

/**
 * Espera a que no quede ninguna bajada en vuelo.
 *
 * Existe para las pruebas y nada mas. El camino de produccion NUNCA
 * espera una bajada (ver el bloque de arriba); un test, en cambio,
 * tiene que poder mirar la tabla ya armada sin dormir un rato fijo y
 * cruzar los dedos. El bucle se repite porque una bajada puede
 * encadenar un segundo pedido (el del set) y porque los casilleros que
 * no entraron en el tope de concurrencia arrancan despues.
 */
export async function reposo() {
  for (let vuelta = 0; vuelta < 50; vuelta++) {
    const enCurso = [...cache.values()].map(c => c.bajando).filter(Boolean);
    if (!enCurso.length) return;
    await Promise.allSettled(enCurso);
  }
}

/* -------------------------------------------------------- identidad

   Quien es este creador en esta red, para 7TV. Se puede reemplazar en
   las pruebas, igual que `chat.fijarConexiones()`: asi el test no
   necesita un almacen ni un vinculo de verdad. */

let identidad = (slug, red) => vinculos.identidad(slug, red);

/** Cambia de donde sale el id de cada creador. Solo para las pruebas. */
export function fijarIdentidad(fn) {
  if (typeof fn !== 'function') throw new Error('fijarIdentidad quiere una funcion');
  identidad = fn;
}

/* ----------------------------------------------------------- pedidos */

class ErrorSinCuenta extends Error {}

async function pedirJson(url) {
  const r = await fetch(url, {
    signal: AbortSignal.timeout(ESPERA),
    headers: { accept: 'application/json' },
  });
  /* 404 es "este usuario (o este set) no existe en 7TV", que es un
     hecho estable y no un fallo. Se distingue para poder cachearlo
     mucho mas tiempo y para no loguearlo como problema. */
  if (r.status === 404) throw new ErrorSinCuenta('7TV no conoce a este usuario');
  if (!r.ok) throw new Error(`7TV contesto ${r.status}`);
  return r.json();
}

/**
 * La imagen que se va a mandar de UN emote, o null si no entra en el
 * presupuesto ni en su tamaño mas chico.
 *
 * 7TV dice el peso exacto de cada archivo en la misma respuesta, asi
 * que el tope se aplica sin pedir nada mas. (Kick no dice nada y por
 * eso CosasStream tiene que ir a mirarle los primeros bytes al CDN;
 * aca esa complicacion no hace falta.)
 */
function imagenDe(emote) {
  const host = emote?.data?.host;
  if (!host?.url) return null;

  const porNombre = new Map((host.files ?? []).map(f => [f.name, f]));
  for (const nombre of TAMANOS) {
    const f = porNombre.get(nombre);
    const bytes = Number(f?.size) || 0;
    if (!f || !bytes || bytes > PRESUPUESTO) continue;
    /* host.url viene sin esquema ("//cdn.7tv.app/emote/<id>") */
    const base = host.url.startsWith('//') ? 'https:' + host.url : host.url;
    return { id: String(emote.id ?? ''), url: `${base}/${nombre}` };
  }
  return null;
}

/** La tabla nombre -> imagen de un set ya bajado. */
function tablaDelSet(set) {
  const t = new Map();
  for (const e of set?.emotes ?? []) {
    const img = imagenDe(e);
    /* 7TV DISTINGUE MAYUSCULAS: "CHAD" y "chad" son dos emotes
       distintos y pueden ser dos dibujos distintos. Nada de
       toLowerCase() ni aca ni al buscar. */
    if (e?.name && img) t.set(String(e.name), img);
  }
  return t;
}

async function bajarSet(slug, red) {
  const quien = await identidad(slug, red);
  const id = String(quien?.usuarioId ?? '');
  /* Sin vinculo con esa red no hay a quien preguntarle. Cuenta como
     "sin cuenta": no se vuelve a intentar por un rato. */
  if (!id) throw new ErrorSinCuenta('el creador no tiene vinculada esa red');

  const usuario = await pedirJson(`${API}/users/${red}/${encodeURIComponent(id)}`);

  /* El set puede venir de tres lados y no siempre estan los tres. En
     Kick la conexion suele quedar sin set asignado y lo que vale es el
     primero del usuario, que es lo que muestra la extension. Esta
     cascada esta copiada del repo hermano, donde ya lleva meses en
     produccion. */
  const conexion = (usuario.user?.connections ?? [])
    .find(c => c?.platform === red.toUpperCase())?.emote_set;
  let set = usuario.emote_set ?? conexion;
  if (!set?.emotes?.length) {
    const idSet = usuario.emote_set_id ?? conexion?.id ?? usuario.user?.emote_sets?.[0]?.id;
    if (!idSet) return new Map();
    set = await pedirJson(`${API}/emote-sets/${encodeURIComponent(idSet)}`);
  }
  return tablaDelSet(set);
}

/* Los globales son los mismos para todos los creadores, asi que son UN
   casillero para todo el proceso, no uno por sala.

   Van incluidos porque es lo que ve en su chat cualquiera que tenga la
   extension puesta, en cualquier canal, tenga o no el streamer cuenta
   de 7TV. Dejarlos afuera haria que el multichat muestre MENOS de lo
   que la gente ya ve. Son 45 emotes y pesan poco: mediana 4,5 KB en
   2x, 852 KB el set entero (medido). */
async function bajarGlobales() {
  return tablaDelSet(await pedirJson(`${API}/emote-sets/global`));
}

/* ------------------------------------------------------------ bajada */

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
  if (enVuelo >= EN_VUELO_MAX) return;   // se reintenta con el proximo mensaje

  enVuelo++;
  c.bajando = como()
    .then(t => {
      c.tabla = t;
      c.vence = Date.now() + CADUCA;
      avisar(c, `ok:${t.size}`, `[7tv] ${etiqueta}: ${t.size} emote${t.size === 1 ? '' : 's'}`);
    })
    .catch(e => {
      if (e instanceof ErrorSinCuenta) {
        /* El caso de la mayoria. Se deja la tabla vacia y se calla. */
        c.tabla = new Map();
        c.vence = Date.now() + SIN_CUENTA;
        avisar(c, 'sin-cuenta', `[7tv] ${etiqueta}: sin set de 7TV`);
        return;
      }
      /* NO se pisa `c.tabla`: si habia una que funcionaba, se sigue
         sirviendo aunque este vencida. */
      c.vence = Date.now() + REINTENTO;
      avisar(c, 'fallo', `[7tv] ${etiqueta}: no se pudo actualizar (${e.message})`);
    })
    .finally(() => {
      c.bajando = null;
      /* Con piso en cero: si alguien llama a `olvidarTodo()` con una
         bajada en vuelo, el contador no puede quedar en negativo y
         dejar el tope de concurrencia abierto para siempre. */
      enVuelo = Math.max(0, enVuelo - 1);
    });
}

/**
 * La tabla `nombre -> { id, url }` del set de un creador en una red.
 *
 * Sincrona: devuelve lo que hay AHORA (puede estar vacia la primera
 * vez) y deja agendada la bajada.
 *
 * @param {string} slug
 * @param {'kick'|'twitch'} red
 * @returns {Map<string,{id:string,url:string}>}
 */
export function tabla(slug, red) {
  if (!ACTIVO || !slug || (red !== 'kick' && red !== 'twitch')) return new Map();
  const k = clave(slug, red);
  agendar(k, () => bajarSet(slug, red), `${slug}/${red}`);
  return casillero(k).tabla;
}

/** La tabla de los globales de 7TV, compartida por todos los canales. */
export function globales() {
  if (!ACTIVO) return new Map();
  agendar(CLAVE_GLOBALES, bajarGlobales, 'globales');
  return casillero(CLAVE_GLOBALES).tabla;
}

/* -------------------------------------------------------- resolucion

   7TV resuelve POR PALABRA ENTERA. "CHAD" es el emote; "CHAD!" y
   "xCHAD" no son nada. Asi funciona la extension y asi tiene que
   funcionar esto, o el chat se llena de emotes donde la gente no los
   puso.

   Y se camina por PUNTOS DE CODIGO, no por unidades de string. Un
   `texto.split(' ')` con indices de string desalinea todos los emotes
   que vengan despues del primer emoji fuera del plano basico, que en
   el chat de Kick es uno de cada dos mensajes. Es el mismo motivo por
   el que el formato unico cuenta puntos de codigo. */

const BLANCO = /\s/u;
/* El espacio comun se ataja antes de tocar la regex: son hasta 2000
   comprobaciones por mensaje. */
const esBlanco = c => c === ' ' || BLANCO.test(c);

/**
 * Le agrega a un mensaje del formato unico los emotes de 7TV que haya
 * en su texto. Modifica el mensaje y lo devuelve.
 *
 * GANAN LOS NATIVOS. Si una palabra cae —aunque sea en parte— adentro
 * del rango de un emote de Kick o de Twitch, se deja como esta. Dos
 * motivos:
 *
 *   1. En Kick el texto que se ve NO es lo que la persona escribio:
 *      `partirTextoDeKick()` reemplaza `[emote:123:HYPERCLAP]` por la
 *      palabra `HYPERCLAP` para que sirva de `alt`. Si 7TV tambien
 *      tuviera un HYPERCLAP, esa palabra se resolveria dos veces y la
 *      segunda pisaria a la primera. El nativo es el que la persona
 *      efectivamente eligio del selector de Kick.
 *   2. El array `emotes` tiene que salir ordenado y SIN SOLAPARSE:
 *      `agregarTextoConEmotes()` de la pagina lo recorre con un
 *      cursor. Dos rangos pisados no tiran error, pintan mal.
 *
 * @param {object} mensaje  un mensaje del formato unico
 * @param {string} slug     de que sala es
 */
export function resolver(mensaje, slug) {
  if (!ACTIVO || !mensaje || mensaje.tipo !== 'chat') return mensaje;
  const texto = mensaje.texto ?? '';
  if (!texto) return mensaje;

  const delCanal = tabla(slug, mensaje.red);
  const comunes = globales();
  if (!delCanal.size && !comunes.size) return mensaje;

  const nativos = Array.isArray(mensaje.emotes) ? mensaje.emotes : [];
  /* Copia ordenada: los tres traductores ya los entregan en orden,
     pero esto se recorre con un puntero que asume que lo estan y no
     vale la pena que dependa de eso. */
  const ocupados = nativos
    .map(e => [Number(e.inicio), Number(e.fin)])
    .sort((a, b) => a[0] - b[0]);

  const puntos = [...texto];
  const hallados = [];
  let i = 0;
  let siguiente = 0;   // primer rango nativo que todavia puede estorbar

  while (i < puntos.length) {
    if (esBlanco(puntos[i])) { i++; continue; }
    const inicio = i;
    while (i < puntos.length && !esBlanco(puntos[i])) i++;
    const fin = i;

    while (siguiente < ocupados.length && ocupados[siguiente][1] <= inicio) siguiente++;
    if (siguiente < ocupados.length && ocupados[siguiente][0] < fin) continue;

    if (hallados.length >= TOPE_POR_MENSAJE) break;

    const nombre = puntos.slice(inicio, fin).join('');
    /* El set del canal le gana a los globales: un streamer puede
       ponerle a un emote suyo el nombre de uno global, y el que manda
       en su casa es el suyo. */
    const img = delCanal.get(nombre) ?? comunes.get(nombre);
    if (img) hallados.push({ id: img.id, inicio, fin, url: img.url, fuente: FUENTE });
  }

  if (!hallados.length) return mensaje;
  mensaje.emotes = [...nativos, ...hallados].sort((a, b) => a.inicio - b.inicio);
  return mensaje;
}
