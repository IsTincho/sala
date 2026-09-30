/* ============================================================
   El selector de emotes de las DOS cajas —`/chat/<slug>`, la del
   espectador, y `/chat`, la del creador— corrido de verdad sobre
   `paginas/chat/chat.js` y `paginas/chat.html` reales, en el DOM de
   mentira de `fijos/dom-falso.js`.

   Va en su propio archivo y no adentro de `pagina-chat.test.js`
   porque aquel ya tiene mil renglones de otra cosa; lo que se prueba
   acá es una pieza sola.

   Lo que se prueba es lo que se rompe callado:

     - LA PÁGINA NO ARMA MARKUP DE NINGUNA PLATAFORMA. Inserta la
       `marca` que le dio el servidor, tal cual. Si alguien la hace
       "ayudar" armando `[emote:...]` por su cuenta, se vuelve a la
       situación que este trabajo vino a arreglar;
     - el emote se inserta con espacios alrededor: se resuelven por
       PALABRA ENTERA, y pegado a una letra deja de ser un emote;
     - el aviso de "esto en Twitch sale como texto" aparece ANTES de
       mandar, y también cuando el cambio es del selector de red y no
       de lo que se escribió;
     - el panel se llena la PRIMERA VEZ QUE SE ABRE: quien no lo usa
       no gasta un pedido;
     - buscar filtra por nombre, y las flechas y Escape sirven sin
       mouse;
     - con el chat cerrado, o sin cuenta, el botón no está;
     - en `/chat` la lista sale de la ruta SIN slug, y el botón está con
       la página: esa caja siempre puede escribir.
   ============================================================ */

import test from 'node:test';
import assert from 'node:assert/strict';

import { abrirPagina } from './fijos/dom-falso.js';

const esperar = ms => new Promise(ok => setTimeout(ok, ms));
const asentarse = () => esperar(10);

const ABIERTO_LAS_DOS = { abierto: true, redes: ['kick', 'twitch'] };
const CERRADO = { abierto: false, redes: [] };

const SIN_CONECTAR = { entrado: false, abierto: true, redes: ['kick', 'twitch'], conectadas: {}, puedeEscribir: [] };
const CON_LAS_DOS = {
  entrado: true, abierto: true, redes: ['kick', 'twitch'],
  conectadas: { kick: { nombre: 'unaespectadora' }, twitch: { nombre: 'UnaEspectadora' } },
  puedeEscribir: ['kick', 'twitch'],
};
const CON_KICK = {
  entrado: true, abierto: true, redes: ['kick', 'twitch'],
  conectadas: { kick: { nombre: 'unaespectadora' } }, puedeEscribir: ['kick'],
};

/* La marca de un emote nativo de Kick es el markup de Kick, con su
   id: es lo que kick.com pone en el `content` y lo único que Kick
   dibuja. La página lo recibe ya armado y no lo mira por dentro. */
const MARCA_KICK = '[emote:5747892:collectiblesMEGALUL]';

const EMOTES = [
  {
    nombre: 'collectiblesMEGALUL', fuente: 'kick', marca: MARCA_KICK,
    url: 'https://files.kick.com/emotes/5747892/fullsize', redes: ['kick'],
  },
  {
    nombre: 'CHAD', fuente: '7tv', marca: 'CHAD',
    url: 'https://cdn.7tv.app/emote/01CHAD/2x.webp', redes: ['kick', 'twitch'],
  },
  {
    nombre: 'KEKW', fuente: '7tv', marca: 'KEKW',
    url: 'https://cdn.7tv.app/emote/01KEKW/2x.webp', redes: ['kick', 'twitch'],
  },
];

/* Un nativo de Twitch: existe solo alla, igual que el de Kick existe
   solo en Kick, y viaja como su nombre pelado. */
const EMOTE_TWITCH = {
  nombre: 'anaLOVE', fuente: 'twitch', marca: 'anaLOVE',
  url: 'https://static-cdn.jtvnw.net/emoticons/v2/emotesv2_ana/default/dark/2.0',
  redes: ['twitch'],
};

/** Todos los botones de emote que hay pintados ahora, en orden. */
function opciones(p) {
  const salida = [];
  (function recorrer(nodo) {
    for (const h of nodo.children ?? []) {
      if (h.classList?.contains('opcion-emote')) salida.push(h);
      recorrer(h);
    }
  })(p.el('rejilla-emotes'));
  return salida;
}

const nombres = p => opciones(p).map(b => b.dataset.nombre);

