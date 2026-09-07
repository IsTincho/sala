/* ============================================================
   El entregable 2 de la fase: las suscripciones de Kick, la
   verificacion cada cinco minutos, y la reconexion sola de Twitch al
   arrancar el servidor.

   Es la parte que decide si el chat existe o no, y hasta ahora no
   tenia un solo test: se podia romper `verificarKick` de manera que
   nunca resuscribiera y ademas dijera "activa" en la pantalla, y
   todo seguia verde.

   No se sale a la red: se reemplaza `fetch` por un router chico que
   contesta como Kick y anota que se le pidio. Los endpoints y las
   formas son los de docs.kick.com, los mismos que usa kick.js.

   ---------------------------------------------------------------
   POR QUE EL "ESTA EN VIVO" SE CRUZA CON LA API Y NO CON EL WEBHOOK

   `livestream.status.updated` avisa en las TRANSICIONES. Un deploy en
   medio del stream deja el dato en false el resto de la noche, y en
   el caso que motiva el aviso —la URL del webhook sin cargar a mano
   en el portal de Kick— no llega ningun webhook, asi que el aviso que
   existe para detectar "no llegan webhooks" no podria aparecer nunca.
   Por eso el ciclo de los cinco minutos pregunta por /channels.
   ============================================================ */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const DATOS = await fsp.mkdtemp(path.join(os.tmpdir(), 'sala-suscripciones-'));
process.env.SALA_DATOS = DATOS;
process.env.CLAVE_CIFRADO = crypto.randomBytes(32).toString('base64');
process.env.KICK_CLIENT_ID = 'cliente-de-prueba';
process.env.KICK_CLIENT_SECRET = 'secreto-de-prueba';

/* Un tope chico para poder llegar a el con tres salas en vez de con
   cincuenta y una, igual que `TOPE_CANALES` en los otros archivos.
   Ningun otro test de aca abre mas de una conexion, asi que bajarlo no
   cambia lo que prueban. El test del tope comprueba que este numero
   sea el que llego a `chat.js`: si alguien borra esta linea, falla en
   vez de ponerse a abrir cincuenta conexiones de mentira. */
process.env.TOPE_TWITCH = '2';

const chat = await import('../servidor/chat.js');
const canales = await import('../servidor/canales.js');
const kick = await import('../servidor/kick.js');
const vinculos = await import('../servidor/vinculos.js');
const { escuchar } = await import('./fijos/bus-falso.js');

const CANAL = 'istincho';
const USUARIO = '4242';
const esperar = ms => new Promise(ok => setTimeout(ok, ms));

/* ------------------------------------------------- el Kick de mentira */

const fetchDeVerdad = globalThis.fetch;

let llamadas = [];
let suscripciones = [];      // lo que Kick dice que ya existe
let enVivo = false;          // lo que /channels dice de stream.is_live
let falla = null;            // ruta que tiene que contestar mal, o null

globalThis.fetch = async (recurso, opciones = {}) => {
  const url = String(recurso);
  const metodo = opciones.method ?? 'GET';
  const cuerpo = opciones.body && typeof opciones.body === 'string' && opciones.body.startsWith('{')
    ? JSON.parse(opciones.body)
    : null;
  llamadas.push({ url, metodo, cuerpo });

  const responder = (estado, datos) =>
    new Response(JSON.stringify(datos), {
      status: estado,
      headers: { 'Content-Type': 'application/json' },
    });

  if (falla && url.includes(falla)) return responder(500, { error: 'kick esta caido' });

  if (url.includes('/events/subscriptions')) {
    if (metodo === 'POST') {
      /* Kick crea las que le pidas y las devuelve; a partir de ahi
         aparecen en el listado. */
      for (const e of cuerpo.events) suscripciones.push({ id: `s-${e.name}`, event: e.name, version: e.version });
      return responder(200, { data: cuerpo.events.map(e => ({ id: `s-${e.name}`, ...e })) });
    }
    return responder(200, { data: suscripciones });
  }

  if (url.includes('/channels')) {
    return responder(200, {
      data: [{
        broadcaster_user_id: Number(USUARIO),
        slug: CANAL,
        stream_title: 'una peli',
        stream: { is_live: enVivo, viewer_count: 12 },
      }],
    });
  }

  throw new Error(`el test no esperaba este pedido: ${metodo} ${url}`);
};

/* ---------------------------------------------- el Twitch de mentira */

