/* ============================================================
   El QR de `paginas/comun/qr.js`.

   ---------------------------------------------------------------
   LO QUE ESTAS PRUEBAS NO PUEDEN HACER

   No pueden decir si un celular lo lee. Para eso hace falta un
   decodificador de verdad y ajeno, y eso se hizo aparte, una vez, con
   jsQR bajado de un CDN: `herramientas/verificar-qr.mjs`. Ahí se
   generaron las diez versiones al tope de su capacidad, 300 textos al
   azar, los links reales del proyecto y textos con acentos y emojis, y
   los 328 volvieron decodificados iguales. La BITACORA lo anota.

   `npm test` no sale a internet, así que acá se prueba lo otro: la
   FORMA (los tres cuadrados de las esquinas, la temporización, el
   tamaño, la versión que se elige) y que el dibujo NO CAMBIE. Si
   alguien toca el enmascarado o una tabla, la prueba de abajo se cae y
   hay que volver a correr la verificación de verdad antes de darla por
   buena. Ese es todo su trabajo.

   El módulo es un script de navegador: se corre en un contexto con un
   `window` de mentira, que es todo lo que necesita.
   ============================================================ */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const ventana = {};
vm.runInNewContext(
  fs.readFileSync(path.join(AQUI, '..', 'paginas', 'comun', 'qr.js'), 'utf8'),
  { window: ventana, TextEncoder },
  { filename: 'comun/qr.js' },
);
const { matriz, svg, datosUri, capacidad, VERSIONES } = ventana.SalaQR;

const LINK = 'https://multichat-osmiumstudio.pages.dev/chat/istincho';

/** El cuadrado de posición de una esquina, como tiene que verse. */
const CUADRADO = [
  '#######',
  '#.....#',
  '#.###.#',
  '#.###.#',
  '#.###.#',
  '#.....#',
  '#######',
];

const leerCuadrado = (m, f0, c0) =>
  CUADRADO.map((_, f) => CUADRADO[f].split('').map((_, c) => (m[f0 + f][c0 + c] ? '#' : '.')).join(''));

/* ------------------------------------------------------- la forma */

test('los tres cuadrados de las esquinas están donde van', () => {
  /* Son los que le dicen a la cámara dónde está el código y cómo está
     girado. Sin uno de los tres no hay QR. */
  const m = matriz(LINK);
  const n = m.length;

  assert.deepEqual(leerCuadrado(m, 0, 0), CUADRADO, 'arriba a la izquierda');
  assert.deepEqual(leerCuadrado(m, 0, n - 7), CUADRADO, 'arriba a la derecha');
  assert.deepEqual(leerCuadrado(m, n - 7, 0), CUADRADO, 'abajo a la izquierda');

  /* Y abajo a la derecha NO hay ninguno: es lo que le dice a la cámara
     cómo está girado el código. */
  assert.notDeepEqual(leerCuadrado(m, n - 7, n - 7), CUADRADO);
});

test('los separadores dejan la calle blanca alrededor de cada cuadrado', () => {
  const m = matriz(LINK);
  const n = m.length;
  for (let i = 0; i < 8; i++) {
    assert.equal(m[7][i], false, 'fila 7 del de arriba a la izquierda');
    assert.equal(m[i][7], false, 'columna 7 del de arriba a la izquierda');
    assert.equal(m[7][n - 1 - i], false);
    assert.equal(m[n - 1 - i][7], false);
  }
});

test('las líneas de temporización alternan', () => {
  /* Son la regla con la que la cámara mide el tamaño de cada módulo. */
  const m = matriz(LINK);
  for (let i = 8; i < m.length - 8; i++) {
    assert.equal(m[6][i], i % 2 === 0, `fila 6, columna ${i}`);
    assert.equal(m[i][6], i % 2 === 0, `columna 6, fila ${i}`);
  }
});

test('el módulo que siempre es oscuro lo es', () => {
  const m = matriz(LINK);
  assert.equal(m[m.length - 8][8], true);
});

