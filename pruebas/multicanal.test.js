/* ============================================================
   La Fase 3 de punta a punta: el servidor levantado de verdad, dos
   creadores distintos, y pedidos HTTP reales.

   Se prueba así y no llamando a los módulos sueltos porque el
   aislamiento es una propiedad del SERVICIO, no de una función. Un
   test que llame a `videos.listar(slug)` con el slug correcto pasa
   siempre; lo que hay que garantizar es que no exista NINGUNA forma de
   pedir, por HTTP, los datos de otra sala.

   Los tres criterios de aceptación que se cubren acá:
     (a) con una segunda cuenta se crea una Sala nueva, se marca como
         "amigo" desde /admin, y su Sala funciona sin tocar la del dueño;
     (b) un creador "pendiente" no puede reproducir;
     (c) el webhook de cobro cambia el plan a "pago".

   Lo que NO se puede probar acá y queda anotado en la bitácora: nada
   sale a Kick, a Twitch, a R2 ni a Paddle. Kick se falsea con un
   `fetch` que contesta como su API, el webhook se firma con un par RSA
   propio, y R2 y Paddle se ejercitan hasta la puerta.
   ============================================================ */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';

/* Las variables van ANTES de importar el servidor: los módulos las
   leen al cargarse. Ninguna es un secreto: son de mentira y no salen
   de este proceso. */
const DATOS = path.join(os.tmpdir(), 'sala-pruebas-multicanal');
process.env.SALA_DATOS = DATOS;
process.env.MODO = 'local';
process.env.KICK_SLUG = 'istincho';
process.env.KICK_CLIENT_ID = 'cliente-de-prueba';
process.env.KICK_CLIENT_SECRET = 'secreto-de-prueba';
process.env.URL_BASE = 'https://sala.example';
process.env.CLAVE_CIFRADO = crypto.randomBytes(32).toString('base64');
process.env.TOPE_CANALES = '4';
process.env.GB_AMIGO = '1';

/* R2 y Paddle, con credenciales de mentira. Las de R2 son las de
   ejemplo de la doc de AWS; las de Paddle, inventadas acá. */
process.env.R2_ACCOUNT_ID = 'cuentadeprueba';
process.env.R2_BUCKET = 'sala-video';
process.env.R2_ACCESS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE';
process.env.R2_SECRET_ACCESS_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
process.env.R2_URL_PUBLICA = 'https://pub-ejemplo.r2.dev';
process.env.PADDLE_CLAVE_WEBHOOK = 'pdl_ntfset_de_mentira';
process.env.PADDLE_API_KEY = 'pdl_apikey_de_mentira';
process.env.PADDLE_PRECIO_ID = 'pri_de_mentira';

const { crearServidor } = await import('../servidor/index.js');
const almacen = await import('../servidor/almacen.js');
const canales = await import('../servidor/canales.js');
const chat = await import('../servidor/chat.js');
const creadores = await import('../servidor/creadores.js');
const sesion = await import('../servidor/sesion.js');
const videos = await import('../servidor/videos.js');
const vinculos = await import('../servidor/vinculos.js');
const webhook = await import('../servidor/webhook.js');

const DUENO = 'istincho';
const ANA = 'ana';
const BETO = 'beto';

/* --------------------------------------------- las APIs de mentira */

const fetchDeVerdad = globalThis.fetch;

/* Lo que va a contestar Kick al canje del código y a /users y
   /channels. `quienSoy` decide qué cuenta vuelve del login. */
let quienSoy = { id: '111', nombre: 'Ana', slug: ANA };
let pedidosAKick = [];
let suscripcionesCreadas = [];
let pedidosAPaddle = [];
/* Si Kick acepta crear la suscripción de eventos. Se apaga para probar
   que el alta no depende de que Kick esté arriba. */
let kickSuscribeBien = true;

const json200 = obj => new Response(JSON.stringify(obj), {
  status: 200, headers: { 'Content-Type': 'application/json' },
});

globalThis.fetch = async (entrada, opciones) => {
  const url = String(typeof entrada === 'string' ? entrada : entrada?.url ?? '');
  const metodo = opciones?.method ?? 'GET';

  if (url.startsWith('https://id.kick.com/oauth/token')) {
    return json200({
      access_token: `acceso-de-${quienSoy.slug}`,
      refresh_token: `refresco-de-${quienSoy.slug}`,
      expires_in: 3600,
      scope: 'user:read channel:read chat:write events:subscribe',
    });
  }

  if (url.startsWith('https://api.kick.com')) {
    pedidosAKick.push({ url, metodo, cuerpo: opciones?.body });

    if (url.includes('/users')) {
      return json200({ data: [{ user_id: Number(quienSoy.id), name: quienSoy.nombre }] });
    }
    if (url.includes('/channels')) {
      return json200({
        data: [{
          broadcaster_user_id: Number(quienSoy.id),
          slug: quienSoy.slug,
          stream: { is_live: false },
        }],
      });
    }
    if (url.includes('/events/subscriptions')) {
      if (!kickSuscribeBien) return new Response('{"error":"nope"}', { status: 503 });
      if (metodo === 'POST') {
        suscripcionesCreadas.push(JSON.parse(opciones.body));
        return json200({ data: [{ id: 'sub-1' }] });
      }
      return json200({ data: [] });
    }
    if (url.includes('/chat')) {
      return json200({ data: { is_sent: true, message_id: 'm-1' } });
    }
    return json200({ data: [] });
  }

  if (url.startsWith('https://sandbox-api.paddle.com/transactions')) {
    pedidosAPaddle.push({ url, metodo, cuerpo: opciones?.body });
    return json200({ data: { id: 'txn_9', checkout: { url: 'https://sandbox-pay.paddle.io/hsc_9' } } });
  }

  /* Nada más puede salir. Si algún día un pedido a R2 o a Paddle se
     escapara de un doble, esto lo convierte en un fallo con nombre en
     vez de un timeout de treinta segundos. */
  if (/^https?:\/\/(?!127\.0\.0\.1|localhost)/.test(url)) {
    throw new Error(`este test no sale a internet, y alguien pidio ${url.slice(0, 80)}`);
  }
  return fetchDeVerdad(entrada, opciones);
};

/* El WebSocket de Twitch no se abre. */
class ConexionFalsa {
  constructor(opciones) { this.opciones = opciones; this.ultimaLlegada = null; }
  conectar() { this.conectada = true; }
  cerrar() { this.cerrada = true; }
}

