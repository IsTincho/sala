/* ============================================================
   La pagina /chat, corrida de verdad.

   `paginas/chat/chat.js` decide todo lo que se ve y no tenia un solo
   test: el bug de la lista que quedaba vacia al cambiar de vista lo
   encontro una persona mirando la pantalla, no la suite.

   Se corre el archivo real sobre `paginas/chat.html` real, en el DOM
   de mentira de fijos/dom-falso.js (que ademas hace explotar cualquier
   uso de innerHTML). Lo que se prueba es lo que se rompe de verdad:

     - que un mensaje entre en la lista mezclada Y en su columna,
       siempre, sin mirar la vista;
     - que subir el scroll pause y cuente, y que el boton despause;
     - que el aviso de "resuscribir" salga del veredicto del SERVIDOR
       y se pueda cerrar sin que quede cerrado para siempre;
     - que un 429 arranque la cuenta regresiva en vez de reintentar;
     - que ?demo=1 no toque la red.
   ============================================================ */

import test from 'node:test';
import assert from 'node:assert/strict';

import { abrirPagina } from './fijos/dom-falso.js';

const esperar = ms => new Promise(ok => setTimeout(ok, ms));
/* La pagina hace todo con promesas de fetch: un par de turnos alcanza
   para que termine de aplicar la respuesta. */
const asentarse = () => esperar(10);

const mensaje = (extra = {}) => ({
  tipo: 'chat', red: 'kick', id: 'm1', usuario: 'ElkaChonda',
  color: '#53fc18', insignias: [], texto: 'hola', emotes: [],
  hora: new Date().toISOString(), ...extra,
});

const SALUD_SANA = {
  kick: { vinculado: true, ultima: new Date().toISOString(), suscripcion: 'activa', vivo: true, sospechoso: false },
  twitch: { vinculado: true, ultima: new Date().toISOString(), estado: 'conectado', modo: 'eventsub' },
  ahora: new Date().toISOString(),
};

/**
 * Abre la pagina con un bus de mentira y un fetch de mentira.
 * Devuelve, ademas de la pagina, con que empujarle mensajes y salud.
 */
function abrir({ busqueda = '', respuestas = {}, salud = SALUD_SANA } = {}) {
  let alRecibir = null;
  const pedidos = [];

  const responder = async (url, opciones = {}) => {
    pedidos.push({ url: String(url), opciones });
    const ruta = String(url);
    if (respuestas[ruta]) return respuestas[ruta](opciones);
    if (ruta === '/api/estado') return { ok: true, status: 200, json: async () => ({ slug: 'istincho' }) };
    if (ruta === '/api/chat/salud') return { ok: true, status: 200, json: async () => salud };
    return { ok: false, status: 404, json: async () => ({}) };
  };

  const pagina = abrirPagina({
    busqueda,
    /* El render de un mensaje vive en comun/mensajes.js, compartido con
       /sala/:slug. La pagina lo carga con su propio <script>; aca se
       corre de verdad, no una imitacion. */
    antes: ['comun/mensajes.js'],
    fetch: responder,
    Sala: { conectar: (_slug, fn) => { alRecibir = fn; } },
  });

  return {
    ...pagina,
    pedidos,
    /** un mensaje que llega por el bus */
    llega: datos => alRecibir?.('chat', datos),
    get conectadoAlBus() { return Boolean(alRecibir); },
  };
}

/* ------------------------------------------------- vistas y listas */

test('un mensaje entra en la lista mezclada Y en la columna de su red', async () => {
  /* EL BUG que encontro un humano: la version anterior elegia la lista
     al recibir el mensaje. Se veia bien hasta que se tocaba el boton
     de vista, y ahi aparecia una lista vacia —el historial estaba en
     la otra— hasta que alguien volviera a hablar. En medio de un
     stream, cambiar de vista te borraba el chat de la pantalla. */
  const p = abrir();
  await asentarse();

  p.llega(mensaje({ id: 'k1', red: 'kick', texto: 'desde kick' }));
  p.llega(mensaje({ id: 't1', red: 'twitch', usuario: 'purple', texto: 'desde twitch' }));

  assert.equal(p.el('lista-mezclada').children.length, 2, 'las dos en la mezclada');
  assert.equal(p.el('lista-kick').children.length, 1);
  assert.equal(p.el('lista-twitch').children.length, 1);

  /* y al cambiar de vista, lo que ya paso sigue estando */
  p.el('boton-vista').disparar('click');
  assert.equal(p.el('lista-kick').children.length, 1, 'la columna no aparece vacia');
  assert.match(p.el('lista-kick').textContent, /desde kick/);
  assert.match(p.el('lista-twitch').textContent, /desde twitch/);

  p.cerrar();
});

test('el boton de vista prende las columnas y lo deja escrito en la URL', async () => {
  const p = abrir();
  await asentarse();

  assert.equal(p.el('columna-mezclada').hidden, false);
  assert.equal(p.el('columna-kick').hidden, true);

  p.el('boton-vista').disparar('click');

  assert.equal(p.el('columna-mezclada').hidden, true);
  assert.equal(p.el('columna-kick').hidden, false);
  assert.equal(p.el('columna-twitch').hidden, false);
  assert.equal(p.el('area-mensajes').dataset.vista, 'columnas');
  assert.match(p.ventana.history.urls.at(-1), /vista=columnas/,
    'la URL tiene que poder compartirse y sobrevivir un F5');

  p.cerrar();
});

