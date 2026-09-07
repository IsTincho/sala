/* ============================================================
   Los vinculos de una sala con Kick y con Twitch.

   El test que mas importa de este archivo es el que mira lo que queda
   ESCRITO EN LA BASE. Un roundtrip guardar/leer pasa igual con el
   cifrado desconectado: lo unico que prueba que los tokens no quedan
   en claro es abrir el documento guardado y no encontrarlos ahi.

   Desde la Fase 3 el slug va primero y es obligatorio: no hay forma de
   pedir "el vinculo de Kick" sin decir de que sala. Los dos ultimos
   tests de este archivo son los que cuidan esa frontera.
   ============================================================ */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/* Carpeta propia: `node --test` corre cada archivo en un proceso
   aparte pero sobre el mismo disco, y dos suites limpiando la misma
   carpeta de datos se pisan. */
const DATOS = await fsp.mkdtemp(path.join(os.tmpdir(), 'sala-vinculos-'));
process.env.SALA_DATOS = DATOS;
process.env.CLAVE_CIFRADO = crypto.randomBytes(32).toString('base64');

const almacen = await import('../servidor/almacen.js');
const vinculos = await import('../servidor/vinculos.js');

test.after(async () => {
  await fsp.rm(DATOS, { recursive: true, force: true });
});

const SALA = 'istincho';

const UNO = {
  usuarioId: '4242',
  nombre: 'IsTincho',
  login: 'istincho',
  slug: 'istincho',
  accessToken: 'acceso-secretisimo-de-prueba',
  refreshToken: 'refresco-secretisimo-de-prueba',
  venceEn: Date.now() + 3600_000,
  scopes: 'user:read chat:write',
};

test('lo guardado se vuelve a leer igual', async () => {
  await vinculos.guardar(SALA, 'kick', UNO);
  const v = await vinculos.leer(SALA, 'kick');
  assert.equal(v.usuarioId, '4242');
  assert.equal(v.slug, 'istincho');
  assert.equal(v.accessToken, UNO.accessToken);
  assert.equal(v.refreshToken, UNO.refreshToken);
});

test('en la base no queda ni un pedazo del token en claro', async () => {
  await vinculos.guardar(SALA, 'twitch', { ...UNO, login: 'istincho_tv' });
  const crudo = await almacen.obtener('tokens', 'twitch:istincho');
  const comoTexto = JSON.stringify(crudo);

  assert.ok(!comoTexto.includes(UNO.accessToken), 'el access token no puede estar en claro');
  assert.ok(!comoTexto.includes(UNO.refreshToken), 'el refresh token menos todavia');
  /* Y ademas: lo que hay guardado tiene que parecerse a un blob del
     modulo de cifrado, no a un base64 casero de nadie. */
  assert.match(crudo.acceso, /^v1\./);
  assert.match(crudo.refresco, /^v1\./);
  /* Lo que no es secreto SI puede estar: es lo que se muestra. */
  assert.equal(crudo.slug, 'istincho');
});

test('el resumen no lleva tokens ni campos cifrados', async () => {
  await vinculos.guardar(SALA, 'kick', UNO);
  const r = await vinculos.resumen(SALA);
  const comoTexto = JSON.stringify(r);
  assert.ok(!comoTexto.includes(UNO.accessToken));
  assert.ok(!comoTexto.includes(UNO.refreshToken));
  assert.ok(!comoTexto.includes('v1.'), 'ni siquiera el blob cifrado');
  assert.equal(r.kick.vinculado, true);
  assert.equal(r.kick.usuario, 'IsTincho');
});

test('una red sin vincular se lee como null y en el resumen como false', async () => {
  await vinculos.olvidar(SALA, 'twitch');
  assert.equal(await vinculos.leer(SALA, 'twitch'), null);
  assert.equal(await vinculos.acceso(SALA, 'twitch'), null);
  assert.equal((await vinculos.resumen(SALA)).twitch.vinculado, false);
});

test('un token que todavia sirve no se refresca', async () => {
  await vinculos.guardar(SALA, 'kick', UNO);
  const a = await vinculos.acceso(SALA, 'kick');
  assert.equal(a.accessToken, UNO.accessToken);
  assert.equal(a.usuarioId, '4242');
  /* Y lo unico que sale de aca es el access token: el refresh no. */
  assert.equal(a.refreshToken, undefined);
});

test('un token vencido sin refresh token no se inventa una sesion', async () => {
  await vinculos.guardar(SALA, 'kick', { ...UNO, venceEn: Date.now() - 1000, refreshToken: '' });
  await assert.rejects(() => vinculos.acceso(SALA, 'kick'), /volver a vincular/);
});

