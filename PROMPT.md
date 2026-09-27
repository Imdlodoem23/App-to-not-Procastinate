# Prompt para Claude: «Céntrate», la app para no procrastinar

> **Cómo usar este prompt**
> 1. Abre una sesión de **Claude Code** (claude.ai/code) con este repositorio y con **GitHub y Render conectados**. Elige el modo de permisos automático para que no te pida permiso en cada paso.
> 2. Para que pueda usar unos 20 agentes a la vez, sube en `/config` el ajuste **«Dynamic workflow size»** (por defecto limita cada workflow a unos 10 agentes).
> 3. Pega todo lo que hay debajo de la línea, o escribe: «Lee `PROMPT.md` y síguelo empezando por la Fase 0». El prompt incluye la palabra **ultracode**, que en Claude Code activa el trabajo con muchos agentes en paralelo.
> 4. Para que siga trabajando solo sin que tengas que escribirle nada, lanza:
>    `/loop Sigue PROMPT.md: haz la siguiente fase pendiente de ROADMAP.md y, si ya están todas, sigue perfeccionando la app (Fase 7).`
>    Sin intervalo, Claude decide cuándo volver a ponerse a trabajar.
> 5. Si aun así se para (por límite de uso o porque se acaba la sesión), escribe «sigue» o abre otra sesión con: «Continúa con la siguiente fase pendiente de `ROADMAP.md`».
>
> Antes de pegarlo puedes cambiar el nombre, las prioridades o los números (puntos, tiempos).

---

## 0. Tu papel y cómo quiero que trabajes

**ultracode.** Eres un equipo de ingeniería sénior (escritorio, web, DevOps, diseño de producto e IA en el dispositivo) coordinado por ti. Vas a construir **de principio a fin** un producto real: el código, el repositorio en GitHub, los instaladores descargables y la web publicada en Render. No me des solo ideas o fragmentos: hazlo, pruébalo y publícalo.

### Modo autónomo total (lo más importante)

1. **No me preguntes nada y no esperes nunca mi respuesta.** Toma tú todas las decisiones y apúntalas en `DECISIONS.md` (una línea con el porqué). Si algo depende de verdad de mí (una credencial, una cuenta de pago, hacer público el repositorio, probar en mi ordenador), anótalo en `PENDIENTE_PARA_MI.md` con los pasos exactos, usa una alternativa temporal y sigue con todo lo demás.
2. **No pares hasta que la app esté terminada:** todas las fases de la sección 15. Después pasa a la Fase 7 y **sigue perfeccionándola durante horas** (interfaz, rendimiento, fallos, tests, textos). «Terminado» no es «compila»: es que funciona, se ve genial y está publicado.
3. Si se te acaba el contexto o la sesión, deja `ROADMAP.md` al día para que la siguiente sesión siga exactamente donde lo dejaste, también sin preguntarme nada.

### Trabajo con muchos agentes (unos 20 por tarea)

Usa **workflows de Claude Code con muchos subagentes en paralelo para cada tarea importante**. Apunta a unos 20 agentes por tarea; si el sistema limita cuántos se ejecutan a la vez, ponlos en cola por tandas. Patrón para cada fase:

- **Diseñar:** varios agentes proponen enfoques distintos y un panel de jueces elige el mejor y le injerta las mejores ideas del resto.
- **Implementar:** reparte el trabajo por módulos (guardián, parser, cada sección de la interfaz, extensión, web, CI…), con un agente por módulo, cada uno en su propio worktree aislado para no pisarse, y luego intégralo.
- **Revisar:** varios revisores independientes, cada uno con un enfoque distinto (bugs, seguridad, rendimiento, interfaz, accesibilidad, fidelidad a este prompt), intentan tumbar cada cambio; solo sobrevive lo que resiste. Repite hasta que dos rondas seguidas no encuentren nada nuevo.
- **Verificar:** un agente final lo compara con los criterios de «terminado» y lo que falte vuelve a la cola.

Tú coordinas, integras y te aseguras de que todo encaja. No hagas a mano, en serie, lo que un grupo de agentes puede hacer mejor en paralelo.

### Reglas de trabajo

