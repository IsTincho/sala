/* ============================================================
   El reloj de sala: en que segundo de la peli va el canal.

   La idea entera de la Sala es que trescientas personas vean el mismo
   fotograma sin que el servidor toque un solo byte de video. Eso se
   logra con cuatro numeros y un reloj comun:

     videoId        que se esta pasando
     empezoEn       ms epoch DEL SERVIDOR en que arranco este tramo
     pausadoEn      ms epoch en que se congelo, o null si corre
     offsetInicial  en que segundo del video estaba en `empezoEn`

   La posicion es aritmetica:

     corriendo:  offsetInicial + (ahora - empezoEn) / 1000
     pausado:    offsetInicial + (pausadoEn - empezoEn) / 1000

   Cada navegador calcula lo mismo con su propio reloj corregido por
   el desfase que midio contra `/api/hora`, y salta ahi. Nadie manda
   "andá al segundo 812" cada segundo: el estado es chico, se manda
   una vez por cambio, y el resto es una cuenta.

   ---------------------------------------------------------------
   POR QUE `empezoEn` Y NO "SEGUNDO ACTUAL"

   Guardar la posicion actual obligaria a escribirla todo el tiempo, y
   entre dos escrituras el estado estaria mal. Guardando el momento en
   que arranco el tramo, el estado no cambia mientras la peli corre:
   se escribe solo cuando alguien toca un boton. Un deploy en el medio
   (que aca es la forma normal de trabajar: push a main es deploy) no
   pierde nada, porque `empezoEn` es una fecha absoluta y la cuenta
   sigue dando lo mismo del otro lado del reinicio.

   ---------------------------------------------------------------
   ESTADOS

     reproduciendo   corre
     pausado         congelado en una posicion
     detenido        no hay nada puesto; la sala muestra la espera

   "detenido" es un estado de verdad y no `null`: el que se conecta
   tiene que poder distinguir "no hay peli" de "todavia no me llego el
   estado".
   ============================================================ */

import * as almacen from './almacen.js';
import * as canales from './canales.js';
import * as videos from './videos.js';

export const ACCIONES = ['reproducir', 'pausar', 'reanudar', 'saltar', 'detener'];

export const DETENIDO = { estado: 'detenido', videoId: '', empezoEn: 0, pausadoEn: null, offsetInicial: 0 };

/* Un salto mas grande que esto es un dedo pesado, no una intencion.
   Igual la posicion se recorta contra la duracion del video. */
const TOPE_SALTO = 24 * 60 * 60;

/* ------------------------------------------------------- cuentas */

/** En que segundo del video esta un reloj. Nunca negativo. */
export function posicion(reloj, ahora = Date.now()) {
  if (!reloj || reloj.estado === 'detenido' || !reloj.videoId) return 0;
  const base = Number(reloj.offsetInicial ?? 0);
  const desde = Number(reloj.empezoEn ?? 0);
  const hasta = reloj.estado === 'pausado' ? Number(reloj.pausadoEn ?? desde) : ahora;
  return Math.max(0, base + (hasta - desde) / 1000);
}

/* La posicion no puede pasarse del final: un video terminado que
   siguiera sumando segundos dejaria al player pidiendo un segmento
   que no existe, y el navegador reintentando para siempre. */
const recortar = (segundos, duracion) =>
  Math.max(0, duracion > 0 ? Math.min(segundos, duracion) : segundos);

/**
 * El reloj tal como sale por el cable y como lo ve la sala.
 *
 * Lleva la ficha del video adentro (titulo, url, duracion,
 * subtitulos) para que el navegador no tenga que hacer un pedido mas
 * antes de empezar a cargar. La URL es publica igual: es la de r2.dev,
 * que es a donde el navegador va a ir solo.
 */
export function paraElCable(reloj, video, ahora = Date.now()) {
  if (!reloj || reloj.estado === 'detenido' || !reloj.videoId) {
    return { tipo: 'reloj', ...DETENIDO, duracion: 0, posicion: 0, titulo: '', url: '', calidades: [], subtitulos: [], ahora };
  }
  const duracion = Number(video?.duracion ?? 0);
  return {
    tipo: 'reloj',
    estado: reloj.estado,
    videoId: reloj.videoId,
    empezoEn: reloj.empezoEn,
    pausadoEn: reloj.pausadoEn ?? null,
    offsetInicial: reloj.offsetInicial,
    titulo: video?.titulo ?? '',
    url: video?.url ?? '',
    duracion,
    calidades: video?.calidades ?? [],
    subtitulos: video?.subtitulos ?? [],
    posicion: recortar(posicion(reloj, ahora), duracion),
    ahora,
  };
}

