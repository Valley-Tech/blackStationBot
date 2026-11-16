# Conversación, búsqueda de platos y seguimiento del pedido (v3.5)

## 1. Búsqueda de platos con IA y tarjetas
El cliente escribe lo que quiere ("me regalas 3 salchipapas", "una piza hawaiana", "tienen micheladas?") y el bot le muestra los platos en tarjetas del catálogo:

| Resultados | Mensaje |
|---|---|
| 1 plato | Tarjeta de producto (`interactive.type = product`) |
| 2 a 10 | **Carrusel de productos** (`interactive.type = carousel`): no necesita plantilla ni aprobación de Meta |
| Más de 10 ("una pizza") | La carta de esa sección (lista de productos con carrito) |

- **IA:** la búsqueda usa la IA del CRM, igual que MerkCentro24 (`POST /api/v1/bot/ai/products/search`). Hay que subir `docs/productos-crm-blackstation.csv` al CRM: Chatbots → BlackStationBot → IA y conocimiento → **Catálogo de productos**. Si la IA está apagada o el CRM no responde, el bot usa una búsqueda local que tolera errores ("piza", "hamburgesa", "salchipapitas").
- **Una tarjeta por plato:** con variantes en Meta (`VARIANTES_META=true`), "Salchipapa" es una sola tarjeta y la sencilla, la mixta, la ranchera… se eligen dentro. Si el cliente nombra la variante ("salchipapa mixta"), la tarjeta abre esa.
- **Familia:** si pide algo genérico ("salchipapa"), también salen los platos de la misma sección de la carta: porción de papa, choripapa, pollipapa y salchiplátano.
- **Cantidad:** "3 salchipapas" → el mensaje le recuerda poner *3* en el carrito.
- **Preguntas sobre un plato** ("¿la hawaiana chicken tiene piña?"): responde la IA y debajo envía la tarjeta para pedir.
- **Si cambias `src/data/catalogo.js`:** ejecuta `npm run productos-crm` y vuelve a subir el CSV al CRM.

## 2. Conversación coherente
- **Bienvenida:** sale una sola vez por cliente en cada turno (`HORA_APERTURA` → `HORA_CIERRE`; 16:00 → 00:00).
  - Si el cliente vuelve a saludar, el bot responde "¡Hola de nuevo!" y, si tiene un pedido sin terminar, se lo recuerda.
  - "Hola, ¿se demora mucho?": el bot quita el saludo y responde la pregunta.
- **Cortesías:** "gracias", "ok", "listo", 👍 reciben una respuesta corta, nunca la bienvenida.
- **Preguntas de tiempos, pagos, domicilio o estado del pedido:** van a la IA del CRM, aunque mencionen un plato.
- **Lo que antes quedaba sin respuesta** ("se demora", "vamos a ir allá"): ahora lo responde la IA. El botón "¿Resolví tu pregunta?" solo sale cuando fue una pregunta.
- **Fuera de horario:**
  - El aviso de "cerrado" completo sale una vez cada 2 horas; después, una línea corta.
  - Los carritos no se toman: el bot da el horario.
  - Un pedido que empezó antes del cierre sí se termina (Flow y botones).
- **`NO_RESPONDER_A`:** números a los que el bot no responde, por ejemplo el personal que escribe a la línea.

## 3. Pedido: confirmar, agregar, cambiar, recordar y adicionales
1. **Carrito → confirmación:** el bot muestra el resumen con tres botones antes de enviar el Flow de datos: **Confirmar pedido ✅**, **Agregar más ➕** y **Cambiar pedido ✏️**.
   - Agregar más: el siguiente carrito se suma al pedido.
   - Cambiar pedido: el siguiente carrito reemplaza el pedido.
2. **Otro carrito con el pedido sin terminar** (el caso de la ensalada mediana → pequeña): el bot pregunta **"Agregar al pedido"** o **"Reemplazar pedido"**.
3. **Flow:** lee el pedido cuando el cliente lo abre. Por eso los cambios hechos antes de llenarlo quedan en el pedido.
4. **Recordatorio:**
   - Si no confirma o no llena el Flow, el bot se lo recuerda cada `RECORDATORIO_PEDIDO_MIN` minutos (5), máximo `RECORDATORIO_PEDIDO_MAX` veces (2). El último recordatorio le ofrece escribir *cancelar*.
   - Si el cliente escribe, el conteo se reinicia, para no interrumpirlo.
   - Si el cliente hace una pregunta, el bot la responde y luego le recuerda el pedido.
   - Los recordatorios se detienen cuando llena el Flow, cancela o arma otro pedido.
5. **Adicional:** si ya llenó el Flow y en los siguientes `ADICIONAL_MINUTOS` (60) envía otro carrito, el bot pregunta si es un **adicional**.
   - Si es adicional, usa los mismos datos de entrega y pago, **sin volver a llenar el Flow y sin cobrar domicilio otra vez**.
   - Avisa al negocio (plantilla con "Adicional"), a Loggro ("➕ ADICIONAL") y a Google Sheets.
   - Si pagó con transferencia, le pide el comprobante del adicional; si fue PSE, le manda el link del adicional.
6. **Cambios después de llenar el Flow** (quitar algo de un pedido que ya está en cocina): los atiende un asesor.

Los recordatorios viven en la memoria del bot: si Railway reinicia el servicio, los pendientes no se envían.

## v3.7 · Pizzas combinadas (2 o 3 sabores en una bandeja)

Reglas: 4 y 6 porciones → 2 sabores mitad y mitad (2+2 / 3+3). 8 porciones → 2 sabores (4+4) o 3 (4+2+2).
12 porciones → 2 sabores (6+6) o 3 (4+4+4). Se cobra el precio del sabor más caro (en ese tamaño).
A Loggro va UNA línea con el producto del sabor que fija el precio y la nota
`COMBINADA 8 porciones: 4 Hawaiana + 2 Mexicana + 2 Ranchera` (más la recomendación del cliente).

Cómo se dispara (`src/services/pizzasCombinadas.js` + sección "Pizzas combinadas" de messageHandler.js):
- "pizza de 4 mitad hawaiana y mitad mexicana", "hawaiana y ranchera", "de 2 sabores" → se arma de una vez
  y solo se pregunta lo que falte (tamaño con lista; nº de sabores con botones en 8 y 12; sabores por texto).
- "quiero una pizza" → botones *Sí, combinar / No, ver la carta*. "carta/menú de pizzas" → la carta y luego la pregunta.
- "pizza hawaiana de 8" (un sabor) → la tarjeta y "¿La quieres combinada con otro sabor?".
- Carrito con pizzas de un sabor → por cada línea "¿Deseas combinar las porciones?" antes de "¿Está todo bien?".
  Con cantidad > 1: "¿Las 2 iguales o solo una?". La pizza combinada reemplaza la línea (o parte de ella).
- "pollo" / "queso" solos son ambiguos → lista para elegir el sabor. Sabores repetidos, sabor sin ese tamaño
  (Toxi-Queso de 12 no tiene precio) y más sabores de los permitidos se avisan y se corrigen.
- Resumen con botones *Agregar al pedido / Cambiar sabores / Cancelar*; "cancelar" por texto también.
- Preguntas de detalle ("¿la hawaiana tiene piña?") siguen yendo a la IA con las tarjetas debajo.
