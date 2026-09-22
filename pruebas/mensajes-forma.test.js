/* ============================================================
   Las tres traducciones tienen que dar EL MISMO juego de claves.

   `deKick`, `deTwitch` y `deIrc` son tres caminos distintos que
   terminan en el mismo formato unico, el que la pagina lee sin
   preguntar por donde vino. Hoy los tres devuelven exactamente las
   mismas claves, pero eso estaba verificado a mano y nada mas:
   agregarle una clave a una sola de las tres sobrevivia las 224
   pruebas de la Fase 1.

   Y el que rompe es el tercero: `deIrc` es el plan B, el camino que
   solo se recorre cuando EventSub ya se cayo cuatro veces. Una clave
   que exista en dos de las tres se descubre justo la noche en que
   todo lo demas tambien esta mal.

   Esta prueba compara formas, no valores: los valores ya los prueba
   pruebas/mensajes.test.js.
   ============================================================ */

import test from 'node:test';
import assert from 'node:assert/strict';
import * as mensajes from '../servidor/mensajes.js';

const AHORA = new Date().toISOString();

/* Los tres payloads, con y sin respuesta a otro mensaje. El
   `respondeA` es opcional en las tres, asi que las dos variantes
   tienen que compararse por separado. */

const deKick = (conRespuesta) => mensajes.deKick({
  message_id: 'k1',
  content: 'hola',
  created_at: AHORA,
  sender: { username: 'Fulana', user_id: 909, identity: { username_color: '#53fc18', badges: [] } },
  ...(conRespuesta
    ? { replies_to: { message_id: 'k0', content: 'que tal', sender: { username: 'Mengana' } } }
    : {}),
}, { hora: AHORA });

const deTwitch = (conRespuesta) => mensajes.deTwitch({
  message_id: 't1',
  chatter_user_name: 'Fulana',
  chatter_user_id: '909',
  color: '#9146ff',
  badges: [],
  message: { text: 'hola', fragments: [{ type: 'text', text: 'hola' }] },
  ...(conRespuesta
    ? { reply: { parent_message_id: 't0', parent_user_name: 'Mengana', parent_message_body: 'que tal' } }
    : {}),
}, { message_timestamp: AHORA });

const deIrc = (conRespuesta) => mensajes.deIrc({
  id: 'i1',
  'display-name': 'Fulana',
  'user-id': '909',
  color: '#9146ff',
  badges: '',
  'tmi-sent-ts': String(Date.now()),
  ...(conRespuesta
    ? {
      'reply-parent-msg-id': 'i0',
      'reply-parent-display-name': 'Mengana',
      'reply-parent-msg-body': 'que tal',
    }
    : {}),
}, 'fulana', 'hola');

const claves = o => Object.keys(o).sort();

test('las tres traducciones devuelven el mismo juego de claves', () => {
  const k = deKick(false);
  const t = deTwitch(false);
  const i = deIrc(false);

  assert.deepEqual(claves(t), claves(k),
    'deTwitch no da las mismas claves que deKick: la pagina lee un solo formato');
  assert.deepEqual(claves(i), claves(k),
    'deIrc no da las mismas claves que deKick, y deIrc es el plan B: se descubre la peor noche');

  /* Que la lista sea la del plan, y no tres iguales entre si pero
     otra cosa. */
  assert.deepEqual(claves(k),
    ['color', 'emotes', 'hora', 'id', 'insignias', 'red', 'texto', 'tipo', 'usuario', 'usuarioId']);

  /* `usuarioId` es el id de quien escribio EN SU RED, y es lo unico
     con lo que se puede bloquear a alguien: por nombre no sirve,
     porque los nombres se cambian. Las tres traducciones tienen que
     traerlo o bloquear anda en Kick y no en Twitch (o al reves, la
     noche que EventSub se cae y entra el plan B de IRC). */
  for (const [nombre, m] of [['kick', k], ['twitch', t], ['irc', i]]) {
    assert.ok(m.usuarioId, `${nombre} no trajo el id de quien escribio`);
  }
});

test('las tres traducciones dan emotes con las mismas claves', () => {
  /* El mismo razonamiento que arriba, un nivel mas adentro. Los
     emotes de 7TV se agregan a este array desde `emotes.js` con un
     campo `fuente`; si una de las tres traducciones no lo pusiera en
     los nativos, habria mensajes donde algunos emotes lo tienen y
     otros no, y el primero que lo lea se rompe justo con una red. */
  const k = mensajes.partirTextoDeKick('hola [emote:4148074:HYPERCLAP]').emotes[0];
  const t = mensajes.deTwitch({
    message: { fragments: [{ type: 'emote', text: 'Kappa', emote: { id: '25' } }] },
  }).emotes[0];
  const i = mensajes.deIrc(new Map([['emotes', '25:0-4']]), 'x', 'Kappa').emotes[0];

  assert.deepEqual(claves(k), ['fin', 'fuente', 'id', 'inicio', 'url']);
  assert.deepEqual(claves(t), claves(k), 'deTwitch no da las mismas claves de emote que deKick');
  assert.deepEqual(claves(i), claves(k), 'deIrc tampoco, y deIrc es el plan B');

  assert.deepEqual([k.fuente, t.fuente, i.fuente], ['kick', 'twitch', 'twitch'],
    'la fuente dice de donde salio el emote, no de que traductor');
});

test('las tres traducciones dan el mismo respondeA', () => {
  const k = deKick(true);
  const t = deTwitch(true);
  const i = deIrc(true);

  assert.deepEqual(claves(k), [...claves(deKick(false)), 'respondeA'].sort(),
    'la respuesta agrega respondeA y nada mas');
  assert.deepEqual(claves(t), claves(k));
  assert.deepEqual(claves(i), claves(k));

  assert.deepEqual(claves(k.respondeA), ['id', 'texto', 'usuario']);
  assert.deepEqual(claves(t.respondeA), claves(k.respondeA));
  assert.deepEqual(claves(i.respondeA), claves(k.respondeA));
});

test('sin respuesta, ninguna de las tres inventa un respondeA', () => {
  /* Un `respondeA` en undefined no es lo mismo que no estar: sale por
     JSON y la pagina decide si dibuja la cita mirando si existe. */
  for (const [nombre, m] of [['kick', deKick(false)], ['twitch', deTwitch(false)], ['irc', deIrc(false)]]) {
    assert.equal('respondeA' in m, false, `${nombre} dejo un respondeA puesto sin haber respuesta`);
  }
});
