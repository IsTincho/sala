/* ============================================================
   Plan B para el chat de Twitch: IRC anonimo.

   ---------------------------------------------------------------
   PARA QUE EXISTE ESTO

   EventSub por WebSocket es el camino oficial y el que usamos. Pero
   es una sola conexion contra un solo servicio: si Twitch tiene un
   mal dia, o el token del dueño pierde el scope, o la suscripcion se
   revoca, el chat de Twitch se apaga entero y en /chat no se ve nada
   sin ningun error que lo explique.

   El IRC de Twitch es el protocolo viejo, sigue andando, y en modo
   anonimo NO NECESITA TOKEN: cualquiera puede entrar como
   `justinfanNNNN` y leer el chat de un canal publico. O sea que este
   plan B funciona incluso en el caso en que el vinculo del dueño es
   justamente lo que se rompio.

   Es de SOLO LECTURA. Un justinfan no puede escribir. Mandar sigue
   yendo por Helix con el token del dueño: si eso falla, falla, y se
   avisa.

   ---------------------------------------------------------------
   CUANDO SE PRENDE

   No es un reemplazo, es una red de contencion: se prende cuando
   EventSub acumula mas de 3 fallos seguidos y se apaga cuando
   EventSub vuelve. Mientras los dos esten prendidos van a llegar
   mensajes duplicados; el dedupe por id de mensaje (que es el mismo
   en las dos vias) lo resuelve arriba, en chat.js.

   ---------------------------------------------------------------
   LO QUE NO ESTA DOCUMENTADO

   El modo anonimo con nick `justinfan` NO figura en docs de Twitch:
   esta confirmado en sus foros oficiales de desarrolladores y lo usa
   toda libreria de chat que existe. Es la unica parte de este
   proyecto que se apoya en algo no documentado, y por eso es el plan
   B y no el plan A. Si algun dia deja de andar, /chat lo dice: el
   modo aparece en el indicador de salud.

   Puerto 6697 con TLS. El 6667 sin cifrar sigue abierto pero Twitch
   avisa que lo va a dar de baja, y ademas mandar el chat de alguien
   en claro por la red no es algo que hagamos.
   ============================================================ */

import tls from 'node:tls';
import { deIrc } from './mensajes.js';

export const HOST = 'irc.chat.twitch.tv';
export const PUERTO = 6697;

/* Tope de la espera entre reintentos. Mas que esto es dejar el chat
   apagado; menos es martillar a Twitch cuando el problema es de
   ellos. */
const ESPERA_TOPE = 60_000;

/* Si no llega NADA en este tiempo, la conexion se da por muerta.
   Twitch manda un PING cada ~5 minutos, asi que 7 sin una sola trama
   quiere decir que el socket esta abierto contra nadie: pasa, y sin
   esto queda mudo para siempre sin cerrarse. */
const SILENCIO_MAXIMO = 7 * 60 * 1000;

/* --------------------------------------------------------- parseo */

/**
 * Desescapa el valor de un tag IRCv3.
 *
 * Las secuencias son cuatro y estan fijadas por la especificacion:
 * `\s` es UN ESPACIO (no whitespace generico, que es el error
 * clasico), `\:` es punto y coma, `\\` es barra, y `\r` / `\n` son
 * los saltos. Una barra seguida de cualquier otra cosa se descarta.
 *
 * Importa de verdad en `reply-parent-msg-body`, que es texto de una
 * persona y esta lleno de espacios.
 */
export function desescaparTag(valor) {
  const s = String(valor ?? '');
  let salida = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '\\') { salida += s[i]; continue; }
    const siguiente = s[++i];
    if (siguiente === undefined) break;          // barra suelta al final: se cae
    if (siguiente === 's') salida += ' ';
    else if (siguiente === ':') salida += ';';
    else if (siguiente === 'r') salida += '\r';
    else if (siguiente === 'n') salida += '\n';
    else salida += siguiente;                     // incluye \\ -> \
  }
  return salida;
}

/**
 * Parte una linea de IRC en sus pedazos.
 *
 *   [@tag=valor;tag2=valor] [:prefijo] COMANDO [params] [:resto]
 *
 * @returns {{tags:Map<string,string>, prefijo:string, comando:string,
 *            params:string[], resto:string}|null}
 */
