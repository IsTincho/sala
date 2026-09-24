/* ============================================================
   Los traductores: de cada plataforma al formato unico.

   Casi todos estos tests estan escritos alrededor del mismo error,
   que es el que de verdad se comete aca: contar el texto con
   `.length` en vez de contar puntos de codigo. `.length` cuenta
   unidades UTF-16, o sea que un emoji fuera del plano basico (💀, ese
   que esta en la mitad de los mensajes de un chat) cuenta dos. Un
   solo emoji antes de un emote corre TODOS los emotes que vengan
   despues, y el sintoma es que la imagen aparece comiendose una letra
   del mensaje. Por eso cada test de posiciones tiene un emoji
   adelante: sin el, el codigo roto pasa igual.
   ============================================================ */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as mensajes from '../servidor/mensajes.js';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(
  fs.readFileSync(path.join(AQUI, 'fijos', 'chat-mensaje.json'), 'utf8'),
);

/* Lo que de verdad importa de un emote: que el tramo [inicio, fin)
   del texto, cortado por puntos de codigo, sea exactamente el emote y
   nada mas. Todos los tests de posiciones preguntan esto y no los
   numeros sueltos: los numeros son un detalle, el recorte es el
   contrato. */
const recortar = (texto, { inicio, fin }) => [...texto].slice(inicio, fin).join('');

/* ---------------------------------------------------------- Kick */

test('Kick: el markup del emote se reemplaza por su nombre', () => {
  const { texto, emotes } = mensajes.partirTextoDeKick('hola [emote:37226:KEKW] chau');
  assert.equal(texto, 'hola KEKW chau', 'lo que se ve no lleva el markup adentro');
  assert.equal(emotes.length, 1);
  assert.equal(recortar(texto, emotes[0]), 'KEKW');
  assert.equal(emotes[0].url, 'https://files.kick.com/emotes/37226/fullsize');
});

test('Kick: un emoji antes del emote no corre las posiciones', () => {
  /* EL BUG: con indices de string, el 💀 cuenta dos y el emote queda
     corrido un lugar. El recorte devolveria "Kapp" o " Kapp" en vez
     de "Kappa". */
  const { texto, emotes } = mensajes.partirTextoDeKick('💀 hola [emote:5:Kappa] fin');
  assert.equal(texto, '💀 hola Kappa fin');
  assert.equal(recortar(texto, emotes[0]), 'Kappa');
  assert.equal(emotes[0].inicio, 7, 'siete puntos de codigo antes: el emoji cuenta UNO');
});

test('Kick: varios emotes seguidos caen cada uno en su lugar', () => {
  const { texto, emotes } = mensajes.partirTextoDeKick(
    '🎬[emote:1:uno] y [emote:2:dos] y [emote:3:tres]',
  );
  assert.equal(emotes.length, 3);
  assert.deepEqual(emotes.map(e => recortar(texto, e)), ['uno', 'dos', 'tres']);
  assert.ok(!texto.includes('[emote:'), 'no queda markup suelto');
});

test('Kick: un emote sin nombre igual ocupa lugar', () => {
  /* Si `fin` fuera igual a `inicio`, el cliente no tendria nada que
     reemplazar y la imagen no aparece. */
  const { texto, emotes } = mensajes.partirTextoDeKick('[emote:99:]');
  assert.equal(emotes.length, 1);
  assert.ok(emotes[0].fin > emotes[0].inicio);
  assert.equal(recortar(texto, emotes[0]), texto);
});

test('Kick: el fixture real se traduce entero', () => {
  const m = mensajes.deKick(FIXTURE, { hora: '2026-01-14T16:08:06Z' });
  assert.equal(m.tipo, 'chat');
  assert.equal(m.red, 'kick');
  assert.equal(m.id, FIXTURE.message_id);
  assert.equal(m.usuario, 'unaespectadora');
  assert.equal(m.color, '#ff5733');
  assert.equal(m.texto, 'que peli mas larga HYPERCLAP');
  assert.equal(recortar(m.texto, m.emotes[0]), 'HYPERCLAP');
  /* `version` vacia porque Kick no tiene versiones de insignia, y
     `url` vacia porque Kick no publica las imagenes por ninguna API
     documentada: se ve la etiqueta de texto. */
  assert.deepEqual(m.insignias, [
    { tipo: 'moderator', version: '', texto: 'Moderator', url: '' },
    { tipo: 'subscriber', version: '', texto: 'Subscriber (3)', url: '' },
  ]);
  assert.equal(m.hora, '2026-01-14T16:08:06.000Z');
  assert.equal(m.respondeA, undefined);
});