/* Par RSA propio para firmar los webhooks de Kick, igual que en
   webhook.test.js: la privada de Kick no existe de este lado y una de
   prueba no se versiona. */
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const firmarKick = (id, ts, crudo) => {
  const s = crypto.createSign('RSA-SHA256');
  s.update(`${id}.${ts}.${crudo}`);
  s.end();
  return s.sign(privateKey, 'base64');
};

const firmarPaddle = (cuerpo, ts = Math.floor(Date.now() / 1000)) =>
  `ts=${ts};h1=` + crypto.createHmac('sha256', process.env.PADDLE_CLAVE_WEBHOOK)
    .update(`${ts}:${cuerpo}`).digest('hex');

/* ---------------------------------------------------------- ayudas */

let servidor;
let raiz;

const cookieCreador = v => `${sesion.COOKIES.dueno}=${v}`;

let sesionDueno = '';
let sesionAna = '';
let sesionBeto = '';

async function pedir(ruta, { metodo = 'GET', cookie = '', cuerpo, cabeceras = {}, seguir = 'manual' } = {}) {
  const h = { ...cabeceras };
  if (cookie) h.Cookie = cookie;
  if (cuerpo !== undefined && !h['Content-Type']) h['Content-Type'] = 'application/json';
  const r = await fetch(raiz + ruta, {
    method: metodo,
    headers: h,
    body: cuerpo === undefined ? undefined : (typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo)),
    redirect: seguir,
  });
  let datos = null;
  const texto = await r.text();
  try { datos = JSON.parse(texto); } catch { /* no era json */ }
  return { estado: r.status, datos, texto, cabeceras: r.headers };
}

/**
 * El viaje entero del alta: /oauth/kick/entrar con el rol y los
 * términos, y después el callback con el `state` que quedó.
 *
 * Se hace el viaje completo y no una llamada a la función suelta a
 * propósito: la versión de los términos cruza el servidor en dos tramos
 * (se guarda en el Map de logins pendientes y se lee en el callback), y
 * un test de la función suelta pasaría con la comprobación puesta en
 * cualquiera de los dos, incluso en ninguno.
 */
async function entrarConKick({ id, nombre, slug, rol = 'creador', terminos = '' }) {
  quienSoy = { id, nombre, slug };

  const entrada = await pedir(
    `/oauth/kick/entrar?rol=${rol}&destino=/panel` + (terminos ? `&terminos=${terminos}` : ''));
  assert.equal(entrada.estado, 302, 'el login tiene que redirigir a Kick');
  const estado = new URL(entrada.cabeceras.get('location')).searchParams.get('state');
  assert.ok(estado, 'la URL de Kick tiene que llevar el state');

  const vuelta = await pedir(`/oauth/kick/volver?code=un-codigo&state=${estado}`);
  const cookie = (vuelta.cabeceras.get('set-cookie') ?? '').split(';')[0];
  return { ...vuelta, cookie, destino: vuelta.cabeceras.get('location') ?? '' };
}

const fichaDe = (slug, id = 'ep1') => ({
  id, slug, titulo: `Episodio de ${slug}`, duracion: 600,
  url: `https://pub-ejemplo.r2.dev/${slug}/${id}/maestra.m3u8`,
  calidades: [720], subtitulos: [], bytes: 10,
});

/* ------------------------------------------------------- arranque */

test.before(async () => {
  await fsp.rm(DATOS, { recursive: true, force: true }).catch(() => {});
  webhook.fijarClavePublica(publicKey);
  chat.fijarConexiones({
    eventSub: o => new ConexionFalsa(o),
    irc: o => new ConexionFalsa(o),
  });

  servidor = crearServidor();
  await new Promise(ok => servidor.listen(0, '127.0.0.1', ok));
  raiz = `http://127.0.0.1:${servidor.address().port}`;
});

test.after(async () => {
  globalThis.fetch = fetchDeVerdad;
  chat.parar();
  chat.fijarConexiones();
  canales.cerrarTodo();
  await new Promise(ok => servidor.close(ok));
  await fsp.rm(DATOS, { recursive: true, force: true }).catch(() => {});
});

/* ==================================================== el alta */

test('sin aceptar los terminos no se crea ninguna sala', async () => {
  /* La casilla de /crear se puede saltear escribiendo la dirección a
     mano; la puerta de verdad es ésta. Si esto no estuviera, cualquiera
     tendría sala sin haber leído nada. */
  const r = await entrarConKick({ id: '111', nombre: 'Ana', slug: ANA });

  assert.equal(r.estado, 200, 'contesta una página, no una redirección');
  assert.match(r.texto, /aceptar los terminos/i);
  assert.equal(await creadores.obtener(ANA), null, 'y NO quedó creada');
});

test('con los terminos aceptados se crea la sala, pendiente, y se guarda la fecha', async () => {
  suscripcionesCreadas = [];
  const r = await entrarConKick({ id: '111', nombre: 'Ana', slug: ANA, terminos: creadores.TERMINOS_VERSION });

  assert.equal(r.estado, 302);
  assert.equal(r.destino, '/panel');
  assert.ok(r.cookie.startsWith(sesion.COOKIES.dueno + '='), 'y queda logueada');
  sesionAna = r.cookie;

  const c = await creadores.obtener(ANA);
  assert.ok(c, 'la sala tiene que existir');
  assert.equal(c.plan, 'pendiente');
  assert.equal(c.usuarioId, '111');
  assert.equal(c.terminos.version, creadores.TERMINOS_VERSION);
  assert.ok(c.terminos.cuando > 0, 'la fecha de aceptación tiene que quedar guardada');

  /* Y su canal quedó suscripto al chat, que es lo que hace que su Sala
     no nazca muda. */
  const v = await vinculos.identidad(ANA, 'kick');
  assert.equal(v.usuarioId, '111');
});

test('una version de terminos vieja no sirve para darse de alta', async () => {
  const r = await entrarConKick({ id: '222', nombre: 'Beto', slug: BETO, terminos: '0' });
  assert.match(r.texto, /aceptar los terminos/i);
  assert.equal(await creadores.obtener(BETO), null);
});

