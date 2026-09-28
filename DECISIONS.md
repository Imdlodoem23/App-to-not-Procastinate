# Decisiones

Una línea por decisión, con el porqué. Las más recientes, al final.

- **Rama principal `main`** creada desde el commit con `PROMPT.md` (8700f0f). El desarrollo va en `claude/zealous-albattani-f3xp5y` y se fusiona por PR.
- **npm workspaces** (no pnpm): lo pide el prompt y evita problemas de enlaces simbólicos con electron-builder.
- **`packages/shared` se consume como código TypeScript** (`exports` a `src/*.ts`), sin compilar: Vite, Astro, esbuild y Vitest lo procesan directamente y no hay paso de build intermedio que se pueda desincronizar.
- **TypeScript 6.0** y no la 7.0: `typescript-eslint` solo admite `<6.1`.
- **Electron 44** (la última estable) con **electron-vite 5 + Vite 7** en la app: electron-vite 5 aún no admite Vite 8. La web usa Astro 7 (Vite 8); npm anida cada versión en su workspace.
- **`node:sqlite` en vez de `better-sqlite3`** para la base de datos local: Electron 44 trae Node 24 con SQLite integrado (comprobado: SQLite 3.53.4). Así no hay módulos nativos, ni recompilación, y el `.dmg` universal es trivial.
- **Guardián en Go 1.26 (lo exige `golang.org/x/sys` actual)** con `kardianos/service`, API HTTP en `127.0.0.1:47600` (configurable).
- **Agentes sin worktree cuando trabajan en carpetas separadas:** cada módulo vive en su propia carpeta y las dependencias se instalan una vez en la raíz. Un worktree por agente obligaría a repetir `npm install` (Electron pesa cientos de MB) y el contenedor solo tiene 4 CPU. Solo se usan worktrees si dos agentes tocan los mismos archivos.
- **README y documentos para el usuario en español**; código, identificadores y commits en inglés.
- **ID fijo de la extensión en Chromium** (`dlabilkpafinafimngfclcfmeghilcah`): el `manifest.json` lleva la clave pública (`key`), así la extensión «descomprimida» tiene siempre el mismo ID en Chrome, Edge y Brave y el guardián puede limitar CORS a ese origen. La clave privada no se guarda: no hace falta para instalarla descomprimida, y Chrome Web Store asigna la suya al publicarla.
- **Firefox:** su origen `moz-extension://` es aleatorio en cada instalación, así que el guardián acepta cualquier `moz-extension://`, pero las escrituras siguen necesitando el token que da el emparejamiento.
- **Web en Render pendiente:** la cuenta de Render está en el límite de 25 servicios del plan gratuito. `render.yaml` queda listo y los pasos están en `PENDIENTE_PARA_MI.md`. Las descargas funcionan igual desde GitHub Releases.
- **Nombre del paquete `.deb` en ASCII** (`centrate`): Debian no admite tildes en el nombre del paquete. La app sigue llamándose «Céntrate» en la interfaz.
- **Firma ad hoc en macOS** con un `afterPack` (`codesign --force --deep --sign -`) e `identity: null`: sin certificado de Apple, es lo que evita el aviso de «app dañada» en Apple Silicon. El CI lo comprueba con `codesign --verify --deep --strict`.

### Contrato del guardián (`docs/ARCHITECTURE.md`)

