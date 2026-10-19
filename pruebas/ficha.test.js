/* ============================================================
   La ficha de quien escribe: GET /api/panel/chatter (servidor/fichas.js).

   El servidor levantado de verdad y el `fetch` global reemplazado por
   uno que contesta como Kick y como Twitch solo para sus dominios.
   Lo que hay que garantizar:

     - los mensajes salen del buffer de LA sala de la cookie, de esa
       persona y de esa red, y nada mas;
     - Twitch: cuenta (token de app), sigue y sub (token del creador,
       contra SU canal);
     - lo que no se pudo traer va en `faltan` con el motivo, y NO como
       "no sigue" o "no es sub";
     - sin cookie de creador, 401; lo mal escrito, 400.
   ============================================================ */

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';

const DATOS = path.join(os.tmpdir(), 'sala-pruebas-ficha');
process.env.SALA_DATOS = DATOS;
process.env.MODO = 'local';
process.env.KICK_SLUG = 'istincho';
process.env.KICK_CLIENT_ID = 'cliente-de-prueba';
process.env.KICK_CLIENT_SECRET = 'secreto-de-prueba';
process.env.TWITCH_CLIENT_ID = 'cliente-twitch-de-prueba';
process.env.TWITCH_CLIENT_SECRET = 'secreto-twitch-de-prueba';
process.env.URL_BASE = 'https://sala.example';
process.env.CLAVE_CIFRADO = crypto.randomBytes(32).toString('base64');
process.env.EMOTES_7TV = '0';
process.env.EMOTES_TWITCH = '0';

const { crearServidor } = await import('../servidor/index.js');
const almacen = await import('../servidor/almacen.js');
const canales = await import('../servidor/canales.js');
const creadores = await import('../servidor/creadores.js');
const fichas = await import('../servidor/fichas.js');
const sesion = await import('../servidor/sesion.js');
const vinculos = await import('../servidor/vinculos.js');

const ANA = 'ana';

/* ------------------------------------------ los fetch de afuera */

const fetchDeVerdad = globalThis.fetch;
let pedidos = [];
let twitchCaido = false;
let sigue = true;

const json = (cuerpo, status = 200) =>
  new Response(JSON.stringify(cuerpo), { status, headers: { 'Content-Type': 'application/json' } });

globalThis.fetch = async (entrada, opciones) => {
  const url = String(typeof entrada === 'string' ? entrada : entrada?.url ?? '');
  if (url.startsWith('https://id.twitch.tv/oauth2/token') || url.startsWith('https://id.kick.com/oauth/token')) {
    return json({ access_token: 'token-de-app', expires_in: 3600, token_type: 'bearer' });
  }
  if (url.startsWith('https://api.twitch.tv') || url.startsWith('https://api.kick.com')) {
    pedidos.push({ url, auth: opciones?.headers?.Authorization ?? '' });
    if (twitchCaido && url.includes('twitch')) return json({}, 500);
    const u = new URL(url);
    if (u.pathname === '/helix/users') {
      return json({ data: [{ id: '77', login: 'purpleguy', display_name: 'PurpleGuy',
        profile_image_url: 'https://static-cdn.example/77.png', created_at: '2019-03-12T10:00:00Z' }] });
    }
    if (u.pathname === '/helix/channels/followers') {
      return json({ data: sigue ? [{ user_id: '77', followed_at: '2025-06-01T00:00:00Z' }] : [] });
    }
    if (u.pathname === '/helix/subscriptions') return json({ data: [{ tier: '2000', is_gift: true }] });
    if (u.pathname === '/public/v1/users') {
      return json({ data: [{ user_id: 909, name: 'ElkaChonda', profile_picture: 'https://files.kick.example/909.webp' }] });
    }
    return json({}, 404);
  }
  return fetchDeVerdad(entrada, opciones);
};

/* --------------------------------------------------------- ayudas */

let servidor;
let raiz;
let cookieAna = '';

async function ficha(query, cookie = cookieAna) {
  const r = await fetch(`${raiz}/api/panel/chatter?${query}`, { headers: cookie ? { Cookie: cookie } : {} });
  return { estado: r.status, datos: await r.json().catch(() => null) };
}

test.before(async () => {
  await fsp.rm(DATOS, { recursive: true, force: true }).catch(() => {});
  await almacen.poner('creadores', ANA, { slug: ANA, plan: 'pendiente', usuarioId: '4242', creado: Date.now() });
  await vinculos.guardar(ANA, 'twitch', {
    usuarioId: '5555', nombre: 'Ana', login: ANA, slug: ANA,
    accessToken: 'acceso-ana-twitch', refreshToken: 'refresco-ana-twitch',
    venceEn: Date.now() + 3600_000, scopes: 'user:read:chat moderator:read:followers channel:read:subscriptions',
  });
  cookieAna = `${sesion.COOKIES.dueno}=` +
    await sesion.crear({ tipo: 'dueno', usuario: '4242', nombre: 'Ana', slug: ANA });
  servidor = crearServidor();
  await new Promise(ok => servidor.listen(0, '127.0.0.1', ok));
  raiz = `http://127.0.0.1:${servidor.address().port}`;
});

