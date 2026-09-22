/* ============================================================
   Twitch: OAuth de usuario, Helix minimo (perfil, mandar mensaje,
   suscribir EventSub) y la conexion EventSub por WebSocket.

   ---------------------------------------------------------------
   POR QUE UN ACCESS TOKEN DE USUARIO Y NO UN APP TOKEN

   Para escuchar el chat por EventSub-WebSocket y para escribir en el
   chat, Twitch exige un token de USUARIO con los scopes
   user:read:chat / user:write:chat. Un app token (client credentials)
   no sirve para transportar por websocket ni para mandar mensajes en
   nombre de alguien: por eso todo el flujo de abajo pasa por
   authorize -> code -> token, como un login mas.

   ---------------------------------------------------------------
   LA ROTACION DEL REFRESH TOKEN

   Twitch devuelve un refresh_token NUEVO cada vez que se usa uno para
   refrescar. El viejo deja de servir. Si el que llama a `refrescar`
   guarda el resultado pero sigue usando el refresh_token que tenia
   antes, la proxima vez el pedido falla. Por eso `refrescar` devuelve
   siempre el par completo y quien llama tiene que persistir el nuevo
   refreshToken, no solo el accessToken.

   ---------------------------------------------------------------
   is_sent Y drop_reason

   Un 200 de /helix/chat/messages no dice que el mensaje llego al
   chat: el automod puede retenerlo en silencio. Por eso
   `enviarMensaje` no confia en el status HTTP: mira data[0].is_sent y,
   si es false, devuelve el motivo de data[0].drop_reason para que
   quien llama pueda avisar en vez de creer que se mando.

   ---------------------------------------------------------------
   SECRETOS

   TWITCH_CLIENT_ID y TWITCH_CLIENT_SECRET salen de process.env y no
   se imprimen nunca. Los errores de red o de la API se resumen sin
   incluir tokens ni el secret: si Twitch algun dia los mete en un
   mensaje de error, ese mensaje no se loguea entero.
   ============================================================ */

const CLIENT_ID     = process.env.TWITCH_CLIENT_ID ?? '';
const CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET ?? '';

const URL_AUTORIZAR = 'https://id.twitch.tv/oauth2/authorize';
const URL_TOKEN      = 'https://id.twitch.tv/oauth2/token';
const URL_HELIX       = 'https://api.twitch.tv/helix';
export const URL_EVENTSUB = 'wss://eventsub.wss.twitch.tv/ws';

const SCOPES_DEFECTO = ['user:read:chat', 'user:write:chat'];

/* Lo minimo que necesita un ESPECTADOR: escribir. Leer el chat de una
   sala entra por el token del creador (una sola conexion EventSub para
   todos los que miran), asi que pedirle `user:read:chat` a cada
   espectador seria pedir un permiso que nadie va a usar. */
export const SCOPES_ESPECTADOR = Object.freeze(['user:write:chat']);

/** Si estan cargadas las credenciales de la app. Para no armar nada sin esto. */
export function hayCredenciales() {
  return Boolean(CLIENT_ID && CLIENT_SECRET);
}

/** La URL de authorize a la que hay que mandar al usuario. */
export function urlLogin({ redirect, estado, scopes = SCOPES_DEFECTO }) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: redirect,
    scope: scopes.join(' '),
    state: estado,
  });
  return `${URL_AUTORIZAR}?${params.toString()}`;
}

/* Un pedido de token nunca debe filtrar el body (lleva el secret) ni
   la respuesta cruda (lleva el access/refresh token) en un error. Se
   arma un Error generico con el status HTTP como unica pista. */
async function pedirToken(cuerpo) {
  const resp = await fetch(URL_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(cuerpo),
  });
  if (!resp.ok) {
    throw new Error(`twitch token respondio ${resp.status}`);
  }
  const datos = await resp.json();
  return {
    accessToken: datos.access_token,
    refreshToken: datos.refresh_token,
    venceEn: Date.now() + datos.expires_in * 1000,
    scopes: datos.scope ?? [],
  };
}

/** Cambia el code del callback de OAuth por los tokens. */
export async function canjearCodigo({ code, redirect }) {
  return pedirToken({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    code,
    grant_type: 'authorization_code',
    redirect_uri: redirect,
  });
}

/**
 * Pide un access token nuevo con el refresh token.
 *
 * Twitch rota el refresh token en cada uso: el que devuelve esta
 * funcion es el que hay que guardar de aca en mas, el que se paso
 * como argumento ya no sirve.
 */
