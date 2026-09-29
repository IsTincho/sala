/* ============================================================
   Cliente de la API de Kick.

   Dos clases de token, y la diferencia importa:

     token de app      client_credentials. Es "la aplicacion Sala".
                       Sirve para mirar datos publicos de un canal.
     token de usuario  OAuth 2.1 + PKCE. Es "esta persona". Hace falta
                       para escribir en el chat con su nombre y para
                       suscribir eventos de su canal.

   En Sala casi todo pasa por el segundo: la gracia del proyecto es que
   el mensaje del espectador salga en kick.com con SU cuenta, no con
   una cuenta de bot. El token de app queda para resolver el
   broadcaster_user_id de un slug y poco mas.

   Todo verificado contra docs.kick.com (enero 2026). Los endpoints no
   se adivinan.
   ============================================================ */

import crypto from 'node:crypto';

const ID  = 'https://id.kick.com';
const API = 'https://api.kick.com/public/v1';

const CLIENT_ID     = process.env.KICK_CLIENT_ID     ?? '';
const CLIENT_SECRET = process.env.KICK_CLIENT_SECRET ?? '';
export const SLUG   = process.env.KICK_SLUG          ?? '';

export const hayCredenciales = () => Boolean(CLIENT_ID && CLIENT_SECRET);

/* Los scopes que pide cada rol. El espectador pide lo minimo que
   necesita para que su mensaje salga con su nombre: identificarse y
   escribir. Nada mas. Pedir de mas espanta gente en la pantalla de
   permisos y no nos sirve para nada.

   `creador` y `dueno` piden lo mismo, y son dos nombres porque son dos
   puertas: `dueno` es el link de /panel (el que ya tiene sala) y
   `creador` es el de /crear (el que la esta creando). Lo que hace cada
   uno con el resultado lo decide `kickVolver`, no los scopes.

   `channel:read` NO esta en la lista del brief (que pide `user:read
   chat:write events:subscribe`) y hace falta igual: /users de Kick no
   devuelve el slug del canal, sale de /channels, y sin el slug no se
   puede saber de que sala es esta persona ni si es el dueño del
   servicio. Sin ese scope el alta no puede funcionar. */
/* `channel:rewards:read` es por los canjes de puntos de la lista de
   actividad. Es de lectura, y un login viejo sin el sigue andando: lo
   unico que puede faltar son los canjes de Kick. */
export const SCOPES = {
  dueno: ['user:read', 'channel:read', 'chat:write', 'events:subscribe', 'channel:rewards:read'],
  creador: ['user:read', 'channel:read', 'chat:write', 'events:subscribe', 'channel:rewards:read'],
  espectador: ['user:read', 'chat:write'],
};

/* Kick separa los scopes por espacio (asi estan todos los ejemplos de
   la doc). URLSearchParams lo codifica solo. */
const scopesComoTexto = lista => lista.join(' ');

/* ------------------------------------------------------- token de app */

let tokenDeApp = { valor: '', vence: 0 };

