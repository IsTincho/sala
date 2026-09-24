/* ============================================================
   Las imagenes de las insignias del chat.

   Lo que se prueba aca es lo que se rompe callado:

     - EL CASAMIENTO POR (set_id, version). Twitch manda en el mensaje
       `{ set_id: "subscriber", id: "12", info: "16" }`: el `12` es
       CUAL de los dibujos del set y el `16` son los meses. Confundirlos
       le pone a un sub de tres años el icono del primer mes, y no
       rompe nada ni avisa: se ve el escudo equivocado.
     - EL CANAL LE GANA A LOS GLOBALES, SET POR SET. Un canal que
       personaliza `subscriber` sigue usando el `moderator` global. Si
       ganara en bloque, ese canal perderia todas las demas.
     - UNA INSIGNIA QUE NO SE PUEDE RESOLVER CAE AL TEXTO, nunca a un
       hueco. Es la unica garantia que tiene la pagina.
     - LA CACHE ES POR CREADOR. El canal de uno no puede pintarle las
       insignias al chat de otro: no rompe nada, muestra el escudo de
       otra comunidad en la pantalla de esta.
     - UN CREADOR SIN TWITCH —o un mensaje de Kick— NO GENERA UN SOLO
       PEDIDO. Kick no tiene imagenes oficiales y aca no se inventan.
     - UN FALLO DE HELIX NO PUEDE ROMPER EL MENSAJE. Esto corre adentro
       del webhook de Kick, despues de marcar el evento como visto: una
       excepcion no seria una insignia que falta, seria el mensaje
       perdido y un 500.

   Nada sale a internet: `fetch` esta falseado y la identidad de cada
   creador se fija con `insignias.fijarIdentidad()`, igual que en
   `pruebas/emotes.test.js`.
   ============================================================ */

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

/* Las variables van ANTES de importar: los modulos las leen al
   cargarse. Ninguna es un secreto: son de mentira y estan en el
   codigo. */
process.env.SALA_DATOS = path.join(os.tmpdir(), 'sala-pruebas-insignias');
process.env.KICK_SLUG = 'istincho';
process.env.CLAVE_CIFRADO = crypto.randomBytes(32).toString('base64');
process.env.TWITCH_CLIENT_ID = 'cliente-de-mentira';
process.env.TWITCH_CLIENT_SECRET = 'secreto-de-mentira';
/* El plazo de una bajada entera, en su minimo: hay una prueba que
   cuelga una bajada a proposito y tiene que poder esperar a que venza.
   El modulo no acepta menos de 1000 ms; queda escrito el numero real
   para que la prueba de la bajada colgada no parezca mas rapida de lo
   que es. */
process.env.INSIGNIAS_PLAZO_MS = '2000';
/* Lo mismo para el pedido del token, que es un plazo aparte y de un
   piso mas abajo: hay una prueba que lo cuelga a proposito y en
   produccion esto espera diez segundos.

   EL DEL TOKEN TIENE QUE SER MAS CORTO QUE EL DE LA BAJADA, igual que
   en produccion (10 s contra 20 s). Si empataran, el orden en que
   vencen los dos timers seria cosa de suerte: con la bajada venciendo
   primero, el intento siguiente se vuelve a colgar de la promesa de
   token que todavia esta muriendo, y la prueba fallaria a veces si y a
   veces no. Un test que depende del orden de dos setTimeout iguales es
   peor que no tenerlo. */
process.env.TWITCH_ESPERA_TOKEN_MS = '1000';

const insignias = await import('../servidor/insignias.js');
const mensajes = await import('../servidor/mensajes.js');
const twitch = await import('../servidor/twitch.js');
const canales = await import('../servidor/canales.js');
const chat = await import('../servidor/chat.js');

/* --------------------------------------------- el Helix de mentira */

const fetchDeVerdad = globalThis.fetch;

const CDN = 'https://static-cdn.jtvnw.net/badges/v1';

/* Un juego de insignias como lo devuelve Helix. `versiones` es
   `{ id: nombreDelDibujo }`, y de ahi salen las tres URLs.

   Las tres medidas SE DIFERENCIAN a proposito: si el modulo pidiera la
   de 1x o la de 4x en vez de la de 2x, las pruebas que comparan la URL
   tienen que fallar. Con las tres iguales, cambiar el tamaño pedido
   pasaria inadvertido. */
