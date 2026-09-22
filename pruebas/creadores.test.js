/* ============================================================
   El indice de creadores: quien tiene sala, con que plan, y de que
   sala es cada evento que llega.

   Es el modulo del que cuelga todo el aislamiento de la Fase 3, asi
   que lo que se prueba aca no es "guarda y lee" sino las cuatro cosas
   que, si fallan, mezclan dos inquilinos:

     1. que el plan del dueño NO salga de la base;
     2. que un vencimiento pasado baje el plan aunque el campo diga
        otra cosa;
     3. que un evento de Kick que no se pueda atribuir a una sala que
        existe se descarte, en vez de caer en la del dueño;
     4. que el dueño no pueda poner planes de cobro ni el cobro planes
        del dueño.
   ============================================================ */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const DATOS = await fsp.mkdtemp(path.join(os.tmpdir(), 'sala-creadores-'));
process.env.SALA_DATOS = DATOS;
process.env.KICK_SLUG = 'istincho';
process.env.CLAVE_CIFRADO = crypto.randomBytes(32).toString('base64');
/* Un tope chico para poder llegar a el sin crear novecientas filas. */
process.env.TOPE_CANALES = '3';

const creadores = await import('../servidor/creadores.js');
const almacen = await import('../servidor/almacen.js');

const DUENO = 'istincho';

test.after(async () => {
  await fsp.rm(DATOS, { recursive: true, force: true });
});

async function limpiar() {
  for (const c of await almacen.listar('creadores')) await almacen.quitar('creadores', c.id);
  creadores.olvidarCache();
}

test.beforeEach(limpiar);

/* ----------------------------------------------- el dueño no es una fila */

test('el dueño existe sin tocar el almacen y su plan no sale de la base', async () => {
  /* Es lo que hace que la Sala del dueño funcione con la coleccion
     vacia, que es como esta hoy y como va a estar el primer dia. */
  assert.equal(await creadores.existe(DUENO), true);
  assert.equal(await creadores.obtener(DUENO), null, 'no hay fila y sin embargo existe');
  assert.equal(await creadores.planDe(DUENO), 'dueno');
  assert.equal(await creadores.puedeReproducir(DUENO), true);
});

test('escribirle "pendiente" al dueño en la base no lo degrada', async () => {
  /* LA PRUEBA QUE IMPORTA de este archivo. Si el plan del dueño saliera
     del documento, cualquiera con escritura en Mongo —o un bug de
     escritura nuestro— lo dejaria sin poder reproducir en su propia
     sala. Se escribe la fila a mano, con el peor valor posible. */
  await almacen.poner('creadores', DUENO, { slug: DUENO, plan: 'vencido', vence: 1 });
  creadores.olvidarCache();

  assert.equal(await creadores.planDe(DUENO), 'dueno');
  assert.equal(await creadores.puedeReproducir(DUENO), true);
});

test('esDueno compara contra KICK_SLUG y nada mas', () => {
  assert.equal(creadores.esDueno('istincho'), true);
  assert.equal(creadores.esDueno('IsTincho'), true, 'no distingue mayusculas');
  assert.equal(creadores.esDueno('istincho2'), false);
  assert.equal(creadores.esDueno('istinch'), false);
  assert.equal(creadores.esDueno(''), false);
  assert.equal(creadores.esDueno(null), false);
});

/* ------------------------------------------------------------ el alta */

test('una sala nueva arranca pendiente y con la fecha de los terminos', async () => {
  const c = await creadores.crear({ slug: 'ana', usuarioId: '111', nombre: 'Ana', terminos: '1' });

  assert.equal(c.slug, 'ana');
  assert.equal(c.plan, 'pendiente');
  assert.equal(c.terminos.version, '1');
  assert.ok(c.terminos.cuando > 0, 'la fecha de aceptacion tiene que quedar');
  assert.equal(await creadores.planDe('ana'), 'pendiente');
  assert.equal(await creadores.puedeReproducir('ana'), false,
    'una sala pendiente no puede reproducir');
});

