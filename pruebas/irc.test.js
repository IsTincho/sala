/* ============================================================
   El plan B: el cliente de IRC anonimo de Twitch.

   Se prueba contra un servidor IRC de mentira levantado con
   `node:net` en un puerto libre, y no contra Twitch: un test que
   necesita internet no es un test, es una consulta.

   Lo que se verifica es lo que rompe de verdad en un protocolo de
   texto sobre TCP:
     - que el handshake anonimo mande lo que tiene que mandar,
     - que el PONG lleve EL MISMO texto del PING (si no, Twitch corta
       la conexion a los cinco minutos y nadie entiende por que),
     - que una linea partida entre dos paquetes TCP no se pierda,
     - que se reconecte solo cuando el servidor corta.
   ============================================================ */

import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

import { ConexionIrc, parsearLinea, desescaparTag } from '../servidor/irc.js';

const esperar = ms => new Promise(ok => setTimeout(ok, ms));

async function esperarHasta(condicion, { tope = 3000, paso = 20 } = {}) {
  const limite = Date.now() + tope;
  while (!condicion()) {
    if (Date.now() > limite) throw new Error('tiempo de espera agotado');
    await esperar(paso);
  }
}

/**
 * Un servidor IRC de mentira. Guarda todo lo que le mandan, linea por
 * linea, y deja escribirle al cliente conectado.
 */
async function servidorFalso() {
  const conexiones = [];
  const recibido = [];
  let cuantas = 0;

  const servidor = net.createServer(socket => {
    cuantas++;
    conexiones.push(socket);
    let resto = '';
    socket.setEncoding('utf8');
    socket.on('data', trozo => {
      resto += trozo;
      const lineas = resto.split('\r\n');
      resto = lineas.pop();
      for (const l of lineas) recibido.push(l);
    });
    socket.on('error', () => {});
  });

  await new Promise(ok => servidor.listen(0, '127.0.0.1', ok));
  const puerto = servidor.address().port;

  return {
    puerto,
    recibido,
    get conexiones() { return cuantas; },
    escribir(texto) { conexiones.at(-1)?.write(texto); },
    cortar() { conexiones.at(-1)?.destroy(); },
    async cerrar() {
      for (const c of conexiones) c.destroy();
      await new Promise(ok => servidor.close(ok));
    },
  };
}

/* ---------------------------------------------------------- parseo */

test('desescaparTag: \\s es UN ESPACIO, no whitespace generico', () => {
  /* El error clasico: tratar \s como la clase de expresion regular y
     comerse tabs y saltos. Se nota en reply-parent-msg-body, que es
     texto de una persona y esta lleno de espacios. */
  assert.equal(desescaparTag('hola\\smundo\\sque\\stal'), 'hola mundo que tal');
  assert.equal(desescaparTag('punto\\sy\\scoma\\:aca'), 'punto y coma;aca');
  assert.equal(desescaparTag('barra\\\\sola'), 'barra\\sola');
  assert.equal(desescaparTag('salto\\nlinea'), 'salto\nlinea');
  /* Una barra seguida de algo que no es una secuencia conocida pierde
     la barra y deja el caracter. */
  assert.equal(desescaparTag('raro\\qcosa'), 'raroqcosa');
  /* Una barra suelta al final no puede tirar ni dejar una barra. */
  assert.equal(desescaparTag('final\\'), 'final');
});

test('parsearLinea: el trailing se lleva los espacios y los dos puntos', () => {
  const l = '@id=abc;display-name=Ronni :ronni!ronni@ronni.tmi.twitch.tv ' +
            'PRIVMSG #canal :hola: che, como va';
  const m = parsearLinea(l);
  assert.equal(m.comando, 'PRIVMSG');
  assert.equal(m.prefijo, 'ronni!ronni@ronni.tmi.twitch.tv');
  assert.deepEqual(m.params, ['#canal']);
  assert.equal(m.resto, 'hola: che, como va',
    'los dos puntos de adentro del mensaje no cortan nada');
  assert.equal(m.tags.get('id'), 'abc');
  assert.equal(m.tags.get('display-name'), 'Ronni');
});

test('parsearLinea: un PING no tiene prefijo', () => {
  const m = parsearLinea('PING :tmi.twitch.tv');
  assert.equal(m.comando, 'PING');
  assert.equal(m.resto, 'tmi.twitch.tv');
});

test('parsearLinea: un tag sin valor queda vacio y no rompe', () => {
  const m = parsearLinea('@badge-info=;badges=turbo/1 PRIVMSG #c :hola');
  assert.equal(m.tags.get('badge-info'), '');
  assert.equal(m.tags.get('badges'), 'turbo/1');
});

/* -------------------------------------------------------- conexion */

test('el handshake anonimo pide capabilities, se pone un nick justinfan y entra al canal', async () => {
  const s = await servidorFalso();
  const c = new ConexionIrc({
    canal: 'istincho',
    alMensaje: () => {},
    abrirSocket: () => net.connect(s.puerto, '127.0.0.1'),
  });
  c.conectar();

  try {
    await esperarHasta(() => s.recibido.length >= 3);
    assert.equal(s.recibido[0], 'CAP REQ :twitch.tv/tags twitch.tv/commands');
    assert.match(s.recibido[1], /^NICK justinfan\d+$/,
      'anonimo: nick justinfan y ningun PASS');
    assert.equal(s.recibido[2], 'JOIN #istincho');
    assert.ok(!s.recibido.some(l => l.startsWith('PASS')),
      'un justinfan no manda contraseña, y mandar una lo rompe');
  } finally {
    c.cerrar();
    await s.cerrar();
  }
});

