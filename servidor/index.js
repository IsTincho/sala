/* ============================================================
   Sala: servidor.

   Un solo proceso Node en Railway con http nativo y enrutador propio.
   Sin framework: las rutas son diez, el ruteo entra en cuarenta lineas
   y una dependencia mas es una dependencia mas que auditar.

   Lo que hay aca:
     /                        paginas estaticas de paginas/
     /eventos/:slug           SSE, un stream por canal
     /oauth/kick/entrar       login con Kick (OAuth 2.1 + PKCE)
     /oauth/kick/volver       callback
     /oauth/twitch/entrar     vinculacion de Twitch (code flow)
     /oauth/twitch/volver     callback
     /kick/webhook            eventos de Kick, firmados con RSA
     /api/estado              como esta el servidor

   LO QUE ESTE SERVIDOR NO HACE NUNCA: servir video. El navegador le
   pide los segmentos directo a R2. Si algun dia una ruta de aca
   devuelve un .ts o un .m3u8, el egreso de Railway se come el
   presupuesto del mes en una noche.
   ============================================================ */

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import nodeCrypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as almacen from './almacen.js';
import * as canales from './canales.js';
import * as cifrado from './cifrado.js';
import * as kick from './kick.js';
import * as sesion from './sesion.js';
import * as twitch from './twitch.js';
import * as webhook from './webhook.js';

const AQUI    = path.dirname(fileURLToPath(import.meta.url));
const PAGINAS = path.join(AQUI, '..', 'paginas');

const PUERTO = Number(process.env.PORT ?? 8778);

/* Por defecto "produccion", no "local", y es a proposito: MODO=local
   habilita un endpoint de prueba que se saltea la verificacion de
   firma. Si el default fuera local, olvidarse de cargar la variable en
   Railway dejaria esa puerta abierta en produccion. Que el descuido
   rompa el desarrollo y no la seguridad. */
const MODO = process.env.MODO ?? 'produccion';
const ES_LOCAL = MODO === 'local';

const SLUG_DUENO = (process.env.KICK_SLUG ?? '').toLowerCase();

/* ------------------------------------------------------------ ayudas */

const json = (res, codigo, obj, cabeceras = {}) => {
  const cuerpo = JSON.stringify(obj);
  res.writeHead(codigo, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(cuerpo),
    ...cabeceras,
  });
  res.end(cuerpo);
};

const texto = (res, codigo, s, cabeceras = {}) => {
  res.writeHead(codigo, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...cabeceras,
  });
  res.end(s);
};

const redirigir = (res, destino, cabeceras = {}) => {
  res.writeHead(302, { Location: destino, 'Cache-Control': 'no-store', ...cabeceras });
  res.end();
};

/** Una pagina de texto simple, para los finales de los flujos OAuth. */
function pagina(res, titulo, cuerpo) {
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${escapar(titulo)} · Sala</title>` +
    `<link rel="stylesheet" href="/comun/base.css"></head>` +
    `<body><main class="contenedor"><div class="tarjeta">` +
    `<h1>${escapar(titulo)}</h1><p>${escapar(cuerpo)}</p>` +
    `<p><a href="/">Volver</a></p></div></main></body></html>`;
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(html);
}

/* Todo lo que llega de afuera (un nombre de Kick, un mensaje de error)
   pasa por aca antes de entrar al HTML. Es una pagina de cuatro
   lineas, pero un nombre de usuario con `<script>` adentro es un XSS
   igual de real en cuatro lineas que en cuatrocientas. */
const escapar = s => String(s)
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#39;');

/** El cuerpo crudo de un pedido. Crudo importa: el webhook lo firma. */
function leerCuerpo(req, tope = 1_000_000) {
  return new Promise((ok, mal) => {
    let d = '';
    req.on('data', c => {
      d += c;
      if (d.length > tope) { mal(new Error('cuerpo demasiado grande')); req.destroy(); }
    });
    req.on('end', () => ok(d));
    req.on('error', mal);
  });
}

/**
 * La base publica del sitio: la que tiene que coincidir con el redirect
 * registrado en Kick y en Twitch.
 *
 * URL_BASE manda. Si no esta, se arma con lo que dice el pedido, que
 * en local es lo correcto y en Railway tambien, pero depende de un
 * header que un cliente puede mentir. Por eso en produccion URL_BASE
 * no es opcional: sin ella, alguien podria mandar un Host falso y
 * hacer que el link de login apunte a otro lado.
 */
function baseDe(req) {
  if (process.env.URL_BASE) return process.env.URL_BASE.replace(/\/+$/, '');
  const protocolo = req.headers['x-forwarded-proto'] ?? 'http';
  return `${protocolo}://${req.headers.host ?? `localhost:${PUERTO}`}`;
}

