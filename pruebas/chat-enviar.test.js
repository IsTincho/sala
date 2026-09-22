/* ============================================================
   Fases 5.2 y 5.3 de punta a punta: el espectador escribe desde
   `/chat/<slug>` en Kick, en Twitch o en las dos (PLAN-MULTICHAT.md).

   El servidor levantado de verdad en un puerto libre y pedidos HTTP
   reales, igual que sala-http y chat-abierto. Lo que hay que
   garantizar es lo que ve (y lo que NO puede hacer) el de afuera:

     - el selector muestra solo las redes que la persona conecto Y que
       el creador abrio;
     - con el chat cerrado, o con una red que el creador no comparte,
       el envio rebota con 403 aunque la caja siga en pantalla;
     - un 200 de Twitch con `is_sent: false` NO es un envio: el
       `drop_reason` se le muestra a la persona;
     - con "ambas", si una red falla y la otra no, se dice exactamente
       cual fallo y por que;
     - uno cada dos segundos por persona, y "ambas" cuenta como uno;
     - un POST con un `Origin` ajeno no escribe nada;
     - salir borra los tokens de LAS DOS redes;
     - un espectador de antes de Twitch sigue escribiendo, con su
       cookie de siempre.

   ---------------------------------------------------------------
   NO SALE UN BYTE A INTERNET

   Se reemplaza el `fetch` global por uno que contesta como Kick y
   como Twitch SOLO para sus dominios y deja pasar todo lo demas (los
   pedidos de este test al servidor son fetch tambien). Asi se ejercita
   el codigo de verdad de `kick.js` y de `twitch.js` —incluido el
   camino de `is_sent`/`drop_reason` y el del 429— sin credenciales
   reales. Lo que NO se puede probar asi esta anotado en la BITACORA:
   que Twitch acepte de verdad un token de espectador con
   `user:write:chat` es algo que solo se ve en produccion.
   ============================================================ */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';

/* Las variables van ANTES de importar el servidor: los modulos las
   leen al cargarse. Ninguna es un secreto: son de mentira. */
const DATOS = path.join(os.tmpdir(), 'sala-pruebas-chat-enviar');
process.env.SALA_DATOS = DATOS;
process.env.MODO = 'local';
process.env.KICK_SLUG = 'istincho';
process.env.KICK_CLIENT_ID = 'cliente-de-prueba';
process.env.KICK_CLIENT_SECRET = 'secreto-de-prueba';
process.env.TWITCH_CLIENT_ID = 'cliente-twitch-de-prueba';
process.env.TWITCH_CLIENT_SECRET = 'secreto-twitch-de-prueba';
process.env.URL_BASE = 'https://sala.example';
/* El segundo dominio: el proxy de Cloudflare Pages delante de Railway.
   Los dos son nuestros y los dos tienen que poder escribir. */
process.env.ORIGENES = 'https://multichat.example';
process.env.CLAVE_CIFRADO = crypto.randomBytes(32).toString('base64');

const { crearServidor } = await import('../servidor/index.js');
const almacen = await import('../servidor/almacen.js');
const canales = await import('../servidor/canales.js');
const cifrado = await import('../servidor/cifrado.js');
const creadores = await import('../servidor/creadores.js');
const espectadores = await import('../servidor/espectadores.js');
const sesion = await import('../servidor/sesion.js');
const vinculos = await import('../servidor/vinculos.js');

const ANA = 'ana';
const NUESTRO = 'https://sala.example';

/* ------------------------------------------ los fetch de afuera */

const fetchDeVerdad = globalThis.fetch;

/* Lo que van a contestar las APIs en el proximo pedido. Cada test lo
   cambia a lo que necesita. */
let respuestaKick = { estado: 200, cuerpo: { data: { is_sent: true, message_id: 'k-1' } }, cabeceras: {} };
let respuestaTwitch = { estado: 200, cuerpo: { data: [{ is_sent: true, message_id: 't-1' }] }, cabeceras: {} };
let pedidosKick = [];
let pedidosTwitch = [];

const responder = ({ estado, cuerpo, cabeceras }) => new Response(JSON.stringify(cuerpo), {
  status: estado,
  headers: { 'Content-Type': 'application/json', ...cabeceras },
});

globalThis.fetch = async (entrada, opciones) => {
  const url = String(typeof entrada === 'string' ? entrada : entrada?.url ?? '');
  const anotar = donde => donde.push({ url, cuerpo: opciones?.body, cabeceras: opciones?.headers ?? {} });

  if (url.startsWith('https://api.kick.com')) {
    anotar(pedidosKick);
    return responder(respuestaKick);
  }
  if (url.startsWith('https://api.twitch.tv/helix/chat/messages')) {
    anotar(pedidosTwitch);
    return responder(respuestaTwitch);
  }
  if (url.startsWith('https://api.twitch.tv/helix/users')) {
    return responder({ estado: 200, cuerpo: { data: [{ id: '9090', login: 'unaespectadora', display_name: 'UnaEspectadora' }] }, cabeceras: {} });
  }
  if (url.startsWith('https://id.twitch.tv/oauth2/token')) {
    return responder({
      estado: 200,
      cuerpo: { access_token: 'acceso-twitch-nuevo', refresh_token: 'refresco-twitch-nuevo', expires_in: 3600, scope: ['user:write:chat'] },
      cabeceras: {},
    });
  }
  return fetchDeVerdad(entrada, opciones);
};

/* --------------------------------------------------------- ayudas */

let servidor;
let raiz;

let sesionAna = '';       // el creador, para /api/panel/chat
let conKick = '';         // espectador con Kick nada mas
let conLasDos = '';       // espectador con Kick y Twitch
let conTwitch = '';       // espectador con Twitch nada mas

const ID_KICK = 'esp_solokick';
const ID_LAS_DOS = 'esp_lasdos';
const ID_TWITCH = 'esp_solotwitch';

/**
 * Un pedido al servidor.
 *
 * Manda `Origin` por defecto porque eso es lo que hace un navegador:
 * los tests que prueban la defensa de CSRF lo cambian a mano.
 */
async function pedir(ruta, { metodo = 'GET', cookie = '', cuerpo, origen = NUESTRO, seguir = 'follow' } = {}) {
  const h = {};
  if (cookie) h.Cookie = cookie;
  if (origen) h.Origin = origen;
  if (cuerpo !== undefined) h['Content-Type'] = 'application/json';
  const r = await fetch(raiz + ruta, {
    method: metodo,
    headers: h,
    body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
    redirect: seguir,
  });
  const texto = await r.text();
  let datos = null;
  try { datos = JSON.parse(texto); } catch { /* no era json */ }
  return { estado: r.status, datos, texto, cabeceras: r.headers };
}

const enviar = (cookie, cuerpo, extra = {}) =>
  pedir(`/api/chat/${ANA}/enviar`, { metodo: 'POST', cookie, cuerpo, ...extra });

