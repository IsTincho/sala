/* ============================================================
   Emotes de 7TV en el multichat.

   Lo que se prueba acá es lo que se rompe callado:

     - 7TV DISTINGUE MAYÚSCULAS y resuelve por PALABRA ENTERA. Si esto
       se afloja, el chat se llena de emotes donde la gente escribió
       otra cosa.
     - Los índices son PUNTOS DE CÓDIGO. Un emoji fuera del plano
       básico antes del emote corre todos los que vengan después, y es
       el bug que nadie encuentra mirando el código.
     - El choque con un emote nativo. Kick reemplaza `[emote:1:CHAD]`
       por la palabra `CHAD`, así que esa palabra queda en el texto
       lista para resolverse DOS veces.
     - La caché es por (slug, red). Dos creadores en la misma red no
       comparten set, y el fallo de uno no puede ensuciar al otro: sería
       el emote de otra comunidad pintado en la pantalla de ésta.
     - Un creador SIN 7TV —la mayoría— no puede generar un pedido por
       mensaje.

   Nada sale a internet: `fetch` está falseado y la identidad de cada
   creador se fija con `emotes.fijarIdentidad()`, igual que
   `chat.fijarConexiones()`.
   ============================================================ */

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

/* Las variables van ANTES de importar: los módulos las leen al
   cargarse. Ninguna es un secreto. */
process.env.SALA_DATOS = path.join(os.tmpdir(), 'sala-pruebas-emotes');
process.env.KICK_SLUG = 'istincho';
process.env.CLAVE_CIFRADO = crypto.randomBytes(32).toString('base64');
/* El plazo de una bajada entera, cortito: hay una prueba que cuelga
   una bajada a propósito y tiene que poder esperar a que venza. El
   7TV de mentira contesta en microsegundos, así que a ninguna otra le
   queda corto. */
process.env.EMOTES_PLAZO_MS = '200';

const emotes = await import('../servidor/emotes.js');
const mensajes = await import('../servidor/mensajes.js');
const canales = await import('../servidor/canales.js');
const chat = await import('../servidor/chat.js');

/* ------------------------------------------------- el 7TV de mentira */

const fetchDeVerdad = globalThis.fetch;

/* `sets` es lo que 7TV "tiene": clave `<red>/<id>` -> lista de emotes,
   o el string 'no-existe' para que conteste 404, o 'roto' para un 500. */
let sets = new Map();
/* Sets que NO vienen incrustados en el usuario y hay que pedir aparte:
   id de set -> lista de emotes. */
let setsAparte = new Map();
let pedidos = [];
/* Cuanto tarda el 7TV de mentira en contestar. Por defecto cero: casi
   todas las pruebas quieren la respuesta ya. Lo usa la prueba del
   plazo con typo, que necesita una bajada que tarde MAS que un
   milisegundo para poder ver la diferencia. */
let demora = 0;

/** Un emote de 7TV como lo devuelve la API, con los pesos que se le pidan.
 *
 * El id sale de un hash del nombre CON sus mayúsculas: 7TV le da un id
 * distinto a "CHAD" y a "chad", y si el fixture se los diera iguales,
 * la prueba de mayúsculas pasaría aunque el módulo las aplastara. */
function emote(nombre, { kb1x = 8, kb2x = 20, sabor = '' } = {}) {
  const id = ('01' + crypto.createHash('sha1').update(nombre + sabor).digest('hex').toUpperCase()).slice(0, 26);
  return {
    id,
    name: nombre,
    data: {
      id,
      name: nombre,
      animated: kb2x > 100,
      host: {
        url: `//cdn.7tv.app/emote/${id}`,
        files: [
          { name: '1x.webp', size: Math.round(kb1x * 1024) },
          { name: '2x.webp', size: Math.round(kb2x * 1024) },
          { name: '4x.webp', size: Math.round(kb2x * 4 * 1024) },
        ],
      },
    },
  };
}

const url1x = (nombre, opts) => `https://cdn.7tv.app/emote/${emote(nombre, opts).id}/1x.webp`;
const url2x = (nombre, opts) => `https://cdn.7tv.app/emote/${emote(nombre, opts).id}/2x.webp`;

globalThis.fetch = async (recurso) => {
  const url = String(recurso);
  pedidos.push(url);
  if (demora) await new Promise(ok => setTimeout(ok, demora));
  const responder = (estado, datos) => new Response(JSON.stringify(datos), {
    status: estado,
    headers: { 'Content-Type': 'application/json' },
  });

  if (url.endsWith('/emote-sets/global')) {
    const g = sets.get('global');
    if (!g) return responder(404, { error: 'not found' });
    return responder(200, { id: 'global', emotes: g });
  }

  const s = url.match(/\/v3\/emote-sets\/(.+)$/);
  if (s) {
    const aparte = setsAparte.get(decodeURIComponent(s[1]));
    if (!aparte) return responder(404, { error: 'set not found' });
    return responder(200, { id: s[1], emotes: aparte });
  }

  const m = url.match(/\/v3\/users\/(kick|twitch)\/(.+)$/);
  if (!m) return responder(404, { error: 'ruta desconocida' });
  const guardado = sets.get(`${m[1]}/${decodeURIComponent(m[2])}`);
  if (!guardado || guardado === 'no-existe') {
    return responder(404, { status: 'Not Found', error_code: 12000, error: 'user not found' });
  }
  if (guardado === 'roto') return responder(500, { error: '7tv esta caido' });
  /* Un objeto se devuelve tal cual: así se puede armar una respuesta
     SIN el set incrustado y ejercitar la cascada de respaldo. */
  if (!Array.isArray(guardado)) return responder(200, { id: 'u1', ...guardado });
  /* La forma real, la que se observó contra el 7TV de verdad: el set
     viene incrustado en el usuario. */
  return responder(200, { id: 'u1', emote_set: { id: 's1', emotes: guardado } });
};

/* ------------------------------------------------------ la identidad */

/* slug -> { kick, twitch }. Sin entrada = creador sin vínculo. */
let identidades = new Map();
emotes.fijarIdentidad(async (slug, red) => {
  const i = identidades.get(slug);
  return i?.[red] ? { red, sala: slug, usuarioId: i[red] } : null;
});

/* ----------------------------------------------------------- ayudas */

function arrancarDeCero() {
  emotes.olvidarTodo();
  sets = new Map();
  setsAparte = new Map();
  identidades = new Map();
  pedidos = [];
  demora = 0;
}