export function parsearLinea(linea) {
  let resto = String(linea ?? '').trim();
  if (!resto) return null;

  const tags = new Map();
  if (resto[0] === '@') {
    const corte = resto.indexOf(' ');
    const crudo = corte < 0 ? resto.slice(1) : resto.slice(1, corte);
    resto = corte < 0 ? '' : resto.slice(corte + 1);
    for (const par of crudo.split(';')) {
      if (!par) continue;
      const igual = par.indexOf('=');
      if (igual < 0) tags.set(par, '');
      else tags.set(par.slice(0, igual), desescaparTag(par.slice(igual + 1)));
    }
  }

  let prefijo = '';
  if (resto[0] === ':') {
    const corte = resto.indexOf(' ');
    prefijo = corte < 0 ? resto.slice(1) : resto.slice(1, corte);
    resto = corte < 0 ? '' : resto.slice(corte + 1);
  }

  /* El ultimo parametro puede empezar con ':' y entonces se lleva
     todo lo que queda, espacios incluidos. Es la unica forma que
     tiene IRC de mandar un texto con espacios, o sea que es
     exactamente donde viene el mensaje del chat. */
  let cola = '';
  const dosPuntos = resto.indexOf(' :');
  if (resto.startsWith(':')) {
    cola = resto.slice(1);
    resto = '';
  } else if (dosPuntos >= 0) {
    cola = resto.slice(dosPuntos + 2);
    resto = resto.slice(0, dosPuntos);
  }

  const partes = resto.split(' ').filter(Boolean);
  const comando = (partes.shift() ?? '').toUpperCase();
  if (!comando) return null;

  return { tags, prefijo, comando, params: partes, resto: cola };
}

/** El nick de un prefijo `nick!usuario@host`. */
const nickDe = prefijo => String(prefijo ?? '').split('!')[0];

/* ------------------------------------------------------- conexion */

export class ConexionIrc {
  #canal;
  #alMensaje;
  #alEstado;
  #abrirSocket;

  #socket = null;
  #buffer = '';
  #estado = 'cortado';
  #cerrando = false;
  #intentos = 0;
  #timerReintento = null;
  #timerSilencio = null;

  ultimaLlegada = null;

  /**
   * @param {object} opciones
   * @param {string} opciones.canal      slug del canal de Twitch (sin #)
   * @param {function} opciones.alMensaje  recibe el mensaje ya traducido
   * @param {function} [opciones.alEstado]
   * @param {function} [opciones.abrirSocket]  solo para los tests: devuelve
   *        un socket duplex ya conectado en vez de abrir TLS de verdad
   */
  constructor({ canal, alMensaje, alEstado, abrirSocket } = {}) {
    this.#canal = String(canal ?? '').toLowerCase().replace(/^#/, '');
    this.#alMensaje = alMensaje ?? (() => {});
    this.#alEstado = alEstado ?? (() => {});
    this.#abrirSocket = abrirSocket ?? (() => tls.connect({ host: HOST, port: PUERTO }));
  }