/**
 * `/chat/<slug>` con su `/emotes` de mentira.
 *
 * Por defecto la persona tiene las dos redes conectadas: sin cuenta
 * no hay caja de escribir y el selector vive adentro de la caja.
 */
function abrirPublico({ yo = CON_LAS_DOS, abierto = ABIERTO_LAS_DOS, emotes = EMOTES, localStorage = null } = {}) {
  const pedidos = [];
  let respuestaAbierto = abierto;
  let quienSoy = yo;
  let listaEmotes = emotes;
  let respuestaEnvio = { estado: 200, datos: { ok: true, kick: { ok: true }, twitch: { ok: true } } };

  const responder = async (url, opciones = {}) => {
    const r = String(url);
    pedidos.push({ url: r, opciones });
    if (/^\/api\/chat\/[^/]+\/abierto$/.test(r)) {
      return { ok: true, status: 200, json: async () => respuestaAbierto };
    }
    if (/^\/api\/chat\/[^/]+\/yo$/.test(r)) {
      return { ok: true, status: 200, json: async () => quienSoy };
    }
    if (/^\/api\/chat\/[^/]+\/emotes$/.test(r)) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ abierto: true, redes: ['kick', 'twitch'], emotes: listaEmotes }),
      };
    }
    if (/^\/api\/chat\/[^/]+\/enviar$/.test(r)) {
      const { estado, datos } = respuestaEnvio;
      return { ok: estado === 200, status: estado, json: async () => datos };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };

  const conexiones = [];
  const pagina = abrirPagina({
    ruta: '/chat/ana',
    antes: ['comun/mensajes.js'],
    fetch: responder,
    /* Para probar lo que sobrevive a recargar la pagina: dos paginas
       con el mismo almacen son el mismo navegador. */
    globales: localStorage ? { localStorage } : {},
    Sala: {
      conectar: (slug, fn) => {
        const c = { slug, fn, cerrar() {} };
        conexiones.push(c);
        return c;
      },
    },
  });

  return {
    ...pagina,
    pedidos,
    /* Un aviso por el bus, que es como se entera la página de que el
       creador cambió algo. Dispara `aplicarAbierto`, y con él una
       reconsulta de /yo. */
    llegaPorElBus: (tipo, datos) => conexiones.at(-1)?.fn(tipo, datos),
    contestar: datos => { respuestaAbierto = datos; },
    contestarYo: datos => { quienSoy = datos; },
    contestarEmotes: lista => { listaEmotes = lista; },
    consultasEmotes: () => pedidos.filter(x => /\/emotes$/.test(x.url)).length,
    ultimoEnvio() {
      const p = pedidos.filter(x => /\/enviar$/.test(x.url)).at(-1);
      return p ? JSON.parse(p.opciones.body) : null;
    },
    /** Abre el panel y espera a que llegue la lista. */
    async abrirEmotes() {
      this.el('boton-emotes').disparar('click');
      await asentarse();
    },
    /** Toca un emote por su nombre, como haría un dedo. */
    elegir(nombre) {
      const boton = opciones(this).find(b => b.dataset.nombre === nombre);
      if (!boton) throw new Error(`no hay ningún emote "${nombre}" en el panel`);
      this.el('rejilla-emotes').disparar('click', { target: boton });
    },
  };
}

/* ================================== el botón y cuándo aparece */

test('el botón de emotes aparece con la caja, y no antes', async () => {
  /* Sin cuenta no hay caja: escribir pide cuenta y el selector es un
     atajo para escribir. La LISTA, en cambio, no pide sesión (eso se
     prueba del lado del servidor). */
  const p = abrirPublico({ yo: SIN_CONECTAR });
  await asentarse();
  assert.equal(p.el('caja-escritura').hidden, true);
  assert.equal(p.el('boton-emotes').hidden, true);
  assert.equal(p.consultasEmotes(), 0, 'y sin caja no se pide la lista de nada');

  p.cerrar();
});

test('cuando la persona pasa a poder escribir, el botón aparece sin recargar', async () => {
  const p = abrirPublico({ yo: SIN_CONECTAR });
  await asentarse();
  assert.equal(p.el('boton-emotes').hidden, true);

  /* El creador toca algo y avisa por el bus: la página vuelve a
     preguntar /yo, que ahora dice que sí. */
  p.contestarYo(CON_LAS_DOS);
  p.llegaPorElBus('chat-abierto', ABIERTO_LAS_DOS);
  await asentarse();

  assert.equal(p.el('caja-escritura').hidden, false);
  assert.equal(p.el('boton-emotes').hidden, false);

  p.cerrar();
});

