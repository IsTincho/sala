/* ============================================================
   Fase 5.1 de punta a punta: el chat abierto de una sala, sólo
   lectura (PLAN-MULTICHAT.md).

   El servidor levantado de verdad en un puerto libre y pedidos HTTP
   reales, igual que sala-http y multicanal. Lo que hay que garantizar
   es lo que ve el de afuera, y sobre todo lo que NO ve:

     - con el chat cerrado, `/eventos/<slug>` no trae Twitch;
     - abierto con las dos redes, sí;
     - si el creador lo cierra (o le saca Twitch) con gente conectada,
       el próximo mensaje de Twitch ya no sale por el cable, sin
       esperar a que reconecten;
     - una sala que no existe da 404;
     - `/api/panel/chat` saca el slug de la cookie y nunca del cuerpo;
     - `/chat` a secas es el mismo archivo de siempre.

   No sale nada a internet: ni Kick ni Twitch intervienen. Los
   mensajes se meten en el bus con `canales.recordar`, que es lo mismo
   que hacen el webhook de Kick y EventSub después de traducir.
   ============================================================ */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

/* Las variables van ANTES de importar el servidor: los módulos las
   leen al cargarse. Ninguna es un secreto: son de mentira. */
const DATOS = path.join(os.tmpdir(), 'sala-pruebas-chat-abierto');
process.env.SALA_DATOS = DATOS;
process.env.MODO = 'local';
process.env.KICK_SLUG = 'istincho';
process.env.URL_BASE = 'https://sala.example';
process.env.CLAVE_CIFRADO = crypto.randomBytes(32).toString('base64');

const { crearServidor } = await import('../servidor/index.js');
const almacen = await import('../servidor/almacen.js');
const canales = await import('../servidor/canales.js');
const creadores = await import('../servidor/creadores.js');
const sesion = await import('../servidor/sesion.js');

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const CHAT_HTML = path.join(AQUI, '..', 'paginas', 'chat.html');

const DUENO = 'istincho';
const ANA = 'ana';
const BETO = 'beto';

let servidor;
let raiz;

const cookieCreador = v => `${sesion.COOKIES.dueno}=${v}`;
let sesionDueno = '';
let sesionAna = '';
let sesionBeto = '';
let sesionEspectador = '';

async function pedir(ruta, { metodo = 'GET', cookie = '', cuerpo } = {}) {
  const h = {};
  if (cookie) h.Cookie = cookie;
  if (cuerpo !== undefined) h['Content-Type'] = 'application/json';
  const r = await fetch(raiz + ruta, {
    method: metodo,
    headers: h,
    body: cuerpo === undefined ? undefined : (typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo)),
  });
  const texto = await r.text();
  let datos = null;
  try { datos = JSON.parse(texto); } catch { /* no era json */ }
  return { estado: r.status, datos, texto, cabeceras: r.headers };
}

const abrirChat = (cookie, cuerpo) => pedir('/api/panel/chat', { metodo: 'POST', cookie, cuerpo });

/** Abre un SSE y va juntando lo que llega. */
function abrirSse(ruta, { cookie = '' } = {}) {
  const eventos = [];
  let resolverPrimero;
  const primero = new Promise(ok => { resolverPrimero = ok; });

  const req = http.get({
    host: '127.0.0.1',
    port: servidor.address().port,
    path: ruta,
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
        if (!datos) continue;
        eventos.push(JSON.parse(datos));
        resolverPrimero();
      }
    });
  });

  return {
    eventos,
    primero,
    cerrar: () => req.destroy(),
    /** Los textos de chat que llegaron, en orden. */
    get textos() { return eventos.filter(e => e.tipo === 'chat').map(e => e.texto); },
    async esperar(condicion, { tope = 3000, que = 'lo esperado' } = {}) {
      const limite = Date.now() + tope;
      while (Date.now() < limite) {
        const hallado = eventos.find(condicion);
        if (hallado) return hallado;
        await new Promise(ok => setTimeout(ok, 15));
      }
      throw new Error(`no llegó ${que}; llegaron: ${eventos.map(e => e.tipo + (e.texto ? `(${e.texto})` : '')).join(', ')}`);
    },
  };
}

