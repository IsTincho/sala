/* ============================================================
   Los creadores: quien tiene una Sala, con que plan, y a que canal
   de Kick corresponde cada cosa que llega.

   Este modulo es el indice del servicio multi-inquilino. Todo lo que
   antes preguntaba "¿es el dueño?" pregunta ahora "¿de que sala es
   esto?", y la respuesta sale de aca.

   ---------------------------------------------------------------
   EL DUEÑO NO SALE DE LA BASE

   Quien es el dueño del SERVICIO lo dice `KICK_SLUG`, una variable de
   entorno, y no un campo de un documento. Es la regla de la casa
   ("login identifica, no autoriza") llevada un paso mas: si el plan
   del dueño saliera de `creadores`, alguien con escritura en Mongo
   podria degradarlo, y peor, un bug de escritura podria hacerlo sin
   que nadie lo intentara.

   Por eso `planDe()` contesta 'dueno' comparando el slug, ANTES de
   mirar el documento, y `existe()` contesta true para el dueño sin
   tocar el almacen. Esa segunda parte no es solo seguridad: es lo que
   hace que la Sala del dueño funcione con la coleccion vacia, que es
   como esta hoy y como va a estar el primer dia de produccion.

   El dueño igual tiene su fila en `creadores` (la escribe su login de
   Kick) porque el indice inverso broadcaster_user_id -> slug la
   necesita y porque /admin lo tiene que listar. Lo que nunca se lee de
   esa fila es su plan.

   ---------------------------------------------------------------
   POR QUE HAY CACHE, Y POR QUE TIENE TOPE

   `canalPermitido()` corre en cada `/eventos/:slug`, o sea una vez por
   pestaña abierta. Con la coleccion vacia eso cortocircuitaba; con mil
   creadores en Mongo es una consulta por conexion, y cuando arranca la
   pelicula entran de a decenas. Va una cache de 5 segundos.

   La cache guarda TAMBIEN los que no existen. Sin eso, `/eventos/`
   con un slug inventado distinto cada vez sigue siendo una consulta a
   Mongo por pedido, o sea un modo barato de voltear el servicio, que
   es justo lo que `canalPermitido` vino a cerrar. Y por eso mismo el
   Map tiene tope: una cache negativa sin tope es el mismo problema
   corrido un casillero, con la memoria en vez de la base.

   5 segundos es corto a proposito, pero lo que hace que /admin se
   sienta instantaneo no es el TTL sino que cada escritura invalida su
   propia entrada.
   ============================================================ */

import * as almacen from './almacen.js';

/* Los cuatro planes de un creador. El del dueño no esta en la lista a
   proposito: no es un plan que se pueda poner, es una consecuencia de
   KICK_SLUG. */
export const PLANES = ['pendiente', 'amigo', 'pago', 'vencido'];

/* Los unicos que puede poner el dueño desde /admin. "pago" y "vencido"
   los pone el webhook de cobro y nadie mas: si el dueño pudiera poner
   "pago" a mano, el estado de la base y el del proveedor se irian
   separando y no habria forma de saber cual manda. */
export const PLANES_A_MANO = ['amigo', 'pendiente'];

/* Los que dejan reproducir. "pendiente" es el que acaba de darse de
   alta y todavia no arreglo con nadie; "vencido" es el que dejo de
   pagar. Los dos ven su panel, en modo solo lectura. */
export const PLANES_ACTIVOS = ['dueno', 'amigo', 'pago'];

export const PLAN_DUENO = 'dueno';

/* La version del texto de /terminos que se acepta al crear la sala. Si
   el texto cambia de fondo, sube este numero y se le vuelve a pedir a
   los creadores. Se guarda junto con la fecha. */
export const TERMINOS_VERSION = '1';

/* El tope de canales con suscripcion a chat.message.sent.

   Kick permite 1.000 por app NO VERIFICADA, y ese tope es de canales,
   no de mensajes (docs.kick.com/events/subscribe-to-events). Se corta
   en 900 para dejar aire: llegar al tope significa que las
   suscripciones nuevas fallan y el chat de los que entren queda mudo
   sin que nada lo explique. Antes de los 500 hay que pedirle a Kick la
   verificacion de la app (PLAN.md, seccion 5).

   Es una variable para que las pruebas puedan bajarlo: no es un
   secreto y no cambia nada si alguien lo mira. */