test('volver a entrar NO le pisa el plan ni los terminos al que ya estaba', async () => {
  /* El login de Kick pasa por `crear()` cada vez que alguien entra a
     su panel. Si eso reseteara el plan, un creador con plan "amigo"
     volveria a "pendiente" la proxima vez que se loguea. */
  await creadores.crear({ slug: 'ana', usuarioId: '111', nombre: 'Ana', terminos: '1' });
  await creadores.ponerPlan('ana', 'amigo', { quien: 'dueno' });

  const otra = await creadores.crear({ slug: 'ana', usuarioId: '111', nombre: 'Ana Nueva', terminos: '' });

  assert.equal(otra.plan, 'amigo', 'el plan no se toca al volver a entrar');
  assert.equal(otra.terminos.version, '1', 'y los terminos aceptados tampoco');
  assert.equal(otra.nombre, 'Ana Nueva', 'lo que si se refresca es el nombre');
});

test('un slug que no sirve como id de documento se rechaza al crear', async () => {
  await assert.rejects(() => creadores.crear({ slug: '../otro', usuarioId: '1' }), /slug invalido/);
  await assert.rejects(() => creadores.crear({ slug: '', usuarioId: '1' }), /slug invalido/);
  await assert.rejects(() => creadores.crear({ slug: 'con espacio', usuarioId: '1' }), /slug invalido/);
});

test('el tope corta las altas nuevas y deja pasar a los que ya estaban', async () => {
  assert.equal(creadores.TOPE_CANALES, 3, 'el tope sale de la variable, para poder probarlo');

  for (const s of ['ana', 'beto', 'cora']) {
    assert.equal(await creadores.hayLugar(), true, `todavia tiene que entrar ${s}`);
    await creadores.crear({ slug: s, usuarioId: `id-${s}`, terminos: '1' });
  }

  assert.equal(await creadores.cuantos(), 3);
  assert.equal(await creadores.hayLugar(), false, 'lleno: no entra uno mas');
});

/* -------------------------------------------------------- los planes */

test('un vencimiento que ya paso baja el plan aunque el campo diga "pago"', async () => {
  /* El webhook de cobro es lo unico del sistema que llega de afuera y
     puede no llegar. Si no llega, el plan tiene que caer SOLO: lo
     contrario es seguir dando el servicio hasta que alguien mire. */
  await creadores.crear({ slug: 'ana', usuarioId: '111', terminos: '1' });
  await creadores.ponerPlan('ana', 'pago', { vence: Date.now() - 1000, quien: 'cobro' });

  const doc = await creadores.obtener('ana');
  assert.equal(doc.plan, 'pago', 'lo guardado sigue diciendo pago');
  assert.equal(await creadores.planDe('ana'), 'vencido', 'y lo que vale hoy es vencido');
  assert.equal(await creadores.puedeReproducir('ana'), false);
});

test('un vencimiento futuro deja el plan como esta', async () => {
  /* El control negativo del de arriba: sin este, "bajar todo a
     vencido" pasaria el test anterior. */
  await creadores.crear({ slug: 'ana', usuarioId: '111', terminos: '1' });
  await creadores.ponerPlan('ana', 'pago', { vence: Date.now() + 86400_000, quien: 'cobro' });

  assert.equal(await creadores.planDe('ana'), 'pago');
  assert.equal(await creadores.puedeReproducir('ana'), true);
});

test('un "pendiente" con vencimiento viejo sigue siendo pendiente, no vencido', async () => {
  /* "vencido" quiere decir "esto andaba y se cayo". Un pendiente que
     nunca arranco no vencio nada, y llamarlo vencido le mostraria el
     cartel equivocado. */
  await creadores.crear({ slug: 'ana', usuarioId: '111', terminos: '1' });
  await almacen.poner('creadores', 'ana', { slug: 'ana', plan: 'pendiente', vence: 1 });
  creadores.olvidarCache();

  assert.equal(await creadores.planDe('ana'), 'pendiente');
});

test('el dueño no puede poner "pago" ni el cobro poner "amigo"', async () => {
  await creadores.crear({ slug: 'ana', usuarioId: '111', terminos: '1' });

  await assert.rejects(
    () => creadores.ponerPlan('ana', 'pago', { quien: 'dueno' }),
    /lo pone el proveedor de cobro/,
    'si el dueño pudiera poner "pago", la base y el proveedor dirian cosas distintas');
  await assert.rejects(
    () => creadores.ponerPlan('ana', 'vencido', { quien: 'dueno' }),
    /lo pone el proveedor de cobro/);
  await assert.rejects(
    () => creadores.ponerPlan('ana', 'amigo', { quien: 'cobro' }),
    /lo pone el dueño/,
    'y un proveedor no puede regalar el servicio');

  /* Y los que si puede cada uno, para que el arreglo no sea "no se
     puede nada". */
  assert.ok(await creadores.ponerPlan('ana', 'amigo', { quien: 'dueno' }));
  assert.ok(await creadores.ponerPlan('ana', 'pago', { quien: 'cobro' }));
});

