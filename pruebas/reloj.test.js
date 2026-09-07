/* ============================================================
   Pruebas de servidor/reloj.js.

   El reloj es aritmetica sobre timestamps mas un puñado de guardas
   contra el dedo pesado (doble click, doble pestaña del panel). Las
   guardas son el corazon de este archivo: varias de ellas evitan bugs
   reales (pausar dos veces adelantando la posicion, saltar pasandose
   de la duracion, reanudar contando el tiempo pausado) que no se ven
   con un test que solo mira "el estado cambio", hay que mirar los
   NUMEROS que quedan.

   Por eso:
   - `posicion()` se prueba pasando siempre un `ahora` explicito: nunca
     hay que dormir el test ni depender del reloj de pared para saber
     si la cuenta da bien.
   - Las acciones (`aplicar`) SI usan `Date.now()` de adentro (no
     reciben un `ahora` como parametro), asi que donde hace falta un
     tramo de tiempo real entre dos llamadas (el bug de pausar dos
     veces, el de reanudar contando la pausa) se usan esperas reales
     pero CORTAS (decenas o cientos de ms), con tolerancias generosas.
     Es la unica forma honesta de ejercitar esas guardas sin tocar el
     reloj del sistema.

   Cada test usa su propio slug de canal (y su propio video, con el
   mismo slug) para no arrastrar estado de un test a otro: el almacen
   de archivo vive para todo el proceso, y `canales.cerrarTodo()` en el
   afterEach borra la memoria pero no el almacen.
   ============================================================ */

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const DATOS = path.join(os.tmpdir(), 'sala-pruebas-reloj');
process.env.SALA_DATOS = DATOS;
/* reloj.js no usa cifrado, pero se pone igual: si algun dia otro
   modulo que se importa desde aca empieza a necesitarlo, no hay que
   acordarse de agregarlo. */
process.env.CLAVE_CIFRADO = crypto.randomBytes(32).toString('base64');

const almacen = await import('../servidor/almacen.js');
const canales = await import('../servidor/canales.js');
const videos = await import('../servidor/videos.js');
const reloj = await import('../servidor/reloj.js');

test.after(async () => {
  await fsp.rm(DATOS, { recursive: true, force: true });
});

afterEach(() => canales.cerrarTodo());

const esperar = ms => new Promise(ok => setTimeout(ok, ms));

/** Guarda una ficha de video de mentira para un slug dado. */
async function guardarVideo(slug, extra = {}) {
  await videos.guardar({
    id: 'ep1',
    slug,
    titulo: 'Episodio 1',
    duracion: 1200,
    url: `https://pub-ejemplo.r2.dev/${slug}/ep1/maestra.m3u8`,
    calidades: [720],
    subtitulos: [{ idioma: 'es', nombre: 'Español' }],
    bytes: 1,
    ...extra,
  });
}

/* Copiada de pruebas/canales.test.js a proposito (nota de la tarea: no
   importarla). Simula una respuesta HTTP SSE y parsea los eventos. */
class ResFalsa {
  constructor() { this.escrito = ''; this.terminada = false; this.cabeceras = null; }
  writeHead(codigo, cabeceras) { this.codigo = codigo; this.cabeceras = cabeceras; return this; }
  write(s) {
    if (this.terminada) throw new Error('la respuesta ya se cerro');
    this.escrito += s;
    return true;
  }
  end() { this.terminada = true; }

  get eventos() {
    return this.escrito.split('\n\n').filter(b => b.includes('data:')).map(bloque => {
      const campos = { data: [] };
      for (const linea of bloque.split('\n')) {
        const i = linea.indexOf(':');
        if (i < 0) continue;
        const campo = linea.slice(0, i);
        const valor = linea.slice(i + 1).replace(/^ /, '');
        if (campo === 'data') campos.data.push(valor);
        else campos[campo] = valor;
      }
      return campos;
    });
  }

  get datos() { return this.eventos.map(e => JSON.parse(e.data.join('\n'))); }
}