test('Kick: identity en null no rompe nada', () => {
  /* Viene null de verdad, y seguido: cualquiera que no tenga insignias
     ni color elegido. */
  const m = mensajes.deKick({
    message_id: 'x',
    sender: { username: 'pelado', identity: null },
    content: 'hola',
    created_at: '2026-01-01T00:00:00Z',
  });
  assert.equal(m.color, '');
  assert.deepEqual(m.insignias, []);
  assert.equal(m.texto, 'hola');
});

test('Kick: un color que no es un color no pasa', () => {
  /* El color va derecho a un atributo style del lado del cliente. */
  for (const malo of ['red', '#GGGGGG', 'javascript:alert(1)', '#fff', 42, null]) {
    const m = mensajes.deKick({
      message_id: 'x',
      sender: { username: 'a', identity: { username_color: malo } },
      content: 'hola',
    });
    assert.equal(m.color, '', `no deberia aceptar ${JSON.stringify(malo)}`);
  }
});

test('Kick: la respuesta trae el padre sin markup', () => {
  const m = mensajes.deKick({
    message_id: 'x',
    sender: { username: 'a', identity: null },
    content: 'si',
    replies_to: {
      message_id: 'padre',
      content: 'mira [emote:7:LUL]',
      sender: { username: 'otra' },
    },
  });
  assert.deepEqual(m.respondeA, { id: 'padre', usuario: 'otra', texto: 'mira LUL' });
});

test('Kick: el texto del usuario llega tal cual, sin escapar', () => {
  /* A proposito: escapar ACA seria escapar dos veces cuando el cliente
     use textContent, y se veria "&lt;b&gt;" en pantalla. El escape es
     responsabilidad de quien pinta el DOM. */
  const m = mensajes.deKick({
    message_id: 'x',
    sender: { username: 'a', identity: null },
    content: '<script>alert(1)</script>',
  });
  assert.equal(m.texto, '<script>alert(1)</script>');
});

test('Kick: livestream.status.updated dice si esta en vivo', () => {
  assert.equal(mensajes.vivoDeKick({ is_live: true }), true);
  assert.equal(mensajes.vivoDeKick({ is_live: false }), false);
  assert.equal(mensajes.vivoDeKick({}), null, 'sin el campo no se inventa un valor');
});

/* -------------------------------------------------------- Twitch */

const eventoTwitch = (extra = {}) => ({
  broadcaster_user_id: '1',
  chatter_user_id: '2',
  chatter_user_name: 'Fulana',
  chatter_user_login: 'fulana',
  message_id: 'abc-123',
  color: '#9146FF',
  badges: [],
  message: { text: 'hola', fragments: [{ type: 'text', text: 'hola' }] },
  ...extra,
});

test('Twitch: los fragmentos arman el texto y ubican los emotes', () => {
  const m = mensajes.deTwitch(eventoTwitch({
    message: {
      text: '💀 Kappa fin',
      fragments: [
        { type: 'text', text: '💀 ' },
        { type: 'emote', text: 'Kappa', emote: { id: '25' } },
        { type: 'text', text: ' fin' },
      ],
    },
  }), { message_timestamp: '2026-02-02T10:00:00.000Z' });

  assert.equal(m.texto, '💀 Kappa fin');
  assert.equal(m.emotes.length, 1);
  assert.equal(recortar(m.texto, m.emotes[0]), 'Kappa',
    'el emoji de adelante no puede correr el emote');
  assert.equal(m.emotes[0].url,
    'https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/2.0');
  assert.equal(m.hora, '2026-02-02T10:00:00.000Z');
});

test('Twitch: las menciones y los cheermotes son texto comun', () => {
  const m = mensajes.deTwitch(eventoTwitch({
    message: {
      text: '@alguien cheer100 hola',
      fragments: [
        { type: 'mention', text: '@alguien', mention: { user_id: '9' } },
        { type: 'text', text: ' ' },
        { type: 'cheermote', text: 'cheer100', cheermote: { prefix: 'cheer', bits: 100 } },
        { type: 'text', text: ' hola' },
      ],
    },
  }));
  assert.equal(m.texto, '@alguien cheer100 hola');
  assert.deepEqual(m.emotes, [], 'solo los fragmentos de tipo emote son emotes');
});

