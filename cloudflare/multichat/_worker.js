/* ============================================================
   multichat-osmiumstudio.pages.dev: la puerta de entrada linda.

   No sirve nada propio. Todo pedido se reenvia tal cual al servidor de
   Railway y la respuesta vuelve igual, incluido el SSE de /eventos (el
   cuerpo se pasa como stream, sin juntarlo). Asi el dominio de Cloudflare
   y el de Railway muestran exactamente lo mismo y hay una sola fuente de
   verdad: el servidor.

   Por que proxy y no una copia estatica de las paginas: con una copia,
   el HTML viviria en otro origen y las cookies de sesion (SameSite=Lax)
   no viajarian al servidor. Con el proxy, para el navegador todo es un
   solo sitio y las fases que piden login funcionan igual.

   Lo unico que se reescribe es el Location de las redirecciones que
   apuntan a Railway, para que el visitante no salte de dominio.
   ============================================================ */

const ORIGEN = 'https://sala-production-2289.up.railway.app';

/* Cabeceras que no se reenvian: las pone Cloudflare o son de este salto. */
const SIN_REENVIAR = ['host', 'cf-connecting-ip', 'cf-ipcountry', 'cf-ray', 'cf-visitor', 'x-forwarded-proto', 'x-real-ip'];

export default {
  async fetch(pedido) {
    const url = new URL(pedido.url);
    const destino = new URL(url.pathname + url.search, ORIGEN);

    const cabeceras = new Headers(pedido.headers);
    for (const c of SIN_REENVIAR) cabeceras.delete(c);
    cabeceras.set('x-forwarded-host', url.host);
    cabeceras.set('x-forwarded-proto', 'https');
    const ip = pedido.headers.get('cf-connecting-ip');
    if (ip) cabeceras.set('x-forwarded-for', ip);

    const conCuerpo = !['GET', 'HEAD'].includes(pedido.method);
    const respuesta = await fetch(destino, {
      method: pedido.method,
      headers: cabeceras,
      body: conCuerpo ? pedido.body : undefined,
      redirect: 'manual',
    });

    const salida = new Headers(respuesta.headers);
    const location = salida.get('location');
    if (location && location.startsWith(ORIGEN)) {
      salida.set('location', url.origin + location.slice(ORIGEN.length));
    }

    return new Response(respuesta.body, {
      status: respuesta.status,
      statusText: respuesta.statusText,
      headers: salida,
    });
  },
};