- **Diseño elegido por un panel:** 3 propuestas (anti-trampas, robustez y sencillez del cliente) y 2 jueces; ganó la de anti-trampas y se le injertaron las mejores ideas de las otras, con 3 revisores adversariales después.
- **XP y racha solo con minutos concentrado del Study Mode** (sección 7 al pie de la letra); los bloqueos dan puntos, no XP.
- **Crédito de bloqueo solo con el equipo despierto**, un bloqueo por minuto real y sin crédito mientras una recompensa abre parte del bloqueo: evita «granjear» puntos con bloqueos solapados o suspendiendo el portátil.
- **Bonus de +20 por sesión limpia solo desde 25 min** y, en Study Mode, con 0 strikes: evita granjearlo con sesiones de 5 min.
- **Escalada de intentos global** (no por servicio) y ventana de 30 s deslizante para agrupar detecciones.
- **Los castigos se apilan** como bloqueos separados; la emergencia sí existe para un castigo (con las reglas de Estricto) y una emergencia cubre varios bloqueos a la vez.
- **La penalización de emergencia cuenta los puntos «aparcados» en recompensas activas**, y no se puede canjear mientras hay una emergencia en marcha: evita esconder puntos antes de pagar.
- **Recompensas:** máximo 60 min por servicio, bloqueadas durante el Study Mode, y si se revocan se devuelve la parte proporcional.
- **Reiniciar cancela una emergencia pendiente.** Los horarios en curso no se pueden tocar, y editar o borrar uno para debilitarlo queda congelado 10 min antes de que empiece.
- **Ajustes que debilitan tardan 24 h** en aplicarse (tiempo de funcionamiento o verificado); el nivel y la duración del castigo se aplican al momento. La zona horaria se fija en el primer arranque y los cambios posteriores también esperan.
- **Borrar datos conserva** el saldo negativo, la escalada y los ajustes anti-trampas; reinstalar sí reinicia el registro de puntos.
- **Los intentos los informa el proceso de fondo de la extensión** (con `webNavigation`), no `blocked.html`: una página se puede abrir a mano y no es fiable como prueba del intento.
- **Las peticiones con el token de la app no pueden llevar `Origin`**: así el token no sirve desde ninguna web. Terminar el Study Mode antes de tiempo es gratis.
- **Reiniciar o cerrar sesión termina el Study Mode como «interrumpido»** sin penalización, y la cámara nunca se vuelve a encender sola. «¡Estaba estudiando!» solo reentrena la IA; no devuelve el strike.
- **Tras reiniciar, un bloqueo recién terminado se mantiene hasta 120 s** («Comprobando la hora…») mientras el guardián verifica que nadie ha adelantado el reloj.
- **Parar el servicio del guardián durante un bloqueo cuesta como una emergencia**, salvo que sea el instalador (marca de parada planificada) o un apagado del sistema.
- **Los bloqueos recuperados** del encabezado del hosts (si el estado se perdió) son Estrictos y no dan puntos.
- **`has-active` devuelve 10** (bloqueo Normal o Estricto) u **11** (Hardcore, Examen o castigo).
- **Puerto fijo 47600 sin alternativa**: la extensión confía en ese puerto tras el emparejamiento.

### Web

- **Iconos de Lucide (ISC; los derivados de Feather, MIT) como excepción a «solo CC0 u OFL»:** son licencias permisivas, la app ya usa `lucide-react` y así la web dibuja los mismos iconos que la app. Su aviso de copyright viaja con la web en `/third-party-notices.txt` y todo queda apuntado en `ASSET-LICENSES.json`.
- **URLs sin barra final** (`/descargar`, nunca `/descargar/`): enlaces, canónicas, `og:url` y sitemap usan la misma forma (`trailingSlash: 'never'`), y `render.yaml` reescribe cada ruta a su `index.html`.
- **La URL del sitio sale de Render** (`RENDER_EXTERNAL_URL`) salvo que se defina `SITE_URL` (dominio propio): si el nombre `centrate` está cogido, las canónicas siguen apuntando a la web real.
- **Imagen Open Graph en PNG** (`public/og.png`, dibujada desde `/og.svg` con Chromium e Inter): las redes sociales no muestran vistas previas en SVG, y resvg no puede cargar las fuentes woff2.
- **Los presupuestos de peso se comprueban en CI** (`lighthouserc*.json` y `tests/quality.spec.ts`): primera vista ≤ 1,5 MB en cada página (y, según Lighthouse, vídeo ≤ 1,2 MB e imágenes ≤ 360 KB, tres imágenes al tope); en `dist/`, cada imagen AVIF o WebP ≤ 120 KB, el vídeo del hero ≤ 0,4 MB en AV1 y ≤ 1,2 MB en los demás códecs, y cada bucle ≤ 0,5 MB. MB y KB decimales, la lectura más estricta. Un vídeo es el del hero si su nombre lleva «hero».
