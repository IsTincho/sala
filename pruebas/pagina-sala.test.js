/* ============================================================
   La página /sala/:slug, corrida de verdad.

   `paginas/sala/sala.js` es donde vive la sincronización: la cuenta
   que decide en qué segundo pone la película cada pantalla. Eso no se
   puede probar desde el servidor y es lo único que separa "trescientas
   personas viendo lo mismo" de "trescientas personas viendo cada una
   su cosa".

   Se corre el archivo real sobre `paginas/sala.html` real, en el DOM
   de mentira de fijos/dom-falso.js —que además hace explotar cualquier
   uso de innerHTML— con un `Hls` de mentira, porque el de verdad
   viene de un CDN.

   Lo que se prueba es lo que se rompe:
     - que la posición se calcule con `empezoEn` y NO con el campo
       `posicion`, que en el evento `estado` puede tener horas de viejo;
     - que se corrija por encima de 1,5 s y no por debajo;
     - que no se corrija mientras el player bufferea (ahí la deriva que
       se mide es el buffer, no la deriva);
     - que la pausa local sea de la persona y la sala no se la pise;
     - que sin login se lea y no se escriba;
     - que el filtro por red NO esté acá (lo hace el servidor).
   ============================================================ */

import test from 'node:test';
import assert from 'node:assert/strict';

import { abrirPagina } from './fijos/dom-falso.js';

const esperar = ms => new Promise(ok => setTimeout(ok, ms));
/* La página arranca con tres `await fetch` seguidos (la medición del
   desfase). Unos turnos alcanzan para que termine de arrancar. */
const arrancada = () => esperar(40);

/* ------------------------------------------------------- el Hls falso

   Sólo lo que la página toca. Guarda la URL cargada para poder
   asertar que apunta a r2.dev y no a nuestro propio servidor. */

function hacerHlsFalso() {
  const instancias = [];

  class HlsFalso {
    constructor(opciones) {
      this.opciones = opciones;
      this.escuchas = new Map();
      this.subtitleTracks = [];
      this.subtitleTrack = -1;
      this.cargada = '';
      this.pegadoA = null;
      this.destruido = false;
      instancias.push(this);
    }
    static isSupported() { return true; }
    on(evento, fn) { this.escuchas.set(evento, fn); }
    loadSource(url) { this.cargada = url; }
    attachMedia(video) { this.pegadoA = video; }
    destroy() { this.destruido = true; }
    startLoad() { this.recargada = true; }
    recoverMediaError() { this.recuperada = true; }
    /** El test dispara los eventos que en el navegador dispara hls.js. */
    disparar(evento, datos) { this.escuchas.get(evento)?.(evento, datos); }
  }

  HlsFalso.Events = {
    MANIFEST_PARSED: 'hlsManifestParsed',
    SUBTITLE_TRACKS_UPDATED: 'hlsSubtitleTracksUpdated',
    ERROR: 'hlsError',
  };
  HlsFalso.ErrorTypes = { NETWORK_ERROR: 'networkError', MEDIA_ERROR: 'mediaError', OTHER_ERROR: 'otherError' };

  return { HlsFalso, instancias };
}

/* --------------------------------------------------------- abrir */

const URL_VIDEO = 'https://pub-ejemplo.r2.dev/istincho/ep1/maestra.m3u8';

const relojReproduciendo = (extra = {}) => ({
  tipo: 'reloj',
  estado: 'reproduciendo',
  videoId: 'ep1',
  titulo: 'Episodio 1',
  url: URL_VIDEO,
  duracion: 1200,
  calidades: [720],
  subtitulos: [],
  empezoEn: Date.now() - 100_000,
  pausadoEn: null,
  offsetInicial: 0,
  /* MENTIRA A PROPÓSITO: la foto que trae el evento está vieja. La
     página no la puede usar. */
  posicion: 7,
  ahora: Date.now() - 100_000,
  ...extra,
});

const mensaje = (extra = {}) => ({
  tipo: 'chat', red: 'kick', id: 'm1', usuario: 'unaespectadora',
  color: '#53fc18', insignias: [], texto: 'hola', emotes: [],
  hora: new Date().toISOString(), ...extra,
});