/* ------------------------------------------------- persistencia */

/* Lo que se guarda en la coleccion `reloj` es SOLO el estado, sin la
   ficha del video: la ficha vive en `videos` y copiarla aca seria
   tener el titulo en dos lugares y que uno se quede viejo. */
const paraGuardar = r => ({
  estado: r.estado,
  videoId: r.videoId,
  empezoEn: r.empezoEn,
  pausadoEn: r.pausadoEn ?? null,
  offsetInicial: r.offsetInicial,
});

const desdeElAlmacen = doc => {
  if (!doc || doc.estado === 'detenido' || !doc.videoId) return { ...DETENIDO };
  return {
    estado: doc.estado === 'pausado' ? 'pausado' : 'reproduciendo',
    videoId: String(doc.videoId),
    empezoEn: Number(doc.empezoEn ?? 0),
    pausadoEn: doc.pausadoEn === null || doc.pausadoEn === undefined ? null : Number(doc.pausadoEn),
    offsetInicial: Number(doc.offsetInicial ?? 0),
  };
};

/**
 * El estado crudo de un canal, sin la ficha del video. Sale de la
 * memoria del canal si esta, y del almacen si no.
 */
export async function leer(slug) {
  const s = String(slug ?? '').toLowerCase();
  /* `hayCanal` y no `canal`: `canal()` CREA la entrada si no existe, y
     leer el reloj de un slug cualquiera no tiene por que hacer crecer
     el Map de canales. Es la misma puerta que cierra `canalPermitido`
     en /eventos, del otro lado. */
  const enMemoria = canales.hayCanal(s) ? canales.canal(s).reloj : null;
  if (enMemoria) return desdeElAlmacen(enMemoria);
  return desdeElAlmacen(await almacen.obtener('reloj', s));
}

/**
 * Deja el reloj puesto en el canal, lo persiste y lo difunde.
 *
 * El orden importa: primero se persiste y despues se difunde. Al
 * reves, un fallo del almacen dejaria a trescientas pantallas
 * reproduciendo algo que el servidor no se va a acordar en el proximo
 * deploy.
 */
async function aplicarYDifundir(slug, nuevo) {
  const s = String(slug).toLowerCase();
  const video = nuevo.videoId ? await videos.obtener(s, nuevo.videoId) : null;

  if (nuevo.estado === 'detenido') await almacen.quitar('reloj', s);
  else await almacen.poner('reloj', s, paraGuardar(nuevo));

  const cable = paraElCable(nuevo, video);
  /* Lo que queda en la memoria del canal es el estado crudo mas lo que
     el que se conecte necesita para arrancar sin pedir nada mas. Va
     entero adentro del evento `estado` inicial (canales.estadoDe). */
  canales.ponerReloj(s, cable);

  /* Salvo cuando se detiene: ahi se difunde y despues se olvida. Un
     "detenido" es la ausencia de reloj, no un reloj, y dejarlo puesto
     hacia que el canal no se liberara nunca aunque se fuera hasta el
     ultimo espectador —el objeto de detenido es tan truthy como el de
     reproduciendo—. `restaurar()` ya trata la ausencia asi (no pone
     nada si no hay nada guardado); las dos mitades tienen que coincidir
     o la memoria solo crece. El que se conecte despues recibe
     `reloj: null` en el evento `estado`, que la sala ya interpreta como
     "todavia no empezo": es el mismo camino que un canal recien
     creado. */
  if (nuevo.estado === 'detenido') canales.olvidarReloj(s);

  return cable;
}

/**
 * Levanta del almacen el reloj de un canal al arrancar el servidor.
 *
 * Sin esto, un deploy en medio de la peli dejaba la sala en "detenido"
 * hasta que el dueño volviera a tocar play, y en un deploy en vivo eso
 * es media pelicula.
 */
export async function restaurar(slug) {
  const s = String(slug ?? '').toLowerCase();
  if (!s) return null;
  const guardado = desdeElAlmacen(await almacen.obtener('reloj', s));
  /* Nada guardado: no se crea el canal ni se difunde nada. Un
     `ponerReloj` aca dejaria una entrada en el Map de canales por cada
     slug que alguien mencione, que es justo lo que la Fase 1 vino a
     arreglar en /eventos. */
  if (guardado.estado === 'detenido') return null;

  const video = await videos.obtener(s, guardado.videoId);
  /* La ficha se borro (por ejemplo con `subir.py --borrar`) mientras
     el servidor estaba abajo: no se puede reproducir lo que ya no
     esta, asi que el reloj arranca detenido y se limpia. */
  if (!video) {
    await almacen.quitar('reloj', s);
    return null;
  }
  const cable = paraElCable(guardado, video);
  canales.ponerReloj(s, cable);
  return cable;
}

