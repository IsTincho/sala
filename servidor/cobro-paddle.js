/* ============================================================
   Paddle Billing: checkout alojado y webhook firmado.

   Se implementa la interfaz de `cobro.js` y nada mas. Todo lo que este
   archivo sabe de Paddle se queda adentro de este archivo.

   ---------------------------------------------------------------
   COMO VUELVE EL SLUG

   Paddle no sabe nada de canales de Kick. La unica forma de saber a
   quien corresponde un pago es mandarle un dato nuestro cuando se crea
   la transaccion y leerlo cuando vuelve el webhook: `custom_data`.

   Es EL punto delicado de la integracion. Si el slug no vuelve, el
   pago entra, el dinero se cobra y el plan no cambia: el creador paga
   y no puede reproducir. Por eso `crearCheckout` falla ruidoso si no
   tiene un slug valido que mandar, en vez de crear una transaccion
   huerfana que despues no se pueda atribuir.

   ---------------------------------------------------------------
   LA FIRMA

   Cabecera `Paddle-Signature`, con la forma

       ts=1671552777;h1=eb4d0dc8853be92b...

   Se firma `{ts}:{cuerpo crudo}` con HMAC-SHA256 y la clave secreta de
   la notificacion (la que empieza con `pdl_ntfset_`), y se compara en
   tiempo constante.
   Fuente: developer.paddle.com/webhooks/signature-verification

   ---------------------------------------------------------------
   LA VENTANA DE TIEMPO, Y POR QUE NO SON 5 SEGUNDOS

   Paddle documenta 5 segundos de tolerancia y sus SDK usan ese numero.
   Aca el default son 60, y la diferencia es a proposito.

   Con 5 segundos, un contenedor con el reloj corrido diez segundos
   rechaza TODOS los webhooks: el plan de todos los que pagan deja de
   actualizarse y el sintoma es "pague y no anda", el peor de todos.
   Fallar cerrado sirve cuando lo que se protege se pierde al fallar
   abierto, y aca no se pierde nada: todos los campos de un evento de
   Paddle son ABSOLUTOS (el estado de la suscripcion y su
   `next_billed_at` vienen adentro), asi que reprocesar un evento
   viejo escribe exactamente lo mismo que escribio la primera vez. Un
   repetido no extiende nada, porque el vencimiento no se calcula
   desde "ahora": se copia del payload.

   Lo que la ventana sigue atajando es un evento capturado hace meses,
   que ya no describe el estado de hoy. Sesenta segundos alcanzan de
   sobra para eso. Se puede cambiar con PADDLE_TOLERANCIA_S.
   ============================================================ */

import crypto from 'node:crypto';

import { numeroDeEntorno } from './entorno.js';

export const nombre = 'paddle';

const leer = n => String(process.env[n] ?? '').trim();

const API = () =>
  (leer('PADDLE_ENTORNO').toLowerCase() === 'produccion'
    ? 'https://api.paddle.com'
    : 'https://sandbox-api.paddle.com');

/* Sandbox por defecto. Que el descuido rompa una prueba y no cobre de
   verdad: es la misma regla que MODO=produccion por defecto en
   index.js, mirada desde el otro lado. */
export const entorno = () =>
  (leer('PADDLE_ENTORNO').toLowerCase() === 'produccion' ? 'produccion' : 'sandbox');

/* El piso es cero: `PADDLE_TOLERANCIA_S=0` es "sin tolerancia de
   reloj", que es una eleccion y no un error. Lo que NO puede pasar es
   que un typo lo deje en NaN, porque `Math.abs(dif) > NaN` es false
   siempre y eso convierte la ventana de tolerancia en INFINITA: un
   webhook viejo pasaria a valer para siempre. */
export const TOLERANCIA = () => numeroDeEntorno('PADDLE_TOLERANCIA_S', 60, { minimo: 0 }) * 1000;

export const listo = () => Boolean(leer('PADDLE_API_KEY') && leer('PADDLE_PRECIO_ID'));

