/* ============================================================
   Los espectadores: la gente que entra a la Sala a ver la peli, o al
   chat abierto de un creador, y escribe con SU cuenta de Kick y/o de
   Twitch.

   Es la parte del proyecto que guarda datos de terceros, y por eso es
   la que se escribe con mas cuidado.

   ---------------------------------------------------------------
   QUE SE GUARDA, Y POR QUE TAN POCO

   Por cada red que la persona conecta: su user_id en esa red, su
   nombre para mostrar, y sus tokens CIFRADOS. Nada mas. No hay email,
   no hay IP, no hay historial de lo que escribio (lo que escribe va a
   Kick o a Twitch y vuelve por el webhook / EventSub como cualquier
   otro mensaje del chat: no lo guardamos aparte), y no hay lista de
   salas visitadas: un espectador es el mismo en todas.

   El refresh token hace falta de verdad: un access token de Kick dura
   una hora y una peli dura dos y media. Sin el, a la mitad de la
   pelicula todos dejarian de poder escribir. Va cifrado con
   AES-256-GCM, igual que el del dueño: `servidor/cifrado.js`.

   "Salir" borra los tokens de LAS DOS REDES y la sesion. No es un
   logout de mentira que solo tira la cookie.

   ---------------------------------------------------------------
   EL ID DEL ESPECTADOR NO ES EL DE NINGUNA RED

   Hasta la Fase 5.1 un espectador ERA una cuenta de Kick: el
   documento se guardaba en `tokens` bajo `espectador:<userId de
   Kick>`. Con Twitch adentro eso ya no cierra: alguien puede conectar
   solo Twitch y no tener nunca un id de Kick.

   Asi que el espectador tiene id propio (`esp_…`, al azar) y las redes
   le cuelgan. La cookie de sesion guarda ESE id.

     { id, kick:   { usuarioId, nombre, login, acceso, refresco, venceEn, scopes },
           twitch: { … }, creado, ultimoUso }

   La red que no se conecto no tiene campo.

   MIGRACION DE LOS QUE YA ESTABAN: el id viejo era el user_id de Kick
   y vive dentro de cookies que estan en navegadores ahora mismo. Por
   eso la migracion CONSERVA ESE ID: el documento viejo de `tokens` se
   convierte al modelo nuevo bajo la misma clave, y la sesion que lo
   nombra sigue sirviendo. Un espectador nuevo estrena un `esp_…`; un
   espectador viejo se queda con su numero de Kick de id, que a esta
   altura es un id opaco mas. Ver `migrarViejo`.

   ---------------------------------------------------------------
   DOS NAVEGADORES SON DOS ESPECTADORES

   Conectar Kick desde el celular y desde la compu deja DOS
   espectadores con la misma cuenta de Kick, cada uno con su sesion y
   sus tokens. Antes era uno solo, porque la clave era la cuenta de
   Kick. Se eligio asi a proposito: deduplicar pide un indice por red
   (o recorrer la coleccion en cada login) y, sobre todo, hace que
   "Salir" en el celular cierre la sesion de la compu, que no es lo que
   nadie espera de un "salir". Cada grant de OAuth es independiente en
   las dos plataformas, asi que los dos funcionan a la vez.

   Lo que si cuesta: el freno de "uno cada dos segundos" es por
   espectador, asi que la misma persona con dos navegadores tiene dos
   frenos. Encima siguen estando los limites de Kick y de Twitch, que
   son por cuenta y no por navegador.

   ---------------------------------------------------------------
   POR QUE NO SE REUSA vinculos.js

   `vinculos.js` guarda UN documento por sala y red (`istincho:kick`) y
   su API entera esta escrita alrededor de eso. Los espectadores son N,
   no son de ninguna sala, y su ciclo de vida es distinto (entran, se
   van, se los olvida). Comparten el cifrado, que es lo que de verdad
   tienen en comun.

   ---------------------------------------------------------------
   EL LIMITE DE ENVIO

   Uno cada dos segundos por persona, en memoria. En memoria y no en
   el almacen porque el limite es una defensa contra el dedo pesado y
   contra el spam de una noche, no un contrato: perderlo en un deploy
   cuesta que alguien pueda mandar dos mensajes seguidos una vez.
   Escribir en Mongo en cada mensaje del chat, en cambio, cuesta todas
   las noches.
   ============================================================ */

import crypto from 'node:crypto';

