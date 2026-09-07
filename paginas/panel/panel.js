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
    for (const t of [tarjetaSala, tarjetaVideos, tarjetaMetricas, tarjetaClave, tarjetaWebhook]) {
      t.hidden = true;
    }
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

    linkTwitch.classList.remove('apagado');
    linkTwitch.removeAttribute('aria-disabled');
    linkKick.textContent = 'Volver a entrar con Kick';
    if (twitch.vinculado) linkTwitch.textContent = 'Volver a vincular Twitch';
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

  function pintar(datos) {
    ultimoPanel = datos;
    pintarSalud(datos.salud);
    pintarReloj(datos.reloj);
    pintarVideos(datos.videos ?? [], datos.reloj);
    pintarMetricas(datos.metricas);
    pintarClave(datos.claveSubida);

    datoConectados.textContent = String(datos.conectados ?? 0);
    datoPico.textContent = String(datos.metricas?.espectadoresPico ?? 0);
    linkSala.href = '/sala/' + encodeURIComponent(datos.slug ?? '');
    urlWebhook.textContent = datos.urlWebhook ?? '';

    /* El desfase con el servidor sale del mismo pedido: `hora` es la
       del servidor en el momento de contestar. Alcanza para que el
       contador de posición no se corra en una máquina con el reloj
       torcido. */
    if (Number.isFinite(Number(datos.hora))) desfase = Number(datos.hora) - Date.now();

    for (const t of [tarjetaSala, tarjetaVideos, tarjetaMetricas, tarjetaClave, tarjetaWebhook]) {
      t.hidden = false;
    }
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

  window.SalaPanel = { posicionAhora, comoTiempo, consultar, pintar };
})();