const cookieEspectador = v => `${sesion.COOKIES.espectador}=${v}`;

/** Un espectador con las redes que se le pidan, y su cookie. */
async function nuevoEspectador(id, redes) {
  if (redes.includes('kick')) {
    await espectadores.conectar(id, 'kick', {
      usuarioId: `kick-${id}`,
      nombre: `${id} en kick`,
      accessToken: `acceso-kick-${id}`,
      refreshToken: `refresco-kick-${id}`,
      venceEn: Date.now() + 3600_000,
      scopes: 'user:read chat:write',
    });
  }
  if (redes.includes('twitch')) {
    await espectadores.conectar(id, 'twitch', {
      usuarioId: `twitch-${id}`,
      nombre: `${id} en twitch`,
      login: id,
      accessToken: `acceso-twitch-${id}`,
      refreshToken: `refresco-twitch-${id}`,
      venceEn: Date.now() + 3600_000,
      scopes: 'user:write:chat',
    });
  }
  return cookieEspectador(await sesion.crear({ tipo: 'espectador', usuario: id, nombre: id }));
}

/** Abre o cierra el chat de Ana. Se usa el modulo: el panel ya tiene su prueba. */
const abrirChat = (activo, redes) => creadores.ponerChatAbierto(ANA, { activo, ...(redes ? { redes } : {}) });

/* ------------------------------------------------------- arranque */

test.before(async () => {
  await fsp.rm(DATOS, { recursive: true, force: true }).catch(() => {});

  await almacen.poner('creadores', ANA, { slug: ANA, plan: 'pendiente', usuarioId: '', creado: Date.now() });

  /* Los dos canales del creador: de aca salen el broadcaster de Kick y
     el broadcaster_id de Twitch a los que cae cada mensaje. */
  await vinculos.guardar(ANA, 'kick', {
    usuarioId: '4242', nombre: 'Ana', login: ANA, slug: ANA,
    accessToken: 'acceso-ana-kick', refreshToken: 'refresco-ana-kick',
    venceEn: Date.now() + 3600_000, scopes: 'user:read chat:write events:subscribe',
  });
  await vinculos.guardar(ANA, 'twitch', {
    usuarioId: '5555', nombre: 'Ana', login: ANA, slug: ANA,
    accessToken: 'acceso-ana-twitch', refreshToken: 'refresco-ana-twitch',
    venceEn: Date.now() + 3600_000, scopes: 'user:read:chat user:write:chat',
  });

  sesionAna = `${sesion.COOKIES.dueno}=` +
    await sesion.crear({ tipo: 'dueno', usuario: '111', nombre: 'Ana', slug: ANA });

  conKick = await nuevoEspectador(ID_KICK, ['kick']);
  conLasDos = await nuevoEspectador(ID_LAS_DOS, ['kick', 'twitch']);
  conTwitch = await nuevoEspectador(ID_TWITCH, ['twitch']);

  servidor = crearServidor();
  await new Promise(ok => servidor.listen(0, '127.0.0.1', ok));
  raiz = `http://127.0.0.1:${servidor.address().port}`;
});

test.beforeEach(async () => {
  espectadores.reiniciar();
  pedidosKick = [];
  pedidosTwitch = [];
  respuestaKick = { estado: 200, cuerpo: { data: { is_sent: true, message_id: 'k-1' } }, cabeceras: {} };
  respuestaTwitch = { estado: 200, cuerpo: { data: [{ is_sent: true, message_id: 't-1' }] }, cabeceras: {} };
  await abrirChat(true, ['kick', 'twitch']);
});

test.after(async () => {
  globalThis.fetch = fetchDeVerdad;
  canales.cerrarTodo();
  await new Promise(ok => servidor.close(ok));
  await fsp.rm(DATOS, { recursive: true, force: true }).catch(() => {});
});

/* ============================== el selector: /api/chat/:slug/yo */

test('sin sesion no hay nada que escribir, y no se cuenta quien mas esta', async () => {
  const { estado, datos } = await pedir(`/api/chat/${ANA}/yo`);
  assert.equal(estado, 200);
  assert.equal(datos.entrado, false);
  assert.deepEqual(datos.puedeEscribir, []);
  assert.deepEqual(datos.conectadas, {});
  /* Que redes abrio el creador es publico (la pagina lo necesita); QUIEN
     esta mirando, nunca. */
  assert.deepEqual(datos.redes, ['kick', 'twitch']);
  assert.equal(JSON.stringify(datos).includes(ID_LAS_DOS), false, 'no puede nombrar a nadie mas');
});

test('el selector muestra solo lo que la persona conecto', async () => {
  const soloKick = await pedir(`/api/chat/${ANA}/yo`, { cookie: conKick });
  assert.equal(soloKick.datos.entrado, true);
  assert.deepEqual(soloKick.datos.puedeEscribir, ['kick'], 'sin Twitch conectado no hay opcion de Twitch');
  assert.deepEqual(Object.keys(soloKick.datos.conectadas), ['kick']);
  assert.equal(soloKick.datos.conectadas.kick.nombre, `${ID_KICK} en kick`);

  const lasDos = await pedir(`/api/chat/${ANA}/yo`, { cookie: conLasDos });
  assert.deepEqual(lasDos.datos.puedeEscribir, ['kick', 'twitch'], 'con las dos, aparece "las dos"');

  const soloTwitch = await pedir(`/api/chat/${ANA}/yo`, { cookie: conTwitch });
  assert.deepEqual(soloTwitch.datos.puedeEscribir, ['twitch']);
});

test('el selector tampoco muestra una red que el creador no abrio', async () => {
  await abrirChat(true, ['kick']);

  const { datos } = await pedir(`/api/chat/${ANA}/yo`, { cookie: conLasDos });
  assert.deepEqual(datos.redes, ['kick']);
  assert.deepEqual(datos.puedeEscribir, ['kick'], 'tiene Twitch, pero acá no se usa');
  assert.deepEqual(Object.keys(datos.conectadas), ['kick', 'twitch'], 'lo que tiene es lo que tiene');
});

test('con el chat cerrado no se cuenta ni que redes eligio el creador', async () => {
  await abrirChat(false);

  const { datos } = await pedir(`/api/chat/${ANA}/yo`, { cookie: conLasDos });
  assert.equal(datos.abierto, false);
  assert.deepEqual(datos.redes, []);
  assert.deepEqual(datos.puedeEscribir, []);
});