import * as almacen from './almacen.js';
import * as cifrado from './cifrado.js';
import * as colores from './colores.js';
import * as kick from './kick.js';
import * as twitch from './twitch.js';

/** Las redes que un espectador puede conectar. */
export const REDES = Object.freeze(['kick', 'twitch']);

/* El scope que hace falta para ESCRIBIR en cada red. Leer no necesita
   nada del espectador: el chat entra con el token del creador. */
export const SCOPE_PARA_ESCRIBIR = Object.freeze({
  kick: 'chat:write',
  twitch: 'user:write:chat',
});

/** Lo que espera un espectador entre dos mensajes. */
export const ESPERA_ENTRE_MENSAJES = 2000;

/* Cuanto vive un espectador que no vuelve. Guardar el refresh token de
   alguien que no usa el servicio hace dos meses es riesgo sin
   beneficio: si vuelve, conecta de nuevo y son dos clicks.

   Se poda al arrancar, que para este servicio pasa seguido (cada deploy
   es un arranque). No hace falta un reloj propio para algo que se mide
   en meses. */
export const VENCE_EN = 60 * 24 * 60 * 60 * 1000;

/* Cada cuanto se anota que esta persona sigue viniendo. Escribir en
   Mongo en cada mensaje del chat, para mover un numero que se compara
   contra sesenta dias, es castigar a la base al pedo. */
const REFRESCAR_USO = 6 * 60 * 60 * 1000;

/* Margen antes del vencimiento para considerar que un access token ya
   no sirve: un token que vence en medio del pedido da un 401 que
   despues cuesta entender. */
const MARGEN = 60_000;

/* El id viejo (el user_id de Kick) era numerico; el nuevo empieza con
   `esp_`. Los dos entran en esta forma, que es la que puede viajar en
   una cookie y en una clave del almacen sin escapar nada. */
const valido = id => /^[0-9a-zA-Z_-]{1,64}$/.test(String(id ?? ''));

const redValida = red => REDES.includes(red);

/** Un id de espectador nuevo. No sale de ninguna cuenta: es al azar. */
export const nuevoId = () => `esp_${crypto.randomBytes(16).toString('base64url')}`;

/* Donde vivia el modelo viejo, y donde sigue viviendo hasta que
   alguien con esa sesion vuelva. Ver `migrarViejo`. */
const claveVieja = id => `espectador:${id}`;

/* --------------------------------------------------------- guardar */

const texto = (v, tope = 80) => String(v ?? '').slice(0, tope);

/** Una red de un documento, lista para guardar. */
function redParaGuardar({ usuarioId, nombre, login, accessToken, refreshToken, venceEn, scopes }) {
  return {
    usuarioId: String(usuarioId ?? ''),
    nombre: texto(nombre),
    login: texto(login),
    acceso: cifrado.cifrar(String(accessToken ?? '')),
    refresco: refreshToken ? cifrado.cifrar(String(refreshToken)) : '',
    venceEn: Number(venceEn ?? 0),
    /* Los scopes se guardan para poder decir POR QUE algo no anda
       ("este permiso no incluye escribir") en vez de dejar que la
       persona escriba un mensaje largo y se coma un 401. */
    scopes: Array.isArray(scopes) ? scopes.join(' ') : String(scopes ?? ''),
    desde: Date.now(),
  };
}

/**
 * Conecta (o vuelve a conectar) UNA red a un espectador. Lo crea si no
 * existia; lo que ya tenia en la otra red no se toca.
 *
 * Sin CLAVE_CIFRADO no se guarda NADA: es preferible que la persona no
 * pueda escribir a que su refresh token quede en claro en una base.
 */
export async function conectar(id, red, datos) {
  if (!valido(id)) throw new Error('espectador invalido');
  if (!redValida(red)) throw new Error(`red desconocida: ${red}`);
  if (!cifrado.hayClave()) {
    throw new Error(`no se puede guardar el vinculo sin CLAVE_CIFRADO (${cifrado.porQueNoHayClave()})`);
  }

  /* En cola: conectar es leer-cambiar-guardar, y dos a la vez sobre el
     mismo espectador se pisan. Pasa de verdad cuando alguien manda "a
     las dos" con los dos tokens vencidos: los dos refrescos guardan al
     mismo tiempo y uno de los dos tokens nuevos se pierde (y el viejo
     ya no sirve, porque las dos plataformas rotan el refresh token). */
  return almacen.enCola('espectadores', id, async () => {
    const viejo = await documento(id);
    const nuevo = {
      ...(viejo ?? {}),
      id: String(id),
      [red]: redParaGuardar(datos),
      creado: Number(viejo?.creado ?? Date.now()),
      ultimoUso: Date.now(),
    };
    await almacen.poner('espectadores', id, nuevo);
    /* Recien conectada, esta red todavia no estaba en el indice de
       colores: quien eligio su color con Kick y hoy suma Twitch tiene
       que salir con el mismo color en las dos. */
    colores.anotar(nuevo);
  });
}