export async function refrescar(refreshToken) {
  return pedirToken({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
}

function cabecerasHelix(accessToken) {
  return {
    Authorization: `Bearer ${accessToken}`,
    'Client-Id': CLIENT_ID,
  };
}

/** El usuario dueño del access token. */
export async function usuarioActual(accessToken) {
  const resp = await fetch(`${URL_HELIX}/users`, {
    headers: cabecerasHelix(accessToken),
  });
  if (!resp.ok) {
    throw new Error(`twitch users respondio ${resp.status}`);
  }
  const { data } = await resp.json();
  const u = data?.[0];
  if (!u) throw new Error('twitch users no devolvio ningun usuario');
  return {
    id: u.id,
    login: u.login,
    nombre: u.display_name,
    avatar: u.profile_image_url,
  };
}

/**
 * Manda un mensaje al chat. `enviado` sale de is_sent, no del status
 * HTTP: un 200 con is_sent=false quiere decir que el automod (u otra
 * cosa) lo retuvo, y eso no es un error de red sino algo para mostrar.
 */
export async function enviarMensaje({ accessToken, broadcasterId, senderId, texto, respondeA }) {
  const resp = await fetch(`${URL_HELIX}/chat/messages`, {
    method: 'POST',
    headers: { ...cabecerasHelix(accessToken), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      broadcaster_id: broadcasterId,
      sender_id: senderId,
      message: texto,
      ...(respondeA ? { reply_parent_message_id: respondeA } : {}),
    }),
  });
  if (!resp.ok) {
    throw new Error(`twitch chat/messages respondio ${resp.status}`);
  }
  const { data } = await resp.json();
  const r = data?.[0] ?? {};
  return {
    enviado: Boolean(r.is_sent),
    mensajeId: r.message_id ?? '',
    motivo: r.is_sent ? '' : (r.drop_reason?.message ?? r.drop_reason?.code ?? ''),
  };
}

/**
 * Crea la suscripcion channel.chat.message para una sesion de
 * EventSub-WebSocket ya conectada.
 *
 * version va como STRING ("1"): Helix lo pide asi, un numero lo
 * rechaza.
 */
export async function suscribirChat({ accessToken, sessionId, broadcasterId, usuarioId }) {
  const resp = await fetch(`${URL_HELIX}/eventsub/subscriptions`, {
    method: 'POST',
    headers: { ...cabecerasHelix(accessToken), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'channel.chat.message',
      version: '1',
      condition: { broadcaster_user_id: broadcasterId, user_id: usuarioId },
      transport: { method: 'websocket', session_id: sessionId },
    }),
  });
  if (!resp.ok) {
    throw new Error(`twitch eventsub/subscriptions respondio ${resp.status}`);
  }
  return resp.json();
}

/* ------------------------------------------------------- EventSub */

const ESTADOS = ['cortado', 'conectando', 'conectado', 'reconectando'];

/* Cuantos ids de mensaje recordar para el dedupe. Twitch reenvia de
   vez en cuando; con guardar los ultimos ~500 alcanza sin dejar
   crecer la memoria sin techo en un stream de horas. */
const TOPE_VISTOS = 500;

export class ConexionEventSub {
  #url;
  #suscribir;
  #alMensaje;
  #alEstado;

  #socket = null;          // socket activo (el que atiende notificaciones)
  #entrante = null;         // durante un reconnect: el socket nuevo, todavia sin welcome
  #sessionId = null;
  #estado = 'cortado';
  #cerrando = false;        // cerrar() fue llamado: no reconectar mas

  #vistos = new Set();      // dedupe de metadata.message_id

  #timerKeepalive = null;
  #timerReintento = null;
  #intentos = 0;            // fallos seguidos, para el backoff

  ultimaLlegada = null;     // Date de la ultima trama recibida (para el panel de salud)
  intentosFallidosSeguidos = 0;

  constructor({ url = URL_EVENTSUB, suscribir, alMensaje, alEstado } = {}) {
    this.#url = url;
    this.#suscribir = suscribir ?? (async () => {});
    this.#alMensaje = alMensaje ?? (() => {});
    this.#alEstado = alEstado ?? (() => {});
  }

  get estado() {
    return this.#estado;
  }

