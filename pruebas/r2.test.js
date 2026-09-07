/* ============================================================
   Las URL prefirmadas de R2.

   ---------------------------------------------------------------
   DE DONDE SALEN LOS TRES VECTORES DE ORO

   SigV4 es de esas cosas que "andan" hasta que un nombre de archivo
   tiene un parentesis. Probar la firma contra si misma no prueba nada:
   una implementacion mal escrita se verifica perfecto contra su propio
   error. Hacia falta un valor de AFUERA.

   Los tres `FIRMA_*` de abajo los genero **boto3** (el SDK de AWS que
   ya esta instalado para `herramientas/subir.py`), apuntado al mismo
   endpoint de R2, con `region_name='auto'`, `addressing_style='path'`,
   la misma clave de mentira y el reloj congelado en el mismo
   milisegundo. O sea: la firma que este archivo exige la calculo otra
   implementacion, no la nuestra.

   La doc de AWS que describe la cadena esta en
   docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html;
   ahi esta el algoritmo pero no hay ningun hexadecimal publicado
   contra el que comparar, que es por lo que hizo falta boto3.

   Si algun dia alguien cambia la firma y estos tres se caen, la
   pregunta no es "actualizo el valor" sino "¿por que dejo de coincidir
   con boto3?".

   ---------------------------------------------------------------
   LO QUE ESTO NO PRUEBA

   Que R2 acepte la URL. No hay bucket (tareas 9 y 10 de
   TAREAS-DUENO.md) y no hay credenciales. Lo que esta verificado es
   que la firma es la que produce un SDK de AWS de verdad para el mismo
   pedido; que R2 la valide igual que S3 es lo que hay que mirar el dia
   que exista el bucket.

   Las credenciales de aca son las de ejemplo de la documentacion de
   AWS, publicas desde hace quince años, y no abren nada.
   ============================================================ */

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.R2_ACCOUNT_ID = 'cuentadeprueba';
process.env.R2_BUCKET = 'sala-video';
process.env.R2_ACCESS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE';
process.env.R2_SECRET_ACCESS_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
process.env.R2_URL_PUBLICA = 'https://pub-ejemplo.r2.dev/';

const r2 = await import('../servidor/r2.js');

/* 2026-09-07T12:00:00Z, el mismo instante que se le congelo a boto3. */
const AHORA = 1788782400000;

const FIRMA_PUT =
  'https://cuentadeprueba.r2.cloudflarestorage.com/sala-video/ana/ep1/720p/lista.m3u8' +
  '?X-Amz-Algorithm=AWS4-HMAC-SHA256' +
  '&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20260907%2Fauto%2Fs3%2Faws4_request' +
  '&X-Amz-Date=20260907T120000Z&X-Amz-Expires=600&X-Amz-SignedHeaders=host' +
  '&X-Amz-Signature=99d0e9855c486715189ad0d0615bb56aefa67c0c2c82c0db1916cefda252b0f1';

const FIRMA_PUT_RARO =
  'https://cuentadeprueba.r2.cloudflarestorage.com/sala-video/ana/ep1/un%20archivo%20%28raro%29%2B1~2.m3u8' +
  '?X-Amz-Algorithm=AWS4-HMAC-SHA256' +
  '&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20260907%2Fauto%2Fs3%2Faws4_request' +
  '&X-Amz-Date=20260907T120000Z&X-Amz-Expires=600&X-Amz-SignedHeaders=host' +
  '&X-Amz-Signature=3f8738d43b2e6c52a1a70b0cc31a8dbcd50322ed888db1b0f42a2e6c9a8d14fb';

const FIRMA_DELETE =
  'https://cuentadeprueba.r2.cloudflarestorage.com/sala-video/ana/ep1/maestra.m3u8' +
  '?X-Amz-Algorithm=AWS4-HMAC-SHA256' +
  '&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20260907%2Fauto%2Fs3%2Faws4_request' +
  '&X-Amz-Date=20260907T120000Z&X-Amz-Expires=60&X-Amz-SignedHeaders=host' +
  '&X-Amz-Signature=fa1591b4e71be2ff39b895436592b84203ab771dc6d2446236e47d6852f57444';

/* ------------------------------------------------ los vectores de oro */

test('la URL de un PUT es, byte por byte, la que firma boto3', () => {
  assert.equal(r2.firmar('PUT', 'ana/ep1/720p/lista.m3u8', { segundos: 600, ahora: AHORA }), FIRMA_PUT);
});

test('un nombre de archivo con parentesis, espacios y "+" firma igual que boto3', () => {
  /* ESTE ES EL QUE IMPORTA. `encodeURIComponent` deja pasar sin
     codificar los caracteres ! * ' ( ), asi que una firma hecha con el
     coincide con la nuestra en todos los nombres normales y falla justo
     en "Episodio 1 (final).mkv". El error saldria como un 403 de R2 sin
     explicacion, y solo para algunos archivos. */
  const clave = 'ana/ep1/un archivo (raro)+1~2.m3u8';
  assert.equal(r2.firmar('PUT', clave, { segundos: 600, ahora: AHORA }), FIRMA_PUT_RARO);
});

