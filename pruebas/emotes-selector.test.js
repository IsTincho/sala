/* ============================================================
   El selector de emotes de la caja de escribir: la parte del
   servidor.

   EL PROBLEMA QUE ESTO CUIDA, en una linea: el mismo emote no se
   escribe igual en las dos redes, y con `red: "ambas"` el mensaje
   sale a las dos a la vez. Un `[emote:5747892:MEGALUL]` es un dibujo
   en Kick y son esos corchetes literales en Twitch, delante de toda
   la comunidad del otro lado.

   Lo que se prueba es lo que se rompe callado:

     - la marca se traduce a `[emote:id:nombre]` en Kick y a nombre
       pelado en Twitch, y con "las dos" CADA RED RECIBE LO SUYO. Se
       mira lo que le llego a cada API, no lo que contesto la ruta;
     - un emote que no existe en una red no se manda mal: nunca sale
       un `[emote:` hacia Twitch, ni escrito por el selector ni
       escrito a mano;
     - EL TOPE DE LARGO SE MIDE DESPUES DE TRADUCIR, contra el texto
       de CADA red. Hay un mensaje que Kick rechaza y Twitch acepta, y
       tiene que pasar en una y rebotar en la otra;
     - un mensaje que era solo un emote de Kick no llega vacio a
       Twitch: se frena antes y se dice por que;
     - el catalogo: 7TV con su marca, los de Kick que el chat vio
       pasar con la suya, y que una sala no ve los de otra;
     - un creador SIN 7TV no genera un solo pedido a 7TV;
     - la ruta: 404 la sala que no existe, nada con el chat cerrado, y
       leer sin login.

   NO SALE UN BYTE A INTERNET: `fetch` esta falseado para Kick, para
   Twitch y para 7TV, y deja pasar los pedidos de este test al
   servidor de prueba.
   ============================================================ */

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';

/* Las variables van ANTES de importar: los modulos las leen al
   cargarse. Ninguna es un secreto: son de mentira. */
const DATOS = path.join(os.tmpdir(), 'sala-pruebas-emotes-selector');
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
const creadores = await import('../servidor/creadores.js');
const emotes = await import('../servidor/emotes.js');
const envio = await import('../servidor/envio.js');
const espectadores = await import('../servidor/espectadores.js');
const mensajes = await import('../servidor/mensajes.js');
const sesion = await import('../servidor/sesion.js');
const vinculos = await import('../servidor/vinculos.js');

const ANA = 'ana';
const BETO = 'beto';
const NUESTRO = 'https://sala.example';

/* ----------------------------------------- las APIs de mentira */

const fetchDeVerdad = globalThis.fetch;

let respuestaKick = { estado: 200, cuerpo: { data: { is_sent: true, message_id: 'k-1' } } };
let respuestaTwitch = { estado: 200, cuerpo: { data: [{ is_sent: true, message_id: 't-1' }] } };
let pedidosKick = [];
let pedidosTwitch = [];
let pedidos7TV = [];

/* slug de 7TV (`<red>/<id>`) -> lista de emotes. Sin entrada, 404. */
let sets7TV = new Map();

const responder = (estado, cuerpo) => new Response(JSON.stringify(cuerpo), {
  status: estado,
  headers: { 'Content-Type': 'application/json' },
});

/** Un emote de 7TV con la forma que devuelve su API. */
function emote7TV(nombre) {
  const id = ('01' + crypto.createHash('sha1').update(nombre).digest('hex').toUpperCase()).slice(0, 26);
  return {
    id,
    name: nombre,
    data: {
      id,
      name: nombre,
      host: {
        url: `//cdn.7tv.app/emote/${id}`,
        files: [{ name: '1x.webp', size: 4096 }, { name: '2x.webp', size: 8192 }],
      },
    },
  };
}

