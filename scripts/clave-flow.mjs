#!/usr/bin/env node
/**
 * Clave de cifrado de los Flows: comprueba que la clave pública registrada en
 * el número de WhatsApp sea la pareja de la PRIVATE_KEY del bot, y si no, la
 * sube. Es la causa del error "oaep decoding error / Failed to decrypt the
 * request" en /flow: Meta cifra con la clave pública del número que envía el
 * Flow, y el bot descifra con su clave privada; si no son pareja, falla.
 *
 *   node scripts/clave-flow.mjs comprobar                 → compara y dice si coinciden
 *   node scripts/clave-flow.mjs subir                     → registra la pública derivada de PRIVATE_KEY
 *   node scripts/clave-flow.mjs publica                   → imprime la clave pública (para pegarla en Meta)
 *
 * Opciones: --phone <phone_number_id> (por defecto BUSINESS_PHONE)
 *           --token <token de Meta>   (por defecto API_TOKEN)
 * Lee PRIVATE_KEY y PASSPHRASE de .env (o de las variables de Railway).
 */
import crypto from 'node:crypto';
try { await import('dotenv/config'); } catch { /* sin dotenv: se usan las variables de entorno tal cual */ }

const args = process.argv.slice(2);
const cmd = args[0] ?? 'comprobar';
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const phone = opt('phone', process.env.BUSINESS_PHONE || process.env.CRM_PHONE_NUMBER_ID);
const token = opt('token', process.env.API_TOKEN);
const GRAPH = `https://graph.facebook.com/${process.env.GRAPH_VERSION || 'v23.0'}`;

const normalize = (pem = '') => String(pem).replace(/\\n/g, '\n').replace(/\r/g, '').trim();
const fingerprint = (pem) => crypto.createHash('sha256').update(normalize(pem).replace(/\s+/g, '')).digest('hex').slice(0, 16);

function publicFromPrivate() {
  const raw = process.env.PRIVATE_KEY;
  if (!raw) throw new Error('Falta PRIVATE_KEY');
  let privateKey;
  try {
    privateKey = crypto.createPrivateKey({ key: normalize(raw), passphrase: process.env.PASSPHRASE || undefined });
  } catch (err) {
    throw new Error(`No se pudo leer PRIVATE_KEY: ${err.message}. Si el PEM dice "ENCRYPTED PRIVATE KEY", PASSPHRASE tiene que ser la misma con la que se generó.`);
  }
  return crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString();
}

async function graph(method, path, body) {
  const res = await fetch(`${GRAPH}/${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
    body: body ? new URLSearchParams(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Meta ${res.status}: ${data.error?.message ?? JSON.stringify(data)}`);
  return data;
}

try {
  const mine = publicFromPrivate();

  if (cmd === 'publica') {
    console.log(mine);
    process.exit(0);
  }
  if (!phone || !token) throw new Error('Indica --phone y --token (o define BUSINESS_PHONE y API_TOKEN)');

  if (cmd === 'comprobar') {
    const data = await graph('GET', `${phone}/whatsapp_business_encryption`);
    // Meta responde { data: [ { business_public_key, business_public_key_signature_status } ] }
    const entry = Array.isArray(data.data) ? data.data[0] ?? {} : data;
    const remote = entry.business_public_key ?? '';
    console.log(`Número ${phone}`);
    console.log(`  Clave en Meta:   ${remote ? fingerprint(remote) : '(ninguna registrada)'}  estado: ${entry.business_public_key_signature_status ?? '—'}`);
    console.log(`  Clave del bot:   ${fingerprint(mine)}  (derivada de PRIVATE_KEY)`);
    if (remote && fingerprint(remote) === fingerprint(mine)) {
      console.log('\n✔ Coinciden. Si el error sigue, revisa que el Flow lo envíe este mismo número (BUSINESS_PHONE / CRM_PHONE_NUMBER_ID).');
    } else {
      console.log('\n✘ NO coinciden: por eso falla el descifrado. Ejecuta: node scripts/clave-flow.mjs subir');
      process.exitCode = 1;
    }
  } else if (cmd === 'subir') {
    const r = await graph('POST', `${phone}/whatsapp_business_encryption`, { business_public_key: mine });
    console.log(r.success ? `✔ Clave pública registrada en ${phone} (huella ${fingerprint(mine)}).` : JSON.stringify(r));
    const check = await graph('GET', `${phone}/whatsapp_business_encryption`);
    const entry = Array.isArray(check.data) ? check.data[0] ?? {} : check;
    console.log(`  Estado en Meta: ${entry.business_public_key_signature_status ?? '—'}`);
  } else {
    console.log('Uso: clave-flow.mjs comprobar|subir|publica [--phone id] [--token token]');
  }
} catch (err) {
  console.error('Error:', err.message);
  process.exit(1);
}
