/* ============================================================
   Almacen de datos.

   Dos backends detras de la misma interfaz: MongoDB Atlas si hay
   MONGODB_URI en el entorno, y archivos JSON en servidor/datos/ si no.

   El fallback no es un parche: permite construir y probar sin Atlas
   configurado, y deja el server arrancando aunque no haya
   node_modules. Por eso el driver se importa de forma DINAMICA: el
   repo declara `mongodb` como unica dependencia, pero si no esta
   instalada el import falla y se cae al archivo, en vez de romper el
   arranque.

   ---------------------------------------------------------------
   POR QUE ESTA INTERFAZ Y NO LA DE CosasStream

   En CosasStream el almacen es clave -> valor: una sola coleccion
   `config` con un documento por clave. Alcanzaba porque ahi todo lo
   guardado es configuracion: una lista de efectos, un mapa de
   usuarios, y nada crece sin techo.

   Aca no. `sesiones`, `tokens` y `videos` crecen con cada espectador
   que entra y cada video que se sube. Meter todas las sesiones en un
   solo documento seria caminar hacia el tope de 16 MB de Mongo y,
   peor, hacer que dos escrituras simultaneas se pisen la una a la
   otra. Asi que el almacen de Sala es orientado a documentos: una
   coleccion de verdad por cada cosa, un documento por fila.

   Colecciones: creadores, tokens, sesiones, videos, reloj, subidas.

   `subidas` guarda el HASH de la clave de subida de cada sala, no la
   clave. Es la misma idea que `sesiones`: un volcado de la base no
   alcanza para subir ni borrar videos.

   ---------------------------------------------------------------
   REGLA DE ORO: la connection string lleva usuario y clave adentro.
   No se imprime nunca, ni en un log ni en un error. Por eso los catch
   de aca loguean `e.name` y jamas `e.message`: los errores del driver
   suelen traer el host, y a veces la URI entera.
   ============================================================ */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = path.dirname(fileURLToPath(import.meta.url));

/* SALA_DATOS existe para que un test pueda trabajar en su propia
   carpeta: `node --test` corre cada archivo de pruebas en un proceso
   aparte pero en el mismo disco, y dos suites limpiando servidor/datos
   a la vez se pisan. En Railway no se carga: ahi manda Mongo y este
   disco es efimero igual. */
const CARPETA = process.env.SALA_DATOS
  ? path.resolve(process.env.SALA_DATOS)
  : path.join(AQUI, 'datos');

/* Se aceptan los dos nombres. MONGODB_URI es el que copias del panel
   de Atlas y el que termina pegado en Railway; MONGO_URI queda por si
   ya estaba puesto de antes. */
const URI  = process.env.MONGODB_URI ?? process.env.MONGO_URI ?? '';
const BASE = process.env.MONGODB_DB  ?? process.env.MONGO_DB  ?? 'sala';

/* Las unicas colecciones que existen. La lista esta para que un typo
   (`sesion` en vez de `sesiones`) explote al escribir y no cree una
   coleccion fantasma que despues nadie lee. */
export const COLECCIONES = ['creadores', 'tokens', 'sesiones', 'videos', 'reloj', 'subidas', 'espectadores'];

let conexion = null;              // promesa de la base, para no abrir dos
let modo     = URI ? 'mongo' : 'archivo';
let motivo   = URI ? '' : 'sin MONGODB_URI';

/* Cuanto se espera antes de volver a probar Mongo despues de un fallo.
   Sin esto, un corte de un minuto dejaba el servicio guardando en
   archivo hasta el proximo deploy, y en Railway ese disco es efimero:
   los datos se perdian sin que nadie se enterara. */
const REINTENTO = 60_000;
let reintentarDesde = 0;

/** Para mostrar en la pagina de estado donde esta guardando de verdad. */
export const dondeGuarda = () => ({ modo, motivo });

/**
 * Si Mongo esta configurado pero ahora mismo se esta guardando en
 * archivo. En ese estado una lectura NO tira: contesta lo que haya en
 * el disco efimero del contenedor, que casi siempre es nada. Quien
 * guarde en memoria lo que lee (el chat abierto de `creadores.js`) lo
 * tiene que saber, o memoriza un "no hay nada" que no es verdad.
 */
export const degradado = () => Boolean(URI) && modo !== 'mongo';

function validar(coleccion) {
  if (!COLECCIONES.includes(coleccion)) {
    throw new Error(`coleccion desconocida: ${coleccion}`);
  }
  return coleccion;
}

