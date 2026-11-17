/**
 * Datos del pedido que el cliente escribe en el chat (v3.9): medio de pago, si recoge en
 * el restaurante o es a domicilio, y la dirección. Ejemplo (JD Prieto):
 *   "Para pedir una pizza de 8 porciones, mitad hawaiana y mitad mexicana, pago por
 *    transferencia. Me avisas cuando el pedido esté listo para pasar a recoger"
 *   → { pago: 'Transferencia', entrega: 'restaurante' }
 *
 * Los valores son los MISMOS ids del Flow de pedido de Meta:
 *   pago:    "Efectivo" | "Transferencia" | "Codigo QR"   (Dropdown "pago")
 *   entrega: "restaurante" | "domicilio"                  (RadioButtonsGroup "paradonde" → data.address)
 * Con eso el Flow se abre ya marcado (ver menuPedido) y el resumen del pedido lo muestra.
 *
 * Solo se toma lo que el cliente AFIRMA. Las preguntas ("¿reciben transferencia?",
 * "¿cuánto vale el domicilio?") no cuentan como elección.
 */
import { normalizar } from './conversacion.js';

// Medios de pago que acepta el Flow de este negocio (ids exactos del Dropdown).
export const PAGOS = ['Efectivo', 'Transferencia', 'Codigo QR'];

const PREGUNTA = /[¿?]|\b(aceptan|reciben|tienen|hay|se puede|puedo|cuanto|cuánto|vale|cuesta|cobran|precio|valor|manejan)\b/;

/** Medio de pago afirmado en el texto (id del Flow) o null. */
export function pagoEnTexto(texto) {
  const t = normalizar(texto);
  const pregunta = PREGUNTA.test(t) && !/\b(pago|pagare|pagamos|pagaria|voy a pagar|te pago|le pago|pagar(e|ia)?) (con|por|en|de|el)\b/.test(t);
  if (pregunta && !/\b(dame|damelo|enviame|enviamelo|mandame|mandamelo|pasame|regalame)\b/.test(t)) return null;
  if (/\b(codigo qr|cod qr|el qr|un qr|por qr|con qr|qr)\b/.test(t)) return PAGOS.includes('Codigo QR') ? 'Codigo QR' : (PAGOS.includes('Transferencia') ? 'Transferencia' : null);
  if (/\b(pse|link de pago|enlace de pago|tarjeta de credito|tarjeta debito|con tarjeta)\b/.test(t)) return PAGOS.includes('PSE') ? 'PSE' : null;
  if (/\b(transferencia|transferir|transfiero|transfiera|consignacion|consigno|nequi|daviplata|bancolombia|por el banco|llave|bre-?b)\b/.test(t)) return PAGOS.includes('Transferencia') ? 'Transferencia' : null;
  if (/\b(efectivo|en billete|cash|contra ?entrega|al recibir|cuando llegue|pago al domiciliario)\b/.test(t)) return 'Efectivo';
  return null;
}

/** 'restaurante' (recoge) | 'domicilio' | null. */
export function entregaEnTexto(texto) {
  const t = normalizar(texto);
  if (/\b(paso|pasar|pasare|pasamos|paso yo|voy|ire|vamos|iremos) (a |por )?(recoger|buscar|por (el|ella|ellas|ellos|eso|el pedido|la pizza|mi pedido))\b|\b(para|lo|la|los|las|a) recoger\b|\brecojo\b|\brecogemos\b|\bpara llevar\b|\ben el (restaurante|local|negocio)\b|\bvoy (para|pa) (alla|el restaurante|el local)\b|\bsin domicilio\b|\bno (es|sera|va a ser) (a |para )?domicilio\b/.test(t)) return 'restaurante';
  const preguntaPrecio = /\b(cuanto|vale|cuesta|cobran|precio|valor|tienen|hacen|hay)\b[^.]*\bdomicilio|\bdomicilio[^.]*\b(cuanto|vale|cuesta|precio|valor)\b/.test(t) || /[¿?]/.test(texto ?? '') && /\bdomicilio/.test(t) && !/\b(a|para|por) domicilio\b/.test(t);
  if (preguntaPrecio) return null;
  if (/\b(a domicilio|para domicilio|por domicilio|un domicilio|el domicilio a|domicilio para|me lo (traen|mandan|envian|llevan)|me la (traen|mandan|envian|llevan)|traemelo|traemela|mandamelo|mandamela|envialo a|enviala a|llevalo a|llevala a|a mi casa|a la casa|hasta mi casa|me lo mandas|me la mandas)\b/.test(t)) return 'domicilio';
  return null;
}

/** Dirección escrita por el cliente ("Calle 10 # 5-20 barrio Centro") o null. */
export function direccionEnTexto(texto) {
  const original = String(texto ?? '').replace(/\s+/g, ' ').trim();
  const t = normalizar(original);
  const via = /\b(calle|cll|cl|carrera|cra|kra|kr|cr|carera|diagonal|dg|transversal|tv|avenida|av|manzana|mz|barrio|br|urbanizacion|urb|conjunto|vereda|corregimiento|apto|apartamento|casa)\b\.?\s*(no\.?|numero|#|n°)?\s*[\w-]*\d|\b(calle|carrera|cra|cll|kr|diagonal|transversal|avenida)\s+\d+\w?\s*(#|no\.?|n°|numero)\s*\d+/;
  const m = t.match(via);
  if (!m) return null;
  // Desde la palabra de la vía hasta el final de la frase (máx. 120 caracteres), con las tildes originales.
  const inicio = m.index;
  const resto = original.slice(inicio);
  const fin = resto.search(/[.\n]\s+[A-ZÁÉÍÓÚ¿¡]|,\s*(pago|me avisas|gracias|porfa|por favor)/i);
  const dir = (fin > 0 ? resto.slice(0, fin) : resto).replace(/[.,;\s]+$/, '').slice(0, 120);
  return dir.length >= 6 ? dir : null;
}

/** Todo lo que se pudo leer: { pago?, entrega?, direccion? } (solo las claves encontradas). */
export function datosEnTexto(texto) {
  const r = {};
  const pago = pagoEnTexto(texto);
  const direccion = direccionEnTexto(texto);
  let entrega = entregaEnTexto(texto);
  if (!entrega && direccion) entrega = 'domicilio';
  if (pago) r.pago = pago;
  if (entrega) r.entrega = entrega;
  if (direccion) r.direccion = direccion;
  return r;
}

/** "57 300 123 4567" → "3001234567" (para el campo teléfono del Flow). */
export const telefonoLocal = (wa) => {
  const d = String(wa ?? '').replace(/\D/g, '');
  return d.length === 12 && d.startsWith('57') ? d.slice(2) : d;
};

/** Nombre del perfil de WhatsApp limpio ("✨Mharia✨" → "Mharia"; "~Josse" → "Josse"), o ''. */
export function nombreLimpio(perfil) {
  const n = String(perfil ?? '').normalize('NFC').replace(/[^\p{L}\p{M}\s'.-]/gu, ' ').replace(/\s+/g, ' ').trim();
  return n.replace(/[^\p{L}]/gu, '').length >= 2 ? n.slice(0, 60) : '';
}