/** Deja el set de un creador cargado en el 7TV de mentira. */
function darle(slug, red, id, lista) {
  const i = identidades.get(slug) ?? {};
  i[red] = id;
  identidades.set(slug, i);
  sets.set(`${red}/${id}`, lista);
}

/**
 * Resuelve un mensaje con la tabla YA bajada.
 *
 * La primera pasada es la que agenda la bajada y sale sin emotes de
 * 7TV: eso es a propósito y se prueba aparte. Acá interesa lo que ve
 * el segundo mensaje en adelante, que es el caso normal.
 */
async function resolverConTabla(mensaje, slug) {
  emotes.resolver(mensaje, slug);
  await emotes.reposo();
  return emotes.resolver(mensaje, slug);
}

/** Un mensaje del formato único, de Kick, con el texto que se pida. */
const deKick = (contenido) => mensajes.deKick({
  message_id: 'k1',
  content: contenido,
  created_at: new Date().toISOString(),
  sender: { username: 'Fulana', user_id: '909', identity: { badges: [] } },
});

const deTwitch = (texto) => mensajes.deTwitch({
  message_id: 't1',
  chatter_user_name: 'Fulana',
  chatter_user_id: '909',
  badges: [],
  message: { text: texto, fragments: [{ type: 'text', text: texto }] },
}, { message_timestamp: new Date().toISOString() });

/** El trozo de texto que tapa un emote, cortando por puntos de código. */
const recortar = (texto, e) => [...texto].slice(e.inicio, e.fin).join('');

test.after(() => {
  globalThis.fetch = fetchDeVerdad;
  chat.parar();
  canales.cerrarTodo();
});

/* ============================================ resolución por palabra */

test('resuelve la palabra exacta y respeta las mayúsculas', async () => {
  arrancarDeCero();
  darle('istincho', 'kick', '262387', [emote('CHAD'), emote('chad')]);

  const m = await resolverConTabla(deKick('mira este CHAD y este chad'), 'istincho');

  assert.equal(m.emotes.length, 2);
  assert.deepEqual(m.emotes.map(e => recortar(m.texto, e)), ['CHAD', 'chad']);
  /* Dos emotes DISTINTOS, no el mismo dos veces: 7TV los trata como
     dos dibujos y un toLowerCase() en el medio los fusionaría. */
  assert.notEqual(m.emotes[0].url, m.emotes[1].url);
  assert.equal(m.emotes[0].url, url2x('CHAD'));
  assert.deepEqual(m.emotes.map(e => e.fuente), ['7tv', '7tv']);
});

test('una palabra que no está en el set no se toca', async () => {
  arrancarDeCero();
  darle('istincho', 'kick', '262387', [emote('CHAD')]);

  /* El `CHAD` pelado del final no es decorado: sin él, esta prueba
     pasaría con 7TV apagado del todo, que es exactamente lo que no
     queremos que pase inadvertido. */
  const m = await resolverConTabla(deKick('CHAd chadd hola CHAD'), 'istincho');
  assert.equal(m.emotes.length, 1);
  assert.equal(m.emotes[0].inicio, 16, 'el único que resolvió es el último');
});

test('sólo la palabra entera: pegada a otra cosa no es un emote', async () => {
  arrancarDeCero();
  darle('istincho', 'kick', '262387', [emote('CHAD')]);

  /* Así funciona la extensión de 7TV y así tiene que funcionar esto:
     si "CHAD!" contara, cualquier mensaje con signos se llenaría de
     imágenes donde la persona escribió texto. El último, suelto, es el
     testigo de que el mecanismo está prendido. */
  const m = await resolverConTabla(deKick('xCHAD CHAD! CHAD, CHAD'), 'istincho');
  assert.equal(m.emotes.length, 1);
  assert.equal(recortar(m.texto, m.emotes[0]), 'CHAD');
  assert.equal(m.emotes[0].inicio, 18, 'el que resolvió es el suelto, no el de los signos');
});

test('separa por cualquier espacio, incluido el salto de línea', async () => {
  arrancarDeCero();
  darle('istincho', 'kick', '262387', [emote('CHAD')]);

  const m = await resolverConTabla(deKick('uno\nCHAD\tdos'), 'istincho');
  assert.equal(m.emotes.length, 1);
  assert.equal(recortar(m.texto, m.emotes[0]), 'CHAD');
});

/* ================================================ índices y Unicode */

test('un emoji fuera del BMP antes del emote no corre los índices', async () => {
  arrancarDeCero();
  darle('istincho', 'kick', '262387', [emote('CHAD')]);

  /* 💀 son DOS unidades UTF-16 y UN punto de código. Si esto se
     calculara con índices de string, `inicio` daría 3 y la página
     cortaría el texto un caracter corrido. */
  const texto = '💀 CHAD';
  const m = await resolverConTabla(deKick(texto), 'istincho');

  assert.equal(m.emotes.length, 1);
  assert.equal(m.emotes[0].inicio, 2, 'el emoji cuenta UNO, más el espacio');
  assert.equal(m.emotes[0].fin, 6);
  assert.equal(recortar(m.texto, m.emotes[0]), 'CHAD');
});

test('el array sale ordenado por inicio aunque el nativo esté al final', async () => {
  arrancarDeCero();
  darle('istincho', 'kick', '262387', [emote('CHAD')]);

  /* `agregarTextoConEmotes()` de la página recorre el array con un
     cursor y asume que viene ordenado. Desordenado no tira error:
     pinta mal, que es peor. */
  const m = await resolverConTabla(deKick('CHAD medio [emote:4148074:HYPERCLAP]'), 'istincho');

  assert.equal(m.emotes.length, 2);
  assert.deepEqual(m.emotes.map(e => e.inicio), [...m.emotes.map(e => e.inicio)].sort((a, b) => a - b));
  assert.deepEqual(m.emotes.map(e => e.fuente), ['7tv', 'kick']);
  assert.deepEqual(m.emotes.map(e => recortar(m.texto, e)), ['CHAD', 'HYPERCLAP']);
});

/* ================================================= choque con nativos */

test('el emote nativo de Kick le gana al de 7TV con el mismo nombre', async () => {
  arrancarDeCero();
  darle('istincho', 'kick', '262387', [emote('HYPERCLAP')]);

  /* Kick deja la palabra `HYPERCLAP` en el texto para que sirva de
     `alt`. Sin la regla de los rangos ocupados, esa palabra se
     resolvería de nuevo como si fuera de 7TV y quedarían dos emotes
     pisados en el mismo lugar. */
  const m = await resolverConTabla(deKick('[emote:4148074:HYPERCLAP] fuerte'), 'istincho');

  assert.equal(m.emotes.length, 1, 'un solo emote, no dos pisados');
  assert.equal(m.emotes[0].fuente, 'kick');
  assert.equal(m.emotes[0].url, 'https://files.kick.com/emotes/4148074/fullsize');
});

