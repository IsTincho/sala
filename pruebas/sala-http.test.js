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
const creadores = await import('../servidor/creadores.js');
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

/* El origen que manda un navegador que abrió este sitio. Va por
   defecto en todos los pedidos porque eso es lo que hace un navegador
   de verdad; los tests de CSRF lo cambian a mano. */
const NUESTRO = 'https://sala.example';

const pedirJson = async (ruta, { metodo = 'GET', cookie = '', clave = '', cuerpo, origen = NUESTRO } = {}) => {
  const cabeceras = {};
  if (cookie) cabeceras.Cookie = cookie;
  if (clave) cabeceras['X-Clave-Subida'] = clave;
  if (origen) cabeceras.Origin = origen;
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

/* Un titulo limpio: ni C0, ni DEL, ni C1, ni los separadores de linea
   de Unicode. Se escribe con escapes a proposito. */
const SIN_CONTROLES = /^[^\u0000-\u001F\u007F-\u009F\u2028\u2029]*$/;

/**
 * Un espectador recién llegado: vínculo con Kick guardado y sesión
 * abierta. Devuelve la cookie.
 *
 * Existe porque varios tests de más abajo dejan a `sesionEspectador`
 * sin token y sin sesión a propósito (el que prueba que un 401 de Kick
 * cierra todo). Un test que use esa cookie después pasaría por el
 * motivo equivocado: contestaría 401 antes de llegar a lo que quiere
 * probar. Con un espectador propio, el pedido llega hasta el final.
 */
async function nuevoEspectador(usuarioId, nombre) {
  await espectadores.conectar(usuarioId, 'kick', {
    usuarioId,
    nombre,
    accessToken: `acceso-de-mentira-${usuarioId}`,
    refreshToken: `refresco-de-mentira-${usuarioId}`,
    venceEn: Date.now() + 3600_000,
    scopes: 'user:read chat:write',
  });
  return cookieEspectador(await sesion.crear({ tipo: 'espectador', usuario: usuarioId, nombre }));
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

  /* LAS DOS SALAS SE PRENDEN ACÁ, y es lo primero que hace este
     archivo desde el 2026-09-22.

     La Sala —pasar una película— nace apagada para todos, incluido el
     dueño del servicio, y con el interruptor en cero estas rutas
     contestan 404 igual que una sala inventada. Este archivo prueba
     cómo se comporta la Sala ANDANDO, así que la enciende y sigue como
     siempre; que apagada no exista se prueba aparte, en
     `sala-cerrada.test.js`.

     Para el dueño hace falta `ponerSalaAbierta` y no un `almacen.poner`
     como el de arriba: no tiene fila en `creadores` (su sala existe por
     KICK_SLUG) y la función se la crea, que es justo el caso raro que
     el módulo atiende. */
  await creadores.ponerSalaAbierta(SLUG, true);
  await creadores.ponerSalaAbierta(OTRO, true);

  sesionDueno = cookieDueno(await sesion.crear({ tipo: 'dueno', usuario: '99', nombre: 'IsTincho', slug: SLUG }));
  sesionEspectador = cookieEspectador(await sesion.crear({ tipo: 'espectador', usuario: '1001', nombre: 'unaespectadora' }));
  sesionOtroEspectador = cookieEspectador(await sesion.crear({ tipo: 'espectador', usuario: '1002', nombre: 'otro' }));

  /* Los dos espectadores tienen vínculo con Kick: sin eso, escribir
     falla por otro motivo y el test no probaría lo que quiere. */
  for (const id of ['1001', '1002']) {
    await espectadores.conectar(id, 'kick', {
      usuarioId: id,
      nombre: 'espectador ' + id,
      accessToken: 'acceso-de-mentira-' + id,
      refreshToken: 'refresco-de-mentira-' + id,
      venceEn: Date.now() + 3600_000,
      scopes: 'user:read chat:write',
    });
  }

  /* El dueño vinculado: de acá sale el broadcaster_user_id al que se
     le mandan los mensajes de los espectadores de SU sala. */
  await vinculos.guardar(SLUG, 'kick', {
    usuarioId: '4242',
    nombre: 'IsTincho',
    login: SLUG,
    slug: SLUG,
    accessToken: 'acceso-dueno',
    refreshToken: 'refresco-dueno',
    venceEn: Date.now() + 3600_000,
    scopes: 'user:read chat:write events:subscribe',
  });

  /* Y el OTRO creador, con SU propio canal de Kick y un
     broadcaster_user_id distinto. Es lo que hace que el test de
     aislamiento del chat pueda distinguir "fue a la sala correcta" de
     "no fue a ningún lado": con la sala ajena sin vincular, un mensaje
     que se ruteara mal daría el mismo 503 que uno bien ruteado. */
  await vinculos.guardar(OTRO, 'kick', {
    usuarioId: '7777',
    nombre: 'Otro Creador',
    login: OTRO,
    slug: OTRO,
    accessToken: 'acceso-otro',
    refreshToken: 'refresco-otro',
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

test('una ficha que apunta a NUESTRO servidor se rechaza con 400', async () => {
  /*
   * EL REPRO DE LA VERIFICACIÓN DE LA FASE 2, tal cual.
   *
   * El comentario de `revisarFicha` prometía desde el día uno que la
   * URL tiene que ser https "y de otro host", con el motivo escrito al
   * lado: el servidor no sirve video y una ficha que apunte a nuestro
   * dominio se descubre con la factura de egreso. El código chequeaba
   * el protocolo y el .m3u8 y nada más, así que esto contestaba 200.
   *
   * Es la invariante más cara del proyecto: una playlist en nuestro
   * origen manda a trescientos navegadores a pedirle los segmentos a
   * Railway en vez de a R2.
   *
   * URL_BASE de este archivo es https://sala.example (arriba del todo).
   */
  const casos = [
    ['https://sala.example/sala/x.m3u8', /este mismo servidor/],
    ['https://localhost:8821/sala/x.m3u8', /esta misma maquina/],
    ['https://127.0.0.1:8821/sala/x.m3u8', /esta misma maquina/],

    /* LA SEGUNDA VERIFICACIÓN. Estas dos contestaban 200 y guardaban la
       ficha: el parser de Node deja `[::ffff:127.0.0.1]` como
       `[::ffff:7f00:1]` y `[0:0:0:0:0:0:0:0]` como `[::]`, y la regex
       de loopback estaba escrita sobre cuartetos decimales. Se miran
       por HTTP y no sólo en `revisarFicha` porque lo que se prometía
       era el 400. */
    ['https://[::ffff:127.0.0.1]:8821/sala/x.m3u8', /esta misma maquina/],
    ['https://[::]:8821/sala/x.m3u8', /esta misma maquina/],
  ];

  for (const [url, esperado] of casos) {
    const { estado, datos } = await pedirJson('/api/videos', {
      metodo: 'POST', clave: claveSubida, cuerpo: { ...fichaCompleta('propia'), url },
    });
    assert.equal(estado, 400, `${url} tendría que dar 400 y dio ${estado}`);
    assert.match(datos.error, esperado, url);
  }

  /* Y no quedó nada guardado con ninguna de las cinco. */
  assert.equal(await videos.obtener(SLUG, 'propia'), null,
    'una ficha rechazada no puede haber quedado en el catálogo');
});

test('el título de un video no puede inventar una línea en el log', async () => {
  /*
   * La otra falla de la verificación. El título sale del nombre del
   * archivo que se le pasa a subir.py, y `apiVideosGuardar` lo mete tal
   * cual en un console.log. Con un \n adentro, la segunda mitad de esa
   * línea la escribe quien subió el video: la salida real que consiguió
   * el verificador fue un `[http] POST /api/panel 200 clave=FALSA`
   * perfectamente creíble en el log de Railway, que no se borra y es la
   * única evidencia cuando algo falla.
   *
   * Se asierta sobre lo que queda GUARDADO porque es exactamente el
   * string que `console.log` interpola: `ficha.titulo`.
   */
  const veneno = 'Episodio raro\n[http] POST /api/panel 200 clave=FALSA';
  const { estado } = await pedirJson('/api/videos', {
    metodo: 'POST', clave: claveSubida, cuerpo: { ...fichaCompleta('venenoso'), titulo: veneno },
  });
  assert.equal(estado, 200, 'no se rechaza la ficha: se limpia el título');

  const guardado = await videos.obtener(SLUG, 'venenoso');
  assert.equal(guardado.titulo.includes('\n'), false, 'el título llegó al almacén con un salto de línea');
  assert.equal(guardado.titulo.includes('\r'), false);
  assert.equal(guardado.titulo, 'Episodio raro [http] POST /api/panel 200 clave=FALSA');

  /* Y lo mismo por la ruta por la que lo ve el panel. */
  const lista = await pedirJson('/api/videos', { cookie: sesionDueno });
  const ficha = lista.datos.videos.find(v => v.id === 'venenoso');
  assert.equal(SIN_CONTROLES.test(ficha.titulo), true,
    `el panel ve un titulo con controles: ${JSON.stringify(ficha.titulo)}`);

  await videos.borrar(SLUG, 'venenoso');
});

test('el catálogo del panel es el del dueño y NO se elige por query', async () => {
  /*
   * LA FUGA DE TENANT QUE LA FASE 3 HEREDA. `apiVideosListar` lista
   * `SLUG_DUENO` y punto. La mutación que la verificación dejó viva era
   * cambiar eso por `url.searchParams.get('slug') ?? SLUG_DUENO`: con
   * una sola línea, la cookie del dueño pasaba a leer el catálogo de
   * cualquier creador. Hoy `creadores` está casi vacía y no se nota;
   * el día que haya mil, es el panel de todos.
   */
  const AJENA = 'salaajena';
  await videos.guardar({
    id: 'secreto', slug: AJENA, titulo: 'Video de otra persona',
    duracion: 100, url: `https://pub-ejemplo.r2.dev/${AJENA}/secreto/maestra.m3u8`,
    calidades: [720], subtitulos: [], bytes: 1,
  });

  try {
    const { estado, datos } = await pedirJson(`/api/videos?slug=${AJENA}`, { cookie: sesionDueno });
    assert.equal(estado, 200);

    const ajenos = datos.videos.filter(v => v.slug === AJENA);
    assert.deepEqual(ajenos, [], 'el catálogo de otra sala no puede salir por acá');
    assert.equal(datos.videos.some(v => v.id === 'secreto'), false);
    /* Y sigue devolviendo lo que tiene que devolver: los del dueño. */
    assert.ok(datos.videos.length > 0, 'tiene que seguir listando los del dueño');
    assert.ok(datos.videos.every(v => v.slug === SLUG));
  } finally {
    await videos.borrar(AJENA, 'secreto');
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

test('/api/videos con GET pide cookie o clave, y sin nada da 401', async () => {
  /*
   * CAMBIO DELIBERADO SOBRE UNA DECISIÓN DE LA FASE 2, anotado en la
   * bitácora.
   *
   * Este test decía que la clave de subida servía para ESCRIBIR el
   * catálogo y no para leerlo. Con un solo creador esa restricción no
   * costaba nada; con la Fase 3 sí, porque `subir.py --listar` de un
   * creador no tiene otra forma de saber qué hay del lado del
   * servidor: no tiene cookie ni token de R2.
   *
   * Y la restricción dejó de ser coherente. Desde que la misma clave
   * firma los DELETE de R2 de su prefijo (que es lo que necesita
   * `--borrar`), poder leer el catálogo es estrictamente menos que lo
   * que ya podía hacer. La regla que queda, y que este test fija, es
   * más simple de enunciar: **la clave puede todo sobre los videos de
   * SU sala, y nada más.**
   */
  const sinNada = await pedirJson('/api/videos');
  assert.equal(sinNada.estado, 401);

  const conClave = await pedirJson('/api/videos', { clave: claveSubida });
  assert.equal(conClave.estado, 200);
  assert.ok(conClave.datos.videos.every(v => v.slug === SLUG),
    'y lo que lista es el catálogo de SU sala');
});

test('la clave NO abre nada que no sean los videos de su sala', async () => {
  /* La otra mitad de la regla, y la que impide que "la clave puede
     leer" se estire hasta "la clave es una sesión". Un `.env` filtrado
     no puede volverse el panel de nadie. */
  const panel = await pedirJson('/api/panel', { clave: claveSubida });
  assert.equal(panel.estado, 401, 'el panel es de la cookie');

  const nuevaClave = await pedirJson('/api/panel/clave', { metodo: 'POST', clave: claveSubida });
  assert.equal(nuevaClave.estado, 401, 'con la clave no se genera otra clave');

  const reloj = await pedirJson(`/api/sala/${SLUG}/reloj`, {
    metodo: 'POST', clave: claveSubida, cuerpo: { accion: 'detener' },
  });
  assert.equal(reloj.estado, 401, 'y no se maneja la película');

  const salud = await pedirJson('/api/chat/salud', { clave: claveSubida });
  assert.equal(salud.estado, 401);
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

/* ============================== entrar con la película ya empezada

   EL CAMINO SIN RED, Y EL QUE MÁS SE USA.

   Todos los tests de reloj de acá arriba abren el SSE ANTES de tocar
   play, así que el reloj siempre les llega como un evento `reloj` en
   vivo. El segundo navegador del criterio de aceptación (a) —"dos
   navegadores muestran el mismo segundo"— entra casi siempre DESPUÉS
   del play, y por ese camino el reloj no viaja como evento: viaja
   adentro del `estado` que `canales.suscribir` manda al conectar,
   sacado de `canal.reloj`.

   Nadie miraba ese campo. Una mutación de una línea en `reloj.js`
   —soltar el reloj del canal SIEMPRE y no sólo al detener— lo dejaba en
   `null` y las 439 pruebas seguían en verde: cualquiera que abriera
   /sala/istincho con la peli andando veía "Todavía no empezó la
   película" para siempre. */

test('el que abre la sala con la peli YA ANDANDO recibe el reloj en el `estado` inicial', async () => {
  const puesto = await pedirJson(`/api/sala/${SLUG}/reloj`, {
    metodo: 'POST', cookie: sesionDueno, cuerpo: { accion: 'reproducir', videoId: 'ep1' },
  });
  assert.equal(puesto.estado, 200);

  /* Y RECIÉN AHORA se abre el SSE. El orden es todo el test. */
  const sse = abrirSse(SLUG);
  await sse.primero;

  const primero = sse.eventos[0].datos;
  assert.equal(primero.tipo, 'estado', 'lo primero que se recibe es el estado');
  assert.ok(primero.reloj, 'el `estado` inicial tiene que traer el reloj del canal');
  assert.equal(primero.reloj.estado, 'reproduciendo');
  assert.equal(primero.reloj.videoId, 'ep1');

  /* Con la ficha adentro: el navegador arranca a cargar sin un pedido
     más, que es para lo que `paraElCable` la mete. */
  assert.match(primero.reloj.url, /maestra\.m3u8$/);
  assert.equal(primero.reloj.duracion, 1200.5);

  /* Y con `empezoEn`, que es lo ÚNICO de lo que la página saca la
     posición: el campo `posicion` de este objeto es la foto del momento
     del play y para el que llega tarde está viejo. */
  assert.ok(Number(primero.reloj.empezoEn) > 0, 'sin empezoEn no hay a qué segundo saltar');

  sse.cerrar();
});

test('el que abre la sala después de "detener" recibe reloj: null', async () => {
  /* El control negativo del test de arriba: que el `estado` traiga un
     reloj tiene que depender de que HAYA película puesta, no de que el
     campo esté siempre lleno.
     Y de paso fija el contrato del otro lado: "detenido" es la AUSENCIA
     de reloj, que es lo que deja que el canal se libere de memoria
     cuando se va el último. */
  const parado = await pedirJson(`/api/sala/${SLUG}/reloj`, {
    metodo: 'POST', cookie: sesionDueno, cuerpo: { accion: 'detener' },
  });
  assert.equal(parado.estado, 200);

  const sse = abrirSse(SLUG);
  await sse.primero;

  const primero = sse.eventos[0].datos;
  assert.equal(primero.tipo, 'estado');
  assert.equal(primero.reloj, null, 'sin peli puesta el estado no puede traer un reloj');

  sse.cerrar();
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
  await espectadores.conectar('1001', 'kick', {
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

test('no se puede escribir en una sala que no existe', async () => {
  /*
   * La guarda de `canalPermitido` en el chat no tenía una sola prueba:
   * sacarla sobrevivía las 411. Sin ella, un espectador logueado postea
   * a /api/sala/<lo-que-sea>/chat y el servidor le manda el mensaje a
   * Kick igual, porque más abajo el destinatario sale de
   * `vinculos.identidad('kick')` y no del slug de la URL.
   */
  espectadores.reiniciar();
  pedidosAKick = [];
  respuestaDeKick = { estado: 200, cuerpo: { data: { is_sent: true, message_id: 'm' } }, cabeceras: {} };
  /* Espectador propio y vivo: con uno al que otro test ya le cerró la
     sesión, esto contestaría 401 y el test pasaría sin probar nada. */
  const cookie = await nuevoEspectador('1004', 'la que prueba slugs');

  const { estado, datos } = await pedirJson('/api/sala/no-existe-esta-sala/chat', {
    metodo: 'POST', cookie, cuerpo: { texto: 'hola' },
  });

  assert.equal(estado, 404, `contestó ${estado}: sin la guarda esto es un 200`);
  assert.match(datos.error, /no existe/);
  assert.equal(pedidosAKick.length, 0, 'no se le puede haber pedido nada a Kick');
});

test('escribir en la sala de OTRO creador va al canal de ESE creador', async () => {
  /*
   * EL AGUJERO QUE LA FASE 2 DEJÓ MARCADO, ahora cerrado de verdad.
   *
   * `apiSalaChat` aceptaba cualquier slug permitido y después mandaba
   * el mensaje a `vinculos.identidad('kick')` —sin slug—, que es el
   * canal del DUEÑO. Un espectador escribiendo en
   * /api/sala/otrocanal/chat le publicaba en kick.com/istincho. La
   * Fase 2 lo tapó con un 503 y su propio autor lo llamó "un cartel de
   * obra, no la solución".
   *
   * Ahora se rutea. Lo que este test mira no es un código de estado
   * sino A DÓNDE FUE EL MENSAJE: el `broadcaster_user_id` del cuerpo
   * que salió hacia Kick tiene que ser el del OTRO creador (7777) y no
   * el del dueño (4242). Con el ruteo roto esto contesta 200 igual: la
   * única forma de ver la diferencia es abrir el pedido.
   */
  espectadores.reiniciar();
  pedidosAKick = [];
  respuestaDeKick = { estado: 200, cuerpo: { data: { is_sent: true, message_id: 'm' } }, cabeceras: {} };
  /* Espectador propio y vivo: con uno al que otro test ya le cerró la
     sesión, el pedido moriría en 401 antes de llegar al ruteo y el
     test pasaría por el motivo equivocado. */
  const cookie = await nuevoEspectador('1005', 'la de la sala ajena');

  const { estado } = await pedirJson(`/api/sala/${OTRO}/chat`, {
    metodo: 'POST', cookie, cuerpo: { texto: 'hola sala ajena' },
  });

  assert.equal(estado, 200, `contestó ${estado}`);
  assert.equal(pedidosAKick.length, 1, 'tiene que haber salido exactamente un mensaje');

  const cuerpo = JSON.parse(pedidosAKick[0].cuerpo);
  assert.equal(cuerpo.broadcaster_user_id, 7777,
    'el mensaje tiene que caer en el canal de ESA sala');
  assert.notEqual(cuerpo.broadcaster_user_id, 4242,
    'y NO en el del dueño del servicio, que es el bug que esto viene a cerrar');
});

test('una sala sin Kick vinculado contesta 503 y no manda nada a ningún lado', async () => {
  /* El 503 que queda es el de verdad: esta sala existe pero todavía no
     vinculó Kick, o sea que no hay a dónde mandar. Antes este código
     hacía las veces de "no sé rutear esto"; ahora dice sólo lo que
     dice.

     Es también el control negativo del test de arriba: sin él, un
     ruteo que mandara todo al dueño y otro que no mandara nada se
     verían igual desde afuera en la mitad de los casos. */
  const SINKICK = 'salasinkick';
  await almacen.poner('creadores', SINKICK,
    { slug: SINKICK, plan: 'amigo', usuarioId: '8888', salaAbierta: true });

  espectadores.reiniciar();
  pedidosAKick = [];
  const cookie = await nuevoEspectador('1006', 'la de la sala sin kick');

  const { estado, datos } = await pedirJson(`/api/sala/${SINKICK}/chat`, {
    metodo: 'POST', cookie, cuerpo: { texto: 'hola' },
  });

  assert.equal(estado, 503, `contestó ${estado}`);
  assert.match(datos.error, /no esta vinculado con Kick/);
  assert.equal(pedidosAKick.length, 0, 'no puede haber salido nada hacia Kick');
});

/* ================================================ entrar y salir

   `POST /api/sala/:slug/salir` no tenía una sola prueba HTTP, y es la
   única promesa de privacidad sobre datos de terceros de toda la fase:
   el refresh token de un espectador es de esa persona, no del dueño. */

test('salir borra el refresh token del espectador, no sólo la cookie', async () => {
  /*
   * EL BUG QUE ESTO ATAJA: sacar el `await espectadores.olvidar(...)`
   * del handler sobrevivía las 411 pruebas. La sesión se cerraba, la
   * cookie se borraba, la persona veía "saliste"... y su refresh token
   * de Kick se quedaba guardado en el servidor. El README y el
   * comentario del propio código prometen que no.
   *
   * Espectador propio (1003) para no depender de en qué orden corren
   * los demás tests ni pisarles el vínculo.
   */
  const USUARIO = '1003';
  const cookie = await nuevoEspectador(USUARIO, 'la que se va');

  assert.ok(await espectadores.leer(USUARIO), 'antes de salir el vínculo tiene que estar');

  const { estado, datos, cabeceras } = await pedirJson(`/api/sala/${SLUG}/salir`, {
    metodo: 'POST', cookie,
  });

  assert.equal(estado, 200);
  assert.equal(datos.ok, true);
  assert.match(cabeceras.get('set-cookie') ?? '', /sala_espectador=; .*Max-Age=0/,
    'la cookie se borra en el navegador');

  /* Y ACÁ ESTÁ LO QUE IMPORTA: el token no puede seguir del lado del
     servidor. Un "logout" que deja el refresh token es un logout de
     mentira. */
  assert.equal(await espectadores.leer(USUARIO), null,
    'salir tiene que borrar el refresh token del espectador, no sólo la cookie');

  /* Y la sesión tampoco vale más, aunque alguien se guarde la cookie. */
  const despues = await pedirJson(`/api/sala/${SLUG}/yo`, { cookie });
  assert.equal(despues.datos.entrado, false);
});

test('salir sin sesión no explota y contesta lo mismo', async () => {
  /* No dice si había alguien: quien prueba cookies no se entera. */
  const { estado, datos } = await pedirJson(`/api/sala/${SLUG}/salir`, { metodo: 'POST' });
  assert.equal(estado, 200);
  assert.equal(datos.ok, true);
});

test('/yo y /salir también validan el slug', async () => {
  /* Eran las dos únicas rutas de /api/sala/ que no pasaban por
     `canalPermitido`. No filtraban nada, pero una excepción sin motivo
     es una excepción que alguien copia en la Fase 3. */
  const yo = await pedirJson('/api/sala/no-existe-esta-sala/yo', { cookie: sesionEspectador });
  assert.equal(yo.estado, 404, `/yo contestó ${yo.estado}`);

  const salir = await pedirJson('/api/sala/no-existe-esta-sala/salir', {
    metodo: 'POST', cookie: sesionEspectador,
  });
  assert.equal(salir.estado, 404, `/salir contestó ${salir.estado}`);

  /* Y la sala de verdad sigue contestando. */
  const buena = await pedirJson(`/api/sala/${SLUG}/yo`);
  assert.equal(buena.estado, 200);
  assert.equal(buena.datos.entrado, false);
});

/* ==================================================== CSRF

   Los dos POST de /api/sala/ hacen lo mismo que sus hermanos de
   /api/chat/: uno escribe con el nombre de la persona en el chat de un
   tercero y el otro le borra los tokens. El argumento entero está en
   `servidor/origenes.js` y vale igual acá: la cookie es `SameSite=Lax`,
   así que sin el `Origin` una página ajena podía hacer que alguien
   escribiera —o que se quedara sin cuenta— sin darse cuenta. */

test('escribir en la Sala desde una página ajena no llega a Kick', async () => {
  espectadores.reiniciar();
  pedidosAKick = [];
  const cookie = await nuevoEspectador('1010', 'la del origen ajeno');

  const r = await pedirJson(`/api/sala/${SLUG}/chat`, {
    metodo: 'POST', cookie, cuerpo: { texto: 'desde otro sitio' },
    origen: 'https://malo.example',
  });
  assert.equal(r.estado, 403, `contestó ${r.estado}`);
  assert.equal(pedidosAKick.length, 0, 'ni siquiera se intentó');

  /* Sin `Origin` tampoco: los navegadores lo mandan en todo POST de
     fetch, así que exigirlo no rompe a nadie que use la página. */
  espectadores.reiniciar();
  const sinOrigen = await pedirJson(`/api/sala/${SLUG}/chat`, {
    metodo: 'POST', cookie, cuerpo: { texto: 'sin origen' }, origen: '',
  });
  assert.equal(sinOrigen.estado, 403, `contestó ${sinOrigen.estado}`);
  assert.equal(pedidosAKick.length, 0);
});

test('salir de la Sala desde una página ajena no le borra la cuenta a nadie', async () => {
  const cookie = await nuevoEspectador('1011', 'la que no se quiere ir');

  const r = await pedirJson(`/api/sala/${SLUG}/salir`, {
    metodo: 'POST', cookie, origen: 'https://malo.example',
  });
  assert.equal(r.estado, 403, `contestó ${r.estado}`);
  assert.ok(await espectadores.leer('1011'), 'una página ajena no puede cerrarle la sesión a nadie');

  /* Y desde una página nuestra sigue saliendo, que es el control
     negativo: sin él, un 403 clavado pasaría igual. */
  const propio = await pedirJson(`/api/sala/${SLUG}/salir`, { metodo: 'POST', cookie });
  assert.equal(propio.estado, 200);
  assert.equal(await espectadores.leer('1011'), null);
});

/* ============================ el slug que llega con basura */

test('un slug con espacios no revienta: se normaliza igual que en /api/chat/', async () => {
  /*
   * EL BUG QUE ESTO ATAJA: `apiSalaChat` normalizaba con
   * `.toLowerCase()` y sin `trim`, mientras que `creadores.existe` sí
   * recorta. O sea que " istincho" pasaba la guarda y después reventaba
   * adentro de `vinculos.identidad`, fuera de todo try/catch: un 500
   * con stack trace en los logs, desde una ruta que alcanza cualquiera
   * con una cookie.
   */
  espectadores.reiniciar();
  pedidosAKick = [];
  respuestaDeKick = { estado: 200, cuerpo: { data: { is_sent: true, message_id: 'm' } }, cabeceras: {} };
  const cookie = await nuevoEspectador('1012', 'la del slug raro');

  const r = await pedirJson(`/api/sala/%20${SLUG}/chat`, {
    metodo: 'POST', cookie, cuerpo: { texto: 'con un espacio adelante' },
  });
  assert.notEqual(r.estado, 500, 'un slug con un espacio no puede ser un 500');
  assert.equal(r.estado, 200, `contestó ${r.estado}`);
  assert.equal(JSON.parse(pedidosAKick.at(-1).cuerpo).broadcaster_user_id, 4242,
    'y cae en el canal de esa sala, no en otro');

  /* Las otras dos rutas de /api/sala/ ya normalizaban así. */
  espectadores.reiniciar();
  assert.equal((await pedirJson(`/api/sala/%20${SLUG}/yo`, { cookie })).estado, 200);
});

test('un slug con espacios en /eventos no abre un canal fantasma', async () => {
  /*
   * LA MISMA CLASE DE BICHO, POR LA PUERTA DEL BUS. `canalPermitido`
   * recorta antes de comparar, así que `/eventos/%20istincho` pasaba la
   * guarda y después se suscribía a un canal llamado " istincho": una
   * entrada nueva en el Map por cada conexión, la presencia contada en
   * una clave que no es la sala, y —lo que se ve— un chat mudo para
   * siempre, porque lo que difunde el webhook cae en "istincho" y ahí
   * no lo escucha nadie.
   */
  const raro = abrirSse(`%20${SLUG}`);
  await raro.primero;
  assert.equal(raro.eventos[0].datos.slug, SLUG, 'el sobre tiene que decir la sala de verdad');
  assert.equal(canales.hayCanal(` ${SLUG}`), false, 'no se puede haber creado un canal con el nombre raro');

  canales.recordar(SLUG, { tipo: 'chat', red: 'kick', id: 'k-raro', usuario: 'alguien', texto: 'hola al del slug raro' });
  const llegado = await raro.esperar('chat');
  assert.equal(llegado.datos.texto, 'hola al del slug raro',
    'quien entra con un espacio de más tiene que escuchar el chat de esa sala igual');

  raro.cerrar();
});

/* ====================== el permiso vencido y el baneo no son lo mismo */

test('un 401 de Kick no le borra el Twitch a nadie', async () => {
  /*
   * EL BUG QUE ESTO ATAJA: la Sala llamaba a `espectadores.olvidar`,
   * que desde la Fase 5.3 borra el documento ENTERO. El espectador es
   * uno solo para todo el dominio, así que un permiso de Kick vencido
   * mientras miraba una peli le borraba de paso el Twitch que estaba
   * usando en /chat/<slug>, que no tiene nada que ver.
   */
  espectadores.reiniciar();
  const id = '1013';
  await espectadores.conectar(id, 'kick', {
    usuarioId: id, nombre: 'la de las dos redes',
    accessToken: 'acceso-kick', refreshToken: 'refresco-kick',
    venceEn: Date.now() + 3600_000, scopes: 'user:read chat:write',
  });
  await espectadores.conectar(id, 'twitch', {
    usuarioId: 'tw-1013', nombre: 'la de las dos redes', login: 'lasdos',
    accessToken: 'acceso-twitch', refreshToken: 'refresco-twitch',
    venceEn: Date.now() + 3600_000, scopes: 'user:write:chat',
  });
  const cookie = cookieEspectador(await sesion.crear({ tipo: 'espectador', usuario: id, nombre: 'la de las dos redes' }));
  respuestaDeKick = { estado: 401, cuerpo: { error: 'unauthorized' }, cabeceras: {} };

  const r = await pedirJson(`/api/sala/${SLUG}/chat`, {
    metodo: 'POST', cookie, cuerpo: { texto: 'se me venció el permiso' },
  });
  assert.equal(r.estado, 401, `contestó ${r.estado}`);

  const v = await espectadores.leer(id);
  assert.ok(v, 'el espectador no se puede haber borrado entero');
  assert.deepEqual(espectadores.redesDe(v), ['twitch'],
    'se va el Kick que Kick rechazó, y el Twitch que anda se queda');
  assert.equal(v.twitch.accessToken, 'acceso-twitch', 'y su token de Twitch no se tocó');

  respuestaDeKick = { estado: 200, cuerpo: { data: { is_sent: true } }, cabeceras: {} };
  await espectadores.olvidar(id);
});

test('un 403 de Kick es un baneo del canal, no un permiso vencido', async () => {
  /*
   * LOS DOS SE TRATABAN IGUAL, y son cosas distintas: 401 es "este
   * token no sirve más" y 403 es "vos no podés escribir acá" (baneado,
   * sólo seguidores, sólo suscriptores). Tratar el segundo como el
   * primero le borraba el permiso a alguien que lo tenía perfecto, y lo
   * mandaba a reconectar su cuenta para volver a chocar contra el mismo
   * baneo.
   */
  espectadores.reiniciar();
  const cookie = await nuevoEspectador('1014', 'la baneada en el canal');
  respuestaDeKick = { estado: 403, cuerpo: { error: 'banned' }, cabeceras: {} };

  const r = await pedirJson(`/api/sala/${SLUG}/chat`, {
    metodo: 'POST', cookie, cuerpo: { texto: 'estoy baneada' },
  });
  assert.equal(r.estado, 403, `contestó ${r.estado}: un baneo no es un 401`);
  assert.ok(await espectadores.leer('1014'), 'un baneo del canal no le borra el permiso a nadie');
  assert.equal((r.cabeceras.get('set-cookie') ?? ''), '', 'ni le cierra la sesión');

  respuestaDeKick = { estado: 200, cuerpo: { data: { is_sent: true } }, cabeceras: {} };
  await espectadores.olvidar('1014');
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
