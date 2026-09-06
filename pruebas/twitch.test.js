/* ============================================================
   Pruebas de servidor/twitch.js, centradas en ConexionEventSub: es la
   parte con estado y con casos borde (reconnect, keepalive, dedupe)
   que vale la pena verificar con un servidor de verdad, aunque sea
   uno falso.

   El servidor falso esta en pruebas/fijos/ws-falso.js. Ahi se explica
   por que se escribe a mano en vez de importar `ws`.
   ============================================================ */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConexionEventSub } from '../servidor/twitch.js';
import { ServidorWsFalso } from './fijos/ws-falso.js';

const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Espera hasta que `condicion()` de true, o tira si se pasa el tiempo. */
async function esperarHasta(condicion, { tope = 3000, paso = 20 } = {}) {
  const limite = Date.now() + tope;
  while (!condicion()) {
    if (Date.now() > limite) throw new Error('tiempo de espera agotado');
    await esperar(paso);
  }
}

function metadata(tipo, id) {
  return {
    message_id: id,
    message_type: tipo,
    message_timestamp: new Date().toISOString(),
  };
}

test('welcome: conecta, suscribe con el session_id y queda conectado', async (t) => {
  const servidor = new ServidorWsFalso();
  const url = await servidor.escuchar();
  t.after(() => servidor.cerrar());

  const idsSuscritos = [];
  const cx = new ConexionEventSub({
    url,
    suscribir: async (sessionId) => { idsSuscritos.push(sessionId); },
  });
  t.after(() => cx.cerrar());

  servidor.alConectar = (conexion) => {
    conexion.enviarJson({
      metadata: metadata('session_welcome', 'w1'),
      payload: { session: { id: 'sesion-123', keepalive_timeout_seconds: 30, status: 'connected' } },
    });
  };

  cx.conectar();
  await esperarHasta(() => cx.estado === 'conectado');

  assert.deepEqual(idsSuscritos, ['sesion-123']);
  assert.equal(cx.estado, 'conectado');
});

test('keepalive: llega y la conexion no se cae', async (t) => {
  const servidor = new ServidorWsFalso();
  const url = await servidor.escuchar();
  t.after(() => servidor.cerrar());

  const cx = new ConexionEventSub({
    url,
    suscribir: async () => {},
  });
  t.after(() => cx.cerrar());

  let conexionServidor;
  servidor.alConectar = (conexion) => {
    conexionServidor = conexion;
    conexion.enviarJson({
      metadata: metadata('session_welcome', 'w1'),
      // timeout chico para que el test sea rapido
      payload: { session: { id: 'sesion-ka', keepalive_timeout_seconds: 1, status: 'connected' } },
    });
  };

  cx.conectar();
  await esperarHasta(() => cx.estado === 'conectado');

  // el margen es timeout * 1.5 = 1.5s; se manda un keepalive antes de eso
  await esperar(700);
  conexionServidor.enviarJson({ metadata: metadata('session_keepalive', 'k1'), payload: {} });
  await esperar(700);

  // si el timer no se hubiera reiniciado, ya habria vencido y reconectado
  assert.equal(cx.estado, 'conectado');
});

test('notification: llama a alMensaje y deduplica por message_id', async (t) => {
  const servidor = new ServidorWsFalso();
  const url = await servidor.escuchar();
  t.after(() => servidor.cerrar());

  const eventosRecibidos = [];
  const cx = new ConexionEventSub({
    url,
    suscribir: async () => {},
    alMensaje: (evento, metadataMsg) => eventosRecibidos.push({ evento, id: metadataMsg.message_id }),
  });
  t.after(() => cx.cerrar());

  let conexionServidor;
  servidor.alConectar = (conexion) => {
    conexionServidor = conexion;
    conexion.enviarJson({
      metadata: metadata('session_welcome', 'w1'),
      payload: { session: { id: 'sesion-n', keepalive_timeout_seconds: 30, status: 'connected' } },
    });
  };

  cx.conectar();
  await esperarHasta(() => cx.estado === 'conectado');

  const notif = {
    metadata: metadata('notification', 'msg-1'),
    payload: {
      subscription: { type: 'channel.chat.message' },
      event: { text: 'hola' },
    },
  };
  conexionServidor.enviarJson(notif);
  await esperarHasta(() => eventosRecibidos.length === 1);

  // mismo message_id: no debe volver a llamar a alMensaje
  conexionServidor.enviarJson(notif);
  await esperar(100);

  assert.equal(eventosRecibidos.length, 1);
  assert.equal(eventosRecibidos[0].evento.text, 'hola');
  assert.equal(eventosRecibidos[0].id, 'msg-1');
});

