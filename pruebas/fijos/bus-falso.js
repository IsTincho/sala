/* ============================================================
   Un cliente SSE de mentira, enganchado a un canal de verdad.

   Existe para poder preguntar QUE SALE por el bus publico, que es una
   pregunta de seguridad y no de formato: el bus de un canal lo
   escucha cualquiera (en la Fase 2, todo el que este mirando la
   peli), asi que lo que viaja por ahi es informacion publicada.

   No simula SSE: le pasa a `canales.suscribir` un `res` que guarda
   cada `write` tal cual, o sea el cable de verdad.
   ============================================================ */

import { EventEmitter } from 'node:events';
import * as canales from '../../servidor/canales.js';

/**
 * Se engancha al canal `slug` y guarda todo lo que le escriban.
 * @returns {{escrito:string[], tipos:function():string[], datos:function():object[], cerrar:function():void}}
 */
export function escuchar(slug) {
  const escrito = [];
  const req = new EventEmitter();
  const res = {
    writeHead() {},
    write(trozo) { escrito.push(String(trozo)); return true; },
    end() {},
  };
  canales.suscribir(slug, req, res);

  const datos = () => escrito
    .join('')
    .split('\n')
    .filter(l => l.startsWith('data: '))
    .map(l => { try { return JSON.parse(l.slice(6)); } catch { return { tipo: '(ilegible)' }; } });

  return {
    escrito,
    datos,
    tipos: () => datos().map(d => d.tipo),
    cerrar() { req.emit('close'); },
  };
}
