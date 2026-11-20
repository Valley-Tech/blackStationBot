# v3.10 · "menú", "carta" y la hora real

## "carta" → siempre el PDF (solo la que nombre)
| El cliente escribe | Recibe |
|---|---|
| "muéstrame la carta de La Estación parrilla" | Carta-La-Estacion-Parrilla.pdf |
| "la carta de las pizzas", "de pizzería", "de Black's Pizza" | Carta-Blacks-Pizza.pdf |
| "la carta de la heladería", "de helados", "Yellow" | Carta-Heladeria-Yellow.pdf |
| "la carta", "CARTA" (sin decir cuál) | las 3 |

También se reconocen platos: "carta de hamburguesas" va a la parrilla y "carta de malteadas" a la heladería.
Si la URL de esa carta está vacía en Railway (`CARTA_*_URL`), el cliente recibe lo de antes: las pizzas del
catálogo, o la lista de cartas.

## "menú" (sin "carta")
| El cliente escribe | Recibe |
|---|---|
| "quiero el menú", "el menú completo", "Regálame el menú xf completo" | catálogo de WhatsApp (`CATALOG_TEMPLATE`). Si está vacía o Meta la rechaza, la lista de cartas |
| "el menú de las pizzas" | carta de pizzas del catálogo |
| "el menú de las hamburguesas" | carrusel solo de hamburguesas. Si alguna no tiene foto en el CSV, la lista de productos de su carta |
| "el menú de bebidas", "de la heladería" | la lista de productos de esa carta |
| "el menú en la página web", "el menú digital", "el link del menú" | enlace `MENU_WEB_URL` |
| "el menú infantil" | es un producto: búsqueda normal |

Corrección: antes "menú" **con tilde** no se reconocía como palabra clave, y "Regálame el menú xf completo"
terminaba en la IA (que mandaba el enlace de la página).

## Hora real de Colombia
- "¿Hay servicio?", "¿La Estación está en servicio aún?", "¿están abiertos?", "¿todavía atienden?" y "¿a qué hora
  cierran?" reciben una respuesta directa del bot con la hora de Bogotá (UTC-5), sin pasar por la IA:
  - abierto: "¡Sí! Estamos atendiendo hasta las *11:30 p.m.* 😊";
  - cerrado: "🌙 En este momento (11:52 p. m.) ya estamos cerrados… volvemos a abrir *mañana* a las *4:00 p.m.*".
- "¿Hay servicio a domicilio?" no cuenta como esa pregunta: la responde la IA.
- Todo lo que responde la IA lleva, al final del historial, una nota con la fecha, la hora y si estamos ABIERTOS o
  CERRADOS (`HORA_EN_IA=true`). El horario sale de `HORA_APERTURA` y `HORA_CIERRE`.
- Corrección: el CRM recortaba el historial a 20 mensajes y se perdía la nota de los datos del cliente (v3.9).
  Ahora el bot envía `historyLimit` (máx. 40).
