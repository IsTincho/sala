/* ============================================================
   El cobro, detras de una interfaz de dos funciones.

     crearCheckout(creador)   -> { url } a donde mandar al creador
     procesarWebhook(pedido)  -> que le paso al plan de quien

   Y nada mas. Todo lo demas —precios, clientes, reintentos, facturas—
   vive del lado del proveedor, que es de lo que se trata elegir uno.

   ---------------------------------------------------------------
   POR QUE PADDLE, Y POR QUE LA INTERFAZ IGUAL

   Stripe no abre cuentas en Argentina (stripe.com/global: en
   Latinoamerica solo Brasil y Mexico), asi que el recomendado de
   PLAN.md es Paddle: es merchant of record, acepta vendedores
   argentinos y liquida en USD. Contra eso esta construido.

   Pero el dueño todavia no eligio (tarea 14 de TAREAS-DUENO.md), y una
   decision que no esta tomada no se puede hornear adentro del codigo.
   Lo que hace esta interfaz es que cambiar de proveedor sea UN ARCHIVO
   NUEVO y una linea en el registro de aca abajo, en vez de una cirugia
   por todo el servidor:

     1. escribir `servidor/cobro-stripe.js` con las mismas dos
        funciones mas `listo()` y `porQueNoEstaListo()`;
     2. agregarlo a IMPLEMENTACIONES;
     3. poner COBRO_PROVEEDOR=stripe en Railway.

   Ninguna ruta, ninguna pagina y ningun otro modulo se enteran.

   ---------------------------------------------------------------
   SIN CLAVES, ARRANCA IGUAL Y DICE QUE LE FALTA

   Es la regla del resto del proyecto: un modulo sin configurar no
   rompe el arranque, contesta que no esta listo y dice el nombre de la
   variable que falta (nunca su valor). Hoy, sin claves, `/panel`
   muestra "el cobro todavia no esta configurado" en vez de un boton
   que lleva a un error.

   ---------------------------------------------------------------
   QUIEN PUEDE PONER QUE PLAN

   Este modulo devuelve 'pago' o 'vencido' y nunca 'amigo' ni
   'pendiente'; los otros dos son del dueño. Esa regla no se cumple
   aca por buena voluntad: `creadores.ponerPlan` la exige con el
   parametro `quien`, asi que un proveedor nuevo que devuelva 'amigo'
   se cae con un error en vez de regalar el servicio.
   ============================================================ */

import { numeroDeEntorno } from './entorno.js';
import * as paddle from './cobro-paddle.js';

/* El proveedor "ninguno": lo que corre mientras el dueño no eligio.
   No es un stub vacio, es la respuesta honesta de un sistema sin
   configurar. */
const ninguno = {
  nombre: 'ninguno',
  listo: () => false,
  porQueNoEstaListo: () =>
    'todavia no se eligio proveedor de cobro (COBRO_PROVEEDOR). ' +
    'Ver TAREAS-DUENO.md, tarea 14.',
  async crearCheckout() {
    throw new Error('no hay proveedor de cobro configurado');
  },
  async procesarWebhook() {
    return { ok: false, motivo: 'no hay proveedor de cobro configurado' };
  },
};

/* Para agregar Stripe: `import * as stripe from './cobro-stripe.js';`
   y una linea mas aca. */
const IMPLEMENTACIONES = {
  paddle,
  ninguno,
};

/* Paddle por defecto y no "ninguno", porque es contra lo que esta
   construido y es lo que recomienda PLAN.md. Sin claves cargadas se
   comporta igual que "ninguno" —dice que no esta listo— asi que el
   default no cambia nada hasta que el dueño cargue las variables. */
const elegido = () => String(process.env.COBRO_PROVEEDOR ?? 'paddle').trim().toLowerCase();

function impl() {
  const nombre = elegido();
  const encontrado = IMPLEMENTACIONES[nombre];
  if (encontrado) return encontrado;
  console.warn(`[cobro] COBRO_PROVEEDOR="${nombre}" no existe; se sigue sin cobro. ` +
               `Los que hay: ${Object.keys(IMPLEMENTACIONES).join(', ')}`);
  return ninguno;
}

/* --------------------------------------------------------- interfaz */

/** Como se llama el proveedor que esta puesto. */
export const proveedor = () => impl().nombre;

/** Si se le puede pedir un checkout ahora mismo. */
export const listo = () => impl().listo();

/** Que falta para que este listo, con el nombre de la variable. */
export const porQueNoEstaListo = () => impl().porQueNoEstaListo();

/**
 * El precio que se le muestra al creador.
 *
 * OJO: es una ETIQUETA, no el precio de verdad. El precio que se cobra
 * es el que esta cargado en el proveedor, y este servidor no lo
 * consulta. Estan separados a proposito (el brief pide precio y moneda
 * por variable), pero eso significa que si alguien cambia el precio en
 * Paddle y no cambia la variable, la pantalla miente. Es la unica
 * cosa de este modulo que puede estar desincronizada, y por eso esta
 * escrita aca.
 */
export const precio = () => ({
  monto: numeroDeEntorno('PRECIO_MENSUAL', 0, { minimo: 0 }),
  moneda: String(process.env.MONEDA ?? 'USD').toUpperCase().slice(0, 3),
});

/**
 * Una URL de checkout alojado para que un creador se suscriba.
 *
 * @param {{slug:string, nombre?:string}} creador
 * @returns {Promise<{url:string}>}
 */
export async function crearCheckout(creador) {
  return impl().crearCheckout(creador);
}

/**
 * Un webhook del proveedor, ya con el cuerpo CRUDO.
 *
 * Crudo importa igual que en el webhook de Kick: la firma se calcula
 * sobre los bytes que llegaron. Volver a serializar el JSON cambia un
 * espacio y la firma no da.
 *
 * @param {{cabeceras:object, crudo:Buffer|string}} pedido
 * @returns {Promise<{ok:boolean, slug?:string, plan?:string, vence?:number, motivo?:string, evento?:string}>}
 */
export async function procesarWebhook(pedido) {
  return impl().procesarWebhook(pedido);
}
