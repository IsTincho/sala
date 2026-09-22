/* ============================================================
   La Sala apagada, de punta a punta.

   Decisión del dueño del 2026-09-22: por ahora el producto que se
   ofrece es el MULTICHAT (Kick y Twitch juntos) y la Sala —pasar una
   película en una página propia— queda cerrada y escondida. No se
   borró nada: es un interruptor por creador (`creadores.salaAbierta`).

   Lo que se prueba acá es que el corte sea DEL SERVIDOR y no de la
   pantalla, que es la única diferencia que importa: esconder botones
   deja la función entera a un `curl` de distancia.

     1. `/sala/:slug` y las cuatro de `/api/sala/:slug/` contestan
        exactamente lo mismo que una sala que no existe;
     2. la clave de subida, la subida a R2 y el catálogo contestan 404
        aunque quien pida esté autenticado y tenga plan activo;
     3. el chat abierto —que es lo que SÍ se ofrece— sigue andando
        igual, sin una sola diferencia;
     4. y el reloj que quedó puesto antes de apagarla no se escapa por
        `/eventos/:slug`, que es el mismo bus público del chat.

   El grupo 3 es el que vale más: cerrar la Sala no puede haber
   apagado, de rebote, lo único que hoy está en producción.
   ============================================================ */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';

/* Las variables van ANTES de importar el servidor: index.js y los
   demás módulos las leen al cargarse. Ninguna es un secreto: son de
   mentira y no salen de este proceso. */
const DATOS = path.join(os.tmpdir(), 'sala-pruebas-sala-cerrada');
process.env.SALA_DATOS = DATOS;
process.env.MODO = 'local';
process.env.KICK_SLUG = 'istincho';
process.env.KICK_CLIENT_ID = 'cliente-de-prueba';
process.env.KICK_CLIENT_SECRET = 'secreto-de-prueba';
process.env.URL_BASE = 'https://sala.example';
process.env.CLAVE_CIFRADO = crypto.randomBytes(32).toString('base64');

/* R2 con credenciales de mentira (las de ejemplo de la doc de AWS): sin
   esto, `/api/subida` contestaría 503 por falta de variables y no se
   podría distinguir "la Sala está apagada" de "falta configurar R2". */
process.env.R2_ACCOUNT_ID = 'cuentadeprueba';
process.env.R2_BUCKET = 'sala-video';
process.env.R2_ACCESS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE';
process.env.R2_SECRET_ACCESS_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
process.env.R2_URL_PUBLICA = 'https://pub-ejemplo.r2.dev';

const { crearServidor, restaurarRelojes } = await import('../servidor/index.js');
const almacen = await import('../servidor/almacen.js');
const canales = await import('../servidor/canales.js');
const creadores = await import('../servidor/creadores.js');
const sesion = await import('../servidor/sesion.js');
const videos = await import('../servidor/videos.js');

const SLUG = 'istincho';          // el dueño del servicio
const OTRO = 'otrocanal';         // un creador cualquiera, con plan activo
const FLOJO = 'salapendiente';    // uno con plan "pendiente", que no reproduce

/* --------------------------------------------------- nada sale afuera */

const fetchDeVerdad = globalThis.fetch;

globalThis.fetch = async (entrada, opciones) => {
  const url = String(typeof entrada === 'string' ? entrada : entrada?.url ?? '');
  if (url.includes('r2.cloudflarestorage.com')) {
    return new Response(
      '<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>',
      { status: 200 });
  }
  /* Si algo más intentara salir, que falle con nombre y no con un
     timeout de treinta segundos. */
  if (/^https?:\/\/(?!127\.0\.0\.1|localhost)/.test(url)) {
    throw new Error(`este test no sale a internet, y alguien pidio ${url.slice(0, 80)}`);
  }
  return fetchDeVerdad(entrada, opciones);
};

/* --------------------------------------------------------- ayudas */

let servidor;
let raiz;

let sesionDueno = '';
let sesionOtro = '';
let sesionFloja = '';
let sesionEspectador = '';
let claveDueno = '';

const NO_EXISTE = 'no-existe-esta-sala';

async function pedir(ruta, { metodo = 'GET', cookie = '', clave = '', origen = '', cuerpo } = {}) {
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
  const texto = await r.text();
  let datos = null;
  try { datos = JSON.parse(texto); } catch { /* no era json */ }
  return { estado: r.status, datos, texto, tipo: r.headers.get('content-type') ?? '' };
}

/** El primer evento de un `/eventos/:slug`, y después se corta. */
function primerEstado(slug, { cookie = '' } = {}) {
  return new Promise((ok, mal) => {
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
          const d = bloque.split('\n').filter(l => l.startsWith('data:'))
            .map(l => l.slice(5).replace(/^ /, '')).join('\n');
          if (!d) continue;
          req.destroy();
          return ok(JSON.parse(d));
        }
      });
    });
    req.on('error', mal);
    setTimeout(() => { req.destroy(); mal(new Error('no llegó ningún evento')); }, 3000).unref?.();
  });
}

/**
 * Un `/eventos/:slug` que queda abierto y va juntando lo que llega.
 * `primerEstado` no sirve para esto: se corta en el primer evento, y lo
 * que hay que ver acá es el que llega DESPUÉS.
 */
