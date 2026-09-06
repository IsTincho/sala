/* ============================================================
   Verificacion de webhooks de Kick.

   La clave privada de Kick no existe de este lado, asi que el test se
   genera SU PROPIO par RSA al vuelo y le dice a webhook.js que use esa
   publica. Un par de claves de prueba no se guarda en el repo ni
   siquiera para tests: una clave privada versionada es una clave
   privada que algun dia alguien confunde con una de verdad.
   ============================================================ */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as webhook from '../servidor/webhook.js';

const AQUI = path.dirname(fileURLToPath(import.meta.url));

const PAYLOAD = fs.readFileSync(path.join(AQUI, 'fijos', 'chat-mensaje.json'), 'utf8');

/* 2048 bits, que es lo que usa Kick. */
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

/** Firma como firma Kick: id . timestamp . cuerpo crudo */
export function firmarComoKick(id, ts, crudo, clave = privateKey) {
  const s = crypto.createSign('RSA-SHA256');
  s.update(`${id}.${ts}.${crudo}`);
  s.end();
  return s.sign(clave, 'base64');
}

export function cabecerasFirmadas(crudo, { id = 'MENSAJE-1', ts = '2026-01-14T16:08:06Z' } = {}) {
  return {
    'kick-event-message-id': id,
    'kick-event-subscription-id': 'SUSCRIPCION-1',
    'kick-event-message-timestamp': ts,
    'kick-event-signature': firmarComoKick(id, ts, crudo),
    'kick-event-type': 'chat.message.sent',
    'kick-event-version': '1',
  };
}

export { publicKey as clavePublicaDePrueba, privateKey as clavePrivadaDePrueba };

test.before(() => {
  webhook.fijarClavePublica(publicKey);
});

test('acepta un webhook bien firmado', async () => {
  assert.equal(await webhook.verificar(cabecerasFirmadas(PAYLOAD), PAYLOAD), true);
});

test('rechaza un cuerpo sin firma', async () => {
  const sinFirma = { ...cabecerasFirmadas(PAYLOAD) };
  delete sinFirma['kick-event-signature'];
  assert.equal(await webhook.verificar(sinFirma, PAYLOAD), false);

  assert.equal(await webhook.verificar({}, PAYLOAD), false);
});

test('rechaza si el cuerpo cambio despues de firmado', async () => {
  const cabeceras = cabecerasFirmadas(PAYLOAD);
  /* Este es EL caso que justifica todo: alguien intercepta el webhook y
     le cambia el texto del mensaje. La firma tiene que dejar de dar. */
  const alterado = PAYLOAD.replace('que peli mas larga', 'entren a mi-sitio-raro.com');
  assert.notEqual(alterado, PAYLOAD);
  assert.equal(await webhook.verificar(cabeceras, alterado), false);
});

test('rechaza si cambio el id o el timestamp', async () => {
  const crudo = PAYLOAD;
  const buenas = cabecerasFirmadas(crudo);

  assert.equal(
    await webhook.verificar({ ...buenas, 'kick-event-message-id': 'OTRO' }, crudo),
    false,
    'el id entra en la firma',
  );
  assert.equal(
    await webhook.verificar({ ...buenas, 'kick-event-message-timestamp': '2020-01-01T00:00:00Z' }, crudo),
    false,
    'el timestamp entra en la firma',
  );
});

test('rechaza una firma hecha con otra clave', async () => {
  const otra = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const id = 'MENSAJE-OTRA-CLAVE';
  const ts = '2026-01-14T16:08:06Z';
  const cabeceras = {
    'kick-event-message-id': id,
    'kick-event-message-timestamp': ts,
    'kick-event-signature': firmarComoKick(id, ts, PAYLOAD, otra.privateKey),
  };
  assert.equal(await webhook.verificar(cabeceras, PAYLOAD), false);
});

test('rechaza una firma que no es base64 valido', async () => {
  const cabeceras = { ...cabecerasFirmadas(PAYLOAD), 'kick-event-signature': 'no soy base64 %%%' };
  assert.equal(await webhook.verificar(cabeceras, PAYLOAD), false);
});

test('deduplica por id: el mismo mensaje se procesa una sola vez', () => {
  webhook.olvidarVistos();

  assert.equal(webhook.yaVisto('ABC'), false, 'la primera vez es nuevo');
  assert.equal(webhook.yaVisto('ABC'), true,  'la segunda ya se vio');
  assert.equal(webhook.yaVisto('DEF'), false, 'otro id sigue siendo nuevo');

  /* Un id vacio no se recuerda: si lo recordara, el primer webhook sin
     id haria que todos los siguientes sin id se descarten. */
  assert.equal(webhook.yaVisto(''), false);
  assert.equal(webhook.yaVisto(''), false);
});

test('la memoria de ids vistos no crece para siempre', () => {
  webhook.olvidarVistos();
  for (let i = 0; i < 700; i++) webhook.yaVisto(`id-${i}`);
  /* los primeros ya se olvidaron; los ultimos siguen ahi */
  assert.equal(webhook.yaVisto('id-0'), false, 'el mas viejo se solto');
  assert.equal(webhook.yaVisto('id-699'), true, 'el mas nuevo se recuerda');
});

