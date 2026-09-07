/* ============================================================
   El cobro: la interfaz y la implementacion de Paddle.

   NADA DE ESTO SE PROBO CONTRA PADDLE. No hay claves (tarea 14 de
   TAREAS-DUENO.md) y no se piden. Lo que se prueba es lo que se puede
   probar sin ellas, que resulta ser casi todo lo que puede salir mal:

     - que sin claves el modulo arranque y diga que le falta, en vez de
       explotar cuando alguien toque el boton;
     - que una firma valida se acepte y CUALQUIER cambio en el cuerpo o
       en la firma se rechace;
     - que el slug vuelva por `custom_data` y sin el no se toque ningun
       plan;
     - que el vencimiento salga del payload y no de "ahora", que es lo
       que hace que un evento repetido no regale un mes.

   Lo que queda sin verificar y hay que mirar el dia de la primera
   prueba en sandbox: que `POST /transactions` acepte este cuerpo, que
   `data.checkout.url` sea el campo, y que los `event_type` se llamen
   asi.
   ============================================================ */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

/* Claves de mentira, inventadas en este archivo y que no salen de este
   proceso. La del webhook tiene la forma que usa Paddle (`pdl_ntfset_`)
   solo para que se lea como lo que es. */
const CLAVE = 'pdl_ntfset_esto-es-de-mentira-no-es-una-clave';
process.env.PADDLE_CLAVE_WEBHOOK = CLAVE;
process.env.PADDLE_API_KEY = 'pdl_apikey_de_mentira';
process.env.PADDLE_PRECIO_ID = 'pri_de_mentira';
process.env.PRECIO_MENSUAL = '5';
process.env.MONEDA = 'usd';

const paddle = await import('../servidor/cobro-paddle.js');
const cobro = await import('../servidor/cobro.js');

/* ------------------------------------------------------------ ayudas */

const AHORA = 1_760_000_000_000;

/** Firma un cuerpo como lo firma Paddle. */
function firmar(cuerpo, { ts = Math.floor(AHORA / 1000), clave = CLAVE } = {}) {
  const h1 = crypto.createHmac('sha256', clave).update(`${ts}:${cuerpo}`).digest('hex');
  return `ts=${ts};h1=${h1}`;
}

const eventoSuscripcion = (estado, extra = {}) => JSON.stringify({
  event_id: 'evt_1',
  event_type: 'subscription.updated',
  data: {
    id: 'sub_1',
    status: estado,
    customer_id: 'ctm_1',
    custom_data: { slug: 'ana', servicio: 'sala' },
    next_billed_at: '2026-10-07T12:00:00Z',
    ...extra,
  },
});

const mandar = (cuerpo, cabecera, ahora = AHORA) =>
  paddle.procesarWebhook({ cabeceras: { 'paddle-signature': cabecera }, crudo: cuerpo, ahora });

/* ------------------------------------------------------- la interfaz */

test('cobro.js elige la implementacion por variable y cae en "ninguno" si no la conoce', async () => {
  const antes = process.env.COBRO_PROVEEDOR;
  try {
    delete process.env.COBRO_PROVEEDOR;
    assert.equal(cobro.proveedor(), 'paddle', 'Paddle por defecto: es contra lo que esta construido');

    process.env.COBRO_PROVEEDOR = 'stripe';
    assert.equal(cobro.proveedor(), 'ninguno',
      'un proveedor que todavia no existe no puede hacerse pasar por uno que si');
    assert.equal(cobro.listo(), false);
    assert.match(cobro.porQueNoEstaListo(), /COBRO_PROVEEDOR/);
    await assert.rejects(() => cobro.crearCheckout({ slug: 'ana' }), /no hay proveedor/);
    assert.equal((await cobro.procesarWebhook({})).ok, false);
  } finally {
    if (antes === undefined) delete process.env.COBRO_PROVEEDOR;
    else process.env.COBRO_PROVEEDOR = antes;
  }
});

