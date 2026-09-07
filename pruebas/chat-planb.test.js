/* ============================================================
   El plan B, ORQUESTADO. No la clase de IRC (eso esta en
   irc.test.js), sino la decision de chat.js: cuando se prende,
   cuando se apaga, y que pasa cuando el estado de EventSub cambia
   dos veces seguidas.

   Es la parte del entregable 6 que vive en chat.js, y es donde
   estaba el unico bug de verdad de la fase: dos conexiones IRC
   abiertas y una imposible de cerrar.

   ---------------------------------------------------------------
   COMO SE PRUEBA SIN SALIR A INTERNET NI ESPERAR LOS BACKOFF

   `chat.fijarConexiones` cambia con que se abren las dos conexiones
   de Twitch:

     - EventSub por un doble, porque lo que hay que provocar es un
       cambio de estado con N fallos acumulados, y llegar al cuarto
       fallo de verdad son mas de quince segundos de backoff.
     - IRC por la clase DE VERDAD con un `abrirSocket` de mentira,
       que es la costura que la propia clase ya tiene. Asi lo que se
       cuenta son conexiones reales abiertas y cerradas, no llamadas
       a un metodo de un doble.
   ============================================================ */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const DATOS = await fsp.mkdtemp(path.join(os.tmpdir(), 'sala-planb-'));
process.env.SALA_DATOS = DATOS;
process.env.CLAVE_CIFRADO = crypto.randomBytes(32).toString('base64');

const chat = await import('../servidor/chat.js');
const canales = await import('../servidor/canales.js');
const mensajes = await import('../servidor/mensajes.js');
const vinculos = await import('../servidor/vinculos.js');
const { ConexionIrc } = await import('../servidor/irc.js');
const { escuchar } = await import('./fijos/bus-falso.js');

const CANAL = 'istincho';
const esperar = ms => new Promise(ok => setTimeout(ok, ms));

/* Un rato: lo que tarda en resolverse el `await vinculos.leer` que
   parte el prendido del plan B en dos. Con leer el archivo del
   almacen alcanza y sobra. */
const asentarse = () => esperar(60);

/* ------------------------------------------------------- los dobles */

/** El doble de EventSub: deja provocar estados y contar fallos. */
class EventSubFalso {
  constructor(opciones) {
    this.opciones = opciones;
    this.estado = 'cortado';
    this.intentosFallidosSeguidos = 0;
    this.ultimaLlegada = null;
    this.conectada = false;
    this.cerrada = false;
  }

  conectar() { this.conectada = true; }
  cerrar() { this.cerrada = true; this.estado = 'cortado'; }

  /** Twitch avisa un cambio de estado, como lo haria la clase real. */
  avisar(nuevo, fallos) {
    if (fallos !== undefined) this.intentosFallidosSeguidos = fallos;
    this.estado = nuevo;
    this.opciones.alEstado(nuevo);
  }
}

/**
 * Un socket de mentira para la ConexionIrc de verdad: se conecta en
 * el tick siguiente, guarda lo que se le escribe y avisa cuando lo
 * destruyen. Que un socket quede sin destruir ES el bug que se
 * busca.
 */
function socketFalso(registro) {
  const s = new EventEmitter();
  s.escrito = [];
  s.destruido = false;
  s.setEncoding = () => {};
  s.write = linea => { s.escrito.push(String(linea)); return true; };
  s.destroy = () => {
    if (s.destruido) return;
    s.destruido = true;
    s.emit('close');
  };
  registro.push(s);
  setImmediate(() => { if (!s.destruido) s.emit('connect'); });
  return s;
}

/**
 * Deja el modulo listo con los dos dobles puestos y el vinculo de
 * Twitch guardado, y devuelve con que mirar lo que pasa.
 */
async function preparar() {
  chat.reiniciar();
  canales.cerrarTodo();
  canales.canal(CANAL);

  await vinculos.guardar(CANAL, 'twitch', {
    usuarioId: '777',
    nombre: 'IsTincho',
    login: CANAL,
    accessToken: 'token-de-prueba',
    refreshToken: 'refresco-de-prueba',
    venceEn: Date.now() + 3600_000,
    scopes: 'user:read:chat user:write:chat',
  });

  const eventSubs = [];
  const ircs = [];
  const sockets = [];

  chat.fijarConexiones({
    eventSub: opciones => {
      const c = new EventSubFalso(opciones);
      eventSubs.push(c);
      return c;
    },
    irc: opciones => {
      const c = new ConexionIrc({ ...opciones, abrirSocket: () => socketFalso(sockets) });
      ircs.push(c);
      return c;
    },
  });

  await chat.conectarTwitch(CANAL);
  assert.equal(eventSubs.length, 1, 'conectarTwitch tiene que abrir EventSub');

  return { eventSubs, ircs, sockets, twitch: eventSubs[0] };
}

test.afterEach(() => { chat.reiniciar(); canales.cerrarTodo(); });

