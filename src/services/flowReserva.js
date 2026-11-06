import messageHandler from './messageHandler.js';
import { horaReserva, fechaReserva } from './datosFlow.js';

const SCREEN_RESPONSES = {
  RESUMEN: {
    screen: "RESUMEN",
    data: {},
  },
  SUCCESS: {
    screen: "SUCCESS",
    data: {},
  },
};

export const nextScreen = async (decryptedBody, numero) => {
  const { screen, data, version, action, flow_token } = decryptedBody;
  // Flow de RESERVA: mismas pantallas que SamuelitoBot (RESERVA → RESUMEN → SUCCESS).
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
    switch (screen) {
      case "RESERVA":  
        // Hora y fecha según el motivo: las mismas funciones que usan la plantilla y Google Sheets (datosFlow.js).

        const details = `Nombre:    ${data.nombre}\n
Celular: ${data.celular}\n
Motivo de reserva: ${data.evento}\n
Fecha de reserva:   ${fechaReserva(data)}\n
Hora de reserva:  ${horaReserva(data)}\n
Cuantas personas:   ${data.cuantos}`;
        return {
          ...SCREEN_RESPONSES.RESUMEN,
          data: {
            details,
            ...data,
          },
        };
      case "RESUMEN":
        messageHandler.completeAppointment({...data}, numero);
        return {
          ...SCREEN_RESPONSES.SUCCESS,
          data: {
            extension_message_response: {
              params: {
                flow_token,
              },
            },
          },
        };

      default:
        break;
    }
  }

  console.error("Unhandled request body:", decryptedBody);
  throw new Error(
    "Unhandled endpoint request. Make sure you handle the request action & screen logged above."
  );
};
