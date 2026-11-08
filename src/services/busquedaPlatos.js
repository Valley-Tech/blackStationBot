/**
 * Búsqueda de platos con IA (v3.5) — como MerkCentro24, pero con tarjetas.
 *
 * El cliente escribe "me regalas 3 salchipapas", "una piza hawaiana", "tienen
 * micheladas?" y el bot le muestra los platos en TARJETAS del catálogo:
 *   · 1 plato   → tarjeta de producto (single product)
 *   · 2 a 10    → carrusel de productos (se desliza; cada tarjeta con "Ver")
 *   · más de 10 → lista de productos con carrito (product_list)
 *
 * Cómo encuentra los platos:
 *   1. La IA del CRM (Gemini o Claude, la misma de Chatbots → IA y conocimiento)
 *      entiende la frase y devuelve los IDs reales del catálogo
 *      (POST /api/v1/bot/ai/products/search; lista "productos-crm-blackstation.csv").
 *   2. Si la IA no está disponible, una búsqueda local con tolerancia a errores
 *      de escritura ("piza", "hamburgesa", "salchipapas").
 *   3. Variantes de Meta: una tarjeta por plato ("Salchipapa": sencilla, mixta,
 *      ranchera… se eligen dentro de la tarjeta). Si el cliente nombró una
 *      variante ("salchipapa mixta"), la tarjeta abre esa variante.
 *   4. Familia: si el cliente pidió algo genérico ("salchipapa"), se agregan los
 *      platos de la misma sección de la carta (choripapa, pollipapa,
 *      salchiplátano…), después de los que pidió.
 */
import { product_names, precios, CATALOGOS, grupoPorId, tituloGrupo } from '../data/catalogo.js';
import config from '../config/env.js';
import sendToWhatsApp from './httpRequest/sendToWhatsApp.js';
import { searchProducts } from './crmAdapter.js';
import { normalizar, cantidadPedida } from './conversacion.js';
import { tieneFoto, asegurarFotos } from './fotosCatalogo.js';

const MAX_CARRUSEL = 10;
const MAX_LISTA = 30;

// ---------------------------------------------------------------------------
//  Índice del catálogo
// ---------------------------------------------------------------------------

/** "salchipapas" → "salchipapa", "patacones" → "patacon". */
const raiz = (w) => (w.length > 5 && w.endsWith('ones') ? w.slice(0, -2) : w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w);
const palabras = (t) => normalizar(t).replace(/[^a-z0-9ñ ]/g, ' ').split(' ').filter((w) => w.length >= 2).map(raiz);

// Palabras de la frase del cliente que no dicen qué plato quiere.
const STOP = new Set(['quiero', 'quisiera', 'regala', 'regalas', 'regalan', 'regalame', 'dame', 'deme', 'mandame', 'manda', 'manden', 'traeme', 'necesito', 'busco', 'me', 'nos', 'una', 'uno', 'un', 'el', 'la', 'lo', 'los', 'la', 'de', 'del', 'por', 'favor', 'porfa', 'porfavor', 'para', 'con', 'sin', 'que', 'tiene', 'tienen', 'hay', 'venden', 'vende', 'algo', 'y', 'o', 'a', 'al', 'en', 'mi', 'tu', 'su', 'pedir', 'pedido', 'comprar', 'precio', 'cuanto', 'cuesta', 'vale', 'valen', 'como', 'esta', 'estan', 'otra', 'otro', 'mas', 'tambien', 'si', 'no', 'hola', 'buena', 'buenas', 'noche', 'tarde', 'dia', 'gracia', 'domicilio', 'llevar', 'aqui', 'alla', 'pa', 'ponme', 'pon', 'agrega', 'agregame', 'ahora', 'tienes', 'q', 'x',
  // Palabras comunes que se parecen a platos ("pero" ≈ "perro", "vamos" ≈ "vaso").
  'pero', 'vamo', 'vaya', 'entre', 'nosotro', 'podemo', 'puedo', 'resto', 'todo', 'nada', 'bien', 'solo', 'ahi', 'aca', 'listo', 'ya', 'pague', 'pagar', 'hablar', 'alguien', 'comer', 'ir', 'voy', 'van', 'va', 'llega', 'cuando', 'donde', 'yo', 'usted', 'ustede', 'senor', 'senora', 'amigo', 'bueno', 'mejor', 'hacer', 'favor', 'mismo', 'misma', 'ese', 'esa', 'eso', 'este', 'esto', 'cual', 'quien', 'porque', 'pue', 'entonce', 'gracia', 'gracias', 'ok', 'vale']);
