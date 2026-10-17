import config from '../config/env.js';
import { decryptRequest, encryptResponse, FlowEndpointException } from "../services/encryption.js";
import { getNextScreen } from "../services/flow.js";
import { nextScreen } from "../services/flowReserva.js";
import { nextEncuesta } from "../services/flowEncuesta.js";
import messageHandler from '../services/messageHandler.js';
import crypto from "crypto";
import { CRM_MODE, forwardWebhook, toMetaMessage } from '../services/crmAdapter.js';
import { nombrePorId } from '../data/catalogo.js';
import { sesion, nuevoPedido, numeroDeToken } from '../services/sesiones.js';

const privateKey = config.PRIVATE_KEY;
function isRequestSignatureValid(req) {
  if(!config.APP_SECRET) {
    console.warn("App Secret is not set up. Please Add your app secret in /.env file to check for request validation");
    return true;
  }
  
  const signatureHeader = req.get("x-hub-signature-256");
  const signatureHeaderSha = signatureHeader.replace("sha256=", "");
  const signatureBuffer = Buffer.from(signatureHeaderSha, "utf-8");
  
  const hmac = crypto.createHmac("sha256", config.APP_SECRET);
  const digestString = hmac.update(req.rawBody).digest('hex');
  const digestBuffer = Buffer.from(digestString, "utf-8");

  if ( !crypto.timingSafeEqual(digestBuffer, signatureBuffer)) {
    return false;
  }
  return true;
}

// El pedido, la reserva y la pantalla del Flow ya no son variables globales:
// cada cliente tiene su sesión (services/sesiones.js), así dos pedidos a la vez no se mezclan.
// Mensajes ya atendidos (wamid → momento). Evita responder dos veces al mismo mensaje.
const SEEN_TTL_MS = 10 * 60 * 1000;
const seenMessages = new Map();
let gatewayWarned = false;
let mirrorWarned = false;

class WebhookController {  
  /**
   * Webhook de Meta (modo espejo). Se reenvía al CRM ANTES del filtro por
   * número para que el CRM vea también estados y eventos. Se responde 200
   * enseguida: Meta reintenta (y duplica) si el bot tarda en contestar.
   */
  async handleIncoming(req, res) {
    // Modo gateway: el CRM es el único que entrega mensajes (por /crm/events).
    // Si Meta sigue llamando aquí (la app propia del cliente aún suscrita a la
    // WABA), se acepta con 200 y se ignora: procesarlo duplicaría cada respuesta.
    if (CRM_MODE === 'gateway') {
      if (!gatewayWarned && req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.length) {
        gatewayWarned = true;
        console.warn('[webhook] Meta sigue enviando webhooks directos al bot en modo gateway: desuscribe la app propia de la WABA. Se ignoran para no duplicar respuestas.');
      }
      return res.sendStatus(200);
    }
    forwardWebhook(req.body); // sin await: no frena la respuesta a Meta

    const message = req.body.entry?.[0]?.changes[0]?.value?.messages?.[0];
    const recipientPhone = req.body.entry?.[0]?.changes[0]?.value?.metadata?.phone_number_id;

    // Solo responde si el mensaje es para el número de este bot
    if (recipientPhone !== process.env.BUSINESS_PHONE) {
      return res.sendStatus(200); // Ignora el mensaje
    }
    const senderInfo = req.body.entry?.[0]?.changes[0]?.value?.contacts?.[0];
    res.sendStatus(200);
    if (message) await this.dispatch(message, senderInfo);
  }

  /**
   * Evento del CRM (modo gateway): el CRM ya guardó el mensaje y comprobó que
   * el bot está activo en esa conversación. Se reconstruye el mensaje con el
   * formato de Meta y se entra por la misma lógica de siempre.
   */
  async handleCrmEvent(event) {
    if (event.event !== 'message.received' || !event.message) return;
    // Modo espejo: los mensajes ya llegan por el webhook de Meta; si además el
    // CRM los reenvía (chatbot registrado en el CRM), se ignoran aquí.
    if (CRM_MODE !== 'gateway') {
      if (!mirrorWarned) {
        mirrorWarned = true;
        console.warn('[crm] evento del CRM ignorado en modo espejo (CRM_MODE=mirror): en este modo responde solo al webhook de Meta. Para que el CRM entregue los mensajes pon CRM_MODE=gateway.');
      }
      return;
    }
    // Doble seguro: el CRM ya filtra por "Atiende", pero si BUSINESS_PHONE está definido solo se atiende ese número.
    if (process.env.BUSINESS_PHONE && event.integration?.phoneNumberId && event.integration.phoneNumberId !== process.env.BUSINESS_PHONE) return;
    const { message, senderInfo } = toMetaMessage(event);
    await this.dispatch(message, senderInfo);
  }