4. Trabaja **por fases** (sección 15). No pases a la siguiente hasta que la actual compile, pase los tests y esté subida.
5. Antes de escribir código, resume en unas 10 líneas el plan y la arquitectura, y sigue sin esperar mi respuesta.
6. Mantén `ROADMAP.md` con casillas `[ ]` / `[x]` al día.
7. Commits pequeños y descriptivos. **Nunca** subas secretos: usa GitHub Secrets y las variables de entorno de Render.
8. Al terminar cada fase, deja escrito en `ROADMAP.md` y en el Pull Request qué funciona, una **checklist para que yo lo pruebe en mi ordenador cuando quiera** y qué viene después. Luego sigue con la siguiente fase sin esperar.
9. Sé honesto con los límites técnicos: si algo no se puede hacer al 100 % (por ejemplo, un bloqueo imposible de saltar para el administrador del ordenador), hazlo de la forma más robusta razonable y explícalo en `DECISIONS.md`.
10. Si trabajas en un contenedor Linux y no puedes probar Windows o macOS a mano, cúbrelo con tests automáticos en GitHub Actions (`windows-latest`, `macos-latest`, `ubuntu-latest`).
11. Usa `main` como rama principal y de despliegue; si no existe, créala. Al terminar cada fase abre un Pull Request hacia `main` con un resumen y **fusiónalo tú** en cuanto el CI esté en verde (tienes mi permiso), sin esperar mi revisión.

## 1. Datos del proyecto

- **Nombre:** Céntrate (identificador técnico `centrate`, sin tildes, para paquetes, archivos y binarios; appId `io.github.imdlodoem23.centrate`).
- **Repositorio:** `https://github.com/imdlodoem23/app-to-not-procastinate`. Ahora mismo está vacío (como mucho contiene este `PROMPT.md`). Tiene que ser **público**: los archivos de GitHub Releases de un repositorio privado no se pueden descargar sin iniciar sesión. Si es privado y no puedes cambiarlo tú, apúntalo en `PENDIENTE_PARA_MI.md` y sigue.
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
apps/api           (Fase 6) Backend Node + TypeScript + Postgres -> Render
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

## 10. Diseño de la interfaz: moderna, simple y útil (estilo G-Helper)

**Referencia visual: G-Helper** (`https://github.com/seerge/g-helper`). Clónalo fuera del repositorio y estudia estos archivos:

- `docs/screenshot.png`, `docs/screenshot-dark.png` y `docs/app-hero.jpg`
- `app/UI/RForm.cs` (colores)
- `app/UI/RButton.cs` (botones y estado seleccionado)
- `app/Settings.Designer.cs` + `app/Settings.cs` (medidas, posición y líneas de ayuda)

Copia su forma de organizar, no su código ni sus iconos (G-Helper es GPL-3.0 y Céntrate es MIT): **una ventana pequeña que sale de la bandeja al instante, con secciones apiladas y filas de botones grandes, todo a la vista y aplicado al momento, sin navegar**. Minimalista significa quitar adornos, no funciones: todo lo de las secciones 4–9 queda a uno o dos clics.

**Reglas de base:**

- **El título es el estado.** Cada sección empieza con una cabecera de 20 px:
  - icono de 16 px;
  - título en negrita «Cosa: valor» («Bloqueo: YouTube · Estricto»);
  - alineado a la derecha y en peso normal, un dato vivo («hasta 17:42»).

  No hay pantalla de resumen aparte.
- **Una decisión = una fila de 3 o 4 botones grandes iguales («tiles»).** Van en una rejilla de 4 columnas (o 3) con 4 px de hueco. Debajo, una **línea de ayuda** gris de 12 px explica el tile que tiene el ratón o el foco. Reserva su alto para que nada salte. Nada de tooltips emergentes.
- **El último tile puede ser una puerta.** Su etiqueta acaba en «…», usa el fondo secundario y abre algo en vez de aplicar. Normalmente es una ventana de detalle pegada a la principal, como «Fans + Power» en G-Helper.
- **Lo reversible se aplica al instante, sin «Guardar».** Crear un bloqueo pasa por la tarjeta de confirmación de la sección 4.
- **Confirmación en el sitio** (para canjear una recompensa, terminar el Study Mode antes de tiempo, activar Nuclear y dar el paso final del desbloqueo de emergencia):
  - el primer clic cambia la etiqueta a «¿Seguro? …», con contorno rojo y la consecuencia en la línea de ayuda;
  - el segundo clic, antes de 3 s, aplica;
  - Esc o sacar el ratón lo desarma.

  Nunca modales encadenados.
