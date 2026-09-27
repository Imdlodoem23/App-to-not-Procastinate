# Prompt para Claude: «Céntrate», la app para no procrastinar

> **Cómo usar este prompt**
> 1. Abre una sesión de **Claude Code** (claude.ai/code) con este repositorio y con **GitHub y Render conectados**.
> 2. Pega todo lo que hay debajo de la línea, o escribe: «Lee `PROMPT.md` y síguelo empezando por la Fase 0».
> 3. Si la sesión se corta o se acaba, abre otra y escribe: «Continúa con la siguiente fase pendiente de `ROADMAP.md`».
>
> Antes de pegarlo puedes cambiar el nombre, las prioridades o los números (puntos, tiempos).

---

## 0. Tu papel y cómo quiero que trabajes

Eres un ingeniero de software sénior (escritorio, web, DevOps e IA en el dispositivo). Vas a construir **de principio a fin** un producto real: el código, el repositorio en GitHub, los instaladores descargables y la web publicada en Render. No me des solo ideas o fragmentos: hazlo, pruébalo y publícalo.

Reglas:

1. Trabaja **por fases** (sección 15). No pases a la siguiente hasta que la actual compile, pase los tests y esté subida.
2. Antes de escribir código, resume en unas 10 líneas el plan y la arquitectura, y sigue sin esperar mi respuesta.
3. Toma tú las decisiones pequeñas sin preguntarme y apúntalas en `DECISIONS.md` (una línea con el porqué). Pregúntame solo si necesitas algo que no puedes conseguir tú: credenciales, cuentas de pago o una acción irreversible.
4. Mantén `ROADMAP.md` con casillas `[ ]` / `[x]` al día, para que cualquier sesión nueva pueda seguir donde lo dejaste.
5. Commits pequeños y descriptivos. **Nunca** subas secretos: usa GitHub Secrets y las variables de entorno de Render.
6. Al terminar cada fase dame: qué funciona, una **checklist para probarlo yo en mi ordenador** paso a paso y qué viene después.
7. Sé honesto con los límites técnicos: si algo no se puede hacer al 100 % (por ejemplo, un bloqueo imposible de saltar para el administrador del ordenador), hazlo de la forma más robusta razonable y explícamelo.
8. Si trabajas en un contenedor Linux y no puedes probar Windows o macOS a mano, cúbrelo con tests automáticos en GitHub Actions (`windows-latest`, `macos-latest`, `ubuntu-latest`).
9. Usa `main` como rama principal y de despliegue; si no existe, créala. Al terminar cada fase abre un Pull Request hacia `main` con un resumen. Tienes mi permiso para fusionarlo cuando el CI esté en verde.

## 1. Datos del proyecto

- **Nombre:** Céntrate (identificador técnico `centrate`, sin tildes, para paquetes, archivos y binarios; appId `io.github.imdlodoem23.centrate`).
- **Repositorio:** `https://github.com/imdlodoem23/app-to-not-procastinate`. Ahora mismo está vacío (como mucho contiene este `PROMPT.md`). Tiene que ser **público**: los archivos de GitHub Releases de un repositorio privado no se pueden descargar sin iniciar sesión. Si es privado y no puedes cambiarlo tú, avísame.
- **Idioma:** app y web en **español**, preparadas con i18n para añadir inglés. Código, nombres y commits en inglés.
- **Plataformas:** **Windows 10/11 es la prioridad** y tiene que funcionar perfecto. También macOS (Apple Silicon e Intel) y Linux (Ubuntu/Debian).
- **Licencia:** MIT.
- **Principios:** funciona sin internet y sin cuenta; privacidad por defecto; nada oculto (siempre hay icono en la bandeja y se puede desinstalar).

## 2. Qué es la app

Céntrate es una app de escritorio para dejar de procrastinar. Abres la app y **escribes lo que quieres hacer**, por ejemplo *«no veo YouTube en una hora»*, y la app lo bloquea durante ese tiempo. **El bloqueo sigue funcionando aunque cierres la app**, la mates desde el Administrador de tareas o reinicies el ordenador, hasta que se acaba el tiempo. Si intentas entrar en lo bloqueado, no te deja y **pierdes puntos**.

Además tiene un **Study Mode**: enciende la cámara y una IA que funciona en tu propio ordenador comprueba si estás estudiando. Si no te ve estudiando, te avisa; si sigues sin estudiar, **te castiga bloqueando tus distracciones durante una hora**.

