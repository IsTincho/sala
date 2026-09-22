/* ============================================================
   /admin: la lista de creadores, el plan de cada uno y el uso.

   Es la pantalla del dueño del SERVICIO, no la de un creador. Lo único
   que escribe es el plan, y sólo los dos que le corresponden.

   ---------------------------------------------------------------
   Nada de innerHTML: los nombres de canal vienen de Kick, o sea de
   afuera, y el DOM de mentira de las pruebas hace tirar innerHTML a
   propósito.
   ============================================================ */
(() => {
  const el = id => document.getElementById(id);

  const tarjetaResumen = el('tarjeta-resumen');
  const textoCarga = el('texto-carga-admin');
  const filas = el('filas-creadores');
  const sinCreadores = el('sin-creadores');
  const aviso = el('aviso-admin');
  const textoAviso = el('texto-aviso-admin');

  function avisar(texto) {
    textoAviso.textContent = texto;
    aviso.hidden = false;
  }
  el('boton-cerrar-aviso-admin').addEventListener('click', () => { aviso.hidden = true; });

  const comoFecha = ms => (ms ? new Date(ms).toLocaleDateString('es-AR') : '–');

  /* Un plan por color, con el texto al lado: el color nunca es el único
     canal de información. */
  const COLOR_PLAN = {
    dueno: 'bien',
    amigo: 'bien',
    pago: 'bien',
    pendiente: 'regular',
    vencido: 'mal',
  };

  function celdaPlan(c) {
    const td = document.createElement('td');
    const puntito = document.createElement('span');
    puntito.className = 'puntito ' + (COLOR_PLAN[c.planEfectivo] ?? 'regular');
    td.appendChild(puntito);

    const texto = document.createElement('span');
    /* Los dos, y sólo cuando difieren: si el guardado dice "pago" y el
       que vale hoy dice "vencido", esa diferencia ES la explicación de
       por qué ese creador no puede reproducir. */
    texto.textContent = c.plan === c.planEfectivo
      ? c.planEfectivo
      : `${c.plan} (hoy: ${c.planEfectivo})`;
    td.appendChild(texto);
    return td;
  }

  function botonPlan(slug, plan, etiqueta) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'boton-admin';
    b.textContent = etiqueta;
    b.dataset.slug = slug;
    b.dataset.plan = plan;
    b.addEventListener('click', () => {
      b.disabled = true;
      fetch('/api/admin/plan', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug, plan }),
      })
        .then(async r => {
          const datos = await r.json().catch(() => null);
          if (!r.ok) { avisar(datos?.error || `no se pudo (http ${r.status})`); return; }
          aviso.hidden = true;
          consultar();
        })
        .catch(() => avisar('no se pudo hablar con el servidor'))
        .finally(() => { b.disabled = false; });
    });
    return b;
  }

  /**
   * La celda de la Sala: cómo está, y el botón para darla vuelta.
   *
   * Es una columna propia y no otro botón adentro de «Acciones» a
   * propósito: el plan y la Sala son dos interruptores independientes
   * (una Sala apagada da 404 tenga el plan que tenga), y mezclarlos en
   * la misma celda los haría parecer grados de lo mismo.
   *
   * Al dueño del servicio SÍ se le ofrece, a diferencia del plan: su
   * plan no sale de la base y éste sí, y es el mismo campo que toca
   * desde su panel.
   */
  function celdaSala(c) {
    const td = document.createElement('td');
    const abierta = Boolean(c.salaAbierta);

    const puntito = document.createElement('span');
    puntito.className = 'puntito ' + (abierta ? 'bien' : 'regular');
    td.appendChild(puntito);

    const texto = document.createElement('span');
    texto.textContent = abierta ? 'abierta' : 'cerrada';
    td.appendChild(texto);

    const boton = document.createElement('button');
    boton.type = 'button';
    boton.className = 'boton-admin';
    boton.textContent = abierta ? 'Cerrar' : 'Abrir';
    boton.dataset.slug = c.slug;
    boton.addEventListener('click', () => {
      boton.disabled = true;
      fetch('/api/admin/sala', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: c.slug, abierta: !abierta }),
      })
        .then(async r => {
          const datos = await r.json().catch(() => null);
          if (!r.ok) { avisar(datos?.error || `no se pudo (http ${r.status})`); return; }
          aviso.hidden = true;
          consultar();
        })
        .catch(() => avisar('no se pudo hablar con el servidor'))
        .finally(() => { boton.disabled = false; });
    });
    td.appendChild(boton);

    return td;
  }

  function fila(c) {
    const tr = document.createElement('tr');

    const canal = document.createElement('td');
    const link = document.createElement('a');
    link.href = '/sala/' + encodeURIComponent(c.slug);
    link.textContent = c.slug;
    canal.appendChild(link);
    if (c.nombre && c.nombre !== c.slug) {
      const nombre = document.createElement('span');
      nombre.className = 'nombre-creador';
      nombre.textContent = ' · ' + c.nombre;
      canal.appendChild(nombre);
    }
    if (!c.suscrito) {
      /* Sin suscripción de eventos su chat está mudo, y eso no se ve
         en ningún otro lado de esta pantalla. */
      const mudo = document.createElement('span');
      mudo.className = 'marca-mudo';
      mudo.textContent = 'sin suscripción de chat';
      canal.appendChild(mudo);
    }
    tr.appendChild(canal);

    tr.appendChild(celdaPlan(c));
    tr.appendChild(celdaSala(c));

    const vence = document.createElement('td');
    vence.textContent = c.vence ? comoFecha(c.vence) : '–';
    tr.appendChild(vence);

    const uso = document.createElement('td');
    uso.textContent = `${c.gb} GB`;
    if (!c.medido) uso.title = 'todavía no se midió contra R2';
    tr.appendChild(uso);

    const acciones = document.createElement('td');
    acciones.className = 'acciones';
    if (c.planEfectivo === 'dueno') {
      const nota = document.createElement('span');
      nota.className = 'linea-tenue';
      nota.textContent = 'sale de KICK_SLUG';
      acciones.appendChild(nota);
    } else {
      if (c.plan !== 'amigo') acciones.appendChild(botonPlan(c.slug, 'amigo', 'Amigo'));
      if (c.plan !== 'pendiente') acciones.appendChild(botonPlan(c.slug, 'pendiente', 'Pendiente'));
    }
    tr.appendChild(acciones);

    return tr;
  }

  function pintar(datos) {
    tarjetaResumen.textContent = '';

    const p = document.createElement('p');
    p.textContent = `${datos.cuantos} salas de un tope de ${datos.tope}.`;
    tarjetaResumen.appendChild(p);

    const cobro = document.createElement('p');
    cobro.className = 'linea-tenue';
    cobro.textContent = datos.cobro.listo
      ? `Cobro por ${datos.cobro.proveedor}.`
      : `Cobro sin configurar: ${datos.cobro.falta}`;
    tarjetaResumen.appendChild(cobro);

    /* El aviso que importa antes de que sea tarde: el tope de Kick es
       de canales, y llegar a él deja el chat mudo de los que entren.
       PLAN.md dice pedir la verificación de la app antes de los 500. */
    if (datos.cuantos >= Math.floor(datos.tope * 0.55)) {
      const alerta = document.createElement('p');
      alerta.className = 'alerta-tope';
      alerta.textContent =
        'Ya hay más de la mitad del tope. Pedile a Kick la verificación de la app ' +
        'antes de llegar: pasado el tope las suscripciones fallan y el chat de los ' +
        'que entren queda mudo.';
      tarjetaResumen.appendChild(alerta);
    }

    filas.textContent = '';
    for (const c of datos.creadores) filas.appendChild(fila(c));
    sinCreadores.hidden = datos.creadores.length > 0;
  }

  function consultar() {
    return fetch('/api/admin/creadores', { credentials: 'same-origin' })
      .then(r => {
        if (r.status === 401 || r.status === 403) {
          tarjetaResumen.textContent = '';
          const p = document.createElement('p');
          p.textContent = 'esta pantalla es sólo del dueño: entrá con Kick desde /panel';
          tarjetaResumen.appendChild(p);
          return null;
        }
        if (!r.ok) throw new Error('http ' + r.status);
        return r.json();
      })
      .then(datos => { if (datos) pintar(datos); })
      .catch(() => {
        /* Se rearma la tarjeta: el párrafo original puede ya no estar
           en el árbol, y escribirle no se vería en ningún lado. */
        textoCarga.textContent = 'no se pudo consultar';
        if (!textoCarga.parentElement) {
          tarjetaResumen.textContent = '';
          tarjetaResumen.appendChild(textoCarga);
        }
      });
  }

  consultar();

  window.SalaAdmin = { consultar, pintar };
})();
