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

   CUANTOS MENSAJES SALEN PELADOS, con los numeros medidos y no con la
   frase linda: todos los que lleguen MIENTRAS se baja la tabla. Con un
   creador solo y 7TV contestando rapido es uno. Pero la bajada tarda
   lo que tarda, y ademas hay un tope de seis simultaneas: medido con
   20 creadores mandando un mensaje cada 250 ms y 7TV a 600 ms, salieron
   130 mensajes sin emotes, y el peor creador se comio 11 seguidos.
   Pasa una sola vez por creador y por arranque —al vencer la tabla se
   sigue sirviendo la vieja mientras se baja la nueva, asi que ahi no
   hay hueco— y lo que se pierde es un adorno, no el mensaje.

   Lo contrario —precalentar la tabla de los 900 creadores— serian
   1800 pedidos por deploy a un servicio gratuito ajeno, la mayoria
   para chats que esa noche no hablan. No compensa.

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

export const CADUCA = 10 * 60 * 1000;
export const SIN_CUENTA = 60 * 60 * 1000;
export const REINTENTO = 60 * 1000;
const ESPERA = 8000;

/* EL RESPALDO ENTRE REDES, y por qué no es una cuarta caché.

   Verificado el 2026-09-22 contra el 7TV real: el Kick del dueño tiene
   set (66 emotes) y su Twitch NO tiene `emote_set` en la respuesta de
   `/users/twitch/<id>` — es el caso normal de quien usa 7TV en una
   sola red. Sin esto, sus mensajes de Twitch salen sin un solo emote
   de 7TV aunque tenga 66 cargados del otro lado.

   Cuando la red PROPIA no tiene set (7TV contestó 404, o contestó bien
   pero sin `emote_set`), se resuelve con el set de la OTRA red del
   mismo creador, si la tiene vinculada. La propia SIEMPRE gana: esto
   sólo se mira cuando la tabla propia está confirmada vacía, nunca la
   pisa ni la mezcla.

   No se guarda en un casillero aparte. Se lee con la misma `tabla()`
   que ya existe para esa otra red — la misma clave `(slug, otraRed)`,
   los mismos tres vencimientos, la misma bajada compartida y el mismo
   tope de `EN_VUELO_MAX`. Dos motivos:

     1. Menos pedidos: si alguien ya mira el chat de la otra red de ese
        creador, esa tabla ya está cacheada y el respaldo la lee gratis,
        sin pedir nada. Un casillero propio para el respaldo bajaría el
        MISMO set dos veces (una como "red propia" para quien la mira
        directo, otra como "respaldo" para la que no tiene) sin ganar
        nada a cambio.
     2. Nada de un cuarto vencimiento: el respaldo hereda el vencimiento
        de la red que lo sirve. Si esa red no tiene cuenta de 7TV, el
        respaldo también queda vacío una hora; si tiene una tabla que
        funciona, dura los mismos diez minutos.

   La red PROPIA tiene que estar vinculada para intentar el respaldo.
   Si ni siquiera está vinculada (no es que le falte 7TV, es que el
   creador no usa esa red en esta herramienta), no hay "red sin set
   propio" que respaldar: es un caso ya cubierto y una prueba vieja lo
   exige ("un creador que no vinculó la red no pide nada"). Por eso se
   guarda si la última bajada tuvo id (`vinculada`) además de si quedó
   vacía. */
export const RESPALDO_7TV = process.env.EMOTES_7TV_RESPALDO !== '0';

/* Cuantas bajadas pueden estar en vuelo a la vez, en todo el proceso.
   Sin esto, un arranque con 900 creadores recibiendo su primer
   mensaje son 900 fetch de una. Las que no entran no se encolan: el
   proximo mensaje de ese canal lo vuelve a intentar, que es el mismo
   trato que ya tiene el primero. */
export const EN_VUELO_MAX = 6;

/* CUANTO PUEDE DURAR UNA BAJADA ENTERA antes de darla por perdida.

   No alcanza con el timeout del `fetch`, y esto casi se lleva puesta
   la funcionalidad entera: una bajada arranca pidiendole el id al
   almacen (`vinculos.identidad` -> Mongo), y el cliente de Mongo se
   crea con `serverSelectionTimeoutMS` pero sin `socketTimeoutMS`. Un
   socket medio abierto no vence NUNCA, asi que esa promesa se queda
   colgada, el descuento del contador de `enVuelo` no llega a
   correr, y con seis colgadas 7TV queda apagado para TODOS los
   creadores, para siempre y sin una sola linea de log.

   Por eso el plazo cubre la bajada completa y no solo el pedido. Se le
   da margen sobre los dos fetch encadenados (8 s cada uno) y encima el
   viaje al almacen. Lo que vence se reintenta al minuto como cualquier
   otro fallo. */
