/* ============================================================
   /admin, corrida de verdad sobre `paginas/admin.html`.

   Es la pantalla desde la que el dueño reparte los planes. Lo que se
   prueba es lo que duele si se rompe:

     - que la fila diga los DOS planes cuando no coinciden, que es lo
       único que explica por qué alguien con plan «pago» no puede
       reproducir;
     - que los botones sólo ofrezcan los dos planes que el dueño puede
       poner;
     - que el nombre de un canal, que viene de Kick, no pueda meter
       HTML (el DOM de mentira hace explotar innerHTML a propósito);
     - que el aviso del tope aparezca antes de que sea tarde.
   ============================================================ */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { abrirPagina, PAGINAS } from './fijos/dom-falso.js';

const esperar = ms => new Promise(ok => setTimeout(ok, ms));
const asentarse = () => esperar(20);

const creador = (extra = {}) => ({
  slug: 'ana', nombre: 'Ana', plan: 'amigo', planEfectivo: 'amigo',
  vence: 0, creado: Date.now(), suscrito: true,
  terminos: { version: '1', cuando: Date.now() },
  conectados: 0, gb: 0.5, medido: Date.now(),
  cobro: { proveedor: '', suscripcion: '' },
  ...extra,
});

const lista = (creadores, extra = {}) => ({
  tope: 900,
  cuantos: creadores.length,
  cobro: { proveedor: 'paddle', listo: false, falta: 'faltan PADDLE_API_KEY' },
  creadores,
  ...extra,
});

/**
 * Abre /admin con un fetch de mentira. `respuesta` decide qué contesta
 * /api/admin/creadores; `pedidos` junta lo que la página manda.
 */
function abrir({ respuesta = lista([creador()]), estado = 200 } = {}) {
  const pedidos = [];
  const p = abrirPagina({
    archivo: 'admin.html',
    script: 'admin/admin.js',
    ruta: '/admin',
    fetch: async (url, opciones = {}) => {
      pedidos.push({ url: String(url), metodo: opciones.method ?? 'GET', cuerpo: opciones.body });
      if (String(url).startsWith('/api/admin/plan')) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response(JSON.stringify(respuesta), { status: estado });
    },
  });
  return { ...p, pedidos, cambiar: r => { respuesta = r; } };
}

/* --------------------------------------------------------- la lista */

test('pinta una fila por creador con su plan y su uso', async () => {
  const p = abrir({ respuesta: lista([
    creador({ slug: 'ana', gb: 0.5 }),
    creador({ slug: 'beto', plan: 'pendiente', planEfectivo: 'pendiente', gb: 0 }),
  ]) });
  try {
    await asentarse();
    const filas = p.el('filas-creadores').children;
    assert.equal(filas.length, 2);
    assert.match(filas[0].textContent, /ana/);
    assert.match(filas[0].textContent, /0\.5 GB/);
    assert.match(filas[1].textContent, /pendiente/);
    assert.equal(p.el('sin-creadores').hidden, true);
  } finally { p.cerrar(); }
});

test('cuando el plan guardado y el que vale hoy no coinciden, se ven los dos', async () => {
  /* Es lo único que explica por qué un creador con «pago» en la base no
     puede reproducir. Mostrar sólo uno de los dos deja al dueño
     mirando una pantalla que dice «pago» al lado de alguien que se
     queja de que no le anda. */
  const p = abrir({ respuesta: lista([
    creador({ slug: 'beto', plan: 'pago', planEfectivo: 'vencido', vence: Date.now() - 1000 }),
  ]) });
  try {
    await asentarse();
    const fila = p.el('filas-creadores').children[0];
    assert.match(fila.textContent, /pago/);
    assert.match(fila.textContent, /vencido/);
  } finally { p.cerrar(); }
});