test('la vista y el filtro se leen de la URL al abrir', async () => {
  const p = abrir({ busqueda: '?vista=columnas&letra=grande&filtro=twitch' });
  await asentarse();

  assert.equal(p.el('columna-mezclada').hidden, true);
  assert.equal(p.el('columna-kick').hidden, true, 'con filtro twitch, la columna de Kick no se ve');
  assert.equal(p.el('columna-twitch').hidden, false);
  assert.equal(p.documento.documentElement.style.getPropertyValue('--tam-chat'), '1.25rem');

  p.cerrar();
});

test('el filtro esconde con CSS, no sacando mensajes de la lista', async () => {
  /* Si el filtro sacara los mensajes de la lista, volver a "todas" no
     los podria traer de vuelta: el historial ya paso. */
  const p = abrir();
  await asentarse();
  p.llega(mensaje({ id: 'k1', red: 'kick' }));
  p.llega(mensaje({ id: 't1', red: 'twitch' }));

  p.el('boton-filtro').disparar('click');          // todas -> kick

  assert.equal(p.el('lista-mezclada').dataset.filtro, 'kick');
  assert.equal(p.el('lista-mezclada').children.length, 2, 'los mensajes siguen ahi');

  p.el('boton-filtro').disparar('click');          // kick -> twitch
  p.el('boton-filtro').disparar('click');          // twitch -> todas
  assert.equal(p.el('lista-mezclada').dataset.filtro, 'todas');
  assert.equal(p.el('lista-mezclada').children.length, 2);

  p.cerrar();
});

/* ------------------------------------------------- pausa del scroll */

test('subir el scroll pausa, cuenta los nuevos, y el boton despausa', async () => {
  const p = abrir();
  await asentarse();
  const lista = p.el('lista-mezclada');
  const boton = p.el('boton-abajo-mezclada');

  /* la persona sube a leer algo de antes */
  lista.scrollHeight = 1000;
  lista.clientHeight = 200;
  lista.scrollTop = 0;
  lista.disparar('scroll');

  assert.equal(lista.getAttribute('aria-live'), 'off',
    'pausado: un lector de pantalla no tiene que leer mensajes que nadie esta mirando');

  p.llega(mensaje({ id: 'a' }));
  p.llega(mensaje({ id: 'b' }));

  assert.equal(boton.hidden, false);
  assert.equal(p.el('contador-mezclada').textContent, '2');
  assert.equal(lista.scrollTop, 0, 'y no se movio la pantalla debajo de la persona');

  boton.disparar('click');

  assert.equal(boton.hidden, true);
  assert.equal(lista.scrollTop, lista.scrollHeight, 'vuelve abajo del todo');

  p.cerrar();
});

test('volver a bajar solo despausa sin tocar el boton', async () => {
  const p = abrir();
  await asentarse();
  const lista = p.el('lista-mezclada');

  lista.scrollHeight = 1000; lista.clientHeight = 200; lista.scrollTop = 0;
  lista.disparar('scroll');
  assert.equal(p.el('boton-abajo-mezclada').hidden, true, 'todavia no hay nuevos');

  lista.scrollTop = 800;                 // pegado abajo otra vez
  lista.disparar('scroll');

  p.llega(mensaje({ id: 'c' }));
  assert.equal(p.el('boton-abajo-mezclada').hidden, true, 'ya no esta pausada');
  assert.equal(lista.getAttribute('aria-live'), 'polite');

  p.cerrar();
});

/* --------------------------------------------------- el render seguro */

test('el texto de un mensaje se escribe como texto, nunca como HTML', async () => {
  /* El DOM de mentira hace explotar innerHTML: si alguien lo usa para
     armar un mensaje, este test se cae con un error, no con una
     asercion. Aca ademas se comprueba que el texto llega entero. */
  const p = abrir();
  await asentarse();

  const veneno = '<img src=x onerror=alert(1)>';
  p.llega(mensaje({ id: 'x', texto: veneno }));

  const li = p.el('lista-mezclada').children[0];
  assert.match(li.textContent, /<img src=x onerror=alert\(1\)>/, 'queda como texto literal');
  assert.equal(li.children.filter(e => e.tagName === 'IMG').length, 0, 'y no se creo ninguna imagen');

  p.cerrar();
});

test('un emote se corta por puntos de codigo, con un emoji adelante', async () => {
  /* Con un emoji fuera del plano basico antes del emote, cortar por
     unidades UTF-16 desplaza la imagen y se come una letra. El caso
     sin emoji pasa igual con el codigo roto, asi que el emoji va a
     proposito. */
  const p = abrir();
  await asentarse();

  p.llega(mensaje({
    id: 'e', red: 'twitch',
    texto: '👋hola Kappa como va',
    emotes: [{ id: '25', inicio: 6, fin: 11, url: 'https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/3.0' }],
  }));

  const li = p.el('lista-mezclada').children[0];
  const img = li.children.flatMap(c => c.children).find(c => c.tagName === 'IMG');
  assert.ok(img, 'el emote tiene que salir como imagen');
  assert.equal(img.getAttribute('alt') ?? img.alt, 'Kappa',
    'si el corte estuviera en unidades UTF-16, aca diria "Kapp" o " Kapp"');
  assert.match(li.textContent, /👋hola/);
  assert.match(li.textContent, /como va/);

  p.cerrar();
});

