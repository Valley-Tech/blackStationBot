import sendToWhatsApp from "../services/httpRequest/sendToWhatsApp.js";

/** Variable de plantilla válida para Meta: sin saltos de línea, sin espacios dobles y nunca vacía. */
function limpiarVariable(v) {
  const t = String(v ?? '')
    .replace(/[\n\t]/g, ' ')      // saltos de línea y tabs -> espacio
    .replace(/ {2,}/g, ' ')       // colapsa espacios múltiples
    .trim();
  return t || '-';
}

class WhatsAppService {
  async sendMessage(to, body, messageId) {
    try {
      const data = {
        messaging_product: 'whatsapp',
        to: to,
        text: { body },
      };

      await sendToWhatsApp(data);
    } catch (error) {
      console.error('Error sending message:', error);
    }
  }

  async markAsRead(messageId) {
    try {
      const data = {
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: messageId,
      };
  
      await sendToWhatsApp(data);
    } catch (error) {
      console.error('Error marking message as read:', error);
    }
  }

  async sendInteractiveButtons(to, bodyText, buttons) {
    try {
      const data = {
        messaging_product: 'whatsapp',
        to: to,
        type: 'interactive',
        interactive: {
          type: "button",
          body: { text: bodyText },
          action: {
            buttons: buttons,
          },
        },
      };

      await sendToWhatsApp(data);
    } catch (error) {
      console.error("Error: ", error);
    }
  }

  async sendFlow(to, action) {
    try {
      const data = {
        recipient_type: 'individual',
        messaging_product: 'whatsapp',
        to: to,
        type: 'interactive',
        interactive: {
          type: "flow",
          header: {
            type: "text",
            text: "Datos de envío:"
          },
          body: { 
            text: "Haz clic aquí 👇" 
          },
          action
        },
      };
      
    await sendToWhatsApp(data);
    } catch (error) {
      console.error("Error: ", error);
    }
  }

  async sendTemplateReserva(to, imageUrl, variables) {
    const data = {
      messaging_product: 'whatsapp',
      to: to,
      type: 'template',
      template: {
        name: "confirmacion_reserva",
        language: { code: "es_CO" },
        components: [
          {
            type: "header",
            parameters: [
              {
                type: "image",
                image: { link: imageUrl }
              }
            ]
          },
          {
            type: "body",
            // Meta rechaza variables vacías o con saltos de línea: se limpian aquí.
            parameters: variables.slice(0, 7).map((v) => ({ type: "text", text: limpiarVariable(v) }))
          }
        ]
      }
    };
    await sendToWhatsApp(data);
  }

  async sendTemplateComprobantePago(to, template, imageUrl, variables) {
    try {
      const safeVariables = variables.map(limpiarVariable);
    const data = {
      messaging_product: 'whatsapp',
      to: to,
      type: 'template',
      template: {
        name: template,
        language: { code: "es_CO" },
        components: [
          {
            type: "header",
            parameters: [
              {
                type: "image",
                image: { link: imageUrl }
              }
            ]
          },
          {
            type: "body",
            parameters: safeVariables.map(text => ({ type: "text", text }))
          }
        ]
      }
    };
    await sendToWhatsApp(data);
    } catch (error) {
      console.error("Error: ", error);
    }
  }
  
  async sendFlowReserva(to, action) {
    try {
      const data = {
        recipient_type: 'individual',
        messaging_product: 'whatsapp',
        to: to,
        type: 'interactive',
        interactive: {
          type: "flow",
          header: {
            type: "text",
            text: "Reserva tu mesa:"
          },
          body: { 
            text: "Haz clic aquí 👇" 
          },
          action
        },
      };
  
    await sendToWhatsApp(data);
    } catch (error) {
      console.error("Error: ", error);
    }
  }
  
  async sendMenu(to, template) {
    try {
      const data = {
        recipient_type: 'individual',
        messaging_product: 'whatsapp',
        to: to,
        type: 'interactive',
        interactive: template
      };
  
    await sendToWhatsApp(data);
    } catch (error) {
      console.error("Error: ", error);
    }
  }

  async sendCatalogo(to, template) {
    try {
      const data = {
        recipient_type: 'individual',
        messaging_product: 'whatsapp',
        to: to,
        type: 'template',
        template: template
      };
  
    await sendToWhatsApp(data);
    } catch (error) {
      console.error("Error: ", error);
    }
  }
  
  async sendFlowEncuesta(to, action) {
    try {
      const data = {
        recipient_type: 'individual',
        messaging_product: 'whatsapp',
        to: to,
        type: 'interactive',
        interactive: {
          type: "flow",
          header: {
            type: "text",
            text: "Encuesta de satisfacción:"
          },
          body: { 
            text: "Diligenciala aquí 👇" 
          },
          action
        },
      };
  
    await sendToWhatsApp(data);
    } catch (error) {
      console.error("Error: ", error);
    }
  }

  async sendMediaMessage(to, type, mediaUrl, caption = '', filename = 'carta-LaEstacion.pdf') {
    try {
      
      const mediaObject = {};
  
      switch (type) {
        case 'image':
          mediaObject.image = { link: mediaUrl, caption: caption };
          break;
        case 'audio':
          mediaObject.audio = { link: mediaUrl };
          break;
        case 'video':
          mediaObject.video = { link: mediaUrl, caption: caption };
          break;
        case 'document':
          mediaObject.document = { link: mediaUrl, caption: caption, filename };
          break;
        default:
          throw new Error('Not Supported Media Type');
      }
  
      const data = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: to,
        type: type,
        ...mediaObject,
      };
  
      await sendToWhatsApp(data);
    } catch (error) {
      console.error("Error: ", error);
    }
  }

  /** Mensaje de lista (selector de cartas, tamaños de pizza…). */
  async sendListMessage(to, { header, body, footer, button, sections }) {
    try {
      const data = {
        recipient_type: 'individual',
        messaging_product: 'whatsapp',
        to: to,
        type: 'interactive',
        interactive: {
          type: 'list',
          ...(header ? { header: { type: 'text', text: header.slice(0, 60) } } : {}),
          body: { text: body },
          ...(footer ? { footer: { text: footer.slice(0, 60) } } : {}),
          action: { button: button.slice(0, 20), sections },
        },
      };
      await sendToWhatsApp(data);
    } catch (error) {
      console.error("Error: ", error);
    }
  }

  async sendContactMessage(to, contact) {
    try {
      const data = {
        messaging_product: 'whatsapp',
        to: to,
        type: 'contacts',
        contacts: [contact],
      };
  
      await sendToWhatsApp(data);
      
    } catch (error) {
      console.error("Error: ", error);
    }
  }

  async sendLocationMessage(to, latitude, longitude, name, address) {
    try {
      
      const data = {
        messaging_product: 'whatsapp',
        to: to,
        type: 'location',
        location: {
          latitude: latitude,
          longitude: longitude,
          name: name,
          address: address
        }
      };
      
      await sendToWhatsApp(data);
    } catch (error) {
      console.error("Error: ", error);
    }
  }
}

export default new WhatsAppService();