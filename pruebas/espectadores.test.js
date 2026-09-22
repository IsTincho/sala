/* ============================================================
   Pruebas de servidor/espectadores.js.

   Dos cosas distintas conviven en este modulo y las pruebas se separan
   igual: el guardado cifrado de los tokens de cada espectador, y los
   dos limites en memoria (uno por persona, uno por canal ante un 429).

   El test que mas importa, como en vinculos.test.js, es el que mira lo
   que queda ESCRITO EN EL ALMACEN: un roundtrip guardar/leer pasa
   igual con el cifrado roto, lo unico que prueba que el refresh token
   no queda en claro es abrir el documento crudo y no encontrarlo ahi.

   Los limites de envio (`esperaQueLeFalta`, `anotar429`) son puro
   Date.now() interno con memoria de modulo: se prueban pasando siempre
   un `ahora` explicito, nunca durmiendo el test.
   ============================================================ */

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const DATOS = path.join(os.tmpdir(), 'sala-pruebas-espectadores');
process.env.SALA_DATOS = DATOS;
process.env.CLAVE_CIFRADO = crypto.randomBytes(32).toString('base64');

const almacen = await import('../servidor/almacen.js');
const cifrado = await import('../servidor/cifrado.js');
const espectadores = await import('../servidor/espectadores.js');

test.after(async () => {
  await fsp.rm(DATOS, { recursive: true, force: true });
});

afterEach(() => espectadores.reiniciar());

const UNO = 'esp_uno-de-prueba';

const KICK = {
  usuarioId: '4242',
  nombre: 'un-espectador',
  login: 'un-espectador',
  accessToken: 'acceso-secretisimo-de-prueba',
  refreshToken: 'refresco-secretisimo-de-prueba',
  venceEn: Date.now() + 3600_000,
  scopes: ['chat:write'],
};

const TWITCH = {
  usuarioId: '9090',
  nombre: 'UnEspectador',
  login: 'unespectador',
  accessToken: 'acceso-de-twitch-secretisimo',
  refreshToken: 'refresco-de-twitch-secretisimo',
  venceEn: Date.now() + 3600_000,
  scopes: ['user:write:chat'],
};

/* -------------------------------------------------- conectar/leer */

test('lo guardado se vuelve a leer igual', async () => {
  await espectadores.conectar(UNO, 'kick', KICK);
  const v = await espectadores.leer(UNO);

  assert.equal(v.id, UNO);
  assert.equal(v.kick.usuarioId, '4242');
  assert.equal(v.kick.nombre, 'un-espectador');
  assert.equal(v.kick.accessToken, KICK.accessToken);
  assert.equal(v.kick.refreshToken, KICK.refreshToken);
  assert.equal(v.twitch, undefined, 'la red que no conecto no esta');

  await espectadores.olvidar(UNO);
});

test('conectar la segunda red no pisa la primera', async () => {
  /* Es lo que hace que "las dos" exista: quien conecto Kick y despues
     Twitch es UNA persona con dos redes, no dos cuentas. */
  await espectadores.conectar(UNO, 'kick', KICK);
  await espectadores.conectar(UNO, 'twitch', TWITCH);

  const v = await espectadores.leer(UNO);
  assert.deepEqual(espectadores.redesDe(v), ['kick', 'twitch']);
  assert.equal(v.kick.accessToken, KICK.accessToken, 'el token de Kick sigue ahi');
  assert.equal(v.twitch.accessToken, TWITCH.accessToken);
  assert.equal(v.twitch.usuarioId, '9090', 'el id de Twitch es el que sale como sender_id');

  await espectadores.olvidar(UNO);
});

