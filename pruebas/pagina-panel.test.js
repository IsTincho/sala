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
  /* Lo que agregó la Fase 3. El panel dejó de ser el del dueño y pasó a
     ser el de cada creador, así que el plan viaja en el mismo pedido y
     decide qué se puede tocar. */
  plan: 'dueno',
  soloLectura: false,
  esDueno: true,
  uso: { bytes: 0, gb: 0, topeGb: null, medido: Date.now(), real: true },
  cobro: { proveedor: 'paddle', listo: false, falta: 'faltan PADDLE_API_KEY', monto: 5, moneda: 'USD' },
  subida: { lista: true, falta: '' },
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
    /* El QR lo dibuja comun/qr.js, que la pagina carga antes del suyo:
       aca se corre el de verdad, no una imitacion. */
    antes: ['comun/qr.js'],
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


/* ================================================== el plan (Fase 3)

   El panel dejó de ser una pantalla de un solo dueño. Lo que se prueba
   acá es que el plan mande sobre lo que se puede tocar, y que APAGAR
   los controles no sea la única defensa: el servidor contesta 402 a
   cualquier acción del reloj sin plan activo, tenga o no la página los
   botones apagados. Eso está probado en pruebas/multicanal.test.js.
   Acá se prueba que la pantalla lo explique en vez de quedarse muda. */

const CONTROLES = [
  'boton-reproducir', 'boton-pausar', 'boton-reanudar', 'boton-detener',
  'boton-atras-60', 'boton-atras-10', 'boton-adelante-10', 'boton-adelante-60',
];

test('con plan activo los controles de la película se pueden tocar', async () => {
  /* El control negativo de los dos que siguen: sin esto, "apagar
     siempre" pasaría el test de abajo y nadie podría tocar play. */
  const p = abrir();
  await asentarse();

  for (const id of CONTROLES) assert.equal(p.el(id).disabled, false, id);
  assert.equal(p.el('select-video').disabled, false);
  assert.equal(p.el('boton-suscribirse').hidden, true, 'el dueño no se suscribe a sí mismo');
  assert.equal(p.el('link-admin').hidden, false, 'y ve el link a /admin');

  p.cerrar();
});

test('un plan pendiente apaga los controles y dice por qué', async () => {
  const p = abrir({
    estadoPanel: () => ({ ok: true, status: 200, json: async () => panelLleno({
      plan: 'pendiente', soloLectura: true, esDueno: false,
      uso: { bytes: 0, gb: 0, topeGb: 2, medido: 0, real: false },
      urlWebhook: '',
    }) }),
  });
  await asentarse();

  assert.equal(p.el('tarjeta-plan').hidden, false);
  assert.match(p.el('texto-plan').textContent, /pendiente/);
  assert.match(p.el('explica-plan').textContent, /no puede reproducir/i);
  for (const id of CONTROLES) assert.equal(p.el(id).disabled, true, id);
  assert.equal(p.el('select-video').disabled, true);

  p.cerrar();
});

test('un plan vencido ofrece suscribirse, y el dueño del servicio no', async () => {
  const p = abrir({
    estadoPanel: () => ({ ok: true, status: 200, json: async () => panelLleno({
      plan: 'vencido', soloLectura: true, esDueno: false,
      uso: { bytes: 1024 ** 3, gb: 1, topeGb: 2, medido: Date.now(), real: true },
      cobro: { proveedor: 'paddle', listo: true, falta: '', monto: 5, moneda: 'USD' },
      urlWebhook: '',
    }) }),
  });
  await asentarse();

  assert.equal(p.el('boton-suscribirse').hidden, false);
  assert.match(p.el('boton-suscribirse').textContent, /5 USD/);
  assert.equal(p.el('boton-suscribirse').disabled, false);
  assert.equal(p.el('link-admin').hidden, true, 'un creador cualquiera no ve /admin');

  p.cerrar();
});

