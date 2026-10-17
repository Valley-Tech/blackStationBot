/**
 * Estado de cada cliente (pedido, reserva y pantalla del Flow) guardado por número.
 *
 * En SamuelitoBot el pedido vivía en variables globales del controlador
 * (productos, datosPedido, pedidoStr, ventana…): si dos clientes pedían a la vez,
 * el segundo pisaba al primero y el /flow usaba el número del último que escribió.
 * Aquí cada cliente tiene su propia sesión y el Flow viaja con un flow_token que
 * dice de quién es ("pedido:<número>:<marca>").
 */
const TTL_MS = 6 * 60 * 60 * 1000; // 6 h sin actividad → se olvida
const sesiones = new Map();
let ultimoNumero = null; // respaldo si un Flow llega sin flow_token (Flows publicados antes de este cambio)

export function sesion(numero) {
  if (!numero) return null;
  limpiar();
  let s = sesiones.get(numero);
  if (!s) {
    s = { productos: [], pedidoStr: '', datosPedido: {}, datosReserva: null, ventana: null };
    sesiones.set(numero, s);
  }
  s.updatedAt = Date.now();
  ultimoNumero = numero;
  return s;
}

/** Empieza un pedido nuevo para ese número (borra el anterior). */
export function nuevoPedido(numero, { productos, pedidoStr, monto }) {
  const s = sesion(numero);
  s.productos = productos;
  s.pedidoStr = pedidoStr;
  s.datosPedido = { monto };
  s.ventana = null;
  return s;
}

export function tokenFlow(tipo, numero) {
  return `${tipo}:${numero}:${Date.now().toString(36)}`;
}

/** Número del cliente a partir del flow_token (o el último que escribió, como antes). */
export function numeroDeToken(token) {
  const partes = String(token ?? '').split(':');
  if (partes.length >= 2 && ['pedido', 'reserva', 'encuesta'].includes(partes[0]) && partes[1]) return partes[1];
  return ultimoNumero;
}

function limpiar() {
  if (sesiones.size < 500) return;
  const limite = Date.now() - TTL_MS;
  for (const [n, s] of sesiones) if (s.updatedAt < limite) sesiones.delete(n);
}