/* --------------------------------------------------- las acciones */

/**
 * Corre una accion sobre el reloj de un canal.
 *
 * @param {string} slug
 * @param {string} accion  reproducir | pausar | reanudar | saltar | detener
 * @param {{videoId?:string, segundos?:number}} opciones
 * @returns {Promise<{error?:string, reloj?:object}>}
 */
export async function aplicar(slug, accion, opciones = {}) {
  const s = String(slug ?? '').toLowerCase();
  if (!videos.slugValido(s)) return { error: 'slug invalido' };
  if (!ACCIONES.includes(accion)) return { error: `accion desconocida: ${accion}` };

  const ahora = Date.now();
  const actual = await leer(s);

  if (accion === 'detener') {
    return { reloj: await aplicarYDifundir(s, { ...DETENIDO }) };
  }

  if (accion === 'reproducir') {
    const videoId = String(opciones.videoId ?? '');
    if (!videos.idValido(videoId)) return { error: 'falta el videoId' };
    const video = await videos.obtener(s, videoId);
    if (!video) return { error: 'ese video no esta en el catalogo' };
    /* Arranca del principio, o del segundo que pidan (el panel manda
       `desde` para retomar un episodio a mitad). */
    const desde = recortar(Number(opciones.desde ?? 0) || 0, video.duracion);
    return {
      reloj: await aplicarYDifundir(s, {
        estado: 'reproduciendo',
        videoId,
        empezoEn: ahora,
        pausadoEn: null,
        offsetInicial: desde,
      }),
    };
  }

  if (actual.estado === 'detenido') return { error: 'no hay nada puesto' };

  if (accion === 'pausar') {
    /* Pausar lo ya pausado no mueve nada. Sin esto, dos clicks
       seguidos (o dos pestañas del panel) adelantaban la posicion:
       el segundo pausadoEn se calculaba contra el empezoEn viejo. */
    if (actual.estado === 'pausado') return { reloj: await aplicarYDifundir(s, actual) };
    return { reloj: await aplicarYDifundir(s, { ...actual, estado: 'pausado', pausadoEn: ahora }) };
  }

  if (accion === 'reanudar') {
    if (actual.estado === 'reproduciendo') return { reloj: await aplicarYDifundir(s, actual) };
    /* Se congela la posicion en la que quedo y se arranca un tramo
       nuevo desde ahora: asi el tiempo que estuvo pausado no cuenta. */
    return {
      reloj: await aplicarYDifundir(s, {
        estado: 'reproduciendo',
        videoId: actual.videoId,
        empezoEn: ahora,
        pausadoEn: null,
        offsetInicial: posicion(actual, ahora),
      }),
    };
  }

  /* saltar */
  const segundos = Number(opciones.segundos);
  if (!Number.isFinite(segundos) || Math.abs(segundos) > TOPE_SALTO) {
    return { error: 'segundos invalidos' };
  }
  const video = await videos.obtener(s, actual.videoId);
  const destino = recortar(posicion(actual, ahora) + segundos, Number(video?.duracion ?? 0));
  return {
    reloj: await aplicarYDifundir(s, {
      estado: actual.estado,
      videoId: actual.videoId,
      empezoEn: ahora,
      /* Si estaba pausado sigue pausado, congelado en el destino: el
         tramo nuevo arranca y termina en el mismo instante. */
      pausadoEn: actual.estado === 'pausado' ? ahora : null,
      offsetInicial: destino,
    }),
  };
}

/**
 * Si el reloj esta usando este video, lo detiene.
 *
 * Lo llama el borrado de un video. Sin esto, borrar de R2 lo que se
 * esta pasando deja a la sala pidiendo segmentos que ya no existen: el
 * player no falla con un error claro, se queda cargando para siempre.
 */
export async function detenerSiUsa(slug, videoId) {
  const actual = await leer(slug);
  if (actual.estado === 'detenido' || actual.videoId !== String(videoId)) return false;
  await aplicarYDifundir(String(slug).toLowerCase(), { ...DETENIDO });
  return true;
}

/** El reloj de un canal listo para mandar por HTTP. */
export async function actual(slug) {
  const s = String(slug ?? '').toLowerCase();
  const r = await leer(s);
  const video = r.videoId ? await videos.obtener(s, r.videoId) : null;
  return paraElCable(r, video);
}
