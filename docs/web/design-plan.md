# Céntrate web: plan de diseño

Plan del diseño de `apps/web`, escrito siguiendo el proceso de la skill `frontend-design` (plan → revisión contra el brief → revisión del plan) con la sección 11 de `PROMPT.md` como brief. El estilo Apple de esa sección manda sobre los valores por defecto de la skill.

- **Tokens:** `apps/web/src/styles/tokens.css` (implementa todo lo de este documento; los valores de allí mandan si algo no coincide).
- **Textos:** `apps/web/src/content/copy.ts` (y su versión legible, `docs/web/copy.md`). Ningún componente escribe textos propios.
- **Reparto de archivos:** BASE (layout, estilos globales, barra, pie, `reveal.ts`, SEO), HERO (`AppWindow`, `Hero`, `Highlights`, `LiveDemo`), SCENE (`StickyScene`), SECTIONS (capítulos, galería, privacidad, números, más funciones, FAQ, descarga final, notas) y PAGES (`/descargar`, `/novedades`, `/privacidad`).

Las medidas se han comprobado con Playwright sobre el texto real de `copy.ts` e Inter servida desde `node_modules` (capturas temporales, fuera del repositorio).

## 1. El tema, el público y el trabajo de la página

- **Qué es:** una app de escritorio gratuita que bloquea distracciones escribiendo una frase («no veo YouTube en una hora») y que sigue bloqueando con la app cerrada, con un Study Mode que usa la cámara en local.
- **Para quién:** estudiantes de secundaria, bachillerato y universidad en España, casi siempre en un portátil con Windows, que ya han probado a «tener fuerza de voluntad». Llegan desde un enlace o una búsqueda, a menudo desde el móvil.
- **El trabajo de la página:** que en 10 segundos se entienda «escribes una frase y se bloquea, aunque cierres la app», que se confíe en la cámara, y que el botón de descarga sea evidente.

## 2. Punto de vista

1. **La app es la foto.** No hay fotografías ni ilustraciones: la imagen de producto es la propia ventana de Céntrate, oscura, densa y pequeña (440 px, estilo herramienta), flotando en una página clara, lenta y con mucho aire. El contraste entre la página generosa y la herramienta compacta es la identidad visual.
2. **Tipografía como imagen.** Titulares en dos tiempos, acabados en punto, una línea por tiempo. Las cifras («−10 puntos por cada intento.») son frases enteras a tamaño de titular, no «número grande + etiqueta».
3. **Un solo hilo verde.** El punto verde de «Guardián activo» del pie de la app es el único motivo recurrente: vive en la ventana y, en la escena pegajosa, se queda solo en pantalla cuando la ventana se va. Es la idea del producto (el guardián sigue) contada con un punto de 8 px.
4. **Color con significado.** Azul de marca solo para acciones (botones, enlaces, foco). Los acentos de la app (verde, naranja, rojo) solo aparecen dentro de la maqueta de la app, con el significado que tienen allí. Un único degradado en toda la web.
5. **Movimiento que se gana su sitio.** Una sola escena controlada por el scroll (la estrella), una aparición sobria en titulares y galerías, y nada más.

### El elemento memorable

**La escena pegajosa «Ciérrala. Sigue funcionando.»** (sección 6.5). Todo lo demás es tranquilo y disciplinado para que esta escena sea lo que se recuerda: la ventana se cierra, queda solo el punto verde del guardián, un navegador intenta abrir youtube.com y aparece la página de bloqueo con «−10 puntos».

## 3. Tokens

### 3.1 Color

Valores en bruto (`--palette-*`). Los componentes usan los tokens semánticos de 3.2, no estos.

| Token                         | Hex                     | Uso                                                   | Contraste                                               |
| ----------------------------- | ----------------------- | ----------------------------------------------------- | ------------------------------------------------------- |
| `ink`                         | `#1d1d1f`               | texto principal en claro                              | 16,83:1 sobre blanco · 15,46:1 sobre `snow`             |
| `ink-2`                       | `#6e6e73`               | texto secundario y entradillas grises en claro        | 5,07:1 sobre blanco · 4,66:1 sobre `snow`               |
| `white` / `snow`              | `#ffffff` / `#f5f5f7`   | fondos alternos                                       | —                                                       |
| `black`                       | `#000000`               | secciones oscuras                                     | —                                                       |
| `snow` sobre negro            | `#f5f5f7`               | texto principal en oscuro                             | 19,29:1                                                 |
| `mist`                        | `#86868b`               | texto secundario en oscuro                            | 5,80:1 sobre negro                                      |
| `graphite` / `graphite-hover` | `#1d1d1f` / `#2c2c2e`   | tiles de descarga y superficies elevadas en oscuro    | `snow` sobre ellos ≥ 13:1                               |
| `hairline` / `hairline-dark`  | `#d2d2d7` / `#424245`   | separadores (FAQ, pie). Decorativos                   | no transmiten información                               |
| `fill` / `fill-hover`         | `#e8e8ed` / `#dcdce1`   | fichas de ejemplo, flechas de galería                 | `ink` sobre `fill` 13,78:1 (nunca `ink-2` sobre `fill`) |
| **`blue`** (acción)           | **`#0a6aa8`**           | botones, enlaces y foco en claro                      | **5,77:1** sobre blanco · 5,30:1 sobre `snow`           |
| `blue-hover` / `blue-active`  | `#0b72b5` / `#085a8f`   | fondo del botón al pasar el ratón / al pulsar         | blanco encima 5,14:1 / 7,32:1                           |
| `blue-dark`                   | `#3aaeef`               | enlaces y foco en oscuro                              | 8,48:1 sobre negro · 6,80:1 sobre `graphite`            |
| `green-dark`                  | `#06b48a`               | final del degradado                                   | 7,90:1 sobre negro                                      |
| `glass`                       | `rgb(255 255 255 / .8)` | barra de navegación (con `saturate(180%) blur(20px)`) | `ink` ≥ 10,48:1 incluso sobre negro                     |
| `nav-border`                  | `rgb(0 0 0 / .16)`      | línea inferior de la barra                            | —                                                       |
| `glass-control` / `-hover`    | `rgb(232 232 237 / .8)` | píldora pegajosa de «Lo más destacado»                | `ink` ≥ 8,66:1; puntos ≥ 3,13:1 (también sobre negro)   |
| `dot`                         | `rgb(29 29 31 / .56)`   | puntos inactivos de esa píldora                       | ≥ 3,13:1 contra la píldora                              |
| `browser-frame` / `-field`    | `#1d1d1f` / `#2c2c2e`   | el navegador genérico de la escena                    | texto `snow`                                            |
| `--aw-*`                      | sección 10, tema oscuro | solo dentro de la maqueta de la app (sección 7)       | los de `packages/shared` (ya validados allí)            |

**El azul de acción:** es el azul del tema claro de la app (`#0A6AA8`) sin cambios, porque ya cumple 4,5:1 sobre blanco (5,77:1) y sobre `#f5f5f7` (5,30:1), y el texto blanco encima también (5,77:1). En secciones oscuras se usa el azul del tema oscuro de la app (`#3AAEEF`) para enlaces y foco: es el mismo color de marca en su versión oscura. Los botones píldora son siempre `#0A6AA8` con texto blanco, también sobre negro.

**El degradado:** solo «Sigue funcionando.», sobre negro: `linear-gradient(90deg, #3aaeef, #06b48a)` (azul = información, verde = guardián OK; los dos colores de marca del tema oscuro). Ningún otro texto, fondo ni borde lleva degradado.

### 3.2 Superficies y orden de fondos

Cada sección lleva `data-surface="light" | "alt" | "dark"` y los tokens semánticos siguen solos: `--surface`, `--surface-raised`, `--text`, `--text-secondary`, `--link`, `--focus`, `--hairline`, `--fill`, `--fill-hover` (en Tailwind: `bg-surface`, `bg-raised`, `text-primary`, `text-secondary`, `text-link`, `outline-focus`, `border-hairline`, `bg-fill`…).

| Superficie | Fondo     | Elevada (tarjetas) | Texto / secundario    | Enlace y foco |
| ---------- | --------- | ------------------ | --------------------- | ------------- |
| `light`    | `#ffffff` | `#f5f5f7`          | `#1d1d1f` / `#6e6e73` | `#0a6aa8`     |
| `alt`      | `#f5f5f7` | `#ffffff`          | `#1d1d1f` / `#6e6e73` | `#0a6aa8`     |
| `dark`     | `#000000` | `#1d1d1f`          | `#f5f5f7` / `#86868b` | `#3aaeef`     |

Orden en la página de inicio (alterna claro y gris; dos negros, el de la escena y el de la descarga):

```text
Barra (glass) → Hero light → Destacados alt → Demo light → ESCENA dark → Capítulos alt (×3)
→ Privacidad light → Números alt → Y mucho más light → FAQ alt → Descarga dark → Notas y pie alt
```

Sin modo oscuro automático: `color-scheme: light` en `:root` (lo pone BASE).

### 3.3 Tipografía