let nMensaje = 0;
/** Un mensaje de chat de una red, recordado en el canal como lo haría el traductor. */
const mensaje = (slug, red, texto) =>
  canales.recordar(slug, { tipo: 'chat', red, id: `m${++nMensaje}`, usuario: 'alguien', texto });

/**
 * Manda un Twitch y DESPUÉS un Kick de control, y espera al de control.
 *
 * Así "no llegó" no depende de esperar un rato: los eventos de una
 * conexión salen en orden, así que si el de control ya llegó y el de
 * Twitch no, el de Twitch no va a llegar nunca.
 */
async function twitchYControl(sse, slug, textoTwitch) {
  const control = `control-${++nMensaje}`;
  mensaje(slug, 'twitch', textoTwitch);
  mensaje(slug, 'kick', control);
  await sse.esperar(e => e.texto === control, { que: `el mensaje de control "${control}"` });
  return sse.textos.includes(textoTwitch);
}

/* ------------------------------------------------------- arranque */

test.before(async () => {
  await fsp.rm(DATOS, { recursive: true, force: true }).catch(() => {});

  /* Dos creadores con su documento, en plan "pendiente": el chat
     abierto entra en todos los planes. El dueño del servicio NO tiene
     documento, a propósito: su sala existe por KICK_SLUG, y el día que
     quiera abrir su chat tiene que poder aunque todavía no lo tenga. */
  for (const slug of [ANA, BETO]) {
    await almacen.poner('creadores', slug, { slug, plan: 'pendiente', usuarioId: '', creado: Date.now() });
  }

  sesionDueno = cookieCreador(await sesion.crear({ tipo: 'dueno', usuario: '99', nombre: 'IsTincho', slug: DUENO }));
  sesionAna = cookieCreador(await sesion.crear({ tipo: 'dueno', usuario: '111', nombre: 'Ana', slug: ANA }));
  sesionBeto = cookieCreador(await sesion.crear({ tipo: 'dueno', usuario: '222', nombre: 'Beto', slug: BETO }));
  sesionEspectador = `${sesion.COOKIES.espectador}=` +
    await sesion.crear({ tipo: 'espectador', usuario: '1001', nombre: 'unaespectadora' });

  servidor = crearServidor();
  await new Promise(ok => servidor.listen(0, '127.0.0.1', ok));
  raiz = `http://127.0.0.1:${servidor.address().port}`;
});

test.after(async () => {
  canales.cerrarTodo();
  await new Promise(ok => servidor.close(ok));
  await fsp.rm(DATOS, { recursive: true, force: true }).catch(() => {});
});

/* ================================================== la página */

test('una sala que no existe da 404: en la página, en /abierto y en el bus', async () => {
  for (const ruta of ['/chat/no-existe-esta-sala', '/api/chat/no-existe-esta-sala/abierto',
                      '/eventos/no-existe-esta-sala']) {
    assert.equal((await pedir(ruta)).estado, 404, ruta);
  }
  assert.equal(canales.hayCanal('no-existe-esta-sala'), false, 'y no dejó un canal en el mapa');
});

test('la página de una sala que existe se sirve aunque el chat esté cerrado', async () => {
  /* Cerrado no es 404: la sala existe y eso ya se sabe con un GET a
     /sala/<slug>. La página se sirve y es ella la que dice "cerrado",
     preguntándole a /abierto, así puede abrirse sola sin recargar. */
  const r = await pedir(`/chat/${ANA}`);
  assert.equal(r.estado, 200);
  assert.match(r.cabeceras.get('content-type'), /text\/html/);

  const abierto = await pedir(`/api/chat/${ANA}/abierto`);
  assert.equal(abierto.estado, 200);
  assert.deepEqual(abierto.datos, { abierto: false, redes: [] },
    'de un chat cerrado no se cuenta ni qué redes eligió');
});

