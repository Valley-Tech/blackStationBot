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
import { separarSaludo, esCortesia, esCancelar, esPreguntaGeneral, turnoActual, dentroDeHorario, esPeticionDeProducto } from './conversacion.js';
import { buscarPlatos, enviarTarjetas, hablaDePlatos, textoSinFoto } from './busquedaPlatos.js';
import { leerPedidoPizza, hablaDePizza, quiereCombinar, armarItem, validar, textoResumen, textoSabores, precioCombinada, maxSabores, repartoDe, esPizza, PIZZA_POR_ID, SABORES, TAMANOS, REPARTOS, cop } from './pizzasCombinadas.js';
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
        if (/^(ped_|cart_|ad_|pzc?_)/.test(boton ?? '')) return this.handleMenuOption(from, boton);
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
      const welcomeMessage = `¡Hola 👋 ${name}!\nSoy tu nuevo asistente virtual de ${negocio.bienvenida}\n\n¿En qué te puedo ayudar? 😊`;
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
    if (!config.FLOW_ID_PEDIDO) console.error('[flows] FLOW_ID_PEDIDO vacío: configura el Flow de pedido en Railway.');
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
          { id: 'cat:parrilla_asados', title: 'Asados y Picadas 🔥'},
          { id: 'cat:parrilla_rapidas', title: 'Salchipapas y Burgers'},
          { id: 'cat:parrilla_patacones', title: 'Patacones y Sándwiches'},
        ],
      },
      {
        title: "Black's Pizza",
        rows: [
          { id: 'cat:pizzas', title: 'Pizzas 🍕'},
          { id: 'cat:pizzeria_otros', title: 'Panzerottis y Lasañas'},
        ],
      },
    ];
    const postresYBebidas = [
      {
        title: 'Heladería Yellow',
        rows: [
          { id: 'cat:heladeria_helados', title: 'Helados y Postres 🍨' },
          { id: 'cat:heladeria_malteadas', title: 'Malteadas y Frappés' },
          { id: 'cat:heladeria_jugos', title: 'Jugos y Micheladas 🍹' },
        ],
      },
      {
        title: 'Bebidas',
        rows: [
          { id: 'cat:bebidas', title: 'Gaseosas y Cervezas 🍺'},
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
    // v3.7: botones y listas de pizzas combinadas (pz_*, pzc_*).
    if (typeof option === 'string' && /^pzc?_/.test(option) && await this.botonPizza(to, option)) return;
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
        sesion(to).vioPizzasAt = Date.now(); // v3.7: contexto para "me la puedes hacer de 2 sabores"
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
    } else if (datosPedido.datos.pago === "Codigo QR") {
      try {
          userOrderDataMap[to] = {
            ...datosPedido.datos,
            monto: datosPedido.monto,
            pedidoStr: pedidoStrTemplate
          };
          // Enviar imagen de codigo QR con sendmediaMessage
          await this.sendMediaQR(to);
          response = `*Resumen de tu compra*🛒:\n\n${pedidoStr}\n*Total:* $${datosPedido.monto.toLocaleString('es-CO')} COP`;
          sesion(to).esperandoComprobante = true;
        } catch (error) {
          response = "Hubo un problema al enviar el código QR. Por favor, intenta nuevamente.";
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

  async sendMediaQR(to) {
    const mediaUrl = 'https://micarta.s3.us-east-1.amazonaws.com/QR-La+Estacion.jpeg';
    const caption = '¡Envíanos el comprobante de la transferencia (captura) para confirmar tu pedido 😊!';
    const type = 'image';

    await whatsappService.sendMediaMessage(to, type, mediaUrl, caption);
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
      notes: [item.nota, data.recomendacion].filter(Boolean).join(' · ') // v3.7: "COMBINADA 8 porciones: 4 Hawaiana + 2 Mexicana + 2 Ranchera"
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
    // v3.7: está armando una pizza combinada → sus respuestas (sabores, tamaño, "cancelar") van ahí.
    if (s.combo) return this.atenderComboTexto(from, t);
    if (esCancelar(t) && this.pedidoPendiente(from)) return this.cancelarPedido(from);

    // Palabras clave (igual que antes).
    if (lower === 'ayuda') return this.helpMenu(from);
    if (lower.includes('carta') && !this.esPedidoDePizza(lower)) return this.sendMedia(from); // v3.7: "carta de pizzas" va a pizzas
    if (/\bmen[uú]\b/.test(lower) && !hablaDePlatos(t)) return this.catalogo(from);
    if (lower === 'ubicacion' || lower === 'ubicación') return this.sendLocation(from);
    if (lower === 'asesor') return this.sendContact(from);
    if (this.isReservation(lower)) return this.handleMenuOption(from, 'option_2');
    if (this.appointmentState[from]) return this.handleAppointmentFlow(from, lower);

    // "Hacer otra pregunta" o preguntas de tiempos, pagos, domicilio, estado del pedido → IA.
    if (this.assistandState[from] || esPreguntaGeneral(t)) return this.handleAssistandFlow(from, t, { botones: pregunta });

    // Platos: la IA completa el nombre y se muestran las tarjetas del catálogo.
    // v3.6: "¿qué hamburguesas tienes?", "¿tienen malteadas?" piden un producto: solo tarjetas, sin texto de la IA.
    const pideProducto = !pregunta || esPeticionDeProducto(t);
    // v3.7: pizzas → combinar sabores (o preguntar si quiere combinar) antes de la búsqueda normal.
    // "me la puedes hacer de 2 sabores" sin decir "pizza": cuenta si acaba de ver las pizzas o tiene una en el pedido.
    const contextoPizza = quiereCombinar(t) && ((s.vioPizzasAt && Date.now() - s.vioPizzasAt < 30 * 60000) || (s.productos ?? []).some((p) => esPizza(p.product_retailer_id)));
    if ((this.esPedidoDePizza(lower) || contextoPizza) && !/\b(panzerott?is?|lasan)/.test(lower) && await this.atenderPizzaTexto(from, t, { pregunta, pideProducto })) return;
    if (hablaDePlatos(t)) {
      const { tarjetas, sinFoto } = await buscarPlatos(from, t);
      const carta = this.cartaPorTexto(lower);
      if (tarjetas.length > 10 && carta && pideProducto) return this.handleMenuOption(from, `cat:${carta}`); // "quiero una pizza" → la carta completa
      if (tarjetas.length) {
        if (!pideProducto) {
          // "¿la hawaiana tiene piña?": responde la IA y debajo quedan las tarjetas para pedir.
          const respuesta = await geminiService(t, from);
          if (respuesta) await whatsappService.sendMessage(from, respuesta);
        }
        await enviarTarjetas(from, tarjetas, t);
        return;
      }
      if (sinFoto?.length && pideProducto) {
        // Lo pidió, pero todavía no tiene foto en Meta (no sale en el catálogo de WhatsApp).
        await whatsappService.sendMessage(from, textoSinFoto(sinFoto));
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
      const nombre = item.nombre || nombrePorId[item.product_retailer_id] || item.product_retailer_id; // v3.7: pizzas combinadas traen su nombre
      if (!item.nombre && !nombrePorId[item.product_retailer_id]) console.warn('[pedido] producto sin nombre en data/catalogo.js:', item.product_retailer_id);
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
      // v3.7: una pizza combinada no se mezcla con la misma pizza de un solo sabor (clave = id + nota).
      const clave = (i) => `${i.product_retailer_id}|${i.nota ?? ''}`;
      const porId = new Map(s.productos.map((i) => [clave(i), { ...i }]));
      for (const i of items) {
        const actual = porId.get(clave(i));
        if (actual) actual.quantity = (Number(actual.quantity) || 0) + (Number(i.quantity) || 0);
        else porId.set(clave(i), { ...i });
      }
      lista = [...porId.values()];
    }
    const { pedidoStr, monto } = this.resumenCarrito(lista);
    nuevoPedido(to, { productos: lista, pedidoStr, monto });
    const recordatorios = modo === 'nuevo' ? 0 : s.pedido?.recordatorios ?? 0;
    s.pedido = { estado: 'confirmar', creadoAt: Date.now(), recordatorios };
    s.carritoNuevo = null;
    s.modoCarrito = null;
    // v3.7: si vienen pizzas de un solo sabor, primero "¿Deseas combinar las porciones?".
    s.comboModo = modo;
    if (await this.comboPreguntarCarrito(to)) { this.programarRecordatorio(to); return; }
    s.comboModo = null;
    await this.pedirConfirmacion(to, { modo });
    this.programarRecordatorio(to);
  }

  /** "¿Está todo bien?" antes de mandar el Flow: confirmar, agregar más o cambiar. */
  async pedirConfirmacion(to, { modo = 'nuevo' } = {}) {
    const s = sesion(to);
    const intro = modo === 'agregar' ? '✅ Listo, lo agregué.\n\n' : modo === 'reemplazar' ? '✅ Listo, cambié tu pedido.\n\n' : '';
    const domicilio = negocio.domicilio;
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

  // ===========================================================================
  //  v3.7 · Pizzas combinadas (2 o 3 sabores en una bandeja)
  // ===========================================================================
  //
  //  Estado por cliente: s.combo = { paso, tamano, sabores, nSabores, cantidad, origen, linea }
  //    paso: 'tamano' → 'nsabores' (solo 8 y 12) → 'sabores' → 'ambiguo' → 'resumen'
  //    origen: 'texto' (lo pidió escribiendo) | 'carrito' (venía una pizza en el carrito; linea = índice)
  //  Disparadores:
  //    · texto con "mitad…", "2 sabores", o 2+ sabores → se arma de una vez (preguntando solo lo que falte);
  //    · "quiero una pizza" (genérico) → botones "¿Deseas combinar?"; No → carta de pizzas;
  //    · "carta/menú de pizzas" → la carta y después la pregunta;
  //    · un sabor concreto ("pizza hawaiana de 8") → la tarjeta y la pregunta "¿la combinamos?";
  //    · carrito con pizza(s) → por cada línea: "¿Deseas combinar las porciones?" antes de "¿Está todo bien?".
  //  El resultado entra al pedido como un producto más (ID del sabor más caro + nota), así que
  //  el Flow, el cobro, Sheets y Loggro no cambian.

  /** ¿El texto habla de pizzas (y no es una pregunta de detalle)? */
  esPedidoDePizza(lower) {
    return hablaDePizza(lower);
  }

  /** Entrada desde el texto del cliente (lo llama responderTexto). Devuelve true si lo atendió. */
  async atenderPizzaTexto(from, t, { pregunta, pideProducto }) {
    const s = sesion(from);
    const lower = normalizar(t);
    const leido = leerPedidoPizza(t);
    const pideCarta = /\b(carta|menu|muestra|muestrame|mostrar|ver|opciones|sabores|cuales|que pizzas|tienen)\b/.test(lower) && leido.sabores.length === 0;

    // 1. Pidió combinar (o nombró 2+ sabores): se arma de una vez. ("queso" contiene "que" y isQuestion
    //    lo toma como pregunta; aquí solo frena una pregunta de detalle: "¿la mitad hawaiana trae piña?").
    const detalle = /\b(trae|traen|lleva|llevan|ingredientes?|contiene|demora|tarda|cuanto|precio|vale|recomiend)/.test(lower);
    if ((pideProducto || !detalle) && (leido.combinar || leido.nSabores)) {
      await this.iniciarCombo(from, { ...leido, origen: 'texto' });
      return true;
    }
    // 2. Un sabor concreto: la tarjeta de siempre y "¿la combinamos?".
    if (pideProducto && leido.sabores.length === 1 && !leido.ambiguos.length) {
      const { tarjetas } = await buscarPlatos(from, t);
      if (tarjetas.length) await enviarTarjetas(from, tarjetas, t);
      s.vioPizzasAt = Date.now();
      s.comboBorrador = { tamano: leido.tamano, sabores: leido.sabores, cantidad: leido.cantidad };
      await whatsappService.sendInteractiveButtons(from, `¿La quieres *combinada* con otro sabor? 🍕 (mitad y mitad; la de 8 y 12 hasta 3 sabores)`, [
        { type: 'reply', reply: { id: 'pz_si', title: 'Sí, combinar 🍕' } },
        { type: 'reply', reply: { id: 'pz_no', title: 'No, un solo sabor' } },
      ]);
      return true;
    }
    if (!pideProducto) return false; // "¿la hawaiana tiene piña?" → IA + tarjetas, como siempre
    // 3. Genérico: carta primero si la pidió; si no, la pregunta primero (No → la carta).
    s.comboBorrador = { tamano: leido.tamano, sabores: [], cantidad: leido.cantidad };
    if (pideCarta) await this.handleMenuOption(from, 'cat:pizzas');
    await whatsappService.sendInteractiveButtons(from, pideCarta
      ? '¿Deseas *combinar sabores* en tu pizza? 🍕 (mitad y mitad; la de 8 y 12 hasta 3 sabores)'
      : '🍕 ¿Deseas *combinar sabores* en tu pizza? (mitad y mitad; la de 8 y 12 hasta 3 sabores)', [
      { type: 'reply', reply: { id: 'pz_si', title: 'Sí, combinar 🍕' } },
      { type: 'reply', reply: { id: 'pz_no', title: pideCarta ? 'No, un solo sabor' : 'No, ver la carta' } },
    ]);
    s.comboPreguntaCarta = !pideCarta;
    return true;
  }

  /** Botones y listas pz_* / pzc_*. Devuelve true si el id era de pizzas. */
  async botonPizza(to, id) {
    const s = sesion(to);
    if (id === 'pz_si') {
      const b = s.comboBorrador ?? {};
      s.comboBorrador = null;
      return this.iniciarCombo(to, { ...b, origen: 'texto' }), true;
    }
    if (id === 'pz_no') {
      const mostrarCarta = s.comboPreguntaCarta;
      s.comboBorrador = null; s.comboPreguntaCarta = false;
      if (mostrarCarta) await this.handleMenuOption(to, 'cat:pizzas');
      else await whatsappService.sendMessage(to, 'Perfecto 👌 Agrégala al carrito 🛒 y envíalo cuando tengas todo.');
      return true;
    }
    if (id.startsWith('pz_t:')) return this.comboTamano(to, Number(id.slice(5))), true;
    if (id === 'pz_n2' || id === 'pz_n3') return this.comboNumeroSabores(to, Number(id.slice(4))), true;
    if (id.startsWith('pz_s:')) return this.comboSaborElegido(to, id.slice(5)), true;
    if (id === 'pz_ok') return this.comboConfirmar(to), true;
    if (id === 'pz_cambiar') return this.comboReiniciarSabores(to), true;
    if (id === 'pz_cancel') return this.comboCancelar(to), true;
    if (id === 'pzc_si' || id === 'pzc_no') return this.comboRespuestaCarrito(to, id === 'pzc_si'), true;
    if (id === 'pz_todas' || id === 'pz_una') return this.comboCantidadCarrito(to, id === 'pz_todas'), true;
    return false;
  }

  /** Arranca (o continúa) la combinación con lo que ya se sabe y pregunta lo que falte. */
  async iniciarCombo(to, { tamano = null, sabores = [], ambiguos = [], nSabores = null, cantidad = 1, origen = 'texto', linea = null } = {}) {
    const s = sesion(to);
    s.combo = { paso: null, tamano, sabores: [...sabores], ambiguos: [...ambiguos], nSabores, cantidad: cantidad || 1, origen, linea };
    return this.comboSiguientePaso(to);
  }

  /** Decide qué falta y lo pregunta. */
  async comboSiguientePaso(to) {
    const s = sesion(to);
    const c = s.combo;
    if (!c) return;
    if (c.ambiguos.length) return this.comboPreguntarAmbiguo(to);
    if (!c.tamano) return this.comboPreguntarTamano(to);
    const max = maxSabores(c.tamano);
    if (max >= 3 && !c.nSabores && c.sabores.length < 2) return this.comboPreguntarNumeroSabores(to);
    if (c.nSabores && c.nSabores > max) {
      c.nSabores = max;
      await whatsappService.sendMessage(to, `La de *${c.tamano} porciones* se combina con máximo *${max} sabores*: seguimos con ${max} 👌`);
    }
    const n = c.nSabores ?? (c.sabores.length >= 2 ? Math.min(c.sabores.length, max) : 2);
    c.nSabores = n;
    if (c.sabores.length > n) {
      const fuera = c.sabores.slice(n);
      c.sabores = c.sabores.slice(0, n);
      await whatsappService.sendMessage(to, `La de *${c.tamano} porciones* se combina con máximo *${n} sabores* (${repartoDe(c.tamano, n).join('+')}) 🙂\nTomo *${c.sabores.join('* y *')}* y dejo por fuera ${fuera.join(', ')}. Si prefieres otros, toca *Cambiar sabores*.`);
    }
    if (c.sabores.length < n) return this.comboPedirSabores(to);
    const problema = validar({ tamano: c.tamano, sabores: c.sabores });
    if (problema) {
      await whatsappService.sendMessage(to, problema);
      if (/tamaño|porciones\*\. ¿De/.test(problema)) { c.tamano = null; return this.comboPreguntarTamano(to); }
      c.sabores = []; return this.comboPedirSabores(to);
    }
    return this.comboResumen(to);
  }

  async comboPreguntarTamano(to) {
    const c = sesion(to).combo;
    c.paso = 'tamano';
    const conSabores = c.sabores.length >= 2 ? c.sabores : null;
    const rows = TAMANOS.map((t) => {
      const base = conSabores ? precioCombinada(t, conSabores) : null;
      const desde = base ? cop(base.precio) : `desde ${cop(Math.min(...[...SABORES.values()].map((e) => e.tamanos[t]?.precio ?? Infinity)))}`;
      const max = maxSabores(t);
      return { id: `pz_t:${t}`, title: `${t} porciones`, description: `${max === 2 ? 'mitad y mitad' : `2 o 3 sabores`} · ${desde}`.slice(0, 72) };
    });
    await whatsappService.sendListMessage(to, {
      header: '🍕 ¿De cuántas porciones?',
      body: conSabores ? `Tu pizza ${c.sabores.join(' + ')}: elige el tamaño 👇` : 'Elige el tamaño de tu pizza combinada 👇',
      footer: "Black's Pizza",
      button: 'Elegir tamaño',
      sections: [{ title: 'Tamaños', rows }],
    });
  }

  async comboTamano(to, tamano) {
    const c = sesion(to).combo;
    if (!c) return this.iniciarCombo(to, { tamano });
    if (!TAMANOS.includes(tamano)) return;
    c.tamano = tamano;
    if (c.nSabores && c.nSabores > maxSabores(tamano)) c.nSabores = null;
    return this.comboSiguientePaso(to);
  }

  async comboPreguntarNumeroSabores(to) {
    const c = sesion(to).combo;
    c.paso = 'nsabores';
    const r = REPARTOS[c.tamano];
    await whatsappService.sendInteractiveButtons(to, `Pizza de *${c.tamano} porciones* 🍕\n¿De cuántos sabores la quieres?`, [
      { type: 'reply', reply: { id: 'pz_n2', title: `2 sabores (${r[2].join('+')})` } },
      { type: 'reply', reply: { id: 'pz_n3', title: `3 sabores (${r[3].join('+')})` } },
    ]);
  }

  async comboNumeroSabores(to, n) {
    const c = sesion(to).combo;
    if (!c) return;
    c.nSabores = n;
    if (c.sabores.length > n) c.sabores = c.sabores.slice(0, n);
    return this.comboSiguientePaso(to);
  }

  async comboPedirSabores(to) {
    const c = sesion(to).combo;
    c.paso = 'sabores';
    const n = c.nSabores;
    const reparto = repartoDe(c.tamano, n);
    const faltan = n - c.sabores.length;
    const ya = c.sabores.length ? `Ya tengo: *${c.sabores.join('* y *')}*.\n` : '';
    const pide = faltan === n
      ? `Escribe los *${n} sabores* que quieres (por ejemplo: "hawaiana y mexicana")`
      : `Escribe ${faltan === 1 ? 'el otro sabor' : `los otros ${faltan} sabores`}`;
    await whatsappService.sendMessage(to, `🍕 *Pizza de ${c.tamano} porciones · ${n} sabores* (${reparto.join(' + ')} porciones)\n${ya}${pide} 👇\n\n${textoSabores(c.tamano)}\n\n_Se cobra el precio del sabor más caro._`);
  }

  async comboPreguntarAmbiguo(to) {
    const c = sesion(to).combo;
    c.paso = 'ambiguo';
    const candidatos = c.ambiguos[0];
    await whatsappService.sendListMessage(to, {
      header: '🍕 ¿Cuál de estas?',
      body: `Tenemos varias pizzas con eso. ¿Cuál quieres? 👇`,
      footer: "Black's Pizza",
      button: 'Elegir sabor',
      sections: [{ title: 'Sabores', rows: candidatos.slice(0, 10).map((sab) => ({ id: `pz_s:${sab}`, title: sab.slice(0, 24), description: c.tamano && SABORES.get(sab)?.tamanos[c.tamano] ? cop(SABORES.get(sab).tamanos[c.tamano].precio) : undefined })) }],
    });
  }

  async comboSaborElegido(to, sabor) {
    const c = sesion(to).combo;
    if (!c || !SABORES.has(sabor)) return;
    c.ambiguos.shift();
    if (!c.sabores.includes(sabor)) c.sabores.push(sabor);
    return this.comboSiguientePaso(to);
  }

  /** Texto del cliente mientras arma la combinación (sabores, tamaño, "cancelar"). */
  async atenderComboTexto(to, t) {
    const s = sesion(to);
    const c = s.combo;
    const lower = normalizar(t);
    if (/^(cancelar|cancela|no quiero|ya no|olvidalo|dejalo asi)\b/.test(lower)) return this.comboCancelar(to);
    const leido = leerPedidoPizza(t);
    if (c.paso === 'resumen') {
      if (/^(si|sí|ok|listo|dale|confirmo|agrega|agregar|esta bien|correcto)\b/.test(lower)) return this.comboConfirmar(to);
      if (/^(no|cambiar|cambia|otro)\b/.test(lower) && !leido.sabores.length) return this.comboReiniciarSabores(to);
    }
    let algo = false;
    if (leido.tamano && leido.tamano !== c.tamano) { c.tamano = leido.tamano; if (c.nSabores && c.nSabores > maxSabores(c.tamano)) c.nSabores = null; algo = true; }
    if (leido.nSabores) { c.nSabores = leido.nSabores; algo = true; }
    // "no, mexicana y ranchera" en el resumen → se reemplazan los sabores.
    if (leido.sabores.length >= 2 && c.paso === 'resumen') { c.sabores = []; }
    for (const sab of leido.sabores) if (!c.sabores.includes(sab)) { c.sabores.push(sab); algo = true; }
    for (const amb of leido.ambiguos) { c.ambiguos.push(amb); algo = true; }
    if (!algo) {
      const ayuda = c.paso === 'tamano' ? 'Dime el tamaño: *4, 6, 8 o 12 porciones* 🙂'
        : c.paso === 'nsabores' ? '¿De *2* o de *3* sabores? 🙂'
        : c.paso === 'resumen' ? 'Responde con los botones 👆 o escribe *cancelar*.'
        : `No encontré ese sabor 🙈. Escríbelo como aparece en la lista (por ejemplo: "hawaiana y mexicana") o *cancelar*.`;
      await whatsappService.sendMessage(to, ayuda);
      return;
    }
    return this.comboSiguientePaso(to);
  }

  async comboResumen(to) {
    const c = sesion(to).combo;
    c.paso = 'resumen';
    const item = armarItem({ tamano: c.tamano, sabores: c.sabores, cantidad: c.cantidad });
    if (!item) { await whatsappService.sendMessage(to, 'No pude armar esa combinación 😔. Escribe *asesor* y una persona te ayuda.'); return this.comboCancelar(to, { silencio: true }); }
    c.item = item;
    await whatsappService.sendInteractiveButtons(to, `${textoResumen(item)}\n\n¿Así está bien?`.slice(0, 1024), [
      { type: 'reply', reply: { id: 'pz_ok', title: c.origen === 'carrito' ? 'Sí, así ✅' : 'Agregar al pedido ✅' } },
      { type: 'reply', reply: { id: 'pz_cambiar', title: 'Cambiar sabores ✏️' } },
      { type: 'reply', reply: { id: 'pz_cancel', title: 'Cancelar ✖' } },
    ]);
  }

  async comboReiniciarSabores(to) {
    const c = sesion(to).combo;
    if (!c) return;
    c.sabores = []; c.ambiguos = []; c.item = null;
    return this.comboSiguientePaso(to);
  }

  async comboCancelar(to, { silencio = false } = {}) {
    const s = sesion(to);
    const c = s.combo;
    s.combo = null;
    if (c?.origen === 'carrito') {
      if (!silencio) await whatsappService.sendMessage(to, 'Listo, la dejo de un solo sabor 👌');
      return this.comboSeguirCarrito(to);
    }
    if (!silencio) await whatsappService.sendMessage(to, 'Listo, no combinamos 👌. Si quieres, escribe *pizzas* para ver la carta.');
  }

  /** "Agregar al pedido" / "Sí, así": la pizza combinada entra al pedido. */
  async comboConfirmar(to) {
    const s = sesion(to);
    const c = s.combo;
    if (!c?.item) return;
    s.combo = null;
    if (c.origen === 'carrito' && Number.isInteger(c.linea) && s.productos?.[c.linea]) {
      // Reemplaza la línea del carrito (o la parte que se combina) y sigue con las demás pizzas.
      const original = s.productos[c.linea];
      const restantes = (Number(original.quantity) || 1) - c.item.quantity;
      const lista = [...s.productos];
      lista[c.linea] = { ...c.item, comboPreguntado: true };
      if (restantes > 0) lista.splice(c.linea + 1, 0, { ...original, quantity: restantes, comboPreguntado: true });
      const { pedidoStr, monto } = this.resumenCarrito(lista);
      nuevoPedido(to, { productos: lista, pedidoStr, monto });
      s.pedido = { ...(s.pedido ?? {}), estado: 'confirmar' };
      s.comboPendientes = (s.comboPendientes ?? []).map((i) => (i > c.linea && restantes > 0 ? i + 1 : i));
      return this.comboSeguirCarrito(to);
    }
    // Vino por texto: se suma al pedido pendiente o abre uno nuevo, y sigue el flujo de siempre.
    return this.aplicarCarrito(to, [c.item], this.pedidoPendiente(to) ? 'agregar' : 'nuevo');
  }

  // ---- Carrito con pizzas: "¿Deseas combinar las porciones?" por cada línea ----------------

  /** Líneas del pedido que son pizzas de un solo sabor y aún no se les preguntó. */
  pizzasSinPreguntar(to) {
    const s = sesion(to);
    return (s.productos ?? []).map((p, i) => (esPizza(p.product_retailer_id) && !p.combinada && !p.comboPreguntado ? i : -1)).filter((i) => i >= 0);
  }

  /** Antes de "¿Está todo bien?": si hay pizzas sin preguntar, pregunta por la primera. Devuelve true si preguntó. */
  async comboPreguntarCarrito(to) {
    const s = sesion(to);
    const pendientes = this.pizzasSinPreguntar(to);
    if (!pendientes.length) return false;
    s.comboPendientes = pendientes;
    const i = pendientes[0];
    const p = s.productos[i];
    const { sabor, tamano } = PIZZA_POR_ID.get(String(p.product_retailer_id));
    s.comboLinea = i;
    const max = maxSabores(tamano);
    await whatsappService.sendInteractiveButtons(to, `Tu pedido tiene *Pizza ${sabor} (${tamano} porciones)*${p.quantity > 1 ? ` x${p.quantity}` : ''} 🍕\n\n¿Deseas *combinar las porciones* con otro sabor? (${max === 2 ? 'mitad y mitad' : 'hasta 3 sabores'}; se cobra el sabor más caro)`, [
      { type: 'reply', reply: { id: 'pzc_si', title: 'Sí, combinar 🍕' } },
      { type: 'reply', reply: { id: 'pzc_no', title: 'No, así está bien' } },
    ]);
    return true;
  }

  async comboRespuestaCarrito(to, combinar) {
    const s = sesion(to);
    const i = s.comboLinea;
    const p = Number.isInteger(i) ? s.productos?.[i] : null;
    if (!p) return this.comboSeguirCarrito(to);
    if (!combinar) { p.comboPreguntado = true; return this.comboSeguirCarrito(to); }
    const { sabor, tamano } = PIZZA_POR_ID.get(String(p.product_retailer_id));
    if ((Number(p.quantity) || 1) > 1) {
      s.comboBorrador = { tamano, sabores: [sabor], linea: i };
      await whatsappService.sendInteractiveButtons(to, `Tienes *${p.quantity}* pizzas ${sabor} de ${tamano} porciones. ¿Las combinamos todas igual o solo una?`, [
        { type: 'reply', reply: { id: 'pz_todas', title: `Las ${p.quantity} iguales` } },
        { type: 'reply', reply: { id: 'pz_una', title: 'Solo una' } },
      ]);
      return;
    }
    return this.iniciarCombo(to, { tamano, sabores: [sabor], cantidad: 1, origen: 'carrito', linea: i });
  }

  async comboCantidadCarrito(to, todas) {
    const s = sesion(to);
    const b = s.comboBorrador;
    s.comboBorrador = null;
    const p = b && s.productos?.[b.linea];
    if (!p) return this.comboSeguirCarrito(to);
    return this.iniciarCombo(to, { tamano: b.tamano, sabores: b.sabores, cantidad: todas ? Number(p.quantity) || 1 : 1, origen: 'carrito', linea: b.linea });
  }

  /** Siguiente pizza sin preguntar o, si no hay, "¿Está todo bien?". */
  async comboSeguirCarrito(to) {
    const s = sesion(to);
    s.comboLinea = null;
    if (await this.comboPreguntarCarrito(to)) return;
    s.comboPendientes = null;
    if (this.pedidoPendiente(to)) { await this.pedirConfirmacion(to, { modo: s.comboModo ?? 'nuevo' }); this.programarRecordatorio(to); }
    s.comboModo = null;
  }
}

export default new MessageHandler();