test('una palabra que se pisa en parte con un nativo tampoco se resuelve', async () => {
  arrancarDeCero();
  darle('istincho', 'kick', '262387', [emote('holaCHAD'), emote('CHAD')]);

  /* Sin espacio, Kick deja `holaCHAD` pegado: la palabra entera se
     pisa con el rango del nativo y ninguna de las dos sale. */
  const m = await resolverConTabla(deKick('hola[emote:7:CHAD]'), 'istincho');

  assert.equal(m.emotes.length, 1);
  assert.equal(m.emotes[0].fuente, 'kick');
});

test('el nativo de Twitch también gana', async () => {
  arrancarDeCero();
  darle('istincho', 'twitch', '4242', [emote('Kappa')]);

  const m = mensajes.deTwitch({
    message_id: 't1',
    chatter_user_name: 'Fulana',
    chatter_user_id: '909',
    badges: [],
    message: {
      text: 'hola Kappa',
      fragments: [
        { type: 'text', text: 'hola ' },
        { type: 'emote', text: 'Kappa', emote: { id: '25' } },
      ],
    },
  }, { message_timestamp: new Date().toISOString() });

  await resolverConTabla(m, 'istincho');
  assert.equal(m.emotes.length, 1);
  assert.equal(m.emotes[0].fuente, 'twitch');
});

/* ======================================== caché por creador y por red */

test('dos creadores en la misma red no comparten set', async () => {
  arrancarDeCero();
  darle('istincho', 'kick', '262387', [emote('CHAD')]);
  darle('otra', 'kick', '999', [emote('PEPE')]);

  const mio = await resolverConTabla(deKick('CHAD PEPE'), 'istincho');
  const suyo = await resolverConTabla(deKick('CHAD PEPE'), 'otra');

  assert.deepEqual(mio.emotes.map(e => recortar(mio.texto, e)), ['CHAD']);
  assert.deepEqual(suyo.emotes.map(e => recortar(suyo.texto, e)), ['PEPE'],
    'el set de un creador no se le puede pintar a los mensajes de otro');
});

test('el mismo creador tiene un set por red', async () => {
  arrancarDeCero();
  darle('istincho', 'kick', '262387', [emote('SOLOKICK')]);
  darle('istincho', 'twitch', '4242', [emote('SOLOTWITCH')]);

  const k = await resolverConTabla(deKick('SOLOKICK SOLOTWITCH'), 'istincho');
  const t = await resolverConTabla(deTwitch('SOLOKICK SOLOTWITCH'), 'istincho');

  assert.deepEqual(k.emotes.map(e => recortar(k.texto, e)), ['SOLOKICK']);
  assert.deepEqual(t.emotes.map(e => recortar(t.texto, e)), ['SOLOTWITCH']);
});

test('el fallo de un creador no ensucia la tabla del otro', async () => {
  arrancarDeCero();
  darle('istincho', 'kick', '262387', [emote('CHAD')]);
  darle('otra', 'kick', '999', 'roto');

  const roto = await resolverConTabla(deKick('CHAD'), 'otra');
  const sano = await resolverConTabla(deKick('CHAD'), 'istincho');

  assert.deepEqual(roto.emotes, [], 'el que falló no inventa nada');
  assert.equal(sano.emotes.length, 1, 'y el de al lado sigue andando');
});

test('un 500 no borra la tabla que ya funcionaba', async () => {
  arrancarDeCero();
  darle('istincho', 'kick', '262387', [emote('CHAD')]);

  const bueno = await resolverConTabla(deKick('CHAD'), 'istincho');
  assert.equal(bueno.emotes.length, 1);

  /* 7TV se cae y la caché vence. Un emote viejo es mejor que ninguno.
     Sin el `vencer()` esta prueba pasaría sin haber pedido nada: los
     diez minutos de la tabla buena no se cumplen durante el test. */
  sets.set('kick/262387', 'roto');
  emotes.vencer('istincho', 'kick');
  const antes = pedidos.length;
  emotes.tabla('istincho', 'kick');
  await emotes.reposo();
  assert.ok(pedidos.length > antes, 'la tabla vencida tiene que haberse vuelto a pedir');

  const despues = emotes.resolver(deKick('CHAD'), 'istincho');
  assert.equal(despues.emotes.length, 1,
    'con 7TV caído se sigue sirviendo la última tabla que funcionó');
  assert.equal(despues.emotes[0].url, url2x('CHAD'));
});

test('mientras se rebaja una tabla vencida se sigue sirviendo la vieja', async () => {
  arrancarDeCero();
  darle('istincho', 'kick', '262387', [emote('CHAD')]);
  await resolverConTabla(deKick('CHAD'), 'istincho');

  /* Éste es el motivo por el que el único mensaje que se pierde los
     emotes es el primero del proceso: al vencer no queda un hueco. */
  emotes.vencer('istincho', 'kick');
  const enElHueco = emotes.resolver(deKick('CHAD'), 'istincho');
  assert.equal(enElHueco.emotes.length, 1, 'no puede haber un mensaje pelado en cada vencimiento');
  await emotes.reposo();
});

/* ================================================== 7TV que no está */

test('un 404 de 7TV deja el mensaje entero y con sus emotes nativos', async () => {
  arrancarDeCero();
  identidades.set('sin7tv', { kick: '123' });
  sets.set('kick/123', 'no-existe');
  /* Con un global que SÍ resuelve: si no, esta prueba pasaría también
     con 7TV apagado entero, y entonces no dice nada sobre el 404. */
  sets.set('global', [emote('Clap')]);

  const m = await resolverConTabla(deKick('hola [emote:4148074:HYPERCLAP] CHAD 💀 Clap'), 'sin7tv');

  assert.equal(m.texto, 'hola HYPERCLAP CHAD 💀 Clap');
  assert.deepEqual(m.emotes.map(e => e.fuente), ['kick', '7tv']);
  assert.equal(recortar(m.texto, m.emotes[0]), 'HYPERCLAP');
  assert.equal(recortar(m.texto, m.emotes[1]), 'Clap');
  assert.equal(m.emotes.filter(e => recortar(m.texto, e) === 'CHAD').length, 0,
    'el canal contestó 404: de su set no sale nada');
});