test('las insignias se cortan en cuatro y el resto se cuenta', async () => {
  const p = abrir();
  await asentarse();
  p.llega(mensaje({
    id: 'i',
    insignias: [1, 2, 3, 4, 5, 6].map(n => ({ tipo: 't' + n, texto: 'ins' + n })),
  }));

  const fila = p.el('lista-mezclada').children[0].children[0];
  const chips = fila.children.filter(c => c.classList.contains('chip-insignia'));
  assert.equal(chips.length, 5, 'cuatro insignias y el "+N"');
  assert.equal(chips.at(-1).textContent, '+2');

  p.cerrar();
});

/* ---------------------------------------------------------- la salud */

test('la salud pintada en pantalla sale de /api/chat/salud', async () => {
  const p = abrir({
    salud: {
      kick: { vinculado: true, ultima: null, suscripcion: 'activa', vivo: false, sospechoso: false },
      twitch: { vinculado: true, ultima: null, estado: 'conectado', modo: 'irc' },
      ahora: new Date().toISOString(),
    },
  });
  await asentarse();

  assert.match(p.el('texto-kick').textContent, /sin mensajes todavía/);
  assert.match(p.el('texto-twitch').textContent, /plan B/,
    'si el chat viene por el plan B tiene que verse, no ser un detalle interno');
  assert.equal(p.el('puntito-twitch').className, 'puntito bien');

  p.cerrar();
});

test('sin sesion de dueño se avisa y no se puede escribir', async () => {
  const p = abrir({
    respuestas: { '/api/chat/salud': async () => ({ ok: false, status: 401, json: async () => ({}) }) },
  });
  await asentarse();

  assert.equal(p.el('banda-sesion').hidden, false);
  assert.equal(p.el('campo-texto').disabled, true);
  assert.equal(p.el('boton-enviar').disabled, true);
  assert.equal(p.el('select-destino').disabled, true);

  p.cerrar();
});

/* ------------------------------- el aviso de resuscribir (F6 y D1) */

test('la banda de resuscribir sale del veredicto del servidor', async () => {
  /* La regla vive en el servidor. Antes la pagina la recalculaba con
     otra: pedia que hubiera llegado al menos un mensaje. O sea que en
     el caso que motiva el aviso —canal en vivo y ni un webhook en la
     vida, con la URL sin cargar en el portal de Kick— la banda no
     aparecia nunca. */
  const p = abrir({
    salud: {
      kick: { vinculado: true, ultima: null, suscripcion: 'activa', vivo: true, sospechoso: true },
      twitch: { vinculado: false, ultima: null, estado: 'cortado', modo: 'ninguno' },
      ahora: new Date().toISOString(),
    },
  });
  await asentarse();

  assert.equal(p.el('banda-resuscribir').hidden, false,
    'en vivo y sin un solo mensaje: el aviso tiene que estar');

  p.cerrar();
});

/* La salud se vuelve a pedir cada 15 segundos. Los tests de la banda
   adelantan ese reloj con timers de mentira en vez de esperar: lo que
   importa es que la pagina pida de nuevo y decida de nuevo, no cuanto
   tarda el reloj de pared. */
const CADA_SALUD = 15000;

function abrirConSaludCambiante(estadoInicial) {
  const caso = { sospechoso: estadoInicial };
  const p = abrir({
    respuestas: {
      '/api/chat/salud': async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          kick: { vinculado: true, ultima: null, suscripcion: 'activa', vivo: true, sospechoso: caso.sospechoso },
          twitch: { vinculado: true, ultima: null, estado: 'conectado', modo: 'eventsub' },
          ahora: new Date().toISOString(),
        }),
      }),
    },
  });
  return { p, caso };
}

test('el aviso se puede cerrar, y se queda cerrado mientras la condicion siga', async (t) => {
  /* Canal en vivo de madrugada y nadie hablando: la condicion se
     cumple toda la noche y la banda roja no se podia sacar. */
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { p } = abrirConSaludCambiante(true);
  await asentarse();

  const banda = p.el('banda-resuscribir');
  assert.equal(banda.hidden, false);

  p.el('boton-cerrar-resuscribir').disparar('click');
  assert.equal(banda.hidden, true, 'cerrar tiene que cerrar');

  /* llega otra salud igual de fea, y otra, y otra */
  for (let i = 0; i < 4; i++) { t.mock.timers.tick(CADA_SALUD); await asentarse(); }
  assert.equal(banda.hidden, true, 'cerrado es cerrado: no vuelve solo cada quince segundos');

  p.cerrar();
});

test('si la condicion se resuelve y vuelve, el aviso vuelve: no se esconde para siempre', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { p, caso } = abrirConSaludCambiante(true);
  await asentarse();

  const banda = p.el('banda-resuscribir');
  p.el('boton-cerrar-resuscribir').disparar('click');
  assert.equal(banda.hidden, true);

  /* el chat vuelve a funcionar: la condicion se resuelve sola */
  caso.sospechoso = false;
  t.mock.timers.tick(CADA_SALUD);
  await asentarse();
  assert.equal(banda.hidden, true, 'sin condicion no hay aviso, obvio');

  /* y se vuelve a cortar: el aviso tiene que aparecer de nuevo */
  caso.sospechoso = true;
  t.mock.timers.tick(CADA_SALUD);
  await asentarse();
  assert.equal(banda.hidden, false,
    'cerrar silencia ESTE episodio, no todos los que vengan despues');

  p.cerrar();
});

