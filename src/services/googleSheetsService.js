import { google } from 'googleapis';
import { reportarFalla } from './reportarFallas.js';

const sheets = google.sheets('v4');

/**
 * Explica en español por qué Google Sheets rechazó la operación, para el log y
 * para Analítica → Fallas del CRM (403 = la hoja no está compartida con la cuenta de servicio).
 */
function explicarErrorSheets(error, spreadsheetId) {
  const status = error?.code ?? error?.status ?? error?.response?.status;
  const cuenta = process.env.GOOGLE_CLIENT_EMAIL || '(GOOGLE_CLIENT_EMAIL vacío en Railway)';
  const hoja = spreadsheetId || '(sin ID)';
  let mensaje;
  if (!spreadsheetId) mensaje = 'Google Sheets: falta el ID de la hoja (SPREADSHEETID_PEDIDO / SPREADSHEETID_RESERVA / SPREADSHEETID_SURVEY en Railway)';
  else if (Number(status) === 403) mensaje = `Google Sheets 403: la cuenta de servicio ${cuenta} no tiene permiso sobre la hoja ${hoja}. Ábrela → Compartir → agrega ${cuenta} como Editor`;
  else if (Number(status) === 404) mensaje = `Google Sheets 404: no existe una hoja con el ID ${hoja} (revisa el ID en Railway: es lo que va entre /d/ y /edit en el enlace)`;
  else if (/plantilla "ORIGINAL"/.test(error?.message ?? '')) mensaje = `Google Sheets: la hoja ${hoja} no tiene la pestaña "ORIGINAL" (es la plantilla que se copia cada día)`;
  else if (/not supported for this document/i.test(error?.message ?? '')) mensaje = `Google Sheets: el archivo ${hoja} es un Excel (.xlsx). Ábrelo y usa Archivo → Guardar como Hojas de cálculo de Google, y pon el ID nuevo en Railway`;
  else mensaje = `Google Sheets: ${error?.message ?? error}`;
  return Object.assign(new Error(mensaje), { code: status ? `SHEETS_${status}` : 'SHEETS', stack: `${mensaje}\n${String(error?.stack ?? '').split('\n').slice(1).join('\n')}` });
}

/** La clave privada del .env (Railway guarda los saltos de línea como \\n). */
const clavePrivada = () => String(process.env.GOOGLE_PRIVATE_KEY ?? '').replace(/\\n/g, '\n');

// Obtiene la fecha actual en formato DD/MM/YYYY usando la zona horaria de Colombia
function getTodaySheetName() {
    const now = new Date();
    // Convierte a zona horaria de Colombia (America/Bogota - UTC-5)
    const localDate = new Date(now.toLocaleString('en-US', { timeZone: 'America/Bogota' }));
    const day = String(localDate.getDate()).padStart(2, '0');
    const month = String(localDate.getMonth() + 1).padStart(2, '0');
    const year = localDate.getFullYear();
    return `${day}/${month}/${year}`;
}

const TEMPLATE_SHEET_NAME = "ORIGINAL";

// Obtiene el ID de una hoja por su nombre
async function getSheetIdByName(auth, spreadsheetId, sheetName) {
    const getSheets = await sheets.spreadsheets.get({
        spreadsheetId,
        auth,
    });
    const sheet = getSheets.data.sheets.find(
        (s) => s.properties.title === sheetName
    );
    return sheet ? sheet.properties.sheetId : null;
}

// Duplica la hoja plantilla si no existe la hoja del día
async function ensureSheetExists(auth, spreadsheetId, sheetName) {
    const getSheets = await sheets.spreadsheets.get({
        spreadsheetId,
        auth,
    });
    const exists = getSheets.data.sheets.some(
        (sheet) => sheet.properties.title === sheetName
    );
    if (!exists) {
        // Obtén el ID de la hoja plantilla
        const templateSheetId = await getSheetIdByName(auth, spreadsheetId, TEMPLATE_SHEET_NAME);
        if (templateSheetId === null || templateSheetId === undefined) {
            throw new Error(`No se encontró la hoja plantilla "${TEMPLATE_SHEET_NAME}"`);
        }
        // Duplica la hoja plantilla
        await sheets.spreadsheets.batchUpdate({
            spreadsheetId,
            auth,
            requestBody: {
                requests: [
                    {
                        duplicateSheet: {
                            sourceSheetId: templateSheetId,
                            newSheetName: sheetName,
                        },
                    },
                ],
            },
        });
    }
}