/* --------------------------------------------------------- leer */

/**
 * El documento crudo (tokens cifrados), migrando el modelo viejo si
 * hace falta. `null` si no hay.
 */
async function documento(id) {
  if (!valido(id)) return null;
  const doc = await almacen.obtener('espectadores', id);
  if (doc) return doc;
  return migrarViejo(id);
}

/**
 * El espectador de antes de la Fase 5.3, convertido al modelo nuevo.
 *
 * Vivia en `tokens` bajo `espectador:<user_id de Kick>` y era un
 * documento plano con una sola red. Se convierte CONSERVANDO LA CLAVE,
 * que es lo que hace que la cookie que alguien tiene abierta ahora
 * mismo siga sirviendo, y se borra el viejo para no dejar dos copias
 * del mismo refresh token dando vueltas.
 *
 * Los tokens NO se vuelven a cifrar: ya estan cifrados con la misma
 * clave y descifrarlos aca seria pasearlos en claro por la memoria sin
 * necesidad.
 *
 * El `tipo` se comprueba de verdad: en `tokens` tambien viven los
 * vinculos de los creadores (`<slug>:<red>`), y un creador con el slug
 * "espectador" tendria documentos con nombres que se parecen.
 */
async function migrarViejo(id) {
  const viejo = await almacen.obtener('tokens', claveVieja(id));
  if (!viejo || viejo.tipo !== 'espectador') return null;

  const nuevo = {
    id: String(id),
    kick: {
      usuarioId: String(viejo.usuarioId ?? id),
      nombre: texto(viejo.nombre),
      login: '',
      acceso: viejo.acceso ?? '',
      refresco: viejo.refresco ?? '',
      venceEn: Number(viejo.venceEn ?? 0),
      scopes: String(viejo.scopes ?? ''),
      desde: Number(viejo.entro ?? Date.now()),
    },
    creado: Number(viejo.entro ?? Date.now()),
    ultimoUso: Date.now(),
  };

  await almacen.poner('espectadores', id, nuevo);
  await almacen.quitar('tokens', claveVieja(id));
  console.log(`[espectadores] se migro un espectador del modelo viejo (solo Kick)`);
  return nuevo;
}

function descifrarRed(r) {
  if (!r) return null;
  return {
    usuarioId: String(r.usuarioId ?? ''),
    nombre: r.nombre ?? '',
    login: r.login ?? '',
    accessToken: r.acceso ? cifrado.descifrar(r.acceso) : '',
    refreshToken: r.refresco ? cifrado.descifrar(r.refresco) : '',
    venceEn: Number(r.venceEn ?? 0),
    scopes: r.scopes ?? '',
  };
}

/**
 * El espectador con sus tokens descifrados, o null.
 *
 * `{ id, kick?, twitch?, creado, ultimoUso }`. La red que no conecto
 * no esta.
 *
 * De paso anota que esta persona sigue viniendo, como mucho una vez
 * cada seis horas y sin esperar a que la escritura termine: es para el
 * vencimiento de sesenta dias, y a nadie le importa si tarda.
 */
export async function leer(id) {
  const doc = await documento(id);
  if (!doc || !cifrado.hayClave()) return null;
  await tocar(doc.id ?? String(id), Number(doc.ultimoUso ?? 0));

  try {
    const v = {
      id: doc.id ?? String(id),
      creado: doc.creado ?? 0,
      ultimoUso: doc.ultimoUso ?? 0,
      /* El color propio no es un secreto ni esta cifrado: sale tal
         cual para que `/api/chat/:slug/yo` se lo pueda mostrar a su
         dueño en el selector. */
      color: colores.limpiar(doc.color),
    };
    for (const red of REDES) {
      const r = descifrarRed(doc[red]);
      if (r) v[red] = r;
    }
    /* Un documento sin ninguna red no es nadie: paso a ser basura
       cuando se desconecto la ultima. */
    return REDES.some(red => v[red]) ? v : null;
  } catch (e) {
    /* e.name y no e.message: la regla de la casa es no confiar en que
       el error de descifrado no traiga nada delicado. */
    console.warn(`[espectadores] no se pudo descifrar un vinculo (${e.name}): hay que volver a entrar`);
    return null;
  }
}