test('el boton de resuscribir le pega al servidor y cuenta lo que paso', async () => {
  let llamado = 0;
  const p = abrir({
    salud: {
      kick: { vinculado: true, ultima: null, suscripcion: 'activa', vivo: true, sospechoso: true },
      twitch: { vinculado: true, ultima: null, estado: 'conectado', modo: 'eventsub' },
      ahora: new Date().toISOString(),
    },
    respuestas: {
      '/api/chat/resuscribir': async () => { llamado++; return { ok: true, status: 200, json: async () => ({ ok: true }) }; },
    },
  });
  await asentarse();

  p.el('boton-resuscribir').disparar('click');
  await asentarse();

  assert.equal(llamado, 1);
  assert.match(p.el('texto-resuscribir').textContent, /listo/);

  p.cerrar();
});

/* ------------------------------------------------- la caja de envio */

test('el contador de caracteres cuenta puntos de codigo y avisa cuando se pasa', async () => {
  const p = abrir();
  await asentarse();
  const campo = p.el('campo-texto');

  campo.value = '👨‍👩‍👦hola';
  campo.disparar('input');
  assert.equal(p.el('contador-caracteres').textContent, '9/500',
    'la familia son 5 puntos de codigo mas 4 letras');
  assert.equal(p.el('contador-caracteres').classList.contains('excedido'), false);

  campo.value = 'a'.repeat(501);
  campo.disparar('input');
  assert.equal(p.el('contador-caracteres').textContent, '501/500');
  assert.equal(p.el('contador-caracteres').classList.contains('excedido'), true);

  p.cerrar();
});

test('enviar manda texto y destino, y limpia la caja si salio', async () => {
  let recibido = null;
  const p = abrir({
    respuestas: {
      '/api/chat/enviar': async opciones => {
        recibido = JSON.parse(opciones.body);
        return { ok: true, status: 200, json: async () => ({ kick: { ok: true, motivo: '' } }) };
      },
    },
  });
  await asentarse();

  p.el('select-destino').value = 'ambos';
  p.el('campo-texto').value = 'hola gente';
  p.el('boton-enviar').disparar('click');
  await asentarse();

  assert.deepEqual(recibido, { texto: 'hola gente', destino: 'ambos' });
  assert.equal(p.el('campo-texto').value, '', 'la caja se limpia sola');
  assert.equal(p.el('aviso-envio').hidden, true);

  p.cerrar();
});

test('si salio en una red y fallo en la otra, se dice exactamente eso', async () => {
  /* Un "error" pelado haria que el dueño lo escriba de nuevo y quede
     repetido en la red donde SI habia salido. */
  const p = abrir({
    respuestas: {
      '/api/chat/enviar': async () => ({
        ok: true, status: 200,
        json: async () => ({ kick: { ok: true, motivo: '' }, twitch: { ok: false, motivo: 'token vencido' } }),
      }),
    },
  });
  await asentarse();

  p.el('campo-texto').value = 'hola';
  p.el('boton-enviar').disparar('click');
  await asentarse();

  assert.equal(p.el('aviso-envio').hidden, false);
  assert.match(p.el('texto-aviso-envio').textContent, /salió en Kick, falló en Twitch: token vencido/);

  p.el('boton-cerrar-aviso').disparar('click');
  assert.equal(p.el('aviso-envio').hidden, true);

  p.cerrar();
});

test('un 429 arranca la cuenta regresiva en vez de reintentar', async () => {
  /* La otra mitad del camino 429. Si la pagina reintentara sola,
     empeoraria el rate limit que la plataforma acaba de avisar. */
  let envios = 0;
  const p = abrir({
    respuestas: {
      '/api/chat/enviar': async () => {
        envios++;
        return {
          ok: false, status: 429,
          json: async () => ({ error: 'las plataformas estan frenando los envios', esperar: 3 }),
        };
      },
    },
  });
  await asentarse();

  p.el('campo-texto').value = 'hola';
  p.el('boton-enviar').disparar('click');
  await asentarse();

  assert.equal(p.el('boton-enviar').disabled, true, 'el boton queda trabado mientras se espera');
  assert.match(p.el('texto-aviso-envio').textContent, /esperá 3 segundos/);

  /* y mientras dura la espera, insistir no manda nada */
  p.el('boton-enviar').disparar('click');
  p.el('campo-texto').disparar('keydown', { key: 'Enter', shiftKey: false });
  await asentarse();
  assert.equal(envios, 1, 'no se reintenta solo');

  p.cerrar();
});

test('Enter manda y Shift+Enter no', async () => {
  let envios = 0;
  const p = abrir({
    respuestas: {
      '/api/chat/enviar': async () => { envios++; return { ok: true, status: 200, json: async () => ({ kick: { ok: true } }) }; },
    },
  });
  await asentarse();

  p.el('campo-texto').value = 'hola';
  p.el('campo-texto').disparar('keydown', { key: 'Enter', shiftKey: true });
  await asentarse();
  assert.equal(envios, 0, 'Shift+Enter es un salto de linea, no un envio');

  p.el('campo-texto').disparar('keydown', { key: 'Enter', shiftKey: false });
  await asentarse();
  assert.equal(envios, 1);

  p.cerrar();
});

test('el destino elegido se recuerda entre sesiones', async () => {
  const p = abrir();
  await asentarse();
  p.el('select-destino').value = 'twitch';
  p.el('select-destino').disparar('change');
  assert.equal(p.ventana.localStorage.getItem('sala-chat-destino'), 'twitch');
  p.cerrar();
});

/* --------------------------------------------------------- ?demo=1 */

