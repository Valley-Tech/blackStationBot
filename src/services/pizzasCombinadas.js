/**
 * Pizzas combinadas (v3.7): una bandeja con 2 o 3 sabores.
 *
 * Reglas del negocio (Black's Pizza):
 *   · 4 y 6 porciones → 2 sabores, mitad y mitad (2+2 / 3+3).
 *   · 8 porciones     → 2 sabores (4+4) o 3 sabores (4+2+2).
 *   · 12 porciones    → 2 sabores (6+6) o 3 sabores (4+4+4).
 *   · Precio: el del sabor más caro de la combinación (en ese tamaño).
 *   · Loggro: una sola línea con el producto del sabor que fija el precio y la nota
 *     "COMBINADA 8 porciones: 4 Hawaiana + 2 Mexicana + 2 Ranchera".
 *
 * Este archivo no habla con WhatsApp: solo sabe de sabores, tamaños, repartos, precios,
 * cómo leer lo que escribe el cliente ("mitad hawaiana y mitad mexicana de 8") y cómo
 * armar el producto que entra al pedido. La conversación (botones, listas, pasos) está en
 * messageHandler.js (sección "Pizzas combinadas").
 */
import { product_names, precios } from '../data/catalogo.js';
import { normalizar } from './conversacion.js';

export const TAMANOS = [4, 6, 8, 12];

/** Repartos permitidos: tamaño → nº de sabores → porciones por sabor (de mayor a menor). */
export const REPARTOS = {
  4: { 2: [2, 2] },
  6: { 2: [3, 3] },
  8: { 2: [4, 4], 3: [4, 2, 2] },
  12: { 2: [6, 6], 3: [4, 4, 4] },
};
export const maxSabores = (tamano) => Math.max(...Object.keys(REPARTOS[tamano] ?? { 2: 1 }).map(Number));
export const repartoDe = (tamano, n) => REPARTOS[tamano]?.[n] ?? null;

// ---------------------------------------------------------------------------
//  Sabores (salen de data/catalogo.js: "Pizza <sabor> (<n> porciones)")
// ---------------------------------------------------------------------------

/** sabor → { nombre, tamanos: { 4: { id, precio }, … } } */
export const SABORES = (() => {
  const m = new Map();
  for (const [nombre, id] of Object.entries(product_names)) {
    const r = nombre.match(/^Pizza (.+) \((\d+) porciones\)$/);
    if (!r) continue;
    const sabor = r[1];
    const e = m.get(sabor) ?? { nombre: sabor, tamanos: {} };
    e.tamanos[Number(r[2])] = { id, precio: precios[nombre] ?? null, producto: nombre };
    m.set(sabor, e);
  }
  return m;
})();

/** id de producto (variante de pizza) → { sabor, tamano } */
export const PIZZA_POR_ID = (() => {
  const m = new Map();
  for (const e of SABORES.values()) for (const [t, v] of Object.entries(e.tamanos)) m.set(v.id, { sabor: e.nombre, tamano: Number(t) });
  return m;
})();

/** ¿Este producto del carrito es una pizza (sabor + tamaño)? */
export const esPizza = (id) => PIZZA_POR_ID.has(String(id));

// Cómo escribe la gente cada sabor (todo normalizado: sin tildes, minúsculas). El más largo gana.
const ALIAS = {
  'Hawaiana Chicken': ['hawaiana chicken', 'hawaiana de pollo', 'hawaiana con pollo', 'hawaiana pollo', 'hawaiana chiken', 'hawaina chicken', 'chicken'],
  'Hawaiana': ['hawaiana', 'hawaina', 'hawayana', 'hawaiiana', 'awaiana', 'hawai'],
  'Mexicana': ['mexicana', 'mexica', 'mejicana', 'mexicanas'],
  'Ranchera': ['ranchera', 'ranchero'],
  'de Pepperoni': ['pepperoni', 'peperoni', 'pepperonni', 'peperonni', 'de pepperoni'],
  'de Salami': ['salami', 'de salami'],
  'Napolitana': ['napolitana'],
  'Vegetariana': ['vegetariana', 'vegetales', 'veggie'],
  'Marinera': ['marinera', 'de mar', 'mariscos'],
  'Carnívora': ['carnivora', 'carnes', 'de carnes'],
  'La Paisita': ['paisita', 'paisa', 'la paisita'],
  'Caprichosa': ['caprichosa'],
  'Toxi-Queso': ['toxi queso', 'toxiqueso', 'toxi', 'toxi-queso', 'cuatro quesos', '4 quesos'],
  'Jamón y Queso': ['jamon y queso', 'jamon queso', 'jamon con queso', 'jamon'],
  'Queso y Bocadillo': ['queso y bocadillo', 'queso con bocadillo', 'bocadillo', 'bocadillo con queso'],
  'Pollo y Champiñón': ['pollo y champinon', 'pollo con champinones', 'pollo champinon', 'pollo y champinones', 'champinon', 'champinones'],
  'Pollo y Jamón': ['pollo y jamon', 'pollo con jamon', 'pollo jamon'],
  'Pollo y Maíz': ['pollo y maiz', 'pollo con maiz', 'pollo maiz', 'maiz'],
  'Pollo y Tocineta': ['pollo y tocineta', 'pollo con tocineta', 'pollo tocineta', 'tocineta'],
};

