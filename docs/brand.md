# Marca de Céntrate

Guía de la marca: el icono de la app, su versión monocroma y la mascota. Los maestros están en `assets/brand/` y todo lo demás (`.ico`, `.icns`, PNG, iconos de la bandeja y de la extensión, favicon) debe generarse a partir de ellos. Es un trabajo original del proyecto, con licencia MIT como el resto del repositorio, y está apuntado en `ASSET-LICENSES.json`.

![Icono de Céntrate](../assets/brand/icon.svg)

## La marca

Un anillo abierto por la derecha con un punto en el centro. Es la diana de enfoque que ya usa la bandeja, con un hueco de 80°:

- se lee como una «C» de Céntrate que sostiene un punto: tú, centrado;
- también se lee como una cuenta atrás casi cerrada, que es lo que hace la app;
- el punto la distingue de una «C» suelta o de un ©, y los extremos redondeados, de las «C» de trazo recto de otras marcas.

**Construcción** (lienzo de 1024, como `assets/brand/icon.svg`):

| Pieza  | Medida                                                                    |
| ------ | ------------------------------------------------------------------------- |
| Placa  | 824 × 824 con 100 de margen, radio de esquina 185                         |
| Anillo | radio 257,5 (línea media), grosor 103, extremos redondeados               |
| Hueco  | 80°, centrado a las 3 (de −40° a +40°)                                    |
| Punto  | radio 103, igual que el grosor del anillo                                 |
| Reglas | grosor = radio del punto = ⅛ de la placa; radio del anillo = 2,5 × grosor |

**Ajustada al píxel.** A 16 px, 1 px son 51,5 unidades del lienzo: el anillo mide 2 px de grosor y 5 px de radio, y el punto 2 px de radio, con los bordes exteriores justo en los píxeles 2 y 14. A 32 y 48 px todo se multiplica por 2 y por 3. Por eso un único maestro sirve desde 16 hasta 1024 px, sin un dibujo aparte para los tamaños pequeños.

## Archivos

| Archivo                              | Qué es                                                    | Dónde se usa                                                                         |
| ------------------------------------ | --------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `icon.svg`                           | Icono de la app, lienzo de 1024 con el margen de macOS    | `.icns` tal cual; `.ico`, PNG de Linux, favicon y web recortados a la placa          |
| `icon-mono.svg`                      | Plantilla monocroma de 16 unidades (solo cuenta el alfa)  | Barra de menús de macOS (_template image_), bandeja en reposo, impresión a una tinta |
| `mascot-brote.svg` … `-marchita.svg` | Las 4 fases de la mascota, rejilla de 24 al estilo lucide | Cabecera de Progreso (16 px) y ventana Recompensas (en grande)                       |

`icon.svg` lleva los identificadores `plate`, `ring` y `dot`, e `icon-mono.svg`, `ring` y `dot`, para que los generadores cambien los colores desde `tokens.ts` sin reescribir el dibujo.

## Tamaños y recortes

- **macOS (`.icns`):** `icon.svg` tal cual, 1024 con 100 de margen, que es la rejilla de iconos de macOS.
- **Windows (`.ico`: 16, 20, 24, 32, 40, 48, 64 y 256), Linux (PNG de 16 a 512), favicon y extensión:** recorta a la placa con `viewBox="100 100 824 824"`. En esos sistemas el icono ocupa toda la caja, sin margen.
- **Tamaños pequeños:** 16, 32 y 48 px salen nítidos porque son múltiplos de la rejilla; 20 y 24 px salen bien, algo más suaves. No añadas un contorno ni cambies el grosor para «arreglarlos».
- **Bandeja y barra de menús:** `icon-mono.svg` en caja de 16 unidades, dibujado a 16, 20, 24 y 32 px. Anillo de radio 6 y grosor 2, hueco de 80° a la derecha y punto de radio 2,5 (la misma proporción entre el punto y el hueco interior que en `icon.svg`).
- **Estados de la bandeja:** en reposo, la plantilla monocroma; con un bloqueo, el disco relleno con el anillo recortado en el color del modo, y el punto rojo de la cámara arriba a la derecha (sección 10 de `PROMPT.md` y `apps/desktop/scripts/gen-tray-icons.mjs`). El cambio de estado cambia la forma, no solo el color.

## Colores

Los valores salen de `packages/shared/src/design/tokens.ts`. Los hexadecimales de los SVG son una copia: si cambia un token, se regeneran los maestros y todo lo que sale de ellos.

| Uso                                           | Token                               | Valor      |
| --------------------------------------------- | ----------------------------------- | ---------- |
| Placa del icono                               | `colors.light.blue`                 | `#0A6AA8`  |
| Anillo y punto sobre la placa                 | `colors.light.tile`                 | `#FFFFFF`  |
| Mascota en la cabecera                        | `currentColor` (= `fg`)             | según tema |
| Mascota viva en grande (brote, planta, árbol) | `green`                             | según tema |
| Mascota marchita en grande                    | `neutral`                           | según tema |
| Plantilla monocroma                           | negro con alfa (la tiñe el sistema) | —          |