export const TOPE_CANALES = Number(process.env.TOPE_CANALES ?? 900);

/* Cuantos GB puede tener cada plan en R2. El bucket gratis son 10 GB
   EN TOTAL, asi que la suma de lo que se reparte aca es lo que de
   verdad se puede regalar; pasado eso son USD 0,015 por GB por mes y
   es el primer gasto real del proyecto. Por eso los numeros son chicos
   y salen de variables: el dia que el dueño decida gastar, se cambian
   sin tocar codigo.

   El dueño no tiene tope: su bucket es. */
export const GB_POR_PLAN = {
  dueno: Infinity,
  amigo: Number(process.env.GB_AMIGO ?? 2),
  pago: Number(process.env.GB_PAGO ?? 5),
  pendiente: 0,
  vencido: 0,
};

const SLUG_DUENO = (process.env.KICK_SLUG ?? '').toLowerCase();

/* El mismo que valida `videos.js`. Se repite el literal en vez de
   importarlo para que este modulo no dependa del catalogo: son dos
   cosas que casualmente coinciden, no la misma. Si alguna vez dejan de
   coincidir, hay pruebas de los dos lados. */
const SLUG_VALIDO = /^[a-z0-9][a-z0-9_-]{0,49}$/;

export const slugValido = s => SLUG_VALIDO.test(String(s ?? ''));

export const normalizar = s => String(s ?? '').trim().toLowerCase();

/** Si este slug es el del dueño del SERVICIO (no el de una sala). */
export const esDueno = slug => Boolean(SLUG_DUENO) && normalizar(slug) === SLUG_DUENO;

export const slugDelDueno = () => SLUG_DUENO;

/* --------------------------------------------------------- cache */

const CACHE_MS = 5000;

/* Tope del Map. Cada entrada es chica; 5.000 slugs distintos en 5
   segundos ya es trafico que no existe. Se sueltan los mas viejos
   (Map conserva el orden de insercion). */
const TOPE_CACHE = 5000;

const cache = new Map();      // slug -> { doc, hasta }

function guardarEnCache(slug, doc) {
  cache.delete(slug);         // que vuelva al final del orden
  cache.set(slug, { doc, hasta: Date.now() + CACHE_MS });
  while (cache.size > TOPE_CACHE) cache.delete(cache.keys().next().value);
  return doc;
}

/** Saca a este creador de la cache. La llama toda escritura. */
export function invalidar(slug) {
  cache.delete(normalizar(slug));
}

/** Solo para los tests y para /admin despues de escribir en lote. */
export function olvidarCache() {
  cache.clear();
  indice = null;
  indiceHasta = 0;
}

/* ------------------------------------------------- indice inverso

   broadcaster_user_id -> slug. Lo necesita el webhook: el payload de
   Kick dice de que canal es el mensaje con un numero, y hay que saber
   en que sala difundirlo.

   Vive en memoria y se rearma entero cada minuto (una consulta que
   devuelve como mucho 900 documentos chicos) y cada vez que se escribe
   un creador. Con una sola instancia en Railway alcanza; el dia que
   haya dos, cada una tendria su copia y una alta hecha en la otra
   tardaria hasta un minuto en aparecer. Esta anotado en la bitacora.

   OJO: quien resuelve por aca NO puede confiar en el resultado sin
   mas. Una entrada vieja podria apuntar a un creador ya borrado, asi
   que `porBroadcaster` devuelve el slug y el que lo usa vuelve a pasar
   por `obtener`. */

const INDICE_MS = 60_000;

let indice = null;            // Map usuarioId -> slug
let indiceHasta = 0;
let armando = null;           // promesa del armado en curso