function conectar(slug) {
  const req = new EventEmitter();
  const res = new ResFalsa();
  canales.suscribir(slug, req, res);
  return { req, res };
}

/* --------------------------------------------------------- posicion */

test('posicion: reproduciendo avanza con el tiempo (ahora explicito)', () => {
  const r = { estado: 'reproduciendo', videoId: 'x', empezoEn: 1000, pausadoEn: null, offsetInicial: 10 };
  assert.equal(reloj.posicion(r, 1000), 10);
  assert.equal(reloj.posicion(r, 3000), 12);
  assert.equal(reloj.posicion(r, 11000), 20);
});

test('posicion: pausado se queda congelada aunque pase mucho tiempo', () => {
  const r = { estado: 'pausado', videoId: 'x', empezoEn: 0, pausadoEn: 5000, offsetInicial: 2 };
  const p = reloj.posicion(r, 6000);
  assert.equal(p, 7);
  assert.equal(reloj.posicion(r, 999_999_999), p, 'pase el tiempo que pase, es la misma');
});

test('posicion: detenido da siempre 0', () => {
  assert.equal(reloj.posicion(reloj.DETENIDO, Date.now()), 0);
  assert.equal(reloj.posicion(null, Date.now()), 0);
  assert.equal(reloj.posicion({ estado: 'detenido', videoId: '' }, Date.now()), 0);
});

test('posicion: nunca da negativo', () => {
  const r = { estado: 'reproduciendo', videoId: 'x', empezoEn: 10_000, pausadoEn: null, offsetInicial: 0 };
  assert.equal(reloj.posicion(r, 5000), 0, 'ahora antes que empezoEn no puede dar negativo');
});

/* ---------------------------------------------------------- reproducir */

test('aplicar reproducir: arranca en 0, y trae la ficha del video', async () => {
  await guardarVideo('canal-reloj');
  const r = await reloj.aplicar('canal-reloj', 'reproducir', { videoId: 'ep1' });

  assert.equal(r.error, undefined);
  assert.equal(r.reloj.estado, 'reproduciendo');
  assert.equal(r.reloj.offsetInicial, 0);
  assert.equal(r.reloj.pausadoEn, null);
  assert.equal(r.reloj.url, 'https://pub-ejemplo.r2.dev/canal-reloj/ep1/maestra.m3u8');
  assert.equal(r.reloj.titulo, 'Episodio 1');
  assert.equal(r.reloj.duracion, 1200);
  assert.deepEqual(r.reloj.subtitulos, [{ idioma: 'es', nombre: 'Español' }]);
});

test('aplicar reproducir con un videoId que no esta en el catalogo no toca el reloj', async () => {
  const antes = await reloj.leer('canal-reloj-invalido');
  assert.equal(antes.estado, 'detenido');

  const r = await reloj.aplicar('canal-reloj-invalido', 'reproducir', { videoId: 'no-existe' });
  assert.ok(r.error);

  const despues = await reloj.leer('canal-reloj-invalido');
  assert.deepEqual(despues, antes);
});

/* -------------------------------------------------------------- pausar */

test('pausar dos veces seguidas no adelanta la posicion (el bug real)', async () => {
  await guardarVideo('canal-reloj-pausar');
  await reloj.aplicar('canal-reloj-pausar', 'reproducir', { videoId: 'ep1' });
  await esperar(30);

  const r1 = await reloj.aplicar('canal-reloj-pausar', 'pausar', {});
  await esperar(30);
  const r2 = await reloj.aplicar('canal-reloj-pausar', 'pausar', {});

  assert.equal(r2.reloj.pausadoEn, r1.reloj.pausadoEn,
    'el segundo pausar no puede recalcular pausadoEn contra el empezoEn viejo');
  assert.equal(r2.reloj.empezoEn, r1.reloj.empezoEn);

  const pos1 = reloj.posicion(r1.reloj, Date.now());
  const pos2 = reloj.posicion(r2.reloj, Date.now());
  assert.equal(pos1, pos2, 'pausar lo ya pausado no mueve la posicion');
});

/* ------------------------------------------------------------ reanudar */

