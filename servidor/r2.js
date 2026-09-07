/* ============================================================
   R2: firmar URLs para que el navegador (o el script del creador)
   suba y borre SIN que un solo byte de video pase por este servidor.

   ---------------------------------------------------------------
   POR QUE EL SERVIDOR TIENE QUE TENER EL TOKEN DE R2, Y ANTES NO

   Hasta la Fase 2 el token de R2 vivia SOLO en la PC del dueño
   (`herramientas/.env`), y estaba bien: el unico que subia era el, con
   su script. En la Fase 3 sube cualquier creador, y a un creador no se
   le puede dar el token del bucket: con el podria leer, pisar y borrar
   los videos de todos los demas, incluidos los del dueño.

   La forma de dar permiso acotado es una URL PREFIRMADA: el servidor
   firma "PUT sobre exactamente esta clave, valido por diez minutos" y
   el creador sube contra esa URL. Firmar es, por definicion, tener el
   secreto. O sea que el token de R2 pasa a ser una variable de Railway.

   Eso cambia una tarea del dueño y esta anotado en TAREAS-DUENO.md.
   Lo que NO cambia: el video sigue sin pasar por Railway. El servidor
   firma una URL de unos cientos de bytes; los gigas van del creador a
   R2 y de R2 al espectador, directo.

   ---------------------------------------------------------------
   EL PREFIJO ES LA FRONTERA, Y LA COMPRUEBA QUIEN FIRMA

   Toda clave firmada tiene que empezar con `<slug>/`: es la unica cosa
   que separa los videos de un creador de los de otro.

   Por eso `firmar()` PIDE EL SLUG y lo comprueba el mismo, en vez de
   confiar en que lo haya hecho el que llama. Hasta la Fase 3 esto era
   un comentario que prometia un segundo cinturon que el codigo no
   tenia: `firmar()` no recibia el slug, asi que no podia comprobar
   nada, y `r2.firmar('DELETE', 'otrocreador/loquesea.ts')` firmaba sin
   una queja. Una invariante que se comprueba solo en el call site es
   una invariante que se pierde en el call site siguiente, y firmar un
   DELETE es la operacion mas cara de deshacer de todo el servicio.

   El slug va como parametro POSICIONAL Y OBLIGATORIO, y no adentro de
   `opciones`, por la misma razon que en `vinculos.js`: sin valor por
   defecto, olvidarse tira. Un call site viejo que llame
   `firmar(metodo, clave, { segundos })` pasa el objeto de opciones
   donde va el slug, no pasa `esDeLaSala`, y explota en el acto en vez
   de firmar sobre el prefijo de cualquiera.

   ---------------------------------------------------------------
   SIGV4 A MANO

   Sin boto3 ni aws-sdk: la unica dependencia del repo es `mongodb`.
   SigV4 son cuatro HMAC y un SHA-256, todo en `node:crypto`. Lo que
   tiene de traicionero es la codificacion de la clave en la URI y el
   orden de la query, asi que las dos cosas tienen pruebas propias
   contra los vectores del ejemplo de AWS.

   Datos de R2 que no son los de S3 (docs de Cloudflare, api/s3):
     - el endpoint es POR CUENTA (`<account>.r2.cloudflarestorage.com`)
       y no por bucket; el bucket va en el camino;
     - la region es siempre `auto`;
     - R2 no implementa ACL ni los checksum nuevos del SDK, asi que no
       se manda ninguno: se firma con UNSIGNED-PAYLOAD.
   ============================================================ */

import crypto from 'node:crypto';

const ALGORITMO = 'AWS4-HMAC-SHA256';
const REGION = 'auto';
const SERVICIO = 's3';

/* Diez minutos: lo que tarda una subida de una pelicula entera con la
   red de una casa, con aire. Mas que eso es una URL con permiso de
   escritura dando vueltas por una terminal mas tiempo del necesario. */
export const VENCE_POR_DEFECTO = 600;

/* Tope duro de R2/S3 para una URL prefirmada: 7 dias. */
const VENCE_MAXIMO = 7 * 24 * 60 * 60;

const leer = n => String(process.env[n] ?? '').trim();

export const cuenta = () => leer('R2_ACCOUNT_ID');
export const bucket = () => leer('R2_BUCKET');

