/* ============================================================
   Los numeros que salen de process.env.

   Lo que se prueba es lo que se rompe callado:

     - UN TYPO NO SE CUELA COMO NaN. `EMOTES_PLAZO_MS=20s` daba NaN, y
       `setTimeout(fn, NaN)` dispara a UN milisegundo: el typo no
       alargaba el plazo, apagaba los emotes para siempre. Un tope en
       NaN es peor todavia, porque `x >= NaN` es false y eso no es un
       tope mas grande, es ninguno.
     - EL CERO SOBREVIVE. Es el motivo por el que esto no es
       `Number(x) || defecto`: hay variables donde el cero es un valor
       que alguien quiere de verdad (`TOPE_TWITCH=0`, `GB_AMIGO=0`).
     - EL VALOR NO SE IMPRIME NUNCA, ni cuando esta mal. El dueño
       trabaja con la pantalla al aire.
   ============================================================ */

import test from 'node:test';
import assert from 'node:assert/strict';

import { numeroDeEntorno, olvidarAvisos } from '../servidor/entorno.js';

const VAR = 'SALA_PRUEBA_NUMERO';

function conValor(valor, fn) {
  const antes = process.env[VAR];
  if (valor === undefined) delete process.env[VAR];
  else process.env[VAR] = valor;
  olvidarAvisos();
  try { return fn(); }
  finally {
    if (antes === undefined) delete process.env[VAR];
    else process.env[VAR] = antes;
  }
}

/** Corre `fn` juntando lo que salga por console.warn. */
function conLog(fn) {
  const warnDeVerdad = console.warn;
  const lineas = [];
  console.warn = (...partes) => lineas.push(partes.join(' '));
  try { fn(); }
  finally { console.warn = warnDeVerdad; }
  return lineas;
}

test('un numero bien escrito se usa tal cual', () => {
  conValor('2500', () => assert.equal(numeroDeEntorno(VAR, 20000), 2500));
  conValor(' 2500 ', () => assert.equal(numeroDeEntorno(VAR, 20000), 2500,
    'con espacios alrededor, que es lo que deja copiar y pegar'));
  conValor('1.5', () => assert.equal(numeroDeEntorno(VAR, 9), 1.5));
});

test('sin la variable, el defecto', () => {
  conValor(undefined, () => assert.equal(numeroDeEntorno(VAR, 20000), 20000));
  conValor('', () => assert.equal(numeroDeEntorno(VAR, 20000), 20000,
    'y vacia cuenta como no puesta: es lo que deja un panel donde borraron el valor'));
});

test('un valor que no es un numero NO se convierte en NaN', () => {
  /* EL BUG. `Math.max(1000, Number('20s'))` daba NaN y
     `setTimeout(fn, NaN)` dispara a 1 ms. */
  for (const typo of ['20s', '20 segundos', 'veinte', '0x', '--5', 'null']) {
    conValor(typo, () => {
      const v = numeroDeEntorno(VAR, 20000, { minimo: 1000 });
      assert.equal(Number.isFinite(v), true, typo);
      assert.equal(v, 20000, typo);
    });
  }
});

test('Infinity tampoco pasa: setTimeout con Infinity tambien dispara a 1 ms', () => {
  for (const malo of ['Infinity', '-Infinity', 'NaN']) {
    conValor(malo, () => assert.equal(numeroDeEntorno(VAR, 30, { minimo: 1 }), 30, malo));
  }
});

test('el cero se respeta, que es lo que `|| defecto` se llevaba puesto', () => {
  /* `TOPE_TWITCH=0` es "no abras ninguna conexion de EventSub" y
     `GB_AMIGO=0` es "este plan no sube videos". Con `||` los dos se
     convertian callados en el defecto: el mismo bug de clase —una
     configuracion ignorada en silencio— apenas mas barato. */
  conValor('0', () => assert.equal(numeroDeEntorno(VAR, 50), 0));
  conValor('0', () => assert.equal(numeroDeEntorno(VAR, 50, { minimo: 0 }), 0));
});

test('el piso y el techo se aplican al final', () => {
  conValor('5', () => assert.equal(numeroDeEntorno(VAR, 20000, { minimo: 1000 }), 1000));
  conValor('-7', () => assert.equal(numeroDeEntorno(VAR, 30, { minimo: 1 }), 1));
  conValor('99999', () => assert.equal(numeroDeEntorno(VAR, 8778, { maximo: 65535 }), 65535));
});

test('avisa cuando el valor no sirve, una sola vez, y sin imprimir el valor', () => {
  const lineas = conValor('20s-secreto', () => conLog(() => {
    numeroDeEntorno(VAR, 20000);
    numeroDeEntorno(VAR, 20000);
    numeroDeEntorno(VAR, 20000);
  }));

  assert.equal(lineas.length, 1, 'una sola vez por variable, no una por lectura');
  assert.match(lineas[0], new RegExp(VAR), 'dice el nombre, que es lo que hace falta para arreglarlo');
  assert.equal(lineas[0].includes('20s-secreto'), false,
    'y NO dice el valor: aca no se imprime el contenido de ninguna variable de entorno');
});

test('un valor bueno no avisa nada', () => {
  const lineas = conValor('1234', () => conLog(() => numeroDeEntorno(VAR, 20000)));
  assert.deepEqual(lineas, []);
});
