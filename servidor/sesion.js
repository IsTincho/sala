/* ============================================================
   Sesiones: quien es el que pide, sin guardar nada delicado en el
   navegador.

   Hay DOS sesiones distintas, a proposito:

     sala_dueno       el streamer, en /panel y /chat
     sala_espectador  cualquiera que entra a ver la peli y escribir

   No es una sola cookie con un campo "rol". Son dos cookies con
   nombres distintos porque el dia que un espectador consiga que le
   den una sesion que no le corresponde, el error tiene que ser
   "no tenes cookie de dueño", no "tu rol dice espectador". Separar
   los espacios de nombres es mas dificil de romper que separarlos
   por un campo.

   ---------------------------------------------------------------
   COMO ES LA COOKIE

   En la cookie viaja `<id>.<firma>`:

     id     32 bytes al azar, base64url
     firma  HMAC-SHA256 del id con CLAVE_CIFRADO, atada al nombre
            de la cookie

   En la base se guarda el SHA-256 del id, nunca el id. Si la base se
   filtra, con el hash no se puede armar la cookie.

   Firma Y almacen puede sonar redundante. No lo es, y cada uno cubre
   algo distinto:

     - La firma se verifica sin tocar la base. Una cookie inventada se
       tira en microsegundos; sin firma, cada basura que llegue seria
       una consulta a Mongo, y eso es un modo barato de voltear el
       servicio.
     - El almacen es la verdad. La firma prueba que la cookie salio de
       aca, no que la sesion siga viva. Cerrar sesion, o echar a
       alguien, tiene que surtir efecto YA, y eso solo se puede si la
       base manda.

   El rol NO se guarda en la sesion. Quien es dueño, amigo o pago se
   resuelve contra `creadores` en cada pedido: sacarle el permiso a
   alguien lo saca en el acto y no cuando se le venza la cookie.
   ============================================================ */

import crypto from 'node:crypto';
import * as almacen from './almacen.js';
import { firmar, firmaValida } from './cifrado.js';

/** tipo -> nombre de la cookie. No hay otros tipos. */
export const COOKIES = {
  dueno: 'sala_dueno',
  espectador: 'sala_espectador',
};

const DURA    = 30 * 24 * 60 * 60 * 1000;   // 30 dias, deslizantes
export const DURA_SEGUNDOS = Math.floor(DURA / 1000);

/* Escribir en la base en cada pedido para mover el "ultimo visto"
   seria castigar a Mongo al pedo. Con anotarlo cada 5 minutos alcanza. */
const REFRESCAR_CADA = 5 * 60 * 1000;

const hashDe = id => crypto.createHash('sha256').update(id).digest('hex');

function nombreDe(tipo) {
  const n = COOKIES[tipo];
  if (!n) throw new Error(`tipo de sesion desconocido: ${tipo}`);
  return n;
}

/* --------------------------------------------------------- cookies */

/** Lee una cookie del pedido por nombre. */
export function leerCookie(req, nombre) {
  for (const parte of (req.headers?.cookie ?? '').split(';')) {
    const i = parte.indexOf('=');
    if (i < 0) continue;
    if (parte.slice(0, i).trim() === nombre) return parte.slice(i + 1).trim();
  }
  return '';
}

/**
 * El Set-Cookie de una sesion.
 *
 * HttpOnly  el JavaScript de la pagina no la puede leer: un XSS no se
 *           lleva la sesion puesta.
 * Secure    solo por HTTPS. En localhost los navegadores la aceptan
 *           igual, asi que no molesta para desarrollar.
 * SameSite=Lax  el callback de OAuth vuelve por una navegacion de
 *           arriba (GET), y con Lax la cookie viaja en ese caso. Con
 *           Strict el login terminaria sin cookie, que es el bug
 *           clasico de este flujo.
 *
 * ---------------------------------------------------------------
 * EL LAX ES LA UNICA DEFENSA CONTRA CSRF QUE HAY EN TODO EL PROYECTO
 *
 * No hay token CSRF en ningun POST. Es lo que pide el brief y alcanza,
 * porque Lax no manda la cookie en un POST cross-site: un formulario
 * en otro sitio que apunte a /api/panel/clave llega sin sesion y se
 * contesta 401.
 *
 * Lo que hay que saber es que esa defensa es UN SOLO renglon, y que
 * cambiarlo abre cinco puertas de golpe. El dia que algo pida
 * SameSite=None —un embed de la Sala adentro de otro sitio es el caso
 * realista— quedan expuestos, todos juntos y sin aviso:
 *   POST /api/panel/clave      (regenera la clave de subida)
 *   DELETE /api/panel/clave    (la revoca)
 *   POST /api/sala/:slug/reloj (play, pausa, salto, stop)
 *   POST /api/sala/:slug/chat  (escribe en kick.com con la cuenta ajena)
 *   POST /api/sala/:slug/salir (cierra la sesion y borra el token)
 * Ese dia, y no antes, hace falta el token. Antes es ceremonia.
 */
