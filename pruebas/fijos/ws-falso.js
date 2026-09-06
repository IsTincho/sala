/* ============================================================
   Servidor WebSocket falso para probar ConexionEventSub sin pegarle
   a Twitch de verdad y sin sumar una dependencia como `ws`.

   Hace a mano lo minimo del protocolo (RFC 6455):
     - el handshake HTTP 101 con el Sec-WebSocket-Accept calculado
     - tramas de texto servidor->cliente SIN mascara (asi vienen
       siempre las que manda el servidor)
     - una trama de cierre con codigo
     - leer las tramas que mande el cliente (vienen enmascaradas) lo
       justo para detectar un close y cerrar prolijo; nuestro cliente
       nunca escribe otra cosa en el socket.
   ============================================================ */

import http from 'node:http';
import crypto from 'node:crypto';

const MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function aceptarClave(clave) {
  return crypto.createHash('sha1').update(clave + MAGIC).digest('base64');
}

function armarTrama(opcode, payload) {
  const largo = payload.length;
  let cabecera;
  if (largo < 126) {
    cabecera = Buffer.from([0x80 | opcode, largo]);
  } else if (largo < 65536) {
    cabecera = Buffer.alloc(4);
    cabecera[0] = 0x80 | opcode;
    cabecera[1] = 126;
    cabecera.writeUInt16BE(largo, 2);
  } else {
    cabecera = Buffer.alloc(10);
    cabecera[0] = 0x80 | opcode;
    cabecera[1] = 127;
    cabecera.writeBigUInt64BE(BigInt(largo), 2);
  }
  return Buffer.concat([cabecera, payload]);
}

/** Una conexion aceptada por el servidor falso. */
class ConexionFalsa {
  constructor(socket) {
    this.socket = socket;
    this._buffer = Buffer.alloc(0);
    socket.on('data', (trozo) => this._alDato(trozo));
  }

  /** Manda un objeto como notificacion JSON de texto. */
  enviarJson(obj) {
    this.enviarTexto(JSON.stringify(obj));
  }

  enviarTexto(texto) {
    if (this.socket.destroyed) return;
    this.socket.write(armarTrama(0x1, Buffer.from(texto, 'utf8')));
  }

  /** Trama de cierre con codigo. No cierra el socket TCP: eso lo hace el cliente al responder. */
  cerrar(codigo = 1000) {
    if (this.socket.destroyed) return;
    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(codigo, 0);
    this.socket.write(armarTrama(0x8, payload));
  }

  /** Corta el socket TCP directamente, sin handshake de cierre. */
  destruir() {
    this.socket.destroy();
  }

  _alDato(trozo) {
    this._buffer = Buffer.concat([this._buffer, trozo]);
    // Alcanza con detectar un frame de close entrante (enmascarado) y responder.
    while (this._buffer.length >= 2) {
      const b0 = this._buffer[0];
      const b1 = this._buffer[1];
      const opcode = b0 & 0x0f;
      const mascarado = Boolean(b1 & 0x80);
      let largo = b1 & 0x7f;
      let offset = 2;
      if (largo === 126) {
        if (this._buffer.length < 4) return;
        largo = this._buffer.readUInt16BE(2);
        offset = 4;
      } else if (largo === 127) {
        if (this._buffer.length < 10) return;
        largo = Number(this._buffer.readBigUInt64BE(2));
        offset = 10;
      }
      const largoMascara = mascarado ? 4 : 0;
      const total = offset + largoMascara + largo;
      if (this._buffer.length < total) return; // trama incompleta, esperar mas datos

      if (opcode === 0x8) {
        // el cliente cerro: se responde con close y se corta el socket
        try { this.cerrar(1000); } catch { /* ya cerrado */ }
        this.socket.end();
      }
      this._buffer = this._buffer.subarray(total);
    }
  }
}

/** Servidor falso: `alConectar` recibe cada ConexionFalsa nueva. */
export class ServidorWsFalso {
  constructor() {
    this.conexiones = new Set();
    this.alConectar = null;
    this._http = http.createServer((_req, res) => { res.statusCode = 404; res.end(); });
    this._http.on('upgrade', (req, socket) => {
      const clave = req.headers['sec-websocket-key'];
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${aceptarClave(clave)}\r\n` +
        '\r\n',
      );
      const conexion = new ConexionFalsa(socket);
      this.conexiones.add(conexion);
      socket.on('close', () => this.conexiones.delete(conexion));
      this.alConectar?.(conexion);
    });
  }

  /** Arranca a escuchar en un puerto libre y devuelve la URL ws://. */
  async escuchar() {
    await new Promise((resolve) => this._http.listen(0, '127.0.0.1', resolve));
    const { port } = this._http.address();
    return `ws://127.0.0.1:${port}`;
  }

  async cerrar() {
    for (const c of this.conexiones) c.destruir();
    await new Promise((resolve) => this._http.close(() => resolve()));
  }
}