test('un DELETE firma distinto que un PUT sobre la misma clave', () => {
  assert.equal(r2.firmar('DELETE', 'ana/ep1/maestra.m3u8', { segundos: 60, ahora: AHORA }), FIRMA_DELETE);
  const put = r2.firmar('PUT', 'ana/ep1/maestra.m3u8', { segundos: 60, ahora: AHORA });
  assert.notEqual(put, FIRMA_DELETE, 'el metodo entra en la firma: si no, un PUT firmado borraria');
});

test('la clave de firma derivada es la de la cadena de cuatro HMAC', () => {
  /* La pieza sola, tambien contra boto3. Sirve para saber, cuando algo
     de arriba se caiga, si el problema esta en la derivacion o en el
     pedido canonico. */
  assert.equal(
    r2.derivarClave('wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', '20260907', 'auto', 's3').toString('hex'),
    '84746b0f1b776ad443ed8c24849d32e179235c064a373e1b73fbd2bdb1544246');
});

/* ------------------------------------------------------ codificacion */

test('codificar sigue la regla de AWS y no la de encodeURIComponent', () => {
  /* Los cinco que `encodeURIComponent` deja pasar y AWS no. */
  assert.equal(r2.codificar("!*'()"), '%21%2A%27%28%29');
  /* Los cuatro no reservados, que tienen que quedar como estan. */
  assert.equal(r2.codificar('aZ0-_.~'), 'aZ0-_.~');
  assert.equal(r2.codificar(' '), '%20', 'espacio como %20, nunca como +');
  assert.equal(r2.codificar('/'), '%2F', 'la barra se codifica: los segmentos se parten antes');
  assert.equal(r2.codificar('ñ'), '%C3%B1', 'UTF-8, byte por byte');
  assert.equal(r2.codificar('%'), '%25');
  /* Mayusculas en el hexa: la doc de AWS lo pide con todas las letras.
     El caracter se arma con fromCharCode y no se escribe: un control
     literal adentro de un archivo fuente no sobrevive un copiar y
     pegar, y es justo lo que otras pruebas de este proyecto prohiben. */
  assert.equal(r2.codificar(String.fromCharCode(31)), '%1F');
});

test('las barras de la clave siguen siendo barras en la URL', () => {
  const url = r2.firmar('PUT', 'ana/ep1/720p/lista.m3u8', { ahora: AHORA });
  assert.ok(url.includes('/sala-video/ana/ep1/720p/lista.m3u8?'),
    'si los segmentos se codificaran enteros, R2 crearia un objeto con barras en el nombre');
});

/* --------------------------------------------------- claves y prefijos */

test('una clave que se sale de su lugar no se firma', () => {
  assert.equal(r2.claveValida('ana/ep1/maestra.m3u8'), true);
  assert.equal(r2.claveValida('ana/../beto/x.ts'), false, 'traversal');
  assert.equal(r2.claveValida('/ana/x.ts'), false, 'barra al principio');
  assert.equal(r2.claveValida('ana//x.ts'), false, 'segmento vacio');
  assert.equal(r2.claveValida('ana/.'), false);
  assert.equal(r2.claveValida(''), false);
  /* Barra invertida: en Windows ffmpeg escribe `720p\lista.m3u8` en la
     playlist maestra, y en una URL eso NO separa carpetas. Ya mordio
     una vez, en el script de subida. */
  assert.equal(r2.claveValida('ana/720p' + String.fromCharCode(92) + 'lista.m3u8'), false);
  /* Un control adentro de una clave es una linea de log partida en dos,
     igual que en el titulo de un video. */
  assert.equal(r2.claveValida('ana/x' + String.fromCharCode(10) + 'y.ts'), false);
});

test('esDeLaSala pide la barra: "ana" no puede firmar en "anaconda"', () => {
  /* Sin la barra, el slug `ana` firmaria claves de `anaconda`, que es
     el prefijo de OTRO creador. Es la unica linea que separa los videos
     de una sala de los de otra. */
  assert.equal(r2.esDeLaSala('ana/ep1/x.ts', 'ana'), true);
  assert.equal(r2.esDeLaSala('anaconda/ep1/x.ts', 'ana'), false);
  assert.equal(r2.esDeLaSala('beto/ep1/x.ts', 'ana'), false);
  assert.equal(r2.esDeLaSala('ana/ep1/x.ts', ''), false);
  assert.equal(r2.esDeLaSala('ana', 'ana'), false, 'el prefijo solo no es un archivo');
});

/* ------------------------------------------------------ vencimiento */

