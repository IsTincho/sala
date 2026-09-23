/* ============================================================
   De que dominio viene un pedido, cuando hay un proxy en el medio.

   El caso real que rompio esto en produccion (2026-09-23): el sitio se
   sirve tambien desde multichat-osmiumstudio.pages.dev, que es un
   Worker de Cloudflare que reenvia todo a Railway. El Worker avisaba el
   dominio real en `X-Forwarded-Host`, pero **Railway la reescribe con
   su propio dominio** antes de que el pedido llegue a este proceso.
   Resultado: el login que empezaba en el dominio lindo terminaba en el
   de Railway, en el panel y en el chat.
   ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const PROXY   = 'https://multichat-osmiumstudio.pages.dev';
const RAILWAY = 'https://sala-production-2289.up.railway.app';

/* El modulo lee el entorno al importarse, asi que se prepara antes. */
process.env.URL_BASE = RAILWAY;
process.env.ORIGENES = PROXY;
const origenes = await import('../servidor/origenes.js');

const pedido = headers => ({ headers });

test('los dos dominios estan en la lista, con URL_BASE primero', () => {
  assert.deepEqual(origenes.permitidos(), [RAILWAY, PROXY]);
});

test('el caso real: Railway pisa el forwarded y manda la cabecera del proxy', () => {
  const r = pedido({
    'x-origen-proxy'   : PROXY,
    'x-forwarded-host' : 'sala-production-2289.up.railway.app',   // lo que reescribe Railway
    'x-forwarded-proto': 'https',
    host               : 'sala-production-2289.up.railway.app',
  });
  assert.equal(origenes.delPedido(r), PROXY);
});

test('sin la cabecera del proxy se sigue mirando el forwarded, como antes', () => {
  const r = pedido({
    'x-forwarded-host' : 'multichat-osmiumstudio.pages.dev',
    'x-forwarded-proto': 'https',
  });
  assert.equal(origenes.delPedido(r), PROXY);
});

test('un dominio ajeno en la cabecera del proxy no sirve de nada', () => {
  const r = pedido({
    'x-origen-proxy'   : 'https://malo.example',
    'x-forwarded-host' : 'sala-production-2289.up.railway.app',
    'x-forwarded-proto': 'https',
  });
  /* Cae al forwarded, que es nuestro. Lo unico que se puede elegir
     mintiendo con esa cabecera es otro dominio de la lista. */
  assert.equal(origenes.delPedido(r), RAILWAY);
});

test('un pedido directo a Railway sigue dando Railway', () => {
  const r = pedido({
    'x-forwarded-host' : 'sala-production-2289.up.railway.app',
    'x-forwarded-proto': 'https',
  });
  assert.equal(origenes.delPedido(r), RAILWAY);
});

test('basura en la cabecera del proxy no rompe nada', () => {
  for (const basura of ['', '   ', 'no-es-una-url', 'javascript:alert(1)', 'https://']) {
    const r = pedido({ 'x-origen-proxy': basura, host: 'localhost:8778' });
    assert.equal(origenes.delPedido(r), '', `con ${JSON.stringify(basura)}`);
  }
});