test('un plan que no existe se rechaza venga de donde venga', async () => {
  await creadores.crear({ slug: 'ana', usuarioId: '111', terminos: '1' });
  await assert.rejects(() => creadores.ponerPlan('ana', 'gratis', { quien: 'dueno' }), /plan desconocido/);
  await assert.rejects(() => creadores.ponerPlan('ana', 'dueno', { quien: 'dueno' }),
    /plan desconocido/, 'el plan del dueño no se puede poner: se es o no se es');
});

test('ponerle plan a una sala que no existe no la crea', async () => {
  assert.equal(await creadores.ponerPlan('fantasma', 'amigo', { quien: 'dueno' }), null);
  assert.equal(await creadores.obtener('fantasma'), null);
});

test('los topes de GB por plan dejan afuera a pendiente y vencido', () => {
  assert.equal(creadores.topeGb('pendiente'), 0);
  assert.equal(creadores.topeGb('vencido'), 0);
  assert.equal(creadores.topeGb('dueno'), Infinity);
  assert.ok(creadores.topeGb('amigo') > 0);
  assert.ok(creadores.topeGb('pago') >= creadores.topeGb('amigo'),
    'el que paga no puede tener menos lugar que el amigo');
  assert.equal(creadores.topeGb('inventado'), 0, 'un plan raro no regala lugar');
});

/* -------------------------------------------------- la sala del evento */

const eventoDe = (userId, slug) => ({
  message_id: 'm1',
  broadcaster: { user_id: userId, username: 'X', channel_slug: slug },
  sender: { user_id: 9, username: 'Fulana' },
  content: 'hola',
});

test('un evento se atribuye por broadcaster_user_id', async () => {
  await creadores.crear({ slug: 'ana', usuarioId: '111', terminos: '1' });
  assert.equal(await creadores.salaDelEvento(eventoDe(111, 'ana')), 'ana');
  assert.equal(await creadores.salaDelEvento(eventoDe('111', 'ana')), 'ana',
    'el payload de Kick trae un numero y el indice guarda texto');
});

test('el numero manda sobre el slug: un renombre en Kick no cambia de sala', async () => {
  /* Los dos viajan adentro del cuerpo firmado, asi que ninguno es "mas
     seguro"; el numero es el que no cambia. Si algun dia se prefiriera
     el slug, este test se cae. */
  await creadores.crear({ slug: 'ana', usuarioId: '111', terminos: '1' });
  await creadores.crear({ slug: 'beto', usuarioId: '222', terminos: '1' });

  assert.equal(await creadores.salaDelEvento(eventoDe(111, 'beto')), 'ana');
});

test('sin user_id se cae al channel_slug', async () => {
  await creadores.crear({ slug: 'ana', usuarioId: '111', terminos: '1' });
  assert.equal(await creadores.salaDelEvento({ broadcaster: { channel_slug: 'ana' } }), 'ana');
});

test('un evento de un canal que no es de nadie NO se atribuye', async () => {
  /* LA PUERTA DEL WEBHOOK. `canales.recordar` crea el canal del bus que
     no exista, asi que sin esto un payload fabrica canales con el
     nombre que quiera y el chat de un creador cae en la sala de otro.
     Devolver '' es lo que hace que el evento se descarte entero. */
  await creadores.crear({ slug: 'ana', usuarioId: '111', terminos: '1' });

  assert.equal(await creadores.salaDelEvento(eventoDe(999, 'nadie')), '');
  assert.equal(await creadores.salaDelEvento(eventoDe(999, 'ana')), 'ana',
    'pero si el slug SI es de alguien, se atribuye por ahi');
  assert.equal(await creadores.salaDelEvento({}), '');
  assert.equal(await creadores.salaDelEvento(null), '');
});

