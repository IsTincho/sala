/* ============================================================
   Pruebas de servidor/canales.js.

   El canal es memoria pura, asi que no hace falta levantar un servidor:
   alcanza con un req y un res de mentira que se comporten como los de
   node en lo poco que canales.js les pide (writeHead, write, end, y los
   eventos 'close' y 'error' del pedido).

   Lo que se prueba aca es lo que no se ve desde afuera: que un canal
   que se fue no se lleve puesto al que llego despues, que el buffer no
   crezca sin techo, y que nada de lo que se difunde pueda romper la
   trama SSE.
   ============================================================ */

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import * as canales from '../servidor/canales.js';

class ResFalsa {
  constructor() { this.escrito = ''; this.terminada = false; this.cabeceras = null; }
  writeHead(codigo, cabeceras) { this.codigo = codigo; this.cabeceras = cabeceras; return this; }
  write(s) {
    if (this.terminada) throw new Error('la respuesta ya se cerro');
    this.escrito += s;
    return true;
  }
  end() { this.terminada = true; }

  /** Los bloques SSE recibidos, ya parseados. */
  get eventos() {
    return this.escrito.split('\n\n').filter(b => b.includes('data:')).map(bloque => {
      const campos = { data: [] };
      for (const linea of bloque.split('\n')) {
        const i = linea.indexOf(':');
        if (i < 0) continue;
        const campo = linea.slice(0, i);
        const valor = linea.slice(i + 1).replace(/^ /, '');
        if (campo === 'data') campos.data.push(valor);
        else campos[campo] = valor;
      }
      return campos;
    });
  }

  /** El data de cada evento, ya como objeto. */
  get datos() { return this.eventos.map(e => JSON.parse(e.data.join('\n'))); }
}

/** Engancha un cliente nuevo a un canal y devuelve { req, res }. */
function conectar(slug, opciones) {
  const req = new EventEmitter();
  const res = new ResFalsa();
  canales.suscribir(slug, req, res, opciones);
  return { req, res };
}

afterEach(() => canales.cerrarTodo());

/* ------------------------------------------------------------ basico */

test('el que se conecta recibe primero el estado, con el tipo adentro del data', () => {
  const { res } = conectar('unslug');

  assert.equal(res.codigo, 200);
  assert.match(res.cabeceras['Content-Type'], /text\/event-stream/);

  const [estado] = res.datos;
  assert.equal(estado.tipo, 'estado');
  assert.equal(estado.slug, 'unslug');
  assert.equal(estado.conectados, 1);

  /* El tipo NO puede ir como `event: <tipo>`: por la especificacion de
     SSE, un evento con nombre solo llega al listener de ese nombre y
     nunca dispara 'message', asi que el cliente no puede recibir un
     tipo que todavia no conocia. */
  assert.equal(res.eventos[0].event, undefined);
});

test('difundir llega a todos los conectados y cuenta cuantos', () => {
  const a = conectar('canal');
  const b = conectar('canal');

  const llegaron = canales.difundir('canal', { tipo: 'kick', texto: 'hola' });
  assert.equal(llegaron, 2);

  for (const c of [a, b]) {
    const ultimo = c.res.datos.at(-1);
    assert.equal(ultimo.tipo, 'kick');
    assert.equal(ultimo.texto, 'hola');
  }
});

test('difundir a un canal que no existe no crea nada', () => {
  assert.equal(canales.difundir('nadie-mira-esto', { tipo: 'kick' }), 0);
  assert.equal(canales.hayCanal('nadie-mira-esto'), false);
});

/* --------------------------------------------- el canal de otro

   EL BUG: `soltar` borraba del Map por slug, sin mirar si el Map
   seguia apuntando al mismo canal. Se registra en 'close' Y en
   'error', y el 'error' puede llegar tarde: para entonces el slug ya
   podia ser de otra persona. */

