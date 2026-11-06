/**
 * Reporte de fallas al CRM ValleyTech (v3.4).
 *
 * Antes, cuando el bot fallaba (un TypeError, un envío que Meta rechazó…), el
 * error solo quedaba en el log de Railway y nadie se enteraba de que el cliente
 * se quedó sin respuesta. Con este módulo la falla llega al CRM:
 *   · aparece en la Bandeja, dentro del chat del cliente, con el log y el mensaje que no salió
 *   · y en Analítica → Fallas (IA), con la causa raíz y los pasos para arreglarla.
 *
 * Usa las mismas variables que el adaptador del CRM (CRM_BASE_URL y CRM_API_KEY).
 * Nunca lanza ni frena al bot: si el CRM no responde, solo deja un aviso en el log.
 *
 *   import { reportarFalla, instalarCapturaGlobal } from './services/reportarFallas.js';
 *   instalarCapturaGlobal();                                   // una vez, en app.js
 *   reportarFalla(error, { to: message.from, waMessageId: message.id, step: 'respFlow' });
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import axios from 'axios';

const CRM_BASE_URL = (process.env.CRM_BASE_URL || '').replace(/\/$/, '');
const CRM_API_KEY = process.env.CRM_API_KEY;
const PHONE_NUMBER_ID = process.env.CRM_PHONE_NUMBER_ID || process.env.BUSINESS_PHONE || undefined;
const enabled = Boolean(CRM_BASE_URL && CRM_API_KEY) && !/^(0|false|no)$/i.test(process.env.CRM_REPORTAR_FALLAS || 'true');

const crm = axios.create({
  baseURL: `${CRM_BASE_URL}/api/v1/bot`,
  timeout: 8000,
  headers: { 'X-Bot-Key': CRM_API_KEY, 'Content-Type': 'application/json' },
});

const ROOT = process.cwd();

/** Primera línea del stack que es código del bot (no node_modules ni Node). */
function primerMarco(stack) {
  for (const line of String(stack || '').split('\n')) {
    const m = line.match(/\(?((?:file:\/\/)?\/[^()\s]+?\.(?:m?js|cjs)):(\d+):(\d+)\)?/);
    if (m && !/node_modules|node:internal/.test(m[1])) return { file: m[1].startsWith('file://') ? fileURLToPath(m[1]) : m[1], line: Number(m[2]), col: Number(m[3]) };
  }
  return null;
}

/** Las líneas de código alrededor del error (la que falló marcada con >). */
function fragmentoDeCodigo(stack) {
  try {
    const f = primerMarco(stack);
    if (!f || !f.file.startsWith(ROOT)) return undefined;
    const lines = fs.readFileSync(f.file, 'utf8').split('\n');
    const from = Math.max(1, f.line - 3);
    const to = Math.min(lines.length, f.line + 2);
    const out = [`${path.relative(ROOT, f.file)}:${f.line}`];
    for (let n = from; n <= to; n += 1) out.push(`${n === f.line ? '>' : ' '} ${String(n).padStart(4)} | ${lines[n - 1].slice(0, 220)}`);
    return out.join('\n');
  } catch {
    return undefined;
  }
}

/** Resumen del mensaje del cliente (para saber qué estaba atendiendo el bot). */
export function entradaDe(message) {
  if (!message) return undefined;
  const i = message.interactive;
  return {
    tipo: message.type,
    texto: message.text?.body?.slice(0, 300),
    boton: i?.button_reply?.id ?? i?.list_reply?.id,
    flow: i?.nfm_reply ? String(i.nfm_reply.response_json ?? '').slice(0, 600) : undefined,
    pedido: message.order ? `${message.order.product_items?.length ?? 0} producto(s)` : undefined,
  };
}

// Mismo error repetido en ráfaga (p. ej. un bucle): se reporta una vez cada 30 s.
const recientes = new Map();
function repetido(clave) {
  const ahora = Date.now();
  for (const [k, t] of recientes) if (ahora - t > 30_000) recientes.delete(k);
  if (recientes.has(clave)) return true;
  recientes.set(clave, ahora);
  return false;
}

/**
 * Reporta una falla al CRM.
 * @param {unknown} error   el error capturado
 * @param {object} contexto { to, waMessageId, conversationId, step, event, level, entrada, pendingMessage, ...otros datos }
 */
export async function reportarFalla(error, contexto = {}) {
  if (!enabled) return null;
  try {
    const err = error instanceof Error ? error : new Error(typeof error === 'string' ? error : JSON.stringify(error));

    // Un envío que el CRM rechazó ya quedó registrado en el CRM con el mensaje: no se duplica.
    if (err.config?.baseURL?.startsWith(CRM_BASE_URL) && err.response) return null;

    const { to, waMessageId, conversationId, step, event, level, pendingMessage, ...resto } = contexto;
    // Error de Meta (modo espejo): se usa el mensaje y el código de Meta, no el genérico de axios.
    const meta = err.response?.data?.error;
    const message = meta
      ? `${meta.message ?? 'Error de Meta'}${meta.error_data?.details ? ` · ${meta.error_data.details}` : ''}`
      : err.message || String(err);
    const code = meta?.code ?? (typeof err.code === 'string' || typeof err.code === 'number' ? err.code : undefined);

    if (repetido(`${to ?? '-'}|${message}|${primerMarco(err.stack)?.line ?? ''}`)) return null;

    const body = {
      message: String(message).slice(0, 2000),
      name: meta ? 'MetaError' : err.name,
      stack: String(err.stack || '').slice(0, 12000) || undefined,
      level: level === 'warning' ? 'warning' : 'error',
      code: code != null ? String(code).slice(0, 80) : undefined,
      to: to ? String(to) : undefined,
      conversationId,
      phoneNumberId: PHONE_NUMBER_ID,
      waMessageId,
      event,
      step,
      context: {
        ...resto,
        ...(err.response ? { http: err.response.status, url: err.config?.url } : {}),
        ...(meta?.error_subcode ? { subcodigo: meta.error_subcode } : {}),
      },
      pendingMessage,
      codeFrame: fragmentoDeCodigo(err.stack),
    };
    const { data } = await crm.post('/errors', JSON.parse(JSON.stringify(body)));
    return data;
  } catch (e) {
    console.warn('[crm] no se pudo reportar la falla al CRM:', e.response ? `${e.response.status} ${JSON.stringify(e.response.data)}` : e.message);
    return null;
  }
}

/**
 * Errores que nadie atrapó (promesas sin catch, excepciones sueltas): también
 * llegan al CRM. En una excepción no atrapada el proceso termina igual que antes
 * (Railway lo reinicia), pero primero se reporta.
 */
export function instalarCapturaGlobal() {
  if (globalThis.__vtCapturaFallas) return;
  globalThis.__vtCapturaFallas = true;
  process.on('unhandledRejection', (reason) => {
    console.error('[falla] promesa rechazada sin catch:', reason);
    reportarFalla(reason, { step: 'promesa sin catch (unhandledRejection)' });
  });
  process.on('uncaughtException', (err) => {
    console.error('[falla] excepción no atrapada:', err);
    const salir = () => process.exit(1);
    setTimeout(salir, 3000).unref();
    reportarFalla(err, { step: 'excepción no atrapada (el bot se reinicia)', level: 'error' }).finally(salir);
  });
}
