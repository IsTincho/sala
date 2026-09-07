/* ============================================================
   La Sala de punta a punta: el servidor levantado de verdad en un
   puerto libre, y pedidos HTTP reales contra él.

   Se prueba así y no llamando a los módulos sueltos porque lo que hay
   que garantizar es lo que ve el de afuera: que la clave de subida
   valga para UNA sala y no para todas, que borrar el video que se
   está pasando detenga el reloj, que el chat de Twitch del dueño NO
   salga por el bus público, y que un espectador sin login pueda leer
   pero no escribir. Un test que llama al manejador directamente puede
   pasar con el enrutador roto.

   ---------------------------------------------------------------
   LOS PEDIDOS A KICK NO SALEN A INTERNET

   `kick.enviarMensaje` usa `fetch`, así que se reemplaza el `fetch`
   global por uno que contesta como la API de Kick SOLO para las URL
   de api.kick.com y deja pasar todo lo demás (los pedidos de este
   test al servidor son fetch también). Así se ejercita el código de
   verdad de `kick.js` —incluido el camino del 429 y su Retry-After—
   sin un solo byte hacia afuera.
   ============================================================ */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';

/* Las variables van ANTES de importar el servidor: index.js y kick.js
   las leen al cargarse. Ninguna es un secreto: son de mentira y no
   salen de este proceso. */
const DATOS = path.join(os.tmpdir(), 'sala-pruebas-sala-http');
process.env.SALA_DATOS = DATOS;
process.env.MODO = 'local';
process.env.KICK_SLUG = 'istincho';
process.env.KICK_CLIENT_ID = 'cliente-de-prueba';
process.env.KICK_CLIENT_SECRET = 'secreto-de-prueba';
process.env.URL_BASE = 'https://sala.example';
process.env.CLAVE_CIFRADO = crypto.randomBytes(32).toString('base64');

const { crearServidor } = await import('../servidor/index.js');
const canales = await import('../servidor/canales.js');
const almacen = await import('../servidor/almacen.js');
const sesion = await import('../servidor/sesion.js');
const videos = await import('../servidor/videos.js');
const vinculos = await import('../servidor/vinculos.js');
const espectadores = await import('../servidor/espectadores.js');

const SLUG = 'istincho';
const OTRO = 'otrocanal';

/* ------------------------------------------------- el fetch de Kick */

const fetchDeVerdad = globalThis.fetch;

/* Lo que va a contestar api.kick.com en el próximo pedido. Se cambia
   desde cada test. */
let respuestaDeKick = { estado: 200, cuerpo: { data: { is_sent: true, message_id: 'msg-1' } }, cabeceras: {} };
let pedidosAKick = [];

globalThis.fetch = async (entrada, opciones) => {
  const url = String(typeof entrada === 'string' ? entrada : entrada?.url ?? '');
  if (!url.startsWith('https://api.kick.com')) return fetchDeVerdad(entrada, opciones);

  pedidosAKick.push({ url, metodo: opciones?.metodo ?? opciones?.method, cuerpo: opciones?.body });
  return new Response(JSON.stringify(respuestaDeKick.cuerpo), {
    status: respuestaDeKick.estado,
    headers: { 'Content-Type': 'application/json', ...respuestaDeKick.cabeceras },
  });
};

/* --------------------------------------------------------- ayudas */

let servidor;
let raiz;

const cookieDueno = valor => `${sesion.COOKIES.dueno}=${valor}`;
const cookieEspectador = valor => `${sesion.COOKIES.espectador}=${valor}`;

let sesionDueno = '';
let sesionEspectador = '';
let sesionOtroEspectador = '';
let claveSubida = '';

const pedirJson = async (ruta, { metodo = 'GET', cookie = '', clave = '', cuerpo } = {}) => {
  const cabeceras = {};
  if (cookie) cabeceras.Cookie = cookie;
  if (clave) cabeceras['X-Clave-Subida'] = clave;
  if (cuerpo !== undefined) cabeceras['Content-Type'] = 'application/json';
  const r = await fetch(raiz + ruta, {
    method: metodo,
    headers: cabeceras,
    body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
  });
  let datos = null;
  try { datos = await r.json(); } catch { /* sin cuerpo */ }
  return { estado: r.status, datos, cabeceras: r.headers };
};