test('reanudar arranca un tramo nuevo: el tiempo pausado no cuenta', async () => {
  await guardarVideo('canal-reloj-reanudar');
  await reloj.aplicar('canal-reloj-reanudar', 'reproducir', { videoId: 'ep1' });
  await esperar(50);                                             // reproduce un rato

  const rPausa = await reloj.aplicar('canal-reloj-reanudar', 'pausar', {});
  const posEnPausa = reloj.posicion(rPausa.reloj, Date.now());

  await esperar(1200);                                           // pausado un buen rato

  const rReanuda = await reloj.aplicar('canal-reloj-reanudar', 'reanudar', {});
  const posJustoDespues = reloj.posicion(rReanuda.reloj, Date.now());

  /* Los dos numeros son a proposito: 1,2 s de pausa contra medio
     segundo de tolerancia. Esta posicion se mide contra el reloj de
     pared, o sea que se le suma lo que tarde la escritura en el
     almacen; con 0,3 s de pausa y 0,1 s de tolerancia, una escritura
     lenta hacia fallar la prueba una de cada diez corridas SIN que
     nada estuviera roto. Con esta distancia, el bug que ataja (contar
     el tiempo pausado) da 1,2 s y se sigue cazando, y el ruido de la
     maquina tiene tres veces mas lugar del que necesita. */
  assert.ok(
    Math.abs(posJustoDespues - posEnPausa) < 0.5,
    `la posicion al reanudar (${posJustoDespues}) tiene que ser casi igual a la de la pausa (${posEnPausa})`,
  );
  /* El offsetInicial del tramo nuevo tiene que ser EXACTAMENTE la
     posicion congelada en la pausa (posicion() para un reloj pausado
     no depende de "ahora"): si reanudar se olvidara de sumar el tiempo
     que se jugo ANTES de pausar (y dejara el offsetInicial viejo), la
     posicion despues de reanudar seguiria dando "casi igual" con la
     tolerancia de arriba cuando el tramo jugado es corto, y ese bug se
     escaparia. Esta comparacion es exacta a proposito. */
  assert.equal(rReanuda.reloj.offsetInicial, posEnPausa);
});

test('reanudar sobre algo que ya esta reproduciendo no rompe ni mueve el tramo', async () => {
  await guardarVideo('canal-reloj-reanudar-ya');
  await reloj.aplicar('canal-reloj-reanudar-ya', 'reproducir', { videoId: 'ep1' });
  const antes = await reloj.leer('canal-reloj-reanudar-ya');

  await esperar(30);
  const r = await reloj.aplicar('canal-reloj-reanudar-ya', 'reanudar', {});

  assert.equal(r.reloj.empezoEn, antes.empezoEn, 'no arranca un tramo nuevo si ya estaba corriendo');
  assert.equal(r.reloj.offsetInicial, antes.offsetInicial);
});

/* -------------------------------------------------------------- saltar */

test('saltar adelanta y atrasa, recortado contra la duracion del video', async () => {
  await guardarVideo('canal-reloj-saltar', { duracion: 1200 });
  await reloj.aplicar('canal-reloj-saltar', 'reproducir', { videoId: 'ep1' });

  const rAdelante = await reloj.aplicar('canal-reloj-saltar', 'saltar', { segundos: 5000 });
  assert.equal(rAdelante.reloj.offsetInicial, 1200, 'no puede pasarse de la duracion');

  const rAtras = await reloj.aplicar('canal-reloj-saltar', 'saltar', { segundos: -5000 });
  assert.equal(rAtras.reloj.offsetInicial, 0, 'no puede bajar de 0');
});

