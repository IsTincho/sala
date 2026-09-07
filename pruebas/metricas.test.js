/* ============================================================
   Pruebas de servidor/metricas.js.

   Todo en memoria (no toca el almacen ni SALA_DATOS), asi que estas
   pruebas se concentran en la aritmetica del anillo de 24 horas: es
   la parte con estado escondido y la que un cambio sin querer rompe
   mas facil.

   Cada test que mide "mensajes por hora" pasa `ahora` a mano en vez
   de dejar que las funciones usen Date.now(): sin eso, un test que
   corra justo al filo de una hora podria fallar por casualidad, y el
   test de "la vuelta del anillo" ni siquiera se podria escribir.

   reiniciar() se llama antes de cada test (en vez de una vez al
   principio) porque las medidas viven en un Map de modulo que no se
   reimporta entre tests: sin este reset, un test contaminaria el
   siguiente por compartir el mismo canal.
   ============================================================ */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as metricas from '../servidor/metricas.js';

const HORA = 60 * 60 * 1000;

/* Un punto fijo en el tiempo, arrancando justo al principio de una
   hora, para que las cuentas de este archivo sean faciles de seguir. */
const T0 = Date.UTC(2026, 0, 1, 10, 0, 0);

beforeEach(() => { metricas.reiniciar(); });

/* ------------------------------------------------------- mensajes */

test('registrarMensaje suma en el casillero de su hora', () => {
  metricas.registrarMensaje('istincho', T0);
  metricas.registrarMensaje('istincho', T0 + 1000);
  metricas.registrarMensaje('istincho', T0 + 2000);

  const r = metricas.resumen('istincho', T0);
  assert.equal(r.mensajesUltimaHora, 3);
  assert.equal(r.mensajesTotales, 3);
});

test('mensajesUltimaHora cuenta solo la hora actual, mensajesTotales las 24', () => {
  metricas.registrarMensaje('istincho', T0 - HORA);       // hora anterior
  metricas.registrarMensaje('istincho', T0 - HORA);
  metricas.registrarMensaje('istincho', T0);               // hora actual
  metricas.registrarMensaje('istincho', T0 + 100);

  const r = metricas.resumen('istincho', T0);
  assert.equal(r.mensajesUltimaHora, 2, 'solo los de la hora actual');
  assert.equal(r.mensajesTotales, 4, 'las 24 horas juntas');
});

/* --------------------------------------------------- vuelta del anillo

   EL BUG QUE ESTO ATAJA: el anillo tiene 24 casilleros indexados por
   `hora % 24`. Sin guardar de que hora es cada casillero, un servidor
   que vive mas de un dia mezclaria el trafico de hoy a las 10 con el
   de ayer a las 10, porque caen en el mismo indice. Por eso cada
   casillero guarda tambien su marca de hora y se resetea cuando esa
   marca cambia. */

test('la vuelta del anillo: la misma hora 24hs despues pisa el casillero, no lo suma', () => {
  metricas.registrarMensaje('istincho', T0);
  metricas.registrarMensaje('istincho', T0);
  metricas.registrarMensaje('istincho', T0);   // 3 mensajes en la hora H

  const unDiaDespues = T0 + 24 * HORA;         // mismo casillero del anillo (H % 24)
  metricas.registrarMensaje('istincho', unDiaDespues);

  const r = metricas.resumen('istincho', unDiaDespues);
  assert.equal(r.mensajesUltimaHora, 1, 'el casillero se piso, no se sumo a los 3 viejos');
});

/* --------------------------------------------------------- porHora */

test('mensajesPorHora siempre trae 24 entradas, de la mas vieja a la mas nueva, en cero si no hubo trafico', () => {
  metricas.registrarMensaje('istincho', T0);
  metricas.registrarMensaje('istincho', T0 - 5 * HORA);

  const r = metricas.resumen('istincho', T0);
  assert.equal(r.mensajesPorHora.length, 24);

  // la ultima entrada es la hora actual
  assert.equal(r.mensajesPorHora.at(-1).hora, T0);
  assert.equal(r.mensajesPorHora.at(-1).cuenta, 1);

  // esta ordenado de mas vieja a mas nueva
  for (let i = 1; i < r.mensajesPorHora.length; i++) {
    assert.ok(r.mensajesPorHora[i].hora > r.mensajesPorHora[i - 1].hora);
  }

  // la de 5 horas atras tiene su mensaje, las demas sin trafico estan en cero
  const haceCinco = r.mensajesPorHora.find(c => c.hora === T0 - 5 * HORA);
  assert.equal(haceCinco.cuenta, 1);
  const sinTrafico = r.mensajesPorHora.filter(c => c.hora !== T0 && c.hora !== T0 - 5 * HORA);
  assert.ok(sinTrafico.every(c => c.cuenta === 0));
});

/* -------------------------------------------------------- envios */

test('registrarEnvio cuenta envios, ok y 429 por separado', () => {
  metricas.registrarEnvio('istincho', { ok: true, estado: 200 });
  metricas.registrarEnvio('istincho', { ok: true, estado: 200 });
  metricas.registrarEnvio('istincho', { ok: false, estado: 429 });
  metricas.registrarEnvio('istincho', { ok: false, estado: 500 });

  const r = metricas.resumen('istincho', T0);
  assert.equal(r.envios, 4);
  assert.equal(r.enviosOk, 2);
  assert.equal(r.errores429, 1);
});

/* ----------------------------------------------------- conectados */

test('verConectados se queda con el maximo, no con el ultimo', () => {
  metricas.verConectados('istincho', 10);
  metricas.verConectados('istincho', 3);   // bajo, pero el pico sigue siendo 10

  const r = metricas.resumen('istincho', T0);
  assert.equal(r.espectadoresPico, 10);
});

/* -------------------------------------------------------- canales */

test('los canales no se mezclan entre si', () => {
  metricas.registrarMensaje('sala-a', T0);
  metricas.registrarMensaje('sala-a', T0);
  metricas.registrarMensaje('sala-b', T0);
  metricas.registrarEnvio('sala-a', { ok: true, estado: 200 });
  metricas.verConectados('sala-a', 50);
  metricas.verConectados('sala-b', 5);

  const a = metricas.resumen('sala-a', T0);
  const b = metricas.resumen('sala-b', T0);

  assert.equal(a.mensajesUltimaHora, 2);
  assert.equal(b.mensajesUltimaHora, 1);
  assert.equal(a.envios, 1);
  assert.equal(b.envios, 0);
  assert.equal(a.espectadoresPico, 50);
  assert.equal(b.espectadoresPico, 5);
});

/* -------------------------------------------------------- reiniciar */

test('reiniciar deja todo en cero', () => {
  metricas.registrarMensaje('istincho', T0);
  metricas.registrarEnvio('istincho', { ok: true, estado: 200 });
  metricas.verConectados('istincho', 20);

  metricas.reiniciar();

  const r = metricas.resumen('istincho', T0);
  assert.equal(r.mensajesUltimaHora, 0);
  assert.equal(r.mensajesTotales, 0);
  assert.equal(r.envios, 0);
  assert.equal(r.enviosOk, 0);
  assert.equal(r.errores429, 0);
  assert.equal(r.espectadoresPico, 0);
});