/** Abre un SSE y devuelve los eventos que van llegando. */
function abrirSse(slug, { cookie = '' } = {}) {
  const eventos = [];
  let resolverPrimero;
  const primero = new Promise(ok => { resolverPrimero = ok; });

  const req = http.get({
    host: '127.0.0.1',
    port: servidor.address().port,
    path: `/eventos/${slug}`,
    headers: cookie ? { Cookie: cookie } : {},
  }, res => {
    let pendiente = '';
    res.setEncoding('utf8');
    res.on('data', trozo => {
      pendiente += trozo;
      let corte;
      while ((corte = pendiente.indexOf('\n\n')) >= 0) {
        const bloque = pendiente.slice(0, corte);
        pendiente = pendiente.slice(corte + 2);
        const datos = bloque.split('\n').filter(l => l.startsWith('data:'))
          .map(l => l.slice(5).replace(/^ /, '')).join('\n');
        /* Los comentarios (`: ping`) y el `retry:` no traen data. */
        if (!datos) continue;
        /* El tipo va ADENTRO del data. Si alguna vez sale como
           `event: <tipo>`, esta prueba lo ve: se guarda el bloque
           crudo para poder asertar que no hay campo `event`. */
        eventos.push({ crudo: bloque, datos: JSON.parse(datos) });
        resolverPrimero();
      }
    });
  });

  return {
    eventos,
    primero,
    cerrar: () => req.destroy(),
    /** Espera hasta que haya un evento del tipo pedido, o falla. */
    async esperar(tipo, { tope = 3000 } = {}) {
      const limite = Date.now() + tope;
      while (Date.now() < limite) {
        const hallado = eventos.find(e => e.datos.tipo === tipo);
        if (hallado) return hallado;
        await new Promise(ok => setTimeout(ok, 20));
      }
      throw new Error(`no llegó ningún evento "${tipo}"; llegaron: ` +
        eventos.map(e => e.datos.tipo).join(', '));
    },
  };
}

const fichaCompleta = (id = 'ep1', slug = SLUG) => ({
  id,
  slug,
  titulo: `Episodio ${id}`,
  duracion: 1200.5,
  url: `https://pub-ejemplo.r2.dev/${slug}/${id}/maestra.m3u8`,
  calidades: [720, 1080],
  subtitulos: [{ idioma: 'spa', nombre: 'Espanol' }],
  bytes: 1234567,
});

/* ------------------------------------------------------- arranque */

test.before(async () => {
  await almacen.poner('creadores', OTRO, { slug: OTRO, plan: 'amigo' });

  sesionDueno = cookieDueno(await sesion.crear({ tipo: 'dueno', usuario: '99', nombre: 'IsTincho', slug: SLUG }));
  sesionEspectador = cookieEspectador(await sesion.crear({ tipo: 'espectador', usuario: '1001', nombre: 'unaespectadora' }));
  sesionOtroEspectador = cookieEspectador(await sesion.crear({ tipo: 'espectador', usuario: '1002', nombre: 'otro' }));

  /* Los dos espectadores tienen vínculo con Kick: sin eso, escribir
     falla por otro motivo y el test no probaría lo que quiere. */
  for (const id of ['1001', '1002']) {
    await espectadores.guardar({
      usuarioId: id,
      nombre: 'espectador ' + id,
      accessToken: 'acceso-de-mentira-' + id,
      refreshToken: 'refresco-de-mentira-' + id,
      venceEn: Date.now() + 3600_000,
      scopes: 'user:read chat:write',
    });
  }

  /* El dueño vinculado: de acá sale el broadcaster_user_id al que se
     le mandan los mensajes de los espectadores. */
  await vinculos.guardar('kick', {
    usuarioId: '4242',
    nombre: 'IsTincho',
    login: SLUG,
    slug: SLUG,
    accessToken: 'acceso-dueno',
    refreshToken: 'refresco-dueno',
    venceEn: Date.now() + 3600_000,
    scopes: 'user:read chat:write events:subscribe',
  });

  claveSubida = await videos.generarClave(SLUG);

  servidor = crearServidor();
  await new Promise(ok => servidor.listen(0, '127.0.0.1', ok));
  raiz = `http://127.0.0.1:${servidor.address().port}`;
});

test.after(async () => {
  globalThis.fetch = fetchDeVerdad;
  canales.cerrarTodo();
  await new Promise(ok => servidor.close(ok));
  await fsp.rm(DATOS, { recursive: true, force: true });
});