function juego(setId, versiones) {
  return {
    set_id: setId,
    versions: Object.entries(versiones).map(([id, dibujo]) => ({
      id,
      image_url_1x: `${CDN}/${dibujo}/1`,
      image_url_2x: `${CDN}/${dibujo}/2`,
      image_url_4x: `${CDN}/${dibujo}/3`,
      title: setId,
      description: setId,
      click_action: '',
      click_url: '',
    })),
  };
}

/** La URL que el modulo TIENE que elegir: siempre la de 2x. */
const url2x = dibujo => `${CDN}/${dibujo}/2`;

/* Lo que "tiene" el Helix de mentira. `canales` es id de canal ->
   lista de juegos, o el string 'roto' para un 500, o 'no-existe' para
   un 400 (que es lo que contesta Helix con un broadcaster_id que no es
   un canal). */
let porCanal = new Map();
let globalesDeTwitch = [];
let pedidos = [];
/* Cuantas veces se pidio un token de app. Lo mira la prueba de que se
   cachea: sin eso serian dos tokens por cada dos bajadas. */
let tokens = 0;
/* Bajadas que se cuelgan a proposito, para la prueba del plazo. */
let colgar = new Set();
/* Y el pedido del TOKEN colgado, que es un caso aparte y peor: el
   token lo comparten todos los creadores. */
let colgarToken = false;

globalThis.fetch = async (recurso) => {
  const url = String(recurso);
  pedidos.push(url);
  const responder = (estado, datos) => new Response(JSON.stringify(datos), {
    status: estado,
    headers: { 'Content-Type': 'application/json' },
  });

  if (url.startsWith('https://id.twitch.tv/oauth2/token')) {
    tokens++;
    if (colgarToken) return new Promise(() => {});   // no contesta nunca
    return responder(200, {
      access_token: 'token-de-app-de-mentira',
      expires_in: 5_000_000,
      token_type: 'bearer',
    });
  }

  if (url.endsWith('/chat/badges/global')) {
    if (globalesDeTwitch === 'roto') return responder(500, { error: 'helix caido' });
    return responder(200, { data: globalesDeTwitch });
  }

  const m = url.match(/\/chat\/badges\?broadcaster_id=(.+)$/);
  if (!m) return responder(404, { error: 'ruta desconocida' });
  const id = decodeURIComponent(m[1]);
  if (colgar.has(id)) return new Promise(() => {});   // no contesta nunca
  const guardado = porCanal.get(id);
  if (guardado === 'roto') return responder(500, { error: 'helix caido' });
  if (guardado === 'no-existe') return responder(400, { error: 'invalid broadcaster_id' });
  if (guardado === 'sin-token') return responder(401, { error: 'invalid token' });
  return responder(200, { data: guardado ?? [] });
};

/* ------------------------------------------------------ la identidad */

/* slug -> id de Twitch. Sin entrada = creador sin vinculo. */
let identidades = new Map();
insignias.fijarIdentidad(async (slug, red) => {
  const id = identidades.get(slug);
  return red === 'twitch' && id ? { red, sala: slug, usuarioId: id } : null;
});

/* ----------------------------------------------------------- ayudas */

function arrancarDeCero() {
  insignias.olvidarTodo();
  twitch.olvidarTokenDeApp();
  porCanal = new Map();
  globalesDeTwitch = [];
  identidades = new Map();
  pedidos = [];
  tokens = 0;
  colgar = new Set();
  colgarToken = false;
}

/** Deja un canal con sus insignias propias cargadas en el Helix de mentira. */
function darle(slug, id, juegos) {
  identidades.set(slug, id);
  porCanal.set(id, juegos);
}

/**
 * Resuelve un mensaje con las tablas YA bajadas.
 *
 * La primera pasada es la que agenda las bajadas y sale con las
 * etiquetas de texto: eso es a proposito y se prueba aparte. Aca
 * interesa lo que ve el segundo mensaje en adelante.
 */
async function resolverConTabla(mensaje, slug) {
  insignias.resolver(mensaje, slug);
  await insignias.reposo();
  return insignias.resolver(mensaje, slug);
}

/** Un mensaje de Twitch del formato unico, con las insignias que se pidan. */
const deTwitch = (badges, extra = {}) => mensajes.deTwitch({
  message_id: 't1',
  chatter_user_name: 'Fulana',
  chatter_user_id: '909',
  badges,
  message: { text: 'hola', fragments: [{ type: 'text', text: 'hola' }] },
  ...extra,
}, { message_timestamp: new Date().toISOString() });

/** Un mensaje de Kick del formato unico, con las insignias que se pidan. */
const deKick = (badges) => mensajes.deKick({
  message_id: `k-${Math.random()}`,
  content: 'hola',
  created_at: new Date().toISOString(),
  sender: { username: 'Fulana', user_id: '909', identity: { badges } },
});