test('si el cobro no está configurado, el botón lo dice en vez de fallar al tocarlo', async () => {
  const p = abrir({
    estadoPanel: () => ({ ok: true, status: 200, json: async () => panelLleno({
      plan: 'pendiente', soloLectura: true, esDueno: false,
      cobro: { proveedor: 'paddle', listo: false, falta: 'faltan PADDLE_API_KEY', monto: 0, moneda: 'USD' },
      urlWebhook: '',
    }) }),
  });
  await asentarse();

  assert.equal(p.el('boton-suscribirse').hidden, false);
  assert.equal(p.el('boton-suscribirse').disabled, true);
  assert.match(p.el('boton-suscribirse').textContent, /no está configurado/);

  p.cerrar();
});

test('el uso dice si el número es de ahora o la última foto', async () => {
  /* Un número medido hace tres días mostrado como si fuera de ahora es
     peor que no mostrarlo: se toman decisiones con él. */
  const p = abrir({
    estadoPanel: () => ({ ok: true, status: 200, json: async () => panelLleno({
      plan: 'amigo', soloLectura: false, esDueno: false,
      uso: { bytes: 0, gb: 1.5, topeGb: 2, medido: 0, real: false },
      urlWebhook: '',
    }) }),
  });
  await asentarse();

  assert.match(p.el('linea-uso').textContent, /1\.5 GB de 2 GB/);
  assert.match(p.el('linea-uso').textContent, /sin medir/i);

  p.cerrar();
});

test('la tarjeta del webhook sólo aparece si el servidor mandó la URL', async () => {
  /* A un creador que no es el dueño del servicio no le sirve de nada y
     lo invita a tocar donde no. El servidor le manda la URL vacía; lo
     que se prueba acá es que la página no muestre una tarjeta vacía. */
  const p = abrir({
    estadoPanel: () => ({ ok: true, status: 200, json: async () => panelLleno({
      plan: 'amigo', soloLectura: false, esDueno: false, urlWebhook: '',
    }) }),
  });
  await asentarse();

  assert.equal(p.el('tarjeta-webhook').hidden, true);
  assert.equal(p.el('url-webhook').textContent, '');

  p.cerrar();
});

test('el ejemplo del comando de subida lleva el slug de quien mira', async () => {
  const p = abrir({
    estadoPanel: () => ({ ok: true, status: 200, json: async () => panelLleno({
      slug: 'ana', plan: 'amigo', soloLectura: false, esDueno: false, urlWebhook: '',
    }) }),
  });
  await asentarse();

  assert.equal(p.el('ejemplo-slug').textContent, 'ana');
  /* `.href` y no `getAttribute('href')`: la página lo escribe como
     propiedad, y el atributo sigue teniendo lo que decía el HTML. En un
     navegador las dos cosas se ven distinto igual. */
  assert.equal(p.el('link-sala').href, '/sala/ana');

  p.cerrar();
});

test('el botón de suscribirse abre el checkout en otra pestaña, sin regalar la ventana', async () => {
  const abiertas = [];
  const p = abrir({
    estadoPanel: () => ({ ok: true, status: 200, json: async () => panelLleno({
      plan: 'pendiente', soloLectura: true, esDueno: false,
      cobro: { proveedor: 'paddle', listo: true, falta: '', monto: 5, moneda: 'USD' },
      urlWebhook: '',
    }) }),
    respuestas: {
      'POST /api/panel/suscribirse': () => ({
        ok: true, status: 200, json: async () => ({ url: 'https://sandbox-pay.paddle.io/hsc_9' }),
      }),
    },
    globales: { open: (url, destino, opciones) => { abiertas.push({ url, destino, opciones }); return {}; } },
  });
  await asentarse();

  p.el('boton-suscribirse').disparar('click');
  await asentarse();

  assert.equal(abiertas.length, 1, 'no se abrió el checkout');
  assert.equal(abiertas[0].url, 'https://sandbox-pay.paddle.io/hsc_9');
  assert.equal(abiertas[0].destino, '_blank', 'en la misma pestaña se pierde el panel');
  assert.match(abiertas[0].opciones, /noopener/,
    'una pestaña abierta sin noopener puede manejar la que la abrió');

  p.cerrar();
});

