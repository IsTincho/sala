/* ============================================================
   El servidor de punta a punta: se levanta de verdad en un puerto
   libre y se le pega con pedidos HTTP reales.

   Se prueba asi y no llamando a las funciones sueltas porque lo que
   hay que garantizar es lo que ve alguien de afuera: que una ruta que
   no existe de 404, que el webhook sin firma de 401, que el SSE
   arranque mandando el estado. Un test que llama al manejador
   directamente puede pasar con el enrutador roto.
   ============================================================ */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const DATOS = path.join(AQUI, '..', 'servidor', 'datos');

/* Las variables se ponen ANTES de importar el servidor: kick.js y
   index.js las leen al cargarse. Por eso el import es dinamico y esta
   mas abajo, y no arriba con los demas.

   Ninguno de estos valores es un secreto: son de mentira y no salen de
   este proceso. El unico pedido que sale a la red en todo el archivo
   es ninguno. */
process.env.MODO = 'local';
process.env.KICK_SLUG = 'istincho';
process.env.KICK_CLIENT_ID = 'cliente-de-prueba';
process.env.KICK_CLIENT_SECRET = 'secreto-de-prueba';
process.env.URL_BASE = 'https://sala.example';
process.env.CLAVE_CIFRADO = crypto.randomBytes(32).toString('base64');

const { crearServidor } = await import('../servidor/index.js');
const canales = await import('../servidor/canales.js');
const webhook = await import('../servidor/webhook.js');
const almacen = await import('../servidor/almacen.js');

/* Par RSA propio para firmar el fixture, igual que en webhook.test.js. */
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
webhook.fijarClavePublica(publicKey);

const PAYLOAD = fs.readFileSync(path.join(AQUI, 'fijos', 'chat-mensaje.json'), 'utf8');

function firmar(id, ts, crudo) {
  const s = crypto.createSign('RSA-SHA256');
  s.update(`${id}.${ts}.${crudo}`);
  s.end();
  return s.sign(privateKey, 'base64');
}

/* ------------------------------------------------------- el servidor */

let servidor;
let raiz;

test.before(async () => {
  servidor = crearServidor();
  /* puerto 0 = el que el sistema tenga libre. Fijar uno haria que dos
     corridas en paralelo se pisen. */
  await new Promise(ok => servidor.listen(0, '127.0.0.1', ok));
  raiz = `http://127.0.0.1:${servidor.address().port}`;
});

test.after(async () => {
  canales.cerrarTodo();
  await new Promise(ok => servidor.close(ok));
  /* los tests no dejan basura: el almacen en modo archivo escribe aca */
  await fsp.rm(DATOS, { recursive: true, force: true });
});

/* --------------------------------------------------------- enrutador */

test('una ruta que no existe da 404', async () => {
  const r = await fetch(`${raiz}/no-existe-esta-ruta`);
  assert.equal(r.status, 404);
  assert.equal(await r.text(), 'no existe');
});

test('una ruta de API que no existe tambien da 404', async () => {
  const r = await fetch(`${raiz}/api/lo-que-sea`);
  assert.equal(r.status, 404);
});

test('una ruta conocida con el metodo equivocado da 405 y dice cual acepta', async () => {
  const r = await fetch(`${raiz}/kick/webhook`);   // es POST
  assert.equal(r.status, 405);
  assert.equal(r.headers.get('allow'), 'POST');
});

test('la raiz sirve la pagina de estado', async () => {
  const r = await fetch(`${raiz}/`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/html/);
  assert.match(r.headers.get('cache-control'), /no-cache/, 'el codigo no se cachea');
  assert.match(await r.text(), /Sala/);
});

test('el CSS y el JS comunes se sirven', async () => {
  for (const [ruta, tipo] of [['/comun/base.css', /text\/css/], ['/comun/bus.js', /javascript/]]) {
    const r = await fetch(raiz + ruta);
    assert.equal(r.status, 200, ruta);
    assert.match(r.headers.get('content-type'), tipo, ruta);
  }
});

test('no se puede salir de paginas/ con ..', async () => {
  /* fetch normaliza los ".." antes de mandar, asi que para probar el
     traversal de verdad hay que armar el pedido crudo con http. El
     %2e%2e es un ".." disfrazado: si el servidor decodifica y no
     revisa, sirve servidor/index.js y de ahi a servidor/.env hay un
     paso. */
  const crudos = [
    '/%2e%2e/servidor/index.js',
    '/..%2fservidor%2findex.js',
    '/comun/%2e%2e/%2e%2e/servidor/kick.js',
  ];
  for (const ruta of crudos) {
    const codigo = await new Promise((ok, mal) => {
      const req = http.get({ host: '127.0.0.1', port: servidor.address().port, path: ruta },
        res => { res.resume(); ok(res.statusCode); });
      req.on('error', mal);
    });
    assert.equal(codigo, 404, `${ruta} tendria que dar 404`);
  }
});