/** Las URLs de las insignias de un mensaje, en orden. */
const urls = m => m.insignias.map(i => i.url);

test.after(() => {
  globalThis.fetch = fetchDeVerdad;
  chat.parar();
  canales.cerrarTodo();
});

/* ===================================== el casamiento por set y version */

test('casa cada insignia por set_id Y por version, no solo por set', async () => {
  arrancarDeCero();
  darle('istincho', '4242', [
    juego('subscriber', { 0: 'sub-nuevo', 3: 'sub-3', 12: 'sub-12' }),
  ]);

  /* El mensaje trae version "12" y meses "16": el dibujo sale del 12,
     que es el tramo, y NO del 16, que son los meses de verdad. */
  const m = await resolverConTabla(
    deTwitch([{ set_id: 'subscriber', id: '12', info: '16' }]), 'istincho');

  assert.equal(m.insignias[0].url, url2x('sub-12'));
  assert.equal(m.insignias[0].version, '12', 'la version tiene que viajar en el formato unico');
  assert.equal(m.insignias[0].texto, 'Sub (16)', 'el texto muestra los meses, no el tramo');
});

test('dos personas del mismo canal con distinto tramo de sub ven distinto dibujo', async () => {
  arrancarDeCero();
  darle('istincho', '4242', [
    juego('subscriber', { 0: 'sub-nuevo', 12: 'sub-12' }),
  ]);

  const nueva = await resolverConTabla(
    deTwitch([{ set_id: 'subscriber', id: '0', info: '1' }]), 'istincho');
  const vieja = insignias.resolver(
    deTwitch([{ set_id: 'subscriber', id: '12', info: '30' }]), 'istincho');

  assert.equal(nueva.insignias[0].url, url2x('sub-nuevo'));
  assert.equal(vieja.insignias[0].url, url2x('sub-12'));
  assert.notEqual(nueva.insignias[0].url, vieja.insignias[0].url);
});

test('se pide la imagen de 2x, que es la que se muestra', async () => {
  arrancarDeCero();
  darle('istincho', '4242', [juego('vip', { 1: 'vip-propio' })]);

  const m = await resolverConTabla(deTwitch([{ set_id: 'vip', id: '1', info: '' }]), 'istincho');

  /* 1x son 18 px y se ve borrosa en una pantalla retina; 4x son 72 px
     para pintar 18. El CSS la muestra a 1,1em. */
  assert.equal(m.insignias[0].url, `${CDN}/vip-propio/2`);
  assert.ok(!m.insignias[0].url.endsWith('/1'), 'no puede ser la de 1x');
  assert.ok(!m.insignias[0].url.endsWith('/3'), 'no puede ser la de 4x');
});

/* =============================== el canal le gana a los globales, set a set */

test('el canal le gana a los globales en SU set y no le toca los demas', async () => {
  arrancarDeCero();
  darle('istincho', '4242', [juego('subscriber', { 0: 'sub-del-canal' })]);
  globalesDeTwitch = [
    juego('subscriber', { 0: 'sub-generico' }),
    juego('moderator', { 1: 'mod-global' }),
  ];

  const m = await resolverConTabla(deTwitch([
    { set_id: 'subscriber', id: '0', info: '' },
    { set_id: 'moderator', id: '1', info: '' },
  ]), 'istincho');

  /* Si el canal ganara EN BLOQUE, este canal se quedaria sin la
     insignia de moderador, que es global y el no personalizo. */
  assert.deepEqual(urls(m), [url2x('sub-del-canal'), url2x('mod-global')]);
});

test('un canal sin insignias propias usa las globales', async () => {
  arrancarDeCero();
  darle('istincho', '4242', []);
  globalesDeTwitch = [juego('broadcaster', { 1: 'streamer-global' })];

  const m = await resolverConTabla(
    deTwitch([{ set_id: 'broadcaster', id: '1', info: '' }]), 'istincho');

  assert.equal(m.insignias[0].url, url2x('streamer-global'));
});

test('el canal personalizo el set pero no esa version: se cae al texto, no a la global', async () => {
  arrancarDeCero();
  darle('istincho', '4242', [juego('subscriber', { 0: 'sub-del-canal' })]);
  globalesDeTwitch = [juego('subscriber', { 12: 'sub-generico-12' })];

  const m = await resolverConTabla(
    deTwitch([{ set_id: 'subscriber', id: '12', info: '12' }]), 'istincho');

  /* Mezclar los dos seria mostrarle a un suscriptor de ESTE canal el
     escudo generico de Twitch como si fuera el del canal. Mejor la
     etiqueta, que no miente. */
  assert.equal(m.insignias[0].url, '');
  assert.equal(m.insignias[0].texto, 'Sub (12)');
});