globalThis.fetch = async (entrada, opciones) => {
  const url = String(typeof entrada === 'string' ? entrada : entrada?.url ?? '');

  if (url.startsWith('https://api.kick.com')) {
    pedidosKick.push({ url, cuerpo: opciones?.body });
    return responder(respuestaKick.estado, respuestaKick.cuerpo);
  }
  if (url.startsWith('https://api.twitch.tv/helix/chat/messages')) {
    pedidosTwitch.push({ url, cuerpo: opciones?.body });
    return responder(respuestaTwitch.estado, respuestaTwitch.cuerpo);
  }
  if (url.startsWith('https://7tv.io/')) {
    pedidos7TV.push(url);
    if (url.includes('/emote-sets/global')) return responder(200, { id: 'globales', emotes: [emote7TV('Clap7TV')] });
    const m = /\/users\/(\w+)\/(\w+)/.exec(url);
    const lista = m ? sets7TV.get(`${m[1]}/${m[2]}`) : null;
    if (!lista) return responder(404, { error: 'no existe' });
    return responder(200, { id: 'u1', emote_set: { id: 's1', emotes: lista.map(emote7TV) } });
  }
  return fetchDeVerdad(entrada, opciones);
};

/* La identidad de cada creador en 7TV, sin tocar el almacen. Sin
   entrada, el creador no tiene esa red vinculada. */
let identidades = new Map();
emotes.fijarIdentidad(async (slug, red) => {
  const i = identidades.get(slug);
  return i?.[red] ? { red, sala: slug, usuarioId: i[red] } : null;
});

/** Deja el set de un creador cargado en el 7TV de mentira. */
function darle7TV(slug, red, id, lista) {
  const i = identidades.get(slug) ?? {};
  i[red] = id;
  identidades.set(slug, i);
  sets7TV.set(`${red}/${id}`, lista);
}

/* --------------------------------------------------------- ayudas */

let servidor;
let raiz;
let conLasDos = '';
const ID_LAS_DOS = 'esp_lasdos';

async function pedir(ruta, { metodo = 'GET', cookie = '', cuerpo, origen = NUESTRO } = {}) {
  const h = {};
  if (cookie) h.Cookie = cookie;
  if (origen) h.Origin = origen;
  if (cuerpo !== undefined) h['Content-Type'] = 'application/json';
  const r = await fetch(raiz + ruta, {
    method: metodo,
    headers: h,
    body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
  });
  const texto = await r.text();
  let datos = null;
  try { datos = JSON.parse(texto); } catch { /* no era json */ }
  return { estado: r.status, datos, texto };
}

const enviar = (cuerpo) =>
  pedir(`/api/chat/${ANA}/enviar`, { metodo: 'POST', cookie: conLasDos, cuerpo });

/** Lo que le llego al chat de Kick en el ultimo envio. */
const textoQueRecibioKick = () => JSON.parse(pedidosKick.at(-1).cuerpo).content;
/** Lo que le llego al chat de Twitch en el ultimo envio. */
const textoQueRecibioTwitch = () => JSON.parse(pedidosTwitch.at(-1).cuerpo).message;

/** Un mensaje de Kick del formato unico, con el `content` que se pida. */
const deKick = (contenido, id = 'k1') => mensajes.deKick({
  message_id: id,
  content: contenido,
  created_at: new Date().toISOString(),
  sender: { username: 'Fulana', user_id: '909', identity: { badges: [] } },
});

/** El catalogo de una sala, con las tablas de 7TV ya bajadas. */
async function catalogoConTabla(slug, redes) {
  emotes.catalogo(slug, redes);
  await emotes.reposo();
  return emotes.catalogo(slug, redes);
}

const porNombre = (catalogo, nombre) => catalogo.find(e => e.nombre === nombre);
/* Los globales de 7TV estan SIEMPRE, en cualquier canal: para mirar
   la lista de nativos de Kick hay que quedarse con los suyos. */
const soloDeKick = catalogo => catalogo.filter(e => e.fuente === 'kick');

/* ------------------------------------------------------- arranque */