test('los datos del evento salen de los seis headers', () => {
  const d = webhook.datosDelEvento(cabecerasFirmadas(PAYLOAD));
  assert.equal(d.id, 'MENSAJE-1');
  assert.equal(d.tipo, 'chat.message.sent');
  assert.equal(d.version, '1');
  assert.equal(d.suscripcion, 'SUSCRIPCION-1');
  assert.equal(d.cuando, '2026-01-14T16:08:06Z');
});

test('el fixture tiene la forma que documenta Kick', () => {
  const p = JSON.parse(PAYLOAD);
  /* Si Kick cambia la forma, que se rompa aca y no en la Fase 1
     cuando haya que traducir el mensaje. */
  assert.ok(p.message_id, 'message_id');
  assert.equal(typeof p.sender.user_id, 'number', 'en Kick los ids son numeros');
  assert.equal(p.sender.identity.username_color, '#FF5733', 'el color cuelga de identity');
  assert.ok(Array.isArray(p.sender.identity.badges), 'los badges cuelgan de identity');
  assert.equal(p.broadcaster.identity, null, 'identity puede venir null');
  assert.equal(p.broadcaster.channel_slug, 'istincho', 'por aca se sabe a que canal va');
  assert.ok(Array.isArray(p.emotes), 'emotes es un array aparte del content');
});

/* ------------------------------------------------ el cuerpo en bytes */

test('verifica igual si el cuerpo llega como Buffer', async () => {
  /* El camino de produccion no decodifica el cuerpo nunca: lo que Kick
     firmo son bytes, y decodificarlos y volverlos a codificar es lo que
     rompia la firma cuando un caracter multibyte caia partido entre dos
     paquetes TCP. */
  assert.equal(await webhook.verificar(cabecerasFirmadas(PAYLOAD), Buffer.from(PAYLOAD, 'utf8')), true);
});

test('un cuerpo con emoji verifica igual, venga como Buffer o como texto', async () => {
  const conEmoji = JSON.stringify({ content: 'buenisima la peli 🎉 ñandú' });
  const cabeceras = cabecerasFirmadas(conEmoji, { id: 'MENSAJE-EMOJI' });
  assert.equal(await webhook.verificar(cabeceras, conEmoji), true);
  assert.equal(await webhook.verificar(cabeceras, Buffer.from(conEmoji, 'utf8')), true);
});

/* --------------------------------------------- ventana de antiguedad */

test('esReciente acepta lo de ahora y rechaza lo viejo', () => {
  const ahora = Date.parse('2026-09-06T12:00:00Z');

  assert.equal(webhook.esReciente('2026-09-06T12:00:00Z', ahora), true);
  assert.equal(webhook.esReciente('2026-09-06T11:55:00Z', ahora), true, 'cinco minutos entra');
  assert.equal(webhook.esReciente('2026-09-06T11:45:00Z', ahora), false, 'un cuarto de hora ya no');

  /* Tolerancia hacia adelante: el reloj de Kick puede ir adelantado
     respecto del del contenedor, y eso no es un ataque. */
  assert.equal(webhook.esReciente('2026-09-06T12:05:00Z', ahora), true);
  assert.equal(webhook.esReciente('2026-09-06T12:30:00Z', ahora), false);

  /* Los dos formatos de epoch, por si Kick cambia el suyo. */
  assert.equal(webhook.esReciente(String(Math.floor(ahora / 1000)), ahora), true, 'epoch en segundos');
  assert.equal(webhook.esReciente(String(ahora), ahora), true, 'epoch en milisegundos');
  assert.equal(webhook.esReciente(String(Math.floor((ahora - 3600_000) / 1000)), ahora), false);
});

test('una fecha que no se entiende se deja pasar, y se avisa una sola vez', () => {
  /* Es la unica parte de la verificacion que falla abierta, y es
     deliberado: el timestamp entra en la firma, asi que es autentico
     aunque no lo sepamos leer. Si Kick cambiara el formato, descartar
     todo dejaria el chat mudo al 100 %. */
  webhook.olvidarAvisoDeFormato();
  const avisos = [];
  const original = console.warn;
  console.warn = (...a) => avisos.push(a.join(' '));
  try {
    for (const basura of ['', 'no es una fecha', undefined, null]) {
      assert.equal(webhook.esReciente(basura, Date.now()), true, `${basura} no se puede juzgar`);
    }
  } finally {
    console.warn = original;
  }
  assert.equal(avisos.length, 1, 'se avisa una vez, no en cada mensaje del chat');
  assert.match(avisos[0], /Kick-Event-Message-Timestamp/);
});

test('olvidar deja que un evento que fallo se vuelva a intentar', () => {
  webhook.olvidarVistos();

  assert.equal(webhook.yaVisto('EVENTO-QUE-FALLA'), false);
  assert.equal(webhook.yaVisto('EVENTO-QUE-FALLA'), true, 'quedo marcado');

  webhook.olvidar('EVENTO-QUE-FALLA');
  assert.equal(webhook.yaVisto('EVENTO-QUE-FALLA'), false,
    'sin esto, el reintento de Kick se contesta "repetido" y el evento se pierde');
});