test('desvincular Twitch manda un DELETE y vuelve a consultar', async () => {
  const p = abrir();
  await asentarse();

  assert.equal(p.el('boton-desvincular-twitch').hidden, false, 'con Twitch vinculado tiene que estar');
  p.el('boton-desvincular-twitch').disparar('click');
  await asentarse();

  const borrados = p.pedidos.filter(x => x.metodo === 'DELETE' && x.url === '/api/panel/twitch');
  assert.equal(borrados.length, 1);

  p.cerrar();
});

test('el tope de conexiones de Twitch se explica en vez de decir "cortado"', async () => {
  const p = abrir({
    estadoPanel: () => ({ ok: true, status: 200, json: async () => panelLleno({
      salud: {
        ...SALUD,
        twitch: { vinculado: true, ultima: null, estado: 'cortado', modo: 'ninguno', tope: true },
      },
    }) }),
  });
  await asentarse();

  assert.match(p.el('tarjeta-estado').textContent, /tope de conexiones/i);
  assert.match(p.el('tarjeta-estado').textContent, /Kick sigue andando/i);

  p.cerrar();
});

/* ================================ el chat para tu comunidad (Fase 5.1) */

const CHAT_CERRADO = { activo: false, redes: ['kick', 'twitch'] };

/** Un panel cuyo /api/panel contesta con este chat abierto. */
const conChat = (chatAbierto, extra = {}) => ({
  estadoPanel: () => ({ ok: true, status: 200, json: async () => panelLleno({ chatAbierto, ...extra }) }),
});

const envios = p => p.pedidos.filter(x => x.metodo === 'POST' && x.url === '/api/panel/chat');

test('el bloque del chat abierto muestra lo que dice el servidor y el link de ESTE origen', async () => {
  const p = abrir(conChat({ activo: true, redes: ['kick', 'twitch'] }));
  await asentarse();

  assert.equal(p.el('tarjeta-chat-abierto').hidden, false);
  assert.equal(p.el('interruptor-chat-abierto').checked, true);
  assert.match(p.el('estado-chat-abierto').textContent, /Abierto/);
  assert.equal(p.el('red-chat-kick').checked, true);
  assert.equal(p.el('red-chat-twitch').checked, true);
  /* El origen es el de la página (acá, sala.example), no uno escrito en
     el código: detrás del proxy de Cloudflare tiene que salir el del
     proxy. */
  assert.equal(p.el('link-chat-abierto').textContent, 'https://sala.example/chat/istincho');
  assert.equal(p.el('abrir-chat-abierto').href, 'https://sala.example/chat/istincho');
  p.cerrar();
});

test('al lado del link está el aviso de OBS y Twitch', async () => {
  const p = abrir(conChat(CHAT_CERRADO));
  await asentarse();
  const texto = p.el('tarjeta-chat-abierto').textContent;
  assert.match(texto, /OBS/);
  assert.match(texto, /Twitch/);
  assert.match(texto, /simulcast/i);
  p.cerrar();
});

test('entra en todos los planes: con plan pendiente el interruptor se puede tocar', async () => {
  const p = abrir(conChat(CHAT_CERRADO, { plan: 'pendiente', soloLectura: true, esDueno: false }));
  await asentarse();
  assert.equal(p.el('boton-reproducir').disabled, true, 'la peli sí está apagada');
  assert.equal(p.el('tarjeta-chat-abierto').hidden, false);
  assert.equal(p.el('interruptor-chat-abierto').disabled, false, 'el chat no');
  p.cerrar();
});

