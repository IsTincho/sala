/* ============================================================
   La página de alta, corrida de verdad sobre `paginas/crear.html`.

   Es una pantalla de una sola decisión, y lo único que puede hacer mal
   es dejar seguir sin aceptar los términos. Se prueban las dos mitades
   de esa puerta:

     - la del ratón, que es CSS (`pointer-events: none`);
     - la del teclado, que es el listener de `crear.js`.

   Y se deja escrito, porque es la clase de cosa que un lector supone
   mal: NINGUNA de las dos es la puerta de verdad. La aceptación la
   exige el servidor, que sólo crea un creador nuevo si el flujo de
   OAuth traía la versión de los términos. Eso está probado en
   `pruebas/multicanal.test.js`. Acá se prueba la interfaz de la
   decisión, no su cumplimiento.
   ============================================================ */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { abrirPagina, PAGINAS } from './fijos/dom-falso.js';

const abrir = () => abrirPagina({
  archivo: 'crear.html',
  script: 'crear/crear.js',
  ruta: '/crear',
});

test('el botón arranca apagado y el aviso a la vista', () => {
  const p = abrir();
  try {
    assert.ok(p.el('boton-entrar').classList.contains('apagado'));
    assert.equal(p.el('boton-entrar').getAttribute('aria-disabled'), 'true');
    assert.equal(p.el('aviso-acepto').hidden, false);
  } finally { p.cerrar(); }
});

test('marcar la casilla lo prende, y desmarcarla lo vuelve a apagar', () => {
  const p = abrir();
  try {
    const casilla = p.el('acepto-terminos');
    const boton = p.el('boton-entrar');

    casilla.checked = true;
    casilla.disparar('change');
    assert.equal(boton.classList.contains('apagado'), false);
    assert.equal(boton.getAttribute('aria-disabled'), null);
    assert.equal(p.el('aviso-acepto').hidden, true);

    /* Y vuelve: si sólo se prendiera, alguien que se arrepiente
       quedaría con el botón vivo. */
    casilla.checked = false;
    casilla.disparar('change');
    assert.ok(boton.classList.contains('apagado'));
    assert.equal(boton.getAttribute('aria-disabled'), 'true');
  } finally { p.cerrar(); }
});

test('un click con la casilla sin marcar no navega y lo dice', () => {
  const p = abrir();
  try {
    let seFrenó = false;
    p.el('boton-entrar').disparar('click', { preventDefault: () => { seFrenó = true; } });

    assert.equal(seFrenó, true, 'sin preventDefault el link navega igual');
    assert.equal(p.el('aviso-acepto').hidden, false);
    assert.match(p.el('aviso-acepto').textContent, /marcar la casilla/i);
    /* Y el foco va a donde está el problema: si no, con el teclado la
       persona queda parada en un botón que no hace nada. */
    assert.equal(p.documento.activeElement?.id, 'acepto-terminos');
  } finally { p.cerrar(); }
});

test('con la casilla marcada el click pasa derecho', () => {
  /* El control negativo del de arriba: sin esto, "frenar siempre"
     pasaría el test anterior y nadie podría darse de alta nunca. */
  const p = abrir();
  try {
    const casilla = p.el('acepto-terminos');
    casilla.checked = true;
    casilla.disparar('change');

    let seFrenó = false;
    p.el('boton-entrar').disparar('click', { preventDefault: () => { seFrenó = true; } });
    assert.equal(seFrenó, false, 'con los términos aceptados el link tiene que funcionar');
  } finally { p.cerrar(); }
});

test('el link lleva el rol, el destino y la versión de los términos', () => {
  const p = abrir();
  try {
    const href = p.el('boton-entrar').getAttribute('href');
    const u = new URL(href, 'https://sala.example');

    assert.equal(u.pathname, '/oauth/kick/entrar');
    assert.equal(u.searchParams.get('rol'), 'creador',
      'con otro rol el servidor no crea la sala');
    assert.equal(u.searchParams.get('destino'), '/panel');
    assert.ok(u.searchParams.get('terminos'), 'sin la versión, el alta se rechaza');
  } finally { p.cerrar(); }
});

test('los términos se abren en otra pestaña y sin regalar la ventana', () => {
  const p = abrir();
  try {
    const html = fs.readFileSync(path.join(PAGINAS, 'crear.html'), 'utf8');
    const link = /<a href="\/terminos"[^>]*>/.exec(html)?.[0] ?? '';
    assert.match(link, /target="_blank"/,
      'si abriera en la misma pestaña, la persona pierde lo que estaba haciendo');
    assert.match(link, /rel="noopener"/,
      'una pestaña abierta sin noopener puede manejar la que la abrió');
  } finally { p.cerrar(); }
});

test('el CSS apaga el botón también para el ratón', () => {
  /* La mitad que no se ve desde el DOM de mentira, que no hace layout.
     Se mira la hoja de estilos: `pointer-events: none` es lo que hace
     que el click del mouse ni siquiera llegue al listener. */
  const css = fs.readFileSync(path.join(PAGINAS, 'crear', 'crear.css'), 'utf8');
  const regla = /\.boton-crear\.apagado\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
  assert.match(regla, /pointer-events:\s*none/,
    'el comentario de crear.css promete esto: si se saca, hay que sacar el comentario');
});

test('la página no ESCRIBE innerHTML en ningún lado', () => {
  /* El DOM de mentira lo hace explotar, así que si estuviera, los tests
     de arriba se caerían. Se mira igual el archivo: la regla vale
     también para el código que ningún test toca todavía. Se busca el
     uso y no la palabra, para no prohibir el comentario que la
     explica. */
  const js = fs.readFileSync(path.join(PAGINAS, 'crear', 'crear.js'), 'utf8');
  assert.equal(/\.innerHTML/.test(js), false);
  assert.equal(/insertAdjacentHTML|outerHTML|document\.write/.test(js), false);
});
