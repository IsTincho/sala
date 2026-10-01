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
/* Si la clave la puso un test a mano: esa no se vuelve a pedir nunca. */
let claveFijada = false;
let ultimaRenovacion = 0;
/* Como mucho una renovacion por minuto: una firma invalida puede ser
   alguien probando la URL, y cada intento no puede ser un pedido a Kick. */
const ENTRE_RENOVACIONES = 60_000;

/**
 * Fija la clave publica a mano. Solo la usan los tests, que firman un
 * fixture con un par de claves generado al vuelo: la privada de Kick
 * no existe de este lado y una privada de prueba NO se guarda en el
 * repo ni para tests, asi no hay ninguna clave privada versionada que
 * despues alguien confunda con algo real.
 */
export function fijarClavePublica(pem) {
  clave = pem;
  claveFijada = Boolean(pem);
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
 * @param {Buffer|string} crudo            body tal cual llego, sin parsear
 *
 * `crudo` es preferentemente un Buffer: lo que Kick firmo son BYTES.
 * Se acepta string por comodidad de los tests, pero el camino de
 * produccion pasa bytes de punta a punta y nunca los decodifica, asi
 * un cuerpo que no sea UTF-8 perfecto igual verifica bien.
 */
/* ANTES ESTO FALLABA EN SILENCIO, y es la peor forma de fallar de todo
   el servicio: un webhook que no verifica se contesta 401 y el chat de
   Kick queda mudo, mientras Twitch (que entra por otro lado) sigue
   andando y hace parecer que todo esta bien. Ahora cada rechazo dice
   por que en el log, como mucho una vez por minuto por motivo. */
const ultimoAviso = new Map();
function avisarRechazo(motivo) {
  const ahora = Date.now();
  if (ahora - (ultimoAviso.get(motivo) ?? 0) < 60_000) return;
  ultimoAviso.set(motivo, ahora);
  console.warn(`[webhook] rechazado (401): ${motivo}`);
}

function firmaValida(pem, id, ts, firma, crudo) {
  const cuerpo = Buffer.isBuffer(crudo) ? crudo : Buffer.from(String(crudo), 'utf8');
  const v = crypto.createVerify('RSA-SHA256');   // PKCS#1 v1.5 es el default
  v.update(Buffer.concat([Buffer.from(`${id}.${ts}.`, 'utf8'), cuerpo]));
  v.end();
  return v.verify(pem, Buffer.from(firma, 'base64'));
}

export async function verificar(headers, crudo) {
  const id    = headers['kick-event-message-id'];
  const ts    = headers['kick-event-message-timestamp'];
  const firma = headers['kick-event-signature'];
  if (!id || !ts || !firma) { avisarRechazo('faltan los headers de la firma de Kick'); return false; }

  let pem;
  try { pem = await clavePublica(); }
  catch (e) { console.error('[webhook] no se pudo traer la clave:', e.message); return false; }

  try {
    if (firmaValida(pem, id, ts, firma, crudo)) return true;

    /* LA CLAVE GUARDADA PUEDE HABER VENCIDO. Se pedia una sola vez por
       arranque y se usaba para siempre: si Kick la cambia, TODOS los
       webhooks dan invalidos hasta el proximo deploy. Ante una firma
       que no da, se vuelve a pedir (una vez por minuto como mucho) y
       se prueba de nuevo con la nueva. */
    if (!claveFijada && Date.now() - ultimaRenovacion > ENTRE_RENOVACIONES) {
      ultimaRenovacion = Date.now();
      const vieja = clave;
      clave = null;
      try {
        const nueva = await clavePublica();
        if (nueva !== vieja) {
          console.warn('[webhook] Kick cambio su clave publica: se renovo');
          if (firmaValida(nueva, id, ts, firma, crudo)) return true;
        }
      } catch (e) {
        clave = vieja;   // sin clave nueva, la de antes es mejor que ninguna
        console.error('[webhook] no se pudo renovar la clave:', e.message);
      }
    }
    avisarRechazo('la firma no coincide con la clave publica de Kick');
    return false;
  } catch (e) {
    console.error('[webhook] error verificando:', e.message);
    return false;
  }
}

/* --------------------------------------------------------------------
   Ventana de antiguedad.

   Una firma RSA no vence: el que capture un webhook valido lo puede
   reenviar dentro de un año y va a verificar igual. Lo unico que lo
   atajaba era el anillo de 500 ids, que se vacia solo despues de 500
   mensajes: en un chat movido, eso es media hora.

   Diez minutos es holgado a proposito. Kick tiene reportes abiertos de
   entregas que se atrasan (KickDevDocs #300) y el reloj del contenedor
   puede ir corrido; una ventana apretada convertiria un webhook lento
   pero legitimo en un mensaje perdido. Se tolera el mismo margen hacia
   adelante por si el reloj de Kick va adelantado respecto del nuestro.
   -------------------------------------------------------------------- */

export const VENTANA_EVENTO = 10 * 60 * 1000;

/* Kick documenta el timestamp en ISO 8601, que es lo que manda hoy. Se
   aceptan tambien los dos formatos de epoch por si algun dia cambia:
   equivocarse en el formato significaria descartar TODOS los webhooks. */
function momentoDe(cuando) {
  if (typeof cuando === 'number') return cuando;
  const s = String(cuando ?? '').trim();
  if (!s) return NaN;
  if (/^\d{10}$/.test(s)) return Number(s) * 1000;   // epoch en segundos
  if (/^\d{13}$/.test(s)) return Number(s);          // epoch en milisegundos
  return Date.parse(s);
}

let yaAvisoDelFormato = false;

/**
 * Si el evento es lo bastante nuevo como para procesarlo.
 *
 * Cuando la fecha no se puede leer, contesta que SI y avisa una vez.
 * Es a proposito, y es la unica parte de esta verificacion que no falla
 * cerrada: el timestamp entra en la firma, o sea que es autentico
 * aunque no lo entendamos. Si Kick cambiara el formato, fallar cerrado
 * dejaria el chat mudo al 100% y con un log que dice "viejo" sobre algo
 * que no es viejo; fallar abierto deja el servicio exactamente como
 * estaba antes de esta ventana, con el dedupe por id como unica
 * defensa, y un aviso en los logs para arreglarlo.
 *
 * @param {string} cuando  el header Kick-Event-Message-Timestamp
 */
export function esReciente(cuando, ahora = Date.now(), ventana = VENTANA_EVENTO) {
  const t = momentoDe(cuando);
  if (!Number.isFinite(t)) {
    if (!yaAvisoDelFormato) {
      yaAvisoDelFormato = true;
      console.warn(`[webhook] no entiendo el formato de Kick-Event-Message-Timestamp ` +
                   `(${JSON.stringify(String(cuando ?? ''))}): se deja pasar y se pierde ` +
                   `la ventana de antiguedad. Hay que actualizar momentoDe().`);
    }
    return true;
  }
  return Math.abs(ahora - t) <= ventana;
}

/** Solo para los tests: vuelve a habilitar el aviso de formato raro. */
export function olvidarAvisoDeFormato() {
  yaAvisoDelFormato = false;
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

/**
 * Saca un id de la memoria de vistos.
 *
 * `yaVisto` marca ANTES de procesar, a proposito: asi dos entregas
 * simultaneas del mismo evento no se procesan las dos. Pero si el
 * procesamiento falla, la marca tiene que irse: el reintento de Kick
 * se contestaria "repetido" y el evento se perderia sin que nadie se
 * entere. Quien procesa llama a esto en su catch.
 */
export function olvidar(id) {
  return VISTOS.delete(id);
}

/** Solo para los tests: borra la memoria de ids vistos. */
export function olvidarVistos() {
  VISTOS.clear();
}
