/* ============================================================
   Pruebas de servidor/videos.js.

   Dos mitades del mismo modulo, probadas juntas porque comparten el
   almacen: el catalogo de videos de cada sala (revisarFicha, guardar,
   obtener, listar, borrar) y la clave de subida que usa
   `herramientas/subir.py` (generarClave, salaDeLaClave, estadoClave,
   revocarClave).

   SALA_DATOS apunta a una carpeta propia de este archivo: `node --test`
   corre cada suite en un proceso aparte pero sobre el mismo disco, y
   dos suites que pisan servidor/datos a la vez (o pruebas/almacen.test.js
   corriendo en paralelo) se arruinarian entre si.
   ============================================================ */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const CARPETA = path.join(os.tmpdir(), `sala-pruebas-videos-${process.pid}-${Date.now()}`);
process.env.SALA_DATOS = CARPETA;
delete process.env.MONGODB_URI;
delete process.env.MONGO_URI;
/* Se fija a mano y no se hereda del ambiente: `revisarFicha` compara la
   URL de la ficha contra el host de URL_BASE, asi que si esta prueba se
   corriera con la variable que tenga cargada la maquina, el chequeo
   estaria comparando contra otra cosa cada vez. */
process.env.URL_BASE = 'https://sala.example';

const almacen = await import('../servidor/almacen.js');
const videos = await import('../servidor/videos.js');

after(async () => { await fs.rm(CARPETA, { recursive: true, force: true }); });

/* Ficha completa, como la manda `herramientas/subir.py` al terminar de
   convertir y subir un video entero. */
const fichaCompleta = () => ({
  id: 'ep-01',
  slug: 'istincho',
  titulo: 'Episodio uno',
  duracion: 1800,
  url: 'https://cosas-r2.example.dev/istincho/ep-01/playlist.m3u8',
  calidades: [1080, 720, 480],
  subtitulos: [{ idioma: 'es', nombre: 'Español' }],
  bytes: 123456789,
});

/* Ficha corta, como la manda `subir.py --avisar`: sin calidades, sin
   subtitulos, sin bytes, porque ese reintento solo avisa que el video
   ya esta arriba, no vuelve a convertirlo. */
const fichaCorta = () => ({
  id: 'ep-02',
  slug: 'istincho',
  titulo: 'Episodio dos',
  duracion: 900,
  url: 'https://cosas-r2.example.dev/istincho/ep-02/playlist.m3u8',
});

/* --------------------------------------------------- revisarFicha */

test('revisarFicha acepta la ficha completa de subir.py', () => {
  const r = videos.revisarFicha(fichaCompleta());
  assert.ok(r.ficha, 'no tiene que haber error');
  assert.equal(r.ficha.id, 'ep-01');
  assert.equal(r.ficha.slug, 'istincho');
  assert.equal(r.ficha.titulo, 'Episodio uno');
  assert.equal(r.ficha.duracion, 1800);
  assert.deepEqual(r.ficha.calidades, [1080, 720, 480]);
  assert.deepEqual(r.ficha.subtitulos, [{ idioma: 'es', nombre: 'Español' }]);
  assert.equal(r.ficha.bytes, 123456789);
});

test('revisarFicha acepta la ficha corta de --avisar y deja calidades/subtitulos/bytes en blanco', () => {
  const r = videos.revisarFicha(fichaCorta());
  assert.ok(r.ficha, 'no tiene que haber error');
  assert.deepEqual(r.ficha.calidades, []);
  assert.deepEqual(r.ficha.subtitulos, []);
  assert.equal(r.ficha.bytes, 0);
});

test('revisarFicha rechaza un id con mayusculas', () => {
  const r = videos.revisarFicha({ ...fichaCompleta(), id: 'EP-01' });
  assert.match(r.error, /id invalido/);
});

test('revisarFicha rechaza un id vacio', () => {
  const r = videos.revisarFicha({ ...fichaCompleta(), id: '' });
  assert.match(r.error, /id invalido/);
});

test('revisarFicha rechaza un id con barra', () => {
  const r = videos.revisarFicha({ ...fichaCompleta(), id: 'ep/01' });
  assert.match(r.error, /id invalido/);
});

test('revisarFicha rechaza un id con punto', () => {
  const r = videos.revisarFicha({ ...fichaCompleta(), id: 'ep.01' });
  assert.match(r.error, /id invalido/);
});