test.after(async () => {
  chat.parar();
  canales.cerrarTodo();
  await fsp.rm(DATOS, { recursive: true, force: true });
});

/* ------------------------------------------------------ el umbral */

test('con tres fallos seguidos el plan B no se prende', async () => {
  /* Tres y no uno: una reconexion suelta es normal (Twitch recicla
     sus servidores) y prender el IRC por eso seria tener dos
     conexiones abiertas todo el tiempo. */
  const { twitch, sockets } = await preparar();

  twitch.avisar('reconectando', 3);
  await asentarse();

  assert.equal(sockets.length, 0, 'ni una conexion de IRC');
  assert.equal(chat.salud(CANAL).twitch.modo, 'eventsub');
});

test('pasados los tres fallos se prende el IRC anonimo y se ve en la salud', async () => {
  const { twitch, sockets } = await preparar();

  twitch.avisar('reconectando', 4);
  await asentarse();

  assert.equal(sockets.length, 1, 'una conexion de IRC, y una sola');
  assert.equal(chat.salud(CANAL).twitch.modo, 'irc',
    'si el chat viene por el plan B tiene que verse en pantalla');

  /* Sigue siendo de solo lectura: un justinfan no puede hablar. */
  const handshake = sockets[0].escrito.join('');
  assert.match(handshake, /NICK justinfan\d+/);
  assert.match(handshake, new RegExp(`JOIN #${CANAL}`));
  assert.ok(!handshake.includes('PRIVMSG'), 'el plan B no escribe nunca');
});

/* --------------------------------------------------------- la carrera */

test('dos cambios de estado seguidos no abren dos conexiones IRC', async () => {
  /* EL BUG. `prenderPlanB` chequeaba `if (conexionIrc) return` y
     recien despues del `await vinculos.leer` reservaba el lugar.
     `revisarPlanB` sale de CADA cambio de estado, y los estados
     vienen de a pares sin ceder el control (el corte y el
     "conectando" del reintento): los dos pasaban la guarda, se
     creaban dos ConexionIrc, y la primera quedaba conectada a
     irc.chat.twitch.tv para siempre. Ni apagarPlanB ni parar la
     alcanzaban —las dos cierran `conexionIrc`, que ya era la
     segunda— y encima reconectaba sola con su propio backoff. */
  const { twitch, sockets } = await preparar();

  twitch.intentosFallidosSeguidos = 9;
  twitch.avisar('cortado');
  twitch.avisar('conectando');
  await asentarse();

  assert.equal(sockets.length, 1,
    `se abrieron ${sockets.length} conexiones IRC: cada una de mas queda hablando con Twitch sola`);

  chat.parar();
  assert.deepEqual(sockets.map(s => s.destruido), [true],
    'y las que haya tienen que poder cerrarse todas');
});

test('un prendido a medio camino no abre nada si EventSub vuelve mientras tanto', async () => {
  /* La otra mitad de lo mismo: entre el pedido y la apertura hay un
     await. Si EventSub se recupera justo ahi, abrir igual dejaria un
     IRC prendido que ya nadie pidio y que `apagarPlanB` no vio
     porque todavia no existia. */
  const { twitch, sockets } = await preparar();

  twitch.avisar('reconectando', 7);   // pide el plan B, todavia no lo abrio
  twitch.avisar('conectado');         // EventSub vuelve en el mismo turno
  await asentarse();

  assert.equal(sockets.length, 0, 'no se abrio ningun IRC');
  assert.equal(chat.salud(CANAL).twitch.modo, 'eventsub');
});

test('un pedido que llega con otro en vuelo no se pierde aunque en el medio se haya apagado', async () => {
  /* La coalescencia mal hecha: `prenderPlanB` devolvia la promesa del
     prendido en curso SIN volver a levantar la bandera. Si entre el
     primer pedido y el tercero hubo un `apagarPlanB()`, esa promesa
     vieja despierta con el pedido cancelado y aborta; como el tercer
     pedido se colgo de ella, no queda nadie que abra el IRC y el
     canal se queda sin plan B hasta el cambio de estado siguiente.

     Que hoy sea casi inalcanzable depende de que `ConexionEventSub`
     ponga `intentosFallidosSeguidos = 0` ANTES de avisar `conectado`,
     o sea del mismo acoplamiento que la guarda de `revisarPlanB`
     quiso dejar de usar. Por eso el doble avisa `conectado` con los
     fallos todavia arriba: es el estado que la clase podria dejar el
     dia que ese orden cambie. */
  const { twitch, sockets } = await preparar();

  twitch.avisar('cortado', 9);      // pide el plan B; queda esperando el vinculo
  twitch.avisar('conectado', 9);    // EventSub vuelve: se cancela el pedido
  twitch.avisar('cortado', 9);      // y se vuelve a caer, todo en el mismo turno
  await asentarse();

  assert.equal(sockets.length, 1,
    'el ultimo pedido se colgo del prendido en vuelo y se perdio: el chat de Twitch queda mudo');
  assert.equal(chat.salud(CANAL).twitch.modo, 'irc');
});