test('si deja de poder escribir, el botón se va y el panel se cierra', async () => {
  const p = abrirPublico();
  await asentarse();
  await p.abrirEmotes();
  assert.equal(p.el('panel-emotes').hidden, false);

  /* El creador lo bloquea, o le saca la red que tenía. */
  p.contestarYo(SIN_CONECTAR);
  p.llegaPorElBus('chat-abierto', ABIERTO_LAS_DOS);
  await asentarse();

  assert.equal(p.el('boton-emotes').hidden, true);
  assert.equal(p.el('panel-emotes').hidden, true,
    'un panel abierto encima de una caja que ya no está sería un fantasma');

  p.cerrar();
});

test('con cuenta, el botón está y el panel arranca cerrado', async () => {
  const p = abrirPublico();
  await asentarse();

  assert.equal(p.el('caja-escritura').hidden, false);
  assert.equal(p.el('boton-emotes').hidden, false);
  assert.equal(p.el('panel-emotes').hidden, true);
  assert.equal(p.el('boton-emotes').getAttribute('aria-expanded'), 'false');

  /* Y NADIE PIDIÓ LA LISTA TODAVÍA: quien no usa el selector no le
     cuesta un pedido al servidor ni una bajada a 7TV. */
  assert.equal(p.consultasEmotes(), 0);

  p.cerrar();
});

test('con el chat cerrado no hay botón de emotes', async () => {
  const p = abrirPublico({ abierto: CERRADO });
  await asentarse();
  assert.equal(p.el('boton-emotes').hidden, true);
  assert.equal(p.el('panel-emotes').hidden, true);
  p.cerrar();
});

/* ====================================== abrir, buscar, elegir */

test('el panel se llena la primera vez que se abre', async () => {
  const p = abrirPublico();
  await asentarse();

  await p.abrirEmotes();

  assert.equal(p.el('panel-emotes').hidden, false);
  assert.equal(p.el('boton-emotes').getAttribute('aria-expanded'), 'true');
  assert.equal(p.consultasEmotes(), 1);
  assert.deepEqual(nombres(p), ['collectiblesMEGALUL', 'CHAD', 'KEKW'],
    'los de Kick primero: son los que no se consiguen en ningún otro lado');

  /* Y no se vuelve a pedir por abrir y cerrar. */
  p.el('boton-emotes').disparar('click');
  await p.abrirEmotes();
  assert.equal(p.consultasEmotes(), 1);

  p.cerrar();
});

test('cada emote dice de qué fuente es y en qué red sale', async () => {
  const p = abrirPublico();
  await asentarse();
  /* Con "las dos": es ahí donde un emote de Kick tiene algo que
     admitir. Con Kick sola no le falta nada y no dice de más. */
  p.el('select-destino').value = 'ambas';
  p.el('select-destino').disparar('change');
  await p.abrirEmotes();

  const [deKick, de7tv] = opciones(p);

  /* En palabras y no sólo con un borde: el color no puede ser el
     único canal de información. */
  assert.match(deKick.getAttribute('aria-label'), /collectiblesMEGALUL · Kick/);
  assert.match(deKick.getAttribute('aria-label'), /en Twitch se lee como texto/);
  assert.ok(deKick.className.includes('opcion-emote-parcial'));

  assert.match(de7tv.getAttribute('aria-label'), /CHAD · 7TV/);
  assert.match(de7tv.getAttribute('aria-label'), /sale en Kick y Twitch/);
  assert.equal(de7tv.className.includes('opcion-emote-parcial'), false);

  /* Y el panel admite lo que NO tiene, en vez de aparentar el
     catálogo completo. */
  assert.match(p.el('nota-emotes').textContent, /sólo los que ya pasaron por este chat/);
  assert.match(p.el('nota-emotes').textContent, /desbloqueados/,
    'y lo que no puede saber: quién tiene desbloqueado un emote de sub');

  p.cerrar();
});

test('el buscador filtra por nombre, sin distinguir mayúsculas', async () => {
  const p = abrirPublico();
  await asentarse();
  await p.abrirEmotes();

  p.el('buscar-emote').value = 'kek';
  p.el('buscar-emote').disparar('input');
  assert.deepEqual(nombres(p), ['KEKW']);

  p.el('buscar-emote').value = 'no existe nada asi';
  p.el('buscar-emote').disparar('input');
  assert.deepEqual(nombres(p), []);
  assert.match(p.el('rejilla-emotes').textContent, /Ningún emote se llama así/);

  p.cerrar();
});