test('reconnect: pasa al servidor nuevo sin volver a suscribir, y cierra el viejo despues del welcome nuevo', async (t) => {
  const servidorViejo = new ServidorWsFalso();
  const urlViejo = await servidorViejo.escuchar();
  t.after(() => servidorViejo.cerrar());

  const servidorNuevo = new ServidorWsFalso();
  const urlNuevo = await servidorNuevo.escuchar();
  t.after(() => servidorNuevo.cerrar());

  let vecesSuscrito = 0;
  const cx = new ConexionEventSub({
    url: urlViejo,
    suscribir: async () => { vecesSuscrito++; },
  });
  t.after(() => cx.cerrar());

  /* El ORDEN es lo que hay que probar, no que las dos cosas pasen:
     cerrar el socket viejo antes de tener el welcome del nuevo deja una
     ventana sin conexion en la que Twitch puede mandar un mensaje y
     perderse. Con dos banderas sueltas, un codigo que cerrara el viejo
     en #alReconnect pasaria el test igual. */
  const orden = [];

  let conexionVieja;
  servidorViejo.alConectar = (conexion) => {
    conexionVieja = conexion;
    conexion.socket.on('close', () => orden.push('cerro-la-vieja'));
    conexion.enviarJson({
      metadata: metadata('session_welcome', 'w1'),
      payload: { session: { id: 'sesion-vieja', keepalive_timeout_seconds: 30, status: 'connected' } },
    });
  };

  servidorNuevo.alConectar = (conexion) => {
    conexion.enviarJson({
      metadata: metadata('session_welcome', 'w2'),
      payload: { session: { id: 'sesion-nueva', keepalive_timeout_seconds: 30, status: 'connected' } },
    });
    orden.push('welcome-nuevo');
  };

  cx.conectar();
  await esperarHasta(() => cx.estado === 'conectado');
  assert.equal(vecesSuscrito, 1);

  conexionVieja.enviarJson({
    metadata: metadata('session_reconnect', 'r1'),
    payload: { session: { id: 'sesion-vieja', reconnect_url: urlNuevo, status: 'reconnecting' } },
  });

  await esperarHasta(() => orden.includes('welcome-nuevo'));
  await esperarHasta(() => orden.includes('cerro-la-vieja'));

  assert.deepEqual(orden, ['welcome-nuevo', 'cerro-la-vieja'],
    'la vieja se cierra DESPUES del welcome de la nueva, nunca antes');
  assert.equal(vecesSuscrito, 1, 'no hay que volver a suscribirse en un reconnect avisado');
  assert.equal(cx.estado, 'conectado');
});

test('reconnect: si se cae el socket ya promovido, se detecta y se reintenta', async (t) => {
  /* EL BUG: los listeners capturaban al abrirse una bandera que decia
     "soy de reconexion". Cuando #alWelcome promovia ese socket a socket
     activo, la bandera seguia diciendo lo mismo, asi que su listener de
     close entraba por la rama del entrante y hacia return: el socket
     quedaba muerto, `estado` seguia diciendo "conectado" y no se
     programaba ningun reintento. Lo unico que lo rescataba era el timer
     de keepalive (timeout * 1.5): con el default de 10s de Twitch son
     15 segundos de chat mudo diciendo que todo bien, y en este test,
     que pide 30s, serian 45. Y Twitch manda session_reconnect de
     rutina en cada deploy suyo. */
  const servidorViejo = new ServidorWsFalso();
  const urlViejo = await servidorViejo.escuchar();

  const servidorNuevo = new ServidorWsFalso();
  const urlNuevo = await servidorNuevo.escuchar();
  t.after(() => servidorNuevo.cerrar());

  const estados = [];
  const cx = new ConexionEventSub({
    url: urlViejo,
    suscribir: async () => {},
    alEstado: (e) => estados.push(e),
  });
  t.after(() => cx.cerrar());

  let conexionVieja;
  let conexionNueva;
  servidorViejo.alConectar = (conexion) => {
    conexionVieja = conexion;
    conexion.enviarJson({
      metadata: metadata('session_welcome', 'w1'),
      payload: { session: { id: 'sesion-vieja', keepalive_timeout_seconds: 30, status: 'connected' } },
    });
  };
  servidorNuevo.alConectar = (conexion) => {
    conexionNueva = conexion;
    conexion.enviarJson({
      metadata: metadata('session_welcome', 'w2'),
      payload: { session: { id: 'sesion-nueva', keepalive_timeout_seconds: 30, status: 'connected' } },
    });
  };

  cx.conectar();
  await esperarHasta(() => cx.estado === 'conectado');

  conexionVieja.enviarJson({
    metadata: metadata('session_reconnect', 'r1'),
    payload: { session: { id: 'sesion-vieja', reconnect_url: urlNuevo, status: 'reconnecting' } },
  });

  // el socket nuevo ya es el activo: dos veces 'conectado' en el historial
  await esperarHasta(() => estados.filter((e) => e === 'conectado').length === 2);

  /* Se baja el servidor viejo para que el reintento no pueda volver a
     conectar: asi el contador de fallos no se reinicia solo y el test
     no depende de quien gana una carrera. */
  await servidorViejo.cerrar();

  const desde = estados.length;
  conexionNueva.destruir();       // se corta el socket activo, sin aviso

  /* El keepalive tardaria 45s (30 * 1.5) en darse cuenta. Tres segundos
     alcanzan de sobra si la caida se detecta cuando pasa. */
  await esperarHasta(() => cx.intentosFallidosSeguidos >= 1, { tope: 3000 });

  assert.ok(estados.slice(desde).includes('reconectando'),
    'la caida del socket activo tiene que avisar, no quedar diciendo "conectado"');
  assert.notEqual(cx.estado, 'conectado', 'y el estado no puede seguir mintiendo');
});