/* ==================================================== la hora */

test('/api/hora devuelve la hora del servidor y nada más', async () => {
  const antes = Date.now();
  const { estado, datos } = await pedirJson('/api/hora');
  const despues = Date.now();

  assert.equal(estado, 200);
  assert.ok(datos.ahora >= antes && datos.ahora <= despues, 'la hora tiene que ser de ahora');
  /* Es el dato que usa cualquiera que abra la sala: no puede filtrar
     nada de la cuenta del dueño. */
  assert.deepEqual(Object.keys(datos), ['ahora']);
});

/* ============================================ el catálogo de videos */

test('POST /api/videos sin la cabecera de la clave da 401', async () => {
  const { estado } = await pedirJson('/api/videos', { metodo: 'POST', cuerpo: fichaCompleta() });
  assert.equal(estado, 401);
});

test('POST /api/videos con una clave que no es da 401', async () => {
  const { estado, datos } = await pedirJson('/api/videos', {
    metodo: 'POST', clave: 'no-soy-la-clave', cuerpo: fichaCompleta(),
  });
  assert.equal(estado, 401);
  /* El error no dice si la clave no existe o si es de otra sala: quien
     prueba claves no tiene por qué enterarse de cuál falló. */
  assert.match(datos.error, /clave de subida invalida/);
});

test('POST /api/videos con la clave guarda la ficha y la lista el panel', async () => {
  const { estado, datos } = await pedirJson('/api/videos', {
    metodo: 'POST', clave: claveSubida, cuerpo: fichaCompleta('ep1'),
  });
  assert.equal(estado, 200);
  assert.equal(datos.id, 'ep1');

  const lista = await pedirJson('/api/videos', { cookie: sesionDueno });
  assert.equal(lista.estado, 200);
  const ep1 = lista.datos.videos.find(v => v.id === 'ep1');
  assert.equal(ep1.titulo, 'Episodio ep1');
  assert.equal(ep1.duracion, 1200.5);
  assert.deepEqual(ep1.calidades, [720, 1080]);
});

test('el mismo id dos veces PISA y no duplica', async () => {
  /* El script se puede correr dos veces sobre el mismo archivo. La
     segunda tiene que dejar UNA entrada, con lo nuevo. */
  await pedirJson('/api/videos', { metodo: 'POST', clave: claveSubida, cuerpo: fichaCompleta('ep2') });
  await pedirJson('/api/videos', {
    metodo: 'POST', clave: claveSubida,
    cuerpo: { ...fichaCompleta('ep2'), titulo: 'Episodio 2, de nuevo' },
  });

  const { datos } = await pedirJson('/api/videos', { cookie: sesionDueno });
  const iguales = datos.videos.filter(v => v.id === 'ep2');
  assert.equal(iguales.length, 1, 'quedó duplicado');
  assert.equal(iguales[0].titulo, 'Episodio 2, de nuevo');
});

test('la clave de una sala no puede escribir en el catálogo de otra', async () => {
  /* Sin esto, la clave del dueño escribiría en la sala de cualquier
     creador de la Fase 3 cambiando un campo del JSON. */
  const { estado, datos } = await pedirJson('/api/videos', {
    metodo: 'POST', clave: claveSubida, cuerpo: fichaCompleta('ajeno', OTRO),
  });
  assert.equal(estado, 403);
  assert.match(datos.error, /no es de esa sala/);

  const lista = await videos.listar(OTRO);
  assert.equal(lista.length, 0, 'no tiene que haber quedado nada en la otra sala');
});

test('una ficha inválida se rechaza con 400 y dice por qué', async () => {
  const casos = [
    [{ ...fichaCompleta(), id: 'MAYUSCULAS' }, /id invalido/],
    [{ ...fichaCompleta(), duracion: 0 }, /duracion/],
    [{ ...fichaCompleta(), url: 'http://pub-ejemplo.r2.dev/x/maestra.m3u8' }, /https/],
    [{ ...fichaCompleta(), url: 'https://pub-ejemplo.r2.dev/x/video.mp4' }, /m3u8/],
  ];
  for (const [cuerpo, esperado] of casos) {
    const { estado, datos } = await pedirJson('/api/videos', { metodo: 'POST', clave: claveSubida, cuerpo });
    assert.equal(estado, 400, JSON.stringify(cuerpo).slice(0, 80));
    assert.match(datos.error, esperado);
  }
});

