/* ============================================================
   Los cabos sueltos que dejo la Fase 1 al cerrarse.

   Ninguno era un bug del dia: son agujeros de red sobre codigo
   correcto y puertas que hoy nadie empuja pero que la Fase 2 y la
   Fase 3 se van a montar encima. Cada prueba de aca existe porque la
   mutacion correspondiente sobrevivia las 224 pruebas anteriores.

   Lo que se cierra aca:
     - el webhook creando canales del bus con el slug que venga en el
       payload,
     - el tope de Twitch contado en puntos de codigo y no en otra cosa,
     - los timers de ConexionEventSub sin unref().
   ============================================================ */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const DATOS = await fsp.mkdtemp(path.join(os.tmpdir(), 'sala-cabos-'));
process.env.SALA_DATOS = DATOS;
process.env.CLAVE_CIFRADO = crypto.randomBytes(32).toString('base64');

const chat = await import('../servidor/chat.js');
const canales = await import('../servidor/canales.js');
const { ConexionEventSub } = await import('../servidor/twitch.js');

const CANAL = 'istincho';

const eventoKick = (tipo) =>
  ({ id: `ev-${Math.random()}`, tipo, cuando: new Date().toISOString(), version: '1', suscripcion: 's1' });

/** Un chat.message.sent de Kick, con el canal que se le pida adentro. */
const mensajeDeKick = (slug) => ({
  message_id: `m-${Math.random()}`,
  broadcaster: { user_id: 4242, username: 'IsTincho', channel_slug: slug },
  sender: { user_id: 9, username: 'Fulana', channel_slug: slug, identity: { username_color: '#53fc18', badges: [] } },
  content: 'hola',
  created_at: new Date().toISOString(),
});

test.beforeEach(() => {
  chat.reiniciar();
  canales.cerrarTodo();
  canales.canal(CANAL);
});

test.after(async () => {
  chat.parar();
  canales.cerrarTodo();
  await fsp.rm(DATOS, { recursive: true, force: true });
});

/* ------------------------------- el webhook no fabrica canales

   OJO, ESTO SE MUDO EN LA FASE 3. La guarda que antes vivia acá —el
   `if (slug !== slugDueno)` de `recibirDeKick`, que devolvia
   `canal ajeno`— ya no está en `chat.js`: la atribución de un evento a
   una sala es una pregunta de inquilino y no de chat, y vive en
   `creadores.salaDelEvento()`. Las pruebas de que un payload no puede
   fabricar canales del bus están en `pruebas/creadores.test.js` y, de
   punta a punta contra el webhook de verdad, en `pruebas/multicanal.test.js`.

   Lo que queda acá es lo de este módulo: que un evento con la sala YA
   RESUELTA entre, y entre en esa y no en otra. */

test('un evento con la sala resuelta entra en ESA sala y en ninguna otra', () => {
  const r = chat.recibirDeKick(CANAL, eventoKick('chat.message.sent'), mensajeDeKick(CANAL));

  assert.equal(r.hecho, 'chat');
  assert.equal(canales.ultimos(CANAL).length, 1);
  assert.equal(canales.hayCanal('canal-ajeno'), false,
    'no se toca ningún canal que nadie pidió');
});

test('el slug que manda es el que se le pasa, no el que trae el payload', () => {
  /* La contracara del punto de arriba, y la razón por la que la
     atribución se resuelve afuera: acá el payload dice `canal-ajeno` y
     el mensaje tiene que caer igual en la sala que se pidió. Si este
     módulo volviera a mirar `broadcaster.channel_slug`, este test se
     cae. */
  const r = chat.recibirDeKick(CANAL, eventoKick('chat.message.sent'), mensajeDeKick('canal-ajeno'));

  assert.equal(r.hecho, 'chat');
  assert.equal(canales.ultimos(CANAL).length, 1);
  assert.equal(canales.hayCanal('canal-ajeno'), false,
    'el payload no puede fabricar un canal del bus con el nombre que quiera');
});

test('un evento sin broadcaster entra igual en la sala que se le pasó', () => {
  /* `livestream.status.updated` llega sin `broadcaster`. Es el camino
     que usa el aviso de "en vivo". */
  const r = chat.recibirDeKick(CANAL, eventoKick('livestream.status.updated'), { is_live: true });

  assert.equal(r.hecho, 'vivo');
  assert.equal(chat.salud(CANAL).kick.vivo, true);
});

/* --------------------------- el tope de Twitch, en puntos de codigo */

/* Una familia: un grapheme cluster, siete puntos de codigo, once
   unidades UTF-16. Es el caracter que separa las tres formas de
   contar. */
const FAMILIA = '\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}';

