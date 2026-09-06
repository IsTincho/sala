/* ============================================================
   EventSource falso, para probar paginas/comun/bus.js en node.

   Existe por una razon puntual: la REGLA DE DESPACHO de SSE. Un
   mensaje que trae `event: kick` se entrega unicamente al listener
   'kick' y NO dispara 'message'; uno sin `event:` se entrega a
   'message'. Esa regla es la que hacia que los eventos del webhook no
   llegaran a ninguna pagina, y un test que mire el stream crudo no la
   ve: pasa igual con el cliente roto.

   Asi que esto implementa esa regla tal como la implementa el
   navegador, y nada mas de lo que bus.js usa: addEventListener,
   close(), readyState y la constante CLOSED.
   ============================================================ */

import http from 'node:http';

/* bus.js pide '/eventos/<slug>', una ruta relativa. En el navegador la
   resuelve el documento; aca hay que decirle contra que servidor. */
let raiz = 'http://127.0.0.1';
export function fijarRaiz(url) { raiz = url; }

export class EventSourceFalso {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;

  constructor(ruta) {
    this.url = new URL(ruta, raiz).toString();
    this.readyState = EventSourceFalso.CONNECTING;
    this._oyentes = new Map();
    this._buffer = '';

    this._pedido = http.get(this.url, { headers: { Accept: 'text/event-stream' } }, (res) => {
      this._res = res;
      if (res.statusCode !== 200) {
        res.resume();
        this._cerrarConError();
        return;
      }
      this.readyState = EventSourceFalso.OPEN;
      this._emitir('open', {});
      res.setEncoding('utf8');
      res.on('data', (trozo) => this._alTrozo(trozo));
      res.on('end', () => this._cerrarConError());
    });
    this._pedido.on('error', () => this._cerrarConError());
  }

  addEventListener(tipo, fn) {
    if (!this._oyentes.has(tipo)) this._oyentes.set(tipo, []);
    this._oyentes.get(tipo).push(fn);
  }

  close() {
    this.readyState = EventSourceFalso.CLOSED;
    try { this._pedido.destroy(); } catch { /* ya estaba */ }
    try { this._res?.destroy(); } catch { /* ya estaba */ }
  }

  _emitir(tipo, evento) {
    for (const fn of this._oyentes.get(tipo) ?? []) fn(evento);
  }

  _cerrarConError() {
    if (this.readyState === EventSourceFalso.CLOSED) return;
    this.readyState = EventSourceFalso.CLOSED;
    this._emitir('error', {});
  }

  _alTrozo(trozo) {
    this._buffer += trozo;
    let corte;
    while ((corte = this._buffer.indexOf('\n\n')) >= 0) {
      const bloque = this._buffer.slice(0, corte);
      this._buffer = this._buffer.slice(corte + 2);
      this._despachar(bloque);
    }
  }

  _despachar(bloque) {
    let tipo = '';
    const datos = [];
    for (const linea of bloque.split('\n')) {
      if (!linea || linea.startsWith(':')) continue;   // comentario (los pings)
      const i = linea.indexOf(':');
      const campo = i < 0 ? linea : linea.slice(0, i);
      let valor = i < 0 ? '' : linea.slice(i + 1);
      if (valor.startsWith(' ')) valor = valor.slice(1);
      if (campo === 'event') tipo = valor;
      else if (campo === 'data') datos.push(valor);
    }
    if (!datos.length) return;   // sin data no se despacha nada

    /* ACA ESTA LA REGLA: con `event:` va solo a ese nombre; sin
       `event:`, va a 'message'. */
    this._emitir(tipo || 'message', { data: datos.join('\n') });
  }
}