/** La base publica del bucket (`https://pub-….r2.dev`), sin barra final. */
export const urlPublicaBase = () => leer('R2_URL_PUBLICA').replace(/\/+$/, '');

/**
 * Si este servidor puede hacer su parte de la subida: firmar, medir y
 * decir donde va a quedar el archivo.
 *
 * ES EXACTAMENTE LO CONTRARIO DE `porQueNoHay()`, y no una lista
 * parecida. Las dos son la misma pregunta ("¿se puede?" y "¿por que
 * no?") y hasta la Fase 3 no coincidian: `porQueNoHay()` nombraba
 * R2_URL_PUBLICA y esta decia que si igual. Con las cuatro primeras
 * cargadas y esa sin cargar, /api/subida contestaba 200 con
 * `urlPublica: "/ana/ep1/"` —sin host— y el creador subia la pelicula
 * entera para enterarse en el POST siguiente, como `400 url invalida`,
 * que no nombra ninguna variable. Faltando cualquiera de las cinco se
 * contesta 503 con el nombre de la que falta, antes de subir un byte.
 */
export function hayCredenciales() {
  return !porQueNoHay();
}

/**
 * Que falta para poder subir, con el nombre exacto de la variable.
 *
 * Nunca dice un valor: dice cual falta. Es la misma regla que
 * /api/estado, y existe porque el dia que la subida no ande hay que
 * poder verlo en un renglon en vez de adivinar entre cinco variables.
 */
export function porQueNoHay() {
  const faltan = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET']
    .filter(n => !leer(n));
  if (!faltan.length && !urlPublicaBase()) return 'falta R2_URL_PUBLICA (la URL publica del bucket)';
  return faltan.length ? `faltan ${faltan.join(', ')}` : '';
}

/* ------------------------------------------------------ codificacion

   AWS codifica para la firma con SU regla, no con la de
   encodeURIComponent: los no reservados son A-Z a-z 0-9 - _ . ~ y todo
   lo demas va como %XX en MAYUSCULAS. `encodeURIComponent` deja pasar
   ! * ' ( ) sin codificar, y con cualquiera de esos en el nombre de un
   archivo la firma no da y R2 contesta 403 sin decir por que. */

const NO_RESERVADOS = /[^A-Za-z0-9\-_.~]/g;

export const codificar = s =>
  String(s).replace(NO_RESERVADOS, c =>
    [...Buffer.from(c, 'utf8')].map(b => '%' + b.toString(16).toUpperCase().padStart(2, '0')).join(''));

/* La clave va codificada POR SEGMENTO: las barras separan carpetas y
   tienen que quedar barras. */
const codificarClave = clave => String(clave).split('/').map(codificar).join('/');

/* ---------------------------------------------------------- claves */

/* Lo que puede tener una clave de R2 de este servicio. Es a proposito
   mas angosto que lo que R2 acepta: estas claves las arma el script de
   un creador y de ellas depende que no se pise el prefijo de otro.

   Sin barra al principio, sin `..` en ningun segmento, sin barra
   invertida (en Windows ffmpeg escribe `720p\lista.m3u8` y en una URL
   eso no separa carpetas), sin segmentos vacios y sin controles. */
const SEGMENTO_MALO = /^$|^\.\.?$|[\u0000-\u001F\u007F\\]/;

export function claveValida(clave) {
  const c = String(clave ?? '');
  if (!c || c.length > 700 || c.startsWith('/')) return false;
  return !c.split('/').some(p => SEGMENTO_MALO.test(p));
}

/**
 * Si una clave cae adentro del prefijo de una sala.
 *
 * `<slug>/` con la barra: sin ella, el slug `ana` dejaria firmar
 * `anaconda/loquesea`, que es el prefijo de otro creador.
 */
export function esDeLaSala(clave, slug) {
  const s = String(slug ?? '').toLowerCase();
  if (!s) return false;
  return String(clave ?? '').startsWith(`${s}/`);
}

/* ------------------------------------------------------------ firma */

const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
const hmac = (clave, dato) => crypto.createHmac('sha256', clave).update(dato).digest();

/* Las dos fechas que pide SigV4: la larga va en la firma y la corta en
   el alcance de la credencial. */
