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
     coloresDeUsuario(datos)      -> { claro, oscuro }, ya corregidos
     pintarNombre(elemento, datos)-> le pone esos dos colores
     recortarTexto(texto, limite)

   Se carga con <script src="comun/mensajes.js"> antes del script de
   la pagina, igual que comun/bus.js.
   ============================================================ */
(() => {
  const REGEX_COLOR_HEX = /^#[0-9a-f]{6}$/i;

  /* ------------------------------------------------- el color del nombre

     De donde sale: el mensaje trae `color`. Puede ser el que le da la
     plataforma (Kick o Twitch) o el que la persona eligio EN ESTA
     PLATAFORMA, que lo pisa; cual de los dos es lo decide el servidor
     (`servidor/colores.js`) y aca no se nota la diferencia, salvo por
     `colorPropio`, que solo sirve para el boton del creador.

     Lo que SI se decide aca es que el color se lea. Nadie puede quedar
     ilegible: si el elegido no contrasta lo suficiente con el fondo, se
     ajusta al tono mas cercano que si contraste. "Lo suficiente" es la
     relacion de contraste de WCAG 2.1 (AA para texto normal, 4.5:1),
     calculada con luminancias relativas de verdad, no a ojo.

     Y SE CALCULAN LOS DOS, el del tema claro y el del oscuro, siempre.
     El chat tiene los dos temas y los sigue del sistema: si se
     calculara solo el que esta puesto, cambiar de tema con el chat
     abierto dejaria todos los nombres que ya estan en pantalla
     corregidos para el fondo de antes. Salen como dos variables CSS
     sobre el <span> y el que elige es el @media de base.css, que no
     necesita que nadie repinte nada. */

  const CONTRASTE_MINIMO = 4.5;

  /* En cuantos pasos se busca la correccion mas chica que alcanza.
     Cincuenta pasos son saltos de 2%: mas fino no se ve, y mas grueso
     empieza a lavar colores que se podian salvar con menos. */
  const PASOS = 50;

  /* Respaldo por si la hoja de estilos no cargo o no tiene las
     variables. Son los mismos valores de base.css. */
  const FONDOS_POR_DEFECTO = { oscuro: '#181b20', claro: '#eeeff1' };

  function variableCss(nombre) {
    try {
      const v = getComputedStyle(document.documentElement).getPropertyValue(nombre);
      return String(v ?? '').trim();
    } catch { return ''; }
  }

  /* Los fondos se leen una vez: no cambian en toda la vida de la
     pagina (los dos estan declarados fuera del @media a proposito) y
     preguntarle al navegador por mensaje es pedirle que resuelva
     estilos en el camino caliente del chat.

     Son los MAS DESFAVORABLES de cada tema, no los del body: el mismo
     nombre cae sobre la lista del chat, sobre la fila resaltada y
     sobre la tarjeta de la Sala, que no son el mismo color. Cual es
     cual esta en base.css, al lado de las variables. */
  let fondos = null;
  function fondosDeLaPagina() {
    if (fondos) return fondos;
    const leer = (nombre, respaldo) => {
      const v = variableCss(nombre);
      return REGEX_COLOR_HEX.test(v) ? v : respaldo;
    };
    fondos = {
      oscuro: leer('--fondo-peor-oscuro', FONDOS_POR_DEFECTO.oscuro),
      claro: leer('--fondo-peor-claro', FONDOS_POR_DEFECTO.claro),
    };
    return fondos;
  }

  function obtenerColorDeRed(red) {
    const nombre = red === 'kick' ? '--kick' : '--twitch';
    const valor = variableCss(nombre);
    return REGEX_COLOR_HEX.test(valor) ? valor : (red === 'kick' ? '#53fc18' : '#9146ff');
  }

  const canales = hex => [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];

  const aHex = ([r, g, b]) =>
    '#' + [r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');

  // luminancia relativa, formula de WCAG 2.1
  function luminanciaRelativa(hex) {
    const lineal = v => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    };
    const [r, g, b] = canales(hex).map(lineal);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  // la relacion de contraste de WCAG entre dos colores: de 1 (el mismo
  // color) a 21 (negro contra blanco).
  function contraste(a, b) {
    const la = luminanciaRelativa(a);
    const lb = luminanciaRelativa(b);
    const claro = Math.max(la, lb);
    const oscuro = Math.min(la, lb);
    return (claro + 0.05) / (oscuro + 0.05);
  }

  // mezcla el color con blanco (destino 255) o con negro (0). Mezclar
  // en sRGB le conserva el tono: un violeta mezclado con blanco sigue
  // siendo violeta, mas lavado.
  const mezclar = (hex, destino, cuanto) =>
    aHex(canales(hex).map(v => v + (destino - v) * cuanto));

  /**
   * El mismo color si ya se lee sobre ese fondo, y si no el tono mas
   * cercano que si se lee.
   *
   * Se mezcla hacia el extremo que mas contraste con el fondo (blanco
   * sobre tema oscuro, negro sobre tema claro) y se devuelve el primer
   * paso que llega al minimo: el cambio mas chico que alcanza. Si ni
   * el extremo alcanza —un fondo gris medio, que no es ninguno de los
   * dos temas— se devuelve el extremo, que es lo mas legible que hay.
   */
  function ajustarAlFondo(hex, fondo) {
    if (contraste(hex, fondo) >= CONTRASTE_MINIMO) return hex;
    const destino = contraste('#ffffff', fondo) >= contraste('#000000', fondo) ? 255 : 0;
    for (let paso = 1; paso <= PASOS; paso++) {
      const probado = mezclar(hex, destino, paso / PASOS);
      if (contraste(probado, fondo) >= CONTRASTE_MINIMO) return probado;
    }
    return destino === 255 ? '#ffffff' : '#000000';
  }

  /* El mismo puñado de colores se repite en todos los mensajes de la
     noche: la correccion se calcula una vez por color. El tope es para
     que un chat lleno de gente con colores distintos no deje creciendo
     un Map para siempre. */
  const TOPE_RECORDADOS = 500;
  const recordados = new Map();

  /**
   * Los dos colores con los que se puede pintar este nombre: el del
   * tema oscuro y el del claro.
   *
   * El color viene de afuera y termina en un `style`: se valida la
   * forma exacta (`#rrggbb`) antes de tocarlo, y lo que no la cumple
   * no se "arregla", se cae al color de la red. El servidor valida lo
   * mismo; que las dos puntas lo hagan es a proposito.
   */
  function coloresDeUsuario(datos) {
    const crudo = datos?.color;
    const base = (typeof crudo === 'string' && REGEX_COLOR_HEX.test(crudo))
      ? crudo.toLowerCase()
      : obtenerColorDeRed(datos?.red);

    const guardado = recordados.get(base);
    if (guardado) return guardado;

    const { oscuro, claro } = fondosDeLaPagina();
    const par = { oscuro: ajustarAlFondo(base, oscuro), claro: ajustarAlFondo(base, claro) };
    if (recordados.size >= TOPE_RECORDADOS) recordados.clear();
    recordados.set(base, par);
    return par;
  }

  /** Le pone a un elemento los dos colores; el CSS elige cual usa. */
  function pintarNombre(elemento, datos) {
    const par = coloresDeUsuario(datos);
    elemento.style.setProperty('--color-usuario-oscuro', par.oscuro);
    elemento.style.setProperty('--color-usuario-claro', par.claro);
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
    /* Quien escribio, para poder repintarle el nombre a los mensajes
       que ya estan en pantalla cuando esa persona cambia su color. Es
       el mismo id que ya viaja en el mensaje (y que la plataforma
       publica en cualquier mensaje publico), no un dato nuevo. */
    if (datos.usuarioId) li.dataset.usuarioId = String(datos.usuarioId);

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
    pintarNombre(usuarioEl, datos);
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

    /* Y el de sacarle el color propio, al lado. Aparece SOLO cuando el
       color es el que la persona eligio (`colorPropio`): en un mensaje
       pintado con el color que le da la plataforma no hay nada que
       resetear, y un boton que no hace nada es ruido en cada renglon
       del chat. */
    if (opciones.conBloquear && datos.usuarioId && datos.colorPropio) {
      const boton = document.createElement('button');
      boton.type = 'button';
      boton.className = 'boton-color';
      boton.textContent = 'color';
      boton.title = `Sacarle a ${datos.usuario} el color que eligió (vuelve al de su plataforma)`;
      boton.dataset.colorRed = datos.red === 'kick' ? 'kick' : 'twitch';
      boton.dataset.colorId = String(datos.usuarioId);
      boton.dataset.colorNombre = String(datos.usuario ?? '');
      filaPrincipal.appendChild(boton);
    }

    li.appendChild(filaPrincipal);

    const textoEl = document.createElement('span');
    textoEl.className = 'texto-mensaje';
    agregarTextoConEmotes(textoEl, datos.texto ?? '', datos.emotes);
    li.appendChild(textoEl);

    return li;
  }

  window.SalaMensajes = {
    crear, vigilarInsignias, coloresDeUsuario, pintarNombre, recortarTexto,
  };
})();