test('con ?demo=1 la pagina se ve completa y no toca la red', async () => {
  /* Existe para poder diseñar sin backend, incluso abriendo el archivo
     con file://. Si tocara la red no serviria para eso. */
  const p = abrir({ busqueda: '?demo=1' });
  await asentarse();

  assert.equal(p.pedidos.length, 0, 'ni un solo fetch');
  assert.equal(p.conectadoAlBus, false, 'ni SSE');
  assert.ok(p.el('lista-mezclada').children.length >= 5, 'y la pantalla llena de mensajes');
  assert.ok(p.el('lista-kick').children.length >= 1);
  assert.ok(p.el('lista-twitch').children.length >= 1);
  assert.match(p.el('texto-kick').textContent, /Kick/);
  assert.equal(p.el('banda-resuscribir').hidden, false,
    'la demo tiene que poder mostrar el aviso: es parte de lo que hay que diseñar');

  p.cerrar();
});

test('en demo, escribir no manda nada a ningun lado', async () => {
  const p = abrir({ busqueda: '?demo=1' });
  await asentarse();

  p.el('campo-texto').value = 'hola';
  p.el('boton-enviar').disparar('click');
  await asentarse();

  assert.equal(p.pedidos.length, 0);
  assert.match(p.el('texto-aviso-envio').textContent, /demo/);

  p.cerrar();
});

/* -------------------------------------------------------- el arranque */

test('sin ?canal, el slug sale de /api/estado y se abre el bus', async () => {
  const p = abrir();
  await asentarse();

  assert.ok(p.pedidos.some(x => x.url === '/api/estado'));
  assert.ok(p.pedidos.some(x => x.url === '/api/chat/salud'));
  assert.equal(p.conectadoAlBus, true);

  p.cerrar();
});

/* ================================= /chat/<slug>: el chat abierto (5.1) */

/* Los turnos de una promesa sin usar setTimeout: las pruebas que
   falsean setTimeout (la reconsulta de "cerrado" es cada 30 s) no
   pueden esperar con él. */
const turnos = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise(ok => setImmediate(ok)); };

const ABIERTO_LAS_DOS = { abierto: true, redes: ['kick', 'twitch'] };
const CERRADO = { abierto: false, redes: [] };

/* Lo que contesta /api/chat/<slug>/yo. Quien mira sin conectar nada es
   el caso por defecto: leer no pide login. */
const SIN_CONECTAR = { entrado: false, abierto: true, redes: ['kick', 'twitch'], conectadas: {}, puedeEscribir: [] };
const CON_KICK = {
  entrado: true, abierto: true, redes: ['kick', 'twitch'],
  conectadas: { kick: { nombre: 'unaespectadora' } }, puedeEscribir: ['kick'],
};
const CON_LAS_DOS = {
  entrado: true, abierto: true, redes: ['kick', 'twitch'],
  conectadas: { kick: { nombre: 'unaespectadora' }, twitch: { nombre: 'UnaEspectadora' } },
  puedeEscribir: ['kick', 'twitch'],
};

/**
 * La misma página, abierta en /chat/<slug>. El bus de mentira anota
 * cada conexión y deja ver si se cerró.
 */
