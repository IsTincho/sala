/* ============================================================
   Cifrado de lo que no puede quedar en claro en la base.

   Los refresh tokens de Kick y de Twitch son la llave para escribir
   en el chat en nombre de otro. Si la base se filtra y estan en
   claro, cualquiera puede hablar como los espectadores. Cifrados con
   una clave que vive SOLO en las variables de Railway, un volcado de
   Mongo no alcanza para nada.

   AES-256-GCM y no AES-CBC: GCM ademas de ocultar autentica. Si
   alguien con acceso a la base edita un byte del blob, el descifrado
   falla en vez de devolver basura silenciosa.

   Formato del blob: "v1." + base64url( iv(12) | tag(16) | secreto ).
   El prefijo de version esta desde el dia uno para poder rotar de
   algoritmo mas adelante sin adivinar que es cada fila vieja.
   ============================================================ */

import crypto from 'node:crypto';

const ALGORITMO = 'aes-256-gcm';
const BYTES_IV  = 12;   // el tamaño que recomienda GCM
const BYTES_TAG = 16;
const VERSION   = 'v1';

/* La clave se lee una sola vez y se guarda como Buffer. Nunca se
   imprime, ni entera ni en pedazos, ni siquiera en un error. */
let clave = null;
let motivoSinClave = 'CLAVE_CIFRADO no esta cargada';

function cargarClave() {
  if (clave) return clave;

  const crudo = process.env.CLAVE_CIFRADO ?? '';
  if (!crudo) throw new Error(motivoSinClave);

  let bytes;
  try {
    bytes = Buffer.from(crudo, 'base64');
  } catch {
    throw new Error('CLAVE_CIFRADO no es base64 valido');
  }
  if (bytes.length !== 32) {
    /* Se dice cuantos bytes tiene, no cuales: el largo ayuda a
       arreglarlo y no revela nada del contenido. */
    throw new Error(`CLAVE_CIFRADO tiene ${bytes.length} bytes y necesita 32`);
  }

  clave = bytes;
  return clave;
}

/** Para que el arranque avise si falta la clave, sin romper. */
export function hayClave() {
  try { cargarClave(); return true; }
  catch (e) { motivoSinClave = e.message; return false; }
}

export const porQueNoHayClave = () => motivoSinClave;

/**
 * Cifra un texto. Devuelve el blob que se guarda en la base.
 * @param {string} texto
 * @returns {string}
 */
export function cifrar(texto) {
  const k = cargarClave();
  const iv = crypto.randomBytes(BYTES_IV);
  const c = crypto.createCipheriv(ALGORITMO, k, iv);
  const secreto = Buffer.concat([c.update(String(texto), 'utf8'), c.final()]);
  const tag = c.getAuthTag();
  return `${VERSION}.${Buffer.concat([iv, tag, secreto]).toString('base64url')}`;
}

/**
 * Descifra un blob de `cifrar`. Tira si fue tocado o si la clave
 * cambio: eso es lo que queremos, un token adulterado no se usa.
 * @param {string} blob
 * @returns {string}
 */
export function descifrar(blob) {
  const k = cargarClave();
  if (typeof blob !== 'string') throw new Error('el blob cifrado no es texto');

  const punto = blob.indexOf('.');
  if (punto < 0) throw new Error('blob cifrado sin version');
  const version = blob.slice(0, punto);
  if (version !== VERSION) throw new Error(`version de cifrado desconocida: ${version}`);

  const bytes = Buffer.from(blob.slice(punto + 1), 'base64url');
  if (bytes.length < BYTES_IV + BYTES_TAG) throw new Error('blob cifrado demasiado corto');

  const iv      = bytes.subarray(0, BYTES_IV);
  const tag     = bytes.subarray(BYTES_IV, BYTES_IV + BYTES_TAG);
  const secreto = bytes.subarray(BYTES_IV + BYTES_TAG);

  const d = crypto.createDecipheriv(ALGORITMO, k, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(secreto), d.final()]).toString('utf8');
}

/**
 * HMAC-SHA256 con la misma clave, para firmar cookies.
 *
 * Comparte la clave con el cifrado a proposito: es un secreto menos
 * que cargar en Railway y un secreto menos que perder. Los usos estan
 * separados por el prefijo de contexto, asi una firma de cookie no
 * puede reusarse como ninguna otra cosa.
 */
export function firmar(contexto, texto) {
  const k = cargarClave();
  return crypto.createHmac('sha256', k)
    .update(`${contexto}:${texto}`)
    .digest('base64url');
}

/** Compara firmas en tiempo constante: comparar con === filtra. */
export function firmaValida(contexto, texto, firmaDada) {
  let esperada;
  try { esperada = firmar(contexto, texto); }
  catch { return false; }
  const a = Buffer.from(esperada);
  const b = Buffer.from(String(firmaDada ?? ''));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