- **Prohibido:**
  - barra lateral, pestañas, rutas con «Atrás» y menú hamburguesa;
  - paneles de tarjetas, sombras, degradados, cristal, ilustraciones o logo grande dentro de la app;
  - seleccionados con relleno sólido y controles solo con icono;
  - spinners en acciones locales;
  - scroll en la ventana principal (salvo el caso extremo de «Alto automático»).
- **Oculta lo que no aplica** en vez de dejarlo gris. Sin cámara no se ofrece nada de cámara, y la fila de ampliar solo existe con un bloqueo activo. Las secciones que no protagonizan el estado actual se pliegan a su cabecera: durante el Study Mode, Bloqueo queda en «Bloqueo: YouTube · 42 min».

**Ventana principal:**

- **Forma:** 440 px (DIP) de ancho y alto ajustado al contenido.
  - `resizable`, `minimizable`, `maximizable` y `fullscreenable` a `false`.
  - Barra de título nativa solo con la X (oscura en tema oscuro).
  - El título de la ventana también dice el estado: «Céntrate», «Céntrate · quedan 42 min», «Céntrate · estudiando», «Céntrate · castigo 38 min».
- **Alto automático:**
  - Un `ResizeObserver` manda el alto por IPC. El proceso principal llama a `setContentSize(440, alto)` dejando fijo el borde inferior, con un máximo de `workArea.height − 20`.
  - Objetivo: ≤ 540 px de contenido en reposo y ≤ 600 px en cualquier estado.
  - Si no cabe, pasa sola a **densidad compacta**: tiles de 40 px con el icono a la izquierda del texto, cuenta atrás de 40 px y 8 px entre secciones.
  - Solo en pantallas más pequeñas que la matriz de pruebas (ver criterios de aceptación) hay scroll, y solo dentro de la columna de secciones, nunca en el pie.
- **Posición:** en la esquina del `workArea` más cercana a la bandeja (`tray.getBounds()`), a 10 px de los bordes. En Windows, abajo a la derecha, aunque la barra de tareas esté arriba o a un lado; en macOS, arriba a la derecha. Vuelve ahí cada vez que se muestra.
- **Ciclo de vida:**
  - Clic izquierdo en la bandeja: la muestra o la oculta (si está tapada, la trae delante).
  - La X oculta la principal y las de detalle; la primera vez, una línea lo explica.
  - Solo se sale con «Salir».
- **Rápida:**
  - Créala oculta al arrancar (`show: false`, `backgroundColor` del tema, sin destello blanco) y después solo muéstrala u ocúltala.
  - Mientras está visible consulta al guardián cada 2 s. Oculta no hace nada (la bandeja la actualiza el proceso principal).
  - Recharts y MediaPipe se cargan solo cuando hacen falta.

**Secciones, de arriba abajo** (12 px de margen lateral, 12 px de aire entre secciones y ningún separador):

1. **Aviso de protección.** Solo aparece si algo falla, como mucho 5 s después de detectarlo:
   - «Guardián detenido: ahora mismo no se bloquea nada», con **Reparar | Detalles…**;
   - en naranja, «Chrome no tiene la extensión: ahí el bloqueo puede tardar», con **Instalar…**.