function abrirPublico({ ruta = '/chat/ana', busqueda = '', abierto = ABIERTO_LAS_DOS, estado = 200,
                       yo = SIN_CONECTAR } = {}) {
  const pedidos = [];
  const conexiones = [];
  let respuesta = { estado, datos: abierto };
  let quienSoy = yo;
  /* Lo que contesta /enviar. Por defecto, salio en todo lo que se pidio. */
  let respuestaEnvio = { estado: 200, datos: { ok: true } };

  const responder = async (url, opciones = {}) => {
    const r = String(url);
    pedidos.push({ url: r, opciones });
    if (/^\/api\/chat\/[^/]+\/abierto$/.test(r)) {
      const { estado: s, datos } = respuesta;
      return { ok: s === 200, status: s, json: async () => datos };
    }
    if (/^\/api\/chat\/[^/]+\/yo$/.test(r)) {
      return { ok: true, status: 200, json: async () => quienSoy };
    }
    if (/^\/api\/chat\/[^/]+\/enviar$/.test(r)) {
      const { estado: s, datos } = respuestaEnvio;
      return { ok: s === 200, status: s, json: async () => datos };
    }
    if (r === '/api/espectador/salir') {
      quienSoy = SIN_CONECTAR;
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };

  const pagina = abrirPagina({
    ruta,
    busqueda,
    antes: ['comun/mensajes.js'],
    fetch: responder,
    Sala: {
      conectar: (slug, fn) => {
        const c = { slug, fn, cerrada: false, cerrar() { this.cerrada = true; } };
        conexiones.push(c);
        return c;
      },
    },
  });

  return {
    ...pagina,
    pedidos,
    conexiones,
    /** algo que llega por la ultima conexion abierta */
    llega: (tipo, datos) => conexiones.at(-1)?.fn(tipo, datos),
    /** lo que va a contestar /abierto la proxima vez */
    contestar: (datos, s = 200) => { respuesta = { estado: s, datos }; },
    /** lo que va a contestar /yo la proxima vez */
    contestarYo: datos => { quienSoy = datos; },
    /** lo que va a contestar /enviar la proxima vez */
    contestarEnvio: (datos, s = 200) => { respuestaEnvio = { estado: s, datos }; },
    /** el ultimo POST a /enviar, ya parseado */
    ultimoEnvio() {
      const p = pedidos.filter(x => /\/enviar$/.test(x.url)).at(-1);
      return p ? { url: p.url, cuerpo: JSON.parse(p.opciones.body) } : null;
    },
    consultasAbierto: () => pedidos.filter(x => /\/abierto$/.test(x.url)).length,
  };
}

test('/chat/<slug> abierto: Kick y Twitch mezclados, y sin la salud del creador', async () => {
  const p = abrirPublico();
  await asentarse();

  assert.ok(p.pedidos.some(x => x.url === '/api/chat/ana/abierto'));
  assert.ok(!p.pedidos.some(x => x.url === '/api/chat/salud' || x.url === '/api/estado'),
    'la salud y /api/estado son de la ventana del creador');
  assert.equal(p.conexiones.length, 1);
  assert.equal(p.conexiones[0].slug, 'ana');

  p.llega('chat', mensaje({ id: 'k1', red: 'kick', texto: 'desde kick' }));
  p.llega('chat', mensaje({ id: 't1', red: 'twitch', usuario: 'purple', texto: 'desde twitch' }));
  assert.equal(p.el('lista-mezclada').children.length, 2, 'las dos redes, juntas, por defecto');
  assert.equal(p.el('lista-mezclada').dataset.filtro, 'todas');
  assert.equal(p.el('columna-mezclada').hidden, false, 'la vista por defecto es la mezclada');

  assert.equal(p.el('caja-escritura').hidden, true, 'sin ninguna red conectada no hay con qué escribir');
  assert.equal(p.el('barra-salud').hidden, true);
  assert.equal(p.el('banda-sesion').hidden, true);
  assert.equal(p.el('pantalla-cerrado').hidden, true);
  assert.equal(p.el('titulo-chat').hidden, false);
  assert.match(p.el('titulo-chat').textContent, /ana/);

  /* Y lo de /chat se reusa tal cual: vista, letra y pausa del scroll. */
  p.el('boton-vista').disparar('click');
  assert.equal(p.el('columna-kick').hidden, false);
  assert.equal(p.el('columna-twitch').hidden, false);
  p.cerrar();
});

test('en /chat/<slug> el slug sale del camino: ?canal= no lo cambia', async () => {
  const p = abrirPublico({ busqueda: '?canal=istincho' });
  await asentarse();
  assert.equal(p.conexiones[0].slug, 'ana');
  assert.ok(!p.pedidos.some(x => x.url.includes('istincho')));
  p.cerrar();
});

test('cerrado: lo dice y NO se conecta al bus', async () => {
  const p = abrirPublico({ abierto: CERRADO });
  await asentarse();

  assert.equal(p.el('pantalla-cerrado').hidden, false);
  assert.match(p.el('titulo-cerrado').textContent, /cerrado/i);
  assert.equal(p.el('area-mensajes').hidden, true);
  assert.equal(p.conexiones.length, 0,
    'escuchar el bus con el chat cerrado cuenta como alguien mirando y trae el Kick de la sala');
  p.cerrar();
});

test('una sala que no existe (o que se dio de baja) lo dice', async () => {
  const p = abrirPublico({ estado: 404, abierto: { error: 'esa sala no existe' } });
  await asentarse();
  assert.equal(p.el('pantalla-cerrado').hidden, false);
  assert.match(p.el('titulo-cerrado').textContent, /no existe/);
  assert.equal(p.conexiones.length, 0);
  p.cerrar();
});

test('si el creador lo cierra con la página abierta, se corta el bus y se ve cerrado', async () => {
  const p = abrirPublico();
  await asentarse();
  p.llega('chat', mensaje({ id: 'k1', red: 'kick' }));

  p.llega('chat-abierto', { tipo: 'chat-abierto', abierto: false, redes: [] });

  assert.equal(p.conexiones[0].cerrada, true, 'la conexión se tiene que cerrar');
  assert.equal(p.el('pantalla-cerrado').hidden, false);
  assert.equal(p.el('area-mensajes').hidden, true);
  p.cerrar();
});

test('cerrado se vuelve a fijar solo, y cuando lo abren aparece sin recargar', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const p = abrirPublico({ abierto: CERRADO });
  await turnos();
  assert.equal(p.consultasAbierto(), 1);
  assert.equal(p.conexiones.length, 0);

  /* Todavía cerrado a los 30 s: vuelve a preguntar y sigue esperando. */
  t.mock.timers.tick(30_000);
  await turnos();
  assert.equal(p.consultasAbierto(), 2);
  assert.equal(p.conexiones.length, 0);

  /* El creador lo abre. */
  p.contestar(ABIERTO_LAS_DOS);
  t.mock.timers.tick(30_000);
  await turnos();
  assert.equal(p.el('pantalla-cerrado').hidden, true);
  assert.equal(p.el('area-mensajes').hidden, false);
  assert.equal(p.conexiones.length, 1, 'y recién ahí se conecta al bus');
  p.cerrar();
});

test('al reabrir no se repite lo que ya estaba: el servidor lo manda de nuevo', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const p = abrirPublico();
  await turnos();
  p.llega('chat', mensaje({ id: 'k1', red: 'kick', texto: 'de antes' }));
  assert.equal(p.el('lista-mezclada').children.length, 1);

  p.contestar(CERRADO);
  p.llega('chat-abierto', { abierto: false, redes: [] });
  p.contestar(ABIERTO_LAS_DOS);
  t.mock.timers.tick(30_000);
  await turnos();

  assert.equal(p.conexiones.length, 2);
  assert.equal(p.el('lista-mezclada').children.length, 0,
    'cada conexión nueva recibe los últimos mensajes: si quedaban los viejos, salían dos veces');
  p.llega('chat', mensaje({ id: 'k1', red: 'kick', texto: 'de antes' }));
  assert.equal(p.el('lista-mezclada').children.length, 1);
  p.cerrar();
});