async function elIndice() {
  if (indice && Date.now() < indiceHasta) return indice;
  /* Sin esto, treinta mensajes de chat que llegan juntos con el indice
     recien vencido salen los treinta a listar la coleccion. */
  if (!armando) {
    armando = (async () => {
      const nuevo = new Map();
      for (const doc of await almacen.listar('creadores')) {
        const id = String(doc?.usuarioId ?? '');
        if (id) nuevo.set(id, String(doc.id ?? doc.slug ?? ''));
      }
      indice = nuevo;
      indiceHasta = Date.now() + INDICE_MS;
      return indice;
    })().finally(() => { armando = null; });
  }
  return armando;
}

/**
 * De que sala es este broadcaster_user_id de Kick, o '' si de ninguna.
 *
 * El que lo llama tiene que comprobar despues que la sala exista: esto
 * sale de un indice en memoria que puede tener hasta un minuto.
 */
export async function porBroadcaster(usuarioId) {
  const id = String(usuarioId ?? '');
  if (!id) return '';
  return (await elIndice()).get(id) ?? '';
}

/**
 * De que sala es un evento de Kick ya verificado, o '' si de ninguna.
 *
 * ES LA PUERTA DEL WEBHOOK, y por eso esta escrita al reves de como
 * estaba: antes se sacaba el slug del payload y se difundia; ahora se
 * saca el slug del payload y se DESCARTA lo que no se pueda atribuir a
 * una sala que existe. `canales.recordar` crea el canal del bus que no
 * exista, asi que sin este filtro un payload puede fabricar canales con
 * el nombre que quiera, salteando el `canalPermitido` que /eventos/:slug
 * exige del otro lado. Con un solo canal eso era inocuo; con varios es
 * el chat de un creador cayendo en la sala de otro.
 *
 * Se prueba primero `broadcaster.user_id` y despues `channel_slug`. Los
 * dos viajan ADENTRO del cuerpo que Kick firmo con RSA, asi que los dos
 * son igual de autenticos y no hay ninguno "mas seguro". Se prefiere el
 * numero porque es el que no cambia: un streamer que se renombra en
 * Kick cambia de slug y su sala seguiria siendo la misma. El
 * `channel_slug` queda de respaldo para los eventos que no traigan el
 * id (hoy los traen todos, pero el payload lo elige Kick).
 */
export async function salaDelEvento(cuerpo) {
  const id = cuerpo?.broadcaster?.user_id;
  if (id !== undefined && id !== null && String(id) !== '') {
    const s = await porBroadcaster(id);
    /* El indice puede tener hasta un minuto: se vuelve a comprobar
       contra el almacen antes de creerle. */
    if (s && await existe(s)) return s;
  }
  const porSlug = normalizar(cuerpo?.broadcaster?.channel_slug);
  if (porSlug && await existe(porSlug)) return porSlug;
  return '';
}

/* -------------------------------------------------------- lectura */

/** El documento de un creador, o null. Pasa por la cache. */
export async function obtener(slug) {
  const s = normalizar(slug);
  if (!slugValido(s)) return null;

  const guardado = cache.get(s);
  if (guardado && Date.now() < guardado.hasta) return guardado.doc;

  let doc = null;
  try {
    doc = await almacen.obtener('creadores', s);
  } catch (e) {
    /* Si el almacen no contesta no se inventa nada, y TAMPOCO se
       cachea el "no existe": una caida de Mongo de un segundo dejaria
       cinco segundos de salas que no existen. */
    console.warn('[creadores] no se pudo leer el creador:', e.name);
    return null;
  }
  return guardarEnCache(s, doc);
}

/**
 * Si este slug puede tener una sala.
 *
 * El dueño pasa sin tocar el almacen. Es lo que hace que su Sala
 * funcione con la coleccion vacia.
 */
export async function existe(slug) {
  const s = normalizar(slug);
  if (!s || !slugValido(s)) return false;
  if (esDueno(s)) return true;
  return Boolean(await obtener(s));
}