test('el permiso viejo que no incluye escribir se dice antes de escribir', async () => {
  /* Mejor decirlo ahora que despues de que alguien escriba un mensaje
     largo y se coma un 401. */
  const id = 'esp_sinpermiso';
  const cookie = await nuevoEspectador(id, ['kick']);
  await espectadores.conectar(id, 'kick', {
    usuarioId: 'kick-viejo', nombre: 'sin permiso',
    accessToken: 'a', refreshToken: 'r', venceEn: Date.now() + 3600_000,
    scopes: 'user:read',
  });

  const { datos } = await pedir(`/api/chat/${ANA}/yo`, { cookie });
  assert.deepEqual(datos.conectadas.kick.nombre, 'sin permiso');
  assert.deepEqual(datos.puedeEscribir, []);

  const r = await enviar(cookie, { red: 'kick', texto: 'hola' });
  assert.equal(r.estado, 403);
  assert.match(r.datos.error, /no incluye escribir/);
  await espectadores.olvidar(id);
});

test('una sala que no existe da 404 en las dos rutas nuevas', async () => {
  assert.equal((await pedir('/api/chat/no-existe-esta-sala/yo')).estado, 404);
  const r = await pedir('/api/chat/no-existe-esta-sala/enviar', {
    metodo: 'POST', cookie: conKick, cuerpo: { red: 'kick', texto: 'hola' },
  });
  assert.equal(r.estado, 404);
});

/* ================================== el corte: cerrado y redes */

test('con el chat cerrado el envio rebota con 403, aunque la caja siga en pantalla', async () => {
  /* El corte de verdad esta en el servidor: alguien con la pagina
     abierta de antes de que el creador cerrara no puede escribir. */
  await abrirChat(false);

  const r = await enviar(conKick, { red: 'kick', texto: 'con el chat cerrado' });
  assert.equal(r.estado, 403);
  assert.match(r.datos.error, /cerrado/);
  assert.equal(pedidosKick.length, 0, 'no se le pidio nada a Kick');
});

test('una red que el creador no abrio da 403', async () => {
  await abrirChat(true, ['kick']);

  const r = await enviar(conLasDos, { red: 'twitch', texto: 'por una puerta que no abrio' });
  assert.equal(r.estado, 403);
  assert.match(r.datos.error, /no abrio Twitch/i);
  assert.equal(pedidosTwitch.length, 0);
});

test('"ambas" con una sola red abierta rebota entero y no manda a media', async () => {
  await abrirChat(true, ['kick']);

  const r = await enviar(conLasDos, { red: 'ambas', texto: 'a las dos' });
  assert.equal(r.estado, 403);
  assert.equal(pedidosKick.length, 0, 'ni siquiera sale por la red que si estaba abierta');
});

test('una red que la persona no conecto da 403', async () => {
  const r = await enviar(conKick, { red: 'twitch', texto: 'sin Twitch conectado' });
  assert.equal(r.estado, 403);
  assert.match(r.datos.error, /no conectaste Twitch/i);
});

test('sin sesion de espectador, 401', async () => {
  const r = await enviar('', { red: 'kick', texto: 'hola' });
  assert.equal(r.estado, 401);
  assert.match(r.datos.error, /conecta Kick o Twitch/i);
});

test('una red inventada da 400', async () => {
  for (const red of ['mastodon', '', undefined, 'ambos']) {
    const r = await enviar(conLasDos, { red, texto: 'hola' });
    assert.equal(r.estado, 400, `red: ${JSON.stringify(red)}`);
  }
});

/* ============================================ el envio de verdad */

test('a Kick: el mensaje sale al canal del creador con el token de la persona', async () => {
  const r = await enviar(conKick, { red: 'kick', texto: 'hola desde el chat abierto' });
  assert.equal(r.estado, 200);
  assert.equal(r.datos.ok, true);
  assert.deepEqual(r.datos.kick, { ok: true, motivo: '' });
  assert.equal(r.datos.twitch, undefined, 'no se manda a donde no se pidio');

  const pedido = pedidosKick.at(-1);
  const enviado = JSON.parse(pedido.cuerpo);
  /* "user" y no "bot": con "bot" el mensaje sale como la app y no como
     la persona, que es toda la gracia. */
  assert.equal(enviado.type, 'user');
  assert.equal(enviado.broadcaster_user_id, 4242, 'el canal es el del creador de ESTA sala');
  assert.equal(enviado.content, 'hola desde el chat abierto');
  assert.match(String(pedido.cabeceras.Authorization), /acceso-kick-esp_solokick/,
    'y va con el token de la persona, no con el del creador');
});

test('a Twitch: broadcaster_id del creador y sender_id del espectador', async () => {
  const r = await enviar(conTwitch, { red: 'twitch', texto: 'hola twitch' });
  assert.equal(r.estado, 200);
  assert.deepEqual(r.datos.twitch, { ok: true, motivo: '' });

  const enviado = JSON.parse(pedidosTwitch.at(-1).cuerpo);
  assert.equal(enviado.broadcaster_id, '5555', 'el canal del creador');
  assert.equal(enviado.sender_id, `twitch-${ID_TWITCH}`, 'y quien habla es el espectador');
  assert.equal(enviado.message, 'hola twitch');
  assert.match(String(pedidosTwitch.at(-1).cabeceras.Authorization), /acceso-twitch-esp_solotwitch/);
});

test('"ambas" es UN envio que sale en las dos', async () => {
  const r = await enviar(conLasDos, { red: 'ambas', texto: 'a las dos a la vez' });
  assert.equal(r.estado, 200);
  assert.equal(r.datos.ok, true);
  assert.deepEqual(r.datos.kick, { ok: true, motivo: '' });
  assert.deepEqual(r.datos.twitch, { ok: true, motivo: '' });
  assert.equal(pedidosKick.length, 1);
  assert.equal(pedidosTwitch.length, 1);
});

test('el mensaje NO se difunde por el bus: vuelve por el webhook y por EventSub', async () => {
  /* Difundirlo al enviarlo lo mostraria dos veces y, peor, lo mostraria
     aunque la plataforma lo hubiera retenido. */
  const eventos = [];
  const req = http.get({
    host: '127.0.0.1', port: servidor.address().port, path: `/eventos/${ANA}`,
  }, res => {
    res.setEncoding('utf8');
    res.on('data', t => eventos.push(t));
  });
  await new Promise(ok => setTimeout(ok, 100));
  const cuantos = eventos.join('').length;

  await enviar(conLasDos, { red: 'ambas', texto: 'no me dupliques' });
  await new Promise(ok => setTimeout(ok, 150));

  assert.equal(eventos.join('').slice(cuantos).includes('no me dupliques'), false);
  req.destroy();
});

/* =================== un 200 de Twitch no quiere decir que salio */