test('el segundo creador entra y no toca al primero', async () => {
  const r = await entrarConKick({ id: '222', nombre: 'Beto', slug: BETO, terminos: creadores.TERMINOS_VERSION });
  assert.equal(r.estado, 302);
  sesionBeto = r.cookie;

  assert.equal((await creadores.obtener(BETO)).usuarioId, '222');
  assert.equal((await creadores.obtener(ANA)).usuarioId, '111', 'Ana sigue siendo Ana');
});

test('volver a entrar no le baja el plan a quien ya lo tenia', async () => {
  await creadores.ponerPlan(ANA, 'amigo', { quien: 'dueno' });
  const r = await entrarConKick({ id: '111', nombre: 'Ana', slug: ANA });   // sin términos
  assert.equal(r.estado, 302, 'la que ya tiene sala entra sin volver a aceptar nada');
  sesionAna = r.cookie;
  assert.equal(await creadores.planDe(ANA), 'amigo');
});

test('el dueño del servicio entra por la misma puerta y su plan no sale de la base', async () => {
  const r = await entrarConKick({ id: '4242', nombre: 'IsTincho', slug: DUENO });
  assert.equal(r.estado, 302);
  sesionDueno = r.cookie;

  assert.equal(await creadores.planDe(DUENO), 'dueno');
  const fila = await creadores.obtener(DUENO);
  assert.equal(fila.plan, 'pendiente', 'su fila dice lo que dice cualquier fila nueva');
  assert.equal(await creadores.puedeReproducir(DUENO), true, 'y sin embargo puede reproducir');
});

test('una cuenta de Kick sin canal no puede tener sala', async () => {
  const r = await entrarConKick({ id: '999', nombre: 'Sin Canal', slug: '', terminos: creadores.TERMINOS_VERSION });
  assert.equal(r.estado, 200);
  assert.match(r.texto, /no tiene un canal/i);
});

test('el alta no depende de que Kick acepte la suscripcion', async () => {
  /* Si fallar la suscripción rompiera el alta, un rato de Kick caído
     dejaría a la gente sin poder crear su sala por algo que el
     verificador de cada cinco minutos arregla solo. */
  kickSuscribeBien = false;
  try {
    const r = await entrarConKick({ id: '333', nombre: 'Cora', slug: 'cora', terminos: creadores.TERMINOS_VERSION });
    assert.equal(r.estado, 302, 'entra igual');
    assert.ok(await creadores.obtener('cora'));
  } finally {
    kickSuscribeBien = true;
  }
});

test('llegado el tope no entran mas salas, y las que ya estaban siguen entrando', async () => {
  /* Cuatro: istincho, ana, beto, cora. El tope de este archivo es 4. */
  assert.equal(await creadores.cuantos(), 4);

  const r = await entrarConKick({ id: '444', nombre: 'Dani', slug: 'dani', terminos: creadores.TERMINOS_VERSION });
  assert.equal(r.estado, 200);
  assert.match(r.texto, /no entran mas salas/i);
  assert.equal(await creadores.obtener('dani'), null);

  /* Y la contracara: con el tope lleno, la que ya tenía sala entra. */
  const ana = await entrarConKick({ id: '111', nombre: 'Ana', slug: ANA });
  assert.equal(ana.estado, 302);
  sesionAna = ana.cookie;
});

/* ============================================ el panel es de uno solo */

test('el panel de cada creador habla de SU sala y de ninguna otra', async () => {
  await videos.guardar(fichaDe(ANA));
  await videos.guardar(fichaDe(BETO));

  const deAna = await pedir('/api/panel', { cookie: sesionAna });
  assert.equal(deAna.estado, 200);
  assert.equal(deAna.datos.slug, ANA);
  assert.ok(deAna.datos.videos.every(v => v.slug === ANA),
    'el catálogo del panel no puede traer un video de otra sala');

  const deBeto = await pedir('/api/panel', { cookie: sesionBeto });
  assert.equal(deBeto.datos.slug, BETO);
  assert.ok(deBeto.datos.videos.every(v => v.slug === BETO));

  /* Y el texto entero de la respuesta de una no puede nombrar a la
     otra: es el cinturón contra un campo nuevo que se agregue mañana y
     que traiga datos ajenos sin que nadie lo note. */
  assert.ok(!deAna.texto.includes(BETO), `la respuesta de ${ANA} nombra a ${BETO}`);
  assert.ok(!deBeto.texto.includes(ANA), `la respuesta de ${BETO} nombra a ${ANA}`);
});

test('no hay ningun parametro que haga que el panel hable de otra sala', async () => {
  /* La fuga de inquilino que la verificación de la Fase 2 dejó anotada:
     `videos.listar(SLUG_DUENO)` volviéndose elegible por query. Se
     prueban las tres formas de intentarlo. */
  for (const intento of [
    `/api/panel?slug=${BETO}`,
    `/api/videos?slug=${BETO}`,
    `/api/panel?sala=${BETO}&creador=${BETO}`,
  ]) {
    const r = await pedir(intento, { cookie: sesionAna });
    assert.equal(r.estado, 200);
    assert.ok(!r.texto.includes(BETO), `${intento} filtró datos de otra sala`);
  }
});

test('el catalogo por cookie es el de la cookie, no el del dueño', async () => {
  const r = await pedir('/api/videos', { cookie: sesionBeto });
  assert.equal(r.estado, 200);
  assert.ok(r.datos.videos.length > 0);
  assert.ok(r.datos.videos.every(v => v.slug === BETO));
});

test('la salud del chat es la de su propia sala', async () => {
  const r = await pedir('/api/chat/salud', { cookie: sesionAna });
  assert.equal(r.estado, 200);
  assert.ok(!r.texto.includes(BETO));
});

test('una sesion de una sala borrada no abre ningun panel', async () => {
  /* Una cookie puede sobrevivir a la sala. Sin esta comprobación
     seguiría dando acceso al panel de algo que ya no está, y peor: a
     un `slug` que podría volver a existir con otro dueño. */
  const cookie = cookieCreador(await sesion.crear({
    tipo: 'dueno', usuario: '555', nombre: 'Fantasma', slug: 'fantasma',
  }));
  const r = await pedir('/api/panel', { cookie });
  assert.equal(r.estado, 403);
  assert.match(r.datos.error, /no corresponde a ninguna sala/);
});

/* ================================== el reloj: de quien es y quien puede */

