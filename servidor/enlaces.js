/* ============================================================
   Vista previa de los links del chat: un tweet, un video de YouTube,
   un post de Instagram, cualquier pagina.

   ---------------------------------------------------------------
   LA ARMA EL SERVIDOR, UNA VEZ, Y NO EL NAVEGADOR DE CADA UNO

   La otra forma era meter en la pagina los scripts de inserción de
   cada red (widgets.js de Twitter, embed.js de Instagram). Eso es
   codigo de terceros corriendo adentro del chat de cada espectador,
   con sus cookies y su rastreo, y trescientas pestañas pidiendo lo
   mismo. Aca el servidor pide la vista previa una sola vez, la
   cachea, y la pagina recibe datos planos (titulo, texto, imagen) que
   pinta con textContent. Lo unico de afuera que carga el navegador es
   la imagen, igual que los emotes.

   ---------------------------------------------------------------
   EL SERVIDOR ABRE URLS QUE ESCRIBE CUALQUIERA: LAS DEFENSAS

   Es la parte delicada. Un link en el chat lo escribe un desconocido,
   y sin cuidado el servidor terminaria pidiendo lo que le digan:
   `http://169.254.169.254/` (los metadatos de la nube),
   `http://localhost:27017`, la red interna de Railway. Por eso:

     - Solo http y https, puertos 80 y 443, sin usuario ni clave en la URL.
     - LA IP SE CHEQUEA AL CONECTAR, en el `lookup` del socket, no con
       un DNS aparte antes: un dominio que contesta una IP publica al
       preguntar y una privada al conectar (DNS rebinding) no pasa,
       porque la que se revisa es la misma con la que se conecta.
     - Redirecciones a mano, como mucho tres, y cada salto pasa por las
       mismas reglas.
     - Tope de tiempo (5 s) y de bytes (512 KB): una pagina que no
       termina nunca no se queda con un lugar para siempre.
     - Cuatro pedidos en vuelo como mucho, cache de 6 horas y como
       mucho dos links por mensaje: el chat no puede convertir al
       servidor en un robot que baja lo que le pidan.
   ============================================================ */

import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';

const ESPERA = 5000;
const TOPE_BYTES = 512 * 1024;
const TOPE_SALTOS = 3;
const EN_VUELO = 4;
const POR_MENSAJE = 2;
const CACHE_OK = 6 * 60 * 60 * 1000;
const CACHE_MAL = 10 * 60 * 1000;
const TOPE_CACHE = 500;

/* ------------------------------------------------------- los links */

/* Lo que se considera un link en el texto. Solo con esquema: "hola.com"
   suelto en una frase no se convierte en nada. La pagina usa la misma
   regla para hacerlos clickeables (paginas/comun/mensajes.js). */
const RE_ENLACE = /\bhttps?:\/\/[^\s<>"'`]+/gi;
/* Lo que suele quedar pegado al final de un link en una frase. */
const RE_COLA = /[),.;:!?'"\]}]+$/;

/** Los links de un texto, sin repetir y sin la puntuacion del final. */
export function enlacesDe(texto) {
  const vistos = new Set();
  for (const m of String(texto ?? '').matchAll(RE_ENLACE)) {
    const limpio = m[0].replace(RE_COLA, '');
    try {
      const u = new URL(limpio);
      if (u.protocol === 'http:' || u.protocol === 'https:') vistos.add(u.href);
    } catch { /* no era una URL */ }
    if (vistos.size >= POR_MENSAJE) break;
  }
  return [...vistos];
}

/* ------------------------------------------------ la red, con cuidado */

/** Si una IP es de las que el servidor no tiene por que pedir nunca. */
export function ipPrivada(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||     // CGNAT
      (a === 169 && b === 254) ||               // link-local y metadatos de la nube
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19));
  }
  const x = ip.toLowerCase();
  if (x.startsWith('::ffff:')) return ipPrivada(x.slice(7));
  return x === '::' || x === '::1' || x.startsWith('fc') || x.startsWith('fd') ||
    x.startsWith('fe8') || x.startsWith('fe9') || x.startsWith('fea') || x.startsWith('feb') ||
    x.startsWith('ff');
}

/* El `lookup` del socket: resuelve y RECHAZA las privadas. Es el mismo
   resultado con el que despues se conecta, asi que no hay ventana. */
function lookupSeguro(host, opciones, cb) {
  dns.lookup(host, { ...opciones, all: true }, (err, direcciones) => {
    if (err) return cb(err);
    const publicas = direcciones.filter(d => !ipPrivada(d.address));
    if (!publicas.length) return cb(new Error('direccion no permitida'));
    if (opciones?.all) return cb(null, publicas);
    return cb(null, publicas[0].address, publicas[0].family);
  });
}

