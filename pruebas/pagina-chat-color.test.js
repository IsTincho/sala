/* ============================================================
   El color propio, del lado de la pantalla.

   Dos cosas distintas viven acá y las dos se corren de verdad, con el
   archivo real sobre el HTML real:

     1. LA CORRECCIÓN DE CONTRASTE (`comun/mensajes.js`), que es la que
        garantiza que nadie quede ilegible. Se mide con una
        implementación PROPIA de la fórmula de WCAG escrita en este
        archivo: si la prueba usara la función de la página, estaría
        preguntándole a la página si la página tiene razón.

     2. EL ELEGIDOR de `/chat/<slug>`: que aparezca cuando corresponde,
        que mande el color al servidor, que repinte los mensajes que ya
        están en pantalla y que el botón del creador exista sólo en los
        mensajes de quien eligió un color.

   El fondo contra el que se mide sale de `base.css` de verdad (lo
   carga el DOM de mentira), así que si alguien cambia el tema, esta
   prueba mide contra el tema nuevo.
   ============================================================ */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { abrirPagina, PAGINAS } from './fijos/dom-falso.js';

const esperar = ms => new Promise(ok => setTimeout(ok, ms));
const asentarse = () => esperar(10);

/* ---------------------------------------------- WCAG, a mano

   La fórmula, escrita de nuevo acá a propósito. Es corta y está en la
   norma; copiarla es más barato que confiar en la de la página. */