- **Fuente:** Inter variable (OFL), autoalojada desde `@fontsource-variable/inter/opsz.css` (ejes `opsz` 14–32 y `wght`). `font-optical-sizing: auto` (por defecto) elige el corte Display en titulares y el de texto en el cuerpo. `font-display: swap` ya viene en el CSS del paquete.
- **Precarga:** solo `inter-latin-opsz-normal.woff2` (72,9 KB). Todo el español cabe en el subconjunto latino (también «−», «…», «», «¿», «¡»). No se carga la cursiva: la única cursiva (el motivo dentro de la maqueta) es oblicua sintética.
- **Respaldo sin salto:** `'Inter Fallback'` = Arial local con `size-adjust: 107.12%`, `ascent-override: 90.44%`, `descent-override: 22.52%` (definido en `tokens.css`).
- **Pesos:** solo 400 y 600. Nada de 500 ni 700 (Tailwind solo tiene `font-regular` y `font-semibold`).

Escala por saltos (grande ≥ 1069 px / mediana ≤ 1068 px / pequeña ≤ 734 px):

| Rol (utilidad Tailwind)                                        | Grande                 | Mediana                | Pequeña                | Peso                   |
| -------------------------------------------------------------- | ---------------------- | ---------------------- | ---------------------- | ---------------------- |
| Hero, capítulos, números (`text-hero`)                         | 64 / 1,0625 / −0,009em | 56 / 1,0714 / −0,009em | 40 / 1,1 / −0,009em    | 600                    |
| Titular de sección (`text-section`)                            | 56 / 1,0714 / −0,005em | 48 / 1,0834 / −0,003em | 32 / 1,125 / +0,004em  | 600                    |
| Antetítulo, entradilla gris, título de destacado (`text-lead`) | 28 / 1,1428 / +0,004em | 24 / 1,1667 / +0,006em | 21 / 1,1905 / +0,008em | 600 o 400              |
| Título no titular: FAQ, valores de la demo (`text-title`)      | 21 / 1,1905 / +0,004em | 21                     | 17 / 1,2353 / −0,01em  | 600                    |
| Texto (`text-body`)                                            | 17 / 1,4706 / −0,022em | igual                  | igual                  | 400 (600 en arranques) |
| Letra pequeña (`text-small`)                                   | 14 / 1,4286 / −0,016em | igual                  | igual                  | 400                    |
| Notas (`text-note`)                                            | 12 / 1,3333 / −0,01em  | igual                  | igual                  | 400                    |
| Barra: marca / enlaces y píldora                               | 21 / 12                | igual                  | igual                  | 600 / 400              |

(tamaño en px / interlineado / espaciado)

Reglas:

- **Titulares en dos tiempos** («Escríbelo. Y olvídate.», «Tú pones la frase. Céntrate pone el límite.»): cada frase en un `<span>` de bloque, una línea por tiempo, a partir de 735 px. El hero mantiene los dos tiempos también en móvil (cada uno cabe a 40 px). En los capítulos y en la escena, por debajo de 735 px los tiempos fluyen en línea con `text-wrap: balance`: medido a 375 px, forzar las líneas deja huérfanos como «Cada minuto / suma.» (4 líneas); fluyendo quedan 3. Se parte con `/(?<=\.)\s+/` sobre el texto de `copy.ts`.
- `text-wrap: balance` en todos los titulares; `text-wrap: pretty` en párrafos.
- Líneas de texto ≤ 680 px (`max-w-text`, unos 75 caracteres a 17 px). Entradillas grises ≤ 840 px (`max-w-lead`).
- Mayúscula solo al empezar la frase; los titulares acaban en punto (ya viene así en `copy.ts`).
- Números: `font-variant-numeric: tabular-nums` en cuentas atrás y horas; el menos siempre «−» (U+2212), como en `copy.ts`.
- Arranques en negrita (galerías, privacidad): `<strong>` en 600 y `--text`, el resto de la frase en `--text-secondary`.
- Nada de mayúsculas sostenidas, ni letra monoespaciada salvo comandos y nombres de archivo en `/descargar` (`font-mono` = fuentes del sistema, nada se descarga).

Líneas medidas con el texto real:

| Titular                                        | 1440 | 1068 | 734       | 375       |
| ---------------------------------------------- | ---- | ---- | --------- | --------- |
| Escríbelo. / Y olvídate.                       | 2    | 2    | 2         | 2         |
| Tú pones la frase. / Céntrate pone el límite.  | 2    | 2    | 2         | 3         |
| Mirar el cuaderno es estudiar. / El móvil, no. | 2    | 2    | 2         | 3         |
| Cada minuto suma. / Cada intento resta.        | 2    | 2    | 2         | 3         |
| Ciérrala. / Sigue funcionando.                 | 2    | 2    | 2         | 2         |
| −10 puntos por cada intento.                   | 1    | 1    | 1         | 2         |
| 60 minutos de castigo si no estudias.          | 1    | 1    | 2         | 3         |
| +2 puntos por cada minuto concentrado.         | 1    | 2    | 2         | 3         |
| Tu cámara no sale de tu ordenador. (6 col)     | 2    | 2    | 2 (1 col) | 2 (1 col) |
| Entradillas de capítulo (28/24/21)             | 3–4  | 3    | 3–4       | 7         |

### 3.4 Espacio y retícula

- **Columna de contenido:** 87,5 % del ancho, máximo 1260 px (1440 → 1260, 1068 → 935, 734 → 642, 375 → 328). En un elemento a todo el ancho, `padding-inline: var(--page-gutter)` da exactamente esa columna, sin depender de `vw` (así no se descuadra con la barra de desplazamiento de Windows); el mismo token sirve de `scroll-padding-inline` en las galerías. `--content-width` es la misma columna como ancho.
- **Retícula:** 12 columnas; hueco 24 / 20 / 16 px.
- **Relleno vertical de sección:** 160 / 128 / 96 px (`--section-pad-block`). Hero: 96 / 80 / 56 px bajo la barra.
- **Ritmo dentro de una sección:** antetítulo → titular 12 · titular → entradilla 24 / 24 / 16 · cabecera → contenido 80 / 64 / 48 · tarjeta → pie 20 · galería → flechas 32 / 32 / 24 · bloques apilados 96 / 80 / 64 · subsecciones de páginas de documentación 64 / 56 / 48.
- **Alineación:** hero, escena y descarga final centrados; todo lo demás alineado a la izquierda de la columna (como las páginas de software de Apple).

### 3.5 Forma y profundidad

- Radios: **28** tarjetas (destacados, capítulos, resultado de la demo, resumen de privacidad) · **18** tiles (descargas, campo de la demo) · **980** píldoras (botones, fichas, píldora de controles) · **8** la ventana de la app (Windows 11) · **12** el navegador genérico.
- **Una sola sombra** en toda la web: la de la ventana flotante (`shadow-window`). Sobre negro, en lugar de sombra, un filo de 1 px `rgb(255 255 255 / .1)` (`--rim-window-dark`). Tarjetas, botones y texto: sin sombra.
- Nada de bordes en tarjetas: se separan del fondo por el color (`alt` ↔ blanco).

### 3.6 Controles

| Control                  | Medidas                                                                    | Color                                                                          |
| ------------------------ | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Botón píldora grande     | alto 44, relleno lateral 22, texto 17/400, radio 980                       | fondo `action`, texto blanco; hover `action-hover`; pulsado `action-active`    |
| Píldora de la barra      | alto 28, relleno lateral 12, texto 12/400                                  | igual                                                                          |
| Enlace                   | texto del contexto (17, 14 o 12), sin flecha ni «›» añadidos               | `--link`; subrayado solo al pasar el ratón (grosor 1 px, separación 0,18em)    |
| Ficha (ejemplos de demo) | alto 36, relleno 16, texto 14, radio 980                                   | fondo `fill`, hover `fill-hover`, texto `--text`                               |
| Flechas de galería       | círculo de 36, chevron de 16 px                                            | fondo `fill`, icono `--text`; en los extremos, `aria-disabled` y opacidad 0,42 |
| Tile de descarga (negro) | alto mínimo 88, radio 18, relleno 20 × 24; etiqueta 17/600 y archivo 12    | fondo `graphite` (hover `graphite-hover`); el del sistema detectado, `action`  |
| Anillo de foco           | `outline: 2px solid var(--focus); outline-offset: 3px` en `:focus-visible` | `--focus` (azul de la superficie)                                              |

Hover: solo cambia el fondo de botones, fichas, flechas y tiles (100 ms). Nada de hover en tarjetas ni imágenes.

### 3.7 Tailwind

`tokens.css` borra la paleta, la escala de texto, los radios, las sombras y los puntos de corte por defecto de Tailwind, y define: `sm:` ≥ 735, `md:` ≥ 1069, `xl:` ≥ 1441 (y sus `max-sm:` ≤ 734, `max-md:` ≤ 1068); colores `surface`, `raised`, `primary`, `secondary`, `link`, `focus`, `hairline`, `fill`, `fill-hover`, `action`, `action-hover`, `action-active`, `on-action`, `glass`, `glass-control`; texto `hero`, `section`, `lead`, `title`, `body`, `small`, `note`; pesos `regular` y `semibold`; radios `card`, `tile`, `pill`; sombra `window`; curvas `reveal` y `ui`; anchos `max-w-content`, `max-w-lead`, `max-w-text`. `bg-red-500`, `text-sm` o `rounded-lg` ya no existen: si hace falta algo nuevo, se añade a `tokens.css`.