test('Twitch: un fragmento de emote sin texto no deja un rango vacio', () => {
  /* Un rango de largo cero no tapa ningun texto y no se ve, pero la
     pagina igual le dibuja un <img>, y lo que venga encima se dibuja
     DOS veces: `agregarTextoConEmotes()` avanza el cursor a `fin`, que
     es el mismo `inicio`. Los otros dos traductores ya no pueden
     emitir uno (Kick le pone un nombre de respaldo al emote sin
     nombre, `deIrc` descarta `fin <= inicio`); este era el unico. */
  const m = mensajes.deTwitch(eventoTwitch({
    message: {
      text: 'hola',
      fragments: [
        { type: 'emote', text: '', emote: { id: '25' } },
        { type: 'text', text: 'hola' },
      ],
    },
  }));
  assert.deepEqual(m.emotes, []);
  assert.equal(m.texto, 'hola');
});

test('Twitch: un emote que el recorte deja afuera del texto no sale', () => {
  /* Son dos cortes que no miden lo mismo: el tope de fragmentos corta
     DESPUES de agregar el fragmento, y `limpiar()` recorta por unidades
     UTF-16 mientras los indices de los emotes cuentan puntos de codigo.
     En el limite, el ultimo emote queda apuntando mas alla del final
     del texto y la pagina se come la cola del mensaje. `deIrc` ya
     descartaba los indices de afuera; esto es lo mismo del otro lado. */
  const m = mensajes.deTwitch(eventoTwitch({
    message: {
      fragments: [
        { type: 'text', text: '💀'.repeat(1000) },   // 2000 unidades UTF-16, 1000 puntos
        { type: 'emote', text: 'Kappa', emote: { id: '25' } },
      ],
    },
  }));
  const largoEnPuntos = [...m.texto].length;
  for (const e of m.emotes) {
    assert.ok(e.fin <= largoEnPuntos,
      `el emote llega hasta ${e.fin} y el texto tiene ${largoEnPuntos} puntos de codigo`);
  }
});

test('Twitch: las insignias se traducen y el subscriber muestra los meses', () => {
  const m = mensajes.deTwitch(eventoTwitch({
    badges: [
      { set_id: 'broadcaster', id: '1', info: '' },
      { set_id: 'subscriber', id: '12', info: '18' },
      { set_id: 'subscriber_nuevo_de_twitch', id: '1', info: '' },
    ],
  }));
  /* `version` es el `id` que manda EventSub: CUAL de los dibujos del
     set, no los meses (los meses son `info`, y van en el texto).
     `url` la completa despues `insignias.js`. */
  assert.deepEqual(m.insignias, [
    { tipo: 'broadcaster', version: '1', texto: 'Streamer', url: '' },
    { tipo: 'subscriber', version: '12', texto: 'Sub (18)', url: '' },
    /* Una insignia que no conocemos se muestra con su id: esconderla
       seria mentir sobre quien es el que habla. */
    { tipo: 'subscriber_nuevo_de_twitch', version: '1', texto: 'subscriber_nuevo_de_twitch', url: '' },
  ]);
});

test('Twitch: un set_id que se llama como un miembro del prototipo no se cuela', () => {
  /* `NOMBRES_TWITCH['constructor']` devolvia la funcion `Object`, y el
     `?? tipo` no lo ataja porque no es null: el chat mostraba el codigo
     fuente de una funcion como nombre de insignia. Con la tabla sin
     prototipo, cae en el `?? tipo` como cualquier set desconocido. */
  const m = mensajes.deTwitch(eventoTwitch({
    badges: [
      { set_id: 'constructor', id: '1', info: '' },
      { set_id: 'toString', id: '1', info: '' },
      { set_id: 'hasOwnProperty', id: '1', info: '' },
    ],
  }));

  assert.deepEqual(m.insignias.map(i => i.texto), ['constructor', 'toString', 'hasOwnProperty']);
  for (const i of m.insignias) assert.equal(typeof i.texto, 'string');
});

test('IRC: un badge que se llama como un miembro del prototipo tampoco', () => {
  const m = mensajes.deIrc(
    new Map([['badges', 'constructor/1'], ['display-name', 'Fulana'], ['user-id', '9']]),
    'fulana', 'hola');
  assert.deepEqual(m.insignias.map(i => i.texto), ['constructor']);
});