test('is_sent:false con drop_reason: se muestra el motivo, no un "enviado"', async () => {
  respuestaTwitch = {
    estado: 200,
    cuerpo: { data: [{ is_sent: false, drop_reason: { code: 'msg_rejected', message: 'el AutoMod lo retuvo' } }] },
    cabeceras: {},
  };

  const r = await enviar(conTwitch, { red: 'twitch', texto: 'algo que el automod odia' });
  assert.notEqual(r.estado, 200, 'un 200 de Twitch con is_sent:false NO es un envio');
  assert.equal(r.datos.ok, false);
  assert.equal(r.datos.twitch.ok, false);
  assert.equal(r.datos.twitch.motivo, 'el AutoMod lo retuvo', 'el motivo es el que dio Twitch, tal cual');
  assert.match(r.datos.error, /AutoMod/);
});

test('is_sent:false sin mensaje usa el code, y si no hay nada lo dice igual', async () => {
  respuestaTwitch = {
    estado: 200,
    cuerpo: { data: [{ is_sent: false, drop_reason: { code: 'followers_only_mode' } }] },
    cabeceras: {},
  };
  const conCodigo = await enviar(conTwitch, { red: 'twitch', texto: 'uno' });
  assert.equal(conCodigo.datos.twitch.motivo, 'followers_only_mode');

  espectadores.reiniciar();
  respuestaTwitch = { estado: 200, cuerpo: { data: [{ is_sent: false }] }, cabeceras: {} };
  const sinNada = await enviar(conTwitch, { red: 'twitch', texto: 'dos' });
  assert.match(sinNada.datos.twitch.motivo, /retuvo/, 'nunca se dice "enviado" por no tener motivo');
});

test('"ambas" con Twitch caido: sale en Kick y se dice exactamente que fallo', async () => {
  respuestaTwitch = { estado: 500, cuerpo: { error: 'boom' }, cabeceras: {} };

  const r = await enviar(conLasDos, { red: 'ambas', texto: 'una sale y la otra no' });
  assert.equal(r.estado, 200, 'salio en una: no se le puede pedir que lo escriba de nuevo');
  assert.equal(r.datos.ok, true);
  assert.equal(r.datos.kick.ok, true);
  assert.equal(r.datos.twitch.ok, false);
  assert.match(r.datos.twitch.motivo, /500/, 'y el motivo dice algo de lo que paso');
  assert.equal(pedidosKick.length, 1, 'el de Kick salio igual');
});

test('"ambas" con Kick caido: sale en Twitch y el motivo es el de Kick', async () => {
  respuestaKick = { estado: 500, cuerpo: { error: 'boom' }, cabeceras: {} };

  const r = await enviar(conLasDos, { red: 'ambas', texto: 'al reves' });
  assert.equal(r.estado, 200);
  assert.equal(r.datos.twitch.ok, true);
  assert.equal(r.datos.kick.ok, false);
  assert.ok(r.datos.kick.motivo, 'tiene que decir por que');
});

test('si fallan las dos, no hay ningun "enviado"', async () => {
  respuestaKick = { estado: 500, cuerpo: { error: 'boom' }, cabeceras: {} };
  respuestaTwitch = { estado: 500, cuerpo: { error: 'boom' }, cabeceras: {} };

  const r = await enviar(conLasDos, { red: 'ambas', texto: 'ninguna' });
  assert.equal(r.estado, 502);
  assert.equal(r.datos.ok, false);
  assert.equal(r.datos.kick.ok, false);
  assert.equal(r.datos.twitch.ok, false);
});

test('un 401 de Twitch desconecta SOLO Twitch: Kick sigue', async () => {
  const id = 'esp_quepierdetwitch';
  const cookie = await nuevoEspectador(id, ['kick', 'twitch']);
  respuestaTwitch = { estado: 401, cuerpo: { error: 'unauthorized' }, cabeceras: {} };

  const r = await enviar(cookie, { red: 'ambas', texto: 'chau twitch' });
  assert.equal(r.estado, 200, 'Kick salio');
  assert.deepEqual(r.datos.reconectar, ['twitch'], 'la pagina tiene que volver a ofrecer el boton');

  const v = await espectadores.leer(id);
  assert.deepEqual(espectadores.redesDe(v), ['kick'], 'el token de Twitch ya no esta');
  assert.equal(v.kick.accessToken, `acceso-kick-${id}`, 'y el de Kick no se toco');

  /* Y la sesion sigue en pie: con Kick todavia puede escribir. */
  espectadores.reiniciar();
  const otra = await enviar(cookie, { red: 'kick', texto: 'sigo aca' });
  assert.equal(otra.estado, 200);

  await espectadores.olvidar(id);
});

/* ========================================== los frenos */

test('el tope de texto frena antes de gastar un pedido', async () => {
  const vacio = await enviar(conLasDos, { red: 'ambas', texto: '   ' });
  assert.equal(vacio.estado, 400);

  espectadores.reiniciar();
  const largo = await enviar(conLasDos, { red: 'kick', texto: 'a'.repeat(501) });
  assert.equal(largo.estado, 400);
  assert.match(largo.datos.error, /tope/);

  espectadores.reiniciar();
  /* Cien familias de emojis: cien caracteres "como los ve una persona"
     (pasa el tope de 500) pero 2500 bytes (no pasa el de 2048). Es el
     caso que hace falta que los dos topes existan por separado. */
  const pesado = await enviar(conLasDos, { red: 'kick', texto: '👨‍👩‍👧‍👦'.repeat(100) });
  assert.equal(pesado.estado, 400);
  assert.match(pesado.datos.error, /bytes/, 'el tope de 2048 bytes tambien vale');

  assert.equal(pedidosKick.length, 0, 'no se le tiene que pedir nada a nadie');
  assert.equal(pedidosTwitch.length, 0);
});

test('lo que se mide es lo que viaja: los espacios no esquivan el tope de Twitch', async () => {
  /*
   * EL BUG QUE ESTO ATAJA: el tope se medía sobre el texto recortado y
   * después se mandaba el CRUDO. 400 letras y 400 espacios pasaban
   * como 400 caracteres y llegaban a Twitch como 800, que es más que
   * su tope. Kick zafaba de casualidad, porque `kick.js` vuelve a
   * recortar adentro: o sea que con "las dos" el mismo mensaje salía
   * distinto en cada red.
   */
  const texto = 'a'.repeat(400) + ' '.repeat(400);

  const r = await enviar(conLasDos, { red: 'ambas', texto });
  assert.equal(r.estado, 200, `contestó ${r.estado}`);

  const enKick = JSON.parse(pedidosKick.at(-1).cuerpo).content;
  const enTwitch = JSON.parse(pedidosTwitch.at(-1).cuerpo).message;
  assert.equal(enTwitch.length, 400, `a Twitch le llegaron ${enTwitch.length} caracteres`);
  assert.equal(enKick, enTwitch, 'y tiene que ser el mismo texto en las dos redes');
});