Una web por sí sola no puede bloquear otras webs ni usar la cámara en segundo plano, así que el producto tiene cuatro piezas:

1. **App de escritorio:** lo que ve el usuario (Electron).
2. **Guardián** (`guardian`): un servicio del sistema en segundo plano que aplica los bloqueos. Es lo que hace que funcione con la app cerrada.
3. **Extensión del navegador:** bloquea al instante dentro del navegador, muestra la página de «bloqueado» y detecta los intentos.
4. **Web en Render:** presenta la app y permite descargarla.

## 3. Arquitectura y tecnologías

Usa esto salvo que haya una razón fuerte para cambiarlo (si cambias algo, justifícalo en `DECISIONS.md`).

Monorepo con npm workspaces:

```text
apps/desktop       App de escritorio: Electron + React + TypeScript + Vite + Tailwind
apps/extension     Extensión Manifest V3 en TypeScript (Chromium y Firefox)
apps/web           Web de descarga: Astro + Tailwind (sitio estático) -> Render
apps/api           (Fase 6, opcional) Backend Node + TypeScript + Postgres -> Render
guardian/          Servicio del sistema en Go
packages/shared    Tipos, catálogo de webs/apps, parser de lenguaje natural, reglas de puntos
.github/workflows  ci.yml y release.yml
render.yaml, README.md, ROADMAP.md, DECISIONS.md, PRIVACY.md, CHANGELOG.md, LICENSE
```

- **Escritorio:** Electron (última versión estable) con `electron-vite`, `electron-builder` para los instaladores y `electron-updater` para las actualizaciones desde GitHub Releases. Estado con Zustand, gráficas con Recharts, datos locales en SQLite (por ejemplo `better-sqlite3`).
- **Guardián:** Go con `kardianos/service` (servicio de Windows, LaunchDaemon en macOS, unidad systemd en Linux). Se ejecuta con privilegios de administrador, arranca con el sistema y no depende de que la app esté abierta.
- **Comunicación:** el guardián expone una API HTTP (o WebSocket) **solo en `127.0.0.1`**, en un puerto fijo configurable. La app y la extensión son clientes.
- **IA de la cámara:** `@mediapipe/tasks-vision` (Face Landmarker y Object Detector) ejecutándose en local dentro de Electron. Los modelos y los archivos WASM **van incluidos en la app** (nada de CDN: tiene que funcionar sin internet).
- **Calidad:** TypeScript en modo estricto, ESLint + Prettier, `go vet`. Tests con Vitest (TypeScript), `go test` (guardián) y Playwright (web y prueba de humo de Electron).
- **Logs:** registros locales rotativos de la app y del guardián, y un botón «Copiar diagnóstico» en Ajustes (sin datos personales).

## 4. Crear bloqueos escribiendo lo que quieres hacer

La pantalla de inicio tiene un campo grande: **«¿Qué quieres hacer?»**. Tiene que entender frases como estas:

| Frase | Resultado |
|---|---|
| «no veo YouTube en una hora» | YouTube, 60 min |
| «nada de TikTok ni Instagram durante 45 minutos» | TikTok + Instagram, 45 min |
| «bloquea las redes sociales hasta las 20:30» | Categoría Redes sociales, hasta las 20:30 |
| «sin juegos hora y media» | Categoría Juegos (webs y apps), 90 min |
| «no quiero ver Netflix 2h» | Netflix, 120 min |
| «estudiar mates 1 hora» | Propone un Study Mode de 60 min con la tarea «mates» |

Requisitos:

- **Parser local** en `packages/shared`, sin internet: duraciones («una hora», «media hora», «hora y media», «90 min», «2h», «1h30», «hasta las 18:00», «hasta mañana a las 8»), servicios con sinónimos y errores de escritura típicos («yt», «youtube», «insta», «tik tok», «redes», «juegos», «series»…), negaciones y frases coloquiales. Mínimo 60 frases de prueba en los tests.
- Antes de activar nada, una **tarjeta de confirmación** editable: qué se bloquea, cuánto dura, a qué hora termina y en qué modo. Si dura más de 4 h, doble confirmación; máximo 24 h por bloqueo.
- Si no entiende la frase, **no se inventa nada**: abre el formulario avanzado con lo que sí haya entendido.
- **Formulario avanzado:** servicios del catálogo, categorías, dominios propios, apps del ordenador, duración u hora de fin, modo y **«tu motivo»** (una frase tuya, por ejemplo «Quiero aprobar mates», que aparecerá cuando intentes entrar en algo bloqueado).
- **Plantillas rápidas** personalizables: «Deberes 1 h», «Examen 3 h», «Leer 30 min».
- Un bloqueo activo se puede **ampliar** en cualquier momento, pero **nunca acortar**.

