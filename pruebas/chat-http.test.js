/* ============================================================
   Las rutas nuevas de la Fase 1, de punta a punta: el servidor se
   levanta de verdad en un puerto libre y se le pega con HTTP.

   Dos cosas se miran con lupa aca:

     1. Que /eventos/:slug deje de aceptar cualquier slug inventado.
        Hasta la Fase 0 lo hacia, y cada slug creaba una entrada en el
        Map de canales mientras la conexion viviera: memoria del
        servidor a pedido de cualquiera.
     2. Que TODO lo que trae o manda chat de verdad exija la sesion
        del dueño. La pagina /chat se sirve a cualquiera porque es
        HTML sin datos; los datos no.
   ============================================================ */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const DATOS = await fsp.mkdtemp(path.join(os.tmpdir(), 'sala-chat-http-'));
process.env.SALA_DATOS = DATOS;
process.env.MODO = 'local';
process.env.KICK_SLUG = 'istincho';
process.env.KICK_CLIENT_ID = 'cliente-de-prueba';
process.env.KICK_CLIENT_SECRET = 'secreto-de-prueba';
process.env.TWITCH_CLIENT_ID = 'cliente-twitch-de-prueba';
process.env.TWITCH_CLIENT_SECRET = 'secreto-twitch-de-prueba';
process.env.URL_BASE = 'https://sala.example';
process.env.CLAVE_CIFRADO = crypto.randomBytes(32).toString('base64');

const { crearServidor } = await import('../servidor/index.js');
const almacen = await import('../servidor/almacen.js');
const canales = await import('../servidor/canales.js');
const sesion = await import('../servidor/sesion.js');
const vinculos = await import('../servidor/vinculos.js');
const webhook = await import('../servidor/webhook.js');

/* Par RSA propio para firmar el fixture, igual que en webhook.test.js:
   la clave privada de Kick no existe de este lado, y una clave privada
   de prueba versionada es una que algun dia alguien confunde con una
   de verdad. */
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
webhook.fijarClavePublica(publicKey);

const AQUI = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1'));
const PAYLOAD = fs.readFileSync(path.join(AQUI, 'fijos', 'chat-mensaje.json'), 'utf8');

function firmarWebhook(id, ts, crudo) {
  const s = crypto.createSign('RSA-SHA256');
  s.update(Buffer.concat([Buffer.from(`${id}.${ts}.`, 'utf8'), Buffer.from(crudo, 'utf8')]));
  s.end();
  return s.sign(privateKey, 'base64');
}

let servidor;
let raiz;
let cookieDueno;
let cookieEspectador;

test.before(async () => {
  await almacen.poner('creadores', 'otrocreador', { slug: 'otrocreador', plan: 'amigo' });

  servidor = crearServidor();
  await new Promise(ok => servidor.listen(0, '127.0.0.1', ok));
  raiz = `http://127.0.0.1:${servidor.address().port}`;

  cookieDueno = `sala_dueno=${await sesion.crear({
    tipo: 'dueno', usuario: '4242', nombre: 'IsTincho', slug: 'istincho',
  })}`;
  cookieEspectador = `sala_espectador=${await sesion.crear({
    tipo: 'espectador', usuario: '99', nombre: 'Alguien',
  })}`;
});

test.after(async () => {
  canales.cerrarTodo();
  await new Promise(ok => servidor.close(ok));
  await fsp.rm(DATOS, { recursive: true, force: true });
});

/* Tope de tiempo para cualquier pedido de este archivo.

   Sin esto, un test que falla contra una ruta SSE no falla: se cuelga.
   El cuerpo de un `text/event-stream` no termina nunca, asi que
   `await r.text()` de una respuesta que deberia haber sido 404 y
   resulto 200 espera hasta que Node se aburra (cinco minutos largos).
   Un test que tarda cinco minutos en decir que algo se rompio es un
   test que nadie corre. Misma fragilidad que marco la Fase 0 con el
   HEAD /eventos/:slug. */
const TOPE_PEDIDO = 5000;
const pedir = (ruta, opciones = {}) =>
  fetch(`${raiz}${ruta}`, { signal: AbortSignal.timeout(TOPE_PEDIDO), ...opciones });

