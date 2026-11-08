/**
 * Reglas de conversación (v3.5): que el bot responda con coherencia y no se
 * "reinicie" cuando el cliente escribe "hola" o "gracias" a mitad de un pedido.
 *
 *  · Turno del día: la bienvenida sale UNA vez por cliente en cada turno
 *    (HORA_APERTURA → HORA_CIERRE; con 16:00 → 00:00 el turno del sábado va del
 *    sábado 4:00 p. m. al domingo 12:00 a. m.).
 *  · "Hola, ¿se demora mucho?" → se quita el saludo y se atiende la pregunta.
 *  · "gracias", "ok", "listo" → respuesta corta, nunca la bienvenida.
 */
import negocio from '../config/negocio.js';

/** Minúsculas, sin tildes ni signos repetidos. */
export const normalizar = (t) => String(t ?? '')
  .toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/\s+/g, ' ')
  .trim();

const minutos = (hhmm) => { const [h, m] = String(hhmm ?? '').split(':').map(Number); return (h || 0) * 60 + (m || 0); };

/** Hora de Colombia (UTC-5, sin horario de verano) en minutos desde la medianoche, y la fecha. */
function horaColombia(ahora = new Date()) {
  const co = new Date(ahora.getTime() - 5 * 3600 * 1000);
  return { co, actual: co.getUTCHours() * 60 + co.getUTCMinutes() };
}

/** ¿Estamos dentro del horario de atención? Soporta horarios que pasan la medianoche (16:00 → 00:00). */
export function dentroDeHorario(ahora = new Date()) {
  return turnoActual(ahora) !== null;
}

/**
 * Identificador del turno actual ("2026-11-07"), o null si estamos fuera de horario.
 * Si el turno pasa la medianoche, la madrugada pertenece al turno del día anterior.
 */
export function turnoActual(ahora = new Date()) {
  const { co, actual } = horaColombia(ahora);
  const ap = minutos(negocio.horario.apertura);
  const ci = minutos(negocio.horario.cierre);
  const dentro = ci > ap ? actual >= ap && actual < ci : actual >= ap || actual < ci;
  if (!dentro) return null;
  const dia = ci <= ap && actual < ci ? new Date(co.getTime() - 86400000) : co;
  return dia.toISOString().slice(0, 10);
}

// Saludos al INICIO del mensaje (por palabras completas).
const SALUDO = /^(hola+|holi+s?|ola|hello|hi|hey|buenas?( (tardes|noches|dias))?|buen(os)? dias?|saludos|que mas|q mas|como (estas|esta|estan|vas|va)|alo)\b[\s,.!¡¿?:;-]*/;

/**
 * Separa el saludo del resto: "Hola buenas noches, ¿se demora mucho?" →
 * { saludo: true, resto: "¿se demora mucho?" }.
 */
export function separarSaludo(texto) {
  const original = String(texto ?? '').trim();
  let t = normalizar(original).replace(/^[¡!¿?.\s]+/, '');
  let saludo = false;
  for (let i = 0; i < 3; i += 1) { // "hola buenas noches como estas"
    const m = t.match(SALUDO);
    if (!m) break;
    saludo = true;
    t = t.slice(m[0].length).trim();
  }
  if (!saludo) return { saludo: false, resto: original };
  // Se devuelve el resto con sus tildes (tomado del final del original).
  const resto = t ? original.slice(Math.max(0, original.length - t.length)).trim() : '';
  return { saludo: true, resto: normalizar(resto) === t ? resto : t };
}

/** Mensajes de cortesía que NO deben reiniciar la conversación. */
const CORTESIA = /^(muchas |mil )?(gracias|grax|gracia|ok+|oka+y|oki|okis|listo|perfecto|dale|vale|bueno|bien|genial|excelente|super|chevere|de una|entendido|claro|si senor|si señor|ya|👍|🙏|👌|😊|🙂)( (gracias|muchas gracias|bueno|listo|perfecto|ok))?[\s!.]*$/;
export const esCortesia = (texto) => CORTESIA.test(normalizar(texto)) || /^[\p{Extended_Pictographic}\s]+$/u.test(String(texto ?? '').trim());

export const esCancelar = (texto) => /^(cancelar|cancela|cancelo|anular|ya no( lo)? quiero|no quiero (el|mi) pedido|cancelar (el |mi )?pedido)[\s!.]*$/.test(normalizar(texto));

/**
 * Preguntas generales (tiempos, horario, pagos, domicilio, estado del pedido):
 * van a la IA aunque mencionen un plato ("para una pizza mediana ¿cuánto se demora?").
 */
export const esPreguntaGeneral = (texto) => /\b(demora|demoran|tarda|tardan|falta|llega|llegan|tiempo|minutos|ya viene|ya va|abren|abierto|abiertos|cierran|horario|servicio|ubicad|direccion|nequi|daviplata|transferencia|qr|cuenta|pagar|pago|cuanto (vale|cuesta) el domicilio|mi pedido|reserv)/.test(normalizar(texto));

/** "Quiero pedir", "para un domicilio": intención de pedir sin nombrar un plato. */
export const quierePedirGenerico = (texto) => /\b(pedir|pedido|ordenar|orden|domicilio|comprar|menu del dia)\b/.test(normalizar(texto)) && !/\bmi pedido\b/.test(normalizar(texto));

/** Cantidad pedida: "me regalas 3 salchipapas" → 3. */
const NUMEROS = { un: 1, una: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10 };
export function cantidadPedida(texto) {
  const t = normalizar(texto);
  const d = t.match(/\b(\d{1,2})\b(?!\s*(porciones|porcion|oz|ml|cm|litros?|lt|gr|g|k|mil))/);
  if (d) return Number(d[1]);
  const w = t.match(/\b(dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)\b/);
  return w ? NUMEROS[w[1]] : null;
}