Catálogo inicial en `packages/shared` (fácil de ampliar):

- Cada servicio con **todos** sus dominios. Ejemplo, YouTube: `youtube.com`, `www.youtube.com`, `m.youtube.com`, `music.youtube.com`, `youtu.be`, `youtube-nocookie.com`, `www.youtube-nocookie.com`, `youtubei.googleapis.com`.
- Categorías: **Redes sociales** (TikTok, Instagram, X/Twitter, Facebook, Snapchat, Reddit, Pinterest, BeReal…), **Vídeo y streaming** (YouTube, Twitch, Kick, Netflix, Disney+, Prime Video, HBO Max…), **Juegos** (webs como Poki o CrazyGames y apps como Steam, Epic Games, Roblox, Minecraft Launcher, Fortnite, League of Legends, Valorant, Battle.net, Riot Client…), **Mensajería** (Discord, WhatsApp Web, Telegram Web), **Compras** y **Noticias y deportes**.
- Apps con sus nombres de proceso para cada sistema (por ejemplo `Discord.exe`, `steam.exe` o `RobloxPlayerBeta.exe` en Windows, y sus equivalentes en macOS y Linux).
- Lista blanca por defecto para estudiar (Google Classroom, Moodle, Google Docs/Drive, Microsoft 365, Wikipedia, Khan Academy, GeoGebra, Desmos, WolframAlpha, RAE, traductores…), editable.

Modos de bloqueo:

- **Normal:** se puede cancelar con el desbloqueo de emergencia (sección 7).
- **Estricto:** desbloqueo de emergencia con una espera larga y mucha penalización.
- **Hardcore:** imposible de cancelar hasta que termine. Avísalo muy claro antes de confirmar.

## 5. El Guardián: un bloqueo que no se salta cerrando la app

Objetivo: una vez confirmado, el bloqueo **dura hasta el final** aunque cierres la ventana, salgas de la app, la mates desde el Administrador de tareas, cierres sesión o reinicies el ordenador. Cuando se acaba el tiempo, se quita solo aunque la app no esté abierta.

**Capas de bloqueo (todas a la vez):**

1. **Archivo hosts** (`C:\Windows\System32\drivers\etc\hosts`, `/etc/hosts`). El guardián escribe los dominios (IPv4 `0.0.0.0` e IPv6 `::`) **solo** dentro de una sección entre los marcadores `# >>> CENTRATE START` y `# <<< CENTRATE END`, con copia de seguridad previa y escritura atómica, sin tocar nunca el resto del archivo. Después vacía la caché DNS del sistema (`ipconfig /flushdns`; `dscacheutil -flushcache` + `killall -HUP mDNSResponder`; `resolvectl flush-caches`).
2. **Extensión del navegador** (sección 6): bloquea al instante aunque el navegador tenga conexiones abiertas o DNS en caché, y muestra la página de bloqueo.
3. **Vigilante de procesos:** cada 1–2 s busca las apps bloqueadas, las cierra y registra el intento.
4. **Ventana activa** (capa de respaldo; la hace la **app de escritorio**, porque un servicio del sistema no ve el escritorio del usuario): si el título de la ventana en primer plano indica un servicio bloqueado (por ejemplo «… - YouTube - Google Chrome»), cuenta como intento. En macOS necesita el permiso de Grabación de pantalla; si no se da, esa capa se desactiva sin romper nada.

**Persistencia y anti-trampas:**