test('un 404 se recuerda una hora; un fallo de verdad, un minuto', async () => {
  arrancarDeCero();
  identidades.set('sin7tv', { kick: '123' });
  sets.set('kick/123', 'no-existe');
  darle('roto', 'kick', '999', 'roto');

  await resolverConTabla(deKick('CHAD'), 'sin7tv');
  await resolverConTabla(deKick('CHAD'), 'roto');

  /* Los dos dejan la tabla vacía y los dos siguen de largo. La
     diferencia sólo se ve en CUÁNTO se lo recuerda, y no es un detalle:
     con 900 creadores, tratar el 404 como un fallo cualquiera pasa de
     unos 21 mil pedidos por día a 1,3 millones. */
  const sin = emotes.comoEsta('sin7tv', 'kick');
  const roto = emotes.comoEsta('roto', 'kick');

  assert.equal(sin.estado, 'sin-cuenta');
  assert.equal(roto.estado, 'fallo');
  assert.ok(sin.vence - Date.now() > emotes.CADUCA,
    'a un creador sin 7TV no se le vuelve a preguntar en diez minutos');
  assert.ok(roto.vence - Date.now() <= emotes.REINTENTO,
    'un 7TV caído sí se reintenta enseguida');
});

test('un creador sin 7TV no genera un pedido por mensaje', async () => {
  arrancarDeCero();
  identidades.set('sin7tv', { kick: '123' });
  sets.set('kick/123', 'no-existe');

  for (let i = 0; i < 20; i++) {
    emotes.resolver(deKick(`mensaje ${i} CHAD`), 'sin7tv');
    await emotes.reposo();
  }

  const aUsuarios = pedidos.filter(u => u.includes('/users/'));
  assert.equal(aUsuarios.length, 1,
    `veinte mensajes tienen que dar UN pedido y dieron ${aUsuarios.length}`);
});

test('un creador que no vinculó la red no pide nada', async () => {
  arrancarDeCero();
  identidades.set('solokick', { kick: '123' });
  sets.set('kick/123', [emote('CHAD')]);

  /* Un mensaje de Twitch de una sala sin Twitch vinculado no tiene id
     que preguntarle a 7TV. Ni siquiera se sale a la red. */
  const t = await resolverConTabla(deTwitch('CHAD'), 'solokick');
  assert.deepEqual(t.emotes, []);
  assert.equal(pedidos.filter(u => u.includes('/users/twitch/')).length, 0);

  /* Y el Kick del MISMO creador sigue andando: sin esto, la prueba
     pasaría igual con 7TV apagado entero. */
  const k = await resolverConTabla(deKick('CHAD'), 'solokick');
  assert.equal(k.emotes.length, 1);
  assert.equal(pedidos.filter(u => u.includes('/users/kick/123')).length, 1);
});

test('varios mensajes de golpe no son varios pedidos', async () => {
  arrancarDeCero();
  darle('istincho', 'kick', '262387', [emote('CHAD')]);

  /* Sin la promesa compartida, una ráfaga de chat en el mismo tick
     serían diez bajadas del mismo set. */
  for (let i = 0; i < 10; i++) emotes.resolver(deKick('CHAD'), 'istincho');
  await emotes.reposo();

  assert.equal(pedidos.filter(u => u.includes('/users/kick/262387')).length, 1);
});

/* ============================== el contador de bajadas en vuelo

   Ésta es la parte que casi se lleva puesta la funcionalidad entera y
   que no tenía ni una prueba: si el contador de bajadas simultáneas no
   vuelve a bajar, a la sexta 7TV queda apagado para TODOS los
   creadores, para siempre, sin un pedido y sin una línea de log. */

const esperar = ms => new Promise(ok => setTimeout(ok, ms));

/** Espera a que un creador tenga tabla, con tope: si no llega, falla. */
async function esperarTabla(slug, red, porque) {
  const limite = Date.now() + 3000;
  while (Date.now() < limite && !emotes.tabla(slug, red).size) await esperar(20);
  assert.ok(emotes.tabla(slug, red).size, porque);
}

test('el tope frena la ráfaga y después el contador se destraba', async () => {
  arrancarDeCero();
  const todos = [];
  for (let i = 0; i < emotes.EN_VUELO_MAX + 2; i++) {
    const slug = `creador${i}`;
    todos.push(slug);
    darle(slug, 'kick', `id${i}`, [emote('CHAD')]);
  }

  /* Todos en el mismo tick. El primer `resolver` se lleva DOS lugares:
     el del creador y el de los globales, que son de todos. Los que no
     entran NO se encolan: se reintentan con el próximo mensaje, así
     que después de que se vacíe el vuelo siguen sin pedir. */
  for (const s of todos) emotes.resolver(deKick('CHAD'), s);
  await emotes.reposo();
  assert.equal(pedidos.filter(u => u.includes('/users/')).length, emotes.EN_VUELO_MAX - 1,
    'sin tope, novecientos creadores despertando son novecientos fetch de una');

  /* Y acá está el punto: los que no entraron tienen que entrar ahora.
     Si el descuento del contador no corre, esto no pasa nunca. */
  for (const s of todos) await esperarTabla(s, 'kick', `${s} se quedó sin tabla: el contador no se destrabó`);
});

test('un EMOTES_PLAZO_MS con un typo no apaga los emotes para siempre', async () => {
  /* EL BUG, y no era teorico: `Math.max(1000, Number('20s'))` da NaN y
     `setTimeout(fn, NaN)` NO espera para siempre, dispara a UN
     milisegundo. Asi que `EMOTES_PLAZO_MS=20s` —el typo natural, el
     que se escribe pensando "veinte segundos"— no alargaba el plazo:
     hacia vencer TODAS las bajadas, dejaba el modulo sin una sola
     tabla y el unico rastro era un log que decia "tardo mas de NaN ms".

     Se prueba con una instancia aparte del modulo (el `?` la separa en
     el cache de modulos) porque el plazo se lee al cargarse. */
  arrancarDeCero();
  process.env.EMOTES_PLAZO_MS = '20s';
  const conTypo = await import('../servidor/emotes.js?plazo-con-typo=1');
  /* Se devuelve el valor de la suite enseguida: las instancias que
     vengan despues tienen que leer el de siempre. */
  process.env.EMOTES_PLAZO_MS = '200';

  conTypo.fijarIdentidad(async (slug, red) => {
    const i = identidades.get(slug);
    return i?.[red] ? { red, sala: slug, usuarioId: i[red] } : null;
  });

  darle('contypo', 'kick', 'idtypo', [emote('CHAD')]);
  /* La bajada tarda 40 ms: con el plazo en NaN (1 ms) se pierde
     siempre, y con el plazo en 20 s entra siempre. */
  demora = 40;

  conTypo.tabla('contypo', 'kick');
  await conTypo.reposo();
  demora = 0;

  assert.equal(conTypo.comoEsta('contypo', 'kick').estado, 'ok:1',
    'con el plazo en NaN esto dice "fallo": la bajada vencio a 1 ms');
  assert.equal(conTypo.tabla('contypo', 'kick').size, 1);
  conTypo.olvidarTodo();
});

