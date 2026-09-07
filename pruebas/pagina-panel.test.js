/* ============================================================
   El panel del dueño, corrido de verdad.

   `paginas/panel/panel.js` es la pantalla desde la que se maneja la
   noche: play, pausa, salto, y la clave con la que se suben las
   películas. Se corre el archivo real sobre `paginas/panel.html` real,
   en el DOM de mentira de fijos/dom-falso.js (que hace explotar
   cualquier uso de innerHTML).

   Lo que se prueba es lo que duele si se rompe:
     - que la clave de subida NO aparezca sola en pantalla, porque esta
       pantalla se mira con la transmisión al aire;
     - que los botones manden la acción que dicen;
     - que el selector de videos no se borre solo cada cuatro segundos
       mientras el dueño está eligiendo;
     - que una sesión caída se avise en vez de dejar datos viejos.
   ============================================================ */

import test from 'node:test';
import assert from 'node:assert/strict';

import { abrirPagina } from './fijos/dom-falso.js';

const esperar = ms => new Promise(ok => setTimeout(ok, ms));
const asentarse = () => esperar(20);

const SALUD = {
  kick: { vinculado: true, ultima: new Date().toISOString(), suscripcion: 'activa', vivo: true, sospechoso: false },
  twitch: { vinculado: true, ultima: new Date().toISOString(), estado: 'conectado', modo: 'eventsub' },
  ahora: new Date().toISOString(),
};

const RELOJ_CORRIENDO = {
  tipo: 'reloj', estado: 'reproduciendo', videoId: 'ep1', titulo: 'Episodio 1',
  url: 'https://pub-ejemplo.r2.dev/istincho/ep1/maestra.m3u8',
  duracion: 1200, calidades: [720], subtitulos: [],
  empezoEn: Date.now() - 65_000, pausadoEn: null, offsetInicial: 0,
  posicion: 65, ahora: Date.now(),
};

const METRICAS = {
  desde: Date.now() - 3600_000,
  mensajesUltimaHora: 42,
  mensajesPorHora: Array.from({ length: 24 }, (_, i) => ({ hora: i, cuenta: i === 23 ? 42 : 0 })),
  mensajesTotales: 42,
  envios: 10, enviosOk: 9, errores429: 1,
  espectadoresPico: 137,
};

const panelLleno = (extra = {}) => ({
  slug: 'istincho',
  modo: 'produccion',
  hora: Date.now(),
  salud: SALUD,
  reloj: RELOJ_CORRIENDO,
  videos: [
    { id: 'ep1', slug: 'istincho', titulo: 'Episodio 1', duracion: 1200, url: 'https://pub-ejemplo.r2.dev/a', calidades: [720, 1080], subtitulos: [], bytes: 2 * 1024 ** 3, subido: 2 },
    { id: 'ep2', slug: 'istincho', titulo: 'Episodio 2', duracion: 60, url: 'https://pub-ejemplo.r2.dev/b', calidades: [720], subtitulos: [], bytes: 0, subido: 1 },
  ],
  conectados: 12,
  metricas: METRICAS,
  claveSubida: { hay: true, creada: Date.now() - 86400_000 },
  almacen: { modo: 'mongo', motivo: '' },
  urlWebhook: 'https://sala.example/kick/webhook',
  ...extra,
});

/**
 * Abre el panel con un fetch de mentira.
 * `estadoPanel` decide qué contesta /api/panel; se puede cambiar entre
 * consultas para simular que la sesión se cae.
 */
function abrir({ estadoPanel = () => ({ ok: true, status: 200, json: async () => panelLleno() }),
                 respuestas = {}, globales = {} } = {}) {
  const pedidos = [];
  const responder = async (url, opciones = {}) => {
    const ruta = String(url);
    pedidos.push({ url: ruta, metodo: opciones.method ?? 'GET', cuerpo: opciones.body });
    if (respuestas[`${opciones.method ?? 'GET'} ${ruta}`]) {
      return respuestas[`${opciones.method ?? 'GET'} ${ruta}`](opciones);
    }
    if (respuestas[ruta]) return respuestas[ruta](opciones);
    if (ruta === '/api/panel') return estadoPanel(opciones);
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };

  const pagina = abrirPagina({
    archivo: 'panel.html',
    script: 'panel/panel.js',
    ruta: '/panel',
    fetch: responder,
    globales,
  });

  return { ...pagina, pedidos, api: () => pagina.ventana.SalaPanel };
}

/* ------------------------------------------------------ sin sesión */

