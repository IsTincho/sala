/* ============================================================
   Pruebas de servidor/kick.js.

   Solo lo que se puede probar sin salir a la red: la ventana de los
   logins a medio empezar. El canje de codigo contra id.kick.com y el
   envio de mensajes se prueban cuando el dueño cargue las credenciales;
   aca no se hace ni un pedido HTTP.

   Las credenciales se ponen ANTES de importar: kick.js las lee al
   cargarse. Son de mentira y no salen de este proceso.
   ============================================================ */

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.KICK_CLIENT_ID = 'cliente-de-prueba';
process.env.KICK_CLIENT_SECRET = 'secreto-de-prueba';

const kick = await import('../servidor/kick.js');

const REDIRECT = 'https://sala.example/oauth/kick/volver';

test('un login recien empezado queda pendiente y guarda su state', () => {
  const { url, estado } = kick.urlLogin({ redirect: REDIRECT });
  assert.ok(estado);
  assert.equal(kick.hayLoginPendiente(estado), true);
  assert.equal(new URL(url).searchParams.get('state'), estado);
});

test('un login que se paso de los diez minutos no se puede canjear', async (t) => {
  /* EL BUG: canjearCodigo no miraba `vence`, y lo pendiente se purgaba
     solo cuando alguien empezaba OTRO login. O sea que un state solo,
     sin nadie mas entrando, se estiraba indefinidamente: la ventana de
     diez minutos no existia. */
  t.mock.timers.enable({ apis: ['Date'] });

  const { estado } = kick.urlLogin({ redirect: REDIRECT });
  assert.equal(kick.hayLoginPendiente(estado), true);

  t.mock.timers.tick(11 * 60 * 1000);   // once minutos despues, sin que entre nadie mas

  await assert.rejects(
    () => kick.canjearCodigo({ code: 'un-codigo', estado }),
    /vencio/,
    'un login vencido no se canjea',
  );
  assert.equal(kick.hayLoginPendiente(estado), false, 'y ademas se consumio');
});

test('un state inventado no se canjea', async () => {
  await assert.rejects(
    () => kick.canjearCodigo({ code: 'x', estado: 'no-existe-este-state' }),
    /desconocido/,
  );
});

test('los logins pendientes no crecen para siempre', () => {
  /* Sin tope, mil pedidos a /oauth/kick/entrar dejan mil entradas en
     memoria que solo se limpian si alguien empieza otro login. */
  const primero = kick.urlLogin({ redirect: REDIRECT }).estado;
  assert.equal(kick.hayLoginPendiente(primero), true);

  for (let i = 0; i < 1000; i++) kick.urlLogin({ redirect: REDIRECT });

  assert.equal(kick.hayLoginPendiente(primero), false, 'el mas viejo se solto');
});