test('una bajada colgada no apaga 7TV para todos', async () => {
  arrancarDeCero();
  /* El caso real: `vinculos.identidad` va a Mongo, y el cliente de
     Mongo se crea sin socketTimeoutMS. Un socket medio abierto no
     vence nunca y la promesa queda colgada para siempre. Sin un plazo
     propio, seis de éstas dejan mudo al módulo entero. */
  /* Los globales se bajan PRIMERO, y de verdad: si se los deja para
     después se llevan uno de los cupos y, al terminar bien, lo
     liberan. Ese cupo suelto alcanza para que el creador sano entre
     aunque las colgadas no se destraben nunca, y la prueba pasaría sin
     probar nada (comprobado: la mutación "sacar el plazo" sobrevivía). */
  sets.set('global', [emote('Clap')]);
  darle('calienta', 'kick', 'idcal', [emote('Clap')]);
  await resolverConTabla(deKick('Clap'), 'calienta');

  /* `sano` llega SIN tabla y SIN haber sido consultado, que es lo
     único que hace que la espera de abajo mida algo. Se comprueba con
     `comoEsta`, que sólo mira: preguntar con `tabla()` le agendaría la
     bajada acá, antes de que se cuelguen los cupos, y entonces la
     prueba pasaría con plazo y sin plazo. */
  darle('sano', 'kick', 'idsano', [emote('CHAD')]);
  assert.equal(emotes.comoEsta('sano', 'kick'), null);

  const colgados = new Set();
  for (let i = 0; i < emotes.EN_VUELO_MAX; i++) colgados.add(`colgado${i}`);
  for (const s of colgados) sets.set(`kick/${s}`, [emote('CHAD')]);

  const antes = identidades;
  emotes.fijarIdentidad(async (slug, red) => {
    if (colgados.has(slug)) return new Promise(() => { /* nunca contesta */ });
    const i = antes.get(slug);
    return i?.[red] ? { red, sala: slug, usuarioId: i[red] } : null;
  });

  /* Las seis colgadas se quedan con TODOS los cupos. */
  for (const s of colgados) emotes.resolver(deKick('CHAD'), s);

  await esperarTabla('sano', 'kick',
    'las bajadas colgadas nunca soltaron su lugar: 7TV quedó apagado para todos');

  /* Devolver la identidad de siempre para las pruebas que sigan. */
  emotes.fijarIdentidad(async (slug, red) => {
    const i = identidades.get(slug);
    return i?.[red] ? { red, sala: slug, usuarioId: i[red] } : null;
  });
});

test('doscientos mensajes no son doscientas líneas de log', async () => {
  arrancarDeCero();
  identidades.set('sin7tv', { kick: '123' });
  sets.set('kick/123', 'no-existe');

  const log = console.log;
  const warn = console.warn;
  let lineas = 0;
  console.log = () => { lineas++; };
  console.warn = () => { lineas++; };
  try {
    for (let i = 0; i < 200; i++) {
      emotes.resolver(deKick(`mensaje ${i} CHAD`), 'sin7tv');
      await emotes.reposo();
    }
  } finally {
    console.log = log;
    console.warn = warn;
  }

  /* Una por el creador sin cuenta y una por los globales. El creador
     sin 7TV es la MAYORÍA: si esto se afloja, el log de Railway se
     vuelve inservible la primera noche movida. */
  assert.ok(lineas <= 3, `doscientos mensajes dejaron ${lineas} líneas de log`);
});

/* ================================= lo que pasa con datos fuera de forma */

test('resolver no tira nunca, aunque le llegue cualquier cosa', async () => {
  arrancarDeCero();
  darle('istincho', 'kick', '262387', [emote('CHAD')]);
  await resolverConTabla(deKick('CHAD'), 'istincho');

  /* `resolver` corre adentro del webhook de Kick, DESPUÉS de que el
     evento quedó marcado como visto y sin try alrededor: una excepción
     acá no sería un emote que falta, sería el mensaje perdido y un 500. */
  const raros = [
    { tipo: 'chat', red: 'kick', texto: 12345, emotes: [] },
    { tipo: 'chat', red: 'kick', texto: 'CHAD', emotes: [null] },
    { tipo: 'chat', red: 'kick', texto: 'CHAD', emotes: [{ inicio: NaN, fin: NaN }] },
    { tipo: 'chat', red: 'kick', texto: 'CHAD', emotes: 'no soy un array' },
    { tipo: 'chat', red: 'kick' },
    {},
    null,
  ];
  for (const r of raros) {
    assert.doesNotThrow(() => emotes.resolver(r, 'istincho'), `explotó con ${JSON.stringify(r)}`);
  }
});

test('un rango nativo con NaN no deja pasar a los que vienen después', async () => {
  arrancarDeCero();
  darle('istincho', 'kick', '262387', [emote('CHAD')]);
  await resolverConTabla(deKick('CHAD'), 'istincho');

  /* El puntero de rangos ocupados va sólo para adelante. Un rango con
     NaN no se puede comparar con nada, así que sin saneo el puntero se
     clava ahí y TODOS los nativos que vengan después dejan de estorbar:
     saldría un emote de 7TV pisado encima de uno de Kick. */
  const m = {
    tipo: 'chat', red: 'kick', texto: 'uno CHAD',
    emotes: [{ inicio: NaN, fin: NaN, id: 'x', url: 'u' }, { inicio: 4, fin: 8, id: 'k', url: 'u' }],
  };
  emotes.resolver(m, 'istincho');
  const deSieteTv = m.emotes.filter(e => e.fuente === '7tv');
  assert.deepEqual(deSieteTv, [], 'CHAD está tapado por un nativo: no lo puede resolver 7TV');
});

