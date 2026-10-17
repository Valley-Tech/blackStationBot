export function logAxiosError(context, error) {
  if (error.response) {
    // El servidor (Meta) respondió con un error
    console.error(`[${context}] Error ${error.response.status}:`,
      JSON.stringify(error.response.data?.error ?? error.response.data)
    );
  } else if (error.request) {
    // La petición se hizo pero no hubo respuesta (timeout, red caída, etc.)
    console.error(`[${context}] Sin respuesta del servidor:`, error.message);
  } else {
    // Error antes de siquiera enviar la petición
    console.error(`[${context}] Error de configuración:`, error.message);
  }
}