test('la matriz es cuadrada y del tamaño de su versión', () => {
  /* 4 x versión + 17, siempre. */
  for (const [texto, version] of [['a', 1], ['a'.repeat(30), 3], ['a'.repeat(100), 6], ['a'.repeat(213), 10]]) {
    const m = matriz(texto);
    assert.equal(m.length, version * 4 + 17, `"${texto.slice(0, 5)}…" tendría que ser versión ${version}`);
    for (const fila of m) assert.equal(fila.length, m.length);
  }
});

test('usa la versión más chica donde entra, y ni una más', () => {
  for (let v = 1; v <= VERSIONES; v++) {
    const cap = capacidad(v);
    assert.equal(matriz('a'.repeat(cap)).length, v * 4 + 17, `${cap} bytes tienen que entrar en la versión ${v}`);
    if (v < VERSIONES) {
      assert.equal(matriz('a'.repeat(cap + 1)).length, (v + 1) * 4 + 17,
        'uno más tiene que saltar a la siguiente');
    }
  }
});

test('lo que no entra tira, en vez de dibujar un QR cortado', () => {
  assert.throws(() => matriz('a'.repeat(capacidad(VERSIONES) + 1)), /no entra/);
});

test('las tablas cierran: bloques por (datos + corrección) da el total', () => {
  /* Es la cuenta que caza un número mal copiado en cualquiera de las
     dos tablas, que es el error que da un QR ilegible sin que nada
     avise. Se mira de afuera: si no cerrara, la versión elegida para
     un texto al tope no tendría el tamaño que tiene. */
  for (let v = 1; v <= VERSIONES; v++) {
    const m = matriz('x'.repeat(capacidad(v)));
    assert.equal(m.length, v * 4 + 17);
  }
});

/* ------------------------------------------------- el dibujo no cambia */

test('el mismo texto da siempre el mismo dibujo', () => {
  const a = matriz(LINK);
  const b = matriz(LINK);
  assert.deepEqual(a, b);
});

test('EL DIBUJO DE UN LINK CONOCIDO NO CAMBIÓ', () => {
  /* Esta huella se sacó de un QR que jsQR decodificó bien (ver el
     encabezado). Si esto se cae, el QR cambió: puede estar igual de
     bien, pero hay que volver a correr `herramientas/verificar-qr.mjs`
     —que sale a internet— antes de darlo por bueno. */
  const m = matriz(LINK);
  const plano = m.map(f => f.map(v => (v ? '1' : '0')).join('')).join('\n');
  const huella = crypto.createHash('sha256').update(plano).digest('hex').slice(0, 16);
  assert.equal(m.length, 33, 'ese link entra en una versión 4');
  assert.equal(huella, 'bd9abc464ab27913', 'el dibujo del QR cambió');
});

/* ------------------------------------------------------- el svg */

test('el svg tiene el margen que piden las cámaras y un solo camino', () => {
  const s = svg(LINK);
  const m = matriz(LINK);
  /* Cuatro módulos de margen de cada lado: sin eso muchas cámaras no
     lo encuentran. */
  assert.match(s, new RegExp(`viewBox="0 0 ${m.length + 8} ${m.length + 8}"`));
  assert.equal((s.match(/<path/g) ?? []).length, 1, 'un solo path: no mil rectángulos sueltos');
  assert.match(s, /<rect [^>]*fill="#ffffff"/, 'el fondo blanco va adentro del svg');
  assert.match(s, /role="img"/);
  assert.match(s, /aria-label=/);
});

test('el data uri se puede poner en el src de un <img>', () => {
  const uri = datosUri(LINK);
  assert.match(uri, /^data:image\/svg\+xml;charset=utf-8,/);
  /* Nada sin escapar que pueda cortar el atributo. */
  assert.equal(uri.includes('"'), false);
  assert.equal(uri.includes('<'), false);
  assert.equal(uri.includes('#'), false, 'un # sin escapar corta el uri en el navegador');
});