test('saltar con un numero de segundos disparatado se rechaza sin tocar el reloj', async () => {
  await guardarVideo('canal-reloj-saltar-tope');
  await reloj.aplicar('canal-reloj-saltar-tope', 'reproducir', { videoId: 'ep1' });
  const antes = await reloj.leer('canal-reloj-saltar-tope');

  /* +99999 y -99999 superan TOPE_SALTO (24hs en segundos = 86400), asi
     que caen en la validacion de "segundos invalidos" antes de llegar
     siquiera al recorte contra la duracion del video. Documentado
     aca porque a primera vista uno esperaria que se recortaran contra
     la duracion en vez de rechazarse. */
  for (const segundos of [99999, -99999]) {
    const r = await reloj.aplicar('canal-reloj-saltar-tope', 'saltar', { segundos });
    assert.ok(r.error, `saltar ${segundos} tiene que rechazarse`);
  }

  const despues = await reloj.leer('canal-reloj-saltar-tope');
  assert.deepEqual(despues, antes, 'un salto rechazado no toca el reloj');
});

test('saltar estando pausado deja el reloj pausado en la posicion nueva', async () => {
  await guardarVideo('canal-reloj-saltar-pausado');
  await reloj.aplicar('canal-reloj-saltar-pausado', 'reproducir', { videoId: 'ep1' });
  await reloj.aplicar('canal-reloj-saltar-pausado', 'pausar', {});

  const r = await reloj.aplicar('canal-reloj-saltar-pausado', 'saltar', { segundos: 50 });
  assert.equal(r.reloj.estado, 'pausado', 'saltar no despausa');
  assert.ok(Number.isFinite(r.reloj.pausadoEn) && r.reloj.pausadoEn !== null);
  assert.equal(r.reloj.pausadoEn, r.reloj.empezoEn, 'el tramo nuevo arranca y termina en el mismo instante');
});

/* --------------------------------------------------------- detenido */

test('pausar, reanudar y saltar con el reloj detenido devuelven error', async () => {
  const slug = 'canal-reloj-guardas-detenido';
  assert.equal((await reloj.leer(slug)).estado, 'detenido');

  const rPausar = await reloj.aplicar(slug, 'pausar', {});
  assert.ok(rPausar.error);

  const rReanudar = await reloj.aplicar(slug, 'reanudar', {});
  assert.ok(rReanudar.error);

  const rSaltar = await reloj.aplicar(slug, 'saltar', { segundos: 10 });
  assert.ok(rSaltar.error);

  assert.equal((await reloj.leer(slug)).estado, 'detenido', 'ninguna de las tres toco el reloj');
});

/* ---------------------------------------------------------- detener */

test('detener deja el estado detenido y borra el documento del almacen', async () => {
  const slug = 'canal-reloj-detener';
  await guardarVideo(slug);
  await reloj.aplicar(slug, 'reproducir', { videoId: 'ep1' });
  assert.ok(await almacen.obtener('reloj', slug), 'antes de detener hay algo guardado');

  const r = await reloj.aplicar(slug, 'detener', {});
  assert.equal(r.reloj.estado, 'detenido');
  assert.equal(await almacen.obtener('reloj', slug), null, 'detener borra el documento');
});