test('si el permiso no sirve en NINGUNA red, es 401 y no 502', async () => {
  /*
   * EL BUG QUE ESTO ATAJA: con todas las redes caídas y sin 429, la
   * ruta contestaba 502 aunque el motivo fuera "tu permiso venció". Un
   * 502 le dice a la persona "el servidor está roto, probá más tarde"
   * cuando lo que tiene que hacer es volver a conectar la cuenta; la
   * rama de la página para el 401 no se ejecutaba nunca por acá.
   */
  const id = 'esp_sinpermisoenninguna';
  const cookie = await nuevoEspectador(id, ['kick', 'twitch']);
  respuestaKick = { estado: 401, cuerpo: { error: 'unauthorized' }, cabeceras: {} };
  respuestaTwitch = { estado: 401, cuerpo: { error: 'unauthorized' }, cabeceras: {} };

  const r = await enviar(cookie, { red: 'ambas', texto: 'no tengo permiso en ninguna' });
  assert.equal(r.estado, 401, `contestó ${r.estado}`);
  assert.equal(r.datos.ok, false);
  assert.deepEqual(r.datos.reconectar, ['kick', 'twitch']);

  /* Y sin ninguna red no queda documento: un espectador sin redes no
     es nadie. */
  assert.equal(await espectadores.leer(id), null);
});

test('con una red caduca y la otra rota sigue siendo 502, no 401', async () => {
  /* El otro lado del test de arriba, y el que fija el `every`. Un 401
     global diría "reconectá tu cuenta" sobre una red que no tiene nada
     que reconectar: la de Twitch falló porque su servidor se cayó. El
     detalle por red y `reconectar` ya dicen exactamente qué pasó con
     cada una. */
  const id = 'esp_unacaducayunarota';
  const cookie = await nuevoEspectador(id, ['kick', 'twitch']);
  respuestaKick = { estado: 401, cuerpo: { error: 'unauthorized' }, cabeceras: {} };
  respuestaTwitch = { estado: 500, cuerpo: { error: 'boom' }, cabeceras: {} };

  const r = await enviar(cookie, { red: 'ambas', texto: 'una vencida y una rota' });
  assert.equal(r.estado, 502, `contestó ${r.estado}`);
  assert.deepEqual(r.datos.reconectar, ['kick'], 'y se dice cuál hay que reconectar');
  assert.deepEqual(espectadores.redesDe(await espectadores.leer(id)), ['twitch'],
    'la que falló por el 401 se desconecta igual');

  await espectadores.olvidar(id);
});

test('quien conectó sólo Twitch no escribe en la Sala, y no pierde nada', async () => {
  /* La Sala es de Kick. Alguien que conectó sólo Twitch (se puede,
     desde /chat/<slug>) tiene cuenta de espectador y acá no le sirve:
     se le dice que entre con Kick, y su sesión y su Twitch quedan
     intactos, que es lo que sigue usando en el chat abierto. */
  await creadores.ponerSalaAbierta(ANA, true);
  try {
    espectadores.reiniciar();
    pedidosKick = [];
    const r = await pedir(`/api/sala/${ANA}/chat`, {
      metodo: 'POST', cookie: conTwitch, cuerpo: { texto: 'yo sólo tengo Twitch' },
    });
    assert.equal(r.estado, 401, `contestó ${r.estado}`);
    assert.match(r.datos.error, /Kick/);
    /* Y se le dice lo que pasa, no "tu permiso venció": nunca tuvo un
       permiso de Kick que se pudiera vencer, y mandarlo a reconectar
       algo que no conectó es mandarlo a buscar un problema que no
       tiene. */
    assert.doesNotMatch(r.datos.error, /venci/i);
    assert.equal(pedidosKick.length, 0, 'no se le pide nada a Kick sin token de Kick');
    assert.equal(r.cabeceras.get('set-cookie') ?? '', '', 'y la sesión no se toca');

    /* Tampoco se le gasta el freno de dos segundos por un mensaje que
       no tenía ninguna chance: el de acá abajo vuelve a contestar 401 y
       no un 429. */
    const otra = await pedir(`/api/sala/${ANA}/chat`, {
      metodo: 'POST', cookie: conTwitch, cuerpo: { texto: 'insisto' },
    });
    assert.equal(otra.estado, 401, `contestó ${otra.estado}`);

    const v = await espectadores.leer(ID_TWITCH);
    assert.deepEqual(espectadores.redesDe(v), ['twitch'], 'su Twitch sigue donde estaba');
  } finally {
    await creadores.ponerSalaAbierta(ANA, false);
  }
});

test('un 403 de la plataforma no le desconecta la cuenta a nadie', async () => {
  /*
   * 401 y 403 se trataban igual, y son cosas distintas: 401 es "este
   * token no sirve más" y 403 es "vos no podés escribir en este canal"
   * (baneado, sólo seguidores, sólo suscriptores). Desconectar la red
   * por un baneo le hace perder el permiso a alguien que lo tenía
   * perfecto, y lo manda a reconectar para volver a chocar contra lo
   * mismo.
   */
  const id = 'esp_baneadaenelcanal';
  const cookie = await nuevoEspectador(id, ['twitch']);
  respuestaTwitch = { estado: 403, cuerpo: { error: 'forbidden' }, cabeceras: {} };

  const r = await enviar(cookie, { red: 'twitch', texto: 'estoy baneada' });
  assert.equal(r.estado, 403, `contestó ${r.estado}: un baneo del canal no es un 502 ni un 401`);
  assert.deepEqual(r.datos.reconectar, [], 'no hay nada que reconectar');

  const v = await espectadores.leer(id);
  assert.deepEqual(espectadores.redesDe(v), ['twitch'], 'su Twitch tiene que seguir conectado');
  await espectadores.olvidar(id);
});

test('uno cada dos segundos por persona, y "ambas" cuenta como UNO', async () => {
  const primero = await enviar(conLasDos, { red: 'ambas', texto: 'uno' });
  assert.equal(primero.estado, 200);

  const segundo = await enviar(conLasDos, { red: 'kick', texto: 'dos' });
  assert.equal(segundo.estado, 429, 'el freno es por persona, no por red');
  assert.ok(segundo.datos.esperar >= 1);
  assert.ok(segundo.cabeceras.get('retry-after'), 'tiene que decir cuanto esperar');

  /* Y no se frenan entre si. */
  const otra = await enviar(conKick, { red: 'kick', texto: 'yo recien llego' });
  assert.equal(otra.estado, 200);
});

test('un 429 de Kick frena el CANAL, y no calla a Twitch', async () => {
  respuestaKick = { estado: 429, cuerpo: { error: 'too many' }, cabeceras: { 'Retry-After': '7' } };

  const frenado = await enviar(conKick, { red: 'kick', texto: 'primero' });
  assert.equal(frenado.estado, 429);
  assert.equal(frenado.datos.esperar, 7, 'respeta el Retry-After de Kick');

  pedidosKick = [];
  const otro = await enviar(conLasDos, { red: 'kick', texto: 'segundo' });
  assert.equal(otro.estado, 429, 'el 429 es del canal: frena a todos');
  assert.equal(pedidosKick.length, 0, 'ni se le pide a Kick mientras dura');

  /* Pero Twitch no tiene nada que ver: su limite es por cuenta. */
  espectadores.reiniciar();
  const porTwitch = await enviar(conTwitch, { red: 'twitch', texto: 'yo por Twitch' });
  assert.equal(porTwitch.estado, 200, 'callar Twitch porque Kick frena seria callar a todos sin motivo');
});

