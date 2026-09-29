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
     /cobro/webhook           avisos del proveedor de cobro, firmados
     /crear                   alta de un creador nuevo
     /terminos                el texto que se acepta al crear la sala
     /panel                   el panel del creador (el dueño incluido)
     /admin                   la lista de creadores, solo para el dueño
     /chat                    el Chat Global (Kick + Twitch)
     /chat/:slug              el Chat Global de una sala, abierto a su gente
     /sala/:slug              la Sala: camara, peli y chat
     /api/chat/*              salud, envio y resuscripcion del chat
     /api/chat/:slug/abierto  si el chat de esa sala esta abierto
     /api/chat/:slug/emotes   los emotes que ofrece el selector de la caja
     /api/chat/:slug/yo       que redes conecto quien pregunta
     /api/chat/:slug/actividad canjes, subs y follows: solo el creador y sus mods
     /api/chat/:slug/enviar   el mensaje de un espectador a Kick y/o Twitch
     /api/espectador/salir    borra los tokens de las dos redes
     /api/estado              como esta el servidor
     /api/hora                la hora del servidor, para sincronizar
     /api/videos              el catalogo (lo escribe herramientas/subir.py)
     /api/sala/:slug/*        reloj, chat del espectador y salir
     /api/panel/*             lo que mira y toca cada creador de SU sala
     /api/subida              las URL prefirmadas de R2 (clave o cookie)
     /api/admin/*             lo que solo puede el dueño del servicio

   ---------------------------------------------------------------
   DOS SENTIDOS DE "DUEÑO", Y NO SE MEZCLAN

   Desde la Fase 3 la palabra aparece en dos lugares y significa cosas
   distintas. Vale la pena leer esto una vez:

     dueño de una SALA      cualquier creador, en la suya. Es lo que
                            identifica la cookie `sala_dueno` y lo que
                            comprueba `conDuenoDeLaSala`.
     dueño del SERVICIO     el que tiene el slug de KICK_SLUG. Es el
                            unico que entra a /admin y el unico que
                            puede regalar el plan "amigo". Se pregunta
                            con `creadores.esDueno()`, nunca con un
                            campo de la base.

   La cookie no cambio de nombre a proposito: sigue queriendo decir lo
   mismo que decia, "el dueño de esta sala". Lo que cambio es que ahora
   hay mas de una sala.

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

import * as actividad from './actividad.js';
import * as almacen from './almacen.js';
import * as canales from './canales.js';
import * as chat from './chat.js';
import * as cifrado from './cifrado.js';
import * as cobro from './cobro.js';
import * as colores from './colores.js';
import * as creadores from './creadores.js';
import { numeroDeEntorno } from './entorno.js';
import * as emotes from './emotes.js';
import * as envio from './envio.js';
import * as espectadores from './espectadores.js';
import * as kick from './kick.js';
import * as origenes from './origenes.js';
import * as metricas from './metricas.js';
import * as r2 from './r2.js';
import * as reloj from './reloj.js';
import * as sesion from './sesion.js';
import * as twitch from './twitch.js';
import * as videos from './videos.js';
import * as vinculos from './vinculos.js';
import * as webhook from './webhook.js';

const AQUI    = path.dirname(fileURLToPath(import.meta.url));
const PAGINAS = path.join(AQUI, '..', 'paginas');

/* Un PORT con un typo daba NaN, y `listen(NaN)` no falla: escucha en
   un puerto al azar. El servicio arranca "bien" y no contesta en el
   puerto que espera el proxy. */
const PUERTO = numeroDeEntorno('PORT', 8778, { minimo: 0, maximo: 65535 });

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
 * Primero, el origen POR EL QUE ENTRO ESTE PEDIDO, si es uno de los
 * nuestros (`servidor/origenes.js`). Este sitio se sirve desde dos
 * dominios —Railway y el proxy de Cloudflare Pages— y un login que
 * empieza en uno y termina en el otro deja la cookie en el dominio
 * equivocado: la persona vuelve al link que tenia abierto y no esta
 * conectada. La lista es explicita, asi que un `Host` inventado no
 * puede mandar el redirect a ningun lado.
 *
 * Si el pedido no vino por ninguno de los nuestros, manda URL_BASE. Si
 * tampoco esta, se arma con lo que dice el pedido, que en local es lo
 * correcto. Por eso en produccion URL_BASE no es opcional: sin ella,
 * alguien podria mandar un Host falso y hacer que el link de login
 * apunte a otro lado.
 */