/** Abre un SSE, lee el primer bloque y corta. Devuelve status y cuerpo. */
async function abrirSse(ruta) {
  const corte = new AbortController();
  const tope = setTimeout(() => corte.abort(), TOPE_PEDIDO);
  tope.unref?.();
  const r = await fetch(`${raiz}${ruta}`, { signal: corte.signal });
  if (!r.ok) { await r.text(); clearTimeout(tope); return { status: r.status, primero: '' }; }
  const lector = r.body.getReader();
  const { value } = await lector.read();
  clearTimeout(tope);
  corte.abort();
  await lector.cancel().catch(() => {});
  return { status: r.status, primero: new TextDecoder().decode(value) };
}

/* ------------------------------------------------- canales validos */

test('un slug inventado ya no abre un canal', async () => {
  /* EL BUG que ataja: hasta la Fase 0, `/eventos/lo-que-sea` contestaba
     200 y creaba el canal en memoria. Miles de pedidos con slugs al
     azar hacian crecer el Map sin techo, y /api/estado devolvia esa
     lista de basura a cualquiera. */
  const r = await pedir('/eventos/canal-que-nadie-dio-de-alta');
  /* El status se mira ANTES de leer el cuerpo: si esta regla se rompe,
     la respuesta es un SSE que no termina nunca y leerlo colgaria el
     test en vez de hacerlo fallar. */
  assert.equal(r.status, 404);
  await r.text().catch(() => {});
  assert.equal(canales.hayCanal('canal-que-nadie-dio-de-alta'), false,
    'y sobre todo: no quedo ningun canal creado');
});

test('el canal del dueño abre y manda el estado', async () => {
  const { status, primero } = await abrirSse('/eventos/istincho');
  assert.equal(status, 200);
  assert.match(primero, /"tipo":"estado"/);
});

test('un creador dado de alta tambien abre', async () => {
  /* Hoy la coleccion `creadores` esta casi vacia; la Fase 3 la llena y
     esta regla sigue valiendo sin tocar nada. */
  const { status } = await abrirSse('/eventos/otrocreador');
  assert.equal(status, 200);
});

/* ----------------------------------------------------- las paginas */

test('/chat y /panel se sirven sin .html', async () => {
  /* La URL sin extension no es cosmetica: /chat es el `start_url` de
     la app instalada, y si redirigiera a /chat.html la app arrancaria
     fuera de su propio scope. */
  for (const ruta of ['/chat', '/panel']) {
    const r = await fetch(`${raiz}${ruta}`);
    const cuerpo = await r.text();
    assert.equal(r.status, 200, `${ruta} tiene que existir`);
    assert.match(r.headers.get('content-type'), /text\/html/);
    assert.match(cuerpo, /<html/i);
  }
});

test('el manifest y el service worker se sirven con su tipo', async () => {
  const m = await fetch(`${raiz}/manifest.webmanifest`);
  const manifest = await m.json();
  assert.equal(m.status, 200);
  assert.match(m.headers.get('content-type'), /application\/manifest\+json/);
  assert.equal(manifest.start_url, '/chat', 'la app instalada arranca en el chat');
  assert.ok(manifest.icons?.length >= 1);

  const sw = await fetch(`${raiz}/sw.js`);
  await sw.text();
  assert.equal(sw.status, 200);
  assert.match(sw.headers.get('content-type'), /javascript/);
});

test('los iconos del manifest existen de verdad', async () => {
  /* Un manifest que apunta a un icono que da 404 es un manifest que
     no instala nada, y el navegador no lo dice en ningun lado obvio. */
  const manifest = await (await fetch(`${raiz}/manifest.webmanifest`)).json();
  for (const icono of manifest.icons) {
    const r = await fetch(new URL(icono.src, raiz));
    const bytes = Buffer.from(await r.arrayBuffer());
    assert.equal(r.status, 200, `${icono.src} tiene que existir`);
    assert.equal(r.headers.get('content-type'), 'image/png');
    assert.deepEqual([...bytes.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47],
      `${icono.src} tiene que ser un PNG de verdad`);
  }
});

