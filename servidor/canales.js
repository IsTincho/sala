/* ============================================================
   Canales: lo que el servidor sabe de cada creador mientras vive.

   Un canal es un slug de Kick y todo lo que pasa alrededor: quienes
   estan mirando, en que segundo va la peli, y los ultimos mensajes.

   POR QUE POR CANAL Y NO GLOBAL, DESDE LA FASE 0

   Hoy hay un solo streamer. En la Fase 3 hay muchos, cada uno con su
   sala, su reloj y su chat. Escribir esto como un bus global y
   partirlo despues significaria tocar todas las rutas, el webhook y el
   cliente del navegador el dia que entre el segundo creador. Empezar
   con la dimension "slug" adentro cuesta unas pocas lineas ahora y
   evita ese refactor entero. Es la unica decision de la Fase 0 que se
   toma mirando la Fase 3.

   Todo esto es MEMORIA: se pierde al reiniciar, y esta bien que asi
   sea. Lo que tiene que sobrevivir un deploy (el reloj de sala, la
   lista de videos) se espeja en el almacen; lo demas se rearma solo
   cuando la gente vuelve a conectarse.

   Se eligio SSE y no WebSocket porque el trafico va en un solo sentido
   (servidor -> navegador), reconecta solo, y del lado del cliente es
   un EventSource y nada mas. Para escribir en el chat ya hay un POST.
   ============================================================ */

/** Cuantos mensajes se guardan para el que llega tarde. */
const TOPE_MENSAJES = 200;

/* Proxies y balanceadores cortan conexiones ociosas; Railway no es la
   excepcion. Un comentario cada 25s mantiene el stream vivo sin
   ensuciar los eventos: un ':' inicial es un comentario SSE y el
   EventSource lo ignora solo. */
const CADA_PING = 25_000;

const canales = new Map();   // slug -> canal
let seq = 0;                 // id incremental de evento, global

function nuevoCanal(slug) {
  return {
    slug,
    /* res -> { redes }. Es un Map y no un Set porque cada conexion
       tiene su propio filtro: ver `leDaEl` mas abajo. */
    clientes: new Map(),
    /* null = no hay nada puesto. La forma del reloj la define la
       Fase 2; aca solo se guarda y se reparte. */
    reloj: null,
    mensajes: [],
    desde: Date.now(),
  };
}

/** El canal de un slug, creandolo si es la primera vez. */
export function canal(slug) {
  const clave = String(slug).toLowerCase();
  if (!canales.has(clave)) canales.set(clave, nuevoCanal(clave));
  return canales.get(clave);
}

export const hayCanal = slug => canales.has(String(slug).toLowerCase());
export const conectados = slug => (canales.get(String(slug).toLowerCase())?.clientes.size ?? 0);

/**
 * Foto de todos los canales, para la pagina de estado.
 *
 * VA `conReloj` Y NO EL RELOJ. `/api/estado` es publico y no pide
 * sesion (lo consulta la pagina `/`), asi que mandar `c.reloj` entero
 * publicaba el titulo, la URL y el segundo exacto de la pelicula de
 * TODOS los canales a cualquiera que pidiera esa direccion. Era la
 * misma fuga que `estadoDe` cierra del lado del bus, por una puerta
 * distinta: cerrar una sola de las dos no cierra nada.
 *
 * El booleano se queda porque tiene un uso real y documentado: un
 * canal con reloj puesto NO se libera de memoria aunque no quede nadie
 * mirando (ver `soltarSiVacio`), y sin este campo no hay forma de
 * entender desde afuera por que un canal con cero conectados y cero
 * mensajes sigue en la lista. No dice que pelicula es.
 */
export const resumen = () =>
  [...canales.values()].map(c => ({
    slug: c.slug,
    conectados: c.clientes.size,
    mensajes: c.mensajes.length,
    conReloj: Boolean(c.reloj),
    desde: c.desde,
  }));

/* --------------------------------------------------------------- sse */