test('/chat/:slug es chat.html con <base href="/"> y sin el manifest del creador', async () => {
  /* Las rutas de chat.html son relativas (para que ?demo=1 ande como
     archivo suelto). Sin la base, desde /chat/ana apuntarían a
     /chat/comun/base.css y la página cargaría sin estilos ni código. */
  const r = await pedir(`/chat/${ANA}`);
  assert.match(r.texto, /<head>\s*<base href="\/">/, 'la base tiene que ir antes de cualquier ruta relativa');
  assert.ok(!/rel="manifest"/.test(r.texto),
    'el manifest es el de la ventana del creador: instalado, abriría /chat');
  /* Y fuera de eso, es la misma página: nada de una copia aparte. */
  assert.match(r.texto, /<script src="chat\/chat\.js"><\/script>/);
});

test('los archivos del chat siguen saliendo aunque /chat/:slug tape /chat/', async () => {
  /* La misma trampa que /sala/:slug: sin la guarda, /chat/chat.js se
     leería como "la sala del canal chat.js" y daría 404. */
  for (const [ruta, tipo] of [['/chat/chat.css', /text\/css/], ['/chat/chat.js', /javascript/],
                              ['/chat/demo.js', /javascript/]]) {
    const r = await pedir(ruta);
    assert.equal(r.estado, 200, ruta);
    assert.match(r.cabeceras.get('content-type'), tipo, ruta);
  }
});

test('/chat a secas sigue siendo el mismo archivo, con su manifest y sin base', async () => {
  const r = await pedir('/chat');
  assert.equal(r.estado, 200);
  assert.equal(r.texto, fs.readFileSync(CHAT_HTML, 'utf8'), 'byte por byte el de paginas/');
  assert.match(r.texto, /rel="manifest"/);
  assert.ok(!r.texto.includes('<base'), 'la base es solo para /chat/:slug');
});

/* ============================================ el bus: cerrado y abierto */

test('con el chat cerrado, el bus público no trae Twitch', async () => {
  const sse = abrirSse(`/eventos/${ANA}`);
  await sse.primero;
  try {
    assert.equal(await twitchYControl(sse, ANA, 'twitch con el chat cerrado'), false,
      'el chat de Twitch salió por el bus público de una sala con el chat cerrado');
  } finally {
    sse.cerrar();
  }
});

test('abierto con las dos redes, el bus público trae Kick y Twitch', async () => {
  const r = await abrirChat(sesionAna, { activo: true });
  assert.equal(r.estado, 200);
  /* Sin decir redes, nace con las dos: la gracia es verlas juntas. */
  assert.deepEqual(r.datos.chatAbierto, { activo: true, redes: ['kick', 'twitch'] });

  const abierto = await pedir(`/api/chat/${ANA}/abierto`);
  assert.deepEqual(abierto.datos, { abierto: true, redes: ['kick', 'twitch'] });

  const sse = abrirSse(`/eventos/${ANA}`);
  await sse.primero;
  try {
    assert.equal(await twitchYControl(sse, ANA, 'twitch con el chat abierto'), true);
  } finally {
    sse.cerrar();
  }
});

test('el que llega con el chat abierto recibe también lo último de Twitch', async () => {
  /* El buffer pasa por el mismo filtro que lo que llega en vivo: acá el
     filtro deja pasar Twitch, así que lo viejo de Twitch viene. */
  mensaje(ANA, 'twitch', 'twitch de antes de conectarse');
  const sse = abrirSse(`/eventos/${ANA}`);
  try {
    await sse.esperar(e => e.texto === 'twitch de antes de conectarse', { que: 'el Twitch del buffer' });
  } finally {
    sse.cerrar();
  }
});