test('un error tardio del que se fue no borra el canal del que llego despues', () => {
  const primero = conectar('mismo-slug');
  primero.req.emit('close');                 // se va: el canal queda vacio y se borra
  assert.equal(canales.hayCanal('mismo-slug'), false);

  const segundo = conectar('mismo-slug');    // entra otro con el mismo slug
  assert.equal(canales.conectados('mismo-slug'), 1);

  primero.req.emit('error');                 // ...y recien ahora el error del primero

  assert.equal(canales.conectados('mismo-slug'), 1, 'el segundo sigue conectado');
  assert.equal(canales.difundir('mismo-slug', { tipo: 'kick', texto: 'sigo aca' }), 1,
    'el que quedo tiene que seguir recibiendo eventos');
  assert.equal(segundo.res.datos.at(-1).texto, 'sigo aca');
});

test('soltar es idempotente: close y error del mismo cliente no descuentan dos veces', () => {
  const a = conectar('doble');
  conectar('doble');
  assert.equal(canales.conectados('doble'), 2);

  a.req.emit('close');
  a.req.emit('error');
  a.req.emit('close');

  assert.equal(canales.conectados('doble'), 1);
});

/* --------------------------------------------------------- inyeccion */

test('un tipo con saltos de linea no puede inventar campos SSE', () => {
  /* Hoy todos los tipos son literales del codigo, pero en la Fase 1 el
     tipo va a salir de payloads de webhook. Un \n adentro abriria
     campos SSE arbitrarios en todos los navegadores conectados. */
  const { res } = conectar('inyeccion');
  const antes = res.eventos.length;

  canales.difundir('inyeccion', {
    tipo: 'chat\nevent: estado\ndata: {"soy":"otro"}',
    texto: 'hola',
  });

  const nuevos = res.eventos.slice(antes);
  assert.equal(nuevos.length, 1, 'un difundir es un solo evento, pase lo que pase');
  assert.equal(nuevos[0].data.length, 1, 'y un solo campo data');
  assert.equal(nuevos[0].event, undefined, 'no se pudo inventar un event');

  const datos = JSON.parse(nuevos[0].data[0]);
  assert.equal(datos.tipo, 'mensaje', 'el tipo que no sirve se reemplaza por uno generico');
  assert.equal(datos.texto, 'hola', 'el resto del evento llega igual');
});

test('los tipos normales pasan tal cual', () => {
  for (const bueno of ['chat', 'reloj', 'kick', 'chat.message.sent', 'prueba']) {
    assert.equal(canales.tipoSeguro(bueno), bueno);
  }
  for (const malo of ['', ' ', '1chat', 'chat mensaje', 'chat\n', null, 42, 'a'.repeat(41)]) {
    assert.equal(canales.tipoSeguro(malo), 'mensaje', `${JSON.stringify(malo)} no sirve como tipo`);
  }
});

/* ------------------------------------------------------- recordar */

test('recordar guarda el mensaje, lo difunde, y se lo cuenta al que llega tarde', () => {
  const temprano = conectar('memoria');
  canales.recordar('memoria', { tipo: 'chat', texto: 'primero' });
  canales.recordar('memoria', { tipo: 'chat', texto: 'segundo' });

  assert.deepEqual(canales.ultimos('memoria').map(m => m.texto), ['primero', 'segundo']);
  assert.deepEqual(temprano.res.datos.slice(1).map(m => m.texto), ['primero', 'segundo']);

  /* El que se conecta despues recibe el estado y despues lo que se
     perdio, en orden. */
  const tarde = conectar('memoria');
  assert.deepEqual(tarde.res.datos.map(m => m.tipo), ['estado', 'chat', 'chat']);
  assert.deepEqual(tarde.res.datos.slice(1).map(m => m.texto), ['primero', 'segundo']);
});

test('el buffer se queda en 200 mensajes y conserva los ultimos', () => {
  for (let i = 0; i < 250; i++) canales.recordar('tope', { tipo: 'chat', n: i });

  const guardados = canales.ultimos('tope');
  assert.equal(guardados.length, 200);
  assert.equal(guardados[0].n, 50, 'se tiraron los mas viejos');
  assert.equal(guardados.at(-1).n, 249);
});

test('un canal con mensajes guardados no se borra cuando se va el ultimo', () => {
  const { req } = conectar('con-historia');
  canales.recordar('con-historia', { tipo: 'chat', texto: 'algo' });
  req.emit('close');
  assert.equal(canales.hayCanal('con-historia'), true);
  assert.equal(canales.conectados('con-historia'), 0);
});

