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
import net from 'node:net';
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
process.env.TWITCH_CLIENT_ID = 'cliente-twitch-de-prueba';
process.env.TWITCH_CLIENT_SECRET = 'secreto-twitch-de-prueba';
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

/* Se firma sobre BYTES, igual que Kick: `${id}.${ts}.` en utf8 pegado
   al cuerpo tal cual llega. Firmar sobre un string obligaria a
   decodificar el cuerpo, que es justo lo que no hay que hacer. */
function firmar(id, ts, crudo) {
  const cuerpo = Buffer.isBuffer(crudo) ? crudo : Buffer.from(String(crudo), 'utf8');
  const s = crypto.createSign('RSA-SHA256');
  s.update(Buffer.concat([Buffer.from(`${id}.${ts}.`, 'utf8'), cuerpo]));
  s.end();
  return s.sign(privateKey, 'base64');
}

/* Kick manda el timestamp del evento y el servidor le pide que sea
   reciente (ventana de 10 minutos). Un fixture con fecha fija dejaria
   de pasar en cuanto pasaran diez minutos del dia en que se escribio. */
const ahoraISO = () => new Date().toISOString();

const esperar = ms => new Promise(ok => setTimeout(ok, ms));

async function esperarHasta(condicion, { tope = 3000, paso = 20 } = {}) {
  const limite = Date.now() + tope;
  while (!condicion()) {
    if (Date.now() > limite) throw new Error('tiempo de espera agotado');
    await esperar(paso);
  }
}