test('el dueño se atribuye por slug aunque no tenga fila todavia', async () => {
  /* El primer webhook puede llegar antes de que el dueño se haya
     logueado nunca, o sea antes de que exista su fila. Si eso no se
     atribuyera, su propio chat quedaria mudo el primer dia. */
  assert.equal(await creadores.salaDelEvento({ broadcaster: { channel_slug: DUENO } }), DUENO);
});

/* ------------------------------------------------------------- cache */

test('la cache se invalida al escribir: un plan nuevo se ve en el acto', async () => {
  await creadores.crear({ slug: 'ana', usuarioId: '111', terminos: '1' });
  assert.equal(await creadores.planDe('ana'), 'pendiente');   // deja la cache puesta

  await creadores.ponerPlan('ana', 'amigo', { quien: 'dueno' });

  /* Sin la invalidacion, esto seguiria diciendo "pendiente" durante
     cinco segundos, y marcar a alguien como amigo desde /admin daria
     la impresion de no haber hecho nada. */
  assert.equal(await creadores.planDe('ana'), 'amigo');
});

/* Cómo se prueba que la cache existe, y por qué así.

   Lo que la cache ahorra es una consulta al almacén, y contar consultas
   no se puede: el objeto de un módulo ES es de sólo lectura, así que no
   hay dónde poner un contador sin abrirle una costura al código de
   producción para uso exclusivo de un test.

   Se mide por el efecto que sí es observable: la RANCIEDAD. Se escribe
   el documento derecho en el almacén, salteando `creadores.js` (que
   invalidaría su propia entrada), y se comprueba que la lectura
   siguiente devuelve todavía lo viejo. Un valor viejo sólo puede salir
   de una cache; si la lectura fuera al almacén cada vez, se vería el
   documento nuevo en el acto.

   La contracara —que la ranciedad no sea eterna— la cuida el test de
   arriba, "la cache se invalida al escribir". */

test('la cache guarda TAMBIEN los que no existen', async () => {
  /* `/eventos/<slug inventado>` corre `existe()` una vez por pestaña.
     Sin cachear el "no existe", un slug distinto cada vez sigue siendo
     una consulta al almacén por pedido, que es el modo barato de
     voltear el servicio que esta guarda vino a cerrar. */
  assert.equal(await creadores.existe('fantasma'), false);

  /* Derecho al almacén: `creadores.crear` invalidaría la entrada. */
  await almacen.poner('creadores', 'fantasma', { slug: 'fantasma', plan: 'amigo' });

  assert.equal(await creadores.existe('fantasma'), false,
    'el "no existe" tiene que estar cacheado: si esto da true, cada slug inventado es una consulta');

  creadores.olvidarCache();
  assert.equal(await creadores.existe('fantasma'), true, 'y con la cache vacía se ve el nuevo');
});

test('la cache guarda a los que sí existen', async () => {
  await creadores.crear({ slug: 'ana', usuarioId: '111', terminos: '1' });
  assert.equal(await creadores.planDe('ana'), 'pendiente');

  await almacen.poner('creadores', 'ana', { slug: 'ana', plan: 'amigo', vence: 0 });

  assert.equal(await creadores.planDe('ana'), 'pendiente',
    'sigue saliendo de la cache');

  creadores.olvidarCache();
  assert.equal(await creadores.planDe('ana'), 'amigo');
});

test('la cache se vence sola a los cinco segundos', async (t) => {
  /* Los dos tests de arriba prueban que la cache GUARDA, y la
     invalidación al escribir prueba que lo escrito por este módulo se
     ve en el acto. Faltaba el tercer lado, y sacar el vencimiento
     sobrevivía la suite entera: sin él, un documento que cambió por
     fuera de este proceso —el otro contenedor de Railway el día que
     haya dos, o el dueño tocando Mongo a mano— queda rancio PARA
     SIEMPRE, no cinco segundos.

     El reloj se mueve en vez de esperar cinco segundos de verdad: un
     test que duerme cinco segundos es un test que alguien borra. */
  await creadores.crear({ slug: 'ana', usuarioId: '111', terminos: '1' });

  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  assert.equal(await creadores.planDe('ana'), 'pendiente');   // deja la cache puesta

  /* Derecho al almacén, salteando `creadores.js`: si se escribiera por
     `ponerPlan` invalidaría su propia entrada y no habría nada rancio
     que vencer. */
  await almacen.poner('creadores', 'ana', { slug: 'ana', plan: 'amigo', vence: 0 });
  assert.equal(await creadores.planDe('ana'), 'pendiente',
    'todavía adentro de la ventana: tiene que salir de la cache');

  t.mock.timers.tick(creadores.CACHE_MS + 1);

  assert.equal(await creadores.planDe('ana'), 'amigo',
    'pasada la ventana tiene que volver a mirar el almacén');
});