test('tocar el interruptor manda activo y las redes, y nunca un slug', async () => {
  const p = abrir({
    ...conChat(CHAT_CERRADO),
    respuestas: {
      'POST /api/panel/chat': () => ({ ok: true, status: 200,
        json: async () => ({ ok: true, chatAbierto: { activo: true, redes: ['kick', 'twitch'] } }) }),
    },
  });
  await asentarse();

  p.el('interruptor-chat-abierto').checked = true;
  p.el('interruptor-chat-abierto').disparar('change');
  await asentarse();

  const [envio] = envios(p);
  assert.ok(envio, 'tiene que mandar algo');
  assert.deepEqual(JSON.parse(envio.cuerpo), { activo: true, redes: ['kick', 'twitch'] });
  assert.equal(p.el('interruptor-chat-abierto').checked, true);
  assert.match(p.el('estado-chat-abierto').textContent, /Abierto/);
  p.cerrar();
});

test('sacar la única red que queda no manda nada y la vuelve a marcar', async () => {
  const p = abrir(conChat({ activo: true, redes: ['kick'] }));
  await asentarse();

  p.el('red-chat-kick').checked = false;
  p.el('red-chat-kick').disparar('change');
  await asentarse();

  assert.equal(envios(p).length, 0);
  assert.equal(p.el('red-chat-kick').checked, true);
  assert.match(p.el('texto-aviso-panel').textContent, /al menos una red/);
  p.cerrar();
});

test('si el servidor lo rechaza, el interruptor vuelve a donde estaba y se dice por qué', async () => {
  const p = abrir({
    ...conChat(CHAT_CERRADO),
    respuestas: {
      'POST /api/panel/chat': () => ({ ok: false, status: 400, json: async () => ({ error: 'no se pudo por X' }) }),
    },
  });
  await asentarse();

  p.el('interruptor-chat-abierto').checked = true;
  p.el('interruptor-chat-abierto').disparar('change');
  await asentarse();

  assert.equal(p.el('interruptor-chat-abierto').checked, false, 'no puede quedar diciendo abierto');
  assert.match(p.el('texto-aviso-panel').textContent, /no se pudo por X/);
  p.cerrar();
});

test('mientras sale el cambio, la consulta de cada 4 s no lo pisa', async () => {
  let soltar;
  const p = abrir({
    ...conChat(CHAT_CERRADO),
    respuestas: {
      'POST /api/panel/chat': () => new Promise(ok => {
        soltar = () => ok({ ok: true, status: 200,
          json: async () => ({ ok: true, chatAbierto: { activo: true, redes: ['kick', 'twitch'] } }) });
      }),
    },
  });
  await asentarse();

  p.el('interruptor-chat-abierto').checked = true;
  p.el('interruptor-chat-abierto').disparar('change');
  assert.equal(p.el('interruptor-chat-abierto').disabled, true, 'mientras sale, no se toca dos veces');

  /* Llega la consulta de siempre, con el estado de ANTES del click. */
  await p.api().consultar();
  assert.equal(p.el('interruptor-chat-abierto').checked, true,
    'la consulta volvió el interruptor a "cerrado" con el click todavía en viaje');

  soltar();
  await asentarse();
  assert.equal(p.el('interruptor-chat-abierto').disabled, false);
  assert.equal(p.el('interruptor-chat-abierto').checked, true);
  p.cerrar();
});

test('Twitch elegido y sin vincular lo avisa', async () => {
  const sinTwitch = { ...SALUD, twitch: { vinculado: false, ultima: null, estado: 'cortado', modo: 'ninguno' } };
  const p = abrir(conChat({ activo: true, redes: ['kick', 'twitch'] }, { salud: sinTwitch }));
  await asentarse();
  assert.equal(p.el('nota-twitch-chat').hidden, false);
  p.cerrar();

  const conTwitch = abrir(conChat({ activo: true, redes: ['kick', 'twitch'] }));
  await asentarse();
  assert.equal(conTwitch.el('nota-twitch-chat').hidden, true);
  conTwitch.cerrar();
});

