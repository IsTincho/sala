/* ============================================================
   Chat Global de Sala (/chat). Pagina que vive en una ventana
   aparte, instalada como PWA en un segundo monitor, mientras se
   streamea de noche.

   Tres modos de arranque segun los parametros de la URL:
     ?demo=1        no toca la red para nada: carga chat/demo.js y
                    simula el chat completo. Existe para poder ver
                    la pagina entera abriendola como archivo suelto
                    (file://), sin backend.
     ?canal=<slug>  se conecta al bus de ese slug en vez del que
                    diga /api/estado.
     ?vista=columnas / ?letra=grande / ?filtro=kick|twitch
                    ajustan la vista; se reflejan en la URL con
                    history.replaceState para que el estado sea
                    compartible y sobreviva a un F5.

   Nada de innerHTML con datos que vengan de la red: el texto de
   un mensaje lo escribe gente desconocida, asi que todo pasa por
   textContent / createTextNode.
   ============================================================ */
(() => {
  const parametrosURL = new URLSearchParams(location.search);
  const modoDemo = parametrosURL.get('demo') === '1';

  // ---------- estado de la vista, leido de la URL ----------

  const estado = {
    vista:  parametrosURL.get('vista') === 'columnas' ? 'columnas' : 'mezclada',
    letra:  parametrosURL.get('letra') === 'grande' ? 'grande' : 'normal',
    filtro: ['kick', 'twitch'].includes(parametrosURL.get('filtro')) ? parametrosURL.get('filtro') : 'todas',
  };

  // reescribe la URL sin recargar, para que el link se pueda compartir
  // o refrescar y quede igual. Se borran los parametros en su valor por
  // defecto para no ensuciar la URL con cosas obvias.
  function escribirParametrosURL() {
    const p = new URLSearchParams(location.search);
    if (estado.vista === 'columnas') p.set('vista', 'columnas'); else p.delete('vista');
    if (estado.letra === 'grande') p.set('letra', 'grande'); else p.delete('letra');
    if (estado.filtro !== 'todas') p.set('filtro', estado.filtro); else p.delete('filtro');
    const query = p.toString();
    history.replaceState(null, '', location.pathname + (query ? '?' + query : ''));
  }

  // ---------- elementos ----------

  const areaMensajes    = document.getElementById('area-mensajes');
  const columnaMezclada = document.getElementById('columna-mezclada');
  const columnaKick     = document.getElementById('columna-kick');
  const columnaTwitch   = document.getElementById('columna-twitch');

  const botonVista  = document.getElementById('boton-vista');
  const botonLetra  = document.getElementById('boton-letra');
  const botonFiltro = document.getElementById('boton-filtro');

  const puntitoKick   = document.getElementById('puntito-kick');
  const textoKick     = document.getElementById('texto-kick');
  const puntitoTwitch = document.getElementById('puntito-twitch');
  const textoTwitch   = document.getElementById('texto-twitch');

  const bandaResuscribir = document.getElementById('banda-resuscribir');
  const botonResuscribir = document.getElementById('boton-resuscribir');
  const textoResuscribir = document.getElementById('texto-resuscribir');
  const botonCerrarResuscribir = document.getElementById('boton-cerrar-resuscribir');

  const bandaSesion = document.getElementById('banda-sesion');

  const avisoEnvio       = document.getElementById('aviso-envio');
  const textoAvisoEnvio  = document.getElementById('texto-aviso-envio');
  const botonCerrarAviso = document.getElementById('boton-cerrar-aviso');

  const campoTexto        = document.getElementById('campo-texto');
  const selectDestino     = document.getElementById('select-destino');
  const contadorCaracteres = document.getElementById('contador-caracteres');
  const botonEnviar       = document.getElementById('boton-enviar');

  // ---------- listas de mensajes: una por cada zona de scroll ----------
  // cada entrada guarda su propio estado de pausa/autoscroll, porque en
  // vista columnas cada columna se maneja por separado.

  const listas = {
    mezclada: crearEstadoLista('lista-mezclada', 'boton-abajo-mezclada', 'contador-mezclada'),
    kick:     crearEstadoLista('lista-kick', 'boton-abajo-kick', 'contador-kick'),
    twitch:   crearEstadoLista('lista-twitch', 'boton-abajo-twitch', 'contador-twitch'),
  };

  const TOPE_MENSAJES = 300; // por lista; una noche larga de stream no tiene que comerse la RAM
  const DISTANCIA_PEGADO = 40; // px de tolerancia para considerar que esta "abajo del todo"

  function crearEstadoLista(idLista, idBoton, idContador) {
    const ul = document.getElementById(idLista);
    const boton = document.getElementById(idBoton);
    const contador = document.getElementById(idContador);
    const info = { ul, boton, contador, pausado: false, nuevos: 0 };

    // si el usuario sube mas de ~40px del fondo se pausa el autoscroll;
    // si vuelve a bajar solo (sin tocar el boton) se despausa igual.
    ul.addEventListener('scroll', () => {
      const pegado = estaPegadoAbajo(ul);
      if (!pegado && !info.pausado) {
        info.pausado = true;
        ul.setAttribute('aria-live', 'off'); // pausado: si no, un lector de pantalla lee mensajes que no se estan mirando
      } else if (pegado && info.pausado) {
        despausar(info);
      }
    });

    boton.addEventListener('click', () => {
      despausar(info);
      ul.scrollTop = ul.scrollHeight;
    });

    return info;
  }

  function estaPegadoAbajo(ul) {
    return ul.scrollHeight - ul.scrollTop - ul.clientHeight < DISTANCIA_PEGADO;
  }

  function despausar(info) {
    info.pausado = false;
    info.nuevos = 0;
    info.boton.hidden = true;
    info.ul.setAttribute('aria-live', 'polite');
    // se poda recien al despausar: mientras esta pausado, sacar nodos de
    // arriba correria el scroll del usuario que esta leyendo mensajes
    // viejos. Es mas simple posponer la poda que andar compensando el
    // scrollTop en cada mensaje que entra.
    podarLista(info.ul);
  }

  function podarLista(ul) {
    while (ul.children.length > TOPE_MENSAJES) ul.removeChild(ul.firstElementChild);
  }

  // agrega un mensaje ya armado (li) a una lista y decide si hace
  // autoscroll o si suma al contador de "nuevos" por estar pausada.
  function agregarMensajeALista(info, li) {
    info.ul.appendChild(li);
    if (info.pausado) {
      info.nuevos += 1;
      info.contador.textContent = String(info.nuevos);
      info.boton.hidden = false;
    } else {
      info.ul.scrollTop = info.ul.scrollHeight;
      // pegado abajo: podar de arriba no mueve nada que se este mirando
      podarLista(info.ul);
    }
  }

  // ---------- armado de un <li> de mensaje ----------

  // Vive en comun/mensajes.js, compartido con /sala/:slug: son los
  // mismos mensajes con el mismo formato unico, y dos copias del mismo
  // armado terminan siendo dos comportamientos distintos el dia que
  // alguien arregla uno de los dos.
  const crearElementoMensaje = datos => window.SalaMensajes.crear(datos);

  // ---------- entrada de un mensaje de chat ----------

  // CADA mensaje entra en la lista mezclada Y en la columna de su red,
  // siempre, sin mirar la vista ni el filtro. Lo que decide que se ve
  // es el CSS.
  //
  // Antes se elegia la lista al recibir el mensaje. Se veia bien hasta
  // que se tocaba el boton de vista: los mensajes viejos habian ido a
  // la otra lista y la que aparecia estaba vacia, asi que cambiar de
  // vista en medio de un stream borraba el chat de la pantalla hasta
  // que alguien volviera a hablar. Lo mismo con el filtro, y lo mismo
  // al achicar la ventana, que cambia cual es la vista efectiva.
  //
  // El costo es tener el mensaje dos veces en el DOM (dos listas de
  // 300 como maximo). Es barato al lado de tener que rearmar todo el
  // historial cada vez que alguien toca un boton.
  function manejarMensajeChat(datos) {
    const li = crearElementoMensaje(datos);
    agregarMensajeALista(listas.mezclada, li);
    agregarMensajeALista(datos.red === 'kick' ? listas.kick : listas.twitch, li.cloneNode(true));
  }

  // ---------- vista: mezclada/columnas, letra, filtro ----------

  function aplicarVista() {
    const columnas = estado.vista === 'columnas';
    areaMensajes.dataset.vista = estado.vista;
    columnaMezclada.hidden = columnas;
    botonVista.textContent = 'Vista: ' + (columnas ? 'columnas' : 'mezclada');
    botonVista.setAttribute('aria-pressed', String(columnas));
    aplicarFiltro();   // que columnas se ven depende tambien del filtro
  }

  function aplicarLetra() {
    document.documentElement.style.setProperty('--tam-chat', estado.letra === 'grande' ? '1.25rem' : '0.95rem');
    botonLetra.textContent = 'Letra: ' + (estado.letra === 'grande' ? 'grande' : 'normal');
    botonLetra.setAttribute('aria-pressed', String(estado.letra === 'grande'));
  }

  function aplicarFiltro() {
    const etiqueta = estado.filtro === 'todas' ? 'todas' : estado.filtro === 'kick' ? 'solo Kick' : 'solo Twitch';
    botonFiltro.textContent = 'Filtro: ' + etiqueta;
    botonFiltro.setAttribute('aria-pressed', String(estado.filtro !== 'todas'));

    // en la vista mezclada el filtro esconde los mensajes de la otra
    // red con CSS, no sacandolos de la lista: si se sacaran, volver a
    // "todas" no los podria traer de vuelta.
    listas.mezclada.ul.dataset.filtro = estado.filtro;

    // en columnas el filtro esconde la columna entera
    const columnas = estado.vista === 'columnas';
    columnaKick.hidden = !columnas || estado.filtro === 'twitch';
    columnaTwitch.hidden = !columnas || estado.filtro === 'kick';

    pegarAbajoLasVisibles();
  }

  // Una lista que estaba oculta tiene scrollTop 0 mientras no se ve, y
  // al aparecer mostraria el principio del historial en vez de lo
  // ultimo. Salvo que el usuario la haya pausado a proposito.
  function pegarAbajoLasVisibles() {
    for (const info of Object.values(listas)) {
      if (info.pausado) continue;
      if (info.ul.closest('.columna')?.hidden) continue;
      info.ul.scrollTop = info.ul.scrollHeight;
    }
  }

  botonVista.addEventListener('click', () => {
    estado.vista = estado.vista === 'columnas' ? 'mezclada' : 'columnas';
    aplicarVista();
    escribirParametrosURL();
  });

  botonLetra.addEventListener('click', () => {
    estado.letra = estado.letra === 'grande' ? 'normal' : 'grande';
    aplicarLetra();
    escribirParametrosURL();
  });

  botonFiltro.addEventListener('click', () => {
    estado.filtro = estado.filtro === 'todas' ? 'kick' : estado.filtro === 'kick' ? 'twitch' : 'todas';
    aplicarFiltro();
    escribirParametrosURL();
  });

  aplicarVista();
  aplicarLetra();
  aplicarFiltro();

  // ---------- salud (kick/twitch), banda de "resuscribir" ----------

  let ultimaSalud = null;

  // Un canal en vivo de madrugada sin nadie hablando cumple la
  // condicion toda la noche: la banda roja se quedaba puesta hasta que
  // amaneciera y no habia forma de sacarla.
  let avisoResuscribirCerrado = false;

  function textoDeAntiguedad(segundos, singularCorto) {
    if (segundos < 60) return singularCorto ? `hace ${segundos} s` : `hace ${segundos} s`;
    if (segundos < 3600) return `hace ${Math.floor(segundos / 60)} min`;
    return `hace ${Math.floor(segundos / 3600)} h`;
  }

  function actualizarTextosSalud() {
    if (!ultimaSalud) return;
    const ahora = Date.now();
    const kick = ultimaSalud.kick;
    const twitch = ultimaSalud.twitch;

    const segundosKick = kick.ultima ? Math.floor((ahora - new Date(kick.ultima).getTime()) / 1000) : null;
    let colorKick = 'mal';
    let mensajeKick;
    if (!kick.vinculado) {
      mensajeKick = 'Kick · no vinculado';
    } else if (segundosKick === null) {
      colorKick = 'regular';
      mensajeKick = 'Kick · sin mensajes todavía';
    } else {
      colorKick = segundosKick < 5 * 60 ? 'bien' : segundosKick < 10 * 60 ? 'regular' : 'mal';
      mensajeKick = segundosKick < 60
        ? `Kick · ${textoDeAntiguedad(segundosKick)}`
        : `Kick · sin mensajes ${textoDeAntiguedad(segundosKick)}`;
    }
    puntitoKick.className = 'puntito ' + colorKick;
    textoKick.textContent = mensajeKick;

    let colorTwitch = 'mal';
    let mensajeTwitch;
    if (!twitch.vinculado) {
      mensajeTwitch = 'Twitch · no vinculado';
    } else if (twitch.estado === 'conectado') {
      colorTwitch = 'bien';
      mensajeTwitch = twitch.modo === 'irc' ? 'Twitch · por IRC (plan B)' : 'Twitch · conectado';
    } else if (twitch.estado === 'conectando' || twitch.estado === 'reconectando') {
      colorTwitch = 'regular';
      mensajeTwitch = 'Twitch · ' + (twitch.estado === 'reconectando' ? 'reconectando' : 'conectando');
    } else {
      mensajeTwitch = 'Twitch · cortado';
    }
    puntitoTwitch.className = 'puntito ' + colorTwitch;
    textoTwitch.textContent = mensajeTwitch;

    // aviso especial: el canal esta en vivo segun la API de Kick pero
    // hace mas de 5 minutos que no llega nada, algo se corto en algun
    // lado.
    //
    // El veredicto lo da el SERVIDOR (salud.kick.sospechoso) y la
    // pagina no lo recalcula. Antes lo calculaba aca con otra regla:
    // exigia que hubiera llegado al menos un mensaje, asi que el caso
    // que motiva el aviso —la URL del webhook sin cargar, donde no
    // llega ni el primero— no lo prendia nunca.
    const sospechoso = Boolean(kick.sospechoso);
    // si la condicion se resolvio, el aviso vuelve a estar disponible:
    // cerrarlo silencia ESTE episodio, no todos los que vengan.
    if (!sospechoso) avisoResuscribirCerrado = false;
    bandaResuscribir.hidden = !sospechoso || avisoResuscribirCerrado;
  }

  botonCerrarResuscribir.addEventListener('click', () => {
    avisoResuscribirCerrado = true;
    bandaResuscribir.hidden = true;
  });

  function aplicarSalud(salud) {
    ultimaSalud = salud;
    actualizarTextosSalud();
  }

  // los textos de "hace N" tienen que avanzar solos: la salud llega
  // salteada (SSE cada ~15s), no se puede esperar un evento nuevo para
  // que el reloj se note.
  setInterval(actualizarTextosSalud, 1000);

  botonResuscribir.addEventListener('click', () => {
    // tocar "Resuscribir" vuelve a armar el aviso: si el problema sigue
    // despues de esto, hay que volver a verlo.
    avisoResuscribirCerrado = false;
    if (modoDemo) {
      textoResuscribir.textContent = 'modo demo: no se envía nada';
      return;
    }
    botonResuscribir.disabled = true;
    fetch('/api/chat/resuscribir', { method: 'POST', credentials: 'same-origin' })
      .then(async r => {
        let datos = null;
        try { datos = await r.json(); } catch { /* sin cuerpo o invalido */ }
        textoResuscribir.textContent = (r.ok && datos?.ok)
          ? 'listo, resuscrito'
          : 'no se pudo: ' + (datos?.error || ('http ' + r.status));
      })
      .catch(() => { textoResuscribir.textContent = 'no se pudo conectar con el servidor'; })
      .finally(() => { botonResuscribir.disabled = false; });
  });

  // ---------- caja de escritura ----------

  const CLAVE_DESTINO = 'sala-chat-destino';
  const LIMITE_VISIBLE_CARACTERES = 500;

  try {
    const guardado = localStorage.getItem(CLAVE_DESTINO);
    if (guardado) selectDestino.value = guardado;
  } catch { /* localStorage puede no estar disponible (file://, modo privado) */ }

  selectDestino.addEventListener('change', () => {
    try { localStorage.setItem(CLAVE_DESTINO, selectDestino.value); } catch { /* nada, no es critico */ }
  });

  function ajustarAlturaCampo() {
    campoTexto.style.height = 'auto';
    campoTexto.style.height = campoTexto.scrollHeight + 'px';
  }

  function actualizarContadorCaracteres() {
    const cantidad = [...campoTexto.value].length;
    contadorCaracteres.textContent = `${cantidad}/${LIMITE_VISIBLE_CARACTERES}`;
    contadorCaracteres.classList.toggle('excedido', cantidad > LIMITE_VISIBLE_CARACTERES);
  }

  campoTexto.addEventListener('input', () => {
    ajustarAlturaCampo();
    actualizarContadorCaracteres();
  });

  campoTexto.addEventListener('keydown', ev => {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      enviarMensaje();
    }
  });

  let avisoOcultarTimeout = null;

  function mostrarAviso(texto, { autoOcultar = false } = {}) {
    textoAvisoEnvio.textContent = texto;
    avisoEnvio.hidden = false;
    if (avisoOcultarTimeout) clearTimeout(avisoOcultarTimeout);
    avisoOcultarTimeout = autoOcultar ? setTimeout(ocultarAviso, 8000) : null;
  }

  function ocultarAviso() {
    avisoEnvio.hidden = true;
    if (avisoOcultarTimeout) { clearTimeout(avisoOcultarTimeout); avisoOcultarTimeout = null; }
  }

  botonCerrarAviso.addEventListener('click', ocultarAviso);

  // arma el mensaje de "salio en una red, fallo en la otra" (o el
  // fallo simple si solo se intento una red). Devuelve null si no hace
  // falta avisar nada (las dos, o la unica intentada, salieron bien).
  function armarMensajeDeResultado(datos) {
    const { kick, twitch } = datos;
    if (kick && twitch) {
      if (kick.ok && !twitch.ok) return `salió en Kick, falló en Twitch: ${twitch.motivo}`;
      if (!kick.ok && twitch.ok) return `salió en Twitch, falló en Kick: ${kick.motivo}`;
      if (!kick.ok && !twitch.ok) return `falló en las dos: Kick: ${kick.motivo} · Twitch: ${twitch.motivo}`;
      return null;
    }
    if (kick && !kick.ok) return `falló en Kick: ${kick.motivo}`;
    if (twitch && !twitch.ok) return `falló en Twitch: ${twitch.motivo}`;
    return null;
  }

  let temporizadorCuentaRegresiva = null;

  function iniciarCuentaRegresiva(segundosIniciales) {
    let restante = Math.max(0, Math.round(segundosIniciales));
    if (temporizadorCuentaRegresiva) clearInterval(temporizadorCuentaRegresiva);
    botonEnviar.disabled = true;

    const paso = () => {
      if (restante <= 0) {
        clearInterval(temporizadorCuentaRegresiva);
        temporizadorCuentaRegresiva = null;
        botonEnviar.disabled = false;
        ocultarAviso();
        return;
      }
      mostrarAviso(`esperá ${restante} segundos`);
      restante -= 1;
    };
    paso();
    temporizadorCuentaRegresiva = setInterval(paso, 1000);
  }

  let envioEnCurso = false;

  function enviarMensaje() {
    const texto = campoTexto.value.trim();
    if (!texto) return;

    if (modoDemo) {
      mostrarAviso('modo demo: no se envía nada');
      return;
    }
    if (envioEnCurso || temporizadorCuentaRegresiva) return;

    envioEnCurso = true;
    botonEnviar.disabled = true;

    fetch('/api/chat/enviar', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texto, destino: selectDestino.value }),
    })
      .then(async r => {
        let datos = null;
        try { datos = await r.json(); } catch { /* sin cuerpo o invalido */ }

        if (r.status === 200) {
          campoTexto.value = '';
          ajustarAlturaCampo();
          actualizarContadorCaracteres();
          const mensajeParcial = armarMensajeDeResultado(datos || {});
          if (mensajeParcial) mostrarAviso(mensajeParcial, { autoOcultar: true });
          else ocultarAviso();
        } else if (r.status === 400) {
          mostrarAviso(datos?.error || 'mensaje invalido');
        } else if (r.status === 401) {
          mostrarAviso('no hay sesión de dueño: entrá con Kick en /panel');
        } else if (r.status === 429) {
          iniciarCuentaRegresiva(datos?.esperar ?? 5);
        } else if (r.status === 502) {
          mostrarAviso(datos?.error || 'error del servidor al enviar');
        } else {
          mostrarAviso('no se pudo enviar (http ' + r.status + ')');
        }
      })
      .catch(() => mostrarAviso('no se pudo conectar con el servidor'))
      .finally(() => {
        envioEnCurso = false;
        if (!temporizadorCuentaRegresiva) botonEnviar.disabled = false;
      });
  }

  botonEnviar.addEventListener('click', enviarMensaje);

  function deshabilitarCajaDeEscritura() {
    campoTexto.disabled = true;
    selectDestino.disabled = true;
    botonEnviar.disabled = true;
  }

  // ---------- service worker (instalable como PWA) ----------
  // en file:// y en http sin localhost no existe navigator.serviceWorker:
  // el guard de arriba evita que eso rompa la pagina.
  function registrarServiceWorker() {
    try {
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/sw.js', { scope: '/chat' }).catch(() => { /* no es critico */ });
      }
    } catch { /* nada: no puede romper la pagina */ }
  }

  // ---------- arranque ----------

  function iniciarModoDemo() {
    const script = document.createElement('script');
    script.src = 'chat/demo.js';
    script.onload = () => {
      window.SalaDemo.mensajes().forEach(manejarMensajeChat);
      aplicarSalud(window.SalaDemo.salud());
      setInterval(() => manejarMensajeChat(window.SalaDemo.siguiente()), 2000);
    };
    document.head.appendChild(script);
  }

  function conectarAlBus(slug) {
    if (!slug) {
      mostrarAviso('no hay canal: el servidor no tiene slug configurado. Probá con ?canal=<slug>.');
      return;
    }
    window.Sala.conectar(slug, (tipo, datos) => {
      if (tipo === 'chat') manejarMensajeChat(datos);
    });
  }

  // La salud NO llega por el bus: el bus de un canal es publico (en la
  // Fase 2 lo escucha cualquiera que mire la peli) y esto es
  // informacion de la cuenta del dueño. Se pide contra el endpoint que
  // exige la cookie, cada 15 segundos. El reloj de "hace N" lo mueve
  // aparte el intervalo de un segundo, asi que entre pedido y pedido la
  // pantalla igual avanza.
  const CADA_SALUD = 15000;

  function consultarSalud() {
    fetch('/api/chat/salud', { credentials: 'same-origin' })
      .then(r => {
        if (r.status === 401) {
          bandaSesion.hidden = false;
          deshabilitarCajaDeEscritura();
          return null;
        }
        if (!r.ok) return null;
        bandaSesion.hidden = true;
        return r.json();
      })
      .then(salud => { if (salud) aplicarSalud(salud); })
      .catch(() => { /* un corte suelto no tiene por que borrar lo ultimo que se sabia */ });
  }

  function iniciar() {
    registrarServiceWorker();

    if (modoDemo) {
      iniciarModoDemo();
      return;
    }

    consultarSalud();
    setInterval(consultarSalud, CADA_SALUD);

    const canalParametro = parametrosURL.get('canal');
    if (canalParametro) {
      conectarAlBus(canalParametro);
      return;
    }

    // sin ?canal=, el slug sale de /api/estado (el canal del dueño)
    fetch('/api/estado')
      .then(r => { if (!r.ok) throw new Error('http ' + r.status); return r.json(); })
      .then(info => conectarAlBus(info.slug))
      .catch(() => mostrarAviso('no se pudo consultar /api/estado para saber el canal'));
  }

  iniciar();
})();