test('la cache no crece para siempre: pasado el tope suelta a los mas viejos', async (t) => {
  /* La cache guarda TAMBIÉN a los que no existen, que es lo que hace
     que `/eventos/<slug inventado>` no sea una consulta por pedido. Sin
     tope, eso es el mismo ataque corrido un casillero: en vez de llenar
     Mongo de consultas se llena este proceso de entradas, una por slug
     inventado, hasta que el contenedor se queda sin memoria.

     Que se suelte al MÁS VIEJO y no al recién llegado importa por lo
     mismo que en `metricas`: el que acaba de entrar es el que está
     hablando ahora.

     La cache no se puede mirar desde afuera (no hay `cache.size`
     exportado, y abrirle una costura al código de producción para uso
     exclusivo de un test es peor que no tener el test). Se mide por lo
     único observable: la ranciedad de la entrada más vieja. Si sigue
     rancia después de llenar el Map, no se soltó. */
  await creadores.crear({ slug: 'ana', usuarioId: '111', terminos: '1' });

  /* El reloj se para: lo que este test mide es ranciedad, y la
     ranciedad también se termina sola a los CACHE_MS. Las 5.001
     lecturas de abajo tardan ~140 ms en esta máquina, pero eso es
     tiempo real y no hay nada que lo ancle: en una máquina cargada
     podrían pasar los cinco segundos, y entonces la entrada de 'ana'
     saldría fresca porque VENCIÓ, no porque el tope la soltó, y el
     test estaría verde con el tope sacado. */
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });

  assert.equal(await creadores.planDe('ana'), 'pendiente');   // 'ana' queda primera en el orden

  await almacen.poner('creadores', 'ana', { slug: 'ana', plan: 'amigo', vence: 0 });
  assert.equal(await creadores.planDe('ana'), 'pendiente', 'todavía rancia, como corresponde');

  /* Un slug distinto por vuelta, como los que llegarían por
     `/eventos/:slug`. Ninguno existe: entran igual, que es el punto. */
  for (let i = 0; i <= creadores.TOPE_CACHE; i++) await creadores.existe(`inventado-${i}`);

  assert.equal(await creadores.planDe('ana'), 'amigo',
    'la entrada más vieja tenía que haberse soltado: si sigue rancia, el Map no tiene tope');
});