- **El icono no cambia con el tema.** Es la misma placa azul en temas claros y oscuros. El blanco sobre azul da 5,77:1; la placa contra el fondo claro da 5,06:1, y contra un fondo oscuro la silueta la marca el anillo blanco.
- **Azul es la marca y la acción; verde es crecer y conseguido.** El verde queda para la mascota y los logros. Naranja y rojo nunca van en la marca: significan Estricto, Hardcore, castigo y error.

## Mascota

Una planta en maceta que crece mientras te concentras y se marchita si te rindes (sección 7 de `PROMPT.md`). Las fases son las de `MASCOT_STAGES` en `packages/shared/src/points.ts`:

| Archivo               | Fase     | Id en el código | Silueta                                    |
| --------------------- | -------- | --------------- | ------------------------------------------ |
| `mascot-brote.svg`    | Brote    | `sprout`        | Tallo corto con dos hojas en V             |
| `mascot-planta.svg`   | Planta   | `plant`         | Tallo alto con dos hojas alternas          |
| `mascot-arbol.svg`    | Árbol    | `tree`          | Tronco con una rama y copa de tres lóbulos |
| `mascot-marchita.svg` | Marchita | `wilted`        | Tallo doblado con las hojas colgando       |

- **Estilo de icono, no de ilustración:** rejilla de 24, trazo de 1,75, extremos y uniones redondeados, sin relleno y `currentColor`, como los iconos de lucide que la rodean.
- **La maceta es idéntica en las cuatro fases**, así el icono de la cabecera no salta al cambiar de fase. Las fases se distinguen por la silueta (altura, copa, tallo doblado), no por el color.
- **Cabecera de Progreso:** 16 px, en `fg`, como cualquier otro icono de cabecera.
- **Recompensas («la mascota en grande»):** de 96 a 160 px, con `stroke-width="1.25"` para que no pese; en `green` las fases vivas y en `neutral` la marchita. Sin fondos, sombras ni degradados.
- **Marchita es amable:** gris, nunca rojo, sin cara triste ni textos de culpa. Vuelve a brotar con minutos concentrados (`MASCOT_RULES`).
- **Sin animaciones:** el cambio de fase es instantáneo o un fundido de 120 ms, y nada con `prefers-reduced-motion`. Sin rebotes ni confeti.

## Logros

Las insignias siguen el mismo estilo (rejilla de 24, trazo de 1,75, `currentColor`) y usan el anillo de la marca como marco:

- **Conseguido:** anillo cerrado, en el tile con el estilo de seleccionado en verde.
- **Pendiente:** el anillo con el hueco de 80° de la marca (la «C»), en `fgMuted`, sobre un tile con contorno gris. El estado cambia la forma, no solo el color.
- **Dentro, un solo símbolo** que diga el logro: un «1» para la primera sesión, una llama para la racha, un libro para el Study Mode (el mismo icono que su sección). El nombre y el progreso van en el texto del tile, nunca dentro de la insignia.

## Sí

- Usar los maestros tal cual y generar los PNG, `.ico` e `.icns` con resvg y los colores de `tokens.ts`.
- Dejar el margen de 100 solo para macOS y recortar a la placa en todo lo demás.
- Dejar alrededor de la placa un espacio libre de al menos ⅛ de su lado.
- Usar la plantilla monocroma cuando el sistema tiñe el icono (barra de menús de macOS) o cuando solo hay una tinta.
- Escribir el nombre con tilde, «Céntrate», en la interfaz, la web y los metadatos. Solo los nombres técnicos sin tildes (`centrate`) lo pierden.

## No

- No girar la marca, no mover el hueco de la derecha y no cerrar el anillo en el icono de la app: el anillo cerrado significa «conseguido» en los logros y el disco relleno significa «bloqueo activo» en la bandeja.
- No usar degradados, sombras, brillos, cristal, contornos ni efectos 3D (sección 10 de `PROMPT.md`).
- No usar colores fuera de `tokens.ts`, ni naranja, rojo o verde en la marca.
- No poner la marca en grande dentro de la app: allí solo existen el icono de la ventana y el de la bandeja.
- No añadir texto dentro del icono ni poner cara a la mascota.
- No dibujar la mascota a 24 px o menos con un trazo distinto de 1,75.
- No acompañar la marca con logos de terceros (Apple, G-Helper, YouTube, Windows…) ni imitarlos: las marcas ajenas solo como texto (sección 11 de `PROMPT.md`).

## Por qué esta marca

Se compararon tres direcciones: la diana abierta sobre placa azul, una «C» azul sobre placa oscura y un candado con un reloj de arena como bocallave. Ganó la primera, con dos ideas injertadas de la segunda: el hueco a las 3, que la hace leerse como «C», y el ajuste al píxel, que permite un único maestro. La placa oscura se perdía en barras de tareas y docks oscuros, y el candado era genérico, se confundía con el icono de la sección Bloqueo y obligaba a rehacer la bandeja. La diana continúa lo que ya existe (bandeja, extensión y favicon de la web) y funciona a 16 px, en claro, en oscuro y en una sola tinta.