test('copiar el link lo manda al portapapeles', async () => {
  const copiado = [];
  const p = abrir({
    ...conChat(CHAT_CERRADO),
    globales: { navigator: { clipboard: { writeText: async t => { copiado.push(t); } } } },
  });
  await asentarse();
  p.el('boton-copiar-link-chat').disparar('click');
  await asentarse();
  assert.deepEqual(copiado, ['https://sala.example/chat/istincho']);
  p.cerrar();
});

test('el QR lleva al mismo link que dice el panel', async () => {
  const p = abrir(conChat({ activo: true, redes: ['kick'] }));
  await asentarse();

  const qr = p.el('qr-chat');
  assert.equal(qr.hidden, false);
  assert.match(qr.src, /^data:image\/svg\+xml;charset=utf-8,/);
  /* Se dibuja acá y no en el servidor porque el link también se arma
     acá, con el origen desde el que se mira el panel: si lo armara el
     servidor, detrás del proxy el QR llevaría al dominio de Railway.
     Que el dibujo sea legible lo prueban pruebas/qr.test.js y
     herramientas/verificar-qr.mjs; acá alcanza con que sea el de ESTE
     link y no el de otro. */
  const esperado = p.ventana.SalaQR.datosUri('https://sala.example/chat/istincho');
  assert.equal(qr.src, esperado);
  p.cerrar();
});

test('sin nadie bloqueado, la lista no se ve', async () => {
  /* Una lista vacía con un título no le dice nada a nadie. */
  const p = abrir(conChat({ activo: true, redes: ['kick'], bloqueados: [] }));
  await asentarse();
  assert.equal(p.el('bloque-bloqueados').hidden, true);
  p.cerrar();
});

test('los bloqueados salen con su red, y el botón los suelta', async () => {
  const p = abrir(conChat({
    activo: true,
    redes: ['kick', 'twitch'],
    bloqueados: [
      { red: 'kick', id: '909', nombre: 'Fulana', desde: Date.now() },
      { red: 'twitch', id: '77', nombre: '', desde: Date.now() },
    ],
  }));
  await asentarse();

  assert.equal(p.el('bloque-bloqueados').hidden, false);
  const filas = p.el('lista-bloqueados').children;
  assert.equal(filas.length, 2);
  assert.match(filas[0].textContent, /Kick/);
  assert.match(filas[0].textContent, /Fulana/);
  /* Sin nombre guardado queda el id, que es lo único seguro que hay. */
  assert.match(filas[1].textContent, /Twitch/);
  assert.match(filas[1].textContent, /77/);

  /* Y el texto dice que esto no es un baneo de la plataforma. */
  assert.match(p.el('bloque-bloqueados').textContent, /kick\.com/);

  const soltar = filas[0].children.find(c => c.tagName === 'BUTTON');
  soltar.disparar('click');
  await asentarse();

  const ultimo = envios(p).at(-1);
  assert.deepEqual(JSON.parse(ultimo.cuerpo), { desbloquear: { red: 'kick', id: '909' } },
    'se suelta de a uno: mandar la lista entera haría que dos pestañas se pisen');
  p.cerrar();
});

test('el nombre de un bloqueado no puede inventar etiquetas', async () => {
  /* El nombre lo escribió una persona desconocida en su plataforma. */
  const p = abrir(conChat({
    activo: true, redes: ['kick'],
    bloqueados: [{ red: 'kick', id: '1', nombre: '<img src=x onerror=alert(1)>', desde: 0 }],
  }));
  await asentarse();
  const fila = p.el('lista-bloqueados').children[0];
  assert.match(fila.textContent, /<img src=x/, 'entra como texto y no como HTML');
  assert.equal(fila.children.filter(c => c.tagName === 'IMG').length, 0);
  p.cerrar();
});

test('sin sesión el bloque del chat abierto no se ve', async () => {
  const p = abrir({ estadoPanel: () => ({ ok: false, status: 401, json: async () => ({ error: 'no hay sesion' }) }) });
  await asentarse();
  assert.equal(p.el('tarjeta-chat-abierto').hidden, true);
  p.cerrar();
});
