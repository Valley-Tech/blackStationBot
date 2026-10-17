# Productos con variantes en el catálogo de Meta (WhatsApp)

## Cómo funciona en Meta

Meta no tiene una fila "padre" aparte. Un producto con variantes es un **grupo de filas que comparten el mismo `item_group_id`**. Cada fila es una variante (hija) con su propio `id`, precio y atributo que la diferencia. En WhatsApp se ven como **un solo producto** ("Pizza Hawaiana · 4 opciones") y al abrirlo el cliente elige el tamaño o el sabor.

Reglas de Meta:
- Todas las variantes del grupo llevan el **mismo `title`** y el mismo `item_group_id`.
- Todas deben tener lleno **el mismo campo de variante** (todas `size`, o todas `additional_variant_attribute`).
- Cada variante conserva su `id` = ID de Loggro de esa variante. Por eso el pedido que llega al bot trae el ID exacto del tamaño elegido y Loggro recibe el producto correcto.

## Qué trae `catalogo-meta-la-estacion.csv`

Columnas nuevas:

| Columna | Uso | Ejemplo |
|---|---|---|
| `item_group_id` | ID del producto padre en Loggro (igual para todas sus variantes) | `6a91ba75433807bf410f69b7` |
| `size` | Tamaño (campo estándar de Meta) | `8 porciones`, `3 personas`, `Mediana` |
| `additional_variant_attribute` | Variante personalizada `Nombre:Valor` | `Sabor:Fresa`, `Presentación:Cono sencillo`, `Diseño:Osito` |

Grupos (35, con 166 variantes):
- **Tamaño (`size`)**: las 19 pizzas y los 3 bordes (4/6/8/12 porciones), Picada (2 a 6 personas y Familiar), Ensalada de Frutas (Pequeña/Mediana/Grande).
- **Sabor**: Helado a la Plancha (14), Malteada (4), Frappé (6), Smoothie (3), Jugos Naturales (11), Michelada Tradicional (8), Michelada Especial (8).
- **Presentación**: Helado en Crema (cono, vaso, copas).
- **Diseño**: Menú Infantil (6), Malteada Kids (3).
- **Tipo**: Waffle con Helado (Sencillo/Especial).
- Los productos sin variantes (asados, salchipapas, burgers, panzerottis, bebidas…) van sin `item_group_id`.

## Pasos (catálogo ya cargado con fotos puestas a mano)

Meta identifica cada producto por su **Identificador de contenido** (`id`). Volver a subir un `id` que ya existe **actualiza** ese producto, nunca crea otro. Pero si vuelves a subir el archivo completo, el `image_link` del archivo **reemplaza las fotos que pusiste a mano**. Por eso:

1. Usa `docs/actualizacion-variantes-meta.csv` (solo `id`, `title`, `item_group_id`, `size`, `additional_variant_attribute`) con el script, que cambia **solo esos campos**:
   ```
   node scripts/actualizar-catalogo-meta.mjs              # simulación
   node scripts/actualizar-catalogo-meta.mjs --enviar     # aplica
   ```
   Necesita `CATALOG_ID` y `CATALOG_TOKEN` (token de usuario del sistema con permiso `catalog_management` sobre el catálogo).
2. Productos que faltan en Meta (Chorizo al Barril, Alitas Tradicionales, Alitas BBQ, Chicharrón, Costillas de Cerdo BBQ): agrega `--crear-faltantes` o súbelos con `docs/productos-faltantes-meta.csv` (Agregar → Carga de archivo). Si faltan, el catálogo "Asados y Picadas" del bot falla completo (#131009).
3. `docs/catalogo-meta-la-estacion.csv` es tu archivo corregido + las 3 columnas de variantes (UTF-8 con BOM, separado por `;`). Úsalo solo para un catálogo nuevo o si decides reemplazar todo (las fotos volverán a la del archivo).
4. Revisa en **Artículos** que la columna *Variantes* muestre los grupos (Pizza Hawaiana → 4).
5. Corre `npm run verificar` con `CATALOG_ID` y `API_TOKEN` para confirmar que están todos.
6. Cuando confirmes que el selector de tamaño se ve bien, pon **`VARIANTES_META=true`** en Railway:
   - "Pizzas" deja de preguntar el tamaño y manda un solo catálogo con todos los sabores (cada pizza muestra el precio desde 4 porciones; el cliente elige el tamaño adentro).
   - En Heladería sale un producto por grupo (p. ej. un solo "Helado a la Plancha" con sus 14 sabores).
   - Si el cliente elige 12 porciones, el pedido llega con el ID de 12 porciones y el resumen dice "Pizza Hawaiana (12 porciones)".

Si algo no se ve bien, vuelve a `VARIANTES_META=false`: el bot regresa al menú de tamaños sin tocar el catálogo.
