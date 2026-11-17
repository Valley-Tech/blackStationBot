/**
 * Memoria de la conversación (v3.9) — lo que el cliente dijo y lo que el bot le mostró
 * durante el TURNO de hoy, para no volver a preguntar lo que ya se sabe.
 *
 * Dos partes por cliente (vive en su sesión, sesiones.js):
 *   · mensajes: el historial del turno (cliente y bot, en texto; las tarjetas, botones y
 *     carritos se guardan como "[Bot mostró: …]"). Se le pasa a la IA del CRM en cada
 *     pregunta (como el chatHistory del bot anterior), así la IA sabe qué se habló hoy,
 *     incluidos los carruseles y botones que el historial del CRM no ve.
 *   · datos: lo que el cliente ya decidió: medio de pago, si recoge o es a domicilio,
 *     dirección, nombre, y de su pizza (sabor, tamaño, "un solo sabor" o combinada).
 *
 * ¿Cuánto dura? Todo el turno de atención: desde que el cliente escribe (aunque sea antes de
 * abrir) hasta HORA_CIERRE más una gracia de MEMORIA_GRACIA_MIN (60 min por defecto, para
 * pedidos que se cierran tarde). Lo que escriba después de esa hora ya cuenta para el turno
 * del día siguiente, que empieza en blanco.
 *
 * Límite: está en la memoria del servidor. Si Railway reinicia o despliegas durante el
 * servicio, se pierde (igual que los pedidos a medio hacer): despliega fuera del horario.
 */
import config from '../config/env.js';
import negocio from '../config/negocio.js';
import { obtenerSesion, sesion } from './sesiones.js';
import { turnoActual } from './conversacion.js';

const MAX_MENSAJES = Number(process.env.MEMORIA_MAX_MENSAJES) || 40;
const GRACIA_MS = (Number(process.env.MEMORIA_GRACIA_MIN ?? 60) || 0) * 60000;

/**
 * Turno al que pertenece este momento ("2026-11-17"): el de ahora, el que acaba de cerrar
 * (dentro de la gracia) o, fuera de horario, el próximo turno (el de hoy en Colombia).
 */
export function turnoDeMemoria(ahora = new Date()) {
  const t = turnoActual(ahora) ?? (GRACIA_MS ? turnoActual(new Date(ahora.getTime() - GRACIA_MS)) : null);
  return t ?? new Date(ahora.getTime() - 5 * 3600 * 1000).toISOString().slice(0, 10);
}

function nueva(ahora) {
  return { turno: turnoDeMemoria(new Date(ahora)), desde: ahora, at: ahora, mensajes: [], datos: { pizzasOk: [] } };
}

/** Memoria del cliente (la crea si no existe; la reinicia si cambió el turno o venció). */
export function memoria(numero, ahora = Date.now()) {
  const s = sesion(numero);
  if (!s) return null;
  const m = s.memoria;
  const turno = turnoDeMemoria(new Date(ahora));
  const vencida = !m || m.turno !== turno;
  if (vencida) s.memoria = nueva(ahora);
  s.memoria.at = ahora;
  return s.memoria;
}

/** Memoria sin crearla (para leer). */
export function verMemoria(numero) {
  const m = obtenerSesion(numero)?.memoria;
  if (!m) return null;
  return m.turno === turnoDeMemoria() ? m : null;
}

/** Datos que el cliente ya decidió hoy (o {}). */
export const datosDe = (numero) => verMemoria(numero)?.datos ?? {};

/** Guarda datos ({ pago: 'Transferencia', entrega: 'restaurante', … }); los vacíos no borran. */
export function recordar(numero, datos) {
  const m = memoria(numero);
  if (!m) return {};
  for (const [k, v] of Object.entries(datos ?? {})) if (v !== undefined && v !== null && v !== '') m.datos[k] = v;
  return m.datos;
}

/** Olvida un dato ("pizza" cuando ya se agregó, por ejemplo). */
export function olvidar(numero, ...claves) {
  const m = verMemoria(numero);
  if (m) for (const k of claves) delete m.datos[k];
}

/** Anota un mensaje en el historial del turno. rol: 'user' (cliente) | 'model' (bot). */
export function anotar(numero, rol, texto) {
  const t = String(texto ?? '').trim();
  if (!numero || !t) return;
  const m = memoria(numero);
  if (!m) return;
  const ultimo = m.mensajes[m.mensajes.length - 1];
  if (ultimo && ultimo.rol === rol && ultimo.texto === t && Date.now() - ultimo.at < 5000) return; // duplicado inmediato
  m.mensajes.push({ rol, texto: t.slice(0, 1500), at: Date.now() });
  if (m.mensajes.length > MAX_MENSAJES) m.mensajes.splice(0, m.mensajes.length - MAX_MENSAJES);
}

// ---------------------------------------------------------------------------
//  Mensajes de WhatsApp → texto para la memoria
// ---------------------------------------------------------------------------

let nombreProducto = (id) => id;
/** El messageHandler registra cómo se llaman los productos (para "[Bot mostró: Pizza Hawaiana…]"). */
export function usarNombres(fn) { nombreProducto = fn; }

