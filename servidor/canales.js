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
    clientes: new Set(),
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

/** Foto de todos los canales, para la pagina de estado. */
export const resumen = () =>
  [...canales.values()].map(c => ({
    slug: c.slug,
    conectados: c.clientes.size,
    mensajes: c.mensajes.length,
    reloj: c.reloj,
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

/** El estado que recibe alguien apenas se conecta. */
export const estadoDe = c => ({
  slug: c.slug,
  conectados: c.clientes.size,
  reloj: c.reloj,
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
 */
export function suscribir(slug, req, res) {
  const c = canal(slug);

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

  c.clientes.add(res);

  /* Lo primero que ve el que llega: donde esta parado. Sin esto, una
     pestaña recien abierta no sabe si el servidor la escucha hasta que
     alguien hable, y en un chat tranquilo eso son minutos de duda. */
  escribir(res, ++seq, 'estado', estadoDe(c));

  /* Y despues, lo que se perdio. Con el chat vacio no manda nada, asi
     que en la Fase 0 esto no se nota; existe aca porque el buffer vive
     aca y partirlo en dos lugares seria peor. */
  for (const m of c.mensajes) escribir(res, ++seq, m.tipo ?? 'chat', m);

  /* `soltar` se engancha a dos eventos que pueden llegar los dos, y
     tarde: primero el close y despues un error, o al reves. Sin la
     bandera, la segunda pasada volvia a evaluar la condicion de borrado
     con el canal ya cambiado. */
  let soltado = false;
  const soltar = () => {
    if (soltado) return;
    soltado = true;
    c.clientes.delete(res);

    /* Un canal sin nadie mirando y sin nada que recordar no tiene por
       que seguir ocupando lugar: con miles de creadores en la Fase 3
       esto es la diferencia entre un Map que crece para siempre y uno
       que respira. El que tiene reloj puesto se queda: es estado real.

       El `canales.get(c.slug) === c` no es paranoia: `c` es el canal
       que existia cuando ESTA conexion se abrio. Si el ultimo se fue,
       el canal se borro, y despues entro otro con el mismo slug, el
       Map ya apunta a un canal NUEVO. Borrar por slug ahi dejaba al
       recien llegado con su EventSource abierto y sin canal detras: sin
       eventos, sin pings, sin error, para siempre. */
    if (canales.get(c.slug) !== c) return;
    if (!c.clientes.size && !c.mensajes.length && !c.reloj) canales.delete(c.slug);
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
  for (const res of c.clientes) {
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

/* ------------------------------------------------------------- pings */

let latido = null;

export function arrancarPings() {
  if (latido) return latido;
  latido = setInterval(() => {
    for (const c of canales.values()) {
      for (const res of c.clientes) {
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
    for (const res of c.clientes) {
      try { res.end(); } catch { /* ya estaba cerrada */ }
    }
    c.clientes.clear();
  }
  canales.clear();
  pararPings();
}
