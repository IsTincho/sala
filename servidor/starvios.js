/* ============================================================
   Starvios: el chat de un directo en starvios.com/live/<usuario>.

   ---------------------------------------------------------------
   DE DONDE SALE

   Starvios no tiene API publica documentada. Su web es un cliente de
   Supabase: lee el chat de la tabla `live_chat_messages` por PostgREST
   con la clave PUBLICABLE de su proyecto, la misma que viaja en el JS
   de starvios.com a cualquiera que abra la pagina, y se entera de los
   nuevos por Supabase Realtime. Leer un chat publico no pide login.

   Aca se hace lo mismo que su web, sin el Realtime: se pregunta cada
   CADA_MENSAJES por los mensajes posteriores al ultimo visto. Polling
   y no el WebSocket de Realtime porque el protocolo de Realtime
   (Phoenix channels, heartbeats, join por tabla y filtro) es bastante
   mas codigo para ganar un segundo, y un pedido HTTP cada dos segundos
   por creador en vivo no le pesa a nadie.

   Como se apoya en algo no documentado, falla CALLADO si Starvios
   cambia su esquema: por eso cada error se loguea con el codigo HTTP
   (sin cuerpo) y queda en salud().

   ---------------------------------------------------------------
   CONFIGURACION

   STARVIOS_USUARIO   usuario de Starvios del dueño (sala de KICK_SLUG)
   STARVIOS_CANALES   o, para varias salas: "slug:usuario,slug2:usuario2"

   Sin ninguna de las dos el modulo queda apagado.

   ---------------------------------------------------------------
   EL DIRECTO

   El chat cuelga de un `live_streams.id`, no del usuario. Se busca el
   perfil por usuario, y su directo por `channel_id`, cada
   CADA_DIRECTO. Solo se leen mensajes mientras ese directo esta en
   `live`: apagado no hay nada que traer.

   Al encontrar un directo nuevo NO se trae el historial: se arranca
   desde el ultimo mensaje que ya tenia. Un deploy en medio del stream
   repetiria si no los ultimos 200 mensajes en pantalla.
   ============================================================ */

import { numeroDeEntorno } from './entorno.js';
import * as mensajes from './mensajes.js';

const URL_API = (process.env.STARVIOS_SUPABASE_URL ?? 'https://naiijcvngtkkocligwvk.supabase.co') + '/rest/v1';
/* Clave publicable (sb_publishable_*) del proyecto de Starvios: es la
   que su web manda a todo visitante, no un secreto nuestro. Se puede
   pisar por variable el dia que la roten. */
const CLAVE = process.env.STARVIOS_SUPABASE_CLAVE ?? 'sb_publishable_4lF1QyQhWOUE1Pw3rWBwEw_bVmkAxm6';

export const CADA_MENSAJES = numeroDeEntorno('STARVIOS_CADA_MS', 2_000, { minimo: 1_000 });
export const CADA_DIRECTO = 30_000;
const ESPERA_PEDIDO = 8_000;

/* Las columnas que pide la web de Starvios para pintar su chat. */
const COLUMNAS = 'id,user_id,body,coins,kind,badges,is_deleted,created_at,' +
  'profiles:profiles!live_chat_messages_user_id_fkey(username,display_name,chat_color)';

/** "slug:usuario,..." + STARVIOS_USUARIO para el dueño -> [[slug, usuario]] */
export function leerConfig(entorno = process.env) {
  const pares = new Map();
  for (const trozo of String(entorno.STARVIOS_CANALES ?? '').split(',')) {
    const [slug, usuario] = trozo.split(':').map(s => s?.trim().toLowerCase());
    if (slug && usuario) pares.set(slug, usuario);
  }
  const dueno = String(entorno.KICK_SLUG ?? '').trim().toLowerCase();
  const suyo = String(entorno.STARVIOS_USUARIO ?? '').trim().toLowerCase();
  if (dueno && suyo && !pares.has(dueno)) pares.set(dueno, suyo);
  return [...pares];
}