test('sin claves dice cual falta, con el nombre exacto y sin el valor de ninguna', () => {
  const guardadas = { ...process.env };
  try {
    delete process.env.PADDLE_API_KEY;
    delete process.env.PADDLE_PRECIO_ID;
    assert.equal(paddle.listo(), false);
    const falta = paddle.porQueNoEstaListo();
    assert.match(falta, /PADDLE_API_KEY/);
    assert.match(falta, /PADDLE_PRECIO_ID/);
    assert.ok(!falta.includes(CLAVE), 'nunca el valor de una clave');
  } finally {
    process.env.PADDLE_API_KEY = guardadas.PADDLE_API_KEY;
    process.env.PADDLE_PRECIO_ID = guardadas.PADDLE_PRECIO_ID;
  }
});

test('el entorno es sandbox salvo que se diga produccion con todas las letras', () => {
  const antes = process.env.PADDLE_ENTORNO;
  try {
    delete process.env.PADDLE_ENTORNO;
    assert.equal(paddle.entorno(), 'sandbox', 'el descuido tiene que romper una prueba, no cobrar');
    process.env.PADDLE_ENTORNO = 'prod';
    assert.equal(paddle.entorno(), 'sandbox', 'y "prod" no alcanza');
    process.env.PADDLE_ENTORNO = 'produccion';
    assert.equal(paddle.entorno(), 'produccion');
  } finally {
    if (antes === undefined) delete process.env.PADDLE_ENTORNO;
    else process.env.PADDLE_ENTORNO = antes;
  }
});

test('el precio que se muestra sale de las variables', () => {
  assert.deepEqual(cobro.precio(), { monto: 5, moneda: 'USD' });
});

/* ---------------------------------------------------------- la firma */

test('partirFirma entiende la cabecera de Paddle y rechaza lo que no lo es', () => {
  assert.deepEqual(paddle.partirFirma(`ts=123;h1=${'a'.repeat(64)}`), { ts: '123', h1: 'a'.repeat(64) });
  assert.equal(paddle.partirFirma(''), null);
  assert.equal(paddle.partirFirma('ts=123'), null, 'sin h1 no hay firma');
  assert.equal(paddle.partirFirma(`h1=${'a'.repeat(64)}`), null, 'sin ts no se puede verificar');
  assert.equal(paddle.partirFirma('ts=noesunnumero;h1=' + 'a'.repeat(64)), null);
  assert.equal(paddle.partirFirma('ts=123;h1=corta'), null, 'un sha256 son 64 hex');
  assert.equal(paddle.partirFirma(null), null);
});

test('una firma buena se acepta', () => {
  const cuerpo = eventoSuscripcion('active');
  assert.equal(paddle.firmaValida(firmar(cuerpo), cuerpo, AHORA), true);
});

test('cambiar un byte del cuerpo tira la firma abajo', () => {
  /* El caso que importa: el que intercepta un webhook y le cambia el
     slug para hacerse pagar el plan por otro. */
  const cuerpo = eventoSuscripcion('active');
  const cabecera = firmar(cuerpo);
  const cambiado = cuerpo.replace('"slug":"ana"', '"slug":"beto"');
  assert.notEqual(cambiado, cuerpo, 'el test tiene que estar cambiando algo de verdad');
  assert.equal(paddle.firmaValida(cabecera, cambiado, AHORA), false);
});

test('una firma hecha con otra clave se rechaza', () => {
  const cuerpo = eventoSuscripcion('active');
  const cabecera = firmar(cuerpo, { clave: 'pdl_ntfset_otra-cosa' });
  assert.equal(paddle.firmaValida(cabecera, cuerpo, AHORA), false);
});

test('la firma se calcula sobre ts:cuerpo y no sobre el cuerpo solo', () => {
  /* Es el error clasico de esta integracion, y falla abierto: si se
     firmara solo el cuerpo, un webhook capturado valdria para siempre
     porque el ts dejaria de estar atado a la firma. */
  const cuerpo = eventoSuscripcion('active');
  const soloElCuerpo = crypto.createHmac('sha256', CLAVE).update(cuerpo).digest('hex');
  assert.equal(paddle.firmaValida(`ts=${Math.floor(AHORA / 1000)};h1=${soloElCuerpo}`, cuerpo, AHORA), false);
});