/**
 * El plan que vale AHORA para esta sala.
 *
 * El dueño es 'dueno' y eso no sale de la base. Para el resto, sale
 * del documento con una correccion: un vencimiento que ya paso cuenta
 * como vencido aunque el campo `plan` siga diciendo otra cosa.
 *
 * Esa correccion existe porque el webhook de cobro es la unica cosa
 * del sistema que llega de afuera y puede no llegar. Si el proveedor
 * no avisa —se cayo, cambiamos la clave, se desconfiguro la
 * notificacion—, el plan tiene que caer solo. Lo contrario (seguir
 * dando el servicio hasta que alguien mire) es el error que no se
 * descubre nunca.
 */
export function planDelDoc(slug, doc, ahora = Date.now()) {
  if (esDueno(slug)) return PLAN_DUENO;
  if (!doc) return '';
  const plan = PLANES.includes(doc.plan) ? doc.plan : 'pendiente';
  const vence = Number(doc.vence ?? 0);
  if (plan !== 'pendiente' && vence > 0 && vence < ahora) return 'vencido';
  return plan;
}

/** El plan de una sala, leyendo el documento. '' si la sala no existe. */
export async function planDe(slug, ahora = Date.now()) {
  if (esDueno(slug)) return PLAN_DUENO;
  return planDelDoc(slug, await obtener(slug), ahora);
}

/** Si el plan de esta sala deja reproducir una pelicula. */
export const planActivo = plan => PLANES_ACTIVOS.includes(plan);

export async function puedeReproducir(slug, ahora = Date.now()) {
  return planActivo(await planDe(slug, ahora));
}

/** Los GB que le tocan a un plan. */
export const topeGb = plan => GB_POR_PLAN[plan] ?? 0;

/* -------------------------------------------------------- escritura */

const aCreador = doc => (doc ? {
  slug: String(doc.id ?? doc.slug ?? ''),
  usuarioId: String(doc.usuarioId ?? ''),
  nombre: String(doc.nombre ?? ''),
  plan: PLANES.includes(doc.plan) ? doc.plan : 'pendiente',
  vence: Number(doc.vence ?? 0),
  creado: Number(doc.creado ?? 0),
  suscrito: Boolean(doc.suscrito),
  terminos: {
    version: String(doc.terminos?.version ?? ''),
    cuando: Number(doc.terminos?.cuando ?? 0),
  },
  cobro: {
    proveedor: String(doc.cobro?.proveedor ?? ''),
    clienteId: String(doc.cobro?.clienteId ?? ''),
    suscripcionId: String(doc.cobro?.suscripcionId ?? ''),
  },
  bytes: Number(doc.bytes ?? 0),
  bytesAl: Number(doc.bytesAl ?? 0),
} : null);

/** Todos los creadores, para /admin. Del mas nuevo al mas viejo. */
export async function listar() {
  const docs = await almacen.listar('creadores');
  return docs.map(aCreador).filter(Boolean).sort((a, b) => b.creado - a.creado);
}

/** Cuantas salas hay dadas de alta. Es lo que cuenta contra el tope. */
export async function cuantos() {
  return (await almacen.listar('creadores')).length;
}

/**
 * Si entra uno mas.
 *
 * Se cuentan los documentos y no las suscripciones de verdad porque la
 * API de Kick no dice cuantas tiene la app: `listarSuscripciones` es
 * por canal. Cada sala dada de alta pide una suscripcion, asi que el
 * numero de salas es la mejor estimacion que hay de este lado, y va
 * por debajo del tope real justamente porque es una estimacion.
 */
export async function hayLugar() {
  return (await cuantos()) < TOPE_CANALES;
}

async function escribir(slug, cambios) {
  const s = normalizar(slug);
  const anterior = (await almacen.obtener('creadores', s)) ?? {};
  const { id: _sinId, ...viejo } = anterior;
  const doc = { ...viejo, ...cambios, slug: s };
  await almacen.poner('creadores', s, doc);
  invalidar(s);
  /* El indice se actualiza en el acto en vez de invalidarse entero:
     una alta no tiene por que costarle a los siguientes mensajes de
     chat una lectura de toda la coleccion. */
  if (indice && doc.usuarioId) indice.set(String(doc.usuarioId), s);
  return aCreador({ id: s, ...doc });
}

