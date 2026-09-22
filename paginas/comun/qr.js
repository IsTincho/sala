/* ============================================================
   Un QR, a mano, sin librerias.

   Existe por una regla de la casa: la unica dependencia del proyecto
   es `mongodb`. Un QR es un formato cerrado y bien documentado
   (ISO/IEC 18004), asi que se puede escribir una vez y no volver a
   tocarlo nunca, que es exactamente lo contrario de sumar una
   dependencia que hay que auditar y actualizar.

   Hace SOLO lo que hace falta para poner el link de un chat en
   pantalla:

     - modo BYTE (el link es ASCII, pero asi anda con cualquier UTF-8),
     - correccion de errores nivel M (~15%): el punto medio entre
       aguantar que la camara lo agarre torcido y no agrandar el
       dibujo al pedo,
     - versiones 1 a 10, o sea hasta 213 caracteres. Un link de este
       proyecto son unos 55.

   No hace modo numerico, ni alfanumerico, ni kanji, ni ECI, ni
   versiones altas. Si alguna vez hace falta codificar algo mas largo
   que 213 caracteres, lo que hay que agregar son dos filas de tablas,
   no otra cosa.

   ---------------------------------------------------------------
   COMO SE VERIFICO

   Con un decodificador de verdad y ajeno (jsQR), una sola vez y
   fuera del repo: se generaron las diez versiones con textos al azar,
   se pintaron a pixeles y se decodificaron de vuelta. Esta anotado en
   la BITACORA. Las pruebas del repo no salen a internet: comprueban
   la forma (patrones de posicion, temporizacion, tamaño) y que el
   mismo texto de siempre de el mismo dibujo de siempre.

   Expone `window.SalaQR`:
     matriz(texto)           -> [[bool, …], …], sin margen
     svg(texto, opciones)    -> un <svg> como string
     datosUri(texto)         -> el svg listo para el src de un <img>
   ============================================================ */
