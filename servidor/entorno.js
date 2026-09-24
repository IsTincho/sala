/* ============================================================
   LOS NUMEROS QUE VIENEN DE process.env, LEIDOS UNA SOLA VEZ BIEN.

   Un tope, un plazo o un presupuesto se configura con una variable de
   entorno, y una variable de entorno es un STRING que escribio una
   persona a mano en un panel. `Number('20s')` da NaN, y NaN no falla:
   se cuela.

   EL BUG QUE ESTO VIENE A MATAR, que era real y estaba anotado en la
   BITACORA del 2026-09-23:

     const PLAZO = Math.max(1000, Number(process.env.EMOTES_PLAZO_MS ?? 20000));

   Con `EMOTES_PLAZO_MS=20s` —el typo natural, el que se escribe
   pensando "veinte segundos"— `Number()` da NaN, `Math.max(1000, NaN)`
   da NaN, y `setTimeout(fn, NaN)` NO espera para siempre: dispara a UN
   milisegundo. O sea que el typo no alarga el plazo, APAGA LOS EMOTES
   PARA SIEMPRE, y el unico rastro es un log que dice "tardo mas de
   NaN ms". Lo mismo con un tope: `cuenta >= NaN` es `false` siempre,
   asi que un tope con typo no es un tope mas grande, es NINGUN tope.

   ---------------------------------------------------------------
   POR QUE NO ALCANZA `Number(x) || defecto`

   Porque `||` tambien manda al defecto el CERO, y hay varias de estas
   variables donde el cero es un valor que alguien puede querer de
   verdad: `TOPE_TWITCH=0` ("no abras ninguna conexion de EventSub"),
   `GB_AMIGO=0` ("el plan de amigo no sube videos"),
   `PADDLE_TOLERANCIA_S=0` ("sin tolerancia de reloj"). Con `||`, esos
   tres ceros se convierten callados en 50, en 2 y en 60, que es el
   MISMO bug de clase —una configuracion que se ignora en silencio—
   apenas mas barato.

   Asi que la regla es: se usa el numero si es un numero FINITO
   (Infinity tampoco sirve: `setTimeout(fn, Infinity)` tambien dispara
   a 1 ms), y si no se usa el defecto Y SE AVISA. La variable vacia
   (`EMOTES_KB=`) cuenta como "no puesta" y no avisa: es lo que deja un
   panel donde alguien borro el valor, no un error de tipeo.

   ---------------------------------------------------------------
   EL AVISO DICE EL NOMBRE Y NO EL VALOR

   El nombre alcanza para encontrar el typo, y el dueño trabaja con la
   pantalla al aire: aca no se imprime el contenido de ninguna
   variable de entorno, ni de una que "seguro" no es un secreto. Una
   vez por variable y no una por lectura, porque alguna se lee en cada
   pedido.
   ============================================================ */

const avisadas = new Set();

/**
 * El numero que dice una variable de entorno, o el defecto.
 *
 * @param {string} nombre              cual variable
 * @param {number} defecto             que valor usar si no dice un numero util
 * @param {{minimo?:number, maximo?:number}} [limites]
 *        el piso y el techo del valor final. Existen para que el piso
 *        viva al lado del defecto y no en un `Math.max` suelto que hay
 *        que acordarse de escribir en cada lado.
 * @returns {number}
 */
export function numeroDeEntorno(nombre, defecto, { minimo, maximo } = {}) {
  const acotar = n => Math.min(maximo ?? Infinity, Math.max(minimo ?? -Infinity, n));

  const crudo = String(process.env[nombre] ?? '').trim();
  if (!crudo) return acotar(defecto);

  const n = Number(crudo);
  if (!Number.isFinite(n)) {
    if (!avisadas.has(nombre)) {
      avisadas.add(nombre);
      /* El valor NO se imprime. Ver el bloque de arriba. */
      console.warn(`[entorno] ${nombre} no dice un numero: se usa ${defecto}`);
    }
    return acotar(defecto);
  }
  return acotar(n);
}

/** Olvida que ya avisó por una variable. Solo para las pruebas. */
export function olvidarAvisos() {
  avisadas.clear();
}
