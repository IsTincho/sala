/* ============================================================
   Canjes, subs y follows de las dos redes (la "actividad").

   Lo que tiene que valer siempre, y por que:

     - Los canjes y las subs salen por el bus de la sala para todos:
       Kick y Twitch ya los muestran en su propio chat. Los follows NO:
       en Twitch no son publicos y el bus lo escucha cualquiera sin login.
     - La lista la ven el creador (su cookie) y los mods, y quien es mod
       lo dice la insignia de moderador vista por el SERVIDOR en los
       mensajes de esa persona, no algo que mande el navegador.
     - Nada de esto puede tirar el chat: la actividad de Twitch se
       suscribe "si se puede" y la de Kick va en otro pedido.
   ============================================================ */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';

const DATOS = await fsp.mkdtemp(path.join(os.tmpdir(), 'sala-actividad-'));
process.env.SALA_DATOS = DATOS;
process.env.MODO = 'local';
process.env.KICK_SLUG = 'istincho';
process.env.URL_BASE = 'https://sala.example';
process.env.CLAVE_CIFRADO = crypto.randomBytes(32).toString('base64');
process.env.ACTIVIDAD_DEMORA_MS = '0';

const { crearServidor } = await import('../servidor/index.js');
const mensajes = await import('../servidor/mensajes.js');
const chat = await import('../servidor/chat.js');
const canales = await import('../servidor/canales.js');
const actividad = await import('../servidor/actividad.js');
const twitch = await import('../servidor/twitch.js');
const sesion = await import('../servidor/sesion.js');
const espectadores = await import('../servidor/espectadores.js');

const SALA = 'istincho';
const deLaSala = () => canales.ultimos(SALA);

/* ------------------------------------------------------ traductores */

test('un canje de Kick es publico y trae lo que se canjeo', () => {
  const a = mensajes.actividadDeKick('channel.reward.redemption.updated', {
    id: 'c1', status: 'pending', user_input: 'toss a coin',
    redeemer: { username: 'Jaskier', user_id: 7 },
    reward: { id: 'r1', title: 'Pedir un tema', cost: 1000 },
  });
  assert.equal(a.tipo, 'actividad');
  assert.equal(a.red, 'kick');
  assert.equal(a.clase, 'canje');
  assert.equal(a.usuario, 'Jaskier');
  assert.equal(a.regalo, 'Pedir un tema');
  assert.equal(a.costo, 1000);
  assert.equal(a.mensaje, 'toss a coin');
  assert.equal(a.publico, true);
  assert.equal('usuarioId' in a, false, 'la lista no necesita ids: no viajan');
});

test('un canje rechazado en Kick no se cuenta, uno pendiente si', () => {
  const base = { id: 'c2', redeemer: { username: 'x' }, reward: { title: 't' } };
  assert.equal(mensajes.actividadDeKick('channel.reward.redemption.updated', { ...base, status: 'rejected' }), null);
  assert.ok(mensajes.actividadDeKick('channel.reward.redemption.updated', { ...base, status: 'pending' }),
    'Kick puede mandar solo pending: exigir accepted pierde canjes reales');
});

test('un follow no es publico, en ninguna de las dos redes', () => {
  const k = mensajes.actividadDeKick('channel.followed', { follower: { username: 'Ciri', user_id: 3 } });
  const t = mensajes.actividadDeTwitch('channel.follow', { user_name: 'Ciri' }, { message_id: 'm1' });
  assert.equal(k.publico, false);
  assert.equal(t.publico, false);
});

test('Twitch: la sub regalada suelta y el canje cancelado se descartan', () => {
  assert.equal(mensajes.actividadDeTwitch('channel.subscribe', { user_name: 'x', is_gift: true }), null,
    'la cubre el regalo de quien regalo: si no, 20 subs regaladas serian 21 lineas');
  assert.equal(mensajes.actividadDeTwitch('channel.channel_points_custom_reward_redemption.add',
    { id: 'c', user_name: 'x', status: 'canceled', reward: { title: 't' } }), null);
});