test('revisarFicha rechaza un slug invalido', () => {
  const r = videos.revisarFicha({ ...fichaCompleta(), slug: 'Sala Rara!' });
  assert.match(r.error, /slug invalido/);
});

test('revisarFicha rechaza duracion 0', () => {
  const r = videos.revisarFicha({ ...fichaCompleta(), duracion: 0 });
  assert.match(r.error, /duracion invalida/);
});

test('revisarFicha rechaza duracion negativa', () => {
  const r = videos.revisarFicha({ ...fichaCompleta(), duracion: -10 });
  assert.match(r.error, /duracion invalida/);
});

test('revisarFicha rechaza duracion mayor a 24 horas', () => {
  const r = videos.revisarFicha({ ...fichaCompleta(), duracion: 24 * 60 * 60 + 1 });
  assert.match(r.error, /duracion invalida/);
});

test('revisarFicha rechaza duracion no numerica', () => {
  const r = videos.revisarFicha({ ...fichaCompleta(), duracion: 'no-es-numero' });
  assert.match(r.error, /duracion invalida/);
});

test('revisarFicha rechaza una url http (tiene que ser https)', () => {
  const r = videos.revisarFicha({ ...fichaCompleta(), url: 'http://cosas-r2.example.dev/x.m3u8' });
  assert.match(r.error, /https/);
});

test('revisarFicha rechaza una url que no termina en .m3u8', () => {
  const r = videos.revisarFicha({ ...fichaCompleta(), url: 'https://cosas-r2.example.dev/x.mp4' });
  assert.match(r.error, /m3u8/);
});

test('revisarFicha rechaza una url que no parsea', () => {
  const r = videos.revisarFicha({ ...fichaCompleta(), url: 'esto no es una url' });
  assert.match(r.error, /url invalida/);
});

test('revisarFicha rechaza una url de mas de 500 caracteres', () => {
  const relleno = 'a'.repeat(500);
  const url = `https://cosas-r2.example.dev/${relleno}.m3u8`;
  assert.ok(url.length > 500);
  const r = videos.revisarFicha({ ...fichaCompleta(), url });
  assert.match(r.error, /demasiado larga/);
});

test('revisarFicha rechaza un titulo vacio', () => {
  const r = videos.revisarFicha({ ...fichaCompleta(), titulo: '   ' });
  assert.match(r.error, /falta el titulo/);
});

/* --------------------------------------- la url NO puede ser nuestra

   Es la invariante mas cara del proyecto: el servidor no sirve video, y
   una ficha que apunta a nuestro propio dominio manda a trescientos
   navegadores a pedirle los segmentos a Railway. El comentario de
   `revisarFicha` lo prometia desde que se escribio; el codigo no lo
   hacia, y la verificacion de la Fase 2 lo cazo con un POST que
   contestaba 200. */

test('revisarFicha rechaza una url que apunta a nuestro propio dominio', () => {
  /* URL_BASE es https://sala.example (arriba del archivo). */
  const r = videos.revisarFicha({
    ...fichaCompleta(),
    url: 'https://sala.example/istincho/ep-01/playlist.m3u8',
  });
  assert.ok(r.error, 'esto tiene que ser un error, no una ficha');
  assert.match(r.error, /este mismo servidor/);
  assert.equal(r.ficha, undefined);
});

test('la comparacion del host ignora el puerto y las mayusculas', () => {
  /* `host` llevaria el puerto y dejaria pasar sala.example:8443, que es
     igual de nuestra. Por eso se compara `hostname`. */
  for (const url of [
    'https://sala.example:8443/x/maestra.m3u8',
    'https://SALA.EXAMPLE/x/maestra.m3u8',
  ]) {
    const r = videos.revisarFicha({ ...fichaCompleta(), url });
    assert.match(r.error ?? '', /este mismo servidor/, url);
  }
});

test('un host que solo se PARECE al nuestro pasa: no se rechaza de mas', () => {
  /* El chequeo compara el hostname entero. Un subdominio o un dominio
     que lo contenga es otro host y tiene que poder servir video. */
  for (const url of [
    'https://videos.sala.example/x/maestra.m3u8',
    'https://sala.example.attacker.test/x/maestra.m3u8',
    'https://pub-abc123.r2.dev/istincho/ep-01/maestra.m3u8',
  ]) {
    const r = videos.revisarFicha({ ...fichaCompleta(), url });
    assert.ok(r.ficha, `${url} tendria que pasar y dio: ${r.error}`);
  }
});