test('la ficha corta de --avisar (sin calidades ni bytes) se acepta igual', async () => {
  /* `subir.py --avisar` es el reintento del paso 5, cuando la subida
     salió bien y el servidor estaba caído: manda sólo cinco campos. */
  const { estado } = await pedirJson('/api/videos', {
    metodo: 'POST', clave: claveSubida,
    cuerpo: {
      id: 'corto', slug: SLUG, titulo: 'Corto', duracion: 60,
      url: `https://pub-ejemplo.r2.dev/${SLUG}/corto/maestra.m3u8`,
    },
  });
  assert.equal(estado, 200);
  const guardado = await videos.obtener(SLUG, 'corto');
  assert.deepEqual(guardado.calidades, []);
  assert.equal(guardado.bytes, 0);
});

test('DELETE borra una vez y después contesta 404, que para el script no es error', async () => {
  await pedirJson('/api/videos', { metodo: 'POST', clave: claveSubida, cuerpo: fichaCompleta('borrable') });

  const primero = await pedirJson('/api/videos/borrable', { metodo: 'DELETE', clave: claveSubida });
  assert.equal(primero.estado, 200);

  const segundo = await pedirJson('/api/videos/borrable', { metodo: 'DELETE', clave: claveSubida });
  assert.equal(segundo.estado, 404);
});

test('DELETE con un id inválido da 400 y no toca nada', async () => {
  const { estado } = await pedirJson('/api/videos/CON%20ESPACIOS', { metodo: 'DELETE', clave: claveSubida });
  assert.equal(estado, 400);
});

test('/api/videos con GET pide cookie de dueño, no la clave', async () => {
  const sinNada = await pedirJson('/api/videos');
  assert.equal(sinNada.estado, 401);
  /* La clave sirve para escribir el catálogo desde una terminal, no
     para leerlo desde cualquier lado. */
  const conClave = await pedirJson('/api/videos', { clave: claveSubida });
  assert.equal(conClave.estado, 401);
});

test('una ruta con dos métodos no contesta 405 al método bueno', async () => {
  /* El enrutador cortaba en la primera coincidencia de camino: con
     GET escrito antes que POST, un POST perfectamente válido a
     /api/videos se contestaba "solo acepta GET". */
  const r = await fetch(`${raiz}/api/videos`, { method: 'PUT' });
  assert.equal(r.status, 405);
  assert.equal(r.headers.get('allow'), 'GET, POST');
});

/* ==================================================== el reloj */

test('el reloj no se toca sin la sesión del dueño', async () => {
  const sinNada = await pedirJson(`/api/sala/${SLUG}/reloj`, {
    metodo: 'POST', cuerpo: { accion: 'reproducir', videoId: 'ep1' },
  });
  assert.equal(sinNada.estado, 401);

  /* Y una cookie de espectador NO sirve de cookie de dueño, aunque
     esté perfectamente firmada: son dos espacios de nombres. */
  const conEspectador = await pedirJson(`/api/sala/${SLUG}/reloj`, {
    metodo: 'POST', cookie: sesionEspectador, cuerpo: { accion: 'reproducir', videoId: 'ep1' },
  });
  assert.equal(conEspectador.estado, 401);
});

test('el dueño no puede tocar el reloj de otra sala', async () => {
  const { estado } = await pedirJson(`/api/sala/${OTRO}/reloj`, {
    metodo: 'POST', cookie: sesionDueno, cuerpo: { accion: 'detener' },
  });
  assert.equal(estado, 403);
});

test('reproducir difunde el reloj por el bus, sin nombre de evento', async () => {
  const sse = abrirSse(SLUG);
  await sse.primero;

  const { estado, datos } = await pedirJson(`/api/sala/${SLUG}/reloj`, {
    metodo: 'POST', cookie: sesionDueno, cuerpo: { accion: 'reproducir', videoId: 'ep1' },
  });
  assert.equal(estado, 200);
  assert.equal(datos.reloj.estado, 'reproduciendo');
  /* La respuesta trae la ficha del video adentro: el navegador no
     tiene que hacer otro pedido antes de empezar a cargar. */
  assert.match(datos.reloj.url, /maestra\.m3u8$/);
  assert.equal(datos.reloj.duracion, 1200.5);

  const evento = await sse.esperar('reloj');
  assert.equal(evento.datos.videoId, 'ep1');
  assert.equal(evento.datos.estado, 'reproduciendo');
  /* REGLA DE LA CASA: todo sale como el `message` por defecto, con el
     tipo adentro del data. Un `event: reloj` sólo llegaría al listener
     de ese nombre y el cliente nunca lo vería. */
  assert.ok(!/^event:/m.test(evento.crudo), 'el evento no puede llevar nombre');

  sse.cerrar();
});

