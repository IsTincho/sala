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

   Expone `window.SalaMensajes`:
     crear(datos)                 -> un <li> listo
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

  function crear(datos) {
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
    insignias.slice(0, 4).forEach(insignia => {
      const chip = document.createElement('span');
      chip.className = 'chip-insignia';
      chip.textContent = insignia.texto;
      filaPrincipal.appendChild(chip);
    });
    if (insignias.length > 4) {
      const chipMas = document.createElement('span');
      chipMas.className = 'chip-insignia';
      chipMas.textContent = '+' + (insignias.length - 4);
      filaPrincipal.appendChild(chipMas);
    }

    const usuarioEl = document.createElement('span');
    usuarioEl.className = 'usuario';
    usuarioEl.textContent = datos.usuario;
    usuarioEl.style.color = colorDeUsuario(datos);
    filaPrincipal.appendChild(usuarioEl);

    li.appendChild(filaPrincipal);

    const textoEl = document.createElement('span');
    textoEl.className = 'texto-mensaje';
    agregarTextoConEmotes(textoEl, datos.texto ?? '', datos.emotes);
    li.appendChild(textoEl);

    return li;
  }

  window.SalaMensajes = { crear, colorDeUsuario, recortarTexto };
})();