  /** La lógica original de handleIncoming, intacta, usada por los dos caminos. */
  async dispatch(message, senderInfo) {
    // Idempotencia: Meta reintenta si tardamos en responder y el CRM reintenta
    // si fallamos; un mismo wamid solo se atiende una vez (memoria de 10 min).
    if (message?.id) {
      if (seenMessages.has(message.id)) {
        console.warn('[webhook] mensaje repetido ignorado:', message.id);
        return;
      }
      seenMessages.set(message.id, Date.now());
      if (seenMessages.size > 5000) {
        const limit = Date.now() - SEEN_TTL_MS;
        for (const [id, at] of seenMessages) if (at < limit) seenMessages.delete(id);
      }
    }
    try {
      const s = sesion(message.from);
      if (message?.type === 'interactive' && message?.interactive.type === 'nfm_reply') {
        await messageHandler.handleIncomingMessage(message, senderInfo, s.ventana, s.datosReserva, s.datosPedido, s.pedidoStr);
      }
      else if (message?.type === 'order') {
        // product_names va NOMBRE → ID (data/catalogo.js). Para mostrar el nombre de
        // lo que llegó en el carrito se usa nombrePorId, que es la misma tabla al revés.
        const order = message.order;
        const productos = order.product_items ?? [];

        // Calcula el total usando reduce
        const precioTotal = productos.reduce((total, item) => total + (item.item_price * item.quantity), 0);

        // Renombra los productos usando el diccionario
        const productosNombres = productos.map(item => {
          const nombre = nombrePorId[item.product_retailer_id] || item.product_retailer_id;
          if (!nombrePorId[item.product_retailer_id]) console.warn('[pedido] producto sin nombre en data/catalogo.js:', item.product_retailer_id);
          return `${nombre} x${item.quantity}`;
        });

        // Construye el string del pedido para mostrarlo bonito
        const pedidoStr = productosNombres.join('\n');

        const nuevo = nuevoPedido(message.from, { productos, pedidoStr, monto: precioTotal });
        await messageHandler.handleHiringFlow(message.from, pedidoStr, nuevo.datosPedido);
      }
      else {
        await messageHandler.handleIncomingMessage(message, senderInfo);
      }
    } catch (error) {
      console.error('Error procesando el mensaje:', error);
    }
  }

  async handleFlow(req, res) {
    if (!privateKey) {
      throw new Error(
        'Private key is empty. Please check your env variable "PRIVATE_KEY".'
      );
    }

    if(!isRequestSignatureValid(req)) {
      return res.status(432).send();
    }

    let decryptedRequest = null;
    try {
      decryptedRequest = decryptRequest(req.body, privateKey, config.PASSPHRASE);
    } catch (err) {
      console.error(err);
      if (err instanceof FlowEndpointException) {
        return res.status(err.statusCode).send();
      }
      return res.status(500).send();
    }

    
    const { aesKeyBuffer, initialVectorBuffer, decryptedBody } = decryptedRequest;
    let screenResponse;
    // De quién es este Flow: viene en el flow_token ("pedido:<número>:…").
    const numero = numeroDeToken(decryptedBody.flow_token);
    const s = decryptedBody.action === 'ping' ? null : sesion(numero);
    try {
      if (decryptedBody.action === "ping") {
        // handle health check request
        screenResponse = await getNextScreen(decryptedBody);
      } else if (decryptedBody.screen === 'DETAILS' || decryptedBody.screen === "SUMMARY") {
        screenResponse = await getNextScreen(decryptedBody, s?.productos, s?.datosPedido?.monto, s?.pedidoStr, numero);
      } else if (decryptedBody.screen === 'RESERVA' || decryptedBody.screen === "RESUMEN") {
        screenResponse = await nextScreen(decryptedBody, numero);
      } else if (decryptedBody.screen === 'RECOMMEND' || decryptedBody.screen === "RATE") {
        screenResponse = await nextEncuesta(decryptedBody, numero);
      } else {
        // Errores reportados por el cliente del Flow u otras pantallas: se acusa recibo.
        screenResponse = await getNextScreen(decryptedBody);
      }
    } catch (error) {
      console.error('[flow] error armando la pantalla:', error.message);
      return res.status(500).send();
    }
    if (s) {
      s.ventana = decryptedBody.screen;
      if (s.ventana === "RESUMEN") {
        s.datosReserva = decryptedBody.data;
      } else if (s.ventana === "SUMMARY") {
        s.datosPedido.datos = decryptedBody.data;
      }
    }

    res.send(encryptResponse(screenResponse, aesKeyBuffer, initialVectorBuffer));
    
  };

  async handleEvent(req, res) {
    try {
      const event = req.body;
      if (event && event.data && event.data.transaction) {
        // El número del cliente se busca por el link de pago (no por "el último que escribió").
        await messageHandler.handleWompiEvent(event.data.transaction);
      }
      res.status(200).send('Evento recibido');
    } catch (error) {
      console.error("Error procesando evento de Wompi:", error);
      res.status(500).send('Error procesando evento');
    }
  }

  verifyWebhook(req, res) {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === config.WEBHOOK_VERIFY_TOKEN) {
      res.status(200).send(challenge);
      console.log('Webhook verified successfully!');
    } else {
      res.sendStatus(403);
    }
  }
}

export default new WebhookController();