test('revisarFicha rechaza loopback aunque no haya URL_BASE cargada', () => {
  /* En local URL_BASE no esta, asi que el chequeo de arriba es un
     no-op: este es el que queda. Y es cierto por si mismo, con o sin
     variable: un playlist en 127.0.0.1 apunta a la maquina del que
     mira. Es tambien el repro exacto de la verificacion. */
  for (const url of [
    'https://localhost:8821/sala/x.m3u8',
    'https://127.0.0.1:8821/sala/x.m3u8',
    'https://[::1]:8821/sala/x.m3u8',
    'https://0.0.0.0/sala/x.m3u8',

    /* Las formas raras de escribir lo mismo. Las cuatro primeras las
       normaliza sola la URL de Node (127.1, el hexadecimal, el entero
       de 32 bits y el IPv6 largo dan todas el mismo `hostname`); el
       punto final de la forma absoluta NO lo saca, y se escapaba de la
       comparacion por un caracter. */
    'https://127.1/sala/x.m3u8',
    'https://0x7f.0.0.1/sala/x.m3u8',
    'https://2130706433/sala/x.m3u8',
    'https://[0:0:0:0:0:0:0:1]/sala/x.m3u8',
    'https://LocalHost/sala/x.m3u8',
    'https://localhost./sala/x.m3u8',
  ]) {
    const r = videos.revisarFicha({ ...fichaCompleta(), url }, { hostPropio: '' });
    assert.ok(r.error, `${url} tendria que dar error`);
    assert.match(r.error, /esta misma maquina/);
  }
});

test('el punto final de la forma absoluta tampoco esquiva el host propio', () => {
  /* `sala.example.` y `sala.example` son el mismo lugar para cualquier
     resolver: si uno se rechaza, el otro tambien. */
  const r = videos.revisarFicha({
    ...fichaCompleta(),
    url: 'https://sala.example./istincho/ep-01/playlist.m3u8',
  });
  assert.match(r.error ?? '', /este mismo servidor/);
});

test('hostPropio sale de URL_BASE y aguanta que no este o que sea basura', () => {
  const antes = process.env.URL_BASE;
  try {
    process.env.URL_BASE = 'https://sala-production.up.railway.app';
    assert.equal(videos.hostPropio(), 'sala-production.up.railway.app');

    /* Con puerto y con barra al final sigue siendo el mismo host. */
    process.env.URL_BASE = 'https://sala.example:8443/';
    assert.equal(videos.hostPropio(), 'sala.example');

    /* Sin variable no se sabe cual es nuestro host: '' y el chequeo de
       loopback es el que sostiene la invariante. */
    delete process.env.URL_BASE;
    assert.equal(videos.hostPropio(), '');

    process.env.URL_BASE = 'no es una url';
    assert.equal(videos.hostPropio(), '', 'una URL_BASE rota no puede tirar');
  } finally {
    process.env.URL_BASE = antes;
  }
});

/* ------------------------------- el titulo no puede inventar un log */

test('el titulo no puede meter una linea falsa en el log', () => {
  /*
   * EL BUG QUE ESTO ATAJA, con la salida real que consiguio la
   * verificacion de la Fase 2.
   *
   * El titulo sale del nombre del archivo que se le pasa a subir.py, y
   * `index.js` lo mete tal cual en un `console.log`. Un \n adentro
   * parte esa linea en dos y la segunda la escribe quien subio el
   * video. Los logs de Railway no se borran y son la unica evidencia
   * cuando algo falla.
   */
  const veneno = 'Episodio 1\n[http] POST /api/panel 200 clave=FALSA';
  const { ficha, error } = videos.revisarFicha({ ...fichaCompleta(), titulo: veneno });

  assert.equal(error, undefined, 'no se rechaza: se limpia');
  assert.equal(ficha.titulo.includes('\n'), false, 'el titulo no puede llevar un salto de linea');
  assert.equal(ficha.titulo, 'Episodio 1 [http] POST /api/panel 200 clave=FALSA',
    'el texto se conserva entero, en UNA sola linea');
});