test('Twitch: las recompensas de fabrica salen con un nombre que se entiende', () => {
  const a = mensajes.actividadDeTwitch('channel.channel_points_automatic_reward_redemption.add', {
    id: 'a1', user_name: 'Eskel',
    reward: { type: 'send_highlighted_message', channel_points: 300 },
    message: { text: 'hola a todos' },
  });
  assert.equal(a.clase, 'canje');
  assert.equal(a.regalo, 'Mensaje resaltado');
  assert.equal(a.costo, 300);
  assert.equal(a.mensaje, 'hola a todos');
});

/* ------------------------------------------------------ el embudo */

test('un canje sale por el bus una sola vez y sin la marca de publico', () => {
  const antes = deLaSala().length;
  const a = mensajes.actividadDeTwitch('channel.channel_points_custom_reward_redemption.add',
    { id: 'dup1', user_name: 'Lambert', status: 'unfulfilled', reward: { title: 'Terremoto', cost: 500 } });
  assert.equal(chat.recibirActividad(SALA, a), true);
  assert.equal(chat.recibirActividad(SALA, a), false, 'el repetido no pasa');
  const nuevos = deLaSala().slice(antes);
  assert.equal(nuevos.length, 1);
  assert.equal(nuevos[0].tipo, 'actividad');
  assert.equal('publico' in nuevos[0], false, 'es una decision del servidor, no un dato para el navegador');
});

test('un follow va a la lista y al bus, pero marcado privado', async () => {
  const antes = deLaSala().length;
  chat.recibirActividad(SALA, mensajes.actividadDeKick('channel.followed',
    { follower: { username: 'Triss', user_id: 44 }, created_at: new Date().toISOString() }));
  const nuevos = deLaSala().slice(antes);
  assert.equal(nuevos.length, 1);
  assert.equal(nuevos[0].privado, true,
    'el bus de la sala lo escucha cualquiera: sin la marca, el follow saldria para todos');
  const lista = await actividad.ver(SALA, { clases: ['follow'] });
  assert.equal(lista[0].usuario, 'Triss');
});

test('un canje NO sale marcado privado', () => {
  const antes = deLaSala().length;
  chat.recibirActividad(SALA, mensajes.actividadDeKick('channel.reward.redemption.updated',
    { id: 'pub1', redeemer: { username: 'Zoltan' }, reward: { title: 'Hidratate' } }));
  assert.equal(deLaSala().slice(antes)[0].privado, undefined);
});

test('el mismo canje de Kick como pending y despues accepted es uno solo', () => {
  const canje = status => mensajes.actividadDeKick('channel.reward.redemption.updated',
    { id: 'pa1', status, redeemer: { username: 'Vesemir' }, reward: { title: 'Hidratate' } });
  assert.equal(chat.recibirActividad(SALA, canje('pending')), true);
  assert.equal(chat.recibirActividad(SALA, canje('accepted')), false);
});

/* ------------------------------------------------------------ mods */

const mensajeDe = (red, usuarioId, tipos) => ({
  tipo: 'chat', red, usuarioId, insignias: tipos.map(tipo => ({ tipo })),
});

test('la insignia de moderador hace mod, y perderla lo saca', async () => {
  actividad.mirarInsignias(SALA, mensajeDe('kick', '500', ['moderator']));
  assert.equal(await actividad.esMod(SALA, [{ red: 'kick', usuarioId: '500' }]), true);
  assert.equal(await actividad.esMod(SALA, [{ red: 'twitch', usuarioId: '500' }]), false,
    'el mismo numero en la otra red es otra persona');

  actividad.mirarInsignias(SALA, mensajeDe('kick', '500', ['subscriber']));
  assert.equal(await actividad.esMod(SALA, [{ red: 'kick', usuarioId: '500' }]), false);
});