/* ================================= lo que no se puede resolver, al texto */

test('una insignia que no conocemos se queda sin imagen y conserva su texto', async () => {
  arrancarDeCero();
  darle('istincho', '4242', []);
  globalesDeTwitch = [juego('moderator', { 1: 'mod-global' })];

  const m = await resolverConTabla(deTwitch([
    { set_id: 'moderator', id: '1', info: '' },
    { set_id: 'insignia-que-no-existe', id: '1', info: '' },
  ]), 'istincho');

  /* El moderador sin pelar es el testigo: sin el, esta prueba pasaria
     con el modulo apagado del todo. */
  assert.equal(m.insignias[0].url, url2x('mod-global'));
  assert.equal(m.insignias[1].url, '');
  assert.equal(m.insignias[1].texto, 'insignia-que-no-existe',
    'sin imagen tiene que quedar el texto, nunca un hueco');
});

test('una URL que no es del CDN de Twitch se descarta', async () => {
  arrancarDeCero();
  darle('istincho', '4242', []);
  globalesDeTwitch = [{
    set_id: 'moderator',
    versions: [
      { id: '1', image_url_2x: 'https://evil.example.com/mod/2' },
      { id: '2', image_url_2x: 'javascript:alert(1)' },
      { id: '3', image_url_2x: 'http://static-cdn.jtvnw.net/badges/v1/mod/2' },
      { id: '4', image_url_2x: `${CDN}/mod-de-verdad/2` },
    ],
  }];

  const m = await resolverConTabla(deTwitch([
    { set_id: 'moderator', id: '1', info: '' },
    { set_id: 'moderator', id: '2', info: '' },
    { set_id: 'moderator', id: '3', info: '' },
    { set_id: 'moderator', id: '4', info: '' },
  ]), 'istincho');

  /* Esto termina en el src de un <img> en la pantalla de cada
     espectador y lo arma un tercero. El cuarto es el testigo de que el
     filtro no apago todo. */
  assert.deepEqual(urls(m), ['', '', '', url2x('mod-de-verdad')]);
});

/* ======================================= Kick no pide nada y no inventa */

test('un mensaje de Kick sale con su etiqueta de texto y sin pedir nada', async () => {
  arrancarDeCero();
  identidades.set('istincho', '4242');
  porCanal.set('4242', [juego('subscriber', { 0: 'sub-del-canal' })]);

  const m = insignias.resolver(deKick([
    { type: 'broadcaster', text: 'Broadcaster' },
    { type: 'moderator', text: 'Moderator' },
    { type: 'verified', text: 'Verified channel' },
  ]), 'istincho');
  await insignias.reposo();

  /* Kick no publica las imagenes de sus insignias por ninguna API
     documentada, y el dueño no quiere iconos inventados (2026-09-23).
     Se quedan como estaban: con su nombre. */
  assert.deepEqual(urls(m), ['', '', '']);
  assert.deepEqual(m.insignias.map(i => i.texto),
    ['Broadcaster', 'Moderator', 'Verified channel']);
  assert.deepEqual(pedidos, [], 'un mensaje de Kick no puede generar un pedido a Twitch');
});

test('un creador sin Twitch vinculado no le pide nada a Helix', async () => {
  arrancarDeCero();
  globalesDeTwitch = [juego('moderator', { 1: 'mod-global' })];

  /* Llega un mensaje de Twitch de una sala sin vinculo: pasa en el
     buffer viejo de un canal al que le desvincularon Twitch. */
  insignias.resolver(deTwitch([{ set_id: 'moderator', id: '1', info: '' }]), 'sin-twitch');
  await insignias.reposo();

  const delCanal = pedidos.filter(u => u.includes('broadcaster_id='));
  assert.deepEqual(delCanal, [], 'sin vinculo no hay a quien preguntarle');
  assert.equal(insignias.comoEsta('sin-twitch').estado, 'sin-propias');

  /* Y no se vuelve a intentar enseguida: vence dentro de una hora, no
     dentro de un minuto. Confundirlos es preguntar 1440 veces por dia
     por cada creador que no tiene Twitch. */
  const falta = insignias.comoEsta('sin-twitch').vence - Date.now();
  assert.ok(falta > 50 * 60 * 1000, `deberia vencer dentro de una hora y vence en ${falta} ms`);
});

