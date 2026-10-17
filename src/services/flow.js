import messageHandler from '../services/messageHandler.js';
import negocio from '../config/negocio.js';

// Flow de PEDIDO: mismas pantallas que SamuelitoBot (DETAILS → SUMMARY → SUCCESS).
const SCREEN_RESPONSES = {
  SUMMARY: {
    screen: "SUMMARY",
    data: {},
  },
  SUCCESS: {
    screen: "SUCCESS",
    data: {},
  },
};

const cop = (n) => `$${Number(n || 0).toLocaleString('es-CO')}`;

export const getNextScreen = async (decryptedBody, productos, total, pedidoStr, numero) => {
  const { screen, data, version, action, flow_token } = decryptedBody;
  // handle health check request
  if (action === "ping") {
    return {
      data: {
        status: "active",
      },
    };
  }

  // handle error notification
  if (data?.error) {
    console.warn("Received client error:", data);
    return {
      data: {
        acknowledged: true,
      },
    };
  }

  if (action === "data_exchange") {
    let result;
    switch (screen) {
      case "DETAILS": {
        // El domicilio se suma solo si el cliente escribió dirección.
        const conDomicilio = Boolean(data.address);
        const totalFinal = (Number(total) || 0) + (conDomicilio ? negocio.domicilio : 0);
        const lineas = [
          `Nombre:    ${data.name}\n`,
          `Pedido: \n${pedidoStr}\n`,
          `Total: ${cop(totalFinal)}${conDomicilio && negocio.domicilio ? ` (Domicilio: ${cop(negocio.domicilio)})` : ''}\n`,
          ...(conDomicilio ? [`Dirección:    ${data.address}\n`] : []),
          `Celular de contacto:    ${data.phone}\n`,
          `Medio de pago:    ${data.pago}`,
          ...(data.recomendacion ? [`\nRecomendaciones:    ${data.recomendacion}`] : []),
        ];
        result = {
          ...SCREEN_RESPONSES.SUMMARY,
          data: {
            details: lineas.join('\n'),
            ...data,
            screen
          },
        };
        break;
      }
      case "SUMMARY":
        messageHandler.completeHiring(pedidoStr, data, numero);
        messageHandler.completeOrder(productos, data);
        result = {
          ...SCREEN_RESPONSES.SUCCESS,
          data: {
            extension_message_response: {
              params: {
                flow_token,
              },
            },
          },
        };
        break;
      default:
          break;
    }
    if (result) return result;
  }

  console.error("Unhandled request body:", decryptedBody);
  throw new Error(
    "Unhandled endpoint request. Make sure you handle the request action & screen logged above."
  );
};
