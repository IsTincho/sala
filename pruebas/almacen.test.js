/* ============================================================
   Pruebas de servidor/almacen.js.

   El almacen es el modulo que mas se aparto del patron de CosasStream
   (alla es clave -> valor, aca es coleccion -> documento) y era el
   unico sin una sola prueba. Lo que se prueba es el backend de
   archivos, que es el que corre en local y el que queda como red de
   seguridad cuando Mongo no contesta.

   SALA_DATOS apunta a una carpeta propia: `node --test` corre cada
   archivo de pruebas en un proceso aparte pero sobre el mismo disco, y
   dos suites limpiando servidor/datos a la vez se pisarian.
   ============================================================ */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const CARPETA = path.join(os.tmpdir(), `sala-almacen-${process.pid}-${Date.now()}`);
process.env.SALA_DATOS = CARPETA;

/* Sin URI el almacen arranca en modo archivo, que es lo que se prueba
   aca. Se borran las dos por si la maquina del dueño las tiene
   puestas: un test que se conecte a la base de verdad seria un test
   que escribe en produccion. */
delete process.env.MONGODB_URI;
delete process.env.MONGO_URI;

const almacen = await import('../servidor/almacen.js');

const leerArchivo = async coleccion =>
  JSON.parse(await fs.readFile(path.join(CARPETA, `${coleccion}.json`), 'utf8'));

before(async () => { await fs.rm(CARPETA, { recursive: true, force: true }); });
after(async () => { await fs.rm(CARPETA, { recursive: true, force: true }); });

/* ------------------------------------------------------------ basico */

test('sin MONGODB_URI guarda en archivo y lo dice', () => {
  assert.deepEqual(almacen.dondeGuarda(), { modo: 'archivo', motivo: 'sin MONGODB_URI' });
});

test('poner y obtener: vuelve el documento con su id adentro', async () => {
  assert.equal(await almacen.poner('creadores', 'istincho', { plan: 'dueno', nombre: 'IsTincho' }), true);

  const c = await almacen.obtener('creadores', 'istincho');
  assert.equal(c.id, 'istincho');
  assert.equal(c.plan, 'dueno');
  assert.equal(c.nombre, 'IsTincho');
  assert.ok(c.ts, 'queda anotado cuando se escribio');
});

test('obtener lo que no esta devuelve el default y no inventa nada', async () => {
  assert.equal(await almacen.obtener('creadores', 'no-existe'), null);
  assert.deepEqual(await almacen.obtener('creadores', 'no-existe', { plan: 'gratis' }), { plan: 'gratis' });
});

test('poner reemplaza el documento entero, no lo mezcla', async () => {
  await almacen.poner('videos', 'ep1', { titulo: 'viejo', duracion: 10, extra: 'sobra' });
  await almacen.poner('videos', 'ep1', { titulo: 'nuevo', duracion: 20 });

  const v = await almacen.obtener('videos', 'ep1');
  assert.equal(v.titulo, 'nuevo');
  assert.equal(v.extra, undefined, 'lo de antes no queda pegado');
});

test('el id no se duplica adentro del documento', async () => {
  await almacen.poner('videos', 'ep2', { id: 'otro-id-que-miente', titulo: 'x' });
  const guardado = (await leerArchivo('videos')).ep2;
  assert.equal(guardado.id, undefined, 'el id es la clave, no un campo');
  assert.equal((await almacen.obtener('videos', 'ep2')).id, 'ep2');
});

test('quitar borra y avisa si habia algo', async () => {
  await almacen.poner('sesiones', 'una', { usuario: '1' });
  assert.equal(await almacen.quitar('sesiones', 'una'), true);
  assert.equal(await almacen.obtener('sesiones', 'una'), null);
  assert.equal(await almacen.quitar('sesiones', 'una'), false, 'borrar dos veces no miente');
});

test('un id numerico y uno de texto son el mismo documento', async () => {
  await almacen.poner('tokens', 4242, { red: 'kick' });
  assert.equal((await almacen.obtener('tokens', '4242')).red, 'kick');
  await almacen.quitar('tokens', '4242');
});

test('una coleccion que no existe explota al escribir, no crea una fantasma', async () => {
  await assert.rejects(() => almacen.poner('sesion', 'x', {}), /coleccion desconocida/);
  await assert.rejects(() => almacen.obtener('lo-que-sea', 'x'), /coleccion desconocida/);
  await assert.rejects(() => almacen.listar('lo-que-sea'), /coleccion desconocida/);
});

/* ----------------------------------------------------------- listar */

test('listar devuelve todo, y con filtro solo lo que coincide', async () => {
  for (const [id, doc] of [
    ['ana',  { plan: 'amigo', activo: true }],
    ['beto', { plan: 'pago',  activo: true }],
    ['caro', { plan: 'amigo', activo: false }],
  ]) await almacen.poner('creadores', id, doc);

  const todos = await almacen.listar('creadores');
  assert.ok(todos.length >= 3);
  assert.ok(todos.every(d => d.id), 'cada documento sabe su id');

  const amigos = await almacen.listar('creadores', { plan: 'amigo' });
  assert.deepEqual(amigos.map(d => d.id).sort(), ['ana', 'caro']);

  /* Dos campos: tienen que cumplirse los dos. */
  const amigosActivos = await almacen.listar('creadores', { plan: 'amigo', activo: true });
  assert.deepEqual(amigosActivos.map(d => d.id), ['ana']);

  assert.deepEqual(await almacen.listar('creadores', { plan: 'no-existe' }), []);
});

