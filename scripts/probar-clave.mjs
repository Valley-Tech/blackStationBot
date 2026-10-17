/**
 * Comprueba que la clave privada de los Flows sirve, ANTES de pelear con Meta.
 *
 *   node scripts/probar-clave.mjs private.pem "TuPassphrase"
 *
 * Si todo está bien, imprime la línea exacta que debes pegar en el .env
 * (y en Railway), con los saltos de línea escapados.
 */
import fs from 'node:fs';
import crypto from 'node:crypto';

const [archivo = 'private.pem', passphrase = process.env.PASSPHRASE] = process.argv.slice(2);

if (!fs.existsSync(archivo)) {
  console.error(`❌ No encuentro el archivo ${archivo}`);
  console.error('   Uso: node scripts/probar-clave.mjs private.pem "TuPassphrase"');
  process.exit(1);
}

const pem = fs.readFileSync(archivo, 'utf8');

console.log(`Archivo:    ${archivo}`);
console.log(`Formato:    ${pem.split('\n')[0]}`);
console.log(`Líneas:     ${pem.trim().split('\n').length}`);
console.log(`Passphrase: ${passphrase ? '(recibida)' : '(vacía)'}\n`);

try {
  const key = crypto.createPrivateKey({ key: pem, passphrase });
  console.log(`✅ La clave privada es válida (${key.asymmetricKeyType}, ${key.asymmetricKeyDetails?.modulusLength} bits)\n`);
} catch (error) {
  const codigo = error.code || error.message;
  console.error(`❌ No se pudo leer la clave: ${codigo}\n`);
  if (codigo === 'ERR_OSSL_BAD_DECRYPT') {
    console.error('   La passphrase no es la que usaste al crear la clave.');
  } else if (/DECODER/.test(codigo)) {
    console.error('   El archivo no parece un PEM válido. Vuelve a generarlo:');
    console.error('     openssl genrsa -des3 -out private.pem 2048');
    console.error('     openssl rsa -in private.pem -outform PEM -pubout -out public.pem');
  }
  process.exit(1);
}

// La pública se deriva de la privada: sirve para comparar con la que subiste a Meta.
const publica = crypto.createPublicKey(crypto.createPrivateKey({ key: pem, passphrase }))
  .export({ type: 'spki', format: 'pem' });

console.log('Clave pública que le corresponde (debe ser la que subiste a Meta):\n');
console.log(publica);

console.log('Línea para el .env (cópiala tal cual, con las comillas):\n');
console.log(`PRIVATE_KEY=${JSON.stringify(pem)}`);
console.log(`PASSPHRASE=${passphrase ?? ''}\n`);
console.log('En Railway pega el contenido del PEM con saltos de línea reales (editor multilínea);');
console.log('el CRM acepta las dos formas.');