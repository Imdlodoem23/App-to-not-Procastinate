# Pendiente para ti

Cosas que dependen de ti (cuentas, credenciales, ajustes del repositorio o pruebas en tu ordenador). Mientras tanto, la app usa una alternativa temporal y el trabajo sigue.

## 1. Poner `main` como rama por defecto del repositorio

Ahora mismo la rama por defecto es `claude/magical-maxwell-h8t2nw`. Desde esta sesión no se puede cambiar.

1. Abre <https://github.com/Imdlodoem23/App-to-not-Procastinate/settings>.
2. En **General → Default branch**, pulsa el icono de las flechas, elige `main` y confirma con **Update**.

Mientras no lo hagas: el CI y las releases funcionan igual (`release.yml` también se lanza al fusionar en `main` un cambio de versión), pero el botón **Run workflow** de GitHub Actions solo aparece para los workflows de la rama por defecto.

## 2. Dominios bloqueados por la red de la sesión

La red de la sesión en la nube bloquea estos dominios. Las pruebas que los necesitan se hacen en GitHub Actions:

- `www.apple.com`: las capturas de referencia de la web se hacen en un workflow.
- `cdn.jsdelivr.net`
- `api.render.com`: se usa el conector de Render, si está disponible.