2. **Bloqueo** (icono de candado).
   - *Sin bloqueo:*
     - Cabecera: «Bloqueo: ninguno» · «Próximo horario: 16:00» (si lo hay).
     - Campo «¿Qué quieres hacer?» de 44 px y texto de 15 px. Recibe el foco cada vez que se muestra la ventana y, mientras está vacío, enseña una frase de ejemplo distinta cada 4 s.
     - Mientras escribes, la línea de ayuda muestra fichas con lo entendido (servicio con su icono · «1 h» · «hasta 17:42»; clic en una ficha para corregirla) o lo que no («No he entendido: "mañana tarde"»).
     - Debajo, tus plantillas: **Deberes 1 h | Examen 3 h | Leer 30 min | Más…**. «Examen» usa el modo examen (lista blanca + Hardcore) y «Más…» abre **Bloqueos**.
   - *Confirmación* (en la misma sección, sustituye a las plantillas, sin modal). Contiene:
     - qué se bloquea (fichas con icono);
     - duración y hora de fin sincronizadas (máximo 24 h);
     - **Normal | Estricto | Hardcore | Examen**, por defecto el de Ajustes. La línea de ayuda explica cada uno: «Estricto: la emergencia tarda 30 min y cuesta al menos 200 puntos»;
     - «Tu motivo» (una línea; recuerda el último);
     - el recordatorio «Solo se puede ampliar, nunca acortar»;
     - **Editar… | Bloquear hasta 17:42**.

     Enter confirma y Esc vuelve.
     - **Más de 4 h, Hardcore o Examen:** el primer Enter añade una línea roja con la consecuencia («6 h: termina a las 23:42 y solo se puede ampliar»; en Hardcore y Examen, «No podrás cancelarlo de ninguna forma hasta las 20:42»). El botón pasa a «Sí, bloquear 6 h», desactivado 2 s.
     - Si la frase es de estudiar («estudiar mates 1 hora»), la tarjeta propone Study Mode con la tarea puesta.
     - Si el parser no entiende la frase, Enter abre **Bloqueos** con lo que sí entendió.
     - Nada aparece como activo hasta que el guardián lo confirma. Mientras tanto se ve «Bloqueando…»; si no responde en 3 s, «El guardián no responde · Reintentar · Reparar».
   - *Con bloqueo:*
     - Cabecera: «Bloqueo: YouTube, Instagram · Estricto» · «hasta 17:42», con una píldora «Nuevo» que vuelve al campo.
     - Cuenta atrás grande, barra de 3 px del color del modo y tu motivo en cursiva en la línea de ayuda.
     - Fila **+15 min | +30 min | +1 h | Otro…**. Un clic amplía y muestra «+30 min · termina a las 18:12 · Deshacer (5 s)». La app no manda la ampliación al guardián hasta que pasan esos 5 s, así que deshacer nunca acorta un bloqueo real.
     - No existe ningún control para acortar.
     - Bajo la barra, el enlace gris «Desbloqueo de emergencia…». En Hardcore, en su lugar, «Hardcore: no se puede cancelar».
     - Con varios bloqueos, la cuenta grande es la del que acaba más tarde y los demás son filas de 28 px (máximo 2; el resto, «y 3 más…», abre **Bloqueos**).
   - *Castigo:* la misma sección con barra roja y sin ampliar: «Castigo: todas las distracciones · 60 min», la causa («3 strikes en "mates"») y «−100 puntos», sin parpadeos ni riñas.
   - *Al terminar:* «Bloqueo: terminado» · «Hecho. +80 puntos» en verde durante 1 min.
3. **Study Mode** (icono de libro).
   - Cabecera: «Study Mode: listo» · «Con cámara · calibrado» (o «Sin cámara»).
   - Tiles **25/5 | 50/10 | 1 h | Más…**. Un clic muestra en el sitio «¿Qué vas a estudiar?» (opcional, con la última tarea), y Enter o «Empezar» arranca.
   - La primera vez con cámara, antes se abre la ventana **Study Mode** con el consentimiento.
   - *En sesión:*
     - Cabecera «Study Mode: historia · 32:10», con la píldora roja fija «● Cámara activa» a la derecha mientras la cámara esté encendida (clic = vista previa).
     - Medidor de 6 px a todo el ancho, siempre con texto: «Concentrado», «¿Sigues ahí?», «No te veo» o «Descanso 4:12 · la cámara no vigila» (en los descansos, todo en gris). A su derecha, 3 puntos de strikes.
     - Tras un aviso o un strike aparece debajo **¡Estaba estudiando!** a todo el ancho.
     - Tiles **Pausa (2) | Sonido: Lluvia | Vista previa | Terminar**. «Sonido» pasa por Nada, Lluvia, Ruido blanco y Lo-fi con cada clic.
     - Al terminar se abre **Resumen**.
4. **Progreso.**
   - El icono de la cabecera es la mascota en su fase actual (brote, planta, árbol, marchita).
   - Cabecera: «Nivel 7 · 1.240 puntos» · «Racha: 5 días». Si el saldo es negativo, en rojo y con la píldora «Números rojos».
   - Una barra de 4 px con el objetivo diario («Hoy: 42 de 60 min»).
   - Tiles de 40 px **Estadísticas… | Recompensas… | Logros…**.
   - Los puntos no se pueden editar en ningún sitio.
5. **Pie:**
   - «● Guardián activo · ● Extensión conectada» (punto de 8 px + texto; si algo falla, «Guardián detenido · Reparar»).
   - A la derecha, «v1.2.0», que pasa a «Actualizar a v1.3.0» en azul cuando hay versión nueva.
   - Debajo, 3 botones secundarios iguales de 32 px con icono: **Mini temporizador | Ajustes… | Salir**. La ayuda de «Salir» dice «Los bloqueos siguen activos aunque salgas».