class EventSubFalso {
  constructor(opciones) {
    this.opciones = opciones;
    this.estado = 'cortado';
    this.intentosFallidosSeguidos = 0;
    this.conectada = false;
    this.cerrada = false;
  }
  conectar() { this.conectada = true; }
  cerrar() { this.cerrada = true; }
}

let eventSubs = [];

/* El plan B no se ejercita en este archivo, pero la fabrica se fija
   igual: `fijarConexiones` exige las dos justamente para que un test
   no se quede con la `ConexionIrc` de verdad puesta y termine abriendo
   un TLS contra irc.chat.twitch.tv el dia que dispare el plan B. Si
   algo la llama, se anota y el test lo ve. */
let ircsPedidos = [];
const ircQueNadieDeberiaPedir = () => {
  ircsPedidos.push(new Error('alguien prendio el plan B en este archivo'));
  return { conectar() {}, cerrar() {}, ultimaLlegada: null };
};

async function guardarVinculoKick() {
  await vinculos.guardar(CANAL, 'kick', {
    usuarioId: USUARIO,
    nombre: 'IsTincho',
    slug: CANAL,
    accessToken: 'token-kick',
    refreshToken: 'refresco-kick',
    venceEn: Date.now() + 3600_000,
    scopes: 'user:read channel:read chat:write events:subscribe',
  });
}

async function guardarVinculoTwitch(sala = CANAL) {
  await vinculos.guardar(sala, 'twitch', {
    usuarioId: '777',
    nombre: 'IsTincho',
    login: sala,
    accessToken: 'token-twitch',
    refreshToken: 'refresco-twitch',
    venceEn: Date.now() + 3600_000,
    scopes: 'user:read:chat user:write:chat',
  });
}

test.beforeEach(async () => {
  chat.reiniciar();
  canales.cerrarTodo();
  canales.canal(CANAL);
  llamadas = [];
  suscripciones = [];
  eventSubs = [];
  enVivo = false;
  falla = null;
  await vinculos.olvidar(CANAL, 'kick');
  await vinculos.olvidar(CANAL, 'twitch');
  ircsPedidos = [];
  chat.fijarConexiones({
    eventSub: opciones => { const c = new EventSubFalso(opciones); eventSubs.push(c); return c; },
    irc: ircQueNadieDeberiaPedir,
  });
});

test.after(async () => {
  chat.parar();
  canales.cerrarTodo();
  globalThis.fetch = fetchDeVerdad;
  await fsp.rm(DATOS, { recursive: true, force: true });
});

const pedidosA = fragmento => llamadas.filter(l => l.url.includes(fragmento));

/* ------------------------------------- la costura no se fija a medias */

test('fijarConexiones no acepta media costura', async () => {
  /* La trampa que dejo la Fase 1: fijar solo `eventSub` dejaba la
     `ConexionIrc` DE VERDAD como fabrica del plan B. Mientras ningun
     test de este archivo llegue al cuarto fallo de EventSub no pasa
     nada; el dia que uno llegue, la suite abre un TLS contra
     irc.chat.twitch.tv desde la maquina que corra `npm test`, sin que
     nada lo diga. Falla al fijarla, que es cuando se puede leer. */
  assert.throws(
    () => chat.fijarConexiones({ eventSub: () => ({ conectar() {}, cerrar() {} }) }),
    /las dos fabricas/,
    'fijar una sola deja la conexion de verdad puesta y eso tiene que doler aca');

  assert.throws(
    () => chat.fijarConexiones({ irc: () => ({ conectar() {}, cerrar() {} }) }),
    /las dos fabricas/);

  /* Sin argumentos si: es como `reiniciar()` vuelve a las de verdad. */
  chat.fijarConexiones();
});

test('ningun test de este archivo prende el plan B por accidente', () => {
  assert.deepEqual(ircsPedidos, [], 'alguien pidio una ConexionIrc: revisar por que');
});

/* ------------------------------------------- suscripciones de Kick */

test('suscribirEventos crea solo lo que falta', async () => {
  suscripciones = [{ id: 's1', event: 'chat.message.sent', version: 1 }];

  const r = await kick.suscribirEventos('token-kick', USUARIO, 'https://sala.example/kick/webhook');

  const creaciones = pedidosA('/events/subscriptions').filter(l => l.metodo === 'POST');
  assert.equal(creaciones.length, 1, 'tiene que crear la que falta');
  assert.deepEqual(creaciones[0].cuerpo.events, [{ name: 'livestream.status.updated', version: 1 }],
    'y solo la que falta: volver a crear la que ya esta seria duplicarla');
  assert.equal(creaciones[0].cuerpo.method, 'webhook');
  assert.equal(creaciones[0].cuerpo.broadcaster_user_id, Number(USUARIO));
  assert.equal(r.creadas.length, 1);
});