export function cabeceraCookie(tipo, valor) {
  return `${nombreDe(tipo)}=${valor}; Path=/; Max-Age=${DURA_SEGUNDOS}; ` +
         `HttpOnly; Secure; SameSite=Lax`;
}

/** El Set-Cookie que borra la sesion del navegador. */
export function cabeceraBorrar(tipo) {
  return `${nombreDe(tipo)}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

/* -------------------------------------------------------- sesiones */

/**
 * Crea una sesion y devuelve el valor listo para la cookie.
 * @param {{tipo:string, usuario?:string, nombre?:string, slug?:string, agente?:string}} datos
 */
export async function crear({ tipo, usuario = '', nombre = '', slug = '', agente = '' }) {
  const cookie = nombreDe(tipo);
  const id = crypto.randomBytes(32).toString('base64url');

  await almacen.poner('sesiones', hashDe(id), {
    tipo,
    usuario: String(usuario),
    nombre: String(nombre),
    slug: String(slug),
    /* el user-agent entero es una novela: con el principio alcanza
       para distinguir "el celu" de "la compu" en una lista */
    agente: String(agente).slice(0, 80),
    creada: Date.now(),
    ultimo: Date.now(),
  });

  return `${id}.${firmar(cookie, id)}`;
}

/**
 * La sesion del pedido, o null. Verifica firma, existencia,
 * vencimiento y que el tipo guardado sea el que se pide.
 *
 * `estirar: false` la lee sin tocar el "ultimo visto". Lo usa `cerrar`,
 * y no es una optimizacion: el refresco se manda SIN await, asi que
 * una sesion que se esta cerrando podria recibir esa escritura
 * DESPUES del borrado y volver a existir. La cookie ya no esta del
 * lado del navegador, pero el documento quedaria en la base hasta que
 * lo pode el vencimiento, y quien hubiera copiado esa cookie antes
 * seguiria entrando. Salir tiene que salir.
 */
export async function leer(req, tipo, { estirar = true } = {}) {
  const cookie = nombreDe(tipo);
  const crudo = leerCookie(req, cookie);
  if (!crudo) return null;

  const punto = crudo.lastIndexOf('.');
  if (punto <= 0) return null;
  const id = crudo.slice(0, punto);
  const firmaDada = crudo.slice(punto + 1);

  /* Primero la firma: es gratis y frena la basura antes de la base. */
  if (!firmaValida(cookie, id, firmaDada)) return null;

  const clave = hashDe(id);
  const s = await almacen.obtener('sesiones', clave);
  if (!s) return null;

  /* Que el tipo coincida importa: sin esto, una cookie de espectador
     legitimamente firmada podria presentarse en la ranura de dueño si
     alguien copiara el valor de una cookie a la otra. */
  if (s.tipo !== tipo) return null;

  if ((s.ultimo ?? s.creada) + DURA < Date.now()) {
    await almacen.quitar('sesiones', clave);
    return null;
  }

  if (estirar && Date.now() - (s.ultimo ?? 0) > REFRESCAR_CADA) {
    /* deslizante: se usa, se estira. Sin await: que el pedido no
       espere a Mongo para algo que a nadie le importa si tarda. */
    almacen.poner('sesiones', clave, { ...s, ultimo: Date.now() })
      .catch(e => console.warn('[sesion] no se pudo refrescar:', e.name));
  }

  return {
    clave,
    tipo: s.tipo,
    usuario: s.usuario,
    nombre: s.nombre,
    slug: s.slug ?? '',
    creada: s.creada,
  };
}

/** Cierra la sesion de este pedido. Devuelve si habia una. */
export async function cerrar(req, tipo) {
  /* Sin estirar: ver el comentario de `leer`. */
  const s = await leer(req, tipo, { estirar: false });
  if (!s) return false;
  await almacen.quitar('sesiones', s.clave);
  return true;
}

/**
 * Saca las sesiones vencidas. Se llama al arrancar; no hace falta un
 * reloj para esto porque `leer` ya tira las vencidas que aparecen.
 */
export async function podar() {
  const ahora = Date.now();
  const todas = await almacen.listar('sesiones');
  let cuantas = 0;
  for (const s of todas) {
    if ((s.ultimo ?? s.creada ?? 0) + DURA < ahora) {
      await almacen.quitar('sesiones', s.id);
      cuantas++;
    }
  }
  return cuantas;
}