**Ventanas de detalle** (lo que abren las puertas):

- 600 px de ancho y el mismo alto que la principal (mínimo 480).
- Pegadas a su izquierda con 6 px de hueco y alineadas por abajo; a la derecha si no caben.
- Una sola a la vez y sin redimensionar. Esc o su X las cierra, y se ocultan con la principal.
- Usan el mismo patrón de secciones, en dos columnas si hace falta, y aquí sí puede haber scroll.

Las ventanas:

- **Bloqueos:**
  - el formulario avanzado de la sección 4: buscador y categorías del catálogo con casillas, dominios propios, apps con autocompletado de los procesos abiertos, duración de 5 min a 24 h o «Hasta las HH:MM», modo y «Tu motivo», con **Guardar como plantilla | Bloquear…**;
  - bloqueos activos y plantillas;
  - **horarios** («L–V 16:00–19:00 · Redes sociales», con interruptor por fila);
  - modo examen y lista blanca;
  - más adelante, «YouTube solo educativo».
- **Emergencia:**
  - lo que vas a perder, ya calculado («Perderás 620 puntos y tu racha de 5 días»);
  - la frase de compromiso escrita a mano;
  - la cuenta atrás en naranja («Esperando · 8:12 · Cancelar (recomendado)»);
  - al final, «Desbloquear» con confirmación en el sitio.
- **Study Mode:**
  - duración y tarea propias, Pomodoro personalizado, modo sin cámara y sonidos con volumen;
  - cámara: consentimiento con «Ninguna imagen sale de tu ordenador» y vista previa de 320×240, oculta por defecto;
  - calibración: las 5 situaciones como filas (Pendiente → Grabando 12 s → Hecho), con un único botón «Grabar 20 s» y «Recalibrar»;
  - ayuda si el sistema bloquea la cámara.
- **Resumen:** tiempo concentrado y porcentaje, una línea de tiempo a todo el ancho con las distracciones en naranja y rojo, strikes, puntos y **¿Lo has conseguido? Sí | En parte | No**.
- **Estadísticas:**
  - **Día | Semana | Mes**;
  - una gráfica de barras (Recharts, un solo color, sin rejilla salvo la línea base);
  - mapa de calor tipo GitHub en verde;
  - lo que más intentas abrir y tus mejores horas;
  - registro de eventos y «Exportar CSV».

  Cada gráfica lleva al lado un resumen en texto para lectores de pantalla.
- **Recompensas:**
  - la tienda en filas («15 min de YouTube · 150 pts · Canjear», con confirmación en el sitio). Si no te llega, el botón aparece desactivado con el motivo: «Te faltan 40 puntos»;
  - la mascota en grande.
- **Logros:** rejilla de 4 columnas. Los conseguidos llevan el estilo de seleccionado en verde; los pendientes, contorno gris, y la línea de ayuda dice cómo conseguirlos.
- **Ajustes** (el «Extra» de G-Helper): filas de 48 px con título y descripción a la izquierda y el control a la derecha. Grupos:
  - **General:** idioma, tema **Sistema | Claro | Oscuro**, arranque automático, objetivo diario, sonidos, avisos grandes y atajo global.
  - **Bloqueo:** modo por defecto, penalizaciones y cerrar navegadores sin extensión.
  - **Study Mode:** sensibilidad de la IA, nivel de castigo (1, 2 o Nuclear, con su explicación), duración del castigo de 15 a 120 min, tiempos, recordatorios y regla 20-20-20.
  - **Sistema:** guardián, extensión (con código de emparejamiento y guía por navegador y para incógnito), permisos y «Copiar diagnóstico».
  - **Datos:** exportar y «Borrar todos mis datos», que pide escribir BORRAR.

**Bandeja y otras superficies:**

- **Icono de la bandeja**, dibujado a 16, 20, 24 y 32 px:
  - monocromo en reposo;
  - azul, naranja o rojo según el modo del bloqueo;
  - verde en Study Mode;
  - rojo en castigo;
  - con un punto rojo si la cámara está encendida.