/* --------------------------------------------------------- estaticos */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css' : 'text/css; charset=utf-8',
  '.js'  : 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png' : 'image/png',
  '.jpg' : 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif' : 'image/gif',
  '.webp': 'image/webp',
  '.svg' : 'image/svg+xml',
  '.ico' : 'image/x-icon',
  '.woff2': 'font/woff2',
};

/* El codigo se sirve no-cache y las imagenes con max-age: durante un
   stream se corrige un CSS y se recarga, y no puede quedar el viejo
   pegado; una imagen, en cambio, no cambia nunca y no tiene sentido
   volver a pedirla. */
const ES_CODIGO = ['.html', '.css', '.js', '.json', '.webmanifest'];

async function estatico(url, req, res) {
  let partes;
  try {
    partes = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  } catch {
    return false;   // %ZZ y cosas asi: no es una ruta, no es nuestra
  }

  /* La raiz es la pagina de estado. */
  if (!partes.length) partes = ['index.html'];

  /* Dos cinturones para lo mismo, porque un traversal que funcione
     serviria cualquier archivo del contenedor, incluido servidor/.env
     si algun dia existiera ahi. El primero rechaza el '..' explicito;
     el segundo comprueba que la ruta YA RESUELTA siga adentro de
     paginas/, que es lo que ataja los casos raros de codificacion y de
     separadores de Windows. */
  if (partes.includes('..') || partes.some(p => p.includes('\0'))) return false;

  const destino = path.join(PAGINAS, ...partes);
  if (destino !== PAGINAS && !destino.startsWith(PAGINAS + path.sep)) return false;

  let st;
  try { st = await fsp.stat(destino); }
  catch { return false; }
  if (st.isDirectory()) return false;

  const ext = path.extname(destino).toLowerCase();
  const modificado = st.mtime.toUTCString();

  if (req.headers['if-modified-since'] === modificado) {
    res.writeHead(304, { 'Cache-Control': 'no-cache', 'Last-Modified': modificado });
    res.end();
    return true;
  }

  res.writeHead(200, {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Content-Length': st.size,
    'Cache-Control': ES_CODIGO.includes(ext) ? 'no-cache' : 'public, max-age=86400',
    'Last-Modified': modificado,
  });
  if (req.method === 'HEAD') return res.end(), true;
  fs.createReadStream(destino).pipe(res);
  return true;
}

/* ---------------------------------------------------------- OAuth */

/* Twitch no tiene PKCE confirmado en su doc, asi que el state es lo
   unico que ata el callback con quien lo empezo. Vive en memoria y se
   vence solo, igual que el de Kick. */
const VENTANA_LOGIN = 10 * 60 * 1000;
const pendientesTwitch = new Map();

function nuevoEstadoTwitch(destino = '') {
  const ahora = Date.now();
  for (const [k, v] of pendientesTwitch) if (v.vence < ahora) pendientesTwitch.delete(k);
  const estado = nodeCrypto.randomBytes(16).toString('base64url');
  pendientesTwitch.set(estado, { destino, vence: ahora + VENTANA_LOGIN });
  return estado;
}