test('el titulo se queda sin ningun caracter de control, de los cuatro grupos', () => {
  /* C0, DEL, C1 y los dos separadores de linea de Unicode. Cada uno
     hace dano en un lugar distinto: \r reescribe la linea en una
     terminal, \t separa columnas en un log, \u001b abre una secuencia
     ANSI, y \u2028 corta linea en un contexto JS.

     Se escriben con escapes a proposito: un caracter de control de
     verdad adentro de este archivo es justo lo que esta prueba
     prohibe, y encima no sobrevive un copiar y pegar. */
  const casos = [
    ['a\u0000b', 'a b'],                     // NUL
    ['a\rb', 'a b'],                         // CR
    ['a\r\nb', 'a b'],                       // CRLF, colapsado a un espacio
    ['a\tb', 'a b'],                         // TAB
    ['a\u007Fb', 'a b'],                     // DEL
    ['a\u009Bb', 'a b'],                     // C1 (CSI)
    ['a\u2028b', 'a b'],                     // separador de linea
    ['a\u2029b', 'a b'],                     // separador de parrafo
    ['a\u001b[31mrojo', 'a [31mrojo'],       // el ESC de una secuencia ANSI
  ];

  const HAY_CONTROL = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/;

  for (const [entrada, esperado] of casos) {
    const { ficha } = videos.revisarFicha({ ...fichaCompleta(), titulo: entrada });
    assert.equal(ficha.titulo, esperado, JSON.stringify(entrada));
    assert.equal(HAY_CONTROL.test(ficha.titulo), false,
      `quedaron controles en ${JSON.stringify(ficha.titulo)}`);
  }
});

test('los nombres de los subtitulos se limpian igual que el titulo', () => {
  /* Salen de los metadatos del mismo archivo y valen lo mismo. */
  const { ficha } = videos.revisarFicha({
    ...fichaCompleta(),
    subtitulos: [{ idioma: 'es\n', nombre: 'Espanol\r\n[http] falso' }],
  });
  assert.equal(ficha.subtitulos[0].idioma, 'es');
  assert.equal(ficha.subtitulos[0].nombre, 'Espanol [http] falso');
});

test('limpiar no come el texto: junta, no borra', () => {
  /* Si los controles se borraran en vez de reemplazarse por un espacio,
     "hola\nchau" quedaria "holachau" y el titulo diria otra cosa. */
  assert.equal(videos.limpiar('hola\nchau'), 'hola chau');
  assert.equal(videos.limpiar('  espacios   de   sobra  '), 'espacios de sobra');
  assert.equal(videos.limpiar('Los Simpson S01E03'), 'Los Simpson S01E03');
  assert.equal(videos.limpiar(null), '');
});

test('un titulo que es SOLO controles se rechaza como vacio', () => {
  const r = videos.revisarFicha({ ...fichaCompleta(), titulo: '\n\r\t' });
  assert.match(r.error, /falta el titulo/);
});

/* ------------------------------------------------- guardar / obtener / listar */

test('guardar dos veces el mismo id pisa, no duplica', async () => {
  const { ficha } = videos.revisarFicha(fichaCompleta());
  await videos.guardar(ficha);
  await videos.guardar({ ...ficha, titulo: 'Episodio uno (retocado)' });

  const lista = await videos.listar(ficha.slug);
  const coincidencias = lista.filter(v => v.id === ficha.id);
  assert.equal(coincidencias.length, 1, 'no tiene que duplicarse');
  assert.equal(coincidencias[0].titulo, 'Episodio uno (retocado)', 'y tiene que quedar la version nueva');
});

test('dos slugs distintos con el mismo id no se pisan entre si', async () => {
  const { ficha: fichaA } = videos.revisarFicha({ ...fichaCompleta(), id: 'compartido', slug: 'sala-a' });
  const { ficha: fichaB } = videos.revisarFicha({ ...fichaCompleta(), id: 'compartido', slug: 'sala-b', titulo: 'Otro titulo' });

  await videos.guardar(fichaA);
  await videos.guardar(fichaB);

  const a = await videos.obtener('sala-a', 'compartido');
  const b = await videos.obtener('sala-b', 'compartido');
  assert.equal(a.titulo, 'Episodio uno');
  assert.equal(b.titulo, 'Otro titulo');
});