test('cuando coinciden se muestra uno solo, sin paréntesis', async () => {
  /* El control negativo: sin esto, "mostrar siempre los dos" pasaría el
     test de arriba y la pantalla diría "amigo (hoy: amigo)" en cada
     fila. */
  const p = abrir({ respuesta: lista([creador({ plan: 'amigo', planEfectivo: 'amigo' })]) });
  try {
    await asentarse();
    const fila = p.el('filas-creadores').children[0];
    assert.ok(!fila.textContent.includes('hoy:'), fila.textContent);
  } finally { p.cerrar(); }
});

test('sin creadores lo dice en vez de mostrar una tabla vacía', async () => {
  const p = abrir({ respuesta: lista([]) });
  try {
    await asentarse();
    assert.equal(p.el('filas-creadores').children.length, 0);
    assert.equal(p.el('sin-creadores').hidden, false);
  } finally { p.cerrar(); }
});

/* ------------------------------------------------------ los botones */

test('los botones son los dos planes que el dueño puede poner, y ninguno más', async () => {
  const p = abrir({ respuesta: lista([creador({ plan: 'pendiente', planEfectivo: 'pendiente' })]) });
  try {
    await asentarse();
    const acciones = p.el('filas-creadores').children[0].children.at(-1);
    const etiquetas = acciones.children.map(b => b.textContent);

    assert.deepEqual(etiquetas, ['Amigo'], 'al que ya es pendiente sólo se le ofrece amigo');
    assert.ok(!etiquetas.some(e => /pago|vencido/i.test(e)),
      'los planes del proveedor de cobro no se ponen desde acá');
  } finally { p.cerrar(); }
});

test('al dueño del servicio no se le ofrece ningún botón', async () => {
  /* Su plan no sale de la base: un botón ahí daría la impresión
     contraria, y el servidor lo rechazaría igual. */
  const p = abrir({ respuesta: lista([creador({ slug: 'istincho', planEfectivo: 'dueno', plan: 'pendiente' })]) });
  try {
    await asentarse();
    const acciones = p.el('filas-creadores').children[0].children.at(-1);
    assert.equal(acciones.children.filter(c => c.tagName === 'BUTTON').length, 0);
    assert.match(acciones.textContent, /KICK_SLUG/);
  } finally { p.cerrar(); }
});

test('tocar "Amigo" manda el slug y el plan, y vuelve a consultar', async () => {
  const p = abrir({ respuesta: lista([creador({ slug: 'beto', plan: 'pendiente', planEfectivo: 'pendiente' })]) });
  try {
    await asentarse();
    const boton = p.el('filas-creadores').children[0].children.at(-1).children[0];
    boton.disparar('click');
    await asentarse();

    const puesto = p.pedidos.find(x => x.url.startsWith('/api/admin/plan'));
    assert.ok(puesto, 'no se mandó nada');
    assert.equal(puesto.metodo, 'POST');
    assert.deepEqual(JSON.parse(puesto.cuerpo), { slug: 'beto', plan: 'amigo' });

    /* Y después vuelve a pedir la lista: si no, la pantalla seguiría
       mostrando el plan viejo hasta que alguien recargue. */
    const consultas = p.pedidos.filter(x => x.url.startsWith('/api/admin/creadores'));
    assert.ok(consultas.length >= 2, `sólo consultó ${consultas.length} vez`);
  } finally { p.cerrar(); }
});

test('un error al cambiar el plan se muestra y no se traga', async () => {
  const pedidos = [];
  const p = abrirPagina({
    archivo: 'admin.html',
    script: 'admin/admin.js',
    ruta: '/admin',
    fetch: async (url, opciones = {}) => {
      pedidos.push(String(url));
      if (String(url).startsWith('/api/admin/plan')) {
        return new Response(JSON.stringify({ error: 'ese creador no existe' }), { status: 404 });
      }
      return new Response(JSON.stringify(lista([creador({ plan: 'pendiente', planEfectivo: 'pendiente' })])), { status: 200 });
    },
  });
  try {
    await asentarse();
    p.el('filas-creadores').children[0].children.at(-1).children[0].disparar('click');
    await asentarse();

    assert.equal(p.el('aviso-admin').hidden, false);
    assert.match(p.el('texto-aviso-admin').textContent, /no existe/);
  } finally { p.cerrar(); }
});