/* ---------------------------------------------------------- reloj */

test('ponerReloj difunde el reloj, lo deja puesto y lo muestra en el resumen', () => {
  const { req, res } = conectar('sala');

  const llegaron = canales.ponerReloj('sala', { videoId: 'ep3', empezoEn: 1000, pausadoEn: null });
  assert.equal(llegaron, 1);

  const evento = res.datos.at(-1);
  assert.equal(evento.tipo, 'reloj');
  assert.equal(evento.videoId, 'ep3');
  assert.equal(evento.empezoEn, 1000);

  /* Y el que llegue despues lo recibe en el estado inicial. */
  const nuevo = conectar('sala');
  assert.equal(nuevo.res.datos[0].reloj.videoId, 'ep3');

  /* En el resumen va un booleano y NO el reloj: `/api/estado` es
     público y sin sesión, así que mandar el objeto entero publicaba el
     título y el segundo de la película de todos los canales a
     cualquiera. El booleano se queda porque explica por qué un canal
     con cero conectados sigue en la lista (ver `soltarSiVacio`). */
  const enResumen = canales.resumen().find(c => c.slug === 'sala');
  assert.equal(enResumen.conReloj, true);
  assert.equal(enResumen.conectados, 2);

  const crudo = JSON.stringify(canales.resumen());
  assert.ok(!crudo.includes('ep3'),
    `el resumen público nombra la película: ${crudo}`);

  /* Un canal con reloj puesto es estado real: no se borra aunque no
     quede nadie mirando. */
  req.emit('close');
  nuevo.req.emit('close');
  assert.equal(canales.hayCanal('sala'), true);
});

test('un cliente que ya no acepta escrituras se saca solo', () => {
  const { res } = conectar('roto');
  conectar('roto');
  res.terminada = true;   // como una respuesta ya cerrada por el socket

  assert.equal(canales.difundir('roto', { tipo: 'chat' }), 1, 'solo llega al que sigue vivo');
  assert.equal(canales.conectados('roto'), 1);
});

/* ------------------------------------------------ el filtro por red

   LA DECISION DE LA FASE 2. Por el canal del dueño viaja tambien su
   chat de Twitch, porque /chat las muestra juntas. Pero
   `/eventos/:slug` no pide sesion y desde la Sala lo escucha cualquiera
   que este mirando la peli.

   Se filtra ACA, por conexion, y no en el navegador: filtrando en el
   navegador el chat de Twitch igual saldria por el cable hacia
   trescientas pestañas y un `curl` lo veria entero. Quien decide que
   redes pide cada conexion es la ruta (`index.js`), no este modulo. */

test('sin filtro llega todo, que es lo que pide /chat', () => {
  const { res } = conectar('sin-filtro');
  canales.difundir('sin-filtro', { tipo: 'chat', red: 'kick', texto: 'de kick' });
  canales.difundir('sin-filtro', { tipo: 'chat', red: 'twitch', texto: 'de twitch' });

  assert.deepEqual(res.datos.slice(1).map(m => m.texto), ['de kick', 'de twitch']);
});

test('con redes: ["kick"] el chat de Twitch no sale por el cable', () => {
  const { res } = conectar('solo-kick', { redes: ['kick'] });
  canales.difundir('solo-kick', { tipo: 'chat', red: 'twitch', texto: 'de twitch' });
  canales.difundir('solo-kick', { tipo: 'chat', red: 'kick', texto: 'de kick' });

  const textos = res.datos.slice(1).map(m => m.texto);
  assert.deepEqual(textos, ['de kick']);
  /* No alcanza con que el cliente no lo muestre: no tiene que estar
     escrito en el stream. */
  assert.ok(!res.escrito.includes('de twitch'), 'el mensaje viajo igual');
});

