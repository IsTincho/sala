import test from 'node:test';
import assert from 'node:assert/strict';
import { deStarvios, actividadDeStarvios, emotesDeStarvios, codigosDeStarvios } from '../servidor/mensajes.js';
import { leerConfig } from '../servidor/starvios.js';

const fila = {
  id: 'f1', user_id: 'u1', body: 'hola :nt:', coins: 0, kind: 'chat', badges: [],
  is_deleted: false, created_at: '2026-10-05T18:30:50.522733+00:00',
  profiles: { username: 'istincho', display_name: 'Tincho', chat_color: '#FF476C' },
};

test('una fila de Starvios sale con el formato unico', () => {
  const m = deStarvios(fila);
  assert.equal(m.red, 'starvios');
  assert.equal(m.usuario, 'Tincho');
  assert.equal(m.usuarioId, 'u1');
  assert.equal(m.color, '#ff476c');
  assert.equal(m.texto, 'hola :nt:');
  assert.deepEqual(m.emotes, []);
  assert.equal(m.hora, '2026-10-05T18:30:50.522Z');
});

test('el mensaje pagado lleva sus monedas como insignia', () => {
  const m = deStarvios({ ...fila, coins: 5 });
  assert.equal(m.insignias[0].texto, '5 Starvies');
});

test('borrados, vacios y filas raras no salen', () => {
  assert.equal(deStarvios({ ...fila, is_deleted: true }), null);
  assert.equal(deStarvios({ ...fila, body: '' }), null);
  assert.equal(deStarvios(null), null);
  assert.equal(deStarvios({ ...fila, profiles: { chat_color: 'red' } }).color, '');
});

test('la config junta STARVIOS_CANALES y el usuario del dueño', () => {
  assert.deepEqual(leerConfig({}), []);
  assert.deepEqual(leerConfig({ KICK_SLUG: 'IsTincho', STARVIOS_USUARIO: 'istincho' }), [['istincho', 'istincho']]);
  assert.deepEqual(leerConfig({ STARVIOS_CANALES: 'a:x, b:y', KICK_SLUG: 'a', STARVIOS_USUARIO: 'z' }),
    [['a', 'x'], ['b', 'y']]);
});

test('los :codigo: del catalogo salen como emotes, en puntos de codigo', () => {
  const urls = new Map([['nt', 'https://x.supabase.co/nt.png']]);
  const m = deStarvios({ ...fila, body: '💀 :nt: y :face:' }, { emotes: urls });
  assert.deepEqual(m.emotes, [{ id: 'nt', inicio: 2, fin: 6, url: 'https://x.supabase.co/nt.png', fuente: 'starvios' }]);
  assert.deepEqual([...m.texto].slice(2, 6).join(''), ':nt:');
  assert.deepEqual(codigosDeStarvios('a :nt: b :face:'), ['nt', 'face']);
  assert.deepEqual(emotesDeStarvios(':nt:', new Map()), []);
});

test('las insignias de rol usan el set propio; las desconocidas van como texto', () => {
  const m = deStarvios({ ...fila, badges: ['owner', 'member', 'rara'] });
  assert.equal(m.insignias[0].url, '/comun/insignias/kick/broadcaster.svg');
  assert.equal(m.insignias[1].url, '/comun/insignias/kick/subscriber.svg');
  assert.deepEqual(m.insignias[2], { tipo: 'rara', version: '', texto: 'rara', url: '' });
});

test('raid, lluvia de estrellas y mensajes del sistema se leen bien', () => {
  assert.equal(deStarvios({ ...fila, kind: 'raid', body: 'raid', meta: { viewers: 3 } }).texto,
    '🚀 llegó con un raid de 3 espectadores');
  assert.equal(deStarvios({ ...fila, kind: 'starfall', body: '¡Lluvia!', meta: { level: 1 } }).insignias[0].texto,
    'Lluvia de estrellas');
  assert.equal(deStarvios({ ...fila, kind: 'system', body: 'hola', meta: { bot: true } }).usuario, 'Starvios');
});

test('las subs no son mensajes: salen como actividad', () => {
  const sub = { ...fila, kind: 'sub', body: 'x se ha suscrito', meta: { months: 1 } };
  assert.equal(deStarvios(sub), null);
  const a = actividadDeStarvios(sub);
  assert.equal(a.tipo, 'actividad');
  assert.equal(a.red, 'starvios');
  assert.equal(a.clase, 'sub');
  assert.equal(actividadDeStarvios({ ...sub, meta: { months: 3 } }).clase, 'resub');
  const regalo = actividadDeStarvios({ ...fila, kind: 'gift_sub', meta: { months: 1, recipient: 'ana', anonymous: true } });
  assert.equal(regalo.clase, 'regalo');
  assert.equal(regalo.usuario, 'anonimo');
  assert.equal(regalo.mensaje, 'para ana');
  assert.equal(actividadDeStarvios(fila), null);
});
