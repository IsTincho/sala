/* ============================================================
   Los links del chat: que se detecten bien, que el servidor no pueda
   ser usado para pedir cosas de adentro, y que la vista previa se lea
   bien de YouTube, de Twitter/X y de una pagina cualquiera.

   No se sale a la red: `fijarPedidor` cambia la capa que pide por una
   de mentira. Las defensas de esa capa (`urlPermitida`, `ipPrivada`) se
   prueban aparte, directo.
   ============================================================ */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.SALA_DATOS = await fsp.mkdtemp(path.join(os.tmpdir(), 'sala-enlaces-'));
process.env.CLAVE_CIFRADO = crypto.randomBytes(32).toString('base64');

const enlaces = await import('../servidor/enlaces.js');
const chat = await import('../servidor/chat.js');
const canales = await import('../servidor/canales.js');
const mensajes = await import('../servidor/mensajes.js');

test.beforeEach(() => { enlaces.olvidarTodo(); enlaces.fijarPedidor(null); });
test.after(() => { enlaces.fijarPedidor(null); canales.cerrarTodo(); });

/* ------------------------------------------------------ detectar */

test('se detectan los links con esquema, sin la puntuacion de la frase', () => {
  assert.deepEqual(
    enlaces.enlacesDe('mira esto (https://x.com/a/status/1). y esto: https://youtu.be/abc!'),
    ['https://x.com/a/status/1', 'https://youtu.be/abc']);
});

test('"hola.com" suelto y los esquemas raros no son links', () => {
  assert.deepEqual(enlaces.enlacesDe('entren a hola.com o javascript:alert(1)'), []);
});

test('como mucho dos por mensaje, sin repetir', () => {
  const t = 'https://a.com/1 https://a.com/1 https://b.com https://c.com';
  assert.deepEqual(enlaces.enlacesDe(t), ['https://a.com/1', 'https://b.com/']);
});

/* ------------------------------------------------------ defensas */

test('no se pide nada de adentro: IPs privadas, localhost, puertos raros', () => {
  for (const url of [
    'http://127.0.0.1/', 'http://10.0.0.5/', 'http://169.254.169.254/latest/meta-data',
    'http://192.168.1.1/', 'http://[::1]/', 'http://localhost/', 'http://servicio.internal/',
    'http://sala/', 'https://ejemplo.com:8080/', 'https://usuario:clave@ejemplo.com/',
    'ftp://ejemplo.com/', 'file:///etc/passwd',
  ]) {
    assert.equal(enlaces.urlPermitida(url), null, url);
  }
  assert.ok(enlaces.urlPermitida('https://www.youtube.com/watch?v=abc'));
});

