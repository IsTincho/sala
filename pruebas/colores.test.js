/* ============================================================
   El color propio de cada persona: `servidor/colores.js`.

   Lo que se prueba acá es el índice en memoria y el pintado, que es
   por donde pasa CADA mensaje de las dos redes. Tres cosas importan:

     1. El color propio le gana al que manda la plataforma, y cuando no
        hay propio el de la plataforma queda intacto.
     2. Vale en todas las salas. El índice es por (red, id de esa red),
        no por sala, así que el mismo mensaje pintado en el chat de un
        creador se pinta igual en el de otro. Se prueba de verdad,
        metiendo el mismo mensaje por `chat.recibirDeKick` en dos salas
        distintas.
     3. Un valor que no es un color no llega nunca al navegador: la
        validación es una forma única (`#rrggbb`) y no una lista de
        cosas prohibidas.

   Y el desempate: la misma cuenta puede tener dos espectadores (el
   celular y la compu). Gana el color elegido más tarde, y el reseteo
   del creador tiene que limpiar LOS DOS documentos, o el color vuelve
   solo en el próximo arranque.
   ============================================================ */

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const DATOS = await fsp.mkdtemp(path.join(os.tmpdir(), 'sala-colores-'));
process.env.SALA_DATOS = DATOS;
process.env.CLAVE_CIFRADO = crypto.randomBytes(32).toString('base64');
/* Acá no se prueban los emotes y 7TV es una API de afuera: sin esto,
   meter un mensaje por el embudo de Kick sale a internet a buscar el
   set del canal. */
process.env.EMOTES_7TV = '0';
process.env.EMOTES_TWITCH = '0';

const colores = await import('../servidor/colores.js');
const chat = await import('../servidor/chat.js');
const canales = await import('../servidor/canales.js');

afterEach(() => colores.reiniciar());

test.after(async () => {
  chat.parar();
  canales.cerrarTodo();
  await fsp.rm(DATOS, { recursive: true, force: true });
});

/** Un documento de espectador con color, como lo guarda espectadores.js. */
const ficha = ({ id, color, desde = 1000, kick, twitch }) => ({
  id,
  color,
  colorDesde: desde,
  ...(kick ? { kick: { usuarioId: kick } } : {}),
  ...(twitch ? { twitch: { usuarioId: twitch } } : {}),
});

const mensajeKick = (usuarioId, color) => ({
  tipo: 'chat', red: 'kick', id: 'm1', usuario: 'Fulana', usuarioId,
  color, insignias: [], texto: 'hola', emotes: [], hora: new Date().toISOString(),
});

/* ------------------------------------------------- la validación */

test('un color válido se normaliza a minúscula', () => {
  assert.equal(colores.limpiar('#AABBCC'), '#aabbcc');
  assert.equal(colores.limpiar('#7a5cff'), '#7a5cff');
});

test('un valor basura no es un color', () => {
  /* Esto termina en un `style` del navegador de todo el que esté
     mirando: la forma aceptada es una sola y corta. Nada de listas de
     cosas prohibidas, que siempre tienen un agujero. */
  const basura = [
    'red', 'rgb(255,0,0)', '#abc', '#aabbccdd', '#12345g', 'aabbcc',
    '#aabbcc;background:url(http://x)', '#aabbcc<script>', 'expression(alert(1))',
    'var(--fondo)', '#aa bb cc', null, undefined, 42, {}, [], '\n#aabbcc{}',
  ];
  for (const malo of basura) {
    assert.equal(colores.limpiar(malo), '', `no debería aceptar ${JSON.stringify(malo)}`);
  }
});

test('el vacío es válido como pedido: es "sacámelo"', () => {
  /* Distinto de un valor basura: el vacío es lo que manda la página
     cuando la persona vuelve al color de su plataforma. */
  assert.equal(colores.esColorOVacio(''), true);
  assert.equal(colores.esColorOVacio('#aabbcc'), true);
  assert.equal(colores.esColorOVacio('rojo'), false);
  assert.equal(colores.esColorOVacio('#abc'), false);
  /* Un null o una clave ausente NO son "sacamelo": son un pedido mal
     escrito. Si valieran, una pagina con un bug le borraria el color a
     alguien sin que nadie lo haya pedido. */
  assert.equal(colores.esColorOVacio(null), false);
  assert.equal(colores.esColorOVacio(undefined), false);
  assert.equal(colores.esColorOVacio(0), false);
});

/* ------------------------------------------------- pintar */

test('el color propio le gana al de la plataforma', () => {
  colores.anotar(ficha({ id: 'esp_1', color: '#7a5cff', kick: '4242' }));
  const m = colores.pintar(mensajeKick('4242', '#53fc18'));

  assert.equal(m.color, '#7a5cff', 'tenía que pisar el color que manda Kick');
  assert.equal(m.colorPropio, true);
});

test('sin color propio, el de la plataforma queda como está', () => {
  const m = colores.pintar(mensajeKick('4242', '#53fc18'));
  assert.equal(m.color, '#53fc18');
  assert.equal(m.colorPropio, undefined,
    'colorPropio es la respuesta a "¿es el suyo?": sin color propio no va');
});

test('el color de una persona no pinta a otra', () => {
  colores.anotar(ficha({ id: 'esp_1', color: '#7a5cff', kick: '4242' }));
  const m = colores.pintar(mensajeKick('9999', '#53fc18'));
  assert.equal(m.color, '#53fc18');
});

test('el id de Kick no pinta un mensaje de Twitch con ese número', () => {
  /* Los dos ids son numéricos y pueden coincidir: la clave lleva la
     red adentro justamente por eso. */
  colores.anotar(ficha({ id: 'esp_1', color: '#7a5cff', kick: '4242' }));
  const m = colores.pintar({ ...mensajeKick('4242', '#9146ff'), red: 'twitch' });
  assert.equal(m.color, '#9146ff');
});