test('un creador no puede tocar el reloj de otra sala', async () => {
  const r = await pedir(`/api/sala/${BETO}/reloj`, {
    metodo: 'POST', cookie: sesionAna, cuerpo: { accion: 'detener' },
  });
  assert.equal(r.estado, 403);
  assert.match(r.datos.error, /no es tuya/);
});

test('el dueño del SERVICIO tampoco es dueño de las salas de los demas', async () => {
  /* La versión vieja comparaba contra KICK_SLUG, así que con un solo
     creador daba el resultado correcto por casualidad. Acá se ve la
     diferencia: la cookie del dueño no abre la sala de Ana. */
  const r = await pedir(`/api/sala/${ANA}/reloj`, {
    metodo: 'POST', cookie: sesionDueno, cuerpo: { accion: 'detener' },
  });
  assert.equal(r.estado, 403);
});

test('una sala que no existe da 404 antes que 401, con cookie y sin ella', async () => {
  /* La decisión de orden que la Fase 2 dejó abierta: primero la sala,
     después la cookie, igual que el chat. Las dos rutas hermanas tienen
     que contestar lo mismo al mismo pedido. */
  const sinCookie = await pedir('/api/sala/no-existe/reloj', { metodo: 'POST', cuerpo: { accion: 'detener' } });
  assert.equal(sinCookie.estado, 404);

  const conCookie = await pedir('/api/sala/no-existe/reloj', {
    metodo: 'POST', cookie: sesionAna, cuerpo: { accion: 'detener' },
  });
  assert.equal(conCookie.estado, 404);

  /* Y el chat, que es la hermana, contesta lo mismo. */
  const chatSinCookie = await pedir('/api/sala/no-existe/chat', { metodo: 'POST', cuerpo: { texto: 'hola' } });
  assert.equal(chatSinCookie.estado, 404, 'las dos rutas tienen que decir lo mismo');
});

test('un creador PENDIENTE no puede reproducir, y lo dice', async () => {
  /* Criterio de aceptación (b). Se prueba contra el servidor y no
     mirando si el botón está gris: la página puede mentir, este pedido
     no. */
  await creadores.ponerPlan(BETO, 'pendiente', { quien: 'dueno' });
  await videos.guardar(fichaDe(BETO));

  const r = await pedir(`/api/sala/${BETO}/reloj`, {
    metodo: 'POST', cookie: sesionBeto, cuerpo: { accion: 'reproducir', videoId: 'ep1' },
  });

  assert.equal(r.estado, 402, `contestó ${r.estado}`);
  assert.equal(r.datos.plan, 'pendiente');

  const reloj = await pedir('/api/panel', { cookie: sesionBeto });
  assert.equal(reloj.datos.reloj.estado, 'detenido', 'y la película no arrancó');
  assert.equal(reloj.datos.soloLectura, true);
});

test('tampoco puede pausar ni saltar: el plan tapa el reloj entero', async () => {
  /* Si sólo se tapara "reproducir", un plan vencido podría seguir
     manejando una película que ya estaba andando. */
  for (const accion of ['pausar', 'reanudar', 'saltar', 'detener']) {
    const r = await pedir(`/api/sala/${BETO}/reloj`, {
      metodo: 'POST', cookie: sesionBeto, cuerpo: { accion, segundos: 10 },
    });
    assert.equal(r.estado, 402, `${accion} tendría que estar tapada`);
  }
});

test('un creador VENCIDO tampoco reproduce', async () => {
  await creadores.ponerPlan(BETO, 'pago', { vence: Date.now() - 1000, quien: 'cobro' });
  const r = await pedir(`/api/sala/${BETO}/reloj`, {
    metodo: 'POST', cookie: sesionBeto, cuerpo: { accion: 'reproducir', videoId: 'ep1' },
  });
  assert.equal(r.estado, 402);
  assert.equal(r.datos.plan, 'vencido');
});

test('con plan "amigo" la sala reproduce igual que la del dueño', async () => {
  /* Criterio de aceptación (a): la sala nueva funciona igual, sin tocar
     la del dueño. */
  await creadores.ponerPlan(ANA, 'amigo', { quien: 'dueno' });
  await videos.guardar(fichaDe(ANA));

  const r = await pedir(`/api/sala/${ANA}/reloj`, {
    metodo: 'POST', cookie: sesionAna, cuerpo: { accion: 'reproducir', videoId: 'ep1' },
  });
  assert.equal(r.estado, 200, JSON.stringify(r.datos));
  assert.equal(r.datos.reloj.estado, 'reproduciendo');
  assert.equal(r.datos.reloj.videoId, 'ep1');

  /* Y la del dueño no se movió. */
  const delDueno = await pedir('/api/panel', { cookie: sesionDueno });
  assert.equal(delDueno.datos.reloj.estado, 'detenido');
});

/* ================================================ el bus por sala */

test('cada sala tiene su bus y el evento de una no llega a la otra', async () => {
  const abrir = slug => new Promise((ok) => {
    const eventos = [];
    const req = http.get({
      host: '127.0.0.1', port: servidor.address().port, path: `/eventos/${slug}`,
    }, res => {
      let pendiente = '';
      res.setEncoding('utf8');
      res.on('data', trozo => {
        pendiente += trozo;
        let corte;
        while ((corte = pendiente.indexOf('\n\n')) >= 0) {
          const bloque = pendiente.slice(0, corte);
          pendiente = pendiente.slice(corte + 2);
          const d = bloque.split('\n').filter(l => l.startsWith('data:'))
            .map(l => l.slice(5).replace(/^ /, '')).join('\n');
          if (d) eventos.push(JSON.parse(d));
        }
      });
      ok({ eventos, cerrar: () => req.destroy() });
    });
  });

  const deAna = await abrir(ANA);
  const deBeto = await abrir(BETO);
  try {
    await new Promise(ok => setTimeout(ok, 50));
    canales.difundir(ANA, { tipo: 'prueba', marca: 'solo-para-ana' });
    await new Promise(ok => setTimeout(ok, 80));

    assert.ok(deAna.eventos.some(e => e.marca === 'solo-para-ana'), 'no llegó al bus de Ana');
    assert.ok(!deBeto.eventos.some(e => e.marca === 'solo-para-ana'),
      'el evento de una sala se coló en el bus de otra');
  } finally {
    deAna.cerrar();
    deBeto.cerrar();
  }
});