/* --------------------------------------------------------------- dns

   mongodb+srv:// necesita una consulta DNS de tipo SRV, y esa la hace
   el driver con su propio resolutor (c-ares), no con el del sistema.
   Si ese resolutor no contesta, la conexion no arranca NUNCA aunque el
   resto de la red ande perfecto: fetch usa el resolutor del sistema
   operativo y no se entera de nada. El sintoma es un ECONNREFUSED que
   no se parece en nada a su causa.

   Por eso se prueba la consulta antes de conectar. Si el resolutor
   esta caido se pasa a uno publico y SE AVISA por consola: el nombre
   del cluster sale hacia un tercero, y eso no puede pasar en silencio.
   MONGO_DNS deja elegir cual, y desactiva esta deteccion. */

const DNS_DE_EMERGENCIA = ['1.1.1.1', '8.8.8.8'];

/* el resolutor esta caido, no el dominio mal escrito */
const RESOLUTOR_CAIDO = ['ECONNREFUSED', 'ETIMEOUT', 'ETIMEDOUT', 'ESERVFAIL', 'EREFUSED', 'ECONNRESET'];

async function asegurarSrv(dns) {
  const host = URI.replace(/^mongodb\+srv:\/\//, '').split('@').pop().split(/[/?]/)[0];
  try {
    await dns.promises.resolveSrv('_mongodb._tcp.' + host);
    return;                                  // el resolutor contesta, nada que hacer
  } catch (e) {
    /* ENOTFOUND o ENODATA serian el host mal escrito, no el resolutor:
       ahi no hay que cambiar nada y conviene que hable el driver */
    if (!RESOLUTOR_CAIDO.includes(e.code)) return;
  }
  dns.setServers(DNS_DE_EMERGENCIA);
  console.warn(`[almacen] el resolutor DNS del sistema no contesta consultas SRV; ` +
               `se usa ${DNS_DE_EMERGENCIA[0]} solo para resolver el cluster. ` +
               `Con MONGO_DNS se elige otro.`);
}

/* ------------------------------------------------------------- mongo */

async function base() {
  if (!conexion) {
    conexion = (async () => {
      const dns = await import('node:dns');
      const elegido = (process.env.MONGO_DNS ?? '').split(',').map(x => x.trim()).filter(Boolean);
      if (elegido.length) dns.setServers(elegido);
      else if (URI.startsWith('mongodb+srv://')) await asegurarSrv(dns);

      const { MongoClient } = await import('mongodb');
      /* timeout corto a proposito: si Atlas no contesta preferimos caer
         al archivo rapido y seguir el stream, no colgar el pedido 30s */
      const c = new MongoClient(URI, { serverSelectionTimeoutMS: 5000 });
      await c.connect();
      return c.db(BASE);
    })();
    conexion.catch(() => { conexion = null; });   // que se pueda reintentar
  }
  return conexion;
}

/* Un fallo de Mongo degrada a archivo y lo dice fuerte. Degradar en
   silencio seria peor: seguirias creyendo que guardas en la nube.

   La degradacion NO es definitiva: pasado REINTENTO se vuelve a
   probar. Asi, arreglado lo que fallaba (tipico: habilitar la IP en
   Atlas), el servicio se recupera solo y no hace falta redeployar. */
/* Del error se toman `name`, `code` y `codeName`, nunca `message`: los
   tres primeros son etiquetas del driver (`MongoServerError`, 18,
   `AuthenticationFailed`) y el ultimo es el unico que puede traer la
   URI con la contraseña adentro. Sin el codigo, "Error" a secas no
   distingue una clave mal puesta de una URI mal armada, que es
   exactamente la duda que aparece la primera vez que se despliega. */
function etiquetaDelError(e) {
  const partes = [e?.name || 'Error'];
  if (e?.codeName) partes.push(e.codeName);
  else if (e?.code !== undefined && e?.code !== null) partes.push(`codigo ${e.code}`);
  return partes.join(', ');
}

function degradar(donde, e) {
  if (modo !== 'archivo') {
    motivo = `mongo fallo en ${donde} (${etiquetaDelError(e)})`;
    console.warn(`[almacen] ${motivo} -> archivo local, reintento en ${REINTENTO / 1000}s`);
  }
  modo = 'archivo';
  conexion = null;
  reintentarDesde = Date.now() + REINTENTO;
}

function recuperado() {
  if (modo === 'mongo') return;
  modo = 'mongo';
  motivo = '';
  console.log('[almacen] Mongo volvio a responder');
}

/* Se intenta mongo si esta configurado y, habiendo degradado, si ya
   paso el tiempo de espera. Sin la espera, cada lectura pagaria el
   timeout completo de conexion y el sitio se arrastraria. */
const conviene = () => Boolean(URI) && (modo === 'mongo' || Date.now() >= reintentarDesde);

/* ------------------------------------------------------------ archivo

   Cada coleccion es un archivo JSON con un objeto id -> documento.

   Lo importante: la copia en memoria es la fuente de verdad mientras
   el proceso vive, y el archivo es solo persistencia. Si en vez de eso
   cada escritura leyera el archivo, lo modificara y lo volviera a
   escribir, dos escrituras simultaneas a la misma coleccion se
   pisarian: la segunda leeria el estado viejo. Con la copia en memoria
   esa carrera no existe. */

const enMemoria = new Map();      // coleccion -> objeto id -> doc
const cargando  = new Map();      // coleccion -> promesa de la carga inicial

/* Object.create(null) y no {}. Los ids de documento vienen de afuera:
   hoy son sesiones que generamos nosotros, en la Fase 3 son ids de
   creadores y de videos que manda gente. Sobre un objeto normal,
   `datos['__proto__'] = doc` no crea ninguna propiedad: activa el
   setter heredado. O sea que poner(coleccion, '__proto__', algo)
   devolvia true sin guardar nada, y quitar() decia que habia borrado
   algo que jamas existio (porque '__proto__' in {} es true). Sin
   prototipo, '__proto__' es una clave como cualquier otra. */
const objetoDeDatos = desde => Object.assign(Object.create(null), desde ?? {});

async function cargarArchivo(coleccion) {
  if (enMemoria.has(coleccion)) return enMemoria.get(coleccion);
  if (!cargando.has(coleccion)) {
    cargando.set(coleccion, (async () => {
      let leido = null;
      try {
        leido = JSON.parse(await fs.readFile(path.join(CARPETA, `${coleccion}.json`), 'utf8'));
      } catch { /* no existe todavia: arranca vacia */ }
      if (!leido || typeof leido !== 'object') leido = {};
      const datos = objetoDeDatos(leido);
      enMemoria.set(coleccion, datos);
      cargando.delete(coleccion);
      return datos;
    })());
  }
  return cargando.get(coleccion);
}

/* Contador de modulo para que dos escrituras concurrentes a la misma
   coleccion no compartan el mismo .tmp: si comparten nombre, la
   segunda renombra un archivo que la primera ya movio y explota con
   ENOENT. */
let contadorTemp = 0;

async function escribirArchivo(destino, datos) {
  const temp = `${destino}.${process.pid}.${contadorTemp++}.tmp`;
  await fs.writeFile(temp, JSON.stringify(datos, null, 2), 'utf8');
  try {
    /* temporal + rename: si el proceso muere a mitad de la escritura
       el archivo viejo queda intacto en vez de quedar truncado */
    await fs.rename(temp, destino);
  } catch (e) {
    await fs.unlink(temp).catch(() => {});   // no dejar el .tmp huerfano
    throw e;
  }
}

/* Una cola de promesas por destino. El tmp unico ya evita que dos
   escrituras se pisen el archivo temporal, pero el rename final sigue
   yendo contra el mismo destino: en Windows dos renames concurrentes
   al mismo destino pueden tirar EPERM, y en POSIX no fallan pero la
   que termina segunda pisa el resultado de la otra sin ningun orden
   garantizado. Serializar por coleccion saca la carrera de encima. */
const colas = new Map();

async function guardarArchivo(coleccion) {
  await fs.mkdir(CARPETA, { recursive: true });
  const destino = path.join(CARPETA, `${coleccion}.json`);
  const datos = enMemoria.get(coleccion) ?? {};

  const previa = colas.get(destino) ?? Promise.resolve();
  /* .then(f, f): si la escritura anterior de la cola fallo, la propia
     no tiene por que fallar tambien. */
  const actual = previa.then(
    () => escribirArchivo(destino, datos),
    () => escribirArchivo(destino, datos),
  );
  colas.set(destino, actual);
  /* La limpieza va con then(f, f) y no con finally(): finally()
     devuelve otra promesa que, si la escritura fallo, rechaza sin que
     nadie la atrape, y un rechazo suelto tumba el proceso. El error
     igual le llega al que llamo, por `actual`. */
  const limpiar = () => { if (colas.get(destino) === actual) colas.delete(destino); };
  actual.then(limpiar, limpiar);
  return actual;
}

/* ------------------------------------------------- leer-cambiar-guardar

   El almacen no sabe actualizar un campo suelto: `poner` reemplaza el
   documento entero. Asi que todo el que cambia una parte hace
   leer-cambiar-guardar, y dos de esos a la vez sobre el MISMO
   documento se pisan: el segundo leyo antes de que el primero
   guardara, y al guardar borra lo que el primero acababa de escribir.

   No es teorico. Los dos casos de este proyecto:

     - un espectador manda "a las dos" con los dos tokens vencidos: los
       dos refrescos guardan a la vez y uno de los dos tokens nuevos se
       pierde (y el viejo ya no sirve, porque las dos plataformas rotan
       el refresh token);
     - el creador toca "bloquear" en dos mensajes seguidos: el segundo
       leyo la lista sin el primero y la guarda sin el.

   `enCola` los serializa por clave. Es la misma idea que la cola de
   escritura de archivos de mas arriba, un piso mas arriba: alla se
   serializa el archivo, aca la operacion entera. */

const enFila = new Map();   // "coleccion/id" -> promesa de lo ultimo encolado

/**
 * Corre `tarea` cuando no haya otra corriendo sobre la misma clave.
 * Devuelve lo que devuelva la tarea.
 */
export function enCola(coleccion, id, tarea) {
  const clave = `${coleccion}/${id}`;
  const previa = enFila.get(clave) ?? Promise.resolve();
  /* .then(f, f): si la anterior fallo, la propia no tiene por que
     fallar tambien. */
  const actual = previa.then(tarea, tarea);
  enFila.set(clave, actual);
  /* La limpieza va con then(f, f) y no con finally(), que devolveria
     otra promesa rechazada sin nadie que la atrape. */
  const limpiar = () => { if (enFila.get(clave) === actual) enFila.delete(clave); };
  actual.then(limpiar, limpiar);
  return actual;
}

/* ---------------------------------------------------------- interfaz

   Los documentos van y vienen como objetos planos. El id se guarda en
   Mongo como _id y se devuelve siempre como `id`, para que el codigo
   de arriba no sepa en que backend esta parado. */

const conId = (id, doc) => (doc ? { id, ...doc } : null);

/** Un documento por su id, o `porDefecto` si no esta. */
export async function obtener(coleccion, id, porDefecto = null) {
  validar(coleccion);
  const clave = String(id);

  if (conviene()) {
    try {
      const doc = await (await base()).collection(coleccion).findOne({ _id: clave });
      recuperado();
      if (!doc) return porDefecto;
      const { _id, ...resto } = doc;
      return conId(_id, resto);
    } catch (e) {
      degradar('obtener', e);
    }
  }
  const datos = await cargarArchivo(coleccion);
  return datos[clave] ? conId(clave, datos[clave]) : porDefecto;
}

/** Crea o reemplaza un documento. */
export async function poner(coleccion, id, datos) {
  validar(coleccion);
  const clave = String(id);
  /* el id no se duplica adentro del documento: es la clave */
  const { id: _ignorado, ...cuerpo } = datos ?? {};

  if (conviene()) {
    try {
      await (await base()).collection(coleccion).replaceOne(
        { _id: clave },
        { ...cuerpo, ts: new Date() },
        { upsert: true },
      );
      recuperado();
      return true;
    } catch (e) {
      degradar('poner', e);
    }
  }
  const enArchivo = await cargarArchivo(coleccion);
  enArchivo[clave] = { ...cuerpo, ts: new Date().toISOString() };
  await guardarArchivo(coleccion);
  return true;
}

/** Borra un documento. Devuelve si habia algo que borrar. */
export async function quitar(coleccion, id) {
  validar(coleccion);
  const clave = String(id);

  if (conviene()) {
    try {
      const r = await (await base()).collection(coleccion).deleteOne({ _id: clave });
      recuperado();
      return r.deletedCount > 0;
    } catch (e) {
      degradar('quitar', e);
    }
  }
  const datos = await cargarArchivo(coleccion);
  if (!(clave in datos)) return false;
  delete datos[clave];
  await guardarArchivo(coleccion);
  return true;
}

/**
 * Todos los documentos de una coleccion, o los que coincidan con un
 * filtro de igualdad simple ({ slug: 'istincho' }). El filtro se
 * mantiene a proposito pobre: tiene que dar el mismo resultado en
 * Mongo y en archivo, y cualquier cosa mas rica se iria comportando
 * distinto en cada backend sin que nadie lo note.
 */
export async function listar(coleccion, filtro = {}) {
  validar(coleccion);

  if (conviene()) {
    try {
      const docs = await (await base()).collection(coleccion).find(filtro).toArray();
      recuperado();
      return docs.map(({ _id, ...resto }) => conId(_id, resto));
    } catch (e) {
      degradar('listar', e);
    }
  }
  const datos = await cargarArchivo(coleccion);
  const campos = Object.entries(filtro);
  return Object.entries(datos)
    .filter(([, doc]) => campos.every(([k, v]) => doc?.[k] === v))
    .map(([id, doc]) => conId(id, doc));
}

/**
 * Solo para los tests: olvida lo cargado en memoria para que cada
 * prueba arranque limpia. En produccion no lo llama nadie.
 */
export function olvidarCache() {
  enMemoria.clear();
  cargando.clear();
}
