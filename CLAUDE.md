# Céntrate: guía para agentes

The full product brief is `PROMPT.md` (Spanish). Read the sections relevant to your task there; this file only holds conventions.

## Languages

- App UI, web copy, user-facing docs (README, ROADMAP, DECISIONS, PENDIENTE_PARA_MI, PRIVACY, CHANGELOG): **Spanish** (Spain), sentence case, typographic minus sign «−» for negative points.
- Code, identifiers, code comments and commit messages: **English**.
- i18n: user strings live in `apps/*/src/**/i18n/es.ts` (or `packages/shared/src/i18n/es.ts` when shared), ready to add `en`.

## Layout

```text
packages/shared   TS source consumed directly (exports -> src/*.ts). Catalog, NL parser, points rules, guardian API types, design tokens.
apps/desktop      Electron 44 + electron-vite 5 (Vite 7) + React 19 + Tailwind 4 + Zustand. Local DB: node:sqlite (no native modules).
apps/extension    MV3 extension built with esbuild (Chromium + Firefox, one codebase).
apps/web          Astro 7 + Tailwind 4 static site deployed to Render.
guardian/         Go 1.24 system service (kardianos/service). HTTP API on 127.0.0.1 only.
```

## Commands (run from repo root)

- `npm run lint` · `npm run format:check` · `npm run typecheck` · `npm test` · `npm run build`
- `npm run test:go` (or `cd guardian && go vet ./... && go test ./...`)
- Single package: `npm test -w packages/shared`, `npm run typecheck -w apps/desktop`.

## Rules

- **Do not run `npm install` / add dependencies yourself** unless your task says so: several agents share one `node_modules`. If you truly need a new package, add it to the right `package.json` and say so in your final report; the coordinator installs it. Go modules: `go get` inside `guardian/` is fine.
- Only touch files inside the module/folder your task assigns you. Never edit `PROMPT.md`.
- Do not commit or push unless your task explicitly says so; the coordinator integrates.
- TypeScript strict; no `any` unless justified; `import type` for types. Run prettier on files you create (`npx prettier --write <files>`).
- Before finishing: the package you touched must pass its typecheck, lint and tests.
- Colors in desktop and extension come only from `packages/shared/src/design/tokens.css` / `tokens.ts` (a CI lint rejects loose hex colors).
- Guardian API is loopback-only, token-protected for writes, strictly validated, never shells out with received data, and has **no operation that ends a block early**.
- Points values live only in `packages/shared/src/points.ts`; the guardian embeds generated data from it (never hand-edit generated files).

## Browsers and screenshots

- Playwright is installed (`@playwright/test` 1.63 in `apps/web`). In this cloud container the bundled browser download is blocked: launch Chromium with `executablePath: process.env.PW_CHROMIUM_PATH` and run with `PW_CHROMIUM_PATH=/opt/pw-browsers/chromium`. In CI, `npx playwright install --with-deps chromium` provides it and the env var is unset.
- Electron runs headless here with `xvfb-run -a` (the Electron binary is in `node_modules/electron/dist`).
- Screenshot folders: `docs/ui/` (app) and `docs/web/` (web). Temporary captures go to the session scratchpad, not the repo.
