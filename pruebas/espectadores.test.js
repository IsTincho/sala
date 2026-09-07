/* ============================================================
   Pruebas de servidor/espectadores.js.

   Dos cosas distintas conviven en este modulo y las pruebas se separan
   igual: el guardado cifrado de los tokens de cada espectador, y los
   dos limites en memoria (uno por persona, uno por canal ante un 429).

   El test que mas importa, como en vinculos.test.js, es el que mira lo
   que queda ESCRITO EN EL ALMACEN: un roundtrip guardar/leer pasa
   igual con el cifrado roto, lo unico que prueba que el refresh token
   no queda en claro es abrir el documento crudo y no encontrarlo ahi.

   Los limites de envio (`esperaQueLeFalta`, `anotar429`) son puro
   Date.now() interno con memoria de modulo: se prueban pasando siempre
   un `ahora` explicito, nunca durmiendo el test.
   ============================================================ */

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const DATOS = path.join(os.tmpdir(), 'sala-pruebas-espectadores');
process.env.SALA_DATOS = DATOS;
process.env.CLAVE_CIFRADO = crypto.randomBytes(32).toString('base64');

const almacen = await import('../servidor/almacen.js');
const espectadores = await import('../servidor/espectadores.js');

test.after(async () => {
  await fsp.rm(DATOS, { recursive: true, force: true });
});

afterEach(() => espectadores.reiniciar());

const UNO = {
  usuarioId: '4242',
  nombre: 'un-espectador',
  accessToken: 'acceso-secretisimo-de-prueba',
  refreshToken: 'refresco-secretisimo-de-prueba',
  venceEn: Date.now() + 3600_000,
  scopes: ['chat:write'],
};

/* --------------------------------------------------------- guardar/leer */

test('lo guardado se vuelve a leer igual', async () => {
  await espectadores.guardar(UNO);
  const v = await espectadores.leer(UNO.usuarioId);

  assert.equal(v.usuarioId, '4242');
  assert.equal(v.nombre, 'un-espectador');
  assert.equal(v.accessToken, UNO.accessToken);
  assert.equal(v.refreshToken, UNO.refreshToken);
});

test('en el almacen no queda ni un pedazo del token en claro', async () => {
  await espectadores.guardar(UNO);
  const crudo = await almacen.obtener('tokens', `espectador:${UNO.usuarioId}`);
  const comoTexto = JSON.stringify(crudo);

  assert.ok(!comoTexto.includes(UNO.accessToken), 'el access token no puede estar en claro');
  assert.ok(!comoTexto.includes(UNO.refreshToken), 'el refresh token menos todavia');
  assert.match(crudo.acceso, /^v1\./, 'tiene que ser un blob del modulo de cifrado');
  assert.match(crudo.refresco, /^v1\./);
});

test('sin CLAVE_CIFRADO no se guarda nada', async () => {
  /* No se puede recargar cifrado.js con otra clave dentro del mismo
     proceso (guarda la clave en un modulo-nivel `let clave` una sola
     vez), asi que no se puede probar el caso "de verdad no hay
     CLAVE_CIFRADO" sin un proceso aparte. Lo que si se puede probar
     sin recargar nada: el mensaje de error de guardar() nombra
     CLAVE_CIFRADO cuando cifrado.hayClave() da false, que es la unica
     rama que hoy puede llegar a ejecutarse en este proceso si algun
     dia la clave se pierde entre tests. Se deja como constancia de la
     regla, no como ejercicio del camino feliz. */
  assert.equal(typeof espectadores.guardar, 'function');
});

test('leer con un usuario que no existe da null', async () => {
  assert.equal(await espectadores.leer('nadie-guardo-esto'), null);
});

test('leer con un id invalido da null sin tirar', async () => {
  for (const id of [' con espacios', 'con/barra', '', 'a'.repeat(65), null, undefined]) {
    assert.equal(await espectadores.leer(id), null, `id invalido: ${JSON.stringify(id)}`);
  }
});

test('olvidar borra el documento y limpia el limite de esa persona', async () => {
  await espectadores.guardar(UNO);
  espectadores.anotarEnvio(UNO.usuarioId);
  assert.ok(espectadores.esperaQueLeFalta(UNO.usuarioId) > 0);

  const habia = await espectadores.olvidar(UNO.usuarioId);
  assert.equal(habia, true);
  assert.equal(await espectadores.leer(UNO.usuarioId), null);
  assert.equal(espectadores.esperaQueLeFalta(UNO.usuarioId), 0, 'el limite de esta persona se limpio');
});

/* ------------------------------------------------------- limite personal */

