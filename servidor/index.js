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
     /panel                   el panel del dueño
     /chat                    el Chat Global (Kick + Twitch)
     /sala/:slug              la Sala: camara, peli y chat
     /api/chat/*              salud, envio y resuscripcion del chat
     /api/estado              como esta el servidor
     /api/hora                la hora del servidor, para sincronizar
     /api/videos              el catalogo (lo escribe herramientas/subir.py)
     /api/sala/:slug/*        reloj, chat del espectador y salir
     /api/panel/*             lo que solo mira y toca el dueño

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
import * as chat from './chat.js';
import * as cifrado from './cifrado.js';
import * as espectadores from './espectadores.js';
import * as kick from './kick.js';
import * as metricas from './metricas.js';
import * as reloj from './reloj.js';
import * as sesion from './sesion.js';
import * as twitch from './twitch.js';
import * as videos from './videos.js';
import * as vinculos from './vinculos.js';
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

/**
 * El cuerpo crudo de un pedido, EN BYTES. Crudo importa: el webhook lo
 * firma.
 *
 * Se acumulan Buffers y se concatenan al final. Ir sumando `d += c`
 * decodifica cada trozo por separado, y el corte entre dos paquetes
 * TCP cae donde quiere: si parte un caracter UTF-8 al medio (cualquier
 * emoji o acento), los bytes partidos se convierten en U+FFFD y el
 * cuerpo reconstruido deja de ser el que Kick firmo. La verificacion
 * da 401, Kick reintenta, y el mensaje llega tarde o no llega. Pasaba
 * solo con mensajes con emoji y solo a veces: el peor tipo de bug.
 *
 * El tope tambien cuenta bytes y no unidades UTF-16, que es lo que de
 * verdad ocupa el pedido.
 */
class CuerpoDemasiadoGrande extends Error {
  constructor(tope) {
    super(`el cuerpo pasa los ${tope} bytes`);
    this.name = 'CuerpoDemasiadoGrande';
  }
}

function leerCuerpo(req, tope = 1_000_000) {
  return new Promise((ok, mal) => {
    const partes = [];
    let total = 0;
    req.on('data', c => {
      total += c.length;
      if (total > tope) {
        /* ACA NO SE DESTRUYE EL SOCKET. Destruirlo antes de contestar
           dejaba el 500 escribiendose sobre un socket muerto: un stack
           trace por pedido en los logs y un ECONNRESET del lado del
           cliente. Y /kick/webhook no pide autenticacion, asi que
           cualquiera podia ensuciar los logs de Railway a voluntad.
           Se deja de acumular, se corta la lectura, y quien atiende el
           error contesta 413 y recien despues cierra. */
        req.pause();
        mal(new CuerpoDemasiadoGrande(tope));
        return;
      }
      partes.push(c);
    });
    req.on('end', () => ok(Buffer.concat(partes)));
    req.on('error', mal);
  });
}

