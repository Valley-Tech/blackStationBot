/**
 * Datos del negocio que usa el chatbot. Lo marcado con ⚠️ hay que confirmarlo
 * con el restaurante antes de salir a producción.
 */
import config from './env.js';

export default {
  nombre: 'La Estación Parrilla Bar',
  marcas: "La Estación Parrilla Bar · Black's Pizza · Heladería Yellow",
  bienvenida: '*La Estación Parrilla Bar* 🔥🍖\n🍕 *Black\'s Pizza*  ·  🍨 *Heladería Yellow*',

  // Horario de atención del chatbot para pedidos (hora Colombia). ⚠️ confirmar.
  horario: { apertura: config.HORA_APERTURA, cierre: config.HORA_CIERRE },
  horarioTexto: () => `todos los días de *${fmtHora(config.HORA_APERTURA)}* a *${fmtHora(config.HORA_CIERRE)}*`,

  // Valor del domicilio que se suma al pedido. ⚠️ confirmar (Samuelito cobra $3.000).
  domicilio: config.DOMICILIO_VALOR,

  // Números que reciben el aviso de pedido/reserva (plantillas). Variable NOTIFY_NUMBERS.
  numerosOficiales: config.NOTIFY_NUMBERS,

  // Líneas de domicilios impresas en las cartas.
  telefonos: { parrilla: '573224993245', pizzeria: '573113509246' },

  // Cuentas para transferencia. ⚠️ completar con las del restaurante.
  cuentasBancarias: '🏦Cuentas bancarias:\n\n*Bancolombia Ahorros:* 70400023806 - Jorge Ariza',

  // Ubicación. Dirección del RUT; las coordenadas van en Railway (UBICACION_LAT y UBICACION_LNG):
  // Google Maps → clic derecho sobre el local → clic en los números (se copian "lat, lng").
  // Sin coordenadas se manda la dirección con el enlace de Google Maps.
  ubicacion: {
    latitude: numeroONull(process.env.UBICACION_LAT),
    longitude: numeroONull(process.env.UBICACION_LNG),
    name: 'La Estación Parrilla Bar',
    address: process.env.UBICACION_DIRECCION || 'Calle 10A # 10-80, Centro, La Loma, El Paso, Cesar',
  },

  // Cartas en PDF (súbelas a S3 o a cualquier URL pública). Si la URL está vacía, no se envía.
  cartas: [
    { url: process.env.CARTA_PARRILLA_URL || '', filename: 'Carta-La-Estacion-Parrilla.pdf', caption: '🔥 Carta La Estación Parrilla Bar' },
    { url: process.env.CARTA_PIZZERIA_URL || '', filename: 'Carta-Blacks-Pizza.pdf', caption: "🍕 Carta Black's Pizza" },
    { url: process.env.CARTA_HELADERIA_URL || '', filename: 'Carta-Heladeria-Yellow.pdf', caption: '🍨 Carta Heladería Yellow' },
  ],

  // Imágenes del encabezado de las plantillas de aviso (URL pública).
  imagenPedido: process.env.IMAGEN_PEDIDO_URL || 'https://micarta.s3.us-east-1.amazonaws.com/Copia+de+Reserva+tu+mesa.jpg',
  imagenReserva: process.env.IMAGEN_RESERVA_URL || 'https://micarta.s3.us-east-1.amazonaws.com/confirmacion_reserva.jpeg',
  imagenEvento: process.env.IMAGEN_EVENTO_URL || '',

  // Tarjeta de contacto (escribir "asesor").
  contacto: {
    name: { formatted_name: 'La Estación Parrilla Bar', first_name: 'La Estación', last_name: 'Parrilla Bar' },
    org: { company: 'La Estación Parrilla Bar', department: 'Atención al Cliente', title: 'Domicilios' },
    phones: [
      { phone: '+573224993245', wa_id: '573224993245', type: 'WORK' },
      { phone: '+573113509246', wa_id: '573113509246', type: 'WORK' },
    ],
  },
};

function numeroONull(v) {
  const n = Number(String(v ?? '').trim().replace(',', '.'));
  return String(v ?? '').trim() && Number.isFinite(n) ? n : null;
}

function fmtHora(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  const ampm = h >= 12 ? 'p.m.' : 'a.m.';
  const h12 = h % 12 || 12;
  return `${h12}:${String(m || 0).padStart(2, '0')} ${ampm}`;
}