test('el tope de Twitch cuenta puntos de codigo, no graphemes', async () => {
  /* 80 familias son 80 caracteres para Kick (que cuenta grapheme
     clusters) y 560 para Twitch (que cuenta puntos de codigo). Si el
     tope se contara como lo cuenta Kick, el mensaje saldria y Twitch
     lo rechazaria con un 400 cuando ya no se puede deshacer. */
  const texto = FAMILIA.repeat(80);
  assert.equal([...texto].length, 560);

  const r = await chat.enviar(CANAL, { texto, destino: 'twitch' });
  assert.match(String(r.error), /560 caracteres/,
    'con 560 puntos de codigo Twitch no lo acepta y hay que decirlo antes de mandar');

  /* Y con destino "ambos" no sale en ninguna: es la decision escrita
     de la fase, validar las dos antes de mandarle nada a ninguna. */
  const ambos = await chat.enviar(CANAL, { texto, destino: 'ambos' });
  assert.match(String(ambos.error), /560 caracteres/);
  assert.equal(ambos.kick, undefined, 'no se le mando nada a Kick');
});

test('el tope de Twitch no cuenta unidades UTF-16', async () => {
  /* La otra mitad: 300 caracteres fuera del plano basico son 300
     puntos de codigo (pasan) pero 600 unidades UTF-16. Contar
     `texto.length` rechazaria un mensaje que Twitch acepta. */
  const texto = '\u{1F600}'.repeat(300);
  assert.equal([...texto].length, 300);
  assert.equal(texto.length, 600);

  const r = await chat.enviar(CANAL, { texto, destino: 'twitch' });
  assert.equal(r.error, undefined, `el largo no tenia que ser un problema: ${r.error}`);
  /* Sin vinculo guardado no puede salir, y ese es el motivo esperado:
     lo que importa es que la validacion de largo lo dejo pasar. */
  assert.equal(r.twitch.ok, false);
  assert.match(r.twitch.motivo, /vinculo/);
});

/* ------------------------------ los timers de EventSub, con unref */

/**
 * Un WebSocket de mentira, para armar los timers sin red y sin
 * esperar. Lo unico que hace falta es que sea un EventTarget con
 * `close`, que es todo lo que ConexionEventSub le pide.
 */
class SocketFalso extends EventTarget {
  constructor(url) { super(); this.url = url; this.cerrado = false; }
  close() { this.cerrado = true; }
}

/** Corre `hacer()` anotando los timers que se armen mientras tanto. */
function anotandoTimers(hacer) {
  const real = globalThis.setTimeout;
  const armados = [];
  globalThis.setTimeout = (fn, ms, ...resto) => {
    const t = real(fn, ms, ...resto);
    armados.push({ ms, t });
    return t;
  };
  try { hacer(); } finally { globalThis.setTimeout = real; }
  return armados;
}

test('los timers de EventSub no sostienen el proceso', (t) => {
  /* Un timer con ref() mantiene vivo el event loop. El de keepalive
     son 45 segundos y el de reintento llega hasta 60: un proceso que
     ya cerro todo lo demas se queda esperando a Twitch en vez de
     terminar. El resto de los timers del proyecto (canales, chat,
     irc, index) llaman a unref; estos dos venian de la Fase 0 sin
     hacerlo. */
  const WsReal = globalThis.WebSocket;
  let ultimo = null;
  globalThis.WebSocket = class extends SocketFalso {
    constructor(url) { super(url); ultimo = this; }
  };
  t.after(() => { globalThis.WebSocket = WsReal; });

  const cx = new ConexionEventSub({ url: 'ws://de-mentira/', suscribir: async () => {} });
  t.after(() => cx.cerrar());

  /* El keepalive: se arma en el mismo turno del welcome. */
  const delKeepalive = anotandoTimers(() => {
    cx.conectar();
    const ev = new Event('message');
    ev.data = JSON.stringify({
      metadata: { message_type: 'session_welcome', message_id: 'w1' },
      payload: { session: { id: 'sesion-1', keepalive_timeout_seconds: 40 } },
    });
    ultimo.dispatchEvent(ev);
  });

  const keepalive = delKeepalive.filter(a => a.ms === 40 * 1000 * 1.5);
  assert.equal(keepalive.length, 1, 'el welcome tiene que armar el timer de keepalive');
  assert.equal(keepalive[0].t.hasRef(), false,
    'el timer de keepalive sostiene el proceso: le falta unref()');

  /* El reintento: si el WebSocket ni se puede construir, #abrir lo
     programa en el acto, sin red de por medio. */
  globalThis.WebSocket = class { constructor() { throw new Error('no hay red'); } };
  const delReintento = anotandoTimers(() => cx.conectar());

  assert.equal(delReintento.length, 1, 'un fallo al abrir tiene que programar un reintento');
  assert.equal(delReintento[0].t.hasRef(), false,
    'el timer de reintento sostiene el proceso: le falta unref()');
});