/* ------------------------------------------------ la puerta cerrada */

const SIN_SESION = [
  ['GET', '/api/chat/salud'],
  ['POST', '/api/chat/enviar'],
  ['POST', '/api/chat/resuscribir'],
];

test('sin sesion de dueño no se lee ni se manda nada', async () => {
  for (const [metodo, ruta] of SIN_SESION) {
    const r = await fetch(`${raiz}${ruta}`, {
      method: metodo,
      headers: { 'Content-Type': 'application/json' },
      body: metodo === 'POST' ? '{"texto":"hola","destino":"kick"}' : undefined,
    });
    const cuerpo = await r.json();
    assert.equal(r.status, 401, `${metodo} ${ruta} sin cookie tiene que dar 401`);
    assert.match(cuerpo.error, /no hay sesion de creador/);
  }
});

test('una sesion de espectador no sirve para la ranura del dueño', async () => {
  /* Las dos cookies tienen nombres distintos a proposito: el error
     tiene que ser "no tenes cookie de dueño", no "tu rol dice otra
     cosa". */
  const r = await fetch(`${raiz}/api/chat/salud`, { headers: { Cookie: cookieEspectador } });
  await r.text();
  assert.equal(r.status, 401);
});

test('una cookie de dueño con la firma cambiada no entra', async () => {
  const rota = cookieDueno.slice(0, -3) + 'aaa';
  const r = await fetch(`${raiz}/api/chat/salud`, { headers: { Cookie: rota } });
  await r.text();
  assert.equal(r.status, 401);
});

/* ------------------------------------------------- con el dueño adentro */

const comoDueno = (ruta, opciones = {}) => fetch(`${raiz}${ruta}`, {
  ...opciones,
  headers: { Cookie: cookieDueno, ...(opciones.headers ?? {}) },
});

test('la salud se lee con la sesion del dueño', async () => {
  const r = await comoDueno('/api/chat/salud');
  const s = await r.json();
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(s).sort(), ['ahora', 'kick', 'twitch']);
  assert.equal(typeof s.kick.vinculado, 'boolean');
});

test('un mensaje vacio se rechaza con 400 y no llega a ninguna API', async () => {
  const r = await comoDueno('/api/chat/enviar', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ texto: '   ', destino: 'ambos' }),
  });
  const cuerpo = await r.json();
  assert.equal(r.status, 400);
  assert.match(cuerpo.error, /vacio/);
});

test('un json roto da 400 y no un 500 con stack', async () => {
  const r = await comoDueno('/api/chat/enviar', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{esto no es json',
  });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /json invalido/);
});

test('sin vinculos, mandar da 502 y dice por que, red por red', async () => {
  const r = await comoDueno('/api/chat/enviar', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ texto: 'hola', destino: 'ambos' }),
  });
  const cuerpo = await r.json();
  assert.equal(r.status, 502);
  assert.equal(cuerpo.kick.ok, false);
  assert.equal(cuerpo.twitch.ok, false);
  assert.match(cuerpo.error, /vinculo/);
});

