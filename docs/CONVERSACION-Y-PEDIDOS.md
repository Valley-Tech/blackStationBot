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

## v3.8 · Pizzas: menos pasos y jerarquía de mensajes

**Jerarquía** de lo que escribe el cliente (de mayor a menor):
1. Palabras clave: *carta*, *menú*, *asesor*, *ubicación*, *ayuda*, *reservar*, *cancelar*. Mandan siempre, aunque esté
   armando una pizza. "La carta" muestra la carta principal y suelta la pizza a medio armar; "carta de pizzas" o
   "¿qué sabores hay?" muestra las pizzas y deja la combinación en espera.
2. Si está armando una pizza, solo se toma lo que es de la pizza (sabores, tamaño, porciones por sabor, borde,
   "un solo sabor", sí/no). Lo demás sigue al flujo normal (otro plato, pregunta a la IA). Ya no existe el mensaje
   "No encontré ese sabor".
3. Pizzas por texto.

**Primera vez que habla de pizzas** ("quiero una pizza", "pizza de 12 porciones", "quiero una pizza mexicana"):
solo se muestran las coincidencias (carta de pizzas, carta de ese tamaño o la tarjeta del sabor). No se pregunta nada.
**Cuando ya las vio y escribe su preferencia** ("deseo una hawaiana por favor", "la mexicana de 8"): botones
*Un solo sabor ✅ / Combinar sabores 🍕*. Un solo sabor → el bot la agrega al pedido (pregunta el tamaño con una lista
si falta) y sigue "¿Está todo bien?". Si escribe que la quiere combinada ("mitad…", "2 sabores", dos sabores) se arma
la combinada de una vez, también en el primer mensaje.

**Combinada**
- En 8 y 12 ya no se pregunta "¿2 o 3 sabores?": se deduce de los sabores que escriba (en el resumen de 2 sabores
  puede escribir un tercero).
- Los sabores que faltan se piden con un texto corto y un **carrusel de recomendaciones** (`RECOMENDADOS` en
  pizzasCombinadas.js), sin los que ya eligió. El cliente escribe el sabor, o lo agrega al carrito desde el carrusel
  y lo envía: se toma como el sabor que faltaba.
- Porciones por sabor: "la de 4 que sea jamón y queso", "4 de jamón y queso, 2 hawaiana y 2 mexicana",
  "mitad hawaiana". Un número antes de un sabor son porciones de ese sabor, no el tamaño de la pizza. Si el reparto
  no existe ("6 y 2" en la de 8) se explican los permitidos.
- "1 solo sabor hawaiana" / "sin combinar" mientras arma la combinada → pasa a pizza de un sabor y entra al pedido.
- Si repite el único sabor que ya dio ("Hawaiana"… "Hawaiana") se le pregunta *Un solo sabor / Combinar*.

**Bordes** (Queso, Bocadillo, Mozzarella): "con borde de queso" agrega `Borde Queso (N porciones)` del mismo tamaño,
en la de un sabor y en la combinada. "Con borde" sin decir cuál → 3 botones con el precio. "Queso" y "bocadillo" del
borde ya no se confunden con sabores de pizza.

## v3.9 · Memoria del turno y datos del pedido escritos en el chat

**Memoria** (`src/services/memoria.js`): por cliente, todo el turno (desde que escribe, aunque sea antes de abrir,
hasta HORA_CIERRE + `MEMORIA_GRACIA_MIN` = 60 min). Guarda:
- el historial del turno (cliente y bot; tarjetas, carruseles, botones y carritos como texto) → se envía a la IA
  del CRM en cada pregunta (`history` de `/ai/reply`), con una nota de los datos que ya dio el cliente;
- los datos: pago, recoger/domicilio, dirección, nombre de WhatsApp y la pizza (sabor, tamaño, "un solo sabor" o
  combinada).
Con eso: "De cuatro porciones" después de la tarjeta de un sabor se entiende; si ya dijo "un solo sabor" el bot no
vuelve a preguntar "¿así o combinada?" (ni por texto ni cuando manda el carrito); "Así está bien" en una pizza vale
para todo el turno. `MEMORIA_IA=false` → la IA vuelve a usar solo el historial del CRM.
Límite: vive en la memoria del servidor; un despliegue o reinicio durante el servicio la borra.

**Datos del pedido en el chat** (`src/services/datosCliente.js`): "pago por transferencia", "dame el QR", "en
efectivo", "por nequi", "paso a recoger", "para llevar", "a domicilio a la calle 10 # 5-20"… se anotan con los ids
del Flow (`pago`: Efectivo | Transferencia | Codigo QR; `paradonde`: restaurante | domicilio). Las preguntas
("¿reciben transferencia?", "¿cuánto vale el domicilio?") no cuentan. Se muestran en "¿Está todo bien?"
("📝 Anoté: recoges en el restaurante · pagas por transferencia").
- "¿Y el valor?" / "¿cuánto es?" con pedido en curso → total (y QR o cuentas si ya lo envió).
- "Dame el QR" con pedido enviado → el QR con el total.
- Un pedido con datos de pago en el mismo mensaje ya no se va a la IA como "pregunta de pagos".

**Flow precargado** (`FLOW_PRECARGA=true`): el Flow de pedido se abre con `flow_action: navigate` y
`init_values` = { name, phone, paradonde, pago, recomendacion: "Dirección: …" } (solo los conocidos).
Requiere el Flow con `"init-values": "${data.init_values}"` en el Form: `docs/FLOW-PEDIDO-PRECARGADO.json`.
