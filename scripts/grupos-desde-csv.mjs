/**
 * Actualiza los grupos de variantes del bot a partir del CSV del catálogo de Meta.
 *
 *   npm run grupos                                   # usa docs/catalogo-meta-la-estacion.csv
 *   npm run grupos -- ruta/al/catalogo.csv
 *
 * Lee las columnas id, title, item_group_id y size (separador ; o , — con o sin BOM)
 * y reescribe en src/data/catalogo.js el bloque entre los marcadores
 * "// <grupos-variantes>" y "// </grupos-variantes>":
 *   grupoPorId     ID de la variante → item_group_id
 *   tituloGrupo    item_group_id → título del grupo en Meta (p. ej. "Jugo Natural")
 *   variantePorId  ID de la variante → valor de la variante (p. ej. "Maracuyá", "8 porciones")
 *
 * Con VARIANTES_META activo, cada catálogo del bot muestra UNA tarjeta por grupo y el
 * cliente elige el sabor o el tamaño dentro del producto. Corre este script cada vez
 * que cambies los grupos en el CSV y súbelo a Meta.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const archivo = path.resolve(process.argv[2] || path.join(raiz, 'docs/catalogo-meta-la-estacion.csv'));
const destino = path.join(raiz, 'src/data/catalogo.js');

function leerCsv(texto) {
  texto = texto.replace(/^﻿/, '');
  const primera = texto.split(/\r?\n/, 1)[0];
  const sep = (primera.match(/;/g) || []).length > (primera.match(/,/g) || []).length ? ';' : ',';
  const filas = [];
  let fila = [], celda = '', comillas = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (comillas) {
      if (c === '"' && texto[i + 1] === '"') { celda += '"'; i++; }
      else if (c === '"') comillas = false;
      else celda += c;
    } else if (c === '"') comillas = true;
    else if (c === sep) { fila.push(celda); celda = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && texto[i + 1] === '\n') i++;
      fila.push(celda); celda = '';
      if (fila.some((x) => x !== '')) filas.push(fila);
      fila = [];
    } else celda += c;
  }
  if (celda || fila.length) { fila.push(celda); if (fila.some((x) => x !== '')) filas.push(fila); }
  const [cab, ...resto] = filas;
  return resto.map((f) => Object.fromEntries(cab.map((k, i) => [k.trim(), (f[i] ?? '').trim()])));
}

const filas = leerCsv(fs.readFileSync(archivo, 'utf8'));
const conGrupo = filas.filter((f) => f.item_group_id);
if (!conGrupo.length) {
  console.error(`❌ ${archivo} no tiene la columna item_group_id con valores.`);
  process.exit(1);
}

const grupoPorId = {}, tituloGrupo = {}, variantePorId = {};
const errores = [];
const porGrupo = new Map();
for (const f of conGrupo) {
  grupoPorId[f.id] = f.item_group_id;
  variantePorId[f.id] = f.size || (f.additional_variant_attribute || '').split(':').slice(1).join(':') || '';
  if (!porGrupo.has(f.item_group_id)) porGrupo.set(f.item_group_id, []);
  porGrupo.get(f.item_group_id).push(f);
}
for (const [g, miembros] of porGrupo) {
  const titulos = [...new Set(miembros.map((m) => m.title))];
  if (titulos.length > 1) errores.push(`El grupo ${g} tiene títulos distintos: ${titulos.join(' | ')} (Meta pide el mismo título en todas las variantes)`);
  tituloGrupo[g] = titulos[0];
  if (miembros.length < 2) errores.push(`El grupo ${g} (${titulos[0]}) tiene una sola variante`);
}

// El bot conoce cada producto por su ID de Loggro: avisa si el CSV trae IDs que el bot no tiene.
const { nombrePorId } = await import(path.join(raiz, 'src/data/catalogo.js'));
const desconocidos = conGrupo.filter((f) => !nombrePorId[f.id]).map((f) => `${f.id} (${f.title})`);
if (desconocidos.length) errores.push(`IDs del CSV que el bot no tiene en product_names: ${desconocidos.join(', ')}`);

const js = (o, comentario) => '{\n' + Object.entries(o)
  .map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},${comentario ? ` // ${comentario(k)}` : ''}`)
  .join('\n') + '\n}';

const bloque = `// <grupos-variantes> (generado por scripts/grupos-desde-csv.mjs a partir de ${path.basename(archivo)}; no editar a mano)
/** ID de la variante → item_group_id del catálogo de Meta. */
export const grupoPorId = ${js(grupoPorId, (k) => nombrePorId[k] ?? '')};

/** item_group_id → título del grupo en Meta. */
export const tituloGrupo = ${js(tituloGrupo)};

/** ID de la variante → valor que elige el cliente dentro del producto (campo size de Meta). */
export const variantePorId = ${js(variantePorId)};
// </grupos-variantes>`;

let codigo = fs.readFileSync(destino, 'utf8');
const marcas = /\/\/ <grupos-variantes>[\s\S]*?\/\/ <\/grupos-variantes>/;
if (!marcas.test(codigo)) {
  console.error('❌ No encuentro los marcadores // <grupos-variantes> en src/data/catalogo.js');
  process.exit(1);
}
codigo = codigo.replace(marcas, bloque);
fs.writeFileSync(destino, codigo);

console.log(`✅ ${porGrupo.size} grupos y ${conGrupo.length} variantes escritos en src/data/catalogo.js`);
for (const [g, miembros] of porGrupo) console.log(`   ${tituloGrupo[g].padEnd(24)} ${miembros.length} · ${miembros.map((m) => variantePorId[m.id]).join(', ')}`);
if (errores.length) {
  console.warn('\n⚠️ Revisa:');
  for (const e of errores) console.warn('   - ' + e);
}