test('las globales igual sirven para un mensaje de un creador sin vinculo', async () => {
  arrancarDeCero();
  globalesDeTwitch = [juego('moderator', { 1: 'mod-global' })];

  const m = await resolverConTabla(
    deTwitch([{ set_id: 'moderator', id: '1', info: '' }]), 'sin-twitch');

  /* No tener vinculo quita las insignias PROPIAS del canal, no las que
     valen en todo Twitch. */
  assert.equal(m.insignias[0].url, url2x('mod-global'));
});

/* ====================================================== la cache */

test('la cache es por creador: el canal de uno no pinta el chat de otro', async () => {
  arrancarDeCero();
  darle('unoo', '1111', [juego('subscriber', { 0: 'sub-de-uno' })]);
  darle('otroo', '2222', [juego('subscriber', { 0: 'sub-de-otro' })]);

  const a = await resolverConTabla(deTwitch([{ set_id: 'subscriber', id: '0', info: '' }]), 'unoo');
  const b = await resolverConTabla(deTwitch([{ set_id: 'subscriber', id: '0', info: '' }]), 'otroo');

  assert.equal(a.insignias[0].url, url2x('sub-de-uno'));
  assert.equal(b.insignias[0].url, url2x('sub-de-otro'));
  assert.notEqual(a.insignias[0].url, b.insignias[0].url,
    'con la cache compartida, el escudo de una comunidad aparece en la pantalla de la otra');
});

test('una vez bajada la tabla, los mensajes que siguen no piden nada', async () => {
  arrancarDeCero();
  darle('istincho', '4242', [juego('subscriber', { 0: 'sub-del-canal' })]);
  globalesDeTwitch = [juego('moderator', { 1: 'mod-global' })];

  await resolverConTabla(deTwitch([{ set_id: 'subscriber', id: '0', info: '' }]), 'istincho');
  const despues = pedidos.length;

  for (let i = 0; i < 50; i++) {
    insignias.resolver(deTwitch([{ set_id: 'subscriber', id: '0', info: '' }]), 'istincho');
  }
  await insignias.reposo();

  assert.equal(pedidos.length, despues, 'un pedido por mensaje es exactamente lo que no puede pasar');
});

test('el token de app se pide una vez y se reusa para todos los creadores', async () => {
  arrancarDeCero();
  darle('unoo', '1111', [juego('vip', { 1: 'vip-uno' })]);
  darle('otroo', '2222', [juego('vip', { 1: 'vip-otro' })]);
  globalesDeTwitch = [juego('moderator', { 1: 'mod-global' })];

  await resolverConTabla(deTwitch([{ set_id: 'vip', id: '1', info: '' }]), 'unoo');
  await resolverConTabla(deTwitch([{ set_id: 'vip', id: '1', info: '' }]), 'otroo');

  assert.equal(tokens, 1, `se pidieron ${tokens} tokens de app y tenia que ser uno solo`);
});

test('un 401 tira el token cacheado para que el proximo intento pida uno nuevo', async () => {
  arrancarDeCero();
  darle('istincho', '4242', 'sin-token');

  insignias.resolver(deTwitch([{ set_id: 'vip', id: '1', info: '' }]), 'istincho');
  await insignias.reposo();
  assert.equal(insignias.comoEsta('istincho').estado, 'fallo');

  /* Ahora el canal contesta bien. Sin tirar el token, el modulo
     seguiria mandando el que Twitch ya rechazo hasta que alguien
     reinicie el proceso. */
  porCanal.set('4242', [juego('vip', { 1: 'vip-propio' })]);
  insignias.vencer('istincho');
  const m = await resolverConTabla(deTwitch([{ set_id: 'vip', id: '1', info: '' }]), 'istincho');

  assert.equal(m.insignias[0].url, url2x('vip-propio'));
  assert.ok(tokens >= 2, `el token tendria que haberse vuelto a pedir y se pidio ${tokens} vez/veces`);
});

test('un canal sin insignias propias vence a la hora, no a las seis', async () => {
  arrancarDeCero();
  darle('istincho', '4242', []);

  insignias.resolver(deTwitch([{ set_id: 'vip', id: '1', info: '' }]), 'istincho');
  await insignias.reposo();

  const c = insignias.comoEsta('istincho');
  assert.equal(c.estado, 'sin-propias');
  const falta = c.vence - Date.now();
  assert.ok(falta > 50 * 60 * 1000 && falta < 70 * 60 * 1000,
    `un canal sin insignias propias tiene que vencer dentro de una hora, y vence en ${falta} ms`);
});