(() => {
  /* ------------------------------------------------- GF(256)

     El cuerpo finito de los QR: 256 elementos, polinomio primitivo
     0x11D. `EXP` y `LOG` estan al doble de largo para no tener que
     hacer el modulo 255 en cada multiplicacion. */

  const EXP = new Uint8Array(512);
  const LOG = new Uint8Array(256);
  (() => {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();

  const multiplicar = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

  /** El polinomio generador de grado `grado`, de mayor a menor. */
  function generador(grado) {
    let g = [1];
    for (let i = 0; i < grado; i++) {
      const nuevo = new Array(g.length + 1).fill(0);
      for (let j = 0; j < g.length; j++) {
        nuevo[j] ^= g[j];                          // por x
        nuevo[j + 1] ^= multiplicar(g[j], EXP[i]); // por alfa^i
      }
      g = nuevo;
    }
    return g;
  }

  /** Los `cuantos` bytes de correccion de un bloque de datos. */
  function correccion(datos, cuantos) {
    const gen = generador(cuantos);
    const resto = new Array(datos.length + cuantos).fill(0);
    for (let i = 0; i < datos.length; i++) resto[i] = datos[i];
    for (let i = 0; i < datos.length; i++) {
      const factor = resto[i];
      if (!factor) continue;
      for (let j = 0; j < gen.length; j++) resto[i + j] ^= multiplicar(gen[j], factor);
    }
    return resto.slice(datos.length);
  }

  /* ------------------------------------------------- las tablas

     Las tres que definen una version, para nivel M. Se cruzan solas:
     bloques * (datos + correccion) tiene que dar el total de bytes de
     esa version, y la prueba lo exige. Un numero mal copiado en
     cualquiera de las dos primeras no pasa esa cuenta. */

  /* bytes totales por version (1..10) */
  const TOTAL = [26, 44, 70, 100, 134, 172, 196, 242, 292, 346];

  /* [bytes de correccion por bloque, bloques del grupo 1, bytes de
     datos por bloque del grupo 1, bloques del grupo 2, bytes de datos
     por bloque del grupo 2] */
  const BLOQUES_M = [
    [10, 1, 16, 0, 0],
    [16, 1, 28, 0, 0],
    [26, 1, 44, 0, 0],
    [18, 2, 32, 0, 0],
    [24, 2, 43, 0, 0],
    [16, 4, 27, 0, 0],
    [18, 4, 31, 0, 0],
    [22, 2, 38, 2, 39],
    [22, 3, 36, 2, 37],
    [26, 4, 43, 1, 44],
  ];

  /* centros de los patrones de alineacion, por version (la 1 no tiene) */
  const ALINEACION = [
    [], [6, 18], [6, 22], [6, 26], [6, 30],
    [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
  ];

  const VERSIONES = TOTAL.length;
  const tamañoDe = version => version * 4 + 17;

  /** Cuantos bytes de datos entran en esta version (sin la correccion). */
  const datosDe = (version) => {
    const [ec, b1, d1, b2, d2] = BLOQUES_M[version - 1];
    void ec;
    return b1 * d1 + b2 * d2;
  };

  /* El contador de caracteres del modo byte ocupa 8 bits hasta la
     version 9 y 16 desde la 10. */
  const bitsDelContador = version => (version < 10 ? 8 : 16);

  /** Cuantos bytes de texto entran en esta version. */
  const capacidad = version => datosDe(version) - 1 - bitsDelContador(version) / 8;

  /* ------------------------------------------------- codificar */

  /** El texto en bytes UTF-8. */
  function aBytes(texto) {
    if (typeof TextEncoder === 'function') return [...new TextEncoder().encode(texto)];
    /* Respaldo sin TextEncoder: no deberia hacer falta en ningun
       navegador de este siglo, pero un QR que tira por esto seria un
       panel roto por un detalle. */
    return [...unescape(encodeURIComponent(texto))].map(c => c.charCodeAt(0));
  }

  /** La version mas chica donde entra este texto. */
  function versionPara(bytes) {
    for (let v = 1; v <= VERSIONES; v++) if (bytes.length <= capacidad(v)) return v;
    throw new Error(`el texto no entra en un QR de hasta ${capacidad(VERSIONES)} bytes`);
  }

  /** Los bytes de datos completos: cabecera, texto, terminador y relleno. */
  function bytesDeDatos(bytes, version) {
    const bits = [];
    const empujar = (valor, cuantos) => {
      for (let i = cuantos - 1; i >= 0; i--) bits.push((valor >> i) & 1);
    };

    empujar(0b0100, 4);                              // modo byte
    empujar(bytes.length, bitsDelContador(version));
    for (const b of bytes) empujar(b, 8);

    const tope = datosDe(version) * 8;
    /* Terminador: hasta cuatro ceros, o menos si no entran. */
    for (let i = 0; i < 4 && bits.length < tope; i++) bits.push(0);
    while (bits.length % 8 !== 0) bits.push(0);

    const salida = [];
    for (let i = 0; i < bits.length; i += 8) {
      let b = 0;
      for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
      salida.push(b);
    }
    /* Relleno: 0xEC y 0x11 alternados hasta llenar. Son los dos bytes
       que manda la norma; cualquier otro par pasaria el decodificador
       igual, pero no seria un QR valido. */
    const relleno = [0xec, 0x11];
    while (salida.length < datosDe(version)) salida.push(relleno[salida.length % 2]);
    return salida;
  }

  /**
   * Los bytes finales, con la correccion intercalada.
   *
   * Intercalados y no uno atras del otro: la norma reparte los bloques
   * byte por byte justamente para que una mancha en el papel no se
   * coma un bloque entero (y con el, su correccion).
   */
  function bytesFinales(datos, version) {
    const [ec, b1, d1, b2, d2] = BLOQUES_M[version - 1];
    const bloques = [];
    let i = 0;
    for (let n = 0; n < b1; n++) { bloques.push(datos.slice(i, i + d1)); i += d1; }
    for (let n = 0; n < b2; n++) { bloques.push(datos.slice(i, i + d2)); i += d2; }
    const correcciones = bloques.map(b => correccion(b, ec));

    const salida = [];
    const masLargo = Math.max(...bloques.map(b => b.length));
    for (let j = 0; j < masLargo; j++) {
      for (const b of bloques) if (j < b.length) salida.push(b[j]);
    }
    for (let j = 0; j < ec; j++) {
      for (const c of correcciones) salida.push(c[j]);
    }
    return salida;
  }

  /* ------------------------------------------------- el dibujo */

  function nuevaMatriz(tamaño) {
    return Array.from({ length: tamaño }, () => new Array(tamaño).fill(false));
  }

  /** Los patrones fijos. Devuelve tambien que modulos quedan ocupados. */
  function patrones(version) {
    const tamaño = tamañoDe(version);
    const m = nuevaMatriz(tamaño);
    const fija = nuevaMatriz(tamaño);

    const poner = (fila, col, oscuro) => {
      m[fila][col] = oscuro;
      fija[fila][col] = true;
    };

    /* Los tres cuadrados de las esquinas, con su separador blanco. */
    for (const [f0, c0] of [[0, 0], [0, tamaño - 7], [tamaño - 7, 0]]) {
      for (let f = -1; f <= 7; f++) {
        for (let c = -1; c <= 7; c++) {
          const fila = f0 + f;
          const col = c0 + c;
          if (fila < 0 || fila >= tamaño || col < 0 || col >= tamaño) continue;
          const borde = f === 0 || f === 6 || c === 0 || c === 6;
          const centro = f >= 2 && f <= 4 && c >= 2 && c <= 4;
          const adentro = f >= 0 && f <= 6 && c >= 0 && c <= 6;
          poner(fila, col, adentro && (borde || centro));
        }
      }
    }

    /* Temporizacion: la fila y la columna 6, alternando. */
    for (let i = 8; i < tamaño - 8; i++) {
      poner(6, i, i % 2 === 0);
      poner(i, 6, i % 2 === 0);
    }

    /* Alineacion: en cada cruce, menos donde pisaria un cuadrado de
       esquina. */
    const centros = ALINEACION[version - 1];
    for (const f0 of centros) {
      for (const c0 of centros) {
        const enEsquina = (f0 === 6 && c0 === 6)
          || (f0 === 6 && c0 === centros[centros.length - 1])
          || (f0 === centros[centros.length - 1] && c0 === 6);
        if (enEsquina) continue;
        for (let f = -2; f <= 2; f++) {
          for (let c = -2; c <= 2; c++) {
            poner(f0 + f, c0 + c, Math.max(Math.abs(f), Math.abs(c)) !== 1);
          }
        }
      }
    }

    /* El lugar del formato se reserva ahora y se escribe al final,
       cuando ya se sabe que mascara gano. */
    for (let i = 0; i < 9; i++) {
      if (!fija[8][i]) fija[8][i] = true;
      if (!fija[i][8]) fija[i][8] = true;
    }
    for (let i = 0; i < 8; i++) {
      fija[8][tamaño - 1 - i] = true;
      fija[tamaño - 1 - i][8] = true;
    }

    /* Y el de la version, desde la 7. */
    if (version >= 7) {
      for (let i = 0; i < 18; i++) {
        const a = tamaño - 11 + (i % 3);
        const b = Math.floor(i / 3);
        fija[b][a] = true;
        fija[a][b] = true;
      }
    }

    return { m, fija, tamaño };
  }

  /** Mete los bits de datos en zigzag, de abajo a la derecha hacia arriba. */
  function ponerDatos(m, fija, tamaño, bytes) {
    const bits = [];
    for (const b of bytes) for (let i = 7; i >= 0; i--) bits.push((b >> i) & 1);

    let i = 0;
    let arriba = true;
    for (let col = tamaño - 1; col > 0; col -= 2) {
      if (col === 6) col--;   // la columna de temporizacion no cuenta
      for (let n = 0; n < tamaño; n++) {
        const fila = arriba ? tamaño - 1 - n : n;
        for (const c of [col, col - 1]) {
          if (fija[fila][c]) continue;
          m[fila][c] = i < bits.length ? bits[i++] === 1 : false;
        }
      }
      arriba = !arriba;
    }
  }

  const MASCARAS = [
    (f, c) => (f + c) % 2 === 0,
    (f) => f % 2 === 0,
    (f, c) => c % 3 === 0,
    (f, c) => (f + c) % 3 === 0,
    (f, c) => (Math.floor(f / 2) + Math.floor(c / 3)) % 2 === 0,
    (f, c) => ((f * c) % 2) + ((f * c) % 3) === 0,
    (f, c) => (((f * c) % 2) + ((f * c) % 3)) % 2 === 0,
    (f, c) => (((f + c) % 2) + ((f * c) % 3)) % 2 === 0,
  ];

  /* Los 15 bits del formato: nivel M (00), la mascara, y diez de BCH,
     todo con el XOR que manda la norma para que el formato nunca sea
     todo ceros. */
  function bitsDeFormato(mascara) {
    const datos = (0b00 << 3) | mascara;
    let resto = datos;
    for (let i = 0; i < 10; i++) resto = (resto << 1) ^ ((resto >> 9) * 0x537);
    return ((datos << 10) | (resto & 0x3ff)) ^ 0x5412;
  }

  function bitsDeVersion(version) {
    let resto = version;
    for (let i = 0; i < 12; i++) resto = (resto << 1) ^ ((resto >> 11) * 0x1f25);
    return (version << 12) | (resto & 0xfff);
  }

  function escribirFormato(m, tamaño, mascara) {
    const bits = bitsDeFormato(mascara);
    const bit = i => ((bits >> i) & 1) === 1;

    for (let i = 0; i <= 5; i++) m[i][8] = bit(i);
    m[7][8] = bit(6);
    m[8][8] = bit(7);
    m[8][7] = bit(8);
    for (let i = 9; i < 15; i++) m[8][14 - i] = bit(i);

    for (let i = 0; i <= 7; i++) m[8][tamaño - 1 - i] = bit(i);
    for (let i = 8; i < 15; i++) m[tamaño - 15 + i][8] = bit(i);
    m[tamaño - 8][8] = true;   // el modulo que siempre es oscuro
  }

  function escribirVersion(m, tamaño, version) {
    if (version < 7) return;
    const bits = bitsDeVersion(version);
    for (let i = 0; i < 18; i++) {
      const oscuro = ((bits >> i) & 1) === 1;
      const a = tamaño - 11 + (i % 3);
      const b = Math.floor(i / 3);
      m[b][a] = oscuro;
      m[a][b] = oscuro;
    }
  }

  /* La penalizacion de la norma: cuatro reglas que castigan los
     dibujos dificiles de leer. Se prueban las ocho mascaras y gana la
     de menor puntaje. */
  function penalizacion(m, tamaño) {
    let total = 0;

    /* 1. Tiras de cinco o mas del mismo color. */
    for (let i = 0; i < tamaño; i++) {
      for (const porFila of [true, false]) {
        let color = null;
        let largo = 0;
        for (let j = 0; j < tamaño; j++) {
          const v = porFila ? m[i][j] : m[j][i];
          if (v === color) largo++;
          else { color = v; largo = 1; }
          if (largo === 5) total += 3;
          else if (largo > 5) total += 1;
        }
      }
    }

    /* 2. Cuadrados de 2x2 del mismo color. */
    for (let f = 0; f < tamaño - 1; f++) {
      for (let c = 0; c < tamaño - 1; c++) {
        const v = m[f][c];
        if (v === m[f][c + 1] && v === m[f + 1][c] && v === m[f + 1][c + 1]) total += 3;
      }
    }

    /* 3. El patron que se parece a un cuadrado de esquina. */
    const patron = [true, false, true, true, true, false, true, false, false, false, false];
    const alReves = [false, false, false, false, true, false, true, true, true, false, true];
    for (let i = 0; i < tamaño; i++) {
      for (let j = 0; j + 11 <= tamaño; j++) {
        let igualFila = true;
        let igualColumna = true;
        let igualFilaR = true;
        let igualColumnaR = true;
        for (let k = 0; k < 11; k++) {
          if (m[i][j + k] !== patron[k]) igualFila = false;
          if (m[j + k][i] !== patron[k]) igualColumna = false;
          if (m[i][j + k] !== alReves[k]) igualFilaR = false;
          if (m[j + k][i] !== alReves[k]) igualColumnaR = false;
        }
        if (igualFila) total += 40;
        if (igualColumna) total += 40;
        if (igualFilaR) total += 40;
        if (igualColumnaR) total += 40;
      }
    }

    /* 4. Cuanto se aleja del mitad y mitad. */
    let oscuros = 0;
    for (let f = 0; f < tamaño; f++) for (let c = 0; c < tamaño; c++) if (m[f][c]) oscuros++;
    const porciento = (oscuros * 100) / (tamaño * tamaño);
    total += Math.floor(Math.abs(porciento - 50) / 5) * 10;

    return total;
  }

  /* ------------------------------------------------- la interfaz */

  /**
   * La matriz de un texto: `true` es un modulo oscuro. Sin margen: el
   * margen lo pone quien dibuja.
   */
  function matriz(texto) {
    const bytes = aBytes(String(texto ?? ''));
    const version = versionPara(bytes);
    const finales = bytesFinales(bytesDeDatos(bytes, version), version);

    let mejor = null;
    let mejorPuntaje = Infinity;

    for (let mascara = 0; mascara < 8; mascara++) {
      const { m, fija, tamaño } = patrones(version);
      ponerDatos(m, fija, tamaño, finales);
      /* La mascara se aplica SOLO a lo que no es patron fijo. */
      for (let f = 0; f < tamaño; f++) {
        for (let c = 0; c < tamaño; c++) {
          if (!fija[f][c] && MASCARAS[mascara](f, c)) m[f][c] = !m[f][c];
        }
      }
      escribirVersion(m, tamaño, version);
      escribirFormato(m, tamaño, mascara);

      const puntaje = penalizacion(m, tamaño);
      if (puntaje < mejorPuntaje) { mejorPuntaje = puntaje; mejor = m; }
    }

    return mejor;
  }

  /**
   * El QR como un <svg>, en texto.
   *
   * Un solo <path> con todos los cuadrados: mil rectangulos sueltos
   * son mil nodos que el navegador tiene que mantener, y esto no se
   * anima ni se toca.
   *
   * El margen de cuatro modulos que pide la norma va incluido: sin el,
   * muchas camaras no lo encuentran.
   */
  function svg(texto, { margen = 4, claro = '#ffffff', oscuro = '#000000' } = {}) {
    const m = matriz(texto);
    const tamaño = m.length;
    const lado = tamaño + margen * 2;

    let camino = '';
    for (let f = 0; f < tamaño; f++) {
      for (let c = 0; c < tamaño; c++) {
        if (m[f][c]) camino += `M${c + margen} ${f + margen}h1v1h-1z`;
      }
    }

    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${lado} ${lado}" ` +
      `shape-rendering="crispEdges" role="img" aria-label="Codigo QR del link">` +
      `<rect width="${lado}" height="${lado}" fill="${claro}"/>` +
      `<path d="${camino}" fill="${oscuro}"/></svg>`;
  }

  /** El svg listo para el `src` de un <img>. */
  const datosUri = (texto, opciones) =>
    'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg(texto, opciones));

  window.SalaQR = { matriz, svg, datosUri, capacidad, VERSIONES };
})();
