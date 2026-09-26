/* ============================================================
   El color propio de cada persona: el que elige EN ESTA PLATAFORMA y
   con el que se pinta su nombre en `/chat/<slug>`, en la ventana del
   creador y en la Sala.

   En kick.com y en twitch.tv sigue saliendo con el color que le da
   cada plataforma: ese no lo controlamos. Lo dice la pagina donde se
   elige, con todas las letras.

   ---------------------------------------------------------------
   POR QUE EL COLOR VIAJA EN EL MENSAJE Y NO LO RESUELVE LA PAGINA

   Las dos opciones estaban sobre la mesa. Gana el servidor por tres
   motivos:

     1. La pagina no tiene de donde sacarlo. Resolverlo alla significa
        pedir "¿que color tiene esta persona?" por cada nombre que
        aparece, o bajarse la tabla entera de colores de todo el
        mundo. Lo primero es un pedido por mensaje; lo segundo es
        repartir una lista de datos de terceros a cualquiera que abra
        el chat.
     2. El mensaje YA viaja con todo resuelto: la url de cada emote y
        la de cada insignia las completa el servidor
        (`emotes.resolver`, `insignias.resolver`). El color es lo
        mismo y entra por la misma puerta, al lado de las otras dos.
     3. Hay una sola pantalla que no es nuestra: ninguna. Todas las
        paginas que muestran chat usan `paginas/comun/mensajes.js`, y
        asi el color aparece en las tres sin tocar ninguna.

   Lo que NO hace el servidor es corregir el contraste: eso depende
   del tema (claro u oscuro) de quien esta mirando, que el servidor no
   sabe. Manda el color elegido, tal cual, y la pagina lo ajusta al
   fondo que tenga puesto. Ver `coloresDeUsuario` en comun/mensajes.js.

   ---------------------------------------------------------------
   POR QUE HAY UN INDICE EN MEMORIA

   `pintar()` corre en CADA mensaje de las dos redes, adentro del
   webhook de Kick y del EventSub de Twitch. Un `await` a Mongo por
   mensaje no existe, igual que no existe en el filtro del bus
   (`creadores.chatAbiertoSabido`). Asi que el color vive en un Map
   que se llena al arrancar (`espectadores.cargarColores`) y lo
   mantienen al dia las escrituras.

   Se llena AL ARRANCAR y no cuando la persona entra: alguien que
   eligio su color hace un mes y hoy escribe desde kick.com sin abrir
   esta pagina tiene que salir con su color igual. Su mensaje llega por
   el webhook y no pasa por ninguna sesion nuestra.

   Con una sola instancia en Railway la memoria no se desincroniza; el
   dia que haya dos, esto viaja junto con el Map de `creadores`.

   ---------------------------------------------------------------
   LA CLAVE ES (RED, ID DE ESA RED), NO EL ESPECTADOR

   Porque lo que llega es un mensaje de Kick o de Twitch, que trae el
   id de la persona EN ESA RED y nada mas. El espectador —nuestro
   `esp_…`— no aparece por ningun lado en un mensaje.

   Y por eso una misma clave puede tener VARIOS espectadores colgando:
   conectar Kick desde el celular y desde la compu deja dos
   espectadores con la misma cuenta (esta explicado en espectadores.js)
   y cada uno guarda su color. Gana el ULTIMO que se eligio, por
   `colorDesde`, que se guarda en el documento: asi el desempate da lo
   mismo despues de un reinicio, donde el orden en que se cargan los
   documentos no significa nada.

   Que la clave tenga la lista de espectadores tampoco es adorno: es
   lo que hace que el reseteo del creador limpie LOS DOS documentos. Si
   limpiara solo el que gana, el color del otro volveria solo en el
   proximo arranque.
   ============================================================ */

/* Un color de chat termina en un `style` del lado del cliente. Se
   acepta EXACTAMENTE `#rrggbb` y nada mas: ni `red`, ni `rgb(...)`,
   ni `#abc`, ni espacios. No es una lista de cosas prohibidas —esas
   siempre tienen un agujero—, es una forma unica y corta. Cualquier
   otra cosa no es un color: es un intento. */
const COLOR_VALIDO = /^#[0-9a-f]{6}$/i;

/**
 * El color, normalizado a minuscula, o '' si lo que llego no es un
 * color. `''` es tambien lo que se manda para BORRAR el propio y
 * volver al de la plataforma.
 */
export function limpiar(color) {
  const s = String(color ?? '').trim();
  return COLOR_VALIDO.test(s) ? s.toLowerCase() : '';
}

/**
 * Si esto es un color guardable, o el vacio, que es "sacarmelo".
 *
 * Tiene que ser un STRING: un `null`, un numero o la clave ausente no
 * son "sacamelo", son un pedido mal escrito. Tratarlos como el vacio
 * haria que una pagina con un bug le borre el color a alguien sin que
 * nadie lo haya pedido.
 */