async function kickEntrar(url, req, res) {
  if (!kick.hayCredenciales()) {
    return pagina(res, 'Falta configurar Kick',
      'Todavia no estan cargadas KICK_CLIENT_ID y KICK_CLIENT_SECRET en Railway.');
  }
  const rol = url.searchParams.get('rol') === 'dueno' ? 'dueno' : 'espectador';
  const { url: destino } = kick.urlLogin({
    redirect: `${baseDe(req)}/oauth/kick/volver`,
    rol,
    destino: url.searchParams.get('destino') ?? '',
  });
  return redirigir(res, destino);
}

/*
 * En la Fase 0 el callback llega hasta "sos fulano" y ahi se planta: el
 * token se usa para preguntar quien sos y se descarta sin guardarlo.
 *
 * Es deliberado. Guardar el refresh token cifrado y decidir roles es
 * trabajo de la Fase 1, y hacerlo a medias ahora dejaria tokens de
 * verdad en la base antes de que exista el codigo que los cuida. Asi,
 * en cambio, el dueño puede probar el circuito entero de OAuth apenas
 * cargue las credenciales, y lo peor que puede pasar es que tenga que
 * loguearse de nuevo la proxima fase.
 */
async function kickVolver(url, req, res) {
  const error = url.searchParams.get('error');
  if (error) return pagina(res, 'Kick no autorizo', `Kick contesto: ${error}`);

  const code = url.searchParams.get('code') ?? '';
  const estado = url.searchParams.get('state') ?? '';
  if (!code || !estado) return pagina(res, 'Falta algo', 'El callback vino sin code o sin state.');

  try {
    const t = await kick.canjearCodigo({ code, estado });
    const yo = await kick.quienEs(t.accessToken);
    const esDueno = Boolean(SLUG_DUENO) && yo.slug.toLowerCase() === SLUG_DUENO;
    return pagina(res, `Hola, ${yo.nombre}`,
      `Kick te reconocio (id ${yo.id}${yo.slug ? `, canal ${yo.slug}` : ''}). ` +
      `${esDueno ? 'Sos el dueño del canal. ' : ''}` +
      `El token no se guardo: eso llega en la Fase 1.`);
  } catch (e) {
    return pagina(res, 'No se pudo completar el login', e.message);
  }
}

async function twitchEntrar(url, req, res) {
  if (!twitch.hayCredenciales()) {
    return pagina(res, 'Falta configurar Twitch',
      'Todavia no estan cargadas TWITCH_CLIENT_ID y TWITCH_CLIENT_SECRET en Railway.');
  }
  const estado = nuevoEstadoTwitch(url.searchParams.get('destino') ?? '');
  return redirigir(res, twitch.urlLogin({
    redirect: `${baseDe(req)}/oauth/twitch/volver`,
    estado,
  }));
}

async function twitchVolver(url, req, res) {
  const error = url.searchParams.get('error');
  if (error) return pagina(res, 'Twitch no autorizo', `Twitch contesto: ${error}`);

  const code = url.searchParams.get('code') ?? '';
  const estado = url.searchParams.get('state') ?? '';
  if (!pendientesTwitch.has(estado)) {
    return pagina(res, 'Ese login ya no vale', 'El state no coincide o se vencio. Proba de nuevo.');
  }
  pendientesTwitch.delete(estado);

  try {
    const t = await twitch.canjearCodigo({ code, redirect: `${baseDe(req)}/oauth/twitch/volver` });
    const yo = await twitch.usuarioActual(t.accessToken);
    return pagina(res, `Hola, ${yo.nombre}`,
      `Twitch te reconocio (id ${yo.id}, usuario ${yo.login}). ` +
      `El token no se guardo: eso llega en la Fase 1.`);
  } catch (e) {
    return pagina(res, 'No se pudo completar el login', e.message);
  }
}

/* --------------------------------------------------------- webhook */

/**
 * Un evento de Kick. Tres puertas antes de creerle:
 *   1. que la firma RSA de el
 *   2. que no lo hayamos procesado ya (Kick reintenta)
 *   3. que el JSON parsee
 *
 * El 401 de la primera no da detalles a proposito: quien esta
 * probando firmas no tiene por que enterarse de cual fallo.
 */
