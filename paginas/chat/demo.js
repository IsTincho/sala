/* ============================================================
   Datos de ejemplo para ?demo=1 en chat.html.

   Existe para que la pagina del Chat Global se pueda ver COMPLETA
   y viva sin backend: abriendo el archivo con file:// no hay
   fetch, ni SSE, ni service worker, asi que hace falta algo que
   simule mensajes cayendo. chat.js llama a estas funciones en vez
   de conectarse al bus cuando detecta ?demo=1.

   Los mensajes de mensajes() cubren, a proposito, los casos raros
   que rompen un render ingenuo:
     - emoji SUELTO en el texto antes de un emote: si chat.js corta
       por indices de string en vez de indices de code point, el
       emote va a aparecer desplazado o va a comerse texto de mas.
     - un color de usuario oscuro/ilegible sobre fondo oscuro, para
       probar que chat.js lo aclara.
     - <script>alert(1)</script> como texto: si chat.js usara
       innerHTML en vez de textContent, esto ejecutaria.
     - 6 insignias, para probar el tope de 4 + "+N".
     - un respondeA, y un texto larguisimo.
   ============================================================ */
(() => {
  // IDs incrementales para siguiente(): que no se repitan con los
  // de mensajes() ni entre si.
  let contador = 100;

  const mensajesBase = [
    {
      tipo: 'chat', red: 'kick', id: 'demo-1', usuario: 'ElkaChonda',
      color: '#53fc18', insignias: [{ tipo: 'suscriptor', texto: 'Sub 6' }],
      texto: 'buenas gente, recien llego',
      emotes: [], hora: new Date(Date.now() - 60000).toISOString(),
    },
    {
      tipo: 'chat', red: 'twitch', id: 'demo-2', usuario: 'purple_viewer',
      color: '#9146ff', insignias: [{ tipo: 'moderador', texto: 'Mod' }],
      texto: 'hola desde twitch',
      emotes: [], hora: new Date(Date.now() - 55000).toISOString(),
    },
    {
      // emoji suelto ANTES del emote: prueba de indices en code points.
      // 'texto' en code points: [👋,h,o,l,a,' ',K,a,p,p,a,' ',c,o,m,o,' ',v,a]
      // "Kappa" ocupa los indices 6 a 11 (fin exclusivo) EN CODE POINTS.
      // 👋 (U+1F44B) son 2 unidades UTF-16: si el codigo cortara sobre el
      // string crudo en vez de sobre [...texto], el corte quedaria
      // desplazado y el emote saldria mal puesto o mordido.
      tipo: 'chat', red: 'twitch', id: 'demo-3', usuario: 'code_point_tester',
      color: '#ff6ec7', insignias: [],
      texto: '👋hola Kappa como va',
      emotes: [{ id: '25', inicio: 6, fin: 11, url: 'https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/3.0' }],
      hora: new Date(Date.now() - 50000).toISOString(),
    },
    {
      // emote real de Kick (7tv/kick cdn de ejemplo) sobre texto simple
      tipo: 'chat', red: 'kick', id: 'demo-4', usuario: 'kickero',
      color: '#53fc18', insignias: [],
      texto: 'mira esto KEKW que bueno',
      emotes: [{ id: '39547', inicio: 10, fin: 14, url: 'https://files.kick.com/emotes/39547/fullsize' }],
      hora: new Date(Date.now() - 45000).toISOString(),
    },
    {
      // respondeA: recorte de un mensaje anterior
      tipo: 'chat', red: 'kick', id: 'demo-5', usuario: 'ElkaChonda',
      color: '#53fc18', insignias: [],
      texto: 'si, todo bien por aca',
      emotes: [], hora: new Date(Date.now() - 40000).toISOString(),
      respondeA: { id: 'demo-2', usuario: 'purple_viewer', texto: 'hola desde twitch' },
    },
    {
      // color oscuro ilegible sobre fondo oscuro (el clasico azul de twitch)
      tipo: 'chat', red: 'twitch', id: 'demo-6', usuario: 'azul_oscuro',
      color: '#0000FF', insignias: [{ tipo: 'suscriptor', texto: 'Sub 24' }],
      texto: 'mi color deberia aclararse para leerse',
      emotes: [], hora: new Date(Date.now() - 35000).toISOString(),
    },
    {
      // 6 insignias: prueba el tope de 4 + "+N"
      tipo: 'chat', red: 'kick', id: 'demo-7', usuario: 'insignias_varias',
      color: '#f39c12',
      insignias: [
        { tipo: 'moderador', texto: 'Mod' },
        { tipo: 'suscriptor', texto: 'Sub 36' },
        { tipo: 'vip', texto: 'VIP' },
        { tipo: 'og', texto: 'OG' },
        { tipo: 'fundador', texto: 'Fundador' },
        { tipo: 'bot', texto: 'Bot' },
      ],
      texto: 'tengo un monton de insignias',
      emotes: [], hora: new Date(Date.now() - 30000).toISOString(),
    },
    {
      // texto largo
      tipo: 'chat', red: 'twitch', id: 'demo-8', usuario: 'el_del_texto_largo',
      color: '#33aacc', insignias: [],
      texto: 'esto es un mensaje bastante largo para probar que el chat no se rompe ni desborda horizontalmente cuando alguien escribe un montón de texto seguido sin espacios raros y ademas sigue y sigue y sigue un poco mas todavia para asegurarnos'.repeat(1),
      emotes: [], hora: new Date(Date.now() - 25000).toISOString(),
    },
    {
      // intento de XSS: tiene que quedar como texto literal, nunca ejecutar
      tipo: 'chat', red: 'kick', id: 'demo-9', usuario: 'probando_xss',
      color: '#e8503c', insignias: [],
      texto: '<script>alert(1)</script>',
      emotes: [], hora: new Date(Date.now() - 20000).toISOString(),
    },
    {
      tipo: 'chat', red: 'kick', id: 'demo-10', usuario: 'otro_kick',
      color: '', insignias: [],
      texto: 'sin color: deberia usar el verde de kick',
      emotes: [], hora: new Date(Date.now() - 15000).toISOString(),
    },
    {
      tipo: 'chat', red: 'twitch', id: 'demo-11', usuario: 'color_invalido',
      color: 'rgb(1,2,3)', insignias: [],
      texto: 'color invalido: deberia usar el violeta de twitch',
      emotes: [], hora: new Date(Date.now() - 10000).toISOString(),
    },
    {
      // dos emotes en el mismo mensaje, no solapados
      tipo: 'chat', red: 'kick', id: 'demo-12', usuario: 'doble_emote',
      color: '#53fc18', insignias: [],
      texto: 'KEKW eso estuvo bueno KEKW',
      emotes: [
        { id: '39547', inicio: 0, fin: 4, url: 'https://files.kick.com/emotes/39547/fullsize' },
        { id: '39547', inicio: 22, fin: 26, url: 'https://files.kick.com/emotes/39547/fullsize' },
      ],
      hora: new Date(Date.now() - 5000).toISOString(),
    },
  ];

  const usuariosSiguiente = [
    { usuario: 'espectador_nuevo', red: 'kick', color: '#53fc18' },
    { usuario: 'otro_de_twitch', red: 'twitch', color: '#9146ff' },
    { usuario: 'fan_del_stream', red: 'kick', color: '#ff8800' },
    { usuario: 'lurker_activo', red: 'twitch', color: '#00c2cc' },
  ];

  const textosSiguiente = [
    'que buen stream',
    'jajajaja',
    'KEKW',
    'saludos desde argentina',
    'esto va a estar bueno',
    'F',
    'link del video?',
    'gg',
  ];

  // Devuelve el array completo de mensajes de ejemplo (formato exacto del
  // bus). Se devuelve una copia superficial de cada objeto para que quien
  // llama pueda mutar sin afectar a mensajesBase.
  function mensajes() {
    return mensajesBase.map(m => ({ ...m }));
  }

  // Estado de salud plausible: kick vivo pero con la ultima llegada vieja
  // (para poder ver la banda de aviso de "resuscribir"), twitch conectado.
  function salud() {
    return {
      kick: {
        vinculado: true,
        ultima: new Date(Date.now() - 6 * 60 * 1000).toISOString(),
        suscripcion: 'activa',
        vivo: true,
        // el veredicto lo da el servidor y la pagina lo muestra tal
        // cual, asi que la demo tiene que traerlo o la banda de aviso
        // no se puede ver nunca en ?demo=1.
        sospechoso: true,
      },
      twitch: {
        vinculado: true,
        ultima: new Date(Date.now() - 5000).toISOString(),
        estado: 'conectado',
        modo: 'eventsub',
      },
      ahora: new Date().toISOString(),
    };
  }

  // Devuelve un mensaje nuevo cada vez que se lo llama, con id distinto y
  // hora de ahora, para simular el bucle en vivo del chat.
  function siguiente() {
    contador += 1;
    const u = usuariosSiguiente[contador % usuariosSiguiente.length];
    const texto = textosSiguiente[contador % textosSiguiente.length];
    return {
      tipo: 'chat', red: u.red, id: 'demo-nuevo-' + contador,
      usuario: u.usuario, color: u.color, insignias: [],
      texto,
      emotes: [], hora: new Date().toISOString(),
    };
  }

  window.SalaDemo = { mensajes, salud, siguiente };
})();
