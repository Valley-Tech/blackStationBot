import messageHandler from './messageHandler.js';

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
      const horaReserva = data.evento === "Festival Gastronomico" 
  ? data.hora 
  : data.evento === "Cumpleaños" 
    ? data.horario
    : data.evento === "Reserva normal"
    ? data.horanormal
    : "";

    const calendario = data.evento === "Festival Gastronomico" 
      ? data.fechafestival 
      : data.evento === "Cumpleaños" 
        ? data.fecha
        : data.evento === "Reserva normal"
        ? data.fechanormal
        : "";
        
        const details = `Nombre:    ${data.nombre}\n
Celular: ${data.celular}\n
Motivo de reserva: ${data.evento}\n
Fecha de reserva:   ${calendario}\n
Hora de reserva:  ${horaReserva}\n
Cuantas personas:   ${data.cuantos}\n
De donde nos visitas:   ${data.donde}`;
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
