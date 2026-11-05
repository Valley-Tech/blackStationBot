# Variantes del catálogo de Meta en el chatbot

## Cómo se ve
El catálogo de Meta agrupa las variantes con `item_group_id` y **todas las variantes de un grupo tienen el mismo título** (es una regla de Meta). Por eso, si el bot manda en un catálogo multiproducto cada variante por separado, WhatsApp muestra el mismo nombre repetido ("Jugo Natural", "Jugo Natural"…): la lista de WhatsApp solo muestra el título del producto, nunca la variante.

Con **`VARIANTES_META` activo (por defecto)** el bot manda **una sola tarjeta por grupo**:

| Catálogo | Antes | Ahora |
|---|---|---|
| Jugos y Micheladas | 8 × "Jugo Natural", 3 × "Limonada", 8 × "Michelada Tradicional", 8 × "Michelada Especial" | **Jugo Natural · Limonada · Michelada Tradicional · Michelada Especial** |
| Salchipapas y Burgers | 6 × "Hamburguesa", 4 × "Perro Caliente"… | **Hamburguesa · Perro Caliente · Salchipapa** (+ los productos sueltos) |

Al tocar la tarjeta, WhatsApp abre el producto con el selector **"Tamaño"** (Maracuyá, Fresa, Mora… o 4, 6, 8, 12 porciones) y **cada opción con su foto y su precio**. El carrito llega con el ID exacto de la variante y el resumen del pedido dice el nombre completo ("Jugo de Maracuyá x2"), y así va a Loggro.

En la lista se ve el precio de la variante más económica del grupo.

## Cuando cambies los grupos
1. Actualiza el CSV del catálogo (`docs/catalogo-meta-la-estacion.csv`) y súbelo a Meta.
2. Corre `npm run grupos` (o `npm run grupos -- ruta/al/archivo.csv`): reescribe `grupoPorId`, `tituloGrupo` y `variantePorId` en `src/data/catalogo.js` y avisa si un grupo tiene títulos distintos o IDs que el bot no conoce.
3. Despliega el bot.

Para volver a mostrar cada variante por separado: `VARIANTES_META=false` en Railway.

## Grupos actuales (56)
Tamaño: 19 pizzas y 3 bordes (4/6/8/12 porciones), Picada, Ensalada de Frutas, Coca-Cola, Cuatro, Jugo Hit, Postobón, Pony Malta, Agua.
Sabor/tipo (también en el campo `size`, para que WhatsApp muestre "Tamaño" y no "Custom_data"): Hamburguesa, Sándwich, Salchipapa, Perro Caliente, Patacón Burger, Patacón Relleno, María Casquito, Desgranado, Lasaña, Panzerotti, Pechuga, Chuleta, Asado, Helado a la Plancha, Copa de Helado, Helado Sencillo, Waffle con Helado, Frappé, Malteada, Malteada Kids, Smoothie, Menú Infantil, Jugo Natural, Limonada, Michelada Tradicional, Michelada Especial.
