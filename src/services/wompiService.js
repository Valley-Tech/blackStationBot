import axios from 'axios';

const WOMPI_BASE_URL = process.env.URL_BASE_WOMPI;
const WOMPI_PUBLIC_KEY = process.env.WOMPI_PUBLIC_KEY;
const WOMPI_PRIVATE_KEY = process.env.WOMPI_PRIVATE_KEY;

export const createWompiPaymentLink = async (amountInCents, currency, description) => {
  try {
    const response = await axios.post(
      `${WOMPI_BASE_URL}/payment_links`,
      {
        name  : "La Estación Parrilla Bar",
        description : description,
        single_use : true,
        collect_shipping: false,
        currency: currency,
        amount_in_cents: amountInCents
        },
      {
        headers: {
          Authorization: `Bearer ${WOMPI_PRIVATE_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );
    return response.data.data.id; // Devuelve el id de pago
  } catch (error) {
    console.error("Error al crear el enlace de pago WOMPi:", error.response?.data || error.message);
    throw new Error("No se pudo generar el enlace de pago.");
  }
};

// Nueva función para consultar el estado de una transacción
export const getWompiTransactionStatus = async (transactionId) => {
  try {
    const response = await axios.get(
      `${WOMPI_BASE_URL}/transactions/${transactionId}`,
      {
        headers: {
          Authorization: `Bearer ${WOMPI_PUBLIC_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );
    // El estado está en response.data.data.status
    return response.data.data.status; // "APPROVED", "DECLINED", etc.
  } catch (error) {
    console.error("Error al consultar el estado de la transacción WOMPi:", error.response?.data || error.message);
    throw new Error("No se pudo consultar el estado de la transacción.");
  }
};