test('listar devuelve del video mas nuevo al mas viejo', async () => {
  const slug = 'orden-de-listado';
  /* Se escribe directo en el almacen, con un `subido` explicito, para
     que el orden no dependa de que tan rapido corre la maquina que
     ejecuta el test (guardar() usa Date.now() y dos llamadas seguidas
     podrian caer en el mismo milisegundo). */
  const doc = (id, subido) => ({
    videoId: id, slug, titulo: `video ${id}`, duracion: 60,
    url: 'https://cosas-r2.example.dev/x.m3u8', calidades: [], subtitulos: [], bytes: 0, subido,
  });
  await almacen.poner('videos', `${slug}:viejo`, doc('viejo', 1000));
  await almacen.poner('videos', `${slug}:medio`, doc('medio', 2000));
  await almacen.poner('videos', `${slug}:nuevo`, doc('nuevo', 3000));

  const lista = await videos.listar(slug);
  assert.deepEqual(lista.map(v => v.id), ['nuevo', 'medio', 'viejo']);
});

test('borrar devuelve true la primera vez y false la segunda', async () => {
  const { ficha } = videos.revisarFicha({ ...fichaCompleta(), id: 'para-borrar', slug: 'borrado' });
  await videos.guardar(ficha);

  assert.equal(await videos.borrar('borrado', 'para-borrar'), true);
  assert.equal(await videos.borrar('borrado', 'para-borrar'), false);
});

test('obtener/borrar/listar con id o slug invalidos no tiran, devuelven vacio', async () => {
  assert.equal(await videos.obtener('Sala Invalida!', 'ep-01'), null);
  assert.equal(await videos.obtener('istincho', 'ID-MAYUSCULA'), null);
  assert.equal(await videos.borrar('Sala Invalida!', 'ep-01'), false);
  assert.equal(await videos.borrar('istincho', 'ID-MAYUSCULA'), false);
  assert.deepEqual(await videos.listar('Sala Invalida!'), []);
});

/* ------------------------------------------------------- clave de subida */

test('generarClave da una clave distinta cada vez, de al menos 32 caracteres', async () => {
  const a = await videos.generarClave('clave-slug-a');
  const b = await videos.generarClave('clave-slug-a');
  assert.ok(a.length >= 32);
  assert.ok(b.length >= 32);
  assert.notEqual(a, b);
});

test('salaDeLaClave reconoce la clave de su sala y no la de otra', async () => {
  const claveA = await videos.generarClave('sala-clave-a');
  await videos.generarClave('sala-clave-b');

  assert.equal(await videos.salaDeLaClave(claveA), 'sala-clave-a');
  assert.equal(await videos.salaDeLaClave('clave-que-no-existe-para-nadie'), '');
});

test('salaDeLaClave con clave vacia, null o undefined da string vacio sin tirar', async () => {
  assert.equal(await videos.salaDeLaClave(''), '');
  assert.equal(await videos.salaDeLaClave(null), '');
  assert.equal(await videos.salaDeLaClave(undefined), '');
});

test('estadoClave nunca devuelve la clave ni el hash', async () => {
  const slug = 'sala-estado-clave';
  const clave = await videos.generarClave(slug);

  const estado = await videos.estadoClave(slug);
  assert.equal(estado.hay, true);
  assert.ok(estado.creada > 0);

  const comoTexto = JSON.stringify(estado);
  assert.equal(comoTexto.includes(clave), false, 'la clave en claro no puede aparecer');
  assert.equal(comoTexto.toLowerCase().includes('hash'), false, 'ni la palabra hash ni el campo');
});

test('revocarClave hace que salaDeLaClave deje de reconocerla', async () => {
  const slug = 'sala-revocada';
  const clave = await videos.generarClave(slug);
  assert.equal(await videos.salaDeLaClave(clave), slug);

  await videos.revocarClave(slug);
  assert.equal(await videos.salaDeLaClave(clave), '');
  assert.equal((await videos.estadoClave(slug)).hay, false);
});

test('generar una clave nueva invalida la anterior', async () => {
  const slug = 'sala-clave-renovada';
  const vieja = await videos.generarClave(slug);
  const nueva = await videos.generarClave(slug);

  assert.equal(await videos.salaDeLaClave(vieja), '', 'la vieja ya no sirve');
  assert.equal(await videos.salaDeLaClave(nueva), slug, 'la nueva si');
});

test('la clave en claro no queda guardada en el almacen', async () => {
  const slug = 'sala-clave-en-claro';
  const clave = await videos.generarClave(slug);

  const doc = await almacen.obtener('subidas', slug);
  assert.ok(doc, 'tiene que existir el documento');
  assert.equal(JSON.stringify(doc).includes(clave), false, 'la clave en claro no puede estar en el documento guardado');
});
