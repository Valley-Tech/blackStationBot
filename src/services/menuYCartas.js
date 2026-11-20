/**
 * Palabras clave "menú" y "carta" (v3.10): qué pidió exactamente el cliente.
 *
 *   "carta" (en cualquier forma: carta, Carta, CARTA, cartas) → SIEMPRE la carta en PDF:
 *       "muéstrame la carta de La Estación parrilla"   → Carta-La-Estacion-Parrilla.pdf
 *       "quiero la carta de las pizzas / de pizzería / de Black's Pizza" → Carta-Blacks-Pizza.pdf
 *       "la carta de la heladería / de helados / Yellow" → Carta-Heladeria-Yellow.pdf
 *       "la carta" (sin decir cuál)                      → las 3
 *   "menú" sin "carta":
 *       con un tema  → "el menú de las pizzas" → carta de pizzas del catálogo (cat:pizzas);
 *                      "el menú de las hamburguesas" → carrusel solo de hamburguesas
 *                      (si alguna no tiene foto, la lista de productos de esa carta);
 *       sin tema     → "quiero el menú", "el menú completo" → catálogo de WhatsApp (CATALOG_TEMPLATE);
 *       en la web    → "el menú en la página web", "el menú digital" → enlace MENU_WEB_URL.
 *   "Menú Infantil" es un producto: no cuenta como "menú".
 */
import { normalizar } from './conversacion.js';

const limpio = (t) => normalizar(t).replace(/[^a-z0-9ñ ]/g, ' ').replace(/\s+/g, ' ').trim();

/** ¿Dijo "carta"? */
export const pideCarta = (texto) => /\bcartas?\b/.test(limpio(texto));

/** ¿Dijo "menú" (y no es el producto "Menú Infantil")? */
export function pideMenu(texto) {
  const t = limpio(texto);
  return /\bmenus?\b/.test(t) && !/\bmenus? (infantil|infantiles|kids|kid|de ninos|para ninos|nino|ninos)\b/.test(t);
}

/** ¿Lo quiere en internet? "en la página web", "el link", "menú digital", "en Google". */
export const pideWeb = (texto) => /\b(pagina|paginas|web|internet|google|navegador|chrome|safari|link|links|enlace|url|digital|en linea|online|sitio)\b/.test(limpio(texto));

// Cartas en PDF por palabra clave (ids de negocio.cartas).
const CARTAS_PDF = [
  ['parrilla', /\b(parrillas?|parrillada|estacion|asados?|carnes?|hamburguesas?|burgers?|salchipapas?|perros?|hot ?dogs?|patacon(es)?|picadas?|sandwich(es)?|sanduches?|comidas? rapidas?|pechugas?|chuletas?|costillas?|desgranados?|casquitos?)\b/],
  ['pizzeria', /\b(pi(z|s|zz)+as?|pizzeria|pizeria|pizzerias|panzerott?is?|lasan(a|as)|lasagnas?)\b/],
  ['heladeria', /\b(helados?|heladerias?|yellow|postres?|malteadas?|waffles?|frapp?es?|smoothies?|jugos?|limonadas?|micheladas?|copas? de helado)\b/],
];

/** Cartas en PDF que nombró: ['pizzeria'], ['parrilla', 'heladeria']… o [] si no nombró ninguna. */
export function cartasPdfPedidas(texto) {
  const t = limpio(texto);
  return CARTAS_PDF.filter(([, re]) => re.test(t)).map(([id]) => id);
}

// Palabras que acompañan a "menú" sin decir de qué: "regálame el menú xf completo".
const RELLENO = new Set(`menu menus carta cartas completo completa completos todo toda todos todas general entero entera ver verlo verla mirar conocer revisar
quiero quiere quisiera queremos deseo deseamos necesito me te le nos les regalas regalame regala regalan regalen muestrame muestreme muestranos mostrar muestra muestras
enviame envia envian enviar envialo manda mandame mandas mandan pasame pasa pasas dame das da puedes podrias puede pueden podrian seria
el la lo los las de del al a en con por para su sus tu tus mi un una unos unas y o que cual cuales como donde
favor porfa porfavor xfa xf pf plis please gracias hola buenas buenos noches tardes dias buen dia saludos
hoy actual ahora ya aqui alla ustedes tienen tienes hay manejan precios precio valores con sus
oye mira listo ok bueno si vale amigo amiga senor senora joven don dona disponible disponibles actualizado nuevo`.split(/\s+/));

/** Lo que queda del mensaje sin "menú" ni palabras de relleno ("el menú de las hamburguesas" → "hamburguesas"). */
export function temaDelMenu(texto) {
  return limpio(texto).split(' ').filter((w) => w && !RELLENO.has(w)).join(' ');
}

/** ¿El tema es la pizza? */
export const temaPizza = (tema) => /\b(pi(z|s|zz)+as?|pizzeria|pizeria)\b/.test(tema);
/** ¿El tema es la parrilla o el negocio en general? */
export const temaParrilla = (tema) => /\b(parrillas?|parrillada)\b/.test(tema);