test('cerrar con gente conectada corta Twitch sin esperar a que reconecten', async () => {
  await abrirChat(sesionAna, { activo: true, redes: ['kick', 'twitch'] });
  const sse = abrirSse(`/eventos/${ANA}`);
  await sse.primero;
  try {
    assert.equal(await twitchYControl(sse, ANA, 'antes de cerrar'), true, 'abierto tiene que llegar');

    const r = await abrirChat(sesionAna, { activo: false });
    assert.equal(r.estado, 200);

    /* La página se entera por el mismo bus, sin esperar a su próxima
       consulta. */
    const aviso = await sse.esperar(e => e.tipo === 'chat-abierto', { que: 'el aviso chat-abierto' });
    assert.equal(aviso.abierto, false);
    assert.deepEqual(aviso.redes, []);

    assert.equal(await twitchYControl(sse, ANA, 'despues de cerrar'), false,
      'la conexión que ya estaba abierta siguió recibiendo Twitch');
    /* Y Kick sigue, porque la Sala depende de eso: twitchYControl ya
       lo probó al esperar el mensaje de control. */
  } finally {
    sse.cerrar();
  }
});

test('sacarle Twitch con gente conectada lo corta, y volver a ponerlo lo devuelve', async () => {
  await abrirChat(sesionAna, { activo: true, redes: ['kick', 'twitch'] });
  const sse = abrirSse(`/eventos/${ANA}`);
  await sse.primero;
  try {
    await abrirChat(sesionAna, { redes: ['kick'] });
    assert.equal(await twitchYControl(sse, ANA, 'sin twitch elegido'), false);
    assert.deepEqual((await pedir(`/api/chat/${ANA}/abierto`)).datos, { abierto: true, redes: ['kick'] });

    await abrirChat(sesionAna, { redes: ['kick', 'twitch'] });
    assert.equal(await twitchYControl(sse, ANA, 'twitch de vuelta'), true,
      'sobre la MISMA conexión, sin reconectar');
  } finally {
    sse.cerrar();
    await abrirChat(sesionAna, { activo: false });
  }
});

/* ===================================== quién abre, y el chat de quién */

test('/api/panel/chat no acepta el slug del cuerpo: abre el de la cookie', async () => {
  const r = await abrirChat(sesionAna, { slug: BETO, activo: true });
  assert.equal(r.estado, 200);

  assert.equal((await pedir(`/api/chat/${ANA}/abierto`)).datos.abierto, true, 'se abrió el de Ana');
  assert.equal((await pedir(`/api/chat/${BETO}/abierto`)).datos.abierto, false,
    'Ana abrió el chat de Beto mandando su slug en el cuerpo');

  /* Y lo que importa de verdad: el bus de Beto sigue sin Twitch. */
  const sse = abrirSse(`/eventos/${BETO}`);
  await sse.primero;
  try {
    assert.equal(await twitchYControl(sse, BETO, 'twitch de beto'), false);
  } finally {
    sse.cerrar();
    await abrirChat(sesionAna, { activo: false });
  }
});

test('sin sesión de creador no se abre nada', async () => {
  assert.equal((await abrirChat('', { activo: true })).estado, 401);
  assert.equal((await abrirChat(sesionEspectador, { activo: true })).estado, 401,
    'la cookie de espectador no es la de creador');
  assert.equal((await pedir(`/api/chat/${BETO}/abierto`)).datos.abierto, false);
});

test('lo que no se entiende se rechaza, y no queda guardado a medias', async () => {
  await abrirChat(sesionBeto, { activo: true, redes: ['kick', 'twitch'] });

  for (const cuerpo of [
    { redes: [] },
    { redes: ['youtube'] },
    { redes: 'kick' },
    { activo: 'si' },
    { activo: false, redes: ['kick', 'youtube'] },
  ]) {
    const r = await abrirChat(sesionBeto, cuerpo);
    assert.equal(r.estado, 400, JSON.stringify(cuerpo));
    assert.ok(r.datos?.error, 'y dice por qué');
  }
  assert.equal((await abrirChat(sesionBeto, '{esto no es json')).estado, 400);

  assert.deepEqual((await pedir(`/api/chat/${BETO}/abierto`)).datos,
    { abierto: true, redes: ['kick', 'twitch'] }, 'quedó como estaba');
  await abrirChat(sesionBeto, { activo: false });
});

