import { askAi } from './crmAdapter.js';
import { historialParaIA } from './memoria.js';

/**
 * IA del chatbot — misma lógica que Mishabella (v2.12).
 *
 * El bot ya NO llama a Gemini con su propia clave ni lleva el contexto del
 * negocio "quemado" en este archivo. Toda la inteligencia vive en el CRM
 * (Chatbots → IA y conocimiento): instrucciones, preguntas frecuentes,
 * archivos (PDF del menú, listas de precios…), sitio web rastreado, proveedor
 * (Gemini o Claude) y el historial del chat. El CRM responde solo si la IA de
 * ESTE chatbot está activa y con conocimiento cargado; si no, devuelve null y
 * el bot contesta con su menú de siempre.
 *
 * Uso (misma firma que antes, más el teléfono del cliente):
 *   const texto = await geminiService(mensaje, to);
 *   response = texto ?? FALLBACK_MENU;
 *
 * Variables del bot: CRM_BASE_URL, CRM_API_KEY (ya las usa el adaptador).
 * GEMINI_API_KEY ya no hace falta en el bot.
 */

/** Texto cuando la IA no está disponible (apagada / sin conocimiento / CRM caído). */
export const AI_UNAVAILABLE = 'Por ahora no puedo responder preguntas libres 🙈. Elige una opción del menú o escribe *Asesor* y una persona te atiende.';

/**
 * @param {string} message  Texto del cliente.
 * @param {string} to       Número del cliente (wa_id). Sin él el CRM no puede
 *                          ubicar la conversación ni su historial.
 * @returns {Promise<string|null>} Respuesta lista para WhatsApp, o null.
 */
const geminiService = async (message, to) => {
  const text = String(message ?? '').trim();
  if (!text) return null;
  if (!to) {
    console.warn('[ia] geminiService(mensaje, to): falta el número del cliente; el CRM no puede responder sin él');
    return null;
  }
  try {
    // v3.9: la IA recibe la memoria del turno (lo que se habló hoy, tarjetas y botones incluidos,
    // y los datos que el cliente ya dio). Sin memoria, el CRM usa su historial de siempre.
    return await askAi(to, text, { history: historialParaIA(to, text) });
  } catch (error) {
    console.error('[ia] error pidiendo la respuesta al CRM:', error.message);
    return null;
  }
};

export default geminiService;