test('un blob que no se puede descifrar se trata como "no hay vinculo"', async () => {
  /* Pasa de verdad cuando se rota CLAVE_CIFRADO: los tokens viejos
     dejan de poder leerse. Lo correcto es pedir que se vuelva a
     vincular, no romper el arranque del servidor. */
  await almacen.poner('tokens', 'kick:istincho', {
    red: 'kick',
    usuarioId: '4242',
    acceso: 'v1.esto-no-descifra-ni-en-broma',
    refresco: '',
    venceEn: Date.now() + 3600_000,
  });
  assert.equal(await vinculos.leer(SALA, 'kick'), null);
});

test('una red que no existe se rechaza', async () => {
  await assert.rejects(() => vinculos.leer(SALA, 'discord'), /red desconocida/);
});


/* ============================================ el slug es obligatorio

   El encabezado de `servidor/vinculos.js` promete, con todas las letras,
   que olvidarse del slug TIRA en vez de caer en el del dueño. Sin
   estas pruebas esa promesa no la sostenía nada: volver a poner un
   valor por defecto sobrevivía la suite entera, porque hoy todos los
   call sites pasan el slug.

   Y el bug que el default reabre no es teórico: es exactamente el que
   la Fase 2 dejó anotado, un espectador escribiendo en la sala de un
   creador y el mensaje cayendo en el chat del dueño. */

test('sin slug no se lee, no se guarda y no se pregunta nada', async () => {
  await assert.rejects(() => vinculos.leer(undefined, 'kick'), /slug invalido/);
  await assert.rejects(() => vinculos.leer('', 'kick'), /slug invalido/);
  await assert.rejects(() => vinculos.leer(null, 'kick'), /slug invalido/);
  await assert.rejects(() => vinculos.identidad(undefined, 'kick'), /slug invalido/);
  await assert.rejects(() => vinculos.acceso(undefined, 'kick'), /slug invalido/);
  await assert.rejects(() => vinculos.olvidar(undefined, 'kick'), /slug invalido/);
  await assert.rejects(() => vinculos.guardar(undefined, 'kick', UNO), /slug invalido/);
  await assert.rejects(() => vinculos.resumen(undefined), /slug invalido/);
});

test('un slug que no sirve como id de documento tampoco pasa', async () => {
  /* De este slug sale el id del documento que se lee y se escribe. Uno
     raro que se colara leería —o pisaría— la fila de otra sala. */
  for (const malo of ['../otro', 'con espacio', 'a/b', 'MAYUS!', '-arranca-con-guion']) {
    await assert.rejects(() => vinculos.leer(malo, 'kick'), /slug invalido/, malo);
  }
});

test('dos salas no comparten vínculo aunque sea la misma red', async () => {
  /* La prueba de aislamiento del módulo. Si el slug se ignorara, las
     dos leerían el mismo documento y el mensaje de una saldría por el
     canal de la otra. */
  await vinculos.guardar('unasala', 'kick', { ...UNO, usuarioId: '111', slug: 'unasala' });
  await vinculos.guardar('otrasala', 'kick', { ...UNO, usuarioId: '222', slug: 'otrasala' });

  assert.equal((await vinculos.identidad('unasala', 'kick')).usuarioId, '111');
  assert.equal((await vinculos.identidad('otrasala', 'kick')).usuarioId, '222');

  /* Y olvidar una no toca a la otra. */
  await vinculos.olvidar('unasala', 'kick');
  assert.equal(await vinculos.leer('unasala', 'kick'), null);
  assert.equal((await vinculos.identidad('otrasala', 'kick')).usuarioId, '222');
});

test('una sala sin vínculo no hereda el del vecino', async () => {
  /* El control negativo del de arriba: sin esto, "devolver siempre el
     primero que haya" pasaría el test anterior a medias. */
  assert.equal(await vinculos.identidad('salavacia', 'kick'), null);
  assert.equal(await vinculos.leer('salavacia', 'kick'), null);
  assert.equal(await vinculos.acceso('salavacia', 'kick'), null);
});

test('salasCon lista las salas de una red y no las de la otra', async () => {
  /* Es de donde el arranque saca a quién levantarle la conexión. Si
     mezclara redes, intentaría abrir EventSub para alguien que sólo
     vinculó Kick. */
  await vinculos.guardar('conkick', 'kick', { ...UNO, slug: 'conkick' });
  await vinculos.guardar('contwitch', 'twitch', { ...UNO, slug: 'contwitch' });

  const deKick = await vinculos.salasCon('kick');
  const deTwitch = await vinculos.salasCon('twitch');

  assert.ok(deKick.includes('conkick'));
  assert.ok(!deKick.includes('contwitch'));
  assert.ok(deTwitch.includes('contwitch'));
  assert.ok(!deTwitch.includes('conkick'));
});