/** El pathname de una URL, sin query. Para loguear sin filtrar nada. */
function soloRuta(u) {
  try { return new URL(u ?? '', 'http://sala.local').pathname; }
  catch { return '(ruta invalida)'; }
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

/* Tope duro del Map. La purga por vencimiento sola no alcanza: como
   corre recien cuando alguien empieza otro login, pegarle mil veces a
   /oauth/twitch/entrar hace crecer el Map sin que nada lo limpie. Mil
   logins a medio empezar es mas de lo que este servicio va a ver
   nunca; pasado eso se sueltan los mas viejos (Map conserva el orden
   de insercion). */
const TOPE_PENDIENTES = 1000;

/* A donde mandar a la persona cuando termina de loguearse. Se acepta
   SOLO una ruta de este mismo sitio: tiene que empezar con una barra
   y no con dos, porque `//otro.com` es una URL absoluta disfrazada y
   convertiria nuestro callback de OAuth en un redirect abierto.
   kick.js tiene la misma guarda para lo suyo; esta es para el destino
   que vuelve del Map de Twitch y para el de Kick al redirigir. */
const destinoSeguro = d =>
  (typeof d === 'string' && /^\/[^/\\]/.test(d) ? d : '');

const pendientesTwitch = new Map();

function nuevoEstadoTwitch(destino = '') {
  const ahora = Date.now();
  for (const [k, v] of pendientesTwitch) if (v.vence < ahora) pendientesTwitch.delete(k);
  while (pendientesTwitch.size >= TOPE_PENDIENTES) {
    pendientesTwitch.delete(pendientesTwitch.keys().next().value);
  }
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
 * El callback de Kick, ya con todo lo que la Fase 0 dejo pendiente:
 * se guarda el vinculo cifrado, se abre la sesion del dueño y se
 * suscriben los eventos de su canal.
 *
 * LOGIN NO ES AUTORIZACION. Entrar con Kick solo prueba quien sos. El
 * dueño es el que ademas tiene el slug de KICK_SLUG: cualquier otra
 * persona puede completar este flujo entero y lo unico que se lleva
 * es una pagina que le dice que no es el dueño. Ningun token de nadie
 * mas se guarda.
 */
async function kickVolver(url, req, res) {
  const error = url.searchParams.get('error');
  if (error) return pagina(res, 'Kick no autorizo', `Kick contesto: ${error}`);

  const code = url.searchParams.get('code') ?? '';
  const estado = url.searchParams.get('state') ?? '';
  if (!code || !estado) return pagina(res, 'Falta algo', 'El callback vino sin code o sin state.');

  let t;
  let yo;
  try {
    t = await kick.canjearCodigo({ code, estado });
    yo = await kick.quienEs(t.accessToken);
  } catch (e) {
    return pagina(res, 'No se pudo completar el login', e.message);
  }

  /*
   * El espectador. Entra para poder escribir en el chat de la Sala con
   * SU cuenta, que es toda la gracia del proyecto.
   *
   * Se le guarda lo minimo: id, nombre y sus tokens cifrados. El
   * refresh hace falta de verdad (el access dura una hora y una peli
   * dura dos y media), y "Salir" lo borra. Sin CLAVE_CIFRADO no se
   * guarda nada: antes que dejar el token de una persona en claro,
   * que no pueda escribir.
   *
   * Y sigue siendo cierto que login no es autorizacion: esto no le da
   * ningun permiso sobre el canal, solo la identifica para que Kick
   * publique su mensaje con su nombre.
   */
  if (t.rol !== 'dueno') {
    try {
      await espectadores.guardar({
        usuarioId: yo.id,
        nombre: yo.nombre,
        accessToken: t.accessToken,
        refreshToken: t.refreshToken,
        venceEn: t.venceEn,
        scopes: t.scopes,
      });
    } catch (e) {
      return pagina(res, 'No se pudo entrar', e.message);
    }

    const cookieEspectador = await sesion.crear({
      tipo: 'espectador',
      usuario: yo.id,
      nombre: yo.nombre,
      slug: yo.slug,
      agente: req.headers['user-agent'] ?? '',
    });

    return redirigir(res, destinoSeguro(t.destino) || '/', {
      'Set-Cookie': sesion.cabeceraCookie('espectador', cookieEspectador),
    });
  }

  if (!SLUG_DUENO) {
    return pagina(res, 'Falta KICK_SLUG',
      'El servidor no sabe cual es el canal del dueño, asi que no puede reconocerte como tal.');
  }
  if (yo.slug.toLowerCase() !== SLUG_DUENO) {
    return pagina(res, `Hola, ${yo.nombre}`,
      `Esta cuenta es del canal ${yo.slug || '(sin canal)'} y el dueño de esta Sala es ` +
      `${SLUG_DUENO}. No se guardo nada.`);
  }

  try {
    await vinculos.guardar('kick', {
      usuarioId: yo.id,
      nombre: yo.nombre,
      login: yo.slug,
      slug: yo.slug,
      accessToken: t.accessToken,
      refreshToken: t.refreshToken,
      venceEn: t.venceEn,
      scopes: t.scopes,
    });
  } catch (e) {
    return pagina(res, 'No se pudo guardar el vinculo', e.message);
  }

  const cookie = await sesion.crear({
    tipo: 'dueno',
    usuario: yo.id,
    nombre: yo.nombre,
    slug: yo.slug,
    agente: req.headers['user-agent'] ?? '',
  });

  /* La suscripcion se intenta ahora pero NO decide el resultado del
     login: si Kick esta caido, la sesion ya vale y el verificador de
     cada cinco minutos la va a crear despues. Fallar aca dejaria al
     dueño sin poder entrar por algo que se arregla solo. */
  chat.verificarKick().catch(e => console.warn('[chat] no se pudo suscribir a Kick:', e.message));

  return redirigir(res, destinoSeguro(t.destino) || '/panel', {
    'Set-Cookie': sesion.cabeceraCookie('dueno', cookie),
  });
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
  /* Se consume primero y se juzga despues: un state vale una sola vez,
     valga o no. Y el vencimiento se comprueba aca, porque la purga del
     Map corre recien cuando alguien empieza OTRO login: sin este
     chequeo, un state sin nadie atras se queda vivo indefinidamente y
     la ventana de 10 minutos no existe. */
  const pendiente = pendientesTwitch.get(estado);
  pendientesTwitch.delete(estado);
  if (!pendiente || pendiente.vence < Date.now()) {
    return pagina(res, 'Ese login ya no vale', 'El state no coincide o se vencio. Proba de nuevo.');
  }

  /* Twitch se VINCULA, no se loguea: la identidad de esta Sala la da
     Kick. Sin sesion de dueño abierta, un token de Twitch de
     cualquiera terminaria guardado como si fuera el del dueño, y el
     servidor mandaria sus mensajes al chat de esa persona. */
  const suyo = await sesion.leer(req, 'dueno');
  if (!suyo) {
    return pagina(res, 'Primero entra con Kick',
      'Vincular Twitch necesita la sesion del dueño: entra con Kick desde /panel y volve a intentarlo.');
  }

  try {
    const t = await twitch.canjearCodigo({ code, redirect: `${baseDe(req)}/oauth/twitch/volver` });
    const yo = await twitch.usuarioActual(t.accessToken);
    await vinculos.guardar('twitch', {
      usuarioId: yo.id,
      nombre: yo.nombre,
      login: yo.login,
      slug: yo.login,
      accessToken: t.accessToken,
      refreshToken: t.refreshToken,
      venceEn: t.venceEn,
      scopes: t.scopes,
    });
    /* Se conecta en segundo plano: el navegador no tiene por que
       esperar a que el WebSocket de Twitch haga su handshake. */
    chat.conectarTwitch().catch(e => console.warn('[chat] no se pudo conectar Twitch:', e.message));
  } catch (e) {
    return pagina(res, 'No se pudo vincular Twitch', e.message);
  }

  return redirigir(res, destinoSeguro(pendiente.destino) || '/panel');
}

/* --------------------------------------------------------- webhook */

/**
 * Un evento de Kick. Cuatro puertas antes de creerle:
 *   1. que la firma RSA de el
 *   2. que sea reciente (una firma valida vale para siempre)
 *   3. que no lo hayamos procesado ya (Kick reintenta)
 *   4. que el JSON parsee
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

  /* La firma sola no alcanza: un webhook capturado y bien firmado se
     puede reenviar cuando quiera, y el anillo de 500 ids solo lo ataja
     hasta que pasen 500 mensajes. La ventana de antiguedad lo cierra.
     Se contesta 200 y no 401 para que Kick deje de reintentarlo: un
     evento viejo no mejora por reintentarse. */
  if (!webhook.esReciente(evento.cuando)) {
    console.warn(`[webhook] ${evento.tipo} descartado por viejo (${evento.cuando})`);
    return texto(res, 200, 'vencido');
  }

  /* Ya visto: se contesta 200 igual. Un 4xx haria que Kick lo siga
     reintentando para siempre, y el problema no es de Kick. */
  if (webhook.yaVisto(evento.id)) return texto(res, 200, 'repetido');

  /* De aca en adelante, TODO camino que no termine procesando el
     evento tiene que desmarcarlo. Si queda marcado sin haberse
     procesado, el reintento de Kick se contesta "repetido" y el
     mensaje se pierde para siempre. */
  let cuerpo;
  try { cuerpo = JSON.parse(crudo); }
  catch {
    webhook.olvidar(evento.id);
    return texto(res, 400, 'json invalido');
  }

  try {
    await procesarEvento(evento, cuerpo);
  } catch (e) {
    webhook.olvidar(evento.id);
    throw e;                       // el 500 lo arma crearServidor
  }
  return texto(res, 200, 'ok');
}

/*
 * Que hacer con un evento de Kick ya verificado.
 *
 * La traduccion al formato unico y el reparto por el bus viven en
 * chat.js: aca solo queda el ruteo y el log. Asi la Sala de la Fase 2
 * puede usar el mismo camino sin copiar nada.
 *
 * OJO EN LA FASE 3: el slug sale de `broadcaster.channel_slug` con el
 * del dueño como respaldo. Esta bien mientras haya un solo canal, pero
 * el dia que haya varios creadores un evento sin channel_slug se
 * difundiria en el canal del DUEÑO, o sea el chat de un creador
 * cayendo en la sala de otro. Cuando entre el segundo creador hay que
 * resolver el slug contra la suscripcion (Kick-Event-Subscription-Id)
 * y descartar lo que no se pueda atribuir, en vez de adivinar.
 */
async function procesarEvento(evento, cuerpo) {
  const r = chat.recibirDeKick(evento, cuerpo);
  const slug = cuerpo?.broadcaster?.channel_slug ?? SLUG_DUENO;
  /* Las metricas cuentan los mensajes de KICK, que son los del chat de
     la Sala. Los de Twitch viajan por el mismo bus pero no entran por
     aca y tampoco llegan a la sala: ver el filtro por red de
     canales.js. */
  if (r.hecho === 'chat') metricas.registrarMensaje(slug);
  console.log(`[webhook] ${evento.tipo} de ${slug}: ${r.hecho}`);
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
  /* `crudo.length` y no `crudo`: un Buffer vacio es truthy. */
  try { cuerpo = crudo.length ? JSON.parse(crudo) : {}; }
  catch { return json(res, 400, { error: 'json invalido' }); }

  const slug = url.searchParams.get('canal') ?? cuerpo?.broadcaster?.channel_slug ?? SLUG_DUENO;

  /* Con `?tipo=` el evento entra por el MISMO camino que uno de verdad:
     se traduce al formato unico y sale como `chat`. Es la unica forma
     de ver la pagina /chat con mensajes andando en una maquina de casa,
     porque los webhooks de Kick no llegan a localhost y firmar uno a
     mano necesitaria la clave privada de Kick.

     Sin `?tipo=` se difunde el cuerpo crudo como evento `prueba`, que es
     lo que hacia la Fase 0 y sirve para probar el cable del bus sin
     hablar del formato de los mensajes. */
  const tipo = url.searchParams.get('tipo');
  if (tipo) {
    const evento = {
      id: `prueba-${nodeCrypto.randomUUID()}`,
      tipo,
      cuando: new Date().toISOString(),
      version: '1',
      suscripcion: 'prueba',
    };
    /* `?canal=` gana sobre lo que diga el payload: el fixture trae el
       slug del dueño escrito adentro y sin esto no habria forma de
       probar otro canal. */
    const conCanal = url.searchParams.get('canal')
      ? { ...cuerpo, broadcaster: { ...(cuerpo?.broadcaster ?? {}), channel_slug: slug } }
      : cuerpo;
    const r = chat.recibirDeKick(evento, conCanal);
    if (r.hecho === 'chat') metricas.registrarMensaje(slug);
    return json(res, 200, { ok: true, canal: slug, tipo, hecho: r.hecho });
  }

  const cuantos = canales.difundir(slug, {
    tipo: 'prueba',
    cuerpo,
    cuando: new Date().toISOString(),
  });
  return json(res, 200, { ok: true, canal: slug, llegoA: cuantos });
}

/* ------------------------------------------------------------- api */

/**
 * El cuerpo de un pedido como JSON. Tope chico a proposito: por aca
 * entran mensajes de chat de 500 caracteres, no archivos.
 */
async function leerJson(req, tope = 64 * 1024) {
  const crudo = await leerCuerpo(req, tope);
  if (!crudo.length) return {};
  return JSON.parse(crudo);          // el que llama atrapa y contesta 400
}

/**
 * Corre `fn` solo si el pedido trae la sesion del dueño.
 *
 * Es la unica puerta del Chat Global. La pagina /chat se sirve a
 * cualquiera (es HTML sin datos), pero todo lo que trae o manda chat
 * de verdad pasa por aca.
 */
async function conDueno(req, res, fn) {
  const suyo = await sesion.leer(req, 'dueno');
  if (!suyo) return json(res, 401, { error: 'no hay sesion de dueño' });
  return fn(suyo);
}

/** Como estan las dos vias del chat. */
async function apiChatSalud(url, req, res) {
  return conDueno(req, res, () => json(res, 200, chat.salud()));
}

/**
 * Manda un mensaje a Kick, a Twitch o a los dos.
 *
 * El resultado viene POR RED y no como un si/no global, porque el
 * caso interesante es el del medio: salio en una y no en la otra. Un
 * "error" pelado ahi haria que el dueño lo escriba de nuevo y quede
 * repetido en la red donde si habia salido.
 */
async function apiChatEnviar(url, req, res) {
  return conDueno(req, res, async () => {
    let pedido;
    try { pedido = await leerJson(req); }
    catch { return json(res, 400, { error: 'json invalido' }); }

    const destino = ['kick', 'twitch', 'ambos'].includes(pedido?.destino) ? pedido.destino : 'kick';
    const r = await chat.enviar({
      texto: pedido?.texto,
      destino,
      respondeA: typeof pedido?.respondeA === 'string' ? pedido.respondeA : undefined,
    });

    if (r.error) return json(res, 400, r);

    const intentos = [r.kick, r.twitch].filter(Boolean);
    const salioAlguno = intentos.some(x => x.ok);
    if (salioAlguno) return json(res, 200, r);

    /* Nadie lo recibio. Si el motivo es que nos estan frenando, el
       codigo tiene que ser 429 para que la pagina sepa esperar en vez
       de reintentar en el acto. */
    if (intentos.some(x => x.estado === 429)) {
      return json(res, 429, {
        ...r,
        error: 'las plataformas estan frenando los envios',
        esperar: 5,
      }, { 'Retry-After': '5' });
    }
    return json(res, 502, { ...r, error: intentos.map(x => x.motivo).join(' · ') || 'no se pudo enviar' });
  });
}

/** Vuelve a crear las suscripciones de Kick, a mano. */
async function apiChatResuscribir(url, req, res) {
  return conDueno(req, res, async () => {
    try { return json(res, 200, await chat.resuscribirKick()); }
    catch (e) { return json(res, 502, { error: e.message }); }
  });
}

/* ------------------------------------------------------ la Sala */

/**
 * La hora del servidor.
 *
 * Es lo que le permite a cada navegador calcular su desfase: pide
 * esto, mide cuanto tardo la ida y vuelta, y se queda con
 * `ahora + rtt/2 - suPropioReloj`. Sin esto, una maquina con el reloj
 * cinco minutos adelantado calcularia la posicion de la peli cinco
 * minutos mas adelante y el player pediria un segmento que todavia no
 * corresponde.
 *
 * No pide sesion ni dice nada de nadie: es un numero.
 */
async function apiHora(url, req, res) {
  return json(res, 200, { ahora: Date.now() });
}

/**
 * Corre `fn(slug)` si el pedido trae la sesion del dueño Y el slug es
 * una sala que existe.
 */
async function conDuenoDeLaSala(url, req, res, p, fn) {
  const suyo = await sesion.leer(req, 'dueno');
  if (!suyo) return json(res, 401, { error: 'no hay sesion de dueño' });
  const slug = String(p.slug ?? '').toLowerCase();
  if (!await canalPermitido(slug)) return json(res, 404, { error: 'esa sala no existe' });
  /* Hoy el unico que pasa el `canalPermitido` con sesion de dueño es
     el dueño mismo. En la Fase 3 hay que comprobar ademas que la sala
     sea SUYA: la sesion dice quien es, no de que canal es dueño. */
  if (SLUG_DUENO && slug !== SLUG_DUENO) {
    return json(res, 403, { error: 'esa sala no es tuya' });
  }
  return fn(slug, suyo);
}

/**
 * Play, pausa, salto y stop. Solo el dueño.
 *
 * La respuesta lleva el reloj nuevo entero, el mismo objeto que salio
 * por el bus: asi el panel no tiene que esperar su propio evento SSE
 * para pintar el estado que acaba de pedir.
 */
async function apiRelojAccion(url, req, res, p) {
  return conDuenoDeLaSala(url, req, res, p, async (slug) => {
    let pedido;
    try { pedido = await leerJson(req); }
    catch { return json(res, 400, { error: 'json invalido' }); }

    const r = await reloj.aplicar(slug, String(pedido?.accion ?? ''), {
      videoId: pedido?.videoId,
      segundos: pedido?.segundos,
      desde: pedido?.desde,
    });
    if (r.error) return json(res, 400, { error: r.error });
    return json(res, 200, { ok: true, reloj: r.reloj });
  });
}

/**
 * Quien esta mirando, desde el navegador de esa persona.
 *
 * Dice SU nombre y nada mas: nunca la lista de quienes estan en la
 * sala. Una pagina publica que enumere a la gente conectada es una
 * lista de asistencia que nadie pidio.
 */
async function apiSalaYo(url, req, res, p) {
  /* Igual que las otras dos de /api/sala/: una sala que no existe se
     contesta 404 y no con un cuerpo util. No filtra nada (la respuesta
     habla del que pregunta, no de la sala), pero eran las dos unicas
     rutas de /api/sala/ que no pasaban por aca, y una excepcion sin
     motivo es una excepcion que alguien copia. */
  if (!await canalPermitido(String(p.slug ?? '').toLowerCase())) {
    return json(res, 404, { error: 'esa sala no existe' });
  }

  const suyo = await sesion.leer(req, 'espectador');
  if (!suyo) return json(res, 200, { entrado: false, nombre: '', puedeEscribir: false });

  const v = await espectadores.leer(suyo.usuario);
  if (!v) {
    /* La sesion sobrevivio al token (se revoco el permiso, o cambio la
       CLAVE_CIFRADO). No sirve para nada: se cierra en vez de dejar a
       la persona con una caja de escribir que va a fallar. */
    await sesion.cerrar(req, 'espectador');
    return json(res, 200, { entrado: false, nombre: '', puedeEscribir: false },
      { 'Set-Cookie': sesion.cabeceraBorrar('espectador') });
  }

  return json(res, 200, {
    entrado: true,
    nombre: suyo.nombre || v.nombre,
    /* Si el permiso que dio no incluye escribir, mejor decirlo ahora
       que despues de que escriba un mensaje largo. */
    puedeEscribir: String(v.scopes ?? '').split(/\s+/).includes('chat:write'),
  });
}

/** Cierra la sesion del espectador y OLVIDA su token. */
async function apiSalaSalir(url, req, res, p) {
  if (!await canalPermitido(String(p.slug ?? '').toLowerCase())) {
    return json(res, 404, { error: 'esa sala no existe' });
  }

  const suyo = await sesion.leer(req, 'espectador');
  if (suyo) {
    await sesion.cerrar(req, 'espectador');
    /* Salir borra el token, no solo la cookie. Un "logout" que deja el
       refresh token del otro lado no es un logout. */
    await espectadores.olvidar(suyo.usuario);
  }
  return json(res, 200, { ok: true }, { 'Set-Cookie': sesion.cabeceraBorrar('espectador') });
}

/**
 * El mensaje de un espectador, que sale en kick.com con SU cuenta.
 *
 * Tres frenos, en este orden y por este motivo:
 *   1. el tope de Kick (500 caracteres / 2048 bytes), antes de gastar
 *      un pedido en algo que va a rebotar;
 *   2. la espera del CANAL, si Kick nos frenó hace poco: el 429 es del
 *      canal, no de la persona, y seguir mandando solo consigue mas;
 *   3. la espera de la persona, uno cada dos segundos.
 */
async function apiSalaChat(url, req, res, p) {
  const slug = String(p.slug ?? '').toLowerCase();
  if (!await canalPermitido(slug)) return json(res, 404, { error: 'esa sala no existe' });

  /* El mismo guard que tiene el reloj en `conDuenoDeLaSala`, y por un
     motivo mas fuerte: mas abajo el mensaje se manda al canal que dice
     `vinculos.identidad('kick')`, que es el del DUEÑO. Sin esto, un
     espectador que escribe en /api/sala/otrocreador/chat le termina
     publicando en el chat de Kick del dueño.
     Hoy no es alcanzable porque `creadores` esta vacia y el unico slug
     que pasa `canalPermitido` es el del dueño. La Fase 3 llena esa
     coleccion, y ese dia esto tiene que ser un vinculo POR SALA, no un
     503. Hasta entonces, la respuesta honesta es que esa sala todavia
     no tiene a donde mandar: es el mismo 503 de mas abajo, detectado
     antes de gastar un pedido. */
  if (SLUG_DUENO && slug !== SLUG_DUENO) {
    return json(res, 503, { error: 'esa sala todavia no puede recibir mensajes' });
  }

  const suyo = await sesion.leer(req, 'espectador');
  if (!suyo) return json(res, 401, { error: 'entra con Kick para poder escribir' });

  let pedido;
  try { pedido = await leerJson(req); }
  catch { return json(res, 400, { error: 'json invalido' }); }

  const cuerpo = String(pedido?.texto ?? '');
  const problema = kick.porQueNoSePuedeMandar(cuerpo);
  if (problema) return json(res, 400, { error: problema });

  const esperaCanal = espectadores.esperaDelCanalQueFalta(slug);
  if (esperaCanal) {
    const segundos = Math.ceil(esperaCanal / 1000);
    return json(res, 429, { error: 'Kick esta frenando los envios del canal', esperar: segundos },
      { 'Retry-After': String(segundos) });
  }

  const falta = espectadores.esperaQueLeFalta(suyo.usuario);
  if (falta) {
    const segundos = Math.ceil(falta / 1000);
    return json(res, 429, { error: 'espera un momento entre mensajes', esperar: segundos },
      { 'Retry-After': String(segundos) });
  }

  /* El mensaje cae en el canal del dueño, no en el de quien escribe.
     `identidad` y no `acceso`: hace falta su numero, no su token. */
  const dueno = await vinculos.identidad('kick');
  if (!dueno?.usuarioId) {
    return json(res, 503, { error: 'el canal todavia no esta vinculado con Kick' });
  }

  const token = await espectadores.acceso(suyo.usuario);
  if (!token) {
    await sesion.cerrar(req, 'espectador');
    return json(res, 401, { error: 'tu permiso con Kick vencio: entra de nuevo' },
      { 'Set-Cookie': sesion.cabeceraBorrar('espectador') });
  }

  /* Se anota ANTES de mandar, y a proposito. Si se anotara despues de
     que salga bien, un error que tarda (un timeout de 30s) dejaria a
     la persona reintentando sin freno mientras tanto. */
  espectadores.anotarEnvio(suyo.usuario);

  try {
    const r = await kick.enviarMensaje(token, dueno.usuarioId, cuerpo);
    metricas.registrarEnvio(slug, { ok: r.enviado });
    if (!r.enviado) return json(res, 502, { error: 'Kick lo recibio pero no lo publico' });
    /* No se difunde nada por el bus: el mensaje vuelve por el webhook
       como cualquier otro. Difundirlo aca lo mostraria dos veces, y
       ademas mentiria (se veria aunque Kick lo hubiera retenido). */
    return json(res, 200, { ok: true });
  } catch (e) {
    const estado = e.status ?? 0;
    metricas.registrarEnvio(slug, { ok: false, estado });

    if (estado === 429) {
      const espera = espectadores.anotar429(slug, e.retryAfter);
      const segundos = Math.ceil(espera / 1000);
      return json(res, 429, { error: 'Kick esta frenando los envios del canal', esperar: segundos },
        { 'Retry-After': String(segundos) });
    }
    if (estado === 401 || estado === 403) {
      await espectadores.olvidar(suyo.usuario);
      await sesion.cerrar(req, 'espectador');
      return json(res, 401, { error: 'Kick rechazo tu permiso: entra de nuevo' },
        { 'Set-Cookie': sesion.cabeceraBorrar('espectador') });
    }
    /* El texto del error de Kick se recorta: se muestra en pantalla y
       no se le confia el largo a la API de nadie. */
    return json(res, 502, { error: String(e.message ?? 'no se pudo enviar').slice(0, 200) });
  }
}

/* ------------------------------------------------------- videos

   Estas dos rutas las llama `herramientas/subir.py` desde una
   terminal, no un navegador: se autentican con la cabecera
   `X-Clave-Subida` y no con una cookie. La clave se genera en /panel y
   se guarda hasheada. */

async function conClaveDeSubida(req, res, fn) {
  const slug = await videos.salaDeLaClave(req.headers['x-clave-subida'] ?? '');
  /* El 401 no dice si la clave no existe o si es de otra sala: quien
     esta probando claves no tiene por que enterarse de cual fallo. */
  if (!slug) return json(res, 401, { error: 'clave de subida invalida' });
  return fn(slug);
}

async function apiVideosGuardar(url, req, res) {
  return conClaveDeSubida(req, res, async (slugAutenticado) => {
    let pedido;
    try { pedido = await leerJson(req); }
    catch { return json(res, 400, { error: 'json invalido' }); }

    const { error, ficha } = videos.revisarFicha(pedido);
    if (error) return json(res, 400, { error });

    /* La clave autoriza UNA sala. Sin esto, la clave del dueño podria
       escribir en el catalogo de cualquier creador de la Fase 3 con
       solo cambiar un campo del JSON. */
    if (ficha.slug !== slugAutenticado) {
      return json(res, 403, { error: 'esa clave no es de esa sala' });
    }

    await videos.guardar(ficha);
    console.log(`[videos] ${ficha.slug}/${ficha.id}: ${ficha.titulo} (${Math.round(ficha.duracion)}s)`);
    return json(res, 200, { ok: true, id: ficha.id, slug: ficha.slug });
  });
}

async function apiVideosBorrar(url, req, res, p) {
  return conClaveDeSubida(req, res, async (slug) => {
    const id = String(p.id ?? '');
    if (!videos.idValido(id)) return json(res, 400, { error: 'id invalido' });

    /* Se para el reloj ANTES de borrar la ficha. Si el canal estaba
       pasando justo este video, dejarlo correr con los segmentos ya
       borrados de R2 deja a la sala cargando para siempre, sin un
       error que diga por que. */
    const detenido = await reloj.detenerSiUsa(slug, id);
    const habia = await videos.borrar(slug, id);

    if (!habia) {
      /* 404 no es un error para el script: significa "el servidor no
         lo tenia" y sigue con lo suyo. */
      return json(res, 404, { error: 'ese video no estaba en el catalogo', relojDetenido: detenido });
    }
    console.log(`[videos] borrado ${slug}/${id}${detenido ? ' (se detuvo el reloj)' : ''}`);
    return json(res, 200, { ok: true, relojDetenido: detenido });
  });
}

/** El catalogo, para el panel. Con cookie de dueño, no con la clave. */
async function apiVideosListar(url, req, res) {
  return conDueno(req, res, async () => json(res, 200, { videos: await videos.listar(SLUG_DUENO) }));
}

/* -------------------------------------------------------- panel */

/**
 * Todo lo que muestra /panel, en un solo pedido.
 *
 * Se junta aca y no se reparte en cinco endpoints porque el panel lo
 * refresca cada pocos segundos mientras el dueño mira: cinco pedidos
 * en vez de uno es cinco veces el ruido en los logs de Railway por
 * exactamente la misma pantalla.
 */
async function apiPanel(url, req, res) {
  return conDueno(req, res, async () => {
    const slug = SLUG_DUENO;
    return json(res, 200, {
      slug,
      modo: MODO,
      hora: Date.now(),
      salud: chat.salud(),
      reloj: slug ? await reloj.actual(slug) : null,
      videos: slug ? await videos.listar(slug) : [],
      conectados: canales.conectados(slug),
      metricas: metricas.resumen(slug),
      claveSubida: slug ? await videos.estadoClave(slug) : { hay: false, creada: 0 },
      almacen: almacen.dondeGuarda(),
      /* La URL que hay que pegar a mano en el portal de Kick. Se
         muestra porque olvidarla es la falla mas cara del proyecto: se
         crean las suscripciones sin error y no llega ni un webhook. */
      urlWebhook: `${baseDe(req)}/kick/webhook`,
    });
  });
}

/**
 * Genera la clave de subida. La devuelve UNA sola vez: lo que queda
 * guardado es su hash.
 */
async function apiClaveGenerar(url, req, res) {
  return conDueno(req, res, async () => {
    if (!SLUG_DUENO) return json(res, 409, { error: 'falta KICK_SLUG' });
    const clave = await videos.generarClave(SLUG_DUENO);
    console.log('[videos] clave de subida nueva para', SLUG_DUENO);
    return json(res, 200, { clave });
  });
}

async function apiClaveRevocar(url, req, res) {
  return conDueno(req, res, async () => {
    if (!SLUG_DUENO) return json(res, 409, { error: 'falta KICK_SLUG' });
    const habia = await videos.revocarClave(SLUG_DUENO);
    return json(res, 200, { ok: true, habia });
  });
}

/* --------------------------------------------------------- paginas

   /panel y /chat son archivos de paginas/, pero con URL sin .html:
   son direcciones que el dueño escribe a mano y que /chat ademas usa
   como `start_url` de la app instalada. Un redirect a /chat.html
   dejaria la app instalada arrancando en una URL distinta de su
   scope, que es justo lo que rompe la instalacion. */

const servirPagina = archivo => async (url, req, res) => {
  const falso = new URL(`http://sala.local/${archivo}`);
  if (await estatico(falso, req, res)) return;
  return texto(res, 404, 'no existe');
};



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

/**
 * Si este slug puede tener un canal en el bus.
 *
 * Sin esta guarda, `/eventos/lo-que-sea` creaba una entrada en el Map
 * de canales mientras la conexion viviera: cualquiera podia hacer
 * crecer la memoria del servidor pidiendo slugs inventados, y de paso
 * el contador de canales de /api/estado se llenaba de basura. La Fase
 * 0 lo dejo anotado como trabajo de esta fase.
 *
 * Pasan el dueño (KICK_SLUG) y cualquier creador dado de alta. Hoy la
 * coleccion `creadores` esta vacia y el unico que pasa es el dueño;
 * la Fase 3 la llena y esto sigue valiendo sin tocarlo.
 */
async function canalPermitido(slug) {
  const s = String(slug ?? '').toLowerCase();
  if (!s) return false;
  if (SLUG_DUENO && s === SLUG_DUENO) return true;
  try { return Boolean(await almacen.obtener('creadores', s)); }
  catch (e) {
    /* Si el almacen no contesta, no se inventa un permiso. */
    console.warn('[eventos] no se pudo comprobar el creador:', e.name);
    return false;
  }
}

/**
 * SSE. Un HEAD no abre stream: la respuesta no lleva cuerpo, asi que
 * el handler escribiria eventos en el vacio y el pedido no terminaria
 * nunca. Un monitor de uptime que use HEAD (curl -I es lo primero que
 * prueba cualquiera) dejaria un socket colgado y un cliente fantasma
 * contando en el canal. Se contesta con las cabeceras y nada mas.
 */
async function eventos(url, req, res, p) {
  /*
   * LA CARRERA DEL CIERRE, y por que la bandera va ACA arriba.
   *
   * `canales.suscribir` mete la respuesta en la lista de clientes y
   * engancha su propia limpieza en el 'close' del pedido. Pero recien
   * llega ahi despues de los dos `await` de mas abajo. Si el socket
   * muere mientras tanto, el 'close' YA se emitio: el listener que se
   * engancha tarde no dispara nunca, y `res.write()` sobre una
   * respuesta muerta no tira, asi que ni `difundir` ni el ping de 25 s
   * la sacan de la lista. Queda un cliente fantasma para siempre: el
   * contador de espectadores inflado, el pico mentiroso y el canal que
   * no se libera nunca.
   *
   * Hoy los dos `await` cortocircuitan sin tocar disco ni red en el
   * camino normal, asi que la ventana es de cero. Con Mongo del otro
   * lado y slugs de creador (Fase 3) los dos hacen I/O de verdad y la
   * ventana es real.
   *
   * Se anota antes de todo y no se suscribe un pedido que ya murio.
   * Entre el `if` y el `suscribir` no queda un solo `await`, asi que no
   * hay ventana nueva: cualquier cierre posterior lo agarra el listener
   * que engancha `suscribir`.
   */
  let cerrado = false;
  req.on('close', () => { cerrado = true; });

  if (!await canalPermitido(p.slug)) return texto(res, 404, 'ese canal no existe');
  if (req.method === 'HEAD') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
    });
    return res.end();
  }

  /*
   * QUE REDES VE CADA CONEXION. Esta es la decision que la Fase 1 dejo
   * anotada y que la Sala obliga a tomar.
   *
   * Por el bus de un canal viaja tambien el chat de TWITCH del dueño:
   * `chat.js` recuerda las dos redes en el canal de su slug, porque
   * /chat las muestra juntas. Pero `/eventos/:slug` no pide sesion, y
   * desde esta fase lo escucha cualquiera que abra la Sala a ver la
   * peli. Esa gente no tiene nada que ver con la comunidad de Twitch
   * del dueño, ni al reves.
   *
   * Asi que el bus publico manda SOLO Kick, y las dos redes se
   * desbloquean con la sesion del dueño, que es la unica pagina que
   * las necesita. Se filtra en el servidor y no en el navegador
   * porque, filtrando en el navegador, el chat de Twitch igual saldria
   * por el cable hacia trescientas pestañas y un `curl` lo veria
   * entero: la regla solo es verdad donde se decide.
   *
   * Efecto secundario buscado: la Fase 3 hereda la puerta cerrada. El
   * dia que haya varios creadores, "que ve cada conexion" ya es una
   * pregunta que este codigo se hace.
   */
  const esDueno = Boolean(await sesion.leer(req, 'dueno'));

  /* El pedido se murio mientras se resolvia todo lo de arriba: no hay a
     quien suscribir. Ver el comentario del principio. */
  if (cerrado || res.writableEnded) return res;

  canales.suscribir(p.slug, req, res, { redes: esDueno ? null : ['kick'] });

  anotarPresencia(p.slug);
  req.on('close', () => anotarPresencia(p.slug));
  return res;
}