function abrir({ busqueda = '', ruta = '/sala/istincho', yo = null, respuestas = {}, conHls = true } = {}) {
  let alRecibir = null;
  const pedidos = [];
  const { HlsFalso, instancias } = hacerHlsFalso();

  const responder = async (url, opciones = {}) => {
    const ruta = String(url);
    pedidos.push({ url: ruta, opciones });
    if (respuestas[ruta]) return respuestas[ruta](opciones);
    if (ruta === '/api/hora') return { ok: true, status: 200, json: async () => ({ ahora: Date.now() }) };
    if (ruta.endsWith('/yo')) {
      return { ok: true, status: 200, json: async () => (yo ?? { entrado: false, nombre: '', puedeEscribir: false }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };

  const pagina = abrirPagina({
    archivo: 'sala.html',
    script: 'sala/sala.js',
    antes: ['comun/mensajes.js'],
    ruta,
    busqueda,
    fetch: responder,
    Sala: { conectar: (_slug, fn) => { alRecibir = fn; return { estado: 'conectado' }; } },
    globales: conHls ? { Hls: HlsFalso } : {},
  });

  return {
    ...pagina,
    pedidos,
    hls: () => instancias.at(-1) ?? null,
    api: () => pagina.ventana.SalaPagina,
    llega: (tipo, datos) => alRecibir?.(tipo, datos),
    get conectadoAlBus() { return Boolean(alRecibir); },
  };
}

/* ================================================ la sincronización */

test('la posición sale de empezoEn, NO del campo posicion del evento', async () => {
  /*
   * EL BUG QUE ESTO ATAJA. El reloj le llega al que se conecta adentro
   * del evento `estado`, y ese objeto está guardado en el canal desde
   * que se tocó play: su `posicion` puede tener horas de viejo. Si la
   * página la usara, cada persona que abriera la sala arrancaría en el
   * segundo en que arrancó la película para el primero que entró.
   */
  const p = abrir();
  await arrancada();

  p.api().fijarDesfase(0);
  const reloj = relojReproduciendo({ empezoEn: Date.now() - 300_000, offsetInicial: 0, posicion: 7 });
  p.api().aplicarReloj(reloj);

  const objetivo = p.api().objetivo();
  assert.ok(Math.abs(objetivo - 300) < 2, `dijo ${objetivo}, tendría que decir ~300`);
  assert.notEqual(Math.round(objetivo), 7, 'usó el campo posicion, que viene viejo');

  p.cerrar();
});

test('offsetInicial se suma: reanudar no reinicia la película', async () => {
  const p = abrir();
  await arrancada();
  p.api().fijarDesfase(0);

  p.api().aplicarReloj(relojReproduciendo({ empezoEn: Date.now() - 10_000, offsetInicial: 600 }));
  const objetivo = p.api().objetivo();
  assert.ok(Math.abs(objetivo - 610) < 2, `dijo ${objetivo}`);

  p.cerrar();
});

test('pausado se queda quieto aunque pase el tiempo', async () => {
  const p = abrir();
  await arrancada();
  p.api().fijarDesfase(0);

  const empezoEn = Date.now() - 60_000;
  p.api().aplicarReloj(relojReproduciendo({
    estado: 'pausado', empezoEn, pausadoEn: empezoEn + 30_000, offsetInicial: 0,
  }));

  const primero = p.api().objetivo();
  await esperar(60);
  const segundo = p.api().objetivo();

  assert.equal(primero, 30);
  assert.equal(segundo, 30, 'un reloj pausado no puede avanzar');

  p.cerrar();
});

test('la posición nunca se pasa de la duración', async () => {
  /* Un video terminado que siguiera sumando segundos dejaría al player
     pidiendo un segmento que no existe, reintentando para siempre. */
  const p = abrir();
  await arrancada();
  p.api().fijarDesfase(0);

  p.api().aplicarReloj(relojReproduciendo({ empezoEn: Date.now() - 5_000_000, duracion: 1200 }));
  assert.equal(p.api().objetivo(), 1200);

  p.cerrar();
});

test('con el reloj detenido no hay objetivo', async () => {
  const p = abrir();
  await arrancada();
  p.api().aplicarReloj({ tipo: 'reloj', estado: 'detenido', videoId: '' });
  assert.equal(p.api().objetivo(), null);
  p.cerrar();
});

/* -------------------------------------------------- la corrección */

/* `aplicarReloj` sincroniza forzando, y eso arranca los cinco segundos
   de gracia. Para probar la corrección NORMAL hay que olvidarse de esa
   corrección; si no, la prueba pasa por el motivo equivocado (lo
   descubrió una mutación: bajar el umbral a 50 segundos sobrevivía
   porque quien frenaba era la gracia, no el umbral). */
function listaParaCorregir(p, reloj) {
  p.api().fijarDesfase(0);
  p.api().aplicarReloj(reloj);
  p.api().olvidarCorreccion();
}

/* ============================== el desfase medido contra /api/hora

   Todo lo que hay abajo entra por `fijarDesfase()`, que es la puerta de
   atrás: pone el desfase a mano y se saltea `medirDesfase()` entero. O
   sea que la mitad del entregable 2 —"/api/hora para que el cliente
   calcule su desfase"— no tenía una sola prueba, y borrar la línea que
   aplica lo medido sobrevivía las 411.

   Importa porque en una máquina con el reloj corrido, esa línea ES el
   criterio de aceptación (a): sin ella, `ahoraServidor()` es el reloj
   local y la película se pone en el segundo equivocado por tanto como
   se haya corrido la máquina. */

/** Espera hasta que `cumple()` sea verdad, o falla diciendo qué pasó. */
async function hasta(cumple, queEsperaba, tope = 2000) {
  const limite = Date.now() + tope;
  while (Date.now() < limite) {
    if (cumple()) return;
    await esperar(5);
  }
  throw new Error(`nunca pasó: ${queEsperaba}`);
}

test('el desfase medido contra /api/hora se aplica de verdad', async () => {
  /*
   * El servidor va MEDIO MINUTO adelante del reloj de esta máquina.
   * Medio minuto es mucho más que cualquier ruido de la ida y vuelta,
   * así que no hay forma de que el resultado se confunda con cero.
   *
   * Y no se llama a `fijarDesfase()` en ningún momento: si la medición
   * no se aplicara sola, `objetivo()` contestaría 100 en vez de 130.
   */
  const ADELANTO = 30_000;
  const p = abrir({
    respuestas: {
      '/api/hora': async () => ({
        ok: true, status: 200, json: async () => ({ ahora: Date.now() + ADELANTO }),
      }),
    },
  });

  /* Las tres muestras que pide `medirDesfase`. */
  await hasta(
    () => p.pedidos.filter(x => x.url === '/api/hora').length >= 3,
    'la página nunca pidió /api/hora tres veces',
  );
  /* Y un turno más para que el `then` de la medición corra. */
  await esperar(10);

  const empezoEn = Date.now() - 100_000;
  p.api().aplicarReloj(relojReproduciendo({ empezoEn, offsetInicial: 0 }));

  /* Contra el reloj del SERVIDOR van 130 s de película, no 100. */
  const objetivo = p.api().objetivo();
  assert.ok(Math.abs(objetivo - 130) < 2,
    `dijo ${objetivo}: con el desfase aplicado tendría que decir ~130, sin aplicar ~100`);

  /* Y llegó hasta el player, que es lo que se ve: `aplicarReloj` fuerza
     una sincronización. */
  const video = p.el('video-peli');
  assert.ok(Math.abs(video.currentTime - 130) < 2,
    `el player quedó en ${video.currentTime}`);

  p.cerrar();
});

test('el reloj atrasado también se corrige, y para el otro lado', async () => {
  /* El signo importa: un desfase que se aplicara al revés pondría la
     película al doble de distancia en vez de acomodarla. */
  const ATRASO = -20_000;
  const p = abrir({
    respuestas: {
      '/api/hora': async () => ({
        ok: true, status: 200, json: async () => ({ ahora: Date.now() + ATRASO }),
      }),
    },
  });

  await hasta(
    () => p.pedidos.filter(x => x.url === '/api/hora').length >= 3,
    'la página nunca pidió /api/hora tres veces',
  );
  await esperar(10);

  p.api().aplicarReloj(relojReproduciendo({ empezoEn: Date.now() - 100_000, offsetInicial: 0 }));

  const objetivo = p.api().objetivo();
  assert.ok(Math.abs(objetivo - 80) < 2,
    `dijo ${objetivo}: tendría que decir ~80 (100 - 20), no ~100 ni ~120`);

  p.cerrar();
});

test('si /api/hora no contesta, la sala sigue con el reloj local', async () => {
  /* Sin desfase medido no se rompe nada: se sigue con cero, que es lo
     que vale en una máquina con la hora bien. Un `/api/hora` caído no
     puede dejar la sala muda. */
  const p = abrir({
    respuestas: { '/api/hora': async () => ({ ok: false, status: 500, json: async () => ({}) }) },
  });
  await arrancada();

  p.api().aplicarReloj(relojReproduciendo({ empezoEn: Date.now() - 100_000, offsetInicial: 0 }));
  const objetivo = p.api().objetivo();
  assert.ok(Math.abs(objetivo - 100) < 2, `dijo ${objetivo}`);
  assert.ok(p.conectadoAlBus, 'el bus se conecta igual: la hora no bloquea a nadie');

  p.cerrar();
});

test('una deriva de más de 1,5 s se corrige, y una de menos no', async () => {
  const p = abrir();
  await arrancada();

  const video = p.el('video-peli');
  listaParaCorregir(p, relojReproduciendo({ empezoEn: Date.now() - 100_000, offsetInicial: 0 }));

  /* Chica: no se toca. Un seek se ve, y medio segundo no se ve. */
  video.currentTime = 100.5;
  p.api().sincronizar();
  assert.equal(video.currentTime, 100.5, 'medio segundo no se corrige');

  /* Grande: se salta, SIN forzar. */
  p.api().olvidarCorreccion();
  video.currentTime = 95;
  p.api().sincronizar();
  assert.ok(Math.abs(video.currentTime - 100) < 2,
    `cinco segundos de deriva tienen que corregirse; quedó en ${video.currentTime}`);

  p.cerrar();
});

test('el umbral es de segundo y medio, no de cualquier número', async () => {
  /* Se prueban los dos lados del borde para que nadie pueda subirlo
     sin que la suite se entere. */
  const p = abrir();
  await arrancada();
  const video = p.el('video-peli');

  listaParaCorregir(p, relojReproduciendo({ empezoEn: Date.now() - 100_000, offsetInicial: 0 }));
  video.currentTime = 100 - 1.2;
  p.api().sincronizar();
  assert.ok(Math.abs(video.currentTime - 98.8) < 0.01, '1,2 s no se corrige');

  p.api().olvidarCorreccion();
  video.currentTime = 100 - 1.8;
  p.api().sincronizar();
  assert.ok(Math.abs(video.currentTime - 100) < 0.5, '1,8 s sí se corrige');

  p.cerrar();
});

test('no se corrige mientras el video bufferea o busca', async () => {
  /*
   * Con el buffer vacío, `currentTime` no dice dónde está la película:
   * dice dónde quedó. Corregir ahí encadena saltos y el video no
   * termina de arrancar nunca.
   */
  const p = abrir();
  await arrancada();

  const video = p.el('video-peli');
  listaParaCorregir(p, relojReproduciendo({ empezoEn: Date.now() - 100_000 }));

  video.currentTime = 10;             // 90 segundos de deriva
  video.readyState = 1;               // todavía no tiene datos
  p.api().sincronizar();
  assert.equal(video.currentTime, 10, 'corrigió con el buffer vacío');

  video.readyState = 4;
  video.seeking = true;
  p.api().sincronizar();
  assert.equal(video.currentTime, 10, 'corrigió en medio de un salto');

  /* Y con todo en orden, la misma deriva sí se corrige: si no, esta
     prueba pasaría igual con la sincronización rota del todo. */
  video.seeking = false;
  p.api().sincronizar();
  assert.ok(Math.abs(video.currentTime - 100) < 2, `quedó en ${video.currentTime}`);

  p.cerrar();
});

test('después de corregir se da unos segundos antes de volver a tocar', async () => {
  /* Un seek tarda en asentarse; volver a medir enseguida encadena
     saltos con la deriva del propio salto. */
  const p = abrir();
  await arrancada();
  p.api().fijarDesfase(0);

  const video = p.el('video-peli');
  p.api().aplicarReloj(relojReproduciendo({ empezoEn: Date.now() - 100_000 }));
  await esperar(10);

  video.currentTime = 50;
  p.api().sincronizar({ forzar: true });   // esto marca el momento de la corrección
  const despuesDeCorregir = video.currentTime;

  video.currentTime = 20;                  // vuelve a irse
  p.api().sincronizar();                   // sin forzar: tiene que aguantarse
  assert.equal(video.currentTime, 20, 'corrigió dentro del tiempo de gracia');
  assert.ok(Math.abs(despuesDeCorregir - 100) < 2);

  /* Y pasada la gracia, corrige: la espera es una espera, no un apagón. */
  p.api().olvidarCorreccion();
  p.api().sincronizar();
  assert.ok(Math.abs(video.currentTime - 100) < 2);

  p.cerrar();
});

/* ------------------------------------------------- la pausa local */

test('la pausa local es de la persona: la sala no se la pisa', async () => {
  /* El botón existe porque el navegador puede no dejar arrancar solo.
     Si la sincronización siguiera corriendo mientras alguien pausó, le
     movería la película bajo los pies. */
  const p = abrir();
  await arrancada();

  const video = p.el('video-peli');
  listaParaCorregir(p, relojReproduciendo({ empezoEn: Date.now() - 100_000 }));

  p.el('boton-play').disparar('click');     // pausa local
  assert.equal(p.api().pausaLocal, true);
  assert.equal(video.paused, true);

  /* Noventa segundos de deriva y la gracia ya vencida: si la pausa
     local no valiera, esto saltaría. */
  p.api().olvidarCorreccion();
  video.currentTime = 10;
  p.api().sincronizar();
  assert.equal(video.currentTime, 10, 'la sincronización pisó una pausa local');

  p.cerrar();
});

test('volver del play local salta a donde va la sala, no a donde se quedó', async () => {
  const p = abrir();
  await arrancada();
  p.api().fijarDesfase(0);

  const video = p.el('video-peli');
  p.api().aplicarReloj(relojReproduciendo({ empezoEn: Date.now() - 100_000 }));
  await esperar(10);

  p.el('boton-play').disparar('click');     // pausa
  video.currentTime = 10;
  p.el('boton-play').disparar('click');     // play

  assert.equal(p.api().pausaLocal, false);
  assert.ok(Math.abs(video.currentTime - 100) < 2, `quedó en ${video.currentTime}`);
  assert.equal(video.paused, false);

  p.cerrar();
});

/* ---------------------------------------------------- el player */

test('el video se carga con hls.js desde la URL de R2, no desde el servidor', async () => {
  /* La regla que no se negocia: el servidor nunca sirve video. */
  const p = abrir();
  await arrancada();

  p.api().aplicarReloj(relojReproduciendo());
  const hls = p.hls();

  assert.equal(hls.cargada, URL_VIDEO);
  assert.match(hls.cargada, /^https:\/\/pub-/);
  assert.equal(hls.pegadoA, p.el('video-peli'));

  p.cerrar();
});

test('el mismo video no se vuelve a cargar en cada evento de reloj', async () => {
  /* Play, pausa y reanudar son tres eventos del mismo video: recargar
     la playlist en cada uno tiraría el buffer y cortaría la imagen. */
  const p = abrir();
  await arrancada();

  p.api().aplicarReloj(relojReproduciendo());
  const primera = p.hls();
  p.api().aplicarReloj(relojReproduciendo({ estado: 'pausado', pausadoEn: Date.now() }));

  assert.equal(p.hls(), primera, 'se creó otro Hls para el mismo video');
  assert.equal(primera.destruido, false);

  p.cerrar();
});

test('un video distinto sí suelta el anterior', async () => {
  const p = abrir();
  await arrancada();

  p.api().aplicarReloj(relojReproduciendo());
  const primera = p.hls();
  p.api().aplicarReloj(relojReproduciendo({
    videoId: 'ep2', url: 'https://pub-ejemplo.r2.dev/istincho/ep2/maestra.m3u8',
  }));

  assert.equal(primera.destruido, true, 'quedó un hls.js vivo consumiendo red');
  assert.notEqual(p.hls(), primera);

  p.cerrar();
});

test('sin hls.js y sin HLS nativo se avisa en vez de quedar la pantalla negra', async () => {
  const p = abrir({ conHls: false });
  await arrancada();

  p.api().aplicarReloj(relojReproduciendo());

  assert.equal(p.el('aviso-sala').hidden, false);
  assert.match(p.el('texto-aviso').textContent, /no puede reproducir/);

  p.cerrar();
});

test('los subtítulos aparecen cuando el video los trae, y no antes', async () => {
  const p = abrir();
  await arrancada();

  const select = p.el('select-subtitulos');
  assert.equal(select.hidden, true, 'un selector con una sola opción no es un selector');

  p.api().aplicarReloj(relojReproduciendo());
  const hls = p.hls();
  hls.subtitleTracks = [{ name: 'Español' }, { name: 'English' }];
  hls.disparar('hlsManifestParsed');

  assert.equal(select.hidden, false);
  assert.deepEqual(select.children.map(o => o.textContent),
    ['Sin subtítulos', 'Español', 'English']);

  select.value = '1';
  select.disparar('change');
  assert.equal(hls.subtitleTrack, 1);

  p.cerrar();
});

/* --------------------------------------------- espera y pantalla */

test('con el reloj detenido se ve la espera y la cámara se queda con la pantalla', async () => {
  const p = abrir();
  await arrancada();

  p.api().aplicarReloj({ tipo: 'reloj', estado: 'detenido', videoId: '' });

  assert.equal(p.el('sala').dataset.espera, 'si');
  assert.equal(p.el('columna-video').hidden, true);
  assert.equal(p.el('texto-espera').hidden, false);
  assert.match(p.el('texto-espera').textContent, /cámara/i);

  /* Y al empezar la película, al revés. */
  p.api().aplicarReloj(relojReproduciendo());
  assert.equal(p.el('sala').dataset.espera, 'no');
  assert.equal(p.el('columna-video').hidden, false);
  assert.equal(p.el('texto-espera').hidden, true);
  assert.equal(p.el('titulo-peli').textContent, 'Episodio 1');

  p.cerrar();
});

test('la cámara es un iframe de player.kick.com con el slug de la dirección', async () => {
  const p = abrir({ ruta: '/sala/istincho' });
  await arrancada();

  const marco = p.el('caja-camara').children[0];
  assert.equal(marco.tagName, 'IFRAME');
  assert.equal(marco.src, 'https://player.kick.com/istincho?autoplay=true&muted=true');

  p.cerrar();
});

test('un canal raro no se cuela en la URL del iframe sin escapar', async () => {
  /*
   * El canal sale de la dirección, o sea de afuera. `?canal=` lo entrega
   * DECODIFICADO (lo decodifica URLSearchParams), así que es el camino
   * por el que de verdad puede entrar un `&` o una comilla: sin
   * encodeURIComponent, un `?canal=x&autoplay=false` reescribiría los
   * parámetros del embed de Kick, y una comilla saldría cruda dentro de
   * un atributo.
   */
  const p = abrir({ busqueda: '?canal=x%22%3E%26autoplay%3Dfalse' });
  await arrancada();

  const marco = p.el('caja-camara').children[0];
  assert.equal(marco.src,
    'https://player.kick.com/x%22%3E%26autoplay%3Dfalse?autoplay=true&muted=true');
  /* Lo que importa: ni la comilla ni el `&` quedan crudos. */
  assert.ok(!marco.src.includes('"'), marco.src);
  assert.ok(!marco.src.includes('&autoplay=false'), marco.src);

  p.cerrar();
});

/* ------------------------------------------------------- el chat */

test('un mensaje del bus entra en la lista', async () => {
  const p = abrir();
  await arrancada();

  p.llega('chat', mensaje({ texto: 'qué peli más larga' }));

  const lista = p.el('lista-chat');
  assert.equal(lista.children.length, 1);
  assert.match(lista.children[0].textContent, /qué peli más larga/);
  assert.match(lista.children[0].textContent, /unaespectadora/);

  p.cerrar();
});

test('la página NO filtra por red: el filtro vive en el servidor', async () => {
  /*
   * A la Sala llega sólo Kick porque el servidor filtra el bus por
   * conexión. Volver a filtrar acá haría invisible una regresión en
   * esa puerta: el chat de Twitch seguiría saliendo por el cable hacia
   * todas las pestañas y nadie se enteraría. Una sola fuente de
   * verdad, y es el servidor; esta prueba lo deja escrito.
   */
  const p = abrir();
  await arrancada();

  p.llega('chat', mensaje({ red: 'twitch', id: 't1', texto: 'esto no debería llegar nunca' }));

  assert.equal(p.el('lista-chat').children.length, 1,
    'si la página filtra, el servidor puede romperse sin que se note');

  p.cerrar();
});

test('subir el scroll pausa, cuenta lo nuevo, y el botón despausa', async () => {
  const p = abrir();
  await arrancada();

  const lista = p.el('lista-chat');
  lista.scrollHeight = 1000;
  lista.clientHeight = 200;
  lista.scrollTop = 0;                 // el usuario subió
  lista.disparar('scroll');

  p.llega('chat', mensaje({ id: 'a' }));
  p.llega('chat', mensaje({ id: 'b' }));

  assert.equal(p.el('boton-abajo').hidden, false);
  assert.equal(p.el('contador-nuevos').textContent, '2');
  assert.equal(lista.scrollTop, 0, 'no puede saltar mientras alguien lee arriba');

  lista.scrollHeight = 1200;
  p.el('boton-abajo').disparar('click');
  assert.equal(p.el('boton-abajo').hidden, true);
  assert.equal(lista.scrollTop, 1200);

  p.cerrar();
});

test('la lista no crece para siempre', async () => {
  const p = abrir();
  await arrancada();

  for (let i = 0; i < 320; i++) p.llega('chat', mensaje({ id: 'm' + i, texto: 'n' + i }));

  const lista = p.el('lista-chat');
  assert.equal(lista.children.length, 300);
  assert.match(lista.children.at(-1).textContent, /n319/);

  p.cerrar();
});

/* -------------------------------------------------- entrar y escribir */

test('sin login se lee pero la caja de escribir está apagada', async () => {
  const p = abrir({ yo: { entrado: false, nombre: '', puedeEscribir: false } });
  await arrancada();

  assert.equal(p.el('campo-texto').disabled, true);
  assert.equal(p.el('boton-enviar').disabled, true);
  assert.equal(p.el('banda-entrar').hidden, false);
  assert.equal(p.el('fila-espectador').hidden, true);

  p.cerrar();
});

test('el link de entrar vuelve a ESTA sala', async () => {
  const p = abrir({ ruta: '/sala/istincho' });
  await arrancada();

  const href = p.el('link-entrar').href;
  assert.match(href, /rol=espectador/);
  assert.match(href, /destino=%2Fsala%2Fistincho/);

  p.cerrar();
});

test('con login se enciende la caja y aparece el nombre', async () => {
  const p = abrir({ yo: { entrado: true, nombre: 'unaespectadora', puedeEscribir: true } });
  await arrancada();

  assert.equal(p.el('campo-texto').disabled, false);
  assert.equal(p.el('boton-enviar').disabled, false);
  assert.equal(p.el('banda-entrar').hidden, true);
  assert.equal(p.el('fila-espectador').hidden, false);
  assert.equal(p.el('nombre-espectador').textContent, 'unaespectadora');

  p.cerrar();
});

test('entrado pero sin permiso para escribir se dice, no se deja probar', async () => {
  const p = abrir({ yo: { entrado: true, nombre: 'alguien', puedeEscribir: false } });
  await arrancada();

  assert.equal(p.el('campo-texto').disabled, true);
  assert.match(p.el('campo-texto').placeholder, /no incluye escribir/);

  p.cerrar();
});

test('enviar pega en la ruta de la sala y limpia el campo, sin pintar el mensaje', async () => {
  /* El mensaje vuelve por el webhook como cualquier otro: pintarlo acá
     lo mostraría dos veces y encima mentiría si Kick lo retuvo. */
  const enviados = [];
  const p = abrir({
    yo: { entrado: true, nombre: 'yo', puedeEscribir: true },
    respuestas: {
      '/api/sala/istincho/chat': opciones => {
        enviados.push(JSON.parse(opciones.body));
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      },
    },
  });
  await arrancada();

  p.el('campo-texto').value = 'hola a todos';
  p.el('boton-enviar').disparar('click');
  await esperar(20);

  assert.deepEqual(enviados, [{ texto: 'hola a todos' }]);
  assert.equal(p.el('campo-texto').value, '');
  assert.equal(p.el('lista-chat').children.length, 0, 'no se pinta el propio mensaje');

  p.cerrar();
});

test('un 429 arranca la cuenta regresiva en vez de reintentar', async () => {
  let intentos = 0;
  const p = abrir({
    yo: { entrado: true, nombre: 'yo', puedeEscribir: true },
    respuestas: {
      '/api/sala/istincho/chat': () => {
        intentos++;
        return { ok: false, status: 429, json: async () => ({ error: 'esperá', esperar: 3 }) };
      },
    },
  });
  await arrancada();

  p.el('campo-texto').value = 'uno';
  p.el('boton-enviar').disparar('click');
  await esperar(20);

  assert.equal(p.el('aviso-sala').hidden, false);
  assert.match(p.el('texto-aviso').textContent, /esperá 3/);
  assert.equal(p.el('boton-enviar').disabled, true);

  /* Y mientras dura, tocar enviar no manda nada. */
  p.el('campo-texto').value = 'dos';
  p.el('boton-enviar').disparar('click');
  await esperar(20);
  assert.equal(intentos, 1);

  p.cerrar();
});

test('un 401 apaga la caja: la sesión se cayó', async () => {
  const p = abrir({
    yo: { entrado: true, nombre: 'yo', puedeEscribir: true },
    respuestas: {
      '/api/sala/istincho/chat': () => ({
        ok: false, status: 401, json: async () => ({ error: 'tu permiso con Kick vencio' }),
      }),
    },
  });
  await arrancada();

  p.el('campo-texto').value = 'hola';
  p.el('boton-enviar').disparar('click');
  await esperar(20);

  assert.equal(p.el('campo-texto').disabled, true);
  assert.equal(p.el('banda-entrar').hidden, false);

  p.cerrar();
});

/* ------------------------------------------------- gente conectada */

test('el contador de espectadores sale del bus', async () => {
  const p = abrir();
  await arrancada();

  p.llega('estado', { tipo: 'estado', slug: 'istincho', conectados: 12, reloj: null });
  assert.equal(p.el('contador-espectadores').textContent, '12');

  p.llega('presencia', { tipo: 'presencia', conectados: 137 });
  assert.equal(p.el('contador-espectadores').textContent, '137');

  p.cerrar();
});

/* ------------------------------------------------------- el demo */

test('?demo=1 no toca la red', async () => {
  const p = abrir({ busqueda: '?demo=1' });
  await arrancada();

  assert.equal(p.pedidos.length, 0, 'el demo pidió algo: ' + JSON.stringify(p.pedidos));
  assert.equal(p.conectadoAlBus, false);
  /* Y aun así se ve la página entera: es para lo que existe. */
  assert.ok(p.el('lista-chat').children.length > 0);
  assert.equal(p.el('sala').dataset.espera, 'no');

  p.cerrar();
});

/* --------------------------------------------------- el volumen */

test('la película arranca muda: es la única forma de que arranque sola', async () => {
  const p = abrir();
  await arrancada();
  assert.equal(p.el('video-peli').muted, true);
  p.cerrar();
});

test('el botón del parlante devuelve el sonido', async () => {
  const p = abrir();
  await arrancada();

  const video = p.el('video-peli');
  p.el('boton-mudo').disparar('click');
  assert.equal(video.muted, false);

  p.el('control-volumen').value = '40';
  p.el('control-volumen').disparar('input');
  assert.equal(video.volume, 0.4);

  p.cerrar();
});

/* ------------------------------------------- el botón con la sala en pausa */

test('con la sala en pausa, ▶ no arranca la película: la deja quieta y lo dice', async () => {
  /*
   * EL BUG QUE ESTO ATAJA. El botón de play existe porque el navegador
   * puede no dejar arrancar solo, no para pelearse con el reloj de la
   * sala. Cuando arrancaba por su cuenta con la sala en pausa, la
   * película corría unos segundos y la sincronización de cada diez la
   * tironeaba de vuelta: la persona veía el video moverse y después
   * dar un salto para atrás, sin entender por qué.
   */
  const p = abrir();
  await arrancada();
  p.api().fijarDesfase(0);

  const video = p.el('video-peli');
  const empezoEn = Date.now() - 60_000;
  p.api().aplicarReloj(relojReproduciendo({
    estado: 'pausado', empezoEn, pausadoEn: empezoEn + 30_000, offsetInicial: 0,
  }));
  assert.equal(video.paused, true, 'con la sala en pausa el video arranca quieto');

  p.el('boton-play').disparar('click');

  assert.equal(video.paused, true,
    'arrancó con la sala en pausa: en diez segundos el reloj lo tironea para atrás');
  assert.equal(p.el('aviso-sala').hidden, false, 'arrancó o no arrancó, pero no dijo nada');
  assert.match(p.el('texto-aviso').textContent, /pausa/i);

  /* Y la pausa local quedó levantada: cuando la sala reanude, esta
     pantalla arranca sola sin que nadie toque nada. */
  assert.equal(p.api().pausaLocal, false);
  p.api().aplicarReloj(relojReproduciendo({ empezoEn: Date.now() - 30_000, offsetInicial: 0 }));
  assert.equal(video.paused, false, 'la sala reanudó y esta pantalla se quedó parada');

  p.cerrar();
});

test('con la sala detenida, ▶ tampoco arranca nada', async () => {
  const p = abrir();
  await arrancada();

  const video = p.el('video-peli');
  p.api().aplicarReloj({ tipo: 'reloj', estado: 'detenido', videoId: '' });

  p.el('boton-play').disparar('click');

  assert.equal(video.paused, true, 'se puso a reproducir un video que no existe');
  assert.match(p.el('texto-aviso').textContent, /no empezó/i);

  p.cerrar();
});

/* ------------------------------------------------- el arranque de la página */

test('un /api/hora colgado no deja la sala muda: el bus se conecta igual', async () => {
  /*
   * EL BUG QUE ESTO ATAJA. `iniciar()` hacía `await medirDesfase()`
   * antes de conectar, y el fetch no tenía corte. Un /api/hora que no
   * contesta nunca (un proxy que se traga la respuesta) dejaba la sala
   * SIN BUS: ni reloj, ni chat, ni contador, y ni un error a la vista.
   */
  const señales = [];
  const p = abrir({
    respuestas: {
      '/api/hora': opciones => new Promise((_, rechazar) => {
        señales.push(opciones.signal);
        opciones.signal.addEventListener('abort', () => rechazar(new Error('abortada')));
      }),
    },
  });
  await arrancada();

  assert.equal(p.conectadoAlBus, true,
    'sin la hora del servidor no se conectó al bus: la sala queda muda para siempre');

  /* Y con el cable puesto, lo que importa llega igual. */
  p.llega('chat', mensaje({ texto: 'se lee igual' }));
  assert.equal(p.el('lista-chat').children.length, 1);
  p.llega('presencia', { tipo: 'presencia', conectados: 9 });
  assert.equal(p.el('contador-espectadores').textContent, '9');

  p.cerrar();
});

test('el pedido de la hora se corta solo en vez de esperar para siempre', async () => {
  const señales = [];
  const p = abrir({
    respuestas: {
      '/api/hora': opciones => new Promise((_, rechazar) => {
        señales.push(opciones.signal);
        opciones.signal.addEventListener('abort', () => rechazar(new Error('abortada')));
      }),
    },
  });

  /* Se espera a que el corte llegue, con margen de sobra: el corte es
     de 3 s. Sin corte, esta espera se agota y la señal sigue viva. */
  const hasta = Date.now() + 6000;
  while (!señales[0]?.aborted && Date.now() < hasta) await esperar(50);

  assert.equal(señales.length, 1, 'volvió a pedir la hora después de un corte: son 9 s de espera al pedo');
  assert.equal(señales[0].aborted, true, 'el fetch de la hora no tiene corte: espera para siempre');

  p.cerrar();
});

/* --------------------------------------------------- pantalla completa */

test('pantalla completa es la caja del video, no el video pelado, y el botón la saca', async () => {
  /* La caja lleva los controles adentro: pedirla sobre el <video> deja
     a la persona en pantalla completa sin volumen ni subtítulos. */
  const p = abrir();
  await arrancada();
  p.api().aplicarReloj(relojReproduciendo());

  /* Se compara por id y no por el elemento: un assert que falla sobre
     un nodo del árbol imprime el árbol entero, con sus padres, y la
     suite se queda colgada armando el mensaje. */
  const quienLaTiene = () => p.documento.fullscreenElement?.id ?? null;

  const boton = p.el('boton-pantalla-completa');
  boton.disparar('click');
  assert.equal(quienLaTiene(), 'caja-video');

  boton.disparar('click');
  assert.equal(quienLaTiene(), null, 'el mismo botón tiene que sacarla');

  p.cerrar();
});

/* ------------------------------------------------------ suscribirse */

test('el botón de suscribirse es un link a kick.com/<canal>/subscribe', async () => {
  const p = abrir({ ruta: '/sala/istincho' });
  await arrancada();

  const link = p.el('link-suscribirse');
  assert.equal(link.hidden, false);
  assert.equal(link.href, 'https://kick.com/istincho/subscribe');
  /* Se abre en otra pestaña y sin dejarle a Kick la referencia a esta:
     la película sigue corriendo acá. */
  assert.equal(link.getAttribute('target'), '_blank');
  assert.equal(link.getAttribute('rel'), 'noopener noreferrer');

  p.cerrar();
});

test('un canal raro tampoco se cuela en el link de suscribirse', async () => {
  const p = abrir({ busqueda: '?canal=x%22%3E%26a%3D1' });
  await arrancada();

  const link = p.el('link-suscribirse');
  assert.equal(link.href, 'https://kick.com/x%22%3E%26a%3D1/subscribe');
  assert.ok(!link.href.includes('"'), link.href);

  p.cerrar();
});