test('un mensaje de Kick con la insignia de mod, entrando por el embudo real, lo anota', async () => {
  chat.recibirDeKick(SALA, { id: 'e1', tipo: 'chat.message.sent', cuando: new Date().toISOString() }, {
    message_id: 'k-mod-1', content: 'hola',
    sender: { username: 'ModDeKick', user_id: 600, identity: { badges: [{ type: 'moderator', text: 'Moderator' }] } },
  });
  assert.equal(await actividad.esMod(SALA, [{ red: 'kick', usuarioId: '600' }]), true);
});

/* ------------------------------------------- nunca tira el chat */

test('la actividad de Twitch nunca tira y no pide lo que no tiene permiso', async () => {
  const fetchDeVerdad = globalThis.fetch;
  const pedidos = [];
  globalThis.fetch = async (url, op) => {
    const cuerpo = JSON.parse(op.body);
    pedidos.push(cuerpo.type);
    if (cuerpo.type === 'channel.follow') throw new Error('se corto la red');
    return new Response('{}', { status: cuerpo.type === 'channel.subscribe' ? 403 : 202 });
  };
  try {
    const r = await twitch.suscribirActividad({
      accessToken: 't', sessionId: 's', broadcasterId: '1',
      scopes: 'user:read:chat moderator:read:followers channel:read:subscriptions',
    });
    assert.ok(!pedidos.some(t => t.includes('channel_points')), 'sin channel:read:redemptions ni se intenta');
    assert.equal(r.sinPermiso.length, 2);
    assert.equal(r.fallaron.length, 2, 'el follow que se corto y la sub que dio 403');
    assert.ok(r.ok.includes('channel.subscription.gift'));
  } finally {
    globalThis.fetch = fetchDeVerdad;
  }
});

test('faltanScopesActividad lee los scopes como los guarda el vinculo', () => {
  assert.deepEqual(twitch.faltanScopesActividad('user:read:chat user:write:chat'), [...twitch.SCOPES_ACTIVIDAD]);
  assert.deepEqual(twitch.faltanScopesActividad([...twitch.SCOPES_ACTIVIDAD]), []);
});

/* ------------------------------------------------ quien ve la lista */

let servidor;
test.before(async () => {
  servidor = crearServidor();
  await new Promise(ok => servidor.listen(0, '127.0.0.1', ok));
});
test.after(() => { servidor?.close(); canales.cerrarTodo(); });

async function pedir(ruta, cookie = '') {
  return new Promise((ok, mal) => {
    http.get({
      host: '127.0.0.1', port: servidor.address().port, path: ruta,
      headers: cookie ? { Cookie: cookie } : {},
    }, res => {
      let texto = '';
      res.setEncoding('utf8');
      res.on('data', t => { texto += t; });
      res.on('end', () => ok({ estado: res.statusCode, datos: texto ? JSON.parse(texto) : null }));
    }).on('error', mal);
  });
}

async function espectadorConKick(usuarioId) {
  const id = espectadores.nuevoId();
  await espectadores.conectar(id, 'kick', {
    usuarioId, nombre: `persona${usuarioId}`, accessToken: 'a', refreshToken: 'r',
    venceEn: Date.now() + 3600_000, scopes: 'user:read chat:write',
  });
  return `${sesion.COOKIES.espectador}=` + await sesion.crear({ tipo: 'espectador', usuario: id, nombre: 'x' });
}

test('sin sesion la lista contesta 403, y /yo dice que no hay boton', async () => {
  assert.equal((await pedir(`/api/chat/${SALA}/actividad`)).estado, 403);
  const yo = await pedir(`/api/chat/${SALA}/yo`);
  assert.equal(yo.datos.veActividad, false);
});

test('el creador de la sala la ve; el de OTRA sala no', async () => {
  const propio = `${sesion.COOKIES.dueno}=` +
    await sesion.crear({ tipo: 'dueno', usuario: '99', nombre: 'IsTincho', slug: SALA });
  const r = await pedir(`/api/chat/${SALA}/actividad`, propio);
  assert.equal(r.estado, 200);
  assert.ok(r.datos.items.some(x => x.usuario === 'Triss'), 'los follows estan en la lista');
  assert.equal((await pedir(`/api/chat/${SALA}/yo`, propio)).datos.veActividad, true);

  const ajeno = `${sesion.COOKIES.dueno}=` +
    await sesion.crear({ tipo: 'dueno', usuario: '98', nombre: 'Otro', slug: 'otrasala' });
  assert.equal((await pedir(`/api/chat/${SALA}/actividad`, ajeno)).estado, 403);
});