- **Tooltip** actualizado una vez por minuto: «Céntrate · YouTube · quedan 43 min · 1.240 pts».
- **Clic derecho:** menú nativo que repite los tiles:
  - «Quedan 43 min · YouTube» (desactivado);
  - Ampliar ▸ +15 / +30 / +1 h;
  - Bloqueo rápido ▸ (las plantillas, que abren la confirmación);
  - Study Mode ▸;
  - Mini temporizador (casilla);
  - Abrir Céntrate;
  - «Salir (los bloqueos siguen activos)».
- **Aviso grande (OSD, como el `ToastForm` de G-Helper):**
  - Cuándo: para lo que hagas desde la bandeja o el atajo global, y para «¿Sigues ahí?» con la ventana oculta.
  - Ventana sin marco que no coge el foco ni el ratón (`focusable: false`, `setIgnoreMouseEvents(true)`).
  - Centrada a 300 px del borde inferior: píldora negra al 60 % con radio de 8 px y texto blanco de 28 px en 600, durante 2 s.
  - Se puede desactivar.
- **Notificaciones:** las de las secciones 5 y 8 son nativas (la del strike, con el botón «¡Estaba estudiando!»), agrupadas y nunca más de una por minuto.
- **Mini temporizador:** 180×44 px, sin marco, siempre encima, arrastrable y recuerda su posición. Muestra el icono del servicio, el tiempo a 20 px y el punto de cámara activa.
- **Nuclear:** pantalla completa en cada monitor con el fondo del tema, cuenta atrás de 72 px, «Castigo · vuelves a las 18:40» y un único botón secundario «Salida de emergencia».
- **Onboarding** (la primera vez, con la ventana principal centrada):
  - Los 5 pasos de la sección 9, cada uno como una sección («Guardián · paso 2 de 5» · «No instalado») con una frase, una fila **Instalar | Omitir** y puntos de progreso.
  - El paso de la extensión muestra el código de emparejamiento a 32 px.
  - El último deja escrito «no veo YouTube en 25 minutos».
- **`blocked.html` y la ventana emergente de la extensión:** los mismos tokens en una columna de 440 px, con:
  - «YouTube: bloqueado» · «quedan 43 min»;
  - tu motivo a 20 px;
  - «−10 puntos» en rojo;
  - la frase con humor en gris;
  - un único tile «Volver a lo mío».

**Estilo visual:**

- Un único `packages/shared/src/design/tokens.css` con variables en `:root` y `[data-theme=dark]`, mapeadas en Tailwind con `@theme inline`.
- `tokens.ts` con los mismos valores para el proceso principal.
- Escritorio, extensión y web solo usan estos tokens; un lint en CI falla si aparece un color suelto.

| Token | Oscuro (valores de G-Helper) | Claro | Uso |
|---|---|---|---|
| `bg` / `tile` / `tile-2` | `#1C1C1C` / `#2E2E2E` / `#242424` | `#F0F0F0` / `#FFFFFF` / `#E3E3E3` | fondo / tiles y campos / puertas y botones secundarios |
| `fg` / `fg-muted` | `#F0F0F0` / `#A8A8A8` | `#1A1A1A` / `#5C5C5C` | texto / ayuda y datos secundarios |
| `border` / `control` | `#373737` / `#7A7A7A` | `#DCDCDC` / `#8A8A8A` | borde de tiles / borde de campos y casillas |
| `green` | `#06B48A` | `#047857` | concentrado, completado, guardián OK |
| `blue` | `#3AAEEF` | `#0A6AA8` | Normal, información, enlaces, sliders, foco |
| `orange` | `#FF8000` | `#A34700` | Estricto, aviso, «¿Sigues ahí?», strike |
| `red` | `#FF2020` (texto `#FF6464`) | `#C81E1E` | Hardcore, Examen, castigo, puntos perdidos, cámara activa, error |
| `neutral` | `#A8A8A8` | `#767676` | seleccionado en opciones sin «mejor» (duraciones, sonidos) |