## 4. Página de inicio, sección a sección

Wireframes a 1440 × 900 y 375 × 667. `[ ]` = campo o tile, `( )` = píldora, `|` = borde de la columna.

### 4.1 Barra (BASE)

Pegajosa, 52 px, `glass` + `backdrop-filter: saturate(180%) blur(20px)` (con `-webkit-`), línea inferior de 1 px `nav-border`. Se queda clara también sobre las secciones negras. `scroll-padding-top: 52px` en `html` para los anclajes.

```text
1440  |Céntrate                               Funciones   Study Mode   Privacidad   (Descargar)|
       21/600                                  12/400, 24 px entre enlaces           píldora 28

375   |Céntrate                                                      (Descargar)   [v]|
                                              botón 44×44 con chevron: «Abrir menú» / «Cerrar menú»
      +--------------------------------------------------------------------------------+
      | Funciones                                                                     |  panel glass bajo la barra,
      | Study Mode                                                                    |  enlaces a 17 px, 48 px de alto
      | Privacidad                                                                    |
```

El panel se abre por debajo de 735 px con `aria-expanded`/`aria-controls`, se cierra con Esc y al elegir un enlace. Sin animación de altura (aparece con un fundido de 0,3 s, nada con movimiento reducido). La píldora siempre lleva `aria-label` «Descargar Céntrate» y va a `#descargar`.

### 4.2 Hero (HERO) · `light`

Centrado. La ventana de la app entra por debajo: en el primer pantallazo a 1440 × 900 se ven la barra de título y la sección Bloqueo con la frase escrita, que es justo la historia.

```text
1440 × 900
+------------------------------------------------------------------------------+ 0
| barra                                                                        | 52
|                                                                              | 96
|                                 Céntrate                                     | 28/600 (antetítulo, <p>)
|                                Escríbelo.                                    | 64/600 (<h1>, un tiempo por línea)
|                                Y olvídate.                                   |
|                                                                              | 32
|                     ( Descargar gratis para Windows )                        | píldora 44
|                  Gratis y sin cuenta. Windows 10 y 11.                       | 14, secundario (8 de separación)
|                              Otros sistemas                                  | 17, enlace (8)
|                                                                              | 64
|                  +--------------------------------------+                    |
|                  | Céntrate                          | X |   AppWindow        | zoom 1.2 → 528 px de ancho
|                  | [c] Bloqueo: ninguno  Próximo hor… |   sombra window      |
|                  | [ no veo YouTube en una hora|    ] |                      |
|                  | (Y YouTube) (1 h) (hasta 17:42)    |                      |
|- - - - - - - - - | [Deberes][Examen][Leer][Más…     ] | - - - - - - - - - - -| 900 (pliegue)
|                  | …Study Mode, Progreso, pie…        |  (|| Pausar)         | control a la derecha, abajo
|                  +--------------------------------------+                    |
|                                                                              | 160 hasta la siguiente
+------------------------------------------------------------------------------+

375 × 667
+--------------------------------+
| barra                          | 52
|                                | 56
|            Céntrate            | 21/600
|           Escríbelo.           | 40/600
|           Y olvídate.          |
|     ( Ver las descargas )      | en móvil el botón va a /descargar
|  Céntrate es para ordenador:   | 14
|    Windows, macOS y Linux.     |
|   +------------------------+   | 40; AppWindow zoom 0.7 → 308 px
|   | Céntrate            X  |   |
|   | Bloqueo: ninguno       |   |
|- -| [ no veo YouTube…   ]  |- -| 667
```

- **Botón por sistema** (detectado con `navigator.userAgentData?.platform` y, si no, `navigator.userAgent`): Windows → `Centrate-Setup.exe`, macOS → `.dmg`, Linux → `.deb`, móvil o desconocido → `/descargar` con `hero.cta.other`. El HTML estático sale con la versión de Windows (la prioridad); el script solo cambia etiqueta, nota y `href`, con el mismo ancho mínimo para que no salte nada. «Otros sistemas» se oculta cuando el botón ya es «Ver las descargas».
- **Visual:** la ventana flota sola, sin dispositivo ni inclinación, con la sombra `window`. Alineada por abajo: cuando cambia de estado y cambia de alto, crece hacia arriba, como la ventana real en Windows (borde inferior fijo). Mientras no haya vídeo, la secuencia animada de 6.3 hace de vídeo.
- **LCP:** el titular. Nunca se oculta ni se anima (ni siquiera con la aparición); solo la ventana entra con la aparición al cargar.

### 4.3 «Lo más destacado.» (HERO) · `alt`

Cuatro tarjetas del ancho de la columna (1260 × 680, radio 28), blancas salvo la cuarta, negra. Galería horizontal a todo el ancho con `scroll-snap-type: x mandatory`; la siguiente tarjeta asoma en el margen derecho.

```text
1440
| Lo más destacado.                                                  56/600, izquierda
|                                                                    80
|+----------------------------------------------------------------+ 20 +------
|| Escríbelo y listo.            (28/600)                         |    | Sigue
|| Escribe «no veo YouTube en una hora» y                         |    | blo…
|| pulsa Enter dos veces: una para revisarlo…  (17, secundario,   |    |
||                                              máx. 400 px)       |    |
||                          +-------------------------------+     |    |
||                          | AppWindow «typing», zoom 1.1  |     |    |
||                          | (484 px), a 96 px del borde   |     |    |
||                          | derecho, sangra por abajo     |     |    |
|+--------------------------+-------------------------------+-----+    +------
|                                                                    32
|                  ( • ━━━━ • • )  ( || Pausar )                    píldoras glass 56 px, pegajosas
|                                                                    (sticky, bottom: 32px), centradas

375
| Lo más destacado.                 32/600
|+-------------- 328 × 500 ------+ 16
|| Escríbelo y listo.   21/600    |
|| Escribe «no veo YouTube…» 17   |
||  +------------------------+    |
||  | AppWindow zoom 0.7     |    |
|+--+------------------------+----+
|      ( • ━━ • • ) ( || Pausar )   48 px
```

| Tarjeta                                | Fondo  | Visual                                                |
| -------------------------------------- | ------ | ----------------------------------------------------- |
| Escríbelo y listo.                     | blanco | AppWindow `typing`, partes título + Bloqueo           |
| Sigue bloqueado aunque cierres la app. | blanco | AppWindow `countdown` completa                        |
| Cada intento te cuesta 10 puntos.      | blanco | AppWindow `blocked-page` (columna oscura sin ventana) |
| El Study Mode te ve estudiar.          | negro  | AppWindow `study` (más adelante, el vídeo en bucle)   |

En la tarjeta negra el texto es `snow` / `mist` (lleva `data-surface="dark"`). Las notas al pie van como superíndice al final del texto. Autoplay: 6.4.

### 4.4 Demo en vivo (HERO) · `light`

```text
1440
| Pruébalo sin instalar nada.                                        56/600
| Escribe lo que quieres evitar, como lo dirías tú, y mira lo que    28, secundario, 840
| haría Céntrate.
|                                                                    80
| +----------- 6 columnas -----------+  +----------- 6 columnas -----------+
| | ¿Qué quieres hacer?     17/600   |  |  bg raised (#f5f5f7), radio 28,   |
| | +------------------------------+ |  |  relleno 40                       |
| | | no veo YouTube en una hora   | |  |  Esto haría Céntrate    21/600    |
| | +------------------------------+ |  |  Céntrate bloquearía YouTube      |
| |   campo 64 px, radio 18, 21 px   |  |  durante 1 h, hasta las 17:42.    |
| | Por ejemplo, «no veo…»  14       |  |  (17, aria-live="polite")         |
| | Prueba con              14/600   |  |  Qué se bloquea    Duración       |  etiqueta 14 secundario
| | (no veo YouTube…) (nada de       |  |  YouTube           1 h            |  valor 21/600
| |  TikTok…) (bloquea las redes…)   |  |  Termina a las     Modo           |
| |  (sin juegos…) (no quiero…)      |  |  17:42             Normal         |
| |                                  |  |  En modo Normal: después solo…  14|
| +----------------------------------+  +-----------------------------------+
| Es una demostración: aquí no se bloquea nada. …   12, secundario

375: todo apilado; campo 56 px de alto con texto de 17 px; fichas en varias filas.
```

- El campo es un `<input>` de verdad, con su `<label>` visible. Fondo `raised`, borde de 1 px `hairline`, foco con el anillo azul. El parser (`@centrate/shared`) se importa de forma diferida (`import()` al primer foco o cuando la sección está a una pantalla), para no cargarlo en la primera vista.
- **Sin frase de ejemplo rotando** en el marcador de posición (ver 11): el marcador es fijo (`demo.inputHint`) y las fichas hacen de ejemplos; al pulsar una se rellena el campo.
- El resultado se actualiza al escribir (con 250 ms de espera) y se anuncia con `aria-live="polite"`.