export async function appToken() {
  if (tokenDeApp.valor && Date.now() < tokenDeApp.vence) return tokenDeApp.valor;
  if (!hayCredenciales()) throw new Error('faltan KICK_CLIENT_ID / KICK_CLIENT_SECRET');

  const r = await fetch(`${ID}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }),
  });
  if (!r.ok) throw new Error(`token de app: HTTP ${r.status}`);

  const d = await r.json();
  /* margen de 60s: un token que vence en el medio de un pedido da un
     401 que despues cuesta entender */
  tokenDeApp = {
    valor: d.access_token,
    vence: Date.now() + ((d.expires_in ?? 3600) * 1000) - 60_000,
  };
  return tokenDeApp.valor;
}

/* ------------------------------------------------------------ pedidos

   Un solo lugar donde se arma el pedido a la API. Los errores llevan
   el status y un recorte del cuerpo, NUNCA el token: un throw que
   imprime el Authorization termina en los logs de Railway y de ahi no
   se borra. */

async function pedir(ruta, { token, metodo = 'GET', cuerpo } = {}) {
  const t = token ?? await appToken();
  const opciones = {
    method: metodo,
    headers: {
      Authorization: `Bearer ${t}`,
      Accept: 'application/json',
    },
  };
  if (cuerpo !== undefined) {
    opciones.headers['Content-Type'] = 'application/json';
    opciones.body = JSON.stringify(cuerpo);
  }

  const r = await fetch(API + ruta, opciones);
  const txt = await r.text();
  if (!r.ok) {
    const e = new Error(`${metodo} ${ruta} -> ${r.status}: ${txt.slice(0, 300)}`);
    e.status = r.status;
    /* Kick no documenta su rate limit de envio, asi que cuando frena
       lo unico que dice cuanto esperar es este encabezado. Sin
       guardarlo aca, el que atrapa el 429 tiene que adivinar, y
       adivinar de menos es pedir otro 429. */
    const reintentar = Number(r.headers.get('retry-after'));
    if (Number.isFinite(reintentar) && reintentar > 0) e.retryAfter = reintentar;
    throw e;
  }
  return txt ? JSON.parse(txt) : null;
}

/* --------------------------------------------------------- OAuth PKCE

   PKCE (S256) ata el canje del codigo a quien lo empezo: aunque
   alguien intercepte el `code` del callback, sin el `code_verifier`
   que quedo de este lado no lo puede canjear.

   Kick ademas pide client_secret en el canje, asi que el flujo NO se
   puede hacer desde el navegador: siempre pasa por el servidor. */

const VENTANA_LOGIN = 10 * 60 * 1000;   // lo que dura un login a medias

/* state -> { verificador, redirect, destino, vence }.

   En memoria y no en el almacen a proposito: es un dato que vive
   segundos, se usa una sola vez, y perderlo en un deploy solo cuesta
   que la persona toque "entrar" de nuevo. Guardarlo en Mongo seria
   ensuciar la base con basura que se vence sola. */
const pendientes = new Map();

/* Tope duro del Map. La purga por vencimiento corre recien cuando
   alguien empieza OTRO login: si nadie mas entra, lo pendiente se
   queda ahi, y mil pedidos a /oauth/kick/entrar hacen crecer el Map
   sin que nada lo limpie. Mil logins a medio empezar es mas de lo que
   este servicio va a ver nunca; pasado eso se sueltan los mas viejos
   (Map conserva el orden de insercion). */
const TOPE_PENDIENTES = 1000;

/* A donde mandar a la persona despues del login. Se acepta SOLO una
   ruta de este mismo sitio: tiene que empezar con una barra y no con
   dos, porque `//otro.com` es una URL absoluta disfrazada y seria un
   redirect abierto servido por nosotros. */
const destinoSeguro = d =>
  typeof d === 'string' && /^\/[^/\\]/.test(d) ? d : '';

/**
 * Arma la URL de autorizacion y se acuerda del verificador.
 *
 * `terminos` es la version del texto de /terminos que la persona
 * acepto antes de empezar. Viaja EN EL SERVIDOR, adentro de este Map,
 * y no en la URL del callback: asi el que vuelve no puede inventarse
 * una aceptacion que nunca hubo cambiando un parametro, y la fecha que
 * queda guardada es la del flujo de verdad.
 *
 * @param {{redirect:string, rol?:string, destino?:string, terminos?:string}} opciones
 * @returns {{url:string, estado:string}}
 */
export function urlLogin({ redirect, rol = 'espectador', destino = '', terminos = '' }) {
  if (!hayCredenciales()) throw new Error('faltan KICK_CLIENT_ID / KICK_CLIENT_SECRET');

  const ahora = Date.now();
  for (const [k, v] of pendientes) if (v.vence < ahora) pendientes.delete(k);
  while (pendientes.size >= TOPE_PENDIENTES) pendientes.delete(pendientes.keys().next().value);

  const estado = crypto.randomBytes(16).toString('base64url');
  const verificador = crypto.randomBytes(32).toString('base64url');
  const desafio = crypto.createHash('sha256').update(verificador).digest('base64url');

  pendientes.set(estado, {
    verificador,
    redirect,
    rol: SCOPES[rol] ? rol : 'espectador',
    destino: destinoSeguro(destino),
    /* Recortada: es una version, no un texto. */
    terminos: String(terminos ?? '').slice(0, 16),
    vence: ahora + VENTANA_LOGIN,
  });

  const p = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: redirect,
    scope: scopesComoTexto(SCOPES[rol] ?? SCOPES.espectador),
    state: estado,
    code_challenge: desafio,
    code_challenge_method: 'S256',
  });
  return { url: `${ID}/oauth/authorize?${p}`, estado };
}

export const hayLoginPendiente = estado => pendientes.has(estado);

/**
 * Canjea el code por tokens. Consume el state: un codigo se canjea una
 * sola vez.
 * @returns {{accessToken:string, refreshToken:string, venceEn:number, scopes:string, rol:string, destino:string}}
 */
