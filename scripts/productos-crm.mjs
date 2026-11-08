/**
 * Genera docs/productos-crm-blackstation.csv: la lista de platos para la búsqueda
 * con IA del CRM (Chatbots → BlackStationBot → IA y conocimiento → Catálogo de
 * productos → Subir CSV). Vuelve a ejecutarlo cuando cambies src/data/catalogo.js:
 *
 *   npm run productos-crm
 */
import { writeFileSync } from 'node:fs';
import { csvParaCrm } from '../src/services/busquedaPlatos.js';

const salida = new URL('../docs/productos-crm-blackstation.csv', import.meta.url);
const csv = csvParaCrm();
writeFileSync(salida, '﻿' + csv + '\n');
console.log(`✔ ${csv.split('\n').length - 1} productos → docs/productos-crm-blackstation.csv`);