/* ====================== bloqueados por el creador (Fase 5.4) */

const panelChat = cuerpo => pedir('/api/panel/chat', { metodo: 'POST', cookie: sesionAna, cuerpo });

test('a quien el creador bloqueó le rebota el mensaje, y la otra red le sigue andando', async () => {
  const r = await panelChat({ bloquear: { red: 'kick', id: `kick-${ID_LAS_DOS}`, nombre: 'la bloqueada' } });
  assert.equal(r.estado, 200);
  assert.deepEqual(r.datos.chatAbierto.bloqueados.map(b => b.red), ['kick']);

  const kick = await enviar(conLasDos, { red: 'kick', texto: 'hola' });
  assert.equal(kick.estado, 403);
  assert.match(kick.datos.error, /te bloqueó/);
  assert.deepEqual(kick.datos.bloqueado, ['kick']);
  assert.equal(pedidosKick.length, 0, 'se corta antes de gastar un pedido');

  /* El bloqueo es por red y por id: su Twitch no tiene nada que ver. */
  espectadores.reiniciar();
  const twitch = await enviar(conLasDos, { red: 'twitch', texto: 'hola' });
  assert.equal(twitch.estado, 200);

  /* Y con "ambas" rebota entero, porque una de las dos está bloqueada. */
  espectadores.reiniciar();
  const ambas = await enviar(conLasDos, { red: 'ambas', texto: 'hola' });
  assert.equal(ambas.estado, 403);

  /* A otra persona no le pasa nada. */
  espectadores.reiniciar();
  const otra = await enviar(conKick, { red: 'kick', texto: 'yo no soy' });
  assert.equal(otra.estado, 200);

  await panelChat({ desbloquear: { red: 'kick', id: `kick-${ID_LAS_DOS}` } });
});

test('el desbloqueo vale al instante', async () => {
  await panelChat({ bloquear: { red: 'kick', id: `kick-${ID_KICK}` } });
  assert.equal((await enviar(conKick, { red: 'kick', texto: 'uno' })).estado, 403);

  const r = await panelChat({ desbloquear: { red: 'kick', id: `kick-${ID_KICK}` } });
  assert.deepEqual(r.datos.chatAbierto.bloqueados, []);

  espectadores.reiniciar();
  assert.equal((await enviar(conKick, { red: 'kick', texto: 'dos' })).estado, 200);
});

test('a quien está bloqueado se le dice, en vez de esconderle la caja sin explicación', async () => {
  await panelChat({ bloquear: { red: 'twitch', id: `twitch-${ID_TWITCH}`, nombre: 'ese' } });

  const { datos } = await pedir(`/api/chat/${ANA}/yo`, { cookie: conTwitch });
  assert.deepEqual(datos.bloqueado, ['twitch']);
  assert.deepEqual(datos.puedeEscribir, [], 'bloqueado no puede escribir, aunque tenga la red conectada');
  assert.deepEqual(Object.keys(datos.conectadas), ['twitch'], 'lo suyo sigue siendo suyo');

  await panelChat({ desbloquear: { red: 'twitch', id: `twitch-${ID_TWITCH}` } });
});

test('la lista de bloqueados no sale por ninguna ruta pública', async () => {
  /* Es del creador: quién está bloqueado no se cuenta en la página que
     lee cualquiera, y menos en el bus. */
  await panelChat({ bloquear: { red: 'kick', id: 'un-id-secreto', nombre: 'alguien' } });

  const abierto = await pedir(`/api/chat/${ANA}/abierto`);
  assert.deepEqual(Object.keys(abierto.datos).sort(), ['abierto', 'redes']);

  const yo = await pedir(`/api/chat/${ANA}/yo`, { cookie: conKick });
  assert.equal(JSON.stringify(yo.datos).includes('un-id-secreto'), false);
  assert.equal(JSON.stringify(yo.datos).includes('alguien'), false);

  await panelChat({ desbloquear: { red: 'kick', id: 'un-id-secreto' } });
});

test('bloquear pide una red y un id de verdad', async () => {
  for (const bloquear of [{ red: 'kick' }, { id: '123' }, { red: 'mastodon', id: '1' },
                          { red: 'kick', id: 'con espacios' }, { red: 'kick', id: 'a'.repeat(65) }]) {
    const r = await panelChat({ bloquear });
    assert.equal(r.estado, 400, JSON.stringify(bloquear));
  }
});

test('bloquear dos veces a la misma persona no la duplica', async () => {
  await panelChat({ bloquear: { red: 'kick', id: '4242', nombre: 'dos veces' } });
  const r = await panelChat({ bloquear: { red: 'kick', id: '4242', nombre: 'dos veces' } });
  assert.equal(r.datos.chatAbierto.bloqueados.length, 1);
  await panelChat({ desbloquear: { red: 'kick', id: '4242' } });
});

test('tres bloqueos seguidos por el panel quedan los tres', async () => {
  /*
   * ESTE TEST NO PRUEBA LA CARRERA, y decirlo es la mitad del test.
   *
   * Se escribió como "dos bloqueos al mismo tiempo no se pisan", pero
   * lo comprobado no era eso: sacándole la cola a `creadores.js` seguía
   * pasando. Tres POST disparados juntos no llegan juntos a la parte
   * que importa —cada pedido pasa antes por la cookie y por el cuerpo,
   * y eso alcanza para que lleguen de a uno—, así que lo que cubre de
   * verdad es la RUTA: que tres bloqueos seguidos por el panel queden
   * los tres, y que desbloquearlos los saque.
   *
   * La carrera se prueba donde sí ocurre, llamando al módulo derecho:
   * `pruebas/creadores.test.js`, "tres bloqueos al mismo tiempo no se
   * pisan" (sin cola falla 20 de 20).
   */
  await Promise.all([
    panelChat({ bloquear: { red: 'kick', id: '10001', nombre: 'uno' } }),
    panelChat({ bloquear: { red: 'kick', id: '10002', nombre: 'dos' } }),
    panelChat({ bloquear: { red: 'twitch', id: '10003', nombre: 'tres' } }),
  ]);

  const r = await panelChat({});
  const ids = r.datos.chatAbierto.bloqueados.map(b => b.id).sort();
  assert.deepEqual(ids, ['10001', '10002', '10003'], 'los tres tienen que haber quedado');

  for (const [red, id] of [['kick', '10001'], ['kick', '10002'], ['twitch', '10003']]) {
    await panelChat({ desbloquear: { red, id } });
  }
  assert.deepEqual((await panelChat({})).datos.chatAbierto.bloqueados, []);
});