test('un canal CON insignias propias vence a las seis horas', async () => {
  arrancarDeCero();
  darle('istincho', '4242', [juego('subscriber', { 0: 'sub-del-canal' })]);

  await resolverConTabla(deTwitch([{ set_id: 'subscriber', id: '0', info: '' }]), 'istincho');

  const falta = insignias.comoEsta('istincho').vence - Date.now();
  assert.ok(falta > 5.5 * 60 * 60 * 1000, `tenia que vencer dentro de seis horas y vence en ${falta} ms`);
});

/* ================================= un fallo no puede romper el mensaje */

test('si Helix se cae, el mensaje sale igual con sus etiquetas de texto', async () => {
  arrancarDeCero();
  darle('istincho', '4242', 'roto');
  globalesDeTwitch = 'roto';

  const m = await resolverConTabla(deTwitch([
    { set_id: 'moderator', id: '1', info: '' },
    { set_id: 'subscriber', id: '12', info: '16' },
  ]), 'istincho');

  assert.equal(m.tipo, 'chat');
  assert.equal(m.texto, 'hola');
  assert.deepEqual(urls(m), ['', '']);
  assert.deepEqual(m.insignias.map(i => i.texto), ['Mod', 'Sub (16)'],
    'el mensaje tiene que salir entero: esto corre adentro del webhook');
  assert.equal(insignias.comoEsta('istincho').estado, 'fallo');
});

test('un fallo NO pisa la tabla que funcionaba y se reintenta al minuto', async () => {
  arrancarDeCero();
  darle('istincho', '4242', [juego('subscriber', { 0: 'sub-del-canal' })]);

  const antes = await resolverConTabla(
    deTwitch([{ set_id: 'subscriber', id: '0', info: '' }]), 'istincho');
  assert.equal(antes.insignias[0].url, url2x('sub-del-canal'));

  /* Ahora Helix se cae y la tabla vence. */
  porCanal.set('4242', 'roto');
  insignias.vencer('istincho');
  const durante = await resolverConTabla(
    deTwitch([{ set_id: 'subscriber', id: '0', info: '' }]), 'istincho');

  /* Una insignia vieja es mejor que ninguna. */
  assert.equal(durante.insignias[0].url, url2x('sub-del-canal'),
    'el fallo pisó la tabla que andaba');
  const falta = insignias.comoEsta('istincho').vence - Date.now();
  assert.ok(falta > 0 && falta < 2 * 60 * 1000,
    `un fallo tiene que reintentarse al minuto, y vence en ${falta} ms`);
});

test('un broadcaster_id que Helix no reconoce no se reintenta cada minuto', async () => {
  arrancarDeCero();
  darle('istincho', '4242', 'no-existe');

  insignias.resolver(deTwitch([{ set_id: 'vip', id: '1', info: '' }]), 'istincho');
  await insignias.reposo();

  /* Un 400 es un hecho estable, no un fallo de red: si se tratara como
     fallo, ese creador pediria 1440 veces por dia para siempre. */
  assert.equal(insignias.comoEsta('istincho').estado, 'sin-propias');
  const falta = insignias.comoEsta('istincho').vence - Date.now();
  assert.ok(falta > 50 * 60 * 1000, `tenia que vencer dentro de una hora y vence en ${falta} ms`);
});

test('una bajada colgada no se queda con un lugar del tope para siempre', async () => {
  arrancarDeCero();
  darle('istincho', '4242', [juego('vip', { 1: 'vip-propio' })]);
  colgar.add('4242');

  insignias.resolver(deTwitch([{ set_id: 'vip', id: '1', info: '' }]), 'istincho');
  /* El plazo (2 s en estas pruebas) tiene que cortarla: sin el, la
     promesa no vence nunca y seis como esta apagan las insignias para
     TODOS los creadores, para siempre y sin una linea de log. */
  await insignias.reposo();

  assert.equal(insignias.comoEsta('istincho').estado, 'fallo');

  colgar.delete('4242');
  insignias.vencer('istincho');
  const m = await resolverConTabla(deTwitch([{ set_id: 'vip', id: '1', info: '' }]), 'istincho');
  assert.equal(m.insignias[0].url, url2x('vip-propio'), 'el lugar del tope quedó tomado');
});

test('un mensaje de Twitch SIN insignias no genera ningun pedido', async () => {
  arrancarDeCero();
  darle('istincho', '4242', [juego('vip', { 1: 'vip-propio' })]);

  /* La mayoria de los mensajes de un chat no tienen insignia. Si cada
     uno agendara la bajada, un canal donde nadie tiene insignias
     estaria preguntandole a Helix por algo que no va a usar. */
  for (let i = 0; i < 20; i++) insignias.resolver(deTwitch([]), 'istincho');
  await insignias.reposo();

  assert.deepEqual(pedidos, []);
  assert.equal(insignias.comoEsta('istincho'), null, 'ni se creo el casillero');
});