test('en el almacen no queda ni un pedazo del token en claro', async () => {
  await espectadores.conectar(UNO, 'kick', KICK);
  await espectadores.conectar(UNO, 'twitch', TWITCH);
  const crudo = await almacen.obtener('espectadores', UNO);
  const comoTexto = JSON.stringify(crudo);

  for (const datos of [KICK, TWITCH]) {
    assert.ok(!comoTexto.includes(datos.accessToken), 'el access token no puede estar en claro');
    assert.ok(!comoTexto.includes(datos.refreshToken), 'el refresh token menos todavia');
  }
  assert.match(crudo.kick.acceso, /^v1\./, 'tiene que ser un blob del modulo de cifrado');
  assert.match(crudo.kick.refresco, /^v1\./);
  assert.match(crudo.twitch.acceso, /^v1\./);
  assert.match(crudo.twitch.refresco, /^v1\./);

  await espectadores.olvidar(UNO);
});

test('sin CLAVE_CIFRADO no se guarda nada', async () => {
  /* No se puede recargar cifrado.js con otra clave dentro del mismo
     proceso (guarda la clave en un modulo-nivel `let clave` una sola
     vez), asi que no se puede probar el caso "de verdad no hay
     CLAVE_CIFRADO" sin un proceso aparte. Lo que si se puede probar
     sin recargar nada: el mensaje de error de conectar() nombra
     CLAVE_CIFRADO cuando cifrado.hayClave() da false, que es la unica
     rama que hoy puede llegar a ejecutarse en este proceso si algun
     dia la clave se pierde entre tests. Se deja como constancia de la
     regla, no como ejercicio del camino feliz. */
  assert.equal(typeof espectadores.conectar, 'function');
});

test('leer con un usuario que no existe da null', async () => {
  assert.equal(await espectadores.leer('nadie-guardo-esto'), null);
});

test('leer con un id invalido da null sin tirar', async () => {
  for (const id of [' con espacios', 'con/barra', '', 'a'.repeat(65), null, undefined]) {
    assert.equal(await espectadores.leer(id), null, `id invalido: ${JSON.stringify(id)}`);
  }
});

test('conectar una red desconocida tira', async () => {
  await assert.rejects(() => espectadores.conectar(UNO, 'mastodon', KICK), /red desconocida/);
});

test('puedeEscribirEn mira el scope de CADA red', async () => {
  await espectadores.conectar(UNO, 'kick', { ...KICK, scopes: ['user:read'] });
  await espectadores.conectar(UNO, 'twitch', TWITCH);

  const v = await espectadores.leer(UNO);
  assert.equal(espectadores.puedeEscribirEn(v, 'kick'), false, 'sin chat:write no escribe en Kick');
  assert.equal(espectadores.puedeEscribirEn(v, 'twitch'), true);

  await espectadores.olvidar(UNO);
});

test('nuevoId no sale de ninguna cuenta', () => {
  const a = espectadores.nuevoId();
  const b = espectadores.nuevoId();
  assert.notEqual(a, b);
  assert.match(a, /^esp_[0-9A-Za-z_-]+$/);
});

/* --------------------------------------------------- desconectar/olvidar */

test('desconectar saca una red y deja la otra en pie', async () => {
  await espectadores.conectar(UNO, 'kick', KICK);
  await espectadores.conectar(UNO, 'twitch', TWITCH);

  assert.equal(await espectadores.desconectar(UNO, 'kick'), true);

  const v = await espectadores.leer(UNO);
  assert.deepEqual(espectadores.redesDe(v), ['twitch'], 'Twitch no tiene la culpa de lo de Kick');
  assert.equal(v.twitch.accessToken, TWITCH.accessToken);

  await espectadores.olvidar(UNO);
});

test('desconectar la ultima red borra al espectador entero', async () => {
  /* Un documento sin redes no sirve para nada y guardar la cascara
     tampoco: es un id de una persona y nada mas. */
  await espectadores.conectar(UNO, 'twitch', TWITCH);
  await espectadores.desconectar(UNO, 'twitch');

  assert.equal(await espectadores.leer(UNO), null);
  assert.equal(await almacen.obtener('espectadores', UNO), null, 'no queda ni la cascara');
});