/* Como sale un evento, y por que asi.

   Todo evento va como el `message` por defecto de SSE, con el tipo
   ADENTRO del data. No como `event: <tipo>`, que es como estaba.

   Por la especificacion de SSE, un mensaje con `event: kick` se
   entrega unicamente a addEventListener('kick', ...) y no dispara
   onmessage nunca. El servidor difundia 'kick' (el webhook real) y
   'prueba' (el endpoint local) y la pagina escuchaba tres nombres
   fijos: esos eventos llegaban al navegador y se perdian ahi, sin un
   solo error. Un cliente no puede suscribirse a un nombre que todavia
   no existe, asi que el nombre no puede ser lo que decide si el evento
   llega. Con el tipo adentro del data, el cliente recibe todo y
   reparte el mismo.

   De paso cierra una inyeccion: el tipo ya no se interpola en el
   armado de la trama, y adentro del JSON un \n queda escapado y no
   puede abrir un campo SSE nuevo. Igual se valida, porque en la Fase 1
   el tipo va a salir de payloads de webhook y ademas de no romper la
   trama tiene que servirle al cliente para repartir. */

const TIPO_VALIDO = /^[a-z][a-z0-9_.:-]{0,39}$/i;

/** El tipo si es usable; si no, uno generico. Nunca rompe la trama. */
export const tipoSeguro = t => (typeof t === 'string' && TIPO_VALIDO.test(t) ? t : 'mensaje');

function escribir(res, id, tipo, datos) {
  const t = tipoSeguro(tipo);
  res.write(`id: ${id}\ndata: ${JSON.stringify({ ...datos, tipo: t })}\n\n`);
}

/* --------------------------------------------- el filtro por red

   EL BUS DE UN CANAL ES PUBLICO: `/eventos/:slug` no pide sesion, y
   desde la Fase 2 lo escucha cualquiera que abra la Sala a ver la
   peli. Pero por ese mismo bus viaja tambien el chat de TWITCH del
   dueño (`chat.js` recuerda las dos redes en el canal de su slug),
   que es la comunidad de otra plataforma y no tiene nada que hacer en
   la sala de la pelicula.

   Por eso cada conexion declara que redes quiere, y el filtro se
   aplica ACA y no en el navegador: si filtrara el cliente, el chat de
   Twitch igual saldria por el cable hacia todas las pestañas, y un
   `curl /eventos/istincho` lo veria entero. Filtrar donde se decide
   es lo unico que hace la regla verdad.

   `redes` null = todas (es lo que pide /chat, con la cookie del
   dueño). Los eventos sin `red` —estado, reloj, presencia— pasan
   siempre: no son de ninguna red.

   `redes` puede ser tambien una FUNCION, y entonces se pregunta en
   cada evento. Existe por el chat abierto (Fase 5.1): el creador puede
   cerrarlo o sacarle Twitch con gente conectada, y ese corte tiene que
   valer para el proximo mensaje, no para la proxima reconexion. Con una
   lista fija, quien se conecto con el chat abierto seguiria recibiendo
   Twitch hasta cerrar la pestaña. Quien decide que contesta la funcion
   es la ruta (`index.js`); este modulo sigue sin saber que es un chat
   abierto. */
const redesDe = suyo => (typeof suyo?.redes === 'function' ? suyo.redes() : suyo?.redes);

/* Y aparte de la red, lo PRIVADO: un evento con `privado: true` (hoy,
   los follows de la actividad) sale solo a las conexiones que la ruta
   marco como del creador de esa sala o de sus mods. En Twitch un follow
   no es publico, y este bus lo escucha cualquiera sin login: el corte
   va aca por el mismo motivo que el de la red, porque filtrarlo en el
   navegador seria mandarlo igual por el cable. */
const leDaEl = (opciones, evento) => {
  if (evento?.privado === true && opciones?.privado !== true) return false;
  const red = evento?.red;
  if (typeof red !== 'string') return true;
  const redes = redesDe(opciones);
  if (!redes) return true;
  return redes.includes(red);
};

/**
 * Borra el canal si ya no queda nada que recordar, y dice si lo borro.
 *
 * Un canal sin nadie mirando y sin nada adentro no tiene por que seguir
 * ocupando lugar: con miles de creadores en la Fase 3 esto es la
 * diferencia entre un Map que crece para siempre y uno que respira. El
 * que tiene reloj puesto se queda: es estado real.
 *
 * El `canales.get(c.slug) === c` no es paranoia: `c` es el canal que
 * existia cuando quien llama lo agarro. Si el ultimo se fue, el canal
 * se borro, y despues entro otro con el mismo slug, el Map ya apunta a
 * un canal NUEVO. Borrar por slug ahi dejaba al recien llegado con su
 * EventSource abierto y sin canal detras: sin eventos, sin pings, sin
 * error, para siempre.
 */