export async function canjearCodigo({ code, estado }) {
  const p = pendientes.get(estado);
  pendientes.delete(estado);          // valga o no, un state se usa una sola vez
  if (!p) throw new Error('state desconocido o vencido: volve a empezar');
  /* El vencimiento se comprueba aca y no solo en la purga de urlLogin:
     la purga corre cuando alguien empieza otro login, asi que un state
     solo, sin nadie mas entrando, se estiraba mas alla de los 10
     minutos. La ventana tiene que valer aunque no pase nadie. */
  if (p.vence < Date.now()) throw new Error('el login se vencio: volve a empezar');

  const r = await fetch(`${ID}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: p.redirect,
      code_verifier: p.verificador,
    }),
  });
  /* el cuerpo del error no se muestra: puede traer el codigo */
  if (!r.ok) throw new Error(`Kick rechazo el canje (HTTP ${r.status})`);
  const d = await r.json();

  return {
    accessToken: d.access_token,
    refreshToken: d.refresh_token ?? '',
    venceEn: Date.now() + ((d.expires_in ?? 3600) * 1000),
    scopes: d.scope ?? '',
    rol: p.rol,
    destino: p.destino,
    terminos: p.terminos ?? '',
  };
}

/** Renueva un access token vencido a partir del refresh guardado. */
export async function refrescar(refreshToken) {
  if (!refreshToken) throw new Error('no hay refresh token');

  const r = await fetch(`${ID}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }),
  });
  if (!r.ok) {
    const e = new Error(`Kick rechazo el refresh (HTTP ${r.status})`);
    e.status = r.status;
    throw e;
  }
  const d = await r.json();
  return {
    accessToken: d.access_token,
    /* si no viene uno nuevo, sigue valiendo el viejo */
    refreshToken: d.refresh_token ?? refreshToken,
    venceEn: Date.now() + ((d.expires_in ?? 3600) * 1000),
    scopes: d.scope ?? '',
  };
}

/* ------------------------------------------------------------ usuario */

/**
 * Quien es el dueño de este token.
 *
 * Ojo: /users NO devuelve el slug del canal, aunque parezca que
 * deberia. El slug sale de /channels. Por eso `quienEs` pide los dos
 * cuando hace falta saber a que canal pertenece la persona.
 */
export async function usuarioActual(token) {
  const d = await pedir('/users', { token });
  const yo = d?.data?.[0];
  if (!yo?.user_id) throw new Error('Kick devolvio un usuario vacio');
  return {
    id: String(yo.user_id),
    nombre: yo.name ?? `usuario-${yo.user_id}`,
    avatar: yo.profile_picture ?? '',
  };
}

/**
 * Datos publicos de un canal por slug.
 *
 * `token` es opcional: sin el se usa el token de app. Se lo pasa el
 * chequeo de los cinco minutos, que ya tiene en la mano el del dueño
 * y asi no depende de que esten cargadas las credenciales de app.
 *
 * De aca sale `vivo`, que es el unico dato confiable de si el canal
 * esta transmitiendo: el webhook de estado solo avisa las
 * transiciones y se pierde en cada deploy.
 */
export async function canalPorSlug(slug = SLUG, token) {
  const d = await pedir(`/channels?slug=${encodeURIComponent(slug)}`, { token });
  const c = d?.data?.[0];
  if (!c) throw new Error(`canal no encontrado: ${slug}`);
  return {
    broadcasterUserId: String(c.broadcaster_user_id),
    slug: c.slug ?? slug,
    titulo: c.stream_title ?? '',
    categoria: c.category?.name ?? '',
    vivo: Boolean(c.stream?.is_live),
    espectadores: c.stream?.viewer_count ?? null,
  };
}

/** El canal de un broadcaster_user_id, para el camino inverso. */
export async function canalPorId(broadcasterUserId, token) {
  const d = await pedir(
    `/channels?broadcaster_user_id=${encodeURIComponent(broadcasterUserId)}`,
    { token },
  );
  const c = d?.data?.[0];
  if (!c) throw new Error(`canal no encontrado: ${broadcasterUserId}`);
  return { broadcasterUserId: String(c.broadcaster_user_id), slug: c.slug ?? '' };
}

/**
 * Quien es y a que canal pertenece, de una sola vez. Es lo que hace
 * falta para decidir si el que se logueo es el dueño (su slug es igual
 * a KICK_SLUG) o un espectador cualquiera.
 */