test('reproducir algo que no está en el catálogo da 400 y no mueve el reloj', async () => {
  const antes = await pedirJson('/api/panel', { cookie: sesionDueno });
  const { estado, datos } = await pedirJson(`/api/sala/${SLUG}/reloj`, {
    metodo: 'POST', cookie: sesionDueno, cuerpo: { accion: 'reproducir', videoId: 'no-existe' },
  });
  assert.equal(estado, 400);
  assert.match(datos.error, /catalogo/);

  const despues = await pedirJson('/api/panel', { cookie: sesionDueno });
  assert.equal(despues.datos.reloj.videoId, antes.datos.reloj.videoId);
});

test('una acción inventada da 400', async () => {
  const { estado } = await pedirJson(`/api/sala/${SLUG}/reloj`, {
    metodo: 'POST', cookie: sesionDueno, cuerpo: { accion: 'rebobinar' },
  });
  assert.equal(estado, 400);
});

test('borrar el video que se está pasando DETIENE el reloj', async () => {
  /* Si no, la sala se queda pidiendo segmentos que ya no existen en
     R2: el player no falla con un error claro, se queda cargando para
     siempre. */
  await pedirJson('/api/videos', { metodo: 'POST', clave: claveSubida, cuerpo: fichaCompleta('en-marcha') });
  await pedirJson(`/api/sala/${SLUG}/reloj`, {
    metodo: 'POST', cookie: sesionDueno, cuerpo: { accion: 'reproducir', videoId: 'en-marcha' },
  });

  const sse = abrirSse(SLUG);
  await sse.primero;

  const borrado = await pedirJson('/api/videos/en-marcha', { metodo: 'DELETE', clave: claveSubida });
  assert.equal(borrado.estado, 200);
  assert.equal(borrado.datos.relojDetenido, true);

  const evento = await sse.esperar('reloj');
  assert.equal(evento.datos.estado, 'detenido');
  sse.cerrar();

  const panel = await pedirJson('/api/panel', { cookie: sesionDueno });
  assert.equal(panel.datos.reloj.estado, 'detenido');
});

/* ======================================= el chat del espectador */

test('sin login se lee pero no se escribe', async () => {
  const { estado, datos } = await pedirJson(`/api/sala/${SLUG}/chat`, {
    metodo: 'POST', cuerpo: { texto: 'hola' },
  });
  assert.equal(estado, 401);
  assert.match(datos.error, /entra con Kick/i);

  /* Leer sí: el bus no pide sesión. */
  const sse = abrirSse(SLUG);
  const primero = await sse.primero.then(() => sse.eventos[0]);
  assert.equal(primero.datos.tipo, 'estado');
  sse.cerrar();
});

test('un mensaje del espectador sale a Kick con el broadcaster del dueño', async () => {
  espectadores.reiniciar();
  pedidosAKick = [];
  respuestaDeKick = { estado: 200, cuerpo: { data: { is_sent: true, message_id: 'm-1' } }, cabeceras: {} };

  const { estado, datos } = await pedirJson(`/api/sala/${SLUG}/chat`, {
    metodo: 'POST', cookie: sesionEspectador, cuerpo: { texto: 'qué peli más larga' },
  });
  assert.equal(estado, 200);
  assert.equal(datos.ok, true);

  const pedido = pedidosAKick.at(-1);
  assert.match(pedido.url, /\/chat$/);
  const enviado = JSON.parse(pedido.cuerpo);
  /* "user" y no "bot": con "bot" el mensaje sale como la app y no
     como la persona, que es toda la gracia del proyecto. */
  assert.equal(enviado.type, 'user');
  assert.equal(enviado.broadcaster_user_id, 4242);
  assert.equal(enviado.content, 'qué peli más larga');
});