test('suscribirEventos no toca nada si ya estan las dos', async () => {
  suscripciones = kick.EVENTOS.map((e, i) => ({ id: `s${i}`, event: e.name, version: e.version }));

  const r = await kick.suscribirEventos('token-kick', USUARIO, '');

  assert.equal(pedidosA('/events/subscriptions').filter(l => l.metodo === 'POST').length, 0);
  assert.deepEqual(r.creadas, []);
});

/* ------------------------------------------ la verificacion de Kick */

test('sin vinculo con Kick no se pide nada y se dice que no esta vinculado', async () => {
  const r = await chat.verificarKick(CANAL);

  assert.deepEqual(r, { vinculado: false });
  assert.equal(chat.salud(CANAL).kick.vinculado, false);
  assert.equal(chat.salud(CANAL).kick.suscripcion, 'desconocida',
    'no se puede decir "activa" de algo que no se miro');
  assert.equal(llamadas.length, 0, 'y no se molesta a la API de Kick');
});

test('con las dos suscripciones puestas, la verificacion no resuscribe', async () => {
  await guardarVinculoKick();
  suscripciones = kick.EVENTOS.map((e, i) => ({ id: `s${i}`, event: e.name, version: e.version }));

  const r = await chat.verificarKick(CANAL);

  assert.deepEqual(r, { vinculado: true, resuscrito: false });
  assert.equal(chat.salud(CANAL).kick.suscripcion, 'activa');
  assert.equal(pedidosA('/events/subscriptions').filter(l => l.metodo === 'POST').length, 0);
});

test('si falta una suscripcion, la verificacion la vuelve a crear', async () => {
  /* EL CASO QUE IMPORTA: Kick borra o pierde una suscripcion y el chat
     se queda mudo. Si la verificacion no resuscribe pero igual dice
     "activa", la pantalla miente y nadie se entera hasta que alguien
     pregunta por que no escribe nadie. */
  await guardarVinculoKick();
  suscripciones = [];

  const r = await chat.verificarKick(CANAL);

  assert.deepEqual(r, { vinculado: true, resuscrito: true });
  const creaciones = pedidosA('/events/subscriptions').filter(l => l.metodo === 'POST');
  assert.equal(creaciones.length, 1, 'tiene que haber creado las suscripciones que faltaban');
  assert.deepEqual(creaciones[0].cuerpo.events, kick.EVENTOS);
  assert.equal(chat.salud(CANAL).kick.suscripcion, 'activa');
});

test('la version de una suscripcion se compara como numero, venga como venga', async () => {
  /* La API contesta JSON y el `version` podria llegar como "1" en vez
     de 1. Sin el `Number(...)`, `'1' === 1` da false, la verificacion
     cree que faltan las dos suscripciones y las vuelve a crear CADA
     CINCO MINUTOS, para siempre, contra la cuota de Kick. El fixture
     de los otros tests usa numeros, asi que ese caso no lo mira
     nadie. */
  await guardarVinculoKick();
  suscripciones = kick.EVENTOS.map((e, i) => ({ id: `s${i}`, event: e.name, version: String(e.version) }));

  const r = await chat.verificarKick(CANAL);

  assert.deepEqual(r, { vinculado: true, resuscrito: false },
    'estan las dos: no hay nada que volver a crear');
  assert.equal(pedidosA('/events/subscriptions').filter(l => l.metodo === 'POST').length, 0);
});

test('resuscribir a mano crea las suscripciones aunque parezca que esta todo bien', async () => {
  await guardarVinculoKick();
  suscripciones = kick.EVENTOS.map((e, i) => ({ id: `s${i}`, event: e.name, version: e.version }));

  const r = await chat.resuscribirKick(CANAL);

  assert.deepEqual(r, { ok: true });
  assert.equal(chat.salud(CANAL).kick.suscripcion, 'activa');
});

/* -------------------------------------------- el "esta en vivo" (D2) */