test('un espectador la ve solo si su cuenta tiene la insignia de mod en ESTA sala', async () => {
  const cualquiera = await espectadorConKick('701');
  assert.equal((await pedir(`/api/chat/${SALA}/actividad`, cualquiera)).estado, 403);

  const mod = await espectadorConKick('702');
  actividad.mirarInsignias(SALA, mensajeDe('kick', '702', ['moderator']));
  const r = await pedir(`/api/chat/${SALA}/actividad?clase=canje`, mod);
  assert.equal(r.estado, 200);
  assert.ok(r.datos.items.length > 0);
  assert.ok(r.datos.items.every(x => x.clase === 'canje'), 'el filtro por clase se respeta');
  assert.equal((await pedir(`/api/chat/${SALA}/yo`, mod)).datos.veActividad, true);
});

/* ------------------------------------ el follow por el cable, de verdad */

/** Abre /eventos/:slug y junta lo que llega. */
function abrirSse(cookie = '') {
  const eventos = [];
  const req = http.get({
    host: '127.0.0.1', port: servidor.address().port, path: `/eventos/${SALA}`,
    headers: cookie ? { Cookie: cookie } : {},
  }, res => {
    let pendiente = '';
    res.setEncoding('utf8');
    res.on('data', t => {
      pendiente += t;
      let corte;
      while ((corte = pendiente.indexOf('\n\n')) >= 0) {
        const bloque = pendiente.slice(0, corte);
        pendiente = pendiente.slice(corte + 2);
        const datos = bloque.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('');
        if (datos) eventos.push(JSON.parse(datos));
      }
    });
  });
  const esperar = async (condicion, que) => {
    const limite = Date.now() + 3000;
    while (Date.now() < limite) {
      if (eventos.some(condicion)) return;
      await new Promise(ok => setTimeout(ok, 15));
    }
    throw new Error(`no llego ${que}`);
  };
  return { eventos, esperar, cerrar: () => req.destroy() };
}

test('el follow le llega al creador por el bus, y a un anonimo no', async () => {
  const dueno = `${sesion.COOKIES.dueno}=` +
    await sesion.crear({ tipo: 'dueno', usuario: '99', nombre: 'IsTincho', slug: SALA });
  const suyo = abrirSse(dueno);
  const anonimo = abrirSse();
  try {
    await suyo.esperar(e => e.tipo === 'estado', 'el estado del creador');
    await anonimo.esperar(e => e.tipo === 'estado', 'el estado del anonimo');

    /* Los dos de KICK: con el chat cerrado, al publico le llega solo
       Kick, asi que con uno de Twitch el anonimo no lo veria por la red
       y esta prueba no diria nada de lo privado. */
    chat.recibirActividad(SALA, mensajes.actividadDeKick('channel.followed',
      { follower: { username: 'Regis', user_id: 77 }, created_at: new Date().toISOString() }));
    /* Un canje despues, de control: los eventos de una conexion salen en
       orden, asi que si al anonimo le llego el canje y el follow no, el
       follow no le va a llegar nunca. */
    chat.recibirActividad(SALA, mensajes.actividadDeKick('channel.reward.redemption.updated',
      { id: 'sse-control-1', redeemer: { username: 'Control' }, reward: { title: 'Control' } }));

    await suyo.esperar(e => e.usuario === 'Regis', 'el follow al creador');
    await anonimo.esperar(e => e.usuario === 'Control', 'el canje de control al anonimo');
    assert.equal(anonimo.eventos.some(e => e.usuario === 'Regis'), false, 'el anonimo no ve follows');
  } finally {
    suyo.cerrar();
    anonimo.cerrar();
  }
});
