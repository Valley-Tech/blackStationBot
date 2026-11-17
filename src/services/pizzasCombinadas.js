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
 * v3.8: también lee BORDES ("con borde de queso"), porciones por sabor ("4 de jamón y queso,
 * 2 hawaiana y 2 mexicana", "la de 4 que sea jamón y queso"), "un solo sabor", y arma la pizza
 * de UN sabor pedida por texto y las recomendaciones (carrusel) de sabores que faltan.
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

// ---------------------------------------------------------------------------
//  Bordes (productos aparte: "Borde Queso (8 porciones)")
// ---------------------------------------------------------------------------

/** Tipos de borde del catálogo: ["Queso", "Bocadillo", "Mozzarella"]. */
export const BORDES = [...new Set(Object.keys(product_names).map((n) => n.match(/^Borde (.+) \((\d+) porciones\)$/)?.[1]).filter(Boolean))];
const ALIAS_BORDE = { Queso: ['queso', 'quesito'], Bocadillo: ['bocadillo', 'bocadiyo', 'guayaba'], Mozzarella: ['mozzarella', 'mozarella', 'mozarela', 'mosarela', 'mozzarela', 'muzarela'] };
const RE_BORDE = /\bbordes?\b(?:\s+(?:de|con|relleno|rellenos|del?))*\s*([a-zñ]+)?/;

/**
 * ¿Pidió borde? "con bordes de queso" → { pide: true, tipo: "Queso" }; "con borde" → { pide: true, tipo: null }.
 * "sin borde" → { pide: false }.
 */
export function bordeEnTexto(texto) {
  const t = limpiar(texto);
  if (!/\bbordes?\b/.test(t) || /\bsin bordes?\b/.test(t)) return { pide: false, tipo: null };
  const palabra = t.match(RE_BORDE)?.[1] ?? '';
  const tipo = BORDES.find((b) => (ALIAS_BORDE[b] ?? [normalizar(b)]).includes(palabra)) ?? null;
  return { pide: true, tipo };
}
/** El texto sin la parte del borde, para que "queso" o "bocadillo" no cuenten como sabor de pizza. */
const sinBorde = (t) => t.replace(/\b(sin |con )?bordes?\b(?:\s+(?:de|con|relleno|rellenos|del?))*\s*(queso|quesito|bocadillo|bocadiyo|guayaba|mozzarella|mozarella|mozarela|mosarela|mozzarela|muzarela)?/g, ' · ');

/** Producto del borde para ese tamaño (o null). */
export function bordeItem(tipo, tamano, cantidad = 1) {
  const nombre = `Borde ${tipo} (${tamano} porciones)`;
  const id = product_names[nombre];
  if (!id) return null;
  return { product_retailer_id: id, quantity: cantidad, item_price: precios[nombre] ?? 0, currency: 'COP', comboPreguntado: true };
}
export const precioBorde = (tipo, tamano) => precios[`Borde ${tipo} (${tamano} porciones)`] ?? null;

// ---------------------------------------------------------------------------
//  Lectura del texto del cliente
// ---------------------------------------------------------------------------

/** Sabores con su posición en el texto (ya sin la parte del borde). */
function hallarSabores(texto) {
  let t = sinBorde(limpiar(texto));
  const hallados = []; // { pos, fin, sabor }
  // Alias ordenados del más largo al más corto para que "hawaiana chicken" gane a "hawaiana".
  const alias = Object.entries(ALIAS).flatMap(([sabor, as]) => as.map((a) => [a, sabor])).sort((a, b) => b[0].length - a[0].length);
  for (const [a, sabor] of alias) {
    if (!SABORES.has(sabor)) continue;
    let i;
    while ((i = t.indexOf(` ${a} `)) >= 0) {
      if (!hallados.some((h) => h.sabor === sabor)) hallados.push({ pos: i + 1, fin: i + 1 + a.length, sabor });
      t = `${t.slice(0, i + 1)}${'·'.repeat(a.length)}${t.slice(i + 1 + a.length)}`; // se tapa para no volver a leerla
    }
  }
  hallados.sort((a, b) => a.pos - b.pos);
  return { t, hallados };
}

/**
 * Sabores mencionados, en el orden en que aparecen.
 * @returns {{ sabores: string[], ambiguos: string[][] }}
 *   ambiguos: palabras como "pollo" que no se pudieron resolver (lista de candidatos).
 */
export function saboresEnTexto(texto) {
  const { t, hallados } = hallarSabores(texto);
  const ambiguos = [];
  for (const [palabra, candidatos] of Object.entries(AMBIGUAS)) {
    if (t.includes(` ${palabra} `)) ambiguos.push(candidatos.filter((c) => SABORES.has(c) && !hallados.some((h) => h.sabor === c)));
  }
  return { sabores: hallados.map((h) => h.sabor), ambiguos: ambiguos.filter((c) => c.length) };
}

const NUM = { un: 1, una: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, seis: 6, ocho: 8, doce: 12 };
const aNumero = (w) => NUM[w] ?? (/^\d{1,2}$/.test(w) ? Number(w) : null);

/**
 * Porciones que el cliente le asignó a cada sabor: el número (o "mitad") escrito justo antes del sabor.
 *   "4 de jamón y queso, 2 hawaiana y 2 mexicana" → { Jamón y Queso: 4, Hawaiana: 2, Mexicana: 2 }
 *   "la de 4 quiero que sea de jamón y queso"     → { Jamón y Queso: 4 }
 *   "mitad hawaiana y mitad mexicana"             → { Hawaiana: 'mitad', Mexicana: 'mitad' }
 * Un número seguido de "sabores" (2 o 3) es la cantidad de sabores, no porciones.
 */
export function asignacionesEnTexto(texto) {
  const { t, hallados } = hallarSabores(texto);
  const res = {};
  let desde = 0;
  for (const h of hallados) {
    const tramo = t.slice(desde, h.pos);
    desde = h.fin;
    const tokens = [...tramo.matchAll(/\b(mitad|mita|media|\d{1,2}|dos|tres|cuatro|seis)\b(\s+(sabores|sabor|solo|sola|pizzas?))?/g)];
    const ult = tokens.at(-1);
    if (!ult) continue;
    if (ult[3] && /^(pizzas?|sabor|solo|sola)$/.test(ult[3])) continue;     // "2 pizzas hawaiana", "1 solo sabor hawaiana"
    if (/^(mitad|mita|media)$/.test(ult[1])) { res[h.sabor] = 'mitad'; continue; }
    const n = aNumero(ult[1]);
    if (ult[3] === 'sabores' && n <= 3) continue;                            // "de 2 sabores hawaiana y…"
    if (n) res[h.sabor] = n;
  }
  return res;
}

/**
 * Tamaño mencionado: "de 8 porciones", "pizza de 12", "la grande", "familiar"… (o null).
 * Un número suelto solo cuenta si va con "porciones" o después de "de / pizza de / la de", o si el
 * mensaje es solo el número. Así "4 de hawaiana" (porciones de un sabor) no cambia el tamaño.
 */
export function tamanoEnTexto(texto) {
  const t = limpiar(texto);
  const m = t.match(/\b(4|6|8|12|cuatro|seis|ocho|doce)\s*(porciones|porcion|pedazos|tajadas|pzs)\b/)
    ?? t.match(/\b(?:pizzas?|una|la|las|tamano)\s+de\s+(4|6|8|12|cuatro|seis|ocho|doce)\b(?!\s+sabores)/)
    ?? t.match(/\bde\s+(4|6|8|12|cuatro|seis|ocho|doce)\s*(?=$|\b(?:con|y|por|porfa|porfavor|para|mitad|combinad\w*|gracias)\b)/)
    ?? t.match(/^\s*(?:de\s+|la de\s+|una de\s+)?(4|6|8|12|cuatro|seis|ocho|doce)\s*$/);
  if (m) return aNumero(m[1]);
  if (/\b(personal|pequena|pequeña|chica)\b/.test(t)) return 4;
  if (/\bmediana\b/.test(t)) return 6;
  if (/\bgrande\b/.test(t)) return 8;
  if (/\b(familiar|gigante|extra ?grande)\b/.test(t)) return 12;
  return null;
}

/** "un solo sabor", "1 sabor", "sin combinar", "no combinar", "normal", "sencilla de sabor" → no quiere combinar. */
export const quiereUnSolo = (texto) => /\b((1|un|uno) (solo |unico |mismo )?sabor|de un sabor|solo (un|1) sabor|sin combinar|no (la )?(quiero )?combin\w+|no combinada|toda de|completa de|entera de)\b/.test(limpiar(texto));

/** ¿El cliente está pidiendo una combinación? ("mitad", "combinada", "2 sabores", "dos sabores"…) */
export const quiereCombinar = (texto) => !quiereUnSolo(texto) && /\b(mitad|mita|combinad[ao]s?|combinar|combinarla|combinacion(es)?|(2|dos|3|tres) sabores|de sabores|varios sabores|surtida|mixta de sabores)\b/.test(limpiar(texto));

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

/**
 * Lee de una vez todo lo que dijo el cliente de la pizza.
 * @param {string} texto
 * @param {{ tamano?: number|null }} [ctx]  tamaño que ya se conoce (si está armando una pizza):
 *   con él, "4 de jamón y queso" son porciones de ese sabor y no un cambio de tamaño.
 */
export function leerPedidoPizza(texto, ctx = {}) {
  const { sabores, ambiguos } = saboresEnTexto(texto);
  const crudas = asignacionesEnTexto(texto);
  const numericas = Object.values(crudas).filter((v) => typeof v === 'number');
  let tamano = tamanoEnTexto(texto);
  // "4 de hawaiana y 4 de mexicana" sin decir el tamaño → es la de 8.
  const suma = numericas.reduce((a, b) => a + b, 0);
  if (!ctx.tamano && numericas.length >= 2 && numericas.length === sabores.length && TAMANOS.includes(suma) && !/\bporciones\b/.test(limpiar(texto).replace(/\b\d+ porciones (de|del)\b/g, ''))) tamano = suma;
  // Con tamaño conocido de antes: un número con sabor después son porciones, no el tamaño ("4 porciones de jamón").
  if (ctx.tamano && tamano && tamano !== ctx.tamano && numericas.includes(tamano)) tamano = null;
  const T = tamano ?? ctx.tamano ?? null;
  // Porciones por sabor: "mitad" = T/2; se descarta el número que en realidad era el tamaño ("pizza de 4 hawaiana").
  const porciones = {};
  for (const [sabor, v] of Object.entries(crudas)) {
    if (v === 'mitad') { if (T) porciones[sabor] = T / 2; continue; }
    if (T && v === T) continue;
    if (!T && TAMANOS.includes(v) && numericas.length === 1) continue;
    porciones[sabor] = v;
  }
  const unSolo = quiereUnSolo(texto);
  return {
    tamano, sabores, ambiguos, porciones,
    borde: bordeEnTexto(texto),
    unSolo,
    combinar: !unSolo && (quiereCombinar(texto) || sabores.length >= 2),
    nSabores: numeroSaboresEnTexto(texto),
    cantidad: cantidadPizzas(texto),
  };
}

/**
 * Ordena los sabores según las porciones que pidió el cliente y revisa que el reparto exista.
 * @returns {{ sabores: string[], nSabores: number|null, error: string|null }}
 */
export function ordenarPorPorciones(tamano, sabores, porciones, nSabores = null) {
  const asignados = sabores.filter((s) => porciones[s]);
  if (!asignados.length || !REPARTOS[tamano]) return { sabores, nSabores, error: null };
  const opciones = Object.entries(REPARTOS[tamano]).map(([n, r]) => ({ n: Number(n), r })).filter((o) => !nSabores || o.n === nSabores);
  const cabe = (r) => { const libres = [...r]; return asignados.every((s) => { const i = libres.indexOf(porciones[s]); if (i < 0) return false; libres.splice(i, 1); return true; }); };
  const validas = opciones.filter((o) => cabe(o.r) && sabores.length <= o.n);
  if (!validas.length) {
    const formas = Object.values(REPARTOS[tamano]).map((r) => r.join(' + ')).join('  o  ');
    return { sabores, nSabores, error: `La pizza de *${tamano} porciones* se reparte así: *${formas}* 🙂 Dime los sabores con uno de esos repartos.` };
  }
  // Si solo una forma sirve (p. ej. pidió "2 de mexicana" en la de 8 → 4+2+2), queda fijado el nº de sabores.
  const elegido = validas.length === 1 ? validas[0] : (validas.find((o) => o.n === Math.max(2, sabores.length)) ?? validas[0]);
  // Orden: de más a menos porciones (el reparto va de mayor a menor); los que no tienen número, al final.
  const orden = [...sabores].sort((a, b) => (porciones[b] ?? 0) - (porciones[a] ?? 0));
  // Si el que tiene la porción grande no fue asignado pero sí los pequeños ("2 mexicana y 2 ranchera, y hawaiana"), el sin número va primero.
  const r = elegido.r;
  const final = [];
  const pend = [...orden];
  for (const tam of r) {
    let i = pend.findIndex((s) => porciones[s] === tam);
    if (i < 0) i = pend.findIndex((s) => !porciones[s]);
    if (i < 0) break;
    final.push(pend.splice(i, 1)[0]);
  }
  return { sabores: [...final, ...pend], nSabores: validas.length === 1 || nSabores ? elegido.n : nSabores, error: null };
}

// ---------------------------------------------------------------------------
//  Recomendaciones y tarjetas
// ---------------------------------------------------------------------------

// Sabores que se recomiendan primero cuando al cliente le falta elegir (cámbialos a tu gusto).
export const RECOMENDADOS = ['Hawaiana', 'Mexicana', 'Ranchera', 'Pollo y Champiñón', 'de Pepperoni', 'Jamón y Queso', 'Carnívora', 'La Paisita', 'Hawaiana Chicken', 'Napolitana', 'Pollo y Tocineta', 'Vegetariana'];

/** Tarjeta (para enviarTarjetas) de un sabor en un tamaño; sin tamaño abre la de 4 porciones. */
export function tarjetaPizza(sabor, tamano = null) {
  const e = SABORES.get(sabor);
  const v = e?.tamanos[tamano] ?? e?.tamanos[4] ?? Object.values(e?.tamanos ?? {})[0];
  if (!v) return null;
  return { id: v.id, nombre: `Pizza ${sabor}`, precio: v.precio, seccion: 'Pizzas', carta: 'pizzas', marca: "Black's Pizza", conVariantes: true, principal: true };
}

/** Hasta `max` sabores recomendados que aún no eligió (en ese tamaño), como tarjetas. */
export function recomendaciones(tamano, yaElegidos = [], max = 6) {
  const orden = [...RECOMENDADOS, ...[...SABORES.keys()].filter((s) => !RECOMENDADOS.includes(s))];
  return orden.filter((s) => !yaElegidos.includes(s) && SABORES.get(s)?.tamanos[tamano]?.precio != null).slice(0, max).map((s) => tarjetaPizza(s, tamano)).filter(Boolean);
}

/** Pizza de UN sabor pedida por texto (mismo formato que un ítem del carrito). */
export function pizzaSencillaItem({ sabor, tamano, cantidad = 1 }) {
  const v = SABORES.get(sabor)?.tamanos[tamano];
  if (!v || v.precio == null) return null;
  return { product_retailer_id: v.id, quantity: cantidad, item_price: v.precio, currency: 'COP', comboPreguntado: true };
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
