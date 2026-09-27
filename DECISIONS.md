# Decisiones

Una línea por decisión, con el porqué. Las más recientes, al final.

- **Rama principal `main`** creada desde el commit con `PROMPT.md` (8700f0f). El desarrollo va en `claude/zealous-albattani-f3xp5y` y se fusiona por PR.
- **npm workspaces** (no pnpm): lo pide el prompt y evita problemas de enlaces simbólicos con electron-builder.
- **`packages/shared` se consume como código TypeScript** (`exports` a `src/*.ts`), sin compilar: Vite, Astro, esbuild y Vitest lo procesan directamente y no hay paso de build intermedio que se pueda desincronizar.
- **TypeScript 6.0** y no la 7.0: `typescript-eslint` solo admite `<6.1`.
- **Electron 44** (la última estable) con **electron-vite 5 + Vite 7** en la app: electron-vite 5 aún no admite Vite 8. La web usa Astro 7 (Vite 8); npm anida cada versión en su workspace.
- **`node:sqlite` en vez de `better-sqlite3`** para la base de datos local: Electron 44 trae Node 24 con SQLite integrado (comprobado: SQLite 3.53.4). Así no hay módulos nativos, ni recompilación, y el `.dmg` universal es trivial.
- **Guardián en Go 1.24** con `kardianos/service`, API HTTP en `127.0.0.1:47600` (configurable).
- **Agentes sin worktree cuando trabajan en carpetas separadas:** cada módulo vive en su propia carpeta y las dependencias se instalan una vez en la raíz. Un worktree por agente obligaría a repetir `npm install` (Electron pesa cientos de MB) y el contenedor solo tiene 4 CPU. Solo se usan worktrees si dos agentes tocan los mismos archivos.
- **README y documentos para el usuario en español**; código, identificadores y commits en inglés.