// Palabras que, solas, aplican a varios sabores → hay que preguntar cuál.
const AMBIGUAS = {
  pollo: ['Pollo y Jamón', 'Pollo y Maíz', 'Pollo y Champiñón', 'Pollo y Tocineta', 'Hawaiana Chicken'],
  queso: ['Jamón y Queso', 'Queso y Bocadillo', 'Toxi-Queso'],
};

const limpiar = (t) => ` ${normalizar(t).replace(/[^a-z0-9ñ ]/g, ' ').replace(/\s+/g, ' ').trim()} `;

/**
 * Sabores mencionados, en el orden en que aparecen.
 * @returns {{ sabores: string[], ambiguos: string[][] }}
 *   ambiguos: palabras como "pollo" que no se pudieron resolver (lista de candidatos).
 */
export function saboresEnTexto(texto) {
  let t = limpiar(texto);
  const hallados = []; // { pos, sabor }
  // Alias ordenados del más largo al más corto para que "hawaiana chicken" gane a "hawaiana".
  const alias = Object.entries(ALIAS).flatMap(([sabor, as]) => as.map((a) => [a, sabor])).sort((a, b) => b[0].length - a[0].length);
  for (const [a, sabor] of alias) {
    if (!SABORES.has(sabor)) continue;
    let i;
    while ((i = t.indexOf(` ${a} `)) >= 0) {
      if (!hallados.some((h) => h.sabor === sabor)) hallados.push({ pos: i, sabor });
      t = `${t.slice(0, i + 1)}${'·'.repeat(a.length)}${t.slice(i + 1 + a.length)}`; // se tapa para no volver a leerla
    }
  }
  const ambiguos = [];
  for (const [palabra, candidatos] of Object.entries(AMBIGUAS)) {
    if (t.includes(` ${palabra} `)) ambiguos.push(candidatos.filter((c) => SABORES.has(c) && !hallados.some((h) => h.sabor === c)));
  }
  return { sabores: hallados.sort((a, b) => a.pos - b.pos).map((h) => h.sabor), ambiguos: ambiguos.filter((c) => c.length) };
}

/** Tamaño mencionado: "de 8", "8 porciones", "grande", "familiar"… (o null). */
export function tamanoEnTexto(texto) {
  const t = limpiar(texto);
  const m = t.match(/\b(4|6|8|12)\s*(porciones|porcion|pedazos|tajadas|pzs)?\b/) ?? t.match(/\bde\s+(4|6|8|12)\b/);
  if (m && TAMANOS.includes(Number(m[1]))) return Number(m[1]);
  if (/\b(personal|pequena|pequeña|chica)\b/.test(t)) return 4;
  if (/\bmediana\b/.test(t)) return 6;
  if (/\bgrande\b/.test(t)) return 8;
  if (/\b(familiar|gigante)\b/.test(t)) return 12;
  return null;
}

/** ¿El cliente está pidiendo una combinación? ("mitad", "combinada", "2 sabores", "dos sabores"…) */
export const quiereCombinar = (texto) => /\b(mitad|mita|combinad[ao]s?|combinar|combinacion(es)?|(2|dos|3|tres) sabores|de sabores|varios sabores|surtida|mixta de sabores)\b/.test(limpiar(texto));

/** Nº de sabores pedido explícitamente ("3 sabores") o null. */
export function numeroSaboresEnTexto(texto) {
  const m = limpiar(texto).match(/\b(2|dos|3|tres)\s+sabores\b/);
  return m ? ({ 2: 2, dos: 2, 3: 3, tres: 3 })[m[1]] : null;
}

/** Cantidad de pizzas: "2 pizzas", "dos pizzas" (por defecto 1). */
export function cantidadPizzas(texto) {
  const m = limpiar(texto).match(/\b(\d{1,2}|dos|tres|cuatro)\s+pizzas\b/);
  return m ? (({ dos: 2, tres: 3, cuatro: 4 })[m[1]] ?? Number(m[1])) : 1;
}

// Sabores cuyo nombre también está en OTROS platos ("Ranchera": salchipapa y hamburguesa ranchera).
const COMPARTIDOS = new Set([...SABORES.keys()].filter((sabor) => {
  const ws = normalizar(sabor).replace(/^de /, '').split(/\s+/).filter((w) => w.length > 3 && !['pollo', 'queso'].includes(w));
  return Object.keys(product_names).some((n) => !/^Pizza /.test(n) && ws.some((w) => normalizar(n).includes(w)));
}));

/**
 * ¿El texto habla de pizzas aunque no diga "pizza"? "mitad hawaiana y mitad ranchera",
 * "hawaiana y mexicana" → sí. "una ranchera" (puede ser salchipapa) → no.
 */
export function hablaDePizza(texto) {
  const t = limpiar(texto);
  if (/\bpi(z|s|zz)+as?\b/.test(t)) return true;
  const { sabores } = saboresEnTexto(texto);
  if (quiereCombinar(texto) && sabores.length >= 1) return true;
  return sabores.length >= 2 && sabores.some((s) => !COMPARTIDOS.has(s));
}

