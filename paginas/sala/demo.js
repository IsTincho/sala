/* ============================================================
   Datos de mentira para /sala/<canal>?demo=1.

   Existe para poder mirar y ajustar la Sala sin servidor, sin R2 y
   sin credenciales: con abrir la página alcanza. Es lo mismo que hace
   chat/demo.js con el Chat Global.

   El video de ejemplo es una playlist HLS pública de prueba (Apple
   Bip-Bop, la que usa la propia documentación de hls.js). No es
   contenido de nadie ni pesa en R2: si no hay internet, el player
   muestra su error y el resto de la página se ve igual.
   ============================================================ */
(() => {
  const HACE_UN_RATO = Date.now() - 42 * 1000;

  const MENSAJES = [
    { usuario: 'lauti', color: '#53fc18', texto: 'arrancó!!', insignias: [{ tipo: 'subscriber', texto: 'Sub' }] },
    { usuario: 'moderadora', color: '#ff5733', texto: 'bajen el volumen del micro', insignias: [{ tipo: 'moderator', texto: 'Mod' }] },
    { usuario: 'unaespectadora', color: '', texto: 'esta parte es la mejor', insignias: [] },
    { usuario: 'pepe', color: '#0000ff', texto: 'se ve perfecto acá', insignias: [] },
    { usuario: 'tincho', color: '#53fc18', texto: 'no spoileen 😤', insignias: [] },
  ];

  let n = 0;

  const armar = (base, i) => ({
    tipo: 'chat',
    red: 'kick',
    id: `demo-${i}`,
    usuario: base.usuario,
    color: base.color,
    insignias: base.insignias,
    texto: base.texto,
    emotes: [],
    hora: new Date().toISOString(),
  });

  window.SalaDemoSala = {
    sesion: () => ({ entrado: false, nombre: '', puedeEscribir: false }),
    conectados: () => 137,
    reloj: () => ({
      tipo: 'reloj',
      estado: 'reproduciendo',
      videoId: 'demo',
      titulo: 'Película de ejemplo',
      url: 'https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/master.m3u8',
      duracion: 1800,
      calidades: [720, 1080],
      subtitulos: [],
      empezoEn: HACE_UN_RATO,
      pausadoEn: null,
      offsetInicial: 0,
      posicion: 42,
      ahora: Date.now(),
    }),
    mensajes: () => MENSAJES.map((m, i) => armar(m, i)),
    siguiente: () => armar(MENSAJES[n % MENSAJES.length], 100 + n++),
  };
})();