export async function quienEs(token) {
  const yo = await usuarioActual(token);
  let slug = '';
  try {
    slug = (await canalPorId(yo.id, token)).slug;
  } catch {
    /* Un espectador puede no tener canal, o el token puede no traer
       channel:read. No saber su slug no es un error: solo significa
       que no es el dueño. */
  }
  return { ...yo, slug };
}

/* --------------------------------------------------------------- chat */

/* Kick mide el contenido de dos formas a la vez, y hay que respetar
   las dos: 500 caracteres "como los ve una persona" (grapheme
   clusters, o sea un emoji con modificadores cuenta uno) y 2048 bytes
   en UTF-8. Contar con `texto.length` seria contar unidades UTF-16 y
   estaria mal en los dos sentidos: rechazaria mensajes buenos llenos
   de emojis y dejaria pasar otros que Kick va a rechazar. */
export const TOPE_CARACTERES = 500;
export const TOPE_BYTES = 2048;

const segmentador = new Intl.Segmenter('es', { granularity: 'grapheme' });

export function medirTexto(texto) {
  const s = String(texto);
  let caracteres = 0;
  for (const _ of segmentador.segment(s)) caracteres++;
  return { caracteres, bytes: Buffer.byteLength(s, 'utf8') };
}

/** El motivo por el que un texto no se puede mandar, o '' si se puede. */
export function porQueNoSePuedeMandar(texto) {
  const s = String(texto ?? '').trim();
  if (!s) return 'el mensaje esta vacio';
  const { caracteres, bytes } = medirTexto(s);
  if (caracteres > TOPE_CARACTERES) return `el mensaje tiene ${caracteres} caracteres y el tope es ${TOPE_CARACTERES}`;
  if (bytes > TOPE_BYTES) return `el mensaje pesa ${bytes} bytes y el tope es ${TOPE_BYTES}`;
  return '';
}

/**
 * Manda un mensaje al chat de un canal, con la cuenta del dueño del
 * token. Es el corazon de Sala: por aca sale el mensaje del espectador
 * hacia kick.com con su propio nombre.
 *
 * @param {string} token              access token del que habla
 * @param {string} broadcasterUserId  el canal donde cae el mensaje
 * @param {string} texto
 * @param {{respondeA?:string}} opciones
 */
export async function enviarMensaje(token, broadcasterUserId, texto, { respondeA } = {}) {
  const problema = porQueNoSePuedeMandar(texto);
  if (problema) throw new Error(problema);

  const cuerpo = {
    /* "user" y no "bot": con "bot" Kick ignora el broadcaster_user_id y
       manda al canal del token, y el mensaje sale como la app en vez de
       como la persona. Justo lo contrario de lo que queremos. */
    type: 'user',
    broadcaster_user_id: Number(broadcasterUserId),
    content: String(texto).trim(),
  };
  if (respondeA) cuerpo.reply_to_message_id = respondeA;

  const d = await pedir('/chat', { token, metodo: 'POST', cuerpo });
  return {
    enviado: Boolean(d?.data?.is_sent),
    mensajeId: d?.data?.message_id ?? '',
  };
}

/* ------------------------------------------------------- suscripciones

   ATENCION, ESTO SORPRENDE: la URL del webhook NO se manda por la API.

   Kick la toma de un campo de texto en el portal del desarrollador
   (Account Settings -> Developer -> "Enable Webhooks"). La API solo
   dice A QUE eventos y DE QUE canal, nunca a donde. Confirmado en
   docs.kick.com/events/introduction.

   Consecuencia practica: el codigo NO puede darse de alta su propio
   endpoint. Es un paso manual del dueño, una sola vez por app, y si no
   esta hecho las suscripciones se crean igual pero no llega ni un
   webhook. Por eso `suscribirEventos` recibe la URL: no para mandarla,
   sino para dejarla escrita en el log y poder avisar en la pagina de
   estado que hay que cargarla a mano. */

export const EVENTOS = [
  { name: 'chat.message.sent', version: 1 },
  { name: 'livestream.status.updated', version: 1 },
];

/* Canjes de puntos, subs y follows, para la lista del creador y sus
   mods. Van APARTE de EVENTOS y en otro pedido a proposito: Kick crea
   las suscripciones de un pedido todas o ninguna, y un evento de estos
   que Kick rechazara no puede llevarse puesto el chat. Los nombres y
   versiones son los que CosasStream usa en produccion desde antes. */
