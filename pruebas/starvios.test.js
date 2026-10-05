import test from 'node:test';
import assert from 'node:assert/strict';
import { deStarvios } from '../servidor/mensajes.js';
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
  assert.equal(m.insignias[0].texto, '5 ★');
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
