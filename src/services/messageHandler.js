import whatsappService from './whatsappService.js';
import appendToSheet from './googleSheetsService.js';
import geminiService, { AI_UNAVAILABLE } from './geminiService.js';
import { createWompiPaymentLink, getWompiTransactionStatus } from './wompiService.js';
import { enviarPedidoALoggro } from './loggroService.js';
import { saveUserDataByNumber } from './googleSheetsService.js';
import { logAxiosError } from './printDetailError.js';
import { reportarFalla } from './reportarFallas.js';
import { esDomicilio, valorDomicilio, entregaTexto, variablesReserva, horaReserva, fechaReserva } from './datosFlow.js';
import { downloadImageFromMeta } from './httpRequest/sendToWhatsApp.js';
import { uploadToPublicStorage } from './awsS3Service.js';
import { sesion, tokenFlow, nuevoPedido, obtenerSesion } from './sesiones.js';
import { separarSaludo, esCortesia, esCancelar, esPreguntaGeneral, turnoActual, dentroDeHorario } from './conversacion.js';
import { buscarPlatos, enviarTarjetas, hablaDePlatos } from './busquedaPlatos.js';
import { product_names, CATALOGOS, areaPorId, grupoPorId, precios, nombrePorId } from '../data/catalogo.js';
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
const PLANTILLA_PEDIDO = 'nuevo_pedido';
const PLANTILLA_COMPROBANTE = 'comprobante_pago';

function isWithinBusinessHours() {
  // Hora de Colombia; soporta horarios que pasan la medianoche (16:00 → 00:00). Ver conversacion.js.
  return dentroDeHorario();
}

const cop = (n) => `$${Number(n || 0).toLocaleString('es-CO')}`;

// Botones del paso "confirmar pedido" (máx. 20 caracteres por botón).
const BOTONES_CONFIRMAR = [
  { type: 'reply', reply: { id: 'ped_ok', title: 'Confirmar pedido ✅' } },
  { type: 'reply', reply: { id: 'ped_mas', title: 'Agregar más ➕' } },
  { type: 'reply', reply: { id: 'ped_cambiar', title: 'Cambiar pedido ✏️' } },
];

