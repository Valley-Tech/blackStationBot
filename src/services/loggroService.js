import axios from "axios";
import { reportarFalla } from "./reportarFallas.js";

const LOGGRO_API_URL = "https://api.pirpos.com/orders";
const LOGGRO_API_KEY = process.env.LOGGRO_API_KEY; // Guarda tu API KEY en .env / Railway

/**
 * Envía la comanda a Loggro POS (Pirpos).
 * Nunca lanza: en SamuelitoBot se llamaba sin await y un error de Loggro quedaba
 * como promesa rechazada sin capturar (en Node 20 eso puede tumbar el proceso).
 * Devuelve la respuesta de Loggro o null si no se pudo.
 */
export async function enviarPedidoALoggro(pedido) {
  if (!LOGGRO_API_KEY) {
    console.warn('[loggro] LOGGRO_API_KEY vacío: el pedido no se envía a Loggro.');
    return null;
  }
  if (!pedido?.table) {
    console.warn('[loggro] LOGGRO_TABLE_ID vacío: Loggro necesita la mesa donde se registra el pedido. No se envía.');
    reportarFalla(new Error('LOGGRO_TABLE_ID vacío: el pedido no se envió a Loggro'), { level: 'warning', step: 'enviar el pedido a Loggro' });
    return null;
  }
  try {
    const response = await axios.post(
      LOGGRO_API_URL,
      pedido,
      {
        headers: {
          "Authorization": `Bearer ${LOGGRO_API_KEY}`,
          "Content-Type": "application/json"
        },
        timeout: 15000,
      }
    );
    return response.data;
  } catch (error) {
    console.error("Error enviando pedido a Loggro:", JSON.stringify(error.response?.data ?? error.message));
    // v3.4: el pedido no quedó en el POS. Se reporta con la respuesta de Loggro para saber por qué.
    reportarFalla(Object.assign(new Error(`Loggro no recibió el pedido: ${error.response ? `HTTP ${error.response.status}` : error.message}`), { stack: error.stack }), {
      step: 'enviar el pedido a Loggro', respuestaLoggro: JSON.stringify(error.response?.data ?? '').slice(0, 800), productos: pedido?.orders?.length, cliente: String(pedido?.groupName ?? "").split("\n")[0],
    });
    return null;
  }
}
