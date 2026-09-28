# Ficha de la extensión en las tiendas

Textos y respuestas para publicar la extensión de Céntrate en **Chrome Web Store** (Chrome, Edge y Brave la instalan desde ahí; Edge también tiene su propia tienda con los mismos campos) y en **Firefox Add-ons (AMO)**. Está todo preparado, pero todavía no se ha publicado: al principio la extensión se distribuye descomprimida en Chromium y firmada como «unlisted» en Firefox (PROMPT §6, `PENDIENTE_PARA_MI.md`).

Los textos siguen las reglas de la app: español de España, mayúscula solo al principio, signo menos tipográfico en los puntos («−10 puntos») y sin emojis.

## Datos comunes

| Campo                  | Valor                                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Nombre                 | Céntrate                                                                                                           |
| Nombre corto           | Céntrate (`short_name` del manifest)                                                                               |
| Idioma principal       | Español (`es`); ficha en inglés (`en`) como segunda                                                                |
| Versión                | La de la Release (`node package.mjs --version X.Y.Z`)                                                              |
| Licencia               | MIT                                                                                                                |
| Web                    | <https://centrate.onrender.com> (o el dominio propio si se configura en Render)                                    |
| Política de privacidad | <https://centrate.onrender.com/privacidad> (misma política que `PRIVACY.md`)                                       |
| Soporte                | <https://github.com/Imdlodoem23/App-to-not-Procastinate/issues>                                                    |
| Código fuente          | <https://github.com/Imdlodoem23/App-to-not-Procastinate> (`apps/extension`)                                        |
| ID en Firefox          | `centrate@imdlodoem23.github.io` (`browser_specific_settings.gecko.id`)                                            |
| ID en Chromium         | `dlabilkpafinafimngfclcfmeghilcah` fuera de la tienda (clave `key` del manifest); la tienda asigna el suyo (abajo) |
| Navegadores            | Chrome, Edge, Brave y demás Chromium 121+; Firefox 128+                                                            |
| Requisito              | La app de escritorio Céntrate con su guardián en el mismo ordenador: sin ella la extensión no bloquea nada         |

## Descripción corta

Chrome Web Store usa la `description` del manifest como resumen (máximo 132 caracteres). AMO pide un resumen de hasta 250.

**Español (manifest y Chrome Web Store, 101 caracteres):**

> Bloquea tus distracciones con Céntrate: aplica en el navegador los bloqueos de la app y del guardián.

**Español (AMO, 196 caracteres):**

> Bloquea tus distracciones con Céntrate: aplica en el navegador los bloqueos de la app de escritorio, aunque la cierres. Tu motivo, el tiempo que queda y los puntos que pierdes, en una sola página.

**English (Chrome Web Store, 112 characters):**

> Block your distractions with Céntrate: enforces the desktop app's blocks in your browser, even when it's closed.

**English (AMO, 177 characters):**

> Block your distractions with Céntrate: enforces the desktop app's blocks in your browser, even when it's closed. Your reason, the time left and the points you lose, on one page.

## Descripción larga

### Español

```text
Céntrate bloquea las webs que te distraen mientras estudias o trabajas, y el bloqueo no se salta cerrando la app.

Esta extensión es la parte del navegador de Céntrate, la app de escritorio gratuita y de código abierto para Windows, macOS y Linux. La app y su guardián (un servicio que sigue activo aunque cierres la app) deciden qué está bloqueado y hasta cuándo; la extensión lo aplica en el navegador al momento.

Qué hace
• Lleva las webs bloqueadas a una página propia con tu motivo («Quiero aprobar mates»), el tiempo que queda y los puntos que te cuesta el intento: −10 puntos, el doble si repites en menos de 5 minutos.
• Si ya tenías abierta una web cuando empieza el bloqueo, cambia esa pestaña a la página de bloqueo sin restarte puntos.
• Modo lista blanca (modo examen y castigo): bloquea todas las webs salvo las permitidas para estudiar, como Wikipedia.
• Descansos ganados: si canjeas puntos por 15 minutos de YouTube en la app, la extensión lo deja pasar solo ese rato.
• Si el guardián no responde, mantiene tus bloqueos hasta que terminen: nunca desbloquea antes de tiempo.
• También bloquea en las ventanas de incógnito si se lo permites.

Cómo empezar
1. Instala Céntrate en tu ordenador desde https://centrate.onrender.com.
2. En Céntrate, abre Ajustes… › Sistema y pulsa «Nuevo código».
3. Escribe los 6 dígitos en la extensión. Listo.

Privacidad
• Sin cuenta, sin anuncios y sin analíticas.
• La extensión solo habla con el guardián de tu propio ordenador (127.0.0.1). Cuando intentas abrir algo bloqueado, le envía el dominio (por ejemplo, youtube.com, nunca la dirección completa) para restar los puntos del intento.
• Nada sale de tu ordenador.

Permisos
• Acceso a todas las webs: sin él, el navegador no aplica los bloqueos y no avisa.
• Bloqueo de contenido (declarativeNetRequest): redirige las webs bloqueadas sin leer el contenido de las páginas.
• Navegación (webNavigation): cuenta un intento solo cuando abres de verdad una web bloqueada.
• Almacenamiento y alarmas: recuerdan el emparejamiento y los bloqueos, y los mantienen al día.

Código abierto (licencia MIT): https://github.com/Imdlodoem23/App-to-not-Procastinate
```