test('sin sesión no se muestra nada de la sala y se dice por qué', async () => {
  const p = abrir({ estadoPanel: () => ({ ok: false, status: 401, json: async () => ({ error: 'no hay sesion' }) }) });
  await asentarse();

  assert.match(p.el('tarjeta-estado').textContent, /todavía no entraste con Kick/);
  for (const id of ['tarjeta-sala', 'tarjeta-videos', 'tarjeta-metricas', 'tarjeta-clave', 'tarjeta-webhook']) {
    assert.equal(p.el(id).hidden, true, id);
  }
  /* Y no se puede vincular Twitch sin haber entrado con Kick. */
  assert.ok(p.el('link-twitch').classList.contains('apagado'));

  p.cerrar();
});

test('si la sesión se cae con el panel abierto, se avisa', async () => {
  /* EL BUG QUE ESTO ATAJA: el aviso se escribía en el párrafo original
     de la tarjeta, que para entonces ya no estaba en el árbol (lo sacó
     el pintado de la salud). El panel se quedaba mostrando datos
     viejos de una sesión muerta, sin decir nada. */
  let hay = true;
  const p = abrir({
    estadoPanel: () => (hay
      ? { ok: true, status: 200, json: async () => panelLleno() }
      : { ok: false, status: 401, json: async () => ({}) }),
  });
  await asentarse();
  assert.match(p.el('tarjeta-estado').textContent, /Kick: vinculado/);

  hay = false;
  await p.api().consultar();
  assert.match(p.el('tarjeta-estado').textContent, /todavía no entraste con Kick/);
  assert.equal(p.el('tarjeta-sala').hidden, true);

  p.cerrar();
});

/* -------------------------------------------------------- pintado */

test('con sesión se ve la salud de las dos redes y el estado del reloj', async () => {
  const p = abrir();
  await asentarse();

  const estado = p.el('tarjeta-estado').textContent;
  assert.match(estado, /Kick: vinculado/);
  assert.match(estado, /suscripción activa/);
  assert.match(estado, /en vivo/);
  assert.match(estado, /Twitch: vinculado/);
  assert.match(estado, /conectado \(eventsub\)/);

  assert.match(p.el('estado-reloj').textContent, /reproduciendo: Episodio 1/);
  assert.equal(p.el('dato-conectados').textContent, '12');
  assert.equal(p.el('dato-pico').textContent, '137');
  assert.equal(p.el('link-sala').href, '/sala/istincho');
  assert.equal(p.el('url-webhook').textContent, 'https://sala.example/kick/webhook');

  p.cerrar();
});

test('el aviso de que Kick está mudo aparece cuando el servidor lo dice', async () => {
  /* El veredicto lo da el servidor (`salud.kick.sospechoso`) y el panel
     no lo recalcula: es la misma regla que en /chat, y vive en un solo
     lugar. */
  const p = abrir({
    estadoPanel: () => ({
      ok: true, status: 200,
      json: async () => panelLleno({ salud: { ...SALUD, kick: { ...SALUD.kick, sospechoso: true } } }),
    }),
  });
  await asentarse();

  assert.match(p.el('tarjeta-estado').textContent, /más de 5 minutos que no llega nada/);
  p.cerrar();
});

test('la posición del reloj avanza sola, sin esperar la próxima consulta', async () => {
  const p = abrir();
  await asentarse();

  /* 65 segundos desde empezoEn con offsetInicial 0. */
  assert.match(p.el('posicion-reloj').textContent, /^1:0[456] \/ 20:00$/,
    `decía ${p.el('posicion-reloj').textContent}`);

  const antes = p.api().posicionAhora();
  await esperar(1100);
  assert.ok(p.api().posicionAhora() > antes, 'el contador quedó congelado');

  p.cerrar();
});

test('un reloj pausado no avanza', async () => {
  const p = abrir({
    estadoPanel: () => ({
      ok: true, status: 200,
      json: async () => panelLleno({
        reloj: { ...RELOJ_CORRIENDO, estado: 'pausado', pausadoEn: RELOJ_CORRIENDO.empezoEn + 30_000 },
      }),
    }),
  });
  await asentarse();

  assert.equal(Math.round(p.api().posicionAhora()), 30);
  await esperar(120);
  assert.equal(Math.round(p.api().posicionAhora()), 30);
  assert.match(p.el('estado-reloj').textContent, /en pausa/);

  p.cerrar();
});