### 4.5 Escena pegajosa (SCENE) · `dark`

Ver 6.5 para la línea de tiempo.

```text
1440
|                                                                    160
|                               Ciérrala.                             64/600, centrado
|                          Sigue funcionando.                         el único degradado
|        Los bloqueos los aplica el guardián, un pequeño servicio…¹   28, mist, 840, centrado
|                                                                    120
|=================== pista de 300vh ===================================|
|| escenario sticky, 100svh, relleno superior de 52 (la barra)       ||
||         +------------------ 960 × 600 -------------------+        ||
||         | (youtube.com   )                               |        ||  navegador genérico:
||         | [ youtube.com                               ]  |        ||  pestaña + barra de dirección,
||         |                                                 |        ||  sin botones de ningún sistema
||         |          +------ AppWindow 440 ------+          |        ||
||         |          | Céntrate · quedan 42 min  |          |        ||
||         |          | Bloqueo: YouTube · Normal |          |        ||
||         |          | 42:18                     |          |        ||
||         |          +---------------------------+          |        ||
||         +-------------------------------------------------+        ||
||         ━━━  ───  ───                                               ||  3 segmentos de progreso
||         Cierras Céntrate.  (28/600)             (● Guardián activo) ||  pie del paso (1 de 3)
||         Con la X, con «Salir» o desde…  (17, mist)                  ||
|======================================================================|
|                                                                    160

375
|           Ciérrala.                40, un tiempo por línea
|       Sigue funcionando.
| Los bloqueos los aplica…¹          21, mist, centrado
|===== pista 300vh =====|
|| +--- 328 × 480 ---+ ||            navegador al ancho de la columna;
|| | (youtube.com)   | ||            AppWindow y columna de bloqueo con zoom 0.7
|| | [youtube.com  ] | ||
|| |  +-----------+  | ||
|| |  | AppWindow |  | ||
|| +--+-----------+--+ ||
|| ━━ ── ──            ||
|| Cierras Céntrate.   ||            21/600
|| Con la X, con…      ||            17, mist
|| (● Guardián activo) ||
|=======================|
```

### 4.6 Capítulos: Bloqueo, Study Mode y Progreso (SECTIONS) · `alt`

Los tres seguidos, cada uno como su propia sección con su relleno de 160.

```text
1440
| Bloqueo                                         28/600 (antetítulo, <p>)
| Tú pones la frase.                              64/600 (<h2>, un tiempo por línea)
| Céntrate pone el límite.
| Escribe «nada de TikTok ni Instagram durante    28/400 secundario, 840
| 45 minutos» y Céntrate entiende qué bloquear…
|                                                 80
|+---- 480 × 580 ----+ 20 +---- 480 × 580 ----+ 20 +---- 480 …   (asoma)
||   tarjeta blanca  |    |                    |    |
||   radio 28        |    |                    |    |
||  +-------------+  |    |                    |    |
||  | AppWindow   |  |    |                    |    |   ventana zoom 0.92 (405 px),
||  | recorte     |  |    |                    |    |   centrada, a 48 px del borde
||  |             |  |    |                    |    |   superior, sangra por abajo
|+--+-------------+--+    +--------------------+    +
| Escribe como hablas. Entiende «yt», «insta»…    17: arranque 600 primario + frase secundaria,
|                                                 ancho = el de la tarjeta, 20 bajo la tarjeta
|                                                 32
|                                        ( < ) ( > )   flechas alineadas al borde derecho

375
| Bloqueo                 21/600
| Tú pones la frase.      40/600, en línea y balanceado
| Céntrate pone el límite.
| Escribe «nada de…»      21, secundario
|+--- 307 × 460 ---+ 16 +-
||  AppWindow 0.62 |    |
|+-----------------+    +-
| Escribe como hablas. Entiende…
|                     ( < ) ( > )
```

Visual de cada tarjeta (recortes de la app mejor que ventanas enteras):

| Capítulo   | Tarjeta                                   | Visual                                                                                                                                                                    |
| ---------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bloqueo    | Escribe como hablas.                      | AppWindow `typing`, partes `block`                                                                                                                                        |
|            | Tú confirmas.                             | AppWindow `confirm`, partes `block`                                                                                                                                       |
|            | Webs y apps a la vez.                     | Rejilla 3 × 2 de tiles de la app (56 px, oscuros) con monograma y nombre, nombres del catálogo de `@centrate/shared` (YouTube, Instagram, TikTok, Steam, Discord, Roblox) |
|            | Solo se puede ampliar.                    | AppWindow `countdown`, partes `block`                                                                                                                                     |
|            | Salir antes tiene un precio.              | AppWindow `countdown`, partes `block`, desplazada para centrar «Desbloqueo de emergencia…»                                                                                |
| Study Mode | Hecho a tu medida.                        | AppWindow `idle`, partes `study` («Con cámara · calibrado»)                                                                                                               |
|            | Primero pregunta.                         | AppWindow `study`, partes `study`                                                                                                                                         |
|            | Aprende de sus errores.                   | Hueco de textos (7.5); mientras tanto, `study` partes `study`                                                                                                             |
|            | Tres strikes, una hora sin distracciones. | Hueco de textos (7.5)                                                                                                                                                     |
|            | También sin cámara.                       | Hueco de textos (7.5)                                                                                                                                                     |
| Progreso   | Así se ganan.                             | AppWindow `progress`                                                                                                                                                      |
|            | Descansos ganados.                        | Hueco de textos (7.5)                                                                                                                                                     |
|            | Una racha que cuidar.                     | AppWindow `idle`, partes `progress`                                                                                                                                       |
|            | Una mascota que crece contigo.            | Tres fases de la mascota (brote, planta, árbol) en SVG de línea, sin texto, `aria-hidden`                                                                                 |
|            | Puntos que nadie puede tocar.             | Hueco de textos (7.5)                                                                                                                                                     |

Galería: `<ul>` dentro de un contenedor con `tabindex="0"`, `role="region"` y `aria-label` = `fill(copy.ui.gallery, { name: eyebrow })`. Flechas `copy.ui.prev` / `copy.ui.next` que desplazan una tarjeta (`scrollBy`, suave salvo con movimiento reducido). Barra de desplazamiento oculta (`scrollbar-width: none`), el gesto nativo sigue funcionando.

### 4.7 Privacidad (SECTIONS) · `light`

```text
1440
|+----------- 6 columnas -----------+  +----------- 6 columnas -----------+
|| Tu cámara no sale                 |  |                                  |
|| de tu ordenador.        56/600    |  |      icono cámara con candado    |
||                         24        |  |      240 × 240, línea de 6 (en   |
|| El Study Mode analiza la imagen…  |  |      viewBox 240), color ink     |
|| La cámara solo se enciende…  17   |  |                                  |
|| Lee la política de privacidad 17  |  |                                  |
|+-----------------------------------+  +----------------------------------+
|                                       96
|+-- 4 columnas --+ +-- 4 columnas --+ +-- 4 columnas --+
|| No se guarda    | | Todo se procesa | | Sin cuenta y sin|   17: título 600 primario en su
|| ninguna imagen. | | en tu ordenador.| | cookies de…     |   propia línea, texto secundario
|| Ni fotos ni…    | | La IA va dentro…| | Ni en la app…   |
|+----------------+ +----------------+ +----------------+

375: icono (160 px) arriba, luego titular, párrafos, enlace y las 3 viñetas apiladas (32 entre ellas).
```

Icono animado: al aparecer, el arco del candado baja y se cierra una vez (`transform`, 0,6 s, 0,3 s después del titular). Menos de 5 s, sin bucle. Con movimiento reducido, cerrado desde el principio. Dibujado a mano (SVG propio), `aria-hidden="true"`.

### 4.8 Números (SECTIONS) · `alt`

Sin titular visible (`aria-label` = `numbers.ariaLabel`). Tres bloques apilados, alineados a la izquierda; el titular es la frase entera.

```text
1440
| −10 puntos por cada intento.                                   64/600 (<h2>)
| Si repites en menos de 5 minutos, se duplica: −20, −40,…²      28, secundario, 840
|                                                                96
| 60 minutos de castigo si no estudias.
| Al tercer strike de una sesión, el guardián bloquea…⁶
|                                                                96
| +2 puntos por cada minuto concentrado.
| El doble que un minuto de bloqueo. Estudia 75 minutos y…⁷

375: igual, 40 / 21, 64 entre bloques.
```

### 4.9 «Y mucho más.» (SECTIONS) · `light`

```text
1440: 5 columnas × 2 filas, 24 entre columnas, 64 entre filas
| [ 80 ]        [ 80 ]        [ 80 ]        [ 80 ]        [ 80 ]
| Pomodoro      Horarios      Límites       Modo examen   Estadísticas   17/600
|                             diarios
| 25/5, 50/10   Bloqueos que  Como YouTube  Solo tus webs Tu tiempo      17, secundario
| o a tu medida se repiten…   30 minutos…   de estudio…   concentrado…
| [ 80 ]  Sonidos · Extensión del navegador · Mantener despierto · Recordatorios · Logros

1068–735: 2 columnas, icono de 72.
375: 1 columna, filas con el icono (56) a la izquierda y nombre + frase a la derecha, 32 entre filas.
```

