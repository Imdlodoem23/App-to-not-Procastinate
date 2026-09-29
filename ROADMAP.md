# Hoja de ruta de Céntrate

> Documento vivo. Cada sesión de trabajo lo actualiza al terminar una tarea (hecho, en curso y siguiente paso).
> Rama de desarrollo: `claude/zealous-albattani-f3xp5y` · Rama principal y de despliegue: `main`.

## Estado actual

- **Hecho:** Fase 0 fusionada en `main` (PR #1). Configuración de instaladores (`electron-builder.yml`, NSIS, `.deb`) y `release.yml` preparados; el `.deb` y el AppImage se han generado en local.
- **Hecho en Fase 1:** contrato del guardián, catálogo, parser, puntos, tokens y capa de plataforma del guardián.
- **Hecho:** web estilo Apple (estructura completa, demo en vivo con el parser real, escena pegajosa, páginas Descargar, Novedades y Privacidad).
- **Hecho:** motor + API HTTP del guardián (prueba de humo real: bloquea, sobrevive al reinicio, ignora cambios de hora y se quita solo), app de escritorio (bandeja, ventana de 440 px, confirmación, cuenta atrás, ampliar con deshacer, ventanas Bloqueos/Emergencia/Ajustes) y extensión del navegador.
- **Web publicada:** <https://centrate.onrender.com> (Render, de momento desde la rama de desarrollo; pasará a `main` al fusionar la Fase 1).
- **En curso (ola 1, en paralelo):** traducción al inglés de web, app y extensión (`english-i18n`); CI de la Fase 1 en verde en Windows y macOS (`phase1-ci-green`); motor de IA del Study Mode en `packages/study-ai` (`phase4-study-ai`); iconos, mascota, sonidos y pipeline de marketing (`brand-assets`); backend `apps/api` de la Fase 6 (`phase6-cloud-api`).
- **Siguiente (ola 2, cuando termine el inglés):** fusionar la Fase 1 en `main` y release `v0.1.0`; integrar en la app el Study Mode (cámara, calibración, resumen), la capa de ventana activa, estadísticas, recompensas, logros, mascota, Pomodoro, horarios, sonidos, recordatorios, onboarding, mini temporizador, OSD y auto-actualización; web con capturas y vídeos reales; release `v1.0.0`; cuentas y amigos en la app; y después la Fase 7.

## Fase 0 · Esqueleto

- [x] Monorepo con npm workspaces (`packages/shared`, `apps/desktop`, `apps/extension`, `apps/web`, `guardian/`)
- [x] TypeScript estricto, ESLint (flat config) y Prettier
- [x] Vitest en `packages/shared` y `go test` en `guardian/`
- [x] Esqueleto de Electron (electron-vite + React + Tailwind), extensión MV3 (esbuild) y web (Astro + Tailwind)
- [x] `ci.yml` en Windows, macOS y Linux
- [x] `README.md`, `ROADMAP.md`, `DECISIONS.md`, `PENDIENTE_PARA_MI.md`, `CHANGELOG.md`, `PRIVACY.md` y `LICENSE`
- [x] CI en verde en los 3 sistemas y PR fusionado en `main`

## Fase 1 · Núcleo de bloqueo

- [x] Contrato de la API del guardián y tipos compartidos (`docs/ARCHITECTURE.md`, `packages/shared/src/guardian-api.ts`, `domain.ts`)
- [x] Catálogo de servicios, categorías, apps y lista blanca (`packages/shared/src/catalog`, 81 servicios)
- [x] Parser de lenguaje natural en español (380 pruebas de frases)
- [x] Reglas de puntos (`packages/shared/src/points.ts`) como función pura sobre el registro de eventos, con vectores compartidos para Go
- [x] Tokens de diseño (`packages/shared/src/design/tokens.css` y `tokens.ts`) y lint de colores sueltos
- [x] Guardián: capa de plataforma (servicio, CLI, rutas protegidas, logs, reloj que cuenta en suspensión, hosts, procesos)
- [x] Guardián: estado persistente, registro de eventos, API HTTP en `127.0.0.1` con token
- [x] Guardián: sección del hosts con marcadores, copia de seguridad, escritura atómica, vigilancia y vaciado de DNS
- [x] Guardián: vigilante de procesos
- [x] Guardián: fin automático y anti-cambio de hora (reloj que cuenta en suspensión)
- [x] Guardián: servicio del sistema (Windows, macOS, Linux) y tests de integración con hosts falso
- [x] App: ventana de 440 px desde la bandeja, campo «¿Qué quieres hacer?», tarjeta de confirmación, cuenta atrás, ampliar con deshacer
- [x] App: bandeja con tiempo restante, notificaciones y puntos básicos
- [x] App: arnés de estados (`?state=…`) y capturas con Playwright

## Fase 2 · Distribución

- [ ] `release.yml` (tag `vX.Y.Z`, `workflow_dispatch` y cambio de versión en `main`) con instaladores y Release publicada
- [ ] Instalador NSIS por máquina con el servicio del guardián (`build/installer.nsh`)
- [ ] `.dmg` con firma ad hoc y LaunchDaemon; `.deb` con systemd; AppImage con `pkexec`
- [ ] Release `v0.1.0`
- [ ] Web en Render (`render.yaml`) con descargas funcionando

## Fase 3 · Extensión e intentos

- [x] Extensión MV3 (Chromium y Firefox) con reglas `declarativeNetRequest`
- [x] `blocked.html` con motivo, tiempo restante y puntos perdidos
- [x] Emparejamiento con código
- [ ] Intentos que restan puntos (con agrupación y duplicado)
- [ ] Ventana activa como capa de respaldo
- [ ] Desbloqueo de emergencia

## Fase 4 · Study Mode

- [ ] Cámara con consentimiento y MediaPipe incluido en la app
- [ ] Calibración y clasificador local
- [ ] Máquina de estados, strikes y castigo aplicado por el guardián
- [ ] Latidos y abandono

## Fase 5 · Extras y v1.0.0

- [ ] Pomodoro, horarios, modo examen, estadísticas, recompensas, logros, mascota, sonidos, tareas, recordatorios
- [x] Límites diarios («YouTube máximo 30 minutos al día»): entidad del guardián, uso informado por la extensión y la app, bloqueo hasta las 0:00, parser en español e inglés, sección en Bloqueos, avisos, estadísticas y web (`docs/ARCHITECTURE.md` §5.10 y §10.13)
- [ ] Ajustes completos, mini temporizador, OSD, auto-actualización, onboarding
- [ ] Web estilo Apple terminada con capturas y vídeos reales
- [ ] Release `v1.0.0`

## Fase 6 · Cuentas, amigos, ranking y coach IA

- [ ] `apps/api` (Fastify + Drizzle + Postgres) en Render
- [ ] Inicio de sesión, sincronización, amigos, ranking, compañero de responsabilidad y coach IA

## Fase 7 · Perfeccionamiento continuo

- [ ] Rondas de interfaz, bugs, rendimiento, accesibilidad y releases de parche

## Pendiente de menor gravedad (para la Fase 7)

- (vacío)

## Checklist para probar en tu ordenador

Se completa al terminar cada fase.

- [ ] Extensión en Chrome, incógnito (Playwright no carga extensiones ahí): con «Permitir en incógnito» activado, abre YouTube en una ventana de incógnito, empieza un bloqueo de YouTube y comprueba que la pestaña pasa sola a la página de bloqueo, sin restar puntos.
