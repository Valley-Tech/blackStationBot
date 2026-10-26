import whatsappService from './whatsappService.js';
import appendToSheet from './googleSheetsService.js';
import geminiService, { AI_UNAVAILABLE } from './geminiService.js';
import { createWompiPaymentLink, getWompiTransactionStatus } from './wompiService.js';
import { enviarPedidoALoggro } from './loggroService.js';
import { saveUserDataByNumber } from './googleSheetsService.js';
import { logAxiosError } from './printDetailError.js';
import { downloadImageFromMeta } from './httpRequest/sendToWhatsApp.js';
import { uploadToPublicStorage } from './awsS3Service.js';
import { sesion, tokenFlow } from './sesiones.js';
import { product_names, CATALOGOS, areaPorId } from '../data/catalogo.js';
import config from '../config/env.js';
import negocio from '../config/negocio.js';

/**
 * BlackStationBot · La Estación Parrilla Bar (+ Black's Pizza y Heladería Yellow).
 *
 * Misma lógica de SamuelitoBot: bienvenida → Pedir / Reservar, catálogos
 * multiproducto, pedido desde el carrito de WhatsApp → Flow de datos de envío →
 * Efectivo / PSE (Wompi) / Transferencia (comprobante) → aviso a los números
 * oficiales, Google Sheets y comanda en Loggro; Flow de reserva; encuesta; IA del
 * CRM para preguntas; fuera de horario solo reservas y preguntas.
 *
 * Diferencias:
 *  · 3 cartas (Parrilla, Pizzería, Heladería) → "Pedir" muestra un menú de cartas
 *    y cada opción manda su catálogo multiproducto (máx. 30 productos cada uno).
 *  · Pizzas: primero se elige el tamaño (4, 6, 8 o 12 porciones) y llega el
 *    catálogo de ese tamaño con todos los sabores y los bordes.
 *  · Estado por cliente (sesiones.js) en vez de variables globales.
 */

// Plantillas (las mismas de SamuelitoBot; créalas en la WABA de La Estación).
const PLANTILLA_PEDIDO = 'mensaje_nuevo_pedido';
const PLANTILLA_COMPROBANTE = 'comprobante_pago';

function isWithinBusinessHours() {
  // Hora actual en Colombia (GMT-5)
  const now = new Date();
  const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
  const colombiaTime = new Date(utc - (5 * 60 * 60000));
  const current = colombiaTime.getHours() * 60 + colombiaTime.getMinutes();

  const minutos = (hhmm) => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + (m || 0); };
  const opening = minutos(negocio.horario.apertura);
  const closing = minutos(negocio.horario.cierre);
  // Soporta horarios que pasan la medianoche (p. ej. 16:00 a 01:00).
  return closing > opening ? current >= opening && current < closing : current >= opening || current < closing;
}

