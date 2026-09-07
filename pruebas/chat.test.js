/* ============================================================
   El orquestador del Chat Global: lo que junta las dos redes.

   No se prueba contra Kick ni contra Twitch: se le entregan payloads
   como los que mandan ellos y se mira que salga por el bus, con la
   forma unica, una sola vez.
   ============================================================ */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const DATOS = await fsp.mkdtemp(path.join(os.tmpdir(), 'sala-chat-'));
process.env.SALA_DATOS = DATOS;
process.env.CLAVE_CIFRADO = crypto.randomBytes(32).toString('base64');

const chat = await import('../servidor/chat.js');
const canales = await import('../servidor/canales.js');
const kick = await import('../servidor/kick.js');
const mensajes = await import('../servidor/mensajes.js');

const FIXTURE = JSON.parse(
  fs.readFileSync(path.join(AQUI, 'fijos', 'chat-mensaje.json'), 'utf8'),
);

const CANAL = 'istincho';

test.beforeEach(() => {
  chat.reiniciar();
  canales.cerrarTodo();
  /* `recordar` guarda en el canal aunque no haya nadie escuchando: es
     el buffer que ve el que llega despues. */
  canales.canal(CANAL);
});

test.after(async () => {
  chat.parar();
  canales.cerrarTodo();
  await fsp.rm(DATOS, { recursive: true, force: true });
});

const eventoKick = (tipo, cuando = new Date().toISOString()) =>
  ({ id: 'ev1', tipo, cuando, version: '1', suscripcion: 's1' });

/* ------------------------------------------------------------ Kick */

test('un chat.message.sent de Kick sale por el bus con el formato unico', () => {
  const r = chat.recibirDeKick(CANAL, eventoKick('chat.message.sent'), FIXTURE);
  assert.equal(r.hecho, 'chat');

  const guardados = canales.ultimos(CANAL);
  assert.equal(guardados.length, 1);
  assert.equal(guardados[0].tipo, 'chat');
  assert.equal(guardados[0].red, 'kick');
  assert.equal(guardados[0].usuario, 'unaespectadora');
  assert.equal(guardados[0].texto, 'que peli mas larga HYPERCLAP');
});

test('la ultima llegada de Kick se anota, y es lo unico que distingue "callado" de "roto"', () => {
  assert.equal(chat.salud(CANAL).kick.ultima, null);
  chat.recibirDeKick(CANAL, eventoKick('chat.message.sent'), FIXTURE);
  assert.ok(chat.salud(CANAL).kick.ultima, 'sin esto no hay indicador de salud posible');
});

test('livestream.status.updated cambia el estado de vivo', () => {
  chat.recibirDeKick(CANAL, eventoKick('livestream.status.updated'), { is_live: true });
  assert.equal(chat.salud(CANAL).kick.vivo, true);
  chat.recibirDeKick(CANAL, eventoKick('livestream.status.updated'), { is_live: false });
  assert.equal(chat.salud(CANAL).kick.vivo, false);
});

test('el aviso de silencio solo se prende si el canal esta en vivo', () => {
  /* Con el canal apagado, media hora sin mensajes es lo normal y
     avisar seria ruido que despues nadie mira. */
  const dentroDeUnRato = Date.now() + chat.SILENCIO_SOSPECHOSO + 60_000;
  assert.equal(chat.kickSospechoso(CANAL, dentroDeUnRato), false, 'apagado: no molesta');

  chat.recibirDeKick(CANAL, eventoKick('livestream.status.updated'), { is_live: true });
  assert.equal(chat.kickSospechoso(CANAL, Date.now()), true,
    'en vivo y sin un solo mensaje: eso si hay que decirlo');

  chat.recibirDeKick(CANAL, eventoKick('chat.message.sent'), FIXTURE);
  assert.equal(chat.kickSospechoso(CANAL, Date.now()), false, 'acaba de llegar uno');
  assert.equal(chat.kickSospechoso(CANAL, dentroDeUnRato), true, 'pero si pasan los 5 minutos, si');
});

test('el veredicto sale por la salud, que es lo unico que mira la pagina', () => {
  /* La regla vive en el servidor y en ningun otro lado. Si `salud()`
     no la lleva, la pagina no tiene con que prender la banda: no le
     queda mas que recalcularla con una regla propia, que es
     exactamente lo que hacia y lo que no coincidia. */
  assert.equal(chat.salud(CANAL).kick.sospechoso, false, 'canal apagado: nada que avisar');

  chat.recibirDeKick(CANAL, eventoKick('livestream.status.updated'), { is_live: true });
  assert.equal(chat.salud(CANAL).kick.sospechoso, true,
    'en vivo y sin un solo mensaje: eso es justo lo que hay que decir');
  assert.equal(chat.salud(CANAL).kick.sospechoso, chat.kickSospechoso(CANAL),
    'la salud dice lo mismo que la regla, no una version parecida');

  chat.recibirDeKick(CANAL, eventoKick('chat.message.sent'), FIXTURE);
  assert.equal(chat.salud(CANAL).kick.sospechoso, false, 'llego uno: se apaga');
});

test('un evento de Kick que no conocemos no rompe ni ensucia el bus', () => {
  const r = chat.recibirDeKick(CANAL, eventoKick('channel.followed'), { broadcaster: { channel_slug: CANAL } });
  assert.equal(r.hecho, 'ignorado');
  assert.equal(canales.ultimos(CANAL).length, 0);
});

