/* ============================================================
   El login no puede rebotar a otro sitio.

   Los dos flujos de OAuth aceptan un `?destino=` para volver a donde
   estaba la persona cuando tocó "entrar". Ese parámetro lo escribe
   quien arma el link, o sea cualquiera: `destinoSeguro()` es lo único
   que decide qué llega a la cabecera `Location`, y sólo deja pasar una
   ruta de este mismo sitio (una barra, y que la segunda no sea otra
   barra ni una contrabarra, porque `//otro.com` es una URL absoluta
   disfrazada).

   No tenía ninguna prueba. Aceptar cualquier `d` dejaba las 439 en
   verde. Y para Kick queda medio tapado porque `kick.js` tiene su
   propia copia de la guarda, pero PARA TWITCH NO: `twitchEntrar` mete
   el `destino` crudo en `pendientesTwitch` y el filtro de `index.js`
   es el único que hay entre eso y el `Location`.

   Un redirect abierto en un callback de OAuth no es un detalle: es el
   link de "entrar con Kick" del propio sitio llevando a una copia de la
   página de login en otro dominio.

   ---------------------------------------------------------------
   NADA SALE A INTERNET

   Se reemplaza el `fetch` global por uno que contesta como Twitch sólo
   para id.twitch.tv y api.twitch.tv, y las conexiones de chat se fijan
   con `chat.fijarConexiones` para que el WebSocket de EventSub no se
   abra de verdad.
   ============================================================ */

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';

/* Las variables van ANTES de importar el servidor: index.js, kick.js y
   twitch.js las leen al cargarse. Ninguna es un secreto: son de mentira
   y no salen de este proceso. El almacén es propio para no pisarse con
   los otros archivos, que corren en paralelo. */
const DATOS = path.join(os.tmpdir(), 'sala-pruebas-oauth-destino');
process.env.SALA_DATOS = DATOS;
process.env.MODO = 'local';
process.env.KICK_SLUG = 'istincho';
process.env.KICK_CLIENT_ID = 'cliente-de-prueba';
process.env.KICK_CLIENT_SECRET = 'secreto-de-prueba';
process.env.TWITCH_CLIENT_ID = 'cliente-twitch-de-prueba';
process.env.TWITCH_CLIENT_SECRET = 'secreto-twitch-de-prueba';
process.env.URL_BASE = 'https://sala.example';
process.env.CLAVE_CIFRADO = crypto.randomBytes(32).toString('base64');

const { crearServidor } = await import('../servidor/index.js');
const canales = await import('../servidor/canales.js');
const sesion = await import('../servidor/sesion.js');
const chat = await import('../servidor/chat.js');
const vinculos = await import('../servidor/vinculos.js');

/* ------------------------------------------------ el Twitch de mentira */

const fetchDeVerdad = globalThis.fetch;

