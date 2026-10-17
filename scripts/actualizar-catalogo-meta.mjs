#!/usr/bin/env node
/**
 * Actualiza el catálogo de Meta SIN tocar fotos ni nada más: solo los campos que
 * trae el archivo (title, item_group_id, size, additional_variant_attribute).
 * Usa la Graph API /{catalog_id}/items_batch con method=UPDATE: Meta cambia
 * únicamente los campos enviados, así las fotos que subiste a mano se conservan.
 *
 *   node scripts/actualizar-catalogo-meta.mjs                       → simulación (no envía nada)
 *   node scripts/actualizar-catalogo-meta.mjs --enviar              → aplica docs/actualizacion-variantes-meta.csv
 *   node scripts/actualizar-catalogo-meta.mjs --crear-faltantes --enviar
 *        → además crea los productos de docs/productos-faltantes-meta.csv (alitas, chicharrón…)
 *
 * Variables (.env o Railway): CATALOG_ID y CATALOG_TOKEN (o API_TOKEN) con permiso
 * catalog_management sobre el catálogo (usuario del sistema del portafolio).
 */
import fs from 'node:fs';
try { await import('dotenv/config'); } catch { /* sin dotenv */ }

const args = process.argv.slice(2);
const ENVIAR = args.includes('--enviar');
const CREAR = args.includes('--crear-faltantes');
const CATALOG_ID = process.env.CATALOG_ID;
const TOKEN = process.env.CATALOG_TOKEN || process.env.API_TOKEN;
const VERSION = process.env.API_VERSION || 'v23.0';
const dir = new URL('../docs/', import.meta.url);

/** CSV con ; o , (UTF-8, con o sin BOM). */
function leerCsv(nombre) {
  const txt = fs.readFileSync(new URL(nombre, dir), 'utf8').replace(/^﻿/, '');
  const lineas = txt.split(/\r?\n/).filter((l) => l.trim());
  const sep = lineas[0].includes(';') ? ';' : ',';
  const partir = (l) => {
    const out = []; let cur = ''; let q = false;
    for (let i = 0; i < l.length; i++) {
      const c = l[i];
      if (q) { if (c === '"' && l[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
      else if (c === '"') q = true; else if (c === sep) { out.push(cur); cur = ''; } else cur += c;
    }
    out.push(cur); return out;
  };
  const cab = partir(lineas[0]);
  return lineas.slice(1).map((l) => Object.fromEntries(partir(l).map((v, i) => [cab[i], v])));
}

const limpio = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== '' && v != null));

const requests = leerCsv('actualizacion-variantes-meta.csv').map((r) => ({ method: 'UPDATE', data: limpio(r) }));
if (CREAR) for (const r of leerCsv('productos-faltantes-meta.csv')) requests.push({ method: 'CREATE', data: limpio(r) });

console.log(`${requests.filter((r) => r.method === 'UPDATE').length} productos a actualizar, ${requests.filter((r) => r.method === 'CREATE').length} a crear.`);
console.log('Ejemplo:', JSON.stringify(requests[0]));

if (!ENVIAR) {
  console.log('\nSimulación: no se envió nada. Agrega --enviar para aplicarlo.');
  process.exit(0);
}
if (!CATALOG_ID || !TOKEN) {
  console.error('✘ Faltan CATALOG_ID y CATALOG_TOKEN/API_TOKEN en el .env');
  process.exit(1);
}

const body = new URLSearchParams({
  item_type: 'PRODUCT_ITEM',
  allow_upsert: 'false', // un UPDATE nunca crea productos nuevos (evita duplicados por un ID mal escrito)
  requests: JSON.stringify(requests),
  access_token: TOKEN,
});
const r = await fetch(`https://graph.facebook.com/${VERSION}/${CATALOG_ID}/items_batch`, { method: 'POST', body }).then((x) => x.json());
if (r.error) { console.error('✘ Meta:', r.error.message); process.exit(1); }
for (const v of r.validation_status ?? []) {
  for (const e of v.errors ?? []) console.error(`✘ ${v.retailer_id}: ${e.message}`);
  for (const w of v.warnings ?? []) console.warn(`⚠ ${v.retailer_id}: ${w.message}`);
}
const handle = r.handles?.[0];
if (!handle) { console.error('✘ Meta no aceptó el lote:', JSON.stringify(r)); process.exit(1); }
console.log('Lote recibido por Meta. Revisando estado…');

for (let i = 0; i < 20; i++) {
  await new Promise((ok) => setTimeout(ok, 3000));
  const s = await fetch(`https://graph.facebook.com/${VERSION}/${CATALOG_ID}/check_batch_request_status?handle=${encodeURIComponent(handle)}&access_token=${TOKEN}`).then((x) => x.json());
  const d = s.data?.[0];
  if (!d) continue;
  if (d.status === 'finished') {
    const errs = d.errors ?? [];
    console.log(`✔ Terminado. Errores: ${errs.length}`);
    for (const e of errs.slice(0, 20)) console.log(`   · ${e.id ?? ''} ${e.message ?? JSON.stringify(e)}`);
    process.exit(errs.length ? 1 : 0);
  }
  console.log(`   estado: ${d.status}`);
}
console.log('Sigue procesando; revisa en el Administrador de ventas en unos minutos.');