test('sin nada puesto se dice sin nada puesto', async () => {
  const p = abrir({
    estadoPanel: () => ({
      ok: true, status: 200,
      json: async () => panelLleno({ reloj: { tipo: 'reloj', estado: 'detenido', videoId: '' } }),
    }),
  });
  await asentarse();

  /* La tarjeta tiene que estar VISIBLE, o sea que el panel pintó de
     verdad: "sin nada puesto" también es lo que dice el HTML antes de
     pintar nada, y sin esta comprobación la prueba pasaría con el
     pintado roto. */
  assert.equal(p.el('tarjeta-sala').hidden, false);
  assert.match(p.el('estado-reloj').textContent, /sin nada puesto/);
  assert.equal(p.el('posicion-reloj').textContent, '–');
  assert.equal(p.api().posicionAhora(), null);

  p.cerrar();
});

test('la lista de videos muestra duración, calidades y peso, y marca el que está en marcha', async () => {
  const p = abrir();
  await asentarse();

  const filas = p.el('lista-videos').children;
  assert.equal(filas.length, 2);
  assert.match(filas[0].textContent, /Episodio 1/);
  assert.match(filas[0].textContent, /20:00/);
  assert.match(filas[0].textContent, /720p\/1080p/);
  assert.match(filas[0].textContent, /2\.00 GB/);
  /* El que se está pasando no tiene botón de reproducir: tiene una
     marca. */
  assert.match(filas[0].textContent, /en marcha/);
  assert.match(filas[1].textContent, /Reproducir/);

  p.cerrar();
});

test('las métricas se pintan con las 24 barras', async () => {
  const p = abrir();
  await asentarse();

  assert.equal(p.el('dato-mensajes-hora').textContent, '42');
  assert.equal(p.el('dato-envios').textContent, '10');
  assert.equal(p.el('dato-envios-ok').textContent, '9');
  assert.equal(p.el('dato-429').textContent, '1');
  assert.equal(p.el('dato-pico-metricas').textContent, '137');
  assert.equal(p.el('grafico-horas').children.length, 24);

  p.cerrar();
});

/* ------------------------------------------------------- botones */

test('los botones del reloj mandan la acción que dicen', async () => {
  const mandados = [];
  const p = abrir({
    respuestas: {
      'POST /api/sala/istincho/reloj': opciones => {
        mandados.push(JSON.parse(opciones.body));
        return { ok: true, status: 200, json: async () => ({ ok: true, reloj: RELOJ_CORRIENDO }) };
      },
    },
  });
  await asentarse();

  p.el('boton-pausar').disparar('click');
  p.el('boton-reanudar').disparar('click');
  p.el('boton-detener').disparar('click');
  p.el('boton-atras-10').disparar('click');
  p.el('boton-adelante-60').disparar('click');
  await asentarse();

  assert.deepEqual(mandados, [
    { accion: 'pausar' },
    { accion: 'reanudar' },
    { accion: 'detener' },
    { accion: 'saltar', segundos: -10 },
    { accion: 'saltar', segundos: 60 },
  ]);

  p.cerrar();
});

test('reproducir sin elegir video avisa y no manda nada', async () => {
  const mandados = [];
  const p = abrir({
    respuestas: {
      'POST /api/sala/istincho/reloj': opciones => {
        mandados.push(JSON.parse(opciones.body));
        return { ok: true, status: 200, json: async () => ({ ok: true, reloj: RELOJ_CORRIENDO }) };
      },
    },
  });
  await asentarse();

  p.el('boton-reproducir').disparar('click');
  await asentarse();

  assert.equal(mandados.length, 0);
  assert.equal(p.el('aviso-panel').hidden, false);
  assert.match(p.el('texto-aviso-panel').textContent, /elegí un video/);

  p.cerrar();
});

test('el botón de cada video reproduce ese video', async () => {
  const mandados = [];
  const p = abrir({
    respuestas: {
      'POST /api/sala/istincho/reloj': opciones => {
        mandados.push(JSON.parse(opciones.body));
        return { ok: true, status: 200, json: async () => ({ ok: true, reloj: RELOJ_CORRIENDO }) };
      },
    },
  });
  await asentarse();

  /* La fila del ep2 es la única con botón: el ep1 está en marcha. */
  const boton = p.el('lista-videos').children[1].children.find(c => c.tagName === 'BUTTON');
  boton.disparar('click');
  await asentarse();

  assert.deepEqual(mandados, [{ accion: 'reproducir', videoId: 'ep2' }]);
  p.cerrar();
});

test('un error del servidor se muestra, no se traga', async () => {
  const p = abrir({
    respuestas: {
      'POST /api/sala/istincho/reloj': () => ({
        ok: false, status: 400, json: async () => ({ error: 'ese video no esta en el catalogo' }),
      }),
    },
  });
  await asentarse();

  p.el('boton-detener').disparar('click');
  await asentarse();

  assert.equal(p.el('aviso-panel').hidden, false);
  assert.match(p.el('texto-aviso-panel').textContent, /no esta en el catalogo/);

  p.cerrar();
});