/**
 * Da de alta una sala. Si ya existe, NO le toca el plan ni los
 * terminos: volver a entrar con Kick no puede degradar a un creador
 * que ya estaba, ni "reaceptar" terminos que nadie leyo esta vez.
 */
export async function crear({ slug, usuarioId, nombre, terminos = '' }) {
  const s = normalizar(slug);
  if (!slugValido(s)) throw new Error('slug invalido');

  const ya = await almacen.obtener('creadores', s);
  if (ya) {
    return escribir(s, {
      usuarioId: String(usuarioId ?? ya.usuarioId ?? ''),
      nombre: String(nombre ?? ya.nombre ?? '').slice(0, 80),
    });
  }

  return escribir(s, {
    usuarioId: String(usuarioId ?? ''),
    nombre: String(nombre ?? '').slice(0, 80),
    plan: 'pendiente',
    vence: 0,
    creado: Date.now(),
    suscrito: false,
    terminos: { version: String(terminos ?? ''), cuando: terminos ? Date.now() : 0 },
    cobro: { proveedor: '', clienteId: '', suscripcionId: '' },
    bytes: 0,
    bytesAl: 0,
  });
}

/**
 * Cambia el plan de una sala.
 *
 * `quien` no es decorativo: dice si el cambio viene del dueño (que solo
 * puede poner los de PLANES_A_MANO) o del proveedor de cobro (que solo
 * pone 'pago' y 'vencido'). Que la regla viva aca y no en la ruta es lo
 * que hace que valga tambien para el call site que se escriba manana.
 */
export async function ponerPlan(slug, plan, { vence = 0, quien = 'dueno' } = {}) {
  const s = normalizar(slug);
  if (!PLANES.includes(plan)) throw new Error(`plan desconocido: ${plan}`);
  if (quien === 'dueno' && !PLANES_A_MANO.includes(plan)) {
    throw new Error(`el plan "${plan}" lo pone el proveedor de cobro, no el dueño`);
  }
  if (quien === 'cobro' && PLANES_A_MANO.includes(plan)) {
    throw new Error(`el plan "${plan}" lo pone el dueño, no el proveedor de cobro`);
  }
  if (!await almacen.obtener('creadores', s)) return null;
  return escribir(s, { plan, vence: Math.max(0, Number(vence) || 0) });
}

/** Deja anotado si la suscripcion de eventos de Kick se pudo crear. */
export async function marcarSuscrito(slug, suscrito) {
  if (!await almacen.obtener('creadores', normalizar(slug))) return null;
  return escribir(slug, { suscrito: Boolean(suscrito) });
}

/** Guarda los datos del proveedor de cobro (cliente y suscripcion). */
export async function guardarCobro(slug, { proveedor, clienteId, suscripcionId }) {
  const s = normalizar(slug);
  const doc = await almacen.obtener('creadores', s);
  if (!doc) return null;
  return escribir(s, {
    cobro: {
      proveedor: String(proveedor ?? doc.cobro?.proveedor ?? ''),
      clienteId: String(clienteId ?? doc.cobro?.clienteId ?? ''),
      suscripcionId: String(suscripcionId ?? doc.cobro?.suscripcionId ?? ''),
    },
  });
}

/**
 * Deja anotado cuanto ocupa esta sala en R2.
 *
 * Es una COPIA de lo que dice R2, con la fecha en que se miro, para
 * poder pintar /admin sin salir a listar el bucket de cada creador. La
 * verdad es R2; esto es la ultima foto.
 */
export async function anotarUso(slug, bytes) {
  const s = normalizar(slug);
  if (!await almacen.obtener('creadores', s)) return null;
  return escribir(s, { bytes: Math.max(0, Math.floor(Number(bytes) || 0)), bytesAl: Date.now() });
}

/** Borra una sala del indice. No toca sus videos ni sus tokens. */
export async function borrar(slug) {
  const s = normalizar(slug);
  const habia = await almacen.quitar('creadores', s);
  invalidar(s);
  indice = null;
  indiceHasta = 0;
  return habia;
}
