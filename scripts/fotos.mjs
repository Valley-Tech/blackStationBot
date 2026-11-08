/**
 * Reporte de fotos del catálogo de Meta (v3.5.3) — npm run fotos
 *
 * El bot solo pone en el carrusel y en la tarjeta de producto los platos con foto
 * válida en docs/catalogo-meta-la-estacion.csv (el mismo CSV que subes a Meta):
 * .jpeg/.jpg/.png que exista en internet y que no sea la genérica (69d9062e681205cd21e4.webp).
 *
 *   npm run fotos
 *       Lista qué productos tienen foto y cuáles no, y revisa en línea que cada foto exista.
 *   npm run fotos -- ruta/productos-loggro.json
 *       Además toma las fotos nuevas de Loggro (urlImage .jpeg/.png del producto o de su padre)
 *       para los productos que hoy no tienen foto: actualiza docs/catalogo-meta-la-estacion.csv
 *       y escribe docs/actualizacion-fotos-meta.csv (id;image_link) para subirlo a Meta.
 *       (El JSON de Loggro trae costos internos: no lo subas al repositorio.)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import axios from 'axios';
import { leerCsv, enlaceValido } from '../src/services/fotosCatalogo.js';

const CSV = new URL('../docs/catalogo-meta-la-estacion.csv', import.meta.url);
const ACTUALIZACION = new URL('../docs/actualizacion-fotos-meta.csv', import.meta.url);
const celda = (v) => (/[;"\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
const escribirCsv = (url, cab, filas) => writeFileSync(url, '﻿' + [cab, ...filas.map((f) => cab.map((k) => f[k] ?? ''))].map((l) => l.map(celda).join(';')).join('\r\n') + '\r\n');
const nombre = (f) => `${f.title}${f.size ? ` ${f.size}` : ''}${f.additional_variant_attribute ? ` ${f.additional_variant_attribute.split(':').pop()}` : ''}`;

const { cab, filas } = leerCsv(readFileSync(CSV, 'utf8'));

// --- Fotos nuevas desde Loggro (opcional) ---
const rutaJson = process.argv[2];
const cambios = [];
if (rutaJson) {
  const productos = JSON.parse(readFileSync(rutaJson, 'utf8'));
  const foto = new Map(); const padre = new Map();
  for (const p of productos) {
    if (p.urlImage) foto.set(p._id, p.urlImage);
    for (const s of p.subProducts ?? []) { padre.set(s._id, p._id); if (s.urlImage) foto.set(s._id, s.urlImage); }
  }
  for (const f of filas) {
    if (enlaceValido(f.image_link)) continue; // ya tiene foto: no se toca
    const nueva = [foto.get(f.id), foto.get(padre.get(f.id))].find(enlaceValido);
    if (nueva) { cambios.push({ id: f.id, image_link: nueva, nombre: nombre(f) }); f.image_link = nueva; }
  }
  if (cambios.length) { escribirCsv(CSV, cab, filas); escribirCsv(ACTUALIZACION, ['id', 'image_link'], cambios); }
}

// --- Revisión en línea ---
const urls = [...new Set(filas.map((f) => f.image_link).filter(enlaceValido))];
const existe = new Map();
for (let i = 0; i < urls.length; i += 8) {
  await Promise.all(urls.slice(i, i + 8).map(async (u) => {
    try { const r = await axios.head(u, { timeout: 8000, validateStatus: () => true }); existe.set(u, r.status >= 200 && r.status < 300); } catch { existe.set(u, null); }
  }));
}
const con = filas.filter((f) => enlaceValido(f.image_link) && existe.get(f.image_link) !== false);
const rotas = filas.filter((f) => enlaceValido(f.image_link) && existe.get(f.image_link) === false);
const sin = filas.filter((f) => !enlaceValido(f.image_link));

console.log(`\n✔ ${con.length} productos con foto · ${sin.length} sin foto · ${rotas.length} con enlace que no existe`);
if (cambios.length) console.log(`\n✔ ${cambios.length} fotos nuevas desde Loggro → súbelas a Meta con docs/actualizacion-fotos-meta.csv:\n` + cambios.map((c) => `   · ${c.nombre}`).join('\n'));
else if (rutaJson) console.log('\n· Loggro no trae fotos nuevas (.jpeg/.png) para los productos sin foto.');
if (rotas.length) console.log('\nEnlace .jpeg/.png que NO existe (sube la foto a Loggro o corrige el enlace):\n' + rotas.map((f) => `   · ${nombre(f)} → ${f.image_link}`).join('\n'));
if (sin.length) console.log('\nSin foto (no salen en el carrusel hasta tener foto .jpeg/.png en Meta):\n' + sin.map((f) => `   · ${nombre(f)} (${f.id})`).join('\n'));
if (!urls.some((u) => existe.get(u) !== null)) console.log('\n(Sin internet: no se pudo revisar en línea.)');
console.log('\nRecuerda: este CSV debe ser el mismo que subes a Meta. Después: commit y despliega.');