test('el PONG lleva exactamente el texto del PING', async () => {
  /* Si el PONG no coincide, Twitch corta la conexion sin decir nada y
     el chat se apaga cada cinco minutos. */
  const s = await servidorFalso();
  const c = new ConexionIrc({
    canal: 'istincho',
    alMensaje: () => {},
    abrirSocket: () => net.connect(s.puerto, '127.0.0.1'),
  });
  c.conectar();

  try {
    await esperarHasta(() => s.recibido.length >= 3);
    s.escribir('PING :tmi.twitch.tv\r\n');
    await esperarHasta(() => s.recibido.some(l => l.startsWith('PONG')));
    assert.equal(s.recibido.at(-1), 'PONG :tmi.twitch.tv');
  } finally {
    c.cerrar();
    await s.cerrar();
  }
});

test('una linea partida entre dos paquetes TCP llega entera', async () => {
  /* EL BUG que ataja: procesar cada trozo de `data` como si fuera una
     linea. El corte de TCP cae donde quiere y el mensaje se pierde o
     llega a la mitad. Pasa solo con mensajes largos y solo a veces. */
  const s = await servidorFalso();
  const recibidos = [];
  const c = new ConexionIrc({
    canal: 'istincho',
    alMensaje: m => recibidos.push(m),
    abrirSocket: () => net.connect(s.puerto, '127.0.0.1'),
  });
  c.conectar();

  try {
    await esperarHasta(() => s.recibido.length >= 3);

    const linea = '@id=m1;display-name=Fulana;color=#9146FF;emotes=25:0-4 ' +
                  ':fulana!fulana@fulana.tmi.twitch.tv PRIVMSG #istincho :Kappa y algo mas\r\n';
    const corte = 40;
    s.escribir(linea.slice(0, corte));
    await esperar(50);
    assert.equal(recibidos.length, 0, 'media linea todavia no es un mensaje');
    s.escribir(linea.slice(corte));

    await esperarHasta(() => recibidos.length === 1);
    const m = recibidos[0];
    assert.equal(m.id, 'm1');
    assert.equal(m.usuario, 'Fulana');
    assert.equal(m.color, '#9146ff');
    assert.equal(m.texto, 'Kappa y algo mas');
    assert.equal(m.emotes.length, 1);
  } finally {
    c.cerrar();
    await s.cerrar();
  }
});

test('dos mensajes en el mismo paquete se procesan los dos', async () => {
  const s = await servidorFalso();
  const recibidos = [];
  const c = new ConexionIrc({
    canal: 'istincho',
    alMensaje: m => recibidos.push(m),
    abrirSocket: () => net.connect(s.puerto, '127.0.0.1'),
  });
  c.conectar();

  try {
    await esperarHasta(() => s.recibido.length >= 3);
    s.escribir(
      '@id=a :a!a@a PRIVMSG #istincho :uno\r\n' +
      '@id=b :b!b@b PRIVMSG #istincho :dos\r\n',
    );
    await esperarHasta(() => recibidos.length === 2);
    assert.deepEqual(recibidos.map(m => m.texto), ['uno', 'dos']);
  } finally {
    c.cerrar();
    await s.cerrar();
  }
});

test('si el servidor corta, se vuelve a conectar solo', async () => {
  const s = await servidorFalso();
  const c = new ConexionIrc({
    canal: 'istincho',
    alMensaje: () => {},
    abrirSocket: () => net.connect(s.puerto, '127.0.0.1'),
  });
  c.conectar();

  try {
    await esperarHasta(() => s.conexiones === 1);
    s.cortar();
    /* El primer reintento espera entre 500 y 1000 ms (backoff con
       jitter), asi que 3 segundos alcanza de sobra. */
    await esperarHasta(() => s.conexiones === 2, { tope: 3000 });
    assert.equal(c.estado, 'conectado');
  } finally {
    c.cerrar();
    await s.cerrar();
  }
});

test('cerrar() no deja ninguna reconexion programada', async () => {
  /* Un timer de reintento que sobrevive a cerrar() abre una conexion
     nueva a Twitch cuando ya nadie la quiere, y no hay forma de
     matarla. */
  const s = await servidorFalso();
  const c = new ConexionIrc({
    canal: 'istincho',
    alMensaje: () => {},
    abrirSocket: () => net.connect(s.puerto, '127.0.0.1'),
  });
  c.conectar();

  try {
    await esperarHasta(() => s.conexiones === 1);
    s.cortar();
    await esperar(100);      // ya hay un reintento programado
    c.cerrar();
    assert.equal(c.estado, 'cortado');
    await esperar(1500);     // mas que la ventana del primer backoff
    assert.equal(s.conexiones, 1, 'no se abrio ninguna conexion despues de cerrar');
  } finally {
    await s.cerrar();
  }
});