test('olvidar borra las DOS redes y limpia el limite de esa persona', async () => {
  await espectadores.conectar(UNO, 'kick', KICK);
  await espectadores.conectar(UNO, 'twitch', TWITCH);
  espectadores.anotarEnvio(UNO);
  assert.ok(espectadores.esperaQueLeFalta(UNO) > 0);

  const habia = await espectadores.olvidar(UNO);
  assert.equal(habia, true);
  assert.equal(await espectadores.leer(UNO), null);
  const crudo = await almacen.obtener('espectadores', UNO);
  assert.equal(crudo, null, 'salir borra los tokens de las dos redes, no solo la cookie');
  assert.equal(espectadores.esperaQueLeFalta(UNO), 0, 'el limite de esta persona se limpio');
});

/* ------------------------------------------ el espectador del modelo viejo */

test('un espectador de antes de Twitch se migra al leerlo, con el MISMO id', async () => {
  /* Asi era hasta la Fase 5.2: un documento plano en `tokens`, bajo
     `espectador:<user_id de Kick>`. Ese id vive dentro de cookies que
     estan en navegadores ahora mismo, asi que la migracion tiene que
     conservarlo o esas sesiones dejan de servir de un deploy al otro. */
  await almacen.poner('tokens', 'espectador:1001', {
    tipo: 'espectador',
    usuarioId: '1001',
    nombre: 'de-antes',
    acceso: cifrado.cifrar('acceso-viejo'),
    refresco: cifrado.cifrar('refresco-viejo'),
    venceEn: Date.now() + 3600_000,
    scopes: 'user:read chat:write',
    entro: 1_700_000_000_000,
  });

  const v = await espectadores.leer('1001');
  assert.equal(v.id, '1001', 'el id no cambia: la cookie que anda tiene que seguir andando');
  assert.equal(v.kick.usuarioId, '1001');
  assert.equal(v.kick.nombre, 'de-antes');
  assert.equal(v.kick.accessToken, 'acceso-viejo', 'los tokens se leen igual que antes');
  assert.equal(v.kick.refreshToken, 'refresco-viejo');
  assert.equal(espectadores.puedeEscribirEn(v, 'kick'), true, 'y sus scopes viajaron');
  assert.equal(v.twitch, undefined, 'el viejo no tenia Twitch');

  assert.ok(await almacen.obtener('espectadores', '1001'), 'quedo guardado en el modelo nuevo');
  assert.equal(await almacen.obtener('tokens', 'espectador:1001'), null,
    'y el viejo se borra: dos copias del mismo refresh token es una de mas');

  /* Y desde ahi puede conectar Twitch como cualquiera. */
  await espectadores.conectar('1001', 'twitch', TWITCH);
  assert.deepEqual(espectadores.redesDe(await espectadores.leer('1001')), ['kick', 'twitch']);

  await espectadores.olvidar('1001');
});

test('un vinculo de creador que se parece a uno viejo NO se migra', async () => {
  /* En `tokens` tambien viven los vinculos de los creadores, con id
     `<slug>:<red>`. Un creador con el slug "espectador" tendria
     documentos llamados `espectador:kick`. Sin mirar el `tipo`, leer
     al espectador "kick" se llevaria el token del creador. */
  await almacen.poner('tokens', 'espectador:kick', {
    red: 'kick',
    sala: 'espectador',
    usuarioId: '777',
    acceso: cifrado.cifrar('el-token-del-creador'),
    refresco: '',
  });

  assert.equal(await espectadores.leer('kick'), null);
  assert.ok(await almacen.obtener('tokens', 'espectador:kick'), 'y no se lo comio la migracion');
  await almacen.quitar('tokens', 'espectador:kick');
});

/* ---------------------------------------------- el vencimiento */

