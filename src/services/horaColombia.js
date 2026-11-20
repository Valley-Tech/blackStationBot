/**
 * Fecha y hora de Colombia (v3.10) — para que el bot y la IA sepan QUÉ HORA ES.
 *
 * Caso real: una clienta escribió "¿Hay servicio?" a las 11:52 p. m., ya cerrado, y la IA
 * le respondió "¡Sí! Atendemos todos los días de 4:00 p.m. a 11:30 p.m.": la IA no sabe la
 * hora. Ahora:
 *   · "¿hay servicio?", "¿están abiertos?", "¿a qué hora cierran?" → respuesta directa del bot
 *     con la hora real (respuestaServicio), sin pasar por la IA.
 *   · Cualquier otra pregunta a la IA lleva una nota con la fecha, la hora y si el restaurante
 *     está ABIERTO o CERRADO en este momento (notaFechaHora → geminiService).
 *
 * Zona horaria: America/Bogota (UTC-5, Colombia no usa horario de verano).
 */
import negocio from '../config/negocio.js';
import { normalizar } from './conversacion.js';

const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const minutos = (hhmm) => { const [h, m] = String(hhmm ?? '').split(':').map(Number); return (h || 0) * 60 + (m || 0); };

/** "16:00" → "4:00 p.m." (mismo formato de negocio.horarioTexto). */
export function hora12(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return `${(h % 12) || 12}:${String(m || 0).padStart(2, '0')} ${h >= 12 ? 'p.m.' : 'a.m.'}`;
}

/**
 * Estado del restaurante ahora mismo (hora Colombia).
 * @returns {{ fecha, hora, dia, abierto, apertura, cierre, reabre: 'hoy'|'mañana', diaReabre, cierraEnMin }}
 */
export function estadoHorario(ahora = new Date()) {
  const co = new Date(ahora.getTime() - 5 * 3600 * 1000); // los getUTC* de co son la hora de Bogotá
  const actual = co.getUTCHours() * 60 + co.getUTCMinutes();
  const ap = minutos(negocio.horario.apertura);
  const ci = minutos(negocio.horario.cierre);
  const pasaMedianoche = ci <= ap;
  const abierto = pasaMedianoche ? actual >= ap || actual < ci : actual >= ap && actual < ci;
  const dia = co.getUTCDay();
  // Cerrado: ¿abre más tarde hoy o mañana?
  const reabre = actual < ap ? 'hoy' : 'mañana';
  let cierraEnMin = null;
  if (abierto) cierraEnMin = (ci - actual + 1440) % 1440 || 1440;
  return {
    fecha: `${DIAS[dia]} ${co.getUTCDate()} de ${MESES[co.getUTCMonth()]} de ${co.getUTCFullYear()}`,
    hora: `${(co.getUTCHours() % 12) || 12}:${String(co.getUTCMinutes()).padStart(2, '0')} ${co.getUTCHours() >= 12 ? 'p. m.' : 'a. m.'}`,
    dia: DIAS[dia],
    abierto,
    apertura: hora12(negocio.horario.apertura),
    cierre: hora12(negocio.horario.cierre),
    reabre,
    diaReabre: reabre === 'hoy' ? DIAS[dia] : DIAS[(dia + 1) % 7],
    cierraEnMin,
  };
}

/** Nota para la IA del CRM con la fecha, la hora y si estamos abiertos (va en el historial). */
export function notaFechaHora(ahora = new Date()) {
  const e = estadoHorario(ahora);
  const estado = e.abierto
    ? `En este momento estamos ABIERTOS (cerramos a las ${e.cierre}${e.cierraEnMin <= 90 ? `, en ${e.cierraEnMin} minutos` : ''}).`
    : `En este momento estamos CERRADOS: volvemos a abrir ${e.reabre} ${e.diaReabre} a las ${e.apertura}. Si pregunta si hay servicio, si están abiertos o si puede pedir ahora, dile que ya cerramos y cuándo abrimos; NO digas que estamos abiertos.`;
  return `[Nota del sistema de ${negocio.nombre}, no es del cliente: fecha y hora actual en Colombia (Bogotá, UTC-5): ${e.fecha}, ${e.hora}. Horario de atención: todos los días de ${e.apertura} a ${e.cierre}. ${estado} Usa esta fecha y hora para "hoy", "mañana", "ahorita" y "esta noche".]`;
}

/**
 * ¿Pregunta si están atendiendo? "¿Hay servicio?", "La estación está en servicio aún?",
 * "¿están abiertos?", "¿todavía atienden?", "¿a qué hora cierran?", "¿ya abrieron?".
 * No cuenta "¿hay servicio a domicilio?" (eso lo responde la IA) ni frases largas.
 */
export function esPreguntaDeServicio(texto) {
  const t = normalizar(texto).replace(/[¿?¡!.,]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t || t.split(' ').length > 12) return false;
  if (/\b(domicilio|domicilios|envio|envios|delivery|mi pedido|el pedido|reserva)\b/.test(t)) return false;
  return /\b(hay servicio|habra servicio|tienen servicio|en servicio|prestando servicio|atendiendo|estan abiertos?|esta abiert[oa]|siguen abiertos?|sigue abiert[oa]|ya abrieron|ya abrio|abren hoy|abrieron hoy|estan trabajando|todavia (atienden|abren|hay|estan)|aun (atienden|hay|estan)|atienden (hoy|ahora|todavia|aun|ya|a esta hora)|a que horas? (abren|cierran|abre|cierra)|hasta que horas? (atienden|abren|estan|cierran|hay)|hora de cierre|cierran a que hora|ya cerraron|ya cerro|estan cerrados?)\b/.test(t);
}

/** Respuesta directa a "¿hay servicio?" con la hora real. */
export function respuestaServicio(ahora = new Date()) {
  const e = estadoHorario(ahora);
  if (e.abierto) {
    const pronto = e.cierraEnMin <= 60 ? ` (en ${e.cierraEnMin} minutos)` : '';
    return `¡Sí! Estamos atendiendo hasta las *${e.cierre}*${pronto} 😊\n¿Qué te gustaría pedir?`;
  }
  return `🌙 En este momento (${e.hora}) ya estamos cerrados.\nTe atendemos ${negocio.horarioTexto()}: volvemos a abrir *${e.reabre}* a las *${e.apertura}* 😊`;
}