/* ---------------------------------------------------------- Twitch */

const mensajeTwitch = id => mensajes.deTwitch({
  message_id: id,
  chatter_user_name: 'Fulana',
  color: '#9146FF',
  badges: [],
  message: { text: 'hola', fragments: [{ type: 'text', text: 'hola' }] },
}, { message_timestamp: new Date().toISOString() });

test('el mismo mensaje de Twitch por las dos vias se muestra una sola vez', () => {
  /* Mientras el plan B esta prendido, EventSub sigue reintentando: el
     mismo mensaje puede llegar por WebSocket y por IRC. El id es el
     mismo por las dos vias, y esa es toda la defensa. */
  assert.equal(chat.recibirDeTwitch(CANAL, mensajeTwitch('m1')), true);
  assert.equal(chat.recibirDeTwitch(CANAL, mensajeTwitch('m1')), false, 'el repetido no pasa');
  assert.equal(chat.recibirDeTwitch(CANAL, mensajeTwitch('m2')), true);
  assert.equal(canales.ultimos(CANAL).length, 2);
});

test('la ultima llegada de Twitch se anota', () => {
  assert.equal(chat.salud(CANAL).twitch.ultima, null);
  chat.recibirDeTwitch(CANAL, mensajeTwitch('m9'));
  assert.ok(chat.salud(CANAL).twitch.ultima);
});

/* ----------------------------------------------------------- salud */

test('la salud tiene la forma que espera la pagina', () => {
  const s = chat.salud(CANAL);
  assert.deepEqual(Object.keys(s).sort(), ['ahora', 'kick', 'twitch']);
  assert.deepEqual(Object.keys(s.kick).sort(), ['sospechoso', 'suscripcion', 'ultima', 'vinculado', 'vivo']);
  /* `tope` es de la Fase 3: dice que la conexion no se abrio por el
     tope de conexiones de ESTE proceso y no por un problema de
     Twitch. Sin ese campo el panel muestra "cortado" y no hay forma
     de distinguir las dos cosas. */
  assert.deepEqual(Object.keys(s.twitch).sort(), ['estado', 'modo', 'tope', 'ultima', 'vinculado']);
  assert.equal(s.kick.suscripcion, 'desconocida');
  assert.equal(s.twitch.modo, 'ninguno');
  assert.ok(Date.parse(s.ahora));
});

/* ---------------------------------------------------------- enviar */

test('no se manda un mensaje vacio ni uno que la plataforma va a rechazar', async () => {
  assert.match((await chat.enviar(CANAL, { texto: '   ', destino: 'kick' })).error, /vacio/);

  const largo = 'a'.repeat(501);
  assert.match((await chat.enviar(CANAL, { texto: largo, destino: 'kick' })).error, /500/);
  assert.match((await chat.enviar(CANAL, { texto: largo, destino: 'twitch' })).error, /Twitch/);
});

test('con destino "ambos" el tope de Twitch se mira ANTES de mandar, no despues', async () => {
  /* Los dos topes dicen 500 y no son el mismo numero: Kick cuenta
     grapheme clusters y Twitch cuenta puntos de codigo. Una familia de
     emojis es UN caracter para Kick y CINCO para Twitch.

     113 familias entran comodas en Kick (113 caracteres y 2034 bytes,
     abajo de sus dos topes) y son 565 puntos de codigo para Twitch,
     que no entran. Con la validacion mirando el tope de Twitch solo
     cuando el destino era "twitch", este mensaje salia en Kick y
     recien ahi Twitch lo rechazaba con un 400: el error llegaba tarde
     y en kick.com el mensaje ya estaba. */
  const familia = '👨‍👩‍👦';
  const texto = familia.repeat(113);
  assert.equal([...texto].length, 565, 'para Twitch son 565 puntos de codigo');
  assert.equal(kick.porQueNoSePuedeMandar(texto), '', 'para Kick el mensaje es perfectamente valido');

  const r = await chat.enviar(CANAL, { texto, destino: 'ambos' });
  assert.match(r.error ?? '', /Twitch/, 'se rechaza entero antes de tocar ninguna API');
  assert.equal(r.kick, undefined, 'y sobre todo: a Kick no se le mando nada');
});

test('sin vinculo, cada red dice que no pudo y no se pierde el resultado de la otra', async () => {
  const r = await chat.enviar(CANAL, { texto: 'hola', destino: 'ambos' });
  assert.equal(r.kick.ok, false);
  assert.equal(r.twitch.ok, false);
  assert.match(r.kick.motivo, /vinculo/);
  assert.match(r.twitch.motivo, /vinculo/);
});

test('un destino desconocido no manda nada a ningun lado', async () => {
  const r = await chat.enviar(CANAL, { texto: 'hola', destino: 'discord' });
  assert.match(r.error, /destino desconocido/);
});

test('el tope de Kick cuenta emojis como un caracter, no como dos', async () => {
  /* 400 emojis son 400 caracteres para Kick y 800 unidades UTF-16
     para `.length`. Contar mal rechazaria un mensaje que Kick acepta
     sin problema. */
  const r = await chat.enviar(CANAL, { texto: '💀'.repeat(400), destino: 'kick' });
  assert.equal(r.error, undefined, 'no lo puede rechazar por largo');
  assert.equal(r.kick.ok, false, 'falla por no haber vinculo, que es otra cosa');
});