test('el selector de videos no se rearma en cada consulta', async () => {
  /*
   * El panel se refresca cada cuatro segundos. Si rearmara el <select>
   * en cada vuelta, el desplegable abierto se cerraría solo justo
   * cuando el dueño está eligiendo, y el foco se perdería.
   *
   * Se comparan las OPCIONES POR IDENTIDAD y no el valor elegido: el
   * valor se restaura igual aunque se rearme (lo cazó una mutación), y
   * el punto de la firma es no tocar el DOM cuando no hace falta.
   */
  const p = abrir();
  await asentarse();

  const antes = p.el('select-video').children.slice();
  p.el('select-video').value = 'ep2';
  await p.api().consultar();

  const despues = p.el('select-video').children;
  assert.equal(p.el('select-video').value, 'ep2');
  assert.equal(despues.length, antes.length);
  for (let i = 0; i < antes.length; i++) {
    assert.equal(despues[i], antes[i], 'la opción se reemplazó por otra igual');
  }

  /* Y si la lista de videos cambia, entonces sí se rearma. */
  await p.api().consultar.call(null);
  p.api().pintar(panelLleno({ videos: [] }));
  assert.equal(p.el('select-video').children.length, 1);

  p.cerrar();
});

/* -------------------------------------------------- la clave */

test('la clave nueva NO aparece en pantalla: hay que pedirlo', async () => {
  /*
   * LA REGLA DE LA CASA: el dueño trabaja con la pantalla al aire. Una
   * clave que se pinta sola apenas se toca "Generar" es un secreto
   * regalado a quien esté mirando el stream.
   */
  const p = abrir({
    respuestas: {
      'POST /api/panel/clave': () => ({ ok: true, status: 200, json: async () => ({ clave: 'CLAVE-SECRETA-DE-PRUEBA' }) }),
    },
  });
  await asentarse();

  p.el('boton-generar-clave').disparar('click');
  await asentarse();

  assert.equal(p.el('caja-clave').hidden, false, 'tiene que aparecer la caja con los botones');
  assert.equal(p.el('valor-clave').hidden, true, 'la clave no puede verse sola');
  assert.equal(p.el('valor-clave').textContent, '');
  /* Y en ningún otro lado de la pantalla. */
  assert.ok(!p.documento.body.textContent.includes('CLAVE-SECRETA-DE-PRUEBA'),
    'la clave se filtró a la pantalla');

  /* Recién si alguien insiste. */
  p.el('boton-mostrar-clave').disparar('click');
  assert.equal(p.el('valor-clave').hidden, false);
  assert.equal(p.el('valor-clave').textContent, 'CLAVE-SECRETA-DE-PRUEBA');

  p.cerrar();
});

test('copiar la manda al portapapeles sin mostrarla', async () => {
  const copiado = [];
  const p = abrir({
    respuestas: {
      'POST /api/panel/clave': () => ({ ok: true, status: 200, json: async () => ({ clave: 'OTRA-CLAVE' }) }),
    },
    globales: { navigator: { clipboard: { writeText: async t => { copiado.push(t); } } } },
  });
  await asentarse();

  p.el('boton-generar-clave').disparar('click');
  await asentarse();
  p.el('boton-copiar-clave').disparar('click');
  await asentarse();

  assert.deepEqual(copiado, ['OTRA-CLAVE']);
  assert.equal(p.el('valor-clave').hidden, true, 'copiar no puede mostrarla');

  p.cerrar();
});

test('sin clave se dice que el script de subida no va a poder avisar', async () => {
  const p = abrir({
    estadoPanel: () => ({
      ok: true, status: 200,
      json: async () => panelLleno({ claveSubida: { hay: false, creada: 0 } }),
    }),
  });
  await asentarse();

  assert.match(p.el('estado-clave').textContent, /no hay ninguna/);
  p.cerrar();
});

test('revocar esconde la caja y vuelve a consultar', async () => {
  const p = abrir({
    respuestas: {
      'POST /api/panel/clave': () => ({ ok: true, status: 200, json: async () => ({ clave: 'X' }) }),
      'DELETE /api/panel/clave': () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }),
    },
  });
  await asentarse();

  p.el('boton-generar-clave').disparar('click');
  await asentarse();
  assert.equal(p.el('caja-clave').hidden, false);

  p.el('boton-revocar-clave').disparar('click');
  await asentarse();
  assert.equal(p.el('caja-clave').hidden, true);

  const borrados = p.pedidos.filter(x => x.metodo === 'DELETE' && x.url === '/api/panel/clave');
  assert.equal(borrados.length, 1);

  p.cerrar();
});