/** El primer bloque SSE del stream, ya separado en campos. */
function bloqueSse(trozo) {
  const campos = { data: [] };
  for (const linea of trozo.split('\n\n')[0].split('\n')) {
    const i = linea.indexOf(':');
    if (i < 0) continue;
    const campo = linea.slice(0, i);
    const valor = linea.slice(i + 1).replace(/^ /, '');
    if (campo === 'data') campos.data.push(valor);
    else campos[campo] = valor;
  }
  return campos;
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

test('// da 404 y no 500', async () => {
  /* `new URL('//', 'http://sala')` es una referencia scheme-relative
     con host vacio: tira ERR_INVALID_URL. Sin atajarlo, el parseo de
     la URL salia del manejador como 500 con stack trace, y `//` es de
     lo primero que prueba cualquier bot. */
  const codigo = await new Promise((ok, mal) => {
    const req = http.get({ host: '127.0.0.1', port: servidor.address().port, path: '//' },
      res => { res.resume(); ok(res.statusCode); });
    req.on('error', mal);
  });
  assert.equal(codigo, 404);
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

test('/oauth/twitch/entrar manda a id.twitch.tv con state y los scopes del chat', async () => {
  const r = await fetch(`${raiz}/oauth/twitch/entrar`, { redirect: 'manual' });
  assert.equal(r.status, 302);

  const destino = new URL(r.headers.get('location'));
  assert.equal(destino.origin, 'https://id.twitch.tv');
  assert.equal(destino.searchParams.get('response_type'), 'code');
  assert.equal(destino.searchParams.get('redirect_uri'), 'https://sala.example/oauth/twitch/volver');
  assert.deepEqual(destino.searchParams.get('scope').split(' '), ['user:read:chat', 'user:write:chat']);
  assert.ok(destino.searchParams.get('state'), 'el state es lo unico que ata el callback');
});

test('/oauth/twitch/volver con un state que no esta no explota', async () => {
  const r = await fetch(`${raiz}/oauth/twitch/volver?code=x&state=inventado`);
  assert.equal(r.status, 200);
  assert.match(await r.text(), /Ese login ya no vale/);
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
  const ts = ahoraISO();
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
  const ts = ahoraISO();
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

/* --------------------------------------------------- cuerpo partido

   EL BUG: el cuerpo se leia con `d += trozo`, o sea decodificando cada
   pedazo de TCP por separado. El corte entre paquetes cae donde quiere
   y, si parte un caracter UTF-8 al medio (cualquier emoji o acento),
   los bytes partidos se vuelven U+FFFD: el cuerpo reconstruido ya no
   es el que Kick firmo y la verificacion da 401. El mismo mensaje
   entero daba 200. */

/** Manda un POST a mano, partiendo el cuerpo en `corte` bytes. */
function postPartido(cuerpo, corte, cabeceras) {
  return new Promise((ok, mal) => {
    const socket = net.connect(servidor.address().port, '127.0.0.1', () => {
      socket.setNoDelay(true);   // sin Nagle: cada write es un paquete
      const lineas = [
        'POST /kick/webhook HTTP/1.1',
        'Host: 127.0.0.1',
        ...Object.entries(cabeceras).map(([k, v]) => `${k}: ${v}`),
        `Content-Length: ${cuerpo.length}`,
        'Connection: close',
        '', '',
      ];
      socket.write(lineas.join('\r\n'));
      if (corte === null) {
        socket.write(cuerpo);
      } else {
        socket.write(cuerpo.subarray(0, corte));
        setTimeout(() => socket.write(cuerpo.subarray(corte)), 40);
      }
    });
    let respuesta = '';
    socket.setEncoding('utf8');
    socket.on('data', d => { respuesta += d; });
    socket.on('end', () => ok(Number(respuesta.split(' ')[1])));
    socket.on('error', mal);
  });
}

test('un cuerpo firmado con emoji vale igual aunque el emoji llegue partido en dos paquetes', async () => {
  const cuerpo = Buffer.from(JSON.stringify({
    broadcaster: { channel_slug: 'istincho' },
    content: 'que peli mas larga 🎉',
  }), 'utf8');

  /* El emoji son cuatro bytes en UTF-8; se corta justo en el medio. */
  const emoji = Buffer.from('🎉', 'utf8');
  const enElEmoji = cuerpo.indexOf(emoji) + 2;
  assert.ok(enElEmoji > 2, 'el emoji tiene que estar en el cuerpo');

  const cabecerasDe = (id, ts) => ({
    'Content-Type': 'application/json',
    'Kick-Event-Message-Id': id,
    'Kick-Event-Message-Timestamp': ts,
    'Kick-Event-Signature': firmar(id, ts, cuerpo),
    'Kick-Event-Type': 'chat.message.sent',
    'Kick-Event-Version': '1',
  });

  const ts = ahoraISO();
  const casos = [
    ['entero',              null],
    ['cortado en limpio',   cuerpo.indexOf(emoji)],   // justo antes del emoji
    ['cortado en el emoji', enElEmoji],
  ];

  for (const [nombre, corte] of casos) {
    const id = `ID-PARTIDO-${nombre.replace(/ /g, '-')}-${Date.now()}`;
    const codigo = await postPartido(cuerpo, corte, cabecerasDe(id, ts));
    assert.equal(codigo, 200, `${nombre}: la firma tiene que dar igual`);
  }
});

/** Un POST con el cuerpo entero, que resuelve apenas ve la linea de estado. */
function postGrande(ruta, cuerpo) {
  return new Promise((ok, mal) => {
    let listo = false;
    const terminar = fn => (...args) => { if (!listo) { listo = true; fn(...args); } };
    const salioBien = terminar(ok);
    const salioMal = terminar(mal);

    const socket = net.connect(servidor.address().port, '127.0.0.1', () => {
      socket.write([
        `POST ${ruta} HTTP/1.1`,
        'Host: 127.0.0.1',
        'Content-Type: application/json',
        `Content-Length: ${cuerpo.length}`,
        'Connection: close',
        '', '',
      ].join('\r\n'));
      /* El callback traga el error de escritura: si el servidor
         contesta y cierra mientras todavia estamos subiendo, eso es
         correcto y no es lo que se esta midiendo. */
      socket.write(cuerpo, () => {});
    });

    let respuesta = '';
    socket.setEncoding('utf8');
    socket.on('data', d => {
      respuesta += d;
      if (respuesta.includes('\r\n')) { salioBien(Number(respuesta.split(' ')[1])); socket.destroy(); }
    });
    socket.on('error', salioMal);
    socket.on('close', () => salioMal(new Error('el servidor corto sin contestar')));
  });
}

test('/kick/webhook da 413 a un cuerpo enorme, sin stack trace y sin cortar de prepo', async () => {
  /* EL BUG: leerCuerpo rechazaba y hacia req.destroy() ahi mismo, asi
     que el 500 se escribia sobre un socket ya muerto: el cliente veia
     ECONNRESET y quedaba un stack trace por pedido en los logs.
     /kick/webhook no pide autenticacion, o sea que cualquiera podia
     llenar los logs de Railway a voluntad. */
  const grande = Buffer.alloc(1_200_000, 0x61);   // el tope es 1 MB

  const errores = [];
  const errorOriginal = console.error;
  console.error = (...args) => errores.push(args);
  let codigo;
  try {
    codigo = await postGrande('/kick/webhook', grande);
  } finally {
    console.error = errorOriginal;
  }

  assert.equal(codigo, 413, 'un cuerpo demasiado grande se contesta, no se corta');
  assert.deepEqual(errores, [], 'y no deja un stack trace en los logs');
});

test('/kick/webhook descarta un evento viejo aunque este bien firmado', async () => {
  /* Una firma RSA no vence: quien capture un webhook valido lo puede
     reenviar cuando quiera y va a verificar igual. Lo unico que lo
     atajaba era el anillo de 500 ids, que se vacia solo. */
  const id = `ID-VIEJO-${Date.now()}`;
  const ts = new Date(Date.now() - 40 * 60 * 1000).toISOString();
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
    body: PAYLOAD,
  });
  /* 200 y no 401: no queremos que Kick lo reintente para siempre. */
  assert.equal(r.status, 200);
  assert.equal(await r.text(), 'vencido');
});

test('un evento que no se pudo procesar no queda marcado como visto', async () => {
  /* EL BUG: el id se marcaba ANTES de procesar. Si el procesamiento
     fallaba, el reintento de Kick se contestaba "repetido" y el evento
     se perdia. Aca el JSON esta roto a proposito: las dos veces tiene
     que dar 400, no un "repetido" la segunda. */
  const id = `ID-ROTO-${Date.now()}`;
  const ts = ahoraISO();
  const roto = '{ esto no es json';
  const cabeceras = {
    'Content-Type': 'application/json',
    'Kick-Event-Message-Id': id,
    'Kick-Event-Message-Timestamp': ts,
    'Kick-Event-Signature': firmar(id, ts, roto),
    'Kick-Event-Type': 'chat.message.sent',
    'Kick-Event-Version': '1',
  };

  const primera = await fetch(`${raiz}/kick/webhook`, { method: 'POST', headers: cabeceras, body: roto });
  assert.equal(primera.status, 400);

  const reintento = await fetch(`${raiz}/kick/webhook`, { method: 'POST', headers: cabeceras, body: roto });
  assert.equal(reintento.status, 400, 'el reintento se vuelve a intentar de verdad');
  assert.equal(await reintento.text(), 'json invalido');
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

  /* El tipo viaja adentro del data y NO como `event: <tipo>`: un
     evento SSE con nombre solo llega al listener de ese nombre y nunca
     dispara 'message', asi que el cliente no podria recibir un tipo
     que todavia no conoce. */
  const bloque = bloqueSse(trozo.slice(trozo.indexOf('id:')));
  assert.equal(bloque.event, undefined, 'los eventos no van con nombre');

  const estado = JSON.parse(bloque.data[0]);
  assert.equal(estado.tipo, 'estado', 'el tipo va adentro del data');
  assert.equal(estado.slug, 'istincho');
  assert.equal(estado.conectados, 1);
  assert.equal(estado.reloj, null);

  corte.abort();
  await lector.cancel().catch(() => {});
});

test('el cliente del bus recibe cualquier tipo, no solo los que ya conocia', async () => {
  /* EL BUG: el servidor difundia 'kick' (webhook real) y 'prueba' como
     eventos SSE con nombre, y paginas/comun/bus.js escuchaba una lista
     fija de tres nombres. Por la especificacion de SSE esos eventos no
     llegaban a ninguna pagina, sin un solo error. El test viejo miraba
     el stream crudo, asi que pasaba igual.

     Este corre el bus.js DE VERDAD, con un EventSource que despacha
     como despacha el navegador. */
  const { EventSourceFalso, fijarRaiz } = await import('./fijos/eventsource-falso.js');
  fijarRaiz(raiz);
  globalThis.EventSource = EventSourceFalso;
  globalThis.window = globalThis.window ?? {};
  await import('../paginas/comun/bus.js');

  const recibidos = [];
  const conexion = globalThis.window.Sala.conectar('canal-del-cliente',
    (tipo, datos) => recibidos.push({ tipo, datos }));

  try {
    await esperarHasta(() => recibidos.some(r => r.tipo === 'estado'));

    const enviado = await fetch(`${raiz}/api/prueba/webhook?canal=canal-del-cliente`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hola: 'mundo' }),
    });
    assert.equal((await enviado.json()).llegoA, 1);

    await esperarHasta(() => recibidos.some(r => r.tipo === 'prueba'));
    const prueba = recibidos.find(r => r.tipo === 'prueba');
    assert.equal(prueba.datos.cuerpo.hola, 'mundo', 'el evento llega entero a la pagina');
  } finally {
    conexion.cerrar();
  }
});