// Palabras de los nombres que, solas, no identifican un plato.
const GENERICAS = new Set(['porcion', 'porcione', 'personal', 'mediana', 'mediano', 'grande', 'pequena', 'pequeno', 'familiar', 'sencillo', 'sencilla', 'especial', 'doble', 'mixto', 'mixta', 'tradicional', 'super', 'casa', 'agua', 'leche', 'litro', 'ml', 'lt', 'oz', 'und', 'unidad', 'borde', 'queso']);

function construirIndice() {
  const porId = new Map();
  for (const [key, carta] of Object.entries(CATALOGOS)) {
    for (const s of carta.sections) {
      for (const nombre of s.productos) {
        const id = product_names[nombre];
        if (!id || porId.has(id)) continue;
        porId.set(id, { id, nombre, precio: precios[nombre] ?? null, carta: key, seccion: `${key}|${s.title}`, tituloSeccion: s.title, marca: carta.marca });
      }
    }
  }
  // Productos del catálogo de Meta que no están en ninguna carta (p. ej. recién agregados).
  for (const [nombre, id] of Object.entries(product_names)) {
    if (!porId.has(id)) porId.set(id, { id, nombre, precio: precios[nombre] ?? null, carta: null, seccion: `otros|${nombre}`, tituloSeccion: '', marca: '' });
  }
  for (const e of porId.values()) {
    e.grupo = grupoPorId[e.id] ?? null;
    e.tituloGrupo = e.grupo ? tituloGrupo[e.grupo] ?? null : null;
    const ws = [...palabras(e.nombre), ...palabras(e.tituloGrupo ?? '')];
    // También las palabras pegadas: "Coca-Cola" → "cocacola", "Salchi Papa" → "salchipapa".
    const juntas = palabras(e.nombre).filter((w) => w.length >= 3 && !STOP.has(w)).flatMap((w, i, a) => (i ? [raiz(a[i - 1] + w)] : []));
    e.palabras = [...new Set([...ws, ...juntas])];
    e.palabrasSeccion = palabras(e.tituloSeccion);
  }
  return porId;
}
const INDICE = construirIndice();

// ---------------------------------------------------------------------------
//  Búsqueda local (respaldo de la IA) y detección de "habla de un plato"
// ---------------------------------------------------------------------------