/*
 * Deja anotado que este espectador se uso, como mucho una vez cada
 * REFRESCAR_USO.
 *
 * SE ESPERA, aunque a nadie le importe cuando se guarda, y eso es lo
 * unico delicado de esta funcion. Escribe el documento ENTERO (el
 * almacen no sabe actualizar un campo suelto), asi que una escritura
 * suelta volando podria aterrizar despues de un `conectar` y devolver
 * el documento a como estaba, borrando la red que se acababa de
 * conectar. Justo el caso de quien vuelve despues de una semana a
 * sumar Twitch: hace mas de seis horas que no viene, asi que esta
 * escritura se dispara.
 *
 * Esperarla cuesta una escritura cada seis horas por persona.
 *
 * ---------------------------------------------------------------
 * Y POR ESO SE VUELVE A LEER ADENTRO DE LA COLA
 *
 * La cola sola no alcanzaba. Recibia el documento que `leer` habia
 * leido AFUERA, asi que serializaba la escritura pero guardaba una foto
 * vieja: con `leer` y `conectar` corriendo a la vez, la red recien
 * conectada se perdia 20 de 20 veces (medido). `conectar` y
 * `desconectar` ya releian adentro; esta era la unica que no.
 *
 * El id y la fecha entran como datos sueltos justamente para que no
 * quede ninguna tentacion de escribir la foto de afuera.
 */
async function tocar(id, ultimoUso) {
  if (Date.now() - ultimoUso < REFRESCAR_USO) return;
  try {
    await almacen.enCola('espectadores', id, async () => {
      const fresco = await documento(id);
      /* Se fue mientras tanto (salio, o se le desconecto la ultima
         red): anotarle el uso lo resucitaria a medias. */
      if (!fresco) return;
      /* Otro ya lo anoto mientras esperaba el turno. */
      if (Date.now() - Number(fresco.ultimoUso ?? 0) < REFRESCAR_USO) return;
      await almacen.poner('espectadores', id, { ...fresco, ultimoUso: Date.now() });
    });
  } catch (e) {
    /* Que no se pueda anotar el ultimo uso no es motivo para que la
       persona no pueda escribir. */
    console.warn('[espectadores] no se pudo anotar el ultimo uso:', e.name);
  }
}

/** Las redes que esta persona tiene conectadas, en el orden de siempre. */
export const redesDe = v => REDES.filter(red => Boolean(v?.[red]));

/** Si el permiso que dio en esa red alcanza para escribir. */
export const puedeEscribirEn = (v, red) =>
  String(v?.[red]?.scopes ?? '').split(/\s+/).includes(SCOPE_PARA_ESCRIBIR[red]);

/* ----------------------------------------------------- el color

   El color con el que se pinta su nombre EN ESTA PLATAFORMA. Vive en
   la ficha del espectador y no en la de ninguna sala, porque es de la
   persona: lo elige una vez y le sirve en el chat de cualquier
   creador. Por que se guarda asi y como se reparte esta contado en
   `servidor/colores.js`.

   No va cifrado: no es un secreto, y cifrarlo lo dejaria fuera del
   alcance del indice en memoria, que es lo que hace que pintar un
   mensaje no cueste un pedido. */

/**
 * Guarda (o borra, con '') el color propio de un espectador.
 *
 * Devuelve el color que quedo, o null si ese espectador no existe.
 * `colorDesde` es lo que desempata cuando la misma cuenta tiene dos
 * espectadores con colores distintos: gana el ultimo elegido.
 */