const PLAZO = Math.max(1000, Number(process.env.EMOTES_PLAZO_MS ?? 20000));

/* Cada cuanto, como mucho, se avisa que el tope de concurrencia esta
   lleno. Sin esto seria una linea por mensaje; sin el aviso, un apagon
   global seria invisible, que es como casi se escapa el bug de arriba. */
const AVISO_TOPE = 60 * 1000;

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

/* ============================================================
   LA MARCA DE UN EMOTE DE KICK EN EL TEXTO QUE SALE

   Esto es la mitad de ida de lo que `mensajes.js` hace de vuelta, y
   esta aca —y no alla— a proposito: `partirTextoDeKick()` traduce lo
   que ENTRA (el markup de Kick a texto + posiciones para pintar), y
   estas dos funciones traducen lo que SALE (lo que el selector puso
   en la caja, a lo que cada red tiene que recibir). Son dos caminos
   distintos con dos duenos distintos, y juntarlos ataria el render
   del chat al envio.

   El formato es el de Kick y no uno inventado nuestro:
   `[emote:5747892:collectiblesMEGALUL]` es literalmente lo que
   kick.com mete en el `content` cuando alguien elige un emote de su
   selector, y es lo que hay que mandarle a `POST /public/v1/chat`
   para que salga dibujado.

   POR QUE LA CAJA GUARDA EL FORMATO DE KICK Y NO UNA MARCA INVENTADA

   Porque el servidor tiene que saber sacarlo IGUAL. Hoy, sin nada de
   esto, cualquiera puede escribir `[emote:1:X]` a mano en la caja y
   con "las dos" eso llega a Twitch como esos corchetes, tal cual. O
   sea que `sinMarcasDeKick()` hay que escribirla de todos modos. Una
   vez que existe, que el selector inserte el formato de Kick no
   agrega ni una linea de servidor; una marca propia —`:nombre:`, o
   lo que fuera— agregaria una tabla de nombre -> id que consultar al
   enviar, con su carrera entre lo que se mide y lo que se manda, y
   con dos emotes distintos que se llamen igual resolviendo al que no
   era. La marca lleva todo lo que hace falta para traducirla y por
   eso la traduccion es una funcion pura.

   Los emotes de 7TV y los nativos de Twitch NO llevan marca: en las
   dos redes viajan como su nombre pelado, que es exactamente lo que
   ya hacen hoy. Solo los de Kick necesitan traduccion. */

/* El mismo patron que `MARCA_EMOTE_KICK` de `mensajes.js`. El nombre
   puede traer cualquier cosa menos un `]`. */
const MARCA_KICK = /\[emote:(\d+):([^\]]*)\]/g;

/** El markup con el que un emote nativo de Kick viaja hacia Kick. */
export const marcaDeKick = (id, nombre) =>
  `[emote:${String(id).replace(/\D/g, '')}:${String(nombre ?? '').replace(/[[\]]/g, '')}]`;

/**
 * El mismo texto pero sin markup de Kick: cada `[emote:id:nombre]`
 * queda como `nombre` pelado.
 *
 * Es lo que se le manda a Twitch. Un emote de Kick no existe en
 * Twitch —menos todavia un coleccionable—, asi que lo mejor que se
 * puede hacer es que se lea la palabra. Mandar los corchetes seria
 * escupirle a la otra comunidad un `[emote:5747892:...]` literal.
 *
 * Un emote sin nombre (`[emote:123:]`) desaparece entero: no hay
 * palabra que dejar. El texto puede quedar vacio y eso NO se arregla
 * aca; lo ataja `envio.porQueNoSePuedeMandar`, que es quien sabe que
 * un mensaje vacio no se manda.
 *
 * ---------------------------------------------------------------
 * POR QUE ES UN BUCLE Y NO UN `replace` SOLO
 *
 * Porque `String.replace` NO vuelve a mirar lo que acaba de escribir,
 * y una pasada sola deja pasar justo lo que esto viene a impedir.
 * Con `[emote:1:[emote:2:AB]]` escrito a mano, el nombre del primero
 * es `[emote:2:AB` (el patron acepta cualquier cosa menos `]`), asi
 * que la unica pasada devuelve `[emote:2:AB]`: markup de Kick VALIDO,
 * camino a Twitch. Verificado, no imaginado.
 *
 * Cerrar el patron para que el nombre tampoco acepte `[` no alcanza:
 * ahi el de adentro es el que matchea y queda `[emote:1:AB]`, que es
 * lo mismo pero al reves.
 *
 * El bucle TERMINA SIEMPRE y no hace falta ponerle un tope arbitrario:
 * cada reemplazo borra por lo menos los 10 caracteres de `[emote:N:]`,
 * asi que cada vuelta que cambia algo acorta el texto de verdad. Con
 * el mensaje topeado en 2000, el peor caso son 200 vueltas sobre un
 * texto que se achica; en la practica es una.
 */
