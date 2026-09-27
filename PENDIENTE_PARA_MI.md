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

## 3. Crear la web en Render (tu cuenta está en el límite de 25 servicios)

Al crear el Static Site `centrate`, Render respondió: «Hobby Tier is limited to 25 services». No he tocado ninguno de tus servicios.

1. En <https://dashboard.render.com>, borra algún servicio que ya no uses (por ejemplo, uno de los suspendidos: `shooter`, `temario` o `territorial-2-0`). **Borrar** libera el hueco; suspender no.
2. Render → **New → Blueprint** → elige `Imdlodoem23/App-to-not-Procastinate` → rama `main` → **Apply**. El archivo `render.yaml` ya trae el build, la carpeta publicada, las cabeceras de seguridad y de caché y el despliegue automático.
3. La URL será `https://centrate.onrender.com` (o parecida si el nombre está cogido).

Si prefieres no borrar nada, la siguiente sesión de trabajo volverá a intentar crearlo con el conector de Render en cuanto haya un hueco.
