/* ============================================================
   Raids en la actividad: Twitch por EventSub (`channel.raid`) y Kick
   por su WebSocket (servidor/hosts.js), los dos al mismo embudo que
   los canjes, subs y follows.

   No sale nada a la red: hosts.js esta apagado en los tests
   (NODE_TEST_CONTEXT) y aca se le dan los sobres de Pusher a mano.
   ============================================================ */

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';

const DATOS = path.join(os.tmpdir(), 'sala-pruebas-raids');
process.env.SALA_DATOS = DATOS;
process.env.MODO = 'local';
process.env.KICK_SLUG = 'istincho';
process.env.CLAVE_CIFRADO = crypto.randomBytes(32).toString('base64');
process.env.ACTIVIDAD_DEMORA_MS = '0';

const canales = await import('../servidor/canales.js');
const chat = await import('../servidor/chat.js');
const hosts = await import('../servidor/hosts.js');
const mensajes = await import('../servidor/mensajes.js');
const twitch = await import('../servidor/twitch.js');

test.before(() => fsp.rm(DATOS, { recursive: true, force: true }).catch(() => {}));
test.after(async () => {
  canales.cerrarTodo();
  await fsp.rm(DATOS, { recursive: true, force: true }).catch(() => {});
});

/* ----------------------------------------------------------- Twitch */

test('channel.raid de Twitch sale como actividad publica, con quien y cuantos', () => {
  const a = mensajes.actividadDeTwitch('channel.raid', {
    from_broadcaster_user_id: '1', from_broadcaster_user_login: 'amigo', from_broadcaster_user_name: 'Amigo',
    to_broadcaster_user_id: '2', viewers: 37,
  }, { message_id: 'trama-1', message_timestamp: '2026-10-19T20:00:00Z' });
  assert.equal(a.tipo, 'actividad');
  assert.equal(a.red, 'twitch');
  assert.equal(a.clase, 'raid');
  assert.equal(a.usuario, 'Amigo');
  assert.equal(a.cantidad, 37);
  assert.equal(a.publico, true, 'un raid se ve en el chat de todos, no es como un follow');
});

test('channel.raid se suscribe aunque el vinculo no tenga ningun permiso de actividad', async () => {
  const fetchDeVerdad = globalThis.fetch;
  const pedidos = [];
  globalThis.fetch = async (url, op) => {
    const cuerpo = JSON.parse(op.body);
    pedidos.push(cuerpo);
    return new Response('{}', { status: 202 });
  };
  try {
    const r = await twitch.suscribirActividad({
      accessToken: 't', sessionId: 's', broadcasterId: '55', scopes: 'user:read:chat user:write:chat',
    });
    const raid = pedidos.find(p => p.type === 'channel.raid');
    assert.ok(raid, 'el raid es publico: no hace falta volver a vincular');
    assert.deepEqual(raid.condition, { to_broadcaster_user_id: '55' }, 'los que LLEGAN, no los que salen');
    assert.ok(r.ok.includes('channel.raid'));
  } finally {
    globalThis.fetch = fetchDeVerdad;
  }
});

/* ------------------------------------------------------------- Kick */

const SALA = 'ana';
const CHAT = '987654';

test('las dos formas del host de Kick dan la misma actividad', () => {
  const plano = mensajes.actividadDeHostKick('App\\Events\\StreamHostEvent',
    { host_username: 'Amiga', number_viewers: 12, optional_message: 'vamos' });
  const anidado = mensajes.actividadDeHostKick('App\\Events\\StreamHostedEvent',
    { user: { username: 'Amiga' }, message: { numberOfViewers: 12, optionalMessage: 'vamos' } });
  for (const a of [plano, anidado]) {
    assert.equal(a.red, 'kick');
    assert.equal(a.clase, 'raid');
    assert.equal(a.usuario, 'Amiga');
    assert.equal(a.cantidad, 12);
  }
  assert.equal(plano.id, anidado.id, 'mismo id: el dedupe del chat las junta');
  assert.equal(mensajes.actividadDeHostKick('App\\Events\\StreamHostEvent', {}), null, 'sin quien no hay raid');
});

test('un host que llega por el WebSocket entra a la actividad de SU sala, una sola vez', () => {
  canales.olvidarMensajes(SALA, () => true);
  canales.olvidarMensajes('otra', () => true);
  hosts.conocer(SALA, CHAT);
  hosts.alRecibir((slug, evento, datos) =>
    chat.recibirActividad(slug, mensajes.actividadDeHostKick(evento, datos)));

  const v2 = { event: 'App\\Events\\StreamHostEvent', channel: `chatrooms.${CHAT}.v2`,
    data: JSON.stringify({ host_username: 'Raider', number_viewers: 40 }) };
  const v1 = { event: 'App\\Events\\StreamHostedEvent', channel: `chatrooms.${CHAT}`,
    data: JSON.stringify({ user: { username: 'Raider' }, message: { numberOfViewers: 40 } }) };

  assert.equal(hosts.recibir(v2), true);
  assert.equal(hosts.recibir(v1), false, 'Kick manda el mismo raid por los dos canales');
  const enBuffer = canales.ultimos(SALA).filter(m => m.clase === 'raid');
  assert.equal(enBuffer.length, 1);
  assert.equal(enBuffer[0].usuario, 'Raider');
  assert.equal(canales.ultimos('otra').length, 0, 'no se cuela en otra sala');
});

test('lo que no es un host, o es de una sala que no se conoce, se ignora', () => {
  assert.equal(hosts.recibir({ event: 'App\\Events\\ChatMessageEvent', channel: `chatrooms.${CHAT}.v2`, data: '{}' }), false);
  assert.equal(hosts.recibir({ event: 'App\\Events\\StreamHostEvent', channel: 'chatrooms.1.v2',
    data: JSON.stringify({ host_username: 'x' }) }), false);
  assert.equal(hosts.recibir({ event: 'App\\Events\\StreamHostEvent', channel: `chatrooms.${CHAT}.v2`,
    data: '{no es json' }), false);
});

test('en los tests hosts.js no sale a la red', async () => {
  assert.equal(hosts.estado().activo, false);
  assert.equal(await hosts.vigilar('alguien', 'alguien'), false);
});