function escuchar(slug) {
  const eventos = [];
  const req = http.get({
    host: '127.0.0.1',
    port: servidor.address().port,
    path: `/eventos/${slug}`,
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
  });

  return {
    eventos,
    cerrar: () => req.destroy(),
    /** Espera hasta que llegue un evento que cumpla, o falla. */
    async esperar(cumple, { tope = 3000 } = {}) {
      const limite = Date.now() + tope;
      while (Date.now() < limite) {
        const hallado = eventos.find(cumple);
        if (hallado) return hallado;
        await new Promise(ok => setTimeout(ok, 20));
      }
      throw new Error('no llegó el evento esperado; llegaron: ' +
        eventos.map(e => `${e.tipo}/${e.estado ?? ''}`).join(', '));
    },
  };
}

const ficha = (id, slug) => ({
  id, slug, titulo: `Episodio ${id}`, duracion: 600,
  url: `https://pub-ejemplo.r2.dev/${slug}/${id}/maestra.m3u8`,
  calidades: [720], subtitulos: [], bytes: 10,
});

/* ------------------------------------------------------- arranque */

test.before(async () => {
  await fsp.rm(DATOS, { recursive: true, force: true }).catch(() => {});

  /* El otro creador con plan "amigo", o sea PLAN ACTIVO. Es lo que hace
     que este archivo pueda probar que el interruptor de la Sala es
     independiente del interruptor del plan: con la Sala apagada tiene
     que dar 404 y no el 402 de "tu plan no reproduce". */
  await almacen.poner('creadores', OTRO, { slug: OTRO, plan: 'amigo', usuarioId: '777' });
  /* Y uno "pendiente", para el otro lado de la misma moneda: con la
     Sala apagada tiene que dar 404 y no el 402 del plan, que es lo que
     fija que el interruptor se mire ANTES. */
  await almacen.poner('creadores', FLOJO, { slug: FLOJO, plan: 'pendiente', usuarioId: '888' });

  sesionDueno = `${sesion.COOKIES.dueno}=` +
    await sesion.crear({ tipo: 'dueno', usuario: '99', nombre: 'IsTincho', slug: SLUG });
  sesionOtro = `${sesion.COOKIES.dueno}=` +
    await sesion.crear({ tipo: 'dueno', usuario: '777', nombre: 'Otro', slug: OTRO });
  sesionEspectador = `${sesion.COOKIES.espectador}=` +
    await sesion.crear({ tipo: 'espectador', usuario: '1001', nombre: 'alguien' });
  sesionFloja = `${sesion.COOKIES.dueno}=` +
    await sesion.crear({ tipo: 'dueno', usuario: '888', nombre: 'Pendiente', slug: FLOJO });

  claveDueno = await videos.generarClave(SLUG);
  await videos.guardar(ficha('ep1', SLUG));

  servidor = crearServidor();
  await new Promise(ok => servidor.listen(0, '127.0.0.1', ok));
  raiz = `http://127.0.0.1:${servidor.address().port}`;
});

test.after(async () => {
  globalThis.fetch = fetchDeVerdad;
  canales.cerrarTodo();
  await new Promise(ok => servidor.close(ok));
  await fsp.rm(DATOS, { recursive: true, force: true }).catch(() => {});
});

/** Deja las dos salas como nacen: apagadas. */
test.beforeEach(async () => {
  await creadores.ponerSalaAbierta(SLUG, false);
  await creadores.ponerSalaAbierta(OTRO, false);
});

/* ======================================= la página de la Sala */

test('con la Sala apagada, /sala/:slug es indistinguible de una sala que no existe', async () => {
  /* INDISTINGUIBLE, y no "un 404 cualquiera": si contestara 403, o un
     404 con otro texto, la dirección estaría anunciando que ahí hay
     algo apagado esperando que alguien insista. Una Sala cerrada no es
     un permiso que falte: es una función que no se está ofreciendo. */
  const apagada = await pedir(`/sala/${SLUG}`);
  const inventada = await pedir(`/sala/${NO_EXISTE}`);

  assert.equal(apagada.estado, 404, `contestó ${apagada.estado}`);
  assert.equal(apagada.estado, inventada.estado);
  assert.equal(apagada.texto, inventada.texto,
    'el cuerpo tiene que ser el mismo que el de una sala inventada');
});

test('con la colección de creadores vacía la Sala del dueño tampoco existe', async () => {
  /*
   * EL PRIMER DÍA EN PRODUCCIÓN, que es el caso que casi se cuela.
   *
   * La sala del dueño del servicio existe por `KICK_SLUG` y funciona
   * con `creadores` VACÍA: `existe()` le contesta true sin tocar el
   * almacén. Si el interruptor hubiera copiado ese criterio, apagar el
   * producto habría dejado prendida justamente la única Sala que hoy
   * tiene una película puesta.
   *
   * Se le saca la fila entera (los demás tests se la crean al apagarla)
   * y se comprueba que sin fila la respuesta es la misma.
   */
  await almacen.quitar('creadores', SLUG);
  creadores.invalidar(SLUG);

  assert.equal(await creadores.existe(SLUG), true, 'su sala tiene que seguir existiendo');
  assert.equal(await creadores.salaAbierta(SLUG), false);
  assert.equal((await pedir(`/sala/${SLUG}`)).estado, 404);
  assert.equal((await pedir(`/api/sala/${SLUG}/yo`)).estado, 404);

  /* Y su chat abierto sigue en pie sin fila, como siempre. */
  assert.equal((await pedir(`/chat/${SLUG}`)).estado, 200);
  assert.equal((await pedir(`/api/chat/${SLUG}/abierto`)).estado, 200);

  /* Prenderla le crea la fila, que es el caso raro que atiende
     `ponerSalaAbierta`. */
  const r = await pedir('/api/panel/sala', {
    metodo: 'POST', cookie: sesionDueno, cuerpo: { abierta: true },
  });
  assert.equal(r.estado, 200, `contestó ${r.estado}: ${r.texto.slice(0, 120)}`);
  assert.equal((await pedir(`/sala/${SLUG}`)).estado, 200);
});