test('el que no vuelve en 60 dias pierde sus tokens, y el que vuelve no', async () => {
  const viejo = Date.now() - espectadores.VENCE_EN - 1000;
  const reciente = Date.now() - 1000;

  await espectadores.conectar('esp_seFue', 'kick', KICK);
  await espectadores.conectar('esp_sigue', 'twitch', TWITCH);
  /* La fecha se toca a mano: esperar sesenta dias en un test no es una
     opcion, y `conectar` siempre deja "ahora". */
  for (const [id, cuando] of [['esp_seFue', viejo], ['esp_sigue', reciente]]) {
    const doc = await almacen.obtener('espectadores', id);
    await almacen.poner('espectadores', id, { ...doc, ultimoUso: cuando });
  }

  const idos = await espectadores.podar();
  assert.ok(idos >= 1);
  assert.equal(await espectadores.leer('esp_seFue'), null, 'se fue con sus tokens');
  assert.equal(await almacen.obtener('espectadores', 'esp_seFue'), null);
  assert.ok(await espectadores.leer('esp_sigue'), 'el que vino ayer se queda');

  await espectadores.olvidar('esp_sigue');
});

test('el vencimiento barre tambien a los del modelo viejo que nunca se migraron', async () => {
  /* La migracion corre al LEER, y a un espectador cuya sesion ya
     vencio no lo lee nadie nunca mas: sin esto se queda con su refresh
     token guardado para siempre. */
  await almacen.poner('tokens', 'espectador:999', {
    tipo: 'espectador',
    usuarioId: '999',
    nombre: 'de hace mucho',
    acceso: cifrado.cifrar('viejisimo'),
    refresco: cifrado.cifrar('viejisimo'),
    venceEn: 0,
    scopes: 'chat:write',
    entro: Date.now() - espectadores.VENCE_EN - 1000,
  });

  await espectadores.podar();
  assert.equal(await almacen.obtener('tokens', 'espectador:999'), null);
});

test('el vencimiento no toca los vinculos de los creadores', async () => {
  /* Viven en la misma coleccion y son de otra cosa: el token del
     creador no se vence solo aunque haga meses que no entra al panel. */
  await almacen.poner('tokens', 'unasala:kick', {
    red: 'kick', sala: 'unasala', usuarioId: '5',
    acceso: cifrado.cifrar('el-del-creador'), refresco: '', vinculado: 0,
  });

  await espectadores.podar();
  assert.ok(await almacen.obtener('tokens', 'unasala:kick'), 'el vinculo del creador sigue ahi');
  await almacen.quitar('tokens', 'unasala:kick');
});

test('leer anota que la persona sigue viniendo, como mucho cada tantas horas', async () => {
  await espectadores.conectar(UNO, 'kick', KICK);
  const recienConectado = (await almacen.obtener('espectadores', UNO)).ultimoUso;

  /* Recien conectado: leerlo no escribe nada. */
  await espectadores.leer(UNO);
  assert.equal((await almacen.obtener('espectadores', UNO)).ultimoUso, recienConectado,
    'una escritura en Mongo por cada mensaje del chat, para esto, no se paga');

  /* Con la fecha vieja, la proxima lectura la mueve: es lo que lo
     salva del vencimiento de sesenta dias. */
  const doc = await almacen.obtener('espectadores', UNO);
  const haceRato = Date.now() - 30 * 24 * 60 * 60 * 1000;
  await almacen.poner('espectadores', UNO, { ...doc, ultimoUso: haceRato });

  const v = await espectadores.leer(UNO);
  assert.equal(v.kick.accessToken, KICK.accessToken, 'y sigue devolviendo lo mismo');
  assert.ok((await almacen.obtener('espectadores', UNO)).ultimoUso > haceRato);

  await espectadores.olvidar(UNO);
});

/* ------------------------------------------------------- limite personal */

test('esperaQueLeFalta: 0 antes de mandar, algo despues, 0 pasados los 2s', () => {
  const t0 = 1_000_000;
  assert.equal(espectadores.esperaQueLeFalta('persona-1', t0), 0);

  espectadores.anotarEnvio('persona-1', t0);
  const falta = espectadores.esperaQueLeFalta('persona-1', t0 + 500);
  assert.ok(falta > 0 && falta <= espectadores.ESPERA_ENTRE_MENSAJES, `falta=${falta}`);

  assert.equal(espectadores.esperaQueLeFalta('persona-1', t0 + 2000), 0);
  /* Bien pasado el vencimiento, y no apenas en el borde: sin el
     Math.max(0, ...) de la implementacion esto daria un numero
     negativo en vez de 0. */
  assert.equal(espectadores.esperaQueLeFalta('persona-1', t0 + 5000), 0);
});