### English

```text
Céntrate blocks the sites that distract you while you study or work, and closing the app doesn't end the block.

This extension is the browser side of Céntrate, a free and open-source desktop app for Windows, macOS and Linux. The app and its guardian (a service that keeps running even when the app is closed) decide what is blocked and until when; the extension enforces it in your browser right away.

What it does
• Sends blocked sites to its own page with your reason ("I want to pass maths"), the time left and the points the attempt costs you: −10 points, doubled if you try again within 5 minutes.
• If a site was already open when a block starts, that tab moves to the blocked page without costing you points.
• Whitelist mode (exam mode and punishments): blocks every site except the ones allowed for studying, such as Wikipedia.
• Earned breaks: redeem points for 15 minutes of YouTube in the app and the extension lets it through for just that long.
• If the guardian doesn't answer, your blocks stay until they end: it never unblocks early.
• Also blocks in incognito windows if you allow it.

Getting started
1. Install Céntrate on your computer from https://centrate.onrender.com.
2. In Céntrate, open Ajustes… › Sistema and click «Nuevo código» (new code).
3. Type the 6 digits in the extension. Done.

Privacy
• No account, no ads, no analytics.
• The extension only talks to the guardian on your own computer (127.0.0.1). When you try to open something blocked, it sends the domain (for example youtube.com, never the full address) so the attempt's points can be deducted.
• Nothing leaves your computer.

Permissions
• Access to all sites: without it the browser doesn't apply the blocks and gives no warning.
• Content blocking (declarativeNetRequest): redirects blocked sites without reading page content.
• Navigation (webNavigation): counts an attempt only when you actually open a blocked site.
• Storage and alarms: remember the pairing and the blocks, and keep them up to date.

Open source (MIT licence): https://github.com/Imdlodoem23/App-to-not-Procastinate
```

La app todavía está solo en español: en la ficha inglesa los nombres de los menús («Ajustes… › Sistema», «Nuevo código») se dejan en español a propósito, que es lo que verá el usuario.

## Categoría

- **Chrome Web Store:** Productividad › Flujo de trabajo y planificación (_Productivity › Workflow & Planning_). Alternativa si la revisión lo pide: Estilo de vida › Bienestar (_Lifestyle › Well-being_).
- **Edge Add-ons:** Productividad (_Productivity_).
- **AMO:** no tiene categoría de productividad: elegir Otros (_Other_). Si el formulario ofrece etiquetas, añadir «productivity».

## Prácticas de privacidad

### Chrome Web Store (pestaña «Privacy practices»)

**Propósito único** (_single purpose_):

- ES: Aplicar en el navegador los bloqueos de webs que el usuario ha creado en la app de escritorio Céntrate, mientras dura cada bloqueo.
- EN: Enforce in the browser the website blocks the user created in the Céntrate desktop app, for as long as each block lasts.

**Código remoto** (_remote code_): **No.** Todo el código va en el paquete (esbuild lo empaqueta; no hay `eval`, scripts de CDN ni código descargado).

**Uso de datos** (_data usage_): no marcar ningún tipo de dato. La extensión no transmite nada fuera del ordenador: el único dato que envía es el dominio de un intento bloqueado, y va al guardián de Céntrate en `127.0.0.1` (el mismo producto, en el mismo equipo), nunca al desarrollador ni a terceros. Si la revisión considera que ese envío local cuenta como recogida, marcar **Historial web** (_Web history_) con esta explicación:

- ES: Solo el dominio (no la dirección completa) de una web bloqueada que el usuario intenta abrir, enviado al guardián de Céntrate que se ejecuta en el mismo ordenador para restar los puntos del intento. No sale del dispositivo.
- EN: Only the domain (never the full URL) of a blocked site the user tries to open, sent to the Céntrate guardian running on the same computer to deduct the attempt's points. It never leaves the device.