test('el mensaje no se difunde por el bus: vuelve por el webhook', async () => {
  /* Difundirlo al enviarlo lo mostraría dos veces y, peor, lo
     mostraría aunque Kick lo hubiera retenido. */
  espectadores.reiniciar();
  const sse = abrirSse(SLUG);
  await sse.primero;
  const cuantos = sse.eventos.length;

  await pedirJson(`/api/sala/${SLUG}/chat`, {
    metodo: 'POST', cookie: sesionEspectador, cuerpo: { texto: 'no me dupliques' },
  });
  await new Promise(ok => setTimeout(ok, 150));

  const nuevos = sse.eventos.slice(cuantos).filter(e => e.datos.tipo === 'chat');
  assert.equal(nuevos.length, 0);
  sse.cerrar();
});

test('el mensaje vacío y el demasiado largo se frenan antes de gastar un pedido a Kick', async () => {
  espectadores.reiniciar();
  pedidosAKick = [];

  const vacio = await pedirJson(`/api/sala/${SLUG}/chat`, {
    metodo: 'POST', cookie: sesionEspectador, cuerpo: { texto: '   ' },
  });
  assert.equal(vacio.estado, 400);

  const largo = await pedirJson(`/api/sala/${SLUG}/chat`, {
    metodo: 'POST', cookie: sesionEspectador, cuerpo: { texto: 'a'.repeat(501) },
  });
  assert.equal(largo.estado, 400);
  assert.match(largo.datos.error, /tope/);

  assert.equal(pedidosAKick.length, 0, 'no se le tiene que pedir nada a Kick');
});

test('uno cada dos segundos por persona, y no se frenan entre sí', async () => {
  espectadores.reiniciar();
  respuestaDeKick = { estado: 200, cuerpo: { data: { is_sent: true, message_id: 'm' } }, cabeceras: {} };

  const primero = await pedirJson(`/api/sala/${SLUG}/chat`, {
    metodo: 'POST', cookie: sesionEspectador, cuerpo: { texto: 'uno' },
  });
  assert.equal(primero.estado, 200);

  const segundo = await pedirJson(`/api/sala/${SLUG}/chat`, {
    metodo: 'POST', cookie: sesionEspectador, cuerpo: { texto: 'dos' },
  });
  assert.equal(segundo.estado, 429);
  assert.ok(segundo.datos.esperar >= 1);
  assert.ok(segundo.cabeceras.get('retry-after'), 'tiene que decir cuánto esperar');

  /* Otra persona no paga el freno de la primera. */
  const otro = await pedirJson(`/api/sala/${SLUG}/chat`, {
    metodo: 'POST', cookie: sesionOtroEspectador, cuerpo: { texto: 'yo recién llego' },
  });
  assert.equal(otro.estado, 200);
});

test('un 429 de Kick frena el CANAL entero, no sólo a quien lo pidió', async () => {
  /* El 429 es del canal: seguir mandando el resto de los mensajes de
     la noche sólo consigue más 429. */
  espectadores.reiniciar();
  respuestaDeKick = {
    estado: 429,
    cuerpo: { error: 'too many requests' },
    cabeceras: { 'Retry-After': '7' },
  };

  const frenado = await pedirJson(`/api/sala/${SLUG}/chat`, {
    metodo: 'POST', cookie: sesionEspectador, cuerpo: { texto: 'primero' },
  });
  assert.equal(frenado.estado, 429);
  assert.equal(frenado.datos.esperar, 7, 'tiene que respetar el Retry-After de Kick');

  pedidosAKick = [];
  const otro = await pedirJson(`/api/sala/${SLUG}/chat`, {
    metodo: 'POST', cookie: sesionOtroEspectador, cuerpo: { texto: 'segundo' },
  });
  assert.equal(otro.estado, 429);
  assert.equal(pedidosAKick.length, 0, 'ni siquiera se le pide a Kick mientras dura la espera');

  espectadores.reiniciar();
});