test('los nativos desordenados igual bloquean', async () => {
  arrancarDeCero();
  darle('istincho', 'kick', '262387', [emote('CHAD'), emote('PEPE')]);
  await resolverConTabla(deKick('CHAD'), 'istincho');

  /* Los tres traductores entregan los nativos ordenados, pero el
     puntero depende de eso y `resolver` es una entrada exportada. */
  const m = {
    tipo: 'chat', red: 'kick', texto: 'CHAD y PEPE',
    emotes: [{ inicio: 7, fin: 11, id: 'b', url: 'u' }, { inicio: 0, fin: 4, id: 'a', url: 'u' }],
  };
  emotes.resolver(m, 'istincho');
  assert.equal(m.emotes.filter(e => e.fuente === '7tv').length, 0,
    'los dos están tapados por nativos, vengan en el orden que vengan');
});

/* ====================================================== tope de peso */

test('un emote que no entra en el presupuesto baja de tamaño', async () => {
  arrancarDeCero();
  const kb = emotes.PRESUPUESTO / 1024;
  darle('istincho', 'kick', '262387', [
    emote('LIVIANO', { kb1x: 5, kb2x: 20 }),
    /* El caso real: `CHAD` del set del dueño pesa 246 KB en 2x y
       97 KB en 1x. Sale, pero un escalón más abajo. */
    emote('PESADO', { kb1x: kb - 1, kb2x: kb + 1 }),
  ]);

  const m = await resolverConTabla(deKick('LIVIANO PESADO'), 'istincho');

  assert.equal(m.emotes.length, 2);
  assert.equal(m.emotes[0].url, url2x('LIVIANO'));
  assert.equal(m.emotes[1].url, url1x('PESADO'), 'el pesado sale en 1x, no en 2x');
});

test('un emote que no entra ni en 1x no sale, y la palabra queda como texto', async () => {
  arrancarDeCero();
  const kb = emotes.PRESUPUESTO / 1024;
  /* `maxwin`, el peor del set real: 1.100 KB en 2x y 505 KB hasta en
     1x. Mandarlo sería bajárselo en el navegador de cada espectador. */
  darle('istincho', 'kick', '262387', [
    emote('MAXWIN', { kb1x: kb + 1, kb2x: kb * 4 }),
    emote('NORMAL', { kb1x: 5, kb2x: 20 }),
  ]);

  const m = await resolverConTabla(deKick('MAXWIN NORMAL'), 'istincho');

  assert.equal(m.emotes.length, 1);
  assert.equal(recortar(m.texto, m.emotes[0]), 'NORMAL');
  assert.equal(m.texto, 'MAXWIN NORMAL', 'el texto no se toca: la palabra se lee igual');
});

test('el presupuesto es inclusivo: lo que pesa justo, entra', async () => {
  arrancarDeCero();
  /* El borde exacto. Con `>=` en vez de `>`, un emote que pesa
     exactamente el tope bajaría un escalón de calidad sin motivo. */
  darle('istincho', 'kick', '262387', [emote('JUSTO', { kb2x: emotes.PRESUPUESTO / 1024 })]);

  const m = await resolverConTabla(deKick('JUSTO'), 'istincho');
  assert.equal(m.emotes[0].url, url2x('JUSTO'));
});

test('un peso que 7TV no dice, o que dice mal, no cuenta como liviano', async () => {
  arrancarDeCero();
  const roto = emote('ROTO');
  /* `Number(-1) || 0` da -1, y `-1 > PRESUPUESTO` es false: un tamaño
     negativo entraría como si fuera gratis. Y un `size` ausente no es
     "liviano", es "no se sabe". */
  roto.data.host.files = [
    { name: '2x.webp', size: -1 },
    { name: '1x.webp' },
  ];
  darle('istincho', 'kick', '262387', [roto, emote('SANO')]);

  const m = await resolverConTabla(deKick('ROTO SANO'), 'istincho');
  assert.equal(m.emotes.length, 1);
  assert.equal(recortar(m.texto, m.emotes[0]), 'SANO');
});

test('una URL que no es de 7TV y por https no se le manda a nadie', async () => {
  arrancarDeCero();
  const malos = ['javascript:alert(1)', '//evil.example/emote/x', 'http://cdn.7tv.app/emote/x'];
  const lista = malos.map((u, i) => {
    const e = emote(`MALO${i}`);
    e.data.host.url = u;
    return e;
  });
  darle('istincho', 'kick', '262387', [...lista, emote('BUENO')]);

  /* Esto termina en el `src` de un <img> en la pantalla de cada
     espectador y lo arma un tercero. El estándar de la casa es el de
     `colorSeguro()`: validar en el servidor además de en la página. */
  const m = await resolverConTabla(deKick('MALO0 MALO1 MALO2 BUENO'), 'istincho');
  assert.deepEqual(m.emotes.map(e => recortar(m.texto, e)), ['BUENO']);
  assert.ok(m.emotes[0].url.startsWith('https://cdn.7tv.app/'));
});

test('un set que no viene incrustado se pide aparte', async () => {
  arrancarDeCero();
  identidades.set('istincho', { kick: '262387' });
  /* La cascada de respaldo. Medido contra el 7TV real, el set viene
     siempre incrustado en `emote_set` y esto no llega a usarse; está
     porque una respuesta sin él es justo el caso en el que quedarse
     sin emotes sería silencioso. */
  sets.set('kick/262387', { emote_set_id: 'set-aparte' });
  setsAparte.set('set-aparte', [emote('CHAD')]);

  const m = await resolverConTabla(deKick('CHAD'), 'istincho');
  assert.equal(m.emotes.length, 1);
  assert.equal(pedidos.filter(u => u.includes('/emote-sets/set-aparte')).length, 1);
});

test('un mensaje que no es de chat no se toca, y una red desconocida no se pregunta', async () => {
  arrancarDeCero();
  darle('istincho', 'kick', '262387', [emote('CHAD')]);
  await resolverConTabla(deKick('CHAD'), 'istincho');

  const reloj = { tipo: 'reloj', red: 'kick', texto: 'CHAD', segundo: 12 };
  emotes.resolver(reloj, 'istincho');
  assert.equal('emotes' in reloj, false, 'un evento de reloj no tiene emotes y no los gana acá');

  const otraRed = { tipo: 'chat', red: 'mastodon', texto: 'CHAD', emotes: [] };
  emotes.resolver(otraRed, 'istincho');
  assert.deepEqual(otraRed.emotes, []);
  assert.equal(pedidos.filter(u => u.includes('/users/mastodon/')).length, 0,
    'una red que 7TV no indexa no se le pregunta');
});

test('un mensaje no puede meter emotes sin límite', async () => {
  arrancarDeCero();
  darle('istincho', 'kick', '262387', [emote('CHAD')]);

  /* Un mensaje de 2000 caracteres de "CHAD " son 400 <img> en el DOM
     de cada pestaña abierta, por un solo mensaje. */
  const m = await resolverConTabla(deKick('CHAD '.repeat(400).trim()), 'istincho');

  assert.equal(m.emotes.length, emotes.TOPE_POR_MENSAJE);
});

