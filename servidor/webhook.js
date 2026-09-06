/* ============================================================
   Recepcion y verificacion de webhooks de Kick.

   Kick firma cada webhook con RSA-2048. Se firma la cadena

       {Kick-Event-Message-Id}.{Kick-Event-Message-Timestamp}.{body crudo}

   con SHA-256 y padding PKCS#1 v1.5, y se manda en base64 en el header
   Kick-Event-Signature.

   Sin esta verificacion, cualquiera que descubra la URL podria
   inventarnos mensajes de chat: en Sala eso es peor que en un overlay,
   porque el chat inventado se le muestra a todo el que este viendo la
   peli. Un webhook que no valida se descarta y punto.

   EL BODY TIENE QUE SER EL CRUDO. Si se parsea el JSON y se vuelve a
   serializar para verificar, cambia un espacio y la firma no da. Por
   eso el enrutador lee el cuerpo como texto y recien despues de
   verificar lo parsea.
   ============================================================ */

import crypto from 'node:crypto';

const URL_CLAVE = 'https://api.kick.com/public/v1/public-key';

let clave = null;

/**
 * Fija la clave publica a mano. Solo la usan los tests, que firman un
 * fixture con un par de claves generado al vuelo: la privada de Kick
 * no existe de este lado y una privada de prueba NO se guarda en el
 * repo ni para tests, asi no hay ninguna clave privada versionada que
 * despues alguien confunda con algo real.
 */
export function fijarClavePublica(pem) {
  clave = pem;
}

export async function clavePublica() {
  if (clave) return clave;
  const r = await fetch(URL_CLAVE, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`public-key ${r.status}`);
  const d = await r.json();
  clave = d?.data?.public_key ?? d?.public_key ?? null;
  if (!clave) throw new Error('la respuesta de public-key no traia la clave');
  return clave;
}

/**
 * @param {Record<string,string>} headers  headers en minuscula, como los da node
 * @param {string} crudo                   body tal cual llego, sin parsear
 */
export async function verificar(headers, crudo) {
  const id    = headers['kick-event-message-id'];
  const ts    = headers['kick-event-message-timestamp'];
  const firma = headers['kick-event-signature'];
  if (!id || !ts || !firma) return false;

  let pem;
  try { pem = await clavePublica(); }
  catch (e) { console.error('[webhook] no se pudo traer la clave:', e.message); return false; }

  try {
    const v = crypto.createVerify('RSA-SHA256');   // PKCS#1 v1.5 es el default
    v.update(`${id}.${ts}.${crudo}`);
    v.end();
    return v.verify(pem, Buffer.from(firma, 'base64'));
  } catch (e) {
    console.error('[webhook] error verificando:', e.message);
    return false;
  }
}

/**
 * Los datos utiles de los headers de un webhook, ya normalizados.
 * Son seis; el que mas importa es el id, que es la clave de
 * idempotencia.
 */
export const datosDelEvento = headers => ({
  id: headers['kick-event-message-id'] ?? '',
  suscripcion: headers['kick-event-subscription-id'] ?? '',
  tipo: headers['kick-event-type'] ?? '',
  version: headers['kick-event-version'] ?? '',
  cuando: headers['kick-event-message-timestamp'] ?? '',
});

/* --------------------------------------------------------------------
   Kick puede reintentar un envio: hay que procesar cada mensaje una
   sola vez. Guardamos los ultimos ids vistos.
   -------------------------------------------------------------------- */

const VISTOS = new Set();
const TOPE = 500;

export function yaVisto(id) {
  if (!id) return false;
  if (VISTOS.has(id)) return true;
  VISTOS.add(id);
  if (VISTOS.size > TOPE) {
    // Set conserva orden de insercion: tiramos los mas viejos
    for (const v of VISTOS) {
      VISTOS.delete(v);
      if (VISTOS.size <= TOPE) break;
    }
  }
  return false;
}

/** Solo para los tests: borra la memoria de ids vistos. */
export function olvidarVistos() {
  VISTOS.clear();
}