test('el bloqueo es de una sala, no del servicio', async () => {
  /* Cada sala es un inquilino: que Ana bloquee a alguien no lo bloquea
     en el chat de Beto. */
  await almacen.poner('creadores', 'beto2', { slug: 'beto2', plan: 'amigo', creado: Date.now() });
  await creadores.ponerChatAbierto('beto2', { activo: true, redes: ['kick'] });
  await vinculos.guardar('beto2', 'kick', {
    usuarioId: '8888', nombre: 'Beto', login: 'beto2', slug: 'beto2',
    accessToken: 'a', refreshToken: 'r', venceEn: Date.now() + 3600_000, scopes: 'chat:write',
  });
  await panelChat({ bloquear: { red: 'kick', id: `kick-${ID_KICK}` } });

  assert.equal((await enviar(conKick, { red: 'kick', texto: 'en la de ana' })).estado, 403);
  espectadores.reiniciar();
  const enBeto = await pedir('/api/chat/beto2/enviar', {
    metodo: 'POST', cookie: conKick, cuerpo: { red: 'kick', texto: 'en la de beto' },
  });
  assert.equal(enBeto.estado, 200, 'el bloqueo de Ana no puede callarlo en la sala de Beto');

  /*
   * PERO SÍ VALE POR LA OTRA PUERTA DE LA MISMA SALA.
   *
   * `/api/sala/<ana>/chat` y `/api/chat/<ana>/enviar` caen en el MISMO
   * canal de Kick, y hasta el 2026-09-22 sólo la segunda miraba la
   * lista de bloqueados: al bloqueado le alcanzaba con abrir la página
   * de la Sala para seguir escribiendo con su nombre. El bloqueo es
   * sobre una persona, no sobre una pantalla.
   */
  await creadores.ponerSalaAbierta(ANA, true);
  try {
    espectadores.reiniciar();
    pedidosKick = [];
    const enLaSala = await pedir(`/api/sala/${ANA}/chat`, {
      metodo: 'POST', cookie: conKick, cuerpo: { texto: 'por la puerta de la Sala' },
    });
    assert.equal(enLaSala.estado, 403, `contestó ${enLaSala.estado}: el bloqueo tiene una sola llave`);
    assert.equal(pedidosKick.length, 0, 'no se le puede haber pedido nada a Kick');

    /* Control negativo: desbloqueada, esa misma puerta escribe. Sin
       esto, un 403 clavado pasaría igual. */
    await panelChat({ desbloquear: { red: 'kick', id: `kick-${ID_KICK}` } });
    espectadores.reiniciar();
    const despues = await pedir(`/api/sala/${ANA}/chat`, {
      metodo: 'POST', cookie: conKick, cuerpo: { texto: 'ya no estoy bloqueada' },
    });
    assert.equal(despues.estado, 200, `contestó ${despues.estado}`);
  } finally {
    await creadores.ponerSalaAbierta(ANA, false);
  }

  await panelChat({ desbloquear: { red: 'kick', id: `kick-${ID_KICK}` } });
});

test('el chat cerrado no calla la Sala: son dos productos', async () => {
  /*
   * LA DECISIÓN, ESCRITA. La Sala no mira `chatAbierto.activo`, y es a
   * propósito: ese interruptor decide si se ofrece la página pública
   * del Chat Global, y la Sala la abre `salaAbierta`. Atarlos sería un
   * apagón silencioso, porque el chat abierto NACE CERRADO: toda Sala
   * prendida se quedaría sin caja de escribir sin que su dueño tocara
   * nada.
   */
  await abrirChat(false);
  await creadores.ponerSalaAbierta(ANA, true);
  try {
    espectadores.reiniciar();
    const porElChat = await enviar(conKick, { red: 'kick', texto: 'por el chat cerrado' });
    assert.equal(porElChat.estado, 403, 'el chat abierto sí está cerrado');

    espectadores.reiniciar();
    pedidosKick = [];
    const porLaSala = await pedir(`/api/sala/${ANA}/chat`, {
      metodo: 'POST', cookie: conKick, cuerpo: { texto: 'por la Sala, que está abierta' },
    });
    assert.equal(porLaSala.estado, 200, `contestó ${porLaSala.estado}`);
    assert.equal(pedidosKick.length, 1);
  } finally {
    await creadores.ponerSalaAbierta(ANA, false);
  }
});

/* ================================================== CSRF */

test('un POST con Origin ajeno no escribe nada', async () => {
  const r = await enviar(conKick, { red: 'kick', texto: 'desde otro sitio' }, { origen: 'https://sitio-ajeno.example' });
  assert.equal(r.estado, 403);
  assert.equal(pedidosKick.length, 0, 'ni siquiera se intento');
});

test('un POST sin Origin tampoco pasa', async () => {
  /* Los navegadores lo mandan en todo POST de fetch: exigirlo no rompe
     a nadie que use la pagina, y aceptarlo sin Origin deja la puerta
     abierta a cualquier cliente que simplemente no lo mande. */
  const r = await enviar(conKick, { red: 'kick', texto: 'sin origen' }, { origen: '' });
  assert.equal(r.estado, 403);
});

test('el segundo dominio nuestro (el proxy de Cloudflare) si escribe', async () => {
  const r = await enviar(conKick, { red: 'kick', texto: 'desde el dominio lindo' },
    { origen: 'https://multichat.example' });
  assert.equal(r.estado, 200, 'el sitio se sirve desde dos dominios y los dos son nuestros');
});

test('salir tambien exige Origin propio', async () => {
  const r = await pedir('/api/espectador/salir', {
    metodo: 'POST', cookie: conKick, origen: 'https://sitio-ajeno.example',
  });
  assert.equal(r.estado, 403);
  assert.ok(await espectadores.leer(ID_KICK), 'no le pudo borrar la cuenta a nadie');
});

/* =================================================== salir */

test('salir borra los tokens de LAS DOS redes, no solo la cookie', async () => {
  const id = 'esp_quesevaentero';
  const cookie = await nuevoEspectador(id, ['kick', 'twitch']);
  assert.deepEqual(espectadores.redesDe(await espectadores.leer(id)), ['kick', 'twitch']);

  const r = await pedir('/api/espectador/salir', { metodo: 'POST', cookie });
  assert.equal(r.estado, 200);
  assert.match(r.cabeceras.get('set-cookie'), /Max-Age=0/, 'y la cookie se va');

  assert.equal(await espectadores.leer(id), null);
  assert.equal(await almacen.obtener('espectadores', id), null, 'no queda ni el documento');

  /* La sesion tampoco vale mas. */
  const despues = await pedir(`/api/chat/${ANA}/yo`, { cookie });
  assert.equal(despues.datos.entrado, false);
});

