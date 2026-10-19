/* ============================================================
   Raids (hosts) de Kick, por el WebSocket de Kick.

   La API publica de Kick no tiene evento de raid: sus webhooks son
   follows, subs, gifts, kicks, recompensas, baneos, chat y estado del
   directo. Nada de hosts. Los bots que si avisan raids se cuelgan del
   WebSocket con el que la propia web de Kick mueve el chat, que es un
   Pusher comun, y aca se hace lo mismo. Adaptado de
   ../CosasStream/servidor/kickws.js, que lo usa en produccion.

   Son canales PUBLICOS: se entra sin credenciales, igual que cualquiera
   que abra kick.com/<canal>. No hay ningun secreto aca.

   ---------------------------------------------------------------
   UNA CONEXION PARA TODAS LAS SALAS

   CosasStream escucha un canal; Sala, el de cada creador vinculado con
   Kick. Pusher deja suscribir muchos canales por la misma conexion, asi
   que es UNA sola, y cada sala suma sus dos canales
   (`chatrooms.<id>.v2` y `chatrooms.<id>`: Kick manda el mismo raid
   por los dos, con forma distinta). Al reconectar se vuelven a pedir
   todos.

   ---------------------------------------------------------------
   LO QUE PUEDE ROMPERSE

   No es una API: es lo que usa la web de Kick, y Kick lo cambia sin
   avisar. Ya roto la clave de Pusher una vez (oct-2026); por eso se le
   pide la vigente en cada conexion. El id de la sala de chat sale de
   `kick.com/api/v2/channels/<slug>`, que tampoco es publica. Si algo de
   esto falla, lo unico que se pierde son los raids de Kick: el log lo
   dice y el chat sigue por webhook como siempre. Se apaga con
   KICK_RAIDS=0.
   ============================================================ */

import crypto from 'node:crypto';

const CLAVE_RESPALDO = process.env.KICK_PUSHER_KEY  ?? '34bf7a0ff419a2a775b9';
const HOST_RESPALDO  = process.env.KICK_PUSHER_HOST ?? 'ws-us2.pusher.com';
/* Prendido en produccion. En local y en los tests, apagado salvo
   KICK_RAIDS=1: un test que verifica Kick no puede salir a kick.com. */
const ACTIVO = process.env.KICK_RAIDS === '1' || (process.env.KICK_RAIDS !== '0' &&
  process.env.MODO !== 'local' && !process.env.NODE_TEST_CONTEXT);

const EVENTOS_HOST = new Set([
  'App\\Events\\StreamHostEvent',    // chatrooms.{id}.v2
  'App\\Events\\StreamHostedEvent',  // chatrooms.{id}
]);

const RECONEXION = [2000, 5000, 10000, 30000, 60000];
const VENTANA_REPETIDO = 60_000;

let ws = null;
let intentos = 0;
let reloj = null;
let cerrado = true;
let clave = CLAVE_RESPALDO;
let host = HOST_RESPALDO;
let alRaid = null;                 // (slug, nombreEvento, datos) => void

/* slug de la sala -> { slugKick, canal, chat } */
const salas = new Map();
/* id de la sala de chat de Kick -> slug de la sala */
const porChat = new Map();
/* `${slug}:${quien}` -> cuando, para no contar dos veces el mismo raid */
const ultimos = new Map();

const log = (...a) => console.log('[hosts]', ...a);