test.before(async () => {
  await fsp.rm(DATOS, { recursive: true, force: true }).catch(() => {});

  for (const slug of [ANA, BETO]) {
    await almacen.poner('creadores', slug, { slug, plan: 'pendiente', usuarioId: '', creado: Date.now() });
    await vinculos.guardar(slug, 'kick', {
      usuarioId: slug === ANA ? '4242' : '4343', nombre: slug, login: slug, slug,
      accessToken: `acceso-${slug}-kick`, refreshToken: `refresco-${slug}-kick`,
      venceEn: Date.now() + 3600_000, scopes: 'user:read chat:write',
    });
    await vinculos.guardar(slug, 'twitch', {
      usuarioId: slug === ANA ? '5555' : '5656', nombre: slug, login: slug, slug,
      accessToken: `acceso-${slug}-twitch`, refreshToken: `refresco-${slug}-twitch`,
      venceEn: Date.now() + 3600_000, scopes: 'user:read:chat user:write:chat',
    });
  }

  await espectadores.conectar(ID_LAS_DOS, 'kick', {
    usuarioId: 'kick-esp', nombre: 'esp en kick',
    accessToken: 'acceso-kick-esp', refreshToken: 'refresco-kick-esp',
    venceEn: Date.now() + 3600_000, scopes: 'user:read chat:write',
  });
  await espectadores.conectar(ID_LAS_DOS, 'twitch', {
    usuarioId: 'twitch-esp', nombre: 'esp en twitch', login: 'esp',
    accessToken: 'acceso-twitch-esp', refreshToken: 'refresco-twitch-esp',
    venceEn: Date.now() + 3600_000, scopes: 'user:write:chat',
  });
  conLasDos = `${sesion.COOKIES.espectador}=` +
    await sesion.crear({ tipo: 'espectador', usuario: ID_LAS_DOS, nombre: 'esp' });

  servidor = crearServidor();
  await new Promise(ok => servidor.listen(0, '127.0.0.1', ok));
  raiz = `http://127.0.0.1:${servidor.address().port}`;
});

test.beforeEach(async () => {
  espectadores.reiniciar();
  emotes.olvidarTodo();
  pedidosKick = [];
  pedidosTwitch = [];
  pedidos7TV = [];
  sets7TV = new Map();
  identidades = new Map();
  respuestaKick = { estado: 200, cuerpo: { data: { is_sent: true, message_id: 'k-1' } } };
  respuestaTwitch = { estado: 200, cuerpo: { data: [{ is_sent: true, message_id: 't-1' }] } };
  await creadores.ponerChatAbierto(ANA, { activo: true, redes: ['kick', 'twitch'] });
});

test.after(async () => {
  globalThis.fetch = fetchDeVerdad;
  canales.cerrarTodo();
  await new Promise(ok => servidor.close(ok));
  await fsp.rm(DATOS, { recursive: true, force: true }).catch(() => {});
});

/* ============================================ la traduccion sola */

const MARCA = '[emote:5747892:collectiblesMEGALUL]';

test('la marca de un emote de Kick viaja entera a Kick y pelada a Twitch', () => {
  assert.equal(envio.comoViajaA(`hola ${MARCA} chau`, 'kick'), `hola ${MARCA} chau`,
    'Kick recibe su propio markup, que es lo que lo dibuja');
  assert.equal(envio.comoViajaA(`hola ${MARCA} chau`, 'twitch'), 'hola collectiblesMEGALUL chau',
    'Twitch recibe la palabra: el markup de Kick ahi no significa nada');
});

test('un emote de 7TV es el nombre pelado y no lo toca nadie', () => {
  /* En las dos redes viaja igual, que es lo que ya pasa hoy cuando
     alguien lo escribe a mano. No hay nada que traducir. */
  for (const red of ['kick', 'twitch']) {
    assert.equal(envio.comoViajaA('mira este CHAD', red), 'mira este CHAD');
  }
});