test('el tope suelta por ULTIMO USO, no por orden de llegada', async (t) => {
  /* El test de arriba no distingue LRU de FIFO: 'ana' es la primera de
     los dos órdenes, así que sale soltada con cualquiera de las dos
     políticas. Y sacar el `cache.delete(slug)` de `guardarEnCache` —la
     línea que devuelve al final del orden a la entrada que se acaba de
     releer— sobrevivía la suite entera: convertía la política en FIFO
     por primera inserción, que es justo lo contrario de lo que el
     comentario de arriba promete ("el que acaba de entrar es el que
     está hablando ahora").

     Que la diferencia importe, y no sea gusto: con FIFO, la sala que
     está pasando una película —la que se lee en cada latido del
     reloj— se suelta igual que una que nadie mira desde hace horas, y
     una ráfaga de slugs inventados le saca la entrada a la única sala
     que la estaba usando. Con LRU esa ráfaga sólo se pisa a sí misma.

     Se ven las dos entradas: se releen en un orden (primero 'beto',
     después 'ana') y se hace lugar para soltar exactamente una. Con
     LRU se suelta 'beto', que es la que hace más que no se toca; con
     FIFO se suelta 'ana', que es la que llegó primera. */
  await creadores.crear({ slug: 'ana', usuarioId: '111', terminos: '1' });
  await creadores.crear({ slug: 'beto', usuarioId: '222', terminos: '1' });

  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });

  assert.equal(await creadores.planDe('ana'), 'pendiente');    // 1ª en llegar
  assert.equal(await creadores.planDe('beto'), 'pendiente');   // 2ª

  /* Vencidas las dos, se releen AL REVÉS: ahora la más recién usada es
     'ana', pero la que llegó primero sigue siendo 'ana'. */
  t.mock.timers.tick(creadores.CACHE_MS + 1);
  assert.equal(await creadores.planDe('beto'), 'pendiente');
  assert.equal(await creadores.planDe('ana'), 'pendiente');

  /* Derecho al almacén, salteando `creadores.js`: la que sobreviva al
     desalojo va a seguir contestando lo viejo, y la soltada lo nuevo. */
  await almacen.poner('creadores', 'ana', { slug: 'ana', plan: 'amigo', vence: 0 });
  await almacen.poner('creadores', 'beto', { slug: 'beto', plan: 'amigo', vence: 0 });

  /* Justo lo necesario para que sobre UNA entrada: con 'ana' y 'beto'
     adentro, TOPE_CACHE - 1 slugs nuevos dejan el Map en TOPE_CACHE + 1
     y se suelta una sola. */
  for (let i = 0; i < creadores.TOPE_CACHE - 1; i++) await creadores.existe(`inventado-${i}`);

  assert.equal(await creadores.planDe('ana'), 'pendiente',
    'la última usada tiene que seguir en la cache: si contesta "amigo", se soltó por orden de llegada (FIFO) y no por último uso');
  assert.equal(await creadores.planDe('beto'), 'amigo',
    'y la que hacía más que no se tocaba tenía que ser la soltada: si sigue rancia, no se soltó ninguna y lo de arriba no probó nada');
});

test('un slug con forma invalida se contesta false sin mirar nada', async () => {
  /* No es sólo higiene: de este slug sale el id del documento que se
     lee, así que uno raro que se colara leería la fila de otro. */
  assert.equal(await creadores.existe('../../etc/passwd'), false);
  assert.equal(await creadores.existe('con espacio'), false);
  assert.equal(await creadores.existe('a/b'), false);
  assert.equal(await creadores.obtener('../otro'), null);

  /* Y lo que sí es válido con otra caja se normaliza en vez de
     rechazarse: el slug llega de una URL escrita a mano. */
  await creadores.crear({ slug: 'ana', usuarioId: '111', terminos: '1' });
  assert.equal(await creadores.existe('ANA'), true);
});

/* ================================================= la Sala prendida

   El interruptor del 2026-09-22: el producto que se ofrece es el
   multichat, y la Sala queda apagada hasta que el dueño la prenda. Lo
   que se prueba acá es el modelo; que las rutas contesten 404 con la
   Sala apagada se prueba por HTTP, en `sala-cerrada.test.js`. */

test('la Sala nace cerrada, y también la del dueño del servicio', async () => {
  /* Que el dueño NO sea la excepción es la mitad del punto: `existe()`
     sí lo trata aparte (su sala funciona con la colección vacía), y
     copiar ese criterio acá dejaría prendida justamente la única Sala
     que hoy tiene una película puesta. */
  await creadores.crear({ slug: 'ana', usuarioId: '111', terminos: '1' });

  assert.equal(await creadores.salaAbierta('ana'), false);
  assert.equal(await creadores.salaAbierta(DUENO), false);
  /* Y una sala que no existe tampoco la tiene abierta: es lo que hace
     que el 404 de las rutas sea indistinguible en los dos casos. */
  assert.equal(await creadores.salaAbierta('no-existe'), false);
});

test('prender y apagar la Sala de un creador sobrevive a la cache', async () => {
  await creadores.crear({ slug: 'ana', usuarioId: '111', terminos: '1' });
  /* Se lee ANTES de escribir, a propósito: así la respuesta "cerrada"
     queda cacheada y, si la escritura no invalidara, lo de abajo
     seguiría diciendo false durante cinco segundos. */
  assert.equal(await creadores.salaAbierta('ana'), false);

  assert.equal(await creadores.ponerSalaAbierta('ana', true), true);
  assert.equal(await creadores.salaAbierta('ana'), true);

  assert.equal(await creadores.ponerSalaAbierta('ana', false), false);
  assert.equal(await creadores.salaAbierta('ana'), false);
});