test('cuando la plataforma frena, la respuesta es 429 con Retry-After y no un 502', async () => {
  /* El unico caso en el que la pagina NO tiene que reintentar sola: si
     Kick esta frenando los envios, un 502 la haria mandar de nuevo en
     el acto y empeorar el rate limit. El 429 con `esperar` es lo que
     arranca la cuenta regresiva y deshabilita el boton.

     El vinculo se guarda de verdad y lo que se falsea es la API de
     Kick, no chat.js: asi el camino que se prueba es el mismo que
     corre en produccion (vinculo -> token -> POST /chat -> error con
     status). Los pedidos que no van a Kick pasan derecho, porque el
     cliente de este test tambien usa fetch. */
  const fetchDeVerdad = globalThis.fetch;
  await vinculos.guardar('istincho', 'kick', {
    usuarioId: '4242',
    nombre: 'IsTincho',
    slug: 'istincho',
    accessToken: 'token-de-prueba',
    refreshToken: 'refresco-de-prueba',
    venceEn: Date.now() + 3600_000,
    scopes: 'user:read chat:write',
  });
  globalThis.fetch = async (recurso, opciones) => {
    if (!String(recurso).includes('api.kick.com')) return fetchDeVerdad(recurso, opciones);
    return new Response(JSON.stringify({ message: 'Too Many Requests' }), { status: 429 });
  };

  try {
    const r = await comoDueno('/api/chat/enviar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texto: 'hola', destino: 'kick' }),
    });
    const cuerpo = await r.json();

    assert.equal(r.status, 429);
    assert.equal(r.headers.get('retry-after'), '5', 'el cliente HTTP tiene que poder esperar sin leer el cuerpo');
    assert.equal(cuerpo.esperar, 5, 'y la pagina tambien, para su cuenta regresiva');
    assert.equal(cuerpo.kick.ok, false);
    assert.equal(cuerpo.kick.estado, 429, 'el status de la plataforma llega hasta arriba');
  } finally {
    globalThis.fetch = fetchDeVerdad;
    await vinculos.olvidar('istincho', 'kick');
  }
});

test('un error que no es 429 sigue siendo 502', async () => {
  /* La otra mitad: si todo error de envio contestara 429, la pagina
     se pondria a esperar cinco segundos por cosas que no se arreglan
     esperando. */
  const fetchDeVerdad = globalThis.fetch;
  await vinculos.guardar('istincho', 'kick', {
    usuarioId: '4242', nombre: 'IsTincho', slug: 'istincho',
    accessToken: 'token-de-prueba', refreshToken: 'refresco-de-prueba',
    venceEn: Date.now() + 3600_000, scopes: 'user:read chat:write',
  });
  globalThis.fetch = async (recurso, opciones) => {
    if (!String(recurso).includes('api.kick.com')) return fetchDeVerdad(recurso, opciones);
    return new Response(JSON.stringify({ message: 'nope' }), { status: 403 });
  };

  try {
    const r = await comoDueno('/api/chat/enviar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texto: 'hola', destino: 'kick' }),
    });
    await r.text();
    assert.equal(r.status, 502);
    assert.equal(r.headers.get('retry-after'), null);
  } finally {
    globalThis.fetch = fetchDeVerdad;
    await vinculos.olvidar('istincho', 'kick');
  }
});

test('resuscribir sin vinculo con Kick contesta 502 y no rompe', async () => {
  const r = await comoDueno('/api/chat/resuscribir', { method: 'POST' });
  const cuerpo = await r.json();
  assert.equal(r.status, 502);
  assert.match(cuerpo.error, /vinculo/);
});

/* -------------------------------------------------- vincular Twitch */

test('vincular Twitch sin ser el dueño no guarda nada', async () => {
  /* Twitch se VINCULA, no se loguea: la identidad la da Kick. Sin esta
     guarda, el token de Twitch de cualquiera quedaria guardado como si
     fuera el del dueño, y el servidor mandaria mensajes al chat de esa
     persona. */
  const entrar = await fetch(`${raiz}/oauth/twitch/entrar`, { redirect: 'manual' });
  await entrar.text();
  const estado = new URL(entrar.headers.get('location')).searchParams.get('state');
  assert.ok(estado, 'el flujo tiene que arrancar con un state');

  const volver = await fetch(`${raiz}/oauth/twitch/volver?code=loquesea&state=${estado}`);
  const html = await volver.text();
  assert.match(html, /Primero entra con Kick/,
    'se corta antes de canjear el codigo, no despues');

  assert.equal(await almacen.obtener('tokens', 'twitch:dueno'), null,
    'y no quedo ningun vinculo guardado');
});

/* ------------------------------------------------- de punta a punta */