globalThis.fetch = async (entrada, opciones) => {
  const url = String(typeof entrada === 'string' ? entrada : entrada?.url ?? '');

  if (url.startsWith('https://id.twitch.tv/oauth2/token')) {
    return new Response(JSON.stringify({
      access_token: 'acceso-twitch-de-mentira',
      refresh_token: 'refresco-twitch-de-mentira',
      expires_in: 3600,
      scope: ['user:read:chat', 'user:write:chat'],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  if (url.startsWith('https://api.twitch.tv/helix/users')) {
    return new Response(JSON.stringify({
      data: [{ id: '777', login: 'istincho', display_name: 'IsTincho', profile_image_url: '' }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  /* Los pedidos de este archivo al servidor de prueba son fetch
     también: esos pasan. */
  return fetchDeVerdad(entrada, opciones);
};

/* La conexión de EventSub no se abre de verdad. Las dos fábricas o
   ninguna: `fijarConexiones` lo exige para que no quede la de IRC de
   verdad puesta. */
class ConexionFalsa {
  constructor(opciones) { this.opciones = opciones; this.ultimaLlegada = null; }
  conectar() { this.conectada = true; }
  cerrar() { this.cerrada = true; }
}

/* --------------------------------------------------------- arranque */

let servidor;
let raiz;
let sesionDueno = '';

test.before(async () => {
  chat.fijarConexiones({
    eventSub: opciones => new ConexionFalsa(opciones),
    irc: opciones => new ConexionFalsa(opciones),
  });

  sesionDueno = `${sesion.COOKIES.dueno}=` +
    await sesion.crear({ tipo: 'dueno', usuario: '99', nombre: 'IsTincho', slug: 'istincho' });

  servidor = crearServidor();
  await new Promise(ok => servidor.listen(0, '127.0.0.1', ok));
  raiz = `http://127.0.0.1:${servidor.address().port}`;
});

test.after(async () => {
  chat.parar();
  chat.fijarConexiones();
  globalThis.fetch = fetchDeVerdad;
  canales.cerrarTodo();
  await vinculos.olvidar('istincho', 'twitch');
  await new Promise(ok => servidor.close(ok));
  await fsp.rm(DATOS, { recursive: true, force: true });
});

/**
 * Hace el viaje entero de Twitch con un `destino` puesto y devuelve la
 * cabecera `Location` con la que termina.
 *
 * Es el viaje entero y no una llamada a la función suelta porque el
 * `destino` cruza el servidor en dos tramos: se guarda crudo en
 * `pendientesTwitch` cuando empieza el login y recién se filtra al
 * salir. Un test de la función suelta pasaría con el filtro puesto en
 * cualquier lado, incluso en ninguno.
 */
async function volverDeTwitchCon(destino) {
  const entrar = await fetch(
    `${raiz}/oauth/twitch/entrar?destino=${encodeURIComponent(destino)}`,
    { redirect: 'manual' },
  );
  assert.equal(entrar.status, 302, 'el login tiene que arrancar');
  const estado = new URL(entrar.headers.get('location')).searchParams.get('state');
  assert.ok(estado, 'sin state no hay callback que valga');

  const volver = await fetch(
    `${raiz}/oauth/twitch/volver?code=un-code-cualquiera&state=${encodeURIComponent(estado)}`,
    { redirect: 'manual', headers: { Cookie: sesionDueno } },
  );
  return volver;
}

/* --------------------------------------------------------- las pruebas */

test('el destino bueno se respeta: la persona vuelve a donde estaba', async () => {
  /* La mitad que impide que el arreglo sea "mandar siempre a /panel".
     Sin esto, borrar la función entera y devolver '' pasaría igual. */
  const r = await volverDeTwitchCon('/sala/istincho');
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/sala/istincho');
});

test('un destino de otro sitio NUNCA llega al Location', async () => {
  /*
   * `//otro.com/x` es el que importa: no parece una URL absoluta, pero
   * el navegador la lee como `https://otro.com/x` y hereda el esquema.
   * `\\otro.com` es la misma trampa con contrabarras, que varios
   * navegadores normalizan a barras.
   *
   * Para Twitch esta guarda es la ÚNICA: `twitchEntrar` guarda el
   * `destino` crudo y nadie lo mira hasta acá.
   */
  const afuera = [
    '//otro.com/x',
    '///otro.com/x',
    '\\\\otro.com\\x',
    '/\\otro.com/x',
    'https://otro.com/x',
    'http://otro.com/x',
    '//sala.example.attacker.test/',
    'javascript:alert(1)',
    'otro.com/x',
    '',
  ];

  for (const destino of afuera) {
    const r = await volverDeTwitchCon(destino);
    const location = r.headers.get('location');
    assert.equal(r.status, 302, `${JSON.stringify(destino)} no terminó en redirección`);
    assert.equal(location, '/panel',
      `${JSON.stringify(destino)} salió por el Location como ${JSON.stringify(location)}`);
  }
});

test('un destino que se pasa de vivo no puede volverse absoluto al resolverse', async () => {
  /* La prueba de fuego, sin mirar la forma del string: se resuelve el
     Location contra un origen cualquiera y el resultado tiene que caer
     en ESE origen. Si alguna forma nueva se escapara, esto la ve aunque
     la regex no la haya previsto. */
  for (const destino of ['//otro.com/x', '/\\otro.com', 'https://otro.com', '/sala/istincho']) {
    const r = await volverDeTwitchCon(destino);
    const resuelta = new URL(r.headers.get('location'), 'https://sala.example');
    assert.equal(resuelta.origin, 'https://sala.example',
      `${JSON.stringify(destino)} terminó apuntando a ${resuelta.origin}`);
  }
});