test('el "en vivo" sale de la API de Kick, no de haber recibido un webhook', async () => {
  /* Este es el caso que motiva el aviso entero: la URL del webhook no
     esta cargada en el portal de Kick, asi que NO LLEGA NI UN EVENTO.
     Si `vivo` dependiera del webhook `livestream.status.updated`,
     seria false para siempre y el aviso que existe para detectar
     justamente esto no podria aparecer nunca. */
  await guardarVinculoKick();
  enVivo = true;

  assert.equal(chat.salud(CANAL).kick.vivo, false, 'antes de preguntar no se sabe');

  await chat.verificarKick(CANAL);

  assert.equal(pedidosA('/channels').length, 1, 'tiene que preguntarle a la API');
  assert.equal(chat.salud(CANAL).kick.vivo, true);
  assert.equal(chat.salud(CANAL).kick.sospechoso, true,
    'en vivo y sin un solo mensaje en la vida: eso es exactamente lo que hay que avisar');
});

test('si la API dice que el canal se apago, el aviso se apaga', async () => {
  await guardarVinculoKick();

  /* El webhook llego cuando arranco el stream (la via rapida) */
  chat.recibirDeKick(CANAL, 
    { id: 'ev', tipo: 'livestream.status.updated', cuando: new Date().toISOString() },
    { is_live: true },
  );
  assert.equal(chat.salud(CANAL).kick.vivo, true);

  /* ...y despues el stream termino. Si el aviso dependiera solo del
     webhook y ese webhook se perdiera, la banda roja se quedaria
     puesta el resto de la noche. */
  enVivo = false;
  await chat.verificarKick(CANAL);

  assert.equal(chat.salud(CANAL).kick.vivo, false);
  assert.equal(chat.salud(CANAL).kick.sospechoso, false);
});

test('si la API no contesta, no se pisa lo que se sabia', async () => {
  /* Que Kick tenga un mal minuto no es "se apago el stream". */
  await guardarVinculoKick();
  chat.recibirDeKick(CANAL, 
    { id: 'ev', tipo: 'livestream.status.updated', cuando: new Date().toISOString() },
    { is_live: true },
  );

  falla = '/channels';
  await chat.verificarKick(CANAL);

  assert.equal(chat.salud(CANAL).kick.vivo, true, 'se queda con lo ultimo que sabia');
  assert.equal(chat.salud(CANAL).kick.suscripcion, 'activa', 'y la verificacion sigue su camino');
});

/* -------------------------------------------------------- arrancar */

test('al arrancar, si hay token de Twitch guardado, se reconecta solo', async () => {
  /* Un deploy no puede dejar el chat de Twitch apagado hasta que
     alguien entre al panel a tocar un boton. */
  await guardarVinculoKick();
  await guardarVinculoTwitch();
  suscripciones = kick.EVENTOS.map((e, i) => ({ id: `s${i}`, event: e.name, version: e.version }));

  await chat.arrancar({ base: 'https://sala.example' });

  assert.equal(eventSubs.length, 1, 'tiene que abrir la conexion EventSub sola');
  assert.equal(eventSubs[0].conectada, true);
  assert.equal(chat.salud(CANAL).twitch.vinculado, true);
  assert.equal(chat.salud(CANAL).kick.suscripcion, 'activa', 'y de paso verifica Kick');

  chat.parar();
});

test('sin vinculo de Twitch, arrancar no abre ninguna conexion y el servidor sigue arriba', async () => {
  await guardarVinculoKick();

  await chat.arrancar({ base: 'https://sala.example' });

  assert.equal(eventSubs.length, 0);
  assert.equal(chat.salud(CANAL).twitch.vinculado, false);
  assert.equal(chat.salud(CANAL).twitch.estado, 'cortado');

  chat.parar();
});

test('la verificacion se repite cada cinco minutos, y arrancar dos veces no la duplica', async (t) => {
  /* El intervalo es lo unico que hace que una suscripcion perdida se
     recupere sola. Y `arrancar` llamado dos veces pisaba
     `timerVerificacion`: el intervalo viejo quedaba corriendo para
     siempre, sin nadie que pudiera apagarlo. */
  assert.equal(chat.CADA_VERIFICACION, 5 * 60 * 1000);

  await guardarVinculoKick();
  suscripciones = kick.EVENTOS.map((e, i) => ({ id: `s${i}`, event: e.name, version: e.version }));

  t.mock.timers.enable({ apis: ['setInterval'] });

  await chat.arrancar({ base: 'https://sala.example' });
  await chat.arrancar({ base: 'https://sala.example' });

  const antes = pedidosA('/events/subscriptions').length;
  t.mock.timers.tick(chat.CADA_VERIFICACION);
  await esperar(0);
  await esperar(0);

  const despues = pedidosA('/events/subscriptions').length;
  assert.equal(despues - antes, 1,
    `paso una verificacion por tick y no ${despues - antes}: hay un setInterval de mas corriendo`);

  chat.parar();
  t.mock.timers.tick(chat.CADA_VERIFICACION);
  await esperar(0);
  assert.equal(pedidosA('/events/subscriptions').length, despues,
    'y despues de parar no queda ninguno vivo');
});