test('elegir un emote inserta la MARCA DEL SERVIDOR, tal cual', async () => {
  /* EL CORAZÓN DE TODO ESTO: la página no arma markup de ninguna
     plataforma. Si algún día alguien la hace "ayudar" armando el
     `[emote:...]` por su cuenta, volvemos a que la caja sepa de redes
     y el mensaje salga mal en una de las dos. */
  const p = abrirPublico();
  await asentarse();
  await p.abrirEmotes();

  p.elegir('collectiblesMEGALUL');
  assert.equal(p.el('campo-texto').value, MARCA_KICK + ' ');

  p.elegir('CHAD');
  assert.equal(p.el('campo-texto').value, MARCA_KICK + ' CHAD ',
    'un emote de 7TV es su nombre pelado: no hay markup que armar');

  p.cerrar();
});

test('el emote entra separado del texto: se resuelve por palabra entera', async () => {
  const p = abrirPublico();
  await asentarse();
  await p.abrirEmotes();

  p.el('campo-texto').value = 'hola';
  p.el('campo-texto').disparar('input');
  p.elegir('CHAD');

  assert.equal(p.el('campo-texto').value, 'hola CHAD ',
    'pegado a la palabra anterior dejaría de ser un emote y sería "holaCHAD"');

  /* Y no se duplica el espacio si ya había uno. */
  p.elegir('KEKW');
  assert.equal(p.el('campo-texto').value, 'hola CHAD KEKW ');

  p.cerrar();
});

test('el panel no se cierra al elegir, y el buscador se vacía', async () => {
  /* Poner tres emotes seguidos es lo normal. */
  const p = abrirPublico();
  await asentarse();
  await p.abrirEmotes();

  p.el('buscar-emote').value = 'chad';
  p.el('buscar-emote').disparar('input');
  p.elegir('CHAD');

  assert.equal(p.el('panel-emotes').hidden, false);
  assert.equal(p.el('buscar-emote').value, '');
  assert.deepEqual(nombres(p), ['collectiblesMEGALUL', 'CHAD', 'KEKW'], 'la lista vuelve entera');

  p.cerrar();
});

test('el contador de caracteres cuenta la marca que va a viajar', async () => {
  const p = abrirPublico();
  await asentarse();
  await p.abrirEmotes();

  p.elegir('collectiblesMEGALUL');
  /* La marca entera más el espacio: es exactamente lo que recibe
     Kick, que es la red donde ese markup existe. Para Twitch es más
     corto, así que el contador nunca promete lugar que no hay. */
  assert.equal(p.el('contador-caracteres').textContent, `${MARCA_KICK.length + 1}/500`);

  p.cerrar();
});

/* ============================== el aviso de "acá sale como texto" */

test('avisa antes de mandar que un emote de Kick en Twitch sale como texto', async () => {
  const p = abrirPublico();
  await asentarse();
  await p.abrirEmotes();

  /* Con "las dos" elegidas (el valor por defecto con dos redes). */
  assert.equal(p.el('select-destino').value, 'kick');
  p.el('select-destino').value = 'ambas';
  p.el('select-destino').disparar('change');

  p.elegir('collectiblesMEGALUL');

  assert.equal(p.el('aviso-emotes').hidden, false);
  assert.match(p.el('aviso-emotes').textContent, /collectiblesMEGALUL es un emote de Kick/);
  assert.match(p.el('aviso-emotes').textContent, /en Twitch va a salir como texto/);

  p.cerrar();
});

test('el aviso aparece al CAMBIAR DE RED lo que ya estaba escrito', async () => {
  /* El caso fácil de olvidar: el emote se puso con "Kick" elegido, o
     sea sin problema, y el problema aparece después. */
  const p = abrirPublico();
  await asentarse();
  await p.abrirEmotes();

  p.elegir('collectiblesMEGALUL');
  assert.equal(p.el('aviso-emotes').hidden, true, 'a Kick sola no hay nada que avisar');

  p.el('select-destino').value = 'ambas';
  p.el('select-destino').disparar('change');
  assert.equal(p.el('aviso-emotes').hidden, false);

  p.el('select-destino').value = 'kick';
  p.el('select-destino').disparar('change');
  assert.equal(p.el('aviso-emotes').hidden, true, 'y se va cuando deja de valer');

  p.cerrar();
});

test('un emote de 7TV no dispara ningún aviso: sale en las dos', async () => {
  const p = abrirPublico();
  await asentarse();
  p.el('select-destino').value = 'ambas';
  p.el('select-destino').disparar('change');
  await p.abrirEmotes();

  p.elegir('CHAD');
  assert.equal(p.el('aviso-emotes').hidden, true);

  p.cerrar();
});