async function kickWebhook(url, req, res) {
  const crudo = await leerCuerpo(req);

  if (!await webhook.verificar(req.headers, crudo)) {
    return texto(res, 401, 'firma invalida');
  }

  const evento = webhook.datosDelEvento(req.headers);

  /* Ya visto: se contesta 200 igual. Un 4xx haria que Kick lo siga
     reintentando para siempre, y el problema no es de Kick. */
  if (webhook.yaVisto(evento.id)) return texto(res, 200, 'repetido');

  let cuerpo;
  try { cuerpo = JSON.parse(crudo); }
  catch { return texto(res, 400, 'json invalido'); }

  await procesarEvento(evento, cuerpo);
  return texto(res, 200, 'ok');
}

/*
 * Fase 0: se anota que llego y se reparte crudo por SSE para poder ver
 * el circuito de punta a punta.
 *
 * La traduccion al formato unico de mensaje (servidor/mensajes.js) es
 * de la Fase 1. No se inventa aca un formato provisorio: un formato
 * provisorio que se filtra al cliente es despues imposible de cambiar.
 */
async function procesarEvento(evento, cuerpo) {
  const slug = cuerpo?.broadcaster?.channel_slug ?? SLUG_DUENO;
  if (!slug) return;
  canales.difundir(slug, { tipo: 'kick', evento: evento.tipo, cuando: evento.cuando });
  console.log(`[webhook] ${evento.tipo} de ${slug}`);
}

/**
 * Inyecta un evento como si viniera de Kick, SIN verificar firma.
 *
 * Solo existe con MODO=local. Los webhooks de verdad no llegan a una
 * maquina de casa, y sin esto no habria forma de ver la pagina
 * reaccionar mientras se desarrolla. En produccion esta ruta no esta
 * registrada: no es que rechace, es que no existe.
 */
async function pruebaWebhook(url, req, res) {
  const crudo = await leerCuerpo(req);
  let cuerpo;
  try { cuerpo = crudo ? JSON.parse(crudo) : {}; }
  catch { return json(res, 400, { error: 'json invalido' }); }

  const slug = url.searchParams.get('canal') ?? cuerpo?.broadcaster?.channel_slug ?? SLUG_DUENO;
  const cuantos = canales.difundir(slug, {
    tipo: 'prueba',
    cuerpo,
    cuando: new Date().toISOString(),
  });
  return json(res, 200, { ok: true, canal: slug, llegoA: cuantos });
}

/* ------------------------------------------------------------- api */

async function apiEstado(url, req, res) {
  return json(res, 200, {
    modo: MODO,
    slug: SLUG_DUENO,
    hora: Date.now(),
    almacen: almacen.dondeGuarda(),
    canales: canales.resumen(),
    /* Que falta para que esto funcione de verdad. Sin este bloque, el
       dia que el login no anda hay que adivinar cual de las cinco
       variables es la que falta. No dice NUNCA el valor de ninguna. */
    listo: {
      kick: kick.hayCredenciales(),
      twitch: twitch.hayCredenciales(),
      cifrado: cifrado.hayClave(),
      mongo: almacen.dondeGuarda().modo === 'mongo',
    },
  });
}

/* --------------------------------------------------------- enrutador

   La tabla es literal y se lee de arriba abajo. Un `:nombre` en el
   patron se convierte en un parametro. No hay comodines ni prioridades
   raras: si una ruta no esta en esta lista, no existe. */

function compilar(patron) {
  const nombres = [];
  const regex = patron
    .split('/')
    .map(parte => {
      if (!parte.startsWith(':')) return parte.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      nombres.push(parte.slice(1));
      return '([^/]+)';
    })
    .join('/');
  return { regex: new RegExp(`^${regex}$`), nombres };
}