/* --------------------------------------------------------- el apagado */

test('cuando EventSub vuelve, el IRC se apaga', async () => {
  const { twitch, sockets } = await preparar();

  twitch.avisar('reconectando', 4);
  await asentarse();
  assert.equal(sockets.length, 1);

  twitch.avisar('conectado');
  await asentarse();

  assert.equal(sockets[0].destruido, true, 'el socket del plan B tiene que cerrarse');
  assert.equal(chat.salud(CANAL).twitch.modo, 'eventsub',
    'y la salud tiene que dejar de decir que el chat viene por IRC');
});

test('parar() cierra el IRC, no solo EventSub', async () => {
  /* Un apagado que deja el plan B prendido deja una conexion a
     Twitch viva despues de que el servidor se dio por apagado, con
     su propia reconexion. */
  const { twitch, sockets } = await preparar();

  twitch.avisar('reconectando', 4);
  await asentarse();
  assert.equal(sockets.length, 1);

  chat.parar();

  assert.equal(sockets[0].destruido, true, 'el socket de IRC tiene que quedar cerrado');
  assert.equal(twitch.cerrada, true, 'y el de EventSub tambien');
});

test('parar() en medio de un prendido no deja un IRC abierto despues', async () => {
  /* La otra mitad del arreglo de la carrera, y la que no tenia test:
     `parar()` baja `planBPedido`. Sin esa linea, un prendido que
     estaba esperando el vinculo despierta despues del apagado, no ve
     ninguna conexion abierta y abre una. Queda un socket contra
     irc.chat.twitch.tv, con su propio backoff, en un modulo que ya se
     dio por apagado y cuyo `conexionIrc` nadie va a volver a mirar. */
  const { twitch, sockets } = await preparar();

  twitch.avisar('reconectando', 4);   // pide el plan B, todavia no lo abrio
  chat.parar();                       // se apaga todo antes de que llegue el vinculo
  await asentarse();

  assert.equal(sockets.length, 0,
    `parar() dejo ${sockets.length} conexion(es) de IRC vivas y sin dueño`);
});

test('mientras el plan B esta prendido, sus mensajes entran por el mismo camino', async () => {
  const { twitch, sockets } = await preparar();

  twitch.avisar('reconectando', 4);
  await asentarse();

  sockets[0].emit('data',
    '@id=abc123;display-name=Fulana;color=#9146FF :fulana!fulana@fulana.tmi.twitch.tv ' +
    `PRIVMSG #${CANAL} :hola por el plan B\r\n`);

  const ultimos = canales.ultimos(CANAL);
  assert.equal(ultimos.length, 1);
  assert.equal(ultimos[0].red, 'twitch');
  assert.equal(ultimos[0].texto, 'hola por el plan B');

  /* Y el dedupe con EventSub sigue valiendo: el mismo id por la otra
     via no se muestra dos veces. */
  chat.recibirDeTwitch(CANAL, mensajes.deTwitch({
    message_id: 'abc123',
    chatter_user_name: 'Fulana',
    color: '#9146FF',
    badges: [],
    message: { text: 'hola por el plan B', fragments: [{ type: 'text', text: 'hola por el plan B' }] },
  }, { message_timestamp: new Date().toISOString() }));
  assert.equal(canales.ultimos(CANAL).length, 1, 'el mismo mensaje una sola vez');
});

/* ----------------------------------------------- la salud no sale al bus */

test('la salud no viaja por el bus publico, pase lo que pase con las conexiones', async () => {
  /* Decision de la fase: el bus de un canal es publico y la salud
     dice que redes tiene vinculadas el dueño, en que modo esta su
     conexion y si su canal esta en vivo. Se pide contra
     /api/chat/salud, que exige la cookie.

     Esta asercion existe para que una fase futura no la vuelva a
     difundir "porque es comodo": se recorre todo lo que cambia la
     salud y se mira lo que salio por el cable. */
  const { twitch, sockets } = await preparar();
  const oyente = escuchar(CANAL);

  twitch.avisar('reconectando', 4);       // se prende el plan B
  await asentarse();
  sockets[0].emit('data',
    `@id=zzz;display-name=Alguien :a!a@a.tmi.twitch.tv PRIVMSG #${CANAL} :hola\r\n`);
  twitch.avisar('conectado');             // vuelve EventSub y se apaga el plan B
  await asentarse();
  chat.recibirDeKick(CANAL, 
    { id: 'ev', tipo: 'livestream.status.updated', cuando: new Date().toISOString() },
    { is_live: true },
  );
  chat.salud(CANAL);

  const tipos = oyente.tipos();
  assert.ok(tipos.length > 0, 'algo tiene que haber salido, si no el test no prueba nada');
  assert.ok(!tipos.includes('salud'),
    `por el bus salio la salud: ${tipos.join(', ')}`);
  assert.deepEqual([...new Set(tipos)].sort(), ['chat', 'estado'],
    'por el bus publico solo viaja el chat y el estado del canal');

  oyente.cerrar();
});