test('con una sola red compartida no hay filtro que elegir, y lo de la otra se esconde', async () => {
  const p = abrirPublico({ abierto: { abierto: true, redes: ['kick'] } });
  await asentarse();

  assert.equal(p.el('boton-filtro').hidden, true);
  assert.equal(p.el('lista-mezclada').dataset.filtro, 'kick');

  /* El creador suma Twitch con la página abierta: vuelve el filtro. */
  p.llega('chat-abierto', { abierto: true, redes: ['kick', 'twitch'] });
  assert.equal(p.el('boton-filtro').hidden, false);
  assert.equal(p.el('lista-mezclada').dataset.filtro, 'todas');
  assert.equal(p.conexiones.length, 1, 'sin reconectar');

  /* Y se lo saca: lo que ya había llegado de Twitch se esconde con el
     mismo CSS del filtro, sin borrarse. */
  p.llega('chat', mensaje({ id: 't1', red: 'twitch' }));
  p.llega('chat-abierto', { abierto: true, redes: ['kick'] });
  assert.equal(p.el('lista-mezclada').dataset.filtro, 'kick');
  assert.equal(p.el('lista-mezclada').children.length, 1);
  p.cerrar();
});

test('después de un corte del bus vuelve a preguntar si sigue abierto', async () => {
  /* Si el creador lo cerró mientras esta pestaña no escuchaba, el aviso
     por el bus se perdió. El estado llega con cada conexión: el primero
     no dice nada nuevo, los siguientes son una reconexión. */
  const p = abrirPublico();
  await asentarse();
  const antes = p.consultasAbierto();

  p.llega('estado', { tipo: 'estado', conectados: 1 });
  await asentarse();
  assert.equal(p.consultasAbierto(), antes, 'el primer estado no vuelve a preguntar');

  p.contestar(CERRADO);
  p.llega('estado', { tipo: 'estado', conectados: 1 });
  await asentarse();
  assert.equal(p.consultasAbierto(), antes + 1);
  assert.equal(p.el('pantalla-cerrado').hidden, false);
  p.cerrar();
});

test('?demo=1 en /chat/<slug> no toca la red ni muestra la salud del creador', async () => {
  const p = abrirPublico({ busqueda: '?demo=1' });
  await asentarse();
  assert.equal(p.pedidos.length, 0);
  assert.equal(p.conexiones.length, 0);
  assert.ok(p.el('lista-mezclada').children.length >= 5);
  assert.equal(p.el('banda-resuscribir').hidden, true);
  assert.equal(p.el('caja-escritura').hidden, true);
  p.cerrar();
});

/* ============ /chat/<slug>: escribir con la cuenta de cada uno ============ */

test('sin conectar nada: los dos botones, y ninguna caja de escribir', async () => {
  const p = abrirPublico();
  await asentarse();

  assert.equal(p.el('barra-conectar').hidden, false);
  assert.equal(p.el('conectar-kick').hidden, false);
  assert.equal(p.el('conectar-twitch').hidden, false);
  assert.equal(p.el('boton-salir').hidden, true, 'no hay de dónde salir');
  assert.equal(p.el('caja-escritura').hidden, true, 'leer no pide login, escribir sí');

  /* El login vuelve a ESTE chat, y con el rol de espectador: con otro
     rol pediría permisos de creador. */
  const kick = p.el('conectar-kick').getAttribute('href');
  assert.match(kick, /^\/oauth\/kick\/entrar\?rol=espectador&destino=%2Fchat%2Fana$/);
  assert.match(p.el('conectar-twitch').getAttribute('href'),
    /^\/oauth\/twitch\/entrar\?rol=espectador&destino=%2Fchat%2Fana$/);
  p.cerrar();
});

test('con una sola red conectada no hay selector, y dice con qué cuenta escribís', async () => {
  const p = abrirPublico({ yo: CON_KICK });
  await asentarse();

  assert.equal(p.el('caja-escritura').hidden, false);
  assert.equal(p.el('select-destino').hidden, true, 'con una sola red no hay nada que elegir');
  assert.equal(p.el('select-destino').value, 'kick');
  assert.equal(p.el('conectar-kick').hidden, true, 'ya la conectó');
  assert.equal(p.el('conectar-twitch').hidden, false, 'la otra sigue ofrecida');
  assert.equal(p.el('boton-salir').hidden, false);
  assert.match(p.el('texto-conectar').textContent, /unaespectadora/);
  p.cerrar();
});

test('con las dos conectadas aparece "las dos", y es UN solo envío', async () => {
  const p = abrirPublico({ yo: CON_LAS_DOS });
  await asentarse();

  const opciones = p.el('select-destino').children.map(o => o.getAttribute('value'));
  assert.deepEqual(opciones, ['kick', 'twitch', 'ambas']);
  assert.equal(p.el('select-destino').hidden, false);
  assert.equal(p.el('conectar-kick').hidden, true);
  assert.equal(p.el('conectar-twitch').hidden, true);

  p.el('select-destino').value = 'ambas';
  p.el('campo-texto').value = 'hola a las dos';
  p.el('boton-enviar').disparar('click');
  await asentarse();

  const envio = p.ultimoEnvio();
  assert.equal(envio.url, '/api/chat/ana/enviar');
  assert.deepEqual(envio.cuerpo, { red: 'ambas', texto: 'hola a las dos' },
    'un pedido solo: el servidor lo manda a las dos y cuenta como uno');
  assert.equal(p.el('campo-texto').value, '', 'salió: se limpia la caja');
  p.cerrar();
});