Iconos: formas de Lucide (licencia ISC, apuntar en `ASSET-LICENSES.json`) dibujadas a 80 px, `stroke-width: 1.25` en su viewBox de 24, `currentColor` = `--text`. Sin contenedor, sin fondo de color. Propuesta: `timer`, `calendar-clock`, `hourglass`, `graduation-cap`, `chart-column`, `audio-lines`, `puzzle`, `coffee`, `bell`, `trophy` (el mini temporizador, con `picture-in-picture-2`, pasó a la reserva al llegar los límites diarios, y «Tu motivo», con `quote`, al llegar «Mantener despierto», que usa el mismo `coffee` que la app).

### 4.10 Preguntas frecuentes (SECTIONS) · `alt`

```text
1440
| Preguntas frecuentes.                                  56/600
|                                                        64
| ------------------------------------------------------ hairline, ancho 840
| ¿Céntrate es gratis?                               +   21/600, fila de 24 arriba y abajo
| ------------------------------------------------------
| ¿Se puede saltar un bloqueo?                       −
| Cerrar la app, terminarla desde el Administrador…      17, primario, 680; 32 debajo
| ------------------------------------------------------

375: igual, preguntas a 17/600.
```

`<details>`/`<summary>` nativos (sin JS), con la pregunta en un `<h3>` dentro del `<summary>`. El icono + pasa a − con un giro de 0,3 s (respuesta a la acción del usuario; nada con movimiento reducido). Las respuestas se renderizan con `inline()` (enlaces).

### 4.11 Descarga final (SECTIONS) · `dark`

```text
1440
|                         Céntrate es gratis.                         56/600, centrado
|              Sin cuenta, sin anuncios y de código abierto.          28, mist
|                                                                     64
| +-- tile 18r --+ +--------------+ +----------------+ +------------------+
| | Descargar    | | Descargar    | | Descargar para | | Descargar para   |  4 columnas, alto ≥ 88
| | para Windows | | para macOS   | | Linux (.deb)   | | Linux (AppImage) |  17/600
| | Centrate-    | | Centrate.dmg | | Centrate.deb   | | Centrate.AppImage|  12, mist
| | Setup.exe    | |              | |                | |                  |
| +--------------+ +--------------+ +----------------+ +------------------+
|        el tile del sistema detectado lleva fondo action (azul) y texto blanco
|                                                                     24
|       Extensión para Chrome, Edge y Brave   (enlace, con Centrate-extension.zip debajo, 12)
|                                                                     64
|                   Requisitos                          17/600, izquierda en una caja de 840 centrada
|   Windows 10 u 11 de 64 bits.        Ubuntu o Debian de 64 bits…    14, mist, 2 columnas
|   macOS 12 o posterior…              Permiso de administrador…
|   Windows y macOS mostrarán un aviso la primera vez que lo abras.⁸  14
|   Guía de instalación     Novedades                                17, enlaces azul oscuro

1068–735: tiles 2 × 2. 375: tiles apilados; requisitos en 1 columna.
```

Versión (`lib/downloads.ts`): se pide a la API de GitHub al cargar; mientras tanto y si falla, `ui.versionFallback`. Reservar el ancho para que no salte.

### 4.12 Notas y pie (SECTIONS / BASE) · `alt`

```text
| 1. En un ordenador del que eres administrador… Volver al texto     12, secundario, 840, 8 entre notas
| 2. Si repites un intento en menos de 5 minutos…
| … (8 notas)
| ------------------------------------------------------------------ hairline
| Descargar   Novedades   Privacidad   Código fuente   Informar de un problema      12, enlaces primario
| Céntrate es software libre con licencia MIT. Esta web no usa cookies.             12, secundario
| YouTube, Windows, macOS y el resto de marcas… Céntrate no está afiliado a…
| © 2026 Imdlodoem23 y colaboradores de Céntrate.
```

Relleno: 40 arriba y 32 abajo (no el de sección). Referencias en el texto: `<sup><a href="#nota-{n}" id="ref-{id}-{k}" aria-label="Nota {n}">{n}</a></sup>`, en el color del texto, subrayado al pasar el ratón.

## 5. Otras páginas (PAGES)

Mismos tokens, barra y pie. Fondo `light`, sin secciones oscuras.

- **`/descargar`:** cabecera como una sección (titular `text-hero` a la izquierda, entradilla gris, botón del sistema detectado + versión con `ui.version`). Por encima de 1069 px, índice pegajoso (`top: 52 + 24`) en las columnas 1–3 y contenido en las 5–12 con texto de 680 px como máximo; por debajo, índice como lista de enlaces arriba. Subsecciones separadas 64 / 56 / 48, con `<h2>` en `text-section`. Los pasos son una secuencia real: `<ol>` con el número en 600. Comandos en `font-mono` 14 sobre `raised`, radio 18, con botón «Copiar» (`ui.copy` → `ui.copied`). Tabla SHA-256 con `hairline` entre filas y el hash en `font-mono` 12 que puede partirse (`overflow-wrap: anywhere`).
- **`/novedades`:** lista de versiones; cada una con `<h2>` «Versión x» en `text-section`, fecha en `text-small` secundario, la píldora «Última versión» (fondo `fill`, 12/600, no azul: no es una acción) y el cuerpo del release en `text-body`, 680 px. Estados de carga, error y vacío con una frase y una acción.
- **`/privacidad`:** texto largo a 680 px. Resumen en una tarjeta `raised` de radio 28 con 3 viñetas. `<h2>` de sección en `text-lead` 600.
- **404:** centrada, `text-hero`, entradilla gris y dos acciones: píldora azul «Ir al inicio» y enlace «Descargar Céntrate».

## 6. Movimiento

### 6.1 Reglas

- Scroll siempre nativo: nada de `scroll-behavior: smooth` en la página, ni librerías, ni secuestro, ni ajuste a secciones. `scroll-snap` solo dentro de las galerías.
- Solo se anima `transform` y `opacity` (la escena anima además una propiedad registrada `--progress` en el respaldo, que solo alimenta `transform` y `opacity`).
- Lo que se mueve solo más de 5 s tiene pausa: la secuencia del hero (6.3), el avance de «Lo más destacado» (6.4) y cada vídeo futuro. Nada más se mueve solo.
- Sin efectos al pasar el ratón salvo el cambio de fondo de controles.

### 6.2 Aparición (BASE, `src/scripts/reveal.ts`)

- **Qué aparece:** la cabecera de cada sección (antetítulo, titular y entradilla, en ese orden y con 0,15 s entre ellos), las pistas de galería (la pista entera, no cada tarjeta), cada bloque de «Números», la ventana del hero y el titular de la escena. Nada más: ni tarjetas sueltas, ni párrafos, ni la rejilla de «Y mucho más», ni el FAQ.
- **Cuándo:** una sola vez, cuando el borde superior del bloque llega al 85 % del alto de la ventana: `IntersectionObserver` con `rootMargin: '0px 0px -15% 0px'` y `threshold: 0`; al entrar, se marca y se deja de observar.
- **Cómo:** `translateY(var(--reveal-distance))` → 0 en 0,7 s y `opacity` 0 → 1 en 0,9 s, las dos con `cubic-bezier(0.4, 0, 0.6, 1)`; retraso = `calc(var(--reveal-index) * var(--reveal-stagger))`.
- **Sin JS o con movimiento reducido:** todo visible desde el principio. El estado oculto solo existe bajo `html.js` (clase que pone un script en línea en el `<head>`) y `@media (prefers-reduced-motion: no-preference)`.

```css
@media (prefers-reduced-motion: no-preference) {
  .js [data-reveal]:not([data-revealed]) {
    opacity: 0;
    transform: translateY(var(--reveal-distance));
  }
  .js [data-reveal] {
    transition:
      transform var(--reveal-duration-transform) var(--curve-reveal),
      opacity var(--reveal-duration-opacity) var(--curve-reveal);
    transition-delay: calc(var(--reveal-index, 0) * var(--reveal-stagger));
  }
}
```

### 6.3 Secuencia del hero (HERO)

Hasta que haya vídeo real, la ventana del hero cuenta la historia con los estados de `AppWindow` apilados en la misma celda y alineados por abajo. Una sola pasada, unos 8 s, y se queda en la cuenta atrás:

| Tiempo    | Qué pasa                                                                                                                 |
| --------- | ------------------------------------------------------------------------------------------------------------------------ |
| 0–0,8 s   | `idle`, cursor en el campo                                                                                               |
| 0,8–2,6 s | se escribe «no veo YouTube en una hora» (unos 70 ms por letra); las fichas aparecen a medida que se entienden (`typing`) |
| 2,6 s     | primer Enter → `confirm` (fundido de 120 ms, el de la app)                                                               |
| 4,4 s     | segundo Enter → `countdown` con la cuenta en 1:00:00 → 59:59 → 59:58…                                                    |
| ~8 s      | fin: la cuenta se detiene; el control pasa a «Repetir»                                                                   |