test('las dos redes de la misma persona salen con el mismo color', () => {
  colores.anotar(ficha({ id: 'esp_1', color: '#7a5cff', kick: '4242', twitch: '9090' }));
  assert.equal(colores.deUsuario('kick', '4242'), '#7a5cff');
  assert.equal(colores.deUsuario('twitch', '9090'), '#7a5cff');
});

test('pintar no puede tirar con un mensaje raro', () => {
  /* Corre adentro del webhook, después de que el evento quedó marcado
     como visto: una excepción acá es el mensaje perdido y un 500. */
  assert.doesNotThrow(() => colores.pintar(null));
  assert.doesNotThrow(() => colores.pintar({}));
  assert.doesNotThrow(() => colores.pintar({ red: 'kick' }));
});

/* ------------------------------------------------- el índice */

test('anotar sin color saca lo que había', () => {
  colores.anotar(ficha({ id: 'esp_1', color: '#7a5cff', kick: '4242' }));
  colores.anotar({ id: 'esp_1', kick: { usuarioId: '4242' } });
  assert.equal(colores.deUsuario('kick', '4242'), '');
  assert.equal(colores.cuantos(), 0);
});

test('olvidar a un espectador le saca el color', () => {
  colores.anotar(ficha({ id: 'esp_1', color: '#7a5cff', kick: '4242' }));
  colores.olvidar('esp_1');
  assert.equal(colores.deUsuario('kick', '4242'), '');
});

test('la red que se desconecta deja de pintar y la otra sigue', () => {
  colores.anotar(ficha({ id: 'esp_1', color: '#7a5cff', kick: '4242', twitch: '9090' }));
  /* Lo que hace `espectadores.desconectar`: vuelve a anotar el
     documento sin esa red. */
  colores.anotar(ficha({ id: 'esp_1', color: '#7a5cff', twitch: '9090' }));

  assert.equal(colores.deUsuario('kick', '4242'), '');
  assert.equal(colores.deUsuario('twitch', '9090'), '#7a5cff');
});

test('con dos navegadores gana el color elegido más tarde', () => {
  /* Conectar desde el celular y desde la compu deja DOS espectadores
     con la misma cuenta (está explicado en espectadores.js). */
  colores.anotar(ficha({ id: 'esp_celu', color: '#111111', desde: 100, kick: '4242' }));
  colores.anotar(ficha({ id: 'esp_compu', color: '#7a5cff', desde: 200, kick: '4242' }));
  assert.equal(colores.deUsuario('kick', '4242'), '#7a5cff');

  /* Y el orden en que se cargan no cambia nada: el desempate es
     `colorDesde`, que está guardado, y no el orden del arranque. */
  colores.reiniciar();
  colores.anotar(ficha({ id: 'esp_compu', color: '#7a5cff', desde: 200, kick: '4242' }));
  colores.anotar(ficha({ id: 'esp_celu', color: '#111111', desde: 100, kick: '4242' }));
  assert.equal(colores.deUsuario('kick', '4242'), '#7a5cff');
});

test('espectadoresCon los trae a todos: el reseteo tiene que limpiar los dos', () => {
  colores.anotar(ficha({ id: 'esp_celu', color: '#111111', desde: 100, kick: '4242' }));
  colores.anotar(ficha({ id: 'esp_compu', color: '#7a5cff', desde: 200, kick: '4242' }));

  assert.deepEqual(colores.espectadoresCon('kick', '4242').sort(), ['esp_celu', 'esp_compu']);
  assert.deepEqual(colores.espectadoresCon('kick', 'nadie'), []);
});

test('sacándole el color al que ganaba, queda el del otro', () => {
  /* Si se limpiara uno solo, el color del otro documento volvería en
     el próximo arranque: por eso el reseteo los recorre a todos. */
  colores.anotar(ficha({ id: 'esp_celu', color: '#111111', desde: 100, kick: '4242' }));
  colores.anotar(ficha({ id: 'esp_compu', color: '#7a5cff', desde: 200, kick: '4242' }));
  colores.anotar({ id: 'esp_compu', kick: { usuarioId: '4242' } });

  assert.equal(colores.deUsuario('kick', '4242'), '#111111');
});

/* ---------------------------------------- el color vale en todas las salas

   La prueba de verdad del encargo: el mismo mensaje entra por el
   embudo de Kick en dos salas distintas y sale pintado igual en las
   dos. El índice no sabe de salas a propósito. */

test('el mismo color pinta en el chat de un creador y en el de otro', () => {
  chat.reiniciar();
  canales.cerrarTodo();
  colores.anotar(ficha({ id: 'esp_1', color: '#7a5cff', kick: '4242' }));

  const evento = { id: 'ev-1', tipo: 'chat.message.sent', cuando: new Date().toISOString() };
  const cuerpo = (mensajeId) => ({
    message_id: mensajeId,
    content: 'hola',
    created_at: new Date().toISOString(),
    sender: { user_id: 4242, username: 'Fulana', identity: { username_color: '#53fc18', badges: [] } },
  });

  const enAna = chat.recibirDeKick('ana', evento, cuerpo('m-1'));
  const enBeto = chat.recibirDeKick('beto', { ...evento, id: 'ev-2' }, cuerpo('m-2'));

  assert.equal(enAna.mensaje.color, '#7a5cff');
  assert.equal(enAna.mensaje.colorPropio, true);
  assert.equal(enBeto.mensaje.color, '#7a5cff', 'el color es de la persona, no de la sala');
  assert.equal(enBeto.mensaje.colorPropio, true);

  canales.cerrarTodo();
});