export async function ponerColor(id, color) {
  if (!valido(id)) return null;
  const limpio = colores.limpiar(color);
  /* Un color que no es un color NO devuelve null: TIRA. `null` de esta
     funcion quiere decir una sola cosa —"ese espectador no existe"— y
     la ruta lo usa para cerrarle la sesion a quien quedo sin ficha. Si
     ademas quisiera decir "eso no es un color", un color mal escrito
     desloguearia a la persona. Hoy no llega ninguno (la ruta valida
     antes, con la misma funcion), asi que si llega, es un bug nuestro
     y tiene que hacer ruido. */
  if (!limpio && String(color ?? '') !== '') {
    throw new Error('ese color no es un #rrggbb');
  }

  /* En cola, como todo lo que es leer-cambiar-guardar sobre el mismo
     documento: si no, elegir un color mientras se refresca un token
     pisa el token nuevo. */
  return almacen.enCola('espectadores', id, async () => {
    const doc = await documento(id);
    if (!doc) {
      /* Sin ficha no hay color que guardar, y tampoco tiene que quedar
         uno pintando: si el indice tenia algo de este espectador, era
         de una ficha que ya no esta. */
      colores.olvidar(id);
      return null;
    }
    const nuevo = { ...doc, ultimoUso: Date.now() };
    if (limpio) {
      nuevo.color = limpio;
      nuevo.colorDesde = Date.now();
    } else {
      delete nuevo.color;
      delete nuevo.colorDesde;
    }
    await almacen.poner('espectadores', id, nuevo);
    colores.anotar(nuevo);
    return limpio;
  });
}

/**
 * Le saca el color propio a UNA CUENTA de una red: es lo que toca el
 * creador cuando alguien se pasa de vivo. Devuelve a cuantos
 * espectadores se les borro.
 *
 * Se limpian TODOS los espectadores de esa cuenta y no solo el que
 * estaba pintando: la misma persona puede tener dos (el celular y la
 * compu, ver arriba), y borrar uno solo haria que el color volviera
 * en el proximo arranque.
 *
 * VALE EN TODAS LAS SALAS, igual que el color: es la ficha de la
 * persona lo que se toca, no la del creador. Esta anotado en el README
 * porque es la consecuencia de que el color sea uno solo.
 */
export async function quitarColorDe(red, usuarioId) {
  if (!redValida(red)) return 0;
  let cuantos = 0;
  for (const id of colores.espectadoresCon(red, usuarioId)) {
    const quedo = await ponerColor(id, '');
    if (quedo !== null) cuantos++;
  }
  return cuantos;
}

/**
 * Llena el indice de colores con lo que hay guardado. Se llama al
 * arrancar y devuelve cuantas cuentas quedaron con color.
 *
 * Al arrancar y no cuando la persona entra: quien eligio su color hace
 * un mes y hoy escribe desde kick.com sin abrir esta pagina tiene que
 * salir con su color igual.
 */
export async function cargarColores() {
  for (const doc of await almacen.listar('espectadores')) {
    if (doc?.color) colores.anotar(doc);
  }
  return colores.cuantos();
}

/* ------------------------------------------------------- olvidar */

/**
 * Borra el espectador entero: las dos redes y sus tokens.
 *
 * VA EN LA COLA, como todo lo que escribe sobre el mismo documento, y
 * eso es del 2026-09-25: antes era el unico que no, con el argumento
 * de que "un borrado no es un leer-cambiar-guardar". El argumento
 * miraba este borrado solo, y el problema no era este borrado: era
 * este borrado CONTRA los otros.
 *
 * Lo que pasaba, reproducido: alguien manda un mensaje con el token
 * casi vencido —eso dispara un refresh, o sea `conectar`, que si esta
 * encolado y lee el documento— y toca "Salir" en el medio. El borrado
 * se colaba entre el `await documento(id)` de la otra tarea y su
 * `almacen.poner`, asi que el documento volvia A ESCRIBIRSE DESPUES DE
 * BORRADO, con el refresh token cifrado adentro: un "salir" que no
 * borra los tokens. Y en el indice de colores quedaba un color
 * fantasma, sin ficha detras, que seguia pintando a esa cuenta en
 * todas las salas y que ni el creador podia sacar (`quitarColorDe`
 * busca el documento, no lo encuentra y no toca el indice).
 *
 * Adentro de la cola las dos tareas se ordenan y cualquiera de los dos
 * ordenes deja algo coherente: o se borra y despues se reescribe
 * entero (y el proximo "salir" lo borra), o se reescribe y despues se
 * borra, que es lo que la persona pidio.
 */
export async function olvidar(id) {
  if (!valido(id)) return false;
  return almacen.enCola('espectadores', id, () => olvidarYa(id));
}

