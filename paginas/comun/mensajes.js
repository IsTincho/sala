/* ============================================================
   El render de un mensaje de chat, compartido.

   Sale de `paginas/chat/chat.js`, donde vivia solo, porque la Sala
   muestra exactamente los mismos mensajes con el mismo formato unico:
   dos copias del mismo armado terminan siendo dos comportamientos
   distintos el dia que alguien arregla uno de los dos.

   NADA DE innerHTML. El texto de un mensaje lo escribe gente
   desconocida y el nombre de usuario tambien. Todo entra por
   textContent y createTextNode. El DOM de mentira de las pruebas hace
   TIRAR innerHTML a proposito, asi que si alguien lo vuelve a usar
   aca, los tests explotan en vez de pasar.

   TAMPOCO SE LE PREGUNTA NADA A NADIE. Esta pagina no habla con APIs
   externas: la URL de cada emote y la de cada insignia ya vienen
   resueltas en el mensaje, desde el servidor. Aca solo se decide como
   se dibujan y que pasa si la imagen no carga (se ve el texto, nunca
   un hueco).

   Expone `window.SalaMensajes`:
     crear(datos, opciones)       -> un <li> listo
     vigilarInsignias(lista)      -> el respaldo a texto de las insignias
     colorDeUsuario(datos)        -> el color ya validado y aclarado
     recortarTexto(texto, limite)

   Se carga con <script src="comun/mensajes.js"> antes del script de
   la pagina, igual que comun/bus.js.
   ============================================================ */