function fechas(ahora) {
  const iso = new Date(ahora).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  return { larga: iso, corta: iso.slice(0, 8) };
}

/**
 * La cadena de cuatro HMAC que da la clave de firma de SigV4.
 *
 * Sale exportada y con la region y el servicio por parametro (aunque
 * aca siempre sean `auto` y `s3`) para que la prueba la pueda correr
 * contra el vector publicado por AWS, que es de `us-east-1` y `iam`.
 * Es lo unico de este archivo que se puede verificar contra un valor
 * de afuera sin tener el bucket: el resto se prueba por forma.
 */
export function derivarClave(secreto, corta, region = REGION, servicio = SERVICIO) {
  const kFecha = hmac(`AWS4${secreto}`, corta);
  const kRegion = hmac(kFecha, region);
  const kServicio = hmac(kRegion, servicio);
  return hmac(kServicio, 'aws4_request');
}

const claveDeFirma = (secreto, corta) => derivarClave(secreto, corta);

const queryCanonica = pares =>
  pares
    .map(([n, v]) => [codificar(n), codificar(v)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([n, v]) => `${n}=${v}`)
    .join('&');

/**
 * Una URL prefirmada para una operacion sobre una clave de UNA sala.
 *
 * El slug no es decorativo: sin el no se firma. Ver "EL PREFIJO ES LA
 * FRONTERA" arriba.
 *
 * @param {'PUT'|'GET'|'DELETE'|'HEAD'} metodo
 * @param {string} clave     la clave completa en el bucket, con prefijo
 * @param {string} slug      la sala que tiene que ser dueña de esa clave
 * @param {{segundos?:number, ahora?:number}} opciones
 * @returns {string} la URL, valida por `segundos`
 */
export function firmar(metodo, clave, slug, { segundos = VENCE_POR_DEFECTO, ahora = Date.now() } = {}) {
  if (!hayCredenciales()) throw new Error(`no se puede firmar para R2: ${porQueNoHay()}`);
  if (!claveValida(clave)) throw new Error('clave de R2 invalida');
  /* El cinturon de verdad. `esDeLaSala` contesta false con el slug
     vacio, asi que olvidarse del argumento tampoco pasa. */
  if (!esDeLaSala(clave, slug)) {
    throw new Error('clave de R2 fuera de la sala: no se firma nada que no empiece con el prefijo');
  }

  const vence = Math.min(VENCE_MAXIMO, Math.max(1, Math.floor(Number(segundos) || 0)));
  const { larga, corta } = fechas(ahora);
  const host = `${cuenta()}.r2.cloudflarestorage.com`;
  const camino = `/${codificar(bucket())}/${codificarClave(clave)}`;
  const alcance = `${corta}/${REGION}/${SERVICIO}/aws4_request`;

  const query = queryCanonica([
    ['X-Amz-Algorithm', ALGORITMO],
    ['X-Amz-Credential', `${leer('R2_ACCESS_KEY_ID')}/${alcance}`],
    ['X-Amz-Date', larga],
    ['X-Amz-Expires', String(vence)],
    ['X-Amz-SignedHeaders', 'host'],
  ]);

  /* UNSIGNED-PAYLOAD: no se firma el contenido. Firmarlo obligaria a
     tener el archivo entero de este lado, que es exactamente lo que
     este diseño evita. Lo que la firma ata es el metodo, la clave y el
     vencimiento, que es lo que importa. */
  const pedidoCanonico = [
    metodo,
    camino,
    query,
    `host:${host}\n`,
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const paraFirmar = [ALGORITMO, larga, alcance, sha256(pedidoCanonico)].join('\n');
  const firma = crypto
    .createHmac('sha256', claveDeFirma(leer('R2_SECRET_ACCESS_KEY'), corta))
    .update(paraFirmar)
    .digest('hex');

  return `https://${host}${camino}?${query}&X-Amz-Signature=${firma}`;
}

/* --------------------------------------------------------- listar

   Lo unico que este modulo pide POR SI MISMO, y existe por una razon
   concreta: sin esto, el tope de GB por plan se calcularia con los
   bytes que DECLARA el que sube, o sea con un numero que elige el
   mismo al que se le esta poniendo el limite. Con esto, el tope se
   compara contra lo que R2 dice que hay.

   Va con Authorization y no prefirmado porque es un pedido que hace el
   servidor, no un tercero. */

async function pedirFirmado(camino, pares, ahora = Date.now()) {
  const { larga, corta } = fechas(ahora);
  const host = `${cuenta()}.r2.cloudflarestorage.com`;
  const alcance = `${corta}/${REGION}/${SERVICIO}/aws4_request`;
  const query = queryCanonica(pares);
  const vacio = sha256('');

  const pedidoCanonico = [
    'GET',
    camino,
    query,
    `host:${host}\nx-amz-content-sha256:${vacio}\nx-amz-date:${larga}\n`,
    'host;x-amz-content-sha256;x-amz-date',
    vacio,
  ].join('\n');

  const paraFirmar = [ALGORITMO, larga, alcance, sha256(pedidoCanonico)].join('\n');
  const firma = crypto
    .createHmac('sha256', claveDeFirma(leer('R2_SECRET_ACCESS_KEY'), corta))
    .update(paraFirmar)
    .digest('hex');

  const r = await fetch(`https://${host}${camino}?${query}`, {
    headers: {
      Authorization: `${ALGORITMO} Credential=${leer('R2_ACCESS_KEY_ID')}/${alcance}, ` +
                     `SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=${firma}`,
      'x-amz-content-sha256': vacio,
      'x-amz-date': larga,
    },
  });
  const texto = await r.text();
  if (!r.ok) {
    const e = new Error(`R2 contesto ${r.status}`);
    e.status = r.status;
    /* El cuerpo del error de S3 trae el bucket y a veces la clave; no
       trae el secreto, pero no se propaga igual. */
    throw e;
  }
  return texto;
}

/* Un XML de S3 se lee con una expresion regular y no con un parser
   porque son dos etiquetas y agregar un parser seria agregar una
   dependencia. Lo unico que hay que acordarse es de desescapar las
   entidades: una clave con `&` llega como `&amp;`. */
const ENTIDADES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
const desescapar = s => String(s).replace(/&(amp|lt|gt|quot|apos);/g, m => ENTIDADES[m]);

const etiqueta = (xml, nombre) => {
  const m = new RegExp(`<${nombre}>([\\s\\S]*?)</${nombre}>`).exec(xml);
  return m ? desescapar(m[1]) : '';
};

/**
 * Todo lo que hay bajo un prefijo, con su tamaño.
 *
 * Pagina sola: S3 devuelve como mucho 1000 por vuelta y una pelicula
 * en segmentos de 6 segundos son mas de mil archivos, asi que sin
 * paginar el numero de una peli larga saldria mal por defecto.
 *
 * @returns {Promise<{objetos:{clave:string,bytes:number}[], bytes:number}>}
 */
export async function listarPrefijo(prefijo, { tope = 20000 } = {}) {
  if (!hayCredenciales()) throw new Error(`no se puede listar R2: ${porQueNoHay()}`);
  const camino = `/${codificar(bucket())}`;
  const objetos = [];
  let cursor = '';

  for (let vuelta = 0; vuelta < 100; vuelta++) {
    const pares = [['list-type', '2'], ['prefix', String(prefijo ?? '')], ['max-keys', '1000']];
    if (cursor) pares.push(['continuation-token', cursor]);
    const xml = await pedirFirmado(camino, pares);

    for (const bloque of xml.match(/<Contents>[\s\S]*?<\/Contents>/g) ?? []) {
      objetos.push({
        clave: etiqueta(bloque, 'Key'),
        bytes: Number(etiqueta(bloque, 'Size')) || 0,
      });
      if (objetos.length >= tope) break;
    }

    if (objetos.length >= tope) break;
    if (etiqueta(xml, 'IsTruncated') !== 'true') break;
    cursor = etiqueta(xml, 'NextContinuationToken');
    if (!cursor) break;
  }

  return { objetos, bytes: objetos.reduce((s, o) => s + o.bytes, 0) };
}

/** Cuantos bytes ocupa una sala en el bucket. */
export async function bytesDeLaSala(slug) {
  const { bytes } = await listarPrefijo(`${String(slug ?? '').toLowerCase()}/`);
  return bytes;
}