test('la cookie de OTRA sala no destapa Twitch; la del dueño de esa sala, sí', async () => {
  /* Antes bastaba cualquier cookie de creador para recibir las dos
     redes de cualquier sala: Ana, con su sesión, leía el Twitch de
     Beto. Las dos redes son del dueño de ESA sala y de nadie más. */
  const deAna = abrirSse(`/eventos/${BETO}`, { cookie: sesionAna });
  const deBeto = abrirSse(`/eventos/${BETO}`, { cookie: sesionBeto });
  await Promise.all([deAna.primero, deBeto.primero]);
  try {
    assert.equal(await twitchYControl(deAna, BETO, 'twitch para el dueño'), false,
      'la cookie de otra sala abrió el Twitch de Beto');
    assert.ok(deBeto.textos.includes('twitch para el dueño'),
      'el dueño de la sala ve las dos redes aunque su chat esté cerrado');
  } finally {
    deAna.cerrar();
    deBeto.cerrar();
  }
});

test('?redes=kick achica lo que llega, pero no agranda nada', async () => {
  await abrirChat(sesionAna, { activo: true, redes: ['kick', 'twitch'] });
  /* La Sala lo pide así: la gente de la peli escribe a Kick, y aunque
     el creador abra su chat con Twitch, la Sala queda como estaba. */
  const soloKick = abrirSse(`/eventos/${ANA}?redes=kick`);
  /* Y pedir Twitch en una sala con el chat cerrado no lo abre. */
  const pideTwitch = abrirSse(`/eventos/${BETO}?redes=kick,twitch`);
  await Promise.all([soloKick.primero, pideTwitch.primero]);
  try {
    assert.equal(await twitchYControl(soloKick, ANA, 'twitch que la sala no pidio'), false);
    assert.equal(await twitchYControl(pideTwitch, BETO, 'twitch pedido a la fuerza'), false);
  } finally {
    soloKick.cerrar();
    pideTwitch.cerrar();
    await abrirChat(sesionAna, { activo: false });
  }
});

test('el bus.js de verdad, pidiendo solo Kick como la Sala, no recibe Twitch', async () => {
  /* De punta a punta: el cliente SSE de las páginas arma el pedido y
     el servidor lo respeta. Una prueba de cada mitad por separado
     pasaría con el nombre del parámetro distinto en cada lado. */
  const { EventSourceFalso, fijarRaiz } = await import('./fijos/eventsource-falso.js');
  fijarRaiz(raiz);
  globalThis.EventSource = EventSourceFalso;
  globalThis.window = globalThis.window ?? {};
  await import('../paginas/comun/bus.js');

  await abrirChat(sesionAna, { activo: true, redes: ['kick', 'twitch'] });
  const recibidos = [];
  const conexion = globalThis.window.Sala.conectar(ANA, (tipo, datos) => recibidos.push({ tipo, datos }),
    { redes: ['kick'] });
  const textos = () => recibidos.filter(r => r.tipo === 'chat').map(r => r.datos.texto);
  const esperarTexto = async t => {
    const limite = Date.now() + 3000;
    while (!textos().includes(t)) {
      if (Date.now() > limite) throw new Error(`no llegó "${t}"; llegaron: ${textos().join(', ')}`);
      await new Promise(ok => setTimeout(ok, 15));
    }
  };
  try {
    const limite = Date.now() + 3000;
    while (!recibidos.some(r => r.tipo === 'estado') && Date.now() < limite) {
      await new Promise(ok => setTimeout(ok, 15));
    }
    mensaje(ANA, 'twitch', 'twitch para la sala');
    mensaje(ANA, 'kick', 'kick para la sala');
    await esperarTexto('kick para la sala');
    assert.ok(!textos().includes('twitch para la sala'), 'a la Sala le llegó Twitch');
  } finally {
    conexion.cerrar();
    await abrirChat(sesionAna, { activo: false });
  }
});