export const saveUserDataByNumber = async (datos, spreadsheetId) => {
  try {
    const auth = new google.auth.GoogleAuth({
      credentials: {
        type: process.env.GOOGLE_TYPE,
        project_id: process.env.GOOGLE_PROJECT_ID,
        private_key_id: process.env.GOOGLE_PRIVATE_KEY_ID,
        private_key: clavePrivada(),
        client_email: process.env.GOOGLE_CLIENT_EMAIL,
        client_id: process.env.GOOGLE_CLIENT_ID,
        auth_uri: process.env.GOOGLE_AUTH_URI,
        token_uri: process.env.GOOGLE_TOKEN_URI || process.env.TOKEN_URI,
        auth_provider_x509_cert_url: process.env.GOOGLE_AUTH_PROVIDER_X509_CERT_URL,
        client_x509_cert_url: process.env.GOOGLE_CLIENT_X509_CERT_URL,
      },
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    const authClient = await auth.getClient();
    const sheetName = getTodaySheetName();

    // Leemos todas las filas (A2:H, suponiendo que la fecha/hora está en la columna H)
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${sheetName}!A2:H`,
      auth: authClient,
    });

    const rows = response.data.values || [];
    const numero = datos.numero;
    const fechayhora = datos.fechayhora;

    // Busca la fila por número y fecha/hora exactos
    const rowIndex = rows.findIndex(row => row[0] == numero && row[7] == fechayhora);
    if (rowIndex === -1) {
      console.error(`No se encontró el pedido para número ${numero} y fecha/hora ${fechayhora}`);
      return false;
    }
    const sheetRow = rowIndex + 2; // A2 = fila 2

    // Actualiza solo la columna "Estado del Pago" (ajusta la letra si tu hoja cambia)
    const updateRange = `${sheetName}!I${sheetRow}`;
    const estadoPago = datos.estado;
    const values = [[estadoPago]];

    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: updateRange,
      valueInputOption: 'RAW',
      resource: { values },
      auth: authClient,
    });

    return true;
  } catch (error) {
    const falla = explicarErrorSheets(error, spreadsheetId);
    console.error("Error guardando estado de pago:", falla.message);
    reportarFalla(falla, { level: 'warning', step: 'guardar el estado del pago en Google Sheets', numero: datos?.numero });
    return false;
  }
};

// ---------------------------------------------------------------------------
//  Escritura de filas: de arriba hacia abajo (v3.4.3)
// ---------------------------------------------------------------------------
// Antes se usaba values.append: Google Sheets busca dónde "termina la tabla" y
// escribe DEBAJO de ella. Con una Tabla de Sheets (encabezado verde con filtros)
// las filas vacías ya formateadas cuentan como parte de la tabla, así que la
// reserva quedaba al final (fila 16) en vez de en la fila 2. Ahora se busca la
// primera fila libre (columna A vacía) desde la fila 2 y se escribe ahí.

const rango = (sheetName, a1) => `'${String(sheetName).replace(/'/g, "''")}'!${a1}`;
const sinTildes = (t) => String(t ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();

// Escrituras en serie por hoja: dos reservas al mismo tiempo no caen en la misma fila.
const colas = new Map();
function enSerie(clave, tarea) {
    const anterior = colas.get(clave) ?? Promise.resolve();
    const siguiente = anterior.catch(() => {}).then(tarea);
    colas.set(clave, siguiente);
    siguiente.finally(() => { if (colas.get(clave) === siguiente) colas.delete(clave); }).catch(() => {});
    return siguiente;
}

/** Fila (número) de la primera celda vacía en la columna A, desde la fila 2. */
async function primeraFilaLibre(auth, spreadsheetId, sheetName) {
    const { data } = await sheets.spreadsheets.values.get({ spreadsheetId, range: rango(sheetName, 'A2:A'), auth });
    const valores = data.values || [];
    const libre = valores.findIndex((fila) => !String(fila?.[0] ?? '').trim());
    return 2 + (libre === -1 ? valores.length : libre);
}

/**
 * Campos que se pueden guardar por NOMBRE de columna (fila 1 de la hoja).
 * Así no importa el orden de tus columnas ni si agregas otras (p. ej. "Estado de Reserva",
 * que el bot deja vacía para que la llenes tú). El orden de esta lista importa:
 * "Fecha y hora de registro" se reconoce antes que "Fecha" y "Hora".
 */
const CAMPOS = [
    ['registro', /registr|creada|recibid|fecha y hora/],
    ['whatsapp', /whatsapp|usuario/],
    ['nombre', /nombre/],
    ['celular', /celular|telefono|contacto/],
    ['motivo', /motivo|evento|ocasion|tipo de reserva/],
    ['fecha', /fecha/],
    ['hora', /hora/],
    ['personas', /persona|cuant/],
];
const avisados = new Set();

/** Convierte { nombre, celular, … } en la fila según los títulos de la fila 1. */
async function filaPorEncabezados(auth, spreadsheetId, sheetName, datos) {
    const { data } = await sheets.spreadsheets.values.get({ spreadsheetId, range: rango(sheetName, '1:1'), auth });
    const titulos = (data.values?.[0] || []).map(sinTildes);
    const usados = new Set();
    // null = esa celda no se toca (Sheets la salta): las columnas que llenas a mano quedan intactas.
    const fila = titulos.map((t) => {
        const campo = CAMPOS.find(([k, re]) => !usados.has(k) && re.test(t))?.[0];
        if (!campo || !(campo in datos)) return null;
        usados.add(campo);
        return datos[campo] ?? '';
    });
    const sinColumna = Object.keys(datos).filter((k) => !usados.has(k) && datos[k] != null && datos[k] !== '');
    const clave = `${spreadsheetId}|${sinColumna.join(',')}`;
    if (sinColumna.length && !avisados.has(clave)) {
        avisados.add(clave);
        const msg = `Google Sheets: la hoja no tiene columna para ${sinColumna.join(', ')} (títulos de la fila 1: ${titulos.join(' | ') || 'vacía'}). Esos datos no se guardan; agrega la columna en la pestaña ORIGINAL si los quieres.`;
        console.warn('[sheets]', msg);
        reportarFalla(new Error(msg), { level: 'warning', step: 'guardar en Google Sheets (columnas)', hoja: spreadsheetId });
    }
    return fila;
}

async function addRowToSheet(auth, spreadsheetId, datos, sheetName) {
    // Sin try/catch aquí: si falla, appendToSheet lo explica y lo reporta al CRM.
    return enSerie(`${spreadsheetId}|${sheetName}`, async () => {
        const values = Array.isArray(datos) ? datos : await filaPorEncabezados(auth, spreadsheetId, sheetName, datos);
        const fila = await primeraFilaLibre(auth, spreadsheetId, sheetName);
        const response = await sheets.spreadsheets.values.update({
            spreadsheetId,
            range: rango(sheetName, `A${fila}`),
            valueInputOption: 'RAW',
            resource: { values: [values] },
            auth,
        });
        return response.data;
    });
}

const appendToSheet = async (data, spreadsheetId) => {
    try {
        const auth = new google.auth.GoogleAuth({
            credentials: {
                type: process.env.GOOGLE_TYPE,
                project_id: process.env.GOOGLE_PROJECT_ID,
                private_key_id: process.env.GOOGLE_PRIVATE_KEY_ID,
                private_key: clavePrivada(),
                client_email: process.env.GOOGLE_CLIENT_EMAIL,
                client_id: process.env.GOOGLE_CLIENT_ID,
                auth_uri: process.env.GOOGLE_AUTH_URI,
                token_uri: process.env.GOOGLE_TOKEN_URI,
                auth_provider_x509_cert_url: process.env.GOOGLE_AUTH_PROVIDER_X509_CERT_URL,
                client_x509_cert_url: process.env.GOOGLE_CLIENT_X509_CERT_URL,
            },
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });

        const authClient = await auth.getClient();
        const sheetName = getTodaySheetName();
        await ensureSheetExists(authClient, spreadsheetId, sheetName);
        await addRowToSheet(authClient, spreadsheetId, data, sheetName);

        return 'Datos correctamente agregados';
    } catch (error) {
        // v3.4: el pedido, la reserva o la encuesta no quedó en la hoja de cálculo.
        const falla = explicarErrorSheets(error, spreadsheetId);
        console.error('[sheets]', falla.message);
        reportarFalla(falla, { level: 'warning', step: 'guardar en Google Sheets', hoja: spreadsheetId || 'vacía', fila: (Array.isArray(data) ? data : Object.values(data ?? {})).slice(0, 4).join(' | ') });
    }
};

export default appendToSheet;