/* Cuanta gente hay mirando, avisado por el mismo bus.
 *
 * Con rebote: cuando arranca la peli entran de a decenas en pocos
 * segundos, y difundir uno por uno seria N eventos a N pestañas. Un
 * solo aviso por segundo dice exactamente lo mismo.
 *
 * El rebote ademas ordena la carrera del cierre: `canales.suscribir`
 * se saca de la lista en su propio 'close' y este no depende de cual
 * de los dos corra primero, porque para cuando el timer dispara la
 * cuenta ya esta bien. */
export const REBOTE_PRESENCIA = 1000;
const presenciaPendiente = new Map();

function anotarPresencia(slug) {
  const s = String(slug ?? '').toLowerCase();
  metricas.verConectados(s, canales.conectados(s));
  if (presenciaPendiente.has(s)) return;
  const t = setTimeout(() => {
    presenciaPendiente.delete(s);
    const cuantos = canales.conectados(s);
    metricas.verConectados(s, cuantos);
    canales.difundir(s, { tipo: 'presencia', conectados: cuantos });
  }, REBOTE_PRESENCIA);
  t.unref?.();
  presenciaPendiente.set(s, t);
}

/**
 * La pagina de la Sala. Se sirve solo para un canal que existe: un
 * `/sala/lo-que-sea` que devolviera la pagina dejaria a alguien
 * mirando una pantalla de carga eterna en vez de un 404.
 */