/** Si una URL se puede pedir, antes de tocar la red. */
export function urlPermitida(texto) {
  let u;
  try { u = new URL(texto); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  if (u.port && u.port !== '80' && u.port !== '443') return null;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) && ipPrivada(host)) return null;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') ||
      host.endsWith('.local') || !host.includes('.')) return null;
  return u;
}

/* Un GET con todas las reglas de arriba. Devuelve { tipo, cuerpo, url }. */
function pedirUnaVez(u) {
  return new Promise((ok, mal) => {
    const cliente = u.protocol === 'https:' ? https : http;
    const req = cliente.get(u, {
      lookup: lookupSeguro,
      timeout: ESPERA,
      headers: {
        /* Un navegador comun: varias redes (Instagram, TikTok) le
           contestan una pagina vacia a lo que no se parece a uno. */
        'User-Agent': 'Mozilla/5.0 (compatible; SalaChat/1.0; vista previa de links)',
        Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.5',
        'Accept-Language': 'es-AR,es;q=0.9,en;q=0.7',
      },
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return ok({ salto: new URL(res.headers.location, u).href });
      }
      if (res.statusCode !== 200) { res.resume(); return mal(new Error(`HTTP ${res.statusCode}`)); }
      const tipo = String(res.headers['content-type'] ?? '');
      if (!/text\/html|application\/xhtml|json/i.test(tipo)) { res.resume(); return mal(new Error('no es una pagina')); }
      const trozos = [];
      let bytes = 0;
      res.on('data', t => {
        bytes += t.length;
        if (bytes > TOPE_BYTES) {
          /* Con lo que llego alcanza: las etiquetas que importan estan
             en el <head>. Se corta y se usa lo que haya. */
          trozos.push(t.subarray(0, t.length - (bytes - TOPE_BYTES)));
          res.destroy();
          return ok({ tipo, cuerpo: Buffer.concat(trozos).toString('utf8'), url: u.href });
        }
        trozos.push(t);
      });
      res.on('end', () => ok({ tipo, cuerpo: Buffer.concat(trozos).toString('utf8'), url: u.href }));
      res.on('error', mal);
    });
    req.on('timeout', () => req.destroy(new Error('tardo demasiado')));
    req.on('error', mal);
  });
}

async function pedirSeguro(texto) {
  let actual = texto;
  for (let salto = 0; salto <= TOPE_SALTOS; salto++) {
    const u = urlPermitida(actual);
    if (!u) throw new Error('url no permitida');
    const r = await pedirUnaVez(u);
    if (!r.salto) return r;
    actual = r.salto;
  }
  throw new Error('demasiadas redirecciones');
}

/* Las pruebas cambian esto: no pueden salir a la red, y un servidor de
   mentira en 127.0.0.1 es justo lo que las defensas rechazan. */
let pedir = pedirSeguro;
export function fijarPedidor(fn) { pedir = fn ?? pedirSeguro; }

/* ------------------------------------------------------ que se saca */

const ENTIDADES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…' };
const desescapar = s => String(s ?? '')
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&([a-z]+);/gi, (m, n) => ENTIDADES[n.toLowerCase()] ?? m);
const recortar = (s, n) => {
  const t = desescapar(s).replace(/\s+/g, ' ').trim();
  return [...t].length > n ? [...t].slice(0, n - 1).join('') + '…' : t;
};
/* Solo imagenes https: una http mezclaria contenido inseguro en la pagina. */
const imagenSegura = (s, base) => {
  /* Vacio es "no hay": resuelto contra la base, '' daria la URL de la
     pagina misma, y la tarjeta pondria la pagina como imagen. */
  if (!String(s ?? '').trim()) return '';
  try {
    const u = new URL(desescapar(s), base);
    return u.protocol === 'https:' ? u.href : '';
  } catch { return ''; }
};

/** Las etiquetas <meta> de una pagina, como mapa de nombre a valor. */
export function metasDe(html) {
  const metas = {};
  const cabeza = String(html).slice(0, TOPE_BYTES);
  for (const m of cabeza.matchAll(/<meta\b[^>]*>/gi)) {
    const etiqueta = m[0];
    const clave = /(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(etiqueta)?.[1]?.toLowerCase();
    const valor = /content\s*=\s*"([^"]*)"|content\s*=\s*'([^']*)'/i.exec(etiqueta);
    if (clave && valor && !(clave in metas)) metas[clave] = valor[1] ?? valor[2] ?? '';
  }
  const titulo = /<title[^>]*>([^<]*)<\/title>/i.exec(cabeza)?.[1];
  if (titulo && !metas['<title>']) metas['<title>'] = titulo;
  return metas;
}

