/* ============================================================
   Verifica el QR de `paginas/comun/qr.js` contra un decodificador de
   verdad y ajeno.

       node herramientas/verificar-qr.mjs

   NO ES PARTE DE `npm test`, y por eso vive acá: baja jsQR de un CDN,
   o sea que sale a internet, y la suite del repo no sale a internet
   nunca. Se corre a mano cuando se toca `qr.js` —y la prueba
   `pruebas/qr.test.js` avisa cuando eso pasó, porque guarda la huella
   del dibujo de un link conocido.

   Qué hace: genera QR con el código del proyecto, los pinta a píxeles
   en memoria (sin navegador: jsQR sólo quiere un array RGBA) y los
   manda a decodificar. Si lo que vuelve no es exactamente el texto que
   entró, falla.

   Qué prueba, que es lo que las pruebas del repo no pueden:
     - las diez versiones al tope de su capacidad, que es donde se nota
       una tabla de bloques mal copiada;
     - 300 textos al azar de cualquier largo;
     - los links de verdad del proyecto;
     - acentos y emojis (UTF-8 de varios bytes).

   La última corrida está anotada en la BITACORA.
   ============================================================ */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const QR_JS = path.join(AQUI, '..', 'paginas', 'comun', 'qr.js');

/* qr.js es un script de navegador: se corre con un window de mentira. */
const ventana = {};
vm.runInNewContext(fs.readFileSync(QR_JS, 'utf8'), { window: ventana, TextEncoder });
const { matriz, capacidad, VERSIONES } = ventana.SalaQR;

/* jsQR, bajado al vuelo. Es un UMD: se le da un module/exports y listo. */
const URL_JSQR = 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js';
console.log(`bajando el decodificador de ${URL_JSQR} …`);
const codigo = await (await fetch(URL_JSQR)).text();
const caja = { module: { exports: {} }, exports: {}, console };
caja.self = caja;
vm.runInNewContext(codigo, caja);
const jsQR = caja.module.exports.default ?? caja.module.exports;
if (typeof jsQR !== 'function') throw new Error('no se pudo cargar jsQR');

/** La matriz pintada a píxeles RGBA, con margen y escala. */
function aPixeles(m, { margen = 4, escala = 4 } = {}) {
  const n = m.length;
  const lado = (n + margen * 2) * escala;
  const datos = new Uint8ClampedArray(lado * lado * 4).fill(255);
  for (let f = 0; f < n; f++) {
    for (let c = 0; c < n; c++) {
      if (!m[f][c]) continue;
      for (let y = 0; y < escala; y++) {
        for (let x = 0; x < escala; x++) {
          const i = (((f + margen) * escala + y) * lado + (c + margen) * escala + x) * 4;
          datos[i] = datos[i + 1] = datos[i + 2] = 0;
        }
      }
    }
  }
  return { datos, lado };
}

const LETRAS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_./:';
const alAzar = (largo) =>
  Array.from({ length: largo }, () => LETRAS[Math.floor(Math.random() * LETRAS.length)]).join('');

let fallos = 0;
let probados = 0;

function probar(texto, etiqueta) {
  probados++;
  const m = matriz(texto);
  const { datos, lado } = aPixeles(m);
  const leido = jsQR(datos, lado, lado);
  if (leido && leido.data === texto) return;
  fallos++;
  console.log(`FALLO ${etiqueta} (${texto.length} bytes, ${m.length}x${m.length}): ` +
    (leido ? `leyó "${leido.data.slice(0, 40)}"` : 'no lo pudo leer'));
}

for (const url of [
  'https://multichat-osmiumstudio.pages.dev/chat/istincho',
  'https://sala-production-2289.up.railway.app/chat/istincho',
  'http://localhost:8778/chat/ana',
  'https://multichat-osmiumstudio.pages.dev/chat/un-slug-bastante-largo-de-kick',
]) probar(url, 'link real');

for (let v = 1; v <= VERSIONES; v++) {
  const cap = capacidad(v);
  probar(alAzar(cap), `versión ${v} llena`);
  if (cap > 1) probar(alAzar(cap - 1), `versión ${v} casi llena`);
}

for (let i = 0; i < 300; i++) {
  probar(alAzar(1 + Math.floor(Math.random() * capacidad(VERSIONES))), 'al azar');
}

for (const texto of ['ñandú', 'ácido láctico ✓', '🧉 mate y más', 'Chat de istincho · Kick y Twitch']) {
  probar(texto, 'utf8');
}

console.log(`\n${probados - fallos}/${probados} decodificados por jsQR`);
process.exit(fallos ? 1 : 0);
