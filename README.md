# BlackStationBot

Chatbot de WhatsApp de **La Estación Parrilla Bar · Black's Pizza · Heladería Yellow**.
Misma lógica de SamuelitoBot (pedido con carrito + Flow, reserva con Flow, pagos en efectivo / PSE con Wompi / transferencia, encuesta, IA del CRM, Loggro y Google Sheets), adaptada a las tres cartas del restaurante.

## Estructura

```
src/
  app.js                         servidor Express
  config/env.js                  variables de entorno
  config/negocio.js              datos del restaurante (horario, domicilio, cuentas, ubicación…) ⚠️ revisar
  data/catalogo.js               product_names (NOMBRE → ID de Loggro), catálogos multiproducto y áreas de Loggro
  controllers/webhookController.js  webhook de Meta, eventos del CRM, endpoint /flow, Wompi
  services/messageHandler.js     conversación (bienvenida, cartas, pedido, reserva, pagos, IA)
  services/flow.js               Flow de pedido (DETAILS → SUMMARY)
  services/flowReserva.js        Flow de reserva (RESERVA → RESUMEN)
  services/flowEncuesta.js       Flow de encuesta (RECOMMEND → RATE)
  services/sesiones.js           estado de cada cliente (pedido, reserva, pantalla del Flow)
  services/whatsappService.js    envíos a WhatsApp (texto, botones, listas, catálogos, Flows, plantillas)
  services/loggroService.js      comanda a Loggro POS (Pirpos)
  services/crmAdapter.js         puente con el CRM ValleyTech (modo gateway)
docs/
  CATALOGOS.md                   qué productos van en cada catálogo, con precio e ID
  catalogo-meta-la-estacion.csv  carga masiva para el Administrador de ventas de Meta
scripts/
  verificar-catalogo.mjs         revisa los catálogos (y si están todos los productos en Meta)
  probar-clave.mjs / clave-flow.mjs   clave de cifrado de los Flows (igual que Samuelito)
```

## Productos: `product_names` al revés

En `src/data/catalogo.js` el diccionario va **nombre → ID** (el `_id` de Loggro):

```js
export const product_names = {
  "Carne Asada": "68f9b01c4023c130e6c7d6ea",
  "Pizza Hawaiana (8 porciones)": "6a91ba75433807bf410f6a11",
  ...
};
```

- Los catálogos multiproducto se arman con los **nombres** (`CATALOGOS`), y el bot busca el ID en `product_names`.
- Cuando llega un pedido del carrito, `webhookController.js` usa `nombrePorId` (la misma tabla al revés, se arma sola) para mostrar los nombres.
- Productos con tamaños o sabores (pizzas, bordes, picadas, malteadas, micheladas, jugos, helados…) usan el ID de la **variante** de Loggro, que es la que tiene el precio.
- 257 productos en total, todos activos en Loggro.

## Cómo pide el cliente

1. **Pedir 🛒** → lista "¿Qué se te antoja hoy?" con 9 cartas:
   - La Estación Parrilla: Asados y Picadas · Salchipapas y Burgers · Patacones y Sándwiches
   - Black's Pizza: Pizzas (primero elige 4, 6, 8 o 12 porciones) · Panzerottis y Lasañas
   - Heladería Yellow: Helados y Postres · Malteadas y Frappés · Jugos y Micheladas
   - Bebidas: Gaseosas y Cervezas
2. Cada opción manda su catálogo multiproducto (máximo 30 productos, que es el límite de WhatsApp). Tras una carta de comida: "¿Deseas bebida o postre?".
3. Todos los catálogos usan el mismo `CATALOG_ID`, así que el cliente puede mezclar productos de las tres cartas en un mismo carrito.
4. También entiende texto: "quiero una pizza", "tienen micheladas", "una salchipapa"… manda la carta que corresponde.
5. Al enviar el carrito: resumen con nombres y total → Flow de datos de envío → Efectivo / PSE / Transferencia (igual que Samuelito).

## Mejoras frente a SamuelitoBot

- **Estado por cliente**: el pedido, la reserva y la pantalla del Flow se guardan por número (antes eran variables globales y dos pedidos simultáneos se mezclaban). El Flow viaja con `flow_token` = `pedido:<número>:…`, así `/flow` sabe de quién es.
- **Saludo por palabras**: "chicharrón" ya no cuenta como "hi".
- **Wompi**: el pago aprobado avisa con los datos del cliente del link (antes, del último que escribió).
- **Loggro**: si falla no tumba el bot; si falta `LOGGRO_TABLE_ID` o la API key, solo avisa en el log.
- Variables de plantilla vacías se mandan como "-" (Meta rechaza vacías).

## Puesta en marcha

1. **Catálogo de Meta** (Administrador de ventas → catálogo del número de La Estación):
   - Carga masiva con `docs/catalogo-meta-la-estacion.csv`. Completa las columnas `link` (p. ej. la página del restaurante) e `image_link` (foto de cada producto), que Meta exige.
   - El **ID de contenido** de cada producto debe ser el ID de Loggro (columna `id`).
   - Conecta el catálogo al número de WhatsApp y copia el ID del catálogo en `CATALOG_ID`.
   - Si falta un solo producto de un catálogo, WhatsApp rechaza ese mensaje completo (#131009). Revisa con `npm run verificar` (con `CATALOG_ID` y `API_TOKEN` en el .env te lista los que faltan).
2. **Flows** (WhatsApp Manager): copia los JSON de Pedido, Reserva y Encuesta de Samuelito (mismas pantallas y campos), endpoint `https://<bot>/flow`, publícalos y pon sus IDs en `FLOW_ID_PEDIDO`, `FLOW_ID_RESERVA`, `FLOW_ID_ENCUESTA`. Registra la clave pública en el número (`node scripts/clave-flow.mjs subir`).
3. **Plantillas** (mismas de Samuelito, en la WABA de La Estación): `mensaje_nuevo_pedido`, `comprobante_pago` (6 variables, encabezado con imagen) y `confirmacion_reserva` (7 variables, encabezado con imagen).
4. **Railway**: variables de `.env.example`. Las más importantes: `CATALOG_ID`, `FLOW_ID_*`, `PRIVATE_KEY`, `PASSPHRASE`, `NOTIFY_NUMBERS`, `LOGGRO_API_KEY`, `LOGGRO_TABLE_ID`, `CRM_*`.
5. **CRM ValleyTech** → Chatbots → nuevo chatbot "BlackStationBot": endpoint `https://<bot>/crm/events`, *Atiende* = número de La Estación; copia la API key y el secreto de firma a `CRM_API_KEY` y `CRM_SIGNING_SECRET`; `CRM_MODE=gateway`. Para la IA: CRM → IA y conocimiento (sube las cartas en PDF).
6. **Revisa `src/config/negocio.js`** (⚠️): horario, valor del domicilio, cuentas bancarias, dirección y coordenadas.

## Pruebas

`npm run verificar` revisa los catálogos. Las pruebas de extremo a extremo (cartas, carrito, Flow cifrado con dos clientes a la vez, Loggro, avisos, transferencia, reserva, IA) se corrieron con WhatsApp, Loggro, Sheets y S3 simulados.
