import dotenv from 'dotenv';
import crypto from 'node:crypto';

dotenv.config();

/**
 * Normaliza una clave PEM leída de una variable de entorno.
 *
 * Al pegar la clave en el .env o en Railway se suelen perder los saltos de
 * línea (quedan como "\n" literales) o se cuelan las comillas. OpenSSL 3
 * entonces responde `DECODER routines::unsupported`, que no dice nada útil.
 * Aquí se arregla antes de usarla, igual que ya se hace con la clave de Google.
 */
function normalizarPem(valor) {
  let pem = String(valor ?? '').trim();
  if ((pem.startsWith('"') && pem.endsWith('"')) || (pem.startsWith("'") && pem.endsWith("'"))) {
    pem = pem.slice(1, -1);
  }
  pem = pem.replace(/\\r/g, '').replace(/\\n/g, '\n').replace(/\r/g, '');
  return pem ? `${pem.trim()}\n` : '';
}

const PRIVATE_KEY = normalizarPem(process.env.PRIVATE_KEY);

// Aviso al arrancar: mejor enterarse aquí que cuando Meta llame al endpoint.
if (PRIVATE_KEY) {
  try {
    crypto.createPrivateKey({ key: PRIVATE_KEY, passphrase: process.env.PASSPHRASE });
    console.log('[flows] clave privada cargada correctamente ✅');
  } catch (error) {
    const codigo = error.code || error.message;
    console.error(`[flows] ❌ no se pudo leer la clave privada: ${codigo}`);
    if (codigo === 'ERR_OSSL_BAD_DECRYPT') {
      console.error('        La PASSPHRASE no coincide con la que usaste al crear private.pem.');
    } else {
      console.error('        Revisa PRIVATE_KEY: debe empezar por "-----BEGIN" y conservar los saltos de línea.');
    }
  }
} else {
  console.warn('[flows] PRIVATE_KEY vacío: el endpoint /flow no podrá descifrar.');
}

export default {
  WEBHOOK_VERIFY_TOKEN: process.env.WEBHOOK_VERIFY_TOKEN,
  API_TOKEN: process.env.API_TOKEN,
  BUSINESS_PHONE: process.env.BUSINESS_PHONE,
  API_VERSION: process.env.API_VERSION,
  PORT: process.env.PORT || 3000,
  BASE_URL: process.env.BASE_URL,
  HUGGINGFACE_API_KEY: process.env.HUGGINGFACE_API_KEY,
  NEBIUS_API_KEY: process.env.NEBIUS_API_KEY,
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  // PRIVATE_KEY: process.env.PRIVATE_KEY,
  PRIVATE_KEY,
  APP_SECRET: process.env.APP_SECRET,
  PASSPHRASE: process.env.PASSPHRASE,
  URL_BASE_WOMPI: process.env.URL_BASE_WOMPI,
  WOMPI_PUBLIC_KEY: process.env.WOMPI_PUBLIC_KEY,
  WOMPI_PRIVATE_KEY: process.env.WOMPI_PRIVATE_KEY,
  NODE_TLS_REJECT_UNAUTHORIZED : process.env.NODE_TLS_REJECT_UNAUTHORIZED,
  LOGGRO_API_KEY : process.env.LOGGRO_API_KEY,
  SPREADSHEETID_PEDIDO: process.env.SPREADSHEETID_PEDIDO,
  SPREADSHEETID_RESERVA: process.env.SPREADSHEETID_RESERVA,
  SPREADSHEETID_SURVEY: process.env.SPREADSHEETID_SURVEY,
  AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
  AWS_REGION: process.env.AWS_REGION,
  AWS_BUCKET_NAME: process.env.AWS_BUCKET_NAME,

  // ---- BlackStationBot (La Estación) ---------------------------------------
  CATALOG_ID: process.env.CATALOG_ID,                         // catálogo del Administrador de ventas de Meta
  CATALOG_TEMPLATE: process.env.CATALOG_TEMPLATE,             // plantilla con botón CATALOG (opcional)
  CATALOG_TEMPLATE_LANG: process.env.CATALOG_TEMPLATE_LANG || 'es_CO',
  FLOW_ID_PEDIDO: process.env.FLOW_ID_PEDIDO,
  FLOW_ID_RESERVA: process.env.FLOW_ID_RESERVA,
  FLOW_ID_ENCUESTA: process.env.FLOW_ID_ENCUESTA,
  NOTIFY_NUMBERS: (process.env.NOTIFY_NUMBERS || '').split(',').map((n) => n.replace(/\D/g, '')).filter(Boolean),
  DOMICILIO_VALOR: Number(process.env.DOMICILIO_VALOR ?? 3000),
  HORA_APERTURA: process.env.HORA_APERTURA || '12:00',
  HORA_CIERRE: process.env.HORA_CIERRE || '23:00',
  LOGGRO_TABLE_ID: process.env.LOGGRO_TABLE_ID,               // mesa "Domicilios/WhatsApp" en Loggro
  LOGGRO_LOCATION_STOCK: process.env.LOGGRO_LOCATION_STOCK || '68f9ad7234a2d185b5e0bf68', // bodega General
  LOGGRO_DOMICILIO_PRODUCT_ID: process.env.LOGGRO_DOMICILIO_PRODUCT_ID, // producto "Domicilio" en Loggro (opcional)
};