test('el vencimiento se recorta a lo que acepta S3 y nunca queda en cero', () => {
  const conVence = s => new URL(r2.firmar('PUT', 'ana/x.ts', { segundos: s, ahora: AHORA }))
    .searchParams.get('X-Amz-Expires');

  assert.equal(conVence(600), '600');
  assert.equal(conVence(0), '1', 'un vencimiento de cero seria una URL nacida muerta');
  assert.equal(conVence(-5), '1');
  assert.equal(conVence(99999999), String(7 * 24 * 60 * 60), 'el tope de S3 son 7 dias');
  assert.equal(conVence('nada'), '1');
});

test('dos firmas del mismo pedido en momentos distintos no son iguales', () => {
  const a = r2.firmar('PUT', 'ana/x.ts', { ahora: AHORA });
  const b = r2.firmar('PUT', 'ana/x.ts', { ahora: AHORA + 3600_000 });
  assert.notEqual(a, b, 'la fecha entra en la firma');
});

/* ------------------------------------------- sin credenciales cargadas */

test('sin credenciales no se firma nada y se dice cual falta', () => {
  const antes = process.env.R2_SECRET_ACCESS_KEY;
  try {
    delete process.env.R2_SECRET_ACCESS_KEY;
    assert.equal(r2.hayCredenciales(), false);
    assert.match(r2.porQueNoHay(), /R2_SECRET_ACCESS_KEY/);
    assert.ok(!r2.porQueNoHay().includes(antes), 'nunca el valor de una variable');
    assert.throws(() => r2.firmar('PUT', 'ana/x.ts'), /no se puede firmar/);
  } finally {
    process.env.R2_SECRET_ACCESS_KEY = antes;
  }
});

test('con todo cargado menos la URL publica, se avisa de esa', () => {
  const antes = process.env.R2_URL_PUBLICA;
  try {
    delete process.env.R2_URL_PUBLICA;
    assert.equal(r2.hayCredenciales(), true, 'firmar se puede igual');
    assert.match(r2.porQueNoHay(), /R2_URL_PUBLICA/,
      'pero sin ella la ficha del video apuntaria a ningun lado');
  } finally {
    process.env.R2_URL_PUBLICA = antes;
  }
});

test('la base publica sale sin barra final, venga como venga', () => {
  assert.equal(r2.urlPublicaBase(), 'https://pub-ejemplo.r2.dev');
});

/* ------------------------------------------------------------ listar

   OJO CON EL `finally`. La primera version de estos tres devolvia la
   promesa desde adentro del `try`, asi que el `finally` restauraba el
   `fetch` de verdad ANTES de que la promesa lo usara: el test salia a
   internet contra un host que no existe y fallaba con un error de TLS.
   Se `await`ea adentro del try, siempre. */

const XML = (contenidos, truncado = false, cursor = '') =>
  `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult>` +
  contenidos.map(([k, s]) => `<Contents><Key>${k}</Key><Size>${s}</Size></Contents>`).join('') +
  `<IsTruncated>${truncado}</IsTruncated>` +
  (cursor ? `<NextContinuationToken>${cursor}</NextContinuationToken>` : '') +
  `</ListBucketResult>`;

test('listarPrefijo suma los bytes y pagina hasta el final', async () => {
  /* Una peli de dos horas en segmentos de 6 s son mas de mil archivos,
     y S3 devuelve como mucho mil por vuelta. Sin paginar, el uso de una
     pelicula larga saldria mal por defecto y el tope de GB dejaria
     pasar el doble. */
  const original = globalThis.fetch;
  const pedidos = [];
  globalThis.fetch = async (url) => {
    pedidos.push(String(url));
    const primera = !String(url).includes('continuation-token');
    return new Response(primera
      ? XML([['ana/ep1/a.ts', 100], ['ana/ep1/b.ts', 250]], true, 'sigue')
      : XML([['ana/ep1/c.ts', 7]]), { status: 200 });
  };
  try {
    const r = await r2.listarPrefijo('ana/');
    assert.equal(r.objetos.length, 3);
    assert.equal(r.bytes, 357);
    assert.equal(pedidos.length, 2, 'tiene que haber pedido la segunda pagina');
    assert.ok(pedidos[0].includes('prefix=ana%2F'));
    assert.ok(pedidos[1].includes('continuation-token=sigue'));
  } finally {
    globalThis.fetch = original;
  }
});

test('una clave con & en el XML se lee desescapada', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(XML([['ana/a&amp;b.ts', 5]]), { status: 200 });
  try {
    const r = await r2.listarPrefijo('ana/');
    assert.equal(r.objetos[0].clave, 'ana/a&b.ts');
  } finally {
    globalThis.fetch = original;
  }
});

test('si R2 contesta un error, no se inventa un uso de cero', async () => {
  /* Si un fallo de R2 se leyera como "no usa nada", el tope de GB
     dejaria subir todo lo que se quiera justo cuando R2 no contesta. */
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('<Error><Code>AccessDenied</Code></Error>', { status: 403 });
  try {
    await assert.rejects(() => r2.listarPrefijo('ana/'), /R2 contesto 403/);
  } finally {
    globalThis.fetch = original;
  }
});