/* ------------------------------------------------- ids que vienen de afuera

   EL BUG: sobre un objeto normal, `datos['__proto__'] = doc` no crea
   ninguna propiedad, activa el setter heredado. poner() devolvia true
   sin guardar nada y quitar() decia que habia borrado algo que nunca
   existio. Hoy no pasa porque los ids los generamos nosotros; en la
   Fase 3 los ids de creadores y de videos vienen de afuera. */

test('un id llamado __proto__ es un documento como cualquier otro', async () => {
  assert.equal(await almacen.poner('videos', '__proto__', { titulo: 'raro' }), true);

  const v = await almacen.obtener('videos', '__proto__');
  assert.ok(v, 'se guardo de verdad');
  assert.equal(v.titulo, 'raro');
  assert.equal(v.id, '__proto__');

  assert.ok((await almacen.listar('videos')).some(d => d.id === '__proto__'));

  /* Y no se contamino el prototipo de nadie. */
  assert.equal({}.titulo, undefined);

  assert.equal(await almacen.quitar('videos', '__proto__'), true);
  assert.equal(await almacen.obtener('videos', '__proto__'), null);
  assert.equal(await almacen.quitar('videos', '__proto__'), false);
});

test('constructor y toString tampoco confunden al almacen', async () => {
  assert.equal(await almacen.obtener('videos', 'constructor'), null);
  assert.equal(await almacen.quitar('videos', 'toString'), false);
});

/* ------------------------------------------------------ concurrencia */

test('cincuenta escrituras a la vez en la misma coleccion no se pisan', async () => {
  const cuantos = 50;
  await Promise.all(
    Array.from({ length: cuantos }, (_, i) => almacen.poner('sesiones', `s${i}`, { n: i })),
  );

  /* En memoria y en disco tienen que estar las cincuenta: si el
     archivo se escribiera leyendo-modificando-escribiendo, varias se
     perderian. */
  const enDisco = await leerArchivo('sesiones');
  assert.equal(Object.keys(enDisco).length, cuantos);
  for (let i = 0; i < cuantos; i++) {
    assert.equal(enDisco[`s${i}`].n, i, `s${i} tiene que estar en el archivo`);
  }

  const listados = await almacen.listar('sesiones');
  assert.equal(listados.length, cuantos);
});

test('borrar y escribir a la vez tampoco pierde nada', async () => {
  await almacen.poner('sesiones', 'para-borrar', { n: -1 });
  await Promise.all([
    almacen.quitar('sesiones', 'para-borrar'),
    almacen.poner('sesiones', 'nueva', { n: 99 }),
  ]);

  const enDisco = await leerArchivo('sesiones');
  assert.equal(enDisco['para-borrar'], undefined);
  assert.equal(enDisco.nueva.n, 99);
});

test('el archivo se escribe con temporal y rename: nunca queda uno a medias', async () => {
  await almacen.poner('reloj', 'istincho', { videoId: 'ep1', empezoEn: 1 });

  const archivos = await fs.readdir(CARPETA);
  assert.equal(archivos.some(f => f.endsWith('.tmp')), false, 'no quedan temporales huerfanos');

  /* Y lo que quedo es JSON completo, no un archivo truncado. */
  const reloj = await leerArchivo('reloj');
  assert.equal(reloj.istincho.videoId, 'ep1');
});

test('lo escrito sobrevive a olvidar la cache: esta en el disco, no solo en memoria', async () => {
  await almacen.poner('tokens', 'persistente', { red: 'twitch' });
  almacen.olvidarCache();
  assert.equal((await almacen.obtener('tokens', 'persistente')).red, 'twitch');
});

/* ------------------------------------------------------- degradacion */

test('si Mongo no responde se degrada a archivo, lo dice, y no pierde el dato', async () => {
  /* Instancia aparte del modulo (el `?` la separa en el cache de
     modulos) para que lea la URI y arranque creyendo que hay Mongo. La
     URI apunta a un puerto donde no hay nadie. */
  process.env.MONGODB_URI = 'mongodb://usuario:clave-que-no-tiene-que-salir@127.0.0.1:1/sala';
  const degradado = await import('../servidor/almacen.js?degradacion=1');
  delete process.env.MONGODB_URI;

  assert.equal(degradado.dondeGuarda().modo, 'mongo', 'arranca creyendo que hay Mongo');

  assert.equal(await degradado.poner('creadores', 'con-mongo-caido', { plan: 'gratis' }), true);

  const donde = degradado.dondeGuarda();
  assert.equal(donde.modo, 'archivo', 'degrado a archivo en vez de romper');
  assert.match(donde.motivo, /mongo fallo en poner/, 'y dice donde fallo');

  /* REGLA DE ORO: la connection string lleva usuario y clave adentro y
     no puede salir por ningun lado, ni en un motivo ni en un log. */
  assert.equal(donde.motivo.includes('clave-que-no-tiene-que-salir'), false);
  assert.equal(donde.motivo.includes('127.0.0.1'), false);

  /* Y el dato no se perdio: quedo en el archivo. */
  const guardado = await degradado.obtener('creadores', 'con-mongo-caido');
  assert.equal(guardado.plan, 'gratis');
  assert.equal((await leerArchivo('creadores'))['con-mongo-caido'].plan, 'gratis');
});