test('si Kick rechaza el permiso, se cierra la sesión y se olvida el token', async () => {
  espectadores.reiniciar();
  await espectadores.guardar({
    usuarioId: '1001', nombre: 'unaespectadora',
    accessToken: 'acceso-de-mentira-1001', refreshToken: 'refresco-de-mentira-1001',
    venceEn: Date.now() + 3600_000, scopes: 'user:read chat:write',
  });
  respuestaDeKick = { estado: 401, cuerpo: { error: 'unauthorized' }, cabeceras: {} };

  const { estado, cabeceras } = await pedirJson(`/api/sala/${SLUG}/chat`, {
    metodo: 'POST', cookie: sesionEspectador, cuerpo: { texto: 'hola' },
  });
  assert.equal(estado, 401);
  assert.match(cabeceras.get('set-cookie') ?? '', /sala_espectador=; .*Max-Age=0/);
  /* El token que Kick ya no acepta no se guarda "por las dudas". */
  assert.equal(await espectadores.leer('1001'), null);

  respuestaDeKick = { estado: 200, cuerpo: { data: { is_sent: true } }, cabeceras: {} };
});

/* ============================== el bus público y el chat de Twitch */

test('el bus público manda Kick y NO manda el Twitch del dueño', async () => {
  /*
   * LA DECISIÓN DE LA FASE 2. Por el canal del dueño viaja también su
   * chat de Twitch, porque /chat los muestra juntos. Pero
   * /eventos/:slug no pide sesión y desde la Sala lo escucha cualquiera
   * que esté mirando la peli: esa gente no tiene nada que ver con la
   * comunidad de Twitch del streamer.
   *
   * Se filtra en el SERVIDOR y no en el navegador: filtrando en el
   * navegador, el chat de Twitch igual saldría por el cable hacia
   * trescientas pestañas y un `curl` lo vería entero.
   */
  const sse = abrirSse(SLUG);
  await sse.primero;

  canales.recordar(SLUG, { tipo: 'chat', red: 'kick', id: 'k1', usuario: 'alguien', texto: 'de Kick' });
  canales.recordar(SLUG, { tipo: 'chat', red: 'twitch', id: 't1', usuario: 'otro', texto: 'de Twitch' });

  await sse.esperar('chat');
  await new Promise(ok => setTimeout(ok, 150));

  const textos = sse.eventos.filter(e => e.datos.tipo === 'chat').map(e => e.datos.texto);
  assert.ok(textos.includes('de Kick'));
  assert.ok(!textos.includes('de Twitch'), 'el chat de Twitch no puede salir por el bus público');
  sse.cerrar();
});

test('con la sesión del dueño el bus manda las dos redes', async () => {
  /* /chat es la única página que las necesita, y exige esta cookie. */
  const sse = abrirSse(SLUG, { cookie: sesionDueno });
  await sse.primero;

  canales.recordar(SLUG, { tipo: 'chat', red: 'twitch', id: 't2', usuario: 'otro', texto: 'twitch para el dueño' });
  await new Promise(ok => setTimeout(ok, 150));

  const textos = sse.eventos.filter(e => e.datos.tipo === 'chat').map(e => e.datos.texto);
  assert.ok(textos.includes('twitch para el dueño'));
  sse.cerrar();
});

test('lo que se perdió también viene filtrado', async () => {
  /* Sin esto, una sala que no recibe Twitch en vivo se comería igual
     los últimos 200 mensajes de Twitch al conectarse, que es la mitad
     del problema y la más visible. */
  canales.cerrarTodo();
  canales.recordar(SLUG, { tipo: 'chat', red: 'twitch', id: 't3', usuario: 'x', texto: 'viejo de twitch' });
  canales.recordar(SLUG, { tipo: 'chat', red: 'kick', id: 'k3', usuario: 'y', texto: 'viejo de kick' });

  const sse = abrirSse(SLUG);
  await sse.esperar('chat');
  await new Promise(ok => setTimeout(ok, 100));

  const textos = sse.eventos.filter(e => e.datos.tipo === 'chat').map(e => e.datos.texto);
  assert.deepEqual(textos, ['viejo de kick']);
  sse.cerrar();
  canales.cerrarTodo();
});

test('el contador de espectadores sale por el bus', async () => {
  const uno = abrirSse(SLUG);
  await uno.primero;
  const dos = abrirSse(SLUG);
  await dos.primero;

  const evento = await uno.esperar('presencia');
  assert.ok(evento.datos.conectados >= 2, `decía ${evento.datos.conectados}`);

  uno.cerrar();
  dos.cerrar();
});

/* ==================================================== el panel */