(() => {
  const REGEX_COLOR_HEX = /^#[0-9a-f]{6}$/i;

  function obtenerColorDeRed(red) {
    const nombre = red === 'kick' ? '--kick' : '--twitch';
    const valor = getComputedStyle(document.documentElement).getPropertyValue(nombre).trim();
    return REGEX_COLOR_HEX.test(valor) ? valor : (red === 'kick' ? '#53fc18' : '#9146ff');
  }

  // luminancia relativa (formula de WCAG) para decidir si un color se
  // lee sobre el fondo oscuro. Colores como el #0000FF clasico de
  // Twitch dan una luminancia bajisima y quedan casi negros.
  function luminanciaRelativa(hex) {
    const canal = v => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    };
    const r = canal(parseInt(hex.slice(1, 3), 16));
    const g = canal(parseInt(hex.slice(3, 5), 16));
    const b = canal(parseInt(hex.slice(5, 7), 16));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  // si el color es demasiado oscuro lo mezcla con blanco para subirle
  // el brillo sin cambiarle el tono.
  function aclararSiOscuro(hex) {
    if (luminanciaRelativa(hex) >= 0.18) return hex;
    const mezclar = v => Math.round(v + (255 - v) * 0.55);
    const r = mezclar(parseInt(hex.slice(1, 3), 16));
    const g = mezclar(parseInt(hex.slice(3, 5), 16));
    const b = mezclar(parseInt(hex.slice(5, 7), 16));
    return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
  }

  function colorDeUsuario(datos) {
    const crudo = datos.color;
    // el color viene de afuera (kick/twitch) y termina en un style: se
    // valida el formato exacto antes de usarlo, sino se cae al color
    // de la red.
    const base = (typeof crudo === 'string' && REGEX_COLOR_HEX.test(crudo))
      ? crudo
      : obtenerColorDeRed(datos.red);
    return aclararSiOscuro(base);
  }

  // recorta contando PUNTOS DE CODIGO, no unidades de string: un emoji
  // de dos unidades UTF-16 no puede contar como dos caracteres.
  function recortarTexto(texto, limite) {
    const puntos = [...texto];
    if (puntos.length <= limite) return texto;
    return puntos.slice(0, limite).join('') + '…';
  }

  // corta el texto en los tramos que marcan los emotes. inicio/fin son
  // indices de puntos de codigo Unicode con fin EXCLUSIVO: hay que
  // cortar sobre [...texto], nunca sobre el string crudo, porque un
  // emoji antes de un emote desalinea los indices si se usan unidades
  // UTF-16.
  function agregarTextoConEmotes(contenedor, texto, emotes) {
    const puntos = [...texto];
    let cursor = 0;
    (emotes || []).forEach(emote => {
      if (emote.inicio > cursor) {
        contenedor.appendChild(document.createTextNode(puntos.slice(cursor, emote.inicio).join('')));
      }
      const alt = puntos.slice(emote.inicio, emote.fin).join('');
      const img = document.createElement('img');
      img.className = 'emote';
      img.src = emote.url;
      img.alt = alt;
      img.title = alt;
      img.loading = 'lazy';
      contenedor.appendChild(img);
      cursor = emote.fin;
    });
    if (cursor < puntos.length) {
      contenedor.appendChild(document.createTextNode(puntos.slice(cursor).join('')));
    }
  }

  // la etiqueta de texto de toda la vida: el nombre de la insignia en
  // un chip. Es lo que se ve cuando no hay imagen, y lo que se ve si
  // la imagen falla. Nunca un hueco.
  function chipDeTexto(texto) {
    const chip = document.createElement('span');
    chip.className = 'chip-insignia';
    chip.textContent = texto;
    return chip;
  }

  // Una insignia: la imagen si el servidor pudo resolverla, y si no el
  // chip de texto.
  //
  // La URL la resuelve el SERVIDOR (servidor/insignias.js): esta
  // pagina no habla con APIs de nadie. Hoy solo la traen las de
  // Twitch; las de Kick vienen con `url` vacia —Kick no las publica
  // por ninguna API documentada— y caen por el camino del chip. Aca no
  // se distinguen las redes a proposito: la pagina pregunta "¿hay
  // imagen?" y no "¿de que red es esto?", asi que el dia que Kick las
  // publique, esto no se toca.
  //
  // `alt` y `title` llevan SIEMPRE el nombre de la insignia. El alt no
  // es decorativo: una insignia dice quien es esa persona en ese chat,
  // y un lector de pantalla tiene que poder decirlo. El title es para
  // el que pasa el mouse y no sabe que es ese dibujito.
  //
  // Si la imagen no carga —un 404, un bloqueador, el CDN caido— se
  // cambia por el chip de texto. QUIEN LO HACE NO ES ESTA IMAGEN: es
  // `vigilarInsignias()`, un escucha puesto en la lista. Ver el
  // comentario de ahi abajo, que explica por que.
  //
  // El nombre viaja en `dataset` por el mismo motivo por el que viaja
  // el del boton de bloquear: /chat CLONA el <li> y un clon se lleva
  // los data-*, pero no las escuchas.
  //
  // Sin `loading="lazy"`, a diferencia de los emotes: una insignia pesa
  // medio kilobyte y la misma URL se repite en casi todos los mensajes,
  // asi que el navegador la baja una vez y la reusa. Lo unico que
  // agregaria lazy es un observador por imagen a cambio de nada.
  function agregarInsignia(fila, insignia) {
    const texto = String(insignia.texto || insignia.tipo || '');
    const url = typeof insignia.url === 'string' ? insignia.url : '';
    if (!url) {
      fila.appendChild(chipDeTexto(texto));
      return;
    }
    const img = document.createElement('img');
    img.className = 'insignia';
    img.src = url;
    img.alt = texto;
    img.title = texto;
    img.dataset.insigniaTexto = texto;
    fila.appendChild(img);
  }

  /**
   * Deja una lista de mensajes vigilando las insignias que no carguen:
   * cada una se cambia por su etiqueta de texto, EN SU LUGAR.
   *
   * HAY QUE LLAMARLO UNA VEZ POR LISTA. Si no, una imagen que falla
   * deja el icono de imagen rota del navegador en vez del texto.
   *
   * POR QUE UN ESCUCHA EN LA LISTA Y NO UN `onerror` POR IMAGEN:
   * /chat clona el <li> para ponerlo tambien en la columna de su red,
   * y `img.onerror = fn` es una propiedad, no un atributo, asi que el
   * CLON NO SE LA LLEVA. Con un handler por imagen, el respaldo andaba
   * en la vista mezclada y en la de columnas se veia el icono roto: el
   * mismo motivo por el que el boton de bloquear tampoco lleva su
   * propia escucha.
   *
   * Y va en fase de CAPTURA (el `true` del final) porque el evento
   * `error` de una imagen NO BURBUJEA: un escucha normal en la lista
   * no se enteraria nunca.
   */
  function vigilarInsignias(lista) {
    if (!lista || lista.dataset.insigniasVigiladas) return;
    lista.dataset.insigniasVigiladas = '1';
    lista.addEventListener('error', ev => {
      const img = ev.target;
      if (!img || img.tagName !== 'IMG') return;
      if (!img.classList.contains('insignia')) return;
      const padre = img.parentElement;
      // ya lo cambio otro, o el mensaje ya salio de la lista
      if (!padre) return;
      padre.replaceChild(chipDeTexto(img.dataset.insigniaTexto || img.alt || ''), img);
    }, true);
  }

  /**
   * Un <li> de mensaje.
   *
   * `opciones.conBloquear` agrega el boton de bloquear al lado del
   * nombre. Lo pide SOLO la ventana del creador (/chat): la Sala y el
   * chat abierto pasan de largo, asi que el boton no existe ahi ni
   * escondido con CSS.
   *
   * El boton no lleva su propia escucha: lleva los datos en `dataset` y
   * quien lo puso escucha el click en la lista. Es a proposito, porque
   * /chat CLONA el <li> para ponerlo en la columna de su red y un
   * clon no se lleva las escuchas: el boton de la columna no haria
   * nada y nadie se enteraria hasta que alguien lo tocara.
   */
  function crear(datos, opciones = {}) {
    const li = document.createElement('li');
    li.className = 'mensaje';
    li.dataset.id = datos.id;
    /* Lo usa el CSS del filtro de la vista mezclada de /chat. */
    li.dataset.red = datos.red === 'kick' ? 'kick' : 'twitch';

    if (datos.respondeA) {
      const lineaRespuesta = document.createElement('div');
      lineaRespuesta.className = 'mensaje-respuesta';
      lineaRespuesta.textContent =
        `↳ respondiendo a ${datos.respondeA.usuario}: ${recortarTexto(datos.respondeA.texto, 60)}`;
      li.appendChild(lineaRespuesta);
    }

    const filaPrincipal = document.createElement('div');
    filaPrincipal.className = 'mensaje-linea';

    // el chip de red lleva texto ademas de color: el color solo no
    // puede ser el unico canal de informacion.
    const chipRed = document.createElement('span');
    chipRed.className = 'chip-red ' + (datos.red === 'kick' ? 'chip-red-kick' : 'chip-red-twitch');
    chipRed.textContent = datos.red === 'kick' ? 'Kick' : 'Twitch';
    filaPrincipal.appendChild(chipRed);

    const insignias = datos.insignias || [];
    insignias.slice(0, 4).forEach(insignia => agregarInsignia(filaPrincipal, insignia));
    if (insignias.length > 4) {
      filaPrincipal.appendChild(chipDeTexto('+' + (insignias.length - 4)));
    }

    const usuarioEl = document.createElement('span');
    usuarioEl.className = 'usuario';
    usuarioEl.textContent = datos.usuario;
    usuarioEl.style.color = colorDeUsuario(datos);
    filaPrincipal.appendChild(usuarioEl);

    /* Sin id no hay a quien bloquear: por nombre no sirve, porque los
       nombres se cambian. Un mensaje viejo del buffer, de antes de que
       el id viajara, simplemente no trae el boton. */
    if (opciones.conBloquear && datos.usuarioId) {
      const boton = document.createElement('button');
      boton.type = 'button';
      boton.className = 'boton-bloquear';
      boton.textContent = 'bloquear';
      boton.title = `Que ${datos.usuario} no pueda escribir desde esta herramienta`;
      boton.dataset.bloquearRed = datos.red === 'kick' ? 'kick' : 'twitch';
      boton.dataset.bloquearId = String(datos.usuarioId);
      boton.dataset.bloquearNombre = String(datos.usuario ?? '');
      filaPrincipal.appendChild(boton);
    }

    li.appendChild(filaPrincipal);

    const textoEl = document.createElement('span');
    textoEl.className = 'texto-mensaje';
    agregarTextoConEmotes(textoEl, datos.texto ?? '', datos.emotes);
    li.appendChild(textoEl);

    return li;
  }

  window.SalaMensajes = { crear, vigilarInsignias, colorDeUsuario, recortarTexto };
})();