test('/eventos de un slug inventado sigue siendo 404', async () => {
  const r = await pedir('/eventos/no-existe-nadie');
  assert.equal(r.estado, 404);
  assert.equal(canales.hayCanal('no-existe-nadie'), false,
    'y no dejó una entrada en el mapa de canales');
});

/* ====================================== el webhook rutea por canal */

test('un webhook de Kick cae en la sala de SU broadcaster', async () => {
  /* La mina que la Fase 2 dejó marcada, del lado de la entrada: el slug
     salía del payload con el del dueño como respaldo, así que un evento
     sin `channel_slug` se difundía en el canal del DUEÑO. */
  const cuerpo = JSON.stringify({
    message_id: 'm-de-beto',
    broadcaster: { user_id: 222, username: 'Beto', channel_slug: BETO },
    sender: { user_id: 9, username: 'Fulana', identity: null },
    content: 'hola sala de beto',
    created_at: new Date().toISOString(),
  });
  const id = 'EV-BETO-1';
  const ts = new Date().toISOString();

  const r = await pedir('/kick/webhook', {
    metodo: 'POST', cuerpo,
    cabeceras: {
      'Content-Type': 'application/json',
      'Kick-Event-Message-Id': id,
      'Kick-Event-Message-Timestamp': ts,
      'Kick-Event-Signature': firmarKick(id, ts, cuerpo),
      'Kick-Event-Type': 'chat.message.sent',
      'Kick-Event-Version': '1',
    },
  });
  assert.equal(r.estado, 200);

  const enBeto = canales.ultimos(BETO);
  assert.equal(enBeto.at(-1)?.texto, 'hola sala de beto');
  assert.ok(!canales.ultimos(DUENO).some(m => m.texto === 'hola sala de beto'),
    'el chat de un creador cayó en la sala del dueño');
});

test('un webhook de un canal que no es de nadie no crea ninguna sala', async () => {
  const cuerpo = JSON.stringify({
    message_id: 'm-de-nadie',
    broadcaster: { user_id: 987654, username: 'Ajeno', channel_slug: 'canal-ajeno' },
    sender: { user_id: 9, username: 'Fulana', identity: null },
    content: 'no tendria que entrar',
    created_at: new Date().toISOString(),
  });
  const id = 'EV-AJENO-1';
  const ts = new Date().toISOString();

  const r = await pedir('/kick/webhook', {
    metodo: 'POST', cuerpo,
    cabeceras: {
      'Content-Type': 'application/json',
      'Kick-Event-Message-Id': id,
      'Kick-Event-Message-Timestamp': ts,
      'Kick-Event-Signature': firmarKick(id, ts, cuerpo),
      'Kick-Event-Type': 'chat.message.sent',
      'Kick-Event-Version': '1',
    },
  });

  /* 200 porque no es culpa de Kick y no queremos que lo reintente para
     siempre; lo que importa es lo que NO pasó. */
  assert.equal(r.estado, 200);
  assert.equal(canales.hayCanal('canal-ajeno'), false,
    'un payload fabricó un canal del bus con el nombre que quiso');
  for (const slug of [DUENO, ANA, BETO]) {
    assert.ok(!canales.ultimos(slug).some(m => m.texto === 'no tendria que entrar'),
      `el mensaje sin dueño terminó en la sala de ${slug}`);
  }
});

/* ============================================================ /admin */

test('/admin no existe para quien no es el dueño del servicio', async () => {
  /* 404 y no 403: una dirección que contesta distinto ya anuncia que
     hay un panel de administración y cómo se llama. */
  assert.equal((await pedir('/admin')).estado, 404);
  assert.equal((await pedir('/admin', { cookie: sesionAna })).estado, 404);

  const r = await pedir('/admin', { cookie: sesionDueno });
  assert.equal(r.estado, 200);
  assert.match(r.texto, /Creadores/);
});

test('la lista de creadores es solo del dueño', async () => {
  assert.equal((await pedir('/api/admin/creadores')).estado, 401);
  assert.equal((await pedir('/api/admin/creadores', { cookie: sesionAna })).estado, 403);

  const r = await pedir('/api/admin/creadores', { cookie: sesionDueno });
  assert.equal(r.estado, 200);
  const slugs = r.datos.creadores.map(c => c.slug).sort();
  assert.deepEqual(slugs, [ANA, BETO, 'cora', DUENO].sort());
  assert.equal(r.datos.tope, 4);
});

test('la lista muestra el plan guardado y el que vale hoy', async () => {
  await creadores.ponerPlan(BETO, 'pago', { vence: Date.now() - 1000, quien: 'cobro' });
  const r = await pedir('/api/admin/creadores', { cookie: sesionDueno });
  const beto = r.datos.creadores.find(c => c.slug === BETO);

  assert.equal(beto.plan, 'pago', 'lo guardado');
  assert.equal(beto.planEfectivo, 'vencido', 'y lo que vale hoy');

  const dueno = r.datos.creadores.find(c => c.slug === DUENO);
  assert.equal(dueno.planEfectivo, 'dueno', 'el del dueño no sale de su fila');
});

test('el dueño marca a alguien como amigo y le empieza a andar la sala', async () => {
  /* Criterio de aceptación (a), el tramo de /admin. */
  const r = await pedir('/api/admin/plan', {
    metodo: 'POST', cookie: sesionDueno, cuerpo: { slug: BETO, plan: 'amigo' },
  });
  assert.equal(r.estado, 200);
  assert.equal(await creadores.planDe(BETO), 'amigo');

  const play = await pedir(`/api/sala/${BETO}/reloj`, {
    metodo: 'POST', cookie: sesionBeto, cuerpo: { accion: 'reproducir', videoId: 'ep1' },
  });
  assert.equal(play.estado, 200, 'con "amigo" tiene que poder reproducir');
});

test('el dueño NO puede poner "pago" ni "vencido" a mano', async () => {
  for (const plan of ['pago', 'vencido']) {
    const r = await pedir('/api/admin/plan', {
      metodo: 'POST', cookie: sesionDueno, cuerpo: { slug: ANA, plan },
    });
    assert.equal(r.estado, 400, `"${plan}" no lo puede poner el dueño`);
    assert.match(r.datos.error, /proveedor de cobro/);
  }
  assert.equal(await creadores.planDe(ANA), 'amigo', 'y no cambió nada');
});