/**
 * Un pedido crudo por socket que NO cierra: se queda escuchando y
 * resuelve en cuanto llegan las cabeceras.
 *
 * Con `fetch(..., {method:'HEAD'})` esto no se puede probar: undici da
 * la respuesta por terminada al recibir las cabeceras y cierra el
 * socket, y ese cierre dispara el `close` que limpia al cliente del
 * canal antes de que el assert lo mire. O sea que el test pasaba
 * tambien con el codigo roto. Con el socket abierto, el cliente
 * fantasma se queda contando y el assert lo ve.
 */
function pedidoQueNoCierra(metodo, ruta, { tope = 3000 } = {}) {
  return new Promise((ok, mal) => {
    let listo = false;
    /* Sin este tope el test no falla: se cuelga. Un HEAD contra el
       handler de SSE ni siquiera llega a mandar las cabeceras, porque
       Node no las descarga hasta el primer write con cuerpo y en un
       HEAD no hay cuerpo. Eso es exactamente lo que le pasaba a
       `curl -I`. */
    let socket;
    const reloj = setTimeout(() => {
      socket?.destroy();
      salioMal(new Error(`${metodo} ${ruta} no contesto en ${tope} ms`));
    }, tope);
    reloj.unref();

    const terminar = fn => (...args) => { if (!listo) { listo = true; clearTimeout(reloj); fn(...args); } };
    const salioBien = terminar(ok);
    const salioMal = terminar(mal);

    socket = net.connect(servidor.address().port, '127.0.0.1', () => {
      socket.write([
        `${metodo} ${ruta} HTTP/1.1`,
        'Host: 127.0.0.1',
        'Accept: text/event-stream',
        '', '',
      ].join('\r\n'));
    });
    let respuesta = '';
    socket.setEncoding('utf8');
    socket.on('data', d => {
      respuesta += d;
      if (respuesta.includes('\r\n\r\n')) {
        const cabeceras = respuesta.split('\r\n\r\n')[0];
        salioBien({
          codigo: Number(cabeceras.split(' ')[1]),
          cabeceras: cabeceras.toLowerCase(),
          cerrar: () => socket.destroy(),
        });
      }
    });
    socket.on('error', salioMal);
    socket.on('close', () => salioMal(new Error('cerro sin contestar')));
  });
}