test.beforeEach(() => {
  pedidos = [];
  twitchCaido = false;
  sigue = true;
  fichas.olvidarCache();
  canales.olvidarMensajes(ANA, () => true);
  canales.olvidarMensajes('otra', () => true);
  const m = (red, id, usuarioId, usuario, texto) =>
    ({ tipo: 'chat', red, id, usuarioId, usuario, texto, emotes: [], insignias: [], hora: new Date().toISOString() });
  canales.recordar(ANA, m('twitch', 't1', '77', 'PurpleGuy', 'hola'));
  canales.recordar(ANA, m('kick', 'k1', '77', 'OtroDeKick', 'yo soy otro'));
  canales.recordar(ANA, m('twitch', 't2', '78', 'Fulano', 'nada que ver'));
  canales.recordar(ANA, m('twitch', 't3', '77', 'PurpleGuy', 'chau'));
  canales.recordar('otra', m('twitch', 'x1', '77', 'PurpleGuy', 'en otra sala'));
});

test.after(async () => {
  globalThis.fetch = fetchDeVerdad;
  canales.cerrarTodo();
  await new Promise(ok => servidor.close(ok));
  await fsp.rm(DATOS, { recursive: true, force: true }).catch(() => {});
});

/* ----------------------------------------------------------- Twitch */

test('Twitch: sus mensajes de ESTA sala y ESTA red, la cuenta, si sigue y si es sub', async () => {
  const r = await ficha('red=twitch&id=77');
  assert.equal(r.estado, 200, JSON.stringify(r.datos));
  const f = r.datos;
  assert.deepEqual(f.mensajes.map(m => m.id), ['t1', 't3'],
    'ni el 77 de Kick, ni el de otra sala, ni otra persona');
  assert.equal(f.nombre, 'PurpleGuy');
  assert.equal(f.creada, '2019-03-12T10:00:00Z');
  assert.equal(f.avatar, 'https://static-cdn.example/77.png');
  assert.equal(f.perfil, 'https://www.twitch.tv/purpleguy');
  assert.equal(f.sigueDesde, '2025-06-01T00:00:00Z');
  assert.deepEqual(f.sub, { nivel: 2, regalada: true });
  assert.deepEqual(f.faltan, []);
  assert.equal(f.bloqueado, false);

  const seguir = pedidos.find(p => p.url.includes('/channels/followers'));
  assert.match(seguir.url, /broadcaster_id=5555/, 'contra el canal del creador de la cookie');
  assert.equal(seguir.auth, 'Bearer acceso-ana-twitch');
});

test('"no sigue" es una respuesta; "no se pudo preguntar" es otra', async () => {
  sigue = false;
  let f = (await ficha('red=twitch&id=77')).datos;
  assert.equal(f.sigueDesde, '', 'Twitch contesto que no lo sigue');

  fichas.olvidarCache();
  twitchCaido = true;
  f = (await ficha('red=twitch&id=77')).datos;
  assert.equal(f.sigueDesde, null, 'no se sabe: no es "no"');
  assert.equal(f.sub, null);
  assert.ok(f.faltan.some(x => x.dato === 'sigue'));
  assert.ok(f.faltan.some(x => x.dato === 'cuenta'));
  assert.deepEqual(f.mensajes.map(m => m.id), ['t1', 't3'], 'los mensajes estan igual');
});

test('tocar el mismo nombre dos veces seguidas no vuelve a preguntarle a Twitch', async () => {
  await ficha('red=twitch&id=77');
  const antes = pedidos.length;
  await ficha('red=twitch&id=77');
  assert.equal(pedidos.length, antes);
});

/* ------------------------------------------------------------- Kick */

test('Kick: nombre y foto por la API publica; ni fecha ni follow, porque Kick no los da', async () => {
  canales.recordar(ANA, { tipo: 'chat', red: 'kick', id: 'k9', usuarioId: '909', usuario: 'ElkaChonda',
    texto: 'buenas', emotes: [], insignias: [{ tipo: 'subscriber', texto: 'Sub 6 meses' }], hora: new Date().toISOString() });
  const f = (await ficha('red=kick&id=909')).datos;
  assert.equal(f.avatar, 'https://files.kick.example/909.webp');
  assert.equal(f.perfil, 'https://kick.com/elkachonda');
  assert.equal(f.creada, '');
  assert.equal(f.sigueDesde, null);
  assert.deepEqual(f.insignias.map(i => i.texto), ['Sub 6 meses']);
});

test('quien esta bloqueado en esta herramienta, lo dice', async () => {
  await creadores.ponerChatAbierto(ANA, { bloquear: { red: 'twitch', id: '77', nombre: 'PurpleGuy' } });
  const f = (await ficha('red=twitch&id=77')).datos;
  assert.equal(f.bloqueado, true);
  await creadores.ponerChatAbierto(ANA, { desbloquear: { red: 'twitch', id: '77' } });
});

/* ------------------------------------------------- quien y que */

test('sin cookie de creador, 401; lo mal escrito, 400; y no sale ningun pedido', async () => {
  assert.equal((await ficha('red=twitch&id=77', '')).estado, 401);
  for (const q of ['red=youtube&id=77', 'red=twitch&id=abc', 'red=twitch', 'id=77']) {
    assert.equal((await ficha(q)).estado, 400, q);
  }
  assert.equal(pedidos.length, 0);
});