test('el dueño no se cambia el plan a si mismo', async () => {
  const r = await pedir('/api/admin/plan', {
    metodo: 'POST', cookie: sesionDueno, cuerpo: { slug: DUENO, plan: 'pendiente' },
  });
  assert.equal(r.estado, 400);
  assert.equal(await creadores.planDe(DUENO), 'dueno');
});

test('un creador no puede cambiarse el plan usando /api/admin', async () => {
  const r = await pedir('/api/admin/plan', {
    metodo: 'POST', cookie: sesionAna, cuerpo: { slug: ANA, plan: 'amigo' },
  });
  assert.equal(r.estado, 403);
});

/* ================================================ el webhook de cobro */

const eventoPaddle = (slug, estado = 'active') => JSON.stringify({
  event_id: 'evt_1',
  event_type: 'subscription.activated',
  data: {
    id: 'sub_ana',
    status: estado,
    customer_id: 'ctm_ana',
    custom_data: { slug, servicio: 'sala' },
    next_billed_at: new Date(Date.now() + 30 * 86400_000).toISOString(),
  },
});

test('un webhook de cobro firmado pasa el plan a "pago"', async () => {
  /* Criterio de aceptación (c). La firma se calcula acá con la misma
     clave que tiene el servidor, que es lo que hace Paddle. */
  await creadores.ponerPlan(ANA, 'pendiente', { quien: 'dueno' });
  const cuerpo = eventoPaddle(ANA);

  const r = await pedir('/cobro/webhook', {
    metodo: 'POST', cuerpo,
    cabeceras: { 'Content-Type': 'application/json', 'Paddle-Signature': firmarPaddle(cuerpo) },
  });

  assert.equal(r.estado, 200);
  assert.equal(await creadores.planDe(ANA), 'pago');

  const doc = await creadores.obtener(ANA);
  assert.equal(doc.cobro.suscripcionId, 'sub_ana');
  assert.ok(doc.vence > Date.now(), 'con vencimiento en el futuro');
});

test('un webhook de cobro sin firma no cambia nada', async () => {
  await creadores.ponerPlan(ANA, 'pendiente', { quien: 'dueno' });
  const cuerpo = eventoPaddle(ANA);

  const r = await pedir('/cobro/webhook', {
    metodo: 'POST', cuerpo, cabeceras: { 'Content-Type': 'application/json' },
  });

  assert.equal(r.estado, 400);
  assert.equal(await creadores.planDe(ANA), 'pendiente', 'el plan no se movió');
});

test('un webhook de cobro con el cuerpo cambiado despues de firmar no cambia nada', async () => {
  /* El caso que importa: el que intercepta el aviso y le cambia el slug
     para hacerse pagar el plan por otro. */
  const original = eventoPaddle(ANA);
  const firma = firmarPaddle(original);
  const cambiado = original.replace(`"slug":"${ANA}"`, `"slug":"${BETO}"`);
  const antes = await creadores.planDe(BETO);

  const r = await pedir('/cobro/webhook', {
    metodo: 'POST', cuerpo: cambiado,
    cabeceras: { 'Content-Type': 'application/json', 'Paddle-Signature': firma },
  });

  assert.equal(r.estado, 400);
  assert.equal(await creadores.planDe(BETO), antes);
});

test('un webhook de cobro para una sala que no existe se contesta 200 y no crea nada', async () => {
  const cuerpo = eventoPaddle('sala-que-no-existe');
  const r = await pedir('/cobro/webhook', {
    metodo: 'POST', cuerpo,
    cabeceras: { 'Content-Type': 'application/json', 'Paddle-Signature': firmarPaddle(cuerpo) },
  });
  assert.equal(r.estado, 200, 'que Paddle deje de reintentar');
  assert.equal(await creadores.obtener('sala-que-no-existe'), null);
});

test('una cancelacion baja el plan a vencido', async () => {
  const cuerpo = eventoPaddle(ANA, 'canceled');
  const r = await pedir('/cobro/webhook', {
    metodo: 'POST', cuerpo,
    cabeceras: { 'Content-Type': 'application/json', 'Paddle-Signature': firmarPaddle(cuerpo) },
  });
  assert.equal(r.estado, 200);
  assert.equal(await creadores.planDe(ANA), 'vencido');
  assert.equal(await creadores.puedeReproducir(ANA), false);
});

/* ================================================= la subida por creador */

test('las URL prefirmadas son del prefijo de quien pide y de ningun otro', async () => {
  await creadores.ponerPlan(ANA, 'amigo', { quien: 'dueno' });

  const r = await pedir('/api/subida', {
    metodo: 'POST', cookie: sesionAna,
    cuerpo: { id: 'ep7', archivos: [{ ruta: 'maestra.m3u8', bytes: 100 }, { ruta: '720p/lista.m3u8', bytes: 50 }] },
  });

  assert.equal(r.estado, 200, JSON.stringify(r.datos));
  assert.equal(r.datos.archivos.length, 2);
  for (const a of r.datos.archivos) {
    const url = new URL(a.url);
    assert.ok(url.pathname.startsWith(`/sala-video/${ANA}/ep7/`),
      `la URL firmada se salió del prefijo: ${url.pathname}`);
    assert.ok(url.searchParams.get('X-Amz-Signature'), 'y viene firmada');
  }
  assert.equal(r.datos.urlPublica, `https://pub-ejemplo.r2.dev/${ANA}/ep7/`);
});

test('una ruta que se escapa del prefijo no se firma', async () => {
  /* Es la línea entera del aislamiento del bucket: sin esto, Ana firma
     un PUT sobre `beto/ep1/maestra.m3u8` y le pisa la película. */
  for (const ruta of ['../beto/ep1/maestra.m3u8', '../../otro.ts', '/absoluta.ts', 'a//b.ts']) {
    const r = await pedir('/api/subida', {
      metodo: 'POST', cookie: sesionAna, cuerpo: { id: 'ep7', archivos: [{ ruta, bytes: 1 }] },
    });
    assert.equal(r.estado, 400, `"${ruta}" no tendría que firmarse`);
  }
});