test('el tope de bajadas se libera: seis colgadas no apagan las insignias para siempre', async () => {
  arrancarDeCero();
  /* Seis creadores que cuelgan a la vez llenan el tope. El septimo no
     entra —eso es a proposito— pero cuando las seis vencen por plazo
     TIENEN que devolver su lugar.

     La prueba anterior de la bajada colgada no cazaba que el contador
     se fugara: usaba UN creador, y con un solo lugar tomado de seis
     nunca se llega al tope. Esta usa siete. */
  for (let i = 1; i <= 7; i++) {
    darle(`creador${i}`, `id${i}`, [juego('vip', { 1: `vip${i}` })]);
    colgar.add(`id${i}`);
  }

  for (let i = 1; i <= 7; i++) {
    insignias.resolver(deTwitch([{ set_id: 'vip', id: '1', info: '' }]), `creador${i}`);
  }
  /* El septimo no entro en el tope: no pidio nada y no tiene casillero
     con estado. */
  assert.equal(insignias.comoEsta('creador7')?.estado, '', 'el septimo no tendria que haber bajado nada');

  await insignias.reposo();

  /* Ahora Helix contesta bien. Si el `.finally` no devolviera el lugar,
     el contador quedaria en 6 (o mas) para siempre y NINGUN creador
     volveria a resolver una insignia. */
  colgar.clear();
  for (let i = 1; i <= 7; i++) insignias.vencer(`creador${i}`);

  const m = await resolverConTabla(
    deTwitch([{ set_id: 'vip', id: '1', info: '' }]), 'creador7');
  assert.equal(m.insignias[0].url, url2x('vip7'),
    'el tope quedo tomado: las bajadas colgadas no devolvieron su lugar');
});

test('resolver nunca tira, ni con un mensaje deforme', async () => {
  arrancarDeCero();
  darle('istincho', '4242', [juego('vip', { 1: 'vip-propio' })]);

  for (const raro of [null, undefined, {}, { tipo: 'reloj' }, { tipo: 'chat', red: 'twitch' },
    { tipo: 'chat', red: 'twitch', insignias: 'no soy un array' },
    { tipo: 'chat', red: 'twitch', insignias: [null, 7, { tipo: null, version: null }] }]) {
    assert.doesNotThrow(() => insignias.resolver(raro, 'istincho'));
  }
  await insignias.reposo();
});

/* ================================= los dos embudos de chat.js, de punta */

test('vincular Twitch vence la tabla: no quedan las insignias de la cuenta anterior', async () => {
  arrancarDeCero();
  darle('istincho', '4242', [juego('subscriber', { 0: 'sub-cuenta-vieja' })]);

  const antes = await resolverConTabla(
    deTwitch([{ set_id: 'subscriber', id: '0', info: '' }]), 'istincho');
  assert.equal(antes.insignias[0].url, url2x('sub-cuenta-vieja'));

  /* El creador desvincula y vincula OTRA cuenta de Twitch. La clave de
     la cache es el SLUG, no el id de Twitch, asi que sin el vencer de
     `conectarTwitch` seguiria mostrando las insignias del canal
     anterior hasta seis horas. */
  darle('istincho', '9999', [juego('subscriber', { 0: 'sub-cuenta-nueva' })]);
  insignias.vencer('istincho');

  const despues = await resolverConTabla(
    deTwitch([{ set_id: 'subscriber', id: '0', info: '' }]), 'istincho');
  assert.equal(despues.insignias[0].url, url2x('sub-cuenta-nueva'));
});

test('un token que se cuelga no apaga las insignias para siempre', async () => {
  arrancarDeCero();
  colgarToken = true;
  darle('istincho', '4242', [juego('vip', { 1: 'vip-propio' })]);

  insignias.resolver(deTwitch([{ set_id: 'vip', id: '1', info: '' }]), 'istincho');
  await insignias.reposo();
  assert.equal(insignias.comoEsta('istincho').estado, 'fallo');

  /* LO QUE ESTO ATAJA, que es el peor modo de falla del modulo:
     `tokenDeApp()` comparte UNA promesa entre todos los creadores. Sin
     plazo en el pedido del token, esa promesa no resuelve nunca, el
     `.finally` que la limpia no corre nunca, y todos los creadores se
     cuelgan de la misma promesa muerta: las insignias quedan apagadas
     para el servicio entero hasta que alguien reinicie el proceso, y
     sin una linea de log que nombre al token.
     Con plazo, el pedido del token se vuelve a hacer. */
  colgarToken = false;
  insignias.vencer('istincho');
  const m = await resolverConTabla(deTwitch([{ set_id: 'vip', id: '1', info: '' }]), 'istincho');

  assert.equal(m.insignias[0].url, url2x('vip-propio'));
  assert.ok(tokens >= 2, `el token se pidio ${tokens} vez/veces: quedo cacheada la promesa colgada`);
});

