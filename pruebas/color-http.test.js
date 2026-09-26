/* ============================================================
   Las dos puertas del color propio, de punta a punta:

     POST /api/espectador/color   la persona elige el suyo
     POST /api/panel/color        el creador se lo saca a alguien

   El servidor se levanta de verdad en un puerto libre. Lo que importa
   acá es lo mismo de siempre con las rutas que escriben: quién puede,
   desde dónde, y qué pasa con lo que llega mal escrito.

   El color es una entrada de terceros que termina en un `style` del
   navegador de TODOS los que estén mirando ese chat. Por eso la
   validación se prueba en el borde HTTP además de en el módulo: que
   `colores.limpiar` sea estricta no sirve de nada si la ruta guarda lo
   que le llega sin llamarla.
   ============================================================ */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const DATOS = await fsp.mkdtemp(path.join(os.tmpdir(), 'sala-color-http-'));
process.env.SALA_DATOS = DATOS;
process.env.MODO = 'local';
process.env.KICK_SLUG = 'istincho';
process.env.URL_BASE = 'https://sala.example';
process.env.CLAVE_CIFRADO = crypto.randomBytes(32).toString('base64');
process.env.EMOTES_7TV = '0';
process.env.EMOTES_TWITCH = '0';

const { crearServidor } = await import('../servidor/index.js');
const almacen = await import('../servidor/almacen.js');
const canales = await import('../servidor/canales.js');
const colores = await import('../servidor/colores.js');
const creadores = await import('../servidor/creadores.js');
const espectadores = await import('../servidor/espectadores.js');
const sesion = await import('../servidor/sesion.js');

const ANA = 'ana';
const NUESTRO = 'https://sala.example';
const ID_ESPECTADOR = 'esp_delcolor';

let servidor;
let raiz;
let cookieEspectador = '';
let cookieAna = '';
let cookieOtro = '';

async function pedir(ruta, { metodo = 'GET', cookie = '', cuerpo, origen = NUESTRO } = {}) {
  const h = {};
  if (cookie) h.Cookie = cookie;
  if (origen) h.Origin = origen;
  if (cuerpo !== undefined) h['Content-Type'] = 'application/json';
  const r = await fetch(raiz + ruta, {
    method: metodo,
    headers: h,
    body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
    signal: AbortSignal.timeout(5000),
  });
  const texto = await r.text();
  let datos = null;
  try { datos = JSON.parse(texto); } catch { /* no era json */ }
  return { estado: r.status, datos };
}

const ponerColor = (cookie, color, extra = {}) =>
  pedir('/api/espectador/color', { metodo: 'POST', cookie, cuerpo: { color }, ...extra });

const resetear = (cookie, cuerpo, extra = {}) =>
  pedir('/api/panel/color', { metodo: 'POST', cookie, cuerpo, ...extra });

const mio = (cookie) => pedir(`/api/chat/${ANA}/yo`, { cookie });

test.before(async () => {
  await almacen.poner('creadores', ANA, { slug: ANA, plan: 'amigo', usuarioId: '77', creado: Date.now() });
  await almacen.poner('creadores', 'beto', { slug: 'beto', plan: 'amigo', usuarioId: '78', creado: Date.now() });
  await creadores.ponerChatAbierto(ANA, { activo: true, redes: ['kick', 'twitch'] });

  await espectadores.conectar(ID_ESPECTADOR, 'kick', {
    usuarioId: '4242',
    nombre: 'Fulana',
    accessToken: 'acceso-de-prueba',
    refreshToken: 'refresco-de-prueba',
    venceEn: Date.now() + 3600_000,
    scopes: 'chat:write',
  });

  servidor = crearServidor();
  await new Promise(ok => servidor.listen(0, '127.0.0.1', ok));
  raiz = `http://127.0.0.1:${servidor.address().port}`;

  cookieEspectador = `${sesion.COOKIES.espectador}=${await sesion.crear({
    tipo: 'espectador', usuario: ID_ESPECTADOR, nombre: 'Fulana',
  })}`;
  cookieAna = `${sesion.COOKIES.dueno}=${await sesion.crear({
    tipo: 'dueno', usuario: '77', nombre: 'Ana', slug: ANA,
  })}`;
  cookieOtro = `${sesion.COOKIES.dueno}=${await sesion.crear({
    tipo: 'dueno', usuario: '78', nombre: 'Beto', slug: 'beto',
  })}`;
});

test.after(async () => {
  canales.cerrarTodo();
  await new Promise(ok => servidor.close(ok));
  await fsp.rm(DATOS, { recursive: true, force: true });
});

/* ------------------------------------------- elegir el propio */

test('sin sesión no se elige ningún color', async () => {
  const r = await ponerColor('', '#7a5cff');
  assert.equal(r.estado, 401);
});

test('un POST con Origin ajeno no escribe nada', async () => {
  const r = await ponerColor(cookieEspectador, '#123456', { origen: 'https://otro.example' });
  assert.equal(r.estado, 403);
  const yo = await mio(cookieEspectador);
  assert.equal(yo.datos.color, '');
});