test('un evento viejo se rechaza por la ventana de tiempo', () => {
  const cuerpo = eventoSuscripcion('active');
  const viejo = Math.floor((AHORA - 10 * 60 * 1000) / 1000);
  assert.equal(paddle.firmaValida(firmar(cuerpo, { ts: viejo }), cuerpo, AHORA), false);
  /* Y uno de recien pasa, para que el arreglo no sea "rechazar todo". */
  assert.equal(paddle.firmaValida(firmar(cuerpo), cuerpo, AHORA), true);
});

test('sin PADDLE_CLAVE_WEBHOOK no se verifica nada y no se procesa nada', async () => {
  const antes = process.env.PADDLE_CLAVE_WEBHOOK;
  try {
    delete process.env.PADDLE_CLAVE_WEBHOOK;
    const cuerpo = eventoSuscripcion('active');
    /* Ojo: la firma se calcula con la clave de verdad, o sea que esto
       seria valido SI la clave estuviera cargada. Lo que se prueba es
       que sin clave se rechaza igual, en vez de dejar pasar todo. */
    const r = await mandar(cuerpo, firmar(cuerpo));
    assert.equal(r.ok, false);
    assert.match(r.motivo, /PADDLE_CLAVE_WEBHOOK/);
  } finally {
    process.env.PADDLE_CLAVE_WEBHOOK = antes;
  }
});

/* --------------------------------------------------------- el evento */

test('una suscripcion activa pasa el plan a "pago" con el vencimiento del payload', async () => {
  const cuerpo = eventoSuscripcion('active');
  const r = await mandar(cuerpo, firmar(cuerpo));

  assert.equal(r.ok, true);
  assert.equal(r.slug, 'ana');
  assert.equal(r.plan, 'pago');
  assert.equal(r.suscripcionId, 'sub_1');
  assert.equal(r.clienteId, 'ctm_1');

  /* EL VENCIMIENTO SALE DEL PAYLOAD, no de "ahora + un mes". Es lo que
     hace que reprocesar un evento repetido escriba exactamente lo
     mismo y no regale tiempo. Se comprueba contra la fecha del evento
     mas la gracia, no contra `Date.now()`. */
  const delPayload = Date.parse('2026-10-07T12:00:00Z');
  assert.ok(r.vence > delPayload, 'lleva la gracia de unos dias');
  assert.ok(r.vence < delPayload + 7 * 86400_000, 'pero no una gracia absurda');

  /* Y el mismo evento otra vez da EXACTAMENTE lo mismo. */
  const otra = await mandar(cuerpo, firmar(cuerpo), AHORA + 30_000);
  assert.equal(otra.vence, r.vence, 'un repetido no puede correr el vencimiento');
});

test('cada estado de Paddle se traduce al plan que corresponde', async () => {
  const casos = [
    ['active', 'pago'],
    ['trialing', 'pago'],
    /* Un cobro que fallo y que Paddle va a reintentar por dias:
       cortarle el servicio en el primer rechazo a alguien cuya tarjeta
       se vencio es perder al cliente por un tramite. El vencimiento
       que ya estaba guardado se pasa solo. */
    ['past_due', 'pago'],
    ['paused', 'vencido'],
    ['canceled', 'vencido'],
  ];
  for (const [estado, plan] of casos) {
    const cuerpo = eventoSuscripcion(estado);
    const r = await mandar(cuerpo, firmar(cuerpo));
    assert.equal(r.plan, plan, `${estado} tiene que dar ${plan}`);
  }
});

test('un estado que no conocemos no cambia ningun plan', async () => {
  const cuerpo = eventoSuscripcion('lo_que_sea');
  const r = await mandar(cuerpo, firmar(cuerpo));
  assert.equal(r.ok, true, 'se contesta 200 para que Paddle deje de reintentar');
  assert.equal(r.ignorado, true);
  assert.equal(r.plan, undefined, 'y sobre todo: no se decide un plan por las dudas');
});