test('/api/panel junta todo en un pedido y no filtra la clave', async () => {
  const sinSesion = await pedirJson('/api/panel');
  assert.equal(sinSesion.estado, 401);

  const { estado, datos } = await pedirJson('/api/panel', { cookie: sesionDueno });
  assert.equal(estado, 200);
  assert.equal(datos.slug, SLUG);
  assert.ok(Array.isArray(datos.videos));
  assert.ok(datos.reloj);
  assert.ok(datos.metricas);
  assert.equal(datos.claveSubida.hay, true);
  assert.match(datos.urlWebhook, /\/kick\/webhook$/);

  /* La pantalla del dueño se mira con la transmisión al aire: la clave
     NO puede viajar en el estado del panel. */
  const crudo = JSON.stringify(datos);
  assert.ok(!crudo.includes(claveSubida), 'la clave de subida se filtró en /api/panel');
  assert.ok(!/"hash"/.test(crudo), 'ni siquiera el hash tiene que salir');
});

test('generar una clave nueva invalida la anterior', async () => {
  const anterior = claveSubida;
  const { estado, datos } = await pedirJson('/api/panel/clave', { metodo: 'POST', cookie: sesionDueno });
  assert.equal(estado, 200);
  assert.ok(datos.clave.length >= 32);
  assert.notEqual(datos.clave, anterior);

  const conVieja = await pedirJson('/api/videos', {
    metodo: 'POST', clave: anterior, cuerpo: fichaCompleta('con-vieja'),
  });
  assert.equal(conVieja.estado, 401);

  const conNueva = await pedirJson('/api/videos', {
    metodo: 'POST', clave: datos.clave, cuerpo: fichaCompleta('con-nueva'),
  });
  assert.equal(conNueva.estado, 200);
  claveSubida = datos.clave;
});

test('revocar la clave deja al script sin poder escribir', async () => {
  const { estado } = await pedirJson('/api/panel/clave', { metodo: 'DELETE', cookie: sesionDueno });
  assert.equal(estado, 200);

  const despues = await pedirJson('/api/videos', {
    metodo: 'POST', clave: claveSubida, cuerpo: fichaCompleta('despues'),
  });
  assert.equal(despues.estado, 401);

  claveSubida = await videos.generarClave(SLUG);   // se deja como estaba
});

test('la clave sólo la puede generar el dueño', async () => {
  const conEspectador = await pedirJson('/api/panel/clave', { metodo: 'POST', cookie: sesionEspectador });
  assert.equal(conEspectador.estado, 401);
});

/* ==================================================== las páginas */

test('/sala/:slug se sirve sólo para una sala que existe', async () => {
  const buena = await fetch(`${raiz}/sala/${SLUG}`);
  assert.equal(buena.status, 200);
  assert.match(buena.headers.get('content-type'), /text\/html/);

  const inventada = await fetch(`${raiz}/sala/no-existe-esta-sala`);
  assert.equal(inventada.status, 404);
});

test('el CSS y el JS de la Sala no quedan tapados por la ruta /sala/:slug', async () => {
  /* `/sala/:slug` tapa todo lo que cuelgue de /sala/, y ahí viven el
     CSS y el JS de la página. Sin la salida a estáticos, la Sala se
     vería sin estilos ni script y el 404 no diría por qué. */
  for (const [ruta, tipo] of [
    ['/sala/sala.css', /text\/css/],
    ['/sala/sala.js', /javascript/],
    ['/sala/demo.js', /javascript/],
  ]) {
    const r = await fetch(raiz + ruta);
    assert.equal(r.status, 200, ruta);
    assert.match(r.headers.get('content-type'), tipo, ruta);
  }
});

test('el servidor no sirve video por ninguna de las rutas nuevas', async () => {
  /* La regla que no se negocia. Ninguna respuesta de la API puede
     traer una playlist ni un segmento: la URL apunta a r2.dev y el
     navegador va solo. */
  const panel = await fetch(`${raiz}/api/panel`, { headers: { Cookie: sesionDueno } });
  assert.match(panel.headers.get('content-type'), /application\/json/);

  for (const ruta of ['/api/videos/ep1', `/${SLUG}/ep1/maestra.m3u8`, '/videos/ep1/maestra.m3u8']) {
    const r = await fetch(raiz + ruta);
    assert.notEqual(r.headers.get('content-type'), 'application/vnd.apple.mpegurl');
    assert.ok(r.status === 404 || r.status === 405 || r.status === 401,
      `${ruta} contestó ${r.status}`);
  }
});