test('el prefijo sale de la cookie: no hay forma de pedir el de otro', async () => {
  const r = await pedir('/api/subida', {
    metodo: 'POST', cookie: sesionAna,
    cuerpo: { id: 'ep7', slug: BETO, sala: BETO, archivos: [{ ruta: 'x.ts', bytes: 1 }] },
  });
  assert.equal(r.estado, 200);
  assert.ok(new URL(r.datos.archivos[0].url).pathname.startsWith(`/sala-video/${ANA}/`),
    'mandar el slug en el cuerpo no puede cambiar el prefijo');
});

test('un plan sin reproduccion tampoco sube', async () => {
  await creadores.ponerPlan(BETO, 'pendiente', { quien: 'dueno' });
  const r = await pedir('/api/subida', {
    metodo: 'POST', cookie: sesionBeto, cuerpo: { id: 'ep7', archivos: [{ ruta: 'x.ts', bytes: 1 }] },
  });
  assert.equal(r.estado, 402);
  await creadores.ponerPlan(BETO, 'amigo', { quien: 'dueno' });
});

test('el tope de GB se compara contra lo que hay en R2, no contra lo declarado', async () => {
  /* Los bytes que declara el que sube los elige el que sube. Si el tope
     se calculara con eso, mentir en el número sería el ataque entero. */
  const original = globalThis.fetch;
  globalThis.fetch = async (entrada, opciones) => {
    const url = String(typeof entrada === 'string' ? entrada : entrada?.url ?? '');
    if (url.includes('r2.cloudflarestorage.com')) {
      /* R2 dice que ya hay 2 GB. El plan "amigo" de este archivo tiene
         1 GB (GB_AMIGO=1), así que no entra ni un byte más. */
      return new Response(
        '<?xml version="1.0"?><ListBucketResult><Contents><Key>ana/viejo/x.ts</Key>' +
        `<Size>${2 * 1024 ** 3}</Size></Contents><IsTruncated>false</IsTruncated></ListBucketResult>`,
        { status: 200 });
    }
    return original(entrada, opciones);
  };
  try {
    const r = await pedir('/api/subida', {
      metodo: 'POST', cookie: sesionAna,
      /* Declara UN byte: si el tope mirara esto, entraría. */
      cuerpo: { id: 'ep8', archivos: [{ ruta: 'x.ts', bytes: 1 }] },
    });
    assert.equal(r.estado, 409, `contestó ${r.estado}: el tope no miró R2`);
    assert.match(r.datos.error, /no entra/);
    assert.equal(r.datos.topeGb, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test('el dueño del servicio no tiene tope y no sale a medir', async () => {
  const r = await pedir('/api/subida', {
    metodo: 'POST', cookie: sesionDueno, cuerpo: { id: 'ep9', archivos: [{ ruta: 'x.ts', bytes: 1 }] },
  });
  assert.equal(r.estado, 200);
  assert.ok(new URL(r.datos.archivos[0].url).pathname.startsWith(`/sala-video/${DUENO}/`));
});

test('sin sesion no se firma nada', async () => {
  const r = await pedir('/api/subida', {
    metodo: 'POST', cuerpo: { id: 'ep7', archivos: [{ ruta: 'x.ts', bytes: 1 }] },
  });
  assert.equal(r.estado, 401);
});

/* ============================================ la clave de subida */

test('cada creador genera SU clave y no la de otro', async () => {
  const deAna = await pedir('/api/panel/clave', { metodo: 'POST', cookie: sesionAna });
  assert.equal(deAna.estado, 200);
  assert.equal(await videos.salaDeLaClave(deAna.datos.clave), ANA);

  const deBeto = await pedir('/api/panel/clave', { metodo: 'POST', cookie: sesionBeto });
  assert.equal(await videos.salaDeLaClave(deBeto.datos.clave), BETO);

  /* Y la de una no escribe en el catálogo de la otra. */
  const r = await pedir('/api/videos', {
    metodo: 'POST', cabeceras: { 'X-Clave-Subida': deAna.datos.clave },
    cuerpo: fichaDe(BETO, 'colado'),
  });
  assert.equal(r.estado, 403);
  assert.equal(await videos.obtener(BETO, 'colado'), null);
});

/* ================================================= las paginas nuevas */

test('/crear y /terminos se sirven a cualquiera', async () => {
  const crear = await pedir('/crear');
  assert.equal(crear.estado, 200);
  assert.match(crear.texto, /rol=creador/, 'el botón tiene que llevar el rol del alta');
  assert.ok(crear.texto.includes(`terminos=${creadores.TERMINOS_VERSION}`),
    'y la versión de los términos que se está aceptando');

  const terminos = await pedir('/terminos');
  assert.equal(terminos.estado, 200);
  assert.match(terminos.texto, /responsable/i);
});

test('la version de los terminos de la pagina es la que exige el servidor', async () => {
  /* Si la página ofreciera aceptar una versión que el servidor ya no
     acepta, nadie podría darse de alta y el error diría "falta aceptar
     los términos" justo después de haberlos aceptado. */
  const crear = await pedir('/crear');
  const enLaPagina = /terminos=(\d+)/.exec(crear.texto)?.[1];
  assert.equal(enLaPagina, creadores.TERMINOS_VERSION);
});


/* ======================== la subida desde una terminal (subir.py)

   `herramientas/subir.py` corre en la PC del creador, no en un
   navegador: no hay cookie que mandar ni OAuth que completar. Manda la
   misma `X-Clave-Subida` que ya usa para avisar del video.

   Sin esto, el entregable 5 de la fase no se puede cumplir: el script
   no tendría cómo pedir una URL prefirmada. */

test('la clave de subida sirve para pedir URL prefirmadas', async () => {
  await creadores.ponerPlan(ANA, 'amigo', { quien: 'dueno' });
  /* El test del tope dejó anotados 2 GB de uso para Ana, y el plan de
     este archivo son 1 GB. Se limpia acá y no en un beforeEach porque
     el archivo cuenta una historia en orden y ese estado es parte de
     ella: lo que se limpia es sólo lo que este test no está probando. */
  await creadores.anotarUso(ANA, 0);
  const { datos: clave } = await pedir('/api/panel/clave', { metodo: 'POST', cookie: sesionAna });

  const r = await pedir('/api/subida', {
    metodo: 'POST',
    cabeceras: { 'X-Clave-Subida': clave.clave },
    cuerpo: { id: 'desdeterminal', archivos: [{ ruta: 'maestra.m3u8', bytes: 10 }] },
  });

  assert.equal(r.estado, 200, JSON.stringify(r.datos));
  assert.ok(new URL(r.datos.archivos[0].url).pathname.startsWith('/sala-video/' + ANA + '/desdeterminal/'));
});

test('la clave de una sala no firma nada de otra', async () => {
  /* El mismo aislamiento que ya tiene POST /api/videos, del otro lado
     del trámite: sin esto, la clave de Ana firmaría un PUT sobre el
     prefijo de Beto y le pisaría la película. */
  await creadores.anotarUso(ANA, 0);
  const { datos: deAna } = await pedir('/api/panel/clave', { metodo: 'POST', cookie: sesionAna });

  const r = await pedir('/api/subida', {
    metodo: 'POST',
    cabeceras: { 'X-Clave-Subida': deAna.clave },
    /* Se intenta de las dos formas: por el cuerpo y por la ruta. */
    cuerpo: { id: 'ep1', slug: BETO, archivos: [{ ruta: '../' + BETO + '/ep1/maestra.m3u8', bytes: 1 }] },
  });

  assert.equal(r.estado, 400, 'la ruta con .. tiene que rebotar');

  const r2 = await pedir('/api/subida', {
    metodo: 'POST',
    cabeceras: { 'X-Clave-Subida': deAna.clave },
    cuerpo: { id: 'ep1', slug: BETO, archivos: [{ ruta: 'maestra.m3u8', bytes: 1 }] },
  });
  assert.equal(r2.estado, 200);
  assert.ok(new URL(r2.datos.archivos[0].url).pathname.startsWith('/sala-video/' + ANA + '/'),
    'el prefijo sale de la clave, no del cuerpo');
});

test('una clave inventada no cae en la cookie del navegador de al lado', async () => {
  /* Si una clave mala cayera en la cookie, un script mal configurado
     "funcionaría" cuando lo corre alguien con sesión abierta y fallaría
     en la máquina de al lado. Se contesta 401 y punto. */
  const r = await pedir('/api/subida', {
    metodo: 'POST',
    cookie: sesionAna,
    cabeceras: { 'X-Clave-Subida': 'esta-clave-no-existe' },
    cuerpo: { id: 'ep1', archivos: [{ ruta: 'x.ts', bytes: 1 }] },
  });
  assert.equal(r.estado, 401);
  assert.match(r.datos.error, /clave de subida invalida/);
});

test('--listar también anda con la clave', async () => {
  const { datos: clave } = await pedir('/api/panel/clave', { metodo: 'POST', cookie: sesionBeto });
  const r = await pedir('/api/videos', { cabeceras: { 'X-Clave-Subida': clave.clave } });

  assert.equal(r.estado, 200);
  assert.ok(r.datos.videos.every(v => v.slug === BETO));
  assert.ok(!r.texto.includes(ANA), 'y sigue sin ver el catálogo de la otra sala');
});

test('los borrados se firman por el mismo camino', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (entrada, opciones) => {
    const url = String(typeof entrada === 'string' ? entrada : entrada?.url ?? '');
    if (url.includes('r2.cloudflarestorage.com')) {
      return new Response(
        '<?xml version="1.0"?><ListBucketResult>' +
        '<Contents><Key>' + ANA + '/ep1/maestra.m3u8</Key><Size>10</Size></Contents>' +
        '<Contents><Key>' + ANA + '/ep1/720p/lista.m3u8</Key><Size>20</Size></Contents>' +
        '<IsTruncated>false</IsTruncated></ListBucketResult>', { status: 200 });
    }
    return original(entrada, opciones);
  };
  try {
    const { datos: clave } = await pedir('/api/panel/clave', { metodo: 'POST', cookie: sesionAna });
    const r = await pedir('/api/subida/borrar', {
      metodo: 'POST',
      cabeceras: { 'X-Clave-Subida': clave.clave },
      cuerpo: { id: 'ep1' },
    });

    assert.equal(r.estado, 200, JSON.stringify(r.datos));
    assert.equal(r.datos.archivos.length, 2);
    for (const a of r.datos.archivos) {
      assert.ok(a.clave.startsWith(ANA + '/ep1/'));
      assert.ok(new URL(a.url).searchParams.get('X-Amz-Signature'));
    }
  } finally {
    globalThis.fetch = original;
  }
});


/* ============================================= el botón de suscribirse */

test('suscribirse lleva al checkout con el slug adentro', async () => {
  await creadores.ponerPlan(BETO, 'pendiente', { quien: 'dueno' });
  pedidosAPaddle = [];

  const r = await pedir('/api/panel/suscribirse', { metodo: 'POST', cookie: sesionBeto });

  assert.equal(r.estado, 200, JSON.stringify(r.datos));
  assert.equal(r.datos.url, 'https://sandbox-pay.paddle.io/hsc_9');
  assert.equal(pedidosAPaddle.length, 1);
  const cuerpo = JSON.parse(pedidosAPaddle[0].cuerpo);
  assert.equal(cuerpo.custom_data.slug, BETO,
    'sin el slug, el pago vuelve sin saber de quién es y se cobra sin habilitar nada');
});

test('sin el cobro configurado se avisa en vez de mandar a un error de un tercero', async () => {
  /* El caso de hoy: el dueño todavía no eligió proveedor. El botón
     tiene que decirlo, no llevar a una pantalla rota de Paddle. */
  const antes = process.env.PADDLE_API_KEY;
  pedidosAPaddle = [];
  try {
    delete process.env.PADDLE_API_KEY;
    const r = await pedir('/api/panel/suscribirse', { metodo: 'POST', cookie: sesionBeto });

    assert.equal(r.estado, 503, 'contestó ' + r.estado);
    assert.match(r.datos.error, /PADDLE_API_KEY/);
    assert.equal(pedidosAPaddle.length, 0, 'no se le pide nada a un proveedor sin configurar');
  } finally {
    process.env.PADDLE_API_KEY = antes;
  }
});

test('el dueño del servicio no se suscribe a sí mismo', async () => {
  const r = await pedir('/api/panel/suscribirse', { metodo: 'POST', cookie: sesionDueno });
  assert.equal(r.estado, 400);
});

test('sin sesión no se crea ningún checkout', async () => {
  pedidosAPaddle = [];
  const r = await pedir('/api/panel/suscribirse', { metodo: 'POST' });
  assert.equal(r.estado, 401);
  assert.equal(pedidosAPaddle.length, 0);
});