/* --------------------------------------------------------------- api */

test('/api/estado cuenta como esta el servidor sin filtrar secretos', async () => {
  const r = await fetch(`${raiz}/api/estado`);
  assert.equal(r.status, 200);
  const d = await r.json();

  assert.equal(d.modo, 'local');
  assert.equal(d.slug, 'istincho');
  assert.equal(typeof d.hora, 'number');
  assert.ok(d.almacen.modo, 'dice donde guarda');
  assert.equal(d.listo.kick, true, 'con credenciales cargadas avisa que esta listo');
  assert.equal(d.listo.cifrado, true);

  /* Que nunca se escape un valor. Esto es un test de seguridad: si
     alguien agrega un campo con el client secret adentro, revienta. */
  const texto = JSON.stringify(d);
  for (const secreto of ['secreto-de-prueba', process.env.CLAVE_CIFRADO]) {
    assert.equal(texto.includes(secreto), false, 'el estado no puede traer secretos');
  }
});

/* ------------------------------------------------------------- oauth */

test('/oauth/kick/entrar manda a id.kick.com con PKCE', async () => {
  const r = await fetch(`${raiz}/oauth/kick/entrar`, { redirect: 'manual' });
  assert.equal(r.status, 302);

  const destino = new URL(r.headers.get('location'));
  assert.equal(destino.origin, 'https://id.kick.com');
  assert.equal(destino.pathname, '/oauth/authorize');
  assert.equal(destino.searchParams.get('response_type'), 'code');
  assert.equal(destino.searchParams.get('client_id'), 'cliente-de-prueba');
  assert.equal(destino.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(destino.searchParams.get('code_challenge'), 'tiene que ir el desafio');
  assert.ok(destino.searchParams.get('state'), 'y el state');

  /* el redirect_uri sale de URL_BASE, que es el que tiene que estar
     registrado en la app de Kick */
  assert.equal(destino.searchParams.get('redirect_uri'), 'https://sala.example/oauth/kick/volver');

  /* el verificador NO puede viajar: si viaja, PKCE no sirve de nada */
  assert.equal(destino.searchParams.has('code_verifier'), false);
});

test('el espectador y el dueño piden scopes distintos', async () => {
  const scopesDe = async rol => {
    const r = await fetch(`${raiz}/oauth/kick/entrar?rol=${rol}`, { redirect: 'manual' });
    return new URL(r.headers.get('location')).searchParams.get('scope').split(' ');
  };

  const espectador = await scopesDe('espectador');
  assert.deepEqual(espectador, ['user:read', 'chat:write'],
    'al espectador se le pide lo minimo para hablar con su nombre');

  const dueno = await scopesDe('dueno');
  assert.ok(dueno.includes('events:subscribe'), 'el dueño ademas suscribe eventos');
});

test('dos logins seguidos no comparten el desafio', async () => {
  const desafioDe = async () => {
    const r = await fetch(`${raiz}/oauth/kick/entrar`, { redirect: 'manual' });
    return new URL(r.headers.get('location')).searchParams.get('code_challenge');
  };
  assert.notEqual(await desafioDe(), await desafioDe());
});

test('/oauth/kick/volver con un state inventado no explota', async () => {
  const r = await fetch(`${raiz}/oauth/kick/volver?code=x&state=inventado`);
  assert.equal(r.status, 200);
  assert.match(await r.text(), /No se pudo completar el login/);
});

test('las cuatro rutas de oauth existen', async () => {
  for (const ruta of ['/oauth/kick/entrar', '/oauth/kick/volver',
                      '/oauth/twitch/entrar', '/oauth/twitch/volver']) {
    const r = await fetch(raiz + ruta, { redirect: 'manual' });
    assert.notEqual(r.status, 404, `${ruta} tiene que existir`);
  }
});

/* ----------------------------------------------------------- webhook */

test('/kick/webhook da 401 a un cuerpo sin firma', async () => {
  const r = await fetch(`${raiz}/kick/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: PAYLOAD,
  });
  assert.equal(r.status, 401);
  assert.equal(await r.text(), 'firma invalida');
});

test('/kick/webhook da 401 si la firma es de otro cuerpo', async () => {
  const id = 'ID-CUERPO-CAMBIADO';
  const ts = '2026-01-14T16:08:06Z';
  const r = await fetch(`${raiz}/kick/webhook`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Kick-Event-Message-Id': id,
      'Kick-Event-Message-Timestamp': ts,
      'Kick-Event-Signature': firmar(id, ts, PAYLOAD),
      'Kick-Event-Type': 'chat.message.sent',
      'Kick-Event-Version': '1',
    },
    body: PAYLOAD.replace('que peli mas larga', 'spam'),
  });
  assert.equal(r.status, 401);
});

test('/kick/webhook da 200 al fixture firmado y no lo procesa dos veces', async () => {
  const id = `ID-BUENO-${Date.now()}`;
  const ts = '2026-01-14T16:08:06Z';
  const cabeceras = {
    'Content-Type': 'application/json',
    'Kick-Event-Message-Id': id,
    'Kick-Event-Message-Timestamp': ts,
    'Kick-Event-Signature': firmar(id, ts, PAYLOAD),
    'Kick-Event-Type': 'chat.message.sent',
    'Kick-Event-Version': '1',
  };

  const primera = await fetch(`${raiz}/kick/webhook`, { method: 'POST', headers: cabeceras, body: PAYLOAD });
  assert.equal(primera.status, 200);
  assert.equal(await primera.text(), 'ok');

  /* Kick reintenta. El segundo envio tiene que contestar 200 (para que
     deje de reintentar) pero decir que ya lo vio. */
  const repetida = await fetch(`${raiz}/kick/webhook`, { method: 'POST', headers: cabeceras, body: PAYLOAD });
  assert.equal(repetida.status, 200);
  assert.equal(await repetida.text(), 'repetido');
});

/* --------------------------------------------------------------- sse */

test('/eventos/:slug abre SSE y lo primero que manda es el estado', async () => {
  const corte = new AbortController();
  const r = await fetch(`${raiz}/eventos/istincho`, { signal: corte.signal });

  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/event-stream/);
  assert.match(r.headers.get('cache-control'), /no-cache/);

  const lector = r.body.getReader();
  const { value } = await lector.read();
  const trozo = new TextDecoder().decode(value);

  assert.match(trozo, /event: estado/, 'el primer evento se llama estado');

  const linea = trozo.split('\n').find(l => l.startsWith('data: '));
  const estado = JSON.parse(linea.slice(6));
  assert.equal(estado.slug, 'istincho');
  assert.equal(estado.conectados, 1);
  assert.equal(estado.reloj, null);

  corte.abort();
  await lector.cancel().catch(() => {});
});

test('el evento de prueba llega a quien esta escuchando ese canal', async () => {
  const corte = new AbortController();
  const r = await fetch(`${raiz}/eventos/istincho`, { signal: corte.signal });
  const lector = r.body.getReader();
  await lector.read();   // el estado inicial

  const enviado = await fetch(`${raiz}/api/prueba/webhook?canal=istincho`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hola: 'mundo' }),
  });
  assert.equal(enviado.status, 200);
  assert.equal((await enviado.json()).llegoA, 1, 'llego al que estaba escuchando');

  const { value } = await lector.read();
  const trozo = new TextDecoder().decode(value);
  assert.match(trozo, /event: prueba/);
  assert.match(trozo, /"hola":"mundo"/);

  corte.abort();
  await lector.cancel().catch(() => {});
});

test('al soltar la conexion el canal deja de contarla', async () => {
  const corte = new AbortController();
  const r = await fetch(`${raiz}/eventos/otrocanal`, { signal: corte.signal });
  await r.body.getReader().read();
  assert.equal(canales.conectados('otrocanal'), 1);

  corte.abort();
  /* el close del socket no es inmediato: se le da un respiro */
  await new Promise(ok => setTimeout(ok, 100));
  assert.equal(canales.conectados('otrocanal'), 0, 'una conexion cerrada no se queda colgada');
});

test('el slug del canal no distingue mayusculas', async () => {
  const corte = new AbortController();
  const r = await fetch(`${raiz}/eventos/IsTincho`, { signal: corte.signal });
  const lector = r.body.getReader();
  const { value } = await lector.read();
  const linea = new TextDecoder().decode(value).split('\n').find(l => l.startsWith('data: '));
  assert.equal(JSON.parse(linea.slice(6)).slug, 'istincho');

  corte.abort();
  await lector.cancel().catch(() => {});
});