test('detener libera el canal de la memoria si no quedo nadie mirando', async () => {
  /*
   * LAS DOS MITADES QUE NO COINCIDIAN.
   *
   * `canales.js` no borra un canal que tenga `reloj` puesto, porque un
   * reloj es estado real. Pero `aplicarYDifundir` dejaba puesto TAMBIEN
   * el de "detenido", que es un objeto igual de truthy que el de
   * "reproduciendo" y sin embargo es la AUSENCIA de estado. Resultado:
   * un canal que se detuvo y del que se fue todo el mundo se quedaba en
   * el Map para siempre.
   *
   * `restaurar()` ya trataba la ausencia como corresponde del otro lado
   * (si no hay nada guardado no pone reloj ni crea el canal), asi que
   * las dos mitades decian cosas distintas sobre lo mismo.
   *
   * Con un creador da igual. Con mil, el Map no respira nunca.
   */
  const slug = 'canal-reloj-liberado';
  await guardarVideo(slug);

  /* Alguien mirando, para que el canal exista de verdad y el evento de
     detener tenga a quien llegarle. */
  const { req, res } = conectar(slug);
  await reloj.aplicar(slug, 'reproducir', { videoId: 'ep1' });

  /*
   * LA ASERCION QUE ESTABA MAL, Y POR QUE.
   *
   * Aca decia `hayCanal(slug) === true`, y eso era verdad SIN QUE EL
   * ARREGLO EXISTIERA: hay un cliente conectado, asi que `soltarSiVacio`
   * no borra nada aunque el reloj este tirado. La mutacion que importa
   * —llamar a `olvidarReloj` SIEMPRE y no solo al detener— pasaba
   * entera: se lleva puesto el reloj de "reproduciendo" y la prueba
   * seguia en verde.
   *
   * Lo que hay que mirar es el RELOJ del canal, que es lo que se le
   * manda al que se conecta despues (`canales.estadoDe`). Si no esta,
   * cualquiera que abra la sala con la peli andando recibe `reloj: null`
   * y ve "todavia no empezo la pelicula" para siempre. Es el tercer test
   * de esta fase que pasaba por el motivo equivocado.
   */
  assert.ok(canales.hayCanal(slug), 'con la peli puesta el canal existe');
  const puesto = canales.canal(slug).reloj;
  assert.ok(puesto, 'reproducir tiene que DEJAR el reloj puesto en el canal');
  assert.equal(puesto.estado, 'reproduciendo');
  assert.equal(puesto.videoId, 'ep1');

  await reloj.aplicar(slug, 'detener', {});

  /* El que estaba mirando SI se tiene que haber enterado: liberar no
     puede significar no avisar. */
  const detenido = res.datos.filter(d => d.tipo === 'reloj' && d.estado === 'detenido');
  assert.equal(detenido.length, 1, 'el evento de detenido tiene que salir igual por el bus');

  /* Todavia hay alguien conectado: el canal no se puede borrar. Pero el
     reloj SI se solto, y eso es lo que hace que el que se conecte ahora
     reciba `reloj: null` en el `estado` y vea la pantalla de espera. */
  assert.equal(canales.hayCanal(slug), true, 'con gente mirando el canal se queda');
  assert.equal(canales.canal(slug).reloj, null, 'detenido es la AUSENCIA de reloj, no un reloj');

  /* Y cuando se va el ultimo, ahi si. */
  req.emit('close');
  assert.equal(canales.conectados(slug), 0);
  assert.equal(canales.hayCanal(slug), false,
    'un canal detenido y sin nadie mirando no tiene por que seguir en memoria');
});

test('detener no se lleva puesto el canal que todavia tiene mensajes', async () => {
  /* El buffer de los ultimos 200 mensajes tambien es estado que hay que
     recordar: el que se conecta despues se los tiene que llevar. */
  const slug = 'canal-reloj-con-mensajes';
  await guardarVideo(slug);
  const { req } = conectar(slug);
  canales.recordar(slug, { tipo: 'chat', red: 'kick', id: 'm1', texto: 'hola' });

  await reloj.aplicar(slug, 'reproducir', { videoId: 'ep1' });
  await reloj.aplicar(slug, 'detener', {});
  req.emit('close');

  assert.equal(canales.hayCanal(slug), true, 'el canal con mensajes guardados se queda');
  assert.equal(canales.ultimos(slug).length, 1);
});

test('leer despues de detener sigue diciendo detenido, no null', async () => {
  /* Al soltar el reloj de la memoria, `leer` cae al almacen. Ahi
     tampoco hay nada (detener borra el documento), y eso tiene que
     seguir leyendose como "detenido" y no como un error. */
  const slug = 'canal-reloj-leer-detenido';
  await guardarVideo(slug);
  conectar(slug);

  await reloj.aplicar(slug, 'reproducir', { videoId: 'ep1' });
  await reloj.aplicar(slug, 'detener', {});

  const despues = await reloj.leer(slug);
  assert.equal(despues.estado, 'detenido');
  assert.equal(despues.videoId, '');

  /* Y lo que sale por HTTP para el panel, igual. */
  const cable = await reloj.actual(slug);
  assert.equal(cable.estado, 'detenido');
  assert.equal(cable.posicion, 0);
});

/* ------------------------------------------------------------- difusion */