/** Lo que envió el bot, en texto (o null si no vale la pena guardarlo: "leído", reacciones…). */
export function textoSaliente(data) {
  if (!data || data.status === 'read') return null;
  if (data.text?.body) return data.text.body;
  const i = data.interactive;
  if (data.type === 'interactive' && i) {
    const cuerpo = i.body?.text ? `${i.body.text}\n` : '';
    if (i.type === 'button') return `${cuerpo}[Botones: ${(i.action?.buttons ?? []).map((b) => b.reply?.title).join(' / ')}]`;
    if (i.type === 'list') return `${cuerpo}[Lista: ${(i.action?.sections ?? []).flatMap((s) => (s.rows ?? []).map((r) => r.title)).slice(0, 12).join(' / ')}]`;
    if (i.type === 'product') return `[Bot mostró el producto: ${nombreProducto(i.action?.product_retailer_id)}]`;
    if (i.type === 'carousel') return `[Bot mostró un carrusel con: ${(i.action?.cards ?? []).map((c) => nombreProducto(c.action?.product_retailer_id)).join(', ')}]`;
    if (i.type === 'product_list') return `[Bot mostró la carta: ${i.header?.text ?? 'productos'}]`;
    if (i.type === 'flow') return '[Bot envió el formulario de datos del pedido]';
    return cuerpo || null;
  }
  if (data.type === 'template') return `[Plantilla ${data.template?.name ?? ''}]`;
  if (['image', 'document'].includes(data.type)) return `[Bot envió ${data.type === 'image' ? 'una imagen' : 'un documento'}${data[data.type]?.caption ? `: ${data[data.type].caption}` : ''}]`;
  if (data.type === 'location') return '[Bot envió la ubicación del restaurante]';
  if (data.type === 'contacts') return '[Bot envió el contacto del restaurante]';
  return null;
}

/** Lo que mandó el cliente, en texto. */
export function textoEntrante(message) {
  if (!message) return null;
  if (message.type === 'text') return message.text?.body ?? null;
  const i = message.interactive;
  if (message.type === 'interactive') {
    if (i?.type === 'button_reply') return `[Tocó el botón: ${i.button_reply?.title ?? i.button_reply?.id}]`;
    if (i?.type === 'list_reply') return `[Eligió: ${i.list_reply?.title ?? i.list_reply?.id}]`;
    if (i?.type === 'nfm_reply') return '[Llenó el formulario del pedido]';
  }
  if (message.type === 'order') {
    const items = (message.order?.product_items ?? []).map((p) => `${nombreProducto(p.product_retailer_id)} x${p.quantity}`);
    return `[Envió el carrito: ${items.join(', ')}]`;
  }
  if (message.type === 'image') return '[Envió una imagen]';
  if (message.type === 'audio') return '[Envió un audio]';
  if (message.type === 'location') return '[Envió su ubicación]';
  return null;
}

/** Registra lo que envía el bot (lo llama sendToWhatsApp). Nunca lanza. */
export function registrarSalida(to, data) {
  try { anotar(to, 'model', textoSaliente(data)); } catch { /* la memoria nunca frena un envío */ }
}

// ---------------------------------------------------------------------------
//  Historial para la IA del CRM (POST /ai/reply acepta `history`)
// ---------------------------------------------------------------------------

const ETIQUETA_PAGO = { Efectivo: 'efectivo', Transferencia: 'transferencia', 'Codigo QR': 'código QR', PSE: 'PSE (link de pago)' };

/** Resumen de lo que ya se sabe del cliente (para que la IA no lo vuelva a preguntar). */
export function resumenDatos(numero) {
  const d = datosDe(numero);
  const partes = [];
  if (d.pago) partes.push(`paga con ${ETIQUETA_PAGO[d.pago] ?? d.pago}`);
  if (d.entrega === 'restaurante') partes.push('recoge en el restaurante');
  if (d.entrega === 'domicilio') partes.push(`es a domicilio${d.direccion ? ` (${d.direccion})` : ''}`);
  else if (d.direccion) partes.push(`dirección: ${d.direccion}`);
  if (d.pizza?.sabor && !d.pizza.agregada) partes.push(`pizza ${d.pizza.sabor}${d.pizza.tamano ? ` de ${d.pizza.tamano} porciones` : ''}${d.pizza.decision === 'uno' ? ' de un solo sabor' : d.pizza.decision === 'combinar' ? ' combinada' : ''}`);
  const s = obtenerSesion(numero);
  const estado = { confirmar: 'sin confirmar', datos: 'confirmado, falta llenar el formulario', enviado: 'ya enviado al restaurante' }[s?.pedido?.estado];
  if (s?.pedidoStr && estado) partes.push(`pedido: ${s.pedidoStr.replace(/\n/g, ', ')} (${estado}; subtotal $${Number(s.datosPedido?.monto || 0).toLocaleString('es-CO')})`);
  return partes.join('; ');
}

/**
 * Historial del turno para la IA: [{ role: 'user'|'model', text }], sin el mensaje actual.
 * Empieza con una nota de contexto (lo que ya sabemos del cliente) para que la IA sea coherente.
 * Devuelve null si no hay nada que aportar (el CRM usa entonces su propio historial).
 */
export function historialParaIA(numero, textoActual = '') {
  const m = verMemoria(numero);
  if (!m || !config.MEMORIA_IA) return null;
  const msgs = [...m.mensajes];
  const ultimo = msgs[msgs.length - 1];
  if (ultimo?.rol === 'user' && ultimo.texto.trim() === String(textoActual).trim()) msgs.pop();
  const history = msgs.slice(-30).map((x) => ({ role: x.rol, text: x.texto }));
  const resumen = resumenDatos(numero);
  if (resumen) {
    history.unshift(
      { role: 'user', text: `[Nota del sistema de ${negocio.nombre}, no es del cliente: datos que el cliente ya dio hoy → ${resumen}. No se los vuelvas a preguntar; si pregunta por su pedido o el pago, tenlos en cuenta.]` },
      { role: 'model', text: 'Entendido.' },
    );
  }
  return history.length ? history.slice(-40) : null;
}