export const EVENTOS_ACTIVIDAD = [
  { name: 'channel.followed', version: 1 },
  { name: 'channel.subscription.new', version: 1 },
  { name: 'channel.subscription.renewal', version: 1 },
  { name: 'channel.subscription.gifts', version: 1 },
  { name: 'channel.reward.redemption.updated', version: 1 },
];

/**
 * Crea las suscripciones de actividad que falten, contra la lista que
 * quien llama ya pidio (asi la verificacion de cada cinco minutos no
 * gasta un pedido de mas). Tira si Kick rechaza: quien llama decide
 * que eso no rompa nada.
 */
export async function suscribirActividad(token, broadcasterUserId, actuales = []) {
  const yaEstan = EVENTOS_ACTIVIDAD.filter(
    e => actuales.some(s => s.event === e.name && Number(s.version) === e.version),
  ).map(e => e.name);
  const faltan = EVENTOS_ACTIVIDAD.filter(e => !yaEstan.includes(e.name));
  if (!faltan.length) return { ok: yaEstan, fallaron: [] };

  const crear = events => pedir('/events/subscriptions', {
    token,
    metodo: 'POST',
    cuerpo: { broadcaster_user_id: Number(broadcasterUserId), method: 'webhook', events },
  });

  try {
    await crear(faltan);
    console.log(`[kick] suscripto a ${faltan.length} eventos de actividad del canal ${broadcasterUserId}`);
    return { ok: [...yaEstan, ...faltan.map(e => e.name)], fallaron: [] };
  } catch (e) {
    if (faltan.length === 1) {
      return { ok: yaEstan, fallaron: [{ evento: faltan[0].name, motivo: resumirError(e) }] };
    }
  }

  /* Todas o ninguna: si Kick rechaza una (un permiso que el token no
     tiene, un evento que no habilita para este canal), el pedido junto
     se cae entero. De a una, lo que se puede queda andando y lo que no
     queda anotado con su motivo, que es lo que muestra el panel. */
  const ok = [...yaEstan];
  const fallaron = [];
  for (const e of faltan) {
    try { await crear([e]); ok.push(e.name); }
    catch (err) { fallaron.push({ evento: e.name, motivo: resumirError(err) }); }
  }
  return { ok, fallaron };
}

/* El motivo de un rechazo, corto y sin nada del pedido: el mensaje de
   `pedir` trae el cuerpo que contesto Kick, nunca el token. */
const resumirError = e => String(e?.message ?? e ?? '').replace(/\s+/g, ' ').slice(0, 160);

export async function listarSuscripciones(token, broadcasterUserId) {
  const q = broadcasterUserId
    ? `?broadcaster_user_id=${encodeURIComponent(broadcasterUserId)}`
    : '';
  return (await pedir(`/events/subscriptions${q}`, { token }))?.data ?? [];
}

/**
 * Suscribe los eventos de un canal. Idempotente del lado nuestro: se
 * fija que ya haya antes de crear.
 *
 * @param {string} token              token de USUARIO con events:subscribe
 * @param {string} broadcasterUserId
 * @param {string} urlWebhook         solo informativa, ver el bloque de arriba
 */
export async function suscribirEventos(token, broadcasterUserId, urlWebhook = '') {
  const actuales = await listarSuscripciones(token, broadcasterUserId);
  const tengo = new Set(actuales.map(s => `${s.event}@${s.version}`));
  const faltan = EVENTOS.filter(e => !tengo.has(`${e.name}@${e.version}`));

  let creadas = [];
  if (faltan.length) {
    const d = await pedir('/events/subscriptions', {
      token,
      metodo: 'POST',
      cuerpo: {
        broadcaster_user_id: Number(broadcasterUserId),
        method: 'webhook',
        events: faltan,
      },
    });
    creadas = d?.data ?? [];
    console.log(`[kick] suscripto a ${faltan.length} eventos del canal ${broadcasterUserId}`);
  }

  if (urlWebhook) {
    console.log(`[kick] recorda que la URL del webhook (${urlWebhook}) se carga a mano ` +
                `en el portal de Kick: la API no la acepta`);
  }

  return { creadas, yaEstaban: actuales.length, urlWebhook };
}

export async function borrarSuscripciones(token, ids) {
  if (!ids.length) return null;
  const q = ids.map(i => `id=${encodeURIComponent(i)}`).join('&');
  return pedir(`/events/subscriptions?${q}`, { token, metodo: 'DELETE' });
}