function baseDe(req) {
  const propio = origenes.delPedido(req);
  if (propio) return propio;
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

async function estatico(url, req, res, { cascaras = false } = {}) {
  let partes;
  try {
    partes = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  } catch {
    return false;   // %ZZ y cosas asi: no es una ruta, no es nuestra
  }

  /* La raiz es la pagina de estado, y es una entrada legitima. */
  if (!partes.length) { partes = ['index.html']; cascaras = true; }

  /*
   * LAS CASCARAS NO SE SIRVEN POR SU NOMBRE DE ARCHIVO.
   *
   * Cada pagina tiene su direccion y su guarda: /panel, /crear,
   * /chat/:slug, /sala/:slug, /admin. Pero los archivos viven en
   * paginas/ y esta funcion sirve paginas/, asi que `/sala.html`,
   * `/panel.html` y `/admin.html` contestaban 200 a cualquiera por la
   * puerta de atras, salteando la guarda de su ruta.
   *
   * No dejaba entrar a ningun dato —todas las rutas de datos tienen su
   * propia guarda, y con la Sala apagada `/sala.html?canal=x` es una
   * pantalla que no reproduce nada—, pero se comia dos argumentos
   * escritos en este archivo: que una Sala apagada "no existe para
   * nadie", y que /admin conteste 404 al que no es el dueño para no
   * anunciar que hay un panel de administracion y con que nombre.
   *
   * `cascaras: true` es como entra `servirPagina`, que es justamente
   * quien ya paso por la guarda de la ruta.
   */
  if (!cascaras && partes[partes.length - 1].toLowerCase().endsWith('.html')) return false;

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

function nuevoEstadoTwitch(destino = '', rol = 'creador') {
  const ahora = Date.now();
  for (const [k, v] of pendientesTwitch) if (v.vence < ahora) pendientesTwitch.delete(k);
  while (pendientesTwitch.size >= TOPE_PENDIENTES) {
    pendientesTwitch.delete(pendientesTwitch.keys().next().value);
  }
  const estado = nodeCrypto.randomBytes(16).toString('base64url');
  /* El rol viaja ACA y no en la query del callback, igual que el
     destino: es lo que decide si este token se guarda como el vinculo
     de una sala o como la cuenta de un espectador, y eso no puede
     salir de algo que quien vuelve del login pueda escribir. */
  pendientesTwitch.set(estado, { destino, rol, vence: ahora + VENTANA_LOGIN });
  return estado;
}

/* Los tres roles con los que se puede empezar un login de Kick.
   Cualquier otra cosa cae en 'espectador', que es el que menos puede:
   un rol que llega de la query no puede convertirse en permisos por
   escribirse distinto. */
const ROLES = ['dueno', 'creador', 'espectador'];

async function kickEntrar(url, req, res) {
  if (!kick.hayCredenciales()) {
    return pagina(res, 'Falta configurar Kick',
      'Todavia no estan cargadas KICK_CLIENT_ID y KICK_CLIENT_SECRET en Railway.');
  }
  const pedido = url.searchParams.get('rol') ?? '';
  const rol = ROLES.includes(pedido) ? pedido : 'espectador';
  const { url: destino } = kick.urlLogin({
    redirect: `${baseDe(req)}/oauth/kick/volver`,
    rol,
    destino: url.searchParams.get('destino') ?? '',
    /* Solo el alta acepta terminos. Que un login de espectador pueda
       mandar `terminos=1` no rompe nada (nadie lo lee por ese camino),
       pero pasarlo solo donde se usa deja el rastro mas corto. */
    terminos: rol === 'creador' ? (url.searchParams.get('terminos') ?? '') : '',
  });
  return redirigir(res, destino);
}

/**
 * Conecta una red a la cuenta de espectador de quien pide, y lo manda
 * de vuelta a donde estaba.
 *
 * Lo usan los dos callbacks (Kick y Twitch) porque el trato es el
 * mismo: se le guarda lo minimo (id en esa red, nombre y tokens
 * cifrados) y nada mas. Login no es autorizacion: esto no le da ningun
 * permiso sobre ningun canal, solo lo identifica para que la
 * plataforma publique su mensaje con su nombre.
 *
 * ---------------------------------------------------------------
 * LA RED SE SUMA, NO REEMPLAZA
 *
 * Si ya tenia sesion de espectador, la red nueva se agrega a la cuenta
 * que ya tiene: quien conecto Kick y despues Twitch es UNA persona con
 * dos redes, no dos cuentas. Y la cookie no se toca, asi que conectar
 * la segunda red no lo saca de la primera.
 *
 * Una cookie que nombra a un espectador que ya no esta (se fue, o
 * cambio la CLAVE_CIFRADO y sus tokens no se pueden leer) se trata
 * como si no hubiera: se empieza una cuenta nueva.
 *
 * LA CUENTA ES GLOBAL, no de una sala: la cookie es del dominio, asi
 * que quien conecta Kick en /chat/unosolo ya esta conectado en
 * /chat/otro. Por eso aca no entra ningun slug.
 */
async function conectarRedDelEspectador(req, res, red, datos, destino) {
  const suyo = await sesion.leer(req, 'espectador');
  let id = String(suyo?.usuario ?? '');
  if (id) {
    const v = await espectadores.leer(id);
    if (!v) id = '';
  }
  const esNueva = !id;
  if (esNueva) id = espectadores.nuevoId();

  try {
    await espectadores.conectar(id, red, datos);
  } catch (e) {
    return pagina(res, 'No se pudo entrar', e.message);
  }

  const cabeceras = {};
  if (esNueva) {
    /* Sin `slug`: la cuenta de espectador no es de ninguna sala, y el
       canal de Kick de la persona no lo necesita nadie. */
    cabeceras['Set-Cookie'] = sesion.cabeceraCookie('espectador', await sesion.crear({
      tipo: 'espectador',
      usuario: id,
      nombre: datos.nombre,
      agente: req.headers['user-agent'] ?? '',
    }));
  }

  return redirigir(res, destino || '/', cabeceras);
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
  if (t.rol === 'espectador') {
    return conectarRedDelEspectador(req, res, 'kick', {
      usuarioId: yo.id,
      nombre: yo.nombre,
      login: yo.slug,
      accessToken: t.accessToken,
      refreshToken: t.refreshToken,
      venceEn: t.venceEn,
      scopes: t.scopes,
    }, destinoSeguro(t.destino));
  }

  /*
   * De aca para abajo: el creador. Puede ser el dueño del servicio
   * (su slug es KICK_SLUG) o cualquier streamer de Kick que se este
   * dando de alta; el camino es el mismo y la unica diferencia esta en
   * el plan, que para el dueño no sale de la base.
   */
  const slug = String(yo.slug ?? '').toLowerCase();

  /* Sin canal en Kick no hay sala: la sala ES un canal de Kick. Pasa
     con una cuenta recien hecha, o si el permiso no trajo
     channel:read. */
  if (!slug || !creadores.slugValido(slug)) {
    return pagina(res, `Hola, ${yo.nombre}`,
      'Tu cuenta de Kick no tiene un canal con nombre, y la Sala se arma sobre un canal. ' +
      'Crea tu canal en kick.com y volve a intentarlo.');
  }

  const yaEsta = await creadores.obtener(slug);

  /* El alta de uno nuevo pide dos cosas que el que ya esta no necesita
     volver a pasar: haber aceptado los terminos en ESTE flujo, y que
     haya lugar bajo el tope de canales de la app de Kick. */
  if (!yaEsta && !creadores.esDueno(slug)) {
    if (t.terminos !== creadores.TERMINOS_VERSION) {
      return pagina(res, 'Falta aceptar los terminos',
        'Para crear tu Sala hay que aceptar los terminos primero. Entra por /crear.');
    }
    if (!await creadores.hayLugar()) {
      /* El tope existe porque la app de Kick sin verificar admite 1.000
         canales suscriptos. Pasado eso las suscripciones fallan y el
         chat del que entre queda mudo sin que nada lo explique. */
      console.warn(`[crear] no se creo ${slug}: se llego al tope de ${creadores.TOPE_CANALES} canales`);
      return pagina(res, 'Por ahora no entran mas salas',
        'Se llego al tope de canales que puede atender esta app de Kick. ' +
        'Escribile al dueño para que pida la verificacion de la app.');
    }
  }

  try {
    await creadores.crear({
      slug,
      usuarioId: yo.id,
      nombre: yo.nombre,
      /* La version aceptada viaja SIEMPRE, tambien para el que ya tiene
         fila. `crear` no pisa una version ya anotada —volver a entrar no
         "reacepta" nada—, pero sí anota la primera: una fila puede
         existir sin que nadie haya aceptado nada, porque el interruptor
         de la Sala se la crea al dueño del servicio, y antes de esto
         quedaba sin terminos para siempre. */
      terminos: t.terminos,
    });
  } catch (e) {
    return pagina(res, 'No se pudo crear la sala', e.message);
  }

  try {
    await vinculos.guardar(slug, 'kick', {
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
    slug,
    agente: req.headers['user-agent'] ?? '',
  });

  /* La suscripcion se intenta ahora pero NO decide el resultado del
     login: si Kick esta caido, la sesion ya vale y el verificador de
     cada cinco minutos la va a crear despues. Fallar aca dejaria al
     creador sin poder entrar por algo que se arregla solo. Lo que si
     queda anotado es si salio, para poder decirlo en su panel. */
  chat.verificarKick(slug)
    .then(() => creadores.marcarSuscrito(slug, true))
    .catch(e => {
      console.warn(`[chat] ${slug}: no se pudo suscribir a Kick:`, e.message);
      return creadores.marcarSuscrito(slug, false);
    })
    .catch(() => {});

  return redirigir(res, destinoSeguro(t.destino) || '/panel', {
    'Set-Cookie': sesion.cabeceraCookie('dueno', cookie),
  });
}

async function twitchEntrar(url, req, res) {
  if (!twitch.hayCredenciales()) {
    return pagina(res, 'Falta configurar Twitch',
      'Todavia no estan cargadas TWITCH_CLIENT_ID y TWITCH_CLIENT_SECRET en Railway.');
  }
  /* Dos roles y dos permisos distintos. El del creador sirve para LEER
     su chat (y escribir con su cuenta); el del espectador es para
     escribir y nada mas: leer entra con el token del creador, asi que
     pedirle `user:read:chat` a cada espectador seria pedir un permiso
     que no se usa. Cualquier otra cosa cae en 'creador', que es el
     camino que ademas exige una sesion abierta. */
  const esEspectador = url.searchParams.get('rol') === 'espectador';
  const estado = nuevoEstadoTwitch(url.searchParams.get('destino') ?? '',
    esEspectador ? 'espectador' : 'creador');
  return redirigir(res, twitch.urlLogin({
    redirect: `${baseDe(req)}/oauth/twitch/volver`,
    estado,
    ...(esEspectador ? { scopes: twitch.SCOPES_ESPECTADOR } : {}),
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

  /*
   * El espectador. No hace falta ninguna sesion previa: esto ES su
   * login. Se le guarda su id de Twitch, su nombre y su token, y con
   * eso puede escribir en el chat abierto de cualquier sala que haya
   * compartido Twitch.
   */
  if (pendiente.rol === 'espectador') {
    let t;
    let yo;
    try {
      t = await twitch.canjearCodigo({ code, redirect: `${baseDe(req)}/oauth/twitch/volver` });
      yo = await twitch.usuarioActual(t.accessToken);
    } catch (e) {
      return pagina(res, 'No se pudo conectar Twitch', e.message);
    }
    return conectarRedDelEspectador(req, res, 'twitch', {
      usuarioId: yo.id,
      nombre: yo.nombre,
      login: yo.login,
      accessToken: t.accessToken,
      refreshToken: t.refreshToken,
      venceEn: t.venceEn,
      scopes: t.scopes,
    }, destinoSeguro(pendiente.destino));
  }

  /* Twitch se VINCULA, no se loguea: la identidad de una Sala la da
     Kick. Sin sesion de creador abierta, un token de Twitch de
     cualquiera terminaria guardado como el de alguna sala, y el
     servidor mandaria sus mensajes al chat de esa persona.

     Y el vinculo va a la sala de QUIEN PIDIO, sacada de su cookie:
     nunca de un parametro. Si el slug viniera de la query, cualquiera
     con una sesion podria colgarle su Twitch a la sala de otro. */
  const suyo = await sesion.leer(req, 'dueno');
  if (!suyo) {
    return pagina(res, 'Primero entra con Kick',
      'Vincular Twitch necesita tu sesion: entra con Kick desde /panel y volve a intentarlo.');
  }
  const sala = String(suyo.slug ?? '').toLowerCase();
  if (!await creadores.existe(sala)) {
    return pagina(res, 'Tu sala no existe',
      'La sesion no corresponde a ninguna sala. Entra por /crear.');
  }

  try {
    const t = await twitch.canjearCodigo({ code, redirect: `${baseDe(req)}/oauth/twitch/volver` });
    const yo = await twitch.usuarioActual(t.accessToken);
    await vinculos.guardar(sala, 'twitch', {
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
    chat.conectarTwitch(sala)
      .catch(e => console.warn(`[chat] ${sala}: no se pudo conectar Twitch:`, e.message));
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
 * chat.js; a que SALA corresponde el evento lo resuelve
 * `creadores.salaDelEvento`. Aca solo queda pegar las dos cosas y
 * loguear.
 *
 * Lo que la Fase 2 dejo anotado como el agujero de esta fase: el slug
 * salia del payload con el del dueño como respaldo, asi que un evento
 * sin `channel_slug` se difundia en el canal del DUEÑO. Ahora un
 * evento que no se puede atribuir a una sala que existe se DESCARTA.
 * No se difunde en ningun lado y no crea ningun canal del bus.
 */
async function procesarEvento(evento, cuerpo) {
  const slug = await creadores.salaDelEvento(cuerpo);
  if (!slug) {
    console.warn(`[webhook] ${evento.tipo} descartado: no es de ninguna sala`);
    return;
  }
  const r = chat.recibirDeKick(slug, evento, cuerpo);
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
       probar otro canal.

       Pasa por el MISMO `canalPermitido` que todo lo demas. Es una
       ruta que solo existe con MODO=local, pero una puerta de prueba
       que se saltea la validacion del ruteo real prueba otra cosa que
       la que hay en produccion. */
    if (!await canalPermitido(slug)) {
      return json(res, 404, { error: 'ese canal no existe' });
    }
    const conCanal = url.searchParams.get('canal')
      ? { ...cuerpo, broadcaster: { ...(cuerpo?.broadcaster ?? {}), channel_slug: slug } }
      : cuerpo;
    const r = chat.recibirDeKick(slug, evento, conCanal);
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
 * Corre `fn(slug, plan, sesion)` solo si el pedido trae la sesion de
 * un creador cuya sala existe.
 *
 * Es la puerta de /panel y del Chat Global. Las paginas se sirven a
 * cualquiera (son HTML sin datos), pero todo lo que trae o manda datos
 * de verdad pasa por aca.
 *
 * EL SLUG SALE DE LA COOKIE Y DE NINGUN OTRO LADO. Es la regla de
 * aislamiento entera en una linea: no hay ninguna ruta de /api/panel
 * que acepte un slug por query o por cuerpo, asi que no hay ninguna
 * forma de pedir los datos de otra sala. La fuga de inquilino que la
 * verificacion de la Fase 2 encontro (`videos.listar` volviendose
 * elegible por query) no puede volver por este camino.
 *
 * La sala se comprueba ademas de la sesion: una cookie puede
 * sobrevivir a la sala (el dueño del servicio borro al creador) y
 * seguir dando acceso a un panel de algo que ya no esta.
 */
async function conCreador(req, res, fn) {
  const suyo = await sesion.leer(req, 'dueno');
  if (!suyo) return json(res, 401, { error: 'no hay sesion de creador' });

  const slug = String(suyo.slug ?? '').toLowerCase();
  if (!slug || !await creadores.existe(slug)) {
    return json(res, 403, { error: 'tu sesion no corresponde a ninguna sala' });
  }
  return fn(slug, await creadores.planDe(slug), suyo);
}

/**
 * Corre `fn` solo si el que pide es el dueño del SERVICIO.
 *
 * No mira ningun campo de la base: compara el slug de la sesion contra
 * KICK_SLUG. Login identifica, no autoriza, y quien es el dueño lo
 * decide una variable de entorno que no se puede escribir desde
 * adentro del programa.
 */
async function conDuenoDelServicio(req, res, fn) {
  const suyo = await sesion.leer(req, 'dueno');
  if (!suyo) return json(res, 401, { error: 'no hay sesion de creador' });
  if (!creadores.esDueno(suyo.slug)) return json(res, 403, { error: 'esto es solo del dueño' });
  return fn(suyo);
}

/**
 * Corta un pedido sobre una sala con la pelicula APAGADA. Devuelve si
 * corto, para escribirse `if (await salaCerrada(slug, res)) return;`.
 *
 * Es el mismo interruptor que `salaPermitida`, para el otro grupo de
 * rutas: las que no llevan el slug en la URL porque lo sacan de la
 * cookie de creador o de la clave de subida (la clave, la subida a R2 y
 * el catalogo). Esas ya probaron de quien es la sala, asi que lo unico
 * que falta preguntar es el interruptor.
 *
 * VA DESPUES DE RESOLVER DE QUIEN ES LA SALA Y ANTES DE TODO LO DEMAS.
 * El plan, el tope de GB y las credenciales de R2 son preguntas sobre
 * una funcion que hoy no se ofrece: contestar 402 "tu plan no sube
 * videos" con la Sala apagada manda a alguien a pagar por algo que no
 * le vamos a dar.
 *
 * 404 y no 403, igual que `salaPermitida`. Pero aca SI se dice por que,
 * y no es una incoherencia: quien llega hasta este punto ya demostro
 * que la sala es suya, asi que "existe, pero la pelicula esta apagada"
 * no le cuenta nada que no sepa, y un 404 mudo sobre su propio panel lo
 * mandaria a buscar un bug que no hay.
 */
async function salaCerrada(slug, res) {
  if (await creadores.salaAbierta(slug)) return false;
  json(res, 404, { error: 'la Sala esta cerrada: por ahora este servicio es solo el chat' });
  return true;
}

/** Como estan las dos vias del chat de la sala de quien pregunta. */
async function apiChatSalud(url, req, res) {
  return conCreador(req, res, slug => json(res, 200, chat.salud(slug)));
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
  return conCreador(req, res, async (slug) => {
    let pedido;
    try { pedido = await leerJson(req); }
    catch { return json(res, 400, { error: 'json invalido' }); }

    const destino = ['kick', 'twitch', 'ambos'].includes(pedido?.destino) ? pedido.destino : 'kick';
    const r = await chat.enviar(slug, {
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

/**
 * Los emotes que el selector de la VENTANA DEL CREADOR puede ofrecer:
 * `{ redes, emotes: [{ nombre, url, fuente, marca, redes }] }`.
 *
 * Es la hermana de `/api/chat/:slug/emotes` y no la misma ruta, por
 * dos motivos que no son de estilo:
 *
 *   1. EL SLUG SALE DE LA SESION, como en todas las de `/api/chat/` sin
 *      slug en el camino. La ventana del creador es la suya.
 *   2. NO MIRA EL CHAT ABIERTO. Ese interruptor es "mi comunidad puede
 *      escribir desde mi pagina", y no tiene nada que ver con que el
 *      creador escriba en su propio chat desde su propia ventana: eso
 *      anda con el chat cerrado y tiene que seguir andando. La hermana
 *      publica devuelve `emotes: []` con el chat cerrado justamente
 *      porque de un chat cerrado no se cuenta nada; aca no hay a quien
 *      no contarle.
 *
 * Las DOS redes siempre, sin `?red=`: el creador manda a la que quiera
 * en cualquier momento y la pagina ya filtra por el destino elegido.
 * Un parametro aca no protegeria nada (son sus propios emotes) y
 * costaria un pedido mas cada vez que mueve el selector.
 */
async function apiChatEmotesDelCreador(url, req, res) {
  return conCreador(req, res, (slug) => {
    const redes = [...envio.REDES];
    return json(res, 200, { redes, emotes: emotes.catalogo(slug, redes) });
  });
}

/** Vuelve a crear las suscripciones de Kick de esta sala, a mano. */
async function apiChatResuscribir(url, req, res) {
  return conCreador(req, res, async (slug) => {
    try {
      const r = await chat.resuscribirKick(slug);
      await creadores.marcarSuscrito(slug, true);
      return json(res, 200, r);
    } catch (e) {
      await creadores.marcarSuscrito(slug, false).catch(() => {});
      return json(res, 502, { error: e.message });
    }
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
 * Corre `fn(slug, sesion)` si el slug es una sala que existe Y el
 * pedido trae la sesion de SU dueño.
 *
 * ---------------------------------------------------------------
 * EL ORDEN: PRIMERO LA SALA, DESPUES LA COOKIE
 *
 * La Fase 2 dejo esto anotado como una decision pendiente: el guard
 * del chat contestaba antes de leer la cookie y este despues, asi que
 * dos rutas hermanas contestaban distinto al mismo pedido sin cookie
 * (503 en una, 401 en la otra). Queda al reves de como estaba: la sala
 * primero, en las dos.
 *
 * El argumento es que "¿existe esta sala?" es un hecho sobre la sala y
 * no sobre quien pregunta, y ya se puede averiguar sin ninguna cookie
 * pidiendo `GET /sala/<slug>`, que contesta 404 si no existe. O sea
 * que contestarlo primero no cuenta nada que no se sepa, y evita el
 * caso raro de contestar 401 sobre una sala inexistente, que manda a
 * buscar una cookie para una puerta que no esta.
 *
 * El precio, y queda escrito: un POST sin cookie a una sala que no
 * existe ahora contesta 404 y antes contestaba 401.
 *
 * Desde el 2026-09-22 el guard pregunta `salaPermitida` y no
 * `canalPermitido`: una Sala APAGADA contesta el mismo 404 que una que
 * no existe, y lo contesta en el MISMO lugar, antes de la cookie. Si el
 * interruptor se mirara despues, un pedido sin sesion a una sala con la
 * pelicula apagada daria 401 y uno con la cookie del dueño daria 404,
 * que es contar por la diferencia justo lo que el 404 viene a no
 * contar.
 *
 * ---------------------------------------------------------------
 * "SUYA" SE COMPRUEBA CONTRA LA COOKIE, NO CONTRA KICK_SLUG
 *
 * La version vieja decia `slug !== SLUG_DUENO`, que con un solo
 * creador daba el resultado correcto por casualidad. Lo que hay que
 * comparar es el slug de la sesion contra el de la sala: el dueño del
 * servicio NO es dueño de las salas de los demas, y su cookie no le
 * abre el panel de nadie.
 */
async function conDuenoDeLaSala(url, req, res, p, fn) {
  /* `creadores.normalizar` y no `.toLowerCase()` a secas: es el mismo
     que usa `existe`, que ademas recorta. Sin el, un slug con un
     espacio (`/api/sala/%20istincho/...`) pasa la guarda con una forma
     y sigue viaje con otra. */
  const slug = creadores.normalizar(p.slug);
  if (!await salaPermitida(slug)) return json(res, 404, { error: 'esa sala no existe' });

  const suyo = await sesion.leer(req, 'dueno');
  if (!suyo) return json(res, 401, { error: 'no hay sesion de dueño' });

  if (creadores.normalizar(suyo.slug) !== slug) {
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
    /*
     * EL PLAN SE MIRA ACA, y esto es lo que quiere decir "un creador
     * pendiente no puede reproducir".
     *
     * Se mira en el servidor y no escondiendo botones: la pagina puede
     * mentir, este pedido no. Y se mira sobre TODAS las acciones y no
     * solo sobre "reproducir": si se dejara pausar y saltar, un plan
     * vencido podria seguir manejando una pelicula que ya estaba
     * andando, que es la misma funcion por otro nombre.
     *
     * El chat NO pasa por aca a proposito: es un proxy al chat de Kick
     * del propio creador, no cuesta ancho de banda y el creador lo
     * podria hacer sin nosotros. Lo que se cobra es pasar la pelicula.
     */
    const plan = await creadores.planDe(slug);
    if (!creadores.planActivo(plan)) {
      return json(res, 402, {
        error: plan === 'vencido'
          ? 'tu suscripcion vencio: la sala no puede reproducir hasta que se renueve'
          : 'tu sala todavia no esta habilitada para reproducir',
        plan,
      });
    }

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
  /* Igual que las otras dos de /api/sala/: una sala que no existe —o
     que tiene la pelicula apagada— se contesta 404 y no con un cuerpo
     util. No filtra nada (la respuesta habla del que pregunta, no de la
     sala), pero eran las dos unicas rutas de /api/sala/ que no pasaban
     por aca, y una excepcion sin motivo es una excepcion que alguien
     copia. */
  const slug = creadores.normalizar(p.slug);
  if (!await salaPermitida(slug)) {
    return json(res, 404, { error: 'esa sala no existe' });
  }

  /* `bloqueado` va en TODAS las respuestas, tambien en las de "no hay
     nadie": una clave que aparece solo a veces es la forma de que el dia
     que alguien la lea se rompa justo en el caso que no probo. Mismo
     criterio que `version` y `url` en las insignias. */
  const nadie = { entrado: false, nombre: '', bloqueado: false, puedeEscribir: false };

  const suyo = await sesion.leer(req, 'espectador');
  if (!suyo) return json(res, 200, nadie);

  const v = await espectadores.leer(suyo.usuario);
  if (!v) {
    /* La sesion sobrevivio al token (se revoco el permiso, o cambio la
       CLAVE_CIFRADO). No sirve para nada: se cierra en vez de dejar a
       la persona con una caja de escribir que va a fallar. */
    await sesion.cerrar(req, 'espectador');
    return json(res, 200, nadie, { 'Set-Cookie': sesion.cabeceraBorrar('espectador') });
  }

  /* La Sala es de Kick. Alguien que conecto SOLO Twitch (se puede,
     desde /chat/<slug>) tiene cuenta de espectador y aca no le sirve
     de nada: se le dice que no esta entrado, en vez de mostrarle una
     caja de escribir que no va a andar. Y la sesion NO se cierra: su
     Twitch sigue valiendo en el chat abierto. */
  if (!v.kick) return json(res, 200, nadie);

  /* SE LE DICE QUE ESTA BLOQUEADO, igual que en `/api/chat/:slug/yo`.
     Era la unica diferencia entre las dos hermanas, y no era una
     decision: el corte ya existia en el envio (403 "el creador te
     bloqueó en este chat") y la pantalla no lo sabia, asi que la caja
     quedaba habilitada para escribir contra una pared.

     Sale de `envio.bloqueadasPara`, la MISMA que usa el envio de aca
     abajo: si se calculara distinto, la pantalla diria una cosa y la
     puerta haria otra. Y habla del que pregunta y de nadie mas: nunca
     quien MAS esta bloqueado. */
  const bloqueado = (await envio.bloqueadasPara(slug, v, ['kick'])).length > 0;

  return json(res, 200, {
    entrado: true,
    nombre: suyo.nombre || v.kick.nombre,
    bloqueado,
    /* Si el permiso que dio no incluye escribir, mejor decirlo ahora
       que despues de que escriba un mensaje largo. Un bloqueado
       tampoco puede: la caja se apaga y el motivo se dice. */
    puedeEscribir: espectadores.puedeEscribirEn(v, 'kick') && !bloqueado,
  });
}

/**
 * Cierra la sesion del espectador y OLVIDA su token.
 *
 * Con `origenAjeno` DESPUES del 404 y antes de la cookie, igual que su
 * hermana `/api/espectador/salir`: este POST le borra a alguien los
 * tokens de las dos redes, que es exactamente la clase de cosa que una
 * pagina ajena no puede poder hacer con la cookie de al lado. El
 * argumento entero esta en `servidor/origenes.js`.
 */
async function apiSalaSalir(url, req, res, p) {
  if (!await salaPermitida(creadores.normalizar(p.slug))) {
    return json(res, 404, { error: 'esa sala no existe' });
  }
  if (origenAjeno(req, res)) return;

  const suyo = await sesion.leer(req, 'espectador');
  if (suyo) {
    await sesion.cerrar(req, 'espectador');
    /* Salir borra los tokens de LAS DOS REDES, no solo la cookie. Un
       "logout" que deja el refresh token del otro lado no es un logout.
       Y son las dos aunque la Sala sea de una sola red porque LA
       SESION ES UNA SOLA para todo el dominio: la que se acaba de
       cerrar es la misma que servia en /chat/<slug>, asi que despues de
       esto no queda ninguna sesion apuntando a esos tokens. Es la
       diferencia con un permiso vencido, donde se desconecta solo la
       red que fallo (ver `servidor/envio.js`): aca lo pidio la persona,
       y pidio irse. */
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
 *
 * ---------------------------------------------------------------
 * EL BLOQUEO DEL CREADOR VALE ACA TAMBIEN, EL CHAT CERRADO NO
 *
 * Son dos puertas al MISMO canal de Kick, y hasta el 2026-09-22 solo
 * una miraba la lista de bloqueados: a quien el creador callaba en
 * `/chat/<slug>` le alcanzaba con abrir `/sala/<slug>` para seguir
 * escribiendo con su nombre. El bloqueo es una decision sobre una
 * PERSONA y no sobre una pantalla, asi que lo miran las dos
 * (`envio.bloqueadasPara`, una sola implementacion).
 *
 * `chatAbierto.activo`, en cambio, NO se mira aca, y es a proposito:
 * son dos productos distintos. Ese interruptor decide si se ofrece la
 * pagina publica del Chat Global; la Sala la abre `salaAbierta`, que es
 * lo que ya contesto el 404 de arriba. Atarlos seria ademas un apagon
 * silencioso: el chat abierto NACE CERRADO, asi que el dia que esto
 * saliera, toda Sala prendida se quedaria sin caja de escribir sin que
 * su dueño tocara nada. Lo mismo con `chatAbierto.redes`: que el
 * creador arme su pagina de chat solo con Twitch no quiere decir que
 * cerro el Kick de su Sala.
 */
async function apiSalaChat(url, req, res, p) {
  const slug = creadores.normalizar(p.slug);
  if (!await salaPermitida(slug)) return json(res, 404, { error: 'esa sala no existe' });
  /* Mismo motivo que en /api/chat/:slug/enviar, y en el mismo lugar:
     despues del 404 (que no cuenta si la sala existe) y antes de leer
     la cookie. Este POST hace que alguien escriba con SU nombre en el
     chat de un tercero. */
  if (origenAjeno(req, res)) return;

  const suyo = await sesion.leer(req, 'espectador');
  if (!suyo) return json(res, 401, { error: 'entra con Kick para poder escribir' });

  const v = await espectadores.leer(suyo.usuario);
  if (!v) {
    /* La sesion sobrevivio a los tokens (se revoco el permiso, o cambio
       la CLAVE_CIFRADO): no sirve para nada y se cierra, en vez de
       dejar una caja de escribir que va a fallar siempre. */
    await sesion.cerrar(req, 'espectador');
    return json(res, 401, { error: 'tu sesion ya no vale: entra con Kick de nuevo' },
      { 'Set-Cookie': sesion.cabeceraBorrar('espectador') });
  }
  /* Alguien que conecto SOLO Twitch (se puede, desde /chat/<slug>) no
     tiene con que escribir aca, y su sesion NO se cierra: su Twitch
     sigue valiendo en el chat abierto. Es lo mismo que le contesta
     /api/sala/:slug/yo. */
  if (!v.kick) return json(res, 401, { error: 'entra con Kick para poder escribir' });

  const bloqueadas = await envio.bloqueadasPara(slug, v, ['kick']);
  if (bloqueadas.length) {
    /* Se corta antes de gastar un pedido, y se dice el motivo: un 403
       mudo lo dejaria reintentando. El bloqueo es de ESTA herramienta;
       desde kick.com sigue pudiendo escribir. */
    return json(res, 403, { error: 'el creador te bloqueó en este chat', bloqueado: bloqueadas });
  }

  let pedido;
  try { pedido = await leerJson(req); }
  catch { return json(res, 400, { error: 'json invalido' }); }

  /* El texto que se MIDE es el que va a VIAJAR: `comoViaja` recorta una
     sola vez y `envio` manda exactamente esto. */
  const cuerpo = envio.comoViaja(pedido?.texto);
  const problema = envio.porQueNoSePuedeMandar(cuerpo, ['kick']);
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

  /* Se anota ANTES de mandar, y a proposito. Si se anotara despues de
     que salga bien, un error que tarda (un timeout de 30s) dejaria a
     la persona reintentando sin freno mientras tanto. */
  espectadores.anotarEnvio(suyo.usuario);

  /*
   * EL MENSAJE CAE EN EL CANAL DE ESTA SALA. El slug sale del camino
   * de la URL y ya paso por `canalPermitido`; `envio.js` busca el
   * vinculo de Kick de ESA sala y no del dueño del servicio, que es la
   * mina que la Fase 2 dejo marcada con un cartel de obra.
   *
   * El mismo camino y los mismos frenos que usa /api/chat/:slug/enviar.
   * Lo unico que decide cada ruta es que hacer cuando el permiso ya no
   * sirve: aca ademas se cierra la sesion, si con eso la persona se
   * quedo sin ninguna red.
   */
  const r = await envio.aUnaRed(slug, suyo.usuario, 'kick', cuerpo);

  if (r.ok) {
    /* No se difunde nada por el bus: el mensaje vuelve por el webhook
       como cualquier otro. Difundirlo aca lo mostraria dos veces, y
       ademas mentiria (se veria aunque Kick lo hubiera retenido). */
    return json(res, 200, { ok: true });
  }

  if (r.caduco) {
    /*
     * SE DESCONECTA KICK, NO SE BORRA LA CUENTA.
     *
     * Hasta el 2026-09-22 esto llamaba a `espectadores.olvidar`, que
     * desde la Fase 5.3 borra el documento ENTERO. Pero el espectador
     * es UNO SOLO para todo el dominio: el mismo documento y la misma
     * cookie sirven en /chat/<slug>. O sea que un permiso de Kick
     * vencido mientras alguien miraba una peli le borraba de paso el
     * token de Twitch que estaba usando en la otra pagina.
     *
     * La sesion se cierra solo si no le quedo ninguna red: con Twitch
     * vivo, la sesion sigue identificandola donde todavia le sirve.
     */
    await espectadores.desconectar(suyo.usuario, 'kick');
    const queda = await espectadores.leer(suyo.usuario);
    if (queda) return json(res, 401, { error: r.motivo, reconectar: ['kick'] });

    await sesion.cerrar(req, 'espectador');
    return json(res, 401, { error: r.motivo, reconectar: ['kick'] },
      { 'Set-Cookie': sesion.cabeceraBorrar('espectador') });
  }

  if (r.estado === 429) {
    const segundos = r.esperar ?? Math.ceil(espectadores.ESPERA_429_POR_DEFECTO / 1000);
    return json(res, 429, { error: r.motivo, esperar: segundos },
      { 'Retry-After': String(segundos) });
  }
  /* 403 es "no podes escribir en este canal" (baneado, solo seguidores)
     y no "tu permiso no sirve": se pasa tal cual y no se le toca el
     token a nadie. Ver `envio.js`. */
  if (r.estado === 403) return json(res, 403, { error: r.motivo });
  if (r.estado === 503) return json(res, 503, { error: r.motivo });
  return json(res, 502, { error: r.motivo });
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

/**
 * Corre `fn(slug, plan)` para el dueño de una sala, identificado por
 * la clave de subida O por la cookie de creador.
 *
 * LAS DOS, y no una, porque las dos existen de verdad: el catalogo y
 * las URL de subida los pide `herramientas/subir.py` desde una
 * terminal (donde no hay cookie que mandar ni OAuth que completar sin
 * abrir un navegador) y tambien el panel desde el navegador (donde no
 * hay clave, y meterla en el JavaScript de la pagina seria regalarla).
 *
 * La clave se mira PRIMERO: si viene, es lo que quiso usar quien
 * llama, y caer en la cookie cuando la clave es invalida haria que un
 * script con la clave equivocada "funcione" desde el navegador de al
 * lado, que es la clase de cosa que se descubre tarde.
 */
async function conCreadorOClave(req, res, fn) {
  const presentada = req.headers['x-clave-subida'];
  if (presentada) {
    const slug = await videos.salaDeLaClave(presentada);
    if (!slug) return json(res, 401, { error: 'clave de subida invalida' });
    /* La clave puede sobrevivir a la sala: se comprueba igual que en
       `conCreador`. */
    if (!await creadores.existe(slug)) {
      return json(res, 403, { error: 'esa clave no corresponde a ninguna sala' });
    }
    return fn(slug, await creadores.planDe(slug));
  }
  return conCreador(req, res, fn);
}

async function apiVideosGuardar(url, req, res) {
  return conClaveDeSubida(req, res, async (slugAutenticado) => {
    if (await salaCerrada(slugAutenticado, res)) return;

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
    if (await salaCerrada(slug, res)) return;

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

/**
 * El catalogo de SU sala.
 *
 * Con la cookie del panel o con la clave de subida: `subir.py --listar`
 * quiere saber que hay del lado del servidor y corre en una terminal.
 */
async function apiVideosListar(url, req, res) {
  return conCreadorOClave(req, res, async (slug) => {
    if (await salaCerrada(slug, res)) return;
    return json(res, 200, { videos: await videos.listar(slug) });
  });
}

/* -------------------------------------------------------- panel */

const GIGA = 1024 ** 3;

/**
 * Cuanto ocupa una sala en R2, saliendo a preguntarselo a R2 pero no
 * mas seguido que cada tanto.
 *
 * La cifra que se guarda en `creadores` es una FOTO. La verdad es lo
 * que hay en el bucket, y es la unica que sirve para un tope: los
 * bytes que declara el que sube los elige el que sube.
 *
 * Sin credenciales de R2 devuelve la ultima foto que haya (cero, al
 * principio) y lo dice. Que la subida no ande porque falta una
 * variable es una cosa; que el panel no se pueda abrir es otra.
 */
const REFRESCAR_USO = 5 * 60 * 1000;

async function usoDeLaSala(slug, { forzar = false } = {}) {
  const doc = await creadores.obtener(slug);
  const foto = { bytes: Number(doc?.bytes ?? 0), medido: Number(doc?.bytesAl ?? 0), real: false };
  if (!r2.hayCredenciales()) return foto;
  if (!forzar && foto.medido && Date.now() - foto.medido < REFRESCAR_USO) {
    return { ...foto, real: true };
  }
  try {
    const bytes = await r2.bytesDeLaSala(slug);
    await creadores.anotarUso(slug, bytes);
    return { bytes, medido: Date.now(), real: true };
  } catch (e) {
    console.warn(`[r2] ${slug}: no se pudo medir el uso:`, e.message);
    return foto;
  }
}

/**
 * Todo lo que muestra /panel, en un solo pedido.
 *
 * Se junta aca y no se reparte en cinco endpoints porque el panel lo
 * refresca cada pocos segundos mientras el creador mira: cinco pedidos
 * en vez de uno es cinco veces el ruido en los logs de Railway por
 * exactamente la misma pantalla.
 *
 * Todo lo que sale de aca es de la sala de QUIEN PREGUNTA. No hay
 * ningun parametro que elija de que sala hablar.
 */
async function apiPanel(url, req, res) {
  return conCreador(req, res, async (slug, plan) => {
    const uso = await usoDeLaSala(slug);
    const tope = creadores.topeGb(plan);
    return json(res, 200, {
      slug,
      plan,
      /* El panel es de solo lectura cuando el plan no deja reproducir.
         Va como un booleano ya resuelto y no como "calcula vos con el
         plan": la pagina no tiene por que conocer la tabla de planes,
         y si la conociera habria dos copias de la regla. */
      soloLectura: !creadores.planActivo(plan),
      esDueno: creadores.esDueno(slug),
      modo: MODO,
      hora: Date.now(),
      salud: chat.salud(slug),
      reloj: await reloj.actual(slug),
      videos: await videos.listar(slug),
      conectados: canales.conectados(slug),
      metricas: metricas.resumen(slug),
      claveSubida: await videos.estadoClave(slug),
      /* El chat abierto de la Fase 5.1. El link NO viaja: lo arma la
         pagina con el origen desde el que la estan mirando, que detras
         de un proxy no es el de Railway. */
      chatAbierto: { ...(await creadores.chatAbierto(slug)) },
      /* El interruptor de la Sala (2026-09-22). El panel lo necesita
         para no mostrar los controles de una pelicula que el servidor
         va a contestar 404: esconder botones no es la puerta —la
         puerta esta en `salaPermitida` y en `salaCerrada`— pero un
         boton que no hace nada sin decir por que es peor que no
         tenerlo. Todo lo demas de este pedido se sigue mandando igual:
         son los datos de SU sala, y el creador los tiene que poder ver
         aunque la pelicula este apagada. */
      salaAbierta: await creadores.salaAbierta(slug),
      almacen: almacen.dondeGuarda(),
      uso: {
        bytes: uso.bytes,
        gb: Math.round((uso.bytes / GIGA) * 100) / 100,
        topeGb: Number.isFinite(tope) ? tope : null,
        medido: uso.medido,
        /* Si es false, el numero es la ultima foto y no lo que hay en
           R2 ahora. La pantalla lo dice en vez de mostrar un numero
           que parece de ahora. */
        real: uso.real,
      },
      cobro: {
        proveedor: cobro.proveedor(),
        listo: cobro.listo(),
        falta: cobro.listo() ? '' : cobro.porQueNoEstaListo(),
        ...cobro.precio(),
      },
      subida: { lista: r2.hayCredenciales(), falta: r2.porQueNoHay() },
      /* La URL que hay que pegar a mano en el portal de Kick. Se
         muestra porque olvidarla es la falla mas cara del proyecto: se
         crean las suscripciones sin error y no llega ni un webhook.
         Solo la ve el dueño del servicio: es el unico que tiene acceso
         al portal de la app de Kick, y para los demas seria un dato
         inutil que invita a tocar donde no. */
      urlWebhook: creadores.esDueno(slug) ? `${baseDe(req)}/kick/webhook` : '',
    });
  });
}

/**
 * Genera la clave de subida de SU sala. La devuelve UNA sola vez: lo
 * que queda guardado es su hash.
 */
async function apiClaveGenerar(url, req, res) {
  return conCreador(req, res, async (slug) => {
    if (await salaCerrada(slug, res)) return;
    const clave = await videos.generarClave(slug);
    console.log('[videos] clave de subida nueva para', slug);
    return json(res, 200, { clave });
  });
}

async function apiClaveRevocar(url, req, res) {
  return conCreador(req, res, async (slug) => {
    if (await salaCerrada(slug, res)) return;
    const habia = await videos.revocarClave(slug);
    return json(res, 200, { ok: true, habia });
  });
}

/**
 * Prende o apaga SU Sala. `POST { abierta: true|false }`.
 *
 * LA RUTA ES DE CUALQUIER CREADOR CON SESION Y CONTESTA 403 AL QUE NO
 * SEA EL DUEÑO DEL SERVICIO. No es un descuido que no use
 * `conDuenoDelServicio`: esta ruta habla de SU sala (el slug sale de la
 * cookie, como todo /api/panel), y la pregunta "¿ademas sos el dueño
 * del servicio?" es otra cosa. Se contesta aca, con `esDueno`, que
 * compara contra KICK_SLUG y no lee ningun campo de la base: login
 * identifica, no autoriza.
 *
 * Y POR QUE NO PUEDE PRENDERLA CADA CREADOR: la Sala no esta apagada
 * porque a alguien le falte un permiso. Esta apagada porque hoy no se
 * ofrece. Es ademas la unica funcion del servicio que gasta R2 y ancho
 * de banda de verdad, asi que prenderla es una decision de producto y
 * de costo, de a uno. El dueño del servicio lo hace desde /admin
 * (`POST /api/admin/sala`); esta ruta es el atajo para la suya, que es
 * la que va a tocar mas seguido.
 */
async function apiPanelSala(url, req, res) {
  return conCreador(req, res, async (slug) => {
    if (!creadores.esDueno(slug)) {
      return json(res, 403, { error: 'la Sala la prende el dueño del servicio' });
    }

    let pedido;
    try { pedido = await leerJson(req); }
    catch { return json(res, 400, { error: 'json invalido' }); }
    /* Exacto y no "lo que parezca": un `abierta: "false"` que se
       interpretara como true dejaria una Sala abierta creyendo que se
       la cerro, que es el error que no se descubre hasta que alguien
       entra. */
    if (typeof pedido?.abierta !== 'boolean') {
      return json(res, 400, { error: 'abierta tiene que ser true o false' });
    }

    const abierta = await ponerLaSala(slug, pedido.abierta);
    /* `null` es "esa sala no existe" (le borraron la fila entre la
       cookie y esto). Se contesta como su hermana `/api/panel/chat` y
       no con un `ok: true` sobre algo que no se escribio. */
    if (abierta === null) return json(res, 403, { error: 'tu sesion no corresponde a ninguna sala' });
    return json(res, 200, { ok: true, salaAbierta: abierta });
  });
}

/**
 * Prende o apaga la Sala de un creador Y, SI LA APAGA, PARA LA PELICULA.
 * Devuelve como quedo, o `null` si esa sala no existe.
 *
 * APAGAR TIENE QUE APAGAR, y hasta el 2026-09-22 no apagaba. El
 * interruptor escribia el campo y nada mas: la gente que ya estaba
 * mirando tenia el sobre `reloj` completo (titulo, URL de R2 y el
 * instante en que empezo) y la posicion la calcula sola el navegador,
 * asi que seguia viendo la pelicula hasta el final aunque para el
 * servidor esa Sala ya no existiera. Y el dueño se quedaba sin la
 * palanca para cortar: con la Sala cerrada, `POST /api/sala/:slug/reloj`
 * contesta 404 como todo lo demas.
 *
 * Detener difunde `reloj: detenido` por el bus (que sigue abierto,
 * porque es el del chat) y BORRA el reloj guardado, asi que tampoco
 * revive solo el dia que la Sala se vuelva a abrir.
 *
 * Se resuelve aca y no adentro de `creadores.ponerSalaAbierta` a
 * proposito: ese modulo es el indice de quien tiene sala y no sabe —ni
 * tiene por que saber— que existe un reloj. Las dos rutas que mueven el
 * interruptor (el panel del dueño y /admin) pasan por esta funcion.
 */
async function ponerLaSala(slug, abierta) {
  /*
   * SE DETIENE PRIMERO Y SE ESCRIBE DESPUES, y el orden es el unico
   * detalle fino de esta funcion: son dos escrituras sin nada que las
   * haga atomicas, asi que hay que elegir de que lado caer si el
   * proceso se muere en el medio (deployar en medio del stream es la
   * forma normal de trabajar aca). Cortando primero, el crash deja "la
   * peli cortada y la Sala todavia abierta": se ve, se arregla tocando
   * el interruptor de nuevo. Al reves dejaria "Sala cerrada con un
   * reloj guardado", que es exactamente el estado contra el que hubo
   * que agregarle una guarda a `restaurarRelojes`.
   */
  if (!abierta) {
    /* Se pregunta antes de detener: detener difunde, y difundir un
       "detenido" por una Sala donde no habia nada puesto le manda un
       evento de mas a todo el que este leyendo el chat —el bus es el
       mismo— y le pide al almacen un borrado que no borra nada. */
    const puesto = await reloj.leer(slug);
    if (puesto.estado !== 'detenido') {
      await reloj.aplicar(slug, 'detener');
      console.log(`[sala] ${slug}: se corto la pelicula al cerrar la Sala`);
    }
  }

  const quedo = await creadores.ponerSalaAbierta(slug, abierta);
  if (quedo === null) return null;
  console.log(`[sala] ${slug}: la Sala queda ${quedo ? 'abierta' : 'cerrada'}`);
  return quedo;
}

/** Desvincula Twitch de SU sala: cierra la conexion y borra el token. */
async function apiTwitchDesvincular(url, req, res) {
  return conCreador(req, res, async (slug) => {
    await chat.desvincularTwitch(slug);
    return json(res, 200, { ok: true });
  });
}

/**
 * Manda al creador al checkout del proveedor de cobro.
 *
 * Devuelve la URL en vez de redirigir: el boton esta en una pagina que
 * ya esta abierta y que tiene que poder mostrar el error si el cobro
 * no esta configurado, en vez de mandar a la persona a un 500 de un
 * tercero.
 *
 * CON LA SALA CERRADA NO SE COBRA, y esta era la unica ruta del grupo
 * que no lo miraba: salia un pedido de verdad al proveedor de cobro por
 * una suscripcion a lo unico que se cobra —pasar una pelicula— que hoy
 * no se ofrece. Es exactamente lo que dice el comentario de
 * `salaCerrada`: el interruptor va antes que cualquier pregunta sobre
 * el plan, porque contestar por el plan manda a alguien a pagar por
 * algo que no le vamos a dar.
 */
async function apiSuscribirse(url, req, res) {
  return conCreador(req, res, async (slug) => {
    if (await salaCerrada(slug, res)) return;
    if (creadores.esDueno(slug)) {
      return json(res, 400, { error: 'el dueño del servicio no se suscribe a si mismo' });
    }
    if (!cobro.listo()) return json(res, 503, { error: cobro.porQueNoEstaListo() });
    try {
      const doc = await creadores.obtener(slug);
      const r = await cobro.crearCheckout({ slug, nombre: doc?.nombre ?? '' });
      return json(res, 200, { url: r.url });
    } catch (e) {
      console.warn(`[cobro] ${slug}: no se pudo crear el checkout:`, e.message);
      return json(res, 502, { error: 'el proveedor de cobro no contesto' });
    }
  });
}

/* ------------------------------------------------------ subida a R2

   Lo que reemplaza al token de R2 en la PC de cada creador: el
   servidor firma una URL por archivo, valida solo para ese archivo y
   por diez minutos. */

/* Cuantos archivos se firman de una. Una pelicula de dos horas en
   segmentos de 6 segundos son unos 1.200 archivos por calidad, asi que
   el script pide de a tandas. El tope existe para que un solo pedido
   no arme cien mil URLs. */
const TOPE_ARCHIVOS = 500;

async function apiSubidaFirmar(url, req, res) {
  return conCreadorOClave(req, res, async (slug, plan) => {
    if (await salaCerrada(slug, res)) return;
    if (!creadores.planActivo(plan)) {
      return json(res, 402, { error: 'tu sala todavia no puede subir videos', plan });
    }
    if (!r2.hayCredenciales()) return json(res, 503, { error: r2.porQueNoHay() });

    let pedido;
    try { pedido = await leerJson(req); }
    catch { return json(res, 400, { error: 'json invalido' }); }

    const id = String(pedido?.id ?? '');
    if (!videos.idValido(id)) return json(res, 400, { error: 'id invalido' });

    const lista = Array.isArray(pedido?.archivos) ? pedido.archivos : [];
    if (!lista.length) return json(res, 400, { error: 'no hay archivos' });
    if (lista.length > TOPE_ARCHIVOS) {
      return json(res, 400, { error: `no se pueden firmar mas de ${TOPE_ARCHIVOS} archivos por pedido` });
    }

    /* El tope de GB se compara contra lo que hay EN R2, no contra lo
       que dijeron las tandas anteriores. Los bytes declarados en este
       pedido son lo unico que todavia no se puede medir (no estan
       subidos), asi que se suman a lo medido. */
    const tope = creadores.topeGb(plan);
    if (Number.isFinite(tope)) {
      const uso = await usoDeLaSala(slug, { forzar: true });
      const porSubir = lista.reduce((s, a) => s + (Number(a?.bytes) || 0), 0);
      if (uso.bytes + porSubir > tope * GIGA) {
        return json(res, 409, {
          error: `no entra: tu plan tiene ${tope} GB y ya usas ` +
                 `${(uso.bytes / GIGA).toFixed(2)} GB`,
          usadoGb: Math.round((uso.bytes / GIGA) * 100) / 100,
          topeGb: tope,
        });
      }
    }

    const firmadas = [];
    for (const archivo of lista) {
      const ruta = String(archivo?.ruta ?? '');
      /* La clave se arma ACA con el slug de la cookie (o de la clave de
         subida) y el id ya validado. El creador solo elige lo que va
         despues, y eso pasa por `claveValida`, que es la que rechaza
         `..`, la barra inicial y los segmentos vacios: las cuatro
         formas de escaparse del prefijo escribiendo una ruta.

         Aca NO se vuelve a comprobar `esDeLaSala`: armada asi, la clave
         empieza siempre con `${slug}/` y esa comprobacion no podria dar
         false nunca, o sea que seria una guarda que ninguna prueba
         puede alcanzar. La frontera del prefijo la exige `r2.firmar`,
         que la comprueba para TODOS los call sites y tiene su propia
         prueba. */
      const clave = `${slug}/${id}/${ruta}`;
      if (!ruta || !r2.claveValida(clave)) {
        return json(res, 400, { error: `ruta invalida: ${ruta.slice(0, 80)}` });
      }
      firmadas.push({ ruta, url: r2.firmar('PUT', clave, slug) });
    }

    return json(res, 200, {
      slug,
      id,
      /* Lo que el script va a mandar despues en la ficha del video. Se
         arma aca para que no tenga que saber como se forman las URL
         publicas del bucket. */
      urlPublica: `${r2.urlPublicaBase()}/${slug}/${id}/`,
      archivos: firmadas,
      venceEn: Date.now() + r2.VENCE_POR_DEFECTO * 1000,
    });
  });
}

/**
 * Firma los borrados de un video de SU sala.
 *
 * Con la Sala apagada esto tambien da 404, aunque borrar sea "menos"
 * que subir. Dejarlo abierto seria la unica pieza del grupo que sigue
 * en pie, y ademas dejaria borrar a medias: `DELETE /api/videos/:id`,
 * que es el que saca la ficha del catalogo, tambien contesta 404, asi
 * que quien usara esto se llevaria los bytes de R2 y dejaria la ficha
 * apuntando a un video que ya no esta. Al que necesite vaciar su
 * bucket con la Sala apagada se le prende un rato.
 */
async function apiSubidaBorrar(url, req, res) {
  return conCreadorOClave(req, res, async (slug) => {
    if (await salaCerrada(slug, res)) return;
    if (!r2.hayCredenciales()) return json(res, 503, { error: r2.porQueNoHay() });

    let pedido;
    try { pedido = await leerJson(req); }
    catch { return json(res, 400, { error: 'json invalido' }); }

    const id = String(pedido?.id ?? '');
    if (!videos.idValido(id)) return json(res, 400, { error: 'id invalido' });

    let objetos;
    try { objetos = await r2.listarPrefijo(`${slug}/${id}/`); }
    catch (e) { return json(res, 502, { error: `no se pudo listar R2: ${e.message}` }); }

    const firmadas = objetos.objetos
      /* Estas claves NO las armo este servidor: las contesto R2, en un
         XML. Se pidieron bajo el prefijo de esta sala, asi que todas
         tendrian que ser suyas, pero "tendrian que" no alcanza cuando
         lo que se firma es un DELETE: es la operacion mas cara de
         deshacer de todo el servicio.

         Es una guarda que SI se puede alcanzar (basta que R2 conteste
         una clave de mas) y por eso tiene prueba: `multicanal`, "un
         listado de R2 con una clave de otra sala no firma ese
         borrado". Lo que caiga afuera se descarta en silencio: la
         alternativa —fallar el pedido entero— dejaria al creador sin
         poder borrar nada suyo por una clave que no es de el. */
      .filter(o => r2.esDeLaSala(o.clave, slug) && r2.claveValida(o.clave))
      .slice(0, TOPE_ARCHIVOS * 8)
      .map(o => ({ clave: o.clave, url: r2.firmar('DELETE', o.clave, slug) }));

    return json(res, 200, { slug, id, archivos: firmadas });
  });
}

/* --------------------------------------------------------- admin */

/** La lista de creadores, con plan, vencimiento y uso. Solo el dueño. */
async function apiAdminCreadores(url, req, res) {
  return conDuenoDelServicio(req, res, async () => {
    const lista = await creadores.listar();
    return json(res, 200, {
      tope: creadores.TOPE_CANALES,
      cuantos: lista.length,
      cobro: { proveedor: cobro.proveedor(), listo: cobro.listo(), falta: cobro.porQueNoEstaListo() },
      creadores: lista.map(c => ({
        slug: c.slug,
        nombre: c.nombre,
        /* Los dos: el guardado y el que vale hoy. Sin los dos, un
           "pago" con la fecha pasada se veria como "pago" y no habria
           forma de entender por que ese creador no puede reproducir. */
        plan: c.plan,
        planEfectivo: creadores.planDelDoc(c.slug, c),
        vence: c.vence,
        creado: c.creado,
        suscrito: c.suscrito,
        /* El interruptor de la Sala (2026-09-22). Va en la lista
           porque /admin es el unico lugar desde donde se prende la de
           otro creador, y un boton que no dice como esta la cosa
           ahora es un boton que se toca dos veces. */
        salaAbierta: c.salaAbierta,
        terminos: c.terminos,
        conectados: canales.conectados(c.slug),
        gb: Math.round((c.bytes / GIGA) * 100) / 100,
        medido: c.bytesAl,
        cobro: { proveedor: c.cobro.proveedor, suscripcion: c.cobro.suscripcionId },
      })),
    });
  });
}

/**
 * El dueño pone "amigo" o "pendiente" y nada mas.
 *
 * Los otros dos planes los pone el webhook de cobro. La regla la
 * exige `creadores.ponerPlan` con el parametro `quien`, asi que no
 * depende de que esta ruta se acuerde.
 */
async function apiAdminPlan(url, req, res) {
  return conDuenoDelServicio(req, res, async () => {
    let pedido;
    try { pedido = await leerJson(req); }
    catch { return json(res, 400, { error: 'json invalido' }); }

    const slug = String(pedido?.slug ?? '').toLowerCase();
    const plan = String(pedido?.plan ?? '');
    /* El dueño del servicio no se cambia el plan a si mismo: el suyo no
       sale de la base y escribirlo daria la impresion de que si. */
    if (creadores.esDueno(slug)) {
      return json(res, 400, { error: 'el plan del dueño no sale de la base: sale de KICK_SLUG' });
    }
    if (!await creadores.obtener(slug)) return json(res, 404, { error: 'ese creador no existe' });

    try {
      const r = await creadores.ponerPlan(slug, plan, { vence: pedido?.vence, quien: 'dueno' });
      console.log(`[admin] ${slug} pasa a plan ${plan}`);
      return json(res, 200, { ok: true, creador: r });
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  });
}

/**
 * El dueño del servicio prende o apaga la Sala de CUALQUIER creador.
 * `POST { slug, abierta }`.
 *
 * Es la unica forma de habilitarle la Sala a alguien que no sea el
 * dueño: `/api/panel/sala` contesta 403 a los demas, a proposito.
 *
 * A DIFERENCIA DE `/api/admin/plan`, ACA EL DUEÑO SI SE PUEDE TOCAR A
 * SI MISMO. Aquella ruta lo rechaza porque su plan no sale de la base y
 * escribirlo daria la impresion de que si; este interruptor, en cambio,
 * SI sale de la base para todos, y es el mismo campo del mismo
 * documento que toca desde su panel.
 */
async function apiAdminSala(url, req, res) {
  return conDuenoDelServicio(req, res, async () => {
    let pedido;
    try { pedido = await leerJson(req); }
    catch { return json(res, 400, { error: 'json invalido' }); }

    const slug = creadores.normalizar(pedido?.slug);
    if (typeof pedido?.abierta !== 'boolean') {
      return json(res, 400, { error: 'abierta tiene que ser true o false' });
    }
    /* `existe` y no `obtener`: el dueño del servicio puede no tener
       fila todavia y su sala existe igual (KICK_SLUG).
       `ponerSalaAbierta` se la crea. */
    if (!await creadores.existe(slug)) return json(res, 404, { error: 'ese creador no existe' });

    /* Por la misma funcion que el panel: apagar la Sala tambien detiene
       la pelicula que hubiera puesta, venga el interruptor de donde
       venga. */
    const abierta = await ponerLaSala(slug, pedido.abierta);
    if (abierta === null) return json(res, 404, { error: 'ese creador no existe' });
    return json(res, 200, { ok: true, slug, salaAbierta: abierta });
  });
}

/* --------------------------------------------------- webhook de cobro

   El otro webhook del proyecto. Mismo cuidado que el de Kick: cuerpo
   crudo, firma verificada, y 200 a lo que no interesa para que el
   proveedor deje de reintentarlo. */

async function cobroWebhook(url, req, res) {
  const crudo = await leerCuerpo(req);

  let r;
  try {
    r = await cobro.procesarWebhook({ cabeceras: req.headers, crudo });
  } catch (e) {
    console.error('[cobro] el webhook exploto:', e.message);
    return texto(res, 500, 'error');
  }

  if (!r.ok) {
    /* 400 y no 401: el proveedor tiene que ver que algo esta mal de
       este lado (clave sin cargar, evento sin slug) y reintentar. Lo
       que NO se dice es cual de las cosas fallo. */
    console.warn('[cobro] webhook rechazado:', r.motivo);
    return texto(res, 400, 'no se pudo procesar');
  }

  if (r.ignorado || !r.slug) return texto(res, 200, 'ok');

  /* Que el evento venga firmado prueba que lo mando el proveedor, no
     que el slug de adentro sea una sala nuestra. */
  if (!await creadores.obtener(r.slug)) {
    console.warn(`[cobro] ${r.evento}: la sala "${r.slug}" no existe`);
    return texto(res, 200, 'ok');
  }

  try {
    await creadores.ponerPlan(r.slug, r.plan, { vence: r.vence, quien: 'cobro' });
    if (r.clienteId || r.suscripcionId) {
      await creadores.guardarCobro(r.slug, {
        proveedor: cobro.proveedor(),
        clienteId: r.clienteId,
        suscripcionId: r.suscripcionId,
      });
    }
    console.log(`[cobro] ${r.evento}: ${r.slug} pasa a ${r.plan}`);
  } catch (e) {
    console.error(`[cobro] no se pudo aplicar el plan a ${r.slug}:`, e.message);
    return texto(res, 500, 'error');
  }
  return texto(res, 200, 'ok');
}

/* --------------------------------------------------------- paginas

   /panel y /chat son archivos de paginas/, pero con URL sin .html:
   son direcciones que el dueño escribe a mano y que /chat ademas usa
   como `start_url` de la app instalada. Un redirect a /chat.html
   dejaria la app instalada arrancando en una URL distinta de su
   scope, que es justo lo que rompe la instalacion. */

const servirPagina = archivo => async (url, req, res) => {
  const falso = new URL(`http://sala.local/${archivo}`);
  /* `cascaras: true`: el de afuera no puede pedir `/panel.html`, pero
     esto es la ruta /panel, que ya paso por su guarda. */
  if (await estatico(falso, req, res, { cascaras: true })) return;
  return texto(res, 404, 'no existe');
};



async function apiEstado(url, req, res) {
  return json(res, 200, {
    modo: MODO,
    slug: SLUG_DUENO,
    hora: Date.now(),
    almacen: almacen.dondeGuarda(),
    canales: canales.resumen(),
    /* Los dominios desde los que este sitio se sirve, y que por lo
       tanto puede usar como redirect de OAuth. No son secretos: son
       justo las URL que hay que registrar en Kick y en Twitch. Estan
       aca porque cuando el login vuelve al dominio equivocado, lo
       primero que hay que saber es si el servidor aprendio el otro. */
    origenes: origenes.permitidos(),
    /* Que falta para que esto funcione de verdad. Sin este bloque, el
       dia que el login no anda hay que adivinar cual de las siete
       variables es la que falta. No dice NUNCA el valor de ninguna. */
    listo: {
      kick: kick.hayCredenciales(),
      twitch: twitch.hayCredenciales(),
      cifrado: cifrado.hayClave(),
      mongo: almacen.dondeGuarda().modo === 'mongo',
      /* Las dos de la Fase 3. `subida` sin esto se descubre recien
         cuando un creador intenta subir; `cobro`, recien cuando
         intenta pagar. */
      subida: r2.hayCredenciales(),
      cobro: cobro.listo(),
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
 * el contador de canales de /api/estado se llenaba de basura.
 *
 * Pasan el dueño del servicio (KICK_SLUG, sin tocar el almacen) y
 * cualquier creador dado de alta.
 *
 * Corre una vez por pestaña abierta, asi que la lectura pasa por la
 * cache corta de `creadores.js`, que ademas se acuerda de los que NO
 * existen: sin eso, `/eventos/<slug inventado distinto cada vez>`
 * seguiria siendo una consulta a Mongo por pedido, que es exactamente
 * lo que esta guarda vino a cerrar.
 */
const canalPermitido = slug => creadores.existe(slug);

/**
 * Si este slug tiene sala Y esa sala tiene la pelicula PRENDIDA.
 *
 * Es `canalPermitido` mas el interruptor del 2026-09-22
 * (`creadores.salaAbierta`), y se usa exactamente donde empieza el
 * producto "ver una pelicula juntos": la pagina `/sala/:slug` y las
 * cuatro rutas de `/api/sala/:slug/`.
 *
 * NO lo usan `/eventos/:slug`, `/chat/:slug` ni el manifest por sala.
 * Eso es el chat abierto, que es lo unico que se ofrece hoy y que tiene
 * que seguir andando exactamente igual con la Sala apagada.
 *
 * CONTESTA LO MISMO QUE UNA SALA QUE NO EXISTE, y es a proposito: una
 * Sala apagada no es un permiso que a alguien le falte, es una funcion
 * que este servicio no esta ofreciendo. Un 403 —o un 404 con otro
 * texto— anunciaria que ahi hay algo escondido esperando que alguien
 * insista.
 *
 * PERO ES UNA PROPIEDAD DE ESTAS RUTAS Y NO DEL SITIO, y conviene
 * decirlo sin adornos: con la Sala apagada, `/chat/<slug>`,
 * `/api/chat/<slug>/abierto`, `/eventos/<slug>` y el manifest siguen
 * contestando 200 para un slug que existe y 404 para uno inventado. O
 * sea que averiguar si alguien tiene sala en este servicio es tan facil
 * como siempre. Es inevitable: el chat abierto es lo que se ofrece, y
 * esconder su existencia seria no ofrecerlo. Lo que estas rutas cuidan
 * es lo otro: que no se pueda distinguir "esta apagada" de "no existe",
 * que es lo unico que invitaria a insistir.
 *
 * El `canalPermitido` de adelante es defensa en profundidad y hoy no
 * decide nada: para un slug que no existe, `salaAbierta` ya contesta
 * false (no hay documento, no hay campo). Se deja porque la pregunta
 * "¿existe?" y la pregunta "¿esta prendida?" son dos, y el dia que
 * `salaAbierta` cambie de criterio —o que el dueño del servicio entre
 * por algun atajo, como ya entra en `existe`— esto tiene que seguir
 * empezando por la primera.
 */
const salaPermitida = async slug =>
  (await canalPermitido(slug)) && (await creadores.salaAbierta(slug));

/* ------------------------------------------ que redes ve el publico */

const SOLO_KICK = Object.freeze(['kick']);

/**
 * Las redes que recibe una conexion SIN la cookie del dueño de esta
 * sala. Corre en cada evento y por cada conexion, asi que es
 * sincronica: lee lo que `creadores.chatAbierto` ya dejo cargado.
 *
 * Si no se sabe (todavia no se cargo, o el almacen fallo), solo Kick:
 * es lo que el bus publico mando siempre y lo que necesita la Sala.
 * Ante la duda, lo cerrado.
 */
function redesPublicas(slug) {
  const c = creadores.chatAbiertoSabido(slug);
  return c?.activo ? c.redes : SOLO_KICK;
}

/**
 * `?redes=kick` en /eventos: una conexion puede pedir MENOS de lo que
 * le toca, nunca mas. Lo usa la Sala, que muestra el chat de Kick
 * aunque el creador haya abierto su chat con Twitch: la gente que mira
 * la peli escribe a Kick, y un mensaje de Twitch ahi es uno que no
 * puede contestar.
 *
 * Lo que no se entiende se ignora (devuelve null = "no pidio nada en
 * particular"). Ignorar es seguro justamente porque esto solo achica:
 * lo que decide el maximo es `redesPublicas` o la cookie.
 */
function redesPedidas(url) {
  const crudo = url.searchParams.get('redes');
  if (!crudo) return null;
  const pedidas = creadores.REDES_CHAT.filter(r => crudo.split(',').includes(r));
  return pedidas.length ? pedidas : null;
}

/** Lo que le toca, achicado a lo que pidio. */
const recortar = (permitidas, pedidas) =>
  (pedidas ? permitidas.filter(r => pedidas.includes(r)) : permitidas);

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
   *
   * ---------------------------------------------------------------
   * DESDE LA FASE 5.1 HAY TRES CASOS, NO DOS
   *
   *   el dueño de ESTA sala     todas las redes, siempre.
   *   cualquier otro            lo que diga el chat abierto de la sala:
   *                             sus redes si esta abierto, solo Kick si
   *                             no (ver `redesPublicas`).
   *
   * "De ESTA sala" es nuevo y es un arreglo: antes bastaba CUALQUIER
   * cookie de creador para recibir las dos redes de cualquier sala, o
   * sea que Ana, con su sesion, podia leer el Twitch de istincho con un
   * curl. Con un solo creador daba lo mismo; con varios, no.
   *
   * Y la regla de "cualquier otro" no se fija al conectar: se pregunta
   * en cada evento. Si el creador cierra el chat o le saca Twitch con
   * gente mirando, el proximo mensaje de Twitch ya no sale por el cable
   * a esas conexiones, sin esperar a que reconecten.
   */
  const slug = creadores.normalizar(p.slug);
  const suyo = await sesion.leer(req, 'dueno');
  const esSuDueno = Boolean(suyo) && creadores.normalizar(suyo.slug) === slug;

  /*
   * Y EL RELOJ, QUE NO ES UNA RED.
   *
   * Esta ruta es la del chat abierto y sigue siendo publica con la Sala
   * apagada, pero el `estado` inicial lleva SIEMPRE la pelicula que
   * haya puesta en el canal: los eventos sin `red` pasan todos los
   * filtros, por definicion. O sea que un creador que deja una peli
   * puesta y despues apaga su Sala seguiria regalando el titulo y el
   * segundo a cualquier `curl /eventos/<slug>`.
   *
   * Lo ve el dueño de ESTA sala siempre, aunque la tenga apagada. Es lo
   * coherente con `/api/panel`, que le sigue contando su propio reloj:
   * si el panel dijera "reproduciendo" y su propio bus dijera "nada
   * puesto", la contradiccion la tendria que resolver el.
   */
  const veElReloj = esSuDueno || await creadores.salaAbierta(slug);

  /* La politica se carga ANTES de suscribir: `suscribir` manda el
     buffer de los ultimos 200 mensajes en el acto, y lo tiene que
     mandar ya filtrado con la regla de verdad y no con la de "todavia
     no se". */
  if (!esSuDueno) await creadores.chatAbierto(slug);

  /* El pedido se murio mientras se resolvia todo lo de arriba: no hay a
     quien suscribir. Ver el comentario del principio. */
  if (cerrado || res.writableEnded) return res;

  /* `slug` y no `p.slug`, que es lo que llegaba hasta el 2026-09-22.
     `canalPermitido` recorta antes de comparar, asi que
     `/eventos/%20istincho` pasaba la guarda y despues se suscribia a un
     canal llamado " istincho": una entrada nueva en el Map por cada
     conexion, con la presencia contada en una clave que no es la sala,
     y —lo que se ve— un chat mudo para siempre, porque lo que difunde
     el webhook cae en "istincho" y ahi no lo escucha nadie. La misma
     clase de bicho que el 500 de /api/sala/%20ana/chat. */
  const pide = redesPedidas(url);
  canales.suscribir(slug, req, res, {
    redes: esSuDueno ? pide : () => recortar(redesPublicas(slug), pide),
    conReloj: veElReloj,
  });

  anotarPresencia(slug);
  req.on('close', () => anotarPresencia(slug));
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
 *
 * Y desde el 2026-09-22, solo si ademas ese creador tiene la Sala
 * PRENDIDA. Con el interruptor apagado esta direccion contesta el mismo
 * 404 que un slug inventado: es lo que hace que "la Sala esta cerrada"
 * sea verdad para el de afuera y no un cartel que la pagina se cuenta a
 * si misma.
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
  if (!await salaPermitida(p.slug)) return texto(res, 404, 'esa sala no existe');
  return servirPagina('sala.html')(url, req, res, p);
}

/**
 * `/chat/:slug`: el Chat Global de una sala, abierto a su comunidad
 * (Fase 5.1). Es la MISMA pagina que /chat; `chat.js` se da cuenta por
 * el camino de la URL de que esta en modo publico.
 *
 * 404 si la sala no existe, con el mismo criterio que /sala/:slug. Si
 * existe y el creador no abrio el chat, la pagina se sirve igual y
 * muestra "este chat esta cerrado": lo pregunta a
 * `/api/chat/:slug/abierto`, y asi puede pasar de cerrado a abierto (y
 * al reves) sin que nadie recargue. El corte de verdad no es la
 * pantalla: es que el bus no le manda Twitch a nadie (ver `eventos`).
 *
 * ---------------------------------------------------------------
 * POR QUE SE LE TOCA EL HTML
 *
 * `chat.html` pide sus archivos con rutas RELATIVAS (`comun/base.css`,
 * `chat/chat.js`) a proposito: asi `?demo=1` anda abriendo el archivo
 * suelto, con file://, sin servidor. Desde `/chat/istincho` esas mismas
 * rutas apuntan a `/chat/comun/base.css`, que no existe, y la pagina
 * cargaria sin estilos y sin codigo.
 *
 * Asi que se sirve el mismo archivo con dos cambios, y nada mas:
 *   - `<base href="/">`, que hace que las relativas resuelvan desde la
 *     raiz. Es una raiz del sitio y no un host: detras de otro dominio
 *     que reenvie todo (el proxy de Cloudflare Pages) sigue andando.
 *   - sin el manifest de la PWA. El que hay es el de la ventana del
 *     creador (`start_url: /chat`): un espectador que "instalara" este
 *     chat terminaria abriendo el de otra persona. El manifest por sala
 *     es de la Fase 5.4.
 * `/chat` a secas no pasa por aca y se sirve byte por byte como antes.
 */
async function paginaChatAbierto(url, req, res, p) {
  /* La misma trampa que /sala/:slug: `/chat/:slug` tapa todo lo que
     cuelga de /chat/, y ahi viven chat.css, chat.js y demo.js. Un slug
     no lleva punto, asi que lo que no parece slug va a los estaticos. */
  if (!videos.slugValido(p.slug)) {
    if (await estatico(url, req, res)) return;
    return texto(res, 404, 'no existe');
  }
  if (!await canalPermitido(p.slug)) return texto(res, 404, 'esa sala no existe');

  let html;
  try { html = await fsp.readFile(path.join(PAGINAS, 'chat.html'), 'utf8'); }
  catch { return texto(res, 404, 'no existe'); }

  const cuerpo = paraUnaSala(html, creadores.normalizar(p.slug));
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Content-Length': Buffer.byteLength(cuerpo),
  });
  if (req.method === 'HEAD') return res.end();
  return res.end(cuerpo);
}

/** chat.html como lo necesita `/chat/:slug`. Ver `paginaChatAbierto`. */
export function paraUnaSala(html, slug) {
  const conBase = html.replace(/<head>/i, '<head>\n<base href="/">');
  /* Si alguien cambia la cabecera y esto deja de encontrarla, que se
     note en las pruebas y no en una pagina sin estilos en produccion. */
  if (conBase === html) throw new Error('chat.html no tiene <head>');

  /* El manifest que trae el archivo es el de la ventana del creador
     (`start_url: /chat`): quien "instalara" el chat de alguien
     terminaria abriendo el de otra persona. Se cambia por el de ESTA
     sala, asi cada espectador puede instalar el chat de SU streamer
     como app y que abra donde tiene que abrir. */
  const conManifest = conBase.replace(/<link rel="manifest"[^>]*>/i,
    `<link rel="manifest" href="/chat/${slug}/manifest.webmanifest">`);
  if (conManifest === conBase) throw new Error('chat.html no tiene el link del manifest');
  return conManifest;
}

/**
 * El manifest de la PWA de UNA sala: lo que hace que el chat de un
 * streamer se pueda instalar como app en el celular de su gente.
 *
 * `start_url` y `scope` son `/chat/<slug>`, que es toda la diferencia
 * con el de `paginas/manifest.webmanifest` (el de la ventana del
 * creador, que abre en `/chat`). Instalar dos salas distintas deja dos
 * apps distintas, cada una en su chat.
 *
 * Se arma aca y no es un archivo de `paginas/` porque depende del slug.
 * El slug ya paso por `slugValido`, asi que no puede meter nada raro
 * adentro del JSON.
 */
async function manifestDeSala(url, req, res, p) {
  const slug = creadores.normalizar(p.slug);
  if (!videos.slugValido(slug)) return texto(res, 404, 'no existe');
  if (!await canalPermitido(slug)) return texto(res, 404, 'esa sala no existe');

  const cuerpo = JSON.stringify({
    name: `Chat de ${slug}`,
    short_name: slug,
    start_url: `/chat/${slug}`,
    scope: `/chat/${slug}`,
    display: 'standalone',
    background_color: '#0e1013',
    theme_color: '#0e1013',
    lang: 'es',
    dir: 'ltr',
    description: `El chat de Kick y de Twitch de ${slug}, juntos y en vivo.`,
    icons: [
      { src: '/icono-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icono-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
    ],
  }, null, 2);

  res.writeHead(200, {
    'Content-Type': 'application/manifest+json; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Content-Length': Buffer.byteLength(cuerpo),
  });
  if (req.method === 'HEAD') return res.end();
  return res.end(cuerpo);
}

/**
 * Si el chat de esta sala esta abierto y con que redes. Publico: es lo
 * que pregunta `/chat/:slug` para saber que mostrar.
 *
 * Cerrado no dice que redes eligio el creador: de un chat cerrado no
 * se cuenta nada. Y contesta de la misma memoria que usa el filtro del
 * bus, asi que lo que la pagina dice y lo que el cable manda no pueden
 * contradecirse.
 */
async function apiChatAbierto(url, req, res, p) {
  const slug = creadores.normalizar(p.slug);
  if (!await canalPermitido(slug)) return json(res, 404, { error: 'esa sala no existe' });
  const c = await creadores.chatAbierto(slug);
  return json(res, 200, { abierto: c.activo, redes: c.activo ? [...c.redes] : [] });
}

/**
 * Los emotes que el selector de la caja de escribir puede ofrecer en
 * esta sala: `{ abierto, redes, emotes: [{ nombre, url, fuente,
 * marca, redes }] }`.
 *
 * PUBLICA Y SIN SESION, igual que `/abierto`. Leer el chat no pide
 * login y esto es parte de leerlo: son los emotes del canal y los que
 * pasaron por su chat publico, nada de nadie. Escribir sigue pidiendo
 * cuenta, y de eso se encarga `/enviar` como siempre.
 *
 * CERRADA NO CUENTA NADA, mismo criterio que `/abierto` y que `/yo`:
 * de un chat cerrado no se dice ni que redes eligio el creador, asi
 * que menos todavia su set de emotes.
 *
 * `?red=` acota a que red va a ir el mensaje, para no ofrecer un
 * emote que ahi no sirve. Lo que no se entienda se trata como "las
 * que el creador abrio": pide menos, nunca mas.
 */
async function apiChatEmotes(url, req, res, p) {
  const slug = creadores.normalizar(p.slug);
  if (!await canalPermitido(slug)) return json(res, 404, { error: 'esa sala no existe' });

  const c = await creadores.chatAbierto(slug);
  if (!c.activo) return json(res, 200, { abierto: false, redes: [], emotes: [] });

  const abiertas = [...c.redes];
  /* El cruce, y en este orden: lo que se pide se recorta contra lo
     que el creador abrio. Un `?red=twitch` en una sala que solo abrio
     Kick no puede destapar nada. */
  const pedidas = envio.redesDelPedido(url.searchParams.get('red')) ?? abiertas;
  const redes = abiertas.filter(r => pedidas.includes(r));

  return json(res, 200, { abierto: true, redes, emotes: emotes.catalogo(slug, redes) });
}

/* --------------------------------- el espectador del chat abierto

   Las tres rutas de las Fases 5.2 y 5.3. La cuenta del espectador es
   GLOBAL (una sola para todas las salas), asi que solo el envio y el
   "que puedo hacer aca" llevan slug; salir no.

   -----------------------------------------------------------------
   CSRF: COOKIE `SameSite=Lax` **Y** `Origin` NUESTRO

   Los POST de aca son los unicos del proyecto que ademas del Lax
   exigen el Origin, y no es ceremonia: son los que hacen que alguien
   escriba con su nombre en el chat de un tercero. Sin `Origin`, un
   navegador viejo o un cliente cualquiera podria mandar el pedido
   igual. La lista de origenes validos es explicita y tiene DOS
   entradas, porque este sitio se sirve desde dos dominios (Railway y
   el proxy de Cloudflare Pages): `servidor/origenes.js`. */

/** Corta un POST que no venga de una pagina nuestra. Devuelve si corto. */
function origenAjeno(req, res) {
  if (origenes.mismoOrigen(req)) return false;
  json(res, 403, { error: 'este pedido no viene de una pagina de este sitio' });
  return true;
}

const nombresDeRedes = redes => redes.map(r => (r === 'kick' ? 'Kick' : 'Twitch')).join(' ni ');

/**
 * Que redes tiene conectadas esta persona y en cuales puede escribir
 * en ESTA sala.
 *
 * Habla del que pregunta y de nadie mas: nunca quien mas esta mirando
 * ni quien mas escribio. `conectadas` sale de su cookie;
 * `puedeEscribir` es el cruce de lo que tiene con lo que el creador
 * abrio, que es lo que la pagina necesita para armar el selector.
 */
async function apiChatYo(url, req, res, p) {
  const slug = creadores.normalizar(p.slug);
  if (!await canalPermitido(slug)) return json(res, 404, { error: 'esa sala no existe' });

  const c = await creadores.chatAbierto(slug);
  /* De un chat cerrado no se cuenta nada, ni siquiera que redes eligio
     el creador. Mismo criterio que /api/chat/:slug/abierto. */
  const abiertas = c.activo ? [...c.redes] : [];
  /* `color: ''` va tambien en la respuesta de "no entraste", con el
     mismo criterio que `bloqueado` en la hermana de /api/sala: todas
     las respuestas de esta ruta tienen las mismas claves, asi que la
     pagina no tiene que preguntarse si el campo existe. */
  /* Si ve el boton de la actividad. Va en TODAS las respuestas, como
     `bloqueado`: el creador que mira su propio chat sin cuenta de
     espectador tambien lo tiene que ver. Lo decide la misma funcion que
     protege la ruta, asi que el boton y la lista no pueden discrepar. */
  const nadie = {
    entrado: false, abierto: c.activo, redes: abiertas, conectadas: {},
    color: '', bloqueado: [], puedeEscribir: [],
    veActividad: await puedeVerActividad(req, slug),
  };

  const suyo = await sesion.leer(req, 'espectador');
  if (!suyo) return json(res, 200, nadie);

  const v = await espectadores.leer(suyo.usuario);
  if (!v) {
    /* La sesion sobrevivio a los tokens: no sirve para nada y se
       cierra, en vez de dejar botones que van a fallar. */
    await sesion.cerrar(req, 'espectador');
    return json(res, 200, nadie, { 'Set-Cookie': sesion.cabeceraBorrar('espectador') });
  }

  const conectadas = {};
  for (const red of espectadores.redesDe(v)) {
    conectadas[red] = {
      nombre: v[red].nombre || v[red].login || '',
      /* Su propio id en esa red. Lo usa la pagina para repintar sus
         mensajes ya puestos cuando cambia de color, y es el mismo id
         que la plataforma publica en cada mensaje suyo: no se cuenta
         nada nuevo, y nunca el de nadie mas. */
      usuarioId: v[red].usuarioId,
    };
  }

  /* Se le dice que esta bloqueado, y no se le esconde la caja sin
     explicacion: quedarse escribiendo contra una pared que no avisa es
     peor que un "el creador te bloqueo en este chat". Sabe de si mismo
     y de nadie mas: nunca quien MAS esta bloqueado. */
  const bloqueado = abiertas.filter(red => v[red] && creadores.estaBloqueado(c, red, v[red].usuarioId));

  return json(res, 200, {
    entrado: true,
    abierto: c.activo,
    redes: abiertas,
    conectadas,
    /* El color que eligio, para que el selector de la pagina arranque
       en el suyo y no en uno cualquiera. Vacio si no eligio ninguno:
       ahi manda el de cada plataforma. */
    color: v.color ?? '',
    bloqueado,
    puedeEscribir: abiertas.filter(red =>
      v[red] && espectadores.puedeEscribirEn(v, red) && !bloqueado.includes(red)),
    veActividad: nadie.veActividad,
  });
}

/* --------------------------------------------- la actividad del canal

   Canjes, subs y follows de las dos redes, para el creador y sus mods.
   Los canjes y las subs ya salen por el bus para todos (son publicos
   en las dos plataformas); lo que esta ruta agrega es la LISTA, con lo
   que paso antes de abrir el chat, y los follows, que no son publicos.

   Quien es mod no lo dice nadie de aca: lo dice la insignia de
   moderador de Kick o de Twitch, vista por el servidor en los mensajes
   de esa persona (servidor/actividad.js). Se cruza con las cuentas con
   las que entro como espectador. */

/** Si quien pide puede ver la actividad de esta sala. */
async function puedeVerActividad(req, slug) {
  const dueno = await sesion.leer(req, 'dueno');
  if (dueno && String(dueno.slug ?? '').toLowerCase() === slug) return true;

  const suyo = await sesion.leer(req, 'espectador');
  if (!suyo) return false;
  const v = await espectadores.leer(suyo.usuario).catch(() => null);
  if (!v) return false;
  const cuentas = espectadores.redesDe(v).map(red => ({ red, usuarioId: v[red].usuarioId }));
  return actividad.esMod(slug, cuentas);
}

const clasesDelPedido = url => (url.searchParams.get('clase') ?? '')
  .split(',').map(x => x.trim()).filter(Boolean).slice(0, 10);

async function apiChatActividad(url, req, res, p) {
  const slug = creadores.normalizar(p.slug);
  if (!await canalPermitido(slug)) return json(res, 404, { error: 'esa sala no existe' });
  if (!await puedeVerActividad(req, slug)) {
    return json(res, 403, { error: 'la actividad la ven el creador y sus mods' });
  }
  return json(res, 200, {
    items: await actividad.ver(slug, { clases: clasesDelPedido(url), n: url.searchParams.get('n') }),
  });
}

/** La misma lista para la ventana del creador (/chat), con el slug de su sesion. */
async function apiChatActividadDelCreador(url, req, res) {
  return conCreador(req, res, async (slug) => json(res, 200, {
    items: await actividad.ver(slug, { clases: clasesDelPedido(url), n: url.searchParams.get('n') }),
  }));
}

/**
 * El mensaje de un espectador en el chat abierto de una sala:
 * `{ red: "kick" | "twitch" | "ambas", texto }`.
 *
 * Los mismos frenos que /api/sala/:slug/chat, por el mismo camino
 * (`servidor/envio.js`): el tope de cada red antes de gastar un pedido,
 * la espera del canal si Kick nos freno hace poco, y uno cada dos
 * segundos por persona. **"Las dos" cuenta como UNO**: es un mensaje,
 * no dos.
 *
 * El corte de verdad esta aca y no en la pantalla: con el chat cerrado
 * —o con una red que el creador no abrio— esto contesta 403 aunque la
 * caja de escribir siga en la pagina de alguien que la tenia abierta.
 *
 * NO SE DIFUNDE NADA POR EL BUS: el mensaje vuelve por el webhook de
 * Kick y por EventSub de Twitch, como cualquier otro. Mismo criterio
 * que la Sala. Difundirlo aca lo mostraria dos veces y, peor, lo
 * mostraria aunque la plataforma lo hubiera retenido.
 */
async function apiChatEnviarEspectador(url, req, res, p) {
  const slug = creadores.normalizar(p.slug);
  if (!await canalPermitido(slug)) return json(res, 404, { error: 'esa sala no existe' });
  if (origenAjeno(req, res)) return;

  const suyo = await sesion.leer(req, 'espectador');
  if (!suyo) return json(res, 401, { error: 'conecta Kick o Twitch para poder escribir' });

  const c = await creadores.chatAbierto(slug);
  if (!c.activo) return json(res, 403, { error: 'este chat esta cerrado' });

  let pedido;
  try { pedido = await leerJson(req); }
  catch { return json(res, 400, { error: 'json invalido' }); }

  const redes = envio.redesDelPedido(pedido?.red);
  if (!redes) return json(res, 400, { error: 'hay que decir a que red mandarlo: kick, twitch o ambas' });

  /* Con "ambas" y una sola red abierta rebota entero, en vez de mandar
     a media: la pagina no tendria que haber ofrecido "las dos" ahi, y
     mandar a una sola callado seria mentirle a quien eligio las dos. */
  const cerradas = redes.filter(red => !c.redes.includes(red));
  if (cerradas.length) {
    return json(res, 403, { error: `el creador no abrio ${nombresDeRedes(cerradas)} en este chat` });
  }

  const v = await espectadores.leer(suyo.usuario);
  if (!v) {
    await sesion.cerrar(req, 'espectador');
    return json(res, 401, { error: 'tu sesion ya no vale: conecta de nuevo' },
      { 'Set-Cookie': sesion.cabeceraBorrar('espectador') });
  }

  const faltan = redes.filter(red => !v[red]);
  if (faltan.length) return json(res, 403, { error: `todavia no conectaste ${nombresDeRedes(faltan)}` });

  /* El creador lo bloqueo EN ESTA HERRAMIENTA. No es un baneo de la
     plataforma: sigue pudiendo escribir desde kick.com o twitch.tv, y
     ahi manda la moderacion de cada una. Se corta antes de gastar un
     pedido, y se dice cual es el motivo: un 403 mudo lo dejaria
     reintentando. */
  const bloqueadas = await envio.bloqueadasPara(slug, v, redes);
  if (bloqueadas.length) {
    return json(res, 403, {
      error: 'el creador te bloqueó en este chat',
      bloqueado: bloqueadas,
    });
  }
  const sinPermiso = redes.filter(red => !espectadores.puedeEscribirEn(v, red));
  if (sinPermiso.length) {
    return json(res, 403, { error: `el permiso que diste en ${nombresDeRedes(sinPermiso)} no incluye escribir` });
  }

  /* El texto que se MIDE es el que va a VIAJAR, y el mismo en las dos
     redes: `comoViaja` recorta una sola vez. */
  const cuerpo = envio.comoViaja(pedido?.texto);
  const problema = envio.porQueNoSePuedeMandar(cuerpo, redes);
  if (problema) return json(res, 400, { error: problema });

  if (redes.includes('kick')) {
    const esperaCanal = espectadores.esperaDelCanalQueFalta(slug);
    if (esperaCanal) {
      const segundos = Math.ceil(esperaCanal / 1000);
      return json(res, 429, { error: 'Kick esta frenando los envios del canal', esperar: segundos },
        { 'Retry-After': String(segundos) });
    }
  }

  const falta = espectadores.esperaQueLeFalta(suyo.usuario);
  if (falta) {
    const segundos = Math.ceil(falta / 1000);
    return json(res, 429, { error: 'espera un momento entre mensajes', esperar: segundos },
      { 'Retry-After': String(segundos) });
  }

  /* Uno solo, aunque vaya a las dos redes: el freno es por persona. Y
     antes de mandar, para que un error que tarda no la deje
     reintentando sin freno mientras tanto. */
  espectadores.anotarEnvio(suyo.usuario);

  const r = await envio.aVariasRedes(slug, suyo.usuario, redes, cuerpo);

  /* Una red cuyo permiso ya no sirve se desconecta SOLA: la otra no
     tiene la culpa y la sesion sigue en pie. `reconectar` es lo que la
     pagina usa para volver a mostrar el boton de esa red. */
  const reconectar = redes.filter(red => r[red].caduco);
  for (const red of reconectar) await espectadores.desconectar(suyo.usuario, red);

  const salida = { ok: redes.some(red => r[red].ok), reconectar };
  for (const red of redes) salida[red] = { ok: r[red].ok, motivo: r[red].motivo };

  /* Salio en alguna: 200, con el detalle por red. La pagina dice
     exactamente cual fallo y por que. Un "enviado" global acá seria
     mentira, y un error pelado haria que la persona lo escriba de
     nuevo y quede repetido en la red donde si habia salido. */
  if (salida.ok) return json(res, 200, salida);

  if (redes.some(red => r[red].estado === 429)) {
    const segundos = Math.max(...redes.map(red => r[red].esperar ?? 5));
    return json(res, 429, { ...salida, error: 'te estan frenando los envios', esperar: segundos },
      { 'Retry-After': String(segundos) });
  }

  const motivos = redes.map(red => r[red].motivo).filter(Boolean).join(' · ');

  /* No salio por ningun lado Y NINGUNA RED TIENE PERMISO: eso es un
     401, no un 502. La pagina tiene una rama para el 401 ("conectá tu
     cuenta de nuevo") que por este camino no se ejecutaba nunca, y un
     502 le dice a la persona "el servidor esta roto, probá mas tarde"
     cuando lo que hay que hacer es volver a conectar. Con una sola red
     caduca y la otra rota sigue siendo 502: ahi el 401 seria mentira
     sobre la otra mitad, y `reconectar` ya dice cual hay que volver a
     conectar. */
  if (redes.every(red => r[red].caduco)) {
    return json(res, 401, { ...salida, error: motivos || 'tu permiso ya no sirve' });
  }
  /* Y un 403 de la plataforma (baneado, solo seguidores) se pasa como
     403: no es una falla del servidor. */
  if (redes.every(red => r[red].estado === 403)) {
    return json(res, 403, { ...salida, error: motivos || 'no podes escribir en este canal' });
  }
  return json(res, 502, { ...salida, error: motivos || 'no se pudo enviar' });
}

/**
 * Salir. Borra los tokens de LAS DOS REDES y la sesion, no solo la
 * cookie.
 *
 * Sin slug: la cuenta de espectador es del dominio y no de una sala,
 * asi que salir es salir de todas.
 */
/**
 * El color propio de quien mira: `{ color: "#rrggbb" }`, o
 * `{ color: "" }` para sacarselo y volver al de cada plataforma.
 *
 * Sin slug, como salir: el color es de la persona y vale en el chat de
 * cualquier creador. Lo elige una vez.
 *
 * SE VALIDA ACA TAMBIEN, y no solo en la pagina: es una entrada de
 * terceros que termina en un `style` del navegador de todos los que
 * esten mirando. La forma aceptada es `#rrggbb` y nada mas
 * (`colores.limpiar`). Lo que no entra en esa forma se rechaza con un
 * 400 que lo dice, en vez de guardarse "arreglado": nadie eligio
 * `#000000` cuando escribio `rojo`.
 *
 * Lo que NO se decide aca es el contraste. El color se guarda tal cual
 * y cada pagina lo ajusta al tema que tenga puesta la persona que
 * mira, que es la unica que sabe si el fondo es claro u oscuro.
 */
async function apiEspectadorColor(url, req, res) {
  if (origenAjeno(req, res)) return;

  const suyo = await sesion.leer(req, 'espectador');
  if (!suyo) return json(res, 401, { error: 'conecta tu cuenta para elegir un color' });

  let pedido;
  try { pedido = await leerJson(req); }
  catch { return json(res, 400, { error: 'json invalido' }); }

  const elegido = pedido?.color;
  if (!colores.esColorOVacio(elegido)) {
    return json(res, 400, { error: 'el color tiene que ser un #rrggbb (por ejemplo #7a5cff), o "" para sacarlo' });
  }

  const quedo = await espectadores.ponerColor(suyo.usuario, elegido);
  if (quedo === null) {
    /* La sesion sobrevivio a la ficha: no sirve para nada y se cierra,
       igual que en /yo y en enviar. */
    await sesion.cerrar(req, 'espectador');
    return json(res, 401, { error: 'tu sesion ya no vale: conecta de nuevo' },
      { 'Set-Cookie': sesion.cabeceraBorrar('espectador') });
  }

  return json(res, 200, { ok: true, color: quedo });
}

/**
 * El creador le saca el color propio a alguien: `{ red, id }`.
 *
 * Es el boton de al lado del de bloquear, para el que se pasa de vivo
 * con el color. NO es un bloqueo: la persona sigue escribiendo, y
 * puede volver a elegir uno. Si insiste, lo que sigue es bloquearla.
 *
 * VALE EN TODAS LAS SALAS, y eso es la consecuencia directa de que el
 * color sea uno solo por persona: se le borra de su ficha, asi que
 * tambien deja de verse en el chat de otro creador. Esta escrito en el
 * README. El dia que moleste, la salida es una lista por sala en el
 * documento del creador (como `bloqueados`), no partir el color en uno
 * por sala.
 *
 * Cookie de creador, como todo /api/panel: el slug sale de ahi y es
 * solo para el log. No se comprueba que esa persona haya escrito en su
 * chat —el id lo saco de un mensaje que vio— porque no hay forma
 * barata de probarlo y lo unico que se pierde es un color que se puede
 * volver a elegir.
 */
async function apiPanelColor(url, req, res) {
  /* Exige `Origin` nuestro, a diferencia del resto de /api/panel, que
     se apoya solo en la cookie SameSite=Lax. El criterio es el mismo
     que en las rutas del espectador: las que tocan a UN TERCERO llevan
     la segunda traba. Esta le borra un dato a otra persona y en todas
     las salas, no un ajuste de la sala propia. */
  if (origenAjeno(req, res)) return;
  return conCreador(req, res, async (slug) => {
    let pedido;
    try { pedido = await leerJson(req); }
    catch { return json(res, 400, { error: 'json invalido' }); }

    const red = String(pedido?.red ?? '');
    const id = String(pedido?.id ?? '');
    if (!creadores.REDES_CHAT.includes(red) || !/^[0-9a-zA-Z_-]{1,64}$/.test(id)) {
      return json(res, 400, { error: 'hace falta una red (kick o twitch) y un id de esa red' });
    }

    const cuantos = await espectadores.quitarColorDe(red, id);
    console.log(`[colores] ${slug}: reseteo el color de ${red}:${id} (${cuantos})`);
    return json(res, 200, { ok: true, reseteados: cuantos });
  });
}

async function apiEspectadorSalir(url, req, res) {
  if (origenAjeno(req, res)) return;
  const suyo = await sesion.leer(req, 'espectador');
  if (suyo) {
    await sesion.cerrar(req, 'espectador');
    await espectadores.olvidar(suyo.usuario);
  }
  return json(res, 200, { ok: true }, { 'Set-Cookie': sesion.cabeceraBorrar('espectador') });
}

/**
 * Abre o cierra el chat de SU sala, y elige las redes. Cookie de
 * creador.
 *
 * EL SLUG SALE DE LA COOKIE, como en todo /api/panel: si el cuerpo trae
 * un `slug`, no se lee. Un creador no puede abrir ni cerrar el chat de
 * otro.
 *
 * El cambio vale en el acto para la gente que ya esta mirando: el
 * filtro del bus lo pregunta en cada mensaje, y ademas se avisa por el
 * bus (`chat-abierto`) para que `/chat/:slug` muestre "cerrado" sin
 * esperar a su proxima consulta. Ese aviso no lleva `red`, asi que pasa
 * por todos los filtros; la Sala lo ignora.
 */
async function apiPanelChat(url, req, res) {
  return conCreador(req, res, async (slug) => {
    let pedido;
    try { pedido = await leerJson(req); }
    catch { return json(res, 400, { error: 'json invalido' }); }

    const cambios = {};
    if (pedido?.activo !== undefined) cambios.activo = pedido.activo;
    if (pedido?.redes !== undefined) cambios.redes = pedido.redes;
    /* De a uno y nunca la lista entera: con dos pestanas del panel
       abiertas, mandar la lista completa haria que la segunda pisara
       el bloqueo que acaba de hacer la primera. */
    if (pedido?.bloquear !== undefined) cambios.bloquear = pedido.bloquear;
    if (pedido?.desbloquear !== undefined) cambios.desbloquear = pedido.desbloquear;
    const problema = creadores.porQueNoSePuedeAbrir(cambios);
    if (problema) return json(res, 400, { error: problema });

    let c;
    try { c = await creadores.ponerChatAbierto(slug, cambios); }
    catch (e) { return json(res, 400, { error: e.message }); }
    if (!c) return json(res, 403, { error: 'tu sesion no corresponde a ninguna sala' });

    console.log(`[chat] ${slug}: chat abierto ${c.activo ? `con ${c.redes.join(' y ')}` : 'cerrado'}`);
    canales.difundir(slug, {
      tipo: 'chat-abierto',
      abierto: c.activo,
      redes: c.activo ? [...c.redes] : [],
    });
    return json(res, 200, {
      ok: true,
      chatAbierto: { activo: c.activo, redes: [...c.redes], bloqueados: [...c.bloqueados] },
    });
  });
}

/**
 * /admin. La pagina se sirve SOLO al dueño del servicio.
 *
 * Es la unica pagina del proyecto que se protege del lado del
 * servidor. Las demas son HTML sin datos y se sirven a cualquiera: lo
 * que se cuida es la API. Aca se cuida tambien la pagina, y no por lo
 * que dice adentro (no dice nada), sino porque una direccion que
 * contesta 200 a todo el mundo anuncia que existe un panel de
 * administracion y con que nombre. Un 404 no anuncia nada.
 */
async function paginaAdmin(url, req, res) {
  const suyo = await sesion.leer(req, 'dueno');
  if (!suyo || !creadores.esDueno(suyo.slug)) return texto(res, 404, 'no existe');
  return servirPagina('admin.html')(url, req, res);
}

const RUTAS = [
  ['GET',    '/api/estado',            apiEstado],
  ['GET',    '/api/hora',              apiHora],
  ['GET',    '/api/chat/salud',        apiChatSalud],
  ['GET',    '/api/chat/emotes',       apiChatEmotesDelCreador],
  ['GET',    '/api/chat/actividad',    apiChatActividadDelCreador],
  ['POST',   '/api/chat/enviar',       apiChatEnviar],
  ['POST',   '/api/chat/resuscribir',  apiChatResuscribir],
  ['GET',    '/api/panel',             apiPanel],
  ['POST',   '/api/panel/clave',       apiClaveGenerar],
  ['DELETE', '/api/panel/clave',       apiClaveRevocar],
  ['DELETE', '/api/panel/twitch',      apiTwitchDesvincular],
  ['POST',   '/api/panel/suscribirse', apiSuscribirse],
  ['POST',   '/api/panel/chat',        apiPanelChat],
  ['POST',   '/api/panel/color',       apiPanelColor],
  ['POST',   '/api/panel/sala',        apiPanelSala],
  ['GET',    '/api/chat/:slug/abierto', apiChatAbierto],
  ['GET',    '/api/chat/:slug/emotes',  apiChatEmotes],
  ['GET',    '/api/chat/:slug/yo',      apiChatYo],
  ['GET',    '/api/chat/:slug/actividad', apiChatActividad],
  ['POST',   '/api/chat/:slug/enviar',  apiChatEnviarEspectador],
  ['POST',   '/api/espectador/salir',   apiEspectadorSalir],
  ['POST',   '/api/espectador/color',   apiEspectadorColor],
  ['POST',   '/api/subida',            apiSubidaFirmar],
  ['POST',   '/api/subida/borrar',     apiSubidaBorrar],
  ['GET',    '/api/admin/creadores',   apiAdminCreadores],
  ['POST',   '/api/admin/plan',        apiAdminPlan],
  ['POST',   '/api/admin/sala',        apiAdminSala],
  ['GET',    '/api/videos',            apiVideosListar],
  ['POST',   '/api/videos',            apiVideosGuardar],
  ['DELETE', '/api/videos/:id',        apiVideosBorrar],
  ['POST',   '/api/sala/:slug/reloj',  apiRelojAccion],
  ['POST',   '/api/sala/:slug/chat',   apiSalaChat],
  ['GET',    '/api/sala/:slug/yo',     apiSalaYo],
  ['POST',   '/api/sala/:slug/salir',  apiSalaSalir],
  ['GET',    '/panel',                 servirPagina('panel.html')],
  ['GET',    '/crear',                 servirPagina('crear.html')],
  ['GET',    '/terminos',              servirPagina('terminos.html')],
  ['GET',    '/admin',                 paginaAdmin],
  ['GET',    '/chat',                  servirPagina('chat.html')],
  ['GET',    '/chat/:slug',            paginaChatAbierto],
  ['GET',    '/chat/:slug/manifest.webmanifest', manifestDeSala],
  ['GET',    '/sala/:slug',            paginaSala],
  ['GET',    '/eventos/:slug',         eventos],
  ['GET',    '/oauth/kick/entrar',     kickEntrar],
  ['GET',    '/oauth/kick/volver',     kickVolver],
  ['GET',    '/oauth/twitch/entrar',   twitchEntrar],
  ['GET',    '/oauth/twitch/volver',   twitchVolver],
  ['POST',   '/kick/webhook',          kickWebhook],
  ['POST',   '/cobro/webhook',         cobroWebhook],
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

/**
 * Vuelve a poner en memoria el reloj de cada sala que tenga uno
 * guardado. Devuelve cuantos se repusieron.
 *
 * Sin esto, un deploy en medio de la peli dejaba la sala en "detenido"
 * hasta que el creador volviera a tocar play, y aca deployar en medio
 * del stream es la forma normal de trabajar. Como `empezoEn` es una
 * fecha absoluta, la posicion despues del reinicio sigue dando lo
 * mismo.
 *
 * Se restauran TODAS y no solo la del dueño: con varios creadores,
 * restaurar una sola dejaria a los demas parados sin motivo. Se hace al
 * arrancar y no por sala a demanda porque `restaurar` es lo que limpia
 * el reloj de un video que ya no esta, y eso conviene que pase una vez
 * y no en el primer pedido de cada noche.
 *
 * LAS SALAS APAGADAS NO SE REPONEN, y eso es del 2026-09-22. Una Sala
 * cerrada contesta 404 por todos lados, asi que reponerle el reloj era
 * dejar una pelicula corriendo que nadie puede ver ni parar: el unico
 * efecto posible era que se escapara por algun lado. Apagar la Sala ya
 * detiene la peli (`ponerLaSala`); esto es la otra mitad, para la que
 * quedo guardada de antes.
 *
 * Exportada para poder probarla: el resto de `arrancar` levanta
 * servidores y conexiones que un test no quiere.
 */
export async function restaurarRelojes() {
  let puestos = 0;
  try {
    /* El dueño puede no tener fila en `creadores` todavia (la escribe
       su primer login de Kick), asi que entra a mano. Un Set: si ya
       esta en la lista, no se restaura dos veces. */
    const salas = new Set((await creadores.listar()).map(c => c.slug));
    if (SLUG_DUENO) salas.add(SLUG_DUENO);
    for (const slug of salas) {
      try {
        if (!await creadores.salaAbierta(slug)) continue;
        const puesto = await reloj.restaurar(slug);
        if (puesto) {
          puestos++;
          console.log(`[reloj] ${slug} sigue en ${puesto.videoId} ` +
                      `(${Math.round(puesto.posicion)}s, ${puesto.estado})`);
        }
      } catch (e) {
        console.warn(`[reloj] ${slug}: no se pudo restaurar:`, e.name);
      }
    }
  } catch (e) {
    console.warn('[reloj] no se pudo listar las salas para restaurar:', e.name);
  }
  return puestos;
}

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

    /* Los espectadores que no vuelven hace dos meses pierden sus
       tokens. Guardar el refresh token de alguien que no usa el
       servicio es riesgo sin beneficio, y si vuelve son dos clicks.
       Se hace al arrancar y no con un reloj propio: cada deploy es un
       arranque, y esto se mide en meses. */
    try {
      const idos = await espectadores.podar();
      if (idos) console.log(`[espectadores] ${idos} espectadores vencidos al arrancar`);
    } catch (e) {
      console.warn('[espectadores] no se pudieron podar:', e.name);
    }

    /* El indice de colores se llena ACA y no cuando cada persona
       entra: quien eligio su color hace un mes y hoy escribe desde
       kick.com, sin abrir esta pagina, tiene que salir con su color
       igual. Su mensaje llega por el webhook y no pasa por ninguna
       sesion nuestra. Va DESPUES de podar, para no indexar a los que
       se acaban de ir. */
    try {
      const conColor = await espectadores.cargarColores();
      if (conColor) console.log(`[colores] ${conColor} cuentas con color propio`);
    } catch (e) {
      console.warn('[colores] no se pudieron cargar los colores:', e.name);
    }
  }

  canales.arrancarPings();

  await restaurarRelojes();

  /* El chat se levanta solo con lo que haya guardado, para cada sala:
     si un creador ya vinculo Twitch, su conexion EventSub vuelve sin
     que nadie toque nada; si vinculo Kick, se comprueba que la
     suscripcion siga estando. No se espera: un deploy no tiene por que
     quedarse sin atender pedidos mientras Twitch hace sus handshakes. */
  chat.arrancar({ base: process.env.URL_BASE ?? '' })
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