- **Color:** solo esos 4 acentos, con el mismo significado en toda la app. Texto ≥ 4,5:1 y bordes de controles ≥ 3:1 en los dos temas. El color nunca es la única señal: siempre va con texto.
- **Tile:**
  - Fondo `tile`, borde de 1 px `border`, radio de 6 px y un icono de 20 px sobre una etiqueta de 13 px.
  - Alto: 56 px; 40 px las puertas de Progreso y 32 px los de solo texto.
  - Con el ratón encima, el fondo se acerca un 4 % a `fg` (un 8 % al pulsar).
  - **Seleccionado:** contorno de 2 px del acento (un 15 % más claro arriba) y un tinte del acento al 12 % que se desvanece en el primer 20 % del alto, como en `RButton.cs`. Nunca relleno sólido, y el texto no cambia de color.
  - Desactivado: 45 % de opacidad, y la línea de ayuda dice por qué.
  - **Única excepción de relleno:** el botón que confirma («Bloquear hasta 17:42», «Empezar»), en `blue`, con texto `#111111` en oscuro y blanco en claro.
- **Tipografía:**
  - Fuente: `"Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, "SF Pro Text", Ubuntu, "Noto Sans", sans-serif` (sin descargas).
  - Casi todo a 13 px: títulos en 600 y el resto en 400. Ayuda y pie a 12 px; píldoras a 11 px en 600.
  - Excepciones: el campo principal a 15 px, la cuenta atrás a 48 px (40 en compacta) en 600 con `tabular-nums` y `letter-spacing: -0.02em`, y el OSD.
  - Mayúscula solo al empezar la frase.
- **Espacio y forma:**
  - Rejilla de 4 px (4, 8, 12, 16).
  - Radios: 4 (píldoras, casillas), 6 (tiles, campos) y 8 (OSD, mini temporizador). Círculo solo en puntos de estado y fichas.
  - Sin sombras dentro de la ventana.
- **Movimiento:** solo el cambio de fondo al pasar el ratón o pulsar (100 ms) y la barra de progreso (lineal). Los cambios de estado son instantáneos o un fundido de 120 ms. Con `prefers-reduced-motion`, nada. Sin transiciones entre pantallas, rebotes ni confeti.
- **Iconos:** solo `lucide-react`, trazo 1,75 y `currentColor`; 16 px en cabeceras y pie, 20 px en tiles. Los servicios usan su favicon guardado en el catálogo. Todo control lleva texto.
- **Tema:** sigue a `nativeTheme` y cambia en vivo, con `color-scheme: light dark` para los controles nativos. Con el contraste alto de Windows (`forced-colors`) se mantienen los bordes.

**Cuenta atrás, números y textos:**

- **Cálculo:** la cuenta atrás es `endsAt − Date.now()` con un único `setTimeout` alineado al segundo. Nunca restando ni con `requestAnimationFrame`.
- **Formato:** `M:SS` bajo una hora y `H:MM:SS` por encima, con los segundos al 60 % de opacidad y sin animar los dígitos. El último minuto no se pone rojo.
- **Lectores de pantalla:** `role="timer"` con `aria-label` («Quedan 43 minutos»), y otra región `aria-live="polite"` que solo habla a los 15, 5 y 1 min y al terminar.
- **Números:** `Intl` en `es-ES` con `useGrouping: 'always'` (si no, sale «1240» en vez de «1.240»), horas de 24 h y el signo «−» tipográfico.
- **Textos:** cercanos y breves, con humor solo en estados vacíos y en la página de bloqueo («YouTube seguirá ahí dentro de 43 minutos. Tus deberes, no.»). Errores claros y con una acción; penalizaciones como un dato, sin culpa.
- **Estados vacíos:** icono de 24 px, una frase y una acción («Tus estadísticas aparecerán después de tu primera sesión» + «Empezar 25 min»).

**Teclado y accesibilidad:**

- **Foco:** al mostrarse la ventana, el foco va al campo; Ctrl+N o `/` vuelven a él.
- **Atajos:**
  - Enter avanza y Esc retrocede u oculta.
  - Ctrl+E amplía (y luego 1/2/3).
  - Ctrl+Shift+S empieza o termina el Study Mode.
  - Flechas dentro de cada fila (`role="radiogroup"` si es una elección).
  - Alt + letra en cada tile, como en G-Helper.
- **Anillo de foco:** `blue` de 2 px, solo con `:focus-visible`.
- **Objetivos de clic:** 32×32 px como mínimo.
- **Marcado:** `lang="es"`; cada sección es un `<section>` con su título como nombre accesible, y la línea de ayuda se enlaza con `aria-describedby`.

**Criterios de aceptación y pulido** (desde la Fase 1 y en cada ronda de interfaz de la Fase 7):