test('el aviso se va cuando el mensaje sale', async () => {
  const p = abrirPublico();
  await asentarse();
  p.el('select-destino').value = 'ambas';
  p.el('select-destino').disparar('change');
  await p.abrirEmotes();
  p.elegir('collectiblesMEGALUL');
  assert.equal(p.el('aviso-emotes').hidden, false);

  p.el('boton-enviar').disparar('click');
  await asentarse();

  assert.equal(p.ultimoEnvio().texto, MARCA_KICK,
    'lo que viaja es la marca: traducirla por red es trabajo del servidor');
  assert.equal(p.el('campo-texto').value, '');
  assert.equal(p.el('aviso-emotes').hidden, true);

  p.cerrar();
});

/* ============================================ teclado y cierre */

test('las flechas recorren los emotes y Enter pone el que está marcado', async () => {
  const p = abrirPublico();
  await asentarse();
  await p.abrirEmotes();

  const buscador = p.el('buscar-emote');
  buscador.disparar('keydown', { key: 'ArrowDown' });
  assert.ok(opciones(p)[0].className.includes('opcion-emote-activa'));

  buscador.disparar('keydown', { key: 'ArrowDown' });
  assert.ok(opciones(p)[1].className.includes('opcion-emote-activa'), 'y avanza');

  buscador.disparar('keydown', { key: 'Enter' });
  assert.equal(p.el('campo-texto').value, 'CHAD ', 'el segundo, que es el que estaba marcado');

  p.cerrar();
});

test('Enter sin haber bajado pone el primero de la lista', async () => {
  const p = abrirPublico();
  await asentarse();
  await p.abrirEmotes();

  p.el('buscar-emote').value = 'kek';
  p.el('buscar-emote').disparar('input');
  p.el('buscar-emote').disparar('keydown', { key: 'Enter' });

  assert.equal(p.el('campo-texto').value, 'KEKW ');
  p.cerrar();
});

test('las flechas dan la vuelta y no se clavan en la punta', async () => {
  const p = abrirPublico();
  await asentarse();
  await p.abrirEmotes();

  p.el('buscar-emote').disparar('keydown', { key: 'ArrowUp' });
  assert.ok(opciones(p).at(-1).className.includes('opcion-emote-activa'),
    'para arriba desde la nada arranca por el último');

  p.cerrar();
});

test('Escape cierra el panel y devuelve el foco a la caja', async () => {
  /* Sin esto, quien no usa mouse queda parado en la nada. */
  const p = abrirPublico();
  await asentarse();
  await p.abrirEmotes();

  p.el('buscar-emote').disparar('keydown', { key: 'Escape' });

  assert.equal(p.el('panel-emotes').hidden, true);
  assert.equal(p.el('boton-emotes').getAttribute('aria-expanded'), 'false');
  assert.equal(p.documento.activeElement, p.el('campo-texto'));

  p.cerrar();
});

test('la × cierra el panel, y el botón lo vuelve a abrir', async () => {
  const p = abrirPublico();
  await asentarse();
  await p.abrirEmotes();

  p.el('cerrar-emotes').disparar('click');
  assert.equal(p.el('panel-emotes').hidden, true);

  p.el('boton-emotes').disparar('click');
  assert.equal(p.el('panel-emotes').hidden, false);

  p.cerrar();
});

/* ====================================== lo que se ofrece por red */

test('con Twitch elegida, un emote que sólo existe en Kick no se ofrece', async () => {
  const p = abrirPublico({ yo: CON_LAS_DOS });
  await asentarse();
  await p.abrirEmotes();

  p.el('select-destino').value = 'twitch';
  p.el('select-destino').disparar('change');

  assert.deepEqual(nombres(p), ['CHAD', 'KEKW'],
    'ofrecerlo sería empujar al error en vez de evitarlo');

  p.cerrar();
});

test('con "las dos" sí se ofrece, marcado: son los únicos que no se consiguen en otro lado', async () => {
  const p = abrirPublico();
  await asentarse();
  await p.abrirEmotes();

  p.el('select-destino').value = 'ambas';
  p.el('select-destino').disparar('change');

  assert.ok(nombres(p).includes('collectiblesMEGALUL'));
  assert.ok(opciones(p)[0].className.includes('opcion-emote-parcial'));

  p.cerrar();
});