test('prender la Sala no le toca el plan ni los términos a nadie', async () => {
  /* Escribe el documento entero (el almacén no sabe actualizar un
     campo suelto), así que lo que no se toca tiene que quedar igual. */
  await creadores.crear({ slug: 'ana', usuarioId: '111', terminos: '1' });
  await creadores.ponerPlan('ana', 'amigo', { quien: 'dueno' });

  await creadores.ponerSalaAbierta('ana', true);

  const c = await creadores.obtener('ana');
  assert.equal(c.plan, 'amigo');
  assert.equal(c.usuarioId, '111');
  assert.equal(c.terminos.version, '1');
});

test('al dueño del servicio sin documento se le crea uno, como el chat abierto', async () => {
  /* Su sala existe por KICK_SLUG y puede no tener fila (es como está
     hoy la colección). El ajuste tiene que poder guardarse igual. */
  assert.equal(await almacen.obtener('creadores', DUENO), null, 'tiene que arrancar sin fila');

  assert.equal(await creadores.ponerSalaAbierta(DUENO, true), true);
  assert.equal(await creadores.salaAbierta(DUENO), true);

  /* Y su plan sigue sin salir de esa fila. */
  assert.equal((await creadores.obtener(DUENO)).plan, 'pendiente');
  assert.equal(await creadores.planDe(DUENO), 'dueno');
});

test('a un creador que no existe no se le prende nada', async () => {
  assert.equal(await creadores.ponerSalaAbierta('no-existe', true), null);
  assert.equal(await almacen.obtener('creadores', 'no-existe'), null,
    'prender la Sala no puede ser una forma lateral de dar de alta una sala');
});

test('dos escrituras a la vez sobre el mismo creador no se pisan', async () => {
  /* `escribir` es leer-cambiar-guardar sobre el documento entero: sin
     la cola, prender la Sala mientras se guarda el plan deja uno de los
     dos cambios afuera, en silencio. */
  await creadores.crear({ slug: 'ana', usuarioId: '111', terminos: '1' });

  await Promise.all([
    creadores.ponerSalaAbierta('ana', true),
    creadores.ponerChatAbierto('ana', { activo: true }),
  ]);

  const c = await creadores.obtener('ana');
  assert.equal(Boolean(c.salaAbierta), true, 'se perdió el interruptor de la Sala');
  assert.equal(c.chatAbierto.activo, true, 'se perdió el del chat abierto');
});

test('prender la Sala mientras entra el plan pagado no pierde el plan', async () => {
  /*
   * ESTE ES EL QUE CUESTA PLATA, y el que el test de arriba no agarra:
   * aquel enfrenta las dos únicas funciones que compartían cola.
   * `ponerPlan`, `anotarUso`, `marcarSuscrito` y `crear` escribían por
   * afuera, así que el dueño habilitándole la Sala a alguien desde
   * /admin justo cuando cae el webhook de Paddle perdía EL PLAN PAGADO.
   * Medido antes del arreglo: 20 de 20 veces.
   */
  await creadores.crear({ slug: 'ana', usuarioId: '111', terminos: '1' });

  await Promise.all([
    creadores.ponerSalaAbierta('ana', true),
    creadores.ponerPlan('ana', 'pago', { quien: 'cobro', vence: Date.now() + 86_400_000 }),
  ]);

  creadores.olvidarCache();
  const c = await creadores.obtener('ana');
  assert.equal(c.plan, 'pago', 'se perdió el plan que alguien pagó');
  assert.equal(Boolean(c.salaAbierta), true, 'y tampoco se puede haber perdido la Sala');

  /* Lo mismo con el uso de R2, que lo escribe el mismo /admin. */
  await Promise.all([
    creadores.ponerSalaAbierta('ana', false),
    creadores.anotarUso('ana', 12_345),
  ]);
  creadores.olvidarCache();
  const d = await creadores.obtener('ana');
  assert.equal(d.bytes, 12_345, 'se perdieron los bytes medidos');
  assert.equal(Boolean(d.salaAbierta), false);
});