async function paginaSala(url, req, res, p) {
  /* OJO, TRAMPA DEL ENRUTADOR: `/sala/:slug` tapa TODO lo que cuelgue
     de /sala/, y ahi viven el CSS y el JS de esta misma pagina
     (`paginas/sala/sala.css`). Sin esto, `/sala/sala.css` se
     interpretaria como "la sala del canal sala.css", daria 404, y la
     pagina se veria sin estilos ni script. Un slug no lleva punto, asi
     que lo que no parece slug se deja pasar a los estaticos. */
  if (!videos.slugValido(p.slug)) {
    if (await estatico(url, req, res)) return;
    return texto(res, 404, 'no existe');
  }
  if (!await canalPermitido(p.slug)) return texto(res, 404, 'esa sala no existe');
  return servirPagina('sala.html')(url, req, res, p);
}

const RUTAS = [
  ['GET',    '/api/estado',            apiEstado],
  ['GET',    '/api/hora',              apiHora],
  ['GET',    '/api/chat/salud',        apiChatSalud],
  ['POST',   '/api/chat/enviar',       apiChatEnviar],
  ['POST',   '/api/chat/resuscribir',  apiChatResuscribir],
  ['GET',    '/api/panel',             apiPanel],
  ['POST',   '/api/panel/clave',       apiClaveGenerar],
  ['DELETE', '/api/panel/clave',       apiClaveRevocar],
  ['GET',    '/api/videos',            apiVideosListar],
  ['POST',   '/api/videos',            apiVideosGuardar],
  ['DELETE', '/api/videos/:id',        apiVideosBorrar],
  ['POST',   '/api/sala/:slug/reloj',  apiRelojAccion],
  ['POST',   '/api/sala/:slug/chat',   apiSalaChat],
  ['GET',    '/api/sala/:slug/yo',     apiSalaYo],
  ['POST',   '/api/sala/:slug/salir',  apiSalaSalir],
  ['GET',    '/panel',                 servirPagina('panel.html')],
  ['GET',    '/chat',                  servirPagina('chat.html')],
  ['GET',    '/sala/:slug',            paginaSala],
  ['GET',    '/eventos/:slug',         eventos],
  ['GET',    '/oauth/kick/entrar',     kickEntrar],
  ['GET',    '/oauth/kick/volver',     kickVolver],
  ['GET',    '/oauth/twitch/entrar',   twitchEntrar],
  ['GET',    '/oauth/twitch/volver',   twitchVolver],
  ['POST',   '/kick/webhook',          kickWebhook],
  /* la de prueba solo se registra en local; ver pruebaWebhook */
  ...(ES_LOCAL ? [['POST', '/api/prueba/webhook', pruebaWebhook]] : []),
].map(([metodo, patron, manejador]) => ({ metodo, patron, manejador, ...compilar(patron) }));