- Control: píldora `fill` pequeña (14 px, 36 de alto) abajo a la derecha de la ventana, con icono y texto: «Pausar» / «Reproducir» / «Repetir» (`ui.pause`, `ui.play`, `ui.replay`; nombres accesibles `ui.pauseVideo`…).
- La cuenta atrás de esta secuencia se genera con el mismo formato que la app (`M:SS` por debajo de una hora). En la secuencia, el título de la ventana se queda en «Céntrate» (el de «quedan 42 min» no cuadraría con 59:59).
- Solo arranca si el hero está visible y la pestaña activa. Con movimiento reducido no hay secuencia: se ve el estado `typing` fijo, que explica el producto en un fotograma (frase + fichas «YouTube · 1 h · hasta 17:42»).

### 6.4 «Lo más destacado»: avance automático (HERO)

- 5 s por tarjeta (`--highlight-interval`). Arranca cuando la galería está visible al 50 % o más, se detiene (sin contar como pausa) cuando deja de estarlo o la pestaña se oculta. Recorre las 4 tarjetas **una vez** y se para en la última; el botón pasa a «Repetir» y vuelve a la primera.
- Píldora de controles: `glass-control` con `backdrop-filter`, 56 px (48 en móvil), `position: sticky; bottom: 32px`, centrada, siempre visible mientras la sección está en pantalla. Dentro: los 4 puntos (8 px; el activo se alarga a 48 px y se rellena con `transform: scaleX()` lineal durante los 5 s) y el botón con icono + «Pausar» / «Reanudar» (`highlights.pause`, `.resume`, con `pauseAria` / `resumeAria`).
- Cada punto es un botón (`aria-label` = `fill(ui.cardPosition, …)`, `aria-current="true"` en el activo). Cualquier navegación manual (punto, gesto, teclado) para el avance: se queda en pausa.
- El foco dentro de la galería pausa mientras dure. La pausa se recuerda en `localStorage` (clave `centrate:highlights-paused`, siempre dentro de `try/catch`), como dice la política de privacidad.
- Deslizamiento: `scrollTo({ left, behavior: 'smooth' })` dentro de la galería; `behavior: 'instant'` con movimiento reducido. Con movimiento reducido además empieza en pausa.

### 6.5 La escena pegajosa (SCENE)

**Estructura:** `<section data-surface="dark">` → cabecera normal (titular + entradilla, con aparición) → pista (`height: var(--scene-track)`, 300vh) → escenario (`position: sticky; top: 0; height: 100vh; height: 100svh; padding-top: 52px`). Ningún antecesor de la pista puede tener `overflow: hidden` (rompe `sticky`); si hace falta recortar, `overflow: clip`.

**Capas del escenario** (todas `aria-hidden="true"`; la información está en los pies de paso, que son texto real, y en `scene.summary` como texto oculto visualmente):

1. `window`: AppWindow `countdown` (zoom `--aw-zoom-stage`), centrada sobre el navegador.
2. `guardian`: píldora «● Guardián activo» (`appWindow.footer.guardian`; punto de 8 px `--aw-green`, texto 14 `snow`, fondo `graphite`, borde `hairline-dark`), a la derecha de la fila de pies.
3. `browser`: navegador genérico (960 × 600, radio 12, `browser-frame`): una pestaña (`scene.browser.tabLoading` → `tabBlocked`) y una barra de dirección (`scene.browser.address`) en `browser-field`. Sin semáforos ni botones de ningún sistema. Barra de carga de 2 px `blue-dark` bajo la barra de dirección.
4. `blocked`: AppWindow `blocked-page` centrada en el área de contenido del navegador (fondo `--aw-bg`). La línea «−10 puntos» expone `data-aw-part="points"` para animarla aparte.
5. `captions`: los 3 pasos (`scene.beats`) como `<ol>`: `<h3>` 28/600 (21 en móvil) + texto 17 `mist`, y 3 segmentos de progreso (40 × 2 px, fondo `hairline-dark`, relleno `snow` con `scaleX`).

**Línea de tiempo** (p = progreso de la pista, de 0 a 1; `animation-range: contain 0% contain 100%` es exactamente el tramo en que el escenario está pegado: comprobado en Chromium):

| Elemento            | Propiedad                         | De → a                                                                                   | Tramo de p                           |
| ------------------- | --------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------ |
| window              | opacity · transform               | 1 → 0 · `none` → `translate(12%, 10%) scale(.86)` (hacia la bandeja, abajo a la derecha) | 0,08 → 0,26                          |
| guardian            | opacity · transform               | 0 → 1 · `translateY(8px)` → 0                                                            | 0,18 → 0,26 (y se queda)             |
| browser             | opacity · transform               | 0 → 1 · `translateY(40px) scale(.96)` → `none`                                           | 0,30 → 0,42                          |
| barra de carga      | transform                         | `scaleX(0)` → `scaleX(.7)`                                                               | 0,42 → 0,56                          |
| barra de carga      | opacity                           | 1 → 0                                                                                    | 0,58 → 0,62                          |
| título de pestaña   | opacity (dos textos superpuestos) | «youtube.com» 1 → 0, «Bloqueado · Céntrate» 0 → 1                                        | 0,58 → 0,64                          |
| blocked             | opacity · transform               | 0 → 1 · `translateY(16px)` → 0                                                           | 0,58 → 0,68                          |
| blocked · points    | opacity · transform               | 0 → 1 · `translateY(12px)` → 0                                                           | 0,66 → 0,74                          |
| paso 1              | opacity · transform               | visible → 0 · 0 → `translateY(-12px)`                                                    | 0,22 → 0,28                          |
| paso 2              | opacity · transform               | `translateY(12px)` 0 → visible → 0                                                       | entra 0,28 → 0,34 · sale 0,52 → 0,58 |
| paso 3              | opacity · transform               | `translateY(12px)` 0 → visible                                                           | 0,58 → 0,64 (y se queda)             |
| segmentos 1 / 2 / 3 | transform (relleno)               | `scaleX(0)` → `scaleX(1)`                                                                | 0 → 0,28 · 0,28 → 0,58 · 0,58 → 0,74 |
| (final)             | —                                 | todo quieto                                                                              | 0,74 → 1                             |

**Dos motores, una sola tabla.** Cada interpolación declara su tramo en propiedades `--a` y `--b` del propio elemento (p. ej. `--a: 0.3; --b: 0.42`):

- `@supports (animation-timeline: view())` (y `prefers-reduced-motion: no-preference`): la pista declara `view-timeline: --scene block`; cada capa usa `animation: <keyframes> linear both; animation-timeline: --scene; animation-range: contain calc(var(--a) * 100%) contain calc(var(--b) * 100%)` con keyframes de `transform`/`opacity` (van por el compositor). `var()` dentro de `animation-range` funciona (comprobado en Chromium 140).
- **Respaldo** (sin soporte, con movimiento permitido): un único listener de `scroll` pasivo que pide un `requestAnimationFrame` (como mucho uno por fotograma) y escribe `--progress` en la pista con `p = clamp((scrollY − inicio) / (alto de la pista − innerHeight), 0, 1)`; solo mientras la pista está cerca de la pantalla (`IntersectionObserver`) y también al redimensionar. Cada capa calcula `--t: clamp(0, (var(--progress) - var(--a)) / (var(--b) - var(--a)), 1)` e interpola con él (`opacity: calc(1 - var(--t))`, `translate`/`scale` con `calc()`). El script solo se activa si `CSS.supports('animation-timeline: view()')` es falso, y marca la pista con `data-scene="fallback"`.
- **Estático** (movimiento reducido, sin JS y sin soporte, o antes de que el script decida): la pista no tiene altura extra ni `sticky`; se ve el fotograma final (navegador con la página de bloqueo y la píldora del guardián) y debajo los 3 pasos como lista ordenada en 3 columnas (apilada por debajo de 735 px). Los segmentos de progreso se ocultan. Así el modo animado solo existe cuando hay un motor que lo mueva.
- Alturas cortas: el visual del escenario escala con `--stage-scale` (1 / 0,86 por debajo de 860 px de alto / 0,74 por debajo de 720) con `transform: scale()` y `transform-origin: top center`.

### 6.6 Movimiento reducido

`@media (prefers-reduced-motion: reduce)`: la aparición no oculta nada; el hero muestra `typing` fijo; «Lo más destacado» empieza en pausa y cambia de tarjeta sin deslizar; la escena es estática (6.5); el candado ya está cerrado; el icono del FAQ cambia sin girar; sin reproducción automática de vídeos (se ve el póster con su botón). `tokens.css` pone a 0 las duraciones y la distancia de aparición.

## 7. AppWindow (HERO)

Representación fiel en HTML/CSS de la ventana de escritorio de la sección 10, tema oscuro, con los tokens `--aw-*`. Es una imagen: no es interactiva, nunca recibe el foco y no tiene enlaces ni botones reales.

### 7.1 API