const RUTAS = [
  ['GET',  '/api/estado',          apiEstado],
  ['GET',  '/eventos/:slug',       (url, req, res, p) => canales.suscribir(p.slug, req, res)],
  ['GET',  '/oauth/kick/entrar',   kickEntrar],
  ['GET',  '/oauth/kick/volver',   kickVolver],
  ['GET',  '/oauth/twitch/entrar', twitchEntrar],
  ['GET',  '/oauth/twitch/volver', twitchVolver],
  ['POST', '/kick/webhook',        kickWebhook],
  /* la de prueba solo se registra en local; ver pruebaWebhook */
  ...(ES_LOCAL ? [['POST', '/api/prueba/webhook', pruebaWebhook]] : []),
].map(([metodo, patron, manejador]) => ({ metodo, patron, manejador, ...compilar(patron) }));

export async function manejar(req, res) {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  const ruta = url.pathname;

  for (const r of RUTAS) {
    const m = r.regex.exec(ruta);
    if (!m) continue;
    /* La ruta existe pero con otro metodo: 405 y no 404. La diferencia
       le ahorra media hora a quien esta probando con curl. */
    if (r.metodo !== req.method && !(r.metodo === 'GET' && req.method === 'HEAD')) {
      return texto(res, 405, `${ruta} solo acepta ${r.metodo}`, { Allow: r.metodo });
    }
    const params = {};
    r.nombres.forEach((n, i) => { params[n] = decodeURIComponent(m[i + 1]); });
    return r.manejador(url, req, res, params);
  }

  if ((req.method === 'GET' || req.method === 'HEAD') && await estatico(url, req, res)) return;

  return texto(res, 404, 'no existe');
}

export function crearServidor() {
  return http.createServer(async (req, res) => {
    try {
      await manejar(req, res);
    } catch (e) {
      console.error('[http]', req.method, req.url, e);
      /* Si ya se empezo a escribir (un SSE, un archivo), no se puede
         mandar un status: lo unico honesto es cortar. */
      if (!res.headersSent) json(res, 500, { error: 'error del servidor' });
      else res.end();
    }
  });
}

/* ---------------------------------------------------------- arranque */

export async function arrancar() {
  /* Lo que falta se dice AHORA y en voz alta. Un servidor que arranca
     lo mas contento y falla recien cuando alguien intenta loguearse es
     un servidor que te hace perder la tarde. */
  if (!cifrado.hayClave()) {
    console.warn(`[sala] sin CLAVE_CIFRADO: no hay sesiones ni tokens guardados ` +
                 `(${cifrado.porQueNoHayClave()})`);
  }
  if (!kick.hayCredenciales())   console.warn('[sala] sin credenciales de Kick');
  if (!twitch.hayCredenciales()) console.warn('[sala] sin credenciales de Twitch');
  if (!SLUG_DUENO)               console.warn('[sala] sin KICK_SLUG: no se sabe cual es el canal del dueño');
  if (ES_LOCAL) console.warn('[sala] MODO=local: /api/prueba/webhook esta abierto y sin firma');

  const donde = almacen.dondeGuarda();
  console.log(`[almacen] guardando en ${donde.modo}${donde.motivo ? ` (${donde.motivo})` : ''}`);

  if (cifrado.hayClave()) {
    try {
      const podadas = await sesion.podar();
      if (podadas) console.log(`[sesion] ${podadas} sesiones vencidas al arrancar`);
    } catch (e) {
      console.warn('[sesion] no se pudieron podar las sesiones:', e.name);
    }
  }

  canales.arrancarPings();

  const servidor = crearServidor();
  servidor.listen(PUERTO, () => console.log(`[http] escuchando en :${PUERTO} (modo ${MODO})`));

  const apagar = () => {
    console.log('[sala] apagando');
    canales.cerrarTodo();
    servidor.close(() => process.exit(0));
    /* Railway manda SIGTERM y despues mata. Si alguna conexion SSE no
       se suelta, mejor irse solo que quedar colgado hasta el KILL. */
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.on('SIGTERM', apagar);
  process.on('SIGINT', apagar);

  return servidor;
}

/* Solo arranca si se ejecuta como programa. Importado desde un test,
   se queda quieto y no ocupa el puerto. */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  arrancar();
}
