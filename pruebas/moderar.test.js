/* ============================================================
   Moderar de verdad desde /chat: borrar, timeout y ban en Kick y en
   Twitch (POST /api/panel/moderar, servidor/moderacion.js).

   El servidor levantado de verdad, y el `fetch` global reemplazado
   por uno que contesta como Kick y como Twitch SOLO para sus dominios,
   igual que chat-enviar. Lo que hay que garantizar:

     - cada accion le pega al endpoint correcto de cada red, con el
       canal del CREADOR de la cookie (nunca uno que venga del cuerpo),
       y con la unidad de cada red (Kick minutos, Twitch segundos);
     - un vinculo sin los permisos de moderacion no gasta un pedido y
       dice que hacer;
     - sin cookie de creador, o con un `Origin` ajeno, no pasa nada;
     - lo que se borra se va del buffer: quien se conecta despues no
       lo recibe;
     - un ban o un borrado hecho desde kick.com o twitch.tv tambien.

   Lo que NO se puede probar asi: que Kick acepte los scopes nuevos en
   la app de verdad. Ver la BITACORA.
   ============================================================ */

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';

const DATOS = path.join(os.tmpdir(), 'sala-pruebas-moderar');
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
const chat = await import('../servidor/chat.js');
const mensajes = await import('../servidor/mensajes.js');
const moderacion = await import('../servidor/moderacion.js');
const sesion = await import('../servidor/sesion.js');
const vinculos = await import('../servidor/vinculos.js');

const ANA = 'ana';
const NUESTRO = 'https://sala.example';

const KICK_TODO = 'user:read channel:read chat:write events:subscribe moderation:ban moderation:chat_message:manage';
const TWITCH_TODO = 'user:read:chat user:write:chat moderator:manage:banned_users moderator:manage:chat_messages';

/* ------------------------------------------ los fetch de afuera */

const fetchDeVerdad = globalThis.fetch;
let pedidos = [];
let respuesta = null;    // null = lo que contestaria si sale bien