test('cada cambio se difunde por SSE sin nombre, con el tipo adentro del data', async () => {
  const slug = 'canal-reloj-sse';
  await guardarVideo(slug);
  const { res } = conectar(slug);

  await reloj.aplicar(slug, 'reproducir', { videoId: 'ep1' });

  const eventoReloj = res.datos.find(d => d.tipo === 'reloj' && d.videoId === 'ep1');
  assert.ok(eventoReloj, 'tiene que llegar un evento de tipo reloj');
  assert.equal(eventoReloj.estado, 'reproduciendo');

  /* Ninguno de los bloques SSE puede tener `event:`, sea cual sea el
     tipo: si lo tuviera, un EventSource sin addEventListener(tipo,...)
     jamas lo recibiria. */
  for (const bloque of res.eventos) {
    assert.equal(bloque.event, undefined);
  }
});

/* ---------------------------------------------------------- restaurar */

test('restaurar levanta el reloj guardado y lo sigue calculando desde el empezoEn original', async () => {
  const slug = 'canal-reloj-restaurar-ok';
  await guardarVideo(slug);
  await reloj.aplicar(slug, 'reproducir', { videoId: 'ep1' });

  canales.cerrarTodo();                      // como si el servidor recien arrancara
  assert.equal(canales.hayCanal(slug), false);

  const cable = await reloj.restaurar(slug);
  assert.ok(cable);
  assert.equal(cable.estado, 'reproduciendo');
  assert.equal(cable.videoId, 'ep1');
  assert.equal(canales.hayCanal(slug), true, 'restaurar deja el canal puesto');

  const estado = await reloj.leer(slug);
  const p1 = reloj.posicion(estado, cable.ahora);
  const p2 = reloj.posicion(estado, cable.ahora + 10_000);
  assert.ok(p2 > p1, 'la posicion sigue avanzando despues de restaurar');
  assert.ok(Math.abs((p2 - p1) - 10) < 0.01);
});

test('restaurar sin el video en el catalogo devuelve null y borra el reloj guardado', async () => {
  const slug = 'canal-reloj-restaurar-sinvideo';
  await guardarVideo(slug);
  await reloj.aplicar(slug, 'reproducir', { videoId: 'ep1' });
  canales.cerrarTodo();

  await videos.borrar(slug, 'ep1');

  const cable = await reloj.restaurar(slug);
  assert.equal(cable, null);
  assert.equal(await almacen.obtener('reloj', slug), null, 'no puede dejar la sala pidiendo un archivo que no existe');
});

test('restaurar sin nada guardado devuelve null y no crea el canal', async () => {
  const slug = 'canal-reloj-restaurar-vacio';
  const cable = await reloj.restaurar(slug);
  assert.equal(cable, null);
  assert.equal(canales.hayCanal(slug), false);
});

/* ------------------------------------------------------- detenerSiUsa */

test('detenerSiUsa detiene el reloj si esta usando ese video', async () => {
  const slug = 'canal-reloj-detenersiusa-si';
  await guardarVideo(slug);
  await reloj.aplicar(slug, 'reproducir', { videoId: 'ep1' });

  const usaba = await reloj.detenerSiUsa(slug, 'ep1');
  assert.equal(usaba, true);
  assert.equal((await reloj.leer(slug)).estado, 'detenido');
});

test('detenerSiUsa no toca nada si el reloj esta usando otro video', async () => {
  const slug = 'canal-reloj-detenersiusa-no';
  await guardarVideo(slug);
  await reloj.aplicar(slug, 'reproducir', { videoId: 'ep1' });

  const usaba = await reloj.detenerSiUsa(slug, 'otro-video');
  assert.equal(usaba, false);

  const estado = await reloj.leer(slug);
  assert.equal(estado.estado, 'reproduciendo');
  assert.equal(estado.videoId, 'ep1');
});

/* -------------------------------------------------------------- otros */

test('aplicar con una accion inventada devuelve error', async () => {
  const r = await reloj.aplicar('cualquier-slug', 'bailar', {});
  assert.ok(r.error);
});
