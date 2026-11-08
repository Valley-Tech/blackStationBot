/**
 * Fotos del catálogo de Meta (v3.5.3).
 *
 * WhatsApp solo muestra (y el carrusel solo acepta) productos con FOTO VÁLIDA en el
 * Administrador de ventas de Meta. Un producto sin foto —o con la imagen genérica
 * .webp— no aparece en el catálogo y hace que Meta rechace el carrusel (#131009).
 *
 * La fuente es el mismo CSV que subes a Meta: docs/catalogo-meta-la-estacion.csv
 * (columna image_link). Una foto es válida si:
 *   1. termina en .jpeg, .jpg o .png (Meta no muestra .webp);
 *   2. no es la imagen genérica (69d9062e681205cd21e4.webp);
 *   3. la imagen existe en internet (el bot lo revisa con una petición HEAD; útil
 *      cuando pones el enlace <id>.jpeg antes de subir la foto a Loggro).
 * Se revisa al arrancar y cada 6 h; si no hay internet, se confía en 1 y 2.
 *
 * Cuando agregues fotos: actualiza el CSV en Meta, copia ese mismo CSV a
 * docs/catalogo-meta-la-estacion.csv, haz commit y despliega.
 */
import { readFileSync, existsSync } from 'node:fs';
import axios from 'axios';
import config from '../config/env.js';

export const GENERICA = '69d9062e681205cd21e4';
const RUTA = process.env.CATALOGO_META_CSV || new URL('../../docs/catalogo-meta-la-estacion.csv', import.meta.url);
const CADA_MS = 6 * 3600 * 1000;

/** ¿El enlace tiene formato de foto que Meta muestra? */
export const enlaceValido = (u) => /^https?:\/\/\S+\.(jpe?g|png)(\?\S*)?$/i.test(String(u ?? '').trim()) && !String(u).includes(GENERICA);

/** Lector de CSV con ";" y comillas (como lo guarda Excel). */
export function leerCsv(texto) {
  const lineas = [];
  let campo = '', fila = [], comillas = false;
  const t = String(texto ?? '').replace(/^﻿/, '');
  for (let i = 0; i < t.length; i += 1) {
    const c = t[i];
    if (comillas) {
      if (c === '"' && t[i + 1] === '"') { campo += '"'; i += 1; } else if (c === '"') comillas = false; else campo += c;
    } else if (c === '"') comillas = true;
    else if (c === ';') { fila.push(campo); campo = ''; }
    else if (c === '\n') { fila.push(campo.replace(/\r$/, '')); lineas.push(fila); fila = []; campo = ''; }
    else campo += c;
  }
  if (campo || fila.length) { fila.push(campo.replace(/\r$/, '')); lineas.push(fila); }
  const utiles = lineas.filter((l) => l.some((x) => x.trim()));
  if (!utiles.length) return { cab: [], filas: [] };
  const cab = utiles[0].map((k) => k.trim());
  return { cab, filas: utiles.slice(1).map((l) => Object.fromEntries(cab.map((k, i) => [k, (l[i] ?? '').trim()]))) };
}

// id del producto → image_link (del CSV de Meta)
let fotoPorId = new Map();
let cargado = false;
function cargar() {
  try {
    if (!existsSync(RUTA)) { console.warn('[fotos] no existe docs/catalogo-meta-la-estacion.csv: no se puede saber qué productos tienen foto (se envían todos)'); return; }
    const { filas } = leerCsv(readFileSync(RUTA, 'utf8'));
    fotoPorId = new Map(filas.filter((f) => f.id).map((f) => [f.id, f.image_link]));
    cargado = fotoPorId.size > 0;
    const con = [...fotoPorId.values()].filter(enlaceValido).length;
    console.log(`[fotos] catálogo de Meta: ${con} productos con foto · ${fotoPorId.size - con} sin foto válida (no salen en carrusel ni tarjeta)`);
  } catch (error) {
    console.warn('[fotos] no se pudo leer el CSV del catálogo:', error.message);
  }
}
cargar();

// Resultado de la revisión en internet: url → { ok, at }
const revisadas = new Map();

async function revisar(url) {
  const previa = revisadas.get(url);
  if (previa && Date.now() - previa.at < CADA_MS) return previa.ok;
  let ok = true; // sin internet o error raro: se confía en el formato del enlace
  try {
    const r = await axios.head(url, { timeout: 5000, validateStatus: () => true, maxRedirects: 3 });
    if (r.status === 404 || r.status === 403 || r.status === 410) ok = false;
    else if (r.status >= 200 && r.status < 300) ok = /^image\//i.test(String(r.headers['content-type'] ?? 'image/'));
  } catch { /* se mantiene ok = true */ }
  revisadas.set(url, { ok, at: Date.now() });
  return ok;
}

const activo = () => config.SOLO_CON_FOTO && cargado;

/**
 * ¿El producto tiene foto válida en el catálogo de Meta?
 * (Si el filtro está apagado con SOLO_CON_FOTO=false o no hay CSV, todos cuentan como con foto.)
 */
export function tieneFoto(id) {
  if (!activo()) return true;
  const url = fotoPorId.get(String(id));
  if (!enlaceValido(url)) return false;
  return revisadas.get(url)?.ok !== false;
}

/** Revisa en internet (si hace falta) las fotos de estos productos antes de armar las tarjetas. */
export async function asegurarFotos(ids) {
  if (!activo() || !config.VERIFICAR_FOTOS) return;
  const urls = [...new Set(ids.map((id) => fotoPorId.get(String(id))).filter(enlaceValido))];
  await Promise.all(urls.map((u) => Promise.race([revisar(u), new Promise((r) => setTimeout(r, 3000))])));
}

/** Revisión de todo el catálogo: al arrancar y cada 6 h (no bloquea al bot). */
export function iniciarRevisionFotos() {
  if (!activo() || !config.VERIFICAR_FOTOS) return;
  const correr = async () => {
    const urls = [...new Set([...fotoPorId.values()].filter(enlaceValido))];
    for (let i = 0; i < urls.length; i += 8) await Promise.all(urls.slice(i, i + 8).map(revisar));
    const malas = urls.filter((u) => revisadas.get(u)?.ok === false);
    console.log(`[fotos] revisión en línea: ${urls.length - malas.length} fotos existen${malas.length ? ` · ${malas.length} no se encontraron (esos productos no salen en el carrusel): ${malas.map((u) => u.split('/').pop()).join(', ')}` : ''}`);
  };
  correr().catch((e) => console.warn('[fotos] revisión en línea falló:', e.message));
  setInterval(() => correr().catch(() => {}), CADA_MS).unref();
}