test('el color queda guardado y /yo lo cuenta', async () => {
  const r = await ponerColor(cookieEspectador, '#7A5CFF');
  assert.equal(r.estado, 200);
  assert.equal(r.datos.color, '#7a5cff');

  const yo = await mio(cookieEspectador);
  assert.equal(yo.datos.color, '#7a5cff');
  /* Y su propio id en esa red, que es lo que la página usa para
     repintar sus mensajes. El de nadie más. */
  assert.equal(yo.datos.conectadas.kick.usuarioId, '4242');
});

test('el color vale en la sala de otro creador: es de la persona', async () => {
  const enBeto = await pedir('/api/chat/beto/yo', { cookie: cookieEspectador });
  assert.equal(enBeto.datos.color, '#7a5cff');
});

test('un valor que no es un color se rechaza y no pisa el que había', async () => {
  for (const malo of ['rojo', '#abc', 'rgb(1,2,3)', '#aabbcc;x', 12, null]) {
    const r = await ponerColor(cookieEspectador, malo);
    assert.equal(r.estado, 400, `debería rechazar ${JSON.stringify(malo)}`);
  }
  const yo = await mio(cookieEspectador);
  assert.equal(yo.datos.color, '#7a5cff');
});

test('el vacío lo saca y vuelve el color de la plataforma', async () => {
  const r = await ponerColor(cookieEspectador, '');
  assert.equal(r.estado, 200);
  assert.equal(r.datos.color, '');
  const yo = await mio(cookieEspectador);
  assert.equal(yo.datos.color, '');
});

/* ------------------------------------------- el reseteo del creador */

test('el creador le saca el color a alguien de su chat', async () => {
  await ponerColor(cookieEspectador, '#7a5cff');
  assert.equal(colores.deUsuario('kick', '4242'), '#7a5cff');

  const r = await resetear(cookieAna, { red: 'kick', id: '4242' });

  assert.equal(r.estado, 200);
  assert.equal(r.datos.reseteados, 1);
  assert.equal(colores.deUsuario('kick', '4242'), '',
    'desde el próximo mensaje vuelve al color de su plataforma');
  const yo = await mio(cookieEspectador);
  assert.equal(yo.datos.color, '', 'y la persona lo ve: puede elegir otro');
});

test('resetear no bloquea ni desconecta a nadie', async () => {
  await ponerColor(cookieEspectador, '#7a5cff');
  await resetear(cookieAna, { red: 'kick', id: '4242' });

  const yo = await mio(cookieEspectador);
  assert.deepEqual(yo.datos.puedeEscribir, ['kick'], 'sigue pudiendo escribir igual');
  assert.deepEqual(yo.datos.bloqueado, []);
});

test('sin sesión de creador no se le saca el color a nadie', async () => {
  await ponerColor(cookieEspectador, '#7a5cff');

  const sinCookie = await resetear('', { red: 'kick', id: '4242' });
  assert.equal(sinCookie.estado, 401);
  /* La cookie de espectador no sirve para esto: es otra puerta. */
  const conLaDeMirar = await resetear(cookieEspectador, { red: 'kick', id: '4242' });
  assert.equal(conLaDeMirar.estado, 401);

  assert.equal(colores.deUsuario('kick', '4242'), '#7a5cff');
});

test('un pedido de reseteo mal escrito se rechaza', async () => {
  await ponerColor(cookieEspectador, '#7a5cff');

  for (const cuerpo of [{}, { red: 'kick' }, { id: '4242' }, { red: 'discord', id: '4242' },
    { red: 'kick', id: 'un id con espacios' }, { red: 'kick', id: 'x'.repeat(65) }]) {
    const r = await resetear(cookieAna, cuerpo);
    assert.equal(r.estado, 400, `debería rechazar ${JSON.stringify(cuerpo)}`);
  }
  assert.equal(colores.deUsuario('kick', '4242'), '#7a5cff');
});

test('el reseteo exige Origin propio, como las rutas que tocan a un tercero', async () => {
  /* El resto de /api/panel se apoya sólo en la cookie SameSite=Lax:
     son ajustes de la sala propia. Ésta le borra un dato a otra
     persona, y en todas las salas, así que lleva la segunda traba. */
  await ponerColor(cookieEspectador, '#7a5cff');

  const r = await resetear(cookieAna, { red: 'kick', id: '4242' }, { origen: 'https://otro.example' });

  assert.equal(r.estado, 403);
  assert.equal(colores.deUsuario('kick', '4242'), '#7a5cff', 'no tocó nada');
});

test('otro creador también puede sacárselo, y eso es a propósito', async () => {
  /* El color es de la persona y vale en todas las salas: el reseteo
     también. Está anotado en el README como el precio de que el color
     sea uno solo. Si algún día molesta, la salida es una lista por
     sala en el documento del creador, como `bloqueados`. */
  await ponerColor(cookieEspectador, '#7a5cff');
  const r = await resetear(cookieOtro, { red: 'kick', id: '4242' });
  assert.equal(r.estado, 200);
  assert.equal(colores.deUsuario('kick', '4242'), '');
});