/**
 * El borrado en si, SIN la cola: lo llama `olvidar` desde adentro de
 * la cola, y `desconectar` desde adentro de la suya (encolarlo ahi
 * seria esperarse a si mismo, que es un cuelgue y no un error).
 */
async function olvidarYa(id) {
  limpiarLimite(id);
  /* Su color se va con el: el indice no puede quedar pintando a
     alguien que ya no tiene ficha. */
  colores.olvidar(id);
  /* Se borran los dos: el del modelo nuevo y, por si nunca se llego a
     migrar, el viejo. Un "salir" que deja un refresh token atras no es
     un salir. */
  const nuevo = await almacen.quitar('espectadores', id);
  const viejo = await almacen.quitar('tokens', claveVieja(id));
  return Boolean(nuevo || viejo);
}

/**
 * Saca UNA red y deja la otra. Si no queda ninguna, el espectador se
 * borra entero: un documento sin redes no sirve para nada y guardar la
 * cascara tampoco.
 */
export async function desconectar(id, red) {
  if (!valido(id) || !redValida(red)) return false;
  /* En cola, por lo mismo que `conectar`: con "las dos" caidas a la
     vez, las dos desconexiones corren juntas. Adentro se llama a
     `olvidarYa` y no a `olvidar`, que ahora tambien encola: llamar al
     encolado desde adentro de la cola seria esperarse a si mismo. */
  return almacen.enCola('espectadores', id, async () => {
    const doc = await documento(id);
    if (!doc?.[red]) return false;

    const quedan = REDES.filter(r => r !== red && doc[r]);
    if (!quedan.length) return olvidarYa(id);

    const nuevo = { ...doc, ultimoUso: Date.now() };
    delete nuevo[red];
    await almacen.poner('espectadores', id, nuevo);
    /* La red que se fue deja de pintar: su color seguia en el indice
       bajo un id de una cuenta que esta persona ya no tiene conectada. */
    colores.anotar(nuevo);
    return true;
  });
}

/* ---------------------------------------------------------- acceso */

/* `<id>:<red>` -> promesa del refresh en curso. Dos mensajes seguidos
   de la misma persona con el token recien vencido saldrian a refrescar
   los dos: las dos plataformas rotan el refresh token, asi que el
   segundo usaria uno que el primero ya quemo. */
const refrescando = new Map();

/**
 * Un access token usable de este espectador en una red, refrescando si
 * hace falta. Devuelve null si no tiene esa red conectada o si el
 * refresh ya no sirve (ahi la persona tiene que volver a conectarla).
 */
export async function acceso(id, red = 'kick') {
  if (!redValida(red)) return null;
  const v = await leer(id);
  const suya = v?.[red];
  if (!suya) return null;
  if (suya.accessToken && Date.now() + MARGEN < suya.venceEn) return suya.accessToken;
  if (!suya.refreshToken) return null;

  const clave = `${id}:${red}`;
  if (!refrescando.has(clave)) {
    refrescando.set(clave, refrescar(id, red, suya).finally(() => refrescando.delete(clave)));
  }
  return refrescando.get(clave);
}

async function refrescar(id, red, viejo) {
  let nuevo;
  try {
    nuevo = red === 'twitch'
      ? await twitch.refrescar(viejo.refreshToken)
      : await kick.refrescar(viejo.refreshToken);
  } catch (e) {
    /* Un refresh rechazado es la persona que revoco el permiso desde
       la plataforma, o un token que caduco del todo. Se desconecta esa
       red: dejarla seria reintentar en cada mensaje que escriba. La
       OTRA red no tiene la culpa y se queda. */
    console.warn(`[espectadores] el refresh de ${red} fallo, se desconecta esa red:`, e.status ?? e.name);
    await desconectar(id, red);
    return null;
  }
  await conectar(id, red, {
    usuarioId: viejo.usuarioId,
    nombre: viejo.nombre,
    login: viejo.login,
    accessToken: nuevo.accessToken,
    refreshToken: nuevo.refreshToken,
    venceEn: nuevo.venceEn,
    scopes: nuevo.scopes,
  });
  return nuevo.accessToken;
}

/* ---------------------------------------------------------- limite */

const ultimoEnvio = new Map();    // id de espectador -> ms del ultimo mensaje