/* ============================================ el dueño y la memoria */

test('el dueño del servicio abre el suyo aunque no tenga documento', async () => {
  assert.equal(await almacen.obtener('creadores', DUENO), null, 'arranca sin documento');

  const r = await abrirChat(sesionDueno, { activo: true });
  assert.equal(r.estado, 200);
  assert.deepEqual((await pedir(`/api/chat/${DUENO}/abierto`)).datos,
    { abierto: true, redes: ['kick', 'twitch'] });

  const doc = await almacen.obtener('creadores', DUENO);
  assert.ok(doc, 'el ajuste quedó guardado en su documento');
  assert.equal(doc.chatAbierto.activo, true);
  /* El documento nuevo trae el plan del alta, pero el del dueño no se
     lee de ahí: sigue saliendo de KICK_SLUG. */
  assert.equal(await creadores.planDe(DUENO), 'dueno');

  const sse = abrirSse(`/eventos/${DUENO}`);
  await sse.primero;
  try {
    assert.equal(await twitchYControl(sse, DUENO, 'twitch del dueño, abierto'), true);
  } finally {
    sse.cerrar();
    await abrirChat(sesionDueno, { activo: false });
  }
});

test('después de un reinicio, el primero que se conecta ya recibe con la regla guardada', async () => {
  await abrirChat(sesionAna, { activo: true, redes: ['kick', 'twitch'] });
  mensaje(ANA, 'twitch', 'twitch de antes del reinicio');

  /* Lo que pierde un reinicio: la memoria. */
  creadores.olvidarCache();
  assert.equal(creadores.chatAbiertoSabido(ANA), undefined, 'la memoria quedó vacía');

  /* El primero que llega es un /eventos, no un /abierto: la regla se
     tiene que cargar ANTES de mandarle el buffer. Si se cargara
     después, o recién al primer /abierto, este buffer saldría con la
     regla de "no se sabe" (solo Kick) y el Twitch no llegaría. */
  const sse = abrirSse(`/eventos/${ANA}`);
  try {
    await sse.esperar(e => e.texto === 'twitch de antes del reinicio', { que: 'el Twitch del buffer' });
  } finally {
    sse.cerrar();
  }
});

test('el ajuste sobrevive a un reinicio: se vuelve a leer del almacén', async () => {
  await abrirChat(sesionAna, { activo: true, redes: ['twitch'] });

  creadores.olvidarCache();
  assert.deepEqual((await pedir(`/api/chat/${ANA}/abierto`)).datos, { abierto: true, redes: ['twitch'] });
  await abrirChat(sesionAna, { activo: false, redes: ['kick', 'twitch'] });
});

test('/api/panel trae el chat abierto de SU sala', async () => {
  await abrirChat(sesionBeto, { activo: true, redes: ['kick'] });
  const r = await pedir('/api/panel', { cookie: sesionBeto });
  assert.equal(r.estado, 200);
  assert.deepEqual(r.datos.chatAbierto, { activo: true, redes: ['kick'] });
  /* El link no viaja: lo arma la página con el origen desde el que la
     miran, que detrás de un proxy no es el de Railway. */
  assert.ok(!JSON.stringify(r.datos).includes('/chat/beto'));

  const deAna = await pedir('/api/panel', { cookie: sesionAna });
  assert.equal(deAna.datos.chatAbierto.activo, false, 'el de Ana es el de Ana');
  await abrirChat(sesionBeto, { activo: false });
});