async function pedir(ruta) {
  const r = await fetch(`${URL_API}/${ruta}`, {
    headers: { apikey: CLAVE, accept: 'application/json' },
    signal: AbortSignal.timeout(ESPERA_PEDIDO),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

const q = encodeURIComponent;

/* ------------------------------------------------- un canal leido */

class LectorStarvios {
  /**
   * @param {string} slug     la sala donde caen los mensajes
   * @param {string} usuario  el usuario en starvios.com
   * @param {(slug:string, mensaje:object) => void} entregar
   */
  constructor(slug, usuario, entregar) {
    this.slug = slug;
    this.usuario = usuario;
    this.entregar = entregar;
    this.perfilId = null;
    this.directoId = null;
    this.vivo = false;
    this.desde = null;          // created_at del ultimo mensaje visto
    this.ultima = null;         // cuando llego el ultimo mensaje
    this.error = '';
    this.timerDirecto = null;
    this.timerMensajes = null;
    this.leyendo = false;
  }

  arrancar() {
    const vuelta = () => this.revisarDirecto()
      .catch(e => this.fallo('directo', e))
      .finally(() => { this.timerDirecto = setTimeout(vuelta, CADA_DIRECTO); this.timerDirecto.unref?.(); });
    vuelta();
    this.timerMensajes = setInterval(() => {
      if (!this.vivo || this.leyendo) return;
      this.leyendo = true;
      this.leerMensajes().catch(e => this.fallo('mensajes', e)).finally(() => { this.leyendo = false; });
    }, CADA_MENSAJES);
    this.timerMensajes.unref?.();
  }

  parar() {
    clearTimeout(this.timerDirecto);
    clearInterval(this.timerMensajes);
    this.timerDirecto = this.timerMensajes = null;
  }

  fallo(donde, e) {
    const texto = `${donde}: ${e?.message ?? e?.name ?? 'Error'}`;
    if (texto !== this.error) console.warn(`[starvios] ${this.slug} (${this.usuario}) ${texto}`);
    this.error = texto;
  }

  async revisarDirecto() {
    if (!this.perfilId) {
      const [perfil] = await pedir(`profiles?select=id&username=eq.${q(this.usuario)}`);
      if (!perfil?.id) throw new Error('no existe ese usuario en Starvios');
      this.perfilId = perfil.id;
    }
    const [directo] = await pedir(
      `live_streams?select=id,status&channel_id=eq.${q(this.perfilId)}&order=started_at.desc&limit=1`);
    const vivo = directo?.status === 'live';

    if (vivo && directo.id !== this.directoId) {
      this.directoId = directo.id;
      /* Arrancar desde el ultimo mensaje que ya tenia, no desde el
         principio: ver el encabezado. */
      const [ultimo] = await pedir(
        `live_chat_messages?select=created_at&stream_id=eq.${q(this.directoId)}&order=created_at.desc&limit=1`);
      this.desde = ultimo?.created_at ?? new Date().toISOString();
    }
    if (vivo !== this.vivo) console.log(`[starvios] ${this.slug} (${this.usuario}) ${vivo ? 'en vivo' : 'apagado'}`);
    this.vivo = vivo;
    this.error = '';
  }

  async leerMensajes() {
    if (!this.directoId) return;
    const filas = await pedir(
      `live_chat_messages?select=${q(COLUMNAS)}&stream_id=eq.${q(this.directoId)}` +
      `&created_at=gt.${q(this.desde)}&order=created_at.asc&limit=100`);
    for (const fila of filas) {
      if (fila.created_at) this.desde = fila.created_at;
      const mensaje = mensajes.deStarvios(fila);
      if (!mensaje) continue;
      this.ultima = new Date();
      try { this.entregar(this.slug, mensaje); }
      catch (e) { console.warn(`[starvios] ${this.slug}: no se pudo entregar un mensaje:`, e?.name ?? 'Error'); }
    }
    this.error = '';
  }

  salud() {
    return {
      usuario: this.usuario,
      vivo: this.vivo,
      ultima: this.ultima ? this.ultima.toISOString() : null,
      error: this.error,
    };
  }
}

/* --------------------------------------------------------- modulo */

const lectores = new Map();   // slug -> LectorStarvios

/**
 * Arranca un lector por sala configurada. No tira nunca.
 * @param {(slug:string, mensaje:object) => void} entregar  chat.recibirDeStarvios
 */
export function arrancar(entregar, entorno = process.env) {
  parar();
  for (const [slug, usuario] of leerConfig(entorno)) {
    const l = new LectorStarvios(slug, usuario, entregar);
    lectores.set(slug, l);
    l.arrancar();
    console.log(`[starvios] leyendo starvios.com/live/${usuario} -> sala ${slug}`);
  }
}

export function parar() {
  for (const l of lectores.values()) l.parar();
  lectores.clear();
}

/** El estado de Starvios de una sala, o null si no lo tiene configurado. */
export function salud(slug) {
  return lectores.get(String(slug ?? '').toLowerCase())?.salud() ?? null;
}
