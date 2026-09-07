/* ============================================================
   Las cuatro medidas que el dueño necesita mirar durante una noche:
   cuanto se habla, cuanto se manda, cuanto rebota y cuanta gente hubo.

   ---------------------------------------------------------------
   EN MEMORIA, Y SE DICE EN PANTALLA

   No se persisten. Escribir en Mongo en cada mensaje del chat es una
   escritura por mensaje todas las noches para un numero que se mira
   una vez, y el plan es no pasarse de la capa gratis de Atlas. El
   precio es que un deploy en medio del stream (que aca es la forma
   normal de trabajar: push a main es deploy) los pone en cero. Por
   eso el panel muestra "desde que arranco el servidor" al lado de los
   numeros, en vez de dejar creer que son de toda la noche.

   ---------------------------------------------------------------
   MENSAJES POR HORA

   Un anillo de 24 casilleros indexado por la hora del dia (UTC), con
   la marca de que dia es cada casillero. Cuando la hora vuelve a dar
   la vuelta, el casillero viejo se pisa en vez de sumarse: sin la
   marca, un servidor de dos dias mezclaria el trafico de las 3 de la
   mañana de hoy con el de ayer.
   ============================================================ */

const HORA = 60 * 60 * 1000;
const CASILLEROS = 24;

const porCanal = new Map();   // slug -> medidas

function medidasDe(slug) {
  const clave = String(slug ?? '').toLowerCase();
  if (!porCanal.has(clave)) {
    porCanal.set(clave, {
      slug: clave,
      desde: Date.now(),
      /* cada casillero: { hora: <ms epoch de la hora>, cuenta } */
      horas: Array.from({ length: CASILLEROS }, () => ({ hora: 0, cuenta: 0 })),
      envios: 0,
      enviosOk: 0,
      errores429: 0,
      espectadoresPico: 0,
    });
  }
  return porCanal.get(clave);
}

const inicioDeHora = ahora => Math.floor(ahora / HORA) * HORA;

/** Un mensaje de chat que entro al canal. */
export function registrarMensaje(slug, ahora = Date.now()) {
  const m = medidasDe(slug);
  const hora = inicioDeHora(ahora);
  const casillero = m.horas[(hora / HORA) % CASILLEROS];
  if (casillero.hora !== hora) { casillero.hora = hora; casillero.cuenta = 0; }
  casillero.cuenta++;
  return casillero.cuenta;
}

/** Un intento de envio de un espectador. */
export function registrarEnvio(slug, { ok = false, estado = 0 } = {}) {
  const m = medidasDe(slug);
  m.envios++;
  if (ok) m.enviosOk++;
  if (estado === 429) m.errores429++;
}

/** Cuanta gente hay mirando ahora; se queda con el maximo. */
export function verConectados(slug, cuantos) {
  const m = medidasDe(slug);
  if (cuantos > m.espectadoresPico) m.espectadoresPico = cuantos;
  return m.espectadoresPico;
}

/**
 * Las medidas de un canal, listas para el panel.
 *
 * `porHora` sale ordenada de la hora mas vieja a la mas nueva, con las
 * horas sin trafico en cero: un grafico con huecos miente sobre
 * cuando paso lo que paso.
 */
export function resumen(slug, ahora = Date.now()) {
  const m = medidasDe(slug);
  const horaActual = inicioDeHora(ahora);

  const porHora = [];
  for (let atras = CASILLEROS - 1; atras >= 0; atras--) {
    const hora = horaActual - atras * HORA;
    const casillero = m.horas[(hora / HORA) % CASILLEROS];
    porHora.push({ hora, cuenta: casillero.hora === hora ? casillero.cuenta : 0 });
  }

  return {
    desde: m.desde,
    mensajesUltimaHora: porHora.at(-1).cuenta,
    mensajesPorHora: porHora,
    mensajesTotales: porHora.reduce((s, c) => s + c.cuenta, 0),
    envios: m.envios,
    enviosOk: m.enviosOk,
    errores429: m.errores429,
    espectadoresPico: m.espectadoresPico,
  };
}

/** Solo para los tests. */
export function reiniciar() { porCanal.clear(); }