test('con una sola red conectada, el selector de red no estorba y el panel anda igual', async () => {
  const p = abrirPublico({ yo: CON_KICK });
  await asentarse();
  await p.abrirEmotes();

  assert.equal(p.el('select-destino').hidden, true, 'con una sola red no hay nada que elegir');
  assert.ok(nombres(p).includes('collectiblesMEGALUL'));
  p.elegir('collectiblesMEGALUL');
  assert.equal(p.el('aviso-emotes').hidden, true, 'no va a Twitch: no hay nada que avisar');

  p.cerrar();
});

/* ============================================ lo que no rompe */

test('una lista que no llega no rompe la caja de escribir', async () => {
  const p = abrirPublico({ emotes: null });
  await asentarse();
  await p.abrirEmotes();

  assert.match(p.el('rejilla-emotes').textContent, /Todavía no hay emotes/);

  p.el('campo-texto').value = 'hola igual';
  p.el('boton-enviar').disparar('click');
  await asentarse();
  assert.equal(p.ultimoEnvio().texto, 'hola igual');

  p.cerrar();
});

test('un emote con una url que no es https no se pinta', async () => {
  /* El servidor ya lo valida; la página tampoco confía, que es el
     mismo criterio que con el color del usuario. */
  const p = abrirPublico({
    emotes: [
      { nombre: 'Malo', fuente: '7tv', marca: 'Malo', url: 'javascript:alert(1)', redes: ['kick'] },
      { nombre: 'Bueno', fuente: '7tv', marca: 'Bueno', url: 'https://cdn.7tv.app/e/2x.webp', redes: ['kick'] },
    ],
  });
  await asentarse();
  await p.abrirEmotes();

  assert.deepEqual(nombres(p), ['Bueno']);
  p.cerrar();
});

/* ===================== /chat: la ventana del creador

   La misma caja y el mismo panel, con dos diferencias que son las
   unicas que el codigo distingue: la lista sale de `/api/chat/emotes`
   (sin slug: el creador es el de la sesion) y el selector de destino
   dice "ambos" en vez de "ambas".

   Estuvo escondido mientras `/api/chat/enviar` mandaba el mismo string
   a las dos redes. Ahora esa puerta traduce con la MISMA
   `envio.comoViajaA`, asi que la pagina puede guardar la marca de Kick
   sin que Twitch vea corchetes. */

