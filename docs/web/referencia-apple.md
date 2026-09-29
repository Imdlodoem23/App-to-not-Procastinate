# Referencia: páginas de software de apple.com

La sección 11 de `PROMPT.md` pide estudiar en vivo [apple.com/es/macos/](https://www.apple.com/es/macos/) y [apple.com/es/apple-intelligence/](https://www.apple.com/es/apple-intelligence/), capturarlas a 375, 768, 1280 y 1920 px y apuntar aquí sus medidas y patrones. Las rondas de crítica de la web comparan las capturas de Céntrate con estas.

Reglas:

- Las capturas de Apple son **solo para comparar**: viven en un artefacto de GitHub Actions que caduca a los 7 días. Nunca se suben al repositorio ni se publican.
- De esas páginas se toman **medidas y ritmo**, nunca material: ni logos, ni SF Pro, ni imágenes, ni dispositivos, ni textos o eslóganes.

## Cómo se generan

El workflow **Apple reference** (`.github/workflows/apple-reference.yml`, solo manual) ejecuta `apps/web/scripts/apple-reference.mjs` con Playwright:

1. GitHub → **Actions → Apple reference → Run workflow** (el botón solo sale en la rama por defecto; desde otra rama: `gh workflow run apple-reference.yml --ref <rama>`).
2. Al acabar, el resumen del job muestra las tablas de medidas, y el artefacto `apple-reference` contiene:
   - `<página>-<ancho>-top.png`: la primera pantalla.
   - `<página>-<ancho>-NN.jpg`: una captura por cada pantalla de scroll (hasta 40).
   - `medidas.json` y `medidas.md`: barras, titulares y texto por punto de corte (tamaño, interlineado, espaciado y peso), relleno de las secciones, ancho de la columna, radios y tamaños de tarjetas, píldoras, escenas pegajosas (recorrido en vh), vídeos y transiciones.
3. Copia en las tablas de abajo los valores de la columna «apple.com» y apunta los patrones.

El mismo script mide cualquier otra página con la misma vara, para comparar cifra con cifra:

```sh
# La web de Céntrate en local (después de npm run build -w apps/web y astro preview)
node apps/web/scripts/apple-reference.mjs --url http://localhost:4321/ --out /tmp/referencia
```

O en Actions, con el campo `url` del workflow (por ejemplo, la web publicada en Render).

## Estado

- **apple.com: pendiente.** La red de la sesión en la nube bloquea `www.apple.com` (el proxy responde 403), así que las capturas no se pueden hacer desde aquí. Salen del workflow en cuanto se lance una vez (ver `PENDIENTE_PARA_MI.md`).
- Mientras tanto, la referencia son los valores de la sección 11 del brief, que es lo que implementan `apps/web/src/styles/tokens.css` y `global.css`.
- La columna «Céntrate» está medida con el mismo script sobre la web en local (28-09-2026), para que la comparación sea directa en cuanto haya datos de Apple.

## Medidas

Formato de los titulares y textos: tamaño / interlineado (proporción) / espaciado (em). Los puntos de corte son 1068 y 734 px; la columna «375 · 768 · 1280» da el valor en cada tramo.

### Tipografía

| Elemento                       | Brief (§ 11)                               | Céntrate a 375 · 768 · 1280                   | apple.com |
| ------------------------------ | ------------------------------------------ | --------------------------------------------- | --------- |
| Titular del hero y de capítulo | 64 / 56 / 40 px, 1,06, −0,009 em, peso 600 | 40 / 1,1 · 56 / 1,071 · 64 / 1,063; −0,009 em | pendiente |
| Titular de sección             | 56 / 48 / 32 px                            | 32 / 1,125 · 48 / 1,083 · 56 / 1,071          | pendiente |
| Antetítulo y entradilla gris   | 28 / 24 / 21 px, 1,14                      | 21 / 1,191 · 24 / 1,167 · 28 / 1,143          | pendiente |
| Texto                          | 17 px, 1,47, −0,022 em                     | 17 / 1,471 / −0,022 em en todos               | pendiente |
| Letra pequeña y notas          | 14 px y 12 px                              | 14 / 1,429 y 12 / 1,333                       | pendiente |
| Pesos                          | solo 600 y 400                             | 600 y 400                                     | pendiente |

### Espacio, forma y color

| Elemento                       | Brief (§ 11)                                                                                     | Céntrate a 375 · 768 · 1280 · 1920                        | apple.com |
| ------------------------------ | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------- | --------- |
| Barra superior                 | 52 px, sticky, blanco al 80 % con `saturate(180%) blur(20px)`                                    | 52 px en todos, cristal en `::before`                     | pendiente |
| Columna de contenido           | 87,5 % del ancho, máximo 1260 px                                                                 | 329 · 672 · 1120 · 1260 px                                | pendiente |
| Relleno vertical de sección    | 160 / 128 / 96 px                                                                                | 96 · 128 · 160 · 160 px                                   | pendiente |
| Tarjetas de «Lo más destacado» | 680 px de alto, radio 28                                                                         | 328 × 500 · 672 × 600 · 1120 × 680 · 1260 × 680, radio 28 | pendiente |
| Tarjetas de los capítulos      | 580 px de alto, radio 28                                                                         | 308 × 460 · 400 × 540 · 480 × 580 · 480 × 580, radio 28   | pendiente |
| Tiles                          | radio 18                                                                                         | radio 18                                                  | pendiente |
| Píldora grande y de la barra   | radio 980                                                                                        | 44 px (relleno 22) y 28 px (relleno 12)                   | pendiente |
| Entradilla                     | máximo 840 px                                                                                    | 840 px                                                    | pendiente |
| Colores                        | texto `#1d1d1f`, secundario `#6e6e73`, fondos `#ffffff` y `#f5f5f7`, oscuro `#000` con `#f5f5f7` | los mismos; acción `#0A6AA8`                              | pendiente |
| Escena pegajosa                | unos 300 vh con un bloque sticky de 100 vh                                                       | recorrido de 300 vh, bloque de 100 vh                     | pendiente |

### Movimiento

| Elemento    | Brief (§ 11)                                                                                                     | Céntrate                                        | apple.com |
| ----------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | --------- |
| Aparición   | 30 px, 0,7 s movimiento, 0,9 s opacidad, 0,15 s entre elementos, `cubic-bezier(0.4, 0, 0.6, 1)`, una vez al 85 % | igual (`src/scripts/reveal.ts`)                 | pendiente |
| Qué aparece | solo titulares y galerías                                                                                        | solo titulares y galerías                       | pendiente |
| Vídeos      | `muted playsinline`, pausa y «Repetir»                                                                           | aún sin vídeos (llegan con las capturas reales) | pendiente |

## Patrones que hay que mirar en las capturas

Para cada punto, apunta lo que se ve en apple.com y si Céntrate lo sigue:

- **Ritmo:** cuánto aire hay entre antetítulo, titular, entradilla y visual, y cómo alternan los fondos blanco, gris claro y negro.
- **Titulares:** dónde cortan las líneas en cada ancho y cuántas palabras caben por línea en el móvil.
- **Galerías:** cuánto asoma la tarjeta siguiente, dónde van las flechas y cómo se alinean con la columna.
- **Hero:** proporción entre texto y visual en la primera pantalla a 1280 y a 375 px.
- **Escenas con scroll:** cuántas pantallas dura cada una y qué se anima (solo `transform` y `opacity`).
- **Barra:** cuándo pasa de transparente a translúcida y cómo se pliega en el móvil.
- **Letra pequeña:** notas al pie, requisitos y avisos (tamaño, color y separación).

Observaciones de apple.com: pendientes de la primera ejecución del workflow.
