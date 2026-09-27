# Hoja de ruta de Céntrate

> Documento vivo. Cada sesión de trabajo lo actualiza al terminar una tarea (hecho, en curso y siguiente paso).
> Rama de desarrollo: `claude/zealous-albattani-f3xp5y` · Rama principal y de despliegue: `main`.

## Estado actual

- **En curso:** Fase 0 · Esqueleto.
- **Siguiente paso:** abrir el PR de la Fase 0 hacia `main`, fusionarlo con el CI en verde y empezar la Fase 1 (diseño del contrato del guardián y de `packages/shared`).

## Fase 0 · Esqueleto

- [x] Monorepo con npm workspaces (`packages/shared`, `apps/desktop`, `apps/extension`, `apps/web`, `guardian/`)
- [x] TypeScript estricto, ESLint (flat config) y Prettier
- [x] Vitest en `packages/shared` y `go test` en `guardian/`
- [x] Esqueleto de Electron (electron-vite + React + Tailwind), extensión MV3 (esbuild) y web (Astro + Tailwind)
- [x] `ci.yml` en Windows, macOS y Linux
- [x] `README.md`, `ROADMAP.md`, `DECISIONS.md`, `PENDIENTE_PARA_MI.md`, `CHANGELOG.md`, `PRIVACY.md` y `LICENSE`
- [ ] CI en verde en los 3 sistemas y PR fusionado en `main`

## Fase 1 · Núcleo de bloqueo

- [ ] Contrato de la API del guardián y tipos compartidos (`packages/shared/src/guardian-api.ts`)
- [ ] Catálogo de servicios, categorías, apps y lista blanca (`packages/shared/src/catalog`)
- [ ] Parser de lenguaje natural en español (≥ 60 frases de prueba)
- [ ] Reglas de puntos (`packages/shared/src/points.ts`) como función pura sobre el registro de eventos
- [ ] Tokens de diseño (`packages/shared/src/design/tokens.css` y `tokens.ts`) y lint de colores sueltos
- [ ] Guardián: estado persistente, registro de eventos, API HTTP en `127.0.0.1` con token
- [ ] Guardián: sección del hosts con marcadores, copia de seguridad, escritura atómica, vigilancia y vaciado de DNS
- [ ] Guardián: vigilante de procesos
- [ ] Guardián: fin automático y anti-cambio de hora (reloj que cuenta en suspensión)
- [ ] Guardián: servicio del sistema (Windows, macOS, Linux) y tests de integración con hosts falso
- [ ] App: ventana de 440 px desde la bandeja, campo «¿Qué quieres hacer?», tarjeta de confirmación, cuenta atrás, ampliar con deshacer
- [ ] App: bandeja con tiempo restante, notificaciones y puntos básicos
- [ ] App: arnés de estados (`?state=…`) y capturas con Playwright

## Fase 2 · Distribución

- [ ] `release.yml` (tag `vX.Y.Z`, `workflow_dispatch` y cambio de versión en `main`) con instaladores y Release publicada
- [ ] Instalador NSIS por máquina con el servicio del guardián (`build/installer.nsh`)
- [ ] `.dmg` con firma ad hoc y LaunchDaemon; `.deb` con systemd; AppImage con `pkexec`
- [ ] Release `v0.1.0`
- [ ] Web en Render (`render.yaml`) con descargas funcionando

## Fase 3 · Extensión e intentos

- [ ] Extensión MV3 (Chromium y Firefox) con reglas `declarativeNetRequest`
- [ ] `blocked.html` con motivo, tiempo restante y puntos perdidos
- [ ] Emparejamiento con código
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
