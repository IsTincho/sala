/* ============================================================
   La página de alta. Hace una sola cosa: no dejar seguir sin aceptar
   los términos.

   ---------------------------------------------------------------
   ESTA CASILLA NO ES LA QUE MANDA

   Apagar un link con JavaScript no impide nada: cualquiera puede
   escribir la dirección a mano. La aceptación de verdad la exige el
   servidor, que sólo crea un creador nuevo si el flujo de OAuth traía
   la versión de los términos, y esa versión viaja del lado del
   servidor (en el Map de logins pendientes), no en la URL del
   callback.

   O sea: acá el checkbox es la interfaz de la decisión, y allá está la
   puerta. Las dos cosas hacen falta y ninguna reemplaza a la otra.
   ============================================================ */
(() => {
  const acepto = document.getElementById('acepto-terminos');
  const boton = document.getElementById('boton-entrar');
  const aviso = document.getElementById('aviso-acepto');

  if (!acepto || !boton) return;

  function pintar() {
    /* `Boolean` y no el valor pelado: una casilla que todavía no se
       tocó puede dar `undefined`, y `hidden = undefined` deja el
       atributo en un estado que no es ni sí ni no. */
    const listo = Boolean(acepto.checked);
    boton.classList.toggle('apagado', !listo);
    if (listo) boton.removeAttribute('aria-disabled');
    else boton.setAttribute('aria-disabled', 'true');
    if (aviso) aviso.hidden = listo;
  }

  /* Un `<a>` no se puede deshabilitar como un botón: hay que atajar el
     click. Se ataja en captura para que ningún otro listener llegue
     antes. */
  boton.addEventListener('click', (e) => {
    if (acepto.checked) return;
    e.preventDefault();
    if (aviso) {
      aviso.hidden = false;
      aviso.textContent = 'Falta marcar la casilla de los términos.';
    }
    acepto.focus();
  });

  acepto.addEventListener('change', pintar);
  pintar();

  window.SalaCrear = { pintar };
})();