**Certificaciones** (marcar las tres):

- No vendo ni transfiero datos de usuarios a terceros fuera de los casos de uso aprobados.
- No uso ni transfiero datos de usuarios para fines no relacionados con el propósito único del elemento.
- No uso ni transfiero datos de usuarios para determinar la solvencia crediticia o para conceder préstamos.

**URL de la política de privacidad:** <https://centrate.onrender.com/privacidad>.

### Firefox Add-ons

- El manifest declara `browser_specific_settings.gecko.data_collection_permissions.required: ["none"]`: la extensión no recoge datos para el desarrollador ni para terceros. `web-ext lint` avisa (sin error) de que esa clave es de Firefox 140+ y la mínima es 128: las versiones anteriores la ignoran.
- Política de privacidad: pegar el texto de `PRIVACY.md` más el párrafo de la extensión de la sección «Privacidad» de arriba.
- Cada cambio se prueba en Firefox 128 ESR (la versión mínima) y en la actual: CI instala el mismo paquete como complemento temporal y lo empareja con un guardián de pruebas (`apps/extension/e2e/firefox`, trabajo «Extension Firefox»).

## Justificación de cada permiso

Chrome Web Store pide un texto por permiso; AMO los muestra en la ficha a partir del manifest.

| Permiso                                | Español                                                                                                                                                                                                                                                                                                                          | English                                                                                                                                                                                                                                                                                   |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `declarativeNetRequest`                | Crea reglas dinámicas que redirigen las webs bloqueadas a la página de bloqueo de la propia extensión y dejan pasar las permitidas, sin leer ni modificar el contenido de ninguna página.                                                                                                                                        | Creates dynamic rules that redirect blocked sites to the extension's own blocked page and let allowed sites through, without reading or changing any page content.                                                                                                                        |
| `declarativeNetRequestWithHostAccess`  | Las reglas `redirect` y la regla de lista blanca solo actúan en las webs a las que la extensión tiene acceso; este permiso vincula las reglas a ese acceso que concede el usuario (en Firefox, el permiso de acceso a las webs que se pide desde la guía).                                                                       | Redirect rules and the whitelist rule only act on sites the extension has access to; this permission ties the rules to the site access the user grants (in Firefox, the site-access permission requested from the guide).                                                                 |
| `storage`                              | Guarda el emparejamiento con el guardián local, la última lista de bloqueos verificada (para seguir bloqueando si el guardián no responde) y, solo en la memoria de la sesión, qué pestaña se bloqueó.                                                                                                                           | Stores the pairing with the local guardian, the last verified block list (to keep blocking if the guardian stops answering) and, in session memory only, which tab was blocked.                                                                                                           |
| `alarms`                               | Una alarma cada 30 s mantiene la lista de bloqueos al día y avisa al guardián de que la extensión sigue activa; otra salta cuando termina un bloqueo para quitarlo a su hora.                                                                                                                                                    | A 30-second alarm keeps the block list up to date and tells the guardian the extension is still active; another fires when a block ends so it is lifted on time.                                                                                                                          |
| `webNavigation`                        | Distingue una visita real a una web bloqueada (el marco principal, no una precarga ni un iframe) para contar el intento una sola vez. Solo el dominio llega al guardián de Céntrate en el mismo ordenador.                                                                                                                       | Tells a real visit to a blocked site (the main frame, not a prerender or an iframe) apart so the attempt is counted once. Only the domain reaches the Céntrate guardian on the same computer.                                                                                             |
| Acceso a todas las webs (`<all_urls>`) | Los bloqueos pueden ser de cualquier web que elija el usuario, y el modo lista blanca bloquea todas salvo las permitidas: sin acceso a las webs el navegador ignora las redirecciones sin avisar. También permite mover a la página de bloqueo una pestaña que ya estaba abierta y hablar con el guardián en `http://127.0.0.1`. | Blocks can target any site the user chooses, and whitelist mode blocks every site but the allowed ones: without host access the browser silently ignores redirects. It also lets the extension move an already open tab to the blocked page and reach the guardian at `http://127.0.0.1`. |

Otras claves del manifest que la revisión puede preguntar:

- `incognito`: `"split"` en Chrome, Edge y Brave (Chromium solo abre la página de bloqueo de una extensión en pestañas de incógnito en ese modo) y `"spanning"` en Firefox, que no tiene modo split (`apps/extension/manifest.mjs`). Los bloqueos también valen en incógnito o en ventanas privadas si el usuario lo permite; si no, la guía de la extensión lo explica. No se guarda nada de incógnito.
- `web_accessible_resources` (`blocked.html` y sus archivos): la redirección necesita que la página de bloqueo sea accesible desde cualquier web. La página no informa de intentos (solo lo hace el proceso de fondo), así que abrirla a mano no resta puntos.

## Notas para la revisión

**Cómo probarla.** La extensión necesita la app de escritorio:

1. Instala Céntrate desde la última Release (<https://github.com/Imdlodoem23/App-to-not-Procastinate/releases/latest>).
2. En la app, Ajustes… › Sistema › «Nuevo código».
3. Escribe el código en la ventana de la extensión y crea un bloqueo en la app («no veo YouTube en 25 minutos»). Al abrir youtube.com aparece la página de bloqueo.

Sin la app, con Node 22 y el repositorio: `node apps/extension/e2e/serve-mock-guardian.mjs` arranca un guardián de pruebas en el puerto 47600, muestra un código y acepta órdenes como `block youtube 25`.

**Código fuente para AMO.** El paquete está generado con esbuild (TypeScript empaquetado, sin minificar), así que AMO pide el código fuente. Subir el zip del repositorio en el tag de la versión con estas instrucciones:

```text
Requisitos: Node.js 22 y npm 10 (Linux, macOS o Windows).
1. npm ci
2. npm run build -w apps/extension -- --engine firefox
El resultado está en apps/extension/dist y coincide con el paquete enviado
(el mismo código que el de Chromium; solo cambia "incognito" en manifest.json).
```

**Chrome Web Store y el ID.** La tienda rechaza un manifest con el campo `key`: quitarlo del paquete que se sube (el zip de la Release sirve para instalarla descomprimida con el ID fijo). La tienda asignará otro ID; hay que añadirlo a los orígenes que acepta el guardián (docs/ARCHITECTURE.md §9.4: ids de tienda en `config.json`, y a `CHROMIUM_EXTENSION_ID` si se incrusta) antes de anunciar la versión de la tienda.

## Imágenes que faltan por hacer

Se pueden generar con Playwright y el guardián de pruebas, reutilizando las piezas de `apps/extension/e2e/support` (una tarea pendiente, sin captura todavía). Tema claro y oscuro de cada una cuando el tema importe; textos reales de la interfaz, sin datos personales.

| #   | Tienda      | Tamaño     | Qué muestra                                                                                                        |
| --- | ----------- | ---------- | ------------------------------------------------------------------------------------------------------------------ |
| 1   | Chrome, AMO | 1280 × 800 | `blocked.html` tras intentar abrir YouTube: «YouTube: bloqueado» · «quedan 43 min», tu motivo, «−10 puntos», claro |
| 2   | Chrome, AMO | 1280 × 800 | La misma página en tema oscuro, con «−20 puntos» tras un segundo intento                                           |
| 3   | Chrome, AMO | 1280 × 800 | La ventana de la extensión con un bloqueo activo (cuenta atrás, «Guardián conectado»), sobre una web normal        |
| 4   | Chrome, AMO | 1280 × 800 | La ventana de la extensión sin emparejar: campo «Código de emparejamiento» y botón «Emparejar»                     |
| 5   | Chrome, AMO | 1280 × 800 | La guía (página de opciones): emparejar, permiso de acceso a las webs e incógnito                                  |
| 6   | AMO         | 1280 × 800 | Modo lista blanca: una web bloqueada en modo examen y Wikipedia abierta en otra pestaña                            |
| 7   | AMO         | 1280 × 800 | «Guardián no responde: tus bloqueos siguen hasta que terminen.» en la ventana de la extensión                      |
| 8   | Chrome      | 440 × 280  | Mosaico promocional pequeño: icono, «Céntrate» y «Bloquea tus distracciones»                                       |
| 9   | Chrome      | 1400 × 560 | Marquesina (opcional): la página de bloqueo junto a la app de escritorio                                           |
| 10  | Chrome      | 128 × 128  | Icono de la tienda: `public/icons/icon-128.png` (96 × 96 de dibujo con 16 px de margen transparente)               |

Chrome Web Store pide al menos una captura (máximo 5, 1280 × 800 o 640 × 400, PNG o JPEG sin transparencia) y el icono de 128 px; el mosaico pequeño es muy recomendable. AMO acepta varias capturas (mejor 1280 × 800) y toma el icono del manifest.