test('varios emotes de Kick en el mismo mensaje se traducen todos', () => {
  const texto = `${MARCA} y [emote:1:CHAD] y [emote:22:KEKW]`;
  assert.equal(envio.comoViajaA(texto, 'twitch'), 'collectiblesMEGALUL y CHAD y KEKW');
  assert.equal(envio.comoViajaA(texto, 'kick'), texto);
});

test('un emote sin nombre no deja corchetes sueltos en Twitch', () => {
  assert.equal(envio.comoViajaA('hola [emote:123:] chau', 'twitch'), 'hola  chau');
  assert.equal(envio.comoViajaA('[emote:123:]', 'twitch'), '',
    'y si era lo unico, no queda nada: lo ataja porQueNoSePuedeMandar');
});

test('una marca adentro de otra no deja salir markup de Kick vivo', () => {
  /* EL BUG QUE ESTO EVITA, y no es teorico: `String.replace` no
     vuelve a mirar lo que acaba de escribir. Con una pasada sola,
     `[emote:1:[emote:2:AB]]` salia como `[emote:2:AB]` —markup de
     Kick VALIDO— camino a Twitch, que es exactamente lo que todo
     esto viene a impedir. Lo puede escribir cualquiera a mano. */
  assert.equal(envio.comoViajaA('[emote:1:[emote:2:AB]]', 'twitch'), 'AB');
  assert.equal(envio.comoViajaA(`hola [emote:9:${MARCA}] chau`, 'twitch'), 'hola collectiblesMEGALUL chau');

  /* Y con mas vueltas encima tampoco. */
  const hondo = '[emote:1:[emote:2:[emote:3:[emote:4:FONDO]]]]';
  assert.equal(envio.comoViajaA(hondo, 'twitch'), 'FONDO');
  assert.doesNotMatch(envio.comoViajaA(hondo, 'twitch'), /\[emote:/);
});

test('lo que no es una marca bien formada se deja como esta', () => {
  /* Nada de regex golosas: un corchete suelto es texto de alguien. */
  for (const texto of ['[emote:abc:CHAD]', '[emote:1:CHAD', 'emote:1:CHAD]', '[1:CHAD]']) {
    assert.equal(envio.comoViajaA(texto, 'twitch'), texto, texto);
  }
});

test('la traduccion es la MISMA funcion que se mide y que se manda', () => {
  /* Es pura: no mira tablas, ni caches, ni el reloj. Por eso medir y
     mandar por separado no puede dar distinto, que es exactamente el
     bug que hubo con `comoViaja`. */
  const texto = `  ${MARCA} hola  `;
  const unaVez = envio.comoViajaA(texto, 'twitch');
  const otraVez = envio.comoViajaA(texto, 'twitch');
  assert.equal(unaVez, otraVez);
  assert.equal(unaVez, 'collectiblesMEGALUL hola', 'y viene recortado, como todo lo que viaja');
});

/* ================================= el tope, despues de traducir */

/* Diez emotes cortos: 130 caracteres para Kick y 30 para Twitch. */
const DIEZ_EMOTES = Array.from({ length: 10 }, () => '[emote:1:AB]').join(' ');
const CASI_LARGO = 'a'.repeat(400) + ' ' + DIEZ_EMOTES;

test('el tope se mide contra el texto de CADA red, no contra uno solo', () => {
  /* EL CASO QUE LO DEMUESTRA: el mismo mensaje pasa de 500 en Kick
     (que recibe el markup entero) y no llega a 500 en Twitch (que
     recibe las palabras). Con un solo texto medido para las dos, una
     de las dos mediciones seria mentira. */
  assert.ok([...envio.comoViajaA(CASI_LARGO, 'kick')].length > 500, 'para Kick se pasa');
  assert.ok([...envio.comoViajaA(CASI_LARGO, 'twitch')].length <= 500, 'para Twitch entra');

  assert.match(envio.porQueNoSePuedeMandar(CASI_LARGO, ['kick']), /tope es 500/);
  assert.equal(envio.porQueNoSePuedeMandar(CASI_LARGO, ['twitch']), '',
    'a Twitch sola se puede mandar: es mas corto de lo que parece');
  assert.match(envio.porQueNoSePuedeMandar(CASI_LARGO, ['kick', 'twitch']), /tope es 500/,
    'y con las dos rebota entero: se miran todas ANTES de mandar a ninguna');
});

test('un mensaje que era solo un emote de Kick no llega vacio a Twitch', () => {
  const solo = '[emote:123:]';
  assert.equal(envio.porQueNoSePuedeMandar(solo, ['kick']), '', 'en Kick es un emote perfecto');
  assert.match(envio.porQueNoSePuedeMandar(solo, ['twitch']), /solo un emote de Kick/,
    'y se dice POR QUE, que mirando la caja llena "esta vacio" seria un misterio');
});

test('el mensaje vacio sigue siendo vacio', () => {
  for (const texto of ['', '   ', null, undefined]) {
    assert.equal(envio.porQueNoSePuedeMandar(texto, ['kick', 'twitch']), 'el mensaje esta vacio');
  }
});

/* ======================== el envio de punta a punta, por HTTP */

test('con "ambas", cada red recibe lo suyo', async () => {
  const r = await enviar({ red: 'ambas', texto: `mira ${MARCA}` });

  assert.equal(r.estado, 200);
  assert.equal(r.datos.kick.ok, true);
  assert.equal(r.datos.twitch.ok, true);

  /* LO QUE IMPORTA NO ES LA RESPUESTA, ES LO QUE LE LLEGO A CADA API. */
  assert.equal(textoQueRecibioKick(), `mira ${MARCA}`);
  assert.equal(textoQueRecibioTwitch(), 'mira collectiblesMEGALUL');
});

test('a Twitch no le llega un [emote: ni por el selector ni escrito a mano', async () => {
  await enviar({ red: 'twitch', texto: `probando ${MARCA} a mano` });
  assert.equal(textoQueRecibioTwitch(), 'probando collectiblesMEGALUL a mano');
  assert.doesNotMatch(textoQueRecibioTwitch(), /\[emote:/,
    'nunca, aunque lo haya escrito una persona y no el selector');
  assert.equal(pedidosKick.length, 0, 'y a Kick no se le mando nada');
});

test('a Kick le llega el markup entero y sale dibujado', async () => {
  await enviar({ red: 'kick', texto: MARCA });
  assert.equal(textoQueRecibioKick(), MARCA);
  assert.equal(pedidosTwitch.length, 0);
});

test('el tope se respeta DESPUES de traducir, tambien por HTTP', async () => {
  /* A Twitch sola entra... */
  const aTwitch = await enviar({ red: 'twitch', texto: CASI_LARGO });
  assert.equal(aTwitch.estado, 200);
  assert.ok([...textoQueRecibioTwitch()].length <= 500);

  /* ...y a las dos rebota SIN GASTAR UN PEDIDO en ninguna, porque
     Kick lo rechazaria y ahi ya no se puede deshacer. */
  pedidosKick = [];
  pedidosTwitch = [];
  const aLasDos = await enviar({ red: 'ambas', texto: CASI_LARGO });
  assert.equal(aLasDos.estado, 400);
  assert.match(aLasDos.datos.error, /tope es 500/);
  assert.equal(pedidosKick.length, 0);
  assert.equal(pedidosTwitch.length, 0, 'ni siquiera a la red donde entraba');
});

test('un mensaje que en Twitch queda vacio rebota antes de mandarse a Kick', async () => {
  const r = await enviar({ red: 'ambas', texto: '[emote:123:]' });
  assert.equal(r.estado, 400);
  assert.match(r.datos.error, /solo un emote de Kick/);
  assert.equal(pedidosKick.length, 0, 'no sale en una y falla en la otra: no sale en ninguna');
});

/* ================================================== el catalogo */

test('el catalogo trae los de 7TV con su marca y saliendo en las dos redes', async () => {
  darle7TV(ANA, 'kick', '4242', ['CHAD', 'KEKW']);
  const catalogo = await catalogoConTabla(ANA, ['kick', 'twitch']);

  const chad = porNombre(catalogo, 'CHAD');
  assert.ok(chad, 'esta');
  assert.equal(chad.fuente, '7tv');
  assert.equal(chad.marca, 'CHAD', 'un emote de 7TV es su nombre pelado: no hay markup');
  assert.deepEqual(chad.redes, ['kick', 'twitch'], 'y sale igual en las dos');
  assert.match(chad.url, /^https:\/\/cdn\.7tv\.app\//);

  assert.ok(porNombre(catalogo, 'Clap7TV'), 'los globales de 7TV tambien entran');
});

test('los emotes de Kick salen de lo que el chat vio pasar, con su markup', async () => {
  /* No hay de donde pedir la lista: la doc de Kick no tiene un solo
     endpoint de emotes (verificado el 2026-09-23) y el unico que los
     enumera no esta documentado, o sea prohibido por sus terminos.
     Asi que la lista la arma el propio chat. */
  assert.deepEqual(soloDeKick(await catalogoConTabla(ANA, ['kick'])), [], 'arranca vacia, y lo dice');

  emotes.resolver(deKick(`hola ${MARCA} chau`), ANA);

  const catalogo = await catalogoConTabla(ANA, ['kick']);
  const suyo = porNombre(catalogo, 'collectiblesMEGALUL');
  assert.ok(suyo, 'lo vio pasar y lo anoto');
  assert.equal(suyo.fuente, 'kick');
  assert.equal(suyo.marca, MARCA, 'la marca es el markup de Kick, id incluido');
  assert.deepEqual(suyo.redes, ['kick'], 'y solo sale en Kick');
  assert.equal(suyo.url, 'https://files.kick.com/emotes/5747892/fullsize');
});

test('un emote de Kick que nunca paso por el chat no esta', async () => {
  emotes.resolver(deKick('[emote:1:CHAD]'), ANA);
  const catalogo = await catalogoConTabla(ANA, ['kick']);
  assert.ok(porNombre(catalogo, 'CHAD'));
  assert.equal(porNombre(catalogo, 'KEKW'), undefined,
    'es una lista viva, no el set del canal: eso se dice en pantalla');
});

test('pidiendo solo Twitch no aparece ningun emote nativo de Kick', async () => {
  darle7TV(ANA, 'twitch', '5555', ['CHAD']);
  emotes.resolver(deKick(MARCA), ANA);

  const catalogo = await catalogoConTabla(ANA, ['twitch']);
  assert.equal(porNombre(catalogo, 'collectiblesMEGALUL'), undefined,
    'ofrecer un emote que ahi no sirve es empujar al error');
  assert.ok(porNombre(catalogo, 'CHAD'), 'los de 7TV si');
});

test('una sala no ve los emotes de Kick de otra', async () => {
  /* La peor clase de bug de un servicio de muchos creadores: no rompe
     nada, muestra el emote de otra comunidad. Es el mismo motivo por
     el que la cache de 7TV es por (slug, red). */
  emotes.resolver(deKick('[emote:1:DeAna]'), ANA);
  emotes.resolver(deKick('[emote:2:DeBeto]'), BETO);

  const deAna = await catalogoConTabla(ANA, ['kick']);
  const deBeto = await catalogoConTabla(BETO, ['kick']);

  assert.ok(porNombre(deAna, 'DeAna'));
  assert.equal(porNombre(deAna, 'DeBeto'), undefined);
  assert.ok(porNombre(deBeto, 'DeBeto'));
  assert.equal(porNombre(deBeto, 'DeAna'), undefined);
});

test('un emote con basura adentro no entra en la lista', async () => {
  /* `resolver()` es una entrada exportada y lo que se guarde acá se
     le sirve a todo el mundo por una ruta pública. No se confía. */
  const conBasura = (emote) => emotes.resolver({
    tipo: 'chat', red: 'kick', id: 'k9', usuario: 'Fulana', texto: 'AB',
    emotes: [{ inicio: 0, fin: 2, fuente: 'kick', ...emote }],
  }, ANA);

  conBasura({ id: '1', url: 'javascript:alert(1)' });
  conBasura({ id: '2', url: 'https://evil.example/x' });
  conBasura({ id: '3', url: 'http://files.kick.com/emotes/3/fullsize' });
  conBasura({ id: 'no-son-digitos', url: 'https://files.kick.com/emotes/4/fullsize' });
  conBasura({ id: '5', url: 'https://files.kick.com/emotes/5/fullsize', inicio: NaN, fin: 2 });
  conBasura({ id: '6', url: 'https://files.kick.com/emotes/6/fullsize', inicio: 5, fin: 2 });

  assert.deepEqual(emotes.emotesDeKickVistos(ANA), [],
    'ni una url ajena, ni un http, ni un id que no sea un número, ni un rango dado vuelta');

  /* Y el bueno sí entra, para que la prueba no pase por estar rota. */
  conBasura({ id: '7', url: 'https://files.kick.com/emotes/7/fullsize' });
  assert.equal(emotes.emotesDeKickVistos(ANA).length, 1);
});

test('un nombre con corchetes no entra: rompería la marca que se arma después', async () => {
  emotes.resolver({
    tipo: 'chat', red: 'kick', id: 'k8', usuario: 'Fulana', texto: '[malo]',
    emotes: [{ id: '1', inicio: 0, fin: 6, fuente: 'kick', url: 'https://files.kick.com/emotes/1/fullsize' }],
  }, ANA);
  assert.deepEqual(emotes.emotesDeKickVistos(ANA), []);
});

test('un mensaje de Twitch no ensucia la lista de emotes de Kick', async () => {
  const mensaje = {
    tipo: 'chat', red: 'twitch', id: 't1', usuario: 'Fulana', texto: 'Kappa',
    emotes: [{ id: '25', inicio: 0, fin: 5, url: 'https://static-cdn.jtvnw.net/x', fuente: 'twitch' }],
  };
  emotes.resolver(mensaje, ANA);
  assert.deepEqual(soloDeKick(await catalogoConTabla(ANA, ['kick'])), [],
    'la lista viva es de Kick: un emote de Twitch no tiene markup que ofrecer');
});

test('la lista de vistos no crece para siempre y desaloja al mas viejo', async () => {
  for (let i = 0; i < emotes.TOPE_EMOTES_VISTOS + 5; i++) {
    emotes.resolver(deKick(`[emote:${i}:emote${i}]`, `k${i}`), ANA);
  }
  const vistos = emotes.emotesDeKickVistos(ANA);
  assert.equal(vistos.length, emotes.TOPE_EMOTES_VISTOS);
  assert.equal(vistos.some(e => e.nombre === 'emote0'), false, 'el primero se fue');
  assert.equal(vistos[0].nombre, `emote${emotes.TOPE_EMOTES_VISTOS + 4}`, 'y el ultimo esta primero');
});

test('un emote que se vio hace mas de 12 horas caduca', () => {
  /* Los terminos de dev.kick.com dejan guardar su contenido "for only
     a twenty-four hour time period": doce horas entra con margen y no
     depende de que el proceso se reinicie seguido. */
  emotes.resolver(deKick('[emote:1:Viejo]'), ANA);
  assert.equal(emotes.emotesDeKickVistos(ANA).length, 1);

  const ahoraDeVerdad = Date.now;
  try {
    Date.now = () => ahoraDeVerdad() + emotes.CADUCA_VISTOS + 1000;
    assert.deepEqual(emotes.emotesDeKickVistos(ANA), []);
  } finally {
    Date.now = ahoraDeVerdad;
  }
});

test('el catalogo de un creador SIN 7TV no genera un solo pedido a su set', async () => {
  /* Es el caso de la MAYORIA de los creadores. Un pedido por consulta
     seria el mismo agujero que ya cuida `emotes.test.js` para los
     mensajes, pero por una puerta nueva. */
  emotes.resolver(deKick(MARCA), ANA);
  for (let i = 0; i < 10; i++) {
    emotes.catalogo(ANA, ['kick', 'twitch']);
    await emotes.reposo();
  }

  const delCreador = pedidos7TV.filter(u => u.includes('/users/'));
  assert.deepEqual(delCreador, [], 'no hay a quien preguntarle: no se le pregunta a nadie');

  /* Y lo que si se puede ofrecer, se ofrece igual. */
  assert.ok(porNombre(emotes.catalogo(ANA, ['kick']), 'collectiblesMEGALUL'));
});

test('el set de 7TV de un creador se baja una sola vez aunque se abra el selector diez veces', async () => {
  darle7TV(ANA, 'kick', '4242', ['CHAD']);
  for (let i = 0; i < 10; i++) {
    emotes.catalogo(ANA, ['kick']);
    await emotes.reposo();
  }
  const suyos = pedidos7TV.filter(u => u.includes('/users/kick/4242'));
  assert.equal(suyos.length, 1, 'la cache es la misma que la de los mensajes');
});

/* ====================================================== la ruta */

test('la ruta contesta el catalogo y leer no pide login', async () => {
  darle7TV(ANA, 'kick', '4242', ['CHAD']);
  emotes.resolver(deKick(MARCA), ANA);
  await emotes.reposo();

  /* SIN COOKIE: leer el chat nunca pidio login y esto es parte de
     leerlo. Escribir sigue pidiendo cuenta. */
  const r = await pedir(`/api/chat/${ANA}/emotes`);
  assert.equal(r.estado, 200);
  assert.equal(r.datos.abierto, true);
  assert.deepEqual(r.datos.redes, ['kick', 'twitch']);

  const nombres = r.datos.emotes.map(e => e.nombre);
  assert.ok(nombres.includes('collectiblesMEGALUL'));
  assert.ok(nombres.includes('CHAD'));

  const suyo = r.datos.emotes.find(e => e.nombre === 'collectiblesMEGALUL');
  assert.equal(suyo.marca, MARCA, 'la marca la arma el servidor: la pagina nunca escribe markup');
});

test('?red=twitch pide menos, nunca mas', async () => {
  emotes.resolver(deKick(MARCA), ANA);
  const r = await pedir(`/api/chat/${ANA}/emotes?red=twitch`);
  assert.deepEqual(r.datos.redes, ['twitch']);
  assert.equal(r.datos.emotes.some(e => e.fuente === 'kick'), false);

  /* Y en una sala que solo abrio Kick, pedir Twitch no destapa nada. */
  await creadores.ponerChatAbierto(ANA, { activo: true, redes: ['kick'] });
  const soloKick = await pedir(`/api/chat/${ANA}/emotes?red=twitch`);
  assert.deepEqual(soloKick.datos.redes, []);
  assert.deepEqual(soloKick.datos.emotes, []);
});

test('con el chat cerrado no se cuenta ni un emote', async () => {
  darle7TV(ANA, 'kick', '4242', ['CHAD']);
  emotes.resolver(deKick(MARCA), ANA);
  await emotes.reposo();
  await creadores.ponerChatAbierto(ANA, { activo: false });

  const r = await pedir(`/api/chat/${ANA}/emotes`);
  assert.equal(r.estado, 200);
  assert.deepEqual(r.datos, { abierto: false, redes: [], emotes: [] },
    'mismo criterio que /abierto y /yo: de un chat cerrado no se cuenta nada');
});

test('una sala que no existe da 404, igual que sus hermanas', async () => {
  const r = await pedir('/api/chat/no-existe-esta-sala/emotes');
  assert.equal(r.estado, 404);
});