/** `/chat`, la ventana del creador, con su `/emotes` de mentira. */
function abrirCreador({ emotes = EMOTES } = {}) {
  const pedidos = [];
  let listaEmotes = emotes;

  const responder = async (url, opciones = {}) => {
    const r = String(url);
    pedidos.push({ url: r, opciones });
    if (r === '/api/estado') return { ok: true, status: 200, json: async () => ({ slug: 'istincho' }) };
    if (r === '/api/chat/emotes') {
      return { ok: true, status: 200, json: async () => ({ redes: ['kick', 'twitch'], emotes: listaEmotes }) };
    }
    if (r === '/api/chat/enviar') {
      return { ok: true, status: 200, json: async () => ({ kick: { ok: true }, twitch: { ok: true } }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };

  const pagina = abrirPagina({
    ruta: '/chat',
    antes: ['comun/mensajes.js'],
    fetch: responder,
    Sala: { conectar: () => ({ cerrar() {} }) },
  });

  return {
    ...pagina,
    pedidos,
    consultasEmotes: () => pedidos.filter(x => /\/emotes$/.test(x.url)).length,
    ultimoEnvio() {
      const p = pedidos.filter(x => x.url === '/api/chat/enviar').at(-1);
      return p ? JSON.parse(p.opciones.body) : null;
    },
    async abrirEmotes() {
      this.el('boton-emotes').disparar('click');
      await asentarse();
    },
    elegir(nombre) {
      const boton = opciones(this).find(b => b.dataset.nombre === nombre);
      if (!boton) throw new Error(`no hay ningún emote "${nombre}" en el panel`);
      this.el('rejilla-emotes').disparar('click', { target: boton });
    },
  };
}

test('en /chat el botón está con la página: esa caja siempre puede escribir', async () => {
  const p = abrirCreador();
  await asentarse();

  assert.equal(p.el('boton-emotes').hidden, false);
  assert.equal(p.el('panel-emotes').hidden, true);
  assert.equal(p.consultasEmotes(), 0, 'y la lista sigue costando cero hasta que alguien abra');

  p.cerrar();
});

test('en /chat la lista sale de /api/chat/emotes, sin slug en el camino', async () => {
  /* El slug de la ventana del creador sale de su sesión, no de la URL.
     Pedirla por `/api/chat/<slug>/emotes` sería además pasar por el
     interruptor del chat abierto, y el creador escribe en su propio
     chat con el chat cerrado. */
  const p = abrirCreador();
  await asentarse();
  await p.abrirEmotes();

  assert.deepEqual(p.pedidos.filter(x => /emotes/.test(x.url)).map(x => x.url), ['/api/chat/emotes']);
  assert.deepEqual(nombres(p), ['collectiblesMEGALUL', 'CHAD', 'KEKW']);

  p.cerrar();
});

test('en /chat la marca viaja tal cual y el servidor la traduce', async () => {
  const p = abrirCreador();
  await asentarse();
  await p.abrirEmotes();
  p.elegir('collectiblesMEGALUL');

  p.el('boton-enviar').disparar('click');
  await asentarse();

  const enviado = p.ultimoEnvio();
  assert.equal(enviado.texto, MARCA_KICK,
    'la página no arma ni traduce markup: manda la marca que le dio el servidor');
  /* El vocabulario de esta caja es `destino` y el de la otra es `red`:
     una habla de los canales del creador y la otra de las cuentas de
     quien mira. (El VALOR lo pone el navegador a partir del primer
     <option>, que el DOM de mentira no imita.) */
  assert.equal('destino' in enviado, true);
  assert.equal('red' in enviado, false);

  p.cerrar();
});

test('en /chat el aviso de "en Twitch sale como texto" también aparece', async () => {
  /* Con "ambos" —la palabra de esta caja— el mensaje sale a las dos
     redes, así que el aviso vale igual que en la otra. */
  const p = abrirCreador();
  await asentarse();
  p.el('select-destino').value = 'ambos';
  p.el('select-destino').disparar('change');
  await p.abrirEmotes();

  p.elegir('collectiblesMEGALUL');
  assert.equal(p.el('aviso-emotes').hidden, false);
  assert.match(p.el('aviso-emotes').textContent, /en Twitch va a salir como texto/);

  p.el('select-destino').value = 'kick';
  p.el('select-destino').disparar('change');
  assert.equal(p.el('aviso-emotes').hidden, true);

  p.cerrar();
});

test('en /chat con Twitch sola, los emotes de Kick no se ofrecen', async () => {
  /* Mismo criterio que en la otra caja: ahí no sirven para nada. */
  const p = abrirCreador();
  await asentarse();
  p.el('select-destino').value = 'twitch';
  p.el('select-destino').disparar('change');
  await p.abrirEmotes();

  assert.deepEqual(nombres(p), ['CHAD', 'KEKW']);

  p.cerrar();
});

/* ============================ los nativos de Twitch en el panel */

test('los emotes de Twitch salen en su propio grupo, después de los de Kick', async () => {
  const p = abrirPublico({ emotes: [...EMOTES, EMOTE_TWITCH] });
  await asentarse();
  p.el('select-destino').value = 'ambas';
  p.el('select-destino').disparar('change');
  await p.abrirEmotes();

  /* El orden importa: Kick primero porque son los que no se pueden
     buscar en ningún otro lado. */
  assert.deepEqual(nombres(p), ['collectiblesMEGALUL', 'anaLOVE', 'CHAD', 'KEKW']);
  assert.match(p.el('rejilla-emotes').textContent, /De Twitch · del canal y los globales/);

  const deTwitch = opciones(p).find(b => b.dataset.nombre === 'anaLOVE');
  assert.match(deTwitch.getAttribute('aria-label'), /anaLOVE · Twitch/);
  assert.match(deTwitch.getAttribute('aria-label'), /en Kick se lee como texto/);
  assert.ok(deTwitch.className.includes('opcion-emote-parcial'));

  p.cerrar();
});

test('con Kick sola, los emotes de Twitch no se ofrecen', async () => {
  const p = abrirPublico({ emotes: [...EMOTES, EMOTE_TWITCH] });
  await asentarse();
  p.el('select-destino').value = 'kick';
  p.el('select-destino').disparar('change');
  await p.abrirEmotes();

  assert.equal(nombres(p).includes('anaLOVE'), false, 'allá no sirven para nada');

  p.cerrar();
});

test('un emote de Twitch se inserta como su nombre pelado', async () => {
  /* No hay markup que armar: en Twitch un emote es su nombre. La
     página igual no decide nada, pone la `marca` que le dieron. */
  const p = abrirPublico({ emotes: [...EMOTES, EMOTE_TWITCH] });
  await asentarse();
  p.el('select-destino').value = 'twitch';
  p.el('select-destino').disparar('change');
  await p.abrirEmotes();

  p.elegir('anaLOVE');
  assert.equal(p.el('campo-texto').value.trim(), 'anaLOVE');
  assert.equal(p.el('aviso-emotes').hidden, true, 'no hay nada que avisar: va a la red donde existe');

  p.cerrar();
});

test('en /chat?demo=1 no hay botón de emotes: la demo no toca la red', async () => {
  /* La demo es una pantalla para mirar sin servidor. Un botón que al
     tocarlo pide `/api/chat/emotes` de verdad rompe eso, y hay una
     prueba vieja que exige que ?demo=1 no haga un solo pedido. */
  const pedidos = [];
  const pagina = abrirPagina({
    ruta: '/chat',
    busqueda: '?demo=1',
    antes: ['comun/mensajes.js'],
    fetch: async (url) => {
      pedidos.push(String(url));
      return { ok: true, status: 200, json: async () => ({}) };
    },
    Sala: { conectar: () => ({ cerrar() {} }) },
  });
  await asentarse();

  assert.equal(pagina.porId.get('boton-emotes').hidden, true);
  assert.deepEqual(pedidos, []);
  pagina.cerrar();
});

/* ================================== los emotes recientes */

/** Un localStorage que se puede compartir entre dos paginas: el mismo navegador. */
function almacenDeNavegador(inicial = {}) {
  const m = new Map(Object.entries(inicial));
  return {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: k => m.delete(k),
    mapa: m,
  };
}
const recientesDe = p => (p.el('emotes-recientes').children ?? []).map(b => b.dataset.marca);

test('un emote elegido queda en la fila de recientes, y sigue ahi al recargar', async () => {
  const navegador = almacenDeNavegador();
  const p = abrirPublico({ localStorage: navegador });
  await asentarse();
  assert.equal(p.el('emotes-recientes').hidden, true, 'sin recientes no hay fila');
  await p.abrirEmotes();
  p.elegir('CHAD');
  p.elegir('KEKW');
  assert.deepEqual(recientesDe(p), ['KEKW', 'CHAD'], 'el ultimo usado, primero');
  assert.equal(p.el('emotes-recientes').hidden, false);
  p.cerrar();

  const otra = abrirPublico({ localStorage: navegador });
  await asentarse();
  assert.deepEqual(recientesDe(otra), ['KEKW', 'CHAD'], 'se pinta al abrir, sin bajar el catalogo');
  otra.el('emotes-recientes').disparar('click', { target: otra.el('emotes-recientes').children[1] });
  assert.equal(otra.el('campo-texto').value.trim(), 'CHAD', 'tocarlo lo pone en la caja');
  otra.cerrar();
});

test('un emote escrito a mano cuenta como reciente cuando el mensaje sale', async () => {
  const p = abrirPublico({ localStorage: almacenDeNavegador() });
  await asentarse();
  await p.abrirEmotes();          // el catalogo tiene que estar para reconocerlo
  p.el('campo-texto').value = 'jajaja KEKW';
  p.el('boton-enviar').disparar('click');
  await asentarse();
  assert.deepEqual(recientesDe(p), ['KEKW']);
  p.cerrar();
});

test('la fila muestra solo los que sirven para la red elegida', async () => {
  const p = abrirPublico({ localStorage: almacenDeNavegador() });
  await asentarse();
  await p.abrirEmotes();
  p.elegir('collectiblesMEGALUL');   // solo Kick
  p.elegir('CHAD');                  // las dos
  p.el('select-destino').value = 'twitch';
  p.el('select-destino').disparar('change');
  assert.deepEqual(recientesDe(p), ['CHAD'], 'uno de Kick no se ofrece si se va a mandar a Twitch');
  p.cerrar();
});

test('lo que haya en localStorage que no sea un emote no se pinta', async () => {
  const navegador = almacenDeNavegador({
    'sala:emotes-recientes:ana': JSON.stringify([
      { nombre: 'x', marca: 'x', url: 'javascript:alert(1)', redes: ['kick'] },
      { nombre: 'y', marca: 'y', url: 'https://cdn.7tv.app/y.webp', redes: ['otra'] },
      'basura',
      { nombre: 'CHAD', marca: 'CHAD', url: 'https://cdn.7tv.app/emote/01CHAD/2x.webp', redes: ['kick', 'twitch'] },
    ]),
  });
  const p = abrirPublico({ localStorage: navegador });
  await asentarse();
  assert.deepEqual(recientesDe(p), ['CHAD']);
  p.cerrar();
});
