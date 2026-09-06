/* ============================================================
   Los vinculos del dueño con Kick y con Twitch.

   El test que mas importa de este archivo es el que mira lo que queda
   ESCRITO EN LA BASE. Un roundtrip guardar/leer pasa igual con el
   cifrado desconectado: lo unico que prueba que los tokens no quedan
   en claro es abrir el documento guardado y no encontrarlos ahi.
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
  await vinculos.guardar('kick', UNO);
  const v = await vinculos.leer('kick');
  assert.equal(v.usuarioId, '4242');
  assert.equal(v.slug, 'istincho');
  assert.equal(v.accessToken, UNO.accessToken);
  assert.equal(v.refreshToken, UNO.refreshToken);
});

test('en la base no queda ni un pedazo del token en claro', async () => {
  await vinculos.guardar('twitch', { ...UNO, login: 'istincho_tv' });
  const crudo = await almacen.obtener('tokens', 'twitch:dueno');
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
  await vinculos.guardar('kick', UNO);
  const r = await vinculos.resumen();
  const comoTexto = JSON.stringify(r);
  assert.ok(!comoTexto.includes(UNO.accessToken));
  assert.ok(!comoTexto.includes(UNO.refreshToken));
  assert.ok(!comoTexto.includes('v1.'), 'ni siquiera el blob cifrado');
  assert.equal(r.kick.vinculado, true);
  assert.equal(r.kick.usuario, 'IsTincho');
});

test('una red sin vincular se lee como null y en el resumen como false', async () => {
  await vinculos.olvidar('twitch');
  assert.equal(await vinculos.leer('twitch'), null);
  assert.equal(await vinculos.acceso('twitch'), null);
  assert.equal((await vinculos.resumen()).twitch.vinculado, false);
});

test('un token que todavia sirve no se refresca', async () => {
  await vinculos.guardar('kick', UNO);
  const a = await vinculos.acceso('kick');
  assert.equal(a.accessToken, UNO.accessToken);
  assert.equal(a.usuarioId, '4242');
  /* Y lo unico que sale de aca es el access token: el refresh no. */
  assert.equal(a.refreshToken, undefined);
});

test('un token vencido sin refresh token no se inventa una sesion', async () => {
  await vinculos.guardar('kick', { ...UNO, venceEn: Date.now() - 1000, refreshToken: '' });
  await assert.rejects(() => vinculos.acceso('kick'), /volver a vincular/);
});

test('un blob que no se puede descifrar se trata como "no hay vinculo"', async () => {
  /* Pasa de verdad cuando se rota CLAVE_CIFRADO: los tokens viejos
     dejan de poder leerse. Lo correcto es pedir que se vuelva a
     vincular, no romper el arranque del servidor. */
  await almacen.poner('tokens', 'kick:dueno', {
    red: 'kick',
    usuarioId: '4242',
    acceso: 'v1.esto-no-descifra-ni-en-broma',
    refresco: '',
    venceEn: Date.now() + 3600_000,
  });
  assert.equal(await vinculos.leer('kick'), null);
});

test('una red que no existe se rechaza', async () => {
  await assert.rejects(() => vinculos.leer('discord'), /red desconocida/);
});