export function sinMarcasDeKick(texto) {
  let antes = String(texto ?? '');
  for (;;) {
    const despues = antes.replace(MARCA_KICK, (_, __, nombre) => nombre);
    if (despues === antes) return despues;
    antes = despues;
  }
}

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
    /* `vinculada` es lo que distingue, de un casillero vacío, "esta red
       no tiene cuenta de 7TV" (true, hay id, el respaldo puede entrar)
       de "el creador ni tiene esta red" (false, no hay a quién
       preguntarle nada). Arranca en `true` porque hasta la primera
       bajada no hay nada confirmado todavía. */
    c = { tabla: new Map(), vence: 0, bajando: null, avisado: '', vinculada: true };
    cache.set(k, c);
  }
  return c;
}

let enVuelo = 0;

/** Borra todo lo cacheado. Para las pruebas y para un apagon de 7TV. */
export function olvidarTodo() {
  cache.clear();
  vistos.clear();
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
  /* Sin red se vencen las dos. Es la forma que quiere un boton de
     "recargar mis emotes": el creador no piensa en redes, piensa en su
     canal. (Antes, sin red, se buscaba la clave `istincho` cuando las
     claves son `istincho/kick`: no vencia nada y no lo decia.) */
  for (const r of red ? [red] : ['kick', 'twitch']) {
    const c = cache.get(clave(slug, r));
    if (c) c.vence = 0;
  }
}

/**
 * Lo que sabe el modulo de un casillero, para mirarlo desde afuera.
 * Sin red, el de los globales. `null` si nunca se consulto.
 *
 * Es de solo lectura y existe para poder comprobar COMO quedo la
 * cache, no solo que devuelve: la diferencia entre "404, este creador
 * no tiene 7TV" (vence a la hora) y "fallo, reintentar" (al minuto) no
 * se puede ver de ninguna otra forma desde afuera, y confundirlas es
 * pasar de ~21 mil pedidos por dia a 1,3 millones.
 */
export function comoEsta(slug, red) {
  const c = cache.get(slug === undefined ? CLAVE_GLOBALES : clave(slug, red));
  return c ? { emotes: c.tabla.size, vence: c.vence, estado: c.avisado } : null;
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

/* `vinculada` dice si HABÍA id para preguntarle a 7TV. En falso es "el
   creador no tiene esta red en la herramienta"; en verdadero (el
   default) es "la tiene, pero 7TV no le conoce cuenta o set", que es
   justo el caso en el que el respaldo de la otra red tiene sentido. */
class ErrorSinCuenta extends Error {
  constructor(mensaje, { vinculada = true } = {}) {
    super(mensaje);
    this.vinculada = vinculada;
  }
}

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
  if (typeof host?.url !== 'string' || !host.url) return null;

  const porNombre = new Map((host.files ?? []).map(f => [f?.name, f]));
  for (const nombre of TAMANOS) {
    const f = porNombre.get(nombre);
    const bytes = Number(f?.size);
    /* Se exige un peso POSITIVO y conocido. Un `size` en 0, ausente o
       negativo no es "liviano", es "no se sabe", y un `-1` colado en
       `bytes > PRESUPUESTO` entraria como si fuera gratis. Si 7TV
       dejara de mandar `size`, el set queda vacio: se ve en el log,
       que pasa a decir "0 emotes". */
    if (!Number.isFinite(bytes) || bytes <= 0 || bytes > PRESUPUESTO) continue;
    /* host.url viene sin esquema ("//cdn.7tv.app/emote/<id>") */
    const base = host.url.startsWith('//') ? 'https:' + host.url : host.url;
    const url = urlSegura(`${base}/${nombre}`);
    if (url) return { id: String(emote?.id ?? '').slice(0, TOPE_ID), url };
  }
  return null;
}

