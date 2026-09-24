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
import { numeroDeEntorno } from './entorno.js';

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
export const TOPE_CANALES = numeroDeEntorno('TOPE_CANALES', 900, { minimo: 0 });

/* Cuantos GB puede tener cada plan en R2. El bucket gratis son 10 GB
   EN TOTAL, asi que la suma de lo que se reparte aca es lo que de
   verdad se puede regalar; pasado eso son USD 0,015 por GB por mes y
   es el primer gasto real del proyecto. Por eso los numeros son chicos
   y salen de variables: el dia que el dueño decida gastar, se cambian
   sin tocar codigo.

   El dueño no tiene tope: su bucket es. */
export const GB_POR_PLAN = {
  dueno: Infinity,
  /* El piso es cero y no uno: `GB_AMIGO=0` es "este plan no sube
     videos", que es algo que alguien puede querer decir de verdad. Lo
     que no puede pasar es que un typo lo deje en NaN, porque
     `usado > NaN` es false y ahi el tope no existe. */
  amigo: numeroDeEntorno('GB_AMIGO', 2, { minimo: 0 }),
  pago: numeroDeEntorno('GB_PAGO', 5, { minimo: 0 }),
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

/* Los dos numeros salen exportados porque los dos tienen prueba, y una
   prueba que los repita a mano deja de probar el codigo el dia que
   alguien cambie uno aca. */
export const CACHE_MS = 5000;

/* Tope del Map. Cada entrada es chica; 5.000 slugs distintos en 5
   segundos ya es trafico que no existe. Se sueltan los mas viejos
   (Map conserva el orden de insercion). */
export const TOPE_CACHE = 5000;

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
  /* La del chat abierto tambien: es lo que simula un reinicio del
     proceso en las pruebas, y un reinicio la pierde. */
  chatEnMemoria.clear();
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
  /* El interruptor de la Sala (ver mas abajo). Sale aca porque /admin
     lo lista y lo toca: el dueño del servicio tiene que poder ver de un
     vistazo a quien le prendio la pelicula. */
  salaAbierta: Boolean(doc.salaAbierta),
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

/*
 * TODA escritura sobre el documento de un creador pasa por aca, y por
 * UNA SOLA COLA por creador.
 *
 * `poner` reemplaza el documento entero —el almacen no sabe actualizar
 * un campo suelto—, asi que esto es leer-cambiar-guardar: sin cola, el
 * segundo lee antes de que el primero guarde y al guardar lo borra.
 *
 * NO ES TEORICO, Y NO ES RARO. La cola vivia un piso mas arriba, en
 * `ponerChatAbierto` y `ponerSalaAbierta`, asi que solo protegia a esas
 * dos entre si. Todo lo demas —el plan, el uso de R2, la suscripcion,
 * el alta, el webhook de cobro— escribia por afuera. Medido con el
 * backend de archivo, 20 de 20 veces: prender la Sala de alguien desde
 * /admin justo cuando entra su pago perdia EL PLAN PAGADO, en silencio.
 *
 * `cambios` puede ser un objeto o una FUNCION del documento guardado
 * (`null` si no hay). La funcion es para quien necesita mirar lo que
 * habia antes de decidir que escribe —la lista de bloqueados, el chat
 * abierto, el alta que no puede pisar un plan— porque leerlo afuera y
 * escribirlo adentro es la misma carrera un piso mas arriba.
 *
 * OJO AL LLAMARLA: la funcion corre ADENTRO de la cola de este creador,
 * asi que no puede esperar nada que entre a la misma cola (otro
 * `escribir` del mismo slug) o se espera a si misma para siempre. Se la
 * espera igual (`await cambios(...)`) por si alguna vez es `async`: sin
 * eso, el parche seria una promesa, el spread no aportaria ninguna
 * clave y la escritura quedaria en un no-op silencioso.
 */
async function escribir(slug, cambios) {
  const s = normalizar(slug);
  return almacen.enCola('creadores', s, async () => {
    /* `almacen.obtener` y NO el `obtener` de este modulo, que pasa por
       la cache de 5 segundos: la cola sirve para leer lo ultimo que se
       guardo, y una lectura cacheada seria exactamente la foto vieja
       que esto viene a evitar. */
    const anterior = await almacen.obtener('creadores', s);
    let viejo = null;
    if (anterior) {
      const { id: _sinId, ...resto } = anterior;
      viejo = resto;
    }
    const parche = typeof cambios === 'function' ? await cambios(viejo) : cambios;
    const doc = { ...(viejo ?? {}), ...parche, slug: s };
    await almacen.poner('creadores', s, doc);
    invalidar(s);
    /* El indice se actualiza en el acto en vez de invalidarse entero:
       una alta no tiene por que costarle a los siguientes mensajes de
       chat una lectura de toda la coleccion. */
    if (indice && doc.usuarioId) indice.set(String(doc.usuarioId), s);
    return aCreador({ id: s, ...doc });
  });
}

/**
 * Da de alta una sala. Si ya existe, NO le toca el plan ni los
 * terminos: volver a entrar con Kick no puede degradar a un creador
 * que ya estaba, ni "reaceptar" terminos que nadie leyo esta vez.
 */
export async function crear({ slug, usuarioId, nombre, terminos = '' }) {
  const s = normalizar(slug);
  if (!slugValido(s)) throw new Error('slug invalido');

  /* "¿Ya estaba?" se pregunta ADENTRO de la cola: preguntarlo afuera y
     escribir despues es la carrera que hace que dos logins a la vez
     —o un login mientras entra el pago— le apliquen el alta a alguien
     que ya existia, y le pisen el plan con "pendiente". */
  return escribir(s, ya => (ya ? {
    usuarioId: String(usuarioId ?? ya.usuarioId ?? ''),
    nombre: String(nombre ?? ya.nombre ?? '').slice(0, 80),
    /* Si la fila existe pero NUNCA se anotaron los terminos, este login
       los anota. No es "reaceptar": es la primera vez. Le pasa al dueño
       del servicio, cuya fila puede nacer de un interruptor
       (`ponerSalaAbierta` se la crea) y quedaba sin terminos para
       siempre, porque su login posterior ya la veia existente. Una
       version ya anotada sigue sin pisarse. */
    ...(terminos && !ya.terminos?.version
      ? { terminos: { version: String(terminos), cuando: Date.now() } }
      : {}),
  } : {
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
  }));
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
  if (!await almacen.obtener('creadores', s)) return null;
  /* Lo que no viene queda como estaba, y ese "como estaba" se lee
     adentro de la cola: si no, el webhook que llega mientras se escribe
     otra cosa guarda el cobro viejo encima del nuevo. */
  /* `||` y no `??`: el proveedor manda '' cuando el evento no trae ese
     campo (`cobro-paddle.js` hace `String(datos?.customer_id ?? '')`),
     y con `??` una cadena vacia NO es nullish, asi que un webhook que
     no nombra al cliente le borraba el cliente guardado. Lo que no
     viene queda como estaba, que es lo que esta funcion promete. */
  return escribir(s, doc => ({
    cobro: {
      proveedor: String(proveedor || doc?.cobro?.proveedor || ''),
      clienteId: String(clienteId || doc?.cobro?.clienteId || ''),
      suscripcionId: String(suscripcionId || doc?.cobro?.suscripcionId || ''),
    },
  }));
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
  chatEnMemoria.delete(s);
  indice = null;
  indiceHasta = 0;
  return habia;
}

/* ---------------------------------------------------- chat abierto

   Fase 5.1 (PLAN-MULTICHAT.md). Cada creador puede abrir su Chat
   Global a la comunidad: `/chat/<slug>` muestra las redes que eligio,
   mezcladas y en vivo, a cualquiera y sin login. Cerrado, que es como
   nace, el bus publico de su sala manda solo Kick, como siempre (la
   Sala depende de eso).

   Se guarda en el documento del creador:

     "chatAbierto": { "activo": false, "redes": ["kick", "twitch"] }

   Entra en TODOS los planes, "pendiente" y "vencido" incluidos: no
   cuesta ancho de banda (no hay video) y es lo que hace que un creador
   pruebe la herramienta. Por eso aca no se mira el plan.

   ---------------------------------------------------------------
   POR QUE HAY UNA COPIA EN MEMORIA, Y POR QUE NO VENCE

   El filtro del bus pregunta "¿que redes ve el publico de esta sala?"
   en CADA mensaje y por CADA conexion abierta (`canales.leDaEl`), y
   tiene que contestar sin esperar: un `await` a Mongo por mensaje no
   existe. Asi que la respuesta vive en un Map, se lee del almacen la
   primera vez que alguien la necesita, y despues la cambia solo
   `ponerChatAbierto`.

   No vence como la cache de arriba, a proposito: una cache que vence
   hay que recargarla, y recargar es otra vez un `await` en el camino
   del mensaje. Con una sola instancia en Railway la memoria no se
   desincroniza (la misma nota que el indice inverso); el dia que haya
   dos, esto tambien hay que moverlo.

   La carrera que si hay: alguien se conecta, se lee el valor VIEJO del
   almacen, y en el medio el creador cierra el chat. Se resuelve con una
   regla de dos lineas: la carga solo escribe el Map si todavia esta
   vacio, y la escritura del creador lo pisa siempre. En cualquier
   orden gana la escritura.

   Y si el almacen falla al cargar, no se memoriza nada: se contesta
   "cerrado" por esta vez y el proximo pedido vuelve a intentar. Un
   corte de Mongo de un segundo no puede dejar un chat cerrado (ni
   abierto) hasta el proximo deploy. */

export const REDES_CHAT = Object.freeze(['kick', 'twitch']);

/* Como nace: cerrado, y con las dos redes elegidas para cuando se
   abra. "Las dos" y no "solo Kick" porque la gracia del chat abierto
   es justamente ver Kick y Twitch juntos; si el creador no vinculo
   Twitch, de esa red no llega nada y el panel se lo dice. */
export const CHAT_POR_DEFECTO = Object.freeze({
  activo: false,
  redes: REDES_CHAT,
  bloqueados: Object.freeze([]),
});

/* Tope de la lista de bloqueados. Una lista mas larga que esto no la
   mira nadie, y el ajuste entero viaja en cada pedido al panel. */
export const TOPE_BLOQUEADOS = 200;

/* Un id de una plataforma. Son numericos en las dos, pero se acepta
   cualquier cosa corta y sin caracteres raros: lo que no se acepta es
   que el id salga de un mensaje de chat sin mirarlo. */
const idValido = id => /^[0-9a-zA-Z_-]{1,64}$/.test(String(id ?? ''));

/** Un bloqueado limpio, o null si el pedido no sirve. */
function bloqueadoLimpio(b) {
  if (!REDES_CHAT.includes(b?.red) || !idValido(b?.id)) return null;
  return {
    red: b.red,
    id: String(b.id),
    /* El nombre es SOLO para que el creador reconozca a quien bloqueo:
       no se compara nunca contra nada, porque los nombres se cambian. */
    nombre: String(b.nombre ?? '').slice(0, 80),
    desde: Number(b.desde) || Date.now(),
  };
}

const chatEnMemoria = new Map();   // slug -> { activo, redes } (congelado)

/** Las redes validas de una lista, sin repetir y en el orden de siempre. */
const redesValidas = lista =>
  (Array.isArray(lista) ? REDES_CHAT.filter(r => lista.includes(r)) : []);

/** El ajuste de un documento, completado y limpio. Nunca tira. */
export function chatAbiertoDelDoc(doc) {
  const guardado = doc?.chatAbierto;
  const redes = redesValidas(guardado?.redes);
  const bloqueados = (Array.isArray(guardado?.bloqueados) ? guardado.bloqueados : [])
    .map(bloqueadoLimpio)
    .filter(Boolean)
    .slice(0, TOPE_BLOQUEADOS);
  return Object.freeze({
    activo: guardado?.activo === true,
    redes: Object.freeze(redes.length ? redes : [...REDES_CHAT]),
    bloqueados: Object.freeze(bloqueados),
  });
}

/**
 * Si esta persona esta bloqueada en esta sala, por su id en esa red.
 *
 * Por id y no por nombre: los nombres se cambian, y bloquear un nombre
 * es bloquear a quien lo tenga manana. El bloqueo es de ESTA
 * herramienta: la persona sigue pudiendo escribir desde kick.com o
 * twitch.tv, donde manda la moderacion de cada plataforma.
 */
export const estaBloqueado = (chat, red, id) =>
  (chat?.bloqueados ?? []).some(b => b.red === red && b.id === String(id ?? ''));

/**
 * Lo que se sabe AHORA del chat abierto de esta sala, sin esperar.
 * `undefined` si todavia no se cargo. Es lo que usa el filtro del bus.
 */
export const chatAbiertoSabido = slug => chatEnMemoria.get(normalizar(slug));

/**
 * El chat abierto de una sala. La primera vez lo lee del almacen;
 * despues contesta de memoria.
 *
 * Lee con `almacen.obtener` y no con `obtener` a proposito: la de
 * arriba se traga los errores del almacen y contesta null, que aca es
 * indistinguible de "no tiene documento" (el caso normal del dueño del
 * servicio antes de su primer login). Hay que saber si la lectura
 * fallo para no memorizar un "cerrado" que no es verdad.
 */
export async function chatAbierto(slug) {
  const s = normalizar(slug);
  const sabido = chatEnMemoria.get(s);
  if (sabido) return sabido;

  let doc;
  try {
    doc = await almacen.obtener('creadores', s);
  } catch (e) {
    console.warn(`[creadores] ${s}: no se pudo leer el chat abierto:`, e.name);
    return CHAT_POR_DEFECTO;
  }
  /* Con Mongo caido el almacen no tira: contesta lo del disco efimero,
     que es nada. Se usa para esta vez y no se memoriza, por la misma
     razon que el catch de arriba. */
  if (almacen.degradado()) return chatAbiertoDelDoc(doc);

  /* Si mientras se leia el creador escribio, gana lo que escribio. */
  if (!chatEnMemoria.has(s)) chatEnMemoria.set(s, chatAbiertoDelDoc(doc));
  return chatEnMemoria.get(s);
}

/**
 * Por que no se puede guardar este pedido, o '' si se puede.
 *
 * Los dos campos son opcionales (lo que no viene queda como estaba),
 * pero lo que viene tiene que ser exacto: una red que no existe o una
 * lista vacia no se "arreglan" en silencio, porque el creador creeria
 * que eligio algo que no quedo guardado.
 */
export function porQueNoSePuedeAbrir({ activo, redes, bloquear, desbloquear } = {}) {
  if (activo !== undefined && typeof activo !== 'boolean') return 'activo tiene que ser true o false';
  if (redes !== undefined) {
    if (!Array.isArray(redes)) return 'redes tiene que ser una lista';
    if (!redes.length) return 'elegí al menos una red';
    const raras = redes.filter(r => !REDES_CHAT.includes(r));
    if (raras.length) return `no existe la red ${String(raras[0]).slice(0, 20)}`;
  }
  for (const [campo, valor] of [['bloquear', bloquear], ['desbloquear', desbloquear]]) {
    if (valor === undefined) continue;
    if (!bloqueadoLimpio(valor)) return `${campo} necesita una red y un id de esa red`;
  }
  return '';
}

/**
 * Abre, cierra o cambia las redes del chat abierto de una sala.
 * Devuelve el ajuste que quedo, o null si la sala no existe.
 *
 * EL DUEÑO DEL SERVICIO PUEDE NO TENER DOCUMENTO: su sala existe por
 * `KICK_SLUG`, no por la base (ver `existe`). Para el, el ajuste va al
 * mismo lugar que el de todos —su documento en `creadores`— y si no lo
 * tiene se le crea con los mismos valores que el alta. El plan que
 * quede escrito ahi no se lee nunca: `planDe` contesta 'dueno' antes de
 * mirar el documento. Y su primer login despues solo completa el id y
 * el nombre, sin tocar nada de esto (`crear` con documento existente).
 */
export async function ponerChatAbierto(slug, pedido = {}) {
  const s = normalizar(slug);
  const problema = porQueNoSePuedeAbrir(pedido);
  if (problema) throw new Error(problema);

  /* El alta del dueño sin fila va ANTES de entrar a la cola: `crear`
     escribe por la misma cola de este creador, y llamarlo desde adentro
     seria esperarse a si mismo. */
  if (!await almacen.obtener('creadores', s)) {
    if (!esDueno(s)) return null;
    await crear({ slug: s });
  }

  /* El calculo entra ADENTRO de `escribir`, o sea adentro de la cola:
     esto es leer-cambiar-guardar sobre la lista de bloqueados y dos a
     la vez se pisan. Pasa de verdad cuando el creador toca "bloquear"
     en dos mensajes seguidos en medio de una tanda de spam: el segundo
     leyo la lista sin el primero y la guardaria sin el, en silencio. */
  let nuevo = null;
  await escribir(s, (doc) => {
    nuevo = calcularChatAbierto(chatAbiertoDelDoc(doc), pedido);
    return {
      chatAbierto: { activo: nuevo.activo, redes: [...nuevo.redes], bloqueados: [...nuevo.bloqueados] },
    };
  });
  chatEnMemoria.set(s, nuevo);
  return nuevo;
}

/** El ajuste que queda despues de aplicarle `pedido` al que habia. */
function calcularChatAbierto(antes, pedido) {
  /* La lista de bloqueados se toca de a uno: el panel manda "bloquea a
     este" o "desbloquea a este", nunca la lista entera. Mandar la lista
     entera haria que dos pestanas del panel abiertas a la vez se
     pisaran los bloqueos sin que nadie se entere. */
  let bloqueados = [...antes.bloqueados];
  if (pedido.desbloquear) {
    const fuera = bloqueadoLimpio(pedido.desbloquear);
    bloqueados = bloqueados.filter(b => !(b.red === fuera.red && b.id === fuera.id));
  }
  if (pedido.bloquear) {
    const nuevoB = bloqueadoLimpio(pedido.bloquear);
    /* Bloquear a alguien que ya estaba no lo duplica ni le mueve la
       fecha: el creador toco dos veces el mismo boton y ya esta. */
    if (!bloqueados.some(b => b.red === nuevoB.red && b.id === nuevoB.id)) {
      if (bloqueados.length >= TOPE_BLOQUEADOS) {
        throw new Error(`no entran mas de ${TOPE_BLOQUEADOS} bloqueados: sacá alguno`);
      }
      bloqueados.push(nuevoB);
    }
  }

  return Object.freeze({
    activo: pedido.activo ?? antes.activo,
    redes: Object.freeze(pedido.redes !== undefined ? redesValidas(pedido.redes) : [...antes.redes]),
    bloqueados: Object.freeze(bloqueados),
  });
}

/* ------------------------------------------------- la Sala prendida

   Decision del dueño del 2026-09-22: por ahora el producto que se
   ofrece es el MULTICHAT (Kick y Twitch juntos), y la Sala —pasar una
   pelicula en una pagina propia— queda cerrada y escondida.

   No se borro nada. Esto es un interruptor: el codigo del reloj, del
   catalogo y de la subida sigue entero y probado, y prender la Sala de
   un creador lo vuelve a poner en linea sin tocar una sola linea.

   Se guarda en el documento del creador, al lado del chat abierto:

     "salaAbierta": true

   ---------------------------------------------------------------
   NACE CERRADA PARA TODOS, INCLUIDO EL DUEÑO DEL SERVICIO

   Y eso es a proposito. `existe()` contesta true para el dueño sin
   tocar el almacen, porque su Sala tiene que funcionar con la coleccion
   vacia; si esta se escribiera con el mismo criterio, apagar el
   producto dejaria prendida justamente la unica Sala que hoy tiene una
   pelicula puesta. El interruptor no es una regla sobre quien es cada
   uno: es una sobre que se esta ofreciendo hoy.

   ---------------------------------------------------------------
   POR QUE ACA NO HAY COPIA EN MEMORIA Y EL CHAT ABIERTO SI TIENE

   La del chat abierto existe porque el filtro del bus pregunta en CADA
   mensaje y por CADA conexion, donde no hay ningun `await` disponible.
   Esto no: todo lo que lo pregunta —las paginas, las cuatro rutas de
   /api/sala, /api/panel/*, /api/videos y /api/subida— ya es
   asincronico. Alcanza con `obtener`, que trae su propia cache de 5
   segundos y que toda escritura invalida. Un Map aca seria complejidad
   sin motivo, y una copia mas para desincronizarse el dia que haya dos
   instancias.

   Y si el almacen falla, `obtener` contesta null y esto contesta
   "cerrada". Es la direccion correcta para una puerta: ante la duda, lo
   cerrado. */

/** Si esta sala tiene la pelicula prendida. */
export async function salaAbierta(slug) {
  const doc = await obtener(slug);
  return Boolean(doc?.salaAbierta);
}

/**
 * Prende o apaga la Sala de un creador. Devuelve como quedo, o null si
 * la sala no existe.
 *
 * MISMO CASO RARO QUE `ponerChatAbierto`: el dueño del servicio puede
 * no tener documento (su sala existe por `KICK_SLUG`, ver `existe`), y
 * entonces se le crea con los mismos valores que el alta. El plan que
 * quede escrito ahi no se lee nunca: `planDe` contesta 'dueno' antes de
 * mirar el documento.
 *
 * La cola la pone `escribir`, que es por donde pasa TODA escritura de
 * este modulo: prender la Sala mientras se guarda un bloqueo (o un
 * plan, o el uso de R2) se pisaban en silencio, y la cola vieja —la que
 * estaba aca arriba— solo protegia a estas dos funciones entre si.
 *
 * `valor === true` y no `Boolean(valor)`: lo que no es exactamente
 * `true` cierra. Es la defensa en profundidad del 400 de las rutas; un
 * `"false"` de texto que prendiera la Sala seria justo el error que no
 * se descubre hasta que alguien entra.
 */
export async function ponerSalaAbierta(slug, valor) {
  const s = normalizar(slug);
  /* Igual que el chat abierto: el alta del dueño sin fila va antes de
     la cola, porque `crear` escribe por la misma. */
  if (!await almacen.obtener('creadores', s)) {
    if (!esDueno(s)) return null;
    await crear({ slug: s });
  }
  const abierta = valor === true;
  await escribir(s, { salaAbierta: abierta });
  return abierta;
}