export async function manejar(req, res) {
  /* Parsear la URL puede tirar, y tira con cosas que llegan solas:
     `new URL('//', 'http://sala')` es una referencia scheme-relative
     con host vacio y da ERR_INVALID_URL. Sin este try eso salia como
     500 con stack trace, y `//` es de lo primero que prueba cualquier
     bot. Lo honesto es 404, igual que con un %ZZ mas abajo. */
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  } catch {
    return texto(res, 404, 'no existe');
  }
  const ruta = url.pathname;

  /* Se juntan TODAS las que coinciden por camino y recien despues se
     elige por metodo.

     Antes se cortaba en la primera coincidencia de camino y, si el
     metodo no era ese, se contestaba 405. Con una sola ruta por camino
     daba igual; desde que `/api/videos` acepta GET y POST, la version
     vieja contestaba "solo acepta GET" a un POST perfectamente valido
     nada mas que porque el GET estaba escrito mas arriba en la tabla.
     Y el Allow del 405 tiene que listar los metodos de verdad. */
  const coinciden = [];
  for (const r of RUTAS) {
    const m = r.regex.exec(ruta);
    if (m) coinciden.push([r, m]);
  }

  if (coinciden.length) {
    const elegida = coinciden.find(([r]) => r.metodo === req.method)
      /* Un HEAD lo atiende el GET: la respuesta se corta sin cuerpo. */
      ?? (req.method === 'HEAD' ? coinciden.find(([r]) => r.metodo === 'GET') : undefined);

    if (!elegida) {
      /* La ruta existe pero con otro metodo: 405 y no 404. La
         diferencia le ahorra media hora a quien prueba con curl. */
      const permitidos = [...new Set(coinciden.map(([r]) => r.metodo))].join(', ');
      return texto(res, 405, `${ruta} solo acepta ${permitidos}`, { Allow: permitidos });
    }

    const [r, m] = elegida;
    /* decodeURIComponent tira URIError con un %ZZ o un % suelto. Sin
       este try eso sale como 500 con stack trace en los logs; lo
       honesto es 404, que es lo mismo que hace estatico(). */
    const params = {};
    try {
      r.nombres.forEach((n, i) => { params[n] = decodeURIComponent(m[i + 1]); });
    } catch {
      return texto(res, 404, 'no existe');
    }
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
      /* Un cuerpo que se pasa del tope no es un error del servidor: es
         un pedido mal hecho, y contestarlo con 413 cuesta una linea de
         log de nada. Nada de stack: es la unica forma de que un
         endpoint sin autenticar no sea un grifo de basura en los logs.
         Se cierra la conexion despues de escribir la respuesta, no
         antes: el cliente tiene que llegar a leer el 413. */
      if (e instanceof CuerpoDemasiadoGrande) {
        console.warn('[http] cuerpo demasiado grande en', soloRuta(req.url));
        if (!res.headersSent) texto(res, 413, 'cuerpo demasiado grande', { Connection: 'close' });
        else res.end();
        /* Se tira el resto del cuerpo sin acumularlo. Cerrar el socket
           con bytes sin leer manda un RST y el cliente ve ECONNRESET
           en vez del 413, que es justo lo que se venia a arreglar. Si
           el que manda no termina nunca, el timer corta. */
        req.resume();
        const corte = setTimeout(() => req.destroy(), 5_000);
        corte.unref();
        req.on('end', () => clearTimeout(corte));
        req.on('close', () => clearTimeout(corte));
        return;
      }
      /* Solo el pathname, nunca la URL entera: /oauth/kick/volver lleva
         el `code` de OAuth en la query, es de un solo uso, y los logs
         de Railway no se borran. Lo mismo cualquier token que algun dia
         viaje por query. */
      console.error('[http]', req.method, soloRuta(req.url), e);
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

  /* El reloj de la sala vuelve del almacen. Sin esto, un deploy en
     medio de la peli dejaba la sala en "detenido" hasta que el dueño
     volviera a tocar play, y aca deployar en medio del stream es la
     forma normal de trabajar. Como `empezoEn` es una fecha absoluta, la
     posicion despues del reinicio sigue dando lo mismo. */
  if (SLUG_DUENO) {
    try {
      const puesto = await reloj.restaurar(SLUG_DUENO);
      if (puesto) console.log(`[reloj] ${SLUG_DUENO} sigue en ${puesto.videoId} (${Math.round(puesto.posicion)}s, ${puesto.estado})`);
    } catch (e) {
      console.warn('[reloj] no se pudo restaurar:', e.name);
    }
  }

  /* El Chat Global se levanta solo con lo que haya guardado: si el
     dueño ya vinculo Twitch, la conexion EventSub vuelve sin que nadie
     toque nada; si vinculo Kick, se comprueba que la suscripcion siga
     estando. No se espera: un deploy no tiene por que quedarse sin
     atender pedidos mientras Twitch hace su handshake. */
  chat.arrancar({ slug: SLUG_DUENO, base: process.env.URL_BASE ?? '' })
    .catch(e => console.warn('[chat] no se pudo arrancar:', e.message));

  const servidor = crearServidor();
  servidor.listen(PUERTO, () => console.log(`[http] escuchando en :${PUERTO} (modo ${MODO})`));

  const apagar = () => {
    console.log('[sala] apagando');
    chat.parar();
    for (const t of presenciaPendiente.values()) clearTimeout(t);
    presenciaPendiente.clear();
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