test('un evento sin custom_data.slug no se atribuye a nadie', async () => {
  /* Es plata cobrada sin efecto: alguien pago y su plan no cambia. Se
     contesta que NO se pudo procesar para que quede el rastro, en vez
     de un 200 silencioso. */
  const cuerpo = JSON.stringify({
    event_type: 'subscription.updated',
    data: { id: 'sub_2', status: 'active', custom_data: {} },
  });
  const r = await mandar(cuerpo, firmar(cuerpo));
  assert.equal(r.ok, false);
  assert.match(r.motivo, /custom_data\.slug/);
});

test('un tipo de evento que no miramos se ignora sin error', async () => {
  const cuerpo = JSON.stringify({
    event_type: 'transaction.completed',
    data: { id: 'txn_1', custom_data: { slug: 'ana' } },
  });
  const r = await mandar(cuerpo, firmar(cuerpo));
  assert.equal(r.ok, true);
  assert.equal(r.ignorado, true);
});

test('un cuerpo que no es JSON se rechaza despues de verificar la firma', async () => {
  const cuerpo = 'esto no es json';
  const r = await mandar(cuerpo, firmar(cuerpo));
  assert.equal(r.ok, false);
  assert.match(r.motivo, /json/);
});

test('el cuerpo se verifica como BYTES: un emoji no rompe la firma', async () => {
  /* Mismo cuidado que en el webhook de Kick. Si el cuerpo se
     reserializara, un caracter multibyte partido entre dos paquetes
     TCP cambiaria la firma y el aviso de pago se perderia a veces. */
  const cuerpo = JSON.stringify({
    event_type: 'subscription.updated',
    data: { id: 'sub_3', status: 'active', custom_data: { slug: 'ana', nota: 'pagó 🎬' } },
  });
  const crudo = Buffer.from(cuerpo, 'utf8');
  const r = await paddle.procesarWebhook({
    cabeceras: { 'paddle-signature': firmar(cuerpo) },
    crudo,
    ahora: AHORA,
  });
  assert.equal(r.ok, true);
  assert.equal(r.plan, 'pago');
});

/* -------------------------------------------------------- el checkout */

test('crearCheckout no sale a internet sin un slug al que atribuirle el pago', async () => {
  /* Sin slug, la transaccion queda huerfana: se cobra y el webhook no
     tiene a quien darle el plan. Mejor no crearla. */
  await assert.rejects(() => paddle.crearCheckout({}), /sin saber de que sala/);
  await assert.rejects(() => paddle.crearCheckout({ slug: '' }), /sin saber de que sala/);
});

test('crearCheckout manda el slug en custom_data y devuelve la URL', async () => {
  const original = globalThis.fetch;
  let pedido = null;
  globalThis.fetch = async (url, opciones) => {
    pedido = { url: String(url), opciones };
    return new Response(JSON.stringify({
      data: { id: 'txn_9', checkout: { url: 'https://sandbox-pay.paddle.io/hsc_9' } },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const r = await paddle.crearCheckout({ slug: 'ana', nombre: 'Ana' });
    assert.equal(r.url, 'https://sandbox-pay.paddle.io/hsc_9');

    assert.match(pedido.url, /sandbox-api\.paddle\.com\/transactions$/,
      'sin PADDLE_ENTORNO=produccion tiene que ir al sandbox');
    const cuerpo = JSON.parse(pedido.opciones.body);
    assert.equal(cuerpo.custom_data.slug, 'ana',
      'sin esto el pago vuelve sin saber de quien es');
    assert.equal(cuerpo.items[0].price_id, 'pri_de_mentira');
    assert.match(pedido.opciones.headers.Authorization, /^Bearer /);
  } finally {
    globalThis.fetch = original;
  }
});

test('si Paddle contesta mal, el error no arrastra la clave', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('{"error":"nope"}', { status: 403 });
  try {
    await assert.rejects(
      () => paddle.crearCheckout({ slug: 'ana' }),
      e => {
        assert.equal(e.status, 403);
        assert.ok(!String(e.message).includes(process.env.PADDLE_API_KEY),
          'el mensaje de error se muestra en pantalla: no puede llevar la clave');
        return true;
      });
  } finally {
    globalThis.fetch = original;
  }
});