/** El id del canal y el de su sala de chat. */
async function ids(slugKick) {
  const r = await fetch(`https://kick.com/api/v2/channels/${encodeURIComponent(slugKick)}`, {
    headers: { 'user-agent': 'Mozilla/5.0', accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) throw new Error(`kick.com respondio ${r.status}`);
  const d = await r.json();
  const chat = d?.chatroom?.id;
  if (!chat) throw new Error('el canal no trae chatroom.id');
  return { canal: d?.id ?? null, chat: String(chat) };
}

/* La clave y el cluster vigentes de Pusher, al mismo endpoint que usa
   la web. Con uno cualquiera de los canales alcanza. */
async function pedirCredenciales() {
  const canal = [...salas.values()].find(s => s.canal)?.canal;
  if (!canal) return;
  try {
    const r = await fetch(`https://web.kick.com/api/v1/realtime/channels/${canal}/chat/connection`, {
      method: 'POST',
      headers: { 'user-agent': 'Mozilla/5.0', accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({
        client: { id: crypto.randomUUID(), type: 'web' },
        capabilities: { accepted_providers: [{ provider: 'pusher' }] },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) throw new Error(`respondio ${r.status}`);
    const d = await r.json();
    const p = d?.data?.connections?.find(c => c?.provider === 'pusher')?.credentials;
    if (!p?.app_key || !p?.cluster) throw new Error('no ofrecio pusher');
    if (p.app_key !== clave) log(`clave de Pusher nueva: ${p.app_key} (${p.cluster})`);
    clave = p.app_key;
    host = `ws-${p.cluster}.pusher.com`;
  } catch (e) {
    log(`no se pudieron pedir las credenciales (${e.message}), sigo con ${clave}`);
  }
}

const canalesDe = chat => [`chatrooms.${chat}.v2`, `chatrooms.${chat}`];

function suscribir(chat) {
  if (ws?.readyState !== 1) return;
  for (const canal of canalesDe(chat)) {
    ws.send(JSON.stringify({ event: 'pusher:subscribe', data: { auth: '', channel: canal } }));
  }
}

/** Si ya se conto este raid en el ultimo minuto. Exportada para los tests. */
export function repetido(slug, quien, ahora = Date.now()) {
  const clave = `${slug}:${String(quien).toLowerCase()}`;
  const antes = ultimos.get(clave);
  if (antes && ahora - antes < VENTANA_REPETIDO) return true;
  ultimos.set(clave, ahora);
  for (const [k, t] of ultimos) if (ahora - t > VENTANA_REPETIDO) ultimos.delete(k);
  return false;
}

/** Un sobre de Pusher. Exportada para los tests: no toca la red. */
export function recibir(sobre) {
  if (!EVENTOS_HOST.has(sobre?.event)) return false;
  const chat = /^chatrooms\.(\d+)/.exec(String(sobre.channel ?? ''))?.[1];
  const slug = chat ? porChat.get(chat) : null;
  if (!slug) return false;
  let datos = sobre.data;
  if (typeof datos === 'string') {
    try { datos = JSON.parse(datos); } catch { return false; }
  }
  const quien = datos?.host_username ?? datos?.user?.username ?? '';
  if (!quien || repetido(slug, quien)) return false;
  log(`${slug}: raid de ${quien}`);
  try { alRaid?.(slug, sobre.event, datos); }
  catch (e) { log('evento de host mal formado:', e.message); }
  return true;
}

function programarReconexion() {
  if (cerrado) return;
  const espera = RECONEXION[Math.min(intentos, RECONEXION.length - 1)];
  intentos++;
  clearTimeout(reloj);
  reloj = setTimeout(() => conectar().catch(e => {
    log('no se pudo reconectar:', e.message);
    programarReconexion();
  }), espera);
  reloj.unref?.();
}

async function conectar() {
  if (cerrado || !salas.size) return;
  await pedirCredenciales();
  if (cerrado) return;
  ws = new WebSocket(`wss://${host}/app/${clave}?protocol=7&client=sala&version=1.0&flash=false`);

  ws.addEventListener('open', () => {
    for (const s of salas.values()) if (s.chat) suscribir(s.chat);
  });

  ws.addEventListener('message', ev => {
    let sobre;
    try { sobre = JSON.parse(ev.data); } catch { return; }
    if (sobre.event === 'pusher:ping') {
      ws.send(JSON.stringify({ event: 'pusher:pong', data: {} }));
      return;
    }
    /* Recien aca se da por bueno: Pusher abre y despues echa si la
       clave no sirve. */
    if (sobre.event === 'pusher_internal:subscription_succeeded') {
      intentos = 0;
      return;
    }
    if (sobre.event === 'pusher:error') {
      let d = sobre.data;
      if (typeof d === 'string') { try { d = JSON.parse(d); } catch { /* queda el texto */ } }
      log('Pusher dio error:', d?.code ?? '', d?.message ?? d);
      return;
    }
    recibir(sobre);
  });

  ws.addEventListener('error', () => { /* el close que viene atras reconecta */ });
  ws.addEventListener('close', ev => {
    if (cerrado) return;
    log(`se corto (${ev.code}${ev.reason ? ' ' + ev.reason : ''}), reintentando`);
    programarReconexion();
  });
}

/** Lo que hace cada raid. Lo pone chat.js al arrancar. */
export function alRecibir(fn) {
  alRaid = fn;
}

/**
 * Suma una sala a la escucha. Idempotente: se llama en cada vuelta de
 * los cinco minutos y solo hace algo la primera vez (o si cambio el
 * canal de Kick de esa sala).
 */
export async function vigilar(slug, slugKick) {
  if (!ACTIVO || !slug || !slugKick) return false;
  if (typeof WebSocket === 'undefined') return false;
  const ya = salas.get(slug);
  if (ya?.slugKick === slugKick && ya.chat) return true;

  let datos;
  try { datos = await ids(slugKick); }
  catch (e) {
    log(`${slug}: no se pudo averiguar la sala de chat de Kick (${e.message}): sin raids de Kick por ahora`);
    return false;
  }
  if (ya?.chat) porChat.delete(ya.chat);
  salas.set(slug, { slugKick, ...datos });
  porChat.set(datos.chat, slug);

  if (cerrado) {
    cerrado = false;
    conectar().catch(e => { log('no se pudo conectar:', e.message); programarReconexion(); });
  } else {
    suscribir(datos.chat);
  }
  return true;
}

export function parar() {
  cerrado = true;
  clearTimeout(reloj);
  try { ws?.close(); } catch { /* ya estaba cerrado */ }
}

/** Para los tests: una sala conocida sin pasar por kick.com. */
export function conocer(slug, chat) {
  salas.set(slug, { slugKick: slug, canal: null, chat: String(chat) });
  porChat.set(String(chat), slug);
}

export const estado = () => ({
  activo: ACTIVO,
  salas: salas.size,
  conectado: ws?.readyState === 1,
});