function soltarSiVacio(c) {
  if (canales.get(c.slug) !== c) return false;
  if (c.clientes.size || c.mensajes.length || c.reloj) return false;
  canales.delete(c.slug);
  return true;
}

/**
 * El estado que recibe alguien apenas se conecta.
 *
 * `conReloj` en false deja el reloj en null aunque el canal tenga una
 * pelicula puesta. Lo usa `/eventos/:slug` cuando la Sala de ese
 * creador esta CERRADA (el interruptor de `creadores.salaAbierta`): ese
 * mismo bus es el del chat abierto, que sigue siendo publico y sin
 * sesion, asi que sin esto un `curl` a `/eventos/<slug>` seguiria
 * contando el titulo y el segundo de la pelicula que quedo puesta antes
 * de apagarla.
 *
 * No es un caso del filtro por red: el reloj no lleva `red` y por eso
 * pasa siempre (ver `leDaEl`). Y no hace falta filtrar ademas los
 * eventos `reloj` en vivo, porque lo unico que los genera es
 * `reloj.aplicarYDifundir`, al que solo se llega por rutas que con la
 * Sala cerrada contestan 404 antes de tocar nada. Lo que se escapaba
 * era la FOTO vieja, no el evento nuevo.
 */
export const estadoDe = (c, conReloj = true) => ({
  slug: c.slug,
  conectados: c.clientes.size,
  reloj: conReloj ? c.reloj : null,
  desde: c.desde,
});

/**
 * Engancha una respuesta HTTP como cliente SSE de un canal.
 *
 * No lleva Access-Control-Allow-Origin. En CosasStream si, porque los
 * overlays los abre OBS desde otro origen; aca todas las paginas se
 * sirven del mismo servidor, y abrir el stream a cualquier origen
 * seria regalarle el chat en vivo a cualquier sitio que lo quiera
 * embeber.
 *
 * @param {{redes?:string[]|(() => string[]|null), conReloj?:boolean}} [opciones]
 *        `redes`: que redes quiere esta conexion. Sin `redes` llega
 *        todo; con `['kick']` llega solo Kick; con una funcion, lo que
 *        conteste en cada evento. Quien decide es la ruta, no este
 *        modulo: ver `leDaEl`.
 *        `conReloj`: si el `estado` inicial lleva la pelicula que haya
 *        puesta. Por defecto si, que es como se comporto siempre; lo
 *        apaga la ruta cuando la Sala de ese creador esta cerrada (ver
 *        `estadoDe`).
 */
export function suscribir(slug, req, res, opciones = {}) {
  const c = canal(slug);
  /* Se copia la lista: quien llama no puede cambiarle el filtro a una
     conexion ya abierta modificando el array que paso. La funcion, en
     cambio, se guarda tal cual: que conteste distinto con el tiempo es
     justamente para lo que esta. */
  const suyo = {
    redes: typeof opciones.redes === 'function' ? opciones.redes
      : Array.isArray(opciones.redes) ? [...opciones.redes] : null,
    /* `=== true` y no truthy: lo privado se abre solo con un si explicito */
    privado: opciones.privado === true,
  };

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    /* nginx y compania bufferean respuestas largas y el chat llegaria
       a los saltos, de a bloques. Esto lo apaga. */
    'X-Accel-Buffering': 'no',
  });
  /* si se corta, que el navegador espere 3s antes de volver */
  res.write('retry: 3000\n\n');

  c.clientes.set(res, suyo);

  /* Lo primero que ve el que llega: donde esta parado. Sin esto, una
     pestaña recien abierta no sabe si el servidor la escucha hasta que
     alguien hable, y en un chat tranquilo eso son minutos de duda. */
  escribir(res, ++seq, 'estado', estadoDe(c, opciones.conReloj !== false));

  /* Y despues, lo que se perdio. Con el chat vacio no manda nada, asi
     que en la Fase 0 esto no se nota; existe aca porque el buffer vive
     aca y partirlo en dos lugares seria peor.

     El buffer pasa por el MISMO filtro que lo que llega en vivo: sin
     esto, una sala que no recibe Twitch en vivo se comeria igual los
     ultimos 200 mensajes de Twitch al conectarse, que es la mitad del
     problema y la mas visible. */
  for (const m of c.mensajes) {
    if (leDaEl(suyo, m)) escribir(res, ++seq, m.tipo ?? 'chat', m);
  }

  /* `soltar` se engancha a dos eventos que pueden llegar los dos, y
     tarde: primero el close y despues un error, o al reves. Sin la
     bandera, la segunda pasada volvia a evaluar la condicion de borrado
     con el canal ya cambiado. */
  let soltado = false;
  const soltar = () => {
    if (soltado) return;
    soltado = true;
    c.clientes.delete(res);
    soltarSiVacio(c);
  };
  req.on('close', soltar);
  req.on('error', soltar);

  return res;
}

