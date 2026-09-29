# Marca de Céntrate

Guía de la marca: el icono de la app, su versión monocroma y la mascota. Los maestros están en `assets/brand/` y todo lo demás (`.ico`, `.icns`, PNG, iconos de la bandeja y de la extensión, favicons) se genera a partir de ellos con los scripts de [Generadores](#generadores). Es un trabajo original del proyecto, con licencia MIT como el resto del repositorio, y está apuntado en `ASSET-LICENSES.json`.

![Icono de Céntrate](../assets/brand/icon.svg)

## La marca

Una «C» abierta por la derecha con un punto en la boca:

- es la «C» de Céntrate con su punto: «céntrate, y punto»;
- también es una cuenta atrás casi cerrada, que es lo que hace la app, y el punto marca dónde termina;
- el punto va en el hueco, no en el centro: un anillo con un punto centrado es una diana, y ese dibujo ya lo usan otras marcas (ver [Por qué esta marca](#por-qué-esta-marca)). Los extremos redondeados la separan de las «C» de trazo recto, y el punto, de una «C» suelta o de un ©.

**Construcción** (lienzo de 1024, como `assets/brand/icon.svg`):

| Pieza  | Medida                                                                                  |
| ------ | --------------------------------------------------------------------------------------- |
| Placa  | 824 × 824 con 100 de margen, radio de esquina 185                                       |
| Anillo | centro (512, 512), radio 257,5 (línea media), grosor 103, extremos redondeados          |
| Hueco  | 110°, centrado a las 3 (de −55° a +55°)                                                 |
| Punto  | radio 103, centro (718, 512): sobre el borde interior del anillo, en el eje del hueco   |
| Reglas | grosor = radio del punto = ⅛ de la placa; radio del anillo = 2,5 × grosor               |
| Encaje | el punto toca la circunferencia exterior del anillo: la marca ocupa un círculo perfecto |

**Ajustada al píxel.** A 16 px, 1 px son 51,5 unidades del lienzo: el anillo mide 2 px de grosor y 5 px de radio, con los bordes exteriores justo en los píxeles 2 y 14, y el punto 2 px de radio, de los píxeles 10 a 14 en horizontal y de 6 a 10 en vertical. Entre el punto y cada extremo del anillo quedan 1,25 px. A 32 y 48 px todo se multiplica por 2 y por 3. Por eso un único maestro sirve desde 16 hasta 1024 px, sin un dibujo aparte para los tamaños pequeños.

## Archivos

| Archivo                              | Qué es                                                    | Dónde se usa                                                                                                |
| ------------------------------------ | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `icon.svg`                           | Icono de la app, lienzo de 1024 con el margen de macOS    | `.icns` tal cual; `.ico`, PNG de Linux, favicons, extensión y bandeja con un bloqueo, recortados a la placa |
| `icon-mono.svg`                      | Plantilla monocroma de 16 unidades (solo cuenta el alfa)  | Barra de menús de macOS (_template image_), bandeja en reposo, impresión a una tinta                        |
| `mascot-brote.svg` … `-marchita.svg` | Las 4 fases de la mascota, rejilla de 24 al estilo lucide | Cabecera de Progreso (16 px) y ventana Recompensas (en grande)                                              |

`icon.svg` lleva los identificadores `plate`, `ring` y `dot`, e `icon-mono.svg`, `ring` y `dot`, para que los generadores cambien los colores desde `tokens.ts` sin reescribir el dibujo.

## Generadores

Todos leen los maestros por identificador con `scripts/brand-masters.mjs`, cambian solo los colores (de `tokens.ts`) y dibujan con resvg. Los archivos generados se suben al repositorio; cada script acepta `--check`, que el CI ejecuta para fallar si alguno no está al día, y el flujo «Marketing assets» los regenera todos en cada versión.

| Script                                    | Maestro                                           | Archivos                                                                                                                  |
| ----------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `scripts/gen-app-icons.mjs`               | `icon.svg`                                        | `apps/desktop/build/` (`.icns`, `.ico`, PNG de Linux), `favicon.svg`, `favicon-32.png` y `apple-touch-icon.png` de la web |
| `apps/desktop/scripts/gen-tray-icons.mjs` | `icon-mono.svg` en reposo, `icon.svg` con bloqueo | `apps/desktop/resources/assets/tray/`                                                                                     |
| `apps/extension/scripts/gen-icons.mjs`    | `icon.svg`                                        | `apps/extension/public/icons/`                                                                                            |

No dibujes la marca a mano en ningún otro sitio: si hace falta en un tamaño o formato nuevo, añádelo a uno de estos scripts.

## Tamaños y recortes

- **macOS (`.icns`):** `icon.svg` tal cual, 1024 con 100 de margen, que es la rejilla de iconos de macOS.
- **Windows (`.ico`: 16, 20, 24, 32, 40, 48, 64 y 256), Linux (PNG de 16 a 512), favicons y extensión:** recorta a la placa con `viewBox="100 100 824 824"`. En esos sistemas el icono ocupa toda la caja, sin margen. Única excepción: el icono de 128 px de la extensión dibuja la placa a 96 px con 16 px transparentes alrededor, como pide la Chrome Web Store.
- **Tamaños pequeños:** 16, 32 y 48 px salen nítidos porque son múltiplos de la rejilla; 20 y 24 px salen bien, algo más suaves. No añadas un contorno ni cambies el grosor para «arreglarlos».
- **Bandeja y barra de menús:** `icon-mono.svg` en caja de 16 unidades, dibujado a 16, 20, 24 y 32 px. Anillo de radio 6 y grosor 2, hueco de 110° a la derecha y punto de radio 2 sobre el borde interior del anillo, como en `icon.svg`. A 16 y 32 px sale nítido: el anillo va de los píxeles 1 a 15 y el punto, de 11 a 15.
- **Estados de la bandeja:** en reposo, la plantilla monocroma en el `fg` del tema (en macOS, _template image_ que tiñe el sistema); con un bloqueo, un disco en el color del modo con la marca de `icon.svg` recortada, como el icono de la app pero redondo y calado; y el punto rojo de la cámara arriba a la derecha (sección 10 de `PROMPT.md` y `apps/desktop/scripts/gen-tray-icons.mjs`). El cambio de estado cambia la forma, no solo el color.
- **Extensión:** el mismo icono que la app, nunca el disco de la bandeja: en la barra del navegador no debe parecer que hay un bloqueo activo.

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

| Archivo               | Fase     | Id en el código | Silueta                                      |
| --------------------- | -------- | --------------- | -------------------------------------------- |
| `mascot-brote.svg`    | Brote    | `sprout`        | Tallo corto y curvo con dos hojas desiguales |
| `mascot-planta.svg`   | Planta   | `plant`         | Tallo alto con dos hojas alternas            |
| `mascot-arbol.svg`    | Árbol    | `tree`          | Tronco corto y copa de tres lóbulos          |
| `mascot-marchita.svg` | Marchita | `wilted`        | Tallo doblado con las hojas colgando         |

- **Estilo de icono, no de ilustración:** rejilla de 24, trazo de 1,75, extremos y uniones redondeados, sin relleno y `currentColor`, como los iconos de lucide que la rodean.
- **Llena la rejilla como lucide:** la maceta va de 4 a 20 de ancho y de 16,5 a 22 de alto, y la planta sube hasta y ≈ 3,5 (la copa del árbol, hasta 2). Así, a 16 px el dibujo ocupa unos 13 × 15 px, como el candado o el libro de al lado, y no queda más bajo que ellos. Las hojas miden al menos 5 de ancho para que su hueco sobreviva al trazo de 1,75 px y no se vean como manchas. El brote lleva las hojas desiguales y el tallo curvo para no confundirse con el trofeo de «Logros…».
- **La maceta es idéntica en las cuatro fases**, así el icono de la cabecera no salta al cambiar de fase. Las fases se distinguen por la silueta (altura, copa, tallo doblado), no por el color.
- **Cabecera de Progreso:** 16 px, en `fg`, como cualquier otro icono de cabecera.
- **Recompensas («la mascota en grande»):** de 96 a 160 px, con `stroke-width="1.25"` para que no pese; en `green` las fases vivas y en `neutral` la marchita. Sin fondos, sombras ni degradados.
- **Marchita es amable:** gris, nunca rojo, sin cara triste ni textos de culpa. Vuelve a brotar con minutos concentrados (`MASCOT_RULES`).
- **Sin animaciones:** el cambio de fase es instantáneo o un fundido de 120 ms, y nada con `prefers-reduced-motion`. Sin rebotes ni confeti.

## Logros

Las insignias siguen el mismo estilo (rejilla de 24, trazo de 1,75, `currentColor`) y usan el anillo de la marca como marco:

- **Conseguido:** anillo cerrado, en el tile con el estilo de seleccionado en verde.
- **Pendiente:** el anillo con el hueco de 110° de la marca (la «C», sin el punto), en `fgMuted`, sobre un tile con contorno gris. El estado cambia la forma, no solo el color.
- **Dentro, un solo símbolo** que diga el logro: un «1» para la primera sesión, una llama para la racha, un libro para el Study Mode (el mismo icono que su sección). El nombre y el progreso van en el texto del tile, nunca dentro de la insignia.

## Sí

- Usar los maestros tal cual y generar los PNG, `.ico` e `.icns` con resvg y los colores de `tokens.ts`.
- Dejar el margen de 100 solo para macOS y recortar a la placa en todo lo demás.
- Dejar alrededor de la placa un espacio libre de al menos ⅛ de su lado.
- Usar la plantilla monocroma cuando el sistema tiñe el icono (barra de menús de macOS) o cuando solo hay una tinta.
- Escribir el nombre con tilde, «Céntrate», en la interfaz, la web y los metadatos. Solo los nombres técnicos sin tildes (`centrate`) lo pierden.

## No

- No girar la marca, no mover el hueco de la derecha y no cerrar el anillo en el icono de la app: el anillo cerrado significa «conseguido» en los logros y el disco relleno significa «bloqueo activo» en la bandeja.
- No llevar el punto al centro del anillo: sería una diana, el dibujo de otras marcas (ver abajo).
- No usar degradados, sombras, brillos, cristal, contornos ni efectos 3D (sección 10 de `PROMPT.md`).
- No usar colores fuera de `tokens.ts`, ni naranja, rojo o verde en la marca.
- No poner la marca en grande dentro de la app: allí solo existen el icono de la ventana y el de la bandeja.
- No añadir texto dentro del icono ni poner cara a la mascota.
- No dibujar la mascota a 24 px o menos con un trazo distinto de 1,75.
- No acompañar la marca con logos de terceros (Apple, G-Helper, YouTube, Windows…) ni imitarlos: las marcas ajenas solo como texto (sección 11 de `PROMPT.md`).

## Por qué esta marca

Se compararon tres direcciones: la diana abierta sobre placa azul, una «C» azul sobre placa oscura y un candado con un reloj de arena como bocallave. Ganó la primera, con dos ideas injertadas de la segunda: el hueco a las 3, que la hace leerse como «C», y el ajuste al píxel, que permite un único maestro. La placa oscura se perdía en barras de tareas y docks oscuros, y el candado era genérico, se confundía con el icono de la sección Bloqueo y obligaba a rehacer la bandeja. La diana continuaba lo que ya existía (bandeja, extensión y favicon de la web) y funcionaba a 16 px, en claro, en oscuro y en una sola tinta.

**Revisión de originalidad (septiembre de 2026).** Aquella primera versión llevaba el punto en el centro del anillo. Comparada con los 3.463 logotipos de marcas de [simple-icons](https://simpleicons.org) 16.33.0 (superposición de siluetas normalizadas, en las 8 orientaciones), quedaba en la familia de las dianas y los anillos con punto central: CircleCI (anillo con punto y hueco a la izquierda), Clerk (anillo abierto por la derecha con punto central) y Target (diana), y la bandeja con un bloqueo, un disco con un anillo calado, era la diana de Target en rojo. Por eso el punto pasó a la boca de la «C», el hueco creció de 80° a 110° para que quepa con aire, y la bandeja y la extensión salen ahora de los maestros. En la misma comparación, CircleCI pasó del puesto 14 al 177 de los más parecidos, Target del 3 al 43 y Clerk del 68 al 1.021, y los más cercanos (Open Collective, Eagle, MLflow) solo coinciden en ser un anillo grueso. Falta la búsqueda de marcas figurativas en TMview (EUIPO) y en la Global Brand Database (OMPI) antes de publicar la primera versión (`PENDIENTE_PARA_MI.md`).