test('prendida, la misma dirección vuelve a servir la página', async () => {
  /* El control negativo: sin esto, un 404 clavado pasaría el test de
     arriba y la Sala no se podría reabrir nunca. */
  await creadores.ponerSalaAbierta(SLUG, true);

  const r = await pedir(`/sala/${SLUG}`);
  assert.equal(r.estado, 200, `contestó ${r.estado}`);
  assert.match(r.tipo, /text\/html/);
});

test('el CSS y el JS de la Sala se siguen sirviendo con la Sala apagada', async () => {
  /* `/sala/:slug` tapa todo lo que cuelga de /sala/. Que el interruptor
     no se coma también los estáticos importa el día que se reabra: si
     los tapara, la Sala volvería sin estilos y el 404 no diría por qué. */
  for (const ruta of ['/sala/sala.css', '/sala/sala.js']) {
    const r = await pedir(ruta);
    assert.equal(r.estado, 200, `${ruta} contestó ${r.estado}`);
  }
});

/* =============================== las cuatro rutas de /api/sala/ */

test('con la Sala apagada, las cuatro rutas de /api/sala/ dan 404', async () => {
  /*
   * `detener` TAMBIÉN DA 404, y quedó así a propósito.
   *
   * Durante un rato fue un problema: apagar la Sala no paraba la
   * película, así que el dueño se quedaba sin forma de cortarla y el
   * único camino era reabrir, detener y volver a cerrar. La salida
   * podía ser dejar pasar `detener` con la Sala cerrada, y se eligió la
   * otra: que apagar detenga (ver "apagar la Sala corta la película que
   * estaba puesta"). Así no queda nada corriendo que haya que ir a
   * parar, y la puerta sigue contestando lo mismo para las cuatro
   * rutas y para cualquier acción. Una excepción —"todo 404 menos
   * detener"— es una excepción que alguien copia, y además anunciaría
   * que ahí adentro hay un reloj.
   */
  const casos = [
    ['POST', `/api/sala/${SLUG}/reloj`, { cookie: sesionDueno, cuerpo: { accion: 'detener' } }],
    ['POST', `/api/sala/${SLUG}/chat`, { cookie: sesionEspectador, cuerpo: { texto: 'hola' } }],
    ['GET', `/api/sala/${SLUG}/yo`, { cookie: sesionEspectador }],
    ['POST', `/api/sala/${SLUG}/salir`, { cookie: sesionEspectador }],
  ];

  for (const [metodo, ruta, extra] of casos) {
    const r = await pedir(ruta, { metodo, ...extra });
    assert.equal(r.estado, 404, `${metodo} ${ruta} contestó ${r.estado}`);

    /* Y con el mismo cuerpo que la sala inventada: las cuatro dicen
       "esa sala no existe" y ninguna cuenta que existe pero está
       apagada. */
    const inventada = await pedir(ruta.replace(SLUG, NO_EXISTE), { metodo, ...extra });
    assert.equal(inventada.estado, 404);
    assert.deepEqual(r.datos, inventada.datos, `${metodo} ${ruta} se delata en el cuerpo`);
  }
});

test('el 404 de la Sala apagada llega ANTES que la cookie, igual que el de la sala inexistente', async () => {
  /*
   * EL ORDEN ES LA MITAD DE LA PROPIEDAD.
   *
   * `conDuenoDeLaSala` contesta la sala primero y la cookie después, con
   * su motivo escrito al lado. Si el interruptor se mirara DESPUÉS de
   * la cookie, un pedido sin sesión daría 401 y el mismo pedido con la
   * cookie del dueño daría 404: la diferencia entre los dos contaría
   * exactamente lo que el 404 viene a no contar.
   */
  const sinCookie = await pedir(`/api/sala/${SLUG}/reloj`, {
    metodo: 'POST', cuerpo: { accion: 'detener' },
  });
  assert.equal(sinCookie.estado, 404, `contestó ${sinCookie.estado}: se leyó la cookie primero`);

  /* Una cookie que no es de esta sala tampoco puede distinguir. */
  const ajena = await pedir(`/api/sala/${SLUG}/reloj`, {
    metodo: 'POST', cookie: sesionOtro, cuerpo: { accion: 'detener' },
  });
  assert.equal(ajena.estado, 404, `contestó ${ajena.estado}`);

  /* Y lo mismo desde el chat, que es la ruta hermana. */
  const chat = await pedir(`/api/sala/${SLUG}/chat`, { metodo: 'POST', cuerpo: { texto: 'hola' } });
  assert.equal(chat.estado, 404, `contestó ${chat.estado}`);
});

/* ====================== la clave, la subida y el catálogo */

