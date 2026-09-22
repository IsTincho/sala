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

   Y un modo mas, que no sale de un parametro sino del CAMINO:
     /chat/<slug>   el chat de esa sala, abierto a su comunidad
                    (PLAN-MULTICHAT.md). Sin salud (es de la cuenta del
                    creador). Le pregunta a /api/chat/<slug>/abierto si
                    esta abierto y con que redes; cerrado, muestra
                    "este chat esta cerrado" y se vuelve a fijar sola
                    cada tanto. El slug sale del camino y de ningun
                    otro lado: ?canal= no lo cambia.

                    Y se puede escribir (Fases 5.2 y 5.3): cada quien
                    conecta SU Kick y/o SU Twitch y el mensaje sale en
                    el chat de verdad con su nombre. El selector
                    muestra solo las redes que conecto Y que el creador
                    abrio; con las dos, "las dos" manda uno solo a las
                    dos. Que se puede hacer lo dice /api/chat/<slug>/yo,
                    nunca la pagina por su cuenta.

   Nada de innerHTML con datos que vengan de la red: el texto de
   un mensaje lo escribe gente desconocida, asi que todo pasa por
   textContent / createTextNode.
   ============================================================ */
(() => {
  const parametrosURL = new URLSearchParams(location.search);
  const modoDemo = parametrosURL.get('demo') === '1';

  // /chat/<slug>. Un %ZZ en el camino no puede tirar la pagina entera:
  // se trata como si no hubiera slug.
  const slugPublico = (() => {
    const m = /^\/chat\/([^/]+)\/?$/.exec(location.pathname);
    if (!m) return '';
    try { return decodeURIComponent(m[1]).toLowerCase(); } catch { return ''; }
  })();
  const modoPublico = Boolean(slugPublico);

  // Que redes se ven. En /chat, las dos; en /chat/<slug>, las que el
  // creador eligio compartir. No filtra nada que llegue (eso lo hace el
  // servidor, por conexion): decide que columnas y que filtro tienen
  // sentido en pantalla.
  const REDES = ['kick', 'twitch'];
  let redesVisibles = REDES.slice();

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

  const avisoEnvio        = document.getElementById('aviso-envio');
  const textoAvisoEnvio   = document.getElementById('texto-aviso-envio');
  const botonCerrarAviso  = document.getElementById('boton-cerrar-aviso');
  const botonDeshacerAviso = document.getElementById('boton-deshacer-aviso');

  const campoTexto        = document.getElementById('campo-texto');
  const selectDestino     = document.getElementById('select-destino');
  const contadorCaracteres = document.getElementById('contador-caracteres');
  const botonEnviar       = document.getElementById('boton-enviar');

  const tituloChat      = document.getElementById('titulo-chat');
  const barraSalud      = document.getElementById('barra-salud');
  const cajaEscritura   = document.getElementById('caja-escritura');
  const pantallaCerrado = document.getElementById('pantalla-cerrado');
  const tituloCerrado   = document.getElementById('titulo-cerrado');
  const textoCerrado    = document.getElementById('texto-cerrado');

  const contadorConectados = document.getElementById('contador-conectados');

  const barraConectar   = document.getElementById('barra-conectar');
  const textoConectar   = document.getElementById('texto-conectar');
  const conectarKick    = document.getElementById('conectar-kick');
  const conectarTwitch  = document.getElementById('conectar-twitch');
  const botonSalir      = document.getElementById('boton-salir');

  const NOMBRE_RED = { kick: 'Kick', twitch: 'Twitch' };

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

    // El botón de bloquear de cada mensaje se escucha ACÁ, en la lista,
    // y no en el botón: /chat clona el <li> para la columna de su red y
    // un clon no se lleva las escuchas.
    ul.addEventListener('click', alClickEnLista);

    return info;
  }

  // ---------- bloquear a alguien en esta herramienta ----------

  function alClickEnLista(ev) {
    const boton = ev?.target;
    const id = boton?.dataset?.bloquearId;
    if (!id) return;
    bloquear({
      red: boton.dataset.bloquearRed,
      id,
      nombre: boton.dataset.bloquearNombre || '',
    });
  }

  // El bloqueo va con la cookie del creador y a SU sala: el servidor
  // saca el slug de ahí y nunca del cuerpo.
  function mandarAlPanel(cuerpo) {
    return fetch('/api/panel/chat', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cuerpo),
    }).then(async r => {
      const datos = await r.json().catch(() => null);
      if (!r.ok) throw new Error(datos?.error || 'http ' + r.status);
      return datos;
    });
  }

  function bloquear({ red, id, nombre }) {
    const quien = nombre || id;
    mandarAlPanel({ bloquear: { red, id, nombre } })
      .then(() => mostrarAviso(
        `bloqueaste a ${quien} en ${NOMBRE_RED[red] ?? red}: no puede escribir desde esta herramienta ` +
        '(en su plataforma sigue pudiendo)',
        // Un click de más no tiene que costar una visita al panel.
        { deshacer: () => desbloquear({ red, id, nombre }) }))
      .catch(e => mostrarAviso('no se pudo bloquear: ' + e.message));
  }

  function desbloquear({ red, id, nombre }) {
    mandarAlPanel({ desbloquear: { red, id } })
      .then(() => mostrarAviso(`${nombre || id} ya no está bloqueado`, { autoOcultar: true }))
      .catch(e => mostrarAviso('no se pudo desbloquear: ' + e.message));
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
  // `conBloquear` sólo en /chat: es la ventana del creador y el bloqueo
  // se hace con SU cookie. En /chat/<slug> y en la Sala, ni existe.
  const crearElementoMensaje = datos =>
    window.SalaMensajes.crear(datos, { conBloquear: !modoPublico && !modoDemo });

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

  // Con una sola red compartida, el filtro es esa red y no hay nada que
  // elegir. Pasa en /chat/<slug> cuando el creador comparte solo Kick, o
  // le saca Twitch con la pagina abierta: lo que ya habia llegado de
  // Twitch se esconde con el mismo CSS del filtro, sin borrar nada.
  const filtroEfectivo = () => (redesVisibles.length === 1 ? redesVisibles[0] : estado.filtro);

  function aplicarFiltro() {
    const etiqueta = estado.filtro === 'todas' ? 'todas' : estado.filtro === 'kick' ? 'solo Kick' : 'solo Twitch';
    botonFiltro.textContent = 'Filtro: ' + etiqueta;
    botonFiltro.setAttribute('aria-pressed', String(estado.filtro !== 'todas'));
    botonFiltro.hidden = redesVisibles.length < 2;

    const filtro = filtroEfectivo();

    // en la vista mezclada el filtro esconde los mensajes de la otra
    // red con CSS, no sacandolos de la lista: si se sacaran, volver a
    // "todas" no los podria traer de vuelta.
    listas.mezclada.ul.dataset.filtro = filtro;

    // en columnas el filtro esconde la columna entera
    const columnas = estado.vista === 'columnas';
    columnaKick.hidden = !columnas || filtro === 'twitch';
    columnaTwitch.hidden = !columnas || filtro === 'kick';

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

  // Dos claves distintas: en /chat la persona elige entre los canales
  // del creador y en /chat/<slug> entre SUS cuentas. Una sola clave
  // haria que abrir el chat de alguien te cambiara el destino de tu
  // propia ventana de streamer.
  const CLAVE_DESTINO = 'sala-chat-destino';
  const CLAVE_RED     = 'sala-chat-red';
  const claveDelSelector = () => (modoPublico ? CLAVE_RED : CLAVE_DESTINO);
  const LIMITE_VISIBLE_CARACTERES = 500;

  function leerGuardado() {
    try { return localStorage.getItem(claveDelSelector()) ?? ''; }
    catch { return ''; }   // localStorage puede no estar disponible (file://, modo privado)
  }

  // en modo publico las opciones las arma `armarSelector` cuando se
  // sabe que redes tiene la persona: elegir antes de saberlo dejaria
  // puesta una red que capaz no conecto.
  if (!modoPublico) {
    const guardado = leerGuardado();
    if (guardado) selectDestino.value = guardado;
  }

  selectDestino.addEventListener('change', () => {
    try { localStorage.setItem(claveDelSelector(), selectDestino.value); } catch { /* nada, no es critico */ }
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

  // lo que hace el botón "Deshacer" del aviso, o null si no hay nada
  // que deshacer. Vive acá y no en el botón para que el aviso siguiente
  // no herede el deshacer del anterior.
  let deshacerDelAviso = null;

  function mostrarAviso(texto, { autoOcultar = false, deshacer = null } = {}) {
    textoAvisoEnvio.textContent = texto;
    deshacerDelAviso = deshacer;
    botonDeshacerAviso.hidden = !deshacer;
    botonDeshacerAviso.disabled = false;
    avisoEnvio.hidden = false;
    if (avisoOcultarTimeout) clearTimeout(avisoOcultarTimeout);
    avisoOcultarTimeout = autoOcultar ? setTimeout(ocultarAviso, 8000) : null;
  }

  function ocultarAviso() {
    avisoEnvio.hidden = true;
    deshacerDelAviso = null;
    botonDeshacerAviso.hidden = true;
    if (avisoOcultarTimeout) { clearTimeout(avisoOcultarTimeout); avisoOcultarTimeout = null; }
  }

  botonDeshacerAviso.addEventListener('click', () => {
    const hacer = deshacerDelAviso;
    if (!hacer) return;
    botonDeshacerAviso.disabled = true;
    hacer();
  });

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

    // En /chat/<slug> el mensaje sale con la cuenta de QUIEN MIRA y va
    // a la sala del camino; en /chat, con la del creador. Es la misma
    // caja y el mismo resultado por red, así que sólo cambian la
    // dirección y el nombre del campo.
    const ruta = modoPublico
      ? `/api/chat/${encodeURIComponent(slugPublico)}/enviar`
      : '/api/chat/enviar';
    const cuerpo = modoPublico
      ? { red: selectDestino.value, texto }
      : { texto, destino: selectDestino.value };

    fetch(ruta, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cuerpo),
    })
      .then(async r => {
        let datos = null;
        try { datos = await r.json(); } catch { /* sin cuerpo o invalido */ }

        // Una red cuyo permiso dejó de valer se desconectó sola del
        // lado del servidor: hay que volver a ofrecer su botón.
        if (modoPublico && Array.isArray(datos?.reconectar) && datos.reconectar.length) consultarYo();

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
          mostrarAviso(modoPublico
            ? (datos?.error || 'conectá tu cuenta de nuevo para poder escribir')
            : 'no hay sesión de dueño: entrá con Kick en /panel');
          if (modoPublico) consultarYo();
        } else if (r.status === 403) {
          // el creador cerró el chat, o le sacó esta red, mientras la
          // página estaba abierta: el corte es del servidor y la
          // pantalla se pone al día.
          mostrarAviso(datos?.error || 'acá no se puede escribir');
          if (modoPublico) { consultarAbierto(); consultarYo(); }
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
  // El alcance es el de ESTA página: /chat para la ventana del creador
  // y /chat/<slug> para el chat abierto de una sala. Dos salas
  // instaladas son dos apps distintas, cada una en su chat.
  function registrarServiceWorker(alcance) {
    try {
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/sw.js', { scope: alcance }).catch(() => { /* no es critico */ });
      }
    } catch { /* nada: no puede romper la pagina */ }
  }

  // ---------- /chat/<slug>: el chat abierto de una sala ----------

  // Cerrado, se vuelve a preguntar cada tanto: asi, cuando el creador
  // lo abre, la pagina aparece sola. Es un pedido chico que se contesta
  // de memoria en el servidor.
  const CADA_CONSULTA_CERRADO = 30000;

  let conexionBus = null;        // lo que devuelve Sala.conectar, para poder cerrarla
  let enElBus = false;
  let yaHuboEstado = false;
  let temporizadorAbierto = null;

  function prepararModoPublico() {
    tituloChat.textContent = 'Chat de ' + slugPublico;
    tituloChat.hidden = false;
    document.title = 'Chat de ' + slugPublico + ' · Sala';
    barraSalud.hidden = true;
    bandaSesion.hidden = true;
    // hasta que /yo conteste no se sabe si esta persona puede escribir
    cajaEscritura.hidden = true;

    // El login es una navegación de arriba y por eso son enlaces: así
    // la cookie vuelve (SameSite=Lax) y así se puede abrir en otra
    // pestaña. `destino` es ESTE chat, para volver a donde estaba.
    const volverAca = encodeURIComponent('/chat/' + slugPublico);
    conectarKick.setAttribute('href', `/oauth/kick/entrar?rol=espectador&destino=${volverAca}`);
    conectarTwitch.setAttribute('href', `/oauth/twitch/entrar?rol=espectador&destino=${volverAca}`);

    botonSalir.addEventListener('click', () => {
      botonSalir.disabled = true;
      // Salir borra los tokens de las dos redes, no sólo la cookie: lo
      // hace el servidor, acá sólo se refresca lo que se ve.
      fetch('/api/espectador/salir', { method: 'POST', credentials: 'same-origin' })
        .then(() => consultarYo())
        .catch(() => mostrarAviso('no se pudo salir: probá de nuevo'))
        .finally(() => { botonSalir.disabled = false; });
    });
  }

  // ---------- /chat/<slug>: con qué cuenta escribe esta persona ----------

  // El selector muestra SÓLO las redes que la persona conectó y que el
  // creador abrió. Con las dos aparece "las dos", que es un solo envío
  // (y un solo mensaje para el freno de dos segundos). Con una sola no
  // hay nada que elegir y se esconde.
  function armarSelector(redes) {
    const opciones = redes.slice();
    if (opciones.length > 1) opciones.push('ambas');

    const antes = selectDestino.value;
    selectDestino.textContent = '';
    for (const valor of opciones) {
      const op = document.createElement('option');
      op.value = valor;
      op.setAttribute('value', valor);
      op.textContent = valor === 'ambas' ? 'Las dos' : NOMBRE_RED[valor];
      selectDestino.appendChild(op);
    }

    // lo que ya estaba elegido gana, después lo guardado de la última
    // vez, y si ninguno sirve la primera opción
    const elegida = [antes, leerGuardado()].find(v => opciones.includes(v)) ?? opciones[0] ?? '';
    selectDestino.value = elegida;
    selectDestino.hidden = opciones.length < 2;
  }

  function aplicarYo(datos) {
    const abiertas = Array.isArray(datos?.redes) ? datos.redes : [];
    const conectadas = datos?.conectadas ?? {};
    const puede = Array.isArray(datos?.puedeEscribir) ? datos.puedeEscribir : [];

    // Se ofrece conectar sólo lo que sirve acá: una red que el creador
    // no abrió no tiene por qué pedirle permisos a nadie.
    conectarKick.hidden = !abiertas.includes('kick') || Boolean(conectadas.kick);
    conectarTwitch.hidden = !abiertas.includes('twitch') || Boolean(conectadas.twitch);
    botonSalir.hidden = !datos?.entrado;

    if (puede.length) {
      armarSelector(puede);
      cajaEscritura.hidden = false;
      const como = REDES.filter(r => conectadas[r])
        .map(r => `${conectadas[r].nombre || ''} en ${NOMBRE_RED[r]}`.trim());
      textoConectar.textContent = 'Escribís como ' + como.join(' y ');
    } else {
      cajaEscritura.hidden = true;
      textoConectar.textContent = datos?.entrado
        ? 'Conectá una de las redes que abrió este chat para poder escribir.'
        : 'Conectá tu cuenta y escribí con tu nombre, en el chat de verdad.';
    }

    barraConectar.hidden = false;
  }

  function consultarYo() {
    return fetch(`/api/chat/${encodeURIComponent(slugPublico)}/yo`, { credentials: 'same-origin' })
      .then(r => (r.ok ? r.json() : null))
      .then(datos => { if (datos) aplicarYo(datos); })
      .catch(() => { /* un corte suelto no tiene por qué esconder la caja */ });
  }

  function mostrarCerrado(titulo, texto) {
    tituloCerrado.textContent = titulo;
    textoCerrado.textContent = texto;
    pantallaCerrado.hidden = false;
    areaMensajes.hidden = true;
  }

  function vaciarListas() {
    for (const info of Object.values(listas)) {
      info.ul.textContent = '';
      despausar(info);
    }
  }

  function conectarPublico() {
    if (enElBus) return;
    enElBus = true;
    yaHuboEstado = false;
    // El servidor le manda los ultimos mensajes a cada conexion nueva:
    // si quedara lo de antes de cerrar, al reabrir saldria repetido.
    vaciarListas();
    conexionBus = window.Sala.conectar(slugPublico, (tipo, datos) => {
      if (tipo === 'chat') return manejarMensajeChat(datos);
      if (tipo === 'chat-abierto') return aplicarAbierto(datos);
      // cuántos están leyendo. Un número y nada más: quiénes, nunca.
      if (tipo === 'presencia') return mostrarConectados(datos?.conectados);
      // El estado llega con cada conexion. La primera vez no dice nada
      // nuevo (se acaba de preguntar); despues de un corte, si: el
      // creador pudo cerrar el chat mientras esta pagina no escuchaba,
      // y el aviso por el bus se perdio.
      if (tipo === 'estado') {
        mostrarConectados(datos?.conectados);
        if (yaHuboEstado) consultarAbierto();
        yaHuboEstado = true;
      }
    });
  }

  function desconectarPublico() {
    if (!enElBus) return;
    enElBus = false;
    try { conexionBus?.cerrar?.(); } catch { /* ya estaba cerrada */ }
    conexionBus = null;
    // sin bus no se sabe cuántos hay: mejor no decir nada que dejar
    // puesto un número viejo.
    contadorConectados.hidden = true;
  }

  function mostrarConectados(cuantos) {
    const n = Number(cuantos);
    if (!Number.isFinite(n)) return;
    contadorConectados.textContent = n === 1 ? '1 conectado' : `${n} conectados`;
    contadorConectados.hidden = false;
  }

  function programarConsultaAbierto() {
    if (temporizadorAbierto) clearTimeout(temporizadorAbierto);
    temporizadorAbierto = setTimeout(consultarAbierto, CADA_CONSULTA_CERRADO);
  }

  // Lo que dice el servidor, venga de /abierto o del aviso por el bus.
  function aplicarAbierto(datos) {
    if (!datos?.abierto) {
      // Cerrado se cierra de verdad: sin conexion al bus. Quedarse
      // escuchando mandaria el Kick de la sala a una pantalla que no lo
      // muestra, y contaria como alguien mirando la peli.
      desconectarPublico();
      mostrarCerrado('Este chat está cerrado',
        'El creador todavía no lo abrió a su comunidad. Esta página se fija sola cada tanto.');
      // Y no se escribe: el corte de verdad lo hace el servidor (403),
      // pero dejar la caja puesta sería ofrecer algo que no anda.
      barraConectar.hidden = true;
      cajaEscritura.hidden = true;
      programarConsultaAbierto();
      return;
    }
    const redes = REDES.filter(r => Array.isArray(datos.redes) && datos.redes.includes(r));
    redesVisibles = redes.length ? redes : REDES.slice();
    pantallaCerrado.hidden = true;
    areaMensajes.hidden = false;
    aplicarFiltro();
    conectarPublico();
    // Qué redes abrió el creador acaba de cambiar (o es la primera
    // vez): el selector se arma con eso cruzado con lo que tiene la
    // persona, así que se vuelve a preguntar.
    consultarYo();
  }

  function consultarAbierto() {
    return fetch(`/api/chat/${encodeURIComponent(slugPublico)}/abierto`, { credentials: 'same-origin' })
      .then(async r => {
        if (r.status === 404) {
          desconectarPublico();
          mostrarCerrado('Esta sala no existe', 'Revisá el link: puede que esté mal escrito.');
          return;
        }
        if (!r.ok) throw new Error('http ' + r.status);
        ocultarAviso();
        aplicarAbierto(await r.json());
      })
      .catch(() => {
        // Un corte suelto no cierra un chat que se estaba viendo: si ya
        // hay bus, sigue; si no, se avisa y se vuelve a probar.
        if (enElBus) return;
        mostrarAviso('no se pudo consultar el chat: se vuelve a intentar solo');
        programarConsultaAbierto();
      });
  }

  // ---------- arranque ----------

  function iniciarModoDemo() {
    const script = document.createElement('script');
    script.src = 'chat/demo.js';
    script.onload = () => {
      window.SalaDemo.mensajes().forEach(manejarMensajeChat);
      // la salud es de la cuenta del creador: en /chat/<slug> no va
      if (!modoPublico) aplicarSalud(window.SalaDemo.salud());
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
    // Cada chat se instala aparte: la ventana del creador abre en
    // /chat y el chat de una sala, en /chat/<slug>. Quien instale el
    // chat de su streamer tiene que abrir ahí y no en el de otro.
    if (modoPublico) prepararModoPublico();
    registrarServiceWorker(modoPublico ? '/chat/' + slugPublico : '/chat');

    if (modoDemo) {
      iniciarModoDemo();
      return;
    }

    if (modoPublico) {
      consultarAbierto();
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
