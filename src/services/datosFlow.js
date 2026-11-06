/**
 * Lectura de los datos que llegan de los Flows (pedido y reserva), en un solo lugar.
 * flow.js, flowReserva.js y messageHandler.js usan estas funciones para que el
 * resumen del Flow, el aviso al negocio, Wompi, Google Sheets y Loggro digan siempre lo mismo.
 */
import negocio from '../config/negocio.js';

const norm = (v) => String(v ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

// ---------------------------------------------------------------------------
//  Pedido: domicilio o recoger en el restaurante
// ---------------------------------------------------------------------------

/**
 * ¿El cliente pidió a domicilio?
 * El Flow de pedido manda "address" (RadioButtons "Tu pedido es para:") con el id
 * "domicilio" o "restaurante". Si algún día vuelve a llegar una dirección escrita
 * (Flow viejo), también cuenta como domicilio.
 */
export function esDomicilio(datos) {
  const v = norm(datos?.address ?? datos?.paradonde);
  if (!v || v === 'restaurante') return false;
  return true; // "domicilio" o una dirección escrita
}

/** Valor del domicilio que se suma al total (0 si recoge en el restaurante). */
export const valorDomicilio = (datos) => (esDomicilio(datos) ? Number(negocio.domicilio) || 0 : 0);

/** Texto para el aviso al negocio, Sheets y Loggro: "Domicilio" o "Recoger en el restaurante". */
export function entregaTexto(datos) {
  if (!esDomicilio(datos)) return 'Recoger en el restaurante';
  const v = String(datos?.address ?? '').trim();
  // Si el Flow trae una dirección escrita (campo "direccion" o el address viejo), se muestra.
  const direccion = datos?.direccion || (norm(v) !== 'domicilio' ? v : '');
  return direccion ? `Domicilio: ${direccion}` : 'Domicilio';
}

// ---------------------------------------------------------------------------
//  Reserva
// ---------------------------------------------------------------------------

/** Hora de la reserva según el motivo (cada motivo usa su propio campo en el Flow). */
export function horaReserva(d) {
  const e = norm(d?.evento);
  const porEvento = e === 'reserva normal' ? d.horanormal
    : e === 'celebracion' || e === 'cumpleanos' ? d.horario
    : e === 'festival gastronomico' ? d.hora
    : undefined;
  return porEvento || d?.horanormal || d?.horario || d?.hora || '';
}

/** Fecha de la reserva (hoy el Flow usa "fecha" para todos los motivos). */
export function fechaReserva(d) {
  return d?.fecha || d?.fechanormal || d?.fechafestival || '';
}

/**
 * Variables de la plantilla confirmacion_reserva, en el orden del cuerpo aprobado:
 * {{1}} Nombre · {{2}} Celular · {{3}} Motivo · {{4}} Fecha · {{5}} Hora · {{6}} Cuántas personas.
 * Si cambias la plantilla en WhatsApp Manager, cambia también esta lista (mismo número y orden).
 */
export function variablesReserva(d) {
  return [d?.nombre, d?.celular, d?.evento, fechaReserva(d), horaReserva(d), d?.cuantos];
}