test('con la Sala apagada, la clave, la subida y el catálogo dan 404 al dueño de esa sala', async () => {
  /* Autenticado y todo: quien pide es el dueño de esta sala, con su
     cookie o con su clave de subida. Lo que no existe no es la sesión,
     es la función. */
  const conCookie = [
    ['POST', '/api/panel/clave', {}],
    ['DELETE', '/api/panel/clave', {}],
    ['POST', '/api/subida', { cuerpo: { id: 'ep1', archivos: [{ ruta: 'maestra.m3u8', bytes: 1 }] } }],
    ['POST', '/api/subida/borrar', { cuerpo: { id: 'ep1' } }],
    ['GET', '/api/videos', {}],
  ];
  for (const [metodo, ruta, extra] of conCookie) {
    const r = await pedir(ruta, { metodo, cookie: sesionDueno, ...extra });
    assert.equal(r.estado, 404, `${metodo} ${ruta} contestó ${r.estado}`);
    assert.match(r.datos.error, /cerrada/i);
  }

  /* Y por el otro camino de autenticación, el de `subir.py`: la clave
     de subida corre en una terminal y no tiene cookie. Si el corte
     estuviera sólo del lado de la cookie, el script seguiría subiendo
     películas a una Sala que nadie puede abrir. */
  const conClave = [
    ['GET', '/api/videos', {}],
    ['POST', '/api/videos', { cuerpo: ficha('ep2', SLUG) }],
    ['DELETE', '/api/videos/ep1', {}],
    ['POST', '/api/subida', { cuerpo: { id: 'ep1', archivos: [{ ruta: 'x.ts', bytes: 1 }] } }],
    ['POST', '/api/subida/borrar', { cuerpo: { id: 'ep1' } }],
  ];
  for (const [metodo, ruta, extra] of conClave) {
    const r = await pedir(ruta, { metodo, clave: claveDueno, ...extra });
    assert.equal(r.estado, 404, `${metodo} ${ruta} con la clave contestó ${r.estado}`);
  }

  /* Nada de todo eso pudo haber pasado: ni ficha nueva ni ficha
     borrada. Los códigos de estado no lo dicen solos. */
  assert.equal(await videos.obtener(SLUG, 'ep2'), null, 'se guardó una ficha con la Sala apagada');
  assert.ok(await videos.obtener(SLUG, 'ep1'), 'se borró una ficha con la Sala apagada');
});

test('el panel sigue abriéndose, y dice que la Sala está apagada', async () => {
  /* El creador tiene que poder entrar a su panel: ahí está su chat
     abierto, que es lo que SÍ se ofrece. Lo que cambia es que el panel
     ahora sabe que no hay película, para no pintar botones que el
     servidor va a rechazar. */
  const r = await pedir('/api/panel', { cookie: sesionDueno });
  assert.equal(r.estado, 200, `contestó ${r.estado}`);
  assert.equal(r.datos.salaAbierta, false);

  await creadores.ponerSalaAbierta(SLUG, true);
  const abierta = await pedir('/api/panel', { cookie: sesionDueno });
  assert.equal(abierta.datos.salaAbierta, true);
});

test('prendida, la clave y el catálogo vuelven a contestar', async () => {
  /* El control negativo del bloque de arriba. */
  await creadores.ponerSalaAbierta(SLUG, true);

  const catalogo = await pedir('/api/videos', { cookie: sesionDueno });
  assert.equal(catalogo.estado, 200, `contestó ${catalogo.estado}`);
  assert.ok(catalogo.datos.videos.some(v => v.id === 'ep1'));

  const subida = await pedir('/api/subida', {
    metodo: 'POST', cookie: sesionDueno,
    cuerpo: { id: 'ep1', archivos: [{ ruta: 'maestra.m3u8', bytes: 1 }] },
  });
  assert.equal(subida.estado, 200, `contestó ${subida.estado}: ${subida.texto.slice(0, 120)}`);
});

/* ============================ el interruptor no es el del plan */

test('con plan ACTIVO y la Sala apagada igual da 404, y no el 402 del plan', async () => {
  /*
   * LOS DOS INTERRUPTORES SON INDEPENDIENTES, y este test es el que lo
   * fija.
   *
   * `otrocanal` tiene plan "amigo", o sea que si la Sala estuviera
   * prendida podría reproducir y podría subir. Con la Sala apagada
   * tiene que dar 404 —no 402, no 409, no 200—, y eso demuestra dos
   * cosas de una: que el corte es del servidor y no de los botones que
   * el panel decide pintar, y que apagar la Sala no se apoya en dejar a
   * nadie sin plan.
   */
  assert.equal(await creadores.planDe(OTRO), 'amigo', 'el plan tiene que estar activo');

  const play = await pedir(`/api/sala/${OTRO}/reloj`, {
    metodo: 'POST', cookie: sesionOtro, cuerpo: { accion: 'reproducir', videoId: 'ep1' },
  });
  assert.equal(play.estado, 404, `contestó ${play.estado}`);

  const subir = await pedir('/api/subida', {
    metodo: 'POST', cookie: sesionOtro,
    cuerpo: { id: 'ep1', archivos: [{ ruta: 'x.ts', bytes: 1 }] },
  });
  assert.equal(subir.estado, 404, `contestó ${subir.estado}: el plan contestó antes que la Sala`);

  /* Y prendida, ese mismo creador con ese mismo plan sube. */
  await creadores.ponerSalaAbierta(OTRO, true);
  const despues = await pedir('/api/subida', {
    metodo: 'POST', cookie: sesionOtro,
    cuerpo: { id: 'ep1', archivos: [{ ruta: 'x.ts', bytes: 1 }] },
  });
  assert.equal(despues.estado, 200, `contestó ${despues.estado}: ${despues.texto.slice(0, 120)}`);
});

