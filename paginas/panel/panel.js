/* ============================================================
   El panel del dueño.

   Un solo pedido a /api/panel trae todo lo que se ve, y se repite
   cada pocos segundos. Es una pantalla que se mira mientras el stream
   está al aire: los botones son grandes y lo que dice el reloj avanza
   solo, sin esperar la próxima consulta.

   ---------------------------------------------------------------
   LA CLAVE DE SUBIDA NO SE MUESTRA

   El dueño trabaja con la pantalla al aire. Una clave que aparece
   sola en pantalla apenas se toca "Generar" es un secreto regalado a
   quien esté mirando el stream. Así que se copia al portapapeles sin
   mostrarla, y si alguien de verdad la necesita a la vista, hay un
   segundo botón que lo dice con todas las letras.

   ---------------------------------------------------------------
   Nada de innerHTML: la lista de videos lleva títulos que vienen del
   nombre de un archivo, y el DOM de mentira de las pruebas hace
   tirar innerHTML a propósito.
   ============================================================ */
(() => {
  const CADA_CONSULTA = 4000;

  const el = id => document.getElementById(id);

  const textoCarga = el('texto-carga');
  const tarjetaEstado = el('tarjeta-estado');
  const linkKick = el('link-kick');
  const linkTwitch = el('link-twitch');

  const avisoPanel = el('aviso-panel');
  const textoAvisoPanel = el('texto-aviso-panel');
  const botonCerrarAviso = el('boton-cerrar-aviso-panel');

  const tarjetaSala = el('tarjeta-sala');
  const puntitoReloj = el('puntito-reloj');
  const estadoReloj = el('estado-reloj');
  const posicionReloj = el('posicion-reloj');
  const selectVideo = el('select-video');
  const linkSala = el('link-sala');
  const datoConectados = el('dato-conectados');
  const datoPico = el('dato-pico');

  const tarjetaVideos = el('tarjeta-videos');
  const listaVideos = el('lista-videos');
  const sinVideos = el('sin-videos');

  const tarjetaMetricas = el('tarjeta-metricas');
  const graficoHoras = el('grafico-horas');

  const tarjetaClave = el('tarjeta-clave');
  const estadoClave = el('estado-clave');
  const cajaClave = el('caja-clave');
  const valorClave = el('valor-clave');

  const tarjetaWebhook = el('tarjeta-webhook');
  const urlWebhook = el('url-webhook');

  const tarjetaPlan = el('tarjeta-plan');
  const puntitoPlan = el('puntito-plan');
  const textoPlan = el('texto-plan');
  const explicaPlan = el('explica-plan');
  const lineaUso = el('linea-uso');
  const botonSuscribirse = el('boton-suscribirse');
  const linkAdmin = el('link-admin');
  const botonDesvincularTwitch = el('boton-desvincular-twitch');

  const tarjetaChatAbierto = el('tarjeta-chat-abierto');
  const interruptorChat = el('interruptor-chat-abierto');
  const estadoChatAbierto = el('estado-chat-abierto');
  const redChatKick = el('red-chat-kick');
  const redChatTwitch = el('red-chat-twitch');
  const notaTwitchChat = el('nota-twitch-chat');
  const linkChatAbierto = el('link-chat-abierto');
  const abrirChatAbierto = el('abrir-chat-abierto');
  const CONTROLES_DEL_CHAT = [interruptorChat, redChatKick, redChatTwitch];

  /* Los controles que un plan sin reproducción no puede tocar. Está
     escrita una sola vez y la usa `pintarPlan`: dos listas distintas
     de "qué se apaga" terminan siendo dos comportamientos. */
  const CONTROLES_DE_LA_PELI = [
    'boton-reproducir', 'boton-pausar', 'boton-reanudar', 'boton-detener',
    'boton-atras-60', 'boton-atras-10', 'boton-adelante-10', 'boton-adelante-60',
  ];

  // ---------- avisos ----------

  function avisar(texto) {
    textoAvisoPanel.textContent = texto;
    avisoPanel.hidden = false;
  }
  botonCerrarAviso.addEventListener('click', () => { avisoPanel.hidden = true; });

  // ---------- formato ----------

  function comoTiempo(segundos) {
    const s = Math.max(0, Math.floor(Number(segundos) || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    const dosDigitos = n => String(n).padStart(2, '0');
    return h ? `${h}:${dosDigitos(m)}:${dosDigitos(r)}` : `${m}:${dosDigitos(r)}`;
  }

  function comoPeso(bytes) {
    const b = Number(bytes) || 0;
    if (b <= 0) return '';
    const giga = b / (1024 ** 3);
    return giga >= 1 ? `${giga.toFixed(2)} GB` : `${Math.round(b / (1024 ** 2))} MB`;
  }

  const comoFecha = ms => (ms ? new Date(ms).toLocaleString('es-AR') : '–');

  // ---------- el reloj, que avanza solo ----------

  let ultimoPanel = null;
  let desfase = 0;                       // ms para pasar del reloj local al del servidor
  const ahoraServidor = () => Date.now() + desfase;

  /** El segundo de la película en el que va la sala, ahora mismo. */
  function posicionAhora(reloj = ultimoPanel?.reloj) {
    if (!reloj || reloj.estado === 'detenido' || !reloj.videoId) return null;
    const empezoEn = Number(reloj.empezoEn ?? 0);
    const base = Number(reloj.offsetInicial ?? 0);
    const hasta = reloj.estado === 'pausado' ? Number(reloj.pausadoEn ?? empezoEn) : ahoraServidor();
    const pos = base + (hasta - empezoEn) / 1000;
    const duracion = Number(reloj.duracion ?? 0);
    return Math.max(0, duracion > 0 ? Math.min(pos, duracion) : pos);
  }

  function pintarPosicion() {
    const reloj = ultimoPanel?.reloj;
    const pos = posicionAhora(reloj);
    if (pos === null) { posicionReloj.textContent = '–'; return; }
    posicionReloj.textContent = `${comoTiempo(pos)} / ${comoTiempo(reloj.duracion)}`;
  }

  // el número tiene que moverse aunque la consulta venga cada 4 s
  setInterval(pintarPosicion, 500);

  // ---------- pintar ----------

  function filaRed(color, texto) {
    const p = document.createElement('p');
    p.className = 'fila-red';
    const puntito = document.createElement('span');
    puntito.className = 'puntito ' + color;
    const span = document.createElement('span');
    span.textContent = texto;
    p.append(puntito, span);
    return p;
  }

  const ultimaComo = iso => (iso ? 'última: ' + new Date(iso).toLocaleString('es-AR') : 'sin mensajes todavía');

  function mostrarSinSesion() {
    /* Se rearma la tarjeta en vez de escribir en `texto-carga`: si
       antes hubo sesión, ese párrafo ya no está en el árbol (lo sacó
       `pintarSalud`) y escribirle no se vería en ningún lado. La sesión
       se puede caer en medio de la noche y el panel tiene que decirlo. */
    tarjetaEstado.textContent = '';
    const p = document.createElement('p');
    p.textContent = 'todavía no entraste con Kick';
    tarjetaEstado.appendChild(p);
    /* Sin sesión de dueño no se puede vincular Twitch: entrar con Kick
       no autoriza nada por sí solo, pero sin eso no hay ni siquiera con
       quién asociar el vínculo. */
    linkTwitch.classList.add('apagado');
    linkTwitch.setAttribute('aria-disabled', 'true');
    for (const t of [tarjetaSala, tarjetaVideos, tarjetaMetricas, tarjetaClave, tarjetaWebhook, tarjetaPlan,
                     tarjetaChatAbierto]) {
      t.hidden = true;
    }
    botonDesvincularTwitch.hidden = true;
  }

  function pintarSalud(salud) {
    tarjetaEstado.textContent = '';   // se rearma con createElement, nunca con innerHTML

    const kick = salud.kick;
    const colorKick = !kick.vinculado ? 'mal' : kick.suscripcion === 'activa' ? 'bien' : 'regular';
    tarjetaEstado.appendChild(filaRed(colorKick,
      `Kick: ${kick.vinculado ? 'vinculado' : 'no vinculado'} · suscripción ${kick.suscripcion}` +
      ` · ${kick.vivo ? 'en vivo' : 'apagado'} · ${ultimaComo(kick.ultima)}`));

    if (kick.sospechoso) {
      tarjetaEstado.appendChild(filaRed('mal',
        'el canal está en vivo y hace más de 5 minutos que no llega nada de Kick'));
    }

    const twitch = salud.twitch;
    const colorTwitch = !twitch.vinculado ? 'mal'
      : twitch.estado === 'conectado' ? 'bien'
      : twitch.estado === 'cortado' ? 'mal' : 'regular';
    tarjetaEstado.appendChild(filaRed(colorTwitch,
      `Twitch: ${twitch.vinculado ? 'vinculado' : 'no vinculado'} · ${twitch.estado} (${twitch.modo})` +
      ` · ${ultimaComo(twitch.ultima)}`));

    if (kick.vinculado) {
      const boton = document.createElement('button');
      boton.type = 'button';
      boton.className = 'boton-secundario';
      boton.textContent = 'Resuscribir Kick';
      boton.addEventListener('click', () => {
        boton.disabled = true;
        fetch('/api/chat/resuscribir', { method: 'POST', credentials: 'same-origin' })
          .then(() => consultar())
          .catch(() => avisar('no se pudo resuscribir'))
          .finally(() => { boton.disabled = false; });
      });
      tarjetaEstado.appendChild(boton);
    }

    /* Que la conexión no se abrió por el tope de conexiones del
       proceso, no por un problema de este creador. Sin decirlo, su
       panel diría "cortado" y no habría forma de distinguirlo de
       Twitch caído. */
    if (twitch.tope) {
      tarjetaEstado.appendChild(filaRed('regular',
        'Twitch quedó sin conectar: este servidor llegó a su tope de conexiones. ' +
        'Kick sigue andando igual, que es lo que la Sala necesita.'));
    }

    linkTwitch.classList.remove('apagado');
    linkTwitch.removeAttribute('aria-disabled');
    linkKick.textContent = 'Volver a entrar con Kick';
    if (twitch.vinculado) linkTwitch.textContent = 'Volver a vincular Twitch';
    botonDesvincularTwitch.hidden = !twitch.vinculado;
  }

  function pintarReloj(reloj) {
    const detenido = !reloj || reloj.estado === 'detenido' || !reloj.videoId;
    puntitoReloj.className = 'puntito ' + (detenido ? 'mal' : reloj.estado === 'pausado' ? 'regular' : 'bien');
    estadoReloj.textContent = detenido
      ? 'sin nada puesto'
      : `${reloj.estado === 'pausado' ? 'en pausa' : 'reproduciendo'}: ${reloj.titulo || reloj.videoId}`;
    pintarPosicion();
  }

  function pintarVideos(videos, reloj) {
    listaVideos.textContent = '';
    sinVideos.hidden = videos.length > 0;

    /* El select se rearma sólo si cambió la lista: si no, se pierde lo
       que el dueño acababa de elegir cada cuatro segundos. */
    const firma = videos.map(v => v.id).join('|');
    if (selectVideo.dataset.firma !== firma) {
      const elegido = selectVideo.value;
      selectVideo.textContent = '';
      const vacio = document.createElement('option');
      vacio.value = '';
      vacio.textContent = '— elegí un video —';
      selectVideo.appendChild(vacio);
      for (const v of videos) {
        const opcion = document.createElement('option');
        opcion.value = v.id;
        opcion.textContent = `${v.titulo} (${comoTiempo(v.duracion)})`;
        selectVideo.appendChild(opcion);
      }
      selectVideo.dataset.firma = firma;
      if (videos.some(v => v.id === elegido)) selectVideo.value = elegido;
    }

    for (const v of videos) {
      const li = document.createElement('li');

      const nombre = document.createElement('span');
      nombre.className = 'nombre-video';
      nombre.textContent = v.titulo;
      li.appendChild(nombre);

      const datos = document.createElement('span');
      datos.className = 'dato-video';
      const peso = comoPeso(v.bytes);
      datos.textContent = [comoTiempo(v.duracion), v.calidades.map(c => c + 'p').join('/'), peso]
        .filter(Boolean).join(' · ');
      li.appendChild(datos);

      if (reloj && reloj.videoId === v.id && reloj.estado !== 'detenido') {
        const marca = document.createElement('span');
        marca.className = 'video-en-marcha';
        marca.textContent = 'en marcha';
        li.appendChild(marca);
      } else {
        const boton = document.createElement('button');
        boton.type = 'button';
        boton.className = 'boton-panel';
        boton.textContent = 'Reproducir';
        boton.addEventListener('click', () => mandarReloj('reproducir', { videoId: v.id }));
        li.appendChild(boton);
      }

      listaVideos.appendChild(li);
    }
  }

  function pintarMetricas(m) {
    el('dato-desde').textContent = comoFecha(m.desde);
    el('dato-mensajes-hora').textContent = String(m.mensajesUltimaHora);
    el('dato-mensajes-total').textContent = String(m.mensajesTotales);
    el('dato-envios').textContent = String(m.envios);
    el('dato-envios-ok').textContent = String(m.enviosOk);
    el('dato-429').textContent = String(m.errores429);
    el('dato-pico-metricas').textContent = String(m.espectadoresPico);

    graficoHoras.textContent = '';
    const techo = Math.max(1, ...m.mensajesPorHora.map(h => h.cuenta));
    for (const h of m.mensajesPorHora) {
      const barra = document.createElement('span');
      barra.style.height = Math.round((h.cuenta / techo) * 100) + '%';
      barra.title = `${h.cuenta} mensajes`;
      graficoHoras.appendChild(barra);
    }
  }

  function pintarClave(clave) {
    estadoClave.textContent = clave.hay
      ? `hay una, creada el ${comoFecha(clave.creada)}`
      : 'no hay ninguna: el script de subida no va a poder avisarle al servidor';
  }

  // ---------- el plan ----------

  const COLOR_PLAN = { dueno: 'bien', amigo: 'bien', pago: 'bien', pendiente: 'regular', vencido: 'mal' };

  const EXPLICA_PLAN = {
    dueno: 'Sos el dueño del servicio: tu sala no tiene plan ni tope.',
    amigo: 'Te lo dio el dueño. Podés reproducir sin pagar nada.',
    pago: 'Suscripción al día.',
    pendiente: 'Tu sala se puede abrir y leer el chat, pero todavía no puede reproducir. ' +
               'Suscribite o pedile al dueño que te ponga como amigo.',
    vencido: 'Tu suscripción venció y la sala dejó de reproducir. Tus videos siguen donde estaban.',
  };

  /**
   * Pinta el plan y, sobre todo, APAGA lo que el plan no deja hacer.
   *
   * Apagar los botones acá es comodidad, no seguridad: el servidor
   * contesta 402 a cualquier acción del reloj sin plan activo, tenga o
   * no la página los botones apagados. Lo que esto evita es que
   * alguien toque play y no pase nada sin explicación.
   */
  function pintarPlan(datos) {
    const plan = datos.plan ?? '';
    puntitoPlan.className = 'puntito ' + (COLOR_PLAN[plan] ?? 'regular');
    textoPlan.textContent = plan || 'sin plan';
    explicaPlan.textContent = EXPLICA_PLAN[plan] ?? '';

    const uso = datos.uso ?? {};
    if (uso.topeGb === null || uso.topeGb === undefined) {
      lineaUso.textContent = `Usás ${uso.gb ?? 0} GB en el bucket.`;
    } else {
      lineaUso.textContent = `Usás ${uso.gb ?? 0} GB de ${uso.topeGb} GB.`;
    }
    if (uso.real === false) {
      /* El número es la última foto y no lo que hay en R2 ahora. Se
         dice, en vez de mostrarlo como si fuera de ahora. */
      lineaUso.textContent += uso.medido
        ? ` (medido el ${comoFecha(uso.medido)})`
        : ' (todavía sin medir contra R2)';
    }

    const puedeSuscribirse = Boolean(datos.soloLectura) && !datos.esDueno;
    botonSuscribirse.hidden = !puedeSuscribirse;
    if (puedeSuscribirse && datos.cobro && !datos.cobro.listo) {
      botonSuscribirse.disabled = true;
      botonSuscribirse.textContent = 'Suscribirme (el cobro todavía no está configurado)';
    } else {
      botonSuscribirse.disabled = false;
      botonSuscribirse.textContent = datos.cobro?.monto
        ? `Suscribirme por ${datos.cobro.monto} ${datos.cobro.moneda} al mes`
        : 'Suscribirme';
    }

    linkAdmin.hidden = !datos.esDueno;

    for (const id of CONTROLES_DE_LA_PELI) {
      const boton = el(id);
      if (boton) boton.disabled = Boolean(datos.soloLectura);
    }
    selectVideo.disabled = Boolean(datos.soloLectura);

    tarjetaPlan.hidden = false;
  }

  // ---------- el chat abierto ----------

  /* Mientras sale un cambio, la consulta de cada 4 s no repinta este
     bloque: si no, el interruptor que el creador acaba de tocar volvería
     un instante a como estaba antes, que es justo lo que hace dudar si
     el click anduvo. */
  let enviandoChat = false;

  /* El link público, con el origen desde el que se mira ESTA página. No
     sale del servidor: detrás de un proxy (Cloudflare Pages reenviando a
     Railway) el dominio que hay que compartir es el del proxy. */
  const linkDelChat = slug => new URL('/chat/' + encodeURIComponent(slug), location.href).href;

  function pintarChatAbierto(chat, slug, salud) {
    if (enviandoChat || !chat) return;
    const redes = Array.isArray(chat.redes) ? chat.redes : [];
    interruptorChat.checked = Boolean(chat.activo);
    estadoChatAbierto.textContent = chat.activo
      ? 'Abierto: lo ve cualquiera que tenga el link'
      : 'Cerrado';
    redChatKick.checked = redes.includes('kick');
    redChatTwitch.checked = redes.includes('twitch');
    /* Twitch elegido pero sin vincular: no rompe nada (de ahí no llega
       nada), pero sin decirlo parece que el chat anda a medias. */
    notaTwitchChat.hidden = !redChatTwitch.checked || Boolean(salud?.twitch?.vinculado);

    const link = linkDelChat(slug ?? '');
    linkChatAbierto.textContent = link;
    abrirChatAbierto.href = link;
    tarjetaChatAbierto.hidden = false;
  }

  function mandarChat(tocado) {
    const redes = [];
    if (redChatKick.checked) redes.push('kick');
    if (redChatTwitch.checked) redes.push('twitch');
    if (!redes.length) {
      /* Un chat sin ninguna red no muestra nada: se vuelve a marcar la
         que acaban de sacar en vez de mandar algo que el servidor
         rechazaría igual. */
      tocado.checked = true;
      avisar('elegí al menos una red');
      return;
    }

    enviandoChat = true;
    for (const c of CONTROLES_DEL_CHAT) c.disabled = true;

    /* Nunca va el slug: el servidor usa el de la cookie. */
    fetch('/api/panel/chat', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ activo: Boolean(interruptorChat.checked), redes }),
    })
      .then(async r => {
        const datos = await r.json().catch(() => null);
        if (!r.ok) { avisar(datos?.error || `no se pudo (http ${r.status})`); return null; }
        avisoPanel.hidden = true;
        return datos?.chatAbierto ?? null;
      })
      .catch(() => { avisar('no se pudo hablar con el servidor'); return null; })
      .then(chat => {
        enviandoChat = false;
        for (const c of CONTROLES_DEL_CHAT) c.disabled = false;
        if (!ultimoPanel) return;
        if (chat) ultimoPanel.chatAbierto = chat;
        /* Salga bien o mal, la pantalla vuelve a decir lo que dice el
           servidor: si falló, el interruptor vuelve a donde estaba. */
        pintarChatAbierto(ultimoPanel.chatAbierto, ultimoPanel.slug, ultimoPanel.salud);
      });
  }

  for (const control of CONTROLES_DEL_CHAT) {
    control.addEventListener('change', () => mandarChat(control));
  }

  el('boton-copiar-link-chat').addEventListener('click', async () => {
    const link = linkChatAbierto.textContent;
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      avisar('link copiado: pasalo en tu chat o en tus redes');
    } catch {
      avisar('el navegador no dejó copiar: seleccioná el link y copialo a mano');
    }
  });

  function pintar(datos) {
    ultimoPanel = datos;
    pintarSalud(datos.salud);
    pintarPlan(datos);
    pintarChatAbierto(datos.chatAbierto, datos.slug, datos.salud);
    pintarReloj(datos.reloj);
    pintarVideos(datos.videos ?? [], datos.reloj);
    pintarMetricas(datos.metricas);
    pintarClave(datos.claveSubida);

    datoConectados.textContent = String(datos.conectados ?? 0);
    datoPico.textContent = String(datos.metricas?.espectadoresPico ?? 0);
    linkSala.href = '/sala/' + encodeURIComponent(datos.slug ?? '');
    urlWebhook.textContent = datos.urlWebhook ?? '';

    /* El ejemplo del comando de subida lleva el slug de quien mira: es
       el argumento que de verdad tiene que escribir. */
    const ejemplo = el('ejemplo-slug');
    if (ejemplo) ejemplo.textContent = datos.slug ?? 'tu-canal';

    /* El desfase con el servidor sale del mismo pedido: `hora` es la
       del servidor en el momento de contestar. Alcanza para que el
       contador de posición no se corra en una máquina con el reloj
       torcido. */
    if (Number.isFinite(Number(datos.hora))) desfase = Number(datos.hora) - Date.now();

    for (const t of [tarjetaSala, tarjetaVideos, tarjetaMetricas, tarjetaClave]) {
      t.hidden = false;
    }
    /* La del webhook sólo si hay algo que mostrar: el servidor le manda
       la URL vacía a quien no es el dueño del servicio. */
    tarjetaWebhook.hidden = !datos.urlWebhook;
  }

  // ---------- acciones ----------

  function mandarReloj(accion, extra = {}) {
    const slug = ultimoPanel?.slug;
    if (!slug) { avisar('el servidor no sabe cuál es tu canal (falta KICK_SLUG)'); return; }
    return fetch(`/api/sala/${encodeURIComponent(slug)}/reloj`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accion, ...extra }),
    })
      .then(async r => {
        const datos = await r.json().catch(() => null);
        if (!r.ok) { avisar(datos?.error || `no se pudo (http ${r.status})`); return; }
        avisoPanel.hidden = true;
        /* La respuesta trae el reloj nuevo: se pinta ya, sin esperar la
           próxima consulta. */
        if (ultimoPanel && datos?.reloj) {
          ultimoPanel.reloj = datos.reloj;
          pintarReloj(datos.reloj);
          pintarVideos(ultimoPanel.videos ?? [], datos.reloj);
        }
      })
      .catch(() => avisar('no se pudo hablar con el servidor'));
  }

  el('boton-reproducir').addEventListener('click', () => {
    const videoId = selectVideo.value;
    if (!videoId) { avisar('elegí un video primero'); return; }
    mandarReloj('reproducir', { videoId });
  });
  el('boton-pausar').addEventListener('click', () => mandarReloj('pausar'));
  el('boton-reanudar').addEventListener('click', () => mandarReloj('reanudar'));
  el('boton-detener').addEventListener('click', () => mandarReloj('detener'));
  el('boton-atras-60').addEventListener('click', () => mandarReloj('saltar', { segundos: -60 }));
  el('boton-atras-10').addEventListener('click', () => mandarReloj('saltar', { segundos: -10 }));
  el('boton-adelante-10').addEventListener('click', () => mandarReloj('saltar', { segundos: 10 }));
  el('boton-adelante-60').addEventListener('click', () => mandarReloj('saltar', { segundos: 60 }));

  // ---------- la clave ----------

  let claveEnMano = '';

  el('boton-generar-clave').addEventListener('click', () => {
    fetch('/api/panel/clave', { method: 'POST', credentials: 'same-origin' })
      .then(async r => {
        const datos = await r.json().catch(() => null);
        if (!r.ok || !datos?.clave) { avisar(datos?.error || 'no se pudo generar'); return; }
        claveEnMano = datos.clave;
        cajaClave.hidden = false;
        /* NO se pinta el valor: sólo aparece si tocan "Mostrar igual". */
        valorClave.hidden = true;
        valorClave.textContent = '';
        consultar();
      })
      .catch(() => avisar('no se pudo hablar con el servidor'));
  });

  el('boton-revocar-clave').addEventListener('click', () => {
    fetch('/api/panel/clave', { method: 'DELETE', credentials: 'same-origin' })
      .then(() => { claveEnMano = ''; cajaClave.hidden = true; consultar(); })
      .catch(() => avisar('no se pudo revocar'));
  });

  el('boton-copiar-clave').addEventListener('click', async () => {
    if (!claveEnMano) return;
    try {
      await navigator.clipboard.writeText(claveEnMano);
      avisar('copiada. Pegala en herramientas/.env y no la dejes en el portapapeles.');
    } catch {
      avisar('el navegador no dejó copiar: usá "Mostrar igual" con la transmisión cortada');
    }
  });

  el('boton-mostrar-clave').addEventListener('click', () => {
    if (!claveEnMano) return;
    valorClave.textContent = claveEnMano;
    valorClave.hidden = false;
  });

  // ---------- el plan y Twitch ----------

  botonSuscribirse.addEventListener('click', () => {
    botonSuscribirse.disabled = true;
    fetch('/api/panel/suscribirse', { method: 'POST', credentials: 'same-origin' })
      .then(async r => {
        const datos = await r.json().catch(() => null);
        if (!r.ok || !datos?.url) {
          avisar(datos?.error || `no se pudo (http ${r.status})`);
          return;
        }
        /* El checkout es del proveedor de cobro: se abre en otra
           pestaña para no perder el panel, y con rel="noopener" por la
           misma razón que el botón de suscribirse de la Sala. */
        const ventana = window.open(datos.url, '_blank', 'noopener,noreferrer');
        if (!ventana) avisar('el navegador bloqueó la ventana del pago: permitila y probá de nuevo');
      })
      .catch(() => avisar('no se pudo hablar con el servidor'))
      .finally(() => { botonSuscribirse.disabled = false; });
  });

  botonDesvincularTwitch.addEventListener('click', () => {
    botonDesvincularTwitch.disabled = true;
    fetch('/api/panel/twitch', { method: 'DELETE', credentials: 'same-origin' })
      .then(() => consultar())
      .catch(() => avisar('no se pudo desvincular'))
      .finally(() => { botonDesvincularTwitch.disabled = false; });
  });

  // ---------- consultar ----------

  function consultar() {
    return fetch('/api/panel', { credentials: 'same-origin' })
      .then(r => {
        if (r.status === 401) { mostrarSinSesion(); return null; }
        if (!r.ok) throw new Error('http ' + r.status);
        return r.json();
      })
      .then(datos => { if (datos) pintar(datos); })
      .catch(() => {
        /* Igual que en mostrarSinSesion: el párrafo original puede ya
           no estar en el árbol, así que se rearma. Un corte de red no
           puede dejar la pantalla mostrando datos viejos sin avisar. */
        textoCarga.textContent = 'no se pudo consultar el estado';
        if (!textoCarga.parentElement) {
          tarjetaEstado.textContent = '';
          tarjetaEstado.appendChild(textoCarga);
        }
      });
  }

  consultar();
  setInterval(consultar, CADA_CONSULTA);

  window.SalaPanel = { posicionAhora, comoTiempo, consultar, pintar, pintarPlan };
})();