// Recordatorios del pedido pendiente (un temporizador por cliente).
const temporizadores = new Map();

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
      this.tocarSeguimiento(from);
      // Botones del pedido (confirmar, agregar, adicional…) y respuestas de Flows: a cualquier hora,
      // para no dejar a medias un pedido que empezó antes del cierre.
      const boton = message?.interactive?.button_reply?.id ?? message?.interactive?.list_reply?.id;
      if (!isWithinBusinessHours() && message?.type === 'interactive') {
        if (message.interactive.type === 'nfm_reply') {
          await this.respFlow(from, screen, datosReserva, datosPedido, pedidoStr);
          await whatsappService.markAsRead(message.id);
          return;
        }
        if (/^(ped_|cart_|ad_)/.test(boton ?? '')) return this.handleMenuOption(from, boton);
      }
      if (isWithinBusinessHours()) {
        if (message?.type === 'text') {
          // v3.5: saludo una vez por turno, cortesías, búsqueda de platos con IA y seguimiento del pedido.
          await this.atenderTexto(from, message, senderInfo);

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
        // Pedido de las últimas 3 h ("¿se demora?" después del cierre): lo atiende la IA, no el aviso de horario.
        const pedido = obtenerSesion(from)?.pedido;
        if (message?.type === 'text' && pedido?.enviadoAt && Date.now() - pedido.enviadoAt < 3 * 3600 * 1000) {
          await this.handleAssistandFlow(from, message.text.body, { botones: false });
          await whatsappService.markAsRead(message.id);
          return;
        }
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
          const s = sesion(from);
          if (s.avisoCerradoAt && Date.now() - s.avisoCerradoAt < 2 * 3600 * 1000) {
            // Ya le dijimos que estamos cerrados: respuesta corta en vez de repetir todo.
            await whatsappService.sendMessage(from, `🌙 Ahora estamos cerrados. Te atendemos ${negocio.horarioTexto()} 😊`);
            return;
          }
          s.avisoCerradoAt = Date.now();
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

  async botonSi(to) {
    const menuMessage = "¿Deseas bebida🍹🍺 o postre? 🍨🧇";
    const buttons = [
      {
        type: 'reply', reply: { id: 'si', title: 'Sí ✅' }
      },
      {
        type: 'reply', reply: { id: 'option_1', title: 'Ver otra carta 📋' }
      }
    ];

    await whatsappService.sendInteractiveButtons(to, menuMessage, buttons);
  }

  /**
   * v3.5.1: un Flow sin su ID en Railway lo rechaza Meta (#131009, "falta flow_id").
   * En vez de mandarlo roto, se avisa al cliente, se reporta la falla al CRM y no se envía.
   */
  async flowSinConfigurar(to, variable, tipo) {
    console.error(`[flows] ${variable} vacío: configura el Flow de ${tipo} en Railway.`);
    reportarFalla(new Error(`${variable} vacío en Railway: no se puede enviar el Flow de ${tipo} (Meta lo rechaza con #131009 por falta de flow_id)`), { to, level: 'error', step: `enviar el Flow de ${tipo}` });
    if (tipo === 'encuesta') {
      await whatsappService.sendMessage(to, '¡Gracias por tu tiempo! 😊 Por ahora la encuesta no está disponible.');
      return null;
    }
    await whatsappService.sendMessage(to, tipo === 'pedido'
      ? 'Tuvimos un problema para abrir el formulario del pedido 😔. Escribe *asesor* y una persona toma tu pedido ya mismo.'
      : 'Tuvimos un problema para abrir el formulario de reservas 😔. Escribe *asesor* y una persona hace tu reserva.');
    return null;
  }

  async menuPedido(to, textos = {}) {
    const action = {
      name: "flow",
      parameters: {
        "flow_message_version": "3",
        "flow_id": config.FLOW_ID_PEDIDO,
        "flow_token": tokenFlow('pedido', to),
        "flow_cta": "Pedido"
      },
    }
    if (!config.FLOW_ID_PEDIDO) return this.flowSinConfigurar(to, 'FLOW_ID_PEDIDO', 'pedido');
    return await whatsappService.sendFlow(to, action, textos);
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
    if (!config.FLOW_ID_RESERVA) return this.flowSinConfigurar(to, 'FLOW_ID_RESERVA', 'reserva');
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
          { id: 'cat:parrilla_asados', title: 'Asados y Picadas 🔥', description: 'Asados al carbón y picadas para compartir' },
          { id: 'cat:parrilla_rapidas', title: 'Salchipapas y Burgers', description: 'Salchipapas, hamburguesas y hot dogs' },
          { id: 'cat:parrilla_patacones', title: 'Patacones y Sándwiches', description: 'María casquito, patacones, desgranados y sándwiches' },
        ],
      },
      {
        title: "Black's Pizza",
        rows: [
          { id: 'cat:pizzas', title: 'Pizzas 🍕', description: config.VARIANTES_META ? 'Todos los sabores · el tamaño lo eliges en cada pizza' : 'Elige el tamaño: 4, 6, 8 o 12 porciones' },
          { id: 'cat:pizzeria_otros', title: 'Panzerottis y Lasañas', description: 'Panzerottis horneados y lasañas gratinadas' },
        ],
      },
    ];
    const postresYBebidas = [
      {
        title: 'Heladería Yellow',
        rows: [
          { id: 'cat:heladeria_helados', title: 'Helados y Postres 🍨', description: 'Helado a la plancha, copas, waffles y más' },
          { id: 'cat:heladeria_malteadas', title: 'Malteadas y Frappés', description: config.VARIANTES_META ? 'Malteadas, frappés, smoothies · elige el sabor adentro' : 'Malteadas, frappés, smoothies y menú infantil' },
          { id: 'cat:heladeria_jugos', title: 'Jugos y Micheladas 🍹', description: config.VARIANTES_META ? 'Jugos, limonadas y micheladas · elige el sabor adentro' : 'Jugos naturales, limonadas y micheladas' },
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
        : 'Aquí👇 puedes ver nuestros menús',
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
      footer: 'Todos los sabores en cada tamaño',
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
  async menuCarta(to, key, { header } = {}) {
    const carta = CATALOGOS[key];
    if (!carta) return false;
    if (!config.CATALOG_ID) {
      console.error('[catalogo] CATALOG_ID vacío: configura el ID del catálogo de Meta en Railway.');
      await whatsappService.sendMessage(to, 'Nuestro catálogo se está actualizando 🙈. Escribe *carta* para recibir el menú en PDF o *asesor* para pedir con una persona.');
      return false;
    }
    // Con variantes en Meta (VARIANTES_META=true) va un solo producto por grupo
    // (p. ej. una "Pizza Hawaiana"): el tamaño o el sabor se elige dentro del producto.
    // Representante de cada grupo: la variante más económica (WhatsApp muestra su precio en la lista).
    const unoPorGrupo = (nombres) => {
      if (!config.VARIANTES_META) return nombres;
      const elegido = new Map(); // grupo → nombre
      for (const n of nombres) {
        const g = grupoPorId[product_names[n]];
        if (g && (!elegido.has(g) || (precios[n] ?? 0) < (precios[elegido.get(g)] ?? 0))) elegido.set(g, n);
      }
      const usados = new Set();
      return nombres.flatMap((n) => {
        const g = grupoPorId[product_names[n]];
        if (!g) return [n];
        if (usados.has(g)) return [];
        usados.add(g);
        return [elegido.get(g)];
      });
    };
    const sections = carta.sections
      .map((s) => ({
        title: s.title,
        product_items: unoPorGrupo(s.productos)
          .map((nombre) => product_names[nombre])
          .filter(Boolean)
          .map((id) => ({ product_retailer_id: id })),
      }))
      .filter((s) => s.product_items.length);
    const tieneVariantes = sections.some((s) => s.product_items.some((p) => grupoPorId[p.product_retailer_id]));
    const template = {
      type: "product_list",
      header: {
        type: "text",
        text: header ?? carta.header
      },
      body: {
        text: config.VARIANTES_META && tieneVariantes
          ? "Agrega lo que quieras al carrito 🛒 y envía tu pedido."
          : ""
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
    if (!config.FLOW_ID_ENCUESTA) return this.flowSinConfigurar(to, 'FLOW_ID_ENCUESTA', 'encuesta');
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
    // v3.5: confirmar / agregar / cambiar el pedido y adicionales.
    switch (option) {
      case 'ped_ok': return this.confirmarPedido(to);
      case 'ped_mas': return this.prepararCarrito(to, 'agregar');
      case 'ped_cambiar': return this.prepararCarrito(to, 'reemplazar');
      case 'cart_sumar': return this.usarCarritoNuevo(to, 'agregar');
      case 'cart_reemplazar': return this.usarCarritoNuevo(to, 'reemplazar');
      case 'ad_si': return this.procesarAdicional(to);
      case 'ad_no': return this.usarCarritoNuevo(to, 'nuevo');
      default: break;
    }
    if (typeof option === 'string' && option.startsWith('cat:')) {
      const key = option.slice(4);
      if (key === 'pizzas') {
        // Con variantes: un solo catálogo con todos los sabores (el tamaño se elige en cada pizza).
        if (!config.VARIANTES_META) return this.menuPizzas(to);
        const enviado = await this.menuCarta(to, 'pizzas_4', { header: "Pizzas Black's 🍕 · elige el tamaño en cada una" });
        if (enviado) await this.botonSi(to);
        return;
      }
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

  /** (Compatibilidad) Antes mandaba el Flow de una vez; ahora primero se confirma el pedido. */
  async handleHiringFlow(to) {
    return this.pedirConfirmacion(to);
  }

  /**
   * Cobro según el medio de pago elegido en el Flow (Efectivo, PSE o Transferencia).
   * Se usa al llenar el Flow y también para los ADICIONALES (mismos datos, sin volver a llenarlo).
   * Devuelve el texto para el cliente.
   */
  async cobrarPedido(to, datosPedido, pedidoStr, { adicional = false } = {}) {
    let response;
    const pedidoStrTemplate = String(pedidoStr ?? '').replace(/\n/g, '  |  ');
    const entrega = entregaTexto(datosPedido.datos);
    if (datosPedido.datos.pago === "Efectivo") {
      const templateVars = [
        datosPedido.datos.name,
        datosPedido.datos.phone,
        entrega,
        pedidoStrTemplate,
        datosPedido.datos.pago,
        datosPedido.monto ? datosPedido.monto.toLocaleString('es-CO') : ""
      ];

      await this.avisarNumerosOficiales(PLANTILLA_PEDIDO, negocio.imagenPedido, templateVars);
      response = adicional
        ? `✅ ¡Adicional recibido! Lo sumamos a tu pedido.\n*Total del adicional:* ${cop(datosPedido.monto)} (pagas en efectivo al recibir) 🤗`
        : "✅¡Pedido recibido!\nPronto nos pondremos en contacto contigo! 🤗";
      // if (!adicional) await this.menuOpcionalHiring(to);
    } else if (datosPedido.datos.pago === "PSE") {
      try {
        userOrderDataMap[to] = {
          ...datosPedido.datos,
          address: entrega,
          monto: datosPedido.monto,
          pedidoStr: pedidoStrTemplate
        };
        // Generar enlace de pago WOMPI (con el domicilio incluido si aplica)
        const idlink = await createWompiPaymentLink(
          datosPedido.monto * 100, // Monto en centavos
          "COP",
          pedidoStr
        );
        transactionToPhoneMap[idlink] = to;
        response = `*Resumen de tu pedido*🛒:\n\n${pedidoStr}\n*Total:* $${datosPedido.monto.toLocaleString('es-CO')} COP\n\nUtiliza el siguiente *link de pago*:\n\nhttps://checkout.wompi.co/l/${idlink}\n\nLuego de realizar el pago espera unos segundos y automáticamente te lo confirmamos! 😊`;
      } catch (error) {
        response = "Hubo un problema al generar el enlace de pago. Por favor, intenta nuevamente.";
        // v3.4: el cliente quería pagar con PSE y no recibió el link.
        reportarFalla(error, { to, step: 'generar el link de pago de Wompi (PSE)', monto: datosPedido.monto, pedido: pedidoStrTemplate });
      }
    } else if (datosPedido.datos.pago === "Transferencia") {
      userOrderDataMap[to] = {
        ...datosPedido.datos,
        address: entrega,
        monto: datosPedido.monto,
        pedidoStr: pedidoStrTemplate
      };
      sesion(to).esperandoComprobante = true;
      response = `*Resumen de tu pedido*🛒:\n\n${pedidoStr}\n*Total:* $${datosPedido.monto.toLocaleString('es-CO')} COP\n\n${negocio.cuentasBancarias}\n\nLuego, envíanos el comprobante de la transferencia (captura) para confirmar tu pedido 😊`;
    }
    return response;
  }

  async respFlow(to, screen, datosReserva, datosPedido, pedidoStr) {
    let response;
    const pedidoStrTemplate = String(pedidoStr ?? '').replace(/\n/g, '  |  ');
    if (screen === "SUMMARY") {
      if (!datosPedido?.datos) {
        await whatsappService.sendMessage(to, 'No encontré los datos de tu pedido 😔. Vuelve a enviarlo desde el carrito, por favor.');
        return;
      }
      // Domicilio ($3.000) solo si eligió "Pedir a domicilio" (address = "domicilio"), y una sola vez
      // aunque el Flow llegue repetido. Este monto es el que va en el aviso, en Wompi y en la transferencia.
      if (esDomicilio(datosPedido.datos) && !datosPedido.domicilioIncluido) {
        datosPedido.monto = Number(datosPedido.monto || 0) + valorDomicilio(datosPedido.datos);
        datosPedido.domicilioIncluido = true;
      }
      response = await this.cobrarPedido(to, datosPedido, pedidoStr);
    } else if (screen === "RESUMEN") {
      if (!datosReserva) {
        await whatsappService.sendMessage(to, 'No encontré los datos de tu reserva 😔. Vuelve a llenarla, por favor.');
        await this.menuReserva(to);
        return;
      }
      // Variables de confirmacion_reserva: exactamente las 6 de la plantilla aprobada
      // (antes iban 7 con "donde" y Meta la rechazaba con el error 132000).
      const templateVars = variablesReserva(datosReserva);

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
      // v3.4: el aviso sale con la imagen genérica en vez de la foto del comprobante.
      reportarFalla(error, { to: from, level: 'warning', step: 'descargar el comprobante de Meta y subirlo a S3' });
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
    // await this.menuOpcionalHiring(from);
  }

  async avisarNumerosOficiales(plantilla, imagen, templateVars) {
    if (!negocio.numerosOficiales.length) {
      console.warn('[avisos] NOTIFY_NUMBERS vacío: nadie recibe el aviso del pedido. Configura los números en Railway.');
      reportarFalla(new Error('NOTIFY_NUMBERS vacío: nadie del negocio recibió el aviso del pedido'), { step: `avisar al negocio (plantilla ${plantilla})`, pendingMessage: { type: 'template', template: { name: plantilla }, variables: templateVars } });
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
        // v3.4: Wompi avisó un pago, pero el bot no sabe de qué cliente es (p. ej. se reinició después de crear el link).
        reportarFalla(new Error(`Pago de Wompi sin cliente asociado (link ${paymentLinkId}): el cliente no recibió la confirmación`), { step: 'evento de pago de Wompi', transaccion: transaction.id, estado: transaction.status, monto: transaction.amount_in_cents ? transaction.amount_in_cents / 100 : undefined });
        return;
      }
      let status;
      try {
        status = await getWompiTransactionStatus(transactionId);
      } catch (error) {
        console.error("Error consultando el estado de la transacción:", error);
        reportarFalla(error, { to: phone, step: 'consultar el estado del pago en Wompi', transaccion: transactionId });
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
        // await this.menuOpcionalHiring(phone);
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
      reportarFalla(error, { step: 'procesar el pago de Wompi (handleWompiEvent)' });
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
      entregaTexto(data), // "Domicilio" o "Recoger en el restaurante"
      data.phone,
      data.pago,
      data.recomendacion,
      fechayhora,
    ];
    paymentRowMap[numero] = fechayhora;
    if (spreadsheetId) appendToSheet(userData, spreadsheetId);
  }

  /** Comanda en Loggro POS: cada producto con su área (parrilla, cocina, bar, heladería). */
  completeOrder(productos, data, { adicional = false } = {}) {
    const orders = (productos ?? []).map(item => ({
      product: item.product_retailer_id,
      locationStock: config.LOGGRO_LOCATION_STOCK,
      waiterOrderArea: areaPorId[item.product_retailer_id] ?? null,
      quantity: item.quantity,
      unit_price: item.item_price,
      notes: data.recomendacion || ""
    }));

    // Si hay domicilio y existe el producto "Domicilio" en Loggro, va como un producto más.
    if (!adicional && esDomicilio(data) && config.LOGGRO_DOMICILIO_PRODUCT_ID && negocio.domicilio) {
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
      groupName: `${adicional ? '➕ ADICIONAL\n' : ''}Nombre: ${data.name}\nTeléfono: ${data.phone}\nEntrega: ${entregaTexto(data)}`,
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
    // Se guarda por NOMBRE de columna (fila 1 de la hoja): "Whatsapp o Usuario", "Nombre Completo",
    // "Celular de Contacto", "Motivo de reserva", "Fecha de Reserva", "Hora de Reserva",
    // "Cuántas personas", "Fecha y hora de registro". Las columnas que no reconoce (p. ej.
    // "Estado de Reserva") quedan vacías para que las llenes tú.
    const userData = {
      whatsapp: numero || "No disponible",
      nombre: data.nombre,
      celular: data.celular,
      motivo: data.evento,
      fecha: fechaReserva(data),
      hora: horaReserva(data),
      personas: data.cuantos,
      registro: fechayhora,
    };
    if (spreadsheetId) appendToSheet(userData, spreadsheetId);
  }

  /**
   * Respuesta de la IA del CRM. Si el cliente tiene un pedido sin terminar, después
   * de responder se le recuerda (sin perder el pedido); si no, "¿Resolví tu pregunta?"
   * solo cuando fue una pregunta.
   */
  async handleAssistandFlow(to, message, { botones = true } = {}) {
    delete this.assistandState[to];
    const response = (await geminiService(message, to)) ?? AI_UNAVAILABLE;
    await whatsappService.sendMessage(to, response);
    if (this.pedidoPendiente(to)) {
      await this.recordarPedido(to);
    } else if (botones) {
      await whatsappService.sendInteractiveButtons(to, "¿Resolví tu pregunta?", [
        { type: 'reply', reply: { id: 'option_4', title: "Si, Gracias 😊" } },
        { type: 'reply', reply: { id: 'option_3', title: 'Hacer otra pregunta' } },
      ]);
    }
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
      console.warn('[ubicacion] faltan UBICACION_LAT y UBICACION_LNG en Railway: se envía la dirección con el enlace de Google Maps');
      const mapa = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${name}, ${address}`)}`;
      await whatsappService.sendMessage(to, `📍 *${name}*\n${address}\n\nCómo llegar: ${mapa}`);
      return;
    }
    await whatsappService.sendLocationMessage(to, latitude, longitude, name, address);
  }

  // ===========================================================================
  //  v3.5 · Conversación
  // ===========================================================================

  /**
   * Texto del cliente dentro del horario.
   *  1. Saludo: la bienvenida sale UNA vez por turno; "hola, ¿se demora?" atiende la pregunta.
   *  2. "gracias", "ok" → respuesta corta (nunca la bienvenida otra vez).
   *  3. Palabras clave de siempre (ayuda, carta, menú, ubicación, asesor, reservar).
   *  4. Preguntas generales (tiempos, pagos, domicilio, estado del pedido) → IA del CRM.
   *  5. Platos ("me regalas 3 salchipapas") → búsqueda con IA → tarjetas / carrusel.
   *  6. Todo lo demás → IA del CRM (antes quedaba sin respuesta).
   * Si hay un pedido sin terminar, se le recuerda después de responder.
   */
  async atenderTexto(from, message, senderInfo) {
    try {
      return await this.responderTexto(from, message, senderInfo);
    } finally {
      await whatsappService.markAsRead(message.id);
    }
  }

  async responderTexto(from, message, senderInfo) {
    const texto = String(message.text?.body ?? '').trim();
    const s = sesion(from);

    const { saludo, resto } = separarSaludo(texto);
    if (saludo) {
      const turno = turnoActual() ?? 'fuera';
      const primeraVez = s.bienvenidaTurno !== turno;
      if (primeraVez) {
        s.bienvenidaTurno = turno;
        await this.sendWelcomeMessage(from, message.id, senderInfo);
      }
      if (!resto) {
        if (!primeraVez) {
          const nombre = this.firstName(senderInfo);
          await whatsappService.sendMessage(from, `¡Hola de nuevo${nombre ? `, ${nombre}` : ''}! 😊 ¿En qué te puedo ayudar?`);
        }
        if (this.pedidoPendiente(from)) await this.recordarPedido(from);
        else if (primeraVez) await this.sendWelcomeMenu(from);
        return;
      }
    }

    const t = saludo ? resto : texto;
    const lower = t.toLowerCase().trim();
    const pregunta = this.isQuestion(lower);

    if (esCortesia(t)) {
      await whatsappService.sendMessage(from, this.pedidoPendiente(from) ? '¡Con gusto! 😊' : '¡Con gusto! 😊 Aquí estamos si necesitas algo más.');
      if (this.pedidoPendiente(from)) await this.recordarPedido(from);
      return;
    }
    if (esCancelar(t) && this.pedidoPendiente(from)) return this.cancelarPedido(from);

    // Palabras clave (igual que antes).
    if (lower === 'ayuda') return this.helpMenu(from);
    if (lower.includes('carta')) return this.sendMedia(from);
    if (/\bmen[uú]\b/.test(lower) && !hablaDePlatos(t)) return this.catalogo(from);
    if (lower === 'ubicacion' || lower === 'ubicación') return this.sendLocation(from);
    if (lower === 'asesor') return this.sendContact(from);
    if (this.isReservation(lower)) return this.handleMenuOption(from, 'option_2');
    if (this.appointmentState[from]) return this.handleAppointmentFlow(from, lower);

    // "Hacer otra pregunta" o preguntas de tiempos, pagos, domicilio, estado del pedido → IA.
    if (this.assistandState[from] || esPreguntaGeneral(t)) return this.handleAssistandFlow(from, t, { botones: pregunta });

    // Platos: la IA completa el nombre y se muestran las tarjetas del catálogo.
    if (hablaDePlatos(t)) {
      const { tarjetas } = await buscarPlatos(from, t);
      const carta = this.cartaPorTexto(lower);
      if (tarjetas.length > 10 && carta && !pregunta) return this.handleMenuOption(from, `cat:${carta}`); // "quiero una pizza" → la carta completa
      if (tarjetas.length) {
        if (pregunta) {
          // "¿la hawaiana tiene piña?": responde la IA y debajo quedan las tarjetas para pedir.
          const respuesta = await geminiService(t, from);
          if (respuesta) await whatsappService.sendMessage(from, respuesta);
        }
        await enviarTarjetas(from, tarjetas, t);
        return;
      }
    }
    const carta = this.cartaPorTexto(lower);
    if (carta && !pregunta) return this.handleMenuOption(from, `cat:${carta}`);
    if (!pregunta && this.isOrder(lower)) {
      if (this.pedidoPendiente(from)) return this.recordarPedido(from);
      return this.handleMenuOption(from, 'option_1');
    }
    return this.handleAssistandFlow(from, t, { botones: pregunta });
  }

  // ===========================================================================
  //  v3.5 · Pedido: confirmar, agregar, cambiar, recordatorios y adicionales
  // ===========================================================================

  /** Pedido del carrito que todavía no tiene los datos del Flow. */
  pedidoPendiente(to) {
    const s = obtenerSesion(to);
    return Boolean(s?.pedido && ['confirmar', 'datos'].includes(s.pedido.estado) && s.productos?.length);
  }

  /** Nombres y total de un carrito (los nombres salen de data/catalogo.js). */
  resumenCarrito(items) {
    const lineas = items.map((item) => {
      const nombre = nombrePorId[item.product_retailer_id] || item.product_retailer_id;
      if (!nombrePorId[item.product_retailer_id]) console.warn('[pedido] producto sin nombre en data/catalogo.js:', item.product_retailer_id);
      return `${nombre} x${item.quantity}`;
    });
    const monto = items.reduce((t, i) => t + (Number(i.item_price) || 0) * (Number(i.quantity) || 1), 0);
    return { pedidoStr: lineas.join('\n'), monto };
  }

  /** Carrito que llega del catálogo de WhatsApp ("Pedido del catálogo"). */
  async recibirCarrito(to, order) {
    const items = (order?.product_items ?? []).map((i) => ({
      product_retailer_id: String(i.product_retailer_id),
      quantity: Number(i.quantity) || 1,
      item_price: Number(i.item_price) || 0,
      currency: i.currency,
    }));
    if (!items.length) return;
    const s = sesion(to);

    if (!isWithinBusinessHours()) {
      await whatsappService.sendMessage(to, `🌙 En este momento estamos cerrados. Recibimos pedidos ${negocio.horarioTexto()}.\nTu carrito queda guardado en WhatsApp 🛒: envíalo de nuevo cuando abramos 😊`);
      return;
    }

    // ¿Ya llenó el Flow hace poco? Puede ser un ADICIONAL a ese pedido.
    const p = s.pedido;
    if (p?.estado === 'enviado' && p.datos && Date.now() - (p.ultimoAt ?? p.enviadoAt ?? 0) < config.ADICIONAL_MINUTOS * 60000) {
      s.carritoNuevo = items;
      const { pedidoStr, monto } = this.resumenCarrito(items);
      await whatsappService.sendInteractiveButtons(to, `Recibí estos productos 🛒\n\n${pedidoStr}\n*Total:* ${cop(monto)}\n\n¿Son un *adicional* para el pedido que ya enviaste? (mismos datos de entrega y pago, sin volver a llenar el formulario)`.slice(0, 1024), [
        { type: 'reply', reply: { id: 'ad_si', title: 'Sí, es adicional' } },
        { type: 'reply', reply: { id: 'ad_no', title: 'Es un pedido nuevo' } },
      ]);
      return;
    }

    // ¿Tiene un pedido sin terminar? Se suma o se reemplaza (lo que haya elegido, o se le pregunta).
    if (this.pedidoPendiente(to)) {
      if (s.modoCarrito) {
        const modo = s.modoCarrito;
        s.modoCarrito = null;
        return this.aplicarCarrito(to, items, modo);
      }
      s.carritoNuevo = items;
      const nuevo = this.resumenCarrito(items);
      await whatsappService.sendInteractiveButtons(to, `Ya tienes un pedido sin terminar:\n\n${s.pedidoStr}\n\nY acabas de enviar:\n\n${nuevo.pedidoStr}\n\n¿Qué hago con estos productos?`.slice(0, 1024), [
        { type: 'reply', reply: { id: 'cart_sumar', title: 'Agregar al pedido' } },
        { type: 'reply', reply: { id: 'cart_reemplazar', title: 'Reemplazar pedido' } },
      ]);
      return;
    }
    return this.aplicarCarrito(to, items, 'nuevo');
  }

  /** Arma el pedido con el carrito (nuevo, sumado al anterior o reemplazándolo) y pide confirmarlo. */
  async aplicarCarrito(to, items, modo = 'nuevo') {
    const s = sesion(to);
    let lista = items;
    if (modo === 'agregar' && s.productos?.length) {
      const porId = new Map(s.productos.map((i) => [i.product_retailer_id, { ...i }]));
      for (const i of items) {
        const actual = porId.get(i.product_retailer_id);
        if (actual) actual.quantity = (Number(actual.quantity) || 0) + (Number(i.quantity) || 0);
        else porId.set(i.product_retailer_id, { ...i });
      }
      lista = [...porId.values()];
    }
    const { pedidoStr, monto } = this.resumenCarrito(lista);
    nuevoPedido(to, { productos: lista, pedidoStr, monto });
    const recordatorios = modo === 'nuevo' ? 0 : s.pedido?.recordatorios ?? 0;
    s.pedido = { estado: 'confirmar', creadoAt: Date.now(), recordatorios };
    s.carritoNuevo = null;
    s.modoCarrito = null;
    await this.pedirConfirmacion(to, { modo });
    this.programarRecordatorio(to);
  }

  /** "¿Está todo bien?" antes de mandar el Flow: confirmar, agregar más o cambiar. */
  async pedirConfirmacion(to, { modo = 'nuevo' } = {}) {
    const s = sesion(to);
    const intro = modo === 'agregar' ? '✅ Listo, lo agregué.\n\n' : modo === 'reemplazar' ? '✅ Listo, cambié tu pedido.\n\n' : '';
    const domicilio = negocio.domicilio ? `\n_(Si es a domicilio se suman ${cop(negocio.domicilio)})_` : '';
    const texto = `${intro}*Tu pedido* 🛒\n\n${s.pedidoStr}\n\n*Subtotal:* ${cop(s.datosPedido?.monto)}${domicilio}\n\n¿Está todo bien?`;
    await whatsappService.sendInteractiveButtons(to, texto.slice(0, 1024), BOTONES_CONFIRMAR);
  }

  /** Confirmó: se manda el Flow de datos (entrega y pago). */
  async confirmarPedido(to) {
    const s = sesion(to);
    if (!this.pedidoPendiente(to)) {
      await whatsappService.sendMessage(to, 'No encontré un pedido pendiente 🤔. Arma tu carrito 🛒 y envíalo, por favor.');
      return;
    }
    s.pedido.estado = 'datos';
    await this.menuPedido(to);
    this.programarRecordatorio(to);
  }

  /** "Agregar más" / "Cambiar pedido": el próximo carrito se suma o reemplaza sin preguntar. */
  async prepararCarrito(to, modo) {
    const s = sesion(to);
    if (!this.pedidoPendiente(to)) {
      await whatsappService.sendMessage(to, 'No encontré un pedido pendiente 🤔. Arma tu carrito 🛒 y envíalo, por favor.');
      return;
    }
    s.modoCarrito = modo;
    await whatsappService.sendMessage(to, modo === 'agregar'
      ? 'Perfecto 👌 Elige lo que quieras agregar y envía el carrito 🛒: lo sumo a tu pedido.'
      : 'Claro 👌 Arma tu carrito 🛒 con el pedido como lo quieres y envíalo: reemplazo el anterior.\n\n💡 En el carrito puedes cambiar cantidades o quitar productos antes de enviarlo.');
    await this.menuCartas(to);
    this.programarRecordatorio(to);
  }

  /** Respuesta a "¿Agregar o reemplazar?" / "¿Es adicional?" sobre el último carrito. */
  async usarCarritoNuevo(to, modo) {
    const s = sesion(to);
    if (!s.carritoNuevo?.length) {
      await whatsappService.sendMessage(to, 'No encontré los productos 🤔. Envía el carrito de nuevo, por favor.');
      return;
    }
    if (modo === 'nuevo') s.pedido = null; // pedido nuevo (el anterior ya se envió)
    return this.aplicarCarrito(to, s.carritoNuevo, modo);
  }

  /** ADICIONAL a un pedido ya enviado: mismos datos del Flow, sin domicilio otra vez. */
  async procesarAdicional(to) {
    const s = sesion(to);
    const prev = s.pedido?.datos;
    const items = s.carritoNuevo;
    if (!prev || !items?.length) {
      await whatsappService.sendMessage(to, 'No encontré tu pedido anterior 🤔. Envía el carrito de nuevo y lo tomamos como un pedido nuevo.');
      return;
    }
    const { pedidoStr, monto } = this.resumenCarrito(items);
    const datos = { ...prev, recomendacion: [prev.recomendacion, 'ADICIONAL al pedido anterior'].filter(Boolean).join(' · ') };
    this.completeHiring(`➕ ADICIONAL\n${pedidoStr}`, datos, to);   // Google Sheets
    this.completeOrder(items, datos, { adicional: true });          // Loggro (sin domicilio)
    const response = await this.cobrarPedido(to, { monto, datos: prev, domicilioIncluido: true }, `➕ *Adicional:*\n${pedidoStr}`, { adicional: true });
    if (response) await whatsappService.sendMessage(to, response);
    s.pedido.ultimoAt = Date.now();
    s.carritoNuevo = null;
  }

  /** El cliente llenó el Flow (pantalla SUMMARY): el pedido quedó enviado. Lo llama flow.js. */
  pedidoEnviado(numero, data) {
    const s = sesion(numero);
    s.pedido = { ...(s.pedido ?? {}), estado: 'enviado', enviadoAt: Date.now(), ultimoAt: Date.now(), datos: { ...data } };
    s.modoCarrito = null;
    clearTimeout(temporizadores.get(numero));
    temporizadores.delete(numero);
  }

  async cancelarPedido(to) {
    const s = sesion(to);
    s.pedido = null;
    s.productos = [];
    s.pedidoStr = '';
    s.modoCarrito = null;
    s.carritoNuevo = null;
    clearTimeout(temporizadores.get(to));
    temporizadores.delete(to);
    await whatsappService.sendMessage(to, 'Listo, cancelé tu pedido 👍. Cuando quieras, escribe *pedir* y te muestro las cartas.');
  }

  /**
   * Recordatorio del pedido sin terminar: automático (cada RECORDATORIO_PEDIDO_MIN,
   * máx. RECORDATORIO_PEDIDO_MAX veces) o justo después de responderle una pregunta.
   */
  async recordarPedido(to, { automatico = false } = {}) {
    const s = obtenerSesion(to);
    if (!s || !this.pedidoPendiente(to)) return false;
    const p = s.pedido;
    if (!automatico && p.ultimoRecordatorioAt && Date.now() - p.ultimoRecordatorioAt < 60 * 1000) return false; // no repetir en ráfaga
    p.ultimoRecordatorioAt = Date.now();
    if (automatico) p.recordatorios = (p.recordatorios ?? 0) + 1;
    const ultimo = automatico && p.recordatorios >= config.RECORDATORIO_PEDIDO_MAX;
    const cierre = ultimo ? '\n\nSi ya no lo quieres, escribe *cancelar*.' : '';
    if (p.estado === 'confirmar') {
      const texto = `${automatico ? '⏰ ' : ''}Tu pedido sigue esperando 🛒\n\n${s.pedidoStr}\n\n*Subtotal:* ${cop(s.datosPedido?.monto)}\n\n¿Lo confirmamos?${cierre}`;
      await whatsappService.sendInteractiveButtons(to, texto.slice(0, 1024), BOTONES_CONFIRMAR);
    } else {
      await this.menuPedido(to, {
        header: automatico ? '⏰ ¿Seguimos con tu pedido?' : '¿Seguimos con tu pedido? 😊',
        body: `Solo falta que llenes tus datos de entrega y pago. Toca *Pedido* 👇${cierre}`,
      });
    }
    if (automatico) this.programarRecordatorio(to);
    return true;
  }

  /** Programa el próximo recordatorio (o lo cancela si ya no hace falta). */
  programarRecordatorio(to) {
    clearTimeout(temporizadores.get(to));
    temporizadores.delete(to);
    const s = obtenerSesion(to);
    if (!this.pedidoPendiente(to) || (s.pedido.recordatorios ?? 0) >= config.RECORDATORIO_PEDIDO_MAX) return;
    const t = setTimeout(() => {
      temporizadores.delete(to);
      this.recordarPedido(to, { automatico: true }).catch((error) => {
        console.error('[pedido] no se pudo enviar el recordatorio:', error.message);
        reportarFalla(error, { to, step: 'recordatorio del pedido pendiente' });
      });
    }, config.RECORDATORIO_PEDIDO_MIN * 60 * 1000);
    t.unref?.();
    temporizadores.set(to, t);
  }

  /** El cliente escribió: el recordatorio se cuenta desde ahora (no se le interrumpe mientras habla). */
  tocarSeguimiento(to) {
    if (temporizadores.has(to)) this.programarRecordatorio(to);
  }
}

export default new MessageHandler();