/* Tope del Map: una noche con mucha gente lo llena y nadie lo vacia.
   Se sueltan los mas viejos (Map conserva el orden de insercion). */
const TOPE_RECORDADOS = 5000;

/**
 * Cuantos ms le faltan a esta persona para poder mandar otro mensaje.
 * 0 si puede ahora.
 *
 * Es por PERSONA y no por red: mandar "a las dos" cuenta como uno.
 */
export function esperaQueLeFalta(id, ahora = Date.now()) {
  const ultimo = ultimoEnvio.get(String(id));
  if (!ultimo) return 0;
  return Math.max(0, ultimo + ESPERA_ENTRE_MENSAJES - ahora);
}

/** Anota que esta persona acaba de mandar. */
export function anotarEnvio(id, ahora = Date.now()) {
  const clave = String(id);
  ultimoEnvio.delete(clave);          // que vuelva al final del orden
  ultimoEnvio.set(clave, ahora);
  while (ultimoEnvio.size > TOPE_RECORDADOS) {
    ultimoEnvio.delete(ultimoEnvio.keys().next().value);
  }
}

export function limpiarLimite(id) {
  if (id === undefined) ultimoEnvio.clear();
  else ultimoEnvio.delete(String(id));
}

/* ------------------------------------------------- la espera del 429

   Kick no documenta su rate limit de envio. Cuando contesta 429, el
   429 es del CANAL, no de la persona: seguir mandando el resto de los
   mensajes de esa noche solo consigue mas 429. Se para todo el canal
   por lo que diga Retry-After (y unos segundos si no lo dice).

   Es de Kick y solo de Kick, a proposito. El limite de Twitch para
   escribir es por CUENTA (20 mensajes cada 30 s para quien no es mod),
   no por canal: frenar el canal entero porque a una persona la frenaron
   callaria a todos los demas sin motivo. */

const esperaDelCanal = new Map();   // slug -> ms epoch hasta cuando esperar

export const ESPERA_429_POR_DEFECTO = 5000;
const TOPE_ESPERA_429 = 60_000;

export function anotar429(slug, retryAfter, ahora = Date.now()) {
  const segundos = Number(retryAfter);
  const espera = Number.isFinite(segundos) && segundos > 0
    ? Math.min(segundos * 1000, TOPE_ESPERA_429)
    : ESPERA_429_POR_DEFECTO;
  esperaDelCanal.set(String(slug).toLowerCase(), ahora + espera);
  return espera;
}

/** Ms que le faltan al canal entero para poder volver a mandar. */
export function esperaDelCanalQueFalta(slug, ahora = Date.now()) {
  const hasta = esperaDelCanal.get(String(slug).toLowerCase());
  if (!hasta) return 0;
  if (hasta <= ahora) { esperaDelCanal.delete(String(slug).toLowerCase()); return 0; }
  return hasta - ahora;
}

/* ----------------------------------------------- el vencimiento

   Un espectador que no vuelve en sesenta dias pierde sus tokens solo.
   Se barren los dos modelos: el nuevo y el viejo (`tokens`), porque un
   documento viejo cuya sesion ya vencio no lo migra nadie —la
   migracion corre al leerlo, y a ese no lo lee mas nadie— y se quedaria
   ahi para siempre. */

/**
 * Borra los espectadores que no vuelven hace `VENCE_EN`. Devuelve
 * cuantos se fueron. Se llama al arrancar.
 */
export async function podar(ahora = Date.now()) {
  let cuantos = 0;

  for (const doc of await almacen.listar('espectadores')) {
    const ultimo = Number(doc.ultimoUso ?? doc.creado ?? 0);
    if (ultimo + VENCE_EN >= ahora) continue;
    await almacen.quitar('espectadores', doc.id);
    limpiarLimite(doc.id);
    colores.olvidar(doc.id);
    cuantos++;
  }

  /* Los del modelo viejo, que nunca se migraron. `entro` era su unica
     marca de tiempo. */
  for (const doc of await almacen.listar('tokens')) {
    if (doc?.tipo !== 'espectador') continue;
    if (Number(doc.entro ?? 0) + VENCE_EN >= ahora) continue;
    await almacen.quitar('tokens', doc.id);
    cuantos++;
  }

  return cuantos;
}

/** Solo para los tests. */
export function reiniciar() {
  ultimoEnvio.clear();
  esperaDelCanal.clear();
  refrescando.clear();
  colores.reiniciar();
}
