/* ============================================================
   Cliente SSE del bus de Sala, con reconexion propia.

   EventSource reconecta solo cuando la conexion se corta en medio
   del stream (por ejemplo si se cae la red), pero NO reconecta
   cuando el servidor responde con un error HTTP definitivo como
   404: ahi el navegador lo trata como fallo final, dispara 'error'
   y se queda cerrado para siempre. Como en Fase 0 el servidor puede
   no tener todavia la ruta lista, o el slug puede estar mal, hace
   falta un reintento propio por arriba con espera creciente (tope
   30s) para no quedar mirando una conexion muerta.

   Los tipos de evento con nombre que el servidor manda (ademas del
   'message' por defecto) crecen por fase: 'estado' en Fase 0,
   despues 'chat' y 'reloj'. Para que sumar uno nuevo sea trivial se
   listan una sola vez aca abajo, en TIPOS_CONOCIDOS.
   ============================================================ */
(() => {
  const TIPOS_CONOCIDOS = ['estado', 'chat', 'reloj'];

  const ESPERA_INICIAL = 1000;   // ms antes del primer reintento
  const ESPERA_TOPE    = 30000;  // ms, tope del backoff

  /* Conecta al bus de un slug y llama a alRecibir(tipo, datos) por
     cada evento. Devuelve un objeto con cerrar() y el estado actual
     de la conexion, para que la pagina pueda mostrarlo. */
  function conectar(slug, alRecibir) {
    let fuente = null;
    let cerrado = false;
    let espera = ESPERA_INICIAL;
    let temporizadorReintento = null;
    let estado = 'conectando';

    // Llama al handler del usuario protegido: que un handler explote
    // no debe tumbar la conexion ni afectar a los demas eventos.
    const notificar = (tipo, crudo) => {
      let datos;
      try { datos = JSON.parse(crudo); }
      catch { return; } // JSON invalido: se ignora ese mensaje, nomas
      try { alRecibir(tipo, datos); }
      catch (e) { console.error('[Sala.bus]', tipo, e); }
    };

    const limpiarTemporizador = () => {
      if (temporizadorReintento !== null) {
        clearTimeout(temporizadorReintento);
        temporizadorReintento = null;
      }
    };

    const cerrarFuente = () => {
      if (fuente) {
        fuente.close();
        fuente = null;
      }
    };

    const programarReintento = () => {
      if (cerrado) return;
      estado = 'cortado';
      limpiarTemporizador();
      temporizadorReintento = setTimeout(abrir, espera);
      espera = Math.min(espera * 2, ESPERA_TOPE);
    };

    function abrir() {
      if (cerrado) return;
      cerrarFuente();
      estado = 'conectando';

      let candidata;
      try {
        candidata = new EventSource(`/eventos/${encodeURIComponent(slug)}`);
      } catch (e) {
        // por ejemplo abierta como archivo suelto (file://): no hay
        // forma de conectar, se avisa por consola y listo.
        console.warn('[Sala.bus] no se pudo conectar:', e.message);
        programarReintento();
        return;
      }
      fuente = candidata;

      fuente.addEventListener('open', () => {
        estado = 'conectado';
        espera = ESPERA_INICIAL; // se reconecto: se resetea el backoff
      });

      fuente.addEventListener('error', () => {
        // EventSource ya reintenta solo en cortes de red, pero no en
        // errores HTTP definitivos (404, etc): ahi queda en
        // readyState CLOSED y hay que reabrir nosotros.
        if (candidata.readyState === EventSource.CLOSED) {
          programarReintento();
        } else {
          estado = 'conectando';
        }
      });

      for (const tipo of TIPOS_CONOCIDOS) {
        fuente.addEventListener(tipo, ev => notificar(tipo, ev.data));
      }
      fuente.addEventListener('message', ev => notificar('message', ev.data));
    }

    abrir();

    return {
      cerrar() {
        cerrado = true;
        limpiarTemporizador();
        cerrarFuente();
        estado = 'cortado';
      },
      get estado() { return estado; },
    };
  }

  // Si se llama conectar() de nuevo, se cierra la conexion anterior
  // para no dejarla colgada consumiendo el stream sin que nadie mire.
  let conexionActual = null;

  window.Sala = {
    conectar(slug, alRecibir) {
      if (conexionActual) conexionActual.cerrar();
      conexionActual = conectar(slug, alRecibir);
      return conexionActual;
    },
  };
})();