  #cambiarEstado(nuevo) {
    if (!ESTADOS.includes(nuevo)) return;
    this.#estado = nuevo;
    this.#alEstado(nuevo);
  }

  conectar() {
    this.#cerrando = false;
    this.#abrir(this.#url, { esperaWelcomeDeReconexion: false });
  }

  /**
   * Abre un socket nuevo. `esperaWelcomeDeReconexion` distingue el
   * caso de session_reconnect (donde el socket VIEJO sigue vivo hasta
   * que este nuevo manda su welcome, y no hay que volver a suscribir)
   * del caso de conexion de cero (donde si hay que suscribir).
   */
  #abrir(url, { esperaWelcomeDeReconexion }) {
    if (this.#cerrando) return;
    this.#cambiarEstado(esperaWelcomeDeReconexion ? 'reconectando' : 'conectando');

    let ws;
    try {
      ws = new WebSocket(url);
    } catch {
      this.#programarReintento();
      return;
    }

    if (esperaWelcomeDeReconexion) {
      this.#entrante = ws;
    } else {
      this.#socket = ws;
    }

    /* Los listeners NO capturan `esperaWelcomeDeReconexion`: preguntan
       cada vez contra `this.#socket` / `this.#entrante`.

       Con la bandera capturada, un socket que entraba por un
       session_reconnect quedaba marcado "de reconexion" PARA SIEMPRE,
       incluso despues de que #alWelcome lo promoviera a socket activo.
       Cuando ese socket ya promovido se caia, su listener de close
       entraba por la rama del entrante y hacia return: el socket
       quedaba muerto, `estado` seguia diciendo "conectado" y no se
       programaba ningun reintento. Lo unico que lo rescataba era el
       timer de keepalive, o sea ~15 segundos de chat mudo mintiendo
       que estaba conectado. Y Twitch manda session_reconnect de rutina
       en cada deploy suyo, asi que toda conexion larga pasa por ahi. */
    ws.addEventListener('message', (ev) => this.#alRecibir(ws, ev));
    ws.addEventListener('close', () => this.#alCerrarSocket(ws));
    ws.addEventListener('error', () => { /* el close que sigue hace todo el trabajo */ });
  }

  #alRecibir(ws, ev) {
    /* Quien es este socket se resuelve ahora, no cuando se abrio. */
    const esEntrante = ws === this.#entrante;
    /* Un socket que ya no es ninguno de los dos es el viejo de un
       reconnect que todavia no termino de cerrarse: lo que mande ya no
       cuenta. */
    if (!esEntrante && ws !== this.#socket) return;

    this.ultimaLlegada = new Date();

    let mensaje;
    try {
      mensaje = JSON.parse(ev.data);
    } catch {
      return; // trama rara: se ignora, no se rompe la conexion por esto
    }

    const tipo = mensaje.metadata?.message_type;
    const payload = mensaje.payload ?? {};

    /* Cualquier trama que llegue reinicia el reloj de keepalive: el
       socket sigue vivo, no hace falta que sea justo un keepalive. */
    if (ws === this.#socket) this.#armarTimerKeepalive(null);

    switch (tipo) {
      case 'session_welcome':
        this.#alWelcome(ws, payload, esEntrante);
        break;
      case 'session_keepalive':
        // nada mas que hacer: ya se reinicio el timer arriba
        break;
      case 'notification':
        this.#alNotificacion(payload, mensaje.metadata);
        break;
      case 'session_reconnect':
        this.#alReconnect(payload);
        break;
      case 'revocation':
        // se informa por alEstado; el socket sigue como estaba
        this.#alEstado(`revocado:${payload.subscription?.status ?? '?'}`);
        break;
      default:
        break;
    }
  }

  #alWelcome(ws, payload, esDeReconexion) {
    const sessionId = payload.session?.id;
    const timeoutSeg = payload.session?.keepalive_timeout_seconds;

    if (esDeReconexion) {
      /* La pieza delicada: las suscripciones se transfieren solas en
         un session_reconnect, asi que ACA NO se llama a `suscribir`.
         Recien ahora, con el welcome del socket nuevo en la mano, se
         cierra el viejo. Cerrarlo antes dejaria una ventana sin
         conexion en la que Twitch podria mandar algo y perderse. */
      const viejo = this.#socket;
      this.#socket = ws;
      this.#entrante = null;
      /* Si el socket activo se cayo MIENTRAS este entrante todavia no
         mandaba su welcome, #alCerrarSocket dejo un reintento
         programado. Ahora ya hay conexion: si ese timer sigue vivo,
         al disparar #abrir pisa this.#socket sin cerrar el de aca y
         queda una conexion a Twitch que ni cerrar() alcanza. */
      clearTimeout(this.#timerReintento);
      this.#timerReintento = null;
      this.#sessionId = sessionId;
      this.#intentos = 0;
      this.intentosFallidosSeguidos = 0;
      this.#armarTimerKeepalive(timeoutSeg);
      this.#cambiarEstado('conectado');
      if (viejo && viejo !== ws) {
        try { viejo.close(1000); } catch { /* ya se estara cerrando */ }
      }
      return;
    }

    this.#sessionId = sessionId;
    this.#armarTimerKeepalive(timeoutSeg);

    /* Si la suscripcion falla no hay que morir en silencio: se avisa
       por alEstado y se reintenta la conexion entera, porque un
       session_id sin nada suscripto no sirve para nada. */
    Promise.resolve()
      .then(() => this.#suscribir(sessionId))
      .then(() => {
        this.#intentos = 0;
        this.intentosFallidosSeguidos = 0;
        this.#cambiarEstado('conectado');
      })
      .catch((e) => {
        this.#alEstado(`error_suscripcion:${e?.name ?? 'Error'}`);
        try { ws.close(1000); } catch { /* sigue el flujo de close igual */ }
      });
  }

  #alNotificacion(payload, metadata) {
    const id = metadata?.message_id;
    if (id) {
      if (this.#vistos.has(id)) return; // reenvio de Twitch: no se procesa de nuevo
      this.#vistos.add(id);
      if (this.#vistos.size > TOPE_VISTOS) {
        // el Set no tiene "el mas viejo": se saca el primero en orden de insercion
        this.#vistos.delete(this.#vistos.values().next().value);
      }
    }
    this.#alMensaje(payload.event, metadata);
  }

  #alReconnect(payload) {
    const url = payload.session?.reconnect_url;
    if (!url) return;
    /* No se toca #socket todavia: sigue siendo el que atiende todo
       hasta que el nuevo mande su welcome (ver #alWelcome). */
    this.#abrir(url, { esperaWelcomeDeReconexion: true });
  }

  #armarTimerKeepalive(timeoutSeg) {
    clearTimeout(this.#timerKeepalive);
    /* timeoutSeg llega null en las tramas que no son welcome: se
       reusa el ultimo conocido guardado en la instancia. */
    const seg = timeoutSeg ?? this.#ultimoTimeout;
    if (!seg) return;
    this.#ultimoTimeout = seg;

    /* El keepalive real llega justo en el borde del timeout. Sin
       margen, la latencia de red sola alcanza para gatillar
       reconexiones que no hacian falta. +50% da aire de sobra. */
    const ms = seg * 1000 * 1.5;
    this.#timerKeepalive = setTimeout(() => this.#alVencerKeepalive(), ms);
    /* unref: esperar un keepalive de Twitch no es motivo para que el
       proceso no pueda terminar. Como el resto de los timers del
       proyecto. */
    this.#timerKeepalive.unref?.();
  }

  #ultimoTimeout = null;

  #alVencerKeepalive() {
    /* Se perdio la sesion: no es un reconnect avisado, es una sesion
       nueva. Por eso aca SI hay que volver a suscribirse, a
       diferencia de session_reconnect. */
    const s = this.#socket;
    this.#socket = null;
    if (s) { try { s.close(4005); } catch { /* no importa si ya esta cerrado */ } }
    this.#cambiarEstado('reconectando');
    this.#programarReintento();
  }

  #alCerrarSocket(ws) {
    /* Sigue siendo el entrante de un reconnect: se cerro antes de
       mandar su welcome. El activo no se toco, no hay nada que
       reconectar. */
    if (this.#entrante === ws) {
      this.#entrante = null;
      return;
    }
    if (this.#socket !== ws) return; // ya fue reemplazado (p.ej. por un reconnect exitoso)
    this.#socket = null;
    clearTimeout(this.#timerKeepalive);
    if (this.#cerrando) {
      this.#cambiarEstado('cortado');
      return;
    }
    this.#cambiarEstado('reconectando');
    this.#programarReintento();
  }

  #programarReintento() {
    if (this.#cerrando) return;
    this.#intentos++;
    this.intentosFallidosSeguidos = this.#intentos;
    /* Backoff exponencial con tope en 60s y jitter: sin jitter, si el
       server tira a todos los clientes a la vez, todos reconectarian
       juntos otra vez y se repetiria el pico. */
    const base = Math.min(1000 * 2 ** (this.#intentos - 1), 60_000);
    const espera = base / 2 + Math.random() * (base / 2);
    clearTimeout(this.#timerReintento);
    this.#timerReintento = setTimeout(() => this.#abrir(this.#url, { esperaWelcomeDeReconexion: false }), espera);
    this.#timerReintento.unref?.();
  }

  /** Corta todo. No reconecta mas. Limpia todos los timers. */
  cerrar() {
    this.#cerrando = true;
    clearTimeout(this.#timerKeepalive);
    clearTimeout(this.#timerReintento);
    /* Nunca se manda nada por el socket (4001 es exactamente el
       cierre que castiga escribirle trafico propio a EventSub): la
       unica interaccion permitida es close(). */
    if (this.#entrante) { try { this.#entrante.close(1000); } catch { /* ignorar */ } }
    if (this.#socket) { try { this.#socket.close(1000); } catch { /* ignorar */ } }
    this.#socket = null;
    this.#entrante = null;
    this.#cambiarEstado('cortado');
  }
}