test('las insignias se resuelven por el camino de Twitch y no rompen el de Kick', async () => {
  arrancarDeCero();
  darle('istincho', '4242', [juego('subscriber', { 0: 'sub-del-canal' })]);

  /* La primera vuelta agenda la bajada; la segunda es la que trae la
     imagen. Se prueban los DOS embudos porque el dia que alguien
     agregue el paso en uno solo, una red muestra las insignias y la
     otra no. */
  chat.recibirDeKick('istincho', { tipo: 'chat.message.sent' }, {
    message_id: 'k1', content: 'hola', created_at: new Date().toISOString(),
    sender: { username: 'Fulana', user_id: '909', identity: { badges: [{ type: 'moderator', text: 'Moderator' }] } },
  });
  chat.recibirDeTwitch('istincho', deTwitch([{ set_id: 'subscriber', id: '0', info: '' }]));
  await insignias.reposo();
  chat.recibirDeTwitch('istincho', { ...deTwitch([{ set_id: 'subscriber', id: '0', info: '' }]), id: 't2' });

  const guardados = canales.ultimos('istincho');
  const twitchito = guardados.find(m => m.red === 'twitch' && m.id === 't2');
  const kickcito = guardados.find(m => m.red === 'kick');

  assert.equal(twitchito.insignias[0].url, url2x('sub-del-canal'));
  assert.equal(kickcito.insignias[0].url, '', 'Kick no tiene imagen y no se le inventa una');
  assert.equal(kickcito.insignias[0].texto, 'Moderator');
});

/* ================================================= el interruptor

   `INSIGNIAS_TWITCH=0` deja el chat exactamente como estaba antes de
   este modulo: las etiquetas de texto de siempre y ni un pedido a
   Helix. Es el freno de mano por si Helix empieza a contestar
   cualquier cosa, y un freno de mano que nadie probo no es un freno.

   Se prueba con las DOS puntas —prendido dibuja, apagado no— porque un
   test que solo mira el apagado pasa igual si el modulo esta roto. */

test('con el interruptor prendido (el default) la insignia sale dibujada', async () => {
  arrancarDeCero();
  darle('istincho', '4242', [juego('subscriber', { 0: 'sub-del-canal' })]);

  const m = await resolverConTabla(
    deTwitch([{ set_id: 'subscriber', id: '0', info: '' }]), 'istincho');

  assert.equal(insignias.ACTIVO_TWITCH, true);
  assert.equal(m.insignias[0].url, url2x('sub-del-canal'));
});

test('con INSIGNIAS_TWITCH=0 no hay imagenes y no se le pide nada a Helix', async () => {
  /* Instancia aparte del modulo: el interruptor se lee al cargarse. */
  process.env.INSIGNIAS_TWITCH = '0';
  const apagadas = await import('../servidor/insignias.js?apagadas=1');
  delete process.env.INSIGNIAS_TWITCH;

  apagadas.fijarIdentidad(async (slug, red) => {
    const id = identidades.get(slug);
    return red === 'twitch' && id ? { red, sala: slug, usuarioId: id } : null;
  });

  arrancarDeCero();
  darle('istincho', '4242', [juego('subscriber', { 0: 'sub-del-canal' })]);

  assert.equal(apagadas.ACTIVO_TWITCH, false);

  const m = apagadas.resolver(deTwitch([{ set_id: 'subscriber', id: '0', info: '' }]), 'istincho');
  await apagadas.reposo();
  apagadas.resolver(m, 'istincho');

  assert.equal(m.insignias[0].url, '', 'sin imagen, que es lo que la pagina lee como "mostrame el texto"');
  assert.equal(m.insignias[0].texto, 'Sub', 'y la etiqueta de siempre sigue ahi');
  assert.deepEqual(pedidos, [], 'ni el token: apagado no toca la red');
  assert.equal(apagadas.comoEsta('istincho'), null, 'y no se agenda ninguna bajada');

  apagadas.olvidarTodo();
});
