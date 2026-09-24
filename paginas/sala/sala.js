/* ============================================================
   La Sala (/sala/:slug): la cámara del streamer, la película y el
   chat real de Kick, todo en la misma pantalla y en el mismo segundo
   para todos.

   ---------------------------------------------------------------
   CÓMO SE SINCRONIZA, EN UNA FRASE

   El servidor no manda "andá al segundo 812". Manda cuatro números
   una sola vez por cambio —qué video, cuándo arrancó el tramo, si
   está congelado y en qué segundo estaba al arrancar— y cada
   navegador hace la cuenta con SU reloj corregido contra el del
   servidor. Trescientas personas mirando cuestan trescientas
   conexiones abiertas y ni un byte de video por Railway.

   ---------------------------------------------------------------
   EL RELOJ DEL SERVIDOR, Y POR QUÉ NO SE USA `reloj.posicion`

   El evento de reloj trae `posicion` y `ahora`, que son una foto del
   instante en que se mandó. Sirven para mirar y para depurar, y NO se
   usan para calcular: cuando alguien se conecta, el reloj le llega
   adentro del evento `estado`, y ese objeto está guardado en el canal
   desde que se tocó play, así que su `posicion` puede tener horas de
   viejo. La posición se calcula SIEMPRE con
   `offsetInicial + (ahora - empezoEn)`, que no envejece.

   ---------------------------------------------------------------
   NADA DE innerHTML: los mensajes los escribe gente desconocida y el
   render compartido (comun/mensajes.js) arma todo con textContent.
   ============================================================ */