/** Lee de una vez todo lo que dijo el cliente de la pizza. */
export function leerPedidoPizza(texto) {
  const { sabores, ambiguos } = saboresEnTexto(texto);
  return { tamano: tamanoEnTexto(texto), sabores, ambiguos, combinar: quiereCombinar(texto) || sabores.length >= 2, nSabores: numeroSaboresEnTexto(texto), cantidad: cantidadPizzas(texto) };
}

// ---------------------------------------------------------------------------
//  Precio y producto del pedido
// ---------------------------------------------------------------------------

/** Sabores que no vienen en ese tamaño (p. ej. Toxi-Queso de 12). */
export const sinTamano = (sabores, tamano) => sabores.filter((s) => !SABORES.get(s)?.tamanos[tamano]);

/** Precio de la combinación (el sabor más caro) y cuál sabor lo fija. */
export function precioCombinada(tamano, sabores) {
  let base = null;
  for (const s of sabores) {
    const v = SABORES.get(s)?.tamanos[tamano];
    if (v && (base === null || (v.precio ?? 0) > (base.precio ?? 0))) base = { sabor: s, ...v };
  }
  return base; // { sabor, id, precio, producto } o null
}

export const cop = (n) => `$${Number(n || 0).toLocaleString('es-CO')}`;

/** "4 Hawaiana + 2 Mexicana + 2 Ranchera" */
export const textoReparto = (sabores, reparto, sep = ' + ') => sabores.map((s, i) => `${reparto[i]} ${s}`).join(sep);

/**
 * Producto que entra al pedido (mismo formato que un ítem del carrito de WhatsApp):
 * el ID del sabor que fija el precio, más nombre y nota de la combinación.
 */
export function armarItem({ tamano, sabores, cantidad = 1 }) {
  const n = sabores.length;
  const reparto = repartoDe(tamano, n);
  if (!reparto) return null;
  const base = precioCombinada(tamano, sabores);
  if (!base) return null;
  const detalle = textoReparto(sabores, reparto, ' · ');
  return {
    product_retailer_id: base.id,
    quantity: cantidad,
    item_price: base.precio,
    currency: 'COP',
    combinada: { tamano, sabores: [...sabores], reparto },
    nombre: `Pizza ${tamano} porciones combinada (${detalle})`,
    nota: `COMBINADA ${tamano} porciones: ${textoReparto(sabores, reparto)}`,
  };
}

/** Validación completa antes de armar: devuelve el texto del problema o null si está bien. */
export function validar({ tamano, sabores }) {
  if (!TAMANOS.includes(tamano)) return 'Las pizzas vienen de *4, 6, 8 o 12 porciones*. ¿De cuántas la quieres?';
  const repetidos = sabores.filter((s, i) => sabores.indexOf(s) !== i);
  if (repetidos.length) return `Me diste *${repetidos[0]}* dos veces 🙈. Dime sabores distintos, por favor.`;
  const faltan = sinTamano(sabores, tamano);
  if (faltan.length) return `La pizza *${faltan[0]}* no viene de ${tamano} porciones 😔. Elige otro sabor o cambia el tamaño.`;
  const sinPrecio = sabores.filter((s) => SABORES.get(s)?.tamanos[tamano]?.precio == null);
  if (sinPrecio.length) return `No tengo el precio de la pizza *${sinPrecio[0]}* de ${tamano} porciones 😔. Escribe *asesor* y una persona te la cotiza.`;
  const max = maxSabores(tamano);
  if (sabores.length < 2) return 'Para combinar necesito al menos *2 sabores*.';
  if (sabores.length > max) return `La de *${tamano} porciones* se combina con máximo *${max} sabores* (${Object.values(REPARTOS[tamano]).map((r) => r.join('+')).join(' o ')}). Dime ${max} sabores, por favor.`;
  return null;
}

/** Lista de sabores con su precio en ese tamaño (para que el cliente escriba los que quiere). */
export function textoSabores(tamano) {
  const lineas = [...SABORES.values()]
    .filter((e) => e.tamanos[tamano])
    .sort((a, b) => (a.tamanos[tamano].precio ?? 0) - (b.tamanos[tamano].precio ?? 0) || a.nombre.localeCompare(b.nombre))
    .map((e) => `• ${e.nombre} · ${cop(e.tamanos[tamano].precio)}`);
  return lineas.join('\n');
}

/** Resumen para confirmar: "🍕 Pizza de 8 porciones · 4 Hawaiana + 2 Mexicana + 2 Ranchera · $44.000". */
export function textoResumen(item) {
  const { tamano, sabores, reparto } = item.combinada;
  const base = precioCombinada(tamano, sabores);
  const cant = item.quantity > 1 ? ` x${item.quantity}` : '';
  return `🍕 *Pizza de ${tamano} porciones combinada*${cant}\n${textoReparto(sabores, reparto, '\n')}\n\n*Precio:* ${cop(item.item_price)}${item.quantity > 1 ? ` c/u (${cop(item.item_price * item.quantity)})` : ''}`;
}