test('ipPrivada reconoce los rangos que importan, tambien en IPv6', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.0.1', '169.254.169.254',
                    '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) {
    assert.equal(enlaces.ipPrivada(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700::1111']) assert.equal(enlaces.ipPrivada(ip), false, ip);
});

/* ------------------------------------------------ vistas previas */

const html = metas => `<html><head><title>Titulo del head</title>${metas}</head><body>...</body></html>`;

test('una pagina cualquiera: Open Graph, con la imagen solo si es https', () => {
  const v = enlaces.vistaDePagina('https://www.instagram.com/p/abc/', html(`
    <meta property="og:site_name" content="Instagram">
    <meta property="og:title" content="Tincho en Instagram: &quot;hola&quot;">
    <meta property="og:description" content="Una descripcion">
    <meta property="og:image" content="https://cdn.ejemplo.com/foto.jpg">`));
  assert.equal(v.sitio, 'Instagram');
  assert.equal(v.titulo, 'Tincho en Instagram: "hola"');
  assert.equal(v.imagen, 'https://cdn.ejemplo.com/foto.jpg');

  const sinImagenSegura = enlaces.vistaDePagina('https://ejemplo.com/',
    html('<meta property="og:image" content="http://inseguro.com/a.jpg">'));
  assert.equal(sinImagenSegura.imagen, '', 'una imagen http mezclaria contenido inseguro');
  assert.equal(sinImagenSegura.titulo, 'Titulo del head', 'sin og:title, el <title>');
});

test('una pagina sin nada que mostrar no tiene vista previa', () => {
  assert.equal(enlaces.vistaDePagina('https://ejemplo.com/', '<html><body>nada</body></html>'), null);
});

test('YouTube usa su oEmbed', async () => {
  const pedidos = [];
  enlaces.fijarPedidor(async url => {
    pedidos.push(url);
    return { cuerpo: JSON.stringify({ title: 'El video', author_name: 'Canal', thumbnail_url: 'https://i.ytimg.com/vi/abc/hqdefault.jpg' }) };
  });
  const v = await enlaces.vistaPrevia('https://www.youtube.com/watch?v=abc');
  assert.equal(v.tipo, 'video');
  assert.equal(v.titulo, 'El video');
  assert.equal(v.autor, 'Canal');
  assert.match(pedidos[0], /^https:\/\/www\.youtube\.com\/oembed\?/);
});

test('un tweet de x.com sale con su texto, sin el html que arma Twitter', async () => {
  const pedidos = [];
  enlaces.fijarPedidor(async url => {
    pedidos.push(url);
    return { cuerpo: JSON.stringify({
      author_name: 'Kick',
      html: '<blockquote class="twitter-tweet"><p lang="es">nuevo <a href="https://t.co/x">link</a><br>y &amp; mas</p>&mdash; Kick (@KickStreaming)</blockquote>',
    }) };
  });
  const v = await enlaces.vistaPrevia('https://x.com/KickStreaming/status/123');
  assert.equal(v.tipo, 'tweet');
  assert.equal(v.titulo, 'Kick');
  assert.equal(v.descripcion, 'nuevo link y & mas');
  assert.match(pedidos[0], /cdn\.syndication\.twimg\.com\/tweet-result\?.*id=123/, 'primero los medios');
  assert.match(decodeURIComponent(pedidos[1]), /url=https:\/\/twitter\.com\/KickStreaming\/status\/123/,
    'si esa via no contesta algo que se entienda, el oEmbed; que solo entiende twitter.com');
});

test('un tweet con GIF, foto y video trae sus medios, solo de twimg.com y sin los t.co del final', async () => {
  const pedidos = [];
  enlaces.fijarPedidor(async url => {
    pedidos.push(url);
    return { cuerpo: JSON.stringify({
      __typename: 'Tweet',
      text: "e jarvi' que camiseta https://t.co/wZsyi725ww",
      user: { name: 'sebaaa', screen_name: 'sebaaguii' },
      mediaDetails: [
        { type: 'animated_gif', media_url_https: 'https://pbs.twimg.com/tweet_video_thumb/a.jpg',
          video_info: { variants: [{ content_type: 'video/mp4', bitrate: 0, url: 'https://video.twimg.com/tweet_video/a.mp4' }] } },
        { type: 'photo', media_url_https: 'https://pbs.twimg.com/media/b.jpg' },
        { type: 'video', media_url_https: 'https://pbs.twimg.com/c.jpg', video_info: { variants: [
          { content_type: 'application/x-mpegURL', url: 'https://video.twimg.com/c.m3u8' },
          { content_type: 'video/mp4', bitrate: 256000, url: 'https://video.twimg.com/c-chico.mp4' },
          { content_type: 'video/mp4', bitrate: 2176000, url: 'https://video.twimg.com/c-medio.mp4' },
          { content_type: 'video/mp4', bitrate: 10368000, url: 'https://video.twimg.com/c-enorme.mp4' },
        ] } },
        { type: 'photo', media_url_https: 'https://malicioso.com/d.jpg' },
      ],
    }) };
  });
  const v = await enlaces.vistaPrevia('https://x.com/sebaaguii/status/2103631863860371523?s=20');
  assert.equal(pedidos.length, 1, 'con los medios alcanza: no hace falta el oEmbed');
  assert.match(pedidos[0], /token=[0-9a-z]+/);
  assert.equal(v.titulo, 'sebaaa');
  assert.equal(v.sitio, 'X · @sebaaguii');
  assert.equal(v.descripcion, "e jarvi' que camiseta");
  assert.deepEqual(v.medios, [
    { tipo: 'gif', url: 'https://video.twimg.com/tweet_video/a.mp4', poster: 'https://pbs.twimg.com/tweet_video_thumb/a.jpg' },
    { tipo: 'imagen', url: 'https://pbs.twimg.com/media/b.jpg', poster: '' },
    { tipo: 'video', url: 'https://video.twimg.com/c-medio.mp4', poster: 'https://pbs.twimg.com/c.jpg' },
  ], 'el video de calidad razonable y no el enorme; la foto de otro dominio, afuera');
});

test('un tweet borrado cae al oEmbed', async () => {
  let veces = 0;
  enlaces.fijarPedidor(async url => {
    veces++;
    if (url.includes('syndication')) return { cuerpo: JSON.stringify({ __typename: 'TweetTombstone' }) };
    return { cuerpo: JSON.stringify({ author_name: 'Alguien', html: '<blockquote><p>texto</p></blockquote>' }) };
  });
  const v = await enlaces.vistaPrevia('https://twitter.com/a/status/9');
  assert.equal(veces, 2);
  assert.equal(v.descripcion, 'texto');
  assert.equal(v.medios, undefined);
});

test('si falla, no hay vista y no tira; y no se vuelve a pedir enseguida', async () => {
  let veces = 0;
  enlaces.fijarPedidor(async () => { veces++; throw new Error('se corto'); });
  assert.equal(await enlaces.vistaPrevia('https://ejemplo.com/roto'), null);
  assert.equal(await enlaces.vistaPrevia('https://ejemplo.com/roto'), null);
  assert.equal(veces, 1);
});

/* ------------------------------------------- de punta a punta */

test('un mensaje con un link sale al toque, y la vista previa llega despues por el bus', async () => {
  enlaces.fijarPedidor(async () => ({ url: 'https://ejemplo.com/nota', cuerpo: html(
    '<meta property="og:title" content="La nota"><meta property="og:image" content="https://ejemplo.com/a.jpg">') }));
  const antes = canales.ultimos('istincho').length;
  const difundidos = [];
  const c = canales.canal('istincho');
  /* un cliente de mentira que anota lo que le llega */
  const res = { write: t => difundidos.push(t) };
  c.clientes.set(res, { redes: null, privado: false });

  chat.recibirDeTwitch('istincho', mensajes.deTwitch({
    message_id: 'con-link-1', chatter_user_name: 'Ciri', badges: [],
    message: { text: 'miren https://ejemplo.com/nota', fragments: [{ type: 'text', text: 'miren https://ejemplo.com/nota' }] },
  }, { message_timestamp: new Date().toISOString() }));

  const guardado = canales.ultimos('istincho').slice(antes)[0];
  assert.equal(guardado.enlaces, undefined, 'el mensaje no espera a la vista previa');

  const limite = Date.now() + 2000;
  while (!difundidos.some(t => t.includes('"tipo":"enlace"')) && Date.now() < limite) {
    await new Promise(ok => setTimeout(ok, 10));
  }
  const evento = JSON.parse(difundidos.find(t => t.includes('"tipo":"enlace"')).split('data: ')[1]);
  assert.equal(evento.mensajeId, 'con-link-1');
  assert.equal(evento.red, 'twitch', 'lleva la red: pasa por el mismo filtro que el mensaje');
  assert.equal(evento.enlaces[0].titulo, 'La nota');
  assert.equal(guardado.enlaces[0].titulo, 'La nota', 'quien entra tarde la recibe adentro del mensaje');
  c.clientes.delete(res);
});

/* ------------------------------------------------------- la pagina */

const { abrirPagina } = await import('./fijos/dom-falso.js');

function renderizador() {
  const p = abrirPagina({ antes: ['comun/mensajes.js'], script: 'comun/mensajes.js' });
  return p.ventana.SalaMensajes;
}
const todos = (nodo, etiqueta, out = []) => {
  if (nodo.tagName === etiqueta) out.push(nodo);
  for (const h of nodo.hijos ?? []) todos(h, etiqueta, out);
  return out;
};
const mensajeCon = (texto, extra = {}) => ({
  tipo: 'chat', red: 'kick', id: 'm1', usuario: 'Fulana', usuarioId: '1',
  color: '', insignias: [], texto, emotes: [], hora: new Date().toISOString(), ...extra,
});

test('en la pagina el link sale clickeable, en otra pestaña y sin avisarle de donde venis', () => {
  const li = renderizador().crear(mensajeCon('mira https://x.com/a/status/1, buenisimo'));
  const [a] = todos(li, 'A');
  assert.equal(a.href, 'https://x.com/a/status/1', 'la coma de la frase no entra en el link');
  assert.equal(a.target, '_blank');
  assert.match(a.rel, /noopener/);
  assert.match(a.rel, /noreferrer/);
  assert.equal(li.textContent.includes('buenisimo'), true);
});

test('un javascript: escrito en el chat se queda como texto', () => {
  const li = renderizador().crear(mensajeCon('toca aca javascript:alert(1)'));
  assert.equal(todos(li, 'A').length, 0);
});

test('la tarjeta se pinta con texto y descarta un link que no es http', () => {
  const S = renderizador();
  const li = S.crear(mensajeCon('https://ejemplo.com', {
    enlaces: [
      { tipo: 'tweet', url: 'https://x.com/a/status/1', sitio: 'X', titulo: '<b>Kick</b>', descripcion: 'hola', imagen: '' },
      { tipo: 'pagina', url: 'javascript:alert(1)', titulo: 'trampa' },
    ],
  }));
  const tarjetas = todos(li, 'A').filter(a => String(a.className).includes('vista-enlace'));
  assert.equal(tarjetas.length, 1);
  assert.equal(tarjetas[0].textContent.includes('<b>Kick</b>'), true, 'como texto, nunca como html');
  S.agregarVistas(li, [{ url: 'https://otra.com', titulo: 'otra' }]);
  assert.equal(todos(li, 'A').filter(a => String(a.className).includes('vista-enlace')).length, 1,
    'una sola vez por mensaje: el evento puede llegar despues de que el mensaje ya la traia');
});

test('en la pagina, el GIF arranca solo y mudo, el video espera el play, y los dos quedan fuera del link', () => {
  const S = renderizador();
  const li = S.crear(mensajeCon('https://x.com/a/status/1', {
    enlaces: [{ tipo: 'tweet', url: 'https://x.com/a/status/1', sitio: 'X', titulo: 'a', descripcion: 'b', medios: [
      { tipo: 'gif', url: 'https://video.twimg.com/a.mp4', poster: 'https://pbs.twimg.com/a.jpg' },
      { tipo: 'video', url: 'https://video.twimg.com/b.mp4', poster: 'https://pbs.twimg.com/b.jpg' },
      { tipo: 'imagen', url: 'javascript:alert(1)' },
    ] }],
  }));
  const [gif, video] = todos(li, 'VIDEO');
  assert.equal(todos(li, 'VIDEO').length, 2);
  assert.equal(gif.autoplay && gif.loop && gif.muted, true);
  assert.equal(video.autoplay, undefined);
  assert.equal(video.controls, true);
  assert.equal(video.preload, 'none', 'un video no se baja hasta que alguien le da play');
  const dentroDeUnLink = todos(li, 'A').some(a => todos(a, 'VIDEO').length);
  assert.equal(dentroDeUnLink, false, 'tocar play no puede abrir la publicacion');
  assert.equal(todos(li, 'IMG').filter(i => String(i.src).startsWith('javascript')).length, 0);
});