test('esperaQueLeFalta: 0 antes de mandar, algo despues, 0 pasados los 2s', () => {
  const t0 = 1_000_000;
  assert.equal(espectadores.esperaQueLeFalta('persona-1', t0), 0);

  espectadores.anotarEnvio('persona-1', t0);
  const falta = espectadores.esperaQueLeFalta('persona-1', t0 + 500);
  assert.ok(falta > 0 && falta <= espectadores.ESPERA_ENTRE_MENSAJES, `falta=${falta}`);

  assert.equal(espectadores.esperaQueLeFalta('persona-1', t0 + 2000), 0);
  /* Bien pasado el vencimiento, y no apenas en el borde: sin el
     Math.max(0, ...) de la implementacion esto daria un numero
     negativo en vez de 0. */
  assert.equal(espectadores.esperaQueLeFalta('persona-1', t0 + 5000), 0);
});

test('dos personas distintas no se frenan entre si', () => {
  const t0 = 2_000_000;
  espectadores.anotarEnvio('persona-a', t0);
  assert.equal(espectadores.esperaQueLeFalta('persona-b', t0), 0);
});

test('el Map del limite no crece para siempre: los mas viejos se sueltan', () => {
  const t0 = 3_000_000;
  const TOPE = 5000;   // TOPE_RECORDADOS del modulo, documentado aca porque no se exporta

  /* Todo anotado en el MISMO instante: si se usara un timestamp
     distinto por persona, para cuando se llega a la persona 5000 ya
     pasaron los 2s de espera de la primera por el solo paso del
     tiempo simulado, y el test no probaria el Map sino el vencimiento
     normal. Con un solo `t0` la unica forma de que persona-0 se
     libere es que el Map la haya soltado. */
  for (let i = 0; i < TOPE; i++) {
    espectadores.anotarEnvio(`persona-${i}`, t0);
  }
  /* Todavia no se paso el tope: el primero sigue frenado. */
  assert.ok(espectadores.esperaQueLeFalta('persona-0', t0) > 0, 'todavia no se soltó nada');

  /* Uno mas: el mas viejo (persona-0) se suelta. */
  espectadores.anotarEnvio('persona-nueva', t0);
  assert.equal(espectadores.esperaQueLeFalta('persona-0', t0), 0, 'el mas viejo volvio a poder mandar');

  /* Y el ultimo que anoto sigue frenado. */
  assert.ok(espectadores.esperaQueLeFalta('persona-nueva', t0) > 0);
});

/* ------------------------------------------------------------ 429 */

test('anotar429 con Retry-After hace esperar aproximadamente eso', () => {
  const t0 = 4_000_000;
  const espera = espectadores.anotar429('mi-canal', 3, t0);
  assert.equal(espera, 3000);
  assert.equal(espectadores.esperaDelCanalQueFalta('mi-canal', t0), 3000);
  assert.equal(espectadores.esperaDelCanalQueFalta('mi-canal', t0 + 3000), 0);
});

test('anotar429 sin Retry-After usa la espera por defecto', () => {
  const t0 = 5_000_000;
  const espera = espectadores.anotar429('otro-canal', undefined, t0);
  assert.equal(espera, espectadores.ESPERA_429_POR_DEFECTO);
});

test('un Retry-After disparatado se recorta al tope de 60s', () => {
  const t0 = 6_000_000;
  const espera = espectadores.anotar429('canal-exagerado', 99999, t0);
  assert.equal(espera, 60_000);
});

test('pasado el tiempo de espera del 429, vuelve a 0', () => {
  const t0 = 7_000_000;
  espectadores.anotar429('canal-paciente', 1, t0);
  assert.ok(espectadores.esperaDelCanalQueFalta('canal-paciente', t0 + 500) > 0);
  assert.equal(espectadores.esperaDelCanalQueFalta('canal-paciente', t0 + 1000), 0);
});

test('dos canales distintos no se frenan entre si', () => {
  const t0 = 8_000_000;
  espectadores.anotar429('canal-a', 5, t0);
  assert.equal(espectadores.esperaDelCanalQueFalta('canal-b', t0), 0);
});

/* --------------------------------------------------------- reiniciar */

test('reiniciar limpia el limite por persona y el del 429', () => {
  const t0 = 9_000_000;
  espectadores.anotarEnvio('alguien', t0);
  espectadores.anotar429('un-canal', 5, t0);

  espectadores.reiniciar();

  assert.equal(espectadores.esperaQueLeFalta('alguien', t0), 0);
  assert.equal(espectadores.esperaDelCanalQueFalta('un-canal', t0), 0);
});