function distancia(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 9;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

/** Puntaje de una palabra del cliente contra las palabras de un plato. */
function puntaje(t, ws) {
  let best = 0;
  for (const w of ws) {
    if (w === t) return 3;
    if (t.length >= 4 && (w.startsWith(t) || (t.length >= 5 && w.includes(t)))) best = Math.max(best, 2);
    else if (w.length >= 4 && t.includes(w)) best = Math.max(best, 1.5);           // "cocacola" ⊃ "coca"
    else if (t.length >= 5 && distancia(t, w) <= (t.length >= 8 ? 2 : 1)) best = Math.max(best, 2); // "hamburgesa", "salchipaa"
    else if (t.length === 4 && w.length === 5 && t[0] === w[0] && distancia(t, w) === 1) best = Math.max(best, 2); // "piza" → "pizza"
  }
  return best;
}

export function terminos(texto) {
  return palabras(texto).filter((w) => !STOP.has(w) && !/^\d+$/.test(w));
}

/** Búsqueda sin IA: [{ e, score }] ordenado de mejor a peor. */
export function buscarLocal(texto) {
  const ts = terminos(texto);
  if (!ts.length) return [];
  const res = [];
  for (const e of INDICE.values()) {
    let score = 0;
    let especifico = false;
    for (const t of ts) {
      // La sección de la carta ("Salchipapas") cuenta un poco menos que el nombre del plato.
      const p = Math.max(puntaje(t, e.palabras), 0.8 * puntaje(t, e.palabrasSeccion));
      if (p > 0) { score += p; if (!GENERICAS.has(t)) especifico = true; }
    }
    if (score > 0 && especifico) res.push({ e, score });
  }
  if (!res.length) return [];
  res.sort((a, b) => b.score - a.score || (a.e.precio ?? 0) - (b.e.precio ?? 0));
  const tope = res[0].score;
  return res.filter((r) => r.score >= Math.max(2, tope * 0.7));
}

// Palabras que nombran un TIPO de plato (primera palabra de cada nombre, grupo o sección de la carta):
// "salchipapa", "pizza", "hamburguesa", "jugo"… Un ingrediente solo ("pollo", "queso") no basta.
const PLATOS = new Set([...INDICE.values()].flatMap((e) => [palabras(e.nombre)[0], palabras(e.tituloGrupo ?? '')[0], palabras(e.tituloSeccion)[0]]).filter((w) => w && w.length >= 3 && !GENERICAS.has(w) && !STOP.has(w)));
const INTENCION = /\b(quiero|quisiera|regala|regalas|regalame|regalen|dame|deme|me das|me da|manda|mandame|manden|traeme|tienen|tiene|hay|venden|pedir|ordenar|antojo|una|un|uno|dos|tres|cuatro|cinco|\d+)\b/;

/**
 * ¿El mensaje pide (o pregunta por) un plato o bebida de la carta?
 * "me regalas 3 salchipapas", "una piza", "tienen micheladas?" → sí.
 * "y el resto del pollo", "vamos a ir allá", "pero pequeño" → no (va a la IA).
 */
export function hablaDePlatos(texto) {
  const res = buscarLocal(texto);
  if (!res.length) return false;
  const ts = terminos(texto);
  if (ts.some((t) => puntaje(t, [...PLATOS]) >= 2)) return true;
  return INTENCION.test(normalizar(texto));
}

// ---------------------------------------------------------------------------
//  De productos a tarjetas
// ---------------------------------------------------------------------------

/**
 * Agrupa los productos encontrados en tarjetas (una por plato) y, si la búsqueda
 * fue genérica, agrega la familia (misma sección de la carta).
 */
export function armarTarjetas(ids, texto) {
  return armar(ids, texto).tarjetas;
}

/**
 * v3.5.3: solo productos con FOTO VÁLIDA en el catálogo de Meta (fotosCatalogo.js).
 * Un producto sin foto no aparece en WhatsApp y hace fallar el carrusel (#131009).
 * Devuelve { tarjetas, sinFoto } — sinFoto: platos que el cliente pidió y aún no tienen foto.
 */
function armar(ids, texto) {
  const encontrados = ids.map((id) => INDICE.get(id)).filter(Boolean);
  if (!encontrados.length) return { tarjetas: [], sinFoto: [] };
  const clave = (e) => (config.VARIANTES_META && e.grupo ? `g:${e.grupo}` : `p:${e.id}`);

  const tarjetas = new Map(); // clave → { ids:[], e }
  const agregar = (e, principal) => {
    const k = clave(e);
    const t = tarjetas.get(k) ?? { clave: k, ids: [], principal, seccion: e.seccion };
    if (!t.ids.includes(e.id)) t.ids.push(e.id);
    tarjetas.set(k, t);
  };
  for (const e of encontrados) agregar(e, true);

  // Familia: "salchipapa" ≈ sección "Salchipapas" → también choripapa, pollipapa, salchiplátano…
  const ts = terminos(texto);
  const secciones = new Set([...tarjetas.values()].map((t) => t.seccion));
  if (secciones.size === 1) {
    const [seccion] = secciones;
    const hermanos = [...INDICE.values()].filter((e) => e.seccion === seccion);
    // Genérica = todo lo que escribió el cliente es el nombre de la sección ("salchipapas"),
    // no un plato concreto ("salchipapa mixta", "jugo de mora").
    const generica = ts.length > 0 && ts.every((t) => puntaje(t, hermanos[0]?.palabrasSeccion ?? []) >= 2);
    const tarjetasSeccion = new Set(hermanos.map(clave));
    if (generica && tarjetasSeccion.size <= MAX_CARRUSEL) for (const e of hermanos) if (!tarjetas.has(clave(e))) agregar(e, false);
  }

  // Producto que abre cada tarjeta: la variante que pidió (o la más económica de las encontradas),
  // siempre una CON FOTO. Si la que pidió no tiene foto, se abre otra variante del mismo plato que sí tenga.
  const porPrecio = (a, b) => (INDICE.get(a).precio ?? 0) - (INDICE.get(b).precio ?? 0);
  const sinFoto = [];
  const lista = [];
  for (const t of tarjetas.values()) {
    const grupo = [...INDICE.values()].filter((e) => clave(e) === t.clave).map((e) => e.id);
    const pedidos = t.principal ? t.ids : grupo;
    const id = pedidos.filter(tieneFoto).sort(porPrecio)[0] ?? grupo.filter(tieneFoto).sort(porPrecio)[0];
    if (!id) {
      if (t.principal) { const e = INDICE.get(t.ids[0]); sinFoto.push({ nombre: e.tituloGrupo && t.clave.startsWith('g:') ? e.tituloGrupo : e.nombre, precio: e.precio }); }
      continue;
    }
    const e = INDICE.get(id);
    lista.push({ id, nombre: e.tituloGrupo && t.clave.startsWith('g:') ? e.tituloGrupo : e.nombre, precio: e.precio, seccion: e.tituloSeccion, carta: e.carta, marca: e.marca, conVariantes: t.clave.startsWith('g:'), principal: t.principal });
  }
  return { tarjetas: lista.slice(0, MAX_LISTA), sinFoto };
}

/** Productos de las mismas secciones y grupos (para revisar sus fotos en una sola pasada). */
function relacionados(ids) {
  const secciones = new Set(ids.map((id) => INDICE.get(id)?.seccion).filter(Boolean));
  const grupos = new Set(ids.map((id) => INDICE.get(id)?.grupo).filter(Boolean));
  return [...INDICE.values()].filter((e) => secciones.has(e.seccion) || (e.grupo && grupos.has(e.grupo))).map((e) => e.id);
}

// ---------------------------------------------------------------------------
//  Búsqueda completa: IA del CRM → respaldo local
// ---------------------------------------------------------------------------

let avisoSinCatalogo = false;

/**
 * @returns {Promise<{ tarjetas, fuente: 'ia'|'local'|null }>}
 */
export async function buscarPlatos(to, texto) {
  const local = buscarLocal(texto);
  let ids = [];
  let fuente = null;
  const r = await searchProducts(to, texto, { limit: 20 });
  if (r?.items?.length) {
    ids = r.items.map((p) => String(p.id)).filter((id) => INDICE.has(id));
    if (ids.length) fuente = 'ia';
  } else if (r === null && !avisoSinCatalogo) {
    avisoSinCatalogo = true;
    console.warn('[platos] la búsqueda con IA del CRM no está disponible: se usa la búsqueda local. Sube docs/productos-crm-blackstation.csv al CRM (Chatbots → IA y conocimiento → Catálogo de productos) y activa la IA.');
  }
  if (!ids.length && local.length) { ids = local.map((x) => x.e.id); fuente = 'local'; }
  await asegurarFotos(relacionados(ids)); // ¿las fotos existen de verdad? (máx. 3 s, con caché)
  const { tarjetas, sinFoto } = armar(ids, texto);
  return { tarjetas, sinFoto, fuente };
}

// ---------------------------------------------------------------------------
//  Envío
// ---------------------------------------------------------------------------

const enviar = (to, interactive) => sendToWhatsApp({ messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'interactive', interactive });

function textoCuerpo(tarjetas, texto) {
  const cantidad = cantidadPedida(texto);
  const variantes = tarjetas.some((t) => t.conVariantes);
  const n = tarjetas.length;
  const intro = n === 1 ? '¡Aquí la tienes! 👇' : `Encontré ${n} opciones para ti 👇${n > 2 ? '\nDesliza ➡️ para verlas todas.' : ''}`;
  const pasos = `Toca *Ver*${variantes ? ', elige el tipo o el tamaño' : ''} y agrégala al carrito 🛒${cantidad && cantidad > 1 ? ` (pon la cantidad: *${cantidad}*)` : ''}.`;
  return `${intro}\n\n${pasos}\nCuando tengas todo, envía el carrito y te confirmo el pedido 😊`;
}

export async function enviarTarjetas(to, tarjetas, texto = '') {
  if (!tarjetas.length) return false;
  if (!config.CATALOG_ID) {
    console.error('[platos] CATALOG_ID vacío: no se pueden enviar tarjetas de productos.');
    return false;
  }
  const body = textoCuerpo(tarjetas, texto);
  try {
    if (tarjetas.length === 1) {
      await enviar(to, {
        type: 'product',
        body: { text: body },
        footer: { text: tarjetas[0].marca || 'La Estación Parrilla Bar' },
        action: { catalog_id: config.CATALOG_ID, product_retailer_id: tarjetas[0].id },
      });
      return true;
    }
    if (tarjetas.length <= MAX_CARRUSEL) {
      await enviar(to, {
        type: 'carousel',
        body: { text: body },
        action: { cards: tarjetas.map((t, i) => ({ card_index: i, type: 'product', action: { product_retailer_id: t.id, catalog_id: config.CATALOG_ID } })) },
      });
      return true;
    }
  } catch (error) {
    // Modo espejo: si Meta rechaza el carrusel (WhatsApp viejo, producto sin imagen…), se manda la lista.
    console.warn('[platos] no se pudo enviar la tarjeta/carrusel; se envía la lista de productos:', error.response?.data?.error?.message ?? error.message);
  }
  return enviarLista(to, tarjetas, body);
}

/** Platos que el cliente pidió pero aún no tienen foto en el catálogo (no se pueden mostrar en tarjeta). */
export function textoSinFoto(sinFoto) {
  const lineas = sinFoto.slice(0, 8).map((p) => `• ${p.nombre}${p.precio ? ` · $${Number(p.precio).toLocaleString('es-CO')}` : ''}`);
  return `Sí lo tenemos 😋\n\n${lineas.join('\n')}\n\nTodavía no está en nuestro catálogo de WhatsApp, así que no lo puedes agregar al carrito. Escribe *asesor* y una persona toma tu pedido 🙌`;
}

/** Lista de productos con carrito (más de 10 platos, o respaldo del carrusel). */
async function enviarLista(to, tarjetas, body) {
  const secciones = new Map();
  for (const t of tarjetas.slice(0, MAX_LISTA)) {
    const titulo = (t.seccion || 'Productos').slice(0, 24);
    if (!secciones.has(titulo)) secciones.set(titulo, []);
    secciones.get(titulo).push({ product_retailer_id: t.id });
  }
  await enviar(to, {
    type: 'product_list',
    header: { type: 'text', text: 'Lo que encontré 🔎' },
    body: { text: body.slice(0, 1024) },
    footer: { text: 'La Estación Parrilla Bar' },
    action: { catalog_id: config.CATALOG_ID, sections: [...secciones].slice(0, 10).map(([title, product_items]) => ({ title, product_items })) },
  });
  return true;
}

/** CSV para subir al CRM (Chatbots → IA y conocimiento → Catálogo de productos). */
export function csvParaCrm() {
  const filas = [['id', 'nombre', 'precio', 'categoria']];
  for (const e of INDICE.values()) {
    const categoria = [e.tituloGrupo, e.tituloSeccion, e.marca].filter(Boolean).join(' · ');
    filas.push([e.id, e.nombre, e.precio ?? '', categoria]);
  }
  return filas.map((f) => f.map((v) => (/[;"\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v)).join(';')).join('\n');
}