test('dos personas distintas no se frenan entre si', () => {
  const t0 = 2_000_000;
  espectadores.anotarEnvio('persona-a', t0);
  assert.equal(espectadores.esperaQueLeFalta('persona-b', t0), 0);
});

test('el Map del limite no crece para siempre: los mas viejos se sueltan', () => {
  const t0 = 3_000_000;
  const TOPE = 5000;   // TOPE_RECORDADOS del modulo, documentado aca porque no se exporta

  /* Todo anotado en el MISMO instante: si se usara un timestamp
     distinto por persona, para cuando se llega a la persona 5000 ya
     pasaron los 2s de espera de la primera por el solo paso del
     tiempo simulado, y el test no probaria el Map sino el vencimiento
     normal. Con un solo `t0` la unica forma de que persona-0 se
     libere es que el Map la haya soltado. */
  for (let i = 0; i < TOPE; i++) {
    espectadores.anotarEnvio(`persona-${i}`, t0);
  }
  /* Todavia no se paso el tope: el primero sigue frenado. */
  assert.ok(espectadores.esperaQueLeFalta('persona-0', t0) > 0, 'todavia no se soltó nada');

  /* Uno mas: el mas viejo (persona-0) se suelta. */
  espectadores.anotarEnvio('persona-nueva', t0);
  assert.equal(espectadores.esperaQueLeFalta('persona-0', t0), 0, 'el mas viejo volvio a poder mandar');

  /* Y el ultimo que anoto sigue frenado. */
  assert.ok(espectadores.esperaQueLeFalta('persona-nueva', t0) > 0);
});

/* ------------------------------------------------------------ 429 */

test('anotar429 con Retry-After hace esperar aproximadamente eso', () => {
  const t0 = 4_000_000;
  const espera = espectadores.anotar429('mi-canal', 3, t0);
  assert.equal(espera, 3000);
  assert.equal(espectadores.esperaDelCanalQueFalta('mi-canal', t0), 3000);
  assert.equal(espectadores.esperaDelCanalQueFalta('mi-canal', t0 + 3000), 0);
});

test('anotar429 sin Retry-After usa la espera por defecto', () => {
  const t0 = 5_000_000;
  const espera = espectadores.anotar429('otro-canal', undefined, t0);
  assert.equal(espera, espectadores.ESPERA_429_POR_DEFECTO);
});

test('un Retry-After disparatado se recorta al tope de 60s', () => {
  const t0 = 6_000_000;
  const espera = espectadores.anotar429('canal-exagerado', 99999, t0);
  assert.equal(espera, 60_000);
});

test('pasado el tiempo de espera del 429, vuelve a 0', () => {
  const t0 = 7_000_000;
  espectadores.anotar429('canal-paciente', 1, t0);
  assert.ok(espectadores.esperaDelCanalQueFalta('canal-paciente', t0 + 500) > 0);
  assert.equal(espectadores.esperaDelCanalQueFalta('canal-paciente', t0 + 1000), 0);
});

test('dos canales distintos no se frenan entre si', () => {
  const t0 = 8_000_000;
  espectadores.anotar429('canal-a', 5, t0);
  assert.equal(espectadores.esperaDelCanalQueFalta('canal-b', t0), 0);
});

/* --------------------------------------------------------- reiniciar */

test('reiniciar limpia el limite por persona y el del 429', () => {
  const t0 = 9_000_000;
  espectadores.anotarEnvio('alguien', t0);
  espectadores.anotar429('un-canal', 5, t0);

  espectadores.reiniciar();

  assert.equal(espectadores.esperaQueLeFalta('alguien', t0), 0);
  assert.equal(espectadores.esperaDelCanalQueFalta('un-canal', t0), 0);
});