test('tres bloqueos al mismo tiempo no se pisan', async () => {
  /*
   * EL BUG QUE ESTO ATAJA: guardar un bloqueo es leer-cambiar-guardar
   * sobre la lista, y el almacén no sabe actualizar un campo suelto.
   * Sin cola, el segundo lee la lista sin el primero y la guarda sin
   * él: el bloqueo desaparece en silencio. Pasa tocando "bloquear" en
   * dos mensajes seguidos, que es justo lo que se hace en una tanda de
   * spam. Medido sin la cola: falta alguno 20 de 20 veces.
   *
   * VA ACÁ Y NO EN LA PRUEBA HTTP: la de `chat-enviar.test.js` manda
   * tres POST a la vez, pero cada pedido pasa antes por la cookie y por
   * el cuerpo, y con eso los tres terminan llegando de a uno a la parte
   * que importa. Aquella prueba el panel; la carrera se prueba acá,
   * llamando al módulo derecho.
   */
  await creadores.crear({ slug: 'ana', usuarioId: '111', terminos: '1' });

  await Promise.all([
    creadores.ponerChatAbierto('ana', { bloquear: { red: 'kick', id: '10001', nombre: 'uno' } }),
    creadores.ponerChatAbierto('ana', { bloquear: { red: 'kick', id: '10002', nombre: 'dos' } }),
    creadores.ponerChatAbierto('ana', { bloquear: { red: 'twitch', id: '10003', nombre: 'tres' } }),
  ]);

  creadores.olvidarCache();
  const c = await creadores.chatAbierto('ana');
  assert.deepEqual(c.bloqueados.map(b => b.id).sort(), ['10001', '10002', '10003'],
    'los tres tienen que haber quedado');
});

test('a quien le crearon la fila sin términos, el login se los anota', async () => {
  /*
   * LE PASA AL DUEÑO DEL SERVICIO Y A NADIE MÁS, pero le pasa siempre.
   * Su fila puede nacer de un interruptor (`ponerSalaAbierta` /
   * `ponerChatAbierto` se la crean, porque su sala existe por
   * KICK_SLUG), y esa fila queda con `terminos.version` vacío. Como
   * `crear` no le toca los términos a quien ya existe —para no
   * "reaceptar" lo que nadie leyó esta vez—, su login posterior lo
   * dejaba en blanco para siempre.
   *
   * Anotarlos la PRIMERA vez no es reaceptar nada: antes no había
   * ninguno. Lo que sigue sin pasar es pisar una versión ya anotada.
   */
  await creadores.ponerSalaAbierta(DUENO, true);
  assert.equal((await creadores.obtener(DUENO)).terminos.version, '', 'la fila nace sin términos');

  await creadores.crear({ slug: DUENO, usuarioId: '99', nombre: 'IsTincho', terminos: '1' });
  creadores.olvidarCache();
  const c = await creadores.obtener(DUENO);
  assert.equal(c.terminos.version, '1', 'el login tiene que poder anotar los términos');
  assert.ok(c.terminos.cuando > 0);

  /* Y una versión ya anotada no se pisa con la de otro login. */
  await creadores.crear({ slug: DUENO, usuarioId: '99', nombre: 'IsTincho', terminos: '2' });
  creadores.olvidarCache();
  assert.equal((await creadores.obtener(DUENO)).terminos.version, '1',
    'volver a entrar no puede "reaceptar" términos que nadie leyó esta vez');
});

test('a la Sala se la prende con true y con nada más', async () => {
  /* Defensa en profundidad del 400 de las rutas: si el día de mañana
     alguien llama a esto con lo que vino en un JSON, un `"false"` de
     texto no puede prender nada. */
  await creadores.crear({ slug: 'ana', usuarioId: '111', terminos: '1' });

  for (const valor of ['true', 1, 'false', {}, [], 'si']) {
    assert.equal(await creadores.ponerSalaAbierta('ana', valor), false, JSON.stringify(valor));
    assert.equal(await creadores.salaAbierta('ana'), false, JSON.stringify(valor));
  }
  assert.equal(await creadores.ponerSalaAbierta('ana', true), true);
});

test('la Sala prendida sale en la lista de /admin', async () => {
  await creadores.crear({ slug: 'ana', usuarioId: '111', terminos: '1' });
  await creadores.crear({ slug: 'beto', usuarioId: '222', terminos: '1' });
  await creadores.ponerSalaAbierta('beto', true);

  const lista = await creadores.listar();
  assert.equal(lista.find(c => c.slug === 'ana').salaAbierta, false);
  assert.equal(lista.find(c => c.slug === 'beto').salaAbierta, true);
});