/* ------------------------------------- la salud tampoco sale por aca */

test('nada de todo esto difunde la salud por el bus publico', async () => {
  const oyente = escuchar(CANAL);
  await guardarVinculoKick();
  await guardarVinculoTwitch();
  enVivo = true;

  await chat.arrancar({ base: 'https://sala.example' });
  chat.salud(CANAL);
  chat.parar();

  assert.deepEqual([...new Set(oyente.tipos())], ['estado'],
    'el arranque no publica el estado de las cuentas del dueño en un bus que es publico');
  oyente.cerrar();
});

/* ------------------------------------------- el tope de conexiones

   Va al final del archivo A PROPOSITO: deja vinculos de Twitch de
   otras salas guardados, y `chat.arrancar()` levanta la conexion de
   TODAS las salas vinculadas, asi que correr esto antes le sumaria
   conexiones a los dos tests de arranque. Se limpia igual en el
   `finally`; el orden es el cinturon. */

test('el tope de conexiones de Twitch frena la que sobra, y dice que fue el tope', async () => {
  /* La guarda sobrevivia la suite entera: sacarla no rompia nada.

     No es una optimizacion, es lo que separa "este servidor llego a su
     tope" de "Twitch esta cortado". Una conexion EventSub por creador
     es legal (el limite de Twitch es por par client id / user id), lo
     que no aguanta 900 es este contenedor: 900 sockets, 900 timers de
     keepalive y 900 buffers. Sin el tope, el creador numero 900 no ve
     un aviso: ve el servicio entero degradandose de a poco. Y sin el
     campo `tope` en la salud, su panel diria "cortado", que es
     exactamente lo que diria si el problema fuera de Twitch. */
  assert.equal(chat.TOPE_TWITCH, 2, 'este archivo corre con un tope chico, puesto en la cabecera');

  const salas = ['unasala', 'otrasala', 'lasobrante'];
  try {
    for (const s of salas) await guardarVinculoTwitch(s);

    assert.deepEqual(await chat.conectarTwitch(salas[0]), { vinculado: true });
    assert.deepEqual(await chat.conectarTwitch(salas[1]), { vinculado: true });
    assert.equal(eventSubs.length, 2, 'las dos primeras entran');

    const sobrante = await chat.conectarTwitch(salas[2]);
    assert.deepEqual(sobrante, { vinculado: true, tope: true },
      'la tercera no puede abrir conexion: ya hay dos');
    assert.equal(eventSubs.length, 2, 'y sobre todo: NO se abrio una tercera conexion');

    /* Lo que ve el creador en su panel. `vinculado` sigue en true —su
       cuenta esta bien— y `tope` dice que el que no da mas es este
       proceso. */
    const salud = chat.salud(salas[2]).twitch;
    assert.equal(salud.vinculado, true);
    assert.equal(salud.tope, true, 'sin esto el panel dice "cortado" y nadie sabe por que');
    assert.equal(salud.estado, 'cortado');

    /* CONTROL, a proposito: sin esto, "no conectar nunca a nadie"
       pasaria todo lo de arriba. Reconectar una sala que YA tenia
       conexion no suma ninguna, asi que tiene que poder hacerse
       aunque estemos en el tope: es lo que pasa cada vez que a un
       creador que ya estaba se le refresca el token. */
    assert.deepEqual(await chat.conectarTwitch(salas[0]), { vinculado: true },
      'reconectar a una que ya estaba no puede chocar contra el tope');
    assert.equal(eventSubs.length, 3, 'se abrio la conexion nueva de la que ya estaba');
    assert.equal(chat.salud(salas[0]).twitch.tope, false);
  } finally {
    for (const s of salas) await vinculos.olvidar(s, 'twitch');
  }
});