```ts
import type { AppWindowState } from '../content/copy';
type AppWindowPart = 'block' | 'study' | 'progress' | 'footer';
interface Props {
  state: AppWindowState; // 'idle' | 'typing' | 'confirm' | 'countdown' | 'study' | 'progress' | 'blocked-page'
  parts?: readonly AppWindowPart[]; // recorte: solo estas secciones (por defecto, todas las del estado)
  chrome?: boolean; // barra de título (por defecto true; 'blocked-page' nunca la lleva)
  decorative?: boolean; // true → aria-hidden="true" + inert (el texto de al lado ya lo dice)
  label?: string; // por defecto copy.appWindow.aria[state]
  class?: string;
}
```

- Sin `decorative`: `role="img"` + `aria-label`. Con él: `aria-hidden="true"` e `inert`.
- Escala desde fuera con `--aw-zoom` (CSS `zoom`, así el hueco en la maqueta también encoge): `--aw-zoom-hero` 1,2 / 1 / 0,7, `--aw-zoom-highlight` 1,1 / 1 / 0,7, `--aw-zoom-card` 0,92 / 0,8 / 0,62, `--aw-zoom-stage` 1 / 0,9 / 0,7 (y 0,56–0,62 por debajo de 360 px).
- `forced-color-adjust: none` (es una imagen: en contraste alto de Windows se ve igual).
- Cada sección expone `data-aw-part="block|study|progress|footer"`, y la línea de puntos de la página de bloqueo `data-aw-part="points"`, para que la escena o las tarjetas puedan alinear o animar partes.
- Fuente: Inter (la de la web), no la pila de sistema de la app: así ningún visitante con Mac ve SF Pro y las capturas son iguales en todos los sistemas. Tamaños de la app: 13 casi todo, 12 ayuda y pie, 11 píldoras, 15 el campo, 48 la cuenta atrás (`tabular-nums`, −0,02em, segundos al 60 %).

### 7.2 Estructura y medidas (estado `idle`)

```text
+------------------------------------------ 440 ------------------------------------------+
| Céntrate  (12, fg)                                                          |    X    | | 32 barra de título; X de 10 px con
+-----------------------------------------------------------------------------+---------+ |    líneas de 1 px en 46 × 32
|12                                                                                    12 | 12
| [candado 16] Bloqueo: ninguno (13/600)                    Próximo horario: 16:00 (13) | 20 cabecera
|                                                                                         | 8
| [ ¿Qué quieres hacer?                                                    (15, muted) ] | 44 campo: tile, borde control, radio 6
| Escribe lo que quieres evitar y pulsa Enter.  (12, muted)                              | 24 línea de ayuda (alto reservado)
|                                                                                         | 4
| [ icono 20  ][ icono 20  ][ icono 20   ][ icono 20 ]                                    | 56 tiles: 4 columnas, hueco 4,
| [Deberes 1 h][Examen 3 h ][Leer 30 min ][Más…      ]                                    |    radio 6; «Más…» en tile-2
|                                                                                         | 12
| [libro 16] Study Mode: listo                                   Con cámara · calibrado | 20
|                                                                                         | 8
| [ 25/5 ][ 50/10 ][ 1 h ][ Más… ]  (con icono 20)                                        | 56
|                                                                                         | 12
| [brote 16] Nivel 7 · 1.240 puntos                                      Racha: 5 días | 20
|                                                                                         | 8
| ██████████████████████████░░░░░░░░░░  (4 px, green 70 %, pista border)                 | 4
| Hoy: 42 de 60 min  (12, muted)                                                          | 4 + 16
|                                                                                         | 8
| [Estadísticas…  ][Recompensas…  ][Logros…      ]  puertas de 40, icono a la izquierda   | 40
|                                                                                         | 12
| ● Guardián activo   ● Extensión conectada                                  v1.2.0 (12) | 20 (puntos de 8, green)
|                                                                                         | 8
| [Mini temporizador][Ajustes…        ][Salir           ]  secundarios de 32, tile-2      | 32
|                                                                                         | 12
+-----------------------------------------------------------------------------------------+
contenido 460 px + barra 32 = 492 px (590 con zoom 1,2)
```

Reglas de la sección 10 que la maqueta respeta: 12 px de margen lateral y entre secciones, sin separadores ni sombras dentro; tiles con fondo `tile`, borde 1 px `border`, radio 6, icono de 20 sobre etiqueta de 13; puertas (acaban en «…») con fondo `tile-2`; seleccionado = contorno de 2 px del acento (más claro arriba, `--aw-selected-top`) + tinte del 12 % que se desvanece en el primer 20 % del alto, nunca relleno; única excepción de relleno: «Bloquear hasta 17:42» en `--aw-blue` con texto `--aw-on-accent`. Iconos: formas de Lucide (ISC), trazo 1,75, `currentColor`; 16 en cabeceras y pie, 20 en tiles. Los favicons de servicios se sustituyen por **monogramas neutros**: círculo de 16 px (14 en fichas) en `--aw-border` con la inicial en 9 px 600 `--aw-fg`. La versión del pie es un dato de ejemplo (`fill(appWindow.footer.version, { version: '1.2.0' })`).

### 7.3 Estados

Textos: `copy.appWindow`. Horas coherentes: bloqueo de 16:42 a 17:42, cuenta atrás en 42:18.

| Estado         | Título de la ventana       | Bloqueo                                                                                                                                                                                                                                                                                                                                          | Study Mode                                                                                                                                                                                                                                                                                           | Progreso                | Pie | Alto aprox. |
| -------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | --- | ----------- |
| `idle`         | «Céntrate»                 | como 7.2                                                                                                                                                                                                                                                                                                                                         | listo                                                                                                                                                                                                                                                                                                | completo                | sí  | 492         |
| `typing`       | «Céntrate»                 | campo con «no veo YouTube en una hora» y cursor (1 × 18 px, `--aw-blue`); la línea de ayuda muestra las fichas (alto 20, radio 10, fondo `tile-2`, borde `border`, 12 px): monograma + «YouTube», «1 h», «hasta 17:42»                                                                                                                           | listo                                                                                                                                                                                                                                                                                                | completo                | sí  | 492         |
| `confirm`      | «Céntrate»                 | cabecera sigue «Bloqueo: ninguno»; campo con la frase; fila «qué» (ficha YouTube + «1 h» + «termina a las 17:42» en muted); fila de modos de 32 (Normal seleccionado en azul); ayuda del modo; «Tu motivo» + campo de 32; recordatorio; fila de 40: «Editar…» (puerta, 1fr) + «Bloquear hasta 17:42» (relleno azul, 2fr, 13/600)                 | plegado a su cabecera                                                                                                                                                                                                                                                                                | plegado                 | sí  | ≈ 484       |
| `countdown`    | «Céntrate · quedan 42 min» | cabecera «Bloqueo: YouTube · Normal» · «hasta 17:42» + píldora «Nuevo» (11/600, borde `control`, radio 4); «42» + «:18» al 60 % (48/600, alto de línea 56); barra de 3 px azul al 70,5 %; motivo en cursiva (12, muted); fila de ampliar de 32 (+15 min, +30 min, +1 h, «Otro…» puerta); enlace gris «Desbloqueo de emergencia…» (12, subrayado) | listo                                                                                                                                                                                                                                                                                                | completo                | sí  | ≈ 507       |
| `study`        | «Céntrate · estudiando»    | plegado: «Bloqueo: YouTube · 42 min»                                                                                                                                                                                                                                                                                                             | «Study Mode: historia · 32:10» + píldora roja «● Cámara activa» (borde `--aw-red`, texto `--aw-red-text`, 11/600); medidor de 6 px verde al 80 % con «Concentrado» debajo y 3 puntos de strike vacíos (borde `control`) a la derecha; tiles de 56: Pausa (2), Sonido: Lluvia, Vista previa, Terminar | completo                | sí  | ≈ 390       |
| `progress`     | «Céntrate»                 | plegado: «Bloqueo: ninguno»                                                                                                                                                                                                                                                                                                                      | plegado: «Study Mode: listo»                                                                                                                                                                                                                                                                         | completo (protagonista) | sí  | ≈ 292       |
| `blocked-page` | sin barra                  | página de la extensión: columna de 440 sobre `--aw-bg`, relleno 24: cabecera «YouTube: bloqueado» · «quedan 42 min»; 16; motivo a 20 px 600; 8; «−10 puntos» 15/600 `--aw-red-text` (`data-aw-part="points"`); 8; la frase con humor (13, muted); 16; un tile de 40 «Volver a lo mío»                                                            | —                                                                                                                                                                                                                                                                                                    | —                       | —   | ≈ 222       |

Si una sección no protagoniza el estado, se pliega a su cabecera (regla de la sección 10). Ninguna sección tiene scroll.

### 7.4 Huecos de textos (para el coordinador de `copy.ts`)

Cinco tarjetas de capítulo necesitan textos de la app que aún no están en `copy.appWindow`. Propuesta, sacada literalmente de la sección 10 de `PROMPT.md`:

- `study.doubt: '¿Sigues ahí?'` y `study.wasStudying: '¡Estaba estudiando!'` → «Aprende de sus errores.» (medidor naranja + botón a todo el ancho).
- `study.noCameraMeta: 'Sin cámara'` → «También sin cámara.» (cabecera «Study Mode: listo» · «Sin cámara»).
- `punishment: { header: 'Castigo: todas las distracciones · 60 min', cause: '3 strikes en «historia»', points: '−100 puntos' }` → «Tres strikes, una hora sin distracciones.» (barra roja, sin ampliar).
- `rewards: { item: '15 min de YouTube', price: '150 pts', action: 'Canjear' }` → «Descansos ganados.».
- `progress.negative: { header: 'Nivel 7 · −60 puntos', pill: 'Números rojos' }` → «Puntos que nadie puede tocar.».

Con esos textos, `AppWindow` añadiría un prop opcional `variant` (`'doubt' | 'no-camera' | 'punishment' | 'rewards' | 'negative'`). Mientras no estén, SECTIONS usa el recorte indicado en 4.6 o una composición sin texto con piezas de la app (tiles, barras, puntos), nunca textos escritos a mano.

## 8. Presupuesto de imagen y vídeo

**Primera vista ≤ 1,5 MB** (lo que se descarga para pintar el primer pantallazo, comprimido):

| Recurso                                                   | Ahora (sin vídeo) | Con el vídeo del hero                                      |
| --------------------------------------------------------- | ----------------- | ---------------------------------------------------------- |
| HTML de la página de inicio                               | ≤ 40 KB           | ≤ 40 KB                                                    |
| CSS (Tailwind + componentes)                              | ≤ 25 KB           | ≤ 25 KB                                                    |
| Inter latina opsz (precargada)                            | 73 KB             | 73 KB                                                      |
| JS de la primera vista (barra, descarga, aparición, hero) | ≤ 15 KB           | ≤ 15 KB                                                    |
| Visual del hero                                           | 0 (HTML)          | póster AVIF ≤ 120 KB + vídeo AV1 ≤ 0,4 MB (H.264 ≤ 1,2 MB) |
| Favicon SVG                                               | ≤ 2 KB            | ≤ 2 KB                                                     |
| **Total**                                                 | **≈ 155 KB**      | **≈ 0,7 MB (AV1) / ≈ 1,48 MB (H.264)**                     |

- El parser de la demo, el script de la escena y el de «Lo más destacado» se cargan como módulos aparte; el parser, con `import()` diferido (4.4).
- Vídeos futuros: `muted playsinline`, `preload="none"` salvo el del hero (`preload="metadata"`), se reproducen al entrar en pantalla y se pausan al salir; bucles de sección ≤ 0,5 MB; nunca en la primera vista salvo el del hero. Solo píxeles de la interfaz: sombra, brillo y fondo los pone el CSS.
- Imágenes: `<Picture>` de Astro, AVIF + WebP, ≤ 120 KB cada una, `alt` descriptivo; la del hero con `priority`.
- Render gratis tiene poco tráfico de salida: nada de vídeos pesados ni imágenes a pantalla completa.
- Lighthouse ≥ 90 en móvil y escritorio, LCP < 2,5 s (el LCP es el titular del hero), CLS < 0,1 (respaldo métrico de la fuente, anchos reservados para versión y botón), INP < 200 ms.

## 9. Accesibilidad

- `lang="es"`, un `<h1>` por página (el titular del hero; el antetítulo «Céntrate» es un `<p>`), `<h2>` por sección, `<h3>` en tarjetas, pasos de la escena y preguntas. Enlace «Saltar al contenido» visible al recibir el foco.
- **Foco:** anillo de 2 px en `--focus` con 3 px de separación, solo con `:focus-visible`, en todo lo interactivo (también en la píldora azul, por fuera). Orden de tabulación = orden visual.
- **Contraste:** todo el texto ≥ 4,5:1 (tabla 3.1); controles e indicadores ≥ 3:1. El color nunca es la única señal (el punto activo cambia de forma; los estados de la app llevan texto).
- **Objetivos:** ≥ 24 × 24 px siempre (píldora de la barra 28, flechas 36, botones grandes 44, puntos con área de 24 aunque se vean de 8). Referencias de notas al pie: excepción de texto en línea.
- **Pausa:** secuencia del hero, avance de destacados y cada vídeo tienen botón visible con texto; nada más se mueve solo. La escena depende del scroll del usuario.
- **Movimiento reducido:** 6.6. Sin JS: todo el contenido visible y legible (la escena en su versión estática).
- **Maqueta:** `role="img"` con `aria-label` o `aria-hidden` + `inert`; nunca finge ser interactiva. Capas de la escena `aria-hidden`; los pasos son texto real y `scene.summary` describe la animación.
- **Galerías:** región con nombre, desplazable con teclado, flechas con nombre, estado de la posición en los puntos.
- **Formularios:** el campo de la demo tiene `<label>`; el resultado se anuncia con `aria-live="polite"`.
- `forced-colors`: los controles mantienen bordes (`border: 1px solid transparent` en píldoras y tiles, que el sistema pinta); la maqueta se ve como imagen.
- 0 fallos de axe-core en todas las páginas, con y sin movimiento reducido.

## 10. Revisión del plan contra el brief

Primer plan → qué sonaba a plantilla o contradecía el brief → cambio:

1. **Hero en dos columnas** (texto a la izquierda, ventana a la derecha): es la plantilla SaaS de siempre. → Hero centrado con la ventana entrando por debajo, como las páginas de software del brief, y alineada por abajo como la ventana real en Windows.
2. **Números como «cifra enorme + etiqueta»** en tres columnas: el gesto por defecto que la skill señala. → Frases enteras a tamaño de titular, apiladas; la tipografía es la imagen.
3. **Halo azul detrás de la ventana del hero:** decoración que no dice nada. → Fuera: una sola sombra en toda la web.
4. **Antetítulos de capítulo en el color de cada acento** (azul, verde, naranja): rompía «un solo color para las acciones». → Antetítulos en `--text`; los acentos solo dentro de la maqueta.
5. **Escena con keyframes propios y un respaldo con fórmulas aparte:** dos fuentes de verdad que se desincronizan. → Una tabla de tramos en `--a/--b` que usan los dos motores (verificado que `var()` funciona dentro de `animation-range`).
6. **Espaciado del texto más abierto para Inter** (−0,011em en vez de −0,022em): probado en capturas lado a lado, el −0,022em del brief se lee bien con el corte de texto de Inter y se parece más al ritmo pedido. → Se mantiene el valor del brief; solo se fija −0,009em en los tres saltos del titular grande.
7. **Tiempos del titular siempre en líneas separadas:** a 375 px dejaba «Cada minuto / suma.». → En móvil, los titulares de capítulo y escena fluyen balanceados; el hero conserva sus dos líneas.
8. **Destacados en bucle infinito:** movimiento sin fin. → Una sola pasada y «Repetir».
9. **Tarjetas de capítulo sin visual resueltas con texto inventado:** rompía «ningún texto fuera de `copy.ts`». → Recortes de estados existentes, piezas sin texto, y una lista de textos pedidos al coordinador (7.4).

## 11. Lo que he quitado a propósito

- Una segunda familia tipográfica (ni serif de titulares ni monoespaciada decorativa): solo Inter; la monoespaciada del sistema solo para comandos reales.
- La frase de ejemplo que rota cada 4 s en el campo de la demo: era contenido que se actualiza solo sin pausa propia; las fichas «Prueba con» hacen lo mismo cuando el usuario quiere.
- Halo, degradados de fondo, grano, inclinación y reflejos alrededor de la ventana: solo su sombra.
- Semáforos de ventana, marcos de dispositivo y cualquier control de un sistema concreto: la maqueta lleva solo la X de la sección 10 y el navegador es genérico.
- Efectos al pasar el ratón en tarjetas e imágenes, parallax, apariciones tarjeta a tarjeta.
- Cristal en tarjetas: el cristal solo está en la barra y en la píldora de controles.
- La paleta, radios, sombras y puntos de corte por defecto de Tailwind.
- Flechas «→» o «›» añadidas a enlaces y botones; separadores con punto medio en la maquetación propia (los «·» que quedan son textos reales de la app).
- Numeración decorativa: solo hay números donde hay una secuencia real (pasos de la escena, pasos de instalación, notas al pie).
- Modo oscuro automático de la web.
- La pila de fuentes del sistema dentro de la maqueta (usaría SF Pro en Mac).
- El archivo de cursiva de Inter (80 KB para una línea de 12 px).
- La cuenta atrás que sigue corriendo al final de la secuencia del hero.

## 12. Comprobaciones para cada constructor

- Colores, tamaños, radios y duraciones solo con tokens (`tokens.css` o sus utilidades). Si falta uno, se pide y se añade allí.
- Textos solo de `copy.ts` (`fill()`, `inline()`, `plain()`).
- Capturas a 375, 768, 1280, 1440 y 1920 px, con y sin movimiento reducido, y de la escena en varias posiciones (p = 0, 0,2, 0,45, 0,7, 1), en `/tmp/claude-0/web-shots/`.
- `npx prettier --write`, `npm run typecheck -w apps/web`, `npm run build -w apps/web` y `npx eslint apps/web` sin errores.