export function porQueNoEstaListo() {
  const faltan = [];
  if (!leer('PADDLE_API_KEY')) faltan.push('PADDLE_API_KEY');
  if (!leer('PADDLE_PRECIO_ID')) faltan.push('PADDLE_PRECIO_ID');
  if (!leer('PADDLE_CLAVE_WEBHOOK')) faltan.push('PADDLE_CLAVE_WEBHOOK (sin ella no se puede recibir el aviso de pago)');
  if (!faltan.length) return '';
  return `faltan ${faltan.join(', ')} en Railway`;
}

/* -------------------------------------------------------- checkout */

/**
 * Crea una transaccion en Paddle y devuelve la URL del checkout
 * alojado.
 *
 * Alojado y no incrustado: incrustar el checkout significa cargar el
 * JS de Paddle en nuestra pagina, o sea un script de un tercero en el
 * mismo origen donde vive la cookie de sesion. El alojado son cero
 * scripts de afuera y un link.
 */
export async function crearCheckout(creador) {
  if (!listo()) throw new Error(porQueNoEstaListo());

  const slug = String(creador?.slug ?? '').toLowerCase();
  if (!slug) throw new Error('no se puede cobrar sin saber de que sala es');

  const r = await fetch(`${API()}/transactions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${leer('PADDLE_API_KEY')}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      items: [{ price_id: leer('PADDLE_PRECIO_ID'), quantity: 1 }],
      /* Lo unico nuestro que viaja: el slug. Vuelve tal cual en cada
         evento de la suscripcion que salga de esta transaccion. */
      custom_data: { slug, servicio: 'sala' },
    }),
  });

  const texto = await r.text();
  if (!r.ok) {
    /* El cuerpo del error de Paddle puede traer datos de la cuenta; se
       recorta y no se le confia el largo a nadie. */
    const e = new Error(`Paddle contesto ${r.status}: ${texto.slice(0, 200)}`);
    e.status = r.status;
    throw e;
  }

  let datos;
  try { datos = JSON.parse(texto); }
  catch { throw new Error('Paddle contesto algo que no es JSON'); }

  const url = datos?.data?.checkout?.url ?? '';
  if (!url) throw new Error('Paddle no devolvio una URL de checkout');
  return { url, transaccionId: String(datos?.data?.id ?? '') };
}

/* --------------------------------------------------------- webhook */

/** Parte `ts=…;h1=…` en sus dos campos. Devuelve null si no se entiende. */
export function partirFirma(cabecera) {
  const partes = String(cabecera ?? '').split(';');
  const campos = {};
  for (const p of partes) {
    const i = p.indexOf('=');
    if (i <= 0) continue;
    campos[p.slice(0, i).trim()] = p.slice(i + 1).trim();
  }
  if (!campos.ts || !campos.h1) return null;
  if (!/^\d{1,15}$/.test(campos.ts)) return null;
  if (!/^[0-9a-f]{64}$/i.test(campos.h1)) return null;
  return { ts: campos.ts, h1: campos.h1 };
}

/**
 * Si la firma de un webhook de Paddle es buena.
 *
 * El cuerpo tiene que ser el CRUDO. Se compara con timingSafeEqual: la
 * diferencia de tiempo entre "el primer byte no coincide" y "los
 * primeros treinta si" es medible por la red.
 */
export function firmaValida(cabecera, crudo, ahora = Date.now(), secreto = leer('PADDLE_CLAVE_WEBHOOK')) {
  if (!secreto) return false;
  const partida = partirFirma(cabecera);
  if (!partida) return false;

  const desfase = Math.abs(ahora - Number(partida.ts) * 1000);
  if (desfase > TOLERANCIA()) return false;

  const cuerpo = Buffer.isBuffer(crudo) ? crudo : Buffer.from(String(crudo ?? ''), 'utf8');
  const esperada = crypto
    .createHmac('sha256', secreto)
    .update(Buffer.concat([Buffer.from(`${partida.ts}:`, 'utf8'), cuerpo]))
    .digest('hex');

  const a = Buffer.from(esperada, 'utf8');
  const b = Buffer.from(partida.h1.toLowerCase(), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/* Que plan deja cada estado de suscripcion de Paddle.

   `past_due` sigue como 'pago' A PROPOSITO: es un cobro que fallo y
   que Paddle va a reintentar durante dias. Cortarle el servicio en el
   primer rechazo a alguien cuya tarjeta se vencio es perder al cliente
   por un tramite. Igual no queda abierto para siempre: el
   `next_billed_at` que ya estaba guardado se pasa, y `creadores.planDe`
   lo baja a 'vencido' solo.

   `trialing` es 'pago' porque el servicio se da; que Paddle no haya
   cobrado todavia es problema de Paddle. */
const PLAN_POR_ESTADO = {
  active: 'pago',
  trialing: 'pago',
  past_due: 'pago',
  paused: 'vencido',
  canceled: 'vencido',
};

/* Los eventos que se miran. El resto se contesta 200 y se ignora: un
   4xx haria que Paddle lo reintente para siempre por algo que no nos
   interesa. */
const EVENTOS = new Set([
  'subscription.created',
  'subscription.activated',
  'subscription.updated',
  'subscription.resumed',
  'subscription.paused',
  'subscription.canceled',
  'subscription.past_due',
  'subscription.trialing',
]);

/* Dos dias de gracia despues de la fecha de cobro. Paddle cobra el dia
   que le toca pero el webhook de la renovacion puede tardar, y sin
   gracia el creador se quedaria sin servicio en la ventana entre que
   vence y que llega el aviso. */
const GRACIA = 2 * 24 * 60 * 60 * 1000;

/**
 * Un webhook de Paddle.
 *
 * @param {{cabeceras:object, crudo:Buffer|string, ahora?:number}} pedido
 * @returns {{ok:boolean, slug?:string, plan?:string, vence?:number, motivo?:string, evento?:string}}
 */
export async function procesarWebhook({ cabeceras = {}, crudo = '', ahora = Date.now() } = {}) {
  if (!leer('PADDLE_CLAVE_WEBHOOK')) {
    return { ok: false, motivo: 'falta PADDLE_CLAVE_WEBHOOK' };
  }
  /* Node baja los nombres de cabecera a minusculas. */
  if (!firmaValida(cabeceras['paddle-signature'], crudo, ahora)) {
    return { ok: false, motivo: 'firma invalida' };
  }

  let cuerpo;
  try { cuerpo = JSON.parse(Buffer.isBuffer(crudo) ? crudo.toString('utf8') : String(crudo)); }
  catch { return { ok: false, motivo: 'json invalido' }; }

  const evento = String(cuerpo?.event_type ?? '');
  if (!EVENTOS.has(evento)) return { ok: true, ignorado: true, evento };

  const datos = cuerpo?.data ?? {};
  const slug = String(datos?.custom_data?.slug ?? '').toLowerCase();
  if (!slug) {
    /* Sin slug no hay a quien atribuirle el pago. Se avisa fuerte: es
       plata cobrada sin efecto, y el unico rastro es este log. */
    return { ok: false, motivo: 'el evento no trae custom_data.slug', evento };
  }

  const estado = String(datos?.status ?? '');
  const plan = PLAN_POR_ESTADO[estado];
  if (!plan) return { ok: true, ignorado: true, evento, motivo: `estado desconocido: ${estado}` };

  /* El vencimiento sale del payload, NUNCA de "ahora + 30 dias". Es lo
     que hace que reprocesar un evento repetido no regale un mes. */
  const hasta = Date.parse(datos?.next_billed_at ?? datos?.current_billing_period?.ends_at ?? '');
  const vence = Number.isFinite(hasta) ? hasta + GRACIA : 0;

  return {
    ok: true,
    evento,
    slug,
    plan,
    vence: plan === 'pago' ? vence : 0,
    clienteId: String(datos?.customer_id ?? ''),
    suscripcionId: String(datos?.id ?? ''),
  };
}