const sitioDe = url => new URL(url).hostname.replace(/^www\./, '');

/** Una pagina cualquiera: Open Graph, con Twitter Cards y <title> de respaldo. */
export function vistaDePagina(url, html) {
  const m = metasDe(html);
  const titulo = recortar(m['og:title'] ?? m['twitter:title'] ?? m['<title>'] ?? '', 140);
  const descripcion = recortar(m['og:description'] ?? m['twitter:description'] ?? m.description ?? '', 280);
  const imagen = imagenSegura(m['og:image'] ?? m['og:image:url'] ?? m['twitter:image'] ?? '', url);
  if (!titulo && !descripcion && !imagen) return null;
  return {
    tipo: 'pagina',
    url,
    sitio: recortar(m['og:site_name'] ?? '', 60) || sitioDe(url),
    titulo, descripcion, imagen, autor: '',
  };
}

/* --------------------------------------------- las redes que tienen API */

const esYoutube = u => /(^|\.)youtube\.com$/.test(u.hostname) || u.hostname === 'youtu.be';
const esTwitter = u => /(^|\.)(twitter|x)\.com$/.test(u.hostname) && /\/status\/\d+/.test(u.pathname);

/* YouTube y Twitter tienen oEmbed publico y sin clave: trae el titulo
   y el autor de verdad, no lo que la pagina quiera poner en sus metas. */
async function vistaDeYoutube(url) {
  const r = await pedir(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`);
  const d = JSON.parse(r.cuerpo);
  return {
    tipo: 'video', url, sitio: 'YouTube',
    titulo: recortar(d.title, 140), descripcion: '',
    imagen: imagenSegura(d.thumbnail_url ?? '', url), autor: recortar(d.author_name, 80),
  };
}

async function vistaDeTwitter(url) {
  /* El oEmbed de Twitter solo entiende twitter.com, aunque el link sea de x.com */
  const deTwitter = url.replace(/^https?:\/\/(www\.|mobile\.)?x\.com\//i, 'https://twitter.com/');
  const r = await pedir(`https://publish.twitter.com/oembed?omit_script=1&dnt=true&url=${encodeURIComponent(deTwitter)}`);
  const d = JSON.parse(r.cuerpo);
  /* El texto del tweet viene adentro del primer <p> del html que arma
     Twitter. Se le sacan las etiquetas: la pagina pinta texto, nunca html. */
  const parrafo = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(String(d.html ?? ''))?.[1] ?? '';
  const texto = parrafo.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '');
  return {
    tipo: 'tweet', url, sitio: 'X',
    titulo: recortar(d.author_name, 80), descripcion: recortar(texto, 280),
    imagen: '', autor: recortar(d.author_name, 80),
  };
}

async function armar(url) {
  const u = new URL(url);
  if (esYoutube(u)) return vistaDeYoutube(url);
  if (esTwitter(u)) {
    /* Si el oEmbed falla (Twitter lo apaga cada tanto), la pagina en
       si no sirve: sin JavaScript no muestra nada. Se deja sin vista. */
    return vistaDeTwitter(url);
  }
  const r = await pedir(url);
  return vistaDePagina(r.url ?? url, r.cuerpo);
}

/* ------------------------------------------------ cache y cola */

const cache = new Map();    // url -> { vista, hasta }
const enCurso = new Map();  // url -> promesa
let activos = 0;
const esperando = [];

const turno = () => new Promise(ok => {
  if (activos < EN_VUELO) { activos++; ok(); }
  else esperando.push(ok);
});
const liberar = () => {
  const siguiente = esperando.shift();
  if (siguiente) siguiente();
  else activos--;
};

/**
 * La vista previa de un link, o null si no hay (o no se pudo). Nunca tira.
 */
export async function vistaPrevia(url) {
  const guardada = cache.get(url);
  if (guardada && Date.now() < guardada.hasta) return guardada.vista;
  if (enCurso.has(url)) return enCurso.get(url);

  const p = (async () => {
    await turno();
    try {
      const vista = await armar(url);
      guardar(url, vista, vista ? CACHE_OK : CACHE_MAL);
      return vista;
    } catch {
      /* Que un link no tenga vista previa es lo normal (paginas sin
         metas, redes con muro de login): no se loguea. */
      guardar(url, null, CACHE_MAL);
      return null;
    } finally {
      liberar();
      enCurso.delete(url);
    }
  })();
  enCurso.set(url, p);
  return p;
}

function guardar(url, vista, dura) {
  cache.set(url, { vista, hasta: Date.now() + dura });
  while (cache.size > TOPE_CACHE) cache.delete(cache.keys().next().value);
}

/** Solo para las pruebas. */
export function olvidarTodo() { cache.clear(); enCurso.clear(); }
