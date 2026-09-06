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

  let conexionVieja;
  let vieroCerroLaVieja = false;
  servidorViejo.alConectar = (conexion) => {
    conexionVieja = conexion;
    conexion.socket.on('close', () => { vieroCerroLaVieja = true; });
    conexion.enviarJson({
      metadata: metadata('session_welcome', 'w1'),
      payload: { session: { id: 'sesion-vieja', keepalive_timeout_seconds: 30, status: 'connected' } },
    });
  };

  let welcomeNuevoLlego = false;
  servidorNuevo.alConectar = (conexion) => {
    conexion.enviarJson({
      metadata: metadata('session_welcome', 'w2'),
      payload: { session: { id: 'sesion-nueva', keepalive_timeout_seconds: 30, status: 'connected' } },
    });
    welcomeNuevoLlego = true;
  };

  cx.conectar();
  await esperarHasta(() => cx.estado === 'conectado');
  assert.equal(vecesSuscrito, 1);

  conexionVieja.enviarJson({
    metadata: metadata('session_reconnect', 'r1'),
    payload: { session: { id: 'sesion-vieja', reconnect_url: urlNuevo, status: 'reconnecting' } },
  });

  await esperarHasta(() => welcomeNuevoLlego);
  await esperarHasta(() => vieroCerroLaVieja);

  assert.equal(vecesSuscrito, 1, 'no hay que volver a suscribirse en un reconnect avisado');
  assert.equal(cx.estado, 'conectado');
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
