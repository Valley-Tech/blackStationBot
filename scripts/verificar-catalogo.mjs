#!/usr/bin/env node
/**
 * Revisa los catálogos multiproducto antes de desplegar:
 *   node scripts/verificar-catalogo.mjs
 *
 *  · cada catálogo ≤ 30 productos y ≤ 10 secciones, títulos de sección ≤ 24 caracteres;
 *  · todos los nombres existen en product_names y no hay IDs repetidos;
 *  · con CATALOG_ID y API_TOKEN en el .env, consulta el catálogo de Meta y lista los
 *    productos que todavía NO están cargados en el Administrador de ventas (si falta
 *    uno, WhatsApp rechaza el mensaje completo con el error #131009).
 */
try { await import('dotenv/config'); } catch { /* sin dotenv */ }
const { product_names, CATALOGOS } = await import('../src/data/catalogo.js');

let errores = 0;
const ids = Object.values(product_names);
const repetidos = ids.filter((id, i) => ids.indexOf(id) !== i);
if (repetidos.length) { errores++; console.error('✘ IDs repetidos en product_names:', repetidos); }

for (const [key, c] of Object.entries(CATALOGOS)) {
  const total = c.sections.reduce((n, s) => n + s.productos.length, 0);
  const faltan = c.sections.flatMap((s) => s.productos).filter((n) => !product_names[n]);
  const largos = c.sections.filter((s) => s.title.length > 24).map((s) => s.title);
  const ok = total <= 30 && c.sections.length <= 10 && !faltan.length && !largos.length && c.header.length <= 60;
  if (!ok) errores++;
  console.log(`${ok ? '✔' : '✘'} ${key.padEnd(20)} ${String(total).padStart(2)} productos, ${c.sections.length} secciones${faltan.length ? ` · sin ID: ${faltan.join(', ')}` : ''}${largos.length ? ` · títulos largos: ${largos.join(', ')}` : ''}`);
}
console.log(`\n${Object.keys(product_names).length} productos en product_names.`);

const { CATALOG_ID, API_TOKEN } = process.env;
if (CATALOG_ID && API_TOKEN) {
  const version = process.env.API_VERSION || 'v23.0';
  const enMeta = new Set();
  let url = `https://graph.facebook.com/${version}/${CATALOG_ID}/products?fields=retailer_id&limit=500&access_token=${API_TOKEN}`;
  while (url) {
    const r = await fetch(url).then((x) => x.json());
    if (r.error) { console.error('✘ Meta:', r.error.message); errores++; break; }
    for (const p of r.data ?? []) enMeta.add(p.retailer_id);
    url = r.paging?.next ?? null;
  }
  const usados = new Set(Object.values(CATALOGOS).flatMap((c) => c.sections.flatMap((s) => s.productos)));
  const faltan = [...usados].filter((n) => !enMeta.has(product_names[n]));
  console.log(`\nCatálogo de Meta ${CATALOG_ID}: ${enMeta.size} productos.`);
  if (faltan.length) {
    errores++;
    console.log(`✘ Faltan ${faltan.length} productos en el Administrador de ventas (súbelos con docs/catalogo-meta-la-estacion.csv):`);
    for (const n of faltan) console.log(`   · ${n} → ${product_names[n]}`);
  } else console.log('✔ Todos los productos de los catálogos están en Meta.');
} else {
  console.log('(Para comparar con el catálogo de Meta, define CATALOG_ID y API_TOKEN en el .env.)');
}
process.exit(errores ? 1 : 0);