(() => {
  const parametros = new URLSearchParams(location.search);
  const modoDemo = parametros.get('demo') === '1';

  /* El canal sale de la URL: /sala/istincho. `?canal=` es para poder
     abrir el archivo suelto mientras se diseña. */
  const slug = String(
    parametros.get('canal') || location.pathname.split('/').filter(Boolean)[1] || '',
  ).toLowerCase();

  // ---------- elementos ----------

  const contenedor = document.getElementById('sala');
  const tituloSala = document.getElementById('titulo-sala');
  const contadorEspectadores = document.getElementById('contador-espectadores');
  const estadoConexion = document.getElementById('estado-conexion');

  const cajaCamara = document.getElementById('caja-camara');
  const columnaVideo = document.getElementById('columna-video');
  const video = document.getElementById('video-peli');
  const textoEspera = document.getElementById('texto-espera');
  const tituloPeli = document.getElementById('titulo-peli');

  const botonPlay = document.getElementById('boton-play');
  const botonMudo = document.getElementById('boton-mudo');
  const controlVolumen = document.getElementById('control-volumen');
  const selectSubtitulos = document.getElementById('select-subtitulos');
  const botonPantallaCompleta = document.getElementById('boton-pantalla-completa');
  const estadoSincro = document.getElementById('estado-sincro');

  const listaChat = document.getElementById('lista-chat');
  const botonAbajo = document.getElementById('boton-abajo');
  const contadorNuevos = document.getElementById('contador-nuevos');

  const avisoSala = document.getElementById('aviso-sala');
  const textoAviso = document.getElementById('texto-aviso');
  const botonCerrarAviso = document.getElementById('boton-cerrar-aviso');

  const bandaEntrar = document.getElementById('banda-entrar');
  const linkEntrar = document.getElementById('link-entrar');
  const filaEspectador = document.getElementById('fila-espectador');
  const nombreEspectador = document.getElementById('nombre-espectador');
  const botonSalir = document.getElementById('boton-salir');

  const campoTexto = document.getElementById('campo-texto');
  const contadorCaracteres = document.getElementById('contador-caracteres');
  const botonEnviar = document.getElementById('boton-enviar');
  const linkSuscribirse = document.getElementById('link-suscribirse');

  if (tituloSala && slug) tituloSala.textContent = slug;

  // ---------- avisos ----------

  let temporizadorAviso = null;

  function avisar(texto, { autoOcultar = false } = {}) {
    textoAviso.textContent = texto;
    avisoSala.hidden = false;
    if (temporizadorAviso) clearTimeout(temporizadorAviso);
    temporizadorAviso = autoOcultar ? setTimeout(ocultarAviso, 8000) : null;
  }

  function ocultarAviso() {
    avisoSala.hidden = true;
    if (temporizadorAviso) { clearTimeout(temporizadorAviso); temporizadorAviso = null; }
  }

  botonCerrarAviso.addEventListener('click', ocultarAviso);

  // ---------- la cámara ----------

  /* El iframe se arma con createElement y encodeURIComponent, nunca
     interpolando el slug en HTML: viene de la URL, o sea de afuera. */
  function ponerCamara() {
    if (!slug || cajaCamara.children.length) return;
    const marco = document.createElement('iframe');
    marco.src = `https://player.kick.com/${encodeURIComponent(slug)}?autoplay=true&muted=true`;
    marco.title = `Cámara de ${slug}`;
    /* `allow` y NO `allowfullscreen`: si están los dos, el navegador
       avisa por consola que uno pisa al otro. `allow` es el moderno y
       el que además habilita el autoplay del embed. */
    marco.allow = 'autoplay; fullscreen; picture-in-picture';
    marco.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
    cajaCamara.appendChild(marco);
  }

  // ---------- el reloj del servidor ----------

  let desfase = 0;          // ms a sumarle al reloj local para tener el del servidor
  const ahoraServidor = () => Date.now() + desfase;

  /* Un `fetch` sin timeout no falla nunca: espera. Un `/api/hora`
     colgado (un proxy que se traga la respuesta, una red que se fue a
     mitad de camino) dejaba esta función esperando para siempre, y con
     ella todo lo que viniera después. Tres segundos son de sobra para
     pedir la hora; pasados, se corta y se sigue sin desfase medido. */
  const ESPERA_HORA = 3000;   // ms

  /* Tres muestras y se elige la del viaje más corto. La ida y vuelta
     más rápida es la que menos ruido tiene: en la más lenta no se sabe
     qué parte del tiempo fue de ida y qué parte de vuelta. */
  async function medirDesfase(muestras = 3) {
    let mejor = null;
    for (let i = 0; i < muestras; i++) {
      const control = new AbortController();
      const corte = setTimeout(() => control.abort(), ESPERA_HORA);
      try {
        const salida = Date.now();
        const r = await fetch('/api/hora', { cache: 'no-store', signal: control.signal });
        const llegada = Date.now();
        if (!r.ok) continue;
        const datos = await r.json();
        const viaje = llegada - salida;
        const candidato = { viaje, desfase: Number(datos.ahora) + viaje / 2 - llegada };
        if (Number.isFinite(candidato.desfase) && (!mejor || viaje < mejor.viaje)) mejor = candidato;
      } catch { /* un intento perdido no rompe nada: quedan los otros */ }
      finally { clearTimeout(corte); }
      /* Si el primero se colgó hasta el corte, los otros dos se van a
         colgar igual: son nueve segundos de espera para el mismo
         resultado. Se deja para la medición de dentro de diez minutos. */
      if (control.signal.aborted) break;
    }
    if (mejor) desfase = mejor.desfase;
    return desfase;
  }

  // ---------- el reloj de la sala ----------

  let relojActual = null;

  /** En qué segundo de la película tendría que estar esta pantalla. */
  function objetivo(r = relojActual) {
    if (!r || r.estado === 'detenido' || !r.videoId) return null;
    const empezoEn = Number(r.empezoEn ?? 0);
    const base = Number(r.offsetInicial ?? 0);
    const hasta = r.estado === 'pausado' ? Number(r.pausadoEn ?? empezoEn) : ahoraServidor();
    const posicion = base + (hasta - empezoEn) / 1000;
    const duracion = Number(r.duracion ?? 0);
    return Math.max(0, duracion > 0 ? Math.min(posicion, duracion) : posicion);
  }

  // ---------- el reproductor ----------

  /* OJO CON LO QUE MIDE ESTE NÚMERO, porque no es lo que pide el
     criterio de aceptación.

     1,5 s es la deriva de ESTA pantalla contra el reloj del servidor.
     El criterio de aceptación es la diferencia ENTRE dos pantallas, y
     dos pantallas cada una a 1,49 s del servidor y para lados opuestos
     dan casi 3 s entre sí. En el papel, entonces, el umbral tendría que
     ser 0,75.

     Se deja en 1,5 igual, y a propósito: la deriva real es de un solo
     signo. Lo que la produce es el player, que se atrasa cuando
     bufferea, cuando el decodificador pierde un cuadro o cuando la
     pestaña estuvo en segundo plano; ninguna de esas cosas ADELANTA un
     `<video>`. Con las dos pantallas atrasándose para el mismo lado, la
     diferencia entre ellas es la diferencia de sus atrasos, no la suma.
     Medido con dos pestañas reales: 0,04 s.

     Bajarlo a 0,75 tiene un costo concreto: cada corrección es un seek,
     y un seek en HLS es un salto visible y un pedido de segmento nuevo.
     Corregir el doble de seguido para tapar un caso que la física del
     player no produce es empeorar lo que se ve.

     Si algún día aparecen dos pantallas de verdad a más de 1,5 s, el
     lugar donde mirar es éste, y el arreglo es 0,75 y no otra cosa. */
  const DERIVA_TOLERADA = 1.5;      // segundos
  const CADA_SINCRO = 10000;        // ms
  const DESPUES_DE_CORREGIR = 5000; // ms de gracia antes de volver a tocar

  let hls = null;
  let urlCargada = '';
  let pausaLocal = false;           // la persona pausó a mano
  let ultimaCorreccion = 0;

  function hayHls() {
    return Boolean(window.Hls && typeof window.Hls.isSupported === 'function' && window.Hls.isSupported());
  }

  function soltarHls() {
    if (!hls) return;
    try { hls.destroy(); } catch { /* ya estaba muerto */ }
    hls = null;
  }

  function cargarVideo(url) {
    if (!url || url === urlCargada) return;
    urlCargada = url;
    soltarHls();

    if (hayHls()) {
      hls = new window.Hls({ enableWorker: true, lowLatencyMode: false });
      hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
        llenarSubtitulos();
        sincronizar({ forzar: true });
        /* Y se vuelve a pedir play. El primer intento sale antes de que
           haya un solo segmento cargado y el navegador lo aborta; sin
           este segundo intento, la película se queda parada en el
           segundo cero sin un error que lo explique. */
        aplicarReproduccion();
      });
      hls.on(window.Hls.Events.SUBTITLE_TRACKS_UPDATED, llenarSubtitulos);
      hls.on(window.Hls.Events.ERROR, (_evento, datos) => {
        if (!datos?.fatal) return;
        /* Los dos fatales que se pueden recuperar se recuperan; el
           tercero no tiene vuelta y hay que decirlo en vez de dejar la
           pantalla negra. */
        if (datos.type === window.Hls.ErrorTypes.NETWORK_ERROR) { hls.startLoad(); return; }
        if (datos.type === window.Hls.ErrorTypes.MEDIA_ERROR) { hls.recoverMediaError(); return; }
        soltarHls();
        avisar('no se pudo cargar el video');
      });
      hls.loadSource(url);
      hls.attachMedia(video);
      return;
    }

    /* Safari y iOS reproducen HLS solos. Es el único caso en que no
       hace falta hls.js, y es justo el navegador donde hls.js no
       funciona. */
    if (typeof video.canPlayType === 'function' && video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = url;
      return;
    }

    avisar('este navegador no puede reproducir el video (y hls.js no cargó)');
  }

  function descargarVideo() {
    soltarHls();
    urlCargada = '';
    video.pause();
    /* removeAttribute + load(), en ese orden, es la única forma de que
       el navegador SUELTE el archivo. Poner `src = ''` hace que pida
       la propia URL de la página como si fuera un video. */
    try { video.removeAttribute('src'); video.load?.(); } catch { /* nada */ }
  }

  /**
   * Pone el video donde dice el reloj.
   *
   * Cuatro guardas antes de tocar `currentTime`, y cada una evita un
   * salto que se ve:
   *   - sin reloj no hay a dónde ir;
   *   - si la persona pausó a mano, es su pantalla;
   *   - si está buscando o todavía no tiene datos, la deriva que se
   *     mide no es la deriva real: es el buffer;
   *   - y después de corregir se dan unos segundos, porque un seek
   *     tarda en asentarse y volver a medir enseguida encadena saltos.
   */
  function sincronizar({ forzar = false } = {}) {
    const meta = objetivo();
    if (meta === null) return null;
    if (pausaLocal && !forzar) return null;

    const ahora = Date.now();
    if (!forzar) {
      if (video.seeking) return null;
      if (Number(video.readyState ?? 0) < 3) return null;
      if (ahora - ultimaCorreccion < DESPUES_DE_CORREGIR) return null;
    }

    const deriva = Number(video.currentTime ?? 0) - meta;
    if (forzar || Math.abs(deriva) > DERIVA_TOLERADA) {
      video.currentTime = meta;
      ultimaCorreccion = ahora;
      mostrarSincro(0, true);
      return deriva;
    }
    mostrarSincro(deriva, false);
    return deriva;
  }

  function mostrarSincro(deriva, corregido) {
    if (!estadoSincro) return;
    estadoSincro.textContent = corregido
      ? 'sincronizado'
      : `desfasado ${deriva >= 0 ? '+' : ''}${deriva.toFixed(1)} s`;
  }

  /** Si la SALA está pasando la película ahora mismo, más allá de
      lo que haga esta pantalla. */
  function salaEnMarcha() {
    return Boolean(relojActual && relojActual.videoId && relojActual.estado === 'reproduciendo');
  }

  /** Lo que el reloj dice que tiene que estar pasando en el player. */
  function aplicarReproduccion() {
    if (!relojActual || relojActual.estado === 'detenido') { video.pause(); return; }
    if (relojActual.estado === 'pausado') { video.pause(); return; }
    if (pausaLocal) return;
    if (video.paused) intentarReproducir();
  }

  function intentarReproducir() {
    /* Se arranca MUDO. Ningún navegador deja reproducir con sonido sin
       que la persona toque algo, y quedarse esperando ese toque
       significa arrancar la peli tarde y desincronizado. Mudo arranca
       siempre; el botón del parlante devuelve el sonido y no mueve
       nada más. */
    let promesa;
    try { promesa = video.play(); }
    catch { promesa = null; }
    if (promesa && typeof promesa.catch === 'function') {
      promesa.catch(error => {
        /* Un play() rechazado NO siempre es autoplay bloqueado. Cuando
           entra un reloj nuevo, la carga del video anterior se corta y
           la promesa vieja rechaza con AbortError: avisar ahí sería
           decirle a la persona que toque play justo cuando el player
           está haciendo lo correcto solo. El único que significa
           "hace falta un gesto" es NotAllowedError. */
        console.warn('[sala] play() rechazado:', error?.name, error?.message);
        if (error && error.name === 'AbortError') return;
        pausaLocal = true;
        pintarBotonPlay();
        avisar('tocá ▶ para empezar: el navegador no deja arrancar solo');
      });
    }
    pintarBotonPlay();
  }

  function pintarBotonPlay() {
    const enMarcha = !video.paused && !pausaLocal;
    botonPlay.textContent = enMarcha ? '❚❚' : '▶';
    botonPlay.setAttribute('aria-label', enMarcha ? 'Pausar' : 'Reproducir');
  }

  function pintarBotonMudo() {
    botonMudo.textContent = video.muted || video.volume === 0 ? '🔇' : '🔊';
    botonMudo.setAttribute('aria-pressed', String(Boolean(video.muted)));
    botonMudo.setAttribute('aria-label', video.muted ? 'Activar sonido' : 'Silenciar');
  }

  botonPlay.addEventListener('click', () => {
    if (video.paused) {
      /* Volver de una pausa local vuelve a donde va la sala, no donde
         se quedó: si no, la persona sigue mirando el pasado. */
      pausaLocal = false;
      sincronizar({ forzar: true });
      /*
       * EL BOTÓN NO ARRANCA NADA POR SU CUENTA.
       *
       * Este botón existe porque el navegador puede no dejar arrancar
       * solo, no para pelearse con el reloj de la sala. Si arrancara
       * con la sala en pausa, la película correría unos segundos y la
       * sincronización de cada diez segundos la tironearía de vuelta:
       * la persona ve el video moverse y después dar un salto para
       * atrás, sin entender por qué. Quien decide si se reproduce es
       * `aplicarReproduccion`, que con la sala en pausa deja el video
       * quieto; acá sólo se dice por qué no pasó nada.
       */
      aplicarReproduccion();
      if (!salaEnMarcha()) {
        avisar(relojActual && relojActual.estado === 'pausado'
          ? 'la sala está en pausa: arranca sola cuando la reanuden'
          : 'todavía no empezó la película', { autoOcultar: true });
      }
    } else {
      pausaLocal = true;
      video.pause();
    }
    pintarBotonPlay();
  });

  botonMudo.addEventListener('click', () => {
    video.muted = !video.muted;
    if (!video.muted && Number(video.volume) === 0) {
      video.volume = 1;
      controlVolumen.value = '100';
    }
    guardarPreferencias();
    pintarBotonMudo();
  });

  controlVolumen.addEventListener('input', () => {
    const v = Math.min(100, Math.max(0, Number(controlVolumen.value) || 0));
    video.volume = v / 100;
    if (v > 0) video.muted = false;
    guardarPreferencias();
    pintarBotonMudo();
  });

  botonPantallaCompleta.addEventListener('click', () => {
    const caja = document.getElementById('caja-video');
    try {
      if (document.fullscreenElement) document.exitFullscreen?.();
      else caja?.requestFullscreen?.();
    } catch { /* algunos navegadores lo niegan sin gesto; no rompe nada */ }
  });

  /* Volumen y mudo se recuerdan por navegador: es una preferencia de
     esta pantalla, no algo que el servidor tenga que saber. */
  const CLAVE_PREFERENCIAS = 'sala-video';

  function guardarPreferencias() {
    try {
      localStorage.setItem(CLAVE_PREFERENCIAS, JSON.stringify({
        volumen: Number(video.volume),
        mudo: Boolean(video.muted),
      }));
    } catch { /* modo privado, file://: no es crítico */ }
  }

  function leerPreferencias() {
    video.muted = true;                 // el default siempre es mudo
    video.volume = 1;
    try {
      const guardado = JSON.parse(localStorage.getItem(CLAVE_PREFERENCIAS) ?? 'null');
      if (guardado && Number.isFinite(guardado.volumen)) {
        video.volume = Math.min(1, Math.max(0, guardado.volumen));
      }
      /* El mudo guardado solo puede APAGAR el sonido, nunca prenderlo:
         si alguien vuelve a la sala, la peli tiene que arrancar igual
         (mudo) y no quedarse esperando un gesto que quizás no llegue. */
    } catch { /* nada */ }
    controlVolumen.value = String(Math.round(video.volume * 100));
    pintarBotonMudo();
  }

  // ---------- subtítulos ----------

  /* Las pistas salen de hls.js cuando hay hls.js, y de las textTracks
     nativas cuando la reproduce el navegador solo (Safari, iOS). Son
     las mismas del `#EXT-X-MEDIA` que escribió el script de subida. */
  const pistasDeSubtitulos = () => {
    if (hls) return hls.subtitleTracks ?? [];
    const nativas = video.textTracks ?? [];
    return Array.from(nativas).filter(p => p.kind === 'subtitles' || p.kind === 'captions');
  };

  function llenarSubtitulos() {
    const pistas = pistasDeSubtitulos();
    /* Se rearma entero: hls.js descubre las pistas después del
       manifiesto y puede avisar más de una vez. */
    selectSubtitulos.textContent = '';
    const ninguno = document.createElement('option');
    ninguno.value = '-1';
    ninguno.textContent = 'Sin subtítulos';
    selectSubtitulos.appendChild(ninguno);

    pistas.forEach((pista, i) => {
      const opcion = document.createElement('option');
      opcion.value = String(i);
      opcion.textContent = pista.name || pista.label || pista.lang || pista.language || `Pista ${i + 1}`;
      selectSubtitulos.appendChild(opcion);
    });

    selectSubtitulos.hidden = pistas.length === 0;
    selectSubtitulos.value = String(hls ? (hls.subtitleTrack ?? -1) : elegidaNativa(pistas));
    return pistas.length;
  }

  const elegidaNativa = pistas => pistas.findIndex(p => p.mode === 'showing');

  selectSubtitulos.addEventListener('change', () => {
    const elegida = Number(selectSubtitulos.value);
    if (hls) {
      hls.subtitleTrack = elegida;
      /* hls.js necesita las dos: el índice elige cuál, y `display` es
         lo que la hace visible. */
      if (hls.subtitleDisplay !== undefined) hls.subtitleDisplay = elegida >= 0;
      return;
    }
    pistasDeSubtitulos().forEach((pista, i) => {
      pista.mode = i === elegida ? 'showing' : 'disabled';
    });
  });

  /* En el camino nativo no hay evento de hls.js que avise: las pistas
     aparecen con los metadatos del video. */
  video.addEventListener?.('loadedmetadata', () => { if (!hls) llenarSubtitulos(); });

  /* La red de seguridad del play. `canplay` llega cada vez que el
     video tiene con qué seguir, incluido después de un corte: si el
     reloj dice que la sala está reproduciendo y esta pantalla no,
     acá se vuelve a intentar. Sin esto, cualquier play() abortado
     (por una carga que lo pisó, por un rebuffer) deja la película
     parada para siempre. */
  video.addEventListener?.('canplay', () => aplicarReproduccion());

  /* Volver a la pestaña.
   *
   * Chrome PAUSA SOLO el video mudo de una pestaña que no se ve
   * ("video-only background media was paused to save power"), y al
   * volver no lo arranca de nuevo. Alguien que se va a otra pestaña
   * media hora vuelve a una película congelada media hora atrás. Acá
   * se vuelve a la posición de la sala y se sigue. */
  document.addEventListener?.('visibilitychange', () => {
    if (document.hidden) return;
    sincronizar({ forzar: true });
    aplicarReproduccion();
  });

  // ---------- qué se ve: espera o película ----------

  function aplicarReloj(nuevo) {
    relojActual = nuevo ?? null;
    const detenido = !relojActual || relojActual.estado === 'detenido' || !relojActual.videoId;

    if (contenedor) contenedor.dataset.espera = detenido ? 'si' : 'no';
    textoEspera.hidden = !detenido;
    if (columnaVideo) columnaVideo.hidden = detenido;
    tituloPeli.textContent = detenido ? '' : (relojActual.titulo ?? '');

    if (detenido) {
      textoEspera.textContent = 'Todavía no empezó la película. Mientras tanto, la cámara.';
      descargarVideo();
      if (estadoSincro) estadoSincro.textContent = '';
      return;
    }

    cargarVideo(relojActual.url);
    /* Un reloj nuevo es una orden: se salta aunque la persona hubiera
       pausado a mano, porque cambió lo que se está pasando. */
    sincronizar({ forzar: true });
    aplicarReproduccion();
    pintarBotonPlay();
  }

  // ---------- el chat ----------

  const TOPE_MENSAJES = 300;
  const DISTANCIA_PEGADO = 40;

  let pausadoElScroll = false;
  let nuevosSinVer = 0;

  /* El respaldo a texto de una insignia que no carga. La Sala hoy sólo
     recibe Kick, y las de Kick no tienen imagen, así que esto no pinta
     nada todavía; va igual porque el render es el MISMO de /chat y el
     día que la Sala muestre Twitch, sin esta línea una imagen caída
     dejaría el ícono de imagen rota en la única página donde nadie
     estaría mirando. */
  window.SalaMensajes.vigilarInsignias(listaChat);

  listaChat.addEventListener('scroll', () => {
    const pegado = listaChat.scrollHeight - listaChat.scrollTop - listaChat.clientHeight < DISTANCIA_PEGADO;
    if (!pegado && !pausadoElScroll) {
      pausadoElScroll = true;
      listaChat.setAttribute('aria-live', 'off');
    } else if (pegado && pausadoElScroll) {
      despausarScroll();
    }
  });

  botonAbajo.addEventListener('click', () => {
    despausarScroll();
    listaChat.scrollTop = listaChat.scrollHeight;
  });

  function despausarScroll() {
    pausadoElScroll = false;
    nuevosSinVer = 0;
    botonAbajo.hidden = true;
    listaChat.setAttribute('aria-live', 'polite');
    podarChat();
  }

  function podarChat() {
    while (listaChat.children.length > TOPE_MENSAJES) {
      listaChat.removeChild(listaChat.firstElementChild);
    }
  }

  /*
   * NO SE FILTRA POR RED ACÁ, y es a propósito.
   *
   * A la Sala llega solo Kick porque el SERVIDOR filtra el bus por
   * conexión (`canales.js`, `leDaEl`). Volver a filtrar acá haría que
   * una regresión en esa puerta fuera invisible: el chat de Twitch
   * seguiría saliendo por el cable hacia todas las pestañas y nadie se
   * enteraría. Una sola fuente de verdad, y es el servidor.
   */
  function manejarMensaje(datos) {
    const li = window.SalaMensajes.crear(datos);
    listaChat.appendChild(li);
    if (pausadoElScroll) {
      nuevosSinVer += 1;
      contadorNuevos.textContent = String(nuevosSinVer);
      botonAbajo.hidden = false;
    } else {
      listaChat.scrollTop = listaChat.scrollHeight;
      podarChat();
    }
  }

  // ---------- quién está mirando ----------

  function mostrarConectados(cuantos) {
    if (!Number.isFinite(Number(cuantos))) return;
    contadorEspectadores.textContent = String(Number(cuantos));
  }

  // ---------- entrar y salir ----------

  let puedoEscribir = false;

  function pintarSesion({ entrado, nombre, puedeEscribir, bloqueado }) {
    puedoEscribir = Boolean(entrado && puedeEscribir);
    bandaEntrar.hidden = Boolean(entrado);
    filaEspectador.hidden = !entrado;
    nombreEspectador.textContent = entrado ? String(nombre ?? '') : '';

    campoTexto.disabled = !puedoEscribir;
    botonEnviar.disabled = !puedoEscribir;
    // Se le dice POR QUÉ no puede escribir. Con el bloqueo callado, la
    // caja se apagaba sin motivo y el aviso aparecía recién al intentar
    // mandar; y quedarse escribiendo contra una pared que no avisa es
    // peor que un "el creador te bloqueó". Lo dice el servidor
    // (`/api/sala/<slug>/yo`): la página no lo adivina.
    campoTexto.placeholder = puedoEscribir
      ? 'Escribí un mensaje…'
      : bloqueado ? 'el creador te bloqueó en este chat'
        : (entrado ? 'tu permiso de Kick no incluye escribir' : 'Entrá con Kick para escribir…');
  }

  botonSalir.addEventListener('click', () => {
    if (modoDemo) { avisar('modo demo: no se sale de ningún lado'); return; }
    botonSalir.disabled = true;
    fetch(`/api/sala/${encodeURIComponent(slug)}/salir`, { method: 'POST', credentials: 'same-origin' })
      .then(() => location.reload())
      .catch(() => { botonSalir.disabled = false; avisar('no se pudo salir'); });
  });

  function consultarSesion() {
    return fetch(`/api/sala/${encodeURIComponent(slug)}/yo`, { credentials: 'same-origin' })
      .then(r => (r.ok ? r.json() : null))
      .then(datos => { if (datos) pintarSesion(datos); })
      .catch(() => { /* sin respuesta se queda como estaba: sin escribir */ });
  }

  // ---------- escribir ----------

  const LIMITE_CARACTERES = 500;

  function ajustarAltura() {
    campoTexto.style.height = 'auto';
    campoTexto.style.height = campoTexto.scrollHeight + 'px';
  }

  function actualizarContador() {
    const cantidad = [...campoTexto.value].length;
    contadorCaracteres.textContent = `${cantidad}/${LIMITE_CARACTERES}`;
    contadorCaracteres.classList.toggle('excedido', cantidad > LIMITE_CARACTERES);
  }

  campoTexto.addEventListener('input', () => { ajustarAltura(); actualizarContador(); });

  campoTexto.addEventListener('keydown', ev => {
    if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); enviar(); }
  });

  let cuentaRegresiva = null;

  function esperar(segundos) {
    let restante = Math.max(0, Math.round(segundos));
    if (cuentaRegresiva) clearInterval(cuentaRegresiva);
    botonEnviar.disabled = true;
    const paso = () => {
      if (restante <= 0) {
        clearInterval(cuentaRegresiva);
        cuentaRegresiva = null;
        botonEnviar.disabled = !puedoEscribir;
        ocultarAviso();
        return;
      }
      avisar(`esperá ${restante} s`);
      restante -= 1;
    };
    paso();
    cuentaRegresiva = setInterval(paso, 1000);
  }

  let enviando = false;

  function enviar() {
    const texto = campoTexto.value.trim();
    if (!texto) return;
    if (modoDemo) { avisar('modo demo: no se envía nada'); return; }
    if (!puedoEscribir || enviando || cuentaRegresiva) return;

    enviando = true;
    botonEnviar.disabled = true;

    fetch(`/api/sala/${encodeURIComponent(slug)}/chat`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texto }),
    })
      .then(async r => {
        let datos = null;
        try { datos = await r.json(); } catch { /* sin cuerpo o inválido */ }

        if (r.status === 200) {
          campoTexto.value = '';
          ajustarAltura();
          actualizarContador();
          ocultarAviso();
          /* El mensaje NO se pinta acá: vuelve por el webhook como
             cualquier otro. Pintarlo de una lo mostraría dos veces y,
             peor, lo mostraría aunque Kick lo hubiera retenido. */
          return;
        }
        if (r.status === 429) { esperar(Number(datos?.esperar ?? 2)); return; }
        if (r.status === 401) {
          pintarSesion({ entrado: false, nombre: '', puedeEscribir: false });
          avisar(datos?.error || 'entrá con Kick para escribir');
          return;
        }
        avisar(datos?.error || `no se pudo enviar (http ${r.status})`);
      })
      .catch(() => avisar('no se pudo conectar con el servidor'))
      .finally(() => {
        enviando = false;
        if (!cuentaRegresiva) botonEnviar.disabled = !puedoEscribir;
      });
  }

  botonEnviar.addEventListener('click', enviar);

  // ---------- el bus ----------

  function conectar() {
    if (!slug) {
      avisar('no hay canal en la dirección: probá con /sala/<canal>');
      return;
    }
    /* `redes: ['kick']`: la Sala es el chat de Kick. Si el creador abre
       su chat a la comunidad con Twitch (Fase 5.1), el bus público de
       esta sala pasa a mandar Twitch, y acá no tiene nada que hacer: la
       gente de la peli escribe a Kick y no puede contestarle a alguien
       de Twitch. Se le pide al SERVIDOR que no lo mande, así que esta
       página sigue sin filtrar nada (ver la prueba "la página NO
       filtra por red"). */
    const conexion = window.Sala.conectar(slug, (tipo, datos) => {
      if (tipo === 'chat') return manejarMensaje(datos);
      if (tipo === 'reloj') return aplicarReloj(datos);
      if (tipo === 'presencia') return mostrarConectados(datos.conectados);
      if (tipo === 'estado') {
        mostrarConectados(datos.conectados);
        aplicarReloj(datos.reloj);
      }
    }, { redes: ['kick'] });

    /* El estado de la conexión se mira solo: el bus reconecta pero no
       avisa, y una sala muda sin cartel es una sala rota que parece
       tranquila. */
    setInterval(() => {
      estadoConexion.textContent = conexion?.estado === 'conectado' ? 'en vivo' : 'reconectando…';
    }, 1000);
    return conexion;
  }

  // ---------- arranque ----------

  function iniciarDemo() {
    const script = document.createElement('script');
    /* Absoluta a propósito: la página vive en /sala/<canal>, así que
       una ruta relativa apuntaría a /sala/<canal>/… y no existe. */
    script.src = '/sala/demo.js';
    script.onload = () => {
      const demo = window.SalaDemoSala;
      estadoConexion.textContent = 'demo (sin servidor)';
      pintarSesion(demo.sesion());
      mostrarConectados(demo.conectados());
      aplicarReloj(demo.reloj());
      demo.mensajes().forEach(manejarMensaje);
      setInterval(() => manejarMensaje(demo.siguiente()), 2500);
    };
    document.head.appendChild(script);
  }

  async function iniciar() {
    leerPreferencias();
    ponerCamara();
    aplicarReloj(null);
    actualizarContador();

    if (linkEntrar) {
      /* Volver a ESTA sala después del login. `destino` sólo acepta
         rutas de este mismo sitio (lo valida el servidor). */
      linkEntrar.href = '/oauth/kick/entrar?rol=espectador&destino=' +
        encodeURIComponent(`/sala/${slug}`);
    }

    /* Suscribirse es un link de Kick, no una ruta nuestra: la
       suscripción se paga y se maneja allá. El slug viene de la URL,
       así que va escapado como el del iframe de la cámara. */
    if (linkSuscribirse) {
      linkSuscribirse.hidden = !slug;
      if (slug) linkSuscribirse.href = `https://kick.com/${encodeURIComponent(slug)}/subscribe`;
    }

    if (modoDemo) { iniciarDemo(); return; }

    pintarSesion({ entrado: false, nombre: '', puedeEscribir: false });
    consultarSesion();

    /*
     * PRIMERO EL CABLE, DESPUÉS LA HORA.
     *
     * Esto era `await medirDesfase()` antes de conectar: un
     * `/api/hora` lento o colgado dejaba la sala muda para siempre y
     * sin un solo error a la vista —no conectaba al bus, así que no
     * llegaba ni el reloj ni el chat, y desde afuera parecía que se
     * había roto todo—. La medición ya no bloquea a nadie: el desfase
     * arranca en cero (el reloj de una máquina rara vez está a más de
     * un segundo) y se acomoda cuando la medición llega.
     */
    conectar();
    setInterval(() => sincronizar(), CADA_SINCRO);

    medirDesfase()
      .then(() => sincronizar({ forzar: true }))
      .catch(() => { /* sin desfase medido se sigue con el reloj local */ });
    /* El reloj de una máquina se corre solo con las horas; se vuelve a
       medir de a ratos para que la peli no se despegue de a poco. */
    setInterval(medirDesfase, 10 * 60 * 1000);
  }

  /* Se expone lo justo para poder probar la sincronización sin un
     navegador: son las tres cuentas que deciden lo que se ve. */
  window.SalaPagina = {
    objetivo,
    sincronizar,
    aplicarReloj,
    manejarMensaje,
    fijarDesfase: d => { desfase = Number(d) || 0; },
    /* Olvidar que recién se corrigió. Existe para las pruebas: sin
       esto, para ejercitar una corrección normal habría que dormir los
       cinco segundos de gracia en cada caso, y una prueba que duerme
       cinco segundos es una prueba que nadie corre. */
    olvidarCorreccion: () => { ultimaCorreccion = 0; },
    get pausaLocal() { return pausaLocal; },
  };

  iniciar();
})();