test('salir sin sesion no explota y contesta lo mismo', async () => {
  const r = await pedir('/api/espectador/salir', { metodo: 'POST' });
  assert.equal(r.estado, 200);
});

/* ================================ el espectador del modelo viejo */

test('un espectador de antes de Twitch sigue escribiendo con su cookie de siempre', async () => {
  /* Hasta la 5.1 el espectador ERA una cuenta de Kick y su documento
     vivia en `tokens`, bajo `espectador:<user_id>`. Esa cookie esta en
     navegadores ahora mismo: tiene que seguir andando, y de paso
     quedar migrada al modelo nuevo. */
  await almacen.poner('tokens', 'espectador:777', {
    tipo: 'espectador',
    usuarioId: '777',
    nombre: 'la de siempre',
    acceso: cifrado.cifrar('acceso-viejo-de-kick'),
    refresco: cifrado.cifrar('refresco-viejo'),
    venceEn: Date.now() + 3600_000,
    scopes: 'user:read chat:write',
    entro: Date.now() - 86_400_000,
  });
  const cookieVieja = cookieEspectador(await sesion.crear({ tipo: 'espectador', usuario: '777', nombre: 'la de siempre' }));

  const yo = await pedir(`/api/chat/${ANA}/yo`, { cookie: cookieVieja });
  assert.equal(yo.datos.entrado, true);
  assert.deepEqual(yo.datos.puedeEscribir, ['kick']);

  const r = await enviar(cookieVieja, { red: 'kick', texto: 'sigo siendo yo' });
  assert.equal(r.estado, 200);
  assert.match(String(pedidosKick.at(-1).cabeceras.Authorization), /acceso-viejo-de-kick/,
    'con su token de siempre, sin volver a entrar');

  assert.equal(await almacen.obtener('tokens', 'espectador:777'), null, 'y quedo migrado');
  assert.ok(await almacen.obtener('espectadores', '777'));

  await espectadores.olvidar('777');
});

/* ======================================= el OAuth del espectador */

test('/oauth/twitch/entrar?rol=espectador pide solo user:write:chat', async () => {
  const r = await pedir('/oauth/twitch/entrar?rol=espectador&destino=%2Fchat%2Fana', { seguir: 'manual' });
  assert.equal(r.estado, 302);
  const destino = new URL(r.cabeceras.get('location'));
  assert.equal(destino.origin + destino.pathname, 'https://id.twitch.tv/oauth2/authorize');
  assert.equal(destino.searchParams.get('scope'), 'user:write:chat',
    'leer entra con el token del creador: al espectador no se le pide user:read:chat');
  assert.equal(destino.searchParams.get('redirect_uri'), 'https://sala.example/oauth/twitch/volver',
    'el mismo redirect de siempre: no hay que tocar la app de Twitch');
});

test('el rol sale del state del servidor y no de la query del callback', async () => {
  /* Si el rol viniera en la query, cualquiera podria empezar un login
     de creador y terminarlo como espectador (o al reves). */
  const entrar = await pedir('/oauth/twitch/entrar?destino=%2Fpanel', { seguir: 'manual' });
  const estado = new URL(entrar.cabeceras.get('location')).searchParams.get('state');

  const volver = await pedir(`/oauth/twitch/volver?code=abc&state=${estado}&rol=espectador`, { seguir: 'manual' });
  assert.equal(volver.estado, 200, 'sin sesion de creador, el camino de creador no pasa');
  assert.match(volver.texto, /Primero entra con Kick/i);
});

test('el espectador conecta Twitch sin tener ninguna sesion previa', async () => {
  const entrar = await pedir('/oauth/twitch/entrar?rol=espectador&destino=%2Fchat%2Fana', { seguir: 'manual' });
  const estado = new URL(entrar.cabeceras.get('location')).searchParams.get('state');

  const volver = await pedir(`/oauth/twitch/volver?code=abc&state=${estado}`, { seguir: 'manual' });
  assert.equal(volver.estado, 302);
  assert.equal(volver.cabeceras.get('location'), '/chat/ana', 'vuelve al chat donde estaba');

  const galleta = volver.cabeceras.get('set-cookie');
  assert.match(galleta, new RegExp(`^${sesion.COOKIES.espectador}=`), 'y sale con su cuenta de espectador');
  assert.match(galleta, /HttpOnly/);
  assert.match(galleta, /SameSite=Lax/);

  const cookie = galleta.split(';')[0];
  const yo = await pedir(`/api/chat/${ANA}/yo`, { cookie });
  assert.equal(yo.datos.entrado, true);
  assert.deepEqual(yo.datos.puedeEscribir, ['twitch']);
  assert.equal(yo.datos.conectadas.twitch.nombre, 'UnaEspectadora');

  /* La cuenta es GLOBAL: la misma cookie vale en cualquier sala. */
  await almacen.poner('creadores', 'beto', { slug: 'beto', plan: 'amigo', creado: Date.now() });
  await creadores.ponerChatAbierto('beto', { activo: true, redes: ['twitch'] });
  const enOtra = await pedir('/api/chat/beto/yo', { cookie });
  assert.deepEqual(enOtra.datos.puedeEscribir, ['twitch'], 'una sesion sirve para todas las salas');

  await pedir('/api/espectador/salir', { metodo: 'POST', cookie });
});

test('conectar la segunda red no saca de la primera ni cambia de cuenta', async () => {
  /* Quien tiene Kick y conecta Twitch tiene que terminar con UNA
     cuenta y las dos redes, no con dos cuentas. */
  const id = 'esp_quesuma';
  const cookie = await nuevoEspectador(id, ['kick']);

  const entrar = await pedir('/oauth/twitch/entrar?rol=espectador&destino=%2Fchat%2Fana', { seguir: 'manual' });
  const estado = new URL(entrar.cabeceras.get('location')).searchParams.get('state');
  const volver = await pedir(`/oauth/twitch/volver?code=abc&state=${estado}`, { cookie, seguir: 'manual' });

  assert.equal(volver.estado, 302);
  assert.equal(volver.cabeceras.get('set-cookie'), null, 'la cookie no se toca: es la misma persona');

  const v = await espectadores.leer(id);
  assert.deepEqual(espectadores.redesDe(v), ['kick', 'twitch']);
  assert.equal(v.kick.accessToken, `acceso-kick-${id}`, 'Kick sigue tal cual');
  assert.equal(v.twitch.usuarioId, '9090');

  const yo = await pedir(`/api/chat/${ANA}/yo`, { cookie });
  assert.deepEqual(yo.datos.puedeEscribir, ['kick', 'twitch'], 'y ahora si aparece "las dos"');

  await espectadores.olvidar(id);
});