/* Cuanto puede medir el id y la URL de un emote. Son de un tercero y
   viajan en cada mensaje a cada pestaña abierta. */
const TOPE_ID = 64;
const TOPE_URL = 300;

/**
 * La URL tal como se la va a mandar al navegador, o '' si no se la
 * puede mandar.
 *
 * Esto termina en el `src` de un `<img>` en la pantalla de cada
 * espectador, y lo arma un servicio de terceros. No es un XSS —un
 * `javascript:` en un `src` de imagen no se ejecuta—, pero el estandar
 * de la casa es no confiar: es el mismo motivo por el que
 * `colorSeguro()` valida el color del chat en el servidor ademas de en
 * la pagina. Verificado que sin esto pasan `javascript:`, `data:` y
 * `http:`.
 *
 * Se ancla al dominio de 7TV y no al host exacto (`cdn.7tv.app`) para
 * que un cambio de subdominio de ellos no apague los emotes, pero un
 * `//evil.com/` en la respuesta no llegue a ningun lado.
 */
function urlSegura(candidata) {
  let u;
  try { u = new URL(candidata); } catch { return ''; }
  if (u.protocol !== 'https:') return '';
  if (u.hostname !== '7tv.app' && !u.hostname.endsWith('.7tv.app')) return '';
  return u.href.length <= TOPE_URL ? u.href : '';
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
     "sin cuenta": no se vuelve a intentar por un rato. `vinculada:
     false` es lo que le dice al respaldo que no intente nada: no es
     que esta red no tenga 7TV, es que el creador no la tiene en la
     herramienta. */
  if (!id) throw new ErrorSinCuenta('el creador no tiene vinculada esa red', { vinculada: false });

  const usuario = await pedirJson(`${API}/users/${red}/${encodeURIComponent(id)}`);

  /* LA CASCADA DEL SET, y lo que se sabe de ella.

     Medido el 2026-09-22 contra el servicio real, con el canal de Kick
     del dueño (66 emotes) y con un canal de Twitch: en los dos casos
     el set viene INCRUSTADO en `emote_set` y ninguno de los respaldos
     llega a usarse.

     Los respaldos se dejan igual porque estan copiados del repo
     hermano, donde llevan meses en produccion, y porque una respuesta
     sin `emote_set` es exactamente el caso en que quedarse sin emotes
     seria silencioso. (El comentario que habia antes aca decia lo
     contrario —que en Kick la conexion "suele" quedar sin set—, y eso
     no es lo que se observo.) */
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
   que la gente ya ve.

   Y pesan poco: 45 emotes, mediana 4,5 KB en 2x y 852 KB el set
   entero. Medido el 2026-09-22 contra `7tv.io/v3/emote-sets/global`;
   esta tambien en el README, al lado de los numeros del set del
   canal. */
async function bajarGlobales() {
  return tablaDelSet(await pedirJson(`${API}/emote-sets/global`));
}

/* ------------------------------------------------------------ bajada */

/**
 * La promesa, pero con fecha de vencimiento.
 *
 * Existe por lo que dice el comentario de `PLAZO`: hay eslabones de la
 * bajada que no tienen timeout propio y pueden quedarse colgados para
 * siempre. Una promesa colgada se lleva puesto un lugar del tope de
 * concurrencia, y seis se llevan puesto el modulo entero.
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
    /* No se encola: se reintenta con el proximo mensaje. Pero se avisa,
       porque si el tope se queda lleno 7TV esta apagado para todos y
       sin esta linea no se notaria. */
    const ahora = Date.now();
    if (ahora - ultimoAvisoTope > AVISO_TOPE) {
      ultimoAvisoTope = ahora;
      console.warn(`[7tv] ${enVuelo} bajadas en vuelo y no entran mas; ${etiqueta} espera al proximo mensaje`);
    }
    return;
  }

  enVuelo++;
  /* `Promise.resolve().then(como)` y no `como()`: asi una excepcion
     sincrona tambien cae en el `.catch` de abajo. Sin esto, el dia que
     `como` tire sincronico, el contador se fuga Y la excepcion sale por
     `resolver()` hasta el webhook.
     `conPlazo` es lo que garantiza que el `.finally` SIEMPRE corra. */
  c.bajando = conPlazo(Promise.resolve().then(como), PLAZO)
    .then(t => {
      c.tabla = t;
      c.vence = Date.now() + CADUCA;
      /* Se llegó hasta acá con un id de verdad (bajarSet lo exige antes
         de pedir nada), así que la red está vinculada aunque el set
         haya salido vacío (el caso de "usuario sin emote_set"). */
      c.vinculada = true;
      avisar(c, `ok:${t.size}`, `[7tv] ${etiqueta}: ${t.size} emote${t.size === 1 ? '' : 's'}`);
    })
    .catch(e => {
      if (e instanceof ErrorSinCuenta) {
        /* El caso de la mayoria. Se deja la tabla vacia y se calla. */
        c.tabla = new Map();
        c.vence = Date.now() + SIN_CUENTA;
        c.vinculada = e.vinculada;
        avisar(c, 'sin-cuenta', `[7tv] ${etiqueta}: sin set de 7TV`);
        return;
      }
      /* NO se pisa `c.tabla`: si habia una que funcionaba, se sigue
         sirviendo aunque este vencida. Tampoco se toca `vinculada`: un
         fallo de verdad no dice nada sobre si la red está vinculada. */
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

const redOpuesta = red => (red === 'kick' ? 'twitch' : 'kick');

/**
 * La tabla de un creador en una red, con el respaldo de su OTRA red
 * cuando ésta no tiene set propio (ver el comentario de `RESPALDO_7TV`).
 *
 * Sincrona como `tabla()`, y por el mismo motivo: nunca espera, se lleva
 * lo que haya cacheado ahora mismo y deja agendada cualquier bajada que
 * falte.
 */
function tablaConRespaldo(slug, red) {
  const propia = tabla(slug, red);
  if (propia.size > 0 || !RESPALDO_7TV) return propia;
  if (red !== 'kick' && red !== 'twitch') return propia;

  const c = casillero(clave(slug, red));
  /* Todavía no se sabe (recién se agendó o está bajando) o fue un
     fallo de verdad (timeout, 500): en ninguno de los dos casos está
     CONFIRMADO que la red no tenga set propio, así que no hay que
     adivinar pidiendo el respaldo de arriba. */
  const confirmadoVacio = c.avisado === 'sin-cuenta' || c.avisado.startsWith('ok:');
  if (!confirmadoVacio || !c.vinculada) return propia;

  return tabla(slug, redOpuesta(red));
}

/* ============================================================
   LOS EMOTES DE KICK QUE ESTE CHAT VIO PASAR

   PARA QUE: el selector de la caja de escribir tiene que ofrecer
   emotes de Kick, y no hay de donde sacar la lista.

   VERIFICADO EL 2026-09-23, y no es una suposicion: la doc entera de
   Kick (`docs.kick.com/llms-full.txt`) no tiene UN endpoint de
   emotes; la palabra aparece solo adentro del payload de ejemplo de
   `chat.message.sent`. Hay un pedido formal de la comunidad abierto y
   sin contestar desde diciembre de 2025 (KickDevDocs#323). Los
   coleccionables no se listan por ningun lado. Y el unico que
   enumera los emotes de un canal, `kick.com/emotes/<slug>`, no esta
   documentado: los terminos de dev.kick.com dicen que uno "will only
   access Program Materials documented on the Kick Developer Site", o
   sea que usarlo nos pone del lado equivocado del acuerdo del dueño.

   ASI QUE LA LISTA SE ARMA SOLA, con lo que pasa por el chat. Cada
   mensaje de Kick ya trae sus emotes resueltos (id, nombre y url,
   sacados del `[emote:id:nombre]` del `content`), asi que anotarlos
   no le cuesta un pedido a nadie. Es una lista VIVA: crece con lo que
   la comunidad usa, incluye coleccionables —que no se pueden listar
   de ninguna otra forma— y arranca vacia.

   LO QUE ESTO NO ES: no es el set del canal. Un emote que nadie uso
   desde que arranco el proceso no esta. Es una limitacion honesta y
   la pagina la dice con todas las letras, en vez de aparentar un
   catalogo completo.

   ---------------------------------------------------------------
   POR QUE CADUCA A LAS 12 HORAS, Y NO ES UN NUMERO AL AZAR

   Los terminos de dev.kick.com permiten guardar su contenido
   "for only a twenty-four hour time period without further sharing
   it with third parties". Doce horas entra con margen, no depende de
   que el proceso se reinicie seguido para cumplir, y es mas o menos
   un ciclo de stream: lo que se uso anoche sigue a mano hoy.

   Nada de esto se persiste: vive en memoria y muere con el proceso.
   Un JSON de emotes de Kick versionado en el repo seria una copia
   permanente Y una redistribucion, y los terminos prohiben las dos
   cosas ("Re-syndication and re-distribution of Program Materials or
   data as available from a Kick API is prohibited").

   ---------------------------------------------------------------
   LO QUE OCUPA, con la cuenta hecha

   Cada emote son ~150 bytes (id, nombre, url y una fecha). Con 100
   por sala y 300 salas a la vez, el techo es ~4,5 MB, y para llegar
   ahi hacen falta 300 chats vivos con 100 emotes distintos cada uno.
   Las salas se desalojan por la MAS VIEJA (la que hace mas que no ve
   un emote), asi que lo que se tira es siempre un chat dormido. */

export const TOPE_EMOTES_VISTOS = 100;
export const TOPE_SALAS_VISTAS = 300;
export const CADUCA_VISTOS = 12 * 60 * 60 * 1000;

/* slug -> Map(clave -> { id, nombre, url, visto }).
   La clave es `id|nombre` y no el id solo: un coleccionable cambia de
   nombre entre temporadas y las dos formas son mandables. */
const vistos = new Map();

const claveEmote = (id, nombre) => `${id}|${nombre}`;

/* Cuanto puede medir el nombre de un emote de Kick que se guarda.
   Sale del `[emote:id:nombre]` de un mensaje, o sea de texto que
   escribio cualquiera: sin tope, un solo mensaje podria guardar 2000
   caracteres de nombre y mandarselos al selector de todo el mundo. */
const TOPE_NOMBRE = 80;

/**
 * La url de un emote de Kick tal como se la va a guardar, o '' si no
 * se la puede guardar.
 *
 * Mismo criterio que `urlSegura` con 7TV: esto termina en el `src` de
 * un `<img>` en la pantalla de cada espectador. Hoy la arma
 * `mensajes.js` a partir de un id de solo digitos, asi que no puede
 * venir mal; pero `resolver()` es una entrada EXPORTADA y lo que se
 * guarda aca se le sirve a todo el mundo por una ruta publica. No se
 * confia, y listo.
 */
function urlDeKickSegura(candidata) {
  let u;
  try { u = new URL(String(candidata ?? '')); } catch { return ''; }
  if (u.protocol !== 'https:') return '';
  if (u.hostname !== 'kick.com' && !u.hostname.endsWith('.kick.com')) return '';
  return u.href.length <= TOPE_URL ? u.href : '';
}

/**
 * Anota los emotes NATIVOS DE KICK de un mensaje que acaba de pasar.
 *
 * Lo llama `resolver()`, que ya corre en todos los mensajes de las
 * dos redes: asi esto no agrega un solo punto de llamada nuevo ni
 * obliga a tocar `chat.js`.
 *
 * El nombre sale del texto, no del emote: `partirTextoDeKick()` ya
 * reemplazo el `[emote:id:nombre]` por el nombre pelado, asi que el
 * tramo `[inicio, fin)` ES el nombre. Se corta por PUNTOS DE CODIGO
 * por el mismo motivo que todo lo demas.
 */
function anotarVistos(mensaje, slug) {
  if (!mensaje || mensaje.tipo !== 'chat' || mensaje.red !== 'kick') return;
  const nativos = (Array.isArray(mensaje.emotes) ? mensaje.emotes : [])
    .filter(e => e?.fuente === 'kick' && e?.id && e?.url);
  if (!nativos.length) return;

  const sala = String(slug ?? '').toLowerCase();
  if (!sala) return;

  const puntos = [...String(mensaje.texto ?? '')];
  const ahora = Date.now();

  let m = vistos.get(sala);
  /* delete + set aunque ya exista: en un Map el orden es el de
     insercion, asi que reponerla la manda al final y el desalojo de
     abajo saca siempre la sala que hace mas que no se usa. */
  if (m) vistos.delete(sala); else m = new Map();
  vistos.set(sala, m);

  for (const e of nativos) {
    const inicio = Number(e.inicio);
    const fin = Number(e.fin);
    /* Un rango con NaN o dado vuelta no es un emote: `slice` con eso
       devuelve cualquier cosa, y "cualquier cosa" seria el nombre que
       despues se le ofrece a todo el mundo. */
    if (!Number.isFinite(inicio) || !Number.isFinite(fin) || fin <= inicio) continue;

    const url = urlDeKickSegura(e.url);
    if (!url) continue;

    /* El id entra en un `[emote:<id>:` , asi que tiene que ser lo que
       Kick pone ahi: digitos y nada mas. */
    const id = String(e.id).replace(/\D/g, '');
    if (!id) continue;

    const nombre = puntos.slice(inicio, fin).join('').slice(0, TOPE_NOMBRE);
    /* Sin nombre no hay que mostrar ni que buscar; con corchetes, la
       marca que se arme despues no se podria volver a leer. */
    if (!nombre || nombre.includes('[') || nombre.includes(']')) continue;

    const k = claveEmote(id, nombre);
    m.delete(k);
    m.set(k, { id, nombre, url, visto: ahora });
    if (m.size > TOPE_EMOTES_VISTOS) m.delete(m.keys().next().value);
  }

  while (vistos.size > TOPE_SALAS_VISTAS) vistos.delete(vistos.keys().next().value);
}

/**
 * Los emotes de Kick que esta sala vio pasar, del mas reciente al mas
 * viejo y sin los que ya caducaron.
 */
export function emotesDeKickVistos(slug) {
  const m = vistos.get(String(slug ?? '').toLowerCase());
  if (!m) return [];
  const corte = Date.now() - CADUCA_VISTOS;
  const salida = [];
  for (const [k, e] of m) {
    /* Se borra al leer: sin esto un chat que se apago deja su lista
       ocupando lugar hasta que alguien vuelva a escribir ahi. */
    if (e.visto <= corte) { m.delete(k); continue; }
    salida.push(e);
  }
  return salida.reverse();
}

/* ------------------------------------------------------- catalogo

   Lo que el selector de la caja de escribir ofrece, ya mezclado y ya
   sabiendo a que red puede ir cada cosa.

   CADA EMOTE DICE SU `marca`: lo que hay que poner en la caja. La
   pagina no arma markup de Kick por su cuenta —el formato vive en un
   solo lado, arriba en este archivo— y asi el dia que cambie, cambia
   aca y nada mas.

   Y CADA EMOTE DICE EN QUE REDES SALE:
     - 7TV viaja como su nombre pelado, igual en las dos redes.
     - un nativo de Kick solo existe en Kick: en Twitch, lo mejor que
       se puede hacer es que se lea la palabra (ver `sinMarcasDeKick`).

   LOS NATIVOS DE TWITCH TODAVIA NO ESTAN, y es a proposito, no un
   olvido. `GET helix/chat/emotes` y `/emotes/global` los dan con un
   app access token y SIN NINGUN SCOPE (verificado el 2026-09-23 en
   dev.twitch.tv/docs/api/reference): o sea que se pueden sumar sin
   pedirle un permiso nuevo a nadie. Lo que falta es de donde sacar
   el app token, y eso esta escribiendose en `twitch.js` en este mismo
   momento por otro camino (las insignias). Sumarlo ahora seria
   escribir dos veces la misma credencial. Queda anotado en el README
   con la forma exacta que tiene que tener. */

/**
 * El catalogo de emotes de una sala para las redes que se pidan.
 *
 * Sincrono, como `tabla()` y por el mismo motivo: devuelve lo que hay
 * AHORA y deja agendada cualquier bajada que falte. La primera vez
 * puede venir corto; la siguiente ya no.
 *
 * @param {string} slug
 * @param {string[]} redes  a que redes va a poder mandar quien pregunta
 */
export function catalogo(slug, redes) {
  const pedidas = ['kick', 'twitch'].filter(r => redes?.includes?.(r));
  if (!slug || !pedidas.length) return [];

  const salida = [];
  const puestos = new Set();

  /* Los nativos de Kick van PRIMERO: son los que no se pueden buscar
     en ningun otro lado, y con dos emotes del mismo nombre el de la
     casa le gana al de 7TV (el mismo criterio que usa `conEmotes`
     para pintar). */
  if (pedidas.includes('kick')) {
    for (const e of emotesDeKickVistos(slug)) {
      if (puestos.has(e.nombre)) continue;
      puestos.add(e.nombre);
      salida.push({
        nombre: e.nombre,
        url: e.url,
        fuente: 'kick',
        marca: marcaDeKick(e.id, e.nombre),
        redes: ['kick'],
      });
    }
  }

  /* 7TV: el set del canal de cada red pedida y despues los globales.
     Se piden las tablas de TODAS las redes pedidas porque un creador
     puede tener set en una sola; `tablaConRespaldo` ya sabe cubrir a
     la que no tiene. */
  const de7TV = new Map();
  for (const red of pedidas) {
    for (const [nombre, img] of tablaConRespaldo(slug, red)) {
      if (!de7TV.has(nombre)) de7TV.set(nombre, img);
    }
  }
  for (const [nombre, img] of globales()) {
    if (!de7TV.has(nombre)) de7TV.set(nombre, img);
  }

  for (const [nombre, img] of de7TV) {
    if (puestos.has(nombre)) continue;
    puestos.add(nombre);
    /* Un emote de 7TV es su nombre pelado, asi que sale en las dos
       redes: en la nuestra lo resuelve `conEmotes`, y en kick.com o
       twitch.tv lo ve quien tenga la extension puesta. Exactamente
       lo que pasa hoy cuando alguien lo escribe a mano. */
    salida.push({ nombre, url: img.url, fuente: FUENTE, marca: nombre, redes: ['kick', 'twitch'] });
  }

  return salida;
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
  /* ESTO NO PUEDE TIRAR NUNCA. Decora un mensaje; no es el mensaje.
     `recibirDeKick` corre adentro de `procesarEvento`, DESPUES de que
     el evento quedo marcado como visto y sin try alrededor: una
     excepcion aca no seria un emote que falta, seria el mensaje
     perdido y un 500 en el webhook de Kick. El catch avisa como mucho
     una vez por minuto, porque si algo lo dispara lo va a disparar en
     todos los mensajes. */
  /* DOS INTENTOS SEPARADOS Y NO UNO. Anotar los emotes de Kick que
     pasaron (para el selector) y pintar los de 7TV son dos trabajos
     distintos: que se rompa el primero no puede dejar al mensaje sin
     los emotes que si sabe resolver, y al reves tampoco.

     El primero va FUERA del `if (!ACTIVO)` de `conEmotes` a
     proposito: los nativos de Kick no tienen nada que ver con 7TV, y
     apagar 7TV no tiene por que apagar el selector. */
  try {
    anotarVistos(mensaje, slug);
  } catch (e) {
    avisarFalla('no se pudo anotar un emote de Kick', e);
  }

  try {
    return conEmotes(mensaje, slug);
  } catch (e) {
    avisarFalla('no se pudo resolver un mensaje', e);
    return mensaje;
  }
}

let ultimoAvisoFalla = 0;

/* Como mucho un aviso por minuto: si algo dispara esto, lo va a
   disparar en TODOS los mensajes. */
function avisarFalla(que, e) {
  const ahora = Date.now();
  if (ahora - ultimoAvisoFalla <= AVISO_TOPE) return;
  ultimoAvisoFalla = ahora;
  console.warn(`[emotes] ${que}:`, e?.message ?? e?.name ?? 'Error');
}

function conEmotes(mensaje, slug) {
  if (!ACTIVO || !mensaje || mensaje.tipo !== 'chat') return mensaje;
  /* String() y no `?? ''`: el texto de los tres traductores siempre es
     string, pero `resolver` es una entrada exportada y `[...]` sobre
     algo que no lo sea revienta. */
  const texto = String(mensaje.texto ?? '');
  if (!texto) return mensaje;

  const delCanal = tablaConRespaldo(slug, mensaje.red);
  const comunes = globales();
  if (!delCanal.size && !comunes.size) return mensaje;

  const nativos = Array.isArray(mensaje.emotes) ? mensaje.emotes : [];
  /* Copia ordenada y SANEADA: se recorre con un puntero que va para
     adelante, y basta un rango con NaN para que el puntero se clave y
     deje pasar por encima de todos los nativos que vengan despues. Un
     rango de largo cero es peor todavia: el `<=` de abajo lo da por
     superado y se dibujarian dos <img> en el mismo lugar.
     Los tres traductores entregan rangos sanos y ordenados; esto es
     para que la propiedad no dependa de eso. */
  const ocupados = nativos
    .map(e => [Number(e?.inicio), Number(e?.fin)])
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b > a)
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
  /* El `?? 0` no es cosmetico: si `nativos` trae basura, el que tira al
     comparar es ESTE sort, y seria `resolver` el que rompe el mensaje.
     Lo que venga mal sigue viniendo mal, pero no por culpa nuestra. */
  mensaje.emotes = [...nativos, ...hallados]
    .sort((a, b) => (Number(a?.inicio) || 0) - (Number(b?.inicio) || 0));
  return mensaje;
}