export const esColorOVacio = color =>
  typeof color === 'string' && (color === '' || Boolean(limpiar(color)));

export const clave = (red, usuarioId) => `${red}:${String(usuarioId ?? '')}`;

/* clave -> { color, desde, porEspectador: Map<id, {color, desde}> } */
const porUsuario = new Map();

/* id de espectador -> Set de claves que toca. Sin esto, olvidar a
   alguien seria recorrer el indice entero. */
const porEspectador = new Map();

/** Recalcula quien gana en una clave: el color elegido mas tarde. */
function recalcular(k) {
  const entrada = porUsuario.get(k);
  if (!entrada) return;
  let gana = null;
  for (const v of entrada.porEspectador.values()) {
    if (!gana || v.desde >= gana.desde) gana = v;
  }
  if (!gana) { porUsuario.delete(k); return; }
  entrada.color = gana.color;
  entrada.desde = gana.desde;
}

function sacarDeClave(k, id) {
  const entrada = porUsuario.get(k);
  if (!entrada) return;
  entrada.porEspectador.delete(id);
  recalcular(k);
}

/**
 * Anota (o borra) lo que dice el documento de UN espectador.
 *
 * Es idempotente y siempre parte de cero para ese espectador: se le
 * sacan todas las claves que tenia y se le ponen las que tiene ahora.
 * Asi una red que se desconecto deja de pintar sin que nadie se
 * acuerde de sacarla a mano.
 *
 * @param {object} doc  el documento crudo de `espectadores`
 */
export function anotar(doc) {
  const id = String(doc?.id ?? '');
  if (!id) return;

  for (const k of porEspectador.get(id) ?? []) sacarDeClave(k, id);
  porEspectador.delete(id);

  const color = limpiar(doc?.color);
  if (!color) return;
  const desde = Number(doc?.colorDesde) || 0;

  const claves = new Set();
  for (const red of ['kick', 'twitch']) {
    const usuarioId = String(doc?.[red]?.usuarioId ?? '');
    if (!usuarioId) continue;
    const k = clave(red, usuarioId);
    claves.add(k);
    if (!porUsuario.has(k)) porUsuario.set(k, { color, desde, porEspectador: new Map() });
    porUsuario.get(k).porEspectador.set(id, { color, desde });
    recalcular(k);
  }
  if (claves.size) porEspectador.set(id, claves);
}

/** Saca del indice todo lo de un espectador (salio, o se lo podo). */
export function olvidar(id) {
  const clavesDe = porEspectador.get(String(id));
  if (!clavesDe) return;
  for (const k of clavesDe) sacarDeClave(k, String(id));
  porEspectador.delete(String(id));
}

/** El color propio de quien escribio, o '' si no eligio ninguno. */
export function deUsuario(red, usuarioId) {
  const entrada = porUsuario.get(clave(red, usuarioId));
  return entrada?.color ?? '';
}

/**
 * Los espectadores que tienen color guardado para esta cuenta. Son
 * varios cuando la misma persona conecto desde dos navegadores.
 */
export function espectadoresCon(red, usuarioId) {
  const entrada = porUsuario.get(clave(red, usuarioId));
  return entrada ? [...entrada.porEspectador.keys()] : [];
}

/** Cuantas cuentas tienen hoy un color propio. Para el log del arranque. */
export const cuantos = () => porUsuario.size;

/**
 * Le pone al mensaje el color propio de quien escribio, si eligio uno.
 *
 * El mensaje se toca EN EL LUGAR, como hacen `emotes.resolver` y
 * `insignias.resolver`, y se devuelve el mismo objeto.
 *
 * `colorPropio` sale SOLO cuando el color es el que eligio la persona.
 * No es "una clave que esta en algunos y en otros no" de las que este
 * proyecto evita: nadie recorre una lista de mensajes preguntandose si
 * cada uno la tiene. Es una respuesta a una sola pregunta —"¿este
 * color es de la persona o de la plataforma?"— que la pagina lee como
 * booleano, y la ausencia es el 'no'. Con ella, el creador ve el boton
 * de resetear exactamente en los mensajes donde significa algo.
 *
 * NO PUEDE TIRAR NUNCA: corre adentro de `recibirDeKick`, despues de
 * que el evento quedo marcado como visto. Una excepcion aca no seria
 * un color que falta, seria el mensaje perdido y un 500 en el webhook.
 */
export function pintar(mensaje) {
  try {
    if (!mensaje || !mensaje.usuarioId) return mensaje;
    const color = deUsuario(mensaje.red, mensaje.usuarioId);
    if (!color) return mensaje;
    mensaje.color = color;
    mensaje.colorPropio = true;
    return mensaje;
  } catch (e) {
    console.warn('[colores] no se pudo pintar un mensaje:', e?.name ?? 'Error');
    return mensaje;
  }
}

/** Solo para los tests. */
export function reiniciar() {
  porUsuario.clear();
  porEspectador.clear();
}