- El estado de los bloqueos, los horarios y el **registro de eventos** que afectan a los puntos (intentos, strikes, castigos, bloqueos completados, emergencias) los guarda el guardián en una carpeta del sistema que el usuario normal no puede modificar (`C:\ProgramData\Centrate\`, `/Library/Application Support/Centrate/`, `/var/lib/centrate/`). La app lo sincroniza con su base de datos local para las estadísticas.
- Al arrancar el sistema, el guardián vuelve a aplicar los bloqueos activos. Si su estado está dañado, restaura la copia del hosts y nunca deja el archivo roto.
- Si alguien borra a mano las líneas del hosts, el guardián las vuelve a poner (vigila el archivo).
- **Cambiar la hora del ordenador no acaba el bloqueo:** usa un reloj monotónico y guarda el tiempo restante cada 30 s; si detecta un salto de hora sospechoso, no adelanta el final (y, si hay internet, lo contrasta con la hora de un servidor).
- La API local **no tiene** ninguna operación para «terminar ya» un bloqueo. Solo permite crear, ampliar, consultar, informar de intentos y pedir el desbloqueo de emergencia, cuya cuenta atrás y penalización hace cumplir el propio guardián. Así, ni llamando a la API a mano se puede hacer trampa.
- Seguridad de la API: solo `127.0.0.1`, token para las operaciones de escritura, CORS limitado a la extensión, validación estricta de todas las entradas y nunca ejecutar comandos construidos con datos recibidos.
- Si la extensión no está conectada durante un bloqueo, la app lo avisa. Opción en Ajustes (desactivada por defecto): durante un bloqueo, cerrar los navegadores que no tengan la extensión activa, para que no se pueda usar otro navegador sin ella.
- Los **horarios** (bloqueos que se repiten) también los guarda y los ejecuta el guardián.

**Instalación del guardián** (pide permisos de administrador una sola vez):

- **Windows:** instalador NSIS por máquina y con elevación, que registra el servicio con `customInstall` / `customUnInstall` en `build/installer.nsh`.
- **macOS:** en el primer arranque la app pide la contraseña de administrador con el diálogo nativo, copia el binario a `/Library/PrivilegedHelperTools/` y carga un LaunchDaemon en `/Library/LaunchDaemons/`.
- **Linux:** el `.deb` instala la unidad systemd en el `postinst`; con AppImage se instala en el primer arranque con `pkexec`.
- **La desinstalación siempre deja el sistema limpio:** quita el servicio, la sección del hosts y todo lo demás. Nunca impidas desinstalar ni ocultes la app. Si hay un bloqueo activo, avisa de que se perderán los puntos y la racha.

**App de escritorio:**

- Al cerrar la ventana, la app se queda en la **bandeja del sistema** mostrando el tiempo restante. Arranque automático al iniciar sesión (activable en Ajustes).
- Notificaciones: bloqueo iniciado, quedan 5 min, bloqueo terminado, «Intento bloqueado: −10 puntos».
- Mini temporizador flotante opcional, siempre visible y que se puede mover.

**Problemas conocidos que debes resolver o documentar:**

- Algunos navegadores con DNS seguro (DoH) o con conexiones ya abiertas pueden tardar en respetar el hosts: por eso la extensión es la capa principal dentro del navegador y el hosts es la red de seguridad.
- El hosts no admite comodines (`*.dominio.com`): enumera en el catálogo los subdominios necesarios.
- Algunos antivirus vigilan los cambios en el hosts: comprueba que Windows Defender no lo marca y documenta qué hacer si avisa.
- Las extensiones no funcionan en incógnito salvo que se permita: la extensión debe detectarlo y explicar cómo activarlo.

## 6. Extensión del navegador

- Manifest V3 con un solo código para Chrome, Edge, Brave (y otros Chromium) y Firefox (`browser_specific_settings` para Firefox).
- Pide al guardián la lista activa cada pocos segundos (o por WebSocket) y crea reglas dinámicas de `declarativeNetRequest` que redirigen a `blocked.html` de la propia extensión (declarada en `web_accessible_resources`).
- **`blocked.html`:** mensaje motivador con humor, **tu motivo**, tiempo restante, puntos perdidos por este intento y botón «Volver a lo mío». Informa del intento al guardián, que resta los puntos.
- Emparejamiento con la app la primera vez mediante un código.
- **Modo lista blanca** (lo usan el castigo de nivel 2 y el modo examen): bloquea todas las webs salvo las permitidas.
- Más adelante: **«YouTube solo educativo»** (bloquear Shorts, la portada y las recomendaciones; permitir vídeos, canales o listas concretas).
- Distribución: al principio se instala como extensión «descomprimida», con una guía paso a paso en la app y en la web. Déjalo todo preparado para publicarla en Chrome Web Store y Firefox Add-ons (iconos, textos y política de privacidad).

## 7. Puntos, penalizaciones y recompensas

Todos los valores en un único archivo (`packages/shared/src/points.ts`) para poder ajustarlos:

- **Ganar:** +1 punto por minuto de bloqueo cumplido; +2 por minuto concentrado en Study Mode; +20 de bonus por terminar una sesión sin ningún intento.
- **Perder:** −10 por **cada intento** de entrar en algo bloqueado; si repites en menos de 5 min se duplica (−10, −20, −40…, con un tope de −80 por intento). El saldo puede quedar en negativo («números rojos»).
- −15 por cada strike en Study Mode; −100 cuando salta el castigo.
- **Desbloqueo de emergencia** (no existe en Hardcore): escribir a mano una frase de compromiso («Acepto romper mi compromiso y perder mis puntos»), esperar una cuenta atrás de 10 min en Normal o 30 min en Estricto (que se puede cancelar) y perder 200 puntos o la mitad del saldo (la pérdida mayor de las dos), además de la racha.
- **XP y niveles:** la XP solo sube (minutos concentrado) y marca tu nivel; los puntos son el «dinero», que sube y baja.
- **Racha:** días seguidos cumpliendo tu objetivo diario (por defecto, 60 min concentrado).
- **Tienda de recompensas:** canjear puntos por descansos ganados (por ejemplo, 15 min de YouTube por 150 puntos) que desbloquean temporalmente un servicio de forma legal.
- **Logros** (primera sesión, 7 días de racha, 10 h de Study Mode, una semana sin intentos…).
- **Mascota o árbol** que crece mientras te concentras y se marchita si te rindes (estilo Forest).
- Los puntos se calculan a partir del registro de eventos del guardián; la interfaz no permite editarlos.

## 8. Study Mode con cámara e IA

**Flujo:** pulsas «Study Mode» → escribes la tarea (por ejemplo «Estudiar historia») y la duración (o eliges Pomodoro) → se enciende la cámara → la IA vigila en local si estás estudiando → al final ves un resumen.

**Privacidad (obligatorio; explícalo en la app y en la web):**

- Todo se procesa **en el ordenador**. Ninguna imagen se guarda, se sube ni sale del dispositivo. Solo se guardan datos agregados (minutos concentrado, número de avisos).
- Pantalla de consentimiento la primera vez. La cámara solo se enciende cuando el usuario inicia Study Mode, con un indicador visible mientras está activa y vista previa opcional.
- Permisos: en macOS, `NSCameraUsageDescription` y `systemPreferences.askForMediaAccess('camera')`; en Windows, detectar si la privacidad del sistema bloquea la cámara y explicar cómo activarla.

**Señales** (a 2–4 fotogramas por segundo y con resolución baja, para gastar poca CPU):

- ¿Hay una cara? Si no hay nadie durante un rato, no estás.
- Orientación de la cabeza (yaw y pitch a partir de la matriz de transformación del Face Landmarker): mirando a la pantalla o girado.
- Ojos cerrados mucho rato (blendshapes `eyeBlinkLeft` / `eyeBlinkRight`): te estás durmiendo → sugiere un descanso.
- **Móvil en la imagen** (Object Detector, clase COCO `cell phone`): distracción fuerte.
- Libro en la imagen (clase `book`): señal positiva.
- Qué app o web está en primer plano: si es una distracción, no estás estudiando aunque mires la pantalla.
- Actividad de teclado y ratón (`powerMonitor.getSystemIdleTime()`), como señal débil.
- **Ojo:** mirar hacia abajo para escribir en un cuaderno o leer un libro **es estudiar**. No lo castigues.

**«IA entrenada» = modelos preentrenados + calibración personal** (es la clave para no dar falsos positivos):

- Asistente de unos 2 minutos que graba unos 20 s de cada situación: «estudiando mirando la pantalla», «estudiando con libro o cuaderno», «distraído con el móvil», «mirando a otro lado» y «no estoy».
- Con las características de cada fotograma (ángulos de la cabeza, blendshapes, posición y tamaño de la cara, probabilidad de móvil y de libro), entrena **en el propio ordenador** un clasificador pequeño (regresión logística o una red pequeña con TensorFlow.js). Se guarda en local y se puede recalibrar.
- En los avisos, botón **«¡Estaba estudiando!»**: guarda ese momento como ejemplo y reentrena, para que la IA aprenda de sus errores.
- **Puntuación de concentración** de 0 a 100, suavizada (media de los últimos 10–20 s, con histéresis), que combina el clasificador personal y reglas (el móvil en la mano pesa mucho).
- **Modo sin cámara** alternativo: usa solo la ventana activa y la actividad.

**Máquina de estados** (tiempos configurables):

- **ENFOCADO** → si la puntuación baja del umbral durante 15 s → **DUDA**: sonido suave y mensaje «¿Sigues ahí?».
- **DUDA** durante 30 s más → **STRIKE**: notificación, sonido y −15 puntos. Tras un strike hay 60 s de margen antes de que pueda contar otro.
- Sin cara durante 60 s → strike (salvo en los descansos).
- **3 strikes en una sesión → CASTIGO de 60 minutos** (configurable entre 15 y 120).
- Los descansos del Pomodoro y el botón «Pausa» (máximo 2 pausas de 5 min por hora) no cuentan.

**Niveles de castigo** (el usuario elige en Ajustes; por defecto, el 1):

1. **Bloqueo de todas las distracciones:** todas las categorías de webs y apps.
2. **Solo lista blanca:** únicamente webs y apps de estudio.
3. **«Nuclear»** (opcional, desactivado por defecto): una pantalla completa por encima de todo, en todos los monitores, que bloquea el ordenador durante el castigo mostrando la cuenta atrás, con salida de emergencia con fricción (espera + penalización). Explica en la app que en un ordenador del que eres administrador no existe un bloqueo 100 % imposible de saltar.

- El castigo lo aplica y lo mantiene **el guardián**, así que no se quita cerrando la app ni reiniciando.
- Durante Study Mode la app envía «latidos» al guardián. Si dejan de llegar durante más de 2 min (porque la app se ha cerrado a la fuerza) y el equipo no estaba suspendido, cuenta como abandono y se aplica el castigo. Tapar la cámara cuenta como «no estás».

**Detalles técnicos que debes respetar:**

- El análisis tiene que seguir funcionando con la ventana cerrada o minimizada: ejecútalo en una ventana oculta con `backgroundThrottling: false` y un bucle con temporizador (**no** `requestAnimationFrame`, que se detiene con la ventana oculta). Pruébalo.
- Objetivo de rendimiento: menos del 15 % de CPU en un portátil normal.
- **Resumen al terminar:** tiempo concentrado, porcentaje de concentración, momentos de distracción en una línea de tiempo, strikes y puntos.

## 9. Más funciones

- **Pomodoro** integrado (25/5 y 50/10, personalizable); en los descansos se pausa la vigilancia de la cámara.
- **Horarios:** bloqueos que se repiten solos (por ejemplo, «de lunes a viernes de 16:00 a 19:00, redes sociales»).
- **Modo examen:** lista blanca + Hardcore durante X horas.
- **Estadísticas:** tiempo concentrado por día, semana y mes; mapa de calor tipo GitHub; webs y apps que más intentas abrir; tus mejores horas; exportar a CSV.
- **Tareas de la sesión:** qué vas a hacer y, al terminar, «¿lo has conseguido?».
- **Sonidos de concentración** (lluvia, ruido blanco, lo-fi) que funcionan sin internet.
- **Recordatorios:** «Es tu hora de estudiar» según tus horarios; descansos para la vista (regla 20-20-20).
- **Ajustes:** idioma, tema claro/oscuro, sonidos, sensibilidad de la IA, penalizaciones, arranque automático, estado del guardián y de la extensión, exportar y **borrar todos mis datos**.
- **Onboarding** la primera vez: bienvenida → instalar el guardián (permiso de administrador) → instalar la extensión → probar la cámara (opcional) → crear tu primer bloqueo.

## 10. Diseño de la app

- Moderno, limpio y motivador (inspiración: Forest, Opal). Tema oscuro y claro, animaciones sutiles, buena tipografía y accesible (contraste, teclado, lectores de pantalla).
- Pantallas: **Inicio** (campo «¿Qué quieres hacer?», plantillas, bloqueos activos con una cuenta atrás grande, puntos, nivel y racha), **Study Mode** (tarea, temporizador, medidor de concentración, strikes, vista previa opcional), **Bloqueos** (activos, horarios, listas), **Estadísticas**, **Recompensas y logros**, **Ajustes** y **Onboarding**.
- Textos en español, cercanos y con algo de humor («YouTube seguirá ahí dentro de 43 minutos. Tus deberes, no.»).
- Menú de la bandeja: tiempo restante, bloqueo rápido y abrir la app.

## 11. La web en Render

Web en `apps/web` con Astro + Tailwind: rápida (Lighthouse ≥ 90), responsive, con modo oscuro y en español.

**Páginas:**

- **Inicio:** titular claro («Deja de procrastinar. De verdad.»), botón grande **«Descargar para Windows / macOS / Linux»** que detecta tu sistema, enlaces a los otros sistemas, «cómo funciona» en 3 pasos, funciones, sección de Study Mode con el mensaje «tu cámara nunca sale de tu ordenador», **demo interactiva** del campo de texto (usa el parser real de `packages/shared`: escribes «no veo YouTube en una hora» y te enseña qué haría la app), capturas o mockups, preguntas frecuentes y pie con enlace a GitHub.
- **Descargar:** instrucciones por sistema, requisitos, versión actual, tamaño, SHA-256, cómo instalar la extensión y **cómo pasar los avisos de seguridad**, porque al principio la app no estará firmada (Windows SmartScreen: «Más información» → «Ejecutar de todas formas»; macOS: Ajustes del Sistema → Privacidad y seguridad → «Abrir igualmente»). Cómo desinstalar.
- **Novedades:** changelog leído de GitHub Releases.
- **Privacidad:** política clara (qué se guarda, cámara 100 % local, sin cookies de seguimiento), adaptada al RGPD.
- SEO básico: título, descripción, imagen para redes (Open Graph), favicon y `sitemap.xml`.

**Enlaces de descarga:**

- Los instaladores se alojan en **GitHub Releases**, no en Render (son archivos grandes).
- Usa **nombres de archivo sin versión** para que los enlaces no cambien nunca: `https://github.com/<owner>/<repo>/releases/latest/download/Centrate-Setup.exe`, y lo mismo con `Centrate.dmg`, `Centrate.AppImage`, `Centrate.deb` y `Centrate-extension.zip`.
- Muestra la versión actual con la API de GitHub (`/releases/latest`), con un valor de respaldo si falla.
- Añade una comprobación que verifique, después de cada release, que todos los enlaces de descarga funcionan.

**Despliegue en Render:**

- Crea `render.yaml` (Blueprint) con un **Static Site** (gratis): build `npm ci && npm run build -w apps/web`, carpeta publicada `apps/web/dist`, cabeceras de seguridad y de caché, y despliegue automático al hacer push a `main`.
- **Si tienes el conector (MCP) de Render disponible, crea tú el servicio**, espera a que el deploy esté «live» y comprueba que la URL carga. Si no lo tienes, dame los pasos exactos (Render → New → Blueprint → elegir el repositorio) y lo hago yo.
- Dame la URL final `https://….onrender.com`.

## 12. GitHub: CI, releases y actualizaciones

- **`ci.yml`** (en cada push y PR, en Windows, macOS y Linux): instalar, lint, typecheck, tests de TypeScript y Go, y build de la web y de la extensión. Incluye tests de integración del guardián contra un **hosts falso** en una carpeta temporal (la ruta del hosts tiene que ser configurable).
- **`release.yml`:** se lanza con un tag `vX.Y.Z` y también a mano (`workflow_dispatch` con la versión; si no puedes subir tags, lánzalo así y que el propio workflow cree el tag). Matriz Windows/macOS/Linux: compila el guardián; empaqueta con electron-builder (Windows: NSIS `.exe`; macOS: `.dmg` universal, o dos DMG arm64/x64 si el universal da problemas con módulos nativos, y entonces la web ofrece los dos; Linux: `.AppImage` y `.deb`); empaqueta la extensión en `.zip`, y lo sube todo a **la misma Release, publicada y no como borrador** (si no, `/releases/latest` no funciona). Genera las sumas SHA-256.
- **Auto-actualización** con `electron-updater` desde GitHub Releases. En macOS sin firmar no funciona: ahí muestra «Hay una versión nueva» con un enlace a la web.
- **Firma de código:** de momento sin firmar (cuesta dinero). Deja el workflow preparado para añadir certificados más adelante mediante secrets y explica en el `README` qué haría falta.
- Versionado semántico y `CHANGELOG.md`.
- **`README.md`:** qué es, capturas, descarga, cómo funciona (diagrama mermaid de la arquitectura), privacidad, cómo desarrollar y cómo publicar una release.

## 13. Seguridad, privacidad y ética

- La app solo actúa sobre el ordenador de quien la instala y con su consentimiento: nada oculto, icono siempre visible y desinstalación limpia siempre posible.
- Cero telemetría sin permiso explícito. Las imágenes de la cámara nunca salen del ordenador.
- Privilegios mínimos: solo el guardián se ejecuta como administrador y solo hace lo imprescindible (hosts, procesos de la lista y su propia carpeta).
- Dependencias actualizadas y sin vulnerabilidades conocidas (`npm audit`, `govulncheck`).
- Sin secretos en el código ni en el historial de git.

## 14. Fase opcional: cuentas, amigos e IA

Solo cuando todo lo anterior funcione:

- Backend en `apps/api` (Node + TypeScript + Fastify + Postgres con Drizzle) desplegado en Render como Web Service, con la configuración en variables de entorno. Ten en cuenta los límites del plan gratuito de Render (el servicio se duerme si no se usa y la base de datos gratuita caduca), así que la app tiene que seguir funcionando al 100 % sin cuenta y sin internet.
- Inicio de sesión (Google o enlace mágico por email) con una librería de autenticación mantenida.
- Sincronización de estadísticas entre ordenadores y panel web con tus gráficas.
- **Amigos, ranking semanal y «estudiar juntos»** (ver quién está concentrado ahora).
- **Compañero de responsabilidad:** un amigo recibe un aviso si usas el desbloqueo de emergencia o abandonas (opcionalmente, tiene que aprobarlo).
- **Coach IA** con la API de Claude (Anthropic), siempre a través del backend (la clave nunca va dentro de la app): divide una tarea grande en pasos, crea un plan de estudio para un examen, interpreta las frases que el parser local no entiende y te hace un resumen semanal. Usa los modelos actuales más adecuados (uno rápido y barato para interpretar frases, uno más capaz para el coach) y limita el uso por usuario.

## 15. Fases y criterios de «terminado»

- **Fase 0. Esqueleto:** monorepo, lint, tests, CI en verde en los 3 sistemas, `README`, `ROADMAP`, `DECISIONS` y `LICENSE`.
- **Fase 1. Núcleo de bloqueo:** app con campo de texto y confirmación, parser, catálogo, guardián (hosts, procesos, persistencia, fin automático, anti-cambio de hora), bandeja, notificaciones y puntos básicos.
  ✅ *Terminada cuando:* escribo «no veo YouTube en una hora», confirmo, cierro la app (y la mato desde el Administrador de tareas) y YouTube sigue bloqueado; reinicio y sigue bloqueado; al pasar la hora se desbloquea solo sin abrir la app.
- **Fase 2. Distribución:** instaladores con GitHub Actions, Release `v0.1.0` y web publicada en Render con descargas que funcionan.
  ✅ *Terminada cuando:* entro en la URL de Render, pulso «Descargar», instalo y la Fase 1 funciona en mi ordenador.
- **Fase 3. Extensión e intentos:** extensión, página de bloqueo, intentos que restan puntos, ventana activa y desbloqueo de emergencia.
  ✅ *Terminada cuando:* al entrar en YouTube veo la página de Céntrate con mi motivo y pierdo 10 puntos.
- **Fase 4. Study Mode:** cámara, calibración, clasificador, máquina de estados, castigo y privacidad.
  ✅ *Terminada cuando:* si cojo el móvil o me voy, me avisa; a los 3 strikes se aplica el castigo de 60 min aunque cierre la app; y si escribo en un cuaderno **no** me castiga.
- **Fase 5. Extras:** Pomodoro, horarios, modo examen, estadísticas, recompensas, logros, mascota, sonidos y onboarding completo. Release `v1.0.0`.
- **Fase 6. Opcional:** cuentas, amigos, ranking y coach IA.

En cada fase: tests nuevos, CI en verde, release nueva si cambia la app, web actualizada, `ROADMAP.md` al día y checklist de pruebas manuales para mí.

## 16. Entrega final

Cuando termines, dame:

1. El enlace al repositorio de GitHub.
2. El enlace a la web en Render.
3. El enlace a la última Release con los instaladores.
4. La lista de cosas que tengo que hacer yo a mano, si hay alguna.
5. Las limitaciones conocidas y los próximos pasos que recomiendas.

**Empieza ahora por la Fase 0.**