test('con plan PENDIENTE y la Sala apagada contesta 404, y no el 402 del plan', async () => {
  /* El otro lado de la moneda, y lo que fija el ORDEN de las dos
     guardas. Si el interruptor se mirara después del plan, a este
     creador se le contestaría "tu sala todavía no puede subir videos" y
     "tu sala todavía no está habilitada para reproducir": dos
     invitaciones a suscribirse para conseguir algo que hoy no se
     ofrece. Primero se dice que no está, y recién si está se habla de
     plata. */
  assert.equal(await creadores.planDe(FLOJO), 'pendiente');

  const play = await pedir(`/api/sala/${FLOJO}/reloj`, {
    metodo: 'POST', cookie: sesionFloja, cuerpo: { accion: 'reproducir', videoId: 'ep1' },
  });
  assert.equal(play.estado, 404, `contestó ${play.estado}`);

  const subir = await pedir('/api/subida', {
    metodo: 'POST', cookie: sesionFloja,
    cuerpo: { id: 'ep1', archivos: [{ ruta: 'x.ts', bytes: 1 }] },
  });
  assert.equal(subir.estado, 404, `contestó ${subir.estado}: el plan contestó antes que la Sala`);
  assert.match(subir.datos.error, /cerrada/i);

  /* Y prendida, recién ahí aparece el 402: el plan sigue mandando
     cuando la Sala existe. */
  await creadores.ponerSalaAbierta(FLOJO, true);
  try {
    const conSala = await pedir('/api/subida', {
      metodo: 'POST', cookie: sesionFloja,
      cuerpo: { id: 'ep1', archivos: [{ ruta: 'x.ts', bytes: 1 }] },
    });
    assert.equal(conSala.estado, 402, `contestó ${conSala.estado}`);
  } finally {
    await creadores.ponerSalaAbierta(FLOJO, false);
  }
});

/* ============================================ el interruptor */

test('el dueño del servicio prende su Sala desde su panel y vuelve a existir', async () => {
  const antes = await pedir(`/sala/${SLUG}`);
  assert.equal(antes.estado, 404, 'tenía que arrancar apagada');

  const r = await pedir('/api/panel/sala', {
    metodo: 'POST', cookie: sesionDueno, cuerpo: { abierta: true },
  });
  assert.equal(r.estado, 200, `contestó ${r.estado}: ${r.texto.slice(0, 120)}`);
  assert.equal(r.datos.salaAbierta, true);

  /* Y lo que importa: las puertas se abrieron de verdad, no se contestó
     un ok y nada más. */
  assert.equal((await pedir(`/sala/${SLUG}`)).estado, 200);
  assert.equal((await pedir('/api/videos', { cookie: sesionDueno })).estado, 200);
  assert.equal((await pedir(`/api/sala/${SLUG}/yo`)).estado, 200);

  /* Y se vuelve a apagar por el mismo camino. */
  const apagar = await pedir('/api/panel/sala', {
    metodo: 'POST', cookie: sesionDueno, cuerpo: { abierta: false },
  });
  assert.equal(apagar.estado, 200);
  assert.equal(apagar.datos.salaAbierta, false);
  assert.equal((await pedir(`/sala/${SLUG}`)).estado, 404);
});

test('un creador que no es el dueño del SERVICIO no puede prender la suya', async () => {
  /* Es la mitad de la decisión: la Sala no está apagada porque a nadie
     le falte un permiso, está apagada porque hoy no se ofrece. Quién
     la prende lo dice KICK_SLUG y no un campo de la base. */
  const r = await pedir('/api/panel/sala', {
    metodo: 'POST', cookie: sesionOtro, cuerpo: { abierta: true },
  });
  assert.equal(r.estado, 403, `contestó ${r.estado}`);

  /* Y no quedó prendida a medias. */
  assert.equal(await creadores.salaAbierta(OTRO), false);
  assert.equal((await pedir(`/sala/${OTRO}`)).estado, 404);
});

test('sin sesión, y con un `abierta` que no es booleano, no se prende nada', async () => {
  const sinSesion = await pedir('/api/panel/sala', { metodo: 'POST', cuerpo: { abierta: true } });
  assert.equal(sinSesion.estado, 401);

  /* `"true"` de texto no se interpreta: una Sala que queda abierta
     creyendo que se la cerró es el error que no se descubre hasta que
     alguien entra. */
  for (const abierta of ['true', 1, undefined]) {
    const r = await pedir('/api/panel/sala', {
      metodo: 'POST', cookie: sesionDueno, cuerpo: { abierta },
    });
    assert.equal(r.estado, 400, `${JSON.stringify(abierta)} contestó ${r.estado}`);
  }
  assert.equal(await creadores.salaAbierta(SLUG), false);
});

test('el dueño del servicio prende la Sala de otro creador desde /admin', async () => {
  /* Es la única forma de habilitársela a alguien que no sea él. */
  const r = await pedir('/api/admin/sala', {
    metodo: 'POST', cookie: sesionDueno, cuerpo: { slug: OTRO, abierta: true },
  });
  assert.equal(r.estado, 200, `contestó ${r.estado}: ${r.texto.slice(0, 120)}`);
  assert.equal(r.datos.salaAbierta, true);

  assert.equal((await pedir(`/sala/${OTRO}`)).estado, 200);
  assert.equal((await pedir('/api/videos', { cookie: sesionOtro })).estado, 200);

  /* Y no le prendió la Sala a nadie más de paso. */
  assert.equal(await creadores.salaAbierta(SLUG), false);
});