test('un mensaje de Kick entra por el webhook y sale por el SSE con el formato unico', async () => {
  /* Este es el criterio de aceptacion de la fase, hecho test: lo que
     Kick manda firmado tiene que aparecer en /chat traducido. Cubre el
     camino entero (firma, dedupe, traduccion, bus) y no cada pedazo
     por separado, que es donde se esconden las costuras. */
  const corte = new AbortController();
  const r = await fetch(`${raiz}/eventos/istincho`, { signal: corte.signal });
  const lector = r.body.getReader();
  await lector.read();                       // el evento de estado inicial

  const id = 'e2e-' + Date.now();
  const ts = new Date().toISOString();
  const envio = await fetch(`${raiz}/kick/webhook`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Kick-Event-Message-Id': id,
      'Kick-Event-Message-Timestamp': ts,
      'Kick-Event-Type': 'chat.message.sent',
      'Kick-Event-Version': '1',
      'Kick-Event-Signature': firmarWebhook(id, ts, PAYLOAD),
    },
    body: PAYLOAD,
  });
  assert.equal(envio.status, 200);

  const { value } = await lector.read();
  const trozo = new TextDecoder().decode(value);
  /* Sin nombre de evento: todo sale como el `message` por defecto y el
     tipo viaja adentro del data. Un `event: chat` no llegaria nunca al
     listener de 'message' del navegador. */
  assert.ok(!trozo.includes('event:'), 'el evento sale sin nombre');
  const [primeraLinea] = trozo.slice(trozo.indexOf('data: ') + 6).split(/\r?\n/);
  const datos = JSON.parse(primeraLinea);
  assert.equal(datos.tipo, 'chat');
  assert.equal(datos.red, 'kick');
  assert.equal(datos.usuario, 'unaespectadora');
  assert.equal(datos.texto, 'que peli mas larga HYPERCLAP');
  assert.equal(datos.color, '#ff5733');
  assert.ok(datos.emotes.length === 1 && datos.emotes[0].url.includes('files.kick.com'));

  corte.abort();
  await lector.cancel().catch(() => {});
});

test('el mismo webhook dos veces se muestra una sola vez', async () => {
  const id = 'repetido-' + Date.now();
  const ts = new Date().toISOString();
  const cabeceras = {
    'Content-Type': 'application/json',
    'Kick-Event-Message-Id': id,
    'Kick-Event-Message-Timestamp': ts,
    'Kick-Event-Type': 'chat.message.sent',
    'Kick-Event-Version': '1',
    'Kick-Event-Signature': firmarWebhook(id, ts, PAYLOAD),
  };
  const antes = canales.ultimos('istincho').length;
  await fetch(`${raiz}/kick/webhook`, { method: 'POST', headers: cabeceras, body: PAYLOAD });
  const segunda = await fetch(`${raiz}/kick/webhook`, { method: 'POST', headers: cabeceras, body: PAYLOAD });
  assert.equal(await segunda.text(), 'repetido');
  assert.equal(canales.ultimos('istincho').length, antes + 1,
    'Kick reintenta: el mensaje no puede aparecer dos veces en el chat');
});

test('el endpoint de prueba puede inyectar un chat de verdad, no solo un evento crudo', async () => {
  /* Los webhooks de Kick no llegan a una maquina de casa y firmar uno
     a mano necesitaria la clave privada de Kick. Sin esto no habria
     forma de ver /chat con mensajes andando mientras se desarrolla.
     Solo existe con MODO=local. */
  const r = await fetch(`${raiz}/api/prueba/webhook?tipo=chat.message.sent&canal=istincho`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: PAYLOAD,
  });
  const cuerpo = await r.json();
  assert.equal(r.status, 200);
  assert.equal(cuerpo.hecho, 'chat');

  const ultimo = canales.ultimos('istincho').at(-1);
  assert.equal(ultimo.tipo, 'chat');
  assert.equal(ultimo.red, 'kick');
  assert.equal(ultimo.usuario, 'unaespectadora');
});

test('sin ?tipo el endpoint de prueba sigue difundiendo el evento crudo', async () => {
  /* Lo usa la Fase 0 para probar el cable del bus sin hablar del
     formato de los mensajes: no se le puede cambiar el significado. */
  const r = await fetch(`${raiz}/api/prueba/webhook?canal=istincho`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hola: 'mundo' }),
  });
  const cuerpo = await r.json();
  assert.equal(r.status, 200);
  assert.equal(typeof cuerpo.llegoA, 'number');
});