test('Twitch: la respuesta usa los nombres de campo de EventSub', () => {
  const m = mensajes.deTwitch(eventoTwitch({
    reply: {
      parent_message_id: 'p1',
      parent_message_body: 'que dijiste',
      parent_user_name: 'Mengano',
      parent_user_login: 'mengano',
    },
  }));
  assert.deepEqual(m.respondeA, { id: 'p1', usuario: 'Mengano', texto: 'que dijiste' });
});

test('Twitch: sin fragmentos se usa el texto plano', () => {
  const m = mensajes.deTwitch(eventoTwitch({ message: { text: 'sin fragmentos' } }));
  assert.equal(m.texto, 'sin fragmentos');
  assert.deepEqual(m.emotes, []);
});

test('Twitch: el color vacio que manda Twitch queda vacio', () => {
  /* Twitch manda "" cuando la persona nunca eligio color. No es un
     error: la pagina pinta con el color de la red. */
  const m = mensajes.deTwitch(eventoTwitch({ color: '' }));
  assert.equal(m.color, '');
});

/* ---------------------------------------------------- Twitch por IRC */

test('IRC: los indices del tag emotes son inclusivos y aca pasan a exclusivos', () => {
  /* El ejemplo textual de la doc de Twitch: "Kappa Keepo Kappa" con
     emotes=25:0-4,12-16/1902:6-10. EL BUG que ataja: olvidarse el +1
     y recortar "Kapp". */
  const texto = 'Kappa Keepo Kappa';
  const m = mensajes.deIrc(
    new Map([['id', 'i1'], ['display-name', 'ronni'], ['emotes', '25:0-4,12-16/1902:6-10']]),
    'ronni', texto,
  );
  assert.equal(m.emotes.length, 3);
  assert.deepEqual(m.emotes.map(e => recortar(texto, e)), ['Kappa', 'Keepo', 'Kappa']);
  assert.deepEqual(m.emotes.map(e => e.id), ['25', '1902', '25'],
    'quedan ordenados por posicion, no por el orden del tag');
});

test('IRC: los indices cuentan puntos de codigo', () => {
  /* "💀 Kappa": el emote arranca en el punto 2, no en el 3. */
  const texto = '💀 Kappa';
  const m = mensajes.deIrc(new Map([['emotes', '25:2-6']]), 'x', texto);
  assert.equal(recortar(texto, m.emotes[0]), 'Kappa');
});

test('IRC: un rango que no entra en el texto se descarta', () => {
  /* Mandar un rango invalido al navegador dejaria un recorte vacio o
     una excepcion en el medio del render de un mensaje. */
  const m = mensajes.deIrc(new Map([['emotes', '25:0-400/9:abc-def']]), 'x', 'corto');
  assert.deepEqual(m.emotes, []);
});

test('IRC: badge-info manda sobre badges para los meses de sub', () => {
  const m = mensajes.deIrc(
    new Map([['badges', 'moderator/1,subscriber/6'], ['badge-info', 'subscriber/25']]),
    'x', 'hola',
  );
  /* Y la version sale de `badges` (el 6, o sea el tramo de 6 meses),
     no de `badge-info` (el 25, los meses de verdad). Son dos numeros
     distintos en el mismo tag y confundirlos le cambia el escudo a
     todos los subs justo la noche en que entra el plan B. */
  assert.deepEqual(m.insignias, [
    { tipo: 'moderator', version: '1', texto: 'Mod', url: '' },
    { tipo: 'subscriber', version: '6', texto: 'Sub (25)', url: '' },
  ]);
});

test('IRC: sin display-name se usa el nick del prefijo', () => {
  const m = mensajes.deIrc(new Map(), 'ronni', 'hola');
  assert.equal(m.usuario, 'ronni');
});

test('IRC: tmi-sent-ts es epoch en milisegundos', () => {
  const m = mensajes.deIrc(new Map([['tmi-sent-ts', '1507246572675']]), 'x', 'hola');
  assert.equal(m.hora, new Date(1507246572675).toISOString());
});

/* ------------------------------------------------------------ horas */

test('una hora que no se entiende no deja el mensaje sin hora', () => {
  const antes = Date.now();
  const h = mensajes.horaIso('la semana pasada');
  assert.ok(Date.parse(h) >= antes, 'cae en ahora, no en NaN ni en vacio');
});