test('la red que el creador NO abrió no se ofrece ni para conectar', async () => {
  const p = abrirPublico({
    abierto: { abierto: true, redes: ['kick'] },
    yo: { entrado: false, abierto: true, redes: ['kick'], conectadas: {}, puedeEscribir: [] },
  });
  await asentarse();

  assert.equal(p.el('conectar-kick').hidden, false);
  assert.equal(p.el('conectar-twitch').hidden, true,
    'pedirle a alguien permisos de una red que este chat no usa sería pedir de más');
  p.cerrar();
});

test('tener Twitch conectado no alcanza si el creador no lo abrió', async () => {
  const p = abrirPublico({
    abierto: { abierto: true, redes: ['kick'] },
    yo: {
      entrado: true, abierto: true, redes: ['kick'],
      conectadas: { kick: { nombre: 'una' }, twitch: { nombre: 'Una' } },
      puedeEscribir: ['kick'],
    },
  });
  await asentarse();

  assert.deepEqual(p.el('select-destino').children.map(o => o.getAttribute('value')), ['kick'],
    'sin "las dos": a Twitch no se puede escribir acá');
  p.cerrar();
});

test('salió en una y falló en la otra: se dice cuál y por qué', async () => {
  const p = abrirPublico({ yo: CON_LAS_DOS });
  await asentarse();

  p.contestarEnvio({
    ok: true,
    kick: { ok: true, motivo: '' },
    twitch: { ok: false, motivo: 'el AutoMod lo retuvo' },
  });
  p.el('campo-texto').value = 'algo';
  p.el('boton-enviar').disparar('click');
  await asentarse();

  const aviso = p.el('texto-aviso-envio').textContent;
  assert.match(aviso, /Kick/);
  assert.match(aviso, /el AutoMod lo retuvo/, 'el motivo de Twitch, tal cual');
  assert.equal(p.el('aviso-envio').hidden, false);
  p.cerrar();
});

test('un 403 pone la pantalla al día: el creador cerró el chat mientras tanto', async () => {
  const p = abrirPublico({ yo: CON_KICK });
  await asentarse();
  const antes = p.consultasAbierto();

  p.contestarEnvio({ error: 'este chat esta cerrado' }, 403);
  p.contestar(CERRADO);
  p.contestarYo({ entrado: true, abierto: false, redes: [], conectadas: { kick: { nombre: 'una' } }, puedeEscribir: [] });
  p.el('campo-texto').value = 'tarde';
  p.el('boton-enviar').disparar('click');
  await asentarse();

  assert.match(p.el('texto-aviso-envio').textContent, /cerrado/);
  assert.ok(p.consultasAbierto() > antes, 'vuelve a preguntar en vez de quedarse con la pantalla vieja');
  assert.equal(p.el('caja-escritura').hidden, true);
  assert.equal(p.el('pantalla-cerrado').hidden, false);
  p.cerrar();
});

test('con el chat cerrado no hay barra de conectar ni caja', async () => {
  const p = abrirPublico({ abierto: CERRADO, yo: CON_LAS_DOS });
  await asentarse();

  assert.equal(p.el('barra-conectar').hidden, true);
  assert.equal(p.el('caja-escritura').hidden, true);
  assert.ok(!p.pedidos.some(x => /\/yo$/.test(x.url)), 'de un chat cerrado no se pregunta nada más');
  p.cerrar();
});

test('salir vuelve a dejar la página como la de cualquiera que mira', async () => {
  const p = abrirPublico({ yo: CON_LAS_DOS });
  await asentarse();
  assert.equal(p.el('caja-escritura').hidden, false);

  p.el('boton-salir').disparar('click');
  await asentarse();

  assert.ok(p.pedidos.some(x => x.url === '/api/espectador/salir' && x.opciones.method === 'POST'));
  assert.equal(p.el('caja-escritura').hidden, true);
  assert.equal(p.el('boton-salir').hidden, true);
  assert.equal(p.el('conectar-kick').hidden, false, 'y se puede volver a entrar');
  p.cerrar();
});

test('una red que perdió el permiso se vuelve a ofrecer sola', async () => {
  const p = abrirPublico({ yo: CON_LAS_DOS });
  await asentarse();

  /* El servidor la desconectó al recibir un 401 de Twitch: avisa con
     `reconectar` y la página vuelve a preguntar qué le quedó. */
  p.contestarEnvio({ ok: true, reconectar: ['twitch'], kick: { ok: true, motivo: '' },
    twitch: { ok: false, motivo: 'Twitch rechazo tu permiso' } });
  p.contestarYo(CON_KICK);
  p.el('campo-texto').value = 'chau twitch';
  p.el('boton-enviar').disparar('click');
  await asentarse();

  assert.equal(p.el('conectar-twitch').hidden, false, 'el botón vuelve');
  assert.deepEqual(p.el('select-destino').children.map(o => o.getAttribute('value')), ['kick']);
  p.cerrar();
});

test('/chat a secas sigue siendo la ventana del creador', async () => {
  const p = abrir();
  await asentarse();
  assert.equal(p.el('caja-escritura').hidden, false);
  assert.equal(p.el('barra-salud').hidden, false);
  assert.equal(p.el('titulo-chat').hidden, true);
  assert.equal(p.el('boton-filtro').hidden, false);
  assert.ok(!p.pedidos.some(x => /\/abierto$/.test(x.url)));
  p.cerrar();
});