/* ======================================================== globales */

test('los globales de 7TV valen para cualquier canal, y se bajan una sola vez', async () => {
  arrancarDeCero();
  sets.set('global', [emote('Clap')]);
  identidades.set('sin7tv', { kick: '123' });
  sets.set('kick/123', 'no-existe');
  darle('otra', 'kick', '999', [emote('PEPE')]);

  const uno = await resolverConTabla(deKick('Clap'), 'sin7tv');
  const dos = await resolverConTabla(deKick('Clap PEPE'), 'otra');

  assert.equal(uno.emotes.length, 1, 'sin cuenta propia igual se ven los globales');
  assert.equal(dos.emotes.length, 2);
  assert.equal(pedidos.filter(u => u.endsWith('/emote-sets/global')).length, 1,
    'los globales son los mismos para todos: un solo pedido para todo el proceso');
});

test('el set del canal le gana a los globales con el mismo nombre', async () => {
  arrancarDeCero();
  /* Mismo nombre, dos dibujos distintos: un streamer puede ponerle a
     un emote suyo el nombre de uno global, y en su casa manda el suyo.
     Los dos ids tienen que ser distintos o la prueba no distingue
     nada. */
  const global = emote('Clap', { sabor: 'el-de-7tv' });
  const propio = emote('Clap', { sabor: 'el-del-canal' });
  assert.notEqual(global.id, propio.id);

  sets.set('global', [global]);
  darle('istincho', 'kick', '262387', [propio]);

  const m = await resolverConTabla(deKick('Clap'), 'istincho');

  assert.equal(m.emotes.length, 1);
  assert.equal(m.emotes[0].id, propio.id, 'ganó el global y tenía que ganar el del canal');
});

/* ================================= los dos embudos de chat.js, de punta */

test('los emotes de 7TV salen por el camino de Kick y por el de Twitch', async () => {
  arrancarDeCero();
  darle('istincho', 'kick', '262387', [emote('CHAD')]);
  darle('istincho', 'twitch', '4242', [emote('CHAD')]);

  /* La primera vuelta agenda las bajadas; la segunda es la que tiene
     que traer los emotes. Se prueban los DOS embudos porque el día que
     alguien agregue el paso en uno solo, el chat de una red muestra
     los emotes y el de la otra no. */
  chat.recibirDeKick('istincho', { tipo: 'chat.message.sent' }, deKickCrudo('CHAD'));
  chat.recibirDeTwitch('istincho', deTwitch('CHAD'));
  await emotes.reposo();

  chat.recibirDeKick('istincho', { tipo: 'chat.message.sent' }, deKickCrudo('CHAD'));
  chat.recibirDeTwitch('istincho', { ...deTwitch('CHAD'), id: 't2' });

  const guardados = canales.ultimos('istincho');
  const conEmote = guardados.filter(m => m.emotes?.some(e => e.fuente === '7tv'));
  assert.deepEqual(conEmote.map(m => m.red).sort(), ['kick', 'twitch'],
    'las dos redes tienen que resolver 7TV, no una sola');
});

function deKickCrudo(contenido) {
  return {
    message_id: `k-${Math.random()}`,
    content: contenido,
    created_at: new Date().toISOString(),
    sender: { username: 'Fulana', user_id: '909', identity: { badges: [] } },
  };
}

/* ============================== el respaldo entre redes de un creador

   Verificado el 2026-09-22 contra el 7TV real: el Kick del dueño tiene
   set propio y su Twitch no. Sin respaldo, sus mensajes de Twitch
   salen sin un solo emote de 7TV. Lo que se prueba acá:

     - la red propia SIEMPRE gana, aunque el respaldo tenga un emote
       con el mismo nombre;
     - sin set propio (confirmado, no sólo "todavía no llegó"), resuelve
       con el de la otra red;
     - sin la otra red vinculada, el respaldo no pide nada;
     - el respaldo no se pide dos veces;
     - los globales siguen resolviendo por debajo del respaldo, igual
       que por debajo del propio.

   Las cuatro primeras van con un token POSITIVO: que el emote
   efectivamente aparezca en el lugar exacto, no sólo que algo esté
   ausente. Una prueba que sólo afirma ausencias pasa igual con la
   función entera apagada. */

test('la red propia le gana al respaldo aunque tengan un emote con el mismo nombre', async () => {
  arrancarDeCero();
  darle('istincho', 'kick', '262387', [emote('CHAD', { sabor: 'kick' })]);
  darle('istincho', 'twitch', '245305929', [emote('CHAD', { sabor: 'twitch' })]);

  const m = await resolverConTabla(deTwitch('CHAD'), 'istincho');

  assert.equal(m.emotes.length, 1);
  assert.equal(recortar(m.texto, m.emotes[0]), 'CHAD');
  /* Si el respaldo (Kick) pisara al propio (Twitch), esta URL sería la
     del "sabor: kick". */
  assert.equal(m.emotes[0].url, url2x('CHAD', { sabor: 'twitch' }));
  assert.notEqual(m.emotes[0].url, url2x('CHAD', { sabor: 'kick' }));
});

test('sin set propio en una red, resuelve con el set de la otra', async () => {
  arrancarDeCero();
  darle('istincho', 'kick', '262387', [emote('CHAD')]);
  identidades.set('istincho', { ...identidades.get('istincho'), twitch: '245305929' });
  /* La forma real, verificada hoy contra 7TV: el usuario de Twitch
     existe pero sin `emote_set` (no tiene 7TV activado en esa red). */
  sets.set('twitch/245305929', { user: { connections: [] } });

  const m1 = emotes.resolver(deTwitch('CHAD'), 'istincho');
  await emotes.reposo(); // confirma que Twitch no tiene set propio
  emotes.resolver(deTwitch('CHAD'), 'istincho');
  await emotes.reposo(); // baja el respaldo (Kick)
  const m = emotes.resolver(deTwitch('CHAD'), 'istincho');

  assert.deepEqual(m1.emotes, [], 'el primer mensaje, antes de confirmar el respaldo, sale pelado');
  assert.equal(m.emotes.length, 1);
  assert.equal(recortar(m.texto, m.emotes[0]), 'CHAD');
  assert.equal(m.emotes[0].url, url2x('CHAD'));
  assert.equal(m.emotes[0].fuente, '7tv');
});