test('reconnect: si el activo se cae antes del welcome del entrante, el promovido no queda huerfano', async (t) => {
  /* LA CARRERA: el socket activo se cae MIENTRAS el entrante de un
     session_reconnect todavia no mando su welcome. #alCerrarSocket
     programa un reintento; despues llega el welcome y el entrante se
     promueve a socket activo, pero nadie cancela ese reintento. Al
     disparar, #abrir pisa #socket sin cerrar el anterior: queda una
     conexion viva a Twitch que ni cerrar() alcanza. */
  const servidorViejo = new ServidorWsFalso();
  const urlViejo = await servidorViejo.escuchar();
  t.after(() => servidorViejo.cerrar());

  const servidorNuevo = new ServidorWsFalso();
  const urlNuevo = await servidorNuevo.escuchar();
  t.after(() => servidorNuevo.cerrar());

  const cx = new ConexionEventSub({ url: urlViejo, suscribir: async () => {} });
  t.after(() => cx.cerrar());

  let conexionesAlViejo = 0;
  let conexionVieja;
  servidorViejo.alConectar = (conexion) => {
    conexionesAlViejo++;
    conexionVieja = conexion;
    conexion.enviarJson({
      metadata: metadata('session_welcome', `wv${conexionesAlViejo}`),
      payload: { session: { id: `sesion-vieja-${conexionesAlViejo}`, keepalive_timeout_seconds: 30, status: 'connected' } },
    });
  };

  /* El welcome del entrante lo manda el test a mano, para poder meter
     la caida del activo justo en el medio. */
  let conexionNueva;
  servidorNuevo.alConectar = (conexion) => { conexionNueva = conexion; };

  cx.conectar();
  await esperarHasta(() => cx.estado === 'conectado');

  conexionVieja.enviarJson({
    metadata: metadata('session_reconnect', 'r1'),
    payload: { session: { id: 'sesion-vieja', reconnect_url: urlNuevo, status: 'reconnecting' } },
  });
  await esperarHasta(() => Boolean(conexionNueva));

  // se cae el activo con el entrante todavia sin welcome: se programa reintento
  conexionVieja.destruir();
  await esperarHasta(() => cx.intentosFallidosSeguidos >= 1);

  // recien ahora el entrante manda su welcome y se promueve
  conexionNueva.enviarJson({
    metadata: metadata('session_welcome', 'w2'),
    payload: { session: { id: 'sesion-nueva', keepalive_timeout_seconds: 30, status: 'connected' } },
  });
  await esperarHasta(() => cx.estado === 'conectado');

  /* El reintento tenia entre 500 ms y 1 s de espera; se le da de sobra
     para que dispare si nadie lo cancelo. */
  await esperar(1500);
  assert.equal(conexionesAlViejo, 1,
    'el reintento quedo pendiente y abrio una conexion de mas contra Twitch');

  cx.cerrar();
  await esperarHasta(() => servidorViejo.conexiones.size + servidorNuevo.conexiones.size === 0,
    { tope: 3000 });
});

test('vencimiento de keepalive: reconecta de cero y vuelve a suscribirse', async (t) => {
  const servidor = new ServidorWsFalso();
  const url = await servidor.escuchar();
  t.after(() => servidor.cerrar());

  let vecesSuscrito = 0;
  const cx = new ConexionEventSub({
    url,
    suscribir: async () => { vecesSuscrito++; },
  });
  t.after(() => cx.cerrar());

  let conexiones = 0;
  servidor.alConectar = (conexion) => {
    conexiones++;
    conexion.enviarJson({
      metadata: metadata('session_welcome', `w${conexiones}`),
      // 1s de timeout -> el margen es 1.5s; no se manda nada mas y se deja vencer
      payload: { session: { id: `sesion-${conexiones}`, keepalive_timeout_seconds: 1, status: 'connected' } },
    });
  };

  cx.conectar();
  await esperarHasta(() => vecesSuscrito === 1);

  // se deja pasar el margen (1.5s) sin mandar nada: tiene que vencer y reconectar
  await esperarHasta(() => vecesSuscrito === 2, { tope: 5000 });

  assert.equal(conexiones, 2);
  assert.equal(vecesSuscrito, 2);
});
