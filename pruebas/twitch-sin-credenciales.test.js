/* ============================================================
   Sin TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET: los dos modulos que le
   piden cosas publicas a Helix —las insignias y los emotes nativos— se
   APAGAN SOLOS en vez de reintentar cada minuto para siempre.

   POR QUE ESTO ES UN ARCHIVO APARTE: las credenciales se leen cuando
   `twitch.js` se carga, y un `import('...?x=1')` da una instancia nueva
   del modulo que lo importa pero NO de sus dependencias. La unica forma
   de tener un `twitch.js` sin credenciales es un proceso donde nunca
   estuvieron, y `node --test` corre cada archivo en su propio proceso.

   QUE SE ROMPE SI ESTO NO SE CUMPLE: un deploy al que le falta una
   variable no se nota —el chat anda igual, sin imagenes— y por atras
   cada mensaje con insignias dispara un pedido a `id.twitch.tv` que va
   a fallar. Con 900 creadores eso es ruido en el log y cuota quemada
   para siempre, sin una sola linea que diga cual es el problema.

   Nada sale a internet: `fetch` esta falseado y ademas se cuenta CADA
   pedido, asi que si alguien rompe el corte se ve en el numero.
   ============================================================ */

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

/* NINGUNA credencial de Twitch, que es de lo que se trata esto. */
process.env.SALA_DATOS = path.join(os.tmpdir(), 'sala-pruebas-sin-credenciales');
process.env.KICK_SLUG = 'istincho';
process.env.CLAVE_CIFRADO = crypto.randomBytes(32).toString('base64');
delete process.env.TWITCH_CLIENT_ID;
delete process.env.TWITCH_CLIENT_SECRET;

const emotes = await import('../servidor/emotes.js');
const insignias = await import('../servidor/insignias.js');
const mensajes = await import('../servidor/mensajes.js');
const twitch = await import('../servidor/twitch.js');

const fetchDeVerdad = globalThis.fetch;

let pedidos = [];
globalThis.fetch = async (recurso) => {
  const url = String(recurso);
  pedidos.push(url);
  /* Un 500 y no un 200: si algo se escapa del corte, que la prueba lo
     vea por el numero de pedidos y no por una respuesta que anda. */
  return new Response(JSON.stringify({ error: 'nadie tendria que haber pedido esto' }), { status: 500 });
};

const deTwitch = (badges) => mensajes.deTwitch({
  message_id: `t-${Math.random()}`,
  chatter_user_name: 'Fulana',
  chatter_user_id: '909',
  badges,
  message: { text: 'hola', fragments: [{ type: 'text', text: 'hola' }] },
}, { message_timestamp: new Date().toISOString() });

/* Los dos modulos tienen Twitch vinculado: lo que falta son las
   credenciales de LA APP, que es otra cosa. Sin esto la prueba pasaria
   por el camino de "este creador no tiene Twitch". */
const identidad = async (slug, red) =>
  (red === 'twitch' ? { red, sala: slug, usuarioId: '5555' } : null);
insignias.fijarIdentidad(identidad);
emotes.fijarIdentidad(identidad);

const aTwitch = u => u.includes('twitch.tv');

test.after(() => {
  globalThis.fetch = fetchDeVerdad;
});

test('sin credenciales de la app, hayCredenciales lo dice', () => {
  assert.equal(twitch.hayCredenciales(), false);
});

test('las insignias se apagan solas: sin imagen, sin pedido y sin reintentar', async () => {
  insignias.olvidarTodo();
  pedidos = [];

  const m = insignias.resolver(deTwitch([{ set_id: 'moderator', id: '1', info: '' }]), 'istincho');
  await insignias.reposo();
  insignias.resolver(m, 'istincho');

  assert.equal(m.insignias[0].url, '', 'sin imagen: la pagina muestra la etiqueta de siempre');
  assert.equal(m.insignias[0].texto, 'Mod', 'que sigue estando');
  assert.deepEqual(pedidos.filter(aTwitch), [], 'no se pide un token que no se puede pedir');

  /* Y LA PARTE QUE IMPORTA: cuenta como "no tiene" (una hora) y no como
     un fallo (un minuto). Un fallo aca seria un pedido por minuto por
     creador, para siempre, por una variable que falta. */
  const c = insignias.comoEsta('istincho');
  assert.equal(c.estado, 'sin-propias');
  assert.ok(c.vence - Date.now() > insignias.REINTENTO * 10,
    `vence en ${c.vence - Date.now()} ms y tendria que ser la hora de "no tiene"`);
});

test('doscientos mensajes con insignias no son doscientos pedidos', async () => {
  insignias.olvidarTodo();
  pedidos = [];

  for (let i = 0; i < 200; i++) {
    insignias.resolver(deTwitch([{ set_id: 'vip', id: '1', info: '' }]), 'istincho');
    await insignias.reposo();
  }

  assert.deepEqual(pedidos.filter(aTwitch), []);
});

test('los emotes nativos de Twitch se apagan solos, con el mismo trato', async () => {
  emotes.olvidarTodo();
  pedidos = [];

  emotes.catalogo('istincho', ['twitch']);
  await emotes.reposo();
  const catalogo = emotes.catalogo('istincho', ['twitch']);

  assert.equal(catalogo.some(e => e.fuente === 'twitch'), false);
  assert.deepEqual(pedidos.filter(aTwitch), [], 'ni el token ni los emotes');

  const c = emotes.comoEsta('istincho', 'twitch-nativos');
  assert.equal(c.estado, 'sin-cuenta');
  assert.ok(c.vence - Date.now() > emotes.REINTENTO * 10,
    `vence en ${c.vence - Date.now()} ms y tendria que ser la hora de "no tiene"`);
});

test('abrir el selector cien veces tampoco pide nada', async () => {
  emotes.olvidarTodo();
  pedidos = [];

  for (let i = 0; i < 100; i++) {
    emotes.catalogo('istincho', ['twitch']);
    await emotes.reposo();
  }

  assert.deepEqual(pedidos.filter(aTwitch), []);
});

test('el log no se llena: un aviso por casillero y no uno por mensaje', async () => {
  insignias.olvidarTodo();
  emotes.olvidarTodo();
  const log = console.log;
  const warn = console.warn;
  let lineas = 0;
  console.log = () => { lineas++; };
  console.warn = () => { lineas++; };
  try {
    for (let i = 0; i < 100; i++) {
      insignias.resolver(deTwitch([{ set_id: 'vip', id: '1', info: '' }]), 'istincho');
      emotes.catalogo('istincho', ['twitch']);
      await insignias.reposo();
      await emotes.reposo();
    }
  } finally {
    console.log = log;
    console.warn = warn;
  }

  /* Un aviso POR CASILLERO, no por mensaje. Los casilleros que se
     tocan son seis: las insignias del canal y las globales, los emotes
     nativos del canal y los globales de Twitch, y —de paso— el set de
     7TV de esa red y los globales de 7TV, que en este proceso fallan
     porque el `fetch` de mentira contesta 500 a todo. Seis lineas, no
     seiscientas: es la misma propiedad para los dos motivos. */
  assert.ok(lineas <= 6, `cien mensajes dejaron ${lineas} lineas de log`);
});