/**
 * Manda un evento a todos los conectados de un canal.
 * @param {string} slug
 * @param {{tipo:string}} evento  el `tipo` viaja adentro del data (ver `escribir`)
 */
export function difundir(slug, evento) {
  const c = canales.get(String(slug).toLowerCase());
  if (!c) return 0;

  const tipo = evento?.tipo ?? 'mensaje';
  const id = ++seq;
  let llegaron = 0;
  for (const [res, suyo] of c.clientes) {
    if (!leDaEl(suyo, evento)) continue;
    try { escribir(res, id, tipo, evento); llegaron++; }
    catch { c.clientes.delete(res); }
  }
  return llegaron;
}

/**
 * Guarda un mensaje en el buffer del canal y lo reparte. Se separa de
 * `difundir` porque no todo lo que se difunde se recuerda: el reloj y
 * el estado son "lo de ahora", no historia.
 */
export function recordar(slug, mensaje) {
  const c = canal(slug);
  c.mensajes.push(mensaje);
  if (c.mensajes.length > TOPE_MENSAJES) {
    c.mensajes.splice(0, c.mensajes.length - TOPE_MENSAJES);
  }
  return difundir(slug, mensaje);
}

export const ultimos = slug =>
  (canales.get(String(slug).toLowerCase())?.mensajes ?? []).slice();

/** Deja anotado el reloj del canal. La Fase 2 define que hay adentro. */
export function ponerReloj(slug, reloj) {
  canal(slug).reloj = reloj;
  return difundir(slug, { tipo: 'reloj', ...reloj });
}

/**
 * Saca el reloj del canal y lo libera si con eso quedo vacio. Devuelve
 * si el canal se borro.
 *
 * Existe porque "detenido" no es un reloj: es la AUSENCIA de reloj. Se
 * difunde igual (los que estan mirando tienen que enterarse de que se
 * cortó), pero el objeto que se difunde es tan truthy como el de
 * "reproduciendo", asi que `soltarSiVacio` lo tomaba por estado real y
 * el canal se quedaba en el Map para siempre despues de un "detener".
 * `reloj.restaurar()` ya evita justamente eso del otro lado (no pone
 * reloj si no hay nada guardado); esto hace que las dos mitades digan
 * lo mismo.
 *
 * Quien decide que es "detenido" es `reloj.js`, que es el que conoce la
 * forma: este modulo sigue sin saber que hay adentro del reloj.
 */
export function olvidarReloj(slug) {
  const c = canales.get(String(slug).toLowerCase());
  if (!c) return false;
  c.reloj = null;
  return soltarSiVacio(c);
}

/* ------------------------------------------------------------- pings */

let latido = null;

export function arrancarPings() {
  if (latido) return latido;
  latido = setInterval(() => {
    for (const c of canales.values()) {
      for (const res of c.clientes.keys()) {
        try { res.write(': ping\n\n'); }
        catch { c.clientes.delete(res); }
      }
    }
  }, CADA_PING);
  /* unref: un intervalo colgado no tiene por que impedir que el
     proceso termine, ni dejar un test corriendo para siempre */
  latido.unref();
  return latido;
}

export function pararPings() {
  if (latido) clearInterval(latido);
  latido = null;
}

/** Cierra todo. Lo usan los tests y el apagado ordenado. */
export function cerrarTodo() {
  for (const c of canales.values()) {
    for (const res of c.clientes.keys()) {
      try { res.end(); } catch { /* ya estaba cerrada */ }
    }
    c.clientes.clear();
  }
  canales.clear();
  pararPings();
}