/** Texto sin tildes y en minúsculas, para comparar palabras. */
const normalizar = (t) => String(t ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

const transactionToPhoneMap = {}; // id del link de pago Wompi → número del cliente
const paymentRowMap = {};         // número → fecha y hora de la fila del pedido en Sheets
const userOrderDataMap = {};      // número → datos del pedido (para avisos y comprobante)

// Cartas por palabra clave ("quiero una pizza", "tienen micheladas"…).
const PALABRAS_CARTA = [
  [/\bpizzas?\b/, 'pizzas'],
  [/\b(panzerott?is?|lasan(a|as)|lasagnas?)\b/, 'pizzeria_otros'],
  [/\b(malteadas?|frapp?es?|smoothies?)\b/, 'heladeria_malteadas'],
  [/\b(jugos?|limonadas?|micheladas?)\b/, 'heladeria_jugos'],
  [/\b(helados?|heladeria|waffles?|brownie|banana split|pina loca|ensalada de frutas|postres?)\b/, 'heladeria_helados'],
  [/\b(salchipapas?|choripapa|pollipapa|salchiplatano|hamburguesas?|burgers?|perros?|hot ?dogs?|choriperro)\b/, 'parrilla_rapidas'],
  [/\b(patacon(es)?|desgranados?|sandwich(es)?|maria casquitos?|casquitos?)\b/, 'parrilla_patacones'],
  [/\b(asados?|carne asada|pechugas?|picadas?|alitas|costillas?|chicharron|chuletas?|punta gorda|lomo de cerdo|chorizos?)\b/, 'parrilla_asados'],
  [/\b(gaseosas?|cervezas?|coca ?cola|postobon|aguas?|pony|soda|bebidas?)\b/, 'bebidas'],
];

class MessageHandler {

  constructor() {
    this.appointmentState = {};
    this.assistandState = {};
  }

  async handleIncomingMessage(message, senderInfo, screen, datosReserva, datosPedido, pedidoStr) {
    try {
      const from = message.from;
      if (!isWithinBusinessHours()) {
        if (message?.type === 'text') {
          const incomingMessage = message.text.body.toLowerCase().trim();
          const carta = this.cartaPorTexto(incomingMessage);
          if (this.isGreeting(incomingMessage)) {
            await this.sendWelcomeMessage(from, message.id, senderInfo);
            await this.sendWelcomeMenu(from);
          } else if (incomingMessage === 'ayuda') {
            await this.helpMenu(from);
          } else if (incomingMessage.includes('carta')) {
            await this.sendMedia(from);
          } else if (incomingMessage.includes('menu') || incomingMessage.includes('menú')) {
            await this.catalogo(from);
          } else if (incomingMessage === 'ubicacion' || incomingMessage === 'ubicación') {
            await this.sendLocation(from);
          } else if (incomingMessage === 'asesor') {
            await this.sendContact(from);
          } else if (this.isReservation(incomingMessage)) {
            await this.handleMenuOption(from, 'option_2');
          } else if (this.isOrder(incomingMessage)) {
            await this.handleMenuOption(from, 'option_1');
          } else if (carta && !/[?¿]/.test(incomingMessage)) {
            // "quiero una pizza", "tienen salchipapas" → directo a esa carta.
            await this.handleMenuOption(from, `cat:${carta}`);
          } else if (this.isQuestion(incomingMessage)) {
            this.assistandState[from] = { step: 'question' };
            await this.handleAssistandFlow(from, incomingMessage);
          }
          else if (this.appointmentState[from]) {
            await this.handleAppointmentFlow(from, incomingMessage);
          }
          else if (this.assistandState[from]) {
            await this.handleAssistandFlow(from, incomingMessage);
          }
          else {
            await this.handleMenuOption(from, incomingMessage);
          }
          await whatsappService.markAsRead(message.id);

        } else if (message?.type === 'interactive') {
          if (message?.interactive.type === 'nfm_reply') {
            await this.respFlow(from, screen, datosReserva, datosPedido, pedidoStr);
            await whatsappService.markAsRead(message.id);
          }
          else {
            // Botones (button_reply) y listas (list_reply: menú de cartas, tamaños de pizza).
            const option = message?.interactive?.button_reply?.id ?? message?.interactive?.list_reply?.id;
            await this.handleMenuOption(from, option);
            await whatsappService.markAsRead(message.id);
          }
        } else if (message?.type === 'image' && sesion(from).esperandoComprobante) {
          await this.recibirComprobante(message);
        }
      } else {
        const incomingMessage = message?.type === 'text' ? message.text.body.toLowerCase().trim() : '';
        if (message?.type === 'text' && this.isQuestion(incomingMessage)) {
          this.assistandState[from] = { step: 'question' };
          await this.handleAssistand(from, incomingMessage);
        } else if (message?.type === 'text' && incomingMessage === 'ayuda') {
          await this.helpMenu(from);
        } else if (message?.type === 'text' && incomingMessage === 'carta') {
          await this.sendMedia(from);
        } else if (message?.type === 'text' && (incomingMessage.includes('menu') || incomingMessage.includes('menú'))) {
          await this.catalogo(from);
        } else if (message?.type === 'text' && (incomingMessage === 'ubicacion' || incomingMessage === 'ubicación')) {
          await this.sendLocation(from);
        } else if (message?.type === 'text' && incomingMessage === 'asesor') {
          await this.sendContact(from);
        } else if (message?.type === 'text' && this.isReservation(incomingMessage)) {
          await this.handleMenuOption(from, 'option_2');
        }
        else if (message?.type === 'interactive' && message?.interactive.type === 'nfm_reply' && screen === "RESUMEN") {
          await this.respFlow(from, screen, datosReserva, datosPedido, pedidoStr);
          await whatsappService.markAsRead(message.id);
        } else if (message?.type === 'image' && sesion(from).esperandoComprobante) {
          await this.recibirComprobante(message);
        } else {
          const name = this.firstName(senderInfo);
          const msg = `¡Hola ${name}! 😊\nNuestro horario de atención es ${negocio.horarioTexto()}\nSi necesitas *Reservar* puedes hacerlo en el *botón de Reservas* o si prefieres hablar con la IA🤖 haz tu pregunta con el signo ❓\n\n ¡Gracias por escribirnos! 😊`;
          await this.menuReserva(from);
          await whatsappService.sendMessage(from, msg, message.id);
          return;
        }
      }
    } catch (error) {
      logAxiosError('Error', error);
      throw error;
    }
  }

  /**
   * Saludo por PALABRAS (no por pedazos de texto): en SamuelitoBot "hi" estaba
   * dentro de "chicharrón" y "hl" en otras palabras, y el bot saludaba en vez de
   * atender el pedido.
   */
  isGreeting(message) {
    const t = normalizar(message);
    return /^(hola|holi|hello|hi|hl|buenas|buen dia|buenos dias|buenas tardes|buenas noches|saludos|que mas|como estas|gracias|muchas gracias)\b/.test(t)
      || /\b(hola|buenas tardes|buenas noches|buenos dias)\b/.test(t) && t.split(/\s+/).length <= 4;
  }

  async getDay() {
    // Día de la semana
    const now = new Date();
    const dias = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];
    return dias[now.getDay()];
  }

  isOrder(message) {
    const lower = message.toLowerCase();
    return (
      lower.includes('pedir') ||
      lower.includes('pedido') ||
      lower.includes('orden') ||
      lower.includes('comprar') ||
      lower.includes('domicilio')
    );
  }

  isReservation(message) {
    const lower = message.toLowerCase();
    return (
      lower.includes('reservar') ||
      lower.includes('reserva') ||
      lower.includes('reservacion') ||
      lower.includes('reservación')
    );
  }

  isQuestion(message) {
    const lower = message.toLowerCase();
    return (
      lower.includes('que') ||
      lower.includes('qué') ||
      lower.includes('quien') ||
      lower.includes('quién') ||
      lower.includes('cual') ||
      lower.includes('cuál') ||
      lower.includes('cuando') ||
      lower.includes('cuándo') ||
      lower.includes('porque') ||
      lower.includes('por que') ||
      lower.includes('porqué') ||
      lower.includes('por qué') ||
      lower.includes('para que') ||
      lower.includes('para qué') ||
      lower.includes('donde') ||
      lower.includes('dónde') ||
      lower.includes('como') ||
      lower.includes('cómo') ||
      lower.includes('cuanto') ||
      lower.includes('cuánto') ||
      lower.includes('pregunta') ||
      lower.includes('¿') ||
      lower.includes('?')
    );
  }

  /** Carta que corresponde a lo que escribió el cliente (o null). */
  cartaPorTexto(message) {
    const t = normalizar(message);
    for (const [re, key] of PALABRAS_CARTA) if (re.test(t)) return key;
    return null;
  }

  getSenderName(senderInfo) {
    return senderInfo?.profile?.name || senderInfo?.profile?.username || "Cliente";
  }

  firstName(senderInfo) {
    return this.getSenderName(senderInfo).replace(/^[~@]+/, '').match(/^([\p{L}\p{N}_]+)/u)?.[1] || '';
  }

  async sendWelcomeMessage(to, messageId, senderInfo) {
    try {
      const name = this.firstName(senderInfo);
      const welcomeMessage = `¡Hola 👋 ${name}!\nBienvenid@ a ${negocio.bienvenida}\n\n¿En qué te puedo ayudar? 😊\n\nEscribe *ayuda* si la necesitas`;
      await whatsappService.sendMessage(to, welcomeMessage, messageId);
    } catch (error) {
      logAxiosError('sendWelcomeMessage', error);
    }
  }

  async sendWelcomeMenu(to) {
    const menuMessage = "Elige una Opción";
    const buttons = [
      {
        type: 'reply', reply: { id: 'option_1', title: 'Pedir 🛒' }
      },
      {
        type: 'reply', reply: { id: 'option_2', title: 'Reservar 📋' }
      },
    ];

    await whatsappService.sendInteractiveButtons(to, menuMessage, buttons);
  }

  async menuOpcionalHiring(to) {
    const menuMessage = "¿Nos ayudarías respondiendo una pequeña encuesta📝?";
    const buttons = [
      {
        type: 'reply', reply: { id: 'opt1', title: 'Si, continuar ✅' }
      },
      {
        type: 'reply', reply: { id: 'option_5', title: 'No, terminar ✖' }
      }
    ];

    await whatsappService.sendInteractiveButtons(to, menuMessage, buttons);
  }

  async menuPedido(to) {
    const action = {
      name: "flow",
      parameters: {
        "flow_message_version": "3",
        "flow_id": config.FLOW_ID_PEDIDO,
        "flow_token": tokenFlow('pedido', to),
        "flow_cta": "Pedido"
      },
    }
    if (!config.FLOW_ID_PEDIDO) console.error('[flows] FLOW_ID_PEDIDO vacío: configura el Flow de pedido en Railway.');
    return await whatsappService.sendFlow(to, action);
  }

  async menuReserva(to) {
    const action = {
      name: "flow",
      parameters: {
        "flow_message_version": "3",
        "flow_id": config.FLOW_ID_RESERVA,
        "flow_token": tokenFlow('reserva', to),
        "flow_cta": "Reserva"
      },
    }
    if (!config.FLOW_ID_RESERVA) console.error('[flows] FLOW_ID_RESERVA vacío: configura el Flow de reserva en Railway.');
    return await whatsappService.sendFlowReserva(to, action);
  }

  async getDia() {
    return this.getDay();
  }

  // ---------------------------------------------------------------------------
  //  Cartas y catálogos multiproducto
  // ---------------------------------------------------------------------------

  /** "Pedir": menú con las cartas de los tres negocios (lista de WhatsApp, máx. 10 filas). */
  async menuCartas(to, { soloBebidasYPostres = false } = {}) {
    const comida = [
      {
        title: 'La Estación Parrilla',
        rows: [
          { id: 'cat:parrilla_asados', title: 'Asados y Picadas 🔥', description: 'Asados y picadas para compartir' },
          { id: 'cat:parrilla_rapidas', title: 'Salchipapas y hamburguesas', description: 'Salchipapas, hamburguesas y perros calientes' },
          { id: 'cat:parrilla_patacones', title: 'Patacones y Sándwiches', description: 'María casquito, patacones y sándwiches' },
        ],
      },
      {
        title: "Black's Pizza",
        rows: [
          { id: 'cat:pizzas', title: 'Pizzas 🍕', description: 'Elige el tamaño: 4, 6, 8 o 12 porciones' },
          { id: 'cat:pizzeria_otros', title: 'Panzerottis y Lasañas', description: 'Panzerottis horneados y lasañas gratinadas' },
        ],
      },
    ];
    const postresYBebidas = [
      {
        title: 'Heladería Yellow',
        rows: [
          { id: 'cat:heladeria_helados', title: 'Helados y Postres 🍨', description: 'Helado a la plancha, copas, waffles y más' },
          { id: 'cat:heladeria_malteadas', title: 'Malteadas y Frappés', description: 'Malteadas, frappés, smoothies y menú infantil' },
          { id: 'cat:heladeria_jugos', title: 'Jugos y Micheladas 🍹', description: 'Jugos naturales, limonadas y micheladas' },
        ],
      },
      {
        title: 'Bebidas',
        rows: [
          { id: 'cat:bebidas', title: 'Gaseosas y Cervezas 🍺', description: 'Gaseosas, agua, jugos Hit, maltas y cervezas' },
        ],
      },
    ];
    await whatsappService.sendListMessage(to, {
      header: soloBebidasYPostres ? 'Bebidas y postres' : '¿Qué se te antoja hoy? 😋',
      body: soloBebidasYPostres
        ? 'Elige qué quieres agregar a tu pedido 👇'
        : 'Aquí 👇 puedes ver nuestras cartas!',
      footer: negocio.marcas,
      button: 'Ver cartas',
      sections: soloBebidasYPostres ? postresYBebidas : [...comida, ...postresYBebidas],
    });
  }

  /** Pizzas: primero el tamaño (cada tamaño tiene su precio). */
  async menuPizzas(to) {
    await whatsappService.sendListMessage(to, {
      header: "Black's Pizza 🍕",
      body: '¿De qué tamaño quieres tu pizza?',
      // footer: 'Todos los sabores en cada tamaño',
      button: 'Elegir tamaño',
      sections: [{
        title: 'Tamaños',
        rows: [
          { id: 'cat:pizzas_4', title: '4 porciones', description: 'Personal · desde $16.000' },
          { id: 'cat:pizzas_6', title: '6 porciones', description: 'Mediana · desde $23.000' },
          { id: 'cat:pizzas_8', title: '8 porciones', description: 'Grande · desde $36.000' },
          { id: 'cat:pizzas_12', title: '12 porciones', description: 'Familiar · desde $54.000' },
        ],
      }],
    });
  }

  /** Catálogo multiproducto (product_list) armado con los nombres de product_names. */
  async menuCarta(to, key) {
    const carta = CATALOGOS[key];
    if (!carta) return false;
    if (!config.CATALOG_ID) {
      console.error('[catalogo] CATALOG_ID vacío: configura el ID del catálogo de Meta en Railway.');
      await whatsappService.sendMessage(to, 'Nuestro catálogo se está actualizando 🙈. Escribe *carta* para recibir el menú en PDF o *asesor* para pedir con una persona.');
      return false;
    }
    const sections = carta.sections
      .map((s) => ({
        title: s.title,
        product_items: s.productos
          .map((nombre) => product_names[nombre])
          .filter(Boolean)
          .map((id) => ({ product_retailer_id: id })),
      }))
      .filter((s) => s.product_items.length);
    const template = {
      type: "product_list",
      header: {
        type: "text",
        text: carta.header
      },
      body: {
        text: "Agrega lo que quieras al carrito 🛒 y envía tu pedido."
      },
      footer: {
        text: carta.marca
      },
      action: {
        catalog_id: config.CATALOG_ID,
        sections,
      }
    };
    await whatsappService.sendMenu(to, template);
    return true;
  }

  async encuesta(to) {
    const action = {
      name: "flow",
      parameters: {
        "flow_message_version": "3",
        "flow_id": config.FLOW_ID_ENCUESTA,
        "flow_token": tokenFlow('encuesta', to),
        "flow_cta": "Encuesta"
      },
    }
    if (!config.FLOW_ID_ENCUESTA) console.error('[flows] FLOW_ID_ENCUESTA vacío: configura el Flow de encuesta en Railway.');
    return await whatsappService.sendFlowEncuesta(to, action);
  }

  /** "menu": plantilla con botón de catálogo si existe; si no, el menú de cartas. */
  async catalogo(to) {
    if (!config.CATALOG_TEMPLATE) return this.menuCartas(to);
    const template = {
      name: config.CATALOG_TEMPLATE,
      language: {
        code: config.CATALOG_TEMPLATE_LANG },
      components: [
        {
          type: "button",
          sub_type: "CATALOG",
          index: 0
        }
      ]
    };
    await whatsappService.sendCatalogo(to, template);
  }

  async handleMenuOption(to, option) {
    let response;
    if (typeof option === 'string' && option.startsWith('cat:')) {
      const key = option.slice(4);
      if (key === 'pizzas') return this.menuPizzas(to);
      const enviado = await this.menuCarta(to, key);
      // Después de la comida, como en SamuelitoBot: "¿Deseas bebida o postre?".
      if (enviado && /^(parrilla_|pizzas_|pizzeria_)/.test(key)) await this.botonSi(to);
      return;
    }
    switch (option) {
      case 'option_1':
        await this.menuCartas(to);
        break;
      case 'option_2':
        await this.sendMediaEvento(to);
        await this.menuReserva(to);
        break;
      case 'option_3':
        this.assistandState[to] = { step: 'question' };
        response = 'Realiza tu pregunta: ';
        break;
      case 'option_4':
        response = "Te esperamos en La Estación! 📍";
        await this.sendLocation(to);
        break;
      case 'option_5':
        response = "Es un placer para nosotros servirte, que disfrutes de tu pedido 😊👩‍🍳\nVuelve pronto!";
        break;
      case 'op_3':
        response = 'Escribe a nuestro Whatsapp personal🤗';
        await this.sendContact(to);
        break;
      case 'opt1':
        await this.encuesta(to);
        break;
      case 'si':
        await this.menuCartas(to, { soloBebidasYPostres: true });
        break;
      default:
        this.assistandState[to] = { step: 'question' };
    }
    if (response) {
      await whatsappService.sendMessage(to, response);
    }
  }

  async handleAppointmentFlow(to, message) {
    const state = this.appointmentState[to];
    delete this.appointmentState[to];
    let response;

    switch (state.step) {
      case 'reserva':
        await this.menuReserva(to);
        break;
      default:
        response = "Lo siento 😔 no entendí tu respuesta\nPor Favor, elige una de las opciones del menú.";
        await whatsappService.sendMessage(to, response);
    }
  }

  async handleHiringFlow(to, pedido, datosPedido) {
    const response = `*Pedido:*

${pedido}

Total: $${Number(datosPedido.monto || 0).toLocaleString('es-CO')} COP`;
    await this.menuPedido(to);

    await whatsappService.sendMessage(to, response);
  }

  async respFlow(to, screen, datosReserva, datosPedido, pedidoStr) {
    let response;
    const pedidoStrTemplate = String(pedidoStr ?? '').replace(/\n/g, '  |  ');
    if (screen === "SUMMARY") {
      if (!datosPedido?.datos) {
        await whatsappService.sendMessage(to, 'No encontré los datos de tu pedido 😔. Vuelve a enviarlo desde el carrito, por favor.');
        return;
      }
      if (datosPedido.datos.address) {
        datosPedido.monto = Number(datosPedido.monto || 0) + negocio.domicilio;
      } else {
        datosPedido.datos.address = "Recogida en el restaurante";
      }
      if (datosPedido.datos.pago === "Efectivo") {
        const templateVars = [
          datosPedido.datos.name,
          datosPedido.datos.phone,
          datosPedido.datos.address,
          pedidoStrTemplate,
          datosPedido.datos.pago,
          datosPedido.monto ? datosPedido.monto.toLocaleString('es-CO') : ""
        ];

        await this.avisarNumerosOficiales(PLANTILLA_PEDIDO, negocio.imagenPedido, templateVars);
        response = "✅¡Pedido recibido!\nPronto nos pondremos en contacto contigo! 🤗";
        await this.menuOpcionalHiring(to);
      } else if (datosPedido.datos.pago === "PSE") {
        try {
          userOrderDataMap[to] = {
            ...datosPedido.datos,
            monto: datosPedido.monto,
            pedidoStr: pedidoStrTemplate
          };
          // Generar enlace de pago WOMPI
          const idlink = await createWompiPaymentLink(
            datosPedido.monto * 100, // Monto en centavos
            "COP",
            pedidoStr
          );
          transactionToPhoneMap[idlink] = to;
          response = `*Resumen de tu pedido*🛒:\n\n${pedidoStr}\n*Total:* $${datosPedido.monto.toLocaleString('es-CO')} COP\n\nUtiliza el siguiente *link de pago*:\n\nhttps://checkout.wompi.co/l/${idlink}\n\nLuego de realizar el pago espera unos segundos y automáticamente te lo confirmamos! 😊`;
        } catch (error) {
          response = "Hubo un problema al generar el enlace de pago. Por favor, intenta nuevamente.";
        }
      } else if (datosPedido.datos.pago === "Transferencia") {
        userOrderDataMap[to] = {
          ...datosPedido.datos,
          monto: datosPedido.monto,
          pedidoStr: pedidoStrTemplate
        };
        sesion(to).esperandoComprobante = true;
        response = `*Resumen de tu pedido*🛒:\n\n${pedidoStr}\n*Total:* $${datosPedido.monto.toLocaleString('es-CO')} COP\n\n${negocio.cuentasBancarias}\n\nLuego, envíanos el comprobante de la transferencia (captura) para confirmar tu pedido 😊`;
      }
    } else if (screen === "RESUMEN") {
      if (!datosReserva) {
        await whatsappService.sendMessage(to, 'No encontré los datos de tu reserva 😔. Vuelve a llenarla, por favor.');
        await this.menuReserva(to);
        return;
      }
      const { horario, calendario } = camposReserva(datosReserva);

      // Variables para la plantilla (en el orden del body)
      const templateVars = [
        datosReserva.nombre,
        datosReserva.celular,
        datosReserva.evento,
        datosReserva[calendario],
        datosReserva[horario],
        datosReserva.cuantos,
        datosReserva.donde
      ];

      for (const numero of [to, ...negocio.numerosOficiales]) {
        await whatsappService.sendTemplateReserva(numero, negocio.imagenReserva, templateVars);
      }
      await this.sendLocation(to);

    } else if (screen === "RATE") {
      response = "¡Recibido!\nMuchas gracias por tu opinión! 🤗";
    }
    if (response) {
      await whatsappService.sendMessage(to, response);
    }
  }

  /** Comprobante de transferencia (imagen) → S3 → aviso a los números oficiales. */
  async recibirComprobante(message) {
    const from = message.from;
    sesion(from).esperandoComprobante = false;
    const datosUsuario = userOrderDataMap[from] || {};
    let publicUrl = negocio.imagenPedido;
    try {
      const imageBuffer = await downloadImageFromMeta(message.image.url);
      publicUrl = await uploadToPublicStorage(imageBuffer, message.image.mime_type);
    } catch (error) {
      logAxiosError('comprobante', error);
    }
    const templateVars = [
      datosUsuario.name || "",
      datosUsuario.phone || "",
      datosUsuario.address || "",
      datosUsuario.pedidoStr || "",
      datosUsuario.pago || "",
      datosUsuario.monto ? datosUsuario.monto.toLocaleString('es-CO') : "",
    ];
    await this.avisarNumerosOficiales(PLANTILLA_COMPROBANTE, publicUrl, templateVars);

    const msg = "Gracias por compartirnos el comprobante de tu pago ✅\n\nPronto nos pondremos en contacto contigo para confirmar tu pedido 😊";
    await whatsappService.sendMessage(from, msg);
    await this.menuOpcionalHiring(from);
  }

  async avisarNumerosOficiales(plantilla, imagen, templateVars) {
    if (!negocio.numerosOficiales.length) {
      console.warn('[avisos] NOTIFY_NUMBERS vacío: nadie recibe el aviso del pedido. Configura los números en Railway.');
      return;
    }
    for (const numero of negocio.numerosOficiales) {
      await whatsappService.sendTemplateComprobantePago(numero, plantilla, imagen, templateVars);
    }
  }

  async handleWompiEvent(transaction) {
    try {
      const transactionId = transaction.id;
      const paymentLinkId = transaction.payment_link_id;
      const phone = transactionToPhoneMap[paymentLinkId];
      const spreadsheetId = process.env.SPREADSHEETID_PEDIDO;

      if (!phone) {
        console.error("No se encontró el número de WhatsApp para la transacción:", paymentLinkId);
        return;
      }
      let status;
      try {
        status = await getWompiTransactionStatus(transactionId);
      } catch (error) {
        console.error("Error consultando el estado de la transacción:", error);
        return;
      }
      console.log(`Estado de la transacción ${transactionId}: ${status}`);
      let estadoPago;
      if (status === "APPROVED") {
        estadoPago = "Pagado";
      } else if (status === "DECLINED" || status === "VOIDED" || status === "ERROR") {
        estadoPago = "Rechazado";
      } else if (status === "PENDING") {
        estadoPago = "Pendiente";
      } else {
        estadoPago = status;
      }
      const fechayhora = paymentRowMap[phone];
      await saveUserDataByNumber({ numero: phone, fechayhora, estado: estadoPago }, spreadsheetId);

      let statusMsg = "";
      if (status === "APPROVED") {
        // En SamuelitoBot se buscaba con el número del último que escribió; aquí, con el de la transacción.
        const datosUsuario = userOrderDataMap[phone] || {};
        const templateVars = [
          datosUsuario.name || "",
          datosUsuario.phone || "",
          datosUsuario.address || "",
          datosUsuario.pedidoStr || "",
          datosUsuario.pago || "",
          datosUsuario.monto ? datosUsuario.monto.toLocaleString('es-CO') : "",
        ];
        await this.avisarNumerosOficiales(PLANTILLA_PEDIDO, negocio.imagenPedido, templateVars);

        statusMsg = "✅ ¡Pago aprobado!\nTu pedido está confirmado.\nPronto nos pondremos en contacto contigo.";
        await this.menuOpcionalHiring(phone);
      } else if (status === "DECLINED" || status === "VOIDED" || status === "ERROR") {
        statusMsg = "❌ El pago fue rechazado\nPor favor, revisa tu medio de pago. Si deseas reintentar, utiliza el mismo link de pago que te enviamos anteriormente.";
      } else if (status === "PENDING") {
        statusMsg = "⏳ Tu pago está pendiente de confirmación.\nTe avisaremos cuando se apruebe.";
      } else {
        statusMsg = `El estado de tu transacción es: ${status}`;
      }

      await whatsappService.sendMessage(phone, statusMsg);

    } catch (error) {
      console.error("Error en handleWompiEvent:", error);
    }
  }

  async helpMenu(to) {
    const response = `Bienvenido al menú de ayuda de *${negocio.nombre}*\n\nPara hacer una pregunta escríbela finalizando con el signo *?*\n\nSi tienes alguna consulta o requerimiento hazla con palabras interrogantes (Qué, Cómo, Por qué, etc.)\n\nPara pedir escribe *Pedir*\nPara reservar escribe *Reservar*\nPara solicitar la carta escribe *Carta*\nPara hablar con un asesor escribe *Asesor*\nPara solicitar la ubicación escribe *Ubicacion*\n\nEspero te sirva! 😊`;

    await whatsappService.sendMessage(to, response);
  }

  /** Cartas en PDF (las que tengan URL configurada); si no hay ninguna, el menú de cartas. */
  async sendMedia(to) {
    const cartas = negocio.cartas.filter((c) => c.url);
    if (!cartas.length) return this.menuCartas(to);
    await whatsappService.sendMessage(to, "Espera que cargue la carta... 📄");
    for (const c of cartas) {
      await whatsappService.sendMediaMessage(to, 'document', c.url, c.caption, c.filename);
    }
  }

  async sendMediaEvento(to) {
    if (!negocio.imagenEvento) return;
    await whatsappService.sendMediaMessage(to, 'image', negocio.imagenEvento);
  }

  completeHiring(productos, data, numero) {
    const fechayhora = new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' });
    const spreadsheetId = process.env.SPREADSHEETID_PEDIDO;
    const userData = [
      numero,
      data.name,
      productos,
      data.address,
      data.phone,
      data.pago,
      data.recomendacion,
      fechayhora,
    ];
    paymentRowMap[numero] = fechayhora;
    if (spreadsheetId) appendToSheet(userData, spreadsheetId);
  }

  /** Comanda en Loggro POS: cada producto con su área (parrilla, cocina, bar, heladería). */
  completeOrder(productos, data) {
    const orders = (productos ?? []).map(item => ({
      product: item.product_retailer_id,
      locationStock: config.LOGGRO_LOCATION_STOCK,
      waiterOrderArea: areaPorId[item.product_retailer_id] ?? null,
      quantity: item.quantity,
      unit_price: item.item_price,
      notes: data.recomendacion || ""
    }));

    // Si hay domicilio y existe el producto "Domicilio" en Loggro, va como un producto más.
    if (data.address && config.LOGGRO_DOMICILIO_PRODUCT_ID && negocio.domicilio) {
      orders.push({
        product: config.LOGGRO_DOMICILIO_PRODUCT_ID,
        locationStock: config.LOGGRO_LOCATION_STOCK,
        quantity: 1,
        unit_price: negocio.domicilio,
        notes: "Domicilio"
      });
    }

    const pedidoLoggro = {
      table: config.LOGGRO_TABLE_ID,
      groupName: `Nombre: ${data.name}\nTeléfono: ${data.phone}\nDirección: ${data.address || 'Recoge en el restaurante'}`,
      orders
    };

    enviarPedidoALoggro(pedidoLoggro); // no lanza errores (ver loggroService.js)
  }

  completeSurvey(data, numero) {
    const fechayhora = new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' });
    const spreadsheetId = process.env.SPREADSHEETID_SURVEY;
    const userData = [
      numero || "No disponible",
      data.experiencia_cliente,
      data.servicio_cliente,
      data.calidad_comida,
      data.recomendacion,
      data.comentarios,
      fechayhora,
    ];
    if (spreadsheetId) appendToSheet(userData, spreadsheetId);
  }

  completeAppointment(data, numero) {
    const fechayhora = new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' });
    const spreadsheetId = process.env.SPREADSHEETID_RESERVA;
    const { horario, calendario } = camposReserva(data);
    const userData = [
      numero || "No disponible",
      data.nombre,
      data.celular,
      data.evento,
      data[calendario],
      data[horario],
      data.cuantos,
      data.donde,
      fechayhora
    ];
    if (spreadsheetId) appendToSheet(userData, spreadsheetId);
  }

  async handleAssistandFlow(to, message) {
    const state = this.assistandState[to];
    let response;

    const menuMessage = "¿Resolví tu pregunta?";
    const buttons = [
      { type: 'reply', reply: { id: 'option_4', title: "Si, Gracias 😊" } },
      { type: 'reply', reply: { id: 'option_3', title: 'Hacer otra pregunta' } },
    ];

    switch (state?.step) {
      case 'question':
        response = (await geminiService(message, to)) ?? AI_UNAVAILABLE;
        break;
      default:
        response = "Lo siento 😔 no entendí tu respuesta\nPor Favor, elige una de las opciones del menú.";
    }

    delete this.assistandState[to];
    await whatsappService.sendMessage(to, response);
    await whatsappService.sendInteractiveButtons(to, menuMessage, buttons);
  }

  async handleAssistand(to, message) {
    const state = this.assistandState[to];
    let response;

    switch (state?.step) {
      case 'question':
        response = (await geminiService(message, to)) ?? AI_UNAVAILABLE;
        break;
      default:
        response = "Lo siento 😔 no entendí tu respuesta\nPor Favor, elige una de las opciones del menú.";
    }

    delete this.assistandState[to];
    await whatsappService.sendMessage(to, response);
  }

  async sendContact(to) {
    await whatsappService.sendContactMessage(to, negocio.contacto);
  }

  async sendLocation(to) {
    const { latitude, longitude, name, address } = negocio.ubicacion;
    if (latitude == null || longitude == null) {
      console.warn('[ubicacion] faltan las coordenadas en src/config/negocio.js');
      await whatsappService.sendMessage(to, `📍 *${name}*\n${address}`);
      return;
    }
    await whatsappService.sendLocationMessage(to, latitude, longitude, name, address);
  }

}

/** Campos del Flow de reserva según el motivo (igual que SamuelitoBot). */
function camposReserva(data) {
  const horario = data.evento === "Festival Gastronomico"
    ? 'hora'
    : data.evento === "Cumpleaños"
      ? 'horario'
      : data.evento === "Reserva normal"
        ? 'horanormal'
        : "";
  const calendario = data.evento === "Festival Gastronomico"
    ? 'fechafestival'
    : data.evento === "Cumpleaños"
      ? 'fecha'
      : data.evento === "Reserva normal"
        ? 'fechanormal'
        : "";
  return { horario, calendario };
}

export default new MessageHandler();