test('sin vínculo en la otra red, el respaldo no pide nada', async () => {
  arrancarDeCero();
  identidades.set('istincho', { kick: '262387' }); // sólo Kick vinculado
  sets.set('kick/262387', 'no-existe');            // Kick vinculado, pero sin cuenta de 7TV
  sets.set('global', [emote('KEKW')]);

  emotes.resolver(deKick('KEKW'), 'istincho');
  await emotes.reposo(); // confirma kick sin-cuenta y baja los globales
  const m = emotes.resolver(deKick('KEKW'), 'istincho');

  /* Token positivo: el global resuelve igual, así que el mecanismo
     sigue vivo y lo que faltó fue específicamente el vínculo de la
     otra red, no la función entera. */
  assert.equal(m.emotes.length, 1, 'el global resuelve igual: el mecanismo sigue vivo');
  assert.equal(recortar(m.texto, m.emotes[0]), 'KEKW');
  assert.equal(m.emotes[0].fuente, '7tv');
  assert.equal(pedidos.filter(u => u.includes('/users/twitch/')).length, 0,
    'sin Twitch vinculado, el respaldo ni pregunta');
});

test('el respaldo se pide una sola vez aunque lleguen más mensajes', async () => {
  arrancarDeCero();
  darle('istincho', 'kick', '262387', [emote('CHAD')]);
  identidades.set('istincho', { ...identidades.get('istincho'), twitch: '245305929' });
  sets.set('twitch/245305929', { user: { connections: [] } });

  emotes.resolver(deTwitch('CHAD'), 'istincho');
  await emotes.reposo(); // confirma twitch sin set propio
  emotes.resolver(deTwitch('CHAD'), 'istincho');
  await emotes.reposo(); // baja el respaldo (Kick), una vez
  const m = emotes.resolver(deTwitch('CHAD'), 'istincho');

  assert.equal(m.emotes.length, 1);
  assert.equal(recortar(m.texto, m.emotes[0]), 'CHAD');
  const antes = pedidos.filter(u => u.includes('/users/kick/262387')).length;
  assert.equal(antes, 1, 'el respaldo de Kick se pidió una sola vez');

  for (let i = 0; i < 10; i++) emotes.resolver(deTwitch('CHAD'), 'istincho');
  await emotes.reposo();

  assert.equal(pedidos.filter(u => u.includes('/users/kick/262387')).length, antes,
    'diez mensajes más no vuelven a pedir el respaldo ya cacheado');
});

test('los globales siguen resolviendo por debajo del respaldo', async () => {
  arrancarDeCero();
  identidades.set('istincho', { kick: '262387', twitch: '245305929' });
  sets.set('kick/262387', 'no-existe'); // Kick vinculado, sin cuenta de 7TV
  sets.set('twitch/245305929', [emote('SOLO_RESPALDO', { sabor: 'respaldo' })]);
  sets.set('global', [emote('SOLO_GLOBAL'), emote('SOLO_RESPALDO', { sabor: 'global' })]);

  emotes.resolver(deKick('SOLO_RESPALDO SOLO_GLOBAL'), 'istincho');
  await emotes.reposo(); // confirma kick sin-cuenta y baja los globales
  emotes.resolver(deKick('SOLO_RESPALDO SOLO_GLOBAL'), 'istincho');
  await emotes.reposo(); // baja el respaldo (Twitch)
  const m = emotes.resolver(deKick('SOLO_RESPALDO SOLO_GLOBAL'), 'istincho');

  assert.equal(m.emotes.length, 2);
  assert.equal(recortar(m.texto, m.emotes[0]), 'SOLO_RESPALDO');
  assert.equal(m.emotes[0].url, url2x('SOLO_RESPALDO', { sabor: 'respaldo' }),
    'el respaldo (Twitch) le gana al global con el mismo nombre');
  assert.equal(recortar(m.texto, m.emotes[1]), 'SOLO_GLOBAL');
  assert.equal(m.emotes[1].url, url2x('SOLO_GLOBAL'));
});

/* ================================================= el interruptor

   `EMOTES_7TV=0` deja el chat como estaba antes de este modulo: las
   palabras como palabras y ni un pedido a 7TV. Es el freno de mano por
   si 7TV empieza a contestar cualquier cosa, y un freno que nadie probo
   no es un freno.

   Las dos puntas, porque un test que solo mira el apagado pasa igual
   con el modulo roto. */

test('con el interruptor prendido (el default) el emote se resuelve', async () => {
  arrancarDeCero();
  darle('istincho', 'kick', '4242', [emote('CHAD')]);

  const m = await resolverConTabla(deKick('mira CHAD'), 'istincho');

  assert.equal(emotes.ACTIVO, true);
  assert.equal(m.emotes.length, 1);
  assert.equal(m.emotes[0].fuente, '7tv');
});

test('con EMOTES_7TV=0 no se resuelve nada y no se le pide nada a 7TV', async () => {
  /* Instancia aparte del modulo: el interruptor se lee al cargarse. */
  process.env.EMOTES_7TV = '0';
  const apagados = await import('../servidor/emotes.js?apagado=1');
  delete process.env.EMOTES_7TV;

  apagados.fijarIdentidad(async (slug, red) => {
    const i = identidades.get(slug);
    return i?.[red] ? { red, sala: slug, usuarioId: i[red] } : null;
  });

  arrancarDeCero();
  darle('istincho', 'kick', '4242', [emote('CHAD')]);

  assert.equal(apagados.ACTIVO, false);

  const m = apagados.resolver(deKick('mira CHAD'), 'istincho');
  await apagados.reposo();
  apagados.resolver(m, 'istincho');

  assert.deepEqual(m.emotes, [], 'la palabra se queda palabra, que es como estaba antes');
  assert.deepEqual(pedidos, [], 'ni un pedido: apagado no toca la red');
  assert.equal(apagados.comoEsta('istincho', 'kick'), null, 'y no se agenda ninguna bajada');

  /* Y APAGAR 7TV NO APAGA EL SELECTOR DE EMOTES DE KICK: son dos
     terceros distintos, y los nativos de Kick no tienen nada que ver
     con 7TV. Por eso `anotarVistos` vive fuera del `if (!ACTIVO)`. */
  apagados.resolver(deKick('[emote:5747892:MEGALUL]'), 'istincho');
  const catalogo = apagados.catalogo('istincho', ['kick']);
  assert.deepEqual(catalogo.map(e => e.nombre), ['MEGALUL']);
  assert.equal(catalogo[0].marca, '[emote:5747892:MEGALUL]');

  apagados.olvidarTodo();
});