test('/api/admin/sala es sólo del dueño del servicio', async () => {
  assert.equal((await pedir('/api/admin/sala', {
    metodo: 'POST', cuerpo: { slug: OTRO, abierta: true },
  })).estado, 401);

  const ajeno = await pedir('/api/admin/sala', {
    metodo: 'POST', cookie: sesionOtro, cuerpo: { slug: OTRO, abierta: true },
  });
  assert.equal(ajeno.estado, 403, `contestó ${ajeno.estado}`);
  assert.equal(await creadores.salaAbierta(OTRO), false, 'se prendió igual');

  /* Ni siquiera para prenderse la suya con su propio slug. */
  const conSuSlug = await pedir('/api/admin/sala', {
    metodo: 'POST', cookie: sesionOtro, cuerpo: { slug: OTRO, abierta: true },
  });
  assert.equal(conSuSlug.estado, 403);
});

test('/api/admin/sala tampoco interpreta un `abierta` que no es booleano', async () => {
  /* La hermana del panel ya lo probaba y ésta no: sacarle el
     `typeof !== 'boolean'` dejaba que `{abierta:"false"}` CERRARA la
     Sala en silencio (por la coerción de `ponerSalaAbierta`), o sea que
     el dueño del servicio apagaba la Sala de alguien creyendo que la
     prendía. Y al revés, sin la coerción del módulo, `"false"` la
     prendería. Las dos defensas se prueban: acá el 400, y en
     creadores.test.js que sólo `true` prende. */
  await creadores.ponerSalaAbierta(OTRO, true);
  for (const abierta of ['true', 'false', 1, 0, undefined, null]) {
    const r = await pedir('/api/admin/sala', {
      metodo: 'POST', cookie: sesionDueno, cuerpo: { slug: OTRO, abierta },
    });
    assert.equal(r.estado, 400, `${JSON.stringify(abierta)} contestó ${r.estado}`);
  }
  assert.equal(await creadores.salaAbierta(OTRO), true, 'no se puede haber movido');
});

test('/api/admin/sala sobre un creador que no existe da 404 y no lo crea', async () => {
  const r = await pedir('/api/admin/sala', {
    metodo: 'POST', cookie: sesionDueno, cuerpo: { slug: NO_EXISTE, abierta: true },
  });
  assert.equal(r.estado, 404, `contestó ${r.estado}`);
  assert.equal(await almacen.obtener('creadores', NO_EXISTE), null,
    'prender una Sala no puede ser una forma lateral de dar de alta una sala');
});

test('desde /admin el dueño SÍ se puede tocar a sí mismo, a diferencia del plan', async () => {
  /* `/api/admin/plan` lo rechaza porque su plan no sale de la base y
     escribirlo daría la impresión de que sí. Este interruptor sale de
     la base para todos, y es el mismo campo del mismo documento que
     toca desde su panel: rechazarlo acá sería una excepción sin
     motivo. */
  const plan = await pedir('/api/admin/plan', {
    metodo: 'POST', cookie: sesionDueno, cuerpo: { slug: SLUG, plan: 'amigo' },
  });
  assert.equal(plan.estado, 400, 'el plan del dueño sigue sin salir de la base');

  const sala = await pedir('/api/admin/sala', {
    metodo: 'POST', cookie: sesionDueno, cuerpo: { slug: SLUG, abierta: true },
  });
  assert.equal(sala.estado, 200, `contestó ${sala.estado}: ${sala.texto.slice(0, 120)}`);
  assert.equal((await pedir(`/sala/${SLUG}`)).estado, 200);
});

/* ================== el chat abierto, que es lo que sí se ofrece */

test('con la Sala apagada el chat abierto no cambia en nada', async () => {
  /* EL TEST QUE MÁS IMPORTA DE ESTE ARCHIVO. Cerrar la Sala no puede
     haber apagado de rebote lo único que hoy está en producción. */
  await creadores.ponerChatAbierto(SLUG, { activo: true, redes: ['kick', 'twitch'] });

  const abierto = await pedir(`/api/chat/${SLUG}/abierto`);
  assert.equal(abierto.estado, 200, `contestó ${abierto.estado}`);
  assert.equal(abierto.datos.abierto, true);
  assert.deepEqual(abierto.datos.redes, ['kick', 'twitch']);

  const yo = await pedir(`/api/chat/${SLUG}/yo`, { cookie: sesionEspectador });
  assert.equal(yo.estado, 200, `contestó ${yo.estado}`);

  /* Escribir sigue pidiendo lo de siempre (conectar una cuenta), que es
     un 401 y no un 404: la ruta existe. */
  const enviar = await pedir(`/api/chat/${SLUG}/enviar`, {
    metodo: 'POST', origen: 'https://sala.example', cuerpo: { red: 'kick', texto: 'hola' },
  });
  assert.equal(enviar.estado, 401, `contestó ${enviar.estado}`);

  const pagina = await pedir(`/chat/${SLUG}`);
  assert.equal(pagina.estado, 200, `contestó ${pagina.estado}`);

  const manifest = await pedir(`/chat/${SLUG}/manifest.webmanifest`);
  assert.equal(manifest.estado, 200, `contestó ${manifest.estado}`);
  assert.equal(JSON.parse(manifest.texto).start_url, `/chat/${SLUG}`);
});