/* ------------------------------------------------------- el resumen */

test('el resumen dice cuántas salas hay y si el cobro está configurado', async () => {
  const p = abrir({ respuesta: lista([creador()], { cuantos: 1, tope: 900 }) });
  try {
    await asentarse();
    assert.match(p.el('tarjeta-resumen').textContent, /1 salas de un tope de 900/);
    assert.match(p.el('tarjeta-resumen').textContent, /sin configurar/);
  } finally { p.cerrar(); }
});

test('pasada la mitad del tope aparece el aviso de pedir la verificación', async () => {
  /* PLAN.md dice pedirla antes de los 500 de 1.000. Pasado el tope, las
     suscripciones fallan y el chat de los que entren queda mudo sin que
     nada lo explique: el aviso tiene que llegar antes. */
  const p = abrir({ respuesta: lista([creador()], { cuantos: 500, tope: 900 }) });
  try {
    await asentarse();
    assert.match(p.el('tarjeta-resumen').textContent, /verificaci/i);
  } finally { p.cerrar(); }
});

test('con pocas salas el aviso del tope no está', async () => {
  /* El control negativo: sin esto, un aviso permanente pasaría el test
     de arriba y dejaría de significar nada. */
  const p = abrir({ respuesta: lista([creador()], { cuantos: 3, tope: 900 }) });
  try {
    await asentarse();
    assert.ok(!/verificaci/i.test(p.el('tarjeta-resumen').textContent));
  } finally { p.cerrar(); }
});

/* ----------------------------------------------------- sin permiso */

test('un 403 se explica en vez de dejar la pantalla en "consultando…"', async () => {
  const p = abrir({ estado: 403, respuesta: { error: 'esto es solo del dueño' } });
  try {
    await asentarse();
    assert.match(p.el('tarjeta-resumen').textContent, /s[oó]lo del due/i);
  } finally { p.cerrar(); }
});

test('un corte de red se avisa y no deja datos viejos sin marcar', async () => {
  const p = abrirPagina({
    archivo: 'admin.html',
    script: 'admin/admin.js',
    ruta: '/admin',
    fetch: async () => { throw new Error('sin red'); },
  });
  try {
    await asentarse();
    assert.match(p.el('tarjeta-resumen').textContent, /no se pudo consultar/);
  } finally { p.cerrar(); }
});

/* ------------------------------------------------------------- XSS */

test('un nombre de canal con HTML adentro no puede abrir una etiqueta', async () => {
  /* El nombre viene de Kick, o sea de afuera. El DOM de mentira hace
     explotar innerHTML, así que si la página lo usara este test no
     llegaría ni a la aserción. */
  const p = abrir({ respuesta: lista([
    creador({ slug: 'ana', nombre: '<img src=x onerror=alert(1)>' }),
  ]) });
  try {
    await asentarse();
    const fila = p.el('filas-creadores').children[0];
    /* El texto se muestra tal cual (es texto, no markup) y no hay
       ningún elemento IMG en el árbol de la fila. */
    assert.match(fila.textContent, /onerror/, 'el nombre se muestra como texto');
    const hayImg = (function buscar(n) {
      if (n.tagName === 'IMG') return true;
      return (n.children ?? []).some(buscar);
    })(fila);
    assert.equal(hayImg, false, 'el nombre abrió una etiqueta');
  } finally { p.cerrar(); }
});

test('la página no ESCRIBE innerHTML en ningún lado', () => {
  /* Se busca el uso (`algo.innerHTML`), no la palabra: el encabezado
     del archivo la nombra para explicar por qué no está, y prohibir la
     palabra prohibiría también explicarla. */
  const js = fs.readFileSync(path.join(PAGINAS, 'admin', 'admin.js'), 'utf8');
  assert.equal(/\.innerHTML/.test(js), false);
  assert.equal(/insertAdjacentHTML|outerHTML|document\.write/.test(js), false);
});
