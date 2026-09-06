/* ============================================================
   Pruebas de servidor/sesion.js.

   sesion.js guarda en el almacen, que sin MONGODB_URI cae al backend
   de archivos JSON en servidor/datos/sesiones.json. Estos tests
   ensucian ese archivo y lo limpian al final con after(), borrandolo
   y llamando a almacen.olvidarCache() para no dejar basura ni cache
   de proceso.

   CLAVE_CIFRADO se setea antes de importar nada, porque sesion.js usa
   firmar/firmaValida de cifrado.js.
   ============================================================ */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.CLAVE_CIFRADO = crypto.randomBytes(32).toString('base64');

const sesion = await import('../servidor/sesion.js');
const almacen = await import('../servidor/almacen.js');

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const ARCHIVO_SESIONES = path.join(AQUI, '..', 'servidor', 'datos', 'sesiones.json');

function reqCon(nombreCookie, valor) {
  return { headers: { cookie: `${nombreCookie}=${valor}` } };
}

test('cookie valida: crear + leer devuelve la sesion con usuario y nombre', async () => {
  const valor = await sesion.crear({ tipo: 'dueno', usuario: '123', nombre: 'IsTincho' });
  const req = reqCon('sala_dueno', valor);
  const s = await sesion.leer(req, 'dueno');
  assert.ok(s);
  assert.equal(s.usuario, '123');
  assert.equal(s.nombre, 'IsTincho');
  assert.equal(s.tipo, 'dueno');
});

test('cookie inventada da null, y sin cookie tambien da null', async () => {
  const req = reqCon('sala_dueno', 'cualquiera.cosa');
  assert.equal(await sesion.leer(req, 'dueno'), null);

  const reqSinCookie = { headers: {} };
  assert.equal(await sesion.leer(reqSinCookie, 'dueno'), null);
});

test('firma adulterada: cambiar un caracter de la firma invalida la cookie', async () => {
  const valor = await sesion.crear({ tipo: 'dueno', usuario: '1', nombre: 'a' });
  const punto = valor.lastIndexOf('.');
  const id = valor.slice(0, punto);
  const firma = valor.slice(punto + 1);
  const ultimo = firma.at(-1);
  const reemplazo = ultimo === 'A' ? 'B' : 'A';
  const firmaAdulterada = firma.slice(0, -1) + reemplazo;

  const req = reqCon('sala_dueno', `${id}.${firmaAdulterada}`);
  assert.equal(await sesion.leer(req, 'dueno'), null);
});

test('id adulterado: cambiar un caracter del id con la firma original invalida la cookie', async () => {
  const valor = await sesion.crear({ tipo: 'dueno', usuario: '1', nombre: 'a' });
  const punto = valor.lastIndexOf('.');
  const id = valor.slice(0, punto);
  const firma = valor.slice(punto + 1);
  const ultimo = id.at(-1);
  const reemplazo = ultimo === 'A' ? 'B' : 'A';
  const idAdulterado = id.slice(0, -1) + reemplazo;

  const req = reqCon('sala_dueno', `${idAdulterado}.${firma}`);
  assert.equal(await sesion.leer(req, 'dueno'), null);
});

test('separacion de sesiones: una cookie de espectador no sirve como cookie de dueno', async () => {
  const valorEspectador = await sesion.crear({ tipo: 'espectador', usuario: '9', nombre: 'mirón' });

  // (a) el valor de la cookie de espectador presentado bajo el nombre sala_dueno
  const reqComoDueno = reqCon('sala_dueno', valorEspectador);
  assert.equal(await sesion.leer(reqComoDueno, 'dueno'), null);

  // (b) el mismo request, con la cookie bajo su nombre correcto, funciona
  // para espectador pero sigue sin servir para dueno
  const reqCorrecto = reqCon('sala_espectador', valorEspectador);
  const comoEspectador = await sesion.leer(reqCorrecto, 'espectador');
  assert.ok(comoEspectador);
  assert.equal(comoEspectador.tipo, 'espectador');
  assert.equal(await sesion.leer(reqCorrecto, 'dueno'), null);
});

test('cerrar borra la sesion: leer da null despues', async () => {
  const valor = await sesion.crear({ tipo: 'dueno', usuario: '5', nombre: 'x' });
  const req = reqCon('sala_dueno', valor);
  assert.ok(await sesion.leer(req, 'dueno'));

  const habiaUna = await sesion.cerrar(req, 'dueno');
  assert.equal(habiaUna, true);
  assert.equal(await sesion.leer(req, 'dueno'), null);
});

test('cabeceraCookie trae HttpOnly, Secure, SameSite=Lax y Path=/; cabeceraBorrar trae Max-Age=0', () => {
  const cabecera = sesion.cabeceraCookie('dueno', 'x');
  assert.match(cabecera, /HttpOnly/);
  assert.match(cabecera, /Secure/);
  assert.match(cabecera, /SameSite=Lax/);
  assert.match(cabecera, /Path=\//);

  const borrar = sesion.cabeceraBorrar('dueno');
  assert.match(borrar, /Max-Age=0/);
});

test('un tipo de sesion desconocido tira, tanto al leer como al crear', async () => {
  const req = reqCon('sala_dueno', 'lo-que-sea.lo-que-sea');
  await assert.rejects(() => sesion.leer(req, 'otro'));
  await assert.rejects(() => sesion.crear({ tipo: 'otro' }));
});

after(async () => {
  await fs.rm(ARCHIVO_SESIONES, { force: true });
  almacen.olvidarCache();
});