test('el bus sigue abierto y sigue repartiendo el chat con la Sala apagada', async () => {
  const estado = await primerEstado(SLUG);
  assert.equal(estado.tipo, 'estado');
  assert.equal(estado.slug, SLUG);
});

/* ======================= la fuga del reloj por /eventos/:slug */

test('el reloj que quedó puesto NO sale por el bus público con la Sala apagada', async () => {
  /*
   * LA FUGA QUE ESTE CAMBIO CIERRA, y la parte delicada de todo esto.
   *
   * `/eventos/:slug` es TAMBIÉN el bus del chat abierto: sigue siendo
   * público y sin sesión con la Sala apagada, porque es lo que hace
   * andar a `/chat/:slug`. Pero el evento `estado` que se manda al
   * conectar lleva siempre el reloj del canal, y los eventos sin `red`
   * pasan todos los filtros por definición (`canales.leDaEl`).
   *
   * O sea: un creador que deja una película puesta y después apaga su
   * Sala seguiría regalando el título, la URL y el segundo exacto a
   * cualquier `curl /eventos/<slug>`. Se corta en `estadoDe`, que es
   * donde el reloj se mete en el sobre.
   */
  await creadores.ponerSalaAbierta(SLUG, true);
  const play = await pedir(`/api/sala/${SLUG}/reloj`, {
    metodo: 'POST', cookie: sesionDueno, cuerpo: { accion: 'reproducir', videoId: 'ep1' },
  });
  assert.equal(play.estado, 200, `no se pudo poner la peli: ${play.texto.slice(0, 120)}`);

  /* Con la Sala PRENDIDA el que llega tarde recibe el reloj, como
     siempre: es el control que hace que lo de abajo signifique algo. */
  const conSalaAbierta = await primerEstado(SLUG);
  assert.ok(conSalaAbierta.reloj, 'con la Sala prendida el estado inicial tiene que traer el reloj');
  assert.equal(conSalaAbierta.reloj.videoId, 'ep1');

  /* Y ahora se apaga la Sala, sin tocar el reloj: queda puesto en el
     canal, que es exactamente el caso real.

     POR EL MÓDULO Y NO POR LA RUTA, y eso importa desde que apagar
     detiene la película: por la ruta no quedaría reloj que filtrar y
     este test pasaría sin probar nada. El filtro de `estadoDe` sigue
     siendo la defensa de atrás —para un reloj que quedó de antes, o
     para una fila escrita a mano— y acá se lo prueba solo. */
  await creadores.ponerSalaAbierta(SLUG, false);

  const publico = await primerEstado(SLUG);
  assert.equal(publico.tipo, 'estado', 'el bus tiene que seguir abierto para el chat');
  assert.equal(publico.reloj, null,
    'con la Sala apagada el bus público no puede contar qué película quedó puesta');
  /* Ni el título ni la URL por ningún otro campo del sobre. */
  assert.ok(!JSON.stringify(publico).includes('ep1'),
    `el estado nombra la película igual: ${JSON.stringify(publico)}`);

  /* El dueño de ESTA sala lo sigue viendo, aunque la tenga apagada: su
     propio `/api/panel` le cuenta el mismo reloj, y que el panel diga
     "reproduciendo" y su propio bus diga "nada puesto" sería una
     contradicción que tendría que resolver él. */
  const suyo = await primerEstado(SLUG, { cookie: sesionDueno });
  assert.ok(suyo.reloj, 'el dueño de la sala tiene que seguir viendo su propio reloj');
  assert.equal(suyo.reloj.videoId, 'ep1');

  /* Pero la cookie de OTRO creador no alcanza: es la cookie de su sala,
     no una llave de todas. */
  const ajeno = await primerEstado(SLUG, { cookie: sesionOtro });
  assert.equal(ajeno.reloj, null, 'la cookie de otro creador no abre el reloj de esta sala');

  /* LA MISMA FUGA POR LA OTRA PUERTA. `/api/estado` es público y sin
     sesión —lo consulta la página `/`— y publicaba `canales[].reloj`
     entero: el título, la URL y el segundo de la película de TODOS los
     canales, de un pedido, sin siquiera saber el slug. Cerrar sólo el
     bus no cerraba nada. */
  const estado = await pedir('/api/estado');
  assert.equal(estado.estado, 200);
  assert.ok(!estado.texto.includes('ep1'),
    `/api/estado nombra la película: ${estado.texto.slice(0, 300)}`);
  assert.ok(!estado.texto.includes('maestra.m3u8'), '/api/estado da la URL del video');
  /* Y sigue sirviendo para lo que sirve: decir qué canales hay vivos. */
  assert.ok(Array.isArray(estado.datos.canales));

  /* Se deja el canal limpio para los demás tests del archivo. */
  await creadores.ponerSalaAbierta(SLUG, true);
  await pedir(`/api/sala/${SLUG}/reloj`, {
    metodo: 'POST', cookie: sesionDueno, cuerpo: { accion: 'detener' },
  });
});

/* ======================= apagar la Sala apaga la película */

