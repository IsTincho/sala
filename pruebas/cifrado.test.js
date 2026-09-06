/* ============================================================
   Pruebas de servidor/cifrado.js.

   CLAVE_CIFRADO se setea ANTES de la primera llamada porque el modulo
   la lee de forma perezosa (recien cuando se usa por primera vez), no
   al importarse. Se genera aca mismo, nunca una clave fija en el repo.
   ============================================================ */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.env.CLAVE_CIFRADO = crypto.randomBytes(32).toString('base64');

const { cifrar, descifrar, firmar, firmaValida, hayClave } =
  await import('../servidor/cifrado.js');

const AQUI = path.dirname(fileURLToPath(import.meta.url));

test('ida y vuelta: descifrar(cifrar(texto)) === texto, con ascii/acentos/emojis', () => {
  for (const texto of ['hola mundo', 'contraseña con ñ y acentos: café, camión', '🎉🔥 emoji test 你好']) {
    assert.equal(descifrar(cifrar(texto)), texto);
  }
});

test('dos cifrados del mismo texto dan blobs distintos (IV aleatorio)', () => {
  const texto = 'el mismo secreto de siempre';
  const a = cifrar(texto);
  const b = cifrar(texto);
  assert.notEqual(a, b);
  // pero los dos descifran al mismo texto original
  assert.equal(descifrar(a), texto);
  assert.equal(descifrar(b), texto);
});

test('un blob adulterado no se descifra: tira en vez de devolver basura', () => {
  const blob = cifrar('texto que no hay que dejar tocar');
  const punto = blob.indexOf('.');
  const cuerpo = blob.slice(punto + 1);

  // cambiamos un caracter del base64url por otro valido y distinto
  const ALFABETO = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const i = 5;
  const original = cuerpo[i];
  const reemplazo = ALFABETO.split('').find(c => c !== original);
  const adulterado = blob.slice(0, punto + 1) + cuerpo.slice(0, i) + reemplazo + cuerpo.slice(i + 1);

  assert.throws(() => descifrar(adulterado));
});

test('un blob con prefijo de version desconocido tira mencionando la version', () => {
  assert.throws(() => descifrar('v9.loquesea'), /version/i);
});

test('un blob demasiado corto tira', () => {
  assert.throws(() => descifrar('v1.abc'));
});

test('firmar es deterministica: dos llamadas iguales dan lo mismo', () => {
  const a = firmar('contexto_test', 'un-id-cualquiera');
  const b = firmar('contexto_test', 'un-id-cualquiera');
  assert.equal(a, b);
});

test('firmaValida da true para una firma buena y false para una mala', () => {
  const firma = firmar('contexto_test', 'un-id-cualquiera');
  assert.equal(firmaValida('contexto_test', 'un-id-cualquiera', firma), true);
  assert.equal(firmaValida('contexto_test', 'un-id-cualquiera', firma + 'x'), false);
  assert.equal(firmaValida('contexto_test', 'un-id-cualquiera', 'firma-inventada'), false);
});

test('la separacion por contexto: una firma de un contexto no vale en otro', () => {
  const firma = firmar('sala_espectador', 'un-id-cualquiera');
  assert.equal(firmaValida('sala_espectador', 'un-id-cualquiera', firma), true);
  assert.equal(firmaValida('sala_dueno', 'un-id-cualquiera', firma), false);
});

test('hayClave() da true con la clave puesta', () => {
  assert.equal(hayClave(), true);
});

test('una CLAVE_CIFRADO de largo incorrecto hace que hayClave() de false y el error hable del largo', () => {
  /* cifrado.js cachea la clave la primera vez que se usa, asi que no se
     puede probar una clave invalida en este mismo proceso sin ensuciar
     los casos de arriba (que ya la cargaron valida). La forma mas simple
     que funciona de verdad es levantar un subproceso de Node aparte,
     con su propio modulo sin cachear nada, y una CLAVE_CIFRADO de 16
     bytes en vez de 32. */
  const clave16 = crypto.randomBytes(16).toString('base64');
  const urlModulo = pathToFileURL(path.join(AQUI, '..', 'servidor', 'cifrado.js')).href;
  const script = `
    process.env.CLAVE_CIFRADO = ${JSON.stringify(clave16)};
    import(${JSON.stringify(urlModulo)}).then(m => {
      const ok = m.hayClave();
      const motivo = m.porQueNoHayClave();
      console.log(JSON.stringify({ ok, motivo }));
    });
  `;
  const salida = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
  });
  const { ok, motivo } = JSON.parse(salida.trim().split('\n').pop());
  assert.equal(ok, false);
  assert.match(motivo, /16/);
});

test('una CLAVE_CIFRADO que no es base64 se rechaza y lo dice', async () => {
  /* Buffer.from(x, 'base64') no tira NUNCA: lo que no entiende lo
     ignora en silencio. Antes esto estaba envuelto en un try/catch, o
     sea que la rama del error era codigo muerto: una clave con un
     caracter de mas se aceptaba como si nada, porque al ignorarlo
     quedaban 32 bytes igual. */
  const conBasura = (() => {
    const buena = crypto.randomBytes(32).toString('base64');
    return `${buena.slice(0, 10)}#${buena.slice(10)}`;   // decodifica a los mismos 32 bytes
  })();

  const antes = process.env.CLAVE_CIFRADO;
  process.env.CLAVE_CIFRADO = conBasura;
  try {
    /* Instancia aparte del modulo: el `?` la separa en el cache. */
    const otro = await import('../servidor/cifrado.js?clave-invalida=1');
    assert.equal(otro.hayClave(), false, 'no se acepta una clave con basura adentro');
    assert.match(otro.porQueNoHayClave(), /base64/);
  } finally {
    process.env.CLAVE_CIFRADO = antes;
  }
});

test('a la clave se le perdonan los espacios de los costados', async () => {
  const antes = process.env.CLAVE_CIFRADO;
  process.env.CLAVE_CIFRADO = `  ${crypto.randomBytes(32).toString('base64')}\n`;
  try {
    const otro = await import('../servidor/cifrado.js?clave-con-espacios=1');
    assert.equal(otro.hayClave(), true, 'un salto de linea al pegar no puede romper todo');
  } finally {
    process.env.CLAVE_CIFRADO = antes;
  }
});