test('lo que no es de ninguna red pasa siempre', () => {
  /* El estado, el reloj y la presencia no llevan `red`: son del canal,
     no de una plataforma. Un filtro que los tirara dejaria a la Sala
     sin saber en que segundo va la peli. */
  const { res } = conectar('sin-red', { redes: ['kick'] });
  canales.ponerReloj('sin-red', { estado: 'reproduciendo', videoId: 'ep1' });
  canales.difundir('sin-red', { tipo: 'presencia', conectados: 3 });

  const tipos = res.datos.map(m => m.tipo);
  assert.deepEqual(tipos, ['estado', 'reloj', 'presencia']);
});

test('difundir cuenta solo a los que de verdad lo recibieron', () => {
  const todos = conectar('mixto');
  const soloKick = conectar('mixto', { redes: ['kick'] });

  assert.equal(canales.difundir('mixto', { tipo: 'chat', red: 'twitch', texto: 'x' }), 1,
    'el que filtra Twitch no cuenta como que le llego');
  assert.equal(canales.difundir('mixto', { tipo: 'chat', red: 'kick', texto: 'y' }), 2);

  assert.deepEqual(todos.res.datos.slice(1).map(m => m.texto), ['x', 'y']);
  assert.deepEqual(soloKick.res.datos.slice(1).map(m => m.texto), ['y']);
});

test('el buffer que recibe el que llega tarde tambien viene filtrado', () => {
  /* Sin esto, una sala que no recibe Twitch en vivo se comeria igual
     los ultimos 200 mensajes de Twitch al conectarse: la mitad del
     problema, y la mas visible. */
  canales.recordar('tarde-filtrado', { tipo: 'chat', red: 'twitch', texto: 'viejo de twitch' });
  canales.recordar('tarde-filtrado', { tipo: 'chat', red: 'kick', texto: 'viejo de kick' });

  const { res } = conectar('tarde-filtrado', { redes: ['kick'] });
  assert.deepEqual(res.datos.slice(1).map(m => m.texto), ['viejo de kick']);
});

test('el filtro es de cada conexion y no se puede cambiar desde afuera', () => {
  /* La lista se copia al suscribir: si se guardara la referencia, quien
     llamo podria abrirle el bus entero a una conexion ya conectada
     empujando un elemento al array. */
  const redes = ['kick'];
  const { res } = conectar('inmutable', { redes });
  redes.push('twitch');

  canales.difundir('inmutable', { tipo: 'chat', red: 'twitch', texto: 'colado' });
  assert.equal(res.datos.slice(1).length, 0);
});

test('un filtro que es una funcion se pregunta en cada evento, no al conectar', () => {
  /* EL CHAT ABIERTO (Fase 5.1). El creador puede cerrarlo, o sacarle
     Twitch, con gente conectada. Con una lista fija al conectar, esa
     gente seguiria recibiendo Twitch hasta cerrar la pestaña: el corte
     solo valdria para el que llega despues. Con una funcion, el
     proximo mensaje ya pasa por la regla nueva. */
  let abiertas = ['kick', 'twitch'];
  const { res } = conectar('en-vivo', { redes: () => abiertas });

  canales.difundir('en-vivo', { tipo: 'chat', red: 'twitch', texto: 'con el chat abierto' });
  abiertas = ['kick'];
  canales.difundir('en-vivo', { tipo: 'chat', red: 'twitch', texto: 'despues de cerrar' });
  canales.difundir('en-vivo', { tipo: 'chat', red: 'kick', texto: 'kick sigue' });
  abiertas = ['kick', 'twitch'];
  canales.difundir('en-vivo', { tipo: 'chat', red: 'twitch', texto: 'reabierto' });

  assert.deepEqual(res.datos.slice(1).map(m => m.texto),
    ['con el chat abierto', 'kick sigue', 'reabierto']);
  assert.ok(!res.escrito.includes('despues de cerrar'), 'el mensaje viajo igual');
});

test('el buffer del que llega tambien pasa por la funcion', () => {
  canales.recordar('funcion-tarde', { tipo: 'chat', red: 'twitch', texto: 'viejo de twitch' });
  canales.recordar('funcion-tarde', { tipo: 'chat', red: 'kick', texto: 'viejo de kick' });

  const { res } = conectar('funcion-tarde', { redes: () => ['kick'] });
  assert.deepEqual(res.datos.slice(1).map(m => m.texto), ['viejo de kick']);
});