test('HEAD /eventos/:slug contesta y no deja un cliente fantasma', async () => {
  /* El enrutador deja pasar HEAD como GET, asi que el handler de SSE
     escribia eventos en una respuesta sin cuerpo: `curl -I` se colgaba
     hasta el timeout y el canal quedaba con un cliente que nadie mira.
     Cualquier monitor de uptime hace exactamente eso. */
  const r = await pedidoQueNoCierra('HEAD', '/eventos/canal-head');
  try {
    assert.equal(r.codigo, 200);
    assert.match(r.cabeceras, /content-type: text\/event-stream/);

    await esperar(200);
    assert.equal(canales.conectados('canal-head'), 0, 'un HEAD no abre stream');
    assert.equal(canales.hayCanal('canal-head'), false, 'ni siquiera crea el canal');
  } finally {
    r.cerrar();
  }
});

test('un slug con un escape roto da 404 y no 500', async () => {
  /* decodeURIComponent('%ZZ') tira URIError; sin atajarlo salia un 500
     con stack trace en los logs por una URL que nadie escribio bien. */
  const codigo = await new Promise((ok, mal) => {
    const req = http.get({ host: '127.0.0.1', port: servidor.address().port, path: '/eventos/%ZZ' },
      res => { res.resume(); ok(res.statusCode); });
    req.on('error', mal);
  });
  assert.equal(codigo, 404);
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
  assert.match(trozo, /"tipo":"prueba"/);
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
  const trozo = new TextDecoder().decode(value);
  const bloque = bloqueSse(trozo.slice(trozo.indexOf('id:')));
  assert.equal(JSON.parse(bloque.data[0]).slug, 'istincho');

  corte.abort();
  await lector.cancel().catch(() => {});
});
