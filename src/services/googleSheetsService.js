import { google } from 'googleapis';

const sheets = google.sheets('v4');

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
        private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
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
    console.error("Error guardando estado de pago:", error.message);
    return false;
  }
};

async function addRowToSheet(auth, spreadsheetId, values, sheetName) {
    const request = {
        spreadsheetId,
        range: `${sheetName}`,
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        resource: {
            values: [values],
        },
        auth,
    };

    try {
        const response = (await sheets.spreadsheets.values.append(request)).data;
        return response;
    } catch (error) {
        console.error(error);
    }
}

const appendToSheet = async (data, spreadsheetId) => {
    try {
        const auth = new google.auth.GoogleAuth({
            credentials: {
                type: process.env.GOOGLE_TYPE,
                project_id: process.env.GOOGLE_PROJECT_ID,
                private_key_id: process.env.GOOGLE_PRIVATE_KEY_ID,
                private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
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
        console.error(error);
    }
};

export default appendToSheet;