test('apagar la Sala corta la película que estaba puesta', async () => {
  /*
   * APAGAR TENÍA QUE APAGAR, y no apagaba.
   *
   * El interruptor escribía el campo y nada más. Quien ya estaba
   * mirando tenía el sobre `reloj` entero (título, URL de R2 y el
   * instante en que empezó) y la posición la calcula sola la página,
   * así que seguía viendo la película hasta el final aunque para el
   * servidor esa Sala ya no existiera. Peor: el dueño se quedaba sin la
   * palanca para cortar, porque con la Sala cerrada
   * `POST /api/sala/:slug/reloj` contesta 404 como todo lo demás. El
   * único camino era reabrir, detener y volver a cerrar.
   */
  await creadores.ponerSalaAbierta(SLUG, true);
  const play = await pedir(`/api/sala/${SLUG}/reloj`, {
    metodo: 'POST', cookie: sesionDueno, cuerpo: { accion: 'reproducir', videoId: 'ep1' },
  });
  assert.equal(play.estado, 200, `no se pudo poner la peli: ${play.texto.slice(0, 120)}`);

  const mirando = escuchar(SLUG);
  await mirando.esperar(e => e.tipo === 'estado');
  assert.equal(mirando.eventos[0].reloj.videoId, 'ep1', 'tiene que estar mirando de verdad');

  try {
    const apagar = await pedir('/api/panel/sala', {
      metodo: 'POST', cookie: sesionDueno, cuerpo: { abierta: false },
    });
    assert.equal(apagar.estado, 200, `contestó ${apagar.estado}`);

    /* A quien está mirando se le avisa: sin esto sigue la película
       hasta el final. */
    const corte = await mirando.esperar(e => e.tipo === 'reloj');
    assert.equal(corte.estado, 'detenido', `llegó ${corte.estado}`);
  } finally {
    mirando.cerrar();
  }

  /* Y no revive sola: el reloj guardado se borró, así que reabrir la
     Sala no vuelve a poner la peli donde estaba. */
  assert.equal(await almacen.obtener('reloj', SLUG), null,
    'el reloj guardado tiene que irse con la Sala');

  await creadores.ponerSalaAbierta(SLUG, true);
  const despues = await primerEstado(SLUG);
  assert.equal(despues.reloj, null, 'reabrir no puede resucitar la película sola');
});

test('apagar la Sala de otro desde /admin también le corta la película', async () => {
  /* El interruptor tiene dos rutas y las dos tienen que apagar igual.
     Si sólo apagara la del panel, la única forma de cortar la de otro
     creador seguiría siendo pedirle que entre él. */
  await creadores.ponerSalaAbierta(OTRO, true);
  await videos.guardar(ficha('ep1', OTRO));
  const play = await pedir(`/api/sala/${OTRO}/reloj`, {
    metodo: 'POST', cookie: sesionOtro, cuerpo: { accion: 'reproducir', videoId: 'ep1' },
  });
  assert.equal(play.estado, 200, `no se pudo poner la peli: ${play.texto.slice(0, 120)}`);

  const mirando = escuchar(OTRO);
  await mirando.esperar(e => e.tipo === 'estado');
  try {
    const apagar = await pedir('/api/admin/sala', {
      metodo: 'POST', cookie: sesionDueno, cuerpo: { slug: OTRO, abierta: false },
    });
    assert.equal(apagar.estado, 200, `contestó ${apagar.estado}`);

    const corte = await mirando.esperar(e => e.tipo === 'reloj');
    assert.equal(corte.estado, 'detenido');
  } finally {
    mirando.cerrar();
  }
  assert.equal(await almacen.obtener('reloj', OTRO), null);
});

test('un deploy no le repone la película a una Sala apagada', async () => {
  /*
   * LA OTRA MITAD DEL MISMO AGUJERO. `restaurarRelojes` corre en cada
   * arranque —y acá deployar en medio del stream es la forma normal de
   * trabajar—, así que un reloj que quedó guardado de antes volvía a
   * memoria aunque la Sala estuviera cerrada: una película corriendo
   * que nadie puede ver ni parar, esperando escaparse por algún lado.
   */
  await creadores.ponerSalaAbierta(OTRO, true);
  await videos.guardar(ficha('ep1', OTRO));
  await pedir(`/api/sala/${OTRO}/reloj`, {
    metodo: 'POST', cookie: sesionOtro, cuerpo: { accion: 'reproducir', videoId: 'ep1' },
  });

  /* Se apaga POR EL MÓDULO, que es lo que no detiene nada: así queda
     el caso real de una Sala cerrada con un reloj guardado de antes
     (una fila escrita a mano, o cerrada antes de este arreglo). */
  await creadores.ponerSalaAbierta(OTRO, false);
  assert.ok(await almacen.obtener('reloj', OTRO), 'el reloj guardado tiene que seguir ahí');

  canales.cerrarTodo();                       // el deploy: la memoria se va
  assert.equal(await restaurarRelojes(), 0, 'no se puede reponer una peli que nadie puede parar');
  assert.equal(canales.hayCanal(OTRO), false, 'ni siquiera se crea el canal');

  /* Control negativo: con la Sala prendida, el mismo reloj sí vuelve.
     Sin esto, un `return 0` pelado pasaría el test. */
  await creadores.ponerSalaAbierta(OTRO, true);
  assert.equal(await restaurarRelojes(), 1);
  const estado = await primerEstado(OTRO);
  assert.equal(estado.reloj.videoId, 'ep1');

  await pedir(`/api/sala/${OTRO}/reloj`, {
    metodo: 'POST', cookie: sesionOtro, cuerpo: { accion: 'detener' },
  });
  canales.cerrarTodo();
});