  get estado() { return this.#estado; }

  #cambiarEstado(nuevo) {
    if (this.#estado === nuevo) return;
    this.#estado = nuevo;
    this.#alEstado(nuevo);
  }

  conectar() {
    if (!this.#canal) throw new Error('la conexion IRC necesita un canal');
    this.#cerrando = false;
    this.#abrir();
  }

  #abrir() {
    if (this.#cerrando) return;
    this.#cambiarEstado('conectando');
    this.#buffer = '';

    let socket;
    try {
      socket = this.#abrirSocket();
    } catch {
      this.#programarReintento();
      return;
    }
    this.#socket = socket;

    socket.setEncoding?.('utf8');

    const listo = () => {
      if (this.#socket !== socket) return;
      /* El handshake anonimo: capabilities, nick al azar, y adentro.
         No va PASS: un justinfan no se autentica. Se piden `tags`
         (los metadatos del mensaje: color, insignias, emotes) y
         `commands`; NO se pide `membership`, que solo agrega el
         ruido de cada JOIN y PART de cada persona que entra al chat
         y que no mostramos en ningun lado. */
      const nick = `justinfan${10_000 + Math.floor(Math.random() * 80_000)}`;
      this.#mandar('CAP REQ :twitch.tv/tags twitch.tv/commands');
      this.#mandar(`NICK ${nick}`);
      this.#mandar(`JOIN #${this.#canal}`);
      this.#armarTimerSilencio();
      this.#cambiarEstado('conectado');
      this.#intentos = 0;
    };

    /* `secureConnect` es el de tls; `connect` el de un socket pelado
       (los tests). Se escuchan los dos y el que llegue primero gana:
       `listo` es idempotente porque solo manda tres lineas y las dos
       señales nunca se disparan las dos en el mismo socket. */
    socket.once('secureConnect', listo);
    socket.once('connect', listo);
    socket.on('data', trozo => this.#alRecibir(socket, trozo));
    socket.on('error', () => { /* el close que sigue hace el trabajo */ });
    socket.on('close', () => this.#alCerrar(socket));
  }

  #mandar(linea) {
    try { this.#socket?.write(`${linea}\r\n`); }
    catch { /* si el socket murio, el close ya va a reconectar */ }
  }

  #alRecibir(socket, trozo) {
    if (this.#socket !== socket) return;   // socket viejo que todavia respira
    this.ultimaLlegada = new Date();
    this.#armarTimerSilencio();

    this.#buffer += trozo;
    /* Se corta por \r\n y lo que queda sin terminar se guarda: una
       linea de IRC puede llegar partida entre dos paquetes TCP, y
       procesar la mitad seria descartar el mensaje entero. */
    const lineas = this.#buffer.split('\r\n');
    this.#buffer = lineas.pop() ?? '';
    for (const linea of lineas) this.#procesar(linea);
  }

  #procesar(linea) {
    const m = parsearLinea(linea);
    if (!m) return;

    if (m.comando === 'PING') {
      /* La respuesta tiene que llevar EL MISMO texto del PING. Si no
         se contesta, Twitch corta la conexion sin avisar. */
      this.#mandar(`PONG :${m.resto}`);
      return;
    }

    if (m.comando === 'RECONNECT') {
      /* Twitch avisa que va a cerrar el servidor. Cerrar de este lado
         y dejar que el backoff reconecte es mas barato que esperar el
         corte. */
      this.#socket?.destroy();
      return;
    }

    if (m.comando !== 'PRIVMSG') return;

    const mensaje = deIrc(m.tags, nickDe(m.prefijo), m.resto);
    if (!mensaje?.texto && !mensaje?.emotes?.length) return;
    try { this.#alMensaje(mensaje); }
    catch (e) { console.error('[irc] error procesando un mensaje:', e?.name ?? 'Error'); }
  }

  #armarTimerSilencio() {
    clearTimeout(this.#timerSilencio);
    this.#timerSilencio = setTimeout(() => {
      /* Socket abierto pero mudo: se lo mata para que el camino de
         close haga la reconexion de siempre. */
      this.#socket?.destroy();
    }, SILENCIO_MAXIMO);
    this.#timerSilencio.unref?.();
  }

  #alCerrar(socket) {
    if (this.#socket !== socket) return;
    this.#socket = null;
    clearTimeout(this.#timerSilencio);
    if (this.#cerrando) { this.#cambiarEstado('cortado'); return; }
    this.#cambiarEstado('reconectando');
    this.#programarReintento();
  }

  #programarReintento() {
    if (this.#cerrando) return;
    this.#intentos++;
    const base = Math.min(1000 * 2 ** (this.#intentos - 1), ESPERA_TOPE);
    /* Mitad fija y mitad al azar: si Twitch tira a todo el mundo a la
       vez, que no vuelvan todos en el mismo milisegundo. */
    const espera = base / 2 + Math.random() * (base / 2);
    clearTimeout(this.#timerReintento);
    this.#timerReintento = setTimeout(() => this.#abrir(), espera);
    this.#timerReintento.unref?.();
  }

  cerrar() {
    this.#cerrando = true;
    clearTimeout(this.#timerReintento);
    clearTimeout(this.#timerSilencio);
    const s = this.#socket;
    this.#socket = null;
    if (s) { try { s.destroy(); } catch { /* ya estaba muerto */ } }
    this.#cambiarEstado('cortado');
  }
}
