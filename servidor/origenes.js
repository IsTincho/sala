/* ============================================================
   De que dominios es este sitio.

   Suena a una linea y son dos cosas distintas que conviene que salgan
   del MISMO lugar, porque si se contradicen el login deja de andar:

     1. CSRF. Los POST del espectador exigen, ademas de la cookie
        `SameSite=Lax`, que el `Origin` del pedido sea uno de los
        nuestros. Una pagina ajena no puede hacer que alguien escriba
        en un chat sin darse cuenta.
     2. Los redirect de OAuth. Kick y Twitch vuelven a la URL que les
        mandamos, y esa URL tiene que ser la del dominio desde el que
        la persona esta mirando: si no, termina el login en otro
        dominio, con la cookie puesta ahi, y al volver al link que
        tenia abierto no esta conectada.

   ---------------------------------------------------------------
   POR QUE HAY MAS DE UN ORIGEN

   El servidor vive en Railway, pero el sitio ademas se sirve desde
   `multichat-osmiumstudio.pages.dev`, un Worker de Cloudflare Pages
   que reenvia todo a Railway (`cloudflare/multichat/_worker.js`) y
   manda `X-Forwarded-Host`. Para el navegador son dos sitios con dos
   juegos de cookies; para el servidor es un proceso solo. Los dos son
   nuestros y los dos tienen que funcionar.

   ---------------------------------------------------------------
   LA LISTA ES EXPLICITA, NUNCA "CUALQUIERA"

   `URL_BASE` entra siempre. `ORIGENES` (separados por coma) agrega los
   demas. Lo que no este en la lista no vale, ni para un POST ni para
   armar un redirect: aceptar el `Origin` que venga seria no tener
   defensa de CSRF, y armar el redirect con el `Host` que venga seria
   dejar que alguien mande a nuestros usuarios a completar un login
   contra un dominio suyo.

   OJO AL AGREGAR UNO: un origen en esta lista tiene que estar tambien
   registrado como redirect en la app de Kick y en la de Twitch
   (`<origen>/oauth/kick/volver` y `<origen>/oauth/twitch/volver`), o
   el login desde ese dominio va a rebotar del lado de ellos. Esta
   anotado en TAREAS-DUENO.md.
   ============================================================ */

/** Un origen normalizado (`https://host[:puerto]`), o '' si no sirve. */
function normalizar(crudo) {
  const s = String(crudo ?? '').trim();
  if (!s) return '';
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
    return u.origin;
  } catch {
    return '';
  }
}

const BASE = normalizar(process.env.URL_BASE);

/* La lista entera, sin repetidos y con URL_BASE primero: es el que se
   usa cuando el pedido no dice de donde viene. */
const LISTA = (() => {
  const vistos = new Set();
  const salida = [];
  for (const crudo of [BASE, ...String(process.env.ORIGENES ?? '').split(',')]) {
    const o = normalizar(crudo);
    if (!o || vistos.has(o)) continue;
    vistos.add(o);
    salida.push(o);
  }
  return Object.freeze(salida);
})();

/** Los origenes desde los que se sirve este sitio. */
export const permitidos = () => LISTA;

/** Si un `Origin` es uno de los nuestros. */
export const esNuestro = origen => Boolean(normalizar(origen)) && LISTA.includes(normalizar(origen));

/**
 * El origen desde el que se pidio ESTO, si es uno de los nuestros.
 *
 * Detras del proxy de Cloudflare el `Host` que llega es el de Railway
 * y el dominio de verdad viene en `X-Forwarded-Host`; sin proxy no hay
 * forwarded y manda el `Host`. Las dos cabeceras las puede escribir
 * cualquiera, y por eso el resultado se compara contra la lista: lo
 * que no esta en la lista devuelve '' y quien llama usa `URL_BASE`.
 */
export function delPedido(req) {
  const host = req?.headers?.['x-forwarded-host'] ?? req?.headers?.host ?? '';
  if (!host) return '';
  /* Con varios saltos la cabecera puede venir como "a, b": el primero
     es el que vio el navegador. */
  const primero = String(host).split(',')[0].trim();
  /* El mismo criterio que `baseDe`: sin forwarded, http (que es lo
     correcto en local). El proxy de Cloudflare siempre lo manda. */
  const protocolo = req?.headers?.['x-forwarded-proto'] ?? 'http';
  const candidato = normalizar(`${String(protocolo).split(',')[0].trim()}://${primero}`);
  return candidato && LISTA.includes(candidato) ? candidato : '';
}

/**
 * Si este pedido viene de una pagina nuestra. Es la mitad de la
 * defensa de CSRF; la otra mitad es `SameSite=Lax`.
 *
 * SIN `Origin` NO PASA. Los navegadores lo mandan en todo POST de
 * `fetch`, asi que exigirlo no rompe a nadie que use la pagina, y
 * aceptar los pedidos sin `Origin` dejaria la puerta abierta a
 * cualquier cliente que simplemente no lo mande.
 */
export const mismoOrigen = req => esNuestro(req?.headers?.origin);