function luminancia(hex) {
  const canal = n => {
    const c = n / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const r = canal(parseInt(hex.slice(1, 3), 16));
  const g = canal(parseInt(hex.slice(3, 5), 16));
  const b = canal(parseInt(hex.slice(5, 7), 16));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contraste(a, b) {
  const la = luminancia(a);
  const lb = luminancia(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/* TODOS los fondos sobre los que puede caer el nombre de alguien, en
   cada tema, ESCRITOS ACÁ A MANO.

   A mano a propósito: si la prueba leyera los mismos valores que lee
   la página, estaría comprobando que la página se lleva bien consigo
   misma —cambiar el fondo en base.css movía las dos puntas a la vez y
   la prueba seguía en verde—. Con los números escritos, cambiar el
   tema y olvidarse del contraste rompe esta prueba, que es lo que
   tiene que pasar.

   De dónde sale cada uno:
     oscuro  #0e1013  la lista de mensajes de /chat (el fondo del body)
             #181a1c  esa misma fila con el puntero encima
             #181b20  la tarjeta de la lista de la Sala (--fondo-tarjeta)
     claro   #ffffff  la tarjeta de la Sala
             #f5f6f8  la lista de /chat
             #eeeff1  esa misma fila con el puntero encima */
const FONDOS_REALES = {
  oscuro: ['#0e1013', '#181a1c', '#181b20'],
  claro: ['#ffffff', '#f5f6f8', '#eeeff1'],
};

const MINIMO = 4.5;

/* El más desfavorable de cada tema: para un texto claro, el fondo más
   claro; para uno oscuro, el más oscuro. */
const peorOscuro = FONDOS_REALES.oscuro.reduce((a, b) => (luminancia(b) > luminancia(a) ? b : a));
const peorClaro = FONDOS_REALES.claro.reduce((a, b) => (luminancia(b) < luminancia(a) ? b : a));

/** Lo que dice base.css, para comprobar que sigue siendo lo mismo. */
function fondosDeBase() {
  const css = fs.readFileSync(path.join(PAGINAS, 'comun', 'base.css'), 'utf8');
  const leer = nombre => new RegExp(`${nombre}\\s*:\\s*([^;]+);`).exec(css)?.[1].trim();
  return { oscuro: leer('--fondo-peor-oscuro'), claro: leer('--fondo-peor-claro') };
}

const FONDOS = { oscuro: peorOscuro, claro: peorClaro };

const mensaje = (extra = {}) => ({
  tipo: 'chat', red: 'kick', id: 'm1', usuario: 'Fulana', usuarioId: '909',
  color: '#53fc18', insignias: [], texto: 'hola', emotes: [],
  hora: new Date().toISOString(), ...extra,
});

/* ================================================= la corrección

   Se corre sólo `comun/mensajes.js`: no hace falta la página entera
   para preguntarle de qué color pinta un nombre. */

function abrirRender() {
  const p = abrirPagina({ antes: ['comun/mensajes.js'], script: 'comun/mensajes.js' });
  return { ...p, SalaMensajes: p.ventana.SalaMensajes };
}

test('base.css declara como peor fondo el que de verdad es el peor', () => {
  /* Si alguien cambia un fondo del tema y no toca estas variables, la
     corrección se calcula contra un fondo que ya no existe y el mínimo
     deja de cumplirse sin que nadie se entere. Esta prueba es el
     recordatorio. También se cae si los mete adentro del @media: ahí
     el JS no puede leer el del tema que no está puesto. */
  const declarado = fondosDeBase();
  assert.equal(declarado.oscuro, peorOscuro,
    `--fondo-peor-oscuro tendría que ser ${peorOscuro}, el más claro sobre el que cae un nombre`);
  assert.equal(declarado.claro, peorClaro,
    `--fondo-peor-claro tendría que ser ${peorClaro}, el más oscuro sobre el que cae un nombre`);
});

test('un color que ya se lee no se toca', () => {
  const p = abrirRender();
  /* Blanco sobre el fondo oscuro: 19:1. No hay nada que corregir. */
  const par = p.SalaMensajes.coloresDeUsuario({ red: 'kick', color: '#ffffff' });
  assert.equal(par.oscuro, '#ffffff');
  p.cerrar();
});

test('un color ilegible sobre el tema oscuro se corrige', () => {
  const p = abrirRender();
  /* El #0000FF clásico de Twitch: sobre el fondo oscuro es casi
     negro. Es el caso que motivó todo esto. */
  const par = p.SalaMensajes.coloresDeUsuario({ red: 'twitch', color: '#0000ff' });

  assert.notEqual(par.oscuro, '#0000ff', 'tenía que cambiar');
  assert.ok(contraste(par.oscuro, FONDOS.oscuro) >= MINIMO,
    `quedó en ${contraste(par.oscuro, FONDOS.oscuro).toFixed(2)}:1 sobre el fondo oscuro`);
  p.cerrar();
});

test('un color ilegible sobre el tema claro se corrige, y es OTRO color', () => {
  const p = abrirRender();
  /* El verde de Kick sobre fondo blanco no se lee: 1,3:1. Este es el
     caso que hoy se ve mal en la pantalla de quien usa el tema claro,
     porque la corrección vieja sólo sabía aclarar. */
  const par = p.SalaMensajes.coloresDeUsuario({ red: 'kick', color: '#53fc18' });

  assert.ok(contraste(par.claro, FONDOS.claro) >= MINIMO,
    `quedó en ${contraste(par.claro, FONDOS.claro).toFixed(2)}:1 sobre el fondo claro`);
  assert.notEqual(par.claro, par.oscuro,
    'el mismo color no puede servir para los dos fondos: por eso se calculan los dos');
  p.cerrar();
});

test('cualquier color termina legible sobre CUALQUIERA de los fondos reales', () => {
  const p = abrirRender();
  /* Una vuelta por todo el círculo de tonos, más los extremos, contra
     los tres fondos de cada tema: la lista, la fila resaltada y la
     tarjeta de la Sala. Nadie puede quedar ilegible en ninguna de las
     tres pantallas, que es la promesa de verdad; medir sólo contra el
     fondo del body dejaba la Sala en 4,08:1 y la fila resaltada del
     tema claro en 4,24:1. */
  const colores = ['#000000', '#ffffff', '#ff0000', '#00ff00', '#0000ff', '#ffff00',
    '#00ffff', '#ff00ff', '#808080', '#53fc18', '#9146ff', '#1a1a1a', '#f0f0f0',
    '#776611', '#0000cc', '#336699'];

  for (const color of colores) {
    const par = p.SalaMensajes.coloresDeUsuario({ red: 'kick', color });
    for (const fondo of FONDOS_REALES.oscuro) {
      assert.ok(contraste(par.oscuro, fondo) >= MINIMO,
        `${color} no se lee sobre ${fondo}: ${contraste(par.oscuro, fondo).toFixed(2)}:1`);
    }
    for (const fondo of FONDOS_REALES.claro) {
      assert.ok(contraste(par.claro, fondo) >= MINIMO,
        `${color} no se lee sobre ${fondo}: ${contraste(par.claro, fondo).toFixed(2)}:1`);
    }
  }
  p.cerrar();
});

test('la corrección es la más chica que alcanza', () => {
  const p = abrirRender();
  /* "El tono más cercano que sí se lea": un color que está apenas por
     debajo del mínimo tiene que moverse poco, no saltar al blanco. */
  const par = p.SalaMensajes.coloresDeUsuario({ red: 'twitch', color: '#9146ff' });
  assert.notEqual(par.oscuro, '#ffffff', 'no puede lavar el violeta hasta el blanco');
  assert.ok(contraste(par.oscuro, FONDOS.oscuro) >= MINIMO);
  /* Y sigue siendo violeta: el azul tiene que seguir mandando. */
  const azul = parseInt(par.oscuro.slice(5, 7), 16);
  const verde = parseInt(par.oscuro.slice(3, 5), 16);
  assert.ok(azul > verde, `dejó de ser violeta: ${par.oscuro}`);
  p.cerrar();
});

test('un color basura no llega nunca al style', () => {
  const p = abrirRender();
  /* Es una entrada de terceros que termina en un atributo de estilo.
     Lo que no es `#rrggbb` se cae al color de la red, no se "arregla". */
  const kick = p.SalaMensajes.coloresDeUsuario({ red: 'kick', color: '#53fc18' });
  for (const malo of ['red', 'rgb(1,2,3)', '#abc', 'url(x)', '#aabbcc;background:red', null, 42]) {
    const par = p.SalaMensajes.coloresDeUsuario({ red: 'kick', color: malo });
    assert.deepEqual(par, kick, `${JSON.stringify(malo)} tendría que caer al color de Kick`);
    assert.match(par.oscuro, /^#[0-9a-f]{6}$/);
  }
  p.cerrar();
});

test('el nombre sale con los dos colores puestos, no con uno solo', () => {
  const p = abrirRender();
  const li = p.SalaMensajes.crear(mensaje({ color: '#0000ff' }));

  const nombre = buscarPorClase(li, 'usuario');
  const oscuro = nombre.style.getPropertyValue('--color-usuario-oscuro');
  const claro = nombre.style.getPropertyValue('--color-usuario-claro');

  assert.match(oscuro, /^#[0-9a-f]{6}$/);
  assert.match(claro, /^#[0-9a-f]{6}$/);
  assert.equal(nombre.style.getPropertyValue('color'), '',
    'el color lo elige el CSS según el tema, no el JS');
  p.cerrar();
});

function buscarPorClase(nodo, clase) {
  for (const h of nodo.children ?? []) {
    if (h.classList?.contains(clase)) return h;
    const dentro = buscarPorClase(h, clase);
    if (dentro) return dentro;
  }
  return null;
}

/* ================================================= el elegidor */

const CON_KICK = {
  entrado: true, abierto: true, redes: ['kick', 'twitch'],
  conectadas: { kick: { nombre: 'Fulana', usuarioId: '909' } },
  puedeEscribir: ['kick'], color: '',
};

function abrirPublico({ yo = CON_KICK } = {}) {
  const pedidos = [];
  let quienSoy = yo;
  let respuestaColor = null;

  const responder = async (url, opciones = {}) => {
    const r = String(url);
    pedidos.push({ url: r, opciones });
    if (/^\/api\/chat\/[^/]+\/abierto$/.test(r)) {
      return { ok: true, status: 200, json: async () => ({ abierto: true, redes: ['kick', 'twitch'] }) };
    }
    if (/^\/api\/chat\/[^/]+\/yo$/.test(r)) {
      return { ok: true, status: 200, json: async () => quienSoy };
    }
    if (r === '/api/espectador/color') {
      const pedido = JSON.parse(opciones.body);
      const datos = respuestaColor ?? { ok: true, color: pedido.color };
      return { ok: true, status: 200, json: async () => datos };
    }
    if (/^\/api\/chat\/[^/]+\/emotes$/.test(r)) {
      return { ok: true, status: 200, json: async () => ({ emotes: [] }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };

  const conexiones = [];
  const pagina = abrirPagina({
    ruta: '/chat/ana',
    antes: ['comun/mensajes.js'],
    fetch: responder,
    Sala: { conectar: (slug, fn) => { const c = { slug, fn, cerrar() {} }; conexiones.push(c); return c; } },
  });

  return {
    ...pagina,
    pedidos,
    llega: datos => conexiones.at(-1)?.fn('chat', datos),
    contestarYo: datos => { quienSoy = datos; },
    ultimoColorMandado() {
      const p = pedidos.filter(x => x.url === '/api/espectador/color').at(-1);
      return p ? JSON.parse(p.opciones.body) : null;
    },
  };
}

test('sin cuenta conectada no hay color que elegir', async () => {
  const p = abrirPublico({
    yo: { entrado: false, abierto: true, redes: ['kick'], conectadas: {}, puedeEscribir: [] },
  });
  await asentarse();

  assert.equal(p.el('boton-color').hidden, true);
  assert.equal(p.el('panel-color').hidden, true);
  p.cerrar();
});

test('con la cuenta conectada aparece el botón', async () => {
  const p = abrirPublico();
  await asentarse();

  assert.equal(p.el('boton-color').hidden, false);
  assert.equal(p.el('boton-color').getAttribute('aria-expanded'), 'false');
  p.cerrar();
});

test('con la cuenta conectada se puede elegir, aunque no pueda escribir', async () => {
  /* El creador puede haber abierto sólo Twitch: esta persona no
     escribe acá, pero lo que escriba en kick.com llega igual, con su
     color. */
  const p = abrirPublico({
    yo: {
      entrado: true, abierto: true, redes: ['twitch'],
      conectadas: { kick: { nombre: 'Fulana', usuarioId: '909' } },
      puedeEscribir: [], color: '',
    },
  });
  await asentarse();

  assert.equal(p.el('boton-color').hidden, false);
  assert.equal(p.el('caja-escritura').hidden, true, 'y sigue sin poder escribir');
  p.cerrar();
});

test('el panel arranca en el color que ya había elegido', async () => {
  const p = abrirPublico({ yo: { ...CON_KICK, color: '#7a5cff' } });
  await asentarse();

  p.el('boton-color').disparar('click');

  assert.equal(p.el('panel-color').hidden, false);
  assert.equal(p.el('campo-color').value, '#7a5cff');
  assert.equal(p.el('boton-color').getAttribute('aria-expanded'), 'true');
  p.cerrar();
});

test('la muestra se pinta con la misma corrección que los mensajes', async () => {
  const p = abrirPublico();
  await asentarse();
  p.el('boton-color').disparar('click');

  p.el('campo-color').value = '#0000ff';
  p.el('campo-color').disparar('input');

  const puesto = p.el('ejemplo-nombre').style.getPropertyValue('--color-usuario-oscuro');
  assert.notEqual(puesto, '#0000ff', 'la muestra tiene que mostrar el color YA corregido');
  assert.ok(contraste(puesto, FONDOS.oscuro) >= MINIMO);
  p.cerrar();
});

test('guardar manda el color y repinta lo que ya estaba en pantalla', async () => {
  const p = abrirPublico();
  await asentarse();

  /* Dos mensajes míos y uno de otra persona. */
  p.llega(mensaje({ id: 'm1', usuarioId: '909', color: '#53fc18' }));
  p.llega(mensaje({ id: 'm2', usuarioId: '909', color: '#53fc18' }));
  p.llega(mensaje({ id: 'm3', usuarioId: '111', usuario: 'Otra', color: '#53fc18' }));

  const delOtro = [...p.el('lista-mezclada').children].find(li => li.dataset.usuarioId === '111');
  const antesDelOtro = buscarPorClase(delOtro, 'usuario').style.getPropertyValue('--color-usuario-oscuro');

  p.el('boton-color').disparar('click');
  p.el('campo-color').value = '#ff00ff';
  p.el('guardar-color').disparar('click');
  await asentarse();

  assert.deepEqual(p.ultimoColorMandado(), { color: '#ff00ff' });

  const mios = [...p.el('lista-mezclada').children].filter(li => li.dataset.usuarioId === '909');
  assert.equal(mios.length, 2);
  for (const li of mios) {
    const puesto = buscarPorClase(li, 'usuario').style.getPropertyValue('--color-usuario-oscuro');
    assert.equal(puesto, '#ff00ff', 'mis mensajes ya puestos tienen que verse con el color nuevo');
  }

  const ahoraElOtro = buscarPorClase(delOtro, 'usuario').style.getPropertyValue('--color-usuario-oscuro');
  assert.equal(ahoraElOtro, antesDelOtro, 'el de otra persona no se toca');

  /* Y el panel se cierra solo: ya está elegido. */
  assert.equal(p.el('panel-color').hidden, true);
  p.cerrar();
});

test('el repintado es por red: el mismo número en la otra red no es la misma persona', async () => {
  const p = abrirPublico();
  await asentarse();

  p.llega(mensaje({ id: 'm1', red: 'twitch', usuarioId: '909', usuario: 'OtraGente', color: '#9146ff' }));
  const ajeno = [...p.el('lista-mezclada').children][0];
  const antes = buscarPorClase(ajeno, 'usuario').style.getPropertyValue('--color-usuario-oscuro');

  p.el('boton-color').disparar('click');
  p.el('campo-color').value = '#ff00ff';
  p.el('guardar-color').disparar('click');
  await asentarse();

  const ahora = buscarPorClase(ajeno, 'usuario').style.getPropertyValue('--color-usuario-oscuro');
  assert.equal(ahora, antes, 'sólo conecté Kick: un id igual en Twitch es otra persona');
  p.cerrar();
});

test('"volver al de la plataforma" manda el vacío', async () => {
  const p = abrirPublico({ yo: { ...CON_KICK, color: '#7a5cff' } });
  await asentarse();

  p.el('boton-color').disparar('click');
  p.el('quitar-color').disparar('click');
  await asentarse();

  assert.deepEqual(p.ultimoColorMandado(), { color: '' });
  p.cerrar();
});

/* ============================== el botón del creador, en el mensaje */

test('el botón de sacar el color sale sólo en los mensajes de quien eligió uno', () => {
  const p = abrirRender();

  const conPropio = p.SalaMensajes.crear(mensaje({ colorPropio: true }), { conBloquear: true });
  const sinPropio = p.SalaMensajes.crear(mensaje(), { conBloquear: true });

  assert.ok(buscarPorClase(conPropio, 'boton-color'), 'con color propio hay botón');
  assert.equal(buscarPorClase(sinPropio, 'boton-color'), null,
    'sin color propio no hay nada que resetear: el botón sería ruido en cada renglón');

  /* Y nunca en la ventana de la comunidad: el reseteo es del creador. */
  const enPublico = p.SalaMensajes.crear(mensaje({ colorPropio: true }));
  assert.equal(buscarPorClase(enPublico, 'boton-color'), null);
  p.cerrar();
});

test('el botón lleva la red y el id, que es lo único con lo que se puede resetear', () => {
  const p = abrirRender();
  const li = p.SalaMensajes.crear(mensaje({ colorPropio: true, red: 'twitch', usuarioId: '909' }),
    { conBloquear: true });
  const boton = buscarPorClase(li, 'boton-color');

  assert.equal(boton.dataset.colorRed, 'twitch');
  assert.equal(boton.dataset.colorId, '909');
  /* Por nombre no sirve: los nombres se cambian. */
  assert.equal(boton.dataset.colorNombre, 'Fulana');
  p.cerrar();
});

/** La ventana del creador, con un mensaje de alguien con color propio. */
function abrirCreador({ reseteados = 1 } = {}) {
  const pedidos = [];
  const p = abrirPagina({
    antes: ['comun/mensajes.js'],
    fetch: async (url, opciones = {}) => {
      pedidos.push({ url: String(url), opciones });
      if (String(url) === '/api/chat/salud') {
        return { ok: false, status: 401, json: async () => ({}) };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, reseteados }) };
    },
    Sala: { conectar: () => ({ cerrar() {} }) },
  });
  return { ...p, pedidos };
}

test('si no había nada que sacar, se lo dice en vez de mentirle', async () => {
  /* Pasa de verdad: el creador toca el botón en un mensaje viejo del
     buffer de alguien que ya se sacó el color solo. El servidor
     contesta `reseteados: 0` y decirle "listo, se lo sacaste" lo deja
     pensando que el botón anda cuando no pasó nada. */
  const p = abrirCreador({ reseteados: 0 });
  await asentarse();

  const li = p.ventana.SalaMensajes.crear(mensaje({ colorPropio: true }), { conBloquear: true });
  p.el('lista-mezclada').appendChild(li);
  p.el('lista-mezclada').disparar('click', { target: buscarPorClase(li, 'boton-color') });
  await asentarse();

  assert.match(p.el('texto-aviso-envio').textContent, /no había nada que sacar/);
  p.cerrar();
});

test('tocarlo le pega a /api/panel/color con la red y el id', async () => {
  const p = abrirCreador();
  const pedidos = p.pedidos;
  await asentarse();

  const li = p.ventana.SalaMensajes.crear(mensaje({ colorPropio: true }), { conBloquear: true });
  p.el('lista-mezclada').appendChild(li);
  const boton = buscarPorClase(li, 'boton-color');
  p.el('lista-mezclada').disparar('click', { target: boton });
  await asentarse();

  const pedido = pedidos.find(x => x.url === '/api/panel/color');
  assert.ok(pedido, 'tenía que pegarle a /api/panel/color');
  assert.equal(pedido.opciones.method, 'POST');
  assert.deepEqual(JSON.parse(pedido.opciones.body), { red: 'kick', id: '909' });
  /* Y se lo dice, incluido que vale en todos los chats. */
  assert.match(p.el('texto-aviso-envio').textContent, /otros creadores/);
  p.cerrar();
});
