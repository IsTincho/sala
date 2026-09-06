// Service worker minimo, solo para que el Chat Global sea instalable como PWA.
// No cachea nada a proposito: el chat es contenido en vivo, y servir una
// version vieja desde cache seria peor que no tener service worker.

self.addEventListener('install', (evento) => {
  self.skipWaiting();
});

self.addEventListener('activate', (evento) => {
  self.clients.claim();
});

// Sin fetch handler que intercepte: los navegadores exigen que exista un
// service worker controlando la pagina para que sea instalable, pero no
// hace falta responder nada propio. Dejamos pasar todo a la red.
self.addEventListener('fetch', (evento) => {});