globalThis.fetch = async (entrada, opciones) => {
  const url = String(typeof entrada === 'string' ? entrada : entrada?.url ?? '');
  if (url.startsWith('https://api.kick.com') || url.startsWith('https://api.twitch.tv')) {
    pedidos.push({
      url,
      metodo: opciones?.method ?? 'GET',
      cuerpo: opciones?.body ? JSON.parse(opciones.body) : undefined,
      auth: opciones?.headers?.Authorization ?? '',
    });
    if (respuesta) {
      return new Response(JSON.stringify(respuesta.cuerpo ?? {}), {
        status: respuesta.estado, headers: { 'Content-Type': 'application/json' },
      });
    }
    const borra = (opciones?.method ?? 'GET') === 'DELETE';
    return new Response(borra ? null : '{"data":{}}', { status: borra ? 204 : 200 });
  }
  if (url.startsWith('https://id.twitch.tv/oauth2/token')) {
    /* Un refresh que NO trae los scopes: ver el test de vinculos. */
    return new Response(JSON.stringify({
      access_token: 'acceso-twitch-refrescado', refresh_token: 'refresco-twitch-nuevo',
      expires_in: 3600, scope: [],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  return fetchDeVerdad(entrada, opciones);
};

/* --------------------------------------------------------- ayudas */

let servidor;
let raiz;
let cookieAna = '';

async function pedir(ruta, { metodo = 'GET', cookie = '', cuerpo, origen = NUESTRO } = {}) {
  const h = {};
  if (cookie) h.Cookie = cookie;
  if (origen) h.Origin = origen;
  if (cuerpo !== undefined) h['Content-Type'] = 'application/json';
  const r = await fetch(raiz + ruta, {
    method: metodo, headers: h, body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
  });
  const texto = await r.text();
  let datos = null;
  try { datos = JSON.parse(texto); } catch { /* no era json */ }
  return { estado: r.status, datos };
}

const moderar = (cuerpo, extra = {}) =>
  pedir('/api/panel/moderar', { metodo: 'POST', cookie: cookieAna, cuerpo, ...extra });

async function vincular({ kick = KICK_TODO, twitch = TWITCH_TODO, venceTwitch = Date.now() + 3600_000 } = {}) {
  await vinculos.guardar(ANA, 'kick', {
    usuarioId: '4242', nombre: 'Ana', login: ANA, slug: ANA,
    accessToken: 'acceso-ana-kick', refreshToken: 'refresco-ana-kick',
    venceEn: Date.now() + 3600_000, scopes: kick,
  });
  await vinculos.guardar(ANA, 'twitch', {
    usuarioId: '5555', nombre: 'Ana', login: ANA, slug: ANA,
    accessToken: 'acceso-ana-twitch', refreshToken: 'refresco-ana-twitch',
    venceEn: venceTwitch, scopes: twitch,
  });
}

const enBuffer = () => canales.ultimos(ANA).map(m => `${m.red}:${m.id}`);

function llenarBuffer() {
  canales.olvidarMensajes(ANA, () => true);
  for (const [red, id, usuarioId] of [
    ['kick', 'k1', '909'], ['kick', 'k2', '909'], ['kick', 'k3', '111'],
    ['twitch', 't1', '909'], ['twitch', 't2', '222'],
  ]) {
    canales.recordar(ANA, { tipo: 'chat', red, id, usuarioId, usuario: 'x', texto: 'hola' });
  }
}

/* ------------------------------------------------------- arranque */

test.before(async () => {
  await fsp.rm(DATOS, { recursive: true, force: true }).catch(() => {});
  await almacen.poner('creadores', ANA, { slug: ANA, plan: 'pendiente', usuarioId: '4242', creado: Date.now() });
  cookieAna = `${sesion.COOKIES.dueno}=` +
    await sesion.crear({ tipo: 'dueno', usuario: '4242', nombre: 'Ana', slug: ANA });
  servidor = crearServidor();
  await new Promise(ok => servidor.listen(0, '127.0.0.1', ok));
  raiz = `http://127.0.0.1:${servidor.address().port}`;
});

test.beforeEach(async () => {
  pedidos = [];
  respuesta = null;
  await vincular();
  llenarBuffer();
});

test.after(async () => {
  globalThis.fetch = fetchDeVerdad;
  canales.cerrarTodo();
  await new Promise(ok => servidor.close(ok));
  await fsp.rm(DATOS, { recursive: true, force: true }).catch(() => {});
});

/* ------------------------------------------------------------ Kick */

test('borrar en Kick: DELETE del mensaje con el token del creador, y se va del buffer', async () => {
  const r = await moderar({ accion: 'borrar', red: 'kick', mensajeId: 'k1' });
  assert.equal(r.estado, 200, JSON.stringify(r.datos));
  assert.equal(pedidos.length, 1);
  assert.equal(pedidos[0].metodo, 'DELETE');
  assert.equal(pedidos[0].url, 'https://api.kick.com/public/v1/chat/k1');
  assert.equal(pedidos[0].auth, 'Bearer acceso-ana-kick');
  assert.deepEqual(enBuffer(), ['kick:k2', 'kick:k3', 'twitch:t1', 'twitch:t2']);
});

test('timeout en Kick va en MINUTOS al canal del creador, y se lleva todo lo de esa persona en Kick', async () => {
  const r = await moderar({ accion: 'timeout', red: 'kick', usuarioId: '909', minutos: 30 });
  assert.equal(r.estado, 200, JSON.stringify(r.datos));
  assert.equal(pedidos[0].url, 'https://api.kick.com/public/v1/moderation/bans');
  assert.equal(pedidos[0].metodo, 'POST');
  assert.deepEqual(pedidos[0].cuerpo, { broadcaster_user_id: 4242, user_id: 909, duration: 30 });
  assert.deepEqual(enBuffer(), ['kick:k3', 'twitch:t1', 'twitch:t2'],
    'el 909 de Twitch es otra persona: no se toca');
});

test('ban en Kick no lleva duracion; desbanear es DELETE', async () => {
  await moderar({ accion: 'ban', red: 'kick', usuarioId: '909' });
  assert.deepEqual(pedidos[0].cuerpo, { broadcaster_user_id: 4242, user_id: 909 });
  await moderar({ accion: 'desbanear', red: 'kick', usuarioId: '909' });
  assert.equal(pedidos[1].metodo, 'DELETE');
  assert.deepEqual(pedidos[1].cuerpo, { broadcaster_user_id: 4242, user_id: 909 });
});

test('el canal sale de la cookie: un broadcaster en el cuerpo no se lee', async () => {
  await moderar({ accion: 'ban', red: 'kick', usuarioId: '909', broadcaster_user_id: 1, slug: 'otro' });
  assert.equal(pedidos[0].cuerpo.broadcaster_user_id, 4242);
});

/* ---------------------------------------------------------- Twitch */

test('timeout en Twitch va en SEGUNDOS, con moderator_id = broadcaster_id = el creador', async () => {
  const r = await moderar({ accion: 'timeout', red: 'twitch', usuarioId: '909' });
  assert.equal(r.estado, 200, JSON.stringify(r.datos));
  const u = new URL(pedidos[0].url);
  assert.equal(u.origin + u.pathname, 'https://api.twitch.tv/helix/moderation/bans');
  assert.equal(u.searchParams.get('broadcaster_id'), '5555');
  assert.equal(u.searchParams.get('moderator_id'), '5555');
  assert.deepEqual(pedidos[0].cuerpo, { data: { user_id: '909', duration: 600 } },
    'sin minutos son 10, y Twitch los quiere en segundos');
  assert.deepEqual(enBuffer(), ['kick:k1', 'kick:k2', 'kick:k3', 'twitch:t2']);
});

test('borrar en Twitch: DELETE /moderation/chat con el message_id', async () => {
  await moderar({ accion: 'borrar', red: 'twitch', mensajeId: 't2' });
  const u = new URL(pedidos[0].url);
  assert.equal(u.pathname, '/helix/moderation/chat');
  assert.equal(u.searchParams.get('message_id'), 't2');
  assert.equal(pedidos[0].metodo, 'DELETE');
});

test('lo que Twitch explica se le muestra al creador tal cual', async () => {
  respuesta = { estado: 400, cuerpo: { error: 'Bad Request', status: 400, message: 'user is already banned' } };
  const r = await moderar({ accion: 'ban', red: 'twitch', usuarioId: '909' });
  assert.equal(r.estado, 400);
  assert.match(r.datos.error, /user is already banned/);
  assert.equal(enBuffer().length, 5, 'no salio: no se borra nada');
});

test('un mensaje que Twitch ya no encuentra se explica (6 horas)', async () => {
  respuesta = { estado: 404, cuerpo: { message: 'not found' } };
  const r = await moderar({ accion: 'borrar', red: 'twitch', mensajeId: 't1' });
  assert.equal(r.estado, 404);
  assert.match(r.datos.error, /6 horas/);
});

/* -------------------------------------------------------- permisos */

test('un vinculo sin los permisos de moderacion no gasta un pedido y dice que hacer', async () => {
  await vincular({ kick: 'user:read channel:read chat:write events:subscribe', twitch: 'user:read:chat user:write:chat' });
  const k = await moderar({ accion: 'ban', red: 'kick', usuarioId: '909' });
  assert.equal(k.estado, 403);
  assert.equal(k.datos.faltaPermiso, true);
  assert.match(k.datos.error, /volvé a entrar con Kick/);
  const t = await moderar({ accion: 'borrar', red: 'twitch', mensajeId: 't1' });
  assert.equal(t.estado, 403);
  assert.match(t.datos.error, /volvé a vincular Twitch/);
  assert.equal(pedidos.length, 0);
});

test('un 401 de la red tambien se lee como "falta el permiso"', async () => {
  respuesta = { estado: 401, cuerpo: { message: 'Unauthorized' } };
  const r = await moderar({ accion: 'ban', red: 'kick', usuarioId: '909' });
  assert.equal(r.estado, 401);
  assert.equal(r.datos.faltaPermiso, true);
});

test('el creador no se puede moderar a si mismo', async () => {
  const r = await moderar({ accion: 'ban', red: 'kick', usuarioId: '4242' });
  assert.equal(r.estado, 400);
  assert.equal(pedidos.length, 0);
});

test('un refresh que no trae scopes no le saca la moderacion al vinculo', async () => {
  await vincular({ venceTwitch: Date.now() - 1000 });
  const r = await moderar({ accion: 'ban', red: 'twitch', usuarioId: '909' });
  assert.equal(r.estado, 200, JSON.stringify(r.datos));
  assert.equal(pedidos[0].auth, 'Bearer acceso-twitch-refrescado');
  const v = await vinculos.leer(ANA, 'twitch');
  assert.match(v.scopes, /moderator:manage:banned_users/);
  const a = await vinculos.acceso(ANA, 'twitch');
  assert.match(a.scopes, /moderator:manage:banned_users/, 'acceso() devuelve los scopes');
});

/* ------------------------------------------------- quien y desde donde */

test('sin cookie de creador, 401; con Origin ajeno, 403; y no sale ningun pedido', async () => {
  const sin = await moderar({ accion: 'ban', red: 'kick', usuarioId: '909' }, { cookie: '' });
  assert.equal(sin.estado, 401);
  const ajeno = await moderar({ accion: 'ban', red: 'kick', usuarioId: '909' }, { origen: 'https://malo.example' });
  assert.equal(ajeno.estado, 403);
  assert.equal(pedidos.length, 0);
  assert.equal(enBuffer().length, 5);
});

test('lo que llega mal escrito rebota con 400 antes de tocar nada', async () => {
  for (const cuerpo of [
    { accion: 'explotar', red: 'kick', usuarioId: '909' },
    { accion: 'ban', red: 'youtube', usuarioId: '909' },
    { accion: 'ban', red: 'kick', usuarioId: '9 OR 1' },
    { accion: 'borrar', red: 'kick' },
    { accion: 'timeout', red: 'kick', usuarioId: '909', minutos: 0 },
    { accion: 'timeout', red: 'kick', usuarioId: '909', minutos: 20_000 },
  ]) {
    const r = await moderar(cuerpo);
    assert.equal(r.estado, 400, JSON.stringify(cuerpo));
  }
  assert.equal(pedidos.length, 0);
});

/* ------------------------------------- lo que pasa en la plataforma */

test('un ban hecho en kick.com (moderation.banned) saca los mensajes de esa persona', () => {
  const r = chat.recibirDeKick(ANA, { tipo: 'moderation.banned' }, {
    broadcaster: { user_id: 4242, channel_slug: ANA },
    banned_user: { user_id: 909, username: 'fulana' },
    metadata: { reason: '', expires_at: null },
  });
  assert.equal(r.hecho, 'borrado');
  assert.deepEqual(enBuffer(), ['kick:k3', 'twitch:t1', 'twitch:t2']);
});

test('los EventSub de borrado de Twitch se traducen a los tres alcances', () => {
  assert.deepEqual(mensajes.borradoDeTwitch('channel.chat.message_delete', { message_id: 'abc-1' }),
    { tipo: 'borrado', red: 'twitch', mensajeId: 'abc-1' });
  assert.deepEqual(mensajes.borradoDeTwitch('channel.chat.clear_user_messages', { target_user_id: '77' }),
    { tipo: 'borrado', red: 'twitch', usuarioId: '77' });
  assert.deepEqual(mensajes.borradoDeTwitch('channel.chat.clear', {}),
    { tipo: 'borrado', red: 'twitch', todo: true });
  assert.equal(mensajes.borradoDeTwitch('channel.chat.message_delete', { message_id: '<script>' }), null,
    'un id raro no sale por el bus');
});

test('vaciar el chat de Twitch saca solo lo de Twitch, y nunca la actividad', () => {
  canales.recordar(ANA, { tipo: 'actividad', red: 'twitch', id: 'a1', clase: 'sub' });
  chat.borrar(ANA, mensajes.borradoDeTwitch('channel.chat.clear', {}));
  assert.deepEqual(enBuffer(), ['kick:k1', 'kick:k2', 'kick:k3', 'twitch:a1']);
});

test('porQueNo y permisoQueFalta, sueltas', () => {
  assert.equal(moderacion.porQueNo({ accion: 'timeout', red: 'kick', usuarioId: '1', minutos: 10_080 }), '');
  assert.equal(moderacion.permisoQueFalta('kick', 'user:read', 'borrar'), 'moderation:chat_message:manage');
  assert.equal(moderacion.permisoQueFalta('twitch', ['moderator:manage:banned_users'], 'timeout'), '');
  assert.equal(moderacion.permisoQueFalta('kick', '', 'ban'), '', 'sin scopes anotados se prueba');
});