- **Arnés de estados:** una ruta solo de desarrollo (`?state=…`) con datos de prueba y el guardián simulado. Tiene que mostrar cada estado:
  - reposo, escribiendo y frase no entendida;
  - confirmación: normal, más de 4 h, Hardcore y Examen;
  - uno y tres bloqueos, ampliar con deshacer, terminado, emergencia, castigo y puntos en negativo;
  - Study Mode: concentrado, duda, strike, descanso y sin cámara;
  - protección rota y densidad compacta;
  - cada ventana de detalle y cada paso del onboarding;
  - mini temporizador, OSD, Nuclear y `blocked.html`.
- **Capturas con Playwright** (`_electron.launch`):
  - de cada estado, en claro y oscuro, a 1366×768 (100 y 125 %) y a 1920×1080 (100 y 150 %);
  - guardadas en `docs/ui/` con una página que las enseñe juntas; de ahí salen las del `README` y las de la web;
  - para criticarlas, ponlas al lado de las capturas de G-Helper.
- **Tiene que cumplirse:**
  - Crear un bloqueo = escribir + 2 Enter (con plantilla, clic + Enter).
  - Ampliar = 1 clic.
  - Empezar el Study Mode = 2 acciones tras el primer consentimiento.
  - Tiempo restante, puntos, racha y estado de la protección visibles sin hacer nada.
  - La ventana principal no tiene scroll ni texto cortado en ningún estado de esa matriz (`scrollHeight <= clientHeight`).
  - Del clic en la bandeja a la ventana con el foco en el campo: menos de 150 ms y sin destello blanco.
  - 0 fallos de axe-core.
  - La cuenta atrás no se desvía más de 1 s en una hora.
  - Con la ventana oculta y sin Study Mode, la app usa menos del 1 % de CPU.
- **Rondas de crítica:** agentes independientes revisan las capturas, cada uno con un enfoque: fidelidad a esta sección, parecido con G-Helper, alineación al píxel, tipografía y contraste, estados y textos, y accesibilidad. Se arregla todo lo de gravedad media o alta y se repite hasta que dos rondas seguidas no encuentren nada importante.

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
- **Si tienes el conector (MCP) de Render disponible, crea tú el servicio**, espera a que el deploy esté «live» y comprueba que la URL carga. Si no lo tienes, deja los pasos exactos en `PENDIENTE_PARA_MI.md` (Render → New → Blueprint → elegir el repositorio) y sigue con lo demás.
- Apunta la URL final `https://….onrender.com` en el `README`.

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

## 14. Fase 6: cuentas, amigos e IA

Hazla cuando todo lo anterior funcione y esté pulido. Lo que necesite claves o cuentas mías (API de Claude, OAuth de Google, base de datos de pago) déjalo preparado, desactivado y apuntado en `PENDIENTE_PARA_MI.md`; la app tiene que funcionar perfecta sin ello.

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
- **Fase 6. Cuentas, amigos, ranking y coach IA** (sección 14).
- **Fase 7. Perfeccionamiento continuo (no tiene fin).** Repite rondas, cada una con muchos agentes en paralelo:
  1. **Interfaz:** capturas de todas las pantallas y estados, en tema claro y oscuro y a varios tamaños. Varios agentes las critican contra la sección 10 y contra G-Helper; se arregla todo y se vuelve a capturar.
  2. **Caza de bugs:** varios agentes buscan fallos por módulos y otros intentan refutarlos; se arreglan los reales con su test. Repite hasta que dos rondas seguidas no encuentren nada.
  3. **Rendimiento y robustez:** arranque, CPU del Study Mode, memoria, reinicios, suspensión, cambios de hora y situaciones raras.
  4. **Accesibilidad, textos y tests** que falten.
  5. Release de parche (`vX.Y.Z+1`) y web actualizada.

  Sigue haciendo rondas mientras encuentres mejoras que valgan la pena.

En cada fase: tests nuevos, CI en verde, release nueva si cambia la app, web actualizada, `ROADMAP.md` al día y checklist de pruebas manuales para mí.

## 16. Entrega final

Cuando termines la Fase 6, deja en el `README` y en `ROADMAP.md`:

1. El enlace al repositorio de GitHub.
2. El enlace a la web en Render.
3. El enlace a la última Release con los instaladores.
4. Lo que tengo que hacer yo a mano (resumen de `PENDIENTE_PARA_MI.md`).
5. Las limitaciones conocidas.

Después pasa directamente a la Fase 7 sin esperar.

**Empieza ahora por la Fase 0 y no